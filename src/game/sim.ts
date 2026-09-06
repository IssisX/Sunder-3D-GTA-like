import type { Actions } from "./input";
import {
  type Actor,
  type Collider,
  type Building,
  type Prop,
  type Region,
  type WeaponKind,
  WEAPON_STATS,
  FIRE_CELL,
  FIRE_RES,
  GRAVITY,
  HALF,
  REGIONS,
  STEP,
} from "./types";
import {
  World,
  canSeeThrough,
  clamp,
  dist2,
  facing,
  injurySum,
  lerpAng,
  locoSpeed,
  rightOf,
} from "./world";
import {
  EDGES,
  boneTolOf,
  concussion,
  contactFocus,
  hardnessOf,
  impulseDamage,
} from "./body";
import { dropFrame, makeFrame, wakeFrame } from "./frames";
import { HELD, solveReactions } from "./statics";
import {
  RISE_CONSCIOUS,
  armMotor,
  checkTrips,
  collapse,
  legMotor,
  releaseGrab,
  stepBodies,
  updateMotor,
} from "./physique";
import {
  avoidBodies,
  incapacity,
  isHelpless,
  isOffBalance,
  shouldStrikeLow,
  threatLevel,
} from "./tactics";

const CAM_FORWARD = (yaw: number) => facing(yaw);
const STEP_UP = 0.48;
/** Fastest a prop may be moving at the moment it becomes a physical body, m/s. */
const PROP_BIRTH_SPEED = 10;
/**
 * Per-node velocity discontinuity applied at a single frame node to start a
 * collapse rotating, m/s-equivalent against the whole prop's mass. These are
 * not measured physical speeds -- concentrating a small kick on one node
 * while its neighbours keep the body's bulk velocity is what the constraint
 * solve turns into torque, the same mechanism validated for melee and throw
 * impulses. `EDGE` pushes sideways from a guessed direction; `DROP` pulls a
 * known failed corner down.
 */
const COLLAPSE_EDGE_KICK = 0.06;
const COLLAPSE_DROP_KICK = 0.5;
/**
 * How fast the sight of a body that is no longer news keeps working on a
 * witness, as a fraction of the discovery shock per second. Well above the
 * 0.05/s fear decay, so standing over the fallen still wears on you; far below
 * the discovery itself, so it is dread rather than a fresh horror sixty times
 * a second.
 */
const BODY_DREAD_RATE = 0.35;
/**
 * Ceiling on the fear a heard scream alone may produce.
 *
 * Sits below the lowest panic threshold (`0.55 + courage*0.35`, so 0.55 at
 * courage 0), which is what holds the crowd's loop gain under one: a scream
 * can bring a listener to the edge and never over it, so screaming cannot
 * propagate itself. Crossing the line takes something witnessed.
 */
const SCREAM_ALARM_CAP = 0.5;
/**
 * Hardest an able body can change its ground speed, m/s^2.
 *
 * A bound, not a target: it exists to rule out the 0 -> 5.4 m/s inside one
 * tick (about 324 m/s^2) that every AI path used to ask for, not to make
 * anyone sluggish. Set low it becomes one, and a body that cannot build
 * momentum cannot push past an obstacle at all -- guards then stall in front
 * of anything in the way rather than shouldering through it. Scaled by leg
 * motor at the point of use: the decision to run arrives instantly, the legs
 * still have to produce it.
 */
const GROUND_ACCEL = 14;
/** Stopping is not the same problem as starting; you can always just stop. */
const GROUND_BRAKE = 14;
/** Parts that came down this tick; reused, never reallocated. */
const fellScratch: Prop[] = [];
/**
 * World-space (x, z) centroid of the dead supports behind each `fellScratch`
 * entry, parallel to it. This is the real edge a tipped or unsupported part
 * gave way from -- not the part's own centre -- so `collapseProp` can anchor
 * the initiating impulse there instead of guessing a direction from velocity.
 */
const fellFailX: number[] = [];
const fellFailZ: number[] = [];

export interface Cam {
  yaw: number;
  pitch: number;
}

function surfaceAt(w: World, x: number, z: number) {
  if (w.inWater(x, z, 0.4)) return "water";
  const i = w.cell(x, z);
  if (w.oil[i] > 0.3) return "oil";
  if (w.wet[i] > 0.55) return "mud";
  if (Math.abs(x) < 9 && Math.abs(z) < 9) return "cobble";
  if (w.indoorAt(x, z)) return "wood";
  if (z < -16) return "dirt";
  return "dirt";
}

function frictionFor(s: string, wet: number) {
  if (s === "water") return 3.2;
  if (s === "mud") return 4.6;
  if (s === "oil") return 1.1;
  if (s === "cobble") return 8 + wet * 4;
  if (s === "wood") return 7;
  return 6.5;
}

function accelFor(s: string) {
  if (s === "water") return 6;
  if (s === "mud") return 9;
  if (s === "oil") return 5;
  return 22;
}

export function stepWorld(w: World, dt: number, input: Actions, cam: Cam, playing: boolean) {
  w.events.length = 0;
  stepClock(w, dt);
  for (const a of w.actors) {
    a.px = a.x;
    a.py = a.y;
    a.pz = a.z;
    a.pyaw = a.yaw;
  }
  for (const p of w.props) {
    p.px = p.x;
    p.py = p.y;
    p.pz = p.z;
  }
  w.rebuildHash();
  // Motor authority is computed first so that gait speed, reach, grip strength
  // and the solver all read the same numbers within a tick.
  for (const a of w.actors) updateMotor(a);
  if (playing) applyPlayer(w, dt, input, cam);
  stepPerception(w, dt);
  stepAI(w, dt);
  stepCombat(w, dt, playing ? input : null);
  stepGrab(w, dt, playing ? input : null);
  stepLocomotion(w, dt);
  stepPhysics(w, dt);
  // Bodies and prop frames are solved together: `stepBodies` interleaves them.
  stepBodies(w, dt);
  // Melee contact needs this tick's solved hand/foot position, which does not
  // exist until stepBodies has run -- see resolveStrikes's own comment.
  resolveStrikes(w);
  checkTrips(w, dt);
  stepDragTracks(w);
  stepInjury(w, dt);
  stepFire(w, dt);
  stepProps(w, dt);
  stepStructures(w, dt);
  stepTracks(w, dt);
  cullSounds(w);
  if (w.shake > 0) w.shake = Math.max(0, w.shake - dt * 1.8);
  if (w.hitstop > 0) w.hitstop = Math.max(0, w.hitstop - dt);
}

function stepClock(w: World, dt: number) {
  w.time += dt;
  w.day = (w.day + dt / 540) % 1;
  if (w.rainTarget === 0 && w.time > 40 && w.rng() < dt * 0.01) {
    w.rainTarget = 0.45 + w.rng() * 0.5;
    w.whisper("Rain starts.");
  }
  if (w.rain > 0.6 && w.rng() < dt * 0.04) {
    w.thunderT = 0;
    w.shake = Math.max(w.shake, 0.35);
    w.emitSound(w.player().x + (w.rng() - 0.5) * 40, w.player().z, 1.6, "impact", 0);
  }
  w.thunderT += dt;
  w.rain += (w.rainTarget - w.rain) * (1 - Math.exp(-dt * 0.15));
  if (w.rain > 0.7 && w.rng() < dt * 0.02) w.windX += (w.rng() - 0.5) * 0.4;
  w.windX = clamp(w.windX, -3, 3);
  w.windZ = clamp(w.windZ + (w.rng() - 0.5) * dt, -2, 2);
}

function applyPlayer(w: World, dt: number, input: Actions, cam: Cam) {
  const p = w.player();
  if (!p.alive) return;
  p.crouch = input.crouch && p.loco !== "ragdoll" && p.loco !== "down";
  if (p.consciousness < 0.35) return;
  if (
    p.loco === "ragdoll" ||
    p.loco === "down" ||
    p.loco === "getup" ||
    p.loco === "pin" ||
    p.loco === "vault"
  )
    return;

  const f = CAM_FORWARD(cam.yaw);
  const r = rightOf(cam.yaw);
  const wishX = f.x * input.moveY + r.x * input.moveX;
  const wishZ = f.z * input.moveY + r.z * input.moveX;
  const wishMag = Math.hypot(wishX, wishZ);
  p.intendX = wishMag > 0.05 ? wishX / wishMag : 0;
  p.intendZ = wishMag > 0.05 ? wishZ / wishMag : 0;

  // Speed is gated by the legs that still have motor authority and by what the
  // arms are actually hauling, not by an abstract injury total.
  const leg = 0.35 + legMotor(p) * 0.65;
  const load = 1 / (1 + p.carry / 90 + p.dragLoad / (p.mass * 26));
  const mud = surfaceAt(w, p.x, p.z) === "mud" ? 0.72 : 1;
  let max = p.crouch ? 1.5 : 3.45;
  if (input.sprint && p.stamina > 0.08 && wishMag > 0.2 && !p.crouch) max = 6.6;
  max *= leg * load * mud * (0.55 + p.consciousness * 0.45) * (1 - p.fatigue * 0.35);
  if (p.balance < 0.4) max *= 0.4 + p.balance;
  p.intendSpeed = wishMag * max;

  if (wishMag > 0.08) {
    const ty = Math.atan2(-p.intendX, -p.intendZ);
    p.yaw = lerpAng(p.yaw, ty, 1 - Math.exp(-dt * 8));
  } else {
    p.yaw = lerpAng(p.yaw, cam.yaw, 1 - Math.exp(-dt * 4));
  }

  if (input.sprint && wishMag > 0.2 && !p.crouch) {
    p.stamina = Math.max(0, p.stamina - dt * 0.18);
    p.fatigue = Math.min(1, p.fatigue + dt * 0.04);
  } else {
    p.stamina = Math.min(1, p.stamina + dt * 0.14 * (p.crouch ? 1.4 : 1) * (1 - p.pain * 0.4));
    p.fatigue = Math.max(0, p.fatigue - dt * 0.03);
  }

  if (input.jumpPressed && p.grounded) {
    const front = probeHeight(w, p.x + f.x * 0.7, p.z + f.z * 0.7);
    if (front > 0.35 && front < 1.15 && locoSpeed(p) > 2.2) {
      p.loco = "vault";
      p.vaultT = 0.38;
      p.vy = 3.6;
      p.vx += f.x * 2.2;
      p.vz += f.z * 2.2;
    } else if (front > 1.15 && front < 2.4) {
      p.loco = "climb";
      p.locoT = 0.55;
      p.vy = 2.4;
    } else {
      p.vy = 6.2 * (0.7 + p.stamina * 0.3) * leg;
      p.grounded = false;
      p.stamina -= 0.08;
      if (p.body >= 0) w.bodies.addVelocity(p.body, 0, p.vy, 0, dt);
    }
  }

  {
    const f2 = facing(p.yaw);
    const r2 = rightOf(p.yaw);
    const along = p.vx * f2.x + p.vz * f2.z;
    const side = p.vx * r2.x + p.vz * r2.z;
    const k = 1 - Math.exp(-dt * 5);
    p.leanZ += (-clamp(along * 0.028, -0.2, 0.2) - p.leanZ) * k;
    p.leanX += (clamp(side * 0.03, -0.16, 0.16) - p.leanX) * k;
  }
  if (input.bandage) treat(w, p, dt);
  if (input.ignitePressed) tryIgnite(w, p);
  if (input.dropPressed) dropHeld(w, p, 0.5);

  if (wishMag > 0.22 && p.grounded && Math.hypot(p.vx, p.vz) < 0.1) {
    p.recovT += dt;
    if (p.recovT > 0.28) {
      unstickActor(w, p);
      p.recovT = 0;
    }
  } else {
    p.recovT = 0;
  }
}

function probeHeight(w: World, x: number, z: number) {
  let h = 0;
  for (const c of w.colliders) {
    if (!c.solid || c.water) continue;
    if (x > c.minX - 0.15 && x < c.maxX + 0.15 && z > c.minZ - 0.15 && z < c.maxZ + 0.15) {
      h = Math.max(h, c.maxY);
    }
  }
  return h;
}

function treat(w: World, p: Actor, dt: number) {
  p.intendSpeed = Math.min(p.intendSpeed, 0.6);
  // Binding a wound needs a hand that still works.
  const hands = armMotor(p);
  if (hands < 0.2) {
    if (p.kind === "player") w.whisper("Your hands will not obey.");
    return;
  }
  dt *= hands;
  p.bleed = Math.max(0, p.bleed - dt * 0.35);
  for (const r of REGIONS) {
    p.injuries[r].cut = Math.max(0, p.injuries[r].cut - dt * 0.12);
    p.injuries[r].puncture = Math.max(0, p.injuries[r].puncture - dt * 0.08);
    p.injuries[r].burn = Math.max(0, p.injuries[r].burn - dt * 0.06);
  }
  p.pain = Math.max(0, p.pain - dt * 0.2);
}

function tryIgnite(w: World, p: Actor) {
  const f = facing(p.yaw);
  const tx = p.x + f.x * 1.1;
  const tz = p.z + f.z * 1.1;
  if (p.weapon === "torch" || p.torchLit) {
    igniteAt(w, tx, tz, 0.9);
    p.torchLit = true;
    w.emitSound(tx, tz, 0.4, "fire", p.id);
    w.whisper("Flame catches.");
    return;
  }
  const i = w.cell(tx, tz);
  if (w.burning[i]) {
    w.burning[i] = 0;
    w.heat[i] *= 0.2;
    w.wet[i] = Math.min(1, w.wet[i] + 0.5);
    w.whisper("You smother the fire.");
  }
}

