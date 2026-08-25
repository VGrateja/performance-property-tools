// =============================================================================
// build-vr-forecast.mjs  —  L2 mart builder for rdp_vr_forecast.
//
// Reads the VR Projections workbook's "1 yr Vacancy Rate Forecast" tab (the
// authoritative source), runs VrForecastCalc per region, VERIFIES against the
// workbook's own output (Expected VR / households), and upserts a per-region
// jsonb payload into rdp_vr_forecast. Shared dataset (used by reports + the
// Buying/Selling VR slide), so deck_type-agnostic.
//
// Dry-run by DEFAULT (parse + verify); --write upserts + logs rdp_runs.
//   node scripts/build-vr-forecast.mjs ["<vr.xlsx>"]            # dry run
//   node scripts/build-vr-forecast.mjs ["<vr.xlsx>"] --write     # upsert
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import './../shared/vr-forecast-calc.js';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sb = KEY ? createClient(URL, KEY, { auth: { persistSession: false } }) : null;   // read approvals even in dry-run

// city-slug resolver (same conventions as the ingestion)
const ST = 'act|nsw|nt|qld|sa|tas|vic|wa';
const SLUGS = new Set(['australia','sydney','melbourne','brisbane','perth','adelaide','canberra','hobart','darwin','mackay','bundaberg','ipswich','rockhampton','gladstone','cairns','townsville','sunshine-coast','toowoomba','gold-coast','albury','central-coast','coffs-harbour','newcastle','orange','port-macquarie','tamworth','wagga-wagga','wollongong','ballarat','bendigo','geelong','wodonga','mildura','mandurah','rockingham','bunbury','launceston']);
function resolveCity(label) {
  if (label == null) return null; let s = String(label).trim();
  if (s === '' || /^year$/i.test(s)) return null;
  if (/^national$/i.test(s)) return 'australia';
  s = s.replace(/\([^)]*\)/g, ' ').replace(new RegExp(',\\s*(' + ST + ')\\b', 'ig'), ' ').replace(/\b\d{3,4}\b/g, ' ').replace(/\bgreater\b/ig, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return SLUGS.has(s) ? s : null;
}

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const FILE = argv.find(a => !a.startsWith('--')) || join(homedir(), 'Downloads', 'UPDATED Vacancy Rate Projections.xlsx');
if (!existsSync(FILE)) { console.error('File not found:', FILE); process.exit(1); }
const wb = XLSX.readFile(FILE, { cellFormula: true });   // keep cell formulas: column J decides OE vs approvals per region
const WS1 = wb.Sheets['1 yr Vacancy Rate Forecast'];
const g = XLSX.utils.sheet_to_json(WS1, { header: 1, raw: true, defval: '' });

// header row (row 3, index 2) -> column index by name
const hdr = (g[2] || []).map(h => String(h).replace(/\s+/g, ' ').trim().toLowerCase());
const col = pred => hdr.findIndex(pred);
const C = {
  region: 0, state: 1,
  population: col(h => h.includes('total population')),
  hhSize: col(h => h.includes('median hh size')),
  currentVR: col(h => h.includes('current vr')),
  oe: col(h => h.includes('oe commencement')),
  nb: col(h => h === 'nb'), im: col(h => h === 'im'), om: col(h => h === 'om'),
  expHH: col(h => h.includes('households expected')),
  expVR: col(h => h.includes('expected vr')),
};
const need = ['population', 'hhSize', 'currentVR', 'oe', 'nb', 'im', 'om', 'expHH', 'expVR'].filter(k => C[k] < 0);
if (need.length) { console.error('Missing columns:', need.join(', '), '| headers:', hdr.join(' | ')); process.exit(1); }

const close = (a, b, rel = 1e-3) => (a == null || b == null) ? false : Math.abs(a - b) <= 1e-6 + rel * Math.abs(b);
const numv = v => (typeof v === 'number' && isFinite(v)) ? v : null;

