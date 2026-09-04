export const STEP = 1 / 60;
export const WORLD = 88;
export const HALF = WORLD * 0.5;
export const FIRE_CELL = 2;
export const FIRE_RES = WORLD / FIRE_CELL;
export const GRAVITY = 24;
export const MAX_ACTORS = 64;

export type Kind = "player" | "human" | "beast" | "prop";
export type Faction = "player" | "civilian" | "guard" | "hunter" | "wild" | "none";
export type Material =
  | "wood"
  | "stone"
  | "metal"
  | "cloth"
  | "glass"
  | "soil"
  | "vegetation"
  | "flesh"
  | "bone"
  | "water"
  | "hay"
  | "oil";
export type Region = "head" | "torso" | "larm" | "rarm" | "lleg" | "rleg";
export type Loco =
  | "idle"
  | "walk"
  | "run"
  | "sprint"
  | "crouch"
  | "crawl"
  | "stumble"
  | "fall"
  | "getup"
  | "vault"
  | "climb"
  | "swim"
  | "ragdoll"
  | "pin"
  | "down";
export type AiState =
  | "idle"
  | "wander"
  | "work"
  | "investigate"
  | "pursue"
  | "search"
  | "combat"
  | "flee"
  | "rescue"
  | "extinguish"
  | "recover"
  | "hide"
  | "hunt"
  | "graze"
  | "herd";
export type WeaponKind = "fist" | "knife" | "club" | "spear" | "torch" | "board" | "pitchfork";
export type PropKind =
  | "crate"
  | "barrel"
  | "board"
  | "lamp"
  | "hay"
  | "flask"
  | "chest"
  | "bucket"
  | "carcass"
  | "weapon"
  | "fence"
  | "door"
  | "post"
  | "beam"
  | "wall"
  | "roof"
  | "table"
  | "stall"
  | "gate";
export type Species = "human" | "goat" | "pig" | "cow" | "deer" | "wolf" | "bear";
export type Surface = "dirt" | "mud" | "cobble" | "wood" | "water" | "hay" | "stone";
export type SoundKind =
  | "step"
  | "sprint"
  | "impact"
  | "wood"
  | "metal"
  | "scream"
  | "shout"
  | "animal"
  | "fire"
  | "collapse"
  | "splash"
  | "break"
  | "weapon"
  | "whoosh"
  | "hurt"
  | "grab";

export const REGIONS: Region[] = ["head", "torso", "larm", "rarm", "lleg", "rleg"];

export interface Injury {
  bruise: number;
  cut: number;
  puncture: number;
  burn: number;
  fracture: number;
  sprain: number;
}

export function emptyInjury(): Injury {
  return { bruise: 0, cut: 0, puncture: 0, burn: 0, fracture: 0, sprain: 0 };
}

export function injuryTotal(i: Injury): number {
  return (
    i.bruise + i.cut * 1.4 + i.puncture * 1.6 + i.burn * 1.3 + i.fracture * 2.2 + i.sprain * 1.1
  );
}

/**
 * Functional impairment weighting: how much this injury costs the limb, as
 * distinct from how life-threatening it is. This is the quantity motor
 * authority is derived from.
 */
export function injurySum(i: Injury): number {
  return (
    i.bruise * 0.4 +
    i.cut * 0.8 +
    i.puncture * 0.9 +
    i.burn * 0.7 +
    i.fracture * 1.4 +
    i.sprain * 0.7
  );
}

export interface Memory {
  t: number;
  kind: "threat" | "body" | "fire" | "sound" | "track" | "theft" | "ally";
  x: number;
  z: number;
  who: number;
  certainty: number;
}

export interface Actor {
  id: number;
  kind: Kind;
  faction: Faction;
  species: Species;
  name: string;
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  yaw: number;
  pyaw: number;
  vx: number;
  vy: number;
  vz: number;
  radius: number;
  height: number;
  mass: number;
  grounded: boolean;
  balance: number;
  stamina: number;
  fatigue: number;
  pain: number;
  consciousness: number;
  breath: number;
  wet: number;
  heat: number;
  loco: Loco;
  locoT: number;
  crouch: boolean;
  injuries: Record<Region, Injury>;
  bleed: number;
  blood: number;
  grabbedId: number;
  grabbedBy: number;
  carry: number;
  weapon: WeaponKind;
  torchLit: boolean;
  strikeT: number;
  strikeCd: number;
  strikeHit: number;
  kickT: number;
  shoveT: number;
  vaultT: number;
  getupT: number;
  climbId: number;
  alive: boolean;
  downT: number;
  ai: AiState;
  aiT: number;
  homeX: number;
  homeZ: number;
  wayX: number;
  wayZ: number;
  targetId: number;
  lastSeenX: number;
  lastSeenZ: number;
  lastSeenT: number;
  fear: number;
  courage: number;
  aggression: number;
  loyalty: number;
  competence: number;
  strength: number;
  memories: Memory[];
  known: number[];
  alert: number;
  routine: { x: number; z: number }[];
  routineI: number;
  walkPhase: number;
  leanX: number;
  leanZ: number;
  recovT: number;
  shoutCd: number;
  attackCd: number;
  submerged: number;
  skin: number;
  cloth: number;
  accent: number;
  helmet: boolean;
  sex: number;
  weaponProp: number;
  intendX: number;
  intendZ: number;
  intendSpeed: number;
  searchX: number;
  searchZ: number;
  searchT: number;
  lastHitBy: number;
  lastHitT: number;
  pinnedId: number;

