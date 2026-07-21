// =============================================================================
// build-runway.mjs  —  L2 mart builder for rdp_runway (DB-native recompute).
//
// Config (AI-ceilings + rates) is read from rdp_runway_config (the lifted
// workbook config); if that isn't seeded yet it falls back to the Runway
// Workbook .xlsx. Median + income come from rdp_report_feed. RunwayCalc does the
// affordability-ceiling math. Stores per-region INPUTS in the payload so the
// Runway tool can recompute scenarios live in-browser.
//
// When the .xlsx is present it also VERIFIES the calc reproduces the workbook.
// Dry-run by DEFAULT; --write upserts + logs rdp_runs.
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import './../shared/runway-calc.js';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');

const ST = 'act|nsw|nt|qld|sa|tas|vic|wa';
const SLUGS = new Set(['australia','sydney','melbourne','brisbane','perth','adelaide','canberra','hobart','darwin','mackay','bundaberg','ipswich','rockhampton','gladstone','cairns','townsville','sunshine-coast','toowoomba','gold-coast','albury','central-coast','coffs-harbour','newcastle','orange','port-macquarie','tamworth','wagga-wagga','wollongong','ballarat','bendigo','geelong','wodonga','mildura','mandurah','rockingham','bunbury','launceston']);
const resolveCity = l => { if (l == null) return null; let s = String(l).trim(); if (!s || /^year$/i.test(s)) return null; if (/^national$/i.test(s)) return 'australia'; s = s.replace(/\([^)]*\)/g, ' ').replace(new RegExp(',\\s*(' + ST + ')\\b', 'ig'), ' ').replace(/\b\d{3,4}\b/g, ' ').replace(/\bgreater\b/ig, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); if (SLUGS.has(s)) return s; return [...SLUGS].find(g => s.startsWith(g + '-')) || null; };   // prefix fallback: "port-macquarie-hastings"→port-macquarie, "tamworth-regional"→tamworth
const numv = v => (typeof v === 'number' && isFinite(v)) ? v : null;

// ── workbook (for verify + config fallback) ──
const FILE = process.argv.slice(2).find(a => !a.startsWith('--')) || join(homedir(), 'Downloads', 'Runway Workbook - Encrypted (updated_ 11Mar2025).xlsx');
const wbExists = existsSync(FILE);
function readIC(sheet, c, rc) {
  const ws = wb.Sheets[sheet]; const g = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const rate = numv(ws[rc.cur] && ws[rc.cur].v), frate = numv(ws[rc.fc] && ws[rc.fc].v);
  const rows = [];
  for (let r = 16; r <= 51; r++) { const a = g[r - 1]; if (!a) continue; const slug = resolveCity(a[1]); if (!slug) continue;
    rows.push({ slug, median: numv(a[c.median]), income: numv(a[c.income]), aiCeiling: numv(a[c.aiCeiling]), wb_ai: numv(a[c.ai]), wb_ceiling: numv(a[c.ceiling]), wb_runway: numv(a[c.runway]), wb_fc_ai: numv(a[c.fc_ai]), wb_fc_ceiling: numv(a[c.fc_ceiling]), wb_fc_pct: numv(a[c.fc_pct]) }); }
  return { rate, frate, rows };
}
let wb, H = { rate: null, frate: null, rows: [] }, U = { rate: null, frate: null, rows: [] };
if (wbExists) { wb = XLSX.readFile(FILE); H = readIC('Houses Runway - IC', { median: 3, income: 4, aiCeiling: 5, ai: 6, ceiling: 7, runway: 9, fc_ai: 13, fc_ceiling: 14, fc_pct: 16 }, { cur: 'P10', fc: 'R10' }); U = readIC('Units Runway - IC', { median: 2, income: 3, aiCeiling: 4, ai: 5, ceiling: 6, runway: 8, fc_ai: 12, fc_ceiling: 13, fc_pct: 15 }, { cur: 'G10', fc: 'I10' }); }

// ── config: DB first, workbook fallback ──
const { data: cfgRows } = await sb.from('rdp_runway_config').select('key,value');
const dbCfg = Object.fromEntries((cfgRows || []).map(r => [r.key, r.value]));
let rateCur, rateFc, ceilH, ceilU;
if (dbCfg.rates && dbCfg.ai_ceiling) {
  rateCur = dbCfg.rates.current.rate; rateFc = dbCfg.rates.forecast.rate;
  ceilH = Object.fromEntries(Object.entries(dbCfg.ai_ceiling).map(([k, v]) => [k, v.h]));
  ceilU = Object.fromEntries(Object.entries(dbCfg.ai_ceiling).map(([k, v]) => [k, v.u]));
  console.log('config source: DB (rdp_runway_config)');
} else if (wbExists) {
  rateCur = H.rate; rateFc = H.frate;
  ceilH = Object.fromEntries(H.rows.map(r => [r.slug, r.aiCeiling]));
  ceilU = Object.fromEntries(U.rows.map(r => [r.slug, r.aiCeiling]));
  console.log('config source: workbook (rdp_runway_config not seeded yet)');
} else { console.error('No config available — seed rdp_runway_config (migration 052 + seed-runway-config) or provide the workbook.'); process.exit(1); }
console.log('rates: current=' + rateCur + ' forecast=' + rateFc);

