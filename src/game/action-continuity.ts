import type { Actions } from "./input";
import type { Actor } from "./types";
import type { World } from "./world";
import {
  BODY,
  BODY_NODE_COUNT,
  type BodyRig,
  type PhysicalBodies,
} from "./body";
import { bodyScale } from "./body-model";
import { bodyTaskTargets, TASK_PRIORITY } from "./body-task-targets";

const ENTITY_ID_CAP = 8192;
const BODY_CAP = 128;
const STRIDE = BODY_NODE_COUNT;
const NONE = 0;
const HAND_ACTION = 1;
const KICK_ACTION = 2;
const INPUT_BUFFER_T = 0.22;

export const EDGES = {
  actionFlow: true,
};

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smooth01(v: number) {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

function human(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/**
 * Preserves mechanical continuity across locomotion -> action -> recovery.
 *
 * Locomotion still owns gait generation and melee still owns the specialist
 * action. This layer only carries forward state that should not disappear at
 * their boundary: achieved momentum, the gait-selected swing foot, body
 * heading, terminal action geometry, and one short buffered follow-up input.
 */
export class ActionContinuity {
  private readonly slotById = new Int16Array(ENTITY_ID_CAP);
  private readonly activeKind = new Uint8Array(BODY_CAP);
  private readonly entrySpeed = new Float32Array(BODY_CAP);
  private readonly entryDirX = new Float32Array(BODY_CAP);
  private readonly entryDirZ = new Float32Array(BODY_CAP);
  private readonly captureSpeed = new Float32Array(BODY_CAP);
  private readonly captureDirX = new Float32Array(BODY_CAP);
  private readonly captureDirZ = new Float32Array(BODY_CAP);
  private readonly recoveryT = new Float32Array(BODY_CAP);
  private readonly recoveryDuration = new Float32Array(BODY_CAP);

  private readonly locoPriority = new Uint8Array(BODY_CAP * STRIDE);
  private readonly locoX = new Float32Array(BODY_CAP * STRIDE);
  private readonly locoY = new Float32Array(BODY_CAP * STRIDE);
  private readonly locoZ = new Float32Array(BODY_CAP * STRIDE);
  private readonly lastActionPriority = new Uint8Array(BODY_CAP * STRIDE);
  // Non-foot action targets are stored in actor-local horizontal coordinates
  // so recovery can turn with the fighter instead of dragging toward stale
  // world-space points. Feet retain world anchors because contact owns them.
  private readonly lastX = new Float32Array(BODY_CAP * STRIDE);
  private readonly lastY = new Float32Array(BODY_CAP * STRIDE);
  private readonly lastZ = new Float32Array(BODY_CAP * STRIDE);

  private slotCount = 0;
  private frameAttack = false;
  private frameKick = false;
  private bufferedAttackT = 0;
  private bufferedKickT = 0;

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
    this.activeKind.fill(0);
    this.entrySpeed.fill(0);
    this.captureSpeed.fill(0);
    this.recoveryT.fill(0);
    this.recoveryDuration.fill(0);
    this.locoPriority.fill(0);
    this.lastActionPriority.fill(0);
    this.slotCount = 0;
    this.frameAttack = false;
    this.frameKick = false;
    this.bufferedAttackT = 0;
    this.bufferedKickT = 0;
  }

  reset(a: Actor) {
    const slot = this.slot(a.id);
    if (slot < 0) return;
    this.activeKind[slot] = NONE;
    this.entrySpeed[slot] = 0;
    this.captureSpeed[slot] = 0;
    this.recoveryT[slot] = 0;
    const base = slot * STRIDE;
    this.locoPriority.fill(0, base, base + STRIDE);
    this.lastActionPriority.fill(0, base, base + STRIDE);
    if (a.kind === "player") {
      this.bufferedAttackT = 0;
      this.bufferedKickT = 0;
    }
  }

  captureInput(input: Actions) {
    this.frameAttack = Boolean(input.attackPressed);
    this.frameKick = Boolean(input.kickPressed);
  }

  /**
   * Keep one deliberate follow-up command briefly while an action owns the
   * body. Returns true only when a buffered command was re-injected and must
   * be passed through MeleeKinematics.captureInput again this frame.
   */
  prepareBufferedInput(input: Actions, actionActive: boolean, dt: number) {
    const h = Math.max(0, dt);
    if (actionActive) {
      if (this.frameAttack) this.bufferedAttackT = INPUT_BUFFER_T;
      else this.bufferedAttackT = Math.max(0, this.bufferedAttackT - h);
      if (this.frameKick) this.bufferedKickT = INPUT_BUFFER_T;
      else this.bufferedKickT = Math.max(0, this.bufferedKickT - h);
    } else {
      this.bufferedAttackT = Math.max(0, this.bufferedAttackT - h);
      this.bufferedKickT = Math.max(0, this.bufferedKickT - h);
    }

    let released = false;
    if (!actionActive && !this.frameAttack && this.bufferedAttackT > 0) {
      input.attackPressed = true;
      this.bufferedAttackT = 0;
      released = true;
    }
    if (!actionActive && !this.frameKick && this.bufferedKickT > 0) {
      input.kickPressed = true;
      this.bufferedKickT = 0;
      released = true;
    }
    if (!actionActive && this.frameAttack) this.bufferedAttackT = 0;
    if (!actionActive && this.frameKick) this.bufferedKickT = 0;
    this.frameAttack = false;
    this.frameKick = false;
    return released;
  }

  /** Capture the locomotion solution before specialist action tasks overwrite it. */
  captureLocomotion(w: World) {
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a)) continue;
      let slot = this.slot(a.id);
      if (slot < 0) slot = this.register(a);
      if (slot < 0) continue;
      const rig = this.bodies.get(a);
      if (!rig?.initialized) continue;

      let dx = a.intendX;
      let dz = a.intendZ;
      let dm = Math.hypot(dx, dz);
      const physicalSpeed = Math.hypot(a.vx, a.vz);
      if (dm < 1e-5 && physicalSpeed > 0.05) {
        dx = a.vx / physicalSpeed;
        dz = a.vz / physicalSpeed;
        dm = 1;
      }
      if (dm > 1e-5) {
        dx /= dm;
        dz /= dm;
      }
      this.captureDirX[slot] = dx;
      this.captureDirZ[slot] = dz;
      this.captureSpeed[slot] = Math.max(0, a.intendSpeed, physicalSpeed);

      const base = slot * STRIDE;
      for (let node = 0; node < STRIDE; node++) {
        const q = base + node;
        const priority = bodyTaskTargets.priorityFor(a, node);
        this.locoPriority[q] = priority;
        if (priority <= 0) continue;
        this.locoX[q] = bodyTaskTargets.targetXFor(a, node);
        this.locoY[q] = bodyTaskTargets.targetYFor(a, node);
        this.locoZ[q] = bodyTaskTargets.targetZFor(a, node);
      }
    }
  }

  /** Couple the final action field to the locomotion state it interrupted. */
  couple(w: World, dt: number) {
    const h = Math.max(1e-5, dt);
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a) || !a.alive) continue;
      const slot = this.slot(a.id);
      if (slot < 0) continue;
      const rig = this.bodies.get(a);
      if (!rig?.initialized || rig.mode !== "follow") continue;

      const detected = this.detectAction(a, rig);
      const previous = this.activeKind[slot]!;
      if (detected !== previous) {
        if (detected !== NONE) {
          const physicalSpeed = Math.hypot(a.vx, a.vz);
          this.entrySpeed[slot] = Math.max(
            physicalSpeed,
            this.captureSpeed[slot]!,
          );
          let dx = this.captureDirX[slot]!;
          let dz = this.captureDirZ[slot]!;
          let dm = Math.hypot(dx, dz);
          if (dm < 1e-5 && physicalSpeed > 0.05) {
            dx = a.vx / physicalSpeed;
            dz = a.vz / physicalSpeed;
            dm = 1;
          }
          if (dm > 1e-5) {
            dx /= dm;
            dz /= dm;
          }
          this.entryDirX[slot] = dx;
          this.entryDirZ[slot] = dz;
          this.recoveryT[slot] = 0;
        } else if (previous !== NONE) {
          const duration = previous === KICK_ACTION ? 0.2 : 0.14;
          this.recoveryDuration[slot] = duration;
          this.recoveryT[slot] = duration;
        }
        this.activeKind[slot] = detected;
      }

      if (detected !== NONE) {
        if (EDGES.actionFlow) this.applyActiveFlow(a, rig, slot, detected);
        this.captureActionTargets(a, slot);
      } else if (EDGES.actionFlow && this.recoveryT[slot]! > 0) {
        this.applyRecovery(a, slot, h);
      } else if (this.recoveryT[slot]! > 0) {
        this.recoveryT[slot] = Math.max(0, this.recoveryT[slot]! - h);
      }
    }
  }

  private detectAction(a: Actor, rig: BodyRig) {
    const scale = bodyScale(a);
    let handDistance = 0;
    let footDistance = 0;
    for (const node of [BODY.lHand, BODY.rHand]) {
      if (bodyTaskTargets.priorityFor(a, node) < TASK_PRIORITY.ACTION) continue;
      handDistance = Math.max(handDistance, this.taskDistance(a, rig, node));
    }
    for (const node of [BODY.lFoot, BODY.rFoot]) {
      if (bodyTaskTargets.priorityFor(a, node) < TASK_PRIORITY.ACTION) continue;
      footDistance = Math.max(footDistance, this.taskDistance(a, rig, node));
    }
    if (footDistance > 0.16 * scale) return KICK_ACTION;
    if (handDistance > 0.05 * scale) return HAND_ACTION;
    return NONE;
  }

  private applyActiveFlow(
    a: Actor,
    rig: BodyRig,
    slot: number,
    kind: number,
  ) {
    const scale = bodyScale(a);
    const physicalSpeed = Math.hypot(a.vx, a.vz);
    const baseSpeed = Math.max(this.entrySpeed[slot]!, physicalSpeed);
    let currentX = this.captureDirX[slot]!;
    let currentZ = this.captureDirZ[slot]!;
    let cm = Math.hypot(currentX, currentZ);
    if (cm > 1e-5) {
      currentX /= cm;
      currentZ /= cm;
    }
    let dirX = this.entryDirX[slot]! * 0.35 + currentX * 0.65;
    let dirZ = this.entryDirZ[slot]! * 0.35 + currentZ * 0.65;
    let dm = Math.hypot(dirX, dirZ);
    if (dm > 1e-5) {
      dirX /= dm;
      dirZ /= dm;
      a.intendX = dirX;
      a.intendZ = dirZ;
    }

    if (kind === HAND_ACTION) {
      const lHandD = this.taskDistance(a, rig, BODY.lHand);
      const rHandD = this.taskDistance(a, rig, BODY.rHand);
      const commit = clamp01(Math.max(lHandD, rHandD) / (0.58 * scale));
      const retained = baseSpeed * (0.86 - 0.18 * commit);
      a.intendSpeed = Math.max(a.intendSpeed, retained);
      this.inheritGaitStep(a, rig, slot, baseSpeed, commit);
      this.inheritLocomotionTorso(a, slot, baseSpeed, commit);
    } else {
      const lFootD = this.taskDistance(a, rig, BODY.lFoot);
      const rFootD = this.taskDistance(a, rig, BODY.rFoot);
      const commit = clamp01(Math.max(lFootD, rFootD) / (0.64 * scale));
      // A kick must establish support, but it should bleed incoming travel
      // through the planted side instead of deleting momentum at the button edge.
      const retained = baseSpeed * (0.52 - 0.2 * commit);
      a.intendSpeed = Math.max(a.intendSpeed, retained);
    }
  }

  private inheritGaitStep(
    a: Actor,
    rig: BodyRig,
    slot: number,
    speed: number,
    commit: number,
  ) {
    const base = slot * STRIDE;
    const scale = bodyScale(a);
    const lq = base + BODY.lFoot;
    const rq = base + BODY.rFoot;
    if (this.locoPriority[lq]! <= 0 && this.locoPriority[rq]! <= 0) return;

    const lMove = this.locoPriority[lq]! > 0
      ? Math.hypot(
          this.locoX[lq]! - rig.x[BODY.lFoot]!,
          this.locoY[lq]! - rig.y[BODY.lFoot]!,
          this.locoZ[lq]! - rig.z[BODY.lFoot]!,
        )
      : 0;
    const rMove = this.locoPriority[rq]! > 0
      ? Math.hypot(
          this.locoX[rq]! - rig.x[BODY.rFoot]!,
          this.locoY[rq]! - rig.y[BODY.rFoot]!,
          this.locoZ[rq]! - rig.z[BODY.rFoot]!,
        )
      : 0;
    const node = lMove >= rMove ? BODY.lFoot : BODY.rFoot;
    const q = base + node;
    const gaitMove = Math.max(lMove, rMove);
    if (gaitMove < 0.035 * scale || this.locoPriority[q]! <= 0) return;

    const flow = clamp01(speed / 4.8) * (1 - commit * 0.25);
    if (flow <= 0.02) return;
    const ax = bodyTaskTargets.targetXFor(a, node);
    const ay = bodyTaskTargets.targetYFor(a, node);
    const az = bodyTaskTargets.targetZFor(a, node);
    const blend = 0.78 * flow;
    bodyTaskTargets.offerWorld(
      a,
      node,
      lerp(ax, this.locoX[q]!, blend),
      lerp(ay, this.locoY[q]!, blend),
      lerp(az, this.locoZ[q]!, blend),
      1,
      TASK_PRIORITY.CONTACT_CRITICAL,
    );
  }

  private inheritLocomotionTorso(
    a: Actor,
    slot: number,
    speed: number,
    commit: number,
  ) {
    const flow = clamp01(speed / 5.4) * (1 - commit * 0.45) * 0.18;
    if (flow <= 0.01) return;
    const base = slot * STRIDE;
    for (const node of [BODY.pelvis, BODY.chest]) {
      const q = base + node;
      if (this.locoPriority[q]! <= 0 ||
          bodyTaskTargets.priorityFor(a, node) < TASK_PRIORITY.ACTION) continue;
      bodyTaskTargets.offerWorld(
        a,
        node,
        lerp(bodyTaskTargets.targetXFor(a, node), this.locoX[q]!, flow),
        lerp(bodyTaskTargets.targetYFor(a, node), this.locoY[q]!, flow),
        lerp(bodyTaskTargets.targetZFor(a, node), this.locoZ[q]!, flow),
        1,
        TASK_PRIORITY.ACTION,
      );
    }
  }

  private captureActionTargets(a: Actor, slot: number) {
    const base = slot * STRIDE;
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    const rx = Math.cos(a.yaw);
    const rz = -Math.sin(a.yaw);
    for (let node = 0; node < STRIDE; node++) {
      const q = base + node;
      const priority = bodyTaskTargets.priorityFor(a, node);
      if (priority < TASK_PRIORITY.ACTION) continue;
      this.lastActionPriority[q] = priority;
      const tx = bodyTaskTargets.targetXFor(a, node);
      const ty = bodyTaskTargets.targetYFor(a, node);
      const tz = bodyTaskTargets.targetZFor(a, node);
      if (node === BODY.lFoot || node === BODY.rFoot) {
        this.lastX[q] = tx;
        this.lastY[q] = ty;
        this.lastZ[q] = tz;
      } else {
        const dx = tx - a.x;
        const dz = tz - a.z;
        this.lastX[q] = dx * rx + dz * rz;
        this.lastY[q] = ty - a.y;
        this.lastZ[q] = dx * fx + dz * fz;
      }
    }
  }

  private applyRecovery(a: Actor, slot: number, dt: number) {
    const duration = Math.max(1e-5, this.recoveryDuration[slot]!);
    const t = 1 - this.recoveryT[slot]! / duration;
    const blend = smooth01(t);
    const base = slot * STRIDE;
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    const rx = Math.cos(a.yaw);
    const rz = -Math.sin(a.yaw);
    const scale = bodyScale(a);

    for (let node = 0; node < STRIDE; node++) {
      const q = base + node;
      if (this.lastActionPriority[q]! < TASK_PRIORITY.ACTION ||
          this.locoPriority[q]! <= 0) continue;
      let sx: number;
      let sy: number;
      let sz: number;
      if (node === BODY.lFoot || node === BODY.rFoot) {
        sx = this.lastX[q]!;
        sy = this.lastY[q]!;
        sz = this.lastZ[q]!;
      } else {
        sx = a.x + rx * this.lastX[q]! + fx * this.lastZ[q]!;
        sy = a.y + this.lastY[q]!;
        sz = a.z + rz * this.lastX[q]! + fz * this.lastZ[q]!;
      }
      let priority = TASK_PRIORITY.ACTION;
      if (
        (node === BODY.lFoot || node === BODY.rFoot) &&
        Math.abs(this.locoY[q]! - sy) < 0.05 * scale &&
        blend < 0.62
      ) {
        priority = TASK_PRIORITY.CONTACT_CRITICAL;
      }
      bodyTaskTargets.offerWorld(
        a,
        node,
        lerp(sx, this.locoX[q]!, blend),
        lerp(sy, this.locoY[q]!, blend),
        lerp(sz, this.locoZ[q]!, blend),
        1,
        priority,
      );
    }

    this.recoveryT[slot] = Math.max(0, this.recoveryT[slot]! - dt);
    if (this.recoveryT[slot] <= 0) {
      this.lastActionPriority.fill(0, base, base + STRIDE);
    }
  }

  private taskDistance(a: Actor, rig: BodyRig, node: number) {
    if (bodyTaskTargets.priorityFor(a, node) < TASK_PRIORITY.ACTION) return 0;
    return Math.hypot(
      bodyTaskTargets.targetXFor(a, node) - rig.x[node]!,
      bodyTaskTargets.targetYFor(a, node) - rig.y[node]!,
      bodyTaskTargets.targetZFor(a, node) - rig.z[node]!,
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
