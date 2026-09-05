import * as THREE from "three";
import type { Actor, Injury, Particle, WeaponKind } from "./types";
import { facing, injurySum, rightOf } from "./world";
import { P, weaponEnds, actionUnit, strikeDuration, punchLeft, KICK_DUR } from "./physique";
import { PROFILE } from "./profile";

export { PROFILE } from "./profile";

/** Bump when the mesh layout changes so cached actors rebuild. */
export const MESH_REV = 9;

const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 14, 12),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 14),
  chest: new THREE.CylinderGeometry(0.5, 0.4, 1, 16),
  belly: new THREE.CylinderGeometry(0.4, 0.46, 1, 16),
  hips: new THREE.CylinderGeometry(0.42, 0.52, 1, 16),
  limbU: new THREE.CylinderGeometry(0.36, 0.5, 1, 12),
  limbL: new THREE.CylinderGeometry(0.3, 0.42, 1, 12),
  cone: new THREE.ConeGeometry(0.5, 1, 8),
};

export function isBodyGeo(geo: THREE.BufferGeometry) {
  return (
    geo === GEO.box ||
    geo === GEO.sphere ||
    geo === GEO.cyl ||
    geo === GEO.chest ||
    geo === GEO.belly ||
    geo === GEO.hips ||
    geo === GEO.limbU ||
    geo === GEO.limbL ||
    geo === GEO.cone
  );
}

function mat(color: number, extra: ConstructorParameters<typeof THREE.MeshStandardMaterial>[0] = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.66,
    metalness: 0.03,
    ...extra,
  });
}

export function makeHumanoid(a: Actor) {
  const g = new THREE.Group();
  const skin = mat(a.skin);
  const cloth = mat(a.cloth);
  const dark = mat(a.accent);
  const mk = (material: THREE.Material, name: string, geo: THREE.BufferGeometry = GEO.box) => {
    const m = new THREE.Mesh(geo, material);
    m.name = name;
    m.castShadow = true;
    g.add(m);
    return m;
  };
  const pelvis = mk(dark, "pelvis", GEO.hips);
  const belly = mk(cloth, "belly", GEO.belly);
  const torso = mk(cloth, "torso", GEO.chest);
  const neck = mk(skin, "neck", GEO.cyl);
  const head = new THREE.Mesh(GEO.sphere, skin);
  head.name = "head";
  head.castShadow = true;
  g.add(head);
  const hairCol = new THREE.Color(a.skin).multiplyScalar(0.32);
  const hair = new THREE.Mesh(GEO.sphere, mat(hairCol.getHex()));
  hair.name = "hair";
  hair.scale.set(1.06, 0.68, 1.04);
  hair.position.set(0, 0.16, -0.02);
  hair.castShadow = true;
  head.add(hair);
  const eyeM = mat(0x1a1512);
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(GEO.sphere, eyeM);
    e.scale.set(0.13, 0.13, 0.08);
    e.position.set(sx * 0.16, 0.05, -0.4);
    head.add(e);
  }
  const nose = new THREE.Mesh(GEO.box, skin);
  nose.scale.set(0.07, 0.09, 0.14);
  nose.position.set(0, -0.02, -0.44);
  head.add(nose);
  const luarm = mk(skin, "luarm", GEO.limbU);
  const llarm = mk(skin, "llarm", GEO.limbL);
  const ruarm = mk(skin, "ruarm", GEO.limbU);
  const rlarm = mk(skin, "rlarm", GEO.limbL);
  const lhand = mk(skin, "lhand", GEO.sphere);
  const rhand = mk(skin, "rhand", GEO.sphere);
  const lelbow = mk(skin, "lelbow", GEO.sphere);
  const relbow = mk(skin, "relbow", GEO.sphere);
  const lthigh = mk(dark, "lthigh", GEO.limbU);
  const lshin = mk(dark, "lshin", GEO.limbL);
  const rthigh = mk(dark, "rthigh", GEO.limbU);
  const rshin = mk(dark, "rshin", GEO.limbL);
  const lknee = mk(dark, "lknee", GEO.sphere);
  const rknee = mk(dark, "rknee", GEO.sphere);
  const lfoot = mk(dark, "lfoot");
  const rfoot = mk(dark, "rfoot");
  const lshcap = mk(cloth, "lshcap", GEO.sphere);
  const rshcap = mk(cloth, "rshcap", GEO.sphere);
  for (const m of [pelvis, belly, torso, neck, head, luarm, llarm, ruarm, rlarm, lthigh, lshin, rthigh, rshin, lhand, rhand]) {
    addWounds(m, a.id);
  }
  if (a.helmet) {
    const h = new THREE.Mesh(GEO.sphere, mat(0x4a4c50, { metalness: 0.5, roughness: 0.4 }));
    h.name = "helmet";
    h.scale.set(1.08, 0.7, 1.08);
    h.position.y = 0.14;
    head.add(h);
  }
  const wep = new THREE.Group();
  wep.name = "weapon";
  g.add(wep);
  g.userData.parts = {
    head,
    neck,
    torso,
    belly,
    pelvis,
    larm: luarm,
    rarm: ruarm,
    lleg: lthigh,
    rleg: rthigh,
    luarm,
    llarm,
    ruarm,
    rlarm,
    lhand,
    rhand,
    lelbow,
    relbow,
    lthigh,
    lshin,
    rthigh,
    rshin,
    lknee,
    rknee,
    lfoot,
    rfoot,
    lshcap,
    rshcap,
    wep,
  };
  return g;
}

