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
import { supportWrench } from "./support-wrench";
import { WholeBodyCoupling } from "./whole-body-coupling";
import { bodyTaskTargets } from "./body-task-targets";
import { HumanRootAuthority } from "./human-root-authority";
import { CentroidalLocomotion } from "./centroidal-locomotion";
import { legacyHumanMeleeFirewall } from "./legacy-human-melee-firewall";

/**
 * Canonical runtime body/action orchestrator.
 *
 * Fixed-step ownership:
 *   pre-world: snapshot solved humanoid root + input/action/AI intent shaping
 *   legacy melee firewall: old timer/range combat cannot damage humanoids
 *   world sim: compatibility prediction for legacy game systems
 *   root firewall: discard temporary capsule translation for body-owned humans
 *   post-world/pre-body: locomotion + melee end-effector task generation
 *   whole-body coupling: support / COM / stance tasks derived from actions
 *   centroidal coupling: acceleration/braking/turning posture from real COM state
 *   task finalization: position + target-velocity field
 *   pre-integration: bounded joint actuation + support translation/yaw wrench
 *   body solve: integration -> posture control -> joint constraints -> contacts
 *   post-solve: real swept effector contact -> impulse -> stability outcome -> Actor root
 */
export class ProceduralAnimationController extends AnimationController {
  private readonly melee = new MeleeKinematics(this);
  private readonly social = new SocialAwarenessController();
  private readonly causality = new BodyCausality(this);
  private readonly coupling = new WholeBodyCoupling(this);
  private readonly rootAuthority = new HumanRootAuthority();
  private readonly centroidal = new CentroidalLocomotion(this);
  private playerJumpRequested = false;

  override bootstrap(w: World) {
    super.bootstrap(w);
    impactDynamics.bind(this);
    impactDynamics.bootstrap(w);
    this.melee.bootstrap(w);
    this.coupling.bootstrap(w);
    this.rootAuthority.clear();
    legacyHumanMeleeFirewall.clear();
    this.social.reset();
    this.playerJumpRequested = false;
  }

  override clear() {
    super.clear();
    impactDynamics.clear();
    this.melee.clear();
    this.coupling.clear();
    this.rootAuthority.clear();
    legacyHumanMeleeFirewall.clear();
    this.social.reset();
    this.playerJumpRequested = false;
  }

  override reset(a: Actor) {
    super.reset(a);
    impactDynamics.reset(a);
    this.melee.reset(a);
    this.coupling.reset(a);
    this.rootAuthority.reset(a);
    if (a.kind === "player") this.playerJumpRequested = false;
  }

  override captureInput(input: Actions) {
    this.melee.captureInput(input);
    super.captureInput(input);
  }

  override prepareInput(w: World, input: Actions, dt: number) {
    // Capture the semantic command before any compatibility layer mutates input.
    // This one-tick authorization is the only path from player jump intent to
    // external upward support work on the articulated body.
    this.playerJumpRequested = Boolean(input.jumpPressed);
    super.prepareInput(w, input, dt);
    this.melee.prepareInput(w, input);
  }

  override prepareStep(w: World, dt: number) {
    this.rootAuthority.capture(w);
    this.social.beginStep(w);
    legacyHumanMeleeFirewall.beforeWorld(w, dt);
    super.prepareStep(w, dt);
  }

  override step(w: World, dt: number) {
    // stepWorld has finished. Restore real AI cooldown ownership before the
    // articulated controller decides whether an attack can begin.
    legacyHumanMeleeFirewall.afterWorld(w, dt);
    this.social.endStep(w);
    this.rootAuthority.restoreBodyOwnedRoots(w);

    super.prepareBodyStep(w, dt);
    this.melee.prepareStep(w, dt);
    this.coupling.prepare(w);
    this.melee.finishCoupledTasks(w);

    // Measured COM velocity error supplies acceleration/braking/turning posture.
    // Corrective steps and combat remain higher-priority than this layer.
    this.centroidal.prepare(w, dt);
    bodyTaskTargets.finalizeStep(dt);

    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (a.kind !== "player" && a.species !== "human") continue;
      const rig = this.get(a);
      if (!rig?.initialized) continue;
      const mode = bodyMode(a);
      activeBodyControl.driveTasksPreIntegration(w, a, rig, dt, mode);
      supportMotion.drive(
        w,
        a,
        rig,
        dt,
        mode,
        a.kind === "player" && this.playerJumpRequested,
      );
      supportWrench.drive(w, a, rig, dt, mode);
    }
    this.playerJumpRequested = false;

    super.step(w, dt);
    this.melee.step(w, dt);
    impactDynamics.step(w, dt);
    this.causality.step(w, dt);
  }
}
