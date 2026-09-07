import type { Actor } from "./types";
import { GRAVITY } from "./types";
import type { World } from "./world";
import { BODY, bodyMode, bodyScale, type BodyRig } from "./body-model";
import {
  makeMechanicalState,
  sampleMechanicalState,
  type MechanicalState,
} from "./mechanical-state";
import { bodyTaskTargets, TASK_PRIORITY } from "./body-task-targets";

const ENTITY_ID_CAP = 8192;
const MIN_DT = 1 / 240;
const MAX_DT = 1 / 30;

export const EDGES = {
  reactiveBalance: true,
};

interface BodyAccess {
  get(a: Actor): BodyRig | undefined;
}

function human(a: Actor) {
  return a.kind === "player" || a.species === "human";
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Continuous whole-body balance coupling.
 *
 * This does not move the body or manufacture recovery. It reads the solved
 * body's COM, residual momentum, support geometry, grip, injuries and impact
 * disturbance, then bends the task field so the existing motors/contacts can
 * counterweight naturally. Specialist action carriers keep authority; their
 * core targets receive only a bounded balance correction.
 */
export class ReactiveBalance {
  private readonly state: MechanicalState = makeMechanicalState();
  private readonly demand = new Float32Array(ENTITY_ID_CAP);

  constructor(private readonly bodies: BodyAccess) {}

  clear() {
    this.demand.fill(0);
  }

  reset(a: Actor) {
    if (a.id >= 0 && a.id < ENTITY_ID_CAP) this.demand[a.id] = 0;
  }

  prepare(w: World, dt: number) {
    const h = dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt;

    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!human(a) || !a.alive || a.id < 0 || a.id >= ENTITY_ID_CAP) continue;
      const rig = this.bodies.get(a);
      if (!rig?.initialized) continue;
      const mode = bodyMode(a);
      if (mode === "dynamic" || mode === "recover" || a.grabbedBy) {
        this.demand[a.id] *= Math.exp(-h * 14);
        continue;
      }

      sampleMechanicalState(w, a, rig, h, this.state);
      if (this.state.supportCount <= 0) {
        this.demand[a.id] *= Math.exp(-h * 10);
        continue;
      }

      const scale = bodyScale(a);
      let supportX = 0;
      let supportY = 0;
      let supportZ = 0;
      if (this.state.leftSupported) {
        supportX += rig.x[BODY.lFoot]!;
        supportY += rig.y[BODY.lFoot]!;
        supportZ += rig.z[BODY.lFoot]!;
      }
      if (this.state.rightSupported) {
        supportX += rig.x[BODY.rFoot]!;
        supportY += rig.y[BODY.rFoot]!;
        supportZ += rig.z[BODY.rFoot]!;
      }
      supportX /= this.state.supportCount;
      supportY /= this.state.supportCount;
      supportZ /= this.state.supportCount;

      let intentX = a.intendX;
      let intentZ = a.intendZ;
      const im = Math.hypot(intentX, intentZ);
      if (im > 1e-5) {
        intentX /= im;
        intentZ /= im;
      } else {
        intentX = 0;
        intentZ = 0;
      }

      // Only motion that the current command actually explains is discounted.
      // Side-slip, braking overshoot and impact momentum remain visible to the
      // recovery controller instead of being mistaken for player intention.
      const alongIntent = this.state.velX * intentX + this.state.velZ * intentZ;
      const intendedSpeed = im > 1e-5
        ? Math.max(0, Math.min(Math.max(0, a.intendSpeed), alongIntent))
        : 0;
      const residualVx = this.state.velX - intentX * intendedSpeed;
      const residualVz = this.state.velZ - intentZ * intendedSpeed;
      const residualSpeed = Math.hypot(residualVx, residualVz);

      const comH = Math.max(0.4 * scale, this.state.comY - supportY);
      const omega0 = Math.sqrt(GRAVITY / comH);
      const captureX = this.state.comX + residualVx / Math.max(1e-5, omega0);
      const captureZ = this.state.comZ + residualVz / Math.max(1e-5, omega0);
      let errorX = captureX - supportX;
      let errorZ = captureZ - supportZ;
      let error = Math.hypot(errorX, errorZ);

      if (error < 1e-5) {
        errorX = this.state.comX - supportX;
        errorZ = this.state.comZ - supportZ;
        error = Math.hypot(errorX, errorZ);
      }
      if (error < 1e-5 && residualSpeed > 1e-5) {
        errorX = residualVx;
        errorZ = residualVz;
        error = residualSpeed;
      }

      let fallX = 0;
      let fallZ = 0;
      if (error > 1e-5) {
        fallX = errorX / error;
        fallZ = errorZ / error;
      }

      const marginDemand = clamp01(
        (0.055 * scale - this.state.supportMargin) / (0.22 * scale),
      );
      const captureDemand = clamp01(
        (error - 0.06 * scale) / (0.3 * scale),
      );
      const residualDemand = clamp01(residualSpeed / 3.4);
      const angularDemand = clamp01(
        Math.hypot(this.state.angularX, this.state.angularZ) /
          Math.max(1, a.mass * 0.24),
      );
      const disturbanceDemand = clamp01(this.state.disturbance / 0.92);
      const control =
        this.state.legIntegrity *
        (0.35 + this.state.consciousness * 0.65);
      let rawDemand = Math.max(
        marginDemand * 0.9,
        captureDemand,
        residualDemand * 0.56,
        angularDemand * 0.68,
        disturbanceDemand * 0.9,
      ) * control;
      if (!EDGES.reactiveBalance) rawDemand = 0;

      const previous = this.demand[a.id]!;
      const rate = rawDemand > previous ? 23 : 11;
      const blend = 1 - Math.exp(-h * rate);
      const demand = previous + (rawDemand - previous) * blend;
      this.demand[a.id] = demand;
      if (demand < 0.025) continue;

      // Moving the upper body opposite the capture error reduces runaway COM
      // motion. Because task actuation is momentum-neutral, this is genuine
      // internal counterweight; only foot contact can provide external impulse.
      const counterX = -fallX;
      const counterZ = -fallZ;
      const actionCore =
        bodyTaskTargets.priorityFor(a, BODY.pelvis) >= TASK_PRIORITY.ACTION ||
        bodyTaskTargets.priorityFor(a, BODY.chest) >= TASK_PRIORITY.ACTION;
      const coreGain = actionCore ? 0.42 : 1;

      this.offsetTask(
        a, rig, BODY.pelvis,
        counterX * 0.026 * demand * scale * coreGain,
        -0.02 * demand * scale * coreGain,
        counterZ * 0.026 * demand * scale * coreGain,
        true,
      );
      this.offsetTask(
        a, rig, BODY.chest,
        counterX * 0.072 * demand * scale * coreGain,
        -0.008 * demand * scale * coreGain,
        counterZ * 0.072 * demand * scale * coreGain,
        true,
      );
      this.offsetTask(
        a, rig, BODY.head,
        counterX * 0.026 * demand * scale * coreGain,
        0,
        counterZ * 0.026 * demand * scale * coreGain,
        true,
      );

      // Knee flex absorbs the recovery without creating a rigid waist bend.
      // Action-owned legs keep specialist authority, especially during kicks.
      this.offsetTask(a, rig, BODY.lKnee, 0, -0.032 * demand * scale, 0, false);
      this.offsetTask(a, rig, BODY.rKnee, 0, -0.032 * demand * scale, 0, false);

      // Free arms become counterweights. During Punch/Kick, action-owned hands
      // are untouched; any genuinely free arm can still participate.
      const arm = clamp01((demand - 0.06) / 0.94);
      if (arm > 0) {
        const sideX = -fallZ;
        const sideZ = fallX;
        this.offsetTask(
          a, rig, BODY.lElbow,
          counterX * 0.055 * arm * scale - sideX * 0.026 * arm * scale,
          0.025 * arm * scale,
          counterZ * 0.055 * arm * scale - sideZ * 0.026 * arm * scale,
          false,
        );
        this.offsetTask(
          a, rig, BODY.rElbow,
          counterX * 0.055 * arm * scale + sideX * 0.026 * arm * scale,
          0.025 * arm * scale,
          counterZ * 0.055 * arm * scale + sideZ * 0.026 * arm * scale,
          false,
        );
        this.offsetTask(
          a, rig, BODY.lHand,
          counterX * 0.115 * arm * scale - sideX * 0.055 * arm * scale,
          0.065 * arm * scale,
          counterZ * 0.115 * arm * scale - sideZ * 0.055 * arm * scale,
          false,
        );
        this.offsetTask(
          a, rig, BODY.rHand,
          counterX * 0.115 * arm * scale + sideX * 0.055 * arm * scale,
          0.065 * arm * scale,
          counterZ * 0.115 * arm * scale + sideZ * 0.055 * arm * scale,
          false,
        );
      }
    }
  }

  private offsetTask(
    a: Actor,
    rig: BodyRig,
    node: number,
    dx: number,
    dy: number,
    dz: number,
    allowAction: boolean,
  ) {
    const currentPriority = bodyTaskTargets.priorityFor(a, node);
    if (currentPriority >= TASK_PRIORITY.CONTACT_CRITICAL) return;
    if (currentPriority >= TASK_PRIORITY.ACTION && !allowAction) return;

    const actionOwned = currentPriority >= TASK_PRIORITY.ACTION;
    const priority = actionOwned
      ? currentPriority
      : TASK_PRIORITY.CORRECTIVE_STEP;
    const tx = currentPriority > 0
      ? bodyTaskTargets.targetXFor(a, node)
      : rig.x[node]!;
    const ty = currentPriority > 0
      ? bodyTaskTargets.targetYFor(a, node)
      : rig.y[node]!;
    const tz = currentPriority > 0
      ? bodyTaskTargets.targetZFor(a, node)
      : rig.z[node]!;

    bodyTaskTargets.offerWorld(
      a,
      node,
      tx + dx,
      ty + dy,
      tz + dz,
      1,
      priority,
    );
  }
}
