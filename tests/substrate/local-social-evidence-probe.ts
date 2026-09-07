import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { Actions } from "../../src/game/input";
import { EDGES, SocialAwarenessController } from "../../src/game/social-awareness";
import { stepWorld } from "../../src/game/sim";
import { World } from "../../src/game/world";

const DT = 1 / 60;
const CAM = { yaw: 0, pitch: 0 };
const INPUT: Actions = {
  moveX: 0, moveY: 0, lookX: 0, lookY: 0,
  sprint: false, crouch: false,
  jump: false, jumpPressed: false,
  attack: false, attackPressed: false,
  grab: false, grabPressed: false, grabReleased: false,
  kick: false, kickPressed: false,
  shove: false, shovePressed: false,
  drop: false, dropPressed: false,
  bandage: false,
  ignite: false, ignitePressed: false,
  pausePressed: false,
};

function tick(w: World, social: SocialAwarenessController) {
  social.beginStep(w);
  stepWorld(w, DT, { ...INPUT }, CAM, false);
  social.endStep(w);
}

function guardScenario(localEvidence: boolean) {
  EDGES.localEvidence = localEvidence;
  const w = new World();
  w.day = 0.5;
  const player = w.addActor({
    kind: "player", species: "human", faction: "player",
    x: 0, z: 0, yaw: 0,
  });
  w.playerId = player.id;
  const reporter = w.addActor({
    kind: "human", species: "human", faction: "guard",
    x: 0, z: 2, yaw: 0,
    courage: 0.9, aggression: 0.8,
  });
  reporter.known.push(player.id);
  reporter.targetId = player.id;
  reporter.lastSeenX = player.x;
  reporter.lastSeenZ = player.z;
  reporter.lastSeenT = 0;
  reporter.alert = 1;

  const hidden = w.addActor({
    kind: "human", species: "human", faction: "guard",
    x: 4, z: 2, yaw: 0,
    courage: 0.8,
  });
  const visible = w.addActor({
    kind: "human", species: "human", faction: "guard",
    x: -3, z: 2, yaw: 0,
    courage: 0.8,
  });

  // Tall wall blocks hidden guard -> player sight, but not the reporter's shout.
  w.addBox(2, 0, 1, 1.2, 2.4, 1.2, { material: "stone" });
  const social = new SocialAwarenessController();
  const start = performance.now();
  tick(w, social);
  const ms = performance.now() - start;

  return {
    ms,
    hiddenKnown: hidden.known.includes(player.id),
    hiddenAi: hidden.ai,
    hiddenTarget: hidden.targetId,
    hiddenAllyMemory: hidden.memories.some((m) => m.kind === "ally" && m.who === reporter.id),
    visibleKnown: visible.known.includes(player.id),
    reporterKnown: reporter.known.includes(player.id),
  };
}

function panicScenario() {
  EDGES.localEvidence = true;
  const w = new World();
  w.day = 0.5;
  const player = w.addActor({
    kind: "player", species: "human", faction: "player",
    x: -5, z: 0,
  });
  w.playerId = player.id;
  const civilian = w.addActor({
    kind: "human", species: "human", faction: "civilian",
    x: 0, z: 0, yaw: Math.PI * 0.5,
    fear: 0.95, courage: 0,
  });
  w.addMemory(civilian, "fire", 5, 0, 0, 1);
  const social = new SocialAwarenessController();
  tick(w, social);
  return { ai: civilian.ai, intendX: civilian.intendX, intendZ: civilian.intendZ };
}

const legacy = guardScenario(false);
const canonical = guardScenario(true);
const replay = guardScenario(true);
const panic = panicScenario();
EDGES.localEvidence = true;

console.log("LOCAL-SOCIAL-EVIDENCE", { canonical, legacy, panic, msPerTick: { legacy: legacy.ms, canonical: canonical.ms } });

assert.equal(canonical.reporterKnown, true, "directly informed guard lost its personal evidence");
assert.equal(canonical.hiddenKnown, false, "a shout still broadcast player hostility through a wall");
assert.equal(canonical.hiddenAi, "investigate", "hidden ally did not investigate the actual shout source");
assert.notEqual(canonical.hiddenTarget, 1, "hidden ally still targeted the player without seeing them");
assert.equal(canonical.hiddenAllyMemory, true, "heard ally shout did not become local investigation evidence");
assert.equal(canonical.visibleKnown, true, "a guard who could actually see the reported target failed to join the incident");
assert.equal(legacy.hiddenKnown, true, "severing local-evidence mediation no longer exposes the old radio-broadcast behavior");
assert.equal(panic.ai, "flee", "source-bound panic stopped being panic");
assert(panic.intendX < -0.5, "civilian panic still ran away from the player instead of the remembered fire");

const deterministicKeys = ["hiddenKnown", "hiddenAi", "hiddenTarget", "hiddenAllyMemory", "visibleKnown", "reporterKnown"] as const;
for (const key of deterministicKeys) {
  assert.deepEqual(canonical[key], replay[key], `local social mediation was not deterministic for ${key}`);
}
