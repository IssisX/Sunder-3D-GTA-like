import type { Actor, Faction, WeaponKind } from "./types";
import { World, makeHumanStats } from "./world";

const NAMES_M = ["Hark", "Rowan", "Bram", "Edd", "Cole", "Pim", "Tor", "Wile", "Nash", "Orrin"];
const NAMES_F = ["Maer", "Linn", "Sera", "Wren", "Nell", "Kett", "Asha", "Brid", "Ola", "Tamsin"];

function name(w: World, sex: number) {
  const list = sex < 0.5 ? NAMES_M : NAMES_F;
  return list[(w.rng() * list.length) | 0]!;
}

function skinOf(w: World) {
  const tones = [0xc4a07a, 0xb08968, 0x8d6e54, 0x6f5340, 0xd4b496, 0x9a704e];
  return tones[(w.rng() * tones.length) | 0]!;
}

export function buildLevel(w: World) {
  seedGround(w);
  addRiver(w);
  addPalisade(w);
  addMarket(w);
  addTavern(w);
  addWarehouse(w);
  addHomes(w);
  addBarracks(w);
  addLivestock(w);
  addForest(w);
  addBridge(w);
  addPeople(w);
  addBeasts(w);
  addPlayer(w);
  markIndoor(w);
}

function seedGround(w: World) {
  for (let iz = 0; iz < 44; iz++) {
    for (let ix = 0; ix < 44; ix++) {
      const i = ix + iz * 44;
      const x = ix * 2 - 44;
      const z = iz * 2 - 44;
      w.fuel[i] = 0.15;
      w.wet[i] = 0.2;
      if (z < -14) w.fuel[i] = 0.55;
      if (Math.abs(x) < 10 && Math.abs(z) < 10) w.fuel[i] = 0.12;
      if (x > 12 && z < -4 && z > -16) w.fuel[i] = 0.7;
      w.wet[i] = z > 16 ? 0.7 : 0.18 + w.rng() * 0.1;
    }
  }
}

function addRiver(w: World) {
  w.addCollider({
    minX: -44,
    maxX: 44,
    minY: -1.4,
    maxY: 0.05,
    minZ: 17.5,
    maxZ: 24.5,
    material: "water",
    climb: false,
    vault: false,
    propId: 0,
    solid: false,
    water: true,
  });
}

function addPalisade(w: World) {
  for (let x = -22; x <= 22; x += 1.4) {
    if (Math.abs(x) < 2.6) continue;
    const p = w.addProp({
      kind: "fence",
      material: "wood",
      x,
      y: 0,
      z: -12,
      sx: 0.28,
      sy: 2.1,
      sz: 1.3,
      mass: 40,
      hp: 55,
      color: 0x3a2e22,
      flammable: true,
      fuel: 6,
    });
    w.addBox(x, 0, -12, 0.28, 2.1, 1.3, { propId: p.id, vault: false, climb: true });
  }
  for (const gx of [-2.8, 2.8]) {
    const post = w.addProp({
      kind: "post",
      material: "wood",
      x: gx,
      y: 0,
      z: -12,
      sx: 0.4,
      sy: 2.8,
      sz: 0.4,
      mass: 55,
      hp: 80,
      color: 0x2e241c,
      flammable: true,
      fuel: 6,
      support: true,
    });
    w.addBox(gx, 0, -12, 0.4, 2.8, 0.4, { propId: post.id, climb: true });
  }
}

