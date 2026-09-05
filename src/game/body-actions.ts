import type { Actions } from "./input";
import type { Actor } from "./types";
import type { World } from "./world";
import { clamp, facing, rightOf } from "./world";
import {
  BODY,
  PhysicalBodies,
  type BodyRig,
} from "./body";

type GrabPhase = "idle" | "reach" | "hold" | "release" | "recover";
type RecoverFrom = "reach" | "release";

interface Point3 { x: number; y: number; z: number; }
interface GrabTarget { id: number; actor: boolean; }
interface GrabMotion {
  phase: GrabPhase;
  t: number;
  lastGrabbedId: number;
  recoverFrom: RecoverFrom;
  contactIssued: boolean;
  releaseQueued: boolean;
  targetId: number;
  targetActor: boolean;
  targetNode: number;
  lastContactX: number;
  lastContactY: number;
  lastContactZ: number;
}
interface KickMotion {
  active: boolean;
  t: number;
  gameplayIssued: boolean;
}

// Grab begins moving on the input edge. Latch waits only for visible hand travel.
const REACH_T = 0.2;
const RELEASE_T = 0.18;
const RECOVER_T = 0.24;
const CONTACT_RADIUS = 0.18;
const UPPER_ARM = 0.294;
const LOWER_ARM = 0.262;

// Kick begins moving immediately. The legacy gameplay kick is armed early enough
// that its existing damage window coincides with the visible foot-contact phase.
const KICK_GAMEPLAY_ARM_T = 0.055;
const KICK_CHAMBER_END = 0.1;
const KICK_DRIVE_END = 0.19;
const KICK_CONTACT_END = 0.255;
const KICK_RECOIL_END = 0.35;
const KICK_END = 0.46;
const THIGH = 0.34;
const SHIN = 0.341;

const CONTACT_NODES = [
  BODY.chest,
  BODY.lShoulder,
  BODY.rShoulder,
  BODY.lElbow,
  BODY.rElbow,
  BODY.pelvis,
] as const;

function smooth01(v: number) {
  const t = clamp(v, 0, 1);
  return t * t * (3 - 2 * t);
}
function smoother01(v: number) {
  const t = clamp(v, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function easeOut(v: number) {
  const t = clamp(v, 0, 1);
  const u = 1 - t;
  return 1 - u * u * u;
}
function mix(a: number, b: number, t: number) { return a + (b - a) * t; }
function mixPoint(a: Point3, b: Point3, t: number): Point3 {
  return { x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), z: mix(a.z, b.z, t) };
}
function distance(a: Point3, b: Point3) {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}
function isHuman(a: Actor) { return a.species === "human" || a.kind === "player"; }
function canPose(a: Actor) {
  return a.alive && a.loco !== "ragdoll" && a.loco !== "down" && a.loco !== "getup";
}
function makeMotion(): GrabMotion {
  return {
    phase: "idle", t: 0, lastGrabbedId: 0, recoverFrom: "reach",
    contactIssued: false, releaseQueued: false, targetId: 0,
    targetActor: false, targetNode: -1, lastContactX: 0,
    lastContactY: 0, lastContactZ: 0,
  };
}
function makeKickMotion(): KickMotion {
  return { active: false, t: 0, gameplayIssued: false };
}
function localPoint(a: Actor, lx: number, ly: number, lz: number): Point3 {
  const scale = a.height / 1.72;
  const f = facing(a.yaw);
  const r = rightOf(a.yaw);
  return {
    x: a.x + r.x * lx * scale + f.x * lz * scale,
    y: a.y + ly * scale,
    z: a.z + r.z * lx * scale + f.z * lz * scale,
  };
}
function setNodeWorld(rig: BodyRig, node: number, p: Point3, strength: number) {
  if (strength <= 0) return;
  rig.x[node] += (p.x - rig.x[node]!) * strength;
  rig.y[node] += (p.y - rig.y[node]!) * strength;
  rig.z[node] += (p.z - rig.z[node]!) * strength;
}
function setLocalNode(
  a: Actor, rig: BodyRig, node: number,
  lx: number, ly: number, lz: number, strength: number,
) {
  setNodeWorld(rig, node, localPoint(a, lx, ly, lz), strength);
}
function nodePoint(rig: BodyRig, node: number): Point3 {
  return { x: rig.x[node]!, y: rig.y[node]!, z: rig.z[node]! };
}

function findGrabTarget(w: World, p: Actor): GrabTarget | null {
  const f = facing(p.yaw);
  let best: GrabTarget | null = null;
  let bestD = 1.7;
  for (const o of w.nearby(p.x, p.z, 1.8)) {
    if (o.id === p.id) continue;
    const dx = o.x - p.x, dz = o.z - p.z;
    const d = Math.hypot(dx, dz);
    const dot = (dx * f.x + dz * f.z) / (d || 1);
    if (dot < 0.1 || d >= bestD) continue;
    bestD = d;
    best = { id: o.id, actor: true };
  }
  for (const pr of w.props) {
    if (pr.anchored && pr.mass > 40 && !pr.dynamic) continue;
    if (pr.kind === "wall" || pr.kind === "roof") continue;
    const dx = pr.x - p.x, dz = pr.z - p.z;
    const d = Math.hypot(dx, dz);
    const dot = (dx * f.x + dz * f.z) / (d || 1);
    if (dot < 0.05 || d > 1.7 || d >= bestD) continue;
    bestD = d;
    best = { id: pr.id, actor: false };
  }
  return best;
}

function chooseTargetNode(holder: Actor, holderRig: BodyRig, targetRig: BodyRig) {
  const f = facing(holder.yaw);
  const reference = {
    x: holderRig.x[BODY.rHand]! + f.x * 0.45,
    y: holderRig.y[BODY.rHand]! + 0.08,
    z: holderRig.z[BODY.rHand]! + f.z * 0.45,
  };
  let best = BODY.chest as number;
  let bestD = Infinity;
  for (const node of CONTACT_NODES) {
    const dx = targetRig.x[node]! - reference.x;
    const dy = targetRig.y[node]! - reference.y;
    const dz = targetRig.z[node]! - reference.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD) { bestD = d2; best = node; }
  }
  return best;
}

