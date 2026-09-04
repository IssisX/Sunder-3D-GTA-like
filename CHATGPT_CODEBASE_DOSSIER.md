# SUNDER - ChatGPT Codebase Dossier

## Purpose

This is the rolling technical memory for `ChatGPT-version`.
Read this before making consequential changes to SUNDER.
It is not a feature list. It records the actual causal architecture,
authority boundaries, system couplings, scaling limits, hidden constraints,
and the highest-leverage paths for future expansion.

Last architecture refresh: 2026-09-04.
Baseline branch: `main`.
Working branch: `ChatGPT-version`.
Original fork point: `fb82dd1e776cf440ec69c213e8d66492f141e2ad`.

---

# 1. Product thesis

SUNDER is a small open systemic 3D world built around direct physical action
and visible consequences.

The useful mental model is not "GTA clone" and not "collection of mechanics."
It is a causal machine:

`player action -> physical/world change -> perception -> memory -> AI response
-> social/environmental consequence -> new physical state`

The game becomes better when new mechanisms couple into several existing
systems instead of living as isolated features.

Examples already present:

- a lamp can become a grabbed object, weapon-like object, breakable prop,
  oil source, fire source, sound source, AI stimulus, and structural hazard;
- blood loss affects consciousness, creates tracks, changes predator behavior,
  and can ultimately change movement state and death;
- fire changes actors, props, structures, visibility, fear, weather response,
  audio, rendering, and traversal conditions;
- a shout changes memory and pursuit rather than merely playing audio.

This coupling density is the project's strongest design property.

---

# 2. Real application surface

The product-bearing code is concentrated in:

- `src/game/game.ts`
- `src/game/types.ts`
- `src/game/world.ts`
- `src/game/sim.ts`
- `src/game/level.ts`
- `src/game/render.ts`
- `src/game/input.ts`
- `src/game/audio.ts`
- `src/game/save.ts`
- `src/game/body-model.ts`
- `src/game/body-contacts.ts`
- `src/game/body.ts`
- `src/game/body-render.ts`
- `src/components/sunder-app.tsx`
- `src/components/sunder-hud.tsx`
- `src/styles.css`

The large `.grok`, platform, generated `.vercel`, auth/data helper, and build
scaffold surfaces are support/environment code unless a requested change
actually crosses into them.

Do not mistake generated deployment output for source authority.

---

# 3. Runtime topology

React owns shell/bootstrap/HUD composition.
`Game` owns runtime lifecycle.
`World` owns canonical coarse game state.
`stepWorld()` is the original causal mutation spine.
`PhysicalBodies` now owns articulated human body state.
`View` and `BodyView` are projections.

Main runtime flow:

1. React mounts `SunderApp`.
2. The game module is dynamically imported.
3. `Game` constructs `World`, input, audio, Three.js `View`, and body system.
4. `buildLevel()` creates the deterministic starting world from `World.rng()`.
5. save state is restored into coarse world state.
6. physical human rigs are initialized from restored actor state.
7. Three.js renders continuously through `setAnimationLoop()`.
8. simulation advances in fixed 1/60-second steps.
9. each fixed step runs existing world simulation, then articulated body solve.
10. rendering interpolates both root/world state and physical body nodes.
11. HUD is projected from the current world state.

Fixed timestep:

`STEP = 1 / 60`

Frame accumulation is capped at five fixed steps per render frame.
Raw frame delta is clamped to 0.1 seconds.

Important consequence:

Simulation is fixed-step, but it is not yet globally deterministic because some
legacy gameplay and presentation paths still use `Math.random()`.
`World.rng()` is deterministic and should be preferred for authoritative new
simulation logic.

---

# 4. Authority model

## 4.1 World authority

`World` remains the canonical aggregate for:

- actors;
- props;
- buildings;
- collision volumes;
- tracks;
- sound events;
- whispers;
- weather;
- wanted state;
- fire/environment fields;
- phase/death/capture state;
- spatial actor hash;
- simulation RNG.

Actor root state remains the compatibility interface used by legacy systems:

- position/velocity;
- facing;
- locomotion state;
- balance;
- stamina/fatigue;
- injuries;
- consciousness;
- AI state;
- memory;
- grabbed relationships;
- weapon state.

## 4.2 Articulated body authority

Human/player body shape is no longer merely a render animation.

`PhysicalBodies` maintains a 15-node physical rig for each human:

