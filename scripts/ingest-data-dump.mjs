// =============================================================================
// ingest-data-dump.mjs  —  P1 ingestion for the central research-data store.
//
// Parses the raw sheets of "Data Dump - Online Report.xlsx" into the canonical
// long-format table rdp_raw_series (migration 050): (source, region_slug,
// metric, freq, period, value). Two sheet shapes are handled:
//   • BLOCK matrices  (CLPF, SQM, CLRent) — region in row1, metric in row2.
//   • WIDE columns    (National&State, Population, Approvals, Unemployment) —
//     each header encodes its own region + metric across 3 geo levels
//     (national = "australia", state = "st-xx", city = the report slug).
//
// ISOLATED: writes ONLY to rdp_raw_series + logs rdp_runs. Dry-run by DEFAULT;
// pass --write to upsert (needs migration 050 applied + a local .env key).
// State/metric dimension rows are added by migration 051 (not required to write,
// since raw_series doesn't FK to them).
//
//   node scripts/ingest-data-dump.mjs ["<file.xlsx>"]            # dry run
//   node scripts/ingest-data-dump.mjs ["<file.xlsx>"] --write     # upsert
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try { // local git-ignored .env (repo root)
  if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

const ST = 'act|nsw|nt|qld|sa|tas|vic|wa';                 // state codes
const stateSlug = c => 'st-' + c.toLowerCase();

// ── canonical city slugs (must match migration 050 seed) ─────────────────────
const SLUGS = new Set([
  'australia','sydney','melbourne','brisbane','perth','adelaide','canberra','hobart','darwin',
  'mackay','bundaberg','ipswich','rockhampton','gladstone','cairns','townsville','sunshine-coast','toowoomba','gold-coast',
  'albury','central-coast','coffs-harbour','newcastle','orange','port-macquarie','tamworth','wagga-wagga','wollongong',
  'ballarat','bendigo','geelong','wodonga','mildura','mandurah','rockingham','bunbury','launceston',
]);

// resolve a city label ("SYDNEY (NSW)", "ADELAIDE, SA", "GREATER BENDIGO (VIC) 3550", "Mackay") -> slug | null
function resolveCity(label) {
  if (label == null) return null;
  let s = String(label).trim();
  if (s === '' || /^year$/i.test(s)) return null;
  if (/^national$/i.test(s)) return 'australia';
  s = s.replace(/\([^)]*\)/g, ' ')                              // (NSW)
       .replace(new RegExp(',\\s*(' + ST + ')\\b', 'ig'), ' ')   // ", SA"
       .replace(/\b\d{3,4}\b/g, ' ')                            // postcode
       .replace(/\bgreater\b/ig, ' ')
       .replace(/\s+/g, ' ').trim().toLowerCase()
       .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return SLUGS.has(s) ? s : null;
}

// ── BLOCK sheets: row2 metric label -> code ──────────────────────────────────
const BLOCK = {
  CLPF: { source: 'corelogic', metrics: {
    'MP - H': 'mp_h', 'MP - U': 'mp_u', 'Sales - H': 'sales_h', 'Sales - U': 'sales_u', 'ADOM - H': 'adom_h', 'ADOM - U': 'adom_u' } },
  SQM: { source: 'sqm', metrics: {
    'SOM - H': 'som_h', 'SOM - U': 'som_u', 'Vacancy Rate': 'vacancy_rate', 'Rent - H': 'rent_h', 'Rent - U': 'rent_u' } },
  CLRent: { source: 'corelogic', metrics: {
    'SOM - H': 'som_h', 'SOM - U': 'som_u', 'VR - H': 'vacancy_rate_h', 'VR - U': 'vacancy_rate_u', 'Rent - H': 'rent_h', 'Rent - U': 'rent_u' } },
};

function parseBlock(g, cfg) {
  const r1 = g[0] || [], r2 = g[1] || [];
  const maxC = Math.max(r1.length, r2.length);
  const cols = []; let cur = null; const regions = new Set(), unresolved = new Set();
  for (let c = 0; c < maxC; c++) {
    const lab1 = String(r1[c] ?? '').trim();
    if (lab1 !== '') { const slug = resolveCity(lab1); if (slug) { cur = slug; regions.add(slug); } else { cur = null; if (!/^year$/i.test(lab1)) unresolved.add(lab1); } }
    const metric = cfg.metrics[String(r2[c] ?? '').trim()];
    if (metric && cur) cols.push({ c, slug: cur, metric });
  }
  return emit(g, cfg.source, cols, regions, unresolved);
}

