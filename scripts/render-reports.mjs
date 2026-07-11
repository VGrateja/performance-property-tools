// =============================================================================
// scripts/render-reports.mjs
//
// Monthly Online Reports renderer. Run by .github/workflows/render-online-
// reports.yml or locally with `node scripts/render-reports.mjs`.
//
// For each region × { full, lite }:
//   1. Sign in to Supabase as the pdf-renderer service account.
//   2. Open online-reports.html?region=<slug>[&lite=1] in headless Chrome.
//   3. Wait for window.PPA_LIVE_BOOT_DONE (page + live data + charts ready).
//   4. Capture the report as a multi-page PDF using native Chrome page.pdf()
//      — vector text, smaller files, sharper than the in-browser
//      html2canvas + jsPDF path the consumer sees as a fallback.
//   5. Upload to Supabase Storage (bucket `online-reports`) using the
//      service-role key (bypasses RLS for write).
//
// Retention: prune anything outside the current calendar month so the bucket
// never exceeds one month's worth of files (~750 MB at current sizes — keeps
// us under Supabase's 1 GB free-tier ceiling). The prune fires EARLY — as soon
// as the first new file of the run is safely uploaded — so a month-rollover
// run never briefly holds two full months at once (~1.1 GB, over the cap). A
// second prune at the tail is the backstop. The admin keeps off-site backups.
//
// Required env vars (set as GitHub Secrets):
//   SUPABASE_URL                  https://<project-ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY     for storage writes
//   SUPABASE_ANON_KEY             for the renderer's password sign-in
//   PDF_RENDERER_EMAIL            pdf-renderer@performanceproperty.com.au
//   PDF_RENDERER_PASSWORD         password for the service account
//   APP_URL                       https://app.url (no trailing slash)
//                                 — the host serving online-reports.html
//
// Local quickstart:
//   cp .env.example .env  # fill in the values
//   set -a && source .env && set +a
//   node scripts/render-reports.mjs
// =============================================================================

import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL               = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY          = process.env.SUPABASE_ANON_KEY;
const PDF_RENDERER_EMAIL         = process.env.PDF_RENDERER_EMAIL;
const PDF_RENDERER_PASSWORD      = process.env.PDF_RENDERER_PASSWORD;
const APP_URL                    = process.env.APP_URL;

const BUCKET = 'online-reports';

/* PDF page size — matches the design's native pixel dimensions so
   each section.page fits in exactly one PDF page with no overflow.
   The .page CSS hardcodes 1200×900 CSS pixels (Looker parity), and
   Chromium's CSS→PDF conversion uses 96 DPI. So:
     1200 px / 96 dpi × 25.4 mm/inch = 317.5 mm  wide
      900 px / 96 dpi × 25.4 mm/inch = 238.125 mm tall
   Previous run used 297 × 222.75 mm (A4 landscape's long side at
   4:3), which was 78px narrower + 58px shorter than the design —
   so each section.page overflowed onto the next PDF page, producing
   alternating "full content" + "empty tail" pages in the output. */
const PDF_WIDTH_MM  = 317.5;
const PDF_HEIGHT_MM = 238.125;

/* Region slugs — copied from REGION_MANIFEST in tools/online-reports.html.
   If a region is added/renamed in the manifest, mirror the change here. */
const REGION_SLUGS = [
  // Capitals
  'sydney', 'melbourne', 'brisbane', 'adelaide',
  'perth', 'hobart', 'canberra', 'darwin',
  // QLD regional
  'mackay', 'bundaberg', 'ipswich', 'rockhampton', 'gladstone',
  'cairns', 'townsville', 'sunshine-coast', 'toowoomba', 'gold-coast',
  // NSW regional (dubbo removed 2026-07-07 — hidden across the system)
  'albury', 'central-coast', 'coffs-harbour', 'orange',
  'port-macquarie', 'newcastle', 'tamworth', 'wagga-wagga', 'wollongong',
  // VIC / WA / TAS regional
  'ballarat', 'bendigo', 'geelong', 'wodonga', 'mildura',
  'rockingham', 'mandurah', 'bunbury', 'launceston',   // mandurah split into its own report 2026-07-09
];

