/**
 * The controller layer over the body substrate.
 *
 * `body.ts` owns node state and the solver. This module owns the two-way
 * boundary with the rest of the game:
 *
 *   intent  -> target pose -> motor authority -> solver gains       (down)
 *   contacts -> injury -> motor authority -> balance -> locomotion  (up)
 *
 * Everything the brief asked for lives on that loop. Stumbling is a support
 * margin going negative. A ragdoll is motor authority reaching zero. Getting up
 * is authority ramping back while the pose target walks prone -> kneel -> stand.
 * Piles are node contacts between bodies, and being pinned is the mass of those
 * contacts exceeding what the get-up controller can lift.
 *
 * Units: m, m/s, kg, s, N*s.
 */

import {
  type BodyPlan,
  Bodies,
  EDGES,
  MAX_FRAMES,
  MAX_NODES,
  boneTolOf,
  concussion,
  SUBSTEPS,
  finish,
  frictionOf,
  hardnessOf,
  impulseDamage,
  limbMotor,
  globalAuthority,
  poseGain,
  predict,
  solveAttach,
  solveBones,
  solveLimits,
  solvePair,
  solvePose,
  poseError,
  attachToPoint,
  solveWorld,
} from "./body";
import {
  type Actor,
  type Material,
  type Prop,
  type Region,
  GRAVITY,
  REGIONS,
  injurySum,
} from "./types";
import { World, clamp, facing } from "./world";
import {
  beginFrames,
  endFrames,
  finishFrames,
  framePropId,
  predictFrames,
  solveFrames,
  wakeFrame,
} from "./frames";

/** Live prop-frame slots this tick. Sized by the frame pool, never grown. */
const liveFrames = new Int32Array(MAX_FRAMES);
let liveFrameCount = 0;

/** Pose stiffness of a fully authoritative limb, s^-1. */
const POSE_RATE = 62;
/** Support margin, m, that maps to balance = 1. */
const BAL_REF = 0.15;
/** Margin, m, past which no catch step can save the fall. */
const FALL_MARGIN = -0.34;
/** How long the capture point may sit outside the base before it is a fall, s. */
const OFF_BALANCE_GRACE = 0.16;
/** Margin, m, deep enough to be a loss of balance the instant it happens. */
const OFF_BALANCE_DEEP = -0.19;
/**
 * Mean pose-tracking error, m, past which the body is judged to have been
 * physically overpowered and the stance is lost.
 */
const POSE_LOST = 0.34;
/**
 * Share of the stride a body can throw ahead of itself to catch a capture
 * point that has left its base, dimensionless.
 *
 * The reach is the STRIDE, not a fixed distance: a walking body reclaims what
 * a walking step covers, a running one covers more, and a body standing still
 * has no step in flight to land on and goes down from a shove exactly as it
 * always did. Reusing `strideAmp` for this rather than inventing a length
 * keeps one gait law in one place -- the same number that decides where the
 * foot is going decides whether it gets there in time.
 */
const CATCH_STRIDES = 2.2;
/**
 * Minimum time after a catch step's own timer runs out before another one may
 * commit, s.
 *
 * A catch expiring is not evidence the body recovered -- only that the clock
 * ran out -- and the SAME still-bad margin that justified the first catch was
 * still there the instant it did, with nothing yet to distinguish "a fresh,
 * escalating loss of balance" from "the last one never actually resolved".
 * Recommitting on that reading relocated the foot to a BRAND NEW live capture
 * point every ~0.36 s, sometimes a large distance from the last one, for as
 * long as the underlying sway continued -- which, self-caused, could be
 * seconds. Every relocation is a fresh, fast solver correction landing right
 * as the foot makes contact, and enough of those chained end to end read as
 * real impacts and cost real motor authority, which made the NEXT relocation
 * likelier still. This is what actually kept a body stumbling through
 * perfectly ordinary walking with nothing external ever touching it.
 * The margin hard floor a few lines up still collapses a genuinely worsening
 * fall immediately, cooldown or not -- this only withholds the DISCRETE
 * re-plant, giving the continuous counterweight lean above a beat to work
 * before the body is asked to relocate a foot again.
 */
const CATCH_RECOMMIT_COOLDOWN = 0.25;
/**
 * Largest involuntary counterweight lean, local m-scale, matching the
 * existing voluntary `leanZ`/`leanX` neighbourhood (0.18-0.22) so the two
 * channels read as one body's worth of tilt once summed, not two competing
 * scales.
 */
const RECOVER_LEAN_MAX = 0.2;
/** How fast the counterweight engages and relaxes, s^-1: a fast reflex, not a deliberate lean. */
const RECOVER_RATE = 10;
/** How fast a body settles into or out of a crouch, s^-1. */
const CROUCH_RATE = 6;
/** Closing speed, m/s, above which a contact interrupts a get-up. */
const KNOCK_V = 3.4;
/** Landing speed a fully able pair of legs can absorb without going down, m/s. */
const LAND_LIMIT = 9.5;
/**
 * Fraction of arriving energy that fully-braced muscle takes, dimensionless.
 * Calibrated against the falls the budget falsifier fixes: a braced 1.5 m drop
 * has to be nearly free and a 6 m one has to be grave.
 */
const ABSORB_MAX = 0.856;
/**
 * Ceiling on the mass ratio in `heft`, dimensionless. Past roughly three times
 * the equivalent impact speed the tissue is destroyed and a larger number is
 * not saying anything the injury model can express.
 */
const HEFT_MAX = 9;
/** Hard ceiling on node speed, m/s. Only ever engages after a solver blow-up. */
const MAX_NODE_SPEED = 34;
/** Node contact pairs considered per tick. */
const MAX_PAIRS = 192;
/**
 * Minimum share of the root the solved body always holds, even at full motor
 * authority. Without it a shove, a haul or a falling beam can displace the body
 * and the locomotion capsule never learns about it: the character resists any
 * external force perfectly until it is violent enough to break the pose
 * outright, which is both wrong and a cliff. This is what makes being pushed
 * feel like being pushed.
 */
const MIN_BODY_SHARE = 0.12;
/** Rate at which a region forgets an impact and can be wounded fresh, s^-1. */
const DAMAGE_RECOVER = 2.2;

const REGION_OF = [0, 1, 2, 3, 4, 5];
const regionV = new Float32Array(6);
const regionVt = new Float32Array(6);
const regionHard = new Float32Array(6);

const pairA = new Int32Array(MAX_PAIRS);
const pairB = new Int32Array(MAX_PAIRS);
const pairActA = new Int32Array(MAX_PAIRS);
const pairActB = new Int32Array(MAX_PAIRS);
let pairCount = 0;

/** Scratch pose buffer in body-local metres; reused every actor, never allocated. */
const lx = new Float32Array(MAX_NODES);
const ly = new Float32Array(MAX_NODES);
const lz = new Float32Array(MAX_NODES);

/* ------------------------------------------------------------------ *
 * Motor authority
 * ------------------------------------------------------------------ */

/**
 * Recomputes per-limb motor authority. Called before locomotion so that gait
 * speed, reach and grab strength all read the same numbers the solver will.
 */
export function updateMotor(a: Actor) {
  a.authority = globalAuthority(a);
  for (const r of REGIONS) a.motor[r] = limbMotor(a, r, injurySum(a.injuries[r]));
}

