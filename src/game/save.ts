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
    stamina: number;
    weapon: WeaponKind;
    torchLit: boolean;
  };
  burned: number[];
  collapsed: number[];
  dead: number[];
  wanted: number;
}

/**
 * Save v1 is a lightweight world-continuity snapshot, not a complete
 * physiology serialization. Injuries, bleed, pain, breath, consciousness,
 * fatigue, balance, and locomotion state are intentionally absent. Restoring
 * blood/stamina in isolation can therefore create impossible states (for
 * example low blood immediately forcing consciousness below the down
 * threshold while the injuries that caused it no longer exist).
 *
 * Normalize transient physiology to the fresh-body baseline whenever v1 is
 * loaded or written. Position, equipment, weather, notoriety and persistent
 * world damage remain continuous. A future full-state save version can own
 * physiology atomically instead of partially.
 */
function normalizeTransientPhysiology(data: SaveBlob) {
  data.player.blood = 1;
  data.player.stamina = 1;
  return data;
}

export function loadSave(): SaveBlob | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveBlob;
    if (!data || data.version !== VERSION) return null;
    return normalizeTransientPhysiology(data);
  } catch {
    return null;
  }
}

export function writeSave(data: SaveBlob) {
  try {
    const blob: SaveBlob = normalizeTransientPhysiology({
      ...data,
      player: { ...data.player },
      version: VERSION,
    });
    localStorage.setItem(KEY, JSON.stringify(blob));
    localStorage.setItem(KEY + ".bak", JSON.stringify(blob));
  } catch {
    /* quota / private mode */
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(KEY + ".bak");
  } catch {
    /* ignore */
  }
}
