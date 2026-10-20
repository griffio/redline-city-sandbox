// Bakes a course into the ground shader's course texture (rgba16float). For each texel near the
// track: R = distance to the centreline, G/B = cos/sin of the kerb-stripe phase along the track,
// A = 1 where that side has a kerb. A distance field interpolates cleanly, so the painted edges stay
// sharp at any zoom even from a ~0.4 m texel. It is unsigned on purpose: halfway between two
// stretches of track a signed distance flips from +d to -d, and filtering that would paint a line.

const BAND = 16; // metres either side of the centreline that get real values (gymkhana guide: 3)
const STRIPE = 3; // kerb stripe period, m (red 1.5, white 1.5)
const FAR = 99;

/**
 * @param course  a generated course
 * @param extent  half-size of the square the texture covers, metres (same as the skid texture)
 * @param res     texture size in texels
 * @returns Uint16Array of half floats, res × res × 4, row 0 = north edge
 */
export function bakeCourseMap(course, extent, res) {
  const texel = (extent * 2) / res;
  const N = res * res;
  const best = new Float32Array(N).fill(Infinity); // squared distance to the nearest segment so far
  const along = new Float32Array(N), kerb = new Uint8Array(N);
  const C = course.center, n = C.length;
  const segs = course.closed ? n : n - 1;
  const band = course.kind === 'gymkhana' ? 3 : BAND;
  const kerbs = course.kerbs;
  for (let i = 0; i < segs; i++) {
    const a = C[i], b = C[(i + 1) % n];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len2 = ex * ex + ey * ey || 1e-9, len = Math.sqrt(len2);
    const c0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - band + extent) / texel));
    const c1 = Math.min(res - 1, Math.ceil((Math.max(a[0], b[0]) + band + extent) / texel));
    const r0 = Math.max(0, Math.floor((extent - Math.max(a[1], b[1]) - band) / texel));
    const r1 = Math.min(res - 1, Math.ceil((extent - Math.min(a[1], b[1]) + band) / texel));
    for (let r = r0; r <= r1; r++) {
      const py = extent - (r + 0.5) * texel - a[1];
      for (let c = c0; c <= c1; c++) {
        const px = -extent + (c + 0.5) * texel - a[0];
        const t = Math.min(1, Math.max(0, (px * ex + py * ey) / len2));
        const dx = px - ex * t, dy = py - ey * t;
        const d2 = dx * dx + dy * dy;
        const k = r * res + c;
        if (d2 >= best[k]) continue;
        best[k] = d2;
        const left = ex * py - ey * px >= 0;
        along[k] = course.s[i] + t * len;
        kerb[k] = kerbs ? (left ? kerbs.left[i] : kerbs.right[i]) : 0;
      }
    }
  }
  // on a loop, fit a whole number of stripes so the pattern meets itself at the start line
  const period = course.closed ? course.length / Math.max(1, Math.round(course.length / STRIPE)) : STRIPE;
  const out = new Uint16Array(N * 4);
  const FAR_H = half(FAR), ONE = half(1);
  for (let k = 0; k < N; k++) {
    const o = k * 4;
    if (best[k] > band * band) { out[o] = FAR_H; out[o + 1] = ONE; continue; }
    const ph = (along[k] / period) * Math.PI * 2;
    out[o] = half(Math.sqrt(best[k]));
    out[o + 1] = half(Math.cos(ph));
    out[o + 2] = half(Math.sin(ph));
    out[o + 3] = kerb[k] ? ONE : 0;
  }
  return out;
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
/** float32 → IEEE half bits, rounded to nearest. */
function half(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 112; // rebias 127 → 15
  const m = x & 0x7fffff;
  if (e <= 0) return e < -10 ? sign : sign | ((((m | 0x800000) >> (1 - e)) + 0x1000) >> 13);
  if (e >= 31) return sign | 0x7c00;
  return sign | ((e << 10) + ((m + 0x1000) >> 13));
}
