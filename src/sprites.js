// Software-rendered (Canvas 2D) sprite atlas. Everything the GPU draws comes from here, so the
// art pipeline is: draw procedurally → optionally run the car through an image model for detail →
// re-upload the region.
//
// Convention: each region is drawn as seen from above with world +y = image up, and sprites
// face +x (east). The car is drawn nose-up first and rotated into its slot.

export const ATLAS_W = 2048;
export const ATLAS_H = 1024;
const CAR_PPM = 160; // atlas pixels per metre for the car

// region: [x, y, w, h] in pixels, plus world size in metres
export const REGIONS = {
  car: { px: [0, 0, 768, 352], size: [4.8, 2.2] },
  wheel: { px: [800, 0, 128, 48], size: [0.8, 0.3] },
  cone: { px: [960, 0, 96, 96], size: [0.6, 0.6] },
  coneDown: { px: [1072, 0, 128, 64], size: [0.8, 0.4] },
  tyres: { px: [1216, 0, 256, 256], size: [1.6, 1.6] },
  white: { px: [1500, 4, 8, 8], size: [1, 1] },
  barrierA: { px: [0, 400, 512, 128], size: [4, 1] },
  barrierB: { px: [0, 540, 512, 128], size: [4, 1] },
  smoke: { px: [560, 400, 256, 256], size: [1, 1] },
  glow: { px: [840, 400, 128, 128], size: [1, 1] },
  carShadow: { px: [1000, 400, 640, 320], size: [5.2, 2.6] },
  blob: { px: [1660, 400, 128, 128], size: [1, 1] },
};

export const CAR_COLORS = {
  Redline: '#d0161e',
  'Midnight Blue': '#1b3f8f',
  'Acid Lime': '#9ad10f',
  Gunmetal: '#4a4f57',
  'Sunset Orange': '#f2650c',
  'Pearl White': '#e9e9e4',
};

// Livery ideas for the AI pass (the text is what goes into the prompt). No real brands or logos.
export const DECAL_PRESETS = {
  None: '',
  Flames: 'hot-rod flame decals in orange and yellow sweeping back from the front of the hood and along both sides',
  'Race number': 'a large white racing roundel with the black number 77 on the roof and on both doors',
  'Carbon hood': 'a matte black carbon-fibre hood and roof with a visible weave',
  Checkered: 'a black-and-white checkered flag pattern across the roof and rear deck',
  'Touring livery': 'a touring-car livery with bold blue and yellow stripes and small generic sponsor-style panels (no real brands or text)',
  'Drift style': 'a Japanese drift-car livery with pink and white cherry-blossom graphics sweeping along the sides',
};

