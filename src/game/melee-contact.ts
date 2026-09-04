import type { Actor, Prop, Region } from "./types";
import { FIRE_CELL, WEAPON_STATS } from "./types";
import type { World } from "./world";
import { canSeeThrough, clamp } from "./world";
import { impactDynamics } from "./impact-dynamics";

const KICK_BLUNT = 1.15;
const KICK_MASS = 3.2;

function addKnown(a: Actor, id: number) {
  if (!a.known.includes(id)) a.known.push(id);
}

function registerWitnesses(w: World, atk: Actor, vic: Actor) {
  for (let i = 0; i < w.actors.length; i++) {
    const o = w.actors[i]!;
    if (!o.alive || o.id === atk.id || o.kind === "player" || o.species !== "human") continue;

    if (o.id === vic.id) {
      addKnown(o, atk.id);
      o.alert = 1;
      o.targetId = atk.id;
      o.lastSeenX = atk.x;
      o.lastSeenZ = atk.z;
      o.lastSeenT = w.time;
      w.addMemory(o, "threat", atk.x, atk.z, atk.id, 1);
      continue;
    }

    const dx = atk.x - o.x;
    const dz = atk.z - o.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 15 * 15) continue;
    const d = Math.sqrt(d2) || 1;
    if (!canSeeThrough(w, o.x, o.z, atk.x, atk.z) && d > 4) continue;

    const fx = -Math.sin(o.yaw);
    const fz = -Math.cos(o.yaw);
    const dot = (dx * fx + dz * fz) / d;
    if (d > 5.5 && dot < -0.05) continue;

    const certainty = clamp(1 - d / 18, 0.35, 0.92);
    w.addMemory(o, "threat", atk.x, atk.z, atk.id, certainty);
    o.alert = Math.max(o.alert, 0.75);

    if (o.faction === "guard") {
      addKnown(o, atk.id);
      o.targetId = atk.id;
      o.lastSeenX = atk.x;
      o.lastSeenZ = atk.z;
      o.lastSeenT = w.time;
    } else {
      o.fear = Math.min(1, o.fear + 0.18 * (1 - o.courage));
    }
  }
}

function normalizeDirection(atk: Actor, x: number, y: number, z: number) {
  let m = Math.hypot(x, y, z);
  if (m < 1e-5) {
    x = -Math.sin(atk.yaw);
    y = 0.08;
    z = -Math.cos(atk.yaw);
    m = Math.hypot(x, y, z) || 1;
  }
  return [x / m, y / m, z / m] as const;
}

