import type { Actions } from "./input";
import type { Actor } from "./types";
import { WEAPON_STATS } from "./types";
import type { World } from "./world";
import { BODY, type BodyRig, type PhysicalBodies } from "./body";
import { CONTACT_NODES, NODE_REGION, bodyScale, nodeRadius } from "./body-model";
import { bodyTaskTargets, TASK_PRIORITY } from "./body-task-targets";
import { applyActorMeleeContact, applyPropMeleeContact } from "./melee-contact";
import { chooseKickAttackLeft } from "./action-support";

const ENTITY_ID_CAP = 8192;
const ACTION_CAP = 128;
const NONE = 0;
const PUNCH = 1;
const KICK = 2;
const MIN_DT = 1 / 240;
const MAX_DT = 1 / 30;
const ARM_UPPER = 0.294;
const ARM_LOWER = 0.262;
const LEG_UPPER = 0.34;
const LEG_LOWER = 0.34;

function clamp01(v: number) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function smooth01(v: number) { const t = clamp01(v); return t * t * (3 - 2 * t); }
function smoother01(v: number) { const t = clamp01(v); return t * t * t * (t * (t * 6 - 15) + 10); }
function pulse(u: number, start: number, peak: number, end: number) {
  if (u <= start || u >= end) return 0;
  if (u < peak) return smoother01((u - start) / Math.max(1e-5, peak - start));
  return 1 - smoother01((u - peak) / Math.max(1e-5, end - peak));
}
function human(a: Actor) { return a.kind === "player" || a.species === "human"; }
function canAct(a: Actor) {
  return a.alive && a.consciousness > 0.35 && !a.grabbedBy && !a.grabbedId &&
    a.loco !== "ragdoll" && a.loco !== "down" && a.loco !== "getup" &&
    a.loco !== "vault" && a.loco !== "climb" && a.loco !== "swim";
}
function segmentPointDist2(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  px: number, py: number, pz: number,
) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const den = abx * abx + aby * aby + abz * abz;
  const t = den > 1e-9 ? clamp01((apx * abx + apy * aby + apz * abz) / den) : 0;
  const qx = ax + abx * t - px, qy = ay + aby * t - py, qz = az + abz * t - pz;
  return qx * qx + qy * qy + qz * qz;
}

