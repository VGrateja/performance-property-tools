// =============================================================================
// ingest-abs-approvals.mjs — Data Forge: BUILDING APPROVALS (dwelling units),
// HOUSES (approvals_h) + UNITS/OTHER RESIDENTIAL (approvals_u), annual counts.
//
// SOURCES (ABS Building Approvals, cat 8731.0, ABS Data API — Original):
//   • National + 8 capitals (incl. Canberra) → dataflow BA_GCCSA.
//       key MEASURE.VALUE.SECTOR.WORK_TYPE.BUILDING_TYPE.TSEST.REGION.FREQ
//       = 1.1.9.1.<BT>.10.<REGION>.M  (1=No. dwelling units, 1=Total value,
//         9=Total sectors, 1=New work, BT 110=Houses / 150=Total Other
//         Residential, 10=Original). REGION: AUS + GCCSA "G" codes;
//         Canberra uses 8ACTE (no "Greater Canberra" exists).
//   • 28 regionals → dataflow BA_LGA<YYYY> (one financial year each:
//       Jul YYYY → Jun YYYY+1). key MEASURE.SECTOR.WORK_TYPE.BUILDING_TYPE.
//       REGION_TYPE.REGION.FREQ = 1.9.1.<BT>.LGA<YYYY>.<lgaCode>.M.
//       Vintages are stitched into continuous CALENDAR-year monthly series
//       (guide: "do not use FYTD"). ⚠️ ABS revises LGA approvals heavily, so
//       regionals differ from the older DB captures — user chose to adopt the
//       current ABS series (2026-06).
//
// RULE (user's guides): stored ANNUAL (freq 'A', period YYYY-01-01), counts.
//   completed years = sum of the year's 12 months. Current (latest) year:
//     HOUSES  → <6 months: sum of the trailing 12 months; 6–11: avg×12; 12: sum.
//     UNITS   → incomplete: avg×12; complete: sum.
//
//   ISOLATED: rdp_raw_series (source='abs', metric approvals_h|approvals_u,
//   freq 'A') + rdp_runs + forge_data_status ('approvals'). Upsert-only (never
//   deletes the long history). Dry-run by DEFAULT; --write upserts.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); if (!t.trim().startsWith('{')) return null; return JSON.parse(t); };
const BT = { approvals_h: '110', approvals_u: '150' };
const GCCSA = { australia: 'AUS', sydney: '1GSYD', melbourne: '2GMEL', brisbane: '3GBRI', adelaide: '4GADE', perth: '5GPER', hobart: '6GHOB', darwin: '7GDAR', canberra: '8ACTE' };
const GCCSA_INV = Object.fromEntries(Object.entries(GCCSA).map(([k, v]) => [v, k]));
const LGA = { albury:10050, ballarat:20570, bendigo:22620, bunbury:51190, bundaberg:31820, cairns:32080, 'central-coast':11650, 'coffs-harbour':11800, geelong:22750, gladstone:33360, 'gold-coast':33430, ipswich:33960, launceston:64010, mackay:34770, mandurah:55110, mildura:24780, newcastle:15900, orange:16150, 'port-macquarie':16380, rockhampton:36370, rockingham:57490, 'sunshine-coast':36720, tamworth:17310, toowoomba:36910, townsville:37010, 'wagga-wagga':17750, wodonga:27170, wollongong:18450 };
const LGA_INV = Object.fromEntries(Object.entries(LGA).map(([k, v]) => [String(v), k]));
const VINTAGES = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];   // FY vintages → calendar 2019..2026

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: 'approvals', label: 'Building Approvals', source: 'ABS Building Approvals (BA_GCCSA + BA_LGA), Original', status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated? ' + error.message + ')');
}

