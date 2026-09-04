import type { Actor, Collider, Joint, Particle, Physique, Region } from "./types";
import { GRAVITY, WEAPON_STATS } from "./types";
import { World, clamp, facing, injurySum, rightOf } from "./world";

export const P = {
  pelvis: 0,
  spine: 1,
  head: 2,
  uarmL: 3,
  larmL: 4,
  uarmR: 5,
  larmR: 6,
  thighL: 7,
  shinL: 8,
  thighR: 9,
  shinR: 10,
} as const;

export const NPART = 11;

export const PART_REGION: Region[] = [
  "torso",
  "torso",
  "head",
  "larm",
  "larm",
  "rarm",
  "rarm",
  "lleg",
  "lleg",
  "rleg",
  "rleg",
];

const LOCAL: [number, number, number][] = [
  [0, 0.9, 0],
  [0, 1.22, 0.02],
  [0, 1.55, 0.04],
  [-0.26, 1.34, 0],
  [-0.28, 0.94, 0.02],
  [0.26, 1.34, 0],
  [0.28, 0.94, 0.02],
  [-0.11, 0.52, 0.01],
  [-0.12, 0.12, 0.05],
  [0.11, 0.52, 0.01],
  [0.12, 0.12, 0.05],
];

const RAD = [0.15, 0.13, 0.11, 0.08, 0.07, 0.08, 0.07, 0.09, 0.08, 0.09, 0.08];
const MASSW = [18, 14, 6, 4, 3, 4, 3, 8, 5, 8, 5];

const BONES: [number, number, number][] = [
  [0, 1, 0.000012],
  [1, 2, 0.000018],
  [1, 3, 0.00002],
  [3, 4, 0.000022],
  [1, 5, 0.00002],
  [5, 6, 0.000022],
  [0, 7, 0.000016],
  [7, 8, 0.000018],
  [0, 9, 0.000016],
  [9, 10, 0.000018],
  [0, 2, 0.00004],
  [3, 5, 0.00003],
  [7, 9, 0.00003],
  [0, 3, 0.000045],
  [0, 5, 0.000045],
];

/** Hinge spans (a-b-c). Min cosine keeps the joint from folding flat; max keeps it from going the wrong way past straight. */
const HINGES: [number, number, number, number, number][] = [
  [P.spine, P.uarmL, P.larmL, -0.72, 0.92],
  [P.spine, P.uarmR, P.larmR, -0.72, 0.92],
  [P.pelvis, P.thighL, P.shinL, -0.88, 0.78],
  [P.pelvis, P.thighR, P.shinR, -0.88, 0.78],
  [P.pelvis, P.spine, P.head, -0.55, 0.85],
];

const BONE_SKIP = new Set(BONES.map(([a, b]) => (a < b ? a * 16 + b : b * 16 + a)));
const CORE_PARTS = [P.pelvis, P.spine, P.head];
const ALL_PARTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];


const SUB = 4;
const ITERS = 2;
const IMPACT_VN = 2.45;
const PELVIS_H = 0.9;
export const STRIKE_DUR = 0.46;
export const KICK_DUR = 0.48;
export const SHOVE_DUR = 0.4;
export const GRAB_DUR = 0.36;
export const FLINCH_DUR = 0.32;

function smooth01(t: number) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function strikeDuration(a: Actor) {
  return STRIKE_DUR / (WEAPON_STATS[a.weapon]?.speed ?? 1);
}

export function actionUnit(remain: number, dur: number) {
  if (remain <= 0 || dur <= 0) return 0;
  return clamp(1 - remain / dur, 0, 1);
}

function weaponArc(kind: Actor["weapon"]) {
  if (kind === "club" || kind === "board" || kind === "torch") {
    return { wind: [0.1, 0.4, -0.22] as [number, number, number], hit: [0.03, -0.16, 0.56] as [number, number, number], hands: 1 };
  }
  if (kind === "spear" || kind === "pitchfork") {
    return { wind: [0.02, 0.06, -0.4] as [number, number, number], hit: [0, 0.05, 0.82] as [number, number, number], hands: 2 };
  }
  if (kind === "knife") {
    return { wind: [0.07, 0.1, -0.16] as [number, number, number], hit: [0.02, 0.03, 0.56] as [number, number, number], hands: 1 };
  }
  return { wind: [0.11, 0.18, -0.3] as [number, number, number], hit: [-0.05, 0.05, 0.64] as [number, number, number], hands: 1 };
}

