import { Renderer } from './gpu/renderer.js';
import { Car, DEFAULT_TUNING, PRESETS } from './physics/car.js';
import { World } from './physics/world.js';
import { Input, INPUT_TUNING } from './input.js';
import { SCHEMES, CONTROL_TUNING } from './controls.js';
import { Camera, CAMERA_TUNING } from './camera.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { buildAtlas, paintCarRegion, paintDetailedCar, renderCarForAI, REGIONS, CAR_COLORS } from './sprites.js';

const PHYS_DT = 1 / 240;
const STORAGE_KEY = 'redline.sandbox.v1';
const SPAWN = [0, 0, Math.PI / 2];

const store = {
  load() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; } },
  save(v) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};

class Game {
  async init() {
    this.canvas = document.getElementById('gpu');
    this.renderer = new Renderer();
    await this.renderer.init(this.canvas);
    this.world = new World();
    this.car = new Car();
    this.camera = new Camera();
    this.input = new Input();
    this.audio = new Audio();
    this.particles = [];
    this.lastMark = [null, null, null, null];
    this.score = { active: false, points: 0, mult: 1, time: 0, idle: 0, best: 0, total: 0, flash: 0, flashText: '', flashBad: false };
    this.carLook = { color: CAR_COLORS.Redline, colorName: 'Redline', stripes: true };
    this.aiSpriteUrl = null;
    this.scheme = SCHEMES[0];
    this.preset = 'Balanced';
    // resolution: 'auto' adapts render scale to hold ~60fps; numbers are fixed fractions of native
    this.perf = { mode: 'auto', scale: 1, timer: 0, frames: 0, dtSum: 0, fps: 0, cooldown: 2, slow: 0 }; // cooldown doubles as startup warm-up

    const saved = store.load();
    if (saved) this.restore(saved);
    else this.setScheme('chase', true);

    this.atlas = buildAtlas(this.carLook);
    this.atlasCtx = this.atlas.getContext('2d');
    this.renderer.uploadAtlas(this.atlas);
    if (this.aiSpriteUrl) this.loadAiSprite(this.aiSpriteUrl).catch(() => { this.aiSpriteUrl = null; });

    this.ui = new UI(this);
    this.resetCar();
    this.input.onPadChange = (id, on) => this.toast(on ? `🎮 ${id.split('(')[0].trim()} connected` : 'Controller disconnected');

    const startAudio = () => {
      this.audio.start();
      this.audio.resume();
      for (const line of ['Nice drift!', 'Great drift!', 'Insane drift!', 'Mini turbo!', 'Wrecked!']) this.audio.loadVoice(line);
      document.getElementById('start').classList.add('hidden');
    };
    addEventListener('keydown', startAudio, { once: true });
    addEventListener('pointerdown', startAudio, { once: true });

    this.last = performance.now();
    this.acc = 0;
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---------------------------------------------------------------- settings
  setScheme(id, applyDefaults) {
    this.scheme = SCHEMES.find((s) => s.id === id) || SCHEMES[0];
    if (applyDefaults) {
      CAMERA_TUNING.mode = this.scheme.camera;
      this.car.model = this.scheme.model;
      this.applyPreset(this.scheme.preset, false);
      this.camera.snap(this.car);
    }
    this.toast(this.scheme.name);
    this.save();
  }

  applyPreset(name, rebuild = true) {
    this.preset = name;
    Object.assign(this.car.t, DEFAULT_TUNING, PRESETS[name] || {});
    this.save();
    if (rebuild && this.ui) this.ui.build();
  }

  snapshot() {
    return {
      scheme: this.scheme.id, preset: this.preset, model: this.car.model,
      car: { ...this.car.t }, input: { ...INPUT_TUNING }, camera: { ...CAMERA_TUNING }, control: { ...CONTROL_TUNING },
      look: this.carLook, aiSpriteUrl: this.aiSpriteUrl,
      sound: this.audio.enabled, voice: this.audio.voiceEnabled, best: this.score.best, resolution: this.perf.mode,
    };
  }

  restore(s) {
    this.scheme = SCHEMES.find((x) => x.id === s.scheme) || SCHEMES[0];
    this.preset = s.preset || 'Balanced';
    this.car.model = s.model || this.scheme.model;
    Object.assign(this.car.t, DEFAULT_TUNING, s.car || {});
    Object.assign(INPUT_TUNING, s.input || {});
    Object.assign(CAMERA_TUNING, s.camera || {});
    Object.assign(CONTROL_TUNING, s.control || {});
    if (s.look) Object.assign(this.carLook, s.look);
    this.aiSpriteUrl = s.aiSpriteUrl || null;
    this.audio.enabled = s.sound ?? true;
    this.audio.voiceEnabled = s.voice ?? true;
    this.score.best = s.best || 0;
    this.setResolution(s.resolution ?? 'auto');
  }

  setResolution(mode) {
    this.perf.mode = mode;
    this.perf.scale = mode === 'auto' ? 1 : Number(mode);
    this.save();
  }

  /**
   * Dynamic resolution. Frame interval is the signal (it includes compositor cost the pass
   * timers can't see); GPU pass time stops it scaling back up into a GPU-bound state.
   */
  updatePerf(dt) {
    const P = this.perf;
    P.frames++;
    P.dtSum += dt;
    P.timer += dt;
    P.cooldown = Math.max(0, P.cooldown - dt);
    if (P.timer < 0.5) return;
    const avgMs = (P.dtSum / P.frames) * 1000;
    P.fps = P.frames / P.timer;
    P.timer = P.frames = P.dtSum = 0;
    if (P.mode !== 'auto' || P.cooldown > 0 || document.hidden) return;
    const gpu = this.renderer.gpuMs;
    // ignore one-off hitches (GC, shader compiles, another tab): need two slow windows in a row
    P.slow = avgMs > 18.5 ? (P.slow || 0) + 1 : 0;
    // only shed pixels when the GPU is a real share of the frame; otherwise resolution won't help
    const gpuBound = gpu == null || gpu > 6;
    if ((P.slow >= 2 || avgMs > 30) && gpuBound && P.scale > 0.5) {
      P.scale = Math.max(0.5, P.scale * (avgMs > 25 ? 0.82 : 0.9));
      P.cooldown = 0.5;
    } else if (avgMs < 17.4 && P.scale < 1 && (gpu == null || gpu < 9)) {
      P.scale = Math.min(1, P.scale * 1.06);
      P.cooldown = 2; // creep up slowly so it doesn't oscillate
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => store.save(this.snapshot()), 200);
  }

  resetCar() {
    this.car.reset(...SPAWN);
    this.lastMark = [null, null, null, null];
    this.camera.snap(this.car);
    this.score.active = false;
    this.score.points = 0;
  }

  toast(text) {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
  }

  // ---------------------------------------------------------------- car art
  setCarLook(patch) {
    Object.assign(this.carLook, patch);
    this.aiSpriteUrl = null; // AI detail is specific to a paint job
    paintCarRegion(this.atlasCtx, this.carLook);
    this.renderer.uploadAtlas(this.atlas);
    if (this.ui) {
      const ta = document.getElementById('aiPrompt');
      if (ta) ta.value = this.aiPrompt();
      this.setAiStatus('Using software-rendered sprite.');
    }
    this.save();
  }

  aiPrompt() {
    const stripes = this.carLook.stripes ? ' with two white racing stripes down the centre' : '';
    return `Photorealistic top-down orthographic view of this exact sports car seen from directly above. Keep the exact silhouette, proportions, position and ${this.carLook.colorName.toLowerCase()} paint${stripes}. Add realistic detail: glossy clear-coat reflections, panel gaps and shut lines, detailed headlights and tail lights, tinted glass with soft sky reflections, rear spoiler, side mirrors. Flat light grey background, no shadow, no text.`;
  }

  /** Status line for the AI panel; survives panel rebuilds (ui.build reads aiStatusText). */
  setAiStatus(text) {
    this.aiStatusText = text;
    if (this.ui?.aiStatus) this.ui.aiStatus.textContent = text;
  }

  async detailCarWithAI(prompt) {
    if (this.aiBusy) return;
    this.aiBusy = true;
    this.setAiStatus('Sending sprite to FLUX.2… (~10–20 s)');
    const look = JSON.stringify(this.carLook);
    try {
      const png = renderCarForAI(this.carLook).toDataURL('image/png').split(',')[1];
      const res = await fetch('/api/detail-car', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, image: png, width: 512, height: 1024 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.status);
      // the image is only valid for the paint job it was generated from
      if (JSON.stringify(this.carLook) !== look) {
        this.setAiStatus(`Paint changed while generating, so not applied (saved as ${json.url}).`);
        return;
      }
      await this.loadAiSprite(json.url);
      this.aiSpriteUrl = json.url;
      this.save();
      this.setAiStatus(`Done → ${json.url}`);
    } catch (e) {
      this.setAiStatus(`AI detail failed: ${e.message || e}. (Is the dev server running? npm start)`);
    } finally {
      this.aiBusy = false;
    }
  }

  async loadAiSprite(url) {
    const img = new Image();
    img.src = url;
    await img.decode();
    paintDetailedCar(this.atlasCtx, img, this.carLook);
    this.renderer.uploadAtlas(this.atlas);
  }

  useProceduralSprite() {
    this.aiSpriteUrl = null;
    this.setAiStatus('Using software-rendered sprite.');
    paintCarRegion(this.atlasCtx, this.carLook);
    this.renderer.uploadAtlas(this.atlas);
    this.save();
  }

  // ---------------------------------------------------------------- loop
  handleToggles() {
    const i = this.input;
    if (i.pressed('KeyR') || i.pressed('pad:Y') || i.pressed('pad:UP')) this.resetCar();
    if (i.pressed('KeyC') || i.pressed('pad:LB')) {
      const modes = ['velocity', 'heading', 'north'];
      CAMERA_TUNING.mode = modes[(modes.indexOf(CAMERA_TUNING.mode) + 1) % modes.length];
      this.toast(`Camera: ${CAMERA_TUNING.mode}`);
      this.ui.build();
      this.save();
    }
    for (const s of SCHEMES) {
      if (i.pressed(`Digit${s.key}`)) { this.setScheme(s.id, true); this.ui.build(); }
    }
    if (i.pressed('pad:BACK')) {
      const idx = (SCHEMES.indexOf(this.scheme) + 1) % SCHEMES.length;
      this.setScheme(SCHEMES[idx].id, true);
      this.ui.build();
    }
    if (i.pressed('pad:LEFT') || i.pressed('pad:RIGHT') || i.pressed('KeyP')) {
      const names = Object.keys(PRESETS);
      const dir = i.pressed('pad:LEFT') ? -1 : 1;
      const n = names[(names.indexOf(this.preset) + dir + names.length) % names.length];
      this.applyPreset(n);
      this.toast(`Handling: ${n}`);
    }
    if (i.pressed('Tab') || i.pressed('pad:START')) document.body.classList.toggle('panel-hidden');
    if (i.pressed('KeyM')) { this.audio.setEnabled(!this.audio.enabled); this.toast(this.audio.enabled ? 'Sound on' : 'Sound off'); }
    if (i.pressed('KeyH')) document.body.classList.toggle('help-hidden');
    if (i.pressed('KeyK')) this.renderer.clearSkids();
    if (i.pressed('KeyF')) document.body.classList.toggle('perf-hidden');
  }

  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const raw = this.input.update(dt);
    this.handleToggles();
    const cmd = this.scheme.map(raw, this.car, this.camera);

    this.acc += dt;
    let impact = 0;
    const wasBoost = this.car.drift.boost;
    while (this.acc >= PHYS_DT) {
      this.car.step(PHYS_DT, cmd);
      impact = Math.max(impact, this.world.step(PHYS_DT, this.car));
      this.emitSkids();
      this.acc -= PHYS_DT;
    }
    if (this.car.drift.boost > wasBoost + 0.1) {
      this.audio.whoosh(this.car.lastBoostLevel);
      if (this.car.lastBoostLevel === 3) this.audio.say('Mini turbo!');
    }
    if (impact > 1) {
      this.camera.addShake(Math.min(1.2, impact / 10));
      this.audio.impact(impact);
      this.input.rumble(Math.min(1, impact / 8), 0.3, 160);
    }
    this.updateScore(dt, impact);
    this.updateParticles(dt);
    this.updateRumble(cmd);
    this.audio.update(this.car, cmd);
    this.camera.update(dt, this.car);

    // Don't queue frames behind a busy GPU: it only adds input lag. Simulation still advances.
    if (!this.renderer.backlogged) {
      this.renderer.resize(this.perf.scale);
      this.draw(cmd);
      this.renderer.render(this.camera);
    }
    this.ui.hudUpdate(this.car, this.scheme, raw, this.score);
    this.updatePerf(dt);
    this.ui.perfUpdate(this.perf, this.renderer);
    this.input.endFrame();
    requestAnimationFrame((t) => this.frame(t));
  }