/** Rest distance between two plan nodes at unit scale, m. */
function restLen(plan: BodyPlan, i: number, j: number) {
  const a = plan.nodes[i]!;
  const b = plan.nodes[j]!;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Half-stride amplitude, m: how far each foot travels fore and aft of the hips.
 *
 * Derived from the no-slip condition rather than picked. During stance the
 * planted foot must move backward relative to the body at exactly the body's
 * speed, so with a foot excursion `z = -A sin(phi)` and phase rate `w`, mid-
 * stance gives `A*w = speed`. Choosing A from speed therefore also fixes the
 * cadence, and the feet stop sliding along the ground.
 *
 * Getting this wrong is not cosmetic: a stride too short for the speed leaves
 * the anticipated base of support permanently behind the capture point, and the
 * balance test correctly -- and constantly -- reports a fall.
 */
export function strideAmp(speed: number, scale: number) {
  return clamp(speed * 0.26, 0.02, 0.42) * scale;
}

/** Gait phase rate, rad/s, that keeps `strideAmp` no-slip at mid-stance. */
export function gaitRate(speed: number, scale: number) {
  const a = strideAmp(speed, scale);
  return a > 1e-4 ? speed / a : 0;
}

/** Mean motor over the two legs: what gait speed and catch steps depend on. */
export function legMotor(a: Actor) {
  return (a.motor.lleg + a.motor.rleg) * 0.5;
}

/** Mean motor over the two arms: what grab and strike strength depend on. */
export function armMotor(a: Actor) {
  return (a.motor.larm + a.motor.rarm) * 0.5;
}

/**
 * Whether this actor currently has any real say over its own body: alive,
 * and not mid-ragdoll, down, getup, pinned or vaulting.
 *
 * This is the one truth every input gate (movement, crouch, attack, kick,
 * shove, grab) needs to agree with the body substrate on, and until now each
 * one carried its own hand-copied guess at it instead of reading this. They
 * had drifted: movement's own copy matched this exactly, but attack excluded
 * only "ragdoll", and kick and shove excluded nothing at all -- so mashing
 * them while down or mid-getup fired a real strike (stamina spent, cooldown
 * reset, sound emitted) or set a real kick/shove timer with no motor
 * authority behind it, which then surfaced once authority came back as
 * action state that looked like it had been queued up and was replaying
 * itself with no input behind it.
 */
export function isControllable(a: Actor): boolean {
  return (
    a.alive &&
    a.loco !== "ragdoll" &&
    a.loco !== "down" &&
    a.loco !== "getup" &&
    a.loco !== "pin" &&
    a.loco !== "vault"
  );
}

/* ------------------------------------------------------------------ *
 * Target pose
 * ------------------------------------------------------------------ */

function groundMaterial(w: World, x: number, z: number): Material {
  if (w.inWater(x, z, 0.3)) return "water";
  const i = w.cell(x, z);
  if (w.oil[i]! > 0.3) return "oil";
  if (w.wet[i]! > 0.55) return "soil";
  if (Math.abs(x) < 9 && Math.abs(z) < 9) return "stone";
  if (w.indoorAt(x, z)) return "wood";
  return "soil";
}

/**
 * Writes the world-space target pose for every node of one actor.
 *
 * The gait, lean, strike and crouch shapes used to live in the renderer, where
 * they could not affect anything. They are authoritative here: the solver is
 * the only thing that decides how much of this pose actually happens.
 */
function writePose(w: World, a: Actor, dt: number) {
  const B = w.bodies;
  const slot = a.body;
  const plan = B.plan(slot);
  const s = B.scale[slot]!;
  const n = B.count[slot]!;
  // The raw crouch input is a boolean; smoothing it keeps an instant keypress
  // from asking the solver for a pose change no body could make. The rate is
  // a real one: a squat takes about four tenths of a second, and asking for it
  // in a twentieth (which a flat 0.22 per tick was) drops the pose target
  // through the body faster than the legs can follow it down. The body then
  // chased its own target at better than half a metre per second, the capture
  // point left the base, and the balance controller -- correctly, on the
  // numbers it was given -- called it a fall. Crouching put the player on the
  // floor. Done as a rate rather than a per-tick fraction so it does not
  // depend on the step length.
  a.crouchAmt += ((a.crouch ? 1 : 0) - a.crouchAmt) * (1 - Math.exp(-dt * CROUCH_RATE));
  // The gait clock lives with the gait pose so the two cannot disagree. Damaged
  // legs lengthen their own stance phase, which is what makes a limp read as a
  // limp rather than as a slower walk.
  a.walkPhase +=
    gaitRate(Math.sqrt(a.vx * a.vx + a.vz * a.vz), B.scale[slot]!) *
    dt *
    (0.55 + legMotor(a) * 0.45);
  // Getting up is a squat that extends, not a body swinging over its own feet:
  // rotating the whole pose about the soles throws the centre of mass forward
  // past the toes, which the support test correctly reads as falling over. The
  // squat keeps the mass over the base the whole way up, which is what makes
  // standing up possible rather than a slow topple.
  const rising = a.loco === "getup" || a.loco === "pin" ? 1 - clamp(a.stanceAuth, 0, 1) : 0;
  // A crouch is a shallow, balanced squat; rising from the ground goes much
  // deeper, because that is where the body has to start from.
  const flex = Math.max(a.crouchAmt * 0.55, rising);
  const spd = Math.sqrt(a.vx * a.vx + a.vz * a.vz);
  const ph = a.walkPhase;
  const stride = strideAmp(spd, s);
  const lift = Math.min(0.16, stride * 0.28);
  const humanoid = n === 11;
  for (let i = 0; i < n; i++) {
    const spec = plan.nodes[i]!;
    lx[i] = spec.x * s;
    ly[i] = spec.y * s;
    lz[i] = spec.z * s;
  }

  if (humanoid) {
    // legs swing out of phase; forward is local -z
    lz[8] = lz[8]! - Math.sin(ph) * stride;
    ly[8] = ly[8]! + Math.max(0, Math.sin(ph)) * lift;

    lz[10] = lz[10]! + Math.sin(ph) * stride;
    ly[10] = ly[10]! + Math.max(0, -Math.sin(ph)) * lift;

    // arms counter-swing
    lz[4] = lz[4]! + Math.sin(ph) * stride * 0.62;

    lz[6] = lz[6]! - Math.sin(ph) * stride * 0.62;

    // Counterweight: free arms spread and rise with the trouble, biased
    // toward whichever side is actually helping -- outward for a lateral
    // catch, up and back for a forward/backward one -- read from the same
    // recoverX/recoverZ the torso below leans with, not a separate guess.
    // This runs before the strike/kick overrides further down, so an active
    // strike still has the final say over its own arm.
    if (a.recoverX !== 0 || a.recoverZ !== 0) {
      const spread = Math.hypot(a.recoverX, a.recoverZ) * s;
      lx[4] = lx[4]! - spread * 0.9 - a.recoverX * s * 0.5;
      lx[6] = lx[6]! + spread * 0.9 - a.recoverX * s * 0.5;
      ly[4] = ly[4]! + spread * 0.7;
      ly[6] = ly[6]! + spread * 0.7;
      lz[4] = lz[4]! + a.recoverZ * s * 0.6;
      lz[6] = lz[6]! + a.recoverZ * s * 0.6;
    }

    // torso leans into travel, away from a dragged load, and opposite the
    // capture point once one has left the base -- three sources, one tilt.
    const lean = clamp(a.leanZ + a.recoverZ, -0.22, 0.22) * s;
    const roll = clamp(a.leanX + a.recoverX, -0.18, 0.18) * s;
    lz[1] = lz[1]! + lean;
    lz[0] = lz[0]! + lean * 1.35;
    lx[1] = lx[1]! + roll;
    lx[0] = lx[0]! + roll * 1.3;
    // The hips share a smaller fraction of the SAME counterweight -- a real
    // recovery shifts weight at the hip, not only the chest -- kept out of
    // the voluntary travel/haul lean above so that established behaviour is
    // untouched.
    lz[2] = lz[2]! + a.recoverZ * s * 0.35;
    lx[2] = lx[2]! + a.recoverX * s * 0.35;
    // Crouching is hip and knee FLEXION, not a uniform vertical squash. Scaling
    // every node's height compresses the spine past its joint limit, and the
    // solver then fights the pose hard enough to be read as losing the stance.
    // Rotating the upper body about the pelvis keeps every segment its own
    // length, so the limits are satisfied by construction.
    if (flex > 0.001) {
      const drop = flex * 0.42 * ly[2]!;
      const theta = flex * 0.5; // hip flexion, rad
      const ct = Math.cos(theta);
      const st2 = Math.sin(theta);
      const py = ly[2]! - drop;
      // The hips travel BACK as they drop, which is what keeps a squat's centre
      // of mass over the feet instead of out past the toes.
      const setback = flex * 0.19 * s;
      lz[2] = lz[2]! + setback;
      for (const i of [0, 1, 3, 4, 5, 6]) {
        const ry = ly[i]! - ly[2]!;
        const rz = lz[i]! - lz[2]!;
        ly[i] = py + (ry * ct + rz * st2);
        lz[i] = lz[2]! + (rz * ct - ry * st2);
      }
      ly[2] = py;
      // knees track the hips down and fold forward; the soles stay put
    }

    // strike: the right arm drives forward through the swing
    if (a.strikeT > 0) {
      const k = clamp(a.strikeT / 0.32, 0, 1); // 1 wound up, 0 extended
      const ext = 1 - k;
      lz[6] = lz[6]! - (0.16 + ext * 0.62) * s;
      ly[6] = ly[6]! + (0.34 - ext * 0.1) * s;
    }
    if (a.kickT > 0) {
      const ext = 1 - clamp(a.kickT / 0.28, 0, 1);
      lz[10] = lz[10]! - (0.2 + ext * 0.6) * s;
      ly[10] = ly[10]! + (0.2 + ext * 0.24) * s;
    }
    // While still low, the hands reach out ahead for ground to push against, so
    // the rise reads as a push-up rather than a body inflating upright.
    if (rising > 0.25) {
      const k = rising;
      lz[4] = lz[4]! - 0.36 * s * k;
      lz[6] = lz[6]! - 0.36 * s * k;
      ly[4] = Math.max(0.07 * s, ly[4]! - 0.34 * s * k);
      ly[6] = Math.max(0.07 * s, ly[6]! - 0.34 * s * k);
    }
  } else {
    // quadruped: diagonal pairs, forelegs lead
    lz[3] = lz[3]! - Math.sin(ph) * stride;
    ly[3] = ly[3]! + Math.max(0, Math.sin(ph)) * lift;
    lz[6] = lz[6]! - Math.sin(ph) * stride;
    ly[6] = ly[6]! + Math.max(0, Math.sin(ph)) * lift;
    lz[4] = lz[4]! + Math.sin(ph) * stride;
    ly[4] = ly[4]! + Math.max(0, -Math.sin(ph)) * lift;
    lz[5] = lz[5]! + Math.sin(ph) * stride;
    ly[5] = ly[5]! + Math.max(0, -Math.sin(ph)) * lift;
  }

  const c = Math.cos(a.yaw);
  const sn = Math.sin(a.yaw);

  if (humanoid) {
    const thigh = restLen(plan, 2, 7) * s;
    const shin = restLen(plan, 7, 8) * s;
    const upper = restLen(plan, 1, 3) * s;
    const fore = restLen(plan, 3, 4) * s;

    // Hip dip.
    //
    // A standing pose has near-straight legs, so a stride long enough to keep
    // up with the body puts the foot out of the leg's reach. A real walker
    // answers that by dropping the hips; without this the IK answers it by
    // lifting the FOOT instead, which takes the body off the ground every
    // stride and launches it off the next contact. The dip is what a stride
    // costs in height, and it is why walking has a vertical bob at all.
    const legReach = (thigh + shin) * 0.985;
    let dip = 0;
    for (const f of plan.feet) {
      const dx = lx[f]! - lx[2]!;
      const dz = lz[f]! - lz[2]!;
      const flat = Math.sqrt(dx * dx + dz * dz);
      if (flat >= legReach) continue;
      const maxDrop = Math.sqrt(legReach * legReach - flat * flat);
      const need = ly[2]! - ly[f]! - maxDrop;
      if (need > dip) dip = need;
    }
    if (dip > 0) {
      for (const i of [0, 1, 2, 3, 4, 5, 6]) ly[i] = ly[i]! - dip;
    }

    // The catch step overrides one foot's target with the capture point --
    // the place the body would actually have to step to arrest the fall it
    // is already in -- in the SAME local frame twoLink reads below, and
    // BEFORE twoLink runs. This used to be a late world-space patch on
    // B.tx/ty/tz, applied AFTER twoLink: the knee got solved for wherever
    // the gait-swing foot guess had been, then the ankle jumped to the catch
    // placement afterward, leaving one two-bone chain asked to satisfy two
    // disagreeing end points in the same tick. It cannot, and instead
    // oscillates fighting between them -- which is why the caught foot swung
    // through the air every tick but could never settle enough to register
    // ground contact.
    if (a.catchT > 0) {
      const foot = a.catchLeg === 0 ? 8 : 10;
      const hCom = Math.max(0.2, B.comY[slot]! - a.y);
      const tau = Math.sqrt(hCom / GRAVITY);
      const cx = B.comX[slot]! + B.comVX[slot]! * tau;
      const cz = B.comZ[slot]! + B.comVZ[slot]! * tau;
      const dx = cx - B.comX[slot]!;
      const dz = cz - B.comZ[slot]!;
      const dm = Math.sqrt(dx * dx + dz * dz);
      const ox = dm > 1e-4 ? (dx / dm) * 0.1 : 0;
      const oz = dm > 1e-4 ? (dz / dm) * 0.1 : 0;
      const tX = cx + ox - a.x;
      const tZ = cz + oz - a.z;
      // World displacement from the body origin, rotated into the same
      // body-local frame the rest of the pose -- and twoLink below -- reads.
      const footY = 0.1 * s;
      let fx = tX * c - tZ * sn;
      let fz = tX * sn + tZ * c;
      // Capped against the leg's actual 3D reach from the HIP -- the same
      // legReach the gait's own hip-dip above is measured against -- not a
      // flat horizontal number. A step this close to the ground has already
      // spent most of that reach on the vertical drop from hip to ankle, so
      // a horizontal-only cap sized as if the step were level let twoLink's
      // own out-of-reach clamp (which measures the true 3D hip-to-ankle
      // distance a few lines below) silently override the target almost
      // every tick, snapping the ankle back up toward the hip along
      // whatever direction that tick's request pointed. That silent
      // override -- not the physics -- was the caught foot's endless,
      // never-landing bounce.
      const vDrop = ly[2]! - footY;
      const maxHoriz = Math.sqrt(Math.max(0, legReach * legReach - vDrop * vDrop));
      const hx = fx - lx[2]!;
      const hz = fz - lz[2]!;
      const hm = Math.sqrt(hx * hx + hz * hz);
      if (hm > maxHoriz) {
        fx = lx[2]! + (hx / hm) * maxHoriz;
        fz = lz[2]! + (hz / hm) * maxHoriz;
      }
      lx[foot] = fx;
      lz[foot] = fz;
      ly[foot] = footY;
    }

    // Knees and elbows are solved from the hips/shoulders and the end effectors
    // rather than posed independently, so every target is reachable.
    // knees break forward and slightly outward, elbows backward and outward:
    // the directions a human joint actually bends.
    twoLink(2, 7, 8, thigh, shin, -0.24, -0.08, -0.97);
    twoLink(2, 9, 10, thigh, shin, 0.24, -0.08, -0.97);
    twoLink(1, 3, 4, upper, fore, -0.42, -0.16, 0.89);
    twoLink(1, 5, 6, upper, fore, 0.42, -0.16, 0.89);
  }

  const b = B.base(slot);
  // How far toward the intended pose the body is even trying to go. At stance
  // authority 0 the target is wherever the body already is, so a limp body is
  // not being pulled toward a standing pose it cannot reach; as authority
  // returns during a get-up, the target walks from prone to standing instead of
  // teleporting there and launching the body off the ground.
  const reach = clamp(a.stanceAuth, 0, 1);
  for (let i = 0; i < n; i++) {
    const k = b + i;
    const wx = a.x + lx[i]! * c + lz[i]! * sn;
    const wy = a.y + ly[i]!;
    const wz = a.z - lx[i]! * sn + lz[i]! * c;
    B.tx[k] = B.px[k]! + (wx - B.px[k]!) * reach;
    B.ty[k] = B.py[k]! + (wy - B.py[k]!) * reach;
    B.tz[k] = B.pz[k]! + (wz - B.pz[k]!) * reach;
  }

  // Publish the foothold this stride is committed to: one half-stride ahead of
  // the hips, on the side of whichever foot is swinging. That, not the planted
  // foot alone, is the base of support a walker is balancing against.
  if (humanoid && spd > 0.4) {
    const swingLeft = Math.sin(ph) > 0;
    const lateral = (swingLeft ? -0.115 : 0.115) * s;
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    const rx = Math.cos(a.yaw);
    const rz = -Math.sin(a.yaw);
    B.stepX[slot] = a.x + fx * stride + rx * lateral;
    B.stepZ[slot] = a.z + fz * stride + rz * lateral;
    B.stepReady[slot] = 1;
  } else {
    B.stepReady[slot] = 0;
  }
}

/**
 * Two-link inverse kinematics for one joint, in body-local metres.
 *
 * The pose generator used to nudge plan coordinates around, which quietly asks
 * for shapes a skeleton cannot make -- a deep crouch would place the knee
 * closer to the foot than the shin is long. The solver then fights the pose,
 * and the fight reads as instability. Solving the joint instead means every
 * pose handed to the solver is reachable by construction, whatever the crouch,
 * stride, kick or get-up did to the end points.
 *
 * Writes the joint position into lx/ly/lz[j].
 */
function twoLink(
  root: number,
  j: number,
  end: number,
  l1: number,
  l2: number,
  bx: number,
  by: number,
  bz: number,
) {
  const dx = lx[end]! - lx[root]!;
  const dy = ly[end]! - ly[root]!;
  const dz = lz[end]! - lz[root]!;
  let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const reach = l1 + l2 - 1e-4;
  if (d < 1e-5) {
    lx[j] = lx[root]! + bx * l1;
    ly[j] = ly[root]! + by * l1;
    lz[j] = lz[root]! + bz * l1;
    return;
  }
  const ux = dx / d;
  const uy = dy / d;
  const uz = dz / d;
  if (d > reach) {
    // out of reach: pull the end point in so the chain stays straight
    lx[end] = lx[root]! + ux * reach;
    ly[end] = ly[root]! + uy * reach;
    lz[end] = lz[root]! + uz * reach;
    d = reach;
  }
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  // component of the preferred bulge perpendicular to the chain
  const bd = bx * ux + by * uy + bz * uz;
  let ex = bx - ux * bd;
  let ey = by - uy * bd;
  let ez = bz - uz * bd;
  let em = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (em < 1e-6) {
    // degenerate: bulge is parallel to the chain, pick any perpendicular
    ex = -uy;
    ey = ux;
    ez = 0;
    em = Math.sqrt(ex * ex + ey * ey);
    if (em < 1e-6) {
      ex = 1;
      ey = 0;
      ez = 0;
      em = 1;
    }
  }
  lx[j] = lx[root]! + ux * a + (ex / em) * h;
  ly[j] = ly[root]! + uy * a + (ey / em) * h;
  lz[j] = lz[root]! + uz * a + (ez / em) * h;
}

/* ------------------------------------------------------------------ *
 * Tick
 * ------------------------------------------------------------------ */

/** Reach used for the collider shortlist and for pair broadphase, m. */
function bodyReach(a: Actor) {
  return a.height * 0.62 + 0.3;
}

function gatherPairs(w: World) {
  pairCount = 0;
  const list = w.actors;
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    if (a.body < 0) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j]!;
      if (b.body < 0) continue;
      // Standing bodies keep the cheap capsule separation; node-vs-node contact
      // is reserved for bodies that are actually loose, which is where piles,
      // draping and trips come from.
      if (!EDGES.bodyPairs) return;
      if (a.authority > 0.72 && b.authority > 0.72) continue;
      const dx = a.x - b.x;
      const dz = a.z - b.z;
      const dy = a.y - b.y;
      const r = bodyReach(a) + bodyReach(b);
      if (dx * dx + dz * dz > r * r || dy * dy > 9) continue;
      if (pairCount >= MAX_PAIRS) return;
      pairA[pairCount] = a.body;
      pairB[pairCount] = b.body;
      pairActA[pairCount] = i;
      pairActB[pairCount] = j;
      pairCount++;
    }
  }
}

