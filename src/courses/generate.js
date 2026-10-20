// Seeded course generators: circuits, rally stages and gymkhanas, plus everything a course
// carries with it (racing line, corners, pace notes, drift zones, kerbs). Pure JS, no DOM, so a
// Worker or a Node script can use it too. Same seed, same course.

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const ARENA = 186; // keep courses inside the 400 m sandbox walls

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(text) {
  const s = String(text).trim();
  if (/^\d+$/.test(s)) return Number(s) >>> 0;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Seeded Fisher–Yates shuffle. (sort() with a random comparator is not the same thing: how often
 * and in what order it calls the comparator differs between JS engines, so tracks would too.)
 */
function shuffled(arr, R) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(R() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ------------------------------------------------------------------ geometry
const at = (arr, i, closed) => (closed ? arr[((i % arr.length) + arr.length) % arr.length] : arr[clamp(i, 0, arr.length - 1)]);

/** Centripetal Catmull-Rom through control points. */
function catmull(ctrl, closed, per = 16) {
  const out = [];
  const n = ctrl.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = at(ctrl, i - 1, closed), p1 = at(ctrl, i, closed), p2 = at(ctrl, i + 1, closed), p3 = at(ctrl, i + 2, closed);
    const d = (a, b) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    for (let k = 0; k < per; k++) {
      const t = t1 + ((t2 - t1) * k) / per;
      const lerp = (a, b, ta, tb) => [((tb - t) * a[0] + (t - ta) * b[0]) / (tb - ta), ((tb - t) * a[1] + (t - ta) * b[1]) / (tb - ta)];
      const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
      out.push(lerp(B1, B2, t1, t2));
    }
  }
  if (!closed) out.push(ctrl[n - 1]);
  return out;
}

function resample(pts, closed, step) {
  const src = closed ? [...pts, pts[0]] : pts;
  const out = [src[0]];
  let carry = 0;
  for (let i = 0; i < src.length - 1; i++) {
    const a = src[i], b = src[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let d = step - carry;
    while (d <= len) {
      const t = d / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      d += step;
    }
    carry = len - (d - step);
  }
  if (closed) {
    const last = out[out.length - 1];
    if (Math.hypot(last[0] - out[0][0], last[1] - out[0][1]) < step * 0.5) out.pop();
  } else {
    const last = out[out.length - 1], end = pts[pts.length - 1];
    if (Math.hypot(last[0] - end[0], last[1] - end[1]) > step * 0.3) out.push(end);
  }
  return out;
}

/** Signed curvature (CCW +) from the turning angle at each point. */
export function curvatures(pts, closed) {
  const n = pts.length;
  const k = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const a = at(pts, i - 1, closed), b = pts[i], c = at(pts, i + 1, closed);
    const h1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const h2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let dh = h2 - h1;
    dh -= TAU * Math.floor((dh + Math.PI) / TAU);
    const ds = (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - b[0], c[1] - b[1])) / 2;
    k[i] = dh / Math.max(ds, 1e-6);
  }
  if (!closed && n > 2) { k[0] = k[1]; k[n - 1] = k[n - 2]; }
  return k;
}

export function smooth1d(arr, closed, r) {
  const n = arr.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0;
    for (let j = -r; j <= r; j++) {
      const idx = closed ? (((i + j) % n) + n) % n : clamp(i + j, 0, n - 1);
      const wt = r + 1 - Math.abs(j);
      s += arr[idx] * wt; w += wt;
    }
    out[i] = s / w;
  }
  return out;
}

function normalsOf(pts, closed) {
  return pts.map((p, i) => {
    const a = at(pts, i - 1, closed), b = at(pts, i + 1, closed);
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l]; // left of travel
  });
}

function offsetLine(pts, nrm, off) {
  return pts.map((p, i) => [p[0] + nrm[i][0] * (typeof off === 'number' ? off : off[i]), p[1] + nrm[i][1] * (typeof off === 'number' ? off : off[i])]);
}

