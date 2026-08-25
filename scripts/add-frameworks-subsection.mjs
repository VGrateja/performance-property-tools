// =============================================================================
// add-frameworks-subsection.mjs — give Frameworks a real home in the Documents
// tool's Strategies folder.
//
// Saskia 2026-08-25: "don't forget to add in the frameworks to their tab". The
// Strategies & Frameworks view splits on item kind ('strategy' left,
// 'framework' right), but the folder had only a Strategies subsection — so
// there was nowhere to PUT a framework, in the UI or in the data. This adds an
// empty subsection with kind 'framework'. View mode is unchanged until items
// exist (the column keeps its empty state); EDIT mode now offers it as a place
// to add them.
//
// Idempotent: re-running is a no-op once the subsection is present.
//
// Usage:
//   node scripts/add-frameworks-subsection.mjs            # dry run
//   node scripts/add-frameworks-subsection.mjs --write
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } } catch {}

const WRITE = process.argv.includes('--write');
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY missing (.env)'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const { data, error } = await sb.from('documents_state').select('payload').eq('id', 1).limit(1);
if (error) { console.error(error.message); process.exit(1); }

const payload = data && data[0] && data[0].payload;
const sec = payload && (payload.sections || []).find(s => s && s.id === 'strategies');
let done = false;

if (!sec) {
  console.error('No "strategies" section in documents_state — stopping rather than guessing.');
  process.exitCode = 1;
} else {
  sec.subsections = sec.subsections || [];
  const already = sec.subsections.find(x => x && (x.id === 'frameworks-sub' || x.kind === 'framework'));
  if (already) {
    console.log('Frameworks subsection already present (' + already.id + ', ' +
      ((already.items || []).length) + ' item(s)) — nothing to do.');
  } else {
    sec.subsections.push({ id: 'frameworks-sub', title: 'Frameworks', kind: 'framework', items: [] });
    done = true;
    console.log('Will add: { id: "frameworks-sub", title: "Frameworks", kind: "framework", items: [] }');
    console.log('  strategies folder subsections after: ' +
      sec.subsections.map(s => s.title + '(' + ((s.items || []).length) + ')').join(', '));
  }
}

if (done) {
  if (!WRITE) {
    console.log('\nDry run. Re-run with --write to apply.');
  } else {
    const { error: e } = await sb.from('documents_state').update({ payload }).eq('id', 1);
    if (e) { console.error('update: ' + e.message); process.exitCode = 1; }
    else console.log('\nWritten. Frameworks now has a home; add items from the Documents tool in edit mode.');
  }
}
