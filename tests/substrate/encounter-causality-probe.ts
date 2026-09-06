import assert from "node:assert/strict";
import type { Actions } from "../../src/game/input";
import { ProceduralAnimationController as Controller } from "../../src/game/ProceduralAnimationController";
import { stepWorld } from "../../src/game/sim";
import { STEP } from "../../src/game/types";
import { World } from "../../src/game/world";
import { buildLevel } from "../../src/game/level";

const input: Actions = {
  moveX: 0, moveY: 0, lookX: 0, lookY: 0,
  sprint: false, crouch: false, jump: false, jumpPressed: false,
  attack: false, attackPressed: false, grab: false, grabPressed: false,
  grabReleased: false, kick: false, kickPressed: false, shove: false,
  shovePressed: false, drop: false, dropPressed: false, bandage: false,
  ignite: false, ignitePressed: false, pausePressed: false,
};

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
  p.y = 0;
  p.z = 0;
  p.yaw = 0;
  p.vx = 0;
  p.vz = 0;
  return { w, p };
}

function tick(w: World) {
  stepWorld(w, STEP, { ...input }, { yaw: 0, pitch: 0 }, true);
}

function quietWeaponPresence() {
  const { w, p } = fixture();
  p.weapon = "knife";
  const civilian = w.addActor({
    kind: "human", species: "human", faction: "civilian",
    x: 0, y: 0, z: -2, yaw: Math.PI, courage: 0.3,
  });
  tick(w);
  return { targetId: civilian.targetId, alert: civilian.alert, playerId: p.id };
}

function cautiousCivilianResponse() {
  const { w, p } = fixture();
  const civilian = w.addActor({
    kind: "human", species: "human", faction: "civilian",
    x: 0, y: 0, z: -2, yaw: Math.PI, courage: 0.55,
  });
  // A visible threatening action is not a hit: it should create space, not
  // immediately make the whole encounter panic or fight.
  p.strikeT = 0.3;
  tick(w);
  return { ai: civilian.ai, intendZ: civilian.intendZ };
}

function directCivilianResponse() {
  const { w, p } = fixture();
  const civilian = w.addActor({
    kind: "human", species: "human", faction: "civilian",
    x: 0, y: 0, z: -2, yaw: Math.PI, courage: 0.8,
  });
  civilian.lastHitBy = p.id;
  civilian.lastHitT = w.time;
  tick(w);
  return { ai: civilian.ai, intendZ: civilian.intendZ };
}

function guardedChallenge() {
  const { w, p } = fixture();
  const guard = w.addActor({
    kind: "human", species: "human", faction: "guard",
    x: 0, y: 0, z: -2, yaw: Math.PI, courage: 0.85,
  });
  w.addMemory(guard, "threat", p.x, p.z, p.id, 0.9);
  guard.alert = 0.8;
  tick(w);
  return {
    ai: guard.ai,
    targetId: guard.targetId,
    encounterId: guard.encounterId,
    encounterT: guard.encounterT,
    playerId: p.id,
  };
}

function localGuardResponse() {
  const { w, p } = fixture();
  const lead = w.addActor({
    kind: "human", species: "human", faction: "guard",
    x: 0, y: 0, z: -2, yaw: Math.PI, courage: 0.85,
  });
  const witness = w.addActor({
    kind: "human", species: "human", faction: "guard",
    x: 6, y: 0, z: -2, yaw: Math.PI, courage: 0.85,
  });
  // This is the direct evidence a guard should need before attacking.
  lead.lastHitBy = p.id;
  lead.lastHitT = w.time;
  tick(w);
  return {
    leadAi: lead.ai,
    witnessAi: witness.ai,
    witnessKnowsPlayer: witness.known.includes(p.id),
    witnessAlert: witness.alert,
  };
}

