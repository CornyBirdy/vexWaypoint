/*
 * VEX V5 Override field. Visual only - nothing here affects the robot.
 *
 * Inches, origin at field centre, +X right, +Y up the screen.
 *
 * Taken from the game manual text: 12 ft x 12 ft, 9 goals (1 tall neutral in
 * the centre, 4 neutral short, 2 red + 2 blue alliance), each outer goal 1 tile
 * from one wall and 2 tiles from another, one loader in each corner, one
 * toggle on top of each wall centre.
 *
 * NOT taken from the manual (fill in from Appendix A / the field figures):
 *   - goal diameters (GOAL_RADIUS is a rough stand-in)
 *   - which outer goal in each quadrant is the alliance goal
 *   - exact loader position and size
 *   - where the 56 cups and 63 pins start (ELEMENTS is intentionally empty)
 *
 * ELEMENTS entries: { type: 'pin' | 'cup', color: 'red' | 'blue' | 'yellow' | 'gray' | 'clear', x, y }
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  const TILE = 24;
  const HALF = 72;

  const GOALS = [
    { x: 0, y: 0, kind: 'tall', team: 'neutral' },
    // bottom quadrant
    { x: 24, y: -48, kind: 'alliance', team: 'red' },
    { x: -24, y: -48, kind: 'short', team: 'neutral' },
    // left quadrant
    { x: -48, y: -24, kind: 'alliance', team: 'red' },
    { x: -48, y: 24, kind: 'short', team: 'neutral' },
    // top quadrant
    { x: -24, y: 48, kind: 'alliance', team: 'blue' },
    { x: 24, y: 48, kind: 'short', team: 'neutral' },
    // right quadrant
    { x: 48, y: 24, kind: 'alliance', team: 'blue' },
    { x: 48, y: -24, kind: 'short', team: 'neutral' },
  ];
  const GOAL_RADIUS = { tall: 6, short: 4.5, alliance: 4 };

  const LOADERS = [
    { x: -HALF + 3, y: -HALF + 3 },
    { x: HALF - 3, y: -HALF + 3 },
    { x: -HALF + 3, y: HALF - 3 },
    { x: HALF - 3, y: HALF - 3 },
  ];

  const TOGGLES = [
    { wall: 'bottom', x: 0, y: -HALF },
    { wall: 'left', x: -HALF, y: 0 },
    { wall: 'top', x: 0, y: HALF },
    { wall: 'right', x: HALF, y: 0 },
  ];

  const ELEMENTS = [];

  Object.assign(NS, {
    FIELD: { TILE, HALF, GOALS, GOAL_RADIUS, LOADERS, TOGGLES, ELEMENTS },
  });
})();
