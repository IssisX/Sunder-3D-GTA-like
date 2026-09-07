import type { Actor } from "./types";
import type { World } from "./world";
import { STEP } from "./types";
import type { PhysicalBodies } from "./body";
import { MeleeKinematics as CoreMelee } from "./melee-kinematics-core";
import { CombatLoadTransfer } from "./combat-load-transfer";

/** Preserves the proven carrier/contact implementation and adds load transfer. */
export class MeleeKinematics extends CoreMelee {
  private readonly loadTransfer: CombatLoadTransfer;
  constructor(bodies: PhysicalBodies) {
    super(bodies);
    this.loadTransfer = new CombatLoadTransfer(bodies, (id) => this.isActive(id));
  }
  override bootstrap(w: World) {
    super.bootstrap(w);
    this.loadTransfer.clear();
  }
  override clear() {
    super.clear();
    this.loadTransfer.clear();
  }
  override reset(a: Actor) {
    super.reset(a);
    this.loadTransfer.reset(a.id);
  }
  override finishCoupledTasks(w: World) {
    super.finishCoupledTasks(w);
    this.loadTransfer.prepare(w, STEP);
  }
}