function targetPoint(
  w: World, bodies: PhysicalBodies, holder: Actor,
  holderRig: BodyRig, motion: GrabMotion,
): Point3 | null {
  const id = holder.grabbedId || motion.targetId;
  if (!id) return null;
  const target = w.actor(id);
  if (target) {
    const targetRig = bodies.get(target);
    if (targetRig?.initialized) {
      if (motion.targetNode < 0) motion.targetNode = chooseTargetNode(holder, holderRig, targetRig);
      const node = motion.targetNode >= 0 ? motion.targetNode : BODY.chest;
      return nodePoint(targetRig, node);
    }
    return { x: target.x, y: target.y + target.height * 0.62, z: target.z };
  }
  const pr = w.prop(id);
  if (pr) return { x: pr.x, y: pr.y + clamp(pr.sy * 0.28, 0.05, 0.38), z: pr.z };
  return null;
}
function targetMass(w: World, motion: GrabMotion, holder: Actor) {
  const id = holder.grabbedId || motion.targetId;
  if (!id) return 0;
  return w.actor(id)?.mass ?? w.prop(id)?.mass ?? 0;
}
function targetIsActor(w: World, motion: GrabMotion, holder: Actor) {
  const id = holder.grabbedId || motion.targetId;
  return Boolean(id && w.actor(id));
}

