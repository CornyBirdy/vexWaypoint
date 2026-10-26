/* UI wiring: settings, path files, code box, run + playback. */
(function () {
  'use strict';
  const V = globalThis.VSim;
  const $ = (id) => document.getElementById(id);
  const D2R = Math.PI / 180;

  // ------------------------------------------------------------------ settings

  const DEFAULTS = {
    start: { x: -60, y: -60, h: 0 },
    robot: { wheelDiameter: 3.25, rpm: 450, speedPct: 90, trackWidth: 12, length: 15, width: 15, responseMs: 80 },
    cfg: { horizontalDrift: 2, pathMode: 'field' },
    lateral: { ...V.DEFAULT_LATERAL },
    angular: { ...V.DEFAULT_ANGULAR },
    lang: 'cpp',
    routine: '',
    autonLimit: 15,
    fieldStyle: 'photo-match',
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let S = clone(DEFAULTS);

  const getp = (o, p) => p.split('.').reduce((a, k) => a[k], o);
  const setp = (o, p, v) => {
    const ks = p.split('.');
    const last = ks.pop();
    ks.reduce((a, k) => a[k], o)[last] = v;
  };

  // [key, label, step, min, max]
  const FORMS = {
    formStart: [
      ['start.x', 'X (in)', 0.5, -72, 72],
      ['start.y', 'Y (in)', 0.5, -72, 72],
      ['start.h', 'Heading (&deg;)', 1, -360, 360],
    ],
    formDrive: [
      ['robot.wheelDiameter', 'Wheel diameter (in)', 0.25, 1, 8, [2.75, 3.25, 4]],
      ['robot.rpm', 'Drivetrain RPM (wheel)', 5, 10, 1200],
      ['robot.speedPct', 'Real-life speed (%)', 1, 5, 100],
      ['robot.trackWidth', 'Track width (in)', 0.25, 4, 24],
      ['robot.length', 'Robot length (in)', 0.5, 6, 24],
      ['robot.width', 'Robot width (in)', 0.5, 6, 24],
      ['robot.responseMs', 'Motor response (ms)', 5, 1, 400],
      ['cfg.horizontalDrift', 'Horizontal drift', 0.5, 0, 50],
    ],
    formLat: controllerFields('lateral'),
    formAng: controllerFields('angular'),
  };
  function controllerFields(k) {
    return [
      [k + '.kP', 'kP', 0.1, 0, 1000],
      [k + '.kI', 'kI', 0.01, 0, 1000],
      [k + '.kD', 'kD', 0.1, 0, 1000],
      [k + '.antiWindup', 'Anti windup', 0.5, 0, 1000],
      [k + '.smallError', 'Small error', 0.1, 0, 1000],
      [k + '.smallErrorTimeout', 'Small error timeout (ms)', 10, 0, 100000],
      [k + '.largeError', 'Large error', 0.1, 0, 1000],
      [k + '.largeErrorTimeout', 'Large error timeout (ms)', 10, 0, 100000],
      [k + '.slew', 'Slew', 1, 0, 127],
    ];
  }

  const PATH_MODES = [
    ['field', 'Field (as drawn)'],
    ['relative', 'Start at robot'],
    ['code', 'Code frame'],
  ];
  const PATH_MODE_NOTES = {
    field: 'File coordinates are jerry.io field coordinates (origin at field centre). They are converted into the code frame, so the start pose can be anywhere.',
    relative: 'Path keeps its shape and direction but is moved so its first point is on the robot when <code>follow()</code> starts.',
    code: 'File numbers are used as-is in the code frame. Path point (0, 0) is the start pose.',
  };

  function buildForms() {
    Object.keys(FORMS).forEach((formId) => {
      const host = $(formId);
      host.innerHTML = '';
      FORMS[formId].forEach(([key, label, step, min, max, list]) => {
        const wrap = document.createElement('label');
        wrap.className = 'field';
        const span = document.createElement('span');
        span.innerHTML = label;
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = step;
        inp.min = min;
        inp.max = max;
        inp.dataset.key = key;
        inp.inputMode = 'decimal';
        if (list) {
          const dl = document.createElement('datalist');
          dl.id = 'dl-' + key.replace('.', '-');
          list.forEach((v) => dl.appendChild(new Option(v)));
          inp.setAttribute('list', dl.id);
          wrap.appendChild(dl);
        }
        inp.addEventListener('input', () => {
          const n = parseFloat(inp.value);
          if (!isFinite(n)) return;
          setp(S, key, n);
          settingsChanged();
        });
        wrap.append(span, inp);
        host.appendChild(wrap);
      });
    });
    PATH_MODES.forEach(([v, t]) => $('pathMode').appendChild(new Option(t, v)));
  }

  function pushSettingsToUi() {
    document.querySelectorAll('input[data-key]').forEach((inp) => {
      inp.value = getp(S, inp.dataset.key);
    });
    $('pathMode').value = S.cfg.pathMode;
    $('pathModeNote').innerHTML = PATH_MODE_NOTES[S.cfg.pathMode];
    $('lang').value = S.lang;
    $('autonLimit').value = String(S.autonLimit);
    $('fieldStyle').value = S.fieldStyle;
    updateTopSpeed();
  }

  function updateTopSpeed() {
    const r = S.robot;
    const v = ((r.rpm / 60) * Math.PI * r.wheelDiameter * r.speedPct) / 100;
    $('topSpeed').textContent = `max ${v.toFixed(1)} in/s`;
  }

  // ------------------------------------------------------------------ persistence

  const KEY = 'vexAutonSim.v1';
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ S, code: $('code').value, files: pathFiles, project: V.PathTool.serialize() }));
    } catch (e) {
      /* storage unavailable: the sim still works */
    }
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ path files

  const PATH_COLORS = ['#ffd166', '#ef7bff', '#7bd3ff', '#9be564', '#ff9b6b', '#c3a6ff'];
  let pathFiles = []; // [{name, text}] raw files, kept so they survive a reload
  let paths = []; // parsed {id, aliases, name, source, unit, approximate, points, visible, color, unitOverride}

  function rebuildPaths(warnOut) {
    const old = new Map(paths.map((p) => [p.id, p]));
    paths = [];
    pathFiles.forEach((f) => {
      const res = V.parsePathFile(f.name, f.text != null ? f.text : b64ToBytes(f.b64));
      (warnOut || []).push(...res.warnings);
      res.paths.forEach((p) => {
        const prev = old.get(p.id);
        p.visible = prev ? prev.visible : true;
        p.unitOverride = prev ? prev.unitOverride : null;
        p.color = PATH_COLORS[paths.length % PATH_COLORS.length];
        paths.push(p);
      });
    });
    renderPathList();
  }

  function renderPathList() {
    const ul = $('pathList');
    ul.innerHTML = '';
    paths.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'path';
      const len = pathLength(p);
      li.innerHTML = `
        <span class="sw" style="background:${p.color}"></span>
        <span class="nm"><b title="${esc(p.name)}">${esc(p.name)}</b>
          <button class="id" type="button" title="Click to copy the name to use in chassis.follow()">${esc(p.id)}</button>
          <span class="meta">${p.points.length} pts &middot; ${len.toFixed(0)} in${p.recomputed ? ' &middot; recomputed from controls' : ''}</span></span>
        <select title="Units used in the file" aria-label="Units in ${esc(p.name)}">
          ${['in', 'cm', 'mm', 'm'].map((u) => `<option value="${u}"${(p.unitOverride || p.unit) === u ? ' selected' : ''}>${u}</option>`).join('')}
        </select>
        <input type="checkbox" ${p.visible ? 'checked' : ''} title="Show on field" aria-label="Show ${esc(p.name)} on the field">
        <button class="x" type="button" title="Remove" aria-label="Remove ${esc(p.name)}">&times;</button>`;
      li.querySelector('.id').addEventListener('click', () => {
        if (navigator.clipboard) navigator.clipboard.writeText(p.id).catch(() => {});
        $('cursor').textContent = `chassis.follow(${p.id}, 15, 4000);`;
      });
      li.querySelector('select').addEventListener('change', (e) => {
        p.unitOverride = e.target.value;
        renderPathList();
        settingsChanged();
      });
      li.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
        p.visible = e.target.checked;
        requestDraw();
      });
      li.querySelector('.x').addEventListener('click', () => {
        pathFiles = pathFiles.filter((f) => f.name !== p.file);
        rebuildPaths();
        settingsChanged();
      });
      ul.appendChild(li);
    });
  }

  function pathLength(p) {
    const pts = V.pointsInInches(p, p.unitOverride).slice(0, p.endIdx + 1);
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return d;
  }

  async function addFiles(fileList) {
    const warn = [];
    for (const f of fileList) {
      if (f.size > 5e6) {
        warn.push(`${f.name}: file is larger than 5 MB, skipped`);
        continue;
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const binary = bytes.subarray(0, 256).includes(0);
      const res = V.parsePathFile(f.name, binary ? bytes : new TextDecoder().decode(bytes));
      warn.push(...res.warnings);
      if (importEditable(res, f.name)) continue;
      pathFiles = pathFiles.filter((x) => x.name !== f.name);
      // binary files (LemLib v1.0) are kept as base64 so they survive a reload
      if (binary) pathFiles.push({ name: f.name, b64: bytesToB64(bytes) });
      else pathFiles.push({ name: f.name, text: new TextDecoder().decode(bytes) });
    }
    rebuildPaths(warn);
    warn.forEach((w) => addLog('warn', w));
    settingsChanged();
  }

  /** files that carry the full jerry.io project open in the path editor */
  function importEditable(res, fileName) {
    const json = res.json;
    if (!json || !Array.isArray(json.paths) || !json.paths.some((p) => p && Array.isArray(p.segments) && p.segments.length)) return false;
    const added = V.PathTool.importJson(json, fileName);
    if (!added.length) return false;
    addLog('info', `${fileName}: ${added.length} editable path${added.length > 1 ? 's' : ''} (${added.map((p) => V.PathTool.idOf(p)).join(', ')})`);
    return true;
  }

  function loadExamplePath() {
    const res = V.parsePathFile(V.EXAMPLES.pathName, V.EXAMPLES.pathText);
    importEditable(res, V.EXAMPLES.pathName);
  }

  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ------------------------------------------------------------------ running

  let result = null;
  let running = false;
  let runAgain = false;
  let renderer;
  let simMs = 0;
  let playing = false;
  let lastTs = 0;
  let drawQueued = false;
  let trail = [];
  let compiled = null;

  function currentCompiled() {
    compiled = V.compileAuton($('code').value, { language: S.lang, routine: S.routine });
    const wrap = $('routineWrap');
    const sel = $('routine');
    sel.innerHTML = '';
    compiled.routines.forEach((r) => sel.appendChild(new Option(r + '()', r)));
    if (compiled.routine) sel.value = compiled.routine;
    wrap.hidden = compiled.routines.length < 2 || S.lang === 'js';
    return compiled;
  }

  async function runNow(opts) {
    opts = opts || {};
    if (running) {
      runAgain = true;
      return;
    }
    running = true;
    $('btnRun').classList.add('busy');
    try {
      const c = currentCompiled();
      const logLines = [];
      c.warnings.forEach((w) => logLines.push(['warn', w]));
      const editorIds = V.PathTool.ids();
      const missing = c.config.assets.filter((a) => !paths.some((p) => p.id === a || p.aliases.includes(a)) && !editorIds.includes(a));
      missing.forEach((a) => logLines.push(['warn', `ASSET(${a}): no matching path file loaded`]));

      const res = await V.runSimulation({
        js: c.js,
        robot: S.robot,
        start: S.start,
        cfg: { lateral: S.lateral, angular: S.angular, trackWidth: S.robot.trackWidth, horizontalDrift: S.cfg.horizontalDrift, pathMode: S.cfg.pathMode },
        paths: paths.map((p) => ({
          ids: [p.id, ...p.aliases],
          name: p.id,
          points: V.pointsInInches(p, p.unitOverride),
          speedUnit: p.speedUnit,
          ghost: p.ghost,
          endIdx: p.endIdx,
        })).concat(V.PathTool.runPaths()),
        chassisNames: ['chassis', c.config.chassisName],
        maxMs: 120000,
      });
      result = res;
      trail = [];
      if (res.frames) {
        const f = res.frames;
        for (let i = 0; i < f.t.length; i++) trail.push({ x: f.x[i], y: f.y[i] });
      }
      renderLog(logLines, res);
      const scrub = $('scrub');
      scrub.max = String(res.durationMs);
      simMs = 0;
      playing = !!opts.autoplay && !!res.frames && res.durationMs > 0;
      lastTs = 0;
      updateLimitBadge();
      syncPlayButton();
      requestDraw();
      save();
    } finally {
      running = false;
      $('btnRun').classList.remove('busy');
      if (runAgain) {
        runAgain = false;
        runNow({ autoplay: false });
      }
    }
  }

  let debounce = 0;
  function settingsChanged() {
    updateTopSpeed();
    save();
    requestDraw();
    if (!$('autoRun').checked) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => runNow({ autoplay: false }), 220);
  }

  // ------------------------------------------------------------------ log

  function addLog(kind, text, t, seekMs) {
    const div = document.createElement('div');
    div.className = kind;
    const stamp = t == null ? '' : `<span class="t">${(t / 1000).toFixed(2)}s</span>`;
    div.innerHTML = stamp + esc(text);
    if (seekMs != null) {
      div.classList.add('motion');
      div.dataset.t0 = seekMs;
      div.title = 'Click to jump here';
      div.addEventListener('click', () => {
        simMs = seekMs;
        playing = false;
        syncPlayButton();
        requestDraw();
      });
    }
    $('log').appendChild(div);
    return div;
  }

  function renderLog(pre, res) {
    $('log').innerHTML = '';
    pre.forEach(([k, t]) => addLog(k, t));
    res.events.forEach((e) => {
      if (e.kind === 'motion') addLog('motion', e.text, e.t, e.t);
      else addLog(e.kind, e.text, e.t);
    });
  }

  function updateLimitBadge() {
    const b = $('tLimit');
    if (!result || !result.frames) {
      b.textContent = '';
      b.className = 'lim';
      return;
    }
    const limit = S.autonLimit * 1000;
    const diff = (limit - result.durationMs) / 1000;
    if (diff >= 0) {
      b.textContent = `${diff.toFixed(1)} s spare`;
      b.className = 'lim ok';
    } else {
      b.textContent = `${(-diff).toFixed(1)} s over the ${S.autonLimit} s limit`;
      b.className = 'lim over';
    }
  }

  // ------------------------------------------------------------------ drawing / playback

  function startFrame() {
    const psi = S.start.h * D2R;
    return { px: S.start.x, py: S.start.y, psi };
  }
  function codeToField(x, y) {
    const f = startFrame();
    const c = Math.cos(f.psi);
    const s = Math.sin(f.psi);
    return { x: f.px + x * c + y * s, y: f.py - x * s + y * c };
  }
  function fieldToCode(x, y) {
    const f = startFrame();
    const c = Math.cos(f.psi);
    const s = Math.sin(f.psi);
    const vx = x - f.px;
    const vy = y - f.py;
    return { x: vx * c - vy * s, y: vx * s + vy * c };
  }

  function previewPaths() {
    return paths.map((p) => {
      const pts = V.pointsInInches(p, p.unitOverride).slice(0, p.endIdx + 1);
      let out = pts;
      if (S.cfg.pathMode === 'code') out = pts.map((q) => codeToField(q.x, q.y));
      else if (S.cfg.pathMode === 'relative') {
        const dx = S.start.x - pts[0].x;
        const dy = S.start.y - pts[0].y;
        out = pts.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      }
      return { visible: p.visible, color: p.color, points: out };
    });
  }

  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(frame);
  }

  function syncPlayButton() {
    $('btnPlay').textContent = playing ? 'Pause' : 'Play';
  }

  let lastActiveMotion = -2;

  function frame(ts) {
    drawQueued = false;
    if (playing && result && result.frames) {
      if (lastTs) simMs += (ts - lastTs) * parseFloat($('speed').value);
      lastTs = ts;
      if (simMs >= result.durationMs) {
        simMs = result.durationMs;
        playing = false;
        syncPlayButton();
      }
    } else lastTs = 0;

    const f = result && result.frames;
    const idx = f ? Math.min(f.t.length - 1, Math.max(0, Math.round(simMs / 10))) : 0;
    const dims = { length: S.robot.length, width: S.robot.width };
    const state = {
      robot: dims,
      ghost: { x: S.start.x, y: S.start.y, h: S.start.h },
      ghostHandle: true,
      paths: $('optPaths').checked ? previewPaths() : null,
      edit: $('optPaths').checked || V.PathTool.tool() === 'edit' ? V.PathTool.drawState() : null,
      codeAxes: $('optAxes').checked ? { x: S.start.x, y: S.start.y, h: S.start.h } : null,
    };
    if (f) {
      state.pose = { x: f.x[idx], y: f.y[idx], h: f.h[idx] };
      state.hit = !!f.hit[idx];
      if ($('optTrail').checked) state.trail = trail.slice(0, idx + 1);
      const mi = f.mi[idx];
      if (mi >= 0 && result.motions[mi] && result.motions[mi].follow) state.followPath = result.motions[mi].follow;
      if ($('optAim').checked && isFinite(f.ax[idx])) state.aim = { x: f.ax[idx], y: f.ay[idx] };
      updateHud(f, idx, mi);
    } else {
      state.pose = { x: S.start.x, y: S.start.y, h: S.start.h };
      updateHud(null, 0, -1);
    }
    renderer.draw(state);

    $('scrub').value = String(Math.round(simMs));
    if (playing) requestDraw();
  }

  function updateHud(f, idx, mi) {
    if (!f) {
      $('tTime').textContent = '0.00';
      $('tField').textContent = `${S.start.x.toFixed(1)}, ${S.start.y.toFixed(1)}  ${S.start.h.toFixed(0)}°`;
      $('tCode').textContent = '0.0, 0.0  0°';
      $('tSpeed').textContent = '-';
      $('tMotion').textContent = '-';
      return;
    }
    $('tTime').textContent = (f.t[idx] / 1000).toFixed(2);
    $('tField').textContent = `${f.x[idx].toFixed(1)}, ${f.y[idx].toFixed(1)}  ${norm360(f.h[idx]).toFixed(0)}°`;
    $('tCode').textContent = `${f.cx[idx].toFixed(1)}, ${f.cy[idx].toFixed(1)}  ${f.ct[idx].toFixed(0)}°`;
    const v = (f.vl[idx] + f.vr[idx]) / 2;
    $('tSpeed').textContent = `${v.toFixed(1)} in/s  (L ${f.vl[idx].toFixed(0)}, R ${f.vr[idx].toFixed(0)})`;
    const m = mi >= 0 ? result.motions[mi] : null;
    $('tMotion').textContent = m ? m.label : '-';
    if (mi !== lastActiveMotion) {
      lastActiveMotion = mi;
      document.querySelectorAll('#log .motion').forEach((d) => {
        const t0 = +d.dataset.t0;
        d.classList.toggle('active', !!m && t0 === m.t0 && d.textContent.endsWith(m.label));
      });
    }
  }
  const norm360 = (d) => ((d % 360) + 360) % 360;

  // ------------------------------------------------------------------ pointer interaction

  function bindCanvas() {
    const cv = $('field');
    let drag = null;

    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return renderer.toWorld(((e.clientX - r.left) / r.width) * renderer.w, ((e.clientY - r.top) / r.height) * renderer.h);
    };
    const hitRobot = (w) => {
      const dx = w.x - S.start.x;
      const dy = w.y - S.start.y;
      const h = S.start.h * D2R;
      // into robot-local coords (right, forward)
      const lx = dx * Math.cos(h) - dy * Math.sin(h);
      const ly = dx * Math.sin(h) + dy * Math.cos(h);
      return { lx, ly, inside: Math.abs(lx) <= S.robot.width / 2 + 1 && Math.abs(ly) <= S.robot.length / 2 + 1 };
    };
    const handleHit = (w) => {
      const h = hitRobot(w);
      const hr = 14 / renderer.scale;
      return Math.hypot(h.lx, h.ly - (S.robot.length / 2 + hr)) < 9 / renderer.scale + 2;
    };

    const clientXY = (e) => ({ x: e.clientX, y: e.clientY });

    cv.addEventListener('pointerdown', (e) => {
      const w = pos(e);
      if (V.PathTool.tool() === 'edit') {
        if (V.PathTool.pointerDown(w, e, clientXY(e))) {
          cv.setPointerCapture(e.pointerId);
          e.preventDefault();
        }
        return;
      }
      if (handleHit(w)) drag = { mode: 'rotate' };
      else {
        const h = hitRobot(w);
        if (h.inside) drag = { mode: 'move', ox: w.x - S.start.x, oy: w.y - S.start.y };
      }
      if (drag) {
        cv.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });
    cv.addEventListener('pointermove', (e) => {
      const w = pos(e);
      const editing = V.PathTool.tool() === 'edit';
      if (editing) V.PathTool.pointerMove(w, e, clientXY(e));
      else if (drag) {
        if (drag.mode === 'move') {
          const lim = 72 - Math.max(S.robot.length, S.robot.width) / 2;
          S.start.x = Math.round(Math.min(lim, Math.max(-lim, w.x - drag.ox)) * 2) / 2;
          S.start.y = Math.round(Math.min(lim, Math.max(-lim, w.y - drag.oy)) * 2) / 2;
        } else {
          let deg = (Math.atan2(w.x - S.start.x, w.y - S.start.y) * 180) / Math.PI;
          deg = e.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg);
          S.start.h = deg;
        }
        pushSettingsToUi();
        settingsChanged();
      }
      const inField = Math.abs(w.x) <= 72 && Math.abs(w.y) <= 72;
      if (inField) {
        const c = fieldToCode(w.x, w.y);
        $('cursor').textContent = `field ${w.x.toFixed(1)}, ${w.y.toFixed(1)}   code ${c.x.toFixed(1)}, ${c.y.toFixed(1)}`;
      }
      cv.style.cursor = editing ? V.PathTool.cursor(w) : drag ? 'grabbing' : handleHit(w) ? 'grab' : hitRobot(w).inside ? 'move' : 'crosshair';
    });
    const end = (e) => {
      if (V.PathTool.tool() === 'edit') V.PathTool.pointerUp(pos(e), e, clientXY(e));
      if (drag) drag = null;
      try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', (e) => {
      drag = null;
      try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    });
  }

  // ------------------------------------------------------------------ import from code

  function importFromCode() {
    const c = currentCompiled();
    const notes = [];
    const dt = c.config.drivetrain;
    if (dt) {
      if (dt.wheelDiameter) { S.robot.wheelDiameter = dt.wheelDiameter; notes.push(`wheel ${dt.wheelDiameter} in`); }
      if (dt.rpm) { S.robot.rpm = dt.rpm; notes.push(`${dt.rpm} rpm`); }
      if (dt.trackWidth) { S.robot.trackWidth = dt.trackWidth; notes.push(`track ${dt.trackWidth} in`); }
      if (dt.horizontalDrift != null) { S.cfg.horizontalDrift = dt.horizontalDrift; notes.push(`drift ${dt.horizontalDrift}`); }
    }
    ['lateral', 'angular'].forEach((k) => {
      const src = c.config[k];
      if (!src) return;
      Object.keys(src).forEach((p) => {
        if (src[p] != null && isFinite(src[p])) S[k][p] = src[p];
      });
      notes.push(`${k} gains`);
    });
    if (!notes.length) {
      addLog('warn', 'Nothing to import: no lemlib::Drivetrain or lemlib::ControllerSettings found in the code.');
      return;
    }
    addLog('info', 'Imported: ' + notes.join(', '));
    pushSettingsToUi();
    settingsChanged();
  }

  // ------------------------------------------------------------------ init

  function init() {
    buildForms();
    renderer = new V.Renderer($('field'));

    const saved = load();
    if (saved && saved.S) {
      S = merge(clone(DEFAULTS), saved.S);
      pathFiles = Array.isArray(saved.files) ? saved.files : [];
      $('code').value = typeof saved.code === 'string' ? saved.code : V.EXAMPLES.code;
    } else {
      $('code').value = V.EXAMPLES.code;
      pathFiles = [];
    }
    V.PathTool.init({
      $,
      renderer: () => renderer,
      requestDraw,
      changed: () => settingsChanged(),
      getStart: () => S.start,
      log: addLog,
      topSpeedMps: () => ((S.robot.rpm / 60) * Math.PI * S.robot.wheelDiameter * (S.robot.speedPct / 100)) / 39.3701,
    });
    if (saved && saved.project) V.PathTool.load(saved.project);
    else if (!saved) loadExamplePath();
    renderer.onImageLoad = requestDraw;
    renderer.setFieldStyle(S.fieldStyle);
    rebuildPaths();
    pushSettingsToUi();

    $('btnRun').addEventListener('click', () => runNow({ autoplay: true }));
    $('btnExample').addEventListener('click', () => {
      $('code').value = V.EXAMPLES.code;
      pathFiles = [];
      V.PathTool.clear();
      loadExamplePath();
      S.start = clone(DEFAULTS.start);
      rebuildPaths();
      pushSettingsToUi();
      runNow({ autoplay: true });
    });
    $('btnReset').addEventListener('click', () => {
      const keep = { lang: S.lang };
      S = merge(clone(DEFAULTS), keep);
      pushSettingsToUi();
      settingsChanged();
    });
    $('btnImport').addEventListener('click', importFromCode);

    $('code').addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const t = e.target;
        const a = t.selectionStart;
        t.value = t.value.slice(0, a) + '    ' + t.value.slice(t.selectionEnd);
        t.selectionStart = t.selectionEnd = a + 4;
      }
    });
    $('code').addEventListener('input', () => save());
    $('lang').addEventListener('change', (e) => {
      S.lang = e.target.value;
      save();
    });
    $('routine').addEventListener('change', (e) => {
      S.routine = e.target.value;
      runNow({ autoplay: true });
    });
    $('fieldStyle').addEventListener('change', (e) => {
      S.fieldStyle = e.target.value;
      renderer.setFieldStyle(S.fieldStyle);
      save();
      requestDraw();
    });
    $('autonLimit').addEventListener('change', (e) => {
      S.autonLimit = parseInt(e.target.value, 10);
      updateLimitBadge();
      save();
    });
    $('pathMode').addEventListener('change', (e) => {
      S.cfg.pathMode = e.target.value;
      $('pathModeNote').innerHTML = PATH_MODE_NOTES[S.cfg.pathMode];
      settingsChanged();
    });

    // files: browse + drag and drop anywhere on the page
    $('btnBrowse').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      addFiles(Array.from(e.target.files));
      e.target.value = '';
    });
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
        dragDepth++;
        document.body.classList.add('dragging');
      }
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) document.body.classList.remove('dragging');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('dragging');
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(Array.from(e.dataTransfer.files));
    });

    // transport
    $('btnPlay').addEventListener('click', togglePlay);
    $('btnRestart').addEventListener('click', () => {
      simMs = 0;
      playing = !!(result && result.frames);
      syncPlayButton();
      requestDraw();
    });
    $('scrub').addEventListener('input', (e) => {
      simMs = parseFloat(e.target.value);
      playing = false;
      syncPlayButton();
      requestDraw();
    });
    $('speed').addEventListener('change', requestDraw);
    ['optTrail', 'optPaths', 'optAxes', 'optAim'].forEach((id) => $(id).addEventListener('change', requestDraw));

    window.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (!typing && V.PathTool.key(e)) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runNow({ autoplay: true });
      } else if (!typing && e.key === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (!typing && e.key === 'Home') {
        $('btnRestart').click();
      } else if (!typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        simMs = Math.max(0, Math.min(result ? result.durationMs : 0, simMs + (e.key === 'ArrowRight' ? 100 : -100)));
        playing = false;
        syncPlayButton();
        requestDraw();
      }
    });

    const ro = new ResizeObserver(() => {
      renderer.resize();
      requestDraw();
    });
    ro.observe($('field'));

    bindCanvas();
    runNow({ autoplay: true });
  }

  function togglePlay() {
    if (!result || !result.frames) return;
    if (!playing && simMs >= result.durationMs) simMs = 0;
    playing = !playing;
    lastTs = 0;
    syncPlayButton();
    requestDraw();
  }

  function merge(base, over) {
    Object.keys(over || {}).forEach((k) => {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') merge(base[k], over[k]);
      else base[k] = over[k];
    });
    return base;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