export function syncHumanoid(a: Actor, g: THREE.Group, alpha: number) {
  const body = a.body!;
  const parts = g.userData.parts as Record<string, THREE.Object3D | undefined>;
  if (!parts?.luarm || !parts.pelvis || body.parts.length < 11) {
    const x = a.px + (a.x - a.px) * alpha;
    const y = a.py + (a.y - a.py) * alpha;
    const z = a.pz + (a.z - a.pz) * alpha;
    g.position.set(x, y, z);
    g.rotation.y = a.yaw;
    return;
  }
  g.position.set(0, 0, 0);
  g.rotation.set(0, 0, 0);
  const lerpP = (p: Particle) => ({
    x: p.px + (p.x - p.px) * alpha,
    y: p.py + (p.y - p.py) * alpha,
    z: p.pz + (p.z - p.pz) * alpha,
  });
  const A = body.parts.map(lerpP);
  const pel = A[P.pelvis]!;
  const sp = A[P.spine]!;
  const hd = A[P.head]!;
  const rgt = rightOf(a.yaw);
  const fwd = facing(a.yaw);
  const limp = a.loco === "ragdoll" || a.loco === "down" || body.mode === "ragdoll" || body.mode === "getup";
  const cf = PROFILE.chestFwd;
  const hb = PROFILE.hipBack;
  const shY = (A[P.uarmL]!.y + A[P.uarmR]!.y) * 0.5;
  placeBody(
    parts.pelvis!,
    { x: pel.x - fwd.x * hb, y: pel.y - 0.1, z: pel.z - fwd.z * hb },
    { x: pel.x - fwd.x * 0.012, y: pel.y + 0.05, z: pel.z - fwd.z * 0.012 },
    rgt,
    PROFILE.hipW,
    PROFILE.hipD,
  );
  if (parts.belly) {
    placeBody(
      parts.belly,
      { x: pel.x + fwd.x * 0.012, y: pel.y + 0.02, z: pel.z + fwd.z * 0.012 },
      { x: pel.x + fwd.x * 0.028, y: pel.y + 0.22, z: pel.z + fwd.z * 0.028 },
      rgt,
      PROFILE.bellyW,
      PROFILE.bellyD,
    );
  }
  const chestA = { x: pel.x + fwd.x * 0.03, y: pel.y + 0.18, z: pel.z + fwd.z * 0.03 };
  const chestB = {
    x: sp.x + fwd.x * cf,
    y: sp.y * 0.4 + shY * 0.6 - 0.02,
    z: sp.z + fwd.z * cf,
  };
  placeBody(parts.torso!, chestA, chestB, rgt, PROFILE.chestW, PROFILE.chestD);
  const nb = { x: chestB.x, y: chestB.y, z: chestB.z };
  const nt = limp
    ? { x: hd.x, y: hd.y - 0.1, z: hd.z }
    : {
        x: nb.x * 0.78 + hd.x * 0.22,
        y: Math.max(hd.y - 0.12, nb.y + 0.09),
        z: nb.z * 0.78 + hd.z * 0.22,
      };
  if (parts.neck) placeSeg(parts.neck, nb, nt, PROFILE.neck);
  const headR = 0.11;
  if (limp) {
    parts.head!.position.set(hd.x, hd.y, hd.z);
    const nl = Math.hypot(hd.x - sp.x, hd.y - sp.y, hd.z - sp.z) || 1;
    _dir.set((hd.x - sp.x) / nl, (hd.y - sp.y) / nl, (hd.z - sp.z) / nl);
    parts.head!.quaternion.setFromUnitVectors(_up, _dir);
  } else {
    parts.head!.position.set(nt.x, nt.y + headR, nt.z);
    parts.head!.rotation.set(0, a.yaw, 0);
  }
  parts.head!.scale.set(0.2, 0.22, PROFILE.head);
  let lBend = PROFILE.idleBend;
  let rBend = PROFILE.idleBend;
  let lLift = PROFILE.idleLift;
  let rLift = PROFILE.idleLift;
  if (a.strikeT > 0) {
    const u = actionUnit(a.strikeT, strikeDuration(a));
    const left = punchLeft(a);
    const punchBend = u < 0.46 ? 0.16 : 0.035;
    const punchLift = u < 0.46 ? 0.08 : 0.02;
    if (left) {
      lBend = punchBend;
      lLift = punchLift;
      rBend = 0.13;
      rLift = 0.1;
    } else {
      rBend = punchBend;
      rLift = punchLift;
      lBend = 0.13;
      lLift = 0.1;
    }
  } else if (a.combo > 0 || a.comboAge < 0.22) {
    lBend = 0.13;
    rBend = 0.13;
    lLift = 0.1;
    rLift = 0.1;
  } else if (a.kickT > 0) {
    const u = actionUnit(a.kickT, KICK_DUR);
    lBend = 0.12;
    rBend = 0.14;
    lLift = 0.08;
    rLift = u < 0.5 ? 0.06 : 0.1;
  }
  placeArm(parts.luarm!, parts.llarm!, parts.lhand, A[P.uarmL]!, A[P.larmL]!, fwd, lBend, lLift, parts.lelbow);
  placeArm(parts.ruarm!, parts.rlarm!, parts.rhand, A[P.uarmR]!, A[P.larmR]!, fwd, rBend, rLift, parts.relbow);
  if (parts.lshcap) {
    parts.lshcap.position.set(A[P.uarmL]!.x, A[P.uarmL]!.y, A[P.uarmL]!.z);
    parts.lshcap.scale.setScalar(PROFILE.shoulder);
    parts.lshcap.quaternion.identity();
  }
  if (parts.rshcap) {
    parts.rshcap.position.set(A[P.uarmR]!.x, A[P.uarmR]!.y, A[P.uarmR]!.z);
    parts.rshcap.scale.setScalar(PROFILE.shoulder);
    parts.rshcap.quaternion.identity();
  }
  placeLeg(parts.lthigh!, parts.lshin!, parts.lfoot, pel, A[P.thighL]!, A[P.shinL]!, rgt, -1, fwd, a.yaw, parts.lknee);
  placeLeg(parts.rthigh!, parts.rshin!, parts.rfoot, pel, A[P.thighR]!, A[P.shinR]!, rgt, 1, fwd, a.yaw, parts.rknee);
  let wep = parts.wep;
  if (wep && !(wep as THREE.Group).isGroup) {
    const ng = new THREE.Group();
    ng.name = "weapon";
    wep.parent?.add(ng);
    wep.parent?.remove(wep);
    parts.wep = ng;
    wep = ng;
  }
  if (wep) {
    const hold = weaponEnds(a);
    wep.visible = !!hold && !a.weaponProp;
    if (hold && !a.weaponProp) {
      if (wep.userData.kind !== a.weapon || wep.userData.lit !== a.torchLit) {
        rebuildHeldWeapon(wep, a.weapon, a.torchLit, a.kind === "player");
      }
      placeHeldWeapon(wep, hold);
      const flame = wep.getObjectByName("flame");
      if (flame) {
        const flick = 0.82 + Math.sin(performance.now() * 0.018 + a.id) * 0.2;
        flame.scale.set(flick, flick * 1.15, flick);
        flame.visible = a.torchLit;
      }
    }
  }
  if (parts.head) (parts.head as THREE.Mesh).material = tintInjury(a.skin, injurySum(a.injuries.head));
  if (parts.neck) (parts.neck as THREE.Mesh).material = tintInjury(a.skin, injurySum(a.injuries.head) * 0.4);
  if (parts.torso) (parts.torso as THREE.Mesh).material = tintInjury(a.cloth, injurySum(a.injuries.torso) * 0.6);
  if (parts.belly) (parts.belly as THREE.Mesh).material = tintInjury(a.cloth, injurySum(a.injuries.torso) * 0.4);
  if (parts.llarm) (parts.llarm as THREE.Mesh).material = tintInjury(a.skin, injurySum(a.injuries.larm));
  if (parts.rlarm) (parts.rlarm as THREE.Mesh).material = tintInjury(a.skin, injurySum(a.injuries.rarm));
  if (parts.luarm) (parts.luarm as THREE.Mesh).material = tintInjury(a.skin, injurySum(a.injuries.larm) * 0.5);
  if (parts.ruarm) (parts.ruarm as THREE.Mesh).material = tintInjury(a.skin, injurySum(a.injuries.rarm) * 0.5);
  if (parts.lshin) (parts.lshin as THREE.Mesh).material = tintInjury(a.accent, injurySum(a.injuries.lleg));
  if (parts.rshin) (parts.rshin as THREE.Mesh).material = tintInjury(a.accent, injurySum(a.injuries.rleg));
  paintWounds(parts.head, a.injuries.head);
  paintWounds(parts.torso, a.injuries.torso);
  paintWounds(parts.belly, a.injuries.torso);
  paintWounds(parts.rlarm, a.injuries.rarm);
  paintWounds(parts.llarm, a.injuries.larm);
  paintWounds(parts.rshin, a.injuries.rleg);
  paintWounds(parts.lshin, a.injuries.lleg);
  paintWounds(parts.rhand, a.injuries.rarm);
  paintWounds(parts.lhand, a.injuries.larm);
}

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _basis = new THREE.Matrix4();

