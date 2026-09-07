export const PUNCH = {
  NONE: 0, JAB: 1, CROSS: 2,
  LEAD_UPPERCUT: 3, REAR_HOOK: 4,
  LEAD_HOOK: 5, REAR_UPPERCUT: 6,
} as const;

export const EDGES = {
  combinationContinuity: true,
  contextualPunchPath: true,
  supportCoupledDrive: true,
};

const CAP = 128;
const QUEUE_CAP = 4;
const BUFFER = 0.48;
const COMBO_WINDOW = 0.7;
const ORDER = [
  PUNCH.JAB, PUNCH.CROSS, PUNCH.LEAD_UPPERCUT,
  PUNCH.REAR_HOOK, PUNCH.LEAD_HOOK, PUNCH.REAR_UPPERCUT,
] as const;
const DURATIONS = [0, 0.27, 0.34, 0.33, 0.34, 0.32, 0.35];

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
function smooth(v: number) {
  const t = clamp(v, 0, 1);
  return t * t * (3 - 2 * t);
}
function cubic(a: number, b: number, c: number,
  d: number, t: number) {
  const s = 1 - t;
  return s * s * s * a + 3 * s * s * t * b +
    3 * s * t * t * c + t * t * t * d;
}

export interface BoxingContext {
  targetX: number;
  targetY: number;
  targetZ: number;
  forwardSpeed: number;
  lateralSpeed: number;
  angularMomentum: number;
  support: number;
  grip: number;
  capacity: number;
}
export interface BoxingPose {
  handX: number; handY: number; handZ: number;
  guardX: number; guardY: number; guardZ: number;
  hipTurn: number; chestTurn: number;
  shiftX: number; shiftZ: number;
  compression: number; drive: number; tuck: number;
}
export function makeBoxingPose(): BoxingPose {
  return {
    handX: 0, handY: 0, handZ: 0,
    guardX: 0, guardY: 0, guardZ: 0,
    hipTurn: 0, chestTurn: 0,
    shiftX: 0, shiftZ: 0, compression: 0,
    drive: 0, tuck: 0,
  };
}

/** Intent selection and path generation. No solved-node writes. */
export class BoxingCombinations {
  private readonly kind = new Uint8Array(CAP);
  private readonly right = new Uint8Array(CAP);
  private readonly leadRight = new Uint8Array(CAP);
  private readonly index = new Uint8Array(CAP);
  private readonly queued = new Uint8Array(CAP);
  private readonly queuedAt = new Float64Array(CAP * QUEUE_CAP);
  private readonly queueHead = new Uint8Array(CAP);
  private readonly lastEnd = new Float64Array(CAP);
  private readonly start = new Float32Array(CAP * 3);
  private readonly tangent = new Float32Array(CAP * 3);
  private readonly duration = new Float32Array(CAP);

