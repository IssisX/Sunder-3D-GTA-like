import type { Actions } from "./input";
import {
  type Actor,
  type Collider,
  type Prop,
  type WeaponKind,
  WEAPON_STATS,
  FIRE_CELL,
  FIRE_RES,
  GRAVITY,
  HALF,
  REGIONS,
} from "./types";
import {
  World,
  canSeeThrough,
  clamp,
  dist2,
  facing,
  injurySum,
  lerpAng,
  locoSpeed,
  regionFromHit,
  rightOf,
} from "./world";
import {
  agentRandom,
  agentSpeedScale,
  agentTempoScale,
  prepareAgent,
} from "./agent-independence";

const CAM_FORWARD = (yaw: number) => facing(yaw);
const STEP_UP = 0.48;

export interface Cam {
  yaw: number;
  pitch: number;
}

function surfaceAt(w: World, x: number, z: number) {
  if (w.inWater(x, z, 0.4)) return "water";
  const i = w.cell(x, z);
  if (w.oil[i] > 0.3) return "oil";
  if (w.wet[i] > 0.55) return "mud";
  if (Math.abs(x) < 9 && Math.abs(z) < 9) return "cobble";
  if (w.indoorAt(x, z)) return "wood";
  if (z < -16) return "dirt";
  return "dirt";
}

function frictionFor(s: string, wet: number) {
  if (s === "water") return 3.2;
  if (s === "mud") return 4.6;
  if (s === "oil") return 1.1;
  if (s === "cobble") return 8 + wet * 4;
  if (s === "wood") return 7;
  return 6.5;
}

function accelFor(s: string) {
  if (s === "water") return 6;
  if (s === "mud") return 9;
  if (s === "oil") return 5;
  return 22;
}

export function stepWorld(w: World, dt: number, input: Actions, cam: Cam, playing: boolean) {
  w.events.length = 0;
  stepClock(w, dt);
  for (const a of w.actors) {
    a.px = a.x;
    a.py = a.y;
    a.pz = a.z;
    a.pyaw = a.yaw;
  }
  for (const p of w.props) {
    p.px = p.x;
    p.py = p.y;
    p.pz = p.z;
  }
  w.rebuildHash();
  if (playing) applyPlayer(w, dt, input, cam);
  stepPerception(w, dt);
  stepAI(w, dt);
  stepCombat(w, dt, playing ? input : null);
  stepGrab(w, dt, playing ? input : null);
  stepLocomotion(w, dt);
  stepPhysics(w, dt);
  stepInjury(w, dt);
  stepFire(w, dt);
  stepProps(w, dt);
  stepStructures(w, dt);
  stepTracks(w, dt);
  cullSounds(w);
  if (w.shake > 0) w.shake = Math.max(0, w.shake - dt * 1.8);
  if (w.hitstop > 0) w.hitstop = Math.max(0, w.hitstop - dt);
}

function stepClock(w: World, dt: number) {
  w.time += dt;
  w.day = (w.day + dt / 540) % 1;
  if (w.rainTarget === 0 && w.time > 40 && w.rng() < dt * 0.01) {
    w.rainTarget = 0.45 + w.rng() * 0.5;
    w.whisper("Rain starts.");
  }
  if (w.rain > 0.6 && w.rng() < dt * 0.04) {
    w.thunderT = 0;
    w.shake = Math.max(w.shake, 0.35);
    w.emitSound(w.player().x + (w.rng() - 0.5) * 40, w.player().z, 1.6, "impact", 0);
  }
  w.thunderT += dt;
  w.rain += (w.rainTarget - w.rain) * (1 - Math.exp(-dt * 0.15));
  if (w.rain > 0.7 && w.rng() < dt * 0.02) w.windX += (w.rng() - 0.5) * 0.4;
  w.windX = clamp(w.windX, -3, 3);
  w.windZ = clamp(w.windZ + (w.rng() - 0.5) * dt, -2, 2);
}

function applyPlayer(w: World, dt: number, input: Actions, cam: Cam) {
  const p = w.player();
  if (!p.alive) return;
  p.crouch = input.crouch && p.loco !== "ragdoll" && p.loco !== "down";
  if (p.consciousness < 0.35) return;
  if (p.loco === "ragdoll" || p.loco === "down" || p.loco === "getup" || p.loco === "vault") return;

  const f = CAM_FORWARD(cam.yaw);
  const r = rightOf(cam.yaw);
  const wishX = f.x * input.moveY + r.x * input.moveX;
  const wishZ = f.z * input.moveY + r.z * input.moveX;
  const wishMag = Math.hypot(wishX, wishZ);
  p.intendX = wishMag > 0.05 ? wishX / wishMag : 0;
  p.intendZ = wishMag > 0.05 ? wishZ / wishMag : 0;

  const leg =
    1 -
    clamp(injurySum(p.injuries.lleg) + injurySum(p.injuries.rleg), 0, 1.6) * 0.35;
  const load = 1 / (1 + p.carry / 90);
  const mud = surfaceAt(w, p.x, p.z) === "mud" ? 0.72 : 1;
  let max = p.crouch ? 1.62 : 4.6;
  if (input.sprint && p.stamina > 0.08 && wishMag > 0.2 && !p.crouch) max = 7.6;
  max *= leg * load * mud * (0.55 + p.consciousness * 0.45) * (1 - p.fatigue * 0.35);
  if (p.grabbedId) max *= 0.72;
  p.intendSpeed = wishMag * max;

  if (wishMag > 0.08) {
    const ty = Math.atan2(-p.intendX, -p.intendZ);
    p.yaw = lerpAng(p.yaw, ty, 1 - Math.exp(-dt * 8));
  }

  if (input.sprint && wishMag > 0.2 && !p.crouch) {
    p.stamina = Math.max(0, p.stamina - dt * 0.18);
    p.fatigue = Math.min(1, p.fatigue + dt * 0.04);
  } else {
    p.stamina = Math.min(1, p.stamina + dt * 0.14 * (p.crouch ? 1.4 : 1) * (1 - p.pain * 0.4));
    p.fatigue = Math.max(0, p.fatigue - dt * 0.03);
  }

  if (input.jumpPressed && p.grounded) {
    const front = probeHeight(w, p.x + f.x * 0.7, p.z + f.z * 0.7);
    if (front > 0.35 && front < 1.15 && locoSpeed(p) > 2.2) {
      p.loco = "vault";
      p.vaultT = 0.38;
      p.vy = 3.6;
      p.vx += f.x * 2.2;
      p.vz += f.z * 2.2;
    } else if (front > 1.15 && front < 2.4) {
      p.loco = "climb";
      p.locoT = 0.55;
      p.vy = 2.4;
    } else {
      p.vy = 6.2 * (0.7 + p.stamina * 0.3) * leg;
      p.grounded = false;
      p.stamina -= 0.08;
    }
  }

  if (input.bandage) treat(w, p, dt);
  if (input.ignitePressed) tryIgnite(w, p);
  if (input.dropPressed) dropHeld(w, p, 0.5);

  if (wishMag > 0.22 && p.grounded && Math.hypot(p.vx, p.vz) < 0.1) {
    p.recovT += dt;
    if (p.recovT > 0.28) {
      unstickActor(w, p);
      p.recovT = 0;
    }
  } else {
    p.recovT = 0;
  }
}

function probeHeight(w: World, x: number, z: number) {
  let h = 0;
  for (const c of w.colliders) {
    if (!c.solid || c.water) continue;
    if (x > c.minX - 0.15 && x < c.maxX + 0.15 && z > c.minZ - 0.15 && z < c.maxZ + 0.15) {
      h = Math.max(h, c.maxY);
    }
  }
  return h;
}

