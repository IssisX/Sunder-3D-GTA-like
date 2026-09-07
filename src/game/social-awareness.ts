import type { World } from "./world";
import { clamp } from "./world";

/**
 * The simulation historically used World.wanted for two different concepts:
 * town-level notoriety and an individual guard's personal knowledge. That made
 * one witnessed impact behave like a global radio broadcast. This adapter keeps
 * the public notoriety scalar intact while presenting only the non-hostile
 * threshold to perception/AI during a fixed step. Agent hostility must then be
 * earned through known[] / memories / explicit local propagation.
 */
export class SocialAwarenessController {
  private realWanted = 0;
  private proxyWanted = 0;
  private active = false;

  beginStep(w: World) {
    if (this.active) return;
    this.active = true;
    this.realWanted = w.wanted;
    this.proxyWanted = Math.min(this.realWanted, 0.15);
    w.wanted = this.proxyWanted;
  }

  endStep(w: World) {
    if (!this.active) return;
    const delta = w.wanted - this.proxyWanted;
    w.wanted = clamp(this.realWanted + delta, 0, 1);
    this.active = false;
  }

  reset() {
    this.realWanted = 0;
    this.proxyWanted = 0;
    this.active = false;
  }
}
