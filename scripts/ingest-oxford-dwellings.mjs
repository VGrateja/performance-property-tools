// =============================================================================
// ingest-oxford-dwellings.mjs — Oxford Economics dwelling pipeline → Forge
//
// Source: "Exported - Oxford Economics Dwelling Data.xlsx" (Van's export, a
// LICENSED product — the workbook is never committed; point --file at it).
// Feeds B/S page 13 "Total Dwellings": approvals, commencements, completions.
//
// Reads the "ALL DATA" sheet (long format: Location | Indicator | Units |
// Scale | Measurement | 2002…2029) rather than the per-state tabs, because
// it carries every location including Greater Adelaide, which the tabs omit.
// Only the three "Number" series are taken:
//     Approvals    - residential - total dwellings (incl. conversion)
//     Commencements - residential - total dwellings (incl. conversion)
//     Completions  - residential - total dwellings (incl. conversion)
//
// COVERAGE (Van's call 2026-07-29). 27 of our 36 markets map to an Oxford
// location; the other 9 keep using the ABS approvals already in Forge
// (approvals_h + approvals_u), so the slide shows one line for those.
//   • exact        — the 7 capitals + the 13 regionals in Van's state tabs
//   • SA4 proxy    — 7 markets whose city sits inside a larger Oxford SA4
//                    and maps ONE-TO-ONE (see PROXY below)
//   • deliberately EXCLUDED as ambiguous: rockhampton + gladstone both fall in
//     "Central Queensland", and albury + mildura both in "Murray" — mapping
//     them would print identical charts on two different markets' decks.
//   • no Oxford data at all: canberra (the ACT is absent — "Capital Region"
//     is the NSW area AROUND it, not Canberra), central-coast, ipswich,
//     mandurah, rockingham.
//
// Writes annual rows to rdp_raw_series with source='oxford', freq='A',
// period = Jan 1 of the year. 2002-2029, so the tail years are Oxford's
// FORECAST — the chart must make that visually explicit.
//
// Dry-run by DEFAULT (parses + prints, no DB, no service key needed).
// --write upserts (never deletes: the house rule is preserve-old-data).
//   node scripts/ingest-oxford-dwellings.mjs [--file "<path.xlsx>"] [--write]
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args  = process.argv.slice(2);
const WRITE = args.includes('--write');
const fileArg = (() => { const i = args.indexOf('--file'); return i >= 0 ? args[i + 1] : null; })();
const FILE = fileArg || join(homedir(), 'Downloads', 'Exported - Oxford Economics Dwelling Data.xlsx');

if (!existsSync(FILE)) { console.error('Workbook not found: ' + FILE); process.exit(1); }

/* our slug ← Oxford location. Exact city/capital matches first, then the
   one-to-one SA4 proxies Van approved. */
const EXACT = {
  'Greater Sydney': 'sydney', 'Greater Melbourne': 'melbourne', 'Greater Brisbane': 'brisbane',
  'Greater Perth': 'perth', 'Greater Adelaide': 'adelaide', 'Greater Hobart': 'hobart',
  'Greater Darwin': 'darwin',
  'Ballarat': 'ballarat', 'Bendigo': 'bendigo', 'Geelong': 'geelong',
  'Coffs Harbour - Grafton': 'coffs-harbour', 'Newcastle & Lake Macquarie': 'newcastle',
  'Cairns': 'cairns', 'Gold Coast': 'gold-coast', 'Sunshine Coast': 'sunshine-coast',
  'Toowoomba': 'toowoomba', 'Townsville': 'townsville',
  'Mackay - Isaac - Whitsunday': 'mackay', 'Bunbury': 'bunbury',
  'Launceston and North East': 'launceston',
};
/* larger SA4 standing in for the city inside it — one-to-one only */
const PROXY = {
  'Illawarra': 'wollongong', 'Mid North Coast': 'port-macquarie',
  'New England & North West': 'tamworth', 'Riverina': 'wagga-wagga',
  'Central West': 'orange', 'Wide Bay': 'bundaberg', 'Hume': 'wodonga',
};
const LOC2SLUG = { ...EXACT, ...PROXY };

const METRIC = {
  'approvals': 'dwellings_approvals',
  'commencements': 'dwellings_commencements',
  'completions': 'dwellings_completions',
};

const wb = XLSX.readFile(FILE);
if (!wb.Sheets['ALL DATA']) { console.error('Sheet "ALL DATA" missing — is this the right export?'); process.exit(1); }
const rows = XLSX.utils.sheet_to_json(wb.Sheets['ALL DATA'], { header: 1, raw: true, defval: '' });
const hdr = rows[0];