function placeSeg(
  mesh: THREE.Object3D,
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  thick: number,
  maxLen = 0.55,
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const n = Math.hypot(dx, dy, dz);
  if (n > maxLen && n > 1e-6) {
    const s = maxLen / n;
    b = { x: a.x + dx * s, y: a.y + dy * s, z: a.z + dz * s };
  }
  placeBody(mesh, a, b, { x: 1, z: 0 }, thick, thick);
}

function placeArm(
  upper: THREE.Object3D,
  lower: THREE.Object3D,
  hand: THREE.Object3D | undefined,
  shoulder: { x: number; y: number; z: number },
  wrist: { x: number; y: number; z: number },
  fwd: { x: number; z: number },
  bend = PROFILE.idleBend,
  lift = PROFILE.idleLift,
  elbowMesh?: THREE.Object3D,
) {
  const elbow = {
    x: shoulder.x * 0.52 + wrist.x * 0.48 - fwd.x * bend,
    y: shoulder.y * 0.52 + wrist.y * 0.48 + lift,
    z: shoulder.z * 0.52 + wrist.z * 0.48 - fwd.z * bend,
  };
  placeSeg(upper, shoulder, elbow, PROFILE.upperArm);
  placeSeg(lower, elbow, wrist, PROFILE.forearm);
  if (elbowMesh) {
    elbowMesh.position.set(elbow.x, elbow.y, elbow.z);
    elbowMesh.scale.setScalar(0.095);
    elbowMesh.quaternion.identity();
  }
  if (hand) {
    hand.position.set(wrist.x, wrist.y, wrist.z);
    hand.scale.set(PROFILE.hand, 0.07, 0.1);
    hand.quaternion.identity();
  }
}