function cumLength(pts, closed) {
  const s = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) s[i] = s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const total = s[pts.length - 1] + (closed ? Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) : 0);
  return { s, total };
}

/** Smallest distance between two parts of the path that are more than `skip` metres apart along it. */
function minClearance(pts, closed, skip, step) {
  const cell = 24, grid = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  pts.forEach((p, i) => {
    const k = key(p[0], p[1]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const n = pts.length, skipN = Math.ceil(skip / step);
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const [x, y] = pts[i];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
      for (const j of grid.get(`${gx},${gy}`) || []) {
        let gap = Math.abs(i - j);
        if (closed) gap = Math.min(gap, n - gap);
        if (gap <= skipN) continue;
        best = Math.min(best, Math.hypot(pts[j][0] - x, pts[j][1] - y));
      }
    }
  }
  return best;
}

/** Ease the tightest corners open until no radius is below rMin. */
function relaxRadius(pts, closed, rMin, step) {
  let p = pts;
  for (let it = 0; it < 80; it++) {
    const k = curvatures(p, closed);
    let worst = 0;
    const hot = new Uint8Array(p.length);
    for (let i = 0; i < p.length; i++) {
      if (Math.abs(k[i]) > 1 / rMin) {
        worst = Math.max(worst, Math.abs(k[i]));
        for (let j = -4; j <= 4; j++) {
          const idx = closed ? (((i + j) % p.length) + p.length) % p.length : i + j;
          if (idx >= 0 && idx < p.length) hot[idx] = 1;
        }
      }
    }
    if (!worst) break;
    const q = p.map((pt) => [...pt]);
    for (let i = 0; i < p.length; i++) {
      if (!hot[i] || (!closed && (i === 0 || i === p.length - 1))) continue;
      const a = at(p, i - 1, closed), c = at(p, i + 1, closed);
      q[i][0] = p[i][0] * 0.5 + (a[0] + c[0]) * 0.25;
      q[i][1] = p[i][1] * 0.5 + (a[1] + c[1]) * 0.25;
    }
    p = it % 8 === 7 ? resample(q, closed, step) : q;
  }
  return resample(p, closed, step);
}

function fitToArena(pts, margin) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const s = (ARENA - margin) / Math.max((x1 - x0) / 2, (y1 - y0) / 2);
  return pts.map(([x, y]) => [(x - cx) * s, (y - cy) * s]);
}

// ------------------------------------------------------------------ generators
export const STEP = 2; // metres between centreline samples

/** Flowing closed circuit: a star-shaped loop with harmonic radius noise, eased to a minimum radius. */
export function genCircuit(seed) {
  const W = 12, rMin = 15;
  for (let attempt = 0; attempt < 60; attempt++) {
    const R = rng(seed * 2654435761 + attempt * 97);
    const n = 10 + Math.floor(R() * 8);
    const aspect = 0.8 + R() * 0.45, rot = R() * TAU;
    const harm = [1, 2, 3, 4, 5].map((h) => ({ h, a: (R() * 0.34) / Math.sqrt(h), ph: R() * TAU }));
    const ctrl = [];
    for (let i = 0; i < n; i++) {
      const th = (TAU * i) / n + (R() - 0.5) * (TAU / n) * 0.55;
      let r = 0.68;
      for (const { h, a, ph } of harm) r += a * Math.sin(h * th + ph);
      r = clamp(r + (R() - 0.5) * 0.18, 0.22, 1.1);
      const x = Math.cos(th) * r * aspect, y = Math.sin(th) * r / aspect;
      ctrl.push([x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)]);
    }
    let pts = fitToArena(catmull(ctrl, true, 30), W / 2 + 3);
    pts = relaxRadius(resample(pts, true, STEP), true, rMin, STEP);
    pts = fitToArena(pts, W / 2 + 3); // relaxing shrinks the loop a little; re-centre it
    const { total } = cumLength(pts, true);
    if (total < 850 || total > 2100) continue;
    if (minClearance(pts, true, 60, STEP) < W + 14) continue;
    const k = curvatures(pts, true);
    if (Math.max(...k.map(Math.abs)) > 1 / (rMin * 0.9)) continue;
    return finishCourse({ kind: 'circuit', seed, attempt, closed: true, width: W, center: pts });
  }
  throw new Error('no circuit found');
}

