import type { Actor } from "./types";
import type { World } from "./world";
import {
  BODY,
  bodyScale,
  nodeVelocityComponent,
  type BodyRig,
} from "./body-model";
import {
  makeMechanicalState,
  sampleMechanicalState,
  type MechanicalState,
} from "./mechanical-state";
import { bodyTaskTargets, TASK_PRIORITY } from "./body-task-targets";

const ENTITY_ID_CAP = 8192;
const BODY_CAP = 128;
const MIN_DT = 1 / 240;
const MAX_DT = 1 / 30;
const HAND = 1;
const FOOT = 2;

export const EDGES = {
  kineticFightSwing: true,
};

interface BodyAccess {
  get(a: Actor): BodyRig | undefined;
}

function human(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Support-relative whole-body action swing.
 *
 * The specialist melee solver still owns the fist/foot/weapon carrier and the
 * contact solver still owns what actually lands. This layer reads that live
 * carrier request together with solved support, COM motion, grip and impact
 * disturbance, then turns the EXISTING stance around its real support. It does
 * not author a combat stance and never moves solved nodes directly.
 *
 * One mechanical truth therefore reaches several existing consumers:
 *  - ActiveBodyControl turns the larger task arc into achieved body motion;
 *  - SupportWrench converts the rotated hip axis into friction-limited yaw;
 *  - ActionContinuity captures the resulting terminal geometry and bridges it
 *    into recovery / the next movement instead of snapping to neutral;
 *  - ReactiveBalance sees the same changed action geometry and recruits free
 *    limbs / support without stealing the carrier.
 */
export class KineticFightFlow {
  private readonly slotById = new Int16Array(ENTITY_ID_CAP);
  private readonly swing = new Float32Array(BODY_CAP);
  private readonly side = new Int8Array(BODY_CAP);
  private readonly carrierClass = new Uint8Array(BODY_CAP);
  private readonly state: MechanicalState = makeMechanicalState();
  private slotCount = 0;

  private candidateNode = -1;
  private candidateClass = 0;
  private candidateSide = 0;
  private candidateDistance = 0;
  private candidateSpeed = 0;

  constructor(private readonly bodies: BodyAccess) {
    this.slotById.fill(-1);
  }

  bootstrap(w: World) {
    this.clear();
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (human(a)) this.register(a);
    }
  }

  clear() {
    this.slotById.fill(-1);
    this.swing.fill(0);
    this.side.fill(0);
    this.carrierClass.fill(0);
    this.slotCount = 0;
  }

  reset(a: Actor) {
    const slot = this.slot(a.id);
    if (slot < 0) return;
    this.swing[slot] = 0;
    this.side[slot] = 0;
    this.carrierClass[slot] = 0;
  }

  prepare(w: World, dt: number) {
    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;

    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a) || !a.alive || a.grabbedBy) continue;
      let slot = this.slot(a.id);
      if (slot < 0) slot = this.register(a);
      if (slot < 0) continue;
      const rig = this.bodies.get(a);
      if (!rig?.initialized || rig.mode === "dynamic" || rig.mode === "recover") {
        this.swing[slot] *= Math.exp(-h * 16);
        continue;
      }

      sampleMechanicalState(w, a, rig, h, this.state);
      this.findCarrier(a, rig, h);

      let targetSwing = 0;
      if (this.candidateNode >= 0) {
        const scale = bodyScale(a);
        const foot = this.candidateClass === FOOT;
        const reach = clamp01(
          this.candidateDistance / ((foot ? 0.56 : 0.46) * scale),
        );
        const carrierVelocity = clamp01(
          this.candidateSpeed / (foot ? 8.2 : 8.8),
        );
        const bodySpeed = clamp01(
          Math.hypot(this.state.velX, this.state.velZ) / 6.2,
        );
        const disturbance = clamp01(this.state.disturbance / 0.9);
        targetSwing = clamp01(
          reach * 0.68 +
          carrierVelocity * 0.22 +
          bodySpeed * 0.12 +
          disturbance * 0.08,
        );
        this.side[slot] = this.candidateSide;
        this.carrierClass[slot] = this.candidateClass;
      } else {
        const angular = clamp01(
          Math.abs(this.state.angularY) / Math.max(1, a.mass * 0.18),
        );
        const disturbance = clamp01(this.state.disturbance / 0.85);
        targetSwing = Math.max(angular * 0.72, disturbance * 0.34);
        if (Math.abs(this.state.angularY) > a.mass * 0.015) {
          this.side[slot] = this.state.angularY > 0 ? 1 : -1;
        }
      }

      if (!EDGES.kineticFightSwing) targetSwing = 0;
      const previous = this.swing[slot]!;
      const rate = targetSwing > previous ? 31 : this.candidateNode >= 0 ? 18 : 8.5;
      const blend = 1 - Math.exp(-h * rate);
      const swing = previous + (targetSwing - previous) * blend;
      this.swing[slot] = swing;
      if (swing < 0.025 || !this.side[slot]) continue;

      this.applySwing(a, rig, slot, swing);
    }
  }

  private findCarrier(a: Actor, rig: BodyRig, dt: number) {
    this.candidateNode = -1;
    this.candidateClass = 0;
    this.candidateSide = 0;
    this.candidateDistance = 0;
    this.candidateSpeed = 0;
    const scale = bodyScale(a);

    for (const node of [BODY.lHand, BODY.rHand, BODY.lFoot, BODY.rFoot]) {
      const priority = bodyTaskTargets.priorityFor(a, node);
      if (priority < TASK_PRIORITY.ACTION) continue;
      const isFoot = node === BODY.lFoot || node === BODY.rFoot;
      if (isFoot && priority >= TASK_PRIORITY.CONTACT_CRITICAL) continue;
      const distance = Math.hypot(
        bodyTaskTargets.targetXFor(a, node) - rig.x[node]!,
        bodyTaskTargets.targetYFor(a, node) - rig.y[node]!,
        bodyTaskTargets.targetZFor(a, node) - rig.z[node]!,
      );
      const normalized = distance / ((isFoot ? 0.54 : 0.42) * scale);
      if (normalized <= this.candidateDistance) continue;
      const vx = nodeVelocityComponent(rig.x[node]!, rig.px[node]!, dt);
      const vy = nodeVelocityComponent(rig.y[node]!, rig.py[node]!, dt);
      const vz = nodeVelocityComponent(rig.z[node]!, rig.pz[node]!, dt);
      this.candidateNode = node;
      this.candidateClass = isFoot ? FOOT : HAND;
      this.candidateSide = node === BODY.rHand || node === BODY.rFoot ? 1 : -1;
      this.candidateDistance = normalized;
      this.candidateSpeed = Math.hypot(vx, vy, vz);
    }

    if (this.candidateNode >= 0) {
      this.candidateDistance *=
        this.candidateClass === FOOT ? 0.54 * scale : 0.42 * scale;
    }
  }

  private applySwing(a: Actor, rig: BodyRig, slot: number, swing: number) {
    const side = this.side[slot]!;
    const carrierClass = this.carrierClass[slot]!;
    const scale = bodyScale(a);
    const control =
      (0.58 + this.state.legIntegrity * 0.42) *
      (0.52 + this.state.consciousness * 0.48);
    const grip = this.state.supportCount > 0
      ? 0.58 + this.state.grip * 0.42
      : 0.32;
    const motion = 1 + clamp01(
      Math.hypot(this.state.velX, this.state.velZ) / 6.4,
    ) * 0.18;
    const drive = swing * control * grip * motion;
    if (drive < 0.02) return;

    const weapon = carrierClass === HAND && a.weapon !== "fist";
    const hipAmplitude = carrierClass === FOOT
      ? 0.24
      : weapon ? 0.74 : 0.62;
    const shoulderAmplitude = carrierClass === FOOT
      ? 0.32
      : weapon ? 1.04 : 0.9;
    const hipTheta = -side * hipAmplitude * drive;
    const shoulderTheta = -side * shoulderAmplitude * drive;

    let pivotX = rig.x[BODY.pelvis]!;
    let pivotZ = rig.z[BODY.pelvis]!;
    let supportCount = 0;
    if (this.state.leftSupported) {
      pivotX += rig.x[BODY.lFoot]!;
      pivotZ += rig.z[BODY.lFoot]!;
      supportCount++;
    }
    if (this.state.rightSupported) {
      pivotX += rig.x[BODY.rFoot]!;
      pivotZ += rig.z[BODY.rFoot]!;
      supportCount++;
    }
    if (supportCount > 0) {
      pivotX = (pivotX - rig.x[BODY.pelvis]!) / supportCount;
      pivotZ = (pivotZ - rig.z[BODY.pelvis]!) / supportCount;
    } else {
      pivotX = rig.x[BODY.pelvis]!;
      pivotZ = rig.z[BODY.pelvis]!;
    }

    if (bodyTaskTargets.priorityFor(a, BODY.pelvis) >= TASK_PRIORITY.LOCOMOTION) {
      const px = bodyTaskTargets.targetXFor(a, BODY.pelvis);
      const py = bodyTaskTargets.targetYFor(a, BODY.pelvis);
      const pz = bodyTaskTargets.targetZFor(a, BODY.pelvis);
      const theta = hipTheta * 0.34;
      const ox = px - pivotX;
      const oz = pz - pivotZ;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      const rotatedX = ox * c - oz * s;
      const rotatedZ = ox * s + oz * c;
      const sideX = Math.cos(a.yaw) * side;
      const sideZ = -Math.sin(a.yaw) * side;
      bodyTaskTargets.offerWorld(
        a,
        BODY.pelvis,
        pivotX + rotatedX + sideX * 0.05 * drive * scale,
        py - 0.018 * drive * scale,
        pivotZ + rotatedZ + sideZ * 0.05 * drive * scale,
        1,
        TASK_PRIORITY.ACTION,
      );
    }

    this.rotatePair(a, BODY.lHip, BODY.rHip, hipTheta);
    this.rotatePair(a, BODY.lShoulder, BODY.rShoulder, shoulderTheta);

    if (bodyTaskTargets.priorityFor(a, BODY.chest) >= TASK_PRIORITY.LOCOMOTION) {
      const cx = bodyTaskTargets.targetXFor(a, BODY.chest);
      const cy = bodyTaskTargets.targetYFor(a, BODY.chest);
      const cz = bodyTaskTargets.targetZFor(a, BODY.chest);
      const fx = -Math.sin(a.yaw);
      const fz = -Math.cos(a.yaw);
      const rx = Math.cos(a.yaw);
      const rz = -Math.sin(a.yaw);
      const lateral = side * (carrierClass === FOOT ? 0.028 : 0.05) * drive * scale;
      const surge = (carrierClass === FOOT ? 0.018 : 0.045) * drive * scale;
      bodyTaskTargets.offerWorld(
        a,
        BODY.chest,
        cx + rx * lateral + fx * surge,
        cy + (carrierClass === FOOT ? 0.01 : 0.022) * drive * scale,
        cz + rz * lateral + fz * surge,
        1,
        TASK_PRIORITY.ACTION,
      );
    }

    if (carrierClass === HAND) {
      if (this.state.leftSupported) this.compressSupportedKnee(a, BODY.lKnee, drive, scale);
      if (this.state.rightSupported) this.compressSupportedKnee(a, BODY.rKnee, drive, scale);
    }
  }

  private rotatePair(a: Actor, left: number, right: number, theta: number) {
    const lp = bodyTaskTargets.priorityFor(a, left);
    const rp = bodyTaskTargets.priorityFor(a, right);
    if (lp < TASK_PRIORITY.LOCOMOTION || rp < TASK_PRIORITY.LOCOMOTION) return;
    const lx = bodyTaskTargets.targetXFor(a, left);
    const ly = bodyTaskTargets.targetYFor(a, left);
    const lz = bodyTaskTargets.targetZFor(a, left);
    const rx = bodyTaskTargets.targetXFor(a, right);
    const ry = bodyTaskTargets.targetYFor(a, right);
    const rz = bodyTaskTargets.targetZFor(a, right);
    const cx = (lx + rx) * 0.5;
    const cy = (ly + ry) * 0.5;
    const cz = (lz + rz) * 0.5;
    const hx = (rx - lx) * 0.5;
    const hy = (ry - ly) * 0.5;
    const hz = (rz - lz) * 0.5;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const tx = hx * c - hz * s;
    const tz = hx * s + hz * c;
    bodyTaskTargets.offerWorld(
      a, left,
      cx - tx, cy - hy, cz - tz,
      1, TASK_PRIORITY.ACTION,
    );
    bodyTaskTargets.offerWorld(
      a, right,
      cx + tx, cy + hy, cz + tz,
      1, TASK_PRIORITY.ACTION,
    );
  }

  private compressSupportedKnee(
    a: Actor,
    knee: number,
    drive: number,
    scale: number,
  ) {
    const priority = bodyTaskTargets.priorityFor(a, knee);
    if (priority < TASK_PRIORITY.LOCOMOTION) return;
    bodyTaskTargets.offerWorld(
      a,
      knee,
      bodyTaskTargets.targetXFor(a, knee),
      bodyTaskTargets.targetYFor(a, knee) - 0.04 * drive * scale,
      bodyTaskTargets.targetZFor(a, knee),
      1,
      TASK_PRIORITY.ACTION,
    );
  }

  private register(a: Actor) {
    if (a.id < 0 || a.id >= ENTITY_ID_CAP || this.slotCount >= BODY_CAP) return -1;
    const existing = this.slotById[a.id]!;
    if (existing >= 0) return existing;
    const slot = this.slotCount++;
    this.slotById[a.id] = slot;
    return slot;
  }

  private slot(id: number) {
    return id < 0 || id >= ENTITY_ID_CAP ? -1 : this.slotById[id]!;
  }
}
