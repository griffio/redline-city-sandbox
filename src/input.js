// Raw input: keyboard + Gamepad API, normalised into one state object each frame.
// Control schemes (controls.js) turn this into car commands.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const INPUT_TUNING = {
  deadzone: 0.12, // radial, rescaled
  outerDeadzone: 0.96,
  steerCurve: 1.6, // exponent on stick X: >1 = finer control near centre
  keySteerIn: 3.2, // keyboard steering ramp, units/s
  keySteerOut: 7.0, // return to centre
  keyReverseBoost: 2.0, // extra speed when flipping direction through centre
  rumble: 1.0,
};

const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color']);
const isTextEntry = (el) =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type)) ||
  (el instanceof HTMLElement && el.isContentEditable);

// Standard gamepad mapping indices
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

export class Input {
  constructor() {
    this.keys = new Set();
    this.pressedEdges = new Set(); // keys/buttons pressed this frame (for toggles)
    this.prevButtons = [];
    this.keySteer = 0;
    this.pad = null;
    this.state = {
      steer: 0, // -1..1, +left (car-relative)
      stickX: 0, stickY: 0, // screen-space stick (+x right, +y up), deadzone applied
      stickMag: 0,
      throttle: 0, brake: 0, handbrake: 0, drift: false, altBrake: 0,
      source: 'keyboard',
    };
    addEventListener('keydown', (e) => {
      if (isTextEntry(e.target)) return;
      // Panel sliders/selects/checkboxes/buttons keep focus after a click; hand the keyboard back to the car
      // and stop the key from also nudging the control (arrows on a slider, type-ahead on a select, Space on a button).
      const panelControl = e.target instanceof HTMLElement && e.target !== document.body && e.target.closest('#panel');
      if (panelControl) {
        e.target.blur();
        e.preventDefault();
      }
      if (!this.keys.has(e.code)) this.pressedEdges.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      this.state.source = 'keyboard';
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('gamepadconnected', (e) => {
      this.onPadChange?.(e.gamepad.id, true);
    });
    addEventListener('gamepaddisconnected', (e) => this.onPadChange?.(e.gamepad.id, false));
  }

  /** True once on the frame the key code / pad button ("pad:A") went down. */
  pressed(code) {
    return this.pressedEdges.has(code);
  }

  update(dt) {
    const k = this.keys;
    const T = INPUT_TUNING;
    const s = this.state;
    const left = k.has('KeyA') || k.has('ArrowLeft');
    const right = k.has('KeyD') || k.has('ArrowRight');
    const up = k.has('KeyW') || k.has('ArrowUp');
    const down = k.has('KeyS') || k.has('ArrowDown');

    // keyboard steering ramp: slower in, faster out, fastest when flipping sides
    const want = (left ? 1 : 0) - (right ? 1 : 0);
    if (want !== 0) {
      const flipping = Math.sign(this.keySteer) === -want;
      const rate = flipping ? T.keySteerOut * T.keyReverseBoost : T.keySteerIn;
      this.keySteer = clamp(this.keySteer + want * rate * dt, -1, 1);
    } else {
      const d = T.keySteerOut * dt;
      this.keySteer = Math.abs(this.keySteer) < d ? 0 : this.keySteer - Math.sign(this.keySteer) * d;
    }
    const kx = (right ? 1 : 0) - (left ? 1 : 0), ky = (up ? 1 : 0) - (down ? 1 : 0);
    const kmag = Math.hypot(kx, ky);

    let steer = this.keySteer;
    let throttle = up ? 1 : 0;
    let brake = down ? 1 : 0;
    let handbrake = k.has('Space') ? 1 : 0;
    let drift = k.has('ShiftLeft') || k.has('ShiftRight');
    let altBrake = k.has('ControlLeft') || k.has('KeyX') ? 1 : 0;
    let stickX = kmag ? kx / kmag : 0, stickY = kmag ? ky / kmag : 0, stickMag = kmag ? 1 : 0;

    // --- gamepad ---
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p && p.connected);
    this.pad = pad || null;
    if (pad) {
      const b = (i) => pad.buttons[i]?.value ?? 0;
      const down = (i) => !!pad.buttons[i]?.pressed;
      pad.buttons.forEach((btn, i) => {
        if (btn.pressed && !this.prevButtons[i]) {
          const name = Object.keys(BTN).find((n) => BTN[n] === i);
          if (name) this.pressedEdges.add(`pad:${name}`);
        }
        this.prevButtons[i] = btn.pressed;
      });
      // radial deadzone, rescaled, so diagonals don't snap to axes
      const ax = pad.axes[0] ?? 0, ay = -(pad.axes[1] ?? 0);
      const mag = Math.hypot(ax, ay);
      let padMag = 0, nx = 0, ny = 0;
      if (mag > T.deadzone) {
        padMag = clamp((mag - T.deadzone) / (T.outerDeadzone - T.deadzone), 0, 1);
        nx = ax / mag;
        ny = ay / mag;
      }
      const padX = nx * padMag;
      const padSteer = -Math.sign(padX) * Math.pow(Math.abs(padX), T.steerCurve);
      const rt = b(BTN.RT), lt = b(BTN.LT);
      const active = padMag > 0 || rt > 0.05 || lt > 0.05 || down(BTN.A) || down(BTN.B) || down(BTN.RB);
      if (active) s.source = 'gamepad';
      if (s.source === 'gamepad') {
        steer = padSteer;
        stickX = nx * padMag;
        stickY = ny * padMag;
        stickMag = padMag;
        throttle = Math.max(throttle, rt);
        brake = Math.max(brake, lt);
        handbrake = Math.max(handbrake, b(BTN.A));
        drift = drift || down(BTN.B) || down(BTN.RB);
        altBrake = Math.max(altBrake, b(BTN.X), lt);
      }
    }

    Object.assign(s, { steer, throttle, brake, handbrake, drift, altBrake, stickX, stickY, stickMag });
    return s;
  }

  endFrame() {
    this.pressedEdges.clear();
  }

  /** Dual-motor rumble: strong = low-frequency (lockups, impacts), weak = high-frequency (tyre buzz). */
  rumble(strong, weak, ms = 60) {
    const act = this.pad?.vibrationActuator;
    if (!act || INPUT_TUNING.rumble <= 0) return;
    strong = clamp(strong * INPUT_TUNING.rumble, 0, 1);
    weak = clamp(weak * INPUT_TUNING.rumble, 0, 1);
    if (strong < 0.02 && weak < 0.02) return;
    act.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
  }
}
