/*
 * Other auton templates and plain motor code.
 *
 *  - JAR-Template (https://github.com/JacksonAreaRobotics/JAR-Template, MIT, (c) 2023 2775Josh):
 *    chassis.drive_distance / turn_to_angle / left_swing_to_angle / right_swing_to_angle /
 *    drive_to_point / drive_to_pose / turn_to_point, its PID, exit conditions and the
 *    drive_min_voltage motion chaining. A JavaScript port of src/JAR-Template/drive.cpp.
 *  - RW-Template (https://github.com/richardbwang/RW-Template, MIT, (c) 2025 Richard Wang):
 *    driveTo / turnToAngle / turnToPoint / moveToPoint / boomerang / curveCircle / swing, its PID,
 *    exit = false chaining, runAsync and the wait helpers. A JavaScript port of
 *    src/motor-control.cpp and src/pid.cpp. driveProfiled / turnProfiled / followPath /
 *    followPathRamsete are close approximations (see README).
 *  - PROS motor groups and VEXcode motors driven directly (move, move_voltage, move_relative,
 *    spin, spinFor, ...), for time-based or encoder-based autons without a library.
 *
 * Every motion runs once per 10 ms tick, like the originals. Voltages (-12..12 V) are turned into
 * the -127..127 motor commands the physics uses.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});
  const { Motion, fmt, D2R, R2D, clamp, TICK_MS } = NS;

  const to_rad = (d) => d * D2R;
  const to_deg = (r) => r * R2D;
  const sgn0 = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

  // =========================================================================================
  // JAR-Template
  // =========================================================================================

  function reduce_0_to_360(a) {
    a %= 360;
    return a < 0 ? a + 360 : a;
  }
  function reduce_negative_180_to_180(a) {
    a = reduce_0_to_360(a + 180) - 180;
    return a;
  }
  function reduce_negative_90_to_90(a) {
    a = (((a + 90) % 180) + 180) % 180;
    return a - 90;
  }
  function is_line_settled(dx, dy, angleDeg, cx, cy) {
    return (dy - cy) * Math.cos(to_rad(angleDeg)) <= -(dx - cx) * Math.sin(to_rad(angleDeg));
  }
  function left_voltage_scaling(d, h) {
    const ratio = Math.max(Math.abs(d + h), Math.abs(d - h)) / 12;
    return ratio > 1 ? (d + h) / ratio : d + h;
  }
  function right_voltage_scaling(d, h) {
    const ratio = Math.max(Math.abs(d + h), Math.abs(d - h)) / 12;
    return ratio > 1 ? (d - h) / ratio : d - h;
  }
  function clamp_min_voltage(out, min) {
    if (out < 0 && out > -min) return -min;
    if (out > 0 && out < min) return min;
    return out;
  }

  class JarPID {
    constructor(error, kp, ki, kd, starti, settle_error = 0, settle_time = 0, timeout = 0) {
      Object.assign(this, { kp, ki, kd, starti, settle_error, settle_time, timeout });
      this.accumulated_error = 0;
      this.previous_error = 0;
      this.time_spent_settled = 0;
      this.time_spent_running = 0;
    }
    compute(error) {
      if (Math.abs(error) < this.starti) this.accumulated_error += error;
      if ((error > 0 && this.previous_error < 0) || (error < 0 && this.previous_error > 0)) this.accumulated_error = 0;
      const output = this.kp * error + this.ki * this.accumulated_error + this.kd * (error - this.previous_error);
      this.previous_error = error;
      if (Math.abs(error) < this.settle_error) this.time_spent_settled += 10;
      else this.time_spent_settled = 0;
      this.time_spent_running += 10;
      return output;
    }
    /** is_settled(), with the reason */
    settled() {
      if (this.time_spent_running > this.timeout && this.timeout !== 0) return 'timeout';
      if (this.time_spent_settled > this.settle_time) return 'settled';
      return null;
    }
  }

  /** the constants `default_constants()` in a fresh JAR-Template project sets */
  const JAR_DEFAULTS = {
    drive_max_voltage: 10, drive_kp: 1.5, drive_ki: 0, drive_kd: 10, drive_starti: 0,
    heading_max_voltage: 6, heading_kp: 0.4, heading_ki: 0, heading_kd: 1, heading_starti: 0,
    turn_max_voltage: 12, turn_kp: 0.4, turn_ki: 0.03, turn_kd: 3, turn_starti: 15,
    swing_max_voltage: 12, swing_kp: 0.3, swing_ki: 0.001, swing_kd: 2, swing_starti: 15,
    drive_settle_error: 1.5, drive_settle_time: 300, drive_timeout: 5000,
    turn_settle_error: 1, turn_settle_time: 300, turn_timeout: 3000,
    swing_settle_error: 1, swing_settle_time: 300, swing_timeout: 3000,
    // global members nobody set are 0 in C++ (odom_constants() sets boomerang_lead = .5)
    drive_min_voltage: 0, boomerang_lead: 0, boomerang_setback: 0, desired_heading: 0,
  };

  /** fill a JAR overload's missing trailing arguments from the chassis members */
  function jarArgs(args, names, st) {
    const o = {};
    names.forEach((n, i) => (o[n] = args[i] !== undefined && args[i] !== null && typeof args[i] !== 'function' ? Number(args[i]) : st[n]));
    return o;
  }

  class JarMotion extends Motion {
    constructor(ch, name, argText) {
      super(ch, name, argText, 1e9);
      this.stopAtEnd = false; // JAR-Template never stops the motors after a motion
    }
    pose() {
      const p = this.ch.poseRad();
      return { x: p.x, y: p.y, h: reduce_0_to_360(p.t * R2D) };
    }
  }

  class JarTurn extends JarMotion {
    /** kind: 'turn' | 'left_swing' | 'right_swing' | 'point' */
    constructor(ch, kind, a, st, name, argText) {
      super(ch, name, argText);
      this.kind = kind;
      this.a = a;
      this.st = st;
      this.err = 0;
    }
    error() {
      const a = this.a;
      const p = this.pose();
      if (this.kind === 'point') {
        this.ch.aim = { x: a.X, y: a.Y };
        return reduce_negative_180_to_180(to_deg(Math.atan2(a.X - p.x, a.Y - p.y)) - p.h + a.extra);
      }
      return reduce_negative_180_to_180(a.angle - p.h);
    }
    begin() {
      super.begin();
      const a = this.a;
      if (this.kind === 'point') {
        const p = this.pose();
        this.pid = new JarPID(reduce_negative_180_to_180(to_deg(Math.atan2(a.X - p.x, a.Y - p.y)) - p.h), a.kp, a.ki, a.kd, a.starti, a.settle_error, a.settle_time, a.timeout);
      } else this.pid = new JarPID(this.error(), a.kp, a.ki, a.kd, a.starti, a.settle_error, a.settle_time, a.timeout);
    }
    step() {
      const done = this.pid.settled();
      if (done) return done;
      const error = this.error();
      this.err = error;
      let output = this.pid.compute(error);
      if (this.kind === 'left_swing') {
        // the original clamps swings with turn_max_voltage (the member), not swing_max_voltage
        output = clamp(output, -this.st.turn_max_voltage, this.st.turn_max_voltage);
        this.ch.driveVolts(output, 0);
      } else if (this.kind === 'right_swing') {
        output = clamp(output, -this.st.turn_max_voltage, this.st.turn_max_voltage);
        this.ch.driveVolts(0, -output);
      } else {
        output = clamp(output, -this.a.max, this.a.max);
        this.ch.driveVolts(output, -output);
      }
      return null;
    }
    errorText() {
      return `${fmt(Math.abs(this.err))} deg from target`;
    }
  }

  class JarDriveDistance extends JarMotion {
    constructor(ch, a, argText) {
      super(ch, 'drive_distance', argText);
      this.a = a;
      this.err = 0;
    }
    begin() {
      super.begin();
      const a = this.a;
      this.drivePID = new JarPID(a.distance, a.drive_kp, a.drive_ki, a.drive_kd, a.drive_starti, a.drive_settle_error, a.drive_settle_time, a.drive_timeout);
      this.headingPID = new JarPID(reduce_negative_180_to_180(a.heading - this.pose().h), a.heading_kp, a.heading_ki, a.heading_kd, a.heading_starti);
      this.start = (this.ch.robot.sL + this.ch.robot.sR) / 2;
    }
    step() {
      const done = this.drivePID.settled();
      if (done) return done;
      const a = this.a;
      const avg = (this.ch.robot.sL + this.ch.robot.sR) / 2;
      const drive_error = a.distance + this.start - avg;
      this.err = drive_error;
      this.dist = Math.abs(avg - this.start);
      const heading_error = reduce_negative_180_to_180(a.heading - this.pose().h);
      let drive_output = this.drivePID.compute(drive_error);
      let heading_output = this.headingPID.compute(heading_error);
      drive_output = clamp(drive_output, -a.drive_max_voltage, a.drive_max_voltage);
      heading_output = clamp(heading_output, -a.heading_max_voltage, a.heading_max_voltage);
      this.ch.driveVolts(drive_output + heading_output, drive_output - heading_output);
      return null;
    }
    errorText() {
      return `${fmt(Math.abs(this.err))} in from target`;
    }
  }

  class JarDriveToPoint extends JarMotion {
    constructor(ch, a, argText) {
      super(ch, 'drive_to_point', argText);
      this.a = a;
      this.err = 0;
    }
    begin() {
      super.begin();
      const a = this.a;
      const p = this.pose();
      this.drivePID = new JarPID(Math.hypot(a.X - p.x, a.Y - p.y), a.drive_kp, a.drive_ki, a.drive_kd, a.drive_starti, a.drive_settle_error, a.drive_settle_time, a.drive_timeout);
      this.start_angle_deg = to_deg(Math.atan2(a.X - p.x, a.Y - p.y));
      this.headingPID = new JarPID(this.start_angle_deg - p.h, a.heading_kp, a.heading_ki, a.heading_kd, a.heading_starti);
      this.prev_line_settled = is_line_settled(a.X, a.Y, this.start_angle_deg, p.x, p.y);
    }
    step() {
      const done = this.drivePID.settled();
      if (done) return done;
      const a = this.a;
      const p = this.pose();
      this.ch.aim = { x: a.X, y: a.Y };
      const line_settled = is_line_settled(a.X, a.Y, this.start_angle_deg, p.x, p.y);
      if (line_settled && !this.prev_line_settled) return 'crossed the finish line';
      this.prev_line_settled = line_settled;

      const drive_error = Math.hypot(a.X - p.x, a.Y - p.y);
      this.err = drive_error;
      let heading_error = reduce_negative_180_to_180(to_deg(Math.atan2(a.X - p.x, a.Y - p.y)) - p.h);
      let drive_output = this.drivePID.compute(drive_error);
      const heading_scale_factor = Math.cos(to_rad(heading_error));
      drive_output *= heading_scale_factor;
      heading_error = reduce_negative_90_to_90(heading_error);
      let heading_output = this.headingPID.compute(heading_error);
      if (drive_error < a.drive_settle_error) heading_output = 0;
      const lim = Math.abs(heading_scale_factor) * a.drive_max_voltage;
      drive_output = clamp(drive_output, -lim, lim);
      heading_output = clamp(heading_output, -a.heading_max_voltage, a.heading_max_voltage);
      drive_output = clamp_min_voltage(drive_output, a.drive_min_voltage);
      this.ch.driveVolts(left_voltage_scaling(drive_output, heading_output), right_voltage_scaling(drive_output, heading_output));
      return null;
    }
    errorText() {
      return `${fmt(this.err)} in from target`;
    }
  }

  class JarDriveToPose extends JarMotion {
    constructor(ch, a, argText) {
      super(ch, 'drive_to_pose', argText);
      this.a = a;
      this.err = 0;
    }
    begin() {
      super.begin();
      const a = this.a;
      const p = this.pose();
      this.drivePID = new JarPID(Math.hypot(a.X - p.x, a.Y - p.y), a.drive_kp, a.drive_ki, a.drive_kd, a.drive_starti, a.drive_settle_error, a.drive_settle_time, a.drive_timeout);
      this.headingPID = new JarPID(to_deg(Math.atan2(a.X - p.x, a.Y - p.y)) - p.h, a.heading_kp, a.heading_ki, a.heading_kd, a.heading_starti);
      this.prev_line_settled = is_line_settled(a.X, a.Y, a.angle, p.x, p.y);
      this.crossed_center_line = false;
      this.prev_center_line_side = is_line_settled(a.X, a.Y, a.angle + 90, p.x, p.y);
    }
    step() {
      const done = this.drivePID.settled();
      if (done) return done;
      const a = this.a;
      const p = this.pose();
      const line_settled = is_line_settled(a.X, a.Y, a.angle, p.x, p.y);
      if (line_settled && !this.prev_line_settled) return 'crossed the finish line';
      this.prev_line_settled = line_settled;
      // (the original never updates prev_center_line_side, so this is "has it ever changed")
      const center_line_side = is_line_settled(a.X, a.Y, a.angle + 90, p.x, p.y);
      if (center_line_side !== this.prev_center_line_side) this.crossed_center_line = true;

      const target_distance = Math.hypot(a.X - p.x, a.Y - p.y);
      this.err = target_distance;
      const carrot_X = a.X - Math.sin(to_rad(a.angle)) * (a.lead * target_distance + a.setback);
      const carrot_Y = a.Y - Math.cos(to_rad(a.angle)) * (a.lead * target_distance + a.setback);
      this.ch.aim = { x: carrot_X, y: carrot_Y };
      let drive_error = Math.hypot(carrot_X - p.x, carrot_Y - p.y);
      let heading_error = reduce_negative_180_to_180(to_deg(Math.atan2(carrot_X - p.x, carrot_Y - p.y)) - p.h);
      if (drive_error < a.drive_settle_error || this.crossed_center_line || drive_error < a.setback) {
        heading_error = reduce_negative_180_to_180(a.angle - p.h);
        drive_error = target_distance;
      }
      let drive_output = this.drivePID.compute(drive_error);
      const heading_scale_factor = Math.cos(to_rad(heading_error));
      drive_output *= heading_scale_factor;
      heading_error = reduce_negative_90_to_90(heading_error);
      let heading_output = this.headingPID.compute(heading_error);
      const lim = Math.abs(heading_scale_factor) * a.drive_max_voltage;
      drive_output = clamp(drive_output, -lim, lim);
      heading_output = clamp(heading_output, -a.heading_max_voltage, a.heading_max_voltage);
      drive_output = clamp_min_voltage(drive_output, a.drive_min_voltage);
      this.ch.driveVolts(left_voltage_scaling(drive_output, heading_output), right_voltage_scaling(drive_output, heading_output));
      return null;
    }
    errorText() {
      return `${fmt(this.err)} in from target`;
    }
  }

  const DRIVE_TAIL = ['drive_settle_error', 'drive_settle_time', 'drive_timeout', 'drive_kp', 'drive_ki', 'drive_kd', 'drive_starti', 'heading_kp', 'heading_ki', 'heading_kd', 'heading_starti'];
  const TURN_TAIL = ['settle_error', 'settle_time', 'timeout', 'kp', 'ki', 'kd', 'starti'];

  /** JAR-Template `Drive` methods, added to the simulated chassis object */
  function makeJarApi(ch, st) {
    const argText = (args) => Array.from(args).map((v) => (typeof v === 'number' ? fmt(v) : String(v))).join(', ');
    const run = (m) => ch._start(m, false);
    const turnArgs = (args, prefix, kind) => {
      const own = {};
      ['max', ...TURN_TAIL].forEach((k) => (own[k] = st[prefix + '_' + (k === 'max' ? 'max_voltage' : k)]));
      const names = kind === 'point' ? ['X', 'Y', 'extra', 'max', ...TURN_TAIL] : ['angle', 'max', ...TURN_TAIL];
      const a = jarArgs(args, names, { ...own, extra: 0 });
      return a;
    };
    const api = {
      drive_distance(...args) {
        const a = jarArgs(args, ['distance', 'heading', 'drive_max_voltage', 'heading_max_voltage', ...DRIVE_TAIL], { ...st, heading: reduce_0_to_360(ch.rotationDeg()) });
        return run(new JarDriveDistance(ch, a, argText(args)));
      },
      turn_to_angle(...args) {
        st.desired_heading = Number(args[0]);
        return run(new JarTurn(ch, 'turn', turnArgs(args, 'turn', 'turn'), st, 'turn_to_angle', argText(args)));
      },
      left_swing_to_angle(...args) {
        st.desired_heading = Number(args[0]);
        return run(new JarTurn(ch, 'left_swing', turnArgs(args, 'swing', 'swing'), st, 'left_swing_to_angle', argText(args)));
      },
      right_swing_to_angle(...args) {
        st.desired_heading = Number(args[0]);
        return run(new JarTurn(ch, 'right_swing', turnArgs(args, 'swing', 'swing'), st, 'right_swing_to_angle', argText(args)));
      },
      turn_to_point(...args) {
        return run(new JarTurn(ch, 'point', turnArgs(args, 'turn', 'point'), st, 'turn_to_point', argText(args)));
      },
      drive_to_point(...args) {
        const a = jarArgs(args, ['X', 'Y', 'drive_min_voltage', 'drive_max_voltage', 'heading_max_voltage', ...DRIVE_TAIL], st);
        return run(new JarDriveToPoint(ch, a, argText(args)));
      },
      drive_to_pose(...args) {
        const a = jarArgs(args, ['X', 'Y', 'angle', 'lead', 'setback', 'drive_min_voltage', 'drive_max_voltage', 'heading_max_voltage', ...DRIVE_TAIL], {
          ...st,
          lead: st.boomerang_lead,
          setback: st.boomerang_setback,
        });
        return run(new JarDriveToPose(ch, a, argText(args)));
      },
      // holonomic only: the sim is a tank drive, so drive to the point and turn
      async holonomic_drive_to_pose(x, y, angle) {
        await api.turn_to_point(x, y);
        await api.drive_to_point(x, y);
        if (angle !== undefined) await api.turn_to_angle(angle);
      },
      set_drive_constants: (m, kp, ki, kd, si) => Object.assign(st, { drive_max_voltage: m, drive_kp: kp, drive_ki: ki, drive_kd: kd, drive_starti: si }),
      set_heading_constants: (m, kp, ki, kd, si) => Object.assign(st, { heading_max_voltage: m, heading_kp: kp, heading_ki: ki, heading_kd: kd, heading_starti: si }),
      set_turn_constants: (m, kp, ki, kd, si) => Object.assign(st, { turn_max_voltage: m, turn_kp: kp, turn_ki: ki, turn_kd: kd, turn_starti: si }),
      set_swing_constants: (m, kp, ki, kd, si) => Object.assign(st, { swing_max_voltage: m, swing_kp: kp, swing_ki: ki, swing_kd: kd, swing_starti: si }),
      set_drive_exit_conditions: (e, t, to) => Object.assign(st, { drive_settle_error: e, drive_settle_time: t, drive_timeout: to }),
      set_turn_exit_conditions: (e, t, to) => Object.assign(st, { turn_settle_error: e, turn_settle_time: t, turn_timeout: to }),
      set_swing_exit_conditions: (e, t, to) => Object.assign(st, { swing_settle_error: e, swing_settle_time: t, swing_timeout: to }),
      set_coordinates: (x, y, h) => ch.setPose(x, y, h),
      set_heading: (h) => {
        const p = ch.poseRad();
        ch.setPose(p.x, p.y, h);
      },
      get_X_position: () => ch.poseRad().x,
      get_Y_position: () => ch.poseRad().y,
      get_absolute_heading: () => reduce_0_to_360(ch.rotationDeg()),
      get_left_position_in: () => ch.robot.sL,
      get_right_position_in: () => ch.robot.sR,
      drive_with_voltage: (l, r) => {
        ch.rawPower('L', (l * 127) / 12);
        ch.rawPower('R', (r * 127) / 12);
      },
      drive_stop: () => {
        ch.rawPower('L', 0);
        ch.rawPower('R', 0);
      },
    };
    return api;
  }

  // =========================================================================================
  // RW-Template
  // =========================================================================================

  /** settings from custom/src/robot-config.cpp (src/rw-config.cpp on PROS), template defaults */
  const RW_DEFAULTS = {
    distance_between_wheels: 12.3,
    distance_kp: 1.1, distance_ki: 0.1, distance_kd: 7,
    turn_kp: 0.3, turn_ki: 0, turn_kd: 2.5,
    heading_correction_kp: 0.6, heading_correction_ki: 0, heading_correction_kd: 4,
    dir_change_start: true, dir_change_end: true,
    min_output: 10,
    max_slew_accel_fwd: 24, max_slew_decel_fwd: 24, max_slew_accel_rev: 24, max_slew_decel_rev: 24,
    chase_power: 2,
    stall_exit_msec: 0,
    imu_scale: 1,
    profile_max_speed: 0, profile_max_accel: 100, profile_turn_speed: 360, profile_turn_accel: 1200,
    path_lookahead: 12, path_max_lateral_accel: 120,
  };
  const RW_SETTING_NAMES = Object.keys(RW_DEFAULTS).concat(['wheel_distance_in', 'drive_motor_rpm', 'drive_kS', 'drive_kV', 'drive_kA']);

  /** RW's PID class (src/pid.cpp), with the robot clock for its exit timers */
  class RwPID {
    constructor(kp, ki, kd, clock) {
      Object.assign(this, { kp, ki, kd, clock });
      this.arrived = false;
      this.arrive = true;
      this.small_error_tolerance = 1;
      this.big_error_tolerance = 3;
      this.small_error_duration = 100;
      this.big_error_duration = 500;
      this.small_check_time = 0;
      this.big_check_time = 0;
      this.first_time = true;
      this.integral_range = 0;
      this.integral_max = 500;
      this.derivative_tolerance = 0;
      this.target = 0;
      this.sum_error = 0;
      this.previous_error = 0;
    }
    setTarget(t) { this.target = t; }
    setIntegralMax(v) { this.integral_max = v; }
    setIntegralRange(v) { this.integral_range = v; }
    setSmallBigErrorTolerance(s, b) { this.small_error_tolerance = s; this.big_error_tolerance = b; }
    setSmallBigErrorDuration(s, b) { this.small_error_duration = s; this.big_error_duration = b; }
    setDerivativeTolerance(v) { this.derivative_tolerance = v; }
    setArrive(v) { this.arrive = v; }
    update(input) {
      const now = this.clock.now;
      const e = this.target - input;
      if (this.first_time) {
        this.first_time = false;
        this.previous_error = e;
        this.sum_error = 0;
        this.small_check_time = now;
        this.big_check_time = now;
      }
      const proportional = this.kp * e;
      const derivative = this.kd * (e - this.previous_error);
      this.previous_error = e;
      if (Math.abs(e) >= this.integral_range && this.integral_range !== 0) this.sum_error = 0;
      else {
        this.sum_error += e;
        if (Math.abs(this.sum_error) * this.ki > this.integral_max && this.integral_max !== 0) this.sum_error = (sgn0(this.sum_error) * this.integral_max) / this.ki;
      }
      if (sgn0(this.sum_error) !== sgn0(e) || Math.abs(e) <= this.small_error_tolerance) this.sum_error = 0;
      const integral = this.ki * this.sum_error;
      if (this.arrive && Math.abs(e) <= this.small_error_tolerance && Math.abs(derivative) <= this.derivative_tolerance) {
        if (now - this.small_check_time >= this.small_error_duration) this.arrived = true;
      } else this.small_check_time = now;
      if (this.arrive && Math.abs(e) <= this.big_error_tolerance && Math.abs(derivative) <= this.derivative_tolerance) {
        if (now - this.big_check_time >= this.big_error_duration) this.arrived = true;
      } else this.big_check_time = now;
      return proportional + integral + derivative;
    }
  }

  function turnTarget(angle, heading, direction) {
    let t = angle;
    while (t - heading > 180) t -= 360;
    while (t - heading < -180) t += 360;
    if (direction > 0 && t < heading - 5) t += 360;
    if (direction < 0 && t > heading + 5) t -= 360;
    return t;
  }

  /** scaleToMin / scaleToMax on a {l, r} pair */
  function scaleToMin(o, m) {
    const L = o.l;
    const R = o.r;
    if (Math.abs(L) <= Math.abs(R) && L < m && L > 0) {
      o.r = (R / L) * m;
      o.l = m;
    } else if (Math.abs(R) < Math.abs(L) && R < m && R > 0) {
      o.l = (L / R) * m;
      o.r = m;
    } else if (Math.abs(L) <= Math.abs(R) && L > -m && L < 0) {
      o.r = (R / L) * -m;
      o.l = -m;
    } else if (Math.abs(R) < Math.abs(L) && R > -m && R < 0) {
      o.l = (L / R) * -m;
      o.r = -m;
    }
  }
  function scaleToMax(o, m) {
    const L = o.l;
    const R = o.r;
    if (Math.abs(L) >= Math.abs(R) && L > m) {
      o.r = (R / L) * m;
      o.l = m;
    } else if (Math.abs(R) > Math.abs(L) && R > m) {
      o.l = (L / R) * m;
      o.r = m;
    } else if (Math.abs(L) > Math.abs(R) && L < -m) {
      o.r = (R / L) * -m;
      o.l = -m;
    } else if (Math.abs(R) > Math.abs(L) && R < -m) {
      o.l = (L / R) * -m;
      o.r = -m;
    }
  }
  function getRadius(x, y, x1, y1, angle) {
    const dx = x1 - x;
    const dy = y1 - y;
    if (2 * dy * Math.sin(to_rad(90 - angle)) === 0) return 999;
    return (dx * dx + dy * dy) / (2 * dy * Math.sin(to_rad(90 - angle)));
  }

  /** slew limits + whether to use min_output, for an `exit = false` (chained) move */
  function chainSlew(S, dir, exit) {
    let fwd = dir > 0 ? S.max_slew_accel_fwd : S.max_slew_decel_rev;
    let rev = dir > 0 ? S.max_slew_decel_fwd : S.max_slew_accel_rev;
    let minSpeed = false;
    if (!exit) {
      if (!S.dir_change_start && S.dir_change_end) {
        fwd = dir > 0 ? 24 : S.max_slew_decel_rev;
        rev = dir > 0 ? S.max_slew_decel_fwd : 24;
      }
      if (S.dir_change_start && !S.dir_change_end) {
        fwd = dir > 0 ? S.max_slew_accel_fwd : 24;
        rev = dir > 0 ? 24 : S.max_slew_accel_rev;
        minSpeed = true;
      }
      if (!S.dir_change_start && !S.dir_change_end) {
        fwd = 24;
        rev = 24;
        minSpeed = true;
      }
    }
    return { fwd, rev, minSpeed };
  }
  function applySlew(o, prev, sl) {
    if (prev.l - o.l > sl.rev) o.l = prev.l - sl.rev;
    if (prev.r - o.r > sl.rev) o.r = prev.r - sl.rev;
    if (o.l - prev.l > sl.fwd) o.l = prev.l + sl.fwd;
    if (o.r - prev.r > sl.fwd) o.r = prev.r + sl.fwd;
    prev.l = o.l;
    prev.r = o.r;
  }

  class RwMotion extends Motion {
    constructor(rw, name, argText, limit, exit) {
      super(rw.ch, name, argText, 1e9);
      this.rw = rw;
      this.S = rw.S;
      this.limit = limit == null ? 1e9 : limit;
      this.exit = exit !== false;
      this.stopAtEnd = this.exit;
      this.err = 0;
    }
    begin() {
      super.begin();
      const rw = this.rw;
      rw.motion_running = true;
      rw.cancel = false;
      rw.motion_start_traveled = this.ch.robot.traveled;
      rw.motion_start_heading = this.H();
      this.start_time = this.ch.clock.now;
      this.stall_start = -1;
    }
    onEnd() {
      this.rw.motion_running = false;
    }
    H() {
      return this.ch.rotationDeg() * this.S.imu_scale;
    }
    get x() {
      return this.ch.poseRad().x;
    }
    get y() {
      return this.ch.poseRad().y;
    }
    /** motionActive(): null while running, else why it stopped */
    inactive() {
      const now = this.ch.clock.now;
      if (this.rw.cancel) return 'cancelled';
      if (now - this.start_time > this.limit) return 'timeout';
      if (this.S.stall_exit_msec > 0 && now - this.start_time > 300) {
        const r = this.ch.robot;
        const speed = Math.abs((r.vL + r.vR) / 2);
        const turn = Math.abs(((r.vL - r.vR) / r.p.trackWidth) * R2D);
        if (!(speed < 1.5 && turn < 10)) this.stall_start = -1;
        else if (this.stall_start < 0) this.stall_start = now;
        else if (now - this.stall_start >= this.S.stall_exit_msec) return 'stalled';
      }
      return null;
    }
    volts(l, r) {
      this.ch.driveVolts(l, r);
    }
    errorText() {
      return this.err ? `${fmt(Math.abs(this.err))} ${this.unit || 'in'} from target` : '';
    }
  }

  class RwTurn extends RwMotion {
    constructor(rw, angle, direction, limit, exit, max, argText) {
      super(rw, 'turnToAngle', argText, limit, exit);
      this.angle = angle;
      this.direction = direction;
      this.max = max == null ? 12 : max;
      this.unit = 'deg';
    }
    begin() {
      super.begin();
      const S = this.S;
      this.target = turnTarget(this.angle, this.H(), this.direction);
      const pid = (this.pid = new RwPID(S.turn_kp, S.turn_ki, S.turn_kd, this.ch.clock));
      pid.setTarget(this.target);
      pid.setIntegralMax(0);
      pid.setIntegralRange(3);
      pid.setSmallBigErrorTolerance(1, 3);
      pid.setSmallBigErrorDuration(50, 250);
      pid.setDerivativeTolerance(4.5);
      const ca = this.rw.correct_angle;
      this.mode = !this.exit && ca < this.target ? 'right' : !this.exit && ca > this.target ? 'left' : 'pid';
    }
    step() {
      const h = this.H();
      this.err = this.target - h;
      if (this.mode === 'pid') {
        if (this.pid.arrived) return 'settled';
      } else if (this.mode === 'right' ? !(h < this.target) : !(h > this.target)) return 'reached';
      const why = this.inactive();
      if (why) return why;
      let out = this.pid.update(h);
      if (this.mode !== 'pid' && out < this.S.min_output) out = this.S.min_output;
      if (out > this.max) out = this.max;
      else if (out < -this.max) out = -this.max;
      if (this.mode === 'left') this.volts(-out, out);
      else this.volts(out, -out);
      return null;
    }
    onEnd(why) {
      super.onEnd(why);
      this.rw.correct_angle = this.target;
    }
  }

  class RwDriveTo extends RwMotion {
    constructor(rw, distance, limit, exit, max, argText) {
      super(rw, 'driveTo', argText, limit, exit);
      this.distance = distance;
      this.max = max == null ? 12 : max;
    }
    begin() {
      const r = this.ch.robot;
      this.startL = r.sL;
      this.startR = r.sR;
      super.begin();
      const S = this.S;
      this.dir = this.distance > 0 ? 1 : -1;
      this.sl = chainSlew(S, this.dir, this.exit);
      this.target = this.distance * this.dir;
      const pd = (this.pd = new RwPID(S.distance_kp, S.distance_ki, S.distance_kd, this.ch.clock));
      pd.setTarget(this.target);
      pd.setIntegralMax(3);
      pd.setSmallBigErrorTolerance(0.5, 1.5);
      pd.setSmallBigErrorDuration(50, 250);
      pd.setDerivativeTolerance(5);
      const ph = (this.ph = new RwPID(S.heading_correction_kp, S.heading_correction_ki, S.heading_correction_kd, this.ch.clock));
      ph.setTarget(turnTarget(this.rw.correct_angle, this.H(), 0));
      ph.setIntegralMax(0);
      ph.setIntegralRange(1);
      ph.setSmallBigErrorTolerance(0, 0);
      ph.setSmallBigErrorDuration(0, 0);
      ph.setDerivativeTolerance(0);
      ph.setArrive(false);
      this.cur = 0;
    }
    step() {
      const why = this.inactive();
      if (this.exit) {
        if (this.pd.arrived) return 'settled';
        if (why) return why;
      } else {
        if (!(this.cur < this.target)) return 'reached';
        if (why) return why;
      }
      const r = this.ch.robot;
      this.cur = (Math.abs(r.sL - this.startL) + Math.abs(r.sR - this.startR)) / 2;
      this.dist = this.cur;
      this.err = this.target - this.cur;
      const o = { l: this.pd.update(this.cur) * this.dir, r: 0 };
      o.r = o.l;
      const corr = this.ph.update(this.H());
      if (this.sl.minSpeed) scaleToMin(o, this.S.min_output);
      if (!this.exit) {
        o.l = 24 * this.dir;
        o.r = 24 * this.dir;
      }
      o.l += corr;
      o.r -= corr;
      scaleToMax(o, this.max);
      applySlew(o, this.rw.prev, this.sl);
      this.volts(o.l, o.r);
      return null;
    }
    onEnd(why) {
      super.onEnd(why);
      if (this.exit) this.rw.prev = { l: 0, r: 0 };
    }
  }

  class RwCurve extends RwMotion {
    constructor(rw, angle, radius, limit, exit, max, argText) {
      super(rw, 'curveCircle', argText, limit, exit);
      this.angle = angle;
      this.radius = radius;
      this.max = max == null ? 12 : max;
    }
    begin() {
      const r = this.ch.robot;
      this.startL = r.sL;
      this.startR = r.sR;
      const S = this.S;
      const ca = this.rw.correct_angle;
      this.result = turnTarget(this.angle, this.H(), 0);
      const ra = ((this.result - ca) * 3.14159265359) / 180;
      const tw = S.distance_between_wheels;
      const inArc = Math.abs((Math.abs(this.radius) - tw / 2) * ra);
      this.outArc = Math.abs((Math.abs(this.radius) + tw / 2) * ra);
      this.ratio = inArc / this.outArc;
      super.begin();
      this.curveDir = this.radius > 0 ? 1 : -1;
      this.driveDir = (this.curveDir === 1 && this.result - ca > 0) || (this.curveDir === -1 && this.result - ca < 0) ? 1 : -1;
      this.sl = chainSlew(S, this.driveDir, this.exit);
      this.ca0 = ca;
      const po = (this.po = new RwPID(S.distance_kp, S.distance_ki, S.distance_kd, this.ch.clock));
      po.setTarget(this.outArc);
      po.setIntegralMax(0);
      po.setIntegralRange(5);
      po.setSmallBigErrorTolerance(0.3, 0.9);
      po.setSmallBigErrorDuration(50, 250);
      po.setDerivativeTolerance(0.5 * 4.5);
      const pt = (this.pt = new RwPID(S.heading_correction_kp, S.heading_correction_ki, S.heading_correction_kd, this.ch.clock));
      pt.setTarget(0);
      pt.setIntegralMax(0);
      pt.setIntegralRange(1);
      pt.setSmallBigErrorTolerance(0, 0);
      pt.setSmallBigErrorDuration(0, 0);
      pt.setDerivativeTolerance(0);
      pt.setArrive(false);
      this.cur = 0;
    }
    step() {
      const why = this.inactive();
      if (this.exit) {
        if (this.po.arrived) return 'settled';
      } else if (!(this.cur < this.outArc)) return 'reached';
      if (why) return why;
      const r = this.ch.robot;
      const ang = this.H();
      const outer = this.curveDir === -1 ? 'R' : 'L';
      this.cur = Math.abs(outer === 'R' ? r.sR - this.startR : r.sL - this.startL);
      this.err = this.outArc - this.cur;
      const real = (this.cur / this.outArc) * (this.result - this.ca0) + this.ca0;
      this.pt.setTarget(turnTarget(real, ang, 0));
      const o = { l: 0, r: 0 };
      if (outer === 'R') {
        o.r = this.po.update(this.cur) * this.driveDir;
        o.l = o.r * this.ratio;
      } else {
        o.l = this.po.update(this.cur) * this.driveDir;
        o.r = o.l * this.ratio;
      }
      const corr = this.pt.update(ang);
      if (this.sl.minSpeed) scaleToMin(o, this.S.min_output);
      o.l += corr;
      o.r -= corr;
      scaleToMax(o, this.max);
      this.volts(o.l, o.r);
      return null;
    }
    onEnd(why) {
      super.onEnd(why);
      this.rw.correct_angle = this.result;
    }
  }

  class RwSwing extends RwMotion {
    constructor(rw, angle, driveDir, limit, exit, max, argText) {
      super(rw, 'swing', argText, limit, exit);
      this.angle = angle;
      this.driveDir = driveDir;
      this.max = max == null ? 12 : max;
      this.unit = 'deg';
    }
    begin() {
      super.begin();
      const S = this.S;
      this.target = turnTarget(this.angle, this.H(), 0);
      const pid = (this.pid = new RwPID(S.turn_kp, S.turn_ki, S.turn_kd, this.ch.clock));
      pid.setTarget(this.target);
      pid.setIntegralMax(0);
      pid.setIntegralRange(5);
      pid.setSmallBigErrorTolerance(1, 3);
      pid.setSmallBigErrorDuration(50, 250);
      pid.setDerivativeTolerance(4.5);
      const ca = this.rw.correct_angle;
      const d = this.driveDir;
      if (this.target - ca < 0 && d === 1) this.choice = 1;
      else if (this.target - ca > 0 && d === 1) this.choice = 2;
      else if (this.target - ca < 0 && d === -1) this.choice = 3;
      else this.choice = 4;
      this.cur = ca;
      // phase 1 (exit == false): swing until past the target; phase 2 (exit == true): PID to it
      this.phase = this.exit ? 2 : 1;
    }
    step() {
      const d = this.driveDir;
      const ch = this.choice;
      if (this.phase === 1) {
        const going = ch === 1 || ch === 3 ? this.cur > this.target : this.cur < this.target;
        const why = this.inactive();
        if (!going || why) return why || 'reached';
        this.cur = this.H();
        this.err = this.target - this.cur;
        let out = this.pid.update(this.cur);
        if (out < this.S.min_output) out = this.S.min_output;
        if (out > this.max) out = this.max;
        else if (out < -this.max) out = -this.max;
        if (ch === 1 || ch === 4) this.volts(0, out * d);
        else this.volts(out * d, 0);
        return null;
      }
      if (this.pid.arrived) return 'settled';
      const why = this.inactive();
      if (why) return why;
      this.cur = this.H();
      this.err = this.target - this.cur;
      let out = this.pid.update(this.cur);
      if (out > this.max) out = this.max;
      else if (out < -this.max) out = -this.max;
      if (ch === 1) this.volts(0, -out * d);
      else if (ch === 2) this.volts(out * d, 0);
      else if (ch === 3) this.volts(-out * d, 0);
      else this.volts(0, out * d);
      return null;
    }
    onEnd(why) {
      super.onEnd(why);
      this.rw.correct_angle = this.target;
    }
  }

  class RwTurnToPoint extends RwMotion {
    constructor(rw, x, y, dir, limit, argText) {
      super(rw, 'turnToPoint', argText, limit, true);
      this.tx = x;
      this.ty = y;
      this.add = dir === -1 ? 180 : 0;
      this.unit = 'deg';
    }
    aimAngle() {
      return turnTarget(to_deg(Math.atan2(this.tx - this.x, this.ty - this.y)) + this.add, this.H(), 0);
    }
    begin() {
      super.begin();
      const S = this.S;
      const pid = (this.pid = new RwPID(S.turn_kp, S.turn_ki, S.turn_kd, this.ch.clock));
      pid.setTarget(this.aimAngle());
      pid.setIntegralMax(0);
      pid.setIntegralRange(3);
      pid.setSmallBigErrorTolerance(1, 3);
      pid.setSmallBigErrorDuration(100, 500);
      pid.setDerivativeTolerance(4.5);
    }
    step() {
      if (this.pid.arrived) return 'settled';
      const why = this.inactive();
      if (why) return why;
      this.ch.aim = { x: this.tx, y: this.ty };
      this.pid.setTarget(this.aimAngle());
      const h = this.H();
      this.err = this.pid.target - h;
      const out = this.pid.update(h);
      this.volts(out, -out);
      return null;
    }
    onEnd(why) {
      super.onEnd(why);
      this.rw.correct_angle = this.H();
    }
  }

  class RwMoveToPoint extends RwMotion {
    constructor(rw, x, y, dir, limit, exit, max, overturn, argText) {
      super(rw, 'moveToPoint', argText, limit, exit);
      this.tx = x;
      this.ty = y;
      this.dir = dir > 0 ? 1 : -1;
      this.max = max == null ? 12 : max;
      this.overturn = !!overturn;
    }
    begin() {
      super.begin();
      const S = this.S;
      this.add = this.dir > 0 ? 0 : 180;
      this.sl = chainSlew(S, this.dir, this.exit);
      const pd = (this.pd = new RwPID(S.distance_kp, S.distance_ki, S.distance_kd, this.ch.clock));
      pd.setTarget(Math.hypot(this.tx - this.x, this.ty - this.y));
      pd.setIntegralMax(0);
      pd.setIntegralRange(3);
      pd.setSmallBigErrorTolerance(0.5, 1.5);
      pd.setSmallBigErrorDuration(50, 250);
      pd.setDerivativeTolerance(5);
      const ph = (this.ph = new RwPID(S.heading_correction_kp, S.heading_correction_ki, S.heading_correction_kd, this.ch.clock));
      ph.setTarget(turnTarget(to_deg(Math.atan2(this.tx - this.x, this.ty - this.y)) + this.add, this.H(), 0));
      ph.setIntegralMax(0);
      ph.setIntegralRange(1);
      ph.setSmallBigErrorTolerance(0, 0);
      ph.setSmallBigErrorDuration(0, 0);
      ph.setDerivativeTolerance(0);
      ph.setArrive(false);
      this.prev = { l: 0, r: 0 }; // moveToPoint keeps its own (local) slew memory
      this.prevPerp = true;
      this.ch_ = true;
      this.last = { x: this.x, y: this.y };
    }
    step() {
      const why = this.inactive();
      if (why) return why;
      const x = this.x;
      const y = this.y;
      this.dist += Math.hypot(x - this.last.x, y - this.last.y);
      this.last = { x, y };
      const tx = this.tx;
      const ty = this.ty;
      this.ch.aim = { x: tx, y: ty };
      this.ph.setTarget(turnTarget(to_deg(Math.atan2(tx - x, ty - y)) + this.add, this.H(), 0));
      this.pd.setTarget(Math.hypot(tx - x, ty - y));
      this.err = Math.hypot(tx - x, ty - y);
      const ang = this.H();
      const o = { l: this.pd.update(0) * Math.cos(to_rad(to_deg(Math.atan2(tx - x, ty - y)) + this.add - ang)) * this.dir, r: 0 };
      o.r = o.l;
      const na = turnTarget(ang + this.add, ang, 0);
      const perp = (y - ty) * -Math.cos(to_rad(na)) <= (x - tx) * Math.sin(to_rad(na)) + 1;
      if (perp && !this.prevPerp) return 'crossed the target line';
      this.prevPerp = perp;
      let corr = 0;
      if (Math.hypot(tx - x, ty - y) > 8 && this.ch_) corr = this.ph.update(ang);
      else this.ch_ = false;
      if (this.sl.minSpeed) scaleToMin(o, this.S.min_output);
      const over = Math.abs(o.l) + Math.abs(corr) - this.max;
      if (over > 0 && this.overturn) o.l += o.l > 0 ? -over : over;
      o.r = o.l;
      o.l += corr;
      o.r -= corr;
      scaleToMax(o, this.max);
      applySlew(o, this.prev, this.sl);
      this.volts(o.l, o.r);
      return null;
    }
    onEnd(why) {
      super.onEnd(why);
      if (this.exit) this.rw.prev = { l: 0, r: 0 };
      this.rw.correct_angle = this.H();
    }
  }

  class RwBoomerang extends RwMotion {
    constructor(rw, x, y, dir, a, dlead, limit, exit, max, overturn, argText) {
      super(rw, 'boomerang', argText, limit, exit);
      Object.assign(this, { tx: x, ty: y, a, dlead });
      this.dir = dir > 0 ? 1 : -1;
      this.max = max == null ? 12 : max;
      this.overturn = !!overturn;
    }
    begin() {
      super.begin();
      const S = this.S;
      this.add = this.dir > 0 ? 0 : 180;
      this.sl = chainSlew(S, this.dir, this.exit);
      const pd = (this.pd = new RwPID(S.distance_kp, S.distance_ki, S.distance_kd, this.ch.clock));
      pd.setTarget(0);
      pd.setIntegralMax(3);
      pd.setSmallBigErrorTolerance(0.5, 1.5);
      pd.setSmallBigErrorDuration(50, 250);
      pd.setDerivativeTolerance(5);
      const ph = (this.ph = new RwPID(S.heading_correction_kp, S.heading_correction_ki, S.heading_correction_kd, this.ch.clock));
      ph.setTarget(turnTarget(to_deg(Math.atan2(this.tx - this.x, this.ty - this.y)), this.H(), 0));
      ph.setIntegralMax(0);
      ph.setIntegralRange(1);
      ph.setSmallBigErrorTolerance(0, 0);
      ph.setSmallBigErrorDuration(0, 0);
      ph.setDerivativeTolerance(0);
      ph.setArrive(false);
      this.prevPerp = true;
      this.last = { x: this.x, y: this.y };
    }
    step() {
      if (this.pd.arrived) return 'settled';
      const why = this.inactive();
      if (why) return why;
      const x = this.x;
      const y = this.y;
      this.dist += Math.hypot(x - this.last.x, y - this.last.y);
      this.last = { x, y };
      const { tx, ty, a, add } = this;
      const hyp = Math.hypot(x - tx, y - ty);
      this.err = hyp;
      const cx = tx - hyp * Math.sin(to_rad(a + add)) * this.dlead;
      const cy = ty - hyp * Math.cos(to_rad(a + add)) * this.dlead;
      this.ch.aim = { x: cx, y: cy };
      this.pd.setTarget(Math.hypot(cx - x, cy - y) * this.dir);
      const ang = this.H();
      const o = { l: this.pd.update(0) * Math.cos(to_rad(to_deg(Math.atan2(cx - x, cy - y)) + add - ang)), r: 0 };
      o.r = o.l;
      const na = turnTarget(a, ang, 0);
      const perp = (y - ty) * -Math.cos(to_rad(na)) <= (x - tx) * Math.sin(to_rad(na)) + 3;
      if (perp && !this.prevPerp) return 'crossed the target line';
      this.prevPerp = perp;
      if (this.sl.minSpeed) scaleToMin(o, this.S.min_output);
      let corr;
      if (Math.hypot(cx - x, cy - y) > 8) {
        this.ph.setTarget(turnTarget(to_deg(Math.atan2(cx - x, cy - y)) + add, ang, 0));
        corr = this.ph.update(ang);
      } else if (Math.hypot(tx - x, ty - y) > 6) {
        this.ph.setTarget(turnTarget(to_deg(Math.atan2(tx - x, ty - y)) + add, ang, 0));
        corr = this.ph.update(ang);
      } else {
        this.ph.setTarget(turnTarget(a, ang, 0));
        corr = this.ph.update(ang);
        if (this.exit && Math.hypot(tx - x, ty - y) < 5) return 'close enough';
      }
      const slip = Math.sqrt(this.S.chase_power * getRadius(x, y, cx, cy, ang) * 9.8);
      if (o.l > slip) o.l = slip;
      else if (o.l < -slip) o.l = -slip;
      const over = Math.abs(o.l) + Math.abs(corr) - this.max;
      if (over > 0 && this.overturn) o.l += o.l > 0 ? -over : over;
      o.r = o.l;
      o.l += corr;
      o.r -= corr;
      scaleToMax(o, this.max);
      applySlew(o, this.rw.prev, this.sl);
      this.volts(o.l, o.r);
      return null;
    }
    onEnd(why) {
      super.onEnd(why);
      if (this.exit) this.rw.prev = { l: 0, r: 0 };
      this.rw.correct_angle = this.a;
    }
  }

  // ----- motion profiles and paths (path.cpp / path-following.cpp)

  function makeProfile(distance, max_speed, max_accel, start_speed = 0, end_speed = 0) {
    const p = { distance, max_speed: Math.abs(max_speed), max_accel: Math.max(Math.abs(max_accel), 1e-6) };
    const d = Math.abs(distance);
    const a = p.max_accel;
    const v0 = Math.min(Math.abs(start_speed), p.max_speed);
    let v1 = Math.min(Math.abs(end_speed), p.max_speed);
    if (v0 * v0 - 2 * a * d > v1 * v1) v1 = Math.sqrt(v0 * v0 - 2 * a * d);
    if (v1 * v1 - 2 * a * d > v0 * v0) v1 = Math.sqrt(v0 * v0 + 2 * a * d);
    let peak = Math.min(p.max_speed, Math.sqrt((2 * a * d + v0 * v0 + v1 * v1) / 2));
    peak = Math.max(peak, v0, v1);
    Object.assign(p, { start_speed: v0, end_speed: v1, peak_speed: peak });
    p.accel_time = (peak - v0) / a;
    p.decel_time = (peak - v1) / a;
    const ad = (peak * peak - v0 * v0) / (2 * a);
    const dd = (peak * peak - v1 * v1) / (2 * a);
    p.cruise_time = peak > 1e-9 ? Math.max(0, d - ad - dd) / peak : 0;
    p.total_time = p.accel_time + p.cruise_time + p.decel_time;
    return p;
  }
  function profileAt(p, t) {
    const sign = p.distance < 0 ? -1 : 1;
    const a = p.max_accel;
    const v0 = p.start_speed;
    const peak = p.peak_speed;
    const ad = (peak * peak - v0 * v0) / (2 * a);
    const cd = peak * p.cruise_time;
    let pos;
    let speed;
    let acc;
    if (t <= 0) [pos, speed, acc] = [0, v0, p.accel_time > 0 ? a : 0];
    else if (t < p.accel_time) [pos, speed, acc] = [v0 * t + 0.5 * a * t * t, v0 + a * t, a];
    else if (t < p.accel_time + p.cruise_time) [pos, speed, acc] = [ad + peak * (t - p.accel_time), peak, 0];
    else if (t < p.total_time) {
      const into = t - p.accel_time - p.cruise_time;
      [pos, speed, acc] = [ad + cd + peak * into - 0.5 * a * into * into, peak - a * into, -a];
    } else [pos, speed, acc] = [Math.abs(p.distance), p.end_speed, 0];
    return { pos: pos * sign, speed: speed * sign, accel: acc * sign };
  }

  function catmullRom(p0, p1, p2, p3, u) {
    const t0 = 0;
    const t1 = t0 + Math.max(Math.sqrt(Math.hypot(p1.x - p0.x, p1.y - p0.y)), 1e-4);
    const t2 = t1 + Math.max(Math.sqrt(Math.hypot(p2.x - p1.x, p2.y - p1.y)), 1e-4);
    const t3 = t2 + Math.max(Math.sqrt(Math.hypot(p3.x - p2.x, p3.y - p2.y)), 1e-4);
    const t = t1 + u * (t2 - t1);
    const L = (ta, tb, A, B) => ({ x: ((tb - t) / (tb - ta)) * A.x + ((t - ta) / (tb - ta)) * B.x, y: ((tb - t) / (tb - ta)) * A.y + ((t - ta) / (tb - ta)) * B.y });
    const a1 = L(t0, t1, p0, p1);
    const a2 = L(t1, t2, p1, p2);
    const a3 = L(t2, t3, p2, p3);
    const b1 = L(t0, t2, a1, a2);
    const b2 = L(t1, t3, a2, a3);
    return L(t1, t2, b1, b2);
  }

  function resamplePath(dense) {
    const path = { __rwPath: true, samples: [], length: 0 };
    if (!dense.length) return path;
    const S = path.samples;
    S.push({ x: dense[0].x, y: dense[0].y, heading_deg: 0, curvature: 0, distance: 0, speed_limit: dense[0].speed });
    let carried = 0;
    for (let i = 1; i < dense.length; i++) {
      const x0 = dense[i - 1].x;
      const y0 = dense[i - 1].y;
      const seg = Math.hypot(dense[i].x - x0, dense[i].y - y0);
      let along = 1 - carried;
      while (along <= seg) {
        const f = along / seg;
        S.push({ x: x0 + (dense[i].x - x0) * f, y: y0 + (dense[i].y - y0) * f, heading_deg: 0, curvature: 0, distance: 0, speed_limit: dense[i - 1].speed + (dense[i].speed - dense[i - 1].speed) * f });
        along += 1;
      }
      carried = seg - (along - 1);
    }
    const last = dense[dense.length - 1];
    const end = S[S.length - 1];
    if (Math.hypot(end.x - last.x, end.y - last.y) > 0.05) S.push({ x: last.x, y: last.y, heading_deg: 0, curvature: 0, distance: 0, speed_limit: last.speed });
    const n = S.length;
    for (let i = 1; i < n; i++) S[i].distance = S[i - 1].distance + Math.hypot(S[i].x - S[i - 1].x, S[i].y - S[i - 1].y);
    path.length = S[n - 1].distance;
    for (let i = 0; i < n; i++) {
      const a = i > 0 ? i - 1 : i;
      const b = i + 1 < n ? i + 1 : i;
      if (a !== b) S[i].heading_deg = to_deg(Math.atan2(S[b].x - S[a].x, S[b].y - S[a].y));
      else if (i > 0) S[i].heading_deg = S[i - 1].heading_deg;
      if (i >= 2 && i + 2 < n) {
        const p = S[i - 2];
        const q = S[i];
        const r = S[i + 2];
        const cross = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
        const len = Math.hypot(q.x - p.x, q.y - p.y) * Math.hypot(r.x - q.x, r.y - q.y) * Math.hypot(r.x - p.x, r.y - p.y);
        S[i].curvature = len > 1e-9 ? (-2 * cross) / len : 0;
      }
    }
    if (n >= 5) {
      S[0].curvature = S[1].curvature = S[2].curvature;
      S[n - 1].curvature = S[n - 2].curvature = S[n - 3].curvature;
    }
    return path;
  }

  /** pathFromPoints({{x, y}, {x, y, speed}, ...}): a centripetal Catmull-Rom spline */
  function pathFromPoints(list) {
    const w = (list || []).map((p) => (Array.isArray(p) ? { x: +p[0], y: +p[1], speed: p[2] == null ? 1 : +p[2] } : { x: +p.x, y: +p.y, speed: p.speed == null ? 1 : +p.speed }));
    if (w.length < 2) return resamplePath(w);
    const n = w.length;
    const padded = [{ x: 2 * w[0].x - w[1].x, y: 2 * w[0].y - w[1].y, speed: w[0].speed }, ...w, { x: 2 * w[n - 1].x - w[n - 2].x, y: 2 * w[n - 1].y - w[n - 2].y, speed: w[n - 1].speed }];
    const dense = [];
    for (let i = 1; i + 2 < padded.length; i++) {
      for (let k = i === 1 ? 0 : 1; k <= 50; k++) {
        const u = k / 50;
        const p = catmullRom(padded[i - 1], padded[i], padded[i + 1], padded[i + 2], u);
        dense.push({ x: p.x, y: p.y, speed: padded[i].speed + (padded[i + 1].speed - padded[i].speed) * u });
      }
    }
    return resamplePath(dense);
  }

  /** a path loaded into the sim (jerry.io file / drawn) as an RW path */
  function pathFromSimPath(simPath, ch) {
    const { pts, endIdx } = simPath.getPath(ch);
    const w = pts.slice(0, endIdx + 1).map((p) => ({ x: p.x, y: p.y, speed: Math.min(1, Math.max(0.05, (p.v || 127) / 127)) }));
    const clean = w.filter((p, i) => i === 0 || Math.hypot(p.x - w[i - 1].x, p.y - w[i - 1].y) > 0.01);
    return resamplePath(clean);
  }

  function planPathSpeeds(path, max_speed, max_accel, max_lat, end_speed) {
    const S = path.samples;
    const n = S.length;
    const sp = S.map((s) => {
      let lim = max_speed * s.speed_limit;
      const c = Math.abs(s.curvature);
      if (c > 1e-6) lim = Math.min(lim, Math.sqrt(max_lat / c));
      return lim;
    });
    if (!n) return sp;
    sp[n - 1] = Math.min(sp[n - 1], end_speed);
    for (let i = n - 1; i > 0; i--) sp[i - 1] = Math.min(sp[i - 1], Math.sqrt(sp[i] * sp[i] + 2 * max_accel * (S[i].distance - S[i - 1].distance)));
    return sp;
  }
  function closestSample(path, x, y, start) {
    const n = path.samples.length;
    let best = clamp(start, 0, n - 1);
    let bd = 1e18;
    const stop = Math.min(start + 40, n);
    for (let i = best; i < stop; i++) {
      const d = Math.hypot(path.samples[i].x - x, path.samples[i].y - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
  function lookaheadPoint(path, x, y, la, from) {
    const S = path.samples;
    const n = S.length;
    let found = null;
    const stop = Math.min(from + Math.floor(la * 3) + 5, n - 1);
    for (let i = Math.max(0, from); i < stop; i++) {
      const a = S[i];
      const b = S[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const fx = a.x - x;
      const fy = a.y - y;
      const qa = dx * dx + dy * dy;
      const qb = 2 * (fx * dx + fy * dy);
      const qc = fx * fx + fy * fy - la * la;
      const disc = qb * qb - 4 * qa * qc;
      if (qa < 1e-12 || disc < 0) continue;
      const root = Math.sqrt(disc);
      const t2 = (-qb + root) / (2 * qa);
      const t1 = (-qb - root) / (2 * qa);
      const t = t2 >= 0 && t2 <= 1 ? t2 : t1 >= 0 && t1 <= 1 ? t1 : -1;
      if (t >= 0) found = { x: a.x + dx * t, y: a.y + dy * t };
    }
    const end = S[n - 1];
    const ex = end.x - x;
    const ey = end.y - y;
    if (!found && Math.hypot(ex, ey) <= la) {
      const ux = Math.sin(to_rad(end.heading_deg));
      const uy = Math.cos(to_rad(end.heading_deg));
      const along = ex * ux + ey * uy;
      const past = -along + Math.sqrt(Math.max(0, along * along - (ex * ex + ey * ey) + la * la));
      found = { x: end.x + ux * past, y: end.y + uy * past };
    }
    return found;
  }
  function curvatureToPoint(x, y, hdg, tx, ty) {
    const h = to_rad(hdg);
    const dx = tx - x;
    const dy = ty - y;
    const lx = dx * Math.cos(h) - dy * Math.sin(h);
    const ly = dx * Math.sin(h) + dy * Math.cos(h);
    const d2 = lx * lx + ly * ly;
    return d2 > 1e-9 ? (2 * lx) / d2 : 0;
  }

  /** driveWheelSpeeds(): the sim's motors are linear, so feedforward is exact: speed / top speed */
  function wheelSpeeds(ch, l, r) {
    const vmax = ch.robot.vmax;
    let L = (l / vmax) * 127;
    let R = (r / vmax) * 127;
    const big = Math.max(Math.abs(L), Math.abs(R));
    if (big > 127) {
      L = (L / big) * 127;
      R = (R / big) * 127;
    }
    ch.drive(L, R);
  }
  function profileSpeed(rw, requested) {
    if (requested > 0) return requested;
    if (rw.S.profile_max_speed > 0) return rw.S.profile_max_speed;
    return rw.ch.robot.vmax * 0.8;
  }
  const curSpeed = (ch, dir) => Math.max(0, (dir * (ch.robot.vL + ch.robot.vR)) / 2);

  class RwDriveProfiled extends RwMotion {
    constructor(rw, distance, limit, exit, maxSpeed, argText) {
      super(rw, 'driveProfiled', argText, limit, exit);
      this.distance = distance;
      this.maxSpeed = maxSpeed || 0;
    }
    begin() {
      super.begin();
      const speed = profileSpeed(this.rw, this.maxSpeed);
      const dir = this.distance < 0 ? -1 : 1;
      this.profile = makeProfile(this.distance, speed, this.S.profile_max_accel, curSpeed(this.ch, dir), this.exit ? 0 : speed * 0.5);
      this.startL = this.ch.robot.sL;
      this.startR = this.ch.robot.sR;
      this.hdg = turnTarget(this.rw.correct_angle, this.H(), 0);
    }
    step() {
      const why = this.inactive();
      if (why) return why;
      const t = (this.ch.clock.now - this.start_time) / 1000;
      const pl = profileAt(this.profile, t);
      const r = this.ch.robot;
      const traveled = (r.sL - this.startL + (r.sR - this.startR)) / 2;
      const perr = pl.pos - traveled;
      this.err = this.distance - traveled;
      this.dist = Math.abs(traveled);
      const T = this.profile.total_time;
      if (t >= T && (!this.exit || Math.abs(perr) < 0.5 || t > T + 0.75)) return 'done';
      const sc = pl.speed + 5 * perr;
      const tc = 0.8 * (this.hdg - this.H());
      wheelSpeeds(this.ch, sc + tc, sc - tc);
      return null;
    }
  }

  class RwTurnProfiled extends RwMotion {
    constructor(rw, angle, direction, limit, exit, maxSpeed, argText) {
      super(rw, 'turnProfiled', argText, limit, exit);
      this.angle = angle;
      this.direction = direction;
      this.maxSpeed = maxSpeed || 0;
      this.unit = 'deg';
    }
    begin() {
      super.begin();
      this.target = turnTarget(this.angle, this.H(), this.direction);
      this.start = this.H();
      const speed = this.maxSpeed > 0 ? this.maxSpeed : this.S.profile_turn_speed;
      this.profile = makeProfile(this.target - this.start, speed, this.S.profile_turn_accel, 0, this.exit ? 0 : speed * 0.5);
    }
    step() {
      const why = this.inactive();
      if (why) return why;
      const t = (this.ch.clock.now - this.start_time) / 1000;
      const pl = profileAt(this.profile, t);
      const h = this.H();
      this.err = this.target - h;
      const T = this.profile.total_time;
      if (t >= T && (!this.exit || Math.abs(this.target - h) < 1 || t > T + 0.75)) return 'done';
      const rate = pl.speed + 6 * (this.start + pl.pos - h);
      const ws = to_rad(rate) * (this.S.distance_between_wheels / 2);
      wheelSpeeds(this.ch, ws, -ws);
      return null;
    }
    onEnd(why) {
      super.onEnd(why);
      this.rw.correct_angle = this.target;
    }
  }

  class RwFollowPath extends RwMotion {
    constructor(rw, path, limit, reverse, exit, maxSpeed, lookahead, name, argText) {
      super(rw, name, argText, limit, exit);
      this.path = path;
      this.reverse = !!reverse;
      this.maxSpeed = maxSpeed || 0;
      this.lookahead = lookahead || 0;
    }
    begin() {
      super.begin();
      const speed = profileSpeed(this.rw, this.maxSpeed);
      this.la = this.lookahead > 0 ? this.lookahead : this.S.path_lookahead;
      this.speeds = planPathSpeeds(this.path, speed, this.S.profile_max_accel, this.S.path_max_lateral_accel, this.exit ? 0 : speed * 0.5);
      this.direction = this.reverse ? -1 : 1;
      this.command = curSpeed(this.ch, this.direction);
      this.closest = 0;
      this.lastT = this.ch.clock.now;
      this.last = { x: this.x, y: this.y };
    }
    step() {
      const why = this.inactive();
      if (why) return why;
      const S = this.path.samples;
      const n = S.length;
      if (n < 2) return 'empty path';
      const now = this.ch.clock.now;
      const dt = Math.max((now - this.lastT) / 1000, 0.001);
      this.lastT = now;
      const x = this.x;
      const y = this.y;
      this.dist += Math.hypot(x - this.last.x, y - this.last.y);
      this.last = { x, y };
      this.closest = closestSample(this.path, x, y, this.closest);
      const end = S[n - 1];
      this.err = Math.hypot(end.x - x, end.y - y);
      const past = (x - end.x) * Math.sin(to_rad(end.heading_deg)) + (y - end.y) * Math.cos(to_rad(end.heading_deg));
      if (this.closest >= n - 3 && (this.err < 1 || past > 0)) return 'reached end';
      let tgt = lookaheadPoint(this.path, x, y, this.la, this.closest);
      if (!tgt) {
        const ahead = Math.min(this.closest + Math.floor(this.la), n - 1);
        tgt = { x: S[ahead].x, y: S[ahead].y };
      }
      this.ch.aim = tgt;
      const travel = this.H() + (this.reverse ? 180 : 0);
      const curv = curvatureToPoint(x, y, travel, tgt.x, tgt.y);
      const want = this.speeds[this.closest];
      if (want > this.command) this.command = Math.min(want, this.command + this.S.profile_max_accel * dt);
      else this.command = want;
      this.command = Math.max(this.command, this.exit ? 4 : 0);
      const outside = curv * (this.S.distance_between_wheels / 2) * (this.reverse ? -1 : 1);
      const v = this.direction * this.command;
      wheelSpeeds(this.ch, v * (1 + outside), v * (1 - outside));
      return null;
    }
    onEnd(why) {
      super.onEnd(why);
      this.rw.correct_angle = this.H();
    }
  }

  /**
   * RW-Template's free functions. `inAsync` = called from inside a runAsync() lambda, where
   * waitForMotion() returns at once and motions run back to back.
   */
  function makeRwApi(ch, S, opts) {
    const rw = {
      ch,
      S,
      correct_angle: 0,
      prev: { l: 0, r: 0 },
      motion_running: false,
      asyncRunning: false,
      cancel: false,
      motion_start_traveled: 0,
      motion_start_heading: 0,
      warned: new Set(),
    };
    const log = opts.log;
    const approx = (name) => {
      if (rw.warned.has(name)) return;
      rw.warned.add(name);
      log('info', `${name}() is simulated closely but not exactly (RW-Template's feedforward / RAMSETE are approximated)`);
    };
    const argText = (args) => Array.from(args).filter((v) => v !== undefined).map((v) => (typeof v === 'number' ? fmt(v) : typeof v === 'object' ? 'path' : String(v))).join(', ');
    const H = () => ch.rotationDeg() * S.imu_scale;
    const anyMotion = () => rw.asyncRunning || rw.motion_running || !!ch.motion;

    function build(inAsync) {
      const run = async (m) => {
        // a regular motion started while an async one runs waits for it
        if (!inAsync) while (rw.asyncRunning) await ch.clock.sleep(TICK_MS);
        await ch._start(m, false);
      };
      const isDir = (v) => v === 'clockwise' || v === 'counterclockwise' || v === 'shortest';
      const dirNum = (v) => (v === 'clockwise' ? 1 : v === 'counterclockwise' ? -1 : 0);
      const api = {
        turnToAngle(angle, a, b, c, d) {
          if (isDir(a)) return run(new RwTurn(rw, angle, dirNum(a), b, c, d, argText(arguments)));
          return run(new RwTurn(rw, angle, 0, a, b, c, argText(arguments)));
        },
        driveTo: function (d, limit, exit, max) {
          return run(new RwDriveTo(rw, d, limit, exit, max, argText(arguments)));
        },
        curveCircle: function (angle, radius, limit, exit, max) {
          return run(new RwCurve(rw, angle, radius, limit, exit, max, argText(arguments)));
        },
        swing: function (angle, dir, limit, exit, max) {
          return run(new RwSwing(rw, angle, dir, limit, exit, max, argText(arguments)));
        },
        turnToPoint: function (x, y, dir, limit) {
          return run(new RwTurnToPoint(rw, x, y, dir, limit, argText(arguments)));
        },
        moveToPoint: function (x, y, dir, limit, exit, max, overturn) {
          return run(new RwMoveToPoint(rw, x, y, dir, limit, exit, max, overturn, argText(arguments)));
        },
        boomerang: function (x, y, dir, a, dlead, limit, exit, max, overturn) {
          return run(new RwBoomerang(rw, x, y, dir, a, dlead, limit, exit, max, overturn, argText(arguments)));
        },
        driveProfiled: function (d, limit, exit, maxSpeed) {
          approx('driveProfiled');
          return run(new RwDriveProfiled(rw, d, limit, exit, maxSpeed, argText(arguments)));
        },
        turnProfiled(angle, a, b, c, d) {
          approx('turnProfiled');
          if (isDir(a)) return run(new RwTurnProfiled(rw, angle, dirNum(a), b, c, d, argText(arguments)));
          return run(new RwTurnProfiled(rw, angle, 0, a, b, c, argText(arguments)));
        },
        followPath: function (path, limit, reverse, exit, maxSpeed, lookahead) {
          approx('followPath');
          const p = path && path.__path ? pathFromSimPath(path, ch) : path;
          if (!p || !p.samples) throw new Error('followPath(): first argument is not a path');
          return run(new RwFollowPath(rw, p, limit, reverse, exit, maxSpeed, lookahead, 'followPath', argText(arguments)));
        },
        followPathRamsete: function (path, limit, reverse, exit, maxSpeed) {
          approx('followPathRamsete');
          const p = path && path.__path ? pathFromSimPath(path, ch) : path;
          if (!p || !p.samples) throw new Error('followPathRamsete(): first argument is not a path');
          return run(new RwFollowPath(rw, p, limit, reverse, exit, maxSpeed, 0, 'followPathRamsete', argText(arguments)));
        },
        pathFromPoints,
        pathFromJerryIO: (text) => {
          const pts = [];
          String(text || '').split(/\r?\n/).some((line) => {
            if (/^\s*endData/.test(line)) return true;
            const m = /^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?:,\s*(-?[\d.]+))?/.exec(line);
            if (m) pts.push({ x: +m[1], y: +m[2], speed: Math.min(1, Math.max(0.05, (m[3] == null ? 127 : +m[3]) / 127)) });
            return false;
          });
          return resamplePath(pts);
        },
        setPose(x, y, h) {
          ch.setPose(x, y, h / S.imu_scale);
          rw.correct_angle = h;
        },
        driveChassis: (l, r) => {
          if (ch.motion) ch.driveVolts(l, r);
          else {
            ch.rawPower('L', (l * 127) / 12);
            ch.rawPower('R', (r * 127) / 12);
          }
        },
        stopChassis: () => {
          ch.rawPower('L', 0);
          ch.rawPower('R', 0);
        },
        resetChassis: () => {},
        getInertialHeading: H,
        normalizeTarget: (a) => turnTarget(a, H(), 0),
        isMotionRunning: () => anyMotion(),
        cancelMotion: () => {
          rw.cancel = true;
        },
        async waitForMotion() {
          if (inAsync) return;
          while (anyMotion()) await ch.clock.sleep(TICK_MS);
        },
        async waitUntilTraveled(d) {
          while (anyMotion() && ch.robot.traveled - rw.motion_start_traveled < d) await ch.clock.sleep(TICK_MS);
        },
        async waitUntilTurned(a) {
          while (anyMotion() && Math.abs(H() - rw.motion_start_heading) < a) await ch.clock.sleep(TICK_MS);
        },
        async waitUntilNear(x, y, r) {
          while (anyMotion() && Math.hypot(x - ch.poseRad().x, y - ch.poseRad().y) > r) await ch.clock.sleep(TICK_MS);
        },
        async runAsync(fn) {
          if (inAsync) return fn(asyncApi);
          await api.waitForMotion();
          rw.asyncRunning = true;
          rw.motion_start_traveled = ch.robot.traveled;
          rw.motion_start_heading = H();
          Promise.resolve()
            .then(() => fn(asyncApi))
            .catch((e) => log('error', 'Error in runAsync: ' + (e && e.message ? e.message : e)))
            .then(() => (rw.asyncRunning = false));
        },
      };
      return api;
    }
    const asyncApi = build(true);
    const api = build(false);
    return { api, asyncApi, rw };
  }

  // =========================================================================================
  // Motors driven directly (PROS / VEXcode)
  // =========================================================================================

  const GEAR_RPM = { blue: 600, green: 200, red: 100 };

  /**
   * One drive motor or motor group. `side` 'L' | 'R'; `gearRpm` = the cartridge's free speed.
   * Positions are in motor degrees, from the sim's wheel travel and the drivetrain's wheel RPM.
   */
  function makeMotor(ch, name, side, gearRpm, clock, log) {
    let zero = 0;
    let velPct = 50;
    const robot = ch.robot;
    const wheelIn = () => (side === 'L' ? robot.sL : robot.sR);
    // motor degrees per inch of wheel travel
    const degPerIn = () => (360 / (Math.PI * robot.p.wheelDiameter)) * (gearRpm / robot.p.rpm);
    const pos = () => wheelIn() * degPerIn() - zero;
    const setPower = (cmd) => ch.rawPower(side, cmd);
    const goTo = (deg, speed) => ch.rawTarget(side, (deg + zero) / degPerIn(), speed);
    const toCmd = (v, unit) => {
      switch (unit) {
        case 'volt': return (v / 12) * 127;
        case 'rpm': return (v / gearRpm) * 127;
        case 'mV': return (v / 12000) * 127;
        default: return (v / 100) * 127; // percent
      }
    };
    const toDeg = (v, unit) => (unit === 'rev' ? v * 360 : v);
    const dirSign = (d) => (d === 'reverse' ? -1 : 1);
    const waitDone = async () => {
      while (ch.rawBusy(side)) await clock.sleep(TICK_MS);
    };
    const m = {
      __motor: true,
      // ---- PROS
      move: (v) => setPower(v),
      move_voltage: (mv) => setPower(toCmd(mv, 'mV')),
      move_velocity: (rpm) => setPower(toCmd(rpm, 'rpm')),
      brake: () => setPower(0),
      move_relative: (d, vel) => goTo(pos() + d, toCmd(vel == null ? gearRpm : vel, 'rpm')),
      move_absolute: (d, vel) => goTo(d, toCmd(vel == null ? gearRpm : vel, 'rpm')),
      get_position: () => pos(),
      get_positions: () => [pos()],
      get_position_all: () => [pos()],
      tare_position: () => (zero = wheelIn() * degPerIn()),
      tare_position_all: () => (zero = wheelIn() * degPerIn()),
      set_zero_position: (p) => (zero = wheelIn() * degPerIn() - (p || 0)),
      get_actual_velocity: () => ((side === 'L' ? robot.vL : robot.vR) / (Math.PI * robot.p.wheelDiameter)) * 60 * (gearRpm / robot.p.rpm),
      // ---- VEXcode
      spin(dir, v, unit) {
        if (v === undefined) setPower(dirSign(dir) * toCmd(velPct, 'pct'));
        else setPower(dirSign(dir) * toCmd(v, unit));
      },
      stop: () => setPower(0),
      setVelocity: (v, unit) => {
        velPct = unit === 'rpm' ? (v / gearRpm) * 100 : v;
      },
      async spinFor(...a) {
        // spinFor(dir, amount, unit, [vel, velUnit], [wait]) / spinFor(amount, unit, ...)
        let dir = 'fwd';
        if (a[0] === 'fwd' || a[0] === 'reverse') dir = a.shift();
        const [amount, unit] = a;
        let rest = a.slice(2);
        let vel = velPct;
        let velUnit = 'pct';
        if (typeof rest[0] === 'number') {
          vel = rest[0];
          velUnit = rest[1];
          rest = rest.slice(2);
        }
        const wait = rest[0] !== false;
        if (unit === 'msec' || unit === 'sec') {
          const ms = unit === 'sec' ? amount * 1000 : amount;
          setPower(dirSign(dir) * toCmd(vel, velUnit));
          const t0 = clock.now;
          const finish = () => setPower(0);
          if (!wait) {
            clock.sleep(ms).then(() => clock.now >= t0 + ms && finish());
            return true;
          }
          await clock.sleep(ms);
          finish();
          return true;
        }
        goTo(pos() + dirSign(dir) * toDeg(amount, unit), Math.abs(toCmd(vel, velUnit)));
        if (wait) await waitDone();
        return true;
      },
      async spinToPosition(p, unit, ...rest) {
        let vel = velPct;
        let velUnit = 'pct';
        if (typeof rest[0] === 'number') {
          vel = rest[0];
          velUnit = rest[1];
          rest = rest.slice(2);
        }
        goTo(toDeg(p, unit), Math.abs(toCmd(vel, velUnit)));
        if (rest[0] !== false) await waitDone();
        return true;
      },
      position: (unit) => (unit === 'rev' ? pos() / 360 : pos()),
      resetPosition: () => (zero = wheelIn() * degPerIn()),
      setPosition: (v, unit) => (zero = wheelIn() * degPerIn() - toDeg(v, unit)),
      velocity: (unit) => {
        const rpm = m.get_actual_velocity();
        return unit === 'rpm' ? rpm : (rpm / gearRpm) * 100;
      },
      isDone: () => !ch.rawBusy(side),
      isSpinning: () => ch.rawBusy(side),
    };
    m.rotateFor = m.spinFor;
    m.rotateTo = m.spinToPosition;
    m.startRotateFor = (...a) => m.spinFor(...a, false);
    // show drive commands in the run log (once per change, so loops do not flood it)
    let last = '';
    ['move', 'move_voltage', 'move_velocity', 'brake', 'move_relative', 'move_absolute', 'spin', 'stop', 'spinFor', 'spinToPosition', 'rotateFor', 'rotateTo'].forEach((k) => {
      const f = m[k];
      m[k] = (...a) => {
        const text = `${name}.${k}(${a.map((v) => (typeof v === 'number' ? fmt(v) : String(v))).join(', ')})`;
        if (log && text !== last && !ch.motion) log('motion', text);
        last = text;
        return f(...a);
      };
    });
    return m;
  }

  /** wrap a motor so any method it does not know (set_brake_mode, setStopping, ...) is a no-op */
  function motorProxy(m, NOOP) {
    return new Proxy(m, {
      get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : NOOP),
      set: () => true,
    });
  }

  Object.assign(NS, {
    JAR_DEFAULTS,
    makeJarApi,
    RW_DEFAULTS,
    RW_SETTING_NAMES,
    makeRwApi,
    pathFromPoints,
    makeMotor,
    motorProxy,
    GEAR_RPM,
  });
})();
