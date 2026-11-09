/*
 * Goal aligners: the pieces fixed to the front (and optionally back) of the chassis that guide a goal into
 * place. This file is only the shapes: lines, arcs and circles drawn in the robot's own frame, how they
 * are cut into small segments for the physics, the alignment point and the materials.
 *
 * Robot frame, inches: origin at the robot's centre, +x to the right, +y forward. Angles are in degrees,
 * 0 = +x, counter-clockwise positive (ordinary maths, as the drawing shows it).
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;

  /** friction against the (plastic) goals; estimates: the aligners "kinda grip" the goal, not too well */
  const MATERIALS = {
    polycarbonate: { label: 'Polycarbonate', mu: 0.32 },
    acetal: { label: 'Acetal (Delrin)', mu: 0.2 },
    steel: { label: 'Steel', mu: 0.35 },
    aluminium: { label: 'Aluminium', mu: 0.4 },
  };
  const SIDES = ['front', 'back'];

  const num = (v, d) => (v !== null && v !== '' && isFinite(Number(v)) ? Number(v) : d);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const wrap360 = (a) => ((a % 360) + 360) % 360;

  function emptySet(on) {
    return { on, shapes: [], thickness: 0.25, material: 'polycarbonate', tol: 0.5, auto: true, point: { x: 0, y: 0 }, preset: 'none', offset: 0, presetSig: '' };
  }
  const DEFAULT_ALIGNERS = { front: emptySet(false), back: emptySet(false) }; // off until you draw some

  // ---------------------------------------------------------------- shapes

  /** the circle through three points as an arc from p1 through p2 to p3; null when they are in a line */
  function arcFromThree(p1, p2, p3) {
    const d = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
    if (Math.abs(d) < 1e-9) return null;
    const s1 = p1.x * p1.x + p1.y * p1.y;
    const s2 = p2.x * p2.x + p2.y * p2.y;
    const s3 = p3.x * p3.x + p3.y * p3.y;
    const cx = (s1 * (p2.y - p3.y) + s2 * (p3.y - p1.y) + s3 * (p1.y - p2.y)) / d;
    const cy = (s1 * (p3.x - p2.x) + s2 * (p1.x - p3.x) + s3 * (p2.x - p1.x)) / d;
    const r = Math.hypot(p1.x - cx, p1.y - cy);
    const ang = (p) => Math.atan2(p.y - cy, p.x - cx) * R2D;
    const a1 = ang(p1);
    const ccw = wrap360(ang(p3) - a1);
    const toMid = wrap360(ang(p2) - a1);
    return { type: 'arc', cx, cy, r, a0: a1, sweep: toMid < ccw ? ccw : ccw - 360 };
  }

  const pointAt = (cx, cy, r, deg) => ({ x: cx + r * Math.cos(deg * D2R), y: cy + r * Math.sin(deg * D2R) });

  /** the end points of a line or arc, in drawing order */
  function ends(s) {
    if (s.type === 'line') return [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }];
    if (s.type === 'arc') return [pointAt(s.cx, s.cy, s.r, s.a0), pointAt(s.cx, s.cy, s.r, s.a0 + s.sweep)];
    return [];
  }

  /** a shape as a polyline (a circle comes back closed); the cut stays within `err` inches of the true curve */
  function polyline(s, err = 0.02) {
    if (s.type === 'line') return [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }];
    const r = Math.max(s.r, 0.01);
    const step = Math.max(2, Math.min(30, 2 * Math.acos(Math.max(0, 1 - err / r)) * R2D));
    const sweep = s.type === 'circle' ? 360 : s.sweep;
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / step));
    const a0 = s.type === 'circle' ? 0 : s.a0;
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(pointAt(s.cx, s.cy, r, a0 + (sweep * i) / n));
    return pts;
  }

  /** every small straight piece of a set: [{ax, ay, bx, by}] */
  function segments(set) {
    const out = [];
    set.shapes.forEach((s) => {
      const p = polyline(s);
      for (let i = 0; i + 1 < p.length; i++) out.push({ ax: p[i].x, ay: p[i].y, bx: p[i + 1].x, by: p[i + 1].y });
    });
    return out;
  }

  /** the lowest-level numbers a person would type for a shape, for the properties panel */
  function dimensions(s) {
    if (s.type === 'line') {
      const dx = s.x2 - s.x1;
      const dy = s.y2 - s.y1;
      return { length: Math.hypot(dx, dy), angle: wrap360(Math.atan2(dy, dx) * R2D) };
    }
    if (s.type === 'arc') {
      const e = ends(s);
      return { radius: s.r, sweep: s.sweep, arcLength: Math.abs(s.sweep) * D2R * s.r, chord: Math.hypot(e[1].x - e[0].x, e[1].y - e[0].y) };
    }
    return { radius: s.r, diameter: 2 * s.r, circumference: 2 * Math.PI * s.r };
  }

  /** distance from a point to a shape's line (for picking with the mouse) */
  function distanceTo(s, x, y) {
    const pts = polyline(s, 0.05);
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = pts[i].x;
      const ay = pts[i].y;
      const dx = pts[i + 1].x - ax;
      const dy = pts[i + 1].y - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) : 0;
      best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
    }
    return best;
  }

  // ---------------------------------------------------------------- sets

  /**
   * "The middle back point of the aligners": half way across the set, at its deepest point (the rear-most
   * point of a front set, the front-most point of a back set). A person can also place it by hand.
   */
  function autoPoint(set, side) {
    const pts = [];
    set.shapes.forEach((s) => polyline(s, 0.05).forEach((p) => pts.push(p)));
    if (!pts.length) return { x: 0, y: side === 'back' ? -7 : 7 };
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { x: r3((Math.min(...xs) + Math.max(...xs)) / 2), y: r3(side === 'back' ? Math.max(...ys) : Math.min(...ys)) };
  }

  function sanitizeShape(s) {
    if (!s || typeof s !== 'object') return null;
    const f = (k, d = 0) => r3(num(s[k], d));
    if (s.type === 'line') {
      const out = { type: 'line', x1: f('x1'), y1: f('y1'), x2: f('x2'), y2: f('y2') };
      return Math.hypot(out.x2 - out.x1, out.y2 - out.y1) > 0.01 ? out : null;
    }
    if (s.type === 'arc') {
      const out = { type: 'arc', cx: f('cx'), cy: f('cy'), r: Math.max(0.05, f('r', 1)), a0: f('a0'), sweep: clamp(f('sweep', 90), -359.9, 359.9) };
      return Math.abs(out.sweep) > 0.1 ? out : null;
    }
    if (s.type === 'circle') return { type: 'circle', cx: f('cx'), cy: f('cy'), r: Math.max(0.05, f('r', 1)) };
    return null;
  }

  function sanitizeSet(set, side) {
    const base = emptySet(false);
    if (!set || typeof set !== 'object') return base;
    const out = {
      on: set.on === undefined ? base.on : !!set.on,
      shapes: (Array.isArray(set.shapes) ? set.shapes : []).map(sanitizeShape).filter(Boolean).slice(0, 200),
      thickness: clamp(num(set.thickness, base.thickness), 0.05, 1),
      material: MATERIALS[set.material] ? set.material : base.material,
      tol: clamp(num(set.tol, base.tol), 0, 6),
      auto: set.auto !== false,
      point: { x: r3(num(set.point && set.point.x, 0)), y: r3(num(set.point && set.point.y, 0)) },
      preset: PRESETS[set.preset] ? set.preset : 'none',
      offset: clamp(num(set.offset, 0), -24, 24),
      presetSig: typeof set.presetSig === 'string' ? set.presetSig : '',
    };
    return out;
  }

  /** a well-formed {front, back} whatever was saved */
  function sanitize(a) {
    const out = {};
    SIDES.forEach((side) => (out[side] = sanitizeSet(a && a[side], side)));
    return out;
  }

  /** the alignment point of a set as it is used: the auto one, or the one placed by hand */
  const pointOf = (set, side) => (set.auto ? autoPoint(set, side) : set.point);

  // ---------------------------------------------------------------- presets

  /**
   * Ready-made aligners. Both are pockets that open away from the robot, so a goal nests in them; their
   * deepest point sits on the drivetrain edge, moved by `offset` inches (+ = towards the robot's front).
   */
  const PRESETS = {
    circle: { label: 'Circle, radius 3 in' },
    triangle: { label: 'Triangle, base 6 in, height 3 in' },
  };

  /** the shapes of a preset for one side of a robot `length` inches long */
  function presetShapes(kind, side, length, offset) {
    const out = side === 'back' ? -1 : 1; // which way "away from the robot" is
    const y0 = (out * (length || 15)) / 2 + (offset || 0); // the pocket's deepest point
    if (kind === 'circle') {
      // half a circle of radius 3: the bottom of the cup on the edge, the two tips 3 in further out
      return [{ type: 'arc', cx: 0, cy: r3(y0 + 3 * out), r: 3, a0: out > 0 ? 180 : 0, sweep: 180 }];
    }
    if (kind === 'triangle') {
      // a V: 6 in across the open side (the base), 3 in deep (the height)
      return [
        { type: 'line', x1: -3, y1: r3(y0 + 3 * out), x2: 0, y2: r3(y0) },
        { type: 'line', x1: 3, y1: r3(y0 + 3 * out), x2: 0, y2: r3(y0) },
      ];
    }
    return [];
  }

  /**
   * Keep a set that uses a preset in step with it (after the robot length or the offset changed). If the
   * shapes were edited by hand since the preset drew them, they become your own drawing (preset 'none').
   * @returns {boolean} whether anything changed
   */
  function applyPreset(set, side, length) {
    if (!set || !PRESETS[set.preset]) return false;
    if (set.presetSig && JSON.stringify(set.shapes) !== set.presetSig) {
      set.preset = 'none';
      set.presetSig = '';
      return true;
    }
    const shapes = presetShapes(set.preset, side, length, set.offset).map(sanitizeShape);
    const sig = JSON.stringify(shapes);
    if (sig === set.presetSig) return false;
    set.shapes = shapes;
    set.presetSig = sig;
    return true;
  }

  /** a V-shaped funnel, as a starting point: two 45 degree wings that meet at the middle */
  function exampleFunnel(p) {
    const half = (p && p.width ? p.width : 15) / 2;
    const y = (p && p.length ? p.length : 15) / 2;
    const reach = Math.min(5, half - 1);
    return [
      { type: 'line', x1: -reach, y1: y + reach, x2: 0, y2: y },
      { type: 'line', x1: reach, y1: y + reach, x2: 0, y2: y },
    ];
  }

  Object.assign(NS, {
    MATERIALS, ALIGNER_SIDES: SIDES, DEFAULT_ALIGNERS, emptyAlignerSet: emptySet,
    sanitizeAligners: sanitize, alignerPoint: pointOf, autoAlignerPoint: autoPoint, alignerSegments: segments,
    shapePolyline: polyline, shapeEnds: ends, shapeDimensions: dimensions, shapeDistance: distanceTo,
    arcFromThree, exampleFunnel, ALIGNER_PRESETS: PRESETS, alignerPresetShapes: presetShapes, applyAlignerPreset: applyPreset,
  });
})();