function addBuilding(
  w: World,
  name: string,
  x: number,
  z: number,
  sx: number,
  sz: number,
  color: number,
  wallHp = 70,
) {
  const b = {
    id: w.nextId++,
    name,
    parts: [] as number[],
    supports: [] as number[],
    collapsed: false,
    minX: x - sx * 0.5,
    maxX: x + sx * 0.5,
    minY: 0,
    maxY: 3.4,
    minZ: z - sz * 0.5,
    maxZ: z + sz * 0.5,
    indoor: true,
  };
  w.buildings.push(b);
  const posts = [
    [x - sx * 0.45, z - sz * 0.45],
    [x + sx * 0.45, z - sz * 0.45],
    [x - sx * 0.45, z + sz * 0.45],
    [x + sx * 0.45, z + sz * 0.45],
  ];
  for (const [px, pz] of posts) {
    const p = w.addProp({
      kind: "post",
      material: "wood",
      x: px,
      y: 0,
      z: pz,
      sx: 0.28,
      sy: 3.1,
      sz: 0.28,
      mass: 50,
      hp: wallHp,
      support: true,
      buildingId: b.id,
      color: 0x4a3a2a,
      flammable: true,
      fuel: 7,
      capacity: 90,
    });
    b.supports.push(p.id);
    b.parts.push(p.id);
    w.addBox(px, 0, pz, 0.28, 3.1, 0.28, { propId: p.id, climb: true });
  }
  const walls: [number, number, number, number][] = [
    [x, z - sz * 0.5, sx, 0.22],
    [x, z + sz * 0.5, sx, 0.22],
    [x - sx * 0.5, z, 0.22, sz],
    [x + sx * 0.5, z, 0.22, sz],
  ];
  walls.forEach((wl, i) => {
    const door = i === 1;
    const ww = door ? wl[2] * 0.38 : wl[2];
    const ox = door ? x - sx * 0.28 : wl[0];
    const p = w.addProp({
      kind: "wall",
      material: "wood",
      x: ox,
      y: 0,
      z: wl[1],
      sx: ww,
      sy: 2.6,
      sz: wl[3],
      mass: 80,
      hp: wallHp,
      buildingId: b.id,
      color,
      flammable: true,
      fuel: 10,
    });
    b.parts.push(p.id);
    w.addBox(ox, 0, wl[1], ww, 2.6, wl[3], { propId: p.id, climb: true });
    if (door) {
      const p2 = w.addProp({
        kind: "wall",
        material: "wood",
        x: x + sx * 0.28,
        y: 0,
        z: wl[1],
        sx: ww,
        sy: 2.6,
        sz: wl[3],
        mass: 80,
        hp: wallHp,
        buildingId: b.id,
        color,
        flammable: true,
        fuel: 10,
      });
      b.parts.push(p2.id);
      w.addBox(x + sx * 0.28, 0, wl[1], ww, 2.6, wl[3], { propId: p2.id, climb: true });
    }
  });
  const roof = w.addProp({
    kind: "roof",
    material: "wood",
    x,
    y: 2.55,
    z,
    sx: sx + 0.5,
    sy: 0.28,
    sz: sz + 0.5,
    mass: 120,
    hp: 50,
    buildingId: b.id,
    color: 0x3b332c,
    flammable: true,
    fuel: 12,
  });
  b.parts.push(roof.id);
  w.addBox(x, 2.55, z, sx + 0.5, 0.28, sz + 0.5, { propId: roof.id, material: "wood" });
  return b;
}

