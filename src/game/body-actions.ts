import type { Actions } from "./input";
import type { Actor, Prop } from "./types";
import type { World } from "./world";
import { clamp, facing, rightOf } from "./world";
import {
  BODY,
  PhysicalBodies,
  type BodyRig,
} from "./body";

type GrabPhase =
  | "idle"
  | "reach"
  | "hold"
  | "release"
  | "recover";

type RecoverFrom = "reach" | "release";

interface Point3 {
  x: number;
  y: number;
  z: number;
}

interface GrabTarget {
  id: number;
  actor: boolean;
}

interface GrabMotion {
  phase: GrabPhase;
  t: number;
  lastGrabbedId: number;
  recoverFrom: RecoverFrom;
  contactIssued: boolean;
  releaseQueued: boolean;
  targetId: number;
  targetActor: boolean;
  targetNode: number;
  lastContactX: number;
  lastContactY: number;
  lastContactZ: number;
}

// No hidden anticipation. Motion begins on the input edge, then the hand must
// physically travel to the target before the gameplay grab edge is released.
const REACH_T = 0.2;
const RELEASE_T = 0.18;
const RECOVER_T = 0.24;
const CONTACT_RADIUS = 0.18;
const UPPER_ARM = 0.294;
const LOWER_ARM = 0.262;

const CONTACT_NODES = [
  BODY.chest,
  BODY.lShoulder,
  BODY.rShoulder,
  BODY.lElbow,
  BODY.rElbow,
  BODY.pelvis,
] as const;

function smooth01(v: number) {
  const t = clamp(v, 0, 1);
  return t * t * (3 - 2 * t);
}

