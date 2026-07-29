// =============================================================================
// ingest-abs-unemployment.mjs — Data Forge: UNEMPLOYMENT (national + states +
// capitals + regionals), UNDEREMPLOYMENT (national + states) and UNDERUTILISATION
// (national + states). ABS, Original.
//
// SOURCES (per the user's Research Guides):
//   • National unemployment + states  → ABS Data API, dataflow LF, MEASURE M13
//     (Unemployment rate), SEX 3, AGE 1599, TSEST 10 (ORIGINAL), FREQ M.
//   • Underemployment (nat + states)  → ABS Data API, dataflow LF_UNDER,
//     PARM_ITEM M23 (Underemployment rate, proportion of labour force), Original.
//     State series run back to 1978 too — B/S page 33 plots its state's line.
//     (Probing gotcha: passing startPeriod makes a state series LOOK truncated.)
//   • Underutilisation (nat + states) → same dataflow, PARM_ITEM M24. This is the
//     guide's "Table X28. Underutilised persons by State and Territory and Sex".
//     ABS publishes NO capital-city underutilisation — X28 is state-level, X29 is
//     by age, and the 6291002 GCCSA cube has no such column — so a regional deck
//     shows its STATE. (That answers the guide's "same source as regular data?".)
//   • Capitals (Greater Capital City) → data cube 6291002.xlsx (Table 02,
//     "Labour force status by ... greater capital city ..."), column
//     "Greater <City> ; Unemployment rate ; Persons", Original. ABS does NOT
//     publish Greater Darwin there → Darwin uses MRM1 SA4 "701 Darwin".
//   • Regionals (SA4)                 → data cube MRM1.xlsx (6291.0.55.001
//     "Modelled estimates ... by SA4"), Table 5 = Unemployment rate, mapped
//     report-region -> SA4 (REGION_SA4 below). NOTE: ABS RETIRED the old SA4
//     series (the series IDs in the guides) and replaced them with these
//     modelled estimates with a REVISED history — so regional figures differ
//     from the pre-existing DB values. The user chose to adopt MRM1 (2026-06).
//
// RULE: stored ANNUAL (freq 'A', period YYYY-01-01) as DECIMAL fractions
//   (4.6% -> 0.046):  completed years = average of that year's months;
//   current year = "R90" = average of the latest 3 available months.
//
//   ISOLATED: rdp_raw_series (source='abs', metric unemployment|underemployment|
//   underutilisation)
//   + rdp_runs + forge_data_status ('unemployment'). Upsert-only. Dry-run by
//   DEFAULT; --write upserts; --from=YYYY (API history start, default 1978).
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);   // scripts/ is under the project → node_modules resolves
const XLSX = require('xlsx');

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const FROM = +((process.argv.find(a => a.startsWith('--from=')) || '--from=1978').split('=')[1]) || 1978;
const API = 'https://data.api.abs.gov.au/rest';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' };
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); if (!t.trim().startsWith('{')) throw new Error(`ABS ${r.status}: ${t.slice(0, 100)}`); return JSON.parse(t); };
const STATE = { AUS: 'australia', '1': 'st-nsw', '2': 'st-vic', '3': 'st-qld', '4': 'st-sa', '5': 'st-wa', '6': 'st-tas', '7': 'st-nt', '8': 'st-act' };
// report region -> MRM1 SA4 row label (geographically correct; confirmed vs the guide groupings)
const REGION_SA4 = {
  albury: '109 Murray', ballarat: '201 Ballarat', bendigo: '202 Bendigo', bunbury: '501 Bunbury',
  bundaberg: '319 Wide Bay', cairns: '306 Cairns', 'central-coast': '102 Central Coast',
  'coffs-harbour': '104 Coffs Harbour - Grafton', geelong: '203 Geelong', gladstone: '308 Central Queensland',
  'gold-coast': '309 Gold Coast', ipswich: '310 Ipswich', launceston: '602 Launceston and North East',
  mackay: '312 Mackay - Isaac - Whitsunday', mandurah: '502 Mandurah', mildura: '215 Victoria - North West',
  newcastle: '111 Newcastle and Lake Macquarie', orange: '103 New South Wales - Central West',
  'port-macquarie': '108 Mid North Coast', rockhampton: '308 Central Queensland', rockingham: '507 Perth - South West',
  'sunshine-coast': '316 Sunshine Coast', tamworth: '110 New England and North West', toowoomba: '317 Toowoomba',
  townsville: '318 Townsville', 'wagga-wagga': '113 Riverina', wodonga: '204 Hume', wollongong: '107 Illawarra',
};
const CAPITALS = ['sydney', 'melbourne', 'brisbane', 'adelaide', 'perth', 'hobart'];   // from 6291002 GCCSA; darwin via MRM1 701

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: 'unemployment', label: 'Unemployment, Underemployment & Underutilisation', source: 'ABS Labour Force (LF/LF_UNDER API + 6291002 GCCSA + MRM1 SA4), Original', status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated? ' + error.message + ')');
}

