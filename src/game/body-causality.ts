import type { Actor } from "./types";
import type { World } from "./world";
import { clamp, injurySum } from "./world";
import { BODY, bodyScale, nodeRadius, type BodyRig } from "./body-model";
import { supportHeight } from "./body-contacts";
import { impactDynamics } from "./impact-dynamics";

interface BodyAccess {
  get(a: Actor): BodyRig | undefined;
}

const MIN_DT = 1 / 240;
const MAX_DT = 1 / 30;

function human(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function distanceToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
) {
  const abx = bx - ax;
  const abz = bz - az;
  const den = abx * abx + abz * abz;
  let t = den > 1e-9 ? ((px - ax) * abx + (pz - az) * abz) / den : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + abx * t);
  const dz = pz - (az + abz * t);
  return Math.hypot(dx, dz);
}

/**
 * Turns the articulated rig into the common causal boundary between contact,
 * injury, balance and locomotion state.
 *
 * Stability is not a hit-animation threshold. It is derived from the support
 * geometry under the feet, projected upper-body COM, torso posture, leg
 * integrity, consciousness and the persistent contact disturbance field.
 */
export class BodyCausality {
  constructor(private readonly bodies: BodyAccess) {}

  step(w: World, dt: number) {
    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;

    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a) || !a.alive) continue;
      const rig = this.bodies.get(a);
      if (!rig?.initialized) continue;
      if (a.loco === "down" || a.loco === "getup" || a.loco === "ragdoll") continue;

      const scale = bodyScale(a);
      const lfx = rig.x[BODY.lFoot]!;
      const lfy = rig.y[BODY.lFoot]!;
      const lfz = rig.z[BODY.lFoot]!;
      const rfx = rig.x[BODY.rFoot]!;
      const rfy = rig.y[BODY.rFoot]!;
      const rfz = rig.z[BODY.rFoot]!;
      const lh = supportHeight(w, lfx, lfy, lfz);
      const rh = supportHeight(w, rfx, rfy, rfz);
      const lBottom = lfy - nodeRadius(a, BODY.lFoot);
      const rBottom = rfy - nodeRadius(a, BODY.rFoot);
      const lSupported = Math.abs(lBottom - lh) <= 0.085 * scale;
      const rSupported = Math.abs(rBottom - rh) <= 0.085 * scale;

      // Compact projected COM proxy. The pelvis carries most mass; chest/head
      // are included so an off-axis upper-body impulse actually moves support
      // demand instead of only changing a cosmetic lean.
      const comX =
        rig.x[BODY.pelvis]! * 0.5 +
        rig.x[BODY.chest]! * 0.34 +
        rig.x[BODY.head]! * 0.16;
      const comZ =
        rig.z[BODY.pelvis]! * 0.5 +
        rig.z[BODY.chest]! * 0.34 +
        rig.z[BODY.head]! * 0.16;

      let supportDistance: number;
      let supportRadius: number;
      let supportCount = 0;
      if (lSupported && rSupported) {
        supportCount = 2;
        supportDistance = distanceToSegment(comX, comZ, lfx, lfz, rfx, rfz);
        supportRadius = 0.19 * scale;
      } else if (lSupported) {
        supportCount = 1;
        supportDistance = Math.hypot(comX - lfx, comZ - lfz);
        supportRadius = 0.25 * scale;
      } else if (rSupported) {
        supportCount = 1;
        supportDistance = Math.hypot(comX - rfx, comZ - rfz);
        supportRadius = 0.25 * scale;
      } else {
        supportDistance = 1;
        supportRadius = 0.18 * scale;
      }

      const supportMargin = supportRadius - supportDistance;
      const supportScore = supportCount
        ? clamp01((supportMargin + 0.07 * scale) / (0.28 * scale))
        : 0;

      const rise = rig.y[BODY.chest]! - rig.y[BODY.pelvis]!;
      const torsoLean = Math.hypot(
        rig.x[BODY.chest]! - rig.x[BODY.pelvis]!,
        rig.z[BODY.chest]! - rig.z[BODY.pelvis]!,
      );
      const upright =
        clamp01((rise - 0.11 * scale) / (0.31 * scale)) *
        clamp01(1 - torsoLean / (0.72 * scale));

      const leftDamage = injurySum(a.injuries.lleg);
      const rightDamage = injurySum(a.injuries.rleg);
      const legIntegrity = 1 / (1 + 0.42 * (leftDamage + rightDamage));
      const consciousness = clamp01((a.consciousness - 0.12) / 0.88);
      const disturbance = impactDynamics.disturbance(a);

      // Capacity comes from what is actually supporting the body. Demand comes
      // from the same impulse field that visibly deforms the rig. No separate
      // melee "fall chance" is needed.
      const capacity =
        (0.18 + supportScore * 0.82) *
        (0.48 + legIntegrity * 0.52) *
        (0.42 + consciousness * 0.58) *
        (0.5 + upright * 0.5);
      const demand = disturbance * (0.72 + (1 - upright) * 0.45);
      const stability = capacity - demand;

      // Recovery is continuous when support is good. Contact loss and impulse
      // load oppose it through the same scalar that decides the locomotion mode.
      const recovery = supportScore * legIntegrity * consciousness * h * 1.15;
      const loss = Math.max(0, demand - capacity * 0.35) * h * 3.6;
      a.balance = clamp(a.balance + recovery - loss, 0, 1);

      const catastrophic =
        disturbance > 1.16 &&
        (stability < -0.32 || supportCount === 0 || consciousness < 0.22);
      const unstable =
        disturbance > 0.18 &&
        (stability < 0.28 || supportScore < 0.22 || a.balance < 0.2);

      if (catastrophic) {
        a.loco = "ragdoll";
        a.locoT = Math.max(a.locoT, 0.62 + Math.min(0.65, disturbance * 0.22));
        a.balance = Math.min(a.balance, 0.08);
      } else if (unstable && a.loco !== "stumble") {
        a.loco = "stumble";
        a.locoT = Math.max(a.locoT, 0.28 + Math.min(0.38, disturbance * 0.14));
      } else if (
        a.loco === "stumble" &&
        disturbance < 0.12 &&
        supportScore > 0.48 &&
        upright > 0.58 &&
        a.locoT <= 0
      ) {
        a.loco = "idle";
      }
    }
  }
}
