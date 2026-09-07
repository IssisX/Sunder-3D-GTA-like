import type { Actions } from './input';
import type { Actor, WeaponKind } from './types';
import { WEAPON_STATS } from './types';
import type { World } from './world';
import { BODY, type BodyRig, type PhysicalBodies } from './body';
import {
  CONTACT_NODES, NODE_REGION, bodyScale, nodeRadius,
  nodeVelocityComponent,
} from './body-model';
import { bodyTaskTargets, TASK_PRIORITY } from './body-task-targets';
import {
  applyActorMeleeContact, applyPropMeleeContact,
} from './melee-contact';
import { chooseKickAttackLeft } from './action-support';
import { agentRandom } from './agent-independence';
import { socialIncidents } from './social-incident';
import {
  makeMechanicalState, sampleMechanicalState,
} from './mechanical-state';
import {
  BoxingCombinations, makeBoxingPose,
  type BoxingContext,
} from './boxing-combinations';

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
const INPUT_BUFFER = 0.22;

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
function pulse(u: number, start: number, peak: number,
  end: number) {
  if (u <= start || u >= end) return 0;
  if (u < peak) return smoother01(
    (u - start) / Math.max(1e-5, peak - start));
  return 1 - smoother01(
    (u - peak) / Math.max(1e-5, end - peak));
}
function human(a: Actor) {
  return a.kind === 'player' || a.species === 'human';
}
function canAct(a: Actor) {
  return a.alive && a.consciousness > 0.35 &&
    !a.grabbedBy && !a.grabbedId &&
    a.loco !== 'ragdoll' && a.loco !== 'down' &&
    a.loco !== 'getup' && a.loco !== 'vault' &&
    a.loco !== 'climb' && a.loco !== 'swim';
}
function segmentPointDist2(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  px: number, py: number, pz: number,
) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const den = abx * abx + aby * aby + abz * abz;
  const t = den > 1e-9 ? clamp01(
    -(px * abx + py * aby + pz * abz) / den) : 0;
  const dx = ax + abx * t - px;
  const dy = ay + aby * t - py;
  const dz = az + abz * t - pz;
  return dx * dx + dy * dy + dz * dz;
}

