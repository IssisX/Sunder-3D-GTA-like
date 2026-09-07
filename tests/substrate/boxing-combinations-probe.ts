import assert from 'node:assert/strict';
import {
  BoxingCombinations, PUNCH, EDGES,
  makeBoxingPose,
} from '../../src/game/boxing-combinations';

const boxing = new BoxingCombinations();
const pose = makeBoxingPose();
const context = {
  targetX: 0, targetY: 1.45, targetZ: 0.76,
  forwardSpeed: 0, lateralSpeed: 0,
  angularMomentum: 0, support: 1, grip: 1,
  capacity: 1,
};
let now = 0;
const sequence: number[] = [];
for (let i = 0; i < 3; i++) {
  boxing.enqueue(0, now);
  assert(boxing.take(0, now));
  const d = boxing.begin(
    0, now, false, 0.76, 1,
    -0.2, 1.32, 0.22, 0, 0, 0,
  );
  sequence.push(boxing.profile(0));
  assert(d > 0.2 && d < 0.5);
  boxing.sample(0, 0.55, context, pose);
  assert(Number.isFinite(pose.handX));
  assert(Number.isFinite(pose.handY));
  assert(Number.isFinite(pose.handZ));
  now += d;
  boxing.end(0, now);
  now += 0.03;
}
assert.deepEqual(sequence, [
  PUNCH.JAB, PUNCH.CROSS, PUNCH.LEAD_UPPERCUT,
]);

boxing.reset(0);
boxing.enqueue(0, 0);
boxing.enqueue(0, 0.01);
boxing.enqueue(0, 0.02);
assert.equal(boxing.pending(0), 3);
assert(boxing.take(0, 0.03));
assert(boxing.take(0, 0.03));
assert(boxing.take(0, 0.03));
assert(!boxing.take(0, 0.03));
boxing.enqueue(0, 1);
assert(!boxing.take(0, 1.5));
boxing.enqueue(0, 2);
boxing.enqueue(0, 2.4);
assert(boxing.take(0, 2.5));
assert(!boxing.take(0, 2.5));

// A rapid burst must reserve enough queue time for all three actions.
boxing.reset(0);
for (let i = 0; i < 3; i++) boxing.enqueue(0, 0);
let burstTime = 0;
for (const expected of [PUNCH.JAB, PUNCH.CROSS,
  PUNCH.LEAD_UPPERCUT]) {
  assert(boxing.take(0, burstTime));
  const d = boxing.begin(0, burstTime, false, 0.76, 1,
    -0.2, 1.32, 0.22, 0, 0, 0);
  assert.equal(boxing.profile(0), expected);
  burstTime += d + 0.03;
  boxing.end(0, burstTime);
}
assert.equal(boxing.pending(0), 0);

boxing.reset(0);
boxing.begin(0, 0, false, 0.76, 1,
  -0.2, 1.32, 0.22, 0, 0, 0);
boxing.sample(0, 0.5, context, pose);
const planted = pose.hipTurn;
const plantedZ = pose.handZ;
context.support = 0;
context.grip = 0.2;
boxing.sample(0, 0.5, context, pose);
assert(Math.abs(pose.hipTurn) < Math.abs(planted));
assert(pose.handZ === plantedZ);
context.support = 1;
context.grip = 1;
EDGES.supportCoupledDrive = false;
boxing.sample(0, 0.5, context, pose);
const severed = pose.hipTurn;
EDGES.supportCoupledDrive = true;
assert(Math.abs(severed) >= Math.abs(planted));

boxing.reset(0);
assert.equal(boxing.nextProfile(0, 0, 0.36),
  PUNCH.LEAD_HOOK);
assert.equal(boxing.nextHand(0, 0, false, 0.36), false);
boxing.begin(0, 0, false, 0.36, 1,
  -0.2, 1.32, 0.22, 0, 0, 0);
assert.equal(boxing.profile(0), PUNCH.LEAD_HOOK);
boxing.end(0, 0.3);
boxing.begin(0, 0.31, false, 0.76, 1,
  0.2, 1.32, 0.22, 0, 0, 0);
assert.equal(boxing.profile(0), PUNCH.CROSS);
assert(boxing.rightHand(0));
boxing.end(0, 0.65);
boxing.begin(0, 0.66, false, 1.2, 1,
  -0.2, 1.32, 0.22, 0, 0, 0);
assert.equal(boxing.profile(0), PUNCH.JAB);

boxing.reset(0);
boxing.begin(0, 0, false, 0.76, 1,
  -0.2, 1.32, 0.22, 0, 0, 0);
assert(!boxing.contactWindow(0, 0.1));
assert(boxing.contactWindow(0, 0.5));
assert(!boxing.contactWindow(0, 0.9));
boxing.end(0, 0.27);
boxing.begin(0, 2, true, 0.76, 1,
  0.2, 1.32, 0.22, 0, 0, 0);
assert.equal(boxing.profile(0), PUNCH.JAB);
assert(boxing.rightHand(0));

// Six distinct families remain reachable without contextual substitution.
boxing.reset(0);
const all: number[] = [];
let t = 0;
for (let i = 0; i < 6; i++) {
  const d = boxing.begin(0, t, false, 0.76, 1,
    -0.2, 1.32, 0.22, 0, 0, 0);
  all.push(boxing.profile(0));
  t += d;
  boxing.end(0, t);
  t += 0.02;
}
assert.equal(new Set(all).size, 6);
console.log('BOXING-COMBINATIONS PASS', {
  sequence, all, queue: true, supportSeverance: true,
  contextSelection: true, stanceMirror: true,
});