function addMarket(w: World) {
  const stalls: [number, number, number][] = [
    [-5.5, -3.2, 0.2],
    [-2.2, -4.4, 0.6],
    [2.4, -4.2, 1.1],
    [5.4, -2.8, 1.8],
    [-5.8, 2.4, -0.4],
    [5.6, 2.8, 3.2],
    [-2.4, 4.6, 0],
  ];
  for (const [x, z, yaw] of stalls) {
    const stall = w.addProp({
      kind: "stall",
      material: "wood",
      x,
      y: 0,
      z,
      yaw,
      sx: 2.4,
      sy: 1.15,
      sz: 1.15,
      mass: 35,
      hp: 28,
      color: 0x6a5138,
      flammable: true,
      fuel: 9,
      anchored: true,
    });
    w.addBox(x, 0, z, 2.4, 1.15, 1.15, { propId: stall.id, vault: true, climb: false });
    w.addProp({
      kind: "lamp",
      material: "glass",
      x: x + 0.7,
      y: 1.25,
      z,
      sx: 0.18,
      sy: 0.32,
      sz: 0.18,
      mass: 1.2,
      hp: 8,
      color: 0xd8b46a,
      flammable: true,
      oil: true,
      fuel: 4,
      anchored: false,
      dynamic: false,
    });
    if (w.rng() > 0.4) {
      w.addProp({
        kind: "crate",
        material: "wood",
        x: x - 0.7,
        y: 0,
        z: z + 0.8,
        sx: 0.55,
        sy: 0.5,
        sz: 0.55,
        mass: 12,
        hp: 18,
        color: 0x5b4634,
        flammable: true,
        fuel: 4,
        anchored: false,
      });
    }
    if (w.rng() > 0.55) {
      w.addProp({
        kind: "flask",
        material: "glass",
        x: x + 0.2,
        y: 1.2,
        z: z + 0.2,
        sx: 0.16,
        sy: 0.28,
        sz: 0.16,
        mass: 1.4,
        hp: 6,
        oil: true,
        flammable: true,
        fuel: 5,
        color: 0x6a5a2a,
        anchored: false,
      });
    }
  }
  w.addProp({
    kind: "hay",
    material: "hay",
    x: 7.4,
    y: 0,
    z: 0.5,
    sx: 1.4,
    sy: 0.9,
    sz: 1.1,
    mass: 18,
    hp: 16,
    color: 0xc2a45a,
    flammable: true,
    fuel: 16,
    anchored: false,
  });
  w.addProp({
    kind: "hay",
    material: "hay",
    x: 8.2,
    y: 0,
    z: 1.6,
    sx: 1.2,
    sy: 0.7,
    sz: 0.9,
    mass: 14,
    hp: 14,
    color: 0xb89648,
    flammable: true,
    fuel: 14,
    anchored: false,
  });
  w.addProp({
    kind: "chest",
    material: "wood",
    x: 0.2,
    y: 0,
    z: 0.4,
    sx: 0.7,
    sy: 0.5,
    sz: 0.45,
    mass: 38,
    hp: 60,
    color: 0x3d2a14,
    flammable: true,
    fuel: 4,
    anchored: false,
  });
  w.addProp({
    kind: "barrel",
    material: "wood",
    x: -7.2,
    y: 0,
    z: 0.2,
    sx: 0.55,
    sy: 0.8,
    sz: 0.55,
    mass: 22,
    hp: 24,
    color: 0x4a3828,
    oil: true,
    flammable: true,
    fuel: 8,
    anchored: false,
  });
  w.addProp({
    kind: "weapon",
    material: "wood",
    x: -1.4,
    y: 0.1,
    z: -6.5,
    sx: 0.12,
    sy: 0.12,
    sz: 1.1,
    mass: 2.2,
    hp: 20,
    weapon: "club",
    color: 0x5a4430,
    flammable: true,
    fuel: 2,
    anchored: false,
  });
}

function addTavern(w: World) {
  addBuilding(w, "The Hearth", -13.5, 6.5, 8.2, 6.4, 0x4a382c, 80);
  w.addProp({
    kind: "table",
    material: "wood",
    x: -13.5,
    y: 0,
    z: 6.2,
    sx: 1.8,
    sy: 0.75,
    sz: 0.8,
    mass: 24,
    hp: 22,
    color: 0x5a4434,
    flammable: true,
    fuel: 6,
    anchored: false,
  });
  w.addProp({
    kind: "lamp",
    material: "glass",
    x: -13.5,
    y: 0.85,
    z: 6.2,
    sx: 0.16,
    sy: 0.28,
    sz: 0.16,
    mass: 1,
    hp: 7,
    oil: true,
    color: 0xe0c070,
    flammable: true,
    fuel: 3,
    anchored: false,
  });
  w.addProp({
    kind: "weapon",
    material: "metal",
    x: -16.5,
    y: 0.1,
    z: 4.2,
    sx: 0.08,
    sy: 0.08,
    sz: 0.7,
    mass: 0.6,
    hp: 30,
    weapon: "knife",
    color: 0x888480,
    flammable: false,
    fuel: 0,
    anchored: false,
  });
}

