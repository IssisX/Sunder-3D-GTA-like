/**
 * Prop frames: rigid bodies for the things in the world that are not people.
 *
 * A prop used to be an axis-aligned box that fell straight down and, on
 * collapse, was drawn with a hardcoded `rotation.z = 0.8`. It could not tumble,
 * could not rest on anything, could not land on anyone, and the `load` and
 * `capacity` fields the data model declared were never read by anything.
 *
 * A frame is a set of nodes held rigid by distance constraints between them.
 * The frames live in the same node store as the bodies, and that is the point:
 * a falling beam meets a shoulder through the same node-vs-node contact that
 * makes two bodies stack, and injures it through the same damage law, rather
 * than through a second physics written for props.
 *
 * Units are SI: m, m/s, kg, s, N*s.
 */

import {
  type Bodies,
  MAX_FRAMES,
  finish,
  frictionOf,
  hardnessOf,
  predict,
  solvePair,
  solveWorld,
} from "./body";
import type { Collider, Prop } from "./types";
import { GRAVITY } from "./types";

/** Most nodes a frame may use; a long prop needs more of them than a crate. */
export const MAX_FRAME_NODES = 10;
/** Node speed ceiling, m/s. Only engages after a solver blow-up. */
const MAX_FRAME_SPEED = 40;
/** Below this centre-of-mass speed for `SLEEP_TIME`, a frame stops solving. */
const SLEEP_SPEED = 0.12;
const SLEEP_TIME = 0.5;
/**
 * How much fatter than its own section a frame may be, dimensionless.
 *
 * Spheres cannot represent a thin slab on a ten-node budget. Past this the
 * frame stops growing and becomes a sparse chain of chunks, which is a better
 * approximation of collapsed rubble than a phantom volume the width of a room.
 */
const FAT_MAX = 2.2;

/**
 * Node layout: a spine of stations along the prop's longest axis, two nodes per
 * station, alternating which cross axis they straddle.
 *
 * Four nodes at the corners of a box is the minimum that fixes an orientation,
 * and it is what a crate needs -- but four spheres cannot cover a beam. Its
 * middle falls between them, so a beam dropped on someone passes straight
 * through and lands on the floor beside them. Stationing nodes ALONG the length
 * is what makes a long prop a long obstacle.
 *
 * Alternating the cross axis (even stations straddle U, odd ones V) keeps the
 * set non-planar -- a flat set of nodes is not rigid, it folds -- and has the
 * useful consequence that each cross axis can be read straight back off one
 * station pair when the orientation is recovered.
 */
interface Layout {
  /** Axis indices in prop-local x/y/z, longest to shortest. */
  L: number;
  U: number;
  V: number;
  /** Half-extents along those axes, m. */
  c: number;
  u: number;
  v: number;
  /** Grid counts along L and U. */
  nL: number;
  nU: number;
  /** Node radius, m, and the offsets that lift nodes off the mid-plane. */
  rad: number;
  offU: number;
  offV: number;
}