// ── Incoming-supply source (replaces the workbook's hardcoded 2026 column) ──
// OE Commencements: store every year (2025-2029); the CURRENT calendar year's
// column is what feeds the forecast (auto-advances 2026→2027→… on each re-seed).
const CUR_YEAR = new Date().getFullYear();
// OE vs approvals is decided PER REGION by the sheet's column-J formula (checked
// in the loop): vlookup('OE Commencements'…) → use OE; "=I" (discounted approvals)
// → use approvals. A region can HAVE OE data but still be an approvals region
// (e.g. Bunbury), so we trust the sheet's formula, not merely "has OE data".
const oeByYearBySlug = {};
{
  const oe = XLSX.utils.sheet_to_json(wb.Sheets['OE Commencements'] || {}, { header: 1, raw: true, defval: '' });
  for (let r = 1; r < oe.length; r++) {
    const label = String(oe[r][0] || '').trim(); if (!label) continue;
    const slug = resolveCity(label); if (!slug) continue;
    const yrs = {}; for (let y = 2025; y <= 2029; y++) { const v = numv(oe[r][y - 2025 + 1]); if (v != null) yrs[y] = v; }
    if (Object.keys(yrs).length) oeByYearBySlug[slug] = yrs;
  }
}
// OM (net overseas migration): a Treasury forward projection by FINANCIAL year
// (2023-24 … 2026-27) on the OM tab. Store per CALENDAR (ending) year so the
// forecast auto-advances like OE — 2026 uses FY2025-26, 2027 will use FY2026-27.
// NB + IM are fixed 2-yr averages (no forward years), so only OM advances.
const omByYearBySlug = {};
{
  const om = XLSX.utils.sheet_to_json(wb.Sheets['OM'] || {}, { header: 1, raw: true, defval: '' });
  const yrHdr = om[1] || [];                                       // row 1: [Year, 2023-24, 2023-24(=%), 2024-25, 2025-26, 2026-27]
  const natl = om.find(r => String(r[0]).trim().toLowerCase() === 'national') || [];
  const colYear = {};                                              // value-column index → calendar (ending) year
  for (let c = 1; c < yrHdr.length; c++) {
    const m = String(yrHdr[c]).match(/^(\d{4})-(\d{2})$/); if (!m) continue;
    if (Math.abs(numv(natl[c]) || 0) <= 100) continue;             // skip the "% of national" column (National ≈ 1)
    colYear[c] = Math.floor(+m[1] / 100) * 100 + (+m[2]);          // "2025-26" → 2026
  }
  for (let r = 2; r < om.length; r++) {
    const slug = resolveCity(String(om[r][0] || '').trim()); if (!slug) continue;
    const by = {}; for (const c in colYear) { const v = numv(om[r][c]); if (v != null) by[colYear[c]] = v; }
    if (Object.keys(by).length) omByYearBySlug[slug] = by;
  }
}
// Forge Total Approvals (house+unit, latest year) — the fallback for regions with
// no OE data. Read from rdp_raw_series (the Building Approvals data point).
const forgeAppr = {};
if (sb) {
  const { data: appr } = await sb.from('rdp_raw_series').select('region_slug,metric,period,value').in('metric', ['approvals_h', 'approvals_u']).eq('freq', 'A').gte('period', '2018-01-01');   // period floor keeps us under the 1000-row cap
  const byY = {};
  for (const row of (appr || [])) { const y = +String(row.period).slice(0, 4); const s = row.region_slug; (byY[s] ??= {}); (byY[s][y] ??= { h: null, u: null }); byY[s][y][row.metric === 'approvals_h' ? 'h' : 'u'] = +row.value; }
  for (const s of Object.keys(byY)) { const ys = Object.keys(byY[s]).map(Number).sort((a, b) => b - a); for (const y of ys) { const rec = byY[s][y]; if (rec.h != null || rec.u != null) { forgeAppr[s] = { total: (rec.h || 0) + (rec.u || 0), year: y }; break; } } }
}

