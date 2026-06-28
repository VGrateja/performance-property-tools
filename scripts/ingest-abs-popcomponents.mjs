// =============================================================================
// ingest-abs-popcomponents.mjs — Data Forge path: POPULATION-CHANGE COMPONENTS
// (annual, by STATE + national) — Natural Increase, NIM, NOM — from the ABS API.
//
// Source: ABS National, State & Territory Population (cat 3101.0), dataflow
//   ERP_COMP_Q ("Population and components of change - national, states and
//   territories"), quarterly. Key  <MEASURE>.<REGION>.Q   (no key-filtering of
//   region needed — we pull all and map). MEASURE 3=Natural Increase,
//   6=Net Internal Migration, 9=Net Overseas Migration. NSW NI = the user's
//   series A2060788C. REGION 1..8 → st-nsw..st-act, AUS → australia.
//   UNIT_MULT varies per measure (NI/NOM published in THOUSANDS, NIM in
//   PERSONS) so every value is scaled by 10^UNIT_MULT read from the API.
//   National (AUS) has NI + NOM but NOT NIM (internal migration nets to ~0
//   nationally — and the DB has no australia row for nim).
//
//   THIS RUN = capital cities (= state-level; each capital uses its state's
//   figure, like income). Regional LGAs come from ERP_COMP_LGA2025 separately.
//
// RULE (user's): the DB stores ANNUAL = a 4-QUARTER SUM.
//   • complete years        → sum of that calendar year's 4 quarters
//   • current/latest year   → if incomplete, the avg of the last 4 quarters × 4
//                             (= rolling sum of the most recent 4 quarters);
//                             if complete, just the sum. (Same maths either way.)
//
// ISOLATED: rdp_raw_series (source='abs', metric in natural_increase|nim|nom,
// freq='A', period 'YYYY-01-01') + rdp_runs + forge_data_status (one row per
// metric). Upsert-only — never deletes the existing regional rows. Dry-run by
// DEFAULT; --write upserts; --from=YYYY; --only=natural_increase|nim|nom.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const FROM = +((process.argv.find(a => a.startsWith('--from=')) || '--from=1990').split('=')[1]) || 1990;
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;
const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`ABS ${r.status}: ${t.slice(0, 80)}`); } };

const MEAS = { '3': 'natural_increase', '6': 'nim', '9': 'nom' };
const REG = { AUS: 'australia', '1': 'st-nsw', '2': 'st-vic', '3': 'st-qld', '4': 'st-sa', '5': 'st-wa', '6': 'st-tas', '7': 'st-nt', '8': 'st-act' };
const STATES = ['st-nsw', 'st-vic', 'st-qld', 'st-sa', 'st-wa', 'st-tas', 'st-nt', 'st-act'];
// national NIM is not published (≈0); the DB has no australia row for it.
const EXPECT = { natural_increase: ['australia', ...STATES], nim: STATES, nom: ['australia', ...STATES] };
const LABEL = { natural_increase: 'Natural Increase', nim: 'Net Internal Migration (NIM)', nom: 'Net Overseas Migration (NOM)' };
const FSOURCE = 'ABS National, State & Territory Population (ERP_COMP_Q)';

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
async function recordStatus(key, status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: key, label: LABEL[key], source: FSOURCE, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated — apply migration 053? ' + error.message + ')');
}

// ── fetch quarterly components (NI/NIM/NOM), all regions, scaled by UNIT_MULT ──
const Q = { natural_increase: {}, nim: {}, nom: {} };   // metric -> slug -> Map(qidx -> persons)
try {
  const j = await getJson(`${API}/data/ERP_COMP_Q/3+6+9..Q?startPeriod=${FROM}-Q1&format=jsondata&dimensionAtObservation=AllDimensions`);
  const st = j.data.structure || j.data.structures[0];
  const od = st.dimensions.observation, oa = (st.attributes && st.attributes.observation) || [];
  const mI = od.findIndex(d => d.id === 'MEASURE'), rI = od.findIndex(d => d.id === 'REGION'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  const umPos = oa.findIndex(a => a.id === 'UNIT_MULT');
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    const metric = MEAS[od[mI].values[ix[mI]].id]; if (!metric) continue;
    const slug = REG[od[rI].values[ix[rI]].id]; if (!slug) continue;
    const m = od[tI].values[ix[tI]].id.match(/^(\d{4})-Q([1-4])$/); if (!m) continue;
    let um = 0; if (umPos >= 0) { const ai = v[1 + umPos]; if (ai != null) um = +oa[umPos].values[ai].id; }
    (Q[metric][slug] ||= new Map()).set((+m[1]) * 4 + (+m[2] - 1), v[0] * Math.pow(10, um));
  }
} catch (e) { console.error('\n✗ ABS fetch failed:', e.message); for (const key of Object.keys(MEAS).map(k => MEAS[k])) await recordStatus(key, 'error', `ABS fetch failed: ${e.message}`); process.exit(1); }