function addWarehouse(w: World) {
  addBuilding(w, "the warehouse", 14.5, 3.5, 8.5, 6.8, 0x3e342c, 65);
  for (let i = 0; i < 5; i++) {
    w.addProp({
      kind: "hay",
      material: "hay",
      x: 12.4 + (i % 3) * 1.5,
      y: 0,
      z: 2.2 + ((i / 3) | 0) * 1.6,
      sx: 1.3,
      sy: 0.95,
      sz: 1.1,
      mass: 16,
      hp: 14,
      color: 0xc4a85c,
      flammable: true,
      fuel: 18,
      anchored: false,
    });
  }
  w.addProp({
    kind: "barrel",
    material: "wood",
    x: 16.8,
    y: 0,
    z: 5.4,
    sx: 0.6,
    sy: 0.85,
    sz: 0.6,
    mass: 28,
    hp: 26,
    oil: true,
    color: 0x4a3828,
    flammable: true,
    fuel: 10,
    anchored: false,
  });
}

function addHomes(w: World) {
  const spots: [number, number, string][] = [
    [-18, -4, "a cottage"],
    [-18.5, 1.2, "a cottage"],
    [-10.5, -5.5, "a shack"],
    [10.5, 9.2, "a cottage"],
  ];
  for (const [x, z, n] of spots) addBuilding(w, n, x, z, 5.4, 5.0, 0x534636, 60);
}

function addBarracks(w: World) {
  addBuilding(w, "the barracks", 9.5, -8.2, 7.2, 5.2, 0x3a3530, 90);
  w.addProp({
    kind: "weapon",
    material: "wood",
    x: 7.2,
    y: 0.1,
    z: -8.4,
    sx: 0.1,
    sy: 0.1,
    sz: 1.8,
    mass: 2.1,
    hp: 28,
    weapon: "spear",
    color: 0x6a6048,
    flammable: true,
    fuel: 2,
    anchored: false,
  });
}

function addLivestock(w: World) {
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const x = 18 + Math.cos(ang) * 4.2;
    const z = -7 + Math.sin(ang) * 3.4;
    if (i === 0) continue;
    const p = w.addProp({
      kind: "fence",
      material: "wood",
      x,
      y: 0,
      z,
      sx: 0.18,
      sy: 1.15,
      sz: 1.5,
      mass: 18,
      hp: 22,
      color: 0x4a3c2c,
      flammable: true,
      fuel: 3,
    });
    w.addBox(x, 0, z, 0.18, 1.15, 1.5, { propId: p.id, vault: true });
  }
}

function addForest(w: World) {
  const trees: [number, number][] = [];
  for (let i = 0; i < 70; i++) {
    const x = (w.rng() - 0.5) * 80;
    const z = -16 - w.rng() * 24;
    if (Math.abs(x) < 3.6 && z > -28 && z < -10) continue;

    let ok = true;
    for (const t of trees) {
      if ((t[0] - x) ** 2 + (t[1] - z) ** 2 < 9) ok = false;
    }
    if (!ok) continue;
    trees.push([x, z]);
    w.addBox(x, 0, z, 0.7, 6, 0.7, { material: "vegetation", climb: true, vault: false });
    w.fuel[w.cell(x, z)] = 0.85;
  }
  w.addProp({
    kind: "weapon",
    material: "wood",
    x: 1.6,
    y: 0.1,
    z: -22.5,
    sx: 0.12,
    sy: 0.12,
    sz: 0.9,
    mass: 1.1,
    hp: 12,
    weapon: "torch",
    color: 0x6a4a28,
    flammable: true,
    fuel: 4,
    anchored: false,
  });
  w.addProp({
    kind: "crate",
    material: "wood",
    x: 2.2,
    y: 0,
    z: -21.4,
    sx: 0.6,
    sy: 0.45,
    sz: 0.6,
    mass: 10,
    hp: 16,
    color: 0x5a4634,
    flammable: true,
    fuel: 4,
    anchored: false,
  });
}

