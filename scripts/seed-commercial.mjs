// =============================================================================
// seed-commercial.mjs — seed forge_commercial from the "Commercial Report Data
// for Looker" workbook (the Commercial report's actual source).
//
// Commercial is a fresh domain: ~12 of its 17 charts are commercial-specific
// series Forge has never carried, and ~half come from manual / subscription
// sources (CBRE/Colliers/Savills/Knight Frank, Statista, port authorities,
// budget papers) with no clean public API. The RBA/ABS series that DO exist
// aren't cleanly matchable (F2 govt-bond CSV carries no history; F3 has 26
// rating×maturity series; PPI is per-capital) — so we mirror the report's exact
// source here for guaranteed parity, and can later upgrade individual
// time-series (PPI, bonds, term deposits, retail, approvals) to API refreshes.
//
// Shape mirrors the commercial Apps Script feed: each grid tab → slugified key →
// { headers:[...], columns:{ camelKey:[values] } }. Date-serial columns are
// converted to YYYY-MM-DD with the safe round (see the xlsx date gotcha);
// duplicate headers are de-duped (adel, adel_2) so no column is dropped.
//
// ISOLATED: forge_commercial (mig 060). Dry-run by DEFAULT; --write upserts.
//   node scripts/seed-commercial.mjs            # dry run (prints tab/column map)
//   node scripts/seed-commercial.mjs --write    # upsert forge_commercial
// =============================================================================
import { createRequire } from 'module';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const DD = join(homedir(), 'Downloads', 'Commercial Report Data for Looker.xlsx');
if (!existsSync(DD)) { console.error('Missing workbook:', DD); process.exit(1); }

const SKIP = /^(README|INSTRUCTIONS|GUIDE|DASHBOARD GUIDE|CHECKLIST)$/i;
const slug = s => String(s).trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const camel = s => String(s).replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().split(' ').map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
const ERR = /^#(REF|N\/A|VALUE|NAME|NUM|ERROR|DIV\/0)/;
// excel serial -> YYYY-MM-DD (safe: UTC epoch + round; absorbs the .9997 float underflow)
const toIso = s => { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(s) * 86400000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); };
const isSerial = v => typeof v === 'number' && v >= 20000 && v <= 60000;   // ~1954..2064 as Excel date serials

const wb = XLSX.read(readFileSync(DD), { type: 'buffer' });
const tabs = {};
let tabCount = 0, colCount = 0;
for (const name of wb.SheetNames) {
  if (SKIP.test(name.trim())) continue;
  const ws = wb.Sheets[name];
  if (!ws || !ws['!ref']) continue;                               // empty (chart-only) tab
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });
  if (grid.length < 2) continue;
  const headers = (grid[0] || []).map(h => String(h ?? '').trim().replace(/\s+/g, ' '));
  const body = grid.slice(1);
  const columns = {}; const used = {};
  headers.forEach((hdr, c) => {
    if (!hdr) return;
    let key = camel(hdr) || ('col' + c);
    if (used[key]) { used[key]++; key = key + '_' + used[key]; } else used[key] = 1;
    // collect, mark whether this column is a date-serial column
    let col = body.map(r => r[c]);
    const dateLike = (c === 0 || /date|period|effective|month|quarter|year/i.test(hdr));
    const sample = col.find(v => typeof v === 'number');
    const asDate = dateLike && isSerial(sample);
    col = col.map(v => {
      if (v === '' || v == null) return null;
      if (typeof v === 'string' && ERR.test(v)) return null;
      if (asDate && isSerial(v)) return toIso(v);
      if (v instanceof Date) return v.toISOString();
      return v;
    });
    // trim trailing nulls
    let end = col.length; while (end > 0 && col[end - 1] == null) end--;
    columns[key] = col.slice(0, end);
    colCount++;
  });
  if (Object.keys(columns).length) { tabs[slug(name)] = { name, headers, columns }; tabCount++; }
}

const slugs = Object.keys(tabs).sort();
console.log(`forge_commercial — ${tabCount} data tabs, ${colCount} columns from the Looker workbook\n`);
for (const s of slugs) { const t = tabs[s]; const cols = Object.keys(t.columns); console.log('  ' + s.padEnd(34) + cols.length + ' cols: ' + cols.slice(0, 6).join(', ') + (cols.length > 6 ? ' …' : '')); }

if (!tabCount) { console.error('\n✗ No data tabs extracted.'); process.exit(1); }
if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert forge_commercial (needs migration 060 applied).'); process.exit(0); }

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const now = new Date().toISOString();
const data = { _meta: { source: 'Commercial Report Data for Looker.xlsx', tabCount, colCount, seeded: now }, tabs };
const { error } = await sb.from('forge_commercial').upsert({ id: 'latest', data, uploaded_at: now, updated_at: now, uploaded_by: 'seed-commercial' }, { onConflict: 'id' });
if (error) { console.error('\n', error.message); process.exit(1); }
try { await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `commercial seed ${now.slice(0, 7)}`, row_count: tabCount, status: 'ok', notes: `forge_commercial seeded from Looker workbook, ${tabCount} tabs / ${colCount} cols` }); } catch {}
console.log(`\n✓ Seeded forge_commercial (${tabCount} tabs, ${colCount} cols).`);
process.exit(0);
