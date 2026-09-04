# SUNDER - ChatGPT Codebase Dossier

## Purpose

This is the rolling technical memory for the `ChatGPT-version` branch.

Read this before making substantial changes. It is not a substitute for reading the source that a change touches. Its job is to restore the high-level mental model quickly, preserve architectural discoveries across long development sessions, and prevent future work from treating visible behavior as if it were the underlying mechanism.

Update this document when a change materially alters architecture, authority, subsystem ownership, runtime ordering, persistent state, or a major expansion seam. Do not bloat it with ordinary patch history.

**Source baseline deeply analyzed:** `fb82dd1e776cf440ec69c213e8d66492f141e2ad`

**Canonical working branch:** `ChatGPT-version`

---

# 1. Product thesis

SUNDER is a compact third-person systemic sandbox set in Harrow's Ford. Its strongest identity is not authored missions. It is causal interaction among a body, townspeople, guards, animals, props, structures, weather, fire, visibility, sound, injury, fear, pursuit, tracks, and memory.

The intended player fantasy is direct physical agency inside a world that reacts:

- move, sprint, crouch, jump, vault, climb, swim;
- strike, kick, shove, grab, drag, carry, throw;
- pick up weapons and combustible objects;
- break stalls, walls, supports, lamps, fences, and structures;
- spill oil and ignite terrain;
- injure bodies by region;
- create sound and visual evidence;
- trigger witnesses, fear, guard pursuit, search, rescue, fire response, animal flight, hunting, and structural collapse.

The code already supports real causal chains. A representative chain is:

`player action -> actor/prop impulse or damage -> oil/fire/sound -> perception + memory -> fear/wanted/AI transition -> pursuit or flight -> secondary collisions/fire -> structural collapse -> injury/death -> more fear/memory/pursuit`

That chain is the core asset to preserve and deepen.

---

# 2. What is actually product code

## Primary game surface

- `src/game/types.ts` - domain schema, constants, weapon stats.
- `src/game/world.ts` - authoritative world container, factories, seeded RNG, spatial hash, shared geometry/helpers.
- `src/game/level.ts` - procedural/code-authored construction of Harrow's Ford and initial population.
- `src/game/sim.ts` - causal simulation spine. Most gameplay semantics live here.
- `src/game/game.ts` - lifecycle, fixed-step accumulator, render interpolation, HUD projection, save cadence, audio event drain.
- `src/game/render.ts` - Three.js scene construction and visual projection of world state.
- `src/game/input.ts` - keyboard, mouse, pointer lock, touch, gamepad, virtual controls.
- `src/game/audio.ts` - procedural WebAudio SFX and ambient beds.
- `src/game/save.ts` - localStorage snapshot format.
- `src/components/sunder-app.tsx` - React boot bridge around the imperative game.
- `src/components/sunder-hud.tsx` - title, status, touch controls, HUD.
- `src/styles.css` - visual tokens, fullscreen behavior, Fold/phone touch layout.

## Platform/support surface

`AGENTS.md`, `.grok/**`, `scripts/**`, `server/**`, prewired `src/lib/**`, generated `.vercel/output/**`, and App Builder support files are platform/runtime infrastructure unless a requested capability genuinely crosses into them.

Do not casually refactor platform infrastructure while modifying game systems.

---

# 3. Authority model

## The single authoritative simulation state

`World` is the center of gravity.

It owns:

- global time, day phase, rain, wind, thunder;
- actors;
- props;
- buildings;
- colliders;
- tracks;
- sounds;
- whispers;
- fire/environment scalar fields;
- spatial hash;
- transient simulation events;
- wanted level;
- fire count;
- camera trauma/hitstop signals;
- phase/death/capture state;
- seeded RNG state.

Actors and props are mutable records. Systems mutate these records in place.

There is no separate ECS authority, physics-engine authority, animation-state authority, navmesh authority, or replicated server state.