function treat(w: World, p: Actor, dt: number) {
  p.intendSpeed = Math.min(p.intendSpeed, 0.6);
  p.bleed = Math.max(0, p.bleed - dt * 0.35);
  for (const r of REGIONS) {
    p.injuries[r].cut = Math.max(0, p.injuries[r].cut - dt * 0.12);
    p.injuries[r].puncture = Math.max(0, p.injuries[r].puncture - dt * 0.08);
    p.injuries[r].burn = Math.max(0, p.injuries[r].burn - dt * 0.06);
  }
  p.pain = Math.max(0, p.pain - dt * 0.2);
}

function tryIgnite(w: World, p: Actor) {
  const f = facing(p.yaw);
  const tx = p.x + f.x * 1.1;
  const tz = p.z + f.z * 1.1;
  if (p.weapon === "torch" || p.torchLit) {
    igniteAt(w, tx, tz, 0.9);
    p.torchLit = true;
    w.emitSound(tx, tz, 0.4, "fire", p.id);
    w.whisper("Flame catches.");
    return;
  }
  const i = w.cell(tx, tz);
  if (w.burning[i]) {
    w.burning[i] = 0;
    w.heat[i] *= 0.2;
    w.wet[i] = Math.min(1, w.wet[i] + 0.5);
    w.whisper("You smother the fire.");
  }
}

function dropHeld(w: World, p: Actor, throwMul: number) {
  if (p.grabbedId) {
    const t = w.actor(p.grabbedId) || w.prop(p.grabbedId);
    if (t && "mass" in t) {
      const f = facing(p.yaw);
      const spd = 4.5 * throwMul * (p.mass / (p.mass + t.mass));
      if ("species" in t) {
        const a = t as Actor;
        a.grabbedBy = 0;
        a.vx += f.x * spd + p.vx;
        a.vz += f.z * spd + p.vz;
        a.vy += 2.4 * throwMul;
        a.loco = "ragdoll";
        a.locoT = 0.8;
        a.balance = 0;
      } else {
        const pr = t as Prop;
        pr.heldBy = 0;
        pr.dynamic = true;
        pr.anchored = false;
        pr.vx += f.x * spd * 1.4 + p.vx;
        pr.vz += f.z * spd * 1.4 + p.vz;
        pr.vy += 3 * throwMul;
      }
    }
    p.grabbedId = 0;
    p.carry = 0;
    w.emitSound(p.x, p.z, 0.5, "whoosh", p.id);
    return;
  }
}

function stepPerception(w: World, dt: number) {
  const hour = w.day;
  const light = hour > 0.25 && hour < 0.75 ? 1 : hour > 0.2 && hour < 0.8 ? 0.45 : 0.18;
  for (const a of w.actors) {
    if (a.kind === "player" || !a.alive) continue;
    a.alert = Math.max(0, a.alert - dt * 0.08);
    a.shoutCd = Math.max(0, a.shoutCd - dt);
    const visRange =
      (a.species === "wolf" ? 22 : a.species === "deer" ? 18 : a.species === "bear" ? 16 : 16) *
      (0.45 + light * 0.55) *
      (1 - w.rain * 0.25);
    const hearMul = 1 - w.rain * 0.2;
    for (const s of w.sounds) {
      if (w.time - s.t > 0.25) continue;
      const d = Math.hypot(s.x - a.x, s.z - a.z);
      const reach = s.mag * 22 * hearMul;
      if (d < reach) {
        w.addMemory(a, "sound", s.x, s.z, s.who, clamp(1 - d / reach, 0.2, 1));
        if (s.kind === "scream" || s.kind === "collapse" || s.kind === "weapon") a.alert = Math.min(1, a.alert + 0.4);
        if (s.kind === "scream") a.fear = Math.min(1, a.fear + 0.2 * (1 - a.courage));
      }
    }
    const others = w.nearby(a.x, a.z, visRange);
    for (const o of others) {
      if (o.id === a.id) continue;
      const dx = o.x - a.x;
      const dz = o.z - a.z;
      const d = Math.hypot(dx, dz);
      const f = facing(a.yaw);
      const dot = d > 0.01 ? (dx * f.x + dz * f.z) / d : 1;
      const fov = a.species === "deer" ? 0.15 : 0.32;
      if (dot < fov && d > 2.2) continue;
      const smoke = w.smoke[w.cell(o.x, o.z)] + w.smoke[w.cell((a.x + o.x) * 0.5, (a.z + o.z) * 0.5)];
      let chance = (1 - d / visRange) * (0.4 + dot) * (o.crouch ? 0.45 : 1) * (o.loco === "sprint" ? 1.2 : 1);
      chance *= 1 - Math.min(0.8, smoke * 0.5);
      chance *= 1 - (o.loco === "idle" && o.crouch ? 0.5 : 0);
      if (w.indoorAt(o.x, o.z) && !w.indoorAt(a.x, a.z)) chance *= 0.45;
      if (chance < 0.12) continue;
      if (!canSeeThrough(w, a.x, a.z, o.x, o.z) && d > 3) continue;
      if (isThreat(a, o, w)) {
        a.lastSeenX = o.x;
        a.lastSeenZ = o.z;
        a.lastSeenT = w.time;
        a.targetId = o.id;
        a.alert = 1;
        w.addMemory(a, "threat", o.x, o.z, o.id, 1);
        if (!a.known.includes(o.id)) a.known.push(o.id);
      }
      if (!o.alive) {
        w.addMemory(a, "body", o.x, o.z, o.id, 1);
        a.fear = Math.min(1, a.fear + 0.25 * (1 - a.courage));
      }
    }
    for (let i = 0; i < w.burning.length; i++) {
      if (!w.burning[i]) continue;
      const p = w.ixz(i);
      if (dist2(a.x, a.z, p.x, p.z) < 18 * 18) {
        w.addMemory(a, "fire", p.x, p.z, 0, 0.8);
        if (dist2(a.x, a.z, p.x, p.z) < 36) a.fear = Math.min(1, a.fear + dt * 0.4);
      }
    }
    for (const m of a.memories) {
      m.certainty *= 1 - dt * 0.05;
    }
    a.memories = a.memories.filter((m) => m.certainty > 0.08 && w.time - m.t < 90);
  }
}

function isThreat(a: Actor, o: Actor, w: World) {
  if (!o.alive) return false;
  if (a.known.includes(o.id)) return true;
  if (o.kind === "player") {
    if (a.faction === "guard" && (w.wanted > 0.15 || (o.weapon !== "fist" && w.wanted > 0))) return true;
    if (a.species === "wolf" || a.species === "bear") {
      if (o.bleed > 0.15 || o.blood < 0.85) return true;
      if (a.species === "bear" && dist2(a.x, a.z, o.x, o.z) < 36) return a.aggression > 0.3;
    }
    if (a.faction === "civilian" && (o.strikeT > 0 || o.weapon !== "fist") && dist2(a.x, a.z, o.x, o.z) < 25) return true;
  }
  if (a.species === "wolf" && (o.species === "deer" || o.species === "goat" || o.species === "pig" || o.species === "cow"))
    return true;
  if (a.species === "bear" && (o.species === "deer" || o.species === "pig" || o.species === "cow" || o.kind === "human"))
    return dist2(a.x, a.z, o.x, o.z) < 80;
  if (a.species === "deer" && (o.kind === "human" || o.kind === "player" || o.species === "wolf" || o.species === "bear"))
    return true;
  if (a.faction === "guard" && o.faction === "wild" && o.species !== "deer") return true;
  if (o.lastHitBy === a.id) return false;
  if (a.lastHitBy === o.id && w.time - a.lastHitT < 20) return true;
  return false;
}

function stepAI(w: World, dt: number) {
  for (const a of w.actors) {
    if (a.kind === "player" || !a.alive) continue;
    prepareAgent(w, a);
    if (a.loco === "ragdoll" || a.loco === "down" || a.loco === "getup" || a.grabbedBy) {
      a.intendSpeed = 0;
      continue;
    }
    a.aiT -= dt * agentTempoScale(a);
    a.fear = clamp(a.fear - dt * 0.05, 0, 1);
    const nearbyFire = closestFire(w, a.x, a.z);
    if (nearbyFire && nearbyFire.d < 3.2) {
      const dx = a.x - nearbyFire.x;
      const dz = a.z - nearbyFire.z;
      const m = Math.hypot(dx, dz) || 1;
      a.intendX = dx / m;
      a.intendZ = dz / m;
      a.intendSpeed = 5 * agentSpeedScale(a);
      a.ai = "flee";
      continue;
    }
    if (a.species !== "human") {
      beastAI(w, a, dt);
      continue;
    }
    humanAI(w, a, dt, nearbyFire);
  }
}

