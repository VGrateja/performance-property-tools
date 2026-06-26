// =============================================================================
// build-runway.mjs  —  L2 mart builder for rdp_runway (RECOMPUTED).
//
// 1) Extracts per-region CONFIG from the Runway Workbook (Houses/Units Runway-IC):
//    AI Ceiling (col F) + current/forecast variable rates (P10/R10).
// 2) VERIFIES RunwayCalc reproduces the workbook (its D/E/F inputs -> G/H/J/N/O/Q).
// 3) RECOMPUTES the mart from the central DB (median + state income from
//    rdp_report_feed's latest row) + that config -> rdp_runway.
//
// AI Ceiling + rates are config held static until the workbook is updated (like
// OE commencements). Dry-run by DEFAULT; --write upserts + logs rdp_runs.
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
const SLUGS = new Set(['australia','sydney','melbourne','brisbane','perth','adelaide','canberra','hobart','darwin','mackay','bundaberg','ipswich','rockhampton','gladstone','cairns','townsville','sunshine-coast','toowoomba','gold-coast','albury','central-coast','coffs-harbour','newcastle','orange','port-macquarie','tamworth','wagga-wagga','wollongong','dubbo','ballarat','bendigo','geelong','wodonga','mildura','mandurah','rockingham','bunbury','launceston']);
const resolveCity = l => { if (l == null) return null; let s = String(l).trim(); if (!s || /^year$/i.test(s)) return null; if (/^national$/i.test(s)) return 'australia'; s = s.replace(/\([^)]*\)/g, ' ').replace(new RegExp(',\\s*(' + ST + ')\\b', 'ig'), ' ').replace(/\b\d{3,4}\b/g, ' ').replace(/\bgreater\b/ig, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); return SLUGS.has(s) ? s : null; };
const numv = v => (typeof v === 'number' && isFinite(v)) ? v : null;

// ── extract config + verify inputs/outputs from a Runway IC tab ──
const FILE = process.argv.slice(2).find(a => !a.startsWith('--')) || join(homedir(), 'Downloads', 'Runway Workbook - Encrypted (updated_ 11Mar2025).xlsx');
const wb = XLSX.readFile(FILE);
// Houses IC has a Population col; Units IC doesn't (shifted left 1) and its rate
// cells are G10/I10, not P10/R10.
function readIC(sheet, c, rc) {
  const ws = wb.Sheets[sheet]; const g = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const rate = numv(ws[rc.cur] && ws[rc.cur].v), frate = numv(ws[rc.fc] && ws[rc.fc].v);
  const rows = [];
  for (let r = 16; r <= 51; r++) {
    const a = g[r - 1]; if (!a) continue; const slug = resolveCity(a[1]); if (!slug) continue;
    rows.push({ slug, median: numv(a[c.median]), income: numv(a[c.income]), aiCeiling: numv(a[c.aiCeiling]), wb_ai: numv(a[c.ai]), wb_ceiling: numv(a[c.ceiling]), wb_runway: numv(a[c.runway]), wb_fc_ai: numv(a[c.fc_ai]), wb_fc_ceiling: numv(a[c.fc_ceiling]), wb_fc_pct: numv(a[c.fc_pct]) });
  }
  return { rate, frate, rows };
}
const H = readIC('Houses Runway - IC', { median: 3, income: 4, aiCeiling: 5, ai: 6, ceiling: 7, runway: 9, fc_ai: 13, fc_ceiling: 14, fc_pct: 16 }, { cur: 'P10', fc: 'R10' });
const U = readIC('Units Runway - IC', { median: 2, income: 3, aiCeiling: 4, ai: 5, ceiling: 6, runway: 8, fc_ai: 12, fc_ceiling: 13, fc_pct: 15 }, { cur: 'G10', fc: 'I10' });
console.log('rates: house current=' + H.rate + ' forecast=' + H.frate + ' | unit current=' + U.rate + ' forecast=' + U.frate);

