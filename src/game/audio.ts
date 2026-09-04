type Bus = "master" | "sfx" | "music";

export class GameAudio {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  sfx: GainNode | null = null;
  music: GainNode | null = null;
  muted = false;
  volume = 0.85;
  private noise: AudioBuffer | null = null;
  private last: Record<string, number> = {};
  private rain: GainNode | null = null;
  private fire: GainNode | null = null;
  private drone: GainNode | null = null;

  unlock() {
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC({ latencyHint: "interactive" });
      this.master = this.ctx.createGain();
      this.sfx = this.ctx.createGain();
      this.music = this.ctx.createGain();
      this.sfx.connect(this.master);
      this.music.connect(this.master);
      this.master.connect(this.ctx.destination);
      this.master.gain.value = this.muted ? 0 : this.volume * this.volume;
      this.sfx.gain.value = 0.9;
      this.music.gain.value = 0.28;
      this.noise = this.makeNoise();
      this.startBeds();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.applyVol();
  }

  setVolume(v: number) {
    this.volume = v;
    this.applyVol();
  }

  private applyVol() {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(
      this.muted ? 0 : this.volume * this.volume,
      this.ctx.currentTime,
      0.04,
    );
  }

  resume() {
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  private makeNoise(): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 1.2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  private startBeds() {
    if (!this.ctx || !this.music || !this.noise) return;
    const ctx = this.ctx;
    const drone = ctx.createGain();
    drone.gain.value = 0.0;
    drone.connect(this.music);
    const o1 = ctx.createOscillator();
    o1.type = "sine";
    o1.frequency.value = 46;
    const o2 = ctx.createOscillator();
    o2.type = "triangle";
    o2.frequency.value = 69.5;
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
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
    f.Q.value = 0.5;
    src.connect(f).connect(rain).connect(this.sfx!);
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
    fs.connect(ff).connect(fire).connect(this.sfx!);
    fs.start();
    this.fire = fire;
  }

  setBeds(rain: number, fire: number, danger: number, timeOfDay: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.rain?.gain.setTargetAtTime(Math.min(0.22, rain * 0.22), t, 0.4);
    this.fire?.gain.setTargetAtTime(Math.min(0.16, fire * 0.05), t, 0.3);
    const night = timeOfDay < 0.22 || timeOfDay > 0.78 ? 0.08 : 0.03;
    this.drone?.gain.setTargetAtTime(night + danger * 0.1, t, 0.6);
  }

  play(kind: string, mag = 1, pan = 0) {
    if (!this.ctx || !this.sfx || !this.noise) return;
    const now = this.ctx.currentTime;
    const last = this.last[kind] ?? 0;
    if (now - last < 0.04) return;
    this.last[kind] = now;
    const g = this.ctx.createGain();
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-0.85, Math.min(0.85, pan));
    g.connect(p).connect(this.sfx);
    const m = Math.max(0.04, Math.min(1.4, mag));

    const beep = (freq: number, dur: number, type: OscillatorType, vol: number, slide = 0) => {
      const o = this.ctx!.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, now);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), now + dur);
      const og = this.ctx!.createGain();
      og.gain.setValueAtTime(vol * m, now);
      og.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      o.connect(og).connect(g);
      o.start(now);
      o.stop(now + dur + 0.02);
    };
    const burst = (dur: number, vol: number, hp: number, lp: number, rate = 1) => {
      const s = this.ctx!.createBufferSource();
      s.buffer = this.noise;
      s.playbackRate.value = rate * (0.9 + Math.random() * 0.2);
      const f1 = this.ctx!.createBiquadFilter();
      f1.type = "highpass";
      f1.frequency.value = hp;
      const f2 = this.ctx!.createBiquadFilter();
      f2.type = "lowpass";
      f2.frequency.value = lp;
      const og = this.ctx!.createGain();
      og.gain.setValueAtTime(vol * m, now);
      og.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      s.connect(f1).connect(f2).connect(og).connect(g);
      s.start(now);
      s.stop(now + dur + 0.02);
    };

    switch (kind) {
      case "step":
        burst(0.08, 0.18, 80, 420, 0.7 + Math.random() * 0.4);
        break;
      case "sprint":
        burst(0.09, 0.26, 60, 500, 0.85);
        break;
      case "impact":
        burst(0.16, 0.45, 40, 700, 0.5);
        beep(90, 0.12, "sine", 0.2, -40);
        break;
      case "wood":
        burst(0.14, 0.35, 200, 1800, 1.1);
        beep(180, 0.08, "triangle", 0.12, -80);
        break;
      case "break":
        burst(0.28, 0.5, 100, 2400, 0.9);
        beep(140, 0.18, "sawtooth", 0.08, -90);
        break;
      case "collapse":
        burst(0.8, 0.7, 30, 600, 0.35);
        beep(55, 0.5, "sine", 0.28, -20);
        break;
      case "scream":
        beep(420 + Math.random() * 80, 0.45, "sawtooth", 0.12, 60);
        burst(0.4, 0.2, 600, 3000, 1.4);
        break;
      case "shout":
        beep(220, 0.22, "square", 0.1, -30);
        burst(0.2, 0.22, 300, 1600, 1);
        break;
      case "weapon":
        burst(0.1, 0.28, 400, 4000, 1.6);
        beep(240, 0.07, "triangle", 0.08, -120);
        break;
      case "fire":
        burst(0.2, 0.18, 200, 1200, 1.3);
        break;
      case "splash":
        burst(0.22, 0.3, 300, 2200, 0.8);
        break;
      case "animal":
        beep(140 + Math.random() * 90, 0.25, "sawtooth", 0.1, -50);
        break;
      case "whoosh":
        burst(0.12, 0.2, 500, 5000, 2);
        break;
      case "hurt":
        beep(160, 0.14, "sine", 0.16, -70);
        burst(0.12, 0.2, 100, 800, 0.6);
        break;
      case "grab":
        burst(0.08, 0.22, 150, 900, 0.7);
        break;
      case "ui":
        beep(520, 0.08, "sine", 0.08, 0);
        break;
      case "thunder":
        burst(1.2, 0.8, 20, 280, 0.25);
        beep(40, 0.8, "sine", 0.3, -10);
        break;
      default:
        burst(0.1, 0.2, 100, 1000, 1);
    }
  }
}
