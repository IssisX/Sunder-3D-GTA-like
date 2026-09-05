import assert from "node:assert/strict";
import { World } from "../../src/game/world";
import { buildLevel } from "../../src/game/level";
import { STEP } from "../../src/game/types";
import { PhysicalBodies } from "../../src/game/body";
import { injuryTotal, REGIONS } from "../../src/game/types";
import { impactDynamics } from "../../src/game/impact-dynamics";
import {
  beastMelee,
  EDGES,
} from "../../src/game/beast-melee-kinematics";

function damageOf(a: ReturnType<World["player"]>) {
  let sum = 0;
  for (const region of REGIONS) sum += injuryTotal(a.injuries[region]);
  return sum;
}

function run(spatialCarrier: boolean) {
  const w = new World();
  w.seed = 12345;
  buildLevel(w);
  const p = w.player();
  const wolf = w.actors.find((a) => a.species === "wolf")!;
  w.actors = [p, wolf];
  w.props = [];
  w.colliders = [];
  w.buildings = [];
  w.fuel.fill(0);

  p.x = 0; p.y = 0; p.z = 0;
  p.vx = p.vy = p.vz = 0;
  wolf.x = 0; wolf.y = 0; wolf.z = 1;
  wolf.yaw = 0;
  wolf.vx = wolf.vy = wolf.vz = 0;

  const bodies = new PhysicalBodies();
  bodies.bootstrap(w);
  impactDynamics.bind(bodies);
  impactDynamics.bootstrap(w);
  beastMelee.bind(bodies);
  beastMelee.bootstrap();

  const prior = EDGES.spatialCarrier;
  EDGES.spatialCarrier = spatialCarrier;
  try {
    wolf.strikeT = 0.28; // AI intent only.
    beastMelee.step(w, STEP);
    beastMelee.step(w, STEP);
    beastMelee.step(w, STEP);

    // Move the visible wolf head through the player's actual lower-body nodes
    // during the carrier-active interval. No range/timer damage is called.
    wolf.z -= 0.25;
    wolf.vz = -0.25 / STEP;
    beastMelee.step(w, STEP);

    return {
      damage: damageOf(p),
      pain: p.pain,
      legacyTimer: wolf.strikeT,
    };
  } finally {
    EDGES.spatialCarrier = prior;
  }
}

const canonical = run(true);
const severed = run(false);
console.log("BEAST-SPATIAL-CARRIER", { canonical, severed });

assert.equal(canonical.legacyTimer, 0,
  "beast strike intent was not consumed before the legacy damage window");
assert(canonical.damage > 0.02,
  "real swept beast carrier failed to produce an energetic impact");
assert.equal(severed.damage, 0,
  "beast damage occurred with the spatial carrier edge severed");
