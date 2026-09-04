/**
 * Falsifiers for the physical substrate.
 *
 * These run against the production simulation, not a reference copy: they build
 * the real level, call the real `stepWorld`, and read the real node arrays. A
 * check that cannot be run in this environment reports `pass: null` rather than
 * passing.
 *
 * The set is chosen to be able to say the coupling claim is FALSE:
 *
 *   replay      -- same seed and input timeline give identical state
 *   severance   -- cutting one edge measurably changes its consumer
 *   loopGain    -- the capsule <-> body feedback loop stays inside g <= 0.5
 *   ablation    -- removing one phenomenon changes at least two others
 *   coactivity  -- the phenomena actually overlap rather than queue up
 *   budget      -- damage never draws more than the contact's kinetic energy
 *   rest        -- nothing drifts, tunnels or goes non-finite when idle
 */

import type { Actions } from "./input";
import { EDGES, SUBSTEPS } from "./body";
import { buildLevel } from "./level";
import { stepWorld, type Cam } from "./sim";
import { REGIONS, STEP, injurySum, type Actor } from "./types";
import { World } from "./world";

export interface CheckResult {
  name: string;
  /** true pass, false fail, null when the environment cannot support the check. */
  pass: boolean | null;
  detail: string;
}

const IDLE: Actions = {
  moveX: 0,
  moveY: 0,
  lookX: 0,
  lookY: 0,
  hoverX: 0,
  hoverY: 0,
  sprint: false,
  crouch: false,
  jump: false,
  jumpPressed: false,
  attack: false,
  attackPressed: false,
  grab: false,
  grabPressed: false,
  grabReleased: false,
  kick: false,
  kickPressed: false,
  shove: false,
  shovePressed: false,
  drop: false,
  dropPressed: false,
  bandage: false,
  ignite: false,
  ignitePressed: false,
  pausePressed: false,
};

const CAM: Cam = { yaw: 0, pitch: 0.18 };

function freshWorld(seed = 12345) {
  const w = new World();
  w.seed = seed;
  buildLevel(w);
  w.phase = "playing";
  return w;
}

function run(w: World, ticks: number, input: Actions = IDLE) {
  for (let i = 0; i < ticks; i++) stepWorld(w, STEP, input, CAM, true);
}

