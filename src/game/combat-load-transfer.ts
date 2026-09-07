import type { Actor } from "./types";
import type { World } from "./world";
import type { PhysicalBodies } from "./body";
import { BODY, bodyScale } from "./body-model";
import { makeMechanicalState, sampleMechanicalState } from "./mechanical-state";
import { bodyTaskTargets as tasks, TASK_PRIORITY as P } from "./body-task-targets";

export const COMBAT_EDGES = { loadTransfer: true };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * The existing strike carrier owns contact. This layer can only request
 * coordinated trunk/hip motion; it never moves solved nodes or grants damage.
 * It is dormant outside actual melee actions, so walking keeps its authority.
 */
export class CombatLoadTransfer {
  private readonly state = makeMechanicalState();
  private readonly smoothed = new Float32Array(8192);
  constructor(private readonly bodies: PhysicalBodies, private readonly active: (id: number) => boolean) {}
  clear() { this.smoothed.fill(0); }
  reset(id: number) { if (id >= 0 && id < this.smoothed.length) this.smoothed[id] = 0; }
  prepare(w: World, dt: number) {
    for (const a of w.actors) {
      if ((a.kind !== "player" && a.species !== "human") || !a.alive || !this.active(a.id)) continue;
      if (a.id < 0 || a.id >= this.smoothed.length) continue;
      const rig = this.bodies.get(a);
      if (!rig?.initialized || rig.mode !== "follow") continue;
      sampleMechanicalState(w, a, rig, dt, this.state);
      const s = this.state;
      if (s.supportCount === 0 || s.consciousness < 0.35) continue;
      const l = this.distance(a, rig, BODY.lHand);
      const r = this.distance(a, rig, BODY.rHand);
      const node = l > r ? BODY.lHand : BODY.rHand;
      const distance = Math.max(l, r);
      if (distance < 0.035 * bodyScale(a)) continue;
      const side = node === BODY.rHand ? 1 : -1;
      const control = clamp01(s.supportScore) * (0.45 + 0.55 * s.legIntegrity) * s.consciousness;
      const reach = clamp01(distance / (0.42 * bodyScale(a)));
      const momentum = clamp01(Math.hypot(s.velX, s.velZ) / 5.5);
      const target = reach * control * (0.85 + 0.15 * momentum);
      const previous = this.smoothed[a.id]!;
      const drive = previous + (target - previous) * (1 - Math.exp(-dt * 24));
      this.smoothed[a.id] = drive;
      if (!COMBAT_EDGES.loadTransfer || drive < 0.015) continue;
      // The pivot is the live support centroid. The free foot is not teleported
      // or replanted, and contact-critical tasks always retain priority.
      let px = 0, pz = 0, n = 0;
      if (s.leftSupported) { px += rig.x[BODY.lFoot]!; pz += rig.z[BODY.lFoot]!; n++; }
      if (s.rightSupported) { px += rig.x[BODY.rFoot]!; pz += rig.z[BODY.rFoot]!; n++; }
      if (!n) continue;
      px /= n; pz /= n;
      const scale = bodyScale(a);
      const twist = -side * drive * (a.weapon === "fist" ? 0.28 : 0.38);
      this.rotate(a, BODY.lHip, BODY.rHip, px, pz, twist * 0.45);
      this.rotate(a, BODY.lShoulder, BODY.rShoulder, px, pz, twist);
      const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
      const rx = Math.cos(a.yaw), rz = -Math.sin(a.yaw);
      this.offset(a, BODY.pelvis, rx * side * drive * 0.018 * scale,
        -drive * 0.012 * scale, rz * side * drive * 0.018 * scale);
      this.offset(a, BODY.chest, fx * drive * 0.03 * scale + rx * side * drive * 0.025 * scale,
        drive * 0.012 * scale, fz * drive * 0.03 * scale + rz * side * drive * 0.025 * scale);
    }
  }
  private distance(a: Actor, rig: NonNullable<ReturnType<PhysicalBodies["get"]>>, node: number) {
    if (tasks.priorityFor(a, node) < P.ACTION) return 0;
    return Math.hypot(tasks.targetXFor(a, node) - rig.x[node]!,
      tasks.targetYFor(a, node) - rig.y[node]!, tasks.targetZFor(a, node) - rig.z[node]!);
  }
  private offset(a: Actor, node: number, dx: number, dy: number, dz: number) {
    if (tasks.priorityFor(a, node) >= P.CONTACT_CRITICAL) return;
    tasks.offerWorld(a, node, tasks.targetXFor(a, node) + dx,
      tasks.targetYFor(a, node) + dy, tasks.targetZFor(a, node) + dz, 1, P.ACTION);
  }
  private rotate(a: Actor, left: number, right: number, px: number, pz: number, theta: number) {
    const c = Math.cos(theta), s = Math.sin(theta);
    for (let i = 0; i < 2; i++) {
      const node = i === 0 ? left : right;
      if (tasks.priorityFor(a, node) >= P.CONTACT_CRITICAL) continue;
      const x = tasks.targetXFor(a, node) - px, z = tasks.targetZFor(a, node) - pz;
      tasks.offerWorld(a, node, px + x * c - z * s, tasks.targetYFor(a, node),
        pz + x * s + z * c, 1, P.ACTION);
    }
  }
}
