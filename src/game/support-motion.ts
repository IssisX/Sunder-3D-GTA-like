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

// How much of the support reaction is transmitted immediately to each node.
// Supported feet remain nearly stationary; the articulated chain carries the
// reaction from the ground into the pelvis/torso instead of simply sliding the
// entire rig as one kinematic object.
const DRIVE_WEIGHT = new Float32Array([
  1.0, // pelvis
  0.96, // chest
  0.84, // head
  0.86, 0.86, // shoulders
  0.78, 0.78, // elbows
  0.7, 0.7, // hands
  0.92, 0.92, // hips
  0.72, 0.72, // knees
  0.58, 0.58, // feet; supported feet are reduced further below
]);

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Converts desired human translation into a friction-limited external support
 * reaction on the authoritative articulated body.
 *
 * This is the missing bridge between "I intend to walk" and actual COM
 * momentum. Internal joint actuation cannot manufacture net translation, so
 * locomotor momentum is introduced only while a real support contact exists
 * (or the previous physical step confirmed grounded support).
 *
 * The legacy Actor root remains a compatibility predictor for one fixed step;
 * it is not the final authority. PhysicalBodies derives the Actor root back
 * from the solved pelvis after this impulse, constraints, and contacts run.
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

    // Previous-step grounded state is a valid one-tick support witness and
    // prevents a contact-tolerance deadlock from making an otherwise standing
    // body incapable of initiating its first step.
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

    // Game/AI intent supplies the desired velocity, while the tiny Actor/pelvis
    // mismatch from the compatibility world step is treated only as a tracking
    // reference. The solved pelvis will overwrite that predictor later.
    let targetVx = a.intendX * Math.max(0, a.intendSpeed);
    let targetVz = a.intendZ * Math.max(0, a.intendSpeed);
    const rootErrX = a.x - rig.x[BODY.pelvis]!;
    const rootErrZ = a.z - rig.z[BODY.pelvis]!;
    const errGain = a.kind === "player" ? 7.5 : 5.2;
    targetVx += clamp(rootErrX * errGain, -1.5 * scale, 1.5 * scale);
    targetVz += clamp(rootErrZ * errGain, -1.5 * scale, 1.5 * scale);

    // A bare-fist strike recruits a small legitimate ground reaction into the
    // punch. This is not an animation shove: it is available only through
    // support and is capped by the same traction envelope as locomotion.
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
      targetVx += fx * recruitment * 0.34 * scale;
      targetVz += fz * recruitment * 0.34 * scale;
    }

    const response =
      mode === "stumble"
        ? 0.2
        : mode === "recover"
          ? 0.16
          : a.kind === "player"
            ? 0.095
            : 0.14;
    let ax = (targetVx - this.state.velX) / response;
    let az = (targetVz - this.state.velZ) / response;

    const supportFactor = supportCount >= 2 ? 1 : 0.74;
    const fatigue = 1 - clamp01(a.fatigue) * 0.34;
    const control = 0.5 + this.state.consciousness * 0.5;
    const traction =
      GRAVITY *
      (0.34 + this.state.grip * 0.74) *
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

    // Jump still originates in the existing gameplay request, but the takeoff
    // velocity is now admitted to the articulated body only while support is
    // available. Once airborne, internal articulation cannot create more lift.
    let dvy = 0;
    if (a.vy > this.state.velY + 0.7 && a.vy > 1.2) {
      const requested = Math.min(7.2 * scale, a.vy - this.state.velY);
      dvy = Math.max(0, requested);
    }

    for (let node = 0; node < BODY_NODE_COUNT; node++) {
      let weight = DRIVE_WEIGHT[node]!;
      if (node === BODY.lFoot && this.state.leftSupported) weight = 0.06;
      else if (node === BODY.rFoot && this.state.rightSupported) weight = 0.06;

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
