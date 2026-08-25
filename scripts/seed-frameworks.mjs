// =============================================================================
// seed-frameworks.mjs — put the five Frameworks into the Documents tool so they
// appear in the Strategies & Frameworks tab and can be edited in place.
//
// Titles taken from the content sheet's Category = Framework rows. URLS ARE
// LEFT BLANK ON PURPOSE — Van is adding the Working Doc and PDF links himself
// through the tool's edit mode (the Working Doc URL field was added for this).
//
// An item with no url renders as an un-clickable card in the grid and is
// skipped by the flat view list, so a blank row is visible to editors without
// dangling a dead link in front of staff.
//
// Idempotent: matches on title, adds only what is missing, never overwrites a
// url or date someone has already entered.
//
// ⚠ documents_state is SHARED WITH PRODUCTION — this appears on the live hub
// immediately. There is no staging copy of Documents content.
//
// Usage:
//   node scripts/seed-frameworks.mjs            # dry run
//   node scripts/seed-frameworks.mjs --write
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } } catch {}

const WRITE = process.argv.includes('--write');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY missing (.env)'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co', KEY, { auth: { persistSession: false } });

/* Category = Framework, in the sheet's own order. */
const FRAMEWORKS = [
  'Established Residential Property',
  'Wholesale Residential Property',
  'Established Commercial Property',   /* removed 2026-08-25 then restored: the
                                          reason it looked wrong was a captured-link
                                          bug, not the entry itself */
  'Homebuying',
  'Portfolio Reviews',
];

const { data, error } = await sb.from('documents_state').select('payload').eq('id', 1).limit(1);
if (error) { console.error(error.message); process.exit(1); }

const payload = data && data[0] && data[0].payload;
const sec = payload && (payload.sections || []).find(s => s && s.id === 'strategies');
if (!sec) { console.error('No "strategies" section — stopping rather than guessing.'); process.exit(1); }

let sub = (sec.subsections || []).find(x => x && (x.id === 'frameworks-sub' || x.kind === 'framework'));
if (!sub) {
  sub = { id: 'frameworks-sub', title: 'Frameworks', kind: 'framework', items: [] };
  (sec.subsections = sec.subsections || []).push(sub);
  console.log('Frameworks subsection created');
}
sub.items = sub.items || [];

const have = new Set(sub.items.map(i => String(i.title || '').trim().toLowerCase()));
const added = [];
for (const title of FRAMEWORKS) {
  if (have.has(title.toLowerCase())) continue;
  /* status 'approved' so the dot is not a warning colour; url/docUrl blank for
     Van to fill. Same shape as the strategy items already in this folder. */
  sub.items.push({ title, url: '', docUrl: '', slidesUrl: '', status: 'approved', date: '' });
  added.push(title);
}

console.log('\nFrameworks subsection now holds ' + sub.items.length + ' item(s):');
sub.items.forEach(i => console.log('   ' + (i.title || '(untitled)').padEnd(36) +
  (i.url ? 'PDF set' : 'no PDF') + ' · ' + (i.docUrl ? 'working doc set' : 'no working doc')));
console.log('\nTo add: ' + (added.length ? added.join(', ') : 'nothing — all present'));

if (!added.length) { console.log('\nNothing to do.'); }
else if (!WRITE) {
  console.log('\nDry run. Re-run with --write to apply.');
  console.log('NOTE: documents_state is shared with PRODUCTION — this shows on the live hub at once.');
} else {
  const { error: e } = await sb.from('documents_state').update({ payload }).eq('id', 1);
  if (e) { console.error('update: ' + e.message); process.exitCode = 1; }
  else console.log('\nWritten. Add the links in the Documents tool: Strategies & Frameworks → edit mode.');
}
