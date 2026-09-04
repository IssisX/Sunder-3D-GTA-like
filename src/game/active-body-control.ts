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
 * Desired body targets become bounded velocity corrections, not direct node
 * placement. Contact/constraints remain authoritative because the controller
 * only changes the Verlet velocity state (previous positions); collision and
 * joint solves run afterward and can reject the requested motion.
 */
export class ActiveBodyControl {
  private readonly state: MechanicalState = makeMechanicalState();

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

    // Base anatomical targets are produced by body-model. Locomotion/actions
    // may only alter that desired state through this pre-solve task buffer.
    bodyTaskTargets.apply(a, rig);
    sampleMechanicalState(w, a, rig, h, this.state);

    const fatigueAuthority = clamp01(1 - a.fatigue * 0.62);
    const painAuthority = clamp01(1 - a.pain * 0.34);
    const consciousAuthority = 0.08 + this.state.consciousness * 0.92;
    const disturbanceAuthority = 1 / (1 + this.state.disturbance * 0.72);
    const balanceAuthority = 0.42 + clamp01(a.balance) * 0.58;

    // Ordinary controlled stance must not enter a positive-feedback collapse
    // just because a foot briefly loses the support tolerance. Contact still
    // limits what the body can actually accomplish after actuation.
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
      const region = NODE_REGION[node]!;
      const integrity = regionIntegrity(a, region);
      const taskPriority = bodyTaskTargets.priorityFor(a, node);
      const taskWeight = bodyTaskTargets.weightFor(a, node);

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

      // The ground owns a planted foot. Motor authority remains finite there;
      // high-priority task requests cannot simply drag a contact through space.
      if (
        (node === BODY.lFoot && this.state.leftSupported) ||
        (node === BODY.rFoot && this.state.rightSupported)
      ) {
        authority *= 0.58 + this.state.grip * 0.28;
      }

      let frequencyGain = 1;
      let maxDv = baseMaxDv;
      if (taskPriority >= TASK_PRIORITY.ACTION) {
        // A punch/kick must move with athletic bandwidth rather than the same
        // low-gain posture servo used for idle hands. It is still bounded and
        // remains subordinate to contact/joint constraints.
        frequencyGain = 1.72 + taskWeight * 0.28;
        authority *= 1.18 + taskWeight * 0.22;
        maxDv *= 1.7;
      } else if (taskPriority >= TASK_PRIORITY.CORRECTIVE_STEP) {
        frequencyGain = 1.48;
        authority *= 1.18;
        maxDv *= 1.45;
      } else if (taskPriority >= TASK_PRIORITY.LOCOMOTION) {
        frequencyGain = 1.24;
        authority *= 1.08;
        maxDv *= 1.25;
      }

      authority = Math.min(1.25, authority);
      if (authority < 0.015) continue;

      const ex = rig.tx[node]! - rig.x[node]!;
      const ey = rig.ty[node]! - rig.y[node]!;
      const ez = rig.tz[node]! - rig.z[node]!;
      const vx = nodeVelocityComponent(rig.x[node]!, rig.px[node]!, h);
      const vy = nodeVelocityComponent(rig.y[node]!, rig.py[node]!, h);
      const vz = nodeVelocityComponent(rig.z[node]!, rig.pz[node]!, h);

      const omega = OMEGA[node]! * frequencyGain;
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

      // Velocity-space actuation. No solved node is teleported to its target.
      rig.px[node] -= dvx * h;
      rig.py[node] -= dvy * h;
      rig.pz[node] -= dvz * h;
    }
  }
}

export const activeBodyControl = new ActiveBodyControl();