/* Research-reports slugs — Australia-wide reports that live in
   their own tool files (national-report.html / commercial-report.html)
   rather than online-reports.html. They share the same Storage
   bucket + month-key path scheme so the front-end download flow
   doesn't need to know they're a different shape — it just asks
   for `online-reports/<month>/national.pdf` or `.../commercial.pdf`.
   Lite mode does not apply to these (no Tier-4 lite preview). */
const RESEARCH_REPORT_SLUGS = ['national', 'commercial'];
function isResearchReportSlug(slug) {
  return RESEARCH_REPORT_SLUGS.indexOf(slug) >= 0;
}
function reportUrlForSlug(slug, lite) {
  const liteSuffix = lite ? '&lite=1' : '';
  /* fresh=1: skips the Supabase snapshot step in the reports' fallback
     chain. Since the Forge cutover the reports read Forge by DEFAULT, so
     on the normal path this flag is a NO-OP — the PDFs capture the
     last-PUBLISHed Forge mart, which is correct and intended (don't
     "fix" this). It only still matters on the legacy ?src=live path /
     when Forge is unreadable, where it forces the live Apps Script feed
     instead of a possibly-stale snapshot. */
  const freshSuffix = '&fresh=1';
  if (isResearchReportSlug(slug)) {
    /* Research reports live in their own tool files. They don't
       take a region param — the tool file IS the report. */
    return APP_URL.replace(/\/$/, '') +
      '/tools/' + slug + '-report.html?exportMode=1' + liteSuffix + freshSuffix;
  }
  return APP_URL.replace(/\/$/, '') +
    '/tools/online-reports.html?region=' + encodeURIComponent(slug) +
    '&exportMode=1' + liteSuffix + freshSuffix;
}

const MONTH_KEY = (() => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
})();

/* Region slug → Research Links subsection id. Mirrors RESEARCH_LINKS_SUBS
   in tools/whitepapers-strategies.html. The "rl-others" subsection is
   intentionally NOT covered here — it stays user-maintained for ad-hoc
   links that don't follow the per-month rendered-PDF pattern. */
const RESEARCH_LINKS_BY_SUB = {
  'rl-capital': [
    'sydney', 'melbourne', 'brisbane', 'adelaide',
    'perth',  'hobart',    'canberra', 'darwin',
  ],
  'rl-qld': [
    'mackay',     'bundaberg',   'ipswich',  'rockhampton', 'gladstone',
    'cairns',     'townsville',  'sunshine-coast', 'toowoomba', 'gold-coast',
  ],
  'rl-nsw': [
    /* dubbo removed 2026-07-07 — hidden across the system (not in use) */
    'albury',         'central-coast', 'coffs-harbour', 'orange',
    'port-macquarie', 'newcastle',     'tamworth',      'wagga-wagga', 'wollongong',
  ],
  'rl-vicwatas': [
    'ballarat',  'bendigo', 'geelong',  'wodonga', 'mildura',
    'rockingham','bunbury', 'launceston',
  ],
};

const MONTH_NAMES = [
  'January', 'February', 'March',     'April',   'May',      'June',
  'July',    'August',   'September', 'October', 'November', 'December',
];

function slugToTitle(slug) {
  return slug.split('-')
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}
function publicPdfUrl(slug) {
  return SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + MONTH_KEY + '/' + slug + '.pdf';
}
function formatTodayDMY() {
  const d = new Date();
  return String(d.getDate()).padStart(2, '0') + '/' +
         String(d.getMonth() + 1).padStart(2, '0') + '/' +
         d.getFullYear();
}
function formatMonthLabel() {
  const [y, m] = MONTH_KEY.split('-');
  return MONTH_NAMES[parseInt(m, 10) - 1] + ' ' + y;
}

function requireEnv() {
  const missing = [
    ['SUPABASE_URL',              SUPABASE_URL],
    ['SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY],
    ['SUPABASE_ANON_KEY',         SUPABASE_ANON_KEY],
    ['PDF_RENDERER_EMAIL',        PDF_RENDERER_EMAIL],
    ['PDF_RENDERER_PASSWORD',     PDF_RENDERER_PASSWORD],
    ['APP_URL',                   APP_URL],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error('Missing required env vars: ' + missing.join(', '));
    process.exit(1);
  }
}

async function signInService() {
  console.log('Signing in as ' + PDF_RENDERER_EMAIL + '…');
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data, error } = await sb.auth.signInWithPassword({
    email:    PDF_RENDERER_EMAIL,
    password: PDF_RENDERER_PASSWORD,
  });
  if (error) throw new Error('Sign-in failed: ' + error.message);
  if (!data || !data.session) throw new Error('Sign-in returned no session');
  return data.session;
}