- pelvis;
- chest;
- head;
- left/right shoulders;
- left/right elbows;
- left/right hands;
- left/right hips;
- left/right knees;
- left/right feet.

Body positions and previous positions are held in preallocated `Float32Array`
state. This gives each rig actual temporal inertia without per-frame body-node
allocation.

The articulated body is authoritative for dynamic human shape during:

- ragdoll;
- downed states;
- physical dragging/grabbing;
- stumbling;
- get-up recovery.

For compatibility, the actor root is derived back from the physical pelvis/body
state after dynamic solving.

Normal locomotion still uses the existing actor root as the movement authority,
with the articulated rig following a constrained target pose.

This is intentionally a bridge architecture: sophisticated body dynamics were
added without forcing AI, perception, combat targeting, camera, or existing
world queries to adopt an entirely new entity contract in one rewrite.

---

# 5. Original `stepWorld()` causal order

Order matters. It is semantics, not organization.

Current legacy world pass order:

1. clear per-step events;
2. advance clock/weather;
3. snapshot actor/prop previous transforms;
4. rebuild actor spatial hash;
5. apply player intent;
6. perception;
7. AI;
8. combat;
9. grabbing;
10. locomotion state;
11. root/prop physics;
12. injury physiology;
13. fire/environment field;
14. prop state;
15. structure failure;
16. tracks;
17. sound culling;
18. shake/hitstop decay.

`PhysicalBodies.step()` currently runs immediately after this pass inside each
fixed step.

That means articulated state affects rendered/body/root state immediately and
feeds legacy systems on the following fixed tick.

This is a deliberate integration boundary, not something to forget.
A later deeper integration can move the body solve between legacy physics and
physiology once the body substrate itself is proven stable.

---

# 6. Articulated physical body substrate

## 6.1 Ownership split

`body-model.ts`

- body topology;
- node indices;
- inverse-mass weighting;
- collision radii;
- anatomical link definitions;
- joint-range definitions;
- body rig allocation;
- follow target generation;
- body-mode selection;
- injury snapshots.

`body-contacts.ts`

- node/world collision;
- node/body collision;
- self-contact exclusions/guards;
- impact-speed measurement;
- region-local collision injury;
- pile contact;
- support-height query.

`body.ts`

- distance/joint solving;
- pose pinning;
- dynamic integration;
- external impulse transfer;
- physical grab constraints;
- drag load feedback;
- stumble destabilization;
- get-up solving;
- actor-root derivation;
- subsystem orchestration.

`body-render.ts`

- visible segmented humanoid projection;
- upper/lower limbs;
- physical hand/foot placement;
- physical head/torso/pelvis placement;
- weapons attached to the articulated hand;
- regional injury tinting;
- hiding the legacy flat/simple humanoid mesh.

## 6.2 Constraint model

The body is a particle/truss articulated solver rather than a hidden rigid-body
library.

It uses:

- anatomical distance constraints;
- torso cross-bracing;
- shoulder/hip width constraints;
- elbow and knee fold-range constraints;
- weighted inverse node mass;
- repeated projection iterations;
- world collision constraints;
- body-body contact projection;
- selected self-contact guards.

The torso is intentionally more rigid than distal limbs.
Hands and feet move more freely than pelvis/chest nodes.

## 6.3 Body modes

`follow`

Normal locomotion remains actor-root driven. The rig tracks an articulated walk,
crouch, attack, and kick target pose.

`stumble`

The rig becomes partially dynamic. Pelvis/chest/head/feet retain weak target
pins. Loss of torso rise, excessive lean, or low balance escalates the actor to
ragdoll.

`dynamic`

The body is gravity/inertia/contact driven. Used for ragdolls, downed/dead
bodies, and physically grabbed actors.

`recover`

The body remains collision constrained while progressively pinning toward an
upright pose. If it cannot approach that pose when the get-up timer expires, it
falls back to ragdoll instead of blindly standing through geometry.

## 6.4 Physical grabbing and dragging

Legacy actor relationships remain:

- holder `grabbedId`;
- victim `grabbedBy`.

The body layer converts that relationship into a physical constraint.

A grabbed human is attached at the nearest suitable body node to the holder's
articulated right hand. The selected grab node persists during the hold.

The body then:

- drags across geometry;
- collides limb-by-limb;
- can fold around obstacles;
- transfers load back into holder balance/velocity;
- participates in piles;
- receives region-local impact injury while dragged.