const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (f < 0) { r *= 1 + f; g *= 1 + f; b *= 1 + f; }
  else { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/**
 * Draw the car nose-up, centred at (0,0) in metres (caller sets transform).
 * Length 4.4m, width 1.86m.
 */
export function drawCarBody(ctx, opts = {}) {
  const color = opts.color || CAR_COLORS.Redline;
  const stripes = opts.stripes ?? true;
  const L = 4.4, W = 1.86;
  const hl = L / 2, hw = W / 2;

  // body silhouette: tapered nose, hips over the rear wheels
  const body = new Path2D();
  body.moveTo(-hw * 0.78, -hl + 0.12);
  body.quadraticCurveTo(-hw * 0.8, -hl, -hw * 0.45, -hl - 0.02);
  body.lineTo(hw * 0.45, -hl - 0.02);
  body.quadraticCurveTo(hw * 0.8, -hl, hw * 0.78, -hl + 0.12);
  body.bezierCurveTo(hw * 0.98, -hl + 0.5, hw * 0.98, -hl + 1.0, hw * 0.93, -hl + 1.5);
  body.bezierCurveTo(hw * 0.9, 0.1, hw * 0.92, 0.4, hw, 0.95);
  body.bezierCurveTo(hw * 1.02, 1.5, hw * 0.98, hl - 0.25, hw * 0.86, hl - 0.04);
  body.quadraticCurveTo(hw * 0.6, hl + 0.03, 0, hl + 0.02);
  body.quadraticCurveTo(-hw * 0.6, hl + 0.03, -hw * 0.86, hl - 0.04);
  body.bezierCurveTo(-hw * 0.98, hl - 0.25, -hw * 1.02, 1.5, -hw, 0.95);
  body.bezierCurveTo(-hw * 0.92, 0.4, -hw * 0.9, 0.1, -hw * 0.93, -hl + 1.5);
  body.bezierCurveTo(-hw * 0.98, -hl + 1.0, -hw * 0.98, -hl + 0.5, -hw * 0.78, -hl + 0.12);
  body.closePath();

  // paint: cylindrical shading across the width
  const g = ctx.createLinearGradient(-hw, 0, hw, 0);
  g.addColorStop(0, shade(color, -0.55));
  g.addColorStop(0.12, shade(color, -0.15));
  g.addColorStop(0.35, shade(color, 0.08));
  g.addColorStop(0.5, shade(color, 0.16));
  g.addColorStop(0.65, shade(color, 0.08));
  g.addColorStop(0.88, shade(color, -0.15));
  g.addColorStop(1, shade(color, -0.55));
  ctx.fillStyle = g;
  ctx.fill(body);
  ctx.lineWidth = 0.025;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke(body);

  ctx.save();
  ctx.clip(body);

  // racing stripes
  if (stripes) {
    ctx.fillStyle = 'rgba(245,245,240,0.92)';
    ctx.fillRect(-0.24, -hl, 0.17, L);
    ctx.fillRect(0.07, -hl, 0.17, L);
  }

  // hood creases
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 0.018;
  ctx.beginPath();
  ctx.moveTo(-0.42, -hl + 0.15); ctx.quadraticCurveTo(-0.5, -hl + 0.8, -0.48, -hl + 1.25);
  ctx.moveTo(0.42, -hl + 0.15); ctx.quadraticCurveTo(0.5, -hl + 0.8, 0.48, -hl + 1.25);
  ctx.stroke();
  // vents
  ctx.fillStyle = 'rgba(10,10,12,0.75)';
  roundRect(ctx, -0.36, -hl + 0.62, 0.18, 0.32, 0.04); ctx.fill();
  roundRect(ctx, 0.18, -hl + 0.62, 0.18, 0.32, 0.04); ctx.fill();

  // greenhouse: windshield, roof, rear window
  const wsTop = -hl + 1.32, roofTop = -hl + 1.98, roofBot = 0.85, rwBot = 1.35;
  const glass = ctx.createLinearGradient(0, wsTop, 0, roofTop);
  glass.addColorStop(0, '#2a3a4c');
  glass.addColorStop(1, '#0d141c');
  ctx.fillStyle = glass;
  ctx.beginPath();
  ctx.moveTo(-0.62, wsTop + 0.04);
  ctx.quadraticCurveTo(0, wsTop - 0.12, 0.62, wsTop + 0.04);
  ctx.lineTo(0.7, roofTop);
  ctx.lineTo(-0.7, roofTop);
  ctx.closePath();
  ctx.fill();
  // windshield reflection streak
  ctx.fillStyle = 'rgba(200,225,255,0.18)';
  ctx.beginPath();
  ctx.moveTo(-0.45, wsTop + 0.05); ctx.lineTo(-0.15, wsTop); ctx.lineTo(-0.35, roofTop); ctx.lineTo(-0.62, roofTop);
  ctx.closePath(); ctx.fill();

  // roof panel
  const roof = ctx.createLinearGradient(-0.7, 0, 0.7, 0);
  roof.addColorStop(0, shade(color, -0.35));
  roof.addColorStop(0.5, shade(color, 0.12));
  roof.addColorStop(1, shade(color, -0.35));
  ctx.fillStyle = roof;
  roundRect(ctx, -0.7, roofTop, 1.4, roofBot - roofTop, 0.12);
  ctx.fill();
  if (stripes) {
    ctx.fillStyle = 'rgba(245,245,240,0.92)';
    ctx.fillRect(-0.24, roofTop, 0.17, roofBot - roofTop);
    ctx.fillRect(0.07, roofTop, 0.17, roofBot - roofTop);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.02;
  roundRect(ctx, -0.7, roofTop, 1.4, roofBot - roofTop, 0.12);
  ctx.stroke();

  // side windows (thin slivers visible from above)
  ctx.fillStyle = '#121a22';
  ctx.beginPath();
  ctx.moveTo(-0.7, roofTop); ctx.lineTo(-0.8, roofTop + 0.15); ctx.lineTo(-0.82, roofBot - 0.1); ctx.lineTo(-0.7, roofBot);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0.7, roofTop); ctx.lineTo(0.8, roofTop + 0.15); ctx.lineTo(0.82, roofBot - 0.1); ctx.lineTo(0.7, roofBot);
  ctx.closePath(); ctx.fill();

  // rear window
  const rg = ctx.createLinearGradient(0, roofBot, 0, rwBot);
  rg.addColorStop(0, '#0d141c');
  rg.addColorStop(1, '#26333f');
  ctx.fillStyle = rg;
  ctx.beginPath();
  ctx.moveTo(-0.68, roofBot); ctx.lineTo(0.68, roofBot);
  ctx.lineTo(0.56, rwBot); ctx.quadraticCurveTo(0, rwBot + 0.06, -0.56, rwBot);
  ctx.closePath(); ctx.fill();

  // rear deck + spoiler
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(-0.8, hl - 0.42, 1.6, 0.03);
  ctx.fillStyle = shade(color, -0.4);
  roundRect(ctx, -0.84, hl - 0.34, 1.68, 0.16, 0.04);
  ctx.fill();
  ctx.fillStyle = shade(color, 0.05);
  roundRect(ctx, -0.84, hl - 0.34, 1.68, 0.07, 0.03);
  ctx.fill();
  ctx.restore();

  // headlights
  ctx.fillStyle = '#f4f2e6';
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 0.015;
  for (const sx of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(sx * 0.42, -hl + 0.02);
    ctx.lineTo(sx * 0.7, -hl + 0.06);
    ctx.quadraticCurveTo(sx * 0.8, -hl + 0.14, sx * 0.79, -hl + 0.24);
    ctx.lineTo(sx * 0.5, -hl + 0.13);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // tail lights
  ctx.fillStyle = '#a3000c';
  for (const sx of [-1, 1]) {
    roundRect(ctx, sx > 0 ? 0.42 : -0.82, hl - 0.11, 0.4, 0.08, 0.03);
    ctx.fill();
  }
  // mirrors
  ctx.fillStyle = shade(color, -0.3);
  for (const sx of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(sx * 0.98, -hl + 1.48, 0.1, 0.06, sx * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function drawWheel(ctx, w, h) {
  ctx.fillStyle = '#121212';
  roundRect(ctx, 2, 2, w - 4, h - 4, 8);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  for (let x = 8; x < w - 8; x += 10) ctx.fillRect(x, 4, 4, h - 8);
}

function drawCone(ctx, s) {
  const c = s / 2;
  ctx.fillStyle = '#1a1a1a';
  roundRect(ctx, s * 0.1, s * 0.1, s * 0.8, s * 0.8, s * 0.08);
  ctx.fill();
  const g = ctx.createRadialGradient(c - s * 0.08, c - s * 0.08, 1, c, c, s * 0.34);
  g.addColorStop(0, '#ffb066');
  g.addColorStop(1, '#e8500c');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(c, c, s * 0.32, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#f5f5f5';
  ctx.lineWidth = s * 0.07;
  ctx.beginPath(); ctx.arc(c, c, s * 0.2, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#ff7a2a';
  ctx.beginPath(); ctx.arc(c, c, s * 0.08, 0, Math.PI * 2); ctx.fill();
}

function drawConeDown(ctx, w, h) {
  // side view of a toppled cone: nose to +x
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(4, 4, h * 0.25, h - 8);
  ctx.fillStyle = '#e8500c';
  ctx.beginPath();
  ctx.moveTo(4 + h * 0.25, 8); ctx.lineTo(w - 6, h / 2 - 4); ctx.lineTo(w - 6, h / 2 + 4); ctx.lineTo(4 + h * 0.25, h - 8);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(w * 0.45, h * 0.28, w * 0.12, h * 0.44);
}

function drawTyres(ctx, s) {
  const c = s / 2;
  for (const [ox, oy] of [[-0.22, -0.18], [0.24, -0.12], [0, 0.24]]) {
    const x = c + ox * s, y = c + oy * s, r = s * 0.26;
    ctx.fillStyle = '#151515';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = s * 0.03;
    ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#060606';
    ctx.beginPath(); ctx.arc(x, y, r * 0.45, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.3, 0, Math.PI * 2); ctx.fill();
  }
}

function drawBarrier(ctx, w, h, painted) {
  // jersey barrier from above: wide base, raised narrow ridge
  ctx.fillStyle = painted ? '#c8c8c4' : '#9a9a96';
  roundRect(ctx, 2, 2, w - 4, h - 4, 6);
  ctx.fill();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(0,0,0,0.35)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.15)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.3)');
  g.addColorStop(0.65, 'rgba(255,255,255,0.15)');
  g.addColorStop(1, 'rgba(0,0,0,0.4)');
  ctx.fillStyle = g;
  roundRect(ctx, 2, 2, w - 4, h - 4, 6);
  ctx.fill();
  if (painted) {
    ctx.save();
    roundRect(ctx, 2, 2, w - 4, h - 4, 6);
    ctx.clip();
    ctx.fillStyle = 'rgba(205,20,28,0.85)';
    for (let x = -h; x < w; x += h * 1.4) {
      ctx.beginPath();
      ctx.moveTo(x, h); ctx.lineTo(x + h * 0.7, h); ctx.lineTo(x + h * 1.4, 0); ctx.lineTo(x + h * 0.7, 0);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, 0, 3, h);
  ctx.fillRect(w - 3, 0, 3, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 2;
  roundRect(ctx, 2, 2, w - 4, h - 4, 6);
  ctx.stroke();
}

function radial(ctx, s, stops) {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
}

function inRegion(ctx, name, fn) {
  const [x, y, w, h] = REGIONS[name].px;
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.clearRect(0, 0, w, h);
  fn(ctx, w, h);
  ctx.restore();
}

/** Car into its atlas slot: nose-up drawing rotated to face +x. */
export function paintCarRegion(ctx, opts) {
  inRegion(ctx, 'car', (c, w, h) => {
    c.translate(w / 2, h / 2);
    c.rotate(Math.PI / 2);
    c.scale(CAR_PPM, CAR_PPM);
    drawCarBody(c, opts);
  });
}

export function buildAtlas(opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d');
  paintCarRegion(ctx, opts);
  inRegion(ctx, 'wheel', drawWheel);
  inRegion(ctx, 'cone', (c, w) => drawCone(c, w));
  inRegion(ctx, 'coneDown', drawConeDown);
  inRegion(ctx, 'tyres', (c, w) => drawTyres(c, w));
  inRegion(ctx, 'white', (c, w, h) => { c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); });
  inRegion(ctx, 'barrierA', (c, w, h) => drawBarrier(c, w, h, false));
  inRegion(ctx, 'barrierB', (c, w, h) => drawBarrier(c, w, h, true));
  inRegion(ctx, 'smoke', (c, s) => {
    radial(c, s, [[0, 'rgba(255,255,255,0.9)'], [0.4, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']]);
    // lumpy puff
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * s * 0.2;
      const g = c.createRadialGradient(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r, 0, s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r, s * 0.25);
      g.addColorStop(0, 'rgba(255,255,255,0.25)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, s, s);
    }
  });
  inRegion(ctx, 'glow', (c, s) => radial(c, s, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]));
  inRegion(ctx, 'blob', (c, s) => radial(c, s, [[0, 'rgba(0,0,0,1)'], [0.5, 'rgba(0,0,0,0.6)'], [1, 'rgba(0,0,0,0)']]));
  inRegion(ctx, 'carShadow', (c, w, h) => {
    c.filter = 'blur(14px)';
    c.fillStyle = 'rgba(0,0,0,1)';
    roundRect(c, w * 0.08, h * 0.12, w * 0.84, h * 0.76, h * 0.25);
    c.fill();
    c.filter = 'none';
  });
  return canvas;
}

// --- AI detail pipeline --------------------------------------------------------------------
// The car is exported nose-up on a flat grey background at 512x1024 (FLUX-friendly), sent to the
// image model as a reference, then the result is clipped back to the original silhouette so the
// collision shape and sprite alignment never drift.

const AI_W = 512, AI_H = 1024, AI_PPM = 205;

export function renderCarForAI(opts) {
  const canvas = document.createElement('canvas');
  canvas.width = AI_W;
  canvas.height = AI_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c8c8c8';
  ctx.fillRect(0, 0, AI_W, AI_H);
  ctx.translate(AI_W / 2, AI_H / 2);
  ctx.scale(AI_PPM, AI_PPM);
  drawCarBody(ctx, opts);
  return canvas;
}

function carMask(opts) {
  const canvas = document.createElement('canvas');
  canvas.width = AI_W;
  canvas.height = AI_H;
  const ctx = canvas.getContext('2d');
  ctx.translate(AI_W / 2, AI_H / 2);
  ctx.scale(AI_PPM, AI_PPM);
  drawCarBody(ctx, opts);
  return canvas;
}

/** Paint an AI-detailed (nose-up, AI_W x AI_H) image into the atlas car slot, clipped to the silhouette. */
export function paintDetailedCar(atlasCtx, image, opts) {
  const tmp = document.createElement('canvas');
  tmp.width = AI_W;
  tmp.height = AI_H;
  const t = tmp.getContext('2d');
  t.drawImage(image, 0, 0, AI_W, AI_H);
  t.globalCompositeOperation = 'destination-in';
  t.drawImage(carMask(opts), 0, 0);
  inRegion(atlasCtx, 'car', (c, w, h) => {
    c.translate(w / 2, h / 2);
    c.rotate(Math.PI / 2);
    const k = CAR_PPM / AI_PPM;
    c.scale(k, k);
    c.drawImage(tmp, -AI_W / 2, -AI_H / 2);
  });
}
