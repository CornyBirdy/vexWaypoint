/* Canvas renderer: field, game elements, paths, trail and robot. */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});
  const F = NS.FIELD;

  // visible world: the field plus a strip of each alliance station
  const VIEW_W = 210;
  const VIEW_H = 160;
  NS.VIEW_ASPECT = VIEW_W / VIEW_H;

  const C = {
    bg: '#1a1b1e',
    tileA: '#8e8e90',
    tileB: '#868688',
    tileLine: '#7b7b7d',
    wall: '#4b4c4f',
    wallEdge: '#2d2e30',
    tape: '#f1f1f1',
    red: '#e5243b',
    blue: '#1fa2e6',
    redDark: '#b3182b',
    blueDark: '#1678ad',
    yellow: '#f2d11c',
    cupGray: '#2b2b2d',
    cupGrayIn: '#4a4a4d',
    cupClear: '#efefef',
    goalBlack: '#1e1e20',
    robot: '#2f8f83',
    hit: '#d9822b',
    trail: '#175c54',
    guide: '#f2c230',
  };

  const teamColor = (t) => (t === 'red' ? C.red : t === 'blue' ? C.blue : C.yellow);

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.w = 700;
      this.h = 533;
      this.dpr = 1;
      this.resize();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.w = Math.max(240, Math.floor(rect.width || 700));
      this.h = Math.round((this.w * VIEW_H) / VIEW_W);
      this.dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.scale = this.w / VIEW_W;
    }

    wx(x) {
      return (x + VIEW_W / 2) * this.scale;
    }
    wy(y) {
      return (VIEW_H / 2 - y) * this.scale;
    }
    /** css pixels (relative to the canvas) -> inches */
    toWorld(px, py) {
      return { x: px / this.scale - VIEW_W / 2, y: VIEW_H / 2 - py / this.scale };
    }

    draw(s) {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, this.w, this.h);
      this.drawStations(ctx);
      this.drawField(ctx);
      this.drawMarkings(ctx);
      this.drawElements(ctx);
      this.drawGoals(ctx);
      this.drawToggles(ctx);
      this.drawLoaders(ctx);
      if (s.paths) this.drawPaths(ctx, s.paths);
      if (s.followPath) this.drawPolyline(ctx, s.followPath, C.guide, 2.5, false);
      if (s.trail && s.trail.length > 1) this.drawPolyline(ctx, s.trail, C.trail, 2, false);
      if (s.ghost) this.drawRobot(ctx, s.ghost, s.robot, { ghost: true, handle: s.ghostHandle });
      if (s.aim && isFinite(s.aim.x)) this.drawAim(ctx, s.aim);
      if (s.pose) this.drawRobot(ctx, s.pose, s.robot, { hit: s.hit });
      if (s.codeAxes) this.drawCodeAxes(ctx, s.codeAxes);
    }

    // ---------------------------------------------------------- field

    drawField(ctx) {
      const S = this.scale;
      const H = F.HALF;
      const x0 = this.wx(-H);
      const y0 = this.wy(H);
      const size = H * 2 * S;
      // perimeter wall
      ctx.fillStyle = C.wallEdge;
      ctx.fillRect(x0 - 3.6 * S, y0 - 3.6 * S, size + 7.2 * S, size + 7.2 * S);
      ctx.fillStyle = C.wall;
      ctx.fillRect(x0 - 3 * S, y0 - 3 * S, size + 6 * S, size + 6 * S);
      // foam tiles
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
          ctx.fillStyle = (i + j) % 2 ? C.tileB : C.tileA;
          ctx.fillRect(x0 + i * F.TILE * S, y0 + j * F.TILE * S, F.TILE * S + 0.5, F.TILE * S + 0.5);
        }
      }
      ctx.strokeStyle = C.tileLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 1; k < 6; k++) {
        ctx.moveTo(x0 + k * F.TILE * S, y0);
        ctx.lineTo(x0 + k * F.TILE * S, y0 + size);
        ctx.moveTo(x0, y0 + k * F.TILE * S);
        ctx.lineTo(x0 + size, y0 + k * F.TILE * S);
      }
      ctx.stroke();
    }

    line(ctx, x1, y1, x2, y2, color, width) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width * this.scale;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(this.wx(x1), this.wy(y1));
      ctx.lineTo(this.wx(x2), this.wy(y2));
      ctx.stroke();
    }

    drawMarkings(ctx) {
      const H = F.HALF;
      // corner boxes (red left, blue right)
      [-1, 1].forEach((sx) => {
        const color = sx < 0 ? C.red : C.blue;
        [-1, 1].forEach((sy) => {
          this.line(ctx, sx * F.BOX.x, sy * H, sx * F.BOX.x, sy * F.BOX.y, color, 0.8);
          this.line(ctx, sx * H, sy * F.BOX.y, sx * F.BOX.x, sy * F.BOX.y, color, 0.8);
        });
      });
      // centre diamond
      const r = F.DIAMOND_R;
      [[0, r, r, 0], [r, 0, 0, -r], [0, -r, -r, 0], [-r, 0, 0, r]].forEach((l) => this.line(ctx, l[0], l[1], l[2], l[3], C.tape, 0.7));
      // diagonals: TL-BR is a double line, TR-BL a single line
      const a = F.DIAGONAL_FROM;
      const b = F.DIAGONAL_TO;
      const o = 0.55; // half the gap of the double line (perpendicular to the diagonal)
      const d = o / Math.SQRT2;
      [[-1, 1], [1, -1]].forEach(([sx, sy]) => {
        this.line(ctx, sx * a + d, sy * a + d, sx * b + d, sy * b + d, C.tape, 0.45);
        this.line(ctx, sx * a - d, sy * a - d, sx * b - d, sy * b - d, C.tape, 0.45);
      });
      [[1, 1], [-1, -1]].forEach(([sx, sy]) => this.line(ctx, sx * a, sy * a, sx * b, sy * b, C.tape, 0.6));
    }

    drawStations(ctx) {
      const st = F.STATION;
      [-1, 1].forEach((s) => {
        const color = s < 0 ? C.red : C.blue;
        const w = 1.8;
        // "]" bracket: vertical at the field side, arms running away from the field
        this.line(ctx, s * st.wallX, -st.halfH - w / 2, s * st.wallX, st.halfH + w / 2, color, w);
        this.line(ctx, s * st.wallX + (s < 0 ? w / 2 : -w / 2), st.halfH, s * st.armTo, st.halfH, color, w);
        this.line(ctx, s * st.wallX + (s < 0 ? w / 2 : -w / 2), -st.halfH, s * st.armTo, -st.halfH, color, w);
      });
    }

    // ---------------------------------------------------------- elements

    drawElements(ctx) {
      const S = this.scale;
      // cups first so standing pins draw on top
      F.ELEMENTS.filter((e) => e.type === 'cup').forEach((e) => {
        const x = this.wx(e.x);
        const y = this.wy(e.y);
        ctx.beginPath();
        ctx.arc(x, y, 1.65 * S, 0, Math.PI * 2);
        ctx.fillStyle = e.side === 'clear' ? C.cupClear : C.cupGray;
        ctx.fill();
        ctx.strokeStyle = e.side === 'clear' ? '#9a9a9c' : '#0e0e0f';
        ctx.lineWidth = Math.max(1, 0.25 * S);
        ctx.stroke();
        if (e.side !== 'clear') {
          ctx.beginPath();
          ctx.arc(x, y, 1.0 * S, 0, Math.PI * 2);
          ctx.fillStyle = C.cupGrayIn;
          ctx.fill();
        }
      });
      F.ELEMENTS.filter((e) => e.type === 'pin' && e.deg == null).forEach((e) => this.standingPin(ctx, e));
      F.ELEMENTS.filter((e) => e.type === 'pin' && e.deg != null).forEach((e) => this.lyingPin(ctx, e));
    }

    standingPin(ctx, e) {
      const S = this.scale;
      const x = this.wx(e.x);
      const y = this.wy(e.y);
      ctx.beginPath();
      ctx.arc(x, y, 1.1 * S, 0, Math.PI * 2);
      ctx.fillStyle = teamColor(e.color);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(1, 0.2 * S);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 0.45 * S, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fill();
    }

    /** a pin lying flat: yellow end toward the centre, team colour at the tip */
    lyingPin(ctx, e) {
      const S = this.scale;
      const r0 = 1.8;
      const len = 6.6;
      ctx.save();
      ctx.translate(this.wx(e.x), this.wy(e.y));
      ctx.rotate((e.deg * Math.PI) / 180);
      // arm points "up" (-y on screen)
      const base = r0 * S;
      const tip = (r0 + len) * S;
      const mid = (r0 + len * 0.5) * S;
      const wBase = 1.25 * S;
      const wTip = 0.5 * S;
      const wMid = wBase + (wTip - wBase) * 0.5;
      ctx.lineJoin = 'round';
      ctx.fillStyle = C.yellow;
      ctx.beginPath();
      ctx.moveTo(-wBase, -base);
      ctx.lineTo(wBase, -base);
      ctx.lineTo(wMid, -mid);
      ctx.lineTo(-wMid, -mid);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = teamColor(e.color);
      ctx.beginPath();
      ctx.moveTo(-wMid, -mid);
      ctx.lineTo(wMid, -mid);
      ctx.lineTo(wTip, -tip);
      ctx.lineTo(-wTip, -tip);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = Math.max(1, 0.18 * S);
      ctx.beginPath();
      ctx.moveTo(-wBase, -base);
      ctx.lineTo(-wTip, -tip);
      ctx.lineTo(wTip, -tip);
      ctx.lineTo(wBase, -base);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    // ---------------------------------------------------------- goals, toggles, loaders

    octagon(ctx, cx, cy, size, cut) {
      const h = size / 2;
      const c = size * cut;
      const pts = [
        [-h + c, -h], [h - c, -h], [h, -h + c], [h, h - c],
        [h - c, h], [-h + c, h], [-h, h - c], [-h, -h + c],
      ];
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(cx + p[0], cy + p[1]) : ctx.moveTo(cx + p[0], cy + p[1])));
      ctx.closePath();
    }

    drawGoals(ctx) {
      const S = this.scale;
      F.GOALS.forEach((g) => {
        const cx = this.wx(g.x);
        const cy = this.wy(g.y);
        const size = g.size * S;
        const body = g.team === 'red' ? C.red : g.team === 'blue' ? C.blue : C.goalBlack;
        const edge = g.team === 'red' ? C.redDark : g.team === 'blue' ? C.blueDark : '#000';
        // shadow
        this.octagon(ctx, cx + 0.5 * S, cy + 0.7 * S, size, 0.29);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fill();
        this.octagon(ctx, cx, cy, size, 0.29);
        ctx.fillStyle = body;
        ctx.fill();
        ctx.strokeStyle = edge;
        ctx.lineWidth = Math.max(1.5, 0.4 * S);
        ctx.stroke();
        // inner rim
        this.octagon(ctx, cx, cy, size * 0.66, 0.29);
        ctx.strokeStyle = g.team === 'neutral' ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.3)';
        ctx.lineWidth = Math.max(1, 0.22 * S);
        ctx.stroke();
        // centre
        ctx.beginPath();
        ctx.arc(cx, cy, size * (g.kind === 'tall' ? 0.24 : 0.2), 0, Math.PI * 2);
        ctx.fillStyle = g.team === 'neutral' ? C.yellow : '#17171a';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = Math.max(1, 0.2 * S);
        ctx.stroke();
      });
    }

    drawToggles(ctx) {
      const S = this.scale;
      const len = 26 * S;
      const th = 2.6 * S;
      F.TOGGLES.forEach((t) => {
        const horizontal = t.wall === 'top' || t.wall === 'bottom';
        const off = 1.6 * (t.wall === 'top' || t.wall === 'right' ? 1 : -1);
        const cx = this.wx(horizontal ? t.x : t.x + off);
        const cy = this.wy(horizontal ? t.y + off : t.y);
        ctx.fillStyle = C.yellow;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 1;
        const w = horizontal ? len : th;
        const h = horizontal ? th : len;
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
        ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
      });
    }

    drawLoaders(ctx) {
      const S = this.scale;
      F.LOADERS.forEach((l) => {
        const w = 5.4 * S;
        const h = 9 * S;
        const cx = this.wx(l.x);
        const cy = this.wy(l.y);
        ctx.fillStyle = '#26272a';
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
        // team-coloured face looking into the field
        ctx.fillStyle = l.team === 'red' ? C.red : C.blue;
        const fw = 1.3 * S;
        ctx.fillRect(l.x < 0 ? cx + w / 2 - fw : cx - w / 2, cy - h / 2, fw, h);
        ctx.strokeStyle = '#0c0c0d';
        ctx.lineWidth = 1;
        ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
        // feed opening
        ctx.beginPath();
        ctx.arc(cx + (l.x < 0 ? -0.6 : 0.6) * S, cy, 1.5 * S, 0, Math.PI * 2);
        ctx.fillStyle = '#050505';
        ctx.fill();
      });
    }

    // ---------------------------------------------------------- overlays

    drawPolyline(ctx, pts, color, width, dashed) {
      if (!pts || pts.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dashed ? [6, 4] : []);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(this.wx(p.x), this.wy(p.y)) : ctx.moveTo(this.wx(p.x), this.wy(p.y))));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    drawPaths(ctx, paths) {
      paths.forEach((p) => {
        if (!p.visible || !p.points.length) return;
        this.drawPolyline(ctx, p.points, p.color, 1.8, true);
        const a = p.points[0];
        const b = p.points[p.points.length - 1];
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(this.wx(a.x), this.wy(a.y), 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(this.wx(b.x) - 3, this.wy(b.y) - 3, 6, 6);
      });
    }

    drawAim(ctx, a) {
      const x = this.wx(a.x);
      const y = this.wy(a.y);
      ctx.strokeStyle = C.guide;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 7, y);
      ctx.lineTo(x + 7, y);
      ctx.moveTo(x, y - 7);
      ctx.lineTo(x, y + 7);
      ctx.stroke();
    }

    /** pose = {x, y, h}, h in compass degrees (0 = up, clockwise) */
    drawRobot(ctx, pose, dims, o) {
      const S = this.scale;
      const L = dims.length * S;
      const W = dims.width * S;
      ctx.save();
      ctx.translate(this.wx(pose.x), this.wy(pose.y));
      ctx.rotate((pose.h * Math.PI) / 180);
      ctx.fillStyle = o.ghost ? 'rgba(255,255,255,0.10)' : o.hit ? C.hit : C.robot;
      ctx.globalAlpha = o.ghost ? 1 : 0.78;
      ctx.fillRect(-W / 2, -L / 2, W, L);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = o.ghost ? 'rgba(255,255,255,0.9)' : '#06201b';
      ctx.lineWidth = 1.5;
      ctx.setLineDash(o.ghost ? [5, 3] : []);
      ctx.strokeRect(-W / 2, -L / 2, W, L);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -L / 2);
      ctx.stroke();
      if (o.handle) {
        ctx.strokeStyle = C.guide;
        ctx.fillStyle = C.guide;
        ctx.beginPath();
        ctx.moveTo(0, -L / 2);
        ctx.lineTo(0, -L / 2 - 14);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, -L / 2 - 14, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    /** code-frame axes drawn at the start pose */
    drawCodeAxes(ctx, a) {
      const len = 12 * this.scale;
      ctx.save();
      ctx.translate(this.wx(a.x), this.wy(a.y));
      ctx.rotate((a.h * Math.PI) / 180);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#c0392b';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(len, 0);
      ctx.stroke();
      ctx.strokeStyle = '#2e9b4e';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -len);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px Consolas, "Liberation Mono", monospace';
      ctx.fillText('x', len + 3, 4);
      ctx.fillText('y', 4, -len - 3);
      ctx.restore();
    }
  }

  NS.Renderer = Renderer;
})();
