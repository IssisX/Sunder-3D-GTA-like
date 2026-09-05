import type { Actor } from "./types";
import { GRAVITY, HALF } from "./types";
import type { World } from "./world";
import { clamp, facing } from "./world";
import {
  BODY,
  BODY_NODE_COUNT,
  BODY_REGIONS,
  GRAB_NODES,
  JOINT_RANGES,
  LINK_DEFS,
  LINK_STIFFNESS,
  NODE_INV_MASS,
  bodyMode,
  bodyScale,
  computeTarget,
  injuryScore,
  makeRig,
  nodeRadius,
  nodeVelocityComponent,
  representativeNode,
  resetRig,
  snapshotInjuries,
  type BodyMode,
  type BodyRig,
} from "./body-model";
import {
  collideRig,
  solveBodyPair,
  solveSelfContacts,
  supportHeight,
} from "./body-contacts";
import { bodyTaskTargets, TASK_PRIORITY } from "./body-task-targets";
import { activeBodyControl } from "./active-body-control";

export {
  BODY,
  BODY_NODE_COUNT,
  type BodyMode,
  type BodyRig,
} from "./body-model";

function solveDistance(
  rig: BodyRig,
  ia: number,
  ib: number,
  rest: number,
  stiffness: number,
  scale: number,
  supportMask = 0,
) {
  const dx = rig.x[ib]! - rig.x[ia]!;
  const dy = rig.y[ib]! - rig.y[ia]!;
  const dz = rig.z[ib]! - rig.z[ia]!;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < 1e-10) return;

  const d = Math.sqrt(d2);
  const wa = NODE_INV_MASS[ia]!;
  const wb = NODE_INV_MASS[ib]!;
  const sum = wa + wb;
  const corr = ((d - rest * scale) / d) * stiffness;

  rig.x[ia] += dx * corr * (wa / sum);
  const ya = supportMask & (1 << ia) ? 0 : wa;
  const yb = supportMask & (1 << ib) ? 0 : wb;
  const ysum = ya + yb || 1;
  rig.y[ia] += dy * corr * (ya / ysum);
  rig.z[ia] += dz * corr * (wa / sum);
  rig.x[ib] -= dx * corr * (wb / sum);
  rig.y[ib] -= dy * corr * (yb / ysum);
  rig.z[ib] -= dz * corr * (wb / sum);
}

function solveRange(
  rig: BodyRig,
  ia: number,
  ib: number,
  min: number,
  max: number,
  scale: number,
  supportMask = 0,
) {
  const dx = rig.x[ib]! - rig.x[ia]!;
  const dy = rig.y[ib]! - rig.y[ia]!;
  const dz = rig.z[ib]! - rig.z[ia]!;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < 1e-10) return;

  const d = Math.sqrt(d2);
  const lo = min * scale;
  const hi = max * scale;
  const target = d < lo ? lo : d > hi ? hi : d;
  if (target === d) return;

  const wa = NODE_INV_MASS[ia]!;
  const wb = NODE_INV_MASS[ib]!;
  const sum = wa + wb;
  const corr = (d - target) / d;

  rig.x[ia] += dx * corr * (wa / sum);
  const ya = supportMask & (1 << ia) ? 0 : wa;
  const yb = supportMask & (1 << ib) ? 0 : wb;
  const ysum = ya + yb || 1;
  rig.y[ia] += dy * corr * (ya / ysum);
  rig.z[ia] += dz * corr * (wa / sum);
  rig.x[ib] -= dx * corr * (wb / sum);
  rig.y[ib] -= dy * corr * (yb / ysum);
  rig.z[ib] -= dz * corr * (wb / sum);
}

function solveLinks(
  a: Actor,
  rig: BodyRig,
  stiffness = 1,
  supportMask = 0,
) {
  const scale = bodyScale(a);

  for (let i = 0; i < LINK_DEFS.length; i++) {
    const [ia, ib, rest] = LINK_DEFS[i]!;
    solveDistance(
      rig,
      ia,
      ib,
      rest,
      LINK_STIFFNESS[i]! * stiffness,
      scale,
      supportMask,
    );
  }

  for (const [ia, ib, min, max] of JOINT_RANGES) {
    solveRange(rig, ia, ib, min, max, scale, supportMask);
  }
}