React is not authoritative gameplay state. The HUD is projected from `World` each frame.

Three.js is not authoritative gameplay state. Render objects interpolate and visualize `World` records.

This distinction is critical. Future upgrades should normally enrich authoritative world state first and make rendering consume it, rather than creating visually convincing parallel state that the simulation does not know about.

---

# 4. Runtime loop and causal ordering

`Game.frame()` uses a fixed simulation step:

- `STEP = 1 / 60`.
- wall-clock delta is clamped to 0.1 s;
- accumulator runs at most 5 fixed substeps per rendered frame;
- rendering interpolates between previous and current simulation transforms;
- title mode still advances much of the world simulation, but player control is not applied;
- hitstop can suspend fixed-step advancement while still rendering.

The order inside `stepWorld()` is a semantic contract:

1. clear transient events;
2. advance clock/weather;
3. copy previous actor/prop transforms;
4. rebuild actor spatial hash;
5. apply player intent;
6. perception;
7. AI decision/intent;
8. combat;
9. grabbing/carrying;
10. locomotion state classification;
11. physics/integration/collision;
12. injury/bleeding/consciousness/death;
13. fire/environment fields;
14. prop consequences;
15. structural failure;
16. tracks/evidence;
17. sound culling;
18. decay shake/hitstop.

Future systems must be inserted based on causality, not convenience. Moving a pass can alter gameplay because later passes observe earlier mutations during the same tick.

Example: combat creates injury and impulses before physics; physics moves the victim; injury then evaluates bleeding/consciousness; fire then affects bodies/props; structures can then fail and apply further injury.

---

# 5. World scale and current population

## Spatial scale

- world width: `88` units;
- half extent: `44`;
- fire/environment cell size: `2`;
- fire grid: `44 x 44 = 1936` cells;
- actor spatial-hash cell size: `4` units.

## Initial actor population

Current level construction produces approximately 34 actors:

- 1 player;
- 12 civilians;
- 7 guards;
- 1 hunter;
- 5 livestock;
- 4 deer;
- 3 wolves;
- 1 bear.

`MAX_ACTORS = 64` exists but is not currently enforcing population.

The map is authored through code, not external scene data. Buildings, market stalls, forest, river, bridge, livestock pen, homes, barracks, tavern, warehouse, weapons, fuel, and population are all instantiated in `level.ts`.

World generation is largely seeded through `World.rng()` once `Game` assigns a seed from time.

---

# 6. Simulation systems

## 6.1 Movement and body state

Player input generates intent vectors and desired speed in camera space.

Movement modifiers already include:

- crouch;
- sprint stamina/fatigue;
- leg injury;
- carried mass;
- mud;
- consciousness;
- grabbed targets;
- surface friction/acceleration;
- water drag and buoyancy-like vertical force.

Locomotion is a state classification over the same actor record:

`idle / walk / run / sprint / crouch / crawl / stumble / fall / getup / vault / climb / swim / ragdoll / pin / down`

Important reality: current `ragdoll` is **not an articulated ragdoll solver**. The actor remains a single simulated body record. The renderer tilts the whole humanoid group and simple limbs are animation children. There is no multi-body skeleton, joint constraint graph, angular momentum model, per-limb collision, or authoritative pose state.

That makes articulated physical humans a genuine future substrate upgrade, not a cosmetic tweak.

## 6.2 Collision and physics

The current physics layer is custom and deliberately lightweight:

- gravity + velocity integration;
- adaptive micro-substeps based on travel distance;
- circle-vs-AABB actor collision;
- vertical floor/ceiling resolution;
- limited step-up logic;
- O(n^2) actor separation;
- simple mass-weighted body separation impulses;
- basic dynamic prop integration;
- mostly static world colliders;
- emergency `unstickActor()` escape search.

It is not a general rigid-body engine.

Dynamic props do not form a full contact graph with actors and one another. Structural debris becomes visually/dynamically loose but collapsed prop colliders are disabled rather than converted into rich persistent debris collision.

