import type { Actor, Collider } from "./types";
import { HALF } from "./types";
import type { World } from "./world";
import { clamp } from "./world";
import { impactDynamics } from "./impact-dynamics";
import { bodyTaskTargets, TASK_PRIORITY } from "./body-task-targets";
import {
  applyBodyImpactDamage,
  assessPairNodeImpact,
  assessStaticNodeImpact,
} from "./impact-mediation";
import {
  BASE_RADIUS,
  BODY,
  CONTACT_NODES,
  NODE_INV_MASS,
  SELF_PAIRS,
  bodyScale,
  nodeRadius,
  nodeVelocityComponent,
  type BodyMode,
  type BodyRig,
} from "./body-model";

function resolveNodeAabb(
  w: World,
  a: Actor,
  rig: BodyRig,
  node: number,
  c: Collider,
  dt: number,
  registerImpact: boolean,
) {
  const radius = nodeRadius(a, node);
  const x = rig.x[node]!;
  const y = rig.y[node]!;
  const z = rig.z[node]!;
  const qx = clamp(x, c.minX, c.maxX);
  const qy = clamp(y, c.minY, c.maxY);
  const qz = clamp(z, c.minZ, c.maxZ);
  let nx = x - qx;
  let ny = y - qy;
  let nz = z - qz;
  const d2 = nx * nx + ny * ny + nz * nz;

  if (d2 >= radius * radius) return false;

  let penetration: number;
  if (d2 < 1e-10) {
    const dl = Math.abs(x - c.minX);
    const dr = Math.abs(c.maxX - x);
    const db = Math.abs(y - c.minY);
    const dtp = Math.abs(c.maxY - y);
    const ds = Math.abs(z - c.minZ);
    const dn = Math.abs(c.maxZ - z);
    const nearest = Math.min(
      dl,
      dr,
      db,
      dtp,
      ds,
      dn,
    );
    penetration = nearest + radius + 0.002;

    if (nearest === dl) {
      nx = -1;
      ny = 0;
      nz = 0;
    } else if (nearest === dr) {
      nx = 1;
      ny = 0;
      nz = 0;
    } else if (nearest === db) {
      nx = 0;
      ny = -1;
      nz = 0;
    } else if (nearest === dtp) {
      nx = 0;
      ny = 1;
      nz = 0;
    } else if (nearest === ds) {
      nx = 0;
      ny = 0;
      nz = -1;
    } else {
      nx = 0;
      ny = 0;
      nz = 1;
    }
  } else {
    const d = Math.sqrt(d2);
    const inv = 1 / d;
    nx *= inv;
    ny *= inv;
    nz *= inv;
    penetration = radius - d + 0.002;
  }

  const vx = nodeVelocityComponent(
    rig.x[node]!,
    rig.px[node]!,
    dt,
  );
  const vy = nodeVelocityComponent(
    rig.y[node]!,
    rig.py[node]!,
    dt,
  );
  const vz = nodeVelocityComponent(
    rig.z[node]!,
    rig.pz[node]!,
    dt,
  );
  const vn = vx * nx + vy * ny + vz * nz;

  if (registerImpact && vn < 0) {
    const closing = -vn;
    const impact = assessStaticNodeImpact(a, node, closing);
    applyBodyImpactDamage(w, a, rig, node, impact);
    if (impact.damaging) {
      impactDynamics.contactNode(
        a,
        node,
        nx * closing * 0.42,
        ny * closing * 0.42,
        nz * closing * 0.42,
        0.78,
      );
    }
  }

  rig.x[node] += nx * penetration;
  rig.y[node] += ny * penetration;
  rig.z[node] += nz * penetration;

  if (vn < 0) {
    const bounce = 0.08;
    const rvx = vx - nx * vn * (1 + bounce);
    const rvy = vy - ny * vn * (1 + bounce);
    const rvz = vz - nz * vn * (1 + bounce);
    rig.px[node] =
      rig.x[node]! - rvx * dt * 0.78;
    rig.py[node] =
      rig.y[node]! - rvy * dt * 0.78;
    rig.pz[node] =
      rig.z[node]! - rvz * dt * 0.78;
  }

  if (ny > 0.45) rig.groundedNodes++;
  return true;
}

