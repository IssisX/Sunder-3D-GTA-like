import type { Actor, Collider, Region } from "./types";
import { GRAVITY, HALF } from "./types";
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

const LINK_DEFS: [number, number, number][] = LINK_PAIRS.map(
  ([a, b]) => [a, b, baseDistance(a, b)] as [number, number, number],
);

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
  if (a.grabbedBy || a.loco === "ragdoll" || a.loco === "down" || !a.alive) return "dynamic";
  if (a.loco === "getup") return "recover";
  if (a.loco === "stumble") return "stumble";
  return "follow";
}

function injuryScore(a: Actor, region: Region) {
  return injurySum(a.injuries[region]);
}

function representativeNode(region: Region) {
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

function computeTarget(a: Actor, rig: BodyRig, floorY = a.y) {
  const scale = bodyScale(a);
  const f = facing(a.yaw);
  const r = rightOf(a.yaw);
  const speed = Math.hypot(a.vx, a.vz);
  const stride = Math.min(0.34, speed * 0.055) * scale;
  const legSwing = Math.sin(a.walkPhase) * stride;
  const armSwing = Math.sin(a.walkPhase + Math.PI) * stride * 0.75;

  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    const o = i * 3;
    const lx = BASE[o]! * scale;
    let ly = BASE[o + 1]! * scale;
    let lz = BASE[o + 2]! * scale;

    if (a.crouch) {
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
    else if (i === BODY.lFoot) lz += legSwing;
    else if (i === BODY.rKnee) lz -= legSwing * 0.5;
    else if (i === BODY.rFoot) lz -= legSwing;
    else if (i === BODY.lElbow) lz += armSwing * 0.45;
    else if (i === BODY.lHand) lz += armSwing;
    else if (i === BODY.rElbow) lz -= armSwing * 0.45;
    else if (i === BODY.rHand) lz -= armSwing;

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
    rig.x[i] = rig.px[i] = rig.tx[i]!;
    rig.y[i] = rig.py[i] = rig.ty[i]!;
    rig.z[i] = rig.pz[i] = rig.tz[i]!;
    rig.impactCd[i] = 0;
  }
  for (let i = 0; i < REGIONS.length; i++) rig.injurySnapshot[i] = injuryScore(a, REGIONS[i]!);
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
  const wa = NODE_INV_MASS[ia]!;
  const wb = NODE_INV_MASS[ib]!;
  const sum = wa + wb;
  const corr = ((d - rest * scale) / d) * stiffness;
  rig.x[ia] += dx * corr * (wa / sum);
  rig.y[ia] += dy * corr * (wa / sum);
  rig.z[ia] += dz * corr * (wa / sum);
  rig.x[ib] -= dx * corr * (wb / sum);
  rig.y[ib] -= dy * corr * (wb / sum);
  rig.z[ib] -= dz * corr * (wb / sum);
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

function solveLinks(a: Actor, rig: BodyRig, stiffness = 1) {
  const scale = bodyScale(a);
  for (let i = 0; i < LINK_DEFS.length; i++) {
    const [ia, ib, rest] = LINK_DEFS[i]!;
    solveDistance(rig, ia, ib, rest, LINK_STIFFNESS[i]! * stiffness, scale);
  }
  for (const [ia, ib, min, max] of JOINT_RANGES) solveRange(rig, ia, ib, min, max, scale);
}

function pinNode(rig: BodyRig, i: number, strength: number) {
  rig.x[i] += (rig.tx[i]! - rig.x[i]!) * strength;
  rig.y[i] += (rig.ty[i]! - rig.y[i]!) * strength;
  rig.z[i] += (rig.tz[i]! - rig.z[i]!) * strength;
}

function nodeRadius(a: Actor, i: number) {
  return BASE_RADIUS[i]! * bodyScale(a);
}

function nodeVelocityComponent(current: number, previous: number, dt: number) {
  return (current - previous) / Math.max(1e-5, dt);
}

function applyImpact(w: World, a: Actor, rig: BodyRig, node: number, speed: number) {
  if (!a.alive || speed < 3.2 || rig.impactCd[node]! > 0) return;
  const region = NODE_REGION[node]!;
  const severity = clamp((speed - 3.2) ** 2 * 0.018 * (a.mass / 78), 0, 1.4);
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
  if (severity > 0.2) w.emitSound(a.x, a.z, 0.24 + severity * 0.2, "hurt", a.id);
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
  const d2 = nx * nx + ny * ny + nz * nz;
  if (d2 >= radius * radius) return false;

  let penetration = 0;
  if (d2 < 1e-10) {
    const dl = Math.abs(x - c.minX);
    const dr = Math.abs(c.maxX - x);
    const db = Math.abs(y - c.minY);
    const dtp = Math.abs(c.maxY - y);
    const ds = Math.abs(z - c.minZ);
    const dn = Math.abs(c.maxZ - z);
    const nearest = Math.min(dl, dr, db, dtp, ds, dn);
    penetration = nearest + radius + 0.002;
    if (nearest === dl) {
      nx = -1;
      ny = 0;
      nz = 0;
    } else if (nearest === dr) {
      nx = 1;
      ny = 0;
      nz = 0;
    } else if (nearest === db) {
      nx = 0;
      ny = -1;
      nz = 0;
    } else if (nearest === dtp) {
      nx = 0;
      ny = 1;
      nz = 0;
    } else if (nearest === ds) {
      nx = 0;
      ny = 0;
      nz = -1;
    } else {
      nx = 0;
      ny = 0;
      nz = 1;
    }
  } else {
    const d = Math.sqrt(d2);
    const inv = 1 / d;
    nx *= inv;
    ny *= inv;
    nz *= inv;
    penetration = radius - d + 0.002;
  }

  const vx = nodeVelocityComponent(rig.x[node]!, rig.px[node]!, dt);
  const vy = nodeVelocityComponent(rig.y[node]!, rig.py[node]!, dt);
  const vz = nodeVelocityComponent(rig.z[node]!, rig.pz[node]!, dt);
  const vn = vx * nx + vy * ny + vz * nz;
  if (registerImpact && vn < -3.2) applyImpact(w, a, rig, node, -vn);

  rig.x[node] += nx * penetration;
  rig.y[node] += ny * penetration;
  rig.z[node] += nz * penetration;

  if (vn < 0) {
    const bounce = 0.08;
    const rvx = vx - nx * vn * (1 + bounce);
    const rvy = vy - ny * vn * (1 + bounce);
    const rvz = vz - nz * vn * (1 + bounce);
    rig.px[node] = rig.x[node]! - rvx * dt * 0.78;
    rig.py[node] = rig.y[node]! - rvy * dt * 0.78;
    rig.pz[node] = rig.z[node]! - rvz * dt * 0.78;
  }
  if (ny > 0.45) rig.groundedNodes++;
  return true;
}

function collideRig(w: World, a: Actor, rig: BodyRig, dt: number, registerImpact: boolean) {
  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    const radius = nodeRadius(a, i);
    if (rig.y[i]! < radius) {
      const vy = nodeVelocityComponent(rig.y[i]!, rig.py[i]!, dt);
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

    rig.x[i] = clamp(rig.x[i]!, -HALF + radius, HALF - radius);
    rig.z[i] = clamp(rig.z[i]!, -HALF + radius, HALF - radius);
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
    const nx = dx / d;
    const ny = dy / d;
    const nz = dz / d;
    const pen = min - d;
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

function supportHeight(w: World, x: number, y: number, z: number) {
  let h = 0;
  for (const c of w.colliders) {
    if (!c.solid || c.water || c.maxY > y + 0.45) continue;
    if (x < c.minX - 0.2 || x > c.maxX + 0.2 || z < c.minZ - 0.2 || z > c.maxZ + 0.2) continue;
    h = Math.max(h, c.maxY);
  }
  return h;
}

function closestGrabNode(rig: BodyRig, x: number, y: number, z: number) {
  let best = BODY.chest;
  let bestD = Infinity;
  for (const i of GRAB_NODES) {
    const dx = rig.x[i]! - x;
    const dy = rig.y[i]! - y;
    const dz = rig.z[i]! - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD) {
      bestD = d2;
      best = i;
    }
  }
  return best;
}

function solveGrab(
  w: World,
  a: Actor,
  rig: BodyRig,
  getRig: (actor: Actor) => BodyRig | undefined,
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
  const holderRig = getRig(holder);
  let tx: number;
  let ty: number;
  let tz: number;
  if (holderRig?.initialized) {
    tx = holderRig.x[BODY.rHand]!;
    ty = holderRig.y[BODY.rHand]!;
    tz = holderRig.z[BODY.rHand]!;
  } else {
    const f = facing(holder.yaw);
    tx = holder.x + f.x * 0.5;
    ty = holder.y + holder.height * 0.65;
    tz = holder.z + f.z * 0.5;
  }

  if (rig.grabNode < 0) rig.grabNode = closestGrabNode(rig, tx, ty, tz);
  const i = rig.grabNode;
  const dx = tx - rig.x[i]!;
  const dy = ty - rig.y[i]!;
  const dz = tz - rig.z[i]!;
  const dist = Math.hypot(dx, dy, dz);
  const k = dist > 1.1 ? Math.min(1, strength * 1.2) : strength;
  rig.x[i] += dx * k;
  rig.y[i] += dy * k;
  rig.z[i] += dz * k;

  if (dist > 0.5) {
    const load = a.mass / Math.max(1, a.mass + holder.mass);
    holder.balance = clamp(holder.balance - Math.min(0.04, dist * load * 0.012), 0, 1);
    holder.vx -= dx * load * 0.03;
    holder.vz -= dz * load * 0.03;
  }
}

function snapshotInjuries(a: Actor, rig: BodyRig) {
  for (let i = 0; i < REGIONS.length; i++) rig.injurySnapshot[i] = injuryScore(a, REGIONS[i]!);
}

function injectExternalImpulse(w: World, a: Actor, rig: BodyRig, dt: number) {
  const p = BODY.pelvis;
  const rvx = nodeVelocityComponent(rig.x[p]!, rig.px[p]!, dt);
  const rvy = nodeVelocityComponent(rig.y[p]!, rig.py[p]!, dt);
  const rvz = nodeVelocityComponent(rig.z[p]!, rig.pz[p]!, dt);
  let dvx = a.vx - rvx;
  let dvy = a.vy - rvy;
  let dvz = a.vz - rvz;
  const mag = Math.hypot(dvx, dvy, dvz);
  if (mag < 1.15) return;

  const capped = Math.min(18, mag) / mag;
  dvx *= capped;
  dvy *= capped;
  dvz *= capped;

  let bestRegion = -1;
  let bestDelta = 0;
  for (let i = 0; i < REGIONS.length; i++) {
    const delta = injuryScore(a, REGIONS[i]!) - rig.injurySnapshot[i]!;
    if (delta > bestDelta) {
      bestDelta = delta;
      bestRegion = i;
    }
  }

  const recentHit = a.lastHitBy && w.time - a.lastHitT < dt * 1.6;
  if (recentHit && bestRegion >= 0) {
    const node = representativeNode(REGIONS[bestRegion]!);
    rig.px[node] -= dvx * dt * 0.85;
    rig.py[node] -= dvy * dt * 0.85;
    rig.pz[node] -= dvz * dt * 0.85;
    rig.px[BODY.chest] -= dvx * dt * 0.18;
    rig.py[BODY.chest] -= dvy * dt * 0.18;
    rig.pz[BODY.chest] -= dvz * dt * 0.18;
    return;
  }

  if (a.grabbedBy) return;
  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    rig.px[i] -= dvx * dt * 0.42;
    rig.py[i] -= dvy * dt * 0.42;
    rig.pz[i] -= dvz * dt * 0.42;
  }
}

function integrateDynamic(w: World, rig: BodyRig, dt: number, mode: BodyMode) {
  const damp = mode === "dynamic" ? 0.988 : mode === "stumble" ? 0.965 : 0.955;
  const gravity = mode === "recover" ? GRAVITY * 0.55 : mode === "stumble" ? GRAVITY * 0.78 : GRAVITY;
  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    const x = rig.x[i]!;
    const y = rig.y[i]!;
    const z = rig.z[i]!;
    let dx = (x - rig.px[i]!) * damp;
    let dy = (y - rig.py[i]!) * damp;
    let dz = (z - rig.pz[i]!) * damp;
    if (w.inWater(x, z, y)) {
      dx *= 0.82;
      dy *= 0.82;
      dz *= 0.82;
      dy += 4.2 * dt * dt;
    }
    rig.px[i] = x;
    rig.py[i] = y;
    rig.pz[i] = z;
    rig.x[i] = x + dx;
    rig.y[i] = y + dy - gravity * dt * dt;
    rig.z[i] = z + dz;
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

function modeWeight(mode: BodyMode) {
  if (mode === "dynamic") return 1;
  if (mode === "stumble") return 0.62;
  if (mode === "recover") return 0.4;
  return 0;
}

function solveBodyPair(w: World, a: Actor, ra: BodyRig, b: Actor, rb: BodyRig, dt: number, register: boolean) {
  const dxRoot = rb.x[BODY.pelvis]! - ra.x[BODY.pelvis]!;
  const dzRoot = rb.z[BODY.pelvis]! - ra.z[BODY.pelvis]!;
  if (dxRoot * dxRoot + dzRoot * dzRoot > 3.4 * 3.4) return;
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

      if (!register) continue;
      const avx = nodeVelocityComponent(ra.x[ia]!, ra.px[ia]!, dt);
      const avy = nodeVelocityComponent(ra.y[ia]!, ra.py[ia]!, dt);
      const avz = nodeVelocityComponent(ra.z[ia]!, ra.pz[ia]!, dt);
      const bvx = nodeVelocityComponent(rb.x[ib]!, rb.px[ib]!, dt);
      const bvy = nodeVelocityComponent(rb.y[ib]!, rb.py[ib]!, dt);
      const bvz = nodeVelocityComponent(rb.z[ib]!, rb.pz[ib]!, dt);
      const rel = (bvx - avx) * nx + (bvy - avy) * ny + (bvz - avz) * nz;
      if (rel < -3.4) {
        if (modeA > 0) applyImpact(w, a, ra, ia, -rel * (b.mass / (a.mass + b.mass)));
        if (modeB > 0) applyImpact(w, b, rb, ib, -rel * (a.mass / (a.mass + b.mass)));
      }
    }
  }
}

function deriveActorFromRig(a: Actor, rig: BodyRig, dt: number) {
  const p = BODY.pelvis;
  const feet = Math.min(
    rig.y[BODY.lFoot]! - nodeRadius(a, BODY.lFoot),
    rig.y[BODY.rFoot]! - nodeRadius(a, BODY.rFoot),
    rig.y[p]! - 0.78 * bodyScale(a),
  );
  a.x = clamp(rig.x[p]!, -HALF + 1, HALF - 1);
  a.z = clamp(rig.z[p]!, -HALF + 1, HALF - 1);
  a.y = Math.max(0, feet);
  a.vx = nodeVelocityComponent(rig.x[p]!, rig.px[p]!, dt);
  a.vy = nodeVelocityComponent(rig.y[p]!, rig.py[p]!, dt);
  a.vz = nodeVelocityComponent(rig.z[p]!, rig.pz[p]!, dt);
  a.grounded = rig.groundedNodes > 0;

  if (rig.mode === "dynamic") {
    const rise = rig.y[BODY.chest]! - rig.y[p]!;
    const lean = Math.hypot(rig.x[BODY.chest]! - rig.x[p]!, rig.z[BODY.chest]! - rig.z[p]!);
    const posture = clamp((rise - 0.05) / 0.42, 0, 1) * clamp(1 - lean / 0.8, 0, 1);
    a.balance = Math.min(a.balance, posture);
  }
}

export class PhysicalBodies {
  private rigs = new Map<number, BodyRig>();

  bootstrap(w: World) {
    for (const a of w.actors) {
      if (a.species === "human" || a.kind === "player") this.ensure(a);
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
    resetRig(a, this.ensure(a));
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
      for (let i = 0; i < BODY_NODE_COUNT; i++) rig.impactCd[i] = Math.max(0, rig.impactCd[i]! - dt);

      const mode = bodyMode(a);
      if (mode !== rig.mode && mode === "follow") resetRig(a, rig);
      rig.mode = mode;
      rig.groundedNodes = 0;

      if (mode === "follow") {
        followPose(a, rig, dt);
        snapshotInjuries(a, rig);
        continue;
      }

      injectExternalImpulse(w, a, rig, dt);
      integrateDynamic(w, rig, dt, mode);
      const floor = supportHeight(w, rig.x[BODY.pelvis]!, rig.y[BODY.pelvis]!, rig.z[BODY.pelvis]!);
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
        const rise = rig.y[BODY.chest]! - rig.y[BODY.pelvis]!;
        const lean = Math.hypot(
          rig.x[BODY.chest]! - rig.x[BODY.pelvis]!,
          rig.z[BODY.chest]! - rig.z[BODY.pelvis]!,
        );
        if (rise < 0.16 || lean > 0.62 * bodyScale(a) || a.balance < 0.08) {
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
          solveBodyPair(w, a, ra, b, this.ensure(b), dt, pass === 0);
        }
      }
    }

    for (const a of humans) {
      const rig = this.ensure(a);
      if (rig.mode !== "follow") {
        solveLinks(a, rig, 0.82);
        deriveActorFromRig(a, rig, dt);
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
