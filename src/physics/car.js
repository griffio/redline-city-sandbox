// Vehicle model: a two-axle ("bicycle") rigid body with
//   - slip-angle tyre forces using a simplified Pacejka curve (peak grip, then a lower sliding plateau)
//   - longitudinal weight transfer (brake → front bites, throttle → rear squats)
//   - per-axle friction circle (wheelspin eats lateral grip → power oversteer)
//   - locked wheels slide along their velocity (no ABS = no steering while locked)
//   - optional "fun" layers on top: countersteer assist, spin protection, slide speed retention,
//     kart-style drift state with mini-turbo, and a retro rotational model.
// World units are metres / seconds / kg. +x right, +y up, heading 0 = facing +x, CCW positive.

const G = 9.81;
const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const sign = (v) => (v < 0 ? -1 : 1);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const approach = (cur, target, maxDelta) =>
  cur < target ? Math.min(cur + maxDelta, target) : Math.max(cur - maxDelta, target);
const wrapAngle = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);

export const DEFAULT_TUNING = {
  // chassis
  mass: 1250,
  inertiaScale: 1.0, // multiplies the box inertia; lower = twitchier rotation
  cgToFront: 1.25,
  cgToRear: 1.35,
  cgHeight: 0.5,
  weightTransfer: 1.0, // 0 = none, 1 = physical, >1 = exaggerated (more lift-off / brake oversteer)
  // tyres
  gripFront: 1.05, // peak friction coefficient
  gripRear: 1.0,
  peakSlipDeg: 7, // slip angle where grip peaks
  slideFalloff: 1.55, // Pacejka C: 1 = no falloff, ~1.9 = big drop past the peak (snappy)
  lockedFriction: 0.8, // kinetic friction of a locked/skidding tyre vs peak
  // drivetrain
  drive: 'RWD', // RWD | AWD | FWD
  enginePower: 1.0,
  maxRpm: 7200,
  brakeForce: 1.1, // in g, total
  brakeBias: 0.62, // fraction to front
  abs: true,
  tractionControl: false,
  handbrakeGrip: 0.55, // rear grip multiplier while handbrake is held (on top of locking)
  // steering
  maxSteerDeg: 34,
  steerSpeed: 4.0, // rad/s the wheels can turn
  steerSpeedFalloff: 28, // m/s where steering lock has halved
  // assists (the "fun" side)
  countersteer: 0.6, // 0..1: front wheels auto-align with the direction of travel
  spinProtection: 0.5, // 0..1: torque that stops body slip past maxDriftDeg
  maxDriftDeg: 55,
  slideRetention: 0.35, // 0..1: how much speed is preserved while sliding sideways
  yawDamping: 0.0, // stability control (ESC) — damps rotation not asked for
  frontSlipLimit: 0.0, // 0..1: clamp front wheel angle near peak slip (Forza-style pad filter)
  // aero
  drag: 0.42,
  rollingResistance: 12,
};

export const PRESETS = {
  Balanced: {},
  'Grip / Sim': {
    countersteer: 0.15, spinProtection: 0, slideRetention: 0, slideFalloff: 1.7, weightTransfer: 1.0,
    gripFront: 1.15, gripRear: 1.15, handbrakeGrip: 0.7, yawDamping: 0.0,
  },
  'Drift Car': {
    gripFront: 1.1, gripRear: 0.88, slideFalloff: 1.35, countersteer: 0.85, spinProtection: 0.8,
    maxDriftDeg: 62, slideRetention: 0.6, enginePower: 1.25, weightTransfer: 1.3, maxSteerDeg: 45,
    steerSpeedFalloff: 60, handbrakeGrip: 0.45,
  },
  'Arcade Grip': {
    gripFront: 1.35, gripRear: 1.35, slideFalloff: 1.2, countersteer: 0.7, spinProtection: 1.0,
    maxDriftDeg: 40, slideRetention: 0.7, yawDamping: 0.4, enginePower: 1.15, abs: true, frontSlipLimit: 0.7,
  },
  'Ice / Rally': {
    gripFront: 0.55, gripRear: 0.5, slideFalloff: 1.25, lockedFriction: 0.85, countersteer: 0.7,
    spinProtection: 0.6, slideRetention: 0.5, enginePower: 0.7, drive: 'AWD', peakSlipDeg: 9,
  },
};