interface Attachment {
  /** Node index within the holder's own body. */
  nodeA: number;
  /** Absolute node index of the far side, or -1 when the far side is a prop. */
  kb: number;
  rest: number;
  gain: number;
  holder: Actor;
  prop: Prop | null;
}
const attachments: Attachment[] = [];
const propPush = { x: 0, y: 0, z: 0 };

/**
 * Rebuilds the grab attachment set for this tick.
 *
 * A grab is a real bilateral constraint between the grabber's hand node and a
 * node of the target, so the reaction is felt by both: hauling a heavy body
 * pulls the hauler off balance, and a strong target can drag a weak grabber
 * along with it.
 */
function gatherAttachments(w: World) {
  attachments.length = 0;
  const B = w.bodies;
  for (const a of w.actors) {
    if (!a.grabbedId || a.body < 0) continue;
    const hand = a.grabNodeA >= 0 ? a.grabNodeA : B.plan(a.body).grabHand;
    const t = w.actor(a.grabbedId);
    if (t && t.body >= 0) {
      const node =
        a.grabNodeB >= 0 && a.grabNodeB < B.count[t.body]! ? a.grabNodeB : B.plan(t.body).chest;
      // grip strength is arm motor: a broken arm cannot hold a body
      const grip = clamp(armMotor(a), 0, 1);
      if (grip < 0.12) {
        releaseGrab(w, a);
        continue;
      }
      attachments.push({
        nodeA: hand,
        kb: B.base(t.body) + node,
        rest: a.grabRest,
        gain: 0.28 * grip,
        holder: a,
        prop: null,
      });
      continue;
    }
    const pr = w.prop(a.grabbedId);
    if (pr) {
      attachments.push({
        nodeA: hand,
        kb: -1,
        rest: a.grabRest,
        gain: 0.34 * clamp(armMotor(a), 0, 1),
        holder: a,
        prop: pr,
      });
      continue;
    }
    releaseGrab(w, a);
  }
}