/**
 * Releasing a grab with a throw.
 *
 * The throw impulse is bounded by what the arm can actually deliver:
 *   J = m_thrower * armMotor * throwMul * K       [N*s]
 * so the resulting speed is J/m_target, and a heavy body barely moves while a
 * bucket flies. The impulse is applied to every node so the released body
 * leaves the hand spinning rather than translating rigidly.
 */
function dropHeld(w: World, p: Actor, throwMul: number) {
  if (!p.grabbedId) return;
  const t = w.actor(p.grabbedId);
  const pr = t ? null : w.prop(p.grabbedId);
  const f = facing(p.yaw);
  const j = p.mass * (0.35 + armMotor(p) * 1.15) * throwMul * 3.4; // N*s
  if (t) {
    const dv = j / t.mass;
    if (t.body >= 0) {
      w.bodies.addVelocity(t.body, f.x * dv + p.vx, dv * 0.42, f.z * dv + p.vz, STEP);
      // extra impulse at the chest so it tumbles rather than sliding flat
      w.bodies.applyImpulse(
        t.body,
        w.bodies.plan(t.body).chest,
        f.x * j * 0.3,
        j * 0.12,
        f.z * j * 0.3,
        STEP,
      );
    }
    t.vx += f.x * dv + p.vx;
    t.vz += f.z * dv + p.vz;
    t.vy += dv * 0.42;
    if (dv > 1.4 || !t.alive) collapse(w, t, 0.7);
  } else if (pr) {
    pr.dynamic = true;
    pr.anchored = false;
    const dv = j / Math.max(1, pr.mass);
    pr.vx += f.x * dv + p.vx;
    pr.vz += f.z * dv + p.vz;
    pr.vy += dv * 0.5;
    // Thrown, so it becomes a physical object again: it tumbles, it lands on
    // whatever is under it, and what it lands on is hurt where it was hit.
    const slot = makeFrame(w.bodies, pr);
    if (slot >= 0) {
      const B = w.bodies;
      // The thrower's own motion and the throw's lift are the platform the
      // object leaves from -- uniform across every node, no rotation implied.
      B.addVelocity(slot, p.vx, dv * 0.5, p.vz, STEP);
      // The throw's own impulse is delivered through the grip, not through
      // the object's centre. Applying it at the node nearest the hand,
      // instead of folding it into that same uniform velocity and then
      // inventing a spin to compensate, is what makes a beam thrown from one
      // end tumble end over end while something held near its middle mostly
      // just flies: the constraint solve turns an off-centre impulse into
      // real rotation on its own, the same way it already does for every
      // other contact in the game.
      const gb = B.base(p.body);
      const gplan = B.plan(p.body);
      const node = B.nearestNode(
        slot,
        B.px[gb + gplan.grabHand]!,
        B.py[gb + gplan.grabHand]!,
        B.pz[gb + gplan.grabHand]!,
        4,
      );
      B.applyImpulse(slot, node >= 0 ? node : 0, f.x * j, 0, f.z * j, STEP);
    }
  }
  releaseGrab(w, p);
  w.emitSound(p.x, p.z, 0.5, "whoosh", p.id);
}

function stepPerception(w: World, dt: number) {
  const hour = w.day;
  const light = hour > 0.25 && hour < 0.75 ? 1 : hour > 0.2 && hour < 0.8 ? 0.45 : 0.18;
  for (const a of w.actors) {
    if (a.kind === "player" || !a.alive) continue;
    a.alert = Math.max(0, a.alert - dt * 0.08);
    a.shoutCd = Math.max(0, a.shoutCd - dt);
    const visRange =
      (a.species === "wolf" ? 22 : a.species === "deer" ? 18 : a.species === "bear" ? 16 : 16) *
      (0.45 + light * 0.55) *
      (1 - w.rain * 0.25);
    const hearMul = 1 - w.rain * 0.2;
    for (const s of w.sounds) {
      if (w.time - s.t > 0.25) continue;
      const d = Math.hypot(s.x - a.x, s.z - a.z);
      const reach = s.mag * 22 * hearMul;
      if (d < reach) {
        w.addMemory(a, "sound", s.x, s.z, s.who, clamp(1 - d / reach, 0.2, 1));
        if (s.kind === "scream" || s.kind === "collapse" || s.kind === "weapon")
          a.alert = Math.min(1, a.alert + 0.4);
        // A scream ALARMS; it does not panic. Panic screams, so if hearing a
        // scream could push a listener over the panic line, one scream bought
        // several more and the crowd became an oscillator: the whole town
        // saturated in under a second from a single cry. Capping what a scream
        // alone can do below the lowest panic threshold makes the loop gain
        // less than one by construction -- the crowd still turns and looks,
        // and still goes up when there is something to see, but the sound can
        // no longer be its own cause. What tips someone over is witnessing.
        if (s.kind === "scream" && a.fear < SCREAM_ALARM_CAP) {
          a.fear += Math.min(0.2 * (1 - a.courage), SCREAM_ALARM_CAP - a.fear);
        }
      }
    }
    const others = w.nearby(a.x, a.z, visRange);
    for (const o of others) {
      if (o.id === a.id) continue;
      const dx = o.x - a.x;
      const dz = o.z - a.z;
      const d = Math.hypot(dx, dz);
      const f = facing(a.yaw);
      const dot = d > 0.01 ? (dx * f.x + dz * f.z) / d : 1;
      const fov = a.species === "deer" ? 0.15 : 0.32;
      if (dot < fov && d > 2.2) continue;
      const smoke =
        w.smoke[w.cell(o.x, o.z)] + w.smoke[w.cell((a.x + o.x) * 0.5, (a.z + o.z) * 0.5)];
      let chance =
        (1 - d / visRange) * (0.4 + dot) * (o.crouch ? 0.45 : 1) * (o.loco === "sprint" ? 1.2 : 1);
      chance *= 1 - Math.min(0.8, smoke * 0.5);
      chance *= 1 - (o.loco === "idle" && o.crouch ? 0.5 : 0);
      if (w.indoorAt(o.x, o.z) && !w.indoorAt(a.x, a.z)) chance *= 0.45;
      if (chance < 0.12) continue;
      if (!canSeeThrough(w, a.x, a.z, o.x, o.z) && d > 3) continue;
      if (isThreat(a, o, w)) {
        a.lastSeenX = o.x;
        a.lastSeenZ = o.z;
        a.lastSeenT = w.time;
        a.targetId = o.id;
        a.alert = 1;
        w.addMemory(a, "threat", o.x, o.z, o.id, 1);
        if (!a.known.includes(o.id)) a.known.push(o.id);
      }
      if (!o.alive || isHelpless(o)) {
        const fresh = w.addMemory(a, "body", o.x, o.z, o.id, 1);
        // How badly wrecked, and whether it is one of ours. A man pinned under
        // a heap in the street is a different sight from a body in a ditch.
        const wreck = incapacity(o) * (o.faction === a.faction ? 1.5 : 0.8);
        const heap = Math.min(1, o.pileLoad / 90);
        // The shock is in the DISCOVERY. This was an event-sized jolt applied
        // on every tick the body stayed in view -- sixty shocks a second, so a
        // single man on the ground pinned every witness at maximum fear for as
        // long as he lay there. A panicking crowd sprints, and sprinting
        // bodies fall over, which made more bodies: the sight of the fallen
        // was manufacturing the thing it was reacting to.
        const shock = (0.14 + wreck * 0.22 + heap * 0.2) * (1 - a.courage);
        a.fear = Math.min(1, a.fear + (fresh ? shock : shock * BODY_DREAD_RATE * dt));
        if (a.faction === "guard" && o.faction === "guard" && a.shoutCd <= 0) {
          a.alert = 1;
          a.shoutCd = 4;
          w.emitSound(a.x, a.z, 1.0, "shout", a.id);
          w.wanted = Math.min(1, w.wanted + 0.12);
        }
      }
    }
    for (let i = 0; i < w.burning.length; i++) {
      if (!w.burning[i]) continue;
      const p = w.ixz(i);
      if (dist2(a.x, a.z, p.x, p.z) < 18 * 18) {
        w.addMemory(a, "fire", p.x, p.z, 0, 0.8);
        if (dist2(a.x, a.z, p.x, p.z) < 36) a.fear = Math.min(1, a.fear + dt * 0.4);
      }
    }
    for (const m of a.memories) {
      m.certainty *= 1 - dt * 0.05;
    }
    a.memories = a.memories.filter((m) => m.certainty > 0.08 && w.time - m.t < 90);
  }
}

function isThreat(a: Actor, o: Actor, w: World) {
  if (!o.alive) return false;
  // Someone who cannot stand is not a threat. Guards still deal with them --
  // see the securing branch in humanAI -- but not by squaring up to them.
  if (isHelpless(o) && a.faction !== "wild") return false;
  if (a.known.includes(o.id)) return true;
  if (o.kind === "player") {
    if (a.faction === "guard" && (w.wanted > 0.15 || (o.weapon !== "fist" && w.wanted > 0)))
      return true;
    if (a.species === "wolf" || a.species === "bear") {
      if (o.bleed > 0.15 || o.blood < 0.85) return true;
      if (a.species === "bear" && dist2(a.x, a.z, o.x, o.z) < 36) return a.aggression > 0.3;
    }
    if (
      a.faction === "civilian" &&
      (o.strikeT > 0 || o.weapon !== "fist") &&
      dist2(a.x, a.z, o.x, o.z) < 25
    )
      return true;
  }
  if (
    a.species === "wolf" &&
    (o.species === "deer" || o.species === "goat" || o.species === "pig" || o.species === "cow")
  )
    return true;
  if (
    a.species === "bear" &&
    (o.species === "deer" || o.species === "pig" || o.species === "cow" || o.kind === "human")
  )
    return dist2(a.x, a.z, o.x, o.z) < 80;
  if (
    a.species === "deer" &&
    (o.kind === "human" || o.kind === "player" || o.species === "wolf" || o.species === "bear")
  )
    return true;
  if (a.faction === "guard" && o.faction === "wild" && o.species !== "deer") return true;
  if (o.lastHitBy === a.id) return false;
  if (a.lastHitBy === o.id && w.time - a.lastHitT < 20) return true;
  return false;
}

function stepAI(w: World, dt: number) {
  for (const a of w.actors) {
    if (a.kind === "player" || !a.alive) continue;
    if (
      a.loco === "ragdoll" ||
      a.loco === "down" ||
      a.loco === "getup" ||
      a.loco === "pin" ||
      a.authority < 0.15
    ) {
      a.intendSpeed = 0;
      continue;
    }
    const prevSpeed = a.intendSpeed;
    decideAI(w, a, dt);
    // Intent is not achievement. Every AI path assigns a speed outright, so a
    // startled villager went from standing to a 5.4 m/s sprint inside one tick
    // -- near four g. The gait target leapt a stride ahead of the body it
    // belonged to, the pose error read as "physically overpowered", and the
    // villager face-planted; the fallen then frightened everyone who could see
    // them, which produced more sprinting, which produced more falling. What a
    // body may ASK for is unbounded. What its legs deliver is not, and a
    // damaged leg is slow off the mark as well as slow at speed.
    const want = a.intendSpeed;
    const limit =
      want > prevSpeed ? GROUND_ACCEL * (0.3 + 0.7 * legMotor(a)) * dt : GROUND_BRAKE * dt;
    a.intendSpeed = clamp(want, prevSpeed - limit, prevSpeed + limit);
  }
}

/** One actor's AI decision for this tick. Sets intent; does not bound it. */
function decideAI(w: World, a: Actor, dt: number) {
  a.aiT -= dt;
  a.fear = clamp(a.fear - dt * 0.05, 0, 1);
  const nearbyFire = closestFire(w, a.x, a.z);
  if (nearbyFire && nearbyFire.d < 3.2) {
    const dx = a.x - nearbyFire.x;
    const dz = a.z - nearbyFire.z;
    const m = Math.hypot(dx, dz) || 1;
    a.intendX = dx / m;
    a.intendZ = dz / m;
    a.intendSpeed = 5;
    a.ai = "flee";
    return;
  }
  if (a.species !== "human") {
    beastAI(w, a, dt);
    return;
  }
  humanAI(w, a, dt, nearbyFire);
}

function closestFire(w: World, x: number, z: number) {
  let best = 99;
  let bx = 0;
  let bz = 0;
  for (let i = 0; i < w.burning.length; i++) {
    if (!w.burning[i]) continue;
    const p = w.ixz(i);
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < best) {
      best = d;
      bx = p.x;
      bz = p.z;
    }
  }
  if (best > 28) return null;
  return { x: bx, z: bz, d: best };
}

/**
 * Steer toward a point, around whatever is lying between here and there.
 *
 * `w` is threaded through so the route can consult the bodies on the ground.
 * Without it every agent walks into the heap it just helped make.
 */
function seek(w: World, a: Actor, x: number, z: number, speed: number, towardId = 0) {
  const dx = x - a.x;
  const dz = z - a.z;
  const m = Math.hypot(dx, dz);
  if (m < 0.4) {
    a.intendSpeed = 0;
    return m;
  }
  const dir = avoidBodies(w, a, dx / m, dz / m, towardId);
  a.intendX = dir.x;
  a.intendZ = dir.z;
  // Every AI-commanded speed passes through here, so this is the one place
  // a shared literal (`seek(w, a, x, z, 1.5)` for every guard on patrol)
  // becomes individual per actor, in both real travel speed and -- because
  // the gait clock integrates off the resulting a.vx/a.vz -- gait rate too.
  a.intendSpeed = speed * a.moveScale;
  a.yaw = lerpAng(a.yaw, Math.atan2(-a.intendX, -a.intendZ), 0.25);
  return m;
}

