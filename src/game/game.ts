import type { HudState } from "./types";
import { Game as CoreGame } from "./game-core";
import { GameAudio } from "./audio";
import { FIRE_CELL, FIRE_RES } from "./types";

/** Presentation hooks only. The original simulation and controls are unchanged. */
export class Game extends CoreGame {
  declare audio: GameAudio;
  private readonly coreFrame: (now: number) => void;
  constructor(canvas: HTMLCanvasElement, onHud: (h: HudState) => void) {
    super(canvas, onHud);
    // The inspected core owns `frame` as a TypeScript-private arrow field.
    // This narrowly wraps that existing runtime field, not a second game loop.
    this.coreFrame = this["frame"];
    this["frame"] = (now: number) => {
      this.coreFrame(now);
      this.syncSoundscape();
    };
  }
  private syncSoundscape() {
    const w = this.world;
    const p = w.player();
    const cell = w.cell(p.x, p.z);
    const cx = cell % FIRE_RES, cz = (cell / FIRE_RES) | 0;
    let fire = 0;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= FIRE_RES || z >= FIRE_RES) continue;
      const distance = Math.hypot(dx, dz) * FIRE_CELL;
      fire += Math.max(0, w.heat[x + z * FIRE_RES]!) / (1 + distance * distance * 0.13);
    }
    this.audio.setBeds(w.rain, fire, w.wanted, w.day, Math.hypot(w.windX, w.windZ));
  }
  override dispose() {
    super.dispose();
    this.audio.dispose();
  }
}
