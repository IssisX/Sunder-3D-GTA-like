import assert from 'node:assert/strict';
import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';
import type { Actions } from '../../src/game/input';
import { stepWorld } from '../../src/game/sim';
import { ProceduralAnimationController as Controller }
  from '../../src/game/ProceduralAnimationController';
import { BODY, EDGES } from '../../src/game/body';
import { nodeRadius } from '../../src/game/body-model';
import { supportHeight } from '../../src/game/body-contacts';

function fixture() {
  const w = new World();
  w.seed = 12345;
  buildLevel(w);
  const p = w.player();
  w.actors = [p];
  w.props = [];
  w.colliders = [];
  w.buildings = [];
  w.fuel.fill(0);
  p.x = 0;
  p.z = 0;
  p.yaw = 0;
  const b = new Controller();
  b.bootstrap(w);
  const cam = { yaw: 0, pitch: 0 };
  function tick(delta: Partial<Actions> = {}) {
    const input = {
      moveX: 0, moveY: 0, lookX: 0, lookY: 0,
      ...delta,
    } as Actions;
    b.captureInput(input);
    b.prepareInput(w, input, STEP);
    b.prepareStep(w, STEP);
    stepWorld(w, STEP, input, cam, true);
    b.step(w, STEP);
  }
  for (let i = 0; i < 30; i++) tick();
  return { w, p, b, tick };
}

function run(plantedFootNormal: boolean) {
  const prior = EDGES.plantedFootNormal;
  EDGES.plantedFootNormal = plantedFootNormal;
  const { w, p, b, tick } = fixture();
  const melee = (b as any).melee;
  let started = 0;
  let wasActive = false;
  let maxNearestFootGap = 0;
  let minRootY = p.y;
  let maxRootY = p.y;
  let groundedTicks = 0;
  let ticks = 0;
  try {
    for (let i = 0; i < 180 && started < 3; i++) {
      const activeBefore = melee.isActive(p.id);
      tick(activeBefore ? {} : { attackPressed: true });
      const activeAfter = melee.isActive(p.id);
      if (!wasActive && activeAfter) started++;
      wasActive = activeAfter;

      const rig = b.get(p)!;
      const lSurface = supportHeight(
        w, rig.x[BODY.lFoot]!, rig.y[BODY.lFoot]!, rig.z[BODY.lFoot]!,
      );
      const rSurface = supportHeight(
        w, rig.x[BODY.rFoot]!, rig.y[BODY.rFoot]!, rig.z[BODY.rFoot]!,
      );
      const lGap = Math.abs(
        rig.y[BODY.lFoot]! - nodeRadius(p, BODY.lFoot) - lSurface,
      );
      const rGap = Math.abs(
        rig.y[BODY.rFoot]! - nodeRadius(p, BODY.rFoot) - rSurface,
      );
      maxNearestFootGap = Math.max(maxNearestFootGap, Math.min(lGap, rGap));
      minRootY = Math.min(minRootY, p.y);
      maxRootY = Math.max(maxRootY, p.y);
      if (p.grounded) groundedTicks++;
      ticks++;
    }
  } finally {
    EDGES.plantedFootNormal = prior;
  }
  return {
    started,
    maxNearestFootGap,
    verticalRange: maxRootY - minRootY,
    groundedFraction: groundedTicks / Math.max(1, ticks),
  };
}

const normal = run(true);
const severed = run(false);

assert.equal(normal.started, 3, 'three punches did not execute');
assert(normal.maxNearestFootGap < 0.04,
  'contact-critical boxing feet leave the support surface');
assert(normal.verticalRange < 0.12,
  'boxing support creates vertical launch');
assert(normal.groundedFraction > 0.9,
  'boxing stance is not physically grounded');
assert(
  severed.maxNearestFootGap > normal.maxNearestFootGap + 0.03 ||
  severed.verticalRange > normal.verticalRange + 0.03,
  'planted-foot edge severance does not change measured support',
);

console.log('PASS planted support', { normal, severed });
