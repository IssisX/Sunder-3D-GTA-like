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

export function loadSave(): SaveBlob | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveBlob;
    if (!data || data.version !== VERSION) return null;
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
