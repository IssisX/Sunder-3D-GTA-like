import assert from 'node:assert/strict';
import { World } from '../../src/game/world';
import { buildLevel } from '../../src/game/level';
import { STEP } from '../../src/game/types';
import type { Actions } from '../../src/game/input';
import { stepWorld } from '../../src/game/sim';
import { ProceduralAnimationController as Controller } from '../../src/game/ProceduralAnimationController';
import { BODY } from '../../src/game/body-model';
import { bodyTaskTargets as tasks } from '../../src/game/body-task-targets';
import { COMBAT_EDGES } from '../../src/game/combat-load-transfer';

function trial(enabled: boolean, attack: boolean) {
  COMBAT_EDGES.loadTransfer = enabled;
  const w = new World(); w.seed = 12345; buildLevel(w);
  const p = w.player();
  w.actors = [p]; w.props = []; w.colliders = []; w.buildings = []; w.fuel.fill(0);
  p.x = 0; p.z = 0; p.yaw = 0;
  const b = new Controller(); b.bootstrap(w);
  const cam = { yaw: 0, pitch: 0 };
  let travel = 0, displacement = 0, maxHeight = 0;
  const trace: number[] = [];
  function tick(input: Partial<Actions> = {}) {
    const a = { moveX:0, moveY:0, lookX:0, lookY:0, ...input } as Actions;
    b.captureInput(a); b.prepareInput(w,a,STEP); b.prepareStep(w,STEP);
    stepWorld(w,STEP,a,cam,true); b.step(w,STEP);
  }
  for(let i=0;i<60;i++) tick();
  const rig = b.get(p)!;
  const startZ = p.z;
  for(let i=0;i<120;i++) {
    tick(attack ? {attackPressed:i===0,moveY:1} : {moveY:1});
    const dx = tasks.targetXFor(p,BODY.chest)-rig.x[BODY.chest]!;
    const dz = tasks.targetZFor(p,BODY.chest)-rig.z[BODY.chest]!;
    displacement += Math.hypot(dx,dz);
    maxHeight=Math.max(maxHeight,p.y);
    trace.push(Math.round(p.z*1e5));
  }
  travel=(startZ-p.z)/2;
  b.clear();
  return {travel,displacement,maxHeight,trace};
}
const normal = trial(true,false);
const cutNormal = trial(false,false);
assert.deepEqual(normal.trace,cutNormal.trace,'load transfer changed ordinary walking');
assert(normal.travel>3.3,'ordinary walking regressed');
const active = trial(true,true);
const cut = trial(false,true);
assert(active.displacement!==cut.displacement,'active strike did not change torso tasks');
assert(active.maxHeight<2.5,'strike launched body');
assert(cut.maxHeight<2.5,'control strike launched body');
const replay=trial(true,true);
assert.deepEqual(active.trace,replay.trace,'replay diverged');
COMBAT_EDGES.loadTransfer=true;
console.log('COMBAT-LOAD-TRANSFER PASS',{walking:normal.travel,activeTravel:active.travel,cutTravel:cut.travel,taskDifference:active.displacement-cut.displacement});
