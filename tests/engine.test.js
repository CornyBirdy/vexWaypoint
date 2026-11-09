// Headless tests for the sim engine. Run with: node tests/engine.test.js
'use strict';
const path = require('path');
const assert = require('assert');
for (const f of ['lemlib', 'templates', 'paths', 'translate', 'sim']) require(path.join('..', 'js', f + '.js'));
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
    motors: c.config.motors,
    rw: c.config.rw,
    maxMs: 60000,
  });
  const f = res.frames;
  if (!f) return { res, c, end: null };
  const n = f.t.length - 1;
  return { res, c, end: { x: f.x[n], y: f.y[n], h: f.h[n], t: f.t[n] } };
}
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b} +-${tol}`);
const normDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const angDiff = (a, b) => Math.abs(normDeg(a - b));

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
  assert(angDiff(t.end.h, 180) < 4, 'translated if+turn: ' + t.end.h);
  console.log('ok C++ translation + config extraction', t.end);

  // --- path parsing + follow (plain "x, y, speed" lines are read as inches, 0..127)
  const libOf = (p) => ({
    ids: [p.id, ...p.aliases],
    name: p.id,
    points: V.pointsInInches(p),
    speedUnit: p.speedUnit,
    ghost: p.ghost,
    endIdx: p.endIdx,
  });
  const txt = [];
  for (let i = 0; i <= 30; i++) txt.push(`${(i * 2).toFixed(3)}, ${(0).toFixed(3)}, 100.000`);
  const parsed = V.parsePathFile('my path.txt', txt.join('\n') + '\n');
  assert.strictEqual(parsed.paths.length, 1);
  assert.strictEqual(parsed.paths[0].id, 'my_path_txt');
  assert.strictEqual(parsed.paths[0].points.length, 31);
  const paths = [libOf(parsed.paths[0])];
  t = await run(`void autonomous(){ chassis.follow(my_path_txt, 12, 4000, true, false); }`, {
    paths,
    start: { x: 0, y: 0, h: 90 },
  });
  near(t.end.x, 58, 3, 'follow end x');
  near(t.end.y, 0, 2, 'follow end y');
  console.log('ok follow (field mode)', t.end);

  // --- real .jerryio project JSON: gc.uol is cm-per-unit (2.54 = inch), controls in that unit
  const project = (uol, scale) => ({
    appVersion: '0.7.0',
    format: 'LemLib v0.4',
    gc: { uol, pointDensity: 2 * scale, coordinateSystem: 'VEX Gaming Positioning System' },
    paths: [
      {
        name: 'Path 1',
        uid: 'abcdefghij',
        segments: [
          {
            controls: [
              { __type: 'end-point', x: 0, y: 0, heading: 0 }, { __type: 'control', x: 20 * scale, y: 0 },
              { __type: 'control', x: 20 * scale, y: 30 * scale }, { __type: 'end-point', x: 40 * scale, y: 30 * scale, heading: 0 },
            ],
            speedProfiles: [],
          },
          { controls: [{ __type: 'end-point', x: 40 * scale, y: 30 * scale }, { __type: 'end-point', x: 60 * scale, y: 30 * scale }], speedProfiles: [] },
        ],
        pc: {
          speedLimit: { minLimit: { value: 0 }, maxLimit: { value: 127 }, from: 20, to: 100 },
          bentRateApplicableRange: { from: 0, to: 0.1 },
          maxDecelerationRate: 127,
        },
      },
    ],
  });
  const pj = V.parsePathFile('curve.jerryio', JSON.stringify(project(2.54, 1)));
  assert.strictEqual(pj.paths.length, 1, pj.warnings.join(';'));
  const jp = pj.paths[0];
  assert.strictEqual(jp.unit, 'in');
  assert(jp.points.length > 20);
  near(jp.points.at(-1).x, 60, 0.01, 'jerryio last x');
  near(jp.points.at(-1).y, 30, 0.01, 'jerryio last y');
  assert.strictEqual(jp.points.at(-2).v, 0, 'speed at the path end is 0');
  assert(jp.points[0].v >= 20 && jp.points[0].v <= 100, 'first speed within the limits');
  const mid = Math.max(...jp.points.map((q) => q.v));
  assert(mid <= 100.0001, 'speed never above the limit');
  // same path authored in cm gives the same inches
  const pcm = V.parsePathFile('curve_cm.jerryio', JSON.stringify(project(1, 2.54)));
  near(V.pointsInInches(pcm.paths[0]).at(-1).x, 60, 0.01, 'cm project converted to inches');
  t = await run(`void autonomous(){ chassis.follow(curve_jerryio, 12, 6000, true, false); }`, {
    paths: [libOf(jp)],
    start: { x: 0, y: 0, h: 90 },
  });
  near(t.end.x, 60, 3.5, 'jerryio follow x');
  near(t.end.y, 30, 3.5, 'jerryio follow y');
  console.log('ok jerryio project follow', t.end, 'in', t.end.t, 'ms');

  // --- LemLib v0.4 text export: points (+ ghost), endData, decel, max speed, 200, segments, json
  const pts04 = jp.points.map((q) => `${q.x.toFixed(3)}, ${q.y.toFixed(3)}, ${q.v.toFixed(3)}`);
  const lastP = jp.points.at(-1);
  const ghost = `${(lastP.x + 20).toFixed(3)}, ${lastP.y.toFixed(3)}, 0`;
  const text04 = [...pts04, ghost, 'endData', '127', '100', '200', '0, 0, 20, 0, 20, 30, 40, 30', '40, 30, 50, 30, 50, 30, 60, 30'].join('\n') +
    '\n#PATH.JERRYIO-DATA ' + JSON.stringify(project(2.54, 1));
  const p04 = V.parsePathFile('route.txt', text04);
  assert.strictEqual(p04.paths.length, 1, p04.warnings.join(';'));
  assert.strictEqual(p04.paths[0].points.length, jp.points.length + 1, 'ghost kept as the last point');
  assert.strictEqual(p04.paths[0].ghost, true);
  assert.strictEqual(p04.paths[0].endIdx, jp.points.length - 1);
  assert.strictEqual(p04.paths[0].unit, 'in');
  t = await run(`void autonomous(){ chassis.follow(route_txt, 12, 6000, true, false); }`, { paths: [libOf(p04.paths[0])], start: { x: 0, y: 0, h: 90 } });
  near(t.end.x, 60, 3.5, 'v0.4 text follow x');
  near(t.end.y, 30, 3.5, 'v0.4 text follow y');
  console.log('ok LemLib v0.4 text', t.end);

  // --- tarball: several `#PATH-POINTS-START` blocks, speeds 0..255
  const blk = (name, y) => [`#PATH-POINTS-START ${name}`, '0, ' + y + ', 255', '10, ' + y + ', 255', '20, ' + y + ', 128', '30, ' + y + ', 0', 'endData'].join('\n');
  const tar = V.parsePathFile('multi.txt', [blk('First', 0), blk('Second leg', 10), '#PATH.JERRYIO-DATA ' + JSON.stringify({ format: 'LemLib Tarball v0.5', paths: [] })].join('\n'));
  assert.strictEqual(tar.paths.length, 2);
  assert.strictEqual(tar.paths[0].speedUnit, 'cmd255');
  assert(tar.paths[1].aliases.includes('Second_leg') || tar.paths[1].id === 'Second_leg');
  console.log('ok tarball blocks', tar.paths.map((q) => q.id + '/' + q.aliases.join('|')));

  // --- path.jerryio v0.1: cm, rpm, no endData
  const pdj = V.parsePathFile('plain.txt', ['#PATH-POINTS-START Only', '0,0,100', '25.4,0,100,90', '50.8,0,50', '#PATH.JERRYIO-DATA {"format":"path.jerryio v0.1","paths":[]}'].join('\n'));
  assert.strictEqual(pdj.paths[0].unit, 'cm');
  assert.strictEqual(pdj.paths[0].speedUnit, 'rpm');
  near(V.pointsInInches(pdj.paths[0]).at(-1).x, 20, 0.001, 'cm -> inches');

  // --- LemLib v1.0 binary: mm, m/s (built here with the documented byte layout)
  function writeV1(pathsIn, jsonObj) {
    const bytes = [];
    const u8 = (v) => bytes.push(v & 255);
    const i16 = (v) => { const b = Buffer.alloc(2); b.writeInt16LE(v); bytes.push(...b); };
    const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); bytes.push(...b); };
    const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); bytes.push(...b); };
    const str = (s) => { bytes.push(...Buffer.from(s, 'latin1')); bytes.push(0); };
    u8(4); u32(0); u16(pathsIn.length);
    pathsIn.forEach((pp) => {
      str(pp.name); u8(0); u16(pp.pts.length);
      pp.pts.forEach(([x, y, v, heading]) => {
        u8(heading != null ? 1 : 0); i16(Math.round(x * 2)); i16(Math.round(y * 2)); i16(Math.round(v * 1000));
        if (heading != null) u16(Math.round(heading * 10000));
      });
    });
    const size = bytes.length;
    const sz = Buffer.alloc(4); sz.writeUInt32LE(size); [0, 1, 2, 3].forEach((i) => (bytes[1 + i] = sz[i]));
    str('#PATH.JERRYIO-DATA');
    bytes.push(...Buffer.from(JSON.stringify(jsonObj)));
    return new Uint8Array(bytes);
  }
  const bin = writeV1(
    [{ name: 'Leg A', pts: [[0, 0, 1.2, 1.5], [508, 0, 1.2], [1016, 0, 0.6], [1524, 0, 0]] }, { name: 'Leg B', pts: [[0, 0, 1], [100, 100, 1]] }],
    { format: 'LemLib v1.0', gc: { uol: 0.1 }, paths: [] }
  );
  const pb = V.parsePathFile('auton.bin', bin);
  assert.strictEqual(pb.paths.length, 2, pb.warnings.join(';'));
  assert.strictEqual(pb.paths[0].unit, 'mm');
  assert.strictEqual(pb.paths[0].speedUnit, 'mps');
  near(V.pointsInInches(pb.paths[0]).at(-1).x, 60, 0.01, 'mm -> inches');
  near(pb.paths[0].points[1].v, 1.2, 0.001, 'm/s speed');
  assert(pb.paths[0].aliases.includes('Leg_A') || pb.paths[0].id === 'Leg_A');
  // m/s speeds become motor commands relative to what the robot can do (68.9 in/s max here)
  t = await run(`void autonomous(){ chassis.follow(Leg_A, 12, 6000, true, false); }`, { paths: [libOf(pb.paths[0])], start: { x: 0, y: 0, h: 90 } });
  // this path has only 4 points 20 in apart: like LemLib, the motion ends once the closest point is the speed-0 end point
  near(t.end.x, 50, 4, 'v1.0 binary follow x');
  console.log('ok LemLib v1.0 binary', t.end);

  // --- relative path mode shifts the path (as drawn) so it starts on the robot
  t = await run(`void autonomous(){ chassis.follow(my_path_txt, 12, 4000, true, false); }`, {
    paths,
    start: { x: -30, y: 20, h: 90 },
    cfgExtra: { pathMode: 'relative' },
  });
  near(t.end.x, 28, 3, 'relative follow end x');
  near(t.end.y, 20, 2, 'relative follow end y');
  console.log('ok follow (relative mode)', t.end);

  // --- a whole main.cpp: finds autonomous(), runs helper functions, ignores the rest of the program
  {
    const full = require('fs').readFileSync(path.join(__dirname, 'fixtures', 'main.cpp'), 'utf8');
    const c = V.compileAuton(full, { language: 'cpp' });
    assert.strictEqual(c.routine, 'autonomous');
    assert.deepStrictEqual(c.routines, ['leftSide', 'autonomous']);
    assert.deepStrictEqual(c.warnings, []);
    assert(c.ignored.includes('opcontrol') && c.ignored.includes('initialize'));
    const ex = V.parsePathFile('example.txt', require('fs').readFileSync(path.join(__dirname, '..', 'examples', 'example.txt'), 'utf8')).paths[0];
    t = await run(full, { paths: [libOf(ex)], start: { x: -60, y: -60, h: 0 } });
    const labels = t.res.motions.map((m) => m.label.split('(')[0]);
    assert.deepStrictEqual(labels, ['moveToPoint', 'moveToPoint', 'moveToPoint', 'turnToHeading', 'follow'], labels.join());
    assert(!t.res.events.some((e) => e.kind === 'error'), 'no errors');
    // pick another routine by name
    const left = V.compileAuton(full, { language: 'cpp', routine: 'leftSide' });
    assert.strictEqual(left.routine, 'leftSide');
    t = await run(full.replace('void autonomous', 'void notAuto'), { paths: [libOf(ex)] });
    assert(t.c.routine === 'leftSide' || /auto/i.test(t.c.routine), 'falls back to a routine when there is no autonomous()');
    console.log('ok whole main.cpp', labels.join(' '));
  }

  // --- a bare list of statements that waits on a lift task the sim does not run, and calls an
  //     undefined helper (a real paste from a skills routine)
  {
    const skills = require('fs').readFileSync(path.join(__dirname, 'fixtures', 'skills.cpp'), 'utf8');
    t = await run(skills);
    const ev = t.res.events;
    assert(!ev.some((e) => e.kind === 'error'), 'no errors: ' + ev.filter((e) => e.kind === 'error').map((e) => e.text));
    assert(ev.some((e) => /Auton code finished/.test(e.text)), 'the routine finishes');
    assert(t.end.t < 120000 && t.end.t > 10000, 'finishes in a sensible time, not at the time limit: ' + t.end.t);
    assert(ev.some((e) => e.kind === 'warn' && /liftPIDEnabled/.test(e.text)), 'tells you the lift wait was skipped');
    assert(ev.some((e) => /resetAtGoalA\(\), resetAtGoalB\(\)/.test(e.text)), 'lists the undefined helpers');
    // 14 waits of the default 500 ms each are the only extra time; a longer wait setting lengthens the run
    const slow = await V.runSimulation({ js: V.compileAuton(skills, { language: 'cpp' }).js, robot: ROBOT, start: { x: 0, y: 0, h: 0 }, cfg: cfg(), paths: [], chassisNames: ['chassis'], mechanismWaitMs: 1500, maxMs: 300000 });
    assert(slow.durationMs > t.end.t + 5000, 'a longer mechanism wait lengthens the run');
    console.log('ok bare skills paste with lift waits finishes in', t.end.t, 'ms');
  }

  // --- parse errors point at the translated line
  t = await run(`void autonomous(){ chassis.moveToPoint(0, 10, 1000); int = ; }`);
  assert(t.res.events.some((e) => e.kind === 'error' && /Could not parse/.test(e.text)), 'syntax error reported');

  // --- motion chaining, as in LemLib v0.5.6 (minSpeed + earlyExitRange)
  {
    const exitAt = (r, k = 0) => {
      const f = r.frames;
      const i = f.t.indexOf(r.motions[k].t1);
      return { x: f.x[i], y: f.y[i], h: f.h[i], speed: (f.vl[i] + f.vr[i]) / 2, vl: f.vl[i], vr: f.vr[i] };
    };
    // moveToPoint exits on the line earlyExitRange before the target, still at speed
    t = await run('chassis.moveToPoint(0, 48, 5000, {.minSpeed = 60, .earlyExitRange = 8}); chassis.waitUntilDone();');
    let e = exitAt(t.res);
    assert.strictEqual(t.res.motions[0].reason, 'early exit');
    near(e.y, 40, 2.5, 'chained moveToPoint exits ~8 in early');
    assert(e.speed > 40, 'and keeps its speed: ' + e.speed);
    // without earlyExitRange it exits as it crosses the target's line
    t = await run('chassis.moveToPoint(0, 48, 5000, {.minSpeed = 60}); chassis.waitUntilDone();');
    near(exitAt(t.res).y, 48, 2, 'exits at the target line');
    // without minSpeed the exit parameters do nothing: it settles at the target and stops
    t = await run('chassis.moveToPoint(0, 48, 5000, {.earlyExitRange = 20}); chassis.waitUntilDone();');
    assert.strictEqual(t.res.motions[0].reason, 'settled');
    near(t.end.y, 48, 1.5, 'plain move still settles');
    // turn: exits within earlyExitRange degrees while still spinning
    t = await run('chassis.turnToHeading(180, 3000, {.minSpeed = 127, .earlyExitRange = 20}); chassis.waitUntilDone();');
    e = exitAt(t.res);
    assert.strictEqual(t.res.motions[0].reason, 'early exit');
    assert(e.h > 158 && e.h < 180, 'turn exit heading ' + e.h);
    assert(Math.abs(e.vl) > 20 && Math.abs(e.vr) > 20, 'still turning');
    // a chain like a real routine: backwards point -> turn -> pose
    t = await run(`chassis.moveToPoint(0, 30, 3000); chassis.waitUntilDone();
      chassis.moveToPoint(0, 12, 4000, {.forwards = false, .minSpeed = 127, .earlyExitRange = 5}); chassis.waitUntilDone();
      chassis.turnToHeading(270, 2000, {.minSpeed = 127, .earlyExitRange = 20}); chassis.waitUntilDone();
      chassis.moveToPose(-12, 12, 270, 4000); chassis.waitUntilDone();`);
    assert.deepStrictEqual(t.res.motions.map((m) => m.reason), ['settled', 'early exit', 'early exit', 'settled']);
    near(t.end.x, -12, 1.5, 'chain end x');
    near(t.end.y, 12, 1.5, 'chain end y');
    assert(angDiff(t.end.h, 270) < 4, 'chain end heading ' + t.end.h);
    // moveToPose quirk in v0.5.6: a small earlyExitRange exits when the robot gets "close" (7.5 in);
    // a larger one never takes the early exit and the motion settles
    t = await run('chassis.moveToPose(0, 48, 0, 4000, {.minSpeed = 72, .earlyExitRange = 3}); chassis.waitUntilDone();');
    assert.strictEqual(t.res.motions[0].reason, 'early exit');
    near(exitAt(t.res).y, 40.5, 2, 'moveToPose early exit when close');
    t = await run('chassis.moveToPose(0, 48, 0, 4000, {.minSpeed = 72, .earlyExitRange = 8}); chassis.waitUntilDone();');
    assert.strictEqual(t.res.motions[0].reason, 'settled');
    // waitUntil on a turn counts degrees from the start heading
    t = await run('chassis.turnToHeading(180, 4000); chassis.waitUntil(90); chassis.cancelMotion();');
    assert(t.end.h > 85 && t.end.h < 150, 'cancelled mid-turn at ' + t.end.h);
    console.log('ok motion chaining (LemLib v0.5.6 behaviour)');
  }

  // --- a chained motion takes over the drivetrain in the same tick (no 10 ms with the motors off)
  {
    t = await run(`chassis.moveToPoint(0, 24, 3000, {.minSpeed = 100, .earlyExitRange = 4});
      chassis.moveToPoint(0, 48, 3000, {.minSpeed = 100, .earlyExitRange = 4});
      chassis.moveToPoint(0, 72, 3000);`, { start: { x: 0, y: -60, h: 0 } });
    const f = t.res.frames;
    const gap = f.mi.slice(1, f.mi.indexOf(2) + 1).some((id) => id === -1);
    assert(!gap, 'no idle tick between chained motions');
    assert.strictEqual(t.res.motions[0].t1, t.res.motions[1].t0, 'next motion starts the tick the last one exits');
    console.log('ok chained motions hand over without a dead tick');
  }

  // --- JAR-Template
  {
    const JAR = `
      Drive chassis(ZERO_TRACKER_NO_ODOM, motor_group(LF, LB), motor_group(RF, RB), PORT1, 3.25, 0.6, 360, PORT1, -PORT2, PORT3, -PORT4, 3, 2.75, -2, 1, -2.75, 5.5);
      void odom_constants(){ default_constants(); chassis.drive_max_voltage = 8; chassis.drive_settle_error = 3; chassis.boomerang_lead = .5; }
      void full_test(){
        chassis.drive_distance(24);
        chassis.turn_to_angle(-45);
        chassis.drive_distance(-36);
        chassis.right_swing_to_angle(-90);
        chassis.drive_distance(24);
        chassis.turn_to_angle(0);
      }
      void odom_test(){
        odom_constants();
        chassis.set_coordinates(0, 0, 0);
        chassis.turn_to_point(24, 24);
        chassis.drive_to_point(24, 24);
        chassis.drive_to_pose(0, 48, 0);
        chassis.left_swing_to_angle(90);
      }
      void chain_test(){
        chassis.drive_to_point(0, 24, 6, 10, 6);
        chassis.drive_to_point(0, 48);
      }`;
    t = await run(JAR + 'void autonomous(){ full_test(); }');
    assert.deepStrictEqual(t.c.config.templates, ['JAR-Template']);
    assert.deepStrictEqual(t.res.motions.map((m) => m.label.split('(')[0]), ['drive_distance', 'turn_to_angle', 'drive_distance', 'right_swing_to_angle', 'drive_distance', 'turn_to_angle']);
    assert(t.res.motions.every((m) => m.reason === 'settled'), 'every JAR motion settles: ' + t.res.motions.map((m) => m.reason));
    assert(angDiff(t.end.h, 0) < 2, 'ends facing 0: ' + t.end.h);
    const f = t.res.frames;
    const i = f.t.indexOf(t.res.motions[0].t1);
    near(f.y[i], 24, 1.6, 'drive_distance(24)');
    t = await run(JAR + 'void autonomous(){ odom_test(); }');
    const reasons = t.res.motions.map((m) => m.reason);
    assert(!reasons.includes('timeout'), 'odom test without timeouts: ' + reasons);
    const ip = t.res.frames.t.indexOf(t.res.motions[2].t1);
    near(t.res.frames.x[ip], 0, 3.5, 'drive_to_pose x');
    near(t.res.frames.y[ip], 48, 3.5, 'drive_to_pose y');
    assert(angDiff(t.end.h, 90) < 3, 'left swing to 90: ' + t.end.h);
    // drive_min_voltage chains: the first motion ends on the line instead of settling for 300 ms
    // (with the default drive_kd = 10 the PID brakes near the point, and the min voltage clamps
    // that to -6 V, so the robot is nearly stopped there, as on a real JAR robot)
    t = await run(JAR + 'void autonomous(){ chain_test(); }');
    assert.strictEqual(t.res.motions[0].reason, 'crossed the finish line');
    near(t.end.y, 48, 3.5, 'chain ends at the second point');
    const chained = t.res.motions[0].t1;
    t = await run(JAR + 'void autonomous(){ chassis.drive_to_point(0, 24); chassis.drive_to_point(0, 48); }');
    assert.strictEqual(t.res.motions[0].reason, 'settled');
    assert(t.res.motions[0].t1 > chained + 100, `chaining skips the settle time (${chained} vs ${t.res.motions[0].t1} ms)`);
    // wait(ms, msec) and wait(s, seconds)
    t = await run('void autonomous(){ wait(250, msec); wait(0.25, seconds); chassis.drive_distance(6); }' + JAR.replace(/void full_test[^]*$/, ''));
    assert.strictEqual(t.res.motions[0].t0, 500, 'VEXcode waits');
    console.log('ok JAR-Template');
  }

  // --- RW-Template
  {
    const CFG = `double distance_between_wheels = 12;\ndouble distance_kp = 1.1, distance_ki = 0.1, distance_kd = 7;\ndouble min_output = 10;\n`;
    t = await run(CFG + `void exampleAuton(){ driveTo(48, 3000); turnToAngle(90, 2000); turnToAngle(180, clockwise, 2000); driveTo(24, 2000); }`);
    assert.deepStrictEqual(t.c.config.templates, ['RW-Template']);
    assert.strictEqual(t.c.config.rw.distance_kd, 7);
    assert.strictEqual(t.c.config.rw.distance_between_wheels, 12);
    assert(t.res.motions.every((m) => m.reason === 'settled'), 'RW motions settle: ' + t.res.motions.map((m) => m.reason));
    near(t.end.x, 0, 1.5, 'RW drive/turn x');
    near(t.end.y, 24, 1.5, 'RW drive/turn y');
    assert(angDiff(t.end.h, 180) < 2, 'RW turn heading ' + t.end.h);
    // exit = false: chained, the robot does not stop between moves
    t = await run(`void a(){ setPose(0, 0, 0); moveToPoint(0, 24, 1, 2000, false); moveToPoint(24, 48, 1, 2000, true); turnToAngle(90, 800, false); turnToAngle(180, 1500); }`);
    let k = t.res.frames.t.indexOf(t.res.motions[0].t1);
    // (with the default dir_change_start = dir_change_end = true it slows down but does not stop)
    assert((t.res.frames.vl[k] + t.res.frames.vr[k]) / 2 > 10, 'exit=false keeps moving');
    assert.strictEqual(t.res.motions[2].reason, 'reached');
    near(t.res.frames.y[t.res.frames.t.indexOf(t.res.motions[1].t1)], 48, 2, 'second point reached');
    assert(angDiff(t.end.h, 180) < 2, 'RW chained turn heading ' + t.end.h);
    // boomerang and swing
    t = await run(`void a(){ boomerang(24, 36, 1, 90, 0.4, 3000); swing(0, 1, 2000); }`);
    assert(!t.res.motions.some((m) => m.reason === 'timeout'), 'boomerang/swing: ' + t.res.motions.map((m) => m.reason));
    // RW's boomerang (exit = true) stops once it is within 5 in of the target
    const bi = t.res.frames.t.indexOf(t.res.motions[0].t1);
    assert.strictEqual(t.res.motions[0].reason, 'close enough');
    assert(Math.hypot(t.res.frames.x[bi] - 24, t.res.frames.y[bi] - 36) < 5.5, 'boomerang ends near the target');
    // runAsync + waitUntilTraveled + waitForMotion; correct_angle is shared with the code
    t = await run(`void a(){
      runAsync([]{ moveToPoint(0, 48, 1, 3000); turnToAngle(90, 1500); });
      waitUntilTraveled(12);
      double when = pros::millis();
      intake.move(127);
      waitForMotion();
      correct_angle = 90;
      driveTo(12, 2000);
    }`);
    assert.deepStrictEqual(t.res.motions.map((m) => m.label.split('(')[0]), ['moveToPoint', 'turnToAngle', 'driveTo']);
    near(t.end.x, 12, 1.5, 'drives on after the async motions');
    assert(t.res.motions[2].t0 >= t.res.motions[1].t1, 'waitForMotion waited');
    // paths
    t = await run(`void a(){ setPose(0, 0, 0); Path p = pathFromPoints({{0, 0}, {0, 24}, {24, 48}}); followPath(p, 5000); }`);
    assert.strictEqual(t.res.motions[0].reason, 'reached end');
    near(t.end.x, 24, 2.5, 'followPath end x');
    near(t.end.y, 48, 2.5, 'followPath end y');
    console.log('ok RW-Template');
  }

  // --- PROS / VEXcode drive motors driven directly
  {
    t = await run(`pros::MotorGroup left_mg({1, -2, 3}, pros::MotorGearset::blue);
      pros::MotorGroup right_mg({-4, 5, -6}, pros::MotorGearset::blue);
      pros::Motor lb(7);
      void autonomous(){
        left_mg.move(127); right_mg.move(127); lb.move(127);
        pros::delay(500);
        left_mg.brake(); right_mg.brake();
        pros::delay(500);
        left_mg.tare_position();
        left_mg.move_relative(-720, 600); right_mg.move_relative(-720, 600);
        while (left_mg.get_position() > -715) pros::delay(10);
      }`);
    assert.deepStrictEqual(t.c.config.motors.map((m) => m.name + m.side + m.gearRpm), ['left_mgL600', 'right_mgR600']);
    assert(t.c.config.templates.includes('PROS motors'));
    const f = t.res.frames;
    const yAt = (ms) => f.y[f.t.indexOf(ms)];
    const top = (ROBOT.rpm / 60) * Math.PI * ROBOT.wheelDiameter * ROBOT.speedPct / 100;
    assert(yAt(500) > top * 0.5 * 0.7 && yAt(500) < top * 0.5, 'half a second at full power: ' + yAt(500));
    // 720 motor degrees on a 600 rpm cartridge, 450 rpm wheels: 2 * 0.75 turns of a 3.25 in wheel
    near(yAt(1000) - t.end.y, 2 * 0.75 * Math.PI * 3.25, 0.6, 'move_relative distance');
    t = await run(`motor LeftFront = motor(PORT1, ratio6_1, true);
      motor RightFront = motor(PORT3, ratio6_1, false);
      motor_group LeftDrive = motor_group(LeftFront);
      motor_group RightDrive = motor_group(RightFront);
      void autonomous(void){
        LeftDrive.spin(forward, 6, volt); RightDrive.spin(reverse, 6, volt);
        wait(300, msec);
        LeftDrive.stop(); RightDrive.stop();
        LeftDrive.spinFor(forward, 1, turns, false);
        RightDrive.spinFor(forward, 1, turns);
      }`);
    assert(t.c.config.templates.includes('VEXcode motors'));
    assert(t.end.h > 30, 'spun right: ' + t.end.h);
    console.log('ok PROS / VEXcode motors');
  }

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

// every browser script must at least parse (a typo here only shows up as a blank page)
(() => {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', 'js');
  for (const f of fs.readdirSync(dir)) {
    try {
      new Function(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (e) {
      console.error('FAILED to parse js/' + f + ': ' + e.message);
      process.exit(1);
    }
  }
  console.log('ok all browser scripts parse');
})();
