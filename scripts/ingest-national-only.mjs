// =============================================================================
// ingest-national-only.mjs — Data Forge "National Only" card. Assembles ONE
// jsonb (forge_national_only) from several national sources. API where it
// exists; two series (Federal Budget, Household composition) are SEEDED here
// (no annual API) and updated at their natural cadence.
//
//   workDone ............ ABS CWD (Value of work done, ENGINEERING construction
//                          type 04, current price, Original, AUS) — public +
//                          private, Q. (Matches the Data Dump basis; total &
//                          building did not.)
//   govtDebtGdp ......... IMF DataMapper GGXWDN_G01_GDP_PT/AUS (NET general-govt
//                          debt % of GDP, incl. IMF projections) — annual
//   householdDebtIncome . RBA E2 series BHFDDIT (household debt to income %) — Q
//   gdpByCountry ........ IMF DataMapper NGDPD + GGXWDG_NGDP — 20 countries,
//                          latest reference year
//   cashRate ............ RBA cash rate from rdp_raw_series (already ingested), M
//   federalBudget ....... SEEDED (Treasury underlying cash balance, $m by FY) —
//                          update at each Budget / MYEFO
//   householdComposition  SEEDED (ABS Census family/household type) — update at
//                          the next census (2026)
//
// Writes ONLY forge_national_only (jsonb, id='latest') + rdp_runs +
// forge_data_status (data_key='national_only'). Dry-run by default; --write.
//   node scripts/ingest-national-only.mjs            # dry run
//   node scripts/ingest-national-only.mjs --write    # upsert
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const ABS = 'https://data.api.abs.gov.au/rest';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120' };
// JSON fetch with a browser UA + retry — institutional sites (imf.org) sometimes
// serve a WAF/HTML block page to plain or cloud (CI) requests; UA + retry clears most.
const fetchJsonRetry = async (url, accept, tries = 3) => {
  let err;
  for (let a = 1; a <= tries; a++) {
    try { const r = await fetch(url, { headers: { ...UA, Accept: accept } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`${r.status} non-JSON: ${t.slice(0, 60).replace(/\s+/g, ' ')}`); } }
    catch (e) { err = e; if (a < tries) await new Promise(s => setTimeout(s, 1500 * a)); }
  }
  throw err;
};
const getAbs = u => fetchJsonRetry(u, 'application/vnd.sdmx.data+json');
const Q_MONTH = { Q1: '01', Q2: '04', Q3: '07', Q4: '10' };

// ── SEEDED: Federal Budget — underlying cash balance ($m) by financial year ──
// (Treasury Budget papers; no API. Update each Budget / MYEFO.)
// Underlying cash balance ($m) by financial year — full series rebuilt from the
// authoritative PBO "Historical Fiscal Data — 2026-27 Budget" (Table 4; the same
// series as Budget Paper No.1 Statement 11). Actuals through 2024-25, forward
// estimates 2025-26 → 2029-30. (Per PBO note (d): between 2005-06 and 2019-20 the
// UCB nets off Future Fund earnings; other years = receipts − payments.)
const FEDERAL_BUDGET = [["2011-12",-43360],["2012-13",-18834],["2013-14",-48456],["2014-15",-37867],["2015-16",-39606],["2016-17",-33151],["2017-18",-10141],["2018-19",-690],["2019-20",-85272],["2020-21",-134171],["2021-22",-31962],["2022-23",22064],["2023-24",15779],["2024-25",-9990],["2025-26",-28284],["2026-27",-31542],["2027-28",-31000],["2028-29",-34445],["2029-30",-25259]];

// ── SEEDED: Household composition by type (ABS Census; update next census) ──
const HH_TYPES = ["Couple with children","Couples without children","One parent families","Other families","Group household","Lone person","Other not classifiable household","Visitor only households"];
const HH_COMPOSITION = [[1991,[2298141,1337576,540127,80048,256049,1130358,102389,107811]],[1996,[2379899,1617533,675582,87090,281389,1488876,96556,131812]],[2001,[2311076,1722930,743160,88862,262558,1616215,183441,143968]],[2006,[2345632,1887682,799752,89682,280850,1740466,322286,129801]],[2011,[2511700,2072767,867913,97706,320990,1888549,279250,142875]],[2016,[2687377,2198551,919133,102563,354925,2023544,427124,148425]],[2021,[2912503,2487806,1033384,108940,361826,2370731,372331,160887]]];

