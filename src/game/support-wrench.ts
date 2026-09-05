import type { Actor } from "./types";
import { GRAVITY } from "./types";
import type { World } from "./world";
import {
  BODY,
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

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Friction-limited vertical-axis support wrench.
 *
 * Translational support reaction already drives COM motion. This companion
 * controller turns desired stance/body orientation into a physically bounded
 * yaw couple while real feet are supported. It does not set orientation or
 * move solved nodes directly.
 */
export class SupportWrenchController {
  private readonly state: MechanicalState = makeMechanicalState();

  drive(
    w: World,
    a: Actor,
    rig: BodyRig,
    dt: number,
    mode: BodyMode,
  ) {
    if (!a.alive || mode === "dynamic" || a.grabbedBy) return;
    if (a.loco === "swim" || a.loco === "climb" || a.loco === "vault") return;

    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;
    sampleMechanicalState(w, a, rig, h, this.state);
    if (this.state.supportCount <= 0) return;

    const scale = bodyScale(a);
    const lx = rig.x[BODY.lHip]!;
    const lz = rig.z[BODY.lHip]!;
    const rx = rig.x[BODY.rHip]!;
    const rz = rig.z[BODY.rHip]!;
    let hx = rx - lx;
    let hz = rz - lz;
    const h2 = hx * hx + hz * hz;
    if (h2 < 1e-7) return;
    const hm = Math.sqrt(h2);
    hx /= hm;
    hz /= hm;

    // Action/locomotion tasks may request a hip-axis orientation. If they do
    // not, the semantic Actor heading supplies the desired right axis.
    let dx: number;
    let dz: number;
    if (
      bodyTaskTargets.priorityFor(a, BODY.lHip) >= TASK_PRIORITY.LOCOMOTION &&
      bodyTaskTargets.priorityFor(a, BODY.rHip) >= TASK_PRIORITY.LOCOMOTION
    ) {
      dx = bodyTaskTargets.targetXFor(a, BODY.rHip) - bodyTaskTargets.targetXFor(a, BODY.lHip);
      dz = bodyTaskTargets.targetZFor(a, BODY.rHip) - bodyTaskTargets.targetZFor(a, BODY.lHip);
      const dm = Math.hypot(dx, dz);
      if (dm > 1e-6) {
        dx /= dm;
        dz /= dm;
      } else {
        dx = Math.cos(a.yaw);
        dz = -Math.sin(a.yaw);
      }
    } else {
      dx = Math.cos(a.yaw);
      dz = -Math.sin(a.yaw);
    }

    const cross = hx * dz - hz * dx;
    const dot = clamp(hx * dx + hz * dz, -1, 1);
    const angleError = Math.atan2(cross, dot);

    const lvx = nodeVelocityComponent(rig.x[BODY.lHip]!, rig.px[BODY.lHip]!, h);
    const lvz = nodeVelocityComponent(rig.z[BODY.lHip]!, rig.pz[BODY.lHip]!, h);
    const rvx = nodeVelocityComponent(rig.x[BODY.rHip]!, rig.px[BODY.rHip]!, h);
    const rvz = nodeVelocityComponent(rig.z[BODY.rHip]!, rig.pz[BODY.rHip]!, h);
    const relVx = rvx - lvx;
    const relVz = rvz - lvz;
    const yawRate = ((rx - lx) * relVz - (rz - lz) * relVx) / Math.max(1e-5, h2);

    const action =
      bodyTaskTargets.priorityFor(a, BODY.lHip) >= TASK_PRIORITY.ACTION ||
      bodyTaskTargets.priorityFor(a, BODY.rHip) >= TASK_PRIORITY.ACTION;
    const kp = action ? 34 : 22;
    const kd = action ? 6.8 : 5.4;
    let alpha = kp * angleError - kd * yawRate;

    // Coulomb-like support limit: tangential ground reaction cannot exceed
    // available grip. One-foot support and damaged legs lower the yaw envelope.
    const supportFactor = this.state.supportCount >= 2 ? 1 : 0.68;
    const halfStance = Math.max(0.12 * scale, hm * 0.5);
    const frictionAccel = GRAVITY * (0.55 + this.state.grip * 1.25);
    const alphaLimit =
      Math.min(34, frictionAccel / halfStance) *
      supportFactor *
      this.state.legIntegrity *
      (0.45 + this.state.consciousness * 0.55) *
      (mode === "stumble" ? 0.48 : mode === "recover" ? 0.72 : 1);
    alpha = clamp(alpha, -alphaLimit, alphaLimit);

    const dOmega = alpha * h;
    const cx = (lx + rx) * 0.5;
    const cz = (lz + rz) * 0.5;

    // v = omega x r. Opposing tangential velocities create a yaw couple with
    // essentially zero net translation; planted-foot/contact constraints provide
    // the external reaction that makes the rotation mechanically legitimate.
    this.applyYawVelocity(rig, BODY.lHip, cx, cz, dOmega, h, 1);
    this.applyYawVelocity(rig, BODY.rHip, cx, cz, dOmega, h, 1);
    this.applyYawVelocity(rig, BODY.lShoulder, cx, cz, dOmega, h, 0.42);
    this.applyYawVelocity(rig, BODY.rShoulder, cx, cz, dOmega, h, 0.42);
    this.applyYawVelocity(rig, BODY.chest, cx, cz, dOmega, h, 0.24);
  }

  private applyYawVelocity(
    rig: BodyRig,
    node: number,
    cx: number,
    cz: number,
    dOmega: number,
    dt: number,
    weight: number,
  ) {
    const ox = rig.x[node]! - cx;
    const oz = rig.z[node]! - cz;
    const dvx = -dOmega * oz * weight;
    const dvz = dOmega * ox * weight;
    rig.px[node] -= dvx * dt;
    rig.pz[node] -= dvz * dt;
  }
}

export const supportWrench = new SupportWrenchController();