function solveTwoBone(
  rig: BodyRig,
  rootNode: number,
  jointNode: number,
  endNode: number,
  desiredEnd: Point3,
  pole: Point3,
  upperLength: number,
  lowerLength: number,
  scale: number,
  strength: number,
) {
  if (strength <= 0) return;
  const root = nodePoint(rig, rootNode);
  const upper = upperLength * scale;
  const lower = lowerLength * scale;
  let dx = desiredEnd.x - root.x;
  let dy = desiredEnd.y - root.y;
  let dz = desiredEnd.z - root.z;
  let d = Math.hypot(dx, dy, dz);
  if (d < 1e-5) return;
  const minReach = Math.abs(upper - lower) + 0.018 * scale;
  const maxReach = (upper + lower) * 0.985;
  const reach = clamp(d, minReach, maxReach);
  dx /= d; dy /= d; dz /= d;
  const end = { x: root.x + dx * reach, y: root.y + dy * reach, z: root.z + dz * reach };
  const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
  const bendRadius = Math.sqrt(Math.max(0, upper * upper - along * along));
  let px = pole.x - root.x, py = pole.y - root.y, pz = pole.z - root.z;
  const pd = px * dx + py * dy + pz * dz;
  px -= dx * pd; py -= dy * pd; pz -= dz * pd;
  let plen = Math.hypot(px, py, pz);
  if (plen < 1e-5) { px = 1; py = 0; pz = 0; plen = 1; }
  px /= plen; py /= plen; pz /= plen;
  const joint = {
    x: root.x + dx * along + px * bendRadius,
    y: root.y + dy * along + py * bendRadius,
    z: root.z + dz * along + pz * bendRadius,
  };
  setNodeWorld(rig, jointNode, joint, strength);
  setNodeWorld(rig, endNode, end, strength);
}

function solveArmIK(
  a: Actor, rig: BodyRig, side: "left" | "right",
  desiredHand: Point3, strength: number,
) {
  const sign = side === "right" ? 1 : -1;
  const shoulder = side === "right" ? BODY.rShoulder : BODY.lShoulder;
  const elbow = side === "right" ? BODY.rElbow : BODY.lElbow;
  const hand = side === "right" ? BODY.rHand : BODY.lHand;
  const pole = localPoint(a, 0.58 * sign, 0.98, 0.12);
  solveTwoBone(rig, shoulder, elbow, hand, desiredHand, pole, UPPER_ARM, LOWER_ARM, a.height / 1.72, strength);
}

function wholeBodyGrabPose(
  a: Actor, rig: BodyRig, phase: GrabPhase,
  phaseWeight: number, load: number, target: Point3,
) {
  const scale = a.height / 1.72;
  const targetLocalY = (target.y - a.y) / Math.max(0.001, scale);
  const lowReach = clamp((1.02 - targetLocalY) / 0.72, 0, 1);
  const f = facing(a.yaw);
  const forwardSpeed = a.vx * f.x + a.vz * f.z;
  const dragBack = clamp(-forwardSpeed / 3.2, 0, 1);
  let chestY = 1.2, chestZ = 0, pelvisY = 0.82, pelvisZ = 0;
  let kneeY = 0.42, kneeZ = 0, rShoulderZ = 0, lShoulderZ = 0;
  if (phase === "reach") {
    chestY -= lowReach * 0.11 * phaseWeight;
    pelvisY -= lowReach * 0.07 * phaseWeight;
    kneeY -= lowReach * 0.06 * phaseWeight;
    kneeZ += lowReach * 0.1 * phaseWeight;
    chestZ += 0.11 * phaseWeight + lowReach * 0.04 * phaseWeight;
    pelvisZ -= 0.025 * phaseWeight;
    rShoulderZ += 0.12 * phaseWeight;
    lShoulderZ -= 0.035 * phaseWeight;
  } else if (phase === "hold") {
    chestY -= 0.035 + load * 0.07;
    pelvisY -= load * 0.055;
    kneeY -= 0.035 + load * 0.065;
    kneeZ += 0.045 + load * 0.065;
    chestZ += 0.025 - load * (0.075 + dragBack * 0.06);
    pelvisZ += load * 0.035;
    rShoulderZ += 0.055; lShoulderZ += 0.035;
  } else if (phase === "release") {
    chestZ += 0.14 * phaseWeight; pelvisZ -= 0.045 * phaseWeight;
    rShoulderZ += 0.16 * phaseWeight; lShoulderZ += 0.07 * phaseWeight;
  } else if (phase === "recover") {
    chestZ += 0.1 * phaseWeight; pelvisZ -= 0.025 * phaseWeight;
    rShoulderZ += 0.1 * phaseWeight; lShoulderZ += 0.035 * phaseWeight;
  }
  const strength = phase === "hold" ? 0.7 : 0.78 * phaseWeight;
  setLocalNode(a, rig, BODY.chest, 0, chestY, chestZ, strength);
  setLocalNode(a, rig, BODY.pelvis, 0, pelvisY, pelvisZ, strength * 0.55);
  setLocalNode(a, rig, BODY.rShoulder, 0.255, chestY + 0.1, rShoulderZ, strength * 0.8);
  setLocalNode(a, rig, BODY.lShoulder, -0.255, chestY + 0.1, lShoulderZ, strength * 0.62);
  setLocalNode(a, rig, BODY.rHip, 0.14, pelvisY - 0.06, pelvisZ, strength * 0.38);
  setLocalNode(a, rig, BODY.lHip, -0.14, pelvisY - 0.06, pelvisZ, strength * 0.38);
  setLocalNode(a, rig, BODY.rKnee, 0.14, kneeY, kneeZ, strength * 0.38);
  setLocalNode(a, rig, BODY.lKnee, -0.14, kneeY, kneeZ, strength * 0.38);
}

