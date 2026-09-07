/**
 * Articulated body substrate.
 *
 * One always-on multi-node body per actor, solved with XPBD (small substeps,
 * one iteration each). This is the authoritative root state of the physical
 * ensemble: limb contacts, joint limits, impact-local injury, balance,
 * stumbling, get-up, piles and grabbing are all consumers of it rather than
 * independent effects.
 *
 * The single idea that unifies them is MOTOR AUTHORITY: a per-limb scalar in
 * [0,1] that sets how stiffly the solver is allowed to pull a node toward its
 * animated target pose. Authority 1 is a controlled character; authority 0 is a
 * ragdoll; everything between is stumbling, limping or getting up. There is no
 * ragdoll "mode" to switch into.
 *
 * Units are SI throughout: m, m/s, kg, s, N, N*s. Every rate constant is s^-1.
 */

import {
  type Actor,
  type Collider,
  type Injury,
  type Material,
  type Region,
  GRAVITY,
  MAX_ACTORS,
  REGIONS,
} from "./types";

/** Largest node count over all body plans; sizes the flat node arrays. */
export const MAX_NODES = 11;
/**
 * Slots reserved for prop frames (see frames.ts).
 *
 * Props share the actors' node store rather than getting one of their own,
 * which is what makes a falling beam collide with a shoulder through the same
 * `solvePair` that makes two bodies stack -- and injure it through the same
 * damage law. A separate store would have meant a second contact path and two
 * sets of physics to keep honest.
 */
export const MAX_FRAMES = 128;
const MAX_BONES = 32;
const MAX_LIMITS = 8;
/**
 * How far above the lowest contact a node still counts as standing on the
 * ground, m. A foot bearing no load this instant is still a foot on the floor,
 * and the base of support is where the body's parts ARE, not where the solver
 * happened to bill an impulse.
 */
const SUPPORT_REST_TOL = 0.06;
/**
 * Horizontal speed under which such a node counts as RESTING there, m^2/s^2.
 *
 * Height alone is not enough: a swing foot passes low through the bottom of
 * every stride, and counting it as support widens the base with a foot that is
 * still in flight -- which flatters the balance test and shortens the stride
 * the walker thinks it needs. A foot that is bearing is also a foot that is
 * not going anywhere.
 */
const SUPPORT_REST_V2 = 0.12;
/** Colliders cached per body between broadphase gathers. */
const MAX_NEAR = 32;

/** Solver substeps per simulation tick. Substeps beat iterations in XPBD. */
export const SUBSTEPS = 4;

const REGION_IX: Record<Region, number> = { head: 0, torso: 1, larm: 2, rarm: 3, lleg: 4, rleg: 5 };

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Coupling edges of the substrate, switchable for severance testing.
 *
 * Each flag is one producer -> consumer edge. Turning one off and replaying the
 * same seed and input timeline must measurably change the consumer; if it does
 * not, the edge was decorative and the coupling claim is false. `probe.ts`
 * runs exactly that test against this object.
 *
 * These are always true in play. Nothing in the game toggles them.
 */
export const EDGES = {
  /** node contact impulse -> impact-local tissue damage */
  impulseInjury: true,
  /** tissue damage -> per-limb motor authority */
  injuryMotor: true,
  /** motor authority -> pose constraint stiffness */
  motorPose: true,
  /** support polygon -> balance, catch step, fall */
  supportBalance: true,
  /** node-vs-node contact between bodies (piles, draping, trips) */
  bodyPairs: true,
  /** grab reaction -> the grabber's own load and balance */
  grabLoad: true,
  /** solved body state -> what agents perceive and decide (see tactics.ts) */
  bodyTactics: true,
  /** structural load share -> support failure -> further load (see stepStructures) */
  loadCascade: true,
  /**
   * Support geometry -> which support carries how much (see statics.ts).
   *
   * Cut this and load reverts to an equal share per standing support: the old
   * law, in which cutting a corner post raised the diagonally opposite post as
   * much as its neighbours and a beam dropped on one side of a roof loaded the
   * far side identically.
   */
  loadMoment: true,
  /**
   * Perceived threat -> hostility and belief, rather than the global tension
   * meter alone (see humanAI, callAllies, panicSource in sim.ts).
   *
   * Cut this and a guard goes hostile the instant `wanted` rises anywhere on
   * the map, with no line of sight and nothing heard; an ally shout hands
   * every faction member within a flat radius the player's exact position and
   * full certainty regardless of distance or walls; and a frightened villager
   * always flees the player, even when a wolf or a fire is what scared them.
   */
  localEvidence: true,
};

/* ------------------------------------------------------------------ *
 * Body plans
 * ------------------------------------------------------------------ */

interface NodeSpec {
  /** Rest offset in body-local metres, y up, -z forward, origin at the feet. */
  x: number;
  y: number;
  z: number;
  /** Fraction of body mass (normalised at spawn so the plan always sums to 1). */
  mf: number;
  /** Contact sphere radius, m. */
  r: number;
  region: Region;
}

/** min/max are multiples of the plan's own rest distance, so they scale with the actor. */
interface LimitSpec {
  a: number;
  b: number;
  min: number;
  max: number;
}

export interface BodyPlan {
  nodes: NodeSpec[];
  bones: [number, number][];
  limits: LimitSpec[];
  /** Height the plan coordinates are authored at, m. */
  refHeight: number;
  head: number;
  chest: number;
  pelvis: number;
  feet: [number, number];
  hands: [number, number];
  /** Node the solver treats as the grab effector. */
  grabHand: number;
}

const HUMANOID: BodyPlan = {
  refHeight: 1.72,
  nodes: [
    { x: 0.0, y: 1.575, z: 0.0, mf: 0.081, r: 0.105, region: "head" },
    { x: 0.0, y: 1.215, z: 0.0, mf: 0.29, r: 0.15, region: "torso" },
    { x: 0.0, y: 0.93, z: 0.0, mf: 0.23, r: 0.14, region: "torso" },
    { x: -0.295, y: 1.075, z: 0.0, mf: 0.027, r: 0.062, region: "larm" },
    { x: -0.335, y: 0.74, z: 0.0, mf: 0.021, r: 0.052, region: "larm" },
    { x: 0.295, y: 1.075, z: 0.0, mf: 0.027, r: 0.062, region: "rarm" },
    { x: 0.335, y: 0.74, z: 0.0, mf: 0.021, r: 0.052, region: "rarm" },
    { x: -0.115, y: 0.5, z: 0.0, mf: 0.1, r: 0.08, region: "lleg" },
    { x: -0.115, y: 0.071, z: 0.0, mf: 0.057, r: 0.075, region: "lleg" },
    { x: 0.115, y: 0.5, z: 0.0, mf: 0.1, r: 0.08, region: "rleg" },
    { x: 0.115, y: 0.071, z: 0.0, mf: 0.057, r: 0.075, region: "rleg" },
  ],
  bones: [
    [0, 1],
    [1, 2],
    [1, 3],
    [3, 4],
    [1, 5],
    [5, 6],
    [2, 7],
    [7, 8],
    [2, 9],
    [9, 10],
  ],
  limits: [
    { a: 0, b: 2, min: 0.82, max: 1.02 }, // spine cannot fold or hyperextend
    { a: 1, b: 4, min: 0.42, max: 1.02 }, // left elbow range
    { a: 1, b: 6, min: 0.42, max: 1.02 }, // right elbow range
    { a: 2, b: 8, min: 0.46, max: 1.01 }, // left knee range
    { a: 2, b: 10, min: 0.46, max: 1.01 }, // right knee range
    { a: 3, b: 5, min: 0.8, max: 1.15 }, // shoulder girdle width
    { a: 7, b: 9, min: 0.55, max: 3.4 }, // hip abduction / stride limit
    { a: 4, b: 6, min: 0.1, max: 1.5 }, // arm span
  ],
  head: 0,
  chest: 1,
  pelvis: 2,
  feet: [8, 10],
  hands: [4, 6],
  grabHand: 6,
};

const QUADRUPED: BodyPlan = {
  refHeight: 0.9,
  nodes: [
    { x: 0.0, y: 0.86, z: -0.66, mf: 0.09, r: 0.13, region: "head" },
    { x: 0.0, y: 0.72, z: -0.3, mf: 0.3, r: 0.19, region: "torso" },
    { x: 0.0, y: 0.72, z: 0.3, mf: 0.26, r: 0.18, region: "torso" },
    { x: -0.2, y: 0.071, z: -0.3, mf: 0.075, r: 0.075, region: "larm" },
    { x: 0.2, y: 0.071, z: -0.3, mf: 0.075, r: 0.075, region: "rarm" },
    { x: -0.2, y: 0.071, z: 0.3, mf: 0.075, r: 0.075, region: "lleg" },
    { x: 0.2, y: 0.071, z: 0.3, mf: 0.075, r: 0.075, region: "rleg" },
    { x: 0.0, y: 0.7, z: 0.62, mf: 0.05, r: 0.09, region: "torso" },
  ],
  bones: [
    [0, 1],
    [1, 2],
    [1, 3],
    [1, 4],
    [2, 5],
    [2, 6],
    [2, 7],
  ],
  limits: [
    { a: 0, b: 2, min: 0.85, max: 1.02 },
    { a: 3, b: 4, min: 0.55, max: 1.6 },
    { a: 5, b: 6, min: 0.55, max: 1.6 },
    { a: 1, b: 5, min: 0.7, max: 1.05 },
    { a: 1, b: 6, min: 0.7, max: 1.05 },
    { a: 2, b: 3, min: 0.7, max: 1.05 },
    { a: 2, b: 4, min: 0.7, max: 1.05 },
  ],
  head: 0,
  chest: 1,
  pelvis: 2,
  feet: [5, 6],
  hands: [3, 4],
  grabHand: 0,
};

export const PLANS = { humanoid: HUMANOID, quadruped: QUADRUPED } as const;
export type PlanId = keyof typeof PLANS;

/* ------------------------------------------------------------------ *
 * Material response
 * ------------------------------------------------------------------ */

