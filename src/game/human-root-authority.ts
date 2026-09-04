import type { Actor } from "./types";
import type { World } from "./world";

const ENTITY_ID_CAP = 8192;

function human(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

/**
 * Returns true when the articulated body, not the legacy Actor capsule, owns
 * translational authority for the humanoid this step.
 *
 * Swim/climb/vault remain on the old transport path until they receive their
 * own complete physical vertical slices. Everything else - standing, walking,
 * combat, stumble, ragdoll, down and get-up - is projected from the solved body.
 */
function bodyOwnsRoot(a: Actor) {
  return (
    human(a) &&
    a.loco !== "swim" &&
    a.loco !== "climb" &&
    a.loco !== "vault"
  );
}

/**
 * Compatibility firewall between the old Actor capsule transport and the new
 * articulated body authority.
 *
 * stepWorld still runs for AI, world interaction, legacy special movement and
 * broad compatibility. For body-owned humanoids its temporary capsule
 * translation is discarded before task generation. The body then advances from
 * support reaction + active control + contacts and derives Actor root afterward.
 *
 * This is intentionally zero-GC in the fixed-step hot path.
 */
export class HumanRootAuthority {
  private readonly x = new Float32Array(ENTITY_ID_CAP);
  private readonly y = new Float32Array(ENTITY_ID_CAP);
  private readonly z = new Float32Array(ENTITY_ID_CAP);
  private readonly valid = new Uint8Array(ENTITY_ID_CAP);

  capture(w: World) {
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a) || a.id < 0 || a.id >= ENTITY_ID_CAP) continue;
      this.x[a.id] = a.x;
      this.y[a.id] = a.y;
      this.z[a.id] = a.z;
      this.valid[a.id] = 1;
    }
  }

  restoreBodyOwnedRoots(w: World) {
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (
        !bodyOwnsRoot(a) ||
        a.id < 0 ||
        a.id >= ENTITY_ID_CAP ||
        this.valid[a.id] === 0
      ) {
        continue;
      }
      a.x = this.x[a.id]!;
      a.y = this.y[a.id]!;
      a.z = this.z[a.id]!;
    }
  }

  reset(a: Actor) {
    if (!human(a) || a.id < 0 || a.id >= ENTITY_ID_CAP) return;
    this.x[a.id] = a.x;
    this.y[a.id] = a.y;
    this.z[a.id] = a.z;
    this.valid[a.id] = 1;
  }

  clear() {
    this.valid.fill(0);
  }
}
