import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';
import { BODY, PhysicalBodies } from '../../src/game/body';
import { bodyTaskTargets, TASK_PRIORITY }
  from '../../src/game/body-task-targets';
import { CommittedCatchStep, EDGES }
  from '../../src/game/committed-catch-step';

function isolated() {
  const w = new World();
  w.seed = 445566;
  buildLevel(w);
  const p = w.player();
  w.actors = [p];
  const bodies = new PhysicalBodies();
  bodies.bootstrap(w);
  bodyTaskTargets.bootstrap(w);
  const catchStep = new CommittedCatchStep(bodies);
  catchStep.bootstrap(w);
  return { w, p, bodies, rig: bodies.get(p)!, catchStep };
}

function footMove(
  p: ReturnType<World['player']>,
  rig: NonNullable<ReturnType<PhysicalBodies['get']>>,
  node: number,
) {
  return Math.hypot(
    bodyTaskTargets.targetXFor(p, node) - rig.x[node]!,
    bodyTaskTargets.targetYFor(p, node) - rig.y[node]!,
    bodyTaskTargets.targetZFor(p, node) - rig.z[node]!,
  );
}

function offer(
  p: ReturnType<World['player']>,
  node: number,
  x: number,
  y: number,
  z: number,
  priority: number,
) {
  bodyTaskTargets.offerWorld(p, node, x, y, z, 1, priority);
}

function sample(enabled: boolean) {
  const { w, p, rig, catchStep } = isolated();
  p.intendSpeed = 2.8;
  const lStartX = rig.x[BODY.lFoot]!;
  const lStartY = rig.y[BODY.lFoot]!;
  const lStartZ = rig.z[BODY.lFoot]!;
  const rStartX = rig.x[BODY.rFoot]!;
  const rStartY = rig.y[BODY.rFoot]!;
  const rStartZ = rig.z[BODY.rFoot]!;
  const lLandingX = lStartX + 0.42;
  const lLandingZ = lStartZ + 0.08;
  const rFlipX = rStartX - 0.46;
  const rFlipZ = rStartZ + 0.05;

  const old = EDGES.committedCatchStep;
  EDGES.committedCatchStep = enabled;
  try {
    // Frame 1: the existing capture planner chooses the left foot.
    bodyTaskTargets.beginStep();
    offer(p, BODY.lFoot, lLandingX, lStartY, lLandingZ, TASK_PRIORITY.CORRECTIVE_STEP);
    offer(p, BODY.rFoot, rStartX, rStartY, rStartZ, TASK_PRIORITY.LOCOMOTION);
    catchStep.prepare(w, STEP);
    const firstLeftPriority = bodyTaskTargets.priorityFor(p, BODY.lFoot);
    const firstLeftMove = footMove(p, rig, BODY.lFoot);

    // Frame 2: a fresh instantaneous planner would flip to the right foot.
    // A committed physical catch must keep the already-moving left leg and
    // prevent the support leg from teleporting into a second recovery step.
    bodyTaskTargets.beginStep();
    offer(p, BODY.lFoot, lStartX, lStartY, lStartZ, TASK_PRIORITY.LOCOMOTION);
    offer(p, BODY.rFoot, rFlipX, rStartY, rFlipZ, TASK_PRIORITY.CORRECTIVE_STEP);
    catchStep.prepare(w, STEP);
    const secondLeftPriority = bodyTaskTargets.priorityFor(p, BODY.lFoot);
    const secondRightPriority = bodyTaskTargets.priorityFor(p, BODY.rFoot);
    const secondLeftMove = footMove(p, rig, BODY.lFoot);
    const secondRightMove = footMove(p, rig, BODY.rFoot);

    let landed = false;
    let landingPriority = 0;
    let landingFrames = 0;
    let handoffReleased = false;

    if (enabled) {
      // Put the solved foot at the committed landing. Progress is still allowed
      // to catch up over several fixed steps; support, not a timer, confirms
      // that the landing actually happened.
      rig.x[BODY.lFoot] = lLandingX;
      rig.z[BODY.lFoot] = lLandingZ;
      rig.y[BODY.lFoot] = lStartY;
      rig.px[BODY.lFoot] = lLandingX;
      rig.pz[BODY.lFoot] = lLandingZ;
      rig.py[BODY.lFoot] = lStartY;
      p.grounded = true;

      for (let i = 0; i < 10; i++) {
        bodyTaskTargets.beginStep();
        offer(p, BODY.lFoot, lLandingX, lStartY, lLandingZ, TASK_PRIORITY.CORRECTIVE_STEP);
        offer(p, BODY.rFoot, rStartX, rStartY, rStartZ, TASK_PRIORITY.LOCOMOTION);
        catchStep.prepare(w, STEP);
        landingFrames = i + 1;
        const error = footMove(p, rig, BODY.lFoot);
        landingPriority = bodyTaskTargets.priorityFor(p, BODY.lFoot);
        if (landingPriority > TASK_PRIORITY.CORRECTIVE_STEP && error < 1e-5) {
          landed = true;
          break;
        }
      }

      // Next gait request agrees with the new support: landed foot stays put,
      // opposite foot wants to move. The catch layer should immediately yield.
      bodyTaskTargets.beginStep();
      offer(p, BODY.lFoot, lLandingX, lStartY, lLandingZ, TASK_PRIORITY.LOCOMOTION);
      offer(p, BODY.rFoot, rStartX + 0.26, rStartY, rStartZ, TASK_PRIORITY.LOCOMOTION);
      catchStep.prepare(w, STEP);
      handoffReleased =
        bodyTaskTargets.priorityFor(p, BODY.lFoot) === TASK_PRIORITY.LOCOMOTION &&
        footMove(p, rig, BODY.rFoot) > 0.2;
    }

    return {
      firstLeftPriority,
      firstLeftMove,
      secondLeftPriority,
      secondRightPriority,
      secondLeftMove,
      secondRightMove,
      landed,
      landingPriority,
      landingFrames,
      handoffReleased,
    };
  } finally {
    EDGES.committedCatchStep = old;
  }
}

