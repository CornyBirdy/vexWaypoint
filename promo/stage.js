/* Waypoint reveal: deterministic stage. Every visual is a pure function of the global time `t`
 * (seconds), so the render rig can ask for any frame, in order, and get the same pixels each run. */
(function () {
  'use strict';
  const { SHOTS, TOTAL, WIPE, SITE_URL } = window.PROMO;
  const $ = (id) => document.getElementById(id);
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const E = {
    lin: (t) => t,
    io: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    io5: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2),
    out: (t) => 1 - Math.pow(1 - t, 3),
    out5: (t) => 1 - Math.pow(1 - t, 5),
    expo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    back: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2),
    inq: (t) => t * t,
  };
  const prog = (t, a, d, ease = E.out) => ease(clamp((t - a) / d));

  const REGION = { x0: 760, y0: 60, x1: 1880, y1: 1020 }; // where app content is fitted
  const APP = { w: 1200, h: 900 };
  const VIEW = 160; // inches across the field canvas (render.js)

  let shot = null;
  let A = null; // helper handed to shot scripts once the app is up
  let actionsDone = 0;
  let clicks = [];
  let lastDown = false;
  const scenes = { logo: $('sceneLogo'), title: $('sceneTitle'), grid: $('sceneGrid'), end: $('sceneEnd') };

  // ------------------------------------------------------------------ app handle

  function makeHelper(win) {
    const doc = win.document;
    const h = {
      win,
      doc,
      V: win.VSim,
      $: (id) => doc.getElementById(id),
      q: (s) => doc.querySelector(s),
      qa: (s) => Array.from(doc.querySelectorAll(s)),
      rect(sel) {
        const el = typeof sel === 'string' ? doc.querySelector(sel) : sel;
        if (!el) throw new Error('no element for ' + sel);
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      },
      union(sels) {
        const rs = sels.map((s) => h.rect(s));
        const x0 = Math.min(...rs.map((r) => r.x));
        const y0 = Math.min(...rs.map((r) => r.y));
        const x1 = Math.max(...rs.map((r) => r.x + r.w));
        const y1 = Math.max(...rs.map((r) => r.y + r.h));
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      },
      /** inches (field frame) -> app pixels */
      field(x, y) {
        const r = h.rect('#field');
        return { x: r.x + ((x + VIEW / 2) / VIEW) * r.w, y: r.y + ((VIEW / 2 - y) / VIEW) * r.h };
      },
      set(el, v) {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      change(el, v) {
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      click: (sel) => (typeof sel === 'string' ? doc.querySelector(sel) : sel).click(),
    };
    return h;
  }

  async function idle() {
    const t0 = performance.now();
    for (;;) {
      const busy = A.$('btnRun') && A.$('btnRun').classList.contains('busy');
      if (!busy) break;
      if (performance.now() - t0 > 20000) throw new Error('app stayed busy');
      await new Promise((r) => setTimeout(r, 4));
    }
  }

  // ------------------------------------------------------------------ camera

  function resolveTarget(spec) {
    // spec: selector | [selectors] | {rect:{x,y,w,h}} ; options pad / s / dx / dy / region
    const sels = spec.fit ? [].concat(spec.fit) : null;
    let r = spec.rect || A.union(sels);
    const reg = spec.region || REGION;
    const pad = spec.pad == null ? 40 : spec.pad;
    const rw = (reg.x1 - reg.x0 - 2 * pad) / r.w;
    const rh = (reg.y1 - reg.y0 - 2 * pad) / r.h;
    const s = spec.s || clamp(Math.min(rw, rh), 0.5, 2.1);
    return {
      cx: r.x + r.w / 2 + (spec.dx || 0),
      cy: r.y + r.h / 2 + (spec.dy || 0),
      s,
      rcx: (reg.x0 + reg.x1) / 2,
      rcy: (reg.y0 + reg.y1) / 2,
    };
  }

  function cameraAt(lt) {
    const keys = shot.camera;
    let i = 0;
    while (i + 1 < keys.length && keys[i + 1].t <= lt) i++;
    const k0 = keys[i];
    const k1 = keys[Math.min(i + 1, keys.length - 1)];
    // resolve lazily: layout may change between keys
    if (!k0._r) k0._r = resolveTarget(k0);
    if (k1 !== k0 && lt >= k0.t && !k1._r) k1._r = resolveTarget(k1);
    let a = k0._r;
    let b = k1 === k0 ? a : k1._r || a;
    const e = k1 === k0 ? 0 : (E[k1.ease || 'io'] || E.io)(clamp((lt - k0.t) / (k1.t - k0.t)));
    const s = Math.exp(lerp(Math.log(a.s), Math.log(b.s), e));
    const cx = lerp(a.cx, b.cx, e);
    const cy = lerp(a.cy, b.cy, e);
    const rcx = lerp(a.rcx, b.rcx, e);
    const rcy = lerp(a.rcy, b.rcy, e);
    return { s, tx: rcx - cx * s, ty: rcy - cy * s };
  }

  const toPage = (cam, p) => ({ x: cam.tx + p.x * cam.s, y: cam.ty + p.y * cam.s });

  // ------------------------------------------------------------------ cursor

  function resolvePoint(spec) {
    if (spec.app) return { x: spec.app[0], y: spec.app[1] };
    if (spec.field) return A.field(spec.field[0], spec.field[1]);
    const r = A.rect(spec.sel);
    return { x: r.x + r.w * (spec.fx == null ? 0.5 : spec.fx) + (spec.dx || 0), y: r.y + r.h * (spec.fy == null ? 0.5 : spec.fy) + (spec.dy || 0) };
  }

  function cursorAt(lt) {
    const segs = shot.mouse || [];
    let cur = null;
    let prev = null;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (lt >= s.t - s.dur) {
        cur = s;
        prev = segs[i - 1] || null;
      }
    }
    if (!cur) return { show: 0, down: false };
    if (!cur._to && !cur.hide) {
      // the target may not exist yet (a popup that opens on the previous click): hold position and retry next frame
      try {
        cur._to = resolvePoint(cur.to);
      } catch (e) {
        if (!prev || !prev._to) return { show: 0, down: false };
        return { show: 1, down: false, p: prev._to };
      }
    }
    if (cur.hide) return { show: lt < cur.t ? 1 : clamp(1 - (lt - cur.t) / 0.25), down: false, p: prev && prev._to, hold: true };
    const from = prev && prev._to ? prev._to : cur.from ? resolvePoint(cur.from) : cur._to;
    const e = E[cur.ease || 'io'](clamp((lt - (cur.t - cur.dur)) / cur.dur));
    // slight arc so the pointer does not travel in a dead-straight line
    const arc = (cur.arc == null ? 0.06 : cur.arc) * Math.sin(Math.PI * e) * Math.hypot(cur._to.x - from.x, cur._to.y - from.y);
    const dx = cur._to.x - from.x;
    const dy = cur._to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const p = { x: lerp(from.x, cur._to.x, e) - (dy / len) * arc, y: lerp(from.y, cur._to.y, e) + (dx / len) * arc };
    let down = false;
    if (cur.click === true) down = lt >= cur.t + 0.03 && lt < cur.t + 0.03 + 0.13;
    if (cur.drag) down = lt >= cur.t - cur.dur + 0.0 && lt < cur.t + 0.06;
    const first = !prev || prev.hide;
    const show = first ? clamp((lt - (cur.t - cur.dur)) / 0.25) : 1;
    return { show, down, p, click: cur.click ? cur.t + 0.03 : null, seg: cur };
  }

  // ------------------------------------------------------------------ caption

  function buildCaption(c) {
    const el = $('cap');
    if (!c) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML =
      `<div class="kicker"><i></i><span>${c.kicker}</span></div>` +
      `<h2>${c.lines.map((l) => `<span class="ln"><span class="in">${l}</span></span>`).join('')}</h2>` +
      (c.sub ? `<p>${c.sub}</p>` : '');
  }

  function captionAt(lt) {
    const c = shot.cap;
    const el = $('cap');
    if (!c) {
      el.style.opacity = 0;
      return;
    }
    const inT = lt - c.t0;
    const outT = lt - c.t1;
    el.style.opacity = inT < 0 ? 0 : 1;
    const q = outT > 0 ? E.io(clamp(outT / 0.35)) : 0;
    el.style.transform = `translateX(${-60 * q}px)`;
    el.style.opacity = inT < 0 ? 0 : 1 - q;
    const k = el.querySelector('.kicker');
    k.style.opacity = prog(inT, 0, 0.4);
    k.style.transform = `translateX(${(1 - prog(inT, 0, 0.5, E.out5)) * -30}px)`;
    k.querySelector('i').style.transform = `skewX(-30deg) scaleX(${prog(inT, 0.05, 0.5, E.out5)})`;
    el.querySelectorAll('.in').forEach((n, i) => {
      n.style.transform = `translateY(${(1 - prog(inT, 0.08 + i * 0.09, 0.7, E.expo)) * 115}%)`;
    });
    const p = el.querySelector('p');
    if (p) {
      const e = prog(inT, 0.3 + (c.lines.length - 1) * 0.09, 0.6, E.out5);
      p.style.opacity = e;
      p.style.transform = `translateY(${(1 - e) * 26}px)`;
    }
  }

  function lensAt(lt) {
    const el = $('lens');
    const L = shot.lens;
    if (!L) {
      el.style.opacity = 0;
      return;
    }
    const a = prog(lt, L.t0, 0.35, E.out5) * (1 - prog(lt, L.t1, 0.3, E.io));
    el.style.opacity = a;
    el.style.transform = `translateY(${(1 - a) * 24}px)`;
    if (a <= 0) return;
    const val = A.$(L.value);
    el.querySelector('.lbl').textContent = L.label(A);
    const v = el.querySelector('.val');
    v.textContent = val.textContent.trim();
    v.className = 'val ' + (val.classList.contains('over') ? 'over' : val.classList.contains('ok') ? 'ok' : '');
  }

  // ------------------------------------------------------------------ scenes

  const trackD = 'M 250 800 C 520 640, 700 940, 960 800 S 1400 650, 1670 790';
  let trackLen = 0;
  let nodesBuilt = false;
  function buildTitle() {
    ['trackBase', 'trackGlow', 'trackDone'].forEach((id) => $(id).setAttribute('d', trackD));
    const path = $('trackBase');
    trackLen = path.getTotalLength();
    const g = $('nodes');
    g.innerHTML = '';
    [0, 0.34, 0.67, 1].forEach((f, i) => {
      const p = path.getPointAtLength(trackLen * f);
      g.insertAdjacentHTML(
        'beforeend',
        `<g class="node" data-f="${f}" transform="translate(${p.x} ${p.y})"><circle r="26" fill="none" stroke="#c4b5fd" stroke-width="3" opacity=".0" class="ring"/><circle r="12" fill="#fff" stroke="#6d4aff" stroke-width="5" class="dot"/></g>`
      );
    });
    nodesBuilt = true;
  }

  function sceneLogo(lt) {
    const ms = Math.max(0, (lt - 0.3) * 1000);
    document.getAnimations().forEach((a) => {
      a.pause();
      a.currentTime = ms;
    });
    const logo = $('logo');
    logo.style.transform = `scale(${1 + 0.05 * clamp(lt / shot.dur)})`;
    logo.style.opacity = 1;
    const q = E.io(clamp((lt - 1.35) / 1.0));
    const gx = lerp(80, 720, q);
    const g = $('gSheen');
    g.setAttribute('x1', gx - 90);
    g.setAttribute('x2', gx + 90);
    $('sheen').style.opacity = q > 0 && q < 1 ? 1 : 0;
    const pr = scenes.logo.querySelector('.presents');
    const e = prog(lt, 1.7, 0.7, E.out5);
    pr.style.opacity = e;
    pr.style.transform = `translateY(${(1 - e) * 16}px)`;
    pr.style.letterSpacing = `${lerp(0.9, 0.6, e)}em`;
  }

  function sceneTitle(lt) {
    if (!nodesBuilt) buildTitle();
    const w = prog(lt, 0.12, 0.8, E.expo);
    $('wordClipRect').setAttribute('x', -1000);
    $('wordClipRect').setAttribute('y', -260);
    $('wordClipRect').setAttribute('width', 2000 * w);
    $('wordClipRect').setAttribute('height', 300);
    const word = $('titleWord');
    word.style.transform = `translateX(${(1 - w) * -60}px)`;
    const p = E.io(clamp((lt - 0.45) / 1.3));
    const len = trackLen * p;
    const base = $('trackBase');
    base.style.opacity = prog(lt, 0.3, 0.4);
    const done = $('trackDone');
    done.style.strokeDasharray = `${len} ${trackLen + 10}`;
    $('trackGlow').style.strokeDasharray = `${len} ${trackLen + 10}`;
    const pt = base.getPointAtLength(len);
    const pt2 = base.getPointAtLength(Math.min(trackLen, len + 2));
    const ang = (Math.atan2(pt2.x - pt.x, -(pt2.y - pt.y)) * 180) / Math.PI;
    const bot = $('botG');
    const bs = prog(lt, 0.4, 0.4, E.back);
    bot.setAttribute('transform', `translate(${pt.x} ${pt.y}) rotate(${p > 0.002 ? ang : 90}) scale(${bs})`);
    bot.style.opacity = bs > 0 ? 1 : 0;
    document.querySelectorAll('#nodes .node').forEach((n) => {
      const f = parseFloat(n.dataset.f);
      const reach = clamp((p - f) / 0.0001 + 1) >= 1 || p >= f;
      const appear = prog(lt, 0.3 + f * 0.25, 0.35, E.back);
      const hit = p >= f ? E.out5(clamp((p - f) / 0.12)) : 0;
      n.querySelector('.dot').setAttribute('transform', `scale(${appear * (1 + 0.35 * Math.sin(Math.PI * Math.min(1, hit * 1.2)))})`);
      n.querySelector('.dot').style.fill = p >= f ? '#c4b5fd' : '#ffffff';
      const ring = n.querySelector('.ring');
      ring.setAttribute('opacity', p >= f ? (1 - hit) * 0.9 : 0);
      ring.setAttribute('transform', `scale(${1 + hit * 1.6})`);
    });
    const tag = $('titleTag');
    const t = prog(lt, 1.1, 0.7, E.out5);
    tag.style.opacity = t;
    tag.style.transform = `translateY(${(1 - t) * 18}px)`;
    tag.style.letterSpacing = `${lerp(0.8, 0.5, t)}em`;
    scenes.title.style.transform = `scale(${1 + 0.03 * clamp(lt / shot.dur)})`;
  }

  function buildGrid() {
    const tiles = window.PROMO.TILES;
    $('tiles').innerHTML = tiles
      .map(
        (t, i) =>
          `<div class="tile"><div class="n">0${i + 1}</div><div class="ico"><svg viewBox="0 0 24 24">${t.icon}</svg></div><h3>${t.title}</h3><p>${t.sub}</p></div>`
      )
      .join('');
  }
  function sceneGrid(lt) {
    $('gridHead').style.opacity = prog(lt, 0.05, 0.4);
    const t = prog(lt, 0.1, 0.6, E.expo);
    $('gridTitle').style.opacity = clamp(t * 2);
    $('gridTitle').style.transform = `skewX(-11deg) translateY(${(1 - t) * 40}px)`;
    document.querySelectorAll('.tile').forEach((el, i) => {
      const e = prog(lt, 0.3 + i * 0.07, 0.6, E.expo);
      el.style.opacity = clamp(e * 1.6);
      el.style.transform = `translateY(${(1 - e) * 60}px) scale(${lerp(0.94, 1, e)})`;
    });
  }

  function sceneEnd(lt) {
    const w = prog(lt, 0.05, 0.9, E.expo);
    const word = $('endWord');
    word.style.clipPath = `inset(-10% ${(1 - w) * 100}% -10% -5%)`;
    word.style.transform = `skewX(-11deg) translateX(${(1 - w) * -80}px)`;
    const l = prog(lt, 0.5, 0.7, E.out5);
    $('endLine').style.opacity = l;
    $('endLine').style.transform = `translateY(${(1 - l) * 24}px)`;
    document.querySelectorAll('#endChips .chip').forEach((c, i) => {
      const e = prog(lt, 0.85 + i * 0.09, 0.55, E.back);
      c.style.opacity = clamp(e * 2);
      c.style.transform = `translateY(${(1 - e) * 28}px) scale(${lerp(0.9, 1, e)})`;
    });
    const by = prog(lt, 1.4, 0.8, E.out5);
    $('endBy').style.opacity = by;
    $('endBy').style.transform = `translateY(${(1 - by) * 14}px)`;
  }

  // ------------------------------------------------------------------ wipes

  function wipes(t) {
    const a = $('wipeA');
    const b = $('wipeB');
    let on = false;
    for (const c of window.PROMO.CUTS) {
      if (t < c - WIPE || t > c + WIPE) continue;
      on = true;
      let L;
      let R;
      let Lb;
      let Rb;
      if (t <= c) {
        const p = E.io5(clamp((t - (c - WIPE)) / WIPE));
        L = -0.25;
        R = lerp(-0.12, 1.25, p);
        Lb = L;
        Rb = R + 0.04;
      } else {
        const p = E.io5(clamp((t - c) / WIPE));
        R = 1.25;
        L = lerp(-0.25, 1.25, p);
        Rb = R;
        Lb = L - 0.04;
      }
      a.style.left = `${L * 1920}px`;
      a.style.width = `${Math.max(0, (R - L) * 1920)}px`;
      b.style.left = `${Lb * 1920}px`;
      b.style.width = `${Math.max(0, (Rb - Lb) * 1920)}px`;
      b.style.background = '#e7e0ff';
    }
    a.style.display = b.style.display = on ? 'block' : 'none';
  }

  // ------------------------------------------------------------------ background

  function background(t) {
    const g1 = document.querySelector('#bg .g1');
    const g2 = document.querySelector('#bg .g2');
    g1.style.transform = `translate(${Math.sin(t * 0.35) * 60}px, ${Math.cos(t * 0.28) * 40}px)`;
    g2.style.transform = `translate(${Math.cos(t * 0.3) * 50}px, ${Math.sin(t * 0.33) * 50}px)`;
  }

  // ------------------------------------------------------------------ public API

  async function ready(shotId) {
    shot = SHOTS.find((s) => s.id === shotId);
    if (!shot) throw new Error('unknown shot ' + shotId);
    shot.dur = shot.t1 - shot.t0;
    buildGrid();
    $('endUrl').textContent = SITE_URL || 'Free in your browser';
    Object.values(scenes).forEach((s) => (s.style.opacity = 0));
    $('appLayer').style.opacity = 0;
    await document.fonts.ready;
    await Promise.all(['Archivo Black', 'Inter', 'Cascadia Mono'].map((f) => document.fonts.load(`40px "${f}"`)));
    if (shot.kind === 'app') {
      const iframe = $('app');
      await new Promise((res) => {
        iframe.onload = res;
        iframe.src = '../index.html' + (shot.query || '');
      });
      const win = iframe.contentWindow;
      await new Promise((res) => {
        const t0 = performance.now();
        (function wait() {
          if (win.document.getElementById('btnRun') && win.__advance && win.document.getElementById('log').children.length) return res();
          if (performance.now() - t0 > 20000) return res();
          setTimeout(wait, 20);
        })();
      });
      A = makeHelper(win);
      await idle();
      if (shot.setup) await shot.setup(A);
      await idle();
      win.__advance(1000);
      await idle();
      win.__advance(1000);
      buildCaption(shot.cap);
      shot.camera.forEach((k) => delete k._r);
      (shot.mouse || []).forEach((m) => delete m._to);
    }
    return { fps: window.PROMO.FPS, t0: shot.t0, t1: shot.t1 };
  }

  /** set up everything for global time t, return where the real mouse should be */
  async function prepare(t) {
    const lt = t - shot.t0;
    background(t);
    wipes(t);
    $('frame').style.opacity = t > TOTAL - 0.45 ? clamp((TOTAL - t) / 0.45) : 1;
    $('cursor').style.opacity = 0;
    $('ripple').style.opacity = 0;
    if (shot.kind !== 'app') {
      $('appLayer').style.opacity = 0;
      $('cap').style.opacity = 0;
      Object.entries(scenes).forEach(([k, el]) => (el.style.opacity = k === shot.kind ? 1 : 0));
      if (shot.kind === 'logo') sceneLogo(lt);
      if (shot.kind === 'title') sceneTitle(lt);
      if (shot.kind === 'grid') sceneGrid(lt);
      if (shot.kind === 'end') sceneEnd(lt);
      return { show: false };
    }
    Object.values(scenes).forEach((s) => (s.style.opacity = 0));
    $('appLayer').style.opacity = 1;

    // scripted app actions (state changes), in order
    while (shot.actions && actionsDone < shot.actions.length && shot.actions[actionsDone].t <= lt) {
      const a = shot.actions[actionsDone++];
      await a.run(A, lt);
    }
    for (const tw of shot.tweens || []) {
      if (lt < tw.t || tw._done) continue;
      const el = typeof tw.el === 'string' ? A.q(tw.el) : tw.el;
      if (!tw._started) {
        tw._started = true;
        if (tw.focus !== false) el.focus();
      }
      const e = (E[tw.ease || 'io'] || E.io)(clamp((lt - tw.t) / tw.dur));
      const v = Math.round(lerp(tw.from, tw.to, e) / (tw.step || 1)) * (tw.step || 1);
      if (String(v) !== el.value) A.set(el, String(v));
      if (!tw._done && lt >= tw.t + tw.dur) {
        tw._done = true;
        if (tw.focus !== false) el.blur();
      }
    }

    if (shot.onFrame) await shot.onFrame(A, lt, E);

    const cam = cameraAt(lt);
    $('cam').style.transform = `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.s})`;
    captionAt(lt);
    lensAt(lt);

    const cur = cursorAt(lt);
    const out = { show: cur.show > 0 && !!cur.p, down: cur.down };
    if (cur.p) {
      const pg = toPage(cam, cur.p);
      out.x = pg.x;
      out.y = pg.y;
      const el = $('cursor');
      el.style.opacity = cur.show;
      const sc = cur.down ? 0.88 : 1;
      el.style.transform = `translate(${pg.x - 5}px, ${pg.y - 3}px) scale(${sc})`;
      el.style.transformOrigin = '5px 3px';
      if (cur.click != null) {
        const q = (lt - cur.click) / 0.55;
        if (q >= 0 && q <= 1) {
          const r = $('ripple');
          r.style.opacity = (1 - q) * 0.9;
          r.style.transform = `translate(${pg.x}px, ${pg.y}px) scale(${0.3 + q * 1.1})`;
        }
      }
    }
    return out;
  }

  /** advance the real app's clock to this frame, wait for any run to finish, repaint */
  async function finish(t) {
    if (shot.kind !== 'app') return;
    const lt = t - shot.t0;
    A.win.__advance(1000 + lt * 1000);
    await idle();
    A.win.__advance(1000 + lt * 1000);
  }

  window.stage = { ready, prepare, finish, app: () => A };
})();
