import type { Actor, Region } from "./types";
import { facing, injurySum, rightOf } from "./world";

export const BODY = {
  pelvis: 0,
  chest: 1,
  head: 2,
  lShoulder: 3,
  rShoulder: 4,
  lElbow: 5,
  rElbow: 6,
  lHand: 7,
  rHand: 8,
  lHip: 9,
  rHip: 10,
  lKnee: 11,
  rKnee: 12,
  lFoot: 13,
  rFoot: 14,
} as const;

export const BODY_NODE_COUNT = 15;

export type BodyMode = "follow" | "stumble" | "dynamic" | "recover";

export interface BodyRig {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  tx: Float32Array;
  ty: Float32Array;
  tz: Float32Array;
  impactCd: Float32Array;
  injurySnapshot: Float32Array;
  initialized: boolean;
  mode: BodyMode;
  grabNode: number;
  groundedNodes: number;
}

export const BODY_REGIONS: Region[] = [
  "head",
  "torso",
  "larm",
  "rarm",
  "lleg",
  "rleg",
];

export const NODE_REGION: readonly Region[] = [
  "torso",
  "torso",
  "head",
  "larm",
  "rarm",
  "larm",
  "rarm",
  "larm",
  "rarm",
  "lleg",
  "rleg",
  "lleg",
  "rleg",
  "lleg",
  "rleg",
];

const BASE = [
  0, 0.82, 0,
  0, 1.2, 0,
  0, 1.58, -0.02,
  -0.27, 1.31, 0,
  0.27, 1.31, 0,
  -0.36, 1.03, 0,
  0.36, 1.03, 0,
  -0.39, 0.77, 0,
  0.39, 0.77, 0,
  -0.13, 0.76, 0,
  0.13, 0.76, 0,
  -0.13, 0.42, 0,
  0.13, 0.42, 0,
  -0.13, 0.08, -0.03,
  0.13, 0.08, -0.03,
] as const;

export const BASE_RADIUS = [
  0.18,
  0.2,
  0.17,
  0.11,
  0.11,
  0.1,
  0.1,
  0.09,
  0.09,
  0.12,
  0.12,
  0.11,
  0.11,
  0.1,
  0.1,
] as const;

export const NODE_INV_MASS = [
  0.48,
  0.42,
  0.72,
  0.78,
  0.78,
  0.9,
  0.9,
  1,
  1,
  0.7,
  0.7,
  0.86,
  0.86,
  1,
  1,
] as const;

export const CONTACT_NODES = [
  BODY.pelvis,
  BODY.chest,
  BODY.head,
  BODY.lElbow,
  BODY.rElbow,
  BODY.lHand,
  BODY.rHand,
  BODY.lKnee,
  BODY.rKnee,
  BODY.lFoot,
  BODY.rFoot,
] as const;

export const GRAB_NODES = [
  BODY.lHand,
  BODY.rHand,
  BODY.lElbow,
  BODY.rElbow,
  BODY.lShoulder,
  BODY.rShoulder,
  BODY.chest,
  BODY.pelvis,
  BODY.head,
] as const;

export const SELF_PAIRS: [number, number][] = [
  [BODY.lHand, BODY.chest],
  [BODY.rHand, BODY.chest],
  [BODY.lHand, BODY.pelvis],
  [BODY.rHand, BODY.pelvis],
  [BODY.lFoot, BODY.chest],
  [BODY.rFoot, BODY.chest],
  [BODY.lFoot, BODY.head],
  [BODY.rFoot, BODY.head],
  [BODY.lKnee, BODY.chest],
  [BODY.rKnee, BODY.chest],
];

function basePoint(i: number) {
  const o = i * 3;
  return {
    x: BASE[o]!,
    y: BASE[o + 1]!,
    z: BASE[o + 2]!,
  };
}

function baseDistance(a: number, b: number) {
  const pa = basePoint(a);
  const pb = basePoint(b);
  return Math.hypot(
    pb.x - pa.x,
    pb.y - pa.y,
    pb.z - pa.z,
  );
}

const LINK_PAIRS: [number, number][] = [
  [BODY.pelvis, BODY.chest],
  [BODY.chest, BODY.head],
  [BODY.chest, BODY.lShoulder],
  [BODY.chest, BODY.rShoulder],
  [BODY.lShoulder, BODY.rShoulder],
  [BODY.lShoulder, BODY.lElbow],
  [BODY.lElbow, BODY.lHand],
  [BODY.rShoulder, BODY.rElbow],
  [BODY.rElbow, BODY.rHand],
  [BODY.pelvis, BODY.lHip],
  [BODY.pelvis, BODY.rHip],
  [BODY.lHip, BODY.rHip],
  [BODY.lHip, BODY.lKnee],
  [BODY.lKnee, BODY.lFoot],
  [BODY.rHip, BODY.rKnee],
  [BODY.rKnee, BODY.rFoot],
  [BODY.chest, BODY.lHip],
  [BODY.chest, BODY.rHip],
  [BODY.pelvis, BODY.lShoulder],
  [BODY.pelvis, BODY.rShoulder],
  [BODY.head, BODY.lShoulder],
  [BODY.head, BODY.rShoulder],
];

export const LINK_DEFS: [number, number, number][] =
  LINK_PAIRS.map(
    ([a, b]) => [a, b, baseDistance(a, b)] as [
      number,
      number,
      number,
    ],
  );

export const LINK_STIFFNESS = [
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  0.88,
  0.88,
  0.86,
  0.86,
  0.82,
  0.82,
] as const;

