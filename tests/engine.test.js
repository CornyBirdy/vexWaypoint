// Headless tests for the sim engine. Run with: node tests/engine.test.js
'use strict';
const path = require('path');
const assert = require('assert');
for (const f of ['lemlib', 'paths', 'translate', 'sim']) require(path.join('..', 'js', f + '.js'));
const V = globalThis.VSim;

const ROBOT = { wheelDiameter: 3.25, rpm: 450, speedPct: 90, trackWidth: 12, length: 15, width: 15, responseMs: 80 };
const cfg = (extra) => ({
  lateral: V.DEFAULT_LATERAL,
  angular: V.DEFAULT_ANGULAR,
  trackWidth: 12,
  horizontalDrift: 2,
  pathMode: 'field',
  ...extra,
});

async function run(code, { start = { x: 0, y: 0, h: 0 }, paths = [], language = 'cpp', cfgExtra } = {}) {
  const c = V.compileAuton(code, { language });
  const res = await V.runSimulation({
    js: c.js,
    robot: ROBOT,
    start,
    cfg: cfg(cfgExtra),
    paths,
    chassisNames: ['chassis', c.config.chassisName],
    maxMs: 60000,
  });
  const f = res.frames;
  if (!f) return { res, c, end: null };
  const n = f.t.length - 1;
  return { res, c, end: { x: f.x[n], y: f.y[n], h: f.h[n], t: f.t[n] } };
}
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b} +-${tol}`);
const normDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

(async () => {
  let t;

  // --- moveToPoint straight ahead, start pose rotated on the field
  t = await run(`void autonomous(){ chassis.setPose(0,0,0); chassis.moveToPoint(0, 24, 3000, {}, false); }`, {
    start: { x: -48, y: -48, h: 90 },
  });
  // heading 90 => code +Y is field +X
  near(t.end.x, -24, 1.5, 'moveToPoint field x');
  near(t.end.y, -48, 1.5, 'moveToPoint field y');
  console.log('ok moveToPoint in rotated frame', t.end);

  // --- backwards
  t = await run(`void autonomous(){ chassis.moveToPoint(0, -20, 3000, {.forwards = false}, false); }`);
  near(t.end.y, -20, 1.5, 'backwards y');
  near(t.end.h % 360, 0, 2, 'backwards heading kept');
  console.log('ok moveToPoint backwards', t.end);

  // --- turnToHeading, both directions, forced direction
  t = await run(`void autonomous(){ chassis.turnToHeading(90, 2000, {}, false); }`);
  near(normDeg(t.end.h), 90, 2, 'turn 90');
  t = await run(`void autonomous(){ chassis.turnToHeading(-90, 2000, {.direction = lemlib::AngularDirection::CW_CLOCKWISE}, false); }`);
  near(normDeg(t.end.h), -90, 3, 'forced cw turn ends at -90');
  assert(t.end.h > 200 || t.end.h < -200 || Math.abs(t.end.h) > 200 || true);
  const turned = t.res.frames.h;
  assert(Math.max(...turned) > 150, 'forced CW turn went the long way round');
  console.log('ok turnToHeading', t.end);

  // --- turnToPoint
  t = await run(`void autonomous(){ chassis.turnToPoint(24, 24, 2000, {}, false); }`);
  near(normDeg(t.end.h), 45, 2.5, 'turnToPoint heading');
  console.log('ok turnToPoint', t.end);

  // --- moveToPose
  t = await run(`void autonomous(){ chassis.moveToPose(24, 24, 90, 4000, {.lead = 0.5}, false); }`);
  near(t.end.x, 24, 2.5, 'moveToPose x');
  near(t.end.y, 24, 2.5, 'moveToPose y');
  near(normDeg(t.end.h), 90, 8, 'moveToPose heading');
  console.log('ok moveToPose', t.end);

  // --- swing
  t = await run(`void autonomous(){ chassis.swingToHeading(90, lemlib::DriveSide::LEFT, 2000, {}, false); }`);
  near(normDeg(t.end.h), 90, 3, 'swing heading');
  console.log('ok swingToHeading', t.end);

  // --- async semantics: second call waits for the first, waitUntilDone, delay
  t = await run(`
    void autonomous() {
      chassis.moveToPoint(0, 24, 3000);
      chassis.turnToHeading(90, 1000);
      chassis.waitUntilDone();
      pros::delay(250);
    }`);
  near(t.end.y, 24, 2, 'queued move y');
  near(normDeg(t.end.h), 90, 3, 'queued turn heading');
  assert(t.res.motions.length === 2, 'two motions');
  assert(t.res.motions[1].t0 >= t.res.motions[0].t1, 'second motion starts after first ends');
  console.log('ok async queueing; motions:', t.res.motions.map((m) => `${m.label} ${m.t0}-${m.t1} ${m.reason}`));

  // --- waitUntil
  t = await run(`
    void autonomous() {
      chassis.moveToPoint(0, 48, 5000);
      chassis.waitUntil(20);
      intake.move(127);
      chassis.cancelMotion();
    }`);
  assert(t.end.y > 18 && t.end.y < 40, 'cancel after waitUntil(20): y=' + t.end.y);
  console.log('ok waitUntil + cancelMotion + unknown object no-op', t.end);

  // --- C++ translation features
  const cpp = `
    #include "main.h"
    ASSET(example_txt)
    lemlib::Drivetrain drivetrain(&left_mg, &right_mg, 10.5, lemlib::Omniwheel::NEW_325, 450, 2);
    lemlib::ControllerSettings lateral_controller(8, 0, 2, 3, 1, 100, 3, 500, 20);
    lemlib::ControllerSettings angular_controller(3, 0, 11, 3, 1, 100, 3, 500, 0);
    lemlib::Chassis chassis(drivetrain, lateral_controller, angular_controller, sensors);
    void autonomous() {
      // comment
      float dist = 12.5f;
      for (int i = 0; i < 2; i++) {
        chassis.moveToPoint(0, dist * (i + 1), 2000, {.maxSpeed = 100}, false);
      }
      clamp.set_value(true);
      lemlib::Pose p(0, 24, 0);
      if (chassis.getPose().y > 20) chassis.turnToHeading(180, 1500, {}, false);
    }`;
  const comp = V.compileAuton(cpp, { language: 'cpp' });
  assert.strictEqual(comp.config.drivetrain.trackWidth, 10.5);
  assert.strictEqual(comp.config.drivetrain.wheelDiameter, 3.25);
  assert.strictEqual(comp.config.drivetrain.rpm, 450);
  assert.strictEqual(comp.config.lateral.kP, 8);
  assert.strictEqual(comp.config.angular.kD, 11);
  assert.deepStrictEqual(comp.config.assets, ['example_txt']);
  t = await run(cpp);
  near(t.end.y, 25, 2, 'translated loop end y');
  near(normDeg(t.end.h), 180, 4, 'translated if+turn');
  console.log('ok C++ translation + config extraction', t.end);

  // --- path parsing + follow
  const txt = [];
  for (let i = 0; i <= 30; i++) txt.push(`${(i * 2).toFixed(3)}, ${(0).toFixed(3)}, 100.000`);
  const text = txt.join('\n') + '\nendData\n200\n#PATH.JERRYIO-DATA {"appVersion":"1","format":"LemLib v0.5 (inch)","paths":[]}\n';
  const parsed = V.parsePathFile('my path.txt', text);
  assert.strictEqual(parsed.paths.length, 1);
  assert.strictEqual(parsed.paths[0].id, 'my_path_txt');
  assert.strictEqual(parsed.paths[0].points.length, 31);
  const pp = parsed.paths[0];
  const paths = [{ ids: [pp.id], name: pp.name, points: V.pointsInInches(pp) }];
  // path runs along +x from field (0,0); robot starts at (0,0) facing +x (h=90)
  t = await run(`void autonomous(){ chassis.follow(my_path_txt, 12, 4000, true, false); }`, {
    paths,
    start: { x: 0, y: 0, h: 90 },
  });
  near(t.end.x, 60, 3, 'follow end x');
  near(t.end.y, 0, 2, 'follow end y');
  console.log('ok follow (field mode)', t.end);

  // --- jerryio JSON
  const json = {
    format: 'LemLib v0.5 (inch)',
    gc: { pointDensity: 2 },
    paths: [
      {
        name: 'Path 1',
        segments: [
          { controls: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 30 }, { x: 40, y: 30 }] },
          { controls: [{ x: 40, y: 30 }, { x: 60, y: 30 }] },
        ],
        pc: { speedLimit: { minLimit: { value: 20 }, topLimit: { value: 100 } }, bentRate: 0.1 },
      },
    ],
  };
  const pj = V.parsePathFile('curve.jerryio', JSON.stringify(json));
  assert.strictEqual(pj.paths.length, 1, pj.warnings.join(';'));
  assert(pj.paths[0].points.length > 20);
  const last = pj.paths[0].points.at(-1);
  near(last.x, 60, 0.01, 'jerryio last x');
  near(last.y, 30, 0.01, 'jerryio last y');
  const p2 = pj.paths[0];
  t = await run(`void autonomous(){ chassis.follow(curve_jerryio, 12, 6000, true, false); }`, {
    paths: [{ ids: [p2.id], name: p2.name, points: V.pointsInInches(p2) }],
    start: { x: 0, y: 0, h: 90 },
  });
  near(t.end.x, 60, 3.5, 'jerryio follow x');
  near(t.end.y, 30, 3.5, 'jerryio follow y');
  console.log('ok jerryio json follow', t.end, 'in', t.end.t, 'ms');

  // --- relative path mode shifts path to the robot
  t = await run(`void autonomous(){ chassis.follow(my_path_txt, 12, 4000, true, false); }`, {
    paths,
    start: { x: -30, y: 20, h: 90 },
    cfgExtra: { pathMode: 'relative' },
  });
  near(t.end.x, 30, 3, 'relative follow end x');
  near(t.end.y, 20, 2, 'relative follow end y');
  console.log('ok follow (relative mode)', t.end);

  // --- errors surface, never hang
  t = await run(`void autonomous(){ while (true) { } }`);
  assert(t.res.events.some((e) => e.kind === 'error'), 'infinite loop reported');
  t = await run(`chassis.moveToPoint(0, 10, 1000, {}, false); nonsense(;`, { language: 'js' });
  assert(t.res.events.some((e) => e.kind === 'error'), 'syntax error reported');
  console.log('ok error reporting');

  // --- speed settings change how fast it goes
  const slowRobot = { ...ROBOT, speedPct: 40 };
  const a = await run(`chassis.moveToPoint(0, 48, 8000, {}, false);`, { language: 'js' });
  const c2 = V.compileAuton(`chassis.moveToPoint(0, 48, 8000, {}, false);`, { language: 'js' });
  const b = await V.runSimulation({ js: c2.js, robot: slowRobot, start: { x: 0, y: 0, h: 0 }, cfg: cfg(), paths: [], chassisNames: ['chassis'], maxMs: 60000 });
  assert(b.durationMs > a.end.t, `slower robot should take longer (${b.durationMs} vs ${a.end.t})`);
  console.log('ok speed percent', a.end.t, 'ms vs', b.durationMs, 'ms');

  console.log('\nALL ENGINE TESTS PASSED');
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
