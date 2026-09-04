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
 *
 * Melee remains responsible for WHAT the fist/foot should do. This layer reads
 * those same task-space requests and adds the mechanically required whole-body
 * consequences: planted feet, support-leg authority, and weight transfer.
 * It never moves solved nodes directly and never invents a second animation.
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

    // Current boxer convention is an orthodox stance: left foot leads, right
    // foot supplies the strongest drive for the rear cross. Anchors are captured
    // from the actual solved feet at action onset so punching from uneven ground
    // does not teleport the character into an abstract stance pose.
    const leadStep = (jab ? 0.055 : 0.025) * drive * scale;
    const rearSet = (jab ? 0.008 : 0.018) * drive * scale;
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
    const transfer = (jab ? 0.09 : 0.17) * drive;
    const surge = (jab ? 0.028 : 0.052) * drive * scale;
    bodyTaskTargets.offerWorld(
      a,
      BODY.pelvis,
      pelvisX + leadDx * transfer + fx * surge,
      pelvisY - (jab ? 0.01 : 0.022) * drive * scale,
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
      chestX + leadDx * transfer * 0.38 + fx * surge * 0.72,
      chestY,
      chestZ + leadDz * transfer * 0.38 + fz * surge * 0.72,
      1,
      TASK_PRIORITY.ACTION,
    );

    const rearKnee = BODY.rKnee;
    if (bodyTaskTargets.priorityFor(a, rearKnee) >= TASK_PRIORITY.ACTION) {
      bodyTaskTargets.offerWorld(
        a,
        rearKnee,
        bodyTaskTargets.targetXFor(a, rearKnee),
        bodyTaskTargets.targetYFor(a, rearKnee) - (jab ? 0.012 : 0.035) * drive * scale,
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
    const flight = clamp01((rawFootY - supportY - 0.1 * scale) / (0.42 * scale));
    const extension = clamp01((forward - 0.16 * scale) / (0.7 * scale));
    const chamber = clamp01(flight * (1 - extension * 0.82));
    const turn = clamp01(chamber * 0.72 + extension * 0.92);
    const preload = flight * (1 - extension * 0.58);

    // Kickboxer-style roundhouse geometry. The original melee phase still owns
    // timing; this coupling remaps its straight front-kick effector into a
    // chambered lateral arc. At chamber the knee comes up/out and the foot folds
    // beneath it; through extension the hip turns and the foot sweeps diagonally
    // across the target line rather than driving straight forward like a door kick.
    const footLX = side * (0.13 + chamber * 0.2 - extension * 0.17) * scale;
    const footLY = (0.08 + chamber * 0.29 + extension * 0.5) * scale;
    const footLZ = (-0.03 + chamber * 0.08 + extension * 0.61) * scale;
    const footX = a.x + rx * footLX + fx * footLZ;
    const footY = a.y + footLY;
    const footZ = a.z + rz * footLX + fz * footLZ;
    bodyTaskTargets.offerWorld(
      a,
      attackFoot,
      footX,
      footY,
      footZ,
      1,
      TASK_PRIORITY.ACTION,
    );

    const kneeLX = side * (0.13 + chamber * 0.19 + extension * 0.08) * scale;
    const kneeLY = (0.42 + chamber * 0.16 + extension * 0.14) * scale;
    const kneeLZ = (0.04 + chamber * 0.1 + extension * 0.25) * scale;
    bodyTaskTargets.offerWorld(
      a,
      attackKnee,
      a.x + rx * kneeLX + fx * kneeLZ,
      a.y + kneeLY,
      a.z + rz * kneeLX + fz * kneeLZ,
      1,
      TASK_PRIORITY.ACTION,
    );

    // Plant the opposite foot. The point foot cannot encode yaw by itself, so
    // support-foot pivot is expressed by rotating the support knee/hip and the
    // pelvis/shoulder lines around this fixed contact.
    bodyTaskTargets.offerWorld(
      a,
      supportFoot,
      supportX,
      supportY,
      supportZ,
      1,
      TASK_PRIORITY.CONTACT_CRITICAL,
    );

    const supportKneeX = bodyTaskTargets.targetXFor(a, supportKnee) - fx * turn * 0.035 * scale;
    const supportKneeY = bodyTaskTargets.targetYFor(a, supportKnee) - flight * 0.025 * scale;
    const supportKneeZ = bodyTaskTargets.targetZFor(a, supportKnee) - fz * turn * 0.035 * scale;
    bodyTaskTargets.offerWorld(
      a,
      supportKnee,
      supportKneeX,
      supportKneeY,
      supportKneeZ,
      1,
      TASK_PRIORITY.CONTACT_CRITICAL,
    );

    const supportHipBaseX = bodyTaskTargets.targetXFor(a, supportHip);
    const supportHipBaseY = bodyTaskTargets.targetYFor(a, supportHip);
    const supportHipBaseZ = bodyTaskTargets.targetZFor(a, supportHip);
    const supportHipTurn = -side * 0.095 * turn * scale;
    bodyTaskTargets.offerWorld(
      a,
      supportHip,
      supportHipBaseX + fx * supportHipTurn,
      supportHipBaseY - flight * 0.018 * scale,
      supportHipBaseZ + fz * supportHipTurn,
      1,
      TASK_PRIORITY.CONTACT_CRITICAL,
    );

    const attackHipBaseX = bodyTaskTargets.targetXFor(a, attackHip);
    const attackHipBaseY = bodyTaskTargets.targetYFor(a, attackHip);
    const attackHipBaseZ = bodyTaskTargets.targetZFor(a, attackHip);
    const attackHipTurn = side * 0.14 * turn * scale;
    bodyTaskTargets.offerWorld(
      a,
      attackHip,
      attackHipBaseX + fx * attackHipTurn,
      attackHipBaseY + flight * 0.018 * scale,
      attackHipBaseZ + fz * attackHipTurn,
      1,
      TASK_PRIORITY.ACTION,
    );

    const pelvisX = bodyTaskTargets.targetXFor(a, BODY.pelvis);
    const pelvisY = bodyTaskTargets.targetYFor(a, BODY.pelvis);
    const pelvisZ = bodyTaskTargets.targetZFor(a, BODY.pelvis);
    const toSupportX = supportX - rig.x[BODY.pelvis]!;
    const toSupportZ = supportZ - rig.z[BODY.pelvis]!;
    const supportShift = 0.34 + flight * 0.28;
    const lateralBrace = -side * (0.055 + flight * 0.06) * scale;
    bodyTaskTargets.offerWorld(
      a,
      BODY.pelvis,
      pelvisX + toSupportX * supportShift + rx * lateralBrace + fx * preload * 0.015 * scale,
      pelvisY - flight * 0.038 * scale,
      pelvisZ + toSupportZ * supportShift + rz * lateralBrace + fz * preload * 0.015 * scale,
      1,
      TASK_PRIORITY.ACTION,
    );

    // Counter-lean away from the kicking leg while the shoulders rotate with
    // the hips. This is the characteristic side-on silhouette missing from the
    // previous rigid front kick.
    const chestX = bodyTaskTargets.targetXFor(a, BODY.chest);
    const chestY = bodyTaskTargets.targetYFor(a, BODY.chest);
    const chestZ = bodyTaskTargets.targetZFor(a, BODY.chest);
    const counterSide = -side * (0.1 * flight + 0.045 * extension) * scale;
    const counterBack = -extension * 0.035 * scale;
    bodyTaskTargets.offerWorld(
      a,
      BODY.chest,
      chestX + rx * counterSide + fx * counterBack + toSupportX * flight * 0.045,
      chestY + extension * 0.018 * scale,
      chestZ + rz * counterSide + fz * counterBack + toSupportZ * flight * 0.045,
      1,
      TASK_PRIORITY.ACTION,
    );

    const lShoulderX = bodyTaskTargets.targetXFor(a, BODY.lShoulder);
    const lShoulderY = bodyTaskTargets.targetYFor(a, BODY.lShoulder);
    const lShoulderZ = bodyTaskTargets.targetZFor(a, BODY.lShoulder);
    const rShoulderX = bodyTaskTargets.targetXFor(a, BODY.rShoulder);
    const rShoulderY = bodyTaskTargets.targetYFor(a, BODY.rShoulder);
    const rShoulderZ = bodyTaskTargets.targetZFor(a, BODY.rShoulder);
    const lTurn = attackLeft ? 0.17 : -0.14;
    const rTurn = attackLeft ? -0.14 : 0.17;
    bodyTaskTargets.offerWorld(
      a,
      BODY.lShoulder,
      lShoulderX + fx * lTurn * turn * scale + rx * counterSide * 0.32,
      lShoulderY,
      lShoulderZ + fz * lTurn * turn * scale + rz * counterSide * 0.32,
      1,
      TASK_PRIORITY.ACTION,
    );
    bodyTaskTargets.offerWorld(
      a,
      BODY.rShoulder,
      rShoulderX + fx * rTurn * turn * scale + rx * counterSide * 0.32,
      rShoulderY,
      rShoulderZ + fz * rTurn * turn * scale + rz * counterSide * 0.32,
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
