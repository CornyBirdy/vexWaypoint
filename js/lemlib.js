/*
 * LemLib motion controllers.
 *
 * A JavaScript port of the chassis motions in LemLib v0.5.6
 * (https://github.com/LemLib/LemLib, MIT licence, (c) 2024 Liam Teale and LemLib
 * contributors - see NOTICE.md): PID + exit conditions, moveToPoint, moveToPose
 * (boomerang), turnTo*, swingTo*, follow() (pure pursuit), and the motion queue /
 * chaining rules (minSpeed + earlyExitRange).
 *
 * Conventions (same as LemLib):
 *   - units are inches / degrees in the public API
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

  // ---- angle helpers, the same maths LemLib v0.5.6 uses (degrees for turns)

  const sanitizeDeg = (a) => ((a % 360) + 360) % 360;

  /** IEEE remainder: x - n*y with n the integer nearest x/y, ties to even (C's std::remainder) */
  function remainder(x, y) {
    const q = x / y;
    let n = Math.floor(q + 0.5);
    if (q + 0.5 === n && n % 2 !== 0) n -= 1;
    return x - n * y;
  }

  /** LemLib angleError(target, position, radians = false, direction) */
  function angleErrorDeg(target, position, direction) {
    const raw = sanitizeDeg(target) - sanitizeDeg(position);
    if (direction === 'CW_CLOCKWISE') return raw < 0 ? raw + 360 : raw;
    if (direction === 'CCW_COUNTERCLOCKWISE') return raw > 0 ? raw - 360 : raw;
    return remainder(raw, 360);
  }

  /** a LemLib ExitCondition pair: either one can end a motion */
  class Exits {
    constructor(s, clock) {
      this.small = new ExitCondition(s.smallError, s.smallErrorTimeout, clock);
      this.large = new ExitCondition(s.largeError, s.largeErrorTimeout, clock);
    }
    update(err) {
      this.small.update(err);
      this.large.update(err);
    }
    get either() {
      return this.small.done || this.large.done;
    }
    get both() {
      return this.small.done && this.large.done;
    }
  }

  const fmt = (n) => (Math.round(n * 100) / 100).toString();

  // ---------------------------------------------------------------- motions
  //
  // Ported from LemLib v0.5.6 (src/lemlib/chassis/motions/*.cpp). One step() is one pass of the
  // original `while` loop (the original sleeps 10 ms after each pass). A step that returns a
  // string ends the motion; the check order matches the original loop condition + body.

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
      this.site = ch.nextSite == null ? null : ch.nextSite; // which call in the code started it (auto-tune)
      ch.nextSite = null;
    }
    /** called when the motion actually starts running (after any earlier motion finished) */
    begin() {
      this.t0 = this.ch.clock.now;
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
      this.maxSpeed = p.maxSpeed == null ? 127 : p.maxSpeed;
      this.minSpeed = p.minSpeed || 0;
      this.earlyExit = Math.abs(p.earlyExitRange || 0);
      this.remaining = 0;
    }
    begin() {
      super.begin();
      const ch = this.ch;
      const lat = ch.cfg.lateral;
      const ang = ch.cfg.angular;
      this.lat = new PID(lat.kP, lat.kI, lat.kD, lat.antiWindup);
      this.ang = new PID(ang.kP, ang.kI, ang.kD, ang.antiWindup);
      this.exits = new Exits(lat, ch.clock);
      const s = ch.poseRad();
      this.last = { x: s.x, y: s.y };
      // direction of travel, start -> target (compass); the "line" used for motion chaining
      this.travel = Math.atan2(this.target.x - s.x, this.target.y - s.y);
      this.close = false;
      this.prevLat = 0;
      this.prevAng = 0;
      this.prevSide = null;
    }
    step() {
      const ch = this.ch;
      // loop condition
      if (this.timedOut()) return 'timeout';
      if (this.close && this.exits.either) return 'settled';

      const pose = ch.poseRad();
      this.dist += Math.hypot(pose.x - this.last.x, pose.y - this.last.y);
      this.last = { x: pose.x, y: pose.y };
      const dx = this.target.x - pose.x;
      const dy = this.target.y - pose.y;
      const distTarget = Math.hypot(dx, dy);
      this.remaining = distTarget;
      ch.aim = this.target;

      // close enough to start settling
      if (distTarget < 7.5 && !this.close) {
        this.close = true;
        this.maxSpeed = Math.max(Math.abs(this.prevLat), 60);
      }

      // motion chaining: has the robot crossed the line earlyExitRange before the target?
      const along = (pose.x - this.target.x) * Math.sin(this.travel) + (pose.y - this.target.y) * Math.cos(this.travel);
      const side = along + this.earlyExit >= 0;
      if (this.prevSide === null) this.prevSide = side;
      if (side !== this.prevSide && this.minSpeed !== 0) return 'early exit';
      this.prevSide = side;

      // errors (the robot's heading is flipped for backwards motion, the lateral error is not)
      const bearing = Math.atan2(dx, dy);
      const adjusted = this.forwards ? pose.t : pose.t + PI;
      const angularError = normPi(bearing - adjusted);
      const lateralError = distTarget * Math.cos(normPi(bearing - pose.t));

      this.exits.update(lateralError);

      let lateralOut = this.lat.update(lateralError);
      let angularOut = this.ang.update(angularError * R2D);
      if (this.close) angularOut = 0;

      angularOut = clamp(angularOut, -this.maxSpeed, this.maxSpeed);
      angularOut = slew(angularOut, this.prevAng, ch.cfg.angular.slew);

      lateralOut = clamp(lateralOut, -this.maxSpeed, this.maxSpeed);
      if (!this.close) lateralOut = slew(lateralOut, this.prevLat, ch.cfg.lateral.slew);

      // never drive away from the target while approaching
      if (this.forwards && !this.close) lateralOut = Math.max(lateralOut, 0);
      else if (!this.forwards && !this.close) lateralOut = Math.min(lateralOut, 0);

      // minimum speed overrides everything but maxSpeed
      const minS = Math.abs(this.minSpeed);
      if (this.forwards && lateralOut < minS && lateralOut > 0) lateralOut = minS;
      if (!this.forwards && -lateralOut < minS && lateralOut < 0) lateralOut = -minS;

      this.prevAng = angularOut;
      this.prevLat = lateralOut;

      let left = lateralOut + angularOut;
      let right = lateralOut - angularOut;
      const ratio = Math.max(Math.abs(left), Math.abs(right)) / this.maxSpeed;
      if (ratio > 1) {
        left /= ratio;
        right /= ratio;
      }
      ch.drive(left, right);
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
      // direction of travel at the target (compass); backwards motion arrives with the rear first
      this.targetT = thetaDeg * D2R + (this.forwards ? 0 : PI);
      this.lead = p.lead == null ? 0.6 : p.lead;
      this.drift = p.horizontalDrift ? p.horizontalDrift : ch.cfg.horizontalDrift;
      this.maxSpeed = p.maxSpeed == null ? 127 : p.maxSpeed;
      this.minSpeed = p.minSpeed || 0;
      this.earlyExit = p.earlyExitRange || 0;
      this.remaining = 0;
      this.headingErr = 0;
    }
    begin() {
      super.begin();
      const ch = this.ch;
      const lat = ch.cfg.lateral;
      const ang = ch.cfg.angular;
      this.lat = new PID(lat.kP, lat.kI, lat.kD, lat.antiWindup);
      this.ang = new PID(ang.kP, ang.kI, ang.kD, ang.antiWindup);
      this.latExits = new Exits(lat, ch.clock);
      this.angExits = new Exits(ang, ch.clock);
      const s = ch.poseRad();
      this.last = { x: s.x, y: s.y };
      this.close = false;
      this.lateralSettled = false;
      this.prevSameSide = false;
      this.prevLat = 0;
    }
    step() {
      const ch = this.ch;
      // loop condition: leave once close, lateral settled (both exits) and the heading has exited (either)
      if (this.timedOut()) return 'timeout';
      if (this.close && this.lateralSettled && this.angExits.either) return 'settled';

      const pose = ch.poseRad();
      this.dist += Math.hypot(pose.x - this.last.x, pose.y - this.last.y);
      this.last = { x: pose.x, y: pose.y };
      const T = this.target;
      const distTarget = Math.hypot(T.x - pose.x, T.y - pose.y);
      this.remaining = distTarget;

      if (distTarget < 7.5 && !this.close) {
        this.close = true;
        this.maxSpeed = Math.max(Math.abs(this.prevLat), 60);
      }
      if (this.latExits.both) this.lateralSettled = true;

      // boomerang carrot
      const ux = Math.sin(this.targetT);
      const uy = Math.cos(this.targetT);
      let carrot = { x: T.x - ux * this.lead * distTarget, y: T.y - uy * this.lead * distTarget };
      if (this.close) carrot = T;
      ch.aim = carrot;

      // motion chaining: which side of the (shifted) target line are the robot and the carrot on?
      const eps = this.earlyExit;
      const robotSide = (pose.x - T.x) * ux + (pose.y - T.y) * uy + eps >= 0;
      const carrotSide = (carrot.x - T.x) * ux + (carrot.y - T.y) * uy + eps >= 0;
      const sameSide = robotSide === carrotSide;
      if (!sameSide && this.prevSameSide && this.close && this.minSpeed !== 0) return 'early exit';
      this.prevSameSide = sameSide;

      // errors
      const cdx = carrot.x - pose.x;
      const cdy = carrot.y - pose.y;
      const toCarrot = Math.atan2(cdx, cdy);
      const adjusted = this.forwards ? pose.t : pose.t + PI;
      const angularError = this.close ? normPi(this.targetT - adjusted) : normPi(toCarrot - adjusted);
      this.headingErr = normPi(this.targetT - adjusted);
      let lateralError = Math.hypot(cdx, cdy);
      const c = Math.cos(normPi(toCarrot - pose.t));
      if (this.close) lateralError *= c;
      else lateralError *= c < 0 ? -1 : 1;

      this.latExits.update(lateralError);
      this.angExits.update(angularError * R2D);

      let lateralOut = this.lat.update(lateralError);
      let angularOut = this.ang.update(angularError * R2D);

      angularOut = clamp(angularOut, -this.maxSpeed, this.maxSpeed);
      lateralOut = clamp(lateralOut, -this.maxSpeed, this.maxSpeed);
      if (!this.close) lateralOut = slew(lateralOut, this.prevLat, ch.cfg.lateral.slew);

      // the fastest it can take this curve without slipping sideways
      const cd = Math.hypot(cdx, cdy);
      if (cd > 1e-9) {
        const curv = Math.abs((2 * Math.sin(normPi(toCarrot - pose.t))) / cd);
        const radius = curv < 1e-12 ? Infinity : 1 / curv;
        const maxSlip = Math.sqrt(this.drift * radius * 9.8);
        if (isFinite(maxSlip)) lateralOut = clamp(lateralOut, -maxSlip, maxSlip);
      }
      // turning has priority over driving
      const overturn = Math.abs(angularOut) + Math.abs(lateralOut) - this.maxSpeed;
      if (overturn > 0) lateralOut -= lateralOut > 0 ? overturn : -overturn;

      if (this.forwards && !this.close) lateralOut = Math.max(lateralOut, 0);
      else if (!this.forwards && !this.close) lateralOut = Math.min(lateralOut, 0);

      const minS = Math.abs(this.minSpeed);
      if (this.forwards && lateralOut < minS && lateralOut > 0) lateralOut = minS;
      if (!this.forwards && -lateralOut < minS && lateralOut < 0) lateralOut = -minS;

      this.prevLat = lateralOut;

      let left = lateralOut + angularOut;
      let right = lateralOut - angularOut;
      const ratio = Math.max(Math.abs(left), Math.abs(right)) / this.maxSpeed;
      if (ratio > 1) {
        left /= ratio;
        right /= ratio;
      }
      ch.drive(left, right);
      return null;
    }
    errorText() {
      return `${fmt(this.remaining)} in, ${fmt(Math.abs(this.headingErr) * R2D)} deg from target`;
    }
  }

  /** turnToHeading / turnToPoint / swingToHeading / swingToPoint (all in degrees, like LemLib) */
  class TurnMotion extends Motion {
    constructor(ch, o) {
      super(ch, o.name, o.argText, o.timeout);
      this.mode = o.mode; // 'heading' | 'point'
      this.thetaDeg = o.thetaDeg;
      this.point = o.point;
      this.forwards = o.forwards !== false;
      this.direction = o.direction || 'AUTO';
      this.swing = o.swing || null; // 'LEFT' | 'RIGHT' = which side stays locked
      this.maxSpeed = o.maxSpeed == null ? 127 : o.maxSpeed;
      this.minSpeed = Math.abs(o.minSpeed || 0);
      this.earlyExit = o.earlyExitRange || 0;
      this.errDeg = 0;
    }
    begin() {
      super.begin();
      const ch = this.ch;
      const ang = ch.cfg.angular;
      this.pid = new PID(ang.kP, ang.kI, ang.kD, ang.antiWindup);
      this.exits = new Exits(ang, ch.clock);
      this.startT = ch.poseRad().t * R2D;
      this.settling = false;
      this.prevRaw = null;
      this.prevDelta = null;
      this.prevPower = 0;
    }
    step() {
      const ch = this.ch;
      if (this.timedOut()) return 'timeout';
      if (this.exits.either) return 'settled';

      const pose = ch.poseRad();
      let theta = pose.t * R2D;
      if (this.mode === 'point') theta = this.forwards ? theta % 360 : (theta - 180) % 360;
      else if (this.swing) theta = theta % 360;

      this.dist = Math.abs(angleErrorDeg(theta, this.startT, 'AUTO'));

      let target;
      if (this.mode === 'point') {
        target = (Math.atan2(this.point.x - pose.x, this.point.y - pose.y) * R2D) % 360;
        ch.aim = this.point;
      } else target = this.thetaDeg;

      // once the shortest-path error changes sign the robot has passed the target: stop forcing a direction
      const raw = angleErrorDeg(target, theta, 'AUTO');
      if (this.prevRaw === null) this.prevRaw = raw;
      if (sgn(raw) !== sgn(this.prevRaw)) this.settling = true;
      this.prevRaw = raw;

      const delta = this.settling ? angleErrorDeg(target, theta, 'AUTO') : angleErrorDeg(target, theta, this.direction);
      if (this.prevDelta === null) this.prevDelta = delta;
      this.errDeg = delta;

      // motion chaining
      if (this.minSpeed !== 0 && Math.abs(delta) < this.earlyExit) return 'early exit';
      if (this.minSpeed !== 0 && sgn(delta) !== sgn(this.prevDelta)) return 'early exit';

      let power = this.pid.update(delta);
      this.exits.update(delta);

      if (power > this.maxSpeed) power = this.maxSpeed;
      else if (power < -this.maxSpeed) power = -this.maxSpeed;
      if (Math.abs(delta) > 20) power = slew(power, this.prevPower, ch.cfg.angular.slew);
      if (power < 0 && power > -this.minSpeed) power = -this.minSpeed;
      else if (power > 0 && power < this.minSpeed) power = this.minSpeed;
      this.prevPower = power;

      if (this.swing === 'LEFT') ch.drive(0, -power);
      else if (this.swing === 'RIGHT') ch.drive(power, 0);
      else ch.drive(power, -power);
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
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / (2 * a);
      const t2 = (-b + sq) / (2 * a);
      if (t2 >= 0 && t2 <= 1) return t2;
      if (t1 >= 0 && t1 <= 1) return t1;
    }
    return -1;
  }

  /**
   * Pure pursuit along a list of {x, y, v} points (v = 0..127), as in LemLib: the closest point
   * anywhere on the path sets the speed (ramped by the lateral slew), the lookahead point is the
   * first circle/path crossing at or after the closest point, and the motion ends when the closest
   * point has speed 0. Points after `endIdx` are a synthetic stopping tail (see sim.js).
   */
  class FollowMotion extends Motion {
    constructor(ch, pts, endIdx, lookahead, timeout, forwards, pathName) {
      super(ch, 'follow', [pathName, fmt(lookahead), timeout].join(', '), timeout);
      this.pts = pts;
      this.endIdx = endIdx;
      this.lookahead = lookahead;
      this.forwards = forwards !== false;
      this.ticks = 0;
      this.remaining = 0;
      // paths exported from jerry.io end in a speed-0 point; plain point lists do not
      this.hasStop = pts.slice(0, endIdx + 1).some((q) => q.v === 0);
    }
    begin() {
      super.begin();
      this.lastLA = { x: this.pts[0].x, y: this.pts[0].y, idx: 0 };
      this.prevVel = 0;
      const s = this.ch.poseRad();
      this.last = { x: s.x, y: s.y };
      this.pastEnd = 0;
      this.prevEndDist = Infinity;
    }
    step() {
      const ch = this.ch;
      const pts = this.pts;
      if (this.ticks >= Math.floor(this.timeout / 10)) return 'timeout';
      this.ticks++;

      const pose = ch.poseRad();
      if (!this.forwards) pose.t -= PI;
      this.dist += Math.hypot(pose.x - this.last.x, pose.y - this.last.y);
      this.last = { x: pose.x, y: pose.y };

      // closest point on the whole path
      let closest = 0;
      let best = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(pts[i].x - pose.x, pts[i].y - pose.y);
        if (d < best) {
          best = d;
          closest = i;
        }
      }
      const end = pts[this.endIdx];
      const endDist = Math.hypot(end.x - pose.x, end.y - pose.y);
      this.remaining = endDist;

      if (this.hasStop) {
        if (pts[closest].v === 0) return 'reached end';
      } else {
        // no stop point in the data: finish at the last real point
        if (endDist < 2.5) return 'reached end';
        if (closest >= this.endIdx) {
          this.pastEnd = endDist > this.prevEndDist + 1e-6 ? this.pastEnd + 1 : 0;
          if (this.pastEnd > 25) return 'passed end';
        }
        this.prevEndDist = endDist;
      }

      // lookahead point: first crossing at or after the closest point / the last lookahead
      const start = Math.max(closest, this.lastLA.idx);
      for (let i = start; i < pts.length - 1; i++) {
        const t = circleIntersect(pts[i], pts[i + 1], pose, this.lookahead);
        if (t !== -1) {
          this.lastLA = { x: lerp(pts[i].x, pts[i + 1].x, t), y: lerp(pts[i].y, pts[i + 1].y, t), idx: i };
          break;
        }
      }
      ch.aim = this.lastLA;

      const ldx = this.lastLA.x - pose.x;
      const ldy = this.lastLA.y - pose.y;
      const ld = Math.hypot(ldx, ldy);
      const curvature = ld > 1e-9 ? (2 * Math.sin(normPi(Math.atan2(ldx, ldy) - pose.t))) / ld : 0;

      let vel = pts[closest].v;
      vel = slew(vel, this.prevVel, ch.cfg.lateral.slew);
      this.prevVel = vel;

      const tw = ch.cfg.trackWidth;
      let left = (vel * (2 + curvature * tw)) / 2;
      let right = (vel * (2 - curvature * tw)) / 2;
      const ratio = Math.max(Math.abs(left), Math.abs(right)) / 127;
      if (ratio > 1) {
        left /= ratio;
        right /= ratio;
      }
      if (this.forwards) ch.drive(left, right);
      else ch.drive(-right, -left);
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
      this.nextSite = null;
      this.idleWaiters = [];
      this.aim = null;
      this.motionCount = 0;
      this.motions = [];
    }

    // ----- frames
    /** where the robot's odometry says it is (what getPose() and every motion controller use) */
    poseRad() {
      const r = this.robot;
      return this._toCode(r.sx, r.sy, r.sh);
    }
    /** where the robot really is, in the code frame (identical to poseRad() unless real-life error is on) */
    truePoseRad() {
      const r = this.robot;
      return this._toCode(r.x, r.y, r.h);
    }
    _toCode(fx, fy, fh) {
      const f = this.frame;
      const vx = fx - f.px;
      const vy = fy - f.py;
      const c = Math.cos(f.psi);
      const s = Math.sin(f.psi);
      return { x: vx * c - vy * s, y: vx * s + vy * c, t: fh - f.psi };
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
    /**
     * Declares the robot to be at (x, y, thetaDeg). The code frame is re-anchored on where the robot
     * really is, and odometry restarts from there (like a wall reset): accumulated position and heading
     * error is cleared, but the gyro keeps drifting afterwards.
     */
    setPose(x, y, thetaDeg) {
      const r = this.robot;
      const psi = r.h - thetaDeg * D2R;
      const c = Math.cos(psi);
      const s = Math.sin(psi);
      this.frame = { px: r.x - (x * c + y * s), py: r.y - (-x * s + y * c), psi };
      r.resetOdometry();
    }

    /** odometry x and y go to 0, the heading is kept (the robot itself does not move) */
    resetLocalPosition() {
      this.frame = { px: this.robot.sx, py: this.robot.sy, psi: this.frame.psi };
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
    }
    endMotion(m, why) {
      m.finish(why);
      if (this.hooks.motionEnd) this.hooks.motionEnd(m);
      this.motion = null;
      this.aim = null;
      // like LemLib, every motion stops the drivetrain when it ends (a chained next motion
      // immediately drives it again, so the robot keeps most of its speed)
      this.drive(0, 0);
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
      motion.id = this.motionCount++;
      this.motions.push(motion);
      this.motion = motion;
      motion.begin();
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
    follow(pathPts, endIdx, pathName, lookahead, timeout, forwards = true, isAsync = true) {
      return this._start(new FollowMotion(this, pathPts, endIdx, lookahead, timeout, forwards, pathName), isAsync);
    }

    /** LemLib: delay(10) first, then wait while the distance travelled is <= dist */
    async waitUntil(dist) {
      do await this.clock.sleep(TICK_MS);
      while (this.motion && this.motion.dist <= dist);
    }
    async waitUntilDone() {
      do await this.clock.sleep(TICK_MS);
      while (this.motion);
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
