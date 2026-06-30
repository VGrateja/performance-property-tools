// =============================================================================
// enrich-marts.mjs  —  wire the deferred raw (pyramid / industry / arrears / JCI)
// into rdp_report_feed payloads as a `payload.extras` section.
//
// These are current snapshots, not per-year series, so they live alongside the
// verified `years` array rather than inside it. ISOLATED — touches only
// rdp_report_feed. Dry-run by DEFAULT; --write upserts + logs rdp_runs.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');

// state capital used as the state arrears/migration proxy
const STATECAP = { nsw: 'sydney', vic: 'melbourne', qld: 'brisbane', wa: 'perth', sa: 'adelaide', nt: 'darwin', act: 'canberra', tas: 'hobart' };
const AGE_ORDER = ['0_04','05_09','10_14','15_19','20_24','25_29','30_34','35_39','40_44','45_49','50_54','55_59','60_64','65_69','70_74','75_79','80_84','85_and_over'];

// load the relevant raw
let raw = [], from = 0;
for (;;) { const { data, error } = await sb.from('rdp_raw_series').select('region_slug,metric,freq,period,value').or('metric.like.pyr\\_%,metric.like.ind\\_%,metric.eq.arrears,metric.eq.jci,metric.eq.nom,metric.eq.nim,metric.eq.owner_occupier,metric.eq.investor').order('region_slug').order('metric').order('period').range(from, from + 999); if (error) { console.error(error.message); process.exit(1); } raw.push(...data.map(r => ({ ...r, value: Number(r.value) }))); if (data.length < 1000) break; from += 1000; }
const idx = Object.create(null);
for (const r of raw) { const k = r.region_slug + '|' + r.metric; (idx[k] || (idx[k] = [])).push(r); }
const latest = (slug, metric) => { const a = idx[slug + '|' + metric]; if (!a) return null; return a.slice().sort((x, y) => y.period.localeCompare(x.period))[0].value; };
const bandsFor = slug => AGE_ORDER.map(b => ({ age: b, count: latest(slug, 'pyr_' + b) })).filter(x => x.count != null);
function pyramid(slug, stateSlug) {
  const r = bandsFor(slug), n = bandsFor('australia');
  if (!r.length) return null;
  const rt = r.reduce((s, x) => s + x.count, 0), nt = n.reduce((s, x) => s + x.count, 0) || 1;
  const nmap = Object.fromEntries(n.map(x => [x.age, x.count]));
  // state comparator (regional reports plot region vs STATE; capitals vs national)
  const sb = (stateSlug && stateSlug !== slug) ? bandsFor(stateSlug) : [];
  const stt = sb.reduce((a, x) => a + x.count, 0) || 1, smap = Object.fromEntries(sb.map(x => [x.age, x.count]));
  return r.map(x => ({ age: x.age, metro_pct: x.count / rt, national_pct: (nmap[x.age] || 0) / nt, state_pct: sb.length ? (smap[x.age] || 0) / stt : null, metro_count: x.count, national_count: (nmap[x.age] || 0), state_count: sb.length ? (smap[x.age] || 0) : null }));
}
function industry(slug) {
  const sectors = Object.keys(idx).filter(k => k.startsWith(slug + '|ind_')).map(k => ({ sector: k.split('|ind_')[1], value: latest(slug, 'ind_' + k.split('|ind_')[1]) })).filter(x => x.value != null);
  if (!sectors.length) return null;
  const total = sectors.reduce((s, x) => s + x.value, 0) || 1;
  return sectors.map(x => ({ sector: x.sector, value: x.value, pct: x.value / total })).sort((a, b) => b.value - a.value);
}
// capital-cities population pyramid (aggregate of the 8 capital GCCSAs) — National p9 second series
const CAPS_PYR = ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'canberra', 'hobart', 'darwin'];
function capitalsPyramid() {
  const sums = {};
  for (const b of AGE_ORDER) { let s = 0, any = false; for (const c of CAPS_PYR) { const v = latest(c, 'pyr_' + b); if (v != null) { s += v; any = true; } } if (any) sums[b] = s; }
  const tot = Object.values(sums).reduce((a, x) => a + x, 0) || 1;
  return AGE_ORDER.filter(b => sums[b] != null).map(b => ({ age: b, count: sums[b], pct: sums[b] / tot }));
}

const { data: feeds } = await sb.from('rdp_report_feed').select('region_slug,cluster,payload');