/**
 * Hardness scales the damage a contact does at a given closing speed. It is a
 * dimensionless ratio against stone, not a physical modulus: the fall that
 * breaks a leg on cobble should bruise in hay.
 */
const HARDNESS: Record<Material, number> = {
  stone: 1.0,
  metal: 1.05,
  wood: 0.7,
  glass: 0.85,
  bone: 0.95,
  soil: 0.5,
  vegetation: 0.3,
  cloth: 0.25,
  hay: 0.15,
  flesh: 0.35,
  water: 0.08,
  oil: 0.45,
};

/** Sliding friction coefficient by surface, dimensionless. */
const FRICTION: Record<Material, number> = {
  stone: 0.72,
  metal: 0.5,
  wood: 0.66,
  glass: 0.28,
  bone: 0.5,
  soil: 0.78,
  vegetation: 0.7,
  cloth: 0.6,
  hay: 0.55,
  flesh: 0.62,
  water: 0.12,
  oil: 0.14,
};

/**
 * Per-region bone tolerance, dimensionless. Higher survives more specific
 * impulse before fracturing; the skull is thin relative to what it protects.
 */
const BONE_TOL: Record<Region, number> = {
  head: 0.75,
  torso: 1.5,
  larm: 1.0,
  rarm: 1.0,
  lleg: 1.25,
  rleg: 1.25,
};

/* Damage thresholds, in m/s of concentrated closing speed.
 * Calibrated against this world's GRAVITY (24 m/s^2), not Earth's: an
 * uncontrolled 1.5 m drop arrives at sqrt(2*24*1.5) = 8.5 m/s, and a controlled
 * landing from the same height does not reach the bruise floor at all, because
 * active muscle absorbs part of the closing speed. */
const VB = 4.0; // bruise floor
const VF = 9.0; // bone yield
const VP = 3.0; // puncture floor
const K_BRUISE = 0.55;
const K_FRACTURE = 0.075;
const K_CUT = 0.15;
const K_PUNCTURE = 0.1;
/** Reference speed the quadratic bruise term is normalised by, m/s. */
const V_REF = 10;
/**
 * Bone yields super-linearly above threshold: below it nothing happens, above
 * it damage runs away. That exponent is why a stumble is free and a fall from a
 * roof is not.
 */
const FRACTURE_EXP = 1.5;

/**
 * Contact concentration, dimensionless.
 *
 * A body landing flat spreads its energy over the whole torso; a club head puts
 * the same energy through a few square centimetres. Without this the same law
 * cannot serve both, and it is the reason a club at 4 m/s injures while a body
 * at 4 m/s does not. Derived from the weapon stats already authored in
 * WEAPON_STATS rather than a new table.
 *
 * Cut concentration is deliberately excluded here and applied on the tangential
 * path instead: a blade concentrates along its edge as it slides, not normal to
 * it, and counting it twice makes knives absurd.
 */
export function contactFocus(blunt: number, pierce: number) {
  return 1 + blunt * 4 + pierce * 22;
}

/* ------------------------------------------------------------------ *
 * Node store
 * ------------------------------------------------------------------ */

export interface ContactHit {
  /** Node index within the body, or -1 for none. */
  node: number;
  region: Region;
  /** Normal impulse magnitude, N*s. */
  jn: number;
}

/**
 * Structure-of-arrays node storage. Fixed capacity, zero steady-state
 * allocation: every buffer below is allocated once at construction.
 */
export class Bodies {
  /** Slots [0, actorCap) belong to actors; [actorCap, cap) to prop frames. */
  readonly actorCap = MAX_ACTORS;
  readonly cap = MAX_ACTORS + MAX_FRAMES;
  private readonly nCap = (MAX_ACTORS + MAX_FRAMES) * MAX_NODES;

  /** Number of live nodes per slot; 0 means the slot is unused. */
  count = new Uint8Array(this.cap);
  planOf: PlanId[] = new Array(this.cap).fill("humanoid");
  /** Actor id, or prop id for frame slots; 0 when free. */
  owner = new Int32Array(this.cap);
  /** Free prop-frame slots, as a stack. */
  private freeFrames: number[] = [];
  private frameTop = MAX_ACTORS;
  scale = new Float32Array(this.cap);
  /** Total mass of the slot, kg. */
  bodyMass = new Float32Array(this.cap);
  /**
   * Fraction of `bodyMass` that stands behind any one node in a contact, [0,1].
   *
   * A body with both feet planted cannot get out of the way: a blow to the
   * shoulder is met by the whole body and, through it, the earth. A body in
   * the air meets the same blow with the limb alone. The controller writes this
   * from the support count each tick.
   */
  backing = new Float32Array(this.cap);
  private used = 0;

  // Node state
  px = new Float32Array(this.nCap);
  py = new Float32Array(this.nCap);
  pz = new Float32Array(this.nCap);
  /** Previous substep position; velocity is (p - o)/h. */
  ox = new Float32Array(this.nCap);
  oy = new Float32Array(this.nCap);
  oz = new Float32Array(this.nCap);
  /** Position at the start of the tick, for render interpolation. */
  rx = new Float32Array(this.nCap);
  ry = new Float32Array(this.nCap);
  rz = new Float32Array(this.nCap);
  /** Target pose position in world space, written by the controller each tick. */
  tx = new Float32Array(this.nCap);
  ty = new Float32Array(this.nCap);
  tz = new Float32Array(this.nCap);

  mass = new Float32Array(this.nCap);
  invMass = new Float32Array(this.nCap);
  rad = new Float32Array(this.nCap);
  /**
   * Radius of this node's SUPPORT patch, m. Equal to the collision radius for
   * most nodes, but larger for feet: a real sole is about 0.25 x 0.10 m, and
   * modelling the base of support as two points makes every body absurdly easy
   * to tip forward.
   */
  patch = new Float32Array(this.nCap);
  region = new Uint8Array(this.nCap);
  /** 1 when the node touched something this tick. */
  touched = new Uint8Array(this.nCap);
  /** Accumulated normal contact impulse this tick, N*s. */
  jimp = new Float32Array(this.nCap);
  /** Hardness of the last surface contacted, dimensionless. */
  jhard = new Float32Array(this.nCap);
  /** Accumulated tangential (sliding) contact impulse this tick, N*s. */
  jtan = new Float32Array(this.nCap);
  /**
   * Peak normal closing speed at this node over the tick, m/s.
   *
   * This, not the summed impulse, is what damage is driven from. The impulse
   * sums across substeps because a landing body keeps re-loading the contact
   * through its own skeleton, so summing it triple-counts the same collision;
   * the peak closing speed is the physical quantity the tissue actually met the
   * surface at, and it calibrates directly against sqrt(2*g*h).
   */
  vmax = new Float32Array(this.nCap);
  /** Peak tangential sliding speed at this node over the tick, m/s. */
  vtan = new Float32Array(this.nCap);
  /**
   * Effective mass behind the contact that set `vmax`, kg.
   *
   * Damage is an energy question, and the energy arriving depends on what is
   * behind the impact as much as on how fast it closes. A hand slapping a
   * shoulder and a 90 kg beam landing on it can share a closing speed and mean
   * completely different things. Zero means "nothing recorded": read `mass`.
   */
  vmass = new Float32Array(this.nCap);
  /**
   * Mass this node presents to a contact from another body, kg.
   *
   * A limb on its own is light, but a limb is not on its own -- it is joined to
   * a body, which may be braced against the ground. `backing` per slot says how
   * much of that is behind a node; a rigid prop frame sets this per node
   * directly, from its own geometry. Zero means "no override": read `mass`.
   */
  cmass = new Float32Array(this.nCap);
  /**
   * Node velocity at the start of the substep, after gravity and before any
   * constraint, m/s.
   *
   * Node-vs-node contact must read the speed the two nodes were TRAVELLING at
   * when they met. Reading (p - o)/h instead bills the same substep's pose,
   * bone and world projection as impact speed, and two men standing still can
   * then register a 38 m/s collision because the solver moved a shoulder
   * 15 cm to fix a joint. Verlet already carries the previous substep's
   * constraint work into this velocity, so real swung momentum is not lost --
   * only the circular part is.
   */
  vnx = new Float32Array(this.nCap);
  vny = new Float32Array(this.nCap);
  vnz = new Float32Array(this.nCap);
  /**
   * Velocity of the node's POSE TARGET, m/s: the motion the muscle is asking
   * for, as opposed to the motion the node has. Written once per tick where the
   * target is written, and read by the pose damper in `solvePose`.
   *
   * A muscle resists a limb moving away from where it is being put, not a limb
   * moving at all -- a sprinter's foot is travelling at 8 m/s and is perfectly
   * under control. Damping against the target's own motion is what separates
   * those two, and it is why locomotion survives a damper stiff enough to stop
   * the body ringing.
   */
  tvx = new Float32Array(this.nCap);
  tvy = new Float32Array(this.nCap);
  tvz = new Float32Array(this.nCap);
  /** Submerged fraction of the node this tick, dimensionless [0,1]. */
  wet = new Float32Array(this.nCap);

  // Constraint rest lengths, m
  boneRest = new Float32Array(this.cap * MAX_BONES);
  limMin = new Float32Array(this.cap * MAX_LIMITS);
  limMax = new Float32Array(this.cap * MAX_LIMITS);

  // Per-slot broadphase cache of nearby collider indices
  near = new Int32Array(this.cap * MAX_NEAR);
  nearCount = new Uint8Array(this.cap);
  nearX = new Float32Array(this.cap);
  nearZ = new Float32Array(this.cap);
  nearAge = new Uint16Array(this.cap);