/**
 * Contact-authoritative melee task generator.
 *
 * Action phases only produce pre-solve whole-body targets. ActiveBodyControl
 * converts those targets into bounded actuation, constraints/contact decide
 * what is feasible, and only the solved physical fist/foot can create damage.
 */
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
  private readonly punchRight = new Uint8Array(ACTION_CAP);
  private readonly nextPunchRight = new Uint8Array(ACTION_CAP);
  private readonly kickAttackLeft = new Uint8Array(ACTION_CAP);
  private slotCount = 0;
  private playerPunchQueued = false;
  private playerKickQueued = false;
  private worldX = 0;
  private worldY = 0;
  private worldZ = 0;

  constructor(private readonly bodies: PhysicalBodies) {
    this.slotById.fill(-1);
    this.hitId.fill(-1);
  }

  bootstrap(w: World) {
    this.clear();
    for (let i = 0; i < w.actors.length; i++) if (human(w.actors[i]!)) this.register(w.actors[i]!);
  }

  clear() {
    this.slotById.fill(-1); this.actorId.fill(0); this.kind.fill(0); this.time.fill(0);
    this.duration.fill(0); this.hitId.fill(-1); this.hasPrev.fill(0);
    this.punchRight.fill(0); this.nextPunchRight.fill(0); this.kickAttackLeft.fill(0);
    this.slotCount = 0; this.playerPunchQueued = false; this.playerKickQueued = false;
  }

  reset(a: Actor) {
    const slot = this.slot(a.id); if (slot < 0) return;
    this.kind[slot] = NONE; this.time[slot] = 0; this.duration[slot] = 0;
    this.hitId[slot] = -1; this.hasPrev[slot] = 0; this.kickAttackLeft[slot] = 0;
  }

  captureInput(input: Actions) {
    let captured = false;
    if (input.attackPressed) { this.playerPunchQueued = true; input.attackPressed = false; captured = true; }
    if (input.kickPressed) { this.playerKickQueued = true; input.kickPressed = false; captured = true; }
    return captured;
  }

  prepareInput(w: World, input: Actions) {
    input.attackPressed = false;
    input.kickPressed = false;
    const p = w.player();
    let slot = this.slot(p.id);
    if (slot < 0 && human(p)) slot = this.register(p);
    if (slot >= 0 && this.kind[slot] === NONE && canAct(p)) {
      if (this.playerKickQueued && p.grounded) this.begin(w, p, slot, KICK);
      else if (this.playerPunchQueued && p.strikeCd <= 0) this.begin(w, p, slot, PUNCH);
    }
    this.playerPunchQueued = false;
    this.playerKickQueued = false;
    if (slot >= 0 && this.kind[slot] !== NONE) {
      const u = this.time[slot]! / Math.max(1e-5, this.duration[slot]!);
      const move = this.kind[slot] === KICK ? 0.18 : 0.42 + pulse(u, 0.18, 0.5, 0.76) * 0.18;
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
          this.begin(w, a, slot, PUNCH);
          a.attackCd = 0.7 / (0.7 + a.competence);
          a.targetId = player.id;
        }
      }

      if (this.kind[slot] === NONE) continue;
      if (!canAct(a)) { this.end(slot); continue; }
      const rig = this.bodies.get(a);
      if (!rig?.initialized || rig.mode !== "follow") { this.end(slot); continue; }

      this.time[slot] += h;
      const u = clamp01(this.time[slot]! / Math.max(1e-5, this.duration[slot]!));
      if (this.kind[slot] === PUNCH) {
        if (a.weapon === "fist") this.offerBoxingPunchTasks(a, rig, slot, u);
        else this.offerWeaponTasks(a, rig, u);
        a.intendSpeed = Math.min(a.intendSpeed, a.weapon === "fist" ? 1.0 : 1.15);
      } else {
        this.offerKickTasks(a, rig, slot, u);
        a.intendSpeed = Math.min(a.intendSpeed, 0.32);
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
      if (!rig?.initialized || !canAct(a)) { this.end(slot); continue; }
      const u = clamp01(this.time[slot]! / Math.max(1e-5, this.duration[slot]!));
      this.resolveContact(w, a, rig, slot, h, u);
      if (u >= 1) this.end(slot);
    }
  }

  isActive(id: number) {
    const slot = this.slot(id);
    return slot >= 0 && this.kind[slot] !== NONE;
  }

  private begin(w: World, a: Actor, slot: number, kind: number) {
    this.kind[slot] = kind;
    this.time[slot] = 0;
    this.hitId[slot] = -1;
    this.hasPrev[slot] = 0;
    if (kind === PUNCH) {
      const speed = WEAPON_STATS[a.weapon].speed;
      if (a.weapon === "fist") {
        const right = this.nextPunchRight[slot]!;
        this.punchRight[slot] = right;
        this.nextPunchRight[slot] = right ? 0 : 1;
        this.duration[slot] = right ? 0.34 : 0.28;
      } else {
        this.punchRight[slot] = 1;
        const thrust = a.weapon === "spear" || a.weapon === "pitchfork" || a.weapon === "knife";
        this.duration[slot] = Math.max(0.28, Math.min(0.58, (thrust ? 0.39 : 0.44) / Math.sqrt(speed)));
      }
      a.strikeCd = Math.max(a.strikeCd,
        a.weapon === "fist" ? this.duration[slot]! : 0.4 / speed);
      a.stamina = Math.max(0, a.stamina - 0.05);
      if (a.kind === "player") a.alert = Math.max(a.alert, 0.1);
    } else {
      this.duration[slot] = 0.48;
      a.stamina = Math.max(0, a.stamina - 0.075);
      const rig = this.bodies.get(a);
      if (rig?.initialized) {
        const attackLeft = chooseKickAttackLeft(w, a, rig);
        this.kickAttackLeft[slot] = attackLeft ? 1 : 0;
        const supportFoot = attackLeft ? BODY.rFoot : BODY.lFoot;
        this.supportX[slot] = rig.x[supportFoot]!;
        this.supportY[slot] = rig.y[supportFoot]!;
        this.supportZ[slot] = rig.z[supportFoot]!;
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

  private offerLocal(
    a: Actor,
    node: number,
    lx: number,
    ly: number,
    lz: number,
    strength: number,
  ) {
    bodyTaskTargets.offerLocal(a, node, lx, ly, lz, strength, TASK_PRIORITY.ACTION);
  }

  private worldFromLocal(a: Actor, lx: number, ly: number, lz: number) {
    const scale = bodyScale(a);
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
    const rx = Math.cos(a.yaw), rz = -Math.sin(a.yaw);
    this.worldX = a.x + rx * lx * scale + fx * lz * scale;
    this.worldY = a.y + ly * scale;
    this.worldZ = a.z + rz * lx * scale + fz * lz * scale;
  }

  private solveArmTask(
    a: Actor,
    rig: BodyRig,
    right: boolean,
    tx: number,
    ty: number,
    tz: number,
    strength: number,
    tuck: number,
  ) {
    const rootNode = right ? BODY.rShoulder : BODY.lShoulder;
    const jointNode = right ? BODY.rElbow : BODY.lElbow;
    const endNode = right ? BODY.rHand : BODY.lHand;
    const scale = bodyScale(a);
    const upper = ARM_UPPER * scale;
    const lower = ARM_LOWER * scale;
    const tasked = bodyTaskTargets.priorityFor(a, rootNode)
      >= TASK_PRIORITY.ACTION;
    const sx = tasked ? bodyTaskTargets.targetXFor(a, rootNode)
      : rig.x[rootNode]!;
    const sy = tasked ? bodyTaskTargets.targetYFor(a, rootNode)
      : rig.y[rootNode]!;
    const sz = tasked ? bodyTaskTargets.targetZFor(a, rootNode)
      : rig.z[rootNode]!;
    let dx = tx - sx, dy = ty - sy, dz = tz - sz;
    let d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return;
    dx /= d; dy /= d; dz /= d;
    const minReach = Math.abs(upper - lower) + 0.018 * scale;
    const maxReach = (upper + lower) * 0.988;
    const reach = d < minReach ? minReach : d > maxReach ? maxReach : d;
    const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
    const bend = Math.sqrt(Math.max(0, upper * upper - along * along));
    const sign = right ? 1 : -1;
    const sideX = Math.cos(a.yaw) * sign;
    const sideZ = -Math.sin(a.yaw) * sign;
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
    const lateral = 0.2 + (1 - clamp01(tuck)) * 0.64;
    let px = sideX * lateral - fx * 0.08;
    let py = -0.24;
    let pz = sideZ * lateral - fz * 0.08;
    const proj = px * dx + py * dy + pz * dz;
    px -= dx * proj; py -= dy * proj; pz -= dz * proj;
    d = Math.hypot(px, py, pz);
    if (d < 1e-6) d = 1;
    px /= d; py /= d; pz /= d;
    bodyTaskTargets.offerWorld(
      a,
      jointNode,
      sx + dx * along + px * bend,
      sy + dy * along + py * bend,
      sz + dz * along + pz * bend,
      strength,
      TASK_PRIORITY.ACTION,
    );
    bodyTaskTargets.offerWorld(
      a,
      endNode,
      sx + dx * reach,
      sy + dy * reach,
      sz + dz * reach,
      strength,
      TASK_PRIORITY.ACTION,
    );
  }

  private solveArmTaskLocal(
    a: Actor,
    rig: BodyRig,
    right: boolean,
    lx: number,
    ly: number,
    lz: number,
    strength: number,
    tuck: number,
  ) {
    this.worldFromLocal(a, lx, ly, lz);
    this.solveArmTask(a, rig, right, this.worldX, this.worldY, this.worldZ, strength, tuck);
  }

  private solveLegTask(
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
    const sx = rig.x[rootNode]!, sy = rig.y[rootNode]!, sz = rig.z[rootNode]!;
    let dx = tx - sx, dy = ty - sy, dz = tz - sz;
    let d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return;
    dx /= d; dy /= d; dz /= d;
    const minReach = Math.abs(upper - lower) + 0.015 * scale;
    const maxReach = (upper + lower) * 0.985;
    const reach = d < minReach ? minReach : d > maxReach ? maxReach : d;
    const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
    const bend = Math.sqrt(Math.max(0, upper * upper - along * along));
    const side = left ? -1 : 1;
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
    const rx = Math.cos(a.yaw) * side, rz = -Math.sin(a.yaw) * side;
    let px = fx * poleForward + rx * 0.16;
    let py = -0.14;
    let pz = fz * poleForward + rz * 0.16;
    const proj = px * dx + py * dy + pz * dz;
    px -= dx * proj; py -= dy * proj; pz -= dz * proj;
    d = Math.hypot(px, py, pz);
    if (d < 1e-6) d = 1;
    px /= d; py /= d; pz /= d;
    bodyTaskTargets.offerWorld(
      a,
      jointNode,
      sx + dx * along + px * bend,
      sy + dy * along + py * bend,
      sz + dz * along + pz * bend,
      strength,
      TASK_PRIORITY.ACTION,
    );
    bodyTaskTargets.offerWorld(
      a,
      endNode,
      sx + dx * reach,
      sy + dy * reach,
      sz + dz * reach,
      strength,
      TASK_PRIORITY.ACTION,
    );
  }

  private solveLegTaskLocal(
    a: Actor,
    rig: BodyRig,
    left: boolean,
    lx: number,
    ly: number,
    lz: number,
    strength: number,
    poleForward: number,
  ) {
    this.worldFromLocal(a, lx, ly, lz);
    this.solveLegTask(a, rig, left, this.worldX, this.worldY, this.worldZ, strength, poleForward);
  }

  private offerBoxingPunchTasks(a: Actor, rig: BodyRig, slot: number, u: number) {
    const right = this.punchRight[slot] !== 0;
    const sign = right ? 1 : -1;
    const jab = !right;
    const root = pulse(u, 0.0, jab ? 0.2 : 0.24, 0.78);
    const pelvis = pulse(u, 0.025, jab ? 0.25 : 0.31, 0.8);
    const spine = pulse(u, 0.065, jab ? 0.32 : 0.38, 0.82);
    const shoulder = pulse(u, 0.105, jab ? 0.4 : 0.46, 0.84);
    const elbow = pulse(u, 0.135, jab ? 0.47 : 0.52, 0.86);
    const fistWave = pulse(u, 0.16, jab ? 0.53 : 0.58, 0.88);
    const compression = pulse(u, 0.0, 0.18, 0.5);
    const hipTurn = pelvis * (jab ? 0.065 : 0.14);
    const chestTurn = spine * (jab ? 0.08 : 0.17);
    const forwardLean = root * (jab ? 0.035 : 0.055);
    const weightX = sign * pelvis * (jab ? 0.012 : 0.035);

    this.offerLocal(a, BODY.pelvis, weightX, 0.82 - 0.025 * compression, -0.015 * compression, 1);
    this.offerLocal(a, BODY.lHip, -0.14, 0.755 - 0.018 * compression, right ? -hipTurn : hipTurn, 0.94);
    this.offerLocal(a, BODY.rHip, 0.14, 0.755 - 0.018 * compression, right ? hipTurn : -hipTurn, 0.94);
    this.offerLocal(a, BODY.chest, -weightX * 0.45, 1.19 - 0.022 * compression, forwardLean + chestTurn * 0.32, 1);
    this.offerLocal(a, BODY.head, -sign * 0.018 * spine, 1.565 - 0.012 * compression, 0.006 + forwardLean * 0.35, 0.82);

    const punchShoulder = right ? BODY.rShoulder : BODY.lShoulder;
    const guardShoulder = right ? BODY.lShoulder : BODY.rShoulder;
    this.offerLocal(a, punchShoulder, sign * 0.245, 1.305 - 0.012 * compression, 0.08 + shoulder * (jab ? 0.1 : 0.17), 1);
    this.offerLocal(a, guardShoulder, -sign * 0.255, 1.315, 0.065 - shoulder * 0.025, 0.88);

    let extension: number;
    if (u < 0.12) extension = smoother01(u / 0.12) * 0.08;
    else if (u < (jab ? 0.52 : 0.57)) extension = 0.08 + 0.92 * smoother01((u - 0.12) / ((jab ? 0.52 : 0.57) - 0.12));
    else if (u < (jab ? 0.64 : 0.69)) extension = 1;
    else if (u < 0.9) extension = 1 - smoother01((u - (jab ? 0.64 : 0.69)) / (0.9 - (jab ? 0.64 : 0.69)));
    else extension = 0;

    this.solveArmTaskLocal(
      a,
      rig,
      right,
      sign * (0.19 - 0.105 * extension),
      1.265 - 0.025 * extension,
      0.18 + extension * (jab ? 0.66 : 0.75),
      0.82 + Math.max(elbow, fistWave) * 0.18,
      0.9,
    );
    this.solveArmTaskLocal(a, rig, !right, -sign * 0.175, 1.285, 0.205 + 0.035 * shoulder, 0.94, 0.94);

    const supportCompression = compression * (jab ? 0.025 : 0.045);
    this.offerLocal(a, BODY.lKnee, -0.13, 0.42 - supportCompression, 0.04 * root, 0.72);
    this.offerLocal(a, BODY.rKnee, 0.13, 0.42 - supportCompression, right ? 0.055 * pelvis : 0.025 * pelvis, 0.74);
  }

  private offerWeaponTasks(a: Actor, rig: BodyRig, u: number) {
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

    this.offerLocal(a, BODY.pelvis, -0.018 * pelvis, 0.81, rootTwist, 0.92);
    this.offerLocal(a, BODY.lHip, -0.14, 0.755, hipTorque, 0.8);
    this.offerLocal(a, BODY.rHip, 0.14, 0.755, -hipTorque, 0.88);
    this.offerLocal(a, BODY.chest, 0.028 * spine, 1.19, 0.045 * spine + spineTorque, 0.96);
    this.offerLocal(a, BODY.head, -0.012 * spine, 1.58, -0.02 + 0.018 * spine, 0.72);
    this.offerLocal(a, BODY.lShoulder, -0.27, 1.305, 0.075 * shoulder, 0.84);
    this.offerLocal(a, BODY.rShoulder, 0.27, 1.305, -0.14 * shoulder, 0.94);

    let hx: number, hy: number, hz: number;
    if (u < 0.24) {
      const q = smoother01(u / 0.24);
      hx = 0.34 - 0.08 * q; hy = 0.92 + 0.2 * q; hz = -0.04 + 0.14 * q;
    } else if (u < 0.55) {
      const q = smoother01((u - 0.24) / 0.31);
      if (thrust) {
        hx = 0.26 - 0.13 * q; hy = 1.12 + 0.04 * q; hz = 0.1 + WEAPON_STATS[a.weapon].reach * 0.66 * q;
      } else {
        hx = 0.26 - 0.3 * q; hy = 1.12 + 0.07 * q; hz = 0.1 + (0.58 + WEAPON_STATS[a.weapon].reach * 0.22) * q;
      }
    } else if (u < 0.74) {
      const q = smooth01((u - 0.55) / 0.19);
      if (thrust) {
        hx = 0.13 - 0.05 * q; hy = 1.16 - 0.025 * q; hz = WEAPON_STATS[a.weapon].reach * (0.66 + 0.08 * q);
      } else {
        hx = -0.04 - 0.26 * q; hy = 1.19 - 0.09 * q; hz = 0.58 + WEAPON_STATS[a.weapon].reach * 0.22 - 0.13 * q;
      }
    } else {
      const q = smoother01((u - 0.74) / 0.26);
      hx = -0.3 + 0.69 * q; hy = 1.1 - 0.31 * q; hz = 0.45 * (1 - q);
    }
    this.solveArmTaskLocal(a, rig, true, hx, hy, hz, 0.82 + handWave * 0.16, 0.25);
    if (thrust) this.solveArmTaskLocal(a, rig, false, -0.12, 1.02, 0.34 + shoulder * 0.12, 0.84, 0.45);
    else this.solveArmTaskLocal(a, rig, false, -0.29, 0.92 + shoulder * 0.08, -(heavy ? 0.22 : 0.13) * shoulder, 0.72, 0.35);
  }

  private offerKickTasks(a: Actor, rig: BodyRig, slot: number, u: number) {
    const attackLeft = this.kickAttackLeft[slot] !== 0;
    const attackFoot = attackLeft ? BODY.lFoot : BODY.rFoot;
    const supportLeft = !attackLeft;
    const supportFoot = supportLeft ? BODY.lFoot : BODY.rFoot;
    const floor = this.supportY[slot]! - nodeRadius(a, supportFoot);
    const heightOffset = (floor - a.y) / bodyScale(a);
    this.offerLocal(a, BODY.pelvis, 0, 0.82 + heightOffset, 0, 1);
    this.offerLocal(a, BODY.chest, 0, 1.2 + heightOffset, 0, 1);
    this.offerLocal(a, BODY.head, 0, 1.58 + heightOffset, 0, 0.9);
    this.solveLegTask(
      a, rig, supportLeft,
      this.supportX[slot]!, this.supportY[slot]!,
      this.supportZ[slot]!, 1, 0.56,
    );

    let lift: number, extension: number;
    if (u < 0.28) {
      lift = smooth01(u / 0.28);
      extension = 0;
    } else if (u < 0.56) {
      lift = 1;
      extension = smoother01((u - 0.28) / 0.28);
    } else if (u < 0.64) {
      lift = 1;
      extension = 1;
    } else if (u < 0.82) {
      lift = 1;
      extension = 1 - smoother01((u - 0.64) / 0.18);
    } else {
      lift = 1 - smoother01((u - 0.82) / 0.18);
      extension = 0;
    }
    const side = attackLeft ? -1 : 1;
    this.offerLocal(a, attackFoot,
      side * (0.13 + 0.12 * lift - 0.2 * extension),
      0.1 + 0.56 * lift + 0.22 * extension + heightOffset,
      -0.03 + 0.16 * lift + 0.65 * extension, 1);
    this.solveArmTaskLocal(a, rig, false,
      -0.22, 1.48 + heightOffset, 0.22, 1, 0.94);
    this.solveArmTaskLocal(a, rig, true,
      0.22, 1.48 + heightOffset, 0.22, 1, 0.94);
  }

  finishCoupledTasks(w: World) {
    for (const a of w.actors) {
      const slot = this.slot(a.id);
      if (slot < 0 || this.kind[slot] !== KICK) continue;
      const rig = this.bodies.get(a);
      if (!rig?.initialized) continue;
      const lx = bodyTaskTargets.targetXFor(a, BODY.lShoulder);
      const lz = bodyTaskTargets.targetZFor(a, BODY.lShoulder);
      const rx = bodyTaskTargets.targetXFor(a, BODY.rShoulder);
      const rz = bodyTaskTargets.targetZFor(a, BODY.rShoulder);
      const width = Math.max(1e-5, Math.hypot(rx - lx, rz - lz));
      const sideX = (rx - lx) / width;
      const sideZ = (rz - lz) / width;
      const scale = bodyScale(a);
      for (let side = -1; side <= 1; side += 2) {
        const node = side > 0 ? BODY.rShoulder : BODY.lShoulder;
        this.solveArmTask(a, rig, side > 0,
          bodyTaskTargets.targetXFor(a, node)
            + (sideZ * 0.23 - sideX * side * 0.04) * scale,
          bodyTaskTargets.targetYFor(a, node) + 0.42 * scale,
          bodyTaskTargets.targetZFor(a, node)
            + (-sideX * 0.23 - sideZ * side * 0.04) * scale,
          1, 0.94);
      }
    }
  }

  private resolveContact(w: World, a: Actor, rig: BodyRig, slot: number, dt: number, u: number) {
    const kind = this.kind[slot]!;
    const fist = kind === PUNCH && a.weapon === "fist";
    const right = this.punchRight[slot] !== 0;
    const active = kind === KICK
      ? u >= 0.28 && u <= 0.67
      : fist
        ? u >= (right ? 0.38 : 0.34) && u <= (right ? 0.71 : 0.67)
        : u >= 0.36 && u <= 0.72;

    let cx: number, cy: number, cz: number, radius: number;
    if (kind === KICK) {
      const foot = this.kickAttackLeft[slot] ? BODY.lFoot : BODY.rFoot;
      cx = rig.x[foot]!; cy = rig.y[foot]!; cz = rig.z[foot]!;
      radius = nodeRadius(a, foot) * 1.08;
    } else {
      const handNode = fist && !right ? BODY.lHand : BODY.rHand;
      const elbowNode = fist && !right ? BODY.lElbow : BODY.rElbow;
      const hx = rig.x[handNode]!, hy = rig.y[handNode]!, hz = rig.z[handNode]!;
      let dx = hx - rig.x[elbowNode]!, dy = hy - rig.y[elbowNode]!, dz = hz - rig.z[elbowNode]!;
      let m = Math.hypot(dx, dy, dz);
      if (m < 1e-6) { dx = -Math.sin(a.yaw); dy = 0; dz = -Math.cos(a.yaw); m = 1; }
      dx /= m; dy /= m; dz /= m;
      const scale = bodyScale(a);
      const extra = fist ? 0 : Math.max(0.1, WEAPON_STATS[a.weapon].reach - 0.68) * scale;
      cx = hx + dx * extra; cy = hy + dy * extra; cz = hz + dz * extra;
      radius = (fist ? 0.11 : 0.075) * scale;
    }

    if (!this.hasPrev[slot]) {
      this.prevX[slot] = cx; this.prevY[slot] = cy; this.prevZ[slot] = cz;
      this.hasPrev[slot] = 1;
      return;
    }
    const px = this.prevX[slot]!, py = this.prevY[slot]!, pz = this.prevZ[slot]!;
    this.prevX[slot] = cx; this.prevY[slot] = cy; this.prevZ[slot] = cz;
    if (!active || this.hitId[slot] >= 0) return;

    let bestActor: Actor | null = null;
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
          bestNode = node;
        }
      }
    }

    const vx = (cx - px) / Math.max(dt, 1e-5);
    const vy = (cy - py) / Math.max(dt, 1e-5);
    const vz = (cz - pz) / Math.max(dt, 1e-5);
    const speed = Math.hypot(vx, vy, vz);
    if (bestActor && bestNode >= 0) {
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
      return;
    }

    let bestProp = -1;
    let bestPropD2 = Infinity;
    for (let i = 0; i < w.props.length; i++) {
      const p = w.props[i]!;
      if (p.collapsed || p.heldBy) continue;
      const rr = radius + Math.max(p.sx, p.sy, p.sz) * 0.45;
      const d2 = segmentPointDist2(px, py, pz, cx, cy, cz, p.x, p.y + p.sy * 0.5, p.z);
      if (d2 <= rr * rr && d2 < bestPropD2) {
        bestPropD2 = d2;
        bestProp = i;
      }
    }
    if (bestProp >= 0) {
      const p = w.props[bestProp]!;
      this.hitId[slot] = p.id;
      const planar = Math.hypot(vx, vz) || 1;
      applyPropMeleeContact(w, a, p, kind === KICK ? "kick" : "strike", speed, vx / planar, vz / planar);
    }
  }

  private register(a: Actor) {
    if (a.id < 0 || a.id >= ENTITY_ID_CAP || this.slotCount >= ACTION_CAP) return -1;
    const existing = this.slotById[a.id]!;
    if (existing >= 0) return existing;
    const slot = this.slotCount++;
    this.slotById[a.id] = slot;
    this.actorId[slot] = a.id;
    this.nextPunchRight[slot] = 0;
    return slot;
  }

  private slot(id: number) {
    return id < 0 || id >= ENTITY_ID_CAP ? -1 : this.slotById[id]!;
  }
}