function hasHumanBody(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

export function isDynamicBody(a: Actor) {
  if (!a.body) return false;
  return a.body.mode === "ragdoll" || a.body.mode === "getup" || a.loco === "down" || !a.alive;
}

export function makePhysique(a: Actor): Physique {
  const scale = a.mass / 75;
  const parts: Particle[] = [];
  for (let i = 0; i < NPART; i++) {
    const m = Math.max(0.8, MASSW[i]! * scale);
    parts.push({
      x: 0,
      y: 0,
      z: 0,
      px: 0,
      py: 0,
      pz: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      invM: 1 / m,
      r: RAD[i]! * (a.height / 1.7),
    });
  }
  const joints: Joint[] = [];
  for (const [ia, ib, comp] of BONES) {
    const la = LOCAL[ia]!;
    const lb = LOCAL[ib]!;
    const rest = Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
    joints.push({ a: ia, b: ib, rest, compliance: comp });
  }
  const body: Physique = {
    parts,
    joints,
    mode: "stance",
    grab: null,
    support: 1,
    lastVn: 0,
    lastHit: -1,
  };
  snapToPose(body, a);
  return body;
}

export function ensureBodies(w: World) {
  for (const a of w.actors) {
    if (!hasHumanBody(a)) continue;
    if (!a.body) a.body = makePhysique(a);
  }
}

function worldPoint(a: Actor, lx: number, ly: number, lz: number) {
  const f = facing(a.yaw);
  const r = rightOf(a.yaw);
  return {
    x: a.x + r.x * lx + f.x * lz,
    y: a.y + ly,
    z: a.z + r.z * lx + f.z * lz,
  };
}

function poseLocal(a: Actor, i: number): [number, number, number] {
  const base = LOCAL[i]!;
  let lx = base[0];
  let ly = base[1];
  let lz = base[2];
  const punching = a.strikeT > 0;
  const kicking = a.kickT > 0;
  const shoving = a.shoveT > 0;
  const spd = Math.hypot(a.vx, a.vz);
  const amp = Math.min(0.34, spd * 0.075 + (a.loco === "walk" || a.loco === "run" || a.loco === "sprint" ? 0.08 : 0));
  const s = Math.sin(a.walkPhase);
  if (a.crouch || a.loco === "crouch") {
    ly *= 0.72;
    lz += 0.08;
  }
  if (!kicking) {
    if (i === P.shinL || i === P.thighL) lz += s * amp * (i === P.shinL ? 1 : 0.45);
    if (i === P.shinR || i === P.thighR) lz -= s * amp * (i === P.shinR ? 1 : 0.45);
  }
  if (!punching && !shoving && a.grabT <= 0 && !a.grabbedId) {
    if (i === P.larmL || i === P.uarmL) lz -= s * amp * (i === P.larmL ? 0.85 : 0.4);
    if (i === P.larmR || i === P.uarmR) lz += s * amp * (i === P.larmR ? 0.85 : 0.4);
  }

  if (punching) {
    const u = actionUnit(a.strikeT, strikeDuration(a));
    const arc = weaponArc(a.weapon);
    let off: [number, number, number];
    if (u < 0.3) off = lerp3([0, 0, 0], arc.wind, smooth01(u / 0.3));
    else if (u < 0.52) off = lerp3(arc.wind, arc.hit, smooth01((u - 0.3) / 0.22));
    else off = lerp3(arc.hit, [0, 0, 0], smooth01((u - 0.52) / 0.48));
    const k = i === P.larmR ? 1 : i === P.uarmR ? 0.48 : 0;
    if (k) {
      lx += off[0] * k;
      ly += off[1] * k;
      lz += off[2] * k;
    }
    if (arc.hands === 2 && (i === P.larmL || i === P.uarmL)) {
      const g = i === P.larmL ? 0.78 : 0.38;
      lx -= off[0] * g * 0.35;
      ly += off[1] * g;
      lz += off[2] * g;
    } else if (i === P.larmL || i === P.uarmL) {
      const g = i === P.larmL ? 1 : 0.4;
      lz += (u < 0.52 ? 0.14 : 0.14 * (1 - (u - 0.52) / 0.48)) * g;
    }
    if (i === P.spine) {
      lz += off[2] * 0.12;
      ly += off[1] * 0.18;
    }
    if (i === P.head) lz += off[2] * 0.06;
  }

  if (kicking) {
    const u = actionUnit(a.kickT, KICK_DUR);
    const chamber: [number, number, number] = [0.02, 0.28, -0.08];
    const snap: [number, number, number] = [0.02, 0.1, 0.72];
    let off: [number, number, number];
    if (u < 0.32) off = lerp3([0, 0, 0], chamber, smooth01(u / 0.32));
    else if (u < 0.5) off = lerp3(chamber, snap, smooth01((u - 0.32) / 0.18));
    else off = lerp3(snap, [0, 0, 0], smooth01((u - 0.5) / 0.5));
    if (i === P.shinR) {
      lx += off[0];
      ly += off[1];
      lz += off[2];
    } else if (i === P.thighR) {
      lx += off[0] * 0.4;
      ly += off[1] * 0.7;
      lz += off[2] * 0.4;
    } else if (i === P.shinL || i === P.thighL) {
      lz -= 0.06;
    } else if (i === P.spine) lz += off[2] * 0.08;
  }

  if (shoving) {
    const u = actionUnit(a.shoveT, SHOVE_DUR);
    const gather: [number, number, number] = [0, 0.06, -0.08];
    const push: [number, number, number] = [0, 0.02, 0.5];
    let off: [number, number, number];
    if (u < 0.34) off = lerp3([0, 0, 0], gather, smooth01(u / 0.34));
    else if (u < 0.55) off = lerp3(gather, push, smooth01((u - 0.34) / 0.21));
    else off = lerp3(push, [0, 0, 0], smooth01((u - 0.55) / 0.45));
    if (i === P.larmR || i === P.larmL) {
      const side = i === P.larmL ? -1 : 1;
      lx += off[0] + side * 0.04;
      ly += off[1];
      lz += off[2];
    } else if (i === P.uarmR || i === P.uarmL) {
      lz += off[2] * 0.45;
      ly += off[1] * 0.5;
    } else if (i === P.spine) lz += off[2] * 0.2;
    else if (i === P.head) lz += off[2] * 0.1;
  }

  const grabbing = a.grabT > 0 || a.grabbedId > 0;
  if (grabbing && !punching && !shoving) {
    const holding = a.grabbedId > 0;
    const u = holding ? 1 : actionUnit(a.grabT, GRAB_DUR);
    const wind: [number, number, number] = [0.04, 0.04, -0.1];
    const reach: [number, number, number] = [0.05, -0.04, 0.52];
    let off: [number, number, number];
    if (holding) off = reach;
    else if (u < 0.38) off = lerp3([0, 0, 0], wind, smooth01(u / 0.38));
    else if (u < 0.62) off = lerp3(wind, reach, smooth01((u - 0.38) / 0.24));
    else off = lerp3(reach, holding ? reach : [0, 0, 0], smooth01((u - 0.62) / 0.38));
    const two = holding && a.body?.grab && a.body.grab.myPart2 >= 0;
    if (i === P.larmR || i === P.uarmR) {
      const k = i === P.larmR ? 1 : 0.45;
      lx += off[0] * k;
      ly += off[1] * k;
      lz += off[2] * k;
    }
    if (two && (i === P.larmL || i === P.uarmL)) {
      const k = i === P.larmL ? 0.92 : 0.42;
      lx -= off[0] * k * 0.4;
      ly += (off[1] - 0.04) * k;
      lz += off[2] * k * 0.85;
    } else if (i === P.larmL || i === P.uarmL) {
      lz += off[2] * 0.12;
    }
    if (i === P.spine) lz += off[2] * 0.1;
  }

  if (a.flinchT > 0 && !punching && !kicking) {
    const u = actionUnit(a.flinchT, FLINCH_DUR);
    const amp = Math.sin(Math.min(1, u < 0.5 ? u * 2 : (1 - u) * 2) * Math.PI) * 0.22;
    const hit = a.body?.lastHit ?? P.spine;
    const rec = PART_REGION[hit] ?? "torso";
    if (rec === "head" && (i === P.head || i === P.spine)) {
      lz -= amp * (i === P.head ? 1 : 0.45);
      ly -= amp * 0.25;
      lx += amp * 0.15;
    } else if ((rec === "rarm" && (i === P.larmR || i === P.uarmR)) || (rec === "larm" && (i === P.larmL || i === P.uarmL))) {
      lz -= amp * 0.7;
      ly += amp * 0.2;
    } else if ((rec === "rleg" && (i === P.shinR || i === P.thighR)) || (rec === "lleg" && (i === P.shinL || i === P.thighL))) {
      lz -= amp * 0.55;
      ly += amp * 0.15;
    } else if (rec === "torso" && (i === P.spine || i === P.head || i === P.pelvis)) {
      lz -= amp * (i === P.spine ? 0.7 : 0.35);
      ly -= amp * 0.12;
    }
  }

  if (a.loco === "stumble") {
    const n = spd > 0.05 ? spd : 1;
    const along = (a.vx * facing(a.yaw).x + a.vz * facing(a.yaw).z) / n;
    lz += along * 0.16;
    ly -= 0.1;
    if (i === P.head) {
      lz += along * 0.08;
      ly -= 0.06;
    }
    if (i === P.larmL || i === P.uarmL) lz -= along * 0.12;
    if (i === P.larmR || i === P.uarmR) lz += along * 0.08;
    if (i === P.shinL) lz -= 0.08;
  }
  if (a.loco === "getup" || (a.body && a.body.mode === "getup")) {
    const k = 1 - clamp(a.getupT / 1.15, 0, 1);
    ly = base[1] * (0.18 + 0.82 * k);
    if (k < 0.35) {
      lz += (1 - k / 0.35) * 0.55;
      if (i === P.head) ly = 0.22;
      if (i === P.spine) ly = 0.16;
    } else if (k < 0.7) {
      const u = (k - 0.35) / 0.35;
      if (i === P.pelvis) ly = 0.35 + u * 0.25;
      lz *= 1 - u * 0.6;
    }
  }
  return [lx, ly, lz];
}

export function poseTargets(a: Actor): { x: number; y: number; z: number }[] {
  const out = [];
  for (let i = 0; i < NPART; i++) {
    const [lx, ly, lz] = poseLocal(a, i);
    out.push(worldPoint(a, lx, ly, lz));
  }
  return out;
}

function snapToPose(body: Physique, a: Actor) {
  const t = poseTargets(a);
  for (let i = 0; i < NPART; i++) {
    const p = body.parts[i]!;
    const q = t[i]!;
    p.x = p.px = q.x;
    p.y = p.py = q.y;
    p.z = p.pz = q.z;
    p.vx = a.vx;
    p.vy = a.vy;
    p.vz = a.vz;
  }
}

export function reposeActor(a: Actor) {
  if (a.body) snapToPose(a.body, a);
}

export function meleeTip(a: Actor, kind: "strike" | "kick" | "shove") {
  const f = facing(a.yaw);
  if (!a.body) {
    if (kind === "kick") return { x: a.x + f.x * 0.5, y: a.y + 0.26, z: a.z + f.z * 0.5, r: 0.12 };
    if (kind === "shove") return { x: a.x + f.x * 0.42, y: a.y + 1.12, z: a.z + f.z * 0.42, r: 0.16 };
    return { x: a.x + f.x * 0.58, y: a.y + 1.12, z: a.z + f.z * 0.58, r: 0.11 };
  }
  if (kind === "kick") {
    const p = a.body.parts[P.shinR]!;
    return { x: p.x + f.x * 0.06, y: p.y, z: p.z + f.z * 0.06, r: p.r + 0.03 };
  }
  if (kind === "shove") {
    const p = a.body.parts[P.spine]!;
    return { x: p.x + f.x * 0.16, y: p.y, z: p.z + f.z * 0.16, r: 0.15 };
  }
  const hand = a.body.parts[P.larmR]!;
  const el = a.body.parts[P.uarmR]!;
  let dx = hand.x - el.x;
  let dy = hand.y - el.y;
  let dz = hand.z - el.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const extra = WEAPON_STATS[a.weapon]?.reach ?? 0.1;
  dx /= len;
  dy /= len;
  dz /= len;
  return {
    x: hand.x + dx * extra,
    y: hand.y + dy * extra,
    z: hand.z + dz * extra,
    r: 0.1 + extra * 0.08,
  };
}

export function nearestPart(body: Physique, x: number, y: number, z: number) {
  let best = 0;
  let bd = 1e9;
  for (let i = 0; i < body.parts.length; i++) {
    const p = body.parts[i]!;
    const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) + (p.z - z) * (p.z - z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

export function applyImpulseToNearest(
  a: Actor,
  x: number,
  y: number,
  z: number,
  ix: number,
  iy: number,
  iz: number,
) {
  if (!a.body) return -1;
  const i = nearestPart(a.body, x, y, z);
  const p = a.body.parts[i]!;
  const scale = a.body.mode === "stance" ? 0.32 : 1;
  p.vx += ix * p.invM * scale;
  p.vy += iy * p.invM * scale;
  p.vz += iz * p.invM * scale;
  a.body.lastHit = i;
  return i;
}

export function setGrab(grabber: Actor, target: Actor) {
  if (!grabber.body || !target.body) return false;
  const hand = grabber.body.parts[P.larmR]!;
  const other = nearestPart(target.body, hand.x, hand.y, hand.z);
  const two = target.mass > grabber.mass * 0.62 || !target.alive || target.body.mode !== "stance";
  let myPart2 = -1;
  let otherPart2 = -1;
  if (two) {
    const left = grabber.body.parts[P.larmL]!;
    myPart2 = P.larmL;
    otherPart2 = nearestPart(target.body, left.x, left.y, left.z);
    if (otherPart2 === other) otherPart2 = P.spine;
  }
  grabber.body.grab = {
    otherId: target.id,
    myPart: P.larmR,
    otherPart: other,
    rest: 0.22,
    myPart2,
    otherPart2,
  };
  return true;
}

export function clearGrab(a: Actor) {
  if (a.body) a.body.grab = null;
}

function pin(p: Particle, tx: number, ty: number, tz: number, compliance: number, h: number) {
  const alpha = compliance / (h * h);
  const w = p.invM;
  if (w <= 0) return;
  const s = w / (w + alpha);
  p.x -= (p.x - tx) * s;
  p.y -= (p.y - ty) * s;
  p.z -= (p.z - tz) * s;
}

function solveDist(pa: Particle, pb: Particle, rest: number, compliance: number, h: number) {
  const dx = pa.x - pb.x;
  const dy = pa.y - pb.y;
  const dz = pa.z - pb.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-8) return 0;
  const C = d - rest;
  const alpha = compliance / (h * h);
  const w = pa.invM + pb.invM;
  if (w <= 0) return 0;
  const dlambda = -C / (w + alpha);
  const s = dlambda / d;
  pa.x += dx * pa.invM * s;
  pa.y += dy * pa.invM * s;
  pa.z += dz * pa.invM * s;
  pb.x -= dx * pb.invM * s;
  pb.y -= dy * pb.invM * s;
  pb.z -= dz * pb.invM * s;
  return C;
}

function solveHinge(pa: Particle, pb: Particle, pc: Particle, minCos: number, maxCos: number, compliance: number, h: number) {
  const ux = pa.x - pb.x;
  const uy = pa.y - pb.y;
  const uz = pa.z - pb.z;
  const vx = pc.x - pb.x;
  const vy = pc.y - pb.y;
  const vz = pc.z - pb.z;
  const ul = Math.hypot(ux, uy, uz);
  const vl = Math.hypot(vx, vy, vz);
  if (ul < 1e-5 || vl < 1e-5) return;
  const c = (ux * vx + uy * vy + uz * vz) / (ul * vl);
  let target = c;
  if (c < minCos) target = minCos;
  else if (c > maxCos) target = maxCos;
  else return;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-8) return;
  const invN = 1 / nl;
  const px = (ny * vz - nz * vy) * invN;
  const py = (nz * vx - nx * vz) * invN;
  const pz = (nx * vy - ny * vx) * invN;
  const qx = (ny * uz - nz * uy) * invN;
  const qy = (nz * ux - nx * uz) * invN;
  const qz = (nx * uy - ny * ux) * invN;
  const C = c - target;
  const alpha = compliance / (h * h);
  const w = pa.invM + pc.invM + pb.invM * 0.35;
  if (w <= 0) return;
  const dl = -C / (w + alpha);
  pa.x += qx * pa.invM * dl;
  pa.y += qy * pa.invM * dl;
  pa.z += qz * pa.invM * dl;
  pc.x -= px * pc.invM * dl;
  pc.y -= py * pc.invM * dl;
  pc.z -= pz * pc.invM * dl;
  pb.x -= (qx * pa.invM - px * pc.invM) * dl * 0.35;
  pb.y -= (qy * pa.invM - py * pc.invM) * dl * 0.35;
  pb.z -= (qz * pa.invM - pz * pc.invM) * dl * 0.35;
}

function solveContact(pa: Particle, pb: Particle, h: number) {
  const min = pa.r + pb.r;
  const dx = pa.x - pb.x;
  const dy = pa.y - pb.y;
  const dz = pa.z - pb.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= min * min || d2 < 1e-10) return 0;
  const d = Math.sqrt(d2);
  const C = d - min;
  const w = pa.invM + pb.invM;
  if (w <= 0) return 0;
  const dlambda = -C / w;
  const s = dlambda / d;
  pa.x += dx * pa.invM * s;
  pa.y += dy * pa.invM * s;
  pa.z += dz * pa.invM * s;
  pb.x -= dx * pb.invM * s;
  pb.y -= dy * pb.invM * s;
  pb.z -= dz * pb.invM * s;
  const vn = (pa.vx - pb.vx) * (dx / d) + (pa.vy - pb.vy) * (dy / d) + (pa.vz - pb.vz) * (dz / d);
  return vn;
}

