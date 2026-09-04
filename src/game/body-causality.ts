import type { Actor } from "./types";
import type { World } from "./world";
import { clamp } from "./world";
import type { BodyRig } from "./body-model";
import {
  makeMechanicalState,
  sampleMechanicalState,
  type MechanicalState,
} from "./mechanical-state";

interface BodyAccess {
  get(a: Actor): BodyRig | undefined;
}

const MIN_DT = 1 / 240;
const MAX_DT = 1 / 30;

function human(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

/**
 * Converts measured articulated state into the semantic locomotion labels the
 * rest of SUNDER already understands. Labels describe physical outcomes; they
 * do not manufacture them.
 */
export class BodyCausality {
  private readonly state: MechanicalState = makeMechanicalState();

  constructor(private readonly bodies: BodyAccess) {}

  step(w: World, dt: number) {
    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;

    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a) || !a.alive) continue;
      const rig = this.bodies.get(a);
      if (!rig?.initialized) continue;
      if (a.loco === "down" || a.loco === "getup" || a.loco === "ragdoll") continue;

      sampleMechanicalState(w, a, rig, h, this.state);

      // Capacity is measured from actual support/contact quality, current body
      // posture, leg integrity and consciousness. Wet/oily support is already
      // reflected in supportScore through the shared estimator.
      const capacity =
        (0.18 + this.state.supportScore * 0.82) *
        (0.48 + this.state.legIntegrity * 0.52) *
        (0.42 + this.state.consciousness * 0.58) *
        (0.5 + this.state.upright * 0.5);

      const angularDemand = Math.min(
        0.62,
        Math.hypot(
          this.state.angularX,
          this.state.angularY,
          this.state.angularZ,
        ) / Math.max(1, a.mass * 0.75),
      );
      const momentumDemand = Math.min(
        0.45,
        Math.hypot(this.state.momentumX, this.state.momentumZ) /
          Math.max(1, a.mass * 5.5),
      );
      const demand =
        this.state.disturbance * (0.68 + (1 - this.state.upright) * 0.42) +
        angularDemand * 0.44 +
        momentumDemand * (this.state.supportCount === 1 ? 0.34 : 0.18);
      const stability = capacity - demand;

      // Balance is now a slow game-level summary of measured support capacity,
      // not an independent fall switch. It recovers when the body is genuinely
      // supported and degrades when measured demand exceeds available control.
      const recovery =
        this.state.supportScore *
        this.state.legIntegrity *
        this.state.consciousness *
        h *
        1.08;
      const loss = Math.max(0, demand - capacity * 0.32) * h * 3.35;
      a.balance = clamp(a.balance + recovery - loss, 0, 1);

      const catastrophic =
        this.state.disturbance > 1.12 &&
        (stability < -0.3 ||
          this.state.supportCount === 0 ||
          this.state.consciousness < 0.22);
      const unstable =
        (this.state.disturbance > 0.16 || angularDemand > 0.16) &&
        (stability < 0.27 ||
          this.state.supportScore < 0.2 ||
          a.balance < 0.2);

      if (catastrophic) {
        a.loco = "ragdoll";
        a.locoT = Math.max(
          a.locoT,
          0.62 + Math.min(0.65, this.state.disturbance * 0.22),
        );
        a.balance = Math.min(a.balance, 0.08);
      } else if (unstable && a.loco !== "stumble") {
        a.loco = "stumble";
        a.locoT = Math.max(
          a.locoT,
          0.28 + Math.min(0.38, this.state.disturbance * 0.14),
        );
      } else if (
        a.loco === "stumble" &&
        this.state.disturbance < 0.11 &&
        this.state.supportScore > 0.5 &&
        this.state.upright > 0.6 &&
        a.locoT <= 0
      ) {
        a.loco = "idle";
      }
    }
  }
}