export const JOINT_RANGES: [
  number,
  number,
  number,
  number,
][] = [
  [BODY.lShoulder, BODY.lHand, 0.3, 0.57],
  [BODY.rShoulder, BODY.rHand, 0.3, 0.57],
  [BODY.lHip, BODY.lFoot, 0.36, 0.67],
  [BODY.rHip, BODY.rFoot, 0.36, 0.67],
];

export function makeRig(): BodyRig {
  return {
    x: new Float32Array(BODY_NODE_COUNT),
    y: new Float32Array(BODY_NODE_COUNT),
    z: new Float32Array(BODY_NODE_COUNT),
    px: new Float32Array(BODY_NODE_COUNT),
    py: new Float32Array(BODY_NODE_COUNT),
    pz: new Float32Array(BODY_NODE_COUNT),
    tx: new Float32Array(BODY_NODE_COUNT),
    ty: new Float32Array(BODY_NODE_COUNT),
    tz: new Float32Array(BODY_NODE_COUNT),
    impactCd: new Float32Array(BODY_NODE_COUNT),
    injurySnapshot: new Float32Array(BODY_REGIONS.length),
    initialized: false,
    mode: "follow",
    grabNode: -1,
    groundedNodes: 0,
  };
}

export function bodyScale(a: Actor) {
  return a.height / 1.72;
}

export function bodyMode(a: Actor): BodyMode {
  if (
    a.grabbedBy ||
    a.loco === "ragdoll" ||
    a.loco === "down" ||
    !a.alive
  ) {
    return "dynamic";
  }
  if (a.loco === "getup") return "recover";
  if (a.loco === "stumble") return "stumble";
  return "follow";
}

export function injuryScore(a: Actor, region: Region) {
  return injurySum(a.injuries[region]);
}

export function representativeNode(region: Region) {
  switch (region) {
    case "head":
      return BODY.head;
    case "larm":
      return BODY.lElbow;
    case "rarm":
      return BODY.rElbow;
    case "lleg":
      return BODY.lKnee;
    case "rleg":
      return BODY.rKnee;
    default:
      return BODY.chest;
  }
}

export function computeTarget(
  a: Actor,
  rig: BodyRig,
  floorY = a.y,
) {
  const scale = bodyScale(a);
  const f = facing(a.yaw);
  const r = rightOf(a.yaw);
  const speed = Math.hypot(a.vx, a.vz);
  const stride = Math.min(0.34, speed * 0.055) * scale;
  const legSwing = Math.sin(a.walkPhase) * stride;
  const armSwing =
    Math.sin(a.walkPhase + Math.PI) * stride * 0.75;

  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    const o = i * 3;
    const lx = BASE[o]! * scale;
    let ly = BASE[o + 1]! * scale;
    let lz = BASE[o + 2]! * scale;

    if (a.crouch) {
      if (
        i === BODY.pelvis ||
        i === BODY.lHip ||
        i === BODY.rHip
      ) {
        ly -= 0.18 * scale;
      }
      if (
        i === BODY.chest ||
        i === BODY.head ||
        i === BODY.lShoulder ||
        i === BODY.rShoulder
      ) {
        ly -= 0.28 * scale;
        lz += 0.12 * scale;
      }
      if (i === BODY.lKnee || i === BODY.rKnee) {
        ly -= 0.08 * scale;
        lz += 0.16 * scale;
      }
    }

    if (i === BODY.lKnee) lz += legSwing * 0.5;
    else if (i === BODY.lFoot) lz += legSwing;
    else if (i === BODY.rKnee) lz -= legSwing * 0.5;
    else if (i === BODY.rFoot) lz -= legSwing;
    else if (i === BODY.lElbow) lz += armSwing * 0.45;
    else if (i === BODY.lHand) lz += armSwing;
    else if (i === BODY.rElbow) lz -= armSwing * 0.45;
    else if (i === BODY.rHand) lz -= armSwing;

    if (
      a.strikeT > 0 &&
      (i === BODY.rElbow || i === BODY.rHand)
    ) {
      lz +=
        (i === BODY.rHand ? 0.48 : 0.24) * scale;
      ly +=
        (i === BODY.rHand ? 0.08 : 0.04) * scale;
    }
    if (
      a.kickT > 0 &&
      (i === BODY.rKnee || i === BODY.rFoot)
    ) {
      lz +=
        (i === BODY.rFoot ? 0.58 : 0.28) * scale;
      ly +=
        (i === BODY.rFoot ? 0.18 : 0.08) * scale;
    }

    rig.tx[i] = a.x + r.x * lx + f.x * lz;
    rig.ty[i] = floorY + ly;
    rig.tz[i] = a.z + r.z * lx + f.z * lz;
  }
}

export function resetRig(a: Actor, rig: BodyRig) {
  computeTarget(a, rig, a.y);
  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    rig.x[i] = rig.px[i] = rig.tx[i]!;
    rig.y[i] = rig.py[i] = rig.ty[i]!;
    rig.z[i] = rig.pz[i] = rig.tz[i]!;
    rig.impactCd[i] = 0;
  }
  snapshotInjuries(a, rig);
  rig.initialized = true;
  rig.mode = bodyMode(a);
  rig.grabNode = -1;
  rig.groundedNodes = 0;
}

export function nodeRadius(a: Actor, i: number) {
  return BASE_RADIUS[i]! * bodyScale(a);
}

export function nodeVelocityComponent(
  current: number,
  previous: number,
  dt: number,
) {
  return (current - previous) / Math.max(1e-5, dt);
}

export function snapshotInjuries(
  a: Actor,
  rig: BodyRig,
) {
  for (let i = 0; i < BODY_REGIONS.length; i++) {
    rig.injurySnapshot[i] = injuryScore(
      a,
      BODY_REGIONS[i]!,
    );
  }
}
