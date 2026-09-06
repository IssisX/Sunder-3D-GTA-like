import type { Actor, Region } from "./types";
import type { World } from "./world";
import type { PhysicalBodies } from "./body";
import {
  CONTACT_NODES,
  NODE_REGION,
  nodeRadius,
} from "./body-model";
import { applyBeastMeleeContact } from "./beast-melee-contact";
import { socialIncidents } from "./social-incident";

const ENTITY_CAP = 8192;
const WOLF_DURATION = 0.28;
const BEAR_DURATION = 0.4;
const OTHER_DURATION = 0.34;

export const EDGES = {
  spatialCarrier: true,
};

function predator(a: Actor) {
  return a.species === "wolf" || a.species === "bear";
}

function segmentPointDist2(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  px: number, py: number, pz: number,
) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const den = abx * abx + aby * aby + abz * abz;
  let t = den > 1e-9 ? (apx * abx + apy * aby + apz * abz) / den : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = ax + abx * t - px;
  const dy = ay + aby * t - py;
  const dz = az + abz * t - pz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Beast melee authority.
 *
 * Predators can still request an attack through their existing AI timer. A
 * prey/herd animal only gains attack authority when a real social incident has
 * marked it as a defender. Either way, consequences still require the visible
 * head carrier to sweep through a target body.
 */
export class BeastMeleeKinematics {
  private readonly active = new Uint8Array(ENTITY_CAP);
  private readonly time = new Float32Array(ENTITY_CAP);
  private readonly duration = new Float32Array(ENTITY_CAP);
  private readonly hitId = new Int32Array(ENTITY_CAP);
  private readonly prevX = new Float32Array(ENTITY_CAP);
  private readonly prevY = new Float32Array(ENTITY_CAP);
  private readonly prevZ = new Float32Array(ENTITY_CAP);
  private readonly hasPrev = new Uint8Array(ENTITY_CAP);
  private bodies: PhysicalBodies | null = null;

  bind(bodies: PhysicalBodies) {
    this.bodies = bodies;
  }

  bootstrap() {
    this.clear();
  }

  clear() {
    this.active.fill(0);
    this.time.fill(0);
    this.duration.fill(0);
    this.hitId.fill(-1);
    this.hasPrev.fill(0);
  }

  reset(a: Actor) {
    if (a.id < 0 || a.id >= ENTITY_CAP) return;
    this.active[a.id] = 0;
    this.time[a.id] = 0;
    this.duration[a.id] = 0;
    this.hitId[a.id] = -1;
    this.hasPrev[a.id] = 0;
  }

  step(w: World, dt: number) {
    for (let i = 0; i < w.actors.length; i++) {
      const a = w.actors[i]!;
      if (a.kind !== "beast" || a.id < 0 || a.id >= ENTITY_CAP) continue;
      const id = a.id;
      const incidentTargetId = socialIncidents.fightTarget(id);
      const incidentTarget = incidentTargetId ? w.actor(incidentTargetId) : null;
      const legacyIntent = predator(a) && a.strikeT > 0;
      let incidentIntent = false;
      if (incidentTarget?.alive && a.attackCd <= 0) {
        const dx = incidentTarget.x - a.x;
        const dz = incidentTarget.z - a.z;
        const reach = a.radius + incidentTarget.radius + (a.species === "cow" ? 1.0 : 0.72);
        incidentIntent = dx * dx + dz * dz <= reach * reach;
      }

      if (!this.active[id] && (legacyIntent || incidentIntent)) {
        this.active[id] = 1;
        this.time[id] = 0;
        this.duration[id] = a.species === "bear" ? BEAR_DURATION : a.species === "wolf" ? WOLF_DURATION : OTHER_DURATION;
        this.hitId[id] = -1;
        this.hasPrev[id] = 0;
        if (incidentIntent && incidentTarget) {
          a.targetId = incidentTarget.id;
          a.attackCd = a.species === "cow" ? 1.15 : 0.92;
        }
      }
      if (!this.active[id]) continue;
      a.strikeT = 0;

      this.time[id] += dt;
      const duration = Math.max(1e-5, this.duration[id]!);
      const u = this.time[id]! / duration;
      this.carrierPoint(a);
      const cx = this.cx, cy = this.cy, cz = this.cz;
      const radius = this.radius;

      if (!this.hasPrev[id]) {
        this.prevX[id] = cx;
        this.prevY[id] = cy;
        this.prevZ[id] = cz;
        this.hasPrev[id] = 1;
      } else {
        const px = this.prevX[id]!;
        const py = this.prevY[id]!;
        const pz = this.prevZ[id]!;
        this.prevX[id] = cx;
        this.prevY[id] = cy;
        this.prevZ[id] = cz;

        const contactActive = u >= 0.18 && u <= 0.82;
        if (EDGES.spatialCarrier && contactActive && this.hitId[id] < 0) {
          this.resolveSweep(w, a, px, py, pz, cx, cy, cz, radius, dt);
        }
      }

      if (u >= 1 || !a.alive) {
        this.active[id] = 0;
        this.time[id] = 0;
        this.duration[id] = 0;
        this.hasPrev[id] = 0;
      }
    }
  }