// Population — the Forge Population data point (rdp_raw_series metric='population',
// latest year). Current VR — the SQM vacancy from the Demand Score Dashboard Data
// card (forge_demand_inputs.vr, stored as a %). Both replace the workbook inputs.
// Rent has two live sources too (mirrors VR): SQM (Demand Score card) + CoreLogic
// (Cotality rentvacancy store). Both weekly. The tool picks the one matching the
// selected VR source; the forecast is rent + workbook slope × that source's VR change.
const forgePop = {}, forgeVR = {}, forgeRentSqm = {}, forgeRentCot = {};
if (sb) {
  const { data: pop } = await sb.from('rdp_raw_series').select('region_slug,period,value').eq('metric', 'population').gte('period', '2020-01-01');   // period floor keeps us under the 1000-row cap
  const latest = {};
  for (const row of (pop || [])) { const s = row.region_slug; if (!latest[s] || row.period > latest[s].period) latest[s] = { period: row.period, value: +row.value }; }
  for (const s of Object.keys(latest)) forgePop[s] = latest[s].value;
  const { data: di } = await sb.from('forge_demand_inputs').select('data').eq('id', 'latest').maybeSingle();
  const dreg = (di && di.data && di.data.regions) || {};
  for (const s of Object.keys(dreg)) { const d = dreg[s]; if (!d) continue;
    if (d.vr != null && isFinite(+d.vr)) forgeVR[s] = +d.vr / 100;   // % → fraction
    if (d.rent_h != null || d.rent_u != null) forgeRentSqm[s] = { h: d.rent_h != null ? +d.rent_h : null, u: d.rent_u != null ? +d.rent_u : null };
  }
  const { data: rvRow } = await sb.from('forge_cotality').select('data').eq('id', 'rentvacancy').maybeSingle();
  const rv = rvRow && rvRow.data;
  for (const r of [].concat((rv && rv.capitals) || [], (rv && rv.regions) || [])) {
    const slug = resolveCity(String(r.name || '').trim()); if (!slug) continue;
    forgeRentCot[slug] = { h: r.rentHouse != null ? +r.rentHouse : null, u: r.rentUnit != null ? +r.rentUnit : null };
  }
}

