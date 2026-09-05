import assert from 'node:assert/strict';
import type { Actions } from '../../src/game/input';
import { STEP } from '../../src/game/types';
import { World } from '../../src/game/world';
import { stepWorld } from '../../src/game/sim';
import {
  EDGES,
  agentPhaseOffset,
  agentRandom,
  agentSpeedScale,
  agentTempoScale,
  prepareAgent,
  resetAgentIndependence,
} from '../../src/game/agent-independence';

const ZERO = {
  moveX: 0, moveY: 0, lookX: 0, lookY: 0,
} as Actions;

function fixture(independent: boolean) {
  EDGES.independentAgentState = independent;
  resetAgentIndependence();
  const w = new World();
  w.seed = 24681357;
  const p = w.addActor({
    kind: 'player', species: 'human', faction: 'player',
    x: 30, z: 30,
  });
  w.playerId = p.id;
  const agents = [0, 1, 2].map((i) => w.addActor({
    kind: 'beast', species: 'cow', faction: 'wild',
    x: -20, z: -8 + i * 4,
    homeX: -20, homeZ: -8 + i * 4,
    wayX: 20, wayZ: -8 + i * 4,
    aiT: 2,
  }));
  for (const a of agents) prepareAgent(w, a);
  const profiles = agents.map((a) => ({
    phase: agentPhaseOffset(a),
    speed: agentSpeedScale(a),
    tempo: agentTempoScale(a),
    random: agentRandom(w, a),
  }));
  stepWorld(w, STEP, ZERO, { yaw: 0, pitch: 0 }, false);
  return {
    profiles,
    intents: agents.map((a) => a.intendSpeed),
    timers: agents.map((a) => a.aiT),
  };
}

const normal = fixture(true);
const replay = fixture(true);
const severed = fixture(false);
EDGES.independentAgentState = true;
resetAgentIndependence();

assert.equal(new Set(normal.profiles.map((p) => p.phase.toFixed(6))).size, 3,
  'agents share one phase offset');
assert.equal(new Set(normal.intents.map((v) => v.toFixed(6))).size, 3,
  'agents share one movement speed');
assert.equal(new Set(normal.timers.map((v) => v.toFixed(6))).size, 3,
  'agents share one decision cadence');
assert.deepEqual(normal, replay,
  'same seeded replay does not reproduce independent agent streams');
assert.equal(new Set(severed.profiles.map((p) => p.phase.toFixed(6))).size, 1,
  'severing independence does not collapse phase');
assert.equal(new Set(severed.intents.map((v) => v.toFixed(6))).size, 1,
  'severing independence does not collapse movement speed');

console.log('PASS agent independence', { normal, severed });