export const GEARS = [3.3, 2.15, 1.55, 1.2, 0.97, 0.8];
const REVERSE_RATIO = 3.0;
export const FINAL_DRIVE = 3.6;
export const WHEEL_RADIUS = 0.33;
const IDLE_RPM = 900;

export function torqueAt(rpm, maxRpm) {
  // Broad hump peaking around 4800rpm, ~380Nm.
  const x = rpm / maxRpm;
  const t = 240 + 140 * Math.sin(clamp(x, 0, 1) * Math.PI * 0.95);
  return rpm > maxRpm ? t * 0.2 : t;
}

export class Car {
  constructor(tuning = DEFAULT_TUNING) {
    this.t = { ...DEFAULT_TUNING, ...tuning };
    this.length = 4.4;
    this.width = 1.9;
    this.track = 1.6;
    this.model = 'physics'; // physics | retro
    this.reset(0, 0, Math.PI / 2);
  }

  reset(x, y, heading) {
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.vx = 0;
    this.vy = 0;
    this.yawRate = 0;
    this.steerAngle = 0;
    this.gear = 1; // 1..6, -1 reverse
    this.rpm = IDLE_RPM;
    this.accelLong = 0; // smoothed, for weight transfer
    this.accelLat = 0;
    this.shiftTimer = 0;
    // per-wheel slide amount 0..1 (FL, FR, RL, RR) — drives skid marks, smoke, audio, rumble
    this.wheelSlide = [0, 0, 0, 0];
    this.frontUsage = 0;
    this.rearUsage = 0;
    this.wheelspin = 0;
    this.slideLat = 0; // sideways / locked-wheel sliding only (not wheelspin) — drives the squeal
    this.locked = { front: false, rear: false };
    // kart drift state
    this.drift = { active: false, dir: 0, time: 0, charge: 0, boost: 0, hop: 0 };
    this.lastBoostLevel = 0;
  }

  get speed() {
    return Math.hypot(this.vx, this.vy);
  }
  get forward() {
    return [Math.cos(this.heading), Math.sin(this.heading)];
  }
  get localVelocity() {
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    return [this.vx * c + this.vy * s, -this.vx * s + this.vy * c];
  }
  /** Body slip: angle between heading and direction of travel (radians, +left). */
  get bodySlip() {
    const [vl, vt] = this.localVelocity;
    if (Math.hypot(vl, vt) < 2) return 0;
    return Math.atan2(vt, Math.abs(vl));
  }

  get mass() {
    return this.t.mass;
  }
  get inertia() {
    return ((this.t.mass * (this.length * this.length + this.width * this.width)) / 12) * this.t.inertiaScale;
  }

  /** Wheel positions in world space: FL, FR, RL, RR. */
  wheelPositions() {
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    const a = this.t.cgToFront, b = this.t.cgToRear, h = this.track / 2;
    const local = [[a, h], [a, -h], [-b, h], [-b, -h]];
    return local.map(([lx, ly]) => [this.x + lx * c - ly * s, this.y + lx * s + ly * c]);
  }

