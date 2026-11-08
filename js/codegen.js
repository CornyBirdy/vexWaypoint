/*
 * Code generation: the LemLib lines that go with an exported path.
 *
 * The path preview runs the very code generated here, so what you watch in the sim is what
 * you paste into your robot project.
 */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});

  const num = (n) => {
    const r = Math.round(n * 10) / 10;
    return Object.is(r, -0) ? '0' : String(r);
  };

  /** the `ASSET(...)` line for a path file (static/Name.txt -> Name_txt) */
  function assetLine(assetId, fileName) {
    return `ASSET(${assetId})` + (fileName ? ` // static/${fileName}` : '');
  }

  /** `chassis.follow(...)` for one path; `forwards` is only written when it is false */
  function followCall(assetId, o) {
    o = o || {};
    const args = [assetId, num(o.lookahead == null ? 15 : o.lookahead), String(Math.round(o.timeout == null ? 4000 : o.timeout))];
    if (o.backwards) args.push('false');
    return `chassis.follow(${args.join(', ')});`;
  }

  function setPoseCall(pose) {
    return `chassis.setPose(${num(pose.x)}, ${num(pose.y)}, ${num(pose.h)});`;
  }

  /**
   * A complete autonomous() for one path: set the pose the path starts from, follow it.
   * @param {{x:number,y:number,h:number}} pose  field pose the robot starts at
   */
  function autonomous(pose, assetId, fileName, o) {
    return [
      assetLine(assetId, fileName),
      '',
      'void autonomous() {',
      '    ' + setPoseCall(pose),
      '    ' + followCall(assetId, o),
      '    chassis.waitUntilDone();',
      '}',
      '',
    ].join('\n');
  }

  /** `source` with comments and string contents blanked out (same length), for scanning braces */
  function blank(source) {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
      .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => '"' + ' '.repeat(m.length - 2) + '"');
  }

  /** index of the `}` that closes the `{` at `open` (in blanked text), or -1 */
  function matchBrace(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) return i;
    }
    return -1;
  }

  /**
   * Add a path to the user's code without disturbing the rest:
   *  - `ASSET(id)` goes after the last #include (or ASSET) unless it is already there
   *  - the follow call goes at the end of autonomous() (a new autonomous() is added if there is none)
   *  - a setPose is added at the top of autonomous() only when the code never calls setPose
   * @returns {{code:string, notes:string[]}}
   */
  function insertIntoCode(code, o) {
    const notes = [];
    let out = String(code || '');
    const clean = () => blank(out);

    if (o.language === 'js') {
      const lines = [];
      if (!/\bsetPose\s*\(/.test(clean()) && o.pose) {
        lines.push('await ' + setPoseCall(o.pose));
        notes.push('added setPose');
      }
      lines.push('await ' + followCall(o.assetId, o), 'await chassis.waitUntilDone();');
      out = out.replace(/\s*$/, '') + (out.trim() ? '\n' : '') + lines.join('\n') + '\n';
      notes.push('added the follow call at the end');
      return { code: out, notes };
    }

    // 1. ASSET line
    const reAsset = new RegExp('\\bASSET\\s*\\(\\s*' + o.assetId + '\\s*\\)');
    if (!reAsset.test(clean())) {
      const line = assetLine(o.assetId, o.fileName);
      const c = clean();
      let at = 0;
      let kind = '';
      const re = /^[ \t]*(#[ \t]*include[^\n]*|ASSET\s*\([^\n]*)$/gm;
      let m;
      while ((m = re.exec(c))) {
        at = m.index + m[0].length;
        kind = m[1][0] === '#' ? 'include' : 'asset';
      }
      out = at ? out.slice(0, at) + (kind === 'asset' ? '\n' : '\n\n') + line + out.slice(at) : line + '\n\n' + out;
      notes.push(`added ${line.split(' //')[0]}`);
    }

    // 2. the call inside autonomous()
    const c = clean();
    const fn = /\bvoid\s+autonomous\s*\(\s*(?:void)?\s*\)\s*\{/.exec(c);
    const withPose = !/\bsetPose\s*\(/.test(c) && o.pose;
    const call = '    ' + followCall(o.assetId, o) + '\n    chassis.waitUntilDone();';
    if (!fn) {
      out = out.replace(/\s*$/, '') + '\n\nvoid autonomous() {\n' + (o.pose ? '    ' + setPoseCall(o.pose) + '\n' : '') + call + '\n}\n';
      notes.push('added autonomous()');
      return { code: out, notes };
    }
    const open = fn.index + fn[0].length - 1;
    const close = matchBrace(c, open);
    if (close < 0) {
      notes.push('could not find the end of autonomous(), appended the call at the end of the file');
      out = out.replace(/\s*$/, '') + '\n' + call + '\n';
      return { code: out, notes };
    }
    if (withPose) {
      out = out.slice(0, open + 1) + '\n    ' + setPoseCall(o.pose) + out.slice(open + 1);
      notes.push('added setPose at the start');
    }
    const c2 = blank(out);
    const fn2 = /\bvoid\s+autonomous\s*\(\s*(?:void)?\s*\)\s*\{/.exec(c2);
    const close2 = matchBrace(c2, fn2.index + fn2[0].length - 1);
    const before = out.slice(0, close2).replace(/[ \t]*$/, '');
    out = before + (before.endsWith('\n') ? '' : '\n') + call + '\n' + out.slice(close2);
    notes.push('added the follow call at the end of autonomous()');
    return { code: out, notes };
  }

  /** a file name that survives PROS's ASSET() mangling: letters, digits and _ only, plus the extension */
  function safeFileName(id, ext) {
    return id + (ext || '.txt');
  }

  Object.assign(NS, { CodeGen: { assetLine, followCall, setPoseCall, autonomous, insertIntoCode, safeFileName, num } });
})();
