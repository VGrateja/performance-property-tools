/* ============================================================================
 * Performance OS — shared chrome (os-chrome.js)
 *
 * Owns everything the desktop and every reskinned tool page share:
 *   • data-mode (auto|light|dark) — persisted in localStorage 'ppos-mode'
 *   • data-period (dawn|day|dusk|night) + data-shade (light|dark), re-checked
 *     every minute (logic identical to the pp-os.html desktop)
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
  var SECTIONS = {
    analytics: { name: 'Analytics Hub',       a1: '#FF8E63', a2: '#FF4D6D', glyph: 'pulse'   },
    vault:     { name: 'The Vault',           a1: '#8E7BFF', a2: '#5B3DF5', glyph: 'lock'    },
    pm:        { name: 'Property Management', a1: '#3EDC97', a2: '#0FA36B', glyph: 'check'   },
    arena:     { name: 'Performance Arena',   a1: '#FF7AC3', a2: '#D6338F', glyph: 'game'    },
    docs:      { name: 'Documents & Reports', a1: '#FFC24D', a2: '#F58A1F', glyph: 'book'    },
    present:   { name: 'Presentations',       a1: '#5AC8FF', a2: '#2A7FE8', glyph: 'present' },
    people:    { name: 'People & Culture',    a1: '#D68CFF', a2: '#9B4DE0', glyph: 'people'  }
  };

  /* ── mode / period / shade (identical rules to the desktop mockup) ──────── */
  var MODES = ['auto', 'light', 'dark'];
  var MODE_ICO = {
    auto:  '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M4.5 12H3M21 12h-1.5M6 6l1 1M17 17l1 1"/>',
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    dark:  '<path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/>'
  };
  function periodFor(h) { return h >= 5 && h < 9 ? 'dawn' : h >= 9 && h < 17 ? 'day' : h >= 17 && h < 20 ? 'dusk' : 'night'; }
  function getMode() {
    try { var m = localStorage.getItem('ppos-mode'); if (MODES.indexOf(m) > -1) return m; } catch (e) {}
    return 'auto';
  }
  function applyPeriod() {
    var mode = root.dataset.mode || getMode();
    var p = mode === 'light' ? 'day' : mode === 'dark' ? 'night' : periodFor(new Date().getHours());
    root.dataset.period = p;
    var shade = (p === 'day' || p === 'dawn') ? 'light' : 'dark';
    var changed = root.dataset.shade !== shade;
    root.dataset.shade = shade;
    /* LEGACY BRIDGE — keep the old theme system in lockstep during rollout.
       Old convention: dark = NO data-theme attribute; light = data-theme="light". */
    if (shade === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    try { localStorage.setItem('pp-theme', shade); } catch (e) {}
    if (changed) {
      try { doc.dispatchEvent(new CustomEvent('pp-theme-change', { detail: { theme: shade } })); } catch (e) {}
      try { doc.dispatchEvent(new CustomEvent('ppos-shade-change', { detail: { shade: shade, period: p } })); } catch (e) {}
    }
  }
  function setMode(m) {
    if (MODES.indexOf(m) < 0) m = 'auto';
    root.dataset.mode = m;
    try { localStorage.setItem('ppos-mode', m); } catch (e) {}
    var ico = doc.getElementById('pposModeIco');
    if (ico) ico.innerHTML = MODE_ICO[m];
    applyPeriod();
  }
  function cycleMode() { setMode(MODES[(MODES.indexOf(root.dataset.mode || 'auto') + 1) % MODES.length]); }

  /* Apply immediately (script loads in <head> or early <body> — first paint
     must already wear the right shade, same contract as the old theme.js). */
  root.dataset.mode = getMode();
  applyPeriod();
  setInterval(applyPeriod, 60000);

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
    var sec = SECTIONS[cfg.section] || { name: cfg.section || '', a1: '#8E7BFF', a2: '#5B3DF5', glyph: 'pulse' };
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
        '<button class="ab-ic" id="pposModeBtn" title="Appearance (auto / light / dark)"><svg id="pposModeIco" viewBox="0 0 24 24">' + MODE_ICO[root.dataset.mode || 'auto'] + '</svg></button>' +
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
