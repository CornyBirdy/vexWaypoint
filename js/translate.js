/*
 * Small C++ (PROS / LemLib) -> JavaScript translator.
 *
 * This is NOT a C++ compiler. It rewrites the handful of constructs that show
 * up in LemLib autonomous routines (calls, designated initialisers, enums,
 * simple declarations, loops, ifs) and ignores everything it does not know.
 * Calls on unknown objects (intake, lift, clamp, ...) become harmless no-ops.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  // ---------------------------------------------------------------- scanning helpers

  function stripComments(src) {
    let out = '';
    let i = 0;
    let q = null;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (q) {
        out += c;
        if (c === '\\') {
          out += d || '';
          i += 2;
          continue;
        }
        if (c === q) q = null;
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        q = c;
        out += c;
        i++;
        continue;
      }
      if (c === '/' && d === '/') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && d === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') out += '\n';
          i++;
        }
        i += 2;
        out += ' ';
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  /** the source with comments and the insides of strings blanked out, same length (newlines kept) */
  function maskSource(src) {
    const out = src.split('');
    const n = src.length;
    let i = 0;
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== '\n') {
          if (src[j] === '\\') j++;
          j++;
        }
        for (let k = i + 1; k < Math.min(j, n); k++) out[k] = ' ';
        i = j + 1;
      } else if (c === '/' && d === '/') {
        while (i < n && src[i] !== '\n') out[i++] = ' ';
      } else if (c === '/' && d === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        for (let k = i; k < stop; k++) if (src[k] !== '\n') out[k] = ' ';
        i = stop;
      } else i++;
    }
    return out.join('');
  }

  /** LemLib motions and the position of their timeout argument (0-based) in the call */
  const MOTION_TIMEOUT_ARG = { moveToPoint: 2, moveToPose: 3, turnToHeading: 1, turnToPoint: 2, swingToHeading: 2, swingToPoint: 3, follow: 2 };

  /**
   * Finds every `chassis.moveToPoint(...)`-style call in the code, remembers where its timeout argument is
   * (offsets in the ORIGINAL text) and renames the call to `moveToPoint__S<n>` so a run can tell the calls apart.
   * @returns {{src:string, sites:Array<{id:number, method:string, line:number, timeout:null|{start:number,end:number,text:string,value:number|null}}>}}
   */
  function markMotionSites(src) {
    const masked = maskSource(src);
    const re = new RegExp('(?:\\.|->)\\s*(' + Object.keys(MOTION_TIMEOUT_ARG).join('|') + ')\\s*\\(', 'g');
    const sites = [];
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(masked))) {
      const method = m[1];
      const open = m.index + m[0].length - 1;
      const nameEnd = m.index + m[0].indexOf(method) + method.length;
      // matching close paren and the top-level argument ranges
      let depth = 0;
      let close = -1;
      const cuts = [open + 1];
      for (let k = open; k < masked.length; k++) {
        const ch = masked[k];
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') {
          depth--;
          if (depth === 0) {
            close = k;
            break;
          }
        } else if (ch === ',' && depth === 1) cuts.push(k + 1);
      }
      if (close < 0) continue;
      cuts.push(close + 1);
      const idx = MOTION_TIMEOUT_ARG[method];
      let timeout = null;
      if (idx < cuts.length - 1) {
        let a = cuts[idx];
        let b = cuts[idx + 1] - 1;
        while (a < b && /\s/.test(src[a])) a++;
        while (b > a && /\s/.test(src[b - 1])) b--;
        const text = src.slice(a, b);
        timeout = { start: a, end: b, text, value: /^\d+$/.test(text) ? Number(text) : null };
      }
      const id = sites.length;
      sites.push({ id, method, line: src.slice(0, m.index).split('\n').length, timeout });
      out += src.slice(last, nameEnd) + '__S' + id;
      last = nameEnd;
    }
    return { src: out + src.slice(last), sites };
  }

  /** index of the bracket matching the one at `open` (string/char aware) */
  function matchBracket(s, open) {
    const pairs = { '(': ')', '{': '}', '[': ']' };
    const o = s[open];
    const c = pairs[o];
    let depth = 0;
    let q = null;
    for (let i = open; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === '\\') i++;
        else if (ch === q) q = null;
        continue;
      }
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === o) depth++;
      else if (ch === c) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** apply `fn` to the parts of `s` that are not inside "..." or '...' (a "%.2f" must keep its f) */
  function outsideStrings(s, fn) {
    return s.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|([^"']+|["'])/g, (all, str, code) => (str ? str : fn(code)));
  }

  function splitTopLevel(s) {
    const out = [];
    let depth = 0;
    let cur = '';
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        cur += ch;
        if (ch === '\\') cur += s[++i] || '';
        else if (ch === q) q = null;
        continue;
      }
      if (ch === '"' || ch === "'") q = ch;
      if ('([{'.includes(ch)) depth++;
      if (')]}'.includes(ch)) depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // ---------------------------------------------------------------- program structure

  /** top-level functions: `void name(...) { ... }` */
  function findFunctions(src) {
    const funcs = [];
    const re = /\b(?:void|int|auto|double|float|bool|long)\s+([A-Za-z_]\w*)\s*\(([^()]*)\)\s*\{/g;
    let m;
    let from = 0;
    while ((m = re.exec(src))) {
      if (m.index < from) continue;
      const open = m.index + m[0].length - 1;
      const close = matchBracket(src, open);
      if (close < 0) break;
      funcs.push({ name: m[1], params: m[2].trim(), body: src.slice(open + 1, close), start: m.index, end: close + 1 });
      from = close + 1;
      re.lastIndex = from;
    }
    return funcs;
  }

  // lemlib::Omniwheel constants (LemLib docs, "Configuration"): the real diameters, not the marketed ones
  const OMNI = {
    NEW_2: 2.125,
    NEW_275: 2.75, OLD_275: 2.75, NEW_275_HALF: 2.744, OLD_275_HALF: 2.74,
    NEW_325: 3.25, OLD_325: 3.25, NEW_325_HALF: 3.246, OLD_325_HALF: 3.246,
    NEW_4: 4, OLD_4: 4.18, NEW_4_HALF: 3.995, OLD_4_HALF: 4.175,
  };

  function numArg(s) {
    if (s == null) return undefined;
    const om = /Omniwheel::(\w+)/.exec(s);
    if (om) return OMNI[om[1]];
    const n = Number(String(s).replace(/[fFuUlL]+$/, ''));
    return isFinite(n) ? n : undefined;
  }

  /** pull drivetrain / controller numbers out of the global declarations */
  function extractConfig(clean) {
    const cfg = { assets: [], chassisName: 'chassis' };
    let m;
    const reAsset = /\bASSET\s*\(\s*(\w+)\s*\)/g;
    while ((m = reAsset.exec(clean))) cfg.assets.push(m[1]);

    const reDt = /\bDrivetrain\s+(\w+)\s*[({]([^;]*?)[)}]\s*;/;
    if ((m = reDt.exec(clean))) {
      const a = splitTopLevel(m[2]);
      cfg.drivetrain = {
        trackWidth: numArg(a[2]),
        wheelDiameter: numArg(a[3]),
        rpm: numArg(a[4]),
        horizontalDrift: numArg(a[5]),
      };
      // `Drivetrain dt(&leftMotors, &rightMotors, ...)`: the names the code uses for the two sides, so
      // `leftMotors.move(-60)` in a helper drives the simulated robot
      const grp = (x) => (x || '').replace(/^[\s&*]+/, '').trim();
      const l = grp(a[0]);
      const r = grp(a[1]);
      if (/^[A-Za-z_]\w*$/.test(l) && /^[A-Za-z_]\w*$/.test(r)) cfg.motorGroups = { left: l, right: r };
    }
    // odometry setup: tracking wheels (offset from the tracking centre) and which of them / the IMU go into OdomSensors
    const wheels = {};
    const reTw = /\bTrackingWheel\s+(\w+)\s*[({]([^;]*?)[)}]\s*;/g;
    while ((m = reTw.exec(clean))) wheels[m[1]] = { offset: numArg(splitTopLevel(m[2])[2]) };
    const reOs = /\bOdomSensors\s+(\w+)\s*[({]([^;]*?)[)}]\s*;/;
    if ((m = reOs.exec(clean))) {
      const a = splitTopLevel(m[2]).map((x) => x.replace(/^[\s&*]+/, '').trim());
      const used = (x) => !!x && !/^(nullptr|NULL|0)$/.test(x);
      const off = (x) => (wheels[x] && wheels[x].offset != null ? wheels[x].offset : 0);
      cfg.odom = {
        vertical: used(a[0]) ? { on: true, offset: off(a[0]) } : { on: false },
        second: used(a[1]),
        horizontal: used(a[2]) ? { on: true, offset: off(a[2]) } : { on: false },
        imu: used(a[4]),
      };
    }
    const settings = {};
    const reCs = /\bControllerSettings\s+(\w+)\s*[({]([^;]*?)[)}]\s*;/g;
    while ((m = reCs.exec(clean))) {
      const a = splitTopLevel(m[2]).map(numArg);
      settings[m[1]] = {
        kP: a[0], kI: a[1], kD: a[2], antiWindup: a[3],
        smallError: a[4], smallErrorTimeout: a[5], largeError: a[6], largeErrorTimeout: a[7], slew: a[8],
      };
    }
    const reCh = /\bChassis\s+(\w+)\s*[({]\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)/;
    if ((m = reCh.exec(clean))) {
      cfg.chassisName = m[1];
      if (settings[m[3]]) cfg.lateral = settings[m[3]];
      if (settings[m[4]]) cfg.angular = settings[m[4]];
    }
    // chassis(...) not found: fall back on conventional names
    if (!cfg.lateral && settings.lateral_controller) cfg.lateral = settings.lateral_controller;
    if (!cfg.angular && settings.angular_controller) cfg.angular = settings.angular_controller;

    // JAR-Template: Drive chassis(setup, motor_group(L...), motor_group(R...), gyro, wheel_diameter, wheel_ratio, ...)
    const reJar = /\bDrive\s+(\w+)\s*\(/.exec(clean);
    if (reJar) {
      const open = reJar.index + reJar[0].length - 1;
      const close = matchBracket(clean, open);
      if (close > 0) {
        cfg.chassisName = reJar[1];
        const a = splitTopLevel(clean.slice(open + 1, close));
        cfg.jarDrive = { left: motorList(a[1]), right: motorList(a[2]), wheelDiameter: numArg(a[4]), wheelRatio: numArg(a[5]) };
      }
    }
    return cfg;
  }

  /** `motor_group(LF, LB)` / `{&a, &b}` -> ['LF', 'LB'] */
  function motorList(s) {
    if (!s) return [];
    const m = /\(([^]*)\)\s*$/.exec(s.trim());
    return splitTopLevel(m ? m[1] : s.replace(/^[{&\s]+|[}\s]+$/g, '')).map((x) => x.replace(/^[&*\s]+/, '').trim()).filter((x) => /^[A-Za-z_]\w*$/.test(x));
  }

  const GEARS = [
    [/ratio6_1|blue|_06\b|600/i, 600],
    [/ratio18_1|green|_18\b|200/i, 200],
    [/ratio36_1|red|_36\b|100/i, 100],
  ];
  const gearOf = (s) => {
    for (const [re, rpm] of GEARS) if (re.test(s || '')) return rpm;
    return 0;
  };

  /**
   * Drive motors that the code may drive directly: PROS `pros::MotorGroup left_mg({1, -2})`,
   * `pros::Motor lf(1)`, VEXcode `motor LF = motor(PORT1, ratio6_1, false)`,
   * `motor_group LeftDrive = motor_group(LF, LB)`. Which side each is on comes from the
   * lemlib::Drivetrain / JAR Drive / RW-Template declarations, else from the name ("left...").
   */
  function findDriveMotors(clean, cfg) {
    const decls = [];
    const re = /\b(?:pros::)?(?:v5::)?(Motor_Group|MotorGroup|Motor|motor_group|motor)\s+([A-Za-z_]\w*)\s*(=\s*(?:pros::)?(?:v5::)?\w+\s*\(|\(|\{)/g;
    let m;
    while ((m = re.exec(clean))) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(clean, open);
      if (close < 0) continue;
      decls.push({ type: m[1], name: m[2], args: clean.slice(open + 1, close) });
    }
    if (!decls.length) return [];
    const side = {};
    const setSide = (names, sd) => names.forEach((n) => (side[n] = sd));
    // lemlib::Drivetrain dt(&left, &right, ...)
    const dt = /\bDrivetrain\s+\w+\s*[({]\s*&?\s*(\w+)\s*,\s*&?\s*(\w+)/.exec(clean);
    if (dt) {
      setSide([dt[1]], 'L');
      setSide([dt[2]], 'R');
    }
    if (cfg.jarDrive) {
      setSide(cfg.jarDrive.left, 'L');
      setSide(cfg.jarDrive.right, 'R');
    }
    const byName = (n) => {
      if (/^(?:left|l(?=[A-Z_\d]|f|b|m|t$|eft))|left|_l$|^L(?=\d|F|B|M|_)/i.test(n) && !/right/i.test(n)) return 'L';
      if (/^(?:right|r(?=[A-Z_\d]|f|b|m|t$))|right|_r$|^R(?=\d|F|B|M|_)/i.test(n)) return 'R';
      return null;
    };
    // short names (lf, lb, L1...) only count when no motor is called "left..." / "right...":
    // in a code base with left_mg / right_mg, "lb" is more likely a lady-brown arm
    const strong = decls.some((d) => !side[d.name] && /left|right/i.test(d.name));
    const out = [];
    const seen = new Set();
    // groups first, so their members inherit the group's side
    decls.sort((a, b) => (/group/i.test(b.type) ? 1 : 0) - (/group/i.test(a.type) ? 1 : 0));
    decls.forEach((d) => {
      let sd = side[d.name] || null;
      if (!sd && dt) return; // a Drivetrain was declared and this motor is not in it
      if (!sd && !cfg.jarDrive && (!strong || /left|right/i.test(d.name))) sd = byName(d.name);
      if (!sd) return;
      side[d.name] = sd;
      if (/group/i.test(d.type)) motorList('(' + d.args + ')').forEach((n) => side[n] || (side[n] = sd));
      if (seen.has(d.name)) return;
      seen.add(d.name);
      out.push({ name: d.name, side: sd, gearRpm: gearOf(d.args) });
    });
    // guessed from names only: it takes a left and a right side to make a drivetrain
    if (!dt && !cfg.jarDrive && !(out.some((o) => o.side === 'L') && out.some((o) => o.side === 'R'))) return [];
    // a group's cartridge: from its first member when it does not say
    out.forEach((o) => {
      if (o.gearRpm) return;
      const d = decls.find((x) => x.name === o.name);
      const first = d && /group/i.test(d.type) ? motorList('(' + d.args + ')')[0] : null;
      const fd = first && decls.find((x) => x.name === first);
      o.gearRpm = (fd && gearOf(fd.args)) || 200;
    });
    return out;
  }

  /** numbers like `(36.0 / 48.0) * 3.17 * M_PI` */
  function evalNumber(expr) {
    const e = String(expr).replace(/\bM_PI\b/g, String(Math.PI)).replace(/(\d)[fF]\b/g, '$1').trim();
    if (/^(true|false)$/.test(e)) return e === 'true';
    if (!/^[\d\s.+\-*/()eE]+$/.test(e)) return undefined;
    try {
      const v = Function('"use strict"; return (' + e + ');')();
      return typeof v === 'number' && isFinite(v) ? v : undefined;
    } catch (err) {
      return undefined;
    }
  }

  // ---------------------------------------------------------------- body translation

  const KEYWORDS = new Set([
    'if', 'else', 'while', 'for', 'do', 'return', 'switch', 'case', 'break', 'continue', 'new', 'delete',
    'throw', 'await', 'let', 'const', 'var', 'typeof', 'in', 'of', 'goto', 'default', 'sizeof',
  ]);

  const NUM_TYPES =
    '(?:(?:const|static|unsigned|signed|volatile)\\s+)*(?:int|float|double|bool|long|short|char|auto|size_t|u?int(?:8|16|32|64)_t|string)';

  /**
   * `while (cond) { body }` -> a loop the simulator can break out of when it is only waiting on
   * something it does not simulate (a lift or claw task). `do { } while (cond);` just gets the
   * runaway guard.
   */
  let loopCounter = 0;
  function guardWhileLoops(s) {
    let out = '';
    let i = 0;
    const re = /\bwhile\s*\(/g;
    let m;
    while ((m = re.exec(s))) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(s, open);
      if (close < 0) break;
      const cond = s.slice(open + 1, close);
      const after = /^\s*\{/.exec(s.slice(close + 1));
      if (after) {
        const bodyOpen = close + after[0].length;
        const bodyClose = matchBracket(s, bodyOpen);
        if (bodyClose >= 0) {
          const id = '__w' + loopCounter++;
          const raw = s.slice(bodyOpen, bodyClose + 1);
          // a loop that does nothing but wait (`while (liftBusy) { pros::delay(20); }`)
          const waitOnly = /^\{\s*(?:(?:await\s+)?(?:pros::)?delay\s*\([^;{}]*\)\s*;?\s*)*\}$/.test(raw) && /delay/.test(raw);
          const body = guardWhileLoops(raw);
          out += s.slice(i, m.index) + `{ const ${id} = __loopStart(${JSON.stringify(cond.trim())}, ${waitOnly}); while (__guard(), !__stuck(${id}) && (${cond})) ${body} }`;
          i = bodyClose + 1;
          re.lastIndex = i;
          continue;
        }
      }
      out += s.slice(i, open + 1) + '__guard(), (' + cond + ')';
      i = close;
      re.lastIndex = close;
    }
    return out + s.slice(i);
  }

  // RW-Template functions; inside a runAsync() lambda they go through __rw (the async context)
  const RW_FUNCS = [
    'driveTo', 'turnToAngle', 'turnToPoint', 'moveToPoint', 'boomerang', 'curveCircle', 'swing', 'driveProfiled',
    'turnProfiled', 'followPath', 'followPathRamsete', 'waitForMotion', 'waitUntilTraveled', 'waitUntilTurned',
    'waitUntilNear', 'runAsync', 'cancelMotion', 'isMotionRunning',
  ];
  // free functions that take time on the robot, so the translated code must await them
  const BLOCKING = ['delay', 'wait', 'sleep', 'sleep_for', 'task_delay'].concat(RW_FUNCS.filter((f) => !/^(cancelMotion|isMotionRunning)$/.test(f)));
  const MOTOR_BLOCKING = ['spinFor', 'spinToPosition', 'rotateFor', 'rotateTo'];

  /**
   * `[&]() { ... }` lambdas (callbacks, tasks) become a harmless no-op, except the ones handed to
   * RW-Template's runAsync(), which run in the background like on the robot.
   */
  function stripLambdas(s) {
    let out = '';
    let i = 0;
    const re = /\[[&=,\s\w]*\]\s*(\()?/g;
    let m;
    while ((m = re.exec(s))) {
      let close = m.index + m[0].length - 1;
      if (m[1]) {
        close = matchBracket(s, close);
        if (close < 0) break;
      }
      const after = /^\s*(?:mutable\s*)?(?:->\s*[\w:<>*&\s]+?)?\s*\{/.exec(s.slice(close + 1));
      if (!after) continue;
      const bodyOpen = close + after[0].length;
      const bodyClose = matchBracket(s, bodyOpen);
      if (bodyClose < 0) break;
      if (/\brunAsync\s*\(\s*$/.test(s.slice(0, m.index))) {
        const body = stripLambdas(s.slice(bodyOpen + 1, bodyClose)).replace(new RegExp('(^|[^.\\w])(' + RW_FUNCS.join('|') + ')\\s*\\(', 'g'), '$1__rw.$2(');
        out += s.slice(i, m.index) + 'async () => {' + body + '}';
      } else out += s.slice(i, m.index) + 'NOOP';
      i = bodyClose + 1;
      re.lastIndex = i;
    }
    return out + s.slice(i);
  }

  /** VEXcode's `waitUntil(cond);` macro (not chassis.waitUntil) -> a polling loop */
  function waitUntilMacro(s) {
    let out = '';
    let i = 0;
    const re = /(^|[^.\w])waitUntil\s*\(/g;
    let m;
    while ((m = re.exec(s))) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(s, open);
      if (close < 0) break;
      const semi = /^\s*;/.exec(s.slice(close + 1));
      out += s.slice(i, m.index) + m[1] + `while (!(${s.slice(open + 1, close)})) { delay(5); }`;
      i = close + 1 + (semi ? semi[0].length : 0);
      re.lastIndex = i;
    }
    return out + s.slice(i);
  }

  /** remove `pros::MotorGroup left_mg({1, 2});` style declarations of motors the sim drives */
  function dropDecls(s, names) {
    if (!names || !names.length) return s;
    const re = new RegExp('(^|[;{}\\n])\\s*(?:const\\s+)?[A-Za-z_][\\w:]*\\s+(' + names.join('|') + ')\\s*(?=[=({])', 'g');
    let out = '';
    let i = 0;
    let m;
    while ((m = re.exec(s))) {
      const end = s.indexOf(';', m.index + m[0].length);
      if (end < 0) break;
      out += s.slice(i, m.index) + m[1];
      i = end + 1;
      re.lastIndex = i;
    }
    return out + s.slice(i);
  }

  /** RW-Template `pathFromPoints({{x, y}, ...})`: brace lists -> arrays */
  function pathBraces(s) {
    let out = '';
    let i = 0;
    const re = /\bpathFromPoints\s*\(/g;
    let m;
    while ((m = re.exec(s))) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(s, open);
      if (close < 0) break;
      out += s.slice(i, open) + s.slice(open, close + 1).replace(/\{/g, '[').replace(/\}/g, ']');
      i = close + 1;
      re.lastIndex = i;
    }
    return out + s.slice(i);
  }

  /** `x = { 1, 2, 3 }` (not `{ .a = 1 }`) is a list: use brackets so JS can read it */
  function bracesToArrays(s) {
    let out = '';
    let i = 0;
    const re = /=\s*\{/g;
    let m;
    while ((m = re.exec(s))) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(s, open);
      if (close < 0) break;
      const inner = s.slice(open, close + 1);
      if (/[A-Za-z_]\w*\s*:/.test(inner)) {
        re.lastIndex = open + 1;
        continue;
      }
      out += s.slice(i, open) + inner.replace(/\{/g, '[').replace(/\}/g, ']');
      i = close + 1;
      re.lastIndex = i;
    }
    return out + s.slice(i);
  }

  const TEMPLATES = '(?:vector|array|map|unordered_map|set|function|unique_ptr|shared_ptr|pair|tuple|optional|deque)';

  // plain-data structs of the file being compiled: name -> [{name, def}] in declaration order
  let STRUCTS = {};

  /** `{a: 1, b: 2}` for a struct value built from a C++ brace list (positional, or designated `.b = 2`); gaps get the defaults */
  function structObject(name, items) {
    const st = STRUCTS[name];
    const vals = {};
    items.forEach((it, i) => {
      const d = /^\.\s*([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(it);
      if (d) vals[d[1]] = d[2];
      else if (st[i]) vals[st[i].name] = it;
    });
    return '{' + st.map((f) => f.name + ': ' + (vals[f.name] != null ? vals[f.name] : f.def)).join(', ') + '}';
  }

  /**
   * `struct Goal { float x; float y; };` (data only: a struct with methods or a destructor is left alone) is
   * removed from the code and remembered, so `Goal g = {24, 15.5};` and `g = {1, 2};` can become objects.
   * @returns {string} JS for any variable declared right after the closing brace
   */
  function takeStructs(clean) {
    STRUCTS = {};
    let out = '';
    let pre = '';
    let i = 0;
    const re = /\bstruct\s+([A-Za-z_]\w*)\s*\{/g;
    let m;
    while ((m = re.exec(clean))) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(clean, open);
      if (close < 0) break;
      const body = clean.slice(open + 1, close);
      if (/[()]/.test(body)) {
        re.lastIndex = close + 1;
        continue;
      }
      const fields = [];
      body.split(';').forEach((mem) => {
        const t = /^(?:(?:const|static|mutable|unsigned|signed|volatile|inline)\s+)*[A-Za-z_][\w:]*(?:<[^>]*>)?[&*]*\s+([\s\S]+)$/.exec(mem.trim());
        if (!t) return;
        splitTopLevel(t[1]).forEach((d) => {
          const dm = /^([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+))?$/.exec(d.trim());
          if (dm) fields.push({ name: dm[1], def: dm[2] != null ? translateExpr(dm[2]) : '0' });
        });
      });
      const tail = /^\s*([A-Za-z_]\w*)?\s*;/.exec(clean.slice(close + 1));
      if (!fields.length || !tail) {
        re.lastIndex = close + 1;
        continue;
      }
      STRUCTS[m[1]] = fields;
      if (tail[1]) pre += `let ${tail[1]} = ${structObject(m[1], [])};\n`;
      out += clean.slice(i, m.index);
      i = close + 1 + tail[0].length;
      re.lastIndex = i;
    }
    return { clean: out + clean.slice(i), prelude: pre };
  }

  /** `v = {1, 2}` / `Goal v = {1, 2}` for a variable of a known struct type -> `v = {x: 1, y: 2}` */
  function structInitialisers(clean) {
    const names = Object.keys(STRUCTS);
    if (!names.length) return clean;
    const reVar = new RegExp('\\b(' + names.join('|') + ')\\s*[&*]*\\s+([A-Za-z_]\\w*)\\b', 'g');
    const vars = new Map();
    let m;
    while ((m = reVar.exec(clean))) if (!KEYWORDS.has(m[2])) vars.set(m[2], m[1]);
    vars.forEach((type, v) => {
      clean = clean.replace(new RegExp('\\b' + v + '\\s*=\\s*\\{([^{}]*)\\}', 'g'), (all, inner) => v + ' = ' + structObject(type, splitTopLevel(inner)));
    });
    return clean;
  }

  function translateBody(body, chassisNames, helperNames, motorNames) {
    let s = dropDecls(body, motorNames);
    s = stripLambdas(s);
    s = waitUntilMacro(s);
    s = pathBraces(s);
    s = s.replace(/->/g, '.');
    // enums first, then drop namespaces
    s = s.replace(/\b(?:\w+::)*(?:DriveSide|AngularDirection)::(\w+)/g, '"$1"');
    s = s.replace(/\b(?:lemlib|pros|std|okapi|vex)::(?:c::)?/g, '');
    s = s.replace(/\b[A-Za-z_]\w*::([A-Za-z_]\w*)/g, '$1');
    // designated initialisers: {.a = 1, .b = 2}
    s = s.replace(/([{,]\s*)\.([A-Za-z_]\w*)\s*=(?!=)/g, '$1$2:');
    // Pose with braces: `Pose{1, 2, 3}`, `Pose p{1, 2, 3};` and `setPose({1, 2, 3})`
    s = s.replace(/\bsetPose\s*\(\s*\{([^{}]*)\}/g, 'setPose(Pose($1)');
    s = s.replace(/\bPose\s+([A-Za-z_]\w*)\s*\{([^{}]*)\}/g, 'Pose $1($2)');
    s = s.replace(/\bPose\s*\{([^{}]*)\}/g, 'Pose($1)');
    // a brace list passed as an argument, `avg({1, 2, 3})`: an array (empty `{}` and `{.a = 1}` params are left alone)
    s = s.replace(/([(,]\s*)\{(\s*[^\s{}:][^{}:]*)\}/g, '$1[$2]');
    // C++-only syntax
    s = s.replace(/\b(?:static|reinterpret|const|dynamic)_cast\s*<[^>]*>/g, '');
    s = outsideStrings(s, (c) =>
      c
        .replace(/\(\s*(?:(?:unsigned|signed|const)\s+)*(?:int|float|double|bool|long|short|char|size_t|u?int(?:8|16|32|64)_t)\s*\)/g, '')
        .replace(/\b(\d+\.?\d*|\.\d+)[fF]\b/g, '$1')
        .replace(/\b(\d+)[uUlL]+\b/g, '$1')
    );
    s = s.replace(/\bnullptr\b|\bNULL\b/g, 'null');

    // std containers: `vector<Pose> stops = {...}` -> `let stops = [...]`
    s = s.replace(new RegExp('\\b' + TEMPLATES + '\\s*<[^<>;(){}]*>\\s*[&*]?\\s*(?=[A-Za-z_])', 'g'), 'let ');
    // range-for: for (auto& p : list)
    s = s.replace(/\bfor\s*\(\s*(?:const\s+)?[A-Za-z_][\w:]*\s*[&*]*\s*([A-Za-z_]\w*)\s*:\s*([^()]+?)\)/g, 'for (let $1 of $2)');

    // declarations
    const declNum = new RegExp('(^|[;{}(\\s])' + NUM_TYPES + '\\s*[&*]*\\s+([A-Za-z_]\\w*)(?=\\s*(?:=(?!=)|;|,|\\[))', 'g');
    s = s.replace(declNum, '$1let $2');
    s = s.replace(/\blet\s+(\w+)\s*\[[^\]]*\]\s*=\s*\{([^}]*)\}/g, 'let $1 = [$2]');
    // `Pose p(1, 2, 3);`  and  `Foo bar(args);`
    // (a match eats the `;` that the next declaration on the same line starts after, so go round again)
    for (let pass = 0, prev = ''; pass < 6 && prev !== s; pass++) {
      prev = s;
      s = s.replace(/(^|[;{}\n])(\s*)([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^()]*)\)\s*;/g, (all, pre, ws, type, name, args) => {
        if (KEYWORDS.has(type)) return all;
        if (type === 'Pose' || type === 'Timer' || type === 'PID') return `${pre}${ws}let ${name} = ${type}(${args});`;
        return `${pre}${ws}let ${name} = NOOP;`;
      });
    }
    // `Foo bar = expr;`  and  `Foo bar;`
    for (let pass = 0, prev = ''; pass < 6 && prev !== s; pass++) {
      prev = s;
      s = s.replace(/(^|[;{}\n])(\s*)([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(=(?!=)|;)/g, (all, pre, ws, type, name, tail) => {
        if (KEYWORDS.has(type)) return all;
        if (tail === ';' && STRUCTS[type]) return `${pre}${ws}let ${name} = ${structObject(type, [])};`;
        return `${pre}${ws}let ${name} ${tail === ';' ? '= NOOP;' : '='}`;
      });
    }

    s = bracesToArrays(s);
    s = guardWhileLoops(s);

    // blocking behaviour: every chassis call / delay must be awaited
    const names = chassisNames.join('|');
    s = s.replace(new RegExp('\\b(' + names + ')\\.([A-Za-z_]\\w*)\\s*\\(', 'g'), 'await $1.$2(');
    s = s.replace(new RegExp('(^|[^.\\w])(' + BLOCKING.join('|') + ')\\s*\\(', 'g'), '$1await $2(');
    s = s.replace(new RegExp('\\b__rw\\.(' + BLOCKING.join('|') + ')\\s*\\(', 'g'), 'await __rw.$1(');
    s = s.replace(new RegExp('\\b([A-Za-z_]\\w*)\\.(' + MOTOR_BLOCKING.join('|') + ')\\s*\\(', 'g'), 'await $1.$2(');
    if (helperNames && helperNames.length) {
      s = s.replace(new RegExp('(^|[^.\\w])(' + helperNames.join('|') + ')\\s*\\(', 'g'), '$1await $2(');
    }
    s = s.replace(/\bawait\s+await\b/g, 'await');
    return s;
  }

  // functions that belong to the robot program but are never an autonomous routine
  const NOT_AUTON = new Set([
    'initialize', 'opcontrol', 'disabled', 'competition_initialize', 'main', 'on_center_button',
    'pre_auton', 'usercontrol', 'vexcodeInit', 'runDriver', 'runPreAutonomous',
  ]);

  function paramNames(params) {
    if (!params || params === 'void') return '';
    return splitTopLevel(params)
      .map((p) => {
        const m = /([A-Za-z_]\w*)\s*(=.*)?$/.exec(p.trim());
        const dflt = m && m[2] ? ' ' + translateExpr(m[2]) : '';
        return m ? m[1] + dflt : '';
      })
      .filter(Boolean)
      .join(', ');
  }

  /** a single expression / initialiser from a declaration */
  function translateExpr(e) {
    return outsideStrings(e, (c) =>
      c
        .replace(/\b(?:\w+::)*(?:DriveSide|AngularDirection)::(\w+)/g, '"$1"')
        .replace(/\b(?:lemlib|pros|std|okapi|vex)::(?:c::)?/g, '')
        .replace(/\b[A-Za-z_]\w*::([A-Za-z_]\w*)/g, '$1')
        .replace(/\b(\d+\.?\d*|\.\d+)[fF]\b/g, '$1')
        .replace(/\b(\d+)[uUlL]+\b/g, '$1')
        .replace(/\bnullptr\b|\bNULL\b/g, 'null')
    ).trim();
  }

  let AsyncFunctionCtor = null;
  function parses(js) {
    try {
      if (!AsyncFunctionCtor) AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor;
      new AsyncFunctionCtor('with (this) {\n' + js + '\n}');
      return null;
    } catch (e) {
      return e.message;
    }
  }

  /**
   * @param {string} source  full C++ file (or just a function body) / or JS
   * @param {{language:'cpp'|'js', routine?:string}} opts
   * @returns {{js:string, routines:string[], routine:string, config:object, warnings:string[], ignored:string[]}}
   */
  function compile(source, opts) {
    opts = opts || {};
    if (opts.markSites) {
      // number every motion call (for auto-tuning the timeouts); the translator sees the renamed calls
      const mk = markMotionSites(source);
      const r = compileInner(mk.src, opts);
      r.sites = mk.sites;
      return r;
    }
    return compileInner(source, opts);
  }

  function compileInner(source, opts) {
    const warnings = [];
    const ignored = [];
    if (opts.language === 'js') {
      return { js: source, routines: [], routine: '', config: { assets: [], chassisName: 'chassis', motors: [], rw: {}, templates: [] }, warnings, ignored };
    }
    let clean = stripComments(source);

    // simple `#define NAME value` constants, then drop the preprocessor lines
    let prelude = '';
    const reDef = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+([^\r\n]+)$/gm;
    let m;
    while ((m = reDef.exec(clean))) {
      const val = translateExpr(m[2]);
      if (!/[(){};]/.test(val)) prelude += `let ${m[1]} = ${val};\n`;
    }
    clean = clean.replace(/^[ \t]*#.*$/gm, '');

    // enums: `enum class Side { LEFT, RIGHT = 5 };` -> plain constants
    clean = clean.replace(/\benum\s+(?:class\s+|struct\s+)?[A-Za-z_]\w*\s*(?::\s*[\w\s]+?)?\s*\{([^}]*)\}\s*;?/g, (all, members) => {
      let next = 0;
      splitTopLevel(members).forEach((mem) => {
        const mm = /^([A-Za-z_]\w*)\s*(?:=\s*(.+))?$/.exec(mem.trim());
        if (!mm) return;
        if (mm[2] != null) {
          const v = Number(translateExpr(mm[2]));
          if (isFinite(v)) next = v;
        }
        prelude += `let ${mm[1]} = ${next++};\n`;
      });
      return '';
    });

    const taken = takeStructs(clean);
    clean = structInitialisers(taken.clean);
    prelude += taken.prelude;

    const funcs = findFunctions(clean);

    // everything outside the functions is "globals"
    let globals = clean;
    for (let i = funcs.length - 1; i >= 0; i--) globals = globals.slice(0, funcs[i].start) + globals.slice(funcs[i].end);
    const config = extractConfig(globals);
    config.motors = findDriveMotors(globals || clean, config);
    const motorNames = config.motors.map((x) => x.name);

    // RW-Template settings (robot-config.cpp): read here, used by the RW motions
    const rwNames = new Set(NS.RW_SETTING_NAMES || []);
    config.rw = {};
    const reRw = /(?:^|[;}\n,])\s*(?:(?:RW_DEFAULT|const|static|constexpr)\s+)*(?:double|float|int|bool)?\s*([A-Za-z_]\w*)\s*=\s*([^;,{}]+?)(?=\s*[;,])/g;
    while ((m = reRw.exec(globals))) {
      if (!rwNames.has(m[1])) continue;
      const v = evalNumber(m[2]);
      if (v !== undefined) config.rw[m[1]] = typeof v === 'boolean' ? v : v;
    }

    // simple top-level constants: `const Side SIDE = Side::RIGHT;`, `bool useClamp = true;`
    const reConst = /(?:^|[;}\n])\s*(?:(?:const|static|constexpr|inline|volatile|unsigned|signed)\s+)*([A-Za-z_][\w:]*(?:<[^>;]*>)?)[&*]*\s+([A-Za-z_]\w*)\s*=\s*([^;(){}]+);/g;
    // (a bare list of statements declares its own variables in the body)
    while (funcs.length && (m = reConst.exec(globals))) {
      if (KEYWORDS.has(m[1]) || m[1] === 'ASSET' || m[1] === 'using' || m[1] === 'typedef') continue;
      if (rwNames.has(m[2])) continue; // the sim owns these (see config.rw)
      prelude += `let ${m[2]} = ${translateExpr(m[3])};\n`;
    }
    config.templates = detectTemplates(clean, config);

    // global variables of a struct type: `inline constexpr Goal GOAL_A = {24, 15.55};`, `ResetDebug last;`
    Object.keys(STRUCTS).forEach((S) => {
      const reS = new RegExp('(?:^|[;}\\n])\\s*(?:(?:inline|constexpr|const|static)\\s+)*' + S + '\\s+([A-Za-z_]\\w*)\\s*(?:=\\s*(\\{[^{}]*\\}))?\\s*;', 'g');
      while ((m = reS.exec(globals))) prelude += `let ${m[1]} = ${translateExpr(m[2] || structObject(S, []))};\n`;
    });

    const names = Array.from(new Set(['chassis', config.chassisName]));
    const candidates = funcs.filter((f) => (f.params === '' || f.params === 'void') && !NOT_AUTON.has(f.name));
    const routines = candidates.map((f) => f.name);

    if (!funcs.length) {
      // a bare list of statements
      return { js: prelude + translateBody(clean, names, [], motorNames), routines: [], routine: '', config, warnings, ignored };
    }

    let pick = opts.routine && candidates.find((f) => f.name === opts.routine);
    if (!pick) pick = candidates.find((f) => f.name === 'autonomous') || candidates.find((f) => /auto/i.test(f.name)) || candidates[0];
    if (!pick) {
      warnings.push('No autonomous routine found: add a function like  void autonomous() { ... }');
      return { js: prelude, routines, routine: '', config, warnings, ignored };
    }

    // every other function with a body becomes a callable helper
    const helpers = funcs.filter((f) => f !== pick && !NOT_AUTON.has(f.name));
    const helperNames = helpers.map((f) => f.name);
    let defs = '';
    const usable = [];
    helpers.forEach((f) => {
      const def = `async function ${f.name}(${paramNames(f.params)}) {\n${translateBody(f.body, names, helperNames, motorNames)}\n}\n`;
      const err = parses(def);
      if (err) {
        warnings.push(`${f.name}() could not be translated (${err}); calls to it are ignored.`);
        ignored.push(f.name);
      } else {
        defs += def;
        usable.push(f.name);
      }
    });
    NOT_AUTON.forEach((n) => funcs.some((f) => f.name === n) && ignored.push(n));

    const body = translateBody(pick.body, names, usable, motorNames);
    return { js: prelude + defs + body, routines, routine: pick.name, config, warnings, ignored };
  }

  /** which libraries / styles the code uses, for the run log */
  function detectTemplates(clean, config) {
    const t = [];
    if (/\.\s*(?:moveToPoint|moveToPose|turnToHeading|swingToHeading|swingToPoint|follow)\s*\(|lemlib::/.test(clean)) t.push('LemLib');
    if (config.jarDrive || /\.\s*(?:drive_distance|turn_to_angle|drive_to_point|drive_to_pose|left_swing_to_angle|right_swing_to_angle|set_coordinates)\s*\(/.test(clean)) t.push('JAR-Template');
    if (/(?:^|[^.\w])(?:driveTo|turnToAngle|boomerang|curveCircle|runAsync|driveProfiled|turnProfiled|followPath)\s*\(|(?:^|[^.\w])moveToPoint\s*\([^;]*,\s*-?1\s*,/.test(clean)) t.push('RW-Template');
    if (config.motors && config.motors.length) {
      const usedRaw = config.motors.some((mo) => new RegExp('\\b' + mo.name + '\\s*\\.\\s*(?:move|move_voltage|move_velocity|move_relative|move_absolute|spin|spinFor|spinToPosition|rotateFor)\\s*\\(').test(clean));
      if (usedRaw) t.push(/\bpros::/.test(clean) ? 'PROS motors' : 'VEXcode motors');
    }
    return t;
  }

  /** lines of translated code that do not parse on their own (a hint for where a syntax error is) */
  function diagnose(js) {
    const bad = [];
    js.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (!t || !/;$/.test(t) || /^(?:\}|\)|\])/.test(t)) return;
      if (parses(t)) bad.push(`line ${i + 1}: ${t.length > 90 ? t.slice(0, 90) + '...' : t}`);
    });
    return bad.slice(0, 3);
  }

  Object.assign(NS, { compileAuton: compile, diagnoseJs: diagnose, stripComments, splitTopLevel, markMotionSites, MOTION_TIMEOUT_ARG });
})();