This is one of the largest available expansion frontiers.

## 6.3 Perception, memory, and evidence

Actors perceive through:

- sound events;
- approximate visual range;
- FOV dot tests;
- smoke attenuation;
- crouch/motion modifiers;
- indoor/outdoor modifier;
- sampled line-of-sight through colliders;
- nearby fires;
- bodies;
- known threats.

Actor memory records:

`threat / body / fire / sound / track / theft / ally`

Each memory has time, position, subject id, and certainty. Certainty decays and old memories expire.

Guards can share threat knowledge by shouting. Tracks can redirect searches after line-of-sight is lost.

This is a strong existing seam for richer knowledge, witness, rumor, suspicion, faction, and historical-world systems.

Current LOS is heuristic - six samples along the line - not geometric ray casting.

## 6.4 AI

AI is stateful but not planner-based.

Human states include:

- wander/work routines;
- investigate;
- pursue;
- search;
- combat;
- flee;
- rescue;
- extinguish.

Behavior depends on faction, courage, fear, aggression, loyalty, competence, memory, target visibility, fire proximity, injuries, and wanted level.

Notable systemic behavior already present:

- civilians panic and spread fear;
- guards fight, call allies, search last-known positions, follow tracks, and extinguish fire;
- wounded allies can be grabbed and carried toward home;
- deer/livestock flee humans, predators, violence, and fire;
- livestock can damage fences while escaping;
- wolves choose prey and can become interested in a bleeding player;
- bears hunt nearby bodies depending on aggression/proximity.

Navigation is direct steering toward target positions. There is no path planner or navmesh. Collision resolution and unstick logic compensate for obstacles.

## 6.5 Combat and injury

Weapons are data-driven through `WEAPON_STATS`:

- mass;
- reach;
- speed;
- blunt;
- cut;
- pierce;
- fire.

Combat supports strike, kick, shove, grabbing, carrying, and throwing.

Actors have six injury regions:

`head / torso / left arm / right arm / left leg / right leg`

Each region tracks:

`bruise / cut / puncture / burn / fracture / sprain`

Consequences include pain, bleed rate, blood volume, consciousness loss, balance loss, locomotion degradation, ragdoll/stumble transitions, death, and visible HUD injury state.

The system is regional but not anatomically articulated. Hit location is selected heuristically rather than derived from limb collision geometry.

One authoritative nondeterminism leak exists here: consequential hit-region/scream decisions use bare `Math.random()` instead of `World.rng()`. Render/audio randomness is non-authoritative, but combat randomness prevents exact deterministic replay.

The per-strike hit mask uses `1 << (actor.id % 30)`. Distinct actor ids can alias once ids differ by 30, which becomes a scaling constraint as population grows.

## 6.6 Grabbing and physical agency

The grab system is one of the strongest direct-agency mechanisms.

The player can acquire a nearby actor or prop in front of the body. Mass and balance affect whether an actor grab succeeds. Held actors and props are attached to the holder's authoritative transform each step. Releasing converts the relationship into an impulse, enabling throws.

AI rescue reuses the same actor-to-actor grab relationship rather than inventing a separate rescue representation.

This reuse is architecturally valuable and should be preserved when deepening interactions.

## 6.7 Fire, weather, and environmental fields

The fire system is a 44x44 scalar-field simulation using typed arrays:

- `fuel`;
- `heat`;
- `wet`;
- `oil`;
- `smoke`;
- `char`;
- `burning`;
- `indoor`.

Interactions include:

- rain increases outdoor wetness and can extinguish fire;
- wind biases heat spread;
- oil increases fuel and spread potential;
- lamps/flasks can spill oil;
- burning terrain heats/injures actors;
- wet actors resist ignition better;
- burning cells damage flammable props;
- indoor smoke reduces breath/consciousness;
- burned ground changes visually;
- rain alters visibility/hearing and rendering.