  // Per-slot derived state (all SI)
  comX = new Float32Array(this.cap);
  comY = new Float32Array(this.cap);
  comZ = new Float32Array(this.cap);
  comVX = new Float32Array(this.cap);
  comVY = new Float32Array(this.cap);
  comVZ = new Float32Array(this.cap);
  /** Support-polygon margin at the capture point, m. Negative means falling. */
  margin = new Float32Array(this.cap);
  /**
   * World XZ of the capture point `supportMargin` projects the residual
   * (unintended) motion to, m. Already computed every tick to produce
   * `margin`; kept here so a consumer can read the DIRECTION a body is
   * falling, not only how far -- the deviation this body needs a counterweight
   * or a caught foot to answer, not a second solve of the same projection.
   */
  captureX = new Float32Array(this.cap);
  captureZ = new Float32Array(this.cap);
  /** Total mass of other bodies resting on this one, kg. */
  pileLoad = new Float32Array(this.cap);
  /** Number of nodes bearing load this tick. Zero means airborne, not falling. */
  supportCount = new Int32Array(this.cap);
  /** Node index of the strongest contact this tick, -1 when none. */
  hitNode = new Int32Array(this.cap);
  hitImp = new Float32Array(this.cap);
  /**
   * Per-region damage-history reference speed, m/s.
   *
   * Damage is driven by how far a contact exceeds what that region has already
   * absorbed in the current event, so one landing is one wound rather than one
   * wound per tick of a body flopping to rest. It decays back to zero, which is
   * what separates "the same impact still settling" from "hit again".
   */
  vref = new Float32Array(this.cap * 6);
  /**
   * World XZ of the foothold this body is committed to, written by the
   * controller each tick. `stepReady` is 0 when there is no committed step.
   */
  stepX = new Float32Array(this.cap);
  stepZ = new Float32Array(this.cap);
  stepReady = new Uint8Array(this.cap);
  /** Ground-plane material response under this body, written each tick by the sim. */
  groundHard = new Float32Array(this.cap);
  groundMu = new Float32Array(this.cap);
  /** Per-region pose gain for the current substep, scratch shared across slots. */
  gain = new Float32Array(6);

  // Preallocated scratch for the support hull (no allocation in the hot path)
  private hullX = new Float32Array(MAX_NODES);
  private hullZ = new Float32Array(MAX_NODES);
  private hullOrder = new Int32Array(MAX_NODES * 2 + 1);
  private stack = new Int32Array(MAX_NODES * 2 + 1);

  base(slot: number) {
    return slot * MAX_NODES;
  }

  /** Allocates a slot and lays the body out in its rest pose. Returns -1 when full. */
  spawn(
    actorId: number,
    plan: PlanId,
    height: number,
    mass: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ) {
    if (this.used >= this.cap) return -1;
    const slot = this.used++;
    const p = PLANS[plan];
    const s = height / p.refHeight;
    this.owner[slot] = actorId;
    this.planOf[slot] = plan;
    this.count[slot] = p.nodes.length;
    this.scale[slot] = s;
    this.nearAge[slot] = 0xffff;
    this.hitNode[slot] = -1;

    let mfSum = 0;
    for (const n of p.nodes) mfSum += n.mf;
    if (mfSum <= 0) mfSum = 1;

    const b = this.base(slot);
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    for (let i = 0; i < p.nodes.length; i++) {
      const n = p.nodes[i]!;
      const lx = n.x * s;
      const ly = n.y * s;
      const lz = n.z * s;
      const wx = x + lx * c + lz * sn;
      const wz = z - lx * sn + lz * c;
      const wy = y + ly;
      const k = b + i;
      this.px[k] = this.ox[k] = this.rx[k] = this.tx[k] = wx;
      this.py[k] = this.oy[k] = this.ry[k] = this.ty[k] = wy;
      this.pz[k] = this.oz[k] = this.rz[k] = this.tz[k] = wz;
      const m = (mass * n.mf) / mfSum;
      this.mass[k] = m;
      this.invMass[k] = 1 / m;
      this.rad[k] = n.r * s;
      this.patch[k] = (i === p.feet[0] || i === p.feet[1] ? 0.13 : n.r) * s;
      this.region[k] = REGION_IX[n.region];
      this.touched[k] = 0;
      this.jimp[k] = 0;
      this.jtan[k] = 0;
      this.vmax[k] = 0;
      this.vtan[k] = 0;
      this.vmass[k] = 0;
      this.cmass[k] = 0;
      this.vnx[k] = 0;
      this.vny[k] = 0;
      this.vnz[k] = 0;
      this.tvx[k] = 0;
      this.tvy[k] = 0;
      this.tvz[k] = 0;
      this.jhard[k] = 0;
      this.wet[k] = 0;
    }
    this.bodyMass[slot] = mass;
    this.backing[slot] = 0;
    this.groundHard[slot] = 0.5;
    this.groundMu[slot] = 0.7;

    for (let i = 0; i < p.bones.length; i++) {
      const [ia, ib] = p.bones[i]!;
      this.boneRest[slot * MAX_BONES + i] = restDist(p, ia, ib) * s;
    }
    for (let i = 0; i < p.limits.length; i++) {
      const l = p.limits[i]!;
      const d = restDist(p, l.a, l.b) * s;
      this.limMin[slot * MAX_LIMITS + i] = d * l.min;
      this.limMax[slot * MAX_LIMITS + i] = d * l.max;
    }
    return slot;
  }

  plan(slot: number) {
    return PLANS[this.planOf[slot]!];
  }

  /** Claims a prop-frame slot, or -1 when none are free. */
  takeFrame(propId: number) {
    const slot = this.freeFrames.length ? this.freeFrames.pop()! : this.frameTop < this.cap ? this.frameTop++ : -1;
    if (slot < 0) return -1;
    this.owner[slot] = propId;
    this.count[slot] = 0;
    this.nearAge[slot] = 0xffff;
    return slot;
  }

  /** Returns a prop-frame slot to the pool. */
  giveBackFrame(slot: number) {
    if (slot < this.actorCap || slot >= this.cap) return;
    this.owner[slot] = 0;
    this.count[slot] = 0;
    this.freeFrames.push(slot);
  }

  /** Snapshots node positions for render interpolation. Call once per tick, before solving. */
  snapshot(slot: number) {
    const b = this.base(slot);
    const n = this.count[slot]!;
    for (let i = 0; i < n; i++) {
      const k = b + i;
      this.rx[k] = this.px[k]!;
      this.ry[k] = this.py[k]!;
      this.rz[k] = this.pz[k]!;
      this.touched[k] = 0;
      this.jimp[k] = 0;
      this.jtan[k] = 0;
      this.vmax[k] = 0;
      this.vtan[k] = 0;
      this.vmass[k] = 0;
      this.jhard[k] = 0;
      this.wet[k] = 0;
      // A slot that is not integrated this tick -- a sleeping frame, a pinned
      // body -- must present no arrival velocity, not the one it settled with.
      this.vnx[k] = 0;
      this.vny[k] = 0;
      this.vnz[k] = 0;
      this.tvx[k] = 0;
      this.tvy[k] = 0;
      this.tvz[k] = 0;
    }
    this.hitNode[slot] = -1;
    this.hitImp[slot] = 0;
    this.pileLoad[slot] = 0;
  }

  /** Decays the damage-history reference. `rate` is in s^-1. */
  decayRef(slot: number, dt: number, rate: number) {
    const k = Math.exp(-rate * dt);
    const o = slot * 6;
    for (let r = 0; r < 6; r++) this.vref[o + r] = this.vref[o + r]! * k;
  }

  /**
   * Excess closing speed over what this region has already absorbed, m/s, and
   * raises the reference to match. Returns 0 when the contact is just the same
   * impact still resolving.
   */
  takeExcess(slot: number, region: number, v: number) {
    const i = slot * 6 + region;
    const ref = this.vref[i]!;
    if (v <= ref) return 0;
    this.vref[i] = v;
    return v - ref;
  }

  /** Mass-weighted centre of mass and its velocity over the tick. */
  updateCom(slot: number, h: number) {
    const b = this.base(slot);
    const n = this.count[slot]!;
    let mx = 0;
    let my = 0;
    let mz = 0;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    let mt = 0;
    for (let i = 0; i < n; i++) {
      const k = b + i;
      const m = this.mass[k]!;
      mt += m;
      mx += this.px[k]! * m;
      my += this.py[k]! * m;
      mz += this.pz[k]! * m;
      vx += ((this.px[k]! - this.ox[k]!) / h) * m;
      vy += ((this.py[k]! - this.oy[k]!) / h) * m;
      vz += ((this.pz[k]! - this.oz[k]!) / h) * m;
    }
    if (mt <= 0) mt = 1;
    this.comX[slot] = mx / mt;
    this.comY[slot] = my / mt;
    this.comZ[slot] = mz / mt;
    this.comVX[slot] = vx / mt;
    this.comVY[slot] = vy / mt;
    this.comVZ[slot] = vz / mt;
  }

