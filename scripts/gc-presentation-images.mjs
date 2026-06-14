// =============================================================================
// Garbage-collect orphaned images in the `presentation-images` Storage bucket.
//
// Why: the presentation builder uploads image overlays to
// `presentation-images/<deckId>/<overlayId>.<ext>`, but nothing deletes them
// when a deck is deleted OR when an image is replaced/removed inside a deck —
// so orphans accumulate against the 1 GB free-tier ceiling.
//
// Safe deletion is REFERENCE-COUNTED, not folder-based: a duplicated deck keeps
// pointing at the SOURCE deck's image paths (duplicateDeck deep-copies overlay
// objects without re-uploading), so a folder whose deck was deleted can still
// be in use by a copy. We therefore KEEP any object whose storage path appears
// anywhere in any presentation payload (substring match, so signed URLs in
// o.src count too) and delete only the rest. Objects newer than the grace
// period are skipped so an in-flight upload (deck row not yet saved) is never
// reaped.
//
// Usage:
//   node scripts/gc-presentation-images.mjs            # dry run (report only)
//   node scripts/gc-presentation-images.mjs --apply    # actually delete
//
// Required env vars (GitHub Secrets):
//   SUPABASE_URL                supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY   service role — reads all deck payloads + removes
//                               storage objects (bypasses RLS)
// =============================================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET       = 'presentation-images';
const APPLY        = process.argv.includes('--apply');
const GRACE_HOURS  = Number(process.env.GC_GRACE_HOURS || 24);   // skip objects newer than this

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function fmtMB(bytes) { return (bytes / (1024 * 1024)).toFixed(1) + ' MB'; }

/* Recursively list every object in the bucket. list() returns one level at a
   time; folders come back with id === null, files with a real id + metadata. */
async function listAll(prefix = '') {
  const out  = [];
  const PAGE = 100;
  let   offset = 0;
  for (;;) {
    const { data, error } = await sb.storage.from(BUCKET).list(prefix, {
      limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error('list "' + prefix + '": ' + error.message);
    if (!data || !data.length) break;
    for (const it of data) {
      const childPath = prefix ? prefix + '/' + it.name : it.name;
      if (it.id === null) {
        out.push(...await listAll(childPath));                 // folder → recurse
      } else {
        out.push({
          path:      childPath,
          size:      (it.metadata && it.metadata.size) || 0,
          createdAt: it.created_at || it.updated_at || null,
        });
      }
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

/* Concatenate every LIVE presentation payload into one big string so a simple
   substring check covers overlay.storage, signed URLs in o.src, slide
   backgrounds, etc.

   Sources: the live per-deck table (presentation_decks) + the Library
   (presentations_state, mig 002). We deliberately do NOT count the legacy
   presentation_state blob (mig 001) — it's a dead pre-migration rollback copy
   of ALL decks, so counting it would pin images for decks that were deleted
   long ago and never let the GC free them. The per-deck rows are the source of
   truth; if a live deck needs an image, its own row references it. */
async function collectReferencedText() {
  let text = '';
  const { data: decks, error } = await sb.from('presentation_decks').select('payload');
  if (error) throw new Error('read presentation_decks: ' + error.message);
  for (const row of (decks || [])) text += JSON.stringify(row.payload || {});

  /* Library tool state (separate from the dead legacy blob). Best-effort. */
  try {
    const { data } = await sb.from('presentations_state').select('payload');
    for (const row of (data || [])) text += JSON.stringify(row.payload || {});
  } catch (_) { /* table may not exist — ignore */ }
  return text;
}

async function main() {
  console.log('GC ' + BUCKET + (APPLY ? '  (APPLY — will delete)' : '  (dry run)'));
  console.log('Grace period: skip objects newer than ' + GRACE_HOURS + 'h\n');

  const [objects, refText] = await Promise.all([listAll(), collectReferencedText()]);
  const cutoff = Date.now() - GRACE_HOURS * 3600 * 1000;

  const orphans = [];
  let tooNew = 0;
  for (const o of objects) {
    if (refText.indexOf(o.path) !== -1) continue;              // referenced → keep
    const created = o.createdAt ? Date.parse(o.createdAt) : 0;
    if (created && created > cutoff) { tooNew++; continue; }    // too new → keep (in-flight upload)
    orphans.push(o);
  }

  const totalBytes  = objects.reduce((s, o) => s + o.size, 0);
  const orphanBytes = orphans.reduce((s, o) => s + o.size, 0);

  console.log('Total objects:      ' + objects.length + '  (' + fmtMB(totalBytes) + ')');
  console.log('Referenced (keep):  ' + (objects.length - orphans.length - tooNew) + '  (' + fmtMB(totalBytes - orphanBytes) + ' incl. skipped)');
  if (tooNew) console.log('Skipped (too new):  ' + tooNew);
  console.log('Orphaned (delete):  ' + orphans.length + '  (' + fmtMB(orphanBytes) + ')\n');

  if (!orphans.length) { console.log('Nothing to clean up.'); return; }

  console.log('Sample:');
  for (const o of orphans.slice(0, 12)) console.log('  ' + o.path + '  (' + Math.round(o.size / 1024) + ' KB)');
  if (orphans.length > 12) console.log('  …and ' + (orphans.length - 12) + ' more');
  console.log('');

  if (!APPLY) {
    console.log('Dry run — nothing deleted. Re-run with --apply to remove the ' +
                orphans.length + ' orphaned file(s) (~' + fmtMB(orphanBytes) + ').');
    return;
  }

  const paths = orphans.map(o => o.path);
  let deleted = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const { error } = await sb.storage.from(BUCKET).remove(batch);
    if (error) { console.error('Delete batch failed: ' + error.message); process.exit(1); }
    deleted += batch.length;
    console.log('  deleted ' + deleted + '/' + paths.length);
  }
  console.log('\nDone — removed ' + deleted + ' orphaned file(s), reclaimed ~' + fmtMB(orphanBytes) + '.');
}

main().catch((err) => { console.error('GC failed:', err); process.exit(1); });
