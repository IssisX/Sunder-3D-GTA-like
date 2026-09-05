import type { WeaponKind } from "./types";

const KEY = "sunder.save.v1";
const VERSION = 1;

export interface SaveBlob {
  version: number;
  time: number;
  rain: number;
  windX: number;
  windZ: number;
  day: number;
  player: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    blood: number;
    /**
     * Not derivable from blood alone: a head-trauma or smoke faint can happen
     * at any blood level, and blood alone can't tell the two apart. Missing
     * this let a reload reset consciousness to a fresh actor's default of 1
     * while blood stayed at its saved, possibly critical value -- so the very
     * first tick's clamp (consciousness capped at 2x blood below 0.25) could
     * cliff consciousness straight back down, below the down threshold, from
     * a state that on its own would never have produced that cliff.
     */
    consciousness: number;
    stamina: number;
    weapon: WeaponKind;
    torchLit: boolean;
  };
  burned: number[];
  collapsed: number[];
  dead: number[];
  wanted: number;
}

export function loadSave(): SaveBlob | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveBlob;
    if (!data || data.version !== VERSION || !data.player) return null;
    // A save written before `consciousness` was tracked has no such field:
    // JSON.parse leaves it `undefined`, which would set the restored actor's
    // consciousness to `undefined` rather than a number, corrupting every
    // formula that reads it (NaN propagates from there, silently, since a
    // comparison against NaN is neither true nor false). Blood is the one
    // piece of information an old save actually has, so reconstruct it with
    // the same relationship the live sim already clamps consciousness to
    // (capped at 2x blood once blood drops under 0.25) rather than guessing:
    // that is the one derivation that cannot produce a state the sim itself
    // would not.
    if (!Number.isFinite(data.player.consciousness)) {
      const blood = Number.isFinite(data.player.blood) ? data.player.blood : 1;
      data.player.consciousness = blood < 0.25 ? Math.max(0, Math.min(1, blood * 2)) : 1;
    }
    return data;
  } catch {
    return null;
  }
}

export function writeSave(data: SaveBlob) {
  try {
    const blob: SaveBlob = { ...data, version: VERSION };
    localStorage.setItem(KEY, JSON.stringify(blob));
    localStorage.setItem(KEY + ".bak", JSON.stringify(blob));
  } catch {
    /* quota / private mode */
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