function passiveAnimals() {
  const herd = fixture();
  const goat = herd.w.addActor({
    kind: "beast", species: "goat", faction: "wild",
    x: 0, y: 0, z: -3, aggression: 0.1,
  });
  tick(herd.w);

  const bearWorld = fixture();
  const bear = bearWorld.w.addActor({
    kind: "beast", species: "bear", faction: "wild",
    x: 0, y: 0, z: -4, aggression: 0.1,
  });
  tick(bearWorld.w);
  return {
    goatAi: goat.ai,
    bearAi: bear.ai,
    bearTargetId: bear.targetId,
    playerId: bearWorld.p.id,
  };
}

function panicFleesCause() {
  const { w, p } = fixture();
  p.x = -6;
  const civilian = w.addActor({
    kind: "human", species: "human", faction: "civilian",
    x: 0, y: 0, z: 0, courage: 0, fear: 1,
  });
  w.addMemory(civilian, "fire", 6, 0, 0, 1);
  tick(w);
  return { ai: civilian.ai, intendX: civilian.intendX };
}

function guardMeleeAuthority() {
  function starts(ai: "combat" | "investigate" | "warn", known: boolean) {
    const { w, p } = fixture();
    const guard = w.addActor({
      kind: "human", species: "human", faction: "guard",
      x: 0, y: 0, z: -1, yaw: Math.PI,
      ai, targetId: p.id, lastSeenT: w.time,
      known: known ? [p.id] : [],
    });
    const body = new Controller();
    body.bootstrap(w);
    const melee = (body as any).melee;
    melee.prepareStep(w, STEP);
    return melee.isActive(guard.id);
  }
  return {
    staleKnownStarts: starts("investigate", true),
    warningStarts: starts("warn", true),
    directCombatStarts: starts("combat", false),
  };
}

const weapon = quietWeaponPresence();
const wary = cautiousCivilianResponse();
const directCivilian = directCivilianResponse();
const challenge = guardedChallenge();
const guard = localGuardResponse();
const animals = passiveAnimals();
const panic = panicFleesCause();
const meleeAuthority = guardMeleeAuthority();

console.log("ENCOUNTER-CAUSALITY", {
  weapon, wary, directCivilian, challenge, guard, animals, panic, meleeAuthority,
});

assert.notEqual(weapon.targetId, weapon.playerId,
  "an equipped but passive player became a civilian threat");
assert.equal(wary.ai, "wary",
  "a witnessed close weapon action did not create a cautious civilian response");
assert(wary.intendZ < -0.2,
  "a cautious civilian moved toward the threatening player instead of creating space");
assert.equal(directCivilian.ai, "flee",
  "a directly harmed civilian did not escalate beyond caution");
assert(directCivilian.intendZ < -0.2,
  "a directly harmed civilian fled toward the attacker");
assert.equal(challenge.ai, "warn",
  "a guard with local incident evidence skipped the challenge stage");
assert.equal(challenge.encounterId, challenge.playerId,
  "the guard did not own its local encounter state");
assert(challenge.encounterT > 3.5,
  "the guard challenge was not given a bounded grace window");
assert.notEqual(challenge.targetId, challenge.playerId,
  "a local incident challenge silently created a combat target");
assert.equal(guard.leadAi, "combat",
  "direct harm no longer produces a local guard response");
assert.equal(guard.witnessKnowsPlayer, false,
  "a guard shout turned every nearby guard into a hostile player target");
assert.equal(guard.witnessAi, "investigate",
  "a nearby guard did not investigate the local incident");
assert.notEqual(animals.goatAi, "flee",
  "a herd animal panicked merely because the player was nearby");
assert.notEqual(animals.bearAi, "hunt",
  "a calm bear hunted solely because the player was close");
assert.notEqual(animals.bearTargetId, animals.playerId,
  "a calm bear acquired the nearby player as prey");
assert.equal(panic.ai, "flee", "a frightened civilian did not flee");
assert(panic.intendX < -0.2,
  "a frightened civilian fled from the player instead of the danger source");
assert.equal(meleeAuthority.staleKnownStarts, false,
  "a stale known target started a guard melee action");
assert.equal(meleeAuthority.warningStarts, false,
  "a guard warning state started a melee action");
assert.equal(meleeAuthority.directCombatStarts, true,
  "a guard with direct combat evidence did not start a melee action");
