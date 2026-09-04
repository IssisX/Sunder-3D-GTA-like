import * as THREE from "three";
import type { Actor, Prop, Region } from "./types";
import { FIRE_RES, HALF, WORLD, injurySum } from "./types";
import { World, facing } from "./world";
import type { Cam } from "./sim";

/**
 * A rendered bone: a box spanning two body nodes.
 *
 * The renderer reads node positions and never writes them. Every pose the
 * player sees -- gait, stumble, ragdoll, drape, get-up -- is solved state, not
 * an animation chosen here. That separation is the reason a limp looks like a
 * limp: nothing in this file knows what a limp is.
 */
interface LimbSpec {
  a: number;
  b: number;
  /** Cross-section width (local x) and depth (local z), m at unit scale. */
  w: number;
  d: number;
  region: Region;
  /** Pushes the near end sideways so shoulders and hips read as joints. */
  offX?: number;
  offY?: number;
}

interface Limb extends LimbSpec {
  mesh: THREE.Mesh;
}

const HUMAN_LIMBS: LimbSpec[] = [
  { a: 1, b: 2, w: 0.42, d: 0.25, region: "torso" },
  { a: 0, b: 1, w: 0.2, d: 0.19, region: "torso" },
  { a: 1, b: 3, w: 0.14, d: 0.14, region: "larm", offX: -0.16, offY: 0.12 },
  { a: 3, b: 4, w: 0.11, d: 0.11, region: "larm" },
  { a: 1, b: 5, w: 0.14, d: 0.14, region: "rarm", offX: 0.16, offY: 0.12 },
  { a: 5, b: 6, w: 0.11, d: 0.11, region: "rarm" },
  { a: 2, b: 7, w: 0.18, d: 0.18, region: "lleg", offX: -0.05 },
  { a: 7, b: 8, w: 0.14, d: 0.14, region: "lleg" },
  { a: 2, b: 9, w: 0.18, d: 0.18, region: "rleg", offX: 0.05 },
  { a: 9, b: 10, w: 0.14, d: 0.14, region: "rleg" },
];

const BEAST_LIMBS: LimbSpec[] = [
  { a: 1, b: 2, w: 0.62, d: 0.62, region: "torso" },
  { a: 0, b: 1, w: 0.3, d: 0.3, region: "head" },
  { a: 2, b: 7, w: 0.2, d: 0.2, region: "torso" },
  { a: 1, b: 3, w: 0.16, d: 0.16, region: "larm" },
  { a: 1, b: 4, w: 0.16, d: 0.16, region: "rarm" },
  { a: 2, b: 5, w: 0.17, d: 0.17, region: "lleg" },
  { a: 2, b: 6, w: 0.17, d: 0.17, region: "rleg" },
];

const UP = new THREE.Vector3(0, 1, 0);

const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 10, 8),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
  cone: new THREE.ConeGeometry(0.5, 1, 8),
  plane: new THREE.PlaneGeometry(1, 1),
};

function mat(
  color: number,
  extra: ConstructorParameters<typeof THREE.MeshStandardMaterial>[0] = {},
) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.86,
    metalness: 0.04,
    ...extra,
  });
}

