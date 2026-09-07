import { GameAudio as CoreAudio } from "./audio-core";

const RICH_EVENTS = new Set(["impact", "hurt", "wood", "break", "collapse", "metal", "weapon", "whoosh", "step", "sprint", "fire", "splash", "shout", "scream"]);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Event and environment audio share the original game's sound bus.
 * The environment is read-only; no audio callback mutates simulation state.
 * Inspired by the Claude/Grok weather beds, with material-aware transient
 * layers and bounded dynamic range rather than continuously loud ambience.
 */
export class GameAudio extends CoreAudio {
  private ambient: GainNode | null = null;
  private rain: GainNode | null = null;
  private wind: GainNode | null = null;
  private fire: GainNode | null = null;
  private drone: GainNode | null = null;
  private richNoise: AudioBuffer | null = null;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private randomState = 0x9e3779b9;
  private nextCrackle = 0;
  private lastVoice = -Infinity;
  private readonly lastEvent = new Map<string, number>();
  private disposed = false;

  private random() {
    let x = this.randomState;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.randomState = x >>> 0;
    return (this.randomState >>> 0) / 4294967296;
  }

  override unlock() {
    if (this.disposed) return;
    super.unlock();
    if (this.ambient || !this.ctx || !this.sfx || !this.music) return;
    const ctx = this.ctx;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.16;
    this.master!.disconnect();
    this.master!.connect(compressor).connect(ctx.destination);
    this.ambient = ctx.createGain();
    this.ambient.gain.value = 0.58;
    this.ambient.connect(this.sfx);
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = this.random() * 2 - 1;
    this.richNoise = noise;
    const bed = (kind: BiquadFilterType, frequency: number, q: number) => {
      const src = ctx.createBufferSource();
      src.buffer = noise; src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = kind; filter.frequency.value = frequency; filter.Q.value = q;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.ambient!);
      src.start(); this.sources.push(src);
      return gain;
    };
    this.rain = bed("bandpass", 1800, 0.44);
    this.wind = bed("lowpass", 340, 0.55);
    this.fire = bed("lowpass", 950, 0.6);
    this.drone = ctx.createGain();
    this.drone.gain.value = 0;
    this.drone.connect(this.music);
    const tone = (freq: number, type: OscillatorType, gain: number) => {
      const osc = ctx.createOscillator(); osc.type = type; osc.frequency.value = freq;
      const g = ctx.createGain(); g.gain.value = gain;
      osc.connect(g).connect(this.drone!); osc.start(); this.sources.push(osc);
    };
    tone(46, "sine", 0.8); tone(69.5, "triangle", 0.16);
    this.music.gain.value = 0.22;
  }

  setBeds(rain: number, fire: number, danger: number, timeOfDay: number, wind = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.ambient) return;
    const t = ctx.currentTime;
    this.rain?.gain.setTargetAtTime(clamp01(rain) * 0.24, t, 0.45);
    this.wind?.gain.setTargetAtTime(clamp01(wind / 8) * 0.18, t, 0.6);
    const fireLevel = clamp01(fire / 2);
    this.fire?.gain.setTargetAtTime(fireLevel * 0.13, t, 0.3);
    const night = timeOfDay < 0.22 || timeOfDay > 0.78 ? 0.025 : 0.008;
    this.drone?.gain.setTargetAtTime(night + clamp01(danger) * 0.045, t, 0.6);
    if (fireLevel > 0.08 && t >= this.nextCrackle) {
      this.nextCrackle = t + 0.13 + this.random() * 0.35 / Math.max(0.2, fireLevel);
      this.transient("fire", fireLevel * (0.2 + this.random() * 0.3), this.random() * 0.5 - 0.25);
    }
  }

  private transient(kind: string, mag: number, pan: number) {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || !this.richNoise || this.disposed) return;
    const t = ctx.currentTime;
    const m = Math.max(0.01, Math.min(1.6, mag));
    const out = ctx.createGain();
    const stereo = ctx.createStereoPanner();
    let pending = 0;
    const done = () => {
      if (--pending === 0) { out.disconnect(); stereo.disconnect(); }
    };
    stereo.pan.value = Math.max(-0.85, Math.min(0.85, pan));
    out.connect(stereo).connect(this.sfx);
    const burst = (duration: number, gain: number, hp: number, lp: number, rate = 1) => {
      pending++;
      const src = ctx.createBufferSource(); src.buffer = this.richNoise;
      src.playbackRate.value = rate * (0.88 + this.random() * 0.24);
      const high = ctx.createBiquadFilter(); high.type = "highpass"; high.frequency.value = hp;
      const low = ctx.createBiquadFilter(); low.type = "lowpass"; low.frequency.value = lp;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(Math.max(0.0002, gain * m), t + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      src.connect(high).connect(low).connect(env).connect(out);
      src.start(t); src.stop(t + duration + 0.01);
      src.onended = () => { src.disconnect(); high.disconnect(); low.disconnect(); env.disconnect(); done(); };
    };
    const tone = (freq: number, end: number, duration: number, gain: number, type: OscillatorType = "sine") => {
      const osc = ctx.createOscillator(); osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, end), t + duration);
      const env = ctx.createGain(); env.gain.setValueAtTime(Math.max(0.0001, gain * m), t);
      env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(env).connect(out); osc.start(t); osc.stop(t + duration + 0.01);
      osc.onended = () => { osc.disconnect(); env.disconnect(); done(); };
    };
    if (kind === "impact" || kind === "hurt") {
      burst(0.12, 0.25, 55, 1200); tone(105, 48, 0.15, 0.11);
    } else if (kind === "wood" || kind === "break" || kind === "collapse") {
      burst(kind === "collapse" ? 0.7 : 0.22, 0.32, 85, 2500, 0.65);
      tone(kind === "collapse" ? 65 : 185, 42, kind === "collapse" ? 0.55 : 0.13, 0.13);
    } else if (kind === "metal") {
      burst(0.09, 0.18, 600, 7000); tone(610, 540, 0.34, 0.12, "triangle");
      tone(1170, 920, 0.23, 0.045, "sine");
    } else if (kind === "weapon" || kind === "whoosh") {
      burst(0.12, 0.2, 450, 5400, 1.4);
    } else if (kind === "step" || kind === "sprint") {
      burst(0.07, 0.12, 90, 700, 0.8);
    } else if (kind === "fire") {
      burst(0.07, 0.09, 250, 2300, 1.2);
    } else if (kind === "splash") {
      burst(0.25, 0.22, 180, 3000, 0.75);
    } else if (kind === "shout" || kind === "scream") {
      const base = kind === "scream" ? 300 : 170;
      tone(base, base * 1.35, kind === "scream" ? 0.48 : 0.23, 0.1, "sawtooth");
      burst(0.2, 0.1, 250, 2400);
    }
  }

  override play(kind: string, mag = 1, pan = 0) {
    if (this.disposed) return;
    // Unhandled cues retain the original audio path, including UI, thunder,
    // animals and grab. No existing event silently becomes inaudible.
    if (!RICH_EVENTS.has(kind)) {
      super.play(kind, mag, pan);
      return;
    }
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const last = this.lastEvent.get(kind) ?? -Infinity;
    if (t - last < 0.035) return;
    this.lastEvent.set(kind, t);
    if ((kind === "shout" || kind === "scream") && t - this.lastVoice < 0.16) return;
    if (kind === "shout" || kind === "scream") this.lastVoice = t;
    this.transient(kind, mag, pan);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const src of this.sources) { try { src.stop(); } catch { /* already stopped */ } src.disconnect(); }
    this.sources.length = 0;
    this.lastEvent.clear();
    this.richNoise = null;
    this.ambient?.disconnect(); this.drone?.disconnect();
    this.ambient = this.rain = this.wind = this.fire = this.drone = null;
    if (this.ctx && this.ctx.state !== "closed") void this.ctx.close();
    this.ctx = null; this.master = this.sfx = this.music = null;
  }
}
