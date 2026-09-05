import assert from 'node:assert/strict';
import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import type { Actions } from '../../src/game/input';
import { STEP } from '../../src/game/types';
import { BODY, PhysicalBodies } from '../../src/game/body';
import { nodeRadius } from '../../src/game/body-model';
import { bodyTaskTargets, TASK_PRIORITY }
  from '../../src/game/body-task-targets';
import { MeleeKinematics } from '../../src/game/melee-kinematics';
import { WholeBodyCoupling } from '../../src/game/whole-body-coupling';
import { EDGES } from '../../src/game/action-support';

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
  p.y = 0;
  p.yaw = 0;
  p.grounded = true;
  p.weapon = 'fist';
  p.strikeCd = 0;
  p.walkPhase = 0.1;

  const bodies = new PhysicalBodies();
  bodies.bootstrap(w);
  const rig = bodies.get(p)!;
  const rightFloor = nodeRadius(p, BODY.rFoot);
  rig.y[BODY.rFoot] = rig.py[BODY.rFoot] = rightFloor;
  rig.y[BODY.lFoot] = rig.py[BODY.lFoot] =
    nodeRadius(p, BODY.lFoot) + 0.16;
  rig.pz[BODY.lFoot] = rig.z[BODY.lFoot]! + 0.035;
  rig.pz[BODY.rFoot] = rig.z[BODY.rFoot]!;

  bodyTaskTargets.bootstrap(w);
  const melee = new MeleeKinematics(bodies);
  const coupling = new WholeBodyCoupling(bodies);
  melee.bootstrap(w);
  coupling.bootstrap(w);
  return { w, p, rig, melee, coupling };
}

function kickSample(authority: boolean) {
  const prior = EDGES.currentStanceAuthority;
  EDGES.currentStanceAuthority = authority;
  const { w, p, rig, melee, coupling } = fixture();
  try {
    const input = {
      moveX: 0, moveY: 0, lookX: 0, lookY: 0,
      kickPressed: true,
    } as Actions;
    melee.captureInput(input);
    melee.prepareInput(w, input);
    bodyTaskTargets.beginStep();
    melee.prepareStep(w, STEP);
    coupling.prepare(w);
    return {
      leftPriority: bodyTaskTargets.priorityFor(p, BODY.lFoot),
      rightPriority: bodyTaskTargets.priorityFor(p, BODY.rFoot),
      rightAnchorError: Math.hypot(
        bodyTaskTargets.targetXFor(p, BODY.rFoot) - rig.x[BODY.rFoot]!,
        bodyTaskTargets.targetYFor(p, BODY.rFoot) - rig.y[BODY.rFoot]!,
        bodyTaskTargets.targetZFor(p, BODY.rFoot) - rig.z[BODY.rFoot]!,
      ),
    };
  } finally {
    EDGES.currentStanceAuthority = prior;
  }
}

function punchSample() {
  const { w, p, rig, coupling } = fixture();
  bodyTaskTargets.beginStep();
  const swingZ = rig.z[BODY.lFoot]! - 0.14;
  bodyTaskTargets.offerWorld(
    p,
    BODY.lFoot,
    rig.x[BODY.lFoot]!,
    rig.y[BODY.lFoot]!,
    swingZ,
    1,
    TASK_PRIORITY.LOCOMOTION,
  );
  bodyTaskTargets.offerWorld(
    p,
    BODY.lHand,
    rig.x[BODY.lHand]! - 0.02,
    rig.y[BODY.lHand]!,
    rig.z[BODY.lHand]! - 0.24,
    1,
    TASK_PRIORITY.ACTION,
  );
  coupling.prepare(w);
  return {
    leftPriority: bodyTaskTargets.priorityFor(p, BODY.lFoot),
    leftSwingError: Math.abs(
      bodyTaskTargets.targetZFor(p, BODY.lFoot) - swingZ,
    ),
    rightPriority: bodyTaskTargets.priorityFor(p, BODY.rFoot),
    rightAnchorError: Math.hypot(
      bodyTaskTargets.targetXFor(p, BODY.rFoot) - rig.x[BODY.rFoot]!,
      bodyTaskTargets.targetYFor(p, BODY.rFoot) - rig.y[BODY.rFoot]!,
      bodyTaskTargets.targetZFor(p, BODY.rFoot) - rig.z[BODY.rFoot]!,
    ),
  };
}

const canonical = kickSample(true);
const severed = kickSample(false);
const punch = punchSample();
console.log('CURRENT-STANCE-ACTION', { canonical, severed, punch });

assert(canonical.leftPriority >= TASK_PRIORITY.ACTION,
  'free left leg did not become the attacking kick leg');
assert(canonical.rightPriority >= TASK_PRIORITY.CONTACT_CRITICAL,
  'existing right support was not preserved through the kick');
assert(canonical.rightAnchorError < 1e-5,
  'kick moved the existing support foot into a new stance');
assert(severed.rightPriority < TASK_PRIORITY.CONTACT_CRITICAL ||
       severed.leftPriority >= TASK_PRIORITY.CONTACT_CRITICAL,
  'severing current-stance authority did not restore fixed-side behavior');
assert.equal(punch.leftPriority, TASK_PRIORITY.LOCOMOTION,
  'punch replaced an already-swinging foot with an authored stance');
assert(punch.leftSwingError < 1e-6,
  'punch changed the incoming swing-foot target');
assert(punch.rightPriority >= TASK_PRIORITY.CONTACT_CRITICAL,
  'punch failed to preserve the foot that was actually supporting');
assert(punch.rightAnchorError < 1e-5,
  'punch moved the real support foot into a designed stance');
