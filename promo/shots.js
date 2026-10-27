/* Waypoint reveal: the shot list. Times are global seconds; inside a shot every time is local to it.
 * Scripts drive the real app (index.html) through real mouse events and its own UI. */
(function () {
  'use strict';

  const SITE_URL = ''; // set when the public address is known

  const EXAMPLE_CODE = null; // filled from the app's own example at runtime (A.V.EXAMPLES.code)

  const SIMPLE_CODE = `#include "main.h"

void autonomous() {
    chassis.setPose(0, 0, 0);
    chassis.follow(Path, 15, 6000);
    chassis.waitUntilDone();
}
`;

  /** collapse panel sections by their heading text */
  const collapse = (A, ...names) =>
    A.qa('.panel details.sec').forEach((d) => {
      const t = d.querySelector('summary').textContent.trim().toLowerCase();
      if (names.some((n) => t.startsWith(n))) d.open = false;
    });
  const expand = (A, ...names) =>
    A.qa('.panel details.sec').forEach((d) => {
      const t = d.querySelector('summary').textContent.trim().toLowerCase();
      if (names.some((n) => t.startsWith(n))) d.open = true;
    });

  const move = (t, to, dur = 0.5, extra = {}) => Object.assign({ t, dur, to }, extra);
  const click = (t, to, dur = 0.5, extra = {}) => Object.assign({ t, dur, to, click: true }, extra);

  // ---------------------------------------------------------------- shots

  const flush = () => new Promise((r) => setTimeout(r, 60));
  /** what a user does after a run to see the whole trail: drag the timeline to the end */
  const toEnd = (A) => {
    const sc = A.$('scrub');
    A.set(sc, sc.max);
  };
  const BASE = (A) => {
    A.click('#btnRestart');
  };

  // draw: field points (inches) the cursor clicks, in order
  const DRAW_PTS = [[-38, -8], [-2, 22], [40, 48]];
  const drawMouse = () => {
    const m = [];
    m.push(click(0.6, { sel: '#toolEdit' }, 0.5, { from: { app: [420, 860] } }));
    let t = 1.2;
    DRAW_PTS.forEach((p, i) => {
      m.push(click(t, { field: p }, i ? 0.3 : 0.4));
      m.push(click(t + 0.45, { sel: '#popup .btn:nth-child(1)' }, 0.25));
      t += 0.92;
    });
    return { m, t };
  };
  const draw = drawMouse();

  const SHOTS = [
    { id: 'logo', kind: 'logo', t0: 0.0, t1: 3.0 },
    { id: 'title', kind: 'title', t0: 3.0, t1: 5.0 },

    // 01 run ------------------------------------------------------------
    {
      id: 'run',
      kind: 'app',
      t0: 5.0,
      t1: 10.0,
      cap: { kicker: '01 &middot; Run', lines: ['Paste your', 'auton.', '<em>Hit run.</em>'], sub: 'Your real <b>LemLib</b> code, simulated end to end.', t0: 0.2, t1: 4.6 },
      setup: async (A) => {
        BASE(A);
        collapse(A, 'start pose', 'drivetrain', 'paths', 'selected path');
        A.change(A.$('speed'), '2');
        A.$('code').value = '';
      },
      camera: [
        { t: 0, rect: { x: 0, y: 0, w: 1200, h: 830 }, pad: 10 },
        { t: 0.8, rect: { x: 800, y: 0, w: 400, h: 780 }, pad: 30 },
        { t: 1.95, rect: { x: 800, y: 0, w: 400, h: 780 }, pad: 30 },
        { t: 2.8, rect: { x: 60, y: 40, w: 700, h: 880 }, pad: 30 },
      ],
      mouse: [
        move(0.85, { sel: '#code', fx: 0.45, fy: 0.4 }, 0.7, { from: { app: [600, 700] } }),
        click(0.9, { sel: '#code', fx: 0.45, fy: 0.4 }, 0.05),
        click(1.75, { sel: '#btnRun' }, 0.6),
        move(2.9, { app: [700, 640] }, 0.8),
        { t: 3.6, dur: 0, hide: true },
      ],
      actions: [{ t: 1.15, run: (A) => A.set(A.$('code'), A.V.EXAMPLES.code) }],
    },

    // 02 draw -----------------------------------------------------------
    {
      id: 'draw',
      kind: 'app',
      t0: 10.0,
      t1: 16.0,
      cap: { kicker: '02 &middot; Draw', lines: ['Draw paths', '<em>on the field.</em>'], sub: 'Curves, lines and speed keyframes. Import and export <b>jerry.io</b>.', t0: 0.2, t1: 5.6 },
      setup: async (A) => {
        A.click('#projList .x');
        await flush();
        A.$('code').value = SIMPLE_CODE;
        A.click('#btnRun');
        await flush();
        BASE(A);
        A.change(A.$('speed'), '4');
        collapse(A, 'start pose', 'drivetrain');
      },
      // the speed graph pushes the transport bar below the window: scroll the page, like a user would
      onFrame: (A, lt, E) => A.win.scrollTo(0, 96 * E.io(Math.min(1, Math.max(0, (lt - 3.1) / 0.6)))),
      camera: [
        { t: 0, rect: { x: 60, y: 40, w: 710, h: 740 }, pad: 20 },
        { t: 3.0, rect: { x: 60, y: 40, w: 710, h: 740 }, pad: 20 },
        { t: 3.7, rect: { x: 60, y: 0, w: 710, h: 900 }, pad: 20 },
        { t: 4.7, rect: { x: 60, y: 0, w: 710, h: 900 }, pad: 20 },
        { t: 5.4, rect: { x: 60, y: -10, w: 710, h: 720 }, pad: 20 },
      ],
      mouse: draw.m.concat([
        click(draw.t + 0.05, { sel: '#speedGraph', fx: 0.5, fy: 0.25 }, 0.3),
        click(draw.t + 0.6, { sel: '#btnPlay' }, 0.35),
        move(draw.t + 1.5, { app: [900, 700] }, 0.8),
      ]),
      actions: [],
    },

    // 03 tune -----------------------------------------------------------
    {
      id: 'tune',
      kind: 'app',
      t0: 16.0,
      t1: 20.0,
      cap: { kicker: '03 &middot; Tune', lines: ['Tune it', '<em>live.</em>'], sub: 'Change the drivetrain and see if you beat the clock.', t0: 0.2, t1: 3.6 },
      setup: async (A) => {
        BASE(A);
        collapse(A, 'start pose', 'paths', 'selected path');
        expand(A, 'drivetrain');
        toEnd(A);
      },
      camera: [{ t: 0, rect: { x: 60, y: 80, w: 1130, h: 830 }, pad: 20 }, { t: 3.8, rect: { x: 60, y: 80, w: 1130, h: 830 }, pad: 6 }],
      // portrait: zoom on the drivetrain panel, where the numbers change, then pull back for the result
      cameraV: [
        { t: 0, rect: { x: 60, y: 80, w: 1130, h: 830 }, pad: 10 },
        { t: 0.7, rect: { x: 800, y: 120, w: 400, h: 470 }, pad: 20 },
        { t: 3.0, rect: { x: 800, y: 120, w: 400, h: 470 }, pad: 20 },
        { t: 3.7, rect: { x: 60, y: 80, w: 1130, h: 830 }, pad: 10 },
      ],
      mouse: [
        move(0.5, { sel: 'input[data-key="robot.rpm"]' }, 0.8, { from: { app: [560, 820] } }),
        click(1.9, { sel: 'input[data-key="robot.rpm"]', fx: 0.8 }, 0.5, { click: 'fake' }),
      ],
      lens: { t0: 1.45, t1: 3.65, value: 'tLimit', label: (A) => `Drivetrain ${A.q('input[data-key="robot.rpm"]').value} rpm` },
      tweens: [
        { t: 0.6, dur: 0.5, el: 'input[data-key="robot.rpm"]', from: 450, to: 100, step: 5 },
        { t: 2.0, dur: 0.5, el: 'input[data-key="robot.rpm"]', from: 100, to: 600, step: 5 },
      ],
      actions: [
        { t: 1.6, run: (A) => toEnd(A) },
        { t: 3.0, run: (A) => toEnd(A) },
      ],
    },

    // 04 explore --------------------------------------------------------
    {
      id: 'explore',
      kind: 'app',
      t0: 20.0,
      t1: 23.5,
      cap: { kicker: '04 &middot; Explore', lines: ['Scrub every', '<em>second.</em>'], sub: 'Timeline, three field views, light and dark.', t0: 0.2, t1: 3.1 },
      setup: async (A) => {
        BASE(A);
        collapse(A, 'start pose', 'paths', 'selected path', 'drivetrain');
      },
      camera: [{ t: 0, rect: { x: 0, y: 0, w: 1200, h: 830 }, pad: 6 }, { t: 3.6, rect: { x: 0, y: 0, w: 1200, h: 830 }, pad: -10 }],
      mouse: [
        move(0.4, { sel: '#scrub', fx: 0.0 }, 0.4, { from: { app: [500, 880] } }),
        { t: 1.3, dur: 0.9, to: { sel: '#scrub', fx: 0.72 }, drag: true },
        move(1.7, { sel: '#fieldStyle' }, 0.4),
        click(1.85, { sel: '#fieldStyle' }, 0.1, { click: 'fake' }),
        click(2.5, { sel: '#btnTheme' }, 0.5),
      ],
      actions: [{ t: 1.9, run: (A) => A.change(A.$('fieldStyle'), 'drawn') }],
    },

    { id: 'grid', kind: 'grid', t0: 23.5, t1: 26.0 },
    { id: 'end', kind: 'end', t0: 26.0, t1: 30.0 },
  ];

  const TILES = [
    { icon: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 4v5M12 15v5M4 12h5M15 12h5"/>', title: 'LemLib 0.5.6', sub: 'A faithful port of the real motions.' },
    { icon: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>', title: 'C++ or JavaScript', sub: 'Paste your whole main.cpp.' },
    { icon: '<path d="M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6"/>', title: 'jerry.io paths', sub: 'Import, edit and export.' },
    { icon: '<circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M7 18c8 0 2-12 10-12"/>', title: 'Path editor', sub: 'Curves, lines, speed keyframes.' },
    { icon: '<path d="M8 5l10 7-10 7z"/>', title: 'Timeline', sub: 'Play, scrub, jump to any motion.' },
    { icon: '<path d="M12 3l9 9-9 9-9-9z"/><path d="M12 8l4 4-4 4-4-4z"/>', title: 'Override field', sub: 'Match, skills or drawn.' },
  ];

  const CUTS = SHOTS.slice(1).map((s) => s.t0);

  window.PROMO = { SHOTS, TILES, CUTS, TOTAL: 30.0, FPS: 60, WIPE: 0.28, SITE_URL };
})();
