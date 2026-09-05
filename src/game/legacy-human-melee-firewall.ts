import type { Actor } from "./types";
import type { World } from "./world";

const ENTITY_ID_CAP = 8192;

/** Severable causal edge for the one targeted spatial-carrier falsifier. */
export const EDGES = {
  suppressLegacyHumanoidMelee: true,
};

function humanoid(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

/**
 * Prevents the legacy timer/range-cone combat path from becoming an authority
 * for humanoid melee. The compatibility simulation may still run, but Punch,
 * Kick and weapon consequences must come from MeleeKinematics swept carriers.
 */
class LegacyHumanMeleeFirewall {
  private readonly savedAttackCd = new Float32Array(ENTITY_ID_CAP);
  private readonly saved = new Uint8Array(ENTITY_ID_CAP);

  beforeWorld(w: World, dt: number) {
    if (!EDGES.suppressLegacyHumanoidMelee) return;
    for (const a of w.actors) {
      if (!humanoid(a)) continue;
      a.strikeT = 0;
      a.kickT = 0;
      a.shoveT = 0;
      a.strikeHit = 0;

      // Legacy human AI arms strikeT when attackCd <= 0 inside stepWorld.
      // Hold that gate closed for this compatibility step, then restore the
      // cooldown as though its ordinary fixed-step decay had occurred.
      if (a.kind === "player" || a.id < 0 || a.id >= ENTITY_ID_CAP) continue;
      this.savedAttackCd[a.id] = a.attackCd;
      this.saved[a.id] = 1;
      a.attackCd = Math.max(a.attackCd, dt * 2);
    }
  }

  afterWorld(w: World, dt: number) {
    if (!EDGES.suppressLegacyHumanoidMelee) return;
    for (const a of w.actors) {
      if (!humanoid(a)) continue;
      a.strikeT = 0;
      a.kickT = 0;
      a.shoveT = 0;
      a.strikeHit = 0;
      if (a.kind === "player" || a.id < 0 || a.id >= ENTITY_ID_CAP || !this.saved[a.id]) continue;
      a.attackCd = Math.max(0, this.savedAttackCd[a.id]! - dt);
      this.saved[a.id] = 0;
    }
  }

  clear() {
    this.saved.fill(0);
    this.savedAttackCd.fill(0);
  }
}

export const legacyHumanMeleeFirewall = new LegacyHumanMeleeFirewall();
