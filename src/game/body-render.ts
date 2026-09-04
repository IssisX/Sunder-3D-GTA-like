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
  lUpperArm: THREE.Mesh;
  lLowerArm: THREE.Mesh;
  rUpperArm: THREE.Mesh;
  rLowerArm: THREE.Mesh;
  lUpperLeg: THREE.Mesh;
  lLowerLeg: THREE.Mesh;
  rUpperLeg: THREE.Mesh;
  rLowerLeg: THREE.Mesh;
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

function material(color: number, metalness = 0.03, roughness = 0.84) {
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

export class BodyView {
  private visuals = new Map<number, HumanVisual>();
  private sphere = new THREE.SphereGeometry(0.5, 12, 10);
  private box = new THREE.BoxGeometry(1, 1, 1);
  private neckGeo = new THREE.CylinderGeometry(0.46, 0.52, 1, 10);
  private torsoGeo = new THREE.CylinderGeometry(0.5, 0.36, 1, 12);
  private upperArmGeo = new THREE.CylinderGeometry(0.43, 0.53, 1, 10);
  private lowerArmGeo = new THREE.CylinderGeometry(0.38, 0.46, 1, 10);
  private upperLegGeo = new THREE.CylinderGeometry(0.44, 0.56, 1, 10);
  private lowerLegGeo = new THREE.CylinderGeometry(0.36, 0.45, 1, 10);
  private cylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  private up = new THREE.Vector3(0, 1, 0);
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private d = new THREE.Vector3();
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
    const lUpperArm = new THREE.Mesh(this.upperArmGeo, mats.lArm);
    const lLowerArm = new THREE.Mesh(this.lowerArmGeo, mats.lArm);
    const rUpperArm = new THREE.Mesh(this.upperArmGeo, mats.rArm);
    const rLowerArm = new THREE.Mesh(this.lowerArmGeo, mats.rArm);
    const lUpperLeg = new THREE.Mesh(this.upperLegGeo, mats.lLeg);
    const lLowerLeg = new THREE.Mesh(this.lowerLegGeo, mats.lLeg);
    const rUpperLeg = new THREE.Mesh(this.upperLegGeo, mats.rLeg);
    const rLowerLeg = new THREE.Mesh(this.lowerLegGeo, mats.rLeg);
    const lHand = new THREE.Mesh(this.box, mats.lArm);
    const rHand = new THREE.Mesh(this.box, mats.rArm);
    const lFoot = new THREE.Mesh(this.box, mats.lLeg);
    const rFoot = new THREE.Mesh(this.box, mats.rLeg);
    const weapon = new THREE.Mesh(this.cylinder, mats.weapon);

    for (const mesh of [
      head,
      torso,
      chest,
      pelvis,
      neck,
      lUpperArm,
      lLowerArm,
      rUpperArm,
      rLowerArm,
      lUpperLeg,
      lLowerLeg,
      rUpperLeg,
      rLowerLeg,
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
      lUpperArm,
      lLowerArm,
      rUpperArm,
      rLowerArm,
      lUpperLeg,
      lLowerLeg,
      rUpperLeg,
      rLowerLeg,
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

  // Limbs overlap their node endpoints. The bend itself is the joint - there
  // is no separate sphere covering elbows/knees/shoulders/hips anymore.
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
    held.position.set(
      this.a.x,
      this.a.y - 0.06 * scale,
      this.a.z,
    );
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

    // Organic torso volumes replace the old box-plank body. The tapered trunk
    // follows pelvis-to-chest while the chest/pelvis ellipsoids cover shoulder
    // and hip roots without exposing construction joints.
    this.segment(
      v.torso,
      rig,
      BODY.pelvis,
      BODY.chest,
      0.62 * scale,
      0.4 * scale,
      alpha,
      0.055 * scale,
    );

    this.node(rig, BODY.chest, alpha, this.a);
    v.chest.position.copy(this.a);
    v.chest.quaternion.copy(v.torso.quaternion);
    v.chest.scale.set(0.7 * scale, 0.36 * scale, 0.44 * scale);

    this.node(rig, BODY.pelvis, alpha, this.a);
    v.pelvis.position.copy(this.a);
    v.pelvis.quaternion.copy(v.torso.quaternion);
    v.pelvis.scale.set(0.57 * scale, 0.28 * scale, 0.39 * scale);

    this.segment(
      v.neck,
      rig,
      BODY.chest,
      BODY.head,
      0.17 * scale,
      0.15 * scale,
      alpha,
      0.03 * scale,
    );

    const armPad = 0.055 * scale;
    const legPad = 0.065 * scale;
    this.segment(v.lUpperArm, rig, BODY.lShoulder, BODY.lElbow, 0.22 * scale, 0.2 * scale, alpha, armPad);
    this.segment(v.lLowerArm, rig, BODY.lElbow, BODY.lHand, 0.19 * scale, 0.17 * scale, alpha, armPad);
    this.segment(v.rUpperArm, rig, BODY.rShoulder, BODY.rElbow, 0.22 * scale, 0.2 * scale, alpha, armPad);
    this.segment(v.rLowerArm, rig, BODY.rElbow, BODY.rHand, 0.19 * scale, 0.17 * scale, alpha, armPad);
    this.segment(v.lUpperLeg, rig, BODY.lHip, BODY.lKnee, 0.27 * scale, 0.23 * scale, alpha, legPad);
    this.segment(v.lLowerLeg, rig, BODY.lKnee, BODY.lFoot, 0.22 * scale, 0.19 * scale, alpha, legPad);
    this.segment(v.rUpperLeg, rig, BODY.rHip, BODY.rKnee, 0.27 * scale, 0.23 * scale, alpha, legPad);
    this.segment(v.rLowerLeg, rig, BODY.rKnee, BODY.rFoot, 0.22 * scale, 0.19 * scale, alpha, legPad);

    this.node(rig, BODY.head, alpha, this.a);
    v.head.position.copy(this.a);
    v.head.quaternion.copy(v.neck.quaternion);
    v.head.scale.set(0.29 * scale, 0.33 * scale, 0.27 * scale);

    this.orientEndpoint(v.lHand, rig, BODY.lElbow, BODY.lHand, 0.14 * scale, 0.19 * scale, 0.1 * scale, alpha);
    this.orientEndpoint(v.rHand, rig, BODY.rElbow, BODY.rHand, 0.14 * scale, 0.19 * scale, 0.1 * scale, alpha);

    const forwardX = -Math.sin(a.yaw);
    const forwardZ = -Math.cos(a.yaw);
    this.node(rig, BODY.lFoot, alpha, this.a);
    v.lFoot.position.set(
      this.a.x + forwardX * 0.07 * scale,
      this.a.y,
      this.a.z + forwardZ * 0.07 * scale,
    );
    v.lFoot.scale.set(0.18 * scale, 0.11 * scale, 0.34 * scale);
    v.lFoot.rotation.set(0, a.yaw, 0);

    this.node(rig, BODY.rFoot, alpha, this.a);
    v.rFoot.position.set(
      this.a.x + forwardX * 0.07 * scale,
      this.a.y,
      this.a.z + forwardZ * 0.07 * scale,
    );
    v.rFoot.scale.set(0.18 * scale, 0.11 * scale, 0.34 * scale);
    v.rFoot.rotation.set(0, a.yaw, 0);

    const helmet = v.group.getObjectByName("helmet") as THREE.Mesh | undefined;
    if (helmet) {
      helmet.position.copy(v.head.position);
      helmet.position.y += 0.06 * scale;
      helmet.quaternion.copy(v.head.quaternion);
      helmet.scale.set(0.34 * scale, 0.24 * scale, 0.32 * scale);
    }

    const len = weaponLength(a.weapon) * scale;
    this.node(rig, BODY.rHand, alpha, this.a);
    this.b.set(
      this.a.x + forwardX * len,
      this.a.y +
        (a.weapon === "spear" || a.weapon === "pitchfork"
          ? 0.05 * scale
          : -0.04 * scale),
      this.a.z + forwardZ * len,
    );
    this.d.subVectors(this.b, this.a);
    const wlen = Math.max(0.001, this.d.length());
    v.weapon.position.copy(this.a).addScaledVector(this.d, 0.5);
    this.d.multiplyScalar(1 / wlen);
    this.q.setFromUnitVectors(this.up, this.d);
    v.weapon.quaternion.copy(this.q);
    v.weapon.scale.set(0.045 * scale, wlen, 0.045 * scale);
    v.weapon.visible = a.weapon !== "fist" && !a.grabbedId;
    v.mats.weapon.color.setHex(weaponColor(a.weapon));
    v.mats.weapon.metalness =
      a.weapon === "knife" ||
      a.weapon === "spear" ||
      a.weapon === "pitchfork"
        ? 0.42
        : 0.08;

    this.tint(v.mats.head, a.skin, injurySum(a.injuries.head));
    this.tint(v.mats.chest, a.cloth, injurySum(a.injuries.torso));
    this.tint(v.mats.pelvis, a.accent, injurySum(a.injuries.torso) * 0.55);
    this.tint(v.mats.lArm, a.skin, injurySum(a.injuries.larm));
    this.tint(v.mats.rArm, a.skin, injurySum(a.injuries.rarm));
    this.tint(v.mats.lLeg, a.accent, injurySum(a.injuries.lleg));
    this.tint(v.mats.rLeg, a.accent, injurySum(a.injuries.rleg));
  }
}
