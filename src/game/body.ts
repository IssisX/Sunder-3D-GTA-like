import type { Actor, Collider, Region } from "./types";
import { GRAVITY } from "./types";
import type { World } from "./world";
import { clamp, facing, injurySum, rightOf } from "./world";

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

const REGIONS: Region[] = ["head", "torso", "larm", "rarm", "lleg", "rleg"];

const NODE_REGION: Region[] = [
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

const BASE_RADIUS = [
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

const NODE_INV_MASS = [
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

const CONTACT_NODES = [
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

const GRAB_NODES = [
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

const SELF_PAIRS: [number, number][] = [
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
  return { x: BASE[o]!, y: BASE[o + 1]!, z: BASE[o + 2]! };
}

function baseDistance(a: number, b: number) {
  const pa = basePoint(a);
  const pb = basePoint(b);
  return Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
}

const LINK_DEFS: [number, number, number][] = [
  [BODY.pelvis, BODY.chest, 1],
  [BODY.chest, BODY.head, 1],
  [BODY.chest, BODY.lShoulder, 1],
  [BODY.chest, BODY.rShoulder, 1],
  [BODY.lShoulder, BODY.rShoulder, 1],
  [BODY.lShoulder, BODY.lElbow, 1],
  [BODY.lElbow, BODY.lHand, 1],
  [BODY.rShoulder, BODY.rElbow, 1],
  [BODY.rElbow, BODY.rHand, 1],
  [BODY.pelvis, BODY.lHip, 1],
  [BODY.pelvis, BODY.rHip, 1],
  [BODY.lHip, BODY.rHip, 1],
  [BODY.lHip, BODY.lKnee, 1],
  [BODY.lKnee, BODY.lFoot, 1],
  [BODY.rHip, BODY.rKnee, 1],
  [BODY.rKnee, BODY.rFoot, 1],
  [BODY.chest, BODY.lHip, 0.9],
  [BODY.chest, BODY.rHip, 0.9],
  [BODY.pelvis, BODY.lShoulder, 0.9],
  [BODY.pelvis, BODY.rShoulder, 0.9],
  [BODY.head, BODY.lShoulder, 0.82],
  [BODY.head, BODY.rShoulder, 0.82],
].map(([a, b, stiffness]) => [a, b, baseDistance(a, b) * stiffness / stiffness]);

const LINK_STIFFNESS = [
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

const JOINT_RANGES: [number, number, number, number][] = [
  [BODY.lShoulder, BODY.lHand, 0.3, 0.57],
  [BODY.rShoulder, BODY.rHand, 0.3, 0.57],
  [BODY.lHip, BODY.lFoot, 0.36, 0.67],
  [BODY.rHip, BODY.rFoot, 0.36, 0.67],
];

function makeRig(): BodyRig {
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
    injurySnapshot: new Float32Array(REGIONS.length),
    initialized: false,
    mode: "follow",
    grabNode: -1,
    groundedNodes: 0,
  };
}

function bodyScale(a: Actor) {
  return a.height / 1.72;
}

function bodyMode(a: Actor): BodyMode {
  if (a.grabbedBy || a.loco === "ragdoll" || a.loco === "down" || !a.alive) {
    return "dynamic";
  }
  if (a.loco === "getup") return "recover";
  if (a.loco === "stumble") return "stumble";
  return "follow";
}

function injuryScore(a: Actor, r: Region) {
  return injurySum(a.injuries[r]);
}

function representativeNode(r: Region) {
  switch (r) {
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

function computeTarget(a: Actor, rig: BodyRig, floorY = a.y) {
  const scale = bodyScale(a);
  const f = facing(a.yaw);
  const r = rightOf(a.yaw);
  const speed = Math.hypot(a.vx, a.vz);
  const phase = a.walkPhase;
  const stride = Math.min(0.34, speed * 0.055) * scale;
  const legSwing = Math.sin(phase) * stride;
  const armSwing = Math.sin(phase + Math.PI) * stride * 0.75;
  const crouch = a.crouch ? 1 : 0;

  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    const o = i * 3;
    let lx = BASE[o]! * scale;
    let ly = BASE[o + 1]! * scale;
    let lz = BASE[o + 2]! * scale;

    if (crouch) {
      if (i === BODY.pelvis || i === BODY.lHip || i === BODY.rHip) ly -= 0.18 * scale;
      if (i === BODY.chest || i === BODY.head || i === BODY.lShoulder || i === BODY.rShoulder) {
        ly -= 0.28 * scale;
        lz += 0.12 * scale;
      }
      if (i === BODY.lKnee || i === BODY.rKnee) {
        ly -= 0.08 * scale;
        lz += 0.16 * scale;
      }
    }

    if (i === BODY.lKnee) lz += legSwing * 0.5;
    if (i === BODY.lFoot) lz += legSwing;
    if (i === BODY.rKnee) lz -= legSwing * 0.5;
    if (i === BODY.rFoot) lz -= legSwing;
    if (i === BODY.lElbow) lz += armSwing * 0.45;
    if (i === BODY.lHand) lz += armSwing;
    if (i === BODY.rElbow) lz -= armSwing * 0.45;
    if (i === BODY.rHand) lz -= armSwing;

    if (a.strikeT > 0 && (i === BODY.rElbow || i === BODY.rHand)) {
      lz += (i === BODY.rHand ? 0.48 : 0.24) * scale;
      ly += (i === BODY.rHand ? 0.08 : 0.04) * scale;
    }
    if (a.kickT > 0 && (i === BODY.rKnee || i === BODY.rFoot)) {
      lz += (i === BODY.rFoot ? 0.58 : 0.28) * scale;
      ly += (i === BODY.rFoot ? 0.18 : 0.08) * scale;
    }

    rig.tx[i] = a.x + r.x * lx + f.x * lz;
    rig.ty[i] = floorY + ly;
    rig.tz[i] = a.z + r.z * lx + f.z * lz;
  }
}

function resetRig(a: Actor, rig: BodyRig) {
  computeTarget(a, rig, a.y);
  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    const x = rig.tx[i]!;
    const y = rig.ty[i]!;
    const z = rig.tz[i]!;
    rig.x[i] = rig.px[i] = x;
    rig.y[i] = rig.py[i] = y;
    rig.z[i] = rig.pz[i] = z;
    rig.impactCd[i] = 0;
  }
  for (let i = 0; i < REGIONS.length; i++) {
    rig.injurySnapshot[i] = injuryScore(a, REGIONS[i]!);
  }
  rig.initialized = true;
  rig.mode = bodyMode(a);
  rig.grabNode = -1;
  rig.groundedNodes = 0;
}

function solveDistance(rig: BodyRig, ia: number, ib: number, rest: number, stiffness: number, scale: number) {
  const dx = rig.x[ib]! - rig.x[ia]!;
  const dy = rig.y[ib]! - rig.y[ia]!;
  const dz = rig.z[ib]! - rig.z[ia]!;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < 1e-10) return;
  const d = Math.sqrt(d2);
  const err = d - rest * scale;
  const wa = NODE_INV_MASS[ia]!;
  const wb = NODE_INV_MASS[ib]!;
  const sum = wa + wb;
  if (sum <= 0) return;
  const corr = (err / d) * stiffness;
  const ax = dx * corr * (wa / sum);
  const ay = dy * corr * (wa / sum);
  const az = dz * corr * (wa / sum);
  const bx = dx * corr * (wb / sum);
  const by = dy * corr * (wb / sum);
  const bz = dz * corr * (wb / sum);
  rig.x[ia] += ax;
  rig.y[ia] += ay;
  rig.z[ia] += az;
  rig.x[ib] -= bx;
  rig.y[ib] -= by;
  rig.z[ib] -= bz;
}

function solveRange(rig: BodyRig, ia: number, ib: number, min: number, max: number, scale: number) {
  const dx = rig.x[ib]! - rig.x[ia]!;
  const dy = rig.y[ib]! - rig.y[ia]!;
  const dz = rig.z[ib]! - rig.z[ia]!;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < 1e-10) return;
  const d = Math.sqrt(d2);
  const lo = min * scale;
  const hi = max * scale;
  const target = d < lo ? lo : d > hi ? hi : d;
  if (target === d) return;
  const wa = NODE_INV_MASS[ia]!;
  const wb = NODE_INV_MASS[ib]!;
  const sum = wa + wb;
  const corr = (d - target) / d;
  rig.x[ia] += dx * corr * (wa / sum);
  rig.y[ia] += dy * corr * (wa / sum);
  rig.z[ia] += dz * corr * (wa / sum);
  rig.x[ib] -= dx * corr * (wb / sum);
  rig.y[ib] -= dy * corr * (wb / sum);
  rig.z[ib] -= dz * corr * (wb / sum);
}

function pinNode(rig: BodyRig, i: number, strength: number) {
  rig.x[i] += (rig.tx[i]! - rig.x[i]!) * strength;
  rig.y[i] += (rig.ty[i]! - rig.y[i]!) * strength;
  rig.z[i] += (rig.tz[i]! - rig.z[i]!) * strength;
}

function closestGrabNode(rig: BodyRig, x: number, y: number, z: number) {
  let best = BODY.chest;
  let bestD = Infinity;
  for (const i of GRAB_NODES) {
    const dx = rig.x[i]! - x;
    const dy = rig.y[i]! - y;
    const dz = rig.z[i]! - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function supportHeight(w: World, x: number, z: number) {
  let h = 0;
  for (const c of w.colliders) {
    if (!c.solid || c.water) continue;
    if (x < c.minX - 0.2 || x > c.maxX + 0.2 || z < c.minZ - 0.2 || z > c.maxZ + 0.2) continue;
    h = Math.max(h, c.maxY);
  }
  return h;
}

function modeWeight(mode: BodyMode) {
  if (mode === "dynamic") return 1;
  if (mode === "stumble") return 0.62;
  if (mode === "recover") return 0.4;
  return 0;
}

function nodeRadius(a: Actor, i: number) {
  return BASE_RADIUS[i]! * bodyScale(a);
}

function nodeVelocity(rig: BodyRig, i: number, dt: number) {
  const invDt = 1 / Math.max(1e-5, dt);
  return {
    x: (rig.x[i]! - rig.px[i]!) * invDt,
    y: (rig.y[i]! - rig.py[i]!) * invDt,
    z: (rig.z[i]! - rig.pz[i]!) * invDt,
  };
}

function applyImpact(w: World, a: Actor, rig: BodyRig, node: number, speed: number) {
  if (!a.alive || speed < 3.2 || rig.impactCd[node]! > 0) return;
  const region = NODE_REGION[node]!;
  const excess = speed - 3.2;
  const severity = clamp(excess * excess * 0.018 * (a.mass / 78), 0, 1.4);
  if (severity < 0.025) return;
  const inj = a.injuries[region];
  inj.bruise += severity * 0.36;
  if (region === "larm" || region === "rarm" || region === "lleg" || region === "rleg") {
    if (speed > 5.4) inj.sprain += severity * 0.1;
    if (speed > 8.2) inj.fracture += severity * 0.08;
  } else if (region === "head") {
    a.consciousness = Math.max(0, a.consciousness - severity * 0.16);
    if (speed > 8.5) inj.fracture += severity * 0.06;
  } else if (speed > 9.5) {
    inj.fracture += severity * 0.04;
  }
  a.pain = clamp(a.pain + severity * 0.18, 0, 1);
  a.balance = clamp(a.balance - severity * 0.28, 0, 1);
  if (speed > 6.6 && a.loco !== "ragdoll" && a.loco !== "down") {
    a.loco = speed > 9 || region === "head" ? "ragdoll" : "stumble";
    a.locoT = Math.max(a.locoT, 0.45 + severity * 0.35);
  }
  rig.impactCd[node] = 0.16;
  w.emitSound(a.x, a.z, 0.3 + Math.min(0.7, severity * 0.45), "impact", a.id);
  if (severity > 0.2 && (a.kind === "human" || a.kind === "player")) {
    w.emitSound(a.x, a.z, 0.24 + severity * 0.2, "hurt", a.id);
  }
  w.shake = Math.max(w.shake, Math.min(0.5, severity * 0.24));
}

function resolveNodeAabb(
  w: World,
  a: Actor,
  rig: BodyRig,
  node: number,
  c: Collider,
  dt: number,
  registerImpact: boolean,
) {
  const radius = nodeRadius(a, node);
  const x = rig.x[node]!;
  const y = rig.y[node]!;
  const z = rig.z[node]!;
  const qx = clamp(x, c.minX, c.maxX);
  const qy = clamp(y, c.minY, c.maxY);
  const qz = clamp(z, c.minZ, c.maxZ);
  let nx = x - qx;
  let ny = y - qy;
  let nz = z - qz;
  let d2 = nx * nx + ny * ny + nz * nz;
  if (d2 >= radius * radius) return false;

  if (d2 < 1e-10) {
    const dl = Math.abs(x - c.minX);
    const dr = Math.abs(c.maxX - x);
    const db = Math.abs(y - c.minY);
    const dtp = Math.abs(c.maxY - y);
    const ds = Math.abs(z - c.minZ);
    const dn = Math.abs(c.maxZ - z);
    const m = Math.min(dl, dr, db, dtp, ds, dn);
    if (m === dl) {
      nx = -1;
      ny = 0;
      nz = 0;
    } else if (m === dr) {
      nx = 1;
      ny = 0;
      nz = 0;
    } else if (m === db) {
      nx = 0;
      ny = -1;
      nz = 0;
    } else if (m === dtp) {
      nx = 0;
      ny = 1;
      nz = 0;
    } else if (m === ds) {
      nx = 0;
      ny = 0;
      nz = -1;
    } else {
      nx = 0;
      ny = 0;
      nz = 1;
    }
    d2 = 0;
  } else {
    const inv = 1 / Math.sqrt(d2);
    nx *= inv;
    ny *= inv;
    nz *= inv;
  }

  const v = nodeVelocity(rig, node, dt);
  const vn = v.x * nx + v.y * ny + v.z * nz;
  if (registerImpact && vn < -3.2) applyImpact(w, a, rig, node, -vn);

  const penetration = d2 < 1e-10 ? radius + 0.002 : radius - Math.sqrt(d2) + 0.002;
  rig.x[node] += nx * penetration;
  rig.y[node] += ny * penetration;
  rig.z[node] += nz * penetration;

  if (vn < 0) {
    const bounce = 0.08;
    const rvx = v.x - nx * vn * (1 + bounce);
    const rvy = v.y - ny * vn * (1 + bounce);
    const rvz = v.z - nz * vn * (1 + bounce);
    const friction = 0.78;
    rig.px[node] = rig.x[node]! - rvx * dt * friction;
    rig.py[node] = rig.y[node]! - rvy * dt * friction;
    rig.pz[node] = rig.z[node]! - rvz * dt * friction;
  }
  if (ny > 0.45) rig.groundedNodes++;
  return true;
}

function collideRig(w: World, a: Actor, rig: BodyRig, dt: number, registerImpact: boolean) {
  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    const radius = nodeRadius(a, i);
    if (rig.y[i]! < radius) {
      const vy = (rig.y[i]! - rig.py[i]!) / Math.max(dt, 1e-5);
      if (registerImpact && vy < -3.2) applyImpact(w, a, rig, i, -vy);
      rig.y[i] = radius;
      if (vy < 0) {
        rig.py[i] = rig.y[i]! + vy * dt * 0.08;
        rig.px[i] += (rig.x[i]! - rig.px[i]!) * 0.2;
        rig.pz[i] += (rig.z[i]! - rig.pz[i]!) * 0.2;
      }
      rig.groundedNodes++;
    }
    for (const c of w.colliders) {
      if (!c.solid || c.water) continue;
      if (
        rig.x[i]! < c.minX - radius ||
        rig.x[i]! > c.maxX + radius ||
        rig.y[i]! < c.minY - radius ||
        rig.y[i]! > c.maxY + radius ||
        rig.z[i]! < c.minZ - radius ||
        rig.z[i]! > c.maxZ + radius
      ) {
        continue;
      }
      resolveNodeAabb(w, a, rig, i, c, dt, registerImpact);
    }
  }
}

function solveSelfContacts(a: Actor, rig: BodyRig) {
  const scale = bodyScale(a);
  for (const [ia, ib] of SELF_PAIRS) {
    const dx = rig.x[ib]! - rig.x[ia]!;
    const dy = rig.y[ib]! - rig.y[ia]!;
    const dz = rig.z[ib]! - rig.z[ia]!;
    const min = (BASE_RADIUS[ia]! + BASE_RADIUS[ib]!) * scale * 0.88;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= min * min || d2 < 1e-10) continue;
    const d = Math.sqrt(d2);
    const pen = min - d;
    const nx = dx / d;
    const ny = dy / d;
    const nz = dz / d;
    const wa = NODE_INV_MASS[ia]!;
    const wb = NODE_INV_MASS[ib]!;
    const sum = wa + wb;
    rig.x[ia] -= nx * pen * (wa / sum);
    rig.y[ia] -= ny * pen * (wa / sum);
    rig.z[ia] -= nz * pen * (wa / sum);
    rig.x[ib] += nx * pen * (wb / sum);
    rig.y[ib] += ny * pen * (wb / sum);
    rig.z[ib] += nz * pen * (wb / sum);
  }
}

function holderHandTarget(w: World, holder: Actor, getRig: (a: Actor) => BodyRig | undefined) {
  const rig = getRig(holder);
  if (rig?.initialized) {
    return {
      x: rig.x[BODY.rHand]!,
      y: rig.y[BODY.rHand]!,
      z: rig.z[BODY.rHand]!,
    };
  }
  const f = facing(holder.yaw);
  return {
    x: holder.x + f.x * 0.5,
    y: holder.y + holder.height * 0.65,
    z: holder.z + f.z * 0.5,
  };
}

function solveGrab(
  w: World,
  a: Actor,
  rig: BodyRig,
  getRig: (a: Actor) => BodyRig | undefined,
  strength: number,
) {
  if (!a.grabbedBy) {
    rig.grabNode = -1;
    return;
  }
  const holder = w.actor(a.grabbedBy);
  if (!holder) {
    a.grabbedBy = 0;
    rig.grabNode = -1;
    return;
  }
  const target = holderHandTarget(w, holder, getRig);
  if (rig.grabNode < 0) {
    rig.grabNode = closestGrabNode(rig, target.x, target.y, target.z);
  }
  const i = rig.grabNode;
  const dx = target.x - rig.x[i]!;
  const dy = target.y - rig.y[i]!;
  const dz = target.z - rig.z[i]!;
  const d = Math.hypot(dx, dy, dz);
  const k = d > 1.1 ? Math.min(1, strength * 1.2) : strength;
  rig.x[i] += dx * k;
  rig.y[i] += dy * k;
  rig.z[i] += dz * k;

  if (d > 0.5) {
    const load = a.mass / Math.max(1, a.mass + holder.mass);
    holder.balance = clamp(holder.balance - Math.min(0.04, d * load * 0.012), 0, 1);
    holder.vx -= dx * load * 0.03;
    holder.vz -= dz * load * 0.03;
  }
}

function solveLinks(a: Actor, rig: BodyRig, stiffness = 1) {
  const scale = bodyScale(a);
  for (let i = 0; i < LINK_DEFS.length; i++) {
    const [ia, ib, rest] = LINK_DEFS[i]!;
    solveDistance(rig, ia, ib, rest, LINK_STIFFNESS[i]! * stiffness, scale);
  }
  for (const [ia, ib, min, max] of JOINT_RANGES) {
    solveRange(rig, ia, ib, min, max, scale);
  }
}

function injectExternalImpulse(w: World, a: Actor, rig: BodyRig, dt: number) {
  const p = BODY.pelvis;
  const rvx = (rig.x[p]! - rig.px[p]!) / Math.max(dt, 1e-5);
  const rvy = (rig.y[p]! - rig.py[p]!) / Math.max(dt, 1e-5);
  const rvz = (rig.z[p]! - rig.pz[p]!) / Math.max(dt, 1e-5);
  let dvx = a.vx - rvx;
  let dvy = a.vy - rvy;
  let dvz = a.vz - rvz;
  const mag = Math.hypot(dvx, dvy, dvz);
  if (mag < 1.15) return;
  const cap = Math.min(18, mag);
  const inv = cap / mag;
  dvx *= inv;
  dvy *= inv;
  dvz *= inv;

  let bestRegion = -1;
  let bestDelta = 0;
  for (let i = 0; i < REGIONS.length; i++) {
    const now = injuryScore(a, REGIONS[i]!);
    const delta = now - rig.injurySnapshot[i]!;
    if (delta > bestDelta) {
      bestDelta = delta;
      bestRegion = i;
    }
  }

  if (a.lastHitBy && w.time - a.lastHitT < dt * 1.6 && bestRegion >= 0) {
    const node = representativeNode(REGIONS[bestRegion]!);
    rig.px[node] -= dvx * dt * 0.85;
    rig.py[node] -= dvy * dt * 0.85;
    rig.pz[node] -= dvz * dt * 0.85;
    rig.px[BODY.chest] -= dvx * dt * 0.18;
    rig.py[BODY.chest] -= dvy * dt * 0.18;
    rig.pz[BODY.chest] -= dvz * dt * 0.18;
    return;
  }

  const gain = a.grabbedBy ? 0.18 : 0.42;
  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    rig.px[i] -= dvx * dt * gain;
    rig.py[i] -= dvy * dt * gain;
    rig.pz[i] -= dvz * dt * gain;
  }
}

function snapshotInjuries(a: Actor, rig: BodyRig) {
  for (let i = 0; i < REGIONS.length; i++) {
    rig.injurySnapshot[i] = injuryScore(a, REGIONS[i]!);
  }
}

function integrateDynamic(w: World, a: Actor, rig: BodyRig, dt: number, mode: BodyMode) {
  const damp = mode === "dynamic" ? 0.988 : mode === "stumble" ? 0.965 : 0.955;
  const gravity = mode === "recover" ? GRAVITY * 0.55 : mode === "stumble" ? GRAVITY * 0.78 : GRAVITY;
  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    const x = rig.x[i]!;
    const y = rig.y[i]!;
    const z = rig.z[i]!;
    let vx = (x - rig.px[i]!) * damp;
    let vy = (y - rig.py[i]!) * damp;
    let vz = (z - rig.pz[i]!) * damp;
    const water = w.inWater(x, z, y);
    if (water) {
      vx *= 0.82;
      vy *= 0.82;
      vz *= 0.82;
      vy += 4.2 * dt * dt;
    }
    rig.px[i] = x;
    rig.py[i] = y;
    rig.pz[i] = z;
    rig.x[i] = x + vx;
    rig.y[i] = y + vy - gravity * dt * dt;
    rig.z[i] = z + vz;
  }
}

function followPose(a: Actor, rig: BodyRig, dt: number) {
  computeTarget(a, rig, a.y);
  const k = 1 - Math.exp(-dt * 34);
  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    const x = rig.x[i]!;
    const y = rig.y[i]!;
    const z = rig.z[i]!;
    rig.px[i] = x;
    rig.py[i] = y;
    rig.pz[i] = z;
    rig.x[i] = x + (rig.tx[i]! - x) * k;
    rig.y[i] = y + (rig.ty[i]! - y) * k;
    rig.z[i] = z + (rig.tz[i]! - z) * k;
  }
}

