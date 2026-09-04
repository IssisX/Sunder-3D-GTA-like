import * as THREE from "three";
import type { Actions } from "./input";
import type { Actor } from "./types";
import type { World } from "./world";
import { BODY, type BodyRig } from "./body";
import { bodyScale } from "./body-model";
import { AnimatedPhysicalBodies } from "./body-actions";

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

  private slotCount = 0;
  private playerActionBlockT = 0;

  private readonly v0 = new THREE.Vector3();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly q0 = new THREE.Quaternion();
  private readonly e0 = new THREE.Euler(0, 0, 0, "XYZ");

  constructor() {
    super();
    this.slotById.fill(-1);
  }

  override bootstrap(w: World) {
    super.bootstrap(w);
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
      const slot = this.slot(a.id);
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
            const s = ((a.id * 73856093) ^ (b.id * 19349663)) & 1 ? 1 : -1;
            dx = s;
            dz = ((a.id + b.id) & 1) ? 0.5 : -0.5;
            d2 = dx * dx + dz * dz;
          }

          const d = Math.sqrt(d2);
          const inv = 1 / d;
          const q = 1 - d / personal;
          const wgt = q * q;
          avoidX += dx * inv * wgt;
          avoidZ += dz * inv * wgt;
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

          const crowdBrake = clamp01(pressure * 0.72);
          desiredSpeed *= 1 - crowdBrake * 0.86;
          if (a.ai === "work" && pressure > 0.28) {
            desiredSpeed = Math.min(desiredSpeed, 0.32);
          }
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

      const dirRate = a.kind === "player" ? 20 : 9;
      const dk = 1 - Math.exp(-h * dirRate);
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
      const sk = 1 - Math.exp(-h * speedRate);
      const root = current + (Math.max(0, desiredSpeed) - current) * sk;
      this.rootSpeed[slot] = root;

      const rbTarget = clamp01((root - 1.55) / 3.65);
      this.runBlend[slot] +=
        (rbTarget - this.runBlend[slot]!) *
        (1 - Math.exp(-h * 9));

      a.intendX = sx;
      a.intendZ = sz;
      a.intendSpeed = root;

      const recentlyHit = w.time - a.lastHitT < 0.18;
      const actionLocked =
        a.strikeT > 0 ||
        a.kickT > 0 ||
        a.shoveT > 0 ||
        Boolean(a.grabbedId);

      if (!recentlyHit && !actionLocked) {
        const vk = 1 - Math.exp(-h * (a.kind === "player" ? 18 : 11));
        a.vx += (sx * root - a.vx) * vk;
        a.vz += (sz * root - a.vz) * vk;
      }
    }
  }

  override step(w: World, dt: number) {
    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;
    super.step(w, h);
    this.playerActionBlockT = Math.max(0, this.playerActionBlockT - h);

    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a)) continue;
      const slot = this.slot(a.id);
      if (slot < 0) continue;

      const dx = a.x - this.lastX[slot]!;
      const dz = a.z - this.lastZ[slot]!;
      const traveled = Math.hypot(dx, dz);
      this.lastX[slot] = a.x;
      this.lastZ[slot] = a.z;

      const rb = this.runBlend[slot]!;
      const stride = lerp(0.54, 1.08, rb) * bodyScale(a);
      if (traveled > 1e-5 && stride > 1e-5) {
        const adv = Math.min(1.15, (traveled / stride) * TAU);
        let p = this.phase[slot]! + adv;
        if (p >= TAU) p -= TAU * Math.floor(p / TAU);
        this.phase[slot] = p;
      }
      a.walkPhase = this.phase[slot]!;

      if (calmCrowdAI(a) && this.crowdPressure[slot]! > 0.2) {
        const speed = Math.hypot(a.vx, a.vz);
        if (speed < 0.42) {
          a.vx *= 0.38;
          a.vz *= 0.38;
          if (Math.abs(a.vx) < 0.018) a.vx = 0;
          if (Math.abs(a.vz) < 0.018) a.vz = 0;
        }
      }

      const rig = this.get(a);
      if (!rig?.initialized || rig.mode !== "follow") continue;

      const explicitAction =
        a.strikeT > 0 ||
        a.kickT > 0 ||
        a.shoveT > 0 ||
        Boolean(a.grabbedId) ||
        Boolean(a.grabbedBy) ||
        (a.kind === "player" && this.playerActionBlockT > 0);

      if (!locomotionEligible(a) || explicitAction) continue;
      this.applyLocomotionPose(a, rig, slot);
    }
  }

  private register(a: Actor) {
    if (
      a.id < 0 ||
      a.id >= ENTITY_ID_CAP ||
      this.slotCount >= ANIM_CAP
    ) {
      return;
    }
    const slot = this.slotCount++;
    this.slotById[a.id] = slot;
    this.phase[slot] = ((a.id * 0.61803398875) % 1) * TAU;
    this.lastX[slot] = a.x;
    this.lastZ[slot] = a.z;

    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    this.dirX[slot] = fx;
    this.dirZ[slot] = fz;
  }

  private slot(id: number) {
    if (id < 0 || id >= ENTITY_ID_CAP) return -1;
    return this.slotById[id]!;
  }

  private setLocal(
    a: Actor,
    rig: BodyRig,
    node: number,
    lx: number,
    ly: number,
    lz: number,
    strength: number,
  ) {
    if (strength <= 0) return;
    const scale = bodyScale(a);
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    const rx = Math.cos(a.yaw);
    const rz = -Math.sin(a.yaw);
    const tx = a.x + rx * lx * scale + fx * lz * scale;
    const ty = a.y + ly * scale;
    const tz = a.z + rz * lx * scale + fz * lz * scale;
    rig.x[node] += (tx - rig.x[node]!) * strength;
    rig.y[node] += (ty - rig.y[node]!) * strength;
    rig.z[node] += (tz - rig.z[node]!) * strength;
  }

  private applyLocomotionPose(a: Actor, rig: BodyRig, slot: number) {
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
    const bob = Math.cos(p * 2) * lerp(0.008, 0.024, rb) * speedN;
    const sway = Math.sin(p) * lerp(0.012, 0.035, rb) * speedN;

    const pitch = -localForward * lerp(0.025, 0.11, rb) * speedN;
    const roll = -localSide * lerp(0.035, 0.1, rb) * speedN;
    this.e0.set(pitch, 0, roll, "XYZ");
    this.q0.setFromEuler(this.e0);
    this.v0.set(sway, 0, lerp(0.015, 0.07, rb) * speedN);
    this.v0.applyQuaternion(this.q0);

    this.setLocal(a, rig, BODY.pelvis, this.v0.x, 0.82 + bob, this.v0.z * 0.25, 0.68);
    this.setLocal(a, rig, BODY.chest, -this.v0.x * 0.55, 1.2 + bob * 0.45 + this.v0.y, this.v0.z, 0.64);
    this.setLocal(a, rig, BODY.head, -this.v0.x * 0.25, 1.58 + bob * 0.18, this.v0.z * 0.42, 0.42);

    const hipTwist = Math.sin(p) * 0.045 * speedN;
    this.setLocal(a, rig, BODY.lHip, -0.13, 0.76 + bob, hipTwist, 0.54);
    this.setLocal(a, rig, BODY.rHip, 0.13, 0.76 + bob, -hipTwist, 0.54);

    const lU = p / TAU;
    let rU = lU + 0.5;
    if (rU >= 1) rU -= 1;

    this.placeFoot(a, rig, slot, true, lU, moveX, moveZ, rb, speedN);
    this.placeFoot(a, rig, slot, false, rU, moveX, moveZ, rb, speedN);

    const arm = Math.sin(p) * lerp(0.14, 0.42, rb) * speedN;
    const sideCounter = localSide * 0.08 * speedN;
    this.setLocal(a, rig, BODY.lShoulder, -0.27, 1.31 + bob * 0.35, -hipTwist - sideCounter, 0.52);
    this.setLocal(a, rig, BODY.rShoulder, 0.27, 1.31 + bob * 0.35, hipTwist + sideCounter, 0.52);
    this.setLocal(a, rig, BODY.lElbow, -0.36, 1.04 + Math.abs(arm) * 0.035, -arm * 0.52, 0.62);
    this.setLocal(a, rig, BODY.lHand, -0.35, 0.81 + Math.abs(arm) * 0.04, -arm, 0.68);
    this.setLocal(a, rig, BODY.rElbow, 0.36, 1.04 + Math.abs(arm) * 0.035, arm * 0.52, 0.62);
    this.setLocal(a, rig, BODY.rHand, 0.35, 0.81 + Math.abs(arm) * 0.04, arm, 0.68);
  }

  private placeFoot(
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

      if (left) {
        tx = this.lAnchorX[slot]!;
        ty = this.lAnchorY[slot]!;
        tz = this.lAnchorZ[slot]!;
      } else {
        tx = this.rAnchorX[slot]!;
        ty = this.rAnchorY[slot]!;
        tz = this.rAnchorZ[slot]!;
      }
    } else {
      if (left) this.lLocked[slot] = 0;
      else this.rLocked[slot] = 0;

      const rx = Math.cos(a.yaw);
      const rz = -Math.sin(a.yaw);
      const lateral = side * 0.13 * scale;

      if (speedN <= 0.035) {
        tx = a.x + rx * lateral;
        ty = a.y + 0.08 * scale;
        tz = a.z + rz * lateral;
      } else {
        const s = smooth01(u / SWING_PORTION);
        const stride = lerp(0.34, 0.78, runBlend) * scale;
        const along = (-0.5 + s) * stride;
        const lift = Math.sin(Math.PI * s) * lerp(0.075, 0.17, runBlend) * scale;
        tx = a.x + rx * lateral + moveX * along;
        ty = a.y + (0.08 * scale) + lift;
        tz = a.z + rz * lateral + moveZ * along;
      }
    }

    this.solveLegIK(a, rig, left, tx, ty, tz, 0.9, moveX, moveZ);
  }

  private solveLegIK(
    a: Actor,
    rig: BodyRig,
    left: boolean,
    tx: number,
    ty: number,
    tz: number,
    strength: number,
    moveX: number,
    moveZ: number,
  ) {
    const hipNode = left ? BODY.lHip : BODY.rHip;
    const kneeNode = left ? BODY.lKnee : BODY.rKnee;
    const footNode = left ? BODY.lFoot : BODY.rFoot;
    const scale = bodyScale(a);
    const upper = 0.34 * scale;
    const lower = 0.34 * scale;

    this.v0.set(rig.x[hipNode]!, rig.y[hipNode]!, rig.z[hipNode]!);
    this.v1.set(tx, ty, tz);
    this.v2.subVectors(this.v1, this.v0);

    let d = this.v2.length();
    if (d < 1e-6) return;
    this.v2.multiplyScalar(1 / d);

    const minReach = Math.abs(upper - lower) + 0.015 * scale;
    const maxReach = (upper + lower) * 0.985;
    const reach = d < minReach ? minReach : d > maxReach ? maxReach : d;
    const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
    const bend = Math.sqrt(Math.max(0, upper * upper - along * along));

    const side = left ? -1 : 1;
    const rx = Math.cos(a.yaw);
    const rz = -Math.sin(a.yaw);

    this.v3.set(moveX * 0.92 + rx * side * 0.18, -0.18, moveZ * 0.92 + rz * side * 0.18);
    const proj = this.v3.dot(this.v2);
    this.v3.addScaledVector(this.v2, -proj);
    d = this.v3.length();
    if (d < 1e-6) {
      this.v3.set(rx * side, 0, rz * side);
      d = this.v3.length() || 1;
    }
    this.v3.multiplyScalar(1 / d);

    const kx = this.v0.x + this.v2.x * along + this.v3.x * bend;
    const ky = this.v0.y + this.v2.y * along + this.v3.y * bend;
    const kz = this.v0.z + this.v2.z * along + this.v3.z * bend;

    rig.x[kneeNode] += (kx - rig.x[kneeNode]!) * strength;
    rig.y[kneeNode] += (ky - rig.y[kneeNode]!) * strength;
    rig.z[kneeNode] += (kz - rig.z[kneeNode]!) * strength;

    const fx = this.v0.x + this.v2.x * reach;
    const fy = this.v0.y + this.v2.y * reach;
    const fz = this.v0.z + this.v2.z * reach;
    rig.x[footNode] += (fx - rig.x[footNode]!) * strength;
    rig.y[footNode] += (fy - rig.y[footNode]!) * strength;
    rig.z[footNode] += (fz - rig.z[footNode]!) * strength;
  }
}