  /**
   * Support-polygon margin at the capture point.
   *
   * Stability is not "are the feet under the centre of mass" but "is the point
   * you would have to step to still inside your base of support" — the
   * extrapolated centre of mass / capture point,
   *
   *     x_cp = x_com + v_com * sqrt(h_com / g)          [m]
   *
   * (Hof; Pratt). Returns the signed distance from x_cp to the convex hull of
   * the grounded contact nodes: positive inside, negative outside.
   */
  supportMargin(slot: number, anticipate: boolean, dirX: number, dirZ: number, maxIntend: number) {
    const b = this.base(slot);
    const n = this.count[slot]!;
    const plan = this.plan(slot);
    let m = 0;
    let lowest = Infinity;
    let patch = 0;
    // Where the ground is, from whatever actually registered contact.
    for (let i = 0; i < n; i++) {
      const k = b + i;
      if (!this.touched[k]) continue;
      if (this.py[k]! < lowest) lowest = this.py[k]!;
    }
    if (lowest === Infinity) {
      // Airborne. There is no base of support to be inside or outside of, so
      // this is not a balance failure -- it is flight, and the landing decides.
      this.supportCount[slot] = 0;
      this.margin[slot] = -0.5;
      return -0.5;
    }
    // A part resting ON that ground is support whether or not it happened to
    // register an impulse this tick. Taking only the nodes with a live contact
    // meant a momentarily unloaded foot left the base -- and unloading a foot
    // for a moment is exactly what a crouch, a weight shift or a slow step
    // does. The base then collapsed to a single point, and a one-point base
    // puts the capture point outside it for any lean at all: the body read as
    // falling while standing still. Crouching alone was enough to put the
    // player on the floor.
    for (let i = 0; i < n; i++) {
      const k = b + i;
      if (!this.touched[k]) {
        if (this.py[k]! > lowest + SUPPORT_REST_TOL) continue;
        const vx = this.vnx[k]!;
        const vz = this.vnz[k]!;
        if (vx * vx + vz * vz > SUPPORT_REST_V2) continue;
      }
      this.hullX[m] = this.px[k]!;
      this.hullZ[m] = this.pz[k]!;
      patch += this.patch[k]!;
      m++;
    }
    this.supportCount[slot] = m;
    // Anticipated base of support.
    //
    // A walker is ALWAYS momentarily outside the base its planted foot defines
    // -- that is what walking is. Judging a stride against the standing base
    // makes every step read as a loss of balance. Dynamic balance is judged
    // against the base the mover is committed to, so a swing foot whose target
    // is about to reach the ground counts as support before it lands.
    if (anticipate && this.stepReady[slot]) {
      this.hullX[m] = this.stepX[slot]!;
      this.hullZ[m] = this.stepZ[slot]!;
      patch += this.patch[b + plan.feet[0]]!;
      m++;
    }

    patch /= m;
    const hCom = Math.max(0.2, this.comY[slot]! - lowest);
    const tau = Math.sqrt(hCom / GRAVITY); // s
    // The capture point is built from the UNINTENDED part of the motion.
    //
    // Travelling forward on purpose is not a loss of balance -- a walker's
    // centre of mass is ahead of their feet by design, and a runner's more so.
    // What a balance test must catch is motion the mover did not ask for: a
    // shove, a trip, a slip, a limb that failed to take its share.
    //
    // Only the forward component actually achieved is discounted, and only up to
    // what was asked for. Moving slower than commanded is not credited as
    // backward motion; being pushed faster than commanded, or sideways, or
    // backward, is residual and counts in full.
    const along = this.comVX[slot]! * dirX + this.comVZ[slot]! * dirZ;
    const keep = Math.min(Math.max(along, 0), maxIntend);
    const rvx = this.comVX[slot]! - dirX * keep;
    const rvz = this.comVZ[slot]! - dirZ * keep;
    const cx = this.comX[slot]! + rvx * tau;
    const cz = this.comZ[slot]! + rvz * tau;

    let d: number;
    if (m === 1) {
      const dx = cx - this.hullX[0]!;
      const dz = cz - this.hullZ[0]!;
      d = patch - Math.sqrt(dx * dx + dz * dz);
    } else {
      const hn = convexHull(this.hullX, this.hullZ, m, this.hullOrder, this.stack);
      d =
        hn < 3
          ? patch - segMinDist(this.hullX, this.hullZ, this.hullOrder, hn, cx, cz)
          : patch + hullSignedDist(this.hullX, this.hullZ, this.hullOrder, hn, cx, cz);
    }
    this.margin[slot] = d;
    this.captureX[slot] = cx;
    this.captureZ[slot] = cz;
    return d;
  }

  /** Applies a world-space impulse [N*s] to one node. */
  applyImpulse(slot: number, node: number, jx: number, jy: number, jz: number, h: number) {
    const k = this.base(slot) + node;
    const im = this.invMass[k]!;
    this.ox[k] = this.ox[k]! - jx * im * h;
    this.oy[k] = this.oy[k]! - jy * im * h;
    this.oz[k] = this.oz[k]! - jz * im * h;
  }

  /** Adds a world-space velocity change [m/s] to every node in a body. */
  addVelocity(slot: number, vx: number, vy: number, vz: number, h: number) {
    const b = this.base(slot);
    const n = this.count[slot]!;
    for (let i = 0; i < n; i++) {
      const k = b + i;
      this.ox[k] = this.ox[k]! - vx * h;
      this.oy[k] = this.oy[k]! - vy * h;
      this.oz[k] = this.oz[k]! - vz * h;
    }
  }

  /** Node whose contact sphere is nearest to a world point, or -1 past maxDist. */
  nearestNode(slot: number, x: number, y: number, z: number, maxDist: number) {
    const b = this.base(slot);
    const n = this.count[slot]!;
    let best = -1;
    let bd = maxDist * maxDist;
    for (let i = 0; i < n; i++) {
      const k = b + i;
      const dx = this.px[k]! - x;
      const dy = this.py[k]! - y;
      const dz = this.pz[k]! - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd) {
        bd = d2;
        best = i;
      }
    }
    return best;
  }

  /**
   * Node on `slot` that a striking sphere actually swept through this tick, or
   * -1 if none.
   *
   * The segment is the striking node's own solved path over the tick --
   * `rx/ry/rz` (where it was when the tick began) to `px/py/pz` (where the
   * solve left it) -- not a point projected from the striker's facing and a
   * weapon-length constant. A blow that never reaches a real node cannot
   * register, and one that grazes an arm cannot be billed to the chest.
   *
   * Picks the node with the deepest overlap along the sweep, so a strike that
   * passes near two nodes lands on whichever it actually came closest to.
   */
  sweptNode(
    slot: number,
    ax0: number,
    ay0: number,
    az0: number,
    ax1: number,
    ay1: number,
    az1: number,
    strikerRad: number,
  ) {
    const b = this.base(slot);
    const n = this.count[slot]!;
    const dx = ax1 - ax0;
    const dy = ay1 - ay0;
    const dz = az1 - az0;
    const segLen2 = dx * dx + dy * dy + dz * dz;
    let best = -1;
    let bestPen = 0;
    for (let i = 0; i < n; i++) {
      const k = b + i;
      const px = this.px[k]!;
      const py = this.py[k]!;
      const pz = this.pz[k]!;
      let t = segLen2 > 1e-9 ? ((px - ax0) * dx + (py - ay0) * dy + (pz - az0) * dz) / segLen2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax0 + dx * t;
      const cy = ay0 + dy * t;
      const cz = az0 + dz * t;
      const ddx = px - cx;
      const ddy = py - cy;
      const ddz = pz - cz;
      const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
      const rr = strikerRad + this.rad[k]!;
      const pen = rr * rr - d2;
      if (pen > bestPen) {
        bestPen = pen;
        best = i;
      }
    }
    return best;
  }

  regionOf(slot: number, node: number): Region {
    return REGIONS[this.region[this.base(slot) + node]!]!;
  }

  /**
   * Teleports a whole body, preserving its pose and killing its velocity.
   *
   * The centroid is recomputed here rather than read from `comX/comZ`: those
   * are only written during a solve, so a teleport before the first tick (a
   * save restore, a scenario setup) would otherwise translate the body by the
   * full distance from the origin and leave it metres from its own capsule.
   */
  moveTo(slot: number, x: number, y: number, z: number) {
    const b = this.base(slot);
    const n = this.count[slot]!;
    let cx = 0;
    let cz = 0;
    let mt = 0;
    let lowest = Infinity;
    for (let i = 0; i < n; i++) {
      const k = b + i;
      const m = this.mass[k]!;
      cx += this.px[k]! * m;
      cz += this.pz[k]! * m;
      mt += m;
      if (this.py[k]! - this.rad[k]! < lowest) lowest = this.py[k]! - this.rad[k]!;
    }
    if (mt <= 0) mt = 1;
    const dx = x - cx / mt;
    const dz = z - cz / mt;
    const dy = y - lowest;
    this.comX[slot] = x;
    this.comZ[slot] = z;
    this.comVX[slot] = 0;
    this.comVY[slot] = 0;
    this.comVZ[slot] = 0;
    for (let i = 0; i < n; i++) {
      const k = b + i;
      this.px[k] = this.px[k]! + dx;
      this.py[k] = this.py[k]! + dy;
      this.pz[k] = this.pz[k]! + dz;
      this.ox[k] = this.px[k]!;
      this.oy[k] = this.py[k]!;
      this.oz[k] = this.pz[k]!;
      this.rx[k] = this.px[k]!;
      this.ry[k] = this.py[k]!;
      this.rz[k] = this.pz[k]!;
      // Carry the pose targets along. Leaving them behind makes the tracking
      // error the full teleport distance for one tick, which the pose-loss test
      // reads as the body having been physically overpowered -- so anything
      // teleported instantly falls over.
      this.tx[k] = this.tx[k]! + dx;
      this.ty[k] = this.ty[k]! + dy;
      this.tz[k] = this.tz[k]! + dz;
    }
  }

  /** Refreshes the cached collider shortlist when the body has moved or aged out. */
  refreshNear(slot: number, colliders: Collider[], x: number, z: number, reach: number) {
    const dx = x - this.nearX[slot]!;
    const dz = z - this.nearZ[slot]!;
    const moved = dx * dx + dz * dz > 0.16; // 0.4 m, well inside the 0.7 m gather margin
    if (!moved && this.nearAge[slot]! < 10) {
      this.nearAge[slot] = this.nearAge[slot]! + 1;
      return;
    }
    this.nearX[slot] = x;
    this.nearZ[slot] = z;
    this.nearAge[slot] = 0;
    const r = reach + 0.7;
    let c = 0;
    const off = slot * MAX_NEAR;
    for (let i = 0; i < colliders.length && c < MAX_NEAR; i++) {
      const col = colliders[i]!;
      if (x + r < col.minX || x - r > col.maxX || z + r < col.minZ || z - r > col.maxZ) continue;
      this.near[off + c] = i;
      c++;
    }
    this.nearCount[slot] = c;
  }
}

