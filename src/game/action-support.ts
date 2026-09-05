import type { Actor } from "./types";
import type { World } from "./world";
import {
  BODY,
  bodyScale,
  nodeRadius,
  type BodyRig,
} from "./body-model";
import { supportHeight } from "./body-contacts";

const TAU = Math.PI * 2;
const SWING_PORTION = 0.42;

export const EDGES = {
  currentStanceAuthority: true,
};

export function footSupported(
  w: World,
  a: Actor,
  rig: BodyRig,
  foot: number,
) {
  const scale = bodyScale(a);
  const surface = supportHeight(
    w,
    rig.x[foot]!,
    rig.y[foot]!,
    rig.z[foot]!,
  );
  const bottom = rig.y[foot]! - nodeRadius(a, foot);
  return Math.abs(bottom - surface) <= 0.085 * scale;
}

/**
 * Select the leg already mechanically free to attack.
 *
 * Order of evidence:
 *  1. if only one foot is supporting, the other leg attacks;
 *  2. if both/neither support, the foot already moving faster attacks;
 *  3. if motion is ambiguous, the foot farther from the current COM attacks;
 *  4. gait phase is only a deterministic tie-breaker.
 *
 * No authored combat stance is created here.
 */
export function chooseKickAttackLeft(
  w: World,
  a: Actor,
  rig: BodyRig,
) {
  if (!EDGES.currentStanceAuthority) return false;

  const leftSupported = footSupported(w, a, rig, BODY.lFoot);
  const rightSupported = footSupported(w, a, rig, BODY.rFoot);
  if (leftSupported !== rightSupported) return rightSupported;

  const scale = bodyScale(a);
  const ldx = rig.x[BODY.lFoot]! - rig.px[BODY.lFoot]!;
  const ldz = rig.z[BODY.lFoot]! - rig.pz[BODY.lFoot]!;
  const rdx = rig.x[BODY.rFoot]! - rig.px[BODY.rFoot]!;
  const rdz = rig.z[BODY.rFoot]! - rig.pz[BODY.rFoot]!;
  const lMove2 = ldx * ldx + ldz * ldz;
  const rMove2 = rdx * rdx + rdz * rdz;
  const moveBias2 = (0.006 * scale) ** 2;
  if (Math.abs(lMove2 - rMove2) > moveBias2) return lMove2 > rMove2;

  const comX = rig.x[BODY.pelvis]! * 0.62 + rig.x[BODY.chest]! * 0.38;
  const comZ = rig.z[BODY.pelvis]! * 0.62 + rig.z[BODY.chest]! * 0.38;
  const lcx = rig.x[BODY.lFoot]! - comX;
  const lcz = rig.z[BODY.lFoot]! - comZ;
  const rcx = rig.x[BODY.rFoot]! - comX;
  const rcz = rig.z[BODY.rFoot]! - comZ;
  const lCom2 = lcx * lcx + lcz * lcz;
  const rCom2 = rcx * rcx + rcz * rcz;
  const comBias2 = (0.025 * scale) ** 2;
  if (Math.abs(lCom2 - rCom2) > comBias2) return lCom2 > rCom2;

  let u = (a.walkPhase % TAU) / TAU;
  if (u < 0) u += 1;
  let ru = u + 0.5;
  if (ru >= 1) ru -= 1;
  const leftSwing = u < SWING_PORTION;
  const rightSwing = ru < SWING_PORTION;
  if (leftSwing !== rightSwing) return leftSwing;

  return false;
}