function secondaryHandTarget(
  a: Actor, target: Point3, holdAnchor: Point3,
  actorTarget: boolean, phase: GrabPhase, q: number,
): Point3 {
  const scale = a.height / 1.72;
  const r = rightOf(a.yaw);
  if (phase === "hold") {
    return { x: holdAnchor.x - r.x * 0.22 * scale, y: holdAnchor.y + 0.035 * scale, z: holdAnchor.z - r.z * 0.22 * scale };
  }
  const offset = actorTarget ? 0.2 : 0.14;
  return { x: target.x - r.x * offset * scale * q, y: target.y - 0.035 * scale, z: target.z - r.z * offset * scale * q };
}

function applyGrabPose(
  w: World, bodies: PhysicalBodies, a: Actor, rig: BodyRig, motion: GrabMotion,
) {
  if (!canPose(a) || motion.phase === "idle") return;
  const actorTarget = targetIsActor(w, motion, a);
  const mass = targetMass(w, motion, a);
  const load = clamp((a.carry || mass * 0.45) / 72, 0, 1);
  const liveTarget = targetPoint(w, bodies, a, rig, motion);
  const target = liveTarget ?? localPoint(a, 0.08, 1.03, 0.78);
  let weight = 1;
  let rightTarget = target;
  let supportWeight = 0;
  if (motion.phase === "reach") {
    const q = easeOut(motion.t / REACH_T);
    rightTarget = mixPoint(nodePoint(rig, BODY.rHand), target, q);
    weight = q;
    supportWeight = (actorTarget || mass > 20) ? clamp((q - 0.42) / 0.58, 0, 1) * 0.76 : q * 0.14;
  } else if (motion.phase === "hold") {
    const settle = smooth01(motion.t / 0.16);
    const contact = { x: motion.lastContactX || target.x, y: motion.lastContactY || target.y, z: motion.lastContactZ || target.z };
    const holdAnchor = localPoint(a, 0.11, 1.0 - load * 0.09, 0.47 - load * 0.07);
    rightTarget = mixPoint(contact, holdAnchor, settle);
    supportWeight = actorTarget || mass > 20 ? 0.94 : 0.35;
  } else if (motion.phase === "release") {
    const q = smooth01(motion.t / RELEASE_T);
    rightTarget = mixPoint(localPoint(a, 0.11, 1.0 - load * 0.05, 0.46), localPoint(a, 0.08, 1.1, 0.93), q);
    supportWeight = (1 - q) * (actorTarget ? 0.65 : 0.25);
  } else {
    const q = 1 - smooth01(motion.t / RECOVER_T);
    rightTarget = localPoint(a, 0.08, 1.08, 0.86);
    supportWeight = q * 0.35;
    weight = q;
  }
  wholeBodyGrabPose(a, rig, motion.phase, weight, load, target);
  solveArmIK(a, rig, "right", rightTarget, 0.98 * weight);
  if (supportWeight > 0.01) {
    const holdAnchor = localPoint(a, -0.08, 1.0 - load * 0.07, 0.43 - load * 0.04);
    solveArmIK(a, rig, "left", secondaryHandTarget(a, target, holdAnchor, actorTarget, motion.phase, weight), supportWeight * weight);
  }
  if (motion.phase === "reach" || motion.phase === "hold") {
    motion.lastContactX = rightTarget.x;
    motion.lastContactY = rightTarget.y;
    motion.lastContactZ = rightTarget.z;
  }
}

