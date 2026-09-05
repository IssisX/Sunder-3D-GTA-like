import type { Actor } from "./types";
import type { World } from "./world";
import { canSeeThrough, clamp } from "./world";

const ENTITY_ID_CAP = 8192;
const RADIO_HOLD = 0.08;

export const EDGES = {
  localEvidence: true,
};

function human(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

/**
 * Keeps public notoriety separate from personal evidence and prevents one local
 * incident from becoming an instant town-wide target broadcast.
 *
 * The world already owns sight, sound, memories, fear, and personal known[]
 * state. This controller only enforces that those channels remain authoritative:
 * unseen allies may investigate a shout, but they do not magically acquire the
 * shouted target; panic keeps the source that actually caused it.
 */
export class SocialAwarenessController {
  private realWanted = 0;
  private proxyWanted = 0;
  private active = false;
  private beginTime = 0;

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
    const playerId = w.playerId;
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (a.id < 0 || a.id >= ENTITY_ID_CAP) continue;
      const id = a.id;
      const knowsPlayer = a.known.includes(playerId);
      this.knownPlayerBefore[id] = knowsPlayer ? 1 : 0;
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

      // A guard who did not know the player at frame start may learn something
      // this tick, but must not rebroadcast it before endStep has checked how.
      if (a.faction === "guard" && !knowsPlayer && a.shoutCd <= 0) {
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
    this.active = false;
  }

  reset() {
    this.realWanted = 0;
    this.proxyWanted = 0;
    this.active = false;
    this.beginTime = 0;
    this.knownPlayerBefore.fill(0);
    this.radioHeld.fill(0);
  }

  private localizePlayerKnowledge(w: World) {
    const player = w.player();
    if (!player) return;

    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a) || a.kind === "player" || a.id < 0 || a.id >= ENTITY_ID_CAP) continue;
      const id = a.id;
      if (this.knownPlayerBefore[id] !== 0 || !a.known.includes(player.id)) continue;

      const directVictim =
        a.lastHitBy === player.id &&
        w.time - a.lastHitT < 2;
      const reportedWitness =
        a.faction === "guard" &&
        this.canSeePlayer(w, a, player) &&
        this.heardFriendlyShout(w, a);

      if (directVictim || reportedWitness) continue;

      this.removeKnown(a, player.id);
      this.removeFreshThreatMemory(a, player.id);
      if (a.targetId === player.id) a.targetId = this.targetBefore[id]!;
      a.lastSeenX = this.lastSeenXBefore[id]!;
      a.lastSeenZ = this.lastSeenZBefore[id]!;
      a.lastSeenT = this.lastSeenTBefore[id]!;
      a.intendX = this.intendXBefore[id]!;
      a.intendZ = this.intendZBefore[id]!;
      a.intendSpeed = this.intendSpeedBefore[id]!;
      a.yaw = this.yawBefore[id]!;
      a.ai = this.aiBefore[id]!;
      a.strikeT = this.strikeTBefore[id]!;
      a.strikeCd = this.strikeCdBefore[id]!;
      a.attackCd = this.attackCdBefore[id]!;
    }
  }

  private mediateAllyShouts(w: World) {
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!a.alive || a.kind === "player" || a.species !== "human" || a.faction !== "guard") continue;
      if (a.known.includes(w.playerId)) continue;

      let bestCertainty = 0;
      let sx = 0;
      let sz = 0;
      let speakerId = 0;
      for (let j = 0; j < w.sounds.length; j++) {
        const s = w.sounds[j]!;
        if (s.kind !== "shout" || w.time - s.t > 0.25 || s.who === a.id) continue;
        const speaker = w.actor(s.who);
        if (!speaker || speaker.faction !== a.faction) continue;
        const d = Math.hypot(s.x - a.x, s.z - a.z);
        const reach = s.mag * 22 * (1 - w.rain * 0.2);
        if (d >= reach || reach <= 1e-5) continue;
        const certainty = clamp(1 - d / reach, 0.2, 1);
        if (certainty <= bestCertainty) continue;
        bestCertainty = certainty;
        sx = s.x;
        sz = s.z;
        speakerId = s.who;
      }
      if (bestCertainty <= 0) continue;

      w.addMemory(a, "ally", sx, sz, speakerId, bestCertainty);
      a.alert = Math.max(a.alert, 0.48 + bestCertainty * 0.28);
      if (a.ai === "extinguish" || a.ai === "rescue" || a.ai === "flee") continue;

      const dx = sx - a.x;
      const dz = sz - a.z;
      const d = Math.hypot(dx, dz);
      a.ai = "investigate";
      if (d > 0.4) {
        a.intendX = dx / d;
        a.intendZ = dz / d;
        a.intendSpeed = Math.max(a.intendSpeed, 2.4 + bestCertainty * 1.2);
      } else {
        a.intendSpeed = 0;
      }
    }
  }

  private rewritePanicFromItsSource(w: World) {
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!a.alive || a.kind === "player" || a.species !== "human" || a.faction === "guard" || a.ai !== "flee") continue;
      if (!this.findPanicSource(w, a)) continue;
      const dx = a.x - this.sourceX;
      const dz = a.z - this.sourceZ;
      const d = Math.hypot(dx, dz);
      if (d <= 1e-5) continue;
      a.intendX = dx / d;
      a.intendZ = dz / d;
    }
  }

  private sourceX = 0;
  private sourceZ = 0;

  private findPanicSource(w: World, a: Actor) {
    if (a.lastHitBy && w.time - a.lastHitT < 8) {
      const attacker = w.actor(a.lastHitBy);
      if (attacker) {
        this.sourceX = attacker.x;
        this.sourceZ = attacker.z;
        return true;
      }
    }

    let best = 0;
    for (let i = 0; i < a.memories.length; i++) {
      const m = a.memories[i]!;
      const age = Math.max(0, w.time - m.t);
      if (age > 12) continue;
      let weight = 0;
      if (m.kind === "threat") weight = 3;
      else if (m.kind === "fire") weight = 2.5;
      else if (m.kind === "body") weight = 1.3;
      if (weight <= 0) continue;
      const score = (m.certainty * weight) / (1 + age * 0.18);
      if (score <= best) continue;
      best = score;
      this.sourceX = m.x;
      this.sourceZ = m.z;
    }
    if (best > 0) return true;

    for (let i = 0; i < w.sounds.length; i++) {
      const s = w.sounds[i]!;
      if (w.time - s.t > 0.25) continue;
      if (s.kind !== "scream" && s.kind !== "collapse" && s.kind !== "weapon") continue;
      const d = Math.hypot(s.x - a.x, s.z - a.z);
      const reach = s.mag * 22 * (1 - w.rain * 0.2);
      if (d >= reach) continue;
      const score = 1 - d / Math.max(reach, 1e-5);
      if (score <= best) continue;
      best = score;
      this.sourceX = s.x;
      this.sourceZ = s.z;
    }
    if (best > 0) return true;

    if (a.known.includes(w.playerId) && w.time - a.lastSeenT < 8) {
      this.sourceX = a.lastSeenX;
      this.sourceZ = a.lastSeenZ;
      return true;
    }
    return false;
  }

  private canSeePlayer(w: World, a: Actor, player: Actor) {
    const dx = player.x - a.x;
    const dz = player.z - a.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 16 * 16) return false;
    const d = Math.sqrt(d2);
    if (d > 2.2) {
      const fx = -Math.sin(a.yaw);
      const fz = -Math.cos(a.yaw);
      const dot = d > 1e-5 ? (dx * fx + dz * fz) / d : 1;
      if (dot < 0.24) return false;
    }
    if (d > 3 && !canSeeThrough(w, a.x, a.z, player.x, player.z)) return false;
    const smoke =
      w.smoke[w.cell(player.x, player.z)]! +
      w.smoke[w.cell((a.x + player.x) * 0.5, (a.z + player.z) * 0.5)]!;
    return smoke < 1.35;
  }

  private heardFriendlyShout(w: World, a: Actor) {
    for (let i = 0; i < w.sounds.length; i++) {
      const s = w.sounds[i]!;
      if (s.kind !== "shout" || w.time - s.t > 0.25 || s.who === a.id) continue;
      const speaker = w.actor(s.who);
      if (!speaker || speaker.faction !== a.faction) continue;
      const reach = s.mag * 22 * (1 - w.rain * 0.2);
      if (Math.hypot(s.x - a.x, s.z - a.z) < reach) return true;
    }
    return false;
  }

  private removeKnown(a: Actor, actorId: number) {
    let write = 0;
    for (let read = 0; read < a.known.length; read++) {
      const id = a.known[read]!;
      if (id === actorId) continue;
      a.known[write++] = id;
    }
    a.known.length = write;
  }

  private removeFreshThreatMemory(a: Actor, actorId: number) {
    let write = 0;
    for (let read = 0; read < a.memories.length; read++) {
      const m = a.memories[read]!;
      if (m.kind === "threat" && m.who === actorId && m.t >= this.beginTime) continue;
      a.memories[write++] = m;
    }
    a.memories.length = write;
  }

  private restoreRadioHolds(w: World) {
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (a.id < 0 || a.id >= ENTITY_ID_CAP || this.radioHeld[a.id] === 0) continue;
      if (a.shoutCd <= RADIO_HOLD) a.shoutCd = 0;
      this.radioHeld[a.id] = 0;
    }
  }
}