function humanAI(w: World, a: Actor, dt: number, fire: { x: number; z: number; d: number } | null) {
  const player = w.player();
  // Crouching is a combat decision, taken below; it must not persist into
  // walking a beat or fleeing a fire.
  a.crouch = false;
  const seesPlayer = a.targetId === player.id && w.time - a.lastSeenT < 0.6;
  const hostile = a.known.includes(player.id) || (a.faction === "guard" && w.wanted > 0.2);
  const panic = a.fear > 0.55 + a.courage * 0.35;

  if (panic && a.faction !== "guard") {
    a.ai = "flee";
    const awayX = a.x - player.x;
    const awayZ = a.z - player.z;
    const m = Math.hypot(awayX, awayZ) || 1;
    seek(w, a, a.x + (awayX / m) * 10, a.z + (awayZ / m) * 10, 5.4);
    if (a.shoutCd <= 0) {
      // One scream, one channel. `spreadFear` used to run here as well,
      // applying the identical +0.2*(1-courage) that the scream sound already
      // delivers on arrival -- the same event billed twice, and the second
      // copy had no distance falloff or hearing model behind it.
      w.emitSound(a.x, a.z, 0.9, "scream", a.id);
      a.shoutCd = 2.4;
    }
    return;
  }

  if (fire && fire.d < 7 && a.faction !== "guard" && a.courage < 0.7) {
    a.ai = "flee";
    seek(w, a, a.x + (a.x - fire.x), a.z + (a.z - fire.z), 4.5);
    return;
  }

  if (fire && fire.d < 5 && a.faction === "guard" && a.courage > 0.5) {
    a.ai = "extinguish";
    const d = seek(w, a, fire.x, fire.z, 3.5);
    if (d < 1.6) {
      const i = w.cell(fire.x, fire.z);
      w.heat[i] *= 0.85;
      w.wet[i] = Math.min(1, w.wet[i] + dt * 0.8);
      if (w.heat[i] < 0.3) w.burning[i] = 0;
    }
    return;
  }

  if (a.faction === "guard" && hostile) {
    // A guard already hauling someone finishes the job rather than restarting a
    // fight; the drag itself is what ends in a capture.
    if (a.grabbedId === player.id) {
      a.ai = "recover";
      a.crouch = false;
      secureTarget(w, a, player, dt);
      return;
    }
    if (seesPlayer || (isHelpless(player) && dist2(a.x, a.z, player.x, player.z) < 36)) {
      const d = Math.hypot(player.x - a.x, player.z - a.z);
      a.targetId = player.id;
      if (a.shoutCd <= 0) {
        w.emitSound(a.x, a.z, 1.0, "shout", a.id);
        a.shoutCd = 3;
        callAllies(w, a, player);
      }

      // A man on the ground is not fought, he is secured. Closing to take hold
      // of him is a different behaviour from squaring up, and it is what turns
      // "the player is down" into something that actually happens to them.
      if (isHelpless(player)) {
        a.ai = "recover";
        a.crouch = false;
        // One pair of hands. A crowd all closing on the same body walks into
        // each other, knocks each other down and drops the prisoner between
        // them; the rest stand off and keep the ring.
        const holder = w.actors.find((o) => o.grabbedId === player.id && o.alive);
        let nearer = holder ? holder.id !== a.id : false;
        if (!holder) {
          for (const o of w.nearby(player.x, player.z, d)) {
            if (o.id === a.id || o.faction !== a.faction || !o.alive || isHelpless(o)) continue;
            if (Math.hypot(o.x - player.x, o.z - player.z) < d - 0.15) nearer = true;
          }
        }
        if (nearer) {
          const away = Math.hypot(a.x - player.x, a.z - player.z) || 1;
          const rx = player.x + ((a.x - player.x) / away) * 2.4;
          const rz = player.z + ((a.z - player.z) / away) * 2.4;
          seek(w, a, rx, rz, 2.2, player.id);
          return;
        }
        // Stop beside the body and reach down for it, rather than walking on
        // to it. A guard that closes all the way puts its feet on a ribcage,
        // trips over what it came to collect, and drops the prisoner -- which
        // is the trip test working correctly on a decision that was wrong.
        const STANDOFF = 1.05;
        if (d > STANDOFF + 0.2) {
          const ux = (a.x - player.x) / (d || 1);
          const uz = (a.z - player.z) / (d || 1);
          // Close at a walk: a body on the ground is something you step around.
          seek(
            w,
            a,
            player.x + ux * STANDOFF,
            player.z + uz * STANDOFF,
            d > 2.8 ? 4.4 : 1.6,
            player.id,
          );
        } else {
          a.intendSpeed = 0;
          a.yaw = lerpAng(a.yaw, Math.atan2(-(player.x - a.x), -(player.z - a.z)), 0.3);
          takeHold(w, a, player);
        }
        return;
      }

      a.ai = "combat";
      // Commit against a target that is already losing its footing: close hard
      // and take hold rather than trading blows it could still recover from.
      const commit = isOffBalance(player) && a.courage > 0.4;
      if (d > 1.5) seek(w, a, player.x, player.z, commit ? 6.0 : 5.2);
      else a.intendSpeed = commit ? 1.2 : 0.4;
      if (commit && d < 1.25 && !a.grabbedId && a.aggression > 0.35) {
        takeHold(w, a, player);
        return;
      }

      // Aim where the target is weakest. Crouching lowers the guard's own hand,
      // and the strike height is read from that hand, so this genuinely changes
      // which region the blow lands on rather than labelling it.
      // Drop into a low guard while closing, not only once already in range:
      // committing to the legs is a decision about the whole approach.
      const low = shouldStrikeLow(player);
      a.crouch = low && d < WEAPON_STATS[a.weapon].reach * 1.6 + 0.5;

      if (d < WEAPON_STATS[a.weapon].reach + 0.4 && a.attackCd <= 0) {
        a.strikeT = 0.32;
        a.strikeCd = 0.7 / (0.7 + a.competence);
        a.strikeHit = 0;
        a.attackCd = a.strikeCd;
      }
      return;
    }
    a.crouch = false;
    if (w.time - a.lastSeenT < 8) {
      a.ai = "pursue";
      const d = seek(w, a, a.lastSeenX, a.lastSeenZ, 5.4);
      if (d < 1.2) {
        a.ai = "search";
        a.searchT = 7;
        pickSearch(w, a);
      }
      return;
    }
    if (a.ai === "search" || a.searchT > 0) {
      a.searchT -= dt;
      a.ai = "search";
      const d = seek(w, a, a.searchX, a.searchZ, 3.2);
      if (d < 1 || a.aiT <= 0) pickSearch(w, a);
      followTracks(w, a);
      if (a.searchT <= 0) a.ai = "wander";
      return;
    }
  }

  if (a.faction === "guard" && a.alert > 0.4) {
    const mem = a.memories.find((m) => m.kind === "threat" || m.kind === "sound");
    if (mem) {
      a.ai = "investigate";
      seek(w, a, mem.x, mem.z, 3.6);
      return;
    }
  }

  // Rescue. The wounded are found by how incapacitated they are, not by blood
  // alone -- a man pinned under a beam with a broken leg needs hauling out as
  // much as a bleeding one -- and they are hauled AWAY from whatever is burning
  // rather than toward a doorstep that may be inside it.
  const ally = w
    .nearby(a.x, a.z, 9)
    .find(
      (o) =>
        o.faction === a.faction &&
        o.alive &&
        o.id !== a.id &&
        !o.grabbedBy &&
        (o.blood < 0.6 || incapacity(o) > 0.6),
    );
  if (ally && a.loyalty > 0.45 && a.fear < 0.6) {
    a.ai = "rescue";
    if (a.grabbedId === ally.id) {
      let tx = a.homeX;
      let tz = a.homeZ;
      if (fire && fire.d < 16) {
        const dx = a.x - fire.x;
        const dz = a.z - fire.z;
        const m = Math.hypot(dx, dz) || 1;
        tx = a.x + (dx / m) * 12;
        tz = a.z + (dz / m) * 12;
      }
      seek(w, a, tx, tz, 2.4);
      return;
    }
    const d0 = Math.hypot(ally.x - a.x, ally.z - a.z);
    const d = seek(w, a, ally.x, ally.z, d0 > 2.6 ? 3.8 : 1.5, ally.id);
    if (d < 1.2) takeHold(w, a, ally);
    return;
  }

  if (a.routine.length) {
    a.ai = "work";
    const wp = a.routine[a.routineI % a.routine.length]!;
    const d = seek(w, a, wp.x, wp.z, 1.7);
    if (d < 0.8) {
      a.routineI++;
      a.intendSpeed = 0;
      a.aiT = 1 + w.rng() * 2;
    }
    return;
  }

  a.ai = "wander";
  if (a.aiT <= 0) {
    a.wayX = a.homeX + (w.rng() - 0.5) * 10;
    a.wayZ = a.homeZ + (w.rng() - 0.5) * 10;
    a.aiT = 3 + w.rng() * 4;
  }
  seek(w, a, a.wayX, a.wayZ, 1.5);
}

/**
 * Take hold of a target: the same physical grab the player uses, so the
 * attachment constraint hauls on both bodies and the target's weight shows up
 * in the holder's own balance.
 */
function takeHold(w: World, a: Actor, t: Actor) {
  if (a.grabbedId || t.grabbedBy) return;
  if (a.body < 0) return;
  const B = w.bodies;
  const grip = armMotor(a);
  if (grip < 0.3) return;
  // A struggling target is harder to get hold of than a limp one.
  const resist = threatLevel(t) * (t.mass / (a.mass + t.mass));
  if (resist > 0.34 + a.strength * 0.2) {
    t.stanceAuth = Math.max(0.2, t.stanceAuth - 0.15);
    return;
  }
  a.grabbedId = t.id;
  t.grabbedBy = a.id;
  a.grabNodeA = B.plan(a.body).grabHand;
  a.grabNodeB = t.body >= 0 ? B.plan(t.body).chest : -1;
  // Long enough to hold someone at arm's length beside you rather than under
  // your feet.
  a.grabRest = 0.9;
  a.carry = t.mass * 0.5;
  w.emitSound(a.x, a.z, 0.5, "grab", a.id);
  if (t.kind === "player") w.whisper("A hand closes on you.");
}

/**
 * Drag a held prisoner back to the barracks. Capture is the end of a haul that
 * really happened -- across the ground, leaving a drag mark -- rather than a
 * timer that fires because a guard stood near you.
 */
const GAOL_X = 9.5;
const GAOL_Z = -8.2;

function secureTarget(w: World, a: Actor, t: Actor, dt: number) {
  if (!t.alive) {
    releaseGrab(w, a);
    return;
  }
  // Fighting free: a target that recovers its feet and its strength can break
  // the hold, and the holder's grip is its own arm's motor authority.
  if (threatLevel(t) > 0.45 && !isHelpless(t)) {
    releaseGrab(w, a);
    w.emitSound(a.x, a.z, 0.4, "grab", a.id);
    return;
  }
  const d = seek(w, a, GAOL_X, GAOL_Z, 2.6, t.id);
  if (t.kind === "player") {
    w.captureT += dt;
    // Capture is the end of a haul, so it takes a haul: reaching the barracks
    // with a prisoner already in hand is not the same as having dragged one
    // there, and a guard who happened to be standing at the door should not
    // skip the part the player is supposed to experience.
    if ((d < 2.2 && w.captureT > 1.6) || w.captureT > 14) {
      w.phase = "captured";
      w.captureT = 0;
      releaseGrab(w, a);
    }
  } else if (d < 2.5) {
    releaseGrab(w, a);
  }
}

function pickSearch(w: World, a: Actor) {
  const ang = w.rng() * Math.PI * 2;
  const r = 3 + w.rng() * 7;
  a.searchX = a.lastSeenX + Math.cos(ang) * r;
  a.searchZ = a.lastSeenZ + Math.sin(ang) * r;
  a.aiT = 2 + w.rng() * 2;
}

function followTracks(w: World, a: Actor) {
  let best: (typeof w.tracks)[0] | null = null;
  let bd = 9;
  for (const t of w.tracks) {
    if (w.time - t.t > 25) continue;
    const d = Math.hypot(t.x - a.x, t.z - a.z);
    if (d < bd && t.actorId === w.playerId) {
      bd = d;
      best = t;
    }
  }
  if (best) {
    a.searchX = best.x + Math.cos(best.heading) * 2;
    a.searchZ = best.z + Math.sin(best.heading) * 2;
  }
}

function callAllies(w: World, a: Actor, player: Actor) {
  for (const o of w.nearby(a.x, a.z, 22)) {
    if (o.faction !== a.faction || o.id === a.id) continue;
    w.addMemory(o, "threat", player.x, player.z, player.id, 0.7);
    if (!o.known.includes(player.id)) o.known.push(player.id);
    o.alert = Math.max(o.alert, 0.8);
    o.lastSeenX = a.lastSeenX;
    o.lastSeenZ = a.lastSeenZ;
    o.lastSeenT = w.time;
  }
  w.wanted = Math.min(1, w.wanted + 0.25);
  w.whisper("A shout carries.");
}

function spreadFear(w: World, a: Actor) {
  for (const o of w.nearby(a.x, a.z, 12)) {
    if (o.id === a.id || o.kind === "player") continue;
    o.fear = Math.min(1, o.fear + 0.2 * (1 - o.courage));
  }
}

