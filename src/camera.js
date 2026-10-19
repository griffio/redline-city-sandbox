// 2D camera: follows the car with look-ahead, zooms out with speed, optionally rotates.
// `rot` is the world angle that points UP on screen (π/2 = north-up).

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const CAMERA_TUNING = {
  mode: 'velocity', // velocity | heading | north
  rotStiffness: 2.2, // 1/s, how quickly the camera swings round
  maxRotRate: 2.5, // rad/s cap so spins don't whirl the world
  lookAhead: 0.3, // seconds of velocity to lead by
  baseView: 34, // metres visible vertically at rest
  speedZoom: 0.55, // extra metres of view per m/s
  maxView: 90,
  shake: 1.0,
  carScreenY: 0.1, // rotating modes: push the car this fraction of the view below centre
};

export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.rot = Math.PI / 2;
    this.view = CAMERA_TUNING.baseView;
    this.shakeAmt = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }

  snap(car) {
    this.rot = CAMERA_TUNING.mode === 'north' ? Math.PI / 2 : car.heading;
    const off = CAMERA_TUNING.mode === 'north' ? 0 : this.view * CAMERA_TUNING.carScreenY;
    this.x = car.x + Math.cos(this.rot) * off;
    this.y = car.y + Math.sin(this.rot) * off;
  }

  addShake(amount) {
    this.shakeAmt = Math.min(1.5, this.shakeAmt + amount * CAMERA_TUNING.shake);
  }

  update(dt, car) {
    const T = CAMERA_TUNING;
    const speed = car.speed;
    // position: lead along velocity
    const la = T.lookAhead * (T.mode === 'north' ? 1.4 : 1);
    const lead = Math.min(speed * la, 30) / Math.max(speed, 1e-3);
    let tx = car.x + car.vx * lead;
    let ty = car.y + car.vy * lead;
    if (T.mode !== 'north') {
      // show more road ahead: offset along the camera's up vector
      const off = this.view * T.carScreenY;
      tx += Math.cos(this.rot) * off;
      ty += Math.sin(this.rot) * off;
    }
    const k = 1 - Math.exp(-dt * 6);
    this.x += (tx - this.x) * k;
    this.y += (ty - this.y) * k;

    // rotation
    let target = Math.PI / 2;
    if (T.mode === 'heading') target = car.heading;
    else if (T.mode === 'velocity') {
      const [vl] = car.localVelocity;
      target = speed > 3 && vl > 0 ? Math.atan2(car.vy, car.vx) : car.heading;
      // blend toward the nose at low speed so it's predictable when pulling away
      if (speed > 3 && vl > 0) {
        const w = clamp((speed - 3) / 8, 0, 1);
        target = car.heading + wrap(target - car.heading) * w;
      }
    }
    const stiff = T.mode === 'heading' ? 12 : T.rotStiffness;
    const maxRate = T.mode === 'heading' ? 20 : T.maxRotRate;
    const diff = wrap(target - this.rot);
    const step = clamp(diff * (1 - Math.exp(-dt * stiff)), -maxRate * dt, maxRate * dt);
    this.rot = wrap(this.rot + step);

    // zoom
    const targetView = Math.min(T.maxView, T.baseView + speed * T.speedZoom);
    this.view += (targetView - this.view) * (1 - Math.exp(-dt * 1.5));

    // shake
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 2.5);
    const s = this.shakeAmt * this.shakeAmt * 0.8;
    this.shakeX = (Math.random() * 2 - 1) * s;
    this.shakeY = (Math.random() * 2 - 1) * s;
  }

  /** Pixels per metre for a canvas of the given pixel height. */
  scale(heightPx) {
    return heightPx / this.view;
  }
}
