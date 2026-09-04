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
  applyImpulseToNearest,
  clearGrab,
  ensureBodies,
  isDynamicBody,
  KICK_DUR,
  meleeTip,
  nearestPart,
  regionOfPart,
  setGrab,
  SHOVE_DUR,
  stepBodies,
  strikeDuration,
  actionUnit,
  GRAB_DUR,
  FLINCH_DUR,
} from "./physique";

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
  ensureBodies(w);
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
  stepBodies(w, dt);
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
  let max = p.crouch ? 1.5 : 3.45;
  if (input.sprint && p.stamina > 0.08 && wishMag > 0.2 && !p.crouch) max = 6.6;
  max *= leg * load * mud * (0.55 + p.consciousness * 0.45) * (1 - p.fatigue * 0.35);
  if (p.grabbedId) max *= 0.55;
  p.intendSpeed = wishMag * max;
  if (p.strikeT > 0 || p.kickT > 0 || p.shoveT > 0 || p.grabT > 0) p.intendSpeed *= 0.32;

  if (wishMag > 0.08) {
    const ty = Math.atan2(-p.intendX, -p.intendZ);
    p.yaw = lerpAng(p.yaw, ty, 1 - Math.exp(-dt * 8));
  } else {
    p.yaw = lerpAng(p.yaw, cam.yaw, 1 - Math.exp(-dt * 4));
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
        if (a.body) a.body.mode = "ragdoll";
        applyImpulseToNearest(a, a.x, a.y + 0.9, a.z, f.x * spd * 12, 6 * throwMul, f.z * spd * 12);
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
    clearGrab(p);
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
    if (a.loco === "ragdoll" || a.loco === "down" || a.loco === "getup") {
      a.intendSpeed = 0;
      continue;
    }
    if (a.grabbedBy) {
      const g = w.actor(a.grabbedBy);
      if (!g || !g.alive) {
        a.grabbedBy = 0;
        a.intendSpeed = 0;
        continue;
      }
      a.ai = "combat";
      const dx = g.x - a.x;
      const dz = g.z - a.z;
      const d = Math.hypot(dx, dz) || 1;
      a.intendX = dx / d;
      a.intendZ = dz / d;
      a.intendSpeed = 0.85 + a.strength * 0.5;
      a.yaw = lerpAng(a.yaw, Math.atan2(-dx, -dz), Math.min(1, dt * 3.2));
      if (a.attackCd <= 0 && a.stamina > 0.18 && a.consciousness > 0.4 && a.pain < 0.85) {
        if (a.stamina > 0.35 && a.weapon !== "fist") {
          a.strikeT = strikeDuration(a);
          a.strikeCd = 0.62;
        } else if (w.rng() > 0.45) {
          a.strikeT = strikeDuration(a);
          a.strikeCd = 0.5;
        } else {
          a.shoveT = SHOVE_DUR;
        }
        a.strikeHit = 0;
        a.attackCd = 0.55 + w.rng() * 0.45;
        a.stamina = Math.max(0, a.stamina - 0.07);
      }
      continue;
    }
    a.aiT -= dt;
    a.fear = clamp(a.fear - dt * 0.05, 0, 1);
    const nearbyFire = closestFire(w, a.x, a.z);
    if (nearbyFire && nearbyFire.d < 3.2) {
      const dx = a.x - nearbyFire.x;
      const dz = a.z - nearbyFire.z;
      const m = Math.hypot(dx, dz) || 1;
      a.intendX = dx / m;
      a.intendZ = dz / m;
      a.intendSpeed = 5;
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
  a.intendSpeed = speed;
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
      if (d > 1.15) seek(a, player.x, player.z, 5.2);
      else a.intendSpeed = 0.35;
      a.targetId = player.id;
      if (a.shoutCd <= 0) {
        w.emitSound(a.x, a.z, 1.0, "shout", a.id);
        a.shoutCd = 3;
        callAllies(w, a, player);
      }
      const want = 0.62 + WEAPON_STATS[a.weapon].reach;
      if (d < want && a.attackCd <= 0) {
        a.strikeT = strikeDuration(a);
        a.strikeCd = 0.72 / (0.7 + a.competence);
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
      a.aiT = 1 + w.rng() * 2;
    }
    return;
  }

  a.ai = "wander";
  if (a.aiT <= 0) {
    a.wayX = a.homeX + (w.rng() - 0.5) * 10;
    a.wayZ = a.homeZ + (w.rng() - 0.5) * 10;
    a.aiT = 3 + w.rng() * 4;
  }
  seek(a, a.wayX, a.wayZ, 1.5);
}

