// =============================================================================
// ingest-abs-pop-pyramid.mjs — Data Forge path: POPULATION PYRAMID
// (population by 5-year age group, persons) for National + 8 states + 8 capital
// cities, straight from the ABS Data API (https://data.api.abs.gov.au). No key.
//
// ALL 45 regions now come from the ABS Data API (two dataflows):
//   • NATIONAL  : ERP_ASGS2021 ASGS_2021 = AUS          ┐ latest ERP year
//   • STATES    : ERP_ASGS2021 ASGS_2021 = 1..8 (STE)   │ (e.g. 2024),
//   • CAPITALS  : ERP_ASGS2021 ASGS_2021 = 1GSYD..8ACTE ┘ GCCSA = "Metro"
//   • 28 REGIONALS : C21_G04_LGA (2021 Census "Age by sex" by LGA) — ERP has NO
//                 LGA age dimension, so these are 2021-Census vintage (the sole
//                 age-by-LGA source). src:'census2021'.
// The two sources own DISJOINT region keys. A manual Data Dump "PopPyramid"
// upload (src:'upload') still OVERRIDES a region if present (merge preserves it).
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

const FK = 'population_pyramid', FLABEL = 'Population Pyramid', FSOURCE = 'ABS Data API: ERP_ASGS2021 (national/states/capitals, latest ERP) + C21_G04_LGA (28 regionals, 2021 Census)';
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