// ── annual = 4-quarter sum (calendar for complete years; rolling for the latest) ──
const sum4 = (map, lastQ) => { let s = 0; for (let q = lastQ - 3; q <= lastQ; q++) { const v = map.get(q); if (v == null) return null; s += v; } return s; };
const metrics = ONLY ? [ONLY] : ['natural_increase', 'nim', 'nom'];
let anyMissing = false;
for (const metric of metrics) {
  const rows = [];
  const slugs = EXPECT[metric];
  let latestYear = 0;
  for (const slug of slugs) {
    const map = Q[metric][slug]; if (!map || !map.size) continue;
    const lastQ = Math.max(...map.keys());
    const ly = Math.floor(lastQ / 4); latestYear = Math.max(latestYear, ly);
    const years = new Set([...map.keys()].map(q => Math.floor(q / 4)));
    for (const y of years) {
      if (y === ly) continue;
      const s = sum4(map, y * 4 + 3);                          // calendar Q1..Q4
      if (s != null) rows.push({ source: 'abs', region_slug: slug, metric, freq: 'A', period: `${y}-01-01`, value: Math.round(s) });
    }
    const roll = sum4(map, lastQ);                             // latest = rolling 4 qtrs (= avg×4 when incomplete)
    if (roll != null) rows.push({ source: 'abs', region_slug: slug, metric, freq: 'A', period: `${ly}-01-01`, value: Math.round(roll) });
  }

  const { data: cur } = await sb.from('rdp_raw_series').select('region_slug,value').eq('source', 'abs').eq('metric', metric).eq('freq', 'A').eq('period', `${latestYear}-01-01`).in('region_slug', slugs);
  const curMap = Object.fromEntries((cur || []).map(r => [r.region_slug, +r.value]));
  console.log(`\n${LABEL[metric]} — ${rows.length} annual rows, ${slugs.length} regions (latest ${latestYear}):`);
  console.log('region       ' + latestYear + ' (new)      DB (old)');
  for (const slug of slugs) {
    const r = rows.find(x => x.region_slug === slug && +x.period.slice(0, 4) === latestYear);
    console.log(slug.padEnd(11), String(r ? Math.round(r.value).toLocaleString() : '—').padStart(11), '  ', curMap[slug] != null ? Math.round(curMap[slug]).toLocaleString() : '—');
  }
  const missing = slugs.filter(s => !rows.some(r => r.region_slug === s && +r.period.slice(0, 4) === latestYear));
  if (missing.length) { anyMissing = true; console.error(`  ✗ COMPLETENESS FAIL: missing ${latestYear} for ${missing.join(', ')}`); }
  else console.log(`  ✓ all ${slugs.length} regions have ${latestYear}.`);

  if (WRITE) {
    let written = 0;
    for (let k = 0; k < rows.length; k += 500) { const chunk = rows.slice(k, k + 500); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\n', error.message); process.exit(1); } written += chunk.length; }
    await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS popcomp ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: missing.length ? 'partial' : 'ok', notes: `ABS ERP_COMP_Q ${metric} (annual 4-qtr sum; latest=rolling), states+national through ${latestYear}${missing.length ? '; MISSING: ' + missing.join(', ') : ''}` });
    await recordStatus(metric, missing.length ? 'error' : 'ok', missing.length ? `Missing ${latestYear} for ${missing.join(', ')}` : `Current through ${latestYear} (ERP_COMP_Q; states + national).`, { row_count: written, region_count: slugs.length, latest_year: latestYear });
    console.log(`  ✓ Upserted ${written} ${metric} rows.`);
  }
}

if (!WRITE) console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.');
process.exit(anyMissing ? 1 : 0);