/** Drops whatever an actor is holding without imparting a throw. */
export function releaseGrab(w: World, a: Actor) {
  if (!a.grabbedId) return;
  const t = w.actor(a.grabbedId);
  if (t) t.grabbedBy = 0;
  const pr = w.prop(a.grabbedId);
  if (pr) pr.heldBy = 0;
  a.grabbedId = 0;
  a.grabNodeA = -1;
  a.grabNodeB = -1;
  a.carry = 0;
  a.dragLoad = 0;
}

/**
 * Solves one attachment. Props are treated as single-mass bodies so that a
 * heavy crate resists exactly as hard as its mass says it should.
 */
function solveAttachments(w: World, h: number) {
  const B = w.bodies;
  for (const at of attachments) {
    // How much mass is braced behind the grip. A strong arm that still answers
    // hauls with the body behind it; a failing one is hauling with the hand
    // alone, which is why grip strength decides whether a heavy body can be
    // moved at all. Feet on the ground add far more than the body does: the
    // reaction goes into the floor, which is the difference between planting
    // yourself to drag someone and being pulled over by them.
    const holder = at.holder;
    const footing = holder.body >= 0 ? Math.min(1, B.supportCount[holder.body]! * 0.5) : 0;
    const brace = holder.mass * (0.62 + footing * 2.5) * clamp(armMotor(holder), 0, 1);
    if (at.prop) {
      const pr = at.prop;
      const invB = pr.mass > 0 ? 1 / pr.mass : 0;
      const j = attachToPoint(
        B,
        at.holder.body,
        at.nodeA,
        pr.x,
        pr.y + pr.sy * 0.5,
        pr.z,
        invB,
        at.rest,
        at.gain,
        h,
        brace,
        propPush,
      );
      pr.x += propPush.x;
      pr.y += propPush.y;
      pr.z += propPush.z;
      if (EDGES.grabLoad) at.holder.dragLoad += j;
    } else {
      const j = solveAttach(
        B,
        at.holder.body,
        at.nodeA,
        at.kb,
        B.invMass[at.kb]!,
        at.rest,
        at.gain,
        h,
        brace,
      );
      if (EDGES.grabLoad) at.holder.dragLoad += j;
    }
  }
}