/* year columns: header cells that are 4-digit numbers */
const YEARS = [];
hdr.forEach((h, i) => { const n = Number(h); if (Number.isInteger(n) && n >= 1990 && n <= 2100) YEARS.push({ year: n, col: i }); });
if (!YEARS.length) { console.error('No year columns found in ALL DATA'); process.exit(1); }

const RE = /^(Approvals|Commencements|Completions) - residential - total dwellings \(incl\. conversion\)$/i;

const out = [];
const seen = new Map();          // slug → Set(metric)
const skippedLoc = new Set();

for (const r of rows.slice(1)) {
  const loc = String(r[0] || '').trim();
  const ind = String(r[1] || '').trim();
  const unit = String(r[2] || '').trim();
  if (!loc || !RE.test(ind)) continue;
  if (unit.toLowerCase() !== 'number') continue;          // skip the $-value twins
  const slug = LOC2SLUG[loc];
  if (!slug) { skippedLoc.add(loc); continue; }

  const metric = METRIC[ind.split(' - ')[0].toLowerCase()];
  if (!metric) continue;

  for (const { year, col } of YEARS) {
    const raw = r[col];
    if (raw === '' || raw === null || raw === undefined) continue;
    const v = Number(raw);
    if (!isFinite(v)) continue;
    out.push({
      source: 'oxford', region_slug: slug, metric, freq: 'A',
      period: year + '-01-01',
      value: Math.round(v * 100) / 100,                    // commencements carry decimals
    });
  }
  if (!seen.has(slug)) seen.set(slug, new Set());
  seen.get(slug).add(metric);
}

/* ── report ───────────────────────────────────────────────────────────── */
const slugs = [...seen.keys()].sort();
console.log('Workbook : ' + FILE);
console.log('Years    : ' + YEARS[0].year + '–' + YEARS[YEARS.length - 1].year + '  (' + YEARS.length + ')');
console.log('Mapped   : ' + slugs.length + ' markets, ' + out.length + ' rows');
const incomplete = slugs.filter(s => seen.get(s).size !== 3);
console.log('Complete : ' + slugs.filter(s => seen.get(s).size === 3).length + ' with all three series'
          + (incomplete.length ? '  ⚠ partial: ' + incomplete.join(', ') : ''));
console.log('\nPer market (rows):');
slugs.forEach(s => {
  const n = out.filter(o => o.region_slug === s).length;
  const tag = Object.values(PROXY).includes(s) ? '  [SA4 proxy]' : '';
  console.log('  ' + s.padEnd(16) + String(n).padStart(4) + tag);
});
console.log('\nOxford locations present but NOT mapped (' + skippedLoc.size + '):');
console.log('  ' + [...skippedLoc].sort().join(', '));

/* spot-check: Melbourne, so the numbers can be eyeballed against the VIC tab */
const mel = out.filter(o => o.region_slug === 'melbourne' && ['2002-01-01','2025-01-01','2029-01-01'].includes(o.period));
console.log('\nSpot-check melbourne:');
mel.forEach(m => console.log('  ' + m.period.slice(0,4) + '  ' + m.metric.padEnd(24) + m.value));

if (!WRITE) { console.log('\nDry run — nothing written. Re-run with --write to upsert.'); process.exit(0); }

/* ── write ────────────────────────────────────────────────────────────── */
try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

let done = 0;
for (let i = 0; i < out.length; i += 500) {
  const chunk = out.slice(i, i + 500);
  const { error } = await sb.from('rdp_raw_series')
    .upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' });
  if (error) { console.error('Upsert failed at row ' + i + ': ' + error.message); process.exit(1); }
  done += chunk.length;
  process.stdout.write('\r  upserted ' + done + '/' + out.length);
}
/* Data Forge card freshness (the 'dwellings' data point) */
{
  const now = new Date().toISOString();
  const { error } = await sb.from('forge_data_status').upsert({
    data_key: 'dwellings', label: 'Total Dwellings (Oxford)',
    source: 'Oxford Economics — dwelling pipeline export (ALL DATA sheet)',
    status: 'ok', message: slugs.length + ' markets · ' + out.length + ' rows · ' + YEARS[0].year + '–' + YEARS[YEARS.length - 1].year,
    last_run_at: now, last_ok_at: now, updated_at: now,
  }, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated? ' + error.message + ')');
}
console.log('\n✓ Oxford dwelling data written for ' + slugs.length + ' markets.');
