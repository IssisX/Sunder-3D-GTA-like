import type { Actor } from "./types";
import type { World } from "./world";
import {
  NODE_INV_MASS,
  NODE_REGION,
  type BodyRig,
} from "./body-model";

export const EDGES = {
  damageThreshold: true,
};

const DAMAGE_ENERGY_J = 22;
const DAMAGE_IMPULSE_NS = 24;
const NODE_MASS_WEIGHT_SUM = NODE_INV_MASS.reduce(
  (sum, invMass) => sum + 1 / invMass,
  0,
);

export interface ImpactMeasure {
  closingSpeed: number;
  effectiveMass: number;
  impulse: number;
  kineticEnergy: number;
  damaging: boolean;
  damageScale: number;
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function nodeEffectiveMass(a: Actor, node: number) {
  const weight = 1 / NODE_INV_MASS[node]!;
  return Math.max(0.25, a.mass * weight / NODE_MASS_WEIGHT_SUM);
}

export function reducedEffectiveMass(a: number, b: number) {
  const ma = Math.max(0.05, a);
  const mb = Math.max(0.05, b);
  return (ma * mb) / (ma + mb);
}

export function assessImpact(
  effectiveMass: number,
  closingSpeed: number,
  restitution = 0.08,
): ImpactMeasure {
  const mass = Math.max(0.05, effectiveMass);
  const speed = Math.max(0, closingSpeed);
  const bounce = clamp(restitution, 0, 0.6);
  const impulse = mass * speed * (1 + bounce);
  const kineticEnergy = 0.5 * mass * speed * speed;
  const ratio = Math.max(
    kineticEnergy / DAMAGE_ENERGY_J,
    impulse / DAMAGE_IMPULSE_NS,
  );
  const damaging = EDGES.damageThreshold ? ratio > 1 : speed > 0;
  const damageScale = damaging
    ? clamp(0.08 + Math.max(0, ratio - 1) * 0.75, 0.08, 1.4)
    : 0;

  return {
    closingSpeed: speed,
    effectiveMass: mass,
    impulse,
    kineticEnergy,
    damaging,
    damageScale,
  };
}

export function assessStaticNodeImpact(
  a: Actor,
  node: number,
  closingSpeed: number,
  restitution = 0.08,
) {
  return assessImpact(
    nodeEffectiveMass(a, node),
    closingSpeed,
    restitution,
  );
}

export function assessPairNodeImpact(
  a: Actor,
  nodeA: number,
  b: Actor,
  nodeB: number,
  closingSpeed: number,
  restitution = 0.04,
) {
  return assessImpact(
    reducedEffectiveMass(
      nodeEffectiveMass(a, nodeA),
      nodeEffectiveMass(b, nodeB),
    ),
    closingSpeed,
    restitution,
  );
}

export function applyBodyImpactDamage(
  w: World,
  a: Actor,
  rig: BodyRig,
  node: number,
  impact: ImpactMeasure,
) {
  if (
    !a.alive ||
    !impact.damaging ||
    rig.impactCd[node]! > 0
  ) {
    return false;
  }

  const region = NODE_REGION[node]!;
  const severity = impact.damageScale;
  const inj = a.injuries[region];
  inj.bruise += severity * 0.36;

  if (
    region === "larm" ||
    region === "rarm" ||
    region === "lleg" ||
    region === "rleg"
  ) {
    if (
      impact.kineticEnergy > 48 ||
      impact.impulse > 30
    ) {
      inj.sprain += severity * 0.1;
    }
    if (
      impact.kineticEnergy > 120 ||
      impact.impulse > 52
    ) {
      inj.fracture += severity * 0.08;
    }
  } else if (region === "head") {
    a.consciousness = Math.max(
      0,
      a.consciousness - severity * 0.16,
    );
    if (
      impact.kineticEnergy > 95 ||
      impact.impulse > 45
    ) {
      inj.fracture += severity * 0.06;
    }
  } else if (
    impact.kineticEnergy > 155 ||
    impact.impulse > 58
  ) {
    inj.fracture += severity * 0.04;
  }

  a.pain = clamp(a.pain + severity * 0.18, 0, 1);
  a.balance = clamp(a.balance - severity * 0.28, 0, 1);

  if (
    (impact.kineticEnergy > 70 || impact.impulse > 36) &&
    a.loco !== "ragdoll" &&
    a.loco !== "down"
  ) {
    const severe =
      impact.kineticEnergy > 135 ||
      impact.impulse > 52 ||
      (region === "head" && impact.kineticEnergy > 90);
    a.loco = severe ? "ragdoll" : "stumble";
    a.locoT = Math.max(
      a.locoT,
      0.45 + severity * 0.35,
    );
  }

  rig.impactCd[node] = 0.16;
  w.emitSound(
    a.x,
    a.z,
    0.3 + Math.min(0.7, severity * 0.45),
    "impact",
    a.id,
  );
  if (severity > 0.2) {
    w.emitSound(
      a.x,
      a.z,
      0.24 + severity * 0.2,
      "hurt",
      a.id,
    );
  }
  w.shake = Math.max(
    w.shake,
    Math.min(0.5, severity * 0.24),
  );
  return true;
}
