import {
  type Actor,
  type AiState,
  type Building,
  type Collider,
  type Faction,
  type Kind,
  type Loco,
  type Memory,
  type Prop,
  type PropKind,
  type Region,
  type Snd,
  type SoundKind,
  type Species,
  type Track,
  type WeaponKind,
  type Whisper,
  emptyInjury,
  injurySum,
  FIRE_CELL,
  FIRE_RES,
  HALF,
  REGIONS,
  WORLD,
} from "./types";
import { Bodies, type PlanId } from "./body";

/** Re-exported so existing call sites keep importing it from the world module. */
export { injurySum };

export class World {
  time = 0;
  day = 0.7;
  rain = 0;
  rainTarget = 0;
  windX = 1.4;
  windZ = 0.4;
  thunderT = 999;
  nextId = 1;
  actors: Actor[] = [];
  props: Prop[] = [];
  buildings: Building[] = [];
  colliders: Collider[] = [];
  tracks: Track[] = [];
  sounds: Snd[] = [];
  whispers: Whisper[] = [];
  whisperId = 1;
  playerId = 0;
  fuel = new Float32Array(FIRE_RES * FIRE_RES);
  heat = new Float32Array(FIRE_RES * FIRE_RES);
  wet = new Float32Array(FIRE_RES * FIRE_RES);
  oil = new Float32Array(FIRE_RES * FIRE_RES);
  smoke = new Float32Array(FIRE_RES * FIRE_RES);
  char = new Float32Array(FIRE_RES * FIRE_RES);
  burning = new Uint8Array(FIRE_RES * FIRE_RES);
  indoor = new Uint8Array(FIRE_RES * FIRE_RES);
  hash = new Map<number, number[]>();
  /** Articulated node bodies, indexed by Actor.body. The physical root state. */
  bodies = new Bodies();
  events: { kind: string; x: number; z: number; a: number; mag: number; text?: string }[] = [];
  wanted = 0;
  fireCount = 0;
  shake = 0;
  hitstop = 0;
  seed = 1;
  captureT = 0;
  deadCause = "";
  phase: "title" | "playing" | "paused" | "down" | "captured" | "dead" = "title";

  rng() {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }

  cell(x: number, z: number) {
    const ix = Math.max(0, Math.min(FIRE_RES - 1, ((x + HALF) / FIRE_CELL) | 0));
    const iz = Math.max(0, Math.min(FIRE_RES - 1, ((z + HALF) / FIRE_CELL) | 0));
    return ix + iz * FIRE_RES;
  }

  ixz(i: number) {
    const ix = i % FIRE_RES;
    const iz = (i / FIRE_RES) | 0;
    return {
      x: ix * FIRE_CELL - HALF + FIRE_CELL * 0.5,
      z: iz * FIRE_CELL - HALF + FIRE_CELL * 0.5,
    };
  }

  hashKey(x: number, z: number) {
    const c = 4;
    return ((Math.floor((x + HALF) / c) & 255) << 8) | (Math.floor((z + HALF) / c) & 255);
  }

  rebuildHash() {
    this.hash.clear();
    for (const a of this.actors) {
      if (!a.alive && a.loco === "down") {
        /* still occupy */
      }
      const k = this.hashKey(a.x, a.z);
      let b = this.hash.get(k);
      if (!b) {
        b = [];
        this.hash.set(k, b);
      }
      b.push(a.id);
    }
  }

