import type { Actor } from "./types";
import { GRAVITY } from "./types";
import type { World } from "./world";
import { clamp } from "./world";
import {
  BODY,
  BODY_NODE_COUNT,
  bodyScale,
  type BodyMode,
  type BodyRig,
} from "./body-model";
import {
  makeMechanicalState,
  sampleMechanicalState,
  type MechanicalState,
} from "./mechanical-state";
import { bodyTaskTargets, TASK_PRIORITY } from "./body-task-targets";

const MIN_DT = 1 / 240;
const MAX_DT = 1 / 30;

const DRIVE_WEIGHT = new Float32Array([
  1.14,
  1.08,
  0.9,
  0.94, 0.94,
  0.84, 0.84,
  0.74, 0.74,
  1.02, 1.02,
  0.78, 0.78,
  0.6, 0.6,
]);

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Converts desired human translation into a friction-limited external support
 * reaction on the authoritative articulated body.
 */
export class SupportMotionController {
  private readonly state: MechanicalState = makeMechanicalState();

  drive(
    w: World,
    a: Actor,
    rig: BodyRig,
    dt: number,
    mode: BodyMode,
  ) {
    if (!a.alive || a.grabbedBy || mode === "dynamic") return;
    if (a.loco === "swim" || a.loco === "climb" || a.loco === "vault") return;

    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;
    sampleMechanicalState(w, a, rig, h, this.state);

    const supportCount =
      this.state.supportCount > 0
        ? this.state.supportCount
        : a.grounded || rig.groundedNodes > 0
          ? 1
          : 0;
    if (supportCount <= 0) return;

    const scale = bodyScale(a);
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);

    // The previous support envelope already has enough acceleration authority to
    // reach the requested speed quickly. The remaining slow feel therefore comes
    // from the gameplay velocity target itself, not insufficient traction. Raise
    // the player target directly while keeping the same friction/leg/fatigue law.
    const requestedSpeed = Math.max(0, a.intendSpeed);
    let speedScale = 1;
    if (a.kind === "player") {
      if (a.crouch) {
        speedScale = 1.08;
      } else {
        const sprintBlend = clamp01((requestedSpeed - 4.2) / 2.4);
        speedScale = 1.32 + (1.15 - 1.32) * sprintBlend;
      }
    }

    let targetVx = a.intendX * requestedSpeed * speedScale;
    let targetVz = a.intendZ * requestedSpeed * speedScale;
    const rootErrX = a.x - rig.x[BODY.pelvis]!;
    const rootErrZ = a.z - rig.z[BODY.pelvis]!;
    const errGain = a.kind === "player" ? 9.5 : 6.2;
    targetVx += clamp(rootErrX * errGain, -2.1 * scale, 2.1 * scale);
    targetVz += clamp(rootErrZ * errGain, -2.1 * scale, 2.1 * scale);

    let handReach = 0;
    if (a.weapon === "fist") {
      if (bodyTaskTargets.priorityFor(a, BODY.lHand) >= TASK_PRIORITY.ACTION) {
        handReach = Math.max(
          handReach,
          Math.hypot(
            bodyTaskTargets.targetXFor(a, BODY.lHand) - rig.x[BODY.lHand]!,
            bodyTaskTargets.targetYFor(a, BODY.lHand) - rig.y[BODY.lHand]!,
            bodyTaskTargets.targetZFor(a, BODY.lHand) - rig.z[BODY.lHand]!,
          ),
        );
      }
      if (bodyTaskTargets.priorityFor(a, BODY.rHand) >= TASK_PRIORITY.ACTION) {
        handReach = Math.max(
          handReach,
          Math.hypot(
            bodyTaskTargets.targetXFor(a, BODY.rHand) - rig.x[BODY.rHand]!,
            bodyTaskTargets.targetYFor(a, BODY.rHand) - rig.y[BODY.rHand]!,
            bodyTaskTargets.targetZFor(a, BODY.rHand) - rig.z[BODY.rHand]!,
          ),
        );
      }
    }
    if (handReach > 0) {
      const recruitment = clamp01(handReach / (0.58 * scale));
      targetVx += fx * recruitment * 0.42 * scale;
      targetVz += fz * recruitment * 0.42 * scale;
    }

    const response =
      mode === "stumble"
        ? 0.16
        : mode === "recover"
          ? 0.13
          : a.kind === "player"
            ? 0.055
            : 0.085;
    let ax = (targetVx - this.state.velX) / response;
    let az = (targetVz - this.state.velZ) / response;

    const supportFactor = supportCount >= 2 ? 1 : 0.78;
    const fatigue = 1 - clamp01(a.fatigue) * 0.34;
    const control = 0.5 + this.state.consciousness * 0.5;
    const traction =
      GRAVITY *
      (0.62 + this.state.grip * 1.48) *
      supportFactor *
      this.state.legIntegrity *
      fatigue *
      control *
      (mode === "stumble" ? 0.58 : mode === "recover" ? 0.78 : 1);

    const amag = Math.hypot(ax, az);
    if (amag > traction && amag > 1e-6) {
      const q = traction / amag;
      ax *= q;
      az *= q;
    }

    const dvx = ax * h;
    const dvz = az * h;

    let dvy = 0;
    if (a.vy > this.state.velY + 0.7 && a.vy > 1.2) {
      const requested = Math.min(7.2 * scale, a.vy - this.state.velY);
      dvy = Math.max(0, requested);
    }

    for (let node = 0; node < BODY_NODE_COUNT; node++) {
      let weight = DRIVE_WEIGHT[node]!;
      if (node === BODY.lFoot && this.state.leftSupported) weight = 0.045;
      else if (node === BODY.rFoot && this.state.rightSupported) weight = 0.045;

      rig.px[node] -= dvx * h * weight;
      rig.pz[node] -= dvz * h * weight;
      if (dvy > 0) {
        const verticalWeight =
          node === BODY.lFoot || node === BODY.rFoot ? 0.48 : Math.max(0.72, weight);
        rig.py[node] -= dvy * h * verticalWeight;
      }
    }
  }
}

export const supportMotion = new SupportMotionController();
