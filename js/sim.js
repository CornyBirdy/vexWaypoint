/*
 * Simulation core: differential-drive physics, a virtual clock, the scope that
 * user auton code runs in, and the run loop that records every tick so the UI
 * can play / scrub the result.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});
  const { TICK_MS, D2R, R2D, Chassis } = NS;

  const HALF_FIELD = 72;
  // a loop that does more than wait, on something the sim does not run, carries on after this long
  const DEFAULT_LOOP_WAIT_MS = 500;
  const SUBSTEPS = 4;

  // ---------------------------------------------------------------- virtual time

  class Clock {
    constructor() {
      this.now = 0; // ms of simulated time
      this.timers = [];
    }
    sleep(ms) {
      return new Promise((res) => this.timers.push({ t: this.now + Math.max(0, ms), res }));
    }
    wake() {
      const due = [];
      const keep = [];
      for (const t of this.timers) (t.t <= this.now ? due : keep).push(t);
      this.timers = keep;
      due.sort((a, b) => a.t - b.t).forEach((d) => d.res());
    }
  }

  /** resolves after every pending promise callback has run */
  const macro = (() => {
    // Node (tests): setImmediate. Browsers: a MessageChannel hop is much faster than setTimeout.
    if (typeof setImmediate === 'function') return () => new Promise((res) => setImmediate(res));
    const ch = new MessageChannel();
    const queue = [];
    ch.port1.onmessage = () => queue.shift()();
    return () =>
      new Promise((res) => {
        queue.push(res);
        ch.port2.postMessage(0);
      });
  })();

  const yieldToUi = () => new Promise((res) => setTimeout(res, 0));

  // ---------------------------------------------------------------- physics

  // ---------------------------------------------------------------- real-life error model

  const G = 386.09; // gravity, in / s^2
  const resolveContacts = (...a) => NS.resolveContacts(...a);
  const motorStep = (...a) => NS.motorStep(...a);
  const LAT_TAU = 0.015; // s: how fast the tyres kill sideways speed while they still have grip
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v, d) => (v !== null && v !== '' && isFinite(Number(v)) ? Number(v) : d);

  /** small seeded generator (mulberry32) so a seed always gives the same run */
  function makeRng(seed) {
    let a = (Math.floor(Number(seed) || 0) + 0x9e3779b9) >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next();
    next();
    return {
      next,
      /** standard normal (Box-Muller) */
      randn() {
        const u = Math.max(next(), 1e-12);
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
      },
    };
  }

  /**
   * The error model. The gyro numbers are fixed (typical V5 inertial sensor); everything about the floor
   * and the odometry comes from the chassis (js/chassis.js). Any of the numbers can still be passed in the
   * realism object to override what the chassis says (the tests do that).
   */
  const REAL_DEFAULTS = {
    seed: 1,
    gyroDrift: 0.2, // deg / min, 1 sigma of the sensor's bias (changes from run to run)
    gyroScale: 0.3, // %, 1 sigma of the turn-rate scale error
    gyroNoise: 0.03, // deg, 1 sigma of the reading noise
    trackScale: 0.2, // %, 1 sigma of a tracking wheel's size error (changes from run to run)
    grip: 0.8, // friction coefficient driving forwards / braking (0 = wheels never slip)
    gripVar: 5, // %, 1 sigma of how much the grip changes from run to run
    latGrip: 0.6, // friction coefficient sideways (0 = never slides)
    scrub: 1.05, // effective track width / measured track width
  };
  // a robot with perfect grip, for the contact physics when real-life error is off
  const IDEAL = { longLim: Infinity, latOn: false, latLim: 0, scrub: 1 };
  const NO_TRACKING = { vertical: { on: false, offset: 0 }, horizontal: { on: false, offset: 0 } };

  /** turns the settings into the numbers the physics uses; null = ideal robot */
  function resolveReal(o, p) {
    if (!o || !o.enabled) return null;
    const d = NS.deriveChassis ? NS.deriveChassis(o.chassis, p || {}) : null;
    const dflt = (k) => (d && k === 'gripVar' ? d.spread : d && d[k] != null ? d[k] : REAL_DEFAULTS[k]);
    const n = (k) => (isFinite(Number(o[k])) && o[k] !== null && o[k] !== '' ? Number(o[k]) : dflt(k));
    // the error size multiplier: 1 is typical, 2 a noticeably bad day (every random error twice as big and the
    // floor slipperier), 0.5 a good one
    const mul = clamp(num(o.mult, 1), 0.1, 5);
    const gripDiv = Math.max(0.4, 1 + 0.5 * (mul - 1));
    const rng = makeRng(n('seed'));
    const gripMul = clamp(1 + ((n('gripVar') * mul) / 100) * rng.randn(), 0.4, 1.6);
    const grip = Math.max(0, n('grip')) / gripDiv;
    const latGrip = Math.max(0, n('latGrip')) / gripDiv;
    const drift = Math.max(0, n('gyroDrift')) * mul;
    const tracking = o.tracking || (d && d.tracking) || NO_TRACKING;
    return {
      rng,
      seed: n('seed'),
      // drawn once per run, always in this order
      biasDegPerS: (drift / 60) * rng.randn(),
      scale: ((Math.max(0, n('gyroScale')) * mul) / 100) * rng.randn(),
      heading: o.heading || (d ? d.heading : 'imu'),
      trkScaleV: ((Math.max(0, n('trackScale')) * mul) / 100) * rng.randn(),
      trkScaleH: ((Math.max(0, n('trackScale')) * mul) / 100) * rng.randn(),
      tracking,
      // aligners grip the goal a little harder than average and vary from run to run: a small bias towards
      // NOT aligning, so autos are no more consistent than they are on a real field
      alignMu: clamp(1.08 + 0.12 * rng.randn(), 0.7, 1.6),
      walkDegPerSqrtS: (drift / 60) * 0.05, // the bias wanders a little during the run
      noiseRad: Math.max(0, n('gyroNoise')) * mul * D2R,
      mult: mul,
      longLim: grip > 0 ? grip * gripMul * G : Infinity, // max change of ground speed, in / s^2
      latLim: latGrip * gripMul * G,
      latOn: latGrip > 0,
      scrub: Math.max(1, n('scrub')),
      gripMul,
    };
  }

  // ---------------------------------------------------------------- physics

  class Robot {
    /**
     * @param {object} p  wheelDiameter(in) rpm speedPct trackWidth length width responseMs
     * @param {{x:number,y:number,h:number}} start field pose, h = compass degrees
     * @param {object} [realism] real-life error settings (see REAL_DEFAULTS); omitted = ideal robot
     *
     * The robot has two poses. x / y / h is where it really is. sx / sy / sh is what its odometry
     * thinks: wheel travel measured at the wheels (so wheel slip fools it) with the heading taken from
     * the gyro (so gyro drift fools it). The motion controllers only ever see the second one.
     */
    constructor(p, start, realism, world) {
      this.p = p;
      this.x = start.x;
      this.y = start.y;
      this.h = start.h * D2R;
      this.vL = 0;
      this.vR = 0;
      this.cmdL = 0;
      this.cmdR = 0;
      this.touching = false;
      this.real = resolveReal(realism, p);
      this.world = world || null; // solid goals + aligners (js/contact.js), or none
      if (this.world) this.world.muScale = this.real ? this.real.alignMu : 1;
      this.touchedGoals = new Set();
      // ground speed under each side of the drivetrain, and sideways speed of the body (in / s)
      this.uL = 0;
      this.uR = 0;
      this.bv = 0;
      // gyro
      const re = this.real;
      this.gyro = 0; // what the gyro has integrated (rad)
      this.gyroBias = re ? re.biasDegPerS * D2R : 0; // rad / s
      this.gyroNoise = 0;
      // statistics for the run log
      this.slipDist = 0; // inches the wheels turned without the robot moving with them
      this.maxSlide = 0; // fastest sideways slide, in / s
      this.resetOdometry();
    }
    /** odometry restarts at the real pose (setPose); the gyro itself keeps its drift */
    resetOdometry() {
      this.sx = this.x;
      this.sy = this.y;
      this.shOff = this.h - this.gyro - this.gyroNoise;
      this.sh = this.h;
    }
    /** max wheel surface speed in inches / second */
    get vmax() {
      const p = this.p;
      return ((p.rpm / 60) * Math.PI * p.wheelDiameter * p.speedPct) / 100;
    }
    step(ms) {
      const dt = ms / 1000 / SUBSTEPS;
      const p = this.p;
      const re = this.real;
      const alpha = 1 - Math.exp(-(dt * 1000) / Math.max(1, p.responseMs));
      if (re) {
        // the bias wanders and the reading is noisy; both are re-drawn once per 10 ms IMU sample
        this.gyroBias += re.walkDegPerSqrtS * D2R * Math.sqrt(ms / 1000) * re.rng.randn();
        this.gyroNoise = re.noiseRad * re.rng.randn();
      }
      const world = this.world;
      const mm = p.motorModel || null;
      for (let i = 0; i < SUBSTEPS; i++) {
        if (mm) {
          // motor model: the wheel speed follows from the motors' torque, the gearing, the weight and the rolling resistance
          this.vL = motorStep(this.vL, this.cmdL, dt, mm);
          this.vR = motorStep(this.vR, this.cmdR, dt, mm);
        } else {
          this.vL += ((this.cmdL / 127) * this.vmax - this.vL) * alpha;
          this.vR += ((this.cmdR / 127) * this.vmax - this.vR) * alpha;
        }
        if (!re && !world) {
          const v = (this.vL + this.vR) / 2;
          const w = (this.vL - this.vR) / p.trackWidth; // rad/s, clockwise positive
          const hm = this.h + (w * dt) / 2;
          this.x += Math.sin(hm) * v * dt;
          this.y += Math.cos(hm) * v * dt;
          this.h += w * dt;
          this.collideWalls();
          this.sx = this.x;
          this.sy = this.y;
          this.sh = this.h;
          continue;
        }

        // --- wheel slip. The wheels follow the motors; the ground only follows the wheels as far as
        // friction allows (wheelspin when accelerating too hard, a skid when braking too hard).
        const dyn = re || IDEAL;
        const x0 = this.x;
        const y0 = this.y;
        const h0 = this.h;
        const lim = dyn.longLim * dt;
        this.uL += clamp(this.vL - this.uL, -lim, lim);
        this.uR += clamp(this.vR - this.uR, -lim, lim);
        let u = (this.uL + this.uR) / 2;
        // turning scrubs the wheels sideways, so the robot turns a bit less than the wheels say
        const half = (p.trackWidth * dyn.scrub) / 2;
        let w = (this.uL - this.uR) / (2 * half);
        const dh = w * dt;
        if (dyn.latOn) {
          // a turning robot wants to keep going straight: that shows up as sideways speed in its own
          // frame, which the tyres remove as long as the sideways force stays under the friction limit
          this.bv -= u * dh;
          const maxCut = dyn.latLim * dt;
          this.bv -= clamp(this.bv * (1 - Math.exp(-dt / LAT_TAU)), -maxCut, maxCut);
          if (Math.abs(this.bv) > this.maxSlide) this.maxSlide = Math.abs(this.bv);
        } else this.bv = 0;
        this.slipDist += Math.abs((this.vL + this.vR) / 2 - u) * dt;
        const hm = this.h + dh / 2;
        this.x += (Math.sin(hm) * u + Math.cos(hm) * this.bv) * dt;
        this.y += (Math.cos(hm) * u - Math.sin(hm) * this.bv) * dt;
        this.h += dh;
        if (world) {
          // solid goals and walls: the robot (body + aligners) is stopped, slides along them and is turned by them
          const f = { x: Math.sin(this.h), y: Math.cos(this.h) };
          const r = { x: Math.cos(this.h), y: -Math.sin(this.h) };
          const pose = { x: this.x, y: this.y, h: this.h };
          const vel = { vx: u * f.x + this.bv * r.x, vy: u * f.y + this.bv * r.y, w };
          const touched = resolveContacts(pose, vel, world);
          this.x = pose.x;
          this.y = pose.y;
          this.touching = touched.wall || touched.goals.size > 0;
          touched.goals.forEach((g) => this.touchedGoals.add(g));
          u = vel.vx * f.x + vel.vy * f.y;
          this.bv = vel.vx * r.x + vel.vy * r.y;
          w = vel.w;
          this.uL = u + w * half;
          this.uR = u - w * half;
          // with perfect grip the wheels are what the ground sees: a blocked robot stalls its wheels
          if (!re) {
            this.vL = this.uL;
            this.vR = this.uR;
          }
        } else this.collideWalls();

        if (!re) {
          this.sx = this.x;
          this.sy = this.y;
          this.sh = this.h;
          continue;
        }

        // --- sensors: the gyro sees the real rotation (scale error + drift + noise), the encoders see
        // how far the wheels turned, not how far the robot moved
        // what the heading sensor adds this step: the IMU (scale error, drift), two forward tracking wheels
        // (the real rotation, tiny size error) or the drive encoders (they count wheelspin and scrub)
        const dhAct = this.h - h0; // the rotation that really happened (a contact can add some)
        const dth =
          re.heading === 'imu'
            ? dhAct * (1 + re.scale) + this.gyroBias * dt
            : re.heading === 'wheels'
              ? dhAct * (1 + re.trkScaleV)
              : ((this.vL - this.vR) / p.trackWidth) * dt;
        this.gyro += dth;
        const shNew = this.gyro + (re.heading === 'imu' ? this.gyroNoise : 0) + this.shOff;
        const shm = (this.sh + shNew) / 2;
        // forward travel: a free-rolling tracking wheel measures how far the robot really went (also when
        // it is held against a wall); without one the drive encoders are used, and they count wheelspin.
        // A wheel off the robot's centre also sees the robot turn, which the code removes using the gyro.
        const trk = re.tracking;
        const dx = this.x - x0;
        const dy = this.y - y0;
        const hmA = h0 + dhAct / 2;
        let dF = ((this.vL + this.vR) / 2) * dt;
        let dS = 0;
        if (trk.vertical.on) {
          const real = dx * Math.sin(hmA) + dy * Math.cos(hmA);
          dF = (real - dhAct * trk.vertical.offset) * (1 + re.trkScaleV) + dth * trk.vertical.offset;
        }
        if (trk.horizontal.on) {
          const real = dx * Math.cos(hmA) - dy * Math.sin(hmA);
          dS = (real + dhAct * trk.horizontal.offset) * (1 + re.trkScaleH) - dth * trk.horizontal.offset;
        }
        this.sx += Math.sin(shm) * dF + Math.cos(shm) * dS;
        this.sy += Math.cos(shm) * dF - Math.sin(shm) * dS;
        this.sh = shNew;
      }
    }
    collideWalls() {
      const L = this.p.length / 2;
      const W = this.p.width / 2;
      const s = Math.abs(Math.sin(this.h));
      const c = Math.abs(Math.cos(this.h));
      const ex = L * s + W * c;
      const ey = L * c + W * s;
      const lx = HALF_FIELD - ex;
      const ly = HALF_FIELD - ey;
      const nx = Math.min(lx, Math.max(-lx, this.x));
      const ny = Math.min(ly, Math.max(-ly, this.y));
      this.touching = nx !== this.x || ny !== this.y;
      this.x = nx;
      this.y = ny;
    }
  }

  // ---------------------------------------------------------------- user-code scope

  /** a value that swallows every call / property access (for intake, lift, ...) */
  function makeNoop() {
    const fn = function () {};
    const proxy = new Proxy(fn, {
      get(_t, k) {
        if (k === 'then') return undefined;
        if (k === Symbol.toPrimitive) return () => 0;
        if (k === Symbol.iterator) return undefined;
        return proxy;
      },
      apply() {
        return proxy;
      },
      set() {
        return true;
      },
    });
    return proxy;
  }

  function poseCtor(x = 0, y = 0, theta = 0) {
    return {
      x,
      y,
      theta,
      distance: (o) => Math.hypot(o.x - x, o.y - y),
      angle: (o) => Math.atan2(o.y - y, o.x - x),
      lerp: (o, t) => poseCtor(x + (o.x - x) * t, y + (o.y - y) * t, theta),
      rotate: (a) => poseCtor(x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), theta),
    };
  }

  // lemlib utility functions (docs: API > Utils), so code that calls them keeps working
  const wrapAngle = (a, max) => a - max * Math.round(a / max);
  const lemUtils = {
    sanitizeAngle: (a, radians = true) => {
      const full = radians ? 2 * Math.PI : 360;
      return ((a % full) + full) % full;
    },
    angleError: (target, position, radians = true, direction = 'AUTO') => {
      const full = radians ? 2 * Math.PI : 360;
      const e = wrapAngle(target - position, full);
      if (direction === 'CW_CLOCKWISE') return e < 0 ? e + full : e;
      if (direction === 'CCW_COUNTERCLOCKWISE') return e > 0 ? e - full : e;
      return e;
    },
    avg: (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0),
    ema: (cur, prev, smooth) => cur * smooth + prev * (1 - smooth),
    slew: (target, current, maxChange) => (maxChange ? current + Math.min(maxChange, Math.max(-maxChange, target - current)) : target),
    // signed curvature of the circle tangent to pose's heading through `other` (theta in radians, standard form)
    getCurvature: (pose, other) => {
      const side = Math.sin(pose.theta) * (other.x - pose.x) - Math.cos(pose.theta) * (other.y - pose.y) < 0 ? -1 : 1;
      const a = -Math.tan(pose.theta);
      const c = Math.tan(pose.theta) * pose.x - pose.y;
      const x = Math.abs(a * other.x + other.y + c) / Math.sqrt(a * a + 1);
      const d = Math.hypot(other.x - pose.x, other.y - pose.y);
      return d === 0 ? 0 : side * ((2 * x) / (d * d));
    },
  };

  /** printf("%d ms, %.1f in", a, b): the format codes are filled in; without a format the arguments are joined */
  function formatPrintf(args) {
    const fmt = args[0];
    if (typeof fmt !== 'string' || !/%/.test(fmt)) return args.join(' ');
    let i = 1;
    return fmt.replace(/%(-?\d*)(?:\.(\d+))?(?:l|ll|h|z)?([dioufFeEgGsc%])/g, (all, width, prec, conv) => {
      if (conv === '%') return '%';
      const v = args[i++];
      let out;
      if (conv === 's' || conv === 'c') out = String(v);
      else if (conv === 'd' || conv === 'i' || conv === 'u' || conv === 'o') out = String(Math.trunc(Number(v)));
      else if (/[fF]/.test(conv)) out = Number(v).toFixed(prec === undefined ? 6 : +prec);
      else out = String(Number(v));
      return width ? out.padStart(Math.abs(+width)) : out;
    });
  }

  /** lemlib::PID (user-facing): integral resets on a sign flip only when signFlipReset is true */
  function makePid(kP, kI, kD, windupRange = 0, signFlipReset = false) {
    const pid = { kP, kI, kD, windupRange, signFlipReset, integral: 0, prevError: 0 };
    pid.update = (error) => {
      pid.integral += error;
      if (pid.signFlipReset && (error < 0) !== (pid.prevError < 0)) pid.integral = 0;
      if (pid.windupRange !== 0 && Math.abs(error) > pid.windupRange) pid.integral = 0;
      const derivative = error - pid.prevError;
      pid.prevError = error;
      return error * pid.kP + pid.integral * pid.kI + derivative * pid.kD;
    };
    pid.reset = () => {
      pid.integral = 0;
      pid.prevError = 0;
    };
    return pid;
  }

  /** lemlib::Timer on the simulated clock (ms); counts down from the time it was set */
  function makeTimer(clock, time = 0) {
    let set = time;
    let started = clock.now;
    let pausedLeft = null;
    const left = () => (pausedLeft !== null ? pausedLeft : Math.max(0, set - (clock.now - started)));
    const t = {
      getTimeSet: () => set,
      getTimeLeft: left,
      getTimePassed: () => set - left(),
      isDone: () => left() <= 0,
      isPaused: () => pausedLeft !== null,
      set: (ms) => {
        set = ms;
        started = clock.now;
        pausedLeft = null;
      },
      reset: () => {
        started = clock.now;
        pausedLeft = null;
      },
      pause: () => {
        if (pausedLeft === null) pausedLeft = left();
      },
      resume: () => {
        if (pausedLeft !== null) {
          set = pausedLeft;
          started = clock.now;
          pausedLeft = null;
        }
      },
      waitUntilDone: () => clock.sleep(left()),
    };
    return t;
  }

  /**
   * @param {Chassis} ch
   * @param {Clock} clock
   * @param {object} pathLib  id -> {name, getPoints(): [{x,y,v}] in inches, file frame}
   * @param {string[]} chassisNames
   */
  function buildScope(ch, clock, pathLib, chassisNames, log, opts) {
    const NOOP = makeNoop();
    // functions called by name that are not defined anywhere in the pasted code (e.g. resetAtGoalA())
    const unknownCalls = new Set();
    const unknownFns = new Map();
    const unknownFn = (name) => {
      let f = unknownFns.get(name);
      if (!f) {
        f = new Proxy(function () {}, {
          get: (_t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => 0 : NOOP),
          apply: (_t, _this, args) => {
            // say so where it happens: a helper that moves the robot but is not pasted makes the run look wrong
            if (!unknownCalls.has(name) && !/^(printf|print|lcd|puts)$/.test(name)) {
              const shown = args.map((a) => (typeof a === 'number' ? +a.toFixed(2) : typeof a === 'string' ? JSON.stringify(a) : '...')).join(', ');
              log('warn', `${name}(${shown}) is not defined in your code, so it was skipped (the robot does not move for it)`);
            }
            unknownCalls.add(name);
            return NOOP;
          },
          set: () => true,
        });
        unknownFns.set(name, f);
      }
      return f;
    };
    const warnedLoops = new Set();
    const stuckMs = opts && opts.mechanismWaitMs != null ? opts.mechanismWaitMs : 0;
    const def = (v, d) => (v === undefined || v === null ? d : v);
    const num = (v) => (isFinite(Number(v)) ? Number(v) : 0);
    let poseDeclared = false;
    // LemLib's docs: "don't attempt to turn the chassis to points within 10 inches of the chassis"
    const nearPoint = (name, x, y) => {
      const p = ch.getPose();
      const d = Math.hypot(x - p.x, y - p.y);
      if (isFinite(d) && d < 10) log('warn', `${name}(${+x.toFixed(1)}, ${+y.toFixed(1)}) is only ${d.toFixed(1)} in from the robot; LemLib advises against turning to points within 10 in (the heading is unstable that close)`);
    };
    // loops that really wait on time or on the drivetrain
    const realWait = new RegExp('millis|isInMotion|waitUntil|getPose|Pose|odom|\\b(?:' + chassisNames.map((n) => n.replace(/\W/g, '')).join('|') + ')\\b');

    const api = {
      // setPose(x, y, theta[, radians]) or setPose(Pose[, radians]) or setPose({x, y, theta}); theta is a compass heading
      setPose: (x, y, theta, radians) => {
        const obj = x !== null && typeof x === 'object';
        const q = obj ? (Array.isArray(x) ? { x: x[0], y: x[1], theta: x[2] } : x) : { x, y, theta };
        let th = Number(q.theta);
        if (obj ? y : radians) th *= R2D;
        const px = Number(q.x);
        const py = Number(q.y);
        if (![px, py, th].every(isFinite)) throw new Error('setPose(): x, y and theta must be numbers');
        // the first setPose before the robot has moved says where it starts
        if (opts && opts.placeRobot && !poseDeclared && ch.motionCount === 0) opts.placeRobot(px, py, th);
        poseDeclared = true;
        ch.setPose(px, py, th);
      },
      // getPose([radians[, standardPos]]): compass degrees unless asked otherwise
      getPose: (radians, standard) => {
        const p = ch.getPose();
        let th = p.theta;
        if (standard) th = 90 - th;
        if (radians) th *= D2R;
        return { x: p.x, y: p.y, theta: th, heading: th };
      },
      calibrate: () => {},
      resetLocalPosition: () => ch.resetLocalPosition(),
      setBrakeMode: () => {},
      moveToPoint: (x, y, timeout, params, a) => ch.moveToPoint(x, y, def(timeout, 10000), params, def(a, true)),
      moveToPose: (x, y, th, timeout, params, a) => ch.moveToPose(x, y, th, def(timeout, 10000), params, def(a, true)),
      turnToHeading: (th, timeout, params, a) => ch.turnToHeading(th, def(timeout, 10000), params, def(a, true)),
      turnToPoint: (x, y, timeout, params, a) => {
        nearPoint('turnToPoint', x, y);
        return ch.turnToPoint(x, y, def(timeout, 10000), params, def(a, true));
      },
      swingToHeading: (th, side, timeout, params, a) =>
        ch.swingToHeading(th, side, def(timeout, 10000), params, def(a, true)),
      swingToPoint: (x, y, side, timeout, params, a) => {
        nearPoint('swingToPoint', x, y);
        return ch.swingToPoint(x, y, side, def(timeout, 10000), params, def(a, true));
      },
      follow: (path, lookahead, timeout, forwards, a) => {
        if (!path || !path.__path) throw new Error('follow(): first argument is not a loaded path file');
        const { pts, endIdx } = path.getPath(ch);
        return ch.follow(pts, endIdx, path.name, def(lookahead, 15), def(timeout, 10000), def(forwards, true), def(a, true));
      },
      waitUntil: (d) => ch.waitUntil(d),
      waitUntilDone: () => ch.waitUntilDone(),
      cancelMotion: () => ch.cancelMotion(),
      cancelAllMotions: () => ch.cancelAllMotions(),
      isInMotion: () => ch.isInMotion(),
      // open loop driving (what a helper like backUp() or driveToGoal() usually does): -127..127 per side
      tank: (l, r) => ch.openLoop(num(l), num(r)),
      arcade: (throttle, turn) => ch.openLoop(num(throttle) + num(turn), num(throttle) - num(turn)),
      curvature: (throttle, turn) => {
        // LemLib's curvature drive turns the robot in proportion to its speed; close enough: steer by the same ratio
        const t = num(throttle);
        const k = num(turn) / 127;
        ch.openLoop(t * (1 + k), t * (1 - k));
      },
    };
    // motion calls numbered by the translator (`moveToPoint__S3`) know which call in the code they are: the
    // auto-tuner can swap that call's timeout (opts.siteTimeouts) or every timeout (opts.timeoutOverride)
    const TIMEOUT_ARG = { moveToPoint: 2, moveToPose: 3, turnToHeading: 1, turnToPoint: 2, swingToHeading: 2, swingToPoint: 3, follow: 2 };
    const siteCall = (method, id) => (...args) => {
      const at = TIMEOUT_ARG[method];
      if (opts && opts.siteTimeouts && opts.siteTimeouts[id] != null) args[at] = opts.siteTimeouts[id];
      else if (opts && opts.timeoutOverride != null) args[at] = opts.timeoutOverride;
      ch.nextSite = id;
      try {
        return api[method](...args);
      } finally {
        ch.nextSite = null;
      }
    };
    // anything else on chassis (e.g. setBrakeMode variants) is ignored
    const chassisObj = new Proxy(api, {
      get: (t, k) => {
        if (typeof k === 'string') {
          const m = /^(\w+)__S(\d+)$/.exec(k);
          if (m && TIMEOUT_ARG[m[1]] !== undefined && m[1] in t) return siteCall(m[1], +m[2]);
        }
        return k in t ? t[k] : k === 'then' ? undefined : NOOP;
      },
    });

    const scope = {
      NOOP,
      Pose: poseCtor,
      delay: (ms) => clock.sleep(ms),
      millis: () => clock.now,
      // `while (cond) {...}` waiting on something that is not simulated (lift, claw): give up after a while
      __loopStart: (cond, waitOnly) => ({ t0: clock.now, cond, waitOnly: !!waitOnly, warned: false }),
      __stuck: (w) => {
        if (realWait.test(w.cond)) return false; // real waits on time / the drivetrain
        // a loop that only waits (`while (liftBusy) { delay(20); }`) is waiting on something the sim does
        // not run, so with the default setting (0) it is treated as already finished and costs no time
        const instant = stuckMs === 0 && w.waitOnly;
        const ms = stuckMs > 0 ? stuckMs : DEFAULT_LOOP_WAIT_MS;
        if (!instant) {
          if (ch.motion) {
            w.t0 = clock.now;
            return false;
          }
          if (clock.now - w.t0 < ms) return false;
        }
        if (!warnedLoops.has(w.cond)) {
          warnedLoops.add(w.cond);
          log('info', `while (${w.cond}) waits on something the sim does not run (lift, claw...)` + (instant ? ', so it counts as already done and adds no delay' : `; carried on after ${ms} ms each time`));
        }
        return true;
      },
      __guard: (() => {
        let n = 0;
        let lastT = -1;
        return () => {
          if (clock.now !== lastT) {
            lastT = clock.now;
            n = 0;
          } else if (++n > 200000) throw new Error('A while-loop is spinning without a delay() - add pros::delay(10)');
        };
      })(),
      printf: (...a) => log('print', formatPrintf(a)),
      ...lemUtils,
      Timer: (ms) => makeTimer(clock, ms),
      PID: makePid,
      M_PI: Math.PI,
      degToRad: (d) => d * D2R,
      radToDeg: (r) => r * R2D,
      abs: Math.abs, fabs: Math.abs, sqrt: Math.sqrt, pow: Math.pow, sin: Math.sin, cos: Math.cos, tan: Math.tan,
      atan: Math.atan, atan2: Math.atan2, floor: Math.floor, ceil: Math.ceil, round: Math.round,
      min: Math.min, max: Math.max, fmin: Math.min, fmax: Math.max, hypot: Math.hypot,
      Math, Number, String, Boolean, Array, Object, JSON, Infinity, NaN, undefined,
      // LemLib enums
      DriveSide: { LEFT: 'LEFT', RIGHT: 'RIGHT' },
      AngularDirection: { AUTO: 'AUTO', CW_CLOCKWISE: 'CW_CLOCKWISE', CCW_COUNTERCLOCKWISE: 'CCW_COUNTERCLOCKWISE' },
      AUTO: 'AUTO', CW_CLOCKWISE: 'CW_CLOCKWISE', CCW_COUNTERCLOCKWISE: 'CCW_COUNTERCLOCKWISE',
      LEFT: 'LEFT', RIGHT: 'RIGHT',
    };
    chassisNames.forEach((n) => (scope[n] = chassisObj));
    Object.keys(pathLib).forEach((id) => (scope[id] = pathLib[id]));
    // the drivetrain's motor groups (`leftMotors.move(-60)`): open-loop commands, like chassis.tank()
    const groups = (opts && opts.motorGroups) || null;
    if (groups) {
      const cart = (opts && opts.cartridge) || 600; // rpm of the cartridge, for move_velocity()
      const mg = (side) => {
        const set = (v) => ch.openLoop(side === 'left' ? num(v) : null, side === 'right' ? num(v) : null);
        const obj = {
          move: set, // -127..127
          move_voltage: (mv) => set((num(mv) / 12000) * 127),
          move_velocity: (rpm) => set((num(rpm) / cart) * 127),
          brake: () => set(0),
          stop: () => set(0),
        };
        return new Proxy(obj, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : NOOP) });
      };
      if (groups.left) scope[groups.left] = mg('left');
      if (groups.right) scope[groups.right] = mg('right');
    }

    scope.__unknownCalls = unknownCalls;
    return new Proxy(scope, {
      has: (_t, k) => typeof k === 'string' && k !== '__scope',
      get: (t, k) => {
        if (k === Symbol.unscopables) return undefined;
        if (k in t) return t[k];
        if (typeof k === 'string' && k in globalThis && /^[A-Z]/.test(k)) return globalThis[k];
        return typeof k === 'string' ? unknownFn(k) : NOOP;
      },
      set: (t, k, v) => {
        t[k] = v;
        return true;
      },
    });
  }

  // ---------------------------------------------------------------- run

  /**
   * Run the user's code to completion in simulated time.
   *
   * @param {object} o
   *   js              translated JavaScript body
   *   robot           {wheelDiameter, rpm, speedPct, trackWidth, length, width, responseMs}
   *   start           {x, y, h}  field pose
   *   cfg             {lateral, angular, trackWidth, horizontalDrift, pathMode}
   *   realism         optional {enabled, seed, chassis, ...} (see resolveReal)
   *   world           optional {goals: {tall, short, alliance base sizes}, aligners: {front, back}}: solid goals,
   *                   walls and aligners (js/contact.js, js/aligners.js); without it the robot only meets the walls
   *   paths           [{ids:[...], name, points:[{x,y,v}] (inches, file frame)}]
   *   startFromSetPose  true: a setPose() before the first motion places the robot there
   *   maxMs           hard stop for the simulation
   *   onProgress(ms)  optional
   */
  async function runSimulation(o) {
    const clock = new Clock();
    const world = makeRunWorld(o);
    // motors + weight: work out the real-life speed and response instead of using the typed-in numbers
    let robotP = o.robot;
    if (robotP.motor && robotP.motor.auto !== false && NS.motorModel) {
      const mm = NS.motorModel(robotP, o.realism && o.realism.chassis);
      robotP = { ...robotP, speedPct: mm.speedPct, responseMs: mm.respMs, motorModel: mm };
    }
    const robot = new Robot(robotP, o.start, o.realism, world);
    const events = [];
    const motions = [];
    const log = (kind, text) => events.push({ t: clock.now, kind, text });

    const ch = new Chassis(robot, clock, o.cfg, o.start, {
      motionStart(m) {
        motions.push({ id: m.id, label: m.label, site: m.site, firstContact: null, alignedAt: null, t0: clock.now, t1: null, reason: '', follow: m.name === 'follow' ? m.pts.map((p) => ch.codeToField(p.x, p.y)) : null });
        log('motion', m.label);
      },
      motionEnd(m) {
        const rec = motions[m.id];
        if (rec) {
          rec.t1 = clock.now;
          rec.reason = m.reason;
        }
        const ms = clock.now - m.t0;
        const err = m.errorText();
        log(m.reason === 'timeout' ? 'warn' : 'done', `  ${m.name} ${m.reason} after ${ms} ms${err ? ' (' + err + ')' : ''}`);
      },
    });
    ch.pathMode = o.cfg.pathMode || 'field';

    // path library visible to the user's code
    const lib = {};
    (o.paths || []).forEach((p) => {
      const obj = {
        __path: true,
        name: p.name,
        /** points in the code frame, speeds as motor commands, with a ghost tail for stopping */
        getPath(chassis) {
          const robot = chassis.robot;
          const src = p.points.map((q) => ({ x: q.x, y: q.y, v: q.v }));
          let endIdx = Math.min(src.length - 1, p.endIdx == null ? src.length - 1 : p.endIdx);
          if (!p.ghost || endIdx >= src.length - 1) {
            // LemLib paths end with a ghost point ahead of the real end; add one if the file has none
            const e = src[endIdx];
            let q = null;
            for (let i = endIdx - 1; i >= 0; i--) {
              if (Math.hypot(e.x - src[i].x, e.y - src[i].y) > 0.01) {
                q = src[i];
                break;
              }
            }
            if (q) {
              const d = Math.hypot(e.x - q.x, e.y - q.y);
              src.splice(endIdx + 1, src.length, { x: e.x + ((e.x - q.x) / d) * 20, y: e.y + ((e.y - q.y) / d) * 20, v: 0 });
            }
          }
          const toCmd = (v) => {
            switch (p.speedUnit) {
              case 'cmd255': return (v / 255) * 127;
              case 'mps': return Math.min(127, ((v * 39.3701) / robot.vmax) * 127);
              case 'rpm': return Math.min(127, (v / robot.p.rpm) * 127);
              default: return v;
            }
          };
          // paths drawn in the editor live on the field, so "code frame" does not apply to them
          const mode = p.forceField && chassis.pathMode === 'code' ? 'field' : chassis.pathMode;
          let shift = { x: 0, y: 0 };
          if (mode === 'relative') shift = { x: robot.sx - src[0].x, y: robot.sy - src[0].y };
          const pts = src.map((q) => {
            const v = toCmd(q.v);
            if (mode === 'code') return { x: q.x, y: q.y, v };
            const c = chassis.fieldToCode(q.x + shift.x, q.y + shift.y);
            return { x: c.x, y: c.y, v };
          });
          return { pts, endIdx };
        },
      };
      p.ids.forEach((id) => (lib[id] = obj));
    });

    const names = o.chassisNames && o.chassisNames.length ? o.chassisNames : ['chassis'];
    let placed = null;
    const scope = buildScope(ch, clock, lib, names, log, {
      mechanismWaitMs: o.mechanismWaitMs,
      motorGroups: o.motorGroups,
      cartridge: o.robot && o.robot.motor ? o.robot.motor.cartridge : 600,
      siteTimeouts: o.siteTimeouts,
      timeoutOverride: o.timeoutOverride,
      // setPose() at the start of the code places the robot there (field coordinates, compass heading)
      placeRobot: o.startFromSetPose
        ? (x, y, th) => {
            robot.x = x;
            robot.y = y;
            robot.h = th * D2R;
            robot.collideWalls();
            robot.touching = false;
            robot.resetOdometry();
            placed = { x: robot.x, y: robot.y, h: th };
            const moved = Math.hypot(robot.x - o.start.x, robot.y - o.start.y) > 0.01 || Math.abs(((((th - o.start.h) % 360) + 540) % 360) - 180) > 0.01;
            if (moved) log('info', `setPose(${+x.toFixed(2)}, ${+y.toFixed(2)}, ${+th.toFixed(2)}) at the start: the robot starts there`);
          }
        : null,
    });

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    let fn;
    try {
      fn = new AsyncFunction('__scope', 'with (__scope) {\n' + o.js + '\n}');
    } catch (e) {
      const hint = NS.diagnoseJs ? NS.diagnoseJs(o.js) : [];
      const text = 'Could not parse the code: ' + e.message + (hint.length ? '\n  possibly near (translated): ' + hint.join('\n  ') : '');
      return { frames: null, events: [{ t: 0, kind: 'error', text }], motions: [], durationMs: 0, error: e };
    }

    // recorded trajectory (one entry per tick, parallel arrays)
    const F = { t: [], x: [], y: [], h: [], vl: [], vr: [], mi: [], ax: [], ay: [], hit: [], cx: [], cy: [], ct: [], ox: [], oy: [], oh: [], alF: [], alB: [] };
    const record = () => {
      F.t.push(clock.now);
      F.x.push(robot.x);
      F.y.push(robot.y);
      F.h.push(robot.h * R2D);
      F.vl.push(robot.vL);
      F.vr.push(robot.vR);
      F.mi.push(ch.motion ? ch.motion.id : -1);
      if (ch.aim) {
        const a = ch.codeToField(ch.aim.x, ch.aim.y);
        F.ax.push(a.x);
        F.ay.push(a.y);
      } else {
        F.ax.push(NaN);
        F.ay.push(NaN);
      }
      F.hit.push(robot.touching ? 1 : 0);
      const cp = ch.getPose();
      F.cx.push(cp.x);
      F.cy.push(cp.y);
      F.ct.push(cp.theta);
      // where the odometry thinks the robot is, on the field (equal to x / y / h for an ideal robot)
      F.ox.push(robot.sx);
      F.oy.push(robot.sy);
      F.oh.push(robot.sh * R2D);
      F.alF.push(align.front ? align.front.now : -1);
      F.alB.push(align.back ? align.back.now : -1);
    };
    const align = makeAlignTracking(world, robot, log, () => clock.now, () => {
      const rec = ch.motion && motions[ch.motion.id];
      if (rec && rec.alignedAt == null) rec.alignedAt = clock.now; // first time an aligner caught a goal
    });

    let codeDone = false;
    let error = null;
    fn(scope).then(
      () => (codeDone = true),
      (e) => {
        codeDone = true;
        error = e;
        log('error', 'Error: ' + (e && e.message ? e.message : e));
      }
    );

    record();
    let ticks = 0;
    for (;;) {
      clock.wake();
      await macro();
      if (codeDone && !ch.motion) break;
      if (clock.now >= o.maxMs) {
        log('warn', `Stopped: simulation ran for ${o.maxMs / 1000} s without finishing`);
        break;
      }
      ch.step();
      robot.step(TICK_MS);
      clock.now += TICK_MS;
      if (ch.motion && robot.touching) {
        const rec = motions[ch.motion.id];
        if (rec && rec.firstContact == null) rec.firstContact = clock.now; // first time it hit a wall or a goal
      }
      align.update();
      record();
      if (++ticks % 400 === 0) {
        if (o.onProgress) o.onProgress(clock.now);
        await yieldToUi();
      }
    }
    if (!error) log('info', `Auton code finished at ${(clock.now / 1000).toFixed(2)} s`);
    const alignResult = align.finish();
    const stats = robot.real ? realStats(robot, F) : null;
    if (stats) {
      log('info', `Real-life error (seed ${robot.real.seed}): odometry ends ${stats.endPosErr.toFixed(1)} in and ${stats.endHeadErr.toFixed(1)}\u00b0 off the real robot (worst ${stats.maxPosErr.toFixed(1)} in, ${stats.maxHeadErr.toFixed(1)}\u00b0).`);
      const heading = robot.real.heading === 'imu' ? `gyro: ${(robot.real.biasDegPerS * 60).toFixed(2)}\u00b0/min drift, ${(robot.real.scale * 100).toFixed(2)}% turn-rate error` : `heading from ${robot.real.heading === 'wheels' ? 'two forward tracking wheels' : 'the drive wheel encoders'}`;
      log('info', `  ${heading}.  wheels: ${stats.slipDist.toFixed(1)} in of slip, fastest sideways slide ${stats.maxSlide.toFixed(1)} in/s, grip x${robot.real.gripMul.toFixed(2)}.`);
    }
    const missing = Array.from(scope.__unknownCalls || []).filter((n) => !/^(printf|print|lcd|puts)$/.test(n));
    if (missing.length) log('info', `Not defined in your code, so skipped: ${missing.map((n) => n + '()').join(', ')}. If one moves the robot, paste its definition too.`);

    return { frames: F, events, motions, durationMs: clock.now, error, vmax: robot.vmax, realism: stats, startFromCode: placed, align: alignResult };
  }

  // ---------------------------------------------------------------- solid goals, aligners

  /** the contact world for a run (js/contact.js), or null when the run has none */
  function makeRunWorld(o) {
    if (!o.world || !NS.makeWorld) return null;
    const capsules = [];
    const cuts = {};
    const al = NS.sanitizeAligners ? NS.sanitizeAligners(o.world.aligners) : {};
    const L = o.robot.length;
    Object.keys(al).forEach((side) => {
      const set = al[side];
      if (!set.on || !set.shapes.length) return;
      const mu = NS.MATERIALS[set.material].mu;
      NS.alignerSegments(set).forEach((g) => capsules.push({ ...g, r: set.thickness / 2, mu, set: side }));
      // the aligner is the front (back) of the chassis: the body ends at its rear-most point
      const pts = [];
      set.shapes.forEach((s) => NS.shapePolyline(s, 0.05).forEach((p) => pts.push(p)));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      if (side === 'front') {
        const y = Math.max(0, Math.min(L / 2, Math.min(...ys)));
        if (y < L / 2 - 0.01) cuts.front = { y, x0: Math.min(...xs), x1: Math.max(...xs) };
      } else {
        const y = Math.min(0, Math.max(-L / 2, Math.max(...ys)));
        if (y > -L / 2 + 0.01) cuts.back = { y, x0: Math.min(...xs), x1: Math.max(...xs) };
      }
    });
    const world = NS.makeWorld({ half: o.world.half, goals: NS.buildGoals(o.world.goals), body: { length: o.robot.length, width: o.robot.width }, capsules, cuts });
    world.aligners = al;
    return world;
  }

  /**
   * "Aligned" = any surface of a goal is within `tol` inches of the aligner's alignment point (the middle
   * back point of the aligner). With real-life error on the allowance is 5% smaller, a small bias towards not
   * aligning. Logs the moment a goal becomes aligned and sums up at the end.
   */
  function makeAlignTracking(world, robot, log, now, onAligned) {
    const out = { front: null, back: null };
    if (!world || !world.aligners) return { ...out, update() {}, finish: () => null };
    const bias = robot.real ? 0.95 : 1;
    const sets = {};
    ['front', 'back'].forEach((side) => {
      const set = world.aligners[side];
      if (!set || !set.on || !set.shapes.length) return;
      const pt = NS.alignerPoint(set, side);
      sets[side] = { side, pt, tol: set.tol * bias, rawTol: set.tol, now: -1, ever: null, closest: { d: Infinity, goal: null } };
      out[side] = sets[side];
    });
    const label = (g) => `${g.team} ${g.kind} goal at (${g.x}, ${g.y})`;
    return {
      ...out,
      update() {
        const c = Math.cos(robot.h);
        const s = Math.sin(robot.h);
        Object.values(sets).forEach((st) => {
          const wp = { x: robot.x + st.pt.x * c + st.pt.y * s, y: robot.y - st.pt.x * s + st.pt.y * c };
          let best = { d: Infinity, goal: null };
          for (const g of world.goals) {
            if (Math.hypot(g.x - wp.x, g.y - wp.y) > g.R + st.tol + 2) continue;
            const d = NS.distanceToPolygon(wp, g.poly);
            if (d < best.d) best = { d, goal: g };
          }
          if (best.goal && best.d < st.closest.d) st.closest = best;
          const idx = best.goal && best.d <= st.tol ? best.goal.index : -1;
          if (idx !== st.now) {
            if (idx >= 0 && (!st.ever || st.ever.goal.index !== idx)) {
              st.ever = { goal: best.goal, d: best.d, t: now() };
              if (onAligned) onAligned(st.side, best.goal.index);
              log('info', `${st.side} aligner aligned with the ${label(best.goal)} (${best.d.toFixed(2)} in from the alignment point)`);
            }
            st.now = idx;
          }
        });
      },
      finish() {
        const res = {};
        Object.values(sets).forEach((st) => {
          res[st.side] = st.ever
            ? { aligned: true, goal: st.ever.goal.index, dist: st.ever.d, t: st.ever.t, still: st.now >= 0 }
            : { aligned: false, goal: st.closest.goal ? st.closest.goal.index : null, dist: st.closest.d };
          if (!st.ever && st.closest.goal) {
            log('warn', `${st.side} aligner never aligned: closest was the ${label(st.closest.goal)}, ${st.closest.d.toFixed(2)} in from the alignment point (needs ${st.rawTol} in${robot.real ? ', a bit less with real-life error on' : ''}).`);
          }
        });
        return res;
      },
    };
  }

  /** how far the odometry ended up from the real robot, for the run log */
  function realStats(robot, F) {
    const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
    let maxPos = 0;
    let maxHead = 0;
    for (let i = 0; i < F.t.length; i++) {
      maxPos = Math.max(maxPos, Math.hypot(F.ox[i] - F.x[i], F.oy[i] - F.y[i]));
      maxHead = Math.max(maxHead, Math.abs(wrap(F.oh[i] - F.h[i])));
    }
    const n = F.t.length - 1;
    return {
      endPosErr: Math.hypot(F.ox[n] - F.x[n], F.oy[n] - F.y[n]),
      endHeadErr: Math.abs(wrap(F.oh[n] - F.h[n])),
      maxPosErr: maxPos,
      maxHeadErr: maxHead,
      slipDist: robot.slipDist,
      maxSlide: robot.maxSlide,
    };
  }

  Object.assign(NS, { runSimulation, Robot, Clock, REAL_DEFAULTS });
})();