/* Inject the auth session into the iframe's localStorage BEFORE any
   page script runs. The session shape matches what supabase-client.js
   writes when a real user signs in — `pp-sb-auth` key, holding the
   currentSession object. auth-gate.js peeks at localStorage
   synchronously, so without this it would redirect to /index.html. */
async function injectSession(page, session) {
  const payload = JSON.stringify({
    access_token:  session.access_token,
    refresh_token: session.refresh_token,
    expires_at:    session.expires_at,
    expires_in:    session.expires_in,
    token_type:    session.token_type,
    user:          session.user,
    currentSession: session,
  });
  await page.evaluateOnNewDocument((p) => {
    try { localStorage.setItem('pp-sb-auth', p); } catch (_) {}
  }, payload);
}

async function renderRegion(browser, slug, lite, session) {
  const page = await browser.newPage();
  try {
    /* deviceScaleFactor controls the DPI at which Chrome rasterizes
       canvas-based charts and embedded images. Text stays vector
       regardless. 1.5 lands full PDFs around 7-8 MB (matching Looker
       Studio's output) with charts still crisp at 1× display zoom —
       softness only visible if the reader zooms 2×+. 2.0 produces
       retina-sharp charts but ~10-11 MB files. */
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1.5 });
    await injectSession(page, session);

    const url = reportUrlForSlug(slug, lite);

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });

    /* The page sets PPA_LIVE_BOOT_DONE = true once liveBoot + charts
       have finished rendering. 90s is the same hard timeout the
       in-page iframe export uses. */
    await page.waitForFunction(
      () => window.PPA_LIVE_BOOT_DONE === true,
      { timeout: 90000, polling: 200 }
    );

    /* Data-applied guard: PPA_LIVE_BOOT_DONE can fire on error paths before
       the region's live data has replaced the static Sydney baseline — which
       would bake WRONG numbers into the PDF/JPG (caught in the At-a-Glance
       JPG cache: Adelaide tiles showing Sydney's 5,143,256). Wait until the
       live merge for THIS region has landed. Best-effort (won't block the
       render if a region's feed is genuinely down). */
    if (!isResearchReportSlug(slug)) {
      await page.waitForFunction(
        s => window.PPA_REGION_DATA && !!window.PPA_REGION_DATA[s],
        { timeout: 60000, polling: 200 }, slug
      ).catch(() => console.warn('  (data-applied guard timed out for ' + slug + ' — capturing anyway)'));
    }

    /* #7: image overlays now load via a signed-URL round-trip
       (createSignedUrl → <img> fetch from the private report-images bucket),
       which can finish after PPA_LIVE_BOOT_DONE. Wait until every overlay
       <img> has actually decoded so it appears in the captured PDF.
       Best-effort: a stuck/failed image times out rather than blocking the
       render (a missing overlay is better than no PDF). Reports with no
       image overlays pass this instantly (every() over an empty list). */
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('.image-overlay img'))
        .every(im => im.complete && im.naturalWidth > 0),
      { timeout: 20000, polling: 200 }
    ).catch(() => {});

    /* Force fonts to load + settle. Without this, glyphs sometimes
       render with the fallback face on first paint. */
    await page.evaluate(() => document.fonts && document.fonts.ready);

    /* Force screen media emulation. Puppeteer's page.pdf() defaults
       to print emulation, which calculates a print viewport from the
       @page size (~1123 CSS px at 297mm/96dpi). That's below the
       page's mobile breakpoint at @media (max-width: 1199px), which
       triggers two layout disasters:
         1. .mobile-control-bar appears (the "ONLINE REPORTS" header
            band shows up in every PDF page).
         2. .page gets `transform: scale(--page-scale)` applied so it
            shrinks to fit a phone — leaves most of the PDF page
            blank with content crammed in the top-left.
       Screen emulation keeps the page at its 1200×900 design width
       so the desktop layout stays put. We then inject the bits of
       @media print behaviour we actually need (page breaks, dark
       background, chrome hidden, colour preservation) below. */
    await page.emulateMediaType('screen');

    await page.evaluate(() => {
      document.body.style.zoom = '1';
      document.body.classList.remove('edit-mode', 'show-grid');
      /* Chrome's page.pdf() preserves <a> link annotations for hidden
         elements — display:none keeps them visually gone but the
         click-region survives in the PDF (and sometimes Chrome
         leaks the visual too). Belt-and-braces: physically remove
         every chrome surface from the DOM before capture. The
         addStyleTag display:none rules below still apply for any
         late-injected nodes (concierge widget, etc.) that arrive
         after this evaluate runs. */
      const CHROME_SELECTORS = [
        '.pager', '.ct-panel', '.side-toc', '.mobile-control-bar',
        '#or-back-to-hub', '#or-cluster-btn', '#or-theme-toggle',
        '#pdf-overlay', '.bands-modal-bg',
        '.concierge-btn', '.concierge-panel',
        /* New chrome on tools/national-report.html and
           tools/commercial-report.html. IDs are pp-* (rather than the
           or-* prefix used on the regional tool), and there's a new
           bottom-center .pp-pager toolbar that hosts the edit-mode
           controls. All of these need DOM-removing to keep them out
           of the cached PDFs. */
        '#pp-back-to-hub', '#pp-back-to-cluster', '#pp-theme-toggle',
        '#pp-download-pill', '#pp-download-menu', '#pp-export-overlay',
        '.pp-pager', '#ct-panel',
        /* Slice 3 — shape picker, shape panel, page-bg popover,
           apply-to-pages modal, image right-click menu. None of these
           are visible at boot but the regional file's belt-and-braces
           pattern is to physically remove them anyway. */
        '#sh-picker', '#sh-panel', '#bg-popover', '#bg-apply-modal-bg',
        '#or-ctx-menu',
        /* Slice 4 — backup, sync, audit modals. */
        '#backup-modal-bg', '#sync-modal-bg', '#audit-modal-bg',
        '#pdf-pages-modal-bg', '#history-modal-bg',
        /* #8 — AI commentary draft modal (injected by report-edit.js). */
        '#pp-ai-modal-bg',
        /* Live-data loading overlay on the research reports — hidden in
           export mode by CSS + liveBoot, but remove it from the DOM too so
           it can never paint behind the first captured page. */
        '#live-loading-overlay',
      ];
      CHROME_SELECTORS.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove());
      });
    });

    /* Inject the print-only behaviours we want, decoupled from the
       page's @media print block (which we're no longer triggering).
       The wide selector list hides every chrome surface — pager,
       mobile bar, side TOC, edit panels, floating nav pills, modals,
       overlays — so none of them leak into the captured PDF. */
    await page.addStyleTag({
      content: `
        /* Chrome surfaces — none of this belongs in a print PDF.
           AI Concierge launcher + panel are loaded on every tool
           page and would otherwise paint a cyan circle in the
           bottom-right corner of every PDF page. */
        .pager, .ct-panel, .side-toc, .mobile-control-bar,
        #or-back-to-hub, #or-cluster-btn, #or-theme-toggle,
        #pdf-overlay, .bands-modal-bg,
        .concierge-btn, .concierge-panel,
        #pp-back-to-hub, #pp-back-to-cluster, #pp-theme-toggle,
        #pp-download-pill, #pp-download-menu, #pp-export-overlay,
        .pp-pager, #ct-panel,
        #sh-picker, #sh-panel, #bg-popover, #bg-apply-modal-bg,
        #or-ctx-menu,
        #backup-modal-bg, #sync-modal-bg, #audit-modal-bg,
        #pdf-pages-modal-bg, #history-modal-bg, #pp-ai-modal-bg,
        #live-loading-overlay { display: none !important; }

        /* Each report page becomes one PDF page. */
        section.page {
          page-break-after: always !important;
          margin: 0 !important;
          box-shadow: none !important;
          transform: none !important;
        }
        section.page:last-of-type { page-break-after: auto !important; }
        .page-outer-wrap { padding: 0 !important; }

        /* Preserve the dark navy background. Without this, Chrome
           strips backgrounds for "ink saving" in print mode. */
        html, body, .page, .page-outer-wrap, * {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        body { background: #0a1520 !important; }
      `,
    });

    /* Lite-mode size guard. The page's CSS uses `filter: blur(6px)`
       on locked-page subtrees to obscure non-preview content. Chrome's
       PDF renderer can't represent CSS blur as vector, so it
       rasterizes the entire blurred subtree at high DPI — which
       turned a ~10 MB full PDF into a ~30 MB lite one. We drop the
       blur here only during render; the live in-browser view still
       sees it. The existing dark gradient overlay (.lite-locked::after)
       plus the "Get Full Access" CTA already obscure the content
       visually, so the locked pages still read as "locked" without
       the blur effect. */
    if (lite) {
      await page.addStyleTag({
        content: '.lite-mode section.page.lite-locked > *:not(.lite-locked-overlay) { filter: none !important; }',
      });
    }

    /* Settle pause — chart resize observers + any deferred layout. */
    await new Promise(r => setTimeout(r, 1500));

    /* At-a-Glance JPG cache: while the FULL regional report is booted anyway,
       snapshot the At a Glance page (p2) — uploaded alongside the PDFs to
       <month>/jpg/<slug>-at-a-glance.jpg so the in-tool JPEG download can
       serve 9 regions in seconds instead of live-rendering each one. Skipped
       for lite + the research reports (the JPG flow is regional-only).
       Best-effort: a capture failure never fails the PDF render. */
    let atGlance = null;
    if (!lite && !isResearchReportSlug(slug)) {
      try {
        /* applyAutoZoom shrinks body at 1200px viewports — force zoom 1 for a
           full-size element screenshot, restore before the PDF capture. */
        const prevZoom = await page.evaluate(() => { const z = document.body.style.zoom; document.body.style.zoom = '1'; return z; });
        await new Promise(r => setTimeout(r, 300));
        const el = await page.$('#p2');
        if (el) atGlance = await el.screenshot({ type: 'jpeg', quality: 82 });
        await page.evaluate(z => { document.body.style.zoom = z || ''; }, prevZoom);
      } catch (e) {
        console.warn('  at-a-glance jpg capture failed for ' + slug + ': ' + (e && e.message || e));
      }
    }

    /* Native PDF. The existing @media print CSS handles page breaks
       (section.page { page-break-after: always }) and background
       colour preservation. We override the @page size to 297×222.75mm
       so the 4:3 design fills the page edge-to-edge. */
    const pdf = await page.pdf({
      width:           PDF_WIDTH_MM + 'mm',
      height:          PDF_HEIGHT_MM + 'mm',
      printBackground: true,
      margin:          { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: false,
    });
    return { pdf, atGlance };
  } finally {
    await page.close();
  }
}

