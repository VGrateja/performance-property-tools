// =============================================================================
// scripts/render-decks.mjs
//
// Pre-renders presentation decks to PDF so the tool's Download button can
// serve them INSTANTLY (Van 2026-08-23). Companion to render-reports.mjs and
// run by .github/workflows/render-deck-pdfs.yml, or locally:
//
//   set -a && source .env && set +a
//   node scripts/render-decks.mjs                # stale/missing decks only
//   RENDER_ALL=1 node scripts/render-decks.mjs   # force every deck (post-PUBLISH)
//   DECK_FILTER="Initial Consultation" node scripts/render-decks.mjs
//
// How it fits the cache contract (mig 114, bucket `presentation-pdfs`):
//   • one object per deck at  <deck row uuid>/<updated_at digits>.pdf
//   • the client serves a download instantly iff the exact path for the deck
//     it is showing exists; any edit bumps updated_at and misses the cache
//   • this renderer fills the cache for COMPANY decks nightly; editors'
//     export-through uploads cover private decks and freshly-edited ones
//
// Render path: the deck tool's own exporter. The deck is a JS-driven
// 1280x720 stage with live embeds — native page.pdf() can't see it — so this
// opens presentation.html as the pdf-renderer service account (a VIEWER:
// opening a deck refreshes its data in memory and can never write), hooks
// _presSaveBlob, calls downloadDeck('pdf'), and uploads the produced bytes
// with the service-role key from Node (the renderer account itself has no
// cache-write rights under RLS — only deck editors and the service role do).
//
// Why company decks only: RLS. The renderer account cannot see other users'
// private decks, and that is correct — private decks get their cache seeded
// by their own editors' export-through instead.
//
// Post-PUBLISH freshness: a deck nobody opens after a data publish keeps its
// old updated_at, so the nightly skip-if-current would leave a stale-data PDF
// in place. The PUBLISH-triggered run therefore sets RENDER_ALL=1 — same
// paths (updated_at unchanged), fresh bytes (the exporter refreshes every
// chart/table from Forge while rendering).
//
// Required env (same GitHub Secrets as render-reports):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
//   PDF_RENDERER_EMAIL, PDF_RENDERER_PASSWORD, APP_URL
// Optional: RENDER_ALL=1 · DECK_FILTER=<title substring> · DECK_LIMIT=<n>
// =============================================================================

import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY;
const PDF_RENDERER_EMAIL        = process.env.PDF_RENDERER_EMAIL;
const PDF_RENDERER_PASSWORD     = process.env.PDF_RENDERER_PASSWORD;
const APP_URL                   = (process.env.APP_URL || '').replace(/\/$/, '');
const RENDER_ALL                = process.env.RENDER_ALL === '1';
const DECK_FILTER               = process.env.DECK_FILTER || '';
const DECK_LIMIT                = Number(process.env.DECK_LIMIT || 0);

const BUCKET = 'presentation-pdfs';
const PER_DECK_TIMEOUT_MS = 8 * 60 * 1000;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, PDF_RENDERER_EMAIL, PDF_RENDERER_PASSWORD, APP_URL })) {
  if (!v) { console.error('Missing env: ' + k); process.exit(1); }
}

const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const digits = ts => String(ts).replace(/\D/g, '');

/* ── 1. the work list ──────────────────────────────────────────────────────── */
const { data: rows, error: listErr } = await svc
  .from('presentation_decks')
  .select('id, title, visibility, updated_at, payload')
  .eq('visibility', 'company')
  .order('updated_at', { ascending: false });
if (listErr) { console.error('deck list failed:', listErr.message); process.exit(1); }

let targets = [];
for (const r of rows || []) {
  const deck = (r.payload && r.payload.deck) || {};
  const slides = Array.isArray(deck.slides) ? deck.slides.length : 0;
  if (!deck.id || slides === 0) { console.log('  skip (empty): ' + r.title); continue; }
  if (DECK_FILTER && !(r.title || '').includes(DECK_FILTER)) continue;
  targets.push({ rowId: r.id, deckId: deck.id, title: r.title, updatedAt: r.updated_at, slides });
}

/* skip decks whose current render already exists (unless forced) */
if (!RENDER_ALL) {
  const keep = [];
  for (const t of targets) {
    const want = digits(t.updatedAt) + '.pdf';
    const { data: files } = await svc.storage.from(BUCKET).list(t.rowId);
    if ((files || []).some(x => x.name === want)) console.log('  current: ' + t.title);
    else keep.push(t);
  }
  targets = keep;
}
if (DECK_LIMIT > 0) targets = targets.slice(0, DECK_LIMIT);
console.log('decks to render: ' + targets.length + (RENDER_ALL ? ' (forced — post-PUBLISH refresh)' : ''));
if (!targets.length) process.exit(0);

