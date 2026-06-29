// =============================================================================
// ingest-abs-act-industry.mjs — Data Forge path: INDUSTRY VALUE ADDED, Canberra
// only, from the ABS Australian National Accounts: State Accounts (cat. 5220.0).
//
// WHY THIS EXISTS: the Industry Value Added data point is REMPLAN-sourced for 35
// of 36 regions, but REMPLAN does NOT cover Canberra for free. There is also NO
// ABS API for industry value added below the national level. HOWEVER — because
// the ACT is simultaneously a territory and (essentially) a single city, the ABS
// State Accounts publish ACT Gross Value Added by ANZSIC industry division in
// current prices ($m): Table 9, file 5220009_Annual_ACT.xlsx. That is the one
// region where a state-level figure equals the city, so we use it for Canberra.
//
// This downloads Table 9, reads the latest year's CURRENT-PRICE industry GVA for
// the 19 ANZSIC divisions, converts $m → raw dollars (×1e6, to match the
// REMPLAN-uploaded regions), and MERGES region 'canberra' into forge_industry —
// leaving every other region untouched. Re-run after each annual ABS release.
//
// Dry-run by DEFAULT (prints the composition). Pass --write to merge.
//
// Usage:
//   node scripts/ingest-abs-act-industry.mjs            # dry run
//   node scripts/ingest-abs-act-industry.mjs --write    # merge canberra
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'module';
import { readFileSync, existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');

const TABLE9 = 'https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-state-accounts/latest-release/5220009_Annual_ACT.xlsx';

// canonical 19 ANZSIC divisions + keyword matcher (identical to data-forge.html
// so the stored labels line up with the REMPLAN-sourced regions exactly)
const ANZSIC_DIVS = ['Agriculture, Forestry and Fishing', 'Mining', 'Manufacturing', 'Electricity, Gas, Water and Waste Services', 'Construction', 'Wholesale Trade', 'Retail Trade', 'Accommodation and Food Services', 'Transport, Postal and Warehousing', 'Information Media and Telecommunications', 'Financial and Insurance Services', 'Rental, Hiring and Real Estate Services', 'Professional, Scientific and Technical Services', 'Administrative and Support Services', 'Public Administration and Safety', 'Education and Training', 'Health Care and Social Assistance', 'Arts and Recreation Services', 'Other Services'];
const ANZSIC_KW = [['agricultur', 0], ['mining', 1], ['manufactur', 2], ['electricity', 3], ['gas, water', 3], ['construction', 4], ['wholesale', 5], ['retail', 6], ['accommodation', 7], ['food service', 7], ['postal', 8], ['transport', 8], ['information media', 9], ['telecommunication', 9], ['financial', 10], ['insurance', 10], ['real estate', 11], ['rental', 11], ['professional', 12], ['scientific', 12], ['administrative', 13], ['support service', 13], ['public admin', 14], ['safety', 14], ['education', 15], ['training', 15], ['health care', 16], ['social assist', 16], ['arts', 17], ['recreation', 17], ['other service', 18]];
function canonIndustry(name){
  if (name == null) return null;
  const n = String(name).toLowerCase().replace(/&/g, 'and');
  const flat = n.replace(/[^a-z]/g, ''); if (!flat) return null;
  for (let i = 0; i < ANZSIC_DIVS.length; i++) if (ANZSIC_DIVS[i].toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '') === flat) return ANZSIC_DIVS[i];
  for (const [kw, idx] of ANZSIC_KW) if (n.includes(kw)) return ANZSIC_DIVS[idx];
  return null;
}

