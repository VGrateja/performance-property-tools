// =============================================================================
// ingest-abs-popcomponents-regional.mjs — Data Forge path: COMPONENTS OF
// POPULATION CHANGE **per region, per FINANCIAL year, in exact persons**.
// Natural Increase / Net Internal Migration / Net Overseas Migration for
// national + 8 states + 8 capitals + 28 regional cities, from the ABS Data API.
//
// WHY THIS EXISTS ALONGSIDE ingest-abs-popcomponents.mjs
// -----------------------------------------------------
// That script reads ERP_COMP_Q — quarterly, national + states only, summed to
// CALENDAR years, and published in THOUSANDS so every value is rounded to the
// nearest hundred. It is the right source for the existing Forge cards and is
// left completely alone.
//
// The VR Projection demand model needs something that series cannot give:
//   * per REGION, not just per state (37 markets)
//   * FINANCIAL years — the workbook's "current (2024-25)" is FY, not CY
//   * exact persons — the model's inputs carry single-digit precision
// The annual regional-population release provides all three. Its reference
// date is 30 June, so ABS's year label IS the financial year: TIME_PERIOD
// 2025 == FY2024-25. No re-aggregation, no rounding.
//
// SOURCES
//   national + states + capitals   ERP_COMP_SA_ASGS2021  ("SA2 and above",
//                                  which carries AUS, STE and GCCSA levels)
//   28 regional cities             ERP_COMP_LGA2025      (by LGA code)
//   POP_COMP codes: 3 Natural Increase · 6 Net Internal Migration
//                   9 Net Overseas Migration
//
// CAPITALS ARE GCCSA HERE. Components are not published for Significant Urban
// Areas, so a capital's components can only be GCCSA. States are stored too
// (st-nsw..st-act), which means a consumer can choose either basis WITHOUT a
// re-ingest — the VR workbook substitutes STATE figures for capitals, and
// whether we keep that or move to GCCSA is a downstream decision, not this
// script's business. Both are on the table because both are stored.
//
// NATIONAL NIM is not published (interstate migration nets to ~0 nationally),
// so it is excluded from the completeness guard rather than reported missing.
//
// ISOLATED: writes ONLY to rdp_raw_series with NEW metric names —
// natural_increase_fy | nim_fy | nom_fy (source='abs', freq='A',
// period 'YYYY-01-01' where YYYY is the June-ENDING year, i.e. 2025 = FY2024-25).
// The existing natural_increase / nim / nom rows are never touched. Upsert-only,
// so re-running refreshes in place and never deletes. Logs rdp_runs and records
// health in forge_data_status (data_key='pop_components_fy').
//
// Dry-run by DEFAULT. Pass --write to upsert. --from=YYYY limits the start year.
//
// Usage:
//   node scripts/ingest-abs-popcomponents-regional.mjs            # dry run
//   node scripts/ingest-abs-popcomponents-regional.mjs --write    # upsert
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const FROM = +((process.argv.find(a => a.startsWith('--from=')) || '--from=2000').split('=')[1]) || 2000;

const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`ABS ${r.status}: ${t.slice(0, 120)}`); } };

// POP_COMP name -> our metric. Matching on NAME rather than code so an ABS
// code reshuffle surfaces as "missing" instead of silently mis-mapping.
const COMP = { 'Natural Increase': 'natural_increase_fy', 'Net Internal Migration': 'nim_fy', 'Net Overseas Migration': 'nom_fy' };
const METRICS = Object.values(COMP);

// national + states, by REGION code in the SA hierarchy
const NATSTATE = { AUS: 'australia', '1': 'st-nsw', '2': 'st-vic', '3': 'st-qld', '4': 'st-sa', '5': 'st-wa', '6': 'st-tas', '7': 'st-nt', '8': 'st-act' };
// capitals = Greater Capital City Statistical Areas (ASGS Ed3)
const GCCSA = { '1GSYD': 'sydney', '2GMEL': 'melbourne', '3GBRI': 'brisbane', '4GADE': 'adelaide', '5GPER': 'perth', '6GHOB': 'hobart', '7GDAR': 'darwin', '8ACTE': 'canberra' };
// regional cities -> ABS LGA code (same map the population ingest verified 28/28)
const REGIONAL = {
  albury: '10050', ballarat: '20570', bendigo: '22620', bunbury: '51190', bundaberg: '31820',
  cairns: '32080', 'central-coast': '11650', 'coffs-harbour': '11800', geelong: '22750', gladstone: '33360',
  'gold-coast': '33430', ipswich: '33960', launceston: '64010', mackay: '34770', mandurah: '55110',
  mildura: '24780', newcastle: '15900', orange: '16150', 'port-macquarie': '16380', rockhampton: '36370',
  rockingham: '57490', 'sunshine-coast': '36720', tamworth: '17310', toowoomba: '36910', townsville: '37010',
  'wagga-wagga': '17750', wodonga: '27170', wollongong: '18450',
};
const lgaToSlug = Object.fromEntries(Object.entries(REGIONAL).map(([s, c]) => [c, s]));

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const FK = 'pop_components_fy', FLABEL = 'Population Components (financial year, regional)';
const FSOURCE = 'ABS Data API (ERP_COMP_SA_ASGS2021 / ERP_COMP_LGA2025)';
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;                                   // dry-run is read-only
  const now = new Date().toISOString();
  const row = { data_key: FK, label: FLABEL, source: FSOURCE, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated: ' + error.message + ')');
}

