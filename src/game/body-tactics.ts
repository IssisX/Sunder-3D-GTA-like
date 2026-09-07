import type { Actor } from "./types";
import type { World } from "./world";
import { clamp } from "./world";
import type { BodyRig } from "./body-model";
import {
  makeMechanicalState,
  sampleMechanicalState,
} from "./mechanical-state";

const ENTITY_ID_CAP = 8192;
const BODY_OBSTACLE_R = 1.45;

export const BODY_TACTICS_EDGES = {
  solvedBodyTactics: true,
};

interface BodyRigSource {
  get(a: Actor): BodyRig | undefined;
}

/**
 * Tactical readout of the already-solved articulated body.
 *
 * Claude's branch had the right consumer-side idea - AI should reason about the
 * body that physics actually solved - but its implementation depended on an
 * older motor-authority body representation. Synth keeps ChatGPT-version's
 * stronger body and derives tactical truth from MechanicalState instead.
 *
 * One continuous body capability signal feeds three independent consumers:
 * combat commitment, route deformation around fallen bodies, and social
 * fear/alert. This module never writes body pose, injury, or contact results.
 */
export class SolvedBodyTactics {
  private source: BodyRigSource | null = null;
  private epoch = 1;
  private readonly stamp = new Uint32Array(ENTITY_ID_CAP);
  private readonly incapacity = new Float32Array(ENTITY_ID_CAP);
  private readonly threat = new Float32Array(ENTITY_ID_CAP);
  private readonly offBalance = new Float32Array(ENTITY_ID_CAP);
  private readonly upright = new Float32Array(ENTITY_ID_CAP);
  private readonly state = makeMechanicalState();

  bind(source: BodyRigSource) {
    this.source = source;
  }

  clear() {
    this.source = null;
    this.epoch = 1;
    this.stamp.fill(0);
    this.incapacity.fill(0);
    this.threat.fill(0);
    this.offBalance.fill(0);
    this.upright.fill(0);
  }

