// Headless tests for the Tune module (real-robot pose logs). Run with: node tests/tune.test.js
'use strict';
const path = require('path');
const assert = require('assert');
for (const f of ['lemlib', 'templates', 'paths', 'translate', 'sim', 'tune']) require(path.join('..', 'js', f + '.js'));
const V = globalThis.VSim;
const T = V.Tune;

const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b} +-${tol}`);

/**
 * A fake robot with the same motor model the sim uses (dv/dt = (u vmax - v)/tau per side),
 * driven by a simple P controller through: drive 24 in, turn 90, drive 12 in.
 * Returns the CSV pose_log.hpp would write.
 */
function fakeRun({ vmax = 60, tau = 0.09, track = 13, overshootGain = 1 } = {}) {
  const dt = 0.001;
  let x = 0, y = 0, h = 0, vL = 0, vR = 0;
  const rows = [];
  const steps = [
    { kind: 'drive', d: 24, ms: 1500 },
    { kind: 'idle', ms: 300 },
    { kind: 'turn', a: 90, ms: 1200 },
    { kind: 'idle', ms: 300 },
    { kind: 'drive', d: 12, ms: 1200 },
    { kind: 'idle', ms: 400 },
  ];
  let t = 0;
  let mark = 'start';
  for (const s of steps) {
    const x0 = x, y0 = y, h0 = h;
    for (let k = 0; k < s.ms; k++) {
      let uL = 0, uR = 0;
      if (s.kind === 'drive') {
        const along = (x - x0) * Math.sin(h0) + (y - y0) * Math.cos(h0);
        const u = Math.max(-1, Math.min(1, 0.05 * overshootGain * (s.d - along)));
        uL = uR = u;
      } else if (s.kind === 'turn') {
        const err = s.a - ((h - h0) * 180) / Math.PI;
        const u = Math.max(-1, Math.min(1, 0.006 * overshootGain * err));
        uL = u;
        uR = -u;
      }
      vL += ((uL * vmax - vL) * dt) / tau;
      vR += ((uR * vmax - vR) * dt) / tau;
      const v = (vL + vR) / 2;
      const w = (vL - vR) / track;
      x += Math.sin(h) * v * dt;
      y += Math.cos(h) * v * dt;
      h += w * dt;
      if (t % 10 === 0) {
        rows.push(`${t},${x.toFixed(3)},${y.toFixed(3)},${((h * 180) / Math.PI).toFixed(2)},${s.kind === 'idle' ? 0 : 1},${Math.round(uL * 12000)},${Math.round(uR * 12000)},${mark}`);
        mark = '';
      }
      t++;
    }
  }
  return [
    '# waypoint-poselog v1',
    '# label=test',
    '# sample_ms=10',
    '# battery_mv=12800 battery_pct=95',
    '# lateral kP=10 kI=0 kD=3 windup=3 smallError=1 smallErrorTimeout=100 largeError=3 largeErrorTimeout=500 slew=20',
    't_ms,x,y,theta,moving,left_mv,right_mv,mark',
    ...rows,
  ].join('\n');
}

(async () => {
  // ---- parsing: SD-card CSV
  const csv = fakeRun();
  assert(T.isPoseLog(csv), 'CSV detected as a pose log');
  let p = T.parsePoseLog(csv, 'plog001.csv');
  assert.strictEqual(p.runs.length, 1, 'one run');
  const run = p.runs[0];
  assert.strictEqual(run.label, 'test');
  assert.strictEqual(run.meta.battery_pct, 95);
  assert.strictEqual(run.meta.lateral.kP, 10);
  assert(run.hasVolts, 'voltage columns read');
  assert.strictEqual(run.marks[0].text, 'start');
  console.log('ok parse CSV');

  // ---- parsing: terminal capture with other output, two runs, one cut off
  const body = csv.split('\n');
  const term = ['Lift reset', '#POSELOG BEGIN', ...body, '#POSELOG END', 'random printf 1,2', '#POSELOG BEGIN', ...body.slice(0, 50)].join('\r\n');
  assert(T.isPoseLog(term), 'terminal capture detected');
  p = T.parsePoseLog(term, 'run.txt');
  assert.strictEqual(p.runs.length, 2, 'two runs in the capture');
  assert(!p.runs[0].cut && p.runs[1].cut, 'second run marked cut off');
  assert(p.warnings.some((w) => /cut off/.test(w)), 'cut-off warning');
  assert.strictEqual(p.runs[0].t.length, run.t.length, 'same rows as the CSV');
  assert(!T.isPoseLog('#PATH-POINTS-START Path\n1,2,3'), 'path file is not a pose log');
  console.log('ok parse terminal capture');

  // ---- segments
  const segs = T.segments(run);
  assert.strictEqual(segs.length, 3, `3 motions, got ${segs.length}`);
  assert.deepStrictEqual(segs.map((s) => s.kind), ['drive', 'turn', 'drive']);
  near(segs[0].dist, 24, 0.5, 'first drive distance');
  near(segs[1].dh, 90, 2, 'turn angle');
  assert(segs[0].riseMs > 100 && segs[0].riseMs < 1500, 'rise time measured');
  const hot = T.segments(T.parsePoseLog(fakeRun({ overshootGain: 4 })).runs[0]);
  assert(hot[1].overshoot > segs[1].overshoot + 1, `hotter turn gains overshoot more (${hot[1].overshoot} vs ${segs[1].overshoot})`);
  console.log('ok segments');

  // ---- drivetrain fit recovers the motor model
  const robot = { rpm: 450, wheelDiameter: 3.25 };
  const fit = T.fitDrive(run, robot);
  assert(fit.ok, 'fit ok: ' + fit.why);
  near(fit.vmax, 60, 3, 'fitted top speed');
  near(fit.responseMs, 90, 15, 'fitted motor response');
  near(fit.trackWidth, 13, 1.5, 'fitted track width');
  const theory = (450 / 60) * Math.PI * 3.25;
  near(fit.speedPct, (60 / theory) * 100, 4, 'speed %');
  console.log(`ok fit: ${fit.vmax.toFixed(1)} in/s, ${fit.responseMs.toFixed(0)} ms, track ${fit.trackWidth.toFixed(1)} in`);

  // ---- compare against a real sim run of the same moves
  const code = 'chassis.setPose(0,0,0);\nchassis.moveToPoint(0, 24, 2000);\nchassis.turnToHeading(90, 2000);\nchassis.moveToPoint(12, 24, 2000);';
  const c = V.compileAuton(code, { language: 'cpp' });
  const res = await V.runSimulation({
    js: c.js,
    robot: { wheelDiameter: 3.25, rpm: 450, speedPct: 90, trackWidth: 12, length: 15, width: 15, responseMs: 80 },
    start: { x: 0, y: 0, h: 0 },
    cfg: { lateral: V.DEFAULT_LATERAL, angular: V.DEFAULT_ANGULAR, trackWidth: 12, horizontalDrift: 2, pathMode: 'field' },
    paths: [],
    chassisNames: ['chassis'],
    maxMs: 20000,
  });
  const cmp = T.compare(run, res.frames, res.motions);
  assert(cmp, 'comparison made');
  near(cmp.realEnd.x, 12, 1.5, 'real end x');
  near(cmp.simEnd.x, 12, 1.5, 'sim end x');
  assert(cmp.endErr < 3, `end error small (${cmp.endErr})`);
  assert.strictEqual(cmp.perMotion.length, 3, 'one row per sim motion');
  console.log(`ok compare: mean ${cmp.meanErr.toFixed(1)} in, max ${cmp.maxErr.toFixed(1)} in`);

  // ---- report
  const md = T.report(run, segs, cmp, fit, { settings: { robot: { ...robot, speedPct: 90, trackWidth: 12, responseMs: 80 } }, code, frames: res.frames });
  assert(/# Waypoint tune report/.test(md) && /## Real motions/.test(md) && /```csv/.test(md), 'report sections');
  assert(md.includes('moveToPoint(0, 24'), 'report includes the code');
  console.log('ok report');

  console.log('\nall tune tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