async function uploadPdf(sb, slug, lite, buffer) {
  const path = MONTH_KEY + '/' + (lite ? 'lite/' : '') + slug + '.pdf';
  const { error } = await sb.storage.from(BUCKET).upload(path, buffer, {
    contentType: 'application/pdf',
    upsert:      true,
    cacheControl: '3600',
  });
  if (error) throw new Error('Upload failed for ' + path + ': ' + error.message);
  return path;
}

/* Render + upload with a single retry. Empirically about ~1 region
   per run hits a transient failure — usually a 90s liveBoot timeout
   on a cold Apps Script start, occasionally a "Bad Request" on the
   storage upload (network blip). Both clear on a second attempt
   ~5s later. Two attempts gets us from ~99% to ~99.95% reliability;
   no point retrying further since persistent failures point to a
   real problem (region renamed, page broken, etc.). */
async function renderAndUploadWithRetry(browser, sb, slug, lite, session, label) {
  const MAX_ATTEMPTS = 2;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const out  = await renderRegion(browser, slug, lite, session);
      const path = await uploadPdf(sb, slug, lite, out.pdf);
      /* At-a-Glance JPG cache (see renderRegion) — best-effort upload. */
      if (out.atGlance) {
        const jpgPath = MONTH_KEY + '/jpg/' + slug + '-at-a-glance.jpg';
        const { error: jErr } = await sb.storage.from(BUCKET).upload(jpgPath, out.atGlance, {
          contentType: 'image/jpeg', upsert: true, cacheControl: '3600',
        });
        if (jErr) console.warn('  at-a-glance jpg upload failed for ' + slug + ': ' + jErr.message);
      }
      return { buf: out.pdf, path };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        console.log(label + ' attempt ' + attempt + ' failed (' +
          (err && err.message || err) + ') — retrying in 5s…');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  throw lastErr;
}

