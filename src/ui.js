// DOM UI: tuning panel, HUD, telemetry widget, drift score banner.
import { DEFAULT_TUNING, PRESETS } from './physics/car.js';
import { SCHEMES, CAMERA_MODES, CONTROL_TUNING } from './controls.js';
import { CAMERA_TUNING } from './camera.js';
import { INPUT_TUNING } from './input.js';
import { CAR_COLORS } from './sprites.js';

const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
};

// slider spec: [key, label, min, max, step, hint]
const CAR_GROUPS = [
  ['Tyres', [
    ['gripFront', 'Front grip μ', 0.3, 2, 0.01, 'Peak friction of the front axle'],
    ['gripRear', 'Rear grip μ', 0.3, 2, 0.01, 'Lower than front = oversteer / easier drifts'],
    ['peakSlipDeg', 'Peak slip angle °', 3, 15, 0.5, 'Where grip peaks — bigger = lazier, more progressive'],
    ['slideFalloff', 'Slide falloff', 1.05, 2.0, 0.01, 'How much grip drops past the peak (1.05 ≈ none, 2 = snappy)'],
    ['lockedFriction', 'Locked-tyre friction', 0.4, 1, 0.01, 'Grip while wheels are locked / handbraked'],
  ]],
  ['Chassis', [
    ['mass', 'Mass kg', 700, 2200, 10],
    ['inertiaScale', 'Yaw inertia ×', 0.4, 2, 0.01, 'Lower = rotates quicker'],
    ['cgHeight', 'CG height m', 0.2, 1.0, 0.01],
    ['weightTransfer', 'Weight transfer ×', 0, 3, 0.05, 'Exaggerate for stronger lift-off / trail-brake rotation'],
  ]],
  ['Drivetrain & brakes', [
    ['enginePower', 'Engine power ×', 0.3, 3, 0.05],
    ['brakeForce', 'Brake force g', 0.4, 2, 0.05],
    ['brakeBias', 'Brake bias (front)', 0.3, 0.9, 0.01, 'More rear = brake-induced oversteer'],
    ['handbrakeGrip', 'Handbrake rear grip', 0.1, 1, 0.01],
  ]],
  ['Steering', [
    ['maxSteerDeg', 'Max lock °', 15, 60, 1],
    ['steerSpeed', 'Steering rate rad/s', 1, 12, 0.1],
    ['steerSpeedFalloff', 'Speed sensitivity m/s', 5, 100, 1, 'Speed at which lock halves (higher = less reduction)'],
  ]],
  ['Assists (fun layer)', [
    ['countersteer', 'Auto-countersteer', 0, 1, 0.01, 'Front wheels align with travel direction'],
    ['spinProtection', 'Spin protection', 0, 1, 0.01],
    ['maxDriftDeg', 'Max drift angle °', 20, 90, 1],
    ['slideRetention', 'Slide speed retention', 0, 1, 0.01, 'Keep speed while sideways'],
    ['yawDamping', 'Stability control', 0, 1, 0.01],
    ['frontSlipLimit', 'Steer-to-grip limiter', 0, 1, 0.01, 'Stops full lock from washing out the front'],
  ]],
  ['Aero', [
    ['drag', 'Air drag', 0.1, 1.5, 0.01],
    ['rollingResistance', 'Rolling resistance', 0, 60, 1],
  ]],
];
const INPUT_SLIDERS = [
  ['deadzone', 'Stick deadzone', 0, 0.4, 0.01],
  ['steerCurve', 'Stick response curve', 1, 3, 0.05, '>1 = finer near centre'],
  ['keySteerIn', 'Key steer-in rate', 0.5, 10, 0.1],
  ['keySteerOut', 'Key return rate', 1, 20, 0.1],
  ['rumble', 'Rumble strength', 0, 1.5, 0.05],
];
const POINT_SLIDERS = [
  ['pointGain', 'Point-to-steer gain', 0.5, 6, 0.1],
  ['pointDamping', 'Point-to-steer damping', 0, 0.6, 0.01],
];
const CAMERA_SLIDERS = [
  ['rotStiffness', 'Rotation stiffness', 0.3, 10, 0.1],
  ['maxRotRate', 'Max rotation rate', 0.5, 8, 0.1],
  ['lookAhead', 'Look-ahead s', 0, 1.5, 0.05],
  ['baseView', 'View height m', 15, 80, 1],
  ['speedZoom', 'Speed zoom', 0, 1.5, 0.05],
  ['carScreenY', 'Car below centre (rotating)', 0, 0.35, 0.01],
  ['shake', 'Impact shake', 0, 2, 0.05],
];