function layout(sx: number, sy: number, sz: number): Layout {
  const half = [Math.max(0.02, sx * 0.5), Math.max(0.02, sy * 0.5), Math.max(0.02, sz * 0.5)];
  const ord = [0, 1, 2].sort((a, b) => half[b]! - half[a]!);
  const L = ord[0]!;
  const U = ord[1]!;
  const V = ord[2]!;
  const c = half[L]!;
  const u = half[U]!;
  const v = half[V]!;
  // A sphere that fits inside the thinnest section with room for the offset
  // that lifts nodes off the mid-plane. Larger and the frame is fatter than the
  // prop it stands for: a chest whose spheres reach above its own lid swallows
  // whoever is standing on it, and the solver then has to eject them.
  const fit = v * 0.7;
  const radMax = fit * FAT_MAX;
  const step = 1.4 * fit;
  const needL = Math.ceil((2 * (c - fit)) / step) + 1;
  const needU = Math.ceil((2 * (u - fit)) / step) + 1;
  let nL: number;
  let nU: number;
  if (Math.max(2, needL) * Math.max(1, needU) <= MAX_FRAME_NODES) {
    nL = Math.max(2, needL);
    nU = Math.max(1, needU);
  } else {
    // The budget binds. Spend it in proportion to the extents, so a beam gets
    // one long row and a wall gets a coarse grid rather than a stripe down its
    // middle with nothing near the top or bottom.
    nU = Math.max(1, Math.min(Math.floor(MAX_FRAME_NODES / 2), Math.round(Math.sqrt((MAX_FRAME_NODES * u) / c))));
    nL = Math.max(2, Math.floor(MAX_FRAME_NODES / nU));
  }
  // Radius that leaves no gap between neighbours: rad = spacing/2 with
  // spacing = 2(c - rad)/(n - 1) solves to c/n. Capped, because past a point a
  // sparse chain of chunks is a better lie than a phantom slab.
  let rad = fit;
  if (needL > nL || needU > nU) {
    const rL = nL > 1 ? c / nL : fit;
    const rU = nU > 1 ? u / nU : fit;
    rad = Math.min(radMax, Math.max(fit, rL, rU));
  }
  return {
    L,
    U,
    V,
    c,
    u,
    v,
    nL,
    nU,
    rad,
    offU: Math.max(u * 0.25, u - rad),
    offV: Math.max(v * 0.25, v - rad),
  };
}

/** Local offset of node `n`, written into `out` as prop-local x/y/z. */
function nodeLocal(la: Layout, n: number, out: [number, number, number]) {
  const i = n % la.nL;
  const j = (n / la.nL) | 0;
  const spanL = Math.max(0, la.c - la.rad);
  const spanU = Math.max(0, la.u - la.rad);
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[la.L] = la.nL > 1 ? -spanL + (2 * spanL * i) / (la.nL - 1) : 0;
  if (la.nU > 1) {
    out[la.U] = -spanU + (2 * spanU * j) / (la.nU - 1);
    // Checkerboard off the mid-plane. A flat node set is not rigid: it folds.
    out[la.V] = ((i + j) & 1 ? -1 : 1) * la.offV;
  } else {
    // A single row has to be lifted off BOTH cross axes in turn, or the whole
    // frame is planar and folds about its own length.
    const side = i & 2 ? -1 : 1;
    if (i & 1) out[la.V] = side * la.offV;
    else out[la.U] = side * la.offU;
  }
}

/**
 * Edges of the frame.
 *
 * Along each row, neighbours plus skip-one -- and skip-two as well when the
 * frame is a single row, because a chain constrained only to |i-j| <= 2 still
 * has a dihedral fold at every joint; overlapping four-node sets do not.
 * Across rows, neighbours and both diagonals.
 */
function edges(nL: number, nU: number, out: Int32Array): number {
  let n = 0;
  const cap = out.length >> 1;
  const push = (a: number, b: number) => {
    if (n >= cap) return;
    out[n * 2] = a;
    out[n * 2 + 1] = b;
    n++;
  };
  const ix = (i: number, j: number) => j * nL + i;
  const reach = nU > 1 ? 2 : 3;
  for (let j = 0; j < nU; j++) {
    for (let k = 1; k <= reach; k++) {
      for (let i = 0; i + k < nL; i++) push(ix(i, j), ix(i + k, j));
    }
  }
  for (let j = 0; j + 1 < nU; j++) {
    for (let i = 0; i < nL; i++) push(ix(i, j), ix(i, j + 1));
    for (let i = 0; i + 1 < nL; i++) {
      push(ix(i, j), ix(i + 1, j + 1));
      push(ix(i + 1, j), ix(i, j + 1));
    }
  }
  return n;
}

/** Per-frame bookkeeping, indexed by slot - Bodies.actorCap. */
const propOf = new Int32Array(MAX_FRAMES);
const sleepT = new Float32Array(MAX_FRAMES);
const asleep = new Uint8Array(MAX_FRAMES);
const edgeCount = new Int32Array(MAX_FRAMES);
/**
 * Rest offsets of each node from the frame's centroid, in the prop's own local
 * axes, m. Orientation is recovered by matching the current node cloud against
 * these, which is what keeps `readFrame` independent of how the nodes are laid
 * out.
 */
