/* =============================================================================
   vercel-img.js — PP_IMG(path, w): route heavy images through Vercel Image
   Optimization (/_vercel/image → AVIF/WebP, resized, edge-cached) when the
   page is served from a Vercel origin. Everywhere else (GitHub Pages,
   localhost, the monthly PDF renderer) it returns the path unchanged — the
   helper is inert off-Vercel, so ONE codebase serves both hosts.

   `w`/`q` must be values allowed by vercel.json's `images` block (sizes /
   qualities) or the endpoint 400s. Default 1920/75 targets the ~3.5MB report
   cover JPGs (→ ~200KB AVIF).

   At DNS cutover (tools.performanceproperty.com.au → Vercel) extend ON to
   match the custom domain — see the Vercel-migration project memory.
   ============================================================================= */
(function (root) {
  'use strict';
  var host = (root.location && root.location.hostname) || '';
  var ON = /\.vercel\.app$/i.test(host);
  function PP_IMG(path, w) {
    if (!ON || !path) return path;
    var abs;
    try { abs = new URL(path, root.location.href).pathname; } catch (e) { return path; }
    return '/_vercel/image?url=' + encodeURIComponent(abs) + '&w=' + (w || 1920) + '&q=75';
  }
  PP_IMG.on = ON;
  root.PP_IMG = PP_IMG;
})(typeof window !== 'undefined' ? window : this);