export class UI {
  constructor(game) {
    this.game = game;
    this.panel = $('#panel');
    this.hud = $('#hud');
    this.tele = $('#tele').getContext('2d');
    this.banner = $('#banner');
    this.buildHud();
    this.build();
  }

  /** HUD nodes are created once; per-frame updates only touch text/transform when values change. */
  buildHud() {
    this.hud.innerHTML = `
      <div class="speed"><b></b><span>km/h</span></div>
      <div class="gear"></div>
      <div class="rpm"><i></i></div>
      <div class="stat">drift <b></b></div>
      <div class="stat scheme-name"></div>
      <div class="turbo"></div>`;
    const q = (sel) => this.hud.querySelector(sel);
    this.el = {
      speed: q('.speed b'), gear: q('.gear'), rpm: q('.rpm i'), drift: q('.stat b'), scheme: q('.scheme-name'),
      turbo: q('.turbo'), best: $('#best'), perf: $('#perf'),
    };
    this.last = {};
  }

  set(key, value, apply) {
    if (this.last[key] === value) return;
    this.last[key] = value;
    apply(value);
  }

  build() {
    const g = this.game;
    const p = this.panel;
    p.innerHTML = '';

    // schemes
    const schemes = h('div', { class: 'schemes' });
    for (const s of SCHEMES) {
      const card = h('button', {
        class: `scheme${g.scheme.id === s.id ? ' on' : ''}`,
        onclick: () => { g.setScheme(s.id, true); this.build(); },
      },
      h('div', { class: 'scheme-head' }, h('kbd', {}, s.key), h('b', {}, s.name), h('span', { class: 'tag' }, s.tag)),
      h('p', {}, s.summary),
      h('p', { class: 'meta' }, h('i', {}, 'Seen in: '), s.games),
      h('p', { class: 'meta' }, h('span', { class: 'pro' }, '+ '), s.pros, h('br'), h('span', { class: 'con' }, '− '), s.cons));
      schemes.append(card);
    }
    p.append(h('h2', {}, 'Control scheme'), schemes);

    // quick setup row
    const presetSel = h('select', { onchange: (e) => g.applyPreset(e.target.value) },
      Object.keys(PRESETS).map((n) => h('option', { value: n, ...(g.preset === n ? { selected: '' } : {}) }, n)));
    const camSel = h('select', { onchange: (e) => { CAMERA_TUNING.mode = e.target.value; g.save(); } },
      Object.entries(CAMERA_MODES).map(([k, v]) => h('option', { value: k, ...(CAMERA_TUNING.mode === k ? { selected: '' } : {}) }, v)));
    const driveSel = h('select', { onchange: (e) => { g.car.t.drive = e.target.value; g.save(); } },
      ['RWD', 'AWD', 'FWD'].map((d) => h('option', { value: d, ...(g.car.t.drive === d ? { selected: '' } : {}) }, d)));
    const resSel = h('select', { onchange: (e) => g.setResolution(e.target.value) },
      [['auto', 'Auto (hold 60 fps)'], ['1', '100%'], ['0.75', '75%'], ['0.5', '50%']].map(([k, v]) =>
        h('option', { value: k, ...(String(g.perf.mode) === k ? { selected: '' } : {}) }, v)));
    const modelSel = h('select', { onchange: (e) => { g.car.model = e.target.value; g.save(); } },
      [['physics', 'Tyre physics'], ['retro', 'Retro rotational']].map(([k, v]) => h('option', { value: k, ...(g.car.model === k ? { selected: '' } : {}) }, v)));
    p.append(h('div', { class: 'row2' },
      h('label', {}, 'Handling preset', presetSel),
      h('label', {}, 'Camera', camSel),
      h('label', {}, 'Drive', driveSel),
      h('label', {}, 'Car model', modelSel),
      h('label', {}, 'Resolution', resSel),
    ));
    p.append(h('div', { class: 'checks' },
      this.check('ABS', g.car.t.abs, (v) => { g.car.t.abs = v; }),
      this.check('Traction control', g.car.t.tractionControl, (v) => { g.car.t.tractionControl = v; }),
      this.check('Auto-throttle (point mode)', CONTROL_TUNING.autoThrottle, (v) => { CONTROL_TUNING.autoThrottle = v; }),
      this.check('Sound', g.audio.enabled, (v) => g.audio.setEnabled(v)),
      this.check('Announcer (AI voice)', g.audio.voiceEnabled, (v) => { g.audio.voiceEnabled = v; }),
    ));

    // sliders
    for (const [title, list] of CAR_GROUPS) p.append(this.group(title, list, g.car.t));
    p.append(this.group('Input', INPUT_SLIDERS, INPUT_TUNING));
    p.append(this.group('Point-to-steer', POINT_SLIDERS, CONTROL_TUNING));
    p.append(this.group('Camera', CAMERA_SLIDERS, CAMERA_TUNING));

    // car look + AI
    const colorSel = h('select', { onchange: (e) => g.setCarLook({ color: CAR_COLORS[e.target.value], colorName: e.target.value }) },
      Object.keys(CAR_COLORS).map((n) => h('option', { value: n, ...(g.carLook.colorName === n ? { selected: '' } : {}) }, n)));
    const prompt = h('textarea', { rows: 5, id: 'aiPrompt' });
    prompt.value = g.aiPrompt();
    this.aiStatus = h('div', { class: 'ai-status' },
      g.aiStatusText || (g.aiSpriteUrl ? 'Using AI-detailed sprite.' : 'Using software-rendered sprite.'));
    p.append(h('details', { class: 'group', open: '' },
      h('summary', {}, 'Car look & AI detail'),
      h('div', { class: 'row2' },
        h('label', {}, 'Paint', colorSel),
        this.check('Racing stripes', g.carLook.stripes, (v) => g.setCarLook({ stripes: v })),
      ),
      h('p', { class: 'hint' }, 'Sends the software-rendered car to FLUX.2 (Cloudflare Workers AI) as a reference image, then clips the result back to the exact silhouette.'),
      prompt,
      h('div', { class: 'btns' },
        h('button', { onclick: () => g.detailCarWithAI(prompt.value) }, '✨ Detail car with AI'),
        h('button', { onclick: () => g.useProceduralSprite() }, 'Use procedural sprite'),
      ),
      this.aiStatus,
    ));

    p.append(h('div', { class: 'btns' },
      h('button', { onclick: () => g.resetCar() }, 'Reset car (R / Y)'),
      h('button', { onclick: () => g.world.resetProps() }, 'Reset cones'),
      h('button', { onclick: () => g.renderer.clearSkids() }, 'Clear skid marks'),
      h('button', { onclick: () => { navigator.clipboard?.writeText(JSON.stringify(g.snapshot(), null, 2)); } }, 'Copy tuning JSON'),
      h('button', { onclick: () => g.applyPreset(g.preset) }, 'Reset sliders to preset'),
    ));
  }