/**
 * One simulation tick of the physical substrate.
 *
 * Solver order is fixed and is part of the determinism boundary: predict,
 * pose, bones, limits, attachments, world contacts, body pairs, clamp. The
 * order matters because projection is Gauss-Seidel, so it is recorded rather
 * than left to iteration order.
 */
export function stepBodies(w: World, dt: number) {
  const B = w.bodies;
  const h = dt / SUBSTEPS;

  for (const a of w.actors) {
    if (a.body < 0) continue;
    B.snapshot(a.body);
    const mat = groundMaterial(w, a.x, a.z);
    B.groundHard[a.body] = hardnessOf(mat);
    B.groundMu[a.body] = frictionOf(mat);
    B.refreshNear(a.body, w.colliders, a.x, a.z, bodyReach(a));
    // How much of the body stands behind any one node in a contact with
    // another body. Feet planted: the blow is met by the whole man and, past
    // him, the ground. Airborne: it is met by the limb alone.
    B.backing[a.body] = Math.min(1, B.supportCount[a.body]! * 0.5);
    a.dragLoad = 0;
    writePose(w, a, dt);
  }
  gatherPairs(w);
  gatherAttachments(w);
  // Props are solved in the same loop as bodies, not after it: they are the
  // same substrate, and a contact between them has to land before `consume`.
  liveFrameCount = beginFrames(B, w.props, w.colliders, liveFrames);

  for (let step = 0; step < SUBSTEPS; step++) {
    for (const a of w.actors) {
      if (a.body < 0) continue;
      predict(B, a.body, h, GRAVITY);
    }
    predictFrames(B, h);
    for (const a of w.actors) {
      if (a.body < 0) continue;
      for (let r = 0; r < 6; r++) B.gain[r] = poseGain(a.motor[REGIONS[r]!]!, h, POSE_RATE);
      // How much of the pose's net centre-of-mass push the contacts can react.
      // Two feet down is full authority; nothing down is none.
      solvePose(B, a.body, h, 0, Math.min(1, B.supportCount[a.body]! * 0.5));
      solveBones(B, a.body, h, a.authority);
      solveLimits(B, a.body);
    }
    solveAttachments(w, h);
    for (const a of w.actors) {
      if (a.body < 0) continue;
      solveWorld(B, a.body, w.colliders, h, 0);
    }
    solveFrames(B, liveFrames, liveFrameCount, w.colliders, h);
    for (let i = 0; i < pairCount; i++) {
      const load = solvePair(B, pairA[i]!, pairB[i]!, h);
      B.pileLoad[pairA[i]!] = B.pileLoad[pairA[i]!]! + load;
    }
    solveActorFrames(w, h);
    for (const a of w.actors) {
      if (a.body < 0) continue;
      finish(B, a.body, h, MAX_NODE_SPEED);
    }
    finishFrames(B, h);
  }

  endFrames(B, w.props, dt, SUBSTEPS);
  for (const a of w.actors) {
    if (a.body < 0) continue;
    B.updateCom(a.body, h);
    consume(w, a, dt);
  }
}

/* ------------------------------------------------------------------ *
 * Reading the body back into the actor
 * ------------------------------------------------------------------ */

/**
 * Turns the tick's node contacts into injury, balance and locomotion state,
 * then reconciles the locomotion capsule with the solved body.
 *
 * The capsule <-> body coupling is bidirectional, so its loop gain is bounded
 * by construction: the body follows the pose target with gain ~= authority and
 * the capsule follows the body with gain (1 - authority), giving a round-trip
 * gain of authority * (1 - authority), maximised at 1/4 when authority = 1/2.
 * That is comfortably inside the <= 1/2 margin, at every authority value, with
 * no tuning.
 */
