import type { Actor } from "./types";
import type { World } from "./world";
import { BODY, bodyScale, type BodyRig, type PhysicalBodies } from "./body";
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

    // Compose with the melee solver's pelvis/chest requests rather than
    // replacing them. Weight moves toward the lead foot while ground reaction
    // from support-motion supplies the net momentum behind the punch.
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

    // Load the rear knee under a cross instead of allowing an arm-only strike.
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
    const attackFoot = attackLeft ? BODY.lFoot : BODY.rFoot;
    const supportFoot = attackLeft ? BODY.rFoot : BODY.lFoot;
    const supportKnee = attackLeft ? BODY.rKnee : BODY.lKnee;
    const supportHip = attackLeft ? BODY.rHip : BODY.lHip;
    const supportX = attackLeft ? this.rFootX[slot]! : this.lFootX[slot]!;
    const supportY = attackLeft ? this.rFootY[slot]! : this.lFootY[slot]!;
    const supportZ = attackLeft ? this.rFootZ[slot]! : this.lFootZ[slot]!;

    // The supporting foot is a hard task relative to cosmetic posture. The
    // controller still cannot violate world collision/friction to satisfy it.
    bodyTaskTargets.offerWorld(
      a,
      supportFoot,
      supportX,
      supportY,
      supportZ,
      1,
      TASK_PRIORITY.CONTACT_CRITICAL,
    );
    if (bodyTaskTargets.priorityFor(a, supportKnee) >= TASK_PRIORITY.ACTION) {
      bodyTaskTargets.offerWorld(
        a,
        supportKnee,
        bodyTaskTargets.targetXFor(a, supportKnee),
        bodyTaskTargets.targetYFor(a, supportKnee),
        bodyTaskTargets.targetZFor(a, supportKnee),
        1,
        TASK_PRIORITY.CONTACT_CRITICAL,
      );
    }
    if (bodyTaskTargets.priorityFor(a, supportHip) >= TASK_PRIORITY.ACTION) {
      bodyTaskTargets.offerWorld(
        a,
        supportHip,
        bodyTaskTargets.targetXFor(a, supportHip),
        bodyTaskTargets.targetYFor(a, supportHip),
        bodyTaskTargets.targetZFor(a, supportHip),
        1,
        TASK_PRIORITY.CONTACT_CRITICAL,
      );
    }

    const attackY = bodyTaskTargets.targetYFor(a, attackFoot);
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    const hip = attackLeft ? BODY.lHip : BODY.rHip;
    const forward =
      (bodyTaskTargets.targetXFor(a, attackFoot) - rig.x[hip]!) * fx +
      (bodyTaskTargets.targetZFor(a, attackFoot) - rig.z[hip]!) * fz;
    const flight = clamp01((attackY - supportY - 0.1 * scale) / (0.42 * scale));
    const extension = clamp01((forward - 0.16 * scale) / (0.7 * scale));
    const preload = flight * (1 - extension * 0.72);

    const pelvisX = bodyTaskTargets.targetXFor(a, BODY.pelvis);
    const pelvisY = bodyTaskTargets.targetYFor(a, BODY.pelvis);
    const pelvisZ = bodyTaskTargets.targetZFor(a, BODY.pelvis);
    const toSupportX = supportX - rig.x[BODY.pelvis]!;
    const toSupportZ = supportZ - rig.z[BODY.pelvis]!;
    const supportShift = 0.2 + flight * 0.22;
    bodyTaskTargets.offerWorld(
      a,
      BODY.pelvis,
      pelvisX + toSupportX * supportShift + fx * preload * 0.035 * scale,
      pelvisY - flight * 0.028 * scale,
      pelvisZ + toSupportZ * supportShift + fz * preload * 0.035 * scale,
      1,
      TASK_PRIORITY.ACTION,
    );

    // The upper body commits before full leg extension, then the existing melee
    // recovery target straightens it. This amplifies the physically meaningful
    // preload already present instead of layering a canned kick animation.
    const chestX = bodyTaskTargets.targetXFor(a, BODY.chest);
    const chestY = bodyTaskTargets.targetYFor(a, BODY.chest);
    const chestZ = bodyTaskTargets.targetZFor(a, BODY.chest);
    bodyTaskTargets.offerWorld(
      a,
      BODY.chest,
      chestX + fx * preload * 0.085 * scale + toSupportX * flight * 0.05,
      chestY - preload * 0.012 * scale,
      chestZ + fz * preload * 0.085 * scale + toSupportZ * flight * 0.05,
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
