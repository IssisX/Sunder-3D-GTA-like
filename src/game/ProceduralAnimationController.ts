import type { Actions } from "./input";
import type { Actor } from "./types";
import type { World } from "./world";
import { AnimationController } from "./AnimationController";
import { MeleeKinematics } from "./melee-kinematics";
import { SocialAwarenessController } from "./social-awareness";
import { impactDynamics } from "./impact-dynamics";
import { BodyCausality } from "./body-causality";

/**
 * Canonical runtime body/action orchestrator.
 *
 * The fixed-step causal order is intentional:
 *   base articulated solve / locomotion
 *   -> action geometry and physical contact
 *   -> anatomical/root impulse propagation
 *   -> support/COM stability decision
 *
 * No action system is allowed to independently choose a hit reaction or fall
 * state when the common body substrate can derive it from contact mechanics.
 */
export class ProceduralAnimationController extends AnimationController {
  private readonly melee = new MeleeKinematics(this);
  private readonly social = new SocialAwarenessController();
  private readonly causality = new BodyCausality(this);

  override bootstrap(w: World) {
    super.bootstrap(w);
    impactDynamics.bind(this);
    impactDynamics.bootstrap(w);
    this.melee.bootstrap(w);
    this.social.reset();
  }

  override clear() {
    super.clear();
    impactDynamics.clear();
    this.melee.clear();
    this.social.reset();
  }

  override reset(a: Actor) {
    super.reset(a);
    impactDynamics.reset(a);
    this.melee.reset(a);
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
    super.prepareStep(w, dt);
    this.melee.prepareStep(w, dt);
  }

  override step(w: World, dt: number) {
    this.social.endStep(w);

    // Establish the current articulated body and locomotion state first.
    super.step(w, dt);

    // The action solver moves the real effectors and detects contact from their
    // swept geometry. Contact writes injury plus one shared impulse field.
    this.melee.step(w, dt);

    // The same field now drives both visible anatomical recoil and coarse root
    // momentum. No separate melee knockback path exists.
    impactDynamics.step(w, dt);

    // Finally derive absorb/recoil/stumble/collapse from actual support geometry,
    // COM projection, posture, injury and the impulse that just occurred.
    this.causality.step(w, dt);
  }
}
