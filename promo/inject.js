/* Runs in every frame before the page's own scripts (Playwright addInitScript).
 * In the embedded Waypoint app it swaps the browser clock for a virtual one, so the render rig can
 * advance the real app one video frame at a time and get identical output on every run. */
(function () {
  'use strict';
  if (window.top === window) return;

  // draw the field canvas at 2x so camera push-ins stay sharp
  Object.defineProperty(window, 'devicePixelRatio', { get: () => 2 });

  let id = 0;
  let rafQ = [];
  window.requestAnimationFrame = (cb) => {
    rafQ.push({ id: ++id, cb });
    return id;
  };
  window.cancelAnimationFrame = (n) => {
    rafQ = rafQ.filter((r) => r.id !== n);
  };

  // timers of 50 ms or more (the 220 ms re-run debounce) follow the virtual clock; short ones stay real
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  let timers = [];
  let now = 0;
  window.setTimeout = (fn, ms, ...args) => {
    if ((ms || 0) < 50) return realSetTimeout(fn, ms, ...args);
    const t = { id: ++id, due: now + ms, fn: () => fn(...args), virtual: true };
    timers.push(t);
    return t.id;
  };
  window.clearTimeout = (n) => {
    const before = timers.length;
    timers = timers.filter((t) => t.id !== n);
    if (timers.length === before) realClearTimeout(n);
  };

  /** advance the virtual clock to `ms` and run what is due */
  window.__advance = (ms) => {
    now = ms;
    const due = timers.filter((t) => t.due <= now).sort((a, b) => a.due - b.due);
    timers = timers.filter((t) => t.due > now);
    due.forEach((t) => t.fn());
    // two passes so a draw requested during a frame is painted in the same video frame
    for (let pass = 0; pass < 2; pass++) {
      const q = rafQ;
      rafQ = [];
      q.forEach((r) => r.cb(now));
    }
  };

  // no scrollbars, no native smooth scrolling, no focus-ring flicker from the headless shell
  const style = document.createElement('style');
  style.textContent = `
    html { scrollbar-width: none; scroll-behavior: auto !important; }
    ::-webkit-scrollbar { display: none; }
    * { caret-color: var(--accent); }
  `;
  document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
})();
