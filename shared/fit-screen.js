/* ───────────────────────────────────────────────────────────────────────────
   shared/fit-screen.js — Auto-fit

   Scales the page DOWN to fit the viewport WIDTH, so a tool designed for a
   larger display still fits a smaller laptop without the user manually zooming
   the browser out. It only ever scales DOWN (never enlarges), and re-applies on
   resize and after late content loads. Uses CSS `zoom` — the same mechanism the
   browser's own zoom uses — so click/drag coordinates stay consistent (unlike
   transform:scale).

   OPT OUT:  set  window.PP_NO_AUTOFIT = true  BEFORE this script loads.
             The report tools (online-reports / national / commercial) do this
             because they run their own zoom system; double-scaling would fight.
   OPT IN TO HEIGHT: set  window.PP_FIT_HEIGHT = true  BEFORE this script loads
             and the page is ALSO scaled down to fit the viewport HEIGHT (the
             smaller of the two scales wins). Width-only is the default because
             most tools scroll vertically by design; a fixed-composition page
             like the Property Clock opts in so a laptop shows the whole face
             without scrolling (Saskia 2026-09-07: "bigger than my screen and
             can't zoom out"). Pages that opt in must not rely on vertical
             scrolling for their main content.

   MIN_SCALE floors the shrink so one stray over-wide element can't collapse the
   whole UI to nothing. A tool that changes its own layout (e.g. revealing a
   panel) can call window.PP_refit() to re-measure.
   ─────────────────────────────────────────────────────────────────────────── */
(function () {
  if (window.PP_NO_AUTOFIT) return;
  var MIN_SCALE = 0.6;
  var pending = false;

  function apply() {
    pending = false;
    try {
      var el = document.documentElement;
      el.style.zoom = '';                 // reset so we measure the TRUE (unscaled) width
      var content = el.scrollWidth;       // reading scrollWidth forces a reflow at zoom:1
      var view = window.innerWidth;
      if (!content || !view) return;
      var scale = view / content;
      if (window.PP_FIT_HEIGHT) {
        var contentH = el.scrollHeight, viewH = window.innerHeight;
        if (contentH && viewH) scale = Math.min(scale, viewH / contentH);
        /* A responsive page re-flows WIDER once it is zoomed out (the CSS
           viewport grows by 1/zoom), so its content can come back taller than
           the first measurement — the clock face tracks the page width, for
           one. Converge: apply the zoom, measure what is actually on screen
           (viewport + how far the page can scroll — unambiguous on-screen px,
           unlike scrollHeight, whose units under `zoom` differ by browser),
           and repeat until the scale stops moving. Scroll position is put
           back each time. */
        for (var i = 0; i < 4 && scale < 0.999; i++) {
          var z = Math.max(MIN_SCALE, Math.floor(scale * 1000) / 1000);
          el.style.zoom = String(z);
          var sx = window.scrollX, sy = window.scrollY;
          window.scrollTo(1e9, 1e9);
          var visW = window.innerWidth + window.scrollX, visH = window.innerHeight + window.scrollY;
          window.scrollTo(sx, sy);
          var next = Math.min(view / visW, viewH / visH) * z;
          if (Math.abs(next - scale) < 0.004) { scale = Math.min(scale, next); break; }
          scale = next;
        }
      }
      if (scale >= 0.999) { el.style.zoom = ''; return; }   // already fits — leave at 100%
      el.style.zoom = String(Math.max(MIN_SCALE, Math.floor(scale * 1000) / 1000));
    } catch (_) { /* zoom unsupported or measurement blocked — leave the page as-is */ }
  }
  function schedule() { if (!pending) { pending = true; requestAnimationFrame(apply); } }

  // Public hook so a tool can ask for a re-fit after it mutates its own layout.
  window.PP_refit = schedule;

  if (document.readyState !== 'loading') schedule();
  document.addEventListener('DOMContentLoaded', schedule);
  // `load` fires after images/fonts settle; the extra delayed pass catches
  // content that appears just after (e.g. an async auth-gated view).
  window.addEventListener('load', function () { schedule(); setTimeout(schedule, 400); });
  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(schedule, 100); });
})();