/** Technical point-to-point stage: a self-avoiding walk on a 40 m grid, jittered and rounded. */
export function genStage(seed) {
  const W = 9, rMin = 11, N = 9, CELL = 40;
  for (let attempt = 0; attempt < 120; attempt++) {
    const R = rng(seed * 2246822519 + attempt * 131);
    const target = 26 + Math.floor(R() * 10);
    const start = [[0, Math.floor(R() * N)], [N - 1, Math.floor(R() * N)], [Math.floor(R() * N), 0], [Math.floor(R() * N), N - 1]][Math.floor(R() * 4)];
    const path = [start];
    const used = new Set([start.join()]);
    let budget = 4000, dir = null;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const walk = () => {
      if (path.length >= target) return true;
      if (--budget < 0) return false;
      const [cx, cy] = path.at(-1);
      // prefer going straight on, which makes straights; otherwise random turns
      const order = shuffled(dirs, R);
      if (dir && R() < 0.42) order.unshift(dir);
      for (const d of order) {
        const nx = cx + d[0], ny = cy + d[1];
        if (nx < 0 || ny < 0 || nx >= N || ny >= N || used.has(`${nx},${ny}`)) continue;
        const prev = dir;
        path.push([nx, ny]); used.add(`${nx},${ny}`); dir = d;
        if (walk()) return true;
        path.pop(); used.delete(`${nx},${ny}`); dir = prev;
      }
      return false;
    };
    if (!walk()) continue;
    const o = -((N - 1) * CELL) / 2;
    const ctrl = path.map(([gx, gy], i) => {
      const j = i === 0 || i === path.length - 1 ? 0 : 9;
      return [o + gx * CELL + (R() - 0.5) * 2 * j, o + gy * CELL + (R() - 0.5) * 2 * j];
    });
    // drop collinear middles so straights are straight, then let the spline round the corners
    const keep = ctrl.filter((p, i) => {
      if (i === 0 || i === ctrl.length - 1) return true;
      const [ax, ay] = path[i - 1], [bx, by] = path[i], [cx, cy] = path[i + 1];
      return !(bx - ax === cx - bx && by - ay === cy - by) || R() < 0.35;
    });
    let pts = relaxRadius(resample(catmull(keep, false, 24), false, STEP), false, rMin, STEP);
    if (minClearance(pts, false, 50, STEP) < W + 12) continue;
    const k = curvatures(pts, false);
    if (Math.max(...k.map(Math.abs)) > 1 / (rMin * 0.9)) continue;
    const { total } = cumLength(pts, false);
    if (total < 900) continue;
    return finishCourse({ kind: 'stage', seed, attempt, closed: false, width: W, center: pts });
  }
  throw new Error('no stage found');
}

/**
 * Gymkhana: a self-avoiding walk over a 4×4 grid of 90 m cells. Straight-through cells get a slalom
 * or a gate chicane; turning cells get a 450° loop round a tyre stack; the walk ends in a cone garage.
 */