/* One-month retention: keep only the current month folder, prune
   everything older. Tighter than the original two-month plan because
   the rendered lite PDFs run ~10 MB each and even a single month of
   the cache pushes against Supabase's 1 GB free-tier ceiling. The
   admin keeps off-site backups (Drive / Slack channel) if a prior
   month is ever needed. Called EARLY (after the first successful upload,
   so a replacement exists) to avoid the two-months-at-once peak, plus
   once more at the tail as a backstop. Idempotent — a no-op once the
   only remaining folder is the current month. */
async function cleanupOldMonths(sb) {
  const { data: top, error } = await sb.storage.from(BUCKET).list('', { limit: 100 });
  if (error || !Array.isArray(top)) return { deleted: 0 };
  const months = top
    .filter(it => /^\d{4}-\d{2}$/.test(it.name))
    .map(it => it.name)
    .sort()
    .reverse();
  const keep     = new Set(months.slice(0, 1));
  const toDelete = months.filter(m => !keep.has(m));

  let deleted = 0;
  for (const month of toDelete) {
    const paths = [];
    for (const sub of ['', '/lite', '/jpg']) {
      const { data } = await sb.storage.from(BUCKET).list(month + sub, { limit: 200 });
      if (Array.isArray(data)) {
        for (const f of data) {
          if (f && f.name && f.id) paths.push(month + sub + '/' + f.name);
        }
      }
    }
    if (paths.length) {
      const { error: delErr } = await sb.storage.from(BUCKET).remove(paths);
      if (!delErr) deleted += paths.length;
    }
  }
  return { deleted, kept: Array.from(keep) };
}