  prepare(w: World, dt: number) {
    this.epoch = (this.epoch + 1) >>> 0;
    if (this.epoch === 0) {
      this.stamp.fill(0);
      this.epoch = 1;
    }
    if (!BODY_TACTICS_EDGES.solvedBodyTactics || !this.source) return;

    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (a.id < 0 || a.id >= ENTITY_ID_CAP) continue;
      if (a.kind !== "player" && a.species !== "human") continue;
      const rig = this.source.get(a);
      if (!rig?.initialized) continue;

      sampleMechanicalState(w, a, rig, dt, this.state);
      const conscious = clamp(this.state.consciousness, 0, 1);
      const posture = clamp(this.state.upright, 0, 1);
      const legs = clamp(this.state.legIntegrity, 0, 1);
      const support = Math.max(
        clamp(this.state.supportScore, 0, 1),
        posture * 0.58,
      );
      const disturbance = clamp(this.state.disturbance, 0, 1);

      // Capability stays continuous. Being briefly one-footed in ordinary gait
      // does not make someone helpless because upright posture remains support
      // evidence; loss of consciousness, leg integrity and posture compound.
      const bodyControl =
        conscious *
        (0.28 + posture * 0.72) *
        (0.42 + legs * 0.58);
      const off = clamp(
        (1 - support) * 0.42 +
          (1 - posture) * 0.38 +
          disturbance * 0.2,
        0,
        1,
      );
      const weaponLeverage = a.weapon === "fist" ? 1 : 1.12;
      const danger = clamp(
        bodyControl * weaponLeverage * (1 - off * 0.32),
        0,
        1,
      );
      const incap = clamp(
        1 - bodyControl + disturbance * 0.1,
        0,
        1,
      );

      this.stamp[a.id] = this.epoch;
      this.incapacity[a.id] = incap;
      this.threat[a.id] = danger;
      this.offBalance[a.id] = off;
      this.upright[a.id] = posture;
    }
  }

  incapacityOf(a: Actor) {
    if (a.id < 0 || a.id >= ENTITY_ID_CAP || this.stamp[a.id] !== this.epoch) {
      return clamp(1 - a.consciousness, 0, 1);
    }
    return this.incapacity[a.id]!;
  }

  threatOf(a: Actor) {
    if (a.id < 0 || a.id >= ENTITY_ID_CAP || this.stamp[a.id] !== this.epoch) {
      return a.alive ? clamp(a.consciousness, 0, 1) : 0;
    }
    return this.threat[a.id]!;
  }

  offBalanceOf(a: Actor) {
    if (a.id < 0 || a.id >= ENTITY_ID_CAP || this.stamp[a.id] !== this.epoch) return 0;
    return this.offBalance[a.id]!;
  }

  mediate(w: World, dt: number) {
    if (!BODY_TACTICS_EDGES.solvedBodyTactics) return;

    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (!a.alive || a.kind === "player" || a.species !== "human") continue;

      this.mediateCombat(w, a);
      this.mediateWitnessResponse(w, a, dt);
      this.avoidFallenBodies(w, a);
    }
  }

  private mediateCombat(w: World, a: Actor) {
    if (a.faction !== "guard" || !a.targetId) return;
    const target = w.actor(a.targetId);
    if (!target || !target.alive) return;

    const dx = target.x - a.x;
    const dz = target.z - a.z;
    const d = Math.hypot(dx, dz);
    const incap = this.incapacityOf(target);
    const threat = this.threatOf(target);

    // Stop treating a physically finished person as a full combatant. Guards
    // still close and contain the target, but the solved body - not an HP/AI
    // enum - decides when repeated striking stops being justified.
    if (incap > 0.72 || threat < 0.22) {
      a.strikeT = 0;
      a.kickT = 0;
      a.shoveT = 0;
      a.attackCd = Math.max(a.attackCd, 0.18);
      a.ai = "pursue";
      if (d > 1.55) this.steerToward(a, target.x, target.z, 2.7);
      else a.intendSpeed = 0;
      return;
    }

    // A real loss of support is an opportunity to close distance. This does not
    // author a hit or takedown - it only changes intent; carrier/contact remains
    // authoritative for whether the action succeeds.
    const off = this.offBalanceOf(target);
    if (off > 0.58 && d > 1.05 && d < 3.8) {
      this.steerToward(a, target.x, target.z, Math.max(4.4, a.intendSpeed));
    }
  }

  private mediateWitnessResponse(w: World, a: Actor, dt: number) {
    let strongest = 0;
    let allied = false;
    for (let i = 0; i < w.actors.length; i++) {
      const o = w.actors[i]!;
      if (o.id === a.id || o.kind === "player" || o.species !== "human") continue;
      const d2 = (o.x - a.x) * (o.x - a.x) + (o.z - a.z) * (o.z - a.z);
      if (d2 > 36) continue;
      const incap = this.incapacityOf(o);
      if (incap < 0.58) continue;
      const score = incap * (1 - Math.sqrt(d2) / 6);
      if (score <= strongest) continue;
      strongest = score;
      allied = o.faction === a.faction;
    }
    if (strongest <= 0) return;

    if (a.faction === "civilian") {
      a.fear = clamp(
        a.fear + strongest * (1 - a.courage) * dt * 0.72,
        0,
        1,
      );
    } else if (a.faction === "guard" && allied) {
      a.alert = Math.max(a.alert, 0.48 + strongest * 0.38);
    }
  }

  private avoidFallenBodies(w: World, a: Actor) {
    if (a.intendSpeed < 0.25 || a.grabbedId || a.grabbedBy) return;
    let pushX = 0;
    let pushZ = 0;

    for (let i = 0; i < w.actors.length; i++) {
      const o = w.actors[i]!;
      if (o.id === a.id || o.id === a.targetId) continue;
      if (o.id === a.grabbedId || o.grabbedId === a.id) continue;
      const incap = this.incapacityOf(o);
      const down = incap > 0.58 || this.uprightOf(o) < 0.42;
      if (!down) continue;

      const dx = a.x - o.x;
      const dz = a.z - o.z;
      const d = Math.hypot(dx, dz);
      const radius = BODY_OBSTACLE_R + incap * 0.75;
      if (d <= 1e-4 || d >= radius) continue;
      const weight = (1 - d / radius) * (0.55 + incap * 1.15);
      pushX += (dx / d) * weight;
      pushZ += (dz / d) * weight;
    }

    if (pushX === 0 && pushZ === 0) return;
    const nx = a.intendX + pushX * 1.35;
    const nz = a.intendZ + pushZ * 1.35;
    const m = Math.hypot(nx, nz);
    if (m <= 1e-5) return;
    a.intendX = nx / m;
    a.intendZ = nz / m;
  }

  private uprightOf(a: Actor) {
    if (a.id < 0 || a.id >= ENTITY_ID_CAP || this.stamp[a.id] !== this.epoch) {
      return a.alive ? 1 : 0;
    }
    return this.upright[a.id]!;
  }

  private steerToward(a: Actor, x: number, z: number, speed: number) {
    const dx = x - a.x;
    const dz = z - a.z;
    const d = Math.hypot(dx, dz);
    if (d <= 1e-5) {
      a.intendSpeed = 0;
      return;
    }
    a.intendX = dx / d;
    a.intendZ = dz / d;
    a.intendSpeed = speed;
  }
}

export const solvedBodyTactics = new SolvedBodyTactics();