  private cx = 0;
  private cy = 0;
  private cz = 0;
  private radius = 0;

  private carrierPoint(a: Actor) {
    const forwardRatio =
      a.species === "bear" ? 1.65 :
      a.species === "wolf" ? 1.83 :
      a.species === "cow" ? 1.83 :
      a.species === "pig" ? 1.74 :
      a.species === "goat" ? 1.28 : 1.98;
    const heightRatio =
      a.species === "bear" ? 0.54 :
      a.species === "wolf" ? 0.595 :
      a.species === "cow" ? 0.596 :
      a.species === "pig" ? 0.62 :
      a.species === "goat" ? 0.713 : 0.557;
    const forward = a.radius * forwardRatio;
    const height = a.height * heightRatio;
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    this.cx = a.x + fx * forward;
    this.cy = a.y + height;
    this.cz = a.z + fz * forward;
    this.radius = a.radius * (predator(a) || a.species === "cow" ? 0.72 : 0.58);
  }

  private resolveSweep(
    w: World,
    atk: Actor,
    px: number, py: number, pz: number,
    cx: number, cy: number, cz: number,
    radius: number,
    dt: number,
  ) {
    let best: Actor | null = null;
    let bestNode = -1;
    let bestRegion: Region = "torso";
    let bestD2 = Infinity;

    for (let i = 0; i < w.actors.length; i++) {
      const o = w.actors[i]!;
      if (!o.alive || o.id === atk.id) continue;
      const rig = this.bodies?.get(o);
      if (rig?.initialized) {
        for (let j = 0; j < CONTACT_NODES.length; j++) {
          const node = CONTACT_NODES[j]!;
          const rr = radius + nodeRadius(o, node);
          const d2 = segmentPointDist2(
            px, py, pz, cx, cy, cz,
            rig.x[node]!, rig.y[node]!, rig.z[node]!,
          );
          if (d2 <= rr * rr && d2 < bestD2) {
            best = o;
            bestNode = node;
            bestRegion = NODE_REGION[node]!;
            bestD2 = d2;
          }
        }
      } else {
        const tx = o.x;
        const ty = o.y + o.height * 0.5;
        const tz = o.z;
        const rr = radius + Math.max(o.radius, o.height * 0.28);
        const d2 = segmentPointDist2(px, py, pz, cx, cy, cz, tx, ty, tz);
        if (d2 <= rr * rr && d2 < bestD2) {
          best = o;
          bestNode = -1;
          bestRegion = "torso";
          bestD2 = d2;
        }
      }
    }

    if (!best) return;
    const invDt = 1 / Math.max(1e-5, dt);
    const vx = (cx - px) * invDt - best.vx;
    const vy = (cy - py) * invDt - best.vy;
    const vz = (cz - pz) * invDt - best.vz;
    const speed = Math.hypot(vx, vy, vz);
    const rig = this.bodies?.get(best);
    applyBeastMeleeContact(
      w,
      atk,
      best,
      bestRegion,
      bestNode,
      rig,
      speed,
      vx,
      vy,
      vz,
    );
    this.hitId[atk.id] = best.id;
  }
}

export const beastMelee = new BeastMeleeKinematics();
