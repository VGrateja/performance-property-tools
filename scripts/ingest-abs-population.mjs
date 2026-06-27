// =============================================================================
// ingest-abs-population.mjs — Data Forge path: POPULATION (National + States +
// Capitals + Regional cities) straight from the ABS Data API (https://data.api.abs.gov.au). No API key.
//
// This is the verified data-gathering "path" for the population data point:
//
//   NATIONAL ('australia') + STATES (st-nsw..st-act)
//     dataflow ERP_Q (Quarterly ERP), MEASURE=1 SEX=3 AGE=TOT, REGION = AUS / 1..8
//     -> take the DECEMBER quarter (YYYY-Q4) as the value for year YYYY.
//     Verified: national 2016-2023 + states 2016-2020 reproduce the DB to the
//     person; later years differ only because the DB is behind ABS's post-2021
//     Census revisions (the API is the more-current source).
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
//   REGIONAL CITIES (28: newcastle, geelong, cairns, ... wollongong)
//     Each city = exactly one ABS Local Government Area (LGA). Pulled from the
//     latest ERP_LGA{year} flow (auto-discovered), MEASURE=ERP, by LGA code.
//     Verified: 2025 reproduces the existing DB EXACTLY for all 28 (by value).
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

// ── regional cities -> ABS LGA code (each city = exactly one LGA; verified 28/28 by value at 2025) ──
const REGIONAL = {
  albury: '10050', ballarat: '20570', bendigo: '22620', bunbury: '51190', bundaberg: '31820',
  cairns: '32080', 'central-coast': '11650', 'coffs-harbour': '11800', geelong: '22750', gladstone: '33360',
  'gold-coast': '33430', ipswich: '33960', launceston: '64010', mackay: '34770', mandurah: '55110',
  mildura: '24780', newcastle: '15900', orange: '16150', 'port-macquarie': '16380', rockhampton: '36370',
  rockingham: '57490', 'sunshine-coast': '36720', tamworth: '17310', toowoomba: '36910', townsville: '37010',
  'wagga-wagga': '17750', wodonga: '27170', wollongong: '18450',
};

// ── national + states -> ERP_Q REGION code (state codes 1..8); Dec quarter ──
const NATSTATE = { AUS: 'australia', '1': 'st-nsw', '2': 'st-vic', '3': 'st-qld', '4': 'st-sa', '5': 'st-wa', '6': 'st-tas', '7': 'st-nt', '8': 'st-act' };

const rows = [];

// ── NATIONAL + STATES: ERP_Q, December quarter ──
{
  const j = await getJson(`${API}/data/ERP_Q/all?startPeriod=${FROM}-Q1&format=jsondata&dimensionAtObservation=AllDimensions`);
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const mI = od.findIndex(d => d.id === 'MEASURE'), sI = od.findIndex(d => d.id === 'SEX'), aI = od.findIndex(d => d.id === 'AGE'), rI = od.findIndex(d => d.id === 'REGION'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    if (od[mI].values[ix[mI]].id !== '1' || od[sI].values[ix[sI]].id !== '3' || od[aI].values[ix[aI]].id !== 'TOT') continue; // ERP, persons, all ages
    const slug = NATSTATE[od[rI].values[ix[rI]].id]; if (!slug) continue;
    const t = od[tI].values[ix[tI]].id; if (!t.endsWith('-Q4')) continue; // December quarter
    rows.push({ source: 'abs', region_slug: slug, metric: 'population', freq: 'A', period: `${t.slice(0, 4)}-01-01`, value: v[0] });
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

// ── REGIONAL CITIES: LGA ERP straight from the latest ERP_LGA flow (one LGA per city) ──
let lgaFlowUsed = '';
{
  const dj = await (await fetch(`${API}/dataflow/ABS?detail=allstubs`, { headers: { Accept: 'application/vnd.sdmx.structure+json' } })).json();
  lgaFlowUsed = (dj.data.dataflows || []).map(f => f.id).filter(id => /^ERP_LGA\d{4}$/.test(id)).sort().pop();
  if (!lgaFlowUsed) throw new Error('No ERP_LGA dataflow found');
  const codeToSlug = Object.fromEntries(Object.entries(REGIONAL).map(([s, c]) => [c, s]));
  const j = await getJson(`${API}/data/${lgaFlowUsed}/all?startPeriod=${FROM}&format=jsondata&dimensionAtObservation=AllDimensions`);
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const mI = od.findIndex(d => d.id === 'MEASURE'), rI = od.findIndex(d => d.id === 'REGION'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  const seen = new Set();
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    if (od[mI].values[ix[mI]].id !== 'ERP') continue;
    const slug = codeToSlug[od[rI].values[ix[rI]].id]; if (!slug) continue;     // only our 28 LGAs
    const yr = od[tI].values[ix[tI]].id; const dk = `${slug}|${yr}`; if (seen.has(dk)) continue; seen.add(dk);
    rows.push({ source: 'abs', region_slug: slug, metric: 'population', freq: 'A', period: `${yr}-01-01`, value: v[0] });
  }
}

// ── connect (dry-run still reads the DB to show a comparison) ──
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

// existing values for comparison
const slugs = [...Object.values(NATSTATE), ...Object.keys(CAPITALS), ...Object.keys(REGIONAL)];
const latest = Math.max(...rows.map(r => +r.period.slice(0, 4)));
const { data: cur } = await sb.from('rdp_raw_series').select('region_slug,value').eq('source', 'abs').eq('metric', 'population').eq('period', `${latest}-01-01`).in('region_slug', slugs);
const curMap = Object.fromEntries((cur || []).map(r => [r.region_slug, +r.value]));

console.log(`ABS population — ${rows.length} rows (${FROM}..${latest}) for ${slugs.length} regions\n`);
console.log(`Latest year (${latest}) — reconstructed vs current DB:`);
console.log('region        reconstructed   DB              diff');
let exact = 0, compared = 0;
for (const slug of slugs) {
  const r = rows.find(x => x.region_slug === slug && +x.period.slice(0, 4) === latest); if (!r) continue;
  const db = curMap[slug];
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
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS population ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: 'ok', notes: `ABS API: national + 8 states ERP_Q (Dec qtr) + ${Object.keys(CAPITALS).length} capital SUAs (SA2 sum) + ${Object.keys(REGIONAL).length} regional LGAs (${lgaFlowUsed}), ${FROM}..${latest}` });
console.log(`\n✓ Upserted ${written} ABS population rows into rdp_raw_series.`);
