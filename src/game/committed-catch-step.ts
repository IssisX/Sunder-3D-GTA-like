import type { Actor } from "./types";
import { GRAVITY } from "./types";
import type { World } from "./world";
import { BODY, bodyScale, nodeRadius, type BodyRig } from "./body-model";
import { supportHeight } from "./body-contacts";
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
const CATCH_PRIORITY = TASK_PRIORITY.CORRECTIVE_STEP + 1;

export const EDGES = {
  committedCatchStep: true,
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

function smooth01(v: number) {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/**
 * Adds physical commitment to the existing capture-step planner.
 *
 * Normal locomotion remains the source of capture-step candidates while the
 * body is still in follow mode. Once the solved body has already crossed into
 * stumble, this same authority can derive the missing recovery candidate from
 * real COM, support and residual momentum instead of letting recovery disappear
 * simply because ordinary gait generation is suspended.
 *
 * The chosen foot cannot flip or teleport its landing after commitment. Actual
 * solved support confirms landing, the new support accepts load, and ordinary
 * gait takes over only when its next foot targets agree with that support.
 */
export class CommittedCatchStep {
  private readonly slotById = new Int16Array(ENTITY_ID_CAP);
  private readonly foot = new Uint8Array(BODY_CAP);
  private readonly startX = new Float32Array(BODY_CAP);
  private readonly startY = new Float32Array(BODY_CAP);
  private readonly startZ = new Float32Array(BODY_CAP);
  private readonly targetX = new Float32Array(BODY_CAP);
  private readonly targetY = new Float32Array(BODY_CAP);
  private readonly targetZ = new Float32Array(BODY_CAP);
  private readonly progress = new Float32Array(BODY_CAP);
  private readonly landingFoot = new Uint8Array(BODY_CAP);
  private readonly landingX = new Float32Array(BODY_CAP);
  private readonly landingY = new Float32Array(BODY_CAP);
  private readonly landingZ = new Float32Array(BODY_CAP);
  private readonly landingHoldT = new Float32Array(BODY_CAP);
  private readonly state: MechanicalState = makeMechanicalState();
  private slotCount = 0;

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
    this.foot.fill(0);
    this.progress.fill(0);
    this.landingFoot.fill(0);
    this.landingHoldT.fill(0);
    this.slotCount = 0;
  }

  reset(a: Actor) {
    const slot = this.slot(a.id);
    if (slot < 0) return;
    this.foot[slot] = 0;
    this.progress[slot] = 0;
    this.landingFoot[slot] = 0;
    this.landingHoldT[slot] = 0;
  }

  prepare(w: World, dt: number) {
    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;

    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a) || !a.alive) continue;
      let slot = this.slot(a.id);
      if (slot < 0) slot = this.register(a);
      if (slot < 0) continue;
      const rig = this.bodies.get(a);
      if (!rig?.initialized || rig.mode === "dynamic" || rig.mode === "recover" || a.grabbedBy) {
        this.reset(a);
        continue;
      }

      if (!EDGES.committedCatchStep) {
        this.foot[slot] = 0;
        this.progress[slot] = 0;
        this.landingFoot[slot] = 0;
        this.landingHoldT[slot] = 0;
        continue;
      }

      sampleMechanicalState(w, a, rig, h, this.state);
      const scale = bodyScale(a);

      if (this.landingFoot[slot]!) {
        this.holdLanding(a, rig, slot, h, scale);
        if (this.landingFoot[slot]!) continue;
      }

      let candidate = this.correctiveCandidate(a, rig);
      if (!candidate && (a.loco === "stumble" || rig.mode === "stumble")) {
        this.offerStumbleCandidate(w, a, rig, scale);
        candidate = this.correctiveCandidate(a, rig);
      }

      let foot = this.foot[slot]!;
      if (!foot) {
        if (!candidate) continue;
        foot = candidate;
        this.begin(a, rig, slot, foot);
      } else if (candidate === foot && this.progress[slot]! < 0.58) {
        this.retarget(a, slot, foot, h, scale);
      }

      const node = foot === 1 ? BODY.lFoot : BODY.rFoot;
      const supported = foot === 1 ? this.state.leftSupported : this.state.rightSupported;
      const landingDistance = Math.hypot(
        rig.x[node]! - this.targetX[slot]!,
        rig.z[node]! - this.targetZ[slot]!,
      );
      if (
        this.progress[slot]! > 0.46 &&
        supported &&
        landingDistance < 0.13 * scale
      ) {
        this.finishLanding(a, rig, slot, foot);
        this.suppressCompetingCatch(a, rig, foot);
        continue;
      }

      this.advanceFlight(w, a, rig, slot, foot, h, scale);
      this.suppressCompetingCatch(a, rig, foot);
    }
  }

  private offerStumbleCandidate(
    w: World,
    a: Actor,
    rig: BodyRig,
    scale: number,
  ) {
    if (this.state.supportCount <= 0) return;

    let supportX = 0;
    let supportZ = 0;
    if (this.state.leftSupported) {
      supportX += rig.x[BODY.lFoot]!;
      supportZ += rig.z[BODY.lFoot]!;
    }
    if (this.state.rightSupported) {
      supportX += rig.x[BODY.rFoot]!;
      supportZ += rig.z[BODY.rFoot]!;
    }
    supportX /= this.state.supportCount;
    supportZ /= this.state.supportCount;

    let intentX = a.intendX;
    let intentZ = a.intendZ;
    const im = Math.hypot(intentX, intentZ);
    if (im > 1e-5) {
      intentX /= im;
      intentZ /= im;
    } else {
      intentX = 0;
      intentZ = 0;
    }

    const alongIntent = this.state.velX * intentX + this.state.velZ * intentZ;
    const intendedSpeed = im > 1e-5
      ? Math.max(0, Math.min(Math.max(0, a.intendSpeed), alongIntent))
      : 0;
    const residualVx = this.state.velX - intentX * intendedSpeed;
    const residualVz = this.state.velZ - intentZ * intendedSpeed;
    const residualSpeed = Math.hypot(residualVx, residualVz);

    const supportY = Math.min(rig.y[BODY.lFoot]!, rig.y[BODY.rFoot]!);
    const comH = Math.max(0.42 * scale, this.state.comY - supportY);
    const omega0 = Math.sqrt(GRAVITY / comH);
    const captureX = this.state.comX + residualVx / Math.max(1e-5, omega0);
    const captureZ = this.state.comZ + residualVz / Math.max(1e-5, omega0);
    let stepX = captureX - supportX;
    let stepZ = captureZ - supportZ;
    const error = Math.hypot(stepX, stepZ);
    const trigger = (0.18 + this.state.supportScore * 0.08) * scale;
    if (error <= trigger && this.state.disturbance < 0.22) return;

    if (error > 1e-5) {
      stepX /= error;
      stepZ /= error;
    } else if (residualSpeed > 1e-5) {
      stepX = residualVx / residualSpeed;
      stepZ = residualVz / residualSpeed;
    } else if (im > 1e-5) {
      stepX = intentX;
      stepZ = intentZ;
    } else {
      stepX = -Math.sin(a.yaw);
      stepZ = -Math.cos(a.yaw);
    }

    let foot: 1 | 2;
    if (this.state.leftSupported && !this.state.rightSupported) {
      foot = 2;
    } else if (this.state.rightSupported && !this.state.leftSupported) {
      foot = 1;
    } else {
      const rx = Math.cos(a.yaw);
      const rz = -Math.sin(a.yaw);
      const lateral = stepX * rx + stepZ * rz;
      if (Math.abs(lateral) > 0.18) {
        foot = lateral > 0 ? 2 : 1;
      } else {
        const leftAlong =
          (rig.x[BODY.lFoot]! - supportX) * stepX +
          (rig.z[BODY.lFoot]! - supportZ) * stepZ;
        const rightAlong =
          (rig.x[BODY.rFoot]! - supportX) * stepX +
          (rig.z[BODY.rFoot]! - supportZ) * stepZ;
        foot = leftAlong <= rightAlong ? 1 : 2;
      }
    }

    const speedN = clamp01(Math.max(a.intendSpeed, residualSpeed) / 6.3);
    const maxStep = (0.48 + speedN * 0.28) * scale;
    const step = Math.min(
      maxStep,
      Math.max(0.28 * scale, error + speedN * 0.1 * scale),
    );
    const tx = supportX + stepX * step + intentX * speedN * 0.06 * scale;
    const tz = supportZ + stepZ * step + intentZ * speedN * 0.06 * scale;
    const node = foot === 1 ? BODY.lFoot : BODY.rFoot;
    const floor = supportHeight(w, tx, rig.y[node]! + 0.7 * scale, tz);
    bodyTaskTargets.offerWorld(
      a,
      node,
      tx,
      floor + nodeRadius(a, node) + 0.04 * scale,
      tz,
      1,
      TASK_PRIORITY.CORRECTIVE_STEP,
    );

    const supportNode = foot === 1 ? BODY.rFoot : BODY.lFoot;
    const supportStillValid = foot === 1
      ? this.state.rightSupported
      : this.state.leftSupported;
    if (supportStillValid) {
      bodyTaskTargets.offerWorld(
        a,
        supportNode,
        rig.x[supportNode]!,
        rig.y[supportNode]!,
        rig.z[supportNode]!,
        1,
        TASK_PRIORITY.CONTACT_CRITICAL,
      );
    }
  }

  private correctiveCandidate(a: Actor, rig: BodyRig) {
    const lPriority = bodyTaskTargets.priorityFor(a, BODY.lFoot);
    const rPriority = bodyTaskTargets.priorityFor(a, BODY.rFoot);
    const left = lPriority === TASK_PRIORITY.CORRECTIVE_STEP;
    const right = rPriority === TASK_PRIORITY.CORRECTIVE_STEP;
    if (!left && !right) return 0;
    if (left && !right) return 1;
    if (right && !left) return 2;
    const lMove = Math.hypot(
      bodyTaskTargets.targetXFor(a, BODY.lFoot) - rig.x[BODY.lFoot]!,
      bodyTaskTargets.targetYFor(a, BODY.lFoot) - rig.y[BODY.lFoot]!,
      bodyTaskTargets.targetZFor(a, BODY.lFoot) - rig.z[BODY.lFoot]!,
    );
    const rMove = Math.hypot(
      bodyTaskTargets.targetXFor(a, BODY.rFoot) - rig.x[BODY.rFoot]!,
      bodyTaskTargets.targetYFor(a, BODY.rFoot) - rig.y[BODY.rFoot]!,
      bodyTaskTargets.targetZFor(a, BODY.rFoot) - rig.z[BODY.rFoot]!,
    );
    return lMove >= rMove ? 1 : 2;
  }

  private begin(a: Actor, rig: BodyRig, slot: number, foot: number) {
    const node = foot === 1 ? BODY.lFoot : BODY.rFoot;
    this.foot[slot] = foot;
    this.progress[slot] = 0;
    this.startX[slot] = rig.x[node]!;
    this.startY[slot] = rig.y[node]!;
    this.startZ[slot] = rig.z[node]!;
    this.targetX[slot] = bodyTaskTargets.targetXFor(a, node);
    this.targetY[slot] = bodyTaskTargets.targetYFor(a, node);
    this.targetZ[slot] = bodyTaskTargets.targetZFor(a, node);
    this.landingFoot[slot] = 0;
    this.landingHoldT[slot] = 0;
  }

  private retarget(a: Actor, slot: number, foot: number, dt: number, scale: number) {
    const node = foot === 1 ? BODY.lFoot : BODY.rFoot;
    const desiredX = bodyTaskTargets.targetXFor(a, node);
    const desiredZ = bodyTaskTargets.targetZFor(a, node);
    let dx = desiredX - this.targetX[slot]!;
    let dz = desiredZ - this.targetZ[slot]!;
    const d = Math.hypot(dx, dz);
    const maxMove = (0.72 + clamp01(a.intendSpeed / 6) * 0.48) * scale * dt;
    if (d > maxMove && d > 1e-6) {
      const q = maxMove / d;
      dx *= q;
      dz *= q;
    }
    this.targetX[slot] += dx;
    this.targetZ[slot] += dz;
    this.targetY[slot] = bodyTaskTargets.targetYFor(a, node);
  }

  private advanceFlight(
    w: World,
    a: Actor,
    rig: BodyRig,
    slot: number,
    foot: number,
    dt: number,
    scale: number,
  ) {
    const node = foot === 1 ? BODY.lFoot : BODY.rFoot;
    const total = Math.max(
      0.08 * scale,
      Math.hypot(
        this.targetX[slot]! - this.startX[slot]!,
        this.targetZ[slot]! - this.startZ[slot]!,
      ),
    );
    const remaining = Math.hypot(
      this.targetX[slot]! - rig.x[node]!,
      this.targetZ[slot]! - rig.z[node]!,
    );
    const achieved = clamp01(1 - remaining / total);
    const duration = Math.max(0.14, Math.min(0.3, total / (2.6 + a.intendSpeed * 0.34)));
    const clocked = Math.min(1, this.progress[slot]! + dt / duration);
    this.progress[slot] = Math.min(clocked, achieved + 0.28);

    const s = smooth01(this.progress[slot]!);
    const tx = lerp(this.startX[slot]!, this.targetX[slot]!, s);
    const tz = lerp(this.startZ[slot]!, this.targetZ[slot]!, s);
    const floor = supportHeight(w, tx, rig.y[node]! + 0.7 * scale, tz);
    const landingY = floor + nodeRadius(a, node);
    const lift = Math.sin(Math.PI * s) *
      (0.07 + total / Math.max(scale, 1e-5) * 0.055) * scale;
    const ty = Math.max(
      lerp(this.startY[slot]!, landingY, s),
      landingY + lift,
    );

    bodyTaskTargets.offerWorld(
      a,
      node,
      tx,
      ty,
      tz,
      1,
      CATCH_PRIORITY,
    );
  }

  private suppressCompetingCatch(a: Actor, rig: BodyRig, catchFoot: number) {
    const other = catchFoot === 1 ? BODY.rFoot : BODY.lFoot;
    const otherPriority = bodyTaskTargets.priorityFor(a, other);
    if (otherPriority !== TASK_PRIORITY.CORRECTIVE_STEP) return;
    const otherSupported = catchFoot === 1
      ? this.state.rightSupported
      : this.state.leftSupported;
    if (!otherSupported) return;
    bodyTaskTargets.offerWorld(
      a,
      other,
      rig.x[other]!,
      rig.y[other]!,
      rig.z[other]!,
      1,
      CATCH_PRIORITY,
    );
  }

  private finishLanding(a: Actor, rig: BodyRig, slot: number, foot: number) {
    const node = foot === 1 ? BODY.lFoot : BODY.rFoot;
    this.landingFoot[slot] = foot;
    this.landingX[slot] = rig.x[node]!;
    this.landingY[slot] = rig.y[node]!;
    this.landingZ[slot] = rig.z[node]!;
    this.landingHoldT[slot] = 0.28 - 0.1 * clamp01(a.intendSpeed / 5);
    this.foot[slot] = 0;
    this.progress[slot] = 0;
    bodyTaskTargets.offerWorld(
      a,
      node,
      this.landingX[slot]!,
      this.landingY[slot]!,
      this.landingZ[slot]!,
      1,
      CATCH_PRIORITY,
    );
  }

  private holdLanding(a: Actor, rig: BodyRig, slot: number, dt: number, scale: number) {
    const foot = this.landingFoot[slot]!;
    const node = foot === 1 ? BODY.lFoot : BODY.rFoot;
    const opposite = foot === 1 ? BODY.rFoot : BODY.lFoot;
    const supported = foot === 1 ? this.state.leftSupported : this.state.rightSupported;
    if (!supported) {
      this.landingFoot[slot] = 0;
      this.landingHoldT[slot] = 0;
      return;
    }

    const landingPriority = bodyTaskTargets.priorityFor(a, node);
    const landingMove = landingPriority > 0
      ? Math.hypot(
          bodyTaskTargets.targetXFor(a, node) - rig.x[node]!,
          bodyTaskTargets.targetYFor(a, node) - rig.y[node]!,
          bodyTaskTargets.targetZFor(a, node) - rig.z[node]!,
        )
      : 0;
    const oppositePriority = bodyTaskTargets.priorityFor(a, opposite);
    const oppositeMove = oppositePriority > 0
      ? Math.hypot(
          bodyTaskTargets.targetXFor(a, opposite) - rig.x[opposite]!,
          bodyTaskTargets.targetYFor(a, opposite) - rig.y[opposite]!,
          bodyTaskTargets.targetZFor(a, opposite) - rig.z[opposite]!,
        )
      : 0;

    this.landingHoldT[slot] = Math.max(0, this.landingHoldT[slot]! - dt);
    const gaitAgrees =
      landingMove < 0.06 * scale &&
      oppositeMove > 0.055 * scale;
    if (gaitAgrees || this.landingHoldT[slot]! <= 0) {
      this.landingFoot[slot] = 0;
      this.landingHoldT[slot] = 0;
      return;
    }

    if (landingPriority < TASK_PRIORITY.ACTION) {
      bodyTaskTargets.offerWorld(
        a,
        node,
        this.landingX[slot]!,
        this.landingY[slot]!,
        this.landingZ[slot]!,
        1,
        CATCH_PRIORITY,
      );
    }
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