// wage-growth config + region cluster — for the Demand Score's runway, which is the
// Runway Workbook's headline scenario: FORECAST rate with income grown by wage growth
// over the horizon (capitals use wgCapital, regions wgRegional). This is what the
// Runway Workbook tool shows by default (e.g. Sydney +1.32%), NOT the current-rate leg.
const wg = dbCfg.wage_growth || { years: 1, capital: 0, regional: 0 };
const { data: regRows } = await sb.from('rdp_regions').select('slug,cluster');
const clusterOf = Object.fromEntries((regRows || []).map(r => [r.slug, r.cluster]));
console.log('wage growth: capital=' + wg.capital + ' regional=' + wg.regional + ' years=' + wg.years);

// ── verify vs workbook (only if present) ──
let checks = 0, pass = 0;
if (wbExists) {
  const close = (a, b) => (a == null || b == null) ? false : Math.abs(a - b) <= 1e-6 + 2e-3 * Math.abs(b) || Math.abs(a - b) <= 2;
  for (const T of [H, U]) for (const row of T.rows) {
    const c = globalThis.RunwayCalc.computeRunway({ median: row.median, income: row.income, aiCeiling: row.aiCeiling, currentRate: T.rate, forecastRate: T.frate });
    for (const [mine, theirs] of [[c.ai, row.wb_ai], [c.ceiling, row.wb_ceiling], [c.runway_pct, row.wb_runway], [c.forecast_ai, row.wb_fc_ai], [c.forecast_ceiling, row.wb_fc_ceiling], [c.forecast_pct, row.wb_fc_pct]]) { if (theirs == null) continue; checks++; if (close(mine, theirs)) pass++; }
  }
  console.log(`verify calc vs workbook: ${pass}/${checks} match`);
  if (checks && pass / checks < 0.95) { console.error(`✗ VERIFY FAILED — only ${pass}/${checks} match the workbook (threshold 95%).`); process.exit(1); }
} else {
  console.log('verify calc vs workbook: SKIPPED — local workbook not present (CI run); rdp_runway freshness is covered by post-publish-verify.mjs.');
}

// ── recompute mart from rdp_report_feed; store INPUTS for the tool ──
const { data: feeds } = await sb.from('rdp_report_feed').select('region_slug,payload');
const list = [];
for (const f of feeds || []) {
  const slug = f.region_slug; if (ceilH[slug] == null && ceilU[slug] == null) continue;
  const years = (f.payload && f.payload.years) || [];
  const latest = [...years].reverse().find(r => r.mp_h != null || r.mp_u != null); if (!latest) continue;
  const income = latest.median_income;
  const house = ceilH[slug] != null ? globalThis.RunwayCalc.computeRunway({ median: latest.mp_h, income, aiCeiling: ceilH[slug], currentRate: rateCur, forecastRate: rateFc }) : null;
  const unit = ceilU[slug] != null ? globalThis.RunwayCalc.computeRunway({ median: latest.mp_u, income, aiCeiling: ceilU[slug], currentRate: rateCur, forecastRate: rateFc }) : null;
  // forecast + wage-growth runway (the Demand Score reads this): grow income by the
  // region's wage-growth over the horizon, then take the runway at the forecast rate.
  const wgRate = (clusterOf[slug] === 'capital') ? (wg.capital || 0) : (wg.regional || 0);
  const grownIncome = income != null ? income * Math.pow(1 + wgRate, wg.years || 1) : income;
  if (house) house.forecast_wg_pct = globalThis.RunwayCalc.computeRunway({ median: latest.mp_h, income: grownIncome, aiCeiling: ceilH[slug], currentRate: rateFc, forecastRate: rateFc }).runway_pct;
  if (unit) unit.forecast_wg_pct = globalThis.RunwayCalc.computeRunway({ median: latest.mp_u, income: grownIncome, aiCeiling: ceilU[slug], currentRate: rateFc, forecastRate: rateFc }).runway_pct;
  list.push({ region_slug: slug, payload: { house, unit, inputs: { median_h: latest.mp_h, median_u: latest.mp_u, income }, ai_ceiling: { h: ceilH[slug] ?? null, u: ceilU[slug] ?? null }, rates: { current: rateCur, forecast: rateFc }, wage_growth: { rate: wgRate, years: wg.years || 1 }, year: latest.year } });
}
const a = list.find(x => x.region_slug === 'adelaide');
if (a) console.log('adelaide:', JSON.stringify({ median_h: a.payload.inputs.median_h, ai: a.payload.house.ai, ceiling: Math.round(a.payload.house.ceiling), runway: a.payload.house.runway_pct }));
console.log('regions:', list.length);

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_runway.'); process.exit(0); }
const stamp = new Date().toISOString(); let n = 0;
const RUN_MONTH = 'Runway recompute ' + stamp.slice(0, 7);   // real run-month provenance (was hardcoded '2026-06')
for (const r of list) { const { error } = await sb.from('rdp_runway').upsert({ region_slug: r.region_slug, payload: r.payload, source_month: RUN_MONTH, computed_at: stamp }, { onConflict: 'region_slug' }); if (error) { console.error(r.region_slug, error.message); process.exit(1); } n++; }
await sb.from('rdp_runs').insert({ dataset: 'runway', source_month: RUN_MONTH, row_count: n, status: 'ok', notes: `${n} regions; RunwayCalc recompute (config: ${dbCfg.rates ? 'DB' : 'workbook'}; verify ${wbExists ? pass + '/' + checks : 'skipped'})` });
console.log(`✓ Recomputed rdp_runway for ${n} regions (with inputs for the tool).`);
