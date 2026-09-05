import assert from 'node:assert/strict';
import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';
import { BODY, EDGES, PhysicalBodies } from '../../src/game/body';
import { nodeRadius } from '../../src/game/body-model';
import { supportHeight } from '../../src/game/body-contacts';
import { bodyTaskTargets, TASK_PRIORITY }
  from '../../src/game/body-task-targets';

function sample(plantedFootNormal: boolean) {
  const w = new World();
  w.seed = 12345;
  buildLevel(w);
  const p = w.player();
  w.actors = [p];
  w.props = [];
  w.colliders = [];
  w.buildings = [];
  w.fuel.fill(0);

  const bodies = new PhysicalBodies();
  bodies.bootstrap(w);
  const rig = bodies.get(p)!;
  const foot = BODY.lFoot;
  const floorY = nodeRadius(p, foot);

  // Isolate the named edge: the foot is close enough to support to be planted,
  // but not touching. The same contact-critical task requests the support plane.
  rig.y[foot] = floorY + 0.05;
  rig.py[foot] = floorY + 0.05;
  bodyTaskTargets.beginStep();
  bodyTaskTargets.offerWorld(
    p, foot,
    rig.x[foot]!, floorY, rig.z[foot]!,
    1, TASK_PRIORITY.CONTACT_CRITICAL,
  );
  bodyTaskTargets.finalizeStep(STEP);

  const prior = EDGES.plantedFootNormal;
  EDGES.plantedFootNormal = plantedFootNormal;
  try {
    bodies.step(w, STEP);
  } finally {
    EDGES.plantedFootNormal = prior;
  }

  const surface = supportHeight(
    w, rig.x[foot]!, rig.y[foot]!, rig.z[foot]!,
  );
  return {
    gap: Math.abs(rig.y[foot]! - nodeRadius(p, foot) - surface),
    grounded: p.grounded,
  };
}

const normal = sample(true);
const severed = sample(false);
console.log('PLANTED-SUPPORT', { normal, severed });

assert(normal.gap < 0.001 && normal.grounded,
  'contact-critical foot did not bind to support normal');
assert(severed.gap > normal.gap + 0.003,
  'planted-foot edge severance does not change support gap');
