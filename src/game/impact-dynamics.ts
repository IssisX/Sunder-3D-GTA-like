import type { Actor, Region } from "./types";
import type { World } from "./world";
import {
  BODY,
  BODY_NODE_COUNT,
  LINK_DEFS,
  bodyScale,
  representativeNode,
  type BodyRig,
} from "./body-model";

const ENTITY_ID_CAP = 8192;
const BODY_CAP = 128;
const STRIDE = BODY_NODE_COUNT;
const MIN_DT = 1 / 240;
const MAX_DT = 1 / 30;

interface BodyAccess {
  get(a: Actor): BodyRig | undefined;
}

function buildCoupling() {
  const n = BODY_NODE_COUNT;
  const hops = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  hops.fill(99);
  for (let i = 0; i < n; i++) hops[i * n + i] = 0;
  for (let i = 0; i < LINK_DEFS.length; i++) {
    const a = LINK_DEFS[i]![0];
    const b = LINK_DEFS[i]![1];
    hops[a * n + b] = 1;
    hops[b * n + a] = 1;
  }
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const ik = hops[i * n + k]!;
      for (let j = 0; j < n; j++) {
        const d = ik + hops[k * n + j]!;
        const q = i * n + j;
        if (d < hops[q]!) hops[q] = d;
      }
    }
  }
  for (let i = 0; i < out.length; i++) {
    const h = hops[i]!;
    out[i] = h >= 90 ? 0 : Math.exp(-0.72 * h);
  }
  return out;
}

const COUPLING = buildCoupling();

