# SUNDER showcase integration

Base: ChatGPT-B c8119e888828c23b85113cadd39b7d8209ac9432.

The integration retains exact original renderer and game-loop source in *-core.ts modules. Two narrow TypeScript-private-field compatibility seams access the original visual map and frame callback; neither creates a parallel simulation or changes physics.

Presentation: adapt Grok anatomical construction to the existing 15-node solved body. Preserve the original curved limbs, contact points, damage, and world. Replace the visual barrel torso, add head/face/hair/hands/feet, and align detailed weapons to the original solved carrier.

Audio: add Claude/Grok-inspired continuous weather/fire beds and a quiet ambient drone; use bounded, material-aware transient layers. The original game event bus remains authoritative and unknown effects retain the original audio path. This is synthesized audio, not recorded speech.

Mechanics: add support-conditioned trunk/hip load transfer to existing melee task preparation. The original strike carrier, whole-body coupling, locomotion, active motor, and collision/damage authority are unchanged. The new edge is severable through COMBAT_EDGES.loadTransfer.

Excluded: unverified replacement boxing combinations, recovery stack, and automatic social-incident enlistment. Their code remains in merge ancestry, not active gameplay. No new independent body solver is introduced.

Verification: npm run typecheck; npm run test:substrate; npm run build:local-preview. The targeted combat-load-transfer probe compares active/severed behavior, ordinary walking, deterministic replay, and vertical launch. The full browser bundle must be built from this source, not a demonstration shell.
