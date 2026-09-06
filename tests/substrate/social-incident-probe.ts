import assert from "node:assert/strict";
import { World } from "../../src/game/world";
import { EDGES, SOCIAL_ROLE, socialIncidents } from "../../src/game/social-incident";

function addPlayer(w: World, x = 0, z = 0) {
  const p = w.addActor({ kind: "player", species: "human", faction: "player", name: "you", x, z, courage: 0.7, aggression: 0.5, competence: 0.6 });
  w.playerId = p.id;
  return p;
}
function addGuard(w: World, x: number, z: number) {
  return w.addActor({ kind: "human", species: "human", faction: "guard", name: "guard", x, z, homeX: x, homeZ: z, courage: 0.9, aggression: 0.75, loyalty: 0.9, competence: 0.8 });
}
function addCivilian(w: World, x: number, z: number) {
  return w.addActor({ kind: "human", species: "human", faction: "civilian", name: "civilian", x, z, homeX: x, homeZ: z, courage: 1, aggression: 0.25, loyalty: 0.45, competence: 0.45, fear: 0 });
}
function singleFightWorld() {
  const w = new World(); w.seed = 1729;
  const player = addPlayer(w); const victim = addGuard(w, 1.05, 0);
  const spectators = [addCivilian(w, 2.8, 0.3), addCivilian(w, -2.9, 0.4), addCivilian(w, 0.4, 3.2)];
  const outsider = addCivilian(w, 16, 0);
  return { w, player, victim, spectators, outsider };
}
function smallPileOnWorld() {
  const w = new World(); w.seed = 9871;
  const player = addPlayer(w); const victim = addGuard(w, 1.05, 0);
  const allyA = addGuard(w, 2.6, 0.5); const allyB = addGuard(w, 2.8, -0.7);
  addCivilian(w, -2.7, 0.2);
  return { w, player, victim, allyA, allyB };
}
function roleCount(w: World, role: number) {
  let n = 0;
  for (const a of w.actors) if (a.kind !== "player" && socialIncidents.roleOf(a.id) === role) n++;
  return n;
}

try {
  EDGES.localIncidentRoles = true;
  socialIncidents.reset();
  const one = singleFightWorld();
  socialIncidents.reportAggression(one.w, one.player, one.victim, "strike", 0.4);
  const singleFighters = roleCount(one.w, SOCIAL_ROLE.FIGHTER);
  const singleSpectators = roleCount(one.w, SOCIAL_ROLE.SPECTATOR);
  assert.equal(singleFighters, 1, "an incident without allies should remain a 1v1");
  assert.ok(singleSpectators >= 1, "nearby uninvolved people should spectate instead of fighting");
  assert.equal(socialIncidents.roleOf(one.outsider.id), SOCIAL_ROLE.NONE, "a distant person must remain uninvolved");
  for (let i = 0; i < 8; i++) { one.w.time += 0.25; socialIncidents.step(one.w, 0.25); }
  const chantEvents = one.w.events.filter((e) => e.kind === "social:chant");
  assert.ok(chantEvents.length > 0, "a live spectator ring should produce staggered FIGHT chant events");
  assert.ok(chantEvents.every((e) => e.text === "FIGHT!"), "bubble and voice must read the same incident chant event");

  socialIncidents.reset();
  const many = smallPileOnWorld();
  socialIncidents.reportAggression(many.w, many.player, many.victim, "kick", 0.55);
  const smallGroupFighters = roleCount(many.w, SOCIAL_ROLE.FIGHTER);
  assert.equal(smallGroupFighters, 3, "two committed local allies should produce a 1v3 pile-on");
  assert.equal(socialIncidents.fightTarget(many.allyA.id), many.player.id);
  assert.equal(socialIncidents.fightTarget(many.allyB.id), many.player.id);

  socialIncidents.reset();
  EDGES.localIncidentRoles = false;
  const cut = singleFightWorld();
  socialIncidents.reportAggression(cut.w, cut.player, cut.victim, "strike", 0.4);
  socialIncidents.step(cut.w, 0.25);
  const cutRoles = cut.w.actors.filter((a) => a.kind !== "player" && socialIncidents.roleOf(a.id) !== SOCIAL_ROLE.NONE).length;
  assert.equal(cutRoles, 0, "severing localIncidentRoles must remove the local social consequence");

  console.log("PASS local social incident roles", { singleFighters, singleSpectators, chantEvents: chantEvents.length, smallGroupFighters, cutRoles });
} finally {
  EDGES.localIncidentRoles = true;
  socialIncidents.reset();
}
