// Tests for the path -> code flow: start pose, generated code, inserting into user code, and that
// the generated code actually drives the path in the sim. Run with: node tests/flow.test.js
'use strict';
const path = require('path');
const assert = require('assert');
for (const f of ['lemlib', 'paths', 'translate', 'editor', 'export', 'codegen', 'sim']) require(path.join('..', 'js', f + '.js'));
const V = globalThis.VSim;
const E = V.Editor;
const G = V.CodeGen;
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b} +-${tol}`);

(async () => {
  // ---- start pose = first point, facing where the path leaves it
  const pr = new E.Project();
  const p = pr.addPath('Route');
  assert.strictEqual(E.startPose(p), null, 'an empty path has no start');
  E.addSegment(p, 20, 20, true, { x: -30, y: -40 });
  const sp = E.startPose(p);
  assert.deepStrictEqual([sp.x, sp.y], [-30, -40]);
  near(sp.h, (Math.atan2(50, 60) * 180) / Math.PI, 0.1, 'faces the first handle (up-right)');
  near(E.startPose(p, true).h, 39.8 - 180, 0.1, 'backwards faces the other way');

  // ---- generated code
  assert.strictEqual(G.followCall('A_txt', { lookahead: 15, timeout: 4000 }), 'chassis.follow(A_txt, 15, 4000);');
  assert.strictEqual(G.followCall('A_txt', { lookahead: 12.5, timeout: 2500, backwards: true }), 'chassis.follow(A_txt, 12.5, 2500, false);');
  const gen = G.autonomous({ x: -60, y: -60, h: 0 }, 'Route_txt', 'Route.txt', { lookahead: 15, timeout: 4000 });
  assert(/ASSET\(Route_txt\) \/\/ static\/Route\.txt/.test(gen));
  assert(/chassis\.setPose\(-60, -60, 0\);/.test(gen));
  assert(/chassis\.follow\(Route_txt, 15, 4000\);/.test(gen));

  // ---- the generated code runs in the sim and drives the path to its end
  pr.checkpoint();
  E.addSegment(p, 20, 40, false, { x: -30, y: -40 });
  const pts = V.computePathPoints(p, pr.gc);
  const end = pts[pts.length - 1];
  const pose = E.startPose(p);
  const code = G.autonomous(pose, 'Route_txt', 'Route.txt', { lookahead: 15, timeout: 8000 });
  const c = V.compileAuton(code, { language: 'cpp' });
  assert.deepStrictEqual(c.config.assets, ['Route_txt']);
  const res = await V.runSimulation({
    js: c.js,
    robot: { wheelDiameter: 3.25, rpm: 450, speedPct: 90, trackWidth: 12, length: 15, width: 15, responseMs: 80 },
    start: pose,
    cfg: { lateral: V.DEFAULT_LATERAL, angular: V.DEFAULT_ANGULAR, trackWidth: 12, horizontalDrift: 2, pathMode: 'field' },
    paths: [{
      ids: ['Route', 'Route_txt'], name: 'Route', points: pts.map((q) => ({ x: q.x, y: q.y, v: q.v })),
      speedUnit: 'cmd127', ghost: false, endIdx: pts.length - 1, forceField: true,
    }],
    chassisNames: ['chassis'],
    maxMs: 60000,
  });
  assert(res.frames, 'it ran: ' + JSON.stringify(res.events.filter((e) => e.kind === 'error')));
  const n = res.frames.t.length - 1;
  assert(Math.hypot(res.frames.x[n] - end.x, res.frames.y[n] - end.y) < 4, `ended at the path end (${res.frames.x[n]}, ${res.frames.y[n]} vs ${end.x}, ${end.y})`);
  assert(res.motions[0].follow && res.motions[0].reason !== 'timeout', 'finished the path before the timeout');
  console.log('ok generated code follows the path to its end');

  // ---- adding to the user's own code
  const base = '#include "main.h"\n\nASSET(old_txt)\n\nvoid autonomous() {\n    chassis.setPose(0, 0, 0);\n    chassis.moveToPoint(0, 24, 3000); // }\n}\n\nvoid opcontrol() {\n    while (true) { pros::delay(20); }\n}\n';
  const o = { language: 'cpp', assetId: 'Route_txt', fileName: 'Route.txt', pose, lookahead: 15, timeout: 4000 };
  let r = G.insertIntoCode(base, o);
  assert(/ASSET\(old_txt\)\nASSET\(Route_txt\) \/\/ static\/Route\.txt/.test(r.code), 'ASSET goes under the existing one');
  assert(!/setPose\(-30/.test(r.code), 'their setPose is left alone');
  const body = r.code.slice(r.code.indexOf('void autonomous'), r.code.indexOf('void opcontrol'));
  assert(/moveToPoint[^\n]*\n\s+chassis\.follow\(Route_txt, 15, 4000\);\n\s+chassis\.waitUntilDone\(\);\n}/.test(body), 'follow lands at the end of autonomous()\n' + body);
  assert(/void opcontrol/.test(r.code), 'the rest is untouched');
  r = G.insertIntoCode(r.code, o);
  assert.strictEqual((r.code.match(/ASSET\(Route_txt\)/g) || []).length, 1, 'ASSET is not added twice');

  r = G.insertIntoCode('', o);
  assert(/ASSET\(Route_txt\)/.test(r.code) && /void autonomous\(\) \{\n\s+chassis\.setPose\(-30, -40, 39\.8/.test(r.code), 'empty code gets a whole autonomous()\n' + r.code);

  r = G.insertIntoCode('#include "main.h"\nvoid autonomous() {\n}\n', o);
  assert(/\{\n\s+chassis\.setPose\([^\n]+\n\s+chassis\.follow/.test(r.code), 'setPose added when the code never sets one\n' + r.code);
  assert(r.notes.some((x) => /setPose/.test(x)));

  // the result compiles and runs as a whole
  const c2 = V.compileAuton(r.code, { language: 'cpp' });
  assert.deepStrictEqual(c2.warnings, []);

  console.log('ALL FLOW TESTS PASSED');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