export function genGymkhana(seed) {
  const N = 4, CELL = 90, o = -((N - 1) * CELL) / 2;
  for (let attempt = 0; attempt < 200; attempt++) {
    const R = rng(seed * 3266489917 + attempt * 61);
    const target = 7 + Math.floor(R() * 4);
    const path = [[Math.floor(R() * N), Math.floor(R() * N)]];
    const used = new Set([path[0].join()]);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let budget = 3000;
    const walk = () => {
      if (path.length >= target) return true;
      if (--budget < 0) return false;
      const [cx, cy] = path.at(-1);
      for (const d of shuffled(dirs, R)) {
        const nx = cx + d[0], ny = cy + d[1];
        if (nx < 0 || ny < 0 || nx >= N || ny >= N || used.has(`${nx},${ny}`)) continue;
        path.push([nx, ny]); used.add(`${nx},${ny}`);
        if (walk()) return true;
        path.pop(); used.delete(`${nx},${ny}`);
      }
      return false;
    };
    if (!walk()) continue;
    const centre = (c) => [o + c[0] * CELL, o + c[1] * CELL];
    const way = [], cones = [], tyres = [], elements = [];
    const add = (p) => way.push(p);
    const first = centre(path[0]);
    const d0 = [path[1][0] - path[0][0], path[1][1] - path[0][1]];
    const start = { x: first[0] - d0[0] * 20, y: first[1] - d0[1] * 20, heading: Math.atan2(d0[1], d0[0]) };
    add([start.x, start.y]);
    for (let i = 0; i < path.length; i++) {
      const C = centre(path[i]);
      const din = i === 0 ? d0 : [path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]];
      const dout = i === path.length - 1 ? din : [path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]];
      const side = [-din[1], din[0]]; // left of travel
      const P = (along, lat) => [C[0] + din[0] * along + side[0] * lat, C[1] + din[1] * along + side[1] * lat];
      if (i === 0) {
        add(P(0, 0));
        elements.push({ type: 'Start box', at: P(-20, 0) });
      } else if (i === path.length - 1) {
        // garage: stop between four cones
        add(P(-22, 0)); add(P(0, 0));
        for (const [a, l] of [[-3.6, -2.3], [-3.6, 2.3], [3.6, -2.3], [3.6, 2.3]]) cones.push(P(a, l));
        elements.push({ type: 'Garage stop', at: P(0, 0) });
      } else if (din[0] === dout[0] && din[1] === dout[1]) {
        if (R() < 0.6) {
          const nC = 5 + Math.floor(R() * 2), gap = 13 + R() * 3, sgn = R() < 0.5 ? 1 : -1;
          for (let c = 0; c < nC; c++) {
            const along = (c - (nC - 1) / 2) * gap;
            cones.push(P(along, 0));
            add(P(along, (c % 2 ? 1 : -1) * sgn * 3.6));
          }
          elements.push({ type: `Slalom ×${nC}`, at: C });
        } else {
          const sgn = R() < 0.5 ? 1 : -1;
          for (const [along, lat] of [[-18, 5 * sgn], [18, -5 * sgn]]) {
            cones.push(P(along, lat - 3.2), P(along, lat + 3.2));
            add(P(along, lat));
          }
          elements.push({ type: 'Gate chicane', at: C });
        }
      } else if (R() < 0.4) {
        // cone box on the inside of the turn: go round the outside of it
        const inner = [dout[0] - din[0], dout[1] - din[1]];
        for (const [a, b] of [[-2.5, -2.5], [-2.5, 2.5], [2.5, -2.5], [2.5, 2.5]]) cones.push([C[0] + inner[0] * 7 + a, C[1] + inner[1] * 7 + b]);
        add([C[0] - din[0] * 24, C[1] - din[1] * 24]);
        add([C[0] - inner[0] * 4, C[1] - inner[1] * 4]);
        add([C[0] + dout[0] * 24, C[1] + dout[1] * 24]);
        elements.push({ type: 'Cone box turn', at: C });
      } else {
        // 450° loop: round the tyre stack once, then leave toward the next cell
        const left = din[0] * dout[1] - din[1] * dout[0] > 0;
        const r = 7.5, s = left ? 1 : -1;
        tyres.push(C);
        const phi = (d) => (left ? Math.atan2(-d[0], d[1]) : Math.atan2(d[0], -d[1]));
        const p0 = phi(din);
        let sweep = phi(dout) - p0;
        sweep = left ? ((sweep % TAU) + TAU) % TAU : -((((-sweep) % TAU) + TAU) % TAU);
        sweep += s * TAU;
        add(P(-30, 0));
        const steps = Math.ceil(Math.abs(sweep) / 0.35);
        for (let k = 0; k <= steps; k++) {
          const ph = p0 + (sweep * k) / steps;
          add([C[0] + Math.cos(ph) * r, C[1] + Math.sin(ph) * r]);
        }
        const exitSide = [-dout[1], dout[0]];
        add([C[0] + dout[0] * 30 + exitSide[0] * 0, C[1] + dout[1] * 30]);
        elements.push({ type: `${left ? 'Left' : 'Right'} 450° pylon`, at: C });
      }
      if (i < path.length - 1) {
        const N2 = centre(path[i + 1]);
        add([(C[0] + N2[0]) / 2, (C[1] + N2[1]) / 2]);
      }
    }
    const route = resample(catmull(way, false, 12), false, STEP);
    const k = curvatures(route, false);
    if (Math.max(...k.map(Math.abs)) > 1 / 4.5) continue; // the car turns down to ~3.9 m
    return finishCourse({ kind: 'gymkhana', seed, attempt, closed: false, width: 8, center: route, cones, tyres, elements, start });
  }
  throw new Error('no gymkhana found');
}