function pickSearch(w: World, a: Actor) {
  const ang = w.rng() * Math.PI * 2;
  const r = 3 + w.rng() * 7;
  a.searchX = a.lastSeenX + Math.cos(ang) * r;
  a.searchZ = a.lastSeenZ + Math.sin(ang) * r;
  a.aiT = 2 + w.rng() * 2;
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
      a.wayX = a.homeX + (w.rng() - 0.5) * (a.species === "deer" ? 16 : 5);
      a.wayZ = a.homeZ + (w.rng() - 0.5) * (a.species === "deer" ? 16 : 5);
      a.aiT = 2 + w.rng() * 4;
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
      if (d < 0.85 && a.attackCd <= 0) {
        a.strikeT = strikeDuration(a);
        a.strikeHit = 0;
        a.attackCd = 0.8;
      }
      return;
    }
    a.ai = "wander";
    if (a.aiT <= 0) {
      a.wayX = a.homeX + (w.rng() - 0.5) * 18;
      a.wayZ = a.homeZ + (w.rng() - 0.5) * 18;
      a.aiT = 4;
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
      if (d < 1.05 && a.attackCd <= 0) {
        a.strikeT = 0.42;
        a.strikeHit = 0;
        a.attackCd = 1.1;
        w.emitSound(a.x, a.z, 1.1, "animal", a.id);
      }
      return;
    }
    if (a.aiT <= 0) {
      a.wayX = a.homeX + (w.rng() - 0.5) * 20;
      a.wayZ = a.homeZ + (w.rng() - 0.5) * 14;
      a.aiT = 5;
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
    if (input.attackPressed && p.strikeCd <= 0 && p.loco !== "ragdoll" && p.loco !== "down" && p.loco !== "getup") {
      p.strikeT = strikeDuration(p);
      p.strikeCd = p.strikeT + 0.16;
      p.strikeHit = 0;
      if (!p.grabbedId) p.grabT = 0;
      p.stamina = Math.max(0, p.stamina - 0.06);
      w.emitSound(p.x, p.z, 0.35, "weapon", p.id);
    }
    if (input.kickPressed && p.kickT <= 0 && p.grounded && p.loco !== "ragdoll") {
      p.kickT = KICK_DUR;
      p.strikeHit = 0;
      w.emitSound(p.x, p.z, 0.3, "whoosh", p.id);
    }
    if (input.shovePressed && p.shoveT <= 0 && p.loco !== "ragdoll") {
      p.shoveT = SHOVE_DUR;
      p.strikeHit = 0;
    }
  }
  for (const a of w.actors) {
    a.strikeCd = Math.max(0, a.strikeCd - dt);
    a.attackCd = Math.max(0, a.attackCd - dt);
    a.flinchT = Math.max(0, a.flinchT - dt);
    if (a.strikeT > 0) {
      const dur =
        a.species === "human" || a.kind === "player" ? strikeDuration(a) : a.species === "bear" ? 0.42 : 0.34;
      a.strikeT = Math.max(0, a.strikeT - dt);
      const u = actionUnit(Math.max(0, a.strikeT), dur);
      const st = WEAPON_STATS[a.weapon] ?? WEAPON_STATS.fist;
      if (u >= 0.3 && u <= 0.54) {
        resolveMelee(w, a, "strike", st);
      }
    }
    if (a.kickT > 0) {
      const prev = a.kickT;
      a.kickT = Math.max(0, a.kickT - dt);
      if (prev > KICK_DUR * 0.52 && a.kickT <= KICK_DUR * 0.52) {
        resolveMelee(w, a, "kick", { ...WEAPON_STATS.fist, blunt: 1.15, reach: 0.08 });
      }
    }
    if (a.shoveT > 0) {
      const prev = a.shoveT;
      a.shoveT = Math.max(0, a.shoveT - dt);
      if (prev > SHOVE_DUR * 0.48 && a.shoveT <= SHOVE_DUR * 0.48) {
        resolveShove(w, a);
      }
    }
  }
}