function noiseCanvas(
  size: number,
  fn: (x: number, y: number, i: number) => [number, number, number],
) {
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
  camera = new THREE.PerspectiveCamera(62, 1, 0.08, 220);
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
  private dir = new THREE.Vector3();
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
    this.waterMat = mat(0x2a3a40, {
      roughness: 0.18,
      metalness: 0.2,
      transparent: true,
      opacity: 0.72,
    });

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
      if (
        m.geometry &&
        m.geometry !== GEO.box &&
        m.geometry !== GEO.sphere &&
        m.geometry !== GEO.cyl &&
        m.geometry !== GEO.cone &&
        m.geometry !== GEO.plane
      ) {
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
    if (this.propMap.has(p.id)) return;
    const color = p.color;
    const mesh = new THREE.Mesh(
      GEO.box,
      mat(color, { map: p.material === "wood" || p.kind === "stall" ? this.woodTex : null }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.scale.set(p.sx, p.sy, p.sz);
    const g = new THREE.Group();
    mesh.position.y = p.sy * 0.5;
    g.add(mesh);
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
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = p.yaw;
    this.scene.add(g);
    this.propMap.set(p.id, g);
  }

  private ensureActor(a: Actor) {
    if (this.actorMap.has(a.id)) return;
    const g = this.makeRig(a, a.species === "human" ? HUMAN_LIMBS : BEAST_LIMBS);
    this.scene.add(g);
    this.actorMap.set(a.id, g);
  }

  /** Builds one box per bone. Nothing here is posed; `poseFromBody` does that. */
  private makeRig(a: Actor, specs: LimbSpec[]) {
    const g = new THREE.Group();
    const limbs: Limb[] = [];
    const skinRegions: Record<string, boolean> = { head: true, larm: true, rarm: true };
    for (const sp of specs) {
      const base =
        a.species === "human"
          ? skinRegions[sp.region]
            ? a.skin
            : a.cloth
          : sp.region === "head"
            ? a.skin
            : a.cloth;
      const m = new THREE.Mesh(GEO.box, mat(base));
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      limbs.push({ ...sp, mesh: m });
    }
    const head = new THREE.Mesh(GEO.box, mat(a.skin));
    head.name = "head";
    head.castShadow = true;
    g.add(head);
    if (a.helmet) {
      const h = new THREE.Mesh(GEO.sphere, mat(0x4a4c50, { metalness: 0.5, roughness: 0.4 }));
      h.name = "helmet";
      g.add(h);
    }
    if (a.species === "deer") {
      for (const sx of [-1, 1]) {
        const h = new THREE.Mesh(GEO.box, mat(0x5a4a38));
        h.name = "antler" + sx;
        g.add(h);
      }
    }
    if (a.species === "human") {
      const wep = new THREE.Mesh(GEO.box, mat(0x6a5a48));
      wep.name = "weapon";
      wep.castShadow = true;
      g.add(wep);
    }
    g.userData.limbs = limbs;
    g.userData.base = { skin: a.skin, cloth: a.cloth };
    return g;
  }

  /**
   * Positions every mesh from the solved node positions, interpolated between
   * the tick boundaries. This is the whole of character animation now: there is
   * no pose logic left in the renderer to disagree with the simulation.
   */
  private poseFromBody(w: World, a: Actor, g: THREE.Group, alpha: number) {
    const B = w.bodies;
    const slot = a.body;
    const b = B.base(slot);
    const limbs = g.userData.limbs as Limb[] | undefined;
    if (!limbs) return;
    const base = g.userData.base as { skin: number; cloth: number };
    const skinRegions: Record<string, boolean> = { head: true, larm: true, rarm: true };
    const scale = B.scale[slot]!;
    const cy = Math.cos(a.yaw);
    const sy = Math.sin(a.yaw);
    for (const L of limbs) {
      const ka = b + L.a;
      const kb = b + L.b;
      const ox = (L.offX ?? 0) * scale;
      const oy = (L.offY ?? 0) * scale;
      const ax = B.rx[ka]! + (B.px[ka]! - B.rx[ka]!) * alpha + ox * cy;
      const ay = B.ry[ka]! + (B.py[ka]! - B.ry[ka]!) * alpha + oy;
      const az = B.rz[ka]! + (B.pz[ka]! - B.rz[ka]!) * alpha - ox * sy;
      const bx = B.rx[kb]! + (B.px[kb]! - B.rx[kb]!) * alpha;
      const by = B.ry[kb]! + (B.py[kb]! - B.ry[kb]!) * alpha;
      const bz = B.rz[kb]! + (B.pz[kb]! - B.rz[kb]!) * alpha;
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      L.mesh.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
      if (len > 1e-4) {
        this.dir.set(dx / len, dy / len, dz / len);
        L.mesh.quaternion.setFromUnitVectors(UP, this.dir);
      }
      L.mesh.scale.set(L.w * scale, Math.max(0.02, len), L.d * scale);
      // Damage tints the limb that took it, so the injury model is legible
      // on the body itself rather than only on the HUD silhouette.
      const hurt = injurySum(a.injuries[L.region]);
      if (hurt > 0.06) {
        L.mesh.material = tintInjury(
          skinRegions[L.region] ? base.skin : base.cloth,
          Math.min(1.4, hurt),
        );
      }
    }
    const plan = B.plan(slot);
    const kh = b + plan.head;
    const hx = B.rx[kh]! + (B.px[kh]! - B.rx[kh]!) * alpha;
    const hy = B.ry[kh]! + (B.py[kh]! - B.ry[kh]!) * alpha;
    const hz = B.rz[kh]! + (B.pz[kh]! - B.rz[kh]!) * alpha;
    const head = g.getObjectByName("head") as THREE.Mesh | undefined;
    const hr = B.rad[kh]! * 2;
    if (head) {
      head.position.set(hx, hy, hz);
      head.scale.set(hr * 0.92, hr, hr * 0.88);
      head.quaternion.copy((limbs[1] ?? limbs[0])!.mesh.quaternion);
      head.material = tintInjury(base.skin, Math.min(1.4, injurySum(a.injuries.head)));
    }
    const helm = g.getObjectByName("helmet");
    if (helm) {
      helm.position.set(hx, hy + hr * 0.22, hz);
      helm.scale.set(hr * 1.06, hr * 0.74, hr * 1.0);
    }
    for (const sx of [-1, 1]) {
      const ant = g.getObjectByName("antler" + sx);
      if (!ant) continue;
      ant.position.set(hx + sx * 0.12 * scale, hy + 0.34 * scale, hz);
      ant.scale.set(0.06 * scale, 0.45 * scale, 0.06 * scale);
    }
    const wep = g.getObjectByName("weapon") as THREE.Mesh | undefined;
    if (wep) {
      wep.visible = a.weapon !== "fist";
      if (wep.visible) {
        const kHand = b + plan.grabHand;
        const kElbow = b + (plan.grabHand === 6 ? 5 : plan.chest);
        const wx = B.rx[kHand]! + (B.px[kHand]! - B.rx[kHand]!) * alpha;
        const wy = B.ry[kHand]! + (B.py[kHand]! - B.ry[kHand]!) * alpha;
        const wz = B.rz[kHand]! + (B.pz[kHand]! - B.rz[kHand]!) * alpha;
        let ex = wx - B.px[kElbow]!;
        let ey = wy - B.py[kElbow]!;
        let ez = wz - B.pz[kElbow]!;
        const em = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (em > 1e-4) {
          ex /= em;
          ey /= em;
          ez /= em;
        } else {
          ex = 0;
          ey = -1;
          ez = 0;
        }
        const wlen =
          a.weapon === "spear" || a.weapon === "pitchfork"
            ? 1.7
            : a.weapon === "club" || a.weapon === "board"
              ? 1.05
              : 0.62;
        wep.position.set(wx + ex * wlen * 0.42, wy + ey * wlen * 0.42, wz + ez * wlen * 0.42);
        this.dir.set(ex, ey, ez);
        wep.quaternion.setFromUnitVectors(UP, this.dir);
        wep.scale.set(0.06, wlen, 0.06);
      }
    }
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
      m.position.set(x, y, z);
      m.rotation.y = p.yaw;
      m.rotation.z = p.collapsed ? 0.8 : 0;
      m.visible = !p.heldBy;
      if (p.kind === "lamp") {
        const fl = m.getObjectByName("flame");
        if (fl) fl.visible = !p.collapsed;
      }
    }
    for (const a of w.actors) {
      this.ensureActor(a);
      const g = this.actorMap.get(a.id)!;
      // Node positions are world-space, so the group carries no transform of
      // its own. There is deliberately no `rotation.x = 1.25` fallback here: a
      // body lying down is lying down because the solver put it there.
      g.position.set(0, 0, 0);
      g.quaternion.identity();
      g.visible = true;
      if (a.body >= 0) this.poseFromBody(w, a, g, alpha);
    }
    this.updateFire(w);
    this.updateRain(w, dt);
    this.updateCamera(w, cam, alpha, title);
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
    const sunCol = new THREE.Color().setHSL(
      0.09 - dusk * 0.03,
      0.42 + dusk * 0.15,
      0.78 - night * 0.28,
    );
    this.sun.color.copy(sunCol);
    this.sun.intensity = 2.05 - night * 1.15 + dusk * 0.15;
    const ang = (d - 0.25) * Math.PI * 2;
    this.sun.position.set(Math.cos(ang) * 40, Math.max(8, Math.sin(ang) * 28 + 10), 18);
    const fogCol = new THREE.Color().setRGB(
      0.22 + dusk * 0.08,
      0.18 + dusk * 0.04,
      0.14 + night * 0.02,
    );
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
    const dist = title ? 18 : 5.4;
    const height = title ? 8 : 1.72;
    const target = this.tmp.set(x, y + (title ? 1.2 : 1.35), z);
    if (title) {
      const t = w.time * 0.07;
      this.camPos.set(Math.sin(t) * 11 + 2, 5.2, Math.cos(t) * 11 + 1);
      this.look.set(0, 1.0, 0);
    } else {
      const desired = this.tmp2.set(x - f.x * dist, y + height, z - f.z * dist);
      desired.y += Math.sin(cam.pitch) * 3.2;
      const k = 1 - Math.exp(-10 * 0.016);
      this.camPos.lerp(desired, k);
      this.look.lerp(target, k);
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

const injuryMats = new Map<string, THREE.MeshStandardMaterial>();
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
