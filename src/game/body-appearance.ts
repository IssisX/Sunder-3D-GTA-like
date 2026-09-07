import * as THREE from "three";
import type { Actor, WeaponKind } from "./types";
import { BODY, type BodyRig, type PhysicalBodies } from "./body";
import type { View } from "./render";
import { BodyView as CoreBodyView, type HumanVisual } from "./body-render-core";

interface Appearance {
  visual: HumanVisual;
  weapon: THREE.Group;
  weaponKind: WeaponKind | null;
  flame: THREE.Object3D | null;
  light: THREE.PointLight | null;
  materials: THREE.Material[];
  flameMaterial: THREE.MeshBasicMaterial;
  shoulderCaps: [THREE.Mesh, THREE.Mesh];
}
const GEO = {
  sphere: new THREE.SphereGeometry(0.5, 16, 12),
  box: new THREE.BoxGeometry(1, 1, 1),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
  torso: new THREE.CylinderGeometry(0.5, 0.4, 1, 18),
  waist: new THREE.CylinderGeometry(0.42, 0.48, 1, 16),
  hair: new THREE.SphereGeometry(0.51, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.59),
  capsule: new THREE.CapsuleGeometry(0.5, 0.3, 4, 8),
  cone: new THREE.ConeGeometry(0.5, 1, 12),
};
function mat(color: number, roughness = 0.78, metalness = 0.03) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}
function mesh(g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D,
  x: number, y: number, z: number, sx: number, sy: number, sz: number) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z); o.scale.set(sx, sy, sz);
  o.castShadow = true; o.receiveShadow = true;
  parent.add(o); return o;
}

/**
 * Grok's richer anatomical construction adapted to the authoritative 15-node
 * body. The original curved limbs, task solver, contacts, and damage remain
 * untouched. Every orientation is derived from solved points, not an animation.
 */
const VISUAL_WEAPON_RANGES: Record<WeaponKind, readonly [number, number]> = {
  fist: [-0.5, 0.5], club: [-0.49, 0.53], board: [-0.5, 0.5],
  spear: [-0.5, 0.55], pitchfork: [-0.5, 0.635],
  knife: [-0.5, 0.52], torch: [-0.47, 0.71],
};

export class BodyView extends CoreBodyView {
  private readonly appearances = new Map<number, Appearance>();
  private readonly right = new THREE.Vector3();
  private readonly appearanceUp = new THREE.Vector3();
  private readonly back = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();
  private readonly orientation = new THREE.Quaternion();
  private readonly forward = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly weaponOffset = new THREE.Vector3();

  constructor(private readonly sceneView: View, private readonly bodySource: PhysicalBodies) {
    super(sceneView, bodySource);
  }

  // The original renderer exposes only its presentation record. The physical
  // rig remains read-only and the original curved limb meshes stay authoritative.
  private coreVisual(id: number): HumanVisual | undefined {
    return this.getVisual(id);
  }

  override bootstrap(actors: Actor[]) {
    super.bootstrap(actors);
    for (const a of actors) if (a.kind === "player" || a.species === "human") this.ensureAppearance(a);
  }

  override sync(actors: Actor[], alpha: number) {
    super.sync(actors, alpha);
    for (const a of actors) {
      if (a.kind !== "player" && a.species !== "human") continue;
      const rig = this.bodySource.get(a);
      if (!rig?.initialized) continue;
      const appearance = this.ensureAppearance(a);
      if (appearance) this.syncAppearance(a, rig, appearance, alpha);
    }
  }

  override forget() {
    // Shared geometry survives a restart; only actor-owned resources are released.
    for (const app of this.appearances.values()) {
      const v = app.visual;
      this.sceneView.scene.remove(v.group);
      for (const limb of [v.lArm, v.rArm, v.lLeg, v.rLeg]) limb.geometry.dispose();
      for (const m of Object.values(v.mats)) m.dispose();
      const helmet = v.group.getObjectByName("helmet");
      if (helmet instanceof THREE.Mesh) {
        if (Array.isArray(helmet.material)) helmet.material.forEach(m => m.dispose());
        else helmet.material.dispose();
      }
      for (const m of app.materials) m.dispose();
    }
    this.appearances.clear();
    super.forget();
  }