function jointCompliance(a: Actor, j: Joint) {
  const ra = PART_REGION[j.a]!;
  const rb = PART_REGION[j.b]!;
  const inj = injurySum(a.injuries[ra]) + injurySum(a.injuries[rb]);
  const frac = a.injuries[ra].fracture + a.injuries[rb].fracture;
  let c = j.compliance * (1 + inj * 2.4 + frac * 10);
  if (a.body?.mode === "ragdoll") c *= 1.15;
  return c;
}

function poseCompliance(a: Actor, i: number) {
  const r = PART_REGION[i]!;
  const inj = injurySum(a.injuries[r]);
  const frac = a.injuries[r].fracture;
  if (a.body?.mode === "getup") {
    if (i === P.shinL || i === P.shinR) return 0.000008 * (1 + inj);
    if (i === P.pelvis) return 0.00005 * (1 + inj);
    return 0.00012 * (1 + inj * 2);
  }
  if (a.strikeT > 0 && (i === P.larmR || i === P.uarmR || i === P.spine)) return 0.0000035 * (1 + frac * 8);
  if (a.kickT > 0 && (i === P.shinR || i === P.thighR || i === P.pelvis)) return 0.0000035 * (1 + frac * 8);
  if (a.shoveT > 0 && (i === P.larmL || i === P.larmR || i === P.uarmL || i === P.uarmR || i === P.spine)) {
    return 0.0000045 * (1 + frac * 8);
  }
  if ((a.grabT > 0 || a.grabbedId) && (i === P.larmR || i === P.uarmR || (a.body?.grab && a.body.grab.myPart2 >= 0 && (i === P.larmL || i === P.uarmL)))) {
    return 0.000004 * (1 + frac * 8);
  }
  if (a.flinchT > 0 && a.body && i === a.body.lastHit) return 0.00008 * (1 + inj);
  if (i === P.pelvis) return 0.00000022;
  if (i === P.spine) return 0.000018 * (1 + inj);
  if (i === P.shinL || i === P.shinR) return 0.000012 * (1 + inj * 3 + frac * 12);
  if (i === P.head) return 0.000028 * (1 + inj * 2);
  if (i === P.thighL || i === P.thighR) return 0.000022 * (1 + inj * 3 + frac * 12);
  let c = 0.00004 * (1 + inj * 3 + frac * 14);
  if (a.loco === "stumble") c *= 2.6;
  if (a.grabbedBy) c *= 3.5;
  if (a.body?.grab && (i === P.larmR || i === P.uarmR)) c *= 5;
  return c;
}