const restLocal = new Float32Array(MAX_FRAMES * MAX_FRAME_NODES * 3);
const centreY = new Float32Array(MAX_FRAMES);
/** Edge index pairs per frame, flat: slot-local edge e uses [e*2], [e*2+1]. */
const edgeIx = new Int32Array(MAX_FRAMES * 32 * 2);
const scratchEdges = new Int32Array(32 * 2);
const scratchLocal: [number, number, number] = [0, 0, 0];
const awakeList = new Int32Array(MAX_FRAMES);
/** How many of `awakeList` are live this tick. Set by `beginFrames`. */
let awakeCount = 0;

/** Orientation basis, written by `readFrame`; reused, never allocated. */
export const frameBasis = {
  x: 0,
  y: 0,
  z: 0,
  /** Column-major 3x3, columns are the prop's local x, y, z axes in world. */
  m: [1, 0, 0, 0, 1, 0, 0, 0, 1],
};

/**
 * Gives a prop a physical frame at its current box pose.
 *
 * Only props that are actually going to move get one: 150 static wall and fence
 * sections do not need nodes each to stand still, and the ones that collapse
 * get a frame at the moment they do.
 */
export function makeFrame(B: Bodies, p: Prop): number {
  if (p.frame >= 0) return p.frame;
  const slot = B.takeFrame(p.id);
  if (slot < 0) return -1;
  const i = slot - B.actorCap;
  const la = layout(p.sx, p.sy, p.sz);
  const nodes = la.nL * la.nU;
  propOf[i] = p.id;
  sleepT[i] = 0;
  asleep[i] = 0;
  centreY[i] = p.sy * 0.5;

  B.count[slot] = nodes;
  B.scale[slot] = 1;
  B.bodyMass[slot] = Math.max(0.2, p.mass);
  B.backing[slot] = 0; // frames carry their rigidity in `cmass` per node
  B.groundHard[slot] = hardnessOf(p.material);
  B.groundMu[slot] = frictionOf(p.material);
  const base = B.base(slot);
  const cy = Math.cos(p.yaw);
  const sy = Math.sin(p.yaw);
  // The prop's own origin is its base, so the box centre is half a height up.
  const ox = p.x;
  const oy = p.y + p.sy * 0.5;
  const oz = p.z;
  const total = Math.max(0.2, p.mass);
  const nodeMass = total / nodes;
  // Mean principal moment of a uniform box, kg*m^2. Direction-free because the
  // contact normal is not known until the collision happens, and the spread
  // between the principal axes is small next to the spread along the length.
  const inertia = Math.max(
    1e-4,
    (total / 3) * (la.c * la.c + la.u * la.u + la.v * la.v),
  );
  for (let n = 0; n < nodes; n++) {
    nodeLocal(la, n, scratchLocal);
    const lx = scratchLocal[0];
    const ly = scratchLocal[1];
    const lz = scratchLocal[2];
    const r = (i * MAX_FRAME_NODES + n) * 3;
    restLocal[r] = lx;
    restLocal[r + 1] = ly;
    restLocal[r + 2] = lz;
    const k = base + n;
    B.px[k] = ox + lx * cy + lz * sy;
    B.py[k] = oy + ly;
    B.pz[k] = oz - lx * sy + lz * cy;
    B.ox[k] = B.px[k]!;
    B.oy[k] = B.py[k]!;
    B.oz[k] = B.pz[k]!;
    B.rx[k] = B.px[k]!;
    B.ry[k] = B.py[k]!;
    B.rz[k] = B.pz[k]!;
    B.tx[k] = B.px[k]!;
    B.ty[k] = B.py[k]!;
    B.tz[k] = B.pz[k]!;
    B.mass[k] = nodeMass;
    B.invMass[k] = 1 / nodeMass;
    B.rad[k] = la.rad;
    B.patch[k] = la.rad;
    B.region[k] = 1; // torso: frames never take injury, but the field must be valid
    // Contact mass: what this node presents when it strikes something. A rigid
    // body struck at offset r from its centre resists with 1/M + |r x n|^2 / I,
    // so a beam's middle carries nearly all 90 kg and its tip carries a
    // fraction. Using the node's 1/n share instead would make a dropped beam
    // land like a plank of firewood.
    const r2 = lx * lx + ly * ly + lz * lz;
    B.cmass[k] = 1 / (1 / total + r2 / inertia);
    B.vnx[k] = 0;
    B.vny[k] = 0;
    B.vnz[k] = 0;
    B.touched[k] = 0;
    B.jimp[k] = 0;
    B.jtan[k] = 0;
    B.vmax[k] = 0;
    B.vtan[k] = 0;
    B.jhard[k] = 0;
    B.wet[k] = 0;
  }

  const ne = edges(la.nL, la.nU, scratchEdges);
  edgeCount[i] = ne;
  const eoff = i * 32 * 2;
  for (let e = 0; e < ne; e++) {
    const ia = scratchEdges[e * 2]!;
    const ib = scratchEdges[e * 2 + 1]!;
    edgeIx[eoff + e * 2] = ia;
    edgeIx[eoff + e * 2 + 1] = ib;
    const ka = base + ia;
    const kb = base + ib;
    const dx = B.px[ka]! - B.px[kb]!;
    const dy = B.py[ka]! - B.py[kb]!;
    const dz = B.pz[ka]! - B.pz[kb]!;
    B.boneRest[slot * 32 + e] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  p.frame = slot;
  return slot;
}

export function dropFrame(B: Bodies, p: Prop) {
  if (p.frame < 0) return;
  B.giveBackFrame(p.frame);
  p.frame = -1;
}

/** Wakes a sleeping frame, e.g. because something hit it. */
export function wakeFrame(B: Bodies, slot: number) {
  if (slot < B.actorCap) return;
  const i = slot - B.actorCap;
  if (!asleep[i]) return;
  asleep[i] = 0;
  sleepT[i] = 0;
  const b = B.base(slot);
  for (let n = 0; n < B.count[slot]!; n++) {
    const k = b + n;
    B.invMass[k] = B.mass[k]! > 0 ? 1 / B.mass[k]! : 0;
    B.ox[k] = B.px[k]!;
    B.oy[k] = B.py[k]!;
    B.oz[k] = B.pz[k]!;
  }
}

/**
 * A frame that has come to rest stops being integrated but keeps its slot and
 * its nodes: settled debris is still something to stand on, trip over and pile
 * against, so it becomes immovable rather than leaving the solver.
 */
function sleepFrame(B: Bodies, slot: number) {
  const i = slot - B.actorCap;
  if (asleep[i]) return;
  asleep[i] = 1;
  const b = B.base(slot);
  for (let n = 0; n < B.count[slot]!; n++) {
    const k = b + n;
    B.invMass[k] = 0;
    B.ox[k] = B.px[k]!;
    B.oy[k] = B.py[k]!;
    B.oz[k] = B.pz[k]!;
  }
}

export function isAsleep(B: Bodies, slot: number) {
  return slot >= B.actorCap && asleep[slot - B.actorCap] === 1;
}

/** Rigid distance constraints. One projection per edge per substep. */
export function solveFrame(B: Bodies, slot: number) {
  const i = slot - B.actorCap;
  const base = B.base(slot);
  const eoff = i * 32 * 2;
  const roff = slot * 32;
  const ne = edgeCount[i]!;
  for (let e = 0; e < ne; e++) {
    const ka = base + edgeIx[eoff + e * 2]!;
    const kb = base + edgeIx[eoff + e * 2 + 1]!;
    const dx = B.px[ka]! - B.px[kb]!;
    const dy = B.py[ka]! - B.py[kb]!;
    const dz = B.pz[ka]! - B.pz[kb]!;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < 1e-12) continue;
    const d = Math.sqrt(d2);
    const C = d - B.boneRest[roff + e]!;
    const wa = B.invMass[ka]!;
    const wb = B.invMass[kb]!;
    const wSum = wa + wb;
    if (wSum <= 0) continue;
    const s = C / (d * wSum);
    B.px[ka] = B.px[ka]! - dx * s * wa;
    B.py[ka] = B.py[ka]! - dy * s * wa;
    B.pz[ka] = B.pz[ka]! - dz * s * wa;
    B.px[kb] = B.px[kb]! + dx * s * wb;
    B.py[kb] = B.py[kb]! + dy * s * wb;
    B.pz[kb] = B.pz[kb]! + dz * s * wb;
  }
}