  private ensureAppearance(a: Actor): Appearance | undefined {
    const existing = this.appearances.get(a.id);
    if (existing) return existing;
    const v = this.coreVisual(a.id);
    if (!v) return undefined;
    const owned: THREE.Material[] = [];
    const make = (c: number, r = 0.78, metal = 0.03) => {
      const m = mat(c, r, metal); owned.push(m); return m;
    };
    const skin = v.mats.head;
    const cloth = v.mats.chest;
    const dark = make(0x22201e, 0.92);
    const leather = make(0x342a23, 0.82);
    const metal = make(0x929ba1, 0.34, 0.72);
    const hairColors = [0x201914, 0x35251b, 0x57412b, 0x171b1d, 0x73604a];
    const hair = make(hairColors[Math.abs(a.id) % hairColors.length]!, 0.96);
    const eye = make(0x191c1b, 0.42);
    const lip = make(new THREE.Color(a.skin).multiplyScalar(0.62).getHex(), 0.92);
    const flameMaterial = new THREE.MeshBasicMaterial({ color: 0xffb34d, transparent: true, opacity: 0.86 });
    owned.push(flameMaterial);

    // Replace the barrel silhouette with a tapered chest and a real waist.
    v.torso.geometry = GEO.torso;
    v.pelvis.geometry = GEO.waist;
    const head = v.head;
    mesh(GEO.hair, hair, head, 0, 0.055, 0.015, 1.03, 1.05, 1.04);
    for (const side of [-1, 1]) {
      mesh(GEO.sphere, skin, head, side * 0.48, -0.035, 0.025, 0.18, 0.28, 0.16);
      mesh(GEO.sphere, eye, head, side * 0.18, 0.045, -0.455, 0.115, 0.09, 0.07);
      mesh(GEO.box, hair, head, side * 0.18, 0.16, -0.47, 0.27, 0.045, 0.045).rotation.z = side * 0.08;
    }
    mesh(GEO.sphere, skin, head, 0, -0.05, -0.47, 0.19, 0.28, 0.27);
    mesh(GEO.box, lip, head, 0, -0.26, -0.466, 0.3, 0.035, 0.035);
    if (a.id % 5 === 2 && !a.helmet) {
      mesh(GEO.sphere, hair, head, 0, -0.31, -0.13, 0.72, 0.28, 0.76);
    }
    const collar = mesh(GEO.cylinder, cloth, v.chest, 0, 0.36, 0, 0.4, 0.18, 0.42);
    collar.name = "collar";
    mesh(GEO.cylinder, leather, v.pelvis, 0, 0.43, 0, 1.04, 0.16, 1.04);
    mesh(GEO.box, metal, v.pelvis, 0, 0.44, -0.51, 0.2, 0.15, 0.08);
    const shoulderCaps = [BODY.lShoulder, BODY.rShoulder].map((node) => {
      const cap = mesh(GEO.sphere, cloth, v.group, 0, 0, 0, 1, 1, 1);
      cap.name = node === BODY.lShoulder ? "left-shoulder-cap" : "right-shoulder-cap";
      return cap;
    }) as [THREE.Mesh, THREE.Mesh];
    for (const hand of [v.lHand, v.rHand]) {
      for (let finger = 0; finger < 4; finger++) {
        mesh(GEO.capsule, skin, hand, (finger - 1.5) * 0.21, -0.43, -0.1,
          0.19, 0.3, 0.23);
      }
      mesh(GEO.capsule, skin, hand, 0.48, -0.08, -0.16, 0.23, 0.37, 0.24).rotation.z = -0.8;
    }
    for (const foot of [v.lFoot, v.rFoot]) {
      foot.geometry = GEO.box;
      foot.material = leather;
      mesh(GEO.sphere, leather, foot, 0, -0.1, -0.37, 0.94, 0.85, 0.68);
      mesh(GEO.box, dark, foot, 0, -0.48, -0.08, 1.06, 0.18, 1.06);
      mesh(GEO.box, dark, foot, 0, -0.15, -0.53, 0.9, 0.04, 0.09);
    }
    const weapon = new THREE.Group();
    v.group.add(weapon);
    v.weapon.visible = false;
    const app: Appearance = { visual: v, weapon, weaponKind: null, flame: null, light: null, materials: owned, flameMaterial, shoulderCaps };
    this.appearances.set(a.id, app);
    this.rebuildWeapon(a, app, leather, metal, dark);
    return app;
  }

