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
 * Fixed-step ownership:
 *   pre-world: input/action selection + locomotion intent shaping
 *   world sim: AI/world/root compatibility movement
 *   post-world/pre-body: locomotion + melee whole-body task generation
 *   body solve: active motors -> joint constraints -> contacts
 *   post-solve: real effector contact -> impulse -> stability outcome
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
    // Only intent shaping belongs before stepWorld. Absolute task geometry is
    // deliberately deferred until step(), which runs after World simulation.
    super.prepareStep(w, dt);
  }

  override step(w: World, dt: number) {
    this.social.endStep(w);

    // Generate all task-space geometry from the current post-world root and the
    // previous solved physical rig immediately before active motor control.
    super.prepareBodyStep(w, dt);
    this.melee.prepareStep(w, dt);

    // ActiveBodyControl consumes the merged locomotion/action targets here.
    super.step(w, dt);

    // Contact is measured from the solved physical fist/foot trajectory only.
    this.melee.step(w, dt);

    // The same impulse field drives visible recoil and coarse root momentum.
    impactDynamics.step(w, dt);

    // Support/COM mechanics decide absorb, corrective recovery, stumble or fall.
    this.causality.step(w, dt);
  }
}
