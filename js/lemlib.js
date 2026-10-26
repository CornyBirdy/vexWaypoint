/*
 * LemLib-style motion controllers.
 *
 * Re-implementation of the LemLib (v0.5.x) chassis motions: PID + exit
 * conditions, moveToPoint, moveToPose (boomerang), turnTo*, swingTo*, and
 * pure-pursuit follow(). It is a faithful *port of the algorithms*, not the
 * original C++, so tiny numerical differences from a real robot are expected.
 *
 * Conventions (same as LemLib):
 *   - units are inches / degrees in the public API, radians internally
 *   - heading is a compass bearing: 0 = +Y, positive = clockwise
 *   - motor commands are -127..127
 *   - controllers run every 10 ms of simulated time
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  const PI = Math.PI;
  const D2R = PI / 180;
  const R2D = 180 / PI;
  const TICK_MS = 10;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sgn = (v) => (v < 0 ? -1 : 1);
  const lerp = (a, b, t) => a + (b - a) * t;

  /** wrap to (-PI, PI] */
  function normPi(a) {
    a = (a + PI) % (2 * PI);
    if (a < 0) a += 2 * PI;
    return a - PI;
  }

  /** limit how much `target` may change from `current` per tick */
  function slew(target, current, maxChange) {
    if (!maxChange) return target;
    return current + clamp(target - current, -maxChange, maxChange);
  }

  class PID {
    constructor(kP, kI, kD, windupRange = 0) {
      this.kP = kP;
      this.kI = kI;
      this.kD = kD;
      this.windupRange = windupRange;
      this.integral = 0;
      this.prevError = 0;
    }
    update(error) {
      this.integral += error;
      if (sgn(error) !== sgn(this.prevError)) this.integral = 0;
      if (this.windupRange !== 0 && Math.abs(error) > this.windupRange) this.integral = 0;
      const derivative = error - this.prevError;
      this.prevError = error;
      return error * this.kP + this.integral * this.kI + derivative * this.kD;
    }
  }

  /** "error stayed inside `range` for `time` ms" */
  class ExitCondition {
    constructor(range, time, clock) {
      this.range = range;
      this.time = time;
      this.clock = clock;
      this.start = -1;
      this.done = false;
    }
    update(input) {
      const now = this.clock.now;
      if (Math.abs(input) > this.range) this.start = -1;
      else if (this.start === -1) this.start = now;
      else if (now >= this.start + this.time) this.done = true;
      return this.done;
    }
  }

  class Settle {
    constructor(s, clock) {
      this.small = new ExitCondition(s.smallError, s.smallErrorTimeout, clock);
      this.large = new ExitCondition(s.largeError, s.largeErrorTimeout, clock);
    }
    update(err) {
      const a = this.small.update(err);
      const b = this.large.update(err);
      return a || b;
    }
  }

  /**
   * Turn error honouring a forced direction. A forced direction is followed
   * until the remaining error is under 90 deg, then the shortest error is used
   * so a small overshoot does not send the robot spinning the long way round.
   */
  function dirError(raw, direction, state) {
    if (direction !== 'CW_CLOCKWISE' && direction !== 'CCW_COUNTERCLOCKWISE') return raw;
    const forced =
      direction === 'CW_CLOCKWISE' ? (raw >= 0 ? raw : raw + 2 * PI) : raw <= 0 ? raw : raw - 2 * PI;
    if (!state.latched && Math.abs(forced) < PI / 2) state.latched = true;
    return state.latched ? raw : forced;
  }

  const fmt = (n) => (Math.round(n * 100) / 100).toString();

  // ---------------------------------------------------------------- motions

  class Motion {
    constructor(ch, name, argText, timeout) {
      this.ch = ch;
      this.name = name;
      this.argText = argText;
      this.timeout = timeout > 0 ? timeout : 10000;
      this.dist = 0; // inches (lateral) or degrees (turns), for waitUntil()
      this.finished = false;
      this.reason = '';
      this.id = -1;
      this.t0 = ch.clock.now;
      this.t1 = null;
      this.donePromise = new Promise((r) => (this._res = r));
    }
    get label() {
      return `${this.name}(${this.argText})`;
    }
    finish(reason) {
      if (this.finished) return;
      this.finished = true;
      this.reason = reason;
      this.t1 = this.ch.clock.now;
      this._res();
    }
    timedOut() {
      return this.ch.clock.now - this.t0 >= this.timeout;
    }
    errorText() {
      return '';
    }
  }

  class MoveToPointMotion extends Motion {
    constructor(ch, x, y, timeout, p) {
      super(ch, 'moveToPoint', [fmt(x), fmt(y), timeout].join(', '), timeout);
      this.target = { x, y };
      this.forwards = p.forwards !== false;
      this.maxSpeed = clamp(p.maxSpeed == null ? 127 : p.maxSpeed, 0, 127);
      this.minSpeed = Math.abs(p.minSpeed || 0);
      this.earlyExit = p.earlyExitRange || 0;
      const lat = ch.cfg.lateral;
      const ang = ch.cfg.angular;
      this.lat = new PID(lat.kP, lat.kI, lat.kD, lat.antiWindup);
      this.ang = new PID(ang.kP, ang.kI, ang.kD, ang.antiWindup);
      this.settle = new Settle(lat, ch.clock);
      this.close = false;
      this.prevLat = 0;
      this.last = null;
      this.remaining = 0;
    }
    step() {
      const ch = this.ch;
      const pose = ch.poseRad();
      if (!this.forwards) pose.t += PI;
      if (this.last) this.dist += Math.hypot(pose.x - this.last.x, pose.y - this.last.y);
      this.last = { x: pose.x, y: pose.y };

      const dx = this.target.x - pose.x;
      const dy = this.target.y - pose.y;
      const dist = Math.hypot(dx, dy);
      this.remaining = dist;
      ch.aim = this.target;

      if (!this.close && dist < 7.5) {
        this.close = true;
        this.maxSpeed = Math.max(Math.abs(this.prevLat), 60);
      }
      if (this.minSpeed !== 0 && dist < this.earlyExit) return 'early exit';

      const angErr = normPi(Math.atan2(dx, dy) - pose.t);
      const latErr = this.close ? dist * Math.cos(angErr) : dist;
      if (this.settle.update(latErr)) return 'settled';
      if (this.timedOut()) return 'timeout';

      let latOut = this.lat.update(latErr);
      let angOut = this.ang.update(angErr * R2D);
      if (this.close) angOut = 0;
      angOut = clamp(angOut, -this.maxSpeed, this.maxSpeed);
      latOut = clamp(latOut, -this.maxSpeed, this.maxSpeed);
      if (!this.close) latOut = slew(latOut, this.prevLat, ch.cfg.lateral.slew);
      this.prevLat = latOut;
      // slow down while pointing away from the target
      if (!this.close) latOut *= Math.max(0, Math.cos(angErr));
      if (this.minSpeed !== 0 && latOut > 0 && latOut < this.minSpeed) latOut = this.minSpeed;

      let left = latOut + angOut;
      let right = latOut - angOut;
      const ratio = Math.max(Math.abs(left), Math.abs(right)) / (this.maxSpeed || 1);
      if (ratio > 1) {
        left /= ratio;
        right /= ratio;
      }
      ch.drive(this.forwards ? left : -right, this.forwards ? right : -left);
      return null;
    }
    errorText() {
      return `${fmt(this.remaining)} in from target`;
    }
  }

  class MoveToPoseMotion extends Motion {
    constructor(ch, x, y, thetaDeg, timeout, p) {
      super(ch, 'moveToPose', [fmt(x), fmt(y), fmt(thetaDeg), timeout].join(', '), timeout);
      this.forwards = p.forwards !== false;
      this.target = { x, y };
      this.targetT = thetaDeg * D2R + (this.forwards ? 0 : PI);
      this.lead = p.lead == null ? 0.6 : p.lead;
      this.drift = p.horizontalDrift ? p.horizontalDrift : ch.cfg.horizontalDrift;
      this.maxSpeed = clamp(p.maxSpeed == null ? 127 : p.maxSpeed, 0, 127);
      this.minSpeed = Math.abs(p.minSpeed || 0);
      this.earlyExit = p.earlyExitRange || 0;
      const lat = ch.cfg.lateral;
      const ang = ch.cfg.angular;
      this.lat = new PID(lat.kP, lat.kI, lat.kD, lat.antiWindup);
      this.ang = new PID(ang.kP, ang.kI, ang.kD, ang.antiWindup);
      this.settle = new Settle(lat, ch.clock);
      this.close = false;
      this.prevLat = 0;
      this.last = null;
      this.remaining = 0;
      this.headingErr = 0;
    }
    step() {
      const ch = this.ch;
      const pose = ch.poseRad();
      if (!this.forwards) pose.t += PI;
      if (this.last) this.dist += Math.hypot(pose.x - this.last.x, pose.y - this.last.y);
      this.last = { x: pose.x, y: pose.y };

      const T = this.target;
      const dist = Math.hypot(T.x - pose.x, T.y - pose.y);
      this.remaining = dist;
      if (!this.close && dist < 7.5) {
        this.close = true;
        this.maxSpeed = Math.max(Math.abs(this.prevLat), 60);
      }
      if (this.minSpeed !== 0 && dist < this.earlyExit) return 'early exit';

      // boomerang "carrot": a point behind the target along its final heading
      let carrot = T;
      if (!this.close) {
        carrot = {
          x: T.x - Math.sin(this.targetT) * this.lead * dist,
          y: T.y - Math.cos(this.targetT) * this.lead * dist,
        };
      }
      ch.aim = carrot;
      const cdx = carrot.x - pose.x;
      const cdy = carrot.y - pose.y;
      const cdist = Math.hypot(cdx, cdy);
      const toCarrot = normPi(Math.atan2(cdx, cdy) - pose.t);
      let angErr = this.close ? normPi(this.targetT - pose.t) : toCarrot;
      this.headingErr = normPi(this.targetT - pose.t);
      const latErr = cdist * Math.cos(toCarrot);

      if (this.settle.update(latErr)) return 'settled';
      if (this.timedOut()) return 'timeout';

      let latOut = this.lat.update(latErr);
      let angOut = this.ang.update(angErr * R2D);
      angOut = clamp(angOut, -this.maxSpeed, this.maxSpeed);
      latOut = clamp(latOut, -this.maxSpeed, this.maxSpeed);
      if (!this.close) latOut = slew(latOut, this.prevLat, ch.cfg.lateral.slew);

      // cap speed by what the drivetrain can corner at without slipping
      if (!this.close && this.drift > 0 && cdist > 1e-6) {
        const curv = Math.abs((2 * Math.sin(toCarrot)) / cdist);
        const radius = curv < 1e-9 ? Infinity : 1 / curv;
        const maxSlip = Math.sqrt(this.drift * radius * 9.8);
        latOut = clamp(latOut, -maxSlip, maxSlip);
      }
      // prioritise turning over driving
      const overturn = Math.abs(angOut) + Math.abs(latOut) - this.maxSpeed;
      if (overturn > 0) latOut -= latOut > 0 ? overturn : -overturn;
      // never drive away from the target
      if (!this.minSpeed && latOut < 0) latOut = 0;
      this.prevLat = latOut;
      if (this.minSpeed !== 0 && latOut > 0 && latOut < this.minSpeed) latOut = this.minSpeed;

      let left = latOut + angOut;
      let right = latOut - angOut;
      const ratio = Math.max(Math.abs(left), Math.abs(right)) / (this.maxSpeed || 1);
      if (ratio > 1) {
        left /= ratio;
        right /= ratio;
      }
      ch.drive(this.forwards ? left : -right, this.forwards ? right : -left);
      return null;
    }
    errorText() {
      return `${fmt(this.remaining)} in, ${fmt(Math.abs(this.headingErr) * R2D)} deg from target`;
    }
  }

  /** turnToHeading / turnToPoint / swingToHeading / swingToPoint */
  class TurnMotion extends Motion {
    constructor(ch, o) {
      super(ch, o.name, o.argText, o.timeout);
      this.mode = o.mode; // 'heading' | 'point'
      this.targetT = o.mode === 'heading' ? o.thetaDeg * D2R : 0;
      this.point = o.point;
      this.forwards = o.forwards !== false;
      this.direction = o.direction || 'AUTO';
      this.swing = o.swing || null; // 'LEFT' | 'RIGHT' = which side stays locked
      this.maxSpeed = clamp(o.maxSpeed == null ? 127 : o.maxSpeed, 0, 127);
      this.minSpeed = Math.abs(o.minSpeed || 0);
      this.earlyExit = o.earlyExitRange || 0;
      const ang = ch.cfg.angular;
      this.pid = new PID(ang.kP, ang.kI, ang.kD, ang.antiWindup);
      this.settle = new Settle(ang, ch.clock);
      this.state = { latched: false };
      this.prevOut = 0;
      this.lastT = null;
      this.errDeg = 0;
    }
    step() {
      const ch = this.ch;
      const pose = ch.poseRad();
      if (this.lastT != null) this.dist += Math.abs(normPi(pose.t - this.lastT)) * R2D;
      this.lastT = pose.t;

      let target = this.targetT;
      if (this.mode === 'point') {
        target = Math.atan2(this.point.x - pose.x, this.point.y - pose.y) + (this.forwards ? 0 : PI);
        ch.aim = this.point;
      }
      const raw = normPi(target - pose.t);
      const err = dirError(raw, this.direction, this.state);
      this.errDeg = err * R2D;

      if (this.minSpeed !== 0 && Math.abs(this.errDeg) < this.earlyExit) return 'early exit';
      if (this.settle.update(this.errDeg)) return 'settled';
      if (this.timedOut()) return 'timeout';

      let out = this.pid.update(this.errDeg);
      out = slew(out, this.prevOut, ch.cfg.angular.slew);
      this.prevOut = out;
      out = clamp(out, -this.maxSpeed, this.maxSpeed);
      if (this.minSpeed !== 0) {
        if (out < 0 && out > -this.minSpeed) out = -this.minSpeed;
        else if (out > 0 && out < this.minSpeed) out = this.minSpeed;
      }
      if (this.swing === 'LEFT') ch.drive(0, -out);
      else if (this.swing === 'RIGHT') ch.drive(out, 0);
      else ch.drive(out, -out);
      return null;
    }
    errorText() {
      return `${fmt(Math.abs(this.errDeg))} deg from target`;
    }
  }

  function circleIntersect(p1, p2, c, r) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const fx = p1.x - c.x;
    const fy = p1.y - c.y;
    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const k = fx * fx + fy * fy - r * r;
    const disc = b * b - 4 * a * k;
    if (a === 0 || disc < 0) return -1;
    const s = Math.sqrt(disc);
    const t1 = (-b - s) / (2 * a);
    const t2 = (-b + s) / (2 * a);
    if (t2 >= 0 && t2 <= 1) return t2;
    if (t1 >= 0 && t1 <= 1) return t1;
    return -1;
  }

  /** pure pursuit along a list of {x, y, v} points (v = 0..127) */
  class FollowMotion extends Motion {
    constructor(ch, pts, lookahead, timeout, forwards, pathName) {
      super(ch, 'follow', [pathName, fmt(lookahead), timeout].join(', '), timeout);
      this.pts = pts;
      this.lookahead = lookahead;
      this.forwards = forwards !== false;
      this.closest = 0;
      this.laIdx = 0;
      this.laT = 0;
      this.la = { x: pts[0].x, y: pts[0].y };
      this.last = null;
      this.pastEnd = 0;
      this.prevEndDist = Infinity;
      this.remaining = 0;
    }
    step() {
      const ch = this.ch;
      const pts = this.pts;
      const n = pts.length;
      const pose = ch.poseRad();
      if (!this.forwards) pose.t += PI;
      if (this.last) this.dist += Math.hypot(pose.x - this.last.x, pose.y - this.last.y);
      this.last = { x: pose.x, y: pose.y };

      // closest path point (searched in a window so crossing paths do not jump)
      let best = Infinity;
      for (let i = this.closest; i < Math.min(n, this.closest + 40); i++) {
        const d = Math.hypot(pts[i].x - pose.x, pts[i].y - pose.y);
        if (d < best) {
          best = d;
          this.closest = i;
        }
      }
      const end = pts[n - 1];
      const endDist = Math.hypot(end.x - pose.x, end.y - pose.y);
      this.remaining = endDist;

      if (endDist < 2.5) return 'reached end';
      if (this.closest === n - 1) {
        this.pastEnd = endDist > this.prevEndDist + 1e-6 ? this.pastEnd + 1 : 0;
        if (this.pastEnd > 25) return 'passed end';
      }
      this.prevEndDist = endDist;
      if (this.timedOut()) return 'timeout';

      // lookahead point
      if (endDist < this.lookahead) {
        this.la = { x: end.x, y: end.y };
      } else {
        const limit = Math.min(n - 1, this.laIdx + 60);
        for (let i = this.laIdx; i < limit; i++) {
          const t = circleIntersect(pts[i], pts[i + 1], pose, this.lookahead);
          if (t >= 0 && (i > this.laIdx || t >= this.laT)) {
            this.laIdx = i;
            this.laT = t;
            this.la = { x: lerp(pts[i].x, pts[i + 1].x, t), y: lerp(pts[i].y, pts[i + 1].y, t) };
            break;
          }
        }
      }
      ch.aim = this.la;

      const ldx = this.la.x - pose.x;
      const ldy = this.la.y - pose.y;
      const ld = Math.hypot(ldx, ldy);
      const toLa = normPi(Math.atan2(ldx, ldy) - pose.t);
      const curvature = ld > 1e-6 ? (2 * Math.sin(toLa)) / ld : 0;

      const v = Math.max(8, pts[this.closest].v);
      const tw = ch.cfg.trackWidth;
      let left = (v * (2 + curvature * tw)) / 2;
      let right = (v * (2 - curvature * tw)) / 2;
      const ratio = Math.max(Math.abs(left), Math.abs(right)) / 127;
      if (ratio > 1) {
        left /= ratio;
        right /= ratio;
      }
      ch.drive(this.forwards ? left : -right, this.forwards ? right : -left);
      return null;
    }
    errorText() {
      return `${fmt(this.remaining)} in from path end`;
    }
  }

  // ---------------------------------------------------------------- chassis

  /**
   * The simulated `lemlib::Chassis`. Owns the odometry frame ("code frame"):
   * the origin/heading chosen with setPose(), expressed relative to the field.
   */
  class Chassis {
    constructor(robot, clock, cfg, startPose, hooks) {
      this.robot = robot;
      this.clock = clock;
      this.cfg = cfg;
      this.hooks = hooks || {};
      this.pathMode = cfg.pathMode || 'field';
      // code frame = field start pose; (0,0,0) in code is the start pose
      this.frame = { px: startPose.x, py: startPose.y, psi: startPose.h * D2R };
      this.motion = null;
      this.stopIn = null;
      this.idleWaiters = [];
      this.aim = null;
      this.motionCount = 0;
      this.motions = [];
    }

    // ----- frames
    poseRad() {
      const r = this.robot;
      const f = this.frame;
      const vx = r.x - f.px;
      const vy = r.y - f.py;
      const c = Math.cos(f.psi);
      const s = Math.sin(f.psi);
      return { x: vx * c - vy * s, y: vx * s + vy * c, t: r.h - f.psi };
    }
    codeToField(x, y) {
      const f = this.frame;
      const c = Math.cos(f.psi);
      const s = Math.sin(f.psi);
      return { x: f.px + x * c + y * s, y: f.py - x * s + y * c };
    }
    fieldToCode(x, y) {
      const f = this.frame;
      const c = Math.cos(f.psi);
      const s = Math.sin(f.psi);
      const vx = x - f.px;
      const vy = y - f.py;
      return { x: vx * c - vy * s, y: vx * s + vy * c };
    }
    getPose() {
      const p = this.poseRad();
      let th = (p.t * R2D) % 360;
      if (th < 0) th += 360;
      return { x: p.x, y: p.y, theta: th, heading: th };
    }
    setPose(x, y, thetaDeg) {
      const r = this.robot;
      const psi = r.h - thetaDeg * D2R;
      const c = Math.cos(psi);
      const s = Math.sin(psi);
      this.frame = { px: r.x - (x * c + y * s), py: r.y - (-x * s + y * c), psi };
    }

    drive(l, r) {
      this.robot.cmdL = clamp(l, -127, 127);
      this.robot.cmdR = clamp(r, -127, 127);
    }

    // ----- scheduler hooks
    /** called once per tick, after user code has had its turn */
    step() {
      if (this.motion) {
        const m = this.motion;
        const why = m.step();
        if (why) this.endMotion(m, why);
      }
      if (!this.motion && this.stopIn !== null) {
        if (this.stopIn <= 0) {
          this.drive(0, 0);
          this.stopIn = null;
        } else this.stopIn--;
      }
    }
    endMotion(m, why) {
      m.finish(why);
      if (this.hooks.motionEnd) this.hooks.motionEnd(m);
      this.motion = null;
      this.aim = null;
      // a motion that exits early hands over to the next one without a braking tick
      this.stopIn = why === 'early exit' ? 1 : 0;
      const w = this.idleWaiters;
      this.idleWaiters = [];
      w.forEach((r) => r());
    }
    _idle() {
      if (!this.motion) return Promise.resolve();
      return new Promise((r) => this.idleWaiters.push(r));
    }
    async _start(motion, isAsync) {
      // LemLib blocks the calling thread until the previous motion has finished
      while (this.motion) await this._idle();
      motion.t0 = this.clock.now;
      motion.id = this.motionCount++;
      this.motions.push(motion);
      this.motion = motion;
      this.stopIn = null;
      if (this.hooks.motionStart) this.hooks.motionStart(motion);
      if (isAsync === false) await motion.donePromise;
      else await this.clock.sleep(TICK_MS);
    }

    // ----- public LemLib API
    moveToPoint(x, y, timeout, p = {}, isAsync = true) {
      return this._start(new MoveToPointMotion(this, x, y, timeout, p || {}), isAsync);
    }
    moveToPose(x, y, theta, timeout, p = {}, isAsync = true) {
      return this._start(new MoveToPoseMotion(this, x, y, theta, timeout, p || {}), isAsync);
    }
    turnToHeading(theta, timeout, p = {}, isAsync = true) {
      p = p || {};
      return this._start(
        new TurnMotion(this, {
          name: 'turnToHeading',
          argText: [fmt(theta), timeout].join(', '),
          mode: 'heading',
          thetaDeg: theta,
          timeout,
          direction: p.direction,
          maxSpeed: p.maxSpeed,
          minSpeed: p.minSpeed,
          earlyExitRange: p.earlyExitRange,
        }),
        isAsync
      );
    }
    turnToPoint(x, y, timeout, p = {}, isAsync = true) {
      p = p || {};
      return this._start(
        new TurnMotion(this, {
          name: 'turnToPoint',
          argText: [fmt(x), fmt(y), timeout].join(', '),
          mode: 'point',
          point: { x, y },
          forwards: p.forwards,
          timeout,
          direction: p.direction,
          maxSpeed: p.maxSpeed,
          minSpeed: p.minSpeed,
          earlyExitRange: p.earlyExitRange,
        }),
        isAsync
      );
    }
    swingToHeading(theta, lockedSide, timeout, p = {}, isAsync = true) {
      p = p || {};
      return this._start(
        new TurnMotion(this, {
          name: 'swingToHeading',
          argText: [fmt(theta), lockedSide, timeout].join(', '),
          mode: 'heading',
          thetaDeg: theta,
          swing: lockedSide,
          timeout,
          direction: p.direction,
          maxSpeed: p.maxSpeed,
          minSpeed: p.minSpeed,
          earlyExitRange: p.earlyExitRange,
        }),
        isAsync
      );
    }
    swingToPoint(x, y, lockedSide, timeout, p = {}, isAsync = true) {
      p = p || {};
      return this._start(
        new TurnMotion(this, {
          name: 'swingToPoint',
          argText: [fmt(x), fmt(y), lockedSide, timeout].join(', '),
          mode: 'point',
          point: { x, y },
          swing: lockedSide,
          forwards: p.forwards,
          timeout,
          direction: p.direction,
          maxSpeed: p.maxSpeed,
          minSpeed: p.minSpeed,
          earlyExitRange: p.earlyExitRange,
        }),
        isAsync
      );
    }
    /** `pathPts` are already in the code frame */
    follow(pathPts, pathName, lookahead, timeout, forwards = true, isAsync = true) {
      return this._start(new FollowMotion(this, pathPts, lookahead, timeout, forwards, pathName), isAsync);
    }

    async waitUntil(dist) {
      const m = this.motion;
      if (!m) return;
      while (this.motion === m && m.dist <= dist) await this.clock.sleep(TICK_MS);
    }
    async waitUntilDone() {
      while (this.motion) await this._idle();
    }
    cancelMotion() {
      if (this.motion) this.endMotion(this.motion, 'cancelled');
      return this.clock.sleep(TICK_MS);
    }
    cancelAllMotions() {
      return this.cancelMotion();
    }
    isInMotion() {
      return !!this.motion;
    }
  }

  Object.assign(NS, {
    TICK_MS,
    D2R,
    R2D,
    clamp,
    normPi,
    PID,
    ExitCondition,
    Chassis,
    DEFAULT_LATERAL: {
      kP: 10, kI: 0, kD: 3, antiWindup: 3,
      smallError: 1, smallErrorTimeout: 100, largeError: 3, largeErrorTimeout: 500, slew: 20,
    },
    DEFAULT_ANGULAR: {
      kP: 2, kI: 0, kD: 10, antiWindup: 3,
      smallError: 1, smallErrorTimeout: 100, largeError: 3, largeErrorTimeout: 500, slew: 0,
    },
  });
})();