function beastAI(w: World, a: Actor, dt: number) {
  if (a.species === "deer" || a.species === "goat" || a.species === "pig" || a.species === "cow") {
    const threat = w.nearby(a.x, a.z, a.species === "deer" ? 14 : 8).find((o) => {
      if (o.id === a.id || !o.alive) return false;
      return (
        o.kind === "player" ||
        o.kind === "human" ||
        o.species === "wolf" ||
        o.species === "bear" ||
        o.strikeT > 0
      );
    });
    const fire = closestFire(w, a.x, a.z);
    if (threat || (fire && fire.d < 8) || a.fear > 0.4) {
      a.ai = "flee";
      // Only a real cause adds fear, and it adds it as a RATE. A flat 0.3 every
      // tick meant the `a.fear > 0.4` arm of this very condition fed itself:
      // once an animal crossed 0.4 it manufactured its own terror at 18/s
      // against a decay of 0.05/s, so it could never calm down again -- and it
      // screamed the whole time, which is what pushed every human in earshot
      // into the same state.
      if (threat || (fire && fire.d < 8)) a.fear = Math.min(1, a.fear + 0.9 * dt);
      const tx = threat ? threat.x : fire ? fire.x : a.x;
      const tz = threat ? threat.z : fire ? fire.z : a.z;
      seek(w, a, a.x + (a.x - tx) * 2, a.z + (a.z - tz) * 2, a.species === "cow" ? 4.2 : 6.5);
      if (a.species !== "deer" && a.shoutCd <= 0) {
        w.emitSound(a.x, a.z, 0.7, "animal", a.id);
        a.shoutCd = 1.6;
      }
      if (a.species !== "deer") breakFence(w, a);
      return;
    }
    a.ai = "graze";
    if (a.aiT <= 0) {
      a.wayX = a.homeX + (w.rng() - 0.5) * (a.species === "deer" ? 16 : 5);
      a.wayZ = a.homeZ + (w.rng() - 0.5) * (a.species === "deer" ? 16 : 5);
      a.aiT = 2 + w.rng() * 4;
    }
    seek(w, a, a.wayX, a.wayZ, 1.1);
    return;
  }
  if (a.species === "wolf") {
    const prey = w
      .nearby(a.x, a.z, 24)
      .filter(
        (o) =>
          o.alive &&
          o.id !== a.id &&
          (o.species === "deer" ||
            o.species === "goat" ||
            o.species === "pig" ||
            (o.kind === "player" && (o.blood < 0.85 || o.bleed > 0.1))),
      )
      // Nearest, but weighted by how badly the prey is already hurt: a wolf
      // takes the animal that cannot run, not the one that happens to be
      // closest. `incapacity` is the substrate's own number, so a limp a wolf
      // reacts to is a limp the solver is producing.
      .sort(
        (b, c) =>
          dist2(a.x, a.z, b.x, b.z) * (1 - incapacity(b) * 0.7) -
          dist2(a.x, a.z, c.x, c.z) * (1 - incapacity(c) * 0.7),
      )[0];
    if (prey) {
      a.ai = "hunt";
      a.targetId = prey.id;
      const d = seek(w, a, prey.x, prey.z, 6.4 * (0.85 + incapacity(prey) * 0.3));
      if (d < 1.3 && a.attackCd <= 0) {
        a.strikeT = 0.28;
        a.strikeHit = 0;
        a.attackCd = 0.8;
      }
      return;
    }
    a.ai = "wander";
    if (a.aiT <= 0) {
      a.wayX = a.homeX + (w.rng() - 0.5) * 18;
      a.wayZ = a.homeZ + (w.rng() - 0.5) * 18;
      a.aiT = 4;
    }
    seek(w, a, a.wayX, a.wayZ, 2.4);
    return;
  }
  if (a.species === "bear") {
    const close = w
      .nearby(a.x, a.z, 16)
      .filter(
        (o) =>
          o.alive &&
          o.id !== a.id &&
          (o.kind === "player" || o.kind === "human" || o.species === "cow" || o.species === "pig"),
      )
      .sort((b, c) => dist2(a.x, a.z, b.x, b.z) - dist2(a.x, a.z, c.x, c.z))[0];
    if (
      close &&
      (a.aggression > 0.3 || close.bleed > 0 || dist2(a.x, a.z, close.x, close.z) < 25)
    ) {
      a.ai = "hunt";
      a.targetId = close.id;
      const d = seek(w, a, close.x, close.z, 5.6);
      if (d < 2 && a.attackCd <= 0) {
        a.strikeT = 0.4;
        a.strikeHit = 0;
        a.attackCd = 1.1;
        w.emitSound(a.x, a.z, 1.1, "animal", a.id);
      }
      return;
    }
    if (a.aiT <= 0) {
      a.wayX = a.homeX + (w.rng() - 0.5) * 20;
      a.wayZ = a.homeZ + (w.rng() - 0.5) * 14;
      a.aiT = 5;
    }
    seek(w, a, a.wayX, a.wayZ, 1.8);
  }
}

function breakFence(w: World, a: Actor) {
  for (const p of w.props) {
    if (p.kind !== "fence" && p.kind !== "gate") continue;
    if (dist2(a.x, a.z, p.x, p.z) > 2.2) continue;
    p.hp -= 12 * (a.mass / 80) * (0.4 + legMotor(a) * 0.6);
    if (p.hp <= 0 && !p.collapsed) collapseProp(w, p, a.vx, a.vz);
  }
}

function stepCombat(w: World, dt: number, input: Actions | null) {
  const p = w.player();
  if (input && p.alive && p.consciousness > 0.4) {
    if (input.attackPressed && p.strikeCd <= 0 && p.loco !== "ragdoll") {
      p.strikeT = 0.3 / WEAPON_STATS[p.weapon].speed;
      p.strikeCd = 0.42 / WEAPON_STATS[p.weapon].speed;
      p.strikeHit = 0;
      p.stamina = Math.max(0, p.stamina - 0.06);
      w.emitSound(p.x, p.z, 0.35, "weapon", p.id);
    }
    if (input.kickPressed && p.kickT <= 0 && p.grounded) {
      p.kickT = 0.28;
      w.emitSound(p.x, p.z, 0.3, "whoosh", p.id);
    }
    if (input.shovePressed) {
      p.shoveT = 0.22;
    }
  }
  for (const a of w.actors) {
    a.strikeCd = Math.max(0, a.strikeCd - dt);
    a.attackCd = Math.max(0, a.attackCd - dt);
    if (a.strikeT > 0) {
      a.strikeT -= dt;
      // Prop damage stays a reach check: a crate has no node frame -- and so
      // no real geometry to sweep a hand against -- until it has already
      // taken damage once (`damageProp` is what creates it). Actor contact
      // has no such excuse and is resolved for real in `resolveStrikes`,
      // after bodies solve.
      const active = a.strikeT < 0.18 && a.strikeT > 0.04;
      if (active) {
        const st = WEAPON_STATS[a.weapon] ?? WEAPON_STATS.fist;
        const f = facing(a.yaw);
        for (const pr of w.props) {
          if (pr.collapsed || pr.heldBy) continue;
          if (dist2(a.x + f.x * 0.8, a.z + f.z * 0.8, pr.x, pr.z) > 1.6) continue;
          damageProp(w, pr, 8 + st.blunt * 14, a.vx + f.x * 3, a.vz + f.z * 3, a);
        }
      }
    }
    if (a.kickT > 0) a.kickT -= dt;
    if (a.shoveT > 0) a.shoveT -= dt;
  }
}

/**
 * Turns an active strike, kick or shove into contact.
 *
 * This runs after `stepBodies`, not from inside `stepCombat` where the
 * timers above are managed. `stepCombat` runs before the body solve, so at
 * that point "where is the hand right now" is still last tick's answer --
 * resolving contact there would price this tick's swing using last tick's
 * geometry and call it current. By the time bodies have solved, the
 * striking node's `rx/ry/rz -> px/py/pz` is a true record of where it was
 * when the tick began and where it ended up -- the actual swept path a hand
 * or foot took this tick, not a point projected from the attacker's facing
 * and a weapon-length constant. `Bodies.sweptNode` tests that segment
 * against the target's real node spheres; nothing registers unless it
 * actually passed within contact distance of one.
 */
function resolveStrikes(w: World) {
  const B = w.bodies;
  for (const a of w.actors) {
    if (a.body < 0) continue;
    const plan = B.plan(a.body);
    const base = B.base(a.body);

    if (a.strikeT > 0 && a.strikeT < 0.18 && a.strikeT > 0.04) {
      const st = WEAPON_STATS[a.weapon] ?? WEAPON_STATS.fist;
      const k = base + plan.grabHand;
      // The weapon still lengthens real reach; it no longer substitutes for it.
      const strikerRad = B.rad[k]! + st.reach * 0.35;
      const broad = st.reach * (a.species === "bear" ? 1.6 : 1) + 1.2;
      for (const o of w.nearby(a.x, a.z, broad)) {
        if (o.id === a.id || !o.alive || o.body < 0) continue;
        if (a.strikeHit & (1 << (o.id % 30))) continue;
        const node = B.sweptNode(o.body, B.rx[k]!, B.ry[k]!, B.rz[k]!, B.px[k]!, B.py[k]!, B.pz[k]!, strikerRad);
        if (node < 0) continue;
        a.strikeHit |= 1 << (o.id % 30);
        const speed = Math.hypot(a.vx, a.vz) + 2.2;
        hitActor(w, a, o, st, speed, "strike", node);
      }
    }

    if (a.kickT > 0 && a.kickT < 0.16 && a.kickT > 0.08) {
      const st = { ...WEAPON_STATS.fist, blunt: 1.1, reach: 1.1 };
      const k = base + plan.feet[1];
      const strikerRad = B.rad[k]! + 0.15;
      for (const o of w.nearby(a.x, a.z, 2.0)) {
        if (o.id === a.id || !o.alive || o.body < 0) continue;
        const node = B.sweptNode(o.body, B.rx[k]!, B.ry[k]!, B.rz[k]!, B.px[k]!, B.py[k]!, B.pz[k]!, strikerRad);
        if (node < 0) continue;
        hitActor(w, a, o, st, 3, "kick", node);
      }
    }

    if (a.shoveT > 0 && a.shoveT < 0.16) {
      const k = base + plan.grabHand;
      const strikerRad = B.rad[k]! + 0.12;
      const push = a.mass * (1.6 + armMotor(a) * 2.2); // N*s
      const f = facing(a.yaw);
      for (const o of w.nearby(a.x, a.z, 1.8)) {
        if (o.id === a.id || o.body < 0) continue;
        const node = B.sweptNode(o.body, B.rx[k]!, B.ry[k]!, B.rz[k]!, B.px[k]!, B.py[k]!, B.pz[k]!, strikerRad);
        if (node < 0) continue;
        // Applied at the chest: the shove tips the body rather than sliding
        // it, so whether it becomes a stagger or a fall is decided by the
        // support-polygon test, not by a threshold here.
        const vplan = B.plan(o.body);
        B.applyImpulse(o.body, vplan.chest, f.x * push, push * 0.12, f.z * push, STEP);
        w.emitSound(o.x, o.z, 0.3, "grab", a.id);
      }
    }
  }
}

/**
 * A strike is an impulse delivered to a node.
 *
 * The struck region is whichever node the weapon actually reached, so aiming
 * low hits legs and a swing at a prone body hits whatever is uppermost. There
 * is no random region roll and no separate "combat damage" model: the impulse
 * goes through exactly the same `impulseDamage` law as a fall or a collapsing
 * beam, with the weapon supplying sharpness and the target's own motor
 * authority deciding how much of it the tissue absorbs.
 *
 *   J   = m_eff * v_swing * massTerm * strengthTerm        [N*s]
 *   J_t = J * (cut + pierce fraction of the contact)       [N*s]
 *
 * `aimY` is the height above the attacker's feet the swing arrives at, m.
 */
