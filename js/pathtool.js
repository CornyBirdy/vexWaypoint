/*
 * Path editing tool: UI around the editor model (js/editor.js).
 *
 * Interaction follows path.jerryio (Jerry Lum, GPL-3.0, https://github.com/Jerrylum/path.jerryio),
 * see NOTICE.md: click empty field -> Curve / Line, click a point -> Delete, click a
 * curve -> Convert / Split, drag points (end points take their handles along, hold
 * Ctrl to move the point alone), and a speed graph with draggable keyframes.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});
  const E = NS.Editor;

  const PT = {};
  NS.PathTool = PT;

  let H; // host hooks, see init()
  let $;
  const project = new E.Project();
  let tool = 'pose'; // 'pose' | 'edit'
  let selPath = null;
  let selCtrl = null;
  let selKf = null;
  let drag = null;
  let version = 0;
  const cache = new Map();

  PT.project = project;
  PT.tool = () => tool;
  PT.selected = () => project.getPath(selPath);

  // ------------------------------------------------------------------ helpers

  function touch() {
    version++;
    cache.clear();
    H.changed();
  }

  function points(path) {
    let c = cache.get(path.uid);
    if (!c) {
      let pts = [];
      if (path.segments.length) {
        try {
          pts = NS.computePathPoints(path, project.gc) || [];
        } catch (e) {
          pts = [];
        }
      }
      c = { pts };
      cache.set(path.uid, c);
    }
    return c.pts;
  }

  /** code names: path name with non-letters turned into _, made unique */
  function idsMap() {
    const used = new Set();
    const map = new Map();
    project.paths.forEach((p) => {
      let id = NS.idFromName(p.name);
      let n = 2;
      const base = id;
      while (used.has(id)) id = `${base}_${n++}`;
      used.add(id);
      map.set(p.uid, id);
    });
    return map;
  }
  PT.idOf = (path) => idsMap().get(path.uid);

  /** extra code names for paths imported from a file: the file name, e.g. example.txt -> example_txt */
  function aliasesMap() {
    const used = new Set(idsMap().values());
    const out = new Map();
    const fileCount = {};
    project.paths.forEach((p) => p.origin && (fileCount[p.origin] = (fileCount[p.origin] || 0) + 1));
    const seen = {};
    project.paths.forEach((p) => {
      const list = [];
      if (p.origin) {
        const fileId = NS.idFromName(p.origin);
        const base = NS.idFromName(p.origin.replace(/\.[^.]*$/, ''));
        seen[p.origin] = (seen[p.origin] || 0) + 1;
        const cand = fileCount[p.origin] === 1 ? [fileId, base] : [`${fileId}_${seen[p.origin]}`];
        cand.forEach((c) => {
          if (!used.has(c)) {
            used.add(c);
            list.push(c);
          }
        });
      }
      out.set(p.uid, list);
    });
    return out;
  }
  PT.ids = () => {
    const al = aliasesMap();
    return Array.from(idsMap().values()).concat(...Array.from(al.values()));
  };

  const colorOf = (path) => NS.theme.series(project.paths.indexOf(path));

  function pathLength(path) {
    const pts = points(path);
    return pts.length ? pts[pts.length - 1].s : 0;
  }

  // ------------------------------------------------------------------ data in / out

  PT.serialize = () => ({ gc: project.gc, paths: project.paths });

  PT.load = (data) => {
    const pr = E.Project.from(data);
    project.gc = pr.gc;
    project.paths = pr.paths;
    selPath = project.paths.length ? project.paths[0].uid : null;
    selCtrl = null;
    version++;
    cache.clear();
    renderList();
    renderProps();
    drawGraph();
  };

  PT.clear = () => {
    project.paths = [];
    project.undoStack = [];
    project.redoStack = [];
    selPath = selCtrl = selKf = null;
    version++;
    cache.clear();
  };

  /** add the editable paths found in a jerry.io project / export */
  PT.importJson = (json, origin) => {
    project.checkpoint();
    const added = E.importPaths(json, project, origin);
    if (added.length) selPath = added[0].uid;
    touch();
    renderList();
    renderProps();
    return added;
  };

  /** paths for the simulator (inches, field coordinates, speeds as motor commands) */
  PT.runPaths = () => {
    const map = idsMap();
    const al = aliasesMap();
    const out = [];
    project.paths.forEach((p) => {
      const pts = points(p);
      if (pts.length < 2) return;
      out.push({
        ids: [map.get(p.uid), ...al.get(p.uid)],
        name: map.get(p.uid),
        points: pts.map((q) => ({ x: q.x, y: q.y, v: q.v })),
        speedUnit: 'cmd127',
        ghost: false,
        endIdx: pts.length - 1,
        forceField: true,
      });
    });
    return out;
  };

  PT.drawState = () => ({
    selCtrl,
    paths: project.paths.map((p) => ({
      visible: p.visible,
      selected: p.uid === selPath && tool === 'edit',
      locked: p.lock,
      points: points(p),
      from: p.pc.speedLimit.from,
      to: p.pc.speedLimit.to,
      segments: p.segments,
      controls: E.controlsOf(p),
    })),
  });

  // ------------------------------------------------------------------ tool + selection

  PT.setTool = (t) => {
    tool = t;
    closePopup();
    $('toolPose').classList.toggle('on', t === 'pose');
    $('toolEdit').classList.toggle('on', t === 'edit');
    $('speedWrap').hidden = t !== 'edit';
    $('field').style.cursor = t === 'edit' ? 'crosshair' : '';
    drawGraph();
    H.requestDraw();
  };

  function select(pathUid, ctrlUid) {
    selPath = pathUid;
    selCtrl = ctrlUid || null;
    selKf = null;
    renderList();
    renderProps();
    drawGraph();
    H.requestDraw();
  }

  // ------------------------------------------------------------------ field interaction

  function hitRadius() {
    return Math.max(2.4, 9 / H.renderer().scale);
  }

  function hitControl(w) {
    const r = hitRadius();
    let best = null;
    // selected path first, then the rest, last drawn on top
    const order = project.paths.slice().reverse().sort((a, b) => (b.uid === selPath) - (a.uid === selPath));
    for (const p of order) {
      if (!p.visible || p.lock) continue;
      for (const c of E.controlsOf(p)) {
        if (!c.visible || c.lock) continue;
        const d = Math.hypot(c.x - w.x, c.y - w.y);
        const rr = c.__type === 'end-point' ? r : r * 0.8;
        if (d <= rr && (!best || d < best.d)) best = { path: p, ctrl: c, d };
      }
      if (best) return best;
    }
    return best;
  }

  function hitSegment(w) {
    const r = Math.max(2.2, 7 / H.renderer().scale);
    let best = null;
    project.paths.forEach((p) => {
      if (!p.visible || p.lock) return;
      const n = E.nearestOnPath(p, w.x, w.y);
      if (n && n.dist <= r && (!best || n.dist < best.dist)) best = Object.assign({ path: p }, n);
    });
    return best;
  }

  function clampField(w) {
    return { x: Math.max(-72, Math.min(72, w.x)), y: Math.max(-72, Math.min(72, w.y)) };
  }

  /** returns true when the event was used by the path tool */
  PT.pointerDown = (w, e, client) => {
    if (tool !== 'edit') return false;
    closePopup();
    const hc = hitControl(w);
    if (hc) {
      select(hc.path.uid, hc.ctrl.uid);
      drag = { kind: 'ctrl', path: hc.path, ctrl: hc.ctrl, moved: false, client, alone: e.ctrlKey };
      return true;
    }
    const hs = hitSegment(w);
    if (hs) {
      select(hs.path.uid, null);
      drag = { kind: 'seg', hit: hs, client };
      return true;
    }
    drag = { kind: 'blank', w, client };
    return true;
  };

  PT.pointerMove = (w, e, client) => {
    if (tool !== 'edit' || !drag) return false;
    if (drag.kind === 'ctrl') {
      if (!drag.moved && Math.hypot(client.x - drag.client.x, client.y - drag.client.y) < 4) return true;
      if (!drag.moved) {
        project.checkpoint();
        drag.moved = true;
      }
      const c = clampField(w);
      E.dragControl(drag.path, drag.ctrl, Math.round(c.x * 10) / 10, Math.round(c.y * 10) / 10, drag.alone || e.ctrlKey);
      touch();
      return true;
    }
    return true;
  };

  PT.pointerUp = (w, e, client) => {
    if (tool !== 'edit' || !drag) return false;
    const d = drag;
    drag = null;
    const moved = Math.hypot(client.x - d.client.x, client.y - d.client.y) >= 4;
    if (d.kind === 'ctrl') {
      if (!d.moved) {
        const items = d.ctrl.__type === 'end-point' ? [['Delete', () => removeSelectedControl()]] : [['Handle', null]];
        popup(client, items.filter((i) => i[1]));
      }
      renderList();
      return true;
    }
    if (moved) return true;
    if (d.kind === 'seg') {
      const h = d.hit;
      popup(client, [
        ['Convert', () => {
          project.checkpoint();
          E.convertSegment(h.path, h.seg);
          touch();
        }],
        ['Split', () => {
          project.checkpoint();
          E.splitSegment(h.path, h.seg, { x: h.x, y: h.y });
          touch();
        }],
      ]);
      return true;
    }
    // blank field: Curve / Line from the last point (or from the robot for a new path)
    const at = clampField(d.w);
    const add = (cubic) => () => {
      project.checkpoint();
      let p = project.getPath(selPath);
      if (!p || p.lock || !p.visible) {
        p = project.addPath('Path');
        selPath = p.uid;
      }
      const s = H.getStart();
      E.addSegment(p, Math.round(at.x * 10) / 10, Math.round(at.y * 10) / 10, cubic, { x: s.x, y: s.y, heading: s.h });
      selCtrl = null;
      touch();
      renderList();
      renderProps();
      drawGraph();
    };
    popup(client, [['Curve', add(true)], ['Line', add(false)]]);
    return true;
  };

  function removeSelectedControl() {
    const p = project.getPath(selPath);
    if (!p || !selCtrl) return;
    const c = E.controlsOf(p).find((x) => x.uid === selCtrl);
    if (!c || c.__type !== 'end-point') return;
    project.checkpoint();
    E.removeEndControl(p, c);
    selCtrl = null;
    touch();
    renderList();
    drawGraph();
  }

  PT.cursor = (w) => {
    if (tool !== 'edit') return '';
    if (drag && drag.kind === 'ctrl' && drag.moved) return 'grabbing';
    if (hitControl(w)) return 'grab';
    if (hitSegment(w)) return 'pointer';
    return 'crosshair';
  };

  /** keyboard: returns true when handled */
  PT.key = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) PT.redo();
      else PT.undo();
      return true;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      PT.redo();
      return true;
    }
    if (tool !== 'edit') return false;
    if (e.key === 'Escape') {
      closePopup();
      selCtrl = null;
      selKf = null;
      H.requestDraw();
      drawGraph();
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selKf) {
        removeSelectedKeyframe();
        return true;
      }
      if (selCtrl) {
        removeSelectedControl();
        return true;
      }
    }
    return false;
  };

  PT.undo = () => {
    if (project.undo()) afterHistory();
  };
  PT.redo = () => {
    if (project.redo()) afterHistory();
  };
  function afterHistory() {
    if (!project.getPath(selPath)) selPath = project.paths.length ? project.paths[0].uid : null;
    selCtrl = selKf = null;
    touch();
    renderList();
    renderProps();
    drawGraph();
  }

  // ------------------------------------------------------------------ popup menu

  function closePopup() {
    const el = $('popup');
    if (el) el.hidden = true;
  }

  function popup(client, items) {
    const el = $('popup');
    if (!items.length) return closePopup();
    el.innerHTML = '';
    items.forEach(([label, fn]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = label;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closePopup();
        fn();
      });
      el.appendChild(b);
    });
    const wrap = $('field').parentElement.getBoundingClientRect();
    el.hidden = false;
    const w = el.offsetWidth;
    el.style.left = Math.max(2, Math.min(wrap.width - w - 2, client.x - wrap.left + 8)) + 'px';
    el.style.top = Math.max(2, Math.min(wrap.height - 34, client.y - wrap.top + 8)) + 'px';
  }

  // ------------------------------------------------------------------ path list + settings

  function renderList() {
    const ul = $('projList');
    if (!ul) return;
    ul.innerHTML = '';
    const map = idsMap();
    const aliases = aliasesMap();
    project.paths.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'path' + (p.uid === selPath ? ' sel' : '');
      const id = map.get(p.uid);
      li.innerHTML = `
        <span class="sw" style="background:${colorOf(p)}"></span>
        <span class="nm"><b title="${esc(p.name)}">${esc(p.name)}</b>
          <button class="id" type="button" title="Click to copy the name to use in chassis.follow()">${esc(id)}</button>
          <span class="meta">${p.segments.length} seg &middot; ${pathLength(p).toFixed(0)} in${aliases.get(p.uid).length ? ' &middot; also ' + esc(aliases.get(p.uid).join(', ')) : ''}</span></span>
        <button class="mini ${p.lock ? 'on' : ''}" type="button" title="Lock (no editing)" data-act="lock">${p.lock ? 'locked' : 'lock'}</button>
        <input type="checkbox" ${p.visible ? 'checked' : ''} title="Show on field" aria-label="Show ${esc(p.name)}">
        <button class="x" type="button" title="Delete path" aria-label="Delete ${esc(p.name)}">&times;</button>`;
      li.addEventListener('click', (e) => {
        if (e.target.closest('button,input')) return;
        select(p.uid, null);
      });
      li.querySelector('.id').addEventListener('click', () => {
        if (navigator.clipboard) navigator.clipboard.writeText(id).catch(() => {});
        $('cursor').textContent = `chassis.follow(${id}, 15, 4000);`;
        select(p.uid, null);
      });
      li.querySelector('[data-act=lock]').addEventListener('click', () => {
        project.checkpoint();
        p.lock = !p.lock;
        touch();
        renderList();
      });
      li.querySelector('input').addEventListener('change', (e) => {
        project.checkpoint();
        p.visible = e.target.checked;
        touch();
      });
      li.querySelector('.x').addEventListener('click', () => {
        project.checkpoint();
        project.paths = project.paths.filter((q) => q !== p);
        if (selPath === p.uid) selPath = project.paths.length ? project.paths[0].uid : null;
        touch();
        renderList();
        renderProps();
        drawGraph();
      });
      ul.appendChild(li);
    });
    $('btnExport').disabled = !project.paths.length;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const PROPS = [
    ['pName', 'name', null],
    ['pFrom', 'pc.speedLimit.from', Number],
    ['pTo', 'pc.speedLimit.to', Number],
    ['pBentFrom', 'pc.bentRateApplicableRange.from', Number],
    ['pBentTo', 'pc.bentRateApplicableRange.to', Number],
    ['pDecel', 'pc.maxDecelerationRate', Number],
  ];
  const getp = (o, p) => p.split('.').reduce((a, k) => a[k], o);
  const setp = (o, p, v) => {
    const ks = p.split('.');
    const l = ks.pop();
    ks.reduce((a, k) => a[k], o)[l] = v;
  };

  function renderProps() {
    const p = project.getPath(selPath);
    $('pathProps').hidden = !p;
    if (!p) return;
    PROPS.forEach(([id, key]) => {
      const el = $(id);
      if (document.activeElement !== el) el.value = getp(p, key);
    });
    $('pDensity').value = project.gc.pointDensity;
  }

  function bindProps() {
    PROPS.forEach(([id, key, conv]) => {
      const el = $(id);
      el.addEventListener('focus', () => project.checkpoint());
      el.addEventListener('input', () => {
        const p = project.getPath(selPath);
        if (!p) return;
        let v = el.value;
        if (conv) {
          v = conv(v);
          if (!isFinite(v)) return;
        } else v = v.replace(/[^\x20-\x7E]/g, '') || 'Path';
        setp(p, key, v);
        touch();
        renderList();
        drawGraph();
      });
    });
    const d = $('pDensity');
    d.addEventListener('focus', () => project.checkpoint());
    d.addEventListener('input', () => {
      const v = parseFloat(d.value);
      if (!isFinite(v) || v < 0.25) return;
      project.gc.pointDensity = v;
      touch();
      renderList();
      drawGraph();
    });
    $('btnNewPath').addEventListener('click', () => {
      project.checkpoint();
      const p = project.addPath('Path');
      selPath = p.uid;
      PT.setTool('edit');
      touch();
      renderList();
      renderProps();
      drawGraph();
    });
    $('btnUndo').addEventListener('click', PT.undo);
    $('btnRedo').addEventListener('click', PT.redo);
    $('toolPose').addEventListener('click', () => PT.setTool('pose'));
    $('toolEdit').addEventListener('click', () => PT.setTool('edit'));
    $('btnExport').addEventListener('click', doExport);
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('#popup')) closePopup();
    });
  }

  function download(name, data, type) {
    const blob = new Blob([data], { type: type || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
  }

  function doExport() {
    const fmt = $('exportFmt').value;
    const p = project.getPath(selPath) || project.paths[0];
    try {
      if (fmt === 'project') download('paths.jerryio', NS.Export.exportProject(project), 'application/json');
      else if (fmt === 'lemlib04') {
        if (!p) throw new Error('No path to export');
        download(NS.idFromName(p.name) + '.txt', NS.Export.exportLemlib04(project, p), 'text/plain');
      } else download('paths.bin', NS.Export.exportLemlib1(project, project.paths, H.topSpeedMps()));
      H.log('info', 'Exported ' + (fmt === 'project' ? 'paths.jerryio' : fmt === 'lemlib04' ? NS.idFromName(p.name) + '.txt' : 'paths.bin'));
    } catch (err) {
      H.log('warn', 'Export failed: ' + err.message);
    }
  }

  // ------------------------------------------------------------------ speed graph

  function graphGeometry(path) {
    const pts = points(path);
    if (pts.length < 2) return null;
    const total = pts[pts.length - 1].s || 1;
    const segStart = path.segments.map((seg, i) => {
      const f = pts.find((q) => q.seg === i);
      return f ? f.s : 0;
    });
    const segEnd = path.segments.map((seg, i) => (i + 1 < segStart.length ? segStart[i + 1] : total));
    const lFrom = path.pc.speedLimit.from;
    const lTo = path.pc.speedLimit.to;
    const top = Math.max(lTo, ...pts.map((q) => q.v)) * 1.15 || 1;
    return { pts, total, segStart, segEnd, lFrom, lTo, top };
  }

  function drawGraph() {
    const cv = $('speedGraph');
    if (!cv || $('speedWrap').hidden) return;
    const rect = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(200, Math.floor(rect.width));
    const Ht = Math.max(80, Math.floor(rect.height));
    cv.width = W * dpr;
    cv.height = Ht * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const T = NS.theme.color;
    const mono = T('mono');
    ctx.fillStyle = T('surface-sunken');
    ctx.fillRect(0, 0, W, Ht);
    const p = project.getPath(selPath);
    const g = p && graphGeometry(p);
    if (!g) {
      ctx.fillStyle = T('ink-muted');
      ctx.font = `12px ${mono}`;
      ctx.fillText('Select or draw a path to edit its speed profile.', 10, 22);
      return;
    }
    const px = (s) => 8 + (s / g.total) * (W - 16);
    const py = (v) => Ht - 14 - (v / g.top) * (Ht - 24);
    // limits
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = T('border-control');
    ctx.lineWidth = 1;
    [g.lFrom, g.lTo].forEach((v) => {
      ctx.beginPath();
      ctx.moveTo(8, py(v));
      ctx.lineTo(W - 8, py(v));
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.fillStyle = T('ink-muted');
    ctx.font = `11px ${mono}`;
    ctx.fillText(String(g.lTo), 10, py(g.lTo) - 3);
    ctx.fillText(String(g.lFrom), 10, py(g.lFrom) - 3);
    // segment ticks
    ctx.strokeStyle = T('hairline');
    g.segStart.forEach((s, i) => {
      if (!i) return;
      ctx.beginPath();
      ctx.moveTo(px(s), 4);
      ctx.lineTo(px(s), Ht - 12);
      ctx.stroke();
    });
    // profile
    ctx.beginPath();
    g.pts.forEach((q, i) => (i ? ctx.lineTo(px(q.s), py(q.v)) : ctx.moveTo(px(q.s), py(q.v))));
    ctx.strokeStyle = T('accent');
    ctx.lineWidth = 2;
    ctx.stroke();
    // keyframes
    p.segments.forEach((seg, i) => {
      seg.speedProfiles.forEach((kf) => {
        const s = g.segStart[i] + kf.xPos * (g.segEnd[i] - g.segStart[i]);
        const v = g.lFrom + (g.lTo - g.lFrom) * kf.yPos;
        ctx.beginPath();
        ctx.arc(px(s), py(v), 5, 0, Math.PI * 2);
        ctx.fillStyle = kf.uid === selKf ? T('accent-2') : T('ink');
        ctx.fill();
        ctx.strokeStyle = T('surface');
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    });
    ctx.fillStyle = T('ink-muted');
    ctx.fillText('0', 8, Ht - 3);
    ctx.fillText(g.total.toFixed(0) + ' in', W - 46, Ht - 3);
  }
  PT.drawGraph = drawGraph;

  function graphPos(e) {
    const cv = $('speedGraph');
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, W: r.width, H: r.height };
  }

  function bindGraph() {
    const cv = $('speedGraph');
    let gd = null;
    const toData = (g, pos) => {
      const s = Math.max(0, Math.min(g.total - 1e-6, ((pos.x - 8) / (pos.W - 16)) * g.total));
      const v = ((pos.H - 14 - pos.y) / (pos.H - 24)) * g.top;
      const yPos = Math.max(0, Math.min(1, (v - g.lFrom) / (g.lTo - g.lFrom || 1)));
      let si = g.segStart.length - 1;
      for (let i = 0; i < g.segStart.length; i++) if (s < g.segEnd[i]) { si = i; break; }
      const len = g.segEnd[si] - g.segStart[si] || 1;
      return { si, xPos: Math.max(0, Math.min(0.9999, (s - g.segStart[si]) / len)), yPos, s, v };
    };
    cv.addEventListener('pointerdown', (e) => {
      const p = project.getPath(selPath);
      const g = p && graphGeometry(p);
      if (!g || p.lock) return;
      const pos = graphPos(e);
      const px = (s) => 8 + (s / g.total) * (pos.W - 16);
      const py = (v) => pos.H - 14 - (v / g.top) * (pos.H - 24);
      let hit = null;
      p.segments.forEach((seg, i) =>
        seg.speedProfiles.forEach((kf) => {
          const s = g.segStart[i] + kf.xPos * (g.segEnd[i] - g.segStart[i]);
          const v = g.lFrom + (g.lTo - g.lFrom) * kf.yPos;
          if (Math.hypot(px(s) - pos.x, py(v) - pos.y) < 9) hit = kf;
        })
      );
      cv.setPointerCapture(e.pointerId);
      project.checkpoint();
      if (hit) selKf = hit.uid;
      else {
        const d = toData(g, pos);
        selKf = E.addKeyframe(p.segments[d.si], d.xPos, d.yPos).uid;
        touch();
      }
      gd = { moved: false };
      drawGraph();
    });
    cv.addEventListener('pointermove', (e) => {
      const p = project.getPath(selPath);
      const g = p && graphGeometry(p);
      if (!g) return;
      const pos = graphPos(e);
      const d = toData(g, pos);
      $('speedInfo').textContent = `${d.s.toFixed(1)} in, speed ${d.v.toFixed(0)}`;
      if (!gd || !selKf) return;
      gd.moved = true;
      E.moveKeyframe(p, selKf, p.segments[d.si], d.xPos, d.yPos);
      touch();
      drawGraph();
    });
    const end = () => {
      gd = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('dblclick', () => removeSelectedKeyframe());
    window.addEventListener('resize', drawGraph);
  }

  function removeSelectedKeyframe() {
    const p = project.getPath(selPath);
    if (!p || !selKf) return;
    project.checkpoint();
    E.removeKeyframe(p, selKf);
    selKf = null;
    touch();
    drawGraph();
  }

  // ------------------------------------------------------------------ init

  /**
   * @param {object} host  { $, renderer(), requestDraw(), changed(), getStart(), log(kind, text), topSpeedMps() }
   */
  PT.init = (host) => {
    H = host;
    $ = host.$;
    bindProps();
    bindGraph();
    renderList();
    renderProps();
    PT.setTool('pose');
  };

  PT.refresh = () => {
    renderList();
    renderProps();
    drawGraph();
  };
})();
