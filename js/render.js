/* Canvas renderer: field, game elements, paths, trail and robot. */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  const VIEW = 160; // inches shown: the field plus a border

  // colours come from the CSS tokens (css/tokens.css); reloaded whenever the theme changes
  const C = {};
  const TOKENS = {
    bg: 'art-bg',
    robot: 'ov-robot', robotEdge: 'ov-robot-edge', hit: 'ov-hit', trail: 'ov-trail', guide: 'ov-guide',
    axisX: 'ov-axis-x', axisY: 'ov-axis-y', label: 'ov-label', curve: 'ov-curve', curveSel: 'ov-curve-sel',
    handleLine: 'ov-handle-line', point: 'ov-point', pointEdge: 'ov-point-edge', pointLocked: 'ov-point-locked',
    ghostFill: 'ov-ghost-fill', ghostEdge: 'ov-ghost-edge', odom: 'ov-odom',
  };
  let paletteVersion = -1;
  function loadPalette() {
    const T = NS.theme;
    if (paletteVersion === T.version) return;
    paletteVersion = T.version;
    Object.keys(TOKENS).forEach((k) => (C[k] = T.color(TOKENS[k])));
    C.mono = T.color('mono');
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
      this.style = 'photo-match'; // 'photo-match' | 'photo-skills'
      this.onImageLoad = null;
      // both field pictures load up front, so switching between them never shows an empty field
      this.images = {};
      Object.keys(PHOTOS).forEach((key) => {
        const img = new Image();
        img.onload = () => this.onImageLoad && this.onImageLoad();
        img.src = PHOTOS[key];
        this.images[key] = img;
      });
      this.shown = null; // the last picture that was ready to draw
      this.logo = new Image();
      this.logo.onload = () => this.onImageLoad && this.onImageLoad();
      this.logo.src = LOGO.src;
      this.resize();
    }

    setFieldStyle(style) {
      this.style = style === 'photo-skills' ? 'photo-skills' : 'photo-match';
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
      if (s.paths) this.drawPaths(ctx, s.paths);
      if (s.edit) this.drawEdit(ctx, s.edit);
      if (s.followPath) this.drawPolyline(ctx, s.followPath, C.guide, 2.5, false);
      if (s.trail && s.trail.length > 1) this.drawPolyline(ctx, s.trail, C.trail, 2, false);
      if (s.ghost) this.drawRobot(ctx, s.ghost, s.robot, { ghost: true, handle: s.ghostHandle });
      if (s.aim && isFinite(s.aim.x)) this.drawAim(ctx, s.aim);
      if (s.odom) this.drawRobot(ctx, s.odom, s.robot, { odom: true });
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

    /** the picture for the current style; while it is still loading, the one that was showing before */
    photo() {
      const img = this.images[this.style === 'photo-skills' ? 'skills' : 'match'];
      if (img.complete && img.naturalWidth) this.shown = img;
      return this.shown;
    }

    drawPhoto(ctx, img) {
      const x0 = this.wx(-PHOTO_HALF);
      const y0 = this.wy(PHOTO_HALF);
      const size = PHOTO_HALF * 2 * this.scale;
      ctx.drawImage(img, x0, y0, size, size);
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
      if (o.odom) {
        // outline only: the robot as its own odometry sees it
        ctx.strokeStyle = C.odom;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(-W / 2, -L / 2, W, L);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -L / 2);
        ctx.stroke();
        ctx.restore();
        return;
      }
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
