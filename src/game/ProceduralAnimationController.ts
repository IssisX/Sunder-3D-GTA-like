import type { Actions } from "./input";
import type { Actor } from "./types";
import type { World } from "./world";
import { AnimationController } from "./AnimationController";
import { MeleeKinematics } from "./melee-kinematics";
import { SocialAwarenessController } from "./social-awareness";

/**
 * Canonical runtime animation orchestrator.
 *
 * AnimationController owns phase-matched locomotion/root motion.
 * MeleeKinematics owns contact-authoritative kinetic-chain Punch/Kick and
 * weapon melee. AnimatedPhysicalBodies underneath still owns Grab while
 * INTERACTION remains the next migration slice. Every system projects into
 * the same authoritative BodyRig.
 */
export class ProceduralAnimationController extends AnimationController {
  private readonly melee = new MeleeKinematics(this);
  private readonly social = new SocialAwarenessController();

  override bootstrap(w: World) {
    super.bootstrap(w);
    this.melee.bootstrap(w);
    this.social.reset();
  }

  override clear() {
    super.clear();
    this.melee.clear();
    this.social.reset();
  }

  override reset(a: Actor) {
    super.reset(a);
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
    super.step(w, dt);
    this.melee.step(w, dt);
  }
}