function injureImpact(w: World, a: Actor, i: number, vn: number, h: number) {
  if (vn < IMPACT_VN) return;
  const extra = vn - IMPACT_VN;
  const r = PART_REGION[i]!;
  const k = Math.min(1, extra * h * 6);
  a.injuries[r].bruise += k * 0.09;
  if (vn > 4.2 && (r === "lleg" || r === "rleg" || r === "larm" || r === "rarm")) {
    a.injuries[r].sprain += k * 0.07;
  }
  if (vn > 5.2 && r === "head") {
    a.injuries[r].fracture += k * 0.05;
    a.consciousness = clamp(a.consciousness - k * 0.12, 0, 1);
  }
  if (vn > 6 && (r === "lleg" || r === "rleg" || r === "torso")) {
    a.injuries[r].fracture += k * 0.03;
  }
  a.pain = clamp(a.pain + k * 0.06, 0, 1);
  if (a.body) {
    a.body.lastVn = Math.max(a.body.lastVn, vn);
    a.body.lastHit = i;
  }
  if (a.body?.mode === "stance" && vn > 5.4) {
    a.balance = Math.max(0, a.balance - extra * 0.1);
    if (a.balance < 0.18) {
      a.loco = "ragdoll";
      a.locoT = 0.7 + extra * 0.08;
      a.body.mode = "ragdoll";
    } else if (a.balance < 0.48) {
      a.loco = "stumble";
      a.locoT = 0.4;
    }
  }
  if (vn > 4 && w.rng() < 0.35) w.emitSound(a.x, a.z, 0.3 + Math.min(0.5, extra * 0.08), "impact", a.id);
}

