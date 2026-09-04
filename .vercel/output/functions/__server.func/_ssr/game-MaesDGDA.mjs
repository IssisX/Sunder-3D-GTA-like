import { a as defaultHud, i as WEAPON_STATS, n as REGIONS, o as emptyInjury, r as STEP } from "./routes-Cwd1k7r-.mjs";
import { C as SRGBColorSpace, E as Vector3, S as RepeatWrapping, T as SphereGeometry, _ as PerspectiveCamera, a as BufferGeometry, b as Points, c as ConeGeometry, d as FogExp2, f as Group, g as MeshStandardMaterial, h as MeshBasicMaterial, i as BufferAttribute, l as CylinderGeometry, m as Mesh, n as AmbientLight, o as CanvasTexture, p as HemisphereLight, r as BoxGeometry, s as Color, t as WebGLRenderer, u as DirectionalLight, v as PlaneGeometry, w as Scene, x as PointsMaterial, y as PointLight } from "../_libs/three.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/game-MaesDGDA.js
var World = class {
	time = 0;
	day = .7;
	rain = 0;
	rainTarget = 0;
	windX = 1.4;
	windZ = .4;
	thunderT = 999;
	nextId = 1;
	actors = [];
	props = [];
	buildings = [];
	colliders = [];
	tracks = [];
	sounds = [];
	whispers = [];
	whisperId = 1;
	playerId = 0;
	fuel = /* @__PURE__ */ new Float32Array(1936);
	heat = /* @__PURE__ */ new Float32Array(1936);
	wet = /* @__PURE__ */ new Float32Array(1936);
	oil = /* @__PURE__ */ new Float32Array(1936);
	smoke = /* @__PURE__ */ new Float32Array(1936);
	char = /* @__PURE__ */ new Float32Array(1936);
	burning = /* @__PURE__ */ new Uint8Array(1936);
	indoor = /* @__PURE__ */ new Uint8Array(1936);
	hash = /* @__PURE__ */ new Map();
	events = [];
	wanted = 0;
	fireCount = 0;
	shake = 0;
	hitstop = 0;
	seed = 1;
	captureT = 0;
	deadCause = "";
	phase = "title";
	rng() {
		this.seed = this.seed * 16807 % 2147483647;
		return (this.seed - 1) / 2147483646;
	}
	cell(x, z) {
		return Math.max(0, Math.min(43, (x + 44) / 2 | 0)) + Math.max(0, Math.min(43, (z + 44) / 2 | 0)) * 44;
	}
	ixz(i) {
		const ix = i % 44;
		const iz = i / 44 | 0;
		return {
			x: ix * 2 - 44 + 1,
			z: iz * 2 - 44 + 1
		};
	}
	hashKey(x, z) {
		const c = 4;
		return (Math.floor((x + 44) / c) & 255) << 8 | Math.floor((z + 44) / c) & 255;
	}
	rebuildHash() {
		this.hash.clear();
		for (const a of this.actors) {
			if (!a.alive && a.loco === "down") {}
			const k = this.hashKey(a.x, a.z);
			let b = this.hash.get(k);
			if (!b) {
				b = [];
				this.hash.set(k, b);
			}
			b.push(a.id);
		}
	}
	nearby(x, z, r) {
		const out = [];
		const c = 4;
		const r2 = r * r;
		const x0 = Math.floor((x - r + 44) / c);
		const x1 = Math.floor((x + r + 44) / c);
		const z0 = Math.floor((z - r + 44) / c);
		const z1 = Math.floor((z + r + 44) / c);
		const seen = /* @__PURE__ */ new Set();
		for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
			const list = this.hash.get((ix & 255) << 8 | iz & 255);
			if (!list) continue;
			for (const id of list) {
				if (seen.has(id)) continue;
				seen.add(id);
				const a = this.actor(id);
				if (!a) continue;
				if ((a.x - x) * (a.x - x) + (a.z - z) * (a.z - z) <= r2) out.push(a);
			}
		}
		return out;
	}
	actor(id) {
		return this.actors.find((a) => a.id === id);
	}
	prop(id) {
		return this.props.find((p) => p.id === id);
	}
	player() {
		return this.actor(this.playerId);
	}
	emitSound(x, z, mag, kind, who = 0) {
		this.sounds.push({
			x,
			z,
			mag,
			kind,
			t: this.time,
			who
		});
		this.events.push({
			kind: "snd:" + kind,
			x,
			z,
			a: who,
			mag
		});
	}
	whisper(text) {
		if (this.whispers.length && this.whispers[this.whispers.length - 1].text === text) return;
		this.whispers.push({
			id: this.whisperId++,
			text,
			t: this.time
		});
		if (this.whispers.length > 8) this.whispers.shift();
	}
	remember(a, mem) {
		a.memories.push({
			...mem,
			t: this.time
		});
		if (a.memories.length > 12) a.memories.shift();
	}
	addActor(partial) {
		const a = {
			id: this.nextId++,
			name: "",
			x: 0,
			y: 0,
			z: 0,
			px: 0,
			py: 0,
			pz: 0,
			yaw: 0,
			pyaw: 0,
			vx: 0,
			vy: 0,
			vz: 0,
			radius: .32,
			height: 1.7,
			mass: 75,
			grounded: true,
			balance: 1,
			stamina: 1,
			fatigue: 0,
			pain: 0,
			consciousness: 1,
			breath: 1,
			wet: 0,
			heat: 0,
			loco: "idle",
			locoT: 0,
			crouch: false,
			injuries: {
				head: emptyInjury(),
				torso: emptyInjury(),
				larm: emptyInjury(),
				rarm: emptyInjury(),
				lleg: emptyInjury(),
				rleg: emptyInjury()
			},
			bleed: 0,
			blood: 1,
			grabbedId: 0,
			grabbedBy: 0,
			carry: 0,
			weapon: "fist",
			torchLit: false,
			strikeT: 0,
			strikeCd: 0,
			strikeHit: 0,
			kickT: 0,
			shoveT: 0,
			vaultT: 0,
			getupT: 0,
			climbId: 0,
			alive: true,
			downT: 0,
			ai: "idle",
			aiT: 0,
			homeX: 0,
			homeZ: 0,
			wayX: 0,
			wayZ: 0,
			targetId: 0,
			lastSeenX: 0,
			lastSeenZ: 0,
			lastSeenT: -99,
			fear: 0,
			courage: .5,
			aggression: .4,
			loyalty: .5,
			competence: .5,
			strength: 1,
			memories: [],
			known: [],
			alert: 0,
			routine: [],
			routineI: 0,
			walkPhase: 0,
			leanX: 0,
			leanZ: 0,
			recovT: 0,
			shoutCd: 0,
			attackCd: 0,
			submerged: 0,
			skin: 12558476,
			cloth: 4866102,
			accent: 2892828,
			helmet: false,
			sex: 0,
			weaponProp: 0,
			intendX: 0,
			intendZ: 0,
			intendSpeed: 0,
			searchX: 0,
			searchZ: 0,
			searchT: 0,
			lastHitBy: 0,
			lastHitT: -99,
			pinnedId: 0,
			...partial
		};
		a.px = a.x;
		a.py = a.y;
		a.pz = a.z;
		a.homeX = a.homeX || a.x;
		a.homeZ = a.homeZ || a.z;
		this.actors.push(a);
		return a;
	}
	addProp(partial) {
		const p = {
			id: this.nextId++,
			material: "wood",
			x: 0,
			y: 0,
			z: 0,
			px: 0,
			py: 0,
			pz: 0,
			yaw: 0,
			vx: 0,
			vy: 0,
			vz: 0,
			sx: .6,
			sy: .6,
			sz: .6,
			mass: 8,
			hp: 40,
			maxHp: 40,
			flammable: true,
			fuel: 8,
			burning: false,
			oil: false,
			sharp: 0,
			heldBy: 0,
			support: false,
			buildingId: 0,
			load: 0,
			capacity: 80,
			collapsed: false,
			dynamic: false,
			anchored: true,
			weapon: null,
			color: 5916212,
			...partial
		};
		p.px = p.x;
		p.py = p.y;
		p.pz = p.z;
		p.maxHp = p.hp;
		this.props.push(p);
		return p;
	}
	addCollider(c) {
		this.colliders.push(c);
		return c;
	}
	addBox(x, y, z, sx, sy, sz, extra = {}) {
		return this.addCollider({
			minX: x - sx * .5,
			maxX: x + sx * .5,
			minY: y,
			maxY: y + sy,
			minZ: z - sz * .5,
			maxZ: z + sz * .5,
			material: "wood",
			climb: sy > 1.2,
			vault: sy > .35 && sy < 1.15,
			propId: 0,
			solid: true,
			water: false,
			...extra
		});
	}
	addMemory(a, kind, x, z, who, certainty) {
		const existing = a.memories.find((m) => m.kind === kind && m.who === who);
		if (existing) {
			existing.x = x;
			existing.z = z;
			existing.t = this.time;
			existing.certainty = Math.max(existing.certainty, certainty);
			return;
		}
		this.remember(a, {
			kind,
			x,
			z,
			who,
			certainty
		});
	}
	inWater(x, z, y) {
		for (const c of this.colliders) {
			if (!c.water) continue;
			if (x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y < c.maxY) return c;
		}
		return null;
	}
	indoorAt(x, z) {
		for (const b of this.buildings) {
			if (b.collapsed) continue;
			if (x > b.minX + .2 && x < b.maxX - .2 && z > b.minZ + .2 && z < b.maxZ - .2) return b;
		}
		return null;
	}
};
function makeHumanStats(w, faction) {
	return {
		courage: faction === "guard" ? .72 + w.rng() * .2 : faction === "hunter" ? .6 + w.rng() * .2 : .28 + w.rng() * .35,
		aggression: faction === "guard" ? .55 + w.rng() * .3 : faction === "hunter" ? .45 + w.rng() * .3 : .12 + w.rng() * .25,
		loyalty: faction === "civilian" ? .4 + w.rng() * .4 : .55 + w.rng() * .35,
		competence: .35 + w.rng() * .5,
		strength: .85 + w.rng() * .4,
		mass: 62 + w.rng() * 30
	};
}
function locoSpeed(a) {
	return Math.hypot(a.vx, a.vz);
}
function facing(yaw) {
	return {
		x: -Math.sin(yaw),
		z: -Math.cos(yaw)
	};
}
function rightOf(yaw) {
	return {
		x: Math.cos(yaw),
		z: -Math.sin(yaw)
	};
}
function angDiff(a, b) {
	let d = b - a;
	while (d > Math.PI) d -= Math.PI * 2;
	while (d < -Math.PI) d += Math.PI * 2;
	return d;
}
function lerpAng(a, b, t) {
	return a + angDiff(a, b) * t;
}
function clamp(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}
function dist2(ax, az, bx, bz) {
	const dx = ax - bx;
	const dz = az - bz;
	return dx * dx + dz * dz;
}
function regionFromHit(localY, side) {
	if (localY > 1.45) return "head";
	if (localY < .7) return side < 0 ? "lleg" : "rleg";
	if (localY > 1.05 && Math.abs(side) > .18) return side < 0 ? "larm" : "rarm";
	return "torso";
}
function injurySum(i) {
	return i.bruise * .4 + i.cut * .8 + i.puncture * .9 + i.burn * .7 + i.fracture * 1.4 + i.sprain * .7;
}
function canSeeThrough(w, ax, az, bx, bz) {
	const dx = bx - ax;
	const dz = bz - az;
	const steps = 6;
	for (let i = 1; i < steps; i++) {
		const t = i / steps;
		const x = ax + dx * t;
		const z = az + dz * t;
		for (const c of w.colliders) {
			if (!c.solid || c.water) continue;
			if (c.maxY < 1.2) continue;
			if (x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ) return false;
		}
	}
	return true;
}
var EMPTY = {
	moveX: 0,
	moveY: 0,
	lookX: 0,
	lookY: 0,
	sprint: false,
	crouch: false,
	jump: false,
	jumpPressed: false,
	attack: false,
	attackPressed: false,
	grab: false,
	grabPressed: false,
	grabReleased: false,
	kick: false,
	kickPressed: false,
	shove: false,
	shovePressed: false,
	drop: false,
	dropPressed: false,
	bandage: false,
	ignite: false,
	ignitePressed: false,
	pausePressed: false
};
var GAME_CODES = /* @__PURE__ */ new Set([
	"KeyW",
	"KeyA",
	"KeyS",
	"KeyD",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"ShiftLeft",
	"ShiftRight",
	"Space",
	"KeyC",
	"KeyE",
	"KeyF",
	"KeyG",
	"KeyQ",
	"KeyR",
	"KeyV",
	"KeyT",
	"Escape",
	"ControlLeft"
]);
function radial(x, y, dz = .16) {
	const m = Math.hypot(x, y);
	if (m < dz) return {
		x: 0,
		y: 0
	};
	const scale = (m - dz) / (1 - dz) / m;
	return {
		x: x * scale,
		y: y * scale
	};
}
function isTouchDevice() {
	if (typeof window === "undefined") return false;
	return window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
}
var Input = class {
	keys = /* @__PURE__ */ new Set();
	injected = null;
	prev = { ...EMPTY };
	mouseDx = 0;
	mouseDy = 0;
	locked = false;
	lookSens = .0022;
	lookTouchSens = .0074;
	invertY = false;
	enabled = false;
	hudControls = false;
	padAwake = false;
	pointerIds = /* @__PURE__ */ new Map();
	joyX = 0;
	joyY = 0;
	lookTouchX = 0;
	lookTouchY = 0;
	heldButtons = /* @__PURE__ */ new Set();
	canvas;
	onLock;
	constructor(canvas) {
		this.canvas = canvas;
		this.onKey = this.onKey.bind(this);
		this.onMouse = this.onMouse.bind(this);
		this.onPointer = this.onPointer.bind(this);
		this.onBlur = this.onBlur.bind(this);
		this.onLockChange = this.onLockChange.bind(this);
		window.addEventListener("keydown", this.onKey);
		window.addEventListener("keyup", this.onKey);
		window.addEventListener("blur", this.onBlur);
		document.addEventListener("visibilitychange", this.onBlur);
		document.addEventListener("pointerlockchange", this.onLockChange);
		canvas.addEventListener("mousemove", this.onMouse);
		canvas.addEventListener("mousedown", this.onMouse);
		canvas.addEventListener("mouseup", this.onMouse);
		canvas.addEventListener("contextmenu", (e) => e.preventDefault());
		canvas.addEventListener("pointerdown", this.onPointer, { passive: false });
		canvas.addEventListener("pointermove", this.onPointer, { passive: false });
		canvas.addEventListener("pointerup", this.onPointer);
		canvas.addEventListener("pointercancel", this.onPointer);
		canvas.addEventListener("lostpointercapture", this.onPointer);
	}
	dispose() {
		window.removeEventListener("keydown", this.onKey);
		window.removeEventListener("keyup", this.onKey);
		window.removeEventListener("blur", this.onBlur);
		document.removeEventListener("visibilitychange", this.onBlur);
		document.removeEventListener("pointerlockchange", this.onLockChange);
		this.canvas.removeEventListener("mousemove", this.onMouse);
		this.canvas.removeEventListener("mousedown", this.onMouse);
		this.canvas.removeEventListener("mouseup", this.onMouse);
		this.canvas.removeEventListener("pointerdown", this.onPointer);
		this.canvas.removeEventListener("pointermove", this.onPointer);
		this.canvas.removeEventListener("pointerup", this.onPointer);
		this.canvas.removeEventListener("pointercancel", this.onPointer);
		this.canvas.removeEventListener("lostpointercapture", this.onPointer);
	}
	requestLock() {
		if (this.locked) return;
		if (isTouchDevice()) return;
		this.canvas.requestPointerLock?.();
	}
	setKeys(codes) {
		this.injected = codes;
	}
	setHudControls(on) {
		this.hudControls = on;
		if (!on) {
			this.joyX = 0;
			this.joyY = 0;
		}
	}
	setStick(x, y) {
		this.joyX = Math.max(-1, Math.min(1, x));
		this.joyY = Math.max(-1, Math.min(1, y));
	}
	addLook(dx, dy) {
		this.lookTouchX += dx;
		this.lookTouchY += dy;
	}
	onLockChange() {
		this.locked = document.pointerLockElement === this.canvas;
		this.onLock?.(this.locked);
	}
	onBlur() {
		this.keys.clear();
		this.mouseDx = 0;
		this.mouseDy = 0;
		this.joyX = 0;
		this.joyY = 0;
		this.lookTouchX = 0;
		this.lookTouchY = 0;
		this.pointerIds.clear();
		this.heldButtons.clear();
	}
	onKey(e) {
		if (!this.enabled && e.type === "keydown") return;
		if (e.type === "keydown") {
			this.keys.add(e.code);
			if (GAME_CODES.has(e.code)) e.preventDefault();
		} else this.keys.delete(e.code);
	}
	onMouse(e) {
		if (!this.enabled) return;
		if (e.type === "mousemove" && this.locked) {
			this.mouseDx += e.movementX;
			this.mouseDy += e.movementY;
		}
		if (e.type === "mousedown") {
			if (e.button === 0) this.heldButtons.add("attack");
			if (e.button === 2) this.heldButtons.add("grab");
		}
		if (e.type === "mouseup") {
			if (e.button === 0) this.heldButtons.delete("attack");
			if (e.button === 2) this.heldButtons.delete("grab");
		}
	}
	onPointer(e) {
		if (!this.enabled) return;
		if (e.pointerType === "mouse") return;
		if (this.hudControls) return;
		if (e.type === "pointerdown" || e.type === "pointermove") e.preventDefault();
		const rect = this.canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		if (e.type === "pointerdown") {
			const role = x < rect.width * .42 ? "joy" : "look";
			this.pointerIds.set(e.pointerId, {
				role,
				x,
				y,
				sx: x,
				sy: y
			});
			try {
				this.canvas.setPointerCapture(e.pointerId);
			} catch {}
		} else if (e.type === "pointermove") {
			const p = this.pointerIds.get(e.pointerId);
			if (!p) return;
			if (p.role === "joy") {
				const v = radial((x - p.sx) / 72, (y - p.sy) / 72, .08);
				this.joyX = Math.max(-1, Math.min(1, v.x));
				this.joyY = Math.max(-1, Math.min(1, -v.y));
			} else if (p.role === "look") {
				this.lookTouchX += e.movementX || x - p.x;
				this.lookTouchY += e.movementY || y - p.y;
				p.x = x;
				p.y = y;
			}
		} else {
			if (this.pointerIds.get(e.pointerId)?.role === "joy") {
				this.joyX = 0;
				this.joyY = 0;
			}
			this.pointerIds.delete(e.pointerId);
		}
	}
	pressVirtual(btn, down) {
		if (down) this.heldButtons.add(btn);
		else this.heldButtons.delete(btn);
	}
	sample() {
		const held = this.injected ? new Set(this.injected) : this.keys;
		const down = (c) => held.has(c);
		let moveX = 0;
		let moveY = 0;
		if (down("KeyD") || down("ArrowRight")) moveX += 1;
		if (down("KeyA") || down("ArrowLeft")) moveX -= 1;
		if (down("KeyW") || down("ArrowUp")) moveY += 1;
		if (down("KeyS") || down("ArrowDown")) moveY -= 1;
		moveX += this.joyX;
		moveY += this.joyY;
		const pads = typeof navigator !== "undefined" ? navigator.getGamepads?.() ?? [] : [];
		for (const pad of pads) {
			if (!pad) continue;
			if (pad.buttons.some((b) => b.pressed)) this.padAwake = true;
			if (!this.padAwake) continue;
			const st = radial(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
			moveX += st.x;
			moveY += -st.y;
			const look = radial(pad.axes[2] ?? 0, pad.axes[3] ?? 0, .22);
			this.mouseDx += look.x * 14;
			this.mouseDy += look.y * 14;
			if (pad.buttons[0]?.pressed) this.heldButtons.add("jump");
			if (pad.buttons[2]?.pressed) this.heldButtons.add("attack");
			if (pad.buttons[5]?.pressed || pad.buttons[7]?.pressed) this.heldButtons.add("grab");
			if (pad.buttons[1]?.pressed) this.heldButtons.add("kick");
			if (pad.buttons[4]?.pressed || pad.buttons[10]?.pressed) this.heldButtons.add("sprint");
			if (pad.buttons[9]?.pressed) this.heldButtons.add("pause");
		}
		const mag = Math.hypot(moveX, moveY);
		if (mag > 1) {
			moveX /= mag;
			moveY /= mag;
		}
		const lookX = this.mouseDx * this.lookSens + this.lookTouchX * this.lookTouchSens;
		const lookY = (this.mouseDy * this.lookSens + this.lookTouchY * this.lookTouchSens) * (this.invertY ? -1 : 1);
		this.mouseDx = 0;
		this.mouseDy = 0;
		this.lookTouchX = 0;
		this.lookTouchY = 0;
		const attack = this.heldButtons.has("attack");
		const grab = this.heldButtons.has("grab") || down("KeyQ");
		const jump = down("Space") || this.heldButtons.has("jump");
		const kick = down("KeyF") || this.heldButtons.has("kick");
		const shove = down("KeyE") || this.heldButtons.has("shove");
		const drop = down("KeyG") || this.heldButtons.has("drop");
		const ignite = down("KeyR") || this.heldButtons.has("ignite");
		const pause = down("Escape") || this.heldButtons.has("pause");
		const sprint = down("ShiftLeft") || down("ShiftRight") || this.heldButtons.has("sprint");
		const a = {
			moveX,
			moveY,
			lookX,
			lookY,
			sprint,
			crouch: down("KeyC") || down("ControlLeft") || this.heldButtons.has("crouch"),
			jump,
			jumpPressed: jump && !this.prev.jump,
			attack,
			attackPressed: attack && !this.prev.attack,
			grab,
			grabPressed: grab && !this.prev.grab,
			grabReleased: !grab && this.prev.grab,
			kick,
			kickPressed: kick && !this.prev.kick,
			shove,
			shovePressed: shove && !this.prev.shove,
			drop,
			dropPressed: drop && !this.prev.drop,
			bandage: down("KeyT") || this.heldButtons.has("bandage"),
			ignite,
			ignitePressed: ignite && !this.prev.ignite,
			pausePressed: pause && !this.prev.pausePressed
		};
		this.prev = {
			...a,
			pausePressed: pause
		};
		if (this.heldButtons.has("jump") && !down("Space") && !this.hudControls) this.heldButtons.delete("jump");
		if (this.heldButtons.has("pause")) this.heldButtons.delete("pause");
		return a;
	}
};
var GameAudio = class {
	ctx = null;
	master = null;
	sfx = null;
	music = null;
	muted = false;
	volume = .85;
	noise = null;
	last = {};
	rain = null;
	fire = null;
	drone = null;
	unlock() {
		if (!this.ctx) {
			const AC = window.AudioContext || window.webkitAudioContext;
			this.ctx = new AC({ latencyHint: "interactive" });
			this.master = this.ctx.createGain();
			this.sfx = this.ctx.createGain();
			this.music = this.ctx.createGain();
			this.sfx.connect(this.master);
			this.music.connect(this.master);
			this.master.connect(this.ctx.destination);
			this.master.gain.value = this.muted ? 0 : this.volume * this.volume;
			this.sfx.gain.value = .9;
			this.music.gain.value = .28;
			this.noise = this.makeNoise();
			this.startBeds();
		}
		if (this.ctx.state === "suspended") this.ctx.resume();
	}
	setMuted(m) {
		this.muted = m;
		this.applyVol();
	}
	setVolume(v) {
		this.volume = v;
		this.applyVol();
	}
	applyVol() {
		if (!this.master || !this.ctx) return;
		this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume * this.volume, this.ctx.currentTime, .04);
	}
	resume() {
		if (this.ctx?.state === "suspended") this.ctx.resume();
	}
	makeNoise() {
		const ctx = this.ctx;
		const buf = ctx.createBuffer(1, ctx.sampleRate * 1.2, ctx.sampleRate);
		const d = buf.getChannelData(0);
		for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
		return buf;
	}
	startBeds() {
		if (!this.ctx || !this.music || !this.noise) return;
		const ctx = this.ctx;
		const drone = ctx.createGain();
		drone.gain.value = 0;
		drone.connect(this.music);
		const o1 = ctx.createOscillator();
		o1.type = "sine";
		o1.frequency.value = 46;
		const o2 = ctx.createOscillator();
		o2.type = "triangle";
		o2.frequency.value = 69.5;
		const g2 = ctx.createGain();
		g2.gain.value = .35;
		o1.connect(drone);
		o2.connect(g2).connect(drone);
		o1.start();
		o2.start();
		this.drone = drone;
		const rain = ctx.createGain();
		rain.gain.value = 0;
		const src = ctx.createBufferSource();
		src.buffer = this.noise;
		src.loop = true;
		const f = ctx.createBiquadFilter();
		f.type = "bandpass";
		f.frequency.value = 1400;
		f.Q.value = .5;
		src.connect(f).connect(rain).connect(this.sfx);
		src.start();
		this.rain = rain;
		const fire = ctx.createGain();
		fire.gain.value = 0;
		const fs = ctx.createBufferSource();
		fs.buffer = this.noise;
		fs.loop = true;
		const ff = ctx.createBiquadFilter();
		ff.type = "lowpass";
		ff.frequency.value = 800;
		fs.connect(ff).connect(fire).connect(this.sfx);
		fs.start();
		this.fire = fire;
	}
	setBeds(rain, fire, danger, timeOfDay) {
		if (!this.ctx) return;
		const t = this.ctx.currentTime;
		this.rain?.gain.setTargetAtTime(Math.min(.22, rain * .22), t, .4);
		this.fire?.gain.setTargetAtTime(Math.min(.16, fire * .05), t, .3);
		const night = timeOfDay < .22 || timeOfDay > .78 ? .08 : .03;
		this.drone?.gain.setTargetAtTime(night + danger * .1, t, .6);
	}
	play(kind, mag = 1, pan = 0) {
		if (!this.ctx || !this.sfx || !this.noise) return;
		const now = this.ctx.currentTime;
		if (now - (this.last[kind] ?? 0) < .04) return;
		this.last[kind] = now;
		const g = this.ctx.createGain();
		const p = this.ctx.createStereoPanner();
		p.pan.value = Math.max(-.85, Math.min(.85, pan));
		g.connect(p).connect(this.sfx);
		const m = Math.max(.04, Math.min(1.4, mag));
		const beep = (freq, dur, type, vol, slide = 0) => {
			const o = this.ctx.createOscillator();
			o.type = type;
			o.frequency.setValueAtTime(freq, now);
			if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), now + dur);
			const og = this.ctx.createGain();
			og.gain.setValueAtTime(vol * m, now);
			og.gain.exponentialRampToValueAtTime(1e-4, now + dur);
			o.connect(og).connect(g);
			o.start(now);
			o.stop(now + dur + .02);
		};
		const burst = (dur, vol, hp, lp, rate = 1) => {
			const s = this.ctx.createBufferSource();
			s.buffer = this.noise;
			s.playbackRate.value = rate * (.9 + Math.random() * .2);
			const f1 = this.ctx.createBiquadFilter();
			f1.type = "highpass";
			f1.frequency.value = hp;
			const f2 = this.ctx.createBiquadFilter();
			f2.type = "lowpass";
			f2.frequency.value = lp;
			const og = this.ctx.createGain();
			og.gain.setValueAtTime(vol * m, now);
			og.gain.exponentialRampToValueAtTime(1e-4, now + dur);
			s.connect(f1).connect(f2).connect(og).connect(g);
			s.start(now);
			s.stop(now + dur + .02);
		};
		switch (kind) {
			case "step":
				burst(.08, .18, 80, 420, .7 + Math.random() * .4);
				break;
			case "sprint":
				burst(.09, .26, 60, 500, .85);
				break;
			case "impact":
				burst(.16, .45, 40, 700, .5);
				beep(90, .12, "sine", .2, -40);
				break;
			case "wood":
				burst(.14, .35, 200, 1800, 1.1);
				beep(180, .08, "triangle", .12, -80);
				break;
			case "break":
				burst(.28, .5, 100, 2400, .9);
				beep(140, .18, "sawtooth", .08, -90);
				break;
			case "collapse":
				burst(.8, .7, 30, 600, .35);
				beep(55, .5, "sine", .28, -20);
				break;
			case "scream":
				beep(420 + Math.random() * 80, .45, "sawtooth", .12, 60);
				burst(.4, .2, 600, 3e3, 1.4);
				break;
			case "shout":
				beep(220, .22, "square", .1, -30);
				burst(.2, .22, 300, 1600, 1);
				break;
			case "weapon":
				burst(.1, .28, 400, 4e3, 1.6);
				beep(240, .07, "triangle", .08, -120);
				break;
			case "fire":
				burst(.2, .18, 200, 1200, 1.3);
				break;
			case "splash":
				burst(.22, .3, 300, 2200, .8);
				break;
			case "animal":
				beep(140 + Math.random() * 90, .25, "sawtooth", .1, -50);
				break;
			case "whoosh":
				burst(.12, .2, 500, 5e3, 2);
				break;
			case "hurt":
				beep(160, .14, "sine", .16, -70);
				burst(.12, .2, 100, 800, .6);
				break;
			case "grab":
				burst(.08, .22, 150, 900, .7);
				break;
			case "ui":
				beep(520, .08, "sine", .08, 0);
				break;
			case "thunder":
				burst(1.2, .8, 20, 280, .25);
				beep(40, .8, "sine", .3, -10);
				break;
			default: burst(.1, .2, 100, 1e3, 1);
		}
	}
};
var NAMES_M = [
	"Hark",
	"Rowan",
	"Bram",
	"Edd",
	"Cole",
	"Pim",
	"Tor",
	"Wile",
	"Nash",
	"Orrin"
];
var NAMES_F = [
	"Maer",
	"Linn",
	"Sera",
	"Wren",
	"Nell",
	"Kett",
	"Asha",
	"Brid",
	"Ola",
	"Tamsin"
];
function name(w, sex) {
	const list = sex < .5 ? NAMES_M : NAMES_F;
	return list[w.rng() * list.length | 0];
}
function skinOf(w) {
	const tones = [
		12886138,
		11569512,
		9268820,
		7295808,
		13939862,
		10121294
	];
	return tones[w.rng() * tones.length | 0];
}
function buildLevel(w) {
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
function seedGround(w) {
	for (let iz = 0; iz < 44; iz++) for (let ix = 0; ix < 44; ix++) {
		const i = ix + iz * 44;
		const x = ix * 2 - 44;
		const z = iz * 2 - 44;
		w.fuel[i] = .15;
		w.wet[i] = .2;
		if (z < -14) w.fuel[i] = .55;
		if (Math.abs(x) < 10 && Math.abs(z) < 10) w.fuel[i] = .12;
		if (x > 12 && z < -4 && z > -16) w.fuel[i] = .7;
		w.wet[i] = z > 16 ? .7 : .18 + w.rng() * .1;
	}
}
function addRiver(w) {
	w.addCollider({
		minX: -44,
		maxX: 44,
		minY: -1.4,
		maxY: .05,
		minZ: 17.5,
		maxZ: 24.5,
		material: "water",
		climb: false,
		vault: false,
		propId: 0,
		solid: false,
		water: true
	});
}
function addPalisade(w) {
	for (let x = -22; x <= 22; x += 1.4) {
		if (Math.abs(x) < 2.6) continue;
		const p = w.addProp({
			kind: "fence",
			material: "wood",
			x,
			y: 0,
			z: -12,
			sx: .28,
			sy: 2.1,
			sz: 1.3,
			mass: 40,
			hp: 55,
			color: 3812898,
			flammable: true,
			fuel: 6
		});
		w.addBox(x, 0, -12, .28, 2.1, 1.3, {
			propId: p.id,
			vault: false,
			climb: true
		});
	}
	for (const gx of [-2.8, 2.8]) {
		const post = w.addProp({
			kind: "post",
			material: "wood",
			x: gx,
			y: 0,
			z: -12,
			sx: .4,
			sy: 2.8,
			sz: .4,
			mass: 55,
			hp: 80,
			color: 3023900,
			flammable: true,
			fuel: 6,
			support: true
		});
		w.addBox(gx, 0, -12, .4, 2.8, .4, {
			propId: post.id,
			climb: true
		});
	}
}
function addBuilding(w, name, x, z, sx, sz, color, wallHp = 70) {
	const b = {
		id: w.nextId++,
		name,
		parts: [],
		supports: [],
		collapsed: false,
		minX: x - sx * .5,
		maxX: x + sx * .5,
		minY: 0,
		maxY: 3.4,
		minZ: z - sz * .5,
		maxZ: z + sz * .5,
		indoor: true
	};
	w.buildings.push(b);
	const posts = [
		[x - sx * .45, z - sz * .45],
		[x + sx * .45, z - sz * .45],
		[x - sx * .45, z + sz * .45],
		[x + sx * .45, z + sz * .45]
	];
	for (const [px, pz] of posts) {
		const p = w.addProp({
			kind: "post",
			material: "wood",
			x: px,
			y: 0,
			z: pz,
			sx: .28,
			sy: 3.1,
			sz: .28,
			mass: 50,
			hp: wallHp,
			support: true,
			buildingId: b.id,
			color: 4864554,
			flammable: true,
			fuel: 7,
			capacity: 90
		});
		b.supports.push(p.id);
		b.parts.push(p.id);
		w.addBox(px, 0, pz, .28, 3.1, .28, {
			propId: p.id,
			climb: true
		});
	}
	[
		[
			x,
			z - sz * .5,
			sx,
			.22
		],
		[
			x,
			z + sz * .5,
			sx,
			.22
		],
		[
			x - sx * .5,
			z,
			.22,
			sz
		],
		[
			x + sx * .5,
			z,
			.22,
			sz
		]
	].forEach((wl, i) => {
		const door = i === 1;
		const ww = door ? wl[2] * .38 : wl[2];
		const ox = door ? x - sx * .28 : wl[0];
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
			fuel: 10
		});
		b.parts.push(p.id);
		w.addBox(ox, 0, wl[1], ww, 2.6, wl[3], {
			propId: p.id,
			climb: true
		});
		if (door) {
			const p2 = w.addProp({
				kind: "wall",
				material: "wood",
				x: x + sx * .28,
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
				fuel: 10
			});
			b.parts.push(p2.id);
			w.addBox(x + sx * .28, 0, wl[1], ww, 2.6, wl[3], {
				propId: p2.id,
				climb: true
			});
		}
	});
	const roof = w.addProp({
		kind: "roof",
		material: "wood",
		x,
		y: 2.55,
		z,
		sx: sx + .5,
		sy: .28,
		sz: sz + .5,
		mass: 120,
		hp: 50,
		buildingId: b.id,
		color: 3879724,
		flammable: true,
		fuel: 12
	});
	b.parts.push(roof.id);
	w.addBox(x, 2.55, z, sx + .5, .28, sz + .5, {
		propId: roof.id,
		material: "wood"
	});
	return b;
}
function addMarket(w) {
	for (const [x, z, yaw] of [
		[
			-5.5,
			-3.2,
			.2
		],
		[
			-2.2,
			-4.4,
			.6
		],
		[
			2.4,
			-4.2,
			1.1
		],
		[
			5.4,
			-2.8,
			1.8
		],
		[
			-5.8,
			2.4,
			-.4
		],
		[
			5.6,
			2.8,
			3.2
		],
		[
			-2.4,
			4.6,
			0
		]
	]) {
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
			color: 6967608,
			flammable: true,
			fuel: 9,
			anchored: true
		});
		w.addBox(x, 0, z, 2.4, 1.15, 1.15, {
			propId: stall.id,
			vault: true,
			climb: false
		});
		w.addProp({
			kind: "lamp",
			material: "glass",
			x: x + .7,
			y: 1.25,
			z,
			sx: .18,
			sy: .32,
			sz: .18,
			mass: 1.2,
			hp: 8,
			color: 14201962,
			flammable: true,
			oil: true,
			fuel: 4,
			anchored: false,
			dynamic: false
		});
		if (w.rng() > .4) w.addProp({
			kind: "crate",
			material: "wood",
			x: x - .7,
			y: 0,
			z: z + .8,
			sx: .55,
			sy: .5,
			sz: .55,
			mass: 12,
			hp: 18,
			color: 5981748,
			flammable: true,
			fuel: 4,
			anchored: false
		});
		if (w.rng() > .55) w.addProp({
			kind: "flask",
			material: "glass",
			x: x + .2,
			y: 1.2,
			z: z + .2,
			sx: .16,
			sy: .28,
			sz: .16,
			mass: 1.4,
			hp: 6,
			oil: true,
			flammable: true,
			fuel: 5,
			color: 6969898,
			anchored: false
		});
	}
	w.addProp({
		kind: "hay",
		material: "hay",
		x: 7.4,
		y: 0,
		z: .5,
		sx: 1.4,
		sy: .9,
		sz: 1.1,
		mass: 18,
		hp: 16,
		color: 12756058,
		flammable: true,
		fuel: 16,
		anchored: false
	});
	w.addProp({
		kind: "hay",
		material: "hay",
		x: 8.2,
		y: 0,
		z: 1.6,
		sx: 1.2,
		sy: .7,
		sz: .9,
		mass: 14,
		hp: 14,
		color: 12097096,
		flammable: true,
		fuel: 14,
		anchored: false
	});
	w.addProp({
		kind: "chest",
		material: "wood",
		x: .2,
		y: 0,
		z: .4,
		sx: .7,
		sy: .5,
		sz: .45,
		mass: 38,
		hp: 60,
		color: 4008468,
		flammable: true,
		fuel: 4,
		anchored: false
	});
	w.addProp({
		kind: "barrel",
		material: "wood",
		x: -7.2,
		y: 0,
		z: .2,
		sx: .55,
		sy: .8,
		sz: .55,
		mass: 22,
		hp: 24,
		color: 4864040,
		oil: true,
		flammable: true,
		fuel: 8,
		anchored: false
	});
	w.addProp({
		kind: "weapon",
		material: "wood",
		x: -1.4,
		y: .1,
		z: -6.5,
		sx: .12,
		sy: .12,
		sz: 1.1,
		mass: 2.2,
		hp: 20,
		weapon: "club",
		color: 5915696,
		flammable: true,
		fuel: 2,
		anchored: false
	});
}
function addTavern(w) {
	addBuilding(w, "The Hearth", -13.5, 6.5, 8.2, 6.4, 4864044, 80);
	w.addProp({
		kind: "table",
		material: "wood",
		x: -13.5,
		y: 0,
		z: 6.2,
		sx: 1.8,
		sy: .75,
		sz: .8,
		mass: 24,
		hp: 22,
		color: 5915700,
		flammable: true,
		fuel: 6,
		anchored: false
	});
	w.addProp({
		kind: "lamp",
		material: "glass",
		x: -13.5,
		y: .85,
		z: 6.2,
		sx: .16,
		sy: .28,
		sz: .16,
		mass: 1,
		hp: 7,
		oil: true,
		color: 14729328,
		flammable: true,
		fuel: 3,
		anchored: false
	});
	w.addProp({
		kind: "weapon",
		material: "metal",
		x: -16.5,
		y: .1,
		z: 4.2,
		sx: .08,
		sy: .08,
		sz: .7,
		mass: .6,
		hp: 30,
		weapon: "knife",
		color: 8946816,
		flammable: false,
		fuel: 0,
		anchored: false
	});
}
function addWarehouse(w) {
	addBuilding(w, "the warehouse", 14.5, 3.5, 8.5, 6.8, 4076588, 65);
	for (let i = 0; i < 5; i++) w.addProp({
		kind: "hay",
		material: "hay",
		x: 12.4 + i % 3 * 1.5,
		y: 0,
		z: 2.2 + (i / 3 | 0) * 1.6,
		sx: 1.3,
		sy: .95,
		sz: 1.1,
		mass: 16,
		hp: 14,
		color: 12888156,
		flammable: true,
		fuel: 18,
		anchored: false
	});
	w.addProp({
		kind: "barrel",
		material: "wood",
		x: 16.8,
		y: 0,
		z: 5.4,
		sx: .6,
		sy: .85,
		sz: .6,
		mass: 28,
		hp: 26,
		oil: true,
		color: 4864040,
		flammable: true,
		fuel: 10,
		anchored: false
	});
}
function addHomes(w) {
	for (const [x, z, n] of [
		[
			-18,
			-4,
			"a cottage"
		],
		[
			-18.5,
			1.2,
			"a cottage"
		],
		[
			-10.5,
			-5.5,
			"a shack"
		],
		[
			10.5,
			9.2,
			"a cottage"
		]
	]) addBuilding(w, n, x, z, 5.4, 5, 5457462, 60);
}
function addBarracks(w) {
	addBuilding(w, "the barracks", 9.5, -8.2, 7.2, 5.2, 3814704, 90);
	w.addProp({
		kind: "weapon",
		material: "wood",
		x: 7.2,
		y: .1,
		z: -8.4,
		sx: .1,
		sy: .1,
		sz: 1.8,
		mass: 2.1,
		hp: 28,
		weapon: "spear",
		color: 6971464,
		flammable: true,
		fuel: 2,
		anchored: false
	});
}
function addLivestock(w) {
	for (let i = 0; i < 8; i++) {
		const ang = i / 8 * Math.PI * 2;
		const x = 18 + Math.cos(ang) * 4.2;
		const z = -7 + Math.sin(ang) * 3.4;
		if (i === 0) continue;
		const p = w.addProp({
			kind: "fence",
			material: "wood",
			x,
			y: 0,
			z,
			sx: .18,
			sy: 1.15,
			sz: 1.5,
			mass: 18,
			hp: 22,
			color: 4865068,
			flammable: true,
			fuel: 3
		});
		w.addBox(x, 0, z, .18, 1.15, 1.5, {
			propId: p.id,
			vault: true
		});
	}
}
function addForest(w) {
	const trees = [];
	for (let i = 0; i < 70; i++) {
		const x = (w.rng() - .5) * 80;
		const z = -16 - w.rng() * 24;
		if (Math.abs(x) < 3.6 && z > -28 && z < -10) continue;
		let ok = true;
		for (const t of trees) if ((t[0] - x) ** 2 + (t[1] - z) ** 2 < 9) ok = false;
		if (!ok) continue;
		trees.push([x, z]);
		w.addBox(x, 0, z, .7, 6, .7, {
			material: "vegetation",
			climb: true,
			vault: false
		});
		w.fuel[w.cell(x, z)] = .85;
	}
	w.addProp({
		kind: "weapon",
		material: "wood",
		x: 1.6,
		y: .1,
		z: -22.5,
		sx: .12,
		sy: .12,
		sz: .9,
		mass: 1.1,
		hp: 12,
		weapon: "torch",
		color: 6965800,
		flammable: true,
		fuel: 4,
		anchored: false
	});
	w.addProp({
		kind: "crate",
		material: "wood",
		x: 2.2,
		y: 0,
		z: -21.4,
		sx: .6,
		sy: .45,
		sz: .6,
		mass: 10,
		hp: 16,
		color: 5916212,
		flammable: true,
		fuel: 4,
		anchored: false
	});
}
function addBridge(w) {
	const deck = w.addProp({
		kind: "beam",
		material: "wood",
		x: 0,
		y: .15,
		z: 20.6,
		sx: 3.4,
		sy: .28,
		sz: 7.2,
		mass: 160,
		hp: 90,
		support: true,
		color: 4865072,
		flammable: true,
		fuel: 10
	});
	w.addBox(0, .15, 20.6, 3.4, .28, 7.2, {
		propId: deck.id,
		material: "wood"
	});
	const supports = [deck.id];
	const parts = [deck.id];
	for (const x of [-1.5, 1.5]) for (const z of [18.2, 23]) {
		const p = w.addProp({
			kind: "post",
			material: "wood",
			x,
			y: -.8,
			z,
			sx: .3,
			sy: 1.4,
			sz: .3,
			mass: 40,
			hp: 55,
			support: true,
			color: 3813416,
			flammable: true,
			fuel: 5
		});
		w.addBox(x, -.8, z, .3, 1.4, .3, { propId: p.id });
		supports.push(p.id);
		parts.push(p.id);
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
		indoor: false
	});
}
function human(w, faction, x, z, extra = {}) {
	const sex = w.rng();
	const stats = makeHumanStats(w, faction);
	const cloth = faction === "guard" ? 2764854 : faction === "hunter" ? 3814440 : [
		5916216,
		4864562,
		6969424,
		4076592,
		7362632
	][w.rng() * 5 | 0];
	const weapon = faction === "guard" ? w.rng() > .5 ? "spear" : "club" : faction === "hunter" ? "knife" : "fist";
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
		height: 1.58 + w.rng() * .22,
		radius: .3,
		skin: skinOf(w),
		cloth,
		accent: faction === "guard" ? 6969408 : 2761244,
		helmet: faction === "guard" && w.rng() > .4,
		sex,
		weapon,
		courage: stats.courage,
		homeX: x,
		homeZ: z,
		...extra
	});
}
function addPeople(w) {
	const marketPts = [
		[-4, -1],
		[-1, -3],
		[3, -2],
		[4, 1],
		[-3, 3],
		[1, 3.5],
		[-6, 1],
		[6, -1]
	];
	marketPts.forEach((p, i) => {
		const a = human(w, "civilian", p[0], p[1]);
		a.routine = marketPts.map(([x, z]) => ({
			x: x + (w.rng() - .5),
			z: z + (w.rng() - .5)
		}));
		a.routineI = i;
	});
	human(w, "civilian", -13.2, 5.8, { routine: [{
		x: -13.2,
		z: 5.8
	}, {
		x: -4,
		z: 1
	}] });
	human(w, "civilian", -18, -3.5);
	human(w, "civilian", -18.2, 1.4);
	human(w, "civilian", 10.5, 9);
	[
		[0, -11.2],
		[2.4, -10.4],
		[-2.2, -10.6],
		[9.2, -8],
		[4, 6],
		[-8, -8],
		[0, 12]
	].forEach(([x, z], i) => {
		const g = human(w, "guard", x, z, {
			height: 1.74,
			mass: 82,
			strength: 1.15
		});
		g.routine = [
			{
				x,
				z
			},
			{
				x: x + (i % 2 ? 6 : -5),
				z: z + 4
			},
			{
				x: 0,
				z: 0
			}
		];
	});
	const h = human(w, "hunter", -4, -20, {
		cloth: 3814440,
		weapon: "knife"
	});
	h.routine = [
		{
			x: -4,
			z: -20
		},
		{
			x: -10,
			z: -24
		},
		{
			x: 6,
			z: -18
		}
	];
}
function addBeasts(w) {
	const pen = (species, x, z, extra = {}) => w.addActor({
		kind: "beast",
		species,
		faction: "none",
		name: species,
		x,
		y: 0,
		z,
		radius: species === "cow" ? .48 : .3,
		height: species === "cow" ? 1.25 : .75,
		mass: species === "cow" ? 220 : species === "pig" ? 65 : 45,
		cloth: species === "cow" ? 5917248 : species === "pig" ? 12093568 : 10129540,
		skin: species === "cow" ? 15260872 : 13934736,
		homeX: 18,
		homeZ: -7,
		courage: .2,
		...extra
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
		[14, -24]
	]) w.addActor({
		kind: "beast",
		species: "deer",
		faction: "wild",
		name: "deer",
		x,
		y: 0,
		z,
		radius: .32,
		height: 1.15,
		mass: 55,
		cloth: 9071176,
		skin: 12886128,
		homeX: x,
		homeZ: z,
		courage: .1
	});
	const wolf = (x, z) => w.addActor({
		kind: "beast",
		species: "wolf",
		faction: "wild",
		name: "wolf",
		x,
		y: 0,
		z,
		radius: .33,
		height: .84,
		mass: 40,
		cloth: 3816e3,
		skin: 2763312,
		homeX: x,
		homeZ: z,
		courage: .55,
		aggression: .68,
		strength: 1.1
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
		radius: .7,
		height: 1.45,
		mass: 280,
		cloth: 3811872,
		skin: 2759700,
		homeX: -24,
		homeZ: -30,
		courage: .85,
		aggression: .55,
		strength: 2.2
	});
}
function addPlayer(w) {
	w.playerId = w.addActor({
		kind: "player",
		species: "human",
		faction: "player",
		name: "you",
		x: .3,
		y: 0,
		z: -24.5,
		yaw: Math.PI,
		radius: .32,
		height: 1.72,
		mass: 78,
		strength: 1.05,
		courage: .7,
		skin: 12096114,
		cloth: 2892828,
		accent: 6961192,
		weapon: "fist"
	}).id;
}
function markIndoor(w) {
	for (const b of w.buildings) {
		if (!b.indoor) continue;
		for (let x = b.minX; x < b.maxX; x += 2) for (let z = b.minZ; z < b.maxZ; z += 2) w.indoor[w.cell(x, z)] = 1;
	}
}
var CAM_FORWARD = (yaw) => facing(yaw);
var STEP_UP = .48;
function surfaceAt(w, x, z) {
	if (w.inWater(x, z, .4)) return "water";
	const i = w.cell(x, z);
	if (w.oil[i] > .3) return "oil";
	if (w.wet[i] > .55) return "mud";
	if (Math.abs(x) < 9 && Math.abs(z) < 9) return "cobble";
	if (w.indoorAt(x, z)) return "wood";
	if (z < -16) return "dirt";
	return "dirt";
}
function frictionFor(s, wet) {
	if (s === "water") return 3.2;
	if (s === "mud") return 4.6;
	if (s === "oil") return 1.1;
	if (s === "cobble") return 8 + wet * 4;
	if (s === "wood") return 7;
	return 6.5;
}
function accelFor(s) {
	if (s === "water") return 6;
	if (s === "mud") return 9;
	if (s === "oil") return 5;
	return 22;
}
function stepWorld(w, dt, input, cam, playing) {
	w.events.length = 0;
	stepClock(w, dt);
	for (const a of w.actors) {
		a.px = a.x;
		a.py = a.y;
		a.pz = a.z;
		a.pyaw = a.yaw;
	}
	for (const p of w.props) {
		p.px = p.x;
		p.py = p.y;
		p.pz = p.z;
	}
	w.rebuildHash();
	if (playing) applyPlayer(w, dt, input, cam);
	stepPerception(w, dt);
	stepAI(w, dt);
	stepCombat(w, dt, playing ? input : null);
	stepGrab(w, dt, playing ? input : null);
	stepLocomotion(w, dt);
	stepPhysics(w, dt);
	stepInjury(w, dt);
	stepFire(w, dt);
	stepProps(w, dt);
	stepStructures(w, dt);
	stepTracks(w, dt);
	cullSounds(w);
	if (w.shake > 0) w.shake = Math.max(0, w.shake - dt * 1.8);
	if (w.hitstop > 0) w.hitstop = Math.max(0, w.hitstop - dt);
}
function stepClock(w, dt) {
	w.time += dt;
	w.day = (w.day + dt / 540) % 1;
	if (w.rainTarget === 0 && w.time > 40 && w.rng() < dt * .01) {
		w.rainTarget = .45 + w.rng() * .5;
		w.whisper("Rain starts.");
	}
	if (w.rain > .6 && w.rng() < dt * .04) {
		w.thunderT = 0;
		w.shake = Math.max(w.shake, .35);
		w.emitSound(w.player().x + (w.rng() - .5) * 40, w.player().z, 1.6, "impact", 0);
	}
	w.thunderT += dt;
	w.rain += (w.rainTarget - w.rain) * (1 - Math.exp(-dt * .15));
	if (w.rain > .7 && w.rng() < dt * .02) w.windX += (w.rng() - .5) * .4;
	w.windX = clamp(w.windX, -3, 3);
	w.windZ = clamp(w.windZ + (w.rng() - .5) * dt, -2, 2);
}
function applyPlayer(w, dt, input, cam) {
	const p = w.player();
	if (!p.alive) return;
	p.crouch = input.crouch && p.loco !== "ragdoll" && p.loco !== "down";
	if (p.consciousness < .35) return;
	if (p.loco === "ragdoll" || p.loco === "down" || p.loco === "getup" || p.loco === "vault") return;
	const f = CAM_FORWARD(cam.yaw);
	const r = rightOf(cam.yaw);
	const wishX = f.x * input.moveY + r.x * input.moveX;
	const wishZ = f.z * input.moveY + r.z * input.moveX;
	const wishMag = Math.hypot(wishX, wishZ);
	p.intendX = wishMag > .05 ? wishX / wishMag : 0;
	p.intendZ = wishMag > .05 ? wishZ / wishMag : 0;
	const leg = 1 - clamp(injurySum(p.injuries.lleg) + injurySum(p.injuries.rleg), 0, 1.6) * .35;
	const load = 1 / (1 + p.carry / 90);
	const mud = surfaceAt(w, p.x, p.z) === "mud" ? .72 : 1;
	let max = p.crouch ? 1.5 : 3.45;
	if (input.sprint && p.stamina > .08 && wishMag > .2 && !p.crouch) max = 6.6;
	max *= leg * load * mud * (.55 + p.consciousness * .45) * (1 - p.fatigue * .35);
	if (p.grabbedId) max *= .72;
	p.intendSpeed = wishMag * max;
	if (wishMag > .08) {
		const ty = Math.atan2(-p.intendX, -p.intendZ);
		p.yaw = lerpAng(p.yaw, ty, 1 - Math.exp(-dt * 8));
	} else p.yaw = lerpAng(p.yaw, cam.yaw, 1 - Math.exp(-dt * 4));
	if (input.sprint && wishMag > .2 && !p.crouch) {
		p.stamina = Math.max(0, p.stamina - dt * .18);
		p.fatigue = Math.min(1, p.fatigue + dt * .04);
	} else {
		p.stamina = Math.min(1, p.stamina + dt * .14 * (p.crouch ? 1.4 : 1) * (1 - p.pain * .4));
		p.fatigue = Math.max(0, p.fatigue - dt * .03);
	}
	if (input.jumpPressed && p.grounded) {
		const front = probeHeight(w, p.x + f.x * .7, p.z + f.z * .7);
		if (front > .35 && front < 1.15 && locoSpeed(p) > 2.2) {
			p.loco = "vault";
			p.vaultT = .38;
			p.vy = 3.6;
			p.vx += f.x * 2.2;
			p.vz += f.z * 2.2;
		} else if (front > 1.15 && front < 2.4) {
			p.loco = "climb";
			p.locoT = .55;
			p.vy = 2.4;
		} else {
			p.vy = 6.2 * (.7 + p.stamina * .3) * leg;
			p.grounded = false;
			p.stamina -= .08;
		}
	}
	if (input.bandage) treat(w, p, dt);
	if (input.ignitePressed) tryIgnite(w, p);
	if (input.dropPressed) dropHeld(w, p, .5);
	if (wishMag > .22 && p.grounded && Math.hypot(p.vx, p.vz) < .1) {
		p.recovT += dt;
		if (p.recovT > .28) {
			unstickActor(w, p);
			p.recovT = 0;
		}
	} else p.recovT = 0;
}
function probeHeight(w, x, z) {
	let h = 0;
	for (const c of w.colliders) {
		if (!c.solid || c.water) continue;
		if (x > c.minX - .15 && x < c.maxX + .15 && z > c.minZ - .15 && z < c.maxZ + .15) h = Math.max(h, c.maxY);
	}
	return h;
}
function treat(w, p, dt) {
	p.intendSpeed = Math.min(p.intendSpeed, .6);
	p.bleed = Math.max(0, p.bleed - dt * .35);
	for (const r of REGIONS) {
		p.injuries[r].cut = Math.max(0, p.injuries[r].cut - dt * .12);
		p.injuries[r].puncture = Math.max(0, p.injuries[r].puncture - dt * .08);
		p.injuries[r].burn = Math.max(0, p.injuries[r].burn - dt * .06);
	}
	p.pain = Math.max(0, p.pain - dt * .2);
}
function tryIgnite(w, p) {
	const f = facing(p.yaw);
	const tx = p.x + f.x * 1.1;
	const tz = p.z + f.z * 1.1;
	if (p.weapon === "torch" || p.torchLit) {
		igniteAt(w, tx, tz, .9);
		p.torchLit = true;
		w.emitSound(tx, tz, .4, "fire", p.id);
		w.whisper("Flame catches.");
		return;
	}
	const i = w.cell(tx, tz);
	if (w.burning[i]) {
		w.burning[i] = 0;
		w.heat[i] *= .2;
		w.wet[i] = Math.min(1, w.wet[i] + .5);
		w.whisper("You smother the fire.");
	}
}
function dropHeld(w, p, throwMul) {
	if (p.grabbedId) {
		const t = w.actor(p.grabbedId) || w.prop(p.grabbedId);
		if (t && "mass" in t) {
			const f = facing(p.yaw);
			const spd = 4.5 * throwMul * (p.mass / (p.mass + t.mass));
			if ("species" in t) {
				const a = t;
				a.grabbedBy = 0;
				a.vx += f.x * spd + p.vx;
				a.vz += f.z * spd + p.vz;
				a.vy += 2.4 * throwMul;
				a.loco = "ragdoll";
				a.locoT = .8;
				a.balance = 0;
			} else {
				const pr = t;
				pr.heldBy = 0;
				pr.dynamic = true;
				pr.anchored = false;
				pr.vx += f.x * spd * 1.4 + p.vx;
				pr.vz += f.z * spd * 1.4 + p.vz;
				pr.vy += 3 * throwMul;
			}
		}
		p.grabbedId = 0;
		p.carry = 0;
		w.emitSound(p.x, p.z, .5, "whoosh", p.id);
		return;
	}
}
function stepPerception(w, dt) {
	const hour = w.day;
	const light = hour > .25 && hour < .75 ? 1 : hour > .2 && hour < .8 ? .45 : .18;
	for (const a of w.actors) {
		if (a.kind === "player" || !a.alive) continue;
		a.alert = Math.max(0, a.alert - dt * .08);
		a.shoutCd = Math.max(0, a.shoutCd - dt);
		const visRange = (a.species === "wolf" ? 22 : a.species === "deer" ? 18 : a.species === "bear" ? 16 : 16) * (.45 + light * .55) * (1 - w.rain * .25);
		const hearMul = 1 - w.rain * .2;
		for (const s of w.sounds) {
			if (w.time - s.t > .25) continue;
			const d = Math.hypot(s.x - a.x, s.z - a.z);
			const reach = s.mag * 22 * hearMul;
			if (d < reach) {
				w.addMemory(a, "sound", s.x, s.z, s.who, clamp(1 - d / reach, .2, 1));
				if (s.kind === "scream" || s.kind === "collapse" || s.kind === "weapon") a.alert = Math.min(1, a.alert + .4);
				if (s.kind === "scream") a.fear = Math.min(1, a.fear + .2 * (1 - a.courage));
			}
		}
		const others = w.nearby(a.x, a.z, visRange);
		for (const o of others) {
			if (o.id === a.id) continue;
			const dx = o.x - a.x;
			const dz = o.z - a.z;
			const d = Math.hypot(dx, dz);
			const f = facing(a.yaw);
			const dot = d > .01 ? (dx * f.x + dz * f.z) / d : 1;
			if (dot < (a.species === "deer" ? .15 : .32) && d > 2.2) continue;
			const smoke = w.smoke[w.cell(o.x, o.z)] + w.smoke[w.cell((a.x + o.x) * .5, (a.z + o.z) * .5)];
			let chance = (1 - d / visRange) * (.4 + dot) * (o.crouch ? .45 : 1) * (o.loco === "sprint" ? 1.2 : 1);
			chance *= 1 - Math.min(.8, smoke * .5);
			chance *= 1 - (o.loco === "idle" && o.crouch ? .5 : 0);
			if (w.indoorAt(o.x, o.z) && !w.indoorAt(a.x, a.z)) chance *= .45;
			if (chance < .12) continue;
			if (!canSeeThrough(w, a.x, a.z, o.x, o.z) && d > 3) continue;
			if (isThreat(a, o, w)) {
				a.lastSeenX = o.x;
				a.lastSeenZ = o.z;
				a.lastSeenT = w.time;
				a.targetId = o.id;
				a.alert = 1;
				w.addMemory(a, "threat", o.x, o.z, o.id, 1);
				if (!a.known.includes(o.id)) a.known.push(o.id);
			}
			if (!o.alive) {
				w.addMemory(a, "body", o.x, o.z, o.id, 1);
				a.fear = Math.min(1, a.fear + .25 * (1 - a.courage));
			}
		}
		for (let i = 0; i < w.burning.length; i++) {
			if (!w.burning[i]) continue;
			const p = w.ixz(i);
			if (dist2(a.x, a.z, p.x, p.z) < 324) {
				w.addMemory(a, "fire", p.x, p.z, 0, .8);
				if (dist2(a.x, a.z, p.x, p.z) < 36) a.fear = Math.min(1, a.fear + dt * .4);
			}
		}
		for (const m of a.memories) m.certainty *= 1 - dt * .05;
		a.memories = a.memories.filter((m) => m.certainty > .08 && w.time - m.t < 90);
	}
}
function isThreat(a, o, w) {
	if (!o.alive) return false;
	if (a.known.includes(o.id)) return true;
	if (o.kind === "player") {
		if (a.faction === "guard" && (w.wanted > .15 || o.weapon !== "fist" && w.wanted > 0)) return true;
		if (a.species === "wolf" || a.species === "bear") {
			if (o.bleed > .15 || o.blood < .85) return true;
			if (a.species === "bear" && dist2(a.x, a.z, o.x, o.z) < 36) return a.aggression > .3;
		}
		if (a.faction === "civilian" && (o.strikeT > 0 || o.weapon !== "fist") && dist2(a.x, a.z, o.x, o.z) < 25) return true;
	}
	if (a.species === "wolf" && (o.species === "deer" || o.species === "goat" || o.species === "pig" || o.species === "cow")) return true;
	if (a.species === "bear" && (o.species === "deer" || o.species === "pig" || o.species === "cow" || o.kind === "human")) return dist2(a.x, a.z, o.x, o.z) < 80;
	if (a.species === "deer" && (o.kind === "human" || o.kind === "player" || o.species === "wolf" || o.species === "bear")) return true;
	if (a.faction === "guard" && o.faction === "wild" && o.species !== "deer") return true;
	if (o.lastHitBy === a.id) return false;
	if (a.lastHitBy === o.id && w.time - a.lastHitT < 20) return true;
	return false;
}
function stepAI(w, dt) {
	for (const a of w.actors) {
		if (a.kind === "player" || !a.alive) continue;
		if (a.loco === "ragdoll" || a.loco === "down" || a.loco === "getup" || a.grabbedBy) {
			a.intendSpeed = 0;
			continue;
		}
		a.aiT -= dt;
		a.fear = clamp(a.fear - dt * .05, 0, 1);
		const nearbyFire = closestFire(w, a.x, a.z);
		if (nearbyFire && nearbyFire.d < 3.2) {
			const dx = a.x - nearbyFire.x;
			const dz = a.z - nearbyFire.z;
			const m = Math.hypot(dx, dz) || 1;
			a.intendX = dx / m;
			a.intendZ = dz / m;
			a.intendSpeed = 5;
			a.ai = "flee";
			continue;
		}
		if (a.species !== "human") {
			beastAI(w, a, dt);
			continue;
		}
		humanAI(w, a, dt, nearbyFire);
	}
}
function closestFire(w, x, z) {
	let best = 99;
	let bx = 0;
	let bz = 0;
	for (let i = 0; i < w.burning.length; i++) {
		if (!w.burning[i]) continue;
		const p = w.ixz(i);
		const d = Math.hypot(p.x - x, p.z - z);
		if (d < best) {
			best = d;
			bx = p.x;
			bz = p.z;
		}
	}
	if (best > 28) return null;
	return {
		x: bx,
		z: bz,
		d: best
	};
}
function seek(a, x, z, speed) {
	const dx = x - a.x;
	const dz = z - a.z;
	const m = Math.hypot(dx, dz);
	if (m < .4) {
		a.intendSpeed = 0;
		return m;
	}
	a.intendX = dx / m;
	a.intendZ = dz / m;
	a.intendSpeed = speed;
	a.yaw = lerpAng(a.yaw, Math.atan2(-a.intendX, -a.intendZ), .25);
	return m;
}
function humanAI(w, a, dt, fire) {
	const player = w.player();
	const seesPlayer = a.targetId === player.id && w.time - a.lastSeenT < .6;
	const hostile = a.known.includes(player.id) || a.faction === "guard" && w.wanted > .2;
	if (a.fear > .55 + a.courage * .35 && a.faction !== "guard") {
		a.ai = "flee";
		const awayX = a.x - player.x;
		const awayZ = a.z - player.z;
		const m = Math.hypot(awayX, awayZ) || 1;
		seek(a, a.x + awayX / m * 10, a.z + awayZ / m * 10, 5.4);
		if (a.shoutCd <= 0) {
			w.emitSound(a.x, a.z, .9, "scream", a.id);
			a.shoutCd = 2.4;
			spreadFear(w, a);
		}
		return;
	}
	if (fire && fire.d < 7 && a.faction !== "guard" && a.courage < .7) {
		a.ai = "flee";
		seek(a, a.x + (a.x - fire.x), a.z + (a.z - fire.z), 4.5);
		return;
	}
	if (fire && fire.d < 5 && a.faction === "guard" && a.courage > .5) {
		a.ai = "extinguish";
		if (seek(a, fire.x, fire.z, 3.5) < 1.6) {
			const i = w.cell(fire.x, fire.z);
			w.heat[i] *= .85;
			w.wet[i] = Math.min(1, w.wet[i] + dt * .8);
			if (w.heat[i] < .3) w.burning[i] = 0;
		}
		return;
	}
	if (a.faction === "guard" && hostile) {
		if (seesPlayer) {
			a.ai = "combat";
			const d = Math.hypot(player.x - a.x, player.z - a.z);
			if (d > 1.5) seek(a, player.x, player.z, 5.2);
			else a.intendSpeed = .4;
			a.targetId = player.id;
			if (a.shoutCd <= 0) {
				w.emitSound(a.x, a.z, 1, "shout", a.id);
				a.shoutCd = 3;
				callAllies(w, a, player);
			}
			if (d < WEAPON_STATS[a.weapon].reach + .4 && a.attackCd <= 0) {
				a.strikeT = .32;
				a.strikeCd = .7 / (.7 + a.competence);
				a.strikeHit = 0;
				a.attackCd = a.strikeCd;
			}
			return;
		}
		if (w.time - a.lastSeenT < 8) {
			a.ai = "pursue";
			if (seek(a, a.lastSeenX, a.lastSeenZ, 5.4) < 1.2) {
				a.ai = "search";
				a.searchT = 7;
				pickSearch(w, a);
			}
			return;
		}
		if (a.ai === "search" || a.searchT > 0) {
			a.searchT -= dt;
			a.ai = "search";
			if (seek(a, a.searchX, a.searchZ, 3.2) < 1 || a.aiT <= 0) pickSearch(w, a);
			followTracks(w, a);
			if (a.searchT <= 0) a.ai = "wander";
			return;
		}
	}
	if (a.faction === "guard" && a.alert > .4) {
		const mem = a.memories.find((m) => m.kind === "threat" || m.kind === "sound");
		if (mem) {
			a.ai = "investigate";
			seek(a, mem.x, mem.z, 3.6);
			return;
		}
	}
	const ally = w.nearby(a.x, a.z, 8).find((o) => o.faction === a.faction && o.alive && o.blood < .55 && o.id !== a.id);
	if (ally && a.loyalty > .45 && a.fear < .6) {
		a.ai = "rescue";
		if (seek(a, ally.x, ally.z, 3.8) < 1.2 && a.grabbedId === 0) {
			a.grabbedId = ally.id;
			ally.grabbedBy = a.id;
			a.carry = ally.mass * .5;
		}
		if (a.grabbedId === ally.id) seek(a, a.homeX, a.homeZ, 2.4);
		return;
	}
	if (a.routine.length) {
		a.ai = "work";
		const wp = a.routine[a.routineI % a.routine.length];
		if (seek(a, wp.x, wp.z, 1.7) < .8) {
			a.routineI++;
			a.intendSpeed = 0;
			a.aiT = 1 + w.rng() * 2;
		}
		return;
	}
	a.ai = "wander";
	if (a.aiT <= 0) {
		a.wayX = a.homeX + (w.rng() - .5) * 10;
		a.wayZ = a.homeZ + (w.rng() - .5) * 10;
		a.aiT = 3 + w.rng() * 4;
	}
	seek(a, a.wayX, a.wayZ, 1.5);
}
function pickSearch(w, a) {
	const ang = w.rng() * Math.PI * 2;
	const r = 3 + w.rng() * 7;
	a.searchX = a.lastSeenX + Math.cos(ang) * r;
	a.searchZ = a.lastSeenZ + Math.sin(ang) * r;
	a.aiT = 2 + w.rng() * 2;
}
function followTracks(w, a) {
	let best = null;
	let bd = 9;
	for (const t of w.tracks) {
		if (w.time - t.t > 25) continue;
		const d = Math.hypot(t.x - a.x, t.z - a.z);
		if (d < bd && t.actorId === w.playerId) {
			bd = d;
			best = t;
		}
	}
	if (best) {
		a.searchX = best.x + Math.cos(best.heading) * 2;
		a.searchZ = best.z + Math.sin(best.heading) * 2;
	}
}
function callAllies(w, a, player) {
	for (const o of w.nearby(a.x, a.z, 22)) {
		if (o.faction !== a.faction || o.id === a.id) continue;
		w.addMemory(o, "threat", player.x, player.z, player.id, .7);
		if (!o.known.includes(player.id)) o.known.push(player.id);
		o.alert = Math.max(o.alert, .8);
		o.lastSeenX = a.lastSeenX;
		o.lastSeenZ = a.lastSeenZ;
		o.lastSeenT = w.time;
	}
	w.wanted = Math.min(1, w.wanted + .25);
	w.whisper("A shout carries.");
}
function spreadFear(w, a) {
	for (const o of w.nearby(a.x, a.z, 12)) {
		if (o.id === a.id || o.kind === "player") continue;
		o.fear = Math.min(1, o.fear + .2 * (1 - o.courage));
	}
}
function beastAI(w, a, _dt) {
	if (a.species === "deer" || a.species === "goat" || a.species === "pig" || a.species === "cow") {
		const threat = w.nearby(a.x, a.z, a.species === "deer" ? 14 : 8).find((o) => {
			if (o.id === a.id || !o.alive) return false;
			return o.kind === "player" || o.kind === "human" || o.species === "wolf" || o.species === "bear" || o.strikeT > 0;
		});
		const fire = closestFire(w, a.x, a.z);
		if (threat || fire && fire.d < 8 || a.fear > .4) {
			a.ai = "flee";
			a.fear = Math.min(1, a.fear + .3);
			const tx = threat ? threat.x : fire ? fire.x : a.x;
			const tz = threat ? threat.z : fire ? fire.z : a.z;
			seek(a, a.x + (a.x - tx) * 2, a.z + (a.z - tz) * 2, a.species === "cow" ? 4.2 : 6.5);
			if (a.species !== "deer" && a.shoutCd <= 0) {
				w.emitSound(a.x, a.z, .7, "animal", a.id);
				a.shoutCd = 1.6;
			}
			if (a.species !== "deer") breakFence(w, a);
			return;
		}
		a.ai = "graze";
		if (a.aiT <= 0) {
			a.wayX = a.homeX + (w.rng() - .5) * (a.species === "deer" ? 16 : 5);
			a.wayZ = a.homeZ + (w.rng() - .5) * (a.species === "deer" ? 16 : 5);
			a.aiT = 2 + w.rng() * 4;
		}
		seek(a, a.wayX, a.wayZ, 1.1);
		return;
	}
	if (a.species === "wolf") {
		const prey = w.nearby(a.x, a.z, 24).filter((o) => o.alive && o.id !== a.id && (o.species === "deer" || o.species === "goat" || o.species === "pig" || o.kind === "player" && (o.blood < .85 || o.bleed > .1))).sort((b, c) => dist2(a.x, a.z, b.x, b.z) - dist2(a.x, a.z, c.x, c.z))[0];
		if (prey) {
			a.ai = "hunt";
			a.targetId = prey.id;
			if (seek(a, prey.x, prey.z, 6.4) < 1.3 && a.attackCd <= 0) {
				a.strikeT = .28;
				a.strikeHit = 0;
				a.attackCd = .8;
			}
			return;
		}
		a.ai = "wander";
		if (a.aiT <= 0) {
			a.wayX = a.homeX + (w.rng() - .5) * 18;
			a.wayZ = a.homeZ + (w.rng() - .5) * 18;
			a.aiT = 4;
		}
		seek(a, a.wayX, a.wayZ, 2.4);
		return;
	}
	if (a.species === "bear") {
		const close = w.nearby(a.x, a.z, 16).filter((o) => o.alive && o.id !== a.id && (o.kind === "player" || o.kind === "human" || o.species === "cow" || o.species === "pig")).sort((b, c) => dist2(a.x, a.z, b.x, b.z) - dist2(a.x, a.z, c.x, c.z))[0];
		if (close && (a.aggression > .3 || close.bleed > 0 || dist2(a.x, a.z, close.x, close.z) < 25)) {
			a.ai = "hunt";
			a.targetId = close.id;
			if (seek(a, close.x, close.z, 5.6) < 2 && a.attackCd <= 0) {
				a.strikeT = .4;
				a.strikeHit = 0;
				a.attackCd = 1.1;
				w.emitSound(a.x, a.z, 1.1, "animal", a.id);
			}
			return;
		}
		if (a.aiT <= 0) {
			a.wayX = a.homeX + (w.rng() - .5) * 20;
			a.wayZ = a.homeZ + (w.rng() - .5) * 14;
			a.aiT = 5;
		}
		seek(a, a.wayX, a.wayZ, 1.8);
	}
}
function breakFence(w, a) {
	for (const p of w.props) {
		if (p.kind !== "fence" && p.kind !== "gate") continue;
		if (dist2(a.x, a.z, p.x, p.z) > 2.2) continue;
		p.hp -= 12 * (a.mass / 80);
		if (p.hp <= 0 && !p.collapsed) collapseProp(w, p, a.vx, a.vz);
	}
}
function stepCombat(w, dt, input) {
	const p = w.player();
	if (input && p.alive && p.consciousness > .4) {
		if (input.attackPressed && p.strikeCd <= 0 && p.loco !== "ragdoll") {
			p.strikeT = .3 / WEAPON_STATS[p.weapon].speed;
			p.strikeCd = .42 / WEAPON_STATS[p.weapon].speed;
			p.strikeHit = 0;
			p.stamina = Math.max(0, p.stamina - .06);
			w.emitSound(p.x, p.z, .35, "weapon", p.id);
		}
		if (input.kickPressed && p.kickT <= 0 && p.grounded) {
			p.kickT = .28;
			w.emitSound(p.x, p.z, .3, "whoosh", p.id);
		}
		if (input.shovePressed) p.shoveT = .22;
	}
	for (const a of w.actors) {
		a.strikeCd = Math.max(0, a.strikeCd - dt);
		a.attackCd = Math.max(0, a.attackCd - dt);
		if (a.strikeT > 0) {
			a.strikeT -= dt;
			const st = WEAPON_STATS[a.weapon] ?? WEAPON_STATS.fist;
			if (a.strikeT < .18 && a.strikeT > .04) {
				const f = facing(a.yaw);
				const reach = st.reach * (a.species === "bear" ? 1.6 : 1);
				for (const o of w.nearby(a.x, a.z, reach + .6)) {
					if (o.id === a.id || !o.alive) continue;
					if (a.strikeHit & 1 << o.id % 30) continue;
					const dx = o.x - a.x;
					const dz = o.z - a.z;
					const d = Math.hypot(dx, dz);
					if (d > reach + o.radius) continue;
					if ((d > 0 ? (dx * f.x + dz * f.z) / d : 1) < .25) continue;
					a.strikeHit |= 1 << o.id % 30;
					hitActor(w, a, o, st, Math.hypot(a.vx, a.vz) + 2.2, "strike");
				}
				for (const pr of w.props) {
					if (pr.collapsed || pr.heldBy) continue;
					if (dist2(a.x + f.x * .8, a.z + f.z * .8, pr.x, pr.z) > 1.6) continue;
					damageProp(w, pr, 8 + st.blunt * 14, a.vx + f.x * 3, a.vz + f.z * 3, a);
				}
			}
		}
		if (a.kickT > 0) {
			a.kickT -= dt;
			if (a.kickT < .16 && a.kickT > .08) {
				const f = facing(a.yaw);
				for (const o of w.nearby(a.x, a.z, 1.4)) {
					if (o.id === a.id) continue;
					const dx = o.x - a.x;
					const dz = o.z - a.z;
					if (dx * f.x + dz * f.z < 0) continue;
					hitActor(w, a, o, {
						...WEAPON_STATS.fist,
						blunt: 1.1,
						reach: 1.1
					}, 3, "kick");
					o.injuries.lleg.sprain += .15;
					o.vy += .6;
				}
			}
		}
		if (a.shoveT > 0) {
			a.shoveT -= dt;
			if (a.shoveT < .16) {
				const f = facing(a.yaw);
				for (const o of w.nearby(a.x, a.z, 1.25)) {
					if (o.id === a.id) continue;
					const rel = a.mass / (a.mass + o.mass);
					o.vx += f.x * 5.5 * rel;
					o.vz += f.z * 5.5 * rel;
					o.balance -= .45 * rel;
					if (o.balance < .25) {
						o.loco = "stumble";
						o.locoT = .4;
					}
				}
			}
		}
	}
}
function hitActor(w, atk, vic, st, speed, how) {
	const f = facing(atk.yaw);
	const rel = atk.mass / (atk.mass + vic.mass);
	const force = (.6 + speed * .25) * (.7 + st.mass * .25) * (.8 + atk.strength * .4);
	vic.vx += f.x * force * 3.2 * rel;
	vic.vz += f.z * force * 3.2 * rel;
	vic.balance -= .35 + st.blunt * .35 * rel;
	const side = rightOf(atk.yaw).x * (vic.x - atk.x) + rightOf(atk.yaw).z * (vic.z - atk.z);
	const region = how === "kick" ? Math.random() < .5 ? "lleg" : "rleg" : regionFromHit(1.1 + Math.random() * .5, side);
	const inj = vic.injuries[region];
	inj.bruise += st.blunt * .28 * force;
	inj.cut += st.cut * .32 * force;
	inj.puncture += st.pierce * .3 * force;
	if (st.fire > 0 || atk.torchLit) {
		inj.burn += .25;
		igniteAt(w, vic.x, vic.z, .35);
	}
	if (st.cut + st.pierce > .4) vic.bleed += .08 + st.cut * .08;
	if (region === "head") {
		vic.consciousness -= .18 * force;
		inj.bruise += .2;
	}
	if (st.blunt > 1 && region === "head") inj.fracture += .12;
	vic.pain = clamp(vic.pain + .2 * force, 0, 1);
	vic.lastHitBy = atk.id;
	vic.lastHitT = w.time;
	if (!vic.known.includes(atk.id) && vic.kind !== "player") vic.known.push(atk.id);
	if (atk.kind === "player" && vic.faction === "guard") w.wanted = Math.min(1, w.wanted + .35);
	if (atk.kind === "player" && vic.faction === "civilian") w.wanted = Math.min(1, w.wanted + .2);
	vic.alert = 1;
	if (vic.balance < .15 || force > 1.6) {
		vic.loco = "ragdoll";
		vic.locoT = .7 + (1 - vic.balance);
		vic.vy += 1.2 * rel;
	} else if (vic.balance < .45) {
		vic.loco = "stumble";
		vic.locoT = .45;
	}
	w.emitSound(vic.x, vic.z, .55 + force * .2, "impact", atk.id);
	if (vic.kind === "human" || vic.kind === "player") {
		if (vic.pain > .5 && Math.random() < .5) w.emitSound(vic.x, vic.z, .7, "scream", vic.id);
		else w.emitSound(vic.x, vic.z, .4, "hurt", vic.id);
	}
	w.shake = Math.max(w.shake, .18 + force * .12);
	w.hitstop = Math.max(w.hitstop, .04);
	if (atk.kind === "player") w.hitstop = .055;
}
function stepGrab(w, dt, input) {
	const p = w.player();
	if (input && p.alive) {
		if (input.grabPressed && !p.grabbedId && p.loco !== "ragdoll") {
			const f = facing(p.yaw);
			let best = null;
			let bd = 1.7;
			for (const o of w.nearby(p.x, p.z, 1.8)) {
				if (o.id === p.id) continue;
				const dx = o.x - p.x;
				const dz = o.z - p.z;
				const d = Math.hypot(dx, dz);
				if ((dx * f.x + dz * f.z) / (d || 1) < .1) continue;
				if (d < bd) {
					bd = d;
					best = o;
				}
			}
			for (const pr of w.props) {
				if (pr.anchored && pr.mass > 40 && !pr.dynamic) continue;
				if (pr.kind === "wall" || pr.kind === "roof") continue;
				const d = Math.hypot(pr.x - p.x, pr.z - p.z);
				const dx = pr.x - p.x;
				const dz = pr.z - p.z;
				if ((dx * f.x + dz * f.z) / (d || 1) < .05 || d > 1.7) continue;
				if (d < bd) {
					bd = d;
					best = pr;
				}
			}
			if (best) {
				p.grabbedId = best.id;
				if ("species" in best) {
					const a = best;
					if (p.mass / (p.mass + a.mass) < .38 && a.balance > .6 && a.grounded) {
						a.balance -= .3;
						p.grabbedId = 0;
						w.emitSound(p.x, p.z, .3, "grab", p.id);
					} else {
						a.grabbedBy = p.id;
						p.carry = a.mass * .45;
						w.emitSound(p.x, p.z, .4, "grab", p.id);
					}
				} else {
					const pr = best;
					pr.heldBy = p.id;
					pr.dynamic = true;
					pr.anchored = false;
					p.carry = pr.mass;
					if (pr.weapon) p.weapon = pr.weapon;
					if (pr.kind === "lamp") p.weapon = "torch";
					if (pr.kind === "board") p.weapon = "board";
					w.emitSound(p.x, p.z, .3, "grab", p.id);
				}
			}
		}
		if (input.grabReleased && p.grabbedId) dropHeld(w, p, clamp((7 + Math.hypot(p.vx, p.vz)) / 6, .8, 1.8));
	}
	for (const a of w.actors) {
		if (!a.grabbedId) continue;
		const t = w.actor(a.grabbedId);
		const pr = t ? null : w.prop(a.grabbedId);
		const f = facing(a.yaw);
		if (t) {
			t.x = a.x + f.x * .55;
			t.z = a.z + f.z * .55;
			t.y = a.y + (a.loco === "ragdoll" ? .2 : .15);
			t.vx = a.vx;
			t.vz = a.vz;
			t.vy = a.vy;
			t.yaw = a.yaw;
			if (!t.alive) a.carry = t.mass * .7;
		} else if (pr) {
			pr.x = a.x + f.x * .5;
			pr.z = a.z + f.z * .5;
			pr.y = a.y + a.height * .55;
			pr.vx = a.vx;
			pr.vz = a.vz;
			pr.yaw = a.yaw;
		} else {
			a.grabbedId = 0;
			a.carry = 0;
		}
	}
}
function stepLocomotion(w, dt) {
	for (const a of w.actors) {
		if (a.grabbedBy) continue;
		if (a.vaultT > 0) {
			a.vaultT -= dt;
			if (a.vaultT <= 0) a.loco = "idle";
		}
		if (a.loco === "climb") {
			a.locoT -= dt;
			if (a.locoT <= 0) a.loco = "idle";
		}
		if (a.loco === "getup") {
			a.getupT -= dt;
			a.intendSpeed = 0;
			if (a.getupT <= 0) {
				a.loco = "idle";
				a.balance = .6;
			}
			continue;
		}
		if (a.loco === "ragdoll") {
			a.locoT -= dt;
			if (a.grounded && Math.hypot(a.vx, a.vz) < .7 && a.locoT <= 0 && a.consciousness > .25 && a.alive) {
				a.loco = "getup";
				a.getupT = .7 + (1 - a.consciousness) * .6;
			}
			continue;
		}
		if (a.loco === "stumble") {
			a.locoT -= dt;
			a.intendSpeed *= .4;
			if (a.locoT <= 0) a.loco = "idle";
		}
		if (a.loco === "down") {
			a.intendSpeed = 0;
			continue;
		}
		const spd = a.intendSpeed;
		if (spd > 5.2) a.loco = "sprint";
		else if (spd > 3.2) a.loco = "run";
		else if (spd > .4) a.loco = a.crouch ? "crouch" : "walk";
		else a.loco = a.crouch ? "crouch" : "idle";
		if (a.y < -.05 && w.inWater(a.x, a.z, a.y + .4)) a.loco = "swim";
		a.walkPhase += Math.hypot(a.vx, a.vz) * dt * 2.4;
	}
}
function stepPhysics(w, dt) {
	for (const a of w.actors) {
		if (a.grabbedBy) continue;
		const surf = surfaceAt(w, a.x, a.z);
		const water = w.inWater(a.x, a.z, a.y + .5);
		const fr = frictionFor(surf, w.wet[w.cell(a.x, a.z)]);
		const acc = accelFor(surf);
		if (a.loco !== "ragdoll") {
			const wishX = a.intendX * a.intendSpeed;
			const wishZ = a.intendZ * a.intendSpeed;
			a.vx += (wishX - a.vx) * (1 - Math.exp(-dt * acc * .25));
			a.vz += (wishZ - a.vz) * (1 - Math.exp(-dt * acc * .25));
			if (a.intendSpeed < .1) {
				a.vx *= Math.exp(-dt * fr);
				a.vz *= Math.exp(-dt * fr);
			}
		} else {
			a.vx *= Math.exp(-dt * (fr * .4));
			a.vz *= Math.exp(-dt * (fr * .4));
		}
		if (water) {
			a.vx *= Math.exp(-dt * 3.5);
			a.vz *= Math.exp(-dt * 3.5);
			a.wet = Math.min(1, a.wet + dt * 1.5);
			if (a.y < water.maxY - .35) {
				a.submerged += dt;
				a.breath = Math.max(0, a.breath - dt * .35);
				a.vy += 4 * dt;
			} else {
				a.submerged = Math.max(0, a.submerged - dt);
				a.breath = Math.min(1, a.breath + dt * .4);
			}
		} else {
			a.submerged = 0;
			a.breath = Math.min(1, a.breath + dt * .5);
			a.wet = Math.max(0, a.wet - dt * .05);
		}
		a.vy -= 24 * dt * (water ? .35 : 1);
		integrateActor(w, a, dt);
		a.balance = clamp(a.balance + dt * .55, 0, 1);
		if (Math.hypot(a.vx, a.vz) > 4.5 && surf === "mud") {
			a.balance -= dt * .2;
			if (a.balance < .2 && a.loco !== "ragdoll") {
				a.loco = "stumble";
				a.locoT = .35;
			}
		}
	}
	separateBodies(w);
	for (const a of w.actors) {
		if (a.grabbedBy) continue;
		collideXZ(w, a);
	}
	for (const p of w.props) {
		if (p.heldBy || !p.dynamic && p.anchored) continue;
		p.vy -= 24 * dt;
		p.vx *= Math.exp(-dt * 1.8);
		p.vz *= Math.exp(-dt * 1.8);
		p.x += p.vx * dt;
		p.y += p.vy * dt;
		p.z += p.vz * dt;
		resolveProp(w, p);
		if (p.y < .02 && Math.abs(p.vy) > 2.5) {
			w.emitSound(p.x, p.z, .4 + Math.min(1, Math.abs(p.vy) * .1), p.material === "wood" ? "wood" : "impact", 0);
			if (p.kind === "lamp" || p.oil) {
				spillOil(w, p);
				if (p.kind === "lamp") igniteAt(w, p.x, p.z, .8);
			}
			p.vy *= -.15;
		}
		if (p.y < 0) {
			p.y = 0;
			p.vy = 0;
		}
	}
}
function integrateActor(w, a, dt) {
	const steps = 1 + Math.hypot(a.vx, a.vz, a.vy) * dt / .25 | 0;
	const sdt = dt / steps;
	for (let i = 0; i < steps; i++) {
		a.x += a.vx * sdt;
		a.z += a.vz * sdt;
		collideXZ(w, a);
		a.y += a.vy * sdt;
		collideY(w, a);
	}
	a.x = clamp(a.x, -43, 43);
	a.z = clamp(a.z, -43, 43);
	if (solidOverlap(w, a.x, a.z, a.y, a.height, a.radius * .92)) unstickActor(w, a);
}
function canStepOn(a, c) {
	const rise = c.maxY - a.y;
	return a.grounded && rise > .04 && rise <= STEP_UP && c.maxY - c.minY < 1.25;
}
function torsoOverlapsY(a, c) {
	const y0 = a.y + .12;
	return !(a.y + a.height * .88 < c.minY + .02 || y0 > c.maxY - .02);
}
function resolveCircleAABB(a, c, r) {
	const closestX = clamp(a.x, c.minX, c.maxX);
	const closestZ = clamp(a.z, c.minZ, c.maxZ);
	const dx = a.x - closestX;
	const dz = a.z - closestZ;
	const d2 = dx * dx + dz * dz;
	if (d2 > r * r && d2 > 1e-8) return false;
	if (d2 < 1e-8) {
		const left = a.x - c.minX;
		const right = c.maxX - a.x;
		const south = a.z - c.minZ;
		const north = c.maxZ - a.z;
		const m = Math.min(left, right, south, north);
		if (m === left) {
			a.x = c.minX - r;
			if (a.vx > 0) a.vx = 0;
		} else if (m === right) {
			a.x = c.maxX + r;
			if (a.vx < 0) a.vx = 0;
		} else if (m === south) {
			a.z = c.minZ - r;
			if (a.vz > 0) a.vz = 0;
		} else {
			a.z = c.maxZ + r;
			if (a.vz < 0) a.vz = 0;
		}
		return true;
	}
	const d = Math.sqrt(d2);
	const pen = r - d;
	const nx = dx / d;
	const nz = dz / d;
	a.x += nx * pen;
	a.z += nz * pen;
	const vn = a.vx * nx + a.vz * nz;
	if (vn < 0) {
		a.vx -= vn * nx;
		a.vz -= vn * nz;
	}
	return true;
}
function collideXZ(w, a) {
	const r = a.radius;
	for (let pass = 0; pass < 3; pass++) {
		let hit = false;
		for (const c of w.colliders) {
			if (!c.solid || c.water) continue;
			if (!torsoOverlapsY(a, c)) continue;
			if (canStepOn(a, c)) continue;
			if (resolveCircleAABB(a, c, r)) hit = true;
		}
		if (!hit) break;
	}
}
function collideY(w, a) {
	a.grounded = false;
	for (const c of w.colliders) {
		if (!c.solid || c.water) continue;
		const r = a.radius * .85;
		if (a.x + r < c.minX || a.x - r > c.maxX || a.z + r < c.minZ || a.z - r > c.maxZ) continue;
		if (a.vy <= 0 && a.y >= c.maxY - STEP_UP && a.y <= c.maxY + .12) {
			a.y = c.maxY;
			a.vy = 0;
			a.grounded = true;
		} else if (a.vy > 0 && a.y + a.height > c.minY && a.y < c.minY) {
			a.y = c.minY - a.height;
			a.vy = 0;
		}
	}
	if (a.y <= 0) {
		a.y = 0;
		a.vy = 0;
		a.grounded = true;
	}
}
function solidOverlap(w, x, z, y, height, r) {
	const y0 = y + .12;
	const y1 = y + height * .88;
	for (const c of w.colliders) {
		if (!c.solid || c.water) continue;
		if (y1 < c.minY + .02 || y0 > c.maxY - .02) continue;
		const cx = clamp(x, c.minX, c.maxX);
		const cz = clamp(z, c.minZ, c.maxZ);
		const dx = x - cx;
		const dz = z - cz;
		if (dx * dx + dz * dz < r * r) return true;
	}
	return false;
}
function unstickActor(w, a) {
	if (!solidOverlap(w, a.x, a.z, a.y, a.height, a.radius * .9)) return false;
	const dirs = [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
		[.7, .7],
		[-.7, .7],
		[.7, -.7],
		[-.7, -.7]
	];
	for (let dist = .4; dist <= 2.4; dist += .35) for (const [dx, dz] of dirs) {
		const nx = a.x + dx * dist;
		const nz = a.z + dz * dist;
		if (!solidOverlap(w, nx, nz, a.y, a.height, a.radius)) {
			a.x = nx;
			a.z = nz;
			a.vx = 0;
			a.vz = 0;
			return true;
		}
	}
	a.y = Math.max(a.y, .05);
	a.x += .6;
	a.z += .6;
	a.vx = a.vz = 0;
	return true;
}
function separateBodies(w) {
	const n = w.actors.length;
	for (let i = 0; i < n; i++) {
		const a = w.actors[i];
		if (!a.alive && a.loco === "down") continue;
		for (let j = i + 1; j < n; j++) {
			const b = w.actors[j];
			if (a.grabbedId === b.id || b.grabbedId === a.id) continue;
			const dx = b.x - a.x;
			const dz = b.z - a.z;
			const min = a.radius + b.radius;
			const d2 = dx * dx + dz * dz;
			if (d2 > min * min || d2 < 1e-6) continue;
			const d = Math.sqrt(d2);
			const pen = min - d;
			const nx = dx / d;
			const nz = dz / d;
			const invA = a.grabbedBy ? 0 : 1 / a.mass;
			const invB = b.grabbedBy ? 0 : 1 / b.mass;
			const s = invA + invB || 1;
			a.x -= nx * pen * (invA / s);
			a.z -= nz * pen * (invA / s);
			b.x += nx * pen * (invB / s);
			b.z += nz * pen * (invB / s);
			const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
			if (rel < 0) {
				const jimp = rel * .4;
				a.vx += jimp * nx;
				a.vz += jimp * nz;
				b.vx -= jimp * nx;
				b.vz -= jimp * nz;
			}
		}
	}
}
function resolveProp(w, p) {
	for (const c of w.colliders) {
		if (!c.solid || c.water || c.propId === p.id) continue;
		if (p.x < c.minX - p.sx || p.x > c.maxX + p.sx || p.z < c.minZ - p.sz || p.z > c.maxZ + p.sz) continue;
		if (p.y > c.maxY + .1 || p.y + p.sy < c.minY) continue;
		const cx = clamp(p.x, c.minX, c.maxX);
		const cz = clamp(p.z, c.minZ, c.maxZ);
		const dx = p.x - cx;
		const dz = p.z - cz;
		if (dx * dx + dz * dz < .01) {
			if (p.vy <= 0) {
				p.y = c.maxY;
				p.vy = 0;
			}
		}
	}
}
function stepInjury(w, dt) {
	for (const a of w.actors) {
		if (a.heat > .5) {
			a.injuries.torso.burn += dt * .15;
			a.pain = Math.min(1, a.pain + dt * .2);
			a.wet = Math.max(0, a.wet - dt);
		}
		const smoke = w.smoke[w.cell(a.x, a.z)];
		if (smoke > .45 && w.indoorAt(a.x, a.z)) {
			a.breath = Math.max(0, a.breath - dt * .25 * smoke);
			a.consciousness -= dt * .08 * smoke;
		}
		if (a.bleed > 0) {
			a.blood = Math.max(0, a.blood - a.bleed * dt * .12);
			a.bleed = Math.max(0, a.bleed - dt * .02);
			if (a.grounded && a.bleed > .08) w.tracks.push({
				x: a.x,
				z: a.z,
				t: w.time,
				actorId: a.id,
				kind: "blood",
				heading: a.yaw
			});
		}
		a.pain = clamp(a.pain * (1 - dt * .08) + injurySum(a.injuries.torso) * .05, 0, 1);
		if (a.blood < .25) a.consciousness = Math.min(a.consciousness, a.blood * 2);
		if (a.breath <= 0) a.consciousness -= dt * .4;
		if (injurySum(a.injuries.head) > 1.6) a.consciousness -= dt * .15;
		a.consciousness = clamp(a.consciousness, 0, 1);
		if (a.alive && (a.blood <= .02 || a.consciousness <= 0 || a.y < -2.5)) kill(w, a, a.blood <= .02 ? "bled out" : a.y < -2.5 ? "drowned" : "the body gave out");
		if (!a.alive) continue;
		if (a.consciousness < .15) {
			a.loco = "down";
			a.intendSpeed = 0;
			a.downT += dt;
			if (a.kind === "player") {
				w.phase = "down";
				if (w.nearby(a.x, a.z, 4).filter((g) => g.faction === "guard" && g.alive).length && a.downT > 1.6) {
					w.phase = "captured";
					w.captureT = 0;
					w.whisper("They drag you.");
				}
			}
		}
	}
}
function kill(w, a, cause) {
	if (!a.alive) return;
	a.alive = false;
	a.loco = "down";
	a.consciousness = 0;
	a.intendSpeed = 0;
	w.emitSound(a.x, a.z, .6, "impact", a.id);
	if (a.kind === "player") {
		w.phase = "dead";
		w.deadCause = cause;
	} else {
		w.whisper(a.faction === "guard" ? "A guard goes still." : a.species === "human" ? "Someone falls and does not rise." : "The animal stills.");
		w.wanted = Math.min(1, w.wanted + (a.faction === "guard" ? .3 : .05));
		const carcass = w.addProp({
			kind: "carcass",
			material: "flesh",
			x: a.x,
			y: .05,
			z: a.z,
			sx: a.radius * 2.2,
			sy: .28,
			sz: a.height * .5,
			mass: a.mass,
			hp: 20,
			flammable: true,
			fuel: 6,
			color: 4861992,
			anchored: false,
			dynamic: false
		});
		carcass.yaw = a.yaw;
	}
}
function igniteAt(w, x, z, power) {
	const i = w.cell(x, z);
	w.heat[i] = Math.min(2.5, w.heat[i] + power);
	if (w.heat[i] > .55 + w.wet[i] * .8 && (w.fuel[i] > .15 || w.oil[i] > .1)) {
		if (!w.burning[i]) {
			w.burning[i] = 1;
			w.emitSound(x, z, .5, "fire", 0);
			if (w.fireCount < 3) w.whisper("Fire takes.");
		}
	}
}
function spillOil(w, p) {
	for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
		const i = w.cell(p.x + dx * 2, p.z + dz * 2);
		w.oil[i] = Math.min(1.5, w.oil[i] + .55);
		w.fuel[i] += .4;
	}
	w.whisper("Oil spreads.");
	p.oil = false;
}
function stepFire(w, dt) {
	w.fireCount = 0;
	const nextHeat = w.heat.slice();
	const wx = w.windX;
	const wz = w.windZ;
	for (let iz = 1; iz < 43; iz++) for (let ix = 1; ix < 43; ix++) {
		const i = ix + iz * 44;
		const rain = w.indoor[i] ? 0 : w.rain;
		w.wet[i] = clamp(w.wet[i] + rain * dt * .35 - dt * .02, 0, 1.2);
		if (w.burning[i]) {
			w.fireCount++;
			const burn = (.35 + w.oil[i] * .5) * dt * (1 - rain * .7);
			w.fuel[i] = Math.max(0, w.fuel[i] - burn);
			w.oil[i] = Math.max(0, w.oil[i] - burn * .6);
			w.heat[i] = Math.min(2.2, w.heat[i] + burn * 1.4);
			w.char[i] = Math.min(1, w.char[i] + dt * .12);
			w.smoke[i] = Math.min(2, w.smoke[i] + dt * (1.2 + w.fuel[i] * .2));
			if (w.fuel[i] <= .02 && w.oil[i] <= .02) {
				w.burning[i] = 0;
				w.heat[i] *= .4;
			}
			if (rain > .55 && w.rng() < dt * 1.2) {
				w.burning[i] = 0;
				w.heat[i] *= .3;
			}
			const pos = w.ixz(i);
			for (const a of w.nearby(pos.x, pos.z, 2.4)) {
				a.heat = Math.max(a.heat, .7);
				if (a.wet < .4) a.injuries.torso.burn += dt * .2;
			}
			for (const p of w.props) {
				if (!p.flammable || p.collapsed) continue;
				if (dist2(p.x, p.z, pos.x, pos.z) < 6) {
					p.hp -= dt * 6;
					if (p.hp < p.maxHp * .6) p.burning = true;
					if (p.hp <= 0) collapseProp(w, p, wx, wz);
				}
			}
		} else {
			w.heat[i] = Math.max(0, w.heat[i] - dt * (.25 + rain));
			w.smoke[i] = Math.max(0, w.smoke[i] - dt * (w.indoor[i] ? .15 : .55));
		}
		const spread = w.heat[i - 1] * (wx < 0 ? 1.25 : .8) + w.heat[i + 1] * (wx > 0 ? 1.25 : .8) + w.heat[i - 44] * (wz < 0 ? 1.25 : .8) + w.heat[i + 44] * (wz > 0 ? 1.25 : .8);
		nextHeat[i] = Math.max(w.heat[i], w.heat[i] * .7 + spread * .08 * dt * 8);
	}
	for (let i = 0; i < w.heat.length; i++) {
		w.heat[i] = nextHeat[i];
		if (!w.burning[i] && w.heat[i] > .7 + w.wet[i] * .7 && (w.fuel[i] > .2 || w.oil[i] > .12)) w.burning[i] = 1;
	}
	for (const a of w.actors) {
		a.heat = Math.max(0, a.heat - dt * .6);
		const i = w.cell(a.x, a.z);
		if (w.burning[i] && a.wet < .5) a.heat = Math.max(a.heat, 1);
	}
}
function stepProps(w, _dt) {
	for (const p of w.props) {
		if (p.burning && p.flammable) igniteAt(w, p.x, p.z, .4);
		if (p.kind === "chest" && !p.heldBy) {
			const player = w.player();
			if (player.grabbedId === p.id && w.wanted < .15) {
				w.wanted = Math.min(1, w.wanted + .5);
				w.whisper("The chest is missed.");
				for (const a of w.nearby(p.x, p.z, 16)) if (a.faction === "civilian" || a.faction === "guard") {
					w.addMemory(a, "theft", p.x, p.z, player.id, .9);
					if (a.faction === "guard") {
						a.known.push(player.id);
						a.alert = 1;
					}
				}
			}
		}
	}
}
function damageProp(w, p, dmg, vx, vz, by) {
	p.hp -= dmg;
	p.vx += vx * .3;
	p.vz += vz * .3;
	if (p.kind === "lamp" && dmg > 6) {
		spillOil(w, p);
		igniteAt(w, p.x, p.z, .7);
		w.emitSound(p.x, p.z, .5, "break", by?.id ?? 0);
	}
	if (p.hp <= 0) collapseProp(w, p, vx, vz);
	else w.emitSound(p.x, p.z, .3, "wood", by?.id ?? 0);
}
function collapseProp(w, p, vx, vz) {
	if (p.collapsed) return;
	p.collapsed = true;
	p.dynamic = true;
	p.anchored = false;
	p.hp = 0;
	p.vy = 1.2;
	p.vx += vx * .4 + (w.rng() - .5);
	p.vz += vz * .4 + (w.rng() - .5);
	w.emitSound(p.x, p.z, p.sy > 1.5 ? 1.1 : .55, p.sy > 1.5 ? "collapse" : "break", 0);
	w.shake = Math.max(w.shake, p.sy > 1.5 ? .55 : .2);
	for (const c of w.colliders) if (c.propId === p.id) c.solid = false;
	igniteAt(w, p.x, p.z, p.burning ? .6 : .1);
	if (p.kind === "stall" || p.kind === "table") w.whisper("A stall comes down.");
}
function stepStructures(w, _dt) {
	for (const b of w.buildings) {
		if (b.collapsed) continue;
		let live = 0;
		for (const id of b.supports) {
			const p = w.prop(id);
			if (p && !p.collapsed && p.hp > 0) live++;
		}
		if (live <= Math.max(1, b.supports.length / 2 | 0) && b.supports.length) {
			b.collapsed = true;
			w.whisper(b.name + " gives way.");
			w.emitSound((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, 1.4, "collapse", 0);
			w.shake = Math.max(w.shake, .7);
			for (const id of b.parts) {
				const p = w.prop(id);
				if (!p) continue;
				collapseProp(w, p, (w.rng() - .5) * 3, (w.rng() - .5) * 3);
				p.vy += 2 + w.rng();
			}
			for (const a of w.actors) {
				if (a.x > b.minX && a.x < b.maxX && a.z > b.minZ && a.z < b.maxZ) {
					a.injuries.torso.bruise += .5;
					a.injuries.head.bruise += .25;
					a.loco = "ragdoll";
					a.vy = -1;
					a.balance = 0;
					a.consciousness -= .25;
				}
				a.fear = Math.min(1, a.fear + .35);
			}
			w.wanted = Math.min(1, w.wanted + .15);
		}
	}
}
function stepTracks(w, _dt) {
	const p = w.player();
	if (p.grounded && Math.hypot(p.vx, p.vz) > 1.2) {
		const surf = surfaceAt(w, p.x, p.z);
		if (surf === "mud" || surf === "dirt" || w.wet[w.cell(p.x, p.z)] > .4) {
			if ((w.time * 8 | 0) !== ((w.time - .016) * 8 | 0)) w.tracks.push({
				x: p.x,
				z: p.z,
				t: w.time,
				actorId: p.id,
				kind: "foot",
				heading: p.yaw
			});
		}
	}
	const rainKill = 8 + w.rain * 18;
	w.tracks = w.tracks.filter((t) => w.time - t.t < rainKill);
	if (w.tracks.length > 220) w.tracks.splice(0, w.tracks.length - 220);
}
function cullSounds(w) {
	w.sounds = w.sounds.filter((s) => w.time - s.t < .8);
}
function hintFor(w) {
	const p = w.player();
	const f = facing(p.yaw);
	for (const o of w.nearby(p.x, p.z, 1.6)) {
		if (o.id === p.id) continue;
		const dx = o.x - p.x;
		const dz = o.z - p.z;
		if (dx * f.x + dz * f.z < 0) continue;
		if (o.species === "human") return o.alive ? "Hold grab — throw on release" : "A body";
		return "Grab";
	}
	for (const pr of w.props) {
		if (Math.hypot(pr.x - p.x, pr.z - p.z) > 1.5) continue;
		if (pr.kind === "chest") return "The tax chest";
		if (pr.weapon) return pr.weapon;
		if (pr.kind === "lamp") return "Lamp";
		if (pr.kind === "flask") return "Oil flask";
		if (pr.kind === "hay") return "Dry hay";
	}
	if (p.bleed > .2) return "Hold T to bind the wound";
	return "";
}
var GEO = {
	box: new BoxGeometry(1, 1, 1),
	sphere: new SphereGeometry(.5, 10, 8),
	cyl: new CylinderGeometry(.5, .5, 1, 8),
	cone: new ConeGeometry(.5, 1, 8),
	plane: new PlaneGeometry(1, 1)
};
function mat(color, extra = {}) {
	return new MeshStandardMaterial({
		color,
		roughness: .86,
		metalness: .04,
		...extra
	});
}
function noiseCanvas(size, fn) {
	const c = document.createElement("canvas");
	c.width = c.height = size;
	const g = c.getContext("2d");
	const img = g.createImageData(size, size);
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
		const i = (y * size + x) * 4;
		const [r, gv, b] = fn(x, y, i);
		img.data[i] = r;
		img.data[i + 1] = gv;
		img.data[i + 2] = b;
		img.data[i + 3] = 255;
	}
	g.putImageData(img, 0, 0);
	const t = new CanvasTexture(c);
	t.wrapS = t.wrapT = RepeatWrapping;
	t.colorSpace = SRGBColorSpace;
	t.anisotropy = 4;
	return t;
}
function hash(x, y) {
	const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
	return s - Math.floor(s);
}
var View = class {
	renderer;
	scene = new Scene();
	camera = new PerspectiveCamera(62, 1, .08, 220);
	sun = new DirectionalLight(15784104, 2.1);
	hemi = new HemisphereLight(12109008, 3813412, .85);
	amb = new AmbientLight(2761756, .42);
	fill = new PointLight(16755302, 0, 18, 2);
	actorMap = /* @__PURE__ */ new Map();
	propMap = /* @__PURE__ */ new Map();
	fireMeshes = [];
	smokeMeshes = [];
	rain = null;
	ground;
	groundColors;
	treeGroup = new Group();
	lampLights = [];
	tmp = new Vector3();
	tmp2 = new Vector3();
	camPos = new Vector3();
	look = new Vector3();
	trauma = 0;
	reduced = false;
	woodTex;
	dirtTex;
	disposed = false;
	fireMat;
	smokeMat;
	water;
	waterMat;
	constructor(canvas) {
		this.reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
		const touch = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0 || (window.matchMedia?.("(pointer: coarse)").matches ?? false);
		this.renderer = new WebGLRenderer({
			canvas,
			antialias: !touch,
			alpha: false,
			powerPreference: "high-performance"
		});
		this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, touch ? 1.35 : 2));
		this.renderer.setClearColor(789258, 1);
		this.renderer.shadowMap.enabled = !touch;
		this.renderer.shadowMap.type = 1;
		this.renderer.toneMapping = 4;
		this.renderer.toneMappingExposure = 1.28;
		this.renderer.outputColorSpace = SRGBColorSpace;
		this.scene.fog = new FogExp2(2761756, .012);
		this.scene.add(this.hemi, this.amb, this.sun, this.fill);
		this.hemi.intensity = .85;
		this.amb.intensity = .42;
		this.sun.castShadow = !touch;
		this.sun.shadow.mapSize.set(touch ? 512 : 1024, touch ? 512 : 1024);
		this.sun.shadow.camera.near = 2;
		this.sun.shadow.camera.far = 90;
		this.sun.shadow.camera.left = -30;
		this.sun.shadow.camera.right = 30;
		this.sun.shadow.camera.top = 30;
		this.sun.shadow.camera.bottom = -30;
		this.sun.shadow.bias = -8e-4;
		this.fill.castShadow = false;
		this.woodTex = noiseCanvas(128, (x, y) => {
			const g = 70 + hash(x * .15, y) * 40 + Math.sin(y * .4) * 12;
			return [
				g + 18,
				g,
				g - 18
			];
		});
		this.woodTex.repeat.set(2, 2);
		this.dirtTex = noiseCanvas(128, (x, y) => {
			const r = 62 + hash(x * .2, y * .2) * 40;
			return [
				r,
				r - 14,
				r - 28
			];
		});
		this.dirtTex.repeat.set(18, 18);
		this.fireMat = new MeshBasicMaterial({
			color: 16755285,
			transparent: true,
			opacity: .85,
			depthWrite: false,
			blending: 2
		});
		this.smokeMat = new MeshBasicMaterial({
			color: 2762788,
			transparent: true,
			opacity: .28,
			depthWrite: false
		});
		this.waterMat = mat(2767424, {
			roughness: .18,
			metalness: .2,
			transparent: true,
			opacity: .72
		});
		this.buildGround();
		this.buildSky();
		this.scene.add(this.treeGroup);
	}
	resize(w, h) {
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
			const m = o;
			if (m.geometry && m.geometry !== GEO.box && m.geometry !== GEO.sphere && m.geometry !== GEO.cyl && m.geometry !== GEO.cone && m.geometry !== GEO.plane) m.geometry.dispose();
			const mat = m.material;
			if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
			else mat?.dispose();
		});
	}
	buildSky() {
		const g = new SphereGeometry(160, 16, 12);
		const m = new MeshBasicMaterial({
			color: 1841688,
			side: 1
		});
		this.scene.add(new Mesh(g, m));
	}
	buildGround() {
		const seg = 44;
		const geo = new PlaneGeometry(88, 88, seg, seg);
		geo.rotateX(-Math.PI / 2);
		const cols = /* @__PURE__ */ new Float32Array(6075);
		geo.setAttribute("color", new BufferAttribute(cols, 3));
		this.groundColors = geo.getAttribute("color");
		const m = new MeshStandardMaterial({
			vertexColors: true,
			map: this.dirtTex,
			roughness: .95,
			metalness: 0
		});
		this.ground = new Mesh(geo, m);
		this.ground.receiveShadow = true;
		this.scene.add(this.ground);
		this.water = new Mesh(new PlaneGeometry(88, 7.2), this.waterMat);
		this.water.rotation.x = -Math.PI / 2;
		this.water.position.set(0, .02, 21);
		this.scene.add(this.water);
	}
	bootstrap(w) {
		this.paintGround(w);
		this.buildTrees(w);
		for (const p of w.props) this.ensureProp(p);
		for (const a of w.actors) this.ensureActor(a);
		for (let i = 0; i < 18; i++) {
			const f = new Mesh(GEO.cone, this.fireMat);
			f.visible = false;
			this.scene.add(f);
			this.fireMeshes.push(f);
		}
		for (let i = 0; i < 14; i++) {
			const s = new Mesh(GEO.sphere, this.smokeMat.clone());
			s.visible = false;
			this.scene.add(s);
			this.smokeMeshes.push(s);
		}
		const rainGeo = new BufferGeometry();
		const n = this.renderer.shadowMap.enabled ? 900 : 220;
		const pos = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) {
			pos[i * 3] = (Math.random() - .5) * 50;
			pos[i * 3 + 1] = Math.random() * 16;
			pos[i * 3 + 2] = (Math.random() - .5) * 50;
		}
		rainGeo.setAttribute("position", new BufferAttribute(pos, 3));
		this.rain = new Points(rainGeo, new PointsMaterial({
			color: 10135728,
			size: .06,
			transparent: true,
			opacity: 0
		}));
		this.scene.add(this.rain);
		for (let i = 0; i < 6; i++) {
			const l = new PointLight(16760944, 0, 9, 2);
			this.scene.add(l);
			this.lampLights.push(l);
		}
	}
	buildTrees(w) {
		const trunkMat = mat(3812900);
		const leafMat = mat(3095080);
		const darkLeaf = mat(2371618);
		for (const c of w.colliders) {
			if (c.material !== "vegetation") continue;
			const x = (c.minX + c.maxX) * .5;
			const z = (c.minZ + c.maxZ) * .5;
			const g = new Group();
			const trunk = new Mesh(GEO.cyl, trunkMat);
			trunk.scale.set(.38, 3.4, .38);
			trunk.position.y = 1.7;
			trunk.castShadow = true;
			const leaf = new Mesh(GEO.cone, Math.random() > .5 ? leafMat : darkLeaf);
			leaf.scale.set(2.2, 4.2, 2.2);
			leaf.position.y = 4.4;
			leaf.castShadow = true;
			g.add(trunk, leaf);
			g.position.set(x, 0, z);
			this.treeGroup.add(g);
		}
	}
	paintGround(w) {
		const seg = 44;
		const attr = this.groundColors;
		const c = new Color();
		for (let iz = 0; iz <= seg; iz++) for (let ix = 0; ix <= seg; ix++) {
			const i = ix + iz * 45;
			const x = ix / seg * 88 - 44;
			const z = iz / seg * 88 - 44;
			const cell = w.cell(x, z);
			const char = w.char[cell] ?? 0;
			const wet = w.wet[cell] ?? 0;
			const oil = w.oil[cell] ?? 0;
			if (z > 17.2 && z < 24.8) c.set(2767938);
			else if (Math.abs(x) < 9 && Math.abs(z) < 9) c.set(7235420);
			else if (z < -16) c.set(4872764);
			else c.set(6049856);
			c.r *= 1 - char * .7;
			c.g *= 1 - char * .7;
			c.b *= 1 - char * .6;
			if (wet > .4) {
				c.r *= .82;
				c.g *= .85;
				c.b *= .9;
			}
			if (oil > .2) {
				c.r *= .7;
				c.g *= .65;
				c.b *= .45;
			}
			attr.setXYZ(i, c.r, c.g, c.b);
		}
		attr.needsUpdate = true;
	}
	ensureProp(p) {
		if (this.propMap.has(p.id)) return;
		const color = p.color;
		const mesh = new Mesh(GEO.box, mat(color, { map: p.material === "wood" || p.kind === "stall" ? this.woodTex : null }));
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.scale.set(p.sx, p.sy, p.sz);
		const g = new Group();
		mesh.position.y = p.sy * .5;
		g.add(mesh);
		if (p.kind === "lamp") {
			const flame = new Mesh(GEO.sphere, new MeshBasicMaterial({ color: 16768392 }));
			flame.scale.set(.12, .16, .12);
			flame.position.y = p.sy + .12;
			flame.name = "flame";
			g.add(flame);
		}
		if (p.kind === "chest") mesh.material = mat(4008468, {
			metalness: .15,
			roughness: .6
		});
		g.position.set(p.x, p.y, p.z);
		g.rotation.y = p.yaw;
		this.scene.add(g);
		this.propMap.set(p.id, g);
	}
	ensureActor(a) {
		if (this.actorMap.has(a.id)) return;
		const g = a.species === "human" || a.kind === "player" ? this.makeHumanoid(a) : this.makeBeast(a);
		this.scene.add(g);
		this.actorMap.set(a.id, g);
	}
	makeHumanoid(a) {
		const g = new Group();
		const skin = mat(a.skin);
		const cloth = mat(a.cloth);
		const dark = mat(a.accent);
		const head = new Mesh(GEO.box, skin);
		head.name = "head";
		head.scale.set(.28, .3, .26);
		head.position.y = 1.52;
		head.castShadow = true;
		const torso = new Mesh(GEO.box, cloth);
		torso.name = "torso";
		torso.scale.set(.42, .52, .24);
		torso.position.y = 1.12;
		torso.castShadow = true;
		const pelvis = new Mesh(GEO.box, dark);
		pelvis.scale.set(.38, .2, .22);
		pelvis.position.y = .78;
		const larm = arm(skin, -1);
		const rarm = arm(skin, 1);
		const lleg = leg(dark, -1);
		const rleg = leg(dark, 1);
		larm.name = "larm";
		rarm.name = "rarm";
		lleg.name = "lleg";
		rleg.name = "rleg";
		g.add(head, torso, pelvis, larm, rarm, lleg, rleg);
		if (a.helmet) {
			const h = new Mesh(GEO.sphere, mat(4869200, {
				metalness: .5,
				roughness: .4
			}));
			h.scale.set(.32, .22, .3);
			h.position.y = 1.64;
			g.add(h);
		}
		const wep = new Mesh(GEO.box, mat(6969928));
		wep.name = "weapon";
		wep.scale.set(.06, .06, .9);
		rarm.add(wep);
		wep.position.set(0, -.42, .2);
		g.userData.parts = {
			head,
			torso,
			larm,
			rarm,
			lleg,
			rleg,
			wep
		};
		return g;
	}
	makeBeast(a) {
		const g = new Group();
		const fur = mat(a.cloth);
		const body = new Mesh(GEO.box, fur);
		const s = a.species === "bear" ? [
			1.3,
			.9,
			2.1
		] : a.species === "cow" ? [
			.9,
			.85,
			1.6
		] : a.species === "wolf" ? [
			.45,
			.5,
			1.1
		] : a.species === "deer" ? [
			.4,
			.7,
			1.15
		] : a.species === "pig" ? [
			.55,
			.45,
			.95
		] : [
			.35,
			.55,
			.7
		];
		body.scale.set(s[0], s[1], s[2]);
		body.position.y = s[1] * .55 + .15;
		body.castShadow = true;
		const head = new Mesh(GEO.box, mat(a.skin));
		head.scale.set(s[0] * .55, s[1] * .55, s[2] * .4);
		head.position.set(0, body.position.y + s[1] * .15, -s[2] * .55);
		head.castShadow = true;
		g.add(body, head);
		if (a.species === "deer") {
			const ant = mat(5917240);
			for (const sx of [-1, 1]) {
				const h = new Mesh(GEO.box, ant);
				h.scale.set(.06, .45, .06);
				h.position.set(sx * .12, head.position.y + .35, head.position.z);
				g.add(h);
			}
		}
		g.userData.bodyH = body.position.y;
		return g;
	}
	sync(w, cam, alpha, dt, title) {
		this.trauma = this.reduced ? 0 : w.shake;
		this.paintGround(w);
		this.updateSky(w);
		for (const p of w.props) {
			this.ensureProp(p);
			const m = this.propMap.get(p.id);
			const x = p.px + (p.x - p.px) * alpha;
			const y = p.py + (p.y - p.py) * alpha;
			const z = p.pz + (p.z - p.pz) * alpha;
			m.position.set(x, y, z);
			m.rotation.y = p.yaw;
			m.rotation.z = p.collapsed ? .8 : 0;
			m.visible = !p.heldBy;
			if (p.kind === "lamp") {
				const fl = m.getObjectByName("flame");
				if (fl) fl.visible = !p.collapsed;
			}
		}
		for (const a of w.actors) {
			this.ensureActor(a);
			const g = this.actorMap.get(a.id);
			const x = a.px + (a.x - a.px) * alpha;
			const y = a.py + (a.y - a.py) * alpha;
			const z = a.pz + (a.z - a.pz) * alpha;
			const yaw = lerpAng(a.pyaw, a.yaw, alpha);
			g.position.set(x, y, z);
			g.rotation.y = yaw;
			g.rotation.x = a.loco === "ragdoll" || a.loco === "down" ? 1.25 : a.loco === "getup" ? .5 : 0;
			g.rotation.z = a.loco === "stumble" ? Math.sin(w.time * 10) * .12 : 0;
			if (a.species === "human" || a.kind === "player") this.animHuman(a, g, w);
			else this.animBeast(a, g);
			g.visible = true;
			if (!a.alive) g.rotation.x = 1.4;
		}
		this.updateFire(w);
		this.updateRain(w, dt);
		this.updateCamera(w, cam, alpha, title);
	}
	animHuman(a, g, w) {
		const parts = g.userData.parts;
		if (!parts) return;
		const spd = Math.hypot(a.vx, a.vz);
		const ph = a.walkPhase;
		injurySum(a.injuries.lleg) + injurySum(a.injuries.rleg);
		const swing = Math.min(.9, spd * .18);
		parts.lleg.rotation.x = Math.sin(ph) * swing * (1 - injurySum(a.injuries.lleg) * .4);
		parts.rleg.rotation.x = Math.sin(ph + Math.PI) * swing * (1 - injurySum(a.injuries.rleg) * .4);
		parts.larm.rotation.x = Math.sin(ph + Math.PI) * swing * .8;
		parts.rarm.rotation.x = Math.sin(ph) * swing * .8;
		if (a.strikeT > 0) {
			parts.rarm.rotation.x = -1.4 + a.strikeT * 4;
			parts.rarm.rotation.y = .4;
		} else parts.rarm.rotation.y = 0;
		if (a.kickT > 0) parts.rleg.rotation.x = -1.2;
		parts.torso.rotation.x = a.crouch ? .35 : spd > 5 ? .18 : .04;
		parts.head.rotation.x = a.crouch ? .2 : 0;
		const wepLen = a.weapon === "spear" || a.weapon === "pitchfork" ? 1.6 : a.weapon === "club" || a.weapon === "board" ? 1.05 : .7;
		parts.wep.scale.set(.05, .05, wepLen);
		parts.wep.visible = a.weapon !== "fist";
		parts.head.material = tintInjury(a.skin, injurySum(a.injuries.head));
		if (a.heat > .4) {
			const t = w.time * 18;
			g.position.y += Math.sin(t) * .01;
		}
	}
	animBeast(a, g) {
		const spd = Math.hypot(a.vx, a.vz);
		g.position.y += Math.abs(Math.sin(a.walkPhase * 2)) * Math.min(.08, spd * .02);
		g.rotation.z = Math.sin(a.walkPhase) * Math.min(.1, spd * .02);
	}
	updateFire(w) {
		const fires = [];
		for (let i = 0; i < w.burning.length; i++) {
			if (!w.burning[i]) continue;
			const p = w.ixz(i);
			fires.push({
				x: p.x,
				z: p.z,
				h: w.heat[i]
			});
		}
		fires.sort((a, b) => b.h - a.h);
		for (let i = 0; i < this.fireMeshes.length; i++) {
			const m = this.fireMeshes[i];
			const f = fires[i];
			if (!f) {
				m.visible = false;
				continue;
			}
			m.visible = true;
			const flick = .8 + Math.sin(w.time * 17 + i) * .2;
			m.position.set(f.x, .4 * flick + f.h * .3, f.z);
			m.scale.set(.6 * flick, 1.4 * flick * (.6 + f.h), .6 * flick);
			m.rotation.y = w.time * 2 + i;
		}
		for (let i = 0; i < this.smokeMeshes.length; i++) {
			const m = this.smokeMeshes[i];
			const f = fires[i];
			if (!f) {
				m.visible = false;
				continue;
			}
			m.visible = true;
			const t = (w.time * .4 + i * .2) % 1;
			m.position.set(f.x + w.windX * t * .8, 1.2 + t * 3.5, f.z + w.windZ * t * .8);
			const s = .6 + t * 2.2;
			m.scale.set(s, s * .7, s);
			m.material.opacity = .28 * (1 - t);
		}
		let li = 0;
		for (const p of w.props) {
			if (p.kind !== "lamp" || p.collapsed || li >= this.lampLights.length) continue;
			const l = this.lampLights[li++];
			l.position.set(p.x, p.y + 1.4, p.z);
			l.intensity = 2.4 + Math.sin(w.time * 7 + p.id) * .25;
		}
		while (li < this.lampLights.length) this.lampLights[li++].intensity = 0;
		const p = w.player();
		if (fires[0]) {
			this.fill.position.set(fires[0].x, 2.2, fires[0].z);
			this.fill.intensity = Math.min(4, fires.length * .7);
			this.fill.distance = 16;
		} else if (p.torchLit) {
			this.fill.position.set(p.x, p.y + 1.5, p.z);
			this.fill.intensity = 1.8;
		} else {
			this.fill.intensity = .15;
			this.fill.position.set(p.x, 2, p.z);
		}
	}
	updateRain(w, dt) {
		if (!this.rain) return;
		const mat = this.rain.material;
		mat.opacity = w.rain * .55;
		const pos = this.rain.geometry.getAttribute("position");
		const p = w.player();
		for (let i = 0; i < pos.count; i++) {
			let y = pos.getY(i) - dt * (14 + w.rain * 8);
			if (y < 0) y = 14;
			pos.setXYZ(i, p.x + i * 17 % 50 - 25, y, p.z + i * 31 % 50 - 25);
		}
		pos.needsUpdate = true;
		this.rain.position.set(0, 0, 0);
	}
	updateSky(w) {
		const d = w.day;
		const night = d < .22 || d > .8 ? 1 : d < .3 || d > .72 ? .45 : 0;
		const dusk = d > .7 && d < .86 ? 1 : d < .28 ? .5 : 0;
		const sunCol = new Color().setHSL(.09 - dusk * .03, .42 + dusk * .15, .78 - night * .28);
		this.sun.color.copy(sunCol);
		this.sun.intensity = 2.05 - night * 1.15 + dusk * .15;
		const ang = (d - .25) * Math.PI * 2;
		this.sun.position.set(Math.cos(ang) * 40, Math.max(8, Math.sin(ang) * 28 + 10), 18);
		const fogCol = new Color().setRGB(.22 + dusk * .08, .18 + dusk * .04, .14 + night * .02);
		this.scene.fog.color.copy(fogCol);
		this.scene.fog.density = .01 + w.rain * .008 + night * .006;
		this.renderer.setClearColor(fogCol, 1);
		this.hemi.intensity = .85 - night * .3;
		this.waterMat.opacity = .65 + w.rain * .1;
	}
	updateCamera(w, cam, alpha, title) {
		const p = w.player();
		const x = p.px + (p.x - p.px) * alpha;
		const y = p.py + (p.y - p.py) * alpha;
		const z = p.pz + (p.z - p.pz) * alpha;
		const f = facing(cam.yaw);
		const dist = title ? 18 : 5.4;
		const height = title ? 8 : 1.72;
		const target = this.tmp.set(x, y + (title ? 1.2 : 1.35), z);
		if (title) {
			const t = w.time * .07;
			this.camPos.set(Math.sin(t) * 11 + 2, 5.2, Math.cos(t) * 11 + 1);
			this.look.set(0, 1, 0);
		} else {
			const desired = this.tmp2.set(x - f.x * dist, y + height, z - f.z * dist);
			desired.y += Math.sin(cam.pitch) * 3.2;
			const k = 1 - Math.exp(-.16);
			this.camPos.lerp(desired, k);
			this.look.lerp(target, k);
		}
		if (this.trauma > .01 && !this.reduced) {
			const s = this.trauma * this.trauma;
			this.camera.position.set(this.camPos.x + (Math.random() - .5) * s * .35, this.camPos.y + (Math.random() - .5) * s * .25, this.camPos.z + (Math.random() - .5) * s * .35);
		} else this.camera.position.copy(this.camPos);
		this.camera.lookAt(this.look);
		this.sun.target.position.set(x, 0, z);
		if (!this.sun.target.parent) this.scene.add(this.sun.target);
	}
	render() {
		this.renderer.render(this.scene, this.camera);
	}
};
function arm(matSkin, side) {
	const g = new Group();
	const u = new Mesh(GEO.box, matSkin);
	u.scale.set(.12, .42, .12);
	u.position.set(0, -.2, 0);
	u.castShadow = true;
	g.add(u);
	g.position.set(side * .28, 1.32, 0);
	return g;
}
function leg(matCloth, side) {
	const g = new Group();
	const u = new Mesh(GEO.box, matCloth);
	u.scale.set(.14, .7, .14);
	u.position.set(0, -.35, 0);
	u.castShadow = true;
	g.add(u);
	g.position.set(side * .12, .7, 0);
	return g;
}
var injuryMats = /* @__PURE__ */ new Map();
function tintInjury(base, amount) {
	const key = base + ":" + (amount * 8 | 0);
	let m = injuryMats.get(key);
	if (!m) {
		const c = new Color(base);
		c.r = Math.min(1, c.r + amount * .25);
		c.g *= 1 - amount * .3;
		c.b *= 1 - amount * .3;
		m = mat(c.getHex());
		injuryMats.set(key, m);
	}
	return m;
}
var KEY = "sunder.save.v1";
var VERSION = 1;
function loadSave() {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return null;
		const data = JSON.parse(raw);
		if (!data || data.version !== VERSION) return null;
		return data;
	} catch {
		return null;
	}
}
function writeSave(data) {
	try {
		const blob = {
			...data,
			version: VERSION
		};
		localStorage.setItem(KEY, JSON.stringify(blob));
		localStorage.setItem(KEY + ".bak", JSON.stringify(blob));
	} catch {}
}
function clearSave() {
	try {
		localStorage.removeItem(KEY);
	} catch {}
}
var Game = class {
	world = new World();
	input;
	audio = new GameAudio();
	view;
	cam = {
		yaw: 0,
		pitch: .18
	};
	hud = defaultHud();
	onHud;
	running = false;
	acc = 0;
	last = 0;
	canvas;
	saveT = 0;
	unsubVis;
	constructor(canvas, onHud) {
		this.canvas = canvas;
		this.onHud = onHud;
		this.input = new Input(canvas);
		this.view = new View(canvas);
		this.world.seed = Date.now() % 2147483646 + 1;
		buildLevel(this.world);
		this.view.bootstrap(this.world);
		this.restore();
		this.cam.yaw = this.world.player().yaw;
		this.resize();
		this.canvas.addEventListener("click", this.onCanvasClick);
		const onVis = () => {
			if (document.hidden) {
				this.flushSave();
				if (this.hud.phase === "playing") this.pause(true);
			} else this.audio.resume();
		};
		document.addEventListener("visibilitychange", onVis);
		this.unsubVis = () => document.removeEventListener("visibilitychange", onVis);
		window.addEventListener("resize", this.resize);
		window.visualViewport?.addEventListener("resize", this.resize);
		window.visualViewport?.addEventListener("scroll", this.resize);
		screen.orientation?.addEventListener?.("change", this.resize);
		this.wireControlsTest();
		this.pushHud();
	}
	start() {
		if (this.running) return;
		this.running = true;
		this.last = performance.now();
		this.view.renderer.setAnimationLoop(this.frame);
	}
	stop() {
		this.running = false;
		this.view.renderer.setAnimationLoop(null);
	}
	dispose() {
		this.stop();
		this.flushSave();
		this.input.dispose();
		this.view.dispose();
		this.unsubVis?.();
		this.canvas.removeEventListener("click", this.onCanvasClick);
		window.removeEventListener("resize", this.resize);
		window.visualViewport?.removeEventListener("resize", this.resize);
		window.visualViewport?.removeEventListener("scroll", this.resize);
		screen.orientation?.removeEventListener?.("change", this.resize);
		if (window.__controlsTest) delete window.__controlsTest;
	}
	resize = () => {
		const p = this.canvas.parentElement;
		const w = p?.clientWidth || window.innerWidth;
		const h = p?.clientHeight || window.innerHeight;
		this.canvas.width = w;
		this.canvas.height = h;
		this.view.resize(w, h);
	};
	onCanvasClick = () => {
		if (this.world.phase === "playing" && !isTouchDevice()) this.input.requestLock();
	};
	enter() {
		this.audio.unlock();
		this.audio.play("ui", .5);
		this.world.phase = "playing";
		this.hud.phase = "playing";
		this.input.enabled = true;
		if (!isTouchDevice()) this.input.requestLock();
		this.cam.yaw = this.world.player().yaw;
		this.pushHud();
	}
	pause(v) {
		if (this.world.phase === "dead" || this.world.phase === "captured") return;
		if (v) {
			this.world.phase = "paused";
			this.hud.phase = "paused";
			this.input.enabled = false;
			document.exitPointerLock?.();
		} else {
			this.world.phase = "playing";
			this.hud.phase = "playing";
			this.input.enabled = true;
			if (!isTouchDevice()) this.input.requestLock();
		}
		this.pushHud();
	}
	restart(fresh = true) {
		if (fresh) clearSave();
		this.view.dispose();
		this.world = new World();
		this.world.seed = Date.now() % 2147483646 + 1;
		buildLevel(this.world);
		this.view = new View(this.canvas);
		this.view.bootstrap(this.world);
		this.cam = {
			yaw: this.world.player().yaw,
			pitch: .18
		};
		this.hud = defaultHud();
		this.input.enabled = false;
		this.resize();
		this.wireControlsTest();
		this.pushHud();
	}
	captureWake() {
		const p = this.world.player();
		p.x = 9.5;
		p.z = -8.2;
		p.y = 0;
		p.vx = p.vz = 0;
		p.consciousness = .7;
		p.stamina = .4;
		p.weapon = "fist";
		p.grabbedId = 0;
		p.loco = "idle";
		p.alive = true;
		p.downT = 0;
		this.world.phase = "playing";
		this.hud.phase = "playing";
		this.input.enabled = true;
		this.world.whisper("You wake in the barracks. They took the blade.");
		if (!isTouchDevice()) this.input.requestLock();
		this.pushHud();
	}
	frame = (now) => {
		const raw = Math.min(.1, (now - this.last) / 1e3);
		this.last = now;
		const playing = this.world.phase === "playing" || this.world.phase === "title";
		const simPlaying = this.world.phase === "playing";
		const input = this.input.sample();
		if (simPlaying) {
			this.cam.yaw -= input.lookX;
			this.cam.pitch = clamp(this.cam.pitch - input.lookY, -.9, .55);
			input.lookX = 0;
			input.lookY = 0;
		}
		if (simPlaying && input.pausePressed) this.pause(true);
		if (this.world.hitstop > 0 && simPlaying) {
			this.world.hitstop -= raw;
			this.view.sync(this.world, this.cam, 1, raw, this.world.phase === "title");
			this.view.render();
			return;
		}
		if (playing) {
			this.acc += raw;
			let steps = 0;
			while (this.acc >= .016666666666666666 && steps < 5) {
				stepWorld(this.world, STEP, input, this.cam, simPlaying);
				this.acc -= STEP;
				steps++;
				this.drainAudio();
			}
		}
		const alpha = playing ? this.acc / STEP : 1;
		this.view.sync(this.world, this.cam, alpha, raw, this.world.phase === "title");
		this.view.render();
		this.saveT += raw;
		if (this.saveT > 4) {
			this.saveT = 0;
			this.flushSave();
		}
		this.pushHud();
		const p = this.world.player();
		const fires = this.world.fireCount;
		this.audio.setBeds(this.world.rain, fires, this.world.wanted, this.world.day);
		if (p && Math.hypot(p.vx, p.vz) > 1.4 && p.grounded && simPlaying) {
			if ((this.world.time * (p.loco === "sprint" ? 5 : 3) | 0) !== ((this.world.time - raw) * 3 | 0)) this.audio.play(p.loco === "sprint" ? "sprint" : "step", .35, 0);
		}
	};
	drainAudio() {
		const p = this.world.player();
		for (const e of this.world.events) {
			if (!e.kind.startsWith("snd:")) continue;
			const kind = e.kind.slice(4);
			const dx = e.x - p.x;
			const dz = e.z - p.z;
			const d = Math.hypot(dx, dz);
			const mag = e.mag * (1 / (1 + d * .12));
			const pan = Math.max(-.8, Math.min(.8, dx / 18));
			this.audio.play(kind, mag, pan);
		}
	}
	pushHud() {
		const p = this.world.player();
		const inj = {
			head: 0,
			torso: 0,
			larm: 0,
			rarm: 0,
			lleg: 0,
			rleg: 0
		};
		for (const r of REGIONS) inj[r] = Math.min(1, injurySum(p.injuries[r]) / 1.4);
		const held = p.grabbedId ? this.world.actor(p.grabbedId)?.name || this.world.prop(p.grabbedId)?.kind || "" : "";
		const hunted = this.world.actors.some((a) => a.alive && a.known.includes(p.id) && (a.ai === "pursue" || a.ai === "combat" || a.ai === "search"));
		this.hud = {
			phase: this.world.phase,
			stamina: p.stamina,
			fatigue: p.fatigue,
			wet: p.wet,
			heat: p.heat,
			blood: p.blood,
			breath: p.breath,
			consciousness: p.consciousness,
			balance: p.balance,
			injuries: inj,
			held,
			weapon: p.weapon,
			stance: p.loco,
			crouch: p.crouch,
			whispers: this.world.whispers.filter((x) => this.world.time - x.t < 5).slice(-3),
			hunted,
			timeOfDay: this.world.day,
			rain: this.world.rain,
			wind: Math.hypot(this.world.windX, this.world.windZ),
			hint: this.world.phase === "playing" ? hintFor(this.world) : "",
			cause: this.world.deadCause,
			burning: p.heat > .5,
			wanted: this.world.wanted,
			captureT: this.world.captureT
		};
		this.onHud(this.hud);
	}
	flushSave() {
		const p = this.world.player();
		writeSave({
			version: 1,
			time: this.world.time,
			rain: this.world.rain,
			windX: this.world.windX,
			windZ: this.world.windZ,
			day: this.world.day,
			player: {
				x: p.x,
				y: p.y,
				z: p.z,
				yaw: p.yaw,
				blood: p.blood,
				stamina: p.stamina,
				weapon: p.weapon,
				torchLit: p.torchLit
			},
			burned: Array.from(this.world.char).map((v, i) => v > .4 ? i : -1).filter((i) => i >= 0).slice(0, 200),
			collapsed: this.world.buildings.filter((b) => b.collapsed).map((b) => b.id),
			dead: this.world.actors.filter((a) => !a.alive && a.kind !== "player").map((a) => a.id),
			wanted: this.world.wanted
		});
	}
	restore() {
		const s = loadSave();
		if (!s) return;
		const p = this.world.player();
		p.x = s.player.x;
		p.y = s.player.y;
		p.z = s.player.z;
		p.yaw = s.player.yaw;
		p.blood = s.player.blood;
		p.stamina = s.player.stamina;
		p.weapon = s.player.weapon;
		p.torchLit = s.player.torchLit;
		this.world.time = s.time;
		this.world.day = s.day;
		this.world.rain = s.rain;
		this.world.windX = s.windX;
		this.world.windZ = s.windZ;
		this.world.wanted = s.wanted;
		for (const i of s.burned) if (i >= 0 && i < this.world.char.length) {
			this.world.char[i] = Math.max(this.world.char[i], .7);
			this.world.fuel[i] = .05;
		}
	}
	wireControlsTest() {
		const self = this;
		window.__controlsTest = {
			getYaw: () => self.world.player().yaw,
			getSpeed: () => Math.hypot(self.world.player().vx, self.world.player().vz),
			getPos: () => {
				const p = self.world.player();
				return {
					x: p.x,
					y: p.y,
					z: p.z,
					loco: p.loco,
					grounded: p.grounded
				};
			},
			setKeys: (codes) => {
				if (self.world.phase !== "playing") {
					self.world.phase = "playing";
					self.hud.phase = "playing";
					self.input.enabled = true;
				}
				self.input.setKeys(codes);
			},
			setSteer: (v) => {
				if (v > .2) self.input.setKeys(["KeyW", "KeyA"]);
				else if (v < -.2) self.input.setKeys(["KeyW", "KeyD"]);
				else self.input.setKeys(["KeyW"]);
			}
		};
	}
};
//#endregion
export { Game };
