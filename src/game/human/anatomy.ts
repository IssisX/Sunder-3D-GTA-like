import type { Actor, Region } from "../types";

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

/** Canonical local-space humanoid rest geometry at 1.72 m stature. */
export const HUMAN_BASE_POSE = [
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

function baseDistance(a: number, b: number) {
  const ao = a * 3;
  const bo = b * 3;
  return Math.hypot(
    HUMAN_BASE_POSE[bo]! - HUMAN_BASE_POSE[ao]!,
    HUMAN_BASE_POSE[bo + 1]! - HUMAN_BASE_POSE[ao + 1]!,
    HUMAN_BASE_POSE[bo + 2]! - HUMAN_BASE_POSE[ao + 2]!,
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

export const LINK_DEFS: [number, number, number][] = LINK_PAIRS.map(
  ([a, b]) => [a, b, baseDistance(a, b)] as [number, number, number],
);

export const LINK_STIFFNESS = [
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1,
  0.88, 0.88, 0.86, 0.86, 0.82, 0.82,
] as const;

export const JOINT_RANGES: [number, number, number, number][] = [
  [BODY.lShoulder, BODY.lHand, 0.3, 0.57],
  [BODY.rShoulder, BODY.rHand, 0.3, 0.57],
  [BODY.lHip, BODY.lFoot, 0.36, 0.67],
  [BODY.rHip, BODY.rFoot, 0.36, 0.67],
];

export function bodyScale(a: Actor) {
  return a.height / 1.72;
}

export function nodeRadius(a: Actor, node: number) {
  return BASE_RADIUS[node]! * bodyScale(a);
}

export function representativeNode(region: Region) {
  switch (region) {
    case "head": return BODY.head;
    case "larm": return BODY.lElbow;
    case "rarm": return BODY.rElbow;
    case "lleg": return BODY.lKnee;
    case "rleg": return BODY.rKnee;
    default: return BODY.chest;
  }
}