function closestFire(w: World, x: number, z: number) {
  let best = 99;
  let bx = 0;
  let bz = 0;
  for (let i = 0; i < w.burning.length; i++) {
    if (!w.burning[i]) continue;
    const p = w.ixz(i);
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < best) {
      best = d;
      bx = p.x;
      bz = p.z;
    }
  }
  if (best > 28) return null;
  return { x: bx, z: bz, d: best };
}

function seek(a: Actor, x: number, z: number, speed: number) {
  const dx = x - a.x;
  const dz = z - a.z;
  const m = Math.hypot(dx, dz);
  if (m < 0.4) {
    a.intendSpeed = 0;
    return m;
  }
  a.intendX = dx / m;
  a.intendZ = dz / m;
  a.intendSpeed = speed * agentSpeedScale(a);
  a.yaw = lerpAng(a.yaw, Math.atan2(-a.intendX, -a.intendZ), 0.25);
  return m;
}

function humanAI(w: World, a: Actor, dt: number, fire: { x: number; z: number; d: number } | null) {
  const player = w.player();
  const seesPlayer = a.targetId === player.id && w.time - a.lastSeenT < 0.6;
  const hostile = a.known.includes(player.id) || (a.faction === "guard" && w.wanted > 0.2);
  const panic = a.fear > 0.55 + a.courage * 0.35;

  if (panic && a.faction !== "guard") {
    a.ai = "flee";
    const awayX = a.x - player.x;
    const awayZ = a.z - player.z;
    const m = Math.hypot(awayX, awayZ) || 1;
    seek(a, a.x + (awayX / m) * 10, a.z + (awayZ / m) * 10, 5.4);
    if (a.shoutCd <= 0) {
      w.emitSound(a.x, a.z, 0.9, "scream", a.id);
      a.shoutCd = 2.4;
      spreadFear(w, a);
    }
    return;
  }

  if (fire && fire.d < 7 && a.faction !== "guard" && a.courage < 0.7) {
    a.ai = "flee";
    seek(a, a.x + (a.x - fire.x), a.z + (a.z - fire.z), 4.5);
    return;
  }

  if (fire && fire.d < 5 && a.faction === "guard" && a.courage > 0.5) {
    a.ai = "extinguish";
    const d = seek(a, fire.x, fire.z, 3.5);
    if (d < 1.6) {
      const i = w.cell(fire.x, fire.z);
      w.heat[i] *= 0.85;
      w.wet[i] = Math.min(1, w.wet[i] + dt * 0.8);
      if (w.heat[i] < 0.3) w.burning[i] = 0;
    }
    return;
  }

  if (a.faction === "guard" && hostile) {
    if (seesPlayer) {
      a.ai = "combat";
      const d = Math.hypot(player.x - a.x, player.z - a.z);
      if (d > 1.5) seek(a, player.x, player.z, 5.2);
      else a.intendSpeed = 0.4 * agentSpeedScale(a);
      a.targetId = player.id;
      if (a.shoutCd <= 0) {
        w.emitSound(a.x, a.z, 1.0, "shout", a.id);
        a.shoutCd = 3;
        callAllies(w, a, player);
      }
      if (d < WEAPON_STATS[a.weapon].reach + 0.4 && a.attackCd <= 0) {
        a.strikeT = 0.32;
        a.strikeCd = 0.7 / (0.7 + a.competence);
        a.strikeHit = 0;
        a.attackCd = a.strikeCd;
      }
      return;
    }
    if (w.time - a.lastSeenT < 8) {
      a.ai = "pursue";
      const d = seek(a, a.lastSeenX, a.lastSeenZ, 5.4);
      if (d < 1.2) {
        a.ai = "search";
        a.searchT = 7;
        pickSearch(w, a);
      }
      return;
    }
    if (a.ai === "search" || a.searchT > 0) {
      a.searchT -= dt;
      a.ai = "search";
      const d = seek(a, a.searchX, a.searchZ, 3.2);
      if (d < 1 || a.aiT <= 0) pickSearch(w, a);
      followTracks(w, a);
      if (a.searchT <= 0) a.ai = "wander";
      return;
    }
  }

  if (a.faction === "guard" && a.alert > 0.4) {
    const mem = a.memories.find((m) => m.kind === "threat" || m.kind === "sound");
    if (mem) {
      a.ai = "investigate";
      seek(a, mem.x, mem.z, 3.6);
      return;
    }
  }

  const ally = w.nearby(a.x, a.z, 8).find((o) => o.faction === a.faction && o.alive && o.blood < 0.55 && o.id !== a.id);
  if (ally && a.loyalty > 0.45 && a.fear < 0.6) {
    a.ai = "rescue";
    const d = seek(a, ally.x, ally.z, 3.8);
    if (d < 1.2 && a.grabbedId === 0) {
      a.grabbedId = ally.id;
      ally.grabbedBy = a.id;
      a.carry = ally.mass * 0.5;
    }
    if (a.grabbedId === ally.id) seek(a, a.homeX, a.homeZ, 2.4);
    return;
  }

  if (a.routine.length) {
    a.ai = "work";
    const wp = a.routine[a.routineI % a.routine.length]!;
    const d = seek(a, wp.x, wp.z, 1.7);
    if (d < 0.8) {
      a.routineI++;
      a.intendSpeed = 0;
      a.aiT = 1 + agentRandom(w, a) * 2;
    }
    return;
  }

  a.ai = "wander";
  if (a.aiT <= 0) {
    a.wayX = a.homeX + (agentRandom(w, a) - 0.5) * 10;
    a.wayZ = a.homeZ + (agentRandom(w, a) - 0.5) * 10;
    a.aiT = 3 + agentRandom(w, a) * 4;
  }
  seek(a, a.wayX, a.wayZ, 1.5);
}

function pickSearch(w: World, a: Actor) {
  const ang = agentRandom(w, a) * Math.PI * 2;
  const r = 3 + agentRandom(w, a) * 7;
  a.searchX = a.lastSeenX + Math.cos(ang) * r;
  a.searchZ = a.lastSeenZ + Math.sin(ang) * r;
  a.aiT = 2 + agentRandom(w, a) * 2;
}

function followTracks(w: World, a: Actor) {
  let best: (typeof w.tracks)[0] | null = null;
  let bd = 9;
  for (const t of w.tracks) {
    if (w.time - t.t > 25) continue;
    const d = Math.hypot(t.x - a.x, t.z - a.z);
    if (d < bd && t.actorId === w.playerId) {
      bd = d;
      best = t;
    }
  }
  if (best) {
    a.searchX = best.x + Math.cos(best.heading) * 2;
    a.searchZ = best.z + Math.sin(best.heading) * 2;
  }
}

function callAllies(w: World, a: Actor, player: Actor) {
  for (const o of w.nearby(a.x, a.z, 22)) {
    if (o.faction !== a.faction || o.id === a.id) continue;
    w.addMemory(o, "threat", player.x, player.z, player.id, 0.7);
    if (!o.known.includes(player.id)) o.known.push(player.id);
    o.alert = Math.max(o.alert, 0.8);
    o.lastSeenX = a.lastSeenX;
    o.lastSeenZ = a.lastSeenZ;
    o.lastSeenT = w.time;
  }
  w.wanted = Math.min(1, w.wanted + 0.25);
  w.whisper("A shout carries.");
}

function spreadFear(w: World, a: Actor) {
  for (const o of w.nearby(a.x, a.z, 12)) {
    if (o.id === a.id || o.kind === "player") continue;
    o.fear = Math.min(1, o.fear + 0.2 * (1 - o.courage));
  }
}