/* ── 2. one browser, signed in once ────────────────────────────────────────── */
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'], protocolTimeout: PER_DECK_TIMEOUT_MS + 60000 });
let failures = 0;
try {
  const auth = await browser.newPage();
  await auth.goto(APP_URL + '/index.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await auth.waitForFunction('!!window.sb', { timeout: 45000 });
  const signIn = await auth.evaluate(async (e, p) => {
    const { error } = await window.sb.auth.signInWithPassword({ email: e, password: p });
    return error ? error.message : null;
  }, PDF_RENDERER_EMAIL, PDF_RENDERER_PASSWORD);
  if (signIn) { console.error('sign-in failed: ' + signIn); process.exit(1); }

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', e => console.log('    pageerror: ' + String(e.message).slice(0, 140)));
  await page.goto(APP_URL + '/tools/presentation.html', { waitUntil: 'networkidle2', timeout: 120000 });
  try {
    await page.waitForFunction("typeof _myUserId !== 'undefined' && !!_myUserId", { timeout: 30000 });
  } catch (e) {
    await page.reload({ waitUntil: 'networkidle2', timeout: 120000 });
    await page.waitForFunction("typeof _myUserId !== 'undefined' && !!_myUserId", { timeout: 60000 });
  }

  /* the artefact seam: every export leaves through _presSaveBlob */
  await page.evaluate(() => {
    window.__artefact = null;
    window._presSaveBlob = function (blob, name) {
      const fr = new FileReader();
      fr.onload = function () { window.__artefact = { b64: String(fr.result).split(',')[1], name: name, size: blob.size }; };
      fr.readAsDataURL(blob);
    };
  });

  /* ── 3. render each deck through the tool's own exporter ─────────────────── */
  for (const t of targets) {
    const started = Date.now();
    process.stdout.write('▶ ' + t.title + ' (' + t.slides + ' slides) … ');
    try {
      /* the cloud hydrate lands after identity — poll rather than peek once */
      let found = false;
      for (let i = 0; i < 30 && !found; i++) {
        found = await page.evaluate(id => typeof findDeck === 'function' && !!findDeck(id), t.deckId);
        if (!found) await new Promise(r => setTimeout(r, 1000));
      }
      if (!found) throw new Error('deck not visible to the renderer account');
      await page.evaluate(id => openDeck(id), t.deckId);
      await page.waitForFunction('!!_activeDeck', { timeout: 60000 });
      /* the on-open data refresh runs in memory (the renderer is a viewer and
         can never persist); give it a beat before exporting */
      await new Promise(r => setTimeout(r, 4000));
      await page.evaluate(() => { window.__artefact = null; });
      await page.evaluate(opts => downloadDeck('pdf', opts), { fresh: true });   /* never serve the cache to the cache */
      const deadline = Date.now() + PER_DECK_TIMEOUT_MS;
      let art = null;
      while (Date.now() < deadline) {
        art = await page.evaluate(() => window.__artefact);
        if (art) break;
        const busy = await page.evaluate(() => _presExportBusy);
        if (!busy) { await new Promise(r => setTimeout(r, 2000)); art = await page.evaluate(() => window.__artefact); break; }
        await new Promise(r => setTimeout(r, 2000));
      }
      if (!art) throw new Error('export produced nothing');

      /* upload under the row's CURRENT updated_at — if it moved mid-render
         (an editor saved), this render describes the past: skip, the next
         run catches it */
      const { data: now } = await svc.from('presentation_decks').select('updated_at').eq('id', t.rowId).single();
      if (!now || digits(now.updated_at) !== digits(t.updatedAt)) throw new Error('deck changed mid-render — skipped');
      const path = t.rowId + '/' + digits(t.updatedAt) + '.pdf';
      const bytes = Buffer.from(art.b64, 'base64');
      const { error: upErr } = await svc.storage.from(BUCKET).upload(path, bytes, { upsert: true, contentType: 'application/pdf' });
      if (upErr) throw new Error('upload: ' + upErr.message);
      /* prune superseded renders of this deck */
      const { data: files } = await svc.storage.from(BUCKET).list(t.rowId);
      const stale = (files || []).map(x => x.name).filter(n => n !== digits(t.updatedAt) + '.pdf').map(n => t.rowId + '/' + n);
      if (stale.length) await svc.storage.from(BUCKET).remove(stale);
      console.log('✓ ' + Math.round(bytes.length / 1024) + 'KB in ' + Math.round((Date.now() - started) / 1000) + 's');
    } catch (e) {
      failures++;
      console.log('✗ ' + (e && e.message ? e.message : e));
    }
    try { await page.evaluate(() => backToPicker()); } catch (_) {}
  }
} finally {
  await browser.close();
}
console.log(failures ? ('DONE with ' + failures + ' failure(s)') : 'DONE — all rendered');
process.exit(failures ? 1 : 0);