const results = [];
const nimOverrides = [];   // regions whose NIM was forced (VR_NIM_OVERRIDES)
let checks = 0, pass = 0; const fails = []; const unresolved = [];
const srcCount = { oe: 0, forge_approvals: 0, workbook: 0 };
const popSrc = { forge: 0, workbook: 0 }, vrSrc = { forge_sqm: 0, workbook: 0 };
for (let r = 3; r < g.length; r++) {
  const row = g[r]; const label = String(row[C.region] || '').trim(); if (!label) continue;
  const slug = resolveCity(label); if (!slug) { unresolved.push(label); continue; }
  const inp = { population: numv(row[C.population]), hhSize: numv(row[C.hhSize]), currentVR: numv(row[C.currentVR]), nb: numv(row[C.nb]), im: numv(row[C.im]), om: numv(row[C.om]) };
  const wbOe = numv(row[C.oe]);

  // Integrity check: does VrForecastCalc reproduce the workbook when fed the
  // workbook's OWN oe input? (keeps the 74/74 verify meaningful, independent of
  // the sourcing change below.)
  const calcWb = globalThis.VrForecastCalc.computeVrForecast({ ...inp, oeCommencements: wbOe });
  if (!calcWb) { unresolved.push(label + ' (missing inputs)'); continue; }
  const expVR = numv(row[C.expVR]), expHH = numv(row[C.expHH]);
  for (const [k, mine, theirs] of [['forecastVR', calcWb.forecastVR, expVR], ['expNewHouseholds', calcWb.expNewHouseholds, expHH]]) {
    if (theirs == null) continue; checks++; if (close(mine, theirs)) pass++; else fails.push({ slug, k, mine, theirs });
  }

  // Incoming-supply input actually used: OE[current year] (no discount) → else
  // Forge Total Approvals × 0.9 (matches the sheet's 10% approvals discount) →
  // else the workbook's own value.
  const oy = oeByYearBySlug[slug];
  // Column-J formula is authoritative: OE regions vlookup the OE Commencements
  // tab; approvals regions use "=I". Fall back to "has OE data" only if no formula.
  const jCell = WS1[XLSX.utils.encode_cell({ r, c: C.oe })];
  const useOe = ((jCell && jCell.f) ? /oe commencement/i.test(jCell.f) : !!oy) && oy;
  let oeInput, oeSource, oeYear = null;
  if (useOe && oy[CUR_YEAR] != null) { oeInput = oy[CUR_YEAR]; oeSource = 'oe'; oeYear = CUR_YEAR; }
  else if (useOe && Object.keys(oy).length) { const yy = Object.keys(oy).map(Number).sort((a, b) => b - a)[0]; oeInput = oy[yy]; oeSource = 'oe'; oeYear = yy; }   // past 2029 → latest OE year
  else if (forgeAppr[slug] != null) { oeInput = forgeAppr[slug].total * 0.9; oeSource = 'forge_approvals'; oeYear = forgeAppr[slug].year; }
  else { oeInput = wbOe; oeSource = 'workbook'; }
  srcCount[oeSource]++;

  // Population + current VR from Forge (fall back to the workbook if a region is missing)
  const popUsed = forgePop[slug] != null ? forgePop[slug] : inp.population;
  const vrUsed = forgeVR[slug] != null ? forgeVR[slug] : inp.currentVR;
  const popSource = forgePop[slug] != null ? 'forge' : 'workbook';
  const vrSource = forgeVR[slug] != null ? 'forge_sqm' : 'workbook';
  popSrc[popSource]++; vrSrc[vrSource]++;

  // NIM override (see VR_NIM_OVERRIDES in shared/vr-forecast-calc.js). Applied
  // HERE and not above, so the workbook verify keeps comparing like with like.
  const nimOv = globalThis.VrForecastCalc.applyNimOverride(slug, inp);
  const inpUsed = nimOv.inp;
  if (nimOv.applied) nimOverrides.push(slug + ': NIM ' + Math.round(nimOv.raw) + ' -> ' + inpUsed.im);

  const calc = globalThis.VrForecastCalc.computeVrForecast({ ...inpUsed, population: popUsed, currentVR: vrUsed, oeCommencements: oeInput });
  results.push({ region_slug: slug, payload: {
    ...calc, oeCommencements: oeInput, oeSource, oeYear, oeByYear: oy || null,
    population: popUsed, popSource, vrSource, hhSize: inp.hhSize,
    nb: inpUsed.nb, im: inpUsed.im, om: inpUsed.om,
    imRaw: nimOv.applied ? nimOv.raw : null,        // the workbook figure the override replaced
    imOverride: nimOv.applied || null,              // so nobody later wonders why this region will not reconcile   // population-growth components (natural increase / net interstate / net overseas) — sum = expectedPeople
    omByYear: omByYearBySlug[slug] || null,   // OM forward projection by year → auto-advances (like oeByYear)
    rentHouseSqm: forgeRentSqm[slug] ? forgeRentSqm[slug].h : null, rentUnitSqm: forgeRentSqm[slug] ? forgeRentSqm[slug].u : null,   // live SQM rents
    rentHouseCot: forgeRentCot[slug] ? forgeRentCot[slug].h : null, rentUnitCot: forgeRentCot[slug] ? forgeRentCot[slug].u : null,   // live CoreLogic rents
  } });
}

