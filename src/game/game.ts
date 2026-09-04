import { STEP, defaultHud, type HudState, type Region, REGIONS } from "./types";
import { World, injurySum, clamp, facing, rightOf } from "./world";
import { Input, isTouchDevice } from "./input";
import { GameAudio } from "./audio";
import { buildLevel } from "./level";
import { hintFor, stepWorld, type Cam } from "./sim";
import { View } from "./render";
import { clearSave, loadSave, writeSave } from "./save";
import { ensureBodies, reposeActor, applyImpulseToNearest, strikeDuration, KICK_DUR, GRAB_DUR, FLINCH_DUR, P, weaponEnds, setGrab } from "./physique";

export class Game {
  world = new World();
  input: Input;
  audio = new GameAudio();
  view: View;
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
    ensureBodies(this.world);
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
    this.world = new World();
    this.world.seed = (Date.now() % 2147483646) + 1;
    buildLevel(this.world);
    ensureBodies(this.world);
    this.view = new View(this.canvas);
    this.view.bootstrap(this.world);
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
    p.loco = "idle";
    p.alive = true;
    p.downT = 0;
    if (p.body) {
      p.body.mode = "stance";
      reposeActor(p);
    }
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
      this.view.render();
      return;
    }
    if (playing) {
      this.acc += raw;
      let steps = 0;
      while (this.acc >= STEP && steps < 5) {
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
    p.y = Math.max(0, s.player.y);
    p.z = s.player.z;
    p.yaw = s.player.yaw;
    p.blood = Math.max(0.35, s.player.blood);
    p.stamina = s.player.stamina;
    p.weapon = s.player.weapon;
    p.torchLit = s.player.torchLit;
    p.loco = "idle";
    p.consciousness = Math.max(p.consciousness, 0.85);
    p.balance = 1;
    p.alive = true;
    if (p.body) p.body.mode = "stance";
    reposeActor(p);
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
      getBody: () => {
        const p = self.world.player();
        const b = p.body;
        if (!b) return null;
        return {
          mode: b.mode,
          support: b.support,
          lastVn: b.lastVn,
          lastHit: b.lastHit,
          n: b.parts.length,
          pelvisY: b.parts[0]?.y ?? 0,
          locoT: p.locoT,
          getupT: p.getupT,
          spd: Math.hypot(p.vx, p.vz),
        };
      },
      forceRagdoll: () => {
        const p = self.world.player();
        if (self.world.phase !== "playing") {
          self.world.phase = "playing";
          self.hud.phase = "playing";
          self.input.enabled = true;
        }
        p.loco = "ragdoll";
        p.locoT = 0.55;
        p.balance = 0;
        if (p.body) p.body.mode = "ragdoll";
        applyImpulseToNearest(p, p.x, p.y + 1.2, p.z, 8.5, 2.2, -5.5);
        applyImpulseToNearest(p, p.x, p.y + 0.4, p.z, 3.2, -1.5, -2.0);
      },
      forceStrike: () => {
        const p = self.world.player();
        if (self.world.phase !== "playing") {
          self.world.phase = "playing";
          self.hud.phase = "playing";
          self.input.enabled = true;
        }
        p.strikeT = strikeDuration(p);
        p.strikeCd = p.strikeT + 0.16;
        p.strikeHit = 0;
      },
      forceKick: () => {
        const p = self.world.player();
        if (self.world.phase !== "playing") {
          self.world.phase = "playing";
          self.hud.phase = "playing";
          self.input.enabled = true;
        }
        p.kickT = KICK_DUR;
        p.strikeHit = 0;
      },
      forceGrab: () => {
        const p = self.world.player();
        if (self.world.phase !== "playing") {
          self.world.phase = "playing";
          self.hud.phase = "playing";
          self.input.enabled = true;
        }
        if (!p.grabbedId) {
          p.grabT = GRAB_DUR;
          p.strikeHit = 0;
        }
      },
      setWeapon: (kind: string) => {
        const p = self.world.player();
        if (kind === "fist" || kind === "knife" || kind === "club" || kind === "spear" || kind === "torch" || kind === "board" || kind === "pitchfork") {
          p.weapon = kind;
          p.torchLit = kind === "torch";
        }
      },
      forceFlinch: (dir?: string) => {
        const p = self.world.player();
        if (self.world.phase !== "playing") {
          self.world.phase = "playing";
          self.hud.phase = "playing";
          self.input.enabled = true;
        }
        p.flinchT = FLINCH_DUR;
        if (p.body) p.body.lastHit = P.head;
        if (dir === "right") {
          const r = rightOf(p.yaw);
          p.hitNx = r.x;
          p.hitNz = r.z;
        } else {
          const f = facing(p.yaw);
          p.hitNx = -f.x;
          p.hitNz = -f.z;
        }
      },
      forceStruggle: () => {
        const p = self.world.player();
        if (self.world.phase !== "playing") {
          self.world.phase = "playing";
          self.hud.phase = "playing";
          self.input.enabled = true;
        }
        let best: typeof p | null = null;
        let bd = 80;
        for (const o of self.world.actors) {
          if (o.id === p.id || !o.alive) continue;
          if (o.kind !== "human") continue;
          const d = Math.hypot(o.x - p.x, o.z - p.z);
          if (d < bd) {
            bd = d;
            best = o;
          }
        }
        if (!best) return false;
        const f = facing(p.yaw);
        best.x = p.x - f.x * 0.7;
        best.z = p.z - f.z * 0.7;
        best.y = p.y;
        reposeActor(best);
        reposeActor(p);
        p.grabbedBy = best.id;
        best.grabbedId = p.id;
        const dx = p.x - best.x;
        const dz = p.z - best.z;
        const d = Math.hypot(dx, dz) || 1;
        p.hitNx = dx / d;
        p.hitNz = dz / d;
        setGrab(best, p);
        return true;
      },
      forceGrabbedPunch: () => {
        const ok = window.__controlsTest?.forceStruggle?.();
        if (ok === false) return false;
        const p = self.world.player();
        p.strikeT = strikeDuration(p);
        p.strikeCd = p.strikeT;
        p.strikeHit = 0;
        p.stamina = Math.max(0.4, p.stamina);
        return true;
      },
      getCombat: () => {
        const p = self.world.player();
        let best: { d: number; loco: string; pain: number; id: number; balance: number; flinchT?: number } | null = null;
        for (const o of self.world.actors) {
          if (o.id === p.id) continue;
          const d = Math.hypot(o.x - p.x, o.z - p.z);
          if (!best || d < best.d) best = { d, loco: o.loco, pain: o.pain, id: o.id, balance: o.balance, flinchT: o.flinchT };
        }
        const hand = p.body?.parts[6];
        const left = p.body?.parts[4];
        const head = p.body?.parts[2];
        const f = facing(p.yaw);
        const r = rightOf(p.yaw);
        const wpn = weaponEnds(p);
        const fwd = (x: number, z: number) => (x - p.x) * f.x + (z - p.z) * f.z;
        const side = (x: number, z: number) => (x - p.x) * r.x + (z - p.z) * r.z;
        const hn = Math.hypot(p.hitNx, p.hitNz);
        const peel =
          hand && hn > 0.1 ? ((hand.x - p.x) * -p.hitNx + (hand.z - p.z) * -p.hitNz) / hn : 0;
        const mesh = self.view.actorMap.get(p.id);
        const wepMesh = mesh?.userData?.parts?.wep as { children?: unknown[]; userData?: { kind?: string } } | undefined;
        return {
          strikeT: p.strikeT,
          kickT: p.kickT,
          shoveT: p.shoveT,
          grabT: p.grabT,
          flinchT: p.flinchT,
          grabbedBy: p.grabbedBy,
          grabbedId: p.grabbedId,
          weapon: p.weapon,
          twoHand: p.body?.grab?.myPart2 ?? -1,
          handFwd: hand ? fwd(hand.x, hand.z) : 0,
          handY: hand ? hand.y - p.y : 0,
          leftFwd: left ? fwd(left.x, left.z) : 0,
          headSide: head ? side(head.x, head.z) : 0,
          headY: head ? head.y - p.y : 0,
          headFwd: head ? fwd(head.x, head.z) : 0,
          wepFwd: wpn ? fwd(wpn.bx, wpn.bz) : 0,
          wepLen: wpn ? wpn.wepLen : 0,
          wepKids: wepMesh?.children?.length ?? 0,
          wepKind: wepMesh?.userData?.kind ?? p.weapon,
          peel,
          nearest: best,
          support: p.body?.support ?? 0,
          loco: p.loco,
          mode: p.body?.mode ?? "",
          pain: p.pain,
          rarm: injurySum(p.injuries.rarm) + p.injuries.rarm.fracture,
          cutR: p.injuries.rarm.cut,
          chestW: (mesh?.userData?.parts?.torso as { scale?: { x: number } } | undefined)?.scale?.x ?? 0,
          hands: !!(mesh?.userData?.parts?.lhand && mesh?.userData?.parts?.rhand),
          feet: !!(mesh?.userData?.parts?.lfoot && mesh?.userData?.parts?.rfoot),
          meshRev: mesh?.userData?.rev ?? 0,
        };
      },
      forceInjure: (region?: string, kind?: string) => {
        const p = self.world.player();
        if (self.world.phase !== "playing") {
          self.world.phase = "playing";
          self.hud.phase = "playing";
          self.input.enabled = true;
        }
        const r = (region === "head" || region === "torso" || region === "larm" || region === "rarm" || region === "lleg" || region === "rleg" ? region : "rarm") as Region;
        const inj = p.injuries[r];
        if (kind === "cut") inj.cut += 0.7;
        else if (kind === "burn") inj.burn += 0.55;
        else if (kind === "break") inj.fracture += 0.5;
        else inj.bruise += 0.8;
        p.pain = Math.min(1, p.pain + 0.35);
        if (kind === "cut") p.bleed = Math.min(1, p.bleed + 0.2);
      },
      forceVictim: () => {
        const p = self.world.player();
        if (self.world.phase !== "playing") {
          self.world.phase = "playing";
          self.hud.phase = "playing";
          self.input.enabled = true;
        }
        let best: typeof p | null = null;
        let bd = 80;
        for (const o of self.world.actors) {
          if (o.id === p.id || !o.alive || o.kind !== "human") continue;
          const d = Math.hypot(o.x - p.x, o.z - p.z);
          if (d < bd) {
            bd = d;
            best = o;
          }
        }
        if (!best) return false;
        const f = facing(p.yaw);
        best.x = p.x + f.x * 0.62;
        best.z = p.z + f.z * 0.62;
        best.y = p.y;
        best.yaw = p.yaw + Math.PI;
        best.balance = 1;
        best.loco = "idle";
        if (best.body) best.body.mode = "stance";
        reposeActor(best);
        reposeActor(p);
        return true;
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
      getBody?: () => {
        mode: string;
        support: number;
        lastVn: number;
        lastHit: number;
        n: number;
        pelvisY: number;
        locoT?: number;
        getupT?: number;
        spd?: number;
      } | null;
      forceRagdoll?: () => void;
      forceStrike?: () => void;
      forceKick?: () => void;
      forceGrab?: () => void;
      forceFlinch?: (dir?: string) => void;
      forceStruggle?: () => boolean;
      forceGrabbedPunch?: () => boolean;
      forceInjure?: (region?: string, kind?: string) => void;
      forceVictim?: () => boolean;
      setWeapon?: (kind: string) => void;
      getCombat?: () => unknown;
      setKeys?: (codes: string[]) => void;
      setSteer?: (v: number) => void;
    };
  }
}
