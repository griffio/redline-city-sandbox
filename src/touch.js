// Touch + tilt controls for tablets (iPad first).
//
// Steering = rotating the device in the plane of its screen, like a steering wheel. It's measured
// as the in-plane angle of the gravity vector *relative to a calibrated neutral*, which makes it
// independent of landscape-left/right, of how far back the device is tilted, and of the sign
// convention a platform uses for accelerationIncludingGravity (iOS and Android differ).
//
// Pitch (full-tilt mode) = the screen's angle from vertical, from |gravity·screenNormal|, so it is
// sign-convention free as well: tilting the top edge away makes the screen flatter (pitch +).
// A fast drop in that angle (top edge yanked toward you) is the jerk-back handbrake.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEG = 180 / Math.PI;
const wrapDeg = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

export const TOUCH_TUNING = {
  ui: 'auto', // auto | on | off — on-screen controls
  mode: 'tilt', // tilt (tilt steer + pedals) | fulltilt (pitch = gas/brake) | touch (buttons only)
  tiltMaxDeg: 28, // device rotation for full steering lock
  tiltDeadzoneDeg: 2,
  tiltCurve: 1.15, // >1 = finer control near centre
  smoothing: 0.5, // 0 = raw sensor, 1 = heavy filtering
  invertSteer: false,
  pitchRangeDeg: 15, // full-tilt: tilt beyond the dead zone for full gas / brake
  pitchDeadzoneDeg: 4,
  jerkHandbrake: false,
  jerkSensitivity: 0.5, // 0..1 → 420..140 °/s of pitch-back rate
};

/** One-euro filter: smooth when still, responsive when moving (Casiez et al. 2012). */
class OneEuro {
  constructor() { this.x = null; this.dx = 0; }
  filter(x, dt, minCutoff, beta = 0.02) {
    if (this.x == null) { this.x = x; return x; }
    dt = Math.max(dt, 1e-3); // two frames can share a timestamp
    const a = (fc) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
    const dx = (x - this.x) / dt;
    this.dx += (dx - this.dx) * a(1);
    this.x += (x - this.x) * a(minCutoff + beta * Math.abs(this.dx));
    return this.x;
  }
  reset() { this.x = null; this.dx = 0; }
}

export class TiltSensor {
  constructor() {
    this.state = 'off'; // off | granted | denied | unavailable | insecure
    this.raw = null; // latest accelerationIncludingGravity [x, y, z]
    this.samples = 0;
    this.neutral = null; // { ang, pitch }
    this.calib = null; // samples being collected for calibration
    this.steerDeg = 0;
    this.pitchDeg = 0;
    this.flatness = 0; // 0 = screen upright, 1 = lying flat (steering unreliable)
    this.jerkUntil = 0;
    this.jerkCooldown = 0;
    this.pitchHist = []; // [t, pitch] over the last ~100 ms, at sensor rate
    this.steerHist = []; // [t, steerDeg] at frame rate, to undo the roll a flick causes
    this.pitchRate = 0;
    this.fSteer = new OneEuro();
    this.fPitch = new OneEuro();
    this.onMotion = this.onMotion.bind(this);
  }

