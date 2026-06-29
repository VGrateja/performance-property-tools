// =============================================================================
// ingest-abs-pop-pyramid.mjs — Data Forge path: POPULATION PYRAMID
// (population by 5-year age group, persons) for National + 8 states + 8 capital
// cities, straight from the ABS Data API (https://data.api.abs.gov.au). No key.
//
// HYBRID data point: this script owns the API-coverable regions only —
//   • NATIONAL  : ERP_ASGS2021 ASGS_2021 = AUS
//   • STATES    : ERP_ASGS2021 ASGS_2021 = 1..8 (STE)
//   • CAPITALS  : ERP_ASGS2021 ASGS_2021 = 1GSYD..8ACTE (GCCSA = the report's
//                 "Metro"). Verified: Greater Sydney 2024 = 5.56M, and the
//                 (older) Data Dump PopPyramid sheet's Sydney ≈ 5.23M is just an
//                 earlier vintage of the SAME GCCSA series.
// The 28 regional cities are NOT API-coverable (ERP_LGA has no age dimension),
// so they are uploaded from the Data Dump "PopPyramid" sheet in the Data Forge
// view (src:'upload'). This script MERGES its 17 regions into the shared
// forge_population_pyramid jsonb, PRESERVING any src:'upload' regions.
//
// ISOLATED: writes ONLY to forge_population_pyramid (jsonb, id='latest') + logs
// rdp_runs + records health in forge_data_status (data_key='population_pyramid').
//
// Dry-run by DEFAULT (prints the reconstructed distribution). Pass --write to
// upsert. --from=YYYY limits the start year (default 2021).
//
// Usage:
//   node scripts/ingest-abs-pop-pyramid.mjs            # dry run
//   node scripts/ingest-abs-pop-pyramid.mjs --write    # upsert (merges)
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const FROM = +((process.argv.find(a => a.startsWith('--from=')) || '--from=2021').split('=')[1]) || 2021;

const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`ABS ${r.status}: ${t.slice(0, 100)}`); } };

// ── ASGS_2021 code → region slug + label (National, states, capital GCCSAs) ──
const CODE_SLUG = {
  AUS: ['australia', 'National'],
  '1': ['st-nsw', 'NSW'], '2': ['st-vic', 'VIC'], '3': ['st-qld', 'QLD'], '4': ['st-sa', 'SA'],
  '5': ['st-wa', 'WA'], '6': ['st-tas', 'TAS'], '7': ['st-nt', 'NT'], '8': ['st-act', 'ACT'],
  '1GSYD': ['sydney', 'Sydney'], '2GMEL': ['melbourne', 'Melbourne'], '3GBRI': ['brisbane', 'Brisbane'],
  '4GADE': ['adelaide', 'Adelaide'], '5GPER': ['perth', 'Perth'], '6GHOB': ['hobart', 'Hobart'],
  '7GDAR': ['darwin', 'Darwin'], '8ACTE': ['canberra', 'Canberra'],
};

// ── ABS AGE code → report age-group label (5-year groups; 8599 = 85 and over) ──
const AGE_LABEL = {
  A04: '0-04', A59: '05-09', A10: '10-14', A15: '15-19', A20: '20-24', A25: '25-29',
  A30: '30-34', A35: '35-39', A40: '40-44', A45: '45-49', A50: '50-54', A55: '55-59',
  A60: '60-64', A65: '65-69', A70: '70-74', A75: '75-79', A80: '80-84', '8599': '85 and over',
};
const AGE_GROUPS = ['0-04', '05-09', '10-14', '15-19', '20-24', '25-29', '30-34', '35-39', '40-44', '45-49', '50-54', '55-59', '60-64', '65-69', '70-74', '75-79', '80-84', '85 and over'];

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const FK = 'population_pyramid', FLABEL = 'Population Pyramid', FSOURCE = 'ABS Data API (ERP_ASGS2021 age×sex) + manual regional upload';
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: FK, label: FLABEL, source: FSOURCE, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated — ' + error.message + ')');
}

