import assert from 'node:assert/strict';
import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';
import type { Actions } from '../../src/game/input';
import { stepWorld } from '../../src/game/sim';
import { ProceduralAnimationController as Controller }
  from '../../src/game/ProceduralAnimationController';
import { BODY, NODE_INV_MASS } from '../../src/game/body-model';
import { activeBodyControl } from '../../src/game/active-body-control';
import { supportMotion } from '../../src/game/support-motion';
import { bodyTaskTargets as tasks, TASK_PRIORITY as priority }
  from '../../src/game/body-task-targets';

// Isolated fixtures use the production world, controller and body solver.
// No replacement physics or renderer. Full-world timing is separate.
function fixture(full = false) {
  const w = new World();
  w.seed = 12345;
  buildLevel(w);
  const p = w.player();
  const propTemplate = { ...w.props[0]! };
  if (!full) {
    w.actors = [p]; w.props = []; w.colliders = [];
    w.buildings = []; w.fuel.fill(0);
    p.x = 0; p.z = 0; p.yaw = 0;
  }
  const b = new Controller(); b.bootstrap(w);
  const cam = { yaw: p.yaw, pitch: 0 };
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
  return { w, p, b, cam, tick, propTemplate };
}

for (const side of [-1, 1]) {
  const { p, cam, tick } = fixture();
  for (let i = 0; i < 30; i++) tick({ moveX: side });
  const facing = p.yaw;
  assert(facing * side < -1.4, 'left/right facing reversed');
  cam.yaw += 0.7;
  for (let i = 0; i < 90; i++) tick();
  assert.equal(p.yaw, facing, 'release/camera reset facing');
}
console.log('PASS facing: left/right, release, camera independence');

function walk(cut = false, sprint = false) {
  const { p, tick } = fixture();
  const z = p.z;
  const drive = supportMotion.drive;
  if (cut) supportMotion.drive = () => {};
  try {
    for (let i = 0; i < 120; i++) {
      tick({ moveY: 1, sprint });
    }
    return { speed: (z - p.z) / 2, alive: p.alive,
      balance: p.balance };
  } finally { supportMotion.drive = drive; }
}
const walking = walk();
const cutWalking = walk(true);
const sprinting = walk(false, true);
assert(walking.speed > 3.3, 'normal movement is still too slow');
assert(walking.speed > cutWalking.speed + 0.6,
  'support reaction does not cause locomotion');
assert(sprinting.speed > walking.speed + 0.3,
  'sprint does not outperform normal movement');
assert(walking.alive && sprinting.alive, 'movement killed player');
console.log('PASS locomotion', { walking, cutWalking, sprinting });

{
  const { w, p, b } = fixture();
  const rig = b.get(p)!;
  tasks.beginStep();
  tasks.offerWorld(p, BODY.chest,
    rig.x[1]! + 0.2, rig.y[1]!, rig.z[1]! - 0.25,
    1, priority.ACTION);
  tasks.finalizeStep(STEP);
  const px = Array.from(rig.px), pz = Array.from(rig.pz);
  activeBodyControl.driveTasksPreIntegration(
    w, p, rig, STEP, 'follow');
  let netX = 0, netZ = 0, local = 0;
  for (let i = 0; i < rig.x.length; i++) {
    const dx = (px[i]! - rig.px[i]!) / STEP;
    const dz = (pz[i]! - rig.pz[i]!) / STEP;
    netX += dx / NODE_INV_MASS[i]!;
    netZ += dz / NODE_INV_MASS[i]!;
    local += Math.hypot(dx, dz);
  }
  assert(Math.hypot(netX, netZ) < 0.0001,
    'internal task motor creates net horizontal momentum');
  assert(local > 1, 'momentum conserved only by disabling motors');
  console.log('PASS motor momentum', { netX, netZ, local });
}