  nearby(x: number, z: number, r: number): Actor[] {
    const out: Actor[] = [];
    const c = 4;
    const r2 = r * r;
    const x0 = Math.floor((x - r + HALF) / c);
    const x1 = Math.floor((x + r + HALF) / c);
    const z0 = Math.floor((z - r + HALF) / c);
    const z1 = Math.floor((z + r + HALF) / c);
    const seen = new Set<number>();
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.hash.get(((ix & 255) << 8) | (iz & 255));
        if (!list) continue;
        for (const id of list) {
          if (seen.has(id)) continue;
          seen.add(id);
          const a = this.actor(id);
          if (!a) continue;
          const d = (a.x - x) * (a.x - x) + (a.z - z) * (a.z - z);
          if (d <= r2) out.push(a);
        }
      }
    }
    return out;
  }

  actor(id: number) {
    return this.actors.find((a) => a.id === id);
  }

  prop(id: number) {
    return this.props.find((p) => p.id === id);
  }

  player() {
    return this.actor(this.playerId)!;
  }

  emitSound(x: number, z: number, mag: number, kind: SoundKind, who = 0) {
    this.sounds.push({ x, z, mag, kind, t: this.time, who });
    this.events.push({ kind: "snd:" + kind, x, z, a: who, mag });
  }

  whisper(text: string) {
    if (this.whispers.length && this.whispers[this.whispers.length - 1]!.text === text) return;
    this.whispers.push({ id: this.whisperId++, text, t: this.time });
    if (this.whispers.length > 8) this.whispers.shift();
  }

  remember(a: Actor, mem: Omit<Memory, "t">) {
    a.memories.push({ ...mem, t: this.time });
    if (a.memories.length > 12) a.memories.shift();
  }

  addActor(partial: Partial<Actor> & { kind: Kind; species: Species; faction: Faction }): Actor {
    const id = this.nextId++;
    const inj = {
      head: emptyInjury(),
      torso: emptyInjury(),
      larm: emptyInjury(),
      rarm: emptyInjury(),
      lleg: emptyInjury(),
      rleg: emptyInjury(),
    };
    const a: Actor = {
      id,
      name: "",
      x: 0,
      y: 0,
      z: 0,
      px: 0,
      py: 0,
      pz: 0,
      yaw: 0,
      pyaw: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      radius: 0.32,
      height: 1.7,
      mass: 75,
      grounded: true,
      balance: 1,
      stamina: 1,
      fatigue: 0,
      pain: 0,
      consciousness: 1,
      breath: 1,
      wet: 0,
      heat: 0,
      loco: "idle",
      locoT: 0,
      crouch: false,
      injuries: inj,
      bleed: 0,
      blood: 1,
      grabbedId: 0,
      grabbedBy: 0,
      carry: 0,
      weapon: "fist",
      torchLit: false,
      strikeT: 0,
      strikeCd: 0,
      strikeHit: 0,
      kickT: 0,
      shoveT: 0,
      vaultT: 0,
      getupT: 0,
      climbId: 0,
      alive: true,
      downT: 0,
      ai: "idle",
      aiT: 0,
      homeX: 0,
      homeZ: 0,
      wayX: 0,
      wayZ: 0,
      targetId: 0,
      lastSeenX: 0,
      lastSeenZ: 0,
      lastSeenT: -99,
      fear: 0,
      courage: 0.5,
      aggression: 0.4,
      loyalty: 0.5,
      competence: 0.5,
      strength: 1,
      memories: [],
      known: [],
      alert: 0,
      routine: [],
      routineI: 0,
      walkPhase: 0,
      moveScale: 1,
      leanX: 0,
      leanZ: 0,
      recovT: 0,
      shoutCd: 0,
      attackCd: 0,
      submerged: 0,
      skin: 0xbfa08c,
      cloth: 0x4a4036,
      accent: 0x2c241c,
      helmet: false,
      sex: 0,
      weaponProp: 0,
      intendX: 0,
      intendZ: 0,
      intendSpeed: 0,
      searchX: 0,
      searchZ: 0,
      searchT: 0,
      lastHitBy: 0,
      lastHitT: -99,
      pinnedId: 0,
      body: -1,
      stanceAuth: 1,
      authority: 1,
      motor: { head: 1, torso: 1, larm: 1, rarm: 1, lleg: 1, rleg: 1 },
      support: 1,
      pileLoad: 0,
      dragLoad: 0,
      crouchAmt: 0,
      offBalT: 0,
      catchT: 0,
      catchLeg: 0,
      tripT: 0,
      lastImpact: 0,
      impactRegion: "torso",
      grabNodeA: -1,
      grabNodeB: -1,
      grabRest: 0.4,
      ...partial,
    };
    a.px = a.x;
    a.py = a.y;
    a.pz = a.z;
    a.homeX = a.homeX || a.x;
    a.homeZ = a.homeZ || a.z;
    // A phase offset so a group spawned together never starts in lockstep,
    // and a speed scale so they do not walk back into sync later: both are
    // the one place gait/travel individuality lives, read by `seek` and the
    // gait clock rather than authored per call site.
    a.walkPhase = this.rng() * Math.PI * 2;
    a.moveScale = 0.92 + this.rng() * 0.16;
    const plan: PlanId = a.species === "human" ? "humanoid" : "quadruped";
    a.body = this.bodies.spawn(a.id, plan, a.height, a.mass, a.x, a.y, a.z, a.yaw);
    this.actors.push(a);
    return a;
  }

  addProp(partial: Partial<Prop> & { kind: PropKind }): Prop {
    const id = this.nextId++;
    const p: Prop = {
      id,
      material: "wood",
      x: 0,
      y: 0,
      z: 0,
      px: 0,
      py: 0,
      pz: 0,
      yaw: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      sx: 0.6,
      sy: 0.6,
      sz: 0.6,
      mass: 8,
      hp: 40,
      maxHp: 40,
      flammable: true,
      fuel: 8,
      burning: false,
      oil: false,
      sharp: 0,
      heldBy: 0,
      support: false,
      buildingId: 0,
      load: 0,
      capacity: 80,
      collapsed: false,
      dynamic: false,
      anchored: true,
      weapon: null,
      color: 0x5a4634,
      frame: -1,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      ...partial,
    };
    p.px = p.x;
    p.py = p.y;
    p.pz = p.z;
    p.maxHp = p.hp;
    this.props.push(p);
    return p;
  }

  addCollider(c: Collider) {
    this.colliders.push(c);
    return c;
  }

  addBox(
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    extra: Partial<Collider> = {},
  ): Collider {
    return this.addCollider({
      minX: x - sx * 0.5,
      maxX: x + sx * 0.5,
      minY: y,
      maxY: y + sy,
      minZ: z - sz * 0.5,
      maxZ: z + sz * 0.5,
      material: "wood",
      climb: sy > 1.2,
      vault: sy > 0.35 && sy < 1.15,
      propId: 0,
      solid: true,
      water: false,
      ...extra,
    });
  }

  /**
   * Records what this actor now knows. Returns true when this is the FIRST
   * time they have known it, which is what separates a discovery from a thing
   * they have been looking at for a while -- the difference between the shock
   * of finding a body and the sight of one lying where it has lain a minute.
   */
  addMemory(
    a: Actor,
    kind: Memory["kind"],
    x: number,
    z: number,
    who: number,
    certainty: number,
  ): boolean {
    const existing = a.memories.find((m) => m.kind === kind && m.who === who);
    if (existing) {
      existing.x = x;
      existing.z = z;
      existing.t = this.time;
      existing.certainty = Math.max(existing.certainty, certainty);
      return false;
    }
    this.remember(a, { kind, x, z, who, certainty });
    return true;
  }

  inWater(x: number, z: number, y: number) {
    for (const c of this.colliders) {
      if (!c.water) continue;
      if (x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y < c.maxY) return c;
    }
    return null;
  }

  indoorAt(x: number, z: number) {
    for (const b of this.buildings) {
      if (b.collapsed) continue;
      if (x > b.minX + 0.2 && x < b.maxX - 0.2 && z > b.minZ + 0.2 && z < b.maxZ - 0.2) return b;
    }
    return null;
  }
}

