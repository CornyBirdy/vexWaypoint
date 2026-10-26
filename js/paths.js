/*
 * Path file loading (path.jerryio).
 *
 * Understood inputs (all written independently from the published file layouts):
 *
 *  - LemLib v0.4 text export   x, y, speed  lines (inches, speed 0..127) + ghost point,
 *                              `endData`, decel rate, max speed, `200`, bezier segments,
 *                              `#PATH.JERRYIO-DATA {json}`
 *  - LemLib Tarball v0.5 text  the same, one `#PATH-POINTS-START name` block per path
 *                              (speed 0..255)
 *  - path.jerryio v0.1 text    `#PATH-POINTS-START name` blocks of `x,y,speed[,heading]` (cm, rpm)
 *  - LemLib v1.0 binary        waypoints in mm and m/s
 *  - .jerryio project JSON     bezier control points; points and speeds are recomputed here
 *
 * Coordinates are jerry.io field coordinates (VEX GPS: origin at field centre,
 * +X east, +Y north) unless the file says it uses another coordinate system.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  const UNIT_TO_IN = { in: 1, cm: 1 / 2.54, mm: 1 / 25.4, m: 39.3701, ft: 12, tile: 24 };
  // jerry.io stores the unit of length as "centimetres per unit"
  const UOL = [[0.1, 'mm'], [1, 'cm'], [2.54, 'in'], [30.48, 'ft'], [60.96, 'tile'], [100, 'm']];

  const GHOST_DISTANCE_IN = 20;

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

  function unitFromUol(m) {
    let best = 'cm';
    let err = Infinity;
    UOL.forEach(([v, u]) => {
      const e = Math.abs(v - m);
      if (e < err) {
        err = e;
        best = u;
      }
    });
    return best;
  }

  /** what a given jerry.io format writes into the file */
  function formatInfo(formatName, hasEndData) {
    const f = String(formatName || '');
    if (/tarball/i.test(f)) return { kind: 'tarball', unit: 'in', speedUnit: 'cmd255', ghost: true };
    if (/v1\.0/i.test(f)) return { kind: 'lemlib1', unit: 'mm', speedUnit: 'mps', ghost: false };
    if (/path\.jerryio/i.test(f)) return { kind: 'pdj', unit: 'cm', speedUnit: 'rpm', ghost: false };
    if (/lemlib/i.test(f) || hasEndData) return { kind: 'lemlib04', unit: 'in', speedUnit: 'cmd127', ghost: true };
    return { kind: 'pdj', unit: 'cm', speedUnit: 'rpm', ghost: false };
  }

  // ---------------------------------------------------------------- text files

  function embeddedJson(text) {
    const marker = '#PATH.JERRYIO-DATA';
    const i = text.indexOf(marker);
    if (i < 0) return null;
    const rest = text.slice(i + marker.length).trim();
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

  function parseTextBlocks(text) {
    const blocks = [];
    let cur = null;
    const open = (name, marker) => {
      cur = { name, pts: [], endData: false, marker: !!marker };
      blocks.push(cur);
    };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#PATH.JERRYIO-DATA')) break;
      if (line.startsWith('#PATH-POINTS-START')) {
        open(line.slice('#PATH-POINTS-START'.length).trim() || 'Path', true);
        continue;
      }
      if (line[0] === '#') continue;
      if (!cur) open(null);
      if (/^endData/i.test(line)) {
        cur.endData = true;
        continue;
      }
      if (cur.endData) continue; // decel rate, max speed, bezier segment lines...
      const parts = line.split(/\s*,\s*|\s+/).map(Number);
      if (parts.length >= 2 && parts.every((n) => isFinite(n))) {
        cur.pts.push({ x: parts[0], y: parts[1], v: parts.length >= 3 ? parts[2] : 100 });
      }
    }
    return blocks.filter((b) => b.pts.length >= 2);
  }

  function pathsFromText(fileName, text, json, warnings) {
    const base = idFromName(fileName.replace(/\.[^.]*$/, ''));
    const fileId = idFromName(fileName);
    const blocks = parseTextBlocks(text);
    const out = [];
    blocks.forEach((b, i) => {
      // a bare list of points with no format information is read as a LemLib text path (inches, 0..127)
      const info =
        json && json.format
          ? formatInfo(json.format, b.endData)
          : b.marker && !b.endData
            ? formatInfo('path.jerryio', false)
            : { kind: 'lemlib04', unit: 'in', speedUnit: 'cmd127', ghost: b.endData };
      const ghost = b.endData && info.ghost;
      const n = b.pts.length;
      const named = b.name ? idFromName(b.name) : null;
      const ids = [];
      if (blocks.length === 1) {
        ids.push(fileId);
        if (base !== fileId) ids.push(base);
        if (named) ids.push(named);
      } else {
        if (named) ids.push(named);
        ids.push(`${fileId}_${i + 1}`);
        if (i === 0) ids.push(fileId);
      }
      out.push({
        id: ids[0],
        aliases: ids.slice(1),
        name: blocks.length > 1 ? `${fileName} / ${b.name || i + 1}` : fileName,
        source: 'text',
        unit: info.unit,
        speedUnit: info.speedUnit,
        ghost,
        endIdx: ghost ? Math.max(1, n - 2) : n - 1,
        points: b.pts,
      });
    });
    return out;
  }

  // ---------------------------------------------------------------- LemLib v1.0 binary

  function parseLemlib1(bytes, fileName, warnings) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 0;
    const u8 = () => dv.getUint8(off++);
    const i16 = () => {
      const v = dv.getInt16(off, true);
      off += 2;
      return v;
    };
    const u16 = () => {
      const v = dv.getUint16(off, true);
      off += 2;
      return v;
    };
    const cstr = () => {
      let s = '';
      while (off < bytes.length && bytes[off] !== 0) s += String.fromCharCode(bytes[off++]);
      off++;
      return s;
    };

    const metaSize = u8();
    const bodySize = dv.getUint32(off, true);
    off = 1 + metaSize;
    const count = u16();
    const fileId = idFromName(fileName);
    const base = idFromName(fileName.replace(/\.[^.]*$/, ''));
    const out = [];
    for (let p = 0; p < count; p++) {
      const name = cstr();
      const skip = dv.getInt8(off++);
      if (skip > 0) off += skip;
      const n = u16();
      const pts = [];
      for (let i = 0; i < n; i++) {
        const flag = u8();
        const x = i16() / 2;
        const y = i16() / 2;
        const v = i16() / 1000;
        if (flag & 0x01) u16(); // heading
        if (flag & 0x02) i16(); // lookahead
        for (let b = 0x04; b <= 0x80; b <<= 1) if (flag & b) i16(); // reserved
        pts.push({ x, y, v });
      }
      if (pts.length < 2) {
        warnings.push(`${fileName}: path "${name}" has fewer than 2 points, skipped`);
        continue;
      }
      const named = idFromName(name || `path${p + 1}`);
      const ids = count === 1 ? [fileId, base, named] : [named, `${fileId}_${p + 1}`].concat(p === 0 ? [fileId] : []);
      out.push({
        id: ids[0],
        aliases: ids.slice(1).filter((s, i, a) => s !== ids[0] && a.indexOf(s) === i),
        name: count > 1 ? `${fileName} / ${name || p + 1}` : fileName,
        source: 'lemlib-1.0',
        unit: 'mm',
        speedUnit: 'mps',
        ghost: false,
        endIdx: pts.length - 1,
        points: pts,
      });
    }
    let json = null;
    off = bodySize;
    if (off < bytes.length) {
      const sig = cstr();
      if (sig === '#PATH.JERRYIO-DATA') {
        try {
          json = JSON.parse(new TextDecoder().decode(bytes.subarray(off)));
        } catch (e) {
          /* the waypoints are all that is needed */
        }
      }
    }
    return { paths: out, json };
  }

  // ---------------------------------------------------------------- .jerryio JSON

  function sampleBezierSegments(segments) {
    // dense samples with arc length and curvature, per segment
    const segs = [];
    segments.forEach((seg) => {
      const c = (seg.controls || []).map((q) => ({ x: num(q.x, 0), y: num(q.y, 0) }));
      if (c.length !== 2 && c.length !== 4) return;
      const dense = [];
      const N = 400;
      let len = 0;
      let prev = null;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        let x;
        let y;
        let k = 0;
        if (c.length === 2) {
          x = c[0].x + (c[1].x - c[0].x) * t;
          y = c[0].y + (c[1].y - c[0].y) * t;
        } else {
          const u = 1 - t;
          x = u * u * u * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t * t * t * c[3].x;
          y = u * u * u * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t * t * t * c[3].y;
          const dx = 3 * (u * u * (c[1].x - c[0].x) + 2 * u * t * (c[2].x - c[1].x) + t * t * (c[3].x - c[2].x));
          const dy = 3 * (u * u * (c[1].y - c[0].y) + 2 * u * t * (c[2].y - c[1].y) + t * t * (c[3].y - c[2].y));
          const ddx = 6 * (u * (c[2].x - 2 * c[1].x + c[0].x) + t * (c[3].x - 2 * c[2].x + c[1].x));
          const ddy = 6 * (u * (c[2].y - 2 * c[1].y + c[0].y) + t * (c[3].y - 2 * c[2].y + c[1].y));
          const sp = Math.pow(dx * dx + dy * dy, 1.5);
          k = sp > 1e-12 ? Math.abs(dx * ddy - dy * ddx) / sp : 0;
        }
        if (prev) len += Math.hypot(x - prev.x, y - prev.y);
        dense.push({ x, y, k, s: len });
        prev = { x, y };
      }
      segs.push({ dense, len, keyframes: Array.isArray(seg.speedProfiles) ? seg.speedProfiles : [] });
    });
    return segs;
  }

  function jsonPathPoints(p, gc, info) {
    const uol = num(gc.uol, 1);
    const density = Math.max(0.05, num(gc.pointDensity, 2));
    const toInch = uol / 2.54;
    const segs = sampleBezierSegments(p.segments || []);
    if (!segs.length) return null;
    const total = segs.reduce((a, s) => a + s.len, 0);
    if (total < 1e-9) return null;

    // cumulative start of each segment
    const starts = [];
    segs.reduce((a, s) => (starts.push(a), a + s.len), 0);
    const locate = (s) => {
      let k = segs.length - 1;
      for (let i = 0; i < segs.length; i++) {
        if (s < starts[i] + segs[i].len || i === segs.length - 1) {
          k = i;
          break;
        }
      }
      const seg = segs[k];
      const ls = Math.min(seg.len, Math.max(0, s - starts[k]));
      let lo = 0;
      let hi = seg.dense.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (seg.dense[mid].s <= ls) lo = mid;
        else hi = mid;
      }
      const a = seg.dense[lo];
      const b = seg.dense[hi];
      const r = b.s - a.s > 1e-12 ? (ls - a.s) / (b.s - a.s) : 0;
      return { seg: k, x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r, k: a.k + (b.k - a.k) * r };
    };

    // uniform points; the end of the path is always included, then repeated once (as jerry.io does)
    const pts = [];
    for (let s = 0; s < total - 1e-9; s += density) pts.push({ s, ...locate(s) });
    pts.push({ s: total, ...locate(total) });
    const uniformCount = pts.length;
    pts.forEach((q) => (q.bent = q.k / uol)); // curvature per cm

    // speed settings
    const pc = p.pc || {};
    const sl = pc.speedLimit || {};
    const lFrom = num(sl.from, 20);
    const lTo = num(sl.to, 100);
    const br = pc.bentRateApplicableRange || {};
    const bFrom = num(br.from, 0);
    const bTo = num(br.to, 0.1);
    const decel = num(pc.maxDecelerationRate, 127);
    const limitDiff = lTo - lFrom;
    const appDiff = bTo - bFrom;
    const useRatio = limitDiff !== 0 && appDiff !== 0;
    const ratio = useRatio ? limitDiff / appDiff : 0;

    // speed keyframes: a default one at the start follows the bend rate (LemLib formats)
    const kfs = [{ idx: 0, y: 1, bent: true }];
    const segRanges = segs.map((s, i) => {
      const from = pts.findIndex((q) => q.seg === i);
      let to = pts.length;
      for (let j = pts.length - 1; j >= 0; j--) if (pts[j].seg === i) { to = j + 1; break; }
      return { from, to };
    });
    segs.forEach((s, i) => {
      const r = segRanges[i];
      if (r.from < 0) return;
      (s.keyframes || []).forEach((kf) => {
        kfs.push({ idx: r.from + Math.floor((r.to - r.from) * num(kf.xPos, 0)), y: num(kf.yPos, 1), bent: !!kf.followBentRate });
      });
    });
    kfs.sort((a, b) => a.idx - b.idx);
    for (let i = 0; i < kfs.length; i++) {
      const cur = kfs[i];
      const next = kfs[i + 1];
      const from = cur.idx;
      const to = next ? next.idx : uniformCount;
      const len = Math.max(1, to - from);
      const yTo = next ? next.y : cur.y;
      for (let j = from; j < to && j < uniformCount; j++) {
        const y = cur.y + ((yTo - cur.y) * (j - from)) / len;
        let v = lFrom + limitDiff * y;
        if (cur.bent) {
          const b = pts[j].bent;
          if (b < bFrom) v = Math.min(v, lTo);
          else if (b > bTo) v = Math.min(v, lFrom);
          else if (useRatio) v = Math.min(v, lTo - (b - bFrom) * ratio);
        }
        pts[j].v = v;
      }
    }
    // the path end is a duplicate point, as in the exported files
    const last = pts[pts.length - 1];
    pts.push({ ...last, v: 0 });

    // never go faster than the robot could stop from: stop at the end, limit by deceleration
    pts[pts.length - 2].v = 0;
    for (let i = pts.length - 3; i >= 0; i--) {
      const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) * toInch;
      const allowed = Math.sqrt(pts[i + 1].v * pts[i + 1].v + 2 * decel * d);
      pts[i].v = Math.max(Math.min(pts[i].v, allowed), lFrom);
    }
    return pts;
  }

  /** points of an editable path ({x, y, v, seg, s}) - used by the path editor and by project import */
  function computePathPoints(p, gc) {
    return jsonPathPoints(p, gc || {}, null);
  }

  function pathsFromJson(json, fileName, warnings) {
    const gc = json.gc || {};
    const info = formatInfo(json.format, false);
    // the editor keeps control points in the unit of length chosen in the general settings
    const unit = unitFromUol(num(gc.uol, 1));
    const list = Array.isArray(json.paths) ? json.paths : [];
    const fileId = idFromName(fileName);
    const base = idFromName(fileName.replace(/\.[^.]*$/, ''));
    const out = [];
    list.forEach((p, idx) => {
      const full = jsonPathPoints(p, gc, info);
      const pts = full && full.map((q) => ({ x: q.x, y: q.y, v: q.v }));
      if (!pts || pts.length < 3) {
        warnings.push(`${fileName}: path "${p.name || idx + 1}" has no usable segments, skipped`);
        return;
      }
      const named = p.name ? idFromName(p.name) : null;
      const ids = [];
      if (list.length === 1) ids.push(fileId, base);
      else {
        if (named) ids.push(named);
        ids.push(`${fileId}_${idx + 1}`);
        if (idx === 0) ids.push(fileId);
      }
      if (named) ids.push(named);
      const uniq = ids.filter((s, i, a) => a.indexOf(s) === i);
      out.push({
        id: uniq[0],
        aliases: uniq.slice(1),
        name: list.length > 1 ? `${fileName} / ${p.name || idx + 1}` : fileName,
        source: 'jerryio-project',
        unit,
        speedUnit: info.speedUnit,
        ghost: false,
        endIdx: pts.length - 1,
        recomputed: true,
        points: pts,
      });
    });
    return out;
  }

  // ---------------------------------------------------------------- entry point

  function looksBinary(bytes) {
    const n = Math.min(bytes.length, 256);
    for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
    return false;
  }

  /**
   * @param {string} fileName
   * @param {string | ArrayBuffer | Uint8Array} input
   * @returns {{paths: object[], warnings: string[]}}
   */
  function parsePathFile(fileName, input) {
    const warnings = [];
    let bytes = null;
    let text = null;
    if (typeof input === 'string') text = input;
    else bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

    let paths = [];
    let json = null;
    try {
      if (bytes && looksBinary(bytes)) {
        const res = parseLemlib1(bytes, fileName, warnings);
        paths = res.paths;
        json = res.json;
      } else {
        if (text == null) text = new TextDecoder().decode(bytes);
        const trimmed = text.trim();
        if (trimmed[0] === '{') {
          json = JSON.parse(trimmed);
          paths = pathsFromJson(json, fileName, warnings);
        } else {
          json = embeddedJson(text);
          paths = pathsFromText(fileName, text, json, warnings);
          if (!paths.length && json && Array.isArray(json.paths)) paths = pathsFromJson(json, fileName, warnings);
        }
      }
    } catch (e) {
      warnings.push(`${fileName}: could not be read (${e.message})`);
    }
    if (!paths.length && !warnings.length) warnings.push(`${fileName}: no path points found (is this a jerry.io export?)`);

    const cs = json && json.gc && json.gc.coordinateSystem;
    if (cs && !/VEX Gaming Positioning/i.test(cs)) {
      warnings.push(`${fileName}: uses the "${cs}" coordinate system. The sim assumes field coordinates (VEX Gaming Positioning System); try "Code frame" mode if it is relative to the path start.`);
    }
    paths.forEach((p) => {
      p.file = fileName;
      p.coordinateSystem = cs || 'VEX Gaming Positioning System';
    });
    return { paths, warnings, json };
  }

  /** points converted to inches */
  function pointsInInches(path, unitOverride) {
    const s = UNIT_TO_IN[unitOverride || path.unit] || 1;
    return path.points.map((p) => ({ x: p.x * s, y: p.y * s, v: p.v }));
  }

  Object.assign(NS, { parsePathFile, computePathPoints, pointsInInches, idFromName, unitFromUol, UNIT_TO_IN, GHOST_DISTANCE_IN });
})();