function beastAI(w: World, a: Actor, _dt: number) {
  if (a.species === "deer" || a.species === "goat" || a.species === "pig" || a.species === "cow") {
    const threat = w.nearby(a.x, a.z, a.species === "deer" ? 14 : 8).find((o) => {
      if (o.id === a.id || !o.alive) return false;
      return o.kind === "player" || o.kind === "human" || o.species === "wolf" || o.species === "bear" || o.strikeT > 0;
    });
    const fire = closestFire(w, a.x, a.z);
    if (threat || (fire && fire.d < 8) || a.fear > 0.4) {
      a.ai = "flee";
      a.fear = Math.min(1, a.fear + 0.3);
      const tx = threat ? threat.x : fire ? fire.x : a.x;
      const tz = threat ? threat.z : fire ? fire.z : a.z;
      seek(a, a.x + (a.x - tx) * 2, a.z + (a.z - tz) * 2, a.species === "cow" ? 4.2 : 6.5);
      if (a.species !== "deer" && a.shoutCd <= 0) {
        w.emitSound(a.x, a.z, 0.7, "animal", a.id);
        a.shoutCd = 1.6;
      }
      if (a.species !== "deer") breakFence(w, a);
      return;
    }
    a.ai = "graze";
    if (a.aiT <= 0) {
      a.wayX = a.homeX + (agentRandom(w, a) - 0.5) * (a.species === "deer" ? 16 : 5);
      a.wayZ = a.homeZ + (agentRandom(w, a) - 0.5) * (a.species === "deer" ? 16 : 5);
      a.aiT = 2 + agentRandom(w, a) * 4;
    }
    seek(a, a.wayX, a.wayZ, 1.1);
    return;
  }
  if (a.species === "wolf") {
    const prey = w
      .nearby(a.x, a.z, 24)
      .filter(
        (o) =>
          o.alive &&
          o.id !== a.id &&
          (o.species === "deer" ||
            o.species === "goat" ||
            o.species === "pig" ||
            (o.kind === "player" && (o.blood < 0.85 || o.bleed > 0.1))),
      )
      .sort((b, c) => dist2(a.x, a.z, b.x, b.z) - dist2(a.x, a.z, c.x, c.z))[0];
    if (prey) {
      a.ai = "hunt";
      a.targetId = prey.id;
      const d = seek(a, prey.x, prey.z, 6.4);
      if (d < 1.3 && a.attackCd <= 0) {
        a.strikeT = 0.28;
        a.strikeHit = 0;
        a.attackCd = 0.8;
      }
      return;
    }
    a.ai = "wander";
    if (a.aiT <= 0) {
      a.wayX = a.homeX + (agentRandom(w, a) - 0.5) * 18;
      a.wayZ = a.homeZ + (agentRandom(w, a) - 0.5) * 18;
      a.aiT = 3.4 + agentRandom(w, a) * 1.2;
    }
    seek(a, a.wayX, a.wayZ, 2.4);
    return;
  }
  if (a.species === "bear") {
    const close = w
      .nearby(a.x, a.z, 16)
      .filter((o) => o.alive && o.id !== a.id && (o.kind === "player" || o.kind === "human" || o.species === "cow" || o.species === "pig"))
      .sort((b, c) => dist2(a.x, a.z, b.x, b.z) - dist2(a.x, a.z, c.x, c.z))[0];
    if (close && (a.aggression > 0.3 || close.bleed > 0 || dist2(a.x, a.z, close.x, close.z) < 25)) {
      a.ai = "hunt";
      a.targetId = close.id;
      const d = seek(a, close.x, close.z, 5.6);
      if (d < 2 && a.attackCd <= 0) {
        a.strikeT = 0.4;
        a.strikeHit = 0;
        a.attackCd = 1.1;
        w.emitSound(a.x, a.z, 1.1, "animal", a.id);
      }
      return;
    }
    if (a.aiT <= 0) {
      a.wayX = a.homeX + (agentRandom(w, a) - 0.5) * 20;
      a.wayZ = a.homeZ + (agentRandom(w, a) - 0.5) * 14;
      a.aiT = 4.2 + agentRandom(w, a) * 1.6;
    }
    seek(a, a.wayX, a.wayZ, 1.8);
  }
}

function breakFence(w: World, a: Actor) {
  for (const p of w.props) {
    if (p.kind !== "fence" && p.kind !== "gate") continue;
    if (dist2(a.x, a.z, p.x, p.z) > 2.2) continue;
    p.hp -= 12 * (a.mass / 80);
    if (p.hp <= 0 && !p.collapsed) collapseProp(w, p, a.vx, a.vz);
  }
}

function stepCombat(w: World, dt: number, input: Actions | null) {
  const p = w.player();
  if (input && p.alive && p.consciousness > 0.4) {
    if (input.attackPressed && p.strikeCd <= 0 && p.loco !== "ragdoll") {
      p.strikeT = 0.3 / WEAPON_STATS[p.weapon].speed;
      p.strikeCd = 0.42 / WEAPON_STATS[p.weapon].speed;
      p.strikeHit = 0;
      p.stamina = Math.max(0, p.stamina - 0.06);
      w.emitSound(p.x, p.z, 0.35, "weapon", p.id);
    }
    if (input.kickPressed && p.kickT <= 0 && p.grounded) {
      p.kickT = 0.28;
      w.emitSound(p.x, p.z, 0.3, "whoosh", p.id);
    }
    if (input.shovePressed) {
      p.shoveT = 0.22;
    }
  }
  for (const a of w.actors) {
    a.strikeCd = Math.max(0, a.strikeCd - dt);
    a.attackCd = Math.max(0, a.attackCd - dt);
    if (a.strikeT > 0) {
      a.strikeT -= dt;
      const st = WEAPON_STATS[a.weapon] ?? WEAPON_STATS.fist;
      const active = a.strikeT < 0.18 && a.strikeT > 0.04;
      if (active) {
        const f = facing(a.yaw);
        const reach = st.reach * (a.species === "bear" ? 1.6 : 1);
        for (const o of w.nearby(a.x, a.z, reach + 0.6)) {
          if (o.id === a.id || !o.alive) continue;
          if (a.strikeHit & (1 << (o.id % 30))) continue;
          const dx = o.x - a.x;
          const dz = o.z - a.z;
          const d = Math.hypot(dx, dz);
          if (d > reach + o.radius) continue;
          const dot = d > 0 ? (dx * f.x + dz * f.z) / d : 1;
          if (dot < 0.25) continue;
          a.strikeHit |= 1 << (o.id % 30);
          const speed = Math.hypot(a.vx, a.vz) + 2.2;
          hitActor(w, a, o, st, speed, "strike");
        }
        for (const pr of w.props) {
          if (pr.collapsed || pr.heldBy) continue;
          if (dist2(a.x + f.x * 0.8, a.z + f.z * 0.8, pr.x, pr.z) > 1.6) continue;
          damageProp(w, pr, 8 + st.blunt * 14, a.vx + f.x * 3, a.vz + f.z * 3, a);
        }
      }
    }
    if (a.kickT > 0) {
      a.kickT -= dt;
      if (a.kickT < 0.16 && a.kickT > 0.08) {
        const f = facing(a.yaw);
        for (const o of w.nearby(a.x, a.z, 1.4)) {
          if (o.id === a.id) continue;
          const dx = o.x - a.x;
          const dz = o.z - a.z;
          if (dx * f.x + dz * f.z < 0) continue;
          hitActor(w, a, o, { ...WEAPON_STATS.fist, blunt: 1.1, reach: 1.1 }, 3, "kick");
          o.injuries.lleg.sprain += 0.15;
          o.vy += 0.6;
        }
      }
    }
    if (a.shoveT > 0) {
      a.shoveT -= dt;
      if (a.shoveT < 0.16) {
        const f = facing(a.yaw);
        for (const o of w.nearby(a.x, a.z, 1.25)) {
          if (o.id === a.id) continue;
          const rel = a.mass / (a.mass + o.mass);
          o.vx += f.x * 5.5 * rel;
          o.vz += f.z * 5.5 * rel;
          o.balance -= 0.45 * rel;
          if (o.balance < 0.25) {
            o.loco = "stumble";
            o.locoT = 0.4;
          }
        }
      }
    }
  }
}

