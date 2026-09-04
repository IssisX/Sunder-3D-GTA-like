import type { Actor, Region } from "./types";
import type { World } from "./world";
import { injurySum } from "./world";
import {
  BODY,
  BODY_NODE_COUNT,
  NODE_REGION,
  bodyScale,
  nodeVelocityComponent,
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

// Controlled humans should feel actively supported, not floppy. Core and legs
// carry stronger posture bandwidth; distal joints remain compliant enough for
// contacts and impact torque to visibly win.
const OMEGA = new Float32Array([
  21.0, // pelvis
  22.0, // chest
  16.0, // head
  18.0, 18.0, // shoulders
  16.0, 16.0, // elbows
  15.0, 15.0, // hands
  20.0, 20.0, // hips
  18.0, 18.0, // knees
  16.0, 16.0, // feet
]);

const NODE_AUTHORITY = new Float32Array([
  1.0,
  1.0,
  0.62,
  0.86, 0.86,
  0.76, 0.76,
  0.68, 0.68,
  0.95, 0.95,
  0.86, 0.86,
  0.72, 0.72,
]);

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function regionIntegrity(a: Actor, region: Region) {
  const d = injurySum(a.injuries[region]);
  return 1 / (1 + d * 0.72);
}

function modeAuthority(mode: BodyMode) {
  if (mode === "follow") return 1;
  if (mode === "stumble") return 0.42;
  if (mode === "recover") return 0.7;
  return 0;
}

/**
 * Active articulated controller.
 *
 * Critical timing rule:
 * - explicit locomotion/action tasks become bounded velocity impulses BEFORE
 *   Verlet integration so their commanded velocity affects the current step;
 * - base posture stabilization runs after passive integration and prepares the
 *   next step without moving solved nodes directly.
 *
 * Contact and constraints remain authoritative in both cases.
 */
export class ActiveBodyControl {
  private readonly state: MechanicalState = makeMechanicalState();

  /**
   * Consume explicit task-space commands before PhysicalBodies integrates.
   * This fixes the old one-step actuation lag where an action impulse was stored
   * in previous-position state only after the current position had already been
   * advanced.
   */
  driveTasksPreIntegration(
    w: World,
    a: Actor,
    rig: BodyRig,
    dt: number,
    mode: BodyMode,
  ) {
    const modeGain = modeAuthority(mode);
    if (modeGain <= 0 || !a.alive) return;

    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;
    sampleMechanicalState(w, a, rig, h, this.state);

    const fatigueAuthority = clamp01(1 - a.fatigue * 0.62);
    const painAuthority = clamp01(1 - a.pain * 0.34);
    const consciousAuthority = 0.08 + this.state.consciousness * 0.92;
    const disturbanceAuthority = 1 / (1 + this.state.disturbance * 0.72);
    const balanceAuthority = 0.42 + clamp01(a.balance) * 0.58;
    const groundedAuthority =
      this.state.supportCount > 0
        ? 0.68 + this.state.supportScore * 0.32
        : mode === "follow"
          ? 0.58
          : 0.34;

    const global =
      modeGain *
      fatigueAuthority *
      painAuthority *
      consciousAuthority *
      disturbanceAuthority *
      balanceAuthority;

    const scale = bodyScale(a);
    const baseMaxDv =
      (mode === "recover" ? 5.2 : mode === "stumble" ? 3.0 : 7.2) * scale;

    for (let node = 0; node < BODY_NODE_COUNT; node++) {
      const taskPriority = bodyTaskTargets.priorityFor(a, node);
      if (taskPriority <= 0) continue;

      const taskWeight = bodyTaskTargets.weightFor(a, node);
      const region = NODE_REGION[node]!;
      const integrity = regionIntegrity(a, region);
      let authority = global * NODE_AUTHORITY[node]! * (0.22 + integrity * 0.78);

      if (
        node === BODY.pelvis ||
        node === BODY.chest ||
        node === BODY.lHip ||
        node === BODY.rHip ||
        node === BODY.lKnee ||
        node === BODY.rKnee ||
        node === BODY.lFoot ||
        node === BODY.rFoot
      ) {
        authority *= groundedAuthority;
      }

      if (
        (node === BODY.lFoot && this.state.leftSupported) ||
        (node === BODY.rFoot && this.state.rightSupported)
      ) {
        authority *= 0.58 + this.state.grip * 0.28;
      }

      let frequencyGain = 1;
      let maxDv = baseMaxDv;
      if (taskPriority >= TASK_PRIORITY.CONTACT_CRITICAL) {
        // A support foot/knee/hip is the physical foundation of the action. Give
        // it more bandwidth than the moving effector without making it rigid or
        // bypassing contact; world collision is still solved afterward.
        frequencyGain = 2.28;
        authority *= 1.42;
        maxDv *= 2.15;
      } else if (taskPriority >= TASK_PRIORITY.ACTION) {
        frequencyGain = 1.9 + taskWeight * 0.34;
        authority *= 1.24 + taskWeight * 0.24;
        maxDv *= 1.95;
      } else if (taskPriority >= TASK_PRIORITY.CORRECTIVE_STEP) {
        frequencyGain = 1.58;
        authority *= 1.2;
        maxDv *= 1.55;
      } else if (taskPriority >= TASK_PRIORITY.LOCOMOTION) {
        frequencyGain = 1.34;
        authority *= 1.12;
        maxDv *= 1.38;
      }

      authority = Math.min(1.42, authority);
      if (authority < 0.015) continue;

      const ex = bodyTaskTargets.targetXFor(a, node) - rig.x[node]!;
      const ey = bodyTaskTargets.targetYFor(a, node) - rig.y[node]!;
      const ez = bodyTaskTargets.targetZFor(a, node) - rig.z[node]!;
      const vx = nodeVelocityComponent(rig.x[node]!, rig.px[node]!, h);
      const vy = nodeVelocityComponent(rig.y[node]!, rig.py[node]!, h);
      const vz = nodeVelocityComponent(rig.z[node]!, rig.pz[node]!, h);

      const omega = OMEGA[node]! * frequencyGain;
      const kp = omega * omega;
      const kd = 2 * 0.88 * omega;
      let dvx = (kp * ex - kd * vx) * h * authority * taskWeight;
      let dvy = (kp * ey - kd * vy) * h * authority * taskWeight;
      let dvz = (kp * ez - kd * vz) * h * authority * taskWeight;

      const mag = Math.hypot(dvx, dvy, dvz);
      if (mag > maxDv) {
        const q = maxDv / mag;
        dvx *= q;
        dvy *= q;
        dvz *= q;
      }

      // Velocity-space impulse. PhysicalBodies integrates this immediately after
      // this call; no current node position is assigned or teleported here.
      rig.px[node] -= dvx * h;
      rig.py[node] -= dvy * h;
      rig.pz[node] -= dvz * h;
    }
  }

  /** Base posture stabilization after integration. Explicit task nodes were
   * already actuated pre-integration and are deliberately not double-driven. */
  drive(
    w: World,
    a: Actor,
    rig: BodyRig,
    dt: number,
    mode: BodyMode,
  ) {
    const modeGain = modeAuthority(mode);
    if (modeGain <= 0 || !a.alive) return;

    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;

    // Keep rig.tx/ty/tz coherent for recovery diagnostics and non-task nodes.
    bodyTaskTargets.apply(a, rig);
    sampleMechanicalState(w, a, rig, h, this.state);

    const fatigueAuthority = clamp01(1 - a.fatigue * 0.62);
    const painAuthority = clamp01(1 - a.pain * 0.34);
    const consciousAuthority = 0.08 + this.state.consciousness * 0.92;
    const disturbanceAuthority = 1 / (1 + this.state.disturbance * 0.72);
    const balanceAuthority = 0.42 + clamp01(a.balance) * 0.58;
    const groundedAuthority =
      this.state.supportCount > 0
        ? 0.68 + this.state.supportScore * 0.32
        : mode === "follow"
          ? 0.58
          : 0.34;

    const global =
      modeGain *
      fatigueAuthority *
      painAuthority *
      consciousAuthority *
      disturbanceAuthority *
      balanceAuthority;

    const scale = bodyScale(a);
    const maxDv =
      (mode === "recover" ? 5.2 : mode === "stumble" ? 3.0 : 7.2) * scale;

    for (let node = 0; node < BODY_NODE_COUNT; node++) {
      // Explicit locomotion/action targets were already integrated this step.
      if (bodyTaskTargets.priorityFor(a, node) > 0) continue;

      const region = NODE_REGION[node]!;
      const integrity = regionIntegrity(a, region);
      let authority = global * NODE_AUTHORITY[node]! * (0.22 + integrity * 0.78);

      if (
        node === BODY.pelvis ||
        node === BODY.chest ||
        node === BODY.lHip ||
        node === BODY.rHip ||
        node === BODY.lKnee ||
        node === BODY.rKnee ||
        node === BODY.lFoot ||
        node === BODY.rFoot
      ) {
        authority *= groundedAuthority;
      }

      if (
        (node === BODY.lFoot && this.state.leftSupported) ||
        (node === BODY.rFoot && this.state.rightSupported)
      ) {
        authority *= 0.58 + this.state.grip * 0.28;
      }

      authority = Math.min(1.25, authority);
      if (authority < 0.015) continue;

      const ex = rig.tx[node]! - rig.x[node]!;
      const ey = rig.ty[node]! - rig.y[node]!;
      const ez = rig.tz[node]! - rig.z[node]!;
      const vx = nodeVelocityComponent(rig.x[node]!, rig.px[node]!, h);
      const vy = nodeVelocityComponent(rig.y[node]!, rig.py[node]!, h);
      const vz = nodeVelocityComponent(rig.z[node]!, rig.pz[node]!, h);

      const omega = OMEGA[node]!;
      const kp = omega * omega;
      const kd = 2 * 0.9 * omega;
      let dvx = (kp * ex - kd * vx) * h * authority;
      let dvy = (kp * ey - kd * vy) * h * authority;
      let dvz = (kp * ez - kd * vz) * h * authority;

      const mag = Math.hypot(dvx, dvy, dvz);
      if (mag > maxDv) {
        const q = maxDv / mag;
        dvx *= q;
        dvy *= q;
        dvz *= q;
      }

      rig.px[node] -= dvx * h;
      rig.py[node] -= dvy * h;
      rig.pz[node] -= dvz * h;
    }
  }
}

export const activeBodyControl = new ActiveBodyControl();