function human(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

/**
 * Zero-allocation articulated contact response.
 *
 * Contact impulses are distributed over the anatomical constraint graph and
 * augmented with the angular velocity implied by r x J about the pelvis.
 * The resulting per-node velocity field is injected after the pose solver;
 * the normal follow controller supplies the restoring spring while dynamic
 * modes naturally inherit the injected motion on the next Verlet step.
 */
export class ImpactDynamics {
  private bodies: BodyAccess | null = null;
  private readonly slotById = new Int16Array(ENTITY_ID_CAP);
  private readonly actorId = new Int32Array(BODY_CAP);
  private readonly vx = new Float32Array(BODY_CAP * STRIDE);
  private readonly vy = new Float32Array(BODY_CAP * STRIDE);
  private readonly vz = new Float32Array(BODY_CAP * STRIDE);
  private slotCount = 0;

  constructor() {
    this.slotById.fill(-1);
  }

  bind(bodies: BodyAccess) {
    this.bodies = bodies;
  }

  bootstrap(w: World) {
    this.clear();
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (human(a)) this.register(a);
    }
  }

  clear() {
    this.slotById.fill(-1);
    this.actorId.fill(0);
    this.vx.fill(0);
    this.vy.fill(0);
    this.vz.fill(0);
    this.slotCount = 0;
  }

  reset(a: Actor) {
    const slot = this.slot(a.id);
    if (slot < 0) return;
    const base = slot * STRIDE;
    this.vx.fill(0, base, base + STRIDE);
    this.vy.fill(0, base, base + STRIDE);
    this.vz.fill(0, base, base + STRIDE);
  }

  contactRegion(
    a: Actor,
    region: Region,
    dvx: number,
    dvy: number,
    dvz: number,
    gain = 1,
  ) {
    this.contactNode(a, representativeNode(region), dvx, dvy, dvz, gain);
  }

  contactNode(
    a: Actor,
    node: number,
    dvx: number,
    dvy: number,
    dvz: number,
    gain = 1,
  ) {
    if (!human(a) || !a.alive || node < 0 || node >= BODY_NODE_COUNT) return;
    const rig = this.bodies?.get(a);
    if (!rig?.initialized) return;
    let slot = this.slot(a.id);
    if (slot < 0) slot = this.register(a);
    if (slot < 0) return;

    const speed = Math.hypot(dvx, dvy, dvz);
    if (speed < 0.02) return;
    const capped = Math.min(8.5, speed) / speed;
    dvx *= capped * gain;
    dvy *= capped * gain;
    dvz *= capped * gain;

    const pelvisX = rig.x[BODY.pelvis]!;
    const pelvisY = rig.y[BODY.pelvis]!;
    const pelvisZ = rig.z[BODY.pelvis]!;
    const rx = rig.x[node]! - pelvisX;
    const ry = rig.y[node]! - pelvisY;
    const rz = rig.z[node]! - pelvisZ;

    // Angular velocity proxy from tau = r x J, normalized by a compact-body
    // inertia estimate. This is deliberately bounded; constraints remain the
    // authority for anatomy while torque makes off-center impacts readable.
    const scale = bodyScale(a);
    const invI = 1 / Math.max(0.2, 0.38 * scale * scale);
    const wx = (ry * dvz - rz * dvy) * invI * 0.28;
    const wy = (rz * dvx - rx * dvz) * invI * 0.28;
    const wz = (rx * dvy - ry * dvx) * invI * 0.28;
    const base = slot * STRIDE;

    for (let j = 0; j < BODY_NODE_COUNT; j++) {
      const coupling = COUPLING[node * BODY_NODE_COUNT + j]!;
      const linear = (0.08 + coupling * 0.92);
      const jx = rig.x[j]! - pelvisX;
      const jy = rig.y[j]! - pelvisY;
      const jz = rig.z[j]! - pelvisZ;
      const rvx = wy * jz - wz * jy;
      const rvy = wz * jx - wx * jz;
      const rvz = wx * jy - wy * jx;
      const rotational = (0.18 + coupling * 0.32);
      const q = base + j;
      this.vx[q] += dvx * linear + rvx * rotational;
      this.vy[q] += dvy * linear + rvy * rotational;
      this.vz[q] += dvz * linear + rvz * rotational;
    }

    // Immediate local compression gives the exact contact point a readable
    // first-frame response before momentum spreads through the graph.
    const invSpeed = 1 / speed;
    const compression = Math.min(0.045 * scale, speed * 0.0055 * scale) * gain;
    rig.x[node] += dvx * invSpeed * compression;
    rig.y[node] += dvy * invSpeed * compression;
    rig.z[node] += dvz * invSpeed * compression;
  }

  step(w: World, dt: number) {
    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a)) continue;
      const slot = this.slot(a.id);
      if (slot < 0) continue;
      const rig = this.bodies?.get(a);
      if (!rig?.initialized) continue;

      const damping = rig.mode === "follow" ? 13.5 : rig.mode === "stumble" ? 9 : 6.5;
      const decay = Math.exp(-damping * h);
      const maxStep = 0.085 * bodyScale(a);
      const base = slot * STRIDE;

      for (let node = 0; node < BODY_NODE_COUNT; node++) {
        const q = base + node;
        let vx = this.vx[q]!;
        let vy = this.vy[q]!;
        let vz = this.vz[q]!;
        const stepMag = Math.hypot(vx, vy, vz) * h;
        if (stepMag > maxStep) {
          const s = maxStep / stepMag;
          vx *= s;
          vy *= s;
          vz *= s;
        }
        rig.x[node] += vx * h;
        rig.y[node] += vy * h;
        rig.z[node] += vz * h;
        vx *= decay;
        vy *= decay;
        vz *= decay;
        if (Math.abs(vx) < 0.006) vx = 0;
        if (Math.abs(vy) < 0.006) vy = 0;
        if (Math.abs(vz) < 0.006) vz = 0;
        this.vx[q] = vx;
        this.vy[q] = vy;
        this.vz[q] = vz;
      }
    }
  }

  private slot(id: number) {
    return id < 0 || id >= ENTITY_ID_CAP ? -1 : this.slotById[id]!;
  }

  private register(a: Actor) {
    if (a.id < 0 || a.id >= ENTITY_ID_CAP || this.slotCount >= BODY_CAP) return -1;
    const existing = this.slotById[a.id]!;
    if (existing >= 0) return existing;
    const slot = this.slotCount++;
    this.slotById[a.id] = slot;
    this.actorId[slot] = a.id;
    return slot;
  }
}

export const impactDynamics = new ImpactDynamics();
