// =============================================================================
// build-national-report.mjs  —  national ('australia') row for rdp_report_feed.
//
// The National report tab (AUSTRALIA) is its own structure: cap-city / regional
// median = median across capital / regional cities; the rest from national raw.
// Verifies the derivable columns against the AUSTRALIA cluster tab, then upserts
// region_slug='australia' (cluster='national') into rdp_report_feed.
//
// Dry-run by DEFAULT; --write upserts + logs rdp_runs.
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import './../shared/national-report-calc.js';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');

const { data: regions } = await sb.from('rdp_regions').select('slug,cluster');
const capitals = regions.filter(r => r.cluster === 'capital' && r.slug !== 'australia').map(r => r.slug);
const regionals = regions.filter(r => ['qld', 'nsw', 'vicwatas'].includes(r.cluster)).map(r => r.slug);

let rows = [], from = 0;
for (;;) { const { data, error } = await sb.from('rdp_raw_series').select('region_slug,metric,period,value').eq('freq', 'A').order('region_slug').order('metric').order('period').range(from, from + 999); if (error) { console.error(error.message); process.exit(1); } rows.push(...data.map(r => ({ ...r, value: Number(r.value) }))); if (data.length < 1000) break; from += 1000; }

const years = []; for (let y = 1980; y <= 2026; y++) years.push(y);
const feed = globalThis.NationalReportCalc.computeNationalReport({ rows, capitals, regionals, years });
const byYear = Object.fromEntries(feed.map(r => [r.year, r]));
console.log('capitals:', capitals.length, '| regionals:', regionals.length, '| years:', feed.length);

// verify vs AUSTRALIA cluster tab
const ddPath = join(homedir(), 'Downloads', 'Data - Online Reports (Capital Cities).xlsx');
if (existsSync(ddPath)) {
  const g = XLSX.utils.sheet_to_json(XLSX.readFile(ddPath, { cellFormula: false }).Sheets['AUSTRALIA'], { header: 1, raw: true, defval: '' });
  const rowOf = {}; g.forEach((r, i) => { if (typeof r[0] === 'number') rowOf[r[0]] = i; });
  const ci = L => { let n = 0; for (const c of L) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };
  const COL = { B: 'cash_rate', C: 'bank_rate', D: 'inflation', E: 'median_income', F: 'annualized_income', G: 'cap_city_median', H: 'cap_city_pct', I: 'regional_median', J: 'regional_pct', K: 'ai_cap_city', L: 'ai_regions', M: 'p2i_cap_city', N: 'p2i_regions', O: 'population', P: 'pop_change', Q: 'pop_pct', R: 'natural_increase', S: 'nom', V: 'unemployment', W: 'underemployment', X: 'commenced_h', Y: 'commenced_u', Z: 'commenced_total', AA: 'approvals_h', AB: 'approvals_u', AC: 'approvals_total', AD: 'bedroom_commencements' };
  const STC = { CV: 'nsw', CW: 'wa', CX: 'vic', CY: 'qld', CZ: 'sa', DA: 'nt', DB: 'act', DC: 'tas' };
  const close = (a, b) => (a == null || b == null) ? false : Math.abs(a - b) <= 1 + 1e-4 * Math.abs(b);
  let checks = 0, pass = 0; const fails = [];
  for (let y = 2016; y <= 2025; y++) { const cr = g[rowOf[y]]; if (!cr || !byYear[y]) continue;
    for (const [L, key] of Object.entries(COL)) { const exp = cr[ci(L)]; if (exp === '' || exp == null) continue; checks++; if (close(typeof byYear[y][key] === 'number' ? byYear[y][key] : null, typeof exp === 'number' ? exp : null)) pass++; else fails.push(`${L} ${key} ${y}: tab=${exp} calc=${byYear[y][key]}`); }
    for (const [L, st] of Object.entries(STC)) { const exp = cr[ci(L)]; if (exp === '' || exp == null) continue; checks++; if (close(byYear[y].state_median_house[st], typeof exp === 'number' ? exp : null)) pass++; else fails.push(`${L} state.${st} ${y}: tab=${exp} calc=${byYear[y].state_median_house[st]}`); }
  }
  console.log(`VERIFY vs AUSTRALIA tab: ${pass}/${checks} match`);
  if (fails.length) for (const f of fails.slice(0, 25)) console.log('  ' + f);
}
const s25 = byYear[2025] || byYear[2024];
if (s25) console.log(`sample ${s25.year}: capCityMedian=${s25.cap_city_median} regionalMedian=${s25.regional_median} p2i_cap=${(s25.p2i_cap_city||0).toFixed(2)} pop=${s25.population}`);

if (!WRITE) { console.log('\nDry run complete. Re-run with --write to upsert.'); process.exit(0); }
const nonEmpty = feed.filter(r => r.cap_city_median != null || r.population != null);
const stamp = new Date().toISOString();
const { error } = await sb.from('rdp_report_feed').upsert({ region_slug: 'australia', cluster: 'national', payload: { national: true, years: nonEmpty }, source_month: 'Data Dump 2026-06', computed_at: stamp }, { onConflict: 'region_slug' });
if (error) { console.error(error.message); process.exit(1); }
await sb.from('rdp_runs').insert({ dataset: 'report_feed', source_month: 'Data Dump 2026-06', row_count: 1, status: 'ok', notes: 'national (australia) aggregate; NationalReportCalc' });
console.log('✓ Built national report_feed (australia).');