function closestGrabNode(
  rig: BodyRig,
  x: number,
  y: number,
  z: number,
) {
  let best: number = BODY.chest;
  let bestD = Infinity;

  for (const i of GRAB_NODES) {
    const dx = rig.x[i]! - x;
    const dy = rig.y[i]! - y;
    const dz = rig.z[i]! - z;
    const d2 = dx * dx + dy * dy + dz * dz;

    if (d2 < bestD) {
      bestD = d2;
      best = i;
    }
  }

  return best;
}

function solveGrab(
  w: World,
  a: Actor,
  rig: BodyRig,
  getRig: (actor: Actor) => BodyRig | undefined,
  strength: number,
) {
  if (!a.grabbedBy) {
    rig.grabNode = -1;
    return;
  }

  const holder = w.actor(a.grabbedBy);
  if (!holder) {
    a.grabbedBy = 0;
    rig.grabNode = -1;
    return;
  }

  const holderRig = getRig(holder);
  let tx: number;
  let ty: number;
  let tz: number;

  if (holderRig?.initialized) {
    tx = holderRig.x[BODY.rHand]!;
    ty = holderRig.y[BODY.rHand]!;
    tz = holderRig.z[BODY.rHand]!;
  } else {
    const f = facing(holder.yaw);
    tx = holder.x + f.x * 0.5;
    ty = holder.y + holder.height * 0.65;
    tz = holder.z + f.z * 0.5;
  }

  if (rig.grabNode < 0) {
    rig.grabNode = closestGrabNode(rig, tx, ty, tz);
  }

  const i = rig.grabNode;
  const dx = tx - rig.x[i]!;
  const dy = ty - rig.y[i]!;
  const dz = tz - rig.z[i]!;
  const dist = Math.hypot(dx, dy, dz);
  const k = dist > 1.1 ? Math.min(1, strength * 1.2) : strength;

  rig.x[i] += dx * k;
  rig.y[i] += dy * k;
  rig.z[i] += dz * k;

  if (dist > 0.5) {
    const load = a.mass / Math.max(1, a.mass + holder.mass);
    holder.balance = clamp(
      holder.balance - Math.min(0.04, dist * load * 0.012),
      0,
      1,
    );
    holder.vx -= dx * load * 0.03;
    holder.vz -= dz * load * 0.03;
  }
}

function injectExternalImpulse(
  w: World,
  a: Actor,
  rig: BodyRig,
  dt: number,
) {
  const p = BODY.pelvis;
  const rvx = nodeVelocityComponent(rig.x[p]!, rig.px[p]!, dt);
  const rvy = nodeVelocityComponent(rig.y[p]!, rig.py[p]!, dt);
  const rvz = nodeVelocityComponent(rig.z[p]!, rig.pz[p]!, dt);

  let dvx = a.vx - rvx;
  let dvy = a.vy - rvy;
  let dvz = a.vz - rvz;
  const mag = Math.hypot(dvx, dvy, dvz);
  if (mag < 1.15) return;

  const capped = Math.min(18, mag) / mag;
  dvx *= capped;
  dvy *= capped;
  dvz *= capped;

  let bestRegion = -1;
  let bestDelta = 0;

  for (let i = 0; i < BODY_REGIONS.length; i++) {
    const delta = injuryScore(a, BODY_REGIONS[i]!) - rig.injurySnapshot[i]!;
    if (delta > bestDelta) {
      bestDelta = delta;
      bestRegion = i;
    }
  }

  const recentHit = Boolean(a.lastHitBy) && w.time - a.lastHitT < dt * 1.6;

  if (recentHit && bestRegion >= 0) {
    const node = representativeNode(BODY_REGIONS[bestRegion]!);
    rig.px[node] -= dvx * dt * 0.85;
    rig.py[node] -= dvy * dt * 0.85;
    rig.pz[node] -= dvz * dt * 0.85;
    rig.px[BODY.chest] -= dvx * dt * 0.18;
    rig.py[BODY.chest] -= dvy * dt * 0.18;
    rig.pz[BODY.chest] -= dvz * dt * 0.18;
    return;
  }

  if (a.grabbedBy) return;

  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    rig.px[i] -= dvx * dt * 0.42;
    rig.py[i] -= dvy * dt * 0.42;
    rig.pz[i] -= dvz * dt * 0.42;
  }
}

