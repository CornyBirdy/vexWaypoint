/*
 * The drivetrain's motors and the robot's weight: from the motor wattage and current figures, the
 * battery voltage, the gearing, the wheel size and the weight, this works out how fast the robot really
 * goes ("real-life speed"), how quickly it gets there and how hard it can push.
 *
 * One side of the drivetrain is a DC motor model with a current limit. A motor at voltage V and shaft speed w
 * draws I = (V - Ke w) / R, limited to the current limit, and makes torque Kt I (less a little friction). That
 * torque goes through the gearing to the wheel and pushes the robot's mass against rolling resistance.
 *
 * Numbers: VEX publishes, for the V5 11 W motor, 2.1 N m stall torque with the 100 rpm cartridge and a 2.5 A
 * current limit (the 5.5 W motor: 0.5 N m, about 200 rpm). It does not publish the true stall current or the
 * free current, so those come from a community fit on the VEX Forum (about 4.7 A and 0.14 A for the 11 W
 * motor, 3.99 N m true stall torque on the 100 rpm cartridge): the 2.1 N m is the 2.5 A limit acting on
 * that. Treat all of it as typical, not measured on your motors.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  const G = 9.80665;
  const IN = 0.0254; // metres per inch
  const LB = 0.45359237; // kilograms per pound

  // reference figures for the 11 W motor at 12 V
  const REF = { watts: 11, stallA: 4.69, freeA: 0.14, limitA: 2.5, stallNm100: 3.99, vNominal: 12 };

  const DEFAULT_MOTOR = {
    auto: true, // work the speed and response out from the motors (off = type them in)
    perSide: 3, // motors on each side of the drivetrain
    watts: 11, // 11 (V5 smart motor) or 5.5 (V5 5.5 W motor)
    cartridge: 600, // rpm of the cartridge: 100, 200 or 600 (the 5.5 W motor is fixed at 200)
    stallA: REF.stallA, // true stall current, amps
    freeA: REF.freeA, // free (no-load) current, amps
    limitA: REF.limitA, // the current limit the brain applies, amps
    volts: 11.6, // battery voltage while driving (12.8 V when full and still, it sags under load)
    weight: 5.5,
    unit: 'kg', // 'kg' or 'lb'
  };

  const num = (v, d) => (v !== null && v !== '' && isFinite(Number(v)) ? Number(v) : d);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function sanitize(m) {
    const b = DEFAULT_MOTOR;
    m = m && typeof m === 'object' ? m : {};
    const watts = clamp(num(m.watts, b.watts), 1, 30);
    const k = watts / REF.watts;
    return {
      auto: m.auto !== false,
      perSide: Math.round(clamp(num(m.perSide, b.perSide), 1, 8)),
      watts,
      cartridge: watts <= 5.5 ? 200 : [100, 200, 600].includes(Number(m.cartridge)) ? Number(m.cartridge) : b.cartridge,
      stallA: clamp(num(m.stallA, REF.stallA * k), 0.2, 30),
      freeA: clamp(num(m.freeA, REF.freeA * k), 0, 5),
      limitA: clamp(num(m.limitA, REF.limitA * k), 0.2, 30),
      volts: clamp(num(m.volts, b.volts), 6, 14),
      weight: clamp(num(m.weight, b.weight), 0.5, 60),
      unit: m.unit === 'lb' ? 'lb' : 'kg',
    };
  }

  /** a change of motor wattage carries the typical current figures with it */
  function motorForWatts(m, watts) {
    const k = watts / REF.watts;
    return sanitize({ ...m, watts, stallA: REF.stallA * k, freeA: REF.freeA * k, limitA: REF.limitA * k, cartridge: watts <= 5.5 ? 200 : m.cartridge });
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
    const ge = m.cartridge / wheelRpm; // reduction from the motor shaft to the wheel (< 1 means geared up)
    const wCap = (m.cartridge * 2 * Math.PI) / 60; // shaft speed the brain allows at full command, rad/s
    const Kt = ((REF.stallNm100 * (100 / m.cartridge)) / (REF.stallA - REF.freeA)) * 1; // N m / A at the shaft
    const R = 12.8 / m.stallA; // winding resistance, ohms
    const Vmax = Math.min(m.volts, REF.vNominal); // the brain never gives a motor more than 12 V
    const Ke = (REF.vNominal - m.freeA * R) / wCap; // back-EMF constant: no-load speed at full command is the cartridge rpm
    const mass = m.weight * (m.unit === 'lb' ? LB : 1);
    const eta = 0.9; // gears, chain, bearings
    const model = {
      N: m.perSide, Kt, R, Ke, I0: m.freeA, Ilim: m.limitA, ge, r, eta, V: Vmax,
      mass, mSide: (mass * 1.08) / 2, // a little extra for the spinning wheels and gears
      Fres: (rollCoef * mass * G) / 2, // rolling resistance per side, N
      wCap,
    };

    // the force one side makes at ground speed v (m/s) and command c (-1..1), N
    const force = (c, v) => {
      const w = (v / r) * ge;
      let I = (c * model.V - Ke * w) / R;
      I = clamp(I, -model.Ilim, model.Ilim);
      const tau = Kt * I - Kt * model.I0 * Math.tanh(w / 3);
      return (model.N * tau * ge * eta) / r;
    };
    model.force = force;

    // top speed: where the push equals the resistance
    const vFree = (wheelRpm / 60) * Math.PI * robot.wheelDiameter; // ideal, in / s
    let lo = 0;
    let hi = (vFree * IN) * 1.3;
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
    model.stallBatteryA = 2 * m.perSide * m.limitA;
    model.vFree = vFree;
    return model;
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
    return (
      `${2 * m.perSide} motors (${m.watts} W, ${m.cartridge} rpm cartridge), ${kg.toFixed(1)} kg. ` +
      `Real top speed ${d.vTop.toFixed(1)} in/s = ${d.speedPct.toFixed(0)}% of the wheel's ideal ${d.vFree.toFixed(1)} in/s. ` +
      `Gets to 63% of that in ${d.respMs} ms; the motors could accelerate it at ${(d.peakAccel / 386.09).toFixed(1)} g and push with ${d.pushForce.toFixed(0)} N ` +
      `(the floor grip limits it first if that is lower). Battery draw at stall about ${d.stallBatteryA.toFixed(0)} A.`
    );
  }

  Object.assign(NS, { DEFAULT_MOTOR, sanitizeMotor: sanitize, motorForWatts, motorModel, motorStep, describeMotors: describe });
})();