function restDist(p: BodyPlan, a: number, b: number) {
  const na = p.nodes[a]!;
  const nb = p.nodes[b]!;
  const dx = na.x - nb.x;
  const dy = na.y - nb.y;
  const dz = na.z - nb.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/* ------------------------------------------------------------------ *
 * Convex hull (Andrew monotone chain) over preallocated scratch
 * ------------------------------------------------------------------ */

function cross2(xs: Float32Array, zs: Float32Array, o: number, a: number, b: number) {
  return (xs[a]! - xs[o]!) * (zs[b]! - zs[o]!) - (zs[a]! - zs[o]!) * (xs[b]! - xs[o]!);
}

/** Writes hull vertex indices into `out` in CCW order; returns the hull size. */
function convexHull(
  xs: Float32Array,
  zs: Float32Array,
  n: number,
  out: Int32Array,
  order: Int32Array,
) {
  for (let i = 0; i < n; i++) order[i] = i;
  // insertion sort by (x, z): n <= 11, so this is cheaper than a comparator sort
  for (let i = 1; i < n; i++) {
    const v = order[i]!;
    let j = i - 1;
    while (
      j >= 0 &&
      (xs[order[j]!]! > xs[v]! || (xs[order[j]!]! === xs[v]! && zs[order[j]!]! > zs[v]!))
    ) {
      order[j + 1] = order[j]!;
      j--;
    }
    order[j + 1] = v;
  }
  let k = 0;
  for (let i = 0; i < n; i++) {
    const p = order[i]!;
    while (k >= 2 && cross2(xs, zs, out[k - 2]!, out[k - 1]!, p) <= 0) k--;
    out[k++] = p;
  }
  const lower = k + 1;
  for (let i = n - 2; i >= 0; i--) {
    const p = order[i]!;
    while (k >= lower && cross2(xs, zs, out[k - 2]!, out[k - 1]!, p) <= 0) k--;
    out[k++] = p;
  }
  return Math.max(0, k - 1);
}

function distToSeg(ax: number, az: number, bx: number, bz: number, px: number, pz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = 0;
  if (len2 > 1e-12) t = clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1);
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  return Math.sqrt(qx * qx + qz * qz);
}

/** Degenerate hull (collinear / 2 points): distance to the supporting segment. */
function segMinDist(
  xs: Float32Array,
  zs: Float32Array,
  hull: Int32Array,
  hn: number,
  px: number,
  pz: number,
) {
  if (hn <= 0) return 0.5;
  if (hn === 1) {
    const a = hull[0]!;
    const dx = xs[a]! - px;
    const dz = zs[a]! - pz;
    return Math.sqrt(dx * dx + dz * dz);
  }
  let best = Infinity;
  for (let i = 0; i < hn; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hn]!;
    best = Math.min(best, distToSeg(xs[a]!, zs[a]!, xs[b]!, zs[b]!, px, pz));
  }
  return best;
}

/** Signed distance to a CCW convex polygon: positive inside, negative outside. */
function hullSignedDist(
  xs: Float32Array,
  zs: Float32Array,
  hull: Int32Array,
  hn: number,
  px: number,
  pz: number,
) {
  let maxOut = -Infinity;
  let outside = false;
  for (let i = 0; i < hn; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hn]!;
    const ex = xs[b]! - xs[a]!;
    const ez = zs[b]! - zs[a]!;
    const len = Math.sqrt(ex * ex + ez * ez);
    if (len < 1e-9) continue;
    // outward normal of a CCW polygon in (x,z) with y up
    const nx = ez / len;
    const nz = -ex / len;
    const d = (px - xs[a]!) * nx + (pz - zs[a]!) * nz;
    if (d > 0) outside = true;
    if (d > maxOut) maxOut = d;
  }
  if (maxOut === -Infinity) return 0;
  if (!outside) return -maxOut; // inside: distance to the nearest edge
  return -segMinDist(xs, zs, hull, hn, px, pz);
}

/* ------------------------------------------------------------------ *
 * Impact-local damage
 * ------------------------------------------------------------------ */

/**
 * Turns a contact into tissue damage on the region that actually took it.
 * The region comes from the struck node's geometry, never a random roll.
 *
 *   v_e      = v * sqrt(focus)                       concentration, see contactFocus
 *   bruise   += K_b * hard * (v_e^2 - VB^2) / V_REF^2   energy density
 *   fracture += K_f * hard * (v_e - VF)^1.5 / boneTol   yield then runaway
 *   cut      += K_c * v_t * sharpness * hard            sliding edge
 *   puncture += K_p * (v_e - VP) * pierce * hard
 *
 * `v` is the closing speed the tissue met the surface at, m/s, and `v_t` the
 * sliding speed across it. Weapon strikes and floor contacts go through this
 * one law, which is why falls injure with no fall-specific code, why hay is
 * survivable and cobble is not, and why a beam landing on a shoulder breaks a
 * shoulder.
 *
 * Returns the total injury increment, dimensionless, for the budget audit.
 */
export function impulseDamage(
  inj: Injury,
  v: number,
  vt: number,
  hardness: number,
  boneTol: number,
  focus: number,
  sharp: number,
  pierce: number,
): number {
  if (!EDGES.impulseInjury) return 0;
  if (!(v >= 0) || !(vt >= 0) || boneTol <= 0) return 0;
  const hard = clamp(hardness, 0, 1.2);
  const ve = v * Math.sqrt(Math.max(1, focus));
  let total = 0;
  if (ve > VB) {
    // blunt trauma tracks energy density, hence the square
    const bruise = (K_BRUISE * hard * (ve * ve - VB * VB)) / (V_REF * V_REF);
    inj.bruise += bruise;
    total += bruise;
  }
  const yieldOver = ve - VF;
  if (yieldOver > 0) {
    const frac = (K_FRACTURE * hard * Math.pow(yieldOver, FRACTURE_EXP)) / boneTol;
    inj.fracture += frac;
    total += frac;
  }
  if (sharp > 0 && vt > 0.3) {
    const cut = K_CUT * vt * sharp * hard;
    inj.cut += cut;
    total += cut;
  }
  if (pierce > 0 && ve > VP) {
    const punc = K_PUNCTURE * (ve - VP) * pierce * hard;
    inj.puncture += punc;
    total += punc;
  }
  return total;
}

/**
 * Concussion is a separate law from tissue damage, because it is driven by a
 * different quantity: the head's change in velocity, not the pressure at the
 * skin. Returns the loss of consciousness, dimensionless in [0,1].
 *
 *   dv_head = J / m_head    [m/s],  loss = K * max(0, dv_head - DV_CONCUSS)
 */
const DV_CONCUSS = 4.0;
const K_CONCUSS = 0.09;

export function concussion(dvHead: number) {
  return K_CONCUSS * Math.max(0, dvHead - DV_CONCUSS);
}

export function hardnessOf(m: Material) {
  return HARDNESS[m] ?? 0.6;
}

export function frictionOf(m: Material) {
  return FRICTION[m] ?? 0.7;
}

export function boneTolOf(r: Region) {
  return BONE_TOL[r];
}

/* ------------------------------------------------------------------ *
 * Motor authority
 * ------------------------------------------------------------------ */

/** Injury load at which a limb has no usable motor authority left. */
export const MOTOR_FAIL = 1.9;

/**
 * Per-limb motor authority in [0,1]: how much of the target pose the solver is
 * permitted to enforce on nodes belonging to that region.
 *
 * This is the coupling that replaces three separate timers. Damage on the left
 * leg lowers only that leg's authority, so the character limps because the
 * solver can no longer place that foot, not because a limp animation was
 * selected.
 */
export function limbMotor(a: Actor, r: Region, injSum: number): number {
  const local = EDGES.injuryMotor ? 1 - clamp(injSum / MOTOR_FAIL, 0, 1) : 1;
  return clamp(local * a.authority, 0, 1);
}

/**
 * Global authority gate: consciousness, fatigue and pain scale everything, and
 * the locomotion state supplies the deliberate part (0 while ragdolling,
 * ramping while getting up).
 */
export function globalAuthority(a: Actor): number {
  const phys = clamp(a.consciousness, 0, 1) * (1 - a.fatigue * 0.28) * (1 - a.pain * 0.22);
  return clamp(phys * a.stanceAuth, 0, 1);
}

/**
 * Converts a motor authority into the fraction of pose error the solver
 * resolves in one substep of length h.
 *
 * Derived from an exponential time constant so it is step-size independent:
 *   retained = exp(-rate * h),  applied = 1 - retained,  rate in s^-1.
 * This is the XPBD soft constraint with compliance alpha~ = w * s/(1-s); the
 * exponential form is used because it keeps the stiffness a real rate rather
 * than a per-frame constant.
 */
export function poseGain(motor: number, h: number, rateMax: number): number {
  const m = EDGES.motorPose ? motor : 1;
  if (m <= 0.001) return 0;
  const rate = rateMax * m * m;
  return 1 - Math.exp(-rate * h);
}

/* ------------------------------------------------------------------ *
 * Solver
 *
 * One tick = SUBSTEPS iterations of:
 *   predict -> pose -> bones -> limits -> attachments -> world -> pairs -> finish
 * The order is fixed and recorded here: it is part of the determinism boundary,
 * because Gauss-Seidel projection is order dependent.
 * ------------------------------------------------------------------ */

/** Water is very slightly less dense than flesh, so a still body sinks slowly. */
const RHO_RATIO = 1.04;
/** Linearised water drag rate, s^-1, applied through the exponential form. */
const WATER_DRAG = 5.2;
/** Air drag on a free node, s^-1. Small: it only keeps ragdolls from windmilling. */
const AIR_DRAG = 0.22;
/**
 * Ceiling on the acceleration a pose constraint may impose on a node, m/s^2.
 * ~25 g at the limb: strong enough for a fast strike or a catch step, bounded
 * enough that a limb cannot outrun a falling body.
 */
const MAX_POSE_ACCEL = 600;
/**
 * Ceiling on the acceleration a grip may impose on what it holds, m/s^2.
 *
 * A hand transmits a bounded force. Without this a braced grip is effectively a
 * winch: it closes the whole gap every substep, which hauls a body across the
 * ground fast enough to kill it and yanks the holder off their feet.
 */
const MAX_GRIP_ACCEL = 900;

/**
 * Semi-implicit prediction step. Velocity is updated before position, which is
 * the whole point of the symplectic form; reversing these two lines pumps
 * energy into every constraint in the body.
 */
