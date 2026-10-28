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

async function run(code, { start = { x: 0, y: 0, h: 0 }, paths = [], language = 'cpp', cfgExtra, realism } = {}) {
  const c = V.compileAuton(code, { language });
  const res = await V.runSimulation({
    js: c.js,
    robot: ROBOT,
    start,
    cfg: cfg(cfgExtra),
    paths,
    chassisNames: ['chassis', c.config.chassisName],
    maxMs: 120000,
    realism,
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


  // --- real-life error: gyro drift + wheel slip (the robot has a true pose and an odometry pose)
  {
    const OFF = { gyroDrift: 0, gyroScale: 0, gyroNoise: 0, grip: 0, gripVar: 0, latGrip: 0, scrub: 1 };
    const R = (extra) => ({ enabled: true, seed: 1, ...OFF, ...extra });
    const drive = `chassis.moveToPoint(0, 48, 4000, {}, false); chassis.turnToHeading(90, 2000, {}, false);
      chassis.moveToPoint(36, 48, 4000, {}, false); chassis.turnToHeading(180, 2000, {}, false); chassis.moveToPoint(36, 0, 4000, {}, false);`;
    const lastCode = (r) => {
      const f = r.res.frames;
      const n = f.t.length - 1;
      return { x: f.cx[n], y: f.cy[n], t: f.ct[n] };
    };

    // every effect switched off = the ideal robot, to the last digit
    const ideal = await run(drive, { language: 'js' });
    let r = await run(drive, { language: 'js', realism: R() });
    near(r.end.x, ideal.end.x, 1e-6, 'zeroed realism x');
    near(r.end.y, ideal.end.y, 1e-6, 'zeroed realism y');
    near(r.end.h, ideal.end.h, 1e-6, 'zeroed realism heading');
    assert.strictEqual(r.end.t, ideal.end.t, 'zeroed realism timing');
    assert.strictEqual(r.res.realism.endPosErr < 1e-6, true, 'no odometry error when nothing is imperfect');
    const off = await run(drive, { language: 'js', realism: { ...R(), enabled: false, gyroDrift: 5 } });
    assert.strictEqual(off.end.x, ideal.end.x, 'disabled realism changes nothing');
    assert.strictEqual(off.res.realism, null, 'no real-life stats when it is off');

    // a seed repeats exactly, another seed is another robot
    const d = { language: 'js' };
    const a1 = await run(drive, { ...d, realism: { enabled: true, seed: 7 } });
    const a2 = await run(drive, { ...d, realism: { enabled: true, seed: 7 } });
    const a3 = await run(drive, { ...d, realism: { enabled: true, seed: 8 } });
    assert.deepStrictEqual(a1.end, a2.end, 'same seed, same run');
    assert(Math.abs(a1.end.h - a3.end.h) > 1e-6 || Math.abs(a1.end.x - a3.end.x) > 1e-6, 'different seed, different run');
    assert(a1.res.realism.endPosErr > 0.05 && a1.res.realism.endPosErr < 10, 'default error is small but real: ' + a1.res.realism.endPosErr);
    assert(a1.res.events.some((e) => /Real-life error \(seed 7\)/.test(e.text)), 'the run log reports it');

    // gyro drift: a robot standing still for a minute is not where its gyro says
    let worst = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      r = await run('pros::delay(60000);', { realism: R({ seed, gyroDrift: 2 }) });
      worst = Math.max(worst, r.res.realism.endHeadErr);
      near(r.end.h, 0, 1e-9, 'a parked robot does not move while its gyro drifts');
      assert(r.res.realism.endHeadErr < 12, 'drift stays plausible: ' + r.res.realism.endHeadErr);
    }
    assert(worst > 0.3, 'a 2 deg/min gyro drifts by a visible amount in a minute: ' + worst);
    r = await run('pros::delay(60000);', { realism: R({ gyroNoise: 0.3 }) });
    assert(r.res.realism.endHeadErr < 1.5 && r.res.realism.maxHeadErr > 0.05, 'gyro noise is a jitter, not a drift');

    // gyro turn-rate error: the code believes it turned 90, the robot turned a little more or less
    let missed = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      r = await run('chassis.turnToHeading(90, 3000, {}, false);', { language: 'js', realism: R({ seed, gyroScale: 4 }) });
      near(lastCode(r).t, 90, 1.5, 'odometry thinks it reached 90');
      missed = Math.max(missed, Math.abs(normDeg(r.end.h) - 90));
    }
    assert(missed > 0.8 && missed < 12, 'but the real robot turned a different amount: off by ' + missed);

    // wheel slip: slippery floor + hard drive = the wheels turn more than the robot moves
    const slippery = await run('chassis.moveToPoint(0, 48, 5000, {}, false);', { language: 'js', realism: R({ grip: 0.25 }) });
    const sticky = await run('chassis.moveToPoint(0, 48, 5000, {}, false);', { language: 'js', realism: R({ grip: 5 }) });
    near(lastCode(slippery).y, 48, 2.5, 'odometry believes it arrived');
    assert(slippery.end.y < 48 - 1, 'the real robot fell short: ' + slippery.end.y);
    near(sticky.end.y, 48, 1.5, 'plenty of grip, no error');
    assert(slippery.res.realism.slipDist > sticky.res.realism.slipDist + 1, 'slip distance is reported');

    // skidding sideways in a fast curve needs low sideways grip
    const curve = 'chassis.moveToPose(36, 36, 90, 4000, {.lead = 0.5}, false);';
    const grippy = await run(curve, { realism: R({ latGrip: 1.5 }) });
    const icy = await run(curve, { realism: R({ latGrip: 0.03 }) });
    assert(icy.res.realism.maxSlide > grippy.res.realism.maxSlide + 1, `low grip slides: ${icy.res.realism.maxSlide} vs ${grippy.res.realism.maxSlide}`);
    assert(icy.res.realism.maxPosErr > grippy.res.realism.maxPosErr, 'sliding fools the odometry');

    // turn scrub: the robot turns less than its wheels say, the gyro-based controller keeps going until it has turned
    r = await run('chassis.turnToHeading(90, 3000, {}, false);', { language: 'js', realism: R({ scrub: 1.3 }) });
    near(normDeg(r.end.h), 90, 2.5, 'a gyro-controlled turn still ends on target with scrub');

    // wheels keep turning against a wall: odometry counts distance the robot never covered
    const wall = 'chassis.moveToPoint(0, 100, 3000, {}, false);';
    const idealWall = await run(wall, { language: 'js' });
    const realWall = await run(wall, { language: 'js', realism: R({ grip: 0.8 }) });
    assert.strictEqual(idealWall.res.motions[0].reason, 'timeout', 'ideal robot pushes on the wall until the timeout');
    assert(realWall.end.y < 66, 'the wall stops the robot: ' + realWall.end.y);
    assert.strictEqual(realWall.res.motions[0].reason, 'settled', 'its wheels kept turning, so the odometry thinks it arrived');
    assert(realWall.res.realism.maxPosErr > 20, 'odometry is far off after pushing a wall');

    // setPose is a reset: odometry error is cleared, the real robot stays where it is
    r = await run('chassis.moveToPoint(0, 48, 4000, {}, false); chassis.setPose(0, 48, 0); pros::delay(50);', { realism: R({ grip: 0.25 }) });
    near(lastCode(r).y, 48, 0.5, 'getPose reports the declared pose (the wheels have nearly stopped)');
    near(lastCode(r).x, 0, 0.5, 'getPose x after setPose');
    // the reset itself, on the robot: sensed pose snaps to the real one
    const rb = new V.Robot(ROBOT, { x: 0, y: 0, h: 0 }, R({ grip: 0.25 }));
    rb.cmdL = rb.cmdR = 127;
    for (let i = 0; i < 100; i++) rb.step(10);
    assert(Math.hypot(rb.sx - rb.x, rb.sy - rb.y) > 0.1, 'odometry disagrees with the robot after slipping');
    rb.resetOdometry();
    near(rb.sx, rb.x, 1e-12, 'reset x');
    near(rb.sy, rb.y, 1e-12, 'reset y');
    near(rb.sh, rb.h, 1e-12, 'reset heading');
    assert(r.res.realism.maxPosErr > 0.5, 'there was an error before the reset: ' + r.res.realism.maxPosErr);
    console.log('ok real-life error: gyro drift, wheel slip, sliding, scrub, wall, setPose, seeds');
  }

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