  private read(rig: BodyRig, node: number, alpha: number, out: THREE.Vector3) {
    return out.set(rig.px[node]! + (rig.x[node]! - rig.px[node]!) * alpha,
      rig.py[node]! + (rig.y[node]! - rig.py[node]!) * alpha,
      rig.pz[node]! + (rig.z[node]! - rig.pz[node]!) * alpha);
  }

  private syncAppearance(a: Actor, rig: BodyRig, app: Appearance, alpha: number) {
    const v = app.visual;
    const scale = a.height / 1.72;
    this.read(rig, BODY.chest, alpha, this.appearanceUp);
    this.read(rig, BODY.head, alpha, this.tmp);
    this.appearanceUp.subVectors(this.tmp, this.appearanceUp);
    if (this.appearanceUp.lengthSq() < 1e-7) this.appearanceUp.set(0, 1, 0);
    this.appearanceUp.normalize();
    this.read(rig, BODY.lShoulder, alpha, this.right);
    this.read(rig, BODY.rShoulder, alpha, this.tmp);
    this.right.subVectors(this.tmp, this.right);
    this.right.addScaledVector(this.appearanceUp, -this.right.dot(this.appearanceUp));
    if (this.right.lengthSq() < 1e-7) this.right.set(Math.cos(a.yaw), 0, -Math.sin(a.yaw));
    this.right.normalize();
    this.back.crossVectors(this.right, this.appearanceUp).normalize();
    this.right.crossVectors(this.appearanceUp, this.back).normalize();
    this.basis.makeBasis(this.right, this.appearanceUp, this.back);
    this.orientation.setFromRotationMatrix(this.basis);
    v.head.quaternion.copy(this.orientation);
    v.chest.quaternion.copy(this.orientation);
    v.pelvis.quaternion.copy(this.orientation);
    v.torso.quaternion.copy(this.orientation);
    v.torso.scale.set(0.68 * scale, v.torso.scale.y, 0.42 * scale);
    v.chest.scale.set(0.7 * scale, 0.34 * scale, 0.44 * scale);
    v.pelvis.scale.set(0.56 * scale, 0.27 * scale, 0.4 * scale);
    for (let i = 0; i < 2; i++) {
      const node = i === 0 ? BODY.lShoulder : BODY.rShoulder;
      const cap = app.shoulderCaps[i]!;
      this.read(rig, node, alpha, cap.position);
      cap.quaternion.copy(this.orientation);
      cap.scale.setScalar(0.23 * scale);
    }
    // The ankle is the physical contact point. Boot length projects forward
    // from that point; it does not inherit the shin's vertical orientation.
    this.forward.copy(this.back).multiplyScalar(-1);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-7) this.forward.set(-Math.sin(a.yaw), 0, -Math.cos(a.yaw));
    this.forward.normalize();
    this.right.crossVectors(this.worldUp, this.forward).multiplyScalar(-1).normalize();
    this.back.copy(this.forward).negate();
    this.basis.makeBasis(this.right, this.worldUp, this.back);
    this.orientation.setFromRotationMatrix(this.basis);
    for (let i = 0; i < 2; i++) {
      const foot = i === 0 ? v.lFoot : v.rFoot;
      foot.quaternion.copy(this.orientation);
      foot.position.addScaledVector(this.forward, 0.075 * scale);
      foot.position.y -= 0.015 * scale;
      foot.scale.set(0.19 * scale, 0.11 * scale, 0.32 * scale);
    }
    // Use the original carrier's solved hand/forearm alignment and reach.
    // The old proxy is hidden, but its transform remains the exact adapter.
    app.weapon.visible = a.weapon !== "fist" && !a.grabbedId;
    v.weapon.visible = false;
    if (app.weaponKind !== a.weapon) {
      const leather = app.materials[1]!;
      const metal = app.materials[2]!;
      const dark = app.materials[0]!;
      this.rebuildWeapon(a, app, leather, metal, dark);
    }
    app.weapon.position.copy(v.weapon.position);
    app.weapon.quaternion.copy(v.weapon.quaternion);
    // Match the actual carrier length and center. The decorative mesh cannot
    // silently extend the physical weapon reach.
    const range = VISUAL_WEAPON_RANGES[a.weapon];
    const span = range[1] - range[0];
    const sy = v.weapon.scale.y / span;
    app.weapon.scale.set(scale, sy, scale);
    this.weaponOffset.set(0, (range[0] + range[1]) * -0.5 * sy, 0);
    this.weaponOffset.applyQuaternion(v.weapon.quaternion);
    app.weapon.position.add(this.weaponOffset);
    if (app.flame) app.flame.visible = a.torchLit;
    if (app.light) app.light.intensity = a.torchLit ? 1.15 : 0;
  }

  private rebuildWeapon(a: Actor, app: Appearance, leather: THREE.Material, metal: THREE.Material, dark: THREE.Material) {
    app.weapon.clear();
    app.weaponKind = a.weapon;
    app.flame = null; app.light = null;
    const root = app.weapon;
    const wood = app.visual.mats.weapon;
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
      mesh(g, m, root, x, y, z, sx, sy, sz);
    const kind = a.weapon;
    if (kind === "fist") return;
    if (kind === "club") {
      add(GEO.cylinder, wood, 0, -0.08, 0, 0.11, 0.82, 0.11);
      add(GEO.sphere, leather, 0, 0.37, 0, 0.3, 0.32, 0.3);
    } else if (kind === "board") {
      add(GEO.box, wood, 0, 0, 0, 0.26, 1, 0.055);
      add(GEO.box, dark, 0, -0.3, 0, 0.27, 0.12, 0.062);
    } else if (kind === "spear" || kind === "pitchfork") {
      add(GEO.cylinder, wood, 0, -0.06, 0, 0.055, 0.88, 0.055);
      if (kind === "spear") add(GEO.cone, metal, 0, 0.45, 0, 0.15, 0.2, 0.15);
      else {
        add(GEO.box, metal, 0, 0.39, 0, 0.34, 0.035, 0.06);
        for (const x of [-0.15, 0, 0.15]) add(GEO.cylinder, metal, x, 0.51, 0, 0.035, 0.25, 0.035);
      }
    } else if (kind === "knife") {
      add(GEO.box, leather, 0, -0.3, 0, 0.08, 0.4, 0.07);
      add(GEO.box, metal, 0, 0.14, 0, 0.12, 0.54, 0.035);
      add(GEO.cone, metal, 0, 0.44, 0, 0.12, 0.16, 0.035);
    } else if (kind === "torch") {
      add(GEO.cylinder, wood, 0, -0.08, 0, 0.095, 0.78, 0.095);
      add(GEO.sphere, leather, 0, 0.34, 0, 0.2, 0.2, 0.2);
      const flame = add(GEO.cone, app.flameMaterial,
        0, 0.53, 0, 0.26, 0.36, 0.26);
      app.flame = flame;
      if (a.kind === "player") {
        const light = new THREE.PointLight(0xffa34d, 1.15, 7, 2);
        flame.add(light); app.light = light;
      }
    }
  }
}
