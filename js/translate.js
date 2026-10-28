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
    const re = /\b(?:void|int|auto)\s+([A-Za-z_]\w*)\s*\(([^()]*)\)\s*\{/g;
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
    return cfg;
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

  /** `[&]() { ... }` lambdas (callbacks, tasks) become a harmless no-op */
  function stripLambdas(s) {
    let out = '';
    let i = 0;
    const re = /\[[&=,\s\w]*\]\s*\(/g;
    let m;
    while ((m = re.exec(s))) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(s, open);
      if (close < 0) break;
      const after = /^\s*(?:mutable\s*)?(?:->\s*[\w:<>*&\s]+?)?\s*\{/.exec(s.slice(close + 1));
      if (!after) continue;
      const bodyOpen = close + after[0].length;
      const bodyClose = matchBracket(s, bodyOpen);
      if (bodyClose < 0) break;
      out += s.slice(i, m.index) + 'NOOP';
      i = bodyClose + 1;
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

  function translateBody(body, chassisNames, helperNames) {
    let s = stripLambdas(body);
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
    s = s.replace(/\(\s*(?:unsigned\s+)?(?:int|float|double|bool|long|short|size_t)\s*\)/g, '');
    s = s.replace(/\b(\d+\.?\d*|\.\d+)[fF]\b/g, '$1');
    s = s.replace(/\b(\d+)[uUlL]+\b/g, '$1');
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
        return `${pre}${ws}let ${name} ${tail === ';' ? '= NOOP;' : '='}`;
      });
    }

    s = bracesToArrays(s);
    s = guardWhileLoops(s);

    // blocking behaviour: every chassis call / delay must be awaited
    const names = chassisNames.join('|');
    s = s.replace(new RegExp('\\b(' + names + ')\\.([A-Za-z_]\\w*)\\s*\\(', 'g'), 'await $1.$2(');
    s = s.replace(/(^|[^.\w])delay\s*\(/g, '$1await delay(');
    if (helperNames && helperNames.length) {
      s = s.replace(new RegExp('(^|[^.\\w])(' + helperNames.join('|') + ')\\s*\\(', 'g'), '$1await $2(');
    }
    s = s.replace(/\bawait\s+await\b/g, 'await');
    return s;
  }

  // functions that belong to the robot program but are never an autonomous routine
  const NOT_AUTON = new Set(['initialize', 'opcontrol', 'disabled', 'competition_initialize', 'main', 'on_center_button']);

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
    return e
      .replace(/\b(?:\w+::)*(?:DriveSide|AngularDirection)::(\w+)/g, '"$1"')
      .replace(/\b(?:lemlib|pros|std|okapi|vex)::(?:c::)?/g, '')
      .replace(/\b[A-Za-z_]\w*::([A-Za-z_]\w*)/g, '$1')
      .replace(/\b(\d+\.?\d*|\.\d+)[fF]\b/g, '$1')
      .replace(/\b(\d+)[uUlL]+\b/g, '$1')
      .replace(/\bnullptr\b|\bNULL\b/g, 'null')
      .trim();
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
      return { js: source, routines: [], routine: '', config: { assets: [], chassisName: 'chassis' }, warnings, ignored };
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

    const funcs = findFunctions(clean);

    // everything outside the functions is "globals"
    let globals = clean;
    for (let i = funcs.length - 1; i >= 0; i--) globals = globals.slice(0, funcs[i].start) + globals.slice(funcs[i].end);
    const config = extractConfig(globals);

    // simple top-level constants: `const Side SIDE = Side::RIGHT;`, `bool useClamp = true;`
    const reConst = /(?:^|[;}\n])\s*(?:(?:const|static|constexpr|inline|volatile|unsigned|signed)\s+)*([A-Za-z_][\w:]*(?:<[^>;]*>)?)[&*]*\s+([A-Za-z_]\w*)\s*=\s*([^;(){}]+);/g;
    while ((m = reConst.exec(globals))) {
      if (KEYWORDS.has(m[1]) || m[1] === 'ASSET') continue;
      prelude += `let ${m[2]} = ${translateExpr(m[3])};\n`;
    }

    const names = Array.from(new Set(['chassis', config.chassisName]));
    const candidates = funcs.filter((f) => (f.params === '' || f.params === 'void') && !NOT_AUTON.has(f.name));
    const routines = candidates.map((f) => f.name);

    if (!funcs.length) {
      // a bare list of statements
      return { js: prelude + translateBody(clean, names, []), routines: [], routine: '', config, warnings, ignored };
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
      const def = `async function ${f.name}(${paramNames(f.params)}) {\n${translateBody(f.body, names, helperNames)}\n}\n`;
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

    const body = translateBody(pick.body, names, usable);
    return { js: prelude + defs + body, routines, routine: pick.name, config, warnings, ignored };
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