/**
 * Reads a frame's centre and orientation back out of its node positions.
 *
 * The rotation is the orthogonal factor of the matrix that best maps the rest
 * node cloud onto the current one -- shape matching, recovered by iterating
 * R <- (R + R^-T)/2, which converges on the polar decomposition. Deriving the
 * axes from named nodes instead would tie the reader to one node layout, and
 * the layout has to be free to differ between a crate, a beam and a wall.
 *
 * `alpha` interpolates between the tick's start and end positions, for render.
 */
export function readFrame(B: Bodies, slot: number, alpha: number) {
  const i = slot - B.actorCap;
  const b = B.base(slot);
  const n = B.count[slot]!;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let j = 0; j < n; j++) {
    const k = b + j;
    cx += B.rx[k]! + (B.px[k]! - B.rx[k]!) * alpha;
    cy += B.ry[k]! + (B.py[k]! - B.ry[k]!) * alpha;
    cz += B.rz[k]! + (B.pz[k]! - B.rz[k]!) * alpha;
  }
  frameBasis.x = cx / n;
  frameBasis.y = cy / n;
  frameBasis.z = cz / n;

  // A = sum over nodes of (world offset) (rest offset)^T, column-major, so
  // A[col*3 + row]. Column c is the image of the prop's local c axis.
  for (let e = 0; e < 9; e++) fitA[e] = 0;
  for (let j = 0; j < n; j++) {
    const k = b + j;
    const wx = B.rx[k]! + (B.px[k]! - B.rx[k]!) * alpha - frameBasis.x;
    const wy = B.ry[k]! + (B.py[k]! - B.ry[k]!) * alpha - frameBasis.y;
    const wz = B.rz[k]! + (B.pz[k]! - B.rz[k]!) * alpha - frameBasis.z;
    const r = (i * MAX_FRAME_NODES + j) * 3;
    const lx = restLocal[r]!;
    const ly = restLocal[r + 1]!;
    const lz = restLocal[r + 2]!;
    fitA[0] += wx * lx;
    fitA[1] += wy * lx;
    fitA[2] += wz * lx;
    fitA[3] += wx * ly;
    fitA[4] += wy * ly;
    fitA[5] += wz * ly;
    fitA[6] += wx * lz;
    fitA[7] += wy * lz;
    fitA[8] += wz * lz;
  }
  if (!polar(fitA, frameBasis.m)) {
    frameBasis.m[0] = 1;
    frameBasis.m[1] = 0;
    frameBasis.m[2] = 0;
    frameBasis.m[3] = 0;
    frameBasis.m[4] = 1;
    frameBasis.m[5] = 0;
    frameBasis.m[6] = 0;
    frameBasis.m[7] = 0;
    frameBasis.m[8] = 1;
  }
}