function marked(a: Actor, id: number) {
  return (a.strikeHit & (1 << (id % 30))) !== 0;
}

function mark(a: Actor, id: number) {
  a.strikeHit |= 1 << (id % 30);
}

function resolveMelee(
  w: World,
  a: Actor,
  how: "strike" | "kick",
  st: (typeof WEAPON_STATS)[WeaponKind],
) {
  const tip = meleeTip(a, how);
  const pad = how === "kick" ? 0.55 : 0.5;
  for (const o of w.nearby(tip.x, tip.z, pad + 0.35)) {
    if (o.id === a.id || !o.alive) continue;
    if (marked(a, o.id)) continue;
    let hx = o.x;
    let hy = o.y + (how === "kick" ? 0.32 : o.height * 0.62);
    let hz = o.z;
    let hit = false;
    if (o.body) {
      let best = 1e9;
      let bi = 0;
      for (let i = 0; i < o.body.parts.length; i++) {
        const p = o.body.parts[i]!;
        const d = (p.x - tip.x) ** 2 + (p.y - tip.y) ** 2 + (p.z - tip.z) ** 2;
        if (d < best) {
          best = d;
          bi = i;
        }
      }
      const p = o.body.parts[bi]!;
      const allow = tip.r + p.r + 0.05;
      if (best <= allow * allow) {
        hit = true;
        hx = p.x;
        hy = p.y;
        hz = p.z;
      }
    } else {
      const cy = o.y + o.height * (how === "kick" ? 0.28 : 0.55);
      const d = Math.hypot(o.x - tip.x, cy - tip.y, o.z - tip.z);
      if (d < tip.r + o.radius + 0.06) hit = true;
    }
    if (!hit) continue;
    mark(a, o.id);
    const speed = Math.hypot(a.vx, a.vz) + (how === "kick" ? 3.1 : 2.0);
    hitActor(w, a, o, st, speed, how, hx, hy, hz);
    if (how === "kick") {
      o.injuries.lleg.sprain += 0.12;
      o.vy += 0.45;
      a.injuries.rleg.sprain += 0.04;
      if (a.injuries.rleg.fracture > 0.22) {
        a.loco = "stumble";
        a.locoT = 0.4;
        a.pain = clamp(a.pain + 0.15, 0, 1);
      }
    }
  }
  if (how !== "strike") return;
  const f = facing(a.yaw);
  for (const pr of w.props) {
    if (pr.collapsed || pr.heldBy) continue;
    if (dist2(tip.x, tip.z, pr.x, pr.z) > (0.35 + tip.r) * (0.35 + tip.r)) continue;
    if (Math.abs(pr.y + pr.sy * 0.5 - tip.y) > 0.7) continue;
    damageProp(w, pr, 8 + st.blunt * 14, a.vx + f.x * 3, a.vz + f.z * 3, a);
  }
}