function advancePassive(motion: GrabMotion, dt: number, holding: boolean) {
  if (motion.phase === "idle") return;
  motion.t += dt;
  if (motion.phase === "reach" && motion.t >= REACH_T) {
    if (holding) { motion.phase = "hold"; motion.t = 0; }
    else { motion.phase = "recover"; motion.t = 0; motion.recoverFrom = "reach"; }
  } else if (motion.phase === "release" && motion.t >= RELEASE_T) {
    motion.phase = "recover"; motion.t = 0; motion.recoverFrom = "release";
  } else if (motion.phase === "recover" && motion.t >= RECOVER_T) {
    motion.phase = "idle"; motion.t = 0;
  }
}

function applyLivingCompliance(a: Actor, rig: BodyRig) {
  if (!canPose(a) || rig.mode !== "follow" || a.grabbedId || a.grabbedBy) return;
  const speed = Math.hypot(a.vx, a.vz);
  const move = clamp(speed / 5.8, 0, 1);
  if (move < 0.03) {
    const breathe = Math.sin(a.walkPhase * 0.23 + a.id * 0.71) * 0.008;
    setLocalNode(a, rig, BODY.chest, 0, 1.2 + breathe, 0.005, 0.12);
    setLocalNode(a, rig, BODY.head, 0, 1.58 + breathe * 0.55, -0.02, 0.08);
    return;
  }
  const phase = a.walkPhase;
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const sway = s * 0.034 * move;
  const bob = Math.abs(c) * 0.025 * move;
  const twist = s * 0.055 * move;
  const lean = clamp(speed / 7, 0, 1) * 0.055;
  setLocalNode(a, rig, BODY.pelvis, sway, 0.82 + bob * 0.35, lean * 0.25, 0.22);
  setLocalNode(a, rig, BODY.chest, -sway * 0.55, 1.2 + bob, lean, 0.2);
  setLocalNode(a, rig, BODY.head, -sway * 0.25, 1.58 + bob * 0.55, lean * 0.35, 0.12);
  setLocalNode(a, rig, BODY.rShoulder, 0.27, 1.31 + bob * 0.5, twist + lean, 0.17);
  setLocalNode(a, rig, BODY.lShoulder, -0.27, 1.31 + bob * 0.5, -twist + lean, 0.17);
  setLocalNode(a, rig, BODY.rHip, 0.13 + sway * 0.35, 0.76, -twist * 0.34, 0.13);
  setLocalNode(a, rig, BODY.lHip, -0.13 + sway * 0.35, 0.76, twist * 0.34, 0.13);
  const leftLift = Math.max(0, c) * 0.055 * move;
  const rightLift = Math.max(0, -c) * 0.055 * move;
  if (leftLift > 0) {
    rig.y[BODY.lKnee] += leftLift * 0.55;
    rig.y[BODY.lFoot] += leftLift;
  }
  if (rightLift > 0) {
    rig.y[BODY.rKnee] += rightLift * 0.55;
    rig.y[BODY.rFoot] += rightLift;
  }
}

function softenModerateImpact(w: World, a: Actor, rig: BodyRig, dt: number) {
  if (a.loco !== "ragdoll" || !a.alive || !a.lastHitBy) return;
  if (w.time - a.lastHitT > dt * 1.8) return;
  const launch = Math.hypot(a.vx, a.vy, a.vz);
  const catastrophic = a.consciousness < 0.2 || a.balance < -0.12 || launch > 10.5;
  if (catastrophic) return;
  a.loco = "stumble";
  a.locoT = Math.max(a.locoT, 0.48);
  a.balance = Math.max(0.14, a.balance);
  rig.mode = "stumble";
  for (const node of [BODY.pelvis, BODY.chest, BODY.head, BODY.lFoot, BODY.rFoot]) {
    rig.x[node] += (rig.tx[node]! - rig.x[node]!) * 0.14;
    rig.y[node] += (rig.ty[node]! - rig.y[node]!) * 0.14;
    rig.z[node] += (rig.tz[node]! - rig.z[node]!) * 0.14;
  }
}