// ── countries for the GDP / debt comparison (ISO3) ──
const COUNTRIES = [["USA","United States"],["CHN","China"],["JPN","Japan"],["DEU","Germany"],["IND","India"],["GBR","United Kingdom"],["FRA","France"],["BRA","Brazil"],["ITA","Italy"],["CAN","Canada"],["RUS","Russia"],["MEX","Mexico"],["AUS","Australia"],["KOR","South Korea"],["ESP","Spain"],["IDN","Indonesia"],["NLD","Netherlands"],["TUR","Turkey"],["SAU","Saudi Arabia"],["CHE","Switzerland"]];

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const FK = 'national_only', FLABEL = 'National Only', FSOURCE = 'ABS CWD + IMF DataMapper + RBA + seeded (Budget/Census)';
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return; const now = new Date().toISOString();
  const row = { data_key: FK, label: FLABEL, source: FSOURCE, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated — ' + error.message + ')');
}

const data = { meta: { updatedAt: new Date().toISOString() } };
try {
  // ── Work Done: ABS CWD, M1 (value of work done), current price, ENGINEERING
  // construction (type 04 — matches the Data Dump "Value of Work Done" basis,
  // NOT total/building), Original, AUS, public(5)+private(1) ──
  {
    const j = await getAbs(`${ABS}/data/CWD/M1.CUR.1+5.04.10.AUS.Q?startPeriod=1986&dimensionAtObservation=AllDimensions&format=jsondata`);
    const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
    const sI = od.findIndex(d => d.id === 'SECTOR_OWN'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
    const pub = {}, priv = {}; const pset = new Set();
    for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
      const ix = k.split(':').map(Number); const sec = od[sI].values[ix[sI]].id; const t = od[tI].values[ix[tI]].id;
      const m = t.match(/^(\d{4})-(Q[1-4])$/); if (!m) continue; const p = `${m[1]}-${Q_MONTH[m[2]]}-01`; pset.add(p);
      const val = v[0] / 1000;   // CWD is $thousands → $m
      if (sec === '5') pub[p] = val; else if (sec === '1') priv[p] = val;
    }
    const periods = [...pset].sort();
    data.workDone = { periods, public: periods.map(p => pub[p] ?? null), private: periods.map(p => priv[p] ?? null), unit: '$m', freq: 'Q' };
  }
  // ── Govt Debt to GDP (AUS) + GDP-by-country: IMF DataMapper ──
  const imf = async ind => { const j = await fetchJsonRetry(`https://www.imf.org/external/datamapper/api/v1/${ind}/${COUNTRIES.map(c => c[0]).join(',')}`, 'application/json'); return (j.values && j.values[ind]) || {}; };
  const gdpAll = await imf('NGDPD'), debtAll = await imf('GGXWDG_NGDP');
  {
    // Govt debt-to-GDP = NET general government, LIVE from the IMF DataMapper.
    // (History: this was a hand-seeded series from the old Data Dump because the
    // indicator code tried back then — GGXWDN_NGDP — returned nothing for AUS.
    // The current DataMapper code GGXWDN_G01_GDP_PT carries full AUS coverage,
    // 1990 → IMF projections, verified 2026-08-10. The old seed also couldn't be
    // matched to ANY published measure and had an impossible 45→34.5 move into
    // COVID-2020 — rebuilt on Van's call, 2026-08-10.) The by-country comparison
    // (p28) stays on IMF gross (debtAll). Values are % of GDP, 1dp.
    const netAll = await imf('GGXWDN_G01_GDP_PT');
    const NET = netAll.AUS || {};
    const years = Object.keys(NET).sort();
    if (!years.length) throw new Error('IMF net-debt series empty for AUS — check indicator GGXWDN_G01_GDP_PT');
    data.govtDebtGdp = { years, values: years.map(y => Math.round(NET[y] * 10) / 10), unit: '% of GDP',
      note: 'IMF DataMapper GGXWDN_G01_GDP_PT — general government NET debt, % of GDP (incl. IMF projections); auto-refreshes with this ingest' };
  }
  {
    // reference year = latest ≤ current year present for Australia
    const yrs = Object.keys(gdpAll.AUS || {}).filter(y => +y <= new Date().getUTCFullYear()).sort(); const refYear = yrs[yrs.length - 1];
    const rows = COUNTRIES.map(([code, name]) => ({ code, country: name, gdpTn: (gdpAll[code] && gdpAll[code][refYear] != null) ? +(gdpAll[code][refYear] / 1000).toFixed(2) : null, debtPct: (debtAll[code] && debtAll[code][refYear] != null) ? debtAll[code][refYear] : null }))
      .filter(r => r.gdpTn != null).sort((a, b) => b.gdpTn - a.gdpTn);
    data.gdpByCountry = { year: refYear, rows };
  }
  // ── Household debt-to-income: RBA E2 BHFDDIT (quarterly %) ──
  {
    const txt = await (await fetch('https://www.rba.gov.au/statistics/tables/csv/e2-data.csv', { headers: UA })).text();
    const lines = txt.split(/\r?\n/); const idRow = lines.findIndex(l => l.startsWith('Series ID')); const ci = lines[idRow].split(',').indexOf('BHFDDIT');
    const periods = [], values = [];
    for (let i = idRow + 1; i < lines.length; i++) { const c = lines[i].split(','); const d = (c[0] || '').trim(); const v = Number(c[ci]); if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(d) || isNaN(v) || c[ci] === '') continue; const [dd, mm, yy] = d.split('/'); periods.push(`${yy}-${mm.padStart(2, '0')}-01`); values.push(v); }
    data.householdDebtIncome = { periods, values, unit: '%' };
  }
  // ── Cash Rate: from rdp_raw_series (RBA, monthly) ──
  {
    const { data: cr } = await sb.from('rdp_raw_series').select('period,value').eq('source', 'rba').eq('metric', 'cash_rate').eq('freq', 'M').order('period');
    data.cashRate = { periods: (cr || []).map(r => r.period), values: (cr || []).map(r => +r.value), unit: '%' };
  }
  // ── seeded ──
  data.federalBudget = { fy: FEDERAL_BUDGET.map(r => r[0]), values: FEDERAL_BUDGET.map(r => r[1]), unit: '$m', note: 'Underlying cash balance, Treasury Budget papers (seeded — update each Budget/MYEFO)' };
  data.householdComposition = { types: HH_TYPES, years: HH_COMPOSITION.map(r => r[0]), data: Object.fromEntries(HH_COMPOSITION.map(r => [r[0], r[1]])), note: 'ABS Census (seeded — update at next census)' };
} catch (e) {
  console.error('\n✗ Assembly failed:', e.message); await recordStatus('error', `Assembly failed: ${e.message}`); process.exit(1);
}