// ── download + read Table 9 ──
let wb;
try {
  const r = await fetch(TABLE9);
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${TABLE9}`);
  wb = XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
} catch (e) { console.error('\n✗ Could not download ABS Table 9:', e.message, '\n  (check the file name on the latest-release page if ABS renamed it)'); process.exit(1); }

// ── Index: Series ID for each division's CURRENT-PRICE level industry GVA ──
const idx = XLSX.utils.sheet_to_json(wb.Sheets['Index'], { header: 1, raw: true, blankrows: false });
const hRow = idx.findIndex(r => /Data Item Description/i.test(String((r || [])[0] || '')));
const cId = (idx[hRow] || []).findIndex(x => /Series ID/i.test(String(x)));
const want = [];   // { ind, id }
for (let i = hRow + 1; i < idx.length; i++){
  const desc = String((idx[i] || [])[0] || ''); const id = String((idx[i] || [])[cId] || '').trim();
  if (!/^A\d{7}[A-Z]$/.test(id)) continue;
  const parts = desc.split(';').map(s => s.trim());
  if (parts[1] !== 'Industry gross value added: Current prices') continue;   // the plain level series only
  const ind = canonIndustry(parts[0].replace(/\s*\([A-S]\)\s*$/, ''));       // excludes Total / Ownership of dwellings
  if (ind && !want.some(w => w.ind === ind)) want.push({ ind, id });
}

// ── Data sheets: latest (bottom-most) numeric value per Series ID ──
function latestById(){
  const map = {};
  for (const sn of wb.SheetNames.filter(s => /^Data\d+$/.test(s))){
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, blankrows: false });
    const idRow = rows.findIndex(r => (r || []).some(c => /^A\d{7}[A-Z]$/.test(String(c || '').trim())));
    if (idRow < 0) continue;
    const ids = (rows[idRow] || []).map(c => String(c || '').trim());
    for (let c = 1; c < ids.length; c++){
      if (!/^A\d{7}[A-Z]$/.test(ids[c]) || map[ids[c]]) continue;
      for (let r = rows.length - 1; r > idRow; r--){ const v = rows[r][c]; if (typeof v === 'number' && !isNaN(v)){ map[ids[c]] = { val: v, serial: rows[r][0] }; break; } }
    }
  }
  return map;
}
const latest = latestById();
const yearOf = s => { const n = typeof s === 'number' ? s : null; if (n == null) return null; return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).getUTCFullYear(); };

// ── build Canberra composition ($m → raw $) ──
const values = {}; let totalM = 0; let fy = null;
for (const w of want){ const e = latest[w.id]; if (!e) continue; values[w.ind] = e.val * 1e6; totalM += e.val; const y = yearOf(e.serial); if (y && (!fy || y > fy)) fy = y; }
const count = Object.keys(values).length;
const total = totalM * 1e6;
const fyLabel = fy ? `${fy - 1}-${String(fy).slice(2)}` : '—';

// ── report ──
console.log(`ABS State Accounts Table 9 — Canberra (ACT) industry value added, current prices, FY ${fyLabel}\n`);
const sorted = Object.entries(values).sort((a, b) => b[1] - a[1]);
for (const [ind, v] of sorted) console.log('  ' + ind.padEnd(46), ('$' + (v / 1e9).toFixed(2) + 'b').padStart(9), (v / total * 100).toFixed(1) + '%');
console.log('  ' + 'TOTAL'.padEnd(46), ('$' + (total / 1e9).toFixed(2) + 'b').padStart(9));

if (count !== ANZSIC_DIVS.length || !(total > 0)) { console.error(`\n✗ COMPLETENESS FAIL: got ${count}/${ANZSIC_DIVS.length} divisions (total $${(total / 1e9).toFixed(2)}b). ABS may have changed Table 9 — inspect before writing.`); process.exit(1); }
console.log(`\n✓ All ${ANZSIC_DIVS.length} ANZSIC divisions resolved; total $${(total / 1e9).toFixed(2)}b.`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to merge region "canberra" into forge_industry (other regions untouched).'); process.exit(0); }

// ── merge ONLY canberra into forge_industry, preserving every other region ──
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const { data: existing } = await sb.from('forge_industry').select('data').eq('id', 'latest').maybeSingle();
const store = { industries: (existing && existing.data && existing.data.industries) || ANZSIC_DIVS, regions: Object.assign({}, existing && existing.data ? existing.data.regions : {}) };
store.regions['canberra'] = { label: 'Canberra', values, total };
const now = new Date().toISOString();
const { error } = await sb.from('forge_industry').upsert({ id: 'latest', data: store, uploaded_at: now, updated_at: now, uploaded_by: 'abs-act-industry' }, { onConflict: 'id' });
if (error) { console.error('\n', error.message); process.exit(1); }
try { await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS ACT industry ${now.slice(0, 7)}`, row_count: count, status: 'ok', notes: `5220.0 Table 9 ACT GVA by industry, current prices FY ${fyLabel}; merged region canberra into forge_industry (${Object.keys(store.regions).length} regions total)` }); } catch {}
console.log(`\n✓ Merged Canberra (FY ${fyLabel}) into forge_industry — ${Object.keys(store.regions).length} regions now stored.`);
process.exit(0);