function hitActor(
  w: World,
  atk: Actor,
  vic: Actor,
  st: (typeof WEAPON_STATS)[WeaponKind],
  speed: number,
  how: "strike" | "kick" | "throw",
) {
  const f = facing(atk.yaw);
  const rel = atk.mass / (atk.mass + vic.mass);
  const force = (0.6 + speed * 0.25) * (0.7 + st.mass * 0.25) * (0.8 + atk.strength * 0.4);
  vic.vx += f.x * force * 3.2 * rel;
  vic.vz += f.z * force * 3.2 * rel;
  vic.balance -= 0.35 + st.blunt * 0.35 * rel;
  const side = rightOf(atk.yaw).x * (vic.x - atk.x) + rightOf(atk.yaw).z * (vic.z - atk.z);
  const region = how === "kick" ? (Math.random() < 0.5 ? "lleg" : "rleg") : regionFromHit(1.1 + Math.random() * 0.5, side);
  const inj = vic.injuries[region];
  inj.bruise += st.blunt * 0.28 * force;
  inj.cut += st.cut * 0.32 * force;
  inj.puncture += st.pierce * 0.3 * force;
  if (st.fire > 0 || atk.torchLit) {
    inj.burn += 0.25;
    igniteAt(w, vic.x, vic.z, 0.35);
  }
  if (st.cut + st.pierce > 0.4) vic.bleed += 0.08 + st.cut * 0.08;
  if (region === "head") {
    vic.consciousness -= 0.18 * force;
    inj.bruise += 0.2;
  }
  if (st.blunt > 1 && region === "head") inj.fracture += 0.12;
  vic.pain = clamp(vic.pain + 0.2 * force, 0, 1);
  vic.lastHitBy = atk.id;
  vic.lastHitT = w.time;
  if (!vic.known.includes(atk.id) && vic.kind !== "player") vic.known.push(atk.id);
  if (atk.kind === "player" && vic.faction === "guard") w.wanted = Math.min(1, w.wanted + 0.35);
  if (atk.kind === "player" && vic.faction === "civilian") w.wanted = Math.min(1, w.wanted + 0.2);
  vic.alert = 1;
  if (vic.balance < 0.15 || force > 1.6) {
    vic.loco = "ragdoll";
    vic.locoT = 0.7 + (1 - vic.balance);
    vic.vy += 1.2 * rel;
  } else if (vic.balance < 0.45) {
    vic.loco = "stumble";
    vic.locoT = 0.45;
  }
  w.emitSound(vic.x, vic.z, 0.55 + force * 0.2, "impact", atk.id);
  if (vic.kind === "human" || vic.kind === "player") {
    if (vic.pain > 0.5 && Math.random() < 0.5) w.emitSound(vic.x, vic.z, 0.7, "scream", vic.id);
    else w.emitSound(vic.x, vic.z, 0.4, "hurt", vic.id);
  }
  w.shake = Math.max(w.shake, 0.18 + force * 0.12);
  w.hitstop = Math.max(w.hitstop, 0.04);
  if (atk.kind === "player") w.hitstop = 0.055;
}

