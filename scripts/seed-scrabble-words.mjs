// =============================================================================
// scripts/seed-scrabble-words.mjs
//
// One-off seed for the public.scrabble_words dictionary table. Reads a plain-
// text word list (one word per line) and bulk-inserts rows in batches.
//
// Run once after migration 018_arena_scrabble.sql lands on the Supabase
// project. Re-running is safe — uses upsert + on-conflict-do-nothing, so
// existing rows are skipped.
//
// Usage:
//   1. Drop your word list (one UPPERCASE word per line) at:
//        data/scrabble-words.txt
//      SOWPODS (≈270k words) is the international Scrabble standard. The
//      official copy is licensed by Collins; community-mirrored copies are
//      widely available — pick one that matches the dialect you want to
//      allow. TWL06 (≈178k words) is the North American alternative.
//
//   2. Set the env vars Supabase needs (export or use a .env loader):
//        SUPABASE_URL=https://<ref>.supabase.co
//        SUPABASE_SERVICE_ROLE_KEY=<service role key — bypasses RLS>
//
//   3. node scripts/seed-scrabble-words.mjs
//
// The service-role key bypasses RLS, which is why no INSERT policy exists on
// scrabble_words: only this script (and future seeded updates) can write.
// =============================================================================

import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const WORD_LIST_PATH = 'data/scrabble-words.txt';
const BATCH_SIZE     = 1000;   // Postgres handles much larger but 1k batches keep memory low.

function die(msg) { console.error('ERROR:', msg); process.exit(1); }

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  die('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

let raw;
try {
  raw = await readFile(WORD_LIST_PATH, 'utf8');
} catch (err) {
  die(`could not read ${WORD_LIST_PATH}: ${err.message}\n` +
      `Drop a plain-text word list (one UPPERCASE word per line) there first.`);
}

/* Normalise: uppercase, strip non-letters, dedupe, filter to >=2 chars
   (Scrabble forbids 1-letter words). We DO allow apostrophes / hyphens out
   on principle — the standard Scrabble dictionary doesn't include them, so
   they get stripped on the source side, but defensive cleaning here means
   a less-pristine input list still produces valid rows. */
const words = [...new Set(
  raw.split(/\r?\n/)
     .map(s => s.trim().toUpperCase().replace(/[^A-Z]/g, ''))
     .filter(w => w.length >= 2 && w.length <= 15)   // 15 = board side; longer can't be played anyway
)];

if (words.length === 0) die('Word list parsed empty — check the file format.');

console.log(`Parsed ${words.length.toLocaleString()} unique words. Seeding…`);

const t0 = Date.now();
let inserted = 0;

for (let i = 0; i < words.length; i += BATCH_SIZE) {
  const batch = words.slice(i, i + BATCH_SIZE).map(w => ({ word: w }));
  /* upsert with onConflict:'word' + ignoreDuplicates makes re-runs idempotent
     without touching already-present rows. */
  const { error } = await supabase
    .from('scrabble_words')
    .upsert(batch, { onConflict: 'word', ignoreDuplicates: true });
  if (error) {
    die(`batch ${i / BATCH_SIZE} failed: ${error.message}`);
  }
  inserted += batch.length;
  if ((i / BATCH_SIZE) % 20 === 0) {
    process.stdout.write(`  ${inserted.toLocaleString()} / ${words.length.toLocaleString()}\r`);
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nDone. Submitted ${inserted.toLocaleString()} rows in ${secs}s.`);

/* Quick sanity check — count the table afterwards. (Approximate via head: true
   so we don't pull the entire dictionary back.) */
const { count, error: countErr } = await supabase
  .from('scrabble_words')
  .select('*', { count: 'exact', head: true });

if (countErr) {
  console.warn('Could not read final row count:', countErr.message);
} else {
  console.log(`scrabble_words table now holds ${count.toLocaleString()} rows.`);
}