  constructor() { this.lastEnd.fill(-1e6); }
  clear() {
    this.kind.fill(0); this.right.fill(0);
    this.leadRight.fill(0); this.index.fill(0);
    this.queued.fill(0); this.queuedAt.fill(0);
    this.queueHead.fill(0); this.lastEnd.fill(-1e6);
    this.start.fill(0); this.tangent.fill(0);
    this.duration.fill(0);
  }
  reset(slot: number) {
    this.kind[slot] = 0; this.index[slot] = 0;
    this.queued[slot] = 0; this.queueHead[slot] = 0;
    this.lastEnd[slot] = -1e6; this.duration[slot] = 0;
  }
  private expire(slot: number, now: number) {
    while (this.queued[slot]) {
      const q = slot * QUEUE_CAP + this.queueHead[slot]!;
      if (now <= this.queuedAt[q]!) break;
      this.queueHead[slot] =
        (this.queueHead[slot]! + 1) % QUEUE_CAP;
      this.queued[slot]--;
    }
  }
  enqueue(slot: number, now: number) {
    this.expire(slot, now);
    if (this.queued[slot] === QUEUE_CAP) return false;
    const q = (this.queueHead[slot]! +
      this.queued[slot]!) % QUEUE_CAP;
    // Reserve enough time for earlier queued punches to complete.
    this.queuedAt[slot * QUEUE_CAP + q] =
      now + BUFFER + this.queued[slot]! * 0.42;
    this.queued[slot]++;
    return true;
  }
  take(slot: number, now: number) {
    this.expire(slot, now);
    if (!this.queued[slot]) return false;
    this.queueHead[slot] =
      (this.queueHead[slot]! + 1) % QUEUE_CAP;
    this.queued[slot]--;
    return true;
  }
  pending(slot: number) { return this.queued[slot]!; }
  private nextIndex(slot: number, now: number) {
    return EDGES.combinationContinuity &&
      now - this.lastEnd[slot]! <= COMBO_WINDOW
      ? (this.index[slot]! + 1) % ORDER.length : 0;
  }
  nextProfile(slot: number, now: number, range: number) {
    let kind: number = ORDER[this.nextIndex(slot, now)]!;
    if (EDGES.contextualPunchPath) {
      if (range < 0.48 && (kind === PUNCH.JAB ||
        kind === PUNCH.CROSS)) {
        kind = kind === PUNCH.JAB
          ? PUNCH.LEAD_HOOK : PUNCH.REAR_HOOK;
      } else if (range > 0.96 && (
        kind === PUNCH.LEAD_UPPERCUT ||
        kind === PUNCH.REAR_UPPERCUT)) {
        kind = kind === PUNCH.LEAD_UPPERCUT
          ? PUNCH.JAB : PUNCH.CROSS;
      }
    }
    return kind;
  }
  nextHand(slot: number, now: number,
    leadRight: boolean, range: number) {
    const kind = this.nextProfile(slot, now, range);
    const lead = kind === PUNCH.JAB ||
      kind === PUNCH.LEAD_UPPERCUT ||
      kind === PUNCH.LEAD_HOOK;
    return lead ? leadRight : !leadRight;
  }
  begin(
    slot: number, now: number, leadRight: boolean,
    range: number, capacity: number,
    startX: number, startY: number, startZ: number,
    velX: number, velY: number, velZ: number,
  ) {
    const index = this.nextIndex(slot, now);
    const kind = this.nextProfile(slot, now, range);
    const lead = kind === PUNCH.JAB ||
      kind === PUNCH.LEAD_UPPERCUT ||
      kind === PUNCH.LEAD_HOOK;
    this.index[slot] = index; this.kind[slot] = kind;
    this.leadRight[slot] = leadRight ? 1 : 0;
    this.right[slot] = lead
      ? this.leadRight[slot]! : 1 - this.leadRight[slot]!;
    const d = DURATIONS[kind]! /
      (0.72 + 0.28 * clamp(capacity, 0, 1));
    this.duration[slot] = d;
    const q = slot * 3;
    this.start[q] = startX;
    this.start[q + 1] = startY;
    this.start[q + 2] = startZ;
    const m = Math.hypot(velX, velY, velZ);
    const v = m > 6.5 ? 6.5 / m : 1;
    this.tangent[q] = velX * v * d * 0.7 / 3;
    this.tangent[q + 1] = velY * v * d * 0.7 / 3;
    this.tangent[q + 2] = velZ * v * d * 0.7 / 3;
    return d;
  }
  end(slot: number, now: number) {
    if (this.kind[slot]) this.lastEnd[slot] = now;
    this.kind[slot] = 0;
  }
  profile(slot: number) { return this.kind[slot]!; }
  rightHand(slot: number) { return this.right[slot] !== 0; }
  durationFor(slot: number) { return this.duration[slot]!; }
  contactWindow(slot: number, u: number) {
    const kind = this.kind[slot]!;
    if (!kind) return false;
    const start = kind === PUNCH.LEAD_UPPERCUT ||
      kind === PUNCH.REAR_UPPERCUT ? 0.25 : 0.29;
    return u >= start && u <= 0.77;
  }
  sample(slot: number, u: number,
    c: BoxingContext, out: BoxingPose) {
    const kind = this.kind[slot]!;
    const sign = this.right[slot] ? 1 : -1;
    const straight = kind === PUNCH.JAB || kind === PUNCH.CROSS;
    const hook = kind === PUNCH.REAR_HOOK ||
      kind === PUNCH.LEAD_HOOK;
    const uppercut = !straight && !hook;
    const lead = kind === PUNCH.JAB ||
      kind === PUNCH.LEAD_HOOK ||
      kind === PUNCH.LEAD_UPPERCUT;
    const q = slot * 3;
    const sx = this.start[q]!, sy = this.start[q + 1]!;
    const sz = this.start[q + 2]!;
    const tx = clamp(c.targetX, -0.37, 0.37);
    const ty = clamp(c.targetY, 0.92, 1.55);
    const tz = clamp(c.targetZ, 0.34, 0.98);
    const reach = straight ? tz : Math.min(tz, 0.7);
    const ex = clamp(tx, -0.2, 0.2);
    const ey = uppercut ? Math.max(1.28, ty) : ty;
    const ez = reach;
    const cx = straight ? sign * 0.13 : sign * 0.47;
    const cy = uppercut ? 0.94 : hook ? ey + 0.02 : ey;
    const cz = straight ? 0.43 : hook ? 0.34 : 0.25;
    const dx = straight ? ex : hook ? sign * 0.44 : ex;
    const dy = uppercut ? ey - 0.3 : hook ? ey : ey;
    const dz = straight ? ez - 0.2 : hook ? ez : ez - 0.08;
    const firstX = sx + this.tangent[q]!;
    const firstY = sy + this.tangent[q + 1]!;
    const firstZ = sz + this.tangent[q + 2]!;
    const controlX = straight ? firstX :
      sx + (cx - sx) * 0.52 + this.tangent[q]!;
    const controlY = straight ? firstY :
      sy + (cy - sy) * 0.52 + this.tangent[q + 1]!;
    const controlZ = straight ? firstZ :
      sz + (cz - sz) * 0.52 + this.tangent[q + 2]!;
    const secondX = hook ? dx : uppercut ? dx : ex;
    const secondY = uppercut ? dy : ey;
    const secondZ = hook ? dz : uppercut ? dz : ez - 0.12;
    const guardX = sign * 0.2, guardY = 1.32, guardZ = 0.22;
    if (u <= 0.7) {
      const t = clamp(u / 0.7, 0, 1);
      out.handX = cubic(sx, controlX, secondX, ex, t);
      out.handY = cubic(sy, controlY, secondY, ey, t);
      out.handZ = cubic(sz, controlZ, secondZ, ez, t);
    } else {
      const t = clamp((u - 0.7) / 0.3, 0, 1);
      out.handX = cubic(ex, ex + (ex - secondX) * 0.18,
        guardX + sign * 0.04, guardX, t);
      out.handY = cubic(ey, ey + (ey - secondY) * 0.18,
        guardY, guardY, t);
      out.handZ = cubic(ez, ez + (ez - secondZ) * 0.18,
        guardZ + 0.08, guardZ, t);
    }
    const wave = smooth(u / 0.34) *
      (1 - smooth((u - 0.68) / 0.32));
    const support = clamp(c.support, 0, 1);
    const grip = clamp(c.grip, 0, 1);
    const capacity = clamp(c.capacity, 0, 1);
    const drive = EDGES.supportCoupledDrive
      ? (0.4 + 0.6 * support * grip) *
        (0.55 + 0.45 * capacity) : 1;
    const motion = clamp(c.forwardSpeed / 5.5, -1, 1);
    const lateral = clamp(c.lateralSpeed / 5.5, -1, 1);
    const inheritedTurn = clamp(
      c.angularMomentum / 30, -0.2, 0.2,
    );
    const turn = ((straight ? (lead ? 0.12 : 0.3) :
      hook ? 0.4 : 0.25) + inheritedTurn * sign) *
      drive * wave;
    out.hipTurn = -sign * turn * 0.62;
    out.chestTurn = -sign * turn;
    out.shiftX = sign * (lead ? 0.012 : 0.035) *
      drive * wave + lateral * 0.025 * wave;
    out.shiftZ = (0.025 + Math.max(0, motion) * 0.045) *
      drive * wave;
    out.compression = (uppercut ? 0.045 : 0.018) *
      drive * smooth(u / 0.2) *
      (1 - smooth((u - 0.55) / 0.35));
    out.drive = drive;
    out.tuck = straight ? 0.92 : 0.35;
    out.guardX = -sign * 0.19;
    out.guardY = 1.32;
    out.guardZ = 0.2;
    return out;
  }
}
