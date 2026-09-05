import type { Actor, Region } from "./types";
import type { World } from "./world";
import type { BodyRig } from "./body";
import { impactDynamics } from "./impact-dynamics";
import {
  applyBodyImpactDamage,
  assessImpact,
  nodeEffectiveMass,
  reducedEffectiveMass,
} from "./impact-mediation";

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function strikingMass(a: Actor) {
  return a.species === "bear"
    ? clamp(a.mass * 0.16, 28, 48)
    : clamp(a.mass * 0.18, 5, 9);
}

/**
 * Consequence layer for a beast carrier that already intersected a real body.
 * Contact always transfers momentum. Injury exists only above the common
 * impact-energy/impulse threshold.
 */
export function applyBeastMeleeContact(
  w: World,
  atk: Actor,
  vic: Actor,
  region: Region,
  node: number,
  rig: BodyRig | undefined,
  speed: number,
  dirX: number,
  dirY: number,
  dirZ: number,
) {
  if (!atk.alive || !vic.alive || atk.id === vic.id) return false;

  let m = Math.hypot(dirX, dirY, dirZ);
  if (m < 1e-6) {
    dirX = -Math.sin(atk.yaw);
    dirY = 0;
    dirZ = -Math.cos(atk.yaw);
    m = 1;
  }
  const nx = dirX / m;
  const ny = dirY / m;
  const nz = dirZ / m;
  const attackerMass = strikingMass(atk);
  const targetMass = rig && node >= 0
    ? nodeEffectiveMass(vic, node)
    : Math.max(1, vic.mass * 0.2);
  const impact = assessImpact(
    reducedEffectiveMass(attackerMass, targetMass),
    Math.max(0, speed),
    0.04,
  );

  // Momentum transfer exists even below the damage threshold. This is the
  // physical bump; damage is a separate downstream decision.
  const victimDv = Math.min(5.5, impact.impulse / Math.max(8, vic.mass) * 1.35);
  vic.vx += nx * victimDv;
  vic.vy += ny * victimDv;
  vic.vz += nz * victimDv;
  const recoilDv = Math.min(1.8, impact.impulse / Math.max(20, atk.mass) * 0.55);
  atk.vx -= nx * recoilDv;
  atk.vy -= ny * recoilDv * 0.25;
  atk.vz -= nz * recoilDv;

  if (rig && node >= 0) {
    impactDynamics.contactNode(
      vic,
      node,
      nx * victimDv,
      ny * victimDv,
      nz * victimDv,
      atk.species === "bear" ? 1.15 : 0.9,
    );
  }

  if (impact.damaging) {
    if (rig && node >= 0) {
      applyBodyImpactDamage(w, vic, rig, node, impact);
    } else {
      const inj = vic.injuries[region];
      const severity = impact.damageScale;
      inj.bruise += severity * (atk.species === "bear" ? 0.48 : 0.22);
      vic.pain = clamp(vic.pain + severity * 0.16, 0, 1);
      vic.balance = clamp(vic.balance - severity * 0.32, 0, 1);
      if (impact.kineticEnergy > 80 || impact.impulse > 38) {
        vic.loco = "stumble";
        vic.locoT = Math.max(vic.locoT, 0.45 + severity * 0.25);
      }
      w.emitSound(vic.x, vic.z, 0.3 + Math.min(0.6, severity * 0.4), "impact", atk.id);
    }

    if (atk.species === "wolf") {
      const inj = vic.injuries[region];
      inj.puncture += 0.08 + impact.damageScale * 0.12;
      vic.bleed += 0.018 + impact.damageScale * 0.035;
    }
  }

  // Awareness follows real spatial contact, not attack intent.
  vic.lastHitBy = atk.id;
  vic.lastHitT = w.time;
  vic.alert = 1;
  if (vic.kind !== "player" && !vic.known.includes(atk.id)) vic.known.push(atk.id);
  return impact.damaging;
}
