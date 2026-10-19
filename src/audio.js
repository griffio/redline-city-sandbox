// Audio: sample-based V8 + tyres from real CC0 recordings (assets/audio, see CREDITS.md),
// with the old procedural synth kept as a fallback if the samples can't be loaded.
//
// Engine: two buses (on-load / off-load) blended by throttle. Each bus is a stack of seamless
// RPM loops; the two neighbours of the current RPM are equal-power crossfaded in log-RPM and
// each is pitch-corrected with playbackRate = rpm / loopRpm, so the pitch is always exact.
// The announcer uses Deepgram Aura TTS via /api/voice (dev server or Cloudflare Worker).

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const AUDIO_ROOT = 'assets/audio/';
import { aiAvailable } from './api.js';

const SMOOTH = 0.03; // seconds, gain/rate smoothing

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.voiceEnabled = true;
    this.voices = new Map();
    this.lastVoice = 0;
    this.samples = null; // set once the recorded sounds are decoded
    this.load = 0; // smoothed engine load 0..1
    this.prevHandbrake = false;
    this.lastHandbrakeFx = 0;
  }

  /** Must be called from a user gesture. */
  start() {
    if (this.ctx) return;
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.7 : 0;
    this.master.connect(ctx.destination);

    // shared noise buffer (road rumble, impacts, whoosh, synth fallback)
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    // road / wind rumble
    const rn = ctx.createBufferSource();
    rn.buffer = buf;
    rn.loop = true;
    this.roadFilter = ctx.createBiquadFilter();
    this.roadFilter.type = 'lowpass';
    this.roadFilter.frequency.value = 300;
    this.roadGain = ctx.createGain();
    this.roadGain.gain.value = 0;
    rn.connect(this.roadFilter).connect(this.roadGain).connect(this.master);
    rn.start();

    this.buildSynth();
    this.loadSamples().catch((err) => console.warn('Engine samples unavailable, using synth:', err));
  }

  // ------------------------------------------------------------------ recorded samples
  async loadSamples() {
    const ctx = this.ctx;
    const manifest = await (await fetch(`${AUDIO_ROOT}manifest.json`)).json();
    const cache = new Map();
    const get = (file) => {
      if (!cache.has(file)) {
        cache.set(file, fetch(AUDIO_ROOT + file)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${file}: HTTP ${r.status}`))))
          .then((b) => ctx.decodeAudioData(b)));
      }
      return cache.get(file);
    };
    const E = manifest.engine;
    // off-load below the recorded overrun range reuses the on-load loops through a low-pass
    const onDefs = [E.idle, ...E.on];
    const offDefs = [E.idle, ...E.on.filter((l) => l.rpm < Math.min(...E.off.map((o) => o.rpm)) - 400), ...E.off];
    const load = async (defs) => Promise.all(defs.map(async (d) => ({ rpm: d.rpm, buffer: await get(d.file) })));
    const [on, off, squeal, spin, handbrake] = await Promise.all([
      load(onDefs), load(offDefs), get(manifest.tyres.squeal), get(manifest.tyres.spin), get(manifest.tyres.handbrake),
    ]);

    const engineOut = ctx.createGain();
    engineOut.gain.value = 0;
    engineOut.connect(this.master);
    const onBus = ctx.createGain();
    onBus.connect(engineOut);
    const offFilter = ctx.createBiquadFilter();
    offFilter.type = 'lowpass';
    offFilter.frequency.value = 1500;
    offFilter.Q.value = 0.5;
    const offBus = ctx.createGain();
    offBus.connect(offFilter).connect(engineOut);
    const t0 = ctx.currentTime + 0.05;
    const layers = (list, bus) => list.sort((a, b) => a.rpm - b.rpm).map((l, i) => {
      const src = ctx.createBufferSource();
      src.buffer = l.buffer;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(bus);
      // stagger start offsets so layers sharing a buffer don't phase-lock
      src.start(t0, (i * 0.137) % l.buffer.duration);
      return { rpm: l.rpm, src, gain, w: 0 };
    });

    const loop = (buffer, dest) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(dest);
      src.start(t0, Math.random() * buffer.duration);
      return { src, gain };
    };

    this.samples = {
      engineOut, onBus, offBus, offFilter,
      on: layers(on, onBus),
      off: layers(off, offBus),
      squeal: loop(squeal, this.master),
      spin: loop(spin, this.master),
      handbrake,
    };
    // hand over from the synth, then stop its sources so they don't keep running silently
    this.synthGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
    this.sqGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
    const stopAt = ctx.currentTime + 0.6;
    for (const node of this.synthSources) node.stop(stopAt);
  }

  /** Equal-power crossfade weights for the layers bracketing rpm (log-RPM space). */
  static weights(layers, rpm) {
    for (const l of layers) l.w = 0;
    const n = layers.length;
    if (rpm <= layers[0].rpm) { layers[0].w = 1; return; }
    if (rpm >= layers[n - 1].rpm) { layers[n - 1].w = 1; return; }
    let i = 0;
    while (layers[i + 1].rpm < rpm) i++;
    const a = layers[i], b = layers[i + 1];
    let t = Math.log(rpm / a.rpm) / Math.log(b.rpm / a.rpm);
    // across a wide gap (idle → low revs) keep each loop near its native pitch for longer
    if (b.rpm / a.rpm > 1.6) t = clamp((t - 0.3) / 0.4, 0, 1);
    a.w = Math.cos((t * Math.PI) / 2);
    b.w = Math.sin((t * Math.PI) / 2);
  }

  updateSamples(car, cmd, now) {
    const S = this.samples;
    const rpm = clamp(car.rpm, 500, 8000);
    // engine load: throttle, briefly cut during gear changes so upshifts get the real "lift"
    let target = cmd.throttle;
    if (car.gear === -1) target = cmd.brake; // reverse uses the brake pedal as throttle
    if (car.shiftTimer > 0.05) target *= 0.15;
    this.load += (target - this.load) * 0.18;
    const load = this.load;
    const rpmN = clamp((rpm - 800) / 6400, 0, 1);

    S.engineOut.gain.setTargetAtTime(0.5 * (0.45 + 0.55 * rpmN), now, SMOOTH);
    S.onBus.gain.setTargetAtTime(0.2 + 0.8 * load, now, SMOOTH);
    S.offBus.gain.setTargetAtTime((1 - load) * 0.75, now, SMOOTH);
    S.offFilter.frequency.setTargetAtTime(900 + rpmN * 1600, now, SMOOTH);
    for (const bus of [S.on, S.off]) {
      Audio.weights(bus, rpm);
      for (const l of bus) {
        l.gain.gain.setTargetAtTime(l.w, now, SMOOTH);
        if (l.w > 0.001) l.src.playbackRate.setTargetAtTime(clamp(rpm / l.rpm, 0.4, 2.4), now, 0.02);
      }
    }

    // tyres: squeal follows lateral slide; locked wheels scrub lower; wheelspin gets the burnout loop
    const slide = Math.max(...car.wheelSlide);
    const speed = car.speed;
    const locked = (car.locked.front || car.locked.rear) && speed > 1.5;
    const squeal = clamp(car.slideLat, 0, 1) * clamp(speed / 7, 0, 1);
    S.squeal.gain.gain.setTargetAtTime(squeal * squeal * 0.75 + squeal * 0.25, now, 0.04);
    const rate = locked ? 0.78 + speed * 0.002 : 0.9 + slide * 0.12 + Math.min(speed, 40) * 0.003;
    S.squeal.src.playbackRate.setTargetAtTime(rate, now, 0.06);
    const spin = car.wheelspin * (speed < 12 ? 1 : 0.65);
    S.spin.gain.gain.setTargetAtTime(spin * 0.7, now, 0.05);
    S.spin.src.playbackRate.setTargetAtTime(0.88 + car.wheelspin * 0.22, now, 0.06);

    const hb = cmd.handbrake > 0.1;
    if (hb && !this.prevHandbrake && speed > 6 && performance.now() - this.lastHandbrakeFx > 600) {
      this.lastHandbrakeFx = performance.now();
      const src = this.ctx.createBufferSource();
      src.buffer = S.handbrake;
      src.playbackRate.value = 0.94 + Math.random() * 0.12;
      const g = this.ctx.createGain();
      g.gain.value = clamp(speed / 22, 0.25, 1) * 0.8;
      src.connect(g).connect(this.master);
      src.start();
    }
    this.prevHandbrake = hb;
  }

  // ------------------------------------------------------------------ synth fallback
  buildSynth() {
    const ctx = this.ctx;
    this.synthGain = ctx.createGain();
    this.synthGain.gain.value = 1;
    this.synthGain.connect(this.master);

    // engine: two detuned saws + sub square → waveshaper → lowpass
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 2.5;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) curve[i] = Math.tanh(((i / 1023) * 2 - 1) * 2.2);
    shaper.curve = curve;
    this.osc = [];
    for (const [type, gain, detune] of [['sawtooth', 0.45, -7], ['sawtooth', 0.35, 9], ['square', 0.35, 0]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(shaper);
      o.start();
      this.osc.push({ o, mult: type === 'square' ? 0.5 : 1 });
    }
    this.synthSources = this.osc.map(({ o }) => o);
    shaper.connect(this.engFilter).connect(this.engGain).connect(this.synthGain);

    // tyre squeal: band-passed noise + wobbling saw
    const nz = ctx.createBufferSource();
    nz.buffer = this.noiseBuf;
    nz.loop = true;
    this.sqFilter = ctx.createBiquadFilter();
    this.sqFilter.type = 'bandpass';
    this.sqFilter.Q.value = 9;
    this.sqFilter.frequency.value = 1100;
    this.sqTone = ctx.createOscillator();
    this.sqTone.type = 'sawtooth';
    this.sqTone.frequency.value = 900;
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 35;
    lfo.connect(lfoGain).connect(this.sqTone.frequency);
    this.sqGain = ctx.createGain();
    this.sqGain.gain.value = 0;
    nz.connect(this.sqFilter);
    this.sqTone.connect(toneGain).connect(this.sqFilter);
    this.sqFilter.connect(this.sqGain).connect(this.master);
    nz.start();
    this.sqTone.start();
    lfo.start();
    this.synthSources.push(nz, this.sqTone, lfo);
  }

  updateSynth(car, cmd, t) {
    const rpm = car.rpm;
    const throttle = cmd.throttle;
    const f = (rpm / 60) * 2; // 4-cylinder firing frequency
    for (const { o, mult } of this.osc) o.frequency.setTargetAtTime(f * mult, t, 0.02);
    this.engFilter.frequency.setTargetAtTime(300 + throttle * 2200 + rpm * 0.25, t, 0.04);
    this.engGain.gain.setTargetAtTime(0.07 + throttle * 0.1 + (rpm / 7000) * 0.04, t, 0.05);
    const slide = Math.max(...car.wheelSlide);
    const speed = car.speed;
    const locked = car.locked.front || car.locked.rear;
    this.sqGain.gain.setTargetAtTime(slide * Math.min(1, speed / 8 + car.wheelspin) * 0.28, t, 0.04);
    const pitch = (locked ? 650 : 950) + Math.min(speed, 40) * 6 + slide * 120;
    this.sqFilter.frequency.setTargetAtTime(pitch, t, 0.05);
    this.sqTone.frequency.setTargetAtTime(pitch * 0.82, t, 0.05);
  }

  // ------------------------------------------------------------------ per frame
  resume() {
    this.ctx?.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.7 : 0, this.ctx.currentTime, 0.05);
  }

  /** @param cmd the car command for this frame ({throttle, brake, handbrake, ...}) */
  update(car, cmd) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.samples) this.updateSamples(car, cmd, t);
    else this.updateSynth(car, cmd, t);
    const speed = car.speed;
    this.roadGain.gain.setTargetAtTime(Math.min(0.12, speed * 0.003), t, 0.1);
    this.roadFilter.frequency.setTargetAtTime(150 + speed * 12, t, 0.1);
  }

  impact(strength) {
    if (!this.ctx || strength < 0.3) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 220 + strength * 120;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(1, strength * 0.12), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.4);
  }

  whoosh(level) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.5;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(2400 + level * 800, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.7 + level * 0.2);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 1.2);
  }

  /** Fetch + cache a TTS line from the dev server. Fails silently (e.g. static hosting). */
  async loadVoice(text) {
    if (!this.ctx || this.voices.has(text)) return this.voices.get(text);
    const p = aiAvailable()
      .then((ok) => (ok ? fetch(`api/voice?text=${encodeURIComponent(text)}`) : Promise.reject(new Error('no AI backend'))))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
      .then((b) => this.ctx.decodeAudioData(b))
      .catch(() => null);
    this.voices.set(text, p);
    return p;
  }

  async say(text) {
    if (!this.ctx || !this.voiceEnabled || !this.enabled) return;
    const now = performance.now();
    if (now - this.lastVoice < 1800) return;
    this.lastVoice = now;
    const buf = await this.loadVoice(text);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.9;
    src.connect(g).connect(this.master);
    src.start();
  }
}
