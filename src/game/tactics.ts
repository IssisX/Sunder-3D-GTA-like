/**
 * The layer where the substrate becomes tactical information.
 *
 * Before this, the AI reasoned about capsules: an actor was a position, a
 * faction and an alive flag. It could not tell a man standing from a man
 * pinned under two bodies, could not see that the leg it just broke was the
 * leg the target runs on, and walked straight through a heap in a doorway.
 *
 * Everything here reads state the physical substrate already solves -- motor
 * authority, support margin, pile load, locomotion state -- and turns it into
 * the things an agent should be able to notice. Nothing here is a new
 * simulation: it is the consumer side of edges that already exist.
 */

import { EDGES } from "./body";
import { type Actor, type Region, REGIONS } from "./types";
import { World, clamp } from "./world";
import { armMotor, legMotor } from "./physique";

/** Radius, m, within which a body on the ground is treated as an obstacle. */
const BODY_OBSTACLE_R = 1.5;
/** Pile load, kg, at which a heap is treated as impassable rather than awkward. */
const PILE_BLOCK = 55;

/**
 * How incapacitated an actor is, 0 (fine) to 1 (helpless).
 *
 * Combines the three ways a body stops working: it is not conscious, it has no
 * motor authority left, or something is on top of it. These are the same
 * numbers the solver uses, so what an observer notices and what is physically
 * true cannot drift apart.
 */
export function incapacity(a: Actor): number {
  if (!a.alive) return 1;
  const down =
    a.loco === "down" || a.loco === "pin"
      ? 1
      : a.loco === "ragdoll" || a.loco === "getup"
        ? 0.75
        : 0;
  const limbs = 1 - (legMotor(a) * 0.6 + armMotor(a) * 0.4);
  const out = 1 - clamp(a.consciousness, 0, 1);
  const pinned = clamp(a.pileLoad / (a.mass * 0.9), 0, 1);
  return clamp(Math.max(down, out, pinned) * 0.7 + limbs * 0.3, 0, 1);
}

/** True when an actor can neither fight nor flee. */
export function isHelpless(a: Actor): boolean {
  if (!a.alive) return true;
  if (!EDGES.bodyTactics) return false;
  return a.loco === "down" || a.loco === "pin" || a.consciousness < 0.3 || incapacity(a) > 0.75;
}

/**
 * How dangerous this actor is right now, 0 to 1.
 *
 * A weapon is worth little in an arm that will not close, and nothing at all
 * to someone who cannot stand up. This is what lets a guard stop swinging at a
 * man who is already finished and go and secure him instead.
 */
export function threatLevel(a: Actor): number {
  if (isHelpless(a)) return 0;
  if (!EDGES.bodyTactics) return 1;
  const reach = a.weapon === "fist" ? 0.45 : 1;
  const arms = armMotor(a);
  const stance = clamp(a.balance, 0, 1) * 0.4 + 0.6;
  return clamp(reach * (0.25 + arms * 0.75) * stance * (0.4 + a.consciousness * 0.6), 0, 1);
}

/** The limb with the least motor authority left, and how far gone it is. */
export function weakestLimb(a: Actor): { region: Region; loss: number } {
  let region: Region = "torso";
  let loss = 0;
  for (const r of REGIONS) {
    const l = 1 - a.motor[r]!;
    if (l > loss) {
      loss = l;
      region = r;
    }
  }
  return { region, loss };
}

/**
 * True when the target's legs are the thing to attack: either they are already
 * the weak point, or the target is on the ground and a low blow is simply where
 * the target is.
 *
 * Because a strike's height is read from the attacker's own solved hand, an
 * attacker that crouches genuinely lands lower -- so this decision changes
 * which region takes the damage rather than annotating it.
 */
export function shouldStrikeLow(target: Actor): boolean {
  if (!EDGES.bodyTactics) return false;
  if (
    target.loco === "down" ||
    target.loco === "ragdoll" ||
    target.loco === "pin" ||
    target.loco === "getup"
  )
    return true;
  return legMotor(target) < 0.7 && legMotor(target) < armMotor(target);
}

/**
 * True when a target is worth committing to: off balance, slowed, or already
 * going down. A pursuer that reads this closes and grabs instead of trading
 * blows at range.
 */
export function isOffBalance(a: Actor): boolean {
  if (!EDGES.bodyTactics) return false;
  return a.support < 0.02 || a.loco === "stumble" || a.catchT > 0 || legMotor(a) < 0.45;
}

/**
 * Steering away from bodies on the ground.
 *
 * Downed actors are solid now -- they block, they trip people, they stack. An
 * agent that steers straight through them walks into a wall of flesh and falls
 * over, which looks like a bug and is really just the AI not being told the
 * world changed. Returns the desired direction bent around whatever is lying in
 * the way, weighted by how much is piled there.
 *
 * This is the topology edge: bodies change what is traversable, and navigation
 * is a consumer of that rather than an authority on it.
 */
export function avoidBodies(
  w: World,
  a: Actor,
  dirX: number,
  dirZ: number,
  skipId = 0,
): { x: number; z: number } {
  if (!EDGES.bodyTactics) return { x: dirX, z: dirZ };
  let px = 0;
  let pz = 0;
  for (const o of w.nearby(a.x, a.z, BODY_OBSTACLE_R + 1)) {
    if (o.id === a.id) continue;
    // The body you are going TO is not an obstacle. Without this exception a
    // guard sent to secure someone is pushed off the very target it is closing
    // on, oscillates, trips over it and drops the prisoner it just took hold of.
    if (o.id === skipId) continue;
    if (o.id === a.grabbedId || o.grabbedId === a.id) continue;
    // Only bodies actually on the ground obstruct; a standing actor is handled
    // by ordinary separation.
    if (o.authority > 0.5 && o.alive) continue;
    const dx = a.x - o.x;
    const dz = a.z - o.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    // A heap is wider and harder to step over than a single body.
    const r = BODY_OBSTACLE_R + clamp(o.pileLoad / PILE_BLOCK, 0, 1) * 0.9;
    if (d > r || d < 1e-4) continue;
    const w8 = (1 - d / r) * (1 + clamp(o.pileLoad / PILE_BLOCK, 0, 1.5));
    px += (dx / d) * w8;
    pz += (dz / d) * w8;
  }
  if (px === 0 && pz === 0) return { x: dirX, z: dirZ };
  const nx = dirX + px * 1.4;
  const nz = dirZ + pz * 1.4;
  const m = Math.sqrt(nx * nx + nz * nz);
  if (m < 1e-4) return { x: dirX, z: dirZ };
  return { x: nx / m, z: nz / m };
}

/** Mass of bodies heaped at a spot, kg. Used to judge whether a way is shut. */
export function pileAt(w: World, x: number, z: number, radius = 1.2): number {
  let mass = 0;
  for (const o of w.nearby(x, z, radius)) {
    if (o.authority > 0.5 && o.alive) continue;
    mass += o.mass;
  }
  return mass;
}

/**
 * True when enough bodies are down at a point to shut it. A doorway with three
 * men in it is not a doorway.
 */
export function isBlocked(w: World, x: number, z: number): boolean {
  return pileAt(w, x, z) > PILE_BLOCK * 2;
}