function clampToward(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  max: number,
) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const n = Math.hypot(dx, dy, dz);
  if (n <= max || n < 1e-6) return { x: to.x, y: to.y, z: to.z };
  const s = max / n;
  return { x: from.x + dx * s, y: from.y + dy * s, z: from.z + dz * s };
}

function placeLeg(
  thigh: THREE.Object3D,
  shin: THREE.Object3D,
  foot: THREE.Object3D | undefined,
  hip: { x: number; y: number; z: number },
  knee: { x: number; y: number; z: number },
  ankle: { x: number; y: number; z: number },
  right: { x: number; z: number },
  side: number,
  fwd: { x: number; z: number },
  yaw: number,
  kneeMesh?: THREE.Object3D,
) {
  const hipP = {
    x: hip.x + right.x * side * 0.1,
    y: hip.y - 0.02,
    z: hip.z + right.z * side * 0.1,
  };
  const span = Math.hypot(ankle.x - hipP.x, ankle.y - hipP.y, ankle.z - hipP.z);
  let kneeP = clampToward(hipP, knee, 0.44);
  if (span > 0.8) {
    kneeP = { x: kneeP.x - fwd.x * 0.07, y: kneeP.y, z: kneeP.z - fwd.z * 0.07 };
  }
  const ankleP = clampToward(kneeP, ankle, 0.5);
  placeSeg(thigh, hipP, kneeP, PROFILE.thigh, 0.46);
  placeSeg(shin, kneeP, ankleP, PROFILE.shin, 0.5);
  if (kneeMesh) {
    kneeMesh.position.set(kneeP.x, kneeP.y, kneeP.z);
    kneeMesh.scale.setScalar(0.11);
    kneeMesh.quaternion.identity();
  }
  if (foot) placeFoot(foot, ankleP, fwd, yaw);
}

