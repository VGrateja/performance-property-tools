/* ============================================================================
 * Performance OS — shared chrome (os-chrome.js)
 *
 * Owns everything the desktop and every reskinned tool page share:
 *   • data-mode (light|dark) — persisted in localStorage 'ppos-mode'
 *   • data-period (day|night) + data-shade (light|dark) — fixed Day/Night,
 *     set once at boot + on toggle (auto/time-of-day retired 2026-07-15)
 *   • LEGACY BRIDGE — while the rollout is in progress, also mirrors the shade
 *     into the old theme system (data-theme attribute + localStorage 'pp-theme'
 *     + the 'pp-theme-change' event) so not-yet-reskinned pages and existing
 *     [data-theme="light"] CSS + ECharts listeners stay in sync.
 *   • The app bar (← Desktop · icon · name · section chip · actions · mode · clock)
 *   • PP_OS.exportFlat(fn) — html2canvas-safe capture wrapper (.export-flat)
 *
 * Load AFTER os-theme.css, BEFORE tool scripts, on every reskinned page:
 *   <link rel="stylesheet" href="../shared/os-theme.css">
 *   <script src="../shared/os-chrome.js"></script>
 *   <script> PP_OS.initChrome({ name:'Demand Score Dashboard', section:'analytics' }); </script>
 *
 * Reskinned pages must NOT also load shared/theme.js (one theme writer only).
 * Pure DOM — no Supabase/auth dependency; safe on the login screen too.
 * ========================================================================== */
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;

  /* ── section registry (accents + glyphs, from the approved mockups) ─────── */
  var GLYPH = {
    pulse:  '<svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
    lock:   '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>',
    check:  '<svg viewBox="0 0 24 24"><path d="M4 6h9M4 12h9M4 18h9"/><path d="M16 6l2 2 4-4"/><path d="M16 17l2 2 4-4"/></svg>',
    game:   '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="10" rx="5"/><path d="M8 12v2M7 13h2M16.5 12.2v.1M14.8 13.8v.1"/></svg>',
    book:   '<svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 19a2 2 0 012-2h13"/></svg>',
    present:'<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v3M8 21h8"/><path d="M7 12l3-3 2 2 4-4"/></svg>',
    people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.4"/><path d="M16 15c2.6.2 5 1.9 5 4.5"/></svg>',
    plus:   '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>'
  };
  /* Section accents = the Brand Guidelines accent palette (p14) with gradient
     ends taken from each accent's official tone ramp (p15) — every value below
     is a sanctioned brand tone. PM wears Eucalyptus (the Asset Management
     sub-brand pairing, p27). Snapped from the old near-miss hues 2026-07-15. */
  var SECTIONS = {
    analytics: { name: 'Analytics Hub',       a1: '#ED5A75', a2: '#CA1637', glyph: 'pulse'   }, /* Red */
    vault:     { name: 'The Vault',           a1: '#7E8CF1', a2: '#233AE7', glyph: 'lock'    }, /* Cobalt Blue */
    pm:        { name: 'Property Management', a1: '#5DAC96', a2: '#3E7967', glyph: 'check'   }, /* Eucalyptus */
    arena:     { name: 'Performance Arena',   a1: '#D373D3', a2: '#AB36AB', glyph: 'game'    }, /* Purple */
    docs:      { name: 'Documents & Reports', a1: '#FFB947', a2: '#E08A00', glyph: 'book'    }, /* Yellow */
    present:   { name: 'Presentations',       a1: '#54A6DE', a2: '#2478BC', glyph: 'present' }, /* Celestial Blue */
    people:    { name: 'People & Culture',    a1: '#47DAFF', a2: '#00A3CC', glyph: 'people'  }  /* Bright Blue */
  };

  /* ── mode / period / shade (identical rules to the desktop mockup) ──────── */
  var MODES = ['light', 'dark'];
  var MODE_ICO = {
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    dark:  '<path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/>'
  };
  /* Fixed Day/Night only (auto / time-of-day retired 2026-07-15). First visit
     follows the OS preference; after that the user's explicit choice sticks. */
  function getMode() {
    try { var m = localStorage.getItem('ppos-mode'); if (m === 'light' || m === 'dark') return m; } catch (e) {}
    try { if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'; } catch (e) {}
    return 'light';
  }
  function syncModeIcon() { var ico = doc.getElementById('pposModeIco'); if (ico) ico.innerHTML = MODE_ICO[root.dataset.mode] || MODE_ICO.light; }
  function applyPeriod() {
    var shade = (root.dataset.mode === 'dark') ? 'dark' : 'light';
    var p = shade === 'dark' ? 'night' : 'day';
    var changed = root.dataset.shade !== shade;
    root.dataset.period = p;
    root.dataset.shade = shade;
    /* LEGACY BRIDGE — dark = NO data-theme attribute; light = data-theme="light". */
    if (shade === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    try { localStorage.setItem('pp-theme', shade); } catch (e) {}
    if (changed) {
      try { doc.dispatchEvent(new CustomEvent('pp-theme-change', { detail: { theme: shade } })); } catch (e) {}
      try { doc.dispatchEvent(new CustomEvent('ppos-shade-change', { detail: { shade: shade, period: p } })); } catch (e) {}
    }
  }
  /* ── Day/Night switch animation (ported from legacy theme.js 2026-07-15) ──
     Primary: View Transitions API — a circular reveal expanding from the last
     pointer position (CSS keyframes pp-theme-circle-reveal in os-theme.css /
     common.css, driven by --ppt-x/--ppt-y/--ppt-r). The page is frozen into two
     snapshots for ~0.9s, so the glass isn't live-re-blurring during the sweep.
     Fallback: the pp-theme-transitioning class (~750ms soft cross-fade).
     PERF GUARDS: skipped entirely under prefers-reduced-motion, lite mode
     (pp-lite) and calm mode (pp-perf-hidden) — weak machines switch instantly.
     window.__pposThemeSwitchAt lets the hub's FPS watchdog ignore samples that
     overlap a toggle, so the one-shot animation can never trip auto-lite. */
  var lastX = window.innerWidth - 50, lastY = 40, _themeFallbackT = null;
  doc.addEventListener('pointerdown', function (e) { lastX = e.clientX; lastY = e.clientY; }, { capture: true, passive: true });
  function setMode(m) {
    if (MODES.indexOf(m) < 0) m = 'light';
    var apply = function () {
      root.dataset.mode = m;
      try { localStorage.setItem('ppos-mode', m); } catch (e) {}
      syncModeIcon();
      applyPeriod();
    };
    var changed = root.dataset.mode !== m;
    var reduce = false; try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    var perfOff = root.classList.contains('pp-lite') || root.classList.contains('pp-perf-hidden');
    if (!changed || reduce || perfOff) { apply(); return; }
    window.__pposThemeSwitchAt = Date.now();
    var maxR = Math.hypot(Math.max(lastX, window.innerWidth - lastX), Math.max(lastY, window.innerHeight - lastY));
    root.style.setProperty('--ppt-x', lastX + 'px');
    root.style.setProperty('--ppt-y', lastY + 'px');
    root.style.setProperty('--ppt-r', maxR + 'px');
    if (document.startViewTransition) {
      document.startViewTransition(apply);
    } else {
      root.classList.add('pp-theme-transitioning');
      if (_themeFallbackT) clearTimeout(_themeFallbackT);
      _themeFallbackT = setTimeout(function () { root.classList.remove('pp-theme-transitioning'); _themeFallbackT = null; }, 750);
      apply();
    }
  }
  function cycleMode() { setMode(root.dataset.mode === 'dark' ? 'light' : 'dark'); }

  /* Apply immediately (script loads early — first paint must wear the right
     shade). No time-of-day polling anymore. */
  root.dataset.mode = getMode();
  applyPeriod();
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', syncModeIcon); else syncModeIcon();

  /* ── app bar ────────────────────────────────────────────────────────────── */
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  /* initChrome(cfg)
     cfg.name     tool display name (required)
     cfg.section  key of SECTIONS (required) — sets accents + chip + glyph
     cfg.glyph    override glyph key or raw '<svg…>' markup
     cfg.a1/a2    override accents
     cfg.backHref default '../index.html'
     cfg.backLabel default 'Desktop'
     cfg.actions  [{id, label, svg, primary, title, onClick}] — optional buttons
     cfg.wall     inject the scrimmed wallpaper div (default true)
     cfg.clock    show the live clock (default true)
     Returns { el, setStatus } for later tweaks. */
  function initChrome(cfg) {
    cfg = cfg || {};
    var sec = SECTIONS[cfg.section] || { name: cfg.section || '', a1: '#7E8CF1', a2: '#233AE7', glyph: 'pulse' };
    var a1 = cfg.a1 || sec.a1, a2 = cfg.a2 || sec.a2;
    var glyph = cfg.glyph ? (GLYPH[cfg.glyph] || cfg.glyph) : GLYPH[sec.glyph];
    doc.body.style.setProperty('--a1', a1);
    doc.body.style.setProperty('--a2', a2);

    if (cfg.wall !== false && !doc.querySelector('.wall')) {
      var wall = doc.createElement('div'); wall.className = 'wall scrim';
      doc.body.insertBefore(wall, doc.body.firstChild);
    }

    var bar = doc.createElement('header');
    bar.className = 'appbar';
    var actions = (cfg.actions || []).map(function (a) {
      return '<button class="ab-btn' + (a.primary ? ' primary' : '') + '"' +
        (a.id ? ' id="' + esc(a.id) + '"' : '') + (a.title ? ' title="' + esc(a.title) + '"' : '') + '>' +
        (a.svg || '') + (a.label ? '<span>' + esc(a.label) + '</span>' : '') + '</button>';
    }).join('');
    bar.innerHTML =
      '<a class="ab-back" href="' + esc(cfg.backHref || '../index.html') + '"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>' + esc(cfg.backLabel || 'Desktop') + '</a>' +
      '<div class="ab-id">' +
        '<span class="ab-icon">' + glyph + '</span>' +
        '<span class="nm">' + esc(cfg.name || doc.title) + '</span>' +
        (sec.name ? '<span class="sec">' + esc(sec.name) + '</span>' : '') +
      '</div>' +
      '<div class="ab-sp"></div>' +
      '<div class="ab-r">' + actions +
        '<button class="ab-ic" id="pposModeBtn" title="Appearance (day / night)"><svg id="pposModeIco" viewBox="0 0 24 24">' + (MODE_ICO[root.dataset.mode] || MODE_ICO.light) + '</svg></button>' +
        (cfg.clock !== false ? '<span class="ab-clock" id="pposClock">—</span>' : '') +
      '</div>';
    /* insert after the wallpaper so the bar is the first visible element.
       Guard: the wall may sit NESTED in a page wrapper (some tools' old nav
       lived deep in the DOM) — insertBefore against <body> then throws and
       the bar never renders. Only anchor to the wall when it is a direct
       body child; otherwise prepend to <body>. */
    var anchor = doc.querySelector('.wall');
    if (anchor && anchor.parentNode === doc.body) {
      doc.body.insertBefore(bar, anchor.nextSibling);
    } else {
      doc.body.insertBefore(bar, doc.body.firstChild);
    }

    bar.querySelector('#pposModeBtn').addEventListener('click', cycleMode);
    (cfg.actions || []).forEach(function (a) {
      if (a.id && typeof a.onClick === 'function') {
        var btn = bar.querySelector('#' + a.id);
        if (btn) btn.addEventListener('click', a.onClick);
      }
    });
    if (cfg.clock !== false) {
      var tick = function () {
        var el = doc.getElementById('pposClock');
        if (el) el.textContent = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
      };
      tick(); setInterval(tick, 30000);
    }
    return { el: bar };
  }

  /* ── export-safe capture wrapper ────────────────────────────────────────── */
  /* html2canvas cannot render backdrop-filter — flatten, capture, restore.
     Usage: await PP_OS.exportFlat(async () => { …html2canvas/jsPDF work… }); */
  function exportFlat(fn) {
    root.classList.add('export-flat');
    return new Promise(function (resolve, reject) {
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        setTimeout(function () {
          Promise.resolve().then(fn).then(
            function (v) { root.classList.remove('export-flat'); resolve(v); },
            function (e) { root.classList.remove('export-flat'); reject(e); }
          );
        }, 60);
      }); });
    });
  }

  window.PP_OS = {
    initChrome: initChrome,
    exportFlat: exportFlat,
    setMode: setMode,
    cycleMode: cycleMode,
    applyPeriod: applyPeriod,
    getShade: function () { return root.dataset.shade || 'dark'; },
    getPeriod: function () { return root.dataset.period || 'night'; },
    SECTIONS: SECTIONS,
    GLYPH: GLYPH
  };
})();
