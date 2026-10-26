/* Canvas renderer: field, game elements (visual only), paths, trail and robot. */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});
  const F = NS.FIELD;
  const MARGIN = 9; // inches of border drawn around the 144 in field

  const COLORS = {
    mat: '#4a5058',
    tileLine: '#5d646d',
    tileAlt: '#51575f',
    wall: '#14171b',
    wallEdge: '#2a2f36',
    red: '#e5484d',
    blue: '#3e7bfa',
    neutral: '#c9ccd2',
    yellow: '#f5c518',
    robot: '#19c3a6',
    robotHit: '#ff8a3d',
    ghost: 'rgba(255,255,255,0.55)',
    trail: 'rgba(25,195,166,0.75)',
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

    // world (inches) <-> css pixels
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
      if (s.followPath) this.drawPolyline(ctx, s.followPath, '#ffd166', 3, false);
      if (s.trail && s.trail.length > 1) this.drawPolyline(ctx, s.trail, COLORS.trail, 2.5, false);
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
      // border / perimeter
      ctx.fillStyle = COLORS.wall;
      ctx.fillRect(0, 0, this.size, this.size);
      ctx.strokeStyle = COLORS.wallEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 - 3.5 * S, y0 - 3.5 * S, size + 7 * S, size + 7 * S);
      // foam tiles
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
          ctx.fillStyle = (i + j) % 2 ? COLORS.tileAlt : COLORS.mat;
          ctx.fillRect(x0 + i * F.TILE * S, y0 + j * F.TILE * S, F.TILE * S + 0.5, F.TILE * S + 0.5);
        }
      }
      ctx.strokeStyle = COLORS.tileLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k <= 6; k++) {
        ctx.moveTo(x0 + k * F.TILE * S, y0);
        ctx.lineTo(x0 + k * F.TILE * S, y0 + size);
        ctx.moveTo(x0, y0 + k * F.TILE * S);
        ctx.lineTo(x0 + size, y0 + k * F.TILE * S);
      }
      ctx.stroke();
      // centre cross-hair
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(this.wx(0), this.wy(-F.HALF));
      ctx.lineTo(this.wx(0), this.wy(F.HALF));
      ctx.moveTo(this.wx(-F.HALF), this.wy(0));
      ctx.lineTo(this.wx(F.HALF), this.wy(0));
      ctx.stroke();
      // alliance stripes on the walls (red bottom half, blue top half)
      const stripe = 2.2 * S;
      ctx.fillStyle = COLORS.red;
      ctx.fillRect(x0 - stripe - 1, this.wy(0), stripe, size / 2);
      ctx.fillRect(x0, y0 + size + 1, size / 2, stripe);
      ctx.fillStyle = COLORS.blue;
      ctx.fillRect(x0 + size + 1, y0, stripe, size / 2);
      ctx.fillRect(x0 + size / 2, y0 - stripe - 1, size / 2, stripe);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.strokeRect(x0, y0, size, size);
    }

    drawToggles(ctx) {
      const S = this.scale;
      F.TOGGLES.forEach((t) => {
        const horizontal = t.wall === 'top' || t.wall === 'bottom';
        const len = 26 * S;
        const th = 3.4 * S;
        const off = t.wall === 'top' ? -1.6 : t.wall === 'bottom' ? 1.6 : 0;
        const offx = t.wall === 'left' ? -1.6 : t.wall === 'right' ? 1.6 : 0;
        const cx = this.wx(t.x + offx);
        const cy = this.wy(t.y + off);
        ctx.fillStyle = t.team === 'red' ? COLORS.red : COLORS.blue;
        ctx.globalAlpha = 0.9;
        if (horizontal) ctx.fillRect(cx - len / 2, cy - th / 2, len, th);
        else ctx.fillRect(cx - th / 2, cy - len / 2, th, len);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#e9eaee';
        ctx.beginPath();
        ctx.arc(cx, cy, th * 0.55, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    drawLoaders(ctx) {
      const S = this.scale;
      F.LOADERS.forEach((l) => {
        const sz = 7 * S;
        ctx.fillStyle = '#2b3037';
        ctx.fillRect(this.wx(l.x) - sz / 2, this.wy(l.y) - sz / 2, sz, sz);
        ctx.strokeStyle = '#9aa1ab';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(this.wx(l.x) - sz / 2, this.wy(l.y) - sz / 2, sz, sz);
        ctx.fillStyle = '#0d0f12';
        ctx.beginPath();
        ctx.arc(this.wx(l.x), this.wy(l.y), 1.7 * S, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    drawElements(ctx) {
      const S = this.scale;
      F.ELEMENTS.forEach((e) => {
        const x = this.wx(e.x);
        const y = this.wy(e.y);
        if (e.type === 'cup') {
          ctx.strokeStyle = '#e7e9ee';
          ctx.fillStyle = 'rgba(231,233,238,0.18)';
          ctx.lineWidth = Math.max(1, 0.7 * S);
          ctx.beginPath();
          ctx.arc(x, y, 1.9 * S, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillStyle = COLORS[e.team] || COLORS.yellow;
          ctx.strokeStyle = 'rgba(0,0,0,0.5)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 1.2 * S, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      });
    }

    drawGoals(ctx) {
      const S = this.scale;
      F.GOALS.forEach((g) => {
        const r = F.GOAL_RADIUS[g.kind] * S;
        const x = this.wx(g.x);
        const y = this.wy(g.y);
        ctx.fillStyle = g.team === 'red' ? 'rgba(229,72,77,0.35)' : g.team === 'blue' ? 'rgba(62,123,250,0.35)' : 'rgba(201,204,210,0.28)';
        ctx.strokeStyle = g.team === 'red' ? COLORS.red : g.team === 'blue' ? COLORS.blue : COLORS.neutral;
        ctx.lineWidth = g.kind === 'tall' ? 3 : 2.2;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    }

    drawPolyline(ctx, pts, color, width, dashed) {
      if (!pts || pts.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dashed ? [6, 5] : []);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(this.wx(p.x), this.wy(p.y)) : ctx.moveTo(this.wx(p.x), this.wy(p.y))));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    drawPaths(ctx, paths) {
      paths.forEach((p) => {
        if (!p.visible || !p.points.length) return;
        this.drawPolyline(ctx, p.points, p.color, 2, true);
        const a = p.points[0];
        const b = p.points[p.points.length - 1];
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(this.wx(a.x), this.wy(a.y), 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(this.wx(b.x) - 3.5, this.wy(b.y) - 3.5, 7, 7);
      });
    }

    drawAim(ctx, a) {
      const x = this.wx(a.x);
      const y = this.wy(a.y);
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.moveTo(x - 10, y);
      ctx.lineTo(x + 10, y);
      ctx.moveTo(x, y - 10);
      ctx.lineTo(x, y + 10);
      ctx.stroke();
    }

    /** pose = {x, y, h} with h in compass degrees (0 = up, clockwise) */
    drawRobot(ctx, pose, dims, o) {
      const S = this.scale;
      const L = dims.length * S;
      const W = dims.width * S;
      ctx.save();
      ctx.translate(this.wx(pose.x), this.wy(pose.y));
      ctx.rotate((pose.h * Math.PI) / 180);
      // wheels
      ctx.fillStyle = o.ghost ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.55)';
      ctx.fillRect(-W / 2 - 2, -L / 2 + L * 0.12, 4, L * 0.76);
      ctx.fillRect(W / 2 - 2, -L / 2 + L * 0.12, 4, L * 0.76);
      // body
      ctx.fillStyle = o.ghost ? 'rgba(255,255,255,0.10)' : o.hit ? COLORS.robotHit : COLORS.robot;
      ctx.globalAlpha = o.ghost ? 1 : 0.88;
      ctx.fillRect(-W / 2, -L / 2, W, L);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = o.ghost ? COLORS.ghost : '#06201b';
      ctx.setLineDash(o.ghost ? [5, 4] : []);
      ctx.lineWidth = 2;
      ctx.strokeRect(-W / 2, -L / 2, W, L);
      ctx.setLineDash([]);
      // front arrow
      ctx.fillStyle = o.ghost ? COLORS.ghost : '#06201b';
      ctx.beginPath();
      ctx.moveTo(0, -L / 2 + 2);
      ctx.lineTo(-W * 0.2, -L * 0.1);
      ctx.lineTo(W * 0.2, -L * 0.1);
      ctx.closePath();
      ctx.fill();
      if (o.handle) {
        ctx.beginPath();
        ctx.arc(0, -L / 2 - 14, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#ffd166';
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(0, -L / 2);
        ctx.lineTo(0, -L / 2 - 14);
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    }

    /** the code-frame axes (0,0,0) drawn at the start pose */
    drawCodeAxes(ctx, a) {
      const S = this.scale;
      const len = 14 * S;
      ctx.save();
      ctx.translate(this.wx(a.x), this.wy(a.y));
      ctx.rotate((a.h * Math.PI) / 180);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ff6b6b';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(len, 0);
      ctx.stroke();
      ctx.strokeStyle = '#6bff9b';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -len);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillText('x', len + 3, 4);
      ctx.fillText('y', 4, -len - 3);
      ctx.restore();
    }
  }

  NS.Renderer = Renderer;
})();