  /* --- articulated body substrate (see body.ts) --- */
  /** Slot in World.bodies, or -1 when this actor has no physical body. */
  body: number;
  /**
   * Deliberate stance authority in [0,1]: how much the character is *trying* to
   * hold its pose. 1 standing, 0 limp, ramping while getting up. Multiplied by
   * physiological state to give `authority`.
   */
  stanceAuth: number;
  /** Global motor authority in [0,1], derived each tick. */
  authority: number;
  /** Per-limb motor authority in [0,1], gated by that limb's own damage. */
  motor: Record<Region, number>;
  /** Support-polygon margin at the capture point, m. Negative means falling. */
  support: number;
  /** Mass of other bodies resting on this one, kg. */
  pileLoad: number;
  /** Impulse currently transmitted through a grab, N*s. */
  dragLoad: number;
  /** Smoothed crouch amount in [0,1]; the raw input is a boolean. */
  crouchAmt: number;
  /** Catch-step timer, s. */
  catchT: number;
  /** Which leg is swinging for the catch step: 0 left, 1 right. */
  catchLeg: number;
  /** Trip recovery timer, s. */
  tripT: number;
  /** Strongest node closing speed this tick, m/s. Read-only expression input. */
  lastImpact: number;
  /** Region that took `lastImpact`. */
  impactRegion: Region;
  /** Grabber-side attachment node index. */
  grabNodeA: number;
  /** Target-side attachment node index (ignored for props). */
  grabNodeB: number;
  /** Attachment rest length, m. */
  grabRest: number;
}

export interface Prop {
  id: number;
  kind: PropKind;
  material: Material;
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  sx: number;
  sy: number;
  sz: number;
  mass: number;
  hp: number;
  maxHp: number;
  flammable: boolean;
  fuel: number;
  burning: boolean;
  oil: boolean;
  sharp: number;
  heldBy: number;
  support: boolean;
  buildingId: number;
  load: number;
  capacity: number;
  collapsed: boolean;
  dynamic: boolean;
  anchored: boolean;
  weapon: WeaponKind | null;
  color: number;
}

export interface Building {
  id: number;
  name: string;
  parts: number[];
  supports: number[];
  collapsed: boolean;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  indoor: boolean;
}

export interface Collider {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  material: Material;
  climb: boolean;
  vault: boolean;
  propId: number;
  solid: boolean;
  water: boolean;
}

export interface Track {
  x: number;
  z: number;
  t: number;
  actorId: number;
  kind: "foot" | "blood" | "drag";
  heading: number;
}

export interface Snd {
  x: number;
  z: number;
  mag: number;
  kind: SoundKind;
  t: number;
  who: number;
}

export interface Whisper {
  id: number;
  text: string;
  t: number;
}

export interface HudState {
  phase: "title" | "playing" | "paused" | "down" | "captured" | "dead";
  stamina: number;
  fatigue: number;
  wet: number;
  heat: number;
  blood: number;
  breath: number;
  consciousness: number;
  balance: number;
  injuries: Record<Region, number>;
  held: string;
  weapon: WeaponKind;
  stance: Loco;
  crouch: boolean;
  whispers: Whisper[];
  hunted: boolean;
  motor: Record<Region, number>;
  support: number;
  pileLoad: number;
  timeOfDay: number;
  rain: number;
  wind: number;
  hint: string;
  cause: string;
  burning: boolean;
  wanted: number;
  captureT: number;
}

export function defaultHud(): HudState {
  return {
    phase: "title",
    stamina: 1,
    fatigue: 0,
    wet: 0,
    heat: 0,
    blood: 1,
    breath: 1,
    consciousness: 1,
    balance: 1,
    injuries: { head: 0, torso: 0, larm: 0, rarm: 0, lleg: 0, rleg: 0 },
    held: "",
    weapon: "fist",
    stance: "idle",
    crouch: false,
    whispers: [],
    hunted: false,
    motor: { head: 1, torso: 1, larm: 1, rarm: 1, lleg: 1, rleg: 1 },
    support: 1,
    pileLoad: 0,
    timeOfDay: 0.7,
    rain: 0,
    wind: 0,
    hint: "",
    cause: "",
    burning: false,
    wanted: 0,
    captureT: 0,
  };
}

export const WEAPON_STATS: Record<
  WeaponKind,
  {
    mass: number;
    reach: number;
    speed: number;
    blunt: number;
    cut: number;
    pierce: number;
    fire: number;
  }
> = {
  fist: { mass: 0.4, reach: 0.85, speed: 1.35, blunt: 0.55, cut: 0, pierce: 0, fire: 0 },
  knife: { mass: 0.5, reach: 0.95, speed: 1.4, blunt: 0.1, cut: 1.1, pierce: 0.7, fire: 0 },
  club: { mass: 2.4, reach: 1.15, speed: 0.75, blunt: 1.4, cut: 0, pierce: 0, fire: 0 },
  spear: { mass: 1.8, reach: 1.85, speed: 0.95, blunt: 0.25, cut: 0.2, pierce: 1.3, fire: 0 },
  torch: { mass: 1.1, reach: 1.05, speed: 1.0, blunt: 0.5, cut: 0, pierce: 0, fire: 1 },
  board: { mass: 2.0, reach: 1.2, speed: 0.8, blunt: 1.05, cut: 0.15, pierce: 0, fire: 0 },
  pitchfork: { mass: 2.2, reach: 1.7, speed: 0.85, blunt: 0.3, cut: 0.1, pierce: 1.15, fire: 0 },
};
