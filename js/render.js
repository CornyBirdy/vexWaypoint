/* Canvas renderer: field, game elements, paths, trail and robot. */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});
  const F = NS.FIELD;

  const VIEW = 160; // inches shown: the field plus a border
  const WALL = 2.6; // perimeter band thickness

  const C = {
    bg: '#1a1b1e',
    wall: '#dcdddf',
    wallEdge: '#8f9092',
    tileA: '#373739',
    tileB: '#343436',
    seam: '#2b2b2d',
    tape: '#bcc1dd',
    red: '#c9283d',
    blue: '#2a9ad8',
    yellow: '#e8dc63',
    pinYellow: '#e9d95f',
    pinRed: '#d02a40',
    pinBlue: '#2f9fe3',
    cupWhite: '#ffffff',
    cupGray: '#5b5c61',
    ink: '#0d0d0e',
    goalBlack: '#1b1b1d',
    robot: '#2f8f83',
    hit: '#d9822b',
    trail: '#37c4b0',
    guide: '#f2c230',
  };

  const hex = { red: C.pinRed, blue: C.pinBlue, yellow: C.yellow };

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.w = 700;
      this.h = 700;
      this.dpr = 1;
      this.resize();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.w = Math.max(240, Math.floor(rect.width || 700));
      this.h = this.w;
      this.dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.scale = this.w / VIEW;
    }

    wx(x) {
      return (x + VIEW / 2) * this.scale;
    }
    wy(y) {
      return (VIEW / 2 - y) * this.scale;
    }
    /** css pixels (relative to the canvas) -> inches */
    toWorld(px, py) {
      return { x: px / this.scale - VIEW / 2, y: VIEW / 2 - py / this.scale };
    }

    draw(s) {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, this.w, this.h);
      this.drawField(ctx);
      this.drawMarkings(ctx);
      this.drawLoaders(ctx);
      this.drawElements(ctx);
      this.drawGoals(ctx);
      this.drawToggles(ctx);
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
      ctx.fillStyle = C.wallEdge;
      ctx.fillRect(x0 - (WALL + 0.3) * S, y0 - (WALL + 0.3) * S, size + (WALL + 0.3) * 2 * S, size + (WALL + 0.3) * 2 * S);
      ctx.fillStyle = C.wall;
      ctx.fillRect(x0 - WALL * S, y0 - WALL * S, size + WALL * 2 * S, size + WALL * 2 * S);
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
          ctx.fillStyle = (i + j) % 2 ? C.tileB : C.tileA;
          ctx.fillRect(x0 + i * F.TILE * S, y0 + j * F.TILE * S, F.TILE * S + 0.5, F.TILE * S + 0.5);
        }
      }
      ctx.strokeStyle = C.seam;
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
          this.line(ctx, sx * F.BOX.x, sy * H, sx * F.BOX.x, sy * F.BOX.y, color, 0.85);
          this.line(ctx, sx * H, sy * F.BOX.y, sx * (F.BOX.x + 0.43), sy * F.BOX.y, color, 0.85);
        });
      });
      // centre diamond
      const r = F.DIAMOND_R;
      [[0, r, r, 0], [r, 0, 0, -r], [0, -r, -r, 0], [-r, 0, 0, r]].forEach((l) => this.line(ctx, l[0], l[1], l[2], l[3], C.tape, 0.9));
      // diagonals: TL-BR is a double line, TR-BL a single line
      const a = F.DIAGONAL_FROM;
      const b = F.DIAGONAL_TO;
      const d = F.DIAGONAL_GAP / 2 / Math.SQRT2;
      [[-1, 1], [1, -1]].forEach(([sx, sy]) => {
        this.line(ctx, sx * a + d, sy * a + d, sx * b + d, sy * b + d, C.tape, 0.9);
        this.line(ctx, sx * a - d, sy * a - d, sx * b - d, sy * b - d, C.tape, 0.9);
      });
      [[1, 1], [-1, -1]].forEach(([sx, sy]) => this.line(ctx, sx * a, sy * a, sx * b, sy * b, C.tape, 0.9));
    }

    // ---------------------------------------------------------- elements

    drawElements(ctx) {
      const E = F.ELEMENTS;
      E.filter((e) => e.type === 'arm').forEach((e) => this.drawArm(ctx, e));
      E.filter((e) => e.type === 'cup').forEach((e) => this.drawCup(ctx, e));
      E.filter((e) => e.type === 'pin').forEach((e) => this.drawPin(ctx, e));
    }

    drawCup(ctx, e) {
      const S = this.scale;
      const x = this.wx(e.x);
      const y = this.wy(e.y);
      const r = 1.6 * S;
      const col = (c) => (c === 'white' ? C.cupWhite : C.cupGray);
      ctx.beginPath();
      ctx.arc(x, y, r, Math.PI, 0);
      ctx.closePath();
      ctx.fillStyle = col(e.top);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI);
      ctx.closePath();
      ctx.fillStyle = col(e.top === 'white' ? 'gray' : 'white');
      ctx.fill();
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = Math.max(1, 0.22 * S);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.moveTo(x - r, y);
      ctx.lineTo(x + r, y);
      ctx.stroke();
    }

    hexPath(ctx, x, y, r) {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 3;
        const px = x + Math.cos(a) * r;
        const py = y + Math.sin(a) * r;
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      }
      ctx.closePath();
    }

    /** a standing pin seen from above: black-outlined hexagon split into two halves */
    drawPin(ctx, e) {
      const S = this.scale;
      const x = this.wx(e.x);
      const y = this.wy(e.y);
      const r = 1.2 * S;
      ctx.save();
      this.hexPath(ctx, x, y, r);
      ctx.clip();
      ctx.fillStyle = hex[e.top] || C.yellow;
      ctx.fillRect(x - r, y - r, r * 2, r);
      ctx.fillStyle = hex[e.bottom] || C.yellow;
      ctx.fillRect(x - r, y, r * 2, r);
      ctx.restore();
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = Math.max(1, 0.2 * S);
      this.hexPath(ctx, x, y, r);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - r * 0.87, y);
      ctx.lineTo(x + r * 0.87, y);
      ctx.stroke();
    }

    /** a pin lying flat: slim yellow neck from the cup, flared coloured cap at the tip */
    drawArm(ctx, e) {
      const S = this.scale;
      ctx.save();
      ctx.translate(this.wx(e.x), this.wy(e.y));
      ctx.rotate((e.deg * Math.PI) / 180);
      const poly = (pts, fill) => {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p[1] * S, -p[0] * S) : ctx.moveTo(p[1] * S, -p[0] * S)));
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = Math.max(1, 0.15 * S);
        ctx.stroke();
      };
      // neck (distance from cup centre, half width)
      poly([[1.4, -1.0], [1.4, 1.0], [4.5, 1.6], [4.5, -1.6]], C.pinYellow);
      // cap: lip then cone narrowing to the tip
      const cap = e.color === 'red' ? C.pinRed : C.pinBlue;
      poly([[4.3, -1.9], [4.3, 1.9], [4.8, 1.9], [8.2, 1.2], [8.2, -1.2], [4.8, -1.9]], cap);
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
        const size = F.GOAL_SIZE * S;
        const neutral = g.team === 'neutral';
        const body = g.team === 'red' ? '#b92337' : g.team === 'blue' ? '#2589c4' : C.goalBlack;
        const rim = g.team === 'red' ? C.red : g.team === 'blue' ? C.blue : '#2a2a2d';
        // soft shadow
        this.octagon(ctx, cx + 0.4 * S, cy + 0.6 * S, size, 0.2);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fill();
        this.octagon(ctx, cx, cy, size, 0.2);
        ctx.fillStyle = body;
        ctx.fill();
        // raised inner octagon
        this.octagon(ctx, cx, cy, size * 0.74, 0.28);
        ctx.fillStyle = rim;
        ctx.fill();
        if (neutral) {
          ctx.beginPath();
          ctx.arc(cx, cy, size * 0.27, 0, Math.PI * 2);
          ctx.fillStyle = '#e3d56a';
          ctx.fill();
          this.drawPin(ctx, { x: g.x, y: g.y, top: 'yellow', bottom: 'yellow' });
        } else {
          ctx.beginPath();
          ctx.arc(cx, cy, size * 0.27, 0, Math.PI * 2);
          ctx.fillStyle = body;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(cx, cy, size * 0.16, 0, Math.PI * 2);
          ctx.fillStyle = '#16090b';
          ctx.fill();
        }
        // AprilTag id
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.max(9, 2.6 * S)}px Consolas, "Liberation Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(g.tag), cx + size * 0.36, cy - size * 0.33);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      });
    }

    drawToggles(ctx) {
      const S = this.scale;
      const len = 26.5 * S;
      const th = 1.7 * S;
      const edge = 0.4 * S;
      F.TOGGLES.forEach((t) => {
        const horizontal = t.wall === 'top' || t.wall === 'bottom';
        const sign = t.wall === 'top' || t.wall === 'right' ? 1 : -1;
        const c = F.HALF + 1.1;
        const cx = this.wx(horizontal ? 0 : sign * c);
        const cy = this.wy(horizontal ? sign * c : 0);
        const w = horizontal ? len : th;
        const h = horizontal ? th : len;
        ctx.fillStyle = C.yellow;
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
        ctx.fillStyle = t.edge === 'red' ? C.red : C.blue;
        // coloured strip on the outer edge
        if (t.wall === 'top') ctx.fillRect(cx - w / 2, cy - h / 2, w, edge);
        if (t.wall === 'bottom') ctx.fillRect(cx - w / 2, cy + h / 2 - edge, w, edge);
        if (t.wall === 'left') ctx.fillRect(cx - w / 2, cy - h / 2, edge, h);
        if (t.wall === 'right') ctx.fillRect(cx + w / 2 - edge, cy - h / 2, edge, h);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
      });
    }

    drawLoaders(ctx) {
      const S = this.scale;
      F.LOADERS.forEach((l) => {
        const dir = l.x < 0 ? 1 : -1; // direction into the field
        const px = (d, w) => [this.wx(l.x + dir * d), this.wy(l.y + w)];
        const pts = [px(0, 2.25), px(2.2, 2.25), px(5.4, 1.6), px(5.4, -1.6), px(2.2, -2.25), px(0, -2.25)];
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.closePath();
        ctx.fillStyle = '#1b1b1d';
        ctx.fill();
        ctx.strokeStyle = l.team === 'red' ? C.red : C.blue;
        ctx.lineWidth = Math.max(1, 0.3 * S);
        ctx.stroke();
        // mounting bar on the wall
        ctx.fillStyle = '#0b0b0c';
        ctx.fillRect(this.wx(l.x) - (l.x < 0 ? 0.1 : 0.6) * S, this.wy(l.y + 2.25), 0.7 * S, 4.5 * S);
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
      ctx.globalAlpha = o.ghost ? 1 : 0.8;
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
      ctx.strokeStyle = '#e8584a';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(len, 0);
      ctx.stroke();
      ctx.strokeStyle = '#4cc36f';
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
