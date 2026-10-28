/*
 * Auto-tuning the motion timeouts.
 *
 * Runs the auton with generous timeouts to see how long every motion really takes, then picks a timeout
 * for each call in the code: the measured time plus a safety margin. A motion that runs into a wall or
 * a goal and can never reach its target gets a timeout a little after it hit (or after an aligner caught
 * the goal), so it has time to square up but does not push in for long. The tuned numbers are put back into
 * a copy of the code. It runs the result again to check, because shorter timeouts change what happens next.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  const DEFAULTS = {
    pct: 20, // safety margin on a motion's measured time, %
    extraMs: 150, // plus this much, ms
    alignMs: 400, // after hitting a wall / goal it cannot get past, wait this long for it to square up, ms
    alignedMarginMs: 200, // or this long after an aligner has caught the goal, ms
    minMs: 200, // never below this
    stepMs: 50, // timeouts are rounded up to a multiple of this
    probeMs: 8000, // the timeout every motion gets while measuring
    rounds: 4, // most checking runs
  };

  const roundUp = (ms, step) => Math.ceil(ms / step) * step;

  /**
   * One run's motions -> a timeout for every call site that ran.
   * @param {Array} motions  res.motions of a run (each has site, t0, t1, reason, firstContact, alignedAt)
   * @returns {Map<number, {ms:number|null, why:string, kind:string, runs:number, minMs:number, maxMs:number}>}
   */
  function computeTimeouts(motions, o) {
    const out = new Map();
    motions.forEach((m) => {
      if (m.site == null || m.t1 == null) return;
      const dur = m.t1 - m.t0;
      let ms = null;
      let kind;
      let why;
      if (m.reason === 'timeout') {
        if (m.alignedAt != null) {
          ms = m.alignedAt - m.t0 + o.alignedMarginMs;
          kind = 'aligned';
          why = `an aligner caught the goal after ${m.alignedAt - m.t0} ms`;
        } else if (m.firstContact != null) {
          ms = m.firstContact - m.t0 + o.alignMs;
          kind = 'blocked';
          why = `hit a wall or goal after ${m.firstContact - m.t0} ms and could not get further`;
        } else {
          kind = 'unfinished';
          why = 'never finished and did not hit anything: left as it is';
        }
      } else if (m.reason === 'cancelled') {
        kind = 'cancelled';
        why = 'ended by cancelMotion() in the code: left as it is';
      } else {
        ms = dur * (1 + o.pct / 100) + o.extraMs;
        kind = 'finished';
        why = `finished by itself in ${dur} ms`;
      }
      if (ms != null) ms = Math.max(o.minMs, roundUp(ms, o.stepMs));
      const prev = out.get(m.site);
      const e = prev || { ms: null, why, kind, runs: 0, minMs: dur, maxMs: dur };
      e.runs++;
      e.minMs = Math.min(e.minMs, dur);
      e.maxMs = Math.max(e.maxMs, dur);
      // a call that runs more than once (a loop, a helper) gets the longest of its timeouts
      if (ms != null && (e.ms == null || ms > e.ms)) {
        e.ms = ms;
        e.why = why;
        e.kind = kind;
      } else if (e.ms == null && !prev) {
        e.why = why;
        e.kind = kind;
      }
      out.set(m.site, e);
    });
    return out;
  }

  /**
   * @param {object} a
   *   simulate(extra) -> Promise<result of runSimulation>, run with `extra` merged in (siteTimeouts / timeoutOverride)
   *   sites           the call sites from compileAuton(..., {markSites: true})
   *   options          overrides of DEFAULTS
   * @returns {{rows, tuned, probe, final, options}}
   */
  async function autoTune(a) {
    const o = { ...DEFAULTS, ...(a.options || {}) };
    const probe = await a.simulate({ timeoutOverride: o.probeMs });
    let info = computeTimeouts(probe.motions, o);
    const tuned = {};
    info.forEach((e, id) => {
      if (e.ms != null) tuned[id] = e.ms;
    });
    let final = probe;
    // tighter timeouts change what happens next, so run again with them and raise any that turn out too short
    for (let round = 0; round < o.rounds; round++) {
      const verify = await a.simulate({ siteTimeouts: tuned });
      final = verify;
      const again = computeTimeouts(verify.motions, o);
      let changed = false;
      again.forEach((e, id) => {
        if (e.ms != null && (tuned[id] == null || e.ms > tuned[id])) {
          tuned[id] = e.ms;
          changed = true;
        }
        const old = info.get(id);
        if (!old) info.set(id, e);
        else if (e.maxMs > old.maxMs) old.maxMs = e.maxMs;
      });
      if (!changed) break;
    }
    const rows = a.sites.map((s) => {
      const e = info.get(s.id);
      const old = s.timeout ? s.timeout.value : null;
      return {
        id: s.id,
        method: s.method,
        line: s.line,
        oldText: s.timeout ? s.timeout.text : '?',
        old,
        ms: tuned[s.id] == null ? null : tuned[s.id],
        kind: e ? e.kind : 'notrun',
        why: e ? e.why : 'this call never ran',
        minMs: e ? e.minMs : null,
        maxMs: e ? e.maxMs : null,
        runs: e ? e.runs : 0,
        editable: !!(s.timeout && s.timeout.value != null),
      };
    });
    return { rows, tuned, probe, final, options: o };
  }

  /**
   * autoTune over several random draws of the real-life error (a motion takes a little different time every
   * run): each call gets the longest timeout any draw needed.
   * @param {object} a  like autoTune, but simulate(seed) returns the simulate(extra) function for that draw;
   *                    `seeds` lists the draws
   */
  async function autoTuneMany(a) {
    const runs = [];
    for (const seed of a.seeds) {
      runs.push(await autoTune({ simulate: a.simulate(seed), sites: a.sites, options: a.options }));
      if (a.onProgress) a.onProgress(runs.length, a.seeds.length);
    }
    const first = runs[0];
    const tuned = {};
    const rows = first.rows.map((row, i) => {
      const merged = { ...row };
      runs.forEach((r) => {
        const x = r.rows[i];
        if (x.ms != null && (merged.ms == null || x.ms > merged.ms)) {
          merged.ms = x.ms;
          merged.kind = x.kind;
          merged.why = x.why;
        }
        if (x.minMs != null) merged.minMs = merged.minMs == null ? x.minMs : Math.min(merged.minMs, x.minMs);
        if (x.maxMs != null && x.kind !== 'blocked' && x.kind !== 'aligned') merged.maxMs = merged.maxMs == null ? x.maxMs : Math.max(merged.maxMs, x.maxMs);
        if (x !== row) merged.runs += x.runs;
      });
      if (merged.ms != null) tuned[merged.id] = merged.ms;
      return merged;
    });
    return { rows, tuned, probe: first.probe, final: first.final, options: first.options, draws: runs.length };
  }

  /** the code with the tuned numbers in place of the timeouts it had (only plain numbers can be replaced) */
  function rewriteCode(code, sites, tuned) {
    const edits = [];
    sites.forEach((s) => {
      const ms = tuned[s.id];
      if (ms == null || !s.timeout || s.timeout.value == null) return;
      edits.push({ start: s.timeout.start, end: s.timeout.end, text: String(ms) });
    });
    edits.sort((x, y) => y.start - x.start);
    let out = code;
    edits.forEach((e) => (out = out.slice(0, e.start) + e.text + out.slice(e.end)));
    return out;
  }

  Object.assign(NS, { autoTune, autoTuneMany, computeTimeouts, rewriteTimeouts: rewriteCode, AUTOTUNE_DEFAULTS: DEFAULTS });
})();
