import type { Actor } from "./types";
import { clamp } from "./world";

const PELVIS = 0;
const SHIN_L = 8;
const SHIN_R = 10;

/**
 * Walk cadence in steps. Slow wander still puts a foot down about twice a
 * second so a crowd doesn't ice-skate past the camera.
 */
export function stepCadence(a: Actor, dt: number) {
  if (a.loco !== "walk" && a.loco !== "run" && a.loco !== "sprint") return;
  const spd = Math.hypot(a.vx, a.vz);
  const steps = clamp(1.75 + spd * 0.42, 1.9, 3.35);
  a.walkPhase += steps * Math.PI * dt;
}

/**
 * One planted foot. The other is allowed to swing. Switching happens when the
 * walk cycle wants the other foot — never because the planted foot stretched.
 * Stretch is handled by sliding the plant in, not hopping to the other foot
 * (that hop is what turned a walk into a slide).
 */
export function updatePlant(a: Actor) {
  if (!a.body || a.body.mode !== "stance" || !a.alive) {
    a.plantPart = -1;
    return;
  }
  if (!a.grounded || a.vy > 0.4 || a.loco === "vault" || a.loco === "climb") {
    a.plantPart = -1;
    return;
  }
  if (a.kickT > 0) {
    const foot = a.body.parts[SHIN_L]!;
    if (a.plantPart !== SHIN_L) {
      a.plantPart = SHIN_L;
      a.plantX = foot.x;
      a.plantZ = foot.z;
    }
    slidePlant(a, 0.34);
    return;
  }
  if (a.strikeT > 0 && a.grounded) {
    const want = Math.sin(a.walkPhase) >= 0 ? SHIN_R : SHIN_L;
    const foot = a.body.parts[want]!;
    if (a.plantPart !== want) {
      a.plantPart = want;
      a.plantX = foot.x;
      a.plantZ = foot.z;
    }
    slidePlant(a, 0.36);
    return;
  }
  const spd = Math.hypot(a.vx, a.vz);
  const stepping =
    a.grounded && spd > 0.28 && (a.loco === "walk" || a.loco === "run" || a.loco === "sprint");
  if (!stepping) {
    a.plantPart = -1;
    return;
  }
  const want = Math.sin(a.walkPhase) >= 0 ? SHIN_R : SHIN_L;
  const foot = a.body.parts[want]!;
  if (want !== a.plantPart) {
    a.plantPart = want;
    a.plantX = foot.x;
    a.plantZ = foot.z;
  }
  slidePlant(a, clamp(0.44 + spd * 0.08, 0.48, 0.72));
}

function slidePlant(a: Actor, maxReach: number) {
  if (!a.body || a.plantPart < 0) return;
  const pel = a.body.parts[PELVIS]!;
  const reach = Math.hypot(pel.x - a.plantX, pel.z - a.plantZ);
  if (reach <= maxReach || reach < 1e-6) return;
  const s = maxReach / reach;
  a.plantX = pel.x + (a.plantX - pel.x) * s;
  a.plantZ = pel.z + (a.plantZ - pel.z) * s;
}
