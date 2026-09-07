# Movement and melee repair — 2026-09-05

Canonical branch: `ChatGPT-version`. Integrated against `b66de377`, preserving
its anatomy extraction and support yaw wrench. Classification: precision repair
under advanced-game-math, with debug-causal owning diagnosis.

## Mechanisms and evidence

| Causal edge | Mechanism | Probe |
| --- | --- | --- |
| Stick direction → retained facing | Remove idle camera-yaw steering; retain full precision in the root snapshot | Left/right then neutral and changed camera heading |
| Supported intent → translation | One requested speed shared by gait and support; remove mass-weighted common horizontal motor acceleration | Sever `supportMotion.drive`: average forward speed falls from 3.84 to -0.11 m/s |
| Reachable stance → sustained running | Derive cycle distance from stance fraction and reachable travel; lower pelvis by the two-link reach geometry | Normal 3.84 m/s, sprint 5.47 m/s over two seconds, alive and stable |
| Turned shoulders → kick guard | Final arm IK uses the winning shoulder frame after coupling | Sever final guard pass: minimum hand height at tick 13 drops from 1.26 to 1.09 m |
| Support surface → kick height | Capture support height instead of feeding solved pelvis lift back into the next target | First 20 ticks: supporting foot center stays below 0.22 m |
| Solved fist sweep → contact consequence | Shorter jab/cross cycles; bounded fist-plus-forearm contact mass in existing empirical impact model | Same small target: 22.02 damage; sever contact resolver: zero |
| Internal motor → articulated shape, not COM propulsion | Mass-weighted projection removes net X/Y/Z momentum from moving-task and posture motors; support/contact remain the only locomotor/external impulse source | Direct motor probe requires vigorous local node motion with near-zero 3D net momentum; 50 back-to-back grounded punches bound root-height drift |
| Commanded travel → gait, unintended motion → recovery | Capture-point corrective stepping discounts only achieved velocity along commanded movement up to requested speed; lateral/backward/overspeed disturbance remains | Ten-second clear-ground walk rejects repeated low-speed windows and reports corrective-step activity |

Kick heel trajectory has one owner. Coupling fits a reachable two-link leg to
the rotated hip instead of replacing the trajectory with another phase curve.
Guard lifts on the input edge; chamber, extension and recoil remain continuous.
Jab/cross durations are 0.28/0.34 seconds, formerly 0.33/0.40. Kick duration is
0.48 seconds, formerly 0.58. Contact still requires a solved effector sweep.

Continuous synthetic rain/fire/drone beds are omitted. Brief event sounds remain.

## Verification and scope

Run `npm run test:substrate` with Node 22.15+ or Node 24, then
`npm run typecheck` and `npm run build:local-preview`.
`tests/substrate/probe.ts` imports the production simulation and solver. Its
isolated mechanics fixtures remove unrelated actors/obstacles; they are tests,
not a substitute playable world. Kick/punch replays match exactly in the same
Node 24 runtime. Full-world stochastic replay and cross-browser bit equality
are not claimed.

Same clear-ground normal-motion fixture: 2.14 m/s at `b66de377`, 3.84 after.
Original starting revision `cfe1172` measured 2.56 m/s. Same contact target:
20.18 damage at `cfe1172`, 21.43 at `b66de377`, 22.02 after. Peak total fist
speed is not uniformly higher; stronger contact and shorter recovery are the
measured improvements.

Full-world CPU tick sample (34 actors, 152 props, 60 warm-up + 120 moving ticks):
8.35 ms before at `b66de377`, 7.04 ms after in the last sample. These are noisy
single-run headless measurements, not phone FPS or a claimed performance gain.

Direct-open `SUNDER.html` was built with the existing local-preview wrapper,
which imports the canonical game, full world and controls. Desktop Chromium
reported no page errors. A 390×844 mobile emulation exercised the actual
on-screen stick with pointer events: both left/right releases retained facing
exactly and produced no page errors. Paused side-view kick extension (tick 15) and recovery
were inspected using the production fixed step through `__controlsTest`.
Cloud browser could not access localhost; local Playwright with packaged
Chromium/SwiftShader was the browser fallback. Audio was not judged by listening.

## 2026-09-05 control-stability continuation

Two repair edges close physics/controller leaks exposed by the touch-first
combat requirements:

- **Internal actuation → shape, not propulsion.** Both moving task motors and
  background posture motors are now mass-projected to zero net linear momentum
  in X/Y/Z. A punch may shift or rotate the body only through support reaction,
  contact, or another external impulse; internal limb commands cannot launch it.