function hitActor(
  w: World,
  atk: Actor,
  vic: Actor,
  st: (typeof WEAPON_STATS)[WeaponKind],
  speed: number,
  how: "strike" | "kick" | "throw",
  node: number,
) {
  const B = w.bodies;
  const f = facing(atk.yaw);
  const grip = how === "kick" ? legMotor(atk) : armMotor(atk);
  // Effective striking mass: the weapon plus the fraction of the limb behind
  // it. A limb with no motor authority cannot put its own mass behind a blow.
  const mEff = st.mass + atk.mass * 0.045 * (0.4 + grip * 0.6);
  // Swing speed, m/s: a base arm speed modified by how quick the weapon is,
  // the wielder's strength and whatever the body is already carrying.
  const vSwing =
    (5.0 + speed * 0.5) *
    (0.6 + st.speed * 0.45) *
    (0.75 + atk.strength * 0.35) *
    (0.35 + grip * 0.65);
  const jn = mEff * vSwing; // N*s

  // `node` is the real contact the swept check already found; the region and
  // mass it carries are read off it, never re-guessed from facing and reach.
  let region: Region = "torso";
  let nodeMass = vic.mass * 0.28;
  if (node >= 0 && vic.body >= 0) {
    region = B.regionOf(vic.body, node);
    nodeMass = B.mass[B.base(vic.body) + node]!;
  }

  const inj = vic.injuries[region];
  // Sharp edges convert part of the blow into a sliding, tissue-cutting
  // component; blunt weapons keep it normal.
  const sharpFrac = clamp(st.cut * 0.5 + st.pierce * 0.2, 0, 0.75);
  // Tissue at the contact deforms at the weapon's speed regardless of whether
  // the whole limb recoils, so the damage path uses the swing speed directly.
  // The limb's recoil is a separate consequence and is carried by the impulse
  // below. Bracing still helps: a limb under control absorbs part of the blow.
  const absorb = 1 - 0.5 * vic.motor[region]!;
  const vHit = vSwing * absorb;
  const got = impulseDamage(
    inj,
    vHit * (1 - sharpFrac),
    vHit * sharpFrac,
    hardnessOf(st.cut + st.pierce > 0.5 ? "metal" : st.mass > 1 ? "wood" : "flesh"),
    boneTolOf(region),
    contactFocus(st.blunt, st.pierce),
    st.cut,
    st.pierce,
  );

  if (node >= 0 && vic.body >= 0) {
    B.applyImpulse(vic.body, node, f.x * jn, jn * 0.18, f.z * jn, STEP);
  }
  vic.vx += f.x * (jn / vic.mass) * 0.55;
  vic.vz += f.z * (jn / vic.mass) * 0.55;

  if (st.fire > 0 || atk.torchLit) {
    inj.burn += 0.25;
    igniteAt(w, vic.x, vic.z, 0.35);
  }
  if (st.cut + st.pierce > 0.4) vic.bleed += 0.08 + st.cut * 0.08 + got * 0.2;
  // Concussion from the head node's change in velocity, the same law a fall or
  // a falling beam goes through.
  if (region === "head" && nodeMass > 0) {
    vic.consciousness = clamp(vic.consciousness - concussion(jn / nodeMass), 0, 1);
  }
  vic.pain = clamp(vic.pain + got * 0.9, 0, 1);
  vic.lastImpact = Math.max(vic.lastImpact, vHit);
  vic.impactRegion = region;
  vic.lastHitBy = atk.id;
  vic.lastHitT = w.time;
  if (!vic.known.includes(atk.id) && vic.kind !== "player") vic.known.push(atk.id);
  if (atk.kind === "player" && vic.faction === "guard") w.wanted = Math.min(1, w.wanted + 0.35);
  if (atk.kind === "player" && vic.faction === "civilian") w.wanted = Math.min(1, w.wanted + 0.2);
  vic.alert = 1;

  // Losing the stance is a physical outcome now: the impulse perturbs the body,
  // and the support-polygon test in the next tick decides whether that became a
  // stagger, a catch step or a fall. Only a blow big enough to overrun any
  // possible catch drops authority outright.
  const knock = jn / (vic.mass * (0.5 + legMotor(vic) * 0.9));
  if (knock > 2.6 || vic.consciousness < 0.25) {
    collapse(w, vic, 0.5 + knock * 0.12);
    if (vic.body >= 0)
      B.addVelocity(vic.body, f.x * knock * 0.9, knock * 0.5, f.z * knock * 0.9, STEP);
  } else if (knock > 1.1) {
    vic.stanceAuth = Math.max(0.15, vic.stanceAuth - knock * 0.3);
  }

  w.emitSound(vic.x, vic.z, 0.45 + Math.min(0.9, jn / 60), "impact", atk.id);
  if (vic.kind === "human" || vic.kind === "player") {
    if (vic.pain > 0.5 && w.rng() < 0.5) w.emitSound(vic.x, vic.z, 0.7, "scream", vic.id);
    else w.emitSound(vic.x, vic.z, 0.4, "hurt", vic.id);
  }
  w.shake = Math.max(w.shake, 0.15 + Math.min(0.4, jn / 90));
  w.hitstop = Math.max(w.hitstop, 0.04);
  if (atk.kind === "player") w.hitstop = 0.055;
}

/**
 * Grabbing.
 *
 * A grab is not a parent transform: it is a soft distance constraint between
 * the grabber's hand node and a node of the target, solved with both bodies'
 * real inverse masses. The consequences fall out of that rather than being
 * scripted — a heavy body hauls back on the hauler, a strong animal drags a
 * weak grabber along, an arm with no motor authority cannot keep its grip, and
 * the load shifts the grabber's centre of mass so the support-polygon test can
 * decide they have overbalanced.
 */
