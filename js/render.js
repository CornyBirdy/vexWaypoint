/* Canvas renderer: field, goals, paths, trail and robot. */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});
  const F = NS.FIELD;
  const MARGIN = 8; // inches of border drawn around the 144 in field

  const C = {
    border: '#17191c',
    tileA: '#74787f',
    tileB: '#6d7178',
    line: '#5c6068',
    wall: '#101113',
    red: '#c8423f',
    blue: '#3a6fc4',
    neutral: '#d4d6da',
    yellow: '#e0b92b',
    gray: '#9a9ea5',
    clear: '#e9ebee',
    robot: '#2f8f83',
    hit: '#d9822b',
    trail: '#1f6f66',
    guide: '#f2c230',
  };

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.size = 600;
      this.dpr = 1;
      this.resize();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const css = Math.max(200, Math.floor(Math.min(rect.width || 600, rect.height || rect.width || 600)));
      this.dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(css * this.dpr);
      this.canvas.height = Math.round(css * this.dpr);
      this.size = css;
      this.scale = css / (F.HALF * 2 + MARGIN * 2);
    }

    wx(x) {
      return (x + F.HALF + MARGIN) * this.scale;
    }
    wy(y) {
      return (F.HALF + MARGIN - y) * this.scale;
    }
    toWorld(px, py) {
      return { x: px / this.scale - F.HALF - MARGIN, y: F.HALF + MARGIN - py / this.scale };
    }

    draw(s) {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.size, this.size);
      this.drawField(ctx);
      this.drawToggles(ctx);
      this.drawLoaders(ctx);
      this.drawElements(ctx);
      this.drawGoals(ctx);
      if (s.paths) this.drawPaths(ctx, s.paths);
      if (s.followPath) this.drawPolyline(ctx, s.followPath, C.guide, 2.5, false);
      if (s.trail && s.trail.length > 1) this.drawPolyline(ctx, s.trail, C.trail, 2, false);
      if (s.ghost) this.drawRobot(ctx, s.ghost, s.robot, { ghost: true, handle: s.ghostHandle });
      if (s.aim && isFinite(s.aim.x)) this.drawAim(ctx, s.aim);
      if (s.pose) this.drawRobot(ctx, s.pose, s.robot, { hit: s.hit });
      if (s.codeAxes) this.drawCodeAxes(ctx, s.codeAxes);
    }

    drawField(ctx) {
      const S = this.scale;
      const x0 = this.wx(-F.HALF);
      const y0 = this.wy(F.HALF);
      const size = F.HALF * 2 * S;
      ctx.fillStyle = C.border;
      ctx.fillRect(0, 0, this.size, this.size);
      // perimeter
      ctx.fillStyle = C.wall;
      ctx.fillRect(x0 - 3 * S, y0 - 3 * S, size + 6 * S, size + 6 * S);
      // foam tiles
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
          ctx.fillStyle = (i + j) % 2 ? C.tileB : C.tileA;
          ctx.fillRect(x0 + i * F.TILE * S, y0 + j * F.TILE * S, F.TILE * S + 0.5, F.TILE * S + 0.5);
        }
      }
      ctx.strokeStyle = C.line;
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

    drawToggles(ctx) {
      const S = this.scale;
      const len = 26 * S;
      const th = 2.4 * S;
      ctx.fillStyle = C.gray;
      F.TOGGLES.forEach((t) => {
        const horizontal = t.wall === 'top' || t.wall === 'bottom';
        const cx = this.wx(t.x);
        const cy = this.wy(t.y);
        if (horizontal) ctx.fillRect(cx - len / 2, cy - th / 2, len, th);
        else ctx.fillRect(cx - th / 2, cy - len / 2, th, len);
      });
    }

    drawLoaders(ctx) {
      const S = this.scale;
      const sz = 6 * S;
      F.LOADERS.forEach((l) => {
        ctx.fillStyle = '#2a2c30';
        ctx.fillRect(this.wx(l.x) - sz / 2, this.wy(l.y) - sz / 2, sz, sz);
        ctx.strokeStyle = '#a4a8af';
        ctx.lineWidth = 1;
        ctx.strokeRect(this.wx(l.x) - sz / 2, this.wy(l.y) - sz / 2, sz, sz);
      });
    }

    drawElements(ctx) {
      const S = this.scale;
      F.ELEMENTS.forEach((e) => {
        const x = this.wx(e.x);
        const y = this.wy(e.y);
        ctx.beginPath();
        if (e.type === 'cup') {
          ctx.arc(x, y, 1.9 * S, 0, Math.PI * 2);
          ctx.fillStyle = C[e.color] || C.gray;
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        } else {
          ctx.arc(x, y, 1.2 * S, 0, Math.PI * 2);
          ctx.fillStyle = C[e.color] || C.yellow;
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        }
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    }

    drawGoals(ctx) {
      const S = this.scale;
      F.GOALS.forEach((g) => {
        const r = F.GOAL_RADIUS[g.kind] * S;
        ctx.beginPath();
        ctx.arc(this.wx(g.x), this.wy(g.y), r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20,22,26,0.35)';
        ctx.fill();
        ctx.strokeStyle = g.team === 'red' ? C.red : g.team === 'blue' ? C.blue : C.neutral;
        ctx.lineWidth = g.kind === 'tall' ? 3 : 2.5;
        ctx.stroke();
      });
    }

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
        this.drawPolyline(ctx, p.points, p.color, 1.5, true);
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
      ctx.fillStyle = o.ghost ? 'rgba(255,255,255,0.08)' : o.hit ? C.hit : C.robot;
      ctx.globalAlpha = o.ghost ? 1 : 0.7;
      ctx.fillRect(-W / 2, -L / 2, W, L);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = o.ghost ? 'rgba(255,255,255,0.8)' : '#0b1d1a';
      ctx.lineWidth = 1.5;
      ctx.setLineDash(o.ghost ? [5, 3] : []);
      ctx.strokeRect(-W / 2, -L / 2, W, L);
      ctx.setLineDash([]);
      // heading line
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
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#e06666';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(len, 0);
      ctx.stroke();
      ctx.strokeStyle = '#7bc47f';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -len);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '11px Consolas, "Liberation Mono", monospace';
      ctx.fillText('x', len + 3, 4);
      ctx.fillText('y', 4, -len - 3);
      ctx.restore();
    }
  }

  NS.Renderer = Renderer;
})();
