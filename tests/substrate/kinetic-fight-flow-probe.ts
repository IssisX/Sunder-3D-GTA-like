import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';
import { BODY, PhysicalBodies } from '../../src/game/body';
import { bodyScale, nodeRadius } from '../../src/game/body-model';
import { supportHeight } from '../../src/game/body-contacts';
import { bodyTaskTargets, TASK_PRIORITY }
  from '../../src/game/body-task-targets';
import { KineticFightFlow, EDGES }
  from '../../src/game/kinetic-fight-flow';

function isolated() {
  const w = new World();
  w.seed = 12345;
  buildLevel(w);
  const p = w.player();
  w.actors = [p];
  const bodies = new PhysicalBodies();
  bodies.bootstrap(w);
  bodyTaskTargets.bootstrap(w);
  const flow = new KineticFightFlow(bodies);
  flow.bootstrap(w);
  const rig = bodies.get(p)!;
  const scale = bodyScale(p);
  for (const foot of [BODY.lFoot, BODY.rFoot]) {
    const floor = supportHeight(w, rig.x[foot]!, rig.y[foot]!, rig.z[foot]!);
    const y = floor + nodeRadius(p, foot);
    rig.y[foot] = y;
    rig.py[foot] = y;
  }
  return { w, p, flow, rig, scale };
}

function axisAngle(rig: NonNullable<ReturnType<PhysicalBodies['get']>>, p: ReturnType<World['player']>, left: number, right: number) {
  let ax = rig.x[right]! - rig.x[left]!;
  let az = rig.z[right]! - rig.z[left]!;
  let bx = bodyTaskTargets.targetXFor(p, right) - bodyTaskTargets.targetXFor(p, left);
  let bz = bodyTaskTargets.targetZFor(p, right) - bodyTaskTargets.targetZFor(p, left);
  const am = Math.hypot(ax, az) || 1;
  const bm = Math.hypot(bx, bz) || 1;
  ax /= am; az /= am; bx /= bm; bz /= bm;
  return Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
}

function seedStrike(p: ReturnType<World['player']>, rig: NonNullable<ReturnType<PhysicalBodies['get']>>, scale: number) {
  bodyTaskTargets.beginStep();
  bodyTaskTargets.offerWorld(p, BODY.rFoot,
    rig.x[BODY.rFoot]!, rig.y[BODY.rFoot]!, rig.z[BODY.rFoot]!,
    1, TASK_PRIORITY.CONTACT_CRITICAL);
  for (const node of [BODY.pelvis, BODY.chest, BODY.lHip, BODY.rHip, BODY.lShoulder, BODY.rShoulder, BODY.lKnee, BODY.rKnee]) {
    bodyTaskTargets.offerWorld(p, node, rig.x[node]!, rig.y[node]!, rig.z[node]!, 1, TASK_PRIORITY.ACTION);
  }
  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  bodyTaskTargets.offerWorld(p, BODY.rHand,
    rig.x[BODY.rHand]! + fx * 0.55 * scale,
    rig.y[BODY.rHand]! - 0.015 * scale,
    rig.z[BODY.rHand]! + fz * 0.55 * scale,
    1, TASK_PRIORITY.ACTION);
}