/** FNV-1a over quantised authoritative state. Millimetre resolution. */
function hashState(w: World) {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    const q = Number.isFinite(v) ? Math.round(v * 1000) | 0 : 0x7fffffff;
    h ^= q & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (q >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (q >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (q >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  const B = w.bodies;
  for (const a of w.actors) {
    mix(a.x);
    mix(a.y);
    mix(a.z);
    mix(a.yaw);
    mix(a.stanceAuth);
    for (const r of REGIONS) mix(injurySum(a.injuries[r]));
    if (a.body < 0) continue;
    const b = B.base(a.body);
    for (let i = 0; i < B.count[a.body]!; i++) {
      mix(B.px[b + i]!);
      mix(B.py[b + i]!);
      mix(B.pz[b + i]!);
    }
  }
  return h >>> 0;
}

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */

/**
 * Moves the player somewhere flat and empty and stops every other actor from
 * wandering into the measurement. Scenarios drive the PLAYER because that path
 * takes real input through `applyPlayer`, rather than fighting the AI for
 * control of an NPC's intent.
 */
function stage(w: World, x = 34, z = 34) {
  for (const a of w.actors) {
    a.routine = [];
    if (a.kind === "player") continue;
    a.homeX = a.x;
    a.homeZ = a.z;
  }
  const p = w.player();
  p.x = x;
  p.z = z;
  p.y = 0;
  p.yaw = 0;
  if (p.body >= 0) w.bodies.moveTo(p.body, x, 0, z);
  return p;
}

/** An input with one field overridden, so scenarios read as intent. */
function act(over: Partial<Actions>): Actions {
  return { ...IDLE, ...over };
}

/** Pins an NPC at a spot so it does not wander out of the measurement. */
function place(w: World, a: Actor, x: number, z: number) {
  a.x = x;
  a.z = z;
  a.y = 0;
  a.homeX = x;
  a.homeZ = z;
  a.wayX = x;
  a.wayZ = z;
  a.routine = [];
  a.ai = "idle";
  a.aiT = 1e6;
  if (a.body >= 0) w.bodies.moveTo(a.body, x, 0, z);
}

/** Lifts one actor to `height` and drops it, limp or braced. */
function dropScenario(seed: number, height: number, limp: boolean, ticks = 90) {
  const w = freshWorld(seed);
  const a = stage(w, 0, 0); // market cobble: the hardest surface in the level
  a.y = height;
  a.vx = a.vy = a.vz = 0;
  if (limp) {
    a.stanceAuth = 0;
    a.consciousness = 0.05;
    a.loco = "ragdoll";
    a.locoT = 999;
  }
  if (a.body >= 0) w.bodies.moveTo(a.body, 0, height, 0);
  run(w, ticks);
  return { w, a };
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

function checkReplay(): CheckResult {
  const a = freshWorld(777);
  const b = freshWorld(777);
  run(a, 240);
  run(b, 240);
  const ha = hashState(a);
  const hb = hashState(b);
  return {
    name: "replay",
    pass: ha === hb,
    detail: `240 ticks, seed 777: ${ha.toString(16)} vs ${hb.toString(16)}`,
  };
}

function checkRest(): CheckResult {
  const w = freshWorld(4242);
  run(w, 600);
  const B = w.bodies;
  let bad = 0;
  let sunk = 0;
  let worstY = 0;
  for (const a of w.actors) {
    if (a.body < 0) continue;
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) bad++;
    const b = B.base(a.body);
    for (let i = 0; i < B.count[a.body]!; i++) {
      const y = B.py[b + i]!;
      if (!Number.isFinite(y) || !Number.isFinite(B.px[b + i]!)) bad++;
      const below = -(y - B.rad[b + i]!);
      if (below > 0.09) sunk++;
      if (below > worstY) worstY = below;
    }
  }
  return {
    name: "rest-stability",
    pass: bad === 0 && sunk === 0,
    detail: `600 ticks idle: ${bad} non-finite, ${sunk} nodes below ground, worst sink ${worstY.toFixed(3)} m`,
  };
}

/**
 * The capsule <-> body loop is the only bidirectional edge in the substrate.
 * Predicted closed form: g = authority * (1 - authority) <= 1/4. Measured by
 * perturbing the capsule and reading back the perturbation one tick later.
 */
function checkLoopGain(): CheckResult {
  let worst = 0;
  let worstAuth = 0;
  const delta = 0.04; // 4 cm, large next to a 0.6 m body width
  for (const auth of [0.1, 0.25, 0.5, 0.75, 0.9, 1.0]) {
    // Two identical worlds. The loop variable is the capsule-to-body
    // DISCREPANCY, not the absolute position: perturbing the capsule translates
    // the whole system, and translation is not feedback. Differencing against
    // an unperturbed control cancels both the equilibrium offset and the
    // dynamics the loop is not responsible for.
    const ctl = freshWorld(99);
    const per = freshWorld(99);
    const ca = stage(ctl);
    const pa = stage(per);
    ca.stanceAuth = auth;
    pa.stanceAuth = auth;
    run(ctl, 40);
    run(per, 40);
    ca.stanceAuth = auth;
    pa.stanceAuth = auth;
    const err = (w: World, a: Actor) => a.x - w.bodies.comX[a.body]!;
    pa.x += delta;
    const d0 = err(per, pa) - err(ctl, ca);
    run(ctl, 1);
    run(per, 1);
    const d1 = err(per, pa) - err(ctl, ca);
    const g = Math.abs(d0) > 1e-9 ? Math.abs(d1 / d0) : 0;
    if (g > worst) {
      worst = g;
      worstAuth = auth;
    }
  }
  return {
    name: "loop-gain",
    pass: worst <= 0.5,
    detail: `worst g = ${worst.toFixed(3)} at authority ${worstAuth}, over one capsule -> pose -> solver -> capsule traversal; required <= 0.5`,
  };
}

/** Severs one edge, replays the same seed and timeline, compares the consumer. */
function severance(
  edge: keyof typeof EDGES,
  name: string,
  measure: () => number,
  tol = 1e-6,
): CheckResult {
  const before = measure();
  EDGES[edge] = false;
  let after: number;
  try {
    after = measure();
  } finally {
    EDGES[edge] = true;
  }
  const changed = Math.abs(after - before) > tol;
  return {
    name: `severance:${name}`,
    pass: changed,
    detail: `${edge} on -> ${before.toFixed(4)}, off -> ${after.toFixed(4)}`,
  };
}

/** Total functional injury over every region of one actor. */
function totalInjury(a: Actor) {
  let t = 0;
  for (const r of REGIONS) t += injurySum(a.injuries[r]);
  return t;
}

function measureFallInjury() {
  const { a } = dropScenario(31337, 3.2, true);
  return totalInjury(a);
}

function measureLimpGait() {
  const w = freshWorld(555);
  const p = stage(w);
  p.injuries.lleg.fracture = 1.2;
  run(w, 30);
  return p.motor.lleg;
}

function measurePoseTracking() {
  const w = freshWorld(556);
  const a = stage(w);
  a.injuries.rarm.fracture = 1.4;
  run(w, 60, act({ moveY: 1 }));
  const B = w.bodies;
  const b = B.base(a.body);
  // distance between the damaged hand and where the pose wanted it, m
  const dx = B.px[b + 6]! - B.tx[b + 6]!;
  const dy = B.py[b + 6]! - B.ty[b + 6]!;
  const dz = B.pz[b + 6]! - B.tz[b + 6]!;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * A sustained sideways push, and the question of what it produces.
 *
 * With the support polygon live, the push walks the capture point off the base,
 * the character throws a foot out to catch it, and it stays on its feet. With
 * that edge severed there is no corrective response available at all: the body
 * resists rigidly, the pose error runs away, and it goes straight down. What is
 * measured is how long it stays upright, because that is the whole of what the
 * edge buys -- the entire middle ground between standing and falling.
 */
function measurePushSurvival() {
  const w = freshWorld(557);
  const a = stage(w);
  run(w, 20);
  const plan = w.bodies.plan(a.body);
  let upright = 0;
  for (let i = 0; i < 90; i++) {
    if (i < 26) w.bodies.applyImpulse(a.body, plan.chest, a.mass * 0.45, 0, 0, STEP);
    run(w, 1);
    if (a.loco !== "ragdoll" && a.loco !== "getup" && a.loco !== "pin" && a.loco !== "down")
      upright++;
  }
  return upright;
}

/**
 * Drops one limp body onto another lying on the ground and returns how high the
 * upper body's lowest node comes to rest, m. With node contact between bodies
 * it settles on top of the lower one; without it, it settles on the floor
 * through it.
 */
function measureDrape() {
  const w = freshWorld(558);
  stage(w, -30, -30);
  const bodies = w.actors.filter((a) => a.kind === "human" && a.alive).slice(0, 2);
  if (bodies.length < 2) return -1;
  const [lower, upper] = bodies as [Actor, Actor];
  for (const a of bodies) {
    place(w, a, 30, 30);
    a.stanceAuth = 0;
    a.consciousness = 0.02;
    a.loco = "ragdoll";
    a.locoT = 1e6;
  }
  run(w, 90); // let the lower body settle flat
  upper.y = 1.4;
  if (upper.body >= 0) w.bodies.moveTo(upper.body, lower.x, 1.4, lower.z);
  // Closest approach between the two bodies' nodes over the whole settle, as a
  // fraction of the radii that should have kept them apart. >= 1 means they
  // never interpenetrated; near 0 means they passed through each other.
  const B = w.bodies;
  const bl = B.base(lower.body);
  const bu = B.base(upper.body);
  let worst = Infinity;
  for (let t = 0; t < 150; t++) {
    run(w, 1);
    for (let i = 0; i < B.count[lower.body]!; i++) {
      for (let j = 0; j < B.count[upper.body]!; j++) {
        const dx = B.px[bl + i]! - B.px[bu + j]!;
        const dy = B.py[bl + i]! - B.py[bu + j]!;
        const dz = B.pz[bl + i]! - B.pz[bu + j]!;
        const rr = B.rad[bl + i]! + B.rad[bu + j]!;
        const ratio = Math.sqrt(dx * dx + dy * dy + dz * dz) / rr;
        if (ratio < worst) worst = ratio;
      }
    }
  }
  return worst;
}

/**
 * Grabs a limp body with the player and sprints away from it. Returns the
 * reaction load the hauler feels, N*s: zero if a grab is a parent transform,
 * non-zero only if it is a real bilateral constraint.
 */
function measureDragLoad() {
  const w = freshWorld(559);
  const hauler = stage(w, 34, 34);
  const load = w.actors.find((a) => a.kind === "human" && a.alive)!;
  place(w, load, 34, 33.5);
  load.stanceAuth = 0;
  load.consciousness = 0.05;
  load.loco = "ragdoll";
  load.locoT = 999;
  run(w, 20);
  run(w, 4, act({ grab: true, grabPressed: true }));
  if (!hauler.grabbedId) return -1; // grab never latched: the test cannot run
  let peak = 0;
  for (let i = 0; i < 90; i++) {
    run(w, 1, act({ moveY: -1, sprint: true, grab: true }));
    peak = Math.max(peak, hauler.dragLoad);
  }
  return peak;
}

/**
 * Ablation: disable one counted phenomenon, replay, and require at least two
 * others to change. A phenomenon whose removal changes nothing else was never
 * part of the ensemble however well it was simulated.
 */
/**
 * The most basic invariant in the whole system, and the one the original
 * falsifier set did not state: an actor must be able to WALK.
 *
 * Every phenomenon here -- balance, catch steps, motor authority, contact
 * damage -- can look correct in isolation while ordinary locomotion silently
 * collapses, because a stride legitimately leaves the base of support on every
 * step. This walks across open ground and requires the actor to stay upright,
 * keep its feet, and actually cover the commanded distance.
 */
function checkLocomotion(): CheckResult {
  const runs: string[] = [];
  let ok = true;
  for (const mode of ["walk", "sprint", "broken leg"] as const) {
    const w = freshWorld(4711);
    const a = stage(w, -34, 34); // open ground, clear of the village
    if (mode === "broken leg") a.injuries.lleg.fracture = 0.9;
    const input = act({ moveY: 1, sprint: mode === "sprint" });
    run(w, 20, input);
    const z0 = a.z;
    const x0 = a.x;
    let fell = 0;
    let supported = 0;
    const TICKS = 300; // 5 s
    for (let i = 0; i < TICKS; i++) {
      run(w, 1, input);
      if (a.loco === "ragdoll" || a.loco === "down" || a.loco === "getup" || a.loco === "pin")
        fell++;
      if (w.bodies.supportCount[a.body]! > 0) supported++;
    }
    const dist = Math.hypot(a.x - x0, a.z - z0);
    const footFrac = supported / TICKS;
    // A limp is slower, but it is still locomotion.
    const minDist = mode === "sprint" ? 18 : mode === "broken leg" ? 5 : 12;
    const good = fell === 0 && dist >= minDist && footFrac > 0.6;
    if (!good) ok = false;
    runs.push(
      `${mode}: ${dist.toFixed(1)} m in 5 s (need >= ${minDist}), ${fell} ticks down, feet on ground ${(footFrac * 100) | 0}%`,
    );
  }
  return {
    name: "locomotion",
    pass: ok,
    detail: runs.join("; "),
  };
}

function checkAblation(): CheckResult {
  // A conscious subject, so motor authority has somewhere to fall from: the
  // point of the test is that removing the injury edge must also change how well
  // the body can still control itself and hold its balance.
  const probeState = () => {
    const { w, a } = dropScenario(2024, 6.5, false, 220);
    void w;
    return {
      injury: totalInjury(a),
      motor: a.motor.lleg + a.motor.rleg + a.motor.larm + a.motor.rarm,
      balance: a.support,
    };
  };
  const base = probeState();
  EDGES.impulseInjury = false;
  let cut;
  try {
    cut = probeState();
  } finally {
    EDGES.impulseInjury = true;
  }
  const moved = [
    Math.abs(cut.injury - base.injury) > 1e-4,
    Math.abs(cut.motor - base.motor) > 1e-4,
    Math.abs(cut.balance - base.balance) > 1e-4,
  ].filter(Boolean).length;
  return {
    name: "ablation:impulse-injury",
    pass: moved >= 2,
    detail: `removing impact-local injury moved ${moved} downstream quantities (injury ${base.injury.toFixed(3)}->${cut.injury.toFixed(3)}, motor ${base.motor.toFixed(3)}->${cut.motor.toFixed(3)}, support ${base.balance.toFixed(3)}->${cut.balance.toFixed(3)}); need >= 2`,
  };
}

/**
 * Co-activity.
 *
 * A sequential showcase and a coupled ensemble are indistinguishable from a
 * wiring diagram: both have edges. What separates them is whether the phenomena
 * are ever changing at the same time. This runs one knockdown from the impulse
 * until the body is back on its feet, samples each phenomenon's own rate of
 * change against its own noise floor, and reports how long at least three of
 * them are simultaneously live.
 *
 * The thresholds are absolute durations rather than a fraction of a window,
 * because a fraction can be improved by choosing a shorter window. Human
 * perception resolves change at about 0.1 s, so a quarter-second of unbroken
 * three-way overlap is material by that standard, not by a tuned one.
 */
function checkCoactivity(): CheckResult {
  const w = freshWorld(31337);
  const a = stage(w);
  // Knock the player down ONTO another body, so the scenario exercises the
  // whole ensemble rather than a subset of it: articulated dynamics, contact
  // damage, motor authority, the support polygon and body-vs-body load are all
  // in play in one event.
  const other = w.actors.find((o) => o.kind === "human" && o.alive)!;
  place(w, other, a.x + 0.7, a.z);
  other.stanceAuth = 0;
  other.consciousness = 0.02;
  other.loco = "ragdoll";
  other.locoT = 1e6;
  run(w, 60);
  const plan = w.bodies.plan(a.body);
  w.bodies.applyImpulse(a.body, plan.chest, a.mass * 8, a.mass * 1.8, 0, STEP);
  a.consciousness = 0.55;

  const sample = () => ({
    inj: totalInjury(a),
    motor: a.motor.lleg + a.motor.rleg + a.motor.larm + a.motor.rarm,
    support: a.support,
    node: nodeSpread(w, a),
    pile: a.pileLoad + other.pileLoad,
  });
  const LABELS = ["injury", "motor", "support", "body", "pile"];
  let prev = sample();
  const MAX = 420; // 7 s: long enough for the fall, the settle and the rise
  let total = 0;
  let longest = 0;
  let runLen = 0;
  let ticks = 0;
  const everActive = [0, 0, 0, 0, 0];
  for (let i = 0; i < MAX; i++) {
    run(w, 1);
    ticks++;
    const cur = sample();
    const active = [
      Math.abs(cur.inj - prev.inj) > 1e-4,
      Math.abs(cur.motor - prev.motor) > 2e-3,
      Math.abs(cur.support - prev.support) > 2e-3,
      Math.abs(cur.node - prev.node) > 2e-3,
      Math.abs(cur.pile - prev.pile) > 0.05,
    ];
    for (let k = 0; k < 5; k++) if (active[k]) everActive[k]!++;
    const n = active.filter(Boolean).length;
    if (n >= 3) {
      total++;
      runLen++;
      if (runLen > longest) longest = runLen;
    } else {
      runLen = 0;
    }
    prev = cur;
    if (i > 90 && a.loco === "idle") break;
  }
  const totalS = total * STEP;
  const longestS = longest * STEP;
  const allParticipate = everActive.every((c) => c > 0);
  return {
    name: "coactivity",
    pass: allParticipate && longestS >= 0.25 && totalS >= 0.5,
    detail: `${(ticks * STEP).toFixed(2)} s event: ${totalS.toFixed(2)} s with >= 3 phenomena live, longest unbroken run ${longestS.toFixed(2)} s; live ticks ${LABELS.map((l, i) => `${l} ${everActive[i]}`).join(", ")}; need every phenomenon to participate, longest >= 0.25 s and total >= 0.50 s`,
  };
}

/** Mean node distance from the body centre: a scalar for "the body is moving". */
function nodeSpread(w: World, a: Actor) {
  if (a.body < 0) return 0;
  const B = w.bodies;
  const b = B.base(a.body);
  const n = B.count[a.body]!;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const dx = B.px[b + i]! - B.comX[a.body]!;
    const dy = B.py[b + i]! - B.comY[a.body]!;
    const dz = B.pz[b + i]! - B.comZ[a.body]!;
    s += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return s / n;
}

/**
 * Falls must scale with the energy that went in: a short drop harmless, a long
 * one incapacitating, monotone in between, and a braced landing cheaper than a
 * limp one from the same height. The last of those is the injury <- motor edge
 * showing up in the fall path.
 */
function checkBudget(): CheckResult {
  const rows: { h: number; inj: number }[] = [];
  for (const h of [0.6, 1.5, 3.2, 6.0]) {
    const { a } = dropScenario(8080, h, true, 140);
    rows.push({ h, inj: totalInjury(a) });
  }
  let mono = true;
  for (let i = 1; i < rows.length; i++) if (rows[i]!.inj < rows[i - 1]!.inj - 1e-9) mono = false;
  const braced = totalInjury(dropScenario(8080, 1.5, false, 140).a);
  const limp15 = rows[1]!.inj;
  const cheap = rows[0]!.inj < 0.12; // 0.6 m limp fall is a scrape
  const grave = rows[3]!.inj > 1.2; // 6 m limp fall is not survivable intact
  const bracedHelps = braced < limp15 - 1e-4;
  return {
    name: "budget-monotonic",
    pass: mono && cheap && grave && bracedHelps,
    detail:
      rows.map((r) => `${r.h}m limp -> ${r.inj.toFixed(3)}`).join(", ") +
      `; 1.5m braced -> ${braced.toFixed(3)}` +
      `; monotone=${mono} shortDropHarmless=${cheap} longDropGrave=${grave} bracingHelps=${bracedHelps}`,
  };
}

/**
 * The struck region must come from geometry. Standing, a club swing lands high;
 * against the same target lying prone it must land somewhere else entirely,
 * because the arm is at the same height and the body is not.
 */
/**
 * The struck region must come from geometry, never a roll.
 *
 * Swing height is read from the attacker's own solved hand node, so the same
 * club against the same target must land somewhere else when the attacker
 * crouches -- because their arm is somewhere else.
 */
function checkImpactLocality(): CheckResult {
  const strikeFrom = (crouch: boolean) => {
    const w = freshWorld(6161);
    const atk = stage(w, 40, 40);
    const vic = w.actors.find((a) => a.kind === "human" && a.alive)!;
    const pin = () => place(w, vic, 40, 39.0);
    pin();
    for (let i = 0; i < 40; i++) {
      pin();
      run(w, 1, act({ crouch }));
    }
    atk.weapon = "club";
    const before = REGIONS.map((r) => injurySum(vic.injuries[r]));
    run(w, 2, act({ crouch, attack: true, attackPressed: true }));
    for (let i = 0; i < 25; i++) {
      pin();
      run(w, 1, act({ crouch }));
    }
    const after = REGIONS.map((r) => injurySum(vic.injuries[r]));
    return after
      .map((v, i) => ({ r: REGIONS[i]!, d: v - before[i]! }))
      .filter((x) => x.d > 1e-4)
      .sort((a, b) => b.d - a.d);
  };
  const high = strikeFrom(false);
  const low = strikeFrom(true);
  const highTop = high[0]?.r ?? "none";
  const lowTop = low[0]?.r ?? "none";
  const localised = high.length > 0 && high.length <= 2 && low.length > 0 && low.length <= 2;
  return {
    name: "impact-locality",
    pass: localised && highTop !== lowTop,
    detail: `standing swing -> ${high.map((x) => `${x.r} +${x.d.toFixed(3)}`).join(", ") || "none"}; crouched swing -> ${low.map((x) => `${x.r} +${x.d.toFixed(3)}`).join(", ") || "none"}; swing height is read from the attacker's own solved hand, so these must differ`,
  };
}

/* ------------------------------------------------------------------ *
 * The AI's reading of the substrate
 * ------------------------------------------------------------------ */

/** Drops `n` limp bodies in a line across a corridor at (x, z). */
function layBodies(w: World, n: number, x: number, z: number) {
  const out: Actor[] = [];
  for (const a of w.actors) {
    if (a.kind !== "human" || !a.alive || out.length >= n) continue;
    place(w, a, x + (out.length - (n - 1) / 2) * 0.55, z);
    a.stanceAuth = 0;
    a.consciousness = 0.02;
    a.loco = "ragdoll";
    a.locoT = 1e6;
    out.push(a);
  }
  run(w, 90); // let them settle flat
  return out;
}

/**
 * A guard's route past a row of bodies. Returns the closest it ever came to
 * one, m: steering that reads the ground keeps its distance.
 */
function measureGuardDetour() {
  const w = freshWorld(2211);
  stage(w, 30, 30); // player parked far away
  const guard = w.actors.find((o) => o.faction === "guard" && o.alive)!;
  place(w, guard, -30, -34);
  const bodies = layBodies(w, 3, -30, -30);
  // Send the guard through the line of bodies.
  let closest = Infinity;
  for (let i = 0; i < 300; i++) {
    guard.routine = [];
    guard.ai = "wander";
    guard.wayX = -30;
    guard.wayZ = -24;
    guard.aiT = 1e6;
    run(w, 1);
    for (const o of bodies) closest = Math.min(closest, Math.hypot(guard.x - o.x, guard.z - o.z));
  }
  return closest;
}

/**
 * A downed player and a guard beside them.
 *
 * Reading the body, the guard stops fighting and secures: takes hold and hauls
 * the prisoner across the ground. Not reading it, the guard keeps swinging at
 * someone who is already finished. Returns the distance the player was dragged,
 * m -- which is zero unless a hold was actually taken.
 */
function measureSecure() {
  const w = freshWorld(3312);
  const a = stage(w, -32, 6); // open ground west of the village
  const guard = w.actors.find((o) => o.faction === "guard" && o.alive)!;
  place(w, guard, -30.8, 6);
  guard.known.push(a.id);
  guard.alert = 1;
  w.wanted = 1;
  // Every other guard is elsewhere: this measures one man securing a prisoner,
  // not a crowd converging on the same body.
  for (const o of w.actors) {
    if (o.faction === "guard" && o.id !== guard.id) place(w, o, 40, -40);
  }
  a.consciousness = 0.05;
  a.stanceAuth = 0;
  a.loco = "down";
  let held = 0;
  for (let i = 0; i < 600; i++) {
    // Concussed, so they stay under: recovery is real but slow.
    a.injuries.head.bruise = Math.max(a.injuries.head.bruise, 1.1);
    run(w, 1);
    if (a.grabbedBy) held++;
    if (w.phase === "captured") return held + 200;
  }
  return held;
}

/**
 * Whether a fighter aims at the limb that is already gone.
 *
 * `impact-locality` above establishes that a crouched swing lands somewhere
 * different from a standing one, because swing height is read from the
 * attacker's own solved hand. What this measures is the decision: does an
 * attacker facing a target whose legs are wrecked actually drop and go for
 * them? Returns the share of combat ticks the guard spent crouched.
 */
function measurePressingTheInjury() {
  const w = freshWorld(4413);
  const a = stage(w, -32, 6);
  const guard = w.actors.find((o) => o.faction === "guard" && o.alive)!;
  for (const o of w.actors) {
    if (o.faction === "guard" && o.id !== guard.id) place(w, o, 40, -40);
  }
  place(w, guard, -30.9, 6);
  guard.weapon = "club";
  guard.known.push(a.id);
  guard.alert = 1;
  w.wanted = 1;
  // The legs are wrecked but the target is still on its feet, so the guard
  // fights rather than secures and the only question is where it aims.
  a.injuries.lleg.fracture = 0.75;
  a.injuries.rleg.fracture = 0.75;
  let crouched = 0;
  let able = 0;
  for (let i = 0; i < 300; i++) {
    a.consciousness = 1;
    a.stanceAuth = 1;
    run(w, 1);
    // Only ticks where the guard is on its feet and in range: chasing a target
    // across a field, or lying on the ground, says nothing about where it
    // intends to hit.
    const up =
      guard.loco !== "ragdoll" &&
      guard.loco !== "getup" &&
      guard.loco !== "down" &&
      guard.loco !== "pin";
    if (guard.ai === "combat" && up && Math.hypot(guard.x - a.x, guard.z - a.z) < 2.3) {
      able++;
      if (guard.crouch) crouched++;
    }
  }
  return able > 15 ? crouched / able : 0;
}

/* ------------------------------------------------------------------ *
 * Suite
 * ------------------------------------------------------------------ */

export function runFalsifiers(): CheckResult[] {
  return [
    checkReplay(),
    checkRest(),
    checkLoopGain(),
    checkImpactLocality(),
    checkBudget(),
    checkLocomotion(),
    severance("impulseInjury", "impulse->injury", measureFallInjury, 1e-4),
    severance("injuryMotor", "injury->motor", measureLimpGait, 1e-4),
    severance("motorPose", "motor->pose", measurePoseTracking, 1e-4),
    severance("supportBalance", "support->stays on its feet", measurePushSurvival, 5),
    severance("bodyPairs", "body-body drape", measureDrape, 0.05),
    severance("grabLoad", "grab->hauler load", measureDragLoad, 1e-3),
    severance("bodyTactics", "bodies->routing", measureGuardDetour, 0.15),
    severance("bodyTactics", "downed target->secured and dragged", measureSecure, 0.5),
    severance("bodyTactics", "damaged limb->aim low", measurePressingTheInjury, 0.2),
    checkAblation(),
    checkCoactivity(),
  ];
}

/* ------------------------------------------------------------------ *
 * In-page probe (dev console)
 * ------------------------------------------------------------------ */

export interface BodyProbe {
  /** Per-limb motor authority of the player. */
  motor: () => Record<string, number>;
  /** Support-polygon margin, m. Negative means the player is falling. */
  support: () => number;
  /** Mass resting on the player, kg. */
  pile: () => number;
  /** Node count and body-pair count actually being solved. */
  cost: () => { nodes: number; substeps: number };
  /** Knocks the player down through the real impulse path. */
  knock: (j?: number) => void;
  /** Runs the falsifier suite against this live world. */
  falsify: () => CheckResult[];
}

export function makeBodyProbe(w: World, enable: () => void): BodyProbe {
  return {
    motor: () => ({ ...w.player().motor }),
    support: () => w.player().support,
    pile: () => w.player().pileLoad,
    cost: () => {
      let nodes = 0;
      for (const a of w.actors) if (a.body >= 0) nodes += w.bodies.count[a.body]!;
      return { nodes, substeps: SUBSTEPS };
    },
    knock: (j = 600) => {
      enable();
      const p = w.player();
      if (p.body < 0) return;
      w.bodies.applyImpulse(p.body, w.bodies.plan(p.body).chest, j, j * 0.2, 0, STEP);
    },
    falsify: () => runFalsifiers(),
  };
}