/** One action owner. Tasks precede the solver; contact follows it. */
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
  private readonly kickAttackLeft = new Uint8Array(ACTION_CAP);
  private readonly activeWeapon: WeaponKind[] =
    Array(ACTION_CAP).fill('fist');
  private readonly boxing = new BoxingCombinations();
  private readonly mechanical = makeMechanicalState();
  private readonly boxingPose = makeBoxingPose();
  private readonly boxingContext: BoxingContext = {
    targetX: 0, targetY: 1.45, targetZ: 0.76,
    forwardSpeed: 0, lateralSpeed: 0,
    angularMomentum: 0, support: 1, grip: 1,
    capacity: 1,
  };
  private slotCount = 0;
  private pendingPunches = 0;
  private pendingKicks = 0;
  private weaponQueuedT = 0;
  private kickQueuedT = 0;
  private worldX = 0;
  private worldY = 0;
  private worldZ = 0;

  constructor(private readonly bodies: PhysicalBodies) {
    this.slotById.fill(-1);
    this.hitId.fill(-1);
  }
  bootstrap(w: World) {
    this.clear();
    for (const a of w.actors) if (human(a)) this.register(a);
  }
  clear() {
    this.slotById.fill(-1);
    this.actorId.fill(0); this.kind.fill(0);
    this.time.fill(0); this.duration.fill(0);
    this.hitId.fill(-1); this.hasPrev.fill(0);
    this.punchRight.fill(0); this.kickAttackLeft.fill(0);
    this.activeWeapon.fill('fist'); this.boxing.clear();
    this.slotCount = 0; this.pendingPunches = 0;
    this.pendingKicks = 0; this.weaponQueuedT = 0;
    this.kickQueuedT = 0;
  }
  reset(a: Actor) {
    const slot = this.slot(a.id);
    if (slot < 0) return;
    this.end(slot, 0, true);
    this.kickAttackLeft[slot] = 0;
    if (a.kind === 'player') {
      this.pendingPunches = 0; this.pendingKicks = 0;
      this.weaponQueuedT = 0; this.kickQueuedT = 0;
    }
  }
  captureInput(input: Actions) {
    let captured = false;
    if (input.attackPressed) {
      this.pendingPunches = Math.min(4, this.pendingPunches + 1);
      input.attackPressed = false;
      captured = true;
    }
    if (input.kickPressed) {
      this.pendingKicks = Math.min(1, this.pendingKicks + 1);
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
    if (slot < 0) return;
    if (p.weapon === 'fist') {
      while (this.pendingPunches > 0) {
        this.boxing.enqueue(slot, w.time);
        this.pendingPunches--;
      }
      this.weaponQueuedT = 0;
    } else if (this.pendingPunches > 0) {
      this.weaponQueuedT = INPUT_BUFFER;
      this.pendingPunches = 0;
      this.boxing.reset(slot);
    }
    if (this.pendingKicks > 0) {
      this.kickQueuedT = INPUT_BUFFER;
      this.pendingKicks = 0;
    }
    if (this.kind[slot] === NONE && canAct(p)) {
      if (this.kickQueuedT > 0 && p.grounded) {
        this.begin(w, p, slot, KICK);
        this.kickQueuedT = 0;
      } else if (p.strikeCd <= 0 &&
        (p.weapon === 'fist'
          ? this.boxing.take(slot, w.time)
          : this.weaponQueuedT > 0)) {
        this.begin(w, p, slot, PUNCH);
        this.weaponQueuedT = 0;
      }
    }
    if (this.kind[slot] !== NONE) {
      const u = this.time[slot]! /
        Math.max(1e-5, this.duration[slot]!);
      if (this.kind[slot] === KICK) {
        input.moveX *= 0.18;
        input.moveY *= 0.18;
        input.sprint = false;
      } else if (this.activeWeapon[slot] !== 'fist') {
        const move = 0.42 + pulse(u, 0.18, 0.5, 0.76) * 0.18;
        input.moveX *= move;
        input.moveY *= move;
        input.sprint = false;
      }
    }
  }
  prepareStep(w: World, dt: number) {
    const h = Math.max(MIN_DT, Math.min(MAX_DT, dt));
    this.weaponQueuedT = Math.max(0, this.weaponQueuedT - h);
    this.kickQueuedT = Math.max(0, this.kickQueuedT - h);
    const player = w.player();
    for (const a of w.actors) {
      if (!human(a)) continue;
      let slot = this.slot(a.id);
      if (slot < 0) slot = this.register(a);
      if (slot < 0) continue;
      if (a.kind !== 'player' && this.kind[slot] === NONE &&
        a.attackCd <= 0 && canAct(a)) {
        const incidentId = socialIncidents.fightTarget(a.id);
        const incident = incidentId ? w.actor(incidentId) : null;
        const guard = !incident && a.faction === 'guard' &&
          a.ai === 'combat' && a.targetId === player.id &&
          w.time - a.lastSeenT < 0.7 ? player : null;
        const target = incident?.alive ? incident : guard;
        if (target?.alive) {
          const dx = target.x - a.x;
          const dz = target.z - a.z;
          const reach = WEAPON_STATS[a.weapon].reach +
            target.radius + 0.35;
          if (dx * dx + dz * dz <= reach * reach) {
            const kick = Boolean(incident) &&
              a.weapon === 'fist' && a.grounded &&
              agentRandom(w, a) < 0.12 + a.competence * 0.16;
            this.begin(w, a, slot, kick ? KICK : PUNCH);
            a.attackCd = (kick ? 0.88 : 0.7) /
              (0.7 + a.competence) + agentRandom(w, a) * 0.14;
            a.targetId = target.id;
          }
        }
      }
      if (this.kind[slot] === NONE) continue;
      if (!canAct(a) || a.weapon !== this.activeWeapon[slot]) {
        this.end(slot, w.time, true);
        continue;
      }
      const rig = this.bodies.get(a);
      if (!rig?.initialized || rig.mode !== 'follow') {
        this.end(slot, w.time, true);
        continue;
      }
      this.time[slot] += h;
      const u = clamp01(this.time[slot]! /
        Math.max(1e-5, this.duration[slot]!));
      if (this.kind[slot] === PUNCH) {
        if (a.weapon === 'fist') {
          this.offerBoxingPunchTasks(w, a, rig, slot, u, h);
        } else {
          this.offerWeaponTasks(a, rig, u);
          a.intendSpeed = Math.min(a.intendSpeed, 1.15);
        }
      } else {
        this.offerKickTasks(a, rig, slot, u);
        a.intendSpeed = Math.min(a.intendSpeed, 0.32);
      }
    }
  }
  step(w: World, dt: number) {
    const h = Math.max(MIN_DT, Math.min(MAX_DT, dt));
    for (const a of w.actors) {
      if (!human(a)) continue;
      const slot = this.slot(a.id);
      if (slot < 0 || this.kind[slot] === NONE) continue;
      const rig = this.bodies.get(a);
      if (!rig?.initialized || !canAct(a)) {
        this.end(slot, w.time, true);
        continue;
      }
      const u = clamp01(this.time[slot]! /
        Math.max(1e-5, this.duration[slot]!));
      this.resolveContact(w, a, rig, slot, h, u);
      if (u >= 1) this.end(slot, w.time, false);
    }
  }
  isActive(id: number) {
    const slot = this.slot(id);
    return slot >= 0 && this.kind[slot] !== NONE;
  }
  private begin(w: World, a: Actor, slot: number,
    kind: number) {
    this.kind[slot] = kind;
    this.time[slot] = 0;
    this.hitId[slot] = -1;
    this.hasPrev[slot] = 0;
    this.activeWeapon[slot] = a.weapon;
    if (kind === PUNCH) {
      const speed = WEAPON_STATS[a.weapon].speed;
      if (a.weapon === 'fist') {
        const rig = this.bodies.get(a);
        if (!rig?.initialized) {
          this.end(slot, w.time, true);
          return;
        }
        const leadRight = this.leadRight(a, rig);
        const range = this.targetRange(w, a);
        const capacity = clamp01(a.stamina) *
          clamp01((a.consciousness - 0.12) / 0.88);
        const next = this.boxing.nextHand(slot, w.time,
          leadRight, range);
        const hand = next ? BODY.rHand : BODY.lHand;
        const scale = bodyScale(a);
        const rx = Math.cos(a.yaw), rz = -Math.sin(a.yaw);
        const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
        const dx = rig.x[hand]! - a.x;
        const dz = rig.z[hand]! - a.z;
        const hx = (dx * rx + dz * rz) / scale;
        const hy = (rig.y[hand]! - a.y) / scale;
        const hz = (dx * fx + dz * fz) / scale;
        const vx = nodeVelocityComponent(
          rig.x[hand]!, rig.px[hand]!, 1 / 60);
        const vy = nodeVelocityComponent(
          rig.y[hand]!, rig.py[hand]!, 1 / 60);
        const vz = nodeVelocityComponent(
          rig.z[hand]!, rig.pz[hand]!, 1 / 60);
        const d = this.boxing.begin(slot, w.time,
          leadRight, range, capacity, hx, hy, hz,
          (vx * rx + vz * rz) / scale,
          vy / scale, (vx * fx + vz * fz) / scale);
        this.duration[slot] = d;
        this.punchRight[slot] = this.boxing.rightHand(slot) ? 1 : 0;
        this.prevX[slot] = rig.x[hand]!;
        this.prevY[slot] = rig.y[hand]!;
        this.prevZ[slot] = rig.z[hand]!;
        this.hasPrev[slot] = 1;
        a.strikeCd = Math.max(a.strikeCd, d);
        a.stamina = Math.max(0, a.stamina - 0.045);
      } else {
        this.punchRight[slot] = 1;
        const thrust = a.weapon === 'spear' ||
          a.weapon === 'pitchfork' || a.weapon === 'knife';
        this.duration[slot] = Math.max(0.28, Math.min(0.58,
          (thrust ? 0.39 : 0.44) / Math.sqrt(speed)));
        a.strikeCd = Math.max(a.strikeCd, 0.4 / speed);
        a.stamina = Math.max(0, a.stamina - 0.05);
      }
      if (a.kind === 'player') a.alert = Math.max(a.alert, 0.1);
    } else {
      this.duration[slot] = 0.48;
      a.stamina = Math.max(0, a.stamina - 0.075);
      const rig = this.bodies.get(a);
      if (rig?.initialized) {
        const left = chooseKickAttackLeft(w, a, rig);
        this.kickAttackLeft[slot] = left ? 1 : 0;
        const foot = left ? BODY.rFoot : BODY.lFoot;
        this.supportX[slot] = rig.x[foot]!;
        this.supportY[slot] = rig.y[foot]!;
        this.supportZ[slot] = rig.z[foot]!;
      }
    }
  }
  private end(slot: number, now: number, cancelled: boolean) {
    if (this.kind[slot] === PUNCH &&
      this.activeWeapon[slot] === 'fist') {
      if (cancelled) this.boxing.reset(slot);
      else this.boxing.end(slot, now);
    }
    this.kind[slot] = NONE;
    this.time[slot] = 0;
    this.duration[slot] = 0;
    this.hitId[slot] = -1;
    this.hasPrev[slot] = 0;
  }
  private leadRight(a: Actor, rig: BodyRig) {
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
    const dx = rig.x[BODY.rFoot]! - rig.x[BODY.lFoot]!;
    const dz = rig.z[BODY.rFoot]! - rig.z[BODY.lFoot]!;
    return dx * fx + dz * fz > 0.06 * bodyScale(a);
  }
  private targetRange(w: World, a: Actor) {
    const t = this.findTarget(w, a);
    if (!t) return 0.76;
    return Math.hypot(t.x - a.x, t.z - a.z) / bodyScale(a);
  }
  private findTarget(w: World, a: Actor) {
    const selected = a.targetId ? w.actor(a.targetId) : null;
    if (selected?.alive && selected.id !== a.id &&
      Math.hypot(selected.x - a.x, selected.z - a.z) < 1.8) {
      return selected;
    }
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
    let best: Actor | null = null;
    let bestD2 = 1.5 * 1.5;
    for (const o of w.actors) {
      if (!o.alive || o.id === a.id) continue;
      const dx = o.x - a.x, dz = o.z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bestD2 || d2 < 1e-6) continue;
      if ((dx * fx + dz * fz) / Math.sqrt(d2) < 0.45) continue;
      best = o;
      bestD2 = d2;
    }
    return best;
  }
  private offerLocal(a: Actor, node: number,
    x: number, y: number, z: number, strength: number) {
    bodyTaskTargets.offerLocal(a, node, x, y, z,
      strength, TASK_PRIORITY.ACTION);
  }
  private worldFromLocal(a: Actor,
    lx: number, ly: number, lz: number) {
    const scale = bodyScale(a);
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
    const rx = Math.cos(a.yaw), rz = -Math.sin(a.yaw);
    this.worldX = a.x + rx * lx * scale + fx * lz * scale;
    this.worldY = a.y + ly * scale;
    this.worldZ = a.z + rz * lx * scale + fz * lz * scale;
  }
  private solveArmTask(
    a: Actor, rig: BodyRig, right: boolean,
    tx: number, ty: number, tz: number,
    strength: number, tuck: number,
  ) {
    const root = right ? BODY.rShoulder : BODY.lShoulder;
    const joint = right ? BODY.rElbow : BODY.lElbow;
    const end = right ? BODY.rHand : BODY.lHand;
    const scale = bodyScale(a);
    const upper = ARM_UPPER * scale, lower = ARM_LOWER * scale;
    const tasked = bodyTaskTargets.priorityFor(a, root) >=
      TASK_PRIORITY.ACTION;
    const sx = tasked ? bodyTaskTargets.targetXFor(a, root)
      : rig.x[root]!;
    const sy = tasked ? bodyTaskTargets.targetYFor(a, root)
      : rig.y[root]!;
    const sz = tasked ? bodyTaskTargets.targetZFor(a, root)
      : rig.z[root]!;
    let dx = tx - sx, dy = ty - sy, dz = tz - sz;
    let d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return;
    dx /= d; dy /= d; dz /= d;
    const reach = Math.max(Math.abs(upper - lower) +
      0.018 * scale, Math.min((upper + lower) * 0.988, d));
    const along = (upper * upper - lower * lower +
      reach * reach) / (2 * reach);
    const bend = Math.sqrt(Math.max(0,
      upper * upper - along * along));
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
    d = Math.hypot(px, py, pz) || 1;
    px /= d; py /= d; pz /= d;
    bodyTaskTargets.offerWorld(a, joint,
      sx + dx * along + px * bend,
      sy + dy * along + py * bend,
      sz + dz * along + pz * bend,
      strength, TASK_PRIORITY.ACTION);
    bodyTaskTargets.offerWorld(a, end,
      sx + dx * reach, sy + dy * reach, sz + dz * reach,
      strength, TASK_PRIORITY.ACTION);
  }
  private solveArmTaskLocal(a: Actor, rig: BodyRig,
    right: boolean, lx: number, ly: number, lz: number,
    strength: number, tuck: number) {
    this.worldFromLocal(a, lx, ly, lz);
    this.solveArmTask(a, rig, right,
      this.worldX, this.worldY, this.worldZ, strength, tuck);
  }
  private solveLegTask(a: Actor, rig: BodyRig,
    left: boolean, tx: number, ty: number, tz: number,
    strength: number, poleForward: number) {
    const root = left ? BODY.lHip : BODY.rHip;
    const joint = left ? BODY.lKnee : BODY.rKnee;
    const end = left ? BODY.lFoot : BODY.rFoot;
    const scale = bodyScale(a);
    const upper = LEG_UPPER * scale, lower = LEG_LOWER * scale;
    const sx = rig.x[root]!, sy = rig.y[root]!, sz = rig.z[root]!;
    let dx = tx - sx, dy = ty - sy, dz = tz - sz;
    let d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return;
    dx /= d; dy /= d; dz /= d;
    const reach = Math.max(Math.abs(upper - lower) +
      0.015 * scale, Math.min((upper + lower) * 0.985, d));
    const along = (upper * upper - lower * lower +
      reach * reach) / (2 * reach);
    const bend = Math.sqrt(Math.max(0,
      upper * upper - along * along));
    const side = left ? -1 : 1;
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
    const rx = Math.cos(a.yaw) * side;
    const rz = -Math.sin(a.yaw) * side;
    let px = fx * poleForward + rx * 0.16;
    let py = -0.14;
    let pz = fz * poleForward + rz * 0.16;
    const proj = px * dx + py * dy + pz * dz;
    px -= dx * proj; py -= dy * proj; pz -= dz * proj;
    d = Math.hypot(px, py, pz) || 1;
    px /= d; py /= d; pz /= d;
    bodyTaskTargets.offerWorld(a, joint,
      sx + dx * along + px * bend,
      sy + dy * along + py * bend,
      sz + dz * along + pz * bend,
      strength, TASK_PRIORITY.ACTION);
    bodyTaskTargets.offerWorld(a, end,
      sx + dx * reach, sy + dy * reach, sz + dz * reach,
      strength, TASK_PRIORITY.ACTION);
  }
  private taskBase(a: Actor, rig: BodyRig,
    node: number, axis: 0 | 1 | 2) {
    if (bodyTaskTargets.priorityFor(a, node) >=
      TASK_PRIORITY.LOCOMOTION) {
      return axis === 0
        ? bodyTaskTargets.targetXFor(a, node)
        : axis === 1
          ? bodyTaskTargets.targetYFor(a, node)
          : bodyTaskTargets.targetZFor(a, node);
    }
    return axis === 0 ? rig.x[node]!
      : axis === 1 ? rig.y[node]! : rig.z[node]!;
  }
  private offerBoxingPunchTasks(w: World, a: Actor,
    rig: BodyRig, slot: number, u: number, dt: number) {
    const scale = bodyScale(a);
    sampleMechanicalState(w, a, rig, dt, this.mechanical);
    const c = this.boxingContext;
    const target = this.findTarget(w, a);
    let tx = a.x - Math.sin(a.yaw) * 0.76 * scale;
    let tz = a.z - Math.cos(a.yaw) * 0.76 * scale;
    let ty = a.y + 1.45 * scale;
    if (target) {
      const tr = this.bodies.get(target);
      tx = tr?.initialized ? tr.x[BODY.head]! : target.x;
      tz = tr?.initialized ? tr.z[BODY.head]! : target.z;
      ty = tr?.initialized ? tr.y[BODY.head]!
        : target.y + target.height * 0.86;
    }
    const rx = Math.cos(a.yaw), rz = -Math.sin(a.yaw);
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
    const dx = tx - a.x, dz = tz - a.z;
    c.targetX = (dx * rx + dz * rz) / scale;
    c.targetY = (ty - a.y) / scale;
    c.targetZ = (dx * fx + dz * fz) / scale;
    c.forwardSpeed = this.mechanical.velX * fx +
      this.mechanical.velZ * fz;
    c.lateralSpeed = this.mechanical.velX * rx +
      this.mechanical.velZ * rz;
    c.angularMomentum = this.mechanical.angularY;
    c.support = this.mechanical.supportScore;
    c.grip = this.mechanical.grip;
    c.capacity = this.mechanical.legIntegrity *
      this.mechanical.consciousness * clamp01(a.stamina);
    const p = this.boxing.sample(slot, u, c, this.boxingPose);
    const right = this.boxing.rightHand(slot);
    const pelvis = BODY.pelvis, chest = BODY.chest;
    const px = this.taskBase(a, rig, pelvis, 0);
    const py = this.taskBase(a, rig, pelvis, 1);
    const pz = this.taskBase(a, rig, pelvis, 2);
    const cx = this.taskBase(a, rig, chest, 0);
    const cy = this.taskBase(a, rig, chest, 1);
    const cz = this.taskBase(a, rig, chest, 2);
    const shiftX = (rx * p.shiftX + fx * p.shiftZ) * scale;
    const shiftZ = (rz * p.shiftX + fz * p.shiftZ) * scale;
    bodyTaskTargets.offerWorld(a, pelvis,
      px + shiftX, py - p.compression * scale,
      pz + shiftZ, 0.92, TASK_PRIORITY.ACTION);
    bodyTaskTargets.offerWorld(a, chest,
      cx + shiftX * 0.3 + fx * p.chestTurn * 0.1 * scale,
      cy - p.compression * 0.3 * scale,
      cz + shiftZ * 0.3 + fz * p.chestTurn * 0.1 * scale,
      0.94, TASK_PRIORITY.ACTION);
    const hipC = Math.cos(p.hipTurn);
    const hipS = Math.sin(p.hipTurn);
    for (let side = -1; side <= 1; side += 2) {
      const node = side < 0 ? BODY.lHip : BODY.rHip;
      const hx = this.taskBase(a, rig, node, 0) - px;
      const hz = this.taskBase(a, rig, node, 2) - pz;
      bodyTaskTargets.offerWorld(a, node,
        px + shiftX + hx * hipC - hz * hipS,
        this.taskBase(a, rig, node, 1) - p.compression * scale,
        pz + shiftZ + hx * hipS + hz * hipC,
        0.88, TASK_PRIORITY.ACTION);
    }
    const shoulderC = Math.cos(p.chestTurn);
    const shoulderS = Math.sin(p.chestTurn);
    for (let side = -1; side <= 1; side += 2) {
      const node = side < 0 ? BODY.lShoulder : BODY.rShoulder;
      const sx = this.taskBase(a, rig, node, 0) - cx;
      const sz = this.taskBase(a, rig, node, 2) - cz;
      bodyTaskTargets.offerWorld(a, node,
        cx + shiftX * 0.3 + sx * shoulderC - sz * shoulderS,
        this.taskBase(a, rig, node, 1) -
          p.compression * 0.3 * scale,
        cz + shiftZ * 0.3 + sx * shoulderS + sz * shoulderC,
        0.94, TASK_PRIORITY.ACTION);
    }
    this.worldFromLocal(a, p.handX, p.handY, p.handZ);
    this.solveArmTask(a, rig, right,
      this.worldX, this.worldY, this.worldZ, 1, p.tuck);
    this.solveArmTaskLocal(a, rig, !right,
      p.guardX, p.guardY, p.guardZ, 0.94, 0.94);
    // Contact and gait retain their existing physical authority.
  }
  private offerWeaponTasks(a: Actor, rig: BodyRig, u: number) {
    const root = pulse(u, 0, 0.24, 0.74);
    const pelvis = pulse(u, 0.035, 0.29, 0.77);
    const spine = pulse(u, 0.075, 0.35, 0.8);
    const shoulder = pulse(u, 0.115, 0.42, 0.83);
    const handWave = pulse(u, 0.155, 0.5, 0.86);
    const recover = smooth01((u - 0.72) / 0.28);
    const thrust = a.weapon === 'spear' ||
      a.weapon === 'pitchfork' || a.weapon === 'knife';
    const heavy = WEAPON_STATS[a.weapon].mass > 1.7;
    const rootTwist = (-0.055 * (1 - root) + 0.075 * root) *
      (1 - recover);
    const hipTorque = 0.12 * pelvis * (1 - recover);
    const spineTorque = -0.1 * spine * (1 - recover);
    this.offerLocal(a, BODY.pelvis, -0.018 * pelvis,
      0.81, rootTwist, 0.92);
    this.offerLocal(a, BODY.lHip, -0.14, 0.755,
      hipTorque, 0.8);
    this.offerLocal(a, BODY.rHip, 0.14, 0.755,
      -hipTorque, 0.88);
    this.offerLocal(a, BODY.chest, 0.028 * spine, 1.19,
      0.045 * spine + spineTorque, 0.96);
    this.offerLocal(a, BODY.head, -0.012 * spine, 1.58,
      -0.02 + 0.018 * spine, 0.72);
    this.offerLocal(a, BODY.lShoulder, -0.27, 1.305,
      0.075 * shoulder, 0.84);
    this.offerLocal(a, BODY.rShoulder, 0.27, 1.305,
      -0.14 * shoulder, 0.94);
    let hx: number, hy: number, hz: number;
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
    this.solveArmTaskLocal(a, rig, true,
      hx, hy, hz, 0.82 + handWave * 0.16, 0.25);
    if (thrust) this.solveArmTaskLocal(a, rig, false,
      -0.12, 1.02, 0.34 + shoulder * 0.12, 0.84, 0.45);
    else this.solveArmTaskLocal(a, rig, false,
      -0.29, 0.92 + shoulder * 0.08,
      -(heavy ? 0.22 : 0.13) * shoulder, 0.72, 0.35);
  }
  private offerKickTasks(a: Actor, rig: BodyRig,
    slot: number, u: number) {
    const left = this.kickAttackLeft[slot] !== 0;
    const supportLeft = !left;
    const supportFoot = supportLeft ? BODY.lFoot : BODY.rFoot;
    const attackFoot = left ? BODY.lFoot : BODY.rFoot;
    const floor = this.supportY[slot]! - nodeRadius(a, supportFoot);
    const heightOffset = (floor - a.y) / bodyScale(a);
    this.offerLocal(a, BODY.pelvis, 0, 0.82 + heightOffset, 0, 1);
    this.offerLocal(a, BODY.chest, 0, 1.2 + heightOffset, 0, 1);
    this.offerLocal(a, BODY.head, 0, 1.58 + heightOffset, 0, 0.9);
    this.solveLegTask(a, rig, supportLeft,
      this.supportX[slot]!, this.supportY[slot]!,
      this.supportZ[slot]!, 1, 0.56);
    let lift: number, extension: number;
    if (u < 0.28) {
      lift = smooth01(u / 0.28);
      extension = 0;
    } else if (u < 0.56) {
      lift = 1;
      extension = smoother01((u - 0.28) / 0.28);
    } else if (u < 0.64) {
      lift = 1; extension = 1;
    } else if (u < 0.82) {
      lift = 1;
      extension = 1 - smoother01((u - 0.64) / 0.18);
    } else {
      lift = 1 - smoother01((u - 0.82) / 0.18);
      extension = 0;
    }
    const side = left ? -1 : 1;
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
          bodyTaskTargets.targetXFor(a, node) +
            (sideZ * 0.23 - sideX * side * 0.04) * scale,
          bodyTaskTargets.targetYFor(a, node) + 0.42 * scale,
          bodyTaskTargets.targetZFor(a, node) +
            (-sideX * 0.23 - sideZ * side * 0.04) * scale,
          1, 0.94);
      }
    }
  }
  private resolveContact(w: World, a: Actor, rig: BodyRig,
    slot: number, dt: number, u: number) {
    const kind = this.kind[slot]!;
    const fist = kind === PUNCH && a.weapon === 'fist';
    const right = this.punchRight[slot] !== 0;
    const active = kind === KICK
      ? u >= 0.28 && u <= 0.67
      : fist ? this.boxing.contactWindow(slot, u)
        : u >= 0.36 && u <= 0.72;
    let cx: number, cy: number, cz: number, radius: number;
    if (kind === KICK) {
      const foot = this.kickAttackLeft[slot]
        ? BODY.lFoot : BODY.rFoot;
      cx = rig.x[foot]!; cy = rig.y[foot]!; cz = rig.z[foot]!;
      radius = nodeRadius(a, foot) * 1.08;
    } else {
      const hand = fist && !right ? BODY.lHand : BODY.rHand;
      const elbow = fist && !right ? BODY.lElbow : BODY.rElbow;
      const hx = rig.x[hand]!, hy = rig.y[hand]!, hz = rig.z[hand]!;
      let dx = hx - rig.x[elbow]!;
      let dy = hy - rig.y[elbow]!;
      let dz = hz - rig.z[elbow]!;
      let m = Math.hypot(dx, dy, dz);
      if (m < 1e-6) {
        dx = -Math.sin(a.yaw); dy = 0;
        dz = -Math.cos(a.yaw); m = 1;
      }
      dx /= m; dy /= m; dz /= m;
      const scale = bodyScale(a);
      const extra = fist ? 0 : Math.max(0.1,
        WEAPON_STATS[a.weapon].reach - 0.68) * scale;
      cx = hx + dx * extra;
      cy = hy + dy * extra;
      cz = hz + dz * extra;
      radius = (fist ? 0.11 : 0.075) * scale;
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
    const vx = (cx - px) / Math.max(dt, 1e-5);
    const vy = (cy - py) / Math.max(dt, 1e-5);
    const vz = (cz - pz) / Math.max(dt, 1e-5);
    let bestActor: Actor | null = null;
    let bestNode = -1;
    let bestD2 = Infinity;
    let bestVx = vx, bestVy = vy, bestVz = vz;
    for (const o of w.actors) {
      if (o.id === a.id || !o.alive) continue;
      const or = this.bodies.get(o);
      if (!or?.initialized) continue;
      for (const node of CONTACT_NODES) {
        const rr = radius + nodeRadius(o, node);
        const ox = or.x[node]!, oy = or.y[node]!;
        const oz = or.z[node]!;
        const ovx = nodeVelocityComponent(ox, or.px[node]!, dt);
        const ovy = nodeVelocityComponent(oy, or.py[node]!, dt);
        const ovz = nodeVelocityComponent(oz, or.pz[node]!, dt);
        const d2 = segmentPointDist2(
          px - or.px[node]!, py - or.py[node]!,
          pz - or.pz[node]!, cx - ox, cy - oy, cz - oz,
          0, 0, 0);
        if (d2 <= rr * rr && d2 < bestD2) {
          bestD2 = d2;
          bestActor = o;
          bestNode = node;
          bestVx = vx - ovx;
          bestVy = vy - ovy;
          bestVz = vz - ovz;
        }
      }
    }
    if (bestActor && bestNode >= 0) {
      this.hitId[slot] = bestActor.id;
      applyActorMeleeContact(w, a, bestActor,
        NODE_REGION[bestNode]!,
        kind === KICK ? 'kick' : 'strike',
        Math.hypot(bestVx, bestVy, bestVz),
        bestVx, bestVy, bestVz);
      return;
    }
    let bestProp = -1;
    let bestPropD2 = Infinity;
    for (let i = 0; i < w.props.length; i++) {
      const p = w.props[i]!;
      if (p.collapsed || p.heldBy) continue;
      const rr = radius + Math.max(p.sx, p.sy, p.sz) * 0.45;
      const d2 = segmentPointDist2(px, py, pz, cx, cy, cz,
        p.x, p.y + p.sy * 0.5, p.z);
      if (d2 <= rr * rr && d2 < bestPropD2) {
        bestPropD2 = d2; bestProp = i;
      }
    }
    if (bestProp >= 0) {
      const p = w.props[bestProp]!;
      this.hitId[slot] = p.id;
      const speed = Math.hypot(vx, vy, vz);
      const planar = Math.hypot(vx, vz) || 1;
      applyPropMeleeContact(w, a, p,
        kind === KICK ? 'kick' : 'strike',
        speed, vx / planar, vz / planar);
    }
  }
  private register(a: Actor) {
    if (a.id < 0 || a.id >= ENTITY_ID_CAP ||
      this.slotCount >= ACTION_CAP) return -1;
    const existing = this.slotById[a.id]!;
    if (existing >= 0) return existing;
    const slot = this.slotCount++;
    this.slotById[a.id] = slot;
    this.actorId[slot] = a.id;
    return slot;
  }
  private slot(id: number) {
    return id < 0 || id >= ENTITY_ID_CAP
      ? -1 : this.slotById[id]!;
  }
}