/* Auto-populate the Research Links folder in documents_state with one
   item per region that rendered successfully this run. Only the four
   region subsections (rl-capital / rl-qld / rl-nsw / rl-vicwatas) get
   touched — "rl-others" stays user-managed.
   The whole items list per subsection is REPLACED each month so the
   page always shows the latest edition's links + nothing stale. */
async function updateResearchLinks(sb, successfulFullSlugs) {
  const successSet  = new Set(successfulFullSlugs);
  const editionLbl  = formatMonthLabel();
  const today       = formatTodayDMY();

  const { data: row, error: fetchErr } = await sb
    .from('documents_state')
    .select('id, payload')
    .eq('id', 1)
    .maybeSingle();
  if (fetchErr || !row) {
    console.warn('Research Links update skipped — could not read documents_state' +
                 (fetchErr ? ' (' + fetchErr.message + ')' : ''));
    return;
  }

  const payload  = row.payload || {};
  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  const rlSec    = sections.find(s => s && s.id === 'research-links');
  if (!rlSec) {
    console.warn('Research Links update skipped — no "research-links" section in documents_state');
    return;
  }

  /* Banner above the folder shows whatever the renderer last set. */
  rlSec.currentEdition = editionLbl;

  rlSec.subsections = (rlSec.subsections || []).map(sub => {
    const slugList = RESEARCH_LINKS_BY_SUB[sub && sub.id];
    if (!slugList) return sub;   // leave rl-others (or anything custom) alone
    const items = slugList
      .filter(s => successSet.has(s))
      .map(s => ({
        title:  slugToTitle(s),
        url:    publicPdfUrl(s),
        status: 'approved',
        date:   today,
      }));
    return { ...sub, items };
  });

  /* "Other" folder — SURGICAL updates only (the folder itself stays
     user-managed; we never replace its items list). The National +
     Commercial report PDFs are rendered by this same run, so their two
     cards get re-pointed at this month's PDF + stamped with today's date.
     Matched by explicit title patterns so "National Property Clock"
     (Clock-Save-managed) and any custom cards are never touched. */
  const OTHERS_RENDERED = [
    { slug: 'national',   title: /national\s+report/i },
    { slug: 'commercial', title: /commercial\s+report/i },
  ];
  const others = (rlSec.subsections || []).find(s => s && s.id === 'rl-others');
  if (others && Array.isArray(others.items)) {
    for (const { slug, title } of OTHERS_RENDERED) {
      if (!successSet.has(slug)) continue;   // render failed → keep the old link/date
      const item = others.items.find(it => it && title.test(it.title || ''));
      if (!item) { console.warn('  rl-others: no card matching ' + title + ' — skipped'); continue; }
      item.url  = publicPdfUrl(slug);
      item.date = today;
    }
  }

  const { error: writeErr } = await sb
    .from('documents_state')
    .update({ payload, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (writeErr) {
    console.warn('Research Links update failed: ' + writeErr.message);
    return;
  }
  const totalItems = rlSec.subsections.reduce((n, s) => n + (s.items ? s.items.length : 0), 0);
  console.log('Research Links updated → ' + editionLbl + ' (' + totalItems + ' links across 4 subsections)');
}


async function main() {
  requireEnv();

  const session = await signInService();
  const sb      = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
    ],
  });

  /* Total = (region slugs × 2 for lite/full) + (research slugs × 1).
     Research reports are full-only — they don't have a lite preview. */
  const total   = (REGION_SLUGS.length * 2) + RESEARCH_REPORT_SLUGS.length;
  let   done    = 0;
  let   ok      = 0;
  const failed  = [];
  /* Track which slugs' FULL PDFs uploaded successfully — those are the
     ones that get linked from Research Links. (Lite PDFs are rendered
     and stored but not surfaced in the Documents page.) */
  const successfulFullSlugs = [];
  let   earlyPruned = false;   /* prune prior months once, right after the first upload */

  console.log('Rendering ' + total + ' PDFs into ' + BUCKET + '/' + MONTH_KEY + '/…\n');

  /* Build the iteration list — every (slug, lite) pair we need to
     render. Research reports skip the lite=true iteration. */
  const renderTargets = [];
  for (const slug of REGION_SLUGS) {
    renderTargets.push({ slug, lite: false });
    renderTargets.push({ slug, lite: true  });
  }
  for (const slug of RESEARCH_REPORT_SLUGS) {
    renderTargets.push({ slug, lite: false });
  }

  try {
    for (const { slug, lite } of renderTargets) {
      done++;
      const label = '(' + done + '/' + total + ') ' + slug + (lite ? ' (lite)' : ' (full)');
      const t0    = Date.now();
      try {
        const { buf, path } = await renderAndUploadWithRetry(browser, sb, slug, lite, session, label);
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(label + ' → ' + path + '  (' + dt + 's, ' + Math.round(buf.length / 1024) + ' KB)');
        ok++;
        if (!lite) successfulFullSlugs.push(slug);
        /* Prune prior months as soon as the FIRST new file is safely up. On a
           month rollover this stops the bucket from briefly holding two full
           months (~1.1 GB — over the 1 GB free cap) at the tail of the run.
           Safe because a replacement now exists, and the tools fall back to
           live render for anything not yet re-uploaded. The post-loop prune
           is the backstop if this attempt fails. */
        if (!earlyPruned) {
          earlyPruned = true;
          try {
            const pr = await cleanupOldMonths(sb);
            if (pr.deleted) console.log('  early-pruned ' + pr.deleted + ' file(s) from prior month(s); kept ' + (pr.kept || []).join(', '));
          } catch (e) {
            console.warn('  early prune skipped (' + (e && e.message || e) + ') — will retry at end');
          }
        }
      } catch (err) {
        console.error(label + ' FAILED after 2 attempts: ' + (err && err.message || err));
        failed.push(slug + (lite ? ' (lite)' : ' (full)'));
      }
    }

    console.log('\nUploaded ' + ok + ' of ' + total + ' files.');

    if (ok > 0) {
      console.log('Pruning old months (backstop)…');
      const r = await cleanupOldMonths(sb);
      if (r.deleted) console.log('  pruned ' + r.deleted + ' file(s)');
      if (r.kept)    console.log('  kept months: ' + r.kept.join(', '));

      console.log('Updating Research Links in documents_state…');
      await updateResearchLinks(sb, successfulFullSlugs);
    }

    if (failed.length) {
      console.error('\nFailed:\n  • ' + failed.join('\n  • '));
      process.exit(1);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Renderer failed:', err);
  process.exit(1);
});