function stepGrab(w: World, dt: number, input: Actions | null) {
  const p = w.player();
  if (input && p.alive) {
    if (input.grabPressed && !p.grabbedId && p.loco !== "ragdoll") {
      const f = facing(p.yaw);
      let best: Actor | Prop | null = null;
      let bd = 1.7;
      for (const o of w.nearby(p.x, p.z, 1.8)) {
        if (o.id === p.id) continue;
        const dx = o.x - p.x;
        const dz = o.z - p.z;
        const d = Math.hypot(dx, dz);
        const dot = (dx * f.x + dz * f.z) / (d || 1);
        if (dot < 0.1) continue;
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
      for (const pr of w.props) {
        if (pr.anchored && pr.mass > 40 && !pr.dynamic) continue;
        if (pr.kind === "wall" || pr.kind === "roof") continue;
        const d = Math.hypot(pr.x - p.x, pr.z - p.z);
        const dx = pr.x - p.x;
        const dz = pr.z - p.z;
        const dot = (dx * f.x + dz * f.z) / (d || 1);
        if (dot < 0.05 || d > 1.7) continue;
        if (d < bd) {
          bd = d;
          best = pr;
        }
      }
      if (best) {
        p.grabbedId = best.id;
        if ("species" in best) {
          const a = best as Actor;
          const rel = p.mass / (p.mass + a.mass);
          if (rel < 0.38 && a.balance > 0.6 && a.grounded) {
            a.balance -= 0.3;
            p.grabbedId = 0;
            w.emitSound(p.x, p.z, 0.3, "grab", p.id);
          } else {
            a.grabbedBy = p.id;
            p.carry = a.mass * 0.45;
            w.emitSound(p.x, p.z, 0.4, "grab", p.id);
          }
        } else {
          const pr = best as Prop;
          pr.heldBy = p.id;
          pr.dynamic = true;
          pr.anchored = false;
          p.carry = pr.mass;
          if (pr.weapon) p.weapon = pr.weapon;
          if (pr.kind === "lamp") p.weapon = "torch";
          if (pr.kind === "board") p.weapon = "board";
          w.emitSound(p.x, p.z, 0.3, "grab", p.id);
        }
      }
    }
    if (input.grabReleased && p.grabbedId) {
      const spd = 7 + Math.hypot(p.vx, p.vz);
      dropHeld(w, p, clamp(spd / 6, 0.8, 1.8));
    }
  }
  for (const a of w.actors) {
    if (!a.grabbedId) continue;
    const t = w.actor(a.grabbedId);
    const pr = t ? null : w.prop(a.grabbedId);
    const f = facing(a.yaw);
    if (t) {
      t.x = a.x + f.x * 0.55;
      t.z = a.z + f.z * 0.55;
      t.y = a.y + (a.loco === "ragdoll" ? 0.2 : 0.15);
      t.vx = a.vx;
      t.vz = a.vz;
      t.vy = a.vy;
      t.yaw = a.yaw;
      if (!t.alive) {
        a.carry = t.mass * 0.7;
      }
    } else if (pr) {
      pr.x = a.x + f.x * 0.5;
      pr.z = a.z + f.z * 0.5;
      pr.y = a.y + a.height * 0.55;
      pr.vx = a.vx;
      pr.vz = a.vz;
      pr.yaw = a.yaw;
    } else {
      a.grabbedId = 0;
      a.carry = 0;
    }
  }
}

function stepLocomotion(w: World, dt: number) {
  for (const a of w.actors) {
    if (a.grabbedBy) continue;
    if (a.vaultT > 0) {
      a.vaultT -= dt;
      if (a.vaultT <= 0) a.loco = "idle";
    }
    if (a.loco === "climb") {
      a.locoT -= dt;
      if (a.locoT <= 0) a.loco = "idle";
    }
    if (a.loco === "getup") {
      a.getupT -= dt;
      a.intendSpeed = 0;
      if (a.getupT <= 0) {
        a.loco = "idle";
        a.balance = 0.6;
      }
      continue;
    }
    if (a.loco === "ragdoll") {
      a.locoT -= dt;
      if (a.grounded && Math.hypot(a.vx, a.vz) < 0.7 && a.locoT <= 0 && a.consciousness > 0.25 && a.alive) {
        a.loco = "getup";
        a.getupT = 0.7 + (1 - a.consciousness) * 0.6;
      }
      continue;
    }
    if (a.loco === "stumble") {
      a.locoT -= dt;
      a.intendSpeed *= 0.4;
      if (a.locoT <= 0) a.loco = "idle";
    }
    if (a.loco === "down") {
      a.intendSpeed = 0;
      continue;
    }
    const spd = a.intendSpeed;
    if (spd > 5.2) a.loco = "sprint";
    else if (spd > 3.2) a.loco = "run";
    else if (spd > 0.4) a.loco = a.crouch ? "crouch" : "walk";
    else a.loco = a.crouch ? "crouch" : "idle";
    if (a.y < -0.05 && w.inWater(a.x, a.z, a.y + 0.4)) a.loco = "swim";
    a.walkPhase += Math.hypot(a.vx, a.vz) * dt * 2.4;
  }
}

function stepPhysics(w: World, dt: number) {
  for (const a of w.actors) {
    if (a.grabbedBy) continue;
    const surf = surfaceAt(w, a.x, a.z);
    const water = w.inWater(a.x, a.z, a.y + 0.5);
    const fr = frictionFor(surf, w.wet[w.cell(a.x, a.z)]);
    const acc = accelFor(surf);
    if (a.loco !== "ragdoll") {
      const wishX = a.intendX * a.intendSpeed;
      const wishZ = a.intendZ * a.intendSpeed;
      a.vx += (wishX - a.vx) * (1 - Math.exp(-dt * acc * 0.25));
      a.vz += (wishZ - a.vz) * (1 - Math.exp(-dt * acc * 0.25));
      if (a.intendSpeed < 0.1) {
        a.vx *= Math.exp(-dt * fr);
        a.vz *= Math.exp(-dt * fr);
      }
    } else {
      a.vx *= Math.exp(-dt * (fr * 0.4));
      a.vz *= Math.exp(-dt * (fr * 0.4));
    }
    if (water) {
      a.vx *= Math.exp(-dt * 3.5);
      a.vz *= Math.exp(-dt * 3.5);
      a.wet = Math.min(1, a.wet + dt * 1.5);
      if (a.y < water.maxY - 0.35) {
        a.submerged += dt;
        a.breath = Math.max(0, a.breath - dt * 0.35);
        a.vy += 4 * dt;
      } else {
        a.submerged = Math.max(0, a.submerged - dt);
        a.breath = Math.min(1, a.breath + dt * 0.4);
      }
    } else {
      a.submerged = 0;
      a.breath = Math.min(1, a.breath + dt * 0.5);
      a.wet = Math.max(0, a.wet - dt * 0.05);
    }
    a.vy -= GRAVITY * dt * (water ? 0.35 : 1);
    integrateActor(w, a, dt);
    a.balance = clamp(a.balance + dt * 0.55, 0, 1);
    if (Math.hypot(a.vx, a.vz) > 4.5 && surf === "mud") {
      a.balance -= dt * 0.2;
      if (a.balance < 0.2 && a.loco !== "ragdoll") {
        a.loco = "stumble";
        a.locoT = 0.35;
      }
    }
  }
  separateBodies(w);
  for (const a of w.actors) {
    if (a.grabbedBy) continue;
    collideXZ(w, a);
  }
  for (const p of w.props) {
    if (p.heldBy || (!p.dynamic && p.anchored)) continue;
    p.vy -= GRAVITY * dt;
    p.vx *= Math.exp(-dt * 1.8);
    p.vz *= Math.exp(-dt * 1.8);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    resolveProp(w, p);
    if (p.y < 0.02 && Math.abs(p.vy) > 2.5) {
      w.emitSound(p.x, p.z, 0.4 + Math.min(1, Math.abs(p.vy) * 0.1), p.material === "wood" ? "wood" : "impact", 0);
      if (p.kind === "lamp" || p.oil) {
        spillOil(w, p);
        if (p.kind === "lamp") igniteAt(w, p.x, p.z, 0.8);
      }
      p.vy *= -0.15;
    }
    if (p.y < 0) {
      p.y = 0;
      p.vy = 0;
    }
  }
}

function integrateActor(w: World, a: Actor, dt: number) {
  const steps = 1 + ((Math.hypot(a.vx, a.vz, a.vy) * dt) / 0.25) | 0;
  const sdt = dt / steps;
  for (let i = 0; i < steps; i++) {
    a.x += a.vx * sdt;
    a.z += a.vz * sdt;
    collideXZ(w, a);
    a.y += a.vy * sdt;
    collideY(w, a);
  }
  a.x = clamp(a.x, -HALF + 1, HALF - 1);
  a.z = clamp(a.z, -HALF + 1, HALF - 1);
  if (solidOverlap(w, a.x, a.z, a.y, a.height, a.radius * 0.92)) unstickActor(w, a);
}

function canStepOn(a: Actor, c: Collider) {
  const rise = c.maxY - a.y;
  return a.grounded && rise > 0.04 && rise <= STEP_UP && c.maxY - c.minY < 1.25;
}

function torsoOverlapsY(a: Actor, c: Collider) {
  const y0 = a.y + 0.12;
  const y1 = a.y + a.height * 0.88;
  return !(y1 < c.minY + 0.02 || y0 > c.maxY - 0.02);
}

function resolveCircleAABB(a: Actor, c: Collider, r: number) {
  const closestX = clamp(a.x, c.minX, c.maxX);
  const closestZ = clamp(a.z, c.minZ, c.maxZ);
  const dx = a.x - closestX;
  const dz = a.z - closestZ;
  const d2 = dx * dx + dz * dz;
  const r2 = r * r;
  if (d2 > r2 && d2 > 1e-8) return false;
  if (d2 < 1e-8) {
    const left = a.x - c.minX;
    const right = c.maxX - a.x;
    const south = a.z - c.minZ;
    const north = c.maxZ - a.z;
    const m = Math.min(left, right, south, north);
    if (m === left) {
      a.x = c.minX - r;
      if (a.vx > 0) a.vx = 0;
    } else if (m === right) {
      a.x = c.maxX + r;
      if (a.vx < 0) a.vx = 0;
    } else if (m === south) {
      a.z = c.minZ - r;
      if (a.vz > 0) a.vz = 0;
    } else {
      a.z = c.maxZ + r;
      if (a.vz < 0) a.vz = 0;
    }
    return true;
  }
  const d = Math.sqrt(d2);
  const pen = r - d;
  const nx = dx / d;
  const nz = dz / d;
  a.x += nx * pen;
  a.z += nz * pen;
  const vn = a.vx * nx + a.vz * nz;
  if (vn < 0) {
    a.vx -= vn * nx;
    a.vz -= vn * nz;
  }
  return true;
}

function collideXZ(w: World, a: Actor) {
  const r = a.radius;
  for (let pass = 0; pass < 3; pass++) {
    let hit = false;
    for (const c of w.colliders) {
      if (!c.solid || c.water) continue;
      if (!torsoOverlapsY(a, c)) continue;
      if (canStepOn(a, c)) continue;
      if (resolveCircleAABB(a, c, r)) hit = true;
    }
    if (!hit) break;
  }
}

function collideY(w: World, a: Actor) {
  a.grounded = false;
  for (const c of w.colliders) {
    if (!c.solid || c.water) continue;
    const r = a.radius * 0.85;
    if (a.x + r < c.minX || a.x - r > c.maxX || a.z + r < c.minZ || a.z - r > c.maxZ) continue;
    if (a.vy <= 0 && a.y >= c.maxY - STEP_UP && a.y <= c.maxY + 0.12) {
      a.y = c.maxY;
      a.vy = 0;
      a.grounded = true;
    } else if (a.vy > 0 && a.y + a.height > c.minY && a.y < c.minY) {
      a.y = c.minY - a.height;
      a.vy = 0;
    }
  }
  if (a.y <= 0) {
    a.y = 0;
    a.vy = 0;
    a.grounded = true;
  }
}

function solidOverlap(w: World, x: number, z: number, y: number, height: number, r: number) {
  const y0 = y + 0.12;
  const y1 = y + height * 0.88;
  for (const c of w.colliders) {
    if (!c.solid || c.water) continue;
    if (y1 < c.minY + 0.02 || y0 > c.maxY - 0.02) continue;
    const cx = clamp(x, c.minX, c.maxX);
    const cz = clamp(z, c.minZ, c.maxZ);
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

export function unstickActor(w: World, a: Actor) {
  if (!solidOverlap(w, a.x, a.z, a.y, a.height, a.radius * 0.9)) return false;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [0.7, 0.7],
    [-0.7, 0.7],
    [0.7, -0.7],
    [-0.7, -0.7],
  ];
  for (let dist = 0.4; dist <= 2.4; dist += 0.35) {
    for (const [dx, dz] of dirs) {
      const nx = a.x + dx * dist;
      const nz = a.z + dz * dist;
      if (!solidOverlap(w, nx, nz, a.y, a.height, a.radius)) {
        a.x = nx;
        a.z = nz;
        a.vx = 0;
        a.vz = 0;
        return true;
      }
    }
  }
  a.y = Math.max(a.y, 0.05);
  a.x += 0.6;
  a.z += 0.6;
  a.vx = a.vz = 0;
  return true;
}

function separateBodies(w: World) {
  const n = w.actors.length;
  for (let i = 0; i < n; i++) {
    const a = w.actors[i]!;
    if (!a.alive && a.loco === "down") continue;
    for (let j = i + 1; j < n; j++) {
      const b = w.actors[j]!;
      if (a.grabbedId === b.id || b.grabbedId === a.id) continue;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const min = a.radius + b.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 > min * min || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const pen = min - d;
      const nx = dx / d;
      const nz = dz / d;
      const invA = a.grabbedBy ? 0 : 1 / a.mass;
      const invB = b.grabbedBy ? 0 : 1 / b.mass;
      const s = invA + invB || 1;
      a.x -= nx * pen * (invA / s);
      a.z -= nz * pen * (invA / s);
      b.x += nx * pen * (invB / s);
      b.z += nz * pen * (invB / s);
      const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
      if (rel < 0) {
        const jimp = rel * 0.4;
        a.vx += jimp * nx;
        a.vz += jimp * nz;
        b.vx -= jimp * nx;
        b.vz -= jimp * nz;
      }
    }
  }
}

function resolveProp(w: World, p: Prop) {
  for (const c of w.colliders) {
    if (!c.solid || c.water || c.propId === p.id) continue;
    if (p.x < c.minX - p.sx || p.x > c.maxX + p.sx || p.z < c.minZ - p.sz || p.z > c.maxZ + p.sz) continue;
    if (p.y > c.maxY + 0.1 || p.y + p.sy < c.minY) continue;
    const cx = clamp(p.x, c.minX, c.maxX);
    const cz = clamp(p.z, c.minZ, c.maxZ);
    const dx = p.x - cx;
    const dz = p.z - cz;
    if (dx * dx + dz * dz < 0.01) {
      if (p.vy <= 0) {
        p.y = c.maxY;
        p.vy = 0;
      }
    }
  }
}

function stepInjury(w: World, dt: number) {
  for (const a of w.actors) {
    if (a.heat > 0.5) {
      a.injuries.torso.burn += dt * 0.15;
      a.pain = Math.min(1, a.pain + dt * 0.2);
      a.wet = Math.max(0, a.wet - dt);
    }
    const smoke = w.smoke[w.cell(a.x, a.z)];
    if (smoke > 0.45 && w.indoorAt(a.x, a.z)) {
      a.breath = Math.max(0, a.breath - dt * 0.25 * smoke);
      a.consciousness -= dt * 0.08 * smoke;
    }
    if (a.bleed > 0) {
      a.blood = Math.max(0, a.blood - a.bleed * dt * 0.12);
      a.bleed = Math.max(0, a.bleed - dt * 0.02);
      if (a.grounded && a.bleed > 0.08) {
        w.tracks.push({ x: a.x, z: a.z, t: w.time, actorId: a.id, kind: "blood", heading: a.yaw });
      }
    }
    a.pain = clamp(a.pain * (1 - dt * 0.08) + injurySum(a.injuries.torso) * 0.05, 0, 1);
    if (a.blood < 0.25) a.consciousness = Math.min(a.consciousness, a.blood * 2);
    if (a.breath <= 0) a.consciousness -= dt * 0.4;
    if (injurySum(a.injuries.head) > 1.6) a.consciousness -= dt * 0.15;
    a.consciousness = clamp(a.consciousness, 0, 1);
    if (a.alive && (a.blood <= 0.02 || a.consciousness <= 0 || a.y < -2.5)) {
      kill(w, a, a.blood <= 0.02 ? "bled out" : a.y < -2.5 ? "drowned" : "the body gave out");
    }
    if (!a.alive) continue;
    if (a.consciousness < 0.15) {
      a.loco = "down";
      a.intendSpeed = 0;
      a.downT += dt;
      if (a.kind === "player") {
        w.phase = "down";
        const guards = w.nearby(a.x, a.z, 4).filter((g) => g.faction === "guard" && g.alive);
        if (guards.length && a.downT > 1.6) {
          w.phase = "captured";
          w.captureT = 0;
          w.whisper("They drag you.");
        }
      }
    }
  }
}

function kill(w: World, a: Actor, cause: string) {
  if (!a.alive) return;
  a.alive = false;
  a.loco = "down";
  a.consciousness = 0;
  a.intendSpeed = 0;
  w.emitSound(a.x, a.z, 0.6, "impact", a.id);
  if (a.kind === "player") {
    w.phase = "dead";
    w.deadCause = cause;
  } else {
    w.whisper(a.faction === "guard" ? "A guard goes still." : a.species === "human" ? "Someone falls and does not rise." : "The animal stills.");
    w.wanted = Math.min(1, w.wanted + (a.faction === "guard" ? 0.3 : 0.05));
    const carcass = w.addProp({
      kind: "carcass",
      material: "flesh",
      x: a.x,
      y: 0.05,
      z: a.z,
      sx: a.radius * 2.2,
      sy: 0.28,
      sz: a.height * 0.5,
      mass: a.mass,
      hp: 20,
      flammable: true,
      fuel: 6,
      color: 0x4a3028,
      anchored: false,
      dynamic: false,
    });
    carcass.yaw = a.yaw;
  }
}

function igniteAt(w: World, x: number, z: number, power: number) {
  const i = w.cell(x, z);
  w.heat[i] = Math.min(2.5, w.heat[i] + power);
  if (w.heat[i] > 0.55 + w.wet[i] * 0.8 && (w.fuel[i] > 0.15 || w.oil[i] > 0.1)) {
    if (!w.burning[i]) {
      w.burning[i] = 1;
      w.emitSound(x, z, 0.5, "fire", 0);
      if (w.fireCount < 3) w.whisper("Fire takes.");
    }
  }
}

function spillOil(w: World, p: Prop) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const i = w.cell(p.x + dx * FIRE_CELL, p.z + dz * FIRE_CELL);
      w.oil[i] = Math.min(1.5, w.oil[i] + 0.55);
      w.fuel[i] += 0.4;
    }
  }
  w.whisper("Oil spreads.");
  p.oil = false;
}