This is an excellent systemic substrate because several gameplay domains share the same fields.

Current scaling costs to remember:

- `stepFire()` copies the full heat array each fixed tick;
- every cell is scanned each tick;
- burning-cell logic scans props;
- `closestFire()` scans the entire fire grid for each AI actor;
- renderer repaints the whole ground color grid every rendered frame.

At the current world size this is acceptable. A much larger map, denser population, or several additional environmental fields should not simply multiply these loops.

## 6.8 Structural destruction

Buildings own part ids and support ids.

Supports are props with HP. When surviving support count drops to roughly half or less, the building collapses. Collapse:

- marks the building collapsed;
- emits sound;
- increases camera shake;
- collapses all parts;
- launches pieces;
- disables corresponding static colliders;
- injures/ragdolls actors inside;
- increases fear and wanted level.

Important reality: `Prop.load` and `Prop.capacity` exist, but current structural failure is support-count/HP based. There is no authoritative load path, stress transfer, torque, fracture propagation, or contact-supported debris structure yet.

Those fields are expansion seams, not evidence that those mechanics already exist.

## 6.9 Tracks, wanted state, and social consequence

The player can leave footprints on suitable wet/dirt/mud surfaces and blood tracks while bleeding. Rain shortens evidence lifetime. Guards in search mode can follow player tracks.

`wanted` is a global scalar. It rises from violence against civilians/guards, theft, structural destruction, and some deaths. Guards treat it as part of hostility logic.

The system already has the beginnings of history and witness behavior but not a full crime/witness graph. `known[]`, memories, sounds, tracks, and wanted are the current social substrate.

---

# 7. Rendering model

Three.js renders a projection of simulation state.

Current graphics strategy:

- shared primitive geometries;
- per-object/groups built at bootstrap or lazily;
- procedural canvas textures for wood/dirt;
- MeshStandardMaterial lighting;
- sun/hemisphere/ambient/fire fill lights;
- fog and day/night changes;
- pooled fire meshes;
- pooled smoke meshes;
- point-cloud rain;
- simple procedural humanoids and beasts;
- interpolation from previous to current transforms;
- camera trauma from `World.shake`;
- touch devices reduce shadows, antialiasing, pixel ratio, and rain count.

Humanoid visuals are box-based primitives. Arms and legs are render-only child groups driven by walk phase and attack state. They are not simulation bodies.

The camera is a smoothed third-person chase camera. It currently has no world occlusion/camera-collision solver.

Render-side randomness exists for foliage variation, rain initialization, and camera shake. That does not alter authoritative world state.

### Render scaling pressure

- full ground vertex-color repaint every frame;
- one group per actor/prop rather than instancing large homogeneous sets;
- many separately allocated materials;
- procedural primitive meshes are intentionally cheap, but visual fidelity expansion must respect mobile GPU limits.

The current architecture has room for much richer visuals, but visual upgrades should remain subordinate to authoritative state rather than becoming fake parallel simulation.

---

# 8. Input and device model

`Input` unifies:

- keyboard;
- mouse/pointer lock;
- touch joystick;
- touch look pad;
- touch action buttons;
- gamepad;
- injected test controls.

Movement is camera-relative. Digital and analog movement are normalized.

The HUD has explicit Galaxy Fold/phone handling:

- cover-screen aspect handling;
- near-square Fold inner-display handling;
- controls parked toward outer thirds;
- safe-area padding;
- touch look width changes by form factor.

This mobile interaction layer is part of the product, not an afterthought.

---

# 9. React/UI boundary

`SunderApp` dynamically imports and owns one imperative `Game` instance.

React responsibilities:

- canvas lifecycle;
- HUD state snapshots;
- title/pause/dead/captured overlays;
- touch controls;
- mute/pause/restart/wake commands.

`Game.pushHud()` constructs a new HUD projection every frame and calls React state through `onHud`.

