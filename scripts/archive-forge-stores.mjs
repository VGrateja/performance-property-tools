// =============================================================================
// archive-forge-stores.mjs — keep a dated copy of every id-keyed Forge store.
//
// WHY THIS EXISTS
// ---------------
// Most Forge data lands in `rdp_raw_series`, which is keyed by period and so
// accumulates. The id-keyed JSON stores do not: each gather upserts `id:'latest'`
// and last month's payload is gone. That is how the V3 question ran aground —
// monthly SQM vacancy and rent for Jan 2025 onward had been fetched every month
// and overwritten every month, and the only surviving copies were spreadsheets
// in somebody's Drive.
//
// SQM's series turned out to be re-fetchable from source (ingest-sqm-history),
// but most of these are not. The REA listings inside `forge_demand_inputs` are
// the clearest case: REA has no API, the figure is typed in by hand through the
// Data Forge card, and once `latest` is overwritten no source on earth can tell
// you what a market's listing count was last March.
//
// WHY ONE ARCHIVER RATHER THAN FOURTEEN EDITS
// -------------------------------------------
// Fourteen call sites write these stores — nine scripts and five places in
// `tools/data-forge.html`. Wiring each one is fourteen chances to half-wire it,
// and it would still miss anything written by hand from the browser. This reads
// whatever is in `latest` and files a dated copy beside it, so it captures every
// writer including the ones typed in by a person.
//
// SAFE BY CONSTRUCTION
// --------------------
// Adding rows to these tables is only safe because every reader now pins its id.
// That was audited first (96 call sites) and six unpinned reads were fixed in
// the same change — one of which was already returning the wrong row:
// `national-report.html` was reading `forge_arrears` with a bare `limit(1)` and
// getting `legacy-mixed-20260811` rather than `latest`. Before adding a writer
// here, re-run that audit.
//
// The archive id is `archive-YYYY-MM`, which no reader matches and no gather
// writes. A month already archived with identical content is left alone, so
// running this twice in a month is a no-op rather than a rewrite.
//
// Dry-run by DEFAULT; --write upserts. `--month=YYYY-MM` overrides the month.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co', KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');

/* The stores that overwrite. `forge_cotality` is here too: its `latest` and
   `rentvacancy` rows are the monthly Cotality drop and are overwritten the same
   way. Its `rvd_*` rows are BUILT timelines, not gathered readings, so they are
   not archived — rebuilding them is a script run, not a lost fact. */
const STORES = [
  { table: 'forge_demand_inputs', ids: ['latest'], why: 'REA listings + SQM vacancy/rents — the listings cannot be re-fetched' },
  { table: 'forge_commercial', ids: ['latest'], why: 'commercial report store' },
  { table: 'forge_industry', ids: ['latest'], why: 'industry value added' },
  { table: 'forge_population_pyramid', ids: ['latest'], why: 'population pyramid' },
  { table: 'forge_national_only', ids: ['latest'], why: 'national-only series' },
  { table: 'forge_monthly_price', ids: ['latest'], why: 'monthly median price' },
  { table: 'forge_arrears', ids: ['latest'], why: 'mortgage arrears' },
  { table: 'forge_cotality', ids: ['latest', 'rentvacancy'], why: 'the monthly Cotality drop' },
];

const argMonth = (process.argv.find(a => a.startsWith('--month=')) || '').slice(8);
/* AEST, because a gather run just after midnight UTC on the 1st still belongs to
   the month the team calls it. */
const aestMonth = () => new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 7);

let archived = 0, skipped = 0, missing = 0;
for (const store of STORES) {
  for (const id of store.ids) {
    const { data: row, error } = await sb.from(store.table).select('data,updated_at').eq('id', id).maybeSingle();
    if (error) { console.log('  ' + store.table + '/' + id + ' — read failed: ' + error.message); continue; }
    if (!row || row.data == null) { console.log('  ' + store.table + '/' + id + ' — nothing to archive'); missing++; continue; }

    /* A store that stamps its own month is archived under THAT month, not the
       month the archiver happened to run: the demand-inputs card is published
       for a month and read as that month's figures. */
    const own = row.data && typeof row.data === 'object' && typeof row.data.month === 'string' && /^\d{4}-\d{2}$/.test(row.data.month) ? row.data.month : null;
    const month = argMonth || own || aestMonth();
    const archiveId = 'archive-' + month + (id === 'latest' ? '' : '-' + id);

    const { data: prev } = await sb.from(store.table).select('data').eq('id', archiveId).maybeSingle();
    const same = prev && JSON.stringify(prev.data) === JSON.stringify(row.data);
    const size = (JSON.stringify(row.data).length / 1024).toFixed(0);
    if (same) { console.log('  ' + (store.table + '/' + id).padEnd(34) + '-> ' + archiveId.padEnd(34) + 'already current (' + size + ' kB)'); skipped++; continue; }
    console.log('  ' + (store.table + '/' + id).padEnd(34) + '-> ' + archiveId.padEnd(34) + (prev ? 'REPLACE' : 'new') + ' (' + size + ' kB)' + (own ? '   [month from payload]' : ''));
    if (!WRITE) { archived++; continue; }
    const now = new Date().toISOString();
    const { error: werr } = await sb.from(store.table)
      .upsert({ id: archiveId, data: row.data, updated_at: now, uploaded_at: now, uploaded_by: 'archive-forge-stores' }, { onConflict: 'id' });
    if (werr) { console.error('    write failed: ' + werr.message); process.exit(1); }
    archived++;
  }
}
console.log('\n' + (WRITE ? 'archived ' : 'would archive ') + archived + '   already current ' + skipped + '   nothing to archive ' + missing);
if (!WRITE) console.log('Dry run. Re-run with --write to store.');