const rows = [];
/* Walk an SDMX AllDimensions payload, mapping REGION through `slugOf`. */
function harvest(j, slugOf, where) {
  const st = j.data.structures ? j.data.structures[0] : j.data.structure;
  const od = st.dimensions.observation;
  const iP = od.findIndex(d => d.id === 'POP_COMP'), iR = od.findIndex(d => d.id === 'REGION'), iT = od.findIndex(d => d.id === 'TIME_PERIOD');
  if (iP < 0 || iR < 0 || iT < 0) throw new Error(`${where}: unexpected dimensions (${od.map(d => d.id).join(',')})`);
  let n = 0;
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    const metric = COMP[od[iP].values[ix[iP]].name]; if (!metric) continue;
    const slug = slugOf(od[iR].values[ix[iR]].id); if (!slug) continue;
    const yr = +od[iT].values[ix[iT]].id; if (!(yr >= FROM)) continue;
    if (v[0] == null) continue;
    // ABS labels the annual regional release by the year ending 30 June, so
    // this year IS the financial year — stored as-is, no shifting.
    rows.push({ source: 'abs', region_slug: slug, metric, freq: 'A', period: `${yr}-01-01`, value: v[0] });
    n++;
  }
  return n;
}

let nSA = 0, nLGA = 0;
try {
  // national + states + capitals in one call — all three levels live in this flow
  const codes = [...Object.keys(NATSTATE), ...Object.keys(GCCSA)].join('+');
  const jSA = await getJson(`${API}/data/ERP_COMP_SA_ASGS2021/..${codes}.A?startPeriod=${FROM}&format=jsondata&dimensionAtObservation=AllDimensions`);
  nSA = harvest(jSA, c => NATSTATE[c] || GCCSA[c] || null, 'ERP_COMP_SA_ASGS2021');

  const jL = await getJson(`${API}/data/ERP_COMP_LGA2025/..${Object.values(REGIONAL).join('+')}.A?startPeriod=${FROM}&format=jsondata&dimensionAtObservation=AllDimensions`);
  nLGA = harvest(jL, c => lgaToSlug[c] || null, 'ERP_COMP_LGA2025');
} catch (e) {
  console.error('\n✗ ABS fetch failed:', e.message);
  await recordStatus('error', `ABS fetch failed: ${e.message}`);
  process.exit(1);
}

if (!rows.length) { console.error('\n✗ No rows returned — check the dataflow ids and region codes.'); await recordStatus('error', 'No rows returned from ABS'); process.exit(1); }

const years = [...new Set(rows.map(r => +r.period.slice(0, 4)))].sort((a, b) => a - b);
const latest = years[years.length - 1];
const ALL = [...Object.values(NATSTATE), ...Object.values(GCCSA), ...Object.keys(REGIONAL)];

console.log(`ABS components of population change — FINANCIAL year, exact persons`);
console.log(`  ${rows.length} rows · years ${years[0]}..${latest} (${latest} = FY${latest - 1}-${String(latest).slice(2)})`);
console.log(`  ${nSA} from ERP_COMP_SA_ASGS2021 (national+states+capitals) · ${nLGA} from ERP_COMP_LGA2025 (regionals)`);
console.log(`  metrics: ${METRICS.join(', ')}\n`);

const val = (slug, metric, yr) => { const r = rows.find(x => x.region_slug === slug && x.metric === metric && +x.period.slice(0, 4) === yr); return r ? r.value : null; };
const fmt = v => v == null ? '—' : String(Math.round(v));
console.log(`Latest year (${latest}):`);
console.log('region            nat.increase        NIM        NOM');
for (const slug of ALL) {
  console.log('  ' + slug.padEnd(16) + fmt(val(slug, 'natural_increase_fy', latest)).padStart(11) + fmt(val(slug, 'nim_fy', latest)).padStart(11) + fmt(val(slug, 'nom_fy', latest)).padStart(11));
}

// ── completeness guard. National NIM is genuinely not published (nets to ~0). ──
const missing = [];
for (const slug of ALL) for (const m of METRICS) {
  if (slug === 'australia' && m === 'nim_fy') continue;
  if (val(slug, m, latest) == null) missing.push(`${slug}/${m}`);
}
if (missing.length) console.error(`\n✗ COMPLETENESS FAIL: ${missing.length} region/metric pair(s) have no ${latest} value → ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` …+${missing.length - 12}` : ''}`);
else console.log(`\n✓ Completeness: all ${ALL.length} regions resolved ${latest} for every metric (national NIM excepted — ABS does not publish it).`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(missing.length ? 1 : 0); }

let written = 0;
for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500);
  const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' });
  if (error) { console.error('\n', error.message); process.exit(1); }
  written += chunk.length; process.stdout.write(`\r  upserted ${written}/${rows.length}`);
}
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS pop components FY ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: missing.length ? 'partial' : 'ok', notes: `ERP_COMP_SA_ASGS2021 (national+8 states+8 capital GCCSA) + ERP_COMP_LGA2025 (28 LGAs); NI/NIM/NOM, financial years ${years[0]}..${latest}, exact persons${missing.length ? `; MISSING: ${missing.join(', ')}` : ''}` });
await recordStatus(missing.length ? 'error' : 'ok',
  missing.length ? `${missing.length} region/metric pair(s) missing a ${latest} value` : `All ${ALL.length} regions current through FY${latest - 1}-${String(latest).slice(2)}.`,
  { row_count: written, region_count: ALL.length, latest_year: latest });
console.log(`\n✓ Upserted ${written} rows into rdp_raw_series.${missing.length ? ' (with completeness warnings — see above)' : ''}`);
process.exit(missing.length ? 1 : 0);