// verify calc reproduces the workbook
const close = (a, b, rel = 2e-3) => (a == null || b == null) ? false : Math.abs(a - b) <= 1e-6 + rel * Math.abs(b) || Math.abs(a - b) <= 2;
let checks = 0, pass = 0; const fails = [];
for (const [tab, T] of [['H', H], ['U', U]]) for (const row of T.rows) {
  const c = globalThis.RunwayCalc.computeRunway({ median: row.median, income: row.income, aiCeiling: row.aiCeiling, currentRate: T.rate, forecastRate: T.frate });
  for (const [k, mine, theirs] of [['ai', c.ai, row.wb_ai], ['ceiling', c.ceiling, row.wb_ceiling], ['runway', c.runway_pct, row.wb_runway], ['fc_ai', c.forecast_ai, row.wb_fc_ai], ['fc_ceiling', c.forecast_ceiling, row.wb_fc_ceiling], ['fc_pct', c.forecast_pct, row.wb_fc_pct]]) {
    if (theirs == null) continue; checks++; if (close(mine, theirs)) pass++; else fails.push(`${tab}:${row.slug}.${k} calc=${mine} wb=${theirs}`);
  }
}
console.log(`VERIFY calc vs workbook: ${pass}/${checks} match`);
if (fails.length) for (const f of fails.slice(0, 12)) console.log('  ' + f);

// config per region
const cfgH = Object.fromEntries(H.rows.map(r => [r.slug, r.aiCeiling]));
const cfgU = Object.fromEntries(U.rows.map(r => [r.slug, r.aiCeiling]));

// ── recompute mart from rdp_report_feed (latest median + state income) ──
const { data: feeds } = await sb.from('rdp_report_feed').select('region_slug,payload');
const list = [];
for (const f of feeds || []) {
  const slug = f.region_slug; if (cfgH[slug] == null && cfgU[slug] == null) continue;
  const years = (f.payload && f.payload.years) || [];
  const latest = [...years].reverse().find(r => r.mp_h != null || r.mp_u != null); if (!latest) continue;
  const income = latest.median_income;
  const house = cfgH[slug] != null ? globalThis.RunwayCalc.computeRunway({ median: latest.mp_h, income, aiCeiling: cfgH[slug], currentRate: H.rate, forecastRate: H.frate }) : null;
  const unit = cfgU[slug] != null ? globalThis.RunwayCalc.computeRunway({ median: latest.mp_u, income, aiCeiling: cfgU[slug], currentRate: U.rate, forecastRate: U.frate }) : null;
  list.push({ region_slug: slug, payload: { house, unit, rates: { house: { current: H.rate, forecast: H.frate }, unit: { current: U.rate, forecast: U.frate } }, ai_ceiling: { house: cfgH[slug] ?? null, unit: cfgU[slug] ?? null }, year: latest.year } });
}
const a = list.find(x => x.region_slug === 'adelaide');
if (a) console.log('adelaide RECOMPUTED (from report_feed):', JSON.stringify({ ai: a.payload.house.ai, ceiling: Math.round(a.payload.house.ceiling), runway: a.payload.house.runway_pct, clock: a.payload.house.clock }));
console.log('regions:', list.length);

if (!WRITE) { console.log('\nDry run complete. Re-run with --write to upsert into rdp_runway.'); process.exit(0); }
const stamp = new Date().toISOString(); let n = 0;
for (const r of list) { const { error } = await sb.from('rdp_runway').upsert({ region_slug: r.region_slug, payload: r.payload, source_month: 'Runway recompute 2026-06', computed_at: stamp }, { onConflict: 'region_slug' }); if (error) { console.error(r.region_slug, error.message); process.exit(1); } n++; }
await sb.from('rdp_runs').insert({ dataset: 'runway', source_month: 'Runway recompute 2026-06', row_count: n, status: 'ok', notes: `${n} regions; RunwayCalc recompute (verified ${pass}/${checks})` });
console.log(`✓ Recomputed rdp_runway for ${n} regions.`);
