import type { Actions } from "./input";
import type { Actor } from "./types";
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
type Vec3 = readonly [number, number, number];

interface GrabMotion {
  phase: GrabPhase;
  t: number;
  lastGrabbedId: number;
  recoverFrom: RecoverFrom;
  contactIssued: boolean;
  releaseQueued: boolean;
}

// Input response begins immediately. The only delay before latch is the
// visible physical travel of the hand itself.
const REACH_T = 0.105;
const CONTACT_T = 0.085;
const RELEASE_T = 0.13;
const RECOVER_T = 0.14;

const START = {
  shoulder: [0.27, 1.31, 0] as Vec3,
  elbow: [0.36, 1.03, 0] as Vec3,
  hand: [0.39, 0.77, 0] as Vec3,
  chestZ: 0,
};

const CONTACT = {
  shoulder: [0.27, 1.29, 0.08] as Vec3,
  elbow: [0.32, 1.1, 0.31] as Vec3,
  hand: [0.2, 1.01, 0.62] as Vec3,
  chestZ: 0.025,
};

const RELEASE = {
  shoulder: [0.25, 1.3, 0.14] as Vec3,
  elbow: [0.25, 1.16, 0.52] as Vec3,
  hand: [0.12, 1.12, 0.86] as Vec3,
  chestZ: 0.09,
};

function smooth01(v: number) {
  const t = clamp(v, 0, 1);
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
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
  };
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
  if (strength <= 0) return;
  const scale = a.height / 1.72;
  const f = facing(a.yaw);
  const r = rightOf(a.yaw);
  const tx = a.x + r.x * lx * scale + f.x * lz * scale;
  const ty = a.y + ly * scale;
  const tz = a.z + r.z * lx * scale + f.z * lz * scale;

  rig.x[node] += (tx - rig.x[node]!) * strength;
  rig.y[node] += (ty - rig.y[node]!) * strength;
  rig.z[node] += (tz - rig.z[node]!) * strength;
}

function applyPose(
  a: Actor,
  rig: BodyRig,
  phase: GrabPhase,
  t: number,
  twoHand: boolean,
  recoverFrom: RecoverFrom,
) {
  if (!canPose(a) || phase === "idle") return;

  let shoulder: Vec3 = CONTACT.shoulder;
  let elbow: Vec3 = CONTACT.elbow;
  let hand: Vec3 = CONTACT.hand;
  let chestZ = CONTACT.chestZ;
  let weight = 1;
  let support = 0;

  if (phase === "reach") {
    const q = smooth01(t / REACH_T);
    shoulder = [
      mix(START.shoulder[0], CONTACT.shoulder[0], q),
      mix(START.shoulder[1], CONTACT.shoulder[1], q),
      mix(START.shoulder[2], CONTACT.shoulder[2], q),
    ];
    elbow = [
      mix(START.elbow[0], CONTACT.elbow[0], q),
      mix(START.elbow[1], CONTACT.elbow[1], q),
      mix(START.elbow[2], CONTACT.elbow[2], q),
    ];
    hand = [
      mix(START.hand[0], CONTACT.hand[0], q),
      mix(START.hand[1], CONTACT.hand[1], q),
      mix(START.hand[2], CONTACT.hand[2], q),
    ];
    chestZ = mix(START.chestZ, CONTACT.chestZ, q);
    weight = q;
    support = twoHand ? q * 0.82 : 0;
  } else if (phase === "hold") {
    const load = clamp(a.carry / 70, 0, 1);
    chestZ = CONTACT.chestZ - load * 0.08;
    hand = [
      CONTACT.hand[0],
      CONTACT.hand[1] - load * 0.08,
      CONTACT.hand[2] - load * 0.08,
    ];
    elbow = [
      CONTACT.elbow[0],
      CONTACT.elbow[1] - load * 0.04,
      CONTACT.elbow[2] - load * 0.04,
    ];
    support = twoHand ? 0.88 : 0.28;
  } else if (phase === "release") {
    const q = smooth01(t / RELEASE_T);
    shoulder = [
      mix(CONTACT.shoulder[0], RELEASE.shoulder[0], q),
      mix(CONTACT.shoulder[1], RELEASE.shoulder[1], q),
      mix(CONTACT.shoulder[2], RELEASE.shoulder[2], q),
    ];
    elbow = [
      mix(CONTACT.elbow[0], RELEASE.elbow[0], q),
      mix(CONTACT.elbow[1], RELEASE.elbow[1], q),
      mix(CONTACT.elbow[2], RELEASE.elbow[2], q),
    ];
    hand = [
      mix(CONTACT.hand[0], RELEASE.hand[0], q),
      mix(CONTACT.hand[1], RELEASE.hand[1], q),
      mix(CONTACT.hand[2], RELEASE.hand[2], q),
    ];
    chestZ = mix(CONTACT.chestZ, RELEASE.chestZ, q);
    support = twoHand ? (1 - q) * 0.55 : 0;
  } else if (phase === "recover") {
    const q = smooth01(t / RECOVER_T);
    const from = recoverFrom === "release" ? RELEASE : CONTACT;
    shoulder = [
      mix(from.shoulder[0], START.shoulder[0], q),
      mix(from.shoulder[1], START.shoulder[1], q),
      mix(from.shoulder[2], START.shoulder[2], q),
    ];
    elbow = [
      mix(from.elbow[0], START.elbow[0], q),
      mix(from.elbow[1], START.elbow[1], q),
      mix(from.elbow[2], START.elbow[2], q),
    ];
    hand = [
      mix(from.hand[0], START.hand[0], q),
      mix(from.hand[1], START.hand[1], q),
      mix(from.hand[2], START.hand[2], q),
    ];
    chestZ = mix(from.chestZ, START.chestZ, q);
    weight = 1 - q;
    support = twoHand ? weight * 0.45 : 0;
  }

  setLocalNode(
    a,
    rig,
    BODY.rShoulder,
    shoulder[0],
    shoulder[1],
    shoulder[2],
    0.72 * weight,
  );
  setLocalNode(
    a,
    rig,
    BODY.rElbow,
    elbow[0],
    elbow[1],
    elbow[2],
    0.86 * weight,
  );
  setLocalNode(
    a,
    rig,
    BODY.rHand,
    hand[0],
    hand[1],
    hand[2],
    0.96 * weight,
  );
  setLocalNode(
    a,
    rig,
    BODY.chest,
    0,
    1.2,
    chestZ,
    0.34 * weight,
  );

  if (support > 0) {
    setLocalNode(
      a,
      rig,
      BODY.lShoulder,
      -0.27,
      1.29,
      0.06,
      support * 0.5,
    );
    setLocalNode(
      a,
      rig,
      BODY.lElbow,
      -0.3,
      1.08,
      0.25,
      support * 0.68,
    );
    setLocalNode(
      a,
      rig,
      BODY.lHand,
      -0.14,
      1.0,
      0.5,
      support,
    );
  }
}

