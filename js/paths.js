/*
 * Path file loading (path.jerryio).
 *
 * Supported inputs
 *   1. LemLib text export  - lines of `x, y, speed`, then `endData`, then
 *      optionally a `#PATH.JERRYIO-DATA {json}` line. Exact points + speeds.
 *   2. .jerryio project JSON - control points are sampled as Bezier curves
 *      here, and the speed profile is *approximated* (export the LemLib .txt
 *      from jerry.io when you need the exact speeds).
 *
 * Coordinates are taken as jerry.io field coordinates: origin at the centre of
 * the field, +Y up, inches (unless the file says cm / mm / m).
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  const UNIT_TO_IN = { in: 1, cm: 1 / 2.54, mm: 1 / 25.4, m: 39.3701, ft: 12 };

  function num(v, d) {
    if (v == null) return d;
    if (typeof v === 'number') return isFinite(v) ? v : d;
    if (typeof v === 'object') return num(v.value, d);
    const n = parseFloat(v);
    return isNaN(n) ? d : n;
  }

  function idFromName(name) {
    let id = String(name).replace(/[^A-Za-z0-9]/g, '_');
    if (/^[0-9]/.test(id)) id = '_' + id;
    return id || '_path';
  }

  function detectUnit(formatText) {
    const f = String(formatText || '').toLowerCase();
    if (/\(\s*cm\s*\)|centi/.test(f)) return 'cm';
    if (/\(\s*mm\s*\)|milli/.test(f)) return 'mm';
    if (/\(\s*m\s*\)|\bmeter/.test(f)) return 'm';
    return 'in';
  }

  // ---------------------------------------------------------------- LemLib txt

  function parseLemlibText(text) {
    const pts = [];
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (/^endData/i.test(line)) break;
      if (line[0] === '#') continue;
      const parts = line.split(/[\s,;]+/).filter(Boolean).map(Number);
      if (parts.length >= 2 && parts.every((n) => isFinite(n))) {
        pts.push({ x: parts[0], y: parts[1], v: parts.length >= 3 ? parts[2] : 100 });
      }
    }
    return pts;
  }

  function extractEmbeddedJson(text) {
    const i = text.indexOf('#PATH.JERRYIO-DATA');
    if (i < 0) return null;
    const rest = text.slice(i + '#PATH.JERRYIO-DATA'.length).trim();
    try {
      return JSON.parse(rest);
    } catch (e) {
      const nl = rest.indexOf('\n');
      try {
        return JSON.parse(nl < 0 ? rest : rest.slice(0, nl));
      } catch (e2) {
        return null;
      }
    }
  }

  // ---------------------------------------------------------------- .jerryio JSON

  function bezierPoint(ctrl, t) {
    let pts = ctrl.map((c) => ({ x: c.x, y: c.y }));
    while (pts.length > 1) {
      const next = [];
      for (let i = 0; i < pts.length - 1; i++) {
        next.push({ x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t });
      }
      pts = next;
    }
    return pts[0];
  }

  function sampleSegments(segments, spacing) {
    // dense polyline first
    const dense = [];
    segments.forEach((seg) => {
      const ctrl = (seg.controls || []).map((c) => ({ x: num(c.x, 0), y: num(c.y, 0) }));
      if (ctrl.length < 2) return;
      const steps = 240;
      for (let i = 0; i <= steps; i++) {
        if (i === 0 && dense.length) continue; // shared end point with previous segment
        dense.push(bezierPoint(ctrl, i / steps));
      }
    });
    if (dense.length < 2) return dense;
    // resample at even arc length
    const out = [{ x: dense[0].x, y: dense[0].y }];
    let carry = 0;
    for (let i = 1; i < dense.length; i++) {
      let a = dense[i - 1];
      const b = dense[i];
      let d = Math.hypot(b.x - a.x, b.y - a.y);
      while (carry + d >= spacing && d > 0) {
        const t = (spacing - carry) / d;
        a = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        out.push({ x: a.x, y: a.y });
        d = Math.hypot(b.x - a.x, b.y - a.y);
        carry = 0;
      }
      carry += d;
    }
    const last = dense[dense.length - 1];
    const tail = out[out.length - 1];
    if (Math.hypot(last.x - tail.x, last.y - tail.y) > 1e-6) out.push({ x: last.x, y: last.y });
    return out;
  }

  function approximateSpeeds(points, pc, unitScale) {
    const sl = pc && pc.speedLimit;
    let min = 20;
    let top = 100;
    if (sl != null && typeof sl === 'object') {
      min = num(sl.minLimit != null ? sl.minLimit : sl.from != null ? sl.from : sl.min, 20);
      top = num(sl.topLimit != null ? sl.topLimit : sl.to != null ? sl.to : sl.maxLimit != null ? sl.maxLimit : sl.max, 100);
    } else if (sl != null) top = num(sl, 100);
    top = Math.min(127, Math.max(1, top));
    min = Math.min(top, Math.max(1, min));
    const bent = num(pc && pc.bentRate, 0.1);

    const n = points.length;
    const v = new Array(n).fill(top);
    for (let i = 1; i < n - 1; i++) {
      const a = points[i - 1];
      const b = points[i];
      const c = points[i + 1];
      const ab = Math.hypot(b.x - a.x, b.y - a.y) * unitScale;
      const bc = Math.hypot(c.x - b.x, c.y - b.y) * unitScale;
      const ac = Math.hypot(c.x - a.x, c.y - a.y) * unitScale;
      const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * unitScale * unitScale;
      const kappa = ab * bc * ac > 1e-9 ? (2 * area2) / (ab * bc * ac) : 0; // 1/inch
      v[i] = Math.max(min, top / (1 + bent * 100 * kappa));
    }
    if (n > 1) v[0] = v[1];
    // slow down over the last 24 inches
    let remaining = 0;
    for (let i = n - 1; i >= 0; i--) {
      if (i < n - 1) {
        const p = points[i];
        const q = points[i + 1];
        remaining += Math.hypot(q.x - p.x, q.y - p.y) * unitScale;
      }
      if (remaining < 24) v[i] = Math.min(v[i], min + ((top - min) * remaining) / 24);
    }
    return points.map((p, i) => ({ x: p.x, y: p.y, v: v[i] }));
  }

  function pathsFromJson(data, fileId, fileName, unit, warnings) {
    const out = [];
    const gc = data.gc || {};
    const spacing = Math.max(0.25, num(gc.pointDensity, 2));
    const list = Array.isArray(data.paths) ? data.paths : [];
    list.forEach((p, idx) => {
      const pts = sampleSegments(p.segments || [], spacing);
      if (pts.length < 2) {
        warnings.push(`${fileName}: path "${p.name || idx + 1}" has fewer than 2 points, skipped`);
        return;
      }
      const scale = UNIT_TO_IN[unit] || 1;
      const withSpeed = approximateSpeeds(pts, p.pc, scale);
      out.push({
        id: idx === 0 ? fileId : `${fileId}_${idx + 1}`,
        aliases: p.name ? [idFromName(p.name)] : [],
        name: list.length > 1 ? `${fileName} / ${p.name || idx + 1}` : fileName,
        source: 'jerryio-json',
        unit,
        approximate: true,
        points: withSpeed,
      });
    });
    return out;
  }

  // ---------------------------------------------------------------- entry points

  /**
   * @returns {{paths: object[], warnings: string[]}}
   */
  function parsePathFile(fileName, text) {
    const warnings = [];
    const base = fileName.replace(/\.[^.]*$/, '');
    const ext = (fileName.match(/\.([^.]*)$/) || [, ''])[1].toLowerCase();
    const fileId = idFromName(fileName);
    const baseId = idFromName(base);
    const trimmed = text.trim();

    let json = null;
    if (trimmed[0] === '{') {
      try {
        json = JSON.parse(trimmed);
      } catch (e) {
        warnings.push(`${fileName}: looks like JSON but could not be parsed (${e.message})`);
      }
    } else {
      json = extractEmbeddedJson(text);
    }

    const unit = detectUnit(json && json.format);
    let paths = [];

    if (trimmed[0] !== '{') {
      const pts = parseLemlibText(text);
      if (pts.length >= 2) {
        paths.push({
          id: fileId,
          aliases: baseId !== fileId ? [baseId] : [],
          name: fileName,
          source: 'lemlib-txt',
          unit,
          approximate: false,
          points: pts,
        });
      }
    }
    if (!paths.length && json && Array.isArray(json.paths)) {
      paths = pathsFromJson(json, fileId, fileName, unit, warnings);
      paths.forEach((p) => {
        if (baseId !== p.id && !p.aliases.includes(baseId) && p.id === fileId) p.aliases.push(baseId);
      });
    }
    if (!paths.length) warnings.push(`${fileName}: no path points found (is this a jerry.io LemLib export?)`);

    paths.forEach((p) => (p.file = fileName));

    // v0.4-style files store wheel rpm instead of 0..127 speeds: normalise
    paths.forEach((p) => {
      const max = Math.max(...p.points.map((q) => q.v));
      if (max > 127.5) {
        warnings.push(`${fileName}: speeds go up to ${Math.round(max)} (> 127), scaled to 0..127`);
        p.points = p.points.map((q) => ({ x: q.x, y: q.y, v: (q.v / max) * 127 }));
      }
    });
    return { paths, warnings, ext };
  }

  /** points converted to inches */
  function pointsInInches(path, unitOverride) {
    const s = UNIT_TO_IN[unitOverride || path.unit] || 1;
    return path.points.map((p) => ({ x: p.x * s, y: p.y * s, v: p.v }));
  }

  Object.assign(NS, { parsePathFile, pointsInInches, idFromName, UNIT_TO_IN });
})();
