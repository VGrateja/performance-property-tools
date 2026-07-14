// =============================================================================
// Garbage-collect orphaned Buying/Selling slide images.
//
// The Buying/Selling Slides editor uploads image overlays to
// `report-images/buysell/<deck>/<overlayId>.<ext>` and stores only the path in
// reports_state — but nothing deletes the file when an image is removed/replaced
// or a whole deck's edits are cleared, so orphans accumulate against the storage
// ceiling. Same design as scripts/gc-presentation-images.mjs.
//
// REFERENCE-COUNTED, not folder-based: an overlay Copy deep-clones the path
// (shares the same file), so we KEEP any object whose path appears anywhere in
// any reports_state payload (substring match) and delete only the rest. Only the
// `buysell/` prefix is ever listed/deleted, so the report editor's own images
// (report-images/<slug>/…) are never touched. Objects newer than the grace
// period are spared (in-flight uploads).
//
// Usage:
//   node scripts/gc-buysell-images.mjs            # dry run (report only)
//   node scripts/gc-buysell-images.mjs --apply    # actually delete
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (service role — reads payloads +
// removes storage objects, bypasses RLS).
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
try { if (existsSync('.env')) for (const ln of readFileSync('.env','utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g,''); } } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET       = 'report-images';
const PREFIX       = 'buysell';
const APPLY        = process.argv.includes('--apply');
const GRACE_HOURS  = Number(process.env.GC_GRACE_HOURS || 24);

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.'); process.exit(1); }
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const fmtMB = b => (b / (1024 * 1024)).toFixed(1) + ' MB';

async function listAll(prefix) {
  const out = [], PAGE = 100; let offset = 0;
  for (;;) {
    const { data, error } = await sb.storage.from(BUCKET).list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error('list "' + prefix + '": ' + error.message);
    if (!data || !data.length) break;
    for (const it of data) {
      const p = prefix ? prefix + '/' + it.name : it.name;
      if (it.id === null) out.push(...await listAll(p));
      else out.push({ path: p, size: (it.metadata && it.metadata.size) || 0, createdAt: it.created_at || it.updated_at || null });
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}
async function collectRefs() {
  let text = '';
  const { data, error } = await sb.from('reports_state').select('payload');
  if (error) throw new Error('read reports_state: ' + error.message);
  for (const r of (data || [])) text += JSON.stringify(r.payload || {});
  return { text, rows: (data || []).length };
}
async function main() {
  console.log('GC ' + BUCKET + '/' + PREFIX + (APPLY ? '  (APPLY — will delete)' : '  (dry run)'));
  console.log('Grace period: skip objects newer than ' + GRACE_HOURS + 'h\n');
  const [objects, refs] = await Promise.all([listAll(PREFIX), collectRefs()]);
  if (refs.rows === 0 && objects.length > 0) {
    console.error('Aborting: reports_state returned 0 rows but ' + PREFIX + '/ has ' + objects.length + ' object(s). Refusing to delete (safety guard).');
    process.exit(1);
  }
  const cutoff = Date.now() - GRACE_HOURS * 3600 * 1000;
  const orphans = []; let tooNew = 0;
  for (const o of objects) {
    if (refs.text.indexOf(o.path) !== -1) continue;                 // referenced → keep
    const c = o.createdAt ? Date.parse(o.createdAt) : 0;
    if (c && c > cutoff) { tooNew++; continue; }                    // in-flight → keep
    orphans.push(o);
  }
  const total = objects.reduce((s, o) => s + o.size, 0), orphB = orphans.reduce((s, o) => s + o.size, 0);
  console.log('Total objects:      ' + objects.length + '  (' + fmtMB(total) + ')');
  console.log('Referenced (keep):  ' + (objects.length - orphans.length - tooNew));
  if (tooNew) console.log('Skipped (too new):  ' + tooNew);
  console.log('Orphaned (delete):  ' + orphans.length + '  (' + fmtMB(orphB) + ')\n');
  if (!orphans.length) { console.log('Nothing to clean up.'); return; }
  for (const o of orphans.slice(0, 12)) console.log('  ' + o.path + '  (' + Math.round(o.size / 1024) + ' KB)');
  if (orphans.length > 12) console.log('  …and ' + (orphans.length - 12) + ' more');
  console.log('');
  if (!APPLY) { console.log('Dry run — re-run with --apply to remove ' + orphans.length + ' file(s) (~' + fmtMB(orphB) + ').'); return; }
  const paths = orphans.map(o => o.path); let del = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const b = paths.slice(i, i + 100);
    const { error } = await sb.storage.from(BUCKET).remove(b);
    if (error) { console.error('Delete batch failed: ' + error.message); process.exit(1); }
    del += b.length; console.log('  deleted ' + del + '/' + paths.length);
  }
  console.log('\nDone — removed ' + del + ' orphaned file(s), reclaimed ~' + fmtMB(orphB) + '.');
}
main().catch(err => { console.error('GC failed:', err); process.exit(1); });