  emitSkids() {
    const wp = this.car.wheelPositions();
    for (let i = 0; i < 4; i++) {
      const s = this.car.wheelSlide[i];
      const p = wp[i];
      if (s > 0.12) {
        const lm = this.lastMark[i];
        const d = lm ? Math.hypot(p[0] - lm[0], p[1] - lm[1]) : 0;
        // a jump longer than any real step means the car was moved (reset/teleport): restart the mark
        if (!lm || d > 3) this.lastMark[i] = p;
        else if (d > 0.25) {
          this.renderer.skid(lm[0], lm[1], p[0], p[1], 0.3, 0.2 + s * 0.45);
          this.lastMark[i] = p;
        }
      } else this.lastMark[i] = null;
    }
  }

  updateScore(dt, impact) {
    const s = this.score;
    const car = this.car;
    const slip = Math.abs(car.bodySlip);
    s.flash = Math.max(0, s.flash - dt);
    const drifting = slip > 0.2 && car.speed > 8 && car.localVelocity[0] > 0;
    if (impact > 4 && s.active) {
      s.active = false;
      s.points = 0;
      s.flash = 1.4;
      s.flashText = 'WRECKED';
      s.flashBad = true;
      this.audio.say('Wrecked!');
      return;
    }
    if (drifting) {
      if (!s.active) { s.active = true; s.points = 0; s.mult = 1; s.time = 0; }
      s.idle = 0;
      s.time += dt;
      s.mult = Math.min(5, 1 + Math.floor(s.time / 1.5) * 0.5);
      s.points += dt * car.speed * (slip * 180 / Math.PI) * 0.6 * s.mult;
    } else if (s.active) {
      s.idle += dt;
      if (s.idle > 1.0) {
        s.active = false;
        s.total += s.points;
        if (s.points > s.best) { s.best = s.points; this.save(); }
        if (s.points > 300) {
          s.flash = 1.6;
          s.flashBad = false;
          s.flashText = `+${Math.round(s.points).toLocaleString()}`;
          this.audio.say(s.points > 15000 ? 'Insane drift!' : s.points > 5000 ? 'Great drift!' : 'Nice drift!');
        }
      }
    }
  }