  /** Must run inside a user gesture (iOS asks for permission here). */
  async enable() {
    if (this.state === 'granted') return true;
    if (!window.isSecureContext) { this.state = 'insecure'; return false; }
    if (typeof DeviceMotionEvent === 'undefined') { this.state = 'unavailable'; return false; }
    try {
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        const r = await DeviceMotionEvent.requestPermission();
        if (r !== 'granted') { this.state = 'denied'; return false; }
      }
    } catch {
      this.state = 'denied';
      return false;
    }
    addEventListener('devicemotion', this.onMotion);
    this.state = 'granted';
    return true;
  }

  get live() {
    return this.state === 'granted' && this.samples > 3 && this.neutral != null;
  }

  onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    this.raw = [a.x, a.y, a.z];
    this.samples++;
    if (this.calib) this.calib.push(this.raw);
    // Jerk detection runs here at sensor rate: a flick peaks for only a sample or two, which a
    // once-per-frame check can miss. Rate is measured over ~50 ms of raw (unfiltered) pitch.
    const now = performance.now();
    const H = this.pitchHist;
    H.push([now, this.pitchOf(this.raw)]);
    while (H.length > 2 && now - H[0][0] > 100) H.shift();
    let k = H.length - 1;
    while (k > 0 && now - H[k][0] < 30) k--; // ~2 samples at 60 Hz: fast enough to beat the roll
    this.pitchRate = k < H.length - 1 ? ((H[H.length - 1][1] - H[k][1]) / (now - H[k][0])) * 1000 : 0;
    const T = TOUCH_TUNING;
    const threshold = 420 - T.jerkSensitivity * 280; // °/s
    if (T.jerkHandbrake && this.neutral && now > this.jerkCooldown && this.pitchRate < -threshold) {
      this.jerkUntil = now + 380;
      this.jerkCooldown = now + 700;
      // undo the roll the flick itself caused: hold steering where it was just before
      const before = this.steerHist.find(([t]) => t >= now - 140);
      if (before) this.steerDeg = before[1];
    }
  }

  pitchOf([x, y, z]) {
    const g = Math.hypot(x, y, z) || 1;
    return Math.asin(clamp(Math.abs(z) / g, 0, 1)) * DEG; // 0 = upright, 90 = flat
  }

  /** Collect ~0.4 s of samples and take them as neutral. Resolves false without a sensor. */
  calibrate() {
    if (this.state !== 'granted') return Promise.resolve(false);
    // overlapping requests (tap-to-start + Recentre + orientation change) share one collection
    if (this.calibrating) return this.calibrating;
    const s = (this.calib = []);
    this.calibrating = new Promise((resolve) => setTimeout(() => {
      this.calib = null;
      this.calibrating = null;
      if (!s.length) return resolve(false);
      let sx = 0, sy = 0, sp = 0;
      for (const v of s) {
        const m = Math.hypot(v[0], v[1]) || 1;
        sx += v[0] / m; sy += v[1] / m; sp += this.pitchOf(v);
      }
      this.neutral = { ang: Math.atan2(sy, sx) * DEG, pitch: sp / s.length };
      this.fSteer.reset();
      this.fPitch.reset();
      resolve(true);
    }, 400));
    return this.calibrating;
  }

  update(dt) {
    if (!this.raw || !this.neutral) return;
    const T = TOUCH_TUNING;
    const [x, y, z] = this.raw;
    const g = Math.hypot(x, y, z) || 1;
    // Rotating the device CCW (top edge to the left) turns gravity CW in device coordinates,
    // so the in-plane angle *decreases*: steer-left (+) = neutral − current, on any platform.
    const ang = Math.atan2(y, x) * DEG;
    let steer = wrapDeg(this.neutral.ang - ang);
    if (T.invertSteer) steer = -steer;
    const minCutoff = 0.4 + (1 - T.smoothing) * 6; // Hz
    const now = performance.now();
    if (now >= this.jerkUntil) {
      this.steerDeg = this.fSteer.filter(steer, dt, minCutoff);
      this.steerHist.push([now, this.steerDeg]);
      while (this.steerHist.length && now - this.steerHist[0][0] > 300) this.steerHist.shift();
    } else this.fSteer.x = this.steerDeg; // resume smoothly from the held value
    this.pitchDeg = this.fPitch.filter(this.pitchOf(this.raw) - this.neutral.pitch, dt, minCutoff);
    this.flatness = Math.abs(z) / g;
  }

  /** Steering -1..1 (+left) with dead zone, curve and fade-out when the screen lies flat. */
  steer() {
    const T = TOUCH_TUNING;
    const d = Math.abs(this.steerDeg);
    if (d <= T.tiltDeadzoneDeg) return 0;
    const n = clamp((d - T.tiltDeadzoneDeg) / (T.tiltMaxDeg - T.tiltDeadzoneDeg), 0, 1);
    const conf = clamp((0.97 - this.flatness) / 0.12, 0, 1); // in-plane gravity vanishes when flat
    return Math.sign(this.steerDeg) * Math.pow(n, T.tiltCurve) * conf;
  }

  /** Full-tilt pedals from pitch: forward (top edge away) = gas, back = brake. */
  pedals() {
    const T = TOUCH_TUNING;
    const p = this.pitchDeg;
    const gas = p > T.pitchDeadzoneDeg ? clamp((p - T.pitchDeadzoneDeg) / T.pitchRangeDeg, 0, 1) : 0;
    const brake = p < -T.pitchDeadzoneDeg ? clamp((-p - T.pitchDeadzoneDeg) / T.pitchRangeDeg, 0, 1) : 0;
    return { gas, brake };
  }

  /** True while a jerk-back handbrake pulse (detected in onMotion) is active. */
  jerk(now) {
    return TOUCH_TUNING.jerkHandbrake && this.live && now < this.jerkUntil;
  }
}

