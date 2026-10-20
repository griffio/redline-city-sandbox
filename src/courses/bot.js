// The bot: drives the real Car round a course with pure pursuit on the racing line and speed
// targets from the lap sim. simulate() runs it headless, stepping exactly like the game loop, to
// prove a course drivable and to record the ghost and split times the player races against.
import { Car } from '../physics/car.js';
import { World } from '../physics/world.js';
import { STEP } from './generate.js';
import { analyse } from './lapsim.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const PHYS_DT = 1 / 240;
export const GHOST_HZ = 30;

/** Sends the same command object the control schemes produce: {throttle, brake, steer, steerAngle}. */
export class Bot {
  constructor(course, profile, { pace = 0.94 } = {}) {
    this.c = course;
    this.v = profile.v;
    this.pace = pace;
    this.idx = 0;
    this.lapDist = 0; // samples travelled, counting laps on a loop
  }

  locate(car) {
    const L = this.c.line, n = L.length, closed = this.c.closed;
    let best = Infinity, bi = this.idx;
    for (let j = -4; j <= 12; j++) {
      let i = this.idx + j;
      if (closed) i = ((i % n) + n) % n;
      else if (i < 0 || i >= n) continue;
      const d = (L[i][0] - car.x) ** 2 + (L[i][1] - car.y) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    let step = bi - this.idx;
    if (closed && step < -n / 2) step += n;
    this.lapDist += step;
    this.idx = bi;
    return Math.sqrt(best);
  }

  command(car) {
    const L = this.c.line, n = L.length, closed = this.c.closed;
    const off = this.locate(car);
    const v = car.speed;
    const pick = (ahead) => (closed ? (this.idx + ahead) % n : Math.min(n - 1, this.idx + ahead));
    const Ld = clamp(5 + 0.42 * v, 7, 34);
    const tp = L[pick(Math.round(Ld / STEP))];
    // pure pursuit in the direction of travel (not the nose), so a slide doesn't fool it
    const course = v > 3 ? Math.atan2(car.vy, car.vx) : car.heading;
    const c = Math.cos(course), s = Math.sin(course);
    const dx = tp[0] - car.x, dy = tp[1] - car.y;
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    const kappa = (2 * ly) / Math.max(1, lx * lx + ly * ly);
    const t = car.t;
    const wb = t.cgToFront + t.cgToRear;
    // wheel angle from the nose = angle wanted relative to the travel direction + body slip, plus
    // yaw-rate feedback to catch slides. The car adds countersteer assist × slip on top of
    // steerAngle itself, so leave that share out.
    const beta = car.bodySlip;
    const assist = v > 2 ? t.countersteer * clamp((v - 2) / 4, 0, 1) : 0;
    const steerAngle = Math.atan(kappa * wb) + 0.12 * (kappa * v - car.yawRate) + beta * (1 - assist);
    // speed: look a little ahead so braking starts on time
    let vt = Infinity;
    const look = Math.round((v * 0.35 + 4) / STEP);
    for (let j = 0; j <= look; j++) vt = Math.min(vt, this.v[pick(j)]);
    vt = Math.max(vt * this.pace, 2.5);
    const e = vt - v;
    let throttle = 0, brake = 0;
    if (e > 0) throttle = clamp(0.35 + e * 0.35, 0, 1);
    else brake = clamp(-e * 0.3, 0, 1);
    // stop in the garage (gymkhana) or after the flying finish (stage)
    const end = L[n - 1];
    if (!closed && (this.idx >= n - 2 || Math.hypot(end[0] - car.x, end[1] - car.y) < 1.5 + v * 0.15)) { throttle = 0; brake = 1; }
    // ease off when the rear is sliding (crude traction control)
    if (Math.abs(car.bodySlip) > 0.2) throttle *= 0.4;
    return { throttle, brake, steer: clamp(steerAngle / 0.6, -1, 1), steerAngle, handbrake: 0, drift: false, off };
  }
}

/** Uniform grid of barriers so collision only checks the walls near the car. */
export function barrierGrid(barriers, cell = 16) {
  const cells = new Map();
  for (const b of barriers) {
    const r = b.hl + 4;
    for (let gx = Math.floor((b.x - r) / cell); gx <= Math.floor((b.x + r) / cell); gx++) {
      for (let gy = Math.floor((b.y - r) / cell); gy <= Math.floor((b.y + r) / cell); gy++) {
        const k = `${gx},${gy}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(b);
      }
    }
  }
  const empty = [];
  return (x, y) => cells.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`) || empty;
}

/**
 * Run the bot headless with this tuning: 240 Hz physics, commands refreshed every 4th step, as in
 * the game. A loop runs two laps so the second is a flying lap. Returns the lap sim's par times
 * and, per lap, its time, a ghost (x, y, heading at GHOST_HZ) and the lap time at each line sample.
 */
export function simulate(course, tune, { pace = 0.94, laps = course.closed ? 2 : 1 } = {}) {
  const car = new Car();
  Object.assign(car.t, tune);
  car.model = 'physics'; // the bot's controller is written for the tyre model
  car.reset(course.start.x, course.start.y, course.start.heading);
  const world = new World();
  world.loadCourse(course);
  const near = barrierGrid(world.barriers);
  const profile = analyse(course, car.t);
  const bot = new Bot(course, profile, { pace });
  const n = course.line.length, end = course.line[n - 1];
  const out = { par: profile.par, flying: profile.flying, laps: [], hits: 0, rescues: 0, cones: 0, total: Infinity };
  let t = 0, tick = 0, cmd = null, stuck = 0, hitCool = 0;
  const newLap = () => ({ time: 0, start: t, frames: [], at: new Float32Array(n).fill(NaN), reached: -1 });
  let lap = newLap();
  const closeLap = () => {
    lap.time = t - lap.start;
    lap.frames = Float32Array.from(lap.frames);
    out.laps.push(lap);
  };

  while (t < 600) {
    if (tick % 4 === 0) cmd = bot.command(car);
    if (tick % (240 / GHOST_HZ) === 0) lap.frames.push(car.x, car.y, car.heading);
    tick++;
    car.step(PHYS_DT, cmd);
    world.barriers = near(car.x, car.y);
    const impact = world.step(PHYS_DT, car);
    t += PHYS_DT;
    hitCool = Math.max(0, hitCool - PHYS_DT);
    if (impact > 1.5 && hitCool === 0) { out.hits++; hitCool = 0.5; }

    // split times: when each line sample is first reached on this lap
    const prog = course.closed ? bot.lapDist - out.laps.length * n : bot.idx;
    for (let k = lap.reached + 1; k <= Math.min(prog, n - 1); k++) lap.at[k] = t - lap.start;
    lap.reached = Math.max(lap.reached, Math.min(prog, n - 1));

    // stuck or far off the line: put it back on the line, +5 s
    stuck = car.speed < 1 && t > 3 ? stuck + PHYS_DT : 0;
    if (stuck > 2.5 || cmd.off > course.width * 1.5) {
      const i = bot.idx, j = course.closed ? (i + 1) % n : Math.min(n - 1, i + 1);
      const L = course.line;
      car.reset(L[i][0], L[i][1], Math.atan2(L[j][1] - L[i][1], L[j][0] - L[i][0]));
      out.rescues++;
      stuck = 0;
    }

    if (course.closed) {
      if (bot.lapDist >= (out.laps.length + 1) * n) {
        closeLap();
        if (out.laps.length >= laps) break;
        lap = newLap();
      }
    } else if (course.kind === 'gymkhana' ? Math.hypot(end[0] - car.x, end[1] - car.y) < 3.5 && car.speed < 1 : bot.idx >= n - 2) {
      closeLap();
      break;
    }
  }
  if (out.laps.length) {
    out.cones = world.props.filter((p) => p.kind === 'cone' && p.down).length;
    out.total = out.laps.reduce((a, l) => a + l.time, 0) + out.cones * 2 + out.rescues * 5;
  }
  return out;
}