function kickPhasePoint(a: Actor, motion: KickMotion): {
  foot: Point3;
  pole: Point3;
  weight: number;
  support: number;
  hipTurn: number;
  shoulderCounter: number;
  crouch: number;
} {
  const t = motion.t;
  const restFoot = localPoint(a, 0.13, 0.08, -0.03);
  const chamberFoot = localPoint(a, 0.16, 0.46, 0.12);
  const strikeFoot = localPoint(a, 0.08, 0.57, 0.82);
  const recoilFoot = localPoint(a, 0.15, 0.39, 0.2);
  let foot = restFoot, q = 0, weight = 0, support = 0, hipTurn = 0, shoulderCounter = 0, crouch = 0;
  if (t <= KICK_CHAMBER_END) {
    q = smoother01(t / KICK_CHAMBER_END);
    foot = mixPoint(restFoot, chamberFoot, q);
    weight = q; support = q; hipTurn = q * 0.45; shoulderCounter = q * 0.32; crouch = q * 0.65;
  } else if (t <= KICK_DRIVE_END) {
    q = smoother01((t - KICK_CHAMBER_END) / (KICK_DRIVE_END - KICK_CHAMBER_END));
    foot = mixPoint(chamberFoot, strikeFoot, q);
    weight = 1; support = 1; hipTurn = mix(0.45, 1, q); shoulderCounter = mix(0.32, 0.85, q); crouch = mix(0.65, 0.3, q);
  } else if (t <= KICK_CONTACT_END) {
    q = smooth01((t - KICK_DRIVE_END) / (KICK_CONTACT_END - KICK_DRIVE_END));
    const punch = localPoint(a, 0.065, 0.575, 0.88);
    foot = mixPoint(strikeFoot, punch, q);
    weight = 1; support = 1; hipTurn = 1; shoulderCounter = 0.9; crouch = 0.22;
  } else if (t <= KICK_RECOIL_END) {
    q = smoother01((t - KICK_CONTACT_END) / (KICK_RECOIL_END - KICK_CONTACT_END));
    foot = mixPoint(strikeFoot, recoilFoot, q);
    weight = 1; support = 1 - q * 0.25; hipTurn = 1 - q * 0.65; shoulderCounter = 0.9 - q * 0.62; crouch = mix(0.22, 0.48, q);
  } else {
    q = smoother01((t - KICK_RECOIL_END) / (KICK_END - KICK_RECOIL_END));
    foot = mixPoint(recoilFoot, restFoot, q);
    weight = 1 - q; support = 0.75 * (1 - q); hipTurn = 0.35 * (1 - q); shoulderCounter = 0.28 * (1 - q); crouch = 0.48 * (1 - q);
  }
  return {
    foot,
    pole: localPoint(a, 0.13, 0.55 - crouch * 0.05, 0.38 + hipTurn * 0.08),
    weight,
    support,
    hipTurn,
    shoulderCounter,
    crouch,
  };
}

function applyKickPose(a: Actor, rig: BodyRig, motion: KickMotion) {
  if (!motion.active || !canPose(a)) return;
  const k = kickPhasePoint(a, motion);
  const w = k.weight;
  const pelvisX = -0.075 * k.support;
  const pelvisY = 0.82 - 0.075 * k.crouch;
  const pelvisZ = -0.035 * k.support;
  const chestX = 0.035 * k.support;
  const chestY = 1.2 - 0.035 * k.crouch;
  const chestZ = -0.045 * k.shoulderCounter + 0.035 * k.hipTurn;

  setLocalNode(a, rig, BODY.pelvis, pelvisX, pelvisY, pelvisZ, 0.9 * w);
  setLocalNode(a, rig, BODY.chest, chestX, chestY, chestZ, 0.78 * w);
  setLocalNode(a, rig, BODY.lHip, -0.15, pelvisY - 0.055, -0.02, 0.82 * w);
  setLocalNode(a, rig, BODY.rHip, 0.13, pelvisY - 0.05, 0.13 * k.hipTurn, 0.9 * w);
  setLocalNode(a, rig, BODY.lShoulder, -0.27, chestY + 0.11, 0.1 * k.shoulderCounter, 0.72 * w);
  setLocalNode(a, rig, BODY.rShoulder, 0.27, chestY + 0.11, -0.12 * k.shoulderCounter, 0.72 * w);

  setLocalNode(a, rig, BODY.lKnee, -0.145, 0.42 - 0.075 * k.crouch, 0.055 * k.crouch, 0.82 * k.support);
  setLocalNode(a, rig, BODY.lFoot, -0.13, 0.08, -0.03, 0.94 * k.support);

  solveTwoBone(
    rig,
    BODY.rHip,
    BODY.rKnee,
    BODY.rFoot,
    k.foot,
    k.pole,
    THIGH,
    SHIN,
    a.height / 1.72,
    0.995 * w,
  );

  setLocalNode(a, rig, BODY.lElbow, -0.34, 1.05, 0.24 * k.shoulderCounter, 0.58 * w);
  setLocalNode(a, rig, BODY.lHand, -0.38, 0.86, 0.36 * k.shoulderCounter, 0.52 * w);
  setLocalNode(a, rig, BODY.rElbow, 0.34, 1.08, -0.16 * k.shoulderCounter, 0.58 * w);
  setLocalNode(a, rig, BODY.rHand, 0.37, 0.9, -0.25 * k.shoulderCounter, 0.52 * w);
}