function strike(kick: boolean, cutGuard = false) {
  const { w, p, b, tick } = fixture();
  // Sever the final shoulder -> guard edge at its actual producer.
  const melee = (b as any).melee;
  if (cutGuard) melee.finishCoupledTasks = () => {};
  const values: number[] = [];
  let peak = 0, reach = 0, turn = 0, handHeight = 0;
  let firstLift = 0, supportHeight = 0;
  for (let i = 0; i < 36; i++) {
    tick(i === 0 ? kick
      ? { kickPressed: true } : { attackPressed: true } : {});
    const r = b.get(p)!;
    const n = kick ? BODY.rFoot : BODY.lHand;
    if (i < 20) {
      peak = Math.max(peak, Math.hypot(
        (r.x[n]! - r.px[n]!) / STEP,
        (r.y[n]! - r.py[n]!) / STEP,
        (r.z[n]! - r.pz[n]!) / STEP));
      reach = Math.max(reach, p.z - r.z[n]!);
    }
    if (i === 2) firstLift = r.y[BODY.rFoot]!;
    if (i < 20 && kick) supportHeight = Math.max(supportHeight, r.y[BODY.lFoot]!);
    if (i === 12) {
      turn = Math.abs(Math.atan2(
        r.z[4]! - r.z[3]!, r.x[4]! - r.x[3]!));
      handHeight = Math.min(r.y[7]!, r.y[8]!);
    }
    values.push(...r.x, ...r.y, ...r.z);
  }
  assert(values.every(Number.isFinite), 'nonfinite solved pose');
  return { values, peak, reach, turn, handHeight, firstLift, supportHeight };
}
const kick = strike(true), punch = strike(false);
assert(kick.supportHeight < 0.22, 'kick support foot climbs off ground');
assert(kick.firstLift > 0.2, 'kick waits before lifting');
assert(kick.turn > 0.9, 'kick remains front-facing');
assert(kick.handHeight > 1.2, 'kick puts hands on hips');
assert(kick.reach > 0.6 && kick.peak > 8, 'weak kick');
assert(punch.reach > 0.6 && punch.peak > 9, 'weak punch');
assert.deepEqual(strike(true).values, kick.values,
  'kick replay diverges in same runtime');
assert.deepEqual(strike(false).values, punch.values,
  'punch replay diverges in same runtime');
const severed = strike(true, true);
assert(Math.abs(kick.handHeight - severed.handHeight) > 0.04,
  'turned shoulders do not affect guard');
console.log('PASS strikes and replay', {
  kick: { peak: kick.peak, reach: kick.reach, turn: kick.turn,
    handHeight: kick.handHeight, firstLift: kick.firstLift,
    supportHeight: kick.supportHeight },
  severedGuardHeight: severed.handHeight,
  punch: { peak: punch.peak, reach: punch.reach },
});

function punchTarget(cutContact = false) {
  const { w, b, tick, propTemplate } = fixture();
  const target = { ...propTemplate, id: 7000,
    x: -0.1, y: 1.18, z: -0.58,
    px: -0.1, py: 1.18, pz: -0.58,
    sx: 0.12, sy: 0.12, sz: 0.12,
    hp: 100, mass: 30, vx: 0, vy: 0, vz: 0,
    heldBy: 0, collapsed: false, dynamic: false,
    anchored: true, oil: false };
  w.props = [target];
  if (cutContact) (b as any).melee.resolveContact = () => {};
  for (let i = 0; i < 36; i++)
    tick(i === 0 ? { attackPressed: true } : {});
  return 100 - target.hp;
}
const punchDamage = punchTarget();
assert(punchDamage > 21, 'punch contact lost its added weight');
assert.equal(punchTarget(true), 0,
  'damage bypasses the solved-effector contact path');
console.log('PASS fist contact and contact severance', { punchDamage });

const { w, p, tick } = fixture(true);
const start = performance.now();
for (let i = 0; i < 120; i++) tick({ moveY: 1 });
console.log('BUDGET full world', {
  actors: w.actors.length, props: w.props.length,
  msPerTick: (performance.now() - start) / 120,
  alive: p.alive, balance: p.balance,
});