function consume(w: World, a: Actor, dt: number) {
  const B = w.bodies;
  const slot = a.body;
  const b = B.base(slot);
  const n = B.count[slot]!;

  // --- impact-local injury -------------------------------------------------
  // Peaks are taken per region, not summed per node, so a two-node limb is not
  // hurt twice by one contact; and the damage-history reference means the same
  // landing does not keep wounding while the body settles.
  B.decayRef(slot, dt, DAMAGE_RECOVER);
  for (let r = 0; r < 6; r++) {
    regionV[r] = 0;
    regionVt[r] = 0;
    regionHard[r] = 0;
  }
  let peak = 0;
  let peakRegion: Region = "torso";
  let footContact = false;
  /** Did the committed catch foot itself register real ground contact this tick. */
  let catchFootTouched = false;
  let lowest = Infinity;
  let headDv = 0;
  // Peak closing speed on the trunk only. A blow to the body interrupts a
  // get-up; a hand pressing on the floor to push yourself up does not, and
  // using every node's contact makes a rising body knock itself back down.
  let trunkPeak = 0;
  const plan = B.plan(slot);
  for (let i = 0; i < n; i++) {
    const k = b + i;
    const yb = B.py[k]! - B.rad[k]!;
    if (yb < lowest) lowest = yb;
    if (!B.touched[k]) continue;
    if (i === plan.feet[0] || i === plan.feet[1]) footContact = true;
    if (a.catchT > 0 && n === 11 && i === plan.feet[a.catchLeg] && !a.catchLanded) {
      catchFootTouched = true;
    }
    const jn = B.jimp[k]!;
    if (jn <= 0) continue;
    const ri = REGION_OF[B.region[k]!]!;
    // Active muscle absorbs part of the closing speed before the tissue takes
    // it. The same motor authority that drives the pose also protects the limb,
    // so losing consciousness genuinely costs you the fall.
    // Muscle absorbs impact, but it has a finite capacity: past what the limb
    // can take, bracing stops helping. This is why a controlled hop is free and
    // a controlled fall from a roof is not.
    const m = a.motor[REGIONS[B.region[k]!]!]!;
    const raw = B.vmax[k]!;
    const mLimb = B.mass[k]!;
    // Everything below is an energy ratio under a square root, because that is
    // what the damage law is: it is calibrated on a limb meeting the ground
    // with its own mass behind it, and 2*E = m*v^2.
    const mEff = B.vmass[k]! > 0 ? B.vmass[k]! : mLimb;
    // What muscle can absorb is an energy budget, not a speed one: a limb can
    // arrest about its own mass at LAND_LIMIT. For a fall the arriving energy
    // uses that same mass and this reduces to (LAND_LIMIT/v)^2 -- which is why
    // bracing a hop is free and bracing a roof is not. Against 90 kg of beam
    // the budget is spent in the first millisecond and bracing barely helps.
    const eHit = mEff * raw * raw;
    const eCap = mLimb * LAND_LIMIT * LAND_LIMIT;
    const capacity = eHit > eCap ? eCap / eHit : 1;
    const absorbed = ABSORB_MAX * m * capacity;
    // Heft: how much more energy this blow carries than the same speed would
    // carry in a fall. It enters as the square root of the mass ratio, exactly
    // as contact concentration does, and is 1 for every contact with the world
    // -- which is why falls are untouched by it. Without it a dropped beam and
    // a slap were the same event to the tissue, and the substrate could injure
    // you with your own weight but never with anything else's.
    const heft = Math.min(HEFT_MAX, mEff / mLimb);
    const scale = Math.sqrt(heft * (1 - absorbed));
    const v = raw * scale;
    if (v > regionV[ri]!) regionV[ri] = v;
    const vt = B.vtan[k]! * scale;
    if (vt > regionVt[ri]!) regionVt[ri] = vt;
    if (B.jhard[k]! > regionHard[ri]!) regionHard[ri] = B.jhard[k]!;
    if (i === plan.head) headDv = Math.max(headDv, jn / B.mass[k]!);
    if (i === plan.head || i === plan.chest || i === plan.pelvis) {
      trunkPeak = Math.max(trunkPeak, B.vmax[k]!);
    }
    if (B.vmax[k]! > peak) {
      peak = B.vmax[k]!;
      peakRegion = REGIONS[B.region[k]!]!;
    }
  }
  for (let r = 0; r < 6; r++) {
    if (regionV[r]! <= 0 && regionVt[r]! <= 0) continue;
    const region = REGIONS[r]!;
    const excess = B.takeExcess(slot, r, regionV[r]!);
    if (excess <= 0 && regionVt[r]! <= 0.3) continue;
    const got = impulseDamage(
      a.injuries[region],
      excess,
      regionVt[r]!,
      regionHard[r]!,
      boneTolOf(region),
      1,
      0,
      0,
    );
    if (got > 0) {
      a.pain = clamp(a.pain + got * 0.55, 0, 1);
      if (a.injuries[region].cut > 0.2) a.bleed += got * 0.12;
    }
  }
  // Concussion runs on the head's change in velocity, which is the quantity it
  // actually depends on, not on the pressure at the skin.
  if (headDv > 0) a.consciousness = clamp(a.consciousness - concussion(headDv), 0, 1);
  a.lastImpact = peak;
  a.impactRegion = peakRegion;
  a.pileLoad = B.pileLoad[slot]!;

  // Read-only expression channels driven by the same contact. They derive cues
  // from the closing speed without debiting the physical budget.
  if (peak > 1.7) {
    const mag = Math.min(1.4, 0.2 + peak / 14);
    w.emitSound(a.x, a.z, mag, peak > 5 ? "impact" : "step", a.id);
    if (a.kind === "player" && peak > 4) w.shake = Math.max(w.shake, Math.min(0.55, peak / 26));
  }

  // --- balance from the support polygon ------------------------------------
  // A body that is deliberately moving under its own power is judged against
  // the foothold it is committed to, not only the foot currently down.
  const striding = a.intendSpeed > 0.4 && a.authority > 0.35;
  // Only a body with motor authority has intent to discount; a limp one is
  // judged against its whole velocity, which is why a thrown body is never
  // "balanced".
  const iv = a.authority > 0.2 ? a.intendSpeed * a.authority : 0;
  const margin = EDGES.supportBalance
    ? B.supportMargin(slot, striding, a.intendX, a.intendZ, iv)
    : 0.15;
  a.support = margin;
  a.balance = clamp(0.5 + margin / (2 * BAL_REF), 0, 1);
  a.grounded = a.grounded || footContact;

  // --- fall, catch and get-up ----------------------------------------------
  const controllable = isControllable(a);

  // --- counterweight: the smallest trouble, answered before a step --------
  //
  // Reads the SAME residual deviation `margin` was just built from -- the
  // point this body would actually have to catch itself at -- so the
  // direction a body leans is the direction it is actually failing to
  // arrest, not a guess. This is deliberately continuous and reflexive:
  // no threshold, no commitment, just a bounded pull toward whichever
  // shift would bring the capture point back over the base, fading in
  // and out with how far out it already is and how hard the body is
  // even trying (`controllable`). The catch-STEP below is the next,
  // discrete rung on the same ladder once this alone is not enough.
  if (controllable && EDGES.supportBalance) {
    const devX = B.captureX[slot]! - a.x;
    const devZ = B.captureZ[slot]! - a.z;
    const devM = Math.hypot(devX, devZ) || 1;
    // How much of margin's own trouble to answer, saturating at the same
    // depth that already means "off balance the instant it happens" --
    // by the time a real catch step is warranted this is already maxed.
    const trouble = clamp(-margin / -OFF_BALANCE_DEEP, 0, 1);
    const c = Math.cos(a.yaw);
    const sn = Math.sin(a.yaw);
    // World deviation into the same body-local frame writePose builds its
    // pose in, so this can be added directly to leanX/leanZ there.
    const localX = (devX * c - devZ * sn) / devM;
    const localZ = (devX * sn + devZ * c) / devM;
    const targetRZ = trouble > 0 ? -localZ * trouble * RECOVER_LEAN_MAX : 0;
    const targetRX = trouble > 0 ? -localX * trouble * RECOVER_LEAN_MAX : 0;
    const k = 1 - Math.exp(-dt * RECOVER_RATE);
    a.recoverZ += (targetRZ - a.recoverZ) * k;
    a.recoverX += (targetRX - a.recoverX) * k;
  } else {
    const k = 1 - Math.exp(-dt * RECOVER_RATE);
    a.recoverZ -= a.recoverZ * k;
    a.recoverX -= a.recoverX * k;
  }

  const catchWasActive = a.catchT > 0;
  if (a.catchT > 0) a.catchT = Math.max(0, a.catchT - dt);
  if (catchWasActive && a.catchT <= 0) a.catchCooldown = CATCH_RECOMMIT_COOLDOWN;
  if (a.catchCooldown > 0) a.catchCooldown = Math.max(0, a.catchCooldown - dt);
  if (a.tripT > 0) a.tripT = Math.max(0, a.tripT - dt);
  // Flight is not a balance failure, so the airborne sentinel must not feed the
  // off-balance timer: a running gait has both feet off the ground every stride.
  const grounded = B.supportCount[slot]! > 0;
  if (grounded && margin < 0) a.offBalT += dt;
  else a.offBalT = Math.max(0, a.offBalT - dt * 2.5);
  const losing = grounded && (a.offBalT > OFF_BALANCE_GRACE || margin < OFF_BALANCE_DEEP);

  const perr = poseError(B, slot);
  if (controllable) {
    a.stanceAuth = Math.min(1, a.stanceAuth + dt * 3.2);
    if (perr > POSE_LOST) {
      // The world is moving this body faster than its muscles can correct it.
      // Shoves, blast impulses and falling timber all arrive here rather than
      // through a knockdown flag of their own.
      collapse(w, a, 0.3 + perr);
    } else if (B.supportCount[slot]! === 0 && a.catchT <= 0) {
      // Airborne is flight, not a balance failure. The landing decides: legs
      // that still have motor authority can absorb it, damaged ones cannot,
      // which is why a bad leg turns an ordinary drop into a fall.
      //
      // Gated to no catch already committed: the recovery lurch of an
      // ACTIVE catch step can genuinely unweight both feet for an instant
      // without being a jump or a fall, and cancelling the commitment on
      // that transient reopened the decision the very next grounded tick --
      // margin was still bad, so it immediately recommitted a BRAND NEW
      // capture-point target, one tick after the last one. Repeated a few
      // times a second, that is a real target hopping around under the
      // solver every tick rather than holding still long enough to be
      // reached, and the ever-growing gap between "where the target keeps
      // jumping to" and "where the body actually is" is exactly what pose
      // error measures -- so the thrash was walking itself into the very
      // POSE_LOST collapse just above during perfectly ordinary walking,
      // no shove or hit involved. An already-committed catch now rides out
      // its own 0.36s hold through a momentary loss of support instead of
      // being cancelled and immediately re-decided.
    } else if (peak > LAND_LIMIT * (0.25 + legMotor(a) * 0.75)) {
      collapse(w, a, 0.35 + peak * 0.04);
    } else if (losing) {
      // A capture point outside the base is not yet a fall. A body catches
      // itself by planting a foot, so what decides the excursion is whether a
      // foot can still reach it -- and walking puts the capture point outside
      // the stance foot on every single stride. Judged against the current
      // base alone, ordinary walking read as falling, and villagers went down
      // at a walking pace on flat ground; the fallen frightened everyone who
      // saw them, and the fright produced more walking bodies to fall over.
      // Leg motor sets the reach, so this is also why a sound body strides
      // through what puts a damaged one on the floor.
      //
      // The STRIDE term is frozen at `a.catchStrideM` only while a catch is
      // already committed (`a.catchT > 0`); a fresh decision -- nothing
      // committed yet -- reads the same live formula a catch would freeze,
      // since there is nothing in progress yet to protect. Without this
      // split, a body that had never caught before read `a.catchStrideM`'s
      // zeroed default as its reach and fell with NO tolerance on its very
      // first excursion, before the commit branch below ever ran to give it
      // one. Once committed, intent is not recomputed: a body mid-catch
      // throwing a punch legitimately zeroes forward intent -- that is not
      // the body giving up the reach it already committed a foot to, and
      // recomputing it from intent every tick read it as exactly that:
      // intent hit zero, catchReach collapsed to its floor, and the very
      // next tick's margin (already deep, mid-recovery) fell past a bound
      // that had quietly shrunk out from under it. Leg motor and stamina
      // stay LIVE either way, since an injury sustained mid-catch genuinely
      // still costs you.
      const physSpeed = Math.hypot(B.comVX[slot]!, B.comVZ[slot]!);
      const liveStrideM = strideAmp(Math.max(a.intendSpeed, physSpeed), B.scale[slot]!);
      const strideM = a.catchT > 0 ? a.catchStrideM : liveStrideM;
      const catchReach = strideM * CATCH_STRIDES * legMotor(a) * (a.stamina > 0.03 ? 1 : 0.4);
      if (margin < FALL_MARGIN - catchReach || a.consciousness < STANCE_CONSCIOUS) {
        collapse(w, a);
      } else if (a.catchT <= 0) {
        const lm = legMotor(a);
        if (lm <= 0.34 || a.stamina <= 0.03 || a.tripT > 0) {
          collapse(w, a);
        } else if (a.catchCooldown <= 0) {
          a.catchLeg = a.motor.lleg >= a.motor.rleg ? 0 : 1;
          a.catchT = 0.36;
          a.catchLanded = false;
          // Entry momentum, not entry intent: a shove can leave a body moving
          // fast with no forward intent behind it at all -- the same live
          // number just used above to decide whether to even reach this
          // branch is what gets frozen for the rest of the catch.
          a.catchStrideM = liveStrideM;
          a.stamina = Math.max(0, a.stamina - 0.025);
          if (a.loco !== "stumble") {
            a.loco = "stumble";
            a.locoT = 0.4;
          }
        }
        // else: cooling down from the last catch (CATCH_RECOMMIT_COOLDOWN) --
        // legs and stamina are fine, so this is not a collapse, but nothing
        // relocates a foot again either; the continuous counterweight lean
        // above keeps answering it in the meantime.
      }
    }
    // Gait resumes from the foot that actually caught you. Without this the
    // walk clock free-runs through the whole recovery off whatever speed the
    // body happens to have mid-stumble, and normal gait picks back up wherever
    // that drifted to -- not necessarily the foot just planted -- so the first
    // stride out of a catch could ask the JUST-LANDED foot to immediately
    // swing again. Snapping to the nearest phase where the caught foot is the
    // planted one, at the real moment it registers ground contact rather than
    // an arbitrary timer edge, means the next stride is always the other foot
    // swinging through from a real plant, the same as an unassisted step.
    if (catchFootTouched) {
      a.catchLanded = true;
      const target = a.catchLeg === 0 ? Math.PI : 0;
      const twoPi = Math.PI * 2;
      a.walkPhase = target + Math.round((a.walkPhase - target) / twoPi) * twoPi;
    }
  } else if (a.loco === "ragdoll" || a.loco === "pin") {
    a.stanceAuth = Math.max(0, a.stanceAuth - dt * (LIMP_RATE + 6 * (1 - a.consciousness)));
    const settled =
      a.stanceAuth < 0.05 && Math.hypot(B.comVX[slot]!, B.comVY[slot]!, B.comVZ[slot]!) < 0.85;
    const pinned = a.pileLoad > a.mass * 0.85;
    if (pinned) {
      a.loco = "pin";
      a.stanceAuth = Math.min(a.stanceAuth, 0.3);
    } else if (settled && a.locoT <= 0 && a.consciousness > RISE_CONSCIOUS && a.alive) {
      a.loco = "getup";
      a.getupT = 0;
    } else {
      a.locoT -= dt;
    }
  } else if (a.loco === "getup") {
    // Get-up rate falls with head trauma, limb damage and anything lying on you.
    const legInj = injurySum(a.injuries.lleg) + injurySum(a.injuries.rleg);
    const armInj = injurySum(a.injuries.larm) + injurySum(a.injuries.rarm);
    const rate =
      1 / (0.85 + 1.7 * (1 - a.consciousness) + 1.3 * legInj + 0.7 * armInj + a.pileLoad / 90);
    a.getupT += dt;
    a.stanceAuth = clamp(a.stanceAuth + rate * dt, 0, 1);
    if (trunkPeak > KNOCK_V) {
      // Knocked back down mid-rise: this is what keeps a downed target down.
      a.stanceAuth = Math.max(0, a.stanceAuth - trunkPeak / 9);
      if (a.stanceAuth < 0.12) collapse(w, a);
    }
    if (a.pileLoad > a.mass * 0.85) {
      a.loco = "pin";
    } else if (a.stanceAuth > 0.93 && margin > -0.02) {
      a.loco = "idle";
      a.balance = 0.65;
    }
  }

  // --- capsule reconciliation ---------------------------------------------
  const share = Math.max(MIN_BODY_SHARE, 1 - a.authority);
  {
    a.x += (B.comX[slot]! - a.x) * share;
    a.z += (B.comZ[slot]! - a.z) * share;
    if (lowest < Infinity) a.y += (lowest - a.y) * share;
    a.vx += (B.comVX[slot]! - a.vx) * share;
    a.vy += (B.comVY[slot]! - a.vy) * share;
    a.vz += (B.comVZ[slot]! - a.vz) * share;
    if (share > 0.5 && B.count[slot]! === 11) {
      // Yaw follows the shoulder line: forward = up x shoulderAxis.
      const kl = b + 3;
      const kr = b + 5;
      const sx = B.px[kr]! - B.px[kl]!;
      const sz = B.pz[kr]! - B.pz[kl]!;
      const m = Math.sqrt(sx * sx + sz * sz);
      if (m > 0.08) {
        const fx = -sz / m;
        const fz = sx / m;
        a.yaw = Math.atan2(-fx, -fz);
      }
    }
  }
}

