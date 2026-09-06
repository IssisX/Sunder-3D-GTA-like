# SUNDER - Project Instructions

These instructions govern work on this repository in addition to `AGENTS.md`.

## ADVANCED GAME MATH FIRST LAW

For every substantive SUNDER development response, begin the technical reasoning from the canonical advanced-game-math skill before selecting or implementing mechanisms. Use it to classify the change, identify the governing physical/mathematical substrate, expose the highest-value causal couplings, and prefer mechanisms whose mathematical consequences become visible in play.

Do not use the skill as a pretext for sprawling verification, decorative equations, or math that does not materially improve the game. `debug-causal` still owns defect process when a defect is present; advanced-game-math governs the physical/mathematical mechanism chosen for the repair or upgrade.

## DEEP MECHANICAL LEVERAGE LAW

For every substantive mechanics/kinematics slice, search first for one deeper authoritative mechanical truth already latent in the current source or demanded by the observed defect. Prefer one physical quantity, constraint, contact relationship, support relationship, momentum relationship, or action-continuity mechanism whose consequences naturally propagate into several visible behaviors over adding parallel features or local corrections.

Depth > breadth. Continue deeper only while the next dependency changes what the player can visibly cause, feel, control, or observe. Stop when another layer would buy only abstraction, code volume, mathematical ornament, or a tiny isolated effect. When naturally available, prefer one mechanism that improves three or more visible consequences over three independent fixes.

For locomotion/fighting, lower-body support, foot placement, load transfer, COM control, momentum, inertia, traction, catch steps, and action-to-footwork continuity outrank upper-body polish. Upper-body behavior must remain cohesive, but it may not substitute for unresolved footwork or support mechanics.

## ONE-BINARY-CHECK LAW

For each substantive change: implement once, run one targeted binary check, report pass/fail, stop. If that check fails, fix once, re-run that same check once, then stop.

No soak tests, confidence reruns, long-horizon proving, duplicate verification, or unrelated test batteries. The check must target the changed causal edge. Full-suite tests and playable builds run only when explicitly required by the task, not automatically for confidence.

## GITHUB MUTATION TRANSACTION LAW

Substantive SUNDER repository changes are atomic Git transactions, not a sequence of convenience writes.

Before any write, read the exact canonical branch HEAD and its tree. Build every changed code/test/instruction/workflow file as an unattached Git blob first. Unattached blobs are scratch data only - they are not staged, delivered, or canonical.

Immediately before promotion, re-read the canonical branch HEAD. If it changed, reconcile the complete change against that new state and rebuild the tree; never overwrite concurrent work. Then create exactly one tree from the current canonical base tree, exactly one commit whose parent is the current canonical HEAD, and move the branch ref exactly once with a normal fast-forward update.

For substantive code transactions, do not use contents-API `create_file`, `update_file`, or `delete_file` convenience writes, because each mutates the shared branch before the complete slice exists. Do not create temp/junk/placeholder files, placeholder commit messages, partial commits, or verification commits. Do not force-update a shared branch in normal development. A force update is permitted only for an explicit, verified recovery operation where no concurrent work can be lost.

Run the targeted check only against the final promoted commit. If a safe Git-data primitive is not currently loaded, discover/load it; do not substitute a lower-integrity shortcut merely because it is convenient.

## SHORTCUT MINIMIZATION LAW

Shortcut, surrogate, fallback, reconstruction, and convenience techniques are last-resort escape hatches, not normal execution strategy. Never trade mechanism quality, canonical provenance, branch integrity, or complete integration for speed or tool convenience when the canonical path is available.

If a shortcut is genuinely unavoidable, use the narrowest one possible, expose it before handoff, and never allow it to become evidence about canonical behavior or a new baseline.

## DAMAGE MEDIATION LAW

Contact is not damage. Collision/contact resolution may produce geometry, relative velocity, impulse, effective mass, or kinetic-energy evidence, but it must not directly write hurt, blood, HP loss, or injury merely because overlap/contact occurred.

