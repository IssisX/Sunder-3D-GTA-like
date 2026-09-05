import type { Actor, Region } from "../types";
import { injurySum } from "../world";
import { BODY_NODE_COUNT, BODY_REGIONS } from "./anatomy";

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

export function nodeVelocityComponent(
  current: number,
  previous: number,
  dt: number,
) {
  return (current - previous) / Math.max(1e-5, dt);
}

export function snapshotInjuries(a: Actor, rig: BodyRig) {
  for (let i = 0; i < BODY_REGIONS.length; i++) {
    rig.injurySnapshot[i] = injuryScore(a, BODY_REGIONS[i]!);
  }
}
