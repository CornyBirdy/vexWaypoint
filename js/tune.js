/*
 * Tune: real-robot pose logs (from Invictus-v2 include/pose_log.hpp) next to the sim.
 *
 *   parsePoseLog(text)   SD-card CSV or a whole `pros terminal` capture -> runs
 *   segments(run)        one entry per LemLib motion: distance, overshoot, rise, coast
 *   compare(run, frames) time-aligned error between the real run and the sim
 *   fitDrive(run, robot) fits the sim's "real-life speed" and "motor response" to the log
 *   report(...)          markdown summary to hand to Claude
 *
 * Everything above is plain functions so tests/tune.test.js can run it in Node.
 * The UI part at the bottom only runs in the browser.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});
  const D2R = Math.PI / 180;

  // ------------------------------------------------------------------ parsing

  const HEADER = /^\s*t_ms\s*,\s*x\s*,\s*y\s*,\s*theta/i;
  const ROW = /^\s*(\d+)\s*,\s*(-?[\d.]+(?:e-?\d+)?)\s*,\s*(-?[\d.]+(?:e-?\d+)?)\s*,\s*(-?[\d.]+(?:e-?\d+)?)\s*(?:,\s*([01])\s*)?(?:,\s*(-?\d+)\s*)?(?:,\s*(-?\d+)\s*)?(?:,(.*))?$/;

  function isPoseLog(text) {
    if (typeof text !== 'string') return false;
    const head = text.slice(0, 4000);
    return /#POSELOG BEGIN/.test(head) || /waypoint-poselog/.test(head) || HEADER.test(head.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) || '');
  }

  function parseKv(s) {
    const out = {};
    s.replace(/(\w+)=(-?[\d.eE+-]+|\S+)/g, (_m, k, v) => {
      const n = parseFloat(v);
      out[k] = isFinite(n) && /^-?[\d.eE+-]+$/.test(v) ? n : v;
      return '';
    });
    return out;
  }

  function emptyRun(name) {
    return { name, label: 'auton', meta: {}, t: [], x: [], y: [], h: [], moving: [], lmv: [], rmv: [], marks: [], hasVolts: false, cut: false };
  }

  /**
   * @returns {{runs: object[], warnings: string[]}}
   * Each BEGIN..END block in a terminal capture is its own run. A file with no
   * BEGIN line (the SD-card CSV) is one run.
   */
  function parsePoseLog(text, name) {
    name = name || 'log';
    const lines = String(text).replace(/\r/g, '').split('\n');
    const runs = [];
    const warnings = [];
    const hasBlocks = lines.some((l) => l.includes('#POSELOG BEGIN'));
    let cur = hasBlocks ? null : emptyRun(name);

    const finish = (r) => {
      if (r && r.t.length >= 2) runs.push(r);
      else if (r) warnings.push(`${r.name}: no pose rows found`);
    };

    for (const raw of lines) {
      const line = raw.trim();
      if (line.includes('#POSELOG BEGIN')) {
        if (cur) {
          cur.cut = true;
          finish(cur);
        }
        cur = emptyRun(`${name} #${runs.length + 1}`);
        continue;
      }
      if (!cur) continue;
      if (line.includes('#POSELOG END') || line.includes('#POSELOG CUT')) {
        if (line.includes('CUT')) cur.cut = true;
        finish(cur);
        cur = null;
        continue;
      }
      if (line.startsWith('#')) {
        const body = line.slice(1).trim();
        if (body.startsWith('label=')) cur.label = body.slice(6).trim();
        else if (/^(lateral|angular)\b/.test(body)) cur.meta[body.split(/\s/)[0]] = parseKv(body);
        else Object.assign(cur.meta, parseKv(body));
        continue;
      }
      if (!line || HEADER.test(line)) continue;
      const m = ROW.exec(line);
      if (!m) continue;
      const t = +m[1];
      if (cur.t.length && t < cur.t[cur.t.length - 1]) continue; // garbled line
      cur.t.push(t);
      cur.x.push(+m[2]);
      cur.y.push(+m[3]);
      cur.h.push(+m[4]);
      cur.moving.push(m[5] == null ? 0 : +m[5]);
      cur.lmv.push(m[6] == null ? 0 : +m[6]);
      cur.rmv.push(m[7] == null ? 0 : +m[7]);
      if (m[6] != null) cur.hasVolts = true;
      const mark = (m[8] || '').trim();
      if (mark) cur.marks.push({ i: cur.t.length - 1, t, text: mark });
    }
    if (cur) {
      if (hasBlocks) cur.cut = true;
      finish(cur);
    }
    runs.forEach((r) => {
      if (r.cut) warnings.push(`${r.name}: log was cut off before #POSELOG END (the end of the run is missing)`);
      r.duration = r.t[r.t.length - 1] - r.t[0];
    });
    return { runs, warnings };
  }

  // ------------------------------------------------------------------ helpers

  /** index of the last sample at or before t */
  function indexAt(arr, t) {
    let lo = 0;
    let hi = arr.length - 1;
    if (t <= arr[0]) return 0;
    if (t >= arr[hi]) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** pose at time t (ms), linearly interpolated */
  function poseAt(run, t) {
    const i = indexAt(run.t, t);
    const j = Math.min(run.t.length - 1, i + 1);
    const span = run.t[j] - run.t[i];
    const k = span > 0 ? Math.min(1, Math.max(0, (t - run.t[i]) / span)) : 0;
    return {
      x: run.x[i] + (run.x[j] - run.x[i]) * k,
      y: run.y[i] + (run.y[j] - run.y[i]) * k,
      h: run.h[i] + (run.h[j] - run.h[i]) * k,
    };
  }

  /** forward speed (in/s) and turn rate (deg/s, clockwise +) at every sample, central difference over +-w */
  function velocities(run, w) {
    w = w || 2;
    const n = run.t.length;
    const v = new Array(n).fill(0);
    const om = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - w);
      const b = Math.min(n - 1, i + w);
      const dt = (run.t[b] - run.t[a]) / 1000;
      if (dt <= 0) continue;
      const h = run.h[i] * D2R;
      v[i] = ((run.x[b] - run.x[a]) * Math.sin(h) + (run.y[b] - run.y[a]) * Math.cos(h)) / dt;
      om[i] = (run.h[b] - run.h[a]) / dt;
    }
    return { v, om };
  }

  const normDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

  // ------------------------------------------------------------------ motion segments

  /**
   * One entry per stretch where the robot reported a LemLib motion running.
   * kind: 'turn' when it mostly rotated, otherwise 'drive'.
   *   overshoot   inches (drive) / degrees (turn) past where the motion ended up
   *   riseMs      time to cover 90% of the motion
   *   settleMs    time from 90% to the motion ending
   *   coast       inches / degrees the robot kept moving in the 250ms after the motion ended
   */
  function segments(run) {
    const out = [];
    const n = run.t.length;
    const { v, om } = velocities(run);
    let i = 0;
    while (i < n) {
      if (!run.moving[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && run.moving[j + 1]) j++;
      out.push(describe(run, i, j, v, om));
      i = j + 1;
    }
    return out;
  }

  function describe(run, i0, i1, v, om) {
    const x0 = run.x[i0];
    const y0 = run.y[i0];
    const h0 = run.h[i0];
    const dx = run.x[i1] - x0;
    const dy = run.y[i1] - y0;
    const dist = Math.hypot(dx, dy);
    const dh = run.h[i1] - h0;
    const kind = Math.abs(dh) > 15 && dist < 6 ? 'turn' : 'drive';
    const seg = {
      i0, i1,
      t0: run.t[i0],
      t1: run.t[i1],
      kind,
      start: { x: x0, y: y0, h: h0 },
      end: { x: run.x[i1], y: run.y[i1], h: run.h[i1] },
      dist,
      dh,
      peakSpeed: 0,
      peakTurn: 0,
      overshoot: 0,
      riseMs: null,
      settleMs: null,
      coast: 0,
      marks: run.marks.filter((m) => m.i >= i0 && m.i <= i1).map((m) => m.text),
    };
    for (let k = i0; k <= i1; k++) {
      seg.peakSpeed = Math.max(seg.peakSpeed, Math.abs(v[k]));
      seg.peakTurn = Math.max(seg.peakTurn, Math.abs(om[k]));
    }
    // progress along the motion: inches along the start->end line, or degrees turned
    let prog;
    let total;
    if (kind === 'turn') {
      const s = Math.sign(dh) || 1;
      prog = (k) => s * (run.h[k] - h0);
      total = Math.abs(dh);
    } else {
      const ux = dist > 0.25 ? dx / dist : 0;
      const uy = dist > 0.25 ? dy / dist : 0;
      prog = (k) => (run.x[k] - x0) * ux + (run.y[k] - y0) * uy;
      total = dist;
    }
    let peak = -Infinity;
    for (let k = i0; k <= i1; k++) {
      const p = prog(k);
      if (p > peak) peak = p;
      if (seg.riseMs == null && total > 0.25 && p >= 0.9 * total) seg.riseMs = run.t[k] - seg.t0;
    }
    seg.overshoot = Math.max(0, peak - total);
    if (seg.riseMs != null) seg.settleMs = seg.t1 - seg.t0 - seg.riseMs;
    // what happened in the 250ms after LemLib said it was done
    const after = indexAt(run.t, seg.t1 + 250);
    if (after > i1) seg.coast = kind === 'turn' ? Math.abs(run.h[after] - run.h[i1]) : Math.hypot(run.x[after] - run.x[i1], run.y[after] - run.y[i1]);
    return seg;
  }

  // ------------------------------------------------------------------ real vs sim

  /**
   * Time-aligned comparison. Both start at t = 0 when the auton starts, and both
   * are in the code frame (chassis.setPose(0, 0, 0) at the start).
   * frames: sim result.frames (t, cx, cy, ct arrays, 10ms apart).
   * motions: sim result.motions ({label, t0, t1}).
   */
  function compare(run, frames, motions) {
    if (!frames || !frames.t || !frames.t.length) return null;
    const simEnd = frames.t[frames.t.length - 1];
    const simAt = (t) => {
      const k = Math.min(frames.t.length - 1, Math.max(0, Math.round(t / 10)));
      return { x: frames.cx[k], y: frames.cy[k], h: frames.ct[k] };
    };
    let maxErr = 0;
    let maxAt = 0;
    let sumErr = 0;
    let count = 0;
    const until = Math.min(simEnd, run.t[run.t.length - 1]);
    for (let i = 0; i < run.t.length && run.t[i] <= until; i++) {
      const s = simAt(run.t[i]);
      const e = Math.hypot(run.x[i] - s.x, run.y[i] - s.y);
      sumErr += e;
      count++;
      if (e > maxErr) {
        maxErr = e;
        maxAt = run.t[i];
      }
    }
    const realEnd = { x: run.x[run.x.length - 1], y: run.y[run.y.length - 1], h: run.h[run.h.length - 1] };
    const simEndPose = simAt(simEnd);
    const perMotion = (motions || []).filter((m) => m.t1 != null).map((m) => {
      const s = simAt(m.t1);
      const r = poseAt(run, m.t1);
      return { label: m.label, t0: m.t0, t1: m.t1, sim: s, real: r, err: Math.hypot(r.x - s.x, r.y - s.y), herr: normDeg(r.h - s.h) };
    });
    return {
      realMs: run.duration,
      simMs: simEnd,
      meanErr: count ? sumErr / count : 0,
      maxErr,
      maxAt,
      realEnd,
      simEnd: simEndPose,
      endErr: Math.hypot(realEnd.x - simEndPose.x, realEnd.y - simEndPose.y),
      endHerr: normDeg(realEnd.h - simEndPose.h),
      perMotion,
    };
  }

  // ------------------------------------------------------------------ drivetrain fit

  /**
   * The sim drives each side as   dv/dt = (u * vmax - v) / tau   with u the motor
   * power (-1..1). The log has the voltage on each side, so fit
   *   dv/dt = A u + B v   (least squares)  ->  tau = -1/B, vmax = -A/B
   * for forward motion, and the same for turning, which also gives the track
   * width the robot actually turns with (wheels scrub, so it is usually wider
   * than the measured one).
   */
  function fitDrive(run, robot) {
    if (!run.hasVolts) return { ok: false, why: 'this log has no voltage columns' };
    const n = run.t.length;
    const { v, om } = velocities(run, 2);
    const acc = (arr, i) => {
      const a = Math.max(0, i - 2);
      const b = Math.min(n - 1, i + 2);
      const dt = (run.t[b] - run.t[a]) / 1000;
      return dt > 0 ? (arr[b] - arr[a]) / dt : 0;
    };
    const lsq = (rows) => {
      // minimise sum (a - A u - B v)^2
      let suu = 0, suv = 0, svv = 0, sua = 0, sva = 0, saa = 0;
      rows.forEach(([u, vv, a]) => {
        suu += u * u; suv += u * vv; svv += vv * vv; sua += u * a; sva += vv * a; saa += a * a;
      });
      const det = suu * svv - suv * suv;
      if (Math.abs(det) < 1e-9) return null;
      const A = (sua * svv - sva * suv) / det;
      const B = (sva * suu - sua * suv) / det;
      let sse = 0;
      rows.forEach(([u, vv, a]) => (sse += (a - A * u - B * vv) ** 2));
      return { A, B, r2: saa > 0 ? 1 - sse / saa : 0, n: rows.length };
    };
    const fwd = [];
    const turn = [];
    for (let i = 3; i < n - 3; i++) {
      const uL = run.lmv[i] / 12000;
      const uR = run.rmv[i] / 12000;
      const u = (uL + uR) / 2;
      const ut = (uL - uR) / 2;
      if (Math.abs(u) > 0.05 || Math.abs(v[i]) > 2) fwd.push([u, v[i], acc(v, i)]);
      if (Math.abs(ut) > 0.05 || Math.abs(om[i]) > 20) turn.push([ut, om[i] * D2R, acc(om, i) * D2R]);
    }
    if (fwd.length < 50) return { ok: false, why: `only ${fwd.length} driving samples, need 50+` };
    const f = lsq(fwd);
    if (!f || f.B >= 0 || f.A <= 0) return { ok: false, why: 'drive data did not fit the motor model (robot pushing something or on a wall?)' };
    const tau = -1 / f.B;
    const vmax = -f.A / f.B;
    const theory = ((robot.rpm / 60) * Math.PI * robot.wheelDiameter);
    const out = {
      ok: true,
      vmax,
      responseMs: tau * 1000,
      speedPct: (vmax / theory) * 100,
      r2: f.r2,
      samples: f.n,
      trackWidth: null,
      turnR2: null,
    };
    const t = turn.length >= 50 ? lsq(turn) : null;
    if (t && t.B < 0 && t.A > 0) {
      // steady state: omega = (A/-B) ut = 2 vmax ut / T
      out.trackWidth = (2 * vmax * -t.B) / t.A;
      out.turnResponseMs = (-1 / t.B) * 1000;
      out.turnR2 = t.r2;
    }
    return out;
  }

  // ------------------------------------------------------------------ report

  const f1 = (n) => (n == null || !isFinite(n) ? '-' : n.toFixed(1));
  const f2 = (n) => (n == null || !isFinite(n) ? '-' : n.toFixed(2));
  const s2 = (ms) => (ms / 1000).toFixed(2);

  /**
   * Markdown for Claude. ctx: {settings: {robot, lateral, angular, start}, code, routine}
   */
  function report(run, segs, cmp, fit, ctx) {
    const L = [];
    const meta = run.meta || {};
    L.push(`# Waypoint tune report: ${run.label} (${run.name})`);
    L.push('');
    L.push('Real robot pose log (odometry, code frame: x right, y forward, theta degrees clockwise) compared with the Waypoint simulation of the same code.');
    L.push('');
    L.push('## Run');
    L.push(`- duration: real ${s2(run.duration)} s` + (cmp ? `, sim ${s2(cmp.simMs)} s` : ''));
    if (meta.battery_pct != null) L.push(`- battery at start: ${meta.battery_pct}% (${meta.battery_mv} mV)`);
    if (run.cut) L.push('- WARNING: log was cut off, the end of the run is missing');
    ['lateral', 'angular'].forEach((k) => {
      if (meta[k]) L.push(`- robot ${k} PID: ` + Object.entries(meta[k]).map(([a, b]) => `${a}=${b}`).join(' '));
    });
    if (ctx && ctx.settings) {
      const r = ctx.settings.robot;
      L.push(`- sim drivetrain: wheel ${r.wheelDiameter} in, ${r.rpm} rpm, real-life speed ${r.speedPct}%, track ${r.trackWidth} in, motor response ${r.responseMs} ms`);
    }
    L.push('');
    if (cmp) {
      L.push('## Real vs sim');
      L.push(`- mean position error ${f1(cmp.meanErr)} in, max ${f1(cmp.maxErr)} in at ${s2(cmp.maxAt)} s`);
      L.push(`- end: real (${f1(cmp.realEnd.x)}, ${f1(cmp.realEnd.y)}, ${f1(cmp.realEnd.h)}°)  sim (${f1(cmp.simEnd.x)}, ${f1(cmp.simEnd.y)}, ${f1(cmp.simEnd.h)}°)  off by ${f1(cmp.endErr)} in, ${f1(cmp.endHerr)}°`);
      if (cmp.perMotion.length) {
        L.push('');
        L.push('Pose when each sim motion ended (same time on the real robot):');
        L.push('');
        L.push('| # | sim motion | ends s | sim x,y,θ | real x,y,θ | off in | off ° |');
        L.push('|---|---|---|---|---|---|---|');
        cmp.perMotion.forEach((m, i) => {
          L.push(`| ${i + 1} | \`${m.label}\` | ${s2(m.t1)} | ${f1(m.sim.x)}, ${f1(m.sim.y)}, ${f1(m.sim.h)} | ${f1(m.real.x)}, ${f1(m.real.y)}, ${f1(m.real.h)} | ${f1(m.err)} | ${f1(m.herr)} |`);
        });
      }
      L.push('');
    }
    L.push('## Real motions (from chassis.isInMotion())');
    L.push('');
    L.push('Overshoot is how far past the final spot it went (in for drives, ° for turns). Rise is time to 90% of the move; settle is the rest of the motion after that. Coast is movement in the 250 ms after the motion ended (big coast + minSpeed/earlyExit chaining is normal; big coast on a motion meant to stop means it exited early).');
    L.push('');
    L.push('| # | start s | end s | kind | move | peak | overshoot | rise ms | settle ms | coast | marks |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|');
    segs.forEach((s, i) => {
      const move = s.kind === 'turn' ? `${f1(s.dh)}°` : `${f1(s.dist)} in`;
      const peak = s.kind === 'turn' ? `${f1(s.peakTurn)}°/s` : `${f1(s.peakSpeed)} in/s`;
      L.push(`| ${i + 1} | ${s2(s.t0)} | ${s2(s.t1)} | ${s.kind} | ${move} | ${peak} | ${f2(s.overshoot)} | ${s.riseMs == null ? '-' : s.riseMs} | ${s.settleMs == null ? '-' : s.settleMs} | ${f2(s.coast)} | ${s.marks.join(', ')} |`);
    });
    L.push('');
    L.push('## Drivetrain fit');
    if (fit && fit.ok) {
      L.push(`- top speed ${f1(fit.vmax)} in/s = real-life speed ${f1(fit.speedPct)}%, motor response ${Math.round(fit.responseMs)} ms (r² ${f2(fit.r2)}, ${fit.samples} samples)`);
      if (fit.trackWidth) L.push(`- turns like a ${f1(fit.trackWidth)} in track width (r² ${f2(fit.turnR2)})`);
    } else L.push(`- not available: ${fit ? fit.why : 'no fit'}`);
    L.push('');
    L.push('## Trajectory every 100 ms');
    L.push('');
    L.push('```csv');
    L.push('t_s,real_x,real_y,real_theta,moving' + (cmp ? ',sim_x,sim_y,sim_theta' : ''));
    const frames = ctx && ctx.frames;
    for (let t = 0; t <= run.duration; t += 100) {
      const i = indexAt(run.t, t);
      const r = poseAt(run, t);
      let row = `${s2(t)},${f2(r.x)},${f2(r.y)},${f1(r.h)},${run.moving[i]}`;
      if (cmp && frames) {
        const k = Math.min(frames.t.length - 1, Math.round(t / 10));
        row += `,${f2(frames.cx[k])},${f2(frames.cy[k])},${f1(frames.ct[k])}`;
      }
      L.push(row);
    }
    L.push('```');
    if (ctx && ctx.code) {
      L.push('');
      L.push(`## Auton code in Waypoint${ctx.routine ? ` (routine ${ctx.routine}())` : ''}`);
      L.push('');
      L.push('```cpp');
      L.push(ctx.code.trim());
      L.push('```');
    }
    return L.join('\n');
  }

  NS.Tune = { isPoseLog, parsePoseLog, segments, compare, fitDrive, report, poseAt, indexAt, velocities };

  // ------------------------------------------------------------------ UI (browser only)

  if (typeof document === 'undefined') return;

  let host = null; // callbacks from app.js
  const say = (text) => {
    host.$('botMsg').textContent = text;
  };
  let runs = [];
  let selected = -1;

  function init(h) {
    host = h;
    const $ = h.$;
    $('btnBotPaste').addEventListener('click', () => {
      const text = $('botPaste').value;
      if (!text.trim()) return;
      addText(text, 'pasted');
      $('botPaste').value = '';
    });
    $('btnBotFit').addEventListener('click', applyFit);
    $('btnBotCopy').addEventListener('click', () => {
      const md = currentReport();
      if (!md) return;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(md).then(
          () => say('Report copied. Paste it to Claude (the waypoint-tune skill knows what to do with it).'),
          () => download(md)
        );
      } else download(md);
    });
    $('btnBotSave').addEventListener('click', () => {
      const md = currentReport();
      if (md) download(md);
    });
    render();
  }

  function addText(text, name) {
    const res = parsePoseLog(text, name);
    res.warnings.forEach((w) => host.log('warn', w));
    if (!res.runs.length) {
      host.log('warn', `${name}: no pose log found (looking for #POSELOG BEGIN or a t_ms,x,y,theta header)`);
      return 0;
    }
    res.runs.forEach((r) => {
      r.visible = true;
      r.color = NS.theme.series(runs.length + 1);
      runs.push(r);
    });
    selected = runs.length - 1;
    host.log('info', `${name}: ${res.runs.length} run${res.runs.length > 1 ? 's' : ''} loaded into Real runs`);
    host.durationChanged();
    render();
    host.requestDraw();
    return res.runs.length;
  }

  function sel() {
    return selected >= 0 ? runs[selected] : null;
  }

  function maxDuration() {
    return runs.reduce((m, r) => (r.visible ? Math.max(m, r.duration) : m), 0);
  }

  function analysis(run) {
    const res = host.result();
    const segs = segments(run);
    const cmp = res && res.frames ? compare(run, res.frames, res.motions) : null;
    const fit = fitDrive(run, host.settings().robot);
    return { segs, cmp, fit, res };
  }

  function currentReport() {
    const run = sel();
    if (!run) return null;
    const a = analysis(run);
    return report(run, a.segs, a.cmp, a.fit, { settings: host.settings(), code: host.code(), routine: host.routine(), frames: a.res && a.res.frames });
  }

  function download(md) {
    const run = sel();
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tune-${(run ? run.name : 'run').replace(/[^\w.-]+/g, '_')}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function applyFit() {
    const run = sel();
    if (!run) return;
    const fit = fitDrive(run, host.settings().robot);
    if (!fit.ok) {
      say(`Can't fit the sim to this run: ${fit.why}`);
      return;
    }
    const pct = Math.round(Math.min(100, Math.max(5, fit.speedPct)));
    const ms = Math.round(Math.min(400, Math.max(1, fit.responseMs)));
    const modelOff = host.applyRobot({ speedPct: pct, responseMs: ms });
    say(
      `Sim fitted to ${run.name}: real-life speed ${pct}%, motor response ${ms} ms.` +
        (fit.trackWidth ? ` It turns like a ${fit.trackWidth.toFixed(1)} in track width.` : '') +
        (modelOff ? ' "Work out the real-life speed" is now off so the measured numbers stay (Robot tab).' : '') +
        (fit.speedPct > 105 ? ` The fitted speed is ${fit.speedPct.toFixed(0)}% of what the wheel size and rpm allow, so check those in Drivetrain.` : '')
    );
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function render() {
    const $ = host.$;
    $('botCount').textContent = runs.length ? `${runs.length} run${runs.length > 1 ? 's' : ''}` : '';
    const ul = $('botRuns');
    ul.innerHTML = '';
    runs.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = 'path' + (i === selected ? ' sel' : '');
      li.innerHTML = `
        <span class="sw" style="background:${r.color}"></span>
        <span class="nm"><b title="${esc(r.name)}">${esc(r.name)}</b>
          <span class="meta">${esc(r.label)} &middot; ${(r.duration / 1000).toFixed(1)} s${r.meta.battery_pct != null ? ` &middot; ${r.meta.battery_pct}% battery` : ''}${r.cut ? ' &middot; cut off' : ''}</span></span>
        <input type="checkbox" ${r.visible ? 'checked' : ''} title="Show on field" aria-label="Show ${esc(r.name)} on the field">
        <button class="x" type="button" title="Remove" aria-label="Remove ${esc(r.name)}">&times;</button>`;
      li.querySelector('.nm').addEventListener('click', () => {
        selected = i;
        render();
        host.requestDraw();
      });
      li.querySelector('input').addEventListener('change', (e) => {
        r.visible = e.target.checked;
        host.durationChanged();
        host.requestDraw();
      });
      li.querySelector('.x').addEventListener('click', () => {
        runs.splice(i, 1);
        if (selected >= runs.length) selected = runs.length - 1;
        host.durationChanged();
        render();
        host.requestDraw();
      });
      ul.appendChild(li);
    });
    renderStats();
  }

  function renderStats() {
    const $ = host.$;
    const run = sel();
    const tbl = $('botStats');
    $('botActions').hidden = !run;
    if (!run) {
      tbl.innerHTML = '';
      return;
    }
    const a = analysis(run);
    const rows = [];
    if (a.cmp) {
      rows.push(['vs sim', `avg ${f1(a.cmp.meanErr)} in off, max ${f1(a.cmp.maxErr)} in at ${s2(a.cmp.maxAt)} s`]);
      rows.push(['end', `${f1(a.cmp.endErr)} in, ${f1(a.cmp.endHerr)}° from the sim`]);
      rows.push(['time', `real ${s2(a.cmp.realMs)} s, sim ${s2(a.cmp.simMs)} s`]);
    }
    const drives = a.segs.filter((s) => s.kind === 'drive' && s.dist > 3);
    const turns = a.segs.filter((s) => s.kind === 'turn');
    if (drives.length) rows.push(['drives', `${drives.length}, worst overshoot ${f2(Math.max(...drives.map((s) => s.overshoot)))} in`]);
    if (turns.length) rows.push(['turns', `${turns.length}, worst overshoot ${f1(Math.max(...turns.map((s) => s.overshoot)))}°`]);
    rows.push(['fit', a.fit.ok ? `${f1(a.fit.speedPct)}% speed, ${Math.round(a.fit.responseMs)} ms response` : esc(a.fit.why)]);
    tbl.innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  }

  /** field overlay: every visible run as a line, the selected one also as a robot at time t */
  function drawState(t, codeToField, startH) {
    if (!runs.length) return null;
    return runs
      .filter((r) => r.visible)
      .map((r) => {
        const pts = [];
        const step = Math.max(1, Math.floor(r.t.length / 1500));
        for (let i = 0; i < r.t.length; i += step) pts.push(codeToField(r.x[i], r.y[i]));
        const out = { color: r.color, points: pts, selected: r === sel() };
        if (out.selected) {
          const p = poseAt(r, Math.min(t, r.duration));
          const f = codeToField(p.x, p.y);
          out.pose = { x: f.x, y: f.y, h: (startH || 0) + p.h };
        }
        return out;
      });
  }

  Object.assign(NS.Tune, { init, addText, drawState, maxDuration, refresh: renderStats });
})();