function stepFire(w: World, dt: number) {
  w.fireCount = 0;
  const nextHeat = w.heat.slice();
  const wx = w.windX;
  const wz = w.windZ;
  for (let iz = 1; iz < FIRE_RES - 1; iz++) {
    for (let ix = 1; ix < FIRE_RES - 1; ix++) {
      const i = ix + iz * FIRE_RES;
      const rain = w.indoor[i] ? 0 : w.rain;
      w.wet[i] = clamp(w.wet[i] + rain * dt * 0.35 - dt * 0.02, 0, 1.2);
      if (w.burning[i]) {
        w.fireCount++;
        const burn = (0.35 + w.oil[i] * 0.5) * dt * (1 - rain * 0.7);
        w.fuel[i] = Math.max(0, w.fuel[i] - burn);
        w.oil[i] = Math.max(0, w.oil[i] - burn * 0.6);
        w.heat[i] = Math.min(2.2, w.heat[i] + burn * 1.4);
        w.char[i] = Math.min(1, w.char[i] + dt * 0.12);
        w.smoke[i] = Math.min(2, w.smoke[i] + dt * (1.2 + w.fuel[i] * 0.2));
        if (w.fuel[i] <= 0.02 && w.oil[i] <= 0.02) {
          w.burning[i] = 0;
          w.heat[i] *= 0.4;
        }
        if (rain > 0.55 && w.rng() < dt * 1.2) {
          w.burning[i] = 0;
          w.heat[i] *= 0.3;
        }
        const pos = w.ixz(i);
        for (const a of w.nearby(pos.x, pos.z, 2.4)) {
          a.heat = Math.max(a.heat, 0.7);
          if (a.wet < 0.4) a.injuries.torso.burn += dt * 0.2;
        }
        for (const p of w.props) {
          if (!p.flammable || p.collapsed) continue;
          if (dist2(p.x, p.z, pos.x, pos.z) < 6) {
            p.hp -= dt * 6;
            if (p.hp < p.maxHp * 0.6) p.burning = true;
            if (p.hp <= 0) collapseProp(w, p, wx, wz);
          }
        }
      } else {
        w.heat[i] = Math.max(0, w.heat[i] - dt * (0.25 + rain));
        w.smoke[i] = Math.max(0, w.smoke[i] - dt * (w.indoor[i] ? 0.15 : 0.55));
      }
      const spread =
        w.heat[i - 1] * (wx < 0 ? 1.25 : 0.8) +
        w.heat[i + 1] * (wx > 0 ? 1.25 : 0.8) +
        w.heat[i - FIRE_RES] * (wz < 0 ? 1.25 : 0.8) +
        w.heat[i + FIRE_RES] * (wz > 0 ? 1.25 : 0.8);
      nextHeat[i] = Math.max(w.heat[i], w.heat[i] * 0.7 + spread * 0.08 * dt * 8);
    }
  }
  for (let i = 0; i < w.heat.length; i++) {
    w.heat[i] = nextHeat[i]!;
    if (!w.burning[i] && w.heat[i] > 0.7 + w.wet[i] * 0.7 && (w.fuel[i] > 0.2 || w.oil[i] > 0.12)) {
      w.burning[i] = 1;
    }
  }
  for (const a of w.actors) {
    a.heat = Math.max(0, a.heat - dt * 0.6);
    const i = w.cell(a.x, a.z);
    if (w.burning[i] && a.wet < 0.5) a.heat = Math.max(a.heat, 1);
  }
}