This is simple and currently functional, but it creates a high-frequency React update boundary. If the HUD becomes much richer, it should not be allowed to turn the render loop into React churn.

The current built browser QA baseline reports desktop and mobile HTTP 200, canvas present, no horizontal overflow, and no console/page errors.

---

# 10. Audio

Audio is procedural WebAudio rather than sample-asset driven.

It has:

- master/SFX/music buses;
- noise buffer synthesis;
- oscillator/noise bursts for event SFX;
- positional stereo panning from world events;
- rain/fire/drone ambient beds;
- danger/time-of-day modulation;
- short per-kind anti-spam cooldown.

Audio randomness is intentionally perceptual and non-authoritative.

---

# 11. Persistence reality

Persistence is local-only through `localStorage` key `sunder.save.v1`.

The save blob includes:

- time/day/weather;
- player position/yaw/blood/stamina/weapon/torch;
- burned cell ids;
- collapsed building ids;
- dead actor ids;
- wanted level.

Current restore behavior is **partial**. It restores player/global weather state and burned cells, but does not currently replay the saved `collapsed` or `dead` arrays into the reconstructed world. It also does not preserve the full mutable state of injuries, props, memories, tracks, fires, oil, AI, grabbed relationships, or structural part damage.

There is a backup key written, but `loadSave()` currently does not fall back to it.

Therefore current persistence should be understood as a lightweight continuity snapshot, not a serialized authoritative world.

Any future promise that "the world remembers what actually happened" across sessions will require a deliberate persistence upgrade.

---

# 12. Hidden invariants and coupling to preserve

1. `World` is authoritative. Do not introduce a second mutable gameplay truth casually.
2. `stepWorld()` ordering is causal behavior.
3. actor `px/py/pz/pyaw` are render interpolation history and must be captured before simulation mutation.
4. spatial hash is rebuilt once near the start of a fixed tick. Several later systems assume movement per tick is small relative to the 4-unit hash cell.
5. collapsed structural props disable their static colliders.
6. AI uses the same actor state and interaction relationships as the player where practical.
7. sound is both gameplay information (`World.sounds`) and an audio-render event (`World.events`).
8. fire fields are authoritative gameplay state, not visual particles.
9. `World.rng()` is the intended authoritative random stream.
10. rendering and audio may use nondeterministic cosmetic randomness, but simulation randomness should use the world stream when replayability matters.
11. desktop, touch, gamepad, and Fold layouts share one input/action contract.
12. React must remain a shell/projection around the simulation, not become the 60 Hz gameplay engine.

---

# 13. Expansion-pressure map

These are not instructions to refactor immediately. They are the places where sophisticated expansions will hit the current substrate first.

## Highest-leverage systemic seams

### A. Articulated physical bodies

Current ragdolls are whole-body state changes with render-only limbs. A true body solver could unlock:

- limb contacts;
- joint limits;
- grabs at actual body parts;
- dragging by limbs;
- impact-local injury;
- body-to-prop force transfer;
- piles/crowds;
- physically grounded get-up and stumble behavior.

This is a major architecture extension and should be designed as authority, not animation decoration.

### B. Contact-rich props and debris

Current dynamic props are lightweight ballistic objects. Deepening prop/actor/prop contact would amplify throwing, collapse, traps, crowd chaos, and emergent destruction.

### C. Structural mechanics

Existing `support`, `load`, `capacity`, building parts, material, fire, HP, and collider links give a natural path from support-count collapse toward load-bearing structural behavior without replacing the entire game model.

### D. AI knowledge and social history

Memory, known threats, sound, tracks, fear, loyalty, wanted, routine, rescue, and faction already form a usable information substrate. This can become richer witness propagation, rumor, relationships, territorial knowledge, group tactics, and persistent consequences.

### E. Environmental field generalization

Fire/wet/oil/smoke already demonstrate coupled fields. Additional fields could support mud depth, scent, blood, heat, windborne smoke, visibility, structural heat, toxic gas, snow, or other systemic media - but only after avoiding full-grid/full-agent brute-force multiplication.