export function applyActorMeleeContact(
  w: World,
  atk: Actor,
  vic: Actor,
  region: Region,
  kind: "strike" | "kick",
  speed: number,
  dirX: number,
  dirY: number,
  dirZ: number,
) {
  if (!atk.alive || !vic.alive || atk.id === vic.id) return;

  const stats = WEAPON_STATS[atk.weapon];
  const blunt = kind === "kick" ? KICK_BLUNT : stats.blunt;
  const mass = kind === "kick" ? KICK_MASS : stats.mass;
  const cut = kind === "kick" ? 0 : stats.cut;
  const pierce = kind === "kick" ? 0 : stats.pierce;
  const fire = kind === "kick" ? 0 : stats.fire;

  const [nx, ny, nz] = normalizeDirection(atk, dirX, dirY, dirZ);
  const rel = atk.mass / Math.max(1, atk.mass + vic.mass);
  const contactSpeed = clamp(speed, 1.5, 14);
  const force =
    (0.52 + contactSpeed * 0.13) *
    (0.72 + mass * 0.22) *
    (0.8 + atk.strength * 0.4);
  const impulse = force * (2.0 + rel * 1.4);
  const bodyDv = impulse * rel;

  // One contact authority: this impulse field now owns both the visible
  // articulated response and the coarse root momentum consumed by world
  // physics. No parallel Actor-velocity kick is applied here.
  impactDynamics.contactRegion(
    vic,
    region,
    nx * bodyDv,
    ny * bodyDv * 0.82,
    nz * bodyDv,
    kind === "kick" ? 1.08 : 1,
  );

  // Equal-and-opposite recoil enters the attacker's same body field. Heavy
  // targets therefore interrupt posture more than light ones without a
  // separate recoil animation.
  const recoil = clamp((vic.mass / Math.max(1, atk.mass + vic.mass)) * 0.52, 0.16, 0.42);
  impactDynamics.contactRegion(
    atk,
    kind === "kick" ? "rleg" : "torso",
    -nx * bodyDv * recoil,
    -ny * bodyDv * recoil * 0.55,
    -nz * bodyDv * recoil,
    0.72,
  );

  const inj = vic.injuries[region];
  inj.bruise += blunt * 0.2 * force;
  inj.cut += cut * 0.28 * force;
  inj.puncture += pierce * 0.27 * force;

  if (kind === "kick" && (region === "lleg" || region === "rleg" || region === "torso")) {
    inj.sprain += 0.035 + force * 0.025;
  }
  if (fire > 0 || atk.torchLit) {
    inj.burn += 0.18 + fire * 0.08;
    const ci = w.cell(vic.x, vic.z);
    w.heat[ci] = Math.min(2.5, w.heat[ci]! + 0.45 + fire * 0.25);
  }
  if (cut + pierce > 0.4) vic.bleed += 0.055 + cut * 0.065 + pierce * 0.045;
  if (region === "head") {
    vic.consciousness = Math.max(0, vic.consciousness - force * 0.11);
    inj.bruise += 0.12 * force;
    if (blunt > 1 && contactSpeed > 8.4) inj.fracture += 0.05 * force;
  }

  // Injury changes physiology; support/balance/fall state is deliberately not
  // chosen here. BodyCausality derives that from the resulting impulse field,
  // actual foot support, posture, leg integrity and consciousness.
  vic.pain = clamp(vic.pain + 0.13 * force, 0, 1);
  vic.lastHitBy = atk.id;
  vic.lastHitT = w.time;
  vic.alert = 1;
  if (vic.kind !== "player") addKnown(vic, atk.id);

  if (atk.kind === "player") {
    if (vic.faction === "guard") w.wanted = Math.min(1, w.wanted + 0.22);
    else if (vic.faction === "civilian") w.wanted = Math.min(1, w.wanted + 0.12);
    registerWitnesses(w, atk, vic);
  }

  w.emitSound(vic.x, vic.z, 0.42 + Math.min(0.6, force * 0.16), "impact", atk.id);
  if (vic.kind === "human" || vic.kind === "player") {
    if (vic.pain > 0.62 && w.rng() < 0.42) w.emitSound(vic.x, vic.z, 0.68, "scream", vic.id);
    else w.emitSound(vic.x, vic.z, 0.34, "hurt", vic.id);
  }
  w.shake = Math.max(w.shake, 0.1 + Math.min(0.32, force * 0.08));
  if (atk.kind === "player") w.hitstop = Math.max(w.hitstop, 0.032 + Math.min(0.022, force * 0.006));
}

export function applyPropMeleeContact(
  w: World,
  atk: Actor,
  p: Prop,
  kind: "strike" | "kick",
  speed: number,
  dirX: number,
  dirZ: number,
) {
  if (p.collapsed || p.heldBy) return;
  const stats = WEAPON_STATS[atk.weapon];
  const blunt = kind === "kick" ? KICK_BLUNT : stats.blunt;
  const mass = kind === "kick" ? KICK_MASS : stats.mass;
  const dmg = (4.5 + speed * 1.2) * (0.7 + blunt * 0.55 + mass * 0.12);

  p.hp -= dmg;
  p.vx += dirX * (1.4 + speed * 0.12);
  p.vz += dirZ * (1.4 + speed * 0.12);

  const rigidity = clamp(p.mass / Math.max(1, p.mass + atk.mass), 0.08, 0.78);
  const recoil = Math.min(3.2, (0.7 + speed * 0.18) * rigidity);
  impactDynamics.contactRegion(
    atk,
    kind === "kick" ? "rleg" : "torso",
    -dirX * recoil,
    kind === "kick" ? 0.22 * recoil : 0.08 * recoil,
    -dirZ * recoil,
    0.9,
  );

  if (p.kind === "lamp" && dmg > 6 && p.oil) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const i = w.cell(p.x + dx * FIRE_CELL, p.z + dz * FIRE_CELL);
        w.oil[i] = Math.min(1.5, w.oil[i]! + 0.55);
        w.fuel[i] += 0.4;
      }
    }
    p.oil = false;
    const i = w.cell(p.x, p.z);
    w.heat[i] = Math.min(2.5, w.heat[i]! + 0.7);
    w.emitSound(p.x, p.z, 0.5, "break", atk.id);
  }

  if (p.hp <= 0) {
    p.hp = 0;
    p.collapsed = true;
    p.dynamic = true;
    p.anchored = false;
    p.vy = Math.max(p.vy, 1.05);
    for (let i = 0; i < w.colliders.length; i++) {
      const c = w.colliders[i]!;
      if (c.propId === p.id) c.solid = false;
    }
    w.emitSound(p.x, p.z, p.sy > 1.5 ? 1.05 : 0.52, p.sy > 1.5 ? "collapse" : "break", atk.id);
    w.shake = Math.max(w.shake, p.sy > 1.5 ? 0.48 : 0.16);
  } else {
    w.emitSound(p.x, p.z, 0.28, p.material === "metal" ? "metal" : "wood", atk.id);
  }
}