function measure(enabled: boolean) {
  const { w, catchStep } = isolated();
  const old = EDGES.committedCatchStep;
  EDGES.committedCatchStep = enabled;
  try {
    const loops = 32;
    const t0 = performance.now();
    for (let i = 0; i < loops; i++) {
      bodyTaskTargets.beginStep();
      catchStep.prepare(w, STEP);
    }
    return (performance.now() - t0) / loops;
  } finally {
    EDGES.committedCatchStep = old;
  }
}

const canonical = sample(true);
const severed = sample(false);
const enabledMs = measure(true);
const severedMs = measure(false);

console.log('PASS committed catch-step glue', {
  canonical,
  severed,
  enabledMsPerPrepare: enabledMs,
  severedMsPerPrepare: severedMs,
  incrementalMsPerPrepare: enabledMs - severedMs,
});

assert(canonical.firstLeftPriority > severed.firstLeftPriority,
  'catch commitment did not take authority over the planner-selected foot');
assert(canonical.firstLeftMove > 0.005,
  'committed catch foot did not begin moving on the first fixed step');
assert(canonical.secondLeftPriority > TASK_PRIORITY.CORRECTIVE_STEP &&
  canonical.secondLeftMove > 0.015,
  'mid-catch replanning abandoned the already-moving recovery foot');
assert(canonical.secondRightMove < 0.02 && severed.secondRightMove > 0.25,
  'opposite-foot planner flip was not causally suppressed by commitment');
assert(canonical.landed && canonical.landingPriority > TASK_PRIORITY.CORRECTIVE_STEP,
  'actual support did not complete the committed landing');
assert(canonical.handoffReleased,
  'landing did not hand back to ordinary gait when support geometry agreed');