export function predict(B: Bodies, slot: number, h: number, gravity: number) {
  const b = B.base(slot);
  const n = B.count[slot]!;
  for (let i = 0; i < n; i++) {
    const k = b + i;
    let vx = (B.px[k]! - B.ox[k]!) / h;
    let vy = (B.py[k]! - B.oy[k]!) / h;
    let vz = (B.pz[k]! - B.oz[k]!) / h;
    const f = B.wet[k]!;
    // Buoyancy as a reduced effective gravity; exponential drag so the update
    // is unconditionally stable however light the node is.
    const g = gravity * (1 - f / RHO_RATIO);
    const drag = Math.exp(-(AIR_DRAG + WATER_DRAG * f) * h);
    vy -= g * h;
    vx *= drag;
    vy *= drag;
    vz *= drag;
    B.ox[k] = B.px[k]!;
    B.oy[k] = B.py[k]!;
    B.oz[k] = B.pz[k]!;
    B.px[k] = B.px[k]! + vx * h;
    B.py[k] = B.py[k]! + vy * h;
    B.pz[k] = B.pz[k]! + vz * h;
    B.vnx[k] = vx;
    B.vny[k] = vy;
    B.vnz[k] = vz;
  }
}

/**
 * Pose constraints. `B.gain` holds the per-region fraction of pose error to
 * resolve this substep (0 = the limb is dead weight, 1 = rigidly driven).
 * This is the only place motor authority enters the solver, and it is why
 * ragdoll, stumble, limp and get-up are one continuum instead of four states.
 */
export function solvePose(
  B: Bodies,
  slot: number,
  h: number,
  groundY: number,
  supportFrac: number,
) {
  const b = B.base(slot);
  const n = B.count[slot]!;
  // Muscle is strong but not infinite. Without this bound the pose constraint
  // can move a node arbitrarily fast, which silently deletes impacts: a braced
  // body would catch a fall from any height with no contact at all, because the
  // pose reached the target before the ground did.
  const maxStep = MAX_POSE_ACCEL * h * h;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let mt = 0;
  for (let i = 0; i < n; i++) {
    const k = b + i;
    mt += B.mass[k]!;
    const g = B.gain[B.region[k]!]!;
    if (g <= 0) continue;
    // A target below the floor turns the pose constraint into a jack: it drives
    // the node down, the contact refuses, and the reaction lifts the body.
    // --- the damping half of the muscle ---------------------------------
    // The attractor above is a spring with no damper, and an undamped spring
    // rings. It had been ringing: measured across a populated level, every
    // node of every villager was oscillating, hands and feet peaking at 25-33
    // m/s while their owners ambled at 0.5 m/s, and the landing test honestly
    // reported those as impacts -- so the whole village fell over on flat
    // ground, and any pose change large enough (a punch) knocked its own
    // thrower down without touching anything.
    //
    // The rate is `g` itself, not a new constant: a first-order position
    // filter of rate w is critically matched by a velocity damper of the same
    // rate, so the muscle damps exactly as hard as it pulls -- and since `g`
    // is `poseGain(motor)`, a damaged limb loses its damping precisely as it
    // loses its drive, and a limp body is floppy without a second law.
    //
    // What it damps is velocity RELATIVE TO THE TARGET's own motion, which is
    // what keeps a sprint a sprint: the targets travel with the body, so bulk
    // locomotion has no relative velocity to lose.
    const rvx = B.px[k]! - B.ox[k]! - B.tvx[k]! * h;
    const rvy = B.py[k]! - B.oy[k]! - B.tvy[k]! * h;
    const rvz = B.pz[k]! - B.oz[k]! - B.tvz[k]! * h;
    let cx = rvx * g;
    let cy = rvy * g;
    let cz = rvz * g;
    // Passivity. A damper may only take kinetic energy out of a node, never
    // put it in, whatever the target claims to be doing -- and a target CAN
    // claim anything for one tick (a teleport, stance authority collapsing,
    // a limb entering a new pose). |v - c| <= |v| is exactly c.c <= 2 c.v, so
    // scale the correction down to that bound and drop it outright when it
    // points the wrong way. This is what makes the pose loop provably
    // non-amplifying on the damping half rather than merely tuned.
    const vx = B.px[k]! - B.ox[k]!;
    const vy = B.py[k]! - B.oy[k]!;
    const vz = B.pz[k]! - B.oz[k]!;
    const cv = cx * vx + cy * vy + cz * vz;
    const cc = cx * cx + cy * cy + cz * cz;
    if (cc > 2 * cv) {
      const s = cv > 0 ? (2 * cv) / cc : 0;
      cx *= s;
      cy *= s;
      cz *= s;
    }
    B.ox[k] = B.ox[k]! + cx;
    B.oy[k] = B.oy[k]! + cy;
    B.oz[k] = B.oz[k]! + cz;

    const ty = Math.max(B.ty[k]!, groundY + B.rad[k]!);
    let dx = (B.tx[k]! - B.px[k]!) * g;
    let dy = (ty - B.py[k]!) * g;
    let dz = (B.tz[k]! - B.pz[k]!) * g;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > maxStep * maxStep && d2 > 1e-18) {
      const sc = maxStep / Math.sqrt(d2);
      dx *= sc;
      dy *= sc;
      dz *= sc;
    }
    B.px[k] = B.px[k]! + dx;
    B.py[k] = B.py[k]! + dy;
    B.pz[k] = B.pz[k]! + dz;
    sx += dx * B.mass[k]!;
    sy += dy * B.mass[k]!;
    sz += dz * B.mass[k]!;
  }
  // Muscle is an INTERNAL force, and internal forces cannot move a centre of
  // mass. A body only translates by pushing on something, so the share of the
  // pose's net centre-of-mass displacement that survives is the share the
  // contacts can react. With nothing underfoot it keeps none: limbs still move,
  // the body does not, and a get-up cannot lift itself out of mid-air.
  const keep = clamp(supportFrac, 0, 1);
  if (keep >= 1 || mt <= 0) return;
  const cx = (sx / mt) * (1 - keep);
  const cy = (sy / mt) * (1 - keep);
  const cz = (sz / mt) * (1 - keep);
  if (cx === 0 && cy === 0 && cz === 0) return;
  for (let i = 0; i < n; i++) {
    const k = b + i;
    B.px[k] = B.px[k]! - cx;
    B.py[k] = B.py[k]! - cy;
    B.pz[k] = B.pz[k]! - cz;
  }
}
/**
 * Rigid distance constraints (the skeleton) plus passive tissue damping.
 *
 * The damping removes a fraction of the RELATIVE velocity across each bone,
 * applied in inverse-mass proportion so linear momentum is exactly conserved:
 * it settles a limp body without slowing a falling one. Rate is in s^-1 and is
 * converted through the exponential form, so it does not depend on the substep
 * size. A body with motor authority is springy; a limp one is a sack, which is
 * the difference between a stagger and a drape.
 */
const BONE_DAMP_LIVE = 7;
const BONE_DAMP_LIMP = 30;

export function solveBones(B: Bodies, slot: number, h: number, motor: number) {
  const p = B.plan(slot);
  const b = B.base(slot);
  const off = slot * MAX_BONES;
  const rate = BONE_DAMP_LIVE + (BONE_DAMP_LIMP - BONE_DAMP_LIVE) * (1 - clamp(motor, 0, 1));
  const kd = 1 - Math.exp(-rate * h);
  for (let i = 0; i < p.bones.length; i++) {
    const [ia, ib] = p.bones[i]!;
    const ka = b + ia;
    const kb = b + ib;
    project(B, ka, kb, B.boneRest[off + i]!, 0);
    const wa = B.invMass[ka]!;
    const wb = B.invMass[kb]!;
    const wSum = wa + wb;
    if (wSum <= 0) continue;
    const dvx = (B.px[ka]! - B.ox[ka]! - (B.px[kb]! - B.ox[kb]!)) * kd;
    const dvy = (B.py[ka]! - B.oy[ka]! - (B.py[kb]! - B.oy[kb]!)) * kd;
    const dvz = (B.pz[ka]! - B.oz[ka]! - (B.pz[kb]! - B.oz[kb]!)) * kd;
    const fa = wa / wSum;
    const fb = wb / wSum;
    B.ox[ka] = B.ox[ka]! + dvx * fa;
    B.oy[ka] = B.oy[ka]! + dvy * fa;
    B.oz[ka] = B.oz[ka]! + dvz * fa;
    B.ox[kb] = B.ox[kb]! - dvx * fb;
    B.oy[kb] = B.oy[kb]! - dvy * fb;
    B.oz[kb] = B.oz[kb]! - dvz * fb;
  }
}

/**
 * Joint limits as inequality distance constraints between nodes two apart.
 * A knee is the pelvis-to-foot distance held inside [min,max]; an elbow is
 * chest-to-hand. Cheap, and it is what stops a particle body folding into a
 * shape a skeleton cannot make.
 */
export function solveLimits(B: Bodies, slot: number) {
  const p = B.plan(slot);
  const b = B.base(slot);
  const off = slot * MAX_LIMITS;
  for (let i = 0; i < p.limits.length; i++) {
    const l = p.limits[i]!;
    project(B, b + l.a, b + l.b, B.limMin[off + i]!, -1);
    project(B, b + l.a, b + l.b, B.limMax[off + i]!, 1);
  }
}

/**
 * Distance projection between two nodes.
 * mode 0 = equality, -1 = minimum only, +1 = maximum only.
 * Guards the zero-length case rather than normalising a null vector.
 */
function project(B: Bodies, ka: number, kb: number, rest: number, mode: number) {
  const dx = B.px[ka]! - B.px[kb]!;
  const dy = B.py[ka]! - B.py[kb]!;
  const dz = B.pz[ka]! - B.pz[kb]!;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < 1e-12) return;
  const d = Math.sqrt(d2);
  const C = d - rest;
  if (mode < 0 && C >= 0) return;
  if (mode > 0 && C <= 0) return;
  const wa = B.invMass[ka]!;
  const wb = B.invMass[kb]!;
  const wSum = wa + wb;
  if (wSum <= 0) return;
  const s = C / (d * wSum);
  B.px[ka] = B.px[ka]! - dx * s * wa;
  B.py[ka] = B.py[ka]! - dy * s * wa;
  B.pz[ka] = B.pz[ka]! - dz * s * wa;
  B.px[kb] = B.px[kb]! + dx * s * wb;
  B.py[kb] = B.py[kb]! + dy * s * wb;
  B.pz[kb] = B.pz[kb]! + dz * s * wb;
}

