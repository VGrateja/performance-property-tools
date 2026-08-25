/* Generate tools/online-reports-picker.html.

   ONE flat ALPHABETICAL list (Van 2026-08-24: no state/cluster grouping, no
   floating modal), rendered as ROWS with a "Copy PDF link" button on the right
   (Saskia 2026-08-25: "one long list in alphabetical order - no emoji - with a
   copy pdf link button next to each report on the right"). The emoji column is
   gone with it.

   The region data is extracted from index.html's REGION_CLUSTERS at generation
   time so the two can't drift apart. The PDF links are NOT baked in — they live
   in public.documents_state (section 'research-links') and are fetched at
   runtime and matched BY TITLE, so a link updated in the Documents tool shows
   up here immediately with nothing to regenerate.

   REGENERATE, don't hand-edit the output: a fix applied to the HTML alone was
   silently wiped the last time this ran. */
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'C:/Users/vandolf_performancep/repos/Supabase - Performance Internal Tool/';
const HUB  = REPO + 'index.html';
const OUT  = REPO + 'tools/online-reports-picker.html';
/* Region data is read straight out of index.html's REGION_CLUSTERS, so this
   script has NO untracked input and the two can never drift. It previously
   read scratch/_regions-flat.json — a gitignored file — while its header
   claimed to do exactly what it now actually does. */
