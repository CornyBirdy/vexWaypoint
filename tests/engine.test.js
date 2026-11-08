// Headless tests for the sim engine. Run with: node tests/engine.test.js
'use strict';
const path = require('path');
const assert = require('assert');
for (const f of ['lemlib', 'chassis', 'motors', 'aligners', 'contact', 'paths', 'translate', 'sim', 'autotune']) require(path.join('..', 'js', f + '.js'));
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

async function run(code, { start = { x: 0, y: 0, h: 0 }, paths = [], language = 'cpp', cfgExtra, realism, startFromSetPose, mechanismWaitMs, world, robot } = {}) {
  const c = V.compileAuton(code, { language });
  const res = await V.runSimulation({
    js: c.js,
    robot: robot || ROBOT,
    start,
    cfg: cfg(cfgExtra),
    paths,
    chassisNames: ['chassis', c.config.chassisName],
    motorGroups: c.config.motorGroups || null,
    maxMs: 120000,
    realism,
    startFromSetPose,
    mechanismWaitMs,
    world,
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
    assert(t.end.t < 120000 && t.end.t > 5000, 'finishes in a sensible time, not at the time limit: ' + t.end.t);
    assert(ev.some((e) => /liftPIDEnabled/.test(e.text) && /adds no delay/.test(e.text)), 'tells you the lift wait was skipped');
    assert(ev.some((e) => /resetAtGoalA\(\), resetAtGoalB\(\)/.test(e.text)), 'lists the undefined helpers');
    // by default a wait on something the sim does not run costs no time at all; a wait setting adds time per loop
    const slow = await V.runSimulation({ js: V.compileAuton(skills, { language: 'cpp' }).js, robot: ROBOT, start: { x: 0, y: 0, h: 0 }, cfg: cfg(), paths: [], chassisNames: ['chassis'], mechanismWaitMs: 1500, maxMs: 300000 });
    assert(slow.durationMs > t.end.t + 5000, 'a longer mechanism wait lengthens the run');
    console.log('ok bare skills paste with lift waits finishes in', t.end.t, 'ms');
  }

  // --- open-loop driving in a helper (chassis.tank, motor group move) moves the robot; an undefined helper is
  //     reported where it is called, with its arguments
  {
    const code = `
      pros::MotorGroup leftMotors({-5, -6}, pros::MotorGearset::blue);
      pros::MotorGroup rightMotors({8, 9}, pros::MotorGearset::blue);
      lemlib::Drivetrain drivetrain(&leftMotors, &rightMotors, 10.5, lemlib::Omniwheel::NEW_325, 450, 2);
      void backUp(float s) { chassis.tank(-60, -60); pros::delay(s * 1000); chassis.tank(0, 0); }
      void push() { leftMotors.move(80); rightMotors.move(80); pros::delay(500); leftMotors.move(0); rightMotors.move(0); }
      void spin() { leftMotors.move(60); rightMotors.move(-60); pros::delay(400); chassis.arcade(0, 0); }
      void autonomous() {
        chassis.setPose(0, 0, 0);
        backUp(0.5);
        const lowY = 0;
        push();
        spin();
        mysteryHelper(3, "x");
      }`;
    t = await run(code);
    assert.deepStrictEqual(t.c.config.motorGroups, { left: 'leftMotors', right: 'rightMotors' });
    const f = t.res.frames;
    const minY = Math.min(...f.y);
    assert(minY < -8, 'backUp() drove the robot backwards: ' + minY);
    assert(t.end.y > minY + 12, 'then push() drove it forwards: ' + t.end.y + ' vs ' + minY);
    assert(angDiff(t.end.h, 0) > 20, 'spin() turned it: ' + t.end.h);
    assert(t.end.t > 1300 && t.end.t < 2500, 'the delays are real time: ' + t.end.t);
    assert(t.res.events.some((e) => e.kind === 'warn' && /mysteryHelper\(3, "x"\) is not defined/.test(e.text)), 'undefined helper reported with its arguments');
    // while a LemLib motion runs it owns the motors: a tank() made then is ignored
    t = await run(`void autonomous(){ chassis.setPose(0,0,0); chassis.moveToPoint(0, 24, 3000); chassis.tank(-127, -127); chassis.waitUntilDone(); }`);
    near(t.end.y, 24, 1.5, 'a tank() during a motion does not fight it');
    console.log('ok open-loop drive (tank / arcade / motor groups)');
  }

  // --- an auton built on helper functions (a split-speed drive, backing off with the motor groups, a reset
  //     header with structs / constexpr / casts, pros::Task): everything translates and the helpers move the robot
  {
    const full = require('fs').readFileSync(path.join(__dirname, 'fixtures', 'helpers_auton.cpp'), 'utf8');
    t = await run(full, { start: { x: 0, y: 0, h: 0 } });
    const ev = t.res.events;
    assert.deepStrictEqual(t.c.warnings, [], 'every helper translates: ' + t.c.warnings);
    assert.deepStrictEqual(t.c.ignored, []);
    assert.deepStrictEqual(t.c.config.motorGroups, { left: 'leftMotors', right: 'rightMotors' });
    assert(!ev.some((e) => e.kind === 'error'), 'no errors: ' + ev.filter((e) => e.kind === 'error').map((e) => e.text));
    assert(!ev.some((e) => /is not defined in your code/.test(e.text)), 'nothing is skipped: ' + ev.filter((e) => /not defined/.test(e.text)).map((e) => e.text));
    assert(ev.some((e) => /Auton code finished/.test(e.text)), 'it finishes');
    // the split drive = two moveToPoint calls to the same point
    const labels = t.res.motions.map((m) => m.label);
    const i = labels.indexOf('moveToPoint(30, 20, 2000)');
    assert(i >= 0 && labels[i + 1] === 'moveToPoint(30, 20, 2000)', 'the split drive runs its two moves: ' + labels);
    // the reset puts the robot `STANDOFF` (7 in) back from TARGET (30, 20) along its heading, printed with %.2f
    const rs = ev.find((e) => e.kind === 'print' && /^reset: before \(-?\d+\.\d\d, -?\d+\.\d\d\) after/.test(e.text));
    assert(rs, 'reset line is formatted: ' + ev.filter((e) => e.kind === 'print').map((e) => e.text));
    const th = (Number(/heading (-?[\d.]+)/.exec(rs.text)[1]) * Math.PI) / 180;
    const after = /after \((-?[\d.]+), (-?[\d.]+)\)/.exec(rs.text);
    near(Number(after[1]), 30 - 7 * Math.sin(th), 0.02, 'reset x = target x - R sin(heading)');
    near(Number(after[2]), 20 - 7 * Math.cos(th), 0.02, 'reset y = target y - R cos(heading)');
    // backOff() drove the motors backwards (the robot was moving towards the target before it)
    const f = t.res.frames;
    const k = f.t.findIndex((tt) => tt >= t.res.events.find((e) => e.kind === 'print').t);
    assert(f.t.length > k + 20, 'there is motion after the reset');
    console.log('ok helper functions (split drive, backOff, reset with structs) run end to end');
  }

  // --- structs, integer casts and printf formats
  {
    t = await run(`
      struct P { float x; float y = 5; bool on = true; };
      const P HOME = {1.5f, 2.5f};
      P last;
      void note(const P& p) { last = {p.x + 1, p.y + 1, false}; printf("%+.2f %05.1f %-4d| %s %u", last.x, last.y, 7, "ok", (uint32_t)3); }
      void autonomous() { P q = {.y = 9}; uint32_t a = (uint32_t)q.y; note(HOME); printf("%d %d", a, last.on); }`);
    assert.deepStrictEqual(t.c.warnings, []);
    const prints = t.res.events.filter((e) => e.kind === 'print').map((e) => e.text);
    assert.deepStrictEqual(prints, ['+2.50 003.5 7   | ok 3', '9 0'], prints.join(' / '));
    console.log('ok structs, casts, printf flags');
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
    // the error-size multiplier: x2 is a worse robot than x1, which is worse than x0.5, on the same random draw
    const sized = async (mult) => {
      let sum = 0;
      for (const seed of [1, 2, 3, 4, 5, 6]) sum += (await run(drive, { language: 'js', realism: { enabled: true, seed, mult } })).res.realism.endPosErr;
      return sum / 6;
    };
    const e1 = await sized(1);
    const e2 = await sized(2);
    const eHalf = await sized(0.5);
    assert(eHalf < e1 && e1 < e2, `a bigger error size gives a bigger odometry error: ${eHalf.toFixed(2)} / ${e1.toFixed(2)} / ${e2.toFixed(2)} in`);
    console.log('ok real-life error: gyro drift, wheel slip, sliding, scrub, wall, setPose, seeds');
  }

  // --- chassis.setPose(): every spelling works, and one at the start of the code says where the robot starts
  {
    const place = { start: { x: -48, y: -48, h: 0 }, startFromSetPose: true };
    const forms = {
      numbers: 'chassis.setPose(10, -20, 90);',
      radians: 'chassis.setPose(10, -20, M_PI / 2, true);',
      pose: 'chassis.setPose(lemlib::Pose(10, -20, 90));',
      poseBraces: 'chassis.setPose(lemlib::Pose{10, -20, 90});',
      bareBraces: 'chassis.setPose({10, -20, 90});',
      variable: 'lemlib::Pose p(10, -20, 90); chassis.setPose(p);',
      variableBraces: 'lemlib::Pose p{10, -20, 90}; chassis.setPose(p);',
    };
    for (const [name, line] of Object.entries(forms)) {
      t = await run(`void autonomous() { ${line} chassis.moveToPoint(34, -20, 3000, {}, false); }`, place);
      assert(!t.res.events.some((e) => e.kind === 'error'), name + ': no error');
      near(t.res.frames.x[0], 10, 1e-9, name + ' start x');
      near(t.res.frames.y[0], -20, 1e-9, name + ' start y');
      near(t.res.frames.h[0], 90, 1e-9, name + ' start heading');
      near(t.end.x, 34, 1.5, name + ' end x');
      near(t.end.y, -20, 1.5, name + ' end y');
      assert.deepStrictEqual(t.res.startFromCode, { x: 10, y: -20, h: 90 }, name + ' reports the start');
    }
    // without the option the robot stays where the start pose panel put it
    t = await run('void autonomous() { chassis.setPose(10, -20, 90); }', { start: { x: -48, y: -48, h: 0 } });
    near(t.res.frames.x[0], -48, 1e-9, 'start pose panel wins when the option is off');
    assert.strictEqual(t.res.startFromCode, null);
    // only a setPose before the first motion places the robot; a later one is a plain re-anchor
    t = await run('void autonomous() { chassis.moveToPoint(0, 24, 3000, {}, false); chassis.setPose(10, 10, 0); }', place);
    near(t.res.frames.x[0], -48, 1e-9, 'a setPose after a motion does not move the robot');
    assert.strictEqual(t.res.startFromCode, null);
    // getPose arguments
    t = await run('void autonomous() { chassis.setPose(0, 0, 90); lemlib::Pose a = chassis.getPose(); lemlib::Pose b = chassis.getPose(true, true); lemlib::Pose c = chassis.getPose(true); chassis.moveToPoint(a.theta == 90 ? 10 : -10, b.theta == 0 ? 10 : -10, 3000, {}, false); chassis.moveToPoint(Math.abs(c.theta - M_PI / 2) < 1e-6 ? 20 : -20, 10, 3000, {}, false); }', { start: { x: 0, y: 0, h: 0 } });
    const fr = t.res.frames;
    near(fr.cx[fr.cx.length - 1], 20, 2, 'getPose(): degrees, standard position and radians');
    near(fr.cy[fr.cy.length - 1], 10, 3, 'getPose(true, true) is 0 for a robot facing +x');
    console.log('ok setPose forms + start from code');
  }

  // --- waiting on a lift / claw the sim does not run
  {
    const wait = 'int liftPIDEnabled = 3; void autonomous() { chassis.moveToPoint(0, 12, 3000, {}, false); while (liftPIDEnabled != 1) { pros::delay(20); } chassis.moveToPoint(0, 24, 3000, {}, false); }';
    t = await run(wait);
    const gap = t.res.motions[1].t0 - t.res.motions[0].t1;
    assert(gap < 30, 'a lift wait adds no time by default: ' + gap);
    t = await run(wait, { mechanismWaitMs: 400 });
    assert(t.res.motions[1].t0 - t.res.motions[0].t1 >= 400, 'the wait setting adds time per loop');
    // loops that do real work keep working
    t = await run('void autonomous() { int i = 0; while (i < 3) { i++; pros::delay(100); } }');
    assert(t.end.t >= 300, 'a counting loop still counts: ' + t.end.t);
    t = await run('void autonomous() { chassis.moveToPoint(0, 24, 3000); while (chassis.isInMotion()) { pros::delay(10); } }');
    near(t.end.y, 24, 1.5, 'waiting on the drivetrain still waits');
    t = await run('void autonomous() { chassis.moveToPoint(0, 24, 3000); while (chassis.getPose().y < 20) { pros::delay(10); } chassis.cancelMotion(); }');
    assert(t.end.y > 18 && t.end.y < 40, 'waiting on getPose() still waits: ' + t.end.y);
    console.log('ok lift waits add no time by default');
  }

  // --- the in-app changelog is generated from CHANGELOG.md (node tools/make-changelog.js)
  {
    const fs = require('fs');
    const { render, parse } = require(path.join('..', 'tools', 'make-changelog.js'));
    const md = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
    assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'js', 'changelog.js'), 'utf8'), render(md), 'js/changelog.js is out of date: run node tools/make-changelog.js');
    const rel = parse(md);
    assert(rel.length >= 3 && rel[0].title === 'Unreleased' && rel[0].sections.some((x) => x.name === 'Added' && x.items.length), 'changelog parses');
    assert(rel.every((r) => r.sections.every((x) => x.items.every((i) => i.text.length > 3))), 'every entry has text');
    console.log('ok changelog data matches CHANGELOG.md');
  }

  // --- chassis: wheel types and tracking wheels decide how the robot behaves on the floor
  {
    const allOmni = { left: ['omni', 'omni', 'omni', 'omni'], mirror: true };
    const allTraction = { left: ['traction', 'traction', 'traction', 'traction'], mirror: true };
    const centreTraction = { left: ['omni', 'traction', 'traction', 'omni'], mirror: true };
    const endTraction = { left: ['traction', 'omni', 'omni', 'traction'], mirror: true };
    const dOmni = V.deriveChassis(allOmni, ROBOT);
    const dTrac = V.deriveChassis(allTraction, ROBOT);
    assert.strictEqual(dOmni.wheels, 8);
    assert(dTrac.grip > dOmni.grip && dTrac.latGrip > dOmni.latGrip, 'traction wheels grip more');
    assert(dTrac.scrub > dOmni.scrub && dTrac.scrub < 1.4, 'but scrub more when turning: ' + dTrac.scrub);
    assert(V.deriveChassis(endTraction, ROBOT).scrub > V.deriveChassis(centreTraction, ROBOT).scrub, 'a traction wheel in the centre scrubs less than one at the ends');
    assert(dOmni.spread > dTrac.spread, 'omni grip is less consistent');
    const lay = V.chassisLayout({ left: ['omni', 'traction', 'omni'], mirror: true }, ROBOT);
    assert.strictEqual(lay.length, 6);
    assert(lay[0].y > lay[1].y && lay[1].y > lay[2].y && lay[0].x < 0 && lay[3].x > 0, 'wheels go front to back, left then right');
    assert.deepStrictEqual(V.sanitizeChassis({ left: ['bogus'], tracking: { vertical: { on: 1, offset: 99 } } }).left, V.DEFAULT_CHASSIS.left, 'junk falls back to the default chassis');
    assert.deepStrictEqual(V.sanitizeChassis({ left: ['omni'], mirror: false, right: ['traction', 'omni'] }).right, ['traction', 'omni', 'none', 'none'], 'the right side can differ, and a short list is padded with blanks');
    // blank positions: a 4WD is eight positions with four blank
    assert.strictEqual(V.WHEEL_SLOTS, 4);
    assert.deepStrictEqual(V.DEFAULT_CHASSIS.left.length, 4, 'the default chassis has 8 wheel positions');
    const fourWd = { left: ['omni', 'none', 'none', 'omni'], mirror: true };
    assert.strictEqual(V.deriveChassis(fourWd, ROBOT).wheels, 4, 'blank positions are not wheels');
    assert.strictEqual(V.chassisSlots(fourWd, ROBOT).length, 8, 'but they are still positions');
    assert.strictEqual(V.chassisSlots(fourWd, ROBOT).filter((w) => w.type === 'none').length, 4);
    const slotsY = V.chassisSlots(V.DEFAULT_CHASSIS, ROBOT).filter((w) => w.side === 'left').map((w) => w.y);
    assert(slotsY[0] > slotsY[1] && slotsY[1] > slotsY[2] && slotsY[2] > slotsY[3], 'positions run front to back');
    assert.deepStrictEqual(V.sanitizeChassis({ left: ['none', 'none', 'none', 'none'] }).left, V.DEFAULT_CHASSIS.left, 'a side with no wheel at all falls back');
    const spreadOut = V.chassisSlots({ left: ['omni', 'none', 'none', 'omni'], mirror: true }, ROBOT).filter((w) => w.side === 'left' && w.type !== 'none');
    assert(Math.abs(spreadOut[0].y - spreadOut[1].y) > 8, 'the wheels stay at their positions when the ones between are blank');
    assert(/drive wheels/.test(V.describeChassis(allOmni, ROBOT)));

    const rc = (chassis, extra) => ({ enabled: true, seed: 4, chassis, ...extra });
    // sideways slide in a fast curve: omni wheels slide, traction wheels hold
    const curve = 'chassis.moveToPose(36, 36, 90, 4000, {.lead = 0.5}, false);';
    const omniRun = await run(curve, { realism: rc(allOmni) });
    const tracRun = await run(curve, { realism: rc(allTraction) });
    assert(omniRun.res.realism.maxSlide > tracRun.res.realism.maxSlide, `omni slides more: ${omniRun.res.realism.maxSlide} vs ${tracRun.res.realism.maxSlide}`);

    // tracking wheels: the odometry stops counting wheelspin (forward wheel) and sees sliding (sideways wheel)
    const vert = { ...allOmni, tracking: { vertical: { on: true, offset: 3 }, horizontal: { on: false, offset: 0 } } };
    const both = { ...allOmni, tracking: { vertical: { on: true, offset: 3 }, horizontal: { on: true, offset: -2 } } };
    const spin = { grip: 0.3, latGrip: 0 };
    const spinDrive = await run(curve, { realism: rc(allOmni, spin) });
    const spinTrack = await run(curve, { realism: rc(vert, spin) });
    assert(spinTrack.res.realism.maxPosErr < spinDrive.res.realism.maxPosErr * 0.5, `a forward tracking wheel ignores wheelspin: ${spinTrack.res.realism.maxPosErr} vs ${spinDrive.res.realism.maxPosErr}`);
    const slide = { grip: 0, latGrip: 0.05 };
    const slideV = await run(curve, { realism: rc(vert, slide) });
    const slideVH = await run(curve, { realism: rc(both, slide) });
    assert(slideV.res.realism.maxSlide > 2, 'the robot slides: ' + slideV.res.realism.maxSlide);
    assert(slideVH.res.realism.maxPosErr < slideV.res.realism.maxPosErr * 0.5, `a sideways tracking wheel sees the slide: ${slideVH.res.realism.maxPosErr} vs ${slideV.res.realism.maxPosErr}`);
    // against a wall the drive wheels keep counting; a tracking wheel does not
    const wallRun = 'chassis.moveToPoint(0, 100, 3000, {}, false);';
    const wallDrive = await run(wallRun, { realism: rc(allOmni) });
    const wallTrack = await run(wallRun, { realism: rc(vert) });
    assert.strictEqual(wallDrive.res.motions[0].reason, 'settled', 'drive encoders: thinks it arrived');
    assert.strictEqual(wallTrack.res.motions[0].reason, 'timeout', 'tracking wheel: knows it is stuck against the wall');
    assert(wallTrack.res.realism.maxPosErr < 5, 'odometry stays right: ' + wallTrack.res.realism.maxPosErr);
    console.log('ok chassis: wheel types, tracking wheels');
  }

  // --- LemLib documentation checks: Omniwheel constants, odometry setup, utilities, resetLocalPosition
  {
    const dia = (c) => V.compileAuton(`lemlib::Drivetrain dt(&l, &r, 10.5, lemlib::Omniwheel::${c}, 450, 2); void autonomous() {}`, { language: 'cpp' }).config.drivetrain.wheelDiameter;
    assert.strictEqual(dia('OLD_4'), 4.18);
    assert.strictEqual(dia('NEW_4'), 4);
    assert.strictEqual(dia('NEW_2'), 2.125);
    assert.strictEqual(dia('NEW_325_HALF'), 3.246);
    assert.strictEqual(dia('OLD_275_HALF'), 2.74);

    const odomCode = `lemlib::TrackingWheel vert(&enc, lemlib::Omniwheel::NEW_275, -3.5);
      lemlib::TrackingWheel hor(&enc2, 2.75, 4);
      lemlib::OdomSensors sensors(&vert, nullptr, &hor, nullptr, &imu);
      lemlib::OdomSensors bare(nullptr, nullptr, nullptr, nullptr, nullptr);
      void autonomous() {}`;
    const od = V.compileAuton(odomCode, { language: 'cpp' }).config.odom;
    assert.deepStrictEqual(od, { vertical: { on: true, offset: -3.5 }, second: false, horizontal: { on: true, offset: 4 }, imu: true }, 'OdomSensors is read from the code');
    const od2 = V.compileAuton(odomCode.replace('&imu', 'nullptr').replace('nullptr, &hor', '&vert, &hor'), { language: 'cpp' }).config.odom;
    assert.strictEqual(od2.imu, false);
    assert.strictEqual(od2.second, true);

    const out = async (code, extra) => (await run(code, extra)).res.events.filter((e) => e.kind === 'print').map((e) => e.text);
    let p = await out('printf("%f", lemlib::angleError(10, 350, false)); printf("%f", lemlib::sanitizeAngle(-90, false)); printf("%f", avg({1, 2, 3, 6})); printf("%f", ema(10, 0, 0.5));');
    assert.deepStrictEqual(p.map(Number), [20, 270, 3, 5], 'utility functions: ' + p);
    p = await out('printf("%f", lemlib::angleError(350, 10, false, lemlib::AngularDirection::CW_CLOCKWISE)); printf("%f", lemlib::slew(100, 0, 10));');
    assert.deepStrictEqual(p.map(Number), [340, 10], 'angleError direction, slew: ' + p);
    // getCurvature: a point straight ahead has none; one to the right at 45 degrees is clockwise (positive)
    p = await out('lemlib::Pose a(0, 0, M_PI / 2); lemlib::Pose b(0, 10, 0); lemlib::Pose c(10, 10, 0); printf("%f", lemlib::getCurvature(a, b)); printf("%f", lemlib::getCurvature(a, c));');
    near(Number(p[0]), 0, 1e-9, 'straight ahead has no curvature');
    assert(Number(p[1]) > 0.05, 'a point to the right curves clockwise: ' + p[1]);
    p = await out('lemlib::Timer t(300); pros::delay(100); printf("%d", t.getTimeLeft()); pros::delay(250); printf("%d", t.isDone() ? 1 : 0);');
    assert.deepStrictEqual(p.map(Number), [200, 1], 'Timer runs on the simulated clock: ' + p);
    p = await out('lemlib::PID pid(2, 0, 1); printf("%f", pid.update(10)); printf("%f", pid.update(4));');
    assert.deepStrictEqual(p.map(Number), [30, 2], 'PID: ' + p);
    p = await out('lemlib::Pose a(0, 0, 0); lemlib::Pose b(10, 20, 0); lemlib::Pose m = a.lerp(b, 0.5); printf("%f", m.x); printf("%f", m.y);');
    assert.deepStrictEqual(p.map(Number), [5, 10], 'Pose.lerp');

    // turnToPoint close to the robot is flagged, as the docs advise
    t = await run('chassis.turnToPoint(5, 5, 1000, {}, false);');
    assert(t.res.events.some((e) => e.kind === 'warn' && /within 10 in/.test(e.text)), 'warns about turning to a point within 10 in');
    t = await run('chassis.turnToPoint(40, 40, 1000, {}, false);');
    assert(!t.res.events.some((e) => e.kind === 'warn'), 'no warning for a far point');

    // resetLocalPosition: odometry x / y go to 0 and the heading is kept; the robot does not move
    t = await run('chassis.moveToPoint(0, 24, 3000, {}, false); chassis.resetLocalPosition(); pros::delay(50); lemlib::Pose q = chassis.getPose(); printf("%f", q.y); chassis.moveToPoint(0, 24, 3000, {}, false);');
    near(Number(t.res.events.find((e) => e.kind === 'print').text), 0, 0.5, 'getPose is 0 after resetLocalPosition');
    near(t.end.y, 48, 2.5, 'the next move goes 24 in further from where the robot stands');

    // where the heading comes from: the drive wheels scrub, so a heading taken from them is wrong; an IMU is not
    const zero = { gyroDrift: 0, gyroScale: 0, gyroNoise: 0, trackScale: 0 };
    const traction = { left: ['traction', 'traction', 'traction', 'traction'], mirror: true };
    const turn = 'chassis.turnToHeading(180, 4000, {}, false);';
    const withImu = await run(turn, { realism: { enabled: true, seed: 2, chassis: { ...traction, imu: true }, ...zero } });
    const noImu = await run(turn, { realism: { enabled: true, seed: 2, chassis: { ...traction, imu: false }, ...zero } });
    const twoWheels = await run(turn, { realism: { enabled: true, seed: 2, chassis: { ...traction, imu: false, tracking: { vertical: { on: true, offset: 3 }, second: true } }, ...zero } });
    assert(withImu.res.realism.endHeadErr < 1, 'IMU heading is right: ' + withImu.res.realism.endHeadErr);
    assert(noImu.res.realism.endHeadErr > 4, 'drive-wheel heading is off by the scrub: ' + noImu.res.realism.endHeadErr);
    assert(twoWheels.res.realism.endHeadErr < 1.5, 'two forward tracking wheels give a good heading: ' + twoWheels.res.realism.endHeadErr);
    assert(/heading from the drive wheel encoders/.test(noImu.res.events.map((e) => e.text).join('\n')), 'the log says where the heading comes from');
    const d = V.deriveChassis({ left: ['omni', 'omni', 'omni', 'omni'], mirror: true }, ROBOT);
    assert.strictEqual(d.driftHint, 2);
    assert.strictEqual(V.deriveChassis({ left: ['omni', 'traction', 'traction', 'omni'], mirror: true }, ROBOT).driftHint, 8);
    console.log('ok LemLib docs checks: Omniwheel, odometry import, utils, Timer, PID, resetLocalPosition, heading source');
  }

  // --- goal aligners: shapes, solid goals, contact physics and the aligned check
  {
    // shapes
    const arc = V.arcFromThree({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 });
    near(arc.cx, 0, 1e-9, 'arc centre x');
    near(arc.r, 1, 1e-9, 'arc radius');
    near(arc.sweep, 180, 1e-6, 'a counter-clockwise half circle');
    const cw = V.arcFromThree({ x: 1, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 });
    near(cw.sweep, -180, 1e-6, 'through the bottom is clockwise');
    assert.strictEqual(V.arcFromThree({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }), null, 'three points in a line are not an arc');
    const ends = V.shapeEnds({ type: 'arc', cx: 0, cy: 0, r: 2, a0: 90, sweep: -90 });
    near(ends[1].x, 2, 1e-9, 'arc end x');
    const circle = V.shapePolyline({ type: 'circle', cx: 0, cy: 0, r: 3 });
    assert(circle.length > 12 && Math.abs(circle[0].x - circle[circle.length - 1].x) < 1e-9, 'a circle closes');
    const chord = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    assert(circle.every((q, i) => i === 0 || chord(q, circle[i - 1]) < 1.2), 'the circle is cut finely enough');
    near(V.shapeDimensions({ type: 'line', x1: 0, y1: 0, x2: 3, y2: 4 }).length, 5, 1e-9, 'line length');
    near(V.shapeDimensions({ type: 'circle', cx: 0, cy: 0, r: 2 }).circumference, 4 * Math.PI, 1e-9, 'circumference');
    const clean = V.sanitizeAligners({ front: { shapes: [{ type: 'line', x1: 0, y1: 0, x2: 0, y2: 0 }, { type: 'line', x1: 0, y1: 0, x2: 3, y2: 0 }, { type: 'blob' }], material: 'wood', thickness: 99 }, back: null });
    assert.strictEqual(clean.front.shapes.length, 1, 'zero-length and unknown shapes are dropped');
    assert.strictEqual(clean.front.material, 'polycarbonate');
    assert.strictEqual(clean.front.thickness, 1);
    assert.strictEqual(clean.back.on, false, 'back aligners are off by default');
    assert.strictEqual(clean.front.on, false, 'aligners are off by default');
    ['polycarbonate', 'acetal', 'steel', 'aluminium'].forEach((m) => assert(V.MATERIALS[m].mu > 0.05 && V.MATERIALS[m].mu < 1));
    assert(V.MATERIALS.acetal.mu < V.MATERIALS.polycarbonate.mu, 'acetal is the slippery one');

    const L = (x1, y1, x2, y2) => ({ type: 'line', x1, y1, x2, y2 });
    const pocket = [L(-3.1, 7.5, 3.1, 7.5), L(-3.1, 7.5, -3.1, 13), L(3.1, 7.5, 3.1, 13), L(-3.1, 13, -6, 16), L(3.1, 13, 6, 16)];
    const withPocket = (extra) => V.sanitizeAligners({ front: { on: true, shapes: pocket, ...extra }, back: { on: false } });
    assert.deepStrictEqual(V.alignerPoint(withPocket().front, 'front'), { x: 0, y: 7.5 }, 'the alignment point is the middle of the back of the aligners');
    assert.deepStrictEqual(V.alignerPoint(withPocket({ auto: false, point: { x: 1, y: 8 } }).front, 'front'), { x: 1, y: 8 }, 'or placed by hand');

    // the footprint measured off the field picture: 5.65 in square, corners cut by 1 in
    const gp = V.goalPolygon(10, 20, 5.65, 1);
    assert.strictEqual(gp.length, 8);
    near(Math.max(...gp.map((q) => q.x)) - Math.min(...gp.map((q) => q.x)), 5.65, 1e-9, 'goal width');
    near(Math.hypot(gp[0].x - gp[7].x, gp[0].y - gp[7].y), 5.65 - 2, 1e-9, 'the flat side is the width minus both cut corners');
    assert(V.buildGoals({}).every((g) => g.flat === 5.65 && g.poly.length === 8), 'all nine goals share the measured footprint');
    assert.strictEqual(V.buildGoals({}).length, 9);

    // the goals are solid: the robot's body stops against the tall goal in the centre (5.65 in across, 15 in robot)
    const goalWorld = { goals: {}, aligners: V.sanitizeAligners({ front: { on: false }, back: { on: false } }) };
    const drive = 'chassis.moveToPoint(0, 35, 3000, {}, false);';
    t = await run(drive, { start: { x: 0, y: -25, h: 0 }, world: goalWorld });
    near(t.end.y, -2.825 - 7.5, 0.3, 'the robot stops against the goal');
    t = await run(drive, { start: { x: 0, y: -25, h: 0 } });
    assert(t.end.y > 8, 'without solid goals it drives through: ' + t.end.y);
    // the goals have an exact size that can be set
    t = await run(drive, { start: { x: 0, y: -25, h: 0 }, world: { ...goalWorld, goals: { tall: 8 } } });
    near(t.end.y, -4 - 7.5, 0.4, 'a bigger goal stops it sooner');
    // the field perimeter is 140.5 in inside: the robot cannot reach the tile edge at 72
    t = await run('chassis.moveToPoint(0, 140, 4000, {}, false);', { start: { x: 60, y: -50, h: 0 }, world: goalWorld });
    near(t.end.y, 70.25 - 7.5, 0.5, 'the wall is at 70.25 in');
    // ... and hits things with its whole body, not its centre: a corner sliding on a goal turns the robot
    t = await run('chassis.moveToPoint(2, 35, 3000, {}, false);', { start: { x: 3.5, y: -25, h: 0 }, world: goalWorld });
    assert(t.res.events.every((e) => e.kind !== 'error'), 'a glancing hit runs');

    // aligners: a pocket the goal drops into
    const pocketRun = (dx, extra = {}, real = null) => run(drive, { start: { x: dx, y: -25, h: 0 }, world: { goals: {}, aligners: withPocket(extra) }, realism: real });
    for (const dx of [0, 1, 2, 3]) {
      t = await pocketRun(dx);
      assert(t.res.align.front.aligned, `a pocket aligns a goal ${dx} in off-centre`);
      assert(t.res.events.some((e) => /front aligner aligned with the neutral tall goal/.test(e.text)), 'the log says so');
      assert(t.res.frames.alF.some((g) => g === 0), 'every frame records which goal is aligned');
      near(t.end.x, 0, 1.2, `the pocket centres the robot on the goal (${dx} in off)`);
    }
    t = await pocketRun(0, { tol: 0.02 });
    assert.strictEqual(t.res.align.front.aligned, false, 'a tighter tolerance is not met');
    assert(t.res.events.some((e) => e.kind === 'warn' && /never aligned/.test(e.text)), 'and the log says how close it got');
    assert(t.res.align.front.dist > 0.02 && t.res.align.front.dist < 1);
    t = await pocketRun(0, { tol: 3 });
    assert(t.res.align.front.aligned, 'a loose tolerance is easy');
    // the other goals: an alliance goal off to one side is ignored, too far away to align
    t = await run(drive, { start: { x: 0, y: -25, h: 0 }, world: { goals: {}, aligners: withPocket() } });
    assert.strictEqual(t.res.align.front.goal, 0);
    // aligners that miss the goal do not align: robot far to the side
    t = await pocketRun(9);
    assert.strictEqual(t.res.align.front.aligned, false, 'too far off to be caught');
    // back aligners work for driving backwards
    const backPocket = pocket.map((s) => L(s.x1, -s.y1, s.x2, -s.y2));
    t = await run('chassis.moveToPoint(0, -35, 3000, {.forwards = false}, false);', { start: { x: 0, y: 25, h: 0 }, world: { goals: {}, aligners: V.sanitizeAligners({ front: { on: false }, back: { on: true, shapes: backPocket } }) } });
    assert(t.res.align.back && t.res.align.back.aligned, 'the back aligner aligns on a backwards approach');
    // with real-life error on the same pocket still works for a good approach, and is a bit less certain
    t = await pocketRun(0, {}, { enabled: true, seed: 3 });
    assert(t.res.align.front.aligned, 'a straight approach still aligns with real-life error');
    t = await pocketRun(4, {}, { enabled: true, seed: 3 });
    const ideal4 = await pocketRun(4);
    assert(!t.res.align.front.aligned || ideal4.res.align.front.aligned, 'a messy approach is never easier than in the perfect sim');

    // aligners drawn inside the body outline: the body is pulled back so the aligner meets the goal first
    const inner = V.sanitizeAligners({ front: { on: true, shapes: [L(-3.1, 3, 3.1, 3), L(-3.1, 3, -3.1, 6), L(3.1, 3, 3.1, 6), L(-3.1, 6, -6, 7), L(3.1, 6, 6, 7)] }, back: { on: false } });
    t = await run(drive, { start: { x: 0, y: -25, h: 0 }, world: { goals: {}, aligners: inner } });
    assert(t.res.align.front.aligned, 'an aligner drawn inside the body outline still meets the goal');
    near(t.end.y, -2.825 - 3, 0.6, 'the goal is stopped at the aligner, not at the body: ' + t.end.y);

    // many frames, and speed: a full run with contacts stays quick
    const t0 = Date.now();
    await pocketRun(1);
    assert(Date.now() - t0 < 4000, 'a run with contacts is fast enough: ' + (Date.now() - t0) + ' ms');
    console.log('ok aligners: shapes, solid goals, walls, pocket alignment, tolerance, back aligners');
  }

  // --- motors and weight: the real-life speed and the response are worked out, not typed in
  {
    const base = { ...ROBOT, motor: V.sanitizeMotor({}) };
    const withMotor = (mod, extra = {}) => ({ ...base, ...extra, motor: V.sanitizeMotor({ ...base.motor, ...mod }) });
    const d = V.motorModel(base);
    assert(d.speedPct > 80 && d.speedPct <= 100, 'a normal drive reaches most of the ideal speed: ' + d.speedPct);
    assert(d.respMs > 40 && d.respMs < 300, 'and gets there in a normal time: ' + d.respMs);
    assert(V.motorModel(withMotor({ n11: 4 })).respMs < d.respMs, 'more motors accelerate faster');
    assert(V.motorModel(withMotor({ n11: 2 })).respMs > d.respMs, 'fewer motors accelerate slower');
    assert(V.motorModel(withMotor({ weight: 9 })).respMs > d.respMs, 'a heavier robot accelerates slower');
    assert(V.motorModel(withMotor({ weight: 20, unit: 'lb' })).respMs > d.respMs, 'the weight can be in lb (20 lb = 9.1 kg)');
    near(V.motorModel(withMotor({ weight: 11.0231, unit: 'lb' })).respMs, V.motorModel(withMotor({ weight: 5, unit: 'kg' })).respMs, 1, 'lb and kg agree');
    assert(V.motorModel(withMotor({ volts: 10.5 })).speedPct < d.speedPct - 3, 'a flat battery is slower');
    assert(V.motorModel(withMotor({ volts: 12 })).speedPct > d.speedPct, 'a full one is quicker');

    // 11 W and 5.5 W motors can be mixed per side: two 11 W + one 5.5 W is the 55 W drive (27.5 W a side)
    const mix = V.motorModel(withMotor({ n11: 2, n55: 1 }));
    near(mix.watts, 55, 1e-9, 'a 55 W drive');
    near(mix.wattsPerSide, 27.5, 1e-9, '27.5 W a side');
    const two = V.motorModel(withMotor({ n11: 2, n55: 0 }));
    const three = V.motorModel(withMotor({ n11: 3, n55: 0 }));
    assert(mix.respMs < two.respMs && mix.respMs > three.respMs, `2.5 motors sit between 2 and 3: ${two.respMs} / ${mix.respMs} / ${three.respMs} ms`);
    assert(mix.pushForce > two.pushForce && mix.pushForce < three.pushForce, 'and push between them');
    // a 5.5 W motor is not exactly half an 11 W one
    const half = V.halfPowerRatio();
    assert(half.stall > 0.4 && half.stall < 0.5 && Math.abs(half.stall - 0.5) > 0.005, 'the 5.5 W motor stalls at under half the torque: ' + half.stall);
    assert(half.running > 0.3 && half.running < 0.5, 'and gives under half while running: ' + half.running);
    assert(V.motorModel(withMotor({ n11: 0, n55: 6 })).respMs > V.motorModel(withMotor({ n11: 3, n55: 0 })).respMs, 'six 5.5 W motors (33 W a side) accelerate slower than three 11 W ones');
    assert(V.motorModel(withMotor({ n11: 0, n55: 6 })).watts === 66);
    assert(V.motorModel(withMotor({ n11: 0, n55: 0 })).watts === 22, 'at least one motor is kept');
    // settings saved by the old form (one type, perSide) carry over
    assert.deepStrictEqual([V.sanitizeMotor({ perSide: 4, watts: 11 }).n11, V.sanitizeMotor({ perSide: 4, watts: 11 }).n55], [4, 0]);
    assert.deepStrictEqual([V.sanitizeMotor({ perSide: 4, watts: 5.5 }).n11, V.sanitizeMotor({ perSide: 4, watts: 5.5 }).n55], [0, 4]);
    assert(/55 W drive/.test(V.describeMotors({ ...base, motor: V.sanitizeMotor({ n11: 2, n55: 1 }) })) && /a bit less than half/.test(V.describeMotors({ ...base, motor: V.sanitizeMotor({ n11: 2, n55: 1 }) })));
    assert(V.motorModel(withMotor({ cur11: { limitA: 1 } })).respMs > d.respMs, 'a lower current limit means less torque');
    assert(V.motorModel(base, { left: ['traction', 'traction', 'traction', 'traction'], mirror: true }).speedPct < V.motorModel(base, { left: ['omni', 'omni', 'omni', 'omni'], mirror: true }).speedPct, 'traction wheels roll harder than omnis');
    assert(/motors/.test(V.describeMotors(base)) && /% of the wheel/.test(V.describeMotors(base)));

    // in the sim: the robot really reaches the worked-out speed, and a heavy one takes longer for the same move
    const move = 'chassis.moveToPoint(0, 60, 6000, {}, false);';
    let fast = await run(move, { robot: base });
    const top = Math.max(...fast.res.frames.vl);
    near(top, d.vTop, d.vTop * 0.04, 'the robot reaches the computed top speed');
    near(fast.res.vmax, d.vTop, 0.5, 'vmax is the computed top speed');
    const heavy = await run(move, { robot: withMotor({ weight: 14 }) });
    assert(heavy.end.t > fast.end.t, `a heavy robot takes longer (${heavy.end.t} vs ${fast.end.t} ms)`);
    const manual = await run(move, { robot: { ...base, motor: { ...base.motor, auto: false } } });
    near(Math.max(...manual.res.frames.vl), ROBOT.rpm / 60 * Math.PI * ROBOT.wheelDiameter * ROBOT.speedPct / 100, 3, 'auto off uses the typed speed');
    console.log('ok motors: speed and response from motors, weight, voltage');
  }

  // --- auto-tuning the timeouts
  {
    const code = `void autonomous() {
      chassis.moveToPoint(0, 20, 5000);           // a normal move
      chassis.turnToHeading(90, 4000);            // a normal turn
      chassis.turnToHeading(0, 4000);
      chassis.moveToPoint(0, 100, 6000);          // drives into the centre goal and can never get there
      chassis.waitUntilDone();
    }`;
    const start = { x: 0, y: -60, h: 0 };
    const pocket = [{ type: 'line', x1: -3.1, y1: 7.5, x2: 3.1, y2: 7.5 }, { type: 'line', x1: -3.1, y1: 7.5, x2: -3.1, y2: 13 }, { type: 'line', x1: 3.1, y1: 7.5, x2: 3.1, y2: 13 }];
    const simulateWith = (src, aligners) => async (extra) => {
      const c = V.compileAuton(src, { language: 'cpp', markSites: true });
      return V.runSimulation({ js: c.js, robot: ROBOT, start, cfg: cfg(), paths: [], chassisNames: ['chassis'], maxMs: 120000, world: { goals: {}, aligners: V.sanitizeAligners(aligners || {}) }, ...extra });
    };
    const sites = V.compileAuton(code, { language: 'cpp', markSites: true }).sites;
    assert.deepStrictEqual(sites.map((x) => x.method), ['moveToPoint', 'turnToHeading', 'turnToHeading', 'moveToPoint']);
    assert.deepStrictEqual(sites.map((x) => x.timeout.value), [5000, 4000, 4000, 6000]);

    const tune = await V.autoTune({ simulate: simulateWith(code), sites });
    const byId = (id) => tune.rows[id];
    // the normal motions: measured time plus the margin, far below the generous timeout they had
    [0, 1, 2].forEach((i) => {
      assert.strictEqual(byId(i).kind, 'finished', 'call ' + i);
      assert(byId(i).ms >= byId(i).maxMs * 1.2 && byId(i).ms < byId(i).maxMs * 1.2 + 400, `call ${i}: ${byId(i).ms} for a ${byId(i).maxMs} ms motion`);
      assert.strictEqual(byId(i).ms % 50, 0, 'rounded up to 50 ms');
    });
    // the move into the goal: a little after it hit it, not the 6 s it had
    assert.strictEqual(byId(3).kind, 'blocked', 'the move into the goal is recognised: ' + byId(3).why);
    assert(byId(3).ms < 2500, 'and gets a short timeout: ' + byId(3).ms);
    assert(byId(3).ms >= 400 + 200, 'which still leaves time to square up: ' + byId(3).ms);
    // the code with the numbers put in
    const tunedCode = V.rewriteTimeouts(code, sites, tune.tuned);
    assert(/moveToPoint\(0, 20, \d+\)/.test(tunedCode) && !/moveToPoint\(0, 20, 5000\)/.test(tunedCode), 'the timeout in the code is replaced');
    assert(/\/\/ a normal move/.test(tunedCode), 'the rest of the code is untouched');
    assert.strictEqual(tunedCode.length - code.length, sites.reduce((n, x) => n + String(tune.tuned[x.id]).length - x.timeout.text.length, 0), 'only the numbers changed');
    // running the tuned code gives a motion that is cut at its tuned time, and a shorter auton
    const before = await simulateWith(code)({});
    const after = await simulateWith(tunedCode)({});
    assert(after.durationMs < before.durationMs - 1500, `the tuned auton is quicker: ${after.durationMs} vs ${before.durationMs} ms`);
    assert.strictEqual(after.motions[3].reason, 'timeout');
    assert.strictEqual(after.motions[0].reason !== 'timeout', true, 'the normal moves still finish on their own');
    // settings change the answer
    const loose = await V.autoTune({ simulate: simulateWith(code), sites, options: { pct: 100, extraMs: 500, alignMs: 1500 } });
    assert(loose.rows[0].ms > tune.rows[0].ms && loose.rows[3].ms > tune.rows[3].ms, 'a bigger margin gives longer timeouts');

    // an aligner that catches the goal ends the wait right after the alignment
    const withPocket = await V.autoTune({ simulate: simulateWith(code, { front: { on: true, shapes: pocket }, back: { on: false } }), sites });
    assert.strictEqual(withPocket.rows[3].kind, 'aligned', 'aligned: ' + withPocket.rows[3].why);
    assert(withPocket.rows[3].ms < 1800, 'the timeout follows the alignment: ' + withPocket.rows[3].ms);

    // several random draws of the real-life error: each call gets the longest timeout any draw needed
    const simSeed = (seed) => async (extra) => {
      const c = V.compileAuton(code, { language: 'cpp', markSites: true });
      return V.runSimulation({ js: c.js, robot: ROBOT, start, cfg: cfg(), paths: [], chassisNames: ['chassis'], maxMs: 120000, world: { goals: {}, aligners: V.sanitizeAligners({}) }, realism: { enabled: true, seed }, ...extra });
    };
    const many = await V.autoTuneMany({ simulate: simSeed, sites, seeds: [11, 12, 13, 14] });
    assert.strictEqual(many.draws, 4);
    for (const seed of [11, 12, 13, 14]) {
      const one = await V.autoTune({ simulate: simSeed(seed), sites });
      sites.forEach((x) => assert(many.tuned[x.id] >= one.tuned[x.id], `call ${x.id}: ${many.tuned[x.id]} is at least what draw ${seed} needs (${one.tuned[x.id]})`));
    }

    // timeouts that are not plain numbers cannot be rewritten, but are still measured
    const varCode = 'int T = 3000; void autonomous() { chassis.moveToPoint(0, 20, T); chassis.waitUntilDone(); chassis.turnToHeading(90, 3000 + 500); chassis.waitUntilDone(); }';
    const vs = V.compileAuton(varCode, { language: 'cpp', markSites: true }).sites;
    assert.deepStrictEqual(vs.map((x) => x.timeout.value), [null, null]);
    const vt = await V.autoTune({ simulate: simulateWith(varCode), sites: vs });
    assert(vt.rows.every((r) => !r.editable && r.ms > 0), 'measured but not editable');
    assert.strictEqual(V.rewriteTimeouts(varCode, vs, vt.tuned), varCode, 'the code is left alone');

    // a call that runs several times (a loop) gets the longest timeout; comments and strings are not calls
    const loopCode = 'void autonomous() { for (int i = 1; i <= 3; i++) { chassis.moveToPoint(0, 10 * i, 4000); chassis.waitUntilDone(); } /* chassis.turnToHeading(5, 100); */ printf("chassis.moveToPoint(1,1,5)"); }';
    const ls = V.compileAuton(loopCode, { language: 'cpp', markSites: true }).sites;
    assert.strictEqual(ls.length, 1, 'comments and strings are skipped');
    const lt = await V.autoTune({ simulate: simulateWith(loopCode), sites: ls });
    assert.strictEqual(lt.rows[0].runs >= 3, true, 'it ran three times');
    assert(lt.rows[0].ms >= lt.rows[0].maxMs * 1.2, 'the longest run sets the timeout');
    console.log('ok auto-tune: margins, blocked moves, aligned goals, code rewrite');
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