/** On-screen pedals/buttons + tilt, merged into one input reading for Input.update(). */
export class TouchControls {
  constructor({ onReset, onPanel, onToast }) {
    this.tilt = new TiltSensor();
    this.onToast = onToast;
    this.values = { gas: 0, brake: 0, handbrake: 0, drift: 0, left: 0, right: 0 };
    this.touchedAt = 0;
    this.started = false;
    this.lastInfo = 0;
    this.isTouchDevice = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
    this.build({ onReset, onPanel });
    this.applyUi();
    const reorient = () => {
      if (!this.started || this.tilt.state !== 'granted') return;
      // the in-plane neutral flips with the device: recentre once it has settled
      setTimeout(() => this.recentre('Orientation changed: recentred'), 600);
    };
    addEventListener('orientationchange', reorient);
    screen.orientation?.addEventListener?.('change', reorient);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && this.started) this.keepAwake(); });
  }

  get enabled() {
    const ui = TOUCH_TUNING.ui;
    return ui === 'on' || (ui === 'auto' && this.isTouchDevice);
  }

  applyUi() {
    const on = this.enabled;
    document.body.classList.toggle('touch', on);
    // fall back to steering buttons only once tilt has actually failed (not before the first tap or mid-calibration)
    const buttons = TOUCH_TUNING.mode === 'touch' || (this.started && !this.calibrating && !this.tilt.live);
    document.body.classList.toggle('touch-steer-buttons', on && buttons);
    document.body.classList.toggle('touch-fulltilt', on && TOUCH_TUNING.mode === 'fulltilt');
  }

  build({ onReset, onPanel }) {
    const root = (this.root = document.createElement('div'));
    root.id = 'touch';
    root.innerHTML = `
      <div class="tc-pedal" data-k="brake"><i></i><span>BRAKE</span></div>
      <div class="tc-btn" data-k="handbrake"><span>HAND<br>BRAKE</span></div>
      <div class="tc-pedal" data-k="gas"><i></i><span>GAS</span></div>
      <div class="tc-btn" data-k="drift"><span>DRIFT</span></div>
      <div class="tc-btn tc-steer" data-k="left"><span>◀</span></div>
      <div class="tc-btn tc-steer" data-k="right"><span>▶</span></div>
      <div class="tc-top">
        <button data-a="recentre" title="Recentre tilt">⟲</button>
        <button data-a="reset" title="Reset car">↺</button>
        <button data-a="panel" title="Settings">⚙</button>
      </div>`;
    document.body.append(root);
    this.info = document.getElementById('tiltinfo');

    for (const el of root.querySelectorAll('[data-k]')) {
      const k = el.dataset.k;
      const analog = el.classList.contains('tc-pedal');
      const fill = el.querySelector('i');
      const set = (v) => {
        this.values[k] = v;
        el.classList.toggle('on', v > 0);
        if (fill) fill.style.transform = `scaleY(${v})`;
      };
      const read = (e) => {
        if (!analog) return 1;
        // slide up the pedal for more: bottom = 35%, top fifth = 100%
        const r = el.getBoundingClientRect();
        const up = clamp((r.bottom - e.clientY) / (r.height * 0.8), 0, 1);
        return 0.35 + 0.65 * up;
      };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        this.touchedAt = performance.now();
        set(read(e));
      });
      el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) set(read(e)); });
      const release = () => set(0);
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('lostpointercapture', release);
    }
    root.querySelector('[data-a=recentre]').addEventListener('click', () => this.recentre('Tilt recentred'));
    root.querySelector('[data-a=reset]').addEventListener('click', onReset);
    root.querySelector('[data-a=panel]').addEventListener('click', onPanel);
  }

  /** Called from the Tap-to-start button (a user gesture): sensor permission, wake lock, calibration. */
  async begin() {
    if (this.started) return;
    this.started = true;
    this.touchedAt = performance.now();
    this.keepAwake();
    if (TOUCH_TUNING.mode !== 'touch') await this.enableTilt();
    this.applyUi();
  }

  /** Ask for sensor access (call from a tap), wait for data, then calibrate. */
  async enableTilt() {
    this.calibrating = true;
    const ok = await this.tilt.enable();
    if (ok) {
      // wait for the first samples, then take the current hold as neutral
      await new Promise((r) => setTimeout(r, 500));
      if (this.tilt.samples === 0) this.tilt.state = 'unavailable';
      else await this.recentre('Calibrated: hold it like a steering wheel');
    }
    const why = { denied: 'Motion access denied', unavailable: 'No motion sensor', insecure: 'Motion sensors need HTTPS' }[this.tilt.state];
    if (why) this.onToast?.(`${why}: using touch steering`);
    this.calibrating = false;
    this.applyUi();
    return this.tilt.live;
  }

  async recentre(msg) {
    if (this.tilt.state !== 'granted') return;
    this.onToast?.('Hold steady…');
    if (await this.tilt.calibrate()) this.onToast?.(msg);
    this.applyUi();
  }

  async keepAwake() {
    try { this.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported / denied */ }
  }

  /** Merged reading for this frame. `engaged` = the player is using touch right now. */
  read(dt) {
    const T = TOUCH_TUNING;
    const v = this.values;
    const now = performance.now();
    const tilt = this.tilt;
    tilt.update(dt);
    const useTilt = this.enabled && T.mode !== 'touch' && tilt.live;
    let steer = useTilt ? tilt.steer() : 0;
    if (!useTilt || document.body.classList.contains('touch-steer-buttons')) steer += v.left - v.right;
    let gas = v.gas, brake = v.brake;
    if (useTilt && T.mode === 'fulltilt') {
      const p = tilt.pedals();
      gas = Math.max(gas, p.gas);
      brake = Math.max(brake, p.brake);
    }
    const jerk = useTilt && tilt.jerk(now);
    const pressed = v.gas || v.brake || v.handbrake || v.drift || v.left || v.right;
    if (pressed) this.touchedAt = now;
    this.updateInfo(now, useTilt, jerk);
    return {
      engaged: this.enabled && (pressed || (useTilt && Math.abs(steer) > 0.05)),
      steer: clamp(steer, -1, 1),
      throttle: gas,
      brake,
      handbrake: v.handbrake || jerk ? 1 : 0,
      drift: !!v.drift,
    };
  }

  updateInfo(now, useTilt, jerk) {
    if (!this.info || now - this.lastInfo < 100) return;
    this.lastInfo = now;
    const t = this.tilt;
    this.info.textContent = !this.enabled ? '' : useTilt
      ? `tilt ${t.steerDeg.toFixed(1)}° · pitch ${t.pitchDeg >= 0 ? '+' : ''}${t.pitchDeg.toFixed(1)}° · flat ${(t.flatness * 100) | 0}%${jerk ? ' · JERK' : ''}`
      : `tilt: ${t.state === 'off' ? 'tap to start' : t.state}`;
  }
}
