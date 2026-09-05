import assert from 'node:assert/strict';
import type { Actions } from '../../src/game/input';
import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';
import { BODY, PhysicalBodies } from '../../src/game/body';
import { bodyTaskTargets, TASK_PRIORITY }
  from '../../src/game/body-task-targets';
import { ActionContinuity, EDGES }
  from '../../src/game/action-continuity';

function input(attackPressed = false): Actions {
  return {
    moveX: 0, moveY: 0, lookX: 0, lookY: 0,
    attackPressed, kickPressed: false,
  } as Actions;
}

function sample(enabled: boolean) {
  const w = new World();
  w.seed = 12345;
  buildLevel(w);
  const p = w.player();
  w.actors = [p];
  w.props = [];
  w.colliders = [];
  w.buildings = [];
  const bodies = new PhysicalBodies();
  bodies.bootstrap(w);
  bodyTaskTargets.bootstrap(w);
  const continuity = new ActionContinuity(bodies);
  continuity.bootstrap(w);
  const rig = bodies.get(p)!;

  p.vx = 2.8;
  p.vz = 0;
  p.intendX = 1;
  p.intendZ = 0;
  p.intendSpeed = 3;

  bodyTaskTargets.beginStep();
  bodyTaskTargets.offerWorld(p, BODY.pelvis,
    rig.x[BODY.pelvis]! + 0.06, rig.y[BODY.pelvis]!, rig.z[BODY.pelvis]!,
    1, TASK_PRIORITY.LOCOMOTION);
  bodyTaskTargets.offerWorld(p, BODY.chest,
    rig.x[BODY.chest]! + 0.05, rig.y[BODY.chest]!, rig.z[BODY.chest]!,
    1, TASK_PRIORITY.LOCOMOTION);
  bodyTaskTargets.offerWorld(p, BODY.lFoot,
    rig.x[BODY.lFoot]! + 0.32, rig.y[BODY.lFoot]! + 0.08, rig.z[BODY.lFoot]!,
    1, TASK_PRIORITY.LOCOMOTION);
  bodyTaskTargets.offerWorld(p, BODY.rFoot,
    rig.x[BODY.rFoot]!, rig.y[BODY.rFoot]!, rig.z[BODY.rFoot]!,
    1, TASK_PRIORITY.LOCOMOTION);
  continuity.captureLocomotion(w);

  // Simulate melee/coupling replacing the locomotion field with a moving punch.
  p.intendSpeed = 1;
  bodyTaskTargets.offerWorld(p, BODY.lFoot,
    rig.x[BODY.lFoot]!, rig.y[BODY.lFoot]!, rig.z[BODY.lFoot]!,
    1, TASK_PRIORITY.CONTACT_CRITICAL);
  bodyTaskTargets.offerWorld(p, BODY.rFoot,
    rig.x[BODY.rFoot]!, rig.y[BODY.rFoot]!, rig.z[BODY.rFoot]!,
    1, TASK_PRIORITY.CONTACT_CRITICAL);
  bodyTaskTargets.offerWorld(p, BODY.rHand,
    rig.x[BODY.rHand]! + 0.42, rig.y[BODY.rHand]!, rig.z[BODY.rHand]!,
    1, TASK_PRIORITY.ACTION);

  const prior = EDGES.actionFlow;
  EDGES.actionFlow = enabled;
  try {
    continuity.couple(w, STEP);
    const inheritedStep = bodyTaskTargets.targetXFor(p, BODY.lFoot)
      - rig.x[BODY.lFoot]!;
    const retainedSpeed = p.intendSpeed;

    // Press during the active action, then release the action on the next frame.
    const during = input(true);
    continuity.captureInput(during);
    continuity.prepareBufferedInput(during, true, STEP);
    const after = input(false);
    continuity.captureInput(after);
    const replayed = continuity.prepareBufferedInput(after, false, STEP);

    // End action. Locomotion returns, but continuity should bridge from the
    // terminal hand target rather than snapping immediately to gait posture.
    const terminalHandX = bodyTaskTargets.targetXFor(p, BODY.rHand);
    bodyTaskTargets.beginStep();
    bodyTaskTargets.offerWorld(p, BODY.rHand,
      rig.x[BODY.rHand]!, rig.y[BODY.rHand]!, rig.z[BODY.rHand]!,
      1, TASK_PRIORITY.LOCOMOTION);
    bodyTaskTargets.offerWorld(p, BODY.lFoot,
      rig.x[BODY.lFoot]! + 0.18, rig.y[BODY.lFoot]!, rig.z[BODY.lFoot]!,
      1, TASK_PRIORITY.LOCOMOTION);
    continuity.captureLocomotion(w);
    continuity.couple(w, STEP);
    const recoveredHandX = bodyTaskTargets.targetXFor(p, BODY.rHand);
    const locomotionHandX = rig.x[BODY.rHand]!;
    const recoveryCarry = Math.abs(recoveredHandX - locomotionHandX);
    const terminalCarry = Math.abs(terminalHandX - locomotionHandX);

    return {
      inheritedStep,
      retainedSpeed,
      replayed,
      recoveryCarry,
      terminalCarry,
    };
  } finally {
    EDGES.actionFlow = prior;
  }
}

const canonical = sample(true);
const severed = sample(false);
console.log('ACTION-CONTINUITY', { canonical, severed });

assert(canonical.inheritedStep > severed.inheritedStep + 0.08,
  'moving strike did not inherit the gait-selected step');
assert(canonical.retainedSpeed > severed.retainedSpeed + 0.6,
  'moving strike discarded incoming COM speed');
assert(canonical.replayed,
  'follow-up action pressed during the current action was not buffered');
assert(canonical.recoveryCarry > 0.02 &&
  canonical.recoveryCarry < canonical.terminalCarry,
  'action recovery snapped directly to locomotion instead of bridging');