This same mechanism automatically applies to AI rescue because rescue already
uses the same grab relationship.

## 6.5 Piles and body-body contact

Dynamic/stumbling/recovering bodies collide through selected major contact
nodes rather than actor-root circles alone.

Follow-mode standing bodies behave as effectively fixed articulated obstacles
for dynamic body contact.

Two dynamic bodies split positional correction according to node inverse mass.
Relative contact speed can generate localized injury on either body.

This is the first real substrate for:

- body piles;
- falling onto another person;
- dragged bodies catching on people;
- crowd knockdown chains;
- bodies cushioning or worsening falls.

## 6.6 Impact-local injury

Physical collision injury is keyed to the actual body node that contacted the
world or another body.

Node-to-region mapping drives:

- bruising;
- limb sprain;
- high-energy fracture;
- head consciousness loss;
- pain;
- balance loss;
- stumble/ragdoll escalation.

Legacy weapon combat still computes its own region injury in `sim.ts`.
The body layer observes the changed region plus root impulse and injects the
external impulse into the corresponding physical limb/region so combat and the
new body solver visually/physically agree as much as possible without rewriting
combat yet.

A future upgrade should make weapon contact itself query the physical rig so the
same contact point owns both impulse and injury from the start.

---

# 7. Root physics reality

The original game does not use a general rigid-body engine.

Actor root physics includes:

- exponential velocity response toward intent;
- friction by surface;
- gravity;
- water drag/buoyancy-like behavior;
- substepped high-speed actor movement;
- actor circle vs AABB collision;
- vertical collider support;
- actor separation;
- dynamic prop integration;
- simple prop/collider resolution;
- unstick recovery.

The new human body solver sits above this legacy root model rather than deleting
it.

Do not claim full rigid-body simulation for every world object.
Humans now have articulated body physics; most props are still coarse single
bodies.

---

# 8. AI/perception substrate

AI is stateful and information-driven rather than purely distance-triggered.

Actors can retain memories of:

- threats;
- bodies;
- fire;
- sounds;
- tracks;
- theft;
- allies.

Human properties include:

- fear;
- courage;
- aggression;
- loyalty;
- competence;
- known actors;
- alertness;
- home;
- routines;
- last seen position/time;
- search target/time.

Human behaviors include:

- work/routine;
- wander;
- investigate;
- pursue;
- search;
- combat;
- flee;
- rescue;
- extinguish.

Animal behaviors include grazing/fleeing, predator hunting, and fence breaking.

The body substrate improves AI behavior indirectly because rescue, knockdown,
injury, dragging, and body location now have richer physical consequences
without requiring a second AI representation.

---

# 9. Combat and injury substrate

Weapons are data-driven through `WEAPON_STATS`:

- mass;
- reach;
- speed;
- blunt;
- cut;
- pierce;
- fire.

Combat currently combines:

- attack windows;
- reach and facing tests;
- impulse;
- balance loss;
- regional injury;
- bleeding;
- pain;
- consciousness;
- wanted state;
- sound;
- hitstop/shake;
- ragdoll/stumble transitions.

Regional anatomy:

- head;
- torso;
- left/right arm;
- left/right leg.

The articulated body now maps those six gameplay regions onto 15 physical nodes.
This is the critical bridge for future physically grounded combat.

---

# 10. Fire/environment field

World size:

`WORLD = 88`

Environmental cell size:

`FIRE_CELL = 2`

Grid resolution:

`44 x 44 = 1,936 cells`

Typed fields:

- fuel;
- heat;
- wet;
- oil;
- smoke;
- char;
- burning;
- indoor.

Fire couples:

- fuel consumption;
- oil;
- rain;
- wind;
- smoke;
- actor heat/burns;
- prop damage;
- structural failure;
- AI fear/perception;
- ground rendering;
- audio/light.

This remains one of the best substrates for high-value expansion because a new
field or material interaction can influence many systems at once.

---

# 11. Structures/destruction

Buildings group props into:

- parts;
- supports;
- bounds;
- indoor state.

Current structural failure is support-count/HP based, not load-path or continuum
structural simulation.

When enough supports fail:

- the building collapses;
- parts become dynamic;
- sound/shake propagate;
- occupants receive injury/knockdown;
- nearby actors gain fear;
- wanted state can rise;
- colliders are disabled as props collapse.