  check(label, value, set) {
    const input = h('input', { type: 'checkbox', ...(value ? { checked: '' } : {}), onchange: (e) => { set(e.target.checked); this.game.save(); } });
    return h('label', { class: 'check' }, input, label);
  }

  group(title, list, obj) {
    const d = h('details', { class: 'group' }, h('summary', {}, title));
    for (const [key, label, min, max, step, hint] of list) {
      const out = h('output', {}, fmt(obj[key], step));
      const input = h('input', {
        type: 'range', min, max, step, value: obj[key],
        oninput: (e) => { obj[key] = parseFloat(e.target.value); out.textContent = fmt(obj[key], step); this.game.save(); },
      });
      d.append(h('div', { class: 'slider', title: hint || '' }, h('span', {}, label), input, out));
    }
    return d;
  }

  hudUpdate(car, scheme, raw, score) {
    const kmh = Math.round(car.speed * 3.6);
    const slipDeg = Math.round(Math.abs(car.bodySlip) * 180 / Math.PI);
    const gear = car.gear === -1 ? 'R' : car.gear;
    const lvl = car.driftLevel;
    const E = this.el;
    this.set('speed', kmh, (v) => { E.speed.textContent = v; });
    this.set('gear', gear, (v) => { E.gear.textContent = v; });
    const rpm = Math.round(Math.min(1, car.rpm / car.t.maxRpm) * 100) / 100;
    this.set('rpm', rpm, (v) => { E.rpm.style.transform = `scaleX(${v})`; });
    this.set('drift', slipDeg, (v) => { E.drift.textContent = `${v}°`; });
    this.set('scheme', scheme.name + raw.source, () => {
      E.scheme.textContent = `${scheme.name}${raw.source === 'gamepad' ? ' · 🎮' : ' · ⌨️'}`;
    });
    this.set('turbo', lvl, (v) => {
      E.turbo.className = `turbo l${v}`;
      E.turbo.textContent = v ? `MINI-TURBO ${'▮'.repeat(v)}` : '';
    });
    this.drawTelemetry(car, raw);
    // drift score
    const showBanner = score.active || score.flash > 0;
    this.set('bannerOn', showBanner, (v) => { this.banner.style.opacity = v ? '1' : '0'; });
    if (showBanner) {
      const html = score.active
        ? `<b>${Math.round(score.points).toLocaleString()}</b><span>×${score.mult.toFixed(1)} DRIFT</span>`
        : `<b class="${score.flashBad ? 'bad' : ''}">${score.flashText}</b>`;
      this.set('banner', html, (v) => { this.banner.innerHTML = v; });
    }
    this.set('best', Math.round(score.best) * 1e9 + Math.round(score.total), () => {
      E.best.textContent = `best drift ${Math.round(score.best).toLocaleString()} · total ${Math.round(score.total).toLocaleString()}`;
    });
  }