- **Intentional travel → locomotion; residual travel → capture recovery.** The
  capture-point correction removes only the achieved component along current
  commanded travel, capped by requested speed. Sideways/backward motion and
  overspeed are still disturbances. This prevents ordinary forward gait from
  repeatedly asking the recovery controller to fight the locomotion controller.

The direct falsifiers are the 3D motor-momentum probe, a 50-punch grounded
sequence, and the clear-ground continuity window in `tests/substrate/probe.ts`.

## Remaining limits and next targets

This remains a bounded active-ragdoll approximation. Internal task/posture
actuation now conserves weighted linear momentum in all three axes; angular
momentum is still approximate and support yaw is handled through the bounded
foot-ground wrench. Fist effective contact mass is empirically bounded, not
computed from an articulated inverse mass matrix. Kick support now uses a
ground-normal stance constraint only when one foot owns a contact-critical
support task and the other owns the action. Horizontal contact, ordinary gait,
jumps, falls and two-foot punch support stay on their existing paths. Maximum
support-foot center height fell from 1.64 m to 0.127 m (0.10 m foot radius)
while heel reach remained 0.77 m and shoulder turn remained 76 degrees.
Hardware Fold 6 touch feel/performance remains unverified.

The action foot's authored ground return no longer registers as a self-impact;
environment and body contacts outside an active limb task retain the existing
impact path. The direct recovery trace returns to idle and both feet settle at
ground height instead of classifying the kick landing as a ragdoll event.

The next capabilities made cheaper are touch-intent combat buffering over the
same mechanical action tasks, and support-aware action continuation that carries
locomotion/stance through attack and recovery instead of cancelling movement.

## 2026-09-06 branch reconciliation and boxing

Source histories: `ChatGPT-B` at `a9fa5690` and `ChatGPT-version` at
`aed29bbe`. The newer body-control branch supplies kinetic fight flow,
reactive balance, committed catch steps, and local social incidents. The B
branch supplies its independently developed encounter authority, action/strike
repair, and regression probes. The 15-node anatomical rig and smooth physical
surface renderer remain authoritative; the older 11-node alternative rigs were
not substituted. Actual visual superiority has not been established by a
side-by-side rendered inspection.

| Causal edge | Owner and consequence | Falsifier |
| --- | --- | --- |
| Input taps → bounded queued actions → continuous combination | `boxing-combinations.ts` owns four FIFO entries with individual deadlines, six punch families, and continuation from the preceding completed action. Melee owns the only player attack buffer. | `boxing-combinations-probe.ts`: a rapid three-tap burst must produce jab/cross/lead uppercut; all six families reachable; stale taps expire. |
| Current stance/range → selected hand and strike family | Existing solved foot positions determine lead side; target distance selects appropriate straight/hook substitutions. No authored combat stance replaces a planted foot. | Same probe: short range selects a hook, long range substitutes a straight, mirrored stance mirrors the hand. Cut `contextualPunchPath` to remove contextual substitutions. |
| Achieved fist velocity → next path → bounded motor → solved carrier | The next attack begins at the actual fist position and inherits its velocity. Cubic paths are motor goals, not animation transforms or damage. | `boxing-integration-probe.ts`: actual controller must produce three consecutive attacks and measurable solved fist travel. |
| Support/traction/COM momentum → core drive → contact and balance | `sampleMechanicalState` supplies real support, wet/oil grip, angular momentum, velocity, injury and consciousness. Boxing changes the existing locomotion targets; KineticFightFlow, SupportWrench, ReactiveBalance and ActionContinuity consume the resulting geometry. | Cut `supportCoupledDrive`: the pure pose torque and integrated solved-body trace must change. |
| Solved fist and target motion → relative sweep → impact mediation | Existing melee contact owns injury, recoil, regional force, sounds, social evidence and prop effects. No timed damage is added. | The existing spatial-carrier/damage probes and the integrated action probe must remain green. |
| Local aggression evidence → guard authorization → incident roles | `social-incident.ts` no longer turns uninvolved guards into fighters or forces them to flee. Existing warning/investigation authority remains responsible for escalation. Direct harm or independently established combat evidence can authorize a local joiner. | `social-incident-probe.ts`: uninvolved guards remain role NONE; direct victims may join; cutting `guardEvidence` restores the old automatic enlistment. |

The older one-entry ActionContinuity input buffer remains available for its
standalone compatibility probe but is disabled in the production orchestrator;
Melee now owns all queued attack and kick inputs. ActionContinuity continues to
own momentum and terminal-pose recovery. Weapon and kick task generators retain
their prior paths and timing. The current implementation is still bounded active
ragdoll control, not an exact anatomical inverse-dynamics solver. Full-world
replay, hardware performance, and close-up visual quality must be reported from
actual measurements rather than inferred from this integration.
