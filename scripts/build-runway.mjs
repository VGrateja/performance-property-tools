// =============================================================================
// build-runway.mjs  —  L2 mart builder for rdp_runway.
//
// EXTRACTS the per-region runway analytic output from the Runway Workbook's
// "Runway Data Report-House" / "-Unit" tabs (AI, ceiling price, runway %,
// forecast AI / median / %). The runway computation itself is the Runway tool's
// domain (PMT-based ceiling + scenario forecasting) — reproducing it in code is
// a later step; for now we snapshot the workbook's computed output so the mart
// is populated and consumers can read the DB.
//
// Dry-run by DEFAULT; --write upserts + logs rdp_runs.
//   node scripts/build-runway.mjs ["<runway.xlsx>"]            # dry run
//   node scripts/build-runway.mjs ["<runway.xlsx>"] --write     # upsert
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}

const ST = 'act|nsw|nt|qld|sa|tas|vic|wa';
const SLUGS = new Set(['australia','sydney','melbourne','brisbane','perth','adelaide','canberra','hobart','darwin','mackay','bundaberg','ipswich','rockhampton','gladstone','cairns','townsville','sunshine-coast','toowoomba','gold-coast','albury','central-coast','coffs-harbour','newcastle','orange','port-macquarie','tamworth','wagga-wagga','wollongong','dubbo','ballarat','bendigo','geelong','wodonga','mildura','mandurah','rockingham','bunbury','launceston']);
function resolveCity(label) {
  if (label == null) return null; let s = String(label).trim();
  if (s === '' || /^year$/i.test(s)) return null; if (/^national$/i.test(s)) return 'australia';
  s = s.replace(/\([^)]*\)/g, ' ').replace(new RegExp(',\\s*(' + ST + ')\\b', 'ig'), ' ').replace(/\b\d{3,4}\b/g, ' ').replace(/\bgreater\b/ig, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return SLUGS.has(s) ? s : null;
}
const numv = v => (typeof v === 'number' && isFinite(v)) ? v : null;

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const FILE = argv.find(a => !a.startsWith('--')) || join(homedir(), 'Downloads', 'Runway Workbook - Encrypted (updated_ 11Mar2025).xlsx');
if (!existsSync(FILE)) { console.error('File not found:', FILE); process.exit(1); }
const wb = XLSX.readFile(FILE, { cellFormula: false });

// extract one report tab: find the "State"/"Area" header row, then read data
// column maps differ: the House report has a Population col (C), the Unit one doesn't (shifted left by 1)
function extract(sheet, c) {
  const ws = wb.Sheets[sheet]; if (!ws) return { rows: [], rates: {} };
  const g = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  // rates from the legend (col B label -> col D value)
  const rates = {};
  for (let i = 0; i < 16; i++) { const b = String((g[i] || [])[1] || '').toLowerCase(); const d = numv((g[i] || [])[3]);
    if (/forecasted rate/.test(b)) rates.forecast = d; else if (/variable|interest/.test(b)) rates.variable = d; else if (/cash rate/.test(b)) rates.cash = d; }
  const hdr = g.findIndex(r => String(r[0]).trim() === 'State' && /area/i.test(String(r[1])));
  const out = [];
  if (hdr >= 0) for (let r = hdr + 1; r < g.length; r++) {
    const row = g[r]; const area = String(row[1] || '').trim(); if (!area) break;
    const slug = resolveCity(area); if (!slug) continue;
    out.push({ slug, current_ai: numv(row[c.ai]), ceiling: numv(row[c.ceiling]), runway_pct: numv(row[c.runway]), forecast_ai: numv(row[c.fc_ai]), forecast_median: numv(row[c.fc_median]), forecast_pct: numv(row[c.fc_pct]) });
  }
  return { rows: out, rates };
}

const house = extract('Runway Data Report-House', { ai: 3, ceiling: 5, runway: 6, fc_ai: 8, fc_median: 9, fc_pct: 10 });
const unit = extract('Runway Data Report-Unit', { ai: 2, ceiling: 4, runway: 5, fc_ai: 7, fc_median: 8, fc_pct: 9 });
const uBy = Object.fromEntries(unit.rows.map(r => [r.slug, r]));
const merged = {};
for (const h of house.rows) merged[h.slug] = { region_slug: h.slug, payload: { house: h, unit: uBy[h.slug] || null, rates: house.rates } };
const list = Object.values(merged);
console.log('runway regions:', list.length, '| house rates:', JSON.stringify(house.rates));
const a = merged['adelaide'];
if (a) console.log('adelaide runway:', JSON.stringify(a.payload));

if (!WRITE) { console.log('\nDry run complete. Re-run with --write to upsert into rdp_runway.'); process.exit(0); }
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const stamp = new Date().toISOString(); let n = 0;
for (const r of list) { const { error } = await sb.from('rdp_runway').upsert({ region_slug: r.region_slug, payload: r.payload, source_month: 'Runway Workbook 2025-03', computed_at: stamp }, { onConflict: 'region_slug' }); if (error) { console.error(r.region_slug, error.message); process.exit(1); } n++; }
await sb.from('rdp_runs').insert({ dataset: 'runway', source_month: 'Runway Workbook 2025-03', row_count: n, status: 'ok', notes: `${n} regions; extracted from Runway Workbook report tabs` });
console.log(`✓ Built rdp_runway for ${n} regions.`);
