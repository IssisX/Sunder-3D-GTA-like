import type { Actor } from "./types";
import type { World } from "./world";

const ENTITY_ID_CAP = 8192;
const UINT32_SCALE = 1 / 4294967296;

/** Causal edge for the anti-lockstep falsifier. */
export const EDGES = {
  independentAgentState: true,
};

const initialized = new Uint8Array(ENTITY_ID_CAP);
const rngState = new Uint32Array(ENTITY_ID_CAP);
const phaseOffset = new Float32Array(ENTITY_ID_CAP);
const speedScale = new Float32Array(ENTITY_ID_CAP);
const tempoScale = new Float32Array(ENTITY_ID_CAP);
let ownerWorld: World | null = null;
let sessionSeed = 1;

function mix32(v: number) {
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d);
  v = Math.imul(v ^ (v >>> 15), 0x846ca68b);
  return (v ^ (v >>> 16)) >>> 0;
}

function speciesSalt(a: Actor) {
  switch (a.species) {
    case "human": return 0x243f6a88;
    case "goat": return 0x85a308d3;
    case "pig": return 0x13198a2e;
    case "cow": return 0x03707344;
    case "deer": return 0xa4093822;
    case "wolf": return 0x299f31d0;
    case "bear": return 0x082efa98;
  }
}

function resetForWorld(w: World) {
  if (ownerWorld === w) return;
  ownerWorld = w;
  initialized.fill(0);
  sessionSeed = mix32((w.seed >>> 0) ^ 0x9e3779b9) || 1;
}

function nextState(id: number) {
  let x = rngState[id]! >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  if (x === 0) x = 0x6d2b79f5;
  rngState[id] = x;
  return x;
}

export function prepareAgent(w: World, a: Actor) {
  if (a.kind === "player" || a.id < 0 || a.id >= ENTITY_ID_CAP) return;
  resetForWorld(w);
  if (initialized[a.id]) return;

  const seed = EDGES.independentAgentState
    ? mix32(sessionSeed ^ Math.imul(a.id + 1, 0x9e3779b1) ^ speciesSalt(a))
    : mix32(sessionSeed ^ 0x51ed270b);
  rngState[a.id] = seed || 0x6d2b79f5;

  const p = nextState(a.id) * UINT32_SCALE;
  const s = nextState(a.id) * UINT32_SCALE;
  const t = nextState(a.id) * UINT32_SCALE;
  phaseOffset[a.id] = EDGES.independentAgentState ? p : 0.5;
  speedScale[a.id] = EDGES.independentAgentState ? 0.9 + s * 0.2 : 1;
  tempoScale[a.id] = EDGES.independentAgentState ? 0.86 + t * 0.28 : 1;
  initialized[a.id] = 1;

  // First decision timing is part of the agent's own state rather than a
  // synchronized world tick. Existing explicit timers remain authoritative.
  if (a.aiT <= 0) a.aiT = phaseOffset[a.id]! * 0.8;
}

export function agentRandom(w: World, a: Actor) {
  prepareAgent(w, a);
  if (a.kind === "player" || a.id < 0 || a.id >= ENTITY_ID_CAP) return 0.5;
  return nextState(a.id) * UINT32_SCALE;
}

export function agentSpeedScale(a: Actor) {
  if (a.kind === "player" || a.id < 0 || a.id >= ENTITY_ID_CAP) return 1;
  return initialized[a.id] ? speedScale[a.id]! : 1;
}

export function agentTempoScale(a: Actor) {
  if (a.kind === "player" || a.id < 0 || a.id >= ENTITY_ID_CAP) return 1;
  return initialized[a.id] ? tempoScale[a.id]! : 1;
}

export function agentPhaseOffset(a: Actor) {
  if (a.kind === "player" || a.id < 0 || a.id >= ENTITY_ID_CAP) return 0;
  return initialized[a.id] ? phaseOffset[a.id]! : 0;
}

export function resetAgentIndependence() {
  ownerWorld = null;
  initialized.fill(0);
}