function deriveActorFromRig(w: World, a: Actor, rig: BodyRig, dt: number) {
  const p = BODY.pelvis;
  const oldX = a.x;
  const oldY = a.y;
  const oldZ = a.z;
  const feet = Math.min(
    rig.y[BODY.lFoot]! - nodeRadius(a, BODY.lFoot),
    rig.y[BODY.rFoot]! - nodeRadius(a, BODY.rFoot),
    rig.y[BODY.pelvis]! - 0.78 * bodyScale(a),
  );
  a.x = rig.x[p]!;
  a.z = rig.z[p]!;
  a.y = Math.max(0, feet);
  a.vx = (a.x - oldX) / Math.max(dt, 1e-5);
  a.vy = (a.y - oldY) / Math.max(dt, 1e-5);
  a.vz = (a.z - oldZ) / Math.max(dt, 1e-5);
  a.grounded = rig.groundedNodes > 0;

  const torsoRise = rig.y[BODY.chest]! - rig.y[BODY.pelvis]!;
  const torsoLean = Math.hypot(
    rig.x[BODY.chest]! - rig.x[BODY.pelvis]!,
    rig.z[BODY.chest]! - rig.z[BODY.pelvis]!,
  );
  if (rig.mode === "dynamic") {
    const posture = clamp((torsoRise - 0.05) / 0.42, 0, 1) * clamp(1 - torsoLean / 0.8, 0, 1);
    a.balance = Math.min(a.balance, posture);
  }

  a.x = clamp(a.x, -43, 43);
  a.z = clamp(a.z, -43, 43);
  void w;
}

