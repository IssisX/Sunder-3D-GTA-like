import type { Actions } from "./input";
import type { Actor } from "./types";
import type { World } from "./world";
import { AnimationController } from "./AnimationController";
import { MeleeKinematics } from "./melee-kinematics";
import { SocialAwarenessController } from "./social-awareness";
import { impactDynamics } from "./impact-dynamics";
import { BodyCausality } from "./body-causality";
import { activeBodyControl } from "./active-body-control";
import { bodyMode } from "./body-model";
import { supportMotion } from "./support-motion";
import { WholeBodyCoupling } from "./whole-body-coupling";

/**
 * Canonical runtime body/action orchestrator.
 *
 * Fixed-step ownership:
 *   pre-world: input/action selection + locomotion intent shaping
 *   world sim: AI/world compatibility prediction
 *   post-world/pre-body: locomotion + melee end-effector task generation
 *   whole-body coupling: support / COM / stance tasks derived from those actions
 *   pre-integration: bounded joint actuation + friction-limited support reaction
 *   body solve: integration -> posture control -> joint constraints -> contacts
 *   post-solve: real effector contact -> impulse -> stability outcome
 */
export class ProceduralAnimationController extends AnimationController {
  private readonly melee = new MeleeKinematics(this);
  private readonly social = new SocialAwarenessController();
  private readonly causality = new BodyCausality(this);
  private readonly coupling = new WholeBodyCoupling(this);

  override bootstrap(w: World) {
    super.bootstrap(w);
    impactDynamics.bind(this);
    impactDynamics.bootstrap(w);
    this.melee.bootstrap(w);
    this.coupling.bootstrap(w);
    this.social.reset();
  }

  override clear() {
    super.clear();
    impactDynamics.clear();
    this.melee.clear();
    this.coupling.clear();
    this.social.reset();
  }

  override reset(a: Actor) {
    super.reset(a);
    impactDynamics.reset(a);
    this.melee.reset(a);
    this.coupling.reset(a);
  }

  override captureInput(input: Actions) {
    this.melee.captureInput(input);
    super.captureInput(input);
  }

  override prepareInput(w: World, input: Actions, dt: number) {
    super.prepareInput(w, input, dt);
    this.melee.prepareInput(w, input);
  }

  override prepareStep(w: World, dt: number) {
    this.social.beginStep(w);
    // Only intent shaping belongs before stepWorld. Absolute body task geometry
    // is generated after the compatibility world step from the current state.
    super.prepareStep(w, dt);
  }

  override step(w: World, dt: number) {
    this.social.endStep(w);

    // Generate locomotion and action tasks against the current predicted world
    // state. These are requests only; no solved body node is moved here.
    super.prepareBodyStep(w, dt);
    this.melee.prepareStep(w, dt);

    // Convert isolated end-effector requests into whole-body stance/support/COM
    // requirements before any motor command is applied.
    this.coupling.prepare(w);

    // Explicit task velocity must be written before Verlet integration. The
    // friction-limited support reaction follows it so internal motor targets do
    // not cancel the external momentum source required for locomotion.
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (a.kind !== "player" && a.species !== "human") continue;
      const rig = this.get(a);
      if (!rig?.initialized) continue;
      const mode = bodyMode(a);
      activeBodyControl.driveTasksPreIntegration(w, a, rig, dt, mode);
      supportMotion.drive(w, a, rig, dt, mode);
    }

    // PhysicalBodies integrates those velocity changes in this same fixed step,
    // then solves anatomical constraints and real world/body contacts.
    super.step(w, dt);

    // Contact is measured from the solved physical fist/foot trajectory only.
    this.melee.step(w, dt);

    // The same impulse field drives visible recoil and coarse root momentum.
    impactDynamics.step(w, dt);

    // Support/COM mechanics decide absorb, corrective recovery, stumble or fall.
    this.causality.step(w, dt);
  }
}