  updateRumble(cmd) {
    // silent while gripping; high-freq motor for slip, low-freq for lockups
    const car = this.car;
    const slide = Math.max(...car.wheelSlide);
    const lock = (car.locked.front || car.locked.rear) && car.speed > 2 ? 0.5 : 0;
    this.rumbleTimer = (this.rumbleTimer || 0) - 1;
    if (this.rumbleTimer <= 0 && (slide > 0.15 || lock)) {
      this.input.rumble(lock + slide * 0.25, slide * Math.min(1, car.speed / 15) * 0.8, 80);
      this.rumbleTimer = 4;
    }
  }

  updateParticles(dt) {
    const car = this.car;
    const wp = car.wheelPositions();
    const P = this.particles;
    for (let i = 0; i < 4; i++) {
      const s = car.wheelSlide[i];
      if (s < 0.3) continue;
      const rate = (s - 0.25) * 70 * (car.speed > 2 || car.wheelspin > 0.2 ? 1 : 0);
      let n = rate * dt;
      while (n > 0 && P.length < 1000) {
        if (n < 1 && Math.random() > n) break;
        n -= 1;
        P.push({
          kind: 'smoke',
          x: wp[i][0] + (Math.random() - 0.5) * 0.4,
          y: wp[i][1] + (Math.random() - 0.5) * 0.4,
          vx: car.vx * 0.25 + (Math.random() - 0.5) * 1.5,
          vy: car.vy * 0.25 + (Math.random() - 0.5) * 1.5,
          life: 0, max: 1.2 + Math.random() * 1.4,
          size: 0.7 + Math.random() * 0.5, grow: 1.6 + Math.random(),
          a: 0.1 + s * 0.18, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 1.5,
        });
      }
    }
    // kart drift sparks / boost flame
    const lvl = car.driftLevel;
    if (lvl > 0 || car.drift.boost > 0) {
      const col = car.drift.boost > 0 ? [1, 0.55, 0.15] : [[0, 0, 0], [0.35, 0.65, 1], [1, 0.55, 0.1], [0.85, 0.35, 1]][lvl];
      for (const i of [2, 3]) {
        if (Math.random() < 0.7) {
          P.push({
            kind: 'spark', x: wp[i][0], y: wp[i][1],
            vx: -Math.cos(car.heading) * 6 + (Math.random() - 0.5) * 5, vy: -Math.sin(car.heading) * 6 + (Math.random() - 0.5) * 5,
            life: 0, max: 0.2 + Math.random() * 0.25, size: 0.35, grow: -0.5, a: 1, col, rot: 0, spin: 0,
          });
        }
      }
    }
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.life += dt;
      if (p.life >= p.max) { P[i] = P[P.length - 1]; P.pop(); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = Math.exp(-dt * (p.kind === 'smoke' ? 1.6 : 4));
      p.vx *= drag;
      p.vy *= drag;
      p.size = Math.max(0.05, p.size + p.grow * dt);
      p.rot += p.spin * dt;
    }
  }

