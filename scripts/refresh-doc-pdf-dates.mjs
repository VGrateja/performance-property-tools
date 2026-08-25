// =============================================================================
// refresh-doc-pdf-dates.mjs — stamp each Whitepaper / Strategy / Framework card
// with its PDF's OWN last-modified date, so the date on the card tracks the file
// instead of whatever someone last typed.
//
// Van 2026-08-25: "make sure that the date in Whitepaper and Strategies auto
// updates when their PDF file has been updated."
//
// WHY SERVER-SIDE. The PDF host (docs.performanceproperty.com.au, GCS-backed)
// does return a real `last-modified` header, but sends no
// access-control-allow-origin — so a browser cannot read it. Nothing in the
// tool can do this client-side; it has to be fetched from outside the browser
// and stored. Hence this script + the workflow that runs it.
//
// It writes `pdfDate` (dd/mm/yyyy, matching the tool's format) and NEVER
// touches the hand-entered `date`. The tool shows pdfDate when present and
// falls back to `date`, so:
//   • an item with a PDF shows the file's real date, always current;
//   • an item without one (most Frameworks today) keeps its manual date;
//   • nobody's typed value is destroyed, and the editor still writes `date`.
//
// A HEAD request per item, ~20 of them, run on a schedule — not per page load.
//
// Usage:
//   node scripts/refresh-doc-pdf-dates.mjs            # dry run, shows drift
//   node scripts/refresh-doc-pdf-dates.mjs --write
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } } catch {}

const WRITE = process.argv.includes('--write');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co', KEY, { auth: { persistSession: false } });

/* Folders whose cards show a "last updated" date. research-links is excluded:
   its dates come from report_pdf_links, captured by the report tools. */
const SECTIONS = ['whitepapers', 'strategies'];

/* Format in AUSTRALIAN time, not UTC. last-modified is GMT, and Sydney runs
   +10/+11 — so a PDF uploaded during the Australian afternoon lands on the
   previous UTC day. Formatting in UTC made "Buying in Melbourne" read 24/03
   where a person had (correctly) typed 25/03. Intl handles AEST/AEDT itself. */
const AU = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: 'numeric',
});
const dmy = d => AU.format(d);   // en-AU 2-digit gives dd/mm/yyyy

async function lastModified(url) {
  try {
    /* HEAD first — no body, and GCS answers it. Some hosts refuse HEAD, so fall
       back to a ranged GET that pulls a single byte rather than a whole PDF. */
    let r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!r.ok || !r.headers.get('last-modified')) {
      r = await fetch(url, { method: 'GET', redirect: 'follow', headers: { Range: 'bytes=0-0' } });
    }
    const lm = r.headers.get('last-modified');
    if (!lm) return { err: 'no last-modified header (HTTP ' + r.status + ')' };
    const d = new Date(lm);
    if (isNaN(d)) return { err: 'unparseable last-modified: ' + lm };
    return { date: dmy(d) };
  } catch (e) { return { err: String(e.message || e).slice(0, 70) }; }
}

const { data, error } = await sb.from('documents_state').select('payload').eq('id', 1).limit(1);
if (error) { console.error(error.message); process.exit(1); }
const payload = data && data[0] && data[0].payload;
if (!payload) { console.error('no documents_state payload'); process.exit(1); }

let changed = 0, checked = 0;
const rows = [];
for (const sec of (payload.sections || [])) {
  if (!sec || SECTIONS.indexOf(sec.id) < 0) continue;
  for (const sub of (sec.subsections || [])) {
    for (const it of (sub.items || [])) {
      if (!it || !it.url) continue;
      checked++;
      const r = await lastModified(it.url);
      if (r.err) { rows.push([sec.id, it.title, '—', it.pdfDate || it.date || '—', r.err]); continue; }
      const was = it.pdfDate || '';
      if (r.date !== was) { it.pdfDate = r.date; changed++; }
      rows.push([sec.id, it.title, r.date, it.date || '—', r.date === was ? 'unchanged' : (was ? 'updated from ' + was : 'stamped')]);
    }
  }
}

const w = (s, n) => String(s).slice(0, n).padEnd(n);
console.log(w('folder', 13) + w('card', 42) + w('PDF date', 12) + w('manual', 12) + 'result');
rows.forEach(r => console.log(w(r[0], 13) + w(r[1], 42) + w(r[2], 12) + w(r[3], 12) + r[4]));
console.log('\n' + checked + ' PDFs checked · ' + changed + ' date(s) to write');

const drift = rows.filter(r => r[2] !== '—' && r[3] !== '—' && r[2] !== r[3]);
if (drift.length) {
  console.log('\n' + drift.length + ' card(s) where the typed date disagrees with the file:');
  drift.forEach(r => console.log('   ' + w(r[1], 42) + 'typed ' + r[3] + '  ->  file ' + r[2]));
}

if (!changed) { console.log('\nNothing to do.'); }
else if (!WRITE) { console.log('\nDry run. Re-run with --write to apply.'); }
else {
  const { error: e } = await sb.from('documents_state').update({ payload }).eq('id', 1);
  if (e) { console.error('update: ' + e.message); process.exitCode = 1; }
  else console.log('\nWritten.');
}
