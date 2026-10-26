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

  const OMNI = {
    NEW_275: 2.75, OLD_275: 2.75, NEW_275_HALF: 2.75, OLD_275_HALF: 2.75,
    NEW_325: 3.25, OLD_325: 3.25, NEW_325_HALF: 3.25, OLD_325_HALF: 3.25,
    NEW_4: 4, OLD_4: 4, NEW_4_HALF: 4, OLD_4_HALF: 4,
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

  /** wrap `while (cond)` so runaway loops can be stopped: while (__guard(), (cond)) */
  function guardWhileLoops(s) {
    let out = '';
    let i = 0;
    const re = /\bwhile\s*\(/g;
    let m;
    while ((m = re.exec(s))) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(s, open);
      if (close < 0) break;
      out += s.slice(i, open + 1) + '__guard(), (' + s.slice(open + 1, close) + ')';
      i = close;
      re.lastIndex = close;
    }
    return out + s.slice(i);
  }

  function translateBody(body, chassisNames) {
    let s = body;
    s = s.replace(/->/g, '.');
    // enums first, then drop namespaces
    s = s.replace(/\b(?:\w+::)*(?:DriveSide|AngularDirection)::(\w+)/g, '"$1"');
    s = s.replace(/\b(?:lemlib|pros|std|okapi|vex)::(?:c::)?/g, '');
    s = s.replace(/\b[A-Za-z_]\w*::([A-Za-z_]\w*)/g, '$1');
    // designated initialisers: {.a = 1, .b = 2}
    s = s.replace(/([{,]\s*)\.([A-Za-z_]\w*)\s*=(?!=)/g, '$1$2:');
    // C++-only syntax
    s = s.replace(/\b(?:static|reinterpret|const|dynamic)_cast\s*<[^>]*>/g, '');
    s = s.replace(/\(\s*(?:unsigned\s+)?(?:int|float|double|bool|long|short|size_t)\s*\)/g, '');
    s = s.replace(/\b(\d+\.?\d*|\.\d+)[fF]\b/g, '$1');
    s = s.replace(/\b(\d+)[uUlL]+\b/g, '$1');
    s = s.replace(/\bnullptr\b|\bNULL\b/g, 'null');

    // declarations
    const declNum = new RegExp('(^|[;{}(\\s])' + NUM_TYPES + '\\s*[&*]*\\s+([A-Za-z_]\\w*)(?=\\s*(?:=(?!=)|;|,|\\[))', 'g');
    s = s.replace(declNum, '$1let $2');
    s = s.replace(/\blet\s+(\w+)\s*\[[^\]]*\]\s*=\s*\{([^}]*)\}/g, 'let $1 = [$2]');
    // `Pose p(1, 2, 3);`  and  `Foo bar(args);`
    s = s.replace(/(^|[;{}\n])(\s*)([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^()]*)\)\s*;/g, (all, pre, ws, type, name, args) => {
      if (KEYWORDS.has(type)) return all;
      if (type === 'Pose') return `${pre}${ws}let ${name} = Pose(${args});`;
      return `${pre}${ws}let ${name} = NOOP;`;
    });
    // `Foo bar = expr;`  and  `Foo bar;`
    s = s.replace(/(^|[;{}\n])(\s*)([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(=(?!=)|;)/g, (all, pre, ws, type, name, tail) => {
      if (KEYWORDS.has(type)) return all;
      return `${pre}${ws}let ${name} ${tail === ';' ? '= NOOP;' : '='}`;
    });

    s = guardWhileLoops(s);

    // blocking behaviour: every chassis call / delay must be awaited
    const names = chassisNames.join('|');
    s = s.replace(new RegExp('\\b(' + names + ')\\.([A-Za-z_]\\w*)\\s*\\(', 'g'), 'await $1.$2(');
    s = s.replace(/(^|[^.\w])delay\s*\(/g, '$1await delay(');
    s = s.replace(/\bawait\s+await\b/g, 'await');
    return s;
  }

  /**
   * @param {string} source  full C++ file (or just a function body) / or JS
   * @param {{language:'cpp'|'js', routine?:string}} opts
   * @returns {{js:string, routines:string[], routine:string, config:object, warnings:string[]}}
   */
  function compile(source, opts) {
    opts = opts || {};
    const warnings = [];
    if (opts.language === 'js') {
      return { js: source, routines: [], routine: '', config: { assets: [], chassisName: 'chassis' }, warnings };
    }
    const clean = stripComments(source).replace(/^\s*#.*$/gm, '');
    const funcs = findFunctions(clean);

    // everything outside the functions is "globals"
    let globals = clean;
    for (let i = funcs.length - 1; i >= 0; i--) globals = globals.slice(0, funcs[i].start) + globals.slice(funcs[i].end);
    const config = extractConfig(globals);

    let body;
    let routine = '';
    const routines = funcs.filter((f) => f.params === '' || f.params === 'void').map((f) => f.name);
    if (funcs.length) {
      let pick = opts.routine && funcs.find((f) => f.name === opts.routine);
      if (!pick) pick = funcs.find((f) => f.name === 'autonomous') || funcs.find((f) => routines.includes(f.name)) || funcs[0];
      body = pick.body;
      routine = pick.name;
      // helper functions with arguments are not supported
      funcs
        .filter((f) => f !== pick && f.name !== 'initialize' && f.name !== 'main')
        .forEach((f) => {
          if (new RegExp('\\b' + f.name + '\\s*\\(').test(body)) {
            warnings.push(`"${f.name}()" is called from ${pick.name}() but helper functions are not supported; the call will be ignored.`);
          }
        });
    } else {
      body = clean; // a bare list of statements
    }

    // simple top-level constants
    let prelude = '';
    const reConst = new RegExp('(?:^|[;}\\n])\\s*' + NUM_TYPES + '\\s+([A-Za-z_]\\w*)\\s*=\\s*([^;(){}]+);', 'g');
    let m;
    while ((m = reConst.exec(globals))) prelude += `let ${m[1]} = ${m[2].replace(/\b(\d+\.?\d*|\.\d+)[fF]\b/g, '$1')};\n`;

    const names = Array.from(new Set(['chassis', config.chassisName]));
    const js = prelude + translateBody(body, names);
    return { js, routines, routine, config, warnings };
  }

  Object.assign(NS, { compileAuton: compile, stripComments, splitTopLevel });
})();
