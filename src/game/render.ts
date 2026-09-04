import * as THREE from "three";
import type { Actor, Injury, Particle, Prop, WeaponKind } from "./types";
import { FIRE_RES, HALF, WORLD } from "./types";
import { World, facing, injurySum, lerpAng, rightOf } from "./world";
import type { Cam } from "./sim";
import { P, weaponEnds } from "./physique";

const MESH_REV = 4;
const PROP_REV = 2;

const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 10, 8),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
  cone: new THREE.ConeGeometry(0.5, 1, 8),
  plane: new THREE.PlaneGeometry(1, 1),
};

function mat(color: number, extra: ConstructorParameters<typeof THREE.MeshStandardMaterial>[0] = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.86,
    metalness: 0.04,
    ...extra,
  });
}

function noiseCanvas(size: number, fn: (x: number, y: number, i: number) => [number, number, number]) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [r, gv, b] = fn(x, y, i);
      img.data[i] = r;
      img.data[i + 1] = gv;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export class View {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(54, 1, 0.08, 220);
  sun = new THREE.DirectionalLight(0xf0d8a8, 2.1);
  hemi = new THREE.HemisphereLight(0xb8c4d0, 0x3a3024, 0.85);
  amb = new THREE.AmbientLight(0x2a241c, 0.42);
  fill = new THREE.PointLight(0xffaa66, 0, 18, 2);
  actorMap = new Map<number, THREE.Group>();
  propMap = new Map<number, THREE.Object3D>();
  fireMeshes: THREE.Mesh[] = [];
  smokeMeshes: THREE.Mesh[] = [];
  rain: THREE.Points | null = null;
  ground!: THREE.Mesh;
  groundColors!: THREE.BufferAttribute;
  treeGroup = new THREE.Group();
  lampLights: THREE.PointLight[] = [];
  tmp = new THREE.Vector3();
  tmp2 = new THREE.Vector3();
  camPos = new THREE.Vector3();
  look = new THREE.Vector3();
  trauma = 0;
  reduced = false;
  private woodTex: THREE.Texture;
  private dirtTex: THREE.Texture;
  private disposed = false;
  private fireMat: THREE.MeshBasicMaterial;
  private smokeMat: THREE.MeshBasicMaterial;
  private water!: THREE.Mesh;
  private waterMat: THREE.MeshStandardMaterial;

  constructor(canvas: HTMLCanvasElement) {
    this.reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const touch =
      (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) ||
      (window.matchMedia?.("(pointer: coarse)").matches ?? false);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !touch,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, touch ? 1.35 : 2));
    this.renderer.setClearColor(0x0c0b0a, 1);
    this.renderer.shadowMap.enabled = !touch;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.28;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.fog = new THREE.FogExp2(0x2a241c, 0.012);
    this.scene.add(this.hemi, this.amb, this.sun, this.fill);
    this.hemi.intensity = 0.85;
    this.amb.intensity = 0.42;
    this.sun.castShadow = !touch;
    this.sun.shadow.mapSize.set(touch ? 512 : 1024, touch ? 512 : 1024);
    this.sun.shadow.camera.near = 2;
    this.sun.shadow.camera.far = 90;
    this.sun.shadow.camera.left = -30;
    this.sun.shadow.camera.right = 30;
    this.sun.shadow.camera.top = 30;
    this.sun.shadow.camera.bottom = -30;
    this.sun.shadow.bias = -0.0008;
    this.fill.castShadow = false;

    this.woodTex = noiseCanvas(128, (x, y) => {
      const g = 70 + hash(x * 0.15, y) * 40 + Math.sin(y * 0.4) * 12;
      return [g + 18, g, g - 18];
    });
    this.woodTex.repeat.set(2, 2);
    this.dirtTex = noiseCanvas(128, (x, y) => {
      const n = hash(x * 0.2, y * 0.2);
      const r = 62 + n * 40;
      return [r, r - 14, r - 28];
    });
    this.dirtTex.repeat.set(18, 18);

    this.fireMat = new THREE.MeshBasicMaterial({
      color: 0xffaa55,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.smokeMat = new THREE.MeshBasicMaterial({
      color: 0x2a2824,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    this.waterMat = mat(0x2a3a40, { roughness: 0.18, metalness: 0.2, transparent: true, opacity: 0.72 });

    this.buildGround();
    this.buildSky();
    this.scene.add(this.treeGroup);
  }

  resize(w: number, h: number) {
    const pw = Math.max(1, w);
    const ph = Math.max(1, h);
    this.renderer.setSize(pw, ph, false);
    this.camera.aspect = pw / ph;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.dispose();
    this.woodTex.dispose();
    this.dirtTex.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && m.geometry !== GEO.box && m.geometry !== GEO.sphere && m.geometry !== GEO.cyl && m.geometry !== GEO.cone && m.geometry !== GEO.plane) {
        m.geometry.dispose();
      }
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  }

  private buildSky() {
    const g = new THREE.SphereGeometry(160, 16, 12);
    const m = new THREE.MeshBasicMaterial({ color: 0x1c1a18, side: THREE.BackSide });
    this.scene.add(new THREE.Mesh(g, m));
  }

  private buildGround() {
    const seg = FIRE_RES;
    const geo = new THREE.PlaneGeometry(WORLD, WORLD, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const cols = new Float32Array((seg + 1) * (seg + 1) * 3);
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    this.groundColors = geo.getAttribute("color") as THREE.BufferAttribute;
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: this.dirtTex,
      roughness: 0.95,
      metalness: 0.0,
    });
    this.ground = new THREE.Mesh(geo, m);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.water = new THREE.Mesh(new THREE.PlaneGeometry(WORLD, 7.2), this.waterMat);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.set(0, 0.02, 21);
    this.scene.add(this.water);
  }

  bootstrap(w: World) {
    this.paintGround(w);
    this.buildTrees(w);
    for (const p of w.props) this.ensureProp(p);
    for (const a of w.actors) this.ensureActor(a);
    for (let i = 0; i < 18; i++) {
      const f = new THREE.Mesh(GEO.cone, this.fireMat);
      f.visible = false;
      this.scene.add(f);
      this.fireMeshes.push(f);
    }
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Mesh(GEO.sphere, this.smokeMat.clone());
      s.visible = false;
      this.scene.add(s);
      this.smokeMeshes.push(s);
    }
    const rainGeo = new THREE.BufferGeometry();
    const n = this.renderer.shadowMap.enabled ? 900 : 220;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 50;
      pos[i * 3 + 1] = Math.random() * 16;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 50;
    }
    rainGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.rain = new THREE.Points(
      rainGeo,
      new THREE.PointsMaterial({ color: 0x9aa8b0, size: 0.06, transparent: true, opacity: 0.0 }),
    );
    this.scene.add(this.rain);

    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffc070, 0, 9, 2);
      this.scene.add(l);
      this.lampLights.push(l);
    }
  }

  private buildTrees(w: World) {
    const trunkMat = mat(0x3a2e24);
    const leafMat = mat(0x2f3a28);
    const darkLeaf = mat(0x243022);
    for (const c of w.colliders) {
      if (c.material !== "vegetation") continue;
      const x = (c.minX + c.maxX) * 0.5;
      const z = (c.minZ + c.maxZ) * 0.5;
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(GEO.cyl, trunkMat);
      trunk.scale.set(0.38, 3.4, 0.38);
      trunk.position.y = 1.7;
      trunk.castShadow = true;
      const leaf = new THREE.Mesh(GEO.cone, Math.random() > 0.5 ? leafMat : darkLeaf);
      leaf.scale.set(2.2, 4.2, 2.2);
      leaf.position.y = 4.4;
      leaf.castShadow = true;
      g.add(trunk, leaf);
      g.position.set(x, 0, z);
      this.treeGroup.add(g);
    }
  }

  private paintGround(w: World) {
    const seg = FIRE_RES;
    const attr = this.groundColors;
    const c = new THREE.Color();
    for (let iz = 0; iz <= seg; iz++) {
      for (let ix = 0; ix <= seg; ix++) {
        const i = ix + iz * (seg + 1);
        const x = (ix / seg) * WORLD - HALF;
        const z = (iz / seg) * WORLD - HALF;
        const cell = w.cell(x, z);
        const char = w.char[cell] ?? 0;
        const wet = w.wet[cell] ?? 0;
        const oil = w.oil[cell] ?? 0;
        if (z > 17.2 && z < 24.8) c.set(0x2a3c42);
        else if (Math.abs(x) < 9 && Math.abs(z) < 9) c.set(0x6e675c);
        else if (z < -16) c.set(0x4a5a3c);
        else c.set(0x5c5040);
        c.r *= 1 - char * 0.7;
        c.g *= 1 - char * 0.7;
        c.b *= 1 - char * 0.6;
        if (wet > 0.4) {
          c.r *= 0.82;
          c.g *= 0.85;
          c.b *= 0.9;
        }
        if (oil > 0.2) {
          c.r *= 0.7;
          c.g *= 0.65;
          c.b *= 0.45;
        }
        attr.setXYZ(i, c.r, c.g, c.b);
      }
    }
    attr.needsUpdate = true;
  }

  private ensureProp(p: Prop) {
    const old = this.propMap.get(p.id);
    const wepKind = p.weapon;
    if (old && old.userData.rev === PROP_REV && old.userData.kind === (wepKind ?? p.kind)) return;
    if (old) {
      this.scene.remove(old);
      this.propMap.delete(p.id);
    }
    const g = new THREE.Group();
    g.userData.rev = PROP_REV;
    if (wepKind) {
      rebuildHeldWeapon(g, wepKind, false, false);
    } else {
      const color = p.color;
      const mesh = new THREE.Mesh(GEO.box, mat(color, { map: p.material === "wood" || p.kind === "stall" ? this.woodTex : null }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.scale.set(p.sx, p.sy, p.sz);
      mesh.position.y = p.sy * 0.5;
      g.add(mesh);
      g.userData.kind = p.kind;
      if (p.kind === "lamp") {
        const flame = new THREE.Mesh(GEO.sphere, new THREE.MeshBasicMaterial({ color: 0xffdd88 }));
        flame.scale.set(0.12, 0.16, 0.12);
        flame.position.y = p.sy + 0.12;
        flame.name = "flame";
        g.add(flame);
      }
      if (p.kind === "chest") {
        mesh.material = mat(0x3d2a14, { metalness: 0.15, roughness: 0.6 });
      }
    }
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = p.yaw;
    this.scene.add(g);
    this.propMap.set(p.id, g);
  }

  private ensureActor(a: Actor) {
    const old = this.actorMap.get(a.id);
    if (old && old.userData.rev === MESH_REV) return;
    if (old) {
      this.scene.remove(old);
      this.actorMap.delete(a.id);
    }
    const g =
      a.species === "human" || a.kind === "player"
        ? this.makeHumanoid(a)
        : this.makeBeast(a);
    g.userData.rev = MESH_REV;
    this.scene.add(g);
    this.actorMap.set(a.id, g);
  }

  private makeHumanoid(a: Actor) {
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
    const pelvis = mk(dark, "pelvis");
    const torso = mk(cloth, "torso");
    const shoulders = mk(cloth, "shoulders");
    const neck = mk(skin, "neck", GEO.cyl);
    const head = new THREE.Mesh(GEO.sphere, skin);
    head.name = "head";
    head.castShadow = true;
    g.add(head);
    const hairCol = new THREE.Color(a.skin).multiplyScalar(0.32);
    const hair = new THREE.Mesh(GEO.sphere, mat(hairCol.getHex()));
    hair.name = "hair";
    hair.scale.set(1.04, 0.7, 1.02);
    hair.position.set(0, 0.14, -0.02);
    hair.castShadow = true;
    head.add(hair);
    const eyeM = mat(0x1a1512);
    for (const sx of [-1, 1]) {
      const e = new THREE.Mesh(GEO.sphere, eyeM);
      e.scale.set(0.14, 0.14, 0.08);
      e.position.set(sx * 0.18, 0.06, -0.42);
      head.add(e);
    }
    const nose = new THREE.Mesh(GEO.box, skin);
    nose.scale.set(0.08, 0.1, 0.14);
    nose.position.set(0, -0.02, -0.46);
    head.add(nose);
    const luarm = mk(skin, "luarm", GEO.cyl);
    const llarm = mk(skin, "llarm", GEO.cyl);
    const ruarm = mk(skin, "ruarm", GEO.cyl);
    const rlarm = mk(skin, "rlarm", GEO.cyl);
    const lhand = mk(skin, "lhand", GEO.sphere);
    const rhand = mk(skin, "rhand", GEO.sphere);
    const lthigh = mk(dark, "lthigh", GEO.cyl);
    const lshin = mk(dark, "lshin", GEO.cyl);
    const rthigh = mk(dark, "rthigh", GEO.cyl);
    const rshin = mk(dark, "rshin", GEO.cyl);
    const lfoot = mk(dark, "lfoot");
    const rfoot = mk(dark, "rfoot");
    const lshcap = mk(cloth, "lshcap", GEO.sphere);
    const rshcap = mk(cloth, "rshcap", GEO.sphere);
    for (const m of [pelvis, torso, neck, head, luarm, llarm, ruarm, rlarm, lthigh, lshin, rthigh, rshin, lhand, rhand]) {
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
      pelvis,
      shoulders,
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
      lthigh,
      lshin,
      rthigh,
      rshin,
      lfoot,
      rfoot,
      lshcap,
      rshcap,
      wep,
    };
    return g;
  }

  private syncPhysique(a: Actor, g: THREE.Group, alpha: number) {
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
    const limp =
      a.loco === "ragdoll" || a.loco === "down" || body.mode === "ragdoll" || body.mode === "getup";
    const chestA = { x: pel.x, y: pel.y + 0.05, z: pel.z };
    const chestB = { x: sp.x, y: sp.y + 0.2, z: sp.z };
    placeBody(parts.pelvis!, { x: pel.x, y: pel.y - 0.1, z: pel.z }, { x: pel.x, y: pel.y + 0.12, z: pel.z }, rgt, 0.38, 0.22);
    placeBody(parts.torso!, chestA, chestB, rgt, 0.46, 0.26);
    if (parts.shoulders) placeBody(parts.shoulders, A[P.uarmL]!, A[P.uarmR]!, fwd, 0.16, 0.18);
    const nb = { x: chestB.x, y: chestB.y - 0.02, z: chestB.z };
    const nt = limp
      ? { x: hd.x, y: hd.y - 0.1, z: hd.z }
      : {
          x: nb.x * 0.72 + hd.x * 0.28,
          y: Math.max(hd.y - 0.13, nb.y + 0.1),
          z: nb.z * 0.72 + hd.z * 0.28,
        };
    if (parts.neck) placeSeg(parts.neck, nb, nt, 0.1);
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
    parts.head!.scale.setScalar(0.22);
    placeArm(parts.luarm!, parts.llarm!, parts.lhand, A[P.uarmL]!, A[P.larmL]!, fwd);
    placeArm(parts.ruarm!, parts.rlarm!, parts.rhand, A[P.uarmR]!, A[P.larmR]!, fwd);
    if (parts.lshcap) {
      parts.lshcap.position.set(A[P.uarmL]!.x, A[P.uarmL]!.y, A[P.uarmL]!.z);
      parts.lshcap.scale.setScalar(0.14);
      parts.lshcap.quaternion.identity();
    }
    if (parts.rshcap) {
      parts.rshcap.position.set(A[P.uarmR]!.x, A[P.uarmR]!.y, A[P.uarmR]!.z);
      parts.rshcap.scale.setScalar(0.14);
      parts.rshcap.quaternion.identity();
    }
    placeLeg(parts.lthigh!, parts.lshin!, parts.lfoot, pel, A[P.thighL]!, A[P.shinL]!, rgt, -1, fwd, a.yaw);
    placeLeg(parts.rthigh!, parts.rshin!, parts.rfoot, pel, A[P.thighR]!, A[P.shinR]!, rgt, 1, fwd, a.yaw);
    let wep = parts.wep;
    if (wep && !(wep as THREE.Group).isGroup) {
      const g = new THREE.Group();
      g.name = "weapon";
      wep.parent?.add(g);
      wep.parent?.remove(wep);
      parts.wep = g;
      wep = g;
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
    if (parts.llarm) (parts.llarm as THREE.Mesh).material = tintInjury(a.skin, injurySum(a.injuries.larm));
    if (parts.rlarm) (parts.rlarm as THREE.Mesh).material = tintInjury(a.skin, injurySum(a.injuries.rarm));
    if (parts.luarm) (parts.luarm as THREE.Mesh).material = tintInjury(a.skin, injurySum(a.injuries.larm) * 0.5);
    if (parts.ruarm) (parts.ruarm as THREE.Mesh).material = tintInjury(a.skin, injurySum(a.injuries.rarm) * 0.5);
    if (parts.lshin) (parts.lshin as THREE.Mesh).material = tintInjury(a.accent, injurySum(a.injuries.lleg));
    if (parts.rshin) (parts.rshin as THREE.Mesh).material = tintInjury(a.accent, injurySum(a.injuries.rleg));
    paintWounds(parts.head, a.injuries.head);
    paintWounds(parts.torso, a.injuries.torso);
    paintWounds(parts.rlarm, a.injuries.rarm);
    paintWounds(parts.llarm, a.injuries.larm);
    paintWounds(parts.rshin, a.injuries.rleg);
    paintWounds(parts.lshin, a.injuries.lleg);
    paintWounds(parts.rhand, a.injuries.rarm);
    paintWounds(parts.lhand, a.injuries.larm);
  }

  private makeBeast(a: Actor) {
    const g = new THREE.Group();
    const fur = mat(a.cloth);
    const body = new THREE.Mesh(GEO.box, fur);
    const s =
      a.species === "bear"
        ? [1.3, 0.9, 2.1]
        : a.species === "cow"
          ? [0.9, 0.85, 1.6]
          : a.species === "wolf"
            ? [0.45, 0.5, 1.1]
            : a.species === "deer"
              ? [0.4, 0.7, 1.15]
              : a.species === "pig"
                ? [0.55, 0.45, 0.95]
                : [0.35, 0.55, 0.7];
    body.scale.set(s[0]!, s[1]!, s[2]!);
    body.position.y = s[1]! * 0.55 + 0.15;
    body.castShadow = true;
    const head = new THREE.Mesh(GEO.box, mat(a.skin));
    head.scale.set(s[0]! * 0.55, s[1]! * 0.55, s[2]! * 0.4);
    head.position.set(0, body.position.y + s[1]! * 0.15, -s[2]! * 0.55);
    head.castShadow = true;
    g.add(body, head);
    if (a.species === "deer") {
      const ant = mat(0x5a4a38);
      for (const sx of [-1, 1]) {
        const h = new THREE.Mesh(GEO.box, ant);
        h.scale.set(0.06, 0.45, 0.06);
        h.position.set(sx * 0.12, head.position.y + 0.35, head.position.z);
        g.add(h);
      }
    }
    g.userData.bodyH = body.position.y;
    return g;
  }

  sync(w: World, cam: Cam, alpha: number, dt: number, title: boolean) {
    this.trauma = this.reduced ? 0 : w.shake;
    this.paintGround(w);
    this.updateSky(w);
    for (const p of w.props) {
      this.ensureProp(p);
      const m = this.propMap.get(p.id)!;
      const x = p.px + (p.x - p.px) * alpha;
      const y = p.py + (p.y - p.py) * alpha;
      const z = p.pz + (p.z - p.pz) * alpha;
      const holder = p.heldBy ? w.actor(p.heldBy) : undefined;
      const wepKind = p.weapon;
      if (holder && wepKind && holder.weaponProp === p.id) {
        const hold = weaponEnds(holder);
        const lit = !!holder.torchLit && wepKind === "torch";
        if (hold) {
          if (m.userData.kind !== wepKind || m.userData.lit !== lit) {
            rebuildHeldWeapon(m, wepKind, lit, holder.kind === "player");
          }
          placeHeldWeapon(m, hold);
          m.visible = true;
          const flame = m.getObjectByName("flame");
          if (flame) {
            const flick = 0.82 + Math.sin(performance.now() * 0.018 + p.id) * 0.2;
            flame.scale.set(flick, flick * 1.15, flick);
            flame.visible = lit;
          }
          continue;
        }
      }
      if (wepKind) {
        if (m.userData.kind !== wepKind) rebuildHeldWeapon(m, wepKind, false, false);
        const len = Math.max(0.34, p.sz);
        const fx = -Math.sin(p.yaw);
        const fz = -Math.cos(p.yaw);
        placeHeldWeapon(m, {
          ax: x,
          ay: Math.max(0.04, y + 0.03),
          az: z,
          bx: x + fx * len,
          by: Math.max(0.04, y + 0.03),
          bz: z + fz * len,
        });
        m.visible = !p.heldBy;
        continue;
      }
      m.position.set(x, y, z);
      m.rotation.y = p.yaw;
      m.rotation.z = p.collapsed ? 0.8 : 0;
      m.visible = true;
      if (p.kind === "lamp") {
        const fl = m.getObjectByName("flame");
        if (fl) fl.visible = !p.collapsed;
      }
    }
    for (const a of w.actors) {
      this.ensureActor(a);
      const g = this.actorMap.get(a.id)!;
      if (a.body && (a.species === "human" || a.kind === "player")) {
        this.syncPhysique(a, g, alpha);
      } else {
        const x = a.px + (a.x - a.px) * alpha;
        const y = a.py + (a.y - a.py) * alpha;
        const z = a.pz + (a.z - a.pz) * alpha;
        const yaw = lerpAng(a.pyaw, a.yaw, alpha);
        g.position.set(x, y, z);
        g.rotation.y = yaw;
        g.rotation.x = a.loco === "ragdoll" || a.loco === "down" ? 1.25 : a.loco === "getup" ? 0.5 : 0;
        g.rotation.z = a.loco === "stumble" ? Math.sin(w.time * 10) * 0.12 : 0;
        if (a.species === "human" || a.kind === "player") this.animHuman(a, g, w);
        else this.animBeast(a, g);
        if (!a.alive) g.rotation.x = 1.4;
      }
      g.visible = true;
    }
    this.updateFire(w);
    this.updateRain(w, dt);
    this.updateCamera(w, cam, alpha, title);
  }

  private animHuman(a: Actor, g: THREE.Group, w: World) {
    const parts = g.userData.parts as {
      head: THREE.Object3D;
      torso: THREE.Object3D;
      larm: THREE.Object3D;
      rarm: THREE.Object3D;
      lleg: THREE.Object3D;
      rleg: THREE.Object3D;
      wep: THREE.Object3D;
    };
    if (!parts) return;
    const spd = Math.hypot(a.vx, a.vz);
    const ph = a.walkPhase;
    const limp = injurySum(a.injuries.lleg) + injurySum(a.injuries.rleg);
    const swing = Math.min(0.9, spd * 0.18);
    parts.lleg.rotation.x = Math.sin(ph) * swing * (1 - injurySum(a.injuries.lleg) * 0.4);
    parts.rleg.rotation.x = Math.sin(ph + Math.PI) * swing * (1 - injurySum(a.injuries.rleg) * 0.4);
    parts.larm.rotation.x = Math.sin(ph + Math.PI) * swing * 0.8;
    parts.rarm.rotation.x = Math.sin(ph) * swing * 0.8;
    if (a.strikeT > 0) {
      parts.rarm.rotation.x = -1.4 + a.strikeT * 4;
      parts.rarm.rotation.y = 0.4;
    } else {
      parts.rarm.rotation.y = 0;
    }
    if (a.kickT > 0) parts.rleg.rotation.x = -1.2;
    parts.torso.rotation.x = a.crouch ? 0.35 : spd > 5 ? 0.18 : 0.04;
    parts.head.rotation.x = a.crouch ? 0.2 : 0;
    const wepLen =
      a.weapon === "spear" || a.weapon === "pitchfork" ? 1.6 : a.weapon === "club" || a.weapon === "board" ? 1.05 : 0.7;
    parts.wep.scale.set(0.05, 0.05, wepLen);
    parts.wep.visible = a.weapon !== "fist";
    (parts.head as THREE.Mesh).material = tintInjury(a.skin, injurySum(a.injuries.head));
    if (a.heat > 0.4) {
      const t = w.time * 18;
      g.position.y += Math.sin(t) * 0.01;
    }
    void limp;
  }

  private animBeast(a: Actor, g: THREE.Group) {
    const spd = Math.hypot(a.vx, a.vz);
    g.position.y += Math.abs(Math.sin(a.walkPhase * 2)) * Math.min(0.08, spd * 0.02);
    g.rotation.z = Math.sin(a.walkPhase) * Math.min(0.1, spd * 0.02);
  }

  private updateFire(w: World) {
    const fires: { x: number; z: number; h: number }[] = [];
    for (let i = 0; i < w.burning.length; i++) {
      if (!w.burning[i]) continue;
      const p = w.ixz(i);
      fires.push({ x: p.x, z: p.z, h: w.heat[i]! });
    }
    fires.sort((a, b) => b.h - a.h);
    for (let i = 0; i < this.fireMeshes.length; i++) {
      const m = this.fireMeshes[i]!;
      const f = fires[i];
      if (!f) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      const flick = 0.8 + Math.sin(w.time * 17 + i) * 0.2;
      m.position.set(f.x, 0.4 * flick + f.h * 0.3, f.z);
      m.scale.set(0.6 * flick, 1.4 * flick * (0.6 + f.h), 0.6 * flick);
      m.rotation.y = w.time * 2 + i;
    }
    for (let i = 0; i < this.smokeMeshes.length; i++) {
      const m = this.smokeMeshes[i]!;
      const f = fires[i];
      if (!f) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      const t = (w.time * 0.4 + i * 0.2) % 1;
      m.position.set(f.x + w.windX * t * 0.8, 1.2 + t * 3.5, f.z + w.windZ * t * 0.8);
      const s = 0.6 + t * 2.2;
      m.scale.set(s, s * 0.7, s);
      (m.material as THREE.MeshBasicMaterial).opacity = 0.28 * (1 - t);
    }
    let li = 0;
    for (const p of w.props) {
      if (p.kind !== "lamp" || p.collapsed || li >= this.lampLights.length) continue;
      const l = this.lampLights[li++]!;
      l.position.set(p.x, p.y + 1.4, p.z);
      l.intensity = 2.4 + Math.sin(w.time * 7 + p.id) * 0.25;
    }
    while (li < this.lampLights.length) {
      this.lampLights[li++]!.intensity = 0;
    }
    const p = w.player();
    if (fires[0]) {
      this.fill.position.set(fires[0].x, 2.2, fires[0].z);
      this.fill.intensity = Math.min(4, fires.length * 0.7);
      this.fill.distance = 16;
    } else if (p.torchLit) {
      this.fill.position.set(p.x, p.y + 1.5, p.z);
      this.fill.intensity = 1.8;
    } else {
      this.fill.intensity = 0.15;
      this.fill.position.set(p.x, 2, p.z);
    }
  }

  private updateRain(w: World, dt: number) {
    if (!this.rain) return;
    const mat = this.rain.material as THREE.PointsMaterial;
    mat.opacity = w.rain * 0.55;
    const pos = this.rain.geometry.getAttribute("position") as THREE.BufferAttribute;
    const p = w.player();
    for (let i = 0; i < pos.count; i++) {
      let y = pos.getY(i) - dt * (14 + w.rain * 8);
      if (y < 0) y = 14;
      pos.setXYZ(i, p.x + ((i * 17) % 50) - 25, y, p.z + ((i * 31) % 50) - 25);
    }
    pos.needsUpdate = true;
    this.rain.position.set(0, 0, 0);
  }

  private updateSky(w: World) {
    const d = w.day;
    const night = d < 0.22 || d > 0.8 ? 1 : d < 0.3 || d > 0.72 ? 0.45 : 0;
    const dusk = d > 0.7 && d < 0.86 ? 1 : d < 0.28 ? 0.5 : 0;
    const sunCol = new THREE.Color().setHSL(0.09 - dusk * 0.03, 0.42 + dusk * 0.15, 0.78 - night * 0.28);
    this.sun.color.copy(sunCol);
    this.sun.intensity = 2.05 - night * 1.15 + dusk * 0.15;
    const ang = (d - 0.25) * Math.PI * 2;
    this.sun.position.set(Math.cos(ang) * 40, Math.max(8, Math.sin(ang) * 28 + 10), 18);
    const fogCol = new THREE.Color().setRGB(0.22 + dusk * 0.08, 0.18 + dusk * 0.04, 0.14 + night * 0.02);
    (this.scene.fog as THREE.FogExp2).color.copy(fogCol);
    (this.scene.fog as THREE.FogExp2).density = 0.01 + w.rain * 0.008 + night * 0.006;
    this.renderer.setClearColor(fogCol, 1);
    this.hemi.intensity = 0.85 - night * 0.3;
    this.waterMat.opacity = 0.65 + w.rain * 0.1;
  }

  private updateCamera(w: World, cam: Cam, alpha: number, title: boolean) {
    const p = w.player();
    const x = p.px + (p.x - p.px) * alpha;
    const y = p.py + (p.y - p.py) * alpha;
    const z = p.pz + (p.z - p.pz) * alpha;
    const f = facing(cam.yaw);
    const dist = title ? 18 : 3.7;
    const height = title ? 8 : 1.48;
    const target = this.tmp.set(x, y + (title ? 1.2 : 1.18), z);
    if (title) {
      const t = w.time * 0.07;
      this.camPos.set(Math.sin(t) * 11 + 2, 5.2, Math.cos(t) * 11 + 1);
      this.look.set(0, 1.0, 0);
    } else {
      const desired = this.tmp2.set(x - f.x * dist, y + height, z - f.z * dist);
      desired.y += Math.sin(cam.pitch) * 2.4;
      if (this.camPos.distanceTo(desired) > 7) {
        this.camPos.copy(desired);
        this.look.copy(target);
      } else {
        const k = 1 - Math.exp(-12 * 0.016);
        this.camPos.lerp(desired, k);
        this.look.lerp(target, k);
      }
    }
    if (this.trauma > 0.01 && !this.reduced) {
      const s = this.trauma * this.trauma;
      this.camera.position.set(
        this.camPos.x + (Math.random() - 0.5) * s * 0.35,
        this.camPos.y + (Math.random() - 0.5) * s * 0.25,
        this.camPos.z + (Math.random() - 0.5) * s * 0.35,
      );
    } else {
      this.camera.position.copy(this.camPos);
    }
    this.camera.lookAt(this.look);
    this.sun.target.position.set(x, 0, z);
    if (!this.sun.target.parent) this.scene.add(this.sun.target);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

function placeSeg(
  mesh: THREE.Object3D,
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  thick: number,
) {
  placeBody(mesh, a, b, { x: 1, z: 0 }, thick, thick);
}

function placeArm(
  upper: THREE.Object3D,
  lower: THREE.Object3D,
  hand: THREE.Object3D | undefined,
  shoulder: { x: number; y: number; z: number },
  wrist: { x: number; y: number; z: number },
  fwd: { x: number; z: number },
) {
  const elbow = {
    x: shoulder.x * 0.52 + wrist.x * 0.48 - fwd.x * 0.055,
    y: shoulder.y * 0.52 + wrist.y * 0.48 + 0.02,
    z: shoulder.z * 0.52 + wrist.z * 0.48 - fwd.z * 0.055,
  };
  placeSeg(upper, shoulder, elbow, 0.13);
  placeSeg(lower, elbow, wrist, 0.105);
  if (hand) {
    hand.position.set(wrist.x, wrist.y, wrist.z);
    hand.scale.setScalar(0.085);
    hand.quaternion.identity();
  }
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
) {
  const hipP = {
    x: hip.x + right.x * side * 0.11,
    y: hip.y - 0.02,
    z: hip.z + right.z * side * 0.11,
  };
  placeSeg(thigh, hipP, knee, 0.16);
  placeSeg(shin, knee, ankle, 0.13);
  if (foot) placeFoot(foot, ankle, fwd, yaw);
}

const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _basis = new THREE.Matrix4();

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
  mesh.position.set(shin.x + fwd.x * 0.07, Math.max(0.035, shin.y - 0.03), shin.z + fwd.z * 0.07);
  mesh.scale.set(0.1, 0.07, 0.2);
  mesh.rotation.set(0, yaw + Math.PI, 0);
}

function placeHeldWeapon(
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

function addWepMesh(g: THREE.Object3D, geo: THREE.BufferGeometry, material: THREE.Material, y: number, sx: number, sy: number, sz: number, name?: string) {
  const m = new THREE.Mesh(geo, material);
  m.position.y = y;
  m.scale.set(sx, sy, sz);
  m.castShadow = true;
  if (name) m.name = name;
  g.add(m);
  return m;
}

function rebuildHeldWeapon(g: THREE.Object3D, kind: WeaponKind, lit: boolean, isPlayer: boolean) {
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
    m.opacity = clamp01(amt * 0.7);
    m.color.setRGB(0.42 + amt * 0.1, 0.12, 0.1);
  }
  if (cut) cut.visible = inj.cut + inj.puncture > 0.08;
  if (burn) {
    burn.visible = inj.burn > 0.1;
    const m = burn.material as THREE.MeshStandardMaterial;
    m.emissiveIntensity = 0.12 + Math.min(0.5, inj.burn);
  }
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function tintInjury(base: number, amount: number) {
  const key = base + ":" + (amount * 8 | 0);
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