export class AnimatedPhysicalBodies extends PhysicalBodies {
  private motions = new Map<number, GrabMotion>();
  private kicks = new Map<number, KickMotion>();
  private playerGrabPressed = false;
  private playerGrabReleased = false;
  private playerKickPressed = false;

  captureInput(input: Actions) {
    this.playerGrabPressed ||= input.grabPressed;
    this.playerGrabReleased ||= input.grabReleased;
    this.playerKickPressed ||= input.kickPressed;
    input.grabPressed = false;
    input.grabReleased = false;
    input.kickPressed = false;
  }

  prepareInput(w: World, input: Actions, dt: number) {
    input.grabPressed = false;
    input.grabReleased = false;
    input.kickPressed = false;

    const p = w.player();
    let motion = this.motions.get(p.id);
    if (!motion) { motion = makeMotion(); this.motions.set(p.id, motion); }
    let kick = this.kicks.get(p.id);
    if (!kick) { kick = makeKickMotion(); this.kicks.set(p.id, kick); }

    if (!canPose(p)) {
      motion.phase = "idle"; motion.t = 0; motion.contactIssued = false;
      motion.releaseQueued = false; motion.targetId = 0; motion.targetNode = -1;
      kick.active = false; kick.t = 0; kick.gameplayIssued = false;
      this.playerGrabPressed = false; this.playerGrabReleased = false; this.playerKickPressed = false;
      return;
    }

    if (this.playerKickPressed) {
      this.playerKickPressed = false;
      if (!kick.active && p.grounded && !p.grabbedId && motion.phase === "idle") {
        kick.active = true;
        kick.t = 0;
        kick.gameplayIssued = false;
      }
    }
    if (kick.active) {
      kick.t += dt;
      input.moveX *= 0.45;
      input.moveY *= 0.45;
      input.sprint = false;
      if (!kick.gameplayIssued && kick.t >= KICK_GAMEPLAY_ARM_T) {
        input.kickPressed = true;
        kick.gameplayIssued = true;
      }
      if (kick.t >= KICK_END) {
        kick.active = false;
        kick.t = 0;
        kick.gameplayIssued = false;
      }
    }

    if (this.playerGrabPressed && !p.grabbedId && !kick.active) {
      this.playerGrabPressed = false;
      const target = findGrabTarget(w, p);
      // An empty-space grab has no external contact to reach for. Starting the
      // full two-hand pose anyway lets the articulated body solve against an
      // invented target and can turn a button tap into vertical motion.
      if (target) {
        motion.phase = "reach"; motion.t = 0; motion.recoverFrom = "reach";
        motion.contactIssued = false; motion.releaseQueued = false;
        motion.targetId = target.id; motion.targetActor = target.actor; motion.targetNode = -1;
      }
    }

    if (this.playerGrabReleased) {
      this.playerGrabReleased = false; this.playerGrabPressed = false;
      if (p.grabbedId) {
        input.grabReleased = true; motion.phase = "release"; motion.t = 0;
        motion.recoverFrom = "release"; motion.contactIssued = false; motion.releaseQueued = false;
      } else if (motion.phase === "reach") motion.releaseQueued = true;
    }

    if (motion.releaseQueued && motion.phase === "hold" && p.grabbedId) {
      input.grabReleased = true; motion.releaseQueued = false; motion.phase = "release";
      motion.t = 0; motion.recoverFrom = "release"; motion.contactIssued = false;
      return;
    }

    if (motion.phase === "reach") {
      motion.t = Math.min(REACH_T, motion.t + dt);
      const rig = this.get(p);
      const target = rig?.initialized ? targetPoint(w, this, p, rig, motion) : null;
      const hand = rig?.initialized ? nodePoint(rig, BODY.rHand) : null;
      const closeEnough = Boolean(target && hand && distance(hand, target) <= CONTACT_RADIUS * (p.height / 1.72));
      if (motion.targetId && closeEnough && !motion.contactIssued) {
        motion.contactIssued = true;
        motion.lastContactX = target!.x; motion.lastContactY = target!.y; motion.lastContactZ = target!.z;
        input.grabPressed = true;
      } else if (motion.t >= REACH_T && !motion.contactIssued) {
        motion.phase = "recover"; motion.t = 0; motion.recoverFrom = "reach"; motion.releaseQueued = false;
      }
    } else if (motion.phase === "hold") motion.t += dt;
    else if (motion.phase === "release") {
      motion.t += dt;
      if (motion.t >= RELEASE_T) { motion.phase = "recover"; motion.t = 0; motion.recoverFrom = "release"; }
    } else if (motion.phase === "recover") {
      motion.t += dt;
      if (motion.t >= RECOVER_T) { motion.phase = "idle"; motion.t = 0; motion.targetId = 0; motion.targetNode = -1; }
    }
  }

