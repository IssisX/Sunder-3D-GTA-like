import type { Actor } from "./types";
import type { World } from "./world";

const ENTITY_ID_CAP = 8192;

export const EDGES = {
  preserveRecoveryState: true,
};

function human(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

function bodyOwnsRoot(a: Actor) {
  return (
    human(a) &&
    a.loco !== "swim" &&
    a.loco !== "climb" &&
    a.loco !== "vault"
  );
}

function supersedesRecovery(a: Actor) {
  return (
    a.loco === "ragdoll" ||
    a.loco === "down" ||
    a.loco === "getup" ||
    a.loco === "swim" ||
    a.loco === "climb" ||
    a.loco === "vault"
  );
}

/**
 * Compatibility firewall between legacy Actor transport/classification and the
 * articulated body authority.
 *
 * A body-earned stumble is preserved across stepWorld's speed-based locomotion
 * relabel so recovery footwork can actually run. Genuine higher-order states
 * still supersede stumble immediately. Translation/facing ownership remains the
 * same as before.
 */
export class HumanRootAuthority {
  private readonly x = new Float32Array(ENTITY_ID_CAP);
  private readonly y = new Float32Array(ENTITY_ID_CAP);
  private readonly z = new Float32Array(ENTITY_ID_CAP);
  private readonly yaw = new Float64Array(ENTITY_ID_CAP);
  private readonly stumble = new Uint8Array(ENTITY_ID_CAP);
  private readonly valid = new Uint8Array(ENTITY_ID_CAP);

  capture(w: World) {
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a) || a.id < 0 || a.id >= ENTITY_ID_CAP) continue;
      this.x[a.id] = a.x;
      this.y[a.id] = a.y;
      this.z[a.id] = a.z;
      this.yaw[a.id] = a.yaw;
      this.stumble[a.id] = a.loco === "stumble" ? 1 : 0;
      this.valid[a.id] = 1;
    }
  }

  restoreBodyOwnedRoots(w: World) {
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (
        !human(a) ||
        a.id < 0 ||
        a.id >= ENTITY_ID_CAP ||
        this.valid[a.id] === 0
      ) {
        continue;
      }

      if (
        EDGES.preserveRecoveryState &&
        this.stumble[a.id] !== 0 &&
        !supersedesRecovery(a)
      ) {
        a.loco = "stumble";
      }

      if (!bodyOwnsRoot(a)) continue;
      a.x = this.x[a.id]!;
      a.y = this.y[a.id]!;
      a.z = this.z[a.id]!;

      if (a.kind === "player" && a.intendSpeed < 0.1) {
        a.yaw = this.yaw[a.id]!;
      }
    }
  }

  reset(a: Actor) {
    if (!human(a) || a.id < 0 || a.id >= ENTITY_ID_CAP) return;
    this.x[a.id] = a.x;
    this.y[a.id] = a.y;
    this.z[a.id] = a.z;
    this.yaw[a.id] = a.yaw;
    this.stumble[a.id] = a.loco === "stumble" ? 1 : 0;
    this.valid[a.id] = 1;
  }

  clear() {
    this.stumble.fill(0);
    this.valid.fill(0);
  }
}
