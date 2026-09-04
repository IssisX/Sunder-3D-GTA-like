import { STEP, defaultHud, type HudState, type Region, REGIONS } from "./types";
import { World, injurySum, clamp } from "./world";
import { Input, isTouchDevice } from "./input";
import { GameAudio } from "./audio";
import { buildLevel } from "./level";
import { hintFor, stepWorld, type Cam } from "./sim";
import { View } from "./render";
import { AnimatedPhysicalBodies } from "./body-actions";
import { BodyView } from "./body-render";
import { clearSave, loadSave, writeSave } from "./save";

export class Game {
  world = new World();
  input: Input;
  audio = new GameAudio();
  view: View;
  bodies = new AnimatedPhysicalBodies();
  bodyView: BodyView;
  cam: Cam = { yaw: 0, pitch: 0.18 };
  hud: HudState = defaultHud();
  onHud: (h: HudState) => void;
  running = false;
  acc = 0;
  last = 0;
  canvas: HTMLCanvasElement;
  saveT = 0;
  private unsubVis?: () => void;

  constructor(canvas: HTMLCanvasElement, onHud: (h: HudState) => void) {
    this.canvas = canvas;
    this.onHud = onHud;
    this.input = new Input(canvas);
    this.view = new View(canvas);
    this.world.seed = (Date.now() % 2147483646) + 1;
    buildLevel(this.world);
    this.view.bootstrap(this.world);
    this.restore();
    this.bodies.bootstrap(this.world);
    this.bodyView = new BodyView(this.view, this.bodies);
    this.bodyView.bootstrap(this.world.actors);
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
    this.bodyView.forget();
    this.bodies.clear();
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
    this.audio.play("ui", 0.5);
    this.world.phase = "playing";
    this.hud.phase = "playing";
    this.input.enabled = true;
    if (!isTouchDevice()) this.input.requestLock();
    this.cam.yaw = this.world.player().yaw;
    this.pushHud();
  }

  pause(v: boolean) {
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
    this.bodyView.forget();
    this.bodies.clear();
    this.world = new World();
    this.world.seed = (Date.now() % 2147483646) + 1;
    buildLevel(this.world);
    this.view = new View(this.canvas);
    this.view.bootstrap(this.world);
    this.bodies = new AnimatedPhysicalBodies();
    this.bodies.bootstrap(this.world);
    this.bodyView = new BodyView(this.view, this.bodies);
    this.bodyView.bootstrap(this.world.actors);
    this.cam = { yaw: this.world.player().yaw, pitch: 0.18 };
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
    p.consciousness = 0.7;
    p.stamina = 0.4;
    p.weapon = "fist";
    p.grabbedId = 0;
    p.grabbedBy = 0;
    p.loco = "idle";
    p.alive = true;
    p.downT = 0;
    this.bodies.reset(p);
    this.world.phase = "playing";
    this.hud.phase = "playing";
    this.input.enabled = true;
    this.world.whisper("You wake in the barracks. They took the blade.");
    if (!isTouchDevice()) this.input.requestLock();
    this.pushHud();
  }

