// Tests for the path editor model and exporters. Run with: node tests/editor.test.js
'use strict';
const path = require('path');
const assert = require('assert');
for (const f of ['lemlib', 'paths', 'editor', 'export']) require(path.join('..', 'js', f + '.js'));
const V = globalThis.VSim;
const E = V.Editor;
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b} +-${tol}`);

// ---- building a path: first segment starts at the robot, later ones continue smoothly
const pr = new E.Project();
const p = pr.addPath('Route');
const start = { x: -60, y: -60, heading: 0 };
const s1 = E.addSegment(p, -36, -36, true, start);
assert.strictEqual(s1.controls.length, 4);
assert.strictEqual(s1.controls[0].x, -60);
// leaves along the robot's heading (up) because the target is in front-ish
assert(s1.controls[1].y > s1.controls[0].y);
const s2 = E.addSegment(p, 0, -20, true, start);
assert.strictEqual(s2.controls[0], s1.controls[3], 'segments share their joint');
// the new first control mirrors the previous one around the joint
near(s2.controls[1].x - s2.controls[0].x, s2.controls[0].x - s1.controls[2].x, 1e-9, 'mirrored control x');
const s3 = E.addSegment(p, 20, 0, false, start);
assert.strictEqual(s3.controls.length, 2);
assert.strictEqual(E.controlsOf(p).length, 4 + 3 + 1);

// ---- dragging an end point drags its handles unless asked not to
const joint = s1.controls[3];
const h1 = { x: s1.controls[2].x, y: s1.controls[2].y };
const h2 = { x: s2.controls[1].x, y: s2.controls[1].y };
E.dragControl(p, joint, joint.x + 5, joint.y + 3, false);
near(s1.controls[2].x, h1.x + 5, 1e-9, 'handle before follows');
near(s2.controls[1].y, h2.y + 3, 1e-9, 'handle after follows');
assert.strictEqual(s2.controls[0].x, joint.x, 'the joint is one point');
const j2x = s1.controls[2].x;
E.dragControl(p, joint, joint.x + 1, joint.y, true);
assert.strictEqual(s1.controls[2].x, j2x, 'ctrl-drag leaves handles');

// ---- split / convert / remove
const n0 = p.segments.length;
const created = E.splitSegment(p, s2, { x: 10, y: -10 });
assert.strictEqual(p.segments.length, n0 + 1);
assert.strictEqual(p.segments[p.segments.indexOf(s2) + 1], created);
assert.strictEqual(s2.controls[3], created.controls[0], 'split joint shared');
E.convertSegment(p, s2);
assert.strictEqual(s2.controls.length, 2);
E.convertSegment(p, s2);
assert.strictEqual(s2.controls.length, 4);
const before = p.segments.length;
E.removeEndControl(p, E.controlsOf(p).filter((c) => c.__type === 'end-point').at(-1));
assert.strictEqual(p.segments.length, before - 1);

// ---- history: undo / redo restore shared joints
pr.checkpoint();
E.addSegment(p, 40, 40, true, start);
const countAfter = p.segments.length;
assert(pr.undo());
const p2 = pr.paths[0];
assert.strictEqual(p2.segments.length, countAfter - 1);
for (let i = 1; i < p2.segments.length; i++) assert.strictEqual(p2.segments[i].controls[0], p2.segments[i - 1].controls.at(-1), 'joint relinked after undo');
assert(pr.redo());
assert.strictEqual(pr.paths[0].segments.length, countAfter);

// ---- speed keyframes change the profile
const q = pr.paths[0];
const base = V.computePathPoints(q, pr.gc);
const kf = E.addKeyframe(q.segments[0], 0.5, 0.2);
const slowed = V.computePathPoints(q, pr.gc);
assert(Math.min(...slowed.map((x) => x.v)) < Math.min(...base.map((x) => x.v)) || slowed.some((x, i) => x.v < base[i].v - 1), 'a low keyframe slows the path down');
E.removeKeyframe(q, kf.uid);
assert.strictEqual(q.segments[0].speedProfiles.length, 0);

// ---- exports can be read back
const pts = V.computePathPoints(q, pr.gc);
assert(pts.length > 20);
const json = E.Project.from(pr.serialize());
const projText = V.Export.exportProject(pr);
const back = V.parsePathFile('mine.jerryio', projText);
assert.strictEqual(back.paths.length, 1, back.warnings.join(';'));
near(back.paths[0].points.length, pts.length, 1, 'same point count after project round trip');
near(back.paths[0].points.at(-1).x, pts.at(-1).x, 1e-6, 'same end x');

const txt = V.Export.exportLemlib04(pr, q);
const backTxt = V.parsePathFile('mine.txt', txt);
assert.strictEqual(backTxt.paths.length, 1, backTxt.warnings.join(';'));
assert.strictEqual(backTxt.paths[0].ghost, true);
assert.strictEqual(backTxt.paths[0].points.length, pts.length + 1);
near(backTxt.paths[0].points[5].v, pts[5].v, 0.001, 'speed written to text');
assert(/endData\n127\n100\n200\n/.test(txt), 'v0.4 trailer');

const bin = V.Export.exportLemlib1(pr, [q], 1.6);
const backBin = V.parsePathFile('mine.bin', bin);
assert.strictEqual(backBin.paths.length, 1, backBin.warnings.join(';'));
assert.strictEqual(backBin.paths[0].unit, 'mm');
near(V.pointsInInches(backBin.paths[0]).at(-1).x, pts.at(-1).x, 0.05, 'binary x in inches');
near(backBin.paths[0].points[3].v, (pts[3].v / 127) * 1.6, 0.002, 'binary speed in m/s');

// ---- import a jerry.io project in cm: converted to inches, keeps editing structure
const cmProject = {
  appVersion: '0.11.0', format: 'LemLib v0.4', gc: { uol: 1, pointDensity: 5 },
  paths: [{
    name: 'Imported', uid: 'abcdefghij', lock: false, visible: true,
    pc: { speedLimit: { from: 20, to: 100 }, bentRateApplicableRange: { from: 0, to: 0.1 }, maxDecelerationRate: 127 },
    segments: [
      { uid: 'segmentaaaa', speedProfiles: [], controls: [{ __type: 'end-point', uid: 'endpointaaa', x: 0, y: 0, heading: 0 }, { __type: 'end-point', uid: 'endpointbbb', x: 254, y: 0, heading: 0 }] },
      { uid: 'segmentbbbb', speedProfiles: [], controls: [{ __type: 'end-point', uid: 'endpointbbb', x: 254, y: 0, heading: 0 }, { __type: 'end-point', uid: 'endpointccc', x: 254, y: 254, heading: 0 }] },
    ],
  }],
};
const pr2 = new E.Project();
const added = E.importPaths(cmProject, pr2, 'x.jerryio');
assert.strictEqual(added.length, 1);
near(added[0].segments[0].controls[1].x, 100, 1e-9, 'cm -> inches');
assert.strictEqual(added[0].segments[0].controls[1], added[0].segments[1].controls[0], 'shared joint after import');

console.log('ALL EDITOR TESTS PASSED');
