// =============================================================================
// build-ranking.mjs — derived Forge data point: Median Price Ranking (H/U).
//
// Ranks every region by median price (house + unit) each year, 2004 → the
// current year's latest month, from forge_monthly_price. Rank 1 = highest
// median price (Excel RANK, descending). This reproduces the "Traffic
// Lights.xlsx" H Ranking / U Ranking sheets (RANK(price,$AN$2:$AN$37,0)),
// which the Traffic Lights Value indicator reads (latest rank vs its own
// long-run average → is a market drifting cheaper/dearer relative to peers).
//
// Writes rdp_raw_series (source='derived', metric='ranking_h'/'ranking_u',
// freq='A', period 'YYYY-01-01', value=rank) — the same annual-series shape
// Data Forge already renders. No new table/migration.
//
// Dry-run by DEFAULT; --write upserts + logs rdp_runs + forge_data_status.
//   node scripts/build-ranking.mjs            # dry run + verify vs xlsx
//   node scripts/build-ranking.mjs --write    # upsert
// =============================================================================
import { createRequire } from 'module';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');

// ── 1) load monthly medians ──────────────────────────────────────────────────
const { data: mp, error } = await sb.from('forge_monthly_price').select('data').eq('id', 'latest').single();
if (error) { console.error('forge_monthly_price:', error.message); process.exit(1); }
const regions = (mp && mp.data && mp.data.regions) || {};
const slugs = Object.keys(regions);
if (!slugs.length) { console.error('forge_monthly_price has no regions'); process.exit(1); }

// ── 2) per region, per year → the year's LATEST month's median (H & U) ────────
// (later months overwrite earlier, so each year keeps its last available value;
//  the current year keeps its latest month — exactly "…to current year latest month".)
const byRegion = {};          // slug -> { h:{year:val}, u:{year:val} }
const yearSet = new Set();
for (const [slug, r] of Object.entries(regions)) {
  const h = {}, u = {}, months = r.months || [];
  for (let i = 0; i < months.length; i++) {
    const y = +String(months[i]).slice(0, 4); if (!y) continue;
    if (r.h && r.h[i] != null && r.h[i] > 0) { h[y] = r.h[i]; yearSet.add(y); }
    if (r.u && r.u[i] != null && r.u[i] > 0) { u[y] = r.u[i]; yearSet.add(y); }
  }
  byRegion[slug] = { h, u };
}
const years = [...yearSet].sort((a, b) => a - b);
const latestYr = years[years.length - 1];

// ── 3) rank per year, descending (Excel RANK: 1 + count strictly greater) ─────
const rankFor = vals => { const e = Object.entries(vals); const out = {}; for (const [s, v] of e) out[s] = 1 + e.filter(([, w]) => w > v).length; return out; };
const rankH = {}, rankU = {};   // year -> { slug: rank }
for (const y of years) {
  const hv = {}, uv = {};
  for (const [slug, rr] of Object.entries(byRegion)) { if (rr.h[y] != null) hv[slug] = rr.h[y]; if (rr.u[y] != null) uv[slug] = rr.u[y]; }
  rankH[y] = rankFor(hv); rankU[y] = rankFor(uv);
}

