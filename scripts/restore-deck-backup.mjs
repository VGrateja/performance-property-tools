#!/usr/bin/env node
/* =============================================================================
   Restore one presentation deck from the nightly backups (mig 128).

   The backups keep the last 7 nights: one slot per day of the week (Sydney
   time), each overwritten a week later by .github/workflows/backup-decks.yml.

     node scripts/restore-deck-backup.mjs
         lists every backed-up deck with the days it can be restored from
     node scripts/restore-deck-backup.mjs --deck "Stage 4" --day mon
         dry run: what the deck is now vs that night's copy
     … --write
         saves the deck's CURRENT row to scratch/deck-restores/ first, then
         puts the backup back (only if nobody saved the deck since this read).
         A deck that was deleted is re-created with its original id and owner.

   --deck takes the deck row id or part of its title (must match one deck).
   --day takes mon…sun or 1…7.

   Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (read from .env if present).
   Anyone with the deck open must reload afterwards; their unsaved copy is
   refused by the editor's save check rather than written over the restore.
   ============================================================================= */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

try {
  if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — rely on the environment */ }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const DAYS = ['', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const WRITE = process.argv.includes('--write');
const slides = (p) => (p && p.deck && Array.isArray(p.deck.slides)) ? p.deck.slides.length : 0;
const sydney = (t) => t ? new Date(t).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' }) : '—';

const { data: backups, error } = await sb.from('presentation_deck_backups')
  .select('slot, deck_id, title, owner_id, created_by, visibility, locked, payload, deck_updated_at, backed_up_at');
if (error) { console.error('read backups:', error.message); process.exit(1); }

const deckArg = arg('--deck'), dayArg = arg('--day');
if (!deckArg) {
  const byDeck = new Map();
  for (const b of backups) {
    if (!byDeck.has(b.deck_id)) byDeck.set(b.deck_id, { title: b.title, rows: [] });
    byDeck.get(b.deck_id).rows.push(b);
  }
  console.log(byDeck.size + ' deck(s) backed up:\n');
  for (const [id, d] of [...byDeck].sort((a, b) => String(a[1].title).localeCompare(String(b[1].title)))) {
    console.log(d.title + '  (' + id + ')');
    for (const b of d.rows.sort((x, y) => new Date(y.backed_up_at) - new Date(x.backed_up_at)))
      console.log('   ' + DAYS[b.slot] + '  backed up ' + sydney(b.backed_up_at) + '  · ' + slides(b.payload) + ' slides · deck last saved ' + sydney(b.deck_updated_at));
  }
  process.exit(0);
}

const slot = /^[1-7]$/.test(String(dayArg)) ? Number(dayArg) : DAYS.indexOf(String(dayArg || '').toLowerCase().slice(0, 3));
if (!(slot >= 1)) { console.error('--day must be mon…sun or 1…7'); process.exit(1); }
const q = deckArg.toLowerCase();
const ids = [...new Set(backups.filter(b => b.deck_id === deckArg || String(b.title || '').toLowerCase().includes(q)).map(b => b.deck_id))];
if (ids.length !== 1) {
  console.error(ids.length ? 'More than one deck matches "' + deckArg + '" — use the deck id:' : 'No backed-up deck matches "' + deckArg + '".');
  for (const id of ids) console.error('  ' + id + '  ' + backups.find(b => b.deck_id === id).title);
  process.exit(1);
}
const bk = backups.find(b => b.deck_id === ids[0] && b.slot === slot);
if (!bk) { console.error('No ' + DAYS[slot] + ' backup for that deck.'); process.exit(1); }

const { data: cur, error: e2 } = await sb.from('presentation_decks').select('*').eq('id', bk.deck_id).maybeSingle();
if (e2) { console.error('read deck:', e2.message); process.exit(1); }
console.log('Deck:    ' + bk.title + '  (' + bk.deck_id + ')');
console.log('Backup:  ' + DAYS[slot] + ', taken ' + sydney(bk.backed_up_at) + ' — ' + slides(bk.payload) + ' slides (deck last saved ' + sydney(bk.deck_updated_at) + ')');
console.log('Now:     ' + (cur ? slides(cur.payload) + ' slides, last saved ' + sydney(cur.updated_at) : 'DELETED — will be re-created'));
if (cur && isDeepStrictEqual(cur.payload, bk.payload)) { console.log('The deck already matches this backup — nothing to do.'); process.exit(0); }
if (!WRITE) { console.log('\nDry run — add --write to restore.'); process.exit(0); }

if (cur) {
  mkdirSync('scratch/deck-restores', { recursive: true });
  const file = 'scratch/deck-restores/' + bk.deck_id + '-before-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  writeFileSync(file, JSON.stringify(cur));
  console.log('Saved the current version to ' + file);
  const { data: upd, error: e3 } = await sb.from('presentation_decks')
    .update({ title: bk.title, payload: bk.payload })
    .eq('id', bk.deck_id).eq('updated_at', cur.updated_at).select('updated_at');
  if (e3) { console.error('restore failed:', e3.message); process.exit(1); }
  if (!upd || !upd.length) { console.error('The deck was saved by someone since this read — nothing written. Run again.'); process.exit(1); }
} else {
  const { error: e4 } = await sb.from('presentation_decks').insert({
    id: bk.deck_id, owner_id: bk.owner_id, created_by: bk.created_by, title: bk.title,
    visibility: bk.visibility, locked: !!bk.locked, payload: bk.payload });
  if (e4) { console.error('re-create failed:', e4.message); process.exit(1); }
}
console.log('Restored from the ' + DAYS[slot] + ' backup. Anyone with the deck open must reload it.');