function placeBody(
  mesh: THREE.Object3D,
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  right: { x: number; z: number },
  width: number,
  depth: number,
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const n = Math.hypot(dx, dy, dz);
  const len = n < 0.04 ? 0.04 : n;
  mesh.position.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
  if (n < 1e-5) {
    mesh.scale.set(width, len, depth);
    return;
  }
  const inv = 1 / n;
  _y.set(dx * inv, dy * inv, dz * inv);
  let rx = right.x;
  let rz = right.z;
  const d = rx * _y.x + rz * _y.z;
  rx -= _y.x * d;
  rz -= _y.z * d;
  const rl = Math.hypot(rx, rz);
  if (rl < 1e-5) {
    _dir.set(_y.x, _y.y, _y.z);
    mesh.quaternion.setFromUnitVectors(_up, _dir);
  } else {
    _x.set(rx / rl, 0, rz / rl);
    _z.crossVectors(_x, _y);
    if (_z.lengthSq() < 1e-8) {
      _dir.set(_y.x, _y.y, _y.z);
      mesh.quaternion.setFromUnitVectors(_up, _dir);
    } else {
      _z.normalize();
      _x.crossVectors(_y, _z).normalize();
      _basis.makeBasis(_x, _y, _z);
      mesh.quaternion.setFromRotationMatrix(_basis);
    }
  }
  mesh.scale.set(width, len, depth);
}

function placeFoot(
  mesh: THREE.Object3D,
  shin: { x: number; y: number; z: number },
  fwd: { x: number; z: number },
  yaw: number,
) {
  mesh.position.set(shin.x + fwd.x * 0.07, Math.max(0.03, shin.y - 0.03), shin.z + fwd.z * 0.07);
  mesh.scale.set(PROFILE.footW, PROFILE.footH, PROFILE.footL);
  mesh.rotation.set(0, yaw + Math.PI, 0);
}

export function placeHeldWeapon(
  g: THREE.Object3D,
  hold: { ax: number; ay: number; az: number; bx: number; by: number; bz: number },
) {
  const dx = hold.bx - hold.ax;
  const dy = hold.by - hold.ay;
  const dz = hold.bz - hold.az;
  const n = Math.hypot(dx, dy, dz) || 1;
  g.position.set(hold.ax, hold.ay, hold.az);
  _dir.set(dx / n, dy / n, dz / n);
  g.quaternion.setFromUnitVectors(_up, _dir);
  g.scale.set(1, 1, 1);
}

function addWepMesh(
  g: THREE.Object3D,
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  y: number,
  sx: number,
  sy: number,
  sz: number,
  name?: string,
) {
  const m = new THREE.Mesh(geo, material);
  m.position.y = y;
  m.scale.set(sx, sy, sz);
  m.castShadow = true;
  if (name) m.name = name;
  g.add(m);
  return m;
}