function stepGrab(w: World, dt: number, input: Actions | null) {
  const p = w.player();
  const B = w.bodies;
  if (input && p.alive) {
    if (input.grabPressed && !p.grabbedId && p.loco !== "ragdoll" && p.loco !== "down") {
      const f = facing(p.yaw);
      const handY =
        p.body >= 0 ? B.py[B.base(p.body) + B.plan(p.body).grabHand]! : p.y + p.height * 0.55;
      const gx = p.x + f.x * 0.5;
      const gz = p.z + f.z * 0.5;
      let best: Actor | Prop | null = null;
      let bd = 1.7;
      for (const o of w.nearby(p.x, p.z, 1.8)) {
        if (o.id === p.id) continue;
        const dx = o.x - p.x;
        const dz = o.z - p.z;
        const d = Math.hypot(dx, dz);
        const dot = (dx * f.x + dz * f.z) / (d || 1);
        if (dot < 0.1) continue;
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
      for (const pr of w.props) {
        if (pr.anchored && pr.mass > 40 && !pr.dynamic) continue;
        if (pr.kind === "wall" || pr.kind === "roof") continue;
        const d = Math.hypot(pr.x - p.x, pr.z - p.z);
        const dx = pr.x - p.x;
        const dz = pr.z - p.z;
        const dot = (dx * f.x + dz * f.z) / (d || 1);
        if (dot < 0.05 || d > 1.7) continue;
        if (d < bd) {
          bd = d;
          best = pr;
        }
      }
      if (best) {
        if ("species" in best) {
          const a = best as Actor;
          // A standing, balanced, heavier target shrugs the grab off; grip
          // strength is the grabber's own arm motor authority.
          const rel = (p.mass * (0.45 + armMotor(p) * 0.75)) / (p.mass + a.mass);
          if (rel < 0.34 && a.balance > 0.6 && a.grounded && a.alive) {
            a.stanceAuth = Math.max(0.2, a.stanceAuth - 0.25);
            w.emitSound(p.x, p.z, 0.3, "grab", p.id);
          } else {
            p.grabbedId = a.id;
            a.grabbedBy = p.id;
            p.grabNodeA = p.body >= 0 ? B.plan(p.body).grabHand : -1;
            p.grabNodeB = a.body >= 0 ? B.nearestNode(a.body, gx, handY, gz, 1.6) : -1;
            if (p.grabNodeB < 0 && a.body >= 0) p.grabNodeB = B.plan(a.body).chest;
            p.grabRest = 0.34;
            p.carry = a.mass * 0.45;
            w.emitSound(p.x, p.z, 0.4, "grab", p.id);
          }
        } else {
          const pr = best as Prop;
          pr.heldBy = p.id;
          pr.dynamic = true;
          pr.anchored = false;
          // While held, the grab constraint moves it; a frame would fight that.
          dropFrame(w.bodies, pr);
          for (const c of w.colliders) if (c.propId === pr.id) c.solid = false;
          p.grabbedId = pr.id;
          p.grabNodeA = p.body >= 0 ? B.plan(p.body).grabHand : -1;
          p.grabNodeB = -1;
          p.grabRest = 0.22;
          p.carry = pr.mass;
          if (pr.weapon) p.weapon = pr.weapon;
          if (pr.kind === "lamp") p.weapon = "torch";
          if (pr.kind === "board") p.weapon = "board";
          w.emitSound(p.x, p.z, 0.3, "grab", p.id);
        }
      }
    }
    if (input.grabReleased && p.grabbedId) {
      const spd = 7 + Math.hypot(p.vx, p.vz);
      dropHeld(w, p, clamp(spd / 6, 0.8, 1.8));
    }
  }

  for (const a of w.actors) {
    if (!a.grabbedId) continue;
    const t = w.actor(a.grabbedId);
    const pr = t ? null : w.prop(a.grabbedId);
    if (!t && !pr) {
      releaseGrab(w, a);
      continue;
    }
    if (t) {
      // Held actors keep no motor authority in the grabbed limb chain; the
      // solver's attachment constraint is what actually moves them.
      t.grabbedBy = a.id;
      a.carry = t.mass * (t.alive ? 0.45 : 0.7);
      if (!t.alive || t.consciousness < 0.3) t.stanceAuth = 0;
      // The load leans the hauler: reaction force through the arm shows up as a
      // torso lean, which shifts the centre of mass inside writePose.
      const dx = t.x - a.x;
      const dz = t.z - a.z;
      const back = -clamp(a.dragLoad / (a.mass * 22), 0, 0.22);
      const fdir = facing(a.yaw);
      a.leanZ =
        a.leanZ +
        (back * (fdir.x * dx + fdir.z * dz > 0 ? 1 : -1) - a.leanZ) * (1 - Math.exp(-dt * 6));
    } else if (pr) {
      pr.heldBy = a.id;
      a.carry = pr.mass;
      // The prop's own integration is suspended while held; the attachment
      // constraint in the solver is its only mover.
      pr.vx = pr.vy = pr.vz = 0;
      pr.yaw = a.yaw;
    }
    // Grip failure: too heavy, too damaged, or the arm has been broken.
    const capacity = a.mass * (0.55 + armMotor(a) * 1.5) * 26; // N*s the grip can hold
    if (a.dragLoad > capacity) {
      releaseGrab(w, a);
      w.emitSound(a.x, a.z, 0.35, "grab", a.id);
      if (a.kind === "player") w.whisper("Your grip tears loose.");
    }
  }
}

/**
 * Dragging leaves a mark. `Track.kind === "drag"` was declared in the data model
 * and never produced by anything; it is produced here, from real contact:
 * a held body whose nodes are touching the ground while being moved.
 */
function stepDragTracks(w: World) {
  const B = w.bodies;
  for (const a of w.actors) {
    if (!a.grabbedId) continue;
    const t = w.actor(a.grabbedId);
    if (!t || t.body < 0) continue;
    const b = B.base(t.body);
    const n = B.count[t.body]!;
    let touching = false;
    for (let i = 0; i < n && !touching; i++) if (B.touched[b + i]) touching = true;
    if (!touching) continue;
    if (Math.hypot(a.vx, a.vz) < 0.6) continue;
    if (((w.time * 6) | 0) === (((w.time - STEP) * 6) | 0)) continue;
    w.tracks.push({ x: t.x, z: t.z, t: w.time, actorId: t.id, kind: "drag", heading: a.yaw });
    if (t.bleed > 0.05)
      w.tracks.push({ x: t.x, z: t.z, t: w.time, actorId: t.id, kind: "blood", heading: a.yaw });
  }
}

/**
 * Locomotion state.
 *
 * Ragdoll, get-up and pin are no longer resolved here: they are outcomes of the
 * substrate's balance test and are advanced in `physique.consume`. What is left
 * is the gait classification and the timers that are genuinely kinematic.
 */
function stepLocomotion(w: World, dt: number) {
  for (const a of w.actors) {
    if (a.vaultT > 0) {
      a.vaultT -= dt;
      if (a.vaultT <= 0) a.loco = "idle";
    }
    if (a.loco === "climb") {
      a.locoT -= dt;
      if (a.locoT <= 0) a.loco = "idle";
    }
    // Substrate-owned states: authority, not a timer, decides when they end.
    if (a.loco === "ragdoll" || a.loco === "getup" || a.loco === "pin" || a.loco === "down") {
      a.intendSpeed = 0;
      continue;
    }
    if (a.loco === "stumble") {
      a.locoT -= dt;
      a.intendSpeed *= 0.4;
      if (a.locoT <= 0 && a.catchT <= 0 && a.offBalT < 0.05) a.loco = "idle";
    }
    const spd = a.intendSpeed;
    if (a.loco !== "stumble") {
      if (spd > 5.2) a.loco = "sprint";
      else if (spd > 3.2) a.loco = "run";
      else if (spd > 0.4) a.loco = a.crouch ? "crouch" : "walk";
      else a.loco = a.crouch ? "crouch" : "idle";
    }
    if (a.y < -0.05 && w.inWater(a.x, a.z, a.y + 0.4)) a.loco = "swim";
  }
}

function stepPhysics(w: World, dt: number) {
  for (const a of w.actors) {
    // A body with no motor authority is moved by the solver, not by this
    // controller; integrating it here too would fight the substrate.
    if (a.authority < 0.02 && a.body >= 0) continue;
    const surf = surfaceAt(w, a.x, a.z);
    const water = w.inWater(a.x, a.z, a.y + 0.5);
    const fr = frictionFor(surf, w.wet[w.cell(a.x, a.z)]);
    const acc = accelFor(surf);
    if (a.loco !== "ragdoll" && a.loco !== "pin") {
      // Traction scales with motor authority: you cannot push off a leg you
      // have no control over, which is why a stumble slides.
      const trac = 0.25 + a.authority * 0.75;
      const wishX = a.intendX * a.intendSpeed * trac;
      const wishZ = a.intendZ * a.intendSpeed * trac;
      a.vx += (wishX - a.vx) * (1 - Math.exp(-dt * acc * 0.25));
      a.vz += (wishZ - a.vz) * (1 - Math.exp(-dt * acc * 0.25));
      if (a.intendSpeed < 0.1) {
        a.vx *= Math.exp(-dt * fr);
        a.vz *= Math.exp(-dt * fr);
      }
    } else {
      a.vx *= Math.exp(-dt * (fr * 0.4));
      a.vz *= Math.exp(-dt * (fr * 0.4));
    }
    if (water) {
      a.vx *= Math.exp(-dt * 3.5);
      a.vz *= Math.exp(-dt * 3.5);
      a.wet = Math.min(1, a.wet + dt * 1.5);
      if (a.y < water.maxY - 0.35) {
        a.submerged += dt;
        a.breath = Math.max(0, a.breath - dt * 0.35);
        a.vy += 4 * dt;
      } else {
        a.submerged = Math.max(0, a.submerged - dt);
        a.breath = Math.min(1, a.breath + dt * 0.4);
      }
    } else {
      a.submerged = 0;
      a.breath = Math.min(1, a.breath + dt * 0.5);
      a.wet = Math.max(0, a.wet - dt * 0.05);
    }
    a.vy -= GRAVITY * dt * (water ? 0.35 : 1);
    integrateActor(w, a, dt);
    // Slippery ground steals traction from the feet; the support-polygon test
    // in the substrate is what turns that into a stumble or a fall.
    if (Math.hypot(a.vx, a.vz) > 4.5 && (surf === "mud" || surf === "oil") && a.body >= 0) {
      const plan = w.bodies.plan(a.body);
      const slip = a.mass * dt * (surf === "oil" ? 2.6 : 1.3);
      w.bodies.applyImpulse(a.body, plan.feet[0], a.vx * slip * 0.5, 0, a.vz * slip * 0.5, dt);
      w.bodies.applyImpulse(a.body, plan.feet[1], a.vx * slip * 0.5, 0, a.vz * slip * 0.5, dt);
    }
  }
  separateBodies(w);
  for (const a of w.actors) {
    if (a.authority < 0.02 && a.body >= 0) continue;
    collideXZ(w, a);
  }
  for (const p of w.props) {
    if (p.heldBy || (!p.dynamic && p.anchored)) continue;
    // Props with a frame are integrated by the solver, not here.
    if (p.frame >= 0) continue;
    p.vy -= GRAVITY * dt;
    p.vx *= Math.exp(-dt * 1.8);
    p.vz *= Math.exp(-dt * 1.8);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    resolveProp(w, p);
    if (p.y < 0.02 && Math.abs(p.vy) > 2.5) {
      w.emitSound(
        p.x,
        p.z,
        0.4 + Math.min(1, Math.abs(p.vy) * 0.1),
        p.material === "wood" ? "wood" : "impact",
        0,
      );
      if (p.kind === "lamp" || p.oil) {
        spillOil(w, p);
        if (p.kind === "lamp") igniteAt(w, p.x, p.z, 0.8);
      }
      p.vy *= -0.15;
    }
    if (p.y < 0) {
      p.y = 0;
      p.vy = 0;
    }
  }
}

function integrateActor(w: World, a: Actor, dt: number) {
  const steps = (1 + (Math.hypot(a.vx, a.vz, a.vy) * dt) / 0.25) | 0;
  const sdt = dt / steps;
  for (let i = 0; i < steps; i++) {
    a.x += a.vx * sdt;
    a.z += a.vz * sdt;
    collideXZ(w, a);
    a.y += a.vy * sdt;
    collideY(w, a);
  }
  a.x = clamp(a.x, -HALF + 1, HALF - 1);
  a.z = clamp(a.z, -HALF + 1, HALF - 1);
  if (solidOverlap(w, a.x, a.z, a.y, a.height, a.radius * 0.92)) unstickActor(w, a);
}

function canStepOn(a: Actor, c: Collider) {
  const rise = c.maxY - a.y;
  return a.grounded && rise > 0.04 && rise <= STEP_UP && c.maxY - c.minY < 1.25;
}

function torsoOverlapsY(a: Actor, c: Collider) {
  const y0 = a.y + 0.12;
  const y1 = a.y + a.height * 0.88;
  return !(y1 < c.minY + 0.02 || y0 > c.maxY - 0.02);
}

function resolveCircleAABB(a: Actor, c: Collider, r: number) {
  const closestX = clamp(a.x, c.minX, c.maxX);
  const closestZ = clamp(a.z, c.minZ, c.maxZ);
  const dx = a.x - closestX;
  const dz = a.z - closestZ;
  const d2 = dx * dx + dz * dz;
  const r2 = r * r;
  if (d2 > r2 && d2 > 1e-8) return false;
  if (d2 < 1e-8) {
    const left = a.x - c.minX;
    const right = c.maxX - a.x;
    const south = a.z - c.minZ;
    const north = c.maxZ - a.z;
    const m = Math.min(left, right, south, north);
    if (m === left) {
      a.x = c.minX - r;
      if (a.vx > 0) a.vx = 0;
    } else if (m === right) {
      a.x = c.maxX + r;
      if (a.vx < 0) a.vx = 0;
    } else if (m === south) {
      a.z = c.minZ - r;
      if (a.vz > 0) a.vz = 0;
    } else {
      a.z = c.maxZ + r;
      if (a.vz < 0) a.vz = 0;
    }
    return true;
  }
  const d = Math.sqrt(d2);
  const pen = r - d;
  const nx = dx / d;
  const nz = dz / d;
  a.x += nx * pen;
  a.z += nz * pen;
  const vn = a.vx * nx + a.vz * nz;
  if (vn < 0) {
    a.vx -= vn * nx;
    a.vz -= vn * nz;
  }
  return true;
}

function collideXZ(w: World, a: Actor) {
  const r = a.radius;
  for (let pass = 0; pass < 3; pass++) {
    let hit = false;
    for (const c of w.colliders) {
      if (!c.solid || c.water) continue;
      if (!torsoOverlapsY(a, c)) continue;
      if (canStepOn(a, c)) continue;
      if (resolveCircleAABB(a, c, r)) hit = true;
    }
    if (!hit) break;
  }
}

function collideY(w: World, a: Actor) {
  a.grounded = false;
  for (const c of w.colliders) {
    if (!c.solid || c.water) continue;
    const r = a.radius * 0.85;
    if (a.x + r < c.minX || a.x - r > c.maxX || a.z + r < c.minZ || a.z - r > c.maxZ) continue;
    if (a.vy <= 0 && a.y >= c.maxY - STEP_UP && a.y <= c.maxY + 0.12) {
      a.y = c.maxY;
      a.vy = 0;
      a.grounded = true;
    } else if (a.vy > 0 && a.y + a.height > c.minY && a.y < c.minY) {
      a.y = c.minY - a.height;
      a.vy = 0;
    }
  }
  if (a.y <= 0) {
    a.y = 0;
    a.vy = 0;
    a.grounded = true;
  }
}

function solidOverlap(w: World, x: number, z: number, y: number, height: number, r: number) {
  const y0 = y + 0.12;
  const y1 = y + height * 0.88;
  for (const c of w.colliders) {
    if (!c.solid || c.water) continue;
    if (y1 < c.minY + 0.02 || y0 > c.maxY - 0.02) continue;
    const cx = clamp(x, c.minX, c.maxX);
    const cz = clamp(z, c.minZ, c.maxZ);
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

export function unstickActor(w: World, a: Actor) {
  if (!solidOverlap(w, a.x, a.z, a.y, a.height, a.radius * 0.9)) return false;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [0.7, 0.7],
    [-0.7, 0.7],
    [0.7, -0.7],
    [-0.7, -0.7],
  ];
  for (let dist = 0.4; dist <= 2.4; dist += 0.35) {
    for (const [dx, dz] of dirs) {
      const nx = a.x + dx * dist;
      const nz = a.z + dz * dist;
      if (!solidOverlap(w, nx, nz, a.y, a.height, a.radius)) {
        a.x = nx;
        a.z = nz;
        a.vx = 0;
        a.vz = 0;
        return true;
      }
    }
  }
  a.y = Math.max(a.y, 0.05);
  a.x += 0.6;
  a.z += 0.6;
  a.vx = a.vz = 0;
  return true;
}

/**
 * Capsule separation for bodies that are still standing up.
 *
 * Pairs where either body has lost motor authority are skipped: those are
 * resolved node-against-node in the substrate, which is what lets them stack,
 * drape and pin rather than sliding apart in the ground plane.
 */
function separateBodies(w: World) {
  const n = w.actors.length;
  for (let i = 0; i < n; i++) {
    const a = w.actors[i]!;
    for (let j = i + 1; j < n; j++) {
      const b = w.actors[j]!;
      if (a.grabbedId === b.id || b.grabbedId === a.id) continue;
      if (a.authority <= 0.72 || b.authority <= 0.72) continue;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const min = a.radius + b.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 > min * min || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const pen = min - d;
      const nx = dx / d;
      const nz = dz / d;
      const invA = 1 / a.mass;
      const invB = 1 / b.mass;
      const s = invA + invB || 1;
      a.x -= nx * pen * (invA / s);
      a.z -= nz * pen * (invA / s);
      b.x += nx * pen * (invB / s);
      b.z += nz * pen * (invB / s);
      const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
      if (rel < 0) {
        const jimp = rel * 0.4;
        a.vx += jimp * nx;
        a.vz += jimp * nz;
        b.vx -= jimp * nx;
        b.vz -= jimp * nz;
      }
    }
  }
}

function resolveProp(w: World, p: Prop) {
  for (const c of w.colliders) {
    if (!c.solid || c.water || c.propId === p.id) continue;
    if (p.x < c.minX - p.sx || p.x > c.maxX + p.sx || p.z < c.minZ - p.sz || p.z > c.maxZ + p.sz)
      continue;
    if (p.y > c.maxY + 0.1 || p.y + p.sy < c.minY) continue;
    const cx = clamp(p.x, c.minX, c.maxX);
    const cz = clamp(p.z, c.minZ, c.maxZ);
    const dx = p.x - cx;
    const dz = p.z - cz;
    if (dx * dx + dz * dz < 0.01) {
      if (p.vy <= 0) {
        p.y = c.maxY;
        p.vy = 0;
      }
    }
  }
}

/**
 * Consciousness band that defines "down": below `DOWN_ENTER` the body is
 * unconscious and unresponsive; recovery does not resume until consciousness
 * climbs back past `DOWN_EXIT`, a deliberate gap above the entry line. Without
 * it, consciousness hovering exactly at the boundary (the regen law and the
 * smoke/head-trauma decrements both touch it every tick) would flicker the
 * actor between down and rising several times a second.
 */
const DOWN_ENTER = 0.15;
/**
 * Leaving "down" is the same decision as deciding a body is ready to rise, so
 * it reads the same number the balance controller does. Picking an independent
 * one put the exit below the floor at which a stance can be held: the body
 * stood up into a controller that immediately collapsed it again.
 */
const DOWN_EXIT = RISE_CONSCIOUS;
/**
 * Bleed rate at or under which a wound counts as closed, per second. The
 * passive decay on `bleed` always reaches this, so every wound closes
 * eventually and no body is left bleeding for good.
 */
const BLEED_CLOSED = 0.02;
/**
 * Blood volume restored per second once the wound is closed, as a fraction of
 * full. At 0.004 a drained body is whole again in about 250 s, a little under
 * half of the 540 s day -- fast enough that coming round after a bad bleed is
 * a beat rather than a wait, slow enough that being cut open still costs you
 * the fight you are in. An open bleed drains far faster than this, so bleeding
 * out is untouched: at bleed 0.5 the loss is 0.06/s against this 0.004/s.
 */
const BLOOD_REFILL = 0.004;

function stepInjury(w: World, dt: number) {
  for (const a of w.actors) {
    if (a.heat > 0.5) {
      a.injuries.torso.burn += dt * 0.15;
      a.pain = Math.min(1, a.pain + dt * 0.2);
      a.wet = Math.max(0, a.wet - dt);
    }
    const smoke = w.smoke[w.cell(a.x, a.z)];
    if (smoke > 0.45 && w.indoorAt(a.x, a.z)) {
      a.breath = Math.max(0, a.breath - dt * 0.25 * smoke);
      a.consciousness -= dt * 0.08 * smoke;
    }
    if (a.bleed > 0) {
      a.blood = Math.max(0, a.blood - a.bleed * dt * 0.12);
      a.bleed = Math.max(0, a.bleed - dt * 0.02);
      if (a.grounded && a.bleed > 0.08) {
        w.tracks.push({ x: a.x, z: a.z, t: w.time, actorId: a.id, kind: "blood", heading: a.yaw });
      }
    }
    a.pain = clamp(a.pain * (1 - dt * 0.08) + injurySum(a.injuries.torso) * 0.05, 0, 1);
    if (a.breath <= 0) a.consciousness -= dt * 0.4;
    if (injurySum(a.injuries.head) > 1.6) a.consciousness -= dt * 0.15;
    // Blood is a reservoir, not a one-way drain. It was only ever subtracted
    // from -- the bleed above was the single place in the game that wrote it --
    // so a body that had bled below the ceiling further down could never get
    // back over it. That left a band, roughly 2% to 7% blood, where an actor
    // was alive, unconscious, and unrecoverable for the rest of the session:
    // strictly worse than dying, because death at least ends.
    //
    // Volume comes back once the wound is closed, over a good part of a day.
    // This is what makes `bleed` and `blood` genuinely different quantities
    // rather than two names for one drain: the bleed is the emergency and it
    // kills in seconds, the reservoir is the debt and it repays slowly. It is
    // also what finally makes binding a wound decisive, because closing the
    // bleed is what flips a body from dying to mending.
    if (a.alive && a.bleed <= BLEED_CLOSED) {
      a.blood = Math.min(1, a.blood + BLOOD_REFILL * dt);
    }
    // Coming round. Consciousness could only ever fall, which made every
    // knockdown terminal -- there was no state between standing and dead. What
    // brings a body back is being stable and breathing, not being full: how
    // much blood is left decides how ALERT it can get, and that is the ceiling
    // below rather than a gate here. Gating recovery on blood > 0.35 meant the
    // one state that most needed a way out was the one state that had none.
    // How slowly it comes round is still what head trauma costs you.
    if (a.alive && a.bleed <= BLEED_CLOSED && a.breath > 0.25) {
      const head = injurySum(a.injuries.head);
      a.consciousness += 0.055 * clamp(1 - head / 1.8, 0, 1) * dt;
    }
    // What is left in the body caps how alert it can be. This is the last word
    // on consciousness each tick, so recovery can approach the ceiling and
    // never cross it -- applied before the recovery instead, the two fought
    // every tick and consciousness sawtoothed around the cap.
    if (a.blood < 0.25) a.consciousness = Math.min(a.consciousness, a.blood * 2);
    a.consciousness = clamp(a.consciousness, 0, 1);
    if (a.alive && (a.blood <= 0.02 || a.consciousness <= 0 || a.y < -2.5)) {
      kill(w, a, a.blood <= 0.02 ? "bled out" : a.y < -2.5 ? "drowned" : "the body gave out");
    }
    if (!a.alive) continue;
    if (a.consciousness < DOWN_ENTER) {
      a.loco = "down";
      a.intendSpeed = 0;
      a.stanceAuth = 0;
      a.downT += dt;
      if (a.kind === "player") {
        // Do not clobber a capture that has already happened: being unconscious
        // is why they took you, not a reason to forget that they did.
        if (w.phase !== "captured" && w.phase !== "dead") w.phase = "down";
        // Capture is no longer a proximity timer. A guard has to reach you,
        // take hold, and haul you across the ground to the barracks, which is
        // why a doorway full of bodies is a real reason none of them gets to
        // you. `secureTarget` ends it.
        if (a.grabbedBy) w.whisper("They drag you.");
      }
    } else if (a.loco === "down" && a.consciousness > DOWN_EXIT) {
      // "down" had no way out: nothing ever moved a loco of "down" to anything
      // else, so once consciousness dipped below DOWN_ENTER the actor -- and,
      // for the player, the whole game loop below -- was stuck there for the
      // rest of the session. Coming round rejoins the ragdoll -> pin -> getup
      // continuum every other knockdown already uses, rather than inventing a
      // second recovery path: stanceAuth ramps back up through the same
      // controller, at the same rate a fall or a shove would.
      a.loco = "getup";
      a.getupT = 0;
      a.downT = 0;
      if (a.kind === "player" && w.phase === "down") {
        // An ordinary knockdown never touches `w.phase` at all -- authority
        // alone gates what a ragdolled body can do, input stays live the whole
        // time. "down" is that same state plus a harder freeze applied only
        // while consciousness is under the line; the moment it is not, this
        // goes back to being an ordinary (if still very compromised) getup.
        w.phase = "playing";
      }
    }
  }
}

function kill(w: World, a: Actor, cause: string) {
  if (!a.alive) return;
  a.alive = false;
  a.loco = "down";
  a.consciousness = 0;
  a.intendSpeed = 0;
  a.stanceAuth = 0;
  a.authority = 0;
  for (const r of REGIONS) a.motor[r] = 0;
  releaseGrab(w, a);
  w.emitSound(a.x, a.z, 0.6, "impact", a.id);
  if (a.kind === "player") {
    w.phase = "dead";
    w.deadCause = cause;
  } else {
    w.whisper(
      a.faction === "guard"
        ? "A guard goes still."
        : a.species === "human"
          ? "Someone falls and does not rise."
          : "The animal stills.",
    );
    w.wanted = Math.min(1, w.wanted + (a.faction === "guard" ? 0.3 : 0.05));
    const carcass = w.addProp({
      kind: "carcass",
      material: "flesh",
      x: a.x,
      y: 0.05,
      z: a.z,
      sx: a.radius * 2.2,
      sy: 0.28,
      sz: a.height * 0.5,
      mass: a.mass,
      hp: 20,
      flammable: true,
      fuel: 6,
      color: 0x4a3028,
      anchored: false,
      dynamic: false,
    });
    carcass.yaw = a.yaw;
    carcass.dynamic = true;
    carcass.anchored = false;
    makeFrame(w.bodies, carcass);
  }
}

function igniteAt(w: World, x: number, z: number, power: number) {
  const i = w.cell(x, z);
  w.heat[i] = Math.min(2.5, w.heat[i] + power);
  if (w.heat[i] > 0.55 + w.wet[i] * 0.8 && (w.fuel[i] > 0.15 || w.oil[i] > 0.1)) {
    if (!w.burning[i]) {
      w.burning[i] = 1;
      w.emitSound(x, z, 0.5, "fire", 0);
      if (w.fireCount < 3) w.whisper("Fire takes.");
    }
  }
}

function spillOil(w: World, p: Prop) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const i = w.cell(p.x + dx * FIRE_CELL, p.z + dz * FIRE_CELL);
      w.oil[i] = Math.min(1.5, w.oil[i] + 0.55);
      w.fuel[i] += 0.4;
    }
  }
  w.whisper("Oil spreads.");
  p.oil = false;
}