function addBridge(w: World) {
  const deck = w.addProp({
    kind: "beam",
    material: "wood",
    x: 0,
    y: 0.15,
    z: 20.6,
    sx: 3.4,
    sy: 0.28,
    sz: 7.2,
    mass: 160,
    hp: 90,
    support: true,
    color: 0x4a3c30,
    flammable: true,
    fuel: 10,
  });
  w.addBox(0, 0.15, 20.6, 3.4, 0.28, 7.2, { propId: deck.id, material: "wood" });
  const supports: number[] = [deck.id];
  const parts: number[] = [deck.id];
  for (const x of [-1.5, 1.5]) {
    for (const z of [18.2, 23]) {
      const p = w.addProp({
        kind: "post",
        material: "wood",
        x,
        y: -0.8,
        z,
        sx: 0.3,
        sy: 1.4,
        sz: 0.3,
        mass: 40,
        hp: 55,
        support: true,
        color: 0x3a3028,
        flammable: true,
        fuel: 5,
      });
      w.addBox(x, -0.8, z, 0.3, 1.4, 0.3, { propId: p.id });
      supports.push(p.id);
      parts.push(p.id);
    }
  }
  w.buildings.push({
    id: w.nextId++,
    name: "the bridge",
    parts,
    supports,
    collapsed: false,
    minX: -2,
    maxX: 2,
    minY: -1,
    maxY: 1,
    minZ: 17.5,
    maxZ: 24.2,
    indoor: false,
  });
}

function human(
  w: World,
  faction: Faction,
  x: number,
  z: number,
  extra: Partial<Actor> = {},
): Actor {
  const sex = w.rng();
  const stats = makeHumanStats(w, faction);
  const cloth =
    faction === "guard"
      ? 0x2a3036
      : faction === "hunter"
        ? 0x3a3428
        : [0x5a4638, 0x4a3a32, 0x6a5850, 0x3e3430, 0x705848][(w.rng() * 5) | 0]!;
  const weapon: WeaponKind =
    faction === "guard"
      ? w.rng() > 0.5
        ? "spear"
        : "club"
      : faction === "hunter"
        ? "knife"
        : "fist";
  return w.addActor({
    kind: "human",
    species: "human",
    faction,
    name: name(w, sex),
    x,
    y: 0,
    z,
    yaw: w.rng() * Math.PI * 2,
    ...stats,
    height: 1.58 + w.rng() * 0.22,
    radius: 0.3,
    skin: skinOf(w),
    cloth,
    accent: faction === "guard" ? 0x6a5840 : 0x2a221c,
    helmet: faction === "guard" && w.rng() > 0.4,
    sex,
    weapon,
    courage: stats.courage,
    homeX: x,
    homeZ: z,
    ...extra,
  });
}

function addPeople(w: World) {
  const marketPts = [
    [-4, -1],
    [-1, -3],
    [3, -2],
    [4, 1],
    [-3, 3],
    [1, 3.5],
    [-6, 1],
    [6, -1],
  ];
  marketPts.forEach((p, i) => {
    const a = human(w, "civilian", p[0]!, p[1]!);
    a.routine = marketPts.map(([x, z]) => ({ x: x + (w.rng() - 0.5), z: z + (w.rng() - 0.5) }));
    a.routineI = i;
  });
  human(w, "civilian", -13.2, 5.8, {
    routine: [
      { x: -13.2, z: 5.8 },
      { x: -4, z: 1 },
    ],
  });
  human(w, "civilian", -18, -3.5);
  human(w, "civilian", -18.2, 1.4);
  human(w, "civilian", 10.5, 9);
  const guards: [number, number][] = [
    [0, -11.2],
    [2.4, -10.4],
    [-2.2, -10.6],
    [9.2, -8],
    [4, 6],
    [-8, -8],
    [0, 12],
  ];
  guards.forEach(([x, z], i) => {
    const g = human(w, "guard", x, z, { height: 1.74, mass: 82, strength: 1.15 });
    g.routine = [
      { x, z },
      { x: x + (i % 2 ? 6 : -5), z: z + 4 },
      { x: 0, z: 0 },
    ];
  });
  const h = human(w, "hunter", -4, -20, { cloth: 0x3a3428, weapon: "knife" });
  h.routine = [
    { x: -4, z: -20 },
    { x: -10, z: -24 },
    { x: 6, z: -18 },
  ];
}

