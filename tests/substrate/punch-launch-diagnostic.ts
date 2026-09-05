import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';
import type { Actions } from '../../src/game/input';
import { stepWorld } from '../../src/game/sim';
import { ProceduralAnimationController as Controller }
  from '../../src/game/ProceduralAnimationController';
import { supportMotion } from '../../src/game/support-motion';
import { BODY, bodyScale, nodeRadius } from '../../src/game/body-model';
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
  for (let i = 0; i < 60; i++) tick();
  return { w, p, b, tick };
}

function run(kind: 'normal' | 'cut-coupling' | 'cut-support-motion') {
  const { w, p, b, tick } = fixture();
  const originalSupport = supportMotion.drive;
  if (kind === 'cut-coupling') {
    (b as any).coupling.prepare = () => {};
  } else if (kind === 'cut-support-motion') {
    supportMotion.drive = () => {};
  }
  const melee = (b as any).melee;
  let started = 0;
  let wasActive = false;
  let minY = p.y;
  let maxY = p.y;
  let grounded = 0;
  let ticks = 0;
  let peakVy = 0;
  let maxNearestFootGap = 0;
  let near3cm = 0;
  let nearMechanical = 0;
  try {
    const sample = () => {
      const rig = b.get(p)!;
      const lg = Math.abs(
        rig.y[BODY.lFoot]! - nodeRadius(p, BODY.lFoot) -
        supportHeight(w, rig.x[BODY.lFoot]!, rig.y[BODY.lFoot]!, rig.z[BODY.lFoot]!),
      );
      const rg = Math.abs(
        rig.y[BODY.rFoot]! - nodeRadius(p, BODY.rFoot) -
        supportHeight(w, rig.x[BODY.rFoot]!, rig.y[BODY.rFoot]!, rig.z[BODY.rFoot]!),
      );
      const nearest = Math.min(lg, rg);
      maxNearestFootGap = Math.max(maxNearestFootGap, nearest);
      if (nearest <= 0.03 * bodyScale(p)) near3cm++;
      if (nearest <= 0.085 * bodyScale(p)) nearMechanical++;
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      peakVy = Math.max(peakVy, Math.abs(p.vy));
      if (p.grounded) grounded++;
      ticks++;
    };

    for (let i = 0; i < 2400 && started < 50; i++) {
      const activeBefore = melee.isActive(p.id);
      tick(activeBefore ? {} : { attackPressed: true });
      const activeAfter = melee.isActive(p.id);
      if (!wasActive && activeAfter) started++;
      wasActive = activeAfter;
      sample();
    }
    for (let i = 0; i < 60; i++) {
      tick();
      sample();
    }
  } finally {
    supportMotion.drive = originalSupport;
  }
  return {
    started,
    verticalRange: maxY - minY,
    groundedFraction: grounded / Math.max(1, ticks),
    peakVy,
    maxNearestFootGap,
    near3cmFraction: near3cm / Math.max(1, ticks),
    nearMechanicalFraction: nearMechanical / Math.max(1, ticks),
  };
}

console.log('PUNCH-LAUNCH-DIAG', {
  normal: run('normal'),
  cutCoupling: run('cut-coupling'),
  cutSupportMotion: run('cut-support-motion'),
});
