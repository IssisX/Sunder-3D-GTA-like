import * as THREE from "three";
import type { Actor, WeaponKind } from "./types";
import { injurySum } from "./world";
import { BODY, type BodyRig, PhysicalBodies } from "./body";
import type { View } from "./render";

interface HumanVisual {
  group: THREE.Group;
  head: THREE.Mesh;
  torso: THREE.Mesh;
  chest: THREE.Mesh;
  pelvis: THREE.Mesh;
  neck: THREE.Mesh;
  lArm: THREE.Mesh;
  rArm: THREE.Mesh;
  lLeg: THREE.Mesh;
  rLeg: THREE.Mesh;
  lHand: THREE.Mesh;
  rHand: THREE.Mesh;
  lFoot: THREE.Mesh;
  rFoot: THREE.Mesh;
  weapon: THREE.Mesh;
  mats: {
    head: THREE.MeshStandardMaterial;
    chest: THREE.MeshStandardMaterial;
    pelvis: THREE.MeshStandardMaterial;
    lArm: THREE.MeshStandardMaterial;
    rArm: THREE.MeshStandardMaterial;
    lLeg: THREE.MeshStandardMaterial;
    rLeg: THREE.MeshStandardMaterial;
    weapon: THREE.MeshStandardMaterial;
  };
}

const LIMB_RINGS = 11;
const LIMB_RADIAL = 9;

function material(color: number, metalness = 0.03, roughness = 0.78) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}

function weaponColor(kind: WeaponKind) {
  if (kind === "knife" || kind === "spear" || kind === "pitchfork") return 0x77756f;
  if (kind === "torch") return 0x604326;
  if (kind === "board" || kind === "club") return 0x654b31;
  return 0x5c5145;
}

function weaponLength(kind: WeaponKind) {
  if (kind === "spear" || kind === "pitchfork") return 1.55;
  if (kind === "club" || kind === "board") return 0.92;
  if (kind === "torch") return 0.82;
  if (kind === "knife") return 0.48;
  return 0.3;
}

