# SUNDER — operating instructions

Domain layer. The user's global operating rules (§0–§9, P1–P10) still govern;
where this file and a global rule disagree, §0 arbitration decides. `AGENTS.md`
is the sandbox contract and says nothing about engineering quality — this does.

Notation: `!X` prohibited. `=>` then. `⊢` must hold before emission. `A>B` A
outranks B. `ev:` a real observation from this codebase, cited because it is
the rule firing, not because it is history.

---

## §S0 THE STANDARD

Sunder is not aiming at "realistic", "polished", or "feature-complete". It is
aiming at two discriminators, and every decision below serves them:

1. **The player can cause something nobody scripted, understand why it
   happened, and fail to reproduce it by repeating the input.**
2. **It survives pause-and-step.** Not "looks fine in motion" — correct frame
   by frame, at the distance a suspicious player would stand.

Competent implementations fail (1) by scripting outcomes and (2) by hiding
seams in motion blur. Both failures are invisible to a feature checklist and
obvious to a player. Treat them as the only two ways to lose.

---

## §S1 THE GATE — ⊢ before any Sunder change is done

Not "it works". All six, stated explicitly to yourself, in this order:

- **G1 Coupling.** Compound work: name ≥3 consequential system roles it binds
  into one authoritative causal graph, carrying at least one state-changing
  `A -> B -> C` path or a justified bounded loop. Pure fan-out — one producer
  read by several passive consumers — does not qualify. Prefer one deeper truth
  spanning those roles. Legitimate leaf or focused work => §S4.
- **G2 Severance.** A new phenomenon has an `EDGES` entry and a falsifier in
  `probe.ts` whose measured number **changes when the edge is cut**.
  `npm run test:substrate` green. A phenomenon with no severance test is a
  claim, not a mechanism.
- **G3 Determinism.** `replay` still passes. No ambient clock, unseeded RNG,
  `Map`/`Set` iteration order, or float-order dependence introduced.
- **G4 Frame test.** Name the frame at which it breaks under pause-and-step.
  Fix it, or state it as a known limit. "I could not find one" is not an answer
  until you have looked at the specific worst case.
- **G5 Budget.** ms/tick measured before and after. Not estimated (§S6).
- **G6 Ceiling.** Name the next two things this change makes cheap.

Cannot state G1 and G6 => you built a trick. Build the substrate instead.

---

## §S2 SEARCH — run before building, not after it fails

The frontier is found by fixed cheap searches, not by inspiration. Run S1–S3
on every non-trivial task; S4–S5 whenever the work is user-visible.

- **S1 Fake ledger.** Grep the subsystem for: fields declared and never read;
  magic constants standing in for a relationship; a `switch` on a state name
  where a continuous quantity belongs; effects computing their own magnitude
  locally. **Every hit is a candidate for promotion to a real simulated
  relationship, and this is the highest-yield search in the repository.**
  `ev:` `Prop.load`/`capacity` were declared and read by nothing; collapse was
  drawn at a hardcoded `rotation.z = 0.8`. Promoting both produced structural
  load cascade — a whole mechanic that was already half-declared in the types.

- **S2 Assumption audit.** Every empirical law encodes an unstated assumption
  about its domain. Before extending a law to a new caller, **write the
  assumption down and check it holds for that caller.**
  `ev:` `impulseDamage(v)` took speed alone, silently encoding "the striker
  carries the victim's own limb mass". True for a fall; false for a 90 kg beam
  — which could therefore shove you but was structurally incapable of hurting
  you. The falsifier found a symptom; the assumption was the bug.

- **S3 Readout vs solver.** For any quantity read out of a solver, ask whether
  the variable the solver uses to converge is the variable that carries
  meaning. It usually is not.
  `ev:` `(p − o)/h` read after projection reported 38 m/s of closing speed
  between two men standing still, because it bills the solver's own corrections
  as impact.

- **S4 Cross-product.** List what already runs in `stepWorld` (perception, AI,
  combat, grab, locomotion, physics, bodies, trips, injury, fire, props,
  structures, tracks) and the shared grid fields (`heat fuel wet oil smoke char
  burning indoor`). Find the pair with no edge between them that should have
  one. **A missing edge is cheaper than a new system and usually worth more.**

- **S5 Adversarial distance.** State where the player stands and how slowly
  they move to see the seam. If you cannot name that vantage, you have not
  looked at the thing you built.

---

## §S3 MECHANISM SELECTION

When several mechanisms would work, rank by:

1. causal reach and depth — the state-changing roles and edges it creates,
   counting fan-out to passive readers for nothing;
2. whether it **removes** a special case rather than adding one;
3. whether it **generalizes an existing law** rather than paralleling it;
4. whether it survives §S0.2;
5. cost.

