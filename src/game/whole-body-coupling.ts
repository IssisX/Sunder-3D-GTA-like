import type { Actor } from "./types";
import type { World } from "./world";
import { BODY, type PhysicalBodies } from "./body";
import { bodyScale, type BodyRig } from "./body-model";
import { bodyTaskTargets, TASK_PRIORITY } from "./body-task-targets";
import { footSupported } from "./action-support";

const ENTITY_ID_CAP = 8192;
const BODY_CAP = 128;
const NONE = 0;
const PUNCH = 1;
const KICK = 2;

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function human(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

/**
 * Couples end-effector action requests back into support and COM tasks.
 * All outputs remain task-space requests consumed by the active controller.
 */
export class WholeBodyCoupling {
  private readonly slotById = new Int16Array(ENTITY_ID_CAP);
  private readonly kind = new Uint8Array(BODY_CAP);
  private readonly supportMask = new Uint8Array(BODY_CAP);
  private readonly lFootX = new Float32Array(BODY_CAP);
  private readonly lFootY = new Float32Array(BODY_CAP);
  private readonly lFootZ = new Float32Array(BODY_CAP);
  private readonly rFootX = new Float32Array(BODY_CAP);
  private readonly rFootY = new Float32Array(BODY_CAP);
  private readonly rFootZ = new Float32Array(BODY_CAP);
  private slotCount = 0;

  constructor(private readonly bodies: PhysicalBodies) {
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
    this.kind.fill(0);
    this.supportMask.fill(0);
    this.slotCount = 0;
  }

  reset(a: Actor) {
    const slot = this.slot(a.id);
    if (slot >= 0) {
      this.kind[slot] = NONE;
      this.supportMask[slot] = 0;
    }
  }

  prepare(w: World) {
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a) || !a.alive) continue;
      let slot = this.slot(a.id);
      if (slot < 0) slot = this.register(a);
      if (slot < 0) continue;
      const rig = this.bodies.get(a);
      if (!rig?.initialized || rig.mode !== "follow") {
        this.kind[slot] = NONE;
        this.supportMask[slot] = 0;
        continue;
      }

      const scale = bodyScale(a);
      const lFootD = this.taskDistance(a, rig, BODY.lFoot, TASK_PRIORITY.ACTION);
      const rFootD = this.taskDistance(a, rig, BODY.rFoot, TASK_PRIORITY.ACTION);
      const lHandD = this.taskDistance(a, rig, BODY.lHand, TASK_PRIORITY.ACTION);
      const rHandD = this.taskDistance(a, rig, BODY.rHand, TASK_PRIORITY.ACTION);

      let detected = NONE;
      if (bodyTaskTargets.priorityFor(a, BODY.lFoot)
          >= TASK_PRIORITY.ACTION ||
          bodyTaskTargets.priorityFor(a, BODY.rFoot)
          >= TASK_PRIORITY.ACTION) detected = KICK;
      else if (a.weapon === "fist" && Math.max(lHandD, rHandD) > 0.05 * scale) detected = PUNCH;

      if (detected !== this.kind[slot]!) {
        this.kind[slot] = detected;
        this.supportMask[slot] = 0;
        if (detected !== NONE) {
          this.captureFeet(rig, slot);
          if (footSupported(w, a, rig, BODY.lFoot)) this.supportMask[slot] |= 1;
          if (footSupported(w, a, rig, BODY.rFoot)) this.supportMask[slot] |= 2;
        }
      }

      if (detected === PUNCH) {
        this.couplePunch(a, rig, slot, lHandD, rHandD);
      } else if (detected === KICK) {
        this.coupleKick(a, rig, slot, lFootD, rFootD);
      }
    }
  }

  private couplePunch(
    a: Actor,
    rig: BodyRig,
    slot: number,
    lHandD: number,
    rHandD: number,
  ) {
    const scale = bodyScale(a);
    const right = rHandD > lHandD;
    const jab = !right;
    const reach = Math.max(lHandD, rHandD);
    const drive = clamp01(reach / (0.56 * scale));
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    const mask = this.supportMask[slot]!;

    // Preserve the stance that physically existed at action entry. A supported
    // foot may brace exactly where it already was; an unsupported/swinging foot
    // is not pulled into an authored boxing layout and remains available to the
    // incoming locomotion step carried by ActionContinuity.
    if (mask & 1) {
      bodyTaskTargets.offerWorld(
        a,
        BODY.lFoot,
        this.lFootX[slot]!,
        this.lFootY[slot]!,
        this.lFootZ[slot]!,
        1,
        TASK_PRIORITY.CONTACT_CRITICAL,
      );
    }
    if (mask & 2) {
      bodyTaskTargets.offerWorld(
        a,
        BODY.rFoot,
        this.rFootX[slot]!,
        this.rFootY[slot]!,
        this.rFootZ[slot]!,
        1,
        TASK_PRIORITY.CONTACT_CRITICAL,
      );
    }

    const pelvisX = bodyTaskTargets.targetXFor(a, BODY.pelvis);
    const pelvisY = bodyTaskTargets.targetYFor(a, BODY.pelvis);
    const pelvisZ = bodyTaskTargets.targetZFor(a, BODY.pelvis);

    let supportX = rig.x[BODY.pelvis]!;
    let supportZ = rig.z[BODY.pelvis]!;
    let supportCount = 0;
    if (mask & 1) {
      supportX += this.lFootX[slot]!;
      supportZ += this.lFootZ[slot]!;
      supportCount++;
    }
    if (mask & 2) {
      supportX += this.rFootX[slot]!;
      supportZ += this.rFootZ[slot]!;
      supportCount++;
    }
    if (supportCount > 0) {
      supportX = (supportX - rig.x[BODY.pelvis]!) / supportCount;
      supportZ = (supportZ - rig.z[BODY.pelvis]!) / supportCount;
    } else {
      supportX = rig.x[BODY.pelvis]!;
      supportZ = rig.z[BODY.pelvis]!;
    }

    const toSupportX = supportX - rig.x[BODY.pelvis]!;
    const toSupportZ = supportZ - rig.z[BODY.pelvis]!;
    const transfer = (jab ? 0.13 : 0.24) * drive;
    const surge = (jab ? 0.052 : 0.105) * drive * scale;
    bodyTaskTargets.offerWorld(
      a,
      BODY.pelvis,
      pelvisX + toSupportX * transfer + fx * surge,
      pelvisY - (jab ? 0.016 : 0.032) * drive * scale,
      pelvisZ + toSupportZ * transfer + fz * surge,
      1,
      TASK_PRIORITY.ACTION,
    );

    const chestX = bodyTaskTargets.targetXFor(a, BODY.chest);
    const chestY = bodyTaskTargets.targetYFor(a, BODY.chest);
    const chestZ = bodyTaskTargets.targetZFor(a, BODY.chest);
    bodyTaskTargets.offerWorld(
      a,
      BODY.chest,
      chestX + toSupportX * transfer * 0.55 + fx * surge * 0.9,
      chestY,
      chestZ + toSupportZ * transfer * 0.55 + fz * surge * 0.9,
      1,
      TASK_PRIORITY.ACTION,
    );

    // Recruit whichever leg is actually behind the pelvis in the current
    // stance. If only one foot is supporting, that real support leg wins.
    const lForward =
      (this.lFootX[slot]! - rig.x[BODY.pelvis]!) * fx +
      (this.lFootZ[slot]! - rig.z[BODY.pelvis]!) * fz;
    const rForward =
      (this.rFootX[slot]! - rig.x[BODY.pelvis]!) * fx +
      (this.rFootZ[slot]! - rig.z[BODY.pelvis]!) * fz;
    let driveLeft = lForward < rForward;
    if (mask === 1) driveLeft = true;
    else if (mask === 2) driveLeft = false;
    const driveKnee = driveLeft ? BODY.lKnee : BODY.rKnee;
    if (bodyTaskTargets.priorityFor(a, driveKnee) >= TASK_PRIORITY.ACTION) {
      bodyTaskTargets.offerWorld(
        a,
        driveKnee,
        bodyTaskTargets.targetXFor(a, driveKnee),
        bodyTaskTargets.targetYFor(a, driveKnee)
          - (jab ? 0.022 : 0.062) * drive * scale,
        bodyTaskTargets.targetZFor(a, driveKnee),
        1,
        TASK_PRIORITY.ACTION,
      );
    }
  }

  private coupleKick(
    a: Actor,
    rig: BodyRig,
    slot: number,
    lFootD: number,
    rFootD: number,
  ) {
    const scale = bodyScale(a);
    const attackLeft = bodyTaskTargets.targetYFor(a, BODY.lFoot)
      > bodyTaskTargets.targetYFor(a, BODY.rFoot);
    const side = attackLeft ? -1 : 1;
    const attackFoot = attackLeft ? BODY.lFoot : BODY.rFoot;
    const attackKnee = attackLeft ? BODY.lKnee : BODY.rKnee;
    const attackHip = attackLeft ? BODY.lHip : BODY.rHip;
    const supportFoot = attackLeft ? BODY.rFoot : BODY.lFoot;
    const supportKnee = attackLeft ? BODY.rKnee : BODY.lKnee;
    const supportHip = attackLeft ? BODY.rHip : BODY.lHip;
    const supportX = attackLeft ? this.rFootX[slot]! : this.lFootX[slot]!;
    const supportY = attackLeft ? this.rFootY[slot]! : this.lFootY[slot]!;
    const supportZ = attackLeft ? this.rFootZ[slot]! : this.lFootZ[slot]!;
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    const rx = Math.cos(a.yaw);
    const rz = -Math.sin(a.yaw);

    const rawFootX = bodyTaskTargets.targetXFor(a, attackFoot);
    const rawFootY = bodyTaskTargets.targetYFor(a, attackFoot);
    const rawFootZ = bodyTaskTargets.targetZFor(a, attackFoot);
    const rawForward =
      (rawFootX - rig.x[attackHip]!) * fx +
      (rawFootZ - rig.z[attackHip]!) * fz;
    const flight = clamp01((rawFootY - supportY - 0.08 * scale) / (0.46 * scale));
    const extension = clamp01((rawForward - 0.12 * scale) / (0.74 * scale));
    const chamber = clamp01(flight * (1 - extension * 0.72));
    const turn = clamp01(chamber * 0.78 + extension);

    bodyTaskTargets.offerWorld(
      a,
      supportFoot,
      supportX,
      supportY,
      supportZ,
      1,
      TASK_PRIORITY.CONTACT_CRITICAL,
    );

    const basePelvisX = bodyTaskTargets.targetXFor(a, BODY.pelvis);
    const basePelvisY = bodyTaskTargets.targetYFor(a, BODY.pelvis);
    const basePelvisZ = bodyTaskTargets.targetZFor(a, BODY.pelvis);
    const toSupportX = supportX - rig.x[BODY.pelvis]!;
    const toSupportZ = supportZ - rig.z[BODY.pelvis]!;
    const supportShift = 0.48 + flight * 0.26;
    const lateralBrace = -side * (0.09 + flight * 0.08) * scale;
    const pelvisX = basePelvisX + toSupportX * supportShift + rx * lateralBrace;
    const pelvisY = basePelvisY - flight * 0.055 * scale;
    const pelvisZ = basePelvisZ + toSupportZ * supportShift + rz * lateralBrace;
    bodyTaskTargets.offerWorld(
      a,
      BODY.pelvis,
      pelvisX,
      pelvisY,
      pelvisZ,
      1,
      TASK_PRIORITY.ACTION,
    );

    const theta = side * turn * 1.48;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const hipRightX = rx * c + fx * s;
    const hipRightZ = rz * c + fz * s;

    const shoulderTheta = theta * 0.94;
    const cs = Math.cos(shoulderTheta);
    const ss = Math.sin(shoulderTheta);
    const shoulderRightX = rx * cs + fx * ss;
    const shoulderRightZ = rz * cs + fz * ss;

    const supportHipSide = -side * 0.14 * scale;
    const attackHipSide = side * 0.14 * scale;
    const supportHipX = pelvisX + hipRightX * supportHipSide;
    const supportHipY = pelvisY - 0.065 * scale;
    const supportHipZ = pelvisZ + hipRightZ * supportHipSide;
    const attackHipX = pelvisX + hipRightX * attackHipSide;
    const attackHipY = pelvisY - 0.045 * scale + flight * 0.035 * scale;
    const attackHipZ = pelvisZ + hipRightZ * attackHipSide;

    bodyTaskTargets.offerWorld(a, supportHip, supportHipX, supportHipY, supportHipZ, 1, TASK_PRIORITY.CONTACT_CRITICAL);
    bodyTaskTargets.offerWorld(a, attackHip, attackHipX, attackHipY, attackHipZ, 1, TASK_PRIORITY.ACTION);

    bodyTaskTargets.offerWorld(
      a,
      supportKnee,
      supportX + (supportHipX - supportX) * 0.52 + fx * 0.07 * turn * scale,
      supportY + (supportHipY - supportY) * 0.5 - 0.045 * flight * scale,
      supportZ + (supportHipZ - supportZ) * 0.52 + fz * 0.07 * turn * scale,
      1,
      TASK_PRIORITY.CONTACT_CRITICAL,
    );

    let dx = rawFootX + pelvisX - basePelvisX - attackHipX;
    let dy = rawFootY - attackHipY;
    let dz = rawFootZ + pelvisZ - basePelvisZ - attackHipZ;
    const distance = Math.max(1e-6, Math.hypot(dx, dy, dz));
    dx /= distance; dy /= distance; dz /= distance;
    const reach = Math.max(0.36 * scale,
      Math.min(0.667 * scale, distance));
    const along = reach * 0.5;
    const bend = Math.sqrt(Math.max(0,
      (0.34 * scale) ** 2 - along * along));
    let poleX = rx * side * 0.5;
    let poleY = 0.8;
    let poleZ = rz * side * 0.5;
    const dot = poleX * dx + poleY * dy + poleZ * dz;
    poleX -= dx * dot; poleY -= dy * dot; poleZ -= dz * dot;
    const poleLength = Math.max(1e-6,
      Math.hypot(poleX, poleY, poleZ));
    bodyTaskTargets.offerWorld(a, attackFoot,
      attackHipX + dx * reach, attackHipY + dy * reach,
      attackHipZ + dz * reach, 1, TASK_PRIORITY.ACTION);
    bodyTaskTargets.offerWorld(a, attackKnee,
      attackHipX + dx * along + poleX / poleLength * bend,
      attackHipY + dy * along + poleY / poleLength * bend,
      attackHipZ + dz * along + poleZ / poleLength * bend,
      1, TASK_PRIORITY.ACTION);

    const baseChestX = bodyTaskTargets.targetXFor(a, BODY.chest);
    const baseChestY = bodyTaskTargets.targetYFor(a, BODY.chest);
    const baseChestZ = bodyTaskTargets.targetZFor(a, BODY.chest);
    const counterSide = -side * (0.18 * flight + 0.09 * extension) * scale;
    const counterBack = -extension * 0.07 * scale;
    const chestX = baseChestX + rx * counterSide + fx * counterBack + toSupportX * flight * 0.065;
    const chestY = baseChestY + extension * 0.025 * scale;
    const chestZ = baseChestZ + rz * counterSide + fz * counterBack + toSupportZ * flight * 0.065;
    bodyTaskTargets.offerWorld(a, BODY.chest, chestX, chestY, chestZ, 1, TASK_PRIORITY.ACTION);

    bodyTaskTargets.offerWorld(
      a,
      BODY.lShoulder,
      chestX + shoulderRightX * (-0.27 * scale),
      chestY + 0.11 * scale,
      chestZ + shoulderRightZ * (-0.27 * scale),
      1,
      TASK_PRIORITY.ACTION,
    );
    bodyTaskTargets.offerWorld(
      a,
      BODY.rShoulder,
      chestX + shoulderRightX * (0.27 * scale),
      chestY + 0.11 * scale,
      chestZ + shoulderRightZ * (0.27 * scale),
      1,
      TASK_PRIORITY.ACTION,
    );

    const guardForwardX = fx * 0.12 * scale;
    const guardForwardZ = fz * 0.12 * scale;
    bodyTaskTargets.offerWorld(
      a,
      BODY.lElbow,
      chestX + shoulderRightX * (-0.22 * scale) + fx * 0.035 * scale,
      chestY - 0.015 * scale,
      chestZ + shoulderRightZ * (-0.22 * scale) + fz * 0.035 * scale,
      1,
      TASK_PRIORITY.ACTION,
    );
    bodyTaskTargets.offerWorld(
      a,
      BODY.rElbow,
      chestX + shoulderRightX * (0.22 * scale) + fx * 0.035 * scale,
      chestY - 0.015 * scale,
      chestZ + shoulderRightZ * (0.22 * scale) + fz * 0.035 * scale,
      1,
      TASK_PRIORITY.ACTION,
    );
    bodyTaskTargets.offerWorld(
      a,
      BODY.lHand,
      chestX + shoulderRightX * (-0.12 * scale) + guardForwardX,
      chestY + 0.19 * scale,
      chestZ + shoulderRightZ * (-0.12 * scale) + guardForwardZ,
      1,
      TASK_PRIORITY.ACTION,
    );
    bodyTaskTargets.offerWorld(
      a,
      BODY.rHand,
      chestX + shoulderRightX * (0.1 * scale) + guardForwardX * 0.78,
      chestY + 0.22 * scale,
      chestZ + shoulderRightZ * (0.1 * scale) + guardForwardZ * 0.78,
      1,
      TASK_PRIORITY.ACTION,
    );
  }

  private taskDistance(
    a: Actor,
    rig: BodyRig,
    node: number,
    minimumPriority: number,
  ) {
    if (bodyTaskTargets.priorityFor(a, node) < minimumPriority) return 0;
    return Math.hypot(
      bodyTaskTargets.targetXFor(a, node) - rig.x[node]!,
      bodyTaskTargets.targetYFor(a, node) - rig.y[node]!,
      bodyTaskTargets.targetZFor(a, node) - rig.z[node]!,
    );
  }

  private captureFeet(rig: BodyRig, slot: number) {
    this.lFootX[slot] = rig.x[BODY.lFoot]!;
    this.lFootY[slot] = rig.y[BODY.lFoot]!;
    this.lFootZ[slot] = rig.z[BODY.lFoot]!;
    this.rFootX[slot] = rig.x[BODY.rFoot]!;
    this.rFootY[slot] = rig.y[BODY.rFoot]!;
    this.rFootZ[slot] = rig.z[BODY.rFoot]!;
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
