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

/** Pose stiffness of a fully authoritative limb, s^-1. */
const POSE_RATE = 62;
/** Support margin, m, that maps to balance = 1. */
const BAL_REF = 0.15;
/** Margin, m, past which no catch step can save the fall. */
const FALL_MARGIN = -0.34;
/**
 * Mean pose-tracking error, m, past which the body is judged to have been
 * physically overpowered and the stance is lost.
 */
const POSE_LOST = 0.34;
/** Closing speed, m/s, above which a contact interrupts a get-up. */
const KNOCK_V = 3.4;
/** Landing speed a fully able pair of legs can absorb without going down, m/s. */
const LAND_LIMIT = 9.5;
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

/** Mean motor over the two legs: what gait speed and catch steps depend on. */
export function legMotor(a: Actor) {
  return (a.motor.lleg + a.motor.rleg) * 0.5;
}

/** Mean motor over the two arms: what grab and strike strength depend on. */
export function armMotor(a: Actor) {
  return (a.motor.larm + a.motor.rarm) * 0.5;
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
function writePose(w: World, a: Actor) {
  const B = w.bodies;
  const slot = a.body;
  const plan = B.plan(slot);
  const s = B.scale[slot]!;
  const n = B.count[slot]!;
  // The raw crouch input is a boolean; smoothing it keeps an instant keypress
  // from asking the solver for a pose change no body could make.
  a.crouchAmt += ((a.crouch ? 1 : 0) - a.crouchAmt) * 0.22;
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
  const stride = Math.min(0.42, spd * 0.075) * s;
  const lift = Math.min(0.13, spd * 0.022) * s;
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

    // torso leans into travel and away from the load being dragged
    const lean = clamp(a.leanZ, -0.22, 0.22) * s;
    const roll = clamp(a.leanX, -0.18, 0.18) * s;
    lz[1] = lz[1]! + lean;
    lz[0] = lz[0]! + lean * 1.35;
    lx[1] = lx[1]! + roll;
    lx[0] = lx[0]! + roll * 1.3;
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

  if (humanoid) {
    // Knees and elbows are solved from the hips/shoulders and the end effectors
    // rather than posed independently, so every target is reachable.
    const thigh = restLen(plan, 2, 7) * s;
    const shin = restLen(plan, 7, 8) * s;
    const upper = restLen(plan, 1, 3) * s;
    const fore = restLen(plan, 3, 4) * s;
    // knees break forward and slightly outward, elbows backward and outward:
    // the directions a human joint actually bends.
    twoLink(2, 7, 8, thigh, shin, -0.24, -0.08, -0.97);
    twoLink(2, 9, 10, thigh, shin, 0.24, -0.08, -0.97);
    twoLink(1, 3, 4, upper, fore, -0.42, -0.16, 0.89);
    twoLink(1, 5, 6, upper, fore, 0.42, -0.16, 0.89);
  }

  const c = Math.cos(a.yaw);
  const sn = Math.sin(a.yaw);
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

  // The catch step overrides one foot target with the capture point: the place
  // the body would actually have to step to arrest the fall it is already in.
  if (a.catchT > 0 && humanoid) {
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
    const reach = 0.82 * s;
    let tX = cx + ox - a.x;
    let tZ = cz + oz - a.z;
    const tm = Math.sqrt(tX * tX + tZ * tZ);
    if (tm > reach) {
      tX = (tX / tm) * reach;
      tZ = (tZ / tm) * reach;
    }
    const kf = b + foot;
    B.tx[kf] = a.x + tX;
    B.ty[kf] = a.y + 0.1 * s;
    B.tz[kf] = a.z + tZ;
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
  ka: number;
  kb: number;
  rest: number;
  gain: number;
  holder: Actor;
  prop: Prop | null;
}
const attachments: Attachment[] = [];

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
    const ka = B.base(a.body) + hand;
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
        ka,
        kb: B.base(t.body) + node,
        rest: a.grabRest,
        gain: 0.35 * grip,
        holder: a,
        prop: null,
      });
      continue;
    }
    const pr = w.prop(a.grabbedId);
    if (pr) {
      attachments.push({
        ka,
        kb: -1,
        rest: a.grabRest,
        gain: 0.42 * clamp(armMotor(a), 0, 1),
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
    if (at.prop) {
      const pr = at.prop;
      const dx = B.px[at.ka]! - pr.x;
      const dy = B.py[at.ka]! - (pr.y + pr.sy * 0.5);
      const dz = B.pz[at.ka]! - pr.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-12) continue;
      const d = Math.sqrt(d2);
      const C = d - at.rest;
      if (C <= 0) continue;
      const wa = B.invMass[at.ka]!;
      const wb = pr.mass > 0 ? 1 / pr.mass : 0;
      const wSum = wa + wb;
      if (wSum <= 0) continue;
      const s = (C * at.gain) / (d * wSum);
      B.px[at.ka] = B.px[at.ka]! - dx * s * wa;
      B.py[at.ka] = B.py[at.ka]! - dy * s * wa;
      B.pz[at.ka] = B.pz[at.ka]! - dz * s * wa;
      pr.x += dx * s * wb;
      pr.y += dy * s * wb;
      pr.z += dz * s * wb;
      if (EDGES.grabLoad) at.holder.dragLoad += (C * at.gain) / (wSum * h);
    } else {
      const j = solveAttach(B, at.ka, at.kb, at.rest, at.gain, h);
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
    a.dragLoad = 0;
    writePose(w, a);
  }
  gatherPairs(w);
  gatherAttachments(w);

  for (let step = 0; step < SUBSTEPS; step++) {
    for (const a of w.actors) {
      if (a.body < 0) continue;
      predict(B, a.body, h, GRAVITY);
    }
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
    for (let i = 0; i < pairCount; i++) {
      const load = solvePair(B, pairA[i]!, pairB[i]!, h);
      B.pileLoad[pairA[i]!] = B.pileLoad[pairA[i]!]! + load;
    }
    for (const a of w.actors) {
      if (a.body < 0) continue;
      finish(B, a.body, h, MAX_NODE_SPEED);
    }
  }

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
    const capacity = raw > LAND_LIMIT ? LAND_LIMIT / raw : 1;
    const absorb = 1 - 0.62 * m * capacity;
    const v = B.vmax[k]! * absorb;
    if (v > regionV[ri]!) regionV[ri] = v;
    const vt = B.vtan[k]! * absorb;
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
  const margin = EDGES.supportBalance ? B.supportMargin(slot) : 0.15;
  a.support = margin;
  a.balance = clamp(0.5 + margin / (2 * BAL_REF), 0, 1);
  a.grounded = a.grounded || footContact;

  // --- fall, catch and get-up ----------------------------------------------
  const controllable =
    a.alive &&
    a.loco !== "ragdoll" &&
    a.loco !== "down" &&
    a.loco !== "getup" &&
    a.loco !== "pin" &&
    a.loco !== "vault";

  if (a.catchT > 0) a.catchT = Math.max(0, a.catchT - dt);
  if (a.tripT > 0) a.tripT = Math.max(0, a.tripT - dt);

  const perr = poseError(B, slot);
  if (controllable) {
    a.stanceAuth = Math.min(1, a.stanceAuth + dt * 3.2);
    if (perr > POSE_LOST) {
      // The world is moving this body faster than its muscles can correct it.
      // Shoves, blast impulses and falling timber all arrive here rather than
      // through a knockdown flag of their own.
      collapse(w, a, 0.3 + perr);
    } else if (B.supportCount[slot]! === 0) {
      // Airborne is flight, not a balance failure. The landing decides: legs
      // that still have motor authority can absorb it, damaged ones cannot,
      // which is why a bad leg turns an ordinary drop into a fall.
      a.catchT = 0;
    } else if (peak > LAND_LIMIT * (0.25 + legMotor(a) * 0.75)) {
      collapse(w, a, 0.35 + peak * 0.04);
    } else if (margin < 0) {
      if (margin < FALL_MARGIN || a.consciousness < 0.3) {
        collapse(w, a);
      } else if (a.catchT <= 0) {
        const lm = legMotor(a);
        if (lm > 0.34 && a.stamina > 0.03 && a.tripT <= 0) {
          a.catchLeg = a.motor.lleg >= a.motor.rleg ? 0 : 1;
          a.catchT = 0.36;
          a.stamina = Math.max(0, a.stamina - 0.025);
          if (a.loco !== "stumble") {
            a.loco = "stumble";
            a.locoT = 0.4;
          }
        } else {
          collapse(w, a);
        }
      }
    }
  } else if (a.loco === "ragdoll" || a.loco === "pin") {
    a.stanceAuth = Math.max(0, a.stanceAuth - dt * (LIMP_RATE + 6 * (1 - a.consciousness)));
    const settled =
      a.stanceAuth < 0.05 && Math.hypot(B.comVX[slot]!, B.comVY[slot]!, B.comVZ[slot]!) < 0.85;
    const pinned = a.pileLoad > a.mass * 0.85;
    if (pinned) {
      a.loco = "pin";
      a.stanceAuth = Math.min(a.stanceAuth, 0.3);
    } else if (settled && a.locoT <= 0 && a.consciousness > 0.25 && a.alive) {
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
 * Trip test: a foot that finds contact well above the ground while the body is
 * moving is a foot that hit something. The consequence is rotational: the feet
 * stop and the chest keeps going.
 */
export function checkTrips(w: World, dt: number) {
  const B = w.bodies;
  for (let i = 0; i < pairCount; i++) {
    const ia = pairActA[i]!;
    const ib = pairActB[i]!;
    tripOne(w, w.actors[ia]!, pairA[i]!, dt);
    tripOne(w, w.actors[ib]!, pairB[i]!, dt);
  }
  void B;
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

export { Bodies };