// ── WIDE sheets: per-sheet header -> {region_slug, metric} ───────────────────
const popMetric = w => ({ 'natural increase': 'natural_increase', 'nom': 'nom', 'nim': 'nim', 'population': 'population' }[w.toLowerCase()]);

const WIDE = {
  // Only the YEAR-indexed columns (B–M, left of "Date (Monthly)"). The monthly
  // section to the right (Owner Occupier, Investor, Retail Turnover, Bus.
  // Investment, FHB) is deferred to a future freq='M' parser — reading it
  // against the year column would misalign.
  'National&State Data': { source: 'abs', map: h => {
    if (/^cash rate$/i.test(h)) return { region_slug: 'australia', metric: 'cash_rate', source: 'rba' };
    if (/^bank rate$/i.test(h)) return { region_slug: 'australia', metric: 'bank_rate', source: 'rba' };
    if (/inflation/i.test(h)) return { region_slug: 'australia', metric: 'inflation', source: 'rba' };
    if (/^national\s*-\s*median income/i.test(h)) return { region_slug: 'australia', metric: 'median_income' };
    let m = h.match(new RegExp('^(' + ST + ')\\s*-\\s*median income', 'i')); if (m) return { region_slug: stateSlug(m[1]), metric: 'median_income' };
    return null; } },
  Population: { source: 'abs', map: h => {
    if (/^national$/i.test(h)) return { region_slug: 'australia', metric: 'population' };
    let m = h.match(/^national\s*-\s*(natural increase|nom|nim)$/i); if (m) return { region_slug: 'australia', metric: popMetric(m[1]) };
    m = h.match(new RegExp('^(' + ST + ')\\s*-\\s*(population|natural increase|nom|nim)$', 'i')); if (m) return { region_slug: stateSlug(m[1]), metric: popMetric(m[2]) };
    m = h.match(/^(.+?)\s*-\s*(natural increase|nom|nim)$/i); if (m) { const c = resolveCity(m[1]); if (c) return { region_slug: c, metric: popMetric(m[2]) }; }
    m = h.match(new RegExp('^(.+?),\\s*(' + ST + ')\\s*$', 'i')); if (m) { const s = resolveCity(m[1]); if (s) return { region_slug: s, metric: 'population' }; }
    return null; } },
  Approvals: { source: 'abs', map: h => {
    const m0 = h.match(/^([HU])\s*-\s*(.+)$/i); if (!m0) return null; const pt = m0[1].toLowerCase(); const s = m0[2].trim();
    if (/national.*commenced/i.test(s)) return { region_slug: 'australia', metric: 'commenced_' + pt };
    if (/national.*approval/i.test(s)) return { region_slug: 'australia', metric: 'approvals_' + pt };
    const m = s.match(new RegExp('^(.+?),\\s*(' + ST + ')\\s*$', 'i')); if (m) { const c = resolveCity(m[1]); if (c) return { region_slug: c, metric: 'approvals_' + pt }; }
    return null; } },
  Unemployment: { source: 'abs', map: h => {
    if (/national unemployment/i.test(h)) return { region_slug: 'australia', metric: 'unemployment' };
    if (/national underemployment/i.test(h)) return { region_slug: 'australia', metric: 'underemployment' };
    let m = h.match(new RegExp('^(.+?),\\s*(' + ST + ')\\s*-\\s*unemployment', 'i')); if (m) { const c = resolveCity(m[1]); if (c) return { region_slug: c, metric: 'unemployment' }; }
    m = h.match(new RegExp('^(' + ST + ')\\s+unemployment', 'i')); if (m) return { region_slug: stateSlug(m[1]), metric: 'unemployment' };
    m = h.match(new RegExp('^(.+?),\\s*(' + ST + ')\\s*$', 'i')); if (m) { const c = resolveCity(m[1]); if (c) return { region_slug: c, metric: 'unemployment' }; }
    return null; } },
};