export function rebuildHeldWeapon(g: THREE.Object3D, kind: WeaponKind, lit: boolean, isPlayer: boolean) {
  while (g.children.length) g.remove(g.children[0]!);
  g.userData.kind = kind;
  g.userData.lit = lit;
  const wood = mat(0x6b4e32);
  const dark = mat(0x3a2818);
  const metal = mat(0x9aa0a6, { metalness: 0.72, roughness: 0.32 });
  const wrap = mat(0x5a4030);
  if (kind === "club") {
    addWepMesh(g, GEO.cyl, wood, 0.36, 0.05, 0.72, 0.05);
    addWepMesh(g, GEO.sphere, dark, 0.84, 0.16, 0.18, 0.16);
  } else if (kind === "board") {
    addWepMesh(g, GEO.box, wood, 0.46, 0.045, 0.92, 0.22);
  } else if (kind === "spear") {
    addWepMesh(g, GEO.cyl, wood, 0.62, 0.03, 1.24, 0.03);
    addWepMesh(g, GEO.cone, metal, 1.36, 0.07, 0.24, 0.07);
  } else if (kind === "pitchfork") {
    addWepMesh(g, GEO.cyl, wood, 0.55, 0.032, 1.1, 0.032);
    addWepMesh(g, GEO.box, metal, 1.18, 0.16, 0.03, 0.03);
    addWepMesh(g, GEO.box, metal, 1.34, 0.025, 0.32, 0.025).position.x = -0.07;
    addWepMesh(g, GEO.box, metal, 1.34, 0.025, 0.32, 0.025).position.x = 0.07;
  } else if (kind === "knife") {
    addWepMesh(g, GEO.box, wrap, 0.05, 0.03, 0.1, 0.03);
    addWepMesh(g, GEO.box, metal, 0.2, 0.012, 0.22, 0.045);
  } else if (kind === "torch") {
    addWepMesh(g, GEO.cyl, wood, 0.24, 0.042, 0.48, 0.042);
    addWepMesh(g, GEO.sphere, wrap, 0.5, 0.1, 0.1, 0.1);
    const flame = addWepMesh(
      g,
      GEO.sphere,
      new THREE.MeshBasicMaterial({ color: lit ? 0xffb060 : 0x4a3a28 }),
      0.62,
      0.11,
      0.16,
      0.11,
      "flame",
    );
    flame.visible = lit;
    if (lit && isPlayer) {
      const light = new THREE.PointLight(0xffaa66, 1.15, 7, 2);
      light.name = "torchLight";
      flame.add(light);
    }
  }
}

const injuryMats = new Map<string, THREE.MeshStandardMaterial>();
function addWounds(parent: THREE.Object3D, id: number) {
  const bruise = new THREE.Mesh(
    GEO.box,
    new THREE.MeshStandardMaterial({ color: 0x6a241c, roughness: 1, transparent: true, opacity: 0.0 }),
  );
  bruise.name = "wound-bruise";
  bruise.scale.set(1.12, 1.12, 1.12);
  bruise.visible = false;
  bruise.castShadow = false;
  parent.add(bruise);
  const cut = new THREE.Mesh(GEO.box, new THREE.MeshStandardMaterial({ color: 0x2a0808, roughness: 0.9, metalness: 0.05 }));
  cut.name = "wound-cut";
  cut.scale.set(0.18, 0.85, 0.07);
  cut.rotation.z = ((id % 7) - 3) * 0.16;
  cut.rotation.x = 0.2;
  cut.visible = false;
  parent.add(cut);
  const burn = new THREE.Mesh(
    GEO.box,
    new THREE.MeshStandardMaterial({ color: 0x1a120c, emissive: 0x4a2208, emissiveIntensity: 0.2, roughness: 1 }),
  );
  burn.name = "wound-burn";
  burn.scale.set(1.08, 0.45, 1.08);
  burn.visible = false;
  parent.add(burn);
}

function paintWounds(mesh: THREE.Object3D | undefined, inj: Injury) {
  if (!mesh) return;
  const bruise = mesh.getObjectByName("wound-bruise") as THREE.Mesh | undefined;
  const cut = mesh.getObjectByName("wound-cut") as THREE.Mesh | undefined;
  const burn = mesh.getObjectByName("wound-burn") as THREE.Mesh | undefined;
  if (bruise) {
    const amt = inj.bruise + inj.sprain * 0.4;
    bruise.visible = amt > 0.1;
    const m = bruise.material as THREE.MeshStandardMaterial;
    m.opacity = amt < 0 ? 0 : amt > 1 ? 0.7 : amt * 0.7;
    m.color.setRGB(0.42 + amt * 0.1, 0.12, 0.1);
  }
  if (cut) cut.visible = inj.cut + inj.puncture > 0.08;
  if (burn) {
    burn.visible = inj.burn > 0.1;
    const m = burn.material as THREE.MeshStandardMaterial;
    m.emissiveIntensity = 0.12 + Math.min(0.5, inj.burn);
  }
}

function tintInjury(base: number, amount: number) {
  const key = base + ":" + ((amount * 8) | 0);
  let m = injuryMats.get(key);
  if (!m) {
    const c = new THREE.Color(base);
    c.r = Math.min(1, c.r + amount * 0.25);
    c.g *= 1 - amount * 0.3;
    c.b *= 1 - amount * 0.3;
    m = mat(c.getHex());
    injuryMats.set(key, m);
  }
  return m;
}