function stepFire(w: World, dt: number) {
  w.fireCount = 0;
  const nextHeat = w.heat.slice();
  const wx = w.windX;
  const wz = w.windZ;
  for (let iz = 1; iz < FIRE_RES - 1; iz++) {
    for (let ix = 1; ix < FIRE_RES - 1; ix++) {
      const i = ix + iz * FIRE_RES;
      const rain = w.indoor[i] ? 0 : w.rain;
      w.wet[i] = clamp(w.wet[i] + rain * dt * 0.35 - dt * 0.02, 0, 1.2);
      if (w.burning[i]) {
        w.fireCount++;
        const burn = (0.35 + w.oil[i] * 0.5) * dt * (1 - rain * 0.7);
        w.fuel[i] = Math.max(0, w.fuel[i] - burn);
        w.oil[i] = Math.max(0, w.oil[i] - burn * 0.6);
        w.heat[i] = Math.min(2.2, w.heat[i] + burn * 1.4);
        w.char[i] = Math.min(1, w.char[i] + dt * 0.12);
        w.smoke[i] = Math.min(2, w.smoke[i] + dt * (1.2 + w.fuel[i] * 0.2));
        if (w.fuel[i] <= 0.02 && w.oil[i] <= 0.02) {
          w.burning[i] = 0;
          w.heat[i] *= 0.4;
        }
        if (rain > 0.55 && w.rng() < dt * 1.2) {
          w.burning[i] = 0;
          w.heat[i] *= 0.3;
        }
        const pos = w.ixz(i);
        for (const a of w.nearby(pos.x, pos.z, 2.4)) {
          a.heat = Math.max(a.heat, 0.7);
          if (a.wet < 0.4) a.injuries.torso.burn += dt * 0.2;
        }
        for (const p of w.props) {
          if (!p.flammable || p.collapsed) continue;
          if (dist2(p.x, p.z, pos.x, pos.z) < 6) {
            p.hp -= dt * 6;
            if (p.hp < p.maxHp * 0.6) p.burning = true;
            if (p.hp <= 0) collapseProp(w, p, wx, wz);
          }
        }
      } else {
        w.heat[i] = Math.max(0, w.heat[i] - dt * (0.25 + rain));
        w.smoke[i] = Math.max(0, w.smoke[i] - dt * (w.indoor[i] ? 0.15 : 0.55));
      }
      const spread =
        w.heat[i - 1] * (wx < 0 ? 1.25 : 0.8) +
        w.heat[i + 1] * (wx > 0 ? 1.25 : 0.8) +
        w.heat[i - FIRE_RES] * (wz < 0 ? 1.25 : 0.8) +
        w.heat[i + FIRE_RES] * (wz > 0 ? 1.25 : 0.8);
      nextHeat[i] = Math.max(w.heat[i], w.heat[i] * 0.7 + spread * 0.08 * dt * 8);
    }
  }
  for (let i = 0; i < w.heat.length; i++) {
    w.heat[i] = nextHeat[i]!;
    if (!w.burning[i] && w.heat[i] > 0.7 + w.wet[i] * 0.7 && (w.fuel[i] > 0.2 || w.oil[i] > 0.12)) {
      w.burning[i] = 1;
    }
  }
  for (const a of w.actors) {
    a.heat = Math.max(0, a.heat - dt * 0.6);
    const i = w.cell(a.x, a.z);
    if (w.burning[i] && a.wet < 0.5) a.heat = Math.max(a.heat, 1);
  }
}

function stepProps(w: World, _dt: number) {
  for (const p of w.props) {
    if (p.burning && p.flammable) igniteAt(w, p.x, p.z, 0.4);
    if (p.kind === "chest" && !p.heldBy) {
      const player = w.player();
      if (player.grabbedId === p.id && w.wanted < 0.15) {
        w.wanted = Math.min(1, w.wanted + 0.5);
        w.whisper("The chest is missed.");
        for (const a of w.nearby(p.x, p.z, 16)) {
          if (a.faction === "civilian" || a.faction === "guard") {
            w.addMemory(a, "theft", p.x, p.z, player.id, 0.9);
            if (a.faction === "guard") {
              a.known.push(player.id);
              a.alert = 1;
            }
          }
        }
      }
    }
  }
}

function damageProp(w: World, p: Prop, dmg: number, vx: number, vz: number, by?: Actor) {
  p.hp -= dmg;
  p.vx += vx * 0.3;
  p.vz += vz * 0.3;
  // A hard enough knock takes a prop off its footing whether or not it breaks.
  if (!p.collapsed && !p.heldBy && dmg > 10 && p.mass < 120 && p.kind !== "wall" && p.kind !== "roof") {
    const slot = makeFrame(w.bodies, p);
    if (slot >= 0) {
      p.dynamic = true;
      p.anchored = false;
      for (const c of w.colliders) if (c.propId === p.id) c.solid = false;
      const B = w.bodies;
      // Same fix as a thrown object: the blow's impulse belongs at the node
      // nearest where it actually landed, not spread over the whole frame
      // with a velocity-shaped guess at how much it should spin. This frame
      // did not exist a moment ago -- damageProp is what just created it --
      // so there is no pre-existing geometry to sweep the strike against;
      // the striker's own solved hand is the closest real fact about where
      // the blow landed that exists yet. Total momentum imparted is
      // unchanged from before (mass * 0.25 * v); only where it is applied is.
      let node = -1;
      if (by && by.body >= 0) {
        const hb = B.base(by.body);
        const hplan = B.plan(by.body);
        node = B.nearestNode(
          slot,
          B.px[hb + hplan.grabHand]!,
          B.py[hb + hplan.grabHand]!,
          B.pz[hb + hplan.grabHand]!,
          Math.max(p.sx, p.sy, p.sz) + 1,
        );
      }
      if (node >= 0) {
        B.applyImpulse(slot, node, p.mass * vx * 0.25, dmg * 0.6, p.mass * vz * 0.25, STEP);
      } else {
        B.addVelocity(slot, vx * 0.25, (dmg * 0.6) / Math.max(1, p.mass), vz * 0.25, STEP);
      }
      wakeFrame(w.bodies, slot);
    }
  }
  if (p.kind === "lamp" && dmg > 6) {
    spillOil(w, p);
    igniteAt(w, p.x, p.z, 0.7);
    w.emitSound(p.x, p.z, 0.5, "break", by?.id ?? 0);
  }
  if (p.hp <= 0) collapseProp(w, p, vx, vz);
  else w.emitSound(p.x, p.z, 0.3, "wood", by?.id ?? 0);
}

function collapseProp(w: World, p: Prop, vx: number, vz: number, failX = NaN, failZ = NaN) {
  if (p.collapsed) return;
  p.collapsed = true;
  p.dynamic = true;
  p.anchored = false;
  p.hp = 0;
  p.vy = 1.2;
  p.vx += vx * 0.4 + (w.rng() - 0.5);
  p.vz += vz * 0.4 + (w.rng() - 0.5);
  // A prop that has started to move gets a body. It can tumble, rest on things,
  // and land on people from here on, and it stops being a solid piece of the
  // world the moment it stops holding still.
  // Velocity accumulated while it was still a static box is bookkeeping, not
  // momentum: nothing was integrating it and nothing was damping it either.
  // Bounded here so a prop that took three knocks is not born at solver speed.
  const birth = Math.hypot(p.vx, p.vy, p.vz);
  if (birth > PROP_BIRTH_SPEED) {
    const k = PROP_BIRTH_SPEED / birth;
    p.vx *= k;
    p.vy *= k;
    p.vz *= k;
  }
  const slot = makeFrame(w.bodies, p);
  if (slot >= 0) {
    const B = w.bodies;
    B.addVelocity(slot, p.vx, p.vy, p.vz, STEP);
    // A structural member starts falling because one side gave way, not
    // because it was pushed from its own centre, so the force that starts it
    // moving belongs at an edge. When the caller knows which edge -- a tipped
    // or unsupported part, threaded from the same reaction solve that decided
    // it was no longer held -- anchor there and pull that corner down: the
    // rest of the frame is still rigidly connected, so the constraint solve
    // turns one corner's extra downward velocity into the same genuine
    // rotation already validated for melee and throw impulses, pivoting away
    // from the support that actually failed instead of an arbitrary axis.
    // Without that (a lone post crushed by its own overload, say -- there is
    // no other support to blame, `p` already IS the failed element), fall
    // back to projecting from (vx, vz): the best direction the caller has.
    const reach = Math.max(p.sx, p.sy, p.sz) + 1;
    if (Number.isFinite(failX) && Number.isFinite(failZ)) {
      const node = B.nearestNode(slot, failX, p.y - p.sy * 0.5, failZ, reach);
      if (node >= 0) {
        B.applyImpulse(
          slot,
          node,
          vx * p.mass * COLLAPSE_EDGE_KICK,
          -p.mass * COLLAPSE_DROP_KICK,
          vz * p.mass * COLLAPSE_EDGE_KICK,
          STEP,
        );
      }
    } else {
      const m = Math.hypot(vx, vz);
      if (m > 1e-4) {
        const node = B.nearestNode(slot, p.x + (vx / m) * reach, p.y + p.sy * 0.5, p.z + (vz / m) * reach, reach);
        if (node >= 0) B.applyImpulse(slot, node, vx * p.mass * COLLAPSE_EDGE_KICK, 0, vz * p.mass * COLLAPSE_EDGE_KICK, STEP);
      }
    }
  }
  w.emitSound(p.x, p.z, p.sy > 1.5 ? 1.1 : 0.55, p.sy > 1.5 ? "collapse" : "break", 0);
  w.shake = Math.max(w.shake, p.sy > 1.5 ? 0.55 : 0.2);
  for (const c of w.colliders) {
    if (c.propId === p.id) c.solid = false;
  }
  igniteAt(w, p.x, p.z, p.burning ? 0.6 : 0.1);
  if (p.kind === "stall" || p.kind === "table") {
    w.whisper("A stall comes down.");
  }
}

