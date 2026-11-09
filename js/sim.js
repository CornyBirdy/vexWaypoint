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

  class Robot {
    /**
     * @param {object} p  wheelDiameter(in) rpm speedPct trackWidth length width responseMs
     * @param {{x:number,y:number,h:number}} start field pose, h = compass degrees
     */
    constructor(p, start) {
      this.p = p;
      this.x = start.x;
      this.y = start.y;
      this.h = start.h * D2R;
      this.vL = 0;
      this.vR = 0;
      this.cmdL = 0;
      this.cmdR = 0;
      this.touching = false;
      this.sL = 0; // wheel travel (inches, like a drive encoder)
      this.sR = 0;
      this.traveled = 0; // path length driven (inches)
    }
    /** max wheel surface speed in inches / second */
    get vmax() {
      const p = this.p;
      return ((p.rpm / 60) * Math.PI * p.wheelDiameter * p.speedPct) / 100;
    }
    step(ms) {
      const dt = ms / 1000 / SUBSTEPS;
      const p = this.p;
      const alpha = 1 - Math.exp(-(dt * 1000) / Math.max(1, p.responseMs));
      for (let i = 0; i < SUBSTEPS; i++) {
        this.vL += ((this.cmdL / 127) * this.vmax - this.vL) * alpha;
        this.vR += ((this.cmdR / 127) * this.vmax - this.vR) * alpha;
        this.sL += this.vL * dt;
        this.sR += this.vR * dt;
        const v = (this.vL + this.vR) / 2;
        const w = (this.vL - this.vR) / p.trackWidth; // rad/s, clockwise positive
        const hm = this.h + (w * dt) / 2;
        const px = this.x;
        const py = this.y;
        this.x += Math.sin(hm) * v * dt;
        this.y += Math.cos(hm) * v * dt;
        this.h += w * dt;
        this.collideWalls();
        this.traveled += Math.hypot(this.x - px, this.y - py);
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
    };
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
          apply: () => {
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
    const stuckMs = opts && opts.mechanismWaitMs != null ? opts.mechanismWaitMs : 500;
    const def = (v, d) => (v === undefined || v === null ? d : v);

    const api = {
      setPose: (x, y, theta) => ch.setPose(x, y, theta),
      getPose: () => ch.getPose(),
      calibrate: () => {},
      resetLocalPosition: () => {},
      setBrakeMode: () => {},
      moveToPoint: (x, y, timeout, params, a) => ch.moveToPoint(x, y, def(timeout, 10000), params, def(a, true)),
      moveToPose: (x, y, th, timeout, params, a) => ch.moveToPose(x, y, th, def(timeout, 10000), params, def(a, true)),
      turnToHeading: (th, timeout, params, a) => ch.turnToHeading(th, def(timeout, 10000), params, def(a, true)),
      turnToPoint: (x, y, timeout, params, a) => ch.turnToPoint(x, y, def(timeout, 10000), params, def(a, true)),
      swingToHeading: (th, side, timeout, params, a) =>
        ch.swingToHeading(th, side, def(timeout, 10000), params, def(a, true)),
      swingToPoint: (x, y, side, timeout, params, a) =>
        ch.swingToPoint(x, y, side, def(timeout, 10000), params, def(a, true)),
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
      // driving the motors directly (when no motion is running)
      tank: (l, r) => {
        ch.rawPower('L', l);
        ch.rawPower('R', r);
      },
      arcade: (throttle, turn) => {
        let l = throttle + turn;
        let r = throttle - turn;
        const big = Math.max(Math.abs(l), Math.abs(r), 127) / 127;
        ch.rawPower('L', l / big);
        ch.rawPower('R', r / big);
      },
      curvature: (throttle, curv) => api.arcade(throttle, throttle === 0 ? curv : Math.abs(throttle) * curv / 127),
    };
    // JAR-Template's Drive (snake_case methods and public members such as drive_max_voltage)
    const jarState = Object.assign({}, NS.JAR_DEFAULTS, opts && opts.jar);
    Object.assign(api, NS.makeJarApi(ch, jarState));
    // anything else on chassis (e.g. setBrakeMode variants) is ignored
    const chassisObj = new Proxy(api, {
      get: (t, k) => (k in t ? t[k] : k in jarState ? jarState[k] : k === 'then' ? undefined : NOOP),
      set: (t, k, v) => {
        if (k in jarState) jarState[k] = v;
        return true;
      },
    });

    // RW-Template's free functions and settings
    const rwSettings = Object.assign({}, NS.RW_DEFAULTS, opts && opts.rw);
    const RW = NS.makeRwApi(ch, rwSettings, { log });

    const scope = {
      NOOP,
      Pose: poseCtor,
      delay: (ms) => clock.sleep(ms),
      millis: () => clock.now,
      // `while (cond) {...}` waiting on something that is not simulated (lift, claw): give up after a while
      __loopStart: (cond) => ({ t0: clock.now, cond, warned: false }),
      __stuck: (w) => {
        if (/millis|isInMotion|isMotionRunning|waitUntil|get_position|position\s*\(|isDone|isSpinning|time\s*\(/.test(w.cond)) return false; // real waits on time / the drivetrain
        if (ch.motion || ch.rawPos) {
          w.t0 = clock.now;
          return false;
        }
        if (clock.now - w.t0 < stuckMs) return false;
        if (!warnedLoops.has(w.cond)) {
          warnedLoops.add(w.cond);
          log('warn', `while (${w.cond}) waits on something the sim does not run (lift, claw...); carried on after ${stuckMs} ms each time`);
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
      printf: (...a) => log('print', a.join(' ')),
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
    Object.assign(scope, {
      // VEXcode / PROS time and units
      wait: (t, unit) => clock.sleep(unit === 'sec' ? t * 1000 : unit === 'usec' ? t / 1000 : t),
      sleep: (ms) => clock.sleep(ms),
      sleep_for: (ms) => clock.sleep(ms),
      task_delay: (ms) => clock.sleep(ms),
      msec: 'msec', sec: 'sec', seconds: 'sec', usec: 'usec',
      fwd: 'fwd', forward: 'fwd', reverse: 'reverse',
      volt: 'volt', voltageUnits: { volt: 'volt', mV: 'mV' }, mV: 'mV',
      pct: 'pct', percent: 'pct', velocityUnits: { pct: 'pct', rpm: 'rpm' }, rpm: 'rpm', dps: 'dps',
      deg: 'deg', degrees: 'deg', rev: 'rev', turns: 'rev', raw: 'raw',
      hold: 'hold', coast: 'coast', brake: 'brake',
      // JAR-Template's constant presets (a definition in your own code replaces these)
      default_constants: () => Object.assign(jarState, {
        drive_max_voltage: 10, drive_kp: 1.5, drive_ki: 0, drive_kd: 10, drive_starti: 0,
        heading_max_voltage: 6, heading_kp: 0.4, heading_ki: 0, heading_kd: 1, heading_starti: 0,
        turn_max_voltage: 12, turn_kp: 0.4, turn_ki: 0.03, turn_kd: 3, turn_starti: 15,
        swing_max_voltage: 12, swing_kp: 0.3, swing_ki: 0.001, swing_kd: 2, swing_starti: 15,
        drive_settle_error: 1.5, drive_settle_time: 300, drive_timeout: 5000,
        turn_settle_error: 1, turn_settle_time: 300, turn_timeout: 3000,
        swing_settle_error: 1, swing_settle_time: 300, swing_timeout: 3000,
      }),
      odom_constants: () => {
        scope.default_constants();
        Object.assign(jarState, { heading_max_voltage: 10, drive_max_voltage: 8, drive_settle_error: 3, boomerang_lead: 0.5, drive_min_voltage: 0 });
      },
      // RW-Template
      ...RW.api,
      __rw: RW.asyncApi,
      clockwise: 'clockwise',
      counterclockwise: 'counterclockwise',
      shortest: 'shortest',
      TurnDirection: { clockwise: 'clockwise', counterclockwise: 'counterclockwise', shortest: 'shortest' },
    });
    const rwState = RW.rw;
    scope.__busy = () => rwState.asyncRunning || !!ch.rawPos;
    Object.defineProperty(scope, 'correct_angle', { get: () => rwState.correct_angle, set: (v) => (rwState.correct_angle = v), enumerable: true });
    Object.defineProperty(scope, 'x_pos', { get: () => ch.poseRad().x, set: () => {}, enumerable: true });
    Object.defineProperty(scope, 'y_pos', { get: () => ch.poseRad().y, set: () => {}, enumerable: true });
    Object.defineProperty(scope, 'motion_running', { get: () => rwState.motion_running || rwState.asyncRunning, set: () => {}, enumerable: true });
    Object.keys(rwSettings).forEach((k) =>
      Object.defineProperty(scope, k, { get: () => rwSettings[k], set: (v) => (rwSettings[k] = v), enumerable: true })
    );

    // drive motors used directly (PROS motor groups, VEXcode motors)
    ((opts && opts.motors) || []).forEach((mo) => {
      scope[mo.name] = NS.motorProxy(NS.makeMotor(ch, mo.name, mo.side, mo.gearRpm || 200, clock, log), NOOP);
    });

    chassisNames.forEach((n) => (scope[n] = chassisObj));
    Object.keys(pathLib).forEach((id) => (scope[id] = pathLib[id]));

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
   *   paths           [{ids:[...], name, points:[{x,y,v}] (inches, file frame)}]
   *   maxMs           hard stop for the simulation
   *   onProgress(ms)  optional
   */
  async function runSimulation(o) {
    const clock = new Clock();
    const robot = new Robot(o.robot, o.start);
    const events = [];
    const motions = [];
    const log = (kind, text) => events.push({ t: clock.now, kind, text });

    const ch = new Chassis(robot, clock, o.cfg, o.start, {
      motionStart(m) {
        motions.push({ id: m.id, label: m.label, t0: clock.now, t1: null, reason: '', follow: m.name === 'follow' ? m.pts.map((p) => ch.codeToField(p.x, p.y)) : null });
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
          if (mode === 'relative') shift = { x: robot.x - src[0].x, y: robot.y - src[0].y };
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
    const scope = buildScope(ch, clock, lib, names, log, { mechanismWaitMs: o.mechanismWaitMs, motors: o.motors, rw: o.rw, jar: o.jar });

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
    const F = { t: [], x: [], y: [], h: [], vl: [], vr: [], mi: [], ax: [], ay: [], hit: [], cx: [], cy: [], ct: [] };
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
    };

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
      if (codeDone && !ch.motion && !scope.__busy()) break;
      if (clock.now >= o.maxMs) {
        log('warn', `Stopped: simulation ran for ${o.maxMs / 1000} s without finishing`);
        break;
      }
      const before = ch.motion;
      ch.step();
      if (before && !ch.motion) {
        // A motion just ended. On the robot a queued (chained) motion takes over the drivetrain at
        // once, so let the waiting code start it and run its first pass in this same tick instead of
        // coasting for 10 ms with the motors at 0.
        await macro();
        if (ch.motion && ch.motion !== before) ch.step();
      }
      robot.step(TICK_MS);
      clock.now += TICK_MS;
      record();
      if (++ticks % 400 === 0) {
        if (o.onProgress) o.onProgress(clock.now);
        await yieldToUi();
      }
    }
    if (!error) log('info', `Auton code finished at ${(clock.now / 1000).toFixed(2)} s`);
    const missing = Array.from(scope.__unknownCalls || []).filter((n) => !/^(printf|print|lcd|puts)$/.test(n));
    if (missing.length) log('info', `Not defined in your code, so skipped: ${missing.map((n) => n + '()').join(', ')}. If one moves the robot, paste its definition too.`);

    return { frames: F, events, motions, durationMs: clock.now, error, vmax: robot.vmax };
  }

  Object.assign(NS, { runSimulation, Robot, Clock });
})();
