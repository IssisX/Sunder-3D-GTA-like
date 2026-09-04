import * as THREE from "three";
import type { Actions } from "./input";
import type { Actor } from "./types";
import { WEAPON_STATS } from "./types";
import type { World } from "./world";
import { BODY, type BodyRig, type PhysicalBodies } from "./body";
import { CONTACT_NODES, NODE_REGION, bodyScale, nodeRadius } from "./body-model";
import { applyActorMeleeContact, applyPropMeleeContact } from "./melee-contact";

const ENTITY_ID_CAP = 8192;
const ACTION_CAP = 128;
const NONE = 0;
const STRIKE = 1;
const KICK = 2;
const MIN_DT = 1 / 240;
const MAX_DT = 1 / 30;
const ARM_UPPER = 0.294;
const ARM_LOWER = 0.262;
const LEG_UPPER = 0.34;
const LEG_LOWER = 0.34;

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smooth01(v: number) {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

function smoother01(v: number) {
  const t = clamp01(v);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function pulse(u: number, start: number, peak: number, end: number) {
  if (u <= start || u >= end) return 0;
  if (u < peak) return smoother01((u - start) / Math.max(1e-5, peak - start));
  return 1 - smoother01((u - peak) / Math.max(1e-5, end - peak));
}

function human(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

function canAct(a: Actor) {
  return (
    a.alive &&
    a.consciousness > 0.35 &&
    !a.grabbedBy &&
    !a.grabbedId &&
    a.loco !== "ragdoll" &&
    a.loco !== "down" &&
    a.loco !== "getup" &&
    a.loco !== "vault" &&
    a.loco !== "climb" &&
    a.loco !== "swim"
  );
}

function segmentPointDist2(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  px: number,
  py: number,
  pz: number,
) {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const den = abx * abx + aby * aby + abz * abz;
  const t = den > 1e-9 ? clamp01((apx * abx + apy * aby + apz * abz) / den) : 0;
  const qx = ax + abx * t - px;
  const qy = ay + aby * t - py;
  const qz = az + abz * t - pz;
  return qx * qx + qy * qy + qz * qz;
}

export class MeleeKinematics {
  private readonly slotById = new Int16Array(ENTITY_ID_CAP);
  private readonly actorId = new Int32Array(ACTION_CAP);
  private readonly kind = new Uint8Array(ACTION_CAP);
  private readonly time = new Float32Array(ACTION_CAP);
  private readonly duration = new Float32Array(ACTION_CAP);
  private readonly hitId = new Int32Array(ACTION_CAP);
  private readonly hasPrev = new Uint8Array(ACTION_CAP);
  private readonly prevX = new Float32Array(ACTION_CAP);
  private readonly prevY = new Float32Array(ACTION_CAP);
  private readonly prevZ = new Float32Array(ACTION_CAP);
  private readonly supportX = new Float32Array(ACTION_CAP);
  private readonly supportY = new Float32Array(ACTION_CAP);
  private readonly supportZ = new Float32Array(ACTION_CAP);
  private slotCount = 0;
  private playerStrikeQueued = false;
  private playerKickQueued = false;

  private readonly v0 = new THREE.Vector3();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly q0 = new THREE.Quaternion();
  private readonly e0 = new THREE.Euler(0, 0, 0, "XYZ");

  constructor(private readonly bodies: PhysicalBodies) {
    this.slotById.fill(-1);
    this.hitId.fill(-1);
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
    this.actorId.fill(0);
    this.kind.fill(0);
    this.time.fill(0);
    this.duration.fill(0);
    this.hitId.fill(-1);
    this.hasPrev.fill(0);
    this.slotCount = 0;
    this.playerStrikeQueued = false;
    this.playerKickQueued = false;
  }

  reset(a: Actor) {
    const slot = this.slot(a.id);
    if (slot < 0) return;
    this.kind[slot] = NONE;
    this.time[slot] = 0;
    this.duration[slot] = 0;
    this.hitId[slot] = -1;
    this.hasPrev[slot] = 0;
  }

  captureInput(input: Actions) {
    let captured = false;
    if (input.attackPressed) {
      this.playerStrikeQueued = true;
      input.attackPressed = false;
      captured = true;
    }
    if (input.kickPressed) {
      this.playerKickQueued = true;
      input.kickPressed = false;
      captured = true;
    }
    return captured;
  }

  prepareInput(w: World, input: Actions) {
    input.attackPressed = false;
    input.kickPressed = false;
    const p = w.player();
    let slot = this.slot(p.id);
    if (slot < 0 && human(p)) slot = this.register(p);

    if (slot >= 0 && this.kind[slot] === NONE && canAct(p)) {
      if (this.playerKickQueued && p.grounded) {
        this.begin(p, slot, KICK);
      } else if (this.playerStrikeQueued && p.strikeCd <= 0) {
        this.begin(p, slot, STRIKE);
      }
    }
    this.playerStrikeQueued = false;
    this.playerKickQueued = false;

    if (slot >= 0 && this.kind[slot] !== NONE) {
      const u = this.time[slot]! / Math.max(1e-5, this.duration[slot]!);
      const move = this.kind[slot] === KICK ? 0.22 : 0.48 + pulse(u, 0.2, 0.45, 0.72) * 0.18;
      input.moveX *= move;
      input.moveY *= move;
      input.sprint = false;
    }
  }

  prepareStep(w: World, dt: number) {
    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;
    const player = w.player();

    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a)) continue;
      let slot = this.slot(a.id);
      if (slot < 0) slot = this.register(a);
      if (slot < 0) continue;

      if (
        a.kind !== "player" &&
        this.kind[slot] === NONE &&
        a.faction === "guard" &&
        a.attackCd <= 0 &&
        a.known.includes(player.id) &&
        canAct(a)
      ) {
        const dx = player.x - a.x;
        const dz = player.z - a.z;
        const reach = WEAPON_STATS[a.weapon].reach + player.radius + 0.35;
        if (dx * dx + dz * dz <= reach * reach) {
          this.begin(a, slot, STRIKE);
          a.attackCd = 0.7 / (0.7 + a.competence);
          a.targetId = player.id;
        }
      }

      if (this.kind[slot] === NONE) continue;
      if (!canAct(a)) {
        this.end(slot);
        continue;
      }

      const u = this.time[slot]! / Math.max(1e-5, this.duration[slot]!);
      const fx = -Math.sin(a.yaw);
      const fz = -Math.cos(a.yaw);
      if (this.kind[slot] === STRIKE) {
        const drive = pulse(u, 0.16, 0.48, 0.72);
        a.intendSpeed = Math.min(a.intendSpeed, 0.55 + drive * 0.8);
        a.vx += fx * drive * h * 3.8;
        a.vz += fz * drive * h * 3.8;
      } else {
        const drive = pulse(u, 0.26, 0.58, 0.74);
        a.intendSpeed = Math.min(a.intendSpeed, 0.2);
        a.vx *= 1 - Math.min(0.5, h * 7);
        a.vz *= 1 - Math.min(0.5, h * 7);
        a.vx += fx * drive * h * 1.5;
        a.vz += fz * drive * h * 1.5;
      }
    }
  }

  step(w: World, dt: number) {
    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a)) continue;
      const slot = this.slot(a.id);
      if (slot < 0 || this.kind[slot] === NONE) continue;
      const rig = this.bodies.get(a);
      if (!rig?.initialized || rig.mode !== "follow" || !canAct(a)) {
        this.end(slot);
        continue;
      }

      this.time[slot] += h;
      const u = clamp01(this.time[slot]! / Math.max(1e-5, this.duration[slot]!));
      if (this.kind[slot] === STRIKE) this.applyStrikePose(a, rig, u);
      else this.applyKickPose(a, rig, slot, u);

      this.resolveContact(w, a, rig, slot, h, u);
      if (u >= 1) this.end(slot);
    }
  }

  isActive(id: number) {
    const slot = this.slot(id);
    return slot >= 0 && this.kind[slot] !== NONE;
  }

  private register(a: Actor) {
    if (a.id < 0 || a.id >= ENTITY_ID_CAP || this.slotCount >= ACTION_CAP) return -1;
    const existing = this.slotById[a.id]!;
    if (existing >= 0) return existing;
    const slot = this.slotCount++;
    this.slotById[a.id] = slot;
    this.actorId[slot] = a.id;
    return slot;
  }

  private slot(id: number) {
    if (id < 0 || id >= ENTITY_ID_CAP) return -1;
    return this.slotById[id]!;
  }

  private begin(a: Actor, slot: number, kind: number) {
    this.kind[slot] = kind;
    this.time[slot] = 0;
    this.hitId[slot] = -1;
    this.hasPrev[slot] = 0;

    if (kind === STRIKE) {
      const speed = WEAPON_STATS[a.weapon].speed;
      const thrust = a.weapon === "spear" || a.weapon === "pitchfork" || a.weapon === "knife";
      this.duration[slot] = Math.max(0.28, Math.min(0.58, (thrust ? 0.39 : 0.44) / Math.sqrt(speed)));
      a.strikeCd = Math.max(a.strikeCd, 0.42 / speed);
      a.stamina = Math.max(0, a.stamina - 0.055);
      if (a.kind === "player") a.alert = Math.max(a.alert, 0.1);
    } else {
      this.duration[slot] = 0.52;
      a.stamina = Math.max(0, a.stamina - 0.075);
      const rig = this.bodies.get(a);
      if (rig?.initialized) {
        this.supportX[slot] = rig.x[BODY.lFoot]!;
        this.supportY[slot] = rig.y[BODY.lFoot]!;
        this.supportZ[slot] = rig.z[BODY.lFoot]!;
      }
    }
  }

  private end(slot: number) {
    this.kind[slot] = NONE;
    this.time[slot] = 0;
    this.duration[slot] = 0;
    this.hitId[slot] = -1;
    this.hasPrev[slot] = 0;
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

  private localToWorld(a: Actor, lx: number, ly: number, lz: number, out: THREE.Vector3) {
    const scale = bodyScale(a);
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    const rx = Math.cos(a.yaw);
    const rz = -Math.sin(a.yaw);
    out.set(
      a.x + rx * lx * scale + fx * lz * scale,
      a.y + ly * scale,
      a.z + rz * lx * scale + fz * lz * scale,
    );
  }

  private solveArmIK(a: Actor, rig: BodyRig, right: boolean, tx: number, ty: number, tz: number, strength: number) {
    const rootNode = right ? BODY.rShoulder : BODY.lShoulder;
    const jointNode = right ? BODY.rElbow : BODY.lElbow;
    const endNode = right ? BODY.rHand : BODY.lHand;
    const scale = bodyScale(a);
    const upper = ARM_UPPER * scale;
    const lower = ARM_LOWER * scale;
    const sx = rig.x[rootNode]!;
    const sy = rig.y[rootNode]!;
    const sz = rig.z[rootNode]!;
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
    let d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return;
    dx /= d;
    dy /= d;
    dz /= d;
    const minReach = Math.abs(upper - lower) + 0.018 * scale;
    const maxReach = (upper + lower) * 0.985;
    const reach = d < minReach ? minReach : d > maxReach ? maxReach : d;
    const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
    const bend = Math.sqrt(Math.max(0, upper * upper - along * along));

    const sign = right ? 1 : -1;
    const rx = Math.cos(a.yaw) * sign;
    const rz = -Math.sin(a.yaw) * sign;
    let px = rx * 0.92 + Math.sin(a.yaw) * 0.12;
    let py = -0.3;
    let pz = rz + Math.cos(a.yaw) * 0.12;
    const proj = px * dx + py * dy + pz * dz;
    px -= dx * proj;
    py -= dy * proj;
    pz -= dz * proj;
    d = Math.hypot(px, py, pz);
    if (d < 1e-6) d = 1;
    px /= d;
    py /= d;
    pz /= d;

    const jx = sx + dx * along + px * bend;
    const jy = sy + dy * along + py * bend;
    const jz = sz + dz * along + pz * bend;
    rig.x[jointNode] += (jx - rig.x[jointNode]!) * strength;
    rig.y[jointNode] += (jy - rig.y[jointNode]!) * strength;
    rig.z[jointNode] += (jz - rig.z[jointNode]!) * strength;
    const ex = sx + dx * reach;
    const ey = sy + dy * reach;
    const ez = sz + dz * reach;
    rig.x[endNode] += (ex - rig.x[endNode]!) * strength;
    rig.y[endNode] += (ey - rig.y[endNode]!) * strength;
    rig.z[endNode] += (ez - rig.z[endNode]!) * strength;
  }

  private solveLegIK(
    a: Actor,
    rig: BodyRig,
    left: boolean,
    tx: number,
    ty: number,
    tz: number,
    strength: number,
    poleForward: number,
  ) {
    const rootNode = left ? BODY.lHip : BODY.rHip;
    const jointNode = left ? BODY.lKnee : BODY.rKnee;
    const endNode = left ? BODY.lFoot : BODY.rFoot;
    const scale = bodyScale(a);
    const upper = LEG_UPPER * scale;
    const lower = LEG_LOWER * scale;
    const sx = rig.x[rootNode]!;
    const sy = rig.y[rootNode]!;
    const sz = rig.z[rootNode]!;
    let dx = tx - sx;
    let dy = ty - sy;
    let dz = tz - sz;
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
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    const rx = Math.cos(a.yaw) * side;
    const rz = -Math.sin(a.yaw) * side;
    let px = fx * poleForward + rx * 0.16;
    let py = -0.14;
    let pz = fz * poleForward + rz * 0.16;
    const proj = px * dx + py * dy + pz * dz;
    px -= dx * proj;
    py -= dy * proj;
    pz -= dz * proj;
    d = Math.hypot(px, py, pz);
    if (d < 1e-6) d = 1;
    px /= d;
    py /= d;
    pz /= d;

    const jx = sx + dx * along + px * bend;
    const jy = sy + dy * along + py * bend;
    const jz = sz + dz * along + pz * bend;
    rig.x[jointNode] += (jx - rig.x[jointNode]!) * strength;
    rig.y[jointNode] += (jy - rig.y[jointNode]!) * strength;
    rig.z[jointNode] += (jz - rig.z[jointNode]!) * strength;
    const ex = sx + dx * reach;
    const ey = sy + dy * reach;
    const ez = sz + dz * reach;
    rig.x[endNode] += (ex - rig.x[endNode]!) * strength;
    rig.y[endNode] += (ey - rig.y[endNode]!) * strength;
    rig.z[endNode] += (ez - rig.z[endNode]!) * strength;
  }

  private applyStrikePose(a: Actor, rig: BodyRig, u: number) {
    const root = pulse(u, 0.0, 0.24, 0.74);
    const pelvis = pulse(u, 0.035, 0.29, 0.77);
    const spine = pulse(u, 0.075, 0.35, 0.8);
    const shoulder = pulse(u, 0.115, 0.42, 0.83);
    const handWave = pulse(u, 0.155, 0.5, 0.86);
    const recover = smooth01((u - 0.72) / 0.28);
    const thrust = a.weapon === "spear" || a.weapon === "pitchfork" || a.weapon === "knife";
    const heavy = WEAPON_STATS[a.weapon].mass > 1.7;

    const rootTwist = (-0.055 * (1 - root) + 0.075 * root) * (1 - recover);
    const hipTorque = 0.12 * pelvis * (1 - recover);
    const spineTorque = -0.1 * spine * (1 - recover);
    this.setLocal(a, rig, BODY.pelvis, -0.018 * pelvis, 0.81, rootTwist, 0.72);
    this.setLocal(a, rig, BODY.lHip, -0.14, 0.755, hipTorque, 0.62);
    this.setLocal(a, rig, BODY.rHip, 0.14, 0.755, -hipTorque, 0.72);
    this.setLocal(a, rig, BODY.chest, 0.028 * spine, 1.19, 0.045 * spine + spineTorque, 0.74);
    this.setLocal(a, rig, BODY.head, -0.012 * spine, 1.58, -0.02 + 0.018 * spine, 0.42);
    this.setLocal(a, rig, BODY.lShoulder, -0.27, 1.305, 0.075 * shoulder, 0.66);
    this.setLocal(a, rig, BODY.rShoulder, 0.27, 1.305, -0.14 * shoulder, 0.82);

    let hx: number;
    let hy: number;
    let hz: number;
    if (u < 0.24) {
      const q = smoother01(u / 0.24);
      hx = 0.34 - 0.08 * q;
      hy = 0.92 + 0.2 * q;
      hz = -0.04 + 0.14 * q;
    } else if (u < 0.55) {
      const q = smoother01((u - 0.24) / 0.31);
      if (thrust) {
        hx = 0.26 - 0.13 * q;
        hy = 1.12 + 0.04 * q;
        hz = 0.1 + WEAPON_STATS[a.weapon].reach * 0.66 * q;
      } else {
        hx = 0.26 - 0.3 * q;
        hy = 1.12 + 0.07 * q;
        hz = 0.1 + (0.58 + WEAPON_STATS[a.weapon].reach * 0.22) * q;
      }
    } else if (u < 0.74) {
      const q = smooth01((u - 0.55) / 0.19);
      if (thrust) {
        hx = 0.13 - 0.05 * q;
        hy = 1.16 - 0.025 * q;
        hz = WEAPON_STATS[a.weapon].reach * (0.66 + 0.08 * q);
      } else {
        hx = -0.04 - 0.26 * q;
        hy = 1.19 - 0.09 * q;
        hz = 0.58 + WEAPON_STATS[a.weapon].reach * 0.22 - 0.13 * q;
      }
    } else {
      const q = smoother01((u - 0.74) / 0.26);
      hx = -0.3 + 0.69 * q;
      hy = 1.1 - 0.31 * q;
      hz = 0.45 * (1 - q);
    }

    this.localToWorld(a, hx, hy, hz, this.v0);
    this.solveArmIK(a, rig, true, this.v0.x, this.v0.y, this.v0.z, 0.72 + handWave * 0.26);

    if (thrust) {
      this.localToWorld(a, -0.12, 1.02, 0.34 + shoulder * 0.12, this.v1);
      this.solveArmIK(a, rig, false, this.v1.x, this.v1.y, this.v1.z, 0.78 * shoulder);
    } else {
      const counter = heavy ? 0.22 : 0.13;
      this.localToWorld(a, -0.29, 0.92 + shoulder * 0.08, -counter * shoulder, this.v1);
      this.solveArmIK(a, rig, false, this.v1.x, this.v1.y, this.v1.z, 0.58 * shoulder);
    }

    void root;
  }

  private applyKickPose(a: Actor, rig: BodyRig, slot: number, u: number) {
    const root = pulse(u, 0.0, 0.23, 0.78);
    const pelvis = pulse(u, 0.035, 0.29, 0.8);
    const spine = pulse(u, 0.08, 0.35, 0.82);
    const hip = pulse(u, 0.13, 0.43, 0.84);
    const knee = pulse(u, 0.18, 0.52, 0.86);
    const foot = pulse(u, 0.22, 0.6, 0.88);

    this.setLocal(a, rig, BODY.pelvis, -0.075 * pelvis, 0.82 - 0.055 * pelvis, -0.025 * root, 0.9);
    this.setLocal(a, rig, BODY.chest, 0.055 * spine, 1.2 - 0.025 * spine, -0.08 * spine, 0.82);
    this.setLocal(a, rig, BODY.head, 0.018 * spine, 1.58, -0.035 * spine, 0.48);
    this.setLocal(a, rig, BODY.lShoulder, -0.27, 1.31, 0.13 * spine, 0.72);
    this.setLocal(a, rig, BODY.rShoulder, 0.27, 1.31, -0.16 * spine, 0.78);
    this.setLocal(a, rig, BODY.rHip, 0.13, 0.755, 0.14 * hip, 0.9);
    this.setLocal(a, rig, BODY.lHip, -0.15, 0.755, -0.025 * pelvis, 0.78);

    this.solveLegIK(
      a,
      rig,
      true,
      this.supportX[slot]!,
      this.supportY[slot]!,
      this.supportZ[slot]!,
      0.95,
      0.52,
    );

    let lx: number;
    let ly: number;
    let lz: number;
    if (u < 0.25) {
      const q = smoother01(u / 0.25);
      lx = 0.13 + 0.03 * q;
      ly = 0.08 + 0.46 * q;
      lz = -0.03 + 0.16 * q;
    } else if (u < 0.57) {
      const q = smoother01((u - 0.25) / 0.32);
      lx = 0.16 - 0.055 * q;
      ly = 0.54 + 0.035 * q;
      lz = 0.13 + 0.72 * q;
    } else if (u < 0.7) {
      const q = smooth01((u - 0.57) / 0.13);
      lx = 0.105 - 0.035 * q;
      ly = 0.575 - 0.015 * q;
      lz = 0.85 + 0.1 * q;
    } else if (u < 0.84) {
      const q = smoother01((u - 0.7) / 0.14);
      lx = 0.07 + 0.08 * q;
      ly = 0.56 - 0.16 * q;
      lz = 0.95 - 0.72 * q;
    } else {
      const q = smoother01((u - 0.84) / 0.16);
      lx = 0.15 - 0.02 * q;
      ly = 0.4 - 0.32 * q;
      lz = 0.23 - 0.26 * q;
    }

    this.localToWorld(a, lx, ly, lz, this.v0);
    this.solveLegIK(a, rig, false, this.v0.x, this.v0.y, this.v0.z, 0.98, 0.94);

    this.localToWorld(a, -0.3, 0.92 + 0.12 * knee, -0.18 * foot, this.v1);
    this.solveArmIK(a, rig, false, this.v1.x, this.v1.y, this.v1.z, 0.66 * root);
    this.localToWorld(a, 0.3, 0.92 + 0.08 * knee, 0.1 * foot, this.v1);
    this.solveArmIK(a, rig, true, this.v1.x, this.v1.y, this.v1.z, 0.58 * root);
  }

  private resolveContact(w: World, a: Actor, rig: BodyRig, slot: number, dt: number, u: number) {
    const kind = this.kind[slot]!;
    const active = kind === STRIKE ? u >= 0.36 && u <= 0.72 : u >= 0.47 && u <= 0.73;

    let cx: number;
    let cy: number;
    let cz: number;
    let radius: number;
    if (kind === KICK) {
      cx = rig.x[BODY.rFoot]!;
      cy = rig.y[BODY.rFoot]!;
      cz = rig.z[BODY.rFoot]!;
      radius = nodeRadius(a, BODY.rFoot) * 1.08;
    } else {
      const hx = rig.x[BODY.rHand]!;
      const hy = rig.y[BODY.rHand]!;
      const hz = rig.z[BODY.rHand]!;
      let dx = hx - rig.x[BODY.rElbow]!;
      let dy = hy - rig.y[BODY.rElbow]!;
      let dz = hz - rig.z[BODY.rElbow]!;
      let m = Math.hypot(dx, dy, dz);
      if (m < 1e-6) {
        dx = -Math.sin(a.yaw);
        dy = 0;
        dz = -Math.cos(a.yaw);
        m = 1;
      }
      dx /= m;
      dy /= m;
      dz /= m;
      const scale = bodyScale(a);
      const extra = a.weapon === "fist" ? 0 : Math.max(0.1, WEAPON_STATS[a.weapon].reach - 0.68) * scale;
      cx = hx + dx * extra;
      cy = hy + dy * extra;
      cz = hz + dz * extra;
      radius = (a.weapon === "fist" ? 0.105 : 0.075) * scale;
    }

    if (!this.hasPrev[slot]) {
      this.prevX[slot] = cx;
      this.prevY[slot] = cy;
      this.prevZ[slot] = cz;
      this.hasPrev[slot] = 1;
      return;
    }

    const px = this.prevX[slot]!;
    const py = this.prevY[slot]!;
    const pz = this.prevZ[slot]!;
    this.prevX[slot] = cx;
    this.prevY[slot] = cy;
    this.prevZ[slot] = cz;
    if (!active || this.hitId[slot] >= 0) return;

    let bestActor: Actor | null = null;
    let bestRig: BodyRig | undefined;
    let bestNode = -1;
    let bestD2 = Infinity;

    for (let i = 0; i < w.actors.length; i++) {
      const o = w.actors[i]!;
      if (o.id === a.id || !o.alive) continue;
      const or = this.bodies.get(o);
      if (!or?.initialized) continue;
      for (let j = 0; j < CONTACT_NODES.length; j++) {
        const node = CONTACT_NODES[j]!;
        const rr = radius + nodeRadius(o, node);
        const d2 = segmentPointDist2(px, py, pz, cx, cy, cz, or.x[node]!, or.y[node]!, or.z[node]!);
        if (d2 <= rr * rr && d2 < bestD2) {
          bestD2 = d2;
          bestActor = o;
          bestRig = or;
          bestNode = node;
        }
      }
    }

    const vx = (cx - px) / Math.max(dt, 1e-5);
    const vy = (cy - py) / Math.max(dt, 1e-5);
    const vz = (cz - pz) / Math.max(dt, 1e-5);
    const speed = Math.hypot(vx, vy, vz);

    if (bestActor && bestRig && bestNode >= 0) {
      this.hitId[slot] = bestActor.id;
      applyActorMeleeContact(
        w,
        a,
        bestActor,
        NODE_REGION[bestNode]!,
        kind === KICK ? "kick" : "strike",
        speed,
        vx,
        vy,
        vz,
      );
      const transfer = kind === KICK ? 0.3 : 0.22;
      bestRig.px[bestNode] -= vx * dt * transfer;
      bestRig.py[bestNode] -= vy * dt * transfer;
      bestRig.pz[bestNode] -= vz * dt * transfer;
      return;
    }

    let bestProp = -1;
    let bestPropD2 = Infinity;
    for (let i = 0; i < w.props.length; i++) {
      const p = w.props[i]!;
      if (p.collapsed || p.heldBy) continue;
      const pcx = p.x;
      const pcy = p.y + p.sy * 0.5;
      const pcz = p.z;
      const rr = radius + Math.max(p.sx, p.sy, p.sz) * 0.45;
      const d2 = segmentPointDist2(px, py, pz, cx, cy, cz, pcx, pcy, pcz);
      if (d2 <= rr * rr && d2 < bestPropD2) {
        bestPropD2 = d2;
        bestProp = i;
      }
    }
    if (bestProp >= 0) {
      const p = w.props[bestProp]!;
      this.hitId[slot] = p.id;
      const planar = Math.hypot(vx, vz) || 1;
      applyPropMeleeContact(
        w,
        a,
        p,
        kind === KICK ? "kick" : "strike",
        speed,
        vx / planar,
        vz / planar,
      );
    }
  }
}
