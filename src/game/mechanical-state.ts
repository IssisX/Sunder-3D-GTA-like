import type { Actor } from "./types";
import type { World } from "./world";
import { clamp, injurySum } from "./world";
import {
  BODY,
  bodyScale,
  nodeRadius,
  nodeVelocityComponent,
  type BodyRig,
} from "./body-model";
import { supportHeight } from "./body-contacts";
import { impactDynamics } from "./impact-dynamics";

export interface MechanicalState {
  comX: number;
  comY: number;
  comZ: number;
  velX: number;
  velY: number;
  velZ: number;
  momentumX: number;
  momentumY: number;
  momentumZ: number;
  angularX: number;
  angularY: number;
  angularZ: number;
  leftSupported: boolean;
  rightSupported: boolean;
  supportCount: number;
  supportMargin: number;
  supportScore: number;
  grip: number;
  upright: number;
  legIntegrity: number;
  consciousness: number;
  disturbance: number;
}

export function makeMechanicalState(): MechanicalState {
  return {
    comX: 0,
    comY: 0,
    comZ: 0,
    velX: 0,
    velY: 0,
    velZ: 0,
    momentumX: 0,
    momentumY: 0,
    momentumZ: 0,
    angularX: 0,
    angularY: 0,
    angularZ: 0,
    leftSupported: false,
    rightSupported: false,
    supportCount: 0,
    supportMargin: -1,
    supportScore: 0,
    grip: 1,
    upright: 0,
    legIntegrity: 1,
    consciousness: 1,
    disturbance: 0,
  };
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function distanceToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
) {
  const abx = bx - ax;
  const abz = bz - az;
  const den = abx * abx + abz * abz;
  let t = den > 1e-9 ? ((px - ax) * abx + (pz - az) * abz) / den : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + abx * t);
  const dz = pz - (az + abz * t);
  return Math.hypot(dx, dz);
}

/**
 * Zero-allocation observation of the authoritative articulated body.
 * Higher-level controllers consume this state; they do not manufacture a
 * parallel pose or collision authority.
 */
