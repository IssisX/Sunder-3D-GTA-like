import type { Actor } from "./types";
import { GRAVITY } from "./types";
import type { World } from "./world";
import { clamp } from "./world";
import { BODY, bodyScale, type BodyRig } from "./body-model";
import {
  makeMechanicalState,
  sampleMechanicalState,
  type MechanicalState,
} from "./mechanical-state";
import { bodyTaskTargets, TASK_PRIORITY } from "./body-task-targets";

interface BodyAccess {
  get(a: Actor): BodyRig | undefined;
}

const MIN_DT = 1 / 240;
const MAX_DT = 1 / 30;
const CENTROIDAL_PRIORITY = TASK_PRIORITY.LOCOMOTION + 1;

function human(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Turns desired locomotor velocity into mechanically meaningful whole-body
 * posture using measured COM velocity and available support.
 *
 * The support-motion controller supplies the external ground reaction. This
 * controller supplies the compatible body organization: accelerate into the
 * force, lean against braking, and bank into lateral acceleration. It does not
 * add root momentum and cannot outrank corrective-step or action tasks.
 */
export class CentroidalLocomotion {
  private readonly state: MechanicalState = makeMechanicalState();

  constructor(private readonly bodies: BodyAccess) {}

  prepare(w: World, dt: number) {
    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;

    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a) || !a.alive || a.grabbedBy) continue;
      const rig = this.bodies.get(a);
      if (!rig?.initialized || rig.mode !== "follow") continue;
      if (a.loco === "swim" || a.loco === "climb" || a.loco === "vault") continue;

      sampleMechanicalState(w, a, rig, h, this.state);
      if (this.state.supportCount <= 0) continue;

      const desiredVx = a.intendX * Math.max(0, a.intendSpeed);
      const desiredVz = a.intendZ * Math.max(0, a.intendSpeed);
      const response = a.kind === "player" ? 0.13 : 0.2;
      let ax = (desiredVx - this.state.velX) / response;
      let az = (desiredVz - this.state.velZ) / response;

      const supportFactor = this.state.supportCount >= 2 ? 1 : 0.72;
      const traction =
        GRAVITY *
        (0.58 + this.state.grip * 1.18) *
        supportFactor *
        this.state.legIntegrity *
        (0.68 + this.state.consciousness * 0.32);
      const amag = Math.hypot(ax, az);
      if (amag > traction && amag > 1e-6) {
        const q = traction / amag;
        ax *= q;
        az *= q;
      }

      const fx = -Math.sin(a.yaw);
      const fz = -Math.cos(a.yaw);
      const rx = Math.cos(a.yaw);
      const rz = -Math.sin(a.yaw);
      const forwardA = ax * fx + az * fz;
      const lateralA = ax * rx + az * rz;
      const forwardLean = clamp(forwardA / GRAVITY, -0.42, 0.42);
      const lateralLean = clamp(lateralA / GRAVITY, -0.36, 0.36);
      const speed = Math.hypot(this.state.velX, this.state.velZ);
      const demand = clamp01(Math.hypot(ax, az) / Math.max(1e-5, GRAVITY));
      const scale = bodyScale(a);

      // Build on the ordinary locomotion targets rather than replacing the gait.
      // Higher-priority corrective/action targets remain authoritative.
      if (bodyTaskTargets.priorityFor(a, BODY.pelvis) <= TASK_PRIORITY.LOCOMOTION) {
        const px = bodyTaskTargets.targetXFor(a, BODY.pelvis);
        const py = bodyTaskTargets.targetYFor(a, BODY.pelvis);
        const pz = bodyTaskTargets.targetZFor(a, BODY.pelvis);
        const forwardShift = forwardLean * 0.05 * scale;
        const lateralShift = lateralLean * 0.04 * scale;
        bodyTaskTargets.offerWorld(
          a,
          BODY.pelvis,
          px + fx * forwardShift + rx * lateralShift,
          py - demand * 0.012 * scale,
          pz + fz * forwardShift + rz * lateralShift,
          1,
          CENTROIDAL_PRIORITY,
        );
      }

      if (bodyTaskTargets.priorityFor(a, BODY.chest) <= TASK_PRIORITY.LOCOMOTION) {
        const cx = bodyTaskTargets.targetXFor(a, BODY.chest);
        const cy = bodyTaskTargets.targetYFor(a, BODY.chest);
        const cz = bodyTaskTargets.targetZFor(a, BODY.chest);
        // Upper body leads acceleration more strongly than the pelvis. Braking
        // automatically reverses this displacement because forwardLean < 0.
        const forwardShift = forwardLean * (0.14 + Math.min(0.05, speed * 0.008)) * scale;
        const lateralShift = lateralLean * 0.12 * scale;
        bodyTaskTargets.offerWorld(
          a,
          BODY.chest,
          cx + fx * forwardShift + rx * lateralShift,
          cy,
          cz + fz * forwardShift + rz * lateralShift,
          1,
          CENTROIDAL_PRIORITY,
        );
      }

      if (bodyTaskTargets.priorityFor(a, BODY.head) <= TASK_PRIORITY.LOCOMOTION) {
        const hx = bodyTaskTargets.targetXFor(a, BODY.head);
        const hy = bodyTaskTargets.targetYFor(a, BODY.head);
        const hz = bodyTaskTargets.targetZFor(a, BODY.head);
        // Head compensation prevents the entire body from becoming a rigid lean.
        bodyTaskTargets.offerWorld(
          a,
          BODY.head,
          hx - fx * forwardLean * 0.028 * scale - rx * lateralLean * 0.022 * scale,
          hy,
          hz - fz * forwardLean * 0.028 * scale - rz * lateralLean * 0.022 * scale,
          0.88,
          CENTROIDAL_PRIORITY,
        );
      }
    }
  }
}