export function makeHumanStats(w: World, faction: Faction) {
  const courage =
    faction === "guard"
      ? 0.72 + w.rng() * 0.2
      : faction === "hunter"
        ? 0.6 + w.rng() * 0.2
        : 0.28 + w.rng() * 0.35;
  const aggression =
    faction === "guard"
      ? 0.55 + w.rng() * 0.3
      : faction === "hunter"
        ? 0.45 + w.rng() * 0.3
        : 0.12 + w.rng() * 0.25;
  return {
    courage,
    aggression,
    loyalty: faction === "civilian" ? 0.4 + w.rng() * 0.4 : 0.55 + w.rng() * 0.35,
    competence: 0.35 + w.rng() * 0.5,
    strength: 0.85 + w.rng() * 0.4,
    mass: 62 + w.rng() * 30,
  };
}

export function locoSpeed(a: Actor): number {
  const v = Math.hypot(a.vx, a.vz);
  return v;
}

export function facing(yaw: number) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

export function rightOf(yaw: number) {
  return { x: Math.cos(yaw), z: -Math.sin(yaw) };
}

export function angDiff(a: number, b: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function lerpAng(a: number, b: number, t: number) {
  return a + angDiff(a, b) * t;
}

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function dist2(ax: number, az: number, bx: number, bz: number) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

export function regionFromHit(localY: number, side: number): Region {
  if (localY > 1.45) return "head";
  if (localY < 0.7) return side < 0 ? "lleg" : "rleg";
  if (localY > 1.05 && Math.abs(side) > 0.18) return side < 0 ? "larm" : "rarm";
  return "torso";
}

export function limbPenalty(a: Actor, region: Region) {
  return injurySum(a.injuries[region]);
}

export function worstRegion(a: Actor): { r: Region; v: number } {
  let r: Region = "torso";
  let v = 0;
  for (const k of REGIONS) {
    const t = injurySum(a.injuries[k]);
    if (t > v) {
      v = t;
      r = k;
    }
  }
  return { r, v };
}

export function canSeeThrough(w: World, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const steps = 6;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = ax + dx * t;
    const z = az + dz * t;
    for (const c of w.colliders) {
      if (!c.solid || c.water) continue;
      if (c.maxY < 1.2) continue;
      if (x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ) return false;
    }
  }
  return true;
}

export type { Loco, AiState, WeaponKind };
