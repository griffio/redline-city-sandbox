// Control schemes: map raw input (input.js) to car commands (car.js).
// Each scheme also suggests a camera mode, a car model and a physics preset; the player can
// override any of those afterwards in the tuning panel.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const CONTROL_TUNING = {
  pointGain: 2.4, // point-to-steer: steering per radian of heading error
  pointDamping: 0.18, // yaw-rate damping so the car doesn't weave onto the target heading
  autoThrottle: true, // point-to-steer: holding a direction drives
};

function carRelative(raw, opts = {}) {
  return {
    steer: raw.steer,
    throttle: raw.throttle,
    brake: raw.brake,
    handbrake: raw.handbrake,
    drift: !!opts.drift && raw.drift,
  };
}

export const SCHEMES = [
  {
    id: 'chase',
    key: '1',
    name: 'Car-relative · Chase cam',
    tag: 'Recommended',
    summary:
      'Stick / A-D turns the front wheels. The camera slowly swings round to the direction of travel, so left is always left and countersteering feels natural.',
    games: 'art of rally (camera rotation), Death Rally "traditional", Rush Rally Origins',
    pros: 'Best match for the tyre model; drifts, countersteer and handbrake turns all read clearly.',
    cons: 'World rotates; less map awareness. Camera follows velocity, not nose, so spins stay readable.',
    camera: 'velocity',
    model: 'physics',
    preset: 'Balanced',
    map: (raw) => carRelative(raw),
  },
  {
    id: 'classic',
    key: '2',
    name: 'Car-relative · North-up',
    tag: 'Classic',
    summary:
      'Same steering, fixed camera. Authentic GTA 2 / Micro Machines / Circuit Superstars feel — but steering mirrors when you drive down the screen.',
    games: 'GTA 1/2, Micro Machines, Super Sprint, Absolute Drift, Circuit Superstars',
    pros: 'Map stays readable; very "arcade". Rewards practice.',
    cons: 'Driving toward the bottom of the screen feels inverted for many players.',
    camera: 'north',
    model: 'physics',
    preset: 'Balanced',
    map: (raw) => carRelative(raw),
  },
  {
    id: 'point',
    key: '3',
    name: 'Point-to-steer (screen-relative)',
    tag: 'Easiest',
    summary:
      'Push the stick / arrows where you want to GO on screen; the car steers its travel direction there. Holding a direction drives (auto-throttle). Handbrake still kicks the tail out.',
    games: 'Death Rally "direction-based", Circuit Superstars "screen-space steering"',
    pros: 'Instant pick-up with any camera; great with north-up.',
    cons: 'Less precise at the limit; subtle drift angle control is handed to the assist.',
    camera: 'north',
    model: 'physics',
    preset: 'Arcade Grip',
    map: (raw, car, cam) => {
      if (raw.source === 'touch') return carRelative(raw); // tilt steering is already car-relative
      if (raw.stickMag < 0.25) {
        return { steer: 0, throttle: raw.throttle, brake: raw.altBrake, handbrake: raw.handbrake, drift: false };
      }
      // stick (screen space) → world direction using the camera's up vector
      const up = cam.rot, rightA = up - Math.PI / 2;
      const wx = raw.stickX * Math.cos(rightA) + raw.stickY * Math.cos(up);
      const wy = raw.stickX * Math.sin(rightA) + raw.stickY * Math.sin(up);
      const desired = Math.atan2(wy, wx);
      const speed = car.speed;
      const [vl] = car.localVelocity;
      // steer the direction of travel (velocity) at speed, the nose when slow
      const travel = speed > 4 && vl > 0 ? Math.atan2(car.vy, car.vx) : car.heading;
      const err = wrap(desired - travel);
      const steer = clamp(err * CONTROL_TUNING.pointGain - car.yawRate * CONTROL_TUNING.pointDamping, -1, 1);
      const aligned = Math.abs(err) < 1.9 ? 1 : 0.35;
      const auto = CONTROL_TUNING.autoThrottle ? raw.stickMag * aligned : 0;
      return {
        steer,
        throttle: Math.max(raw.throttle, auto),
        brake: raw.altBrake,
        handbrake: raw.handbrake,
        drift: false,
      };
    },
  },
  {
    id: 'kart',
    key: '4',
    name: 'Drift button + mini-turbo',
    tag: 'Arcade',
    summary:
      'Car-relative steering with a held DRIFT button (Shift / B / RB): hop into a locked-in slide, steer to tighten or widen it, release for a blue → orange → purple boost.',
    games: 'Mario Kart 8, Hotshot Racing, Ridge Racer',
    pros: 'Readable, forgiving, strong reward loop.',
    cons: 'Drift is a scripted state layered on the tyres — less "real" than a handbrake slide.',
    camera: 'velocity',
    model: 'physics',
    preset: 'Arcade Grip',
    map: (raw) => carRelative(raw, { drift: true }),
  },
  {
    id: 'retro',
    key: '5',
    name: 'Retro rotational',
    tag: 'Old-school',
    summary:
      'Steering spins the car at a fixed rate and the velocity lags behind the nose — no tyre model. Handbrake loosens grip for big slides.',
    games: 'Micro Machines, GTA 1, Super Cars, Death Rally (1996)',
    pros: 'Dead simple, very responsive, easy to tune.',
    cons: 'No weight, no lift-off oversteer, no "real" braking.',
    camera: 'north',
    model: 'retro',
    preset: 'Balanced',
    map: (raw) => carRelative(raw),
  },
];

export const CAMERA_MODES = {
  velocity: 'Rotate · follow travel direction',
  heading: 'Rotate · locked to nose',
  north: 'Fixed north-up',
};
