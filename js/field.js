/*
 * VEX V5 "Override" field layout. VISUAL ONLY - nothing here affects the robot.
 *
 * Coordinates: inches, origin at field centre, +X right, +Y up the screen.
 *
 * What is known from the game manual: 12 ft x 12 ft field, 9 goals (1 neutral
 * tall goal in the centre, 4 neutral short goals, 2 red + 2 blue alliance
 * goals), the 8 outer goals sit 1 tile from one wall and 2 tiles from another,
 * a loader in each corner, a toggle on top of the centre of each wall, 56 cups
 * and 63 pins on the field.
 *
 * Exact goal diameters, which outer goal is the alliance one, element start
 * positions and loader contents are APPROXIMATE. If your field differs, edit the
 * numbers below - that is the only place that needs changing.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  const TILE = 24;
  const HALF = 72;

  // outer goals: 1 tile from one wall, 2 tiles from the other
  const OUTER = [
    // bottom quadrant (red)       left quadrant (red)
    { x: 24, y: -48, kind: 'alliance', team: 'red' },
    { x: -24, y: -48, kind: 'short', team: 'neutral' },
    { x: -48, y: -24, kind: 'alliance', team: 'red' },
    { x: -48, y: 24, kind: 'short', team: 'neutral' },
    // top quadrant (blue)         right quadrant (blue)
    { x: -24, y: 48, kind: 'alliance', team: 'blue' },
    { x: 24, y: 48, kind: 'short', team: 'neutral' },
    { x: 48, y: 24, kind: 'alliance', team: 'blue' },
    { x: 48, y: -24, kind: 'short', team: 'neutral' },
  ];

  const GOALS = [{ x: 0, y: 0, kind: 'tall', team: 'neutral' }].concat(OUTER);
  const GOAL_RADIUS = { tall: 6.5, short: 5, alliance: 4.2 };

  // one loader in each corner
  const LOADERS = [
    { x: -HALF + 3.5, y: -HALF + 3.5, side: 'bl' },
    { x: HALF - 3.5, y: -HALF + 3.5, side: 'br' },
    { x: -HALF + 3.5, y: HALF - 3.5, side: 'tl' },
    { x: HALF - 3.5, y: HALF - 3.5, side: 'tr' },
  ];

  // one toggle on top of each wall centre (bar is ~26 in long)
  const TOGGLES = [
    { wall: 'bottom', x: 0, y: -HALF, team: 'red' },
    { wall: 'left', x: -HALF, y: 0, team: 'red' },
    { wall: 'top', x: 0, y: HALF, team: 'blue' },
    { wall: 'right', x: HALF, y: 0, team: 'blue' },
  ];

  // illustrative element placement: pins and cups
  const ELEMENTS = [];
  (function build() {
    // a short row of elements waiting next to each loader
    LOADERS.forEach((l) => {
      const sx = l.x < 0 ? 1 : -1;
      const sy = l.y < 0 ? 1 : -1;
      for (let i = 0; i < 4; i++) {
        ELEMENTS.push({ type: 'pin', team: sy < 0 ? 'red' : 'blue', x: l.x + sx * (10 + i * 4.4), y: l.y + sy * 0 });
        ELEMENTS.push({ type: 'cup', team: 'neutral', x: l.x + sx * 0, y: l.y + sy * (10 + i * 4.4) });
      }
    });
    // scattered pins around the centre goal and between the quadrants
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + Math.PI / 4;
      for (let j = 0; j < 3; j++) {
        const r = 14 + j * 5;
        ELEMENTS.push({ type: 'pin', team: 'yellow', x: Math.cos(a) * r, y: Math.sin(a) * r });
      }
    }
    // a few cups beside each outer goal
    OUTER.forEach((g, i) => {
      const a = (i * Math.PI) / 4;
      ELEMENTS.push({ type: 'cup', team: 'neutral', x: g.x + Math.cos(a) * 9, y: g.y + Math.sin(a) * 9 });
    });
  })();

  Object.assign(NS, {
    FIELD: { TILE, HALF, GOALS, GOAL_RADIUS, LOADERS, TOGGLES, ELEMENTS },
  });
})();
