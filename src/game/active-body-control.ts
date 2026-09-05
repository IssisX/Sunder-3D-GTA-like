import type { Actor, Region } from "./types";
import type { World } from "./world";
import { injurySum } from "./world";
import {
  BODY,
  BODY_NODE_COUNT,
  NODE_INV_MASS,
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

const OMEGA = new Float32Array([
  21.0,
  22.0,
  16.0,
  18.0, 18.0,
  16.0, 16.0,
  15.0, 15.0,
  20.0, 20.0,
  18.0, 18.0,
  16.0, 16.0,
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
 * Explicit moving tasks are tracked as position + velocity targets before
 * integration. Static posture stabilization remains a conventional damped
 * position servo. Every internal motor pass is projected to zero net linear
 * momentum in all three axes; only support/contact/external impulses may move
 * the body's centre of mass.
 */
export class ActiveBodyControl {
  private readonly taskDvX = new Float32Array(BODY_NODE_COUNT);
  private readonly taskDvY = new Float32Array(BODY_NODE_COUNT);
  private readonly taskDvZ = new Float32Array(BODY_NODE_COUNT);
  private readonly state: MechanicalState = makeMechanicalState();

  private clearInternalDv() {
    this.taskDvX.fill(0);
    this.taskDvY.fill(0);
    this.taskDvZ.fill(0);
  }

  private applyInternalDv(rig: BodyRig, h: number) {
    let mass = 0;
    let momentumX = 0;
    let momentumY = 0;
    let momentumZ = 0;

    for (let node = 0; node < BODY_NODE_COUNT; node++) {
      const m = 1 / NODE_INV_MASS[node]!;
      mass += m;
      momentumX += this.taskDvX[node]! * m;
      momentumY += this.taskDvY[node]! * m;
      momentumZ += this.taskDvZ[node]! * m;
    }

    if (mass <= 0) return;
    const commonX = momentumX / mass;
    const commonY = momentumY / mass;
    const commonZ = momentumZ / mass;

    for (let node = 0; node < BODY_NODE_COUNT; node++) {
      rig.px[node] -= (this.taskDvX[node]! - commonX) * h;
      rig.py[node] -= (this.taskDvY[node]! - commonY) * h;
      rig.pz[node] -= (this.taskDvZ[node]! - commonZ) * h;
    }
  }

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

    this.clearInternalDv();
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
      let targetVelocityGain = 0.72;
      if (taskPriority >= TASK_PRIORITY.CONTACT_CRITICAL) {
        frequencyGain = 2.28;
        authority *= 1.42;
        maxDv *= 2.15;
        targetVelocityGain = 0.82;
      } else if (taskPriority >= TASK_PRIORITY.ACTION) {
        frequencyGain = 1.9 + taskWeight * 0.34;
        authority *= 1.24 + taskWeight * 0.24;
        maxDv *= 1.95;
        targetVelocityGain = 1;
      } else if (taskPriority >= TASK_PRIORITY.CORRECTIVE_STEP) {
        frequencyGain = 1.58;
        authority *= 1.2;
        maxDv *= 1.55;
        targetVelocityGain = 0.9;
      } else if (taskPriority >= TASK_PRIORITY.LOCOMOTION) {
        frequencyGain = 1.34;
        authority *= 1.12;
        maxDv *= 1.38;
        targetVelocityGain = 0.78;
      }

      authority = Math.min(1.42, authority);
      if (authority < 0.015) continue;

      const ex = bodyTaskTargets.targetXFor(a, node) - rig.x[node]!;
      const ey = bodyTaskTargets.targetYFor(a, node) - rig.y[node]!;
      const ez = bodyTaskTargets.targetZFor(a, node) - rig.z[node]!;
      const vx = nodeVelocityComponent(rig.x[node]!, rig.px[node]!, h);
      const vy = nodeVelocityComponent(rig.y[node]!, rig.py[node]!, h);
      const vz = nodeVelocityComponent(rig.z[node]!, rig.pz[node]!, h);
      const tvx = bodyTaskTargets.targetVxFor(a, node) * targetVelocityGain;
      const tvy = bodyTaskTargets.targetVyFor(a, node) * targetVelocityGain;
      const tvz = bodyTaskTargets.targetVzFor(a, node) * targetVelocityGain;

      const omega = OMEGA[node]! * frequencyGain;
      const kp = omega * omega;
      const kd = 2 * 0.88 * omega;

      let dvx = (kp * ex + kd * (tvx - vx)) * h * authority * taskWeight;
      let dvy = (kp * ey + kd * (tvy - vy)) * h * authority * taskWeight;
      let dvz = (kp * ez + kd * (tvz - vz)) * h * authority * taskWeight;

      const mag = Math.hypot(dvx, dvy, dvz);
      if (mag > maxDv) {
        const q = maxDv / mag;
        dvx *= q;
        dvy *= q;
        dvz *= q;
      }

      this.taskDvX[node] = dvx;
      this.taskDvY[node] = dvy;
      this.taskDvZ[node] = dvz;
    }

    this.applyInternalDv(rig, h);
  }

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

    this.clearInternalDv();
    for (let node = 0; node < BODY_NODE_COUNT; node++) {
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

      this.taskDvX[node] = dvx;
      this.taskDvY[node] = dvy;
      this.taskDvZ[node] = dvz;
    }

    this.applyInternalDv(rig, h);
  }
}

export const activeBodyControl = new ActiveBodyControl();
