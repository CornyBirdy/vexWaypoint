/*
 * The aligner sketch editor: a CAD-style top-down drawing of the chassis on an inch grid where the
 * goal aligners are drawn with lines, 3-point arcs, centre-point arcs and circles, with exact dimensions
 * typed in and snapping to the grid. The shapes live in the robot's frame (js/aligners.js).
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;

  const TOOLS = {
    select: { label: 'Select', hint: 'Click a shape to select it, drag it (or one of its handles) to change it.' },
    line: { label: 'Line', hint: 'Line: click the start, then the end.' },
    arc3: { label: 'Arc (3 points)', hint: 'Arc: click the start, a point on the arc, then the end.' },
    arcC: { label: 'Arc (centre)', hint: 'Arc: click the centre, the start of the arc, then the end.' },
    circle: { label: 'Circle', hint: 'Circle: click the centre, then a point on the circle.' },
  };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
  const wrap360 = (a) => ((a % 360) + 360) % 360;

  /**
   * @param {object} o
   *   $            getElementById
   *   get()        -> {aligners, robot, chassis, goals}
   *   changed()    called whenever the aligners changed
   */
  function init(o) {
    const $ = o.$;
    const dlg = $('alignDlg');
    const cv = $('alignCanvas');
    if (!dlg || !cv || typeof dlg.showModal !== 'function') return null;
    const ctx = cv.getContext('2d');

    let side = 'front';
    let tool = 'select';
    let selected = -1;
    let pending = []; // points clicked so far for the shape being drawn
    let hover = null; // snapped cursor position
    let drag = null;
    let view = { cx: 0, cy: 0, scale: 12 };
    let size = { w: 600, h: 600 };
    let snap = 1;
    let mirrorDraw = false;
    let showGoal = true;
    let undo = [];
    let redo = [];

    const state = () => o.get();
    const set = () => state().aligners[side];
    const shapes = () => set().shapes;

    // ------------------------------------------------------------ history
    const snapshot = () => JSON.stringify(state().aligners);
    function push() {
      undo.push(snapshot());
      if (undo.length > 80) undo.shift();
      redo = [];
    }
    function restore(json) {
      const a = JSON.parse(json);
      const target = state().aligners;
      target.front = a.front;
      target.back = a.back;
      selected = -1;
      commit(false);
    }
    function commit(record = true) {
      if (record) push();
      renderProps();
      draw();
      o.changed();
    }

    // ------------------------------------------------------------ geometry helpers
    const toScreen = (x, y) => ({ x: size.w / 2 + (x - view.cx) * view.scale, y: size.h / 2 - (y - view.cy) * view.scale });
    const fromScreen = (px, py) => ({ x: (px - size.w / 2) / view.scale + view.cx, y: view.cy - (py - size.h / 2) / view.scale });
    const snapPt = (p) => (snap > 0 ? { x: Math.round(p.x / snap) * snap, y: Math.round(p.y / snap) * snap } : { x: r3(p.x), y: r3(p.y) });
    const mirrorShape = (s) => {
      if (s.type === 'line') return { type: 'line', x1: -s.x1, y1: s.y1, x2: -s.x2, y2: s.y2 };
      if (s.type === 'arc') return { type: 'arc', cx: -s.cx, cy: s.cy, r: s.r, a0: wrap180(180 - s.a0), sweep: -s.sweep };
      return { type: 'circle', cx: -s.cx, cy: s.cy, r: s.r };
    };

    function fit() {
      const { robot } = state();
      const reach = Math.max(robot.length, robot.width) / 2 + 12;
      view = { cx: 0, cy: side === 'back' ? -robot.length / 4 : robot.length / 4, scale: Math.min(size.w, size.h) / (reach * 2) };
    }

    function resize() {
      const r = cv.getBoundingClientRect();
      size = { w: Math.max(300, Math.floor(r.width)), h: Math.max(300, Math.floor(r.height)) };
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(size.w * dpr);
      cv.height = Math.round(size.h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ------------------------------------------------------------ handles of the selected shape
    function handles(s) {
      if (!s) return [];
      if (s.type === 'line') return [{ id: 'p1', x: s.x1, y: s.y1 }, { id: 'p2', x: s.x2, y: s.y2 }];
      if (s.type === 'arc') {
        const e = NS.shapeEnds(s);
        return [{ id: 'start', x: e[0].x, y: e[0].y }, { id: 'end', x: e[1].x, y: e[1].y }, { id: 'centre', x: s.cx, y: s.cy }];
      }
      return [{ id: 'centre', x: s.cx, y: s.cy }, { id: 'radius', x: s.cx + s.r, y: s.cy }];
    }

    function applyHandle(s, id, p) {
      if (s.type === 'line') {
        if (id === 'p1') {
          s.x1 = p.x;
          s.y1 = p.y;
        } else {
          s.x2 = p.x;
          s.y2 = p.y;
        }
      } else if (s.type === 'arc') {
        if (id === 'centre') {
          s.cx = p.x;
          s.cy = p.y;
        } else if (id === 'start') {
          const end = s.a0 + s.sweep;
          s.a0 = Math.atan2(p.y - s.cy, p.x - s.cx) * R2D;
          s.r = Math.max(0.05, Math.hypot(p.x - s.cx, p.y - s.cy));
          s.sweep = Math.max(-359.9, Math.min(359.9, end - s.a0));
          if (Math.abs(s.sweep) < 0.2) s.sweep = s.sweep < 0 ? -0.2 : 0.2;
        } else {
          const a1 = Math.atan2(p.y - s.cy, p.x - s.cx) * R2D;
          const diff = wrap180(a1 - s.a0);
          // keep going the same way round as before unless the end has clearly crossed over
          s.sweep = s.sweep >= 0 ? (diff < 0 ? diff + 360 : diff) : diff > 0 ? diff - 360 : diff;
          s.r = Math.max(0.05, Math.hypot(p.x - s.cx, p.y - s.cy));
        }
      } else if (id === 'centre') {
        s.cx = p.x;
        s.cy = p.y;
      } else s.r = Math.max(0.05, Math.hypot(p.x - s.cx, p.y - s.cy));
    }

    function translate(s, dx, dy) {
      if (s.type === 'line') {
        s.x1 += dx;
        s.x2 += dx;
        s.y1 += dy;
        s.y2 += dy;
      } else {
        s.cx += dx;
        s.cy += dy;
      }
    }

    // ------------------------------------------------------------ drawing
    function themeColor(n, fallback) {
      return (NS.theme && NS.theme.color(n)) || fallback;
    }

    function pathShape(s) {
      const pts = NS.shapePolyline(s, 0.01);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const q = toScreen(p.x, p.y);
        if (i) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
      });
    }

    function draw() {
      const { robot, chassis, goals } = state();
      const ink = themeColor('ink', '#ddd');
      const muted = themeColor('ink-muted', '#999');
      const accent = themeColor('accent', '#a78bfa');
      ctx.fillStyle = themeColor('surface', '#222');
      ctx.fillRect(0, 0, size.w, size.h);

      // inch grid
      const lo = fromScreen(0, size.h);
      const hi = fromScreen(size.w, 0);
      ctx.lineWidth = 1;
      for (let g = Math.floor(lo.x); g <= Math.ceil(hi.x); g++) {
        ctx.strokeStyle = muted;
        ctx.globalAlpha = g % 6 === 0 ? 0.42 : 0.14;
        const a = toScreen(g, 0).x;
        ctx.beginPath();
        ctx.moveTo(a, 0);
        ctx.lineTo(a, size.h);
        ctx.stroke();
      }
      for (let g = Math.floor(lo.y); g <= Math.ceil(hi.y); g++) {
        ctx.strokeStyle = muted;
        ctx.globalAlpha = g % 6 === 0 ? 0.42 : 0.14;
        const a = toScreen(0, g).y;
        ctx.beginPath();
        ctx.moveTo(0, a);
        ctx.lineTo(size.w, a);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = muted;
      ctx.font = '10px ui-monospace, monospace';
      for (let g = Math.ceil(lo.x / 6) * 6; g <= hi.x; g += 6) if (g) ctx.fillText(String(g), toScreen(g, 0).x + 2, toScreen(0, 0).y - 3);
      for (let g = Math.ceil(lo.y / 6) * 6; g <= hi.y; g += 6) if (g) ctx.fillText(String(g), toScreen(0, 0).x + 3, toScreen(0, g).y - 2);
      ctx.fillText('inches, robot centre = 0, front is up', 8, size.h - 8);

      // body + wheels
      const a = toScreen(-robot.width / 2, robot.length / 2);
      ctx.fillStyle = themeColor('ov-robot', '#a78bfa');
      ctx.globalAlpha = 0.25;
      ctx.fillRect(a.x, a.y, robot.width * view.scale, robot.length * view.scale);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = themeColor('ov-robot', '#a78bfa');
      ctx.lineWidth = 1.5;
      ctx.strokeRect(a.x, a.y, robot.width * view.scale, robot.length * view.scale);
      const wheelsList = NS.chassisLayout ? NS.chassisLayout(chassis, robot) : [];
      wheelsList.forEach((w) => {
        const q = toScreen(w.x - 0.55, w.y + robot.wheelDiameter / 2);
        ctx.fillStyle = w.type === 'omni' ? themeColor('surface-raised', '#444') : ink;
        ctx.globalAlpha = w.type === 'omni' ? 1 : 0.75;
        ctx.fillRect(q.x, q.y, 1.1 * view.scale, robot.wheelDiameter * view.scale);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1;
        ctx.strokeRect(q.x, q.y, 1.1 * view.scale, robot.wheelDiameter * view.scale);
      });
      ctx.strokeStyle = themeColor('ov-robot', '#a78bfa');
      ctx.lineWidth = 1.5;
      const nose = toScreen(0, robot.length / 2);
      ctx.beginPath();
      ctx.moveTo(nose.x - 12, nose.y);
      ctx.lineTo(nose.x, nose.y - 10);
      ctx.lineTo(nose.x + 12, nose.y);
      ctx.stroke();

      // a goal seated against the alignment point, to see how it fits
      const st = set();
      const ap = NS.alignerPoint(st, side);
      if (showGoal && goals) {
        const flat = goals.tall;
        const R = flat / 2 / Math.cos(22.5 * D2R);
        const dir = side === 'back' ? -1 : 1;
        const gx = ap.x;
        const gy = ap.y + (dir * flat) / 2;
        ctx.beginPath();
        for (let k = 0; k < 8; k++) {
          const ang = (22.5 + 45 * k) * D2R;
          const q = toScreen(gx + R * Math.cos(ang), gy + R * Math.sin(ang));
          if (k) ctx.lineTo(q.x, q.y);
          else ctx.moveTo(q.x, q.y);
        }
        ctx.closePath();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = themeColor('success', '#81c995');
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = themeColor('success', '#81c995');
        ctx.globalAlpha = 0.08;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // the other side faintly, then this side
      const other = state().aligners[side === 'front' ? 'back' : 'front'];
      if (other.on) {
        ctx.strokeStyle = muted;
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = Math.max(1.5, other.thickness * view.scale);
        other.shapes.forEach((s) => {
          pathShape(s);
          ctx.stroke();
        });
        ctx.globalAlpha = 1;
      }
      shapes().forEach((s, i) => {
        ctx.strokeStyle = i === selected ? themeColor('ov-guide', '#fdd663') : accent;
        ctx.lineWidth = Math.max(2, st.thickness * view.scale);
        ctx.lineCap = 'round';
        pathShape(s);
        ctx.stroke();
      });

      // alignment point + its tolerance
      const apS = toScreen(ap.x, ap.y);
      ctx.strokeStyle = themeColor('success', '#81c995');
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(apS.x, apS.y, Math.max(3, st.tol * view.scale), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = themeColor('success', '#81c995');
      ctx.beginPath();
      ctx.moveTo(apS.x, apS.y - 6);
      ctx.lineTo(apS.x + 6, apS.y);
      ctx.lineTo(apS.x, apS.y + 6);
      ctx.lineTo(apS.x - 6, apS.y);
      ctx.closePath();
      ctx.fill();
      ctx.fillText('alignment point', apS.x + 9, apS.y + 4);

      // handles of the selected shape
      if (tool === 'select' && selected >= 0 && shapes()[selected]) {
        handles(shapes()[selected]).forEach((h) => {
          const q = toScreen(h.x, h.y);
          ctx.fillStyle = themeColor('surface', '#222');
          ctx.strokeStyle = themeColor('ov-guide', '#fdd663');
          ctx.lineWidth = 2;
          ctx.fillRect(q.x - 4, q.y - 4, 8, 8);
          ctx.strokeRect(q.x - 4, q.y - 4, 8, 8);
        });
      }

      // the shape being drawn
      if (pending.length && hover) {
        const p = pending.concat([hover]);
        const prev = previewShape(p);
        ctx.strokeStyle = themeColor('ov-guide', '#fdd663');
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = Math.max(1.5, st.thickness * view.scale);
        if (prev) {
          pathShape(prev);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        pending.forEach((q) => {
          const s = toScreen(q.x, q.y);
          ctx.fillStyle = themeColor('ov-guide', '#fdd663');
          ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
        });
      }
      if (hover) {
        const q = toScreen(hover.x, hover.y);
        ctx.strokeStyle = ink;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(q.x - 6, q.y);
        ctx.lineTo(q.x + 6, q.y);
        ctx.moveTo(q.x, q.y - 6);
        ctx.lineTo(q.x, q.y + 6);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    /** the shape that the clicked points would make (the last point is the mouse) */
    function previewShape(p) {
      if (tool === 'line' && p.length >= 2) return { type: 'line', x1: p[0].x, y1: p[0].y, x2: p[1].x, y2: p[1].y };
      if (tool === 'arc3') {
        if (p.length === 2) return { type: 'line', x1: p[0].x, y1: p[0].y, x2: p[1].x, y2: p[1].y };
        if (p.length >= 3) return NS.arcFromThree(p[0], p[1], p[2]);
      }
      if (tool === 'arcC') {
        if (p.length === 2) {
          const r = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
          return r > 0.05 ? { type: 'circle', cx: p[0].x, cy: p[0].y, r } : null;
        }
        if (p.length >= 3) return arcFromCentre(p[0], p[1], p[2]);
      }
      if (tool === 'circle' && p.length >= 2) {
        const r = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
        return r > 0.05 ? { type: 'circle', cx: p[0].x, cy: p[0].y, r } : null;
      }
      return null;
    }

    /** centre, start point, end point: the arc between them the short way round */
    function arcFromCentre(c, s, e) {
      const r = Math.hypot(s.x - c.x, s.y - c.y);
      if (r < 0.05) return null;
      const a0 = Math.atan2(s.y - c.y, s.x - c.x) * R2D;
      const a1 = Math.atan2(e.y - c.y, e.x - c.x) * R2D;
      const sweep = wrap180(a1 - a0);
      return Math.abs(sweep) < 0.1 ? null : { type: 'arc', cx: c.x, cy: c.y, r, a0, sweep };
    }

    function finishShape() {
      const prev = previewShape(pending);
      pending = [];
      if (!prev) return;
      const s = NS.sanitizeAligners({ front: { shapes: [prev] }, back: {} }).front.shapes[0];
      if (!s) return;
      shapes().push(s);
      if (mirrorDraw) {
        const m = mirrorShape(s);
        if (JSON.stringify(m) !== JSON.stringify(s)) shapes().push(m);
      }
      selected = shapes().length - (mirrorDraw ? 2 : 1);
      commit();
    }

    // ------------------------------------------------------------ pointer
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return { px: e.clientX - r.left, py: e.clientY - r.top };
    };

    function pick(p) {
      let best = -1;
      let bd = 7 / view.scale;
      shapes().forEach((s, i) => {
        const d = NS.shapeDistance(s, p.x, p.y);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return best;
    }

    cv.addEventListener('pointerdown', (e) => {
      const { px, py } = pos(e);
      const raw = fromScreen(px, py);
      if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
        drag = { mode: 'pan', px, py, cx: view.cx, cy: view.cy };
        cv.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      const p = snapPt(raw);
      if (tool === 'select') {
        const st = set();
        const ap = NS.alignerPoint(st, side);
        const apS = toScreen(ap.x, ap.y);
        if (Math.hypot(px - apS.x, py - apS.y) < 9) {
          if (st.auto) {
            st.auto = false;
            st.point = { x: ap.x, y: ap.y };
          }
          drag = { mode: 'point', recorded: false };
          cv.setPointerCapture(e.pointerId);
          return;
        }
        if (selected >= 0 && shapes()[selected]) {
          const hs = handles(shapes()[selected]);
          for (const h of hs) {
            const q = toScreen(h.x, h.y);
            if (Math.abs(px - q.x) <= 7 && Math.abs(py - q.y) <= 7) {
              drag = { mode: 'handle', id: h.id, recorded: false };
              cv.setPointerCapture(e.pointerId);
              return;
            }
          }
        }
        const hit = pick(raw);
        selected = hit;
        if (hit >= 0) {
          drag = { mode: 'move', last: p, recorded: false };
          cv.setPointerCapture(e.pointerId);
        }
        renderProps();
        draw();
        return;
      }
      pending.push(p);
      const need = { line: 2, arc3: 3, arcC: 3, circle: 2 }[tool];
      if (pending.length >= need) finishShape();
      else {
        draw();
        status();
      }
    });

    cv.addEventListener('pointermove', (e) => {
      const { px, py } = pos(e);
      const raw = fromScreen(px, py);
      hover = snapPt(raw);
      status();
      if (drag) {
        if (drag.mode === 'pan') {
          view.cx = drag.cx - (px - drag.px) / view.scale;
          view.cy = drag.cy + (py - drag.py) / view.scale;
        } else if (drag.mode === 'point') {
          if (!drag.recorded) {
            push();
            drag.recorded = true;
          }
          set().point = { x: hover.x, y: hover.y };
          renderProps();
          o.changed();
        } else if (selected >= 0 && shapes()[selected]) {
          const s = shapes()[selected];
          if (!drag.recorded && (drag.mode === 'handle' || hover.x !== drag.last.x || hover.y !== drag.last.y)) {
            push();
            drag.recorded = true;
          }
          if (drag.mode === 'handle') applyHandle(s, drag.id, hover);
          else if (drag.recorded) {
            translate(s, hover.x - drag.last.x, hover.y - drag.last.y);
            drag.last = hover;
          }
          renderProps();
          o.changed();
        }
      }
      draw();
    });

    const end = (e) => {
      if (drag && drag.mode !== 'pan') {
        const sets = state().aligners;
        ['front', 'back'].forEach((k) => (sets[k] = NS.sanitizeAligners(sets)[k]));
        selected = Math.min(selected, shapes().length - 1);
        renderProps();
        o.changed();
      }
      drag = null;
      try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
      draw();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => {
      hover = null;
      draw();
    });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { px, py } = pos(e);
      const before = fromScreen(px, py);
      view.scale = Math.max(4, Math.min(80, view.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      const after = fromScreen(px, py);
      view.cx += before.x - after.x;
      view.cy += before.y - after.y;
      draw();
    }, { passive: false });

    // ------------------------------------------------------------ side panel
    function status() {
      const t = TOOLS[tool];
      let line = t.hint;
      if (tool !== 'select' && pending.length) line += ` (${pending.length} point${pending.length > 1 ? 's' : ''} so far, Esc cancels)`;
      if (hover) line += `   x ${hover.x}  y ${hover.y} in`;
      $('alignStatus').textContent = line;
    }

    function num(label, key, value, step = 0.125, extra = '') {
      return `<label class="field"><span>${esc(label)}</span><input type="number" step="${step}" data-k="${key}" value="${r3(value)}" ${extra}></label>`;
    }

    function renderProps() {
      const st = set();
      const s = selected >= 0 ? shapes()[selected] : null;
      const ap = NS.alignerPoint(st, side);
      let html = '';
      html += `<label class="check"><input type="checkbox" data-set="on"${st.on ? ' checked' : ''}> ${side} aligners on</label>`;
      html += `<label class="field"><span>Material</span><select data-set="material">${Object.keys(NS.MATERIALS).map((k) => `<option value="${k}"${k === st.material ? ' selected' : ''}>${esc(NS.MATERIALS[k].label)}</option>`).join('')}</select></label>`;
      html += `<label class="field"><span>Stock thickness (in)</span><input type="number" step="0.0625" min="0.05" max="1" data-set="thickness" value="${st.thickness}"></label>`;
      html += `<label class="field"><span>Aligned within (in)</span><input type="number" step="0.05" min="0" max="6" data-set="tol" value="${st.tol}"></label>`;
      html += `<label class="check"><input type="checkbox" data-set="auto"${st.auto ? ' checked' : ''}> alignment point = middle of the back of the aligners</label>`;
      html += `<div class="pt"><label class="field"><span>Point x</span><input type="number" step="0.125" data-set="px" value="${r3(ap.x)}"${st.auto ? ' disabled' : ''}></label><label class="field"><span>Point y</span><input type="number" step="0.125" data-set="py" value="${r3(ap.y)}"${st.auto ? ' disabled' : ''}></label></div>`;
      html += '<h3>Selected shape</h3>';
      if (!s) html += '<p class="note">Nothing selected. Pick the Select tool and click a shape.</p>';
      else if (s.type === 'line') {
        const d = NS.shapeDimensions(s);
        html += num('Start x', 'x1', s.x1) + num('Start y', 'y1', s.y1) + num('End x', 'x2', s.x2) + num('End y', 'y2', s.y2);
        html += num('Length (in)', 'length', d.length, 0.125, 'min="0.05"') + num('Angle (deg)', 'angle', d.angle, 1);
      } else if (s.type === 'arc') {
        const d = NS.shapeDimensions(s);
        html += num('Centre x', 'cx', s.cx) + num('Centre y', 'cy', s.cy) + num('Radius (in)', 'r', s.r, 0.125, 'min="0.05"');
        html += num('Start angle (deg)', 'a0', s.a0, 1) + num('Sweep (deg, - = clockwise)', 'sweep', s.sweep, 1);
        html += `<p class="note">Arc length ${d.arcLength.toFixed(2)} in, chord ${d.chord.toFixed(2)} in.</p>`;
      } else {
        const d = NS.shapeDimensions(s);
        html += num('Centre x', 'cx', s.cx) + num('Centre y', 'cy', s.cy) + num('Radius (in)', 'r', s.r, 0.125, 'min="0.05"');
        html += `<p class="note">Diameter ${d.diameter.toFixed(2)} in, circumference ${d.circumference.toFixed(2)} in.</p>`;
      }
      $('alignProps').innerHTML = html;
    }

    $('alignProps').addEventListener('change', (e) => {
      const el = e.target;
      const st = set();
      if (el.dataset.set) {
        const k = el.dataset.set;
        if (k === 'on' || k === 'auto') {
          if (k === 'auto' && !el.checked) st.point = { ...NS.alignerPoint(st, side) };
          st[k] = el.checked;
        } else if (k === 'material') st.material = el.value;
        else if (k === 'px' || k === 'py') st.point = { ...st.point, [k === 'px' ? 'x' : 'y']: parseFloat(el.value) || 0 };
        else st[k] = parseFloat(el.value);
        if (st.auto && (k === 'px' || k === 'py')) return;
        const clean = NS.sanitizeAligners(state().aligners);
        state().aligners[side] = clean[side];
        commit();
        return;
      }
      const s = selected >= 0 ? shapes()[selected] : null;
      if (!s || !el.dataset.k) return;
      const v = parseFloat(el.value);
      if (!isFinite(v)) return;
      const k = el.dataset.k;
      if (k === 'length' || k === 'angle') {
        const d = NS.shapeDimensions(s);
        const len = k === 'length' ? Math.max(0.05, v) : d.length;
        const ang = (k === 'angle' ? v : d.angle) * D2R;
        s.x2 = s.x1 + len * Math.cos(ang);
        s.y2 = s.y1 + len * Math.sin(ang);
      } else s[k] = v;
      const clean = NS.sanitizeAligners(state().aligners);
      state().aligners[side] = clean[side];
      selected = Math.min(selected, state().aligners[side].shapes.length - 1);
      commit();
    });

    // ------------------------------------------------------------ toolbar
    function renderTools() {
      const host = $('alignTools');
      host.innerHTML = Object.keys(TOOLS).map((k) => `<button class="btn${k === tool ? ' on' : ''}" type="button" data-tool="${k}">${TOOLS[k].label}</button>`).join('');
      host.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    }
    function setTool(t) {
      tool = t;
      pending = [];
      renderTools();
      status();
      draw();
    }
    function setSide(s) {
      side = s;
      selected = -1;
      pending = [];
      document.querySelectorAll('#alignDlg [data-side]').forEach((b) => b.classList.toggle('on', b.dataset.side === s));
      fit();
      renderProps();
      draw();
    }
    document.querySelectorAll('#alignDlg [data-side]').forEach((b) => b.addEventListener('click', () => setSide(b.dataset.side)));

    $('alignSnap').addEventListener('change', (e) => {
      snap = parseFloat(e.target.value);
    });
    $('alignMirrorDraw').addEventListener('change', (e) => (mirrorDraw = e.target.checked));
    $('alignShowGoal').addEventListener('change', (e) => {
      showGoal = e.target.checked;
      draw();
    });
    $('alignMirror').addEventListener('click', () => {
      if (selected < 0) return;
      const m = mirrorShape(shapes()[selected]);
      shapes().push(m);
      selected = shapes().length - 1;
      commit();
    });
    $('alignDelete').addEventListener('click', deleteSelected);
    function deleteSelected() {
      if (selected < 0) return;
      shapes().splice(selected, 1);
      selected = -1;
      commit();
    }
    $('alignClear').addEventListener('click', () => {
      if (!shapes().length) return;
      shapes().length = 0;
      selected = -1;
      commit();
    });
    $('alignExample').addEventListener('click', () => {
      const robot = state().robot;
      const ex = NS.exampleFunnel(robot);
      const flip = side === 'back' ? -1 : 1;
      ex.forEach((s) => shapes().push({ ...s, y1: s.y1 * flip, y2: s.y2 * flip }));
      set().on = true;
      commit();
    });
    $('alignUndo').addEventListener('click', () => {
      if (!undo.length) return;
      redo.push(snapshot());
      restore(undo.pop());
    });
    $('alignRedo').addEventListener('click', () => {
      if (!redo.length) return;
      undo.push(snapshot());
      restore(redo.pop());
    });
    $('alignFit').addEventListener('click', () => {
      fit();
      draw();
    });
    $('alignClose').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => {
      pending = [];
      drag = null;
    });
    dlg.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
      if (e.key === 'Escape') {
        if (pending.length || tool !== 'select') {
          e.preventDefault();
          if (pending.length) pending = [];
          else setTool('select');
          draw();
        }
      } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        deleteSelected();
      } else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        (e.shiftKey ? $('alignRedo') : $('alignUndo')).click();
      } else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        $('alignRedo').click();
      } else if (!typing && !e.ctrlKey && !e.metaKey) {
        const map = { v: 'select', l: 'line', a: 'arc3', c: 'arcC', o: 'circle' };
        if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
      }
    });
    new ResizeObserver(() => {
      if (!dlg.open) return;
      resize();
      draw();
    }).observe(cv);

    return {
      open(which) {
        undo = [];
        redo = [];
        dlg.showModal();
        resize();
        setSide(which || 'front');
        renderTools();
        status();
        draw();
      },
      redraw() {
        if (dlg.open) {
          renderProps();
          draw();
        }
      },
    };
  }

  NS.AlignerEditor = { init };
})();
