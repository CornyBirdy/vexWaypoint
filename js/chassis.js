/*
 * The robot's chassis: which wheels it has (omni / traction, in what order) and which tracking wheels.
 *
 * From that this file works out how the robot behaves on the floor (forward grip, sideways grip, turn
 * scrub, how much the grip changes from run to run) and how its odometry is measured. The physics in
 * sim.js uses the result. The numbers per wheel type are estimates, see WHEEL_TYPES.
 *
 * It also holds the chassis drawing (top-down, with an inch grid) that the Chassis panel shows.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  /**
   * Per wheel type (estimates, not measurements):
   *   grip     friction coefficient driving forwards / braking
   *   lat      friction coefficient sideways (an omni's rollers let it slide, a traction wheel does not)
   *   spread   how much the grip of this wheel changes from run to run, % (1 sigma); rollers collect dust
   */
  const WHEEL_TYPES = {
    omni: { label: 'Omni', grip: 0.75, lat: 0.25, spread: 6 },
    traction: { label: 'Traction', grip: 1.0, lat: 0.9, spread: 3 },
  };
  const MAX_PER_SIDE = 4;
  const TRACKING_DIAMETER = 2; // drawn size of a tracking wheel, in

  const DEFAULT_CHASSIS = {
    left: ['omni', 'traction', 'omni'],
    mirror: true,
    right: ['omni', 'traction', 'omni'],
    tracking: { vertical: { on: false, offset: 3 }, horizontal: { on: false, offset: -2 } },
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const num = (v, d) => (isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);

  /** a well-formed chassis, whatever was saved or typed */
  function sanitize(ch) {
    const base = clone(DEFAULT_CHASSIS);
    if (!ch || typeof ch !== 'object') return base;
    const side = (list, fallback) => {
      const ok = (Array.isArray(list) ? list : []).filter((t) => WHEEL_TYPES[t]).slice(0, MAX_PER_SIDE);
      return ok.length ? ok : fallback;
    };
    const out = { left: side(ch.left, base.left), mirror: ch.mirror !== false, tracking: base.tracking };
    out.right = out.mirror ? out.left.slice() : side(ch.right, out.left.slice());
    const t = ch.tracking || {};
    ['vertical', 'horizontal'].forEach((k) => {
      const w = t[k] || {};
      out.tracking[k] = { on: !!w.on, offset: Math.max(-12, Math.min(12, num(w.offset, base.tracking[k].offset))) };
    });
    return out;
  }

  /** every drive wheel: {x, y, type}. x = inches right of the robot's centre, y = inches ahead of it */
  function layout(ch, p) {
    const c = sanitize(ch);
    const span = Math.max(2, (p.length || 15) - (p.wheelDiameter || 3.25) - 1);
    const half = (p.trackWidth || 12) / 2;
    const wheels = [];
    [[-1, c.left], [1, c.right]].forEach(([sx, list]) => {
      list.forEach((type, i) => {
        const y = list.length === 1 ? 0 : span / 2 - (i * span) / (list.length - 1); // front wheel first
        wheels.push({ x: sx * half, y, type });
      });
    });
    return wheels;
  }

  /**
   * What the chassis does on the floor.
   * @returns {{grip:number, latGrip:number, scrub:number, spread:number, tracking:object, wheels:number}}
   */
  function derive(ch, p) {
    const c = sanitize(ch);
    const wheels = layout(c, p);
    const n = wheels.length;
    const mean = (f) => wheels.reduce((a, w) => a + f(w), 0) / n;
    const trackWidth = p.trackWidth || 12;
    return {
      wheels: n,
      grip: mean((w) => WHEEL_TYPES[w.type].grip),
      latGrip: mean((w) => WHEEL_TYPES[w.type].lat),
      spread: mean((w) => WHEEL_TYPES[w.type].spread),
      // turning drags every wheel sideways; a wheel far from the centre, with sideways grip, resists most
      scrub: 1 + (0.5 * mean((w) => WHEEL_TYPES[w.type].lat * Math.abs(w.y))) / trackWidth,
      tracking: c.tracking,
    };
  }

  /** one line for the UI */
  function describe(ch, p) {
    const d = derive(ch, p);
    const odo = [d.tracking.vertical.on && 'forward tracking wheel', d.tracking.horizontal.on && 'sideways tracking wheel'].filter(Boolean);
    return (
      `${d.wheels} drive wheels. Forward grip ${d.grip.toFixed(2)}, sideways grip ${d.latGrip.toFixed(2)}, ` +
      `turn scrub x${d.scrub.toFixed(2)}, grip changes ${d.spread.toFixed(1)}% per run. ` +
      `Odometry: ${odo.length ? odo.join(' + ') + ' + gyro' : 'drive wheel encoders + gyro (wheel slip fools it)'}.`
    );
  }

  // ---------------------------------------------------------------- drawing

  /** Top-down drawing of the chassis on an inch grid (up = the robot's front). */
  class ChassisView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.view = { cx: 0, cy: 0, scale: 10 };
      this.hits = [];
      this.onToggle = null; // (side, index) when a drive wheel is clicked
      canvas.addEventListener('click', (e) => {
        const h = this.hitTest(e);
        if (h && this.onToggle) this.onToggle(h.side, h.index);
      });
      canvas.addEventListener('pointermove', (e) => {
        canvas.style.cursor = this.hitTest(e) ? 'pointer' : 'default';
      });
    }

    hitTest(e) {
      const r = this.canvas.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * this.w;
      const py = ((e.clientY - r.top) / r.height) * this.h;
      const { cx, cy, scale } = this.view;
      const x = (px - this.w / 2) / scale + cx;
      const y = cy - (py - this.h / 2) / scale;
      return this.hits.find((w) => Math.abs(x - w.x) <= w.hw && Math.abs(y - w.y) <= w.hl) || null;
    }

    /** @param {{robot: object, chassis: object}} s */
    draw(s) {
      const T = NS.theme;
      const col = (n) => (T ? T.color(n) : '#888');
      const cv = this.canvas;
      const rect = cv.getBoundingClientRect();
      this.w = Math.max(200, Math.floor(rect.width || 300));
      this.h = this.w;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(this.w * dpr)) {
        cv.width = Math.round(this.w * dpr);
        cv.height = Math.round(this.h * dpr);
      }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const p = s.robot;
      const c = sanitize(s.chassis);
      const wheels = layout(c, p);
      // fit the robot, its wheels and the tracking wheels, rounded up to whole 6 in squares
      const trackOff = [c.tracking.vertical, c.tracking.horizontal].reduce((m, t) => Math.max(m, t.on ? Math.abs(t.offset) : 0), 0);
      const reach = Math.max(p.length, p.width, p.trackWidth + p.wheelDiameter) / 2 + 3 + trackOff * 0.2;
      const halfSpan = Math.ceil(reach / 6) * 6;
      const scale = this.w / (halfSpan * 2);
      this.view = { cx: 0, cy: 0, scale };
      const X = (x) => this.w / 2 + x * scale;
      const Y = (y) => this.h / 2 - y * scale;

      ctx.fillStyle = col('surface');
      ctx.fillRect(0, 0, this.w, this.h);

      // inch grid: every inch faint, every 6 in stronger, labelled
      ctx.lineWidth = 1;
      for (let g = -halfSpan; g <= halfSpan; g++) {
        const major = g % 6 === 0;
        ctx.strokeStyle = col('ink-muted');
        ctx.globalAlpha = major ? 0.45 : 0.16;
        ctx.beginPath();
        ctx.moveTo(X(g), 0);
        ctx.lineTo(X(g), this.h);
        ctx.moveTo(0, Y(g));
        ctx.lineTo(this.w, Y(g));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = col('ink-muted');
      ctx.font = `10px ${col('mono') || 'monospace'}`;
      for (let g = -halfSpan + 6; g < halfSpan; g += 6) {
        if (g !== 0) {
          ctx.fillText(String(g), X(g) + 2, Y(0) - 3);
          ctx.fillText(String(g), X(0) + 3, Y(g) - 2);
        }
      }
      ctx.fillText('in', this.w - 14, this.h - 4);

      // body
      ctx.fillStyle = col('ov-robot');
      ctx.globalAlpha = 0.35;
      ctx.fillRect(X(-p.width / 2), Y(p.length / 2), p.width * scale, p.length * scale);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = col('ov-robot');
      ctx.lineWidth = 1.5;
      ctx.strokeRect(X(-p.width / 2), Y(p.length / 2), p.width * scale, p.length * scale);
      // front marker
      ctx.beginPath();
      ctx.moveTo(X(-2), Y(p.length / 2));
      ctx.lineTo(X(0), Y(p.length / 2 + 1.6));
      ctx.lineTo(X(2), Y(p.length / 2));
      ctx.stroke();

      // drive wheels
      const wheelW = 1.1;
      this.hits = [];
      let li = 0;
      let ri = 0;
      wheels.forEach((w) => {
        const left = w.x < 0;
        const idx = left ? li++ : ri++;
        const x0 = X(w.x - wheelW / 2);
        const y0 = Y(w.y + p.wheelDiameter / 2);
        const ww = wheelW * scale;
        const hh = p.wheelDiameter * scale;
        if (w.type === 'omni') {
          ctx.fillStyle = col('surface-raised');
          ctx.fillRect(x0, y0, ww, hh);
          ctx.strokeStyle = col('ink');
          ctx.lineWidth = 1;
          ctx.strokeRect(x0, y0, ww, hh);
          ctx.beginPath(); // roller marks
          for (let k = 1; k < 4; k++) {
            ctx.moveTo(x0, y0 + (hh * k) / 4 + 2);
            ctx.lineTo(x0 + ww, y0 + (hh * k) / 4 - 2);
          }
          ctx.stroke();
        } else {
          ctx.fillStyle = col('ink');
          ctx.globalAlpha = 0.8;
          ctx.fillRect(x0, y0, ww, hh);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = col('surface');
          ctx.lineWidth = 1;
          ctx.beginPath(); // tread
          for (let k = 1; k < 6; k++) {
            ctx.moveTo(x0, y0 + (hh * k) / 6);
            ctx.lineTo(x0 + ww, y0 + (hh * k) / 6);
          }
          ctx.stroke();
        }
        this.hits.push({ side: left ? 'left' : 'right', index: idx, x: w.x, y: w.y, hw: wheelW / 2 + 0.4, hl: p.wheelDiameter / 2 });
      });

      // tracking wheels: forward one sits to the right (+) / left (-) of centre, sideways one ahead (+) / behind (-)
      const tw = (x, y, vertical, label) => {
        const w = vertical ? 0.7 : TRACKING_DIAMETER;
        const h = vertical ? TRACKING_DIAMETER : 0.7;
        ctx.fillStyle = col('ov-odom');
        ctx.globalAlpha = 0.85;
        ctx.fillRect(X(x - w / 2), Y(y + h / 2), w * scale, h * scale);
        ctx.globalAlpha = 1;
        ctx.fillStyle = col('ink');
        ctx.font = `10px ${col('mono') || 'monospace'}`;
        ctx.fillText(label, X(x + w / 2) + 3, Y(y) + 3);
      };
      if (c.tracking.vertical.on) tw(c.tracking.vertical.offset, 0, true, 'fwd track');
      if (c.tracking.horizontal.on) tw(0, c.tracking.horizontal.offset, false, 'side track');
    }
  }

  Object.assign(NS, { WHEEL_TYPES, DEFAULT_CHASSIS, MAX_WHEELS_PER_SIDE: MAX_PER_SIDE, sanitizeChassis: sanitize, chassisLayout: layout, deriveChassis: derive, describeChassis: describe, ChassisView });
})();