function predict(a: Actor, h: number) {
  const body = a.body!;
  const g = -GRAVITY;
  const rag = body.mode !== "stance";
  for (const p of body.parts) {
    p.px = p.x;
    p.py = p.y;
    p.pz = p.z;
    if (rag) {
      p.vy += g * h;
      p.vx *= 0.999;
      p.vy *= 0.999;
      p.vz *= 0.999;
    } else {
      p.vy += g * h * 0.15;
    }
    p.x += p.vx * h;
    p.y += p.vy * h;
    p.z += p.vz * h;
  }
}

function updateVel(body: Physique, h: number) {
  const inv = 1 / h;
  for (const p of body.parts) {
    p.vx = (p.x - p.px) * inv;
    p.vy = (p.y - p.py) * inv;
    p.vz = (p.z - p.pz) * inv;
    const sp = Math.hypot(p.vx, p.vy, p.vz);
    if (sp > 28) {
      const s = 28 / sp;
      p.vx *= s;
      p.vy *= s;
      p.vz *= s;
    }
  }
}

function solveGround(w: World, a: Actor, h: number) {
  const body = a.body!;
  for (let i = 0; i < NPART; i++) {
    const p = body.parts[i]!;
    if (p.y >= p.r) continue;
    const vn = -p.vy;
    p.y = p.r;
    p.vx *= 0.62;
    p.vz *= 0.62;
    if (p.vy < 0) p.vy = 0;
    if (vn > IMPACT_VN) injureImpact(w, a, i, vn, h);
  }
}

