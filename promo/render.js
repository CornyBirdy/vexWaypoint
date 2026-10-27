#!/usr/bin/env node
/* Waypoint reveal: frame renderer.
 *
 *   node promo/render.js <shot|all> [--out DIR] [--fps 60] [--stills 1.2,3.4] [--jobs 3]
 *
 * Serves the repo, opens promo/stage.html in Chromium, and steps the real app one video frame at a time
 * (virtual clock, real mouse events). Writes DIR/<global frame number>.png. With --stills only those
 * times are written (every earlier frame is still stepped so the app is in the right state).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 ? args[i + 1] : d;
};
const which = args[0] && !args[0].startsWith('--') ? args[0] : 'all';
const OUT = path.resolve(flag('out', path.join(__dirname, 'out', 'frames')));
const stills = flag('stills', '') ? flag('stills', '').split(',').map(Number) : null;
const jobs = parseInt(flag('jobs', '3'), 10);
const probe = flag('probe', '');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.ttf': 'font/ttf', '.txt': 'text/plain' };
function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
        rsp.writeHead(404);
        return rsp.end();
      }
      rsp.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(p).pipe(rsp);
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

async function renderShot(id) {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text', '--hide-scrollbars'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'no-preference' });
  await ctx.addInitScript({ path: path.join(__dirname, 'inject.js') });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${id}] page error:`, e.message));
  page.on('console', (m) => m.type() === 'error' && console.error(`[${id}] console:`, m.text()));
  await page.goto(`${base}/promo/stage.html`);
  const { fps, t0, t1 } = await page.evaluate((s) => window.stage.ready(s), id);
  fs.mkdirSync(OUT, { recursive: true });

  const f0 = Math.ceil(t0 * fps - 1e-6);
  const f1 = Math.ceil(t1 * fps - 1e-6);
  const want = stills ? new Set(stills.map((t) => Math.round(t * fps))) : null;
  let down = false;
  const started = Date.now();
  for (let f = f0; f < f1; f++) {
    const t = f / fps;
    const m = await page.evaluate((tt) => window.stage.prepare(tt), t);
    if (m.show) {
      await page.mouse.move(m.x, m.y);
      if (m.down && !down) await page.mouse.down();
      if (!m.down && down) await page.mouse.up();
      down = m.down;
    } else if (down) {
      await page.mouse.up();
      down = false;
    }
    await page.evaluate((tt) => window.stage.finish(tt), t);
    if (probe && (f - f0) % 6 === 0) console.log(((f - f0) / fps).toFixed(2), await page.evaluate(probe));
    if (!want || want.has(f)) {
      await page.screenshot({ path: path.join(OUT, `${String(f).padStart(5, '0')}.png`), type: 'png' });
    }
    if (!stills && (f - f0) % 60 === 0) console.log(`[${id}] frame ${f - f0}/${f1 - f0}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  await browser.close();
  srv.close();
  console.log(`[${id}] done ${f1 - f0} frames in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

async function main() {
  const shotsSrc = fs.readFileSync(path.join(__dirname, 'shots.js'), 'utf8');
  const window = {};
  new Function('window', shotsSrc)(window);
  const all = window.PROMO.SHOTS.map((s) => s.id);
  if (which !== 'all') return renderShot(which);
  // one child process per shot, `jobs` at a time
  const queue = all.slice();
  const run = () =>
    new Promise((res) => {
      const next = () => {
        const id = queue.shift();
        if (!id) return res();
        const extra = ['--out', OUT];
        const p = spawn(process.execPath, [__filename, id, ...extra], { stdio: 'inherit' });
        p.on('exit', (code) => {
          if (code) process.exitCode = code;
          next();
        });
      };
      next();
    });
  await Promise.all(Array.from({ length: jobs }, run));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