const fitA = new Float64Array(9);
const polarR = new Float64Array(9);
const polarI = new Float64Array(9);

function det3(m: Float64Array) {
  return (
    m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
    m[3]! * (m[1]! * m[8]! - m[2]! * m[7]!) +
    m[6]! * (m[1]! * m[5]! - m[2]! * m[4]!)
  );
}

/**
 * Orthogonal factor of `A`, written to `out` (column-major 3x3).
 *
 * Iterates R <- (R + R^-T)/2 from R = A. Each step halves the distance to the
 * nearest rotation, and six are far more than a nearly-rigid frame ever needs.
 * Returns false when `A` is singular -- a frame collapsed onto a plane or a
 * line, which has no orientation to read.
 */
function polar(A: Float64Array, out: number[]): boolean {
  for (let e = 0; e < 9; e++) polarR[e] = A[e]!;
  let d = det3(polarR);
  if (!(Math.abs(d) > 1e-12)) return false;
  for (let iter = 0; iter < 6; iter++) {
    d = det3(polarR);
    if (!(Math.abs(d) > 1e-18)) return false;
    // R^-T, column-major: the cofactor matrix over the determinant.
    const inv = 1 / d;
    polarI[0] = (polarR[4]! * polarR[8]! - polarR[5]! * polarR[7]!) * inv;
    polarI[1] = (polarR[5]! * polarR[6]! - polarR[3]! * polarR[8]!) * inv;
    polarI[2] = (polarR[3]! * polarR[7]! - polarR[4]! * polarR[6]!) * inv;
    polarI[3] = (polarR[2]! * polarR[7]! - polarR[1]! * polarR[8]!) * inv;
    polarI[4] = (polarR[0]! * polarR[8]! - polarR[2]! * polarR[6]!) * inv;
    polarI[5] = (polarR[1]! * polarR[6]! - polarR[0]! * polarR[7]!) * inv;
    polarI[6] = (polarR[1]! * polarR[5]! - polarR[2]! * polarR[4]!) * inv;
    polarI[7] = (polarR[2]! * polarR[3]! - polarR[0]! * polarR[5]!) * inv;
    polarI[8] = (polarR[0]! * polarR[4]! - polarR[1]! * polarR[3]!) * inv;
    let move = 0;
    for (let e = 0; e < 9; e++) {
      const next = 0.5 * (polarR[e]! + polarI[e]!);
      move += Math.abs(next - polarR[e]!);
      polarR[e] = next;
    }
    if (move < 1e-9) break;
  }
  for (let e = 0; e < 9; e++) out[e] = polarR[e]!;
  return true;
}

