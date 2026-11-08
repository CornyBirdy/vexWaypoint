/*
 * Contact physics: the goals as fixed solid objects on the field, and the robot (its body and its
 * aligners) as a rigid body that hits them and the field walls.
 *
 * Goals are screwed to the field, so they never move: the robot gets stopped, slides along them (with
 * friction) and is turned by the contact, which is what lets an aligner funnel a goal into place.
 * Everything is 2D, seen from above. Inches, seconds. Heading is a compass bearing (clockwise).
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});
  const D2R = Math.PI / 180;

  // ---------------------------------------------------------------- the field

  /** inside wall to inside wall of the metal field perimeter is 140.5 in (the portable one 140.4 in) */
  const PERIMETER_HALF = 70.25;

  /** the nine goals, 1 tile from one wall and 2 tiles from another (Override game manual, figure FO-1) */
  const GOALS = [
    { x: 0, y: 0, kind: 'tall', team: 'neutral' },
    { x: -24, y: 48, kind: 'short', team: 'neutral' },
    { x: -48, y: 24, kind: 'short', team: 'neutral' },
    { x: 48, y: -24, kind: 'short', team: 'neutral' },
    { x: 24, y: -48, kind: 'short', team: 'neutral' },
    { x: -48, y: -24, kind: 'alliance', team: 'red' },
    { x: -24, y: -48, kind: 'alliance', team: 'red' },
    { x: 24, y: 48, kind: 'alliance', team: 'blue' },
    { x: 48, y: 24, kind: 'alliance', team: 'blue' },
  ];

  /**
   * The goal's footprint, measured off the field picture (assets/field/override-match.png), which the team
   * confirmed matches the real goal base: a square 5.65 in across with its four corners cut off by about
   * 1.0 in, so the flat sides are about 3.65 in long and sit parallel to the field walls. All the goals
   * have the same footprint; the sizes can still be set separately (the manual only has them in a drawing).
   */
  const GOAL_DEFAULTS = { tall: 5.65, short: 5.65, alliance: 5.65, chamfer: 1.0 };

  /** a square `flat` inches across with the corners cut off by `chamfer` inches, counter-clockwise */
  function goalPolygon(cx, cy, flat, chamfer) {
    const h = flat / 2;
    const c = Math.min(Math.max(0, chamfer), h - 0.05);
    const pts = [
      [h - c, -h], [h, -h + c], [h, h - c], [h - c, h], [-h + c, h], [-h, h - c], [-h, -h + c], [-h + c, -h],
    ];
    return pts.map(([x, y]) => ({ x: cx + x, y: cy + y }));
  }

  function buildGoals(sizes) {
    const s = { ...GOAL_DEFAULTS, ...(sizes || {}) };
    return GOALS.map((g, i) => {
      const flat = Math.max(1, Number(s[g.kind]) || GOAL_DEFAULTS[g.kind]);
      const chamfer = isFinite(Number(s.chamfer)) ? Number(s.chamfer) : GOAL_DEFAULTS.chamfer;
      const poly = goalPolygon(g.x, g.y, flat, chamfer);
      return { ...g, index: i, flat, poly, R: Math.max(...poly.map((p) => Math.hypot(p.x - g.x, p.y - g.y))) };
    });
  }

  // ---------------------------------------------------------------- geometry

  const dot = (ax, ay, bx, by) => ax * bx + ay * by;

  /** outward normal of the edge a -> b of a counter-clockwise polygon */
  function edgeNormal(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: dy / l, y: -dx / l };
  }

  /** signed distance of a point outside the polygon (negative inside) on the edge that is nearest to it */
  function insideDepth(p, poly) {
    let best = -Infinity;
    let bn = null;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const n = edgeNormal(a, poly[(i + 1) % poly.length]);
      const sd = dot(p.x - a.x, p.y - a.y, n.x, n.y);
      if (sd > best) {
        best = sd;
        bn = n;
      }
    }
    return { sd: best, n: bn }; // sd < 0: inside
  }

  const inside = (p, poly) => insideDepth(p, poly).sd < 0;

  /** closest points between segments p1-p2 and q1-q2 */
  function segSeg(p1, p2, q1, q2) {
    const d1x = p2.x - p1.x;
    const d1y = p2.y - p1.y;
    const d2x = q2.x - q1.x;
    const d2y = q2.y - q1.y;
    const rx = p1.x - q1.x;
    const ry = p1.y - q1.y;
    const a = dot(d1x, d1y, d1x, d1y);
    const e = dot(d2x, d2y, d2x, d2y);
    const f = dot(d2x, d2y, rx, ry);
    let s;
    let t;
    if (a < 1e-12 && e < 1e-12) {
      s = t = 0;
    } else if (a < 1e-12) {
      s = 0;
      t = Math.min(1, Math.max(0, f / e));
    } else {
      const c = dot(d1x, d1y, rx, ry);
      if (e < 1e-12) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else {
        const b = dot(d1x, d1y, d2x, d2y);
        const den = a * e - b * b;
        s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
        t = (b * s + f) / e;
        if (t < 0) {
          t = 0;
          s = Math.min(1, Math.max(0, -c / a));
        } else if (t > 1) {
          t = 1;
          s = Math.min(1, Math.max(0, (b - c) / a));
        }
      }
    }
    const A = { x: p1.x + d1x * s, y: p1.y + d1y * s };
    const B = { x: q1.x + d2x * t, y: q1.y + d2y * t };
    return { a: A, b: B, d: Math.hypot(A.x - B.x, A.y - B.y) };
  }

  /** distance from a point to a convex polygon: 0 when it is inside */
  function distanceToPolygon(p, poly) {
    if (inside(p, poly)) return 0;
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) best = Math.min(best, segSeg(p, p, poly[i], poly[(i + 1) % poly.length]).d);
    return best;
  }

  // ---------------------------------------------------------------- the world

  /**
   * @param {object} o
   *   half       half the inside width of the perimeter (inches)
   *   goals      buildGoals() output, or [] for none
   *   body       {length, width}
   *   capsules   [{ax, ay, bx, by, r, mu, set}] aligner pieces in the robot frame
   *   muBody     friction of the chassis body against goals
   *   muWall     friction against the walls
   */
  /**
   * The chassis body as convex pieces. Aligners are part of the front (or back) of the chassis, so where one
   * is, the body stops at the aligner's rear-most point instead of at the full length: the aligner is the
   * surface that meets the goal. The chassis beside the aligner (wider than it) stays full length.
   * @param {{front?: {y:number, x0:number, x1:number}, back?: {y:number, x0:number, x1:number}}} cuts
   */
  function bodyPieces(length, width, cuts) {
    const hl = length / 2;
    const hw = width / 2;
    const f = cuts && cuts.front;
    const b = cuts && cuts.back;
    const yf = f ? f.y : hl;
    const yb = b ? Math.min(b.y, yf - 0.5) : -hl;
    const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]; // counter-clockwise
    const pieces = [rect(-hw, yb, hw, Math.max(yf, yb + 0.5))];
    const wings = (cut, y0, y1) => {
      if (!cut) return;
      const x0 = Math.max(-hw, cut.x0);
      const x1 = Math.min(hw, cut.x1);
      if (x0 > -hw + 0.05) pieces.push(rect(-hw, y0, x0, y1));
      if (x1 < hw - 0.05) pieces.push(rect(x1, y0, hw, y1));
    };
    wings(f, f ? f.y : hl, hl);
    wings(b, -hl, b ? b.y : -hl);
    return pieces;
  }

  function makeWorld(o) {
    const L = o.body.length / 2;
    const W = o.body.width / 2;
    const pieces = bodyPieces(o.body.length, o.body.width, o.cuts);
    let radius = Math.hypot(W, L);
    (o.capsules || []).forEach((c) => {
      radius = Math.max(radius, Math.hypot(c.ax, c.ay) + c.r, Math.hypot(c.bx, c.by) + c.r);
    });
    return {
      half: o.half == null ? PERIMETER_HALF : o.half,
      goals: o.goals || [],
      bodyPieces: pieces,
      capsules: o.capsules || [],
      radius,
      muBody: o.muBody == null ? 0.3 : o.muBody,
      muWall: o.muWall == null ? 0.3 : o.muWall,
      muScale: 1, // multiplies the goal friction (set per run)
      mass: 1,
      inertia: (o.body.length * o.body.length + o.body.width * o.body.width) / 12,
    };
  }

  const toWorld = (pose, c, s, lx, ly) => ({ x: pose.x + lx * c + ly * s, y: pose.y - lx * s + ly * c });

  /** convex polygons A (the robot body) and B (a goal): the contacts, normals pointing from B to A */
  function bodyVsGoal(A, B, ca, cb, out, mu, goal) {
    let bestOverlap = Infinity;
    let bestN = null;
    const test = (poly) => {
      for (let i = 0; i < poly.length; i++) {
        const n = edgeNormal(poly[i], poly[(i + 1) % poly.length]);
        let minA = Infinity;
        let maxA = -Infinity;
        let minB = Infinity;
        let maxB = -Infinity;
        A.forEach((p) => {
          const d = dot(p.x, p.y, n.x, n.y);
          minA = Math.min(minA, d);
          maxA = Math.max(maxA, d);
        });
        B.forEach((p) => {
          const d = dot(p.x, p.y, n.x, n.y);
          minB = Math.min(minB, d);
          maxB = Math.max(maxB, d);
        });
        const overlap = Math.min(maxA, maxB) - Math.max(minA, minB);
        if (overlap <= 0) return false;
        if (overlap < bestOverlap) {
          bestOverlap = overlap;
          bestN = n;
        }
      }
      return true;
    };
    if (!test(A) || !test(B)) return;
    let n = bestN;
    if (dot(ca.x - cb.x, ca.y - cb.y, n.x, n.y) < 0) n = { x: -n.x, y: -n.y };
    let any = false;
    A.forEach((p) => {
      if (inside(p, B)) {
        out.push({ px: p.x, py: p.y, nx: n.x, ny: n.y, depth: bestOverlap, mu, goal });
        any = true;
      }
    });
    B.forEach((p) => {
      if (inside(p, A)) {
        out.push({ px: p.x, py: p.y, nx: n.x, ny: n.y, depth: bestOverlap, mu, goal });
        any = true;
      }
    });
    if (!any) out.push({ px: ca.x, py: ca.y, nx: n.x, ny: n.y, depth: bestOverlap, mu, goal });
  }

  /** a thin rigid bar (segment + radius) against a convex goal */
  function capsuleVsGoal(a, b, r, poly, out, mu, goal, set) {
    let pushed = false;
    [a, b].forEach((p) => {
      const q = insideDepth(p, poly);
      if (q.sd < 0) {
        out.push({ px: p.x, py: p.y, nx: q.n.x, ny: q.n.y, depth: -q.sd + r, mu, goal, set });
        pushed = true;
      }
    });
    if (pushed) return;
    for (let i = 0; i < poly.length; i++) {
      const c = segSeg(a, b, poly[i], poly[(i + 1) % poly.length]);
      if (c.d < r && c.d > 1e-9) {
        out.push({ px: c.a.x, py: c.a.y, nx: (c.a.x - c.b.x) / c.d, ny: (c.a.y - c.b.y) / c.d, depth: r - c.d, mu, goal, set });
      }
    }
  }

  /** every place the robot overlaps a goal or a wall right now */
  function collect(pose, world) {
    const c = Math.cos(pose.h);
    const s = Math.sin(pose.h);
    const out = [];
    const pieces = world.bodyPieces.map((poly) => poly.map((p) => toWorld(pose, c, s, p.x, p.y)));
    const centres = pieces.map((poly) => ({ x: poly.reduce((a, p) => a + p.x, 0) / poly.length, y: poly.reduce((a, p) => a + p.y, 0) / poly.length }));
    const body = pieces.flat();
    const caps = world.capsules.map((k) => ({ a: toWorld(pose, c, s, k.ax, k.ay), b: toWorld(pose, c, s, k.bx, k.by), r: k.r, mu: k.mu, set: k.set }));
    for (const g of world.goals) {
      if (Math.hypot(g.x - pose.x, g.y - pose.y) > world.radius + g.R + 0.1) continue;
      pieces.forEach((poly, i) => bodyVsGoal(poly, g.poly, centres[i], g, out, world.muBody * world.muScale, g));
      for (const k of caps) capsuleVsGoal(k.a, k.b, k.r, g.poly, out, k.mu * world.muScale, g, k.set);
    }
    // walls: any corner or aligner end past them
    const H = world.half;
    const wall = (p, r) => {
      const push = (nx, ny, depth) => out.push({ px: p.x, py: p.y, nx, ny, depth, mu: world.muWall, goal: null, wall: true });
      if (p.x - r < -H) push(1, 0, -H - (p.x - r));
      if (p.x + r > H) push(-1, 0, p.x + r - H);
      if (p.y - r < -H) push(0, 1, -H - (p.y - r));
      if (p.y + r > H) push(0, -1, p.y + r - H);
    };
    body.forEach((p) => wall(p, 0));
    caps.forEach((k) => {
      wall(k.a, k.r);
      wall(k.b, k.r);
    });
    return out;
  }

  /**
   * Stops the robot going into things. `pose` {x, y, h} and `vel` {vx, vy, w} (w clockwise, rad/s) are
   * changed in place. Impulses remove the speed into each surface and apply friction along it, which also
   * turns the robot when the contact is off its centre; then it is pushed back out of any overlap.
   * @returns {{goals: Set<number>, wall: boolean}} what it touched
   */
  function resolve(pose, vel, world) {
    const touched = { goals: new Set(), wall: false };
    const m = world.mass;
    const I = world.inertia;
    for (let iter = 0; iter < 4; iter++) {
      const cs = collect(pose, world);
      if (!cs.length) break;
      let deepest = null;
      for (const k of cs) {
        if (k.goal) touched.goals.add(k.goal.index);
        else touched.wall = true;
        if (!deepest || k.depth > deepest.depth) deepest = k;
        const rx = k.px - pose.x;
        const ry = k.py - pose.y;
        const vx = vel.vx + vel.w * ry;
        const vy = vel.vy - vel.w * rx;
        const vn = vx * k.nx + vy * k.ny;
        if (vn >= 0) continue;
        const rcn = ry * k.nx - rx * k.ny;
        const j = -vn / (1 / m + (rcn * rcn) / I);
        vel.vx += (k.nx * j) / m;
        vel.vy += (k.ny * j) / m;
        vel.w += (j * rcn) / I;
        // friction along the surface, never more than mu x the push
        const tx = -k.ny;
        const ty = k.nx;
        const vx2 = vel.vx + vel.w * ry;
        const vy2 = vel.vy - vel.w * rx;
        const vt = vx2 * tx + vy2 * ty;
        const rct = ry * tx - rx * ty;
        const jt = Math.min(k.mu * j, Math.max(-k.mu * j, -vt / (1 / m + (rct * rct) / I)));
        vel.vx += (tx * jt) / m;
        vel.vy += (ty * jt) / m;
        vel.w += (jt * rct) / I;
      }
      const d = Math.max(0, deepest.depth - 0.002) * 0.9;
      pose.x += deepest.nx * d;
      pose.y += deepest.ny * d;
    }
    return touched;
  }

  Object.assign(NS, {
    PERIMETER_HALF, FIELD_GOALS: GOALS, GOAL_DEFAULTS, goalPolygon, buildGoals, bodyPieces, makeWorld, resolveContacts: resolve,
    distanceToPolygon, collectContacts: collect,
  });
})();
