/* =============================================================================
   Google Slides change monitor  (migration 098)

   For every Google file referenced by public.gslides_links, work out whether it
   changed since we last looked and — when it did — WHICH PAGES changed. Results
   land in public.gslides_files; the hub reads them to put a red mark on the hub
   slide the link is attached to.

   HOW IT READS GOOGLE — no new credential:
   it calls the Apps Script web app that tools/presentation.html already uses
   (SLIDES_IMPORT_URL). Two modes:
     ?id=<fileId>&mode=snapshot -> { _meta:{ title, slideCount, revisionId }, slides:[{id}] }   ~2.5s
     ?id=<fileId>               -> { _meta:{…}, slides:[{ elements[], background }] }          ~5-9s
   The snapshot call is the cheap GATE: unchanged revisionId => nothing to do.
   Only when the revision moves do we pull the (expensive) structural JSON and
   fingerprint each page.

   VERIFIED 2026-08-06 (scratch/gslides-volatility.mjs): two identical structural
   fetches of the same deck produced 0/14 differing slides — the payload carries
   no signed urls, no timestamps, no churn inside slides[]. Only _meta.generated
   moves, and that is outside the hashed region. So a plain hash of a slide's
   JSON is a sound fingerprint; no field-stripping needed.

   FAILURE POLICY — a monitor that cries wolf gets ignored, and one that
   mistakes an outage for "everything changed" is worse. So:
     - non-JSON / HTTP error / deck-open error => TRANSIENT. Record error_text,
       touch nothing else, retry next run. (The Apps Script intermittently
       serves an HTML 404 that succeeds on retry — reproduced twice.)
     - a file seen for the FIRST time is seeded SILENTLY (no change flagged):
       we have no "before" to compare against, so flagging would be noise.
     - a zero-slide or malformed structural response is never committed.

   Usage:
     node scripts/gslides-watch.mjs              # dry run — reports, writes nothing
     node scripts/gslides-watch.mjs --write      # apply
     node scripts/gslides-watch.mjs --write --file=<id>   # just one file
   ============================================================================= */
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

try {
  if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const WRITE   = process.argv.includes('--write');
const ONLY    = (process.argv.find(a => a.startsWith('--file=')) || '').split('=')[1] || null;
const SB_URL  = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const SB_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

/* The Slides reader. This runs server-side (GitHub Actions), so unlike the
   browser it CAN hold the shared secret and call the Apps Script directly —
   no Edge Function hop needed.

   BOTH values come from secrets, with NO hard-coded fallback on purpose: this
   repo is public, and the endpoint URL sitting in it is half of what made the
   reader world-readable in the first place. GitHub Actions gets them from repo
   secrets; locally they come from .env (gitignored). */
const EXEC   = process.env.SLIDES_IMPORT_URL || '';
const SECRET = process.env.SLIDES_SHARED_SECRET || '';
if (!EXEC) {
  console.error('Missing SLIDES_IMPORT_URL (repo secret in CI, .env locally) — cannot reach the Slides reader.');
  process.exit(1);
}

const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 16);
/* key-sorted stringify so an incidental key-order change can't read as an edit */
const canon = v => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* one fetch with retries — the Apps Script intermittently returns an HTML error
   page for a deck that succeeds moments later, so a single failure means nothing */
async function callScript(fileId, qs, tries = 3) {
  let lastErr = '';
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(1500 * i);
    try {
      const res = await fetch(EXEC + '?id=' + encodeURIComponent(fileId) + qs
        + (SECRET ? '&k=' + encodeURIComponent(SECRET) : ''), { redirect: 'follow' });
      const txt = await res.text();
      let j = null; try { j = JSON.parse(txt); } catch {}
      if (!j) { lastErr = 'non-JSON response (HTTP ' + res.status + ')'; continue; }
      if (j.error) return { err: String(j.error).slice(0, 300), permanent: /could not open/i.test(j.error) };
      return { json: j };
    } catch (e) { lastErr = String(e && e.message || e).slice(0, 200); }
  }
  return { err: lastErr || 'unreachable' };
}

