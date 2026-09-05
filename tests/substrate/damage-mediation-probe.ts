import assert from 'node:assert/strict';
import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';
import { BODY, makeRig, nodeRadius, resetRig } from '../../src/game/body-model';
import { collideRig } from '../../src/game/body-contacts';
import { EDGES } from '../../src/game/impact-mediation';

function sample(speed: number, threshold: boolean) {
  const w = new World();
  w.seed = 12345;
  buildLevel(w);
  const p = w.player();
  w.actors = [p];
  w.props = [];
  w.colliders = [];
  w.buildings = [];
  w.fuel.fill(0);

  const rig = makeRig();
  resetRig(p, rig);
  const node = BODY.chest;
  const radius = nodeRadius(p, node);
  rig.y[node] = radius - 0.01;
  rig.py[node] = rig.y[node]! + speed * STEP;
  rig.impactCd[node] = 0;

  const prior = EDGES.damageThreshold;
  EDGES.damageThreshold = threshold;
  try {
    collideRig(w, p, rig, STEP, true);
  } finally {
    EDGES.damageThreshold = prior;
  }

  return {
    bruise: p.injuries.torso.bruise,
    pain: p.pain,
    grounded: rig.groundedNodes > 0,
  };
}

const gentle = sample(1.0, true);
const hard = sample(6.0, true);
const severed = sample(1.0, false);
console.log('DAMAGE-MEDIATION', { gentle, hard, severed });

assert(gentle.grounded,
  'gentle collision did not resolve as contact');
assert.equal(gentle.bruise, 0,
  'gentle contact produced bruise damage');
assert.equal(gentle.pain, 0,
  'gentle contact produced hurt/pain');
assert(hard.bruise > 0 && hard.pain > 0,
  'high-energy collision failed to produce damage');
assert(severed.bruise > gentle.bruise,
  'damage-threshold severance does not change collision damage');
