import type { Actor } from "./types";
import type { World } from "./world";
import { canSeeThrough, clamp } from "./world";
import { socialIncidents } from "./social-incident";

const ENTITY_ID_CAP = 8192;
const RADIO_HOLD = 0.08;

export const EDGES = { localEvidence: true };

function human(a: Actor) { return a.kind === "player" || a.species === "human"; }

export class SocialAwarenessController {
  private realWanted = 0;
  private proxyWanted = 0;
  private active = false;
  private beginTime = 0;
  private sourceX = 0;
  private sourceZ = 0;
  private readonly knownPlayerBefore = new Uint8Array(ENTITY_ID_CAP);
  private readonly radioHeld = new Uint8Array(ENTITY_ID_CAP);
  private readonly targetBefore = new Int32Array(ENTITY_ID_CAP);
  private readonly lastSeenXBefore = new Float32Array(ENTITY_ID_CAP);
  private readonly lastSeenZBefore = new Float32Array(ENTITY_ID_CAP);
  private readonly lastSeenTBefore = new Float32Array(ENTITY_ID_CAP);
  private readonly intendXBefore = new Float32Array(ENTITY_ID_CAP);
  private readonly intendZBefore = new Float32Array(ENTITY_ID_CAP);
  private readonly intendSpeedBefore = new Float32Array(ENTITY_ID_CAP);
  private readonly yawBefore = new Float32Array(ENTITY_ID_CAP);
  private readonly strikeTBefore = new Float32Array(ENTITY_ID_CAP);
  private readonly strikeCdBefore = new Float32Array(ENTITY_ID_CAP);
  private readonly attackCdBefore = new Float32Array(ENTITY_ID_CAP);
  private readonly aiBefore: Actor["ai"][] = new Array(ENTITY_ID_CAP).fill("idle");

  beginStep(w: World) {
    if (this.active) return;
    this.active = true;
    this.beginTime = w.time;
    this.realWanted = w.wanted;
    this.proxyWanted = Math.min(this.realWanted, 0.15);
    w.wanted = this.proxyWanted;
    if (!EDGES.localEvidence) return;
    for (const a of w.actors) {
      if (a.id < 0 || a.id >= ENTITY_ID_CAP) continue;
      const id = a.id;
      const knows = a.known.includes(w.playerId);
      this.knownPlayerBefore[id] = knows ? 1 : 0;
      this.targetBefore[id] = a.targetId;
      this.lastSeenXBefore[id] = a.lastSeenX;
      this.lastSeenZBefore[id] = a.lastSeenZ;
      this.lastSeenTBefore[id] = a.lastSeenT;
      this.intendXBefore[id] = a.intendX;
      this.intendZBefore[id] = a.intendZ;
      this.intendSpeedBefore[id] = a.intendSpeed;
      this.yawBefore[id] = a.yaw;
      this.strikeTBefore[id] = a.strikeT;
      this.strikeCdBefore[id] = a.strikeCd;
      this.attackCdBefore[id] = a.attackCd;
      this.aiBefore[id] = a.ai;
      this.radioHeld[id] = 0;
      if (a.faction === "guard" && !knows && a.shoutCd <= 0) {
        a.shoutCd = RADIO_HOLD;
        this.radioHeld[id] = 1;
      }
    }
  }

  endStep(w: World) {
    if (!this.active) return;
    const delta = w.wanted - this.proxyWanted;
    if (EDGES.localEvidence) {
      this.localizePlayerKnowledge(w);
      this.mediateAllyShouts(w);
      this.rewritePanicFromItsSource(w);
      this.restoreRadioHolds(w);
    }
    w.wanted = clamp(this.realWanted + delta, 0, 1);
    socialIncidents.step(w, Math.max(0, w.time - this.beginTime));
    this.active = false;
  }

  reset() {
    this.realWanted = 0; this.proxyWanted = 0; this.active = false; this.beginTime = 0;
    this.knownPlayerBefore.fill(0); this.radioHeld.fill(0);
    socialIncidents.reset();
  }

  private localizePlayerKnowledge(w: World) {
    const player = w.player();
    if (!player) return;
    for (const a of w.actors) {
      if (!human(a) || a.kind === "player" || a.id < 0 || a.id >= ENTITY_ID_CAP) continue;
      const id = a.id;
      if (this.knownPlayerBefore[id] || !a.known.includes(player.id)) continue;
      const directVictim = a.lastHitBy === player.id && w.time - a.lastHitT < 2;
      const reportedWitness = a.faction === "guard" && this.canSeePlayer(w, a, player) && this.heardFriendlyShout(w, a);
      if (directVictim || reportedWitness) continue;
      this.removeKnown(a, player.id);
      this.removeFreshThreatMemory(a, player.id);
      if (a.targetId === player.id) a.targetId = this.targetBefore[id]!;
      a.lastSeenX = this.lastSeenXBefore[id]!; a.lastSeenZ = this.lastSeenZBefore[id]!; a.lastSeenT = this.lastSeenTBefore[id]!;
      a.intendX = this.intendXBefore[id]!; a.intendZ = this.intendZBefore[id]!; a.intendSpeed = this.intendSpeedBefore[id]!;
      a.yaw = this.yawBefore[id]!; a.ai = this.aiBefore[id]!;
      a.strikeT = this.strikeTBefore[id]!; a.strikeCd = this.strikeCdBefore[id]!; a.attackCd = this.attackCdBefore[id]!;
    }
  }