  private frame = (now: number) => {
    const raw = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const playing = this.world.phase === "playing" || this.world.phase === "title";
    const simPlaying = this.world.phase === "playing";
    const input = this.input.sample();
    this.bodies.captureInput(input);
    if (simPlaying) {
      this.cam.yaw -= input.lookX;
      this.cam.pitch = clamp(this.cam.pitch - input.lookY, -0.9, 0.55);
      input.lookX = 0;
      input.lookY = 0;
    }
    if (simPlaying && input.pausePressed) this.pause(true);
    if (this.world.hitstop > 0 && simPlaying) {
      this.world.hitstop -= raw;
      this.view.sync(this.world, this.cam, 1, raw, this.world.phase === "title");
      this.bodyView.sync(this.world.actors, 1);
      this.view.render();
      return;
    }
    if (playing) {
      this.acc += raw;
      let steps = 0;
      while (this.acc >= STEP && steps < 5) {
        this.bodies.prepareInput(this.world, input, STEP);
        stepWorld(this.world, STEP, input, this.cam, simPlaying);
        this.bodies.step(this.world, STEP);
        this.acc -= STEP;
        steps++;
        this.drainAudio();
      }
    }
    const alpha = playing ? this.acc / STEP : 1;
    this.view.sync(this.world, this.cam, alpha, raw, this.world.phase === "title");
    this.bodyView.sync(this.world.actors, alpha);
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
      if (((this.world.time * (p.loco === "sprint" ? 5 : 3)) | 0) !== (((this.world.time - raw) * 3) | 0)) {
        this.audio.play(p.loco === "sprint" ? "sprint" : "step", 0.35, 0);
      }
    }
  };

  private drainAudio() {
    const p = this.world.player();
    for (const e of this.world.events) {
      if (!e.kind.startsWith("snd:")) continue;
      const kind = e.kind.slice(4);
      const dx = e.x - p.x;
      const dz = e.z - p.z;
      const d = Math.hypot(dx, dz);
      const mag = e.mag * (1 / (1 + d * 0.12));
      const pan = Math.max(-0.8, Math.min(0.8, dx / 18));
      this.audio.play(kind, mag, pan);
    }
  }

  private pushHud() {
    const p = this.world.player();
    const inj: Record<Region, number> = { head: 0, torso: 0, larm: 0, rarm: 0, lleg: 0, rleg: 0 };
    for (const r of REGIONS) inj[r] = Math.min(1, injurySum(p.injuries[r]) / 1.4);
    const held = p.grabbedId
      ? this.world.actor(p.grabbedId)?.name || this.world.prop(p.grabbedId)?.kind || ""
      : "";
    const hunted = this.world.actors.some(
      (a) => a.alive && a.known.includes(p.id) && (a.ai === "pursue" || a.ai === "combat" || a.ai === "search"),
    );
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
      burning: p.heat > 0.5,
      wanted: this.world.wanted,
      captureT: this.world.captureT,
    };
    this.onHud(this.hud);
  }

  private flushSave() {
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
        torchLit: p.torchLit,
      },
      burned: Array.from(this.world.char)
        .map((v, i) => (v > 0.4 ? i : -1))
        .filter((i) => i >= 0)
        .slice(0, 200),
      collapsed: this.world.buildings.filter((b) => b.collapsed).map((b) => b.id),
      dead: this.world.actors.filter((a) => !a.alive && a.kind !== "player").map((a) => a.id),
      wanted: this.world.wanted,
    });
  }

  private restore() {
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
    for (const i of s.burned) {
      if (i >= 0 && i < this.world.char.length) {
        this.world.char[i] = Math.max(this.world.char[i]!, 0.7);
        this.world.fuel[i] = 0.05;
      }
    }
  }

  private wireControlsTest() {
    const self = this;
    window.__controlsTest = {
      getYaw: () => self.world.player().yaw,
      getSpeed: () => Math.hypot(self.world.player().vx, self.world.player().vz),
      getPos: () => {
        const p = self.world.player();
        return { x: p.x, y: p.y, z: p.z, loco: p.loco, grounded: p.grounded };
      },
      setKeys: (codes: string[]) => {
        if (self.world.phase !== "playing") {
          self.world.phase = "playing";
          self.hud.phase = "playing";
          self.input.enabled = true;
        }
        self.input.setKeys(codes);
      },
      setSteer: (v: number) => {
        if (v > 0.2) self.input.setKeys(["KeyW", "KeyA"]);
        else if (v < -0.2) self.input.setKeys(["KeyW", "KeyD"]);
        else self.input.setKeys(["KeyW"]);
      },
    };
  }
}

declare global {
  interface Window {
    __controlsTest?: {
      getYaw: () => number;
      getSpeed: () => number;
      getPos?: () => { x: number; y: number; z: number; loco: string; grounded: boolean };
      setKeys?: (codes: string[]) => void;
      setSteer?: (v: number) => void;
    };
  }
}