// ── fetch ERP_ASGS2021 persons (SEX=3), all needed ASGS_2021 codes in one call ──
// key order (from DSD): MEASURE.SEX.AGE.REGION_TYPE.ASGS_2021.FREQ
const codes = Object.keys(CODE_SLUG);
const regions = {};   // slug -> { label, src:'api', total:[18], year }
let latest = 0;
try {
  const key = ['', '3', '', '', codes.join('+'), ''].join('.');
  const j = await getJson(`${API}/data/ERP_ASGS2021/${key}?startPeriod=${FROM}&dimensionAtObservation=AllDimensions&format=jsondata`);
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const sI = od.findIndex(d => d.id === 'SEX'), aI = od.findIndex(d => d.id === 'AGE'),
        rI = od.findIndex(d => d.id === 'ASGS_2021'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  latest = Math.max(...od[tI].values.map(v => +v.id));
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    if (od[sI].values[ix[sI]].id !== '3') continue;                 // persons
    if (+od[tI].values[ix[tI]].id !== latest) continue;             // latest year only
    const label = AGE_LABEL[od[aI].values[ix[aI]].id]; if (!label) continue;   // skip TOT + any non-5yr code
    const ent = CODE_SLUG[od[rI].values[ix[rI]].id]; if (!ent) continue;
    const [slug, lbl] = ent;
    (regions[slug] ||= { label: lbl, src: 'api', total: Array(AGE_GROUPS.length).fill(null), year: latest });
    regions[slug].total[AGE_GROUPS.indexOf(label)] = Math.round(v[0]);
  }
} catch (e) {
  console.error('\n✗ ABS fetch failed:', e.message);
  await recordStatus('error', `ABS fetch failed: ${e.message}`);
  process.exit(1);
}

// ── report ──
const slugs = Object.values(CODE_SLUG).map(e => e[0]);
console.log(`ABS population pyramid — ${slugs.length} API regions, ${AGE_GROUPS.length} age groups, year ${latest}\n`);
console.log('region        pop (persons)   top age group');
for (const slug of slugs) {
  const r = regions[slug]; if (!r) { console.log(slug.padEnd(13), '   (missing)'); continue; }
  const sum = r.total.reduce((a, b) => a + (b || 0), 0);
  let ti = 0; r.total.forEach((v, i) => { if ((v || 0) > (r.total[ti] || 0)) ti = i; });
  console.log(slug.padEnd(13), String(sum).padStart(13), '   ' + AGE_GROUPS[ti] + ' (' + (sum ? (r.total[ti] / sum * 100).toFixed(1) : '0') + '%)');
}

// ── completeness guard: every API region must have all 18 age values ──
const incomplete = slugs.filter(s => !regions[s] || regions[s].total.some(v => v == null));
if (incomplete.length) console.error(`\n✗ COMPLETENESS FAIL: ${incomplete.length}/${slugs.length} region(s) missing age values → ${incomplete.join(', ')}`);
else console.log(`\n✓ Completeness: all ${slugs.length} API regions have all ${AGE_GROUPS.length} age groups for ${latest}.`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to merge into forge_population_pyramid (preserving uploaded regionals).'); process.exit(incomplete.length ? 1 : 0); }

// ── merge into the shared jsonb store, preserving any src:'upload' regions ──
const { data: existing } = await sb.from('forge_population_pyramid').select('data').eq('id', 'latest').maybeSingle();
const merged = { ageGroups: AGE_GROUPS, regions: {} };
if (existing && existing.data && existing.data.regions) {
  for (const [slug, r] of Object.entries(existing.data.regions)) if (r && r.src === 'upload') merged.regions[slug] = r;
}
for (const slug of slugs) if (regions[slug]) merged.regions[slug] = regions[slug];

const now = new Date().toISOString();
const { error: upErr } = await sb.from('forge_population_pyramid').upsert({ id: 'latest', data: merged, uploaded_by: 'abs-api', uploaded_at: now, updated_at: now }, { onConflict: 'id' });
if (upErr) { console.error('\n', upErr.message); await recordStatus('error', upErr.message); process.exit(1); }

const kept = Object.values(merged.regions).filter(r => r.src === 'upload').length;
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS pop-pyramid ${now.slice(0, 7)}`, row_count: slugs.length, status: incomplete.length ? 'partial' : 'ok', notes: `ERP_ASGS2021 age×sex persons: national + 8 states + 8 capital GCCSAs, year ${latest}; preserved ${kept} uploaded regional region(s)` });
await recordStatus(incomplete.length ? 'error' : 'ok',
  incomplete.length ? `${incomplete.length} region(s) incomplete: ${incomplete.join(', ')}` : `${slugs.length} API regions current through ${latest}; ${kept} uploaded regional region(s) preserved.`,
  { row_count: slugs.length, region_count: slugs.length, latest_year: latest });
console.log(`\n✓ Merged ${slugs.length} API regions into forge_population_pyramid (kept ${kept} uploaded regional region(s)).`);
process.exit(incomplete.length ? 1 : 0);