export function sampleMechanicalState(
  w: World,
  a: Actor,
  rig: BodyRig,
  dt: number,
  out: MechanicalState,
) {
  const h = Math.max(1e-5, dt);
  const scale = bodyScale(a);

  const px = rig.x[BODY.pelvis]!;
  const py = rig.y[BODY.pelvis]!;
  const pz = rig.z[BODY.pelvis]!;
  const cx = rig.x[BODY.chest]!;
  const cy = rig.y[BODY.chest]!;
  const cz = rig.z[BODY.chest]!;
  const hx = rig.x[BODY.head]!;
  const hy = rig.y[BODY.head]!;
  const hz = rig.z[BODY.head]!;

  out.comX = px * 0.5 + cx * 0.34 + hx * 0.16;
  out.comY = py * 0.5 + cy * 0.34 + hy * 0.16;
  out.comZ = pz * 0.5 + cz * 0.34 + hz * 0.16;

  const pvx = nodeVelocityComponent(px, rig.px[BODY.pelvis]!, h);
  const pvy = nodeVelocityComponent(py, rig.py[BODY.pelvis]!, h);
  const pvz = nodeVelocityComponent(pz, rig.pz[BODY.pelvis]!, h);
  const cvx = nodeVelocityComponent(cx, rig.px[BODY.chest]!, h);
  const cvy = nodeVelocityComponent(cy, rig.py[BODY.chest]!, h);
  const cvz = nodeVelocityComponent(cz, rig.pz[BODY.chest]!, h);
  const hvx = nodeVelocityComponent(hx, rig.px[BODY.head]!, h);
  const hvy = nodeVelocityComponent(hy, rig.py[BODY.head]!, h);
  const hvz = nodeVelocityComponent(hz, rig.pz[BODY.head]!, h);

  out.velX = pvx * 0.5 + cvx * 0.34 + hvx * 0.16;
  out.velY = pvy * 0.5 + cvy * 0.34 + hvy * 0.16;
  out.velZ = pvz * 0.5 + cvz * 0.34 + hvz * 0.16;
  out.momentumX = out.velX * a.mass;
  out.momentumY = out.velY * a.mass;
  out.momentumZ = out.velZ * a.mass;

  // Compact centroidal angular-momentum proxy from upper-body mass about the
  // pelvis. Exact inverse dynamics is unnecessary at this scale; this captures
  // the mechanical signal needed for disturbance/recovery decisions.
  const crx = cx - px;
  const cry = cy - py;
  const crz = cz - pz;
  const hrx = hx - px;
  const hry = hy - py;
  const hrz = hz - pz;
  const cMass = a.mass * 0.34;
  const hMass = a.mass * 0.16;
  out.angularX =
    (cry * (cvz - pvz) - crz * (cvy - pvy)) * cMass +
    (hry * (hvz - pvz) - hrz * (hvy - pvy)) * hMass;
  out.angularY =
    (crz * (cvx - pvx) - crx * (cvz - pvz)) * cMass +
    (hrz * (hvx - pvx) - hrx * (hvz - pvz)) * hMass;
  out.angularZ =
    (crx * (cvy - pvy) - cry * (cvx - pvx)) * cMass +
    (hrx * (hvy - pvy) - hry * (hvx - pvx)) * hMass;

  const lfx = rig.x[BODY.lFoot]!;
  const lfy = rig.y[BODY.lFoot]!;
  const lfz = rig.z[BODY.lFoot]!;
  const rfx = rig.x[BODY.rFoot]!;
  const rfy = rig.y[BODY.rFoot]!;
  const rfz = rig.z[BODY.rFoot]!;
  const lh = supportHeight(w, lfx, lfy, lfz);
  const rh = supportHeight(w, rfx, rfy, rfz);
  const lBottom = lfy - nodeRadius(a, BODY.lFoot);
  const rBottom = rfy - nodeRadius(a, BODY.rFoot);
  out.leftSupported = Math.abs(lBottom - lh) <= 0.085 * scale;
  out.rightSupported = Math.abs(rBottom - rh) <= 0.085 * scale;

  let supportDistance = 1;
  let supportRadius = 0.18 * scale;
  if (out.leftSupported && out.rightSupported) {
    out.supportCount = 2;
    supportDistance = distanceToSegment(out.comX, out.comZ, lfx, lfz, rfx, rfz);
    supportRadius = 0.19 * scale;
  } else if (out.leftSupported) {
    out.supportCount = 1;
    supportDistance = Math.hypot(out.comX - lfx, out.comZ - lfz);
    supportRadius = 0.25 * scale;
  } else if (out.rightSupported) {
    out.supportCount = 1;
    supportDistance = Math.hypot(out.comX - rfx, out.comZ - rfz);
    supportRadius = 0.25 * scale;
  } else {
    out.supportCount = 0;
  }

  out.supportMargin = supportRadius - supportDistance;

  // Existing environmental fields now participate in actual support authority.
  // Oil is dominant; wetness also reduces available friction but less severely.
  let grip = 1;
  if (out.leftSupported) {
    const cell = w.cell(lfx, lfz);
    grip = Math.min(grip, clamp(1 - w.oil[cell]! * 0.62 - w.wet[cell]! * 0.18, 0.18, 1));
  }
  if (out.rightSupported) {
    const cell = w.cell(rfx, rfz);
    grip = Math.min(grip, clamp(1 - w.oil[cell]! * 0.62 - w.wet[cell]! * 0.18, 0.18, 1));
  }
  out.grip = grip;
  out.supportScore = out.supportCount
    ? clamp01((out.supportMargin + 0.07 * scale) / (0.28 * scale)) * grip
    : 0;

  const rise = cy - py;
  const torsoLean = Math.hypot(cx - px, cz - pz);
  out.upright =
    clamp01((rise - 0.11 * scale) / (0.31 * scale)) *
    clamp01(1 - torsoLean / (0.72 * scale));

  const leftDamage = injurySum(a.injuries.lleg);
  const rightDamage = injurySum(a.injuries.rleg);
  out.legIntegrity = 1 / (1 + 0.42 * (leftDamage + rightDamage));
  out.consciousness = clamp01((a.consciousness - 0.12) / 0.88);
  out.disturbance = impactDynamics.disturbance(a);
}