function parseWide(g, cfg) {
  const r1 = g[0] || [];
  const cols = []; const regions = new Set(), unresolved = new Set();
  for (let c = 1; c < r1.length; c++) {
    const h = String(r1[c] ?? '').replace(/\s+/g, ' ').trim(); if (!h) continue;
    const mp = cfg.map(h);
    if (mp && mp.region_slug && mp.metric) { cols.push({ c, slug: mp.region_slug, metric: mp.metric, source: mp.source }); regions.add(mp.region_slug); }
    else if (!/date.*monthly|owner occupier|investor|retail turnover|bus\.? investment|annual fhb|^\s*$/i.test(h)) unresolved.add(h);  // monthly-section macro = deferred
  }
  return emit(g, cfg.source, cols, regions, unresolved);
}

// shared: read values down col A (year) for the mapped columns
function emit(g, source, cols, regions, unresolved) {
  const rows = [];
  for (let r = 1; r < g.length; r++) {
    const y = g[r][0]; if (typeof y !== 'number' || !isFinite(y)) continue;
    const year = Math.round(y); if (year < 1900 || year > 2100) continue;
    const period = `${year}-01-01`;
    for (const col of cols) { const v = g[r][col.c]; if (typeof v === 'number' && isFinite(v)) rows.push({ source: col.source || source, region_slug: col.slug, metric: col.metric, freq: 'A', period, value: v }); }
  }
  return { rows, regions: [...regions], unresolved: [...unresolved] };
}

// ── run ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const FILE = argv.find(a => !a.startsWith('--')) || join(homedir(), 'Downloads', 'Data Dump - Online Report.xlsx');
if (!existsSync(FILE)) { console.error('File not found:', FILE); process.exit(1); }
console.log('Reading', FILE, WRITE ? '(WRITE mode)' : '(dry run — no DB writes)');
const wb = XLSX.readFile(FILE, { cellFormula: false });
const grid = name => wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' }) : null;

const all = []; const reports = [];
function handle(name, kind, cfg) {
  const g = grid(name); if (!g) { console.log(`\n[${name}] MISSING`); return; }
  const { rows, regions, unresolved } = kind === 'block' ? parseBlock(g, cfg) : parseWide(g, cfg);
  all.push(...rows);
  const yrs = rows.map(r => +r.period.slice(0, 4));
  const metrics = [...new Set(rows.map(r => r.metric))];
  reports.push({ name, source: cfg.source, rows: rows.length, regions: regions.length, metrics });
  console.log(`\n[${name} · ${cfg.source}] rows=${rows.length} regions=${regions.length} years=${yrs.length ? Math.min(...yrs) + '-' + Math.max(...yrs) : '—'}`);
  console.log('   metrics:', metrics.join(', '));
  if (unresolved.length) console.log('   ⚠ UNRESOLVED headers:', unresolved.slice(0, 12).join(' | '));
}
for (const [n, c] of Object.entries(BLOCK)) handle(n, 'block', c);
for (const [n, c] of Object.entries(WIDE)) handle(n, 'wide', c);

// a couple of cross-checks
const pick = (slug, metric, year) => { const r = all.find(x => x.region_slug === slug && x.metric === metric && x.period === year + '-01-01'); return r ? r.value : '—'; };
console.log('\nSanity:',
  'adelaide mp_h 2026 =', pick('adelaide', 'mp_h', 2026),
  '| adelaide population 2024 =', pick('adelaide', 'population', 2024),
  '| australia cash_rate 2024 =', pick('australia', 'cash_rate', 2024),
  '| st-sa median_income 2024 =', pick('st-sa', 'median_income', 2024));
console.log('TOTAL parsed rows:', all.length, '| distinct regions:', new Set(all.map(r => r.region_slug)).size, '| distinct metrics:', new Set(all.map(r => r.metric)).size);

if (!WRITE) { console.log('\nDry run complete. Re-run with --write to upsert.'); process.exit(0); }

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const month = (FILE.match(/\d{4}-\d{2}(-\d{2})?/) || [])[0] || null;
let written = 0;
for (let i = 0; i < all.length; i += 1000) {
  const chunk = all.slice(i, i + 1000);
  const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' });
  if (error) { console.error('\nUpsert failed at', i, ':', error.message); process.exit(1); }
  written += chunk.length; process.stdout.write(`\r  upserted ${written}/${all.length}`);
}
console.log('');
for (const r of reports) await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: month, row_count: r.rows, status: 'ok', notes: `${r.name} (${r.source}): ${r.regions} regions, ${r.metrics.length} metrics` });
console.log(`✓ Ingested ${written} rows into rdp_raw_series; logged ${reports.length} runs.`);