// ── computed-from-payload extras: capital-city yield comparison (CIV) + long-term CAGR ──
const CAPS = ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'canberra', 'hobart', 'darwin'];
const feedBySlug = Object.fromEntries((feeds || []).map(f => [f.region_slug, f]));
const latestYearVal = (payload, field) => { const ys = (payload && payload.years) || []; for (let i = ys.length - 1; i >= 0; i--) { const v = ys[i][field]; if (v != null && !isNaN(v)) return +v; } return null; };
// CIV: the 8-capital gross-yield comparison (report fields 70-72). Computed from
// the Cotality CURRENT snapshot — replicating the verified Data Forge CIV card
// (forge_cotality 'latest'.cap.rows median price [col 4] + 'rentvacancy'.capitals
// rent; yield = rent×52÷price). NOT the report's annual yields, which use a
// different (SQM/annual) rent reference and so diverge, esp. on units.
const civNum = s => { const n = Number(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
const civNorm = s => String(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/[-/]/g, ' ').replace(/\s+/g, ' ').trim();
const civTok = s => civNorm(s).split(' ').filter(Boolean);
const civMatch = (fileName, target) => { const f = civTok(fileName), t = civTok(target); if (!t.length || f.length < t.length) return false; for (let i = 0; i + t.length <= f.length; i++) { let all = true; for (let j = 0; j < t.length; j++) if (f[i + j] !== t[j]) { all = false; break; } if (all) return true; } return false; };
const { data: cotRows } = await sb.from('forge_cotality').select('id,data').in('id', ['latest', 'rentvacancy']);
const cotLatest = (cotRows || []).find(r => r.id === 'latest'), cotRent = (cotRows || []).find(r => r.id === 'rentvacancy');
const civCapRows = (cotLatest && cotLatest.data && cotLatest.data.cap && cotLatest.data.cap.rows) || [];
const civRentCaps = (cotRent && cotRent.data && cotRent.data.capitals) || [];
const CIV_CAP_NAME = { sydney: 'Sydney', melbourne: 'Melbourne', brisbane: 'Brisbane', perth: 'Perth', adelaide: 'Adelaide', canberra: 'Canberra', hobart: 'Hobart', darwin: 'Darwin' };
const capcityYields = CAPS.map(s => {
  const city = CIV_CAP_NAME[s] || s;
  const ph = civCapRows.find(r => /^h/i.test(String(r[2])) && civMatch(String(r[1]), city));
  const pu = civCapRows.find(r => /^u/i.test(String(r[2])) && civMatch(String(r[1]), city));
  const priceH = ph ? civNum(ph[4]) : null, priceU = pu ? civNum(pu[4]) : null;
  const rc = civRentCaps.find(c => civMatch(String(c.name), city));
  const rentH = rc && rc.rentHouse != null ? rc.rentHouse : null, rentU = rc && rc.rentUnit != null ? rc.rentUnit : null;
  return { slug: s, yield_h: (priceH && rentH) ? rentH * 52 / priceH : null, yield_u: (priceU && rentU) ? rentU * 52 / priceU : null };
}).filter(x => x.yield_h != null || x.yield_u != null);
// "Long-Term Trends" block (fields 78-80): CAGR of median price at 3/5/7/10yr +
// LT. 10/7/5/3 = (cur/cur_minus_n)^(1/n)-1 — verified to match the cluster sheet
// exactly. LT = CAGR over each region's ACTUAL data history (first data year →
// latest, n = the span). The cluster sheet hand-picks a base row per region
// (and the VIC regionals miscount it as ÷46 instead of ÷41); basing LT on real
// data history is the correct, per-region-history method the user asked for.
function ltBlock(payload, field) {
  const ys = (payload && payload.years) || [];
  const map = {}; for (const y of ys) { const v = y[field]; if (v != null && !isNaN(v) && v > 0) map[y.year] = +v; }
  const yrs = Object.keys(map).map(Number).sort((a, b) => a - b); if (yrs.length < 2) return null;
  const Y = yrs[yrs.length - 1], Y0 = yrs[0];
  const cagr = (base, n) => (base > 0 && n > 0) ? Math.pow(map[Y] / base, 1 / n) - 1 : null;
  // LT = CAGR over the region's actual data history (first data year → latest)
  return { y3: cagr(map[Y - 3], 3), y5: cagr(map[Y - 5], 5), y7: cagr(map[Y - 7], 7), y10: cagr(map[Y - 10], 10), lt: cagr(map[Y0], Y - Y0), from: Y0 };
}

// monthly state-level lending (owner-occupier / investor); a capital/regional uses its state's series (fields 57-58)
const { data: regDim } = await sb.from('rdp_regions').select('slug,state');
const stateOf = Object.fromEntries((regDim || []).map(r => [r.slug, r.state ? 'st-' + r.state.toLowerCase() : null]));
const stateMonthly = {};   // 'st-nsw'|'australia' -> { oo:{period:val}, inv:{period:val} }
for (const r of raw) { if (r.metric !== 'owner_occupier' && r.metric !== 'investor') continue; if (!r.region_slug.startsWith('st-') && r.region_slug !== 'australia') continue; (stateMonthly[r.region_slug] || (stateMonthly[r.region_slug] = { oo: {}, inv: {} }))[r.metric === 'owner_occupier' ? 'oo' : 'inv'][r.period] = r.value; }
function lendingFor(slug) { const st = (slug === 'australia') ? 'australia' : stateOf[slug]; const sm = st && stateMonthly[st]; if (!sm) return null; const months = [...new Set([...Object.keys(sm.oo), ...Object.keys(sm.inv)])].sort(); if (!months.length) return null; return { state: st, months, owner_occupier: months.map(m => sm.oo[m] ?? null), investor: months.map(m => sm.inv[m] ?? null) }; }

// national quarterly/monthly series for the National report extras: job vacancies
// (ABS, Q) + internet vacancies (NSC IVI, M). Australia only — small targeted pull.
const natSeries = {};
{
  const { data } = await sb.from('rdp_raw_series').select('metric,period,value').eq('region_slug', 'australia').in('metric', ['job_vacancies_private', 'job_vacancies_public', 'job_vacancies_total', 'internet_vacancies']).order('period');
  for (const r of (data || [])) (natSeries[r.metric] || (natSeries[r.metric] = [])).push({ period: r.period, value: Number(r.value) });
}
const jvSeries = m => (natSeries[m] || []).map(x => x.value);
// 8-capital current/prior vacancy snapshot (National p5) — annual vacancy_rate from each capital feed
function vacancySnapshot() {
  return CAPS.map(s => { const ys = (feedBySlug[s] && feedBySlug[s].payload.years) || []; const vr = ys.filter(y => y.vacancy_rate != null); const last = vr[vr.length - 1], prev = vr[vr.length - 2]; return { slug: s, current: last ? last.vacancy_rate : null, prior: prev ? prev.vacancy_rate : null, year: last ? last.year : null, prior_year: prev ? prev.year : null }; });
}

// Perth-only report charts (p32 Iron Ore Price, p33 Mineral Exploration). The
// report's annual ironOre = each year's ANNUAL AVERAGE of the monthly price
// (verified vs the Perth tab: 2004 16.39, 2024 108.54 exact, others within ~1%);
// mineral exploration = WA quarterly ($m). Data in rdp_raw_series.
const perthSeries = { iron: {}, mineral: [] };
{
  const { data: ir } = await sb.from('rdp_raw_series').select('period,value').eq('region_slug', 'perth').eq('metric', 'iron_ore_price').eq('freq', 'M').order('period');
  const ironM = {};
  for (const r of (ir || [])) { const y = +String(r.period).slice(0, 4); (ironM[y] || (ironM[y] = [])).push(Number(r.value)); }
  for (const y in ironM) perthSeries.iron[y] = ironM[y].reduce((a, b) => a + b, 0) / ironM[y].length;
  const { data: me } = await sb.from('rdp_raw_series').select('period,value').eq('region_slug', 'st-wa').eq('metric', 'mineral_exploration').eq('freq', 'Q').order('period');
  perthSeries.mineral = (me || []).map(r => ({ period: r.period, value: Number(r.value) }));
}

// monthly median price (forge_monthly_price store) + monthly JCI / arrears (rdp_raw_series, freq M)
const { data: mpRow } = await sb.from('forge_monthly_price').select('data').eq('id', 'latest').maybeSingle();
const monthlyPrice = (mpRow && mpRow.data && mpRow.data.regions) || {};
const monthlySeries = (slug, metric) => { const a = idx[slug + '|' + metric]; if (!a) return null; const mm = a.filter(r => r.freq === 'M').slice().sort((x, y) => String(x.period).localeCompare(String(y.period))); if (!mm.length) return null; return { months: mm.map(r => r.period), values: mm.map(r => r.value) }; };

// Industry Value Added — read the CURRENT forge_industry store (the Data Forge
// Industry data point / latest REMPLAN). rdp_raw_series ind_* is a STALE copy of
// the ORIGINAL report values (e.g. Perth Mining 30.86% old vs 65.8% current REMPLAN),
// so prefer the store; fall back to ind_* only for a region the store lacks.
const { data: indRows } = await sb.from('forge_industry').select('data');
const indStore = (indRows || []).map(r => r.data).find(d => d && d.regions);
const indRegions = (indStore && indStore.regions) || {};
const labelToSlug = lbl => String(lbl).toLowerCase().replace(/,/g, '').replace(/&/g, 'and').replace(/\s+/g, '_');
function industryForge(slug) {
  const r = indRegions[slug];
  if (!r || !r.values) return null;
  const entries = Object.entries(r.values).filter(([, v]) => v != null && !isNaN(Number(v)));
  if (!entries.length) return null;
  const total = (r.total != null && !isNaN(Number(r.total))) ? Number(r.total) : entries.reduce((s, [, v]) => s + Number(v), 0) || 1;
  return entries.map(([lbl, v]) => ({ sector: labelToSlug(lbl), value: Number(v), pct: Number(v) / total })).sort((a, b) => b.value - a.value);
}

// Population pyramid — read the CURRENT forge_population_pyramid store (latest 2024
// ERP). rdp_raw_series pyr_* is again a STALE copy (Perth 0-04: store 135443 vs
// rdp 129598). Prefer the store; fall back to pyr_* only for a region it lacks.
const { data: pyrRows } = await sb.from('forge_population_pyramid').select('data');
const pyrData = (pyrRows || []).map(r => r.data).find(d => d && d.regions);
const pyrStore = (pyrData && pyrData.regions) || {};
const pyrAges = (pyrData && pyrData.ageGroups) || [];
function pyramidForge(slug, stateSlug) {
  const reg = pyrStore[slug];
  if (!reg || !Array.isArray(reg.total) || !pyrAges.length) return null;
  const metro = reg.total;
  const nat = (pyrStore['australia'] && pyrStore['australia'].total) || [];
  const st = (stateSlug && stateSlug !== slug && pyrStore[stateSlug]) ? pyrStore[stateSlug].total : null;
  const sum = a => (a || []).reduce((s, x) => s + (Number(x) || 0), 0) || 1;
  const mt = sum(metro), nt = sum(nat), stt = st ? sum(st) : 1;
  return pyrAges.map((age, i) => ({
    age: age,
    metro_pct: metro[i] != null ? metro[i] / mt : null,
    national_pct: nat[i] != null ? nat[i] / nt : null,
    state_pct: st ? (st[i] != null ? st[i] / stt : null) : null,
    metro_count: metro[i] != null ? Number(metro[i]) : null,
    national_count: nat[i] != null ? Number(nat[i]) : null,
    state_count: st ? (st[i] != null ? Number(st[i]) : null) : null
  }));
}

const updates = [];
for (const f of feeds) {
  const slug = f.region_slug;
  const extras = {};
  const py = pyramidForge(slug, stateOf[slug]) || pyramid(slug, stateOf[slug]); if (py) extras.pyramid = py;
  const ind = industryForge(slug) || industry(slug); if (ind) extras.industry = ind;
  // arrears: region's own (capitals = their state) → fall back to the region's
  // state capital's series for regionals (the chart plots region-state vs national)
  let ar = latest(slug, 'arrears');
  if (ar == null && stateOf[slug]) { const cap = STATECAP[stateOf[slug].slice(3)]; if (cap) ar = latest(cap, 'arrears'); }
  if (ar != null) extras.arrears = ar;
  const jc = latest(slug, 'jci'); if (jc != null) extras.jci = jc;
  extras.arrears_national = latest('australia', 'arrears');
  // monthly series for the monthly charts (lending already added below)
  if (monthlyPrice[slug]) extras.monthly_price = { months: monthlyPrice[slug].months, h: monthlyPrice[slug].h, u: monthlyPrice[slug].u };
  const jm = monthlySeries(slug, 'jci'); if (jm) extras.jci_monthly = jm;
  let amS = monthlySeries(slug, 'arrears');
  if (!amS && stateOf[slug]) { const cap = STATECAP[stateOf[slug].slice(3)]; if (cap) amS = monthlySeries(cap, 'arrears'); }
  if (amS) extras.arrears_monthly = amS;
  const amN = monthlySeries('australia', 'arrears'); if (amN) extras.arrears_national_monthly = amN;
  // CIV (capital-city yield comparison) + long-term CAGR (computed from payloads)
  extras.capcity_yields = capcityYields;
  extras.lt = { house: ltBlock(f.payload, 'mp_h'), unit: ltBlock(f.payload, 'mp_u') };
  const lend = lendingFor(slug); if (lend) extras.lending = lend;
  if (slug === 'australia') {  // national-only extras
    extras.arrears_by_state = Object.fromEntries(Object.entries(STATECAP).map(([st, cap]) => [st, latest(cap, 'arrears')]));
    extras.state_migration = Object.fromEntries(Object.keys(STATECAP).map(st => [st, { nom: latest('st-' + st, 'nom'), nim: latest('st-' + st, 'nim') }]));
    // National report charts p19/p20/p9/p5
    extras.job_vacancies = { periods: (natSeries.job_vacancies_total || []).map(x => x.period), private: jvSeries('job_vacancies_private'), public: jvSeries('job_vacancies_public'), total: jvSeries('job_vacancies_total') };
    extras.internet_vacancies = { periods: (natSeries.internet_vacancies || []).map(x => x.period), values: jvSeries('internet_vacancies') };
    extras.pyramid_capitals = capitalsPyramid();
    extras.vacancy_snapshot = vacancySnapshot();
  }
  if (slug === 'perth') {  // Perth-only report charts (p32 Iron Ore Price, p33 Mineral Exploration)
    const iy = Object.keys(perthSeries.iron).map(Number).sort((a, b) => a - b);
    if (iy.length) extras.iron_ore = { years: iy, values: iy.map(y => perthSeries.iron[y]) };
    if (perthSeries.mineral.length) extras.mineral_exploration = { quarters: perthSeries.mineral.map(x => x.period), values: perthSeries.mineral.map(x => x.value) };
  }
  const payload = { ...f.payload, extras };
  updates.push({ region_slug: slug, cluster: f.cluster, payload });
}

// spot-check
const adel = updates.find(u => u.region_slug === 'adelaide');
const au = updates.find(u => u.region_slug === 'australia');
console.log('regions enriched:', updates.length);
if (adel) console.log('adelaide extras: pyramid bands=' + (adel.payload.extras.pyramid || []).length + ', industry sectors=' + (adel.payload.extras.industry || []).length + ', arrears=' + adel.payload.extras.arrears + ', jci=' + adel.payload.extras.jci + ', CAGR house 3/5/7/10/LT=' + ['y3','y5','y7','y10','lt'].map(k => (adel.payload.extras.lt.house[k] * 100).toFixed(2)).join('/') + '%');
console.log('capcity yields (CIV): ' + capcityYields.map(c => c.slug + ' H' + (c.yield_h * 100).toFixed(2) + '%/U' + (c.yield_u * 100).toFixed(2) + '%').join(', '));
if (adel) { const L = adel.payload.extras.lending; console.log('adelaide lending (' + (L && L.state) + '): ' + (L ? L.months.length + ' months, latest OO $' + L.owner_occupier[L.owner_occupier.length - 1] + 'm / INV $' + L.investor[L.investor.length - 1] + 'm' : 'none')); }
if (au) console.log('australia extras: pyramid=' + (au.payload.extras.pyramid || []).length + ' bands, arrears_by_state.sa=' + au.payload.extras.arrears_by_state?.sa + ', state_migration.nsw=' + JSON.stringify(au.payload.extras.state_migration?.nsw));

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert.'); process.exit(0); }
const stamp = new Date().toISOString(); let n = 0;
for (const u of updates) { const { error } = await sb.from('rdp_report_feed').upsert({ region_slug: u.region_slug, cluster: u.cluster, payload: u.payload, computed_at: stamp }, { onConflict: 'region_slug' }); if (error) { console.error(u.region_slug, error.message); process.exit(1); } n++; }
await sb.from('rdp_runs').insert({ dataset: 'report_feed', source_month: 'enrich 2026-06', row_count: n, status: 'ok', notes: 'extras: pyramid/industry/arrears/jci + capcity_yields(CIV) + lt CAGR + lending (OO/INV monthly) (+ national state migration)' });
console.log(`✓ Enriched ${n} report_feed payloads with extras.`);