Prefer one deeper mechanical truth that naturally couples several roles over
parallel mechanisms, whenever it still preserves the objective.

Standing preferences:

- **Generalize > parallelize.** `ev:` effective mass entered the damage law as
  `sqrt(m_eff/m_limb)` — the same algebraic shape as contact concentration, and
  **exactly 1 for every world contact**, so all fall calibration survived
  untouched. A separate "crushing damage" system would have been cheaper to
  write and would have needed its own tuning forever.
- **Continuous scalar > state enum**, wherever the states are one phenomenon at
  different magnitudes. `ev:` motor authority replaced ragdoll / stumble / limp
  / get-up as four states with transitions between them.
- **Field > per-object flag**, wherever the quantity is spatial.
- **Representation change > correction term**, once it is the third correction
  (§S5).
- Depth is not obscurity. Take the mechanism from wherever it lives — rigid-body
  dynamics, control theory, biomechanics, constraint solving, signal
  processing, geometry, numerics, or one unexpectedly simple idea with enormous
  leverage. The source does not score points; the consequences do.
- **!Sophistication without consequence.** Before implementing, state in one
  sentence what the player will newly **see, feel, control, or cause**. Cannot
  state it => do not build it.

---

## §S4 COUPLING — the multiplication rules

- **One truth, many consumers.** Before adding state, find the existing
  quantity that already means this. Two systems carrying their own version of
  the same truth is a defect (§S5 E5).
- **Multiplication threshold.** In compound work, a new physical quantity must
  participate in ≥3 consequential system roles across the same causal graph,
  including at least one state-changing downstream consumer. Three passive or
  effect-only readers do not qualify — that is one truth displayed three ways,
  and it is still a variable. Legitimate focused or leaf work carries no
  artificial reader quota.
- **No effect invents its own magnitude.** Camera shake, sound, particles,
  decals, hitstop, AI reaction and HUD all read the same recorded event
  numbers. Seven independent versions of one event is the signature of a weak
  implementation, and it is why such impacts never feel heavy.
- **Grade the work.** Consequence count alone does not define depth: three
  passive readouts are still one feature. Mechanic and substrate value comes
  from state-changing causal propagation and from consequences you did not
  enumerate. Aim for substrate; accept a mechanic; a feature needs a reason.
- Worked target shape: one damaged leg should reach stance, gait, reach,
  attack generation, evasion, balance margin, climbing, fall behaviour and
  enemy target selection **through one scalar** — not through nine call sites
  that each check an injury number. Prefer one authoritative scalar or field
  propagating into many behaviours over call-site conditionals, but fan-out is
  reuse and expression, not proof of compound coupling. What earns that claim
  is consumers changing state that other consumers then read.

---

## §S5 ESCALATION — breaking local maxima

Stop patching and change the representation when **any** of these fires:

- **E1** the third consecutive fix in one subsystem adds a special case;
- **E2** a fix needs a constant with no physical name;
- **E3** the falsifier passes and the observed behaviour is still wrong (=> the
  check is the bug, §S6);
- **E4** the mechanism cannot express something a player would obviously try;
- **E5** two systems each carry their own copy of one truth.

On escalation: state the limiting representation in one sentence, state what
the new one makes possible, then change it. Do not request permission to
replace a representation you can demonstrate is the limit — do state the delta
(§9).

`ev:` prop discretization went 4 corners => alternating spine => grid + shape
matching. The first two were patches to a representation that was wrong; only
the third stopped generating symptoms (beams passing through people, chests
swallowing whoever stood on them, frames ejecting bodies at solver speed).

---

## §S6 EVIDENCE

- Falsifiers arbitrate, not intuition. **But a falsifier that runs in the live
  world measures the live world** — isolate what the check names.
  `ev:` `budget-monotonic` was partly measuring a market brawl, because
  dropping the player into the market makes the neighbours attack.
- **A check that cannot fail is not a check.** When a check passes and the game
  is wrong, fix the check first, then the code.
- `!Assert` ran / tested / passes / measured without the command's output. Perf
  is ms/tick, measured, before and after — never an adjective.
- **One probe per unknown, then commit.** `!Research theater`, `!framework
  before the second caller exists`, `!speculative abstraction`. Depth belongs
  in the mechanism, not in the deliberation about it.

---

## §S7 EMBODIMENT — motion, animation, combat

- **Characters solve actions; they never play them.** Motion is an output of
  pose targets, motor authority, contact and momentum. `!Clip selected by
  state`, `!canned transition`, `!animation that position-writes the body`.
- **The renderer reads solved state and never writes it.** Anything the player
  sees a body do must be true in the solver first. This is why a limp reads as
  a limp: nothing in `render.ts` knows what a limp is.
