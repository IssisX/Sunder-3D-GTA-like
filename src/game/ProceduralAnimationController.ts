import type { Actions } from "./input";
import type { Actor } from "./types";
import type { World } from "./world";
import { AnimationController } from "./AnimationController";
import { MeleeKinematics } from "./melee-kinematics";
import { beastMelee } from "./beast-melee-kinematics";
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
import { ActionContinuity } from "./action-continuity";
import { ReactiveBalance } from "./reactive-balance";
import { CommittedCatchStep } from "./committed-catch-step";

/**
 * Canonical runtime body/action orchestrator.
 *
 * Fixed-step ownership:
 *   pre-world: snapshot solved humanoid root + input/action/AI intent shaping
 *   world sim: compatibility prediction for legacy game systems
 *   root firewall: discard temporary capsule translation for body-owned humans
 *   post-world/pre-body: locomotion + capture-step commitment + melee task generation
 *   action continuity: preserve incoming step/momentum through action + recovery
 *   whole-body coupling: support / COM / stance tasks derived from actions
 *   reactive balance: measured COM/momentum/support bend free whole-body tasks
 *   centroidal coupling: acceleration/braking/turning posture from real COM state
 *   task finalization: position + target-velocity field
 *   pre-integration: bounded joint actuation + support translation/yaw wrench
 *   body solve: integration -> posture control -> joint constraints -> contacts
 *   post-solve: real human/beast carrier contact -> impulse -> stability outcome
 */
export class ProceduralAnimationController extends AnimationController {
  private readonly melee = new MeleeKinematics(this);
  private readonly social = new SocialAwarenessController();
  private readonly causality = new BodyCausality(this);
  private readonly coupling = new WholeBodyCoupling(this);
  private readonly continuity = new ActionContinuity(this);
  private readonly rootAuthority = new HumanRootAuthority();
  private readonly centroidal = new CentroidalLocomotion(this);
  private readonly balance = new ReactiveBalance(this);
  private readonly catchStep = new CommittedCatchStep(this);
  private playerJumpRequested = false;

  override bootstrap(w: World) {
    super.bootstrap(w);
    impactDynamics.bind(this);
    impactDynamics.bootstrap(w);
    beastMelee.bind(this);
    beastMelee.bootstrap();
    this.melee.bootstrap(w);
    this.coupling.bootstrap(w);
    this.continuity.bootstrap(w);
    this.catchStep.bootstrap(w);
    this.balance.clear();
    this.rootAuthority.clear();
    this.social.reset();
    this.playerJumpRequested = false;
  }

  override clear() {
    super.clear();
    impactDynamics.clear();
    beastMelee.clear();
    this.melee.clear();
    this.coupling.clear();
    this.continuity.clear();
    this.catchStep.clear();
    this.balance.clear();
    this.rootAuthority.clear();
    this.social.reset();
    this.playerJumpRequested = false;
  }

  override reset(a: Actor) {
    super.reset(a);
    impactDynamics.reset(a);
    beastMelee.reset(a);
    this.melee.reset(a);
    this.coupling.reset(a);
    this.continuity.reset(a);
    this.catchStep.reset(a);
    this.balance.reset(a);
    this.rootAuthority.reset(a);
    if (a.kind === "player") this.playerJumpRequested = false;
  }

  override captureInput(input: Actions) {
    this.continuity.captureInput(input);
    this.melee.captureInput(input);
    super.captureInput(input);
  }

  override prepareInput(w: World, input: Actions, dt: number) {
    this.playerJumpRequested = Boolean(input.jumpPressed);
    const replayBuffered = this.continuity.prepareBufferedInput(
      input,
      this.melee.isActive(w.playerId),
      dt,
    );
    if (replayBuffered) this.melee.captureInput(input);
    super.prepareInput(w, input, dt);
    this.melee.prepareInput(w, input);
  }

  override prepareStep(w: World, dt: number) {
    this.rootAuthority.capture(w);
    this.social.beginStep(w);
    super.prepareStep(w, dt);
  }

  override step(w: World, dt: number) {
    this.social.endStep(w);
    this.rootAuthority.restoreBodyOwnedRoots(w);

    super.prepareBodyStep(w, dt);
    // Ordinary gait computes the capture point/foot. Commitment then keeps the
    // chosen foot and landing coherent before action continuity sees the step.
    this.catchStep.prepare(w, dt);
    this.continuity.captureLocomotion(w);
    this.melee.prepareStep(w, dt);
    this.coupling.prepare(w);
    this.melee.finishCoupledTasks(w);
    this.continuity.couple(w, dt);

    // Balance is evaluated after action/continuity targets exist. It can bend
    // the core of an action and recruit genuinely free limbs, but never steals
    // the fist/foot carrier or a planted contact-critical foot.
    this.balance.prepare(w, dt);
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
    beastMelee.step(w, dt);
    impactDynamics.step(w, dt);
    this.causality.step(w, dt);
  }
}
