/*
 * The drivetrain's motors and the robot's weight: from the motors (11 W and / or 5.5 W, how many on each
 * side), the current figures, the gearing, the wheel size and the weight, this works out how fast the robot
 * really goes ("real-life speed"), how quickly it gets there and how hard it can push.
 *
 * A motor is a DC motor model with a current limit: at voltage V and shaft speed w it draws I = (V - Ke w) / R,
 * limited to the current limit, and makes torque Kt I (less a little friction). That torque goes through the
 * gearing to the wheel and pushes the robot's mass against rolling resistance. Every motor on a side pushes
 * on the same wheels, so their forces add; 11 W and 5.5 W motors can be mixed (2 x 11 W + 1 x 5.5 W per side
 * is the 55 W drive: 27.5 W a side).
 *
 * Numbers. 11 W motor: VEX publishes 2.1 N m stall torque with the 100 rpm cartridge and a 2.5 A current limit.
 * It does not publish the true stall current or the free current, so those come from a community fit on the
 * VEX Forum (about 4.7 A and 0.14 A, 3.99 N m true stall torque on the 100 rpm cartridge): the 2.1 N m is the
 * 2.5 A limit acting on that. 5.5 W motor: VEX publishes 0.5 N m stall torque at a fixed ~200 rpm. That is
 * 48% of an 11 W motor on the 200 rpm cartridge (1.05 N m), not exactly half, and its small free current is a
 * larger share of what it can do, so it loses slightly more than half the useful power. Treat all of it as
 * typical, not measured on your motors.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  const G = 9.80665;
  const IN = 0.0254; // metres per inch
  const LB = 0.45359237; // kilograms per pound
  const V_NOMINAL = 12; // the brain never gives a motor more than 12 V

  /** the electrical figures of each motor type (see the note at the top) */
  const TYPES = {
    11: { label: '11 W', stallA: 4.69, freeA: 0.14, limitA: 2.5, ktAt100: 0.877 * 100, fixedRpm: 0 }, // Kt = ktAt100 / cartridge rpm
    5.5: { label: '5.5 W', stallA: 2.3, freeA: 0.1, limitA: 1.25, kt: 0.435, fixedRpm: 200 },
  };

  const DEFAULT_MOTOR = {
    auto: true, // work the speed and response out from the motors (off = type them in)
    n11: 3, // 11 W motors on each side of the drivetrain
    n55: 0, // 5.5 W motors on each side
    cartridge: 600, // rpm of the 11 W motors' cartridge: 100, 200 or 600 (a 5.5 W motor is fixed at 200)
    cur11: { stallA: TYPES[11].stallA, freeA: TYPES[11].freeA, limitA: TYPES[11].limitA },
    cur55: { stallA: TYPES[5.5].stallA, freeA: TYPES[5.5].freeA, limitA: TYPES[5.5].limitA },
    volts: 11.6, // battery voltage while driving (12.8 V when full and still, it sags under load)
    weight: 5.5,
    unit: 'kg', // 'kg' or 'lb'
  };

  const num = (v, d) => (v !== null && v !== '' && isFinite(Number(v)) ? Number(v) : d);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function currents(c, type) {
    const t = TYPES[type];
    c = c && typeof c === 'object' ? c : {};
    return {
      stallA: clamp(num(c.stallA, t.stallA), 0.2, 30),
      freeA: clamp(num(c.freeA, t.freeA), 0, 5),
      limitA: clamp(num(c.limitA, t.limitA), 0.2, 30),
    };
  }

  /** a well-formed motor setup; settings saved by the old single-type form (perSide + watts) carry over */
  function sanitize(m) {
    const b = DEFAULT_MOTOR;
    m = m && typeof m === 'object' ? m : {};
    let n11 = m.n11;
    let n55 = m.n55;
    if (n11 === undefined && n55 === undefined && m.perSide !== undefined) {
      if (num(m.watts, 11) <= 5.5) {
        n11 = 0;
        n55 = m.perSide;
      } else {
        n11 = m.perSide;
        n55 = 0;
      }
    }
    n11 = Math.round(clamp(num(n11, b.n11), 0, 8));
    n55 = Math.round(clamp(num(n55, b.n55), 0, 8));
    if (n11 + n55 === 0) n11 = 1;
    return {
      auto: m.auto !== false,
      n11,
      n55,
      cartridge: [100, 200, 600].includes(Number(m.cartridge)) ? Number(m.cartridge) : b.cartridge,
      cur11: currents(m.cur11 || (m.watts > 5.5 ? m : null), 11),
      cur55: currents(m.cur55, 5.5),
      volts: clamp(num(m.volts, b.volts), 6, 14),
      weight: clamp(num(m.weight, b.weight), 0.5, 60),
      unit: m.unit === 'lb' ? 'lb' : 'kg',
    };
  }

  /**
   * One motor type as a group on a side: constants at the motor shaft, and its gearing to the wheel.
   * The motors are geared so that, unloaded, each type turns the wheel at the wheel RPM (a 5.5 W motor's
   * 200 rpm is geared up to a faster wheel, which costs it torque).
   */
  function group(type, count, cartridge, cur, wheelRpm) {
    const t = TYPES[type];
    const rpm = t.fixedRpm || cartridge;
    const Kt = t.kt || t.ktAt100 / rpm;
    const R = 12.8 / cur.stallA;
    const wCap = (rpm * 2 * Math.PI) / 60;
    return { type, count, Kt, R, Ke: (V_NOMINAL - cur.freeA * R) / wCap, I0: cur.freeA, Ilim: cur.limitA, ge: rpm / wheelRpm, rpm };
  }

  /**
   * @param {object} robot  {wheelDiameter (in), rpm (wheel, ideal), motor, ...}
   * @param {object} [chassis] the chassis (wheel types set the rolling resistance)
   * @returns the model the physics runs on, and the numbers for the readout
   */
  function motorModel(robot, chassis) {
    const m = sanitize(robot.motor);
    const rollCoef = NS.deriveChassis ? NS.deriveChassis(chassis, robot).roll : 0.045;
    const r = (robot.wheelDiameter * IN) / 2; // wheel radius, m
    const wheelRpm = Math.max(1, robot.rpm);
    const Vmax = Math.min(m.volts, V_NOMINAL);
    const mass = m.weight * (m.unit === 'lb' ? LB : 1);
    const eta = 0.9; // gears, chain, bearings
    const groups = [];
    if (m.n11) groups.push(group(11, m.n11, m.cartridge, m.cur11, wheelRpm));
    if (m.n55) groups.push(group(5.5, m.n55, 200, m.cur55, wheelRpm));
    const model = { groups, r, eta, V: Vmax, mass, mSide: (mass * 1.08) / 2, Fres: (rollCoef * mass * G) / 2 };

    // the force one side makes at ground speed v (m/s) and command c (-1..1), N
    const force = (c, v) => {
      let F = 0;
      for (const g of groups) {
        const w = (v / r) * g.ge;
        let I = (c * model.V - g.Ke * w) / g.R;
        I = clamp(I, -g.Ilim, g.Ilim);
        const tau = g.Kt * I - g.Kt * g.I0 * Math.tanh(w / 3);
        F += (g.count * tau * g.ge * eta) / r;
      }
      return F;
    };
    model.force = force;

    // top speed: where the push equals the resistance
    const vFree = (wheelRpm / 60) * Math.PI * robot.wheelDiameter; // ideal, in / s
    let lo = 0;
    let hi = vFree * IN * 1.3;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (force(1, mid) - model.Fres > 0) lo = mid;
      else hi = mid;
    }
    const vTop = lo / IN; // in / s
    model.vTop = vTop;
    model.speedPct = clamp((vTop / vFree) * 100, 1, 100);

    // response: time to reach 63% of top speed from rest at full command
    let v = 0;
    let t = 0;
    const dt = 0.001;
    while (v < 0.632 * vTop * IN && t < 3) {
      v += ((force(1, v) - model.Fres) / model.mSide) * dt;
      t += dt;
    }
    model.respMs = Math.max(1, Math.round(t * 1000));
    model.peakAccel = (force(1, 0) - model.Fres) / model.mSide / IN; // in / s^2, per side (the robot accelerates at this)
    model.pushForce = 2 * force(1, 0); // N, both sides at stall
    model.stallBatteryA = 2 * groups.reduce((a, g) => a + g.count * g.Ilim, 0);
    model.vFree = vFree;
    model.watts = 2 * (m.n11 * 11 + m.n55 * 5.5); // the drive's rated power, W
    model.wattsPerSide = m.n11 * 11 + m.n55 * 5.5;
    return model;
  }

  /**
   * How a 5.5 W motor compares with an 11 W one on the same shaft speed (the 11 W one on the 200 rpm cartridge):
   * the torque each makes at stall and while running (60% of free speed), as a ratio. It is not exactly half.
   */
  function halfPowerRatio(cartridge = 200, cur11, cur55) {
    const a = group(11, 1, cartridge, currents(cur11, 11), cartridge); // geared 1:1 so both run at the same speed
    const b = group(5.5, 1, 200, currents(cur55, 5.5), cartridge);
    // the force each makes at 60% of the free speed, per unit of wheel torque at the shaft
    const f = (g, c) => {
      const w = 0.6 * (g.rpm * 2 * Math.PI) / 60;
      let I = (c * V_NOMINAL - g.Ke * w) / g.R;
      I = clamp(I, -g.Ilim, g.Ilim);
      return g.Kt * I - g.Kt * g.I0 * Math.tanh(w / 3);
    };
    const stall = (g) => g.Kt * (g.Ilim - g.I0);
    return { stall: stall(b) / stall(a), running: f(b, 1) / f(a, 1) };
  }

  /** advance one side's ground speed (in / s) by dt seconds at motor command cmd (-127..127) */
  function motorStep(vIn, cmd, dt, m) {
    const v = vIn * IN;
    const F = m.force(clamp(cmd / 127, -1, 1), v) - m.Fres * Math.tanh(v / 0.05);
    return vIn + (F / m.mSide / IN) * dt;
  }

  /** one line for the UI */
  function describe(robot, chassis) {
    const m = sanitize(robot.motor);
    const d = motorModel(robot, chassis);
    const kg = m.weight * (m.unit === 'lb' ? LB : 1);
    const mix = [m.n11 ? `${m.n11} x 11 W (${m.cartridge} rpm cartridge)` : '', m.n55 ? `${m.n55} x 5.5 W` : ''].filter(Boolean).join(' + ');
    let text =
      `${mix} per side = ${d.wattsPerSide} W a side, a ${d.watts} W drive, ${kg.toFixed(1)} kg. ` +
      `Real top speed ${d.vTop.toFixed(1)} in/s = ${d.speedPct.toFixed(0)}% of the wheel's ideal ${d.vFree.toFixed(1)} in/s. ` +
      `Gets to 63% of that in ${d.respMs} ms; the motors could accelerate it at ${(d.peakAccel / 386.09).toFixed(1)} g and push with ${d.pushForce.toFixed(0)} N ` +
      `(the floor grip limits it first if that is lower). Battery draw at stall about ${d.stallBatteryA.toFixed(0)} A.`;
    if (m.n55) {
      const h = halfPowerRatio(200, m.cur11, m.cur55);
      text += ` A 5.5 W motor makes ${(h.stall * 100).toFixed(0)}% of the stall torque and ${(h.running * 100).toFixed(0)}% of the running torque of an 11 W motor at the same speed: a bit less than half.`;
    }
    return text;
  }

  Object.assign(NS, { DEFAULT_MOTOR, MOTOR_TYPES: TYPES, sanitizeMotor: sanitize, motorModel, motorStep, describeMotors: describe, halfPowerRatio });
})();
