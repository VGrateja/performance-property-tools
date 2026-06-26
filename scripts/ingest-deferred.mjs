// =============================================================================
// ingest-deferred.mjs  —  the deferred raw sources for the central DB.
//
// Adds the sheets the main ingestion skipped, into rdp_raw_series:
//   • SNAPSHOT (category x region): PopPyramid (age bands), Industry (sectors)
//   • ANNUAL national: Mining (commodity prices)
//   • MONTHLY (Date serial x region): Arrears, JCI
// Still deferred after this: Perth-Iron, the National&State monthly block
// (Owner Occupier / Investor / Retail / Bus / FHB), and CLPF monthly medians.
//
// Dry-run by DEFAULT; --write upserts + logs rdp_runs.
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}

const ST = 'act|nsw|nt|qld|sa|tas|vic|wa';
const SLUGS = new Set(['australia','sydney','melbourne','brisbane','perth','adelaide','canberra','hobart','darwin','mackay','bundaberg','ipswich','rockhampton','gladstone','cairns','townsville','sunshine-coast','toowoomba','gold-coast','albury','central-coast','coffs-harbour','newcastle','orange','port-macquarie','tamworth','wagga-wagga','wollongong','dubbo','ballarat','bendigo','geelong','wodonga','mildura','mandurah','rockingham','bunbury','launceston']);
function resolveCity(label) { if (label == null) return null; let s = String(label).trim().replace(/^sydey\b/i, 'Sydney'); if (s === '' || /^year$/i.test(s)) return null; if (/^national$/i.test(s)) return 'australia'; s = s.replace(/\([^)]*\)/g, ' ').replace(new RegExp(',\\s*(' + ST + ')\\b', 'ig'), ' ').replace(/\b\d{3,4}\b/g, ' ').replace(/\bgreater\b/ig, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); return SLUGS.has(s) ? s : null; }
function resolveGeo(label) { const c = resolveCity(label); if (c) return c; const s = String(label || '').trim(); const m = s.match(new RegExp('^(' + ST + ')$', 'i')); if (m) return 'st-' + m[1].toLowerCase(); if (/^capital cities$/i.test(s)) return 'capital-cities'; return null; }
const numv = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const serialToMonth = s => { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(s) * 86400000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-01'; };

const DD = join(homedir(), 'Downloads', 'Data Dump - Online Report.xlsx');
const wb = XLSX.readFile(DD, { cellFormula: false });
const grid = name => wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' }) : null;
const all = []; const reports = [];

// ── SNAPSHOT: col A = category, row1 = region headers; emit metricPrefix+category at one period ──
function snapshot(name, source, prefix, period) {
  const g = grid(name); if (!g) return; const r1 = g[0] || [];
  const cols = []; for (let c = 1; c < r1.length; c++) { const geo = resolveGeo(r1[c]); if (geo) cols.push({ c, geo }); }
  let rows = 0; const regions = new Set();
  for (let r = 1; r < g.length; r++) { const cat = String(g[r][0] || '').trim(); if (!cat) continue; const metric = prefix + slug(cat);
    for (const col of cols) { const v = numv(g[r][col.c]); if (v != null) { all.push({ source, region_slug: col.geo, metric, freq: 'A', period, value: v }); rows++; regions.add(col.geo); } } }
  reports.push({ name, source, rows, regions: regions.size, kind: 'snapshot' });
}

// ── MONTHLY: col A = Excel-serial date, row1 = region headers; one metric, freq M ──
function monthly(name, source, metric) {
  const g = grid(name); if (!g) return; const r1 = g[0] || [];
  const cols = []; for (let c = 1; c < r1.length; c++) { const geo = resolveGeo(r1[c]); if (geo) cols.push({ c, geo }); }
  let rows = 0; const regions = new Set();
  for (let r = 1; r < g.length; r++) { const s = g[r][0]; if (typeof s !== 'number' || !isFinite(s) || s < 20000 || s > 60000) continue; const period = serialToMonth(s);
    for (const col of cols) { const v = numv(g[r][col.c]); if (v != null) { all.push({ source, region_slug: col.geo, metric, freq: 'M', period, value: v }); rows++; regions.add(col.geo); } } }
  reports.push({ name, source, rows, regions: regions.size, kind: 'monthly' });
}

// ── ANNUAL national: col A = year, row1 = metric headers (one region: australia) ──
function annualNational(name, source, headerMap) {
  const g = grid(name); if (!g) return; const r1 = g[0] || [];
  const cols = []; for (let c = 1; c < r1.length; c++) { const code = headerMap(String(r1[c] || '').trim()); if (code) cols.push({ c, metric: code }); }
  let rows = 0;
  for (let r = 1; r < g.length; r++) { const y = g[r][0]; if (typeof y !== 'number' || y < 1900 || y > 2100) continue; const period = Math.round(y) + '-01-01';
    for (const col of cols) { const v = numv(g[r][col.c]); if (v != null) { all.push({ source, region_slug: 'australia', metric: col.metric, freq: 'A', period, value: v }); rows++; } } }
  reports.push({ name, source, rows, regions: 1, kind: 'annual' });
}

snapshot('PopPyramid', 'abs', 'pyr_', '2025-01-01');
snapshot('Industry', 'abs', 'ind_', '2025-01-01');
monthly('Arrears', 'apra', 'arrears');
monthly('JCI', 'jci', 'jci');
annualNational('Mining', 'marketindex', h => /gold/i.test(h) ? 'mining_gold' : /iron/i.test(h) ? 'mining_iron_ore' : /oil/i.test(h) ? 'mining_crude_oil' : /silver/i.test(h) ? 'mining_silver' : /copper/i.test(h) ? 'mining_copper' : /mineral exploration/i.test(h) ? 'mineral_exploration' : null);

// ── MONTHLY block dated by a specific column (National&State monthly section uses Date(Monthly) = col N, idx 13) ──
function monthlyBlock(name, source, dateCol, mapHeader) {
  const g = grid(name); if (!g) return; const r1 = g[0] || [];
  const cols = []; for (let c = 0; c < r1.length; c++) { if (c === dateCol) continue; const mp = mapHeader(String(r1[c] || '').replace(/\s+/g, ' ').trim()); if (mp) cols.push({ c, ...mp }); }
  let rows = 0; const regions = new Set();
  for (let r = 1; r < g.length; r++) { const s = g[r][dateCol]; if (typeof s !== 'number' || s < 20000 || s > 60000) continue; const period = serialToMonth(s);
    for (const col of cols) { const v = numv(g[r][col.c]); if (v != null) { all.push({ source, region_slug: col.region_slug, metric: col.metric, freq: 'M', period, value: v }); rows++; regions.add(col.region_slug); } } }
  reports.push({ name: name + ' monthly-block', source, rows, regions: regions.size, kind: 'monthly' });
}
// ── Perth-Iron: Ref Year + Month name + Iron Ore Price (monthly) ──
function perthIron() {
  const g = grid('Perth - Iron'); if (!g) return; const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  let rows = 0;
  for (let r = 1; r < g.length; r++) { const y = g[r][0], mo = MON[String(g[r][1] || '').slice(0, 3).toLowerCase()], v = numv(g[r][2]); if (typeof y !== 'number' || !mo || v == null) continue;
    all.push({ source: 'marketindex', region_slug: 'perth', metric: 'iron_ore_price', freq: 'M', period: Math.round(y) + '-' + String(mo).padStart(2, '0') + '-01', value: v }); rows++; }
  reports.push({ name: 'Perth - Iron', source: 'marketindex', rows, regions: 1, kind: 'monthly' });
}

monthlyBlock('National&State Data', 'abs', 13, h => {
  let region = null; if (/^national/i.test(h)) region = 'australia'; else { const m = h.match(new RegExp('^(' + ST + ')', 'i')); if (m) region = 'st-' + m[1].toLowerCase(); }
  if (!region) return null;
  const metric = /owner occupier/i.test(h) ? 'owner_occupier' : /investor/i.test(h) ? 'investor' : /retail turnover/i.test(h) ? 'retail_turnover' : /bus.*investment/i.test(h) ? 'bus_investment' : /fhb/i.test(h) ? 'fhb' : null;
  return metric ? { region_slug: region, metric } : null;
});
annualNational('Dwellings', 'abs', h => /national - approvals/i.test(h) ? 'dwelling_approvals' : /national - commenced/i.test(h) ? 'dwelling_commenced' : /national - completions/i.test(h) ? 'dwelling_completions' : null);
perthIron();

for (const r of reports) console.log(`[${r.name} · ${r.source}] ${r.kind}: rows=${r.rows} regions=${r.regions}`);
const pick = (slug, metric, freq) => { const xs = all.filter(x => x.region_slug === slug && x.metric === metric && x.freq === freq).sort((a, b) => b.period.localeCompare(a.period)); return xs[0]; };
const s1 = pick('adelaide', 'pyr_0_04', 'A'), s2 = pick('adelaide', 'arrears', 'M'), s3 = pick('australia', 'mining_iron_ore', 'A'), s4 = pick('adelaide', 'ind_mining', 'A');
console.log('\nsanity:', 'adelaide pyr_0_04=' + (s1 && s1.value), '| adelaide arrears(' + (s2 && s2.period) + ')=' + (s2 && s2.value), '| australia iron_ore(' + (s3 && s3.period.slice(0,4)) + ')=' + (s3 && s3.value), '| adelaide ind_mining=' + (s4 && s4.value));
console.log('TOTAL deferred rows:', all.length);

if (!process.argv.includes('--write')) { console.log('\nDry run. Re-run with --write to upsert.'); process.exit(0); }
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
let n = 0;
for (let i = 0; i < all.length; i += 1000) { const chunk = all.slice(i, i + 1000); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\nupsert', i, error.message); process.exit(1); } n += chunk.length; process.stdout.write(`\r  upserted ${n}/${all.length}`); }
console.log('');
for (const r of reports) await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: 'Data Dump 2026-06 (deferred)', row_count: r.rows, status: 'ok', notes: `${r.name} (${r.source}) ${r.kind}` });
console.log(`✓ Ingested ${n} deferred rows into rdp_raw_series.`);