// monthly {ym:count} → annual rows per the rule
function annualRows(monthly, metric, region) {
  const months = Object.keys(monthly).sort();
  if (!months.length) return [];
  const byYear = {}; for (const ym of months) (byYear[ym.slice(0, 4)] ||= []).push(monthly[ym]);
  const years = Object.keys(byYear).sort(); const latestY = years[years.length - 1];
  const trailing12 = months.slice(-12).map(m => monthly[m]);
  const rows = [];
  for (const y of years) {
    const a = byYear[y]; const n = a.length; const sum = a.reduce((p, q) => p + q, 0);
    let val;
    if (y === latestY) {
      if (metric === 'approvals_h' && n < 6) val = trailing12.reduce((p, q) => p + q, 0);   // houses: trailing 12 months
      else if (n < 12) val = sum / n * 12;                                                   // avg × 12
      else val = sum;                                                                         // complete
    } else {
      if (n < 12) continue;   // skip incomplete non-latest years (vintage-stitch boundaries)
      val = sum;
    }
    rows.push({ source: 'abs', region_slug: region, metric, freq: 'A', period: `${y}-01-01`, value: Math.round(val) });
  }
  return rows;
}

// BA_GCCSA: national + capitals, one building type → { slug: {ym:val} }
async function fetchGCCSA(bt) {
  const j = await getJson(`${API}/data/BA_GCCSA/1.1.9.1.${bt}.10.${Object.values(GCCSA).join('+')}.M?startPeriod=2016-01&format=jsondata&dimensionAtObservation=AllDimensions`);
  if (!j) throw new Error('BA_GCCSA fetch returned no data');
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const rI = od.findIndex(d => d.id === 'REGION'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  const out = {};
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    const slug = GCCSA_INV[od[rI].values[ix[rI]].id]; if (!slug) continue;
    (out[slug] ||= {})[od[tI].values[ix[tI]].id] = v[0];
  }
  return out;
}
// BA_LGA<yr>: one building type, all LGAs → merge into { slug: {ym:val} }
async function fetchLGAvintage(yr, bt, into) {
  const j = await getJson(`${API}/data/BA_LGA${yr}/1.9.1.${bt}.LGA${yr}..M?startPeriod=${yr}-07&format=jsondata&dimensionAtObservation=AllDimensions`);
  if (!j) return;
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const rI = od.findIndex(d => d.id === 'REGION'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    const slug = LGA_INV[od[rI].values[ix[rI]].id]; if (!slug) continue;
    (into[slug] ||= {})[od[tI].values[ix[tI]].id] = v[0];
  }
}

// national dwellings COMMENCED (ABS Building Activity 8752.0, M6 — quarterly → annual)
const COMMENCED = { commenced_h: '110', commenced_u: '150' };
function annualFromQ(byYear, metric) {
  const years = Object.keys(byYear).sort(); const latestY = years[years.length - 1]; const out = [];
  for (const y of years) { const a = byYear[y], n = a.length, sum = a.reduce((p, q) => p + q, 0);
    let val; if (y === latestY) val = n < 4 ? sum / n * 4 : sum; else { if (n < 4) continue; val = sum; }
    out.push({ source: 'abs', region_slug: 'australia', metric, freq: 'A', period: `${y}-01-01`, value: Math.round(val) }); }
  return out;
}

const rows = []; const warn = [];
try {
  for (const [metric, bt] of Object.entries(BT)) {
    const g = await fetchGCCSA(bt);
    for (const [slug, m] of Object.entries(g)) rows.push(...annualRows(m, metric, slug));
    const lga = {};
    for (const yr of VINTAGES) await fetchLGAvintage(yr, bt, lga);
    for (const [slug, m] of Object.entries(lga)) rows.push(...annualRows(m, metric, slug));
    const missing = Object.keys(LGA).filter(s => !lga[s]); if (missing.length) warn.push(`${metric}: no LGA data for ${missing.join(', ')}`);
  }
  for (const [metric, bt] of Object.entries(COMMENCED)) {
    const j = await getJson(`${API}/data/BUILDING_ACTIVITY/M6.AUS.CUR.1.9.${bt}.10.Q?startPeriod=2015-Q1&format=jsondata&dimensionAtObservation=AllDimensions`);
    if (!j) { warn.push(`${metric}: no Building Activity data`); continue; }
    const od = (j.data.structure || j.data.structures[0]).dimensions.observation; const tI = od.findIndex(d => d.id === 'TIME_PERIOD');
    const byYear = {}; for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) { const ix = k.split(':').map(Number); const ym = od[tI].values[ix[tI]].id; (byYear[ym.slice(0, 4)] ||= []).push(v[0]); }
    rows.push(...annualFromQ(byYear, metric));
  }
} catch (e) { console.error('\n✗ ABS fetch failed:', e.message); await recordStatus('error', `ABS fetch failed: ${e.message}`); process.exit(1); }

