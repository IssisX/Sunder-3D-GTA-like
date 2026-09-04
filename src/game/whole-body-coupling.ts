import type { Actor } from "./types";
import type { World } from "./world";
import { BODY, type PhysicalBodies } from "./body";
import { bodyScale, type BodyRig } from "./body-model";
import { bodyTaskTargets, TASK_PRIORITY } from "./body-task-targets";

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
    this.slotCount = 0;
  }

  reset(a: Actor) {
    const slot = this.slot(a.id);
    if (slot >= 0) this.kind[slot] = NONE;
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
        continue;
      }

      const scale = bodyScale(a);
      const lFootD = this.taskDistance(a, rig, BODY.lFoot, TASK_PRIORITY.ACTION);
      const rFootD = this.taskDistance(a, rig, BODY.rFoot, TASK_PRIORITY.ACTION);
      const lHandD = this.taskDistance(a, rig, BODY.lHand, TASK_PRIORITY.ACTION);
      const rHandD = this.taskDistance(a, rig, BODY.rHand, TASK_PRIORITY.ACTION);

      let detected = NONE;
      if (Math.max(lFootD, rFootD) > 0.09 * scale) detected = KICK;
      else if (a.weapon === "fist" && Math.max(lHandD, rHandD) > 0.05 * scale) detected = PUNCH;

      if (detected !== this.kind[slot]!) {
        this.kind[slot] = detected;
        if (detected !== NONE) this.captureFeet(rig, slot);
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
    const drive = clamp01(reach / (0.58 * scale));
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);

    // Orthodox boxer footwork. The jab gets a visible lead-foot gather/step;
    // the cross sets the rear foot harder and moves more body mass through the
    // pelvis before the fist reaches full extension.
    const leadStep = (jab ? 0.078 : 0.038) * drive * scale;
    const rearSet = (jab ? 0.012 : 0.03) * drive * scale;
    bodyTaskTargets.offerWorld(
      a,
      BODY.lFoot,
      this.lFootX[slot]! + fx * leadStep,
      this.lFootY[slot]!,
      this.lFootZ[slot]! + fz * leadStep,
      1,
      TASK_PRIORITY.CONTACT_CRITICAL,
    );
    bodyTaskTargets.offerWorld(
      a,
      BODY.rFoot,
      this.rFootX[slot]! - fx * rearSet,
      this.rFootY[slot]!,
      this.rFootZ[slot]! - fz * rearSet,
      1,
      TASK_PRIORITY.CONTACT_CRITICAL,
    );

    const pelvisX = bodyTaskTargets.targetXFor(a, BODY.pelvis);
    const pelvisY = bodyTaskTargets.targetYFor(a, BODY.pelvis);
    const pelvisZ = bodyTaskTargets.targetZFor(a, BODY.pelvis);
    const leadDx = this.lFootX[slot]! - rig.x[BODY.pelvis]!;
    const leadDz = this.lFootZ[slot]! - rig.z[BODY.pelvis]!;
    const transfer = (jab ? 0.13 : 0.24) * drive;
    const surge = (jab ? 0.04 : 0.08) * drive * scale;
    bodyTaskTargets.offerWorld(
      a,
      BODY.pelvis,
      pelvisX + leadDx * transfer + fx * surge,
      pelvisY - (jab ? 0.014 : 0.028) * drive * scale,
      pelvisZ + leadDz * transfer + fz * surge,
      1,
      TASK_PRIORITY.ACTION,
    );

    const chestX = bodyTaskTargets.targetXFor(a, BODY.chest);
    const chestY = bodyTaskTargets.targetYFor(a, BODY.chest);
    const chestZ = bodyTaskTargets.targetZFor(a, BODY.chest);
    bodyTaskTargets.offerWorld(
      a,
      BODY.chest,
      chestX + leadDx * transfer * 0.46 + fx * surge * 0.82,
      chestY,
      chestZ + leadDz * transfer * 0.46 + fz * surge * 0.82,
      1,
      TASK_PRIORITY.ACTION,
    );

    const rearKnee = BODY.rKnee;
    if (bodyTaskTargets.priorityFor(a, rearKnee) >= TASK_PRIORITY.ACTION) {
      bodyTaskTargets.offerWorld(
        a,
        rearKnee,
        bodyTaskTargets.targetXFor(a, rearKnee),
        bodyTaskTargets.targetYFor(a, rearKnee) - (jab ? 0.018 : 0.052) * drive * scale,
        bodyTaskTargets.targetZFor(a, rearKnee),
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
    const attackLeft = lFootD > rFootD;
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
    const forward =
      (rawFootX - rig.x[attackHip]!) * fx +
      (rawFootZ - rig.z[attackHip]!) * fz;
    const flight = clamp01((rawFootY - supportY - 0.09 * scale) / (0.44 * scale));
    const extension = clamp01((forward - 0.13 * scale) / (0.72 * scale));
    const chamber = clamp01(flight * (1 - extension * 0.78));
    const turn = clamp01(chamber * 0.7 + extension);

    // Support is the pivot. The point foot is fixed in world space; the rest of
    // the stance is organized around it rather than translating the whole rig.
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
    const supportShift = 0.42 + flight * 0.24;
    const lateralBrace = -side * (0.07 + flight * 0.07) * scale;
    const pelvisX = basePelvisX + toSupportX * supportShift + rx * lateralBrace;
    const pelvisY = basePelvisY - flight * 0.045 * scale;
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

    // True transverse-axis rotation instead of shear offsets. At peak turn the
    // pelvis rotates about 70 degrees toward the attack while preserving hip
    // width. Shoulders lag slightly, producing a real hip-to-torso torque chain.
    const theta = side * turn * 1.22;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const hipRightX = rx * c + fx * s;
    const hipRightZ = rz * c + fz * s;

    const shoulderTheta = theta * 0.82;
    const cs = Math.cos(shoulderTheta);
    const ss = Math.sin(shoulderTheta);
    const shoulderRightX = rx * cs + fx * ss;
    const shoulderRightZ = rz * cs + fz * ss;

    const supportHipSide = -side * 0.14 * scale;
    const attackHipSide = side * 0.14 * scale;
    const supportHipX = pelvisX + hipRightX * supportHipSide;
    const supportHipY = pelvisY - 0.06 * scale;
    const supportHipZ = pelvisZ + hipRightZ * supportHipSide;
    const attackHipX = pelvisX + hipRightX * attackHipSide;
    const attackHipY = pelvisY - 0.045 * scale + flight * 0.03 * scale;
    const attackHipZ = pelvisZ + hipRightZ * attackHipSide;

    bodyTaskTargets.offerWorld(
      a,
      supportHip,
      supportHipX,
      supportHipY,
      supportHipZ,
      1,
      TASK_PRIORITY.CONTACT_CRITICAL,
    );
    bodyTaskTargets.offerWorld(
      a,
      attackHip,
      attackHipX,
      attackHipY,
      attackHipZ,
      1,
      TASK_PRIORITY.ACTION,
    );

    // Support knee remains under the rotating pelvis with a modest forward bend,
    // giving the planted leg something to carry instead of remaining a rigid post.
    bodyTaskTargets.offerWorld(
      a,
      supportKnee,
      supportX + (supportHipX - supportX) * 0.5 + fx * 0.055 * turn * scale,
      supportY + (supportHipY - supportY) * 0.5 - 0.035 * flight * scale,
      supportZ + (supportHipZ - supportZ) * 0.5 + fz * 0.055 * turn * scale,
      1,
      TASK_PRIORITY.CONTACT_CRITICAL,
    );

    // The attacking leg sweeps on an arc: lateral chamber first, then the knee
    // comes around and the foot crosses inward as forward reach increases.
    const footSide = side * (0.3 + chamber * 0.1 - extension * 0.42) * scale;
    const footForward = (0.02 + chamber * 0.1 + extension * 0.78) * scale;
    const footHeight = (0.12 + chamber * 0.4 + extension * 0.38) * scale;
    bodyTaskTargets.offerWorld(
      a,
      attackFoot,
      pelvisX + rx * footSide + fx * footForward,
      a.y + footHeight,
      pelvisZ + rz * footSide + fz * footForward,
      1,
      TASK_PRIORITY.ACTION,
    );

    const kneeSide = side * (0.28 + chamber * 0.1 - extension * 0.2) * scale;
    const kneeForward = (0.06 + chamber * 0.14 + extension * 0.42) * scale;
    const kneeHeight = (0.42 + chamber * 0.22 + extension * 0.17) * scale;
    bodyTaskTargets.offerWorld(
      a,
      attackKnee,
      pelvisX + rx * kneeSide + fx * kneeForward,
      a.y + kneeHeight,
      pelvisZ + rz * kneeSide + fz * kneeForward,
      1,
      TASK_PRIORITY.ACTION,
    );

    const baseChestX = bodyTaskTargets.targetXFor(a, BODY.chest);
    const baseChestY = bodyTaskTargets.targetYFor(a, BODY.chest);
    const baseChestZ = bodyTaskTargets.targetZFor(a, BODY.chest);
    const counterSide = -side * (0.14 * flight + 0.06 * extension) * scale;
    const counterBack = -extension * 0.045 * scale;
    const chestX = baseChestX + rx * counterSide + fx * counterBack + toSupportX * flight * 0.05;
    const chestY = baseChestY + extension * 0.02 * scale;
    const chestZ = baseChestZ + rz * counterSide + fz * counterBack + toSupportZ * flight * 0.05;
    bodyTaskTargets.offerWorld(
      a,
      BODY.chest,
      chestX,
      chestY,
      chestZ,
      1,
      TASK_PRIORITY.ACTION,
    );

    // Shoulder line follows the rotating torso but lags the hips. This makes the
    // upper body visibly turn sideways rather than merely leaning while the leg
    // moves independently.
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