const serialYM = s => { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(s) * 86400000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
// monthly {ym:pct} -> annual rows (completed years = avg; latest year = avg of last 3 months)
function annualRows(monthly, metric, region) {
  const byYear = {};
  for (const [ym, val] of Object.entries(monthly)) (byYear[ym.slice(0, 4)] ||= []).push([ym, val]);
  const years = Object.keys(byYear).sort(); const latestY = years[years.length - 1];
  return years.map(y => {
    const vals = byYear[y].sort((a, b) => a[0] < b[0] ? -1 : 1).map(x => x[1]);
    const use = y === latestY ? vals.slice(-3) : vals;
    return { source: 'abs', region_slug: region, metric, freq: 'A', period: `${y}-01-01`, value: +(use.reduce((a, b) => a + b, 0) / use.length / 100).toFixed(4) };
  });
}
// ABS API: one measure/code from a dataflow → { region_slug: {ym:val} }
async function fetchAPI(flow, code, regionsCsv, regMap) {
  const j = await getJson(`${API}/data/${flow}/${code}.3.1599.10.${regionsCsv}.M?startPeriod=${FROM}-01&format=jsondata&dimensionAtObservation=AllDimensions`);
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const rI = od.findIndex(d => d.id === 'REGION'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  const out = {};
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    const reg = regMap[od[rI].values[ix[rI]].id]; if (!reg) continue;
    const ym = od[tI].values[ix[tI]].id; if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    (out[reg] ||= {})[ym] = v[0];
  }
  return out;
}
// ABS detailed data cube — try recent months newest-first (the release lags ~1-2 months)
async function dlCube(file) {
  const now = new Date(); const mon = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  for (let back = 0; back < 10; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const tag = `${mon[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
    const url = `https://www.abs.gov.au/statistics/labour/employment-and-unemployment/labour-force-australia-detailed/${tag}/${file}`;
    try { const r = await fetch(url, { headers: UA }); if (r.ok) return { buf: Buffer.from(await r.arrayBuffer()), tag }; } catch {}
  }
  throw new Error('could not download ' + file + ' from any recent month');
}
// capitals from 6291002: "Greater <City> ; Unemployment rate ; Persons", Original
function parseCapitals(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' }); const out = {};
  for (const sh of wb.SheetNames.filter(n => /^Data/.test(n))) {
    const r = XLSX.utils.sheet_to_json(wb.Sheets[sh], { header: 1, raw: true, blankrows: false });
    const typeRow = r.find(x => (x[0] || '') === 'Series Type') || [];   // Original | Seasonally Adjusted | Trend
    (r[0] || []).forEach((d, ci) => {
      if (typeof d !== 'string') return;
      // exact "Greater <City> ; Unemployment rate ; Persons" — not the
      // "Unemployment rate - looking for full-time work" sub-series.
      const m = d.match(/Greater (Sydney|Melbourne|Brisbane|Adelaide|Perth|Hobart)\s*;\s*Unemployment rate\s*;\s*Persons\b/i);
      if (!m) return;
      if (!/original/i.test(typeRow[ci] || '')) return;   // ORIGINAL only (per the rule)
      const slug = m[1].toLowerCase(); const mm = {};
      for (const row of r.slice(10)) if (typeof row[0] === 'number' && typeof row[ci] === 'number') mm[serialYM(row[0])] = row[ci];
      out[slug] = mm;
    });
  }
  return out;
}
// SA4 unemployment rate from MRM1 Table 5 → { 'NNN Name': {ym:val} }
function parseMRM1(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Table 5'], { header: 1, raw: true, blankrows: false });
  const cols = (rows[4] || []).map((v, i) => i > 0 && typeof v === 'number' ? { i, ym: serialYM(v) } : null).filter(Boolean);
  const sa4 = {};
  for (const row of rows.slice(5)) { const name = (row[0] || '').toString().trim(); if (!name || /^SA4|^\(a\)/.test(name)) continue; const mm = {}; for (const c of cols) if (typeof row[c.i] === 'number') mm[c.ym] = row[c.i]; sa4[name] = mm; }
  return sa4;
}

const rows = []; const warn = [];
try {
  // ── API: national + states unemployment, national underemployment ──
  const unemp = await fetchAPI('LF', 'M13', Object.keys(STATE).join('+'), STATE);
  /* Underemployment: national AND the 8 states. ABS serves M23 by state back to
     1978-02 (581 monthly obs) — the same depth as the national series — so the
     B/S Underutilisation slide can plot its state's underemployment line.
     (Careful when probing this by hand: passing startPeriod makes it LOOK like
     the state series only begins there.) */
  const under = await fetchAPI('LF_UNDER', 'M23', Object.keys(STATE).join('+'), STATE);
  // Underutilisation rate (M24 = unemployment + underemployment). ABS publishes it
  // for the nation and the 8 states ONLY — Table X28 is "by State and Territory and
  // Sex", X29 is by age, and the GCCSA cube (6291002) carries no underutilisation
  // column at all. So there is NO capital-city series to be had; regional decks read
  // their state. (This answers the "same source as regular data?" note in the guide.)
  const underutil = await fetchAPI('LF_UNDER', 'M24', Object.keys(STATE).join('+'), STATE);
  for (const [reg, m] of Object.entries(unemp)) rows.push(...annualRows(m, 'unemployment', reg));
  for (const [reg, m] of Object.entries(under)) rows.push(...annualRows(m, 'underemployment', reg));
  for (const [reg, m] of Object.entries(underutil)) rows.push(...annualRows(m, 'underutilisation', reg));
  // ── Capitals (6291002 GCCSA) ──
  const cap = await dlCube('6291002.xlsx'); const caps = parseCapitals(cap.buf);
  for (const slug of CAPITALS) { if (caps[slug]) rows.push(...annualRows(caps[slug], 'unemployment', slug)); else warn.push(`capital ${slug} not found in 6291002`); }
  // ── Regionals + Darwin capital (MRM1 SA4 Table 5) ──
  const reg = await dlCube('MRM1.xlsx'); const sa4 = parseMRM1(reg.buf);
  const need = { ...REGION_SA4, darwin: '701 Darwin' };
  for (const [slug, name] of Object.entries(need)) { if (sa4[name]) rows.push(...annualRows(sa4[name], 'unemployment', slug)); else warn.push(`region ${slug} -> SA4 "${name}" not found in MRM1`); }
  console.log(`Cubes: capitals 6291002 (${cap.tag}), regionals MRM1 (${reg.tag}).`);
} catch (e) { console.error('\n✗ fetch/parse failed:', e.message); await recordStatus('error', `fetch/parse failed: ${e.message}`); process.exit(1); }

// completeness
const latestYear = rows.reduce((a, r) => Math.max(a, +r.period.slice(0, 4)), 0);
const regionsLatest = new Set(rows.filter(r => r.metric === 'unemployment' && +r.period.slice(0, 4) === latestYear).map(r => r.region_slug));
const expected = ['australia', ...Object.keys(STATE).filter(k => k !== 'AUS').map(k => STATE[k]), ...CAPITALS, 'darwin', ...Object.keys(REGION_SA4)];
const missing = expected.filter(r => !regionsLatest.has(r));
const ok = missing.length === 0 && rows.some(r => r.metric === 'underemployment' && +r.period.slice(0, 4) === latestYear);

// reconcile vs DB (recent years) — national/states/capitals should match; regionals are the new MRM1 basis
const yrs = [latestYear - 2, latestYear - 1, latestYear];
const { data: db } = await sb.from('rdp_raw_series').select('region_slug,metric,period,value').eq('source', 'abs').in('metric', ['unemployment', 'underemployment', 'underutilisation']).eq('freq', 'A').gte('period', `${yrs[0]}-01-01`);
const dbMap = {}; for (const r of (db || [])) dbMap[`${r.metric}|${r.region_slug}|${r.period.slice(0, 4)}`] = +r.value;
const newMap = {}; for (const r of rows) newMap[`${r.metric}|${r.region_slug}|${r.period.slice(0, 4)}`] = r.value;
const pct = v => v == null ? '  — ' : (v * 100).toFixed(2).padStart(5);
function tier(title, keys) {
  console.log(`\n${title}` + `  (new / DB, ${yrs.join('/')})`);
  for (const [metric, region] of keys) {
    const k = y => `${metric}|${region}|${y}`;
    if (!yrs.some(y => newMap[k(y)] != null)) continue;
    console.log(`  ${(metric === 'underemployment' ? 'underemp ' : metric === 'underutilisation' ? 'underutil ' : '') + region}`.padEnd(20) + yrs.map(y => `${pct(newMap[k(y)])}/${pct(dbMap[k(y)])}`).join('  '));
  }
}
console.log(`\nABS Original — ${rows.length} annual rows, latest year ${latestYear}.`);
tier('NATIONAL + STATES + UNDEREMP', [['unemployment','australia'],['underemployment','australia'],...Object.keys(STATE).filter(k=>k!=='AUS').map(k=>['unemployment',STATE[k]])]);
tier('UNDERUTILISATION (national + states)', [['underutilisation','australia'],...Object.keys(STATE).filter(k=>k!=='AUS').map(k=>['underutilisation',STATE[k]])]);
tier('UNDEREMPLOYMENT (national + states)', [['underemployment','australia'],...Object.keys(STATE).filter(k=>k!=='AUS').map(k=>['underemployment',STATE[k]])]);
tier('CAPITALS', [...CAPITALS,'darwin'].map(c=>['unemployment',c]));
tier('REGIONALS (new MRM1 basis — expected to differ from old DB)', Object.keys(REGION_SA4).map(r=>['unemployment',r]));
if (warn.length) console.log('\n⚠ ', warn.join('\n   '));
console.log(`\nCompleteness for ${latestYear}: ${ok ? 'OK' : 'MISSING ' + missing.join(', ')}`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert (upsert-only; never deletes).'); process.exit(ok ? 0 : 1); }

let written = 0;
for (let k = 0; k < rows.length; k += 500) { const chunk = rows.slice(k, k + 500); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\n', error.message); process.exit(1); } written += chunk.length; }
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS unemployment ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: ok ? 'ok' : 'partial', notes: `Unemployment (national+states API, capitals 6291002, regionals MRM1 SA4) + underemployment (national) + underutilisation (national+states), Original, annual per R90 rule, through ${latestYear}.` });
await recordStatus(ok ? 'ok' : 'error', ok ? `All tiers through ${latestYear}. Regionals now on ABS MRM1 modelled SA4 estimates.` : `Incomplete for ${latestYear}: ${missing.join(', ')}`, { row_count: written, region_count: regionsLatest.size, latest_year: latestYear });
console.log(`\n✓ Upserted ${written} rows.`);
process.exit(ok ? 0 : 1);