  perfUpdate(perf, renderer) {
    const gpu = renderer.gpuMs == null ? 'n/a' : `${renderer.gpuMs.toFixed(1)} ms`;
    const text = `${Math.round(perf.fps)} fps · GPU ${gpu} · ${renderer.canvas.width}×${renderer.canvas.height} (${Math.round(perf.scale * 100)}%${perf.mode === 'auto' ? ' auto' : ''})`;
    // refresh twice a second, matching the perf sampling window
    this.set('perf', Math.round(perf.fps) + gpu + perf.scale + renderer.canvas.width, () => { this.el.perf.textContent = text; });
  }

  drawTelemetry(car, raw) {
    const c = this.tele;
    const W = c.canvas.width, H = c.canvas.height;
    c.clearRect(0, 0, W, H);
    c.font = '11px ui-monospace, monospace';
    // grip usage bars
    const bar = (x, label, v, locked) => {
      c.fillStyle = 'rgba(255,255,255,0.12)';
      c.fillRect(x, 18, 18, 90);
      const hgt = Math.min(1.2, v) / 1.2 * 90;
      c.fillStyle = locked ? '#ff3b3b' : v > 0.97 ? '#ffb020' : '#3fd07a';
      c.fillRect(x, 108 - hgt, 18, hgt);
      c.fillStyle = 'rgba(255,255,255,0.6)';
      c.fillRect(x - 2, 108 - 90 / 1.2, 22, 1);
      c.fillStyle = '#ddd';
      c.fillText(label, x + 2, 122);
    };
    bar(10, 'F', car.frontUsage, car.locked.front);
    bar(36, 'R', car.rearUsage, car.locked.rear);
    c.fillStyle = '#9aa';
    c.fillText('grip use', 6, 12);

    // body slip gauge
    const cx = 128, cy = 72, r = 44;
    c.strokeStyle = 'rgba(255,255,255,0.2)';
    c.lineWidth = 6;
    c.beginPath(); c.arc(cx, cy, r, Math.PI, 0); c.stroke();
    const slip = car.bodySlip;
    c.strokeStyle = Math.abs(slip) > 0.2 ? '#ff4fb0' : '#58b7ff';
    c.beginPath();
    c.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 - Math.max(-1.5, Math.min(1.5, slip)), slip > 0);
    c.stroke();
    c.fillStyle = '#ddd';
    c.textAlign = 'center';
    c.fillText(`${Math.round((slip * 180) / Math.PI)}° slip`, cx, cy + 4);
    c.fillText(`steer ${Math.round((car.steerAngle * 180) / Math.PI)}°`, cx, cy + 18);
    c.textAlign = 'left';

    // inputs
    const ix = 186;
    const vbar = (x, v, col, label) => {
      c.fillStyle = 'rgba(255,255,255,0.12)';
      c.fillRect(x, 18, 8, 90);
      c.fillStyle = col;
      c.fillRect(x, 108 - v * 90, 8, v * 90);
      c.fillStyle = '#9aa';
      c.fillText(label, x, 122);
    };
    vbar(ix, raw.throttle, '#3fd07a', 'T');
    vbar(ix + 12, Math.max(raw.brake, raw.altBrake), '#ff3b3b', 'B');
    vbar(ix + 24, raw.handbrake, '#ffb020', 'H');
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(70, 126, 116, 8);
    c.fillStyle = '#58b7ff';
    const sx = 128 - raw.steer * 58;
    c.fillRect(Math.min(128, sx), 126, Math.abs(sx - 128), 8);
  }
}

function fmt(v, step) {
  const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return Number(v).toFixed(d);
}