function makeLimbGeometry() {
  const vertexCount = LIMB_RINGS * LIMB_RADIAL;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices: number[] = [];
  for (let ring = 0; ring < LIMB_RINGS - 1; ring++) {
    for (let j = 0; j < LIMB_RADIAL; j++) {
      const a = ring * LIMB_RADIAL + j;
      const b = ring * LIMB_RADIAL + ((j + 1) % LIMB_RADIAL);
      const c = (ring + 1) * LIMB_RADIAL + j;
      const d = (ring + 1) * LIMB_RADIAL + ((j + 1) % LIMB_RADIAL);
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

export class BodyView {
  private visuals = new Map<number, HumanVisual>();
  private sphere = new THREE.SphereGeometry(0.5, 18, 14);
  private handGeo = new THREE.SphereGeometry(0.5, 12, 9);
  private footGeo = new THREE.SphereGeometry(0.5, 12, 8);
  private neckGeo = new THREE.CylinderGeometry(0.46, 0.52, 1, 12);
  private torsoGeo = new THREE.CylinderGeometry(0.5, 0.36, 1, 16);
  private cylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  private up = new THREE.Vector3(0, 1, 0);
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private d = new THREE.Vector3();
  private p0 = new THREE.Vector3();
  private p1 = new THREE.Vector3();
  private p2 = new THREE.Vector3();
  private tangent = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private binormal = new THREE.Vector3();
  private ref = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private color = new THREE.Color();

  constructor(
    private view: View,
    private bodies: PhysicalBodies,
  ) {}

  bootstrap(actors: Actor[]) {
    for (const a of actors) {
      if (a.species !== "human" && a.kind !== "player") continue;
      this.ensure(a);
    }
  }

  forget() {
    this.visuals.clear();
  }

  sync(actors: Actor[], alpha: number) {
    for (const a of actors) {
      if (a.species !== "human" && a.kind !== "player") continue;
      const legacy = this.view.actorMap.get(a.id);
      if (legacy) legacy.visible = false;
      const rig = this.bodies.get(a);
      if (!rig?.initialized) continue;
      const visual = this.ensure(a);
      this.syncHuman(a, rig, visual, alpha);
      this.syncHeldProp(a, rig, alpha);
    }
  }

  private ensure(a: Actor) {
    const existing = this.visuals.get(a.id);
    if (existing) return existing;

    const mats = {
      head: material(a.skin),
      chest: material(a.cloth),
      pelvis: material(a.accent),
      lArm: material(a.skin),
      rArm: material(a.skin),
      lLeg: material(a.accent),
      rLeg: material(a.accent),
      weapon: material(
        weaponColor(a.weapon),
        a.weapon === "knife" ? 0.42 : 0.08,
        0.62,
      ),
    };
    const group = new THREE.Group();

    const head = new THREE.Mesh(this.sphere, mats.head);
    const torso = new THREE.Mesh(this.torsoGeo, mats.chest);
    const chest = new THREE.Mesh(this.sphere, mats.chest);
    const pelvis = new THREE.Mesh(this.sphere, mats.pelvis);
    const neck = new THREE.Mesh(this.neckGeo, mats.head);
    const lArm = new THREE.Mesh(makeLimbGeometry(), mats.lArm);
    const rArm = new THREE.Mesh(makeLimbGeometry(), mats.rArm);
    const lLeg = new THREE.Mesh(makeLimbGeometry(), mats.lLeg);
    const rLeg = new THREE.Mesh(makeLimbGeometry(), mats.rLeg);
    const lHand = new THREE.Mesh(this.handGeo, mats.lArm);
    const rHand = new THREE.Mesh(this.handGeo, mats.rArm);
    const lFoot = new THREE.Mesh(this.footGeo, mats.lLeg);
    const rFoot = new THREE.Mesh(this.footGeo, mats.rLeg);
    const weapon = new THREE.Mesh(this.cylinder, mats.weapon);

    for (const mesh of [
      head,
      torso,
      chest,
      pelvis,
      neck,
      lArm,
      rArm,
      lLeg,
      rLeg,
      lHand,
      rHand,
      lFoot,
      rFoot,
      weapon,
    ]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    for (const limb of [lArm, rArm, lLeg, rLeg]) limb.frustumCulled = false;

    if (a.helmet) {
      const helmet = new THREE.Mesh(
        this.sphere,
        material(0x4a4c50, 0.5, 0.42),
      );
      helmet.name = "helmet";
      helmet.castShadow = true;
      group.add(helmet);
    }

    this.view.scene.add(group);
    const visual: HumanVisual = {
      group,
      head,
      torso,
      chest,
      pelvis,
      neck,
      lArm,
      rArm,
      lLeg,
      rLeg,
      lHand,
      rHand,
      lFoot,
      rFoot,
      weapon,
      mats,
    };
    this.visuals.set(a.id, visual);
    return visual;
  }

  private node(
    rig: BodyRig,
    i: number,
    alpha: number,
    out: THREE.Vector3,
  ) {
    out.set(
      rig.px[i]! + (rig.x[i]! - rig.px[i]!) * alpha,
      rig.py[i]! + (rig.y[i]! - rig.py[i]!) * alpha,
      rig.pz[i]! + (rig.z[i]! - rig.pz[i]!) * alpha,
    );
    return out;
  }

  private segment(
    mesh: THREE.Mesh,
    rig: BodyRig,
    ia: number,
    ib: number,
    width: number,
    depth: number,
    alpha: number,
    pad = 0,
  ) {
    this.node(rig, ia, alpha, this.a);
    this.node(rig, ib, alpha, this.b);
    this.d.subVectors(this.b, this.a);
    const rawLength = Math.max(0.001, this.d.length());
    mesh.position.copy(this.a).addScaledVector(this.d, 0.5);
    this.d.multiplyScalar(1 / rawLength);
    this.q.setFromUnitVectors(this.up, this.d);
    mesh.quaternion.copy(this.q);
    mesh.scale.set(width, rawLength + pad * 2, depth);
  }

  // One continuously curved mesh passes through start -> joint -> end.
  // All scratch vectors are persistent: zero new THREE.* allocations in sync().
  private curvedLimb(
    mesh: THREE.Mesh,
    actor: Actor,
    rig: BodyRig,
    startNode: number,
    jointNode: number,
    endNode: number,
    startRadius: number,
    jointRadius: number,
    endRadius: number,
    alpha: number,
  ) {
    this.node(rig, startNode, alpha, this.p0);
    this.node(rig, jointNode, alpha, this.p1);
    this.node(rig, endNode, alpha, this.p2);

    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const nor = mesh.geometry.getAttribute("normal") as THREE.BufferAttribute;
    const scale = actor.height / 1.72;
    const forwardX = -Math.sin(actor.yaw);
    const forwardZ = -Math.cos(actor.yaw);

    for (let ring = 0; ring < LIMB_RINGS; ring++) {
      const t = ring / (LIMB_RINGS - 1);
      const l0 = 2 * (t - 0.5) * (t - 1);
      const l1 = -4 * t * (t - 1);
      const l2 = 2 * t * (t - 0.5);
      const dl0 = 4 * t - 3;
      const dl1 = -8 * t + 4;
      const dl2 = 4 * t - 1;

      const px = this.p0.x * l0 + this.p1.x * l1 + this.p2.x * l2;
      const py = this.p0.y * l0 + this.p1.y * l1 + this.p2.y * l2;
      const pz = this.p0.z * l0 + this.p1.z * l1 + this.p2.z * l2;
      this.tangent.set(
        this.p0.x * dl0 + this.p1.x * dl1 + this.p2.x * dl2,
        this.p0.y * dl0 + this.p1.y * dl1 + this.p2.y * dl2,
        this.p0.z * dl0 + this.p1.z * dl1 + this.p2.z * dl2,
      ).normalize();

      if (Math.abs(this.tangent.y) < 0.86) this.ref.set(0, 1, 0);
      else this.ref.set(forwardX, 0, forwardZ).normalize();
      this.normal.crossVectors(this.tangent, this.ref).normalize();
      if (this.normal.lengthSq() < 1e-6) this.normal.set(1, 0, 0);
      this.binormal.crossVectors(this.normal, this.tangent).normalize();

      const s = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const r0 = t < 0.5 ? startRadius : jointRadius;
      const r1 = t < 0.5 ? jointRadius : endRadius;
      const q = s * s * (3 - 2 * s);
      const radius = (r0 + (r1 - r0) * q) * scale;

      for (let j = 0; j < LIMB_RADIAL; j++) {
        const angle = (j / LIMB_RADIAL) * Math.PI * 2;
        const ca = Math.cos(angle);
        const sa = Math.sin(angle);
        const nx = this.normal.x * ca + this.binormal.x * sa;
        const ny = this.normal.y * ca + this.binormal.y * sa;
        const nz = this.normal.z * ca + this.binormal.z * sa;
        const index = ring * LIMB_RADIAL + j;
        pos.setXYZ(index, px + nx * radius, py + ny * radius, pz + nz * radius);
        nor.setXYZ(index, nx, ny, nz);
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
  }

  private orientEndpoint(
    mesh: THREE.Mesh,
    rig: BodyRig,
    from: number,
    at: number,
    width: number,
    length: number,
    depth: number,
    alpha: number,
  ) {
    this.node(rig, from, alpha, this.a);
    this.node(rig, at, alpha, this.b);
    this.d.subVectors(this.b, this.a);
    const rawLength = Math.max(0.001, this.d.length());
    this.d.multiplyScalar(1 / rawLength);
    this.q.setFromUnitVectors(this.up, this.d);
    mesh.position.copy(this.b);
    mesh.quaternion.copy(this.q);
    mesh.scale.set(width, length, depth);
  }

  private tint(
    mat: THREE.MeshStandardMaterial,
    base: number,
    amount: number,
  ) {
    this.color.set(base);
    const t = Math.min(1.2, amount);
    this.color.r = Math.min(1, this.color.r + t * 0.22);
    this.color.g *= 1 - t * 0.28;
    this.color.b *= 1 - t * 0.3;
    mat.color.copy(this.color);
  }

  private syncHeldProp(a: Actor, rig: BodyRig, alpha: number) {
    if (!a.grabbedId) return;
    const held = this.view.propMap.get(a.grabbedId);
    if (!held) return;
    const scale = a.height / 1.72;
    this.node(rig, BODY.rHand, alpha, this.a);
    held.visible = true;
    held.position.set(this.a.x, this.a.y - 0.06 * scale, this.a.z);
    held.rotation.set(0, a.yaw, 0);
  }

  private syncHuman(
    a: Actor,
    rig: BodyRig,
    v: HumanVisual,
    alpha: number,
  ) {
    const scale = a.height / 1.72;
    v.group.position.set(0, 0, 0);
    v.group.rotation.set(0, 0, 0);

    this.segment(v.torso, rig, BODY.pelvis, BODY.chest, 0.62 * scale, 0.4 * scale, alpha, 0.055 * scale);

    this.node(rig, BODY.chest, alpha, this.a);
    v.chest.position.copy(this.a);
    v.chest.quaternion.copy(v.torso.quaternion);
    v.chest.scale.set(0.69 * scale, 0.34 * scale, 0.43 * scale);

    this.node(rig, BODY.pelvis, alpha, this.a);
    v.pelvis.position.copy(this.a);
    v.pelvis.quaternion.copy(v.torso.quaternion);
    v.pelvis.scale.set(0.56 * scale, 0.27 * scale, 0.38 * scale);

    this.segment(v.neck, rig, BODY.chest, BODY.head, 0.17 * scale, 0.15 * scale, alpha, 0.03 * scale);

    this.curvedLimb(v.lArm, a, rig, BODY.lShoulder, BODY.lElbow, BODY.lHand, 0.125, 0.105, 0.082, alpha);
    this.curvedLimb(v.rArm, a, rig, BODY.rShoulder, BODY.rElbow, BODY.rHand, 0.125, 0.105, 0.082, alpha);
    this.curvedLimb(v.lLeg, a, rig, BODY.lHip, BODY.lKnee, BODY.lFoot, 0.155, 0.13, 0.095, alpha);
    this.curvedLimb(v.rLeg, a, rig, BODY.rHip, BODY.rKnee, BODY.rFoot, 0.155, 0.13, 0.095, alpha);

    this.node(rig, BODY.head, alpha, this.a);
    v.head.position.copy(this.a);
    v.head.quaternion.copy(v.neck.quaternion);
    v.head.scale.set(0.29 * scale, 0.33 * scale, 0.27 * scale);

    this.orientEndpoint(v.lHand, rig, BODY.lElbow, BODY.lHand, 0.13 * scale, 0.18 * scale, 0.09 * scale, alpha);
    this.orientEndpoint(v.rHand, rig, BODY.rElbow, BODY.rHand, 0.13 * scale, 0.18 * scale, 0.09 * scale, alpha);
    this.orientEndpoint(v.lFoot, rig, BODY.lKnee, BODY.lFoot, 0.18 * scale, 0.24 * scale, 0.13 * scale, alpha);
    this.orientEndpoint(v.rFoot, rig, BODY.rKnee, BODY.rFoot, 0.18 * scale, 0.24 * scale, 0.13 * scale, alpha);

    const helmet = v.group.getObjectByName("helmet") as THREE.Mesh | undefined;
    if (helmet) {
      helmet.position.copy(v.head.position);
      helmet.position.y += 0.06 * scale;
      helmet.quaternion.copy(v.head.quaternion);
      helmet.scale.set(0.34 * scale, 0.24 * scale, 0.32 * scale);
    }

    // Weapon axis is derived from the live forearm/hand chain. It therefore
    // follows the kinetic-chain strike instead of remaining rigidly yaw-locked.
    const forwardX = -Math.sin(a.yaw);
    const forwardZ = -Math.cos(a.yaw);
    const len = weaponLength(a.weapon) * scale;
    this.node(rig, BODY.rElbow, alpha, this.a);
    this.node(rig, BODY.rHand, alpha, this.b);
    this.d.subVectors(this.b, this.a);
    let armLen = this.d.length();
    if (armLen < 1e-5) {
      this.d.set(forwardX, 0, forwardZ);
      armLen = 1;
    } else {
      this.d.multiplyScalar(1 / armLen);
      const follow = a.weapon === "spear" || a.weapon === "pitchfork" ? 0.82 : 0.93;
      this.d.x = this.d.x * follow + forwardX * (1 - follow);
      this.d.z = this.d.z * follow + forwardZ * (1 - follow);
      const dm = this.d.length() || 1;
      this.d.multiplyScalar(1 / dm);
    }
    this.a.copy(this.b);
    this.b.copy(this.a).addScaledVector(this.d, len);
    const wlen = Math.max(0.001, len);
    v.weapon.position.copy(this.a).addScaledVector(this.d, wlen * 0.5);
    this.q.setFromUnitVectors(this.up, this.d);
    v.weapon.quaternion.copy(this.q);
    v.weapon.scale.set(0.045 * scale, wlen, 0.045 * scale);
    v.weapon.visible = a.weapon !== "fist" && !a.grabbedId;
    v.mats.weapon.color.setHex(weaponColor(a.weapon));
    v.mats.weapon.metalness =
      a.weapon === "knife" || a.weapon === "spear" || a.weapon === "pitchfork" ? 0.42 : 0.08;

    this.tint(v.mats.head, a.skin, injurySum(a.injuries.head));
    this.tint(v.mats.chest, a.cloth, injurySum(a.injuries.torso));
    this.tint(v.mats.pelvis, a.accent, injurySum(a.injuries.torso) * 0.55);
    this.tint(v.mats.lArm, a.skin, injurySum(a.injuries.larm));
    this.tint(v.mats.rArm, a.skin, injurySum(a.injuries.rarm));
    this.tint(v.mats.lLeg, a.accent, injurySum(a.injuries.lleg));
    this.tint(v.mats.rLeg, a.accent, injurySum(a.injuries.rleg));
  }
}