// ------------------------------------------------------------------ racing line
/**
 * Minimum-curvature line inside the corridor: gradient descent on Σ|second difference|², run on an
 * 8 m sampling first (long corners converge there), then refined at full resolution.
 */
function racingLine(center, closed, halfW) {
  const n = center.length;
  const nrm = normalsOf(center, closed);
  const solve = (idx, iters, eta, off) => {
    const m = idx.length;
    const C = idx.map((i) => center[i]), Nn = idx.map((i) => nrm[i]);
    const L = C.map((p, i) => [p[0] + Nn[i][0] * off[i], p[1] + Nn[i][1] * off[i]]);
    const d = new Array(m);
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < m; i++) {
        if (!closed && (i === 0 || i === m - 1)) { d[i] = [0, 0]; continue; }
        const a = at(L, i - 1, closed), c = at(L, i + 1, closed);
        d[i] = [a[0] - 2 * L[i][0] + c[0], a[1] - 2 * L[i][1] + c[1]];
      }
      for (let i = 0; i < m; i++) {
        if (!closed && i < 2) continue;
        if (!closed && i > m - 3) continue;
        const a = at(d, i - 1, closed), c = at(d, i + 1, closed);
        const gx = a[0] - 2 * d[i][0] + c[0], gy = a[1] - 2 * d[i][1] + c[1];
        off[i] = clamp(off[i] - eta * (gx * Nn[i][0] + gy * Nn[i][1]), -halfW, halfW);
        L[i] = [C[i][0] + Nn[i][0] * off[i], C[i][1] + Nn[i][1] * off[i]];
      }
    }
    return off;
  };
  const stride = 4;
  const coarseIdx = [];
  for (let i = 0; i < n; i += stride) coarseIdx.push(i);
  if (!closed && coarseIdx.at(-1) !== n - 1) coarseIdx.push(n - 1);
  const coarse = solve(coarseIdx, 2500, 0.1, new Float64Array(coarseIdx.length));
  // upsample offsets
  const off = new Float64Array(n);
  for (let c = 0; c < coarseIdx.length; c++) {
    const i0 = coarseIdx[c];
    const i1 = c + 1 < coarseIdx.length ? coarseIdx[c + 1] : closed ? n : i0;
    const o0 = coarse[c], o1 = c + 1 < coarseIdx.length ? coarse[c + 1] : closed ? coarse[0] : o0;
    for (let i = i0; i < i1 && i < n; i++) off[i] = o0 + ((o1 - o0) * (i - i0)) / Math.max(1, i1 - i0);
    if (i1 === i0) off[i0] = o0;
  }
  const fineIdx = [...Array(n).keys()];
  solve(fineIdx, 300, 0.05, off);
  return { pts: offsetLine(center, nrm, off), off, nrm };
}

