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
        const v = (this.vL + this.vR) / 2;
        const w = (this.vL - this.vR) / p.trackWidth; // rad/s, clockwise positive
        const hm = this.h + (w * dt) / 2;
        this.x += Math.sin(hm) * v * dt;
        this.y += Math.cos(hm) * v * dt;
        this.h += w * dt;
        this.collideWalls();
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
  function buildScope(ch, clock, pathLib, chassisNames, log) {
    const NOOP = makeNoop();
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
      // drivetrain-only sim: manual driving calls do nothing
      tank: () => {},
      arcade: () => {},
      curvature: () => {},
    };
    // anything else on chassis (e.g. setBrakeMode variants) is ignored
    const chassisObj = new Proxy(api, {
      get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : NOOP),
    });

    const scope = {
      NOOP,
      Pose: poseCtor,
      delay: (ms) => clock.sleep(ms),
      millis: () => clock.now,
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
    chassisNames.forEach((n) => (scope[n] = chassisObj));
    Object.keys(pathLib).forEach((id) => (scope[id] = pathLib[id]));

    return new Proxy(scope, {
      has: (_t, k) => typeof k === 'string' && k !== '__scope',
      get: (t, k) => {
        if (k === Symbol.unscopables) return undefined;
        if (k in t) return t[k];
        if (typeof k === 'string' && k in globalThis && /^[A-Z]/.test(k)) return globalThis[k];
        return NOOP;
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
          const mode = chassis.pathMode;
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
    const scope = buildScope(ch, clock, lib, names, log);

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    let fn;
    try {
      fn = new AsyncFunction('__scope', 'with (__scope) {\n' + o.js + '\n}');
    } catch (e) {
      return { frames: null, events: [{ t: 0, kind: 'error', text: 'Could not parse the code: ' + e.message }], motions: [], durationMs: 0, error: e };
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
      if (codeDone && !ch.motion) break;
      if (clock.now >= o.maxMs) {
        log('warn', `Stopped: simulation ran for ${o.maxMs / 1000} s without finishing`);
        break;
      }
      ch.step();
      robot.step(TICK_MS);
      clock.now += TICK_MS;
      record();
      if (++ticks % 400 === 0) {
        if (o.onProgress) o.onProgress(clock.now);
        await yieldToUi();
      }
    }
    if (!error) log('info', `Auton code finished at ${(clock.now / 1000).toFixed(2)} s`);

    return { frames: F, events, motions, durationMs: clock.now, error, vmax: robot.vmax };
  }

  Object.assign(NS, { runSimulation, Robot, Clock });
})();
