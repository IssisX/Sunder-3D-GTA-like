import assert from 'node:assert/strict';
import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';
import type { Actions } from '../../src/game/input';
import { stepWorld } from '../../src/game/sim';
import { ProceduralAnimationController as Controller }
  from '../../src/game/ProceduralAnimationController';
import { BODY_TACTICS_EDGES } from '../../src/game/body-tactics';

function run(cut: boolean) {
  const w = new World();
  w.seed = 424242;
  buildLevel(w);
  const p = w.player();
  const guard = w.actors.find((a) => a.faction === 'guard' && a.species === 'human');
  assert(guard, 'fixture has no human guard');

  // Isolate one guard and one player from crowd/fire/routing confounds while
  // preserving the real world, body controller and legacy AI pipeline.
  w.actors = [p, guard];
  w.wanted = 0;
  p.x = 0; p.y = 0; p.z = 0; p.vx = p.vy = p.vz = 0;
  guard.x = 0; guard.y = 0; guard.z = -0.92;
  guard.vx = guard.vy = guard.vz = 0;
  guard.weapon = 'fist';
  guard.attackCd = 0; guard.strikeCd = 0; guard.strikeT = 0;
  guard.known.length = 0;
  guard.targetId = 0;

  const b = new Controller();
  b.bootstrap(w);
  const cam = { yaw: p.yaw, pitch: 0 };
  function tick() {
    const input = { moveX: 0, moveY: 0, lookX: 0, lookY: 0 } as Actions;
    b.captureInput(input);
    b.prepareInput(w, input, STEP);
    b.prepareStep(w, STEP);
    stepWorld(w, STEP, input, cam, true);
    b.step(w, STEP);
  }

  // Settle the same body state before cutting the single tactical read edge.
  for (let i = 0; i < 8; i++) tick();
  BODY_TACTICS_EDGES.solvedBodyTactics = !cut;
  p.consciousness = 0.05;
  guard.known.push(p.id);
  guard.targetId = p.id;
  guard.lastSeenX = p.x;
  guard.lastSeenZ = p.z;
  guard.lastSeenT = w.time;
  guard.attackCd = 0;
  guard.strikeCd = 0;
  guard.strikeT = 0;
  w.wanted = 1;

  tick();
  const result = {
    strikeT: guard.strikeT,
    intendSpeed: guard.intendSpeed,
    ai: guard.ai,
    playerConsciousness: p.consciousness,
  };
  BODY_TACTICS_EDGES.solvedBodyTactics = true;
  b.clear();
  return result;
}

const live = run(false);
const severed = run(true);
console.log('DIAG solved-body tactics', { live, severed });
assert.equal(live.strikeT, 0,
  'guard still commits a strike against a physically incapacitated target');
assert(severed.strikeT > 0.02,
  'severing solved-body tactics does not restore legacy attack commitment');
assert(live.intendSpeed < severed.intendSpeed,
  'incapacity evidence does not change guard closing behavior');
console.log('PASS solved body -> tactical commitment severance');