function solveBodyPair(w: World, a: Actor, ra: BodyRig, b: Actor, rb: BodyRig, dt: number, register: boolean) {
  const rootDx = rb.x[BODY.pelvis]! - ra.x[BODY.pelvis]!;
  const rootDz = rb.z[BODY.pelvis]! - ra.z[BODY.pelvis]!;
  if (rootDx * rootDx + rootDz * rootDz > 10.5) return;
  const modeA = modeWeight(ra.mode);
  const modeB = modeWeight(rb.mode);
  if (modeA + modeB <= 0) return;

  for (const ia of CONTACT_NODES) {
    for (const ib of CONTACT_NODES) {
      const dx = rb.x[ib]! - ra.x[ia]!;
      const dy = rb.y[ib]! - ra.y[ia]!;
      const dz = rb.z[ib]! - ra.z[ia]!;
      const min = nodeRadius(a, ia) + nodeRadius(b, ib);
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= min * min || d2 < 1e-10) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      const nz = dz / d;
      const pen = min - d + 0.001;
      const wa = NODE_INV_MASS[ia]! * modeA;
      const wb = NODE_INV_MASS[ib]! * modeB;
      const sum = wa + wb;
      if (sum <= 0) continue;
      ra.x[ia] -= nx * pen * (wa / sum);
      ra.y[ia] -= ny * pen * (wa / sum);
      ra.z[ia] -= nz * pen * (wa / sum);
      rb.x[ib] += nx * pen * (wb / sum);
      rb.y[ib] += ny * pen * (wb / sum);
      rb.z[ib] += nz * pen * (wb / sum);

      if (register) {
        const va = nodeVelocity(ra, ia, dt);
        const vb = nodeVelocity(rb, ib, dt);
        const rel = (vb.x - va.x) * nx + (vb.y - va.y) * ny + (vb.z - va.z) * nz;
        if (rel < -3.4) {
          if (modeA > 0) applyImpact(w, a, ra, ia, -rel * (b.mass / (a.mass + b.mass)));
          if (modeB > 0) applyImpact(w, b, rb, ib, -rel * (a.mass / (a.mass + b.mass)));
        }
      }
    }
  }
}