export function collideRig(
  w: World,
  a: Actor,
  rig: BodyRig,
  dt: number,
  registerImpact: boolean,
) {
  for (let i = 0; i < rig.x.length; i++) {
    const radius = nodeRadius(a, i);

    if (rig.y[i]! < radius) {
      const vy = nodeVelocityComponent(
        rig.y[i]!,
        rig.py[i]!,
        dt,
      );
      if (
        registerImpact &&
        vy < 0 &&
        bodyTaskTargets.priorityFor(a, i) < TASK_PRIORITY.ACTION
      ) {
        const closing = -vy;
        const impact = assessStaticNodeImpact(a, i, closing);
        applyBodyImpactDamage(w, a, rig, i, impact);
        if (impact.damaging) {
          impactDynamics.contactNode(
            a,
            i,
            0,
            closing * 0.36,
            0,
            0.72,
          );
        }
      }
      rig.y[i] = radius;
      if (vy < 0) {
        rig.py[i] =
          rig.y[i]! + vy * dt * 0.08;
        rig.px[i] +=
          (rig.x[i]! - rig.px[i]!) * 0.2;
        rig.pz[i] +=
          (rig.z[i]! - rig.pz[i]!) * 0.2;
      }
      rig.groundedNodes++;
    }

    for (const c of w.colliders) {
      if (!c.solid || c.water) continue;
      if (
        rig.x[i]! < c.minX - radius ||
        rig.x[i]! > c.maxX + radius ||
        rig.y[i]! < c.minY - radius ||
        rig.y[i]! > c.maxY + radius ||
        rig.z[i]! < c.minZ - radius ||
        rig.z[i]! > c.maxZ + radius
      ) {
        continue;
      }
      resolveNodeAabb(
        w,
        a,
        rig,
        i,
        c,
        dt,
        registerImpact,
      );
    }

    rig.x[i] = clamp(
      rig.x[i]!,
      -HALF + radius,
      HALF - radius,
    );
    rig.z[i] = clamp(
      rig.z[i]!,
      -HALF + radius,
      HALF - radius,
    );
  }
}

export function solveSelfContacts(
  a: Actor,
  rig: BodyRig,
) {
  const scale = bodyScale(a);

  for (const [ia, ib] of SELF_PAIRS) {
    const dx = rig.x[ib]! - rig.x[ia]!;
    const dy = rig.y[ib]! - rig.y[ia]!;
    const dz = rig.z[ib]! - rig.z[ia]!;
    const min =
      (BASE_RADIUS[ia]! + BASE_RADIUS[ib]!) *
      scale *
      0.88;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= min * min || d2 < 1e-10) {
      continue;
    }

    const d = Math.sqrt(d2);
    const nx = dx / d;
    const ny = dy / d;
    const nz = dz / d;
    const pen = min - d;
    const wa = NODE_INV_MASS[ia]!;
    const wb = NODE_INV_MASS[ib]!;
    const sum = wa + wb;

    rig.x[ia] -= nx * pen * (wa / sum);
    rig.y[ia] -= ny * pen * (wa / sum);
    rig.z[ia] -= nz * pen * (wa / sum);
    rig.x[ib] += nx * pen * (wb / sum);
    rig.y[ib] += ny * pen * (wb / sum);
    rig.z[ib] += nz * pen * (wb / sum);
  }
}

export function supportHeight(
  w: World,
  x: number,
  y: number,
  z: number,
) {
  let h = 0;

  for (const c of w.colliders) {
    if (
      !c.solid ||
      c.water ||
      c.maxY > y + 0.45
    ) {
      continue;
    }
    if (
      x < c.minX - 0.2 ||
      x > c.maxX + 0.2 ||
      z < c.minZ - 0.2 ||
      z > c.maxZ + 0.2
    ) {
      continue;
    }
    h = Math.max(h, c.maxY);
  }

  return h;
}