// ------------------------------------------------------------------ corner analysis
function corners(center, closed) {
  const k = smooth1d(curvatures(center, closed), closed, 3);
  const n = center.length;
  const TH = 1 / 160;
  const runs = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    const sg = Math.abs(k[i]) > TH ? Math.sign(k[i]) : 0;
    if (sg && cur && cur.sign === sg) cur.end = i;
    else {
      if (cur) runs.push(cur);
      cur = sg ? { sign: sg, start: i, end: i } : null;
    }
  }
  if (cur) runs.push(cur);
  // merge same-direction runs separated by a short gap
  const merged = [];
  for (const r of runs) {
    const last = merged.at(-1);
    if (last && last.sign === r.sign && (r.start - last.end) * STEP < 10) last.end = r.end;
    else merged.push({ ...r });
  }
  if (closed && merged.length > 1) {
    const f = merged[0], l = merged.at(-1);
    if (f.sign === l.sign && f.start === 0 && l.end === n - 1) { l.end = n - 1 + f.end + 1; merged.shift(); }
  }
  const out = [];
  for (const r of merged) {
    let angle = 0, kmax = 0, apex = r.start;
    for (let i = r.start; i <= r.end; i++) {
      const kk = k[i % n];
      angle += kk * STEP;
      if (Math.abs(kk) > kmax) { kmax = Math.abs(kk); apex = i % n; }
    }
    const deg = Math.abs((angle * 180) / Math.PI);
    if (deg < 14) continue;
    const len = r.end - r.start + 1;
    const third = Math.max(1, Math.floor(len / 3));
    const avgK = (a, b) => {
      let s = 0;
      for (let i = a; i < b; i++) s += Math.abs(k[i % n]);
      return s / Math.max(1, b - a);
    };
    const kIn = avgK(r.start, r.start + third), kOut = avgK(r.end + 1 - third, r.end + 1);
    out.push({
      dir: r.sign > 0 ? 'Left' : 'Right', start: r.start % n, end: r.end % n, apex, len: len * STEP,
      radius: 1 / kmax, deg, tightens: kOut > kIn * 1.45, opens: kIn > kOut * 1.45,
    });
  }
  return out;
}

function severity(c) {
  const R = c.radius;
  if (R < 13 || (c.deg > 140 && R < 22)) return 'Hairpin';
  if (R < 22 && c.deg > 70 && c.deg < 110) return 'Square';
  if (R < 20) return '1';
  if (R < 30) return '2';
  if (R < 45) return '3';
  if (R < 65) return '4';
  if (R < 95) return '5';
  return '6';
}

/** Rally pace notes, from a finite vocabulary a build step can voice once. */
function paceNotes(cs, closed, total) {
  const notes = [];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i], next = cs[i + 1] || (closed ? cs[0] : null), prev = cs[i - 1] || (closed ? cs.at(-1) : null);
    const sev = severity(c);
    const words = [];
    const gapBefore = prev ? ((((c.start - prev.end) * STEP) % total) + total) % total : c.start * STEP;
    if (gapBefore > 110 && ['Hairpin', 'Square', '1', '2'].includes(sev)) words.push('Caution');
    words.push(sev === 'Hairpin' || sev === 'Square' ? `${sev} ${c.dir}` : `${c.dir} ${sev}`);
    if (c.deg > 120 && sev !== 'Hairpin') words.push('long');
    if (c.tightens) words.push('tightens');
    else if (c.opens) words.push('opens');
    let link = '';
    if (next) {
      const gap = ((((next.start - c.end) * STEP) % total) + total) % total;
      if (gap < 16) link = 'into';
      else if (gap < 32) link = 'and';
      else if (gap < 100) link = String(Math.round(gap / 10) * 10);
      else link = String(Math.min(300, Math.round(gap / 50) * 50));
    } else link = 'Finish';
    notes.push({ ...c, sev, call: words.join(' '), link });
  }
  return notes;
}