Damage is a downstream consequence of a calibrated impact threshold. Gentle touch, resting/standing contact, overlap correction, and low-energy bumps are inert. Only contact impulses / kinetic energy above the calibrated threshold may produce damage consequences.

## AGENT INDEPENDENCE LAW

Every NPC, animal, and independently simulated entity owns its own decision state and deterministic entropy stream: unique seed/stream identity, phase/time offset, speed variance, and decision state. Shared movement logic may define rules but must not collapse entities onto one synchronized script or phase.

Visible lockstep among three or more independent agents is a defect. Ordinary repeated play should diverge because independently seeded agent streams and decisions diverge; explicit deterministic replay remains reproducible when the captured session seed/state/order are replayed.

## SPATIAL CARRIER LAW

No action-at-a-distance and no magic hits. Intent, timer expiry, or range checks may authorize motion but never apply the effect by themselves.

Melee resolves only from a real swept limb/weapon volume occupying the target volume during the fixed-step strike path. Ranged/fire effects require a projectile, propagating field, or expanding physical volume with travel time, geometry, and physics steps. If the carrier never occupied the target volume, nothing happens.

## MEDIATION-FIRST WORK LAW

Fix the authoritative mediation layer - impulse/energy, per-agent state, swept/projectile carriers, support/contact constraints - rather than masking defects with FX, extra scripts, or extra verification.

## HANDOFF EXPOSURE LAW

Never hide, blur, or euphemize the actual state of delivered work.

For every artifact-changing turn, end with a compact reality report that surfaces:
- the exact canonical branch/state changed;
- what the delivered playable artifact actually is;
- any shortcut, fallback, surrogate, reconstruction, stripped shell, mock, approximation, or intentionally omitted subsystem used during the turn;
- verification actually performed versus verification not performed;
- confirmed regressions, unresolved defects, and material unknowns still present;
- the highest-value next target(s) exposed by the completed work.

A fallback or reduced artifact must be identified **before** the user opens or evaluates it. Never call a reduced, synthetic, reconstructed, debug, benchmark, or stripped artifact simply a "preview" when that wording could imply the canonical game.

Reserve **real preview / real build / playable current version** for an artifact produced from the current canonical `ChatGPT-version` product code and current world/content. A hosting/build wrapper may differ, but the game, world, assets, controls, simulation, and current modifications being evaluated must be the canonical ones. If that artifact cannot be produced, say so plainly rather than substituting a surrogate without disclosure.

Never let a fallback artifact silently become a new baseline. Never use omitted/degraded systems in a fallback as evidence that the canonical game regressed. Never conceal failed work, partial work, unverified behavior, or a quality compromise merely to make a handoff appear complete.

## PLAYER-ACTION RESPONSE LAW

Player-owned actions begin responding on the input edge. Do not insert an involuntary anticipation delay before the visible/mechanical response.

If an action needs travel time, wind-up, charge, leverage, or preparation for physical reasons, motion begins immediately and the timing must arise from the player's continuing input or from the actual physical mechanism - not from a hidden pre-action pause. Animation, contact, and gameplay consequence should converge on the same authoritative physical event whenever the substrate supports it.

## PREVIEW FIDELITY CONTRACT

After substantive gameplay changes, prefer a reproducible playable build from the canonical branch over bespoke demo shells. Preview infrastructure must import/use canonical game modules rather than copying, simplifying, or reimplementing the game. Any intentional wrapper difference must be surfaced in the handoff reality report.

## LAW OF COMPLETE MODULAR DELIVERY

Modularity is an internal organization and output-packaging rule, never a reason to defer.

When a request requires multiple modules, files, prompts, documents, components, or subsystems, deliver every feasible required artifact in the same response. Each artifact must be complete within its role and connect coherently to the others.

Do not list modules that should be created - create them. Do not describe interfaces that need implementation - implement them. Do not provide a file tree without the file contents when the user asked for the build. Do not use modularity to split one complete request across artificial future turns.

If output-size limits make literal inclusion of every low-value generated artifact impossible, prioritize the executable core, all critical integrations, and a deterministic generator or build script that produces the remaining repetitive artifacts. Never omit the logic that makes the system function.