function solveAABB(w: World, a: Actor, cols: Collider[], h: number) {
  const body = a.body!;
  for (const p of body.parts) {
    for (const c of cols) {
      if (p.x < c.minX - p.r || p.x > c.maxX + p.r || p.z < c.minZ - p.r || p.z > c.maxZ + p.r) continue;
      if (p.y < c.minY - p.r || p.y > c.maxY + p.r) continue;
      const cx = clamp(p.x, c.minX, c.maxX);
      const cy = clamp(p.y, c.minY, c.maxY);
      const cz = clamp(p.z, c.minZ, c.maxZ);
      let dx = p.x - cx;
      let dy = p.y - cy;
      let dz = p.z - cz;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > p.r * p.r) continue;
      let nx: number, ny: number, nz: number, pen: number;
      if (d2 < 1e-8) {
        const px0 = p.x - c.minX;
        const px1 = c.maxX - p.x;
        const py0 = p.y - c.minY;
        const py1 = c.maxY - p.y;
        const pz0 = p.z - c.minZ;
        const pz1 = c.maxZ - p.z;
        const m = Math.min(px0, px1, py0, py1, pz0, pz1);
        if (m === px0) {
          nx = -1;
          ny = 0;
          nz = 0;
          pen = px0 + p.r;
        } else if (m === px1) {
          nx = 1;
          ny = 0;
          nz = 0;
          pen = px1 + p.r;
        } else if (m === py0) {
          nx = 0;
          ny = -1;
          nz = 0;
          pen = py0 + p.r;
        } else if (m === py1) {
          nx = 0;
          ny = 1;
          nz = 0;
          pen = py1 + p.r;
        } else if (m === pz0) {
          nx = 0;
          ny = 0;
          nz = -1;
          pen = pz0 + p.r;
        } else {
          nx = 0;
          ny = 0;
          nz = 1;
          pen = pz1 + p.r;
        }
      } else {
        const d = Math.sqrt(d2);
        nx = dx / d;
        ny = dy / d;
        nz = dz / d;
        pen = p.r - d;
      }
      p.x += nx * pen;
      p.y += ny * pen;
      p.z += nz * pen;
      const vn = -(p.vx * nx + p.vy * ny + p.vz * nz);
      if (vn > IMPACT_VN) injureImpact(w, a, body.parts.indexOf(p), vn, h);
    }
  }
}

function nearbyCols(w: World, a: Actor): Collider[] {
  const r = 1.9;
  const out: Collider[] = [];
  for (const c of w.colliders) {
    if (!c.solid || c.water) continue;
    if (a.x + r < c.minX || a.x - r > c.maxX || a.z + r < c.minZ || a.z - r > c.maxZ) continue;
    out.push(c);
  }
  return out;
}

function solvePiles(w: World, a: Actor, h: number) {
  if (!a.body) return;
  const parts = a.body.parts;
  const stanceA = a.body.mode === "stance";
  if (!stanceA) {
    for (let i = 0; i < NPART; i++) {
      const pa = parts[i]!;
      for (let j = i + 2; j < NPART; j++) {
        if (BONE_SKIP.has(i * 16 + j) || BONE_SKIP.has(j * 16 + i)) continue;
        if (j - i === 1 && (i === P.uarmL || i === P.uarmR || i === P.thighL || i === P.thighR)) continue;
        solveContact(pa, parts[j]!, h);
      }
    }
  }
  const core = CORE_PARTS;
  for (const o of w.nearby(a.x, a.z, 2.2)) {
    if (o.id <= a.id || !o.body) continue;
    const stanceB = o.body.mode === "stance";
    const listA = stanceA ? core : ALL_PARTS;
    const listB = stanceB ? core : ALL_PARTS;
    for (const i of listA) {
      const pa = a.body.parts[i]!;
      for (const j of listB) {
        const pb = o.body.parts[j]!;
        const vn = solveContact(pa, pb, h);
        if (vn === 0) continue;
        if (stanceA && stanceB) {
          if (vn < -6) {
            injureImpact(w, a, i, -vn, h);
            injureImpact(w, o, j, -vn, h);
          }
          continue;
        }
        if (vn < -IMPACT_VN) {
          injureImpact(w, a, i, -vn, h);
          injureImpact(w, o, j, -vn, h);
        } else if (pa.y > pb.y && PART_REGION[j] === "torso") {
          const crush = Math.max(0, -pa.vy) * h * 0.15;
          if (crush > 0.002) o.injuries.torso.bruise += crush;
        }
      }
    }
  }
}

