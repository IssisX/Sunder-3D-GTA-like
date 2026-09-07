import assert from 'node:assert/strict';
import type { Actions } from '../../src/game/input';
import { ProceduralAnimationController as Controller }
  from '../../src/game/ProceduralAnimationController';
import { BODY } from '../../src/game/body';
import { EDGES, PUNCH }
  from '../../src/game/boxing-combinations';
import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';

function input(attackPressed: boolean): Actions {
  return {
    moveX: 0, moveY: 0, lookX: 0, lookY: 0,
    sprint: false, crouch: false, jump: false,
    jumpPressed: false, attack: false, attackPressed,
    grab: false, grabPressed: false, grabReleased: false,
    kick: false, kickPressed: false, shove: false,
    shovePressed: false, drop: false, dropPressed: false,
    bandage: false, ignite: false, ignitePressed: false,
    pausePressed: false,
  };
}

function run(supportDrive: boolean) {
  const prior = EDGES.supportCoupledDrive;
  EDGES.supportCoupledDrive = supportDrive;
  const w = new World();
  w.seed = 12345;
  buildLevel(w);
  const p = w.player();
  w.actors = [p];
  w.props = [];
  w.colliders = [];
  w.buildings = [];
  w.fuel.fill(0);
  p.x = 0; p.y = 0; p.z = 0; p.yaw = 0;
  p.vx = 0; p.vy = 0; p.vz = 0;
  p.grounded = true; p.weapon = 'fist';
  p.strikeCd = 0; p.stamina = 1;
  p.consciousness = 1; p.loco = 'idle';
  const body = new Controller();
  body.bootstrap(w);
  const melee = (body as unknown as {
    melee: { slotById: Int16Array;
      boxing: { profile(slot: number): number } };
  }).melee;
  const slot = melee.slotById[p.id]!;
  const rig = body.get(p)!;
  const startX = rig.x[BODY.lHand]!;
  const startY = rig.y[BODY.lHand]!;
  const startZ = rig.z[BODY.lHand]!;
  const sequence: number[] = [];
  let lastProfile = 0;
  let maxHandTravel = 0;
  let maxHeight = 0;
  let trace = 0;
  const started = performance.now();
  try {
    for (let i = 0; i < 96; i++) {
      w.time += STEP;
      p.strikeCd = Math.max(0, p.strikeCd - STEP);
      const controls = input(i < 3);
      body.captureInput(controls);
      body.prepareInput(w, controls, STEP);
      body.prepareStep(w, STEP);
      body.step(w, STEP);
      const profile = melee.boxing.profile(slot);
      if (profile && profile !== lastProfile) {
        sequence.push(profile);
      }
      lastProfile = profile;
      const x = rig.x[BODY.lHand]!;
      const y = rig.y[BODY.lHand]!;
      const z = rig.z[BODY.lHand]!;
      const travel = Math.hypot(
        x - startX, y - startY, z - startZ,
      );
      maxHandTravel = Math.max(maxHandTravel, travel);
      maxHeight = Math.max(maxHeight, rig.y[BODY.pelvis]!);
      trace += rig.x[BODY.pelvis]! * 0.31 +
        rig.z[BODY.chest]! * 0.17 + x * 0.23 + z * 0.29;
      assert(Number.isFinite(trace), 'body state became non-finite');
    }
    return {
      sequence, maxHandTravel, maxHeight, trace,
      msPerTick: (performance.now() - started) / 96,
    };
  } finally {
    body.clear();
    EDGES.supportCoupledDrive = prior;
  }
}

const actual = run(true);
const replay = run(true);
const severed = run(false);
console.log('BOXING-BODY', { actual, severed });
assert.deepEqual(actual.sequence, [
  PUNCH.JAB, PUNCH.CROSS, PUNCH.LEAD_UPPERCUT,
], 'three rapid taps did not become three physical punches');
assert(actual.maxHandTravel > 0.04,
  'the fist never achieved a visible physical movement');
assert(actual.maxHeight < 2.5,
  'the punch generated an unsupported vertical launch');
assert.equal(actual.trace, replay.trace,
  'identical fixed-step input did not replay identically');
assert(Math.abs(actual.trace - severed.trace) > 1e-4,
  'cutting support-coupled drive did not change solved motion');