  override reset(a: Actor) {
    super.reset(a);
    this.motions.delete(a.id);
    this.kicks.delete(a.id);
  }
  override clear() {
    super.clear();
    this.motions.clear();
    this.kicks.clear();
    this.playerGrabPressed = false;
    this.playerGrabReleased = false;
    this.playerKickPressed = false;
  }

  override step(w: World, dt: number) {
    super.step(w, dt);
    for (const a of w.actors) {
      if (!isHuman(a)) continue;
      const rig = this.get(a);
      if (!rig?.initialized) continue;

      softenModerateImpact(w, a, rig, dt);
      applyLivingCompliance(a, rig);

      let motion = this.motions.get(a.id);
      if (!motion) { motion = makeMotion(); this.motions.set(a.id, motion); }
      const isPlayer = a.id === w.playerId;
      const grabbedNow = a.grabbedId;
      const beganHolding = grabbedNow !== 0 && motion.lastGrabbedId === 0;
      const stoppedHolding = grabbedNow === 0 && motion.lastGrabbedId !== 0;

      if (!canPose(a)) {
        motion.phase = "idle"; motion.t = 0; motion.contactIssued = false; motion.releaseQueued = false;
      } else if (isPlayer) {
        if (motion.phase === "reach" && motion.contactIssued) {
          motion.contactIssued = false;
          if (grabbedNow) {
            motion.phase = "hold"; motion.t = 0; motion.targetId = grabbedNow;
            motion.targetActor = Boolean(w.actor(grabbedNow)); motion.targetNode = -1;
          } else {
            motion.phase = "recover"; motion.t = 0; motion.recoverFrom = "reach"; motion.releaseQueued = false;
          }
        } else if (stoppedHolding && motion.phase === "hold") {
          motion.phase = "release"; motion.t = 0; motion.recoverFrom = "release"; motion.releaseQueued = false;
        }
      } else {
        if (stoppedHolding && motion.phase === "hold") {
          motion.phase = "release"; motion.t = 0; motion.recoverFrom = "release";
        } else if (beganHolding && motion.phase === "idle") {
          motion.phase = "hold"; motion.t = 0; motion.targetId = grabbedNow;
          motion.targetActor = Boolean(w.actor(grabbedNow)); motion.targetNode = -1;
        }
        advancePassive(motion, dt, Boolean(grabbedNow));
      }
      motion.lastGrabbedId = grabbedNow;
      applyGrabPose(w, this, a, rig, motion);

      const kick = this.kicks.get(a.id);
      if (kick?.active) applyKickPose(a, rig, kick);
    }
  }
}