function resolveShove(w: World, a: Actor) {
  const tip = meleeTip(a, "shove");
  const f = facing(a.yaw);
  for (const o of w.nearby(tip.x, tip.z, 0.7)) {
    if (o.id === a.id || !o.alive) continue;
    if (marked(a, o.id)) continue;
    let close = false;
    if (o.body) {
      const p = o.body.parts[1] ?? o.body.parts[0]!;
      close = Math.hypot(p.x - tip.x, p.y - tip.y, p.z - tip.z) < 0.38;
    } else {
      close = Math.hypot(o.x - tip.x, o.z - tip.z) < 0.45 + o.radius;
    }
    if (!close) continue;
    mark(a, o.id);
    const rel = a.mass / (a.mass + o.mass);
    o.vx += f.x * 4.2 * rel;
    o.vz += f.z * 4.2 * rel;
    o.balance = Math.max(0, o.balance - 0.12 * rel);
    applyImpulseToNearest(o, o.x, o.y + 1.05, o.z, f.x * 5 * rel, 0.8 * rel, f.z * 5 * rel);
    if (o.balance < 0.18) {
      o.loco = "stumble";
      o.locoT = 0.32;
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
  hx?: number,
  hy?: number,
  hz?: number,
) {
  const f = facing(atk.yaw);
  const rel = atk.mass / (atk.mass + vic.mass);
  const force = (0.6 + speed * 0.25) * (0.7 + st.mass * 0.25) * (0.8 + atk.strength * 0.4);
  vic.vx += f.x * force * 1.6 * rel;
  vic.vz += f.z * force * 1.6 * rel;
  vic.balance = Math.max(0, vic.balance - (0.05 + st.blunt * 0.08 * rel));
  const side = rightOf(atk.yaw).x * (vic.x - atk.x) + rightOf(atk.yaw).z * (vic.z - atk.z);
  const hitX = hx ?? vic.x + f.x * 0.12;
  const hitY = hy ?? (how === "kick" ? vic.y + 0.32 : vic.y + 1.05);
  const hitZ = hz ?? vic.z + f.z * 0.12;
  const jScale = vic.body?.mode === "stance" ? 2.8 : 12;
  const part = applyImpulseToNearest(
    vic,
    hitX,
    hitY,
    hitZ,
    f.x * force * jScale * rel,
    (how === "kick" ? 2.2 : 4.5) * rel,
    f.z * force * jScale * rel,
  );
  const region =
    part >= 0
      ? regionOfPart(part)
      : how === "kick"
        ? Math.random() < 0.5
          ? "lleg"
          : "rleg"
        : regionFromHit(1.1 + Math.random() * 0.5, side);
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
  vic.hitNx = f.x;
  vic.hitNz = f.z;
  if (atk.grabbedBy === vic.id) {
    vic.stamina = Math.max(0, vic.stamina - 0.2 - force * 0.12);
    vic.balance = Math.max(0, vic.balance - 0.08 * force);
    if (vic.stamina < 0.14 || force > 1.35) {
      atk.grabbedBy = 0;
      vic.grabbedId = 0;
      vic.carry = 0;
      clearGrab(vic);
      atk.vx += f.x * 1.4;
      atk.vz += f.z * 1.4;
      w.emitSound(vic.x, vic.z, 0.45, "grab", atk.id);
    }
  }
  if (!vic.known.includes(atk.id) && vic.kind !== "player") vic.known.push(atk.id);
  if (atk.kind === "player" && vic.faction === "guard") w.wanted = Math.min(1, w.wanted + 0.35);
  if (atk.kind === "player" && vic.faction === "civilian") w.wanted = Math.min(1, w.wanted + 0.2);
  vic.alert = 1;
  const legsBroken = vic.injuries.lleg.fracture + vic.injuries.rleg.fracture > 0.4;
  const dropped = vic.consciousness < 0.22 || (vic.balance < 0.08 && force > 1.9) || (legsBroken && how === "kick" && force > 1.15);
  if (dropped) {
    vic.loco = "ragdoll";
    vic.locoT = 0.7 + (1 - vic.balance);
    vic.vy += 0.5 * rel;
    if (vic.body) vic.body.mode = "ragdoll";
  } else if (vic.balance < 0.3 || (force > 1.7 && st.blunt > 1)) {
    vic.loco = "stumble";
    vic.locoT = 0.32;
    vic.flinchT = Math.max(vic.flinchT, FLINCH_DUR);
  } else {
    vic.flinchT = Math.max(vic.flinchT, 0.22 + force * 0.08);
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
    if (input.grabPressed && !p.grabbedId && p.loco !== "ragdoll" && p.grabT <= 0) {
      p.grabT = GRAB_DUR;
      p.strikeHit = 0;
    }
    if (input.grabReleased && p.grabbedId) {
      const spd = 7 + Math.hypot(p.vx, p.vz);
      dropHeld(w, p, clamp(spd / 6, 0.8, 1.8));
    }
  }
  for (const a of w.actors) {
    if (a.grabT > 0 && !a.grabbedId) {
      a.grabT = Math.max(0, a.grabT - dt);
      const u = actionUnit(a.grabT, GRAB_DUR);
      if (u >= 0.32 && u <= 0.68) tryLockGrab(w, a);
    } else if (a.grabT > 0) {
      a.grabT = Math.max(0, a.grabT - dt);
    }
    if (!a.grabbedId) continue;
    const t = w.actor(a.grabbedId);
    const pr = t ? null : w.prop(a.grabbedId);
    if (t) {
      if (!t.alive) a.carry = t.mass * 0.7;
      if (t.body) {
        const two = t.mass > a.mass * 0.62 || !t.alive || t.body.mode !== "stance";
        if (!a.body?.grab || (two && a.body.grab.myPart2 < 0)) setGrab(a, t);
      }
      if (t.alive && t.body?.mode === "stance" && t.consciousness > 0.35) {
        const dx = t.x - a.x;
        const dz = t.z - a.z;
        const d = Math.hypot(dx, dz) || 1;
        if (t.flinchT <= 0) {
          t.hitNx = dx / d;
          t.hitNz = dz / d;
        }
        if (t.kind !== "player") {
          const fight = t.stamina > 0.22 && t.consciousness > 0.45 && t.pain < 0.72;
          if (fight) {
            t.intendX = -dx / d;
            t.intendZ = -dz / d;
            t.intendSpeed = Math.max(t.intendSpeed, 1.05 * t.strength);
          } else {
            t.intendX = dx / d;
            t.intendZ = dz / d;
            t.intendSpeed = Math.max(t.intendSpeed, 1.5 * t.strength);
          }
        }
        const peel = t.strength * t.balance * (0.6 + t.stamina);
        const hold = a.strength * (0.45 + a.stamina);
        const fighting = t.strikeT > 0 || t.shoveT > 0 || t.kickT > 0;
        a.stamina = Math.max(
          0,
          a.stamina - dt * (0.1 + 0.22 * clamp(peel / Math.max(0.25, hold), 0.3, 2.4) + (fighting ? 0.45 : 0)),
        );
        t.stamina = Math.max(0, t.stamina - dt * 0.05);
        if (a.stamina < 0.05) {
          t.vx += (dx / d) * 1.8;
          t.vz += (dz / d) * 1.8;
          t.grabbedBy = 0;
          a.grabbedId = 0;
          a.carry = 0;
          clearGrab(a);
          t.flinchT = Math.max(t.flinchT, 0.16);
          w.emitSound(a.x, a.z, 0.35, "grab", a.id);
        }
      }
    } else if (pr) {
      const hand = a.body?.parts[6];
      if (hand) {
        pr.x = hand.x;
        pr.y = hand.y - pr.sy * 0.25;
        pr.z = hand.z;
        pr.vx = hand.vx;
        pr.vz = hand.vz;
        pr.yaw = a.yaw;
      } else {
        const f = facing(a.yaw);
        pr.x = a.x + f.x * 0.5;
        pr.z = a.z + f.z * 0.5;
        pr.y = a.y + a.height * 0.55;
        pr.vx = a.vx;
        pr.vz = a.vz;
        pr.yaw = a.yaw;
      }
    } else {
      a.grabbedId = 0;
      a.carry = 0;
      clearGrab(a);
    }
  }
}

function tryLockGrab(w: World, a: Actor) {
  const hand = a.body?.parts[6];
  const f = facing(a.yaw);
  const hx = hand?.x ?? a.x + f.x * 0.5;
  const hy = hand?.y ?? a.y + 1.05;
  const hz = hand?.z ?? a.z + f.z * 0.5;
  let best: Actor | Prop | null = null;
  let bd = 0.34;
  for (const o of w.nearby(hx, hz, 0.85)) {
    if (o.id === a.id || !o.alive) continue;
    if (marked(a, o.id)) continue;
    let d: number;
    if (o.body) {
      const i = nearestPart(o.body, hx, hy, hz);
      const p = o.body.parts[i]!;
      d = Math.hypot(p.x - hx, p.y - hy, p.z - hz);
    } else {
      d = Math.hypot(o.x - hx, o.y + o.height * 0.5 - hy, o.z - hz);
    }
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  for (const pr of w.props) {
    if (pr.anchored && pr.mass > 40 && !pr.dynamic) continue;
    if (pr.kind === "wall" || pr.kind === "roof" || pr.heldBy) continue;
    const d = Math.hypot(pr.x - hx, pr.y + pr.sy * 0.4 - hy, pr.z - hz);
    if (d < bd) {
      bd = d;
      best = pr;
    }
  }
  if (!best) return;
  if ("species" in best) {
    const o = best as Actor;
    const rel = a.mass / (a.mass + o.mass);
    if (rel < 0.38 && o.balance > 0.6 && o.grounded && o.alive && o.body?.mode === "stance") {
      mark(a, o.id);
      o.balance -= 0.22;
      o.flinchT = Math.max(o.flinchT, 0.18);
      o.vx += f.x * 0.8;
      o.vz += f.z * 0.8;
      a.stamina = Math.max(0, a.stamina - 0.08);
      a.grabT = Math.min(a.grabT, 0.08);
      w.emitSound(a.x, a.z, 0.3, "grab", a.id);
      return;
    }
    a.grabbedId = o.id;
    o.grabbedBy = a.id;
    mark(a, o.id);
    {
      const dx = o.x - a.x;
      const dz = o.z - a.z;
      const d = Math.hypot(dx, dz) || 1;
      o.hitNx = dx / d;
      o.hitNz = dz / d;
    }
    a.carry = o.mass * (o.mass > a.mass * 0.62 || !o.alive ? 0.7 : 0.42);
    setGrab(a, o);
    if (!o.alive || o.consciousness < 0.22) {
      o.loco = "ragdoll";
      o.locoT = 0.6;
      if (o.body) o.body.mode = "ragdoll";
    }
    w.emitSound(a.x, a.z, 0.4, "grab", a.id);
  } else {
    const pr = best as Prop;
    a.grabbedId = pr.id;
    pr.heldBy = a.id;
    pr.dynamic = true;
    pr.anchored = false;
    a.carry = pr.mass;
    if (pr.weapon) a.weapon = pr.weapon;
    if (pr.kind === "lamp") a.weapon = "torch";
    if (pr.kind === "board") a.weapon = "board";
    w.emitSound(a.x, a.z, 0.3, "grab", a.id);
  }
}

function stepLocomotion(w: World, dt: number) {
  for (const a of w.actors) {
    if (a.grabbedBy && !a.body) continue;
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
      if (!a.body && a.getupT <= 0) {
        a.loco = "idle";
        a.balance = 0.6;
      }
      continue;
    }
    if (a.loco === "ragdoll") {
      a.locoT -= dt;
      if (!a.body && a.grounded && Math.hypot(a.vx, a.vz) < 1.8 && a.locoT <= 0 && a.consciousness > 0.25 && a.alive) {
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
    if (a.grabbedBy) a.intendSpeed *= 0.62;
    if (a.kind !== "player") {
      const limp = 1 - clamp(injurySum(a.injuries.lleg) + injurySum(a.injuries.rleg), 0, 1.8) * 0.28;
      a.intendSpeed *= limp;
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
    if (a.grabbedBy && !a.body) continue;
    const surf = surfaceAt(w, a.x, a.z);
    const water = w.inWater(a.x, a.z, a.y + 0.5);
    const fr = frictionFor(surf, w.wet[w.cell(a.x, a.z)]);
    const acc = accelFor(surf);
    if (isDynamicBody(a)) {
      if (water) {
        a.wet = Math.min(1, a.wet + dt * 1.5);
        if (a.y < water.maxY - 0.35) {
          a.submerged += dt;
          a.breath = Math.max(0, a.breath - dt * 0.35);
        }
      } else {
        a.submerged = 0;
        a.breath = Math.min(1, a.breath + dt * 0.5);
        a.wet = Math.max(0, a.wet - dt * 0.05);
      }
      continue;
    }
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
    if (a.grabbedBy && !a.body) continue;
    if (isDynamicBody(a)) continue;
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
      if (a.body && b.body && (a.body.mode !== "stance" || b.body.mode !== "stance")) continue;
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
      if (a.body) a.body.mode = "ragdoll";
      if (a.kind === "player" && w.phase !== "title") {
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
  if (a.body) a.body.mode = "ragdoll";
  w.emitSound(a.x, a.z, 0.6, "impact", a.id);
  if (a.kind === "player") {
    if (w.phase === "title") return;
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