// ── report ──
const wd = data.workDone, q = wd.periods[wd.periods.length - 1];
console.log('National Only — assembled:\n');
console.log('  Work Done (CWD, $m, Q):      ', wd.periods.length, 'qtrs →', q, '| public $' + (wd.public[wd.public.length - 1] || 0).toFixed(0) + 'm · private $' + (wd.private[wd.private.length - 1] || 0).toFixed(0) + 'm');
console.log('  Govt Debt-to-GDP (IMF net):', data.govtDebtGdp.years.length, 'yrs → ' + data.govtDebtGdp.years.slice(-1)[0] + ' = ' + data.govtDebtGdp.values.slice(-1)[0] + '%');
console.log('  Household debt-to-income:    ', data.householdDebtIncome.periods.length, 'qtrs → ' + data.householdDebtIncome.periods.slice(-1)[0].slice(0, 7) + ' = ' + data.householdDebtIncome.values.slice(-1)[0] + '%');
console.log('  GDP by country (IMF ' + data.gdpByCountry.year + '):', data.gdpByCountry.rows.length, 'countries | top', data.gdpByCountry.rows[0].country, '$' + data.gdpByCountry.rows[0].gdpTn + 'tn/' + data.gdpByCountry.rows[0].debtPct + '%');
console.log('  Cash Rate (RBA, M):          ', data.cashRate.periods.length, 'months → ' + (data.cashRate.periods.slice(-1)[0] || '—'));
console.log('  Federal Budget (seeded):     ', data.federalBudget.fy.length, 'FYs → ' + data.federalBudget.fy.slice(-1)[0] + ' = $' + data.federalBudget.values.slice(-1)[0] + 'm');
console.log('  Household composition (seed):', data.householdComposition.years.length, 'censuses → ' + data.householdComposition.years.slice(-1)[0]);

const ok = wd.periods.length && data.govtDebtGdp.years.length && data.householdDebtIncome.periods.length && data.gdpByCountry.rows.length >= 15 && data.cashRate.periods.length;
if (!ok) { console.error('\n✗ A live series came back empty — not writing.'); await recordStatus('error', 'A live series was empty.'); process.exit(1); }

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert forge_national_only.'); process.exit(0); }
const now = new Date().toISOString();
const { error } = await sb.from('forge_national_only').upsert({ id: 'latest', data, uploaded_at: now, updated_at: now, uploaded_by: 'national-only-ingest' }, { onConflict: 'id' });
if (error) { console.error('\n', error.message); await recordStatus('error', error.message); process.exit(1); }
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `National Only ${now.slice(0, 7)}`, row_count: 7, status: 'ok', notes: `forge_national_only: workDone(CWD) + govtDebtGdp(IMF) + householdDebtIncome(RBA) + gdpByCountry(IMF ${data.gdpByCountry.year}) + cashRate(RBA) + seeded budget/composition` });
await recordStatus('ok', `5 API series + 2 seeded; GDP-by-country ref ${data.gdpByCountry.year}.`, { row_count: 7, latest_year: +data.gdpByCountry.year });
console.log('\n✓ Wrote forge_national_only.');
process.exit(0);