/**
 * Design safety factor on a support's rated capacity, dimensionless.
 *
 * Chosen against the structural consequence rather than picked: losing one
 * corner of a four-post rectangle throws the load onto the two neighbours and
 * exactly doubles it, so a factor below 2 makes any single cut fatal on its own
 * and a factor far above 2 makes the second cut irrelevant too. Just over 2
 * leaves a building that has lost a post standing but critical -- and puts the
 * outcome in the hands of what happens next, which is what makes a beam landing
 * on that roof matter.
 */
const SUPPORT_MARGIN = 2.2;

/**
 * A part is carried by the support group when its base stands clear of the
 * ground, m. Posts and walls are founded at y=0 and hold themselves up; a roof
 * at 2.55 m is held up by the posts, and that difference is the whole question
 * of what the supports are actually rated against.
 */
const FOUNDED_Y = 0.5;
/** Debris this far below a carried part's base still counts as resting on it, m. */
const REST_SLACK = 0.4;

/** Support scratch, sized past any building in the level; never reallocated. */
const supX = new Float64Array(32);
const supZ = new Float64Array(32);
const supLive = new Uint8Array(32);
const supR = new Float64Array(32);
const supAccum = new Float64Array(32);
const supId = new Int32Array(32);

/**
 * Rates each support against the load it actually carries in the intact
 * structure, so the safety margin is uniform even when the reactions are not.
 *
 * This runs the same solver the live cascade runs. A post that carries more by
 * geometry is built to carry more, which is why an untouched building is not
 * quietly closer to failing at one corner than another -- the asymmetry that
 * matters appears when something is removed, not at rest.
 */
function rateSupports(w: World, b: Building) {
  b.rated = true;
  const n = gatherSupports(w, b);
  if (!n) return;
  for (let i = 0; i < n; i++) {
    supLive[i] = 1;
    supAccum[i] = 0;
  }
  accumulateLoad(w, b, n, null);
  for (let i = 0; i < n; i++) {
    const p = w.prop(supId[i]!);
    if (p) p.capacity = Math.max(20, supAccum[i]! * SUPPORT_MARGIN);
  }
}

/** Fills the support scratch from `b`. Returns the count. */
function gatherSupports(w: World, b: Building) {
  let n = 0;
  for (const id of b.supports) {
    if (n >= supX.length) break;
    const p = w.prop(id);
    if (!p) continue;
    supId[n] = p.id;
    supX[n] = p.x;
    supZ[n] = p.z;
    supLive[n] = p.collapsed || p.hp <= 0 ? 0 : 1;
    n++;
  }
  return n;
}

/**
 * Distributes every carried weight onto the live supports and accumulates the
 * reactions into `supAccum`. When `fell` is supplied, parts the live supports
 * can no longer balance are pushed into it rather than silently ignored.
 *
 * Reactions superpose, so each weight is solved at its own position and summed:
 * that is what gives the result a moment arm, and it is why where a beam lands
 * decides which post carries it.
 */
function accumulateLoad(w: World, b: Building, n: number, fell: Prop[] | null) {
  let live = 0;
  for (let i = 0; i < n; i++) if (supLive[i]) live++;

  // Centroid of whichever of these supports are no longer live -- the real
  // edge a part comes down from, for `collapseProp` to anchor on. NaN when
  // none are dead (a tip from geometry alone finds no failed support to
  // blame). Computed once per building: `supLive` does not change across the
  // reaction solves below, since `solveReactions` mutates its own scratch
  // copy, never the array it is given.
  let deadX = NaN;
  let deadZ = NaN;
  if (live < n) {
    let sx = 0;
    let sz = 0;
    let dn = 0;
    for (let i = 0; i < n; i++) {
      if (supLive[i]) continue;
      sx += supX[i]!;
      sz += supZ[i]!;
      dn++;
    }
    deadX = sx / dn;
    deadZ = sz / dn;
  }

  if (!live) {
    // Nothing is holding it up. Returning here would leave a roof standing on
    // four dead posts, which is exactly the all-or-nothing failure this solve
    // exists to remove.
    if (fell) {
      for (const id of b.parts) {
        const p = w.prop(id);
        if (p && !p.collapsed && p.y > FOUNDED_Y) {
          fell.push(p);
          fellFailX.push(deadX);
          fellFailZ.push(deadZ);
        }
      }
    }
    return;
  }

  let roofY = Infinity;
  for (const id of b.parts) {
    const p = w.prop(id);
    if (p && !p.collapsed && p.y > FOUNDED_Y && p.y < roofY) roofY = p.y;
  }

  const place = (p: Prop, mass: number) => {
    if (!(mass > 0)) return;
    if (EDGES.loadMoment) {
      const r = solveReactions(supX, supZ, supLive, n, p.x, p.z, mass, supR);
      if (r === HELD) {
        for (let i = 0; i < n; i++) supAccum[i] = supAccum[i]! + supR[i]!;
      } else if (fell) {
        // Tipped past the edge of what is left standing, or nothing left at
        // all. Either way it is no longer being held up.
        fell.push(p);
        fellFailX.push(deadX);
        fellFailZ.push(deadZ);
      }
    } else {
      // Severed: an equal share per standing support, with no position in it.
      const share = mass / live;
      for (let i = 0; i < n; i++) if (supLive[i]) supAccum[i] = supAccum[i]! + share;
    }
  };

  for (const id of b.parts) {
    const p = w.prop(id);
    if (!p || p.collapsed || p.y <= FOUNDED_Y) continue;
    place(p, p.mass);
  }
  if (roofY === Infinity) return;
  // Debris resting on the structure is weight the frame has to carry, and it
  // carries it where the debris actually landed.
  for (const p of w.props) {
    if (p.collapsed || p.frame < 0 || p.buildingId === b.id) continue;
    if (p.x <= b.minX || p.x >= b.maxX || p.z <= b.minZ || p.z >= b.maxZ) continue;
    if (p.y < roofY - REST_SLACK) continue;
    place(p, p.mass);
  }
}

/**
 * Structural load, and what happens when it has nowhere to go.
 *
 * `Prop.load` and `Prop.capacity` were declared in the data model and read by
 * nothing: a building stood until half its posts were gone and then vanished
 * all at once. Load is now solved as reactions on the support group, so it
 * carries a moment arm: cutting one post throws its share onto its NEIGHBOURS
 * and unloads the diagonal, and a beam that lands on one side of the roof is
 * carried by the posts on that side.
 *
 * Two consequences follow that the equal-share model could not express. A load
 * the live supports cannot balance in moment -- past the edge of what is left
 * standing -- tips instead of overloading, so a roof comes off its remaining
 * posts rather than waiting for them to be crushed. And because each carried
 * part is solved at its own position, a building can lose one part and keep the
 * rest: half-collapsed is a real state, not a step on the way to gone.
 */
function stepStructures(w: World, dt: number) {
  for (const b of w.buildings) {
    if (b.collapsed) continue;
    if (!b.rated) rateSupports(w, b);
    const n = gatherSupports(w, b);
    if (!n) continue;
    for (let i = 0; i < n; i++) supAccum[i] = 0;

    fellScratch.length = 0;
    fellFailX.length = 0;
    fellFailZ.length = 0;
    accumulateLoad(w, b, n, fellScratch);

    // Anything the remaining supports cannot balance comes down where it stood.
    for (let i = 0; i < fellScratch.length; i++) {
      const p = fellScratch[i]!;
      collapseProp(w, p, (w.rng() - 0.5) * 2, (w.rng() - 0.5) * 2, fellFailX[i], fellFailZ[i]);
      w.whisper("Something gives way overhead.");
      w.shake = Math.max(w.shake, 0.45);
    }

    let failed = 0;
    let live = 0;
    for (let i = 0; i < n; i++) {
      if (!supLive[i]) continue;
      live++;
      const p = w.prop(supId[i]!);
      if (!p) continue;
      p.load = supAccum[i]!;
      // Overload is not instant: timber groans, sags, and then goes. The margin
      // above capacity sets how fast, so a post barely over holds for a while
      // and one carrying twice its share does not.
      if (EDGES.loadCascade && p.load > p.capacity && p.capacity > 0) {
        const over = p.load / p.capacity;
        p.hp -= dt * 14 * over;
        if (w.rng() < dt * 0.6 * over) w.emitSound(p.x, p.z, 0.5 + over * 0.2, "wood", 0);
        if (p.hp <= 0) {
          collapseProp(w, p, (w.rng() - 0.5) * 2, (w.rng() - 0.5) * 2);
          failed++;
        }
      }
    }
    if (failed && live - failed > 0) w.whisper("Timber groans overhead.");

    // The building is gone when none of its parts are left.
    //
    // `FOUNDED_Y` answers "is this part carried by the support group?" -- a
    // question about load. Asking it here made it answer "does this part still
    // exist?", which is a different question, and it got a wrong answer for
    // every structure that has nothing elevated in the first place. The bridge
    // is the proof: a deck at 0.15 m on piers sunk to -0.80 m has no part above
    // FOUNDED_Y at all, so it read as already destroyed on the first tick of
    // every game -- announcing its own collapse, frightening the whole map, and
    // igniting a panic that never ended. A part that has not collapsed is still
    // standing, whatever height it stands at.
    let standing = 0;
    for (const id of b.parts) {
      const p = w.prop(id);
      if (p && !p.collapsed) standing++;
    }
    if (standing === 0) {
      b.collapsed = true;
      w.whisper(b.name + " gives way.");
      w.emitSound((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, 1.4, "collapse", 0);
      w.shake = Math.max(w.shake, 0.7);
      // The falling timber itself is what hurts anyone underneath: the frames
      // land on them, node against node, through the same contact and the same
      // damage law as everything else. Walls are founded on the ground and are
      // not carried by the posts, so they stay up -- what is left is a real
      // half-collapsed building rather than an empty lot.
      for (const a of w.actors) {
        a.fear = Math.min(1, a.fear + 0.35);
      }
      w.wanted = Math.min(1, w.wanted + 0.15);
    }
  }
}

function stepTracks(w: World, _dt: number) {
  const p = w.player();
  if (p.grounded && Math.hypot(p.vx, p.vz) > 1.2) {
    const surf = surfaceAt(w, p.x, p.z);
    if (surf === "mud" || surf === "dirt" || w.wet[w.cell(p.x, p.z)] > 0.4) {
      if (((w.time * 8) | 0) !== (((w.time - 0.016) * 8) | 0)) {
        w.tracks.push({ x: p.x, z: p.z, t: w.time, actorId: p.id, kind: "foot", heading: p.yaw });
      }
    }
  }
  const rainKill = 8 + w.rain * 18;
  w.tracks = w.tracks.filter((t) => w.time - t.t < rainKill);
  if (w.tracks.length > 220) w.tracks.splice(0, w.tracks.length - 220);
}

function cullSounds(w: World) {
  w.sounds = w.sounds.filter((s) => w.time - s.t < 0.8);
}

export function hintFor(w: World): string {
  const p = w.player();
  const f = facing(p.yaw);
  if (p.loco === "pin") return "Pinned — something is on top of you";
  if (p.loco === "getup") return "Getting up";
  if (p.pileLoad > 12) return "Weight on you";
  if (p.grabbedId && p.dragLoad > p.mass * 12) return "Heavy — you are being pulled off balance";
  const dead = REGIONS.filter((r) => p.motor[r] < 0.25);
  if (dead.length) {
    const nice: Record<string, string> = {
      head: "head",
      torso: "body",
      larm: "left arm",
      rarm: "right arm",
      lleg: "left leg",
      rleg: "right leg",
    };
    return "Your " + nice[dead[0]!]! + " will not answer";
  }
  for (const o of w.nearby(p.x, p.z, 1.6)) {
    if (o.id === p.id) continue;
    const dx = o.x - p.x;
    const dz = o.z - p.z;
    if (dx * f.x + dz * f.z < 0) continue;
    if (o.species === "human") return o.alive ? "Hold grab — throw on release" : "A body";
    return "Grab";
  }
  for (const pr of w.props) {
    if (Math.hypot(pr.x - p.x, pr.z - p.z) > 1.5) continue;
    if (pr.kind === "chest") return "The tax chest";
    if (pr.weapon) return pr.weapon;
    if (pr.kind === "lamp") return "Lamp";
    if (pr.kind === "flask") return "Oil flask";
    if (pr.kind === "hay") return "Dry hay";
  }
  if (p.bleed > 0.2) return "Hold T to bind the wound";
  return "";
}