// ── REGIONALS: 28 LGAs from the 2021 Census (ERP has no LGA age dimension).
//   dataflow C21_G04_LGA "Age by sex", key AGEINGP.SEXP.REGION.REGION_TYPE.STATE.
//   5-year groups 0_4..80_84 map 1:1; 85_89/90_94/95_99/100_104/…/_over sum to
//   "85 and over" (the codelist has no 85+ aggregate, so no double-count). Census
//   is 2021 ONLY — a frozen vintage (capitals/states/national stay ERP latest);
//   it is the sole age-by-LGA source. LGA codes shared with ingest-abs-approvals. ──
const LGA = { albury: '10050', ballarat: '20570', bendigo: '22620', bunbury: '51190', bundaberg: '31820', cairns: '32080', 'central-coast': '11650', 'coffs-harbour': '11800', geelong: '22750', gladstone: '33360', 'gold-coast': '33430', ipswich: '33960', launceston: '64010', mackay: '34770', mandurah: '55110', mildura: '24780', newcastle: '15900', orange: '16150', 'port-macquarie': '16380', rockhampton: '36370', rockingham: '57490', 'sunshine-coast': '36720', tamworth: '17310', toowoomba: '36910', townsville: '37010', 'wagga-wagga': '17750', wodonga: '27170', wollongong: '18450' };
const LGA_SLUG = Object.fromEntries(Object.entries(LGA).map(([k, v]) => [v, k]));
const regionalSlugs = Object.keys(LGA);
const FIVE = { '0_4': '0-04', '5_9': '05-09', '10_14': '10-14', '15_19': '15-19', '20_24': '20-24', '25_29': '25-29', '30_34': '30-34', '35_39': '35-39', '40_44': '40-44', '45_49': '45-49', '50_54': '50-54', '55_59': '55-59', '60_64': '60-64', '65_69': '65-69', '70_74': '70-74', '75_79': '75-79', '80_84': '80-84' };
let censusYear = 2021;
try {
  const ckey = ['', '3', Object.values(LGA).join('+'), '', ''].join('.');   // AGEINGP.SEXP=3(persons).REGION=<28 LGAs>.REGION_TYPE.STATE
  const cj = await getJson(`${API}/data/C21_G04_LGA/${ckey}?format=jsondata&dimensionAtObservation=AllDimensions`);
  const od = (cj.data.structure || cj.data.structures[0]).dimensions.observation;
  const aI = od.findIndex(d => /AGEINGP/i.test(d.id)), sI = od.findIndex(d => /SEXP/i.test(d.id)), rI = od.findIndex(d => d.id === 'REGION'), tI = od.findIndex(d => /TIME_PERIOD/i.test(d.id));
  if (tI >= 0 && od[tI].values.length) censusYear = Math.max(...od[tI].values.map(v => +v.id));
  for (const [k, v] of Object.entries(cj.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    if (od[sI].values[ix[sI]].id !== '3') continue;                          // persons only
    const slug = LGA_SLUG[od[rI].values[ix[rI]].id]; if (!slug) continue;
    const code = od[aI].values[ix[aI]].id;
    let label = FIVE[code];
    if (!label) { const m = code.match(/^(\d+)_/); if (m && +m[1] >= 85) label = '85 and over'; else continue; }   // skip single years / _T
    (regions[slug] ||= { label: od[rI].values[ix[rI]].name, src: 'census2021', total: Array(AGE_GROUPS.length).fill(0), year: censusYear });
    regions[slug].total[AGE_GROUPS.indexOf(label)] += Math.round(v[0]);
  }
} catch (e) { console.error('\n✗ Census G04 (regional) fetch failed:', e.message); await recordStatus('error', `Census G04 fetch failed: ${e.message}`); process.exit(1); }

// ── report ──
const slugs = [...Object.values(CODE_SLUG).map(e => e[0]), ...regionalSlugs];
console.log(`ABS population pyramid — ${slugs.length} regions (${Object.keys(CODE_SLUG).length} ERP ${latest} + ${regionalSlugs.length} Census ${censusYear}), ${AGE_GROUPS.length} age groups\n`);
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
else console.log(`\n✓ Completeness: all ${slugs.length} regions have all ${AGE_GROUPS.length} age groups (ERP ${latest} + Census ${censusYear}).`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to merge into forge_population_pyramid (preserving uploaded regionals).'); process.exit(incomplete.length ? 1 : 0); }

// ── merge into the shared jsonb store, preserving any src:'upload' regions ──
const { data: existing } = await sb.from('forge_population_pyramid').select('data').eq('id', 'latest').maybeSingle();
const merged = { ageGroups: AGE_GROUPS, regions: {} };
if (existing && existing.data && existing.data.regions) {
  for (const [slug, r] of Object.entries(existing.data.regions)) if (r && r.src === 'upload') merged.regions[slug] = r;
}
for (const slug of slugs) if (regions[slug] && !merged.regions[slug]) merged.regions[slug] = regions[slug];   // a manual upload (preserved above) still wins

const now = new Date().toISOString();
const { error: upErr } = await sb.from('forge_population_pyramid').upsert({ id: 'latest', data: merged, uploaded_by: 'abs-api', uploaded_at: now, updated_at: now }, { onConflict: 'id' });
if (upErr) { console.error('\n', upErr.message); await recordStatus('error', upErr.message); process.exit(1); }

const kept = Object.values(merged.regions).filter(r => r.src === 'upload').length;
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS pop-pyramid ${now.slice(0, 7)}`, row_count: slugs.length, status: incomplete.length ? 'partial' : 'ok', notes: `pop pyramid age×sex persons: ${Object.keys(CODE_SLUG).length} ERP ${latest} (national/states/capitals) + ${regionalSlugs.length} Census ${censusYear} regionals (C21_G04_LGA)${kept ? `; ${kept} manual upload(s) preserved` : ''}` });
await recordStatus(incomplete.length ? 'error' : 'ok',
  incomplete.length ? `${incomplete.length} region(s) incomplete: ${incomplete.join(', ')}` : `All ${slugs.length} regions current — ${Object.keys(CODE_SLUG).length} ERP ${latest} + ${regionalSlugs.length} Census ${censusYear} regionals${kept ? `; ${kept} upload(s) preserved` : ''}.`,
  { row_count: slugs.length, region_count: slugs.length, latest_year: latest });
console.log(`\n✓ Merged ${slugs.length} regions into forge_population_pyramid (${Object.keys(CODE_SLUG).length} ERP + ${regionalSlugs.length} Census${kept ? `; kept ${kept} upload(s)` : ''}).`);
process.exit(incomplete.length ? 1 : 0);
