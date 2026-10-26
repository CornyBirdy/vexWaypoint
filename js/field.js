/*
 * VEX V5 Override field - visual only, nothing here affects the robot.
 *
 * Inches, origin at field centre, +X right, +Y up the screen, red side on the
 * left and blue on the right. Positions were measured off a top-down render of
 * the field (6 tiles of 24 in, playfield -72..72), good to about half an inch.
 * Everything is plain data: if something is off, change the numbers.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  const HALF = 72;
  const TILE = 24;

  // ---- goals: 1 tile from one wall, 2 tiles from another. tag = AprilTag id
  const GOALS = [
    { x: 0, y: 0, kind: 'tall', team: 'neutral', tag: 0 },
    // neutral short goals (upper-left, lower-right)
    { x: -24, y: 48, kind: 'short', team: 'neutral', tag: 4 },
    { x: -48, y: 24, kind: 'short', team: 'neutral', tag: 1 },
    { x: 48, y: -24, kind: 'short', team: 'neutral', tag: 1 },
    { x: 24, y: -48, kind: 'short', team: 'neutral', tag: 4 },
    // red alliance goals (lower-left)
    { x: -48, y: -24, kind: 'alliance', team: 'red', tag: 2 },
    { x: -24, y: -48, kind: 'alliance', team: 'red', tag: 3 },
    // blue alliance goals (upper-right)
    { x: 24, y: 48, kind: 'alliance', team: 'blue', tag: 3 },
    { x: 48, y: 24, kind: 'alliance', team: 'blue', tag: 2 },
  ];
  const GOAL_SIZE = 5.8; // flat-to-flat

  // ---- floor tape
  const DIAMOND_R = 24; // |x| + |y| = 24
  const DIAGONAL_FROM = 60.8; // diagonals start at the corner boxes and end on the diamond
  const DIAGONAL_TO = 12;
  const DIAGONAL_GAP = 2.1; // centre-to-centre spacing of the double line
  const BOX = { x: 60.8, y: 47.5 }; // corner L-box reaches this far in from the walls

  // ---- loaders: on the alliance walls, 12 in from each corner
  const LOADERS = [
    { x: -73.6, y: 60.3, team: 'red' },
    { x: -73.6, y: -60.3, team: 'red' },
    { x: 73.6, y: 60.3, team: 'blue' },
    { x: 73.6, y: -60.3, team: 'blue' },
  ];

  // ---- toggles: yellow bar on top of each wall centre, 26.5 in long; edge = underside colour
  const TOGGLES = [
    { wall: 'top', edge: 'blue' },
    { wall: 'bottom', edge: 'red' },
    { wall: 'left', edge: 'red' },
    { wall: 'right', edge: 'blue' },
  ];

  // ---- game elements
  //   cup:   { type:'cup', x, y, top:'white'|'gray' }        (top = colour of the upper half)
  //   pin:   { type:'pin', x, y, top, bottom }                standing pin seen from above (hexagon)
  //   arm:   { type:'arm', x, y, deg, color }                 pin lying flat, tip pointing at deg (compass)
  const ELEMENTS = [];
  const cup = (x, y, top) => ELEMENTS.push({ type: 'cup', x, y, top });
  const pin = (x, y, top, bottom) => ELEMENTS.push({ type: 'pin', x, y, top, bottom: bottom || top });
  const arm = (x, y, deg, color) => ELEMENTS.push({ type: 'arm', x, y, deg, color });

  // three cups in a row against each wall, yellow pin standing in the middle one
  const GAP = 3.2;
  const WALL_OFFSET = 70.3;
  [-1, 1].forEach((a) => {
    [-1, 1].forEach((b) => {
      const cx = 24 * a;
      const cy = WALL_OFFSET * b; // top / bottom walls
      cup(cx - GAP, cy, 'gray');
      cup(cx, cy, 'gray');
      pin(cx, cy, 'yellow');
      cup(cx + GAP, cy, 'gray');
      const wx = WALL_OFFSET * a; // left / right walls
      const wy = 24 * b;
      cup(wx, wy - GAP, 'gray');
      cup(wx, wy, 'gray');
      pin(wx, wy, 'yellow');
      cup(wx, wy + GAP, 'gray');
    });
  });

  // starbursts on the double diagonal: a cup with four pins lying flat (blue up/right, red left/down)
  [[-48, 48], [-24, 24], [24, -24], [48, -48]].forEach(([x, y]) => {
    cup(x, y, 'white');
    arm(x, y, 0, 'blue');
    arm(x, y, 90, 'blue');
    arm(x, y, 180, 'red');
    arm(x, y, 270, 'red');
  });

  // a yellow pin standing in a cup on the single diagonal
  [[-48, -48], [-24, -24], [24, 24], [48, 48]].forEach(([x, y]) => {
    cup(x, y, 'white');
    pin(x, y, 'yellow');
  });

  // red / blue pins at the diamond points (upper half colour, lower half colour)
  [[0, 24, 'blue', 'red'], [-24, 0, 'red', 'blue'], [24, 0, 'blue', 'red'], [0, -24, 'red', 'blue']].forEach(([x, y, t, b]) => {
    cup(x, y, 'white');
    pin(x, y, t, b);
  });

  Object.assign(NS, {
    FIELD: {
      HALF, TILE, GOALS, GOAL_SIZE, DIAMOND_R, DIAGONAL_FROM, DIAGONAL_TO, DIAGONAL_GAP, BOX,
      LOADERS, TOGGLES, ELEMENTS,
    },
  });
})();