function easeOut(v: number) {
  const t = clamp(v, 0, 1);
  const u = 1 - t;
  return 1 - u * u * u;
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function mixPoint(a: Point3, b: Point3, t: number): Point3 {
  return {
    x: mix(a.x, b.x, t),
    y: mix(a.y, b.y, t),
    z: mix(a.z, b.z, t),
  };
}

function distance(a: Point3, b: Point3) {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

function isHuman(a: Actor) {
  return a.species === "human" || a.kind === "player";
}

function canPose(a: Actor) {
  return (
    a.alive &&
    a.loco !== "ragdoll" &&
    a.loco !== "down" &&
    a.loco !== "getup"
  );
}

function makeMotion(): GrabMotion {
  return {
    phase: "idle",
    t: 0,
    lastGrabbedId: 0,
    recoverFrom: "reach",
    contactIssued: false,
    releaseQueued: false,
    targetId: 0,
    targetActor: false,
    targetNode: -1,
    lastContactX: 0,
    lastContactY: 0,
    lastContactZ: 0,
  };
}

function localPoint(
  a: Actor,
  lx: number,
  ly: number,
  lz: number,
): Point3 {
  const scale = a.height / 1.72;
  const f = facing(a.yaw);
  const r = rightOf(a.yaw);
  return {
    x: a.x + r.x * lx * scale + f.x * lz * scale,
    y: a.y + ly * scale,
    z: a.z + r.z * lx * scale + f.z * lz * scale,
  };
}

function setNodeWorld(
  rig: BodyRig,
  node: number,
  p: Point3,
  strength: number,
) {
  if (strength <= 0) return;
  rig.x[node] += (p.x - rig.x[node]!) * strength;
  rig.y[node] += (p.y - rig.y[node]!) * strength;
  rig.z[node] += (p.z - rig.z[node]!) * strength;
}

function setLocalNode(
  a: Actor,
  rig: BodyRig,
  node: number,
  lx: number,
  ly: number,
  lz: number,
  strength: number,
) {
  setNodeWorld(rig, node, localPoint(a, lx, ly, lz), strength);
}

function nodePoint(rig: BodyRig, node: number): Point3 {
  return {
    x: rig.x[node]!,
    y: rig.y[node]!,
    z: rig.z[node]!,
  };
}

// Mirrors the gameplay grab candidate rules so the visible reach aims at the
// same thing the authoritative grab mechanic will attempt to latch.
function findGrabTarget(w: World, p: Actor): GrabTarget | null {
  const f = facing(p.yaw);
  let best: GrabTarget | null = null;
  let bestD = 1.7;

  for (const o of w.nearby(p.x, p.z, 1.8)) {
    if (o.id === p.id) continue;
    const dx = o.x - p.x;
    const dz = o.z - p.z;
    const d = Math.hypot(dx, dz);
    const dot = (dx * f.x + dz * f.z) / (d || 1);
    if (dot < 0.1 || d >= bestD) continue;
    bestD = d;
    best = { id: o.id, actor: true };
  }

  for (const pr of w.props) {
    if (pr.anchored && pr.mass > 40 && !pr.dynamic) continue;
    if (pr.kind === "wall" || pr.kind === "roof") continue;
    const dx = pr.x - p.x;
    const dz = pr.z - p.z;
    const d = Math.hypot(dx, dz);
    const dot = (dx * f.x + dz * f.z) / (d || 1);
    if (dot < 0.05 || d > 1.7 || d >= bestD) continue;
    bestD = d;
    best = { id: pr.id, actor: false };
  }

  return best;
}

function chooseTargetNode(
  holder: Actor,
  holderRig: BodyRig,
  targetRig: BodyRig,
) {
  const f = facing(holder.yaw);
  const reference = {
    x: holderRig.x[BODY.rHand]! + f.x * 0.45,
    y: holderRig.y[BODY.rHand]! + 0.08,
    z: holderRig.z[BODY.rHand]! + f.z * 0.45,
  };
  let best = BODY.chest as number;
  let bestD = Infinity;

  for (const node of CONTACT_NODES) {
    const dx = targetRig.x[node]! - reference.x;
    const dy = targetRig.y[node]! - reference.y;
    const dz = targetRig.z[node]! - reference.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD) {
      bestD = d2;
      best = node;
    }
  }
  return best;
}

function targetPoint(
  w: World,
  bodies: PhysicalBodies,
  holder: Actor,
  holderRig: BodyRig,
  motion: GrabMotion,
): Point3 | null {
  const id = holder.grabbedId || motion.targetId;
  if (!id) return null;

  const target = w.actor(id);
  if (target) {
    const targetRig = bodies.get(target);
    if (targetRig?.initialized) {
      if (motion.targetNode < 0) {
        motion.targetNode = chooseTargetNode(
          holder,
          holderRig,
          targetRig,
        );
      }
      const node = motion.targetNode >= 0
        ? motion.targetNode
        : BODY.chest;
      return nodePoint(targetRig, node);
    }
    return {
      x: target.x,
      y: target.y + target.height * 0.62,
      z: target.z,
    };
  }

  const pr = w.prop(id);
  if (pr) {
    return {
      x: pr.x,
      y: pr.y + clamp(pr.sy * 0.28, 0.05, 0.38),
      z: pr.z,
    };
  }
  return null;
}

function targetMass(w: World, motion: GrabMotion, holder: Actor) {
  const id = holder.grabbedId || motion.targetId;
  if (!id) return 0;
  const a = w.actor(id);
  if (a) return a.mass;
  return w.prop(id)?.mass ?? 0;
}

function targetIsActor(w: World, motion: GrabMotion, holder: Actor) {
  const id = holder.grabbedId || motion.targetId;
  return Boolean(id && w.actor(id));
}

function solveArmIK(
  a: Actor,
  rig: BodyRig,
  side: "left" | "right",
  desiredHand: Point3,
  strength: number,
) {
  if (strength <= 0) return;
  const scale = a.height / 1.72;
  const shoulderNode = side === "right" ? BODY.rShoulder : BODY.lShoulder;
  const elbowNode = side === "right" ? BODY.rElbow : BODY.lElbow;
  const handNode = side === "right" ? BODY.rHand : BODY.lHand;
  const shoulder = nodePoint(rig, shoulderNode);
  const upper = UPPER_ARM * scale;
  const lower = LOWER_ARM * scale;

  let dx = desiredHand.x - shoulder.x;
  let dy = desiredHand.y - shoulder.y;
  let dz = desiredHand.z - shoulder.z;
  let d = Math.hypot(dx, dy, dz);
  if (d < 1e-5) return;

  const minReach = Math.abs(upper - lower) + 0.018 * scale;
  const maxReach = (upper + lower) * 0.985;
  const reach = clamp(d, minReach, maxReach);
  dx /= d;
  dy /= d;
  dz /= d;

  const hand = {
    x: shoulder.x + dx * reach,
    y: shoulder.y + dy * reach,
    z: shoulder.z + dz * reach,
  };

  const along =
    (upper * upper - lower * lower + reach * reach) /
    (2 * reach);
  const bendRadius = Math.sqrt(
    Math.max(0, upper * upper - along * along),
  );

  const r = rightOf(a.yaw);
  const f = facing(a.yaw);
  const sign = side === "right" ? 1 : -1;
  let px = r.x * sign * 0.9 - f.x * 0.12;
  let py = -0.36;
  let pz = r.z * sign * 0.9 - f.z * 0.12;
  const poleDot = px * dx + py * dy + pz * dz;
  px -= dx * poleDot;
  py -= dy * poleDot;
  pz -= dz * poleDot;
  let poleLen = Math.hypot(px, py, pz);
  if (poleLen < 1e-5) {
    px = r.x * sign;
    py = 0;
    pz = r.z * sign;
    poleLen = Math.hypot(px, pz) || 1;
  }
  px /= poleLen;
  py /= poleLen;
  pz /= poleLen;

  const elbow = {
    x: shoulder.x + dx * along + px * bendRadius,
    y: shoulder.y + dy * along + py * bendRadius,
    z: shoulder.z + dz * along + pz * bendRadius,
  };

  setNodeWorld(rig, elbowNode, elbow, strength);
  setNodeWorld(rig, handNode, hand, strength);
}

function wholeBodyPose(
  a: Actor,
  rig: BodyRig,
  phase: GrabPhase,
  phaseWeight: number,
  load: number,
  target: Point3,
) {
  const scale = a.height / 1.72;
  const targetLocalY = (target.y - a.y) / Math.max(0.001, scale);
  const lowReach = clamp((1.02 - targetLocalY) / 0.72, 0, 1);
  const f = facing(a.yaw);
  const forwardSpeed = a.vx * f.x + a.vz * f.z;
  const dragBack = clamp(-forwardSpeed / 3.2, 0, 1);

  let chestY = 1.2;
  let chestZ = 0;
  let pelvisY = 0.82;
  let pelvisZ = 0;
  let kneeY = 0.42;
  let kneeZ = 0;
  let rShoulderZ = 0;
  let lShoulderZ = 0;

  if (phase === "reach") {
    chestY -= lowReach * 0.11 * phaseWeight;
    pelvisY -= lowReach * 0.07 * phaseWeight;
    kneeY -= lowReach * 0.06 * phaseWeight;
    kneeZ += lowReach * 0.1 * phaseWeight;
    chestZ += 0.11 * phaseWeight + lowReach * 0.04 * phaseWeight;
    pelvisZ -= 0.025 * phaseWeight;
    rShoulderZ += 0.12 * phaseWeight;
    lShoulderZ -= 0.035 * phaseWeight;
  } else if (phase === "hold") {
    chestY -= 0.035 + load * 0.07;
    pelvisY -= load * 0.055;
    kneeY -= 0.035 + load * 0.065;
    kneeZ += 0.045 + load * 0.065;
    chestZ += 0.025 - load * (0.075 + dragBack * 0.06);
    pelvisZ += load * 0.035;
    rShoulderZ += 0.055;
    lShoulderZ += 0.035;
  } else if (phase === "release") {
    chestZ += 0.14 * phaseWeight;
    pelvisZ -= 0.045 * phaseWeight;
    rShoulderZ += 0.16 * phaseWeight;
    lShoulderZ += 0.07 * phaseWeight;
  } else if (phase === "recover") {
    chestZ += 0.1 * phaseWeight;
    pelvisZ -= 0.025 * phaseWeight;
    rShoulderZ += 0.1 * phaseWeight;
    lShoulderZ += 0.035 * phaseWeight;
  }

  const strength = phase === "hold" ? 0.7 : 0.78 * phaseWeight;
  setLocalNode(a, rig, BODY.chest, 0, chestY, chestZ, strength);
  setLocalNode(a, rig, BODY.pelvis, 0, pelvisY, pelvisZ, strength * 0.55);
  setLocalNode(a, rig, BODY.rShoulder, 0.255, chestY + 0.1, rShoulderZ, strength * 0.8);
  setLocalNode(a, rig, BODY.lShoulder, -0.255, chestY + 0.1, lShoulderZ, strength * 0.62);
  setLocalNode(a, rig, BODY.rHip, 0.14, pelvisY - 0.06, pelvisZ, strength * 0.38);
  setLocalNode(a, rig, BODY.lHip, -0.14, pelvisY - 0.06, pelvisZ, strength * 0.38);
  setLocalNode(a, rig, BODY.rKnee, 0.14, kneeY, kneeZ, strength * 0.38);
  setLocalNode(a, rig, BODY.lKnee, -0.14, kneeY, kneeZ, strength * 0.38);
}

function secondaryHandTarget(
  a: Actor,
  target: Point3,
  holdAnchor: Point3,
  actorTarget: boolean,
  phase: GrabPhase,
  q: number,
): Point3 {
  const scale = a.height / 1.72;
  const r = rightOf(a.yaw);
  if (phase === "hold") {
    return {
      x: holdAnchor.x - r.x * 0.22 * scale,
      y: holdAnchor.y + 0.035 * scale,
      z: holdAnchor.z - r.z * 0.22 * scale,
    };
  }
  const offset = actorTarget ? 0.2 : 0.14;
  return {
    x: target.x - r.x * offset * scale * q,
    y: target.y - 0.035 * scale,
    z: target.z - r.z * offset * scale * q,
  };
}

function applyGrabPose(
  w: World,
  bodies: PhysicalBodies,
  a: Actor,
  rig: BodyRig,
  motion: GrabMotion,
) {
  if (!canPose(a) || motion.phase === "idle") return;

  const scale = a.height / 1.72;
  const actorTarget = targetIsActor(w, motion, a);
  const mass = targetMass(w, motion, a);
  const load = clamp((a.carry || mass * 0.45) / 72, 0, 1);
  const liveTarget = targetPoint(w, bodies, a, rig, motion);
  const fallback = localPoint(a, 0.08, 1.03, 0.78);
  const target = liveTarget ?? fallback;

  let weight = 1;
  let rightTarget = target;
  let supportWeight = 0;

  if (motion.phase === "reach") {
    const q = easeOut(motion.t / REACH_T);
    const natural = nodePoint(rig, BODY.rHand);
    rightTarget = mixPoint(natural, target, q);
    weight = q;
    supportWeight = (actorTarget || mass > 20)
      ? clamp((q - 0.42) / 0.58, 0, 1) * 0.76
      : q * 0.14;
  } else if (motion.phase === "hold") {
    const settle = smooth01(motion.t / 0.16);
    const contact = {
      x: motion.lastContactX || target.x,
      y: motion.lastContactY || target.y,
      z: motion.lastContactZ || target.z,
    };
    const holdAnchor = localPoint(
      a,
      0.11,
      1.0 - load * 0.09,
      0.47 - load * 0.07,
    );
    rightTarget = mixPoint(contact, holdAnchor, settle);
    supportWeight = actorTarget || mass > 20 ? 0.94 : 0.35;
  } else if (motion.phase === "release") {
    const q = smooth01(motion.t / RELEASE_T);
    const from = localPoint(
      a,
      0.11,
      1.0 - load * 0.05,
      0.46,
    );
    const followThrough = localPoint(a, 0.08, 1.1, 0.93);
    rightTarget = mixPoint(from, followThrough, q);
    supportWeight = (1 - q) * (actorTarget ? 0.65 : 0.25);
    weight = 1;
  } else {
    const q = 1 - smooth01(motion.t / RECOVER_T);
    rightTarget = localPoint(a, 0.08, 1.08, 0.86);
    supportWeight = q * 0.35;
    weight = q;
  }

  wholeBodyPose(a, rig, motion.phase, weight, load, target);
  solveArmIK(a, rig, "right", rightTarget, 0.98 * weight);

  if (supportWeight > 0.01) {
    const holdAnchor = localPoint(
      a,
      -0.08,
      1.0 - load * 0.07,
      0.43 - load * 0.04,
    );
    const leftTarget = secondaryHandTarget(
      a,
      target,
      holdAnchor,
      actorTarget,
      motion.phase,
      weight,
    );
    solveArmIK(
      a,
      rig,
      "left",
      leftTarget,
      supportWeight * weight,
    );
  }

  // Keep the contact position available after the target is released so the
  // throw follow-through does not snap back to an unrelated point.
  if (motion.phase === "reach" || motion.phase === "hold") {
    motion.lastContactX = rightTarget.x;
    motion.lastContactY = rightTarget.y;
    motion.lastContactZ = rightTarget.z;
  }

  // The physical hand remains authoritative. Props are projected from it by
  // BodyView; grabbed actors are constrained to it by PhysicalBodies.
  void scale;
}

function advancePassive(
  motion: GrabMotion,
  dt: number,
  holding: boolean,
) {
  if (motion.phase === "idle") return;
  motion.t += dt;

  if (motion.phase === "reach" && motion.t >= REACH_T) {
    if (holding) {
      motion.phase = "hold";
      motion.t = 0;
    } else {
      motion.phase = "recover";
      motion.t = 0;
      motion.recoverFrom = "reach";
    }
  } else if (motion.phase === "release" && motion.t >= RELEASE_T) {
    motion.phase = "recover";
    motion.t = 0;
    motion.recoverFrom = "release";
  } else if (motion.phase === "recover" && motion.t >= RECOVER_T) {
    motion.phase = "idle";
    motion.t = 0;
  }
}

export class AnimatedPhysicalBodies extends PhysicalBodies {
  private motions = new Map<number, GrabMotion>();
  private playerGrabPressed = false;
  private playerGrabReleased = false;

  captureInput(input: Actions) {
    this.playerGrabPressed ||= input.grabPressed;
    this.playerGrabReleased ||= input.grabReleased;
    input.grabPressed = false;
    input.grabReleased = false;
  }

  prepareInput(w: World, input: Actions, dt: number) {
    input.grabPressed = false;
    input.grabReleased = false;

    const p = w.player();
    let motion = this.motions.get(p.id);
    if (!motion) {
      motion = makeMotion();
      this.motions.set(p.id, motion);
    }

    if (!canPose(p)) {
      motion.phase = "idle";
      motion.t = 0;
      motion.contactIssued = false;
      motion.releaseQueued = false;
      motion.targetId = 0;
      motion.targetNode = -1;
      this.playerGrabPressed = false;
      this.playerGrabReleased = false;
      return;
    }

    if (this.playerGrabPressed && !p.grabbedId) {
      this.playerGrabPressed = false;
      const target = findGrabTarget(w, p);
      motion.phase = "reach";
      motion.t = 0;
      motion.recoverFrom = "reach";
      motion.contactIssued = false;
      motion.releaseQueued = false;
      motion.targetId = target?.id ?? 0;
      motion.targetActor = target?.actor ?? false;
      motion.targetNode = -1;
    }

    if (this.playerGrabReleased) {
      this.playerGrabReleased = false;
      this.playerGrabPressed = false;

      if (p.grabbedId) {
        input.grabReleased = true;
        motion.phase = "release";
        motion.t = 0;
        motion.recoverFrom = "release";
        motion.contactIssued = false;
        motion.releaseQueued = false;
      } else if (motion.phase === "reach") {
        motion.releaseQueued = true;
      }
    }

    if (
      motion.releaseQueued &&
      motion.phase === "hold" &&
      p.grabbedId
    ) {
      input.grabReleased = true;
      motion.releaseQueued = false;
      motion.phase = "release";
      motion.t = 0;
      motion.recoverFrom = "release";
      motion.contactIssued = false;
      return;
    }

    if (motion.phase === "reach") {
      motion.t = Math.min(REACH_T, motion.t + dt);
      const rig = this.get(p);
      const target = rig?.initialized
        ? targetPoint(w, this, p, rig, motion)
        : null;
      const hand = rig?.initialized
        ? nodePoint(rig, BODY.rHand)
        : null;
      const closeEnough = Boolean(
        target &&
        hand &&
        distance(hand, target) <= CONTACT_RADIUS * (p.height / 1.72),
      );

      if (motion.targetId && closeEnough && !motion.contactIssued) {
        motion.contactIssued = true;
        motion.lastContactX = target!.x;
        motion.lastContactY = target!.y;
        motion.lastContactZ = target!.z;
        input.grabPressed = true;
      } else if (motion.t >= REACH_T && !motion.contactIssued) {
        motion.phase = "recover";
        motion.t = 0;
        motion.recoverFrom = "reach";
        motion.releaseQueued = false;
      }
    } else if (motion.phase === "hold") {
      motion.t += dt;
    } else if (motion.phase === "release") {
      motion.t += dt;
      if (motion.t >= RELEASE_T) {
        motion.phase = "recover";
        motion.t = 0;
        motion.recoverFrom = "release";
      }
    } else if (motion.phase === "recover") {
      motion.t += dt;
      if (motion.t >= RECOVER_T) {
        motion.phase = "idle";
        motion.t = 0;
        motion.targetId = 0;
        motion.targetNode = -1;
      }
    }
  }

  override reset(a: Actor) {
    super.reset(a);
    this.motions.delete(a.id);
  }

  override clear() {
    super.clear();
    this.motions.clear();
    this.playerGrabPressed = false;
    this.playerGrabReleased = false;
  }

  override step(w: World, dt: number) {
    super.step(w, dt);

    for (const a of w.actors) {
      if (!isHuman(a)) continue;
      const rig = this.get(a);
      if (!rig?.initialized) continue;

      let motion = this.motions.get(a.id);
      if (!motion) {
        motion = makeMotion();
        this.motions.set(a.id, motion);
      }

      const isPlayer = a.id === w.playerId;
      const grabbedNow = a.grabbedId;
      const beganHolding = grabbedNow !== 0 && motion.lastGrabbedId === 0;
      const stoppedHolding = grabbedNow === 0 && motion.lastGrabbedId !== 0;

      if (!canPose(a)) {
        motion.phase = "idle";
        motion.t = 0;
        motion.contactIssued = false;
        motion.releaseQueued = false;
      } else if (isPlayer) {
        if (motion.phase === "reach" && motion.contactIssued) {
          motion.contactIssued = false;
          if (grabbedNow) {
            motion.phase = "hold";
            motion.t = 0;
            motion.targetId = grabbedNow;
            motion.targetActor = Boolean(w.actor(grabbedNow));
            motion.targetNode = -1;
          } else {
            motion.phase = "recover";
            motion.t = 0;
            motion.recoverFrom = "reach";
            motion.releaseQueued = false;
          }
        } else if (stoppedHolding && motion.phase === "hold") {
          motion.phase = "release";
          motion.t = 0;
          motion.recoverFrom = "release";
          motion.releaseQueued = false;
        }
      } else {
        if (stoppedHolding && motion.phase === "hold") {
          motion.phase = "release";
          motion.t = 0;
          motion.recoverFrom = "release";
        } else if (beganHolding && motion.phase === "idle") {
          motion.phase = "hold";
          motion.t = 0;
          motion.targetId = grabbedNow;
          motion.targetActor = Boolean(w.actor(grabbedNow));
          motion.targetNode = -1;
        }
        advancePassive(motion, dt, Boolean(grabbedNow));
      }

      motion.lastGrabbedId = grabbedNow;
      applyGrabPose(w, this, a, rig, motion);
    }
  }
}