function modeWeight(mode: BodyMode) {
  if (mode === "dynamic") return 1;
  if (mode === "stumble") return 0.62;
  if (mode === "recover") return 0.4;
  return 0;
}

export function solveBodyPair(
  w: World,
  a: Actor,
  ra: BodyRig,
  b: Actor,
  rb: BodyRig,
  dt: number,
  register: boolean,
) {
  const dxRoot =
    rb.x[BODY.pelvis]! - ra.x[BODY.pelvis]!;
  const dzRoot =
    rb.z[BODY.pelvis]! - ra.z[BODY.pelvis]!;

  if (
    dxRoot * dxRoot + dzRoot * dzRoot >
    3.4 * 3.4
  ) {
    return;
  }

  const modeA = modeWeight(ra.mode);
  const modeB = modeWeight(rb.mode);
  if (modeA + modeB <= 0) return;

  for (const ia of CONTACT_NODES) {
    for (const ib of CONTACT_NODES) {
      const dx = rb.x[ib]! - ra.x[ia]!;
      const dy = rb.y[ib]! - ra.y[ia]!;
      const dz = rb.z[ib]! - ra.z[ia]!;
      const min =
        nodeRadius(a, ia) + nodeRadius(b, ib);
      const d2 = dx * dx + dy * dy + dz * dz;

      if (d2 >= min * min || d2 < 1e-10) {
        continue;
      }

      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      const nz = dz / d;
      const pen = min - d + 0.001;
      const wa = NODE_INV_MASS[ia]! * modeA;
      const wb = NODE_INV_MASS[ib]! * modeB;
      const sum = wa + wb;
      if (sum <= 0) continue;

      ra.x[ia] -= nx * pen * (wa / sum);
      ra.y[ia] -= ny * pen * (wa / sum);
      ra.z[ia] -= nz * pen * (wa / sum);
      rb.x[ib] += nx * pen * (wb / sum);
      rb.y[ib] += ny * pen * (wb / sum);
      rb.z[ib] += nz * pen * (wb / sum);

      if (!register) continue;

      const avx = nodeVelocityComponent(
        ra.x[ia]!,
        ra.px[ia]!,
        dt,
      );
      const avy = nodeVelocityComponent(
        ra.y[ia]!,
        ra.py[ia]!,
        dt,
      );
      const avz = nodeVelocityComponent(
        ra.z[ia]!,
        ra.pz[ia]!,
        dt,
      );
      const bvx = nodeVelocityComponent(
        rb.x[ib]!,
        rb.px[ib]!,
        dt,
      );
      const bvy = nodeVelocityComponent(
        rb.y[ib]!,
        rb.py[ib]!,
        dt,
      );
      const bvz = nodeVelocityComponent(
        rb.z[ib]!,
        rb.pz[ib]!,
        dt,
      );
      const rel =
        (bvx - avx) * nx +
        (bvy - avy) * ny +
        (bvz - avz) * nz;

      if (rel >= 0) continue;

      const closing = -rel;
      const impact = assessPairNodeImpact(a, ia, b, ib, closing);
      const shareA = b.mass / Math.max(1, a.mass + b.mass);
      const shareB = a.mass / Math.max(1, a.mass + b.mass);
      if (modeA > 0) {
        applyBodyImpactDamage(w, a, ra, ia, impact);
        if (impact.damaging) {
          impactDynamics.contactNode(
            a,
            ia,
            -nx * closing * shareA * 0.38,
            -ny * closing * shareA * 0.38,
            -nz * closing * shareA * 0.38,
            0.7,
          );
        }
      }
      if (modeB > 0) {
        applyBodyImpactDamage(w, b, rb, ib, impact);
        if (impact.damaging) {
          impactDynamics.contactNode(
            b,
            ib,
            nx * closing * shareB * 0.38,
            ny * closing * shareB * 0.38,
            nz * closing * shareB * 0.38,
            0.7,
          );
        }
      }
    }
  }
}
