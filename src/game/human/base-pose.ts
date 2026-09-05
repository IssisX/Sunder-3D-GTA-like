import type { Actor } from "../types";
import { facing, rightOf } from "../world";
import {
  BODY,
  BODY_NODE_COUNT,
  HUMAN_BASE_POSE,
  bodyScale,
} from "./anatomy";
import {
  bodyMode,
  snapshotInjuries,
  type BodyRig,
} from "./rig-state";

/**
 * Compatibility/default whole-body target only.
 * Locomotion and actions override these targets through task-space controllers.
 */
export function computeTarget(
  a: Actor,
  rig: BodyRig,
  floorY = a.y,
) {
  const scale = bodyScale(a);
  const f = facing(a.yaw);
  const r = rightOf(a.yaw);
  const speed = Math.hypot(a.vx, a.vz);
  const stride = Math.min(0.34, speed * 0.055) * scale;
  const legSwing = Math.sin(a.walkPhase) * stride;
  const armSwing = Math.sin(a.walkPhase + Math.PI) * stride * 0.75;

  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    const o = i * 3;
    const lx = HUMAN_BASE_POSE[o]! * scale;
    let ly = HUMAN_BASE_POSE[o + 1]! * scale;
    let lz = HUMAN_BASE_POSE[o + 2]! * scale;

    if (a.crouch) {
      if (i === BODY.pelvis || i === BODY.lHip || i === BODY.rHip) {
        ly -= 0.18 * scale;
      }
      if (
        i === BODY.chest ||
        i === BODY.head ||
        i === BODY.lShoulder ||
        i === BODY.rShoulder
      ) {
        ly -= 0.28 * scale;
        lz += 0.12 * scale;
      }
      if (i === BODY.lKnee || i === BODY.rKnee) {
        ly -= 0.08 * scale;
        lz += 0.16 * scale;
      }
    }

    if (i === BODY.lKnee) lz += legSwing * 0.5;
    else if (i === BODY.lFoot) lz += legSwing;
    else if (i === BODY.rKnee) lz -= legSwing * 0.5;
    else if (i === BODY.rFoot) lz -= legSwing;
    else if (i === BODY.lElbow) lz += armSwing * 0.45;
    else if (i === BODY.lHand) lz += armSwing;
    else if (i === BODY.rElbow) lz -= armSwing * 0.45;
    else if (i === BODY.rHand) lz -= armSwing;

    // Legacy compatibility while old semantic attack timers still exist.
    // Procedural action tasks supersede these nodes at higher priority.
    if (a.strikeT > 0 && (i === BODY.rElbow || i === BODY.rHand)) {
      lz += (i === BODY.rHand ? 0.48 : 0.24) * scale;
      ly += (i === BODY.rHand ? 0.08 : 0.04) * scale;
    }
    if (a.kickT > 0 && (i === BODY.rKnee || i === BODY.rFoot)) {
      lz += (i === BODY.rFoot ? 0.58 : 0.28) * scale;
      ly += (i === BODY.rFoot ? 0.18 : 0.08) * scale;
    }

    rig.tx[i] = a.x + r.x * lx + f.x * lz;
    rig.ty[i] = floorY + ly;
    rig.tz[i] = a.z + r.z * lx + f.z * lz;
  }
}

export function resetRig(a: Actor, rig: BodyRig) {
  computeTarget(a, rig, a.y);
  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    rig.x[i] = rig.px[i] = rig.tx[i]!;
    rig.y[i] = rig.py[i] = rig.ty[i]!;
    rig.z[i] = rig.pz[i] = rig.tz[i]!;
    rig.impactCd[i] = 0;
  }
  snapshotInjuries(a, rig);
  rig.initialized = true;
  rig.mode = bodyMode(a);
  rig.grabNode = -1;
  rig.groundedNodes = 0;
}
