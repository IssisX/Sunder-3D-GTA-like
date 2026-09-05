import type { Actions } from "./input";
import type { Actor } from "./types";
import { GRAVITY } from "./types";
import type { World } from "./world";
import { BODY, type BodyRig } from "./body";
import { bodyScale, nodeRadius } from "./body-model";
import { supportHeight } from "./body-contacts";
import { AnimatedPhysicalBodies } from "./body-actions";
import {
  bodyTaskTargets,
  TASK_PRIORITY,
} from "./body-task-targets";
import {
  makeMechanicalState,
  sampleMechanicalState,
  type MechanicalState,
} from "./mechanical-state";

const TAU = Math.PI * 2;
const MAX_DT = 1 / 30;
const MIN_DT = 1 / 240;
const ENTITY_ID_CAP = 8192;
const ANIM_CAP = 128;
const SWING_PORTION = 0.42;

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

function human(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

function locomotionEligible(a: Actor) {
  return (
    a.alive &&
    !a.grabbedBy &&
    a.loco !== "ragdoll" &&
    a.loco !== "down" &&
    a.loco !== "getup" &&
    a.loco !== "stumble" &&
    a.loco !== "vault" &&
    a.loco !== "climb" &&
    a.loco !== "swim"
  );
}

function calmCrowdAI(a: Actor) {
  return (
    a.kind !== "player" &&
    (a.ai === "idle" ||
      a.ai === "wander" ||
      a.ai === "work" ||
      a.ai === "investigate" ||
      a.ai === "search")
  );
}

/**
 * Locomotion/task generator only.
 * Intent shaping happens before World simulation; body tasks are generated from
 * the current physical/mechanical state immediately before actuation.
 */
export class AnimationController extends AnimatedPhysicalBodies {
  private readonly slotById = new Int16Array(ENTITY_ID_CAP);
  private readonly phase = new Float32Array(ANIM_CAP);
  private readonly rootSpeed = new Float32Array(ANIM_CAP);
  private readonly runBlend = new Float32Array(ANIM_CAP);
  private readonly dirX = new Float32Array(ANIM_CAP);
  private readonly dirZ = new Float32Array(ANIM_CAP);
  private readonly lastX = new Float32Array(ANIM_CAP);
  private readonly lastZ = new Float32Array(ANIM_CAP);
  private readonly crowdPressure = new Float32Array(ANIM_CAP);

  private readonly lLocked = new Uint8Array(ANIM_CAP);
  private readonly rLocked = new Uint8Array(ANIM_CAP);
  private readonly lAnchorX = new Float32Array(ANIM_CAP);
  private readonly lAnchorY = new Float32Array(ANIM_CAP);
  private readonly lAnchorZ = new Float32Array(ANIM_CAP);
  private readonly rAnchorX = new Float32Array(ANIM_CAP);
  private readonly rAnchorY = new Float32Array(ANIM_CAP);
  private readonly rAnchorZ = new Float32Array(ANIM_CAP);
  private readonly lPoleX = new Float32Array(ANIM_CAP);
  private readonly lPoleZ = new Float32Array(ANIM_CAP);
  private readonly rPoleX = new Float32Array(ANIM_CAP);
  private readonly rPoleZ = new Float32Array(ANIM_CAP);

  private readonly mech: MechanicalState = makeMechanicalState();
  private slotCount = 0;
  private playerActionBlockT = 0;

  constructor() {
    super();
    this.slotById.fill(-1);
  }

  override bootstrap(w: World) {
    super.bootstrap(w);
    bodyTaskTargets.bootstrap(w);
    this.slotById.fill(-1);
    this.slotCount = 0;
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a)) continue;
      this.register(a);
    }
  }

  override clear() {
    super.clear();
    bodyTaskTargets.clear();
    this.slotById.fill(-1);
    this.slotCount = 0;
    this.playerActionBlockT = 0;
    this.phase.fill(0);
    this.rootSpeed.fill(0);
    this.runBlend.fill(0);
    this.dirX.fill(0);
    this.dirZ.fill(0);
    this.crowdPressure.fill(0);
    this.lLocked.fill(0);
    this.rLocked.fill(0);
  }

  override reset(a: Actor) {
    super.reset(a);
    const slot = this.slot(a.id);
    if (slot < 0) return;
    this.rootSpeed[slot] = 0;
    this.runBlend[slot] = 0;
    this.phase[slot] = ((a.id * 0.61803398875) % 1) * TAU;
    this.lastX[slot] = a.x;
    this.lastZ[slot] = a.z;
    this.lLocked[slot] = 0;
    this.rLocked[slot] = 0;
  }

  override captureInput(input: Actions) {
    if (
      input.grabPressed ||
      input.grabReleased ||
      input.kickPressed ||
      input.attackPressed ||
      input.shovePressed
    ) {
      this.playerActionBlockT = Math.max(this.playerActionBlockT, 0.42);
    }
    super.captureInput(input);
  }

  prepareStep(w: World, dt: number) {
    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;

    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a)) continue;
      let slot = this.slot(a.id);
      if (slot < 0) {
        this.register(a);
        slot = this.slot(a.id);
      }
      if (slot < 0 || !locomotionEligible(a)) continue;

      let desiredX = a.intendX;
      let desiredZ = a.intendZ;
      let desiredSpeed = a.intendSpeed;
      let pressure = 0;

      if (calmCrowdAI(a)) {
        let avoidX = 0;
        let avoidZ = 0;
        for (let j = 0; j < w.actors.length; j++) {
          if (j === i) continue;
          const b = w.actors[j]!;
          if (!human(b) || !b.alive || b.grabbedBy) continue;
          let dx = a.x - b.x;
          let dz = a.z - b.z;
          const personal = (a.radius + b.radius) * 1.65;
          let d2 = dx * dx + dz * dz;
          if (d2 >= personal * personal) continue;
          if (d2 < 1e-8) {
            const sign = ((a.id * 73856093) ^ (b.id * 19349663)) & 1 ? 1 : -1;
            dx = sign;
            dz = ((a.id + b.id) & 1) ? 0.5 : -0.5;
            d2 = dx * dx + dz * dz;
          }
          const d = Math.sqrt(d2);
          const q = 1 - d / personal;
          const wgt = q * q;
          avoidX += (dx / d) * wgt;
          avoidZ += (dz / d) * wgt;
          pressure += wgt;
        }
        if (pressure > 0) {
          const am = Math.hypot(avoidX, avoidZ);
          if (am > 1e-6) {
            avoidX /= am;
            avoidZ /= am;
            const steer = Math.min(0.9, 0.28 + pressure * 0.42);
            desiredX = desiredX * (1 - steer) + avoidX * steer;
            desiredZ = desiredZ * (1 - steer) + avoidZ * steer;
          }
          desiredSpeed *= 1 - clamp01(pressure * 0.72) * 0.86;
          if (a.ai === "work" && pressure > 0.28) desiredSpeed = Math.min(desiredSpeed, 0.32);
        }
      }
      this.crowdPressure[slot] = pressure;

      let dm = Math.hypot(desiredX, desiredZ);
      if (dm > 1e-5) {
        desiredX /= dm;
        desiredZ /= dm;
      } else {
        desiredX = this.dirX[slot]!;
        desiredZ = this.dirZ[slot]!;
      }

      const dk = 1 - Math.exp(-h * (a.kind === "player" ? 20 : 9));
      let sx = this.dirX[slot]! + (desiredX - this.dirX[slot]!) * dk;
      let sz = this.dirZ[slot]! + (desiredZ - this.dirZ[slot]!) * dk;
      dm = Math.hypot(sx, sz);
      if (dm > 1e-5) {
        sx /= dm;
        sz /= dm;
      }
      this.dirX[slot] = sx;
      this.dirZ[slot] = sz;

      const current = this.rootSpeed[slot]!;
      const speedRate = desiredSpeed > current
        ? (a.kind === "player" ? 24 : 12)
        : (a.kind === "player" ? 30 : 17);
      const root = current + (Math.max(0, desiredSpeed) - current) *
        (1 - Math.exp(-h * speedRate));
      this.rootSpeed[slot] = root;
      const rbTarget = clamp01((root - 1.55) / 3.65);
      this.runBlend[slot] += (rbTarget - this.runBlend[slot]!) *
        (1 - Math.exp(-h * 9));

      a.intendX = sx;
      a.intendZ = sz;
      a.intendSpeed = root;
    }
  }

  prepareBodyStep(w: World, dt: number) {
    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;
    bodyTaskTargets.beginStep();

    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a)) continue;
      let slot = this.slot(a.id);
      if (slot < 0) {
        this.register(a);
        slot = this.slot(a.id);
      }
      if (slot < 0) continue;

      const traveled = Math.hypot(
        a.x - this.lastX[slot]!,
        a.z - this.lastZ[slot]!,
      );
      this.lastX[slot] = a.x;
      this.lastZ[slot] = a.z;

      const rig = this.get(a);
      let physicalSpeed = traveled / Math.max(h, 1e-5);
      if (rig?.initialized) {
        sampleMechanicalState(w, a, rig, h, this.mech);
        physicalSpeed = Math.hypot(this.mech.velX, this.mech.velZ);
      }

      // Phase-matched cadence. Physical COM velocity remains the primary source,
      // but intent contributes enough phase to initiate stepping instead of the
      // old self-locking "must already move before feet can move" loop.
      const commandSpeed = this.rootSpeed[slot]!;
      const intentBlend =
        a.kind === "player"
          ? 0.72
          : calmCrowdAI(a)
            ? 0.14
            : 0.4;
      const phaseSpeed =
        physicalSpeed + Math.max(0, commandSpeed - physicalSpeed) * intentBlend;
      // A planted leg cannot cover more than its fore/aft reach while
      // the body passes over it. The old sprint cycle asked a 0.68 m leg
      // to remain planted across 1.48 m, lifting both feet and stalling.
      const stanceTravel = lerp(0.58, 0.78,
        this.runBlend[slot]!) * bodyScale(a);
      const cycleDistance = stanceTravel / (1 - SWING_PORTION);
      if (phaseSpeed > 0.035 && cycleDistance > 1e-5) {
        const adv = Math.min(0.5, (phaseSpeed * h / cycleDistance) * TAU);
        let p = this.phase[slot]! + adv;
        if (p >= TAU) p -= TAU * Math.floor(p / TAU);
        this.phase[slot] = p;
      }
      a.walkPhase = this.phase[slot]!;

      if (!locomotionEligible(a)) continue;
      if (!rig?.initialized || rig.mode !== "follow") continue;
      this.writeLocomotionTasks(w, a, rig, slot);
    }
  }

  override step(w: World, dt: number) {
    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;
    super.step(w, h);
    this.playerActionBlockT = Math.max(0, this.playerActionBlockT - h);
  }

  private writeLocomotionTasks(
    w: World,
    a: Actor,
    rig: BodyRig,
    slot: number,
  ) {
    const scale = bodyScale(a);
    const p = this.phase[slot]!;
    const rb = this.runBlend[slot]!;
    const speed = this.rootSpeed[slot]!;
    const speedN = clamp01(speed / 6.3);
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    const rx = Math.cos(a.yaw);
    const rz = -Math.sin(a.yaw);

    let moveX = this.dirX[slot]!;
    let moveZ = this.dirZ[slot]!;
    let mm = Math.hypot(moveX, moveZ);
    if (mm < 1e-5) {
      moveX = fx;
      moveZ = fz;
      mm = 1;
    }
    moveX /= mm;
    moveZ /= mm;

    const localForward = moveX * fx + moveZ * fz;
    const localSide = moveX * rx + moveZ * rz;
    // Keep stance targets reachable as horizontal stride grows. Without
    // lowering the hips, IK shortens a long step by lifting its support foot.
    const halfSpan = lerp(0.29, 0.39, rb) * speedN;
    const stanceDrop = 0.68 - Math.sqrt(
      Math.max(0, 0.68 ** 2 - halfSpan ** 2));
    const bob = Math.cos(p * 2) * lerp(0.008, 0.024, rb)
      * speedN - stanceDrop;
    const sway = Math.sin(p) * lerp(0.012, 0.035, rb) * speedN;
    const pitch = -localForward * lerp(0.025, 0.11, rb) * speedN;
    const roll = -localSide * lerp(0.035, 0.1, rb) * speedN;

    bodyTaskTargets.offerLocal(a, BODY.pelvis, sway + roll * 0.18, 0.82 + bob, pitch * 0.22, 1, TASK_PRIORITY.LOCOMOTION);
    bodyTaskTargets.offerLocal(a, BODY.chest, -sway * 0.55 - roll * 0.12, 1.2 + bob * 0.45, -pitch + localSide * 0.025 * speedN, 1, TASK_PRIORITY.LOCOMOTION);
    bodyTaskTargets.offerLocal(a, BODY.head, -sway * 0.25, 1.58 + bob * 0.18, -pitch * 0.35, 0.82, TASK_PRIORITY.LOCOMOTION);

    const hipTwist = Math.sin(p) * 0.045 * speedN;
    bodyTaskTargets.offerLocal(a, BODY.lHip, -0.13, 0.76 + bob, hipTwist, 0.9, TASK_PRIORITY.LOCOMOTION);
    bodyTaskTargets.offerLocal(a, BODY.rHip, 0.13, 0.76 + bob, -hipTwist, 0.9, TASK_PRIORITY.LOCOMOTION);

    sampleMechanicalState(w, a, rig, 1 / 60, this.mech);
    const corrected = this.offerCorrectiveStep(w, a, rig, slot, moveX, moveZ, rb, speedN);

    const lU = p / TAU;
    let rU = lU + 0.5;
    if (rU >= 1) rU -= 1;
    if (corrected !== 1) this.offerFootTask(w, a, rig, slot, true, lU, moveX, moveZ, rb, speedN);
    if (corrected !== 2) this.offerFootTask(w, a, rig, slot, false, rU, moveX, moveZ, rb, speedN);

    const arm = Math.sin(p) * lerp(0.14, 0.42, rb) * speedN;
    const sideCounter = localSide * 0.08 * speedN;
    bodyTaskTargets.offerLocal(a, BODY.lShoulder, -0.27, 1.31 + bob * 0.35, -hipTwist - sideCounter, 0.82, TASK_PRIORITY.LOCOMOTION);
    bodyTaskTargets.offerLocal(a, BODY.rShoulder, 0.27, 1.31 + bob * 0.35, hipTwist + sideCounter, 0.82, TASK_PRIORITY.LOCOMOTION);
    bodyTaskTargets.offerLocal(a, BODY.lElbow, -0.36, 1.04 + Math.abs(arm) * 0.035, -arm * 0.52, 0.8, TASK_PRIORITY.LOCOMOTION);
    bodyTaskTargets.offerLocal(a, BODY.lHand, -0.35, 0.81 + Math.abs(arm) * 0.04, -arm, 0.78, TASK_PRIORITY.LOCOMOTION);
    bodyTaskTargets.offerLocal(a, BODY.rElbow, 0.36, 1.04 + Math.abs(arm) * 0.035, arm * 0.52, 0.8, TASK_PRIORITY.LOCOMOTION);
    bodyTaskTargets.offerLocal(a, BODY.rHand, 0.35, 0.81 + Math.abs(arm) * 0.04, arm, 0.78, TASK_PRIORITY.LOCOMOTION);
  }

  private offerCorrectiveStep(
    w: World,
    a: Actor,
    rig: BodyRig,
    slot: number,
    moveX: number,
    moveZ: number,
    runBlend: number,
    speedN: number,
  ) {
    if (this.mech.supportCount <= 0) return 0;
    const scale = bodyScale(a);
    let supportX = 0;
    let supportZ = 0;
    if (this.mech.leftSupported) {
      supportX += rig.x[BODY.lFoot]!;
      supportZ += rig.z[BODY.lFoot]!;
    }
    if (this.mech.rightSupported) {
      supportX += rig.x[BODY.rFoot]!;
      supportZ += rig.z[BODY.rFoot]!;
    }
    supportX /= this.mech.supportCount;
    supportZ /= this.mech.supportCount;

    const supportY = Math.min(rig.y[BODY.lFoot]!, rig.y[BODY.rFoot]!);
    const comH = Math.max(0.42 * scale, this.mech.comY - supportY);
    const omega0 = Math.sqrt(GRAVITY / comH);
    const captureX = this.mech.comX + this.mech.velX / Math.max(1e-5, omega0);
    const captureZ = this.mech.comZ + this.mech.velZ / Math.max(1e-5, omega0);
    let ex = captureX - supportX;
    let ez = captureZ - supportZ;
    const err = Math.hypot(ex, ez);
    const trigger = (0.22 + this.mech.supportScore * 0.08) * scale;
    if (err <= trigger && this.mech.disturbance < 0.3) return 0;

    if (err > 1e-5) {
      ex /= err;
      ez /= err;
    } else {
      ex = moveX;
      ez = moveZ;
    }

    let foot: 1 | 2;
    if (this.mech.leftSupported && !this.mech.rightSupported) foot = 2;
    else if (this.mech.rightSupported && !this.mech.leftSupported) foot = 1;
    else {
      const rx = Math.cos(a.yaw);
      const rz = -Math.sin(a.yaw);
      const lateral = ex * rx + ez * rz;
      if (Math.abs(lateral) > 0.18) foot = lateral > 0 ? 2 : 1;
      else foot = (this.phase[slot]! / TAU) < 0.5 ? 1 : 2;
    }

    const maxStep = lerp(0.42, 0.76, runBlend) * scale;
    const step = Math.min(maxStep, Math.max(0.28 * scale, err + speedN * 0.12 * scale));
    const tx = supportX + ex * step + moveX * speedN * 0.08 * scale;
    const tz = supportZ + ez * step + moveZ * speedN * 0.08 * scale;
    const node = foot === 1 ? BODY.lFoot : BODY.rFoot;
    const currentY = rig.y[node]!;
    const floor = supportHeight(w, tx, currentY + 0.65 * scale, tz);
    const ty = floor + nodeRadius(a, node) + 0.045 * scale;
    this.solveLegTask(a, rig, foot === 1, tx, ty, tz, 1, ex, ez, TASK_PRIORITY.CORRECTIVE_STEP);
    if (foot === 1) this.lLocked[slot] = 0;
    else this.rLocked[slot] = 0;
    return foot;
  }

  private offerFootTask(
    w: World,
    a: Actor,
    rig: BodyRig,
    slot: number,
    left: boolean,
    u: number,
    moveX: number,
    moveZ: number,
    runBlend: number,
    speedN: number,
  ) {
    const footNode = left ? BODY.lFoot : BODY.rFoot;
    const side = left ? -1 : 1;
    const swing = u < SWING_PORTION;
    const scale = bodyScale(a);
    let tx: number;
    let ty: number;
    let tz: number;

    if (!swing && speedN > 0.035) {
      const locked = left ? this.lLocked[slot]! : this.rLocked[slot]!;
      if (!locked) {
        if (left) {
          this.lLocked[slot] = 1;
          this.lAnchorX[slot] = rig.x[footNode]!;
          this.lAnchorY[slot] = rig.y[footNode]!;
          this.lAnchorZ[slot] = rig.z[footNode]!;
        } else {
          this.rLocked[slot] = 1;
          this.rAnchorX[slot] = rig.x[footNode]!;
          this.rAnchorY[slot] = rig.y[footNode]!;
          this.rAnchorZ[slot] = rig.z[footNode]!;
        }
      }
      tx = left ? this.lAnchorX[slot]! : this.rAnchorX[slot]!;
      ty = left ? this.lAnchorY[slot]! : this.rAnchorY[slot]!;
      tz = left ? this.lAnchorZ[slot]! : this.rAnchorZ[slot]!;
    } else {
      if (left) this.lLocked[slot] = 0;
      else this.rLocked[slot] = 0;
      const rx = Math.cos(a.yaw);
      const rz = -Math.sin(a.yaw);
      const lateral = side * 0.13 * scale;
      if (speedN <= 0.035) {
        tx = a.x + rx * lateral;
        tz = a.z + rz * lateral;
        ty = supportHeight(w, tx, a.y + 0.5 * scale, tz) + nodeRadius(a, footNode);
      } else {
        const s = smooth01(u / SWING_PORTION);
        const stride = lerp(0.34, 0.78, runBlend) * scale;
        const along = (-0.5 + s) * stride;
        const lift = Math.sin(Math.PI * s) * lerp(0.075, 0.17, runBlend) * scale;
        tx = a.x + rx * lateral + moveX * along;
        tz = a.z + rz * lateral + moveZ * along;
        const floor = supportHeight(w, tx, a.y + 0.6 * scale, tz);
        ty = floor + nodeRadius(a, footNode) + lift;
      }
    }
    this.solveLegTask(a, rig, left, tx, ty, tz, 1, moveX, moveZ, TASK_PRIORITY.LOCOMOTION);
  }

  private solveLegTask(
    a: Actor,
    rig: BodyRig,
    left: boolean,
    tx: number,
    ty: number,
    tz: number,
    strength: number,
    moveX: number,
    moveZ: number,
    priority: number,
  ) {
    const hipNode = left ? BODY.lHip : BODY.rHip;
    const kneeNode = left ? BODY.lKnee : BODY.rKnee;
    const footNode = left ? BODY.lFoot : BODY.rFoot;
    const slot = this.slot(a.id);
    const scale = bodyScale(a);
    const upper = 0.34 * scale;
    const lower = 0.34 * scale;
    const hx = rig.x[hipNode]!;
    const hy = rig.y[hipNode]!;
    const hz = rig.z[hipNode]!;
    let dx = tx - hx;
    let dy = ty - hy;
    let dz = tz - hz;
    let d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return;
    dx /= d;
    dy /= d;
    dz /= d;
    const minReach = Math.abs(upper - lower) + 0.015 * scale;
    const maxReach = (upper + lower) * 0.985;
    const reach = d < minReach ? minReach : d > maxReach ? maxReach : d;
    const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
    const bend = Math.sqrt(Math.max(0, upper * upper - along * along));

    const side = left ? -1 : 1;
    const rx = Math.cos(a.yaw) * side;
    const rz = -Math.sin(a.yaw) * side;
    let desiredPoleX = moveX * 0.92 + rx * 0.18;
    let desiredPoleZ = moveZ * 0.92 + rz * 0.18;
    let pm = Math.hypot(desiredPoleX, desiredPoleZ);
    if (pm < 1e-5) {
      desiredPoleX = rx;
      desiredPoleZ = rz;
      pm = Math.hypot(rx, rz) || 1;
    }
    desiredPoleX /= pm;
    desiredPoleZ /= pm;
    if (slot >= 0) {
      const poleX = left ? this.lPoleX : this.rPoleX;
      const poleZ = left ? this.lPoleZ : this.rPoleZ;
      if (Math.abs(poleX[slot]!) + Math.abs(poleZ[slot]!) < 1e-5) {
        poleX[slot] = desiredPoleX;
        poleZ[slot] = desiredPoleZ;
      } else {
        poleX[slot] += (desiredPoleX - poleX[slot]!) * 0.22;
        poleZ[slot] += (desiredPoleZ - poleZ[slot]!) * 0.22;
      }
      desiredPoleX = poleX[slot]!;
      desiredPoleZ = poleZ[slot]!;
    }

    let px = desiredPoleX;
    let py = -0.18;
    let pz = desiredPoleZ;
    const proj = px * dx + py * dy + pz * dz;
    px -= dx * proj;
    py -= dy * proj;
    pz -= dz * proj;
    pm = Math.hypot(px, py, pz);
    if (pm < 1e-6) {
      px = rx;
      py = 0;
      pz = rz;
      pm = Math.hypot(px, pz) || 1;
    }
    px /= pm;
    py /= pm;
    pz /= pm;

    bodyTaskTargets.offerWorld(
      a,
      kneeNode,
      hx + dx * along + px * bend,
      hy + dy * along + py * bend,
      hz + dz * along + pz * bend,
      strength,
      priority,
    );
    bodyTaskTargets.offerWorld(
      a,
      footNode,
      hx + dx * reach,
      hy + dy * reach,
      hz + dz * reach,
      strength,
      priority,
    );
  }

  private register(a: Actor) {
    if (a.id < 0 || a.id >= ENTITY_ID_CAP || this.slotCount >= ANIM_CAP) return;
    const existing = this.slotById[a.id]!;
    if (existing >= 0) return;
    const slot = this.slotCount++;
    this.slotById[a.id] = slot;
    this.phase[slot] = ((a.id * 0.61803398875) % 1) * TAU;
    this.lastX[slot] = a.x;
    this.lastZ[slot] = a.z;
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    this.dirX[slot] = fx;
    this.dirZ[slot] = fz;
    this.lPoleX[slot] = fx;
    this.lPoleZ[slot] = fz;
    this.rPoleX[slot] = fx;
    this.rPoleZ[slot] = fz;
  }

  private slot(id: number) {
    return id < 0 || id >= ENTITY_ID_CAP ? -1 : this.slotById[id]!;
  }
}

