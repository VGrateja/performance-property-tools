/* ============================================================================
 * Performance Property — theme manager.
 *
 * Loaded via <script src="../shared/theme.js"></script> in the <head> of every
 * page. MUST run before stylesheets paint to avoid a flash of the wrong theme,
 * so it's a synchronous IIFE — no DOMContentLoaded wait.
 *
 * Reads localStorage key "pp-theme" (values: "dark" | "light"; default "dark")
 * and applies a data-theme="light" attribute to <html> when light is active.
 *
 * Public API:
 *   window.PP_setTheme(t)    — explicitly set "dark" or "light"
 *   window.PP_toggleTheme()  — flip between dark and light
 *   window.PP_getTheme()     — returns the current theme string
 *
 * Also dispatches a `pp-theme-change` CustomEvent on `document` so any tool
 * that needs to react (e.g. swap an ECharts theme) can subscribe.
 * ============================================================================ */
(function(){
  var KEY = 'pp-theme';
  var FALLBACK_MS = 750;
  var fallbackTimer = null;

  /* Track the most recent pointer position so the View Transition
     reveal expands from where the user clicked the toggle button.
     Falls back to the top-right corner (where most theme toggles
     live) if no pointer event has fired yet. Capture phase + passive
     so it never interferes with normal click handling. */
  var lastX = window.innerWidth - 50;
  var lastY = 40;
  document.addEventListener('pointerdown', function(e){
    lastX = e.clientX;
    lastY = e.clientY;
  }, { capture: true, passive: true });

  function applyTheme(t){
    if (t === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function getTheme(){
    try { return localStorage.getItem(KEY) || 'dark'; }
    catch (_) { return 'dark'; }
  }

  function reduceMotion(){
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (_) { return false; }
  }

  /* Two animation paths:

     1) View Transitions API (Chrome 111+, Safari 18+) — captures the
        current screen, applies the theme, then animates the new view
        in via a CSS-driven circular clip-path expanding from the
        last pointer position. CSS keyframes live in common.css /
        each tool's inline <style>. We pre-set --ppt-x/--ppt-y/--ppt-r
        so the keyframes know where to grow from.

     2) Fallback for older browsers + reduced-motion users — the
        `pp-theme-transitioning` class is added to <html> for ~350ms
        and CSS gives every element a soft cross-property transition
        so the swap eases in instead of snapping. */
  function setTheme(t){
    var next = (t === 'light') ? 'light' : 'dark';
    var html = document.documentElement;
    var current = getTheme();
    var changed = next !== current;

    try { localStorage.setItem(KEY, next); } catch (_) {}

    if (!changed) {
      applyTheme(next);
      return;
    }

    // Compute the max distance from the click point to any viewport
    // corner — the reveal circle has to grow at least this far to
    // cover everything.
    var maxR = Math.hypot(
      Math.max(lastX, window.innerWidth  - lastX),
      Math.max(lastY, window.innerHeight - lastY)
    );
    html.style.setProperty('--ppt-x', lastX + 'px');
    html.style.setProperty('--ppt-y', lastY + 'px');
    html.style.setProperty('--ppt-r', maxR + 'px');

    if (document.startViewTransition && !reduceMotion()) {
      // Modern path — circular reveal via View Transitions.
      document.startViewTransition(function(){
        applyTheme(next);
      });
    } else {
      // Fallback — simple cross-fade.
      html.classList.add('pp-theme-transitioning');
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(function(){
        html.classList.remove('pp-theme-transitioning');
        fallbackTimer = null;
      }, FALLBACK_MS);
      applyTheme(next);
    }

    try {
      document.dispatchEvent(new CustomEvent('pp-theme-change', { detail: { theme: next } }));
    } catch (_) {}
  }

  function toggle(){
    setTheme(getTheme() === 'light' ? 'dark' : 'light');
  }

  // Apply immediately so the first paint matches the saved preference.
  applyTheme(getTheme());

  window.PP_setTheme = setTheme;
  window.PP_toggleTheme = toggle;
  window.PP_getTheme = getTheme;
})();