- **Continuity is the standard.** Controlled motion → partial loss → impact →
  stumble → catch → fall → get-up → grapple must be **one continuous
  quantity**, not a transition table. A proposed new motion state that cannot
  be expressed as a value of an existing continuous quantity does not belong;
  find the quantity.
- **Whole-body participation.** An action is finished when the limbs *not*
  performing it also respond: counterweight, gaze, footing, anticipation,
  follow-through, recovery. Half a body acting is the tell that separates
  functional from elite, and it is visible instantly.
- **Intent ≠ achievement.** What the player asks for and what the body manages
  are different quantities and must stay different variables. `!Let intent
  write position directly` — that is where responsiveness is bought by
  destroying physicality, and it can never be bought back.
- **Contact is the currency.** Anything that touches anything should do so
  through the node contact path, so that it participates in impulse, injury,
  support, load, friction and sound **without being told to**. A new interaction
  that needs its own collision code is usually a §S5 signal.

---

## §S8 CAUSALITY — visual and audio feedback

- **Effects are consequences.** Every effect names the simulated quantity it
  reads. No quantity => no effect.
- **Weight comes from agreement, not amplitude.** An impact reads powerful when
  body, camera, sound, debris, deformation, light and the victim's subsequent
  balance all move from the same numbers. **Adding a bigger particle burst to a
  weak impact makes it worse**, because the disagreement is what the player
  actually perceives.
- **Destruction follows the mechanism**: what broke, where, along which
  constraint, under which load. A visual result that does not follow the
  physical cause is decoration and will not survive §S0.2.
- **Audio is synthesized from state** (`audio.ts` is oscillators and filtered
  noise — no samples). A sound whose parameters do not vary with the physical
  quantity is a sample in disguise; give it the quantity.
- `!Add an effect to compensate for a mechanism that is not producing the
  feeling.` Fix the mechanism. Effects cannot rescue a weak simulation and
  reliably make it read as cheaper.

---

## §S9 BUDGET

- The real numbers: fixed `STEP = 1/60` with ≤5 catch-up steps and render
  interpolation by `alpha`; 4 XPBD substeps; measured ~2.0–2.5 ms/tick at 34
  actors and 96 prop frames, against 16.7. **Headroom is capital. Spend it on
  coupling; do not hoard it.**
- Performance limits are an engineering problem, **never a licence to be
  primitive**. Buy apparent complexity from bounded computation: sleeping,
  adaptive fidelity by perceptual salience, temporal coherence, analytic closed
  forms, shared fields, precomputation, procedural synthesis, pooling,
  hierarchy, batching, constraint prioritization, reduced models.
- P1 holds across the whole tick: zero steady-state allocation, SoA typed
  arrays, preallocated pools, monomorphic shapes.
- **Cost is justified by consequence count, not by realism.** 0.5 ms read by
  six systems beats 0.1 ms read by one.

---

## §S10 INTEGRATION

- **Read the authority boundaries first**: who owns this number, who may write
  it, where in `stepWorld` order, and what reads it afterwards. State the order
  before changing it.
- **Two systems that exchange state within a tick must be interleaved, not
  sequenced.** A system that runs after its consumer is talking to a corpse.
  `ev:` prop frames ran after bodies, so a beam's contact landed after the tick
  had already turned impulses into injury, and the next tick's snapshot wiped
  it.
- **Extend the existing machine.** A new parallel system that resembles
  integration is worse than no system, because it looks finished.
- **Exploit latent capability before adding abstraction.** If the node store,
  the solver, the shared fields or the reader already support the thing, use
  them.
- Preserve working behaviour unless replacing it breaks a demonstrated limit
  (§S5). When you do replace, state the blast radius.

---

## §S11 EXECUTION

- **Every task has two objectives**: solve the immediate problem completely,
  and raise the ceiling of what Sunder can subsequently become (§S1 G6).
- **Ambition is grounded.** Inspect the source. `!Assert an API, constraint,
  field or behaviour you have not read.` Distinguish what exists from what
  could exist.
- Once the mechanism is understood, **execute decisively**.
- Report faithfully: what you ran, what it printed, what you left out and why.

---

**Governing standard: maximum realized game quality per unit of justified
complexity.** Complexity is paid for by player control, physical credibility,
mechanical possibility, audiovisual impact, systemic interaction, emergent
consequence, animation continuity, environmental embodiment, robustness under
unusual situations, or reusable capability that amplifies future systems.
Complexity that buys only abstraction, code volume, mathematical ornamentation,
simulation cost, or intellectual impressiveness is rejected.

**Nothing above describes a ceiling.** The mechanisms cited as `ev:` are
examples of the rules firing, not the state of the art for Sunder. When the
rules point past them, go.
