#!/usr/bin/env node
/* Prints the moments the score should hit: cuts, mouse clicks, caption entries. Used by audio.py. */
const fs = require('fs');
const path = require('path');
const w = {};
new Function('window', fs.readFileSync(path.join(__dirname, 'shots.js'), 'utf8'))(w);
const { SHOTS, CUTS } = w.PROMO;
const clicks = [];
const caps = [];
SHOTS.forEach((s) => {
  (s.mouse || []).forEach((m) => {
    if (m.click) clicks.push({ t: +(s.t0 + m.t + 0.03).toFixed(3), real: m.click === true });
    if (m.drag) clicks.push({ t: +(s.t0 + m.t - m.dur).toFixed(3), real: true });
  });
  if (s.cap) caps.push(+(s.t0 + s.cap.t0).toFixed(3));
});
console.log(JSON.stringify({ cuts: CUTS, clicks, caps, shots: SHOTS.map((s) => ({ id: s.id, t0: s.t0, t1: s.t1 })), total: w.PROMO.TOTAL }, null, 1));