/**
 * The stance is lost. Motor authority is not switched off: it bleeds out over a
 * fraction of a second, faster the less conscious the body is. That is what
 * losing your footing actually looks like -- a short window of failing control,
 * not a state change -- and it is why the fall, the injury and the loss of
 * control are visibly the same event rather than three that happen to coincide.
 */
export function collapse(w: World, a: Actor, hold = 0) {
  if (a.loco === "ragdoll" || a.loco === "down") return;
  a.loco = "ragdoll";
  a.locoT = Math.max(hold, 0.45 + (1 - a.balance) * 0.5);
  a.stanceAuth = Math.min(a.stanceAuth, 0.8);
  a.catchT = 0;
  a.intendSpeed = 0;
  if (a.kind === "human" || a.kind === "player") w.emitSound(a.x, a.z, 0.5, "impact", a.id);
}

/** Rate at which a body that has lost its stance gives up the rest of it, s^-1. */
const LIMP_RATE = 4.2;
/**
 * Consciousness below which a body cannot hold a stance at all: the balance
 * controller stops trying and lets it go down.
 */
export const STANCE_CONSCIOUS = 0.3;
/**
 * Consciousness a body must reach before it tries to get up.
 *
 * This has to sit clear ABOVE `STANCE_CONSCIOUS`, not below it. It used to be
 * 0.25 against a floor of 0.3, which left a band where a body would rise, be
 * collapsed by its own balance controller on the next tick, hit the ground,
 * and try again -- banging its head until the head trauma killed it. Anything
 * that decides a body is ready to be back on its feet reads this.
 */