  draw(cmd) {
    const r = this.renderer;
    const car = this.car;
    const SH = [0, 0, 0, 0.35];
    const sun = [0.35, -0.5];
    r.begin();
    // cull against a circle around the camera that covers the (rotated) viewport
    const cam = this.camera;
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const viewR = (cam.view / 2) * Math.hypot(1, aspect) + 3;
    const visible = (x, y, rad) => {
      const dx = x - cam.x, dy = y - cam.y, rr = viewR + rad;
      return dx * dx + dy * dy < rr * rr;
    };

    // shadows
    const barriers = this.world.barriers.filter((b) => visible(b.x, b.y, b.hl + 1));
    const props = this.world.props.filter((p) => visible(p.x, p.y, 1));
    for (const b of barriers) r.sprite('white', b.x + sun[0] * 0.8, b.y + sun[1] * 0.8, b.hl * 2, b.hw * 2.1, b.rot, SH);
    for (const p of props) {
      const sz = p.kind === 'cone' ? 0.6 : 1.9;
      r.sprite('blob', p.x + sun[0] * 0.5, p.y + sun[1] * 0.5, sz, sz, 0, [0, 0, 0, 0.45]);
    }
    const hop = car.drift.hop > 0 ? Math.sin((car.drift.hop / 0.18) * Math.PI) : 0;
    const sh = 1 + hop * 0.8;
    r.sprite('carShadow', car.x + sun[0] * sh, car.y + sun[1] * sh, 5.2, 2.6, car.heading, [0, 0, 0, 0.6 - hop * 0.2]);

    // barriers & props
    for (const b of barriers) r.sprite(b.tint ? 'barrierB' : 'barrierA', b.x, b.y, b.hl * 2, b.hw * 2, b.rot);
    for (const p of props) {
      if (p.kind === 'cone') {
        if (p.down) r.sprite('coneDown', p.x, p.y, 0.8, 0.4, p.rot);
        else r.sprite('cone', p.x, p.y, 0.6, 0.6, p.rot);
      } else r.sprite('tyres', p.x, p.y, 1.6, 1.6, p.rot);
    }

    // car: wheels under the body, front ones steered
    const scale = 1 + hop * 0.08;
    const wp = car.wheelPositions();
    for (let i = 0; i < 4; i++) {
      const rot = car.heading + (i < 2 ? car.steerAngle : 0);
      r.sprite('wheel', wp[i][0], wp[i][1], 0.68 * scale, 0.27 * scale, rot);
    }
    const [cw, ch] = REGIONS.car.size;
    r.sprite('car', car.x, car.y, cw * scale, ch * scale, car.heading);

    // brake lights
    const braking = car.gear === -1 ? cmd.throttle > 0.1 : cmd.brake > 0.1 || cmd.handbrake > 0.1;
    if (braking || car.gear === -1) {
      const c = Math.cos(car.heading), s = Math.sin(car.heading);
      const col = car.gear === -1 && !braking ? [1, 1, 1, 0.5] : [1, 0.08, 0.05, 0.9];
      for (const side of [-0.62, 0.62]) {
        const lx = -2.15, ly = side;
        r.sprite('glow', car.x + lx * c - ly * s, car.y + lx * s + ly * c, 1.1, 1.1, 0, col, 1);
      }
    }

    // particles
    for (const p of this.particles) {
      if (!visible(p.x, p.y, p.size)) continue;
      const t = p.life / p.max;
      if (p.kind === 'smoke') {
        const a = p.a * (t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9);
        r.sprite('smoke', p.x, p.y, p.size, p.size, p.rot, [0.86, 0.86, 0.88, a]);
      } else {
        r.sprite('glow', p.x, p.y, p.size, p.size, 0, [p.col[0], p.col[1], p.col[2], 1 - t], 1);
      }
    }
    if (car.drift.boost > 0) {
      const c = Math.cos(car.heading), s = Math.sin(car.heading);
      const f = 0.8 + Math.random() * 0.5;
      r.sprite('glow', car.x - c * 2.6, car.y - s * 2.6, 1.8 * f, 1.2 * f, car.heading, [1, 0.5, 0.15, 1], 1);
      r.sprite('glow', car.x - c * 2.4, car.y - s * 2.4, 0.9 * f, 0.6 * f, car.heading, [1, 0.95, 0.7, 1], 1);
    }
  }
}

const game = new Game();
game.init().catch((err) => {
  console.error(err);
  const el = document.getElementById('error');
  el.textContent = `Couldn't start Redline City: ${err.message}. Use a WebGPU-capable browser (Chrome / Edge 113+, Safari 26+, Firefox 141+).`;
  el.classList.remove('hidden');
});
window.game = game;
