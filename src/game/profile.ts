/**
 * Athletic fighter shape. Visuals read PROFILE; the skeleton stands in REST.
 * Wider than deep. Flat stomach. Hips as a pelvis, not a pouch. Head over the
 * hips. Side-on this should read as a person who fights, not a barrel with a
 * belly.
 *
 * Local REST axes: x = right, y = up, z = forward of the body.
 */
export const PROFILE = {
  chestW: 0.36,
  chestD: 0.22,
  bellyW: 0.27,
  bellyD: 0.2,
  hipW: 0.31,
  hipD: 0.22,
  shoulder: 0.13,
  upperArm: 0.125,
  forearm: 0.1,
  thigh: 0.145,
  shin: 0.115,
  hand: 0.08,
  footW: 0.09,
  footH: 0.045,
  footL: 0.22,
  head: 0.2,
  neck: 0.085,
  chestFwd: 0.02,
  hipBack: 0.02,
  idleBend: 0.11,
  idleLift: 0.05,
};

export const REST: [number, number, number][] = [
  [0, 0.94, 0],
  [0, 1.38, 0.03],
  [0, 1.68, 0.01],
  [-0.19, 1.5, 0.02],
  [-0.23, 0.9, 0.03],
  [0.19, 1.5, 0.02],
  [0.23, 0.9, 0.03],
  [-0.1, 0.52, 0],
  [-0.11, 0.08, 0.03],
  [0.1, 0.52, 0],
  [0.11, 0.08, 0.03],
];
