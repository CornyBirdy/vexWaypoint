/*
 * Path export: jerry.io project (.jerryio), LemLib v0.4 text, LemLib v1.0 binary.
 *
 * Ported from path.jerryio (Jerry Lum, GPL-3.0, https://github.com/Jerrylum/path.jerryio),
 * see NOTICE.md. Exported project files can be opened in jerry.io.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  const APP_VERSION = '0.11.0'; // path.jerryio version whose project layout this writes
  const FIELD_IMAGE = {
    displayName: 'V5RC 2027 - Override',
    signature: 'V5RC-Override-H2H-TopDownHighlighted-TileColor66_71',
    origin: { __type: 'built-in' },
  };

  const f3 = (n) => String(Math.round(n * 1000) / 1000);

  function asciiName(name) {
    return String(name).replace(/[^\x20-\x7E]/g, '') || 'Path';
  }

  /** the project as a jerry.io file ({appVersion, format, gc, paths}) */
  function projectData(project, paths) {
    const list = (paths || project.paths).map((p) => {
      const o = JSON.parse(JSON.stringify(p));
      delete o.origin;
      o.name = asciiName(o.name);
      o.segments.forEach((seg) =>
        seg.controls.forEach((c) => {
          if (c.__type === 'end-point') c.heading = ((c.heading || 0) % 360 + 360) % 360;
        })
      );
      return o;
    });
    return {
      appVersion: APP_VERSION,
      format: 'LemLib v0.4',
      gc: Object.assign({}, project.gc, { fieldImage: FIELD_IMAGE }),
      paths: list,
    };
  }

  function exportProject(project, paths) {
    return JSON.stringify(projectData(project, paths));
  }

  /**
   * LemLib v0.4 text for ONE path: x, y, speed points (inches), a ghost point 20 in past the
   * end, endData, deceleration rate, max speed, 200, the bezier segments, then the project data.
   */
  function exportLemlib04(project, path) {
    const pts = NS.computePathPoints(path, project.gc);
    if (!pts || pts.length < 3) throw new Error('The path is too short to export');
    let out = '';
    pts.forEach((p) => (out += `${f3(p.x)}, ${f3(p.y)}, ${f3(p.v)}\n`));
    const a = pts[pts.length - 3];
    const b = pts[pts.length - 2];
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ghost = { x: b.x + ((b.x - a.x) / d) * 20, y: b.y + ((b.y - a.y) / d) * 20 };
    out += `${f3(ghost.x)}, ${f3(ghost.y)}, 0\n`;
    out += 'endData\n';
    out += `${path.pc.maxDecelerationRate}\n`;
    out += `${path.pc.speedLimit.to}\n`;
    out += '200\n';
    path.segments.forEach((seg) => {
      const c = seg.controls;
      if (c.length === 4) out += `${f3(c[0].x)}, ${f3(c[0].y)}, ${f3(c[1].x)}, ${f3(c[1].y)}, ${f3(c[2].x)}, ${f3(c[2].y)}, ${f3(c[3].x)}, ${f3(c[3].y)}\n`;
      else {
        const m = { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 };
        out += `${f3(c[0].x)}, ${f3(c[0].y)}, ${f3(m.x)}, ${f3(m.y)}, ${f3(m.x)}, ${f3(m.y)}, ${f3(c[1].x)}, ${f3(c[1].y)}\n`;
      }
    });
    out += '#PATH.JERRYIO-DATA ' + exportProject(project, [path]);
    return out;
  }

  /**
   * LemLib v1.0 binary: waypoints in mm and m/s. The editor's 0..127 speeds are scaled to
   * `topSpeedMps` (the speed that 127 stands for).
   */
  function exportLemlib1(project, paths, topSpeedMps) {
    const bytes = [];
    const u8 = (v) => bytes.push(v & 255);
    const i16 = (v) => {
      const x = Math.max(-32768, Math.min(32767, Math.round(v)));
      bytes.push(x & 255, (x >> 8) & 255);
    };
    const u16 = (v) => bytes.push(v & 255, (v >> 8) & 255);
    const u32 = (v) => bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
    const str = (s) => {
      for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 127);
      bytes.push(0);
    };
    u8(4);
    u32(0); // size of the body, filled in below
    u16(paths.length);
    paths.forEach((p) => {
      const pts = NS.computePathPoints(p, project.gc);
      str(asciiName(p.name));
      u8(0);
      u16(pts.length);
      pts.forEach((q) => {
        u8(0);
        i16(q.x * 25.4 * 2);
        i16(q.y * 25.4 * 2);
        i16((q.v / 127) * topSpeedMps * 1000);
      });
    });
    const size = bytes.length;
    bytes[1] = size & 255;
    bytes[2] = (size >>> 8) & 255;
    bytes[3] = (size >>> 16) & 255;
    bytes[4] = (size >>> 24) & 255;
    str('#PATH.JERRYIO-DATA');
    const json = new TextEncoder().encode(JSON.stringify(projectData(project, paths)));
    return new Uint8Array(bytes.concat(Array.from(json)));
  }

  Object.assign(NS, { Export: { projectData, exportProject, exportLemlib04, exportLemlib1 } });
})();
