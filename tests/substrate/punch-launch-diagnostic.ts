import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';
import type { Actions } from '../../src/game/input';
import { stepWorld } from '../../src/game/sim';
import { ProceduralAnimationController as Controller }
  from '../../src/game/ProceduralAnimationController';
import { supportMotion } from '../../src/game/support-motion';

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
  const { p, b, tick } = fixture();
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
  try {
    for (let i = 0; i < 2400 && started < 50; i++) {
      const activeBefore = melee.isActive(p.id);
      tick(activeBefore ? {} : { attackPressed: true });
      const activeAfter = melee.isActive(p.id);
      if (!wasActive && activeAfter) started++;
      wasActive = activeAfter;
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      peakVy = Math.max(peakVy, Math.abs(p.vy));
      if (p.grounded) grounded++;
      ticks++;
    }
    for (let i = 0; i < 60; i++) {
      tick();
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      peakVy = Math.max(peakVy, Math.abs(p.vy));
      if (p.grounded) grounded++;
      ticks++;
    }
  } finally {
    supportMotion.drive = originalSupport;
  }
  return {
    started,
    verticalRange: maxY - minY,
    groundedFraction: grounded / Math.max(1, ticks),
    peakVy,
  };
}

console.log('PUNCH-LAUNCH-DIAG', {
  normal: run('normal'),
  cutCoupling: run('cut-coupling'),
  cutSupportMotion: run('cut-support-motion'),
});