### F. Navigation and crowd motion

Direct steering is enough for the current scale. More actors, denser interiors, formation behavior, fleeing crowds, and long pursuits will expose the lack of path planning/local avoidance.

### G. Persistent history

The current save layer does not serialize the authoritative world. A deeper persistence model would make destruction, bodies, fires, relationships, injuries, and social knowledge survive reloads.

---

# 14. Scaling limits already visible

These are confirmed implementation properties, not speculative criticism.

- `World.actor(id)` and `prop(id)` use linear search.
- `separateBodies()` is O(n^2).
- `nearby()` allocates output arrays and a `Set` per query.
- `closestFire()` scans all 1936 cells for each AI actor.
- `stepFire()` scans the full field and allocates `w.heat.slice()` every fixed tick.
- burning-cell damage loops over props.
- ground colors are repainted over the whole fire-grid-sized mesh every rendered frame.
- HUD React state is updated every frame.
- line of sight uses sampled collider checks rather than a spatially accelerated ray query.
- actor strike hit bookkeeping aliases ids modulo 30.
- several schema fields (`load`, `capacity`, `weaponProp`, `pinnedId`, `MAX_ACTORS`) are unused or only partially realized.

Do not optimize these merely because they exist. Optimize when an intended expansion would make one a real capability or performance barrier.

---

# 15. Architectural interpretation

SUNDER's current strength is **coupling density**, not individual subsystem sophistication.

Each subsystem is relatively small, but many share the same authoritative state:

- fire affects actors, props, structures, visuals, sound, fear, AI, weather response;
- injury affects locomotion, blood, tracks, consciousness, AI threat interest, HUD, death;
- sound affects perception and pursuit while also producing audio;
- physical actions affect wanted state and social memory;
- structural failure affects collision topology, bodies, fear, sound, camera trauma, fire exposure;
- weather affects fire, wetness, visibility, hearing, rendering, and evidence lifetime.

That means the best future upgrades are usually those that **increase the number and quality of meaningful cross-system couplings** rather than adding isolated features.

A sophisticated feature that only renders differently is weaker than a smaller feature that changes simulation, perception, behavior, consequence, and history coherently.

---

# 16. Development doctrine for this branch

When expanding SUNDER:

1. inspect the exact authoritative source first;
2. identify which state is real and which state is projection;
3. trace all producers and consumers of the state being changed;
4. preserve `stepWorld()` causal semantics unless the change intentionally alters them;
5. prefer extending existing shared mechanisms over parallel special-case systems when the semantics genuinely match;
6. do not claim an underlying physical/social/environmental mechanism exists because a visual approximation resembles it;
7. make sophisticated upgrades visible and playable through direct player agency;
8. protect mobile/Fold interaction and performance as first-class constraints;
9. do not refactor unrelated working systems for cleanliness while implementing a requested expansion;
10. after a major architecture change, update this dossier with the new authority map and remove claims that are no longer true.

---

# 17. Fast mental reload

If only one section can be read before a future turn, remember this:

SUNDER is a custom Three.js systemic sandbox with one mutable authoritative `World` and a fixed 60 Hz ordered simulation pipeline. `sim.ts` is the causal core. Actors combine body state, regional injury, AI state, memory, social traits, locomotion, and interaction state in one record. Props combine material, damage, flammability, structural membership, and simple dynamics. Fire is a real typed-array field coupled to weather, actors, props, structures, smoke, wetness, oil, and visuals. AI is reactive state logic driven by perception/memory rather than planning. Physics is custom circle/AABB and ballistic integration, not a rigid-body or articulated solver. Rendering is a projection with simple primitive humans and whole-body pseudo-ragdolls. The current architecture is small enough to understand end-to-end and coupled enough to reward deep systemic upgrades. The main danger is adding visually impressive parallel systems that do not become authoritative causes in the world.