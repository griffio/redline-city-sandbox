// Sandbox layout (or a generated course's walls and props) + collision response.
// Static barriers are oriented boxes; cones and tyre stacks are light dynamic circles.

export const WORLD = {
  half: 200, // sandbox is 400m square
  skidpad: { x: -95, y: -75, r: 28 },
  figure8: { x: 95, y: -75, r: 20 },
  dragStrip: { y: 120, x0: -170, x1: 170 },
};

const BARRIER_LEN = 4, BARRIER_W = 0.9;

export class World {
  constructor() {
    this.barriers = []; // {x, y, rot, hl, hw, tint}
    this.props = []; // {x, y, vx, vy, r, mass, kind, rot, spin, down}
    this.build();
  }

  addWall(x0, y0, x1, y1) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / BARRIER_LEN));
    const rot = Math.atan2(y1 - y0, x1 - x0);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      this.barriers.push({
        x: x0 + (x1 - x0) * t,
        y: y0 + (y1 - y0) * t,
        rot,
        hl: len / n / 2,
        hw: BARRIER_W / 2,
        tint: (this.barriers.length & 1) === 0 ? 0 : 1,
      });
    }
  }

  addCone(x, y) {
    this.props.push({ kind: 'cone', x, y, vx: 0, vy: 0, r: 0.22, mass: 4, rot: 0, spin: 0, down: false, home: [x, y] });
  }

  addTyres(x, y) {
    this.props.push({ kind: 'tyres', x, y, vx: 0, vy: 0, r: 0.75, mass: 90, rot: Math.random() * 6, spin: 0, down: false, home: [x, y] });
  }

  addArena() {
    const H = WORLD.half;
    this.addWall(-H, -H, H, -H);
    this.addWall(H, -H, H, H);
    this.addWall(H, H, -H, H);
    this.addWall(-H, H, -H, -H);
  }

  build() {
    const H = WORLD.half;
    this.addArena();

    // skidpad: ring of cones on the outer line
    const sp = WORLD.skidpad;
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      this.addCone(sp.x + Math.cos(a) * (sp.r + 4), sp.y + Math.sin(a) * (sp.r + 4));
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.addCone(sp.x + Math.cos(a) * 3, sp.y + Math.sin(a) * 3);
    }
    // figure-8 pylons
    const f8 = WORLD.figure8;
    this.addTyres(f8.x - f8.r, f8.y);
    this.addTyres(f8.x + f8.r, f8.y);
    // slalom down the middle
    for (let i = 0; i < 9; i++) this.addCone(-60 + i * 15, 40);
    // tight gymkhana box
    for (let i = 0; i < 6; i++) {
      this.addCone(-150 + i * 9, -150 + (i & 1) * 6);
    }
    // drag strip lane markers (cones every 20m on both sides)
    const ds = WORLD.dragStrip;
    for (let x = ds.x0 + 10; x < ds.x1; x += 20) {
      this.addCone(x, ds.y + 6);
      this.addCone(x, ds.y - 6);
    }
    // barrier chicane + a hairpin wall to bounce off
    this.addWall(30, -20, 70, -20);
    this.addWall(70, -20, 70, 10);
    this.addWall(-140, 60, -140, 100);
    this.addWall(-140, 100, -100, 100);
    // a "city block" of barriers to slide around
    this.addWall(120, 30, 160, 30);
    this.addWall(160, 30, 160, 70);
    this.addWall(160, 70, 120, 70);
    this.addWall(120, 70, 120, 30);
    // tyre walls in corners
    for (let i = 0; i < 6; i++) this.addTyres(-H + 6 + i * 1.6, H - 6);
    for (let i = 0; i < 6; i++) this.addTyres(H - 6, -H + 6 + i * 1.6);
  }

  /** Swap the sandbox layout for a generated course: its walls (segments), cones and tyre stacks. */
  loadCourse({ walls = [], cones = [], tyres = [] }) {
    this.barriers = [];
    this.props = [];
    this.addArena();
    for (const seg of walls) this.addWall(...seg);
    for (const [x, y] of cones) this.addCone(x, y);
    for (const [x, y] of tyres) this.addTyres(x, y);
  }

  loadSandbox() {
    this.barriers = [];
    this.props = [];
    this.build();
  }

  resetProps() {
    for (const p of this.props) {
      [p.x, p.y] = p.home;
      p.vx = p.vy = p.spin = 0;
      p.down = false;
    }
  }

  /** Step props and resolve car collisions. Returns the strongest impact speed this step. */
  step(dt, car) {
    let impact = 0;
    impact = Math.max(impact, this.collideCarBarriers(car));
    impact = Math.max(impact, this.collideCarProps(car));
    for (const p of this.props) {
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 0) {
        const fr = p.kind === 'cone' ? (p.down ? 5 : 3.5) : 6;
        const k = Math.max(0, 1 - (fr * dt) / Math.max(sp, 1e-3));
        p.vx *= k;
        p.vy *= k;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      p.rot += p.spin * dt;
      p.spin *= Math.exp(-dt * 2.5);
      // keep props inside the arena
      const lim = WORLD.half - 0.5 - p.r;
      if (Math.abs(p.x) > lim) { p.x = Math.sign(p.x) * lim; p.vx *= -0.4; }
      if (Math.abs(p.y) > lim) { p.y = Math.sign(p.y) * lim; p.vy *= -0.4; }
    }
    // props vs props (cheap n², small n)
    const P = this.props;
    for (let i = 0; i < P.length; i++) {
      const a = P[i];
      if (a.vx === 0 && a.vy === 0) continue;
      for (let j = 0; j < P.length; j++) {
        if (i === j) continue;
        const b = P[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const rr = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr || d2 === 0) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        const pen = rr - d;
        const im = 1 / a.mass + 1 / b.mass;
        a.x -= nx * pen * (1 / a.mass) / im;
        a.y -= ny * pen * (1 / a.mass) / im;
        b.x += nx * pen * (1 / b.mass) / im;
        b.y += ny * pen * (1 / b.mass) / im;
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
          const j = (-(1.4) * vn) / im;
          a.vx -= (j * nx) / a.mass; a.vy -= (j * ny) / a.mass;
          b.vx += (j * nx) / b.mass; b.vy += (j * ny) / b.mass;
        }
      }
    }
    return impact;
  }

  carCorners(car) {
    const c = Math.cos(car.heading), s = Math.sin(car.heading);
    const hl = car.length / 2, hw = car.width / 2;
    return [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([x, y]) => [car.x + x * c - y * s, car.y + x * s + y * c]);
  }

  /** Apply an impulse at world point (px,py) along normal n with restitution e. Returns closing speed. */
  impulse(car, px, py, nx, ny, e, mu, otherMass = Infinity) {
    const rx = px - car.x, ry = py - car.y;
    const vx = car.vx - car.yawRate * ry, vy = car.vy + car.yawRate * rx;
    const vn = vx * nx + vy * ny;
    if (vn >= 0) return 0;
    const I = car.inertia, m = car.mass;
    const rn = rx * ny - ry * nx;
    const invOther = otherMass === Infinity ? 0 : 1 / otherMass;
    const j = (-(1 + e) * vn) / (1 / m + invOther + (rn * rn) / I);
    car.vx += (j * nx) / m;
    car.vy += (j * ny) / m;
    car.yawRate += (rn * j) / I;
    // friction along the contact tangent
    const tx = -ny, ty = nx;
    const vt = vx * tx + vy * ty;
    const rt = rx * ty - ry * tx;
    let jt = -vt / (1 / m + invOther + (rt * rt) / I);
    jt = Math.max(-mu * j, Math.min(mu * j, jt));
    car.vx += (jt * tx) / m;
    car.vy += (jt * ty) / m;
    car.yawRate += (rt * jt) / I;
    return { closing: -vn, j, jt, tx, ty };
  }

  collideCarBarriers(car) {
    let impact = 0;
    const reach = car.length / 2 + 3;
    for (const b of this.barriers) {
      if (Math.abs(b.x - car.x) > reach + b.hl || Math.abs(b.y - car.y) > reach + b.hl) continue;
      const hit = obbVsObb(car, b, this.carCorners(car));
      if (!hit) continue;
      car.x += hit.nx * hit.depth;
      car.y += hit.ny * hit.depth;
      const r = this.impulse(car, hit.px, hit.py, hit.nx, hit.ny, 0.25, 0.4);
      if (r) impact = Math.max(impact, r.closing);
    }
    return impact;
  }

  collideCarProps(car) {
    let impact = 0;
    const c = Math.cos(car.heading), s = Math.sin(car.heading);
    const hl = car.length / 2, hw = car.width / 2;
    for (const p of this.props) {
      const dx = p.x - car.x, dy = p.y - car.y;
      if (dx * dx + dy * dy > 16) continue;
      // closest point on car box to prop centre (in car space)
      const lx = dx * c + dy * s, ly = -dx * s + dy * c;
      const cx = Math.max(-hl, Math.min(hl, lx)), cy = Math.max(-hw, Math.min(hw, ly));
      let ox = lx - cx, oy = ly - cy;
      let d = Math.hypot(ox, oy);
      let nlx, nly, depth;
      if (d > 1e-6) {
        if (d >= p.r) continue;
        nlx = ox / d; nly = oy / d; depth = p.r - d;
      } else {
        // centre inside the car: push out the nearest face
        const fx = hl - Math.abs(lx), fy = hw - Math.abs(ly);
        if (fx < fy) { nlx = Math.sign(lx); nly = 0; depth = fx + p.r; }
        else { nlx = 0; nly = Math.sign(ly); depth = fy + p.r; }
      }
      // normal from car toward prop, world space
      const nx = nlx * c - nly * s, ny = nlx * s + nly * c;
      const px = car.x + cx * c - cy * s, py = car.y + cx * s + cy * c;
      const im = 1 / car.mass + 1 / p.mass;
      p.x += nx * depth * (1 / p.mass) / im;
      p.y += ny * depth * (1 / p.mass) / im;
      car.x -= nx * depth * (1 / car.mass) / im;
      car.y -= ny * depth * (1 / car.mass) / im;
      // relative velocity at contact
      const rx = px - car.x, ry = py - car.y;
      const cvx = car.vx - car.yawRate * ry, cvy = car.vy + car.yawRate * rx;
      const vn = (p.vx - cvx) * nx + (p.vy - cvy) * ny;
      if (vn >= 0) continue;
      const rn = rx * ny - ry * nx;
      const e = p.kind === 'cone' ? 0.5 : 0.2;
      const j = (-(1 + e) * vn) / (1 / car.mass + 1 / p.mass + (rn * rn) / car.inertia);
      p.vx += (j * nx) / p.mass;
      p.vy += (j * ny) / p.mass;
      car.vx -= (j * nx) / car.mass;
      car.vy -= (j * ny) / car.mass;
      car.yawRate -= (rn * j) / car.inertia;
      p.spin += (Math.random() - 0.5) * Math.min(30, -vn * 3);
      if (p.kind === 'cone' && -vn > 3) p.down = true;
      if (p.kind === 'tyres') impact = Math.max(impact, -vn * 0.6);
      else impact = Math.max(impact, Math.min(-vn * 0.15, 1.5));
    }
    return impact;
  }
}

/** SAT between the car box and a barrier box. Normal points from barrier toward car. */
function obbVsObb(car, b, corners) {
  const bc = Math.cos(b.rot), bs = Math.sin(b.rot);
  const bCorners = [[b.hl, b.hw], [b.hl, -b.hw], [-b.hl, -b.hw], [-b.hl, b.hw]].map(([x, y]) => [b.x + x * bc - y * bs, b.y + x * bs + y * bc]);
  const cc = Math.cos(car.heading), cs = Math.sin(car.heading);
  const axes = [[cc, cs], [-cs, cc], [bc, bs], [-bs, bc]];
  let best = Infinity, bnx = 0, bny = 0;
  for (const [ax, ay] of axes) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of corners) { const p = x * ax + y * ay; a0 = Math.min(a0, p); a1 = Math.max(a1, p); }
    for (const [x, y] of bCorners) { const p = x * ax + y * ay; b0 = Math.min(b0, p); b1 = Math.max(b1, p); }
    const o = Math.min(a1, b1) - Math.max(a0, b0);
    if (o <= 0) return null;
    if (o < best) {
      best = o;
      // orient from barrier to car
      const dir = (car.x - b.x) * ax + (car.y - b.y) * ay;
      bnx = dir < 0 ? -ax : ax;
      bny = dir < 0 ? -ay : ay;
    }
  }
  // contact: car corners inside barrier, else barrier corners inside car
  const inside = (pts, ox, oy, oc, os, hl, hw) =>
    pts.filter(([x, y]) => {
      const dx = x - ox, dy = y - oy;
      return Math.abs(dx * oc + dy * os) <= hl + 0.02 && Math.abs(-dx * os + dy * oc) <= hw + 0.02;
    });
  let pts = inside(corners, b.x, b.y, bc, bs, b.hl, b.hw);
  if (!pts.length) pts = inside(bCorners, car.x, car.y, cc, cs, car.length / 2, car.width / 2);
  if (!pts.length) pts = [[(car.x + b.x) / 2, (car.y + b.y) / 2]];
  const px = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const py = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return { nx: bnx, ny: bny, depth: best, px, py };
}
