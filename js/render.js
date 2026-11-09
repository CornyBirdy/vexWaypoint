/* Canvas renderer: field, game elements, paths, trail and robot. */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});
  const F = NS.FIELD;

  const VIEW = 160; // inches shown: the field plus a border
  const WALL = 2.6; // perimeter band thickness

  // colours come from the CSS tokens (css/tokens.css); reloaded whenever the theme changes
  const C = {};
  const TOKENS = {
    bg: 'art-bg', wall: 'art-wall', wallEdge: 'art-wall-edge', tileA: 'art-tile-a', tileB: 'art-tile-b',
    seam: 'art-seam', tape: 'art-tape', red: 'art-red', blue: 'art-blue', yellow: 'art-yellow',
    pinYellow: 'art-pin-yellow', pinRed: 'art-pin-red', pinBlue: 'art-pin-blue', cupWhite: 'art-cup-white',
    cupGray: 'art-cup-gray', ink: 'art-ink', goalBlack: 'art-goal-black', goalRed: 'art-goal-red',
    goalBlue: 'art-goal-blue', goalRim: 'art-goal-rim', goalHub: 'art-goal-hub', goalHole: 'art-goal-hole',
    mount: 'art-mount', shade: 'art-shade', shadeSoft: 'art-shade-soft',
    robot: 'ov-robot', robotEdge: 'ov-robot-edge', hit: 'ov-hit', trail: 'ov-trail', guide: 'ov-guide',
    axisX: 'ov-axis-x', axisY: 'ov-axis-y', label: 'ov-label', curve: 'ov-curve', curveSel: 'ov-curve-sel',
    handleLine: 'ov-handle-line', point: 'ov-point', pointEdge: 'ov-point-edge', pointLocked: 'ov-point-locked',
    ghostFill: 'ov-ghost-fill', ghostEdge: 'ov-ghost-edge',
  };
  const hex = {};
  let paletteVersion = -1;
  function loadPalette() {
    const T = NS.theme;
    if (paletteVersion === T.version) return;
    paletteVersion = T.version;
    Object.keys(TOKENS).forEach((k) => (C[k] = T.color(TOKENS[k])));
    C.mono = T.color('mono');
    hex.red = C.pinRed;
    hex.blue = C.pinBlue;
    hex.yellow = C.yellow;
  }


  // the field photos (from path.jerryio) cover the field plus its perimeter
  const PHOTO_HALF = 74.0; // inches from the field centre to the edge of the picture
  const LOGO = { src: 'assets/invictus-52111a-light.svg', ratio: 1194 / 309 }; // team watermark
  const PHOTOS = { match: 'assets/field/override-match.png', skills: 'assets/field/override-skills.png' };

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.w = 700;
      this.h = 700;
      this.dpr = 1;
      this.style = 'photo-match'; // 'photo-match' | 'photo-skills' | 'drawn'
      this.images = {};
      this.onImageLoad = null;
      this.logo = new Image();
      this.logo.onload = () => this.onImageLoad && this.onImageLoad();
      this.logo.src = LOGO.src;
      this.resize();
    }

    setFieldStyle(style) {
      this.style = style;
      const key = style === 'photo-skills' ? 'skills' : style === 'photo-match' ? 'match' : null;
      if (key && !this.images[key]) {
        const img = new Image();
        img.onload = () => this.onImageLoad && this.onImageLoad();
        img.src = PHOTOS[key];
        this.images[key] = img;
      }
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
      loadPalette();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, this.w, this.h);
      const photo = this.photo();
      if (photo) this.drawPhoto(ctx, photo);
      else {
        this.drawField(ctx);
        this.drawMarkings(ctx);
        this.drawLoaders(ctx);
        this.drawElements(ctx);
        this.drawGoals(ctx);
        this.drawToggles(ctx);
      }
      if (s.paths) this.drawPaths(ctx, s.paths);
      if (s.edit) this.drawEdit(ctx, s.edit);
      if (s.followPath) this.drawPolyline(ctx, s.followPath, C.guide, 2.5, false);
      if (s.trail && s.trail.length > 1) this.drawPolyline(ctx, s.trail, C.trail, 2, false);
      if (s.logs) this.drawLogs(ctx, s.logs, s.robot);
      if (s.ghost) this.drawRobot(ctx, s.ghost, s.robot, { ghost: true, handle: s.ghostHandle });
      if (s.aim && isFinite(s.aim.x)) this.drawAim(ctx, s.aim);
      if (s.pose) this.drawRobot(ctx, s.pose, s.robot, { hit: s.hit });
      if (s.codeAxes) this.drawCodeAxes(ctx, s.codeAxes);
      this.drawWatermark(ctx);
    }

    /** "made by" mark in the bottom-right corner, in the border below the field */
    drawWatermark(ctx) {
      const img = this.logo;
      if (!img || !img.complete || !img.naturalWidth) return;
      const h = 3.3 * this.scale;
      const w = h * LOGO.ratio;
      ctx.globalAlpha = 0.5;
      ctx.drawImage(img, this.wx(78.5) - w, this.wy(-77.2) - h / 2, w, h);
      ctx.globalAlpha = 1;
    }

    // ---------------------------------------------------------- field

    /** the loaded photo for the current style, or null while it loads / when drawing the field */
    photo() {
      const key = this.style === 'photo-skills' ? 'skills' : this.style === 'photo-match' ? 'match' : null;
      const img = key && this.images[key];
      return img && img.complete && img.naturalWidth ? img : null;
    }

    drawPhoto(ctx, img) {
      const x0 = this.wx(-PHOTO_HALF);
      const y0 = this.wy(PHOTO_HALF);
      const size = PHOTO_HALF * 2 * this.scale;
      ctx.drawImage(img, x0, y0, size, size);
    }

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
        ctx.strokeStyle = C.shade;
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
        const body = g.team === 'red' ? C.goalRed : g.team === 'blue' ? C.goalBlue : C.goalBlack;
        const rim = g.team === 'red' ? C.red : g.team === 'blue' ? C.blue : C.goalRim;
        // soft shadow
        this.octagon(ctx, cx + 0.4 * S, cy + 0.6 * S, size, 0.2);
        ctx.fillStyle = C.shadeSoft;
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
          ctx.fillStyle = C.goalHub;
          ctx.fill();
          this.drawPin(ctx, { x: g.x, y: g.y, top: 'yellow', bottom: 'yellow' });
        } else {
          ctx.beginPath();
          ctx.arc(cx, cy, size * 0.27, 0, Math.PI * 2);
          ctx.fillStyle = body;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(cx, cy, size * 0.16, 0, Math.PI * 2);
          ctx.fillStyle = C.goalHole;
          ctx.fill();
        }
        // AprilTag id
        ctx.fillStyle = C.label;
        ctx.font = `${Math.max(9, 2.6 * S)}px ${C.mono}`;
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
        ctx.strokeStyle = C.shade;
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
        ctx.fillStyle = C.goalBlack;
        ctx.fill();
        ctx.strokeStyle = l.team === 'red' ? C.red : C.blue;
        ctx.lineWidth = Math.max(1, 0.3 * S);
        ctx.stroke();
        // mounting bar on the wall
        ctx.fillStyle = C.mount;
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

    /** editable paths: speed-coloured points, curves, and control handles for the selected path */
    drawEdit(ctx, edit) {
      const S = this.scale;
      edit.paths.forEach((p) => {
        if (!p.visible) return;
        ctx.globalAlpha = p.selected ? 1 : 0.55;
        // curve
        ctx.strokeStyle = p.selected ? C.curveSel : C.curve;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        p.points.forEach((q, i) => (i ? ctx.lineTo(this.wx(q.x), this.wy(q.y)) : ctx.moveTo(this.wx(q.x), this.wy(q.y))));
        ctx.stroke();
        // points coloured by speed: red = slowest, green = fastest
        const span = p.to - p.from || 1;
        p.points.forEach((q) => {
          const pct = (q.v - p.from) / span;
          const hue = Math.max(-20, Math.min(120, pct * 90));
          ctx.fillStyle = `hsl(${hue}, 75%, 50%)`;
          ctx.beginPath();
          ctx.arc(this.wx(q.x), this.wy(q.y), Math.max(1.6, 0.42 * S), 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.globalAlpha = 1;
        if (!p.selected) return;
        // handles
        p.segments.forEach((seg) => {
          const c = seg.controls;
          if (c.length === 4) {
            ctx.strokeStyle = C.handleLine;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(this.wx(c[0].x), this.wy(c[0].y));
            ctx.lineTo(this.wx(c[1].x), this.wy(c[1].y));
            ctx.moveTo(this.wx(c[3].x), this.wy(c[3].y));
            ctx.lineTo(this.wx(c[2].x), this.wy(c[2].y));
            ctx.stroke();
            ctx.setLineDash([]);
          }
        });
        p.controls.forEach((c) => {
          if (!c.visible) return;
          const x = this.wx(c.x);
          const y = this.wy(c.y);
          const sel = c.uid === edit.selCtrl;
          ctx.beginPath();
          if (c.__type === 'end-point') {
            ctx.arc(x, y, Math.max(5, 1.5 * S), 0, Math.PI * 2);
            ctx.fillStyle = sel ? C.guide : C.point;
            ctx.fill();
            ctx.strokeStyle = p.locked ? C.pointLocked : C.pointEdge;
            ctx.lineWidth = 2;
            ctx.stroke();
          } else {
            ctx.arc(x, y, Math.max(3.5, 1.0 * S), 0, Math.PI * 2);
            ctx.fillStyle = sel ? C.guide : C.robot;
            ctx.fill();
            ctx.strokeStyle = C.point;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        });
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
      ctx.fillStyle = o.ghost ? C.ghostFill : o.hit ? C.hit : C.robot;
      ctx.globalAlpha = o.ghost ? 1 : 0.8;
      ctx.fillRect(-W / 2, -L / 2, W, L);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = o.ghost ? C.ghostEdge : C.robotEdge;
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

    /** real-robot pose logs (Tune): a solid line each, plus an outline robot for the selected one */
    drawLogs(ctx, logs, dims) {
      logs.forEach((l) => this.drawPolyline(ctx, l.points, l.color, l.selected ? 2.5 : 1.5, false));
      logs.forEach((l) => {
        if (!l.pose) return;
        const S = this.scale;
        ctx.save();
        ctx.translate(this.wx(l.pose.x), this.wy(l.pose.y));
        ctx.rotate((l.pose.h * Math.PI) / 180);
        ctx.strokeStyle = l.color;
        ctx.lineWidth = 2;
        ctx.strokeRect((-dims.width / 2) * S, (-dims.length / 2) * S, dims.width * S, dims.length * S);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, (-dims.length / 2) * S);
        ctx.stroke();
        ctx.restore();
      });
    }

    /** code-frame axes drawn at the start pose */
    drawCodeAxes(ctx, a) {
      const len = 12 * this.scale;
      ctx.save();
      ctx.translate(this.wx(a.x), this.wy(a.y));
      ctx.rotate((a.h * Math.PI) / 180);
      ctx.lineWidth = 2;
      ctx.strokeStyle = C.axisX;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(len, 0);
      ctx.stroke();
      ctx.strokeStyle = C.axisY;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -len);
      ctx.stroke();
      ctx.fillStyle = C.label;
      ctx.font = `bold 11px ${C.mono}`;
      ctx.fillText('x', len + 3, 4);
      ctx.fillText('y', 4, -len - 3);
      ctx.restore();
    }
  }

  NS.Renderer = Renderer;
})();