function stepProps(w: World, _dt: number) {
  for (const p of w.props) {
    if (p.burning && p.flammable) igniteAt(w, p.x, p.z, 0.4);
    if (p.kind === "chest" && !p.heldBy) {
      const player = w.player();
      if (player.grabbedId === p.id && w.wanted < 0.15) {
        w.wanted = Math.min(1, w.wanted + 0.5);
        w.whisper("The chest is missed.");
        for (const a of w.nearby(p.x, p.z, 16)) {
          if (a.faction === "civilian" || a.faction === "guard") {
            w.addMemory(a, "theft", p.x, p.z, player.id, 0.9);
            if (a.faction === "guard") {
              a.known.push(player.id);
              a.alert = 1;
            }
          }
        }
      }
    }
  }
}

function damageProp(w: World, p: Prop, dmg: number, vx: number, vz: number, by?: Actor) {
  p.hp -= dmg;
  p.vx += vx * 0.3;
  p.vz += vz * 0.3;
  if (p.kind === "lamp" && dmg > 6) {
    spillOil(w, p);
    igniteAt(w, p.x, p.z, 0.7);
    w.emitSound(p.x, p.z, 0.5, "break", by?.id ?? 0);
  }
  if (p.hp <= 0) collapseProp(w, p, vx, vz);
  else w.emitSound(p.x, p.z, 0.3, "wood", by?.id ?? 0);
}

function collapseProp(w: World, p: Prop, vx: number, vz: number) {
  if (p.collapsed) return;
  p.collapsed = true;
  p.dynamic = true;
  p.anchored = false;
  p.hp = 0;
  p.vy = 1.2;
  p.vx += vx * 0.4 + (w.rng() - 0.5);
  p.vz += vz * 0.4 + (w.rng() - 0.5);
  w.emitSound(p.x, p.z, p.sy > 1.5 ? 1.1 : 0.55, p.sy > 1.5 ? "collapse" : "break", 0);
  w.shake = Math.max(w.shake, p.sy > 1.5 ? 0.55 : 0.2);
  for (const c of w.colliders) {
    if (c.propId === p.id) c.solid = false;
  }
  igniteAt(w, p.x, p.z, p.burning ? 0.6 : 0.1);
  if (p.kind === "stall" || p.kind === "table") {
    w.whisper("A stall comes down.");
  }
}

function stepStructures(w: World, _dt: number) {
  for (const b of w.buildings) {
    if (b.collapsed) continue;
    let live = 0;
    for (const id of b.supports) {
      const p = w.prop(id);
      if (p && !p.collapsed && p.hp > 0) live++;
    }
    if (live <= Math.max(1, (b.supports.length / 2) | 0) && b.supports.length) {
      b.collapsed = true;
      w.whisper(b.name + " gives way.");
      w.emitSound((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, 1.4, "collapse", 0);
      w.shake = Math.max(w.shake, 0.7);
      for (const id of b.parts) {
        const p = w.prop(id);
        if (!p) continue;
        collapseProp(w, p, (w.rng() - 0.5) * 3, (w.rng() - 0.5) * 3);
        p.vy += 2 + w.rng();
      }
      for (const a of w.actors) {
        if (a.x > b.minX && a.x < b.maxX && a.z > b.minZ && a.z < b.maxZ) {
          a.injuries.torso.bruise += 0.5;
          a.injuries.head.bruise += 0.25;
          a.loco = "ragdoll";
          a.vy = -1;
          a.balance = 0;
          a.consciousness -= 0.25;
        }
        a.fear = Math.min(1, a.fear + 0.35);
      }
      w.wanted = Math.min(1, w.wanted + 0.15);
    }
  }
}

function stepTracks(w: World, _dt: number) {
  const p = w.player();
  if (p.grounded && Math.hypot(p.vx, p.vz) > 1.2) {
    const surf = surfaceAt(w, p.x, p.z);
    if (surf === "mud" || surf === "dirt" || w.wet[w.cell(p.x, p.z)] > 0.4) {
      if (((w.time * 8) | 0) !== (((w.time - 0.016) * 8) | 0)) {
        w.tracks.push({ x: p.x, z: p.z, t: w.time, actorId: p.id, kind: "foot", heading: p.yaw });
      }
    }
  }
  const rainKill = 8 + w.rain * 18;
  w.tracks = w.tracks.filter((t) => w.time - t.t < rainKill);
  if (w.tracks.length > 220) w.tracks.splice(0, w.tracks.length - 220);
}

function cullSounds(w: World) {
  w.sounds = w.sounds.filter((s) => w.time - s.t < 0.8);
}

export function hintFor(w: World): string {
  const p = w.player();
  const f = facing(p.yaw);
  for (const o of w.nearby(p.x, p.z, 1.6)) {
    if (o.id === p.id) continue;
    const dx = o.x - p.x;
    const dz = o.z - p.z;
    if (dx * f.x + dz * f.z < 0) continue;
    if (o.species === "human") return o.alive ? "Hold grab — throw on release" : "A body";
    return "Grab";
  }
  for (const pr of w.props) {
    if (Math.hypot(pr.x - p.x, pr.z - p.z) > 1.5) continue;
    if (pr.kind === "chest") return "The tax chest";
    if (pr.weapon) return pr.weapon;
    if (pr.kind === "lamp") return "Lamp";
    if (pr.kind === "flask") return "Oil flask";
    if (pr.kind === "hay") return "Dry hay";
  }
  if (p.bleed > 0.2) return "Hold T to bind the wound";
  return "";
}