This system is strongly coupled but mechanically coarse.

---

# 12. Rendering reality

Three.js remains the renderer.

Main visual systems include:

- procedural dirt/wood textures;
- dynamic vertex-colored ground;
- day/night lighting;
- fog;
- rain points;
- fire/smoke meshes;
- water;
- props;
- beasts;
- articulated physical humans;
- camera trauma.

Human rendering is now a projection of the physical body rig instead of the old
single-segment procedural humanoid pose.

The legacy human render objects still exist because `View` owns mixed actor
rendering, but `BodyView` suppresses them before final render.

This preserves existing `View` behavior for beasts and avoids a dangerous broad
renderer rewrite.

---

# 13. Input/mobile reality

Input supports:

- keyboard;
- pointer lock mouse;
- touch;
- gamepad;
- injected controls test state.

The UI already contains Galaxy Fold-specific layout handling.

Touch UI routes into the same `Input` abstraction as desktop input.
Do not create parallel gameplay controls in React.

---

# 14. Persistence reality

Persistence uses localStorage save version 1.

It stores only a partial world snapshot:

- time/weather;
- player location/basic state;
- burned cells;
- collapsed building IDs;
- dead actor IDs;
- wanted state.

It does not persist full physical body rigs, AI memories, exact prop dynamics,
tracks, or all injuries/state.

On load, physical bodies are reconstructed from restored coarse actor state.
This is intentional for now.

If persistent world history becomes a major goal, the save model must be
expanded rather than pretending current continuity is complete.

---

# 15. Scaling pressure

Known pressure points from source inspection:

- actor root separation is O(n^2);
- actor/prop ID lookup uses array `.find()`;
- `closestFire()` scans the fire field for each AI actor;
- fire scans the full field every fixed tick;
- burning cells scan props;
- ground colors repaint the field every render frame;
- React receives HUD state every render frame;
- LOS is sampled against colliders;
- body-body contact is pairwise across humans, with node tests after coarse
  pelvis rejection;
- articulated rendering materially increases human draw count.

Do not preemptively "optimize everything."
Use these facts when a requested expansion actually approaches the relevant
limit.

---

# 16. Hidden invariants

Preserve these unless a deliberate architecture change replaces them.

1. Actor root remains the compatibility contract used by legacy AI/world code.
2. Fixed-step simulation remains authoritative over frame rate.
3. Render interpolation must never become gameplay authority.
4. Body rendering must follow body simulation, not maintain a second skeleton.
5. Human dynamic body state must derive back to actor root before the next
   legacy tick.
6. Existing grab relationships are shared by player grabbing and AI rescue.
7. Broken prop colliders must stop being solid.
8. Fire fields are authoritative environmental state, not particle effects.
9. `World.rng()` is the preferred RNG for new consequential simulation logic.
10. `main` is the original baseline; `ChatGPT-version` is the working canon.

---

# 17. High-value discoveries - current

## A. Physical humans are now a platform, not a feature

The highest-value result of the body work is not "better ragdolls."

There is now one physical representation that can increasingly own:

- weapon contact;
- grappling;
- falls;
- environmental impacts;
- crowd knockdowns;
- dragging;
- rescue;
- body piles;
- local injury;
- balance;
- physical recovery.

That creates a convergence point where previously disconnected mechanics can be
made consequences of the same state.

## B. The next body leap is contact-authored combat

Legacy combat still chooses gameplay hit regions independently and the body
solver adapts to the result.

The stronger architecture is the inverse:

`weapon trajectory/contact -> physical node -> impulse -> tissue/region injury
-> balance/consciousness -> body reaction`

That would remove one of the last major duplicated interpretations of a hit.
It is the strongest immediate continuation of this substrate.

## C. Full same-tick coupling is now worth considering

The body solve currently executes after the legacy `stepWorld()` pass.
That was the safest way to establish the substrate without destabilizing every
existing system.

Once behavior is proven, moving the body pass between root physics and
physiology would make fire exposure, structural injury, dragging, tracks, and
other downstream systems observe the articulated result in the same fixed tick.

This is a meaningful architectural upgrade, not cleanup.
Do it when it buys visible systemic behavior, not merely elegance.

## D. Crowd physics can become systemic without adding a crowd system