function integrateBody(
  w: World,
  rig: BodyRig,
  dt: number,
  mode: BodyMode,
) {
  const damp =
    mode === "dynamic"
      ? 0.988
      : mode === "stumble"
        ? 0.965
        : mode === "recover"
          ? 0.958
          : 0.992;
  const gravity =
    mode === "recover"
      ? GRAVITY * 0.72
      : mode === "stumble"
        ? GRAVITY * 0.9
        : GRAVITY;

  for (let i = 0; i < BODY_NODE_COUNT; i++) {
    const x = rig.x[i]!;
    const y = rig.y[i]!;
    const z = rig.z[i]!;
    let dx = (x - rig.px[i]!) * damp;
    let dy = (y - rig.py[i]!) * damp;
    let dz = (z - rig.pz[i]!) * damp;

    if (w.inWater(x, z, y)) {
      dx *= 0.82;
      dy *= 0.82;
      dz *= 0.82;
      dy += 4.2 * dt * dt;
    }

    rig.px[i] = x;
    rig.py[i] = y;
    rig.pz[i] = z;
    rig.x[i] = x + dx;
    rig.y[i] = y + dy - gravity * dt * dt;
    rig.z[i] = z + dz;
  }
}

function deriveActorFromRig(
  a: Actor,
  rig: BodyRig,
  dt: number,
) {
  const p = BODY.pelvis;
  const feet = Math.min(
    rig.y[BODY.lFoot]! - nodeRadius(a, BODY.lFoot),
    rig.y[BODY.rFoot]! - nodeRadius(a, BODY.rFoot),
    rig.y[p]! - 0.78 * bodyScale(a),
  );

  a.x = clamp(rig.x[p]!, -HALF + 1, HALF - 1);
  a.z = clamp(rig.z[p]!, -HALF + 1, HALF - 1);
  a.y = Math.max(0, feet);
  a.vx = nodeVelocityComponent(rig.x[p]!, rig.px[p]!, dt);
  a.vy = nodeVelocityComponent(rig.y[p]!, rig.py[p]!, dt);
  a.vz = nodeVelocityComponent(rig.z[p]!, rig.pz[p]!, dt);
  a.grounded = rig.groundedNodes > 0;

  if (rig.mode === "dynamic") {
    const rise = rig.y[BODY.chest]! - rig.y[p]!;
    const lean = Math.hypot(
      rig.x[BODY.chest]! - rig.x[p]!,
      rig.z[BODY.chest]! - rig.z[p]!,
    );
    const posture =
      clamp((rise - 0.05) / 0.42, 0, 1) *
      clamp(1 - lean / 0.8, 0, 1);
    a.balance = Math.min(a.balance, posture);
  }
}

export class PhysicalBodies {
  private rigs = new Map<number, BodyRig>();

  bootstrap(w: World) {
    for (const a of w.actors) {
      if (a.species === "human" || a.kind === "player") {
        this.ensure(a);
      }
    }
  }

  get(a: Actor) {
    return this.rigs.get(a.id);
  }

  ensure(a: Actor) {
    let rig = this.rigs.get(a.id);
    if (!rig) {
      rig = makeRig();
      this.rigs.set(a.id, rig);
    }
    if (!rig.initialized) resetRig(a, rig);
    return rig;
  }

  reset(a: Actor) {
    resetRig(a, this.ensure(a));
  }

  clear() {
    this.rigs.clear();
  }