export class PhysicalBodies {
  private rigs = new Map<number, BodyRig>();

  bootstrap(w: World) {
    for (const a of w.actors) {
      if (a.species !== "human" && a.kind !== "player") continue;
      this.ensure(a);
    }
  }

  get(a: Actor) {
    return this.rigs.get(a.id);
  }

  ensure(a: Actor) {
    let rig = this.rigs.get(a.id);
    if (!rig) {
      rig = makeRig();
      this.rigs.set(a.id, rig);
    }
    if (!rig.initialized) resetRig(a, rig);
    return rig;
  }

  reset(a: Actor) {
    const rig = this.ensure(a);
    resetRig(a, rig);
  }

  clear() {
    this.rigs.clear();
  }

  step(w: World, dt: number) {
    const humans: Actor[] = [];
    for (const a of w.actors) {
      if (a.species !== "human" && a.kind !== "player") continue;
      humans.push(a);
      const rig = this.ensure(a);
      for (let i = 0; i < BODY_NODE_COUNT; i++) {
        rig.impactCd[i] = Math.max(0, rig.impactCd[i]! - dt);
      }
      const mode = bodyMode(a);
      if (mode !== rig.mode && mode === "follow") {
        resetRig(a, rig);
      }
      rig.mode = mode;
      rig.groundedNodes = 0;

      if (mode === "follow") {
        followPose(a, rig, dt);
        snapshotInjuries(a, rig);
        continue;
      }

      injectExternalImpulse(w, a, rig, dt);
      integrateDynamic(w, a, rig, dt, mode);

      const floor = supportHeight(w, rig.x[BODY.pelvis]!, rig.z[BODY.pelvis]!);
      computeTarget(a, rig, floor);
      const iterations = mode === "dynamic" ? 6 : 5;
      for (let iter = 0; iter < iterations; iter++) {
        solveLinks(a, rig, mode === "dynamic" ? 1 : 0.94);
        if (mode === "stumble") {
          pinNode(rig, BODY.pelvis, 0.1);
          pinNode(rig, BODY.chest, 0.08);
          pinNode(rig, BODY.head, 0.045);
          pinNode(rig, BODY.lFoot, 0.035);
          pinNode(rig, BODY.rFoot, 0.035);
        } else if (mode === "recover") {
          const k = 0.16 + (iter / iterations) * 0.08;
          for (let i = 0; i < BODY_NODE_COUNT; i++) pinNode(rig, i, k);
        }
        solveGrab(w, a, rig, (actor) => this.get(actor), mode === "dynamic" ? 0.72 : 0.58);
        collideRig(w, a, rig, dt, iter === 0);
        solveSelfContacts(a, rig);
      }

      if (mode === "stumble") {
        const torsoRise = rig.y[BODY.chest]! - rig.y[BODY.pelvis]!;
        const torsoLean = Math.hypot(
          rig.x[BODY.chest]! - rig.x[BODY.pelvis]!,
          rig.z[BODY.chest]! - rig.z[BODY.pelvis]!,
        );
        if (torsoRise < 0.16 || torsoLean > 0.62 * bodyScale(a) || a.balance < 0.08) {
          a.loco = "ragdoll";
          a.locoT = Math.max(a.locoT, 0.65);
          rig.mode = "dynamic";
        }
      }
    }

    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < humans.length; i++) {
        const a = humans[i]!;
        const ra = this.ensure(a);
        for (let j = i + 1; j < humans.length; j++) {
          const b = humans[j]!;
          if (a.grabbedId === b.id || b.grabbedId === a.id) continue;
          const rb = this.ensure(b);
          solveBodyPair(w, a, ra, b, rb, dt, pass === 0);
        }
      }
    }

    for (const a of humans) {
      const rig = this.ensure(a);
      if (rig.mode !== "follow") {
        solveLinks(a, rig, 0.82);
        deriveActorFromRig(w, a, rig, dt);
      }
      if (rig.mode === "recover" && a.getupT <= 0) {
        const err = Math.hypot(
          rig.x[BODY.head]! - rig.tx[BODY.head]!,
          rig.y[BODY.head]! - rig.ty[BODY.head]!,
          rig.z[BODY.head]! - rig.tz[BODY.head]!,
        );
        if (err > 0.42 * bodyScale(a)) {
          a.loco = "ragdoll";
          a.locoT = 0.35;
          rig.mode = "dynamic";
        }
      }
      snapshotInjuries(a, rig);
    }
  }
}