function sample(enabled: boolean) {
  const { w, p, flow, rig, scale } = isolated();
  const previous = EDGES.kineticFightSwing;
  EDGES.kineticFightSwing = enabled;
  try {
    seedStrike(p, rig, scale);
    const catchX = rig.x[BODY.lFoot]! + 0.18 * scale;
    const catchZ = rig.z[BODY.lFoot]! - 0.12 * scale;
    bodyTaskTargets.offerWorld(p, BODY.lFoot,
      catchX, rig.y[BODY.lFoot]! + 0.045 * scale, catchZ,
      1, TASK_PRIORITY.CORRECTIVE_STEP + 1);
    flow.prepare(w, STEP);
    const hipAngle = axisAngle(rig, p, BODY.lHip, BODY.rHip);
    const shoulderAngle = axisAngle(rig, p, BODY.lShoulder, BODY.rShoulder);
    const pelvisShift = Math.hypot(
      bodyTaskTargets.targetXFor(p, BODY.pelvis) - rig.x[BODY.pelvis]!,
      bodyTaskTargets.targetZFor(p, BODY.pelvis) - rig.z[BODY.pelvis]!);
    const kneeLoad = Math.max(
      rig.y[BODY.lKnee]! - bodyTaskTargets.targetYFor(p, BODY.lKnee),
      rig.y[BODY.rKnee]! - bodyTaskTargets.targetYFor(p, BODY.rKnee));
    const catchError = Math.hypot(
      bodyTaskTargets.targetXFor(p, BODY.lFoot) - catchX,
      bodyTaskTargets.targetZFor(p, BODY.lFoot) - catchZ);
    const catchPriority = bodyTaskTargets.priorityFor(p, BODY.lFoot);

    bodyTaskTargets.beginStep();
    for (const foot of [BODY.lFoot, BODY.rFoot]) {
      bodyTaskTargets.offerWorld(p, foot,
        rig.x[foot]!, rig.y[foot]!, rig.z[foot]!,
        1, TASK_PRIORITY.CONTACT_CRITICAL);
    }
    for (const node of [BODY.pelvis, BODY.chest, BODY.lHip, BODY.rHip, BODY.lShoulder, BODY.rShoulder, BODY.lKnee, BODY.rKnee]) {
      bodyTaskTargets.offerWorld(p, node, rig.x[node]!, rig.y[node]!, rig.z[node]!, 1, TASK_PRIORITY.ACTION);
    }
    flow.prepare(w, STEP);
    const followThroughAngle = axisAngle(rig, p, BODY.lShoulder, BODY.rShoulder);
    return { hipAngle, shoulderAngle, pelvisShift, kneeLoad, catchError, catchPriority, followThroughAngle };
  } finally {
    EDGES.kineticFightSwing = previous;
  }
}

function measureCost(enabled: boolean) {
  const { w, p, flow, rig, scale } = isolated();
  const previous = EDGES.kineticFightSwing;
  EDGES.kineticFightSwing = enabled;
  const loops = 48;
  const t0 = performance.now();
  try {
    for (let i = 0; i < loops; i++) {
      seedStrike(p, rig, scale);
      flow.prepare(w, STEP);
    }
  } finally {
    EDGES.kineticFightSwing = previous;
  }
  return (performance.now() - t0) / loops;
}

const canonical = sample(true);
const severed = sample(false);
const enabledMs = measureCost(true);
const severedMs = measureCost(false);
console.log('PASS kinetic fight flow', { canonical, severed, enabledMsPerPrepare: enabledMs, severedMsPerPrepare: severedMs, incrementalMsPerPrepare: enabledMs - severedMs });

assert(canonical.hipAngle > severed.hipAngle + 0.1,
  'hand strike did not visibly rotate the hips through planted support');
assert(canonical.shoulderAngle > severed.shoulderAngle + 0.16,
  'hand strike did not visibly whip the shoulder line through the action');
assert(canonical.shoulderAngle > canonical.hipAngle + 0.035,
  'shoulders did not lead the kinetic chain beyond the hips');
assert(canonical.pelvisShift > severed.pelvisShift + 0.008,
  'pelvis did not arc around real support during the strike');
assert(canonical.kneeLoad > severed.kneeLoad + 0.004,
  'supported legs did not visibly load under the hand strike');
assert(canonical.catchError < 1e-6 && canonical.catchPriority === TASK_PRIORITY.CORRECTIVE_STEP + 1,
  'action swing stole or moved the committed recovery foot');
assert(canonical.followThroughAngle > severed.followThroughAngle + 0.08,
  'terminal action swing snapped to neutral instead of carrying into recovery');