  private mediateAllyShouts(w: World) {
    for (const a of w.actors) {
      if (!a.alive || a.kind === "player" || a.species !== "human" || a.faction !== "guard" || a.known.includes(w.playerId)) continue;
      let certainty = 0, sx = 0, sz = 0, speakerId = 0;
      for (const s of w.sounds) {
        if (s.kind !== "shout" || w.time - s.t > 0.25 || s.who === a.id) continue;
        const speaker = w.actor(s.who);
        if (!speaker || speaker.faction !== a.faction) continue;
        const d = Math.hypot(s.x - a.x, s.z - a.z);
        const reach = s.mag * 22 * (1 - w.rain * 0.2);
        if (d >= reach || reach <= 1e-5) continue;
        const c = clamp(1 - d / reach, 0.2, 1);
        if (c <= certainty) continue;
        certainty = c; sx = s.x; sz = s.z; speakerId = s.who;
      }
      if (!certainty) continue;
      w.addMemory(a, "ally", sx, sz, speakerId, certainty);
      a.alert = Math.max(a.alert, 0.48 + certainty * 0.28);
      if (a.ai === "extinguish" || a.ai === "rescue" || a.ai === "flee") continue;
      const dx = sx - a.x, dz = sz - a.z, d = Math.hypot(dx, dz);
      a.ai = "investigate";
      if (d > 0.4) { a.intendX = dx / d; a.intendZ = dz / d; a.intendSpeed = Math.max(a.intendSpeed, 2.4 + certainty * 1.2); }
      else a.intendSpeed = 0;
    }
  }

  private rewritePanicFromItsSource(w: World) {
    for (const a of w.actors) {
      if (!a.alive || a.kind === "player" || a.species !== "human" || a.faction === "guard" || a.ai !== "flee") continue;
      if (!this.findPanicSource(w, a)) continue;
      const dx = a.x - this.sourceX, dz = a.z - this.sourceZ, d = Math.hypot(dx, dz);
      if (d > 1e-5) { a.intendX = dx / d; a.intendZ = dz / d; }
    }
  }

  private findPanicSource(w: World, a: Actor) {
    if (a.lastHitBy && w.time - a.lastHitT < 8) {
      const attacker = w.actor(a.lastHitBy);
      if (attacker) { this.sourceX = attacker.x; this.sourceZ = attacker.z; return true; }
    }
    let best = 0;
    for (const m of a.memories) {
      const age = Math.max(0, w.time - m.t); if (age > 12) continue;
      const weight = m.kind === "threat" ? 3 : m.kind === "fire" ? 2.5 : m.kind === "body" ? 1.3 : 0;
      const score = weight ? (m.certainty * weight) / (1 + age * 0.18) : 0;
      if (score > best) { best = score; this.sourceX = m.x; this.sourceZ = m.z; }
    }
    if (best) return true;
    for (const s of w.sounds) {
      if (w.time - s.t > 0.25 || (s.kind !== "scream" && s.kind !== "collapse" && s.kind !== "weapon")) continue;
      const d = Math.hypot(s.x - a.x, s.z - a.z), reach = s.mag * 22 * (1 - w.rain * 0.2);
      const score = d < reach ? 1 - d / Math.max(reach, 1e-5) : 0;
      if (score > best) { best = score; this.sourceX = s.x; this.sourceZ = s.z; }
    }
    if (best) return true;
    if (a.known.includes(w.playerId) && w.time - a.lastSeenT < 8) { this.sourceX = a.lastSeenX; this.sourceZ = a.lastSeenZ; return true; }
    return false;
  }

  private canSeePlayer(w: World, a: Actor, p: Actor) {
    const dx = p.x - a.x, dz = p.z - a.z, d2 = dx * dx + dz * dz;
    if (d2 > 256) return false;
    const d = Math.sqrt(d2);
    if (d > 2.2) {
      const dot = (dx * -Math.sin(a.yaw) + dz * -Math.cos(a.yaw)) / Math.max(d, 1e-5);
      if (dot < 0.24) return false;
    }
    if (d > 3 && !canSeeThrough(w, a.x, a.z, p.x, p.z)) return false;
    const smoke = w.smoke[w.cell(p.x, p.z)]! + w.smoke[w.cell((a.x + p.x) * 0.5, (a.z + p.z) * 0.5)]!;
    return smoke < 1.35;
  }

  private heardFriendlyShout(w: World, a: Actor) {
    for (const s of w.sounds) {
      if (s.kind !== "shout" || w.time - s.t > 0.25 || s.who === a.id) continue;
      const speaker = w.actor(s.who); if (!speaker || speaker.faction !== a.faction) continue;
      if (Math.hypot(s.x - a.x, s.z - a.z) < s.mag * 22 * (1 - w.rain * 0.2)) return true;
    }
    return false;
  }

  private removeKnown(a: Actor, actorId: number) {
    let w = 0; for (let r = 0; r < a.known.length; r++) if (a.known[r] !== actorId) a.known[w++] = a.known[r]!; a.known.length = w;
  }

  private removeFreshThreatMemory(a: Actor, actorId: number) {
    let w = 0; for (let r = 0; r < a.memories.length; r++) { const m = a.memories[r]!; if (m.kind === "threat" && m.who === actorId && m.t >= this.beginTime) continue; a.memories[w++] = m; } a.memories.length = w;
  }

  private restoreRadioHolds(w: World) {
    for (const a of w.actors) if (a.id >= 0 && a.id < ENTITY_ID_CAP && this.radioHeld[a.id]) { if (a.shoutCd <= RADIO_HOLD) a.shoutCd = 0; this.radioHeld[a.id] = 0; }
  }
}