Because dynamic humans now collide by body nodes and existing AI already has
fear, fleeing, rescue, pursuit, and routines, crowd disasters can emerge from
existing systems once density and propagation are increased.

Potential consequences include:

- stampedes;
- blocked exits;
- people tripping over bodies;
- rescue attempts creating secondary falls;
- fire panic causing pileups;
- guards physically forcing through crowds.

No separate "crowd event manager" is required.

## E. Environment x body is a high-leverage frontier

The field system and articulated body system now create a natural coupling
frontier:

- mud changes footing and fall probability;
- oil can create actual body slips;
- water can drag/submerge individual limbs;
- fire can damage regionally based on exposed nodes;
- collapsing structures can contact actual body parts;
- surfaces can carry distinct impact/friction behavior.

This path multiplies existing systems rather than adding content islands.

## F. Structural debris is now the weakest physical link in large disasters

Humans can become articulated and pile physically, while collapsed props are
still coarse bodies with shallow contact handling.

If large-scale destruction becomes a priority, better debris/body interaction
will deliver more value than adding more destruction visuals.

---

# 18. Best forward paths - ranked by leverage

These are not generic feature suggestions. They are the current highest-value
continuations of the actual architecture.

## 1. Physical contact-authored combat

Make melee attacks generate a real weapon/contact trajectory against articulated
body nodes. Let the contacted node determine region, impulse, injury type,
balance response, and physical reaction.

Why first:

- directly deepens the player's primary action;
- removes duplicated hit interpretation;
- makes every existing injury/body feature more meaningful;
- immediately visible;
- naturally extends to blocks, grabs, shields, pinned limbs, and weapon traps.

## 2. Same-tick body/environment coupling

Move body solving into the world causal sequence after coarse movement/physics
but before injury/fire/structures/tracks consume final body state.

Why second:

- makes articulated position authoritative to more systems;
- improves dragging through fire/water/debris;
- enables local structural impact;
- reduces root/body temporal mismatch.

## 3. Surface-contact locomotion and falls

Use physical feet/contact normals plus mud/oil/wetness to drive support quality,
slipping, bracing, stumbling, and fall initiation.

Why third:

- connects body + environment + weather + movement;
- converts "surface modifiers" into visible physical behavior;
- produces emergent chaos without authored encounters.

## 4. Crowd chain dynamics

Increase physical knock-on behavior between fear-driven humans, bodies, rescue,
and constrained spaces.

Why high leverage:

- uses AI already present;
- uses body contacts already present;
- uses sound/fire/wanted state already present;
- creates large visible consequences from small causes.

## 5. Debris/body contact depth

Promote selected broken structural props to better collision bodies and let their
mass/velocity apply node-local human injury.

Why later:

- major payoff during destruction;
- but player-to-human physical combat will be encountered more often and should
  mature first.

---

# 19. Expansion doctrine

When adding a major mechanic, prefer this question:

"What existing states can this mechanism read, and what existing systems can
observe its consequences?"

Prefer:

- shared authority;
- conserved/physical relationships;
- visible causality;
- consequences that propagate;
- small mechanisms with large coupling surfaces.

Avoid:

- parallel fake state;
- animation-only approximations when physical state already exists;
- scripted one-off spectacle;
- feature managers that duplicate information already represented by world,
  memory, field, or body state;
- broad rewrites whose only payoff is code cleanliness.

---

# 20. Fast reload - read this if context is scarce

SUNDER is a fixed-step TypeScript/React/Three.js systemic game.
`World` is the coarse state aggregate and `stepWorld()` is the original ordered
mutation pipeline.

Humans now also have a 15-node articulated physical body system split across
`body-model.ts`, `body-contacts.ts`, `body.ts`, and `body-render.ts`.
Normal movement remains actor-root driven for compatibility; stumble, ragdoll,
down, dragging, piles, and get-up use physical body constraints and contact.
Dynamic body state derives back into actor root state for AI/camera/world
compatibility.

Fire is a 44x44 coupled environmental field over an 88x88 world.
AI already has perception, memory, fear, loyalty, routines, pursuit, search,
rescue, and animal predator/prey behavior.
Structures are support-count/HP based.
Props remain coarse dynamic bodies.
Persistence is partial.

The strongest next expansion is to let real weapon/body contact author injury
and impulse, then move body solving deeper into the same-tick world causal
sequence so environment/physiology consume articulated results directly.

Always seek deeper coupling before adding isolated feature count.
