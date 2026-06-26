// Verify ReportFeedCalc reproduces the "Adelaide, SA" cluster tab from rdp_raw_series.
// Reads raw from the DB (service-role .env), runs the calc, compares cell-by-cell.
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import './../shared/report-feed-calc.js';   // sets globalThis.ReportFeedCalc

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const colIdx = L => { let n = 0; for (const ch of L) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
// cluster column letter -> calc key
const COLMAP = {
  B: 'cash_rate', C: 'bank_rate', D: 'median_income', E: 'mp_h', F: 'mp_u', G: 'sales_h', H: 'sales_u', I: 'sales_total',
  J: 'pct_diff_hu', K: 'house_yoy', L: 'unit_yoy', M: 'cagr_h_3', N: 'cagr_h_10', O: 'cagr_u_3', P: 'cagr_u_10',
  Q: 'pi_house', R: 'pi_unit', S: 'ai_pi_house', T: 'ai_pi_unit', U: 'ai_house_state', V: 'ai_unit_state',
  W: 'p2i_house', X: 'p2i_unit', Y: 'adom_h', Z: 'adom_u', AA: 'som_h', AB: 'som_u', AC: 'vacancy_rate',
  AD: 'rent_h', AE: 'rent_u', AF: 'rent2inc_house', AG: 'rent2inc_unit', AH: 'yield_house', AI: 'yield_unit',
  AJ: 'pop_metro', AK: 'pct_change_metro', AL: 'pop_state', AM: 'pct_change_state', AN: 'pop_national', AO: 'pct_change_national',
  AP: 'natural_increase', AQ: 'nim', AR: 'nom', AS: 'unemp_metro', AT: 'unemp_state', AU: 'unemp_national',
  AV: 'approvals_h', AW: 'approvals_u', AX: 'approvals_total', BW: 'capcity_benchmark', BX: 'capcity_pct_diff',
  BY: 'new_pop_metro', BZ: 'household',
};

// ── load raw from DB ──
const slugs = ['adelaide', 'st-sa', 'australia', 'sydney'];
let rows = [], from = 0;
for (;;) {
  const { data, error } = await sb.from('rdp_raw_series').select('region_slug,metric,period,value').in('region_slug', slugs).eq('freq', 'A').order('region_slug').order('metric').order('period').range(from, from + 999);
  if (error) { console.error('DB read failed:', error.message); process.exit(1); }
  rows.push(...data.map(r => ({ ...r, value: Number(r.value) })));
  if (data.length < 1000) break; from += 1000;
}
console.log('loaded', rows.length, 'raw rows for', slugs.join(', '));

const YEARS = []; for (let y = 2016; y <= 2025; y++) YEARS.push(y);
const feed = globalThis.ReportFeedCalc.computeReportFeed({ region: 'adelaide', state: 'st-sa', benchmark: 'sydney', rows, years: YEARS });
const byYear = Object.fromEntries(feed.map(r => [r.year, r]));

// ── cluster expected ──
const wb = XLSX.readFile('C:/Users/vandolf_performancep/Downloads/Data - Online Reports (Capital Cities).xlsx', { cellFormula: false });
const g = XLSX.utils.sheet_to_json(wb.Sheets['Adelaide, SA'], { header: 1, raw: true, defval: '' });
const rowOf = {}; g.forEach((r, i) => { if (typeof r[0] === 'number') rowOf[r[0]] = i; });

const close = (a, b) => (a == null && b == null) ? true : (a == null || b == null) ? false : Math.abs(a - b) <= 1e-6 + 1e-5 * Math.abs(b);
let checks = 0, pass = 0; const fails = [];
for (const y of YEARS) {
  const cr = g[rowOf[y]]; if (!cr) continue;
  for (const [L, key] of Object.entries(COLMAP)) {
    const exp = cr[colIdx(L)]; if (exp === '' || exp == null) continue;          // only check where cluster has a value
    const got = byYear[y][key];
    checks++;
    if (close(typeof got === 'number' ? got : null, typeof exp === 'number' ? exp : null)) pass++;
    else fails.push({ L, key, y, exp, got });
  }
}
console.log(`\nCHECKS: ${pass}/${checks} match`);
if (fails.length) {
  console.log('MISMATCHES (first 40):');
  for (const f of fails.slice(0, 40)) console.log(`  ${f.L} ${f.key.padEnd(20)} ${f.y}: cluster=${f.exp}  calc=${f.got}`);
  // which columns are systematically off?
  const byCol = {}; for (const f of fails) byCol[f.L + ' ' + f.key] = (byCol[f.L + ' ' + f.key] || 0) + 1;
  console.log('\nfailing columns:', Object.entries(byCol).map(([k, n]) => k + '×' + n).join(', '));
} else console.log('✓ ALL MATCH — report_feed calculator reproduces the cluster tab.');
