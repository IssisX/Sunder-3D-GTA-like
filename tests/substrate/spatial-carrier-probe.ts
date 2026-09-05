import assert from 'node:assert/strict';
import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';
import type { Actions } from '../../src/game/input';
import { stepWorld } from '../../src/game/sim';
import { ProceduralAnimationController } from '../../src/game/ProceduralAnimationController';
import { EDGES } from '../../src/game/legacy-human-melee-firewall';

function injuryMagnitude(a: ReturnType<World['player']>) {
  let total = a.pain;
  for (const i of Object.values(a.injuries)) {
    total += i.bruise + i.cut + i.puncture + i.burn + i.fracture + i.sprain;
  }
  return total;
}

function run(firewall: boolean) {
  const w = new World();
  w.seed = 424242;
  buildLevel(w);
  const p = w.player();
  const attacker = w.actors.find((a) => a.id !== p.id && a.species === 'human')!;
  w.actors = [p, attacker];
  w.props = [];
  w.colliders = [];
  w.buildings = [];
  w.fuel.fill(0);
  w.heat.fill(0);
  w.burning.fill(0);

  p.x = 0; p.y = 0; p.z = 0;
  p.vx = p.vy = p.vz = 0;
  attacker.x = 0; attacker.y = 0; attacker.z = 0.8;
  attacker.vx = attacker.vy = attacker.vz = 0;
  attacker.yaw = 0;
  attacker.weapon = 'fist';
  attacker.faction = 'civilian';
  attacker.known.length = 0;
  attacker.routine.length = 0;
  attacker.attackCd = 1;
  attacker.strikeT = 0.15; // legacy timer is inside its old active damage window
  attacker.strikeHit = 0;

  const input = {
    moveX: 0, moveY: 0, lookX: 0, lookY: 0,
  } as Actions;
  const controller = new ProceduralAnimationController();
  controller.bootstrap(w);

  const prior = EDGES.suppressLegacyHumanoidMelee;
  EDGES.suppressLegacyHumanoidMelee = firewall;
  const before = injuryMagnitude(p);
  try {
    controller.prepareStep(w, STEP);
    stepWorld(w, STEP, input, { yaw: 0, pitch: 0 }, true);
    controller.step(w, STEP);
  } finally {
    EDGES.suppressLegacyHumanoidMelee = prior;
  }
  return injuryMagnitude(p) - before;
}

const canonical = run(true);
const severed = run(false);
console.log('SPATIAL-CARRIER', { canonical, severed });

assert(canonical < 1e-6,
  'legacy humanoid timer/range path still applies damage');
assert(severed > 0.01,
  'firewall severance does not restore the legacy magic-hit consequence');