function solveProps(w: World, a: Actor, h: number) {
  const body = a.body;
  if (!body) return;
  for (const pr of w.props) {
    if (pr.heldBy || pr.kind === "wall" || pr.kind === "roof") continue;
    if (Math.abs(pr.x - a.x) > 2.4 || Math.abs(pr.z - a.z) > 2.4) continue;
    const hx = Math.max(0.12, pr.sx * 0.5);
    const hy = Math.max(0.12, pr.sy);
    const hz = Math.max(0.12, pr.sz * 0.5);
    const minX = pr.x - hx;
    const maxX = pr.x + hx;
    const minY = pr.y;
    const maxY = pr.y + hy;
    const minZ = pr.z - hz;
    const maxZ = pr.z + hz;
    const stance = body.mode === "stance";
    for (let i = 0; i < NPART; i++) {
      if (stance && i !== P.pelvis && i !== P.spine && i !== P.head) continue;
      const p = body.parts[i]!;
      if (p.x < minX - p.r || p.x > maxX + p.r || p.z < minZ - p.r || p.z > maxZ + p.r) continue;
      if (p.y < minY - p.r || p.y > maxY + p.r) continue;
      const cx = clamp(p.x, minX, maxX);
      const cy = clamp(p.y, minY, maxY);
      const cz = clamp(p.z, minZ, maxZ);
      let dx = p.x - cx;
      let dy = p.y - cy;
      let dz = p.z - cz;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > p.r * p.r) continue;
      let nx: number;
      let ny: number;
      let nz: number;
      let pen: number;
      if (d2 < 1e-8) {
        ny = 1;
        nx = 0;
        nz = 0;
        pen = p.r;
      } else {
        const d = Math.sqrt(d2);
        nx = dx / d;
        ny = dy / d;
        nz = dz / d;
        pen = p.r - d;
      }
      p.x += nx * pen;
      p.y += ny * pen;
      p.z += nz * pen;
      const vn = -(p.vx * nx + p.vy * ny + p.vz * nz);
      if (vn > IMPACT_VN) injureImpact(w, a, i, vn, h);
      if (pr.dynamic && !pr.anchored) {
        const rel = 1 / (1 / Math.max(0.5, 1 / p.invM) + pr.mass);
        pr.vx -= nx * vn * rel * 0.8;
        pr.vy -= ny * vn * rel * 0.5;
        pr.vz -= nz * vn * rel * 0.8;
      }
    }
  }
}

function solveGrab(w: World, a: Actor, h: number) {
  const g = a.body?.grab;
  if (!g) return;
  const other = w.actor(g.otherId);
  if (!other?.body || a.grabbedId !== other.id) {
    if (a.body) a.body.grab = null;
    return;
  }
  const pa = a.body!.parts[g.myPart]!;
  const pb = other.body.parts[g.otherPart]!;
  const C = solveDist(pa, pb, g.rest, 0.00018, h);
  let tension = Math.abs(C);
  if (g.myPart2 >= 0 && g.otherPart2 >= 0) {
    const C2 = solveDist(a.body!.parts[g.myPart2]!, other.body.parts[g.otherPart2]!, g.rest + 0.06, 0.00022, h);
    tension = Math.max(tension, Math.abs(C2));
  }
  if (tension > 0.08) {
    const r = PART_REGION[g.otherPart]!;
    other.injuries[r].sprain += tension * h * 0.35;
    a.injuries.rarm.sprain += tension * h * 0.18;
    if (g.myPart2 >= 0) a.injuries.larm.sprain += tension * h * 0.12;
    other.balance = Math.max(0, other.balance - tension * h * 1.8);
    if (other.body.mode === "stance" && (tension > 0.55 || other.balance < 0.28)) {
      other.loco = "ragdoll";
      other.locoT = 0.85;
      other.body.mode = "ragdoll";
    }
  }
  const pull = g.myPart2 >= 0 ? 0.16 : 0.1;
  other.vx += (pa.vx - other.vx) * pull;
  other.vz += (pa.vz - other.vz) * pull;
  a.vx -= (pa.vx - other.vx) * pull * 0.35 * (other.mass / (a.mass + other.mass));
  a.vz -= (pa.vz - other.vz) * pull * 0.35 * (other.mass / (a.mass + other.mass));
  if (other.body.parts[P.shinL]!.y < 0.22 && Math.hypot(other.vx, other.vz) > 1.2) {
    w.tracks.push({ x: other.x, z: other.z, t: w.time, actorId: other.id, kind: "drag", heading: a.yaw });
  }
}

function comOf(body: Physique) {
  let x = 0;
  let y = 0;
  let z = 0;
  let m = 0;
  for (const p of body.parts) {
    const mass = p.invM > 0 ? 1 / p.invM : 1;
    x += p.x * mass;
    y += p.y * mass;
    z += p.z * mass;
    m += mass;
  }
  const inv = m > 0 ? 1 / m : 1;
  return { x: x * inv, y: y * inv, z: z * inv };
}

function evalSupport(a: Actor) {
  const body = a.body!;
  const l = body.parts[P.shinL]!;
  const r = body.parts[P.shinR]!;
  const c = comOf(body);
  const midX = (l.x + r.x) * 0.5;
  const midZ = (l.z + r.z) * 0.5;
  const planted = l.y < 0.38 && r.y < 0.38;
  const offset = Math.hypot(c.x - midX, c.z - midZ);
  const stance = planted ? clamp(1 - offset / 0.42, 0, 1) : clamp(0.25 - offset * 0.4, 0, 0.4);
  body.support = stance;
  return { c, offset, planted, stance };
}