/**
 * Soft attachment between two nodes, used for grabs.
 *
 * Hauling on something is done with the whole body, not with the hand. Solving
 * against the hand node's own 1.6 kg means a grip can barely move a torso --
 * essentially all of the correction goes into the arm. `brace` is the share of
 * the holder's mass the grip is braced against, and the resulting displacement
 * is applied across the holder, because that is what actually moved.
 *
 * Both ends still move in inverse-mass proportion, so grabbing something heavy
 * pulls the holder as hard as it pulls the load.
 *
 * Returns the transmitted impulse magnitude, N*s.
 */
export function solveAttach(
  B: Bodies,
  slotA: number,
  nodeA: number,
  kb: number,
  invB: number,
  rest: number,
  gain: number,
  h: number,
  brace: number,
) {
  const ka = B.base(slotA) + nodeA;
  const dx = B.px[ka]! - B.px[kb]!;
  const dy = B.py[ka]! - B.py[kb]!;
  const dz = B.pz[ka]! - B.pz[kb]!;
  return applyAttach(B, slotA, nodeA, ka, dx, dy, dz, invB, rest, gain, h, brace, kb, ATTACH_OUT);
}

/** Scratch for the free-body branch of an attachment; never allocated per call. */
const ATTACH_OUT = { x: 0, y: 0, z: 0 };

/**
 * Attachment between a held node and a point in space that belongs to something
 * outside the node store -- a prop. The displacement the far side should take
 * is written into `out` for the caller to apply.
 */
export function attachToPoint(
  B: Bodies,
  slotA: number,
  nodeA: number,
  tx: number,
  ty: number,
  tz: number,
  invB: number,
  rest: number,
  gain: number,
  h: number,
  brace: number,
  out: { x: number; y: number; z: number },
) {
  const ka = B.base(slotA) + nodeA;
  return applyAttach(
    B,
    slotA,
    nodeA,
    ka,
    B.px[ka]! - tx,
    B.py[ka]! - ty,
    B.pz[ka]! - tz,
    invB,
    rest,
    gain,
    h,
    brace,
    -1,
    out,
  );
}

function applyAttach(
  B: Bodies,
  slotA: number,
  nodeA: number,
  ka: number,
  dx: number,
  dy: number,
  dz: number,
  invB: number,
  rest: number,
  gain: number,
  h: number,
  brace: number,
  kb: number,
  out: { x: number; y: number; z: number },
) {
  out.x = 0;
  out.y = 0;
  out.z = 0;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < 1e-12) return 0;
  const d = Math.sqrt(d2);
  const C = d - rest;
  if (C <= 0) return 0;
  const mA = B.mass[ka]! + Math.max(0, brace);
  const wa = 1 / mA;
  const wSum = wa + invB;
  if (wSum <= 0) return 0;
  const pull = Math.min(C * gain, MAX_GRIP_ACCEL * h * h);
  const s = pull / (d * wSum);
  const ax = -dx * s * wa;
  const ay = -dy * s * wa;
  const az = -dz * s * wa;
  const share = brace > 0 ? brace / mA : 0;
  const b = B.base(slotA);
  const n = B.count[slotA]!;
  for (let i = 0; i < n; i++) {
    const k = b + i;
    const f = i === nodeA ? 1 : share;
    B.px[k] = B.px[k]! + ax * f;
    B.py[k] = B.py[k]! + ay * f;
    B.pz[k] = B.pz[k]! + az * f;
  }
  if (kb >= 0) {
    B.px[kb] = B.px[kb]! + dx * s * invB;
    B.py[kb] = B.py[kb]! + dy * s * invB;
    B.pz[kb] = B.pz[kb]! + dz * s * invB;
  } else {
    out.x = dx * s * invB;
    out.y = dy * s * invB;
    out.z = dz * s * invB;
  }
  // |dp| / (w * h) has units of m / ((1/kg) * s) = N*s
  return pull / (wSum * h);
}
/**
 * World contacts against the cached collider shortlist plus the ground plane.
 *
 * Depenetration moves the previous position by the same amount as the current
 * one, so it injects no velocity; the closing normal velocity is removed
 * separately (restitution 0). Friction removes tangential motion up to
 * mu * penetration, the standard position-based Coulomb approximation.
 *
 * Both the normal and tangential impulses are accumulated per node: they are
 * the producer for impact-local injury.
 */
export function solveWorld(
  B: Bodies,
  slot: number,
  colliders: Collider[],
  h: number,
  groundY: number,
) {
  const b = B.base(slot);
  const n = B.count[slot]!;
  const nc = B.nearCount[slot]!;
  const noff = slot * MAX_NEAR;
  const gHard = B.groundHard[slot]!;
  const gMu = B.groundMu[slot]!;

  for (let i = 0; i < n; i++) {
    const k = b + i;
    const r = B.rad[k]!;

    // --- cached colliders ---
    for (let c = 0; c < nc; c++) {
      const col = colliders[B.near[noff + c]!];
      if (!col) continue;
      if (col.water) {
        if (
          B.px[k]! > col.minX &&
          B.px[k]! < col.maxX &&
          B.pz[k]! > col.minZ &&
          B.pz[k]! < col.maxZ &&
          B.py[k]! - r < col.maxY
        ) {
          B.wet[k] = clamp((col.maxY - (B.py[k]! - r)) / (2 * r), 0, 1);
        }
        continue;
      }
      if (!col.solid) continue;
      const qx = clamp(B.px[k]!, col.minX, col.maxX);
      const qy = clamp(B.py[k]!, col.minY, col.maxY);
      const qz = clamp(B.pz[k]!, col.minZ, col.maxZ);
      let dx = B.px[k]! - qx;
      let dy = B.py[k]! - qy;
      let dz = B.pz[k]! - qz;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > (r + SUPPORT_EPS) * (r + SUPPORT_EPS)) continue;
      let nx: number;
      let ny: number;
      let nz: number;
      let pen: number;
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2);
        nx = dx / d;
        ny = dy / d;
        nz = dz / d;
        pen = r - d;
      } else {
        // node centre is inside the box: escape along the shallowest face
        const ex = Math.min(B.px[k]! - col.minX, col.maxX - B.px[k]!);
        const ey = Math.min(B.py[k]! - col.minY, col.maxY - B.py[k]!);
        const ez = Math.min(B.pz[k]! - col.minZ, col.maxZ - B.pz[k]!);
        nx = ny = nz = 0;
        if (ey <= ex && ey <= ez) {
          ny = B.py[k]! - col.minY < col.maxY - B.py[k]! ? -1 : 1;
          pen = ey + r;
        } else if (ex <= ez) {
          nx = B.px[k]! - col.minX < col.maxX - B.px[k]! ? -1 : 1;
          pen = ex + r;
        } else {
          nz = B.pz[k]! - col.minZ < col.maxZ - B.pz[k]! ? -1 : 1;
          pen = ez + r;
        }
      }
      const mat = col.material;
      contact(B, k, nx, ny, nz, pen, frictionOf(mat), hardnessOf(mat), h);
      dx = dy = dz = d2 = 0; // keep the loop body free of stale state
    }

    // --- ground plane, resolved last ---
    // A node whose centre ends up inside a box escapes through its shallowest
    // face, and that face can point down. Resolving the floor afterwards means
    // nothing can be left below the world, whichever way it was pushed.
    if (B.py[k]! - r < groundY + SUPPORT_EPS) {
      contact(B, k, 0, 1, 0, groundY + r - B.py[k]!, gMu, gHard, h);
    }
  }
}

/**
 * Mean distance from each node to its pose target, m.
 *
 * This is the measure of "how badly is the world overpowering this body". When
 * it grows past what muscle can recover, the character has physically lost the
 * pose, and the honest consequence is that they lose their footing. It is also
 * what bounds the capsule/body feedback loop: the discrepancy cannot grow
 * without triggering the collapse that hands authority to the body.
 */
export function poseError(B: Bodies, slot: number) {
  const b = B.base(slot);
  const n = B.count[slot]!;
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const k = b + i;
    const dx = B.px[k]! - B.tx[k]!;
    const dy = B.py[k]! - B.ty[k]!;
    const dz = B.pz[k]! - B.tz[k]!;
    s += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return s / n;
}

/**
 * Single contact resolution against a plane (n, pen) at one node.
 * Records the normal and tangential impulses, which are what damage is made of.
 */
const SUPPORT_EPS = 0.02;
/**
 * Rate at which an embedded overlap is allowed to unwind, m/s.
 *
 * Resolving a 30 cm overlap in one substep is not a push-out, it is an
 * explosion: on a rigid frame the distance constraints immediately yank the
 * displaced node back, and that yank IS velocity. Spread over a quarter of a
 * second the same body squeezes out of the chest that appeared around it.
 */
const MAX_DEPEN = 1.2;