function addBeasts(w: World) {
  const pen = (species: "goat" | "pig" | "cow", x: number, z: number, extra: Partial<Actor> = {}) =>
    w.addActor({
      kind: "beast",
      species,
      faction: "none",
      name: species,
      x,
      y: 0,
      z,
      radius: species === "cow" ? 0.48 : 0.3,
      height: species === "cow" ? 1.25 : 0.75,
      mass: species === "cow" ? 220 : species === "pig" ? 65 : 45,
      cloth: species === "cow" ? 0x5a4a40 : species === "pig" ? 0xb88880 : 0x9a9084,
      skin: species === "cow" ? 0xe8dcc8 : 0xd4a090,
      homeX: 18,
      homeZ: -7,
      courage: 0.2,
      ...extra,
    });
  pen("goat", 17.2, -6.4);
  pen("goat", 18.6, -7.8);
  pen("pig", 16.8, -8.2);
  pen("pig", 19.1, -6.1);
  pen("cow", 18.2, -7.2, { strength: 1.8 });
  for (const [x, z] of [
    [-12, -26],
    [-6, -30],
    [8, -28],
    [14, -24],
  ] as [number, number][]) {
    w.addActor({
      kind: "beast",
      species: "deer",
      faction: "wild",
      name: "deer",
      x,
      y: 0,
      z,
      radius: 0.32,
      height: 1.15,
      mass: 55,
      cloth: 0x8a6a48,
      skin: 0xc4a070,
      homeX: x,
      homeZ: z,
      courage: 0.1,
    });
  }
  const wolf = (x: number, z: number) =>
    w.addActor({
      kind: "beast",
      species: "wolf",
      faction: "wild",
      name: "wolf",
      x,
      y: 0,
      z,
      radius: 0.33,
      height: 0.84,
      mass: 40,
      cloth: 0x3a3a40,
      skin: 0x2a2a30,
      homeX: x,
      homeZ: z,
      courage: 0.55,
      aggression: 0.68,
      strength: 1.1,
    });
  wolf(-16, -32);
  wolf(-13.5, -34);
  wolf(18, -33);
  w.addActor({
    kind: "beast",
    species: "bear",
    faction: "wild",
    name: "bear",
    x: -24,
    y: 0,
    z: -30,
    radius: 0.7,
    height: 1.45,
    mass: 280,
    cloth: 0x3a2a20,
    skin: 0x2a1c14,
    homeX: -24,
    homeZ: -30,
    courage: 0.85,
    aggression: 0.55,
    strength: 2.2,
  });
}

function addPlayer(w: World) {
  const p = w.addActor({
    kind: "player",
    species: "human",
    faction: "player",
    name: "you",
    x: 0.3,
    y: 0,
    z: -24.5,
    yaw: Math.PI,
    radius: 0.32,
    height: 1.72,
    mass: 78,
    strength: 1.05,
    courage: 0.7,
    skin: 0xb89272,
    cloth: 0x2c241c,
    accent: 0x6a3828,
    weapon: "fist",
  });
  w.playerId = p.id;
}

function markIndoor(w: World) {
  for (const b of w.buildings) {
    if (!b.indoor) continue;
    for (let x = b.minX; x < b.maxX; x += 2) {
      for (let z = b.minZ; z < b.maxZ; z += 2) {
        w.indoor[w.cell(x, z)] = 1;
      }
    }
  }
}
