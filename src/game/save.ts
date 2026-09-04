import type { WeaponKind } from "./types";

// v2 intentionally invalidates v1 positions produced while human root authority
// was in transition. Those builds could autosave a mechanically corrupted
// player location even though the world itself was intact.
const KEY = "sunder.save.v2";
const VERSION = 2;

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
 * This remains a lightweight world-continuity snapshot, not a complete
 * physiology serialization. Injuries, bleed, pain, breath, consciousness,
 * fatigue, balance, and locomotion state are intentionally absent.
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
    if (
      !Number.isFinite(data.player.x) ||
      !Number.isFinite(data.player.y) ||
      !Number.isFinite(data.player.z) ||
      !Number.isFinite(data.player.yaw)
    ) {
      return null;
    }
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
    // Clean the retired epoch as well so Start over is genuinely fresh.
    localStorage.removeItem("sunder.save.v1");
    localStorage.removeItem("sunder.save.v1.bak");
  } catch {
    /* ignore */
  }
}