export const RISE_CONSCIOUS = 0.36;

/**
 * Trip test: a foot that finds contact well above the ground while the body is
 * moving is a foot that hit something. The consequence is rotational: the feet
 * stop and the chest keeps going.
 */
export function checkTrips(w: World, dt: number) {
  for (let i = 0; i < pairCount; i++) {
    const a = w.actors[pairActA[i]!]!;
    const b = w.actors[pairActB[i]!]!;
    // You do not trip over the body you are carrying.
    const linked = a.grabbedId === b.id || b.grabbedId === a.id;
    if (!linked) {
      tripOne(w, a, pairA[i]!, dt);
      tripOne(w, b, pairB[i]!, dt);
    }
  }
}

const TRIP_H = 0.17;
const TRIP_SPEED = 1.5;

function tripOne(w: World, a: Actor, slot: number, dt: number) {
  if (!a.alive || a.authority < 0.5 || a.tripT > 0) return;
  const spd = Math.sqrt(a.vx * a.vx + a.vz * a.vz);
  if (spd < TRIP_SPEED) return;
  const B = w.bodies;
  const plan = B.plan(slot);
  const b = B.base(slot);
  for (const f of plan.feet) {
    const k = b + f;
    if (!B.touched[k]) continue;
    if (B.py[k]! - B.rad[k]! - a.y < TRIP_H) continue;
    a.tripT = 0.55;
    // feet held, chest carried forward: a real forward pitch, not a canned one
    const fdir = facing(a.yaw);
    B.applyImpulse(
      slot,
      plan.chest,
      fdir.x * a.mass * 1.9,
      6 * a.mass * 0.06,
      fdir.z * a.mass * 1.9,
      dt,
    );
    a.stanceAuth = Math.min(a.stanceAuth, 0.25);
    a.balance = 0;
    a.loco = "stumble";
    a.locoT = 0.5;
    w.emitSound(a.x, a.z, 0.45, "step", a.id);
    return;
  }
}

/** Total node count in play; used by the frame budget readout. */
export function activeNodes(w: World) {
  let n = 0;
  for (const a of w.actors) if (a.body >= 0) n += w.bodies.count[a.body]!;
  return n;
}

/** Number of body-body node contact pairs solved this tick. */
export function lastPairCount() {
  return pairCount;
}

/**
 * Contact between actor bodies and prop frames.
 *
 * This is the edge that makes a falling beam a physical event rather than a
 * scripted one: it goes through the same node-vs-node solver as body-against-
 * body, so the beam lands on whichever limb was under it and that limb takes
 * the damage, with the prop's own material deciding how hard the blow is.
 */
/**
 * Actor against prop frame, for one substep.
 *
 * This runs inside the substep loop, not after it. A beam falling at 8 m/s
 * covers 13 cm in a tick and only 3 cm in a substep, so resolving it once per
 * tick both tunnels and, worse, lands the impulse after `consume` has already
 * turned the tick's contacts into injury -- the next tick's `snapshot` then
 * wipes it. Interleaved, a dropped beam breaks a shoulder through exactly the
 * same node contact and damage law as a fall or a club.
 */
function solveActorFrames(w: World, h: number) {
  const B = w.bodies;
  for (let i = 0; i < liveFrameCount; i++) {
    const slot = liveFrames[i]!;
    const prop = w.prop(framePropId(B, slot));
    const hard = prop ? hardnessOf(prop.material) : 0.7;
    const b = B.base(slot);
    const fx = B.px[b]!;
    const fz = B.pz[b]!;
    for (const a of w.actors) {
      if (a.body < 0) continue;
      // Held props ride with the holder; contact with them would fight the grab.
      if (prop && prop.heldBy === a.id) continue;
      const dx = a.x - fx;
      const dz = a.z - fz;
      if (dx * dx + dz * dz > 16) continue;
      const load = solvePair(B, a.body, slot, h, hard);
      if (load > 0) {
        B.pileLoad[a.body] = B.pileLoad[a.body]! + load;
        wakeFrame(B, slot);
      }
    }
  }
}

export { Bodies };
