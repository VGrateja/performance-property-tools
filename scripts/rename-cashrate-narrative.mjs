// =============================================================================
// rename-cashrate-narrative.mjs — "cash rate" -> "rate of borrowing" in the
// Buying/Selling sensitivity narrative overlays.
//
// Saskia/Kia via Van, 2026-08-25. The column header is code
// (tools/buying-selling-slides.html); THIS is the other half — the line under
// the table ("August 2026 forecasted cash rate 2.65%") is an authored text
// overlay stored per deck in reports_state.
//
// TEXT ONLY. No number changes: the ladder still shows cash rates and the
// ceiling maths still assesses at cash + margin + APRA. Van's explicit call
// after being shown that the borrowing rate is ~1.75pp higher.
//
// ⚠ reports_state is SHARED WITH PRODUCTION — every deck changes the moment
// this writes. There is no staging copy of deck content.
//
// Replacement walks the JSON and only touches STRING VALUES, so a key that
// happened to contain the phrase could never be corrupted.
//
// Usage:
//   node scripts/rename-cashrate-narrative.mjs            # dry run
//   node scripts/rename-cashrate-narrative.mjs --write
//   node scripts/rename-cashrate-narrative.mjs --write --skip-personal
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } } catch {}

const WRITE = process.argv.includes('--write');
const SKIP_PERSONAL = process.argv.includes('--skip-personal');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY missing (.env)'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co', KEY, { auth: { persistSession: false } });

/* Mirror the wording Van used when he edited the BASIS DECK (bss-melbourne-sell)
   by hand: "forecasted cash rate:" -> "forecasted Rate of Borrowing:". Title
   case regardless of the original casing, so every deck matches the column
   header exactly. Read off his edit rather than assumed — an earlier draft of
   this script used lowercase and would have left the decks inconsistent. */
const swap = s => s.replace(/cash\s+rate/gi, 'Rate of Borrowing');

let hits = 0;
function walk(v) {
  if (typeof v === 'string') { const n = swap(v); if (n !== v) hits++; return n; }
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = walk(v[k]);   // keys untouched
    return o;
  }
  return v;
}

const { data: rows, error } = await sb.from('reports_state').select('region,payload').like('region', 'bss-%');
if (error) { console.error(error.message); process.exit(1); }

const changes = [];
for (const r of rows) {
  if (SKIP_PERSONAL && r.region.includes('--')) continue;
  hits = 0;
  const next = walk(r.payload);
  if (!hits) continue;
  changes.push({ region: r.region, payload: next, hits, personal: r.region.includes('--') });
}

const personal = changes.filter(c => c.personal);
console.log('Decks with the phrase: ' + changes.length +
  (personal.length ? '  (including ' + personal.length + ' PERSONAL copy: ' + personal.map(p => p.region).join(', ') + ')' : ''));
console.log('Total string replacements: ' + changes.reduce((a, b) => a + b.hits, 0));

/* Show one before/after so the wording is checked, not assumed. */
const sample = rows.find(r => JSON.stringify(r.payload).toLowerCase().includes('cash rate'));
if (sample) {
  const m = JSON.stringify(sample.payload).match(/.{0,60}[Cc]ash [Rr]ate.{0,30}/);
  if (m) {
    console.log('\nSample (' + sample.region + ')');
    console.log('  before: …' + m[0].replace(/\\"/g, '"') + '…');
    console.log('  after : …' + swap(m[0]).replace(/\\"/g, '"') + '…');
  }
}

if (!WRITE) {
  console.log('\nDry run. Re-run with --write to apply.');
  console.log('NOTE: reports_state is shared with PRODUCTION — writing changes every deck immediately.');
} else {
  let done = 0;
  for (const c of changes) {
    const { error: e } = await sb.from('reports_state').update({ payload: c.payload }).eq('region', c.region);
    if (e) { console.error('update ' + c.region + ': ' + e.message); process.exitCode = 1; break; }
    done++;
  }
  console.log('\nUpdated ' + done + '/' + changes.length + ' decks.');
}
