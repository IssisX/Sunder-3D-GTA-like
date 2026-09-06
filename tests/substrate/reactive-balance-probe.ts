import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';
import { BODY, PhysicalBodies } from '../../src/game/body';
import { bodyTaskTargets, TASK_PRIORITY }
  from '../../src/game/body-task-targets';
import { ReactiveBalance, EDGES as BALANCE_EDGES }
  from '../../src/game/reactive-balance';
import { SupportMotionController, EDGES as SUPPORT_EDGES }
  from '../../src/game/support-motion';

function isolated() {
  const w = new World();
  w.seed = 12345;
  buildLevel(w);
  const p = w.player();
  w.actors = [p];
  const bodies = new PhysicalBodies();
  bodies.bootstrap(w);
  bodyTaskTargets.bootstrap(w);
  return { w, p, bodies, rig: bodies.get(p)! };
}

function seedLocomotionTargets(p: ReturnType<World['player']>, rig: ReturnType<PhysicalBodies['get']>) {
  if (!rig) throw new Error('missing rig');
  bodyTaskTargets.beginStep();
  for (const node of [
    BODY.pelvis, BODY.chest, BODY.head,
    BODY.lKnee, BODY.rKnee,
    BODY.lElbow, BODY.rElbow, BODY.lHand, BODY.rHand,
  ]) {
    bodyTaskTargets.offerWorld(
      p, node,
      rig.x[node]!, rig.y[node]!, rig.z[node]!,
      1, TASK_PRIORITY.LOCOMOTION,
    );
  }
}

function makeResidualMotion(rig: NonNullable<ReturnType<PhysicalBodies['get']>>) {
  for (const node of [BODY.pelvis, BODY.chest, BODY.head]) {
    rig.px[node] = rig.x[node]! - 0.065;
  }
}

function reactiveSample(enabled: boolean) {
  const { w, p, bodies, rig } = isolated();
  const balance = new ReactiveBalance(bodies);
  p.intendX = 0;
  p.intendZ = 0;
  p.intendSpeed = 0;
  makeResidualMotion(rig);
  seedLocomotionTargets(p, rig);

  const old = BALANCE_EDGES.reactiveBalance;
  BALANCE_EDGES.reactiveBalance = enabled;
  try {
    balance.prepare(w, STEP);
    const chestShift = bodyTaskTargets.targetXFor(p, BODY.chest) - rig.x[BODY.chest]!;
    const leftHandShift = bodyTaskTargets.targetXFor(p, BODY.lHand) - rig.x[BODY.lHand]!;

    // The next frame is an active punch: the core may bend with balance, but
    // the striking hand carrier itself must remain owned by the action.
    bodyTaskTargets.beginStep();
    const actionChestX = rig.x[BODY.chest]! + 0.04;
    const strikeHandX = rig.x[BODY.rHand]! + 0.42;
    bodyTaskTargets.offerWorld(
      p, BODY.chest,
      actionChestX, rig.y[BODY.chest]!, rig.z[BODY.chest]!,
      1, TASK_PRIORITY.ACTION,
    );
    bodyTaskTargets.offerWorld(
      p, BODY.pelvis,
      rig.x[BODY.pelvis]!, rig.y[BODY.pelvis]!, rig.z[BODY.pelvis]!,
      1, TASK_PRIORITY.ACTION,
    );
    bodyTaskTargets.offerWorld(
      p, BODY.rHand,
      strikeHandX, rig.y[BODY.rHand]!, rig.z[BODY.rHand]!,
      1, TASK_PRIORITY.ACTION,
    );
    bodyTaskTargets.offerWorld(
      p, BODY.lHand,
      rig.x[BODY.lHand]!, rig.y[BODY.lHand]!, rig.z[BODY.lHand]!,
      1, TASK_PRIORITY.LOCOMOTION,
    );
    balance.prepare(w, STEP);
    const actionCoreCorrection = bodyTaskTargets.targetXFor(p, BODY.chest) - actionChestX;
    const carrierError = bodyTaskTargets.targetXFor(p, BODY.rHand) - strikeHandX;
    const freeArmCorrection = bodyTaskTargets.targetXFor(p, BODY.lHand) - rig.x[BODY.lHand]!;

    return {
      chestShift,
      leftHandShift,
      actionCoreCorrection,
      carrierError,
      freeArmCorrection,
    };
  } finally {
    BALANCE_EDGES.reactiveBalance = old;
  }
}

function supportSample(enabled: boolean) {
  const { w, p, rig } = isolated();
  const controller = new SupportMotionController();
  p.loco = 'stumble';
  p.intendX = 0;
  p.intendZ = 0;
  p.intendSpeed = 0;
  makeResidualMotion(rig);
  const before = rig.px[BODY.pelvis]!;
  const old = SUPPORT_EDGES.adaptiveRecovery;
  SUPPORT_EDGES.adaptiveRecovery = enabled;
  try {
    controller.drive(w, p, rig, STEP, 'stumble', false);
    return Math.abs(rig.px[BODY.pelvis]! - before);
  } finally {
    SUPPORT_EDGES.adaptiveRecovery = old;
  }
}

function measureBalanceCost() {
  const w = new World();
  w.seed = 24680;
  buildLevel(w);
  const bodies = new PhysicalBodies();
  bodies.bootstrap(w);
  bodyTaskTargets.bootstrap(w);
  const balance = new ReactiveBalance(bodies);
  const loops = 48;
  const t0 = performance.now();
  for (let i = 0; i < loops; i++) {
    bodyTaskTargets.beginStep();
    balance.prepare(w, STEP);
  }
  return (performance.now() - t0) / loops;
}

const canonical = reactiveSample(true);
const severed = reactiveSample(false);
const adaptiveSupport = supportSample(true);
const legacySupport = supportSample(false);
const balanceMs = measureBalanceCost();

console.log('PASS fluid balance glue', {
  canonical,
  severed,
  adaptiveSupport,
  legacySupport,
  balanceMsPerPrepare: balanceMs,
});

assert(Math.abs(canonical.chestShift) > Math.abs(severed.chestShift) + 0.004,
  'residual momentum did not create a visible core counterweight');
assert(Math.abs(canonical.leftHandShift) > Math.abs(severed.leftHandShift) + 0.004,
  'free arm did not participate in balance recovery');
assert(Math.abs(canonical.actionCoreCorrection) > Math.abs(severed.actionCoreCorrection) + 0.002,
  'active strike core did not adapt to measured balance');
assert(Math.abs(canonical.carrierError) < 1e-6,
  'balance correction stole authority from the physical striking hand');
assert(Math.abs(canonical.freeArmCorrection) > Math.abs(severed.freeArmCorrection) + 0.003,
  'free guard arm did not remain available as a counterweight during the strike');
assert(adaptiveSupport > legacySupport * 1.05,
  'good planted support did not increase stumble correction authority');