// ── PRESENTATION sheet extras: 2yr VR forecast, rents (+1yr forecasts), OO%,
//    property surplus/deficit, 2yr HH & properties. Merged onto each region's
//    payload (the existing 1yr fields are untouched). Columns per the sheet:
//    I(8) surplus · E(4) 2yr HH · H(7) 2yr props · L(11) 2yr VR · M(12) OO% ·
//    N(13) house rent · P(15) 1yr house rent fc · Q(16) unit rent · S(18) unit fc.
{
  const pres = XLSX.utils.sheet_to_json(wb.Sheets['PRESENTATION'] || {}, { header: 1, raw: true, defval: '' });
  // 2-yr VR forecast comes from the dedicated "2 yr Vacancy Rate Forecast" tab (col L):
  // it adds year-2 (2027) commencements. PRESENTATION's own L reuses year-1 (2026)
  // commencements and is LOWER — do NOT use it for the 2yr number.
  // 2yr VR + its household/property basis ALL come from the dedicated 2yr tab so
  // they're mutually consistent (1 − 2yrHH/2yrProps === forecastVR2). PRESENTATION's
  // own 2yr HH/props reuse year-1 commencements and disagree with its own 2yr VR.
  //   2yr tab cols: E(4) 2yr HH · H(7) 2yr properties · L(11) 2yr VR forecast
  const twoyr = XLSX.utils.sheet_to_json(wb.Sheets['2 yr Vacancy Rate Forecast'] || {}, { header: 1, raw: true, defval: '' });
  const twoyrD = {};
  for (let r = 1; r < twoyr.length; r++) { const label = String(twoyr[r][0] || '').trim(); if (!label) continue; const slug = resolveCity(label); if (slug) twoyrD[slug] = { vr: numv(twoyr[r][11]), hh: numv(twoyr[r][4]), props: numv(twoyr[r][7]) }; }
  const extras = {};
  for (let r = 1; r < pres.length; r++) {
    const row = pres[r]; const label = String(row[0] || '').trim(); if (!label) continue;
    const slug = resolveCity(label); if (!slug) continue;
    const t = twoyrD[slug];
    extras[slug] = {
      forecastVR2: (t && t.vr != null) ? t.vr : numv(row[11]),           // dedicated 2yr tab; fall back to PRESENTATION
      twoYrHH: (t && t.hh != null) ? t.hh : numv(row[4]),                // 2yr HH/props from the SAME tab as the 2yr VR
      twoYrProps: (t && t.props != null) ? t.props : numv(row[7]),
      ooPct: numv(row[12]), surplus: numv(row[8]),
      rentHouse: numv(row[13]), rentHouseFc: numv(row[15]),
      rentUnit: numv(row[16]), rentUnitFc: numv(row[18]),
      rentHouseSlope: numv(row[14]), rentUnitSlope: numv(row[17]),   // $/VR-fraction sensitivity → forecast = rent + slope × VR change
    };
  }
  let merged = 0;
  for (const res of results) { const e = extras[res.region_slug]; if (e) { Object.assign(res.payload, e); merged++; } }
  console.log(`extras merged onto ${merged}/${results.length} regions (2yr VR from dedicated tab, rents, OO%, surplus).`);
}

console.log('regions parsed:', results.length, unresolved.length ? '| unresolved: ' + unresolved.join(', ') : '');
console.log(`VERIFY (calc reproduces workbook, using workbook inputs): ${pass}/${checks} match`);
if (fails.length) for (const f of fails.slice(0, 15)) console.log(`  ${f.slug} ${f.k}: calc=${f.mine} workbook=${f.theirs}`);
console.log(`incoming-supply source (year ${CUR_YEAR}): ${srcCount.oe} OE · ${srcCount.forge_approvals} Forge approvals×0.9 · ${srcCount.workbook} workbook`);
console.log(`population source: ${popSrc.forge} Forge · ${popSrc.workbook} workbook   |   current VR source: ${vrSrc.forge_sqm} Forge SQM · ${vrSrc.workbook} workbook`);
const adel = results.find(r => r.region_slug === 'adelaide');
if (adel) console.log(`adelaide: currentVR=${(adel.payload.currentVR*100).toFixed(2)}%  forecastVR=${(adel.payload.forecastVR*100).toFixed(2)}%  oe=${Math.round(adel.payload.oeCommencements)} (${adel.payload.oeSource} ${adel.payload.oeYear||''})`);

if (!WRITE) {
  console.log('\nDry run complete. Re-run with --write to upsert into rdp_vr_forecast.');
} else {
  if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
  const stamp = new Date().toISOString();
  let n = 0;
  for (const r of results) {
    const { error } = await sb.from('rdp_vr_forecast').upsert({ region_slug: r.region_slug, payload: r.payload, source_month: 'VR Projections 2026-06', computed_at: stamp }, { onConflict: 'region_slug' });
    if (error) { console.error('upsert', r.region_slug, error.message); process.exit(1); }
    n++; process.stdout.write(`\r  upserted ${n}/${results.length}`);
  }
  console.log('');
  await sb.from('rdp_runs').insert({ dataset: 'vr_forecast', source_month: 'VR Projections 2026-06', row_count: n, status: 'ok', notes: `${n} regions; VrForecastCalc (verified ${pass}/${checks}); supply from OE[year]/Forge approvals×0.9` });
  console.log(`✓ Built rdp_vr_forecast for ${n} regions.`);
}
