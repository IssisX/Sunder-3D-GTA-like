import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';
import { BODY, PhysicalBodies } from '../../src/game/body';
import { bodyTaskTargets, TASK_PRIORITY }
  from '../../src/game/body-task-targets';
import { CommittedCatchStep, EDGES as CATCH_EDGES }
  from '../../src/game/committed-catch-step';
import { HumanRootAuthority, EDGES as ROOT_EDGES }
  from '../../src/game/human-root-authority';

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

function commitmentSample(enabled: boolean) {
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

  const old = CATCH_EDGES.committedCatchStep;
  CATCH_EDGES.committedCatchStep = enabled;
  try {
    bodyTaskTargets.beginStep();
    offer(p, BODY.lFoot, lLandingX, lStartY, lLandingZ, TASK_PRIORITY.CORRECTIVE_STEP);
    offer(p, BODY.rFoot, rStartX, rStartY, rStartZ, TASK_PRIORITY.LOCOMOTION);
    catchStep.prepare(w, STEP);
    const firstLeftPriority = bodyTaskTargets.priorityFor(p, BODY.lFoot);
    const firstLeftMove = footMove(p, rig, BODY.lFoot);

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
    CATCH_EDGES.committedCatchStep = old;
  }
}

function stumbleSample(enabled: boolean) {
  const { w, p, rig, catchStep } = isolated();
  p.loco = 'stumble';
  p.intendX = 0;
  p.intendZ = 0;
  p.intendSpeed = 0;

  // Same solved pose, but the core carries sideways residual momentum while
  // both feet are still near support. Ordinary locomotion contributes no task.
  for (const node of [BODY.pelvis, BODY.chest, BODY.head]) {
    rig.px[node] = rig.x[node]! - 0.055;
    rig.pz[node] = rig.z[node]!;
  }

  const old = CATCH_EDGES.committedCatchStep;
  CATCH_EDGES.committedCatchStep = enabled;
  try {
    bodyTaskTargets.beginStep();
    catchStep.prepare(w, STEP);
    const lp = bodyTaskTargets.priorityFor(p, BODY.lFoot);
    const rp = bodyTaskTargets.priorityFor(p, BODY.rFoot);
    const selected = lp > TASK_PRIORITY.CORRECTIVE_STEP
      ? 1
      : rp > TASK_PRIORITY.CORRECTIVE_STEP
        ? 2
        : 0;
    const selectedNode = selected === 1 ? BODY.lFoot : selected === 2 ? BODY.rFoot : BODY.lFoot;
    const supportNode = selected === 1 ? BODY.rFoot : BODY.lFoot;
    return {
      selected,
      selectedMove: selected ? footMove(p, rig, selectedNode) : 0,
      supportPriority: selected ? bodyTaskTargets.priorityFor(p, supportNode) : 0,
    };
  } finally {
    CATCH_EDGES.committedCatchStep = old;
  }
}

function recoveryFirewallSample(enabled: boolean) {
  const { w, p } = isolated();
  const authority = new HumanRootAuthority();
  const old = ROOT_EDGES.preserveRecoveryState;
  ROOT_EDGES.preserveRecoveryState = enabled;
  try {
    p.loco = 'stumble';
    authority.capture(w);
    p.loco = 'run';
    authority.restoreBodyOwnedRoots(w);
    const ordinaryRelabel = p.loco;

    p.loco = 'stumble';
    authority.capture(w);
    p.loco = 'ragdoll';
    authority.restoreBodyOwnedRoots(w);
    const supersedingState = p.loco;
    return { ordinaryRelabel, supersedingState };
  } finally {
    ROOT_EDGES.preserveRecoveryState = old;
  }
}

function measure(enabled: boolean) {
  const { w, catchStep } = isolated();
  const old = CATCH_EDGES.committedCatchStep;
  CATCH_EDGES.committedCatchStep = enabled;
  try {
    const loops = 32;
    const t0 = performance.now();
    for (let i = 0; i < loops; i++) {
      bodyTaskTargets.beginStep();
      catchStep.prepare(w, STEP);
    }
    return (performance.now() - t0) / loops;
  } finally {
    CATCH_EDGES.committedCatchStep = old;
  }
}

const canonical = commitmentSample(true);
const severed = commitmentSample(false);
const stumble = stumbleSample(true);
const stumbleCut = stumbleSample(false);
const firewall = recoveryFirewallSample(true);
const firewallCut = recoveryFirewallSample(false);
const enabledMs = measure(true);
const severedMs = measure(false);

console.log('PASS committed catch-step complete seam', {
  canonical,
  severed,
  stumble,
  stumbleCut,
  firewall,
  firewallCut,
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
assert(stumble.selected !== 0 && stumble.selectedMove > 0.005,
  'already-stumbling body did not generate a physical recovery step');
assert(stumble.supportPriority >= TASK_PRIORITY.CONTACT_CRITICAL,
  'stumble recovery did not preserve the opposite real support foot');
assert.equal(stumbleCut.selected, 0,
  'severing catch authority did not remove stumble recovery footwork');
assert.equal(firewall.ordinaryRelabel, 'stumble',
  'legacy speed classification erased body-earned stumble recovery');
assert.equal(firewallCut.ordinaryRelabel, 'run',
  'severing recovery-state authority did not expose the legacy relabel');
assert.equal(firewall.supersedingState, 'ragdoll',
  'recovery authority blocked a genuine higher-order body transition');
