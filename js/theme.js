/* Theme: Auto (follow the OS) / Light / Dark. Sets <html data-theme> and lets canvas code read the CSS tokens. */
(function () {
  'use strict';
  const NS = (globalThis.VSim = globalThis.VSim || {});
  const KEY = 'vexAutonSim.theme';
  const MODES = ['auto', 'light', 'dark'];
  const LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  const root = document.documentElement;

  let mode = 'auto';
  try {
    const saved = localStorage.getItem(KEY);
    if (MODES.includes(saved)) mode = saved;
  } catch (e) { /* storage blocked: stay on Auto */ }

  let version = 0;
  const cache = new Map();

  function apply() {
    if (mode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    cache.clear();
    version++;
    window.dispatchEvent(new Event('vsim-theme'));
  }

  function set(next) {
    if (!MODES.includes(next)) return;
    mode = next;
    try { localStorage.setItem(KEY, mode); } catch (e) { /* ignore */ }
    apply();
    refreshButton();
  }

  /** value of a CSS token, e.g. color('ov-guide') reads --ov-guide */
  function color(name) {
    if (!cache.has(name)) cache.set(name, getComputedStyle(root).getPropertyValue('--' + name).trim());
    return cache.get(name);
  }

  function refreshButton() {
    const b = document.getElementById('btnTheme');
    if (b) b.textContent = 'Theme: ' + LABEL[mode];
  }

  NS.theme = {
    get mode() { return mode; },
    get version() { return version; },
    set,
    color,
    series: (i) => color('series-' + ((((i % 6) + 6) % 6) + 1)),
  };

  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (mode === 'auto') apply(); });

  apply();
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('btnTheme');
    if (!b) return;
    refreshButton();
    b.addEventListener('click', () => set(MODES[(MODES.indexOf(mode) + 1) % MODES.length]));
  });
})();