function readRegionClusters() {
  const idx = readFileSync(HUB, 'utf8');
  const start = idx.indexOf('const REGION_CLUSTERS = {');
  if (start < 0) throw new Error('REGION_CLUSTERS not found in index.html');
  /* walk to the matching close brace so nested objects are included */
  const open = idx.indexOf('{', start);
  let d = 0, end = -1;
  for (let i = open; i < idx.length; i++) {
    if (idx[i] === '{') d++;
    else if (idx[i] === '}') { d--; if (d === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('unbalanced REGION_CLUSTERS block');
  const literal = idx.slice(open, end + 1);
  /* an object literal with comments and trailing commas — eval it in a
     Function rather than JSON.parse, which handles neither */
  const obj = new Function('return (' + literal + ');')();
  const out = [];
  for (const ck of Object.keys(obj)) {
    for (const r of (obj[ck].regions || [])) {
      out.push({ cluster: ck, slug: r.slug, name: r.name, state: r.state || null, icon: r.icon || null, url: r.url || null });
    }
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}
const flat = readRegionClusters();
const NL = '\n';
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/* The picker and the PDF-link list name two things differently. Everything else
   matches exactly (verified 36/36), so only these two need an alias. */
const PDF_TITLE = {
  'Commercial Market': 'Commercial Report',
  'National Market': 'National Report',
};

/* The PDF Reports widget was removed 2026-08-25, which left ONE of its 39 links
   with nowhere to live: the National Property Clock is a PDF but not a report,
   so it had no row here to attach to. It gets one — opening the Clock tool, and
   picking up its PDF by title like every other row. Drop this entry if the
   Clock's PDF ever gets a home of its own. */
const EXTRAS = [
  { name: 'National Property Clock', state: 'AUS', url: 'tools/property-clock.html' },
];

const rows = flat.concat(EXTRAS)
  .sort((a, b) => String(a.name).localeCompare(String(b.name)))
  .map(r => {
  /* This page lives IN tools/, so a tool it links to is a SIBLING — no '../'.
     The original prefixed one, which 404'd every research-report row from the
     day this was generated (National Market, Commercial Market). */
  const href = r.url ? r.url.replace(/^tools\//, '') : ('online-reports.html?cluster=' + r.cluster + '&region=' + r.slug);
  const research = !!r.url;
  return [
    '    <div class="rp-row' + (research ? ' rp-research' : '') + '" data-name="' + esc(r.name).toLowerCase() + '" data-pdf="' + esc(PDF_TITLE[r.name] || r.name) + '">',
    /* new tab per report — the picker stays put so several can be compared */
    '      <a class="rp-open" href="' + href + '" target="_blank" rel="noopener">',
    '        <span class="rp-name">' + esc(r.name) + '</span>',
    '        <span class="rp-state">' + esc(r.state || '') + '</span>',
    '      </a>',
    '      <button type="button" class="rp-copy" hidden>Copy PDF link</button>',
    '    </div>',
  ].join(NL);
}).join(NL);

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Residential Research Reports &mdash; Performance Property</title>
<link rel="icon" href="../assets/logo.png" type="image/png"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;0,600;0,700;0,800;0,900;1,400&display=swap" rel="stylesheet">
<script src="../shared/os-chrome.js"></script>
<link rel="stylesheet" href="../shared/os-theme.css"/>
<style>
  /* RESIDENTIAL RESEARCH REPORTS PICKER — replaces the hub's floating cluster
     modal (Van 2026-08-24). Every report in ONE flat alphabetical list, each
     row carrying a Copy PDF link button (Saskia 2026-08-25). Accent = the
     Documents amber the widget wears. GENERATED by
     scratch/_gen-reports-picker.mjs — regenerate rather than hand-edit.
     Dark = default; light via the os-chrome bridge. */
  *,*::before,*::after{ box-sizing:border-box; }
  :root{
    --ink:#F5F3FA; --muted:#9A94B0; --line:rgba(255,255,255,.10);
    --panel:rgba(255,255,255,.04); --panel2:rgba(255,255,255,.07);
    --amber:#FFB947; --amber2:#E08A00;
  }
  html,body{ margin:0; padding:0; }
  body{ background:transparent; color:var(--ink); min-height:100vh;
    font-family:'Montserrat','Segoe UI',system-ui,-apple-system,sans-serif; -webkit-font-smoothing:antialiased; }
  .wrap{ max-width:900px; margin:0 auto; padding:64px 22px 70px; }
  .eyebrow{ font-size:.7rem; font-weight:800; letter-spacing:.22em; text-transform:uppercase; color:var(--amber); }
  h1{ font-size:1.9rem; font-weight:800; margin:8px 0 4px; letter-spacing:-.02em;
    background:linear-gradient(90deg,#fff,#ffe2b3 60%,var(--amber)); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
  .lede{ color:var(--muted); font-size:.92rem; max-width:760px; }
  .rp-search{ margin:20px 0 16px; }
  .rp-search input{ width:100%; max-width:420px; padding:11px 15px; border:1px solid var(--line); border-radius:11px;
    background:var(--panel2); color:var(--ink); font:inherit; font-weight:600; font-size:.92rem; }
  .rp-search input::placeholder{ color:var(--muted); }

  /* One long list, not a grid — the report name reads first, the PDF action
     sits at a constant x so the right-hand column scans as one column. */
  .rp-list{ display:flex; flex-direction:column; gap:5px; }
  .rp-row{ display:flex; align-items:center; gap:10px; padding:4px 6px 4px 14px; border-radius:11px;
    background:var(--panel); border:1px solid var(--line); transition:background .14s, border-color .14s; }
  .rp-row:hover{ background:var(--panel2); border-color:var(--amber); }
  .rp-open{ flex:1; min-width:0; display:flex; align-items:center; gap:11px;
    padding:9px 0; color:inherit; text-decoration:none; }
  .rp-name{ font-weight:800; font-size:.95rem; letter-spacing:-.01em; overflow-wrap:anywhere; }
  .rp-state{ flex:none; font-size:.64rem; font-weight:800; letter-spacing:.08em; color:var(--muted);
    border:1px solid var(--line); border-radius:6px; padding:3px 7px; }
  .rp-copy{ flex:none; font:inherit; font-size:.72rem; font-weight:800; letter-spacing:.02em;
    padding:7px 11px; border-radius:8px; cursor:pointer; white-space:nowrap;
    background:transparent; color:var(--muted); border:1px solid var(--line);
    transition:background .14s, color .14s, border-color .14s; }
  .rp-copy:hover{ background:rgba(255,185,71,.14); color:var(--amber); border-color:rgba(255,185,71,.45); }
  .rp-copy.copied{ background:rgba(113,179,87,.16); color:#8FD16F; border-color:rgba(113,179,87,.5); }
  .rp-research{ border-color:rgba(255,185,71,.45); background:rgba(255,185,71,.07); }
  .rp-research .rp-state{ color:var(--amber); border-color:rgba(255,185,71,.45); }
  .rp-none{ color:var(--muted); font-size:.85rem; padding:14px 4px; display:none; }
  [data-theme="light"] body{ color:#1F283F; }
  [data-theme="light"] .rp-row{ background:rgba(31,40,63,.04); border-color:rgba(31,40,63,.12); }
  [data-theme="light"] .rp-row:hover{ background:rgba(31,40,63,.08); border-color:var(--amber2); }
  [data-theme="light"] .rp-name{ color:#1F283F; }
  [data-theme="light"] .rp-state{ color:rgba(31,40,63,.6); border-color:rgba(31,40,63,.18); }
  [data-theme="light"] .rp-research .rp-state{ color:#8a5200; border-color:rgba(224,138,0,.5); }
  [data-theme="light"] .rp-copy{ color:rgba(31,40,63,.62); border-color:rgba(31,40,63,.18); }
  [data-theme="light"] .rp-copy:hover{ background:rgba(224,138,0,.12); color:#8a5200; border-color:rgba(224,138,0,.5); }
  [data-theme="light"] .rp-search input{ background:#fff; color:#1F283F; border-color:rgba(31,40,63,.18); }
  [data-theme="light"] .lede{ color:rgba(31,40,63,.65); }
  [data-theme="light"] h1{ background:linear-gradient(90deg,#1F283F,#8a5200 70%,var(--amber2)); -webkit-background-clip:text; background-clip:text; }
  @media(max-width:520px){ .rp-copy{ font-size:0; padding:7px 9px; } .rp-copy::after{ content:'PDF'; font-size:.72rem; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="eyebrow">Documents &amp; Reports</div>
  <h1>Residential Research Reports</h1>
  <p class="lede">Every report in one list, A&nbsp;to&nbsp;Z &mdash; the eight capitals, all 28 regions, the two Australia-wide research reports, and the national property clock. Each report opens in a new tab, so you can open several and compare them side by side. <strong>Copy PDF link</strong> copies the shareable PDF for that report.</p>
  <div class="rp-search"><input id="rpSearch" type="text" placeholder="Type to filter&hellip; (e.g. mel, gold, national)" autocomplete="off"></div>
  <div class="rp-list" id="rpGrid">
${rows}
  </div>
  <div class="rp-none" id="rpNone">No report matches that filter.</div>
</div>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="../shared/supabase-client.js"></script>
<script src="../shared/auth.js"></script>
<script src="../shared/auth-gate.js"></script>
<script src="../shared/pp-telemetry.js"></script>
<script>
  PP_OS.initChrome({ name: 'Residential Research Reports', section: 'docs', backHref: '../' });
  /* ?lite=1 (the Vault's Lite card routes here too) — propagate onto every link */
  (function () {
    try {
      if (new URLSearchParams(location.search).get('lite') !== '1') return;
      document.querySelectorAll('.rp-open').forEach(function (a) {
        a.href += (a.href.indexOf('?') >= 0 ? '&' : '?') + 'lite=1';
      });
      document.querySelector('h1').textContent = 'Lite Residential Research Reports';
    } catch (e) {}
  })();

  /* PDF links come from the Documents tool's own data (public.documents_state,
     section 'research-links'), matched BY TITLE — so a link corrected there is
     live here with nothing to regenerate. A row whose title has no PDF simply
     keeps its button hidden rather than showing one that does nothing. */
  (function () {
    function copy(url, btn) {
      var done = function () {
        btn.classList.add('copied'); btn.textContent = 'Copied';
        clearTimeout(btn._t);
        btn._t = setTimeout(function () { btn.classList.remove('copied'); btn.textContent = 'Copy PDF link'; }, 1600);
      };
      function fallback() {
        try {
          var ta = document.createElement('textarea');
          ta.value = url; ta.setAttribute('readonly', '');
          ta.style.cssText = 'position:absolute;left:-9999px';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); ta.remove(); done();
        } catch (e) { window.prompt('Copy this link:', url); }
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fallback);
        else fallback();
      } catch (e) { fallback(); }
    }
    async function wire() {
      if (!window.sb) return;
      var map = {};
      try {
        /* singleton row id=1; .limit(1) rather than .single() — .single() 406s
           on these payload tables when the row is filtered out by RLS */
        var res = await window.sb.from('documents_state').select('payload').eq('id', 1).limit(1);
        var payload = res && res.data && res.data[0] && res.data[0].payload;
        var secs = (payload && payload.sections) || [];
        secs.forEach(function (s) {
          if (!s || s.id !== 'research-links') return;
          (s.subsections || []).forEach(function (sub) {
            (sub.items || []).forEach(function (it) {
              if (it && it.title && it.url) map[String(it.title).trim().toLowerCase()] = it.url;
            });
          });
        });
      } catch (e) { console.warn('[reports] PDF links unavailable', e); return; }
      document.querySelectorAll('.rp-row').forEach(function (row) {
        var url = map[String(row.dataset.pdf || '').trim().toLowerCase()];
        var btn = row.querySelector('.rp-copy');
        if (!btn || !url) return;
        btn.hidden = false;
        btn.title = 'Copy the shareable PDF link for ' + (row.dataset.pdf || 'this report');
        btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); copy(url, btn); });
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
    setTimeout(wire, 1500);   /* the supabase client can land after first paint */
  })();

  /* type-to-filter — instant, purely client-side */
  (function () {
    var box = document.getElementById('rpSearch'), grid = document.getElementById('rpGrid'), none = document.getElementById('rpNone');
    if (!box) return;
    box.addEventListener('input', function () {
      var q = box.value.trim().toLowerCase(), shown = 0;
      grid.querySelectorAll('.rp-row').forEach(function (t) {
        var on = !q || t.dataset.name.indexOf(q) >= 0;
        t.style.display = on ? '' : 'none'; if (on) shown++;
      });
      none.style.display = shown ? 'none' : 'block';
    });
    box.focus();
  })();
</script>
</body>
</html>
`;
/* Writes into the REPO. It pointed at the Desktop/PP-Hub-Simplify staging
   worktree while the redesign lived there; once that merged into main, a
   regeneration silently edited a redundant copy and left production alone. */
writeFileSync(OUT, page.replace(/\n/g, '\r\n'));
console.log('written: tools/online-reports-picker.html (' + (flat.length + EXTRAS.length) + ' rows, alphabetical, copy-PDF buttons)');

/* The template above writes shared/* refs WITHOUT ?v= cache-bust stamps, so a
   regeneration silently strips them and returning visitors get stale shared
   CSS/JS on this page — the offline-vs-online gap the repo works hard to avoid.
   Re-stamp here rather than relying on anyone remembering. Idempotent; it only
   rewrites query strings. */
const { execFileSync } = await import('node:child_process');
try {
  execFileSync(process.execPath, ['scripts/stamp-shared-assets.mjs'], { stdio: 'pipe' });
  console.log('re-stamped shared-asset refs (the template emits them unstamped)');
} catch (e) {
  console.error('WARNING: could not re-stamp shared assets — run node scripts/stamp-shared-assets.mjs');
}
