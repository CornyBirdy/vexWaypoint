/*
 * Path editor model and operations.
 *
 * Ported from path.jerryio (Jerry Lum, GPL-3.0, https://github.com/Jerrylum/path.jerryio):
 * the Path / Segment / Control model, and the behaviour of the add, split,
 * convert, remove and drag commands and of the speed keyframes. See NOTICE.md.
 *
 * Everything is stored in the same shape jerry.io saves, with coordinates in
 * INCHES (unit of length 2.54), so a project can be exported as a .jerryio file
 * and opened in jerry.io. End points that join two segments are the same
 * object, so moving one moves both.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  function makeUid() {
    let s = '';
    for (let i = 0; i < 10; i++) s += ALNUM[Math.floor(Math.random() * ALNUM.length)];
    return s;
  }

  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------------------------------------------------------------- model

  const defaultPc = () => ({
    speedLimit: { minLimit: { value: 0, label: '0' }, maxLimit: { value: 127, label: '127' }, step: 1, from: 20, to: 100 },
    bentRateApplicableRange: { minLimit: { value: 0, label: '0' }, maxLimit: { value: 1, label: '1' }, step: 0.001, from: 0, to: 0.1 },
    maxDecelerationRate: 127,
  });

  const defaultGc = () => ({
    robotWidth: 12,
    robotHeight: 12,
    robotIsHolonomic: false,
    showRobot: false,
    uol: 2.54, // centimetres per unit: inches
    pointDensity: 2,
    controlMagnetDistance: 5 / 2.54,
    coordinateSystem: 'VEX Gaming Positioning System',
  });

  const endControl = (x, y, heading = 0) => ({ __type: 'end-point', uid: makeUid(), lock: false, visible: true, x, y, heading });
  const control = (x, y) => ({ __type: 'control', uid: makeUid(), lock: false, visible: true, x, y });
  const makeSegment = (controls) => ({ uid: makeUid(), controls, speedProfiles: [], lookaheadKeyframes: [] });
  const newPath = (name) => ({ segments: [], pc: defaultPc(), name: name || 'Path', uid: makeUid(), lock: false, visible: true });

  /** make consecutive segments share the same end point object again (after a clone / import) */
  function relink(path) {
    for (let i = 1; i < path.segments.length; i++) {
      const prev = path.segments[i - 1];
      const seg = path.segments[i];
      const a = prev.controls[prev.controls.length - 1];
      const b = seg.controls[0];
      if (a !== b && (a.uid === b.uid || (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6))) seg.controls[0] = a;
    }
    return path;
  }

  /** all controls of a path in drawing order, each end point once */
  function controlsOf(path) {
    const out = [];
    path.segments.forEach((seg, i) => seg.controls.forEach((c, j) => (i > 0 && j === 0 ? 0 : out.push(c))));
    return out;
  }

  const first = (seg) => seg.controls[0];
  const last = (seg) => seg.controls[seg.controls.length - 1];
  const isCubic = (seg) => seg.controls.length === 4;

  // ---------------------------------------------------------------- geometry

  function bezier(c, t) {
    if (c.length === 2) return { x: c[0].x + (c[1].x - c[0].x) * t, y: c[0].y + (c[1].y - c[0].y) * t };
    const u = 1 - t;
    return {
      x: u * u * u * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t * t * t * c[3].x,
      y: u * u * u * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t * t * t * c[3].y,
    };
  }

  /** closest point on a path's curves: { seg, t, x, y, dist } or null */
  function nearestOnPath(path, x, y) {
    let best = null;
    path.segments.forEach((seg, si) => {
      const N = seg.controls.length === 2 ? 1 : 60;
      for (let i = 0; i <= N; i++) {
        const p = bezier(seg.controls, i / N);
        const d = Math.hypot(p.x - x, p.y - y);
        if (!best || d < best.dist) best = { seg, segIndex: si, t: i / N, x: p.x, y: p.y, dist: d };
      }
      if (seg.controls.length === 2) {
        // exact distance to a straight segment
        const a = seg.controls[0];
        const b = seg.controls[1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2));
        const px = a.x + dx * t;
        const py = a.y + dy * t;
        const d = Math.hypot(px - x, py - y);
        if (!best || d < best.dist) best = { seg, segIndex: si, t, x: px, y: py, dist: d };
      }
    });
    return best;
  }

  // ---------------------------------------------------------------- operations (mutate the path)

  /**
   * Add a segment ending at (x, y). The first segment starts at `start` (the robot's
   * start position). Later segments continue from the last end point with a mirrored
   * control so the path stays smooth.
   */
  function addSegment(path, x, y, cubic, start) {
    const p3 = endControl(x, y);
    let seg;
    if (path.segments.length === 0) {
      const p0 = endControl(start ? start.x : 0, start ? start.y : 0);
      if (!cubic) seg = makeSegment([p0, p3]);
      else {
        const dx = x - p0.x;
        const dy = y - p0.y;
        const d = Math.hypot(dx, dy) || 1;
        let p1 = control(p0.x + dx / 3, p0.y + dy / 3);
        if (start && start.heading != null) {
          const h = (start.heading * Math.PI) / 180;
          const fx = Math.sin(h);
          const fy = Math.cos(h);
          // leave along the robot's heading if the target is in front of it
          if ((dx * fx + dy * fy) / d > 0.2) p1 = control(p0.x + fx * (d / 3), p0.y + fy * (d / 3));
        }
        seg = makeSegment([p0, p1, control(x - dx / 3, y - dy / 3), p3]);
      }
    } else {
      const prev = path.segments[path.segments.length - 1];
      const p0 = last(prev);
      if (!cubic) seg = makeSegment([p0, p3]);
      else {
        const c = prev.controls.length === 2 ? prev.controls[0] : prev.controls[2];
        const p1 = control(2 * p0.x - c.x, 2 * p0.y - c.y); // mirror of the previous control
        const p2 = control((p0.x + x) / 2, (p0.y + y) / 2);
        seg = makeSegment([p0, p1, p2, p3]);
      }
    }
    path.segments.push(seg);
    return seg;
  }

  /**
   * Where a robot should stand to drive this path: its first point, facing the way the path
   * leaves it (compass degrees, 0 = up, clockwise). `backwards` faces the other way, for
   * paths that are driven in reverse. Null for a path with no segments.
   */
  function startPose(path, backwards) {
    if (!path || !path.segments.length) return null;
    const c = path.segments[0].controls;
    const p0 = c[0];
    let h = 0;
    for (let i = 1; i < c.length; i++) {
      const dx = c[i].x - p0.x;
      const dy = c[i].y - p0.y;
      if (Math.hypot(dx, dy) > 1e-6) {
        h = (Math.atan2(dx, dy) * 180) / Math.PI;
        break;
      }
    }
    if (backwards) h += 180;
    h = ((h % 360) + 360) % 360;
    if (h > 180) h -= 360; // -180..180, like the start pose box
    return { x: Math.round(p0.x * 10) / 10, y: Math.round(p0.y * 10) / 10, h: Math.round(h * 10) / 10 };
  }

  function splitSegment(path, seg, pt) {
    const index = path.segments.indexOf(seg);
    if (index < 0) return null;
    const point = endControl(pt.x, pt.y);
    let created;
    if (seg.controls.length === 2) {
      const end = last(seg);
      seg.controls[1] = point;
      created = makeSegment([point, end]);
    } else {
      const [p0, p1, p2, p3] = seg.controls;
      const a = control((p1.x + point.x) / 2, (p1.y + point.y) / 2);
      const c = control((p2.x + point.x) / 2, (p2.y + point.y) / 2);
      seg.controls = [p0, p1, a, point];
      created = makeSegment([point, c, p2, p3]);
    }
    path.segments.splice(index + 1, 0, created);
    return created;
  }

  function convertSegment(path, seg) {
    if (isCubic(seg)) {
      seg.controls = [first(seg), last(seg)];
      return;
    }
    const index = path.segments.indexOf(seg);
    const prev = path.segments[index - 1];
    const next = path.segments[index + 1];
    const p0 = first(seg);
    const p3 = last(seg);
    let t;
    if (prev) {
      const c = prev.controls[prev.controls.length - 2];
      t = { x: 2 * p0.x - c.x, y: 2 * p0.y - c.y };
    } else t = { x: (p0.x + p3.x) / 2, y: (p0.y + p3.y) / 2 };
    const p1 = control(t.x, t.y);
    if (next) {
      const c = next.controls[1];
      t = { x: 2 * p3.x - c.x, y: 2 * p3.y - c.y };
    } else t = { x: (p0.x + p3.x) / 2, y: (p0.y + p3.y) / 2 };
    const p2 = control(t.x, t.y);
    seg.controls = [p0, p1, p2, p3];
  }

  /** remove an end point: its segment goes with it (the previous segment is re-linked) */
  function removeEndControl(path, ctrl) {
    for (let i = 0; i < path.segments.length; i++) {
      const seg = path.segments[i];
      const isFirst = first(seg) === ctrl;
      const isLastOfLast = i === path.segments.length - 1 && last(seg) === ctrl;
      if (!isFirst && !isLastOfLast) continue;
      if (isFirst && i > 0) {
        const prev = path.segments[i - 1];
        prev.controls[prev.controls.length - 1] = last(seg);
      }
      path.segments.splice(i, 1);
      return true;
    }
    return false;
  }

  /** drag a control; an end point takes its neighbouring control handles with it unless `alone` */
  function dragControl(path, ctrl, x, y, alone) {
    const dx = x - ctrl.x;
    const dy = y - ctrl.y;
    ctrl.x = x;
    ctrl.y = y;
    if (ctrl.__type === 'end-point' && !alone) {
      const all = controlsOf(path);
      const idx = all.indexOf(ctrl);
      [all[idx - 1], all[idx + 1]].forEach((n) => {
        if (n && n.__type === 'control' && !n.lock) {
          n.x += dx;
          n.y += dy;
        }
      });
    }
  }

  // ---------------------------------------------------------------- speed keyframes

  function addKeyframe(seg, xPos, yPos) {
    const kf = { uid: makeUid(), xPos: Math.max(0, Math.min(0.9999, xPos)), yPos: Math.max(0, Math.min(1, yPos)), followBentRate: true };
    seg.speedProfiles.push(kf);
    seg.speedProfiles.sort((a, b) => a.xPos - b.xPos);
    return kf;
  }

  function findKeyframe(path, kfUid) {
    for (const seg of path.segments) {
      const kf = seg.speedProfiles.find((k) => k.uid === kfUid);
      if (kf) return { seg, kf };
    }
    return null;
  }

  function moveKeyframe(path, kfUid, toSeg, xPos, yPos) {
    const f = findKeyframe(path, kfUid);
    if (!f) return;
    f.seg.speedProfiles = f.seg.speedProfiles.filter((k) => k !== f.kf);
    f.kf.xPos = Math.max(0, Math.min(0.9999, xPos));
    f.kf.yPos = Math.max(0, Math.min(1, yPos));
    toSeg.speedProfiles.push(f.kf);
    toSeg.speedProfiles.sort((a, b) => a.xPos - b.xPos);
  }

  function removeKeyframe(path, kfUid) {
    const f = findKeyframe(path, kfUid);
    if (f) f.seg.speedProfiles = f.seg.speedProfiles.filter((k) => k !== f.kf);
  }

  // ---------------------------------------------------------------- project + history

  class Project {
    constructor() {
      this.gc = defaultGc();
      this.paths = [];
      this.undoStack = [];
      this.redoStack = [];
    }
    uniqueName(base) {
      const taken = new Set(this.paths.map((p) => p.name));
      if (!taken.has(base)) return base;
      let n = 2;
      while (taken.has(`${base} ${n}`)) n++;
      return `${base} ${n}`;
    }
    addPath(name) {
      const p = newPath(this.uniqueName(name || 'Path'));
      this.paths.push(p);
      return p;
    }
    getPath(uid) {
      return this.paths.find((p) => p.uid === uid) || null;
    }
    /** call BEFORE a change so it can be undone */
    checkpoint() {
      const snap = JSON.stringify(this.paths);
      if (this.undoStack[this.undoStack.length - 1] === snap) return; // nothing changed since the last one
      this.undoStack.push(snap);
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    undo() {
      if (!this.undoStack.length) return false;
      this.redoStack.push(JSON.stringify(this.paths));
      this.paths = JSON.parse(this.undoStack.pop()).map(relink);
      return true;
    }
    redo() {
      if (!this.redoStack.length) return false;
      this.undoStack.push(JSON.stringify(this.paths));
      this.paths = JSON.parse(this.redoStack.pop()).map(relink);
      return true;
    }
    serialize() {
      return { gc: this.gc, paths: this.paths };
    }
    static from(data) {
      const pr = new Project();
      if (data && data.gc) pr.gc = Object.assign(defaultGc(), data.gc);
      if (data && Array.isArray(data.paths)) pr.paths = clone(data.paths).map(relink);
      return pr;
    }
  }

  /**
   * Turn the paths of a loaded jerry.io project (any unit of length) into editable
   * inch paths with fresh uids where they would collide.
   */
  function importPaths(json, project, origin) {
    const gc = json.gc || {};
    const k = (gc.uol != null ? gc.uol : 1) / 2.54; // file units -> inches
    const added = [];
    (json.paths || []).forEach((raw) => {
      if (!raw || !Array.isArray(raw.segments) || !raw.segments.length) return;
      const p = clone(raw);
      p.name = String(p.name || 'Path').replace(/[^\x20-\x7E]/g, '');
      p.name = project.uniqueName(p.name || 'Path');
      if (project.paths.some((q) => q.uid === p.uid) || !p.uid) p.uid = makeUid();
      p.lock = !!p.lock;
      p.visible = p.visible !== false;
      p.pc = Object.assign(defaultPc(), p.pc || {});
      p.segments.forEach((seg) => {
        if (!seg.uid) seg.uid = makeUid();
        seg.speedProfiles = seg.speedProfiles || [];
        seg.lookaheadKeyframes = seg.lookaheadKeyframes || [];
        seg.controls.forEach((c, i) => {
          c.x *= k;
          c.y *= k;
          if (!c.uid) c.uid = makeUid();
          c.lock = !!c.lock;
          c.visible = c.visible !== false;
          const isEnd = i === 0 || i === seg.controls.length - 1;
          c.__type = isEnd ? 'end-point' : 'control';
          if (isEnd && c.heading == null) c.heading = 0;
        });
      });
      relink(p);
      p.origin = origin || null;
      project.paths.push(p);
      added.push(p);
    });
    return added;
  }

  Object.assign(NS, {
    Editor: {
      makeUid, clone, defaultPc, defaultGc, endControl, control, makeSegment, newPath, relink, controlsOf,
      first, last, isCubic, bezier, nearestOnPath,
      addSegment, startPose, splitSegment, convertSegment, removeEndControl, dragControl,
      addKeyframe, findKeyframe, moveKeyframe, removeKeyframe,
      Project, importPaths,
    },
  });
})();
