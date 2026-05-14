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
// Retention: at the tail of every successful run, prune anything outside
// the current calendar month so the bucket never exceeds one month's
// worth of files (~750 MB at current sizes — keeps us under Supabase's
// 1 GB free-tier ceiling). The admin keeps off-site backups elsewhere.
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

/* PDF page size — matches the design's 4:3 ratio so each captured
   1200×900 page slots into one PDF page edge-to-edge. 297mm wide is
   A4 landscape's long side, so most viewers display at familiar size. */
const PDF_WIDTH_MM  = 297;
const PDF_HEIGHT_MM = 222.75;

/* Region slugs — copied from REGION_MANIFEST in tools/online-reports.html.
   If a region is added/renamed in the manifest, mirror the change here. */
const REGION_SLUGS = [
  // Capitals
  'sydney', 'melbourne', 'brisbane', 'adelaide',
  'perth', 'hobart', 'canberra', 'darwin',
  // QLD regional
  'mackay', 'bundaberg', 'ipswich', 'rockhampton', 'gladstone',
  'cairns', 'townsville', 'sunshine-coast', 'toowoomba', 'gold-coast',
  // NSW regional
  'albury', 'central-coast', 'coffs-harbour', 'dubbo', 'orange',
  'port-macquarie', 'newcastle', 'tamworth', 'wagga-wagga', 'wollongong',
  // VIC / WA / TAS regional
  'ballarat', 'bendigo', 'geelong', 'wodonga', 'mildura',
  'rockingham', 'bunbury', 'launceston',
];

const MONTH_KEY = (() => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
})();

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

    const url = APP_URL.replace(/\/$/, '') +
      '/tools/online-reports.html?region=' + encodeURIComponent(slug) +
      '&exportMode=1' + (lite ? '&lite=1' : '');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });

    /* The page sets PPA_LIVE_BOOT_DONE = true once liveBoot + charts
       have finished rendering. 90s is the same hard timeout the
       in-page iframe export uses. */
    await page.waitForFunction(
      () => window.PPA_LIVE_BOOT_DONE === true,
      { timeout: 90000, polling: 200 }
    );

    /* Force fonts to load + settle. Without this, glyphs sometimes
       render with the fallback face on first paint. */
    await page.evaluate(() => document.fonts && document.fonts.ready);

    /* Reset zoom + hide chrome — the in-page exporter does the same.
       The @media print CSS already hides .pager / .ct-panel /
       .side-toc but we belt-and-brace here in case the print rule
       doesn't apply (Puppeteer's page.pdf uses print emulation by
       default, but be explicit). */
    await page.evaluate(() => {
      document.body.style.zoom = '1';
      document.body.classList.remove('edit-mode', 'show-grid');
      ['.pager', '#side-toc', '#ct-panel', '#pdf-overlay'].forEach(sel => {
        const el = document.querySelector(sel);
        if (el) el.style.display = 'none';
      });
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

    /* Native PDF. The existing @media print CSS handles page breaks
       (section.page { page-break-after: always }) and background
       colour preservation. We override the @page size to 297×222.75mm
       so the 4:3 design fills the page edge-to-edge. */
    return await page.pdf({
      width:           PDF_WIDTH_MM + 'mm',
      height:          PDF_HEIGHT_MM + 'mm',
      printBackground: true,
      margin:          { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: false,
    });
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
      const buf  = await renderRegion(browser, slug, lite, session);
      const path = await uploadPdf(sb, slug, lite, buf);
      return { buf, path };
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
   month is ever needed. */
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
    for (const sub of ['', '/lite']) {
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

  const total   = REGION_SLUGS.length * 2;
  let   done    = 0;
  let   ok      = 0;
  const failed  = [];

  console.log('Rendering ' + total + ' PDFs into ' + BUCKET + '/' + MONTH_KEY + '/…\n');

  try {
    for (const slug of REGION_SLUGS) {
      for (const lite of [false, true]) {
        done++;
        const label = '(' + done + '/' + total + ') ' + slug + (lite ? ' (lite)' : ' (full)');
        const t0    = Date.now();
        try {
          const { buf, path } = await renderAndUploadWithRetry(browser, sb, slug, lite, session, label);
          const dt = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(label + ' → ' + path + '  (' + dt + 's, ' + Math.round(buf.length / 1024) + ' KB)');
          ok++;
        } catch (err) {
          console.error(label + ' FAILED after 2 attempts: ' + (err && err.message || err));
          failed.push(slug + (lite ? ' (lite)' : ' (full)'));
        }
      }
    }

    console.log('\nUploaded ' + ok + ' of ' + total + ' files.');

    if (ok > 0) {
      console.log('Pruning old months…');
      const r = await cleanupOldMonths(sb);
      if (r.deleted) console.log('  pruned ' + r.deleted + ' file(s)');
      if (r.kept)    console.log('  kept months: ' + r.kept.join(', '));
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
