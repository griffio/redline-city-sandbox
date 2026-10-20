// Timing for a generated course: checkpoints passed in order, laps (circuit) or a finish (stage,
// gymkhana garage stop), cone penalties, medals, the bot's ghost and the live gap to it, and the
// pace note coming up next.
import { STEP } from './generate.js';
import { GHOST_HZ } from './bot.js';

const CP_EVERY = 10; // line samples between checkpoints (20 m)
const BEST_KEY = 'redline.courses.v1';

const bests = {
  all() { try { return JSON.parse(localStorage.getItem(BEST_KEY) || '{}'); } catch { return {}; } },
  get(key) { return this.all()[key] ?? null; },
  set(key, v) {
    try { localStorage.setItem(BEST_KEY, JSON.stringify({ ...this.all(), [key]: v })); } catch { /* private mode etc. */ }
  },
};

export const MEDALS = ['gold', 'silver', 'bronze'];

/** 83.456 → "1:23.46" */
export function formatTime(t) {
  if (t == null || !isFinite(t)) return '–:––.––';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export class CourseSession {
  /**
   * @param course a generated course
   * @param ref    simulate() result for the current tuning
   * @param key    storage key for best times (kind:seed)
   */
  constructor(course, ref, key) {
    this.c = course;
    this.ref = ref;
    this.key = key;
    const n = course.center.length;
    this.cps = [];
    for (let i = CP_EVERY; i < n - 2; i += CP_EVERY) this.cps.push(i);
    this.radius = course.kind === 'gymkhana' ? 7 : course.width / 2 + 3;
    // circuits are judged on the best lap against the bot's flying lap; the rest on the whole run
    const refRun = course.closed ? ref.laps[1] ?? ref.laps[0] : ref.laps[0];
    const botTime = course.closed ? refRun?.time : ref.total;
    const parTime = course.closed ? ref.flying : ref.par;
    this.targets = isFinite(botTime)
      ? { gold: parTime * 1.05, silver: botTime, bronze: botTime * 1.15 }
      : { gold: parTime * 1.05, silver: parTime * 1.15, bronze: parTime * 1.3 };
    this.best = bests.get(key);
    if (course.kind === 'gymkhana') {
      // where each element sits along the route, in order
      let from = 0;
      this.elemIdx = course.elements.map((e) => {
        let bestD = Infinity, bi = from;
        for (let i = from; i < n; i++) {
          const d = (course.center[i][0] - e.at[0]) ** 2 + (course.center[i][1] - e.at[1]) ** 2;
          if (d < bestD) { bestD = d; bi = i; }
        }
        return (from = bi);
      });
    }
    this.reset();
  }

  reset() {
    this.state = 'ready'; // ready → running → finished
    this.t = 0;
    this.lap = 1;
    this.lapStart = 0;
    this.lastLap = null;
    this.cp = 0;
    this.idx = 0;
    this.reached = 0;
    this.delta = null;
    this.cones = 0;
    this.result = null;
    this.prevAlong = null;
  }

  get lapTime() {
    return this.state === 'finished' ? this.result.time : this.t - this.lapStart;
  }

  /** Medal for a time, or null. */
  medalFor(time) {
    return MEDALS.find((m) => time <= this.targets[m]) ?? null;
  }

  /** Advance one frame. Returns events: {type: 'start' | 'lap' | 'finish', ...}. */
  update(dt, car, world) {
    const ev = [];
    if (this.state === 'finished') return ev;
    if (this.state === 'ready') {
      if (car.speed < 0.6) return ev;
      this.state = 'running'; // the clock starts when the car moves
      ev.push({ type: 'start' });
    }
    this.t += dt;
    const c = this.c, C = c.center, n = C.length;
    this.locate(car);
    const next = this.cps[this.cp];
    if (next !== undefined && Math.hypot(C[next][0] - car.x, C[next][1] - car.y) < this.radius) this.cp++;
    const allPassed = this.cp >= this.cps.length;

    if (c.kind === 'gymkhana') {
      this.cones = world.props.filter((p) => p.kind === 'cone' && p.down).length;
      const end = C[n - 1];
      if (allPassed && Math.hypot(end[0] - car.x, end[1] - car.y) < 3.5 && car.speed < 1) {
        ev.push(this.finish(this.t, this.cones * 2));
      }
    } else {
      // timing line: the start on a loop, the end of a stage; crossing time interpolated in the frame
      const i = c.closed ? 0 : n - 1;
      const p = C[i], nr = c.normals[i];
      const tx = nr[1], ty = -nr[0];
      const along = (car.x - p[0]) * tx + (car.y - p[1]) * ty;
      const across = Math.abs((car.x - p[0]) * nr[0] + (car.y - p[1]) * nr[1]);
      const prev = this.prevAlong;
      this.prevAlong = along;
      if (allPassed && prev !== null && prev < 0 && along >= 0 && across < c.width / 2 + 2.5) {
        const at = this.t - (dt * along) / Math.max(1e-6, along - prev);
        const time = Math.max(0, at - this.lapStart);
        ev.push(c.closed ? this.completeLap(time, at) : this.finish(time, 0));
      }
    }
    this.updateDelta();
    return ev;
  }

  /** Nearest centreline sample, searched between the last checkpoint and the next one. */
  locate(car) {
    const C = this.c.center, n = C.length, closed = this.c.closed;
    const lo = (this.cp > 0 ? this.cps[this.cp - 1] : 0) - 6;
    const hi = (this.cps[this.cp] ?? n - 1) + 6;
    let bestD = Infinity, bi = this.idx;
    for (let j = lo; j <= hi; j++) {
      const i = closed ? ((j % n) + n) % n : Math.max(0, Math.min(n - 1, j));
      const d = (C[i][0] - car.x) ** 2 + (C[i][1] - car.y) ** 2;
      if (d < bestD) { bestD = d; bi = i; }
    }
    // just after the line on a loop, the samples near n-1 aren't progress
    if (closed && this.cp === 0 && bi > n - 20) bi = 0;
    this.idx = bi;
    this.reached = Math.max(this.reached, bi);
  }

  completeLap(time, at) {
    const best = !this.best || time < this.best.time;
    const medal = this.medalFor(time);
    if (best) {
      this.best = { time, medal };
      bests.set(this.key, this.best);
    }
    this.lastLap = time;
    this.lap++;
    this.lapStart = at;
    this.cp = 0;
    this.reached = 0;
    this.idx = 0;
    return { type: 'lap', time, best, medal, lap: this.lap - 1 };
  }

  finish(time, penalty) {
    const total = time + penalty;
    const best = !this.best || total < this.best.time;
    const medal = this.medalFor(total);
    if (best) {
      this.best = { time: total, medal };
      bests.set(this.key, this.best);
    }
    this.state = 'finished';
    this.result = { time: total, penalty, medal, best };
    return { type: 'finish', ...this.result };
  }

  /** The bot's run for the lap being driven: lap 1 is its standing start, later laps its flying lap. */
  get refLap() {
    const L = this.ref.laps;
    return this.c.closed && this.lap > 1 ? L[1] ?? L[0] : L[0];
  }

  updateDelta() {
    const at = this.refLap?.at[this.reached];
    if (this.state === 'running' && at > 0 && this.reached > 2) this.delta = this.lapTime - at;
  }

  /** Ghost pose at the current lap time, or null before the start / after it finishes its run. */
  ghost() {
    const lap = this.refLap;
    if (!lap || this.state === 'ready') return null;
    const f = lap.frames, count = f.length / 3;
    const pos = this.lapTime * GHOST_HZ;
    const i = Math.floor(pos);
    if (i >= count - 1) return null;
    const k = pos - i, a = i * 3, b = a + 3;
    let dh = f[b + 2] - f[a + 2];
    dh -= Math.PI * 2 * Math.round(dh / (Math.PI * 2));
    return { x: f[a] + (f[b] - f[a]) * k, y: f[a + 1] + (f[b + 1] - f[a + 1]) * k, heading: f[a + 2] + dh * k };
  }

  /** The pace note being called (about 3.5 s ahead), and the one after when they run together. */
  noteAhead(speed) {
    const c = this.c, n = c.center.length;
    if (c.kind === 'gymkhana') {
      // the next element coming up, and the one after it
      const i = this.elemIdx.findIndex((ei) => ei > this.idx + 4);
      if (i < 0) return null;
      return { call: c.elements[i].type, link: '', then: c.elements[i + 1]?.type ?? null };
    }
    const lead = (speed * 3.5 + 40) / STEP;
    for (let i = 0; i < c.notes.length; i++) {
      const nt = c.notes[i];
      const end = c.closed && nt.end < nt.start ? nt.end + n : nt.end;
      if (end < this.idx) continue;
      if (nt.start - this.idx > lead) return null;
      const then = ['into', 'and'].includes(nt.link) ? c.notes[i + 1] ?? (c.closed ? c.notes[0] : null) : null;
      return { call: nt.call, link: nt.link, then: then?.call ?? null };
    }
    return null;
  }
}
