import type { Actor } from "./types";
import type { World } from "./world";
import {
  BODY_NODE_COUNT,
  bodyScale,
  type BodyRig,
} from "./body-model";

const ENTITY_ID_CAP = 8192;
const BODY_CAP = 128;
const STRIDE = BODY_NODE_COUNT;

export const TASK_PRIORITY = {
  LOCOMOTION: 10,
  CORRECTIVE_STEP: 14,
  ACTION: 20,
  CONTACT_CRITICAL: 28,
} as const;

/**
 * Zero-allocation task-space target buffer.
 *
 * Producers describe desired body geometry here before the physical solve.
 * ActiveBodyControl consumes the same targets as velocity-space actuation.
 * Nothing in this module is allowed to move solved body nodes directly.
 */
class BodyTaskTargets {
  private readonly slotById = new Int16Array(ENTITY_ID_CAP);
  private readonly actorId = new Int32Array(BODY_CAP);
  private readonly x = new Float32Array(BODY_CAP * STRIDE);
  private readonly y = new Float32Array(BODY_CAP * STRIDE);
  private readonly z = new Float32Array(BODY_CAP * STRIDE);
  private readonly weight = new Float32Array(BODY_CAP * STRIDE);
  private readonly priority = new Uint8Array(BODY_CAP * STRIDE);
  private slotCount = 0;

  constructor() {
    this.slotById.fill(-1);
  }

  bootstrap(w: World) {
    this.clear();
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (a.kind === "player" || a.species === "human") this.register(a);
    }
  }

  clear() {
    this.slotById.fill(-1);
    this.actorId.fill(0);
    this.weight.fill(0);
    this.priority.fill(0);
    this.slotCount = 0;
  }

  beginStep() {
    this.weight.fill(0, 0, this.slotCount * STRIDE);
    this.priority.fill(0, 0, this.slotCount * STRIDE);
  }

  offerWorld(
    a: Actor,
    node: number,
    tx: number,
    ty: number,
    tz: number,
    strength: number,
    priority: number,
  ) {
    if (node < 0 || node >= STRIDE || strength <= 0) return;
    let slot = this.slot(a.id);
    if (slot < 0) slot = this.register(a);
    if (slot < 0) return;
    const q = slot * STRIDE + node;
    if (priority < this.priority[q]!) return;
    this.priority[q] = priority;
    this.weight[q] = strength < 1 ? strength : 1;
    this.x[q] = tx;
    this.y[q] = ty;
    this.z[q] = tz;
  }

  offerLocal(
    a: Actor,
    node: number,
    lx: number,
    ly: number,
    lz: number,
    strength: number,
    priority: number,
  ) {
    const scale = bodyScale(a);
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    const rx = Math.cos(a.yaw);
    const rz = -Math.sin(a.yaw);
    this.offerWorld(
      a,
      node,
      a.x + rx * lx * scale + fx * lz * scale,
      a.y + ly * scale,
      a.z + rz * lx * scale + fz * lz * scale,
      strength,
      priority,
    );
  }

  apply(a: Actor, rig: BodyRig) {
    const slot = this.slot(a.id);
    if (slot < 0) return;
    const base = slot * STRIDE;
    for (let node = 0; node < STRIDE; node++) {
      const q = base + node;
      const w = this.weight[q]!;
      if (w <= 0) continue;
      rig.tx[node] += (this.x[q]! - rig.tx[node]!) * w;
      rig.ty[node] += (this.y[q]! - rig.ty[node]!) * w;
      rig.tz[node] += (this.z[q]! - rig.tz[node]!) * w;
    }
  }

  priorityFor(a: Actor, node: number) {
    const q = this.index(a.id, node);
    return q < 0 ? 0 : this.priority[q]!;
  }

  weightFor(a: Actor, node: number) {
    const q = this.index(a.id, node);
    return q < 0 ? 0 : this.weight[q]!;
  }

  targetXFor(a: Actor, node: number) {
    const q = this.index(a.id, node);
    return q < 0 ? 0 : this.x[q]!;
  }

  targetYFor(a: Actor, node: number) {
    const q = this.index(a.id, node);
    return q < 0 ? 0 : this.y[q]!;
  }

  targetZFor(a: Actor, node: number) {
    const q = this.index(a.id, node);
    return q < 0 ? 0 : this.z[q]!;
  }

  private index(id: number, node: number) {
    if (node < 0 || node >= STRIDE) return -1;
    const slot = this.slot(id);
    return slot < 0 ? -1 : slot * STRIDE + node;
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

export const bodyTaskTargets = new BodyTaskTargets();
