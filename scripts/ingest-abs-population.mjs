// =============================================================================
// ingest-abs-population.mjs — Data Forge path: POPULATION (National + Capitals)
// straight from the ABS Data API (https://data.api.abs.gov.au). No API key.
//
// This is the verified data-gathering "path" for the population data point:
//
//   NATIONAL ('australia')
//     dataflow ERP_Q  (Quarterly ERP),  key  1.3.TOT.AUS.Q
//     -> take the DECEMBER quarter (YYYY-Q4) as the value for year YYYY.
//     Verified: 2016-2023 reproduce the existing DB to the person; 2024/25
//     differ only by ABS revisions to preliminary figures.
//
//   CAPITAL CITIES (sydney/melbourne/brisbane/perth/adelaide/canberra/hobart/darwin)
//     The DB capitals are ABS Significant Urban Areas (SUA), NOT Greater
//     Capital City (GCCSA). The API has no annual SUA series, but a SUA's ERP
//     is the exact sum of its component SA2s. So:
//       dataflow ABS_ANNUAL_ERP_ASGS2021 -> SA2-level ERP
//       sum SA2 -> SUA via scripts/data/sa2-sua-2021.json (ASGS Ed3 correspondence)
//     Verified: 2025 reproduces the existing DB EXACTLY for all 8 capitals.
//     (Canberra SUA = "Canberra - Queanbeyan", includes the NSW side.)
//
// ISOLATED: writes ONLY to rdp_raw_series (source='abs', metric='population',
// freq='A', period 'YYYY-01-01') + logs rdp_runs. Same shape as the existing
// rows, so it UPDATES them in place (no duplicates).
//
// Dry-run by DEFAULT (prints a comparison vs the current DB). Pass --write to
// upsert. --from=YYYY limits the start year (default 2001, the ASGS2021 floor).
//
// Usage:
//   node scripts/ingest-abs-population.mjs                 # dry run, all years
//   node scripts/ingest-abs-population.mjs --from=2023     # dry run, 2023+
//   node scripts/ingest-abs-population.mjs --write         # upsert
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const FROM = +((process.argv.find(a => a.startsWith('--from=')) || '--from=2001').split('=')[1]) || 2001;

const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`ABS ${r.status}: ${t.slice(0, 80)}`); } };

// ── capital city -> SUA name (looked up to a code in the bundled correspondence) ──
const CAPITALS = { sydney: 'Sydney', melbourne: 'Melbourne', brisbane: 'Brisbane', perth: 'Perth', adelaide: 'Adelaide', canberra: 'Canberra - Queanbeyan', hobart: 'Hobart', darwin: 'Darwin' };
const corr = JSON.parse(readFileSync(join(__dir, 'data', 'sa2-sua-2021.json'), 'utf8'));
const capSua = {}; // slug -> sua code
for (const [slug, name] of Object.entries(CAPITALS)) { const code = Object.keys(corr.sua_names).find(c => corr.sua_names[c] === name); if (!code) throw new Error(`SUA not found for ${slug} (${name})`); capSua[slug] = code; }

const rows = [];

// ── NATIONAL: ERP_Q, December quarter ──
{
  const j = await getJson(`${API}/data/ERP_Q/1.3.TOT.AUS.Q?startPeriod=${FROM}-Q1&format=jsondata&dimensionAtObservation=AllDimensions`);
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const t = od[tI].values[k.split(':').map(Number)[tI]].id;
    if (!t.endsWith('-Q4')) continue;
    rows.push({ source: 'abs', region_slug: 'australia', metric: 'population', freq: 'A', period: `${t.slice(0, 4)}-01-01`, value: v[0] });
  }
}

// ── CAPITALS: SA2 ERP summed to SUA ──
{
  const j = await getJson(`${API}/data/ABS_ANNUAL_ERP_ASGS2021/....A?startPeriod=${FROM}&format=jsondata&dimensionAtObservation=AllDimensions`);
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const aI = od.findIndex(d => d.id === 'ASGS_2021'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  // accumulate: sua code -> year -> sum
  const acc = {};
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    const sa2 = od[aI].values[ix[aI]].id;
    const sua = corr.sa2_to_sua[sa2]; if (!sua) continue;            // only SA2s that belong to a SUA
    const yr = od[tI].values[ix[tI]].id;
    ((acc[sua] ||= {})[yr] ||= 0); acc[sua][yr] += v[0];
  }
  for (const [slug, sua] of Object.entries(capSua)) {
    for (const [yr, val] of Object.entries(acc[sua] || {})) rows.push({ source: 'abs', region_slug: slug, metric: 'population', freq: 'A', period: `${yr}-01-01`, value: val });
  }
}

// ── connect (dry-run still reads the DB to show a comparison) ──
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

// existing values for comparison
const slugs = ['australia', ...Object.keys(CAPITALS)];
const { data: cur } = await sb.from('rdp_raw_series').select('region_slug,period,value').eq('source', 'abs').eq('metric', 'population').in('region_slug', slugs);
const curMap = Object.fromEntries((cur || []).map(r => [`${r.region_slug}|${r.period.slice(0, 10)}`, +r.value]));

const latest = Math.max(...rows.map(r => +r.period.slice(0, 4)));
console.log(`ABS population — ${rows.length} rows (${FROM}..${latest}) for ${slugs.length} regions\n`);
console.log(`Latest year (${latest}) — reconstructed vs current DB:`);
console.log('region        reconstructed   DB              diff');
let exact = 0, compared = 0;
for (const slug of slugs) {
  const r = rows.find(x => x.region_slug === slug && +x.period.slice(0, 4) === latest); if (!r) continue;
  const db = curMap[`${slug}|${r.period.slice(0, 10)}`];
  const diff = db == null ? null : r.value - db; if (diff != null) { compared++; if (diff === 0) exact++; }
  console.log(slug.padEnd(13), String(Math.round(r.value)).padStart(13), String(db ?? '—').padStart(15), (diff == null ? '—' : String(diff)).padStart(9), diff === 0 ? '  EXACT' : '');
}
console.log(`\n${exact}/${compared} exact at ${latest} (older-year diffs = ABS revisions since last manual pull).`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(0); }

let written = 0;
for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500);
  const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' });
  if (error) { console.error('\n', error.message); process.exit(1); }
  written += chunk.length; process.stdout.write(`\r  upserted ${written}/${rows.length}`);
}
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS population ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: 'ok', notes: `ABS API: national ERP_Q (Dec qtr) + ${Object.keys(CAPITALS).length} capital SUAs (SA2 sum), ${FROM}..${latest}` });
console.log(`\n✓ Upserted ${written} ABS population rows into rdp_raw_series.`);