  /**
   * @param {number} dt
   * @param {{throttle:number, brake:number, steer:number, handbrake:number, drift:boolean,
   *          steerAngle?:number, autoReverse?:boolean}} input
   *   steer: -1..1 (+left). steerAngle (radians) overrides it when a control scheme computes the wheel angle itself.
   */
  step(dt, input) {
    if (this.model === 'retro') return this.stepRetro(dt, input);
    const t = this.t;
    const m = t.mass;
    const a = t.cgToFront, b = t.cgToRear, L = a + b;
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    let vLong = this.vx * c + this.vy * s;
    let vLat = -this.vx * s + this.vy * c;
    const speed = Math.hypot(vLong, vLat);

    // --- gear selection / reverse --------------------------------------------------------
    let throttle = input.throttle;
    let brake = input.brake;
    if (this.gear === -1) {
      // In reverse the brake pedal drives backwards and throttle brakes.
      if (input.throttle > 0.05 && vLong > -0.5) this.gear = 1;
      [throttle, brake] = [input.brake, input.throttle];
    } else if (input.brake > 0.1 && input.throttle < 0.05 && vLong < 0.4 && speed < 1.0) {
      this.gear = -1;
      [throttle, brake] = [input.brake, 0];
    }

    // --- steering ----------------------------------------------------------------------
    const maxSteer = (t.maxSteerDeg * Math.PI) / 180;
    const speedFactor = 1 / (1 + Math.max(0, speed - 5) / t.steerSpeedFalloff);
    const beta = speed > 2 ? Math.atan2(vLat, Math.abs(vLong)) : 0;
    // A player countersteering (steering toward the direction of travel) keeps most of their lock.
    const counter = Math.abs(beta) > 0.08 && Math.sign(input.steer) === Math.sign(beta);
    let target = input.steerAngle ?? input.steer * maxSteer * (counter ? Math.max(speedFactor, 0.85) : speedFactor);
    // Countersteer assist: aim the front wheels toward the direction of travel, like caster self-aligning.
    if (vLong > 1) target += t.countersteer * beta * smoothstep(2, 6, speed);
    // Steering limiter: keep the front slip angle near peak grip so a full stick doesn't just plough.
    if (t.frontSlipLimit > 0 && vLong > 4) {
      const vAngle = Math.atan2(vLat + this.yawRate * a, vLong);
      const lim = ((t.peakSlipDeg * Math.PI) / 180) * (1 + 3 * (1 - t.frontSlipLimit));
      target = clamp(target, vAngle - lim, vAngle + lim);
    }
    target = clamp(target, -maxSteer * 1.25, maxSteer * 1.25);
    this.steerAngle = approach(this.steerAngle, target, t.steerSpeed * dt);
    const delta = this.steerAngle;

    // --- engine ------------------------------------------------------------------------
    const ratio = this.gear === -1 ? REVERSE_RATIO : GEARS[this.gear - 1];
    const wheelRpm = (Math.abs(vLong) / WHEEL_RADIUS) * (60 / TAU);
    const spinBoost = 1 + this.wheelspin * 0.6;
    const rpmTarget = Math.max(IDLE_RPM + throttle * 1500 * (speed < 1 ? 1 : 0), wheelRpm * ratio * FINAL_DRIVE * spinBoost);
    this.rpm += (rpmTarget - this.rpm) * Math.min(1, dt * 12);
    this.rpm = clamp(this.rpm, IDLE_RPM * 0.8, t.maxRpm * 1.05);
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (this.gear > 0 && this.shiftTimer === 0) {
      const shiftUpRpm = t.maxRpm * 0.93;
      if (this.rpm > shiftUpRpm && this.gear < GEARS.length) {
        this.gear++;
        this.shiftTimer = 0.25;
      } else if (this.gear > 1) {
        const lower = (wheelRpm * GEARS[this.gear - 2] * FINAL_DRIVE);
        if (lower < t.maxRpm * 0.62) {
          this.gear--;
          this.shiftTimer = 0.2;
        }
      }
    }
    const shifting = this.shiftTimer > 0.1;
    let driveForce = 0;
    if (!shifting) {
      const torque = torqueAt(this.rpm, t.maxRpm) * t.enginePower;
      driveForce = (throttle * torque * ratio * FINAL_DRIVE * 0.85) / WHEEL_RADIUS;
      if (this.gear === -1) driveForce = -Math.min(driveForce, 5000) * (vLong < -8 ? 0 : 1);
      if (this.rpm >= t.maxRpm) driveForce *= 0.1; // limiter
    }
    if (this.drift.boost > 0) driveForce += m * G * 0.35;

    // kart drift state first: it loosens the rear while active
    this.stepKartDrift(dt, input, speed, beta);
    const driftGrip = this.drift.active ? 0.78 : 1;

    // --- axle loads (longitudinal weight transfer) --------------------------------------
    const transfer = (m * this.accelLong * t.cgHeight * t.weightTransfer) / L;
    const staticF = (m * G * b) / L, staticR = (m * G * a) / L;
    const loadF = Math.max(staticF * 0.15, staticF - transfer);
    const loadR = Math.max(staticR * 0.15, staticR + transfer);

    // --- distribute drive & brake per axle ----------------------------------------------
    const frontDrive = t.drive === 'FWD' ? 1 : t.drive === 'AWD' ? 0.4 : 0;
    const brakeTotal = brake * t.brakeForce * m * G;
    const handbrake = input.handbrake > 0.1;

    const axles = [
      { x: a, steer: delta, load: loadF, mu: t.gripFront, drive: driveForce * frontDrive, brake: brakeTotal * t.brakeBias, hand: false },
      { x: -b, steer: 0, load: loadR, mu: t.gripRear * driftGrip * (handbrake ? t.handbrakeGrip : 1), drive: driveForce * (1 - frontDrive), brake: brakeTotal * (1 - t.brakeBias), hand: handbrake },
    ];

    // Simplified Pacejka: f(α) = sin(C·atan(Bα)), B chosen so the peak lands on peakSlipDeg.
    // C = 1 would put the peak at tan(π/2) (a step function); 1.05 is already effectively flat past the peak
    const C = Math.max(1.05, t.slideFalloff);
    const peak = (t.peakSlipDeg * Math.PI) / 180;
    const B = Math.tan(Math.PI / (2 * C)) / peak;

    let fx = 0, fy = 0, torque = 0;
    let spin = 0;
    let slideLat = 0;
    for (let i = 0; i < 2; i++) {
      const ax = axles[i];
      const maxF = ax.mu * ax.load;
      const mEff = m * (ax.load / (m * G)); // share of mass this axle "carries" — for overshoot clamps
      // velocity of the axle in car frame, then in tyre frame
      const avx = vLong;
      const avy = vLat + this.yawRate * ax.x;
      const cs = Math.cos(ax.steer), sn = Math.sin(ax.steer);
      const tvx = avx * cs + avy * sn;
      const tvy = -avx * sn + avy * cs;
      const tspeed = Math.hypot(tvx, tvy);

      let Fx = 0, Fy = 0, slide = 0;
      const lockedDemand = ax.hand || (!t.abs && ax.brake > maxF * 1.02);
      if (lockedDemand && tspeed > 0.3) {
        // Locked tyre: kinetic friction straight against its sliding velocity.
        const f = maxF * t.lockedFriction * Math.min(1, tspeed / 1.0);
        Fx = (-tvx / tspeed) * f;
        Fy = (-tvy / tspeed) * f;
        slide = smoothstep(1, 4, tspeed);
        slideLat = Math.max(slideLat, slide);
        if (i === 0) this.locked.front = true; else this.locked.rear = true;
      } else {
        if (i === 0) this.locked.front = false; else this.locked.rear = false;
        // longitudinal: drive + brake (ABS caps the brake at the grip limit)
        let brakeF = ax.brake;
        if (t.abs) brakeF = Math.min(brakeF, maxF * 0.97);
        const brakeDir = Math.abs(tvx) > 0.4 ? -sign(tvx) : -tvx / 0.4;
        Fx = ax.drive + brakeDir * brakeF;
        let fxCap = Math.abs(tvx) * mEff / dt + Math.abs(ax.drive);
        Fx = clamp(Fx, -fxCap, fxCap);
        let spinAmt = 0;
        if (t.tractionControl && Math.abs(ax.drive) > maxF * 0.92) {
          Fx = clamp(Fx, -maxF * 0.92, maxF * 0.92);
        }
        if (Math.abs(Fx) > maxF) {
          // wheelspin / overbraking: slide at kinetic friction
          spinAmt = clamp((Math.abs(Fx) - maxF) / maxF, 0, 1);
          Fx = sign(Fx) * maxF * (0.92 - 0.12 * spinAmt);
          if (ax.drive !== 0) spin = Math.max(spin, Math.max(0.35, spinAmt));
        }
        // lateral
        const alpha = Math.atan2(tvy, Math.max(Math.abs(tvx), 0.5));
        Fy = -Math.sin(C * Math.atan(B * alpha)) * maxF;
        // never push harder than it takes to cancel the sideways speed this step (low-speed jitter)
        const fyCap = Math.abs(tvy) * mEff / dt;
        Fy = clamp(Fy, -fyCap, fyCap);
        // friction circle: longitudinal use eats lateral capacity
        const latCap = Math.sqrt(Math.max(0, maxF * maxF - Fx * Fx)) + (spinAmt > 0 ? maxF * 0.12 : 0);
        if (Math.abs(Fy) > latCap) Fy = sign(Fy) * latCap;
        const latSlide = smoothstep(peak * 0.9, peak * 2.6, Math.abs(alpha)) * smoothstep(2, 6, tspeed);
        slide = Math.max(latSlide, spinAmt > 0 ? 0.4 + spinAmt * 0.6 : 0);
        slideLat = Math.max(slideLat, latSlide);
      }
      const usage = Math.hypot(Fx, Fy) / Math.max(1, maxF);
      if (i === 0) this.frontUsage = usage; else this.rearUsage = usage;
      // back to car frame
      const cfx = Fx * cs - Fy * sn;
      const cfy = Fx * sn + Fy * cs;
      fx += cfx;
      fy += cfy;
      torque += ax.x * cfy;
      ax.slide = slide;
    }
    this.wheelspin += ((spin) - this.wheelspin) * Math.min(1, dt * 10);
    this.slideLat = slideLat;

    // --- aero + rolling --------------------------------------------------------------
    fx += -t.drag * vLong * speed - t.rollingResistance * vLong;
    fy += -t.drag * vLat * speed - t.rollingResistance * 3 * vLat;

    // --- fun layers -----------------------------------------------------------------
    // Slide retention: give back part of the scrub that a sideways tyre bleeds off.
    if (t.slideRetention > 0 && speed > 4) {
      const vxn = vLong / speed, vyn = vLat / speed;
      const along = fx * vxn + fy * vyn;
      const driftAmt = smoothstep(0.12, 0.45, Math.abs(beta));
      if (along < 0) {
        const giveBack = -along * t.slideRetention * driftAmt * 0.85;
        fx += vxn * giveBack;
        fy += vyn * giveBack;
      }
    }
    // Spin protection: torque that pulls the nose back toward the travel direction past maxDrift.
    const maxDrift = (t.maxDriftDeg * Math.PI) / 180;
    if (t.spinProtection > 0 && speed > 3 && Math.abs(beta) > maxDrift * 0.75) {
      const excess = Math.abs(beta) - maxDrift * 0.75;
      torque += sign(beta) * excess * t.spinProtection * this.inertia * 40;
      // and stop it rotating further outward
      if (sign(this.yawRate) !== sign(beta)) torque -= this.yawRate * t.spinProtection * this.inertia * 4;
    }
    if (t.yawDamping > 0 && speed > 3) {
      const expected = (vLong * Math.tan(delta)) / L;
      torque -= (this.yawRate - expected) * t.yawDamping * this.inertia * 3;
    }
    torque -= this.yawRate * this.inertia * (speed < 1 ? 3 : 0.15); // tiny structural damping

    // --- kart drift layer -------------------------------------------------------------
    if (this.drift.active) {
      // hold a target body slip set by the stick: tight or wide arc.
      // Drifting left (d=+1) means travel points right of the nose, i.e. negative body slip.
      const d = this.drift.dir;
      const targetBeta = -d * (0.38 + 0.22 * clamp(input.steer * d, -1, 1));
      const err = targetBeta - beta;
      // PD on body slip: dβ/dt ≈ (path turn rate) − yawRate
      const pathRate = this.accelLat / Math.max(speed, 1);
      torque += -err * this.inertia * 30 + (pathRate - this.yawRate) * this.inertia * 5 + d * this.inertia * 1.2 * smoothstep(5, 15, speed);
      // keep speed through the drift
      const ff = Math.hypot(fx, fy);
      fx += (vLong / Math.max(speed, 1)) * ff * 0.25;
    }

    // --- integrate ------------------------------------------------------------------
    const axLocal = fx / m, ayLocal = fy / m;
    this.accelLong += (axLocal - this.accelLong) * Math.min(1, dt * 8);
    this.accelLat += (ayLocal - this.accelLat) * Math.min(1, dt * 8);
    const wx = axLocal * c - ayLocal * s;
    const wy = axLocal * s + ayLocal * c;
    this.vx += wx * dt;
    this.vy += wy * dt;
    this.yawRate += (torque / this.inertia) * dt;
    this.heading = wrapAngle(this.heading + this.yawRate * dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // --- per-wheel slide, with lateral load shift for the visual split ----------------
    const latShift = clamp((this.accelLat * t.cgHeight) / (this.track * G), -0.6, 0.6);
    const fS = axles[0].slide, rS = axles[1].slide;
    // +accelLat (turning left) loads the right-hand wheels
    this.wheelSlide[0] = fS * (1 - latShift);
    this.wheelSlide[1] = fS * (1 + latShift);
    this.wheelSlide[2] = rS * (1 - latShift * 0.7);
    this.wheelSlide[3] = rS * (1 + latShift * 0.7);
    for (let i = 0; i < 4; i++) this.wheelSlide[i] = clamp(this.wheelSlide[i], 0, 1);
  }

  stepKartDrift(dt, input, speed, beta) {
    const d = this.drift;
    d.boost = Math.max(0, d.boost - dt);
    d.hop = Math.max(0, d.hop - dt);
    if (!input.drift) {
      if (d.active) {
        // release: cash in the mini-turbo
        const level = d.charge >= 2.4 ? 3 : d.charge >= 1.5 ? 2 : d.charge >= 0.7 ? 1 : 0;
        d.boost = [0, 0.45, 0.9, 1.4][level];
        this.lastBoostLevel = level;
        d.active = false;
      }
      d.charge = 0;
      return;
    }
    if (!d.active && Math.abs(input.steer) > 0.25 && speed > 8 && input.throttle > 0.2) {
      d.active = true;
      d.dir = sign(input.steer);
      d.time = 0;
      d.charge = 0;
      d.hop = 0.18;
    }
    if (d.active) {
      d.time += dt;
      // steering into the drift charges faster
      d.charge += dt * (0.7 + 0.6 * clamp(input.steer * d.dir, 0, 1));
      if (speed < 5) d.active = false;
    }
  }

  get driftLevel() {
    const c = this.drift.charge;
    return !this.drift.active ? 0 : c >= 2.4 ? 3 : c >= 1.5 ? 2 : c >= 0.7 ? 1 : 0;
  }

  /** Retro rotational model (Micro Machines / GTA2 style): steering rotates the car directly. */
  stepRetro(dt, input) {
    const t = this.t;
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    let vLong = this.vx * c + this.vy * s;
    let vLat = -this.vx * s + this.vy * c;
    const speed = Math.hypot(vLong, vLat);
    const hand = input.handbrake > 0.1;
    const dir = vLong < -0.5 ? -1 : 1;
    const turnRate = 2.9 * (hand ? 1.35 : 1) * clamp(speed / 7, 0, 1) / (1 + speed / 70);
    const steer = input.steerAngle != null ? clamp(input.steerAngle / 0.6, -1, 1) : input.steer;
    const targetYaw = steer * turnRate * dir;
    this.yawRate += (targetYaw - this.yawRate) * Math.min(1, dt * 10);
    this.heading = wrapAngle(this.heading + this.yawRate * dt);
    // throttle / brake along the nose
    const power = 9.5 * t.enginePower;
    if (input.throttle > 0) vLong += input.throttle * power * (1 - clamp(vLong / 62, 0, 1)) * dt;
    if (input.brake > 0) {
      if (vLong > 0.5) vLong -= input.brake * 16 * dt;
      else vLong = Math.max(vLong - input.brake * 6 * dt, -12);
    }
    vLong -= vLong * (0.08 + (input.throttle > 0 ? 0 : 0.35)) * dt;
    // grip: kill the sideways component exponentially (lower when handbraking)
    const grip = (hand ? 1.6 : 5.5) * (t.gripRear + t.gripFront) * 0.5;
    vLat *= Math.exp(-grip * dt);
    // re-express in the rotated frame so velocity lags the heading → slides
    const c2 = Math.cos(this.heading), s2 = Math.sin(this.heading);
    const dh = this.yawRate * dt;
    // velocity was expressed relative to the old heading; rotate it back by dh to keep it in world space
    const cl = Math.cos(-dh), sl = Math.sin(-dh);
    const nl = vLong * cl - vLat * sl, nt = vLong * sl + vLat * cl;
    this.vx = nl * c2 - nt * s2;
    this.vy = nl * s2 + nt * c2;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.steerAngle = steer * 0.5;
    this.accelLong = 0;
    this.rpm = IDLE_RPM + (Math.abs(vLong) % 18) / 18 * 5000 + input.throttle * 600;
    this.gear = Math.min(6, 1 + Math.floor(Math.abs(vLong) / 18));
    const slide = smoothstep(2.5, 7, Math.abs(nt)) * smoothstep(3, 8, speed);
    this.wheelSlide = [slide * 0.6, slide * 0.6, slide, slide];
    this.slideLat = slide;
    this.frontUsage = slide;
    this.rearUsage = slide;
    this.wheelspin = 0;
    this.locked.front = this.locked.rear = false; // no tyre model here; don't inherit lock state from physics mode
    this.stepKartDrift(dt, { ...input, drift: false }, speed, 0);
  }
}
