// Quasi-steady-state lap simulation: the fastest a course can be driven with a given tuning.
// Corner speeds come from the grip circle, then a forward pass adds the car's own torque curve and
// gears and a backward pass its brakes. Gives the par time and the bot's speed targets.
import { GEARS, FINAL_DRIVE, WHEEL_RADIUS, torqueAt } from '../physics/car.js';
import { curvatures, smooth1d } from './generate.js';

const TAU = Math.PI * 2;
const G = 9.81;

/** Best forward acceleration at speed v over all gears, after drag (same numbers as car.js). */
function engineAccel(v, t) {
  let best = 0;
  for (const g of GEARS) {
    const rpm = Math.max(3000, (v / WHEEL_RADIUS) * (60 / TAU) * g * FINAL_DRIVE);
    if (rpm > t.maxRpm) continue;
    best = Math.max(best, (torqueAt(rpm, t.maxRpm) * t.enginePower * g * FINAL_DRIVE * 0.85) / WHEEL_RADIUS);
  }
  return (best - t.drag * v * v - t.rollingResistance * v) / t.mass;
}

/** Speed at every point of `pts` and the time to drive them. v0 = Infinity solves a flying lap. */
export function speedProfile(pts, closed, tune, { v0 = Infinity, vEnd = Infinity, gripScale = 1 } = {}) {
  // a closed loop is solved over three laps and the middle one kept, so the profile is periodic
  const reps = closed && v0 === Infinity ? 3 : 1;
  const loop = [];
  for (let r = 0; r < reps; r++) loop.push(...pts);
  if (closed) loop.push(pts[0]);
  const n = loop.length;
  const kc = smooth1d(curvatures(pts, closed), closed, 2);
  const k = new Float64Array(n);
  for (let i = 0; i < n; i++) k[i] = kc[i % pts.length];
  const ds = new Float64Array(n);
  for (let i = 1; i < n; i++) ds[i] = Math.hypot(loop[i][0] - loop[i - 1][0], loop[i][1] - loop[i - 1][1]);
  const mu = Math.min(tune.gripFront, tune.gripRear) * gripScale;
  const muG = mu * G;
  const traction = tune.drive === 'AWD' ? mu * G : tune.gripRear * gripScale * G * (tune.drive === 'FWD' ? 0.45 : 0.56);
  const vc = new Float64Array(n);
  for (let i = 0; i < n; i++) vc[i] = Math.min(70, Math.sqrt(muG / Math.max(Math.abs(k[i]), 1e-5)));
  vc[0] = Math.min(vc[0], v0);
  vc[n - 1] = Math.min(vc[n - 1], vEnd);
  const v = Float64Array.from(vc);
  for (let i = 0; i < n - 1; i++) {
    const lat = v[i] * v[i] * Math.abs(k[i]);
    const avail = Math.sqrt(Math.max(0, muG * muG - lat * lat));
    const a = Math.min(avail, engineAccel(v[i], tune), traction);
    v[i + 1] = Math.min(v[i + 1], Math.sqrt(v[i] * v[i] + 2 * Math.max(a, 0) * ds[i + 1]));
  }
  for (let i = n - 1; i > 0; i--) {
    const lat = v[i] * v[i] * Math.abs(k[i]);
    const avail = Math.sqrt(Math.max(0, muG * muG - lat * lat));
    const a = Math.min(avail, tune.brakeForce * G * (tune.abs ? 1 : 0.85));
    v[i - 1] = Math.min(v[i - 1], Math.sqrt(v[i] * v[i] + 2 * a * ds[i]));
  }
  const m = pts.length;
  const o = reps === 3 ? m : 0;
  let time = 0;
  for (let i = o + 1; i <= o + m - (closed ? 0 : 1); i++) time += (2 * ds[i]) / Math.max(0.5, v[i] + v[i - 1]);
  return { v: v.slice(o, o + m), time };
}

/** Par time (standing start) and the flying-lap profile the bot drives to. */
export function analyse(course, tune) {
  const vEnd = course.kind === 'gymkhana' ? 0 : Infinity;
  const par = speedProfile(course.line, course.closed, tune, { v0: 0, vEnd });
  const fly = speedProfile(course.line, course.closed, tune, { vEnd });
  return { v: fly.v, par: par.time, flying: fly.time, standing: par.v };
}