/**
 * Quaternion from the basis in `frameBasis`, via Shepperd's method: pick the
 * largest of the four candidate divisors so the square root is never taken of
 * something near zero, which is where the naive trace formula loses precision
 * or fails outright on a half-turn.
 */
export function frameQuat(out: { qx: number; qy: number; qz: number; qw: number }) {
  const m = frameBasis.m;
  const m00 = m[0]!;
  const m10 = m[1]!;
  const m20 = m[2]!;
  const m01 = m[3]!;
  const m11 = m[4]!;
  const m21 = m[5]!;
  const m02 = m[6]!;
  const m12 = m[7]!;
  const m22 = m[8]!;
  const tr = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let wq: number;
  if (tr > 0) {
    const sq = Math.sqrt(tr + 1) * 2;
    wq = 0.25 * sq;
    x = (m21 - m12) / sq;
    y = (m02 - m20) / sq;
    z = (m10 - m01) / sq;
  } else if (m00 > m11 && m00 > m22) {
    const sq = Math.sqrt(1 + m00 - m11 - m22) * 2;
    wq = (m21 - m12) / sq;
    x = 0.25 * sq;
    y = (m01 + m10) / sq;
    z = (m02 + m20) / sq;
  } else if (m11 > m22) {
    const sq = Math.sqrt(1 + m11 - m00 - m22) * 2;
    wq = (m02 - m20) / sq;
    x = (m01 + m10) / sq;
    y = 0.25 * sq;
    z = (m12 + m21) / sq;
  } else {
    const sq = Math.sqrt(1 + m22 - m00 - m11) * 2;
    wq = (m10 - m01) / sq;
    x = (m02 + m20) / sq;
    y = (m12 + m21) / sq;
    z = 0.25 * sq;
  }
  const n = Math.hypot(x, y, z, wq) || 1;
  out.qx = x / n;
  out.qy = y / n;
  out.qz = z / n;
  out.qw = wq / n;
}

/**
 * One tick of every prop frame, in the same order and with the same solver as
 * the bodies. Fills `all` with the slots in play and returns how many.
 */
/**
 * Phase 1 of the frame step: snapshot, refresh the near-collider cache, and
 * build the awake list. Returns the number of live frames written to `all`.
 *
 * The step is split into phases so that the caller can interleave it with the
 * actor solve rather than running it afterwards. Running the two solvers back
 * to back is what made a falling beam unable to hurt anyone: the contact was
 * resolved after the tick had already turned impulses into injury, and the
 * next tick's snapshot wiped it before it was ever read.
 */