function contact(
  B: Bodies,
  k: number,
  nx: number,
  ny: number,
  nz: number,
  pen: number,
  mu: number,
  hard: number,
  h: number,
) {
  // A node resting exactly on a surface is supported even when the solver has
  // just pushed the penetration to zero. Without this tolerance a stiffly posed
  // body loses and regains its base of support every other tick.
  if (pen > -SUPPORT_EPS && ny > 0.3) B.touched[k] = 1;
  if (pen <= 0) return;
  // A penetration deeper than the node itself is not a collision, it is a body
  // that started inside geometry -- a teleport, a spawn, a collapsing wall that
  // appeared around it. Push it out, but do not bill it for an impact it never
  // had: the alternative is that anything placed badly is instantly maimed.
  const artefact = pen > B.rad[k]!;
  // Signed normal displacement over the substep: what the SOLVER still has to
  // take out. It is not a velocity readout -- see below.
  const on = (B.px[k]! - B.ox[k]!) * nx + (B.py[k]! - B.oy[k]!) * ny + (B.pz[k]! - B.oz[k]!) * nz;
  if (on < 0) {
    // remove the closing normal velocity (perfectly inelastic)
    B.ox[k] = B.ox[k]! + nx * on;
    B.oy[k] = B.oy[k]! + ny * on;
    B.oz[k] = B.oz[k]! + nz * on;
  }
  // The impact is the speed the node ARRIVED with, read from `vnx` -- never
  // from (p - o) this substep, exactly as `solvePair` already does. By the time
  // world contact runs, `solvePose` and `solveLimits` have both written `px`
  // without moving `ox`, so (p - o)/h bills every muscle correction and every
  // joint-limit projection as a collision. At h = 1/240 a one-centimetre pose
  // correction reads as 2.4 m/s of impact, and a limit projection reads as
  // tens: standing still in a crowd measured 27 m/s of landing, so the whole
  // village fell over on flat ground and a punch -- the largest pose change a
  // body makes -- knocked its own thrower down without touching anything.
  const vn = B.vnx[k]! * nx + B.vny[k]! * ny + B.vnz[k]! * nz;
  if (vn < 0 && !artefact) {
    const closing = -vn; // m/s
    B.jimp[k] = B.jimp[k]! + B.mass[k]! * closing; // N*s, summed: this is force
    if (closing > B.vmax[k]!) B.vmax[k] = closing; // m/s, peak: this is damage
    if (hard > B.jhard[k]!) B.jhard[k] = hard;
  }
  // depenetrate p and o together so no velocity is created by the correction,
  // and unwind an embedded overlap at a bounded rate for the same reason a
  // pair does: a rigid frame answers a big one-substep correction with a big
  // constraint force.
  const out = artefact ? Math.min(pen, MAX_DEPEN * h) : pen;
  B.px[k] = B.px[k]! + nx * out;
  B.ox[k] = B.ox[k]! + nx * out;
  B.py[k] = B.py[k]! + ny * out;
  B.oy[k] = B.oy[k]! + ny * out;
  B.pz[k] = B.pz[k]! + nz * out;
  B.oz[k] = B.oz[k]! + nz * out;
  B.touched[k] = 1;

  // Coulomb friction, position form: remove tangential motion up to mu * pen
  const rx = B.px[k]! - B.ox[k]!;
  const ry = B.py[k]! - B.oy[k]!;
  const rz = B.pz[k]! - B.oz[k]!;
  const rn = rx * nx + ry * ny + rz * nz;
  const tx = rx - nx * rn;
  const ty = ry - ny * rn;
  const tz = rz - nz * rn;
  const tm = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (tm < 1e-9) return;
  const s = Math.min(1, (mu * pen) / tm);
  B.px[k] = B.px[k]! - tx * s;
  B.py[k] = B.py[k]! - ty * s;
  B.pz[k] = B.pz[k]! - tz * s;
  if (artefact) return;
  // Same rule tangentially: the abrasion is the speed the node was travelling
  // along the surface when it got here, times the fraction friction actually
  // arrests. `s` is a fraction, so it is free of the phantom; `tm` is not.
  const vtx = B.vnx[k]! - nx * vn;
  const vty = B.vny[k]! - ny * vn;
  const vtz = B.vnz[k]! - nz * vn;
  const slide = Math.sqrt(vtx * vtx + vty * vty + vtz * vtz) * s; // m/s arrested
  if (slide <= 0) return;
  B.jtan[k] = B.jtan[k]! + B.mass[k]! * slide;
  if (slide > B.vtan[k]!) B.vtan[k] = slide;
}

/**
 * Node-vs-node contact between two bodies. This is what makes a pile a pile:
 * bodies rest on, drape over and block one another instead of sharing a
 * capsule-vs-capsule push in the ground plane.
 *
 * Returns the mass of B transferred onto A through downward contacts, kg,
 * which is the load that shows up in A's balance.
 */
/**
 * Mass a node presents to a contact from another body, kg.
 *
 * Three cases, one expression. A prop frame sets `cmass` per node from its own
 * geometry, because a rigid beam struck near its middle has nearly all of its
 * mass behind the blow and struck at the tip has a quarter of it. A body with
 * its feet planted has `backing` near 1, and meets a blow with itself rather
 * than with the limb; that is why a beam dropped on a standing man breaks
 * something and the same beam nudging a man in mid-air just spins him. A body
 * in the air has `backing` 0 and falls back to the node's own mass.
 */
function contactMass(B: Bodies, slot: number, k: number) {
  const c = B.cmass[k]!;
  if (c > 0) return c;
  const m = B.mass[k]!;
  const back = B.backing[slot]!;
  if (back <= 0) return m;
  return m + back * (B.bodyMass[slot]! - m);
}

export function solvePair(B: Bodies, sa: number, sb: number, h: number, hardness = hardnessOf("flesh")) {
  const ba = B.base(sa);
  const bb = B.base(sb);
  const na = B.count[sa]!;
  const nb = B.count[sb]!;
  let loadOnA = 0;
  for (let i = 0; i < na; i++) {
    const ka = ba + i;
    const ra = B.rad[ka]!;
    for (let j = 0; j < nb; j++) {
      const kb = bb + j;
      const rr = ra + B.rad[kb]!;
      const dx = B.px[ka]! - B.px[kb]!;
      const dy = B.py[ka]! - B.py[kb]!;
      const dz = B.pz[ka]! - B.pz[kb]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > rr * rr || d2 < 1e-12) continue;
      const d = Math.sqrt(d2);
      const pen = rr - d;
      const nx = dx / d;
      const ny = dy / d;
      const nz = dz / d;
      const wa = B.invMass[ka]!;
      const wb = B.invMass[kb]!;
      const wSum = wa + wb;
      if (wSum <= 0) continue;

      // Closing speed along the normal, for the impulse readout. Read from the
      // velocity the nodes arrived with, never from (p - o) this substep: see
      // `vnx`. An immovable node (a sleeping frame, a pinned body) has no
      // predicted velocity and correctly contributes none.
      const van = B.vnx[ka]! * nx + B.vny[ka]! * ny + B.vnz[ka]! * nz;
      const vbn = B.vnx[kb]! * nx + B.vny[kb]! * ny + B.vnz[kb]! * nz;
      // An overlap deeper than a node is not a collision, it is geometry that
      // appeared around a body -- a chest given a frame while someone stands on
      // it, collapse debris spawning around a corpse. Billing it as an impact
      // maims whoever was standing there; resolving p alone turns the
      // correction into velocity and fires them across the market at solver
      // speed. Push both p and o, and charge nothing.
      const artefact = pen > Math.min(ra, B.rad[kb]!);
      const closing = vbn - van;
      if (closing > 0 && !artefact) {
        // The reduced mass of the two NODES is what the projection moves, but
        // it is not what the collision means. A node is joined to a body, and
        // that body may be braced against the ground; a rigid frame has its
        // whole length behind every node. `contactMass` is that, and the energy
        // it carries is what the tissue has to absorb.
        const ma = contactMass(B, sa, ka);
        const mb = contactMass(B, sb, kb);
        const mEff = (ma * mb) / (ma + mb); // reduced mass, kg
        const j = (1 / wSum) * closing; // N*s, what the projection actually moves
        B.jimp[ka] = B.jimp[ka]! + j;
        B.jimp[kb] = B.jimp[kb]! + j;
        if (closing > B.vmax[ka]!) {
          B.vmax[ka] = closing;
          B.vmass[ka] = mEff;
        }
        if (closing > B.vmax[kb]!) {
          B.vmax[kb] = closing;
          B.vmass[kb] = mEff;
        }
        if (hardness > B.jhard[ka]!) B.jhard[ka] = hardness;
        if (hardness > B.jhard[kb]!) B.jhard[kb] = hardness;
      }

      const s = (artefact ? Math.min(pen, MAX_DEPEN * h) : pen) / wSum;
      const ax = nx * s * wa;
      const ay = ny * s * wa;
      const az = nz * s * wa;
      const bx = nx * s * wb;
      const by = ny * s * wb;
      const bz = nz * s * wb;
      B.px[ka] = B.px[ka]! + ax;
      B.py[ka] = B.py[ka]! + ay;
      B.pz[ka] = B.pz[ka]! + az;
      B.px[kb] = B.px[kb]! - bx;
      B.py[kb] = B.py[kb]! - by;
      B.pz[kb] = B.pz[kb]! - bz;
      if (artefact) {
        B.ox[ka] = B.ox[ka]! + ax;
        B.oy[ka] = B.oy[ka]! + ay;
        B.oz[ka] = B.oz[ka]! + az;
        B.ox[kb] = B.ox[kb]! - bx;
        B.oy[kb] = B.oy[kb]! - by;
        B.oz[kb] = B.oz[kb]! - bz;
      }
      B.touched[ka] = 1;
      B.touched[kb] = 1;
      // B's node sits above A's: its weight is bearing down on A
      if (ny < -0.35) loadOnA += B.mass[kb]! * -ny;
    }
  }
  return loadOnA;
}

/** Clamps node speed after projection. Guards against a bad frame launching a body. */
export function finish(B: Bodies, slot: number, h: number, maxSpeed: number) {
  const b = B.base(slot);
  const n = B.count[slot]!;
  const lim = maxSpeed * h;
  const lim2 = lim * lim;
  for (let i = 0; i < n; i++) {
    const k = b + i;
    const dx = B.px[k]! - B.ox[k]!;
    const dy = B.py[k]! - B.oy[k]!;
    const dz = B.pz[k]! - B.oz[k]!;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > lim2 && d2 > 1e-12) {
      const s = lim / Math.sqrt(d2);
      B.ox[k] = B.px[k]! - dx * s;
      B.oy[k] = B.py[k]! - dy * s;
      B.oz[k] = B.pz[k]! - dz * s;
    }
  }
}

/** Strongest contact of the tick, used to route damage to one region. */
export function strongestHit(B: Bodies, slot: number): ContactHit {
  const b = B.base(slot);
  const n = B.count[slot]!;
  let best = -1;
  let bj = 0;
  for (let i = 0; i < n; i++) {
    const k = b + i;
    if (B.jimp[k]! > bj) {
      bj = B.jimp[k]!;
      best = i;
    }
  }
  return { node: best, region: best < 0 ? "torso" : B.regionOf(slot, best), jn: bj };
}