// ── 4) rows for rdp_raw_series ────────────────────────────────────────────────
const rows = [];
for (const y of years) {
  for (const [slug, rk] of Object.entries(rankH[y])) rows.push({ source: 'derived', region_slug: slug, metric: 'ranking_h', freq: 'A', period: `${y}-01-01`, value: rk });
  for (const [slug, rk] of Object.entries(rankU[y])) rows.push({ source: 'derived', region_slug: slug, metric: 'ranking_u', freq: 'A', period: `${y}-01-01`, value: rk });
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const avgRank = (rmap, slug) => mean(years.map(y => rmap[y][slug]).filter(v => v != null));

console.log(`Ranking — ${slugs.length} regions, years ${years[0]}–${latestYr} (${rows.length} rows)\n`);
console.log('  region'.padEnd(18), 'H rank', ' H avg', '  U rank', ' U avg');
for (const s of slugs.sort()) {
  console.log('  ' + s.padEnd(16), String(rankH[latestYr][s] ?? '—').padStart(5), String((avgRank(rankH, s) ?? 0).toFixed(1)).padStart(6), String(rankU[latestYr][s] ?? '—').padStart(7), String((avgRank(rankU, s) ?? 0).toFixed(1)).padStart(6));
}

// ── 5) verify vs Traffic Lights.xlsx capital sheets (AA48/AA50 = H latest/avg; AB = U) ──
const xlsxPath = join(homedir(), 'Downloads', 'Traffic Lights.xlsx');
if (existsSync(xlsxPath)) {
  const wb = XLSX.readFile(xlsxPath, { cellFormula: false });
  const raw = (sh, a) => { const c = wb.Sheets[sh] && wb.Sheets[sh][a]; return c == null ? null : c.v; };
  const CAPS = { Melbourne: 'melbourne', Sydney: 'sydney', Brisbane: 'brisbane', Perth: 'perth', Adelaide: 'adelaide', Canberra: 'canberra', Darwin: 'darwin', Hobart: 'hobart' };
  let ok = 0, tot = 0; const fails = [];
  console.log('\nVERIFY latest-year rank vs workbook (AA48 / AB48):');
  for (const [sheet, slug] of Object.entries(CAPS)) {
    const xlH = raw(sheet, 'AA48'), xlU = raw(sheet, 'AB48'), xlAvgH = raw(sheet, 'AA50'), xlAvgU = raw(sheet, 'AB50');
    const myH = rankH[latestYr][slug], myU = rankU[latestYr][slug], myAvgH = avgRank(rankH, slug), myAvgU = avgRank(rankU, slug);
    const chk = (mine, xl) => { if (xl == null) return ''; tot++; if (Math.round(mine) === Math.round(xl)) { ok++; return '✓'; } fails.push(`${slug}: mine ${mine} vs xlsx ${xl}`); return '✗'; };
    const rH = chk(myH, xlH), rU = chk(myU, xlU);
    console.log(`  ${sheet.padEnd(10)} H ${String(myH).padStart(2)} vs ${String(xlH).padStart(2)} ${rH}  (avg ${(myAvgH ?? 0).toFixed(1)} vs ${xlAvgH != null ? (+xlAvgH).toFixed(1) : '—'})   U ${String(myU).padStart(2)} vs ${String(xlU).padStart(2)} ${rU}  (avg ${(myAvgU ?? 0).toFixed(1)} vs ${xlAvgU != null ? (+xlAvgU).toFixed(1) : '—'})`);
  }
  console.log(`  → ${ok}/${tot} latest-year ranks match` + (fails.length ? '\n    ' + fails.join('\n    ') : ''));
}

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(0); }

// ── 6) write ──────────────────────────────────────────────────────────────────
let written = 0;
for (let k = 0; k < rows.length; k += 500) { const chunk = rows.slice(k, k + 500); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\n', error.message); process.exit(1); } written += chunk.length; }
const now = new Date().toISOString();
try { await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ranking ${now.slice(0, 7)}`, row_count: written, status: 'ok', notes: `ranking_h/ranking_u derived from forge_monthly_price, ${slugs.length} regions × ${years.length} years` }); } catch {}
try { await sb.from('forge_data_status').upsert({ data_key: 'ranking', label: 'Median Price Ranking (H/U)', source: 'derived', status: 'ok', message: `${slugs.length} regions, ${years[0]}–${latestYr}`, last_run_at: now, updated_at: now }, { onConflict: 'data_key' }); } catch {}
console.log(`\n✓ Upserted ${written} ranking rows into rdp_raw_series.`);
process.exit(0);
