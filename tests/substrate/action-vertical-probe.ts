import assert from "node:assert/strict";
import type { Actions } from "../../src/game/input";
import { ProceduralAnimationController as Controller } from "../../src/game/ProceduralAnimationController";
import { stepWorld } from "../../src/game/sim";
import { STEP } from "../../src/game/types";
import { World } from "../../src/game/world";
import { buildLevel } from "../../src/game/level";

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
  p.yaw = 0;
  const body = new Controller();
  body.bootstrap(w);
  const cam = { yaw: 0, pitch: 0 };
  function tick(delta: Partial<Actions> = {}) {
    const input = {
      moveX: 0, moveY: 0, lookX: 0, lookY: 0,
      sprint: false, crouch: false, jump: false, jumpPressed: false,
      attack: false, attackPressed: false, grab: false, grabPressed: false,
      grabReleased: false, kick: false, kickPressed: false, shove: false,
      shovePressed: false, drop: false, dropPressed: false, bandage: false,
      ignite: false, ignitePressed: false, pausePressed: false,
      ...delta,
    } as Actions;
    body.captureInput(input);
    body.prepareInput(w, input, STEP);
    body.prepareStep(w, STEP);
    stepWorld(w, STEP, input, cam, true);
    body.step(w, STEP);
  }
  for (let i = 0; i < 60; i++) tick();
  return { w, p, tick };
}

function verticalRise(press: Partial<Actions>) {
  const { p, tick } = fixture();
  const startY = p.y;
  let rise = 0;
  for (let i = 0; i < 150; i++) {
    tick(i === 0 ? press : {});
    rise = Math.max(rise, p.y - startY);
  }
  return rise;
}

function closeTargetGrab() {
  const { w, p, tick } = fixture();
  const crate = w.addProp({
    kind: "crate", x: 0.22, y: 0.55, z: -0.12,
    sx: 0.34, sy: 0.34, sz: 0.34, mass: 5,
    anchored: false, dynamic: true,
  });
  w.rebuildHash();
  const startY = p.y;
  let rise = 0;
  for (let i = 0; i < 90; i++) {
    tick(i === 0 ? { grab: true, grabPressed: true } : {});
    rise = Math.max(rise, p.y - startY);
  }
  return { acquired: p.grabbedId === crate.id, rise };
}

const idleRise = verticalRise({});
const emptyGrabRise = verticalRise({ grab: true, grabPressed: true });
const jumpRise = verticalRise({ jump: true, jumpPressed: true });
const targetGrab = closeTargetGrab();

console.log("ACTION-VERTICAL", {
  idleRise,
  emptyGrabRise,
  jumpRise,
  targetGrab,
});

assert(emptyGrabRise <= idleRise + 0.03,
  "an empty-space grab created vertical body motion");
assert(jumpRise > 0.2, "the explicit jump edge no longer creates a jump");
assert(targetGrab.acquired, "a close valid grab target was not acquired");
assert(targetGrab.rise < 0.06,
  "acquiring a close valid target created a vertical launch");
