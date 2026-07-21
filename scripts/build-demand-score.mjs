// =============================================================================
// ⛔ RETIRED / PARKED — kept for reference only (decision 2026-07-10).
//
// rdp_demand_score is a write-only dead end: this builder is in no workflow,
// writes score:null / listings:null, and has ZERO readers. The LIVE Demand
// Score computes client-side (PP_DEMAND_ENGINE in tools/demand-score.html)
// from forge_demand_inputs + rdp_vr_forecast + rdp_runway + forge_cotality +
// forge_monthly_price + rdp population. Do not wire this script anywhere.
// =============================================================================
// build-demand-score.mjs  —  L2 mart builder for rdp_demand_score (INPUTS only).
//
// Assembles the per-region Demand Score INPUTS from the Data Dump "DemandScore"
// tab (current-month population, DOM, median price, rent, SOM, vacancy,
// approvals) + Expected VR from rdp_vr_forecast. Upserts to rdp_demand_score.
//
// NOTE: the actual demand SCORE is NOT computed here — the scoring formula lives
// in the monthly "Demand Score Sheets" (House & Unit), which we don't have, and
// it also needs LISTINGS (realestate.com.au, manual). Both are flagged as
// pending; `score` and `listings` are left null until provided.
//
// Dry-run by DEFAULT; --write upserts + logs rdp_runs.
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');

const ST = 'act|nsw|nt|qld|sa|tas|vic|wa';
const SLUGS = new Set(['australia','sydney','melbourne','brisbane','perth','adelaide','canberra','hobart','darwin','mackay','bundaberg','ipswich','rockhampton','gladstone','cairns','townsville','sunshine-coast','toowoomba','gold-coast','albury','central-coast','coffs-harbour','newcastle','orange','port-macquarie','tamworth','wagga-wagga','wollongong','ballarat','bendigo','geelong','wodonga','mildura','mandurah','rockingham','bunbury','launceston']);
function resolveCity(label) { if (label == null) return null; let s = String(label).trim(); if (s === '' || /^year$/i.test(s)) return null; if (/^national$/i.test(s)) return 'australia'; s = s.replace(/\([^)]*\)/g, ' ').replace(new RegExp(',\\s*(' + ST + ')\\b', 'ig'), ' ').replace(/\b\d{3,4}\b/g, ' ').replace(/\bgreater\b/ig, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); return SLUGS.has(s) ? s : null; }
const numv = v => (typeof v === 'number' && isFinite(v)) ? v : null;

// inputs from the Data Dump DemandScore tab
const ddPath = join(homedir(), 'Downloads', 'Data Dump - Online Report.xlsx');
if (!existsSync(ddPath)) { console.error(`Data Dump xlsx not found: ${ddPath} — this retired builder needs "Data Dump - Online Report.xlsx" in Downloads.`); process.exit(1); }
const g = XLSX.utils.sheet_to_json(XLSX.readFile(ddPath, { cellFormula: false }).Sheets['DemandScore'], { header: 1, raw: true, defval: '' });
const inputs = {};
for (let r = 1; r < g.length; r++) {
  const row = g[r]; const slug = resolveCity(row[1]); if (!slug) continue;
  inputs[slug] = { population: numv(row[2]), dom_h: numv(row[3]), dom_u: numv(row[4]), median_h: numv(row[5]), median_u: numv(row[6]), rent_h: numv(row[7]), rent_u: numv(row[8]), som_h: numv(row[9]), som_u: numv(row[10]), current_vr: numv(row[11]), approvals_h: numv(row[12]), approvals_u: numv(row[13]) };
}

// Expected VR from the vr_forecast mart
const { data: vr } = await sb.from('rdp_vr_forecast').select('region_slug,payload');
const expVR = Object.fromEntries((vr || []).map(r => [r.region_slug, r.payload && r.payload.forecastVR]));

const list = Object.entries(inputs).map(([slug, inp]) => ({ region_slug: slug, payload: { inputs: inp, expected_vr: expVR[slug] ?? null, listings: null, score: null, _pending: 'score formula (Demand Score Sheet) + listings (realestate.com.au)' } }));
console.log('demand_score input rows:', list.length);
const a = list.find(x => x.region_slug === 'adelaide');
if (a) console.log('adelaide inputs:', JSON.stringify(a.payload.inputs), 'expVR=', a.payload.expected_vr);

if (!WRITE) { console.log('\nDry run complete. Re-run with --write to upsert into rdp_demand_score.'); process.exit(0); }
const stamp = new Date().toISOString(); let n = 0;
for (const r of list) { const { error } = await sb.from('rdp_demand_score').upsert({ region_slug: r.region_slug, payload: r.payload, source_month: 'Data Dump 2026-06', computed_at: stamp }, { onConflict: 'region_slug' }); if (error) { console.error(r.region_slug, error.message); process.exit(1); } n++; }
await sb.from('rdp_runs').insert({ dataset: 'demand_score', source_month: 'Data Dump 2026-06', row_count: n, status: 'ok', notes: `${n} regions; INPUTS only (score + listings pending)` });
console.log(`✓ Built rdp_demand_score INPUTS for ${n} regions (score pending).`);