function advancePassive(
  motion: GrabMotion,
  dt: number,
  holding: boolean,
) {
  if (motion.phase === "idle" || motion.phase === "hold") return;
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
  } else if (
    motion.phase === "release" &&
    motion.t >= RELEASE_T
  ) {
    motion.phase = "recover";
    motion.t = 0;
    motion.recoverFrom = "release";
  } else if (
    motion.phase === "recover" &&
    motion.t >= RECOVER_T
  ) {
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

    // This layer owns only the contact timing. Visible motion starts on the
    // original input edge; there is no hidden anticipation phase.
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
      this.playerGrabPressed = false;
      this.playerGrabReleased = false;
      return;
    }

    if (
      this.playerGrabPressed &&
      !p.grabbedId
    ) {
      this.playerGrabPressed = false;
      motion.phase = "reach";
      motion.t = 0;
      motion.recoverFrom = "reach";
      motion.contactIssued = false;
      motion.releaseQueued = false;
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
        // Preserve a fast tap as a real grab attempt. The hand keeps moving
        // toward contact, then releases immediately if something is caught.
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
      if (
        motion.t >= CONTACT_T &&
        !motion.contactIssued
      ) {
        motion.contactIssued = true;
        input.grabPressed = true;
      }
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
      const beganHolding =
        grabbedNow !== 0 && motion.lastGrabbedId === 0;
      const stoppedHolding =
        grabbedNow === 0 && motion.lastGrabbedId !== 0;

      if (!canPose(a)) {
        motion.phase = "idle";
        motion.t = 0;
        motion.contactIssued = false;
        motion.releaseQueued = false;
      } else if (isPlayer) {
        if (
          motion.phase === "reach" &&
          motion.contactIssued
        ) {
          motion.contactIssued = false;
          if (grabbedNow) {
            motion.phase = "hold";
            motion.t = 0;
          } else {
            motion.phase = "recover";
            motion.t = 0;
            motion.recoverFrom = "reach";
            motion.releaseQueued = false;
          }
        } else if (
          stoppedHolding &&
          motion.phase === "hold"
        ) {
          motion.phase = "release";
          motion.t = 0;
          motion.recoverFrom = "release";
          motion.releaseQueued = false;
        }
      } else {
        if (
          stoppedHolding &&
          motion.phase === "hold"
        ) {
          motion.phase = "release";
          motion.t = 0;
          motion.recoverFrom = "release";
        } else if (
          beganHolding &&
          motion.phase === "idle"
        ) {
          motion.phase = "reach";
          motion.t = 0;
          motion.recoverFrom = "reach";
        }
        advancePassive(motion, dt, Boolean(grabbedNow));
      }

      motion.lastGrabbedId = grabbedNow;

      const targetActor =
        grabbedNow ? w.actor(grabbedNow) : undefined;
      const twoHand =
        Boolean(targetActor) || a.carry > 24;

      applyPose(
        a,
        rig,
        motion.phase,
        motion.t,
        twoHand,
        motion.recoverFrom,
      );
    }
  }
}