function writeback(a: Actor) {
  const body = a.body!;
  if (body.mode === "stance") {
    const pel = body.parts[P.pelvis]!;
    const t = poseTargets(a)[P.pelvis]!;
    const dx = pel.x - t.x;
    const dz = pel.z - t.z;
    const push = Math.hypot(dx, dz);
    if (push > 0.02) {
      a.x += dx * 0.35;
      a.z += dz * 0.35;
      a.vx += dx * 1.4;
      a.vz += dz * 1.4;
    }
    return;
  }
  const pel = body.parts[P.pelvis]!;
  if (body.mode === "getup") {
    a.x = pel.x;
    a.z = pel.z;
    a.y = Math.max(0, pel.y - PELVIS_H * (a.height / 1.7) * 0.92);
    a.vx = pel.vx * 0.22;
    a.vy = pel.vy * 0.35;
    a.vz = pel.vz * 0.22;
    a.grounded = body.parts[P.shinL]!.y < 0.32 || body.parts[P.shinR]!.y < 0.32;
    return;
  }
  a.x = pel.x;
  a.z = pel.z;
  a.y = Math.max(0, pel.y - PELVIS_H * (a.height / 1.7) * 0.92);
  a.vx = pel.vx;
  a.vy = pel.vy;
  a.vz = pel.vz;
  a.grounded = body.parts[P.shinL]!.y < 0.28 || body.parts[P.shinR]!.y < 0.28 || pel.y < PELVIS_H * 0.55;
  const dx = body.parts[P.spine]!.x - pel.x;
  const dz = body.parts[P.spine]!.z - pel.z;
  if (dx * dx + dz * dz > 0.002) a.yaw = Math.atan2(-dx, -dz);
}

function syncMode(a: Actor) {
  if (!a.body) return;
  if (!a.alive || a.loco === "down" || a.loco === "ragdoll") {
    a.body.mode = "ragdoll";
    return;
  }
  if (a.loco === "getup") a.body.mode = "getup";
  else a.body.mode = "stance";
}

export function stepBodies(w: World, dt: number) {
  ensureBodies(w);
  const h = dt / SUB;
  for (const a of w.actors) {
    if (!a.body) continue;
    syncMode(a);
    a.body.lastVn *= 0.85;
    if (a.body.mode === "stance") {
      const t = poseTargets(a);
      const pel = a.body.parts[P.pelvis]!;
      const q = t[P.pelvis]!;
      if (Math.hypot(pel.x - q.x, pel.z - q.z) > 2.4) snapToPose(a.body, a);
    }
  }
  const colCache = new Map<number, Collider[]>();
  for (let s = 0; s < SUB; s++) {
    for (const a of w.actors) {
      if (!a.body) continue;
      predict(a, h);
    }
    for (let it = 0; it < ITERS; it++) {
      for (const a of w.actors) {
        if (!a.body) continue;
        for (const j of a.body.joints) {
          const pa = a.body.parts[j.a]!;
          const pb = a.body.parts[j.b]!;
          solveDist(pa, pb, j.rest, jointCompliance(a, j), h);
        }
        const hingeC = a.body.mode === "ragdoll" ? 0.00008 : 0.00002;
        for (const [ia, ib, ic, lo, hi] of HINGES) {
          solveHinge(a.body.parts[ia]!, a.body.parts[ib]!, a.body.parts[ic]!, lo, hi, hingeC, h);
        }
        if (a.body.mode !== "ragdoll") {
          const t = poseTargets(a);
          for (let i = 0; i < NPART; i++) {
            const q = t[i]!;
            pin(a.body.parts[i]!, q.x, q.y, q.z, poseCompliance(a, i), h);
          }
        }
        solveGrab(w, a, h);
      }
      for (const a of w.actors) {
        if (!a.body) continue;
        let cols = colCache.get(a.id);
        if (!cols) {
          cols = nearbyCols(w, a);
          colCache.set(a.id, cols);
        }
        solveGround(w, a, h);
        solveAABB(w, a, cols, h);
        solvePiles(w, a, h);
        solveProps(w, a, h);
      }
    }
    for (const a of w.actors) {
      if (!a.body) continue;
      updateVel(a.body, h);
      for (const p of a.body.parts) {
        if (p.y <= p.r + 0.02) {
          if (p.vy > 0) p.vy *= 0.12;
          else p.vy = 0;
          p.vx *= 0.48;
          p.vz *= 0.48;
          p.y = Math.max(p.y, p.r);
        }
      }
      if (a.body.mode !== "stance") {
        for (const p of a.body.parts) {
          p.vx *= 0.985;
          p.vy *= 0.985;
          p.vz *= 0.985;
        }
      }
    }
  }
  for (const a of w.actors) {
    if (!a.body) continue;
    writeback(a);
    const { stance, planted } = evalSupport(a);
    if (a.body.mode === "stance" && a.alive && a.loco !== "vault" && a.loco !== "climb") {
      if (stance < 0.2 && Math.hypot(a.vx, a.vz) > 1.6) {
        a.loco = "stumble";
        a.locoT = 0.45;
        a.balance = Math.min(a.balance, 0.38);
      }
      if (stance < 0.08 && !planted) {
        a.loco = "ragdoll";
        a.locoT = 0.85;
        a.body.mode = "ragdoll";
        a.balance = 0;
      }
    }
    if (a.body.mode === "ragdoll" && a.alive && a.consciousness > 0.25) {
      const pel = a.body.parts[P.pelvis]!;
      const down = pel.y < 0.4;
      const slow = Math.hypot(pel.vx, pel.vz) < 1.45;
      if (a.grounded && down && slow && a.locoT <= 0) {
        a.loco = "getup";
        a.getupT = 0.85 + (1 - a.consciousness) * 0.55;
        a.body.mode = "getup";
      }
    }
    if (a.body.mode === "getup") {
      if ((a.getupT <= 0 && stance > 0.42) || a.getupT < -1.35) {
        a.loco = "idle";
        a.balance = 0.62;
        a.body.mode = "stance";
        snapToPose(a.body, a);
      }
    }
  }
}

export function regionOfPart(i: number): Region {
  return PART_REGION[i] ?? "torso";
}