export function beginFrames(
  B: Bodies,
  props: Prop[],
  colliders: Collider[],
  all: Int32Array,
): number {
  let n = 0;
  awakeCount = 0;
  for (const p of props) {
    if (p.frame < 0) continue;
    if (n >= all.length) break;
    const slot = p.frame;
    B.snapshot(slot);
    // Settled debris keeps its slot and its nodes so it is still something to
    // stand on and trip over; it just stops being integrated.
    if (!asleep[slot - B.actorCap]) {
      B.refreshNear(slot, colliders, p.x, p.z, Math.max(p.sx, p.sy, p.sz) * 0.6 + 0.3);
      awakeList[awakeCount++] = slot;
    }
    all[n++] = slot;
  }
  return n;
}

/** Integrates the awake frames one substep forward. */
export function predictFrames(B: Bodies, h: number) {
  for (let j = 0; j < awakeCount; j++) predict(B, awakeList[j]!, h, GRAVITY);
}

/** Projects rigidity and the world for one substep, then frame against frame. */
export function solveFrames(
  B: Bodies,
  all: Int32Array,
  n: number,
  colliders: Collider[],
  h: number,
) {
  for (let j = 0; j < awakeCount; j++) solveFrame(B, awakeList[j]!);
  for (let j = 0; j < awakeCount; j++) solveWorld(B, awakeList[j]!, colliders, h, 0);
  // Frame against frame: crates stack, beams cross, debris heaps. Sleeping
  // frames take part as immovable ones, which is what lets a heap hold.
  for (let j = 0; j < awakeCount; j++) {
    const sa = awakeList[j]!;
    for (let k = 0; k < n; k++) {
      const sb = all[k]!;
      if (sb === sa) continue;
      if (sb < sa && !asleep[sb - B.actorCap]) continue; // awake pairs solved once
      if (!nearEnough(B, sa, sb)) continue;
      const load = solvePair(B, sa, sb, h, hardnessOf("wood"));
      B.pileLoad[sa] = B.pileLoad[sa]! + load;
    }
  }
}

/** Clamps frame node speed at the end of a substep. */
export function finishFrames(B: Bodies, h: number) {
  for (let j = 0; j < awakeCount; j++) finish(B, awakeList[j]!, h, MAX_FRAME_SPEED);
}

/** Writes the solved pose back onto the props and decides what may rest. */
export function endFrames(B: Bodies, props: Prop[], dt: number, substeps: number) {
  const h = dt / substeps;
  for (const p of props) {
    if (p.frame < 0) continue;
    const slot = p.frame;
    const i = slot - B.actorCap;
    if (asleep[i]) continue;
    B.updateCom(slot, h);
    readFrame(B, slot, 1);
    p.x = frameBasis.x;
    p.y = frameBasis.y - centreY[i]!;
    p.z = frameBasis.z;
    // Yaw for the code that still reasons about an axis-aligned prop.
    p.yaw = Math.atan2(frameBasis.m[2]!, frameBasis.m[0]!);
    p.vx = B.comVX[slot]!;
    p.vy = B.comVY[slot]!;
    p.vz = B.comVZ[slot]!;
    p.load = B.pileLoad[slot]!;
    frameQuat(p);
    const speed = Math.hypot(p.vx, p.vy, p.vz);
    if (speed < SLEEP_SPEED) {
      sleepT[i] += dt;
      if (sleepT[i]! > SLEEP_TIME) sleepFrame(B, slot);
    } else {
      sleepT[i] = 0;
    }
  }
}

function nearEnough(B: Bodies, sa: number, sb: number) {
  const ba = B.base(sa);
  const bb = B.base(sb);
  const dx = B.px[ba]! - B.px[bb]!;
  const dz = B.pz[ba]! - B.pz[bb]!;
  const dy = B.py[ba]! - B.py[bb]!;
  return dx * dx + dy * dy + dz * dz < 49;
}

export function framePropId(B: Bodies, slot: number) {
  return slot >= B.actorCap ? propOf[slot - B.actorCap]! : 0;
}
