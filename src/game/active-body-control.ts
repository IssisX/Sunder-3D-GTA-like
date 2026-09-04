import type { Actor, Region } from "./types";
import type { World } from "./world";
import { clamp, injurySum } from "./world";
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

const MIN_DT = 1 / 240;
const MAX_DT = 1 / 30;

// Natural-frequency hierarchy. Core posture gets the most authority; distal
// limbs remain more compliant so contacts and disturbances can visibly win.
const OMEGA = new Float32Array([
  17.5, // pelvis
  18.5, // chest
  13.5, // head
  16.0, 16.0, // shoulders
  13.5, 13.5, // elbows
  11.5, 11.5, // hands
  17.0, 17.0, // hips
  14.5, 14.5, // knees
  11.0, 11.0, // feet
]);

const NODE_AUTHORITY = new Float32Array([
  1.0,
  1.0,
  0.56,
  0.82, 0.82,
  0.68, 0.68,
  0.5, 0.5,
  0.92, 0.92,
  0.76, 0.76,
  0.48, 0.48,
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
    sampleMechanicalState(w, a, rig, h, this.state);

    const fatigueAuthority = clamp01(1 - a.fatigue * 0.62);
    const painAuthority = clamp01(1 - a.pain * 0.34);
    const consciousAuthority = 0.08 + this.state.consciousness * 0.92;
    const disturbanceAuthority = 1 / (1 + this.state.disturbance * 0.72);
    const balanceAuthority = 0.38 + clamp01(a.balance) * 0.62;

    // Support is required for strong whole-body posture actuation. Airborne or
    // slipping bodies retain orientation control but cannot invent propulsion.
    const groundedAuthority =
      this.state.supportCount > 0
        ? 0.42 + this.state.supportScore * 0.58
        : 0.28;

    const global =
      modeGain *
      fatigueAuthority *
      painAuthority *
      consciousAuthority *
      disturbanceAuthority *
      balanceAuthority;

    const scale = bodyScale(a);
    const maxDv = (mode === "recover" ? 4.2 : mode === "stumble" ? 2.4 : 5.4) * scale;

    for (let node = 0; node < BODY_NODE_COUNT; node++) {
      const region = NODE_REGION[node]!;
      const integrity = regionIntegrity(a, region);
      let authority = global * NODE_AUTHORITY[node]! * (0.22 + integrity * 0.78);

      // Legs and core depend strongly on actual support. Arms/head can still
      // orient in air, but never create root momentum by themselves.
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

      // A planted foot is a contact constraint first and a pose target second.
      // Keep the motor compliant there so the ground, friction and joint chain
      // determine what motion is actually feasible.
      if (
        (node === BODY.lFoot && this.state.leftSupported) ||
        (node === BODY.rFoot && this.state.rightSupported)
      ) {
        authority *= 0.46 + this.state.grip * 0.28;
      }

      if (authority < 0.015) continue;

      const ex = rig.tx[node]! - rig.x[node]!;
      const ey = rig.ty[node]! - rig.y[node]!;
      const ez = rig.tz[node]! - rig.z[node]!;
      const vx = nodeVelocityComponent(rig.x[node]!, rig.px[node]!, h);
      const vy = nodeVelocityComponent(rig.y[node]!, rig.py[node]!, h);
      const vz = nodeVelocityComponent(rig.z[node]!, rig.pz[node]!, h);

      const omega = OMEGA[node]!;
      const kp = omega * omega;
      const kd = 2 * 0.88 * omega;
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

      // Velocity-space actuation. This is the critical distinction from the old
      // followPose()/pinNode path: no node is teleported toward its target.
      rig.px[node] -= dvx * h;
      rig.py[node] -= dvy * h;
      rig.pz[node] -= dvz * h;
    }
  }
}

export const activeBodyControl = new ActiveBodyControl();
