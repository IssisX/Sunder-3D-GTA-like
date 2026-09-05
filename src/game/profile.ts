/**
 * How a person is shaped. Visuals read PROFILE; the skeleton stands in REST.
 * Keep both here so a side-on silhouette is one conversation, not two files
 * drifting apart.
 *
 * Local axes for REST: x = right, y = up, z = forward of the body.
 * Chest sits forward, hips sit back, head stacks over the pelvis — an S from
 * the side, not a plank.
 */
export const PROFILE = {
  chestW: 0.33,
  chestD: 0.36,
  bellyW: 0.28,
  bellyD: 0.32,
  hipW: 0.34,
  hipD: 0.34,
  shoulder: 0.17,
  upperArm: 0.14,
  forearm: 0.11,
  thigh: 0.165,
  shin: 0.125,
  hand: 0.09,
  footW: 0.1,
  footH: 0.05,
  footL: 0.24,
  head: 0.21,
  neck: 0.09,
  chestFwd: 0.07,
  hipBack: 0.055,
  idleBend: 0.16,
  idleLift: 0.07,
};

export const REST: [number, number, number][] = [
  [0, 0.94, -0.02],
  [0, 1.36, 0.07],
  [0, 1.66, 0.01],
  [-0.18, 1.48, 0.05],
  [-0.22, 0.88, 0.04],
  [0.18, 1.48, 0.05],
  [0.22, 0.88, 0.04],
  [-0.1, 0.52, 0],
  [-0.11, 0.08, 0.04],
  [0.1, 0.52, 0],
  [0.11, 0.08, 0.04],
];