/* a human-meaningful label for a page: the biggest piece of text on it */
function pageTitle(slide) {
  const els = (slide && slide.elements) || [];
  let best = null;
  for (const el of els) {
    const t = String(el && el.text || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const size = Number(el.fontSize) || 0;
    if (!best || size > best.size || (size === best.size && (Number(el.y) || 0) < best.y)) {
      best = { text: t, size, y: Number(el.y) || 0 };
    }
  }
  return best ? best.text.slice(0, 70) : '';
}

function diffPages(prevHashes, prevOrder, nextHashes, nextOrder, titles) {
  const out = [];
  const prevSet = new Set(prevOrder), nextSet = new Set(nextOrder);
  nextOrder.forEach((oid, i) => {
    const title = titles[oid] || '';
    if (!prevSet.has(oid)) { out.push({ objectId: oid, index: i + 1, title, kind: 'added' }); return; }
    if (prevHashes[oid] !== nextHashes[oid]) { out.push({ objectId: oid, index: i + 1, title, kind: 'edited' }); return; }
    if (prevOrder.indexOf(oid) !== i) out.push({ objectId: oid, index: i + 1, title, kind: 'moved' });
  });
  prevOrder.forEach((oid, i) => {
    if (!nextSet.has(oid)) out.push({ objectId: oid, index: i + 1, title: titles[oid] || '', kind: 'removed' });
  });
  /* a pure reorder reports every shifted page; that is honest but noisy, so an
     insert/delete that merely pushes the tail down is collapsed to the real edit */
  const structural = out.filter(c => c.kind !== 'moved');
  return (structural.length && out.length - structural.length > 2) ? structural : out;
}

(async () => {
  const { data: links, error: le } = await sb.from('gslides_links').select('file_id,scope,deck_key,slide_key,page_id');
  if (le) { console.error('read gslides_links failed:', le.message); process.exit(1); }
  let fileIds = [...new Set((links || []).map(l => l.file_id))].filter(Boolean);
  if (ONLY) fileIds = fileIds.filter(f => f === ONLY);
  console.log((WRITE ? 'APPLY' : 'DRY RUN') + ' — ' + (links || []).length + ' link(s) across ' + fileIds.length + ' Google file(s)');
  if (!fileIds.length) { console.log('Nothing linked yet — attach a Google Slides link to a hub slide first.'); return; }

  const { data: prevRows } = await sb.from('gslides_files').select('*').in('file_id', fileIds);
  const prev = Object.fromEntries((prevRows || []).map(r => [r.file_id, r]));

  const nowIso = new Date().toISOString();
  let checked = 0, changed = 0, seeded = 0, errored = 0, gated = 0;

  for (const fileId of fileIds) {
    const usedBy = (links || []).filter(l => l.file_id === fileId).length;
    const before = prev[fileId] || null;
    const tag = '  ' + fileId.slice(0, 14) + '… (' + usedBy + ' link' + (usedBy === 1 ? '' : 's') + ')';

    // ── cheap gate ──
    const snap = await callScript(fileId, '&mode=snapshot');
    if (snap.err) {
      errored++;
      console.log(tag + ' ERROR: ' + snap.err + (snap.permanent ? '  [permanent — link is dead]' : '  [transient — will retry]'));
      if (WRITE) await sb.from('gslides_files').upsert({ file_id: fileId, error_text: snap.err, error_at: nowIso, last_checked_at: nowIso }, { onConflict: 'file_id' });
      continue;
    }
    const meta = snap.json._meta || {};
    const order = (snap.json.slides || []).map(s => s.id).filter(Boolean);
    if (!order.length) { errored++; console.log(tag + ' ERROR: snapshot returned no pages — not committing'); continue; }
    checked++;

    const revision = meta.revisionId || '';
    if (before && revision && before.revision_id === revision) {
      gated++;
      console.log(tag + ' unchanged (rev ' + revision + ')');
      if (WRITE) await sb.from('gslides_files').update({ last_checked_at: nowIso, error_text: null, error_at: null }).eq('file_id', fileId);
      continue;
    }

    // ── revision moved (or first sight): pull structure and fingerprint pages ──
    const full = await callScript(fileId, '');
    if (full.err || !full.json || !Array.isArray(full.json.slides) || !full.json.slides.length) {
      errored++;
      console.log(tag + ' ERROR fetching structure: ' + (full.err || 'empty') + '  [not committing]');
      if (WRITE) await sb.from('gslides_files').upsert({ file_id: fileId, error_text: (full.err || 'empty structure'), error_at: nowIso, last_checked_at: nowIso }, { onConflict: 'file_id' });
      continue;
    }
    const slides = full.json.slides;
    if (slides.length !== order.length) {
      /* the deck was edited BETWEEN our two calls — bail rather than pair the
         wrong content to the wrong page id; next run gets a consistent read */
      errored++;
      console.log(tag + ' SKIP: page count moved mid-read (' + order.length + ' -> ' + slides.length + ')');
      continue;
    }

    const hashes = {}, titles = {};
    order.forEach((oid, i) => { hashes[oid] = sha(canon(slides[i])); titles[oid] = pageTitle(slides[i]); });
    const stamp = sha(order.map(o => hashes[o]).join('|'));

    if (!before) {
      seeded++;
      console.log(tag + ' seeded silently — ' + order.length + ' pages, "' + (meta.title || '?') + '"');
      if (WRITE) await sb.from('gslides_files').upsert({
        file_id: fileId, google_title: meta.title || null, slide_count: order.length, revision_id: revision,
        content_stamp: stamp, page_hashes: hashes, page_order: order, page_titles: titles,
        changed_pages: [], last_checked_at: nowIso, last_changed_at: null, error_text: null, error_at: null,
      }, { onConflict: 'file_id' });
      continue;
    }

    const changes = diffPages(before.page_hashes || {}, before.page_order || [], hashes, order, titles);
    if (!changes.length && before.content_stamp === stamp) {
      console.log(tag + ' revision moved but content identical (rev ' + revision + ') — no flag');
      if (WRITE) await sb.from('gslides_files').update({ revision_id: revision, google_title: meta.title || null, last_checked_at: nowIso, error_text: null, error_at: null }).eq('file_id', fileId);
      continue;
    }

    changed++;
    console.log(tag + ' CHANGED — ' + changes.length + ' page(s): '
      + changes.slice(0, 6).map(c => '#' + c.index + ' ' + c.kind + (c.title ? ' "' + c.title.slice(0, 28) + '"' : '')).join(', ')
      + (changes.length > 6 ? ' …' : ''));
    if (WRITE) await sb.from('gslides_files').upsert({
      file_id: fileId, google_title: meta.title || null, slide_count: order.length, revision_id: revision,
      content_stamp: stamp, page_hashes: hashes, page_order: order, page_titles: titles,
      changed_pages: changes, last_checked_at: nowIso, last_changed_at: nowIso, error_text: null, error_at: null,
    }, { onConflict: 'file_id' });
  }

  console.log('\n' + (WRITE ? 'Applied' : 'Would apply') + ': ' + checked + ' checked, ' + gated + ' unchanged, '
    + changed + ' changed, ' + seeded + ' seeded, ' + errored + ' errored.');
  if (!WRITE) console.log('Re-run with --write to persist.');
  /* Errors are reported but never fail the run: a transient Apps Script blip is
     normal. A file erroring for DAYS is the real signal — visible as a stale
     last_checked_at + a persistent error_text in gslides_files. */
})();
