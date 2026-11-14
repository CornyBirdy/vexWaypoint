/* UI wiring: settings, path files, code box, run + playback. */
(function () {
  'use strict';
  const V = globalThis.VSim;
  const $ = (id) => document.getElementById(id);
  const D2R = Math.PI / 180;

  // ------------------------------------------------------------------ settings

  const DEFAULTS = {
    start: { x: -58, y: 0, h: 90 },
    robot: { wheelDiameter: 3.25, rpm: 450, speedPct: 90, trackWidth: 12, length: 15, width: 15, responseMs: 80, motor: JSON.parse(JSON.stringify(V.DEFAULT_MOTOR)) },
    cfg: { horizontalDrift: 2, pathMode: 'field', mechanismWait: 0, startFromCode: true, solidGoals: false },
    aligners: JSON.parse(JSON.stringify(V.DEFAULT_ALIGNERS)),
    goals: { ...V.GOAL_DEFAULTS },
    chassis: JSON.parse(JSON.stringify(V.DEFAULT_CHASSIS)),
    lateral: { ...V.DEFAULT_LATERAL },
    angular: { ...V.DEFAULT_ANGULAR },
    lang: 'cpp',
    routine: '',
    autonLimit: 15,
    fieldStyle: 'photo-match',
    defaultsV: 2, // 2: real-life error, aligners and solid goals start off
    preview: 'path', // what the field runs: 'path' (the selected path, generated code) or 'code' (your autonomous())
    follow: { lookahead: 15, timeout: 4000, backwards: false },
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
      ['cfg.mechanismWait', 'Lift / claw wait (ms, 0 = none)', 50, 0, 5000],
    ],
    formMotor: [
      ['robot.motor.n11', '11 W motors per side', 1, 0, 8],
      ['robot.motor.n55', '5.5 W motors per side', 1, 0, 8],
      ['robot.motor.weight', 'Robot weight', 0.1, 0.5, 60],
    ],
    formMotorCur: [
      ['robot.motor.cur11.stallA', '11 W: stall current (A)', 0.1, 0.2, 30],
      ['robot.motor.cur11.freeA', '11 W: free current (A)', 0.01, 0, 5],
      ['robot.motor.cur11.limitA', '11 W: current limit (A)', 0.1, 0.2, 30],
      ['robot.motor.cur55.stallA', '5.5 W: stall current (A)', 0.1, 0.2, 30],
      ['robot.motor.cur55.freeA', '5.5 W: free current (A)', 0.01, 0, 5],
      ['robot.motor.cur55.limitA', '5.5 W: current limit (A)', 0.1, 0.2, 30],
    ],
    formGoals: [
      ['goals.tall', 'Tall goal (centre)', 0.1, 2, 12],
      ['goals.short', 'Short neutral goals', 0.1, 2, 12],
      ['goals.alliance', 'Alliance goals', 0.1, 2, 12],
      ['goals.chamfer', 'Corner cut-off', 0.1, 0, 3],
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
    updateSolidUi();
    $('startFromCode').checked = !!S.cfg.startFromCode;
    $('solidGoals').checked = !!S.cfg.solidGoals;
    renderAlignSummary();
    updateMotorUi();
    renderChassisUi();
    $('lang').value = S.lang;
    $('autonLimit').value = String(S.autonLimit);
    $('fieldStyle').value = S.fieldStyle;
    $('fLook').value = S.follow.lookahead;
    $('fTimeout').value = S.follow.timeout;
    $('fBack').checked = !!S.follow.backwards;
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
        p.color = V.theme.series(paths.length);
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
      if (!binary) {
        // pose logs from the robot (Real runs tab) are not path files
        const text = new TextDecoder().decode(bytes);
        if (V.Tune.isPoseLog(text)) {
          V.Tune.addText(text, f.name);
          showTab('real');
          continue;
        }
      }
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

  // ------------------------------------------------------------------ path preview + code for the robot

  const pathPreview = () => S.preview === 'path';

  /** the selected path with the code generated for it, or null when there is nothing to run */
  function previewRun() {
    const info = V.PathTool.info();
    if (!info || !info.path.segments.length) return null;
    const f = S.follow;
    const opts = { lookahead: f.lookahead, timeout: f.timeout, backwards: f.backwards };
    const pose = V.Editor.startPose(info.path, f.backwards);
    return { info, pose, opts, code: V.CodeGen.autonomous(pose, info.assetId, info.fileName, opts) };
  }

  /** where the robot stands: the path's start while previewing a path, else the start pose box (null: no robot yet) */
  function activeStart() {
    if (!pathPreview()) return S.start;
    const info = V.PathTool.info();
    const pose = info && V.Editor.startPose(info.path, S.follow.backwards);
    if (pose) return pose;
    const pend = V.PathTool.pendingStart();
    return pend ? { x: pend.x, y: pend.y, h: 0 } : null;
  }

  function updateExport() {
    const pv = previewRun();
    const code = $('genCode');
    const info = $('genInfo');
    ['btnDownloadPath', 'btnCopyCode', 'btnInsert', 'btnStartAtPath'].forEach((id) => ($(id).disabled = !pv));
    if (!pv) {
      code.value = '// Draw a path on the field and its LemLib code appears here.';
      $('btnDownloadPath').textContent = 'Download path';
      info.textContent = '';
      return;
    }
    code.value = pv.code.replace(/\n+$/, '');
    $('btnDownloadPath').textContent = `Download ${pv.info.fileName}`;
    const m = pathPreview() && result && result.motions && result.motions[0];
    if (m && m.follow && m.t1 != null) {
      const sec = (m.t1 - m.t0) / 1000;
      info.className = 'note status ' + (m.reason === 'timeout' ? 'bad' : 'good');
      info.textContent =
        m.reason === 'timeout'
          ? `Timed out after ${S.follow.timeout} ms before reaching the end. Raise the timeout.`
          : `Takes ${sec.toFixed(1)} s in the sim (timeout ${(S.follow.timeout / 1000).toFixed(1)} s).`;
    } else {
      info.className = 'note status';
      info.textContent = '';
    }
  }

  function flash(btn, text) {
    const old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.textContent = text;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      btn.textContent = old;
      delete btn.dataset.label;
      updateExport();
    }, 1400);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = $('genCode');
      ta.focus();
      ta.select();
      try {
        return document.execCommand('copy');
      } catch (err) {
        return false;
      }
    }
  }

  function setPreview(mode, opts) {
    S.preview = mode;
    const path = mode === 'path';
    $('pvPath').classList.toggle('on', path);
    $('pvCode').classList.toggle('on', !path);
    $('pvPath').setAttribute('aria-pressed', String(path));
    $('pvCode').setAttribute('aria-pressed', String(!path));
    $('secStart').hidden = path;
    $('secCode').hidden = path;
    $('toolPose').hidden = path;
    document.body.dataset.preview = mode;
    if (path) {
      V.PathTool.setTool('edit');
      // the path's own panels live on the Paths tab
      const tab = document.querySelector('#tabs .tab[data-tab="paths"]');
      if (tab && !(opts && opts.quiet)) tab.click();
    }
    save();
    requestDraw();
    if (!opts || !opts.quiet) runNow({ autoplay: true });
  }

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
  let runs = []; // run history: {n, at, seed, text}
  let runCounter = 0;
  let goalCache = { key: '', goals: [] };
  let runSeed = null; // the random draw of the current run (see runNow)
  let chassisView = null;
  let codeStart = null; // {x, y, h} when the code's own setPose() placed the robot on the last run
  const round2 = (v) => Math.round(v * 100) / 100;

  function currentCompiled() {
    compiled = V.compileAuton($('code').value, { language: S.lang, routine: S.routine });
    return syncRoutines(compiled);
  }
  function syncRoutines(compiled) {
    const wrap = $('routineWrap');
    const sel = $('routine');
    sel.innerHTML = '';
    compiled.routines.forEach((r) => sel.appendChild(new Option(r + '()', r)));
    if (compiled.routine) sel.value = compiled.routine;
    wrap.hidden = compiled.routines.length < 2 || S.lang === 'js';
    return compiled;
  }

  /** everything a run needs besides the code, from the current settings */
  function runOptions(c, seed, pv) {
    return {
      robot: S.robot,
      // path preview: the robot stands on the path's start and the generated setPose() must not move the start pose box
      start: pv ? pv.pose : S.start,
      // real-life error was removed: always a perfect robot (the chassis still sets up the motor model)
      realism: { enabled: false, seed, chassis: S.chassis },
      world: worldOn() ? { goals: S.goals, aligners: S.aligners } : null,
      startFromSetPose: pv ? false : S.cfg.startFromCode,
      cfg: { lateral: S.lateral, angular: S.angular, trackWidth: S.robot.trackWidth, horizontalDrift: S.cfg.horizontalDrift, pathMode: pv ? 'field' : S.cfg.pathMode },
      paths: paths.map((p) => ({
        ids: [p.id, ...p.aliases],
        name: p.id,
        points: V.pointsInInches(p, p.unitOverride),
        speedUnit: p.speedUnit,
        ghost: p.ghost,
        endIdx: p.endIdx,
      })).concat(V.PathTool.runPaths()),
      chassisNames: ['chassis', c.config.chassisName],
      motorGroups: c.config.motorGroups || null,
      motors: c.config.motors,
      rw: c.config.rw,
      mechanismWaitMs: S.cfg.mechanismWait,
      maxMs: 120000,
    };
  }

  async function runNow(opts) {
    opts = opts || {};
    if (running) {
      runAgain = true;
      return;
    }
    running = true;
    // pressing Run (or Ctrl+Enter) gives the robot a new random draw; re-runs after a settings change keep it
    if (opts.seed != null) runSeed = opts.seed;
    else if (opts.autoplay || runSeed == null) runSeed = 1 + Math.floor(Math.random() * 999999);
    $('btnRun').classList.add('busy');
    try {
      const pv = pathPreview() ? previewRun() : null;
      if (pathPreview() && !pv) {
        // nothing to run yet
        result = null;
        trail = [];
        $('log').innerHTML = '';
        addLog('info', 'Draw a path: click the field where it should start, then where it should go. It runs here as you draw.');
        updateScrubMax();
        simMs = 0;
        playing = false;
        syncPlayButton();
        updateLimitBadge();
        updateExport();
        requestDraw();
        return;
      }
      const c = pv ? V.compileAuton(pv.code, { language: 'cpp' }) : currentCompiled();
      const logLines = [];
      if (pv) logLines.push(['info', `Previewing ${pv.info.assetId}: the generated code from "Use on the robot"`]);
      c.warnings.forEach((w) => logLines.push(['warn', w]));
      if (!pv && S.lang === 'cpp' && c.routine) logLines.push(['info', `Running ${c.routine}()` + (c.ignored.length ? `  (ignored: ${c.ignored.join(', ')})` : '')]);
      if (!pv && S.lang === 'cpp' && c.config.templates && c.config.templates.length) logLines.push(['info', 'Code style: ' + c.config.templates.join(', ')]);
      const editorIds = V.PathTool.ids();
      const missing = c.config.assets.filter((a) => !paths.some((p) => p.id === a || p.aliases.includes(a)) && !editorIds.includes(a));
      missing.forEach((a) => logLines.push(['warn', `ASSET(${a}): no matching path file loaded`]));

      const res = await V.runSimulation({ js: c.js, ...runOptions(c, runSeed, pv) });
      result = res;
      // a setPose() at the start of the code decides where the robot starts: show it in the panel
      codeStart = pv ? null : res.startFromCode;
      if (codeStart) {
        S.start = { x: round2(codeStart.x), y: round2(codeStart.y), h: round2(codeStart.h) };
        pushSettingsToUi();
      }
      $('startNote').hidden = !codeStart;
      trail = [];
      if (res.frames) {
        const f = res.frames;
        for (let i = 0; i < f.t.length; i++) trail.push({ x: f.x[i], y: f.y[i] });
      }
      renderLog(logLines, res);
      recordRun(res, !!(opts.autoplay || opts.seed != null));
      updateScrubMax();
      simMs = 0;
      playing = !!opts.autoplay && !!res.frames && res.durationMs > 0;
      lastTs = 0;
      updateLimitBadge();
      syncPlayButton();
      updateExport();
      V.Tune.refresh();
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
  /** why a control is greyed out, shown under it (and as a tooltip); '' clears it */
  function why(el, text) {
    if (!el) return;
    el.title = text || '';
    const lab = el.closest('label');
    if (!lab) return;
    if (text) lab.dataset.why = text;
    else delete lab.dataset.why;
  }

  function updateMotorUi() {
    if (!$('motorAuto')) return;
    S.robot.motor = V.sanitizeMotor(S.robot.motor);
    const m = S.robot.motor;
    $('motorAuto').checked = m.auto;
    $('motorCartridge').value = String(m.cartridge);
    $('motorCartridge').disabled = m.n11 === 0;
    why($('motorCartridge'), m.n11 === 0 ? 'Only for the 11 W motors, and there are none. A 5.5 W motor is fixed at about 200 rpm.' : '');
    $('motorUnit').value = m.unit;
    const speed = document.querySelector('[data-key="robot.speedPct"]');
    const resp = document.querySelector('[data-key="robot.responseMs"]');
    if (m.auto) {
      const d = V.motorModel(S.robot, S.chassis);
      S.robot.speedPct = Math.round(d.speedPct * 10) / 10;
      S.robot.responseMs = d.respMs;
      if (speed && document.activeElement !== speed) speed.value = S.robot.speedPct;
      if (resp && document.activeElement !== resp) resp.value = S.robot.responseMs;
    }
    [speed, resp].forEach((i) => {
      if (!i) return;
      i.disabled = m.auto;
      why(i, m.auto ? 'Worked out from the motors and the weight. Untick "work out the real-life speed" above to type it in.' : '');
    });
    $('motorInfo').textContent = m.auto ? V.describeMotors(S.robot, S.chassis) : 'Off: the real-life speed and motor response typed above are used.';
  }

  /** timeline length: the sim, or a longer real-robot log in the Real runs tab */
  function totalMs() {
    return Math.max(result && result.frames ? result.durationMs : 0, V.Tune.maxDuration());
  }
  function updateScrubMax() {
    $('scrub').max = String(totalMs());
  }

  function settingsChanged() {
    syncPresets();
    updateMotorUi();
    updateTopSpeed();
    drawChassis();
    updateExport();
    save();
    requestDraw();
    if (!$('autoRun').checked) return;
    clearTimeout(debounce);
    // while you draw, wait until you stop for a moment, then show the robot driving the path
    debounce = setTimeout(() => runNow({ autoplay: pathPreview() }), pathPreview() ? 450 : 220);
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
    // code coordinates are field coordinates when the code's own setPose() placed the robot
    if (codeStart && S.cfg.startFromCode) return { px: 0, py: 0, psi: 0 };
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
    if (playing && totalMs() > 0) {
      if (lastTs) simMs += (ts - lastTs) * parseFloat($('speed').value);
      lastTs = ts;
      if (simMs >= totalMs()) {
        simMs = totalMs();
        playing = false;
        syncPlayButton();
      }
    } else lastTs = 0;

    const f = result && result.frames;
    const idx = f ? Math.min(f.t.length - 1, Math.max(0, Math.round(simMs / 10))) : 0;
    const dims = { length: S.robot.length, width: S.robot.width };
    const st = activeStart();
    const state = {
      robot: dims,
      ghost: st && { x: st.x, y: st.y, h: st.h },
      ghostHandle: !pathPreview(),
      paths: $('optPaths').checked ? previewPaths() : null,
      edit: $('optPaths').checked || V.PathTool.tool() === 'edit' ? V.PathTool.drawState() : null,
      codeAxes: $('optAxes').checked && st
        ? pathPreview() ? { x: 0, y: 0, h: 0 } : { x: startFrame().px, y: startFrame().py, h: (startFrame().psi * 180) / Math.PI }
        : null,
      aligners: hasAligners() ? S.aligners : null,
      logs: V.Tune.drawState(simMs, codeToField, (startFrame().psi * 180) / Math.PI),
    };
    const goals = worldOn() ? currentGoals() : [];
    if (f) {
      state.pose = { x: f.x[idx], y: f.y[idx], h: f.h[idx] };
      state.hit = !!f.hit[idx];
      if ($('optTrail').checked) state.trail = trail.slice(0, idx + 1);
      if (goals.length) {
        const al = { front: f.alF ? f.alF[idx] : -1, back: f.alB ? f.alB[idx] : -1 };
        const on = new Set([al.front, al.back]);
        const boxes = goals.filter((g) => $('optGoals').checked || on.has(g.index)).map((g) => ({ poly: g.poly, aligned: on.has(g.index) }));
        if (boxes.length) state.goalBoxes = boxes;
        if (state.aligners) {
          const c = Math.cos(f.h[idx] * D2R);
          const s = Math.sin(f.h[idx] * D2R);
          state.alignPoints = ['front', 'back'].filter((k) => S.aligners[k].on && S.aligners[k].shapes.length).map((k) => {
            const pt = V.alignerPoint(S.aligners[k], k);
            return { x: f.x[idx] + pt.x * c + pt.y * s, y: f.y[idx] - pt.x * s + pt.y * c, aligned: al[k] >= 0 };
          });
        }
      }
      const mi = f.mi[idx];
      if (mi >= 0 && result.motions[mi] && result.motions[mi].follow) state.followPath = result.motions[mi].follow;
      if ($('optAim').checked && isFinite(f.ax[idx])) state.aim = { x: f.ax[idx], y: f.ay[idx] };
      updateHud(f, idx, mi);
    } else {
      state.pose = st ? { x: st.x, y: st.y, h: st.h } : null;
      updateHud(null, 0, -1);
    }
    renderer.draw(state);

    $('scrub').value = String(Math.round(simMs));
    if (playing) requestDraw();
  }

  function updateHud(f, idx, mi) {
    if (!f) {
      $('tTime').textContent = '0.00';
      const st = activeStart();
      $('tField').textContent = st ? `${st.x.toFixed(1)}, ${st.y.toFixed(1)}  ${st.h.toFixed(0)}°` : '-';
      $('tCode').textContent = '0.0, 0.0  0°';
      $('tSpeed').textContent = '-';
      $('tAlign').textContent = '-';
      $('tMotion').textContent = '-';
      return;
    }
    $('tTime').textContent = (f.t[idx] / 1000).toFixed(2);
    $('tField').textContent = `${f.x[idx].toFixed(1)}, ${f.y[idx].toFixed(1)}  ${norm360(f.h[idx]).toFixed(0)}°`;
    $('tCode').textContent = `${f.cx[idx].toFixed(1)}, ${f.cy[idx].toFixed(1)}  ${f.ct[idx].toFixed(0)}°`;
    const alText = ['front', 'back']
      .filter((k) => S.aligners[k].on && S.aligners[k].shapes.length)
      .map((k) => {
        const g = f[k === 'front' ? 'alF' : 'alB'][idx];
        return `${k}: ${g >= 0 ? 'aligned (goal ' + (g + 1) + ')' : 'no'}`;
      });
    $('tAlign').textContent = alText.length ? alText.join(', ') : '-';
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
  const wrap180 = (d) => norm360(d + 180) - 180;

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
      if (V.PathTool.tool() !== 'edit' && codeStart && S.cfg.startFromCode && (hitRobot(w).inside || handleHit(w))) {
        $('cursor').textContent = 'The start pose comes from setPose() in your code. Untick "take the start pose from setPose()" to place it by hand.';
        return;
      }
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
    const od = c.config.odom;
    if (od) {
      const t = S.chassis.tracking;
      t.vertical = { on: od.vertical.on, offset: od.vertical.offset != null ? od.vertical.offset : t.vertical.offset };
      t.horizontal = { on: od.horizontal.on, offset: od.horizontal.offset != null ? od.horizontal.offset : t.horizontal.offset };
      t.second = od.second;
      S.chassis.imu = od.imu;
      S.chassis = V.sanitizeChassis(S.chassis);
      notes.push(`odometry (${od.imu ? 'IMU' : 'no IMU'}${od.vertical.on ? ', forward wheel' : ''}${od.horizontal.on ? ', sideways wheel' : ''})`);
    }
    ['lateral', 'angular'].forEach((k) => {
      const src = c.config[k];
      if (!src) return;
      Object.keys(src).forEach((p) => {
        if (src[p] != null && isFinite(src[p])) S[k][p] = src[p];
      });
      notes.push(`${k} gains`);
    });
    // JAR-Template: Drive chassis(..., wheel_diameter, wheel_ratio, ...) + the motors' cartridge
    const jd = c.config.jarDrive;
    if (jd && jd.wheelDiameter) {
      S.robot.wheelDiameter = jd.wheelDiameter;
      notes.push(`wheel ${jd.wheelDiameter} in`);
      const gear = (c.config.motors.find((m) => m.side === 'L') || {}).gearRpm;
      if (gear && jd.wheelRatio) {
        S.robot.rpm = Math.round(gear * jd.wheelRatio);
        notes.push(`${S.robot.rpm} rpm`);
      }
    }
    // RW-Template: distance_between_wheels, wheel_distance_in (= ratio * diameter * pi), drive_motor_rpm
    const rw = c.config.rw || {};
    if (rw.distance_between_wheels) {
      S.robot.trackWidth = rw.distance_between_wheels;
      notes.push(`track ${rw.distance_between_wheels} in`);
    }
    if (rw.wheel_distance_in) {
      // top speed = motor rpm / 60 * wheel_distance_in; the sim's is wheel rpm / 60 * pi * diameter
      const rpm = rw.drive_motor_rpm || (c.config.motors.find((m) => m.side === 'L') || {}).gearRpm || 600;
      S.robot.wheelDiameter = Math.round((rw.wheel_distance_in / Math.PI) * 1000) / 1000;
      S.robot.rpm = rpm;
      notes.push(`wheel_distance_in ${rw.wheel_distance_in.toFixed(2)} in at ${rpm} rpm`);
    }
    if (!notes.length) {
      addLog('warn', 'Nothing to import: no lemlib::Drivetrain / ControllerSettings, JAR-Template Drive or RW-Template settings found in the code.');
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
      // the "drawn" field was removed; settings saved with it fall back to the match field
      if (S.fieldStyle !== 'photo-skills') S.fieldStyle = 'photo-match';
      // real-life error was removed (settings saved with it just drop it)
      delete S.real;
      // settings saved before the defaults changed: error and solid goals off, aligners off until something is drawn
      if (saved.S.defaultsV !== 2) {
        S.cfg.solidGoals = false;
        ['front', 'back'].forEach((k) => {
          if (S.aligners[k] && !(S.aligners[k].shapes || []).length) S.aligners[k].on = false;
        });
        S.defaultsV = 2;
      }
      S.chassis = V.sanitizeChassis(S.chassis);
      S.aligners = V.sanitizeAligners(S.aligners);
      S.robot.motor = V.sanitizeMotor(S.robot.motor);
      Object.keys(V.GOAL_DEFAULTS).forEach((k) => {
        const lo = k === 'chamfer' ? 0 : 2;
        const hi = k === 'chamfer' ? 3 : 12;
        // goals saved with the old estimate (5.8 in, regular octagon) get the measured footprint
        if (!(S.goals[k] >= lo && S.goals[k] <= hi) || (k !== 'chamfer' && S.goals[k] === 5.8)) S.goals[k] = V.GOAL_DEFAULTS[k];
      });
      // 500 ms was the old default for the lift / claw wait; the new default is no wait at all
      if (saved.S.cfg && saved.S.cfg.mechanismWait === 500) S.cfg.mechanismWait = 0;
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
      pathPreview,
      hint: (t) => ($('cursor').textContent = t),
      selected: () => pathPreview() && runNow({ autoplay: true }),
      log: addLog,
      topSpeedMps: () => ((S.robot.rpm / 60) * Math.PI * S.robot.wheelDiameter * (S.robot.speedPct / 100)) / 39.3701,
    });
    if (saved && saved.project) V.PathTool.load(saved.project);
    else if (!saved) loadExamplePath();
    V.Tune.init({
      $,
      log: addLog,
      requestDraw,
      durationChanged: updateScrubMax,
      result: () => result,
      settings: () => S,
      code: () => $('code').value,
      routine: () => (compiled && compiled.routine) || '',
      applyRobot: (r) => {
        // measured beats modelled: switch off the motor model so it doesn't overwrite these
        const wasAuto = !!(S.robot.motor && S.robot.motor.auto);
        if (S.robot.motor) S.robot.motor.auto = false;
        Object.assign(S.robot, r);
        pushSettingsToUi();
        updateMotorUi();
        settingsChanged();
        return wasAuto;
      },
    });
    renderer.onImageLoad = requestDraw;
    window.addEventListener('vsim-theme', () => {
      drawChassis();
      requestDraw();
      V.PathTool.drawGraph();
    });
    renderer.setFieldStyle(S.fieldStyle);
    rebuildPaths();
    pushSettingsToUi();
    setPreview(S.preview === 'code' ? 'code' : 'path', { quiet: true });

    $('btnRun').addEventListener('click', () => runNow({ autoplay: true }));
    $('pvPath').addEventListener('click', () => setPreview('path'));
    $('pvCode').addEventListener('click', () => setPreview('code'));
    const follow = (id, key, conv) =>
      $(id).addEventListener('input', () => {
        const v = conv($(id));
        if (v == null || !isFinite(v)) return;
        S.follow[key] = v;
        settingsChanged();
      });
    follow('fLook', 'lookahead', (el) => parseFloat(el.value));
    follow('fTimeout', 'timeout', (el) => parseFloat(el.value));
    $('fBack').addEventListener('change', (e) => {
      S.follow.backwards = e.target.checked;
      settingsChanged();
    });
    $('btnDownloadPath').addEventListener('click', () => {
      try {
        const info = V.PathTool.downloadPath();
        addLog('info', `Saved ${info.fileName}. Put it in your PROS project's static/ folder.`);
        flash($('btnDownloadPath'), 'Saved');
      } catch (err) {
        addLog('warn', 'Export failed: ' + err.message);
      }
    });
    $('btnCopyCode').addEventListener('click', async () => {
      flash($('btnCopyCode'), (await copyText($('genCode').value)) ? 'Copied' : 'Select + Ctrl+C');
    });
    $('btnInsert').addEventListener('click', () => {
      const pv = previewRun();
      if (!pv) return;
      const res = V.CodeGen.insertIntoCode($('code').value, {
        language: S.lang,
        assetId: pv.info.assetId,
        fileName: pv.info.fileName,
        pose: pv.pose,
        ...pv.opts,
      });
      $('code').value = res.code;
      // the robot has to stand where the new setPose says it does
      if (res.notes.some((n) => /setPose/.test(n))) S.start = { x: pv.pose.x, y: pv.pose.y, h: pv.pose.h };
      pushSettingsToUi();
      setPreview('code', { quiet: true });
      addLog('info', 'Added to your code: ' + res.notes.join(', '));
      flash($('btnInsert'), 'Added');
      runNow({ autoplay: true });
    });
    $('btnStartAtPath').addEventListener('click', () => {
      const pv = previewRun();
      if (!pv) return;
      S.start = { x: pv.pose.x, y: pv.pose.y, h: pv.pose.h };
      pushSettingsToUi();
      settingsChanged();
    });
    $('btnExample').addEventListener('click', () => {
      setPreview('code', { quiet: true });
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
      const keep = { lang: S.lang, preview: S.preview };
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
    // rewind to the start and wait there; Play starts it
    $('btnRestart').addEventListener('click', () => {
      simMs = 0;
      playing = false;
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
    // aligners and goals
    $('solidGoals').addEventListener('change', (e) => {
      S.cfg.solidGoals = e.target.checked;
      updateSolidUi();
      settingsChanged();
    });
    const alignEditor = V.AlignerEditor.init({
      $,
      get: () => ({ aligners: S.aligners, robot: S.robot, chassis: S.chassis, goals: S.goals }),
      changed: () => {
        updateSolidUi();
        renderAlignSummary();
        settingsChanged();
      },
    });
    ['Front', 'Back'].forEach((k) => $('btnAlign' + k).addEventListener('click', () => alignEditor && alignEditor.open(k.toLowerCase())));
    $('optGoals').addEventListener('change', requestDraw);
    setInterval(renderRuns, 30000);
    renderAlignSummary();
    syncPresets();
    chassisView = new V.ChassisView($('chassisCanvas'));
    chassisView.onToggle = (side, i) => {
      const list = S.chassis[side];
      // omni -> traction -> blank -> omni; the last wheel on a side cannot be blanked
      const next = { omni: 'traction', traction: 'none', none: 'omni' }[list[i]] || 'omni';
      list[i] = next === 'none' && list.filter((t, j) => j !== i && t !== 'none').length === 0 ? 'omni' : next;
      if (S.chassis.mirror) S.chassis[side === 'left' ? 'right' : 'left'] = list.slice();
      renderChassisUi();
      settingsChanged();
    };
    new ResizeObserver(drawChassis).observe($('chassisCanvas'));
    renderChassisUi();
    initChangelog();
    initTune();
    initTabs();
    $('startFromCode').addEventListener('change', (e) => {
      S.cfg.startFromCode = e.target.checked;
      if (!e.target.checked) $('startNote').hidden = true;
      settingsChanged();
    });
    $('motorAuto').addEventListener('change', (e) => {
      S.robot.motor.auto = e.target.checked;
      settingsChanged();
    });
    $('motorCartridge').addEventListener('change', (e) => {
      S.robot.motor.cartridge = parseInt(e.target.value, 10);
      settingsChanged();
    });
    $('motorUnit').addEventListener('change', (e) => {
      const m = S.robot.motor;
      const to = e.target.value;
      if (to !== m.unit) m.weight = Math.round(m.weight * (to === 'lb' ? 2.20462 : 0.453592) * 10) / 10;
      m.unit = to;
      pushSettingsToUi();
      settingsChanged();
    });
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
        simMs = Math.max(0, Math.min(totalMs(), simMs + (e.key === 'ArrowRight' ? 100 : -100)));
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
    const splashShown = Date.now();
    runNow({ autoplay: true }).then(() => hideSplash(splashShown));
  }

  // ------------------------------------------------------------------ aligners, goals, run history

  const hasAligners = () => ['front', 'back'].some((k) => S.aligners[k].on && S.aligners[k].shapes.length);
  /** goals and walls are solid when asked for, and always while aligners are on (they are no use otherwise) */
  const worldOn = () => !!S.cfg.solidGoals || hasAligners();

  function updateSolidUi() {
    const box = $('solidGoals');
    if (!box) return;
    const forced = hasAligners();
    box.checked = forced || !!S.cfg.solidGoals;
    box.disabled = forced;
    why(box, forced ? 'Ticked and greyed out because goal aligners are on: they only work if the goals are solid. Turn the aligners off to untick this.' : '');
  }

  /** the solid goals at the sizes in the settings (rebuilt only when a size changes) */
  function currentGoals() {
    const key = JSON.stringify(S.goals);
    if (goalCache.key !== key) goalCache = { key, goals: V.buildGoals(S.goals) };
    return goalCache.goals;
  }

  /** aligner presets follow the robot length and their offset; hand-edited ones become a drawing */
  function syncPresets() {
    let changed = false;
    ['front', 'back'].forEach((k) => {
      if (V.applyAlignerPreset(S.aligners[k], k, S.robot.length)) changed = true;
    });
    if (changed) {
      updateSolidUi();
      renderAlignSummary();
    }
    renderPresetUi();
  }

  function renderPresetUi() {
    const host = $('alignPresets');
    if (!host) return;
    if (!host.dataset.built) {
      host.dataset.built = '1';
      const opts = '<option value="none">None (draw your own)</option>' + Object.keys(V.ALIGNER_PRESETS).map((k) => `<option value="${k}">${esc(V.ALIGNER_PRESETS[k].label)}</option>`).join('');
      host.innerHTML = ['front', 'back']
        .map((k) => {
          const K = k[0].toUpperCase() + k.slice(1);
          return `<label class="field"><span>${K} preset</span><select data-preset="${k}">${opts}</select></label>` +
            `<label class="field"><span>${K}: forward / back (in)</span><input type="number" step="0.25" min="-24" max="24" inputmode="decimal" data-offset="${k}"></label>`;
        })
        .join('');
      host.querySelectorAll('[data-preset]').forEach((sel) =>
        sel.addEventListener('change', () => {
          const a = S.aligners[sel.dataset.preset];
          const was = a.preset;
          a.preset = sel.value;
          a.presetSig = '';
          if (a.preset !== 'none') a.on = true;
          else if (was !== 'none') {
            // back to drawing your own: the preset's shapes go
            a.shapes = [];
            a.on = false;
          }
          updateSolidUi();
          renderAlignSummary();
          settingsChanged();
        })
      );
      host.querySelectorAll('[data-offset]').forEach((inp) =>
        inp.addEventListener('input', () => {
          const n = parseFloat(inp.value);
          if (!isFinite(n)) return;
          S.aligners[inp.dataset.offset].offset = Math.min(24, Math.max(-24, n));
          settingsChanged();
        })
      );
    }
    ['front', 'back'].forEach((k) => {
      const a = S.aligners[k];
      const sel = host.querySelector(`[data-preset="${k}"]`);
      const inp = host.querySelector(`[data-offset="${k}"]`);
      sel.value = a.preset || 'none';
      if (document.activeElement !== inp) inp.value = a.offset || 0;
      inp.disabled = !V.ALIGNER_PRESETS[a.preset];
      why(inp, inp.disabled ? 'Greyed out because this side has no preset: pick one to the left to move it.' : '');
    });
  }

  function renderAlignSummary() {
    const host = $('alignSummary');
    if (!host) return;
    host.innerHTML = ['front', 'back']
      .map((k) => {
        const a = S.aligners[k];
        if (!a.on) return `<div>${k}: off</div>`;
        const n = a.shapes.length;
        if (V.ALIGNER_PRESETS[a.preset]) return `<div>${k}: ${esc(V.ALIGNER_PRESETS[a.preset].label.toLowerCase())}${a.offset ? `, moved ${Math.abs(a.offset)} in ${a.offset > 0 ? 'forward' : 'back'}` : ''}, aligned within ${a.tol} in</div>`;
        return `<div>${k}: ${n ? n + ' shape' + (n > 1 ? 's' : '') : 'nothing drawn yet'}, ${esc(V.MATERIALS[a.material].label.toLowerCase())}, aligned within ${a.tol} in</div>`;
      })
      .join('');
  }

  function timeAgo(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    return h < 24 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
  }

  /** a line for the run history: how long it took, how far off the odometry ended, whether the aligners aligned */
  function describeRun(res) {
    if (!res.frames) return 'could not run';
    const parts = [`${(res.durationMs / 1000).toFixed(1)} s`];
    if (res.realism) parts.push(`odometry ${res.realism.endPosErr.toFixed(1)} in / ${res.realism.endHeadErr.toFixed(1)}° off`);
    if (res.align) ['front', 'back'].forEach((k) => res.align[k] && parts.push(`${k} ${res.align[k].aligned ? 'aligned' : 'not aligned'}`));
    if (res.error) parts.push('error');
    return parts.join(' · ');
  }

  function recordRun(res, fresh) {
    const entry = { seed: runSeed, text: describeRun(res) };
    if (fresh || !runs.length) runs.unshift({ n: ++runCounter, at: Date.now(), ...entry });
    else Object.assign(runs[0], entry); // a re-run after changing a setting keeps the same draw: update the entry
    runs = runs.slice(0, 30);
    renderRuns();
  }

  function renderRuns() {
    const ul = $('runList');
    if (!ul) return;
    $('runCount').textContent = runs.length ? runs.length + ' run' + (runs.length > 1 ? 's' : '') : '';
    ul.innerHTML = '';
    runs.forEach((r, i) => {
      const li = document.createElement('li');
      if (i === 0) li.className = 'cur';
      li.innerHTML = `<span class="what"><b>Run #${r.n}</b> &middot; ${esc(r.text)}</span><span class="when" title="random seed ${r.seed}">${timeAgo(r.at)}</span>` +
        (i === 0 ? '' : '<button class="btn" type="button" title="Run this random draw again with the current settings">Replay</button>');
      const b = li.querySelector('button');
      if (b) b.addEventListener('click', () => runNow({ seed: r.seed, autoplay: true }));
      ul.appendChild(li);
    });
  }

  // ------------------------------------------------------------------ auto-tune timeouts

  function initTune() {
    const dlg = $('tuneDlg');
    if (!dlg || typeof dlg.showModal !== 'function') {
      $('btnTune').hidden = true;
      return;
    }
    let tuned = null;
    $('btnTune').addEventListener('click', () => {
      $('tuneOut').hidden = true;
      $('tuneStatus').textContent = '';
      dlg.showModal();
    });
    $('tuneClose').addEventListener('click', () => dlg.close());
    $('tuneCopy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('tuneCode').value);
        $('tuneStatus').textContent = 'Copied.';
      } catch (e) {
        $('tuneCode').select();
        $('tuneStatus').textContent = 'Select the code and copy it (Ctrl+C).';
      }
    });
    $('tuneUse').addEventListener('click', () => {
      $('code').value = $('tuneCode').value;
      save();
      dlg.close();
      runNow({ autoplay: true });
    });
    $('tuneRun').addEventListener('click', async () => {
      const btn = $('tuneRun');
      btn.disabled = true;
      $('tuneOut').hidden = true;
      try {
        const code = $('code').value;
        const c = V.compileAuton(code, { language: S.lang, routine: S.routine, markSites: true });
        if (!c.sites || !c.sites.length) {
          $('tuneStatus').textContent = 'No motion calls (moveToPoint, turnToHeading, follow, ...) found in the code.';
          return;
        }
        const num = (id, d) => (isFinite(parseFloat($(id).value)) ? parseFloat($(id).value) : d);
        const options = { pct: num('tunePct', 20), extraMs: num('tuneExtra', 150), alignMs: num('tuneAlign', 400), alignedMarginMs: num('tuneAligned', 200) };
        const draws = 1; // the sim is a perfect robot: one run measures it
        const base = runSeed == null ? 1 : runSeed;
        const seeds = Array.from({ length: draws }, (_, i) => base + i * 7919);
        $('tuneStatus').textContent = 'Measuring...';
        await new Promise((r) => setTimeout(r, 30));
        const result = await V.autoTuneMany({
          sites: c.sites,
          options,
          seeds,
          simulate: (seed) => (extra) => V.runSimulation({ js: c.js, ...runOptions(c, seed), ...extra }),
          onProgress: (i, n) => {
            $('tuneStatus').textContent = `Measured ${i} of ${n} random draw${n > 1 ? 's' : ''}...`;
          },
        });
        // how the auton does with the tuned timeouts, on the first draw, against the code as it is
        const before = await V.runSimulation({ js: c.js, ...runOptions(c, seeds[0]) });
        const after = await V.runSimulation({ js: c.js, ...runOptions(c, seeds[0]), siteTimeouts: result.tuned });
        tuned = result;
        renderTune(result, code, c.sites, before, after, draws);
        $('tuneStatus').textContent = '';
      } catch (e) {
        $('tuneStatus').textContent = 'Could not auto-tune: ' + (e && e.message ? e.message : e);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function renderTune(result, code, sites, before, after, draws) {
    const sec = (ms) => (ms == null ? '-' : (ms / 1000).toFixed(2) + ' s');
    const gain = before.durationMs - after.durationMs;
    const lower = result.rows.filter((r) => r.editable && r.ms != null && r.ms < r.old).length;
    const raise = result.rows.filter((r) => r.editable && r.ms != null && r.ms > r.old).length;
    $('tuneSummary').textContent =
      `Auton time with your timeouts ${sec(before.durationMs)}, with the tuned ones ${sec(after.durationMs)}` +
      (gain > 50 ? ` (${(gain / 1000).toFixed(2)} s faster)` : gain < -50 ? ` (${(-gain / 1000).toFixed(2)} s slower)` : '') +
      `. ${lower} timeout${lower === 1 ? '' : 's'} lowered` +
      (raise ? `, ${raise} raised because the old one cut the motion off before it finished` : '') +
      '.';
    const kinds = { blocked: 'hit something', aligned: 'aligned', finished: '', cancelled: 'left as is', unfinished: 'left as is', notrun: 'did not run' };
    const head = '<tr><th>Line</th><th>Call</th><th class="n">Your timeout</th><th class="n">Measured</th><th class="n">New timeout</th><th>Why</th></tr>';
    const rows = result.rows
      .map((r) => {
        const measured = r.kind === 'blocked' || r.kind === 'aligned' || r.maxMs == null ? '-' : r.minMs === r.maxMs ? r.maxMs + ' ms' : `${r.minMs}-${r.maxMs} ms`;
        const nw = r.ms == null ? '-' : r.ms + (r.editable ? '' : ' (change it by hand)');
        return `<tr class="${r.kind}"><td class="n">${r.line}</td><td>${esc(r.method)}</td><td class="n">${esc(r.oldText)}</td><td class="n">${measured}</td><td class="n new">${nw}</td><td class="why">${esc(r.why)}${kinds[r.kind] && r.kind === 'blocked' ? '' : ''}</td></tr>`;
      })
      .join('');
    $('tuneTable').innerHTML = head + rows;
    $('tuneCode').value = V.rewriteTimeouts(code, sites, result.tuned);
    $('tuneOut').hidden = false;
  }

  // ------------------------------------------------------------------ settings tabs

  /** switch to a settings tab (unless Everything is showing) */
  function showTab(name) {
    if (document.querySelector('#tabs .tab.on[data-tab="all"]')) return;
    const t = document.querySelector(`#tabs .tab[data-tab="${name}"]`);
    if (t) t.click();
  }

  function initTabs() {
    const bar = $('tabs');
    if (!bar) return;
    const tabs = Array.from(bar.querySelectorAll('.tab'));
    let shown = null;
    const show = (name) => {
      // the settings slide the way you are going: to a tab on the right from the right, to one on the left from the left
      const prev = shown ? tabs.findIndex((t) => t.dataset.tab === shown) : -1, next = tabs.findIndex((t) => t.dataset.tab === name);
      const panes = document.getElementById('panes');
      if (panes && prev >= 0 && prev !== next && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        panes.classList.remove('tab-fwd', 'tab-back'); void panes.offsetWidth; panes.classList.add(next > prev ? 'tab-fwd' : 'tab-back');
        setTimeout(() => panes.classList.remove('tab-fwd', 'tab-back'), 500);
      }
      shown = name;
      tabs.forEach((t) => {
        t.classList.toggle('on', t.dataset.tab === name);
        t.setAttribute('aria-selected', String(t.dataset.tab === name));
      });
      document.querySelectorAll('#panes > .sec[data-tab]').forEach((sec) => sec.classList.toggle('off-tab', name !== 'all' && sec.dataset.tab !== name));
      try { localStorage.setItem('waypointTab', name); } catch (e) { /* storage blocked */ }
    };
    tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
    // path-first: a new visitor lands on the Paths tab (draw, preview, export)
    let saved = 'paths';
    try { saved = localStorage.getItem('waypointTab') || 'paths'; } catch (e) { /* storage blocked */ }
    show(tabs.some((t) => t.dataset.tab === saved) ? saved : 'paths');
  }

  // ------------------------------------------------------------------ chassis

  function drawChassis() {
    if (chassisView) chassisView.draw({ robot: S.robot, chassis: S.chassis });
  }

  /** wheel rows, tracking wheel boxes and the summary line under the drawing */
  function renderChassisUi() {
    const host = $('chassisControls');
    if (!host) return;
    S.chassis = V.sanitizeChassis(S.chassis);
    const c = S.chassis;
    host.innerHTML = '';
    const change = () => {
      S.chassis = V.sanitizeChassis(S.chassis);
      renderChassisUi();
      settingsChanged();
    };
    const opts = (cur) => V.WHEEL_CHOICES.map((k) => `<option value="${k}"${k === cur ? ' selected' : ''}>${V.WHEEL_CHOICE_LABEL[k]}</option>`).join('');
    const row = (side, label) => {
      const list = c[side];
      const div = document.createElement('div');
      div.className = 'wrow wheels';
      div.innerHTML = `<span>${label}</span>` + list.map((t, i) => `<select data-i="${i}" aria-label="${label} position ${i + 1} from the front">${opts(t)}</select>`).join('');
      div.querySelectorAll('select').forEach((sel) => sel.addEventListener('change', () => {
        S.chassis[side][+sel.dataset.i] = sel.value;
        if (S.chassis.mirror && side === 'left') S.chassis.right = S.chassis.left.slice();
        change();
      }));
      host.appendChild(div);
      if (list.filter((t) => t !== 'none').length <= 1) {
        const n = document.createElement('p');
        n.className = 'whynote';
        n.textContent = 'Only one wheel is left on this side, so the others can not all be blanked: pick Omni or Traction at a blank position to add one back.';
        host.appendChild(n);
      }
    };
    row('left', c.mirror ? 'Wheels, each side' : 'Left wheels');
    if (!c.mirror) row('right', 'Right wheels');
    const mir = document.createElement('label');
    mir.className = 'check';
    mir.innerHTML = `<input type="checkbox"${c.mirror ? ' checked' : ''}> right side is the same as the left`;
    mir.querySelector('input').addEventListener('change', (e) => {
      S.chassis.mirror = e.target.checked;
      if (S.chassis.mirror) S.chassis.right = S.chassis.left.slice();
      change();
    });
    host.appendChild(mir);
    [['vertical', 'Forward tracking wheel', 'sideways offset from the centre (in, + = right)'], ['horizontal', 'Sideways tracking wheel', 'forward offset from the centre (in, + = ahead)']].forEach(([k, label, hint]) => {
      const t = c.tracking[k];
      const div = document.createElement('div');
      div.className = 'trow';
      div.innerHTML = `<label class="check"><input type="checkbox"${t.on ? ' checked' : ''}> ${label}</label>` +
        `<input type="number" step="0.5" min="-12" max="12" value="${t.offset}" title="${hint}" aria-label="${label}: ${hint}"${t.on ? '' : ' disabled'}>`;
      div.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
        S.chassis.tracking[k].on = e.target.checked;
        change();
      });
      div.querySelector('input[type=number]').addEventListener('input', (e) => {
        const n = parseFloat(e.target.value);
        if (!isFinite(n)) return;
        S.chassis.tracking[k].offset = n;
        S.chassis = V.sanitizeChassis(S.chassis);
        $('chassisInfo').textContent = V.describeChassis(S.chassis, S.robot);
        settingsChanged();
      });
      host.appendChild(div);
      if (!t.on) {
        const n = document.createElement('p');
        n.className = 'whynote';
        n.textContent = `The ${k === 'vertical' ? 'sideways offset' : 'forward offset'} box is off until you tick this wheel.`;
        host.appendChild(n);
      }
    });
    const extra = document.createElement('div');
    extra.className = 'wrow';
    extra.innerHTML = `<label class="check"><input type="checkbox" data-k="imu"${c.imu ? ' checked' : ''}> IMU (inertial sensor) for heading</label>` +
      `<label class="check"><input type="checkbox" data-k="second"${c.tracking.second ? ' checked' : ''}${c.tracking.vertical.on ? '' : ' disabled'}> second forward tracking wheel (other side)</label>`;
    if (!c.tracking.vertical.on) why(extra.querySelector('[data-k=second]'), 'Greyed out because it needs the forward tracking wheel above: tick that first.');
    extra.querySelector('[data-k=imu]').addEventListener('change', (e) => {
      S.chassis.imu = e.target.checked;
      change();
    });
    extra.querySelector('[data-k=second]').addEventListener('change', (e) => {
      S.chassis.tracking.second = e.target.checked;
      change();
    });
    host.appendChild(extra);
    $('chassisInfo').textContent = V.describeChassis(S.chassis, S.robot);
    drawChassis();
  }

  // ------------------------------------------------------------------ changelog

  /** `**bold**`, `*italic*` and `code` from CHANGELOG.md; everything else is escaped text */
  function inlineMd(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\*([^*]+)\*/g, '<i>$1</i>');
  }

  function renderChangelog() {
    const body = $('changelogBody');
    body.innerHTML = '';
    (V.CHANGELOG || []).forEach((rel, i) => {
      const card = document.createElement('section');
      card.className = 'cl-rel';
      const title = rel.title === 'Unreleased' ? 'Latest changes' : rel.title;
      card.innerHTML = `<h3>${esc(title)}${i === 0 ? '<span class="cl-tag">New</span>' : ''}</h3>`;
      rel.sections.forEach((sec) => {
        const div = document.createElement('div');
        div.className = 'cl-sec';
        const items = sec.items
          .map((it) => `<li>${inlineMd(it.text)}${it.sub.length ? '<ul>' + it.sub.map((t) => `<li>${inlineMd(t)}</li>`).join('') + '</ul>' : ''}</li>`)
          .join('');
        div.innerHTML = (sec.name ? `<h4 class="${esc(sec.name.toLowerCase())}">${esc(sec.name)}</h4>` : '') + `<ul>${items}</ul>`;
        card.appendChild(div);
      });
      body.appendChild(card);
    });
  }

  /** a dot on the button until the newest entry has been opened */
  function changelogSignature() {
    const log = V.CHANGELOG || [];
    return log.length ? `${log[0].title}:${log[0].sections.reduce((n, s) => n + s.items.length, 0)}` : '';
  }

  function initChangelog() {
    const dlg = $('changelog');
    if (!dlg || typeof dlg.showModal !== 'function') {
      $('btnChangelog').hidden = true;
      return;
    }
    renderChangelog();
    const seen = () => {
      try { return localStorage.getItem('waypointChangelogSeen'); } catch (e) { return null; }
    };
    $('changelogDot').hidden = seen() === changelogSignature();
    $('btnChangelog').addEventListener('click', () => {
      dlg.showModal();
      $('changelogBody').scrollTop = 0;
      $('changelogDot').hidden = true;
      try { localStorage.setItem('waypointChangelogSeen', changelogSignature()); } catch (e) { /* storage blocked */ }
    });
    $('changelogClose').addEventListener('click', () => dlg.close());
    // a click on the dimmed area (the dialog element itself, outside its box) closes it
    dlg.addEventListener('click', (e) => {
      const r = dlg.getBoundingClientRect();
      if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dlg.close();
    });
  }

  /** fade the logo splash out (if it is showing) once the first run is ready, but not before ~1 s; a click skips it */
  function hideSplash(since) {
    const el = $('splash');
    if (!el || el.hidden) return;
    const close = () => {
      el.classList.add('out');
      setTimeout(() => (el.hidden = true), 500);
    };
    el.addEventListener('click', close, { once: true });
    setTimeout(close, Math.max(0, 1100 - (Date.now() - since)));
  }

  function togglePlay() {
    if (totalMs() <= 0) return;
    if (!playing && simMs >= totalMs()) simMs = 0;
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
