// =============================================================================
// sync-doc-dates.mjs — auto-update "last updated" dates on the Documents page
// (whitepapers-strategies.html) from the FILES the cards link to.
//
// For every card in documents_state whose url (or a strategy's slidesUrl)
// points at the GCS-backed docs.performanceproperty.com.au bucket, HEAD the
// file, read its Last-Modified header, and stamp the card's date (DD/MM/YYYY,
// Sydney time) when it differs. Strategy cards use the NEWER of doc + slides.
//
// Covers the hand-uploaded external files (Whitepapers, Strategies, plus any
// stray GCS card in Research Links). Cards hosted on Supabase storage are
// managed by their own flows (regionals + national/commercial by the render
// action; the Clock PDF by Clock Save) and are skipped here.
//
// Runs daily via .github/workflows/sync-doc-dates.yml (+ manual dispatch).
// Dry-run by DEFAULT (prints what would change); --write applies.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const URL_  = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const sb = createClient(URL_, KEY, { auth: { persistSession: false } });

const DOC_HOST = 'docs.performanceproperty.com.au';
const isDocUrl = u => { try { return new URL(u).hostname === DOC_HOST; } catch { return false; } };

/* Last-Modified of a file, or null (missing header / 404 / network error —
   never fatal, the card just keeps its current date). */
async function lastModified(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!res.ok) { console.warn('  ! HTTP ' + res.status + ' — ' + url); return null; }
    const lm = res.headers.get('last-modified');
    return lm ? new Date(lm) : null;
  } catch (e) { console.warn('  ! HEAD failed (' + (e && e.message || e) + ') — ' + url); return null; }
}

/* DD/MM/YYYY in Sydney time — matches the format the Documents tool stores. */
function fmtSydney(d) {
  const p = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return g('day') + '/' + g('month') + '/' + g('year');
}

const { data: row, error } = await sb.from('documents_state').select('id, payload').eq('id', 1).maybeSingle();
if (error || !row || !row.payload) { console.error('documents_state read failed' + (error ? ': ' + error.message : '')); process.exit(1); }

const payload = row.payload;
let checked = 0, changed = 0;
const changes = [];

for (const sec of (payload.sections || [])) {
  const subs = Array.isArray(sec.subsections) ? sec.subsections : [{ items: sec.items }];
  for (const sub of subs) {
    for (const item of (sub && Array.isArray(sub.items) ? sub.items : [])) {
      const urls = [item.url, item.slidesUrl].filter(u => u && isDocUrl(u));
      if (!urls.length) continue;
      checked++;
      // Newest of the card's files (a strategy's doc OR slides being re-uploaded
      // both count as "updated").
      let newest = null;
      for (const u of urls) { const lm = await lastModified(u); if (lm && (!newest || lm > newest)) newest = lm; }
      if (!newest) continue;
      const want = fmtSydney(newest);
      if (item.date !== want) {
        changes.push('  ' + (sec.id || '?') + ' › "' + (item.title || '?') + '": ' + (item.date || '(none)') + ' → ' + want);
        item.date = want;
        changed++;
      }
    }
  }
}

console.log('Checked ' + checked + ' bucket-hosted card(s); ' + changed + ' date change(s).');
changes.forEach(c => console.log(c));

if (!changed) process.exit(0);
if (!WRITE) { console.log('\nDry run. Re-run with --write to apply.'); process.exit(0); }

const { error: writeErr } = await sb.from('documents_state')
  .update({ payload, updated_at: new Date().toISOString() }).eq('id', 1);
if (writeErr) { console.error('documents_state update failed: ' + writeErr.message); process.exit(1); }
console.log('✓ Dates updated in documents_state.');