  step(w: World, dt: number) {
    const humans: Actor[] = [];

    for (const a of w.actors) {
      if (a.species !== "human" && a.kind !== "player") {
        continue;
      }

      humans.push(a);
      const rig = this.ensure(a);

      for (let i = 0; i < BODY_NODE_COUNT; i++) {
        rig.impactCd[i] = Math.max(0, rig.impactCd[i]! - dt);
      }

      const mode = bodyMode(a);
      rig.mode = mode;
      rig.groundedNodes = 0;

      if (mode !== "follow") {
        injectExternalImpulse(w, a, rig, dt);
      }

      // A one-leg action stance may use the ground as its normal boundary
      // while contact is close. Horizontal motion remains free for the
      // existing collision/friction solver.
      let supportMask = 0;
      let leftY = 0, rightY = 0;
      if (mode !== "dynamic" && !a.grabbedBy) {
        for (const foot of [BODY.lFoot, BODY.rFoot]) {
          if (bodyTaskTargets.priorityFor(a, foot) <
              TASK_PRIORITY.CONTACT_CRITICAL) continue;
          const other = foot === BODY.lFoot ? BODY.rFoot : BODY.lFoot;
          if (bodyTaskTargets.priorityFor(a, other) !==
              TASK_PRIORITY.ACTION) continue;
          const floorY = supportHeight(
            w, rig.x[foot]!, rig.y[foot]!, rig.z[foot]!,
          ) + nodeRadius(a, foot);
          if (Math.abs(rig.y[foot]! - floorY) >
              0.085 * bodyScale(a)) continue;
          if (Math.abs(bodyTaskTargets.targetYFor(a, foot) -
              floorY) > 0.025 * bodyScale(a)) continue;
          supportMask |= 1 << foot;
          if (foot === BODY.lFoot) leftY = floorY;
          else rightY = floorY;
        }
      }
      integrateBody(w, rig, dt, mode);
      if (supportMask & (1 << BODY.lFoot)) {
        rig.y[BODY.lFoot] = rig.py[BODY.lFoot] = leftY;
      }
      if (supportMask & (1 << BODY.rFoot)) {
        rig.y[BODY.rFoot] = rig.py[BODY.rFoot] = rightY;
      }

      const floor = supportHeight(
        w,
        rig.x[BODY.pelvis]!,
        rig.y[BODY.pelvis]!,
        rig.z[BODY.pelvis]!,
      );
      computeTarget(a, rig, floor);

      activeBodyControl.drive(w, a, rig, dt, mode);

      const iterations = mode === "dynamic" ? 6 : 5;
      const linkStrength =
        mode === "dynamic"
          ? 1
          : mode === "follow"
            ? 0.96
            : 0.94;

      for (let iter = 0; iter < iterations; iter++) {
        solveLinks(a, rig, linkStrength, supportMask);
        solveGrab(
          w,
          a,
          rig,
          (actor) => this.get(actor),
          mode === "dynamic" ? 0.72 : 0.58,
        );
        collideRig(w, a, rig, dt, iter === 0);
        solveSelfContacts(a, rig);
        if (supportMask & (1 << BODY.lFoot)) {
          rig.y[BODY.lFoot] = rig.py[BODY.lFoot] = leftY;
          rig.groundedNodes = Math.max(1, rig.groundedNodes);
        }
        if (supportMask & (1 << BODY.rFoot)) {
          rig.y[BODY.rFoot] = rig.py[BODY.rFoot] = rightY;
          rig.groundedNodes = Math.max(1, rig.groundedNodes);
        }
      }

      if (mode === "stumble") {
        const actionActive =
          bodyTaskTargets.priorityFor(a, BODY.lFoot) >= TASK_PRIORITY.ACTION ||
          bodyTaskTargets.priorityFor(a, BODY.rFoot) >= TASK_PRIORITY.ACTION ||
          bodyTaskTargets.priorityFor(a, BODY.lHand) >= TASK_PRIORITY.ACTION ||
          bodyTaskTargets.priorityFor(a, BODY.rHand) >= TASK_PRIORITY.ACTION;
        const rise = rig.y[BODY.chest]! - rig.y[BODY.pelvis]!;
        const lean = Math.hypot(
          rig.x[BODY.chest]! - rig.x[BODY.pelvis]!,
          rig.z[BODY.chest]! - rig.z[BODY.pelvis]!,
        );

        if (
          !actionActive && (
          rise < 0.16 ||
          lean > 0.62 * bodyScale(a) ||
          a.balance < 0.08
          )
        ) {
          a.loco = "ragdoll";
          a.locoT = Math.max(a.locoT, 0.65);
          rig.mode = "dynamic";
        }
      }
    }

    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < humans.length; i++) {
        const a = humans[i]!;
        const ra = this.ensure(a);

        for (let j = i + 1; j < humans.length; j++) {
          const b = humans[j]!;
          if (a.grabbedId === b.id || b.grabbedId === a.id) {
            continue;
          }

          solveBodyPair(
            w,
            a,
            ra,
            b,
            this.ensure(b),
            dt,
            pass === 0,
          );
        }
      }
    }

    for (const a of humans) {
      const rig = this.ensure(a);

      solveLinks(a, rig, rig.mode === "dynamic" ? 0.82 : 0.76);
      deriveActorFromRig(a, rig, dt);

      if (rig.mode === "recover" && a.getupT <= 0) {
        const err = Math.hypot(
          rig.x[BODY.head]! - rig.tx[BODY.head]!,
          rig.y[BODY.head]! - rig.ty[BODY.head]!,
          rig.z[BODY.head]! - rig.tz[BODY.head]!,
        );

        if (err > 0.42 * bodyScale(a)) {
          a.loco = "ragdoll";
          a.locoT = 0.35;
          rig.mode = "dynamic";
        }
      }

      snapshotInjuries(a, rig);
    }
  }
}
