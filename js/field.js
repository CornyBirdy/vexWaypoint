/*
 * VEX V5 Override field - visual only, nothing here affects the robot.
 *
 * Inches, origin at field centre, +X right, +Y up the screen. Red alliance
 * side on the left, blue on the right (as in the manual's field setup figure). Positions were read off that figure (6 tiles of 24 in, so the
 * playfield is -72..72); they are good to roughly an inch.
 *
 * Everything is plain data below. If something is off, change the numbers.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  const HALF = 72;
  const TILE = 24;

  // ---- goals: 1 tile from one wall, 2 tiles from another. size = flat-to-flat width
  const GOALS = [
    { x: 0, y: 0, kind: 'tall', team: 'neutral', size: 7.2 },
    // neutral short goals (upper-left, lower-right)
    { x: -24, y: 48, kind: 'short', team: 'neutral', size: 6.2 },
    { x: -48, y: 24, kind: 'short', team: 'neutral', size: 6.2 },
    { x: 48, y: -24, kind: 'short', team: 'neutral', size: 6.2 },
    { x: 24, y: -48, kind: 'short', team: 'neutral', size: 6.2 },
    // red alliance goals (lower-left)
    { x: -48, y: -24, kind: 'alliance', team: 'red', size: 6.2 },
    { x: -24, y: -48, kind: 'alliance', team: 'red', size: 6.2 },
    // blue alliance goals (upper-right)
    { x: 24, y: 48, kind: 'alliance', team: 'blue', size: 6.2 },
    { x: 48, y: 24, kind: 'alliance', team: 'blue', size: 6.2 },
  ];

  // ---- floor markings (white tape)
  const DIAMOND_R = 24; // |x| + |y| = 24
  const DIAGONAL_FROM = 58.7; // diagonals run from the corner boxes in to the diamond
  const DIAGONAL_TO = 12;
  const BOX = { x: 58.7, y: 45.9 }; // corner L-box: from the wall to x=58.7 and y=45.9

  // ---- loaders sit on the alliance walls, 12 in from each corner
  const LOADERS = [
    { x: -70.6, y: 60, team: 'red' },
    { x: -70.6, y: -60, team: 'red' },
    { x: 70.6, y: 60, team: 'blue' },
    { x: 70.6, y: -60, team: 'blue' },
  ];

  // ---- toggles: yellow bar on top of each wall centre, ~26 in long
  const TOGGLES = [
    { wall: 'top', x: 0, y: HALF },
    { wall: 'bottom', x: 0, y: -HALF },
    { wall: 'left', x: -HALF, y: 0 },
    { wall: 'right', x: HALF, y: 0 },
  ];

  // ---- game elements
  // cup: {type:'cup', side:'gray'|'clear'}   standing pin: {type:'pin', color}   lying pin: {type:'pin', deg, color}
  const ELEMENTS = [];
  const cup = (x, y, side) => ELEMENTS.push({ type: 'cup', x, y, side });
  const pin = (x, y, color) => ELEMENTS.push({ type: 'pin', x, y, color });
  const lying = (x, y, deg, color) => ELEMENTS.push({ type: 'pin', x, y, deg, color });

  // three cups in a row against each wall, yellow pin standing in the middle one
  const WALL_GAP = 3.3;
  [-1, 1].forEach((a) => {
    [-1, 1].forEach((b) => {
      // top / bottom walls
      const cx = 24 * a;
      const cy = 69.3 * b;
      cup(cx - WALL_GAP, cy, 'gray');
      cup(cx, cy, 'clear');
      pin(cx, cy, 'yellow');
      cup(cx + WALL_GAP, cy, 'gray');
      // left / right walls
      const wx = 69.3 * a;
      const wy = 24 * b;
      cup(wx, wy - WALL_GAP, 'gray');
      cup(wx, wy, 'clear');
      pin(wx, wy, 'yellow');
      cup(wx, wy + WALL_GAP, 'gray');
    });
  });

  // starbursts: a gray cup with four lying pins (blue up/right, red left/down), on the TL-BR diagonal
  [[-48, 48], [-24, 24], [24, -24], [48, -48]].forEach(([x, y]) => {
    cup(x, y, 'gray');
    lying(x, y, 0, 'blue');
    lying(x, y, 90, 'blue');
    lying(x, y, 180, 'red');
    lying(x, y, 270, 'red');
  });

  // single yellow pin in a clear cup, on the other diagonal
  [[-48, -48], [-24, -24], [24, 24], [48, 48]].forEach(([x, y]) => {
    cup(x, y, 'clear');
    pin(x, y, 'yellow');
  });

  // red / blue pins at the diamond points
  [[0, 24, 'blue'], [24, 0, 'blue'], [0, -24, 'red'], [-24, 0, 'red']].forEach(([x, y, c]) => {
    cup(x, y, 'gray');
    pin(x, y, c);
  });

  Object.assign(NS, {
    FIELD: { HALF, TILE, GOALS, DIAMOND_R, DIAGONAL_FROM, DIAGONAL_TO, BOX, LOADERS, TOGGLES, ELEMENTS },
  });
})();