const latestYear = rows.reduce((a, r) => Math.max(a, +r.period.slice(0, 4)), 0);
const expected = [...Object.keys(GCCSA), ...Object.keys(LGA)];
const haveH = new Set(rows.filter(r => r.metric === 'approvals_h' && +r.period.slice(0, 4) === latestYear).map(r => r.region_slug));
const haveU = new Set(rows.filter(r => r.metric === 'approvals_u' && +r.period.slice(0, 4) === latestYear).map(r => r.region_slug));
const missH = expected.filter(r => !haveH.has(r)), missU = expected.filter(r => !haveU.has(r));
const ok = missH.length === 0 && missU.length === 0;

// reconcile vs DB (national/capitals should match; regionals = new ABS basis)
const yrs = [latestYear - 2, latestYear - 1, latestYear];
const { data: db } = await sb.from('rdp_raw_series').select('region_slug,metric,period,value').in('metric', ['approvals_h', 'approvals_u', 'commenced_h', 'commenced_u']).eq('freq', 'A').gte('period', `${yrs[0]}-01-01`);
const dbMap = {}; for (const r of (db || [])) dbMap[`${r.metric}|${r.region_slug}|${r.period.slice(0, 4)}`] = Math.round(+r.value);
const newMap = {}; for (const r of rows) newMap[`${r.metric}|${r.region_slug}|${r.period.slice(0, 4)}`] = r.value;
const n = v => v == null ? '   —' : String(v).padStart(7);
function tier(title, slugs) {
  console.log(`\n${title}  (H new/DB · U new/DB, ${latestYear})`);
  for (const s of slugs) {
    const hk = `approvals_h|${s}|${latestYear}`, uk = `approvals_u|${s}|${latestYear}`;
    console.log(`  ${s.padEnd(15)} H ${n(newMap[hk])}/${n(dbMap[hk])}    U ${n(newMap[uk])}/${n(dbMap[uk])}`);
  }
}
console.log(`ABS Building Approvals — ${rows.length} annual rows, latest year ${latestYear}.`);
tier('NATIONAL + CAPITALS', Object.keys(GCCSA));
tier('REGIONALS (new ABS BA_LGA basis — differ from old DB)', Object.keys(LGA));
const cy = rows.filter(r => r.metric.startsWith('commenced_')).reduce((a, r) => Math.max(a, +r.period.slice(0, 4)), 0);
if (cy) { console.log(`\nDWELLINGS COMMENCED (national, new/DB) — latest ${cy}`);
  for (const metric of ['commenced_h', 'commenced_u']) { const k = y => `${metric}|australia|${y}`; console.log(`  ${metric.padEnd(15)} ` + [cy - 1, cy].map(y => `${y}: ${n(newMap[k(y)])}/${n(dbMap[k(y)])}`).join('   ')); } }
if (warn.length) console.log('\n⚠ ', warn.join('\n   '));
console.log(`\nCompleteness ${latestYear}: ${ok ? 'OK' : 'missing H[' + missH.join(',') + '] U[' + missU.join(',') + ']'}`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert (upsert-only; never deletes).'); process.exit(ok ? 0 : 1); }

let written = 0;
for (let k = 0; k < rows.length; k += 500) { const chunk = rows.slice(k, k + 500); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\n', error.message); process.exit(1); } written += chunk.length; }
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS approvals ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: ok ? 'ok' : 'partial', notes: `Building approvals houses+units (national+capitals BA_GCCSA, regionals BA_LGA calendar-stitched) + national dwellings commenced (BUILDING_ACTIVITY M6), annual per rule, through ${latestYear}.` });
await recordStatus(ok ? 'ok' : 'error', ok ? `All tiers through ${latestYear}. Regionals on current ABS BA_LGA.` : `Incomplete for ${latestYear}.`, { row_count: written, region_count: expected.length, latest_year: latestYear });
console.log(`\n✓ Upserted ${written} rows.`);
process.exit(ok ? 0 : 1);