/** Drift zones: medium-radius, long-angle corners; clipping points on the inside apex and outside exit. */
function driftZones(cs, center, nrm, halfW, closed) {
  const n = center.length;
  return cs
    .filter((c) => c.radius > 16 && c.radius < 75 && c.deg > 55)
    .map((c) => {
      const inside = c.dir === 'Left' ? 1 : -1;
      const ap = c.apex;
      const exitI = (c.start + Math.round(((c.end - c.start + n) % n) * 0.8)) % n;
      const P = (i, side) => [center[i][0] + nrm[i][0] * side * (halfW - 0.6), center[i][1] + nrm[i][1] * side * (halfW - 0.6)];
      return { ...c, from: closed ? (c.start - 8 + n) % n : Math.max(0, c.start - 8), to: closed ? (c.end + 8) % n : Math.min(n - 1, c.end + 8), clipIn: P(ap, inside), clipOut: P(exitI, -inside) };
    });
}

/** Which centreline samples get a kerb on each side: the inside at the apex, the outside at the exit. */
function kerbFlags(cs, n, closed) {
  const left = new Uint8Array(n), right = new Uint8Array(n);
  const mark = (arr, a, b) => {
    for (let i = a; i <= b; i++) {
      const j = closed ? ((i % n) + n) % n : i;
      if (j >= 0 && j < n) arr[j] = 1;
    }
  };
  for (const c of cs) {
    if (c.radius > 45) continue;
    const end = c.end < c.start ? c.end + n : c.end;
    const [inside, outside] = c.dir === 'Left' ? [left, right] : [right, left];
    mark(inside, c.apex - 7, c.apex + 7);
    mark(outside, end - 10, end + 2);
  }
  return { left, right };
}

function finishCourse(course) {
  const { center, closed, width } = course;
  const nrm = normalsOf(center, closed);
  const { s, total } = cumLength(center, closed);
  course.length = total;
  course.s = s;
  course.normals = nrm;
  course.edges = [offsetLine(center, nrm, width / 2), offsetLine(center, nrm, -width / 2)];
  if (course.kind === 'gymkhana') {
    course.line = center;
  } else {
    course.line = racingLine(center, closed, width / 2 - 1.7).pts;
    course.corners = corners(center, closed);
    course.notes = paceNotes(course.corners, closed, total);
    course.zones = driftZones(course.corners, center, nrm, width / 2, closed);
    course.kerbs = kerbFlags(course.corners, center.length, closed);
  }
  course.walls = wallSegments(course);
  if (!course.start) {
    const a = center[0], b = center[1];
    const h = Math.atan2(b[1] - a[1], b[0] - a[0]);
    course.start = { x: course.line[0][0], y: course.line[0][1], heading: h };
  }
  return course;
}

export const WALL_GAP = 1.2; // walls stand this far outside the painted track edge, m

/** Barrier walls for World.addWall: both edges, WALL_GAP outside the painted edge. */
export function wallSegments(course) {
  if (course.kind === 'gymkhana') return [];
  const segs = [];
  const nrm = course.normals;
  for (const side of [1, -1]) {
    const e = offsetLine(course.center, nrm, side * (course.width / 2 + WALL_GAP));
    const pts = [];
    for (let i = 0; i < e.length; i += 2) pts.push(e[i]);
    for (let i = 0; i < pts.length - 1; i++) segs.push([...pts[i], ...pts[i + 1]]);
    if (course.closed) segs.push([...pts.at(-1), ...pts[0]]);
  }
  return segs;
}

export const KINDS = {
  circuit: { name: 'Circuit', gen: genCircuit },
  stage: { name: 'Rally stage', gen: genStage },
  gymkhana: { name: 'Gymkhana', gen: genGymkhana },
};

/** Build a course. Throws if no valid layout turns up for this seed (rare). */
export function generate(kind, seed) {
  return KINDS[kind].gen(seed >>> 0);
}
