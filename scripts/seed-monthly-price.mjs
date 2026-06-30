// =============================================================================
// seed-monthly-price.mjs — one-time seed of forge_monthly_price from the four
// "Data - Online Reports" cluster sheets (the reports' current source). Pulls
// each region tab's monthly median price (house + unit) from the
// "Date (Monthly)" / "Median House per Month" / "Median Unit per Month" columns.
// After this, the Cotality monthly drop appends new months in-app.
//
// Dry-run by default; --write upserts forge_monthly_price.
//   node scripts/seed-monthly-price.mjs            # dry run
//   node scripts/seed-monthly-price.mjs --write    # upsert
//
// Cluster files are read from ~/Downloads (same place the other imports use).
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
const DL = join(homedir(), 'Downloads');
const FILES = ['Data - Online Reports (Capital Cities).xlsx', 'Data - Online Reports (QLD - Regions).xlsx', 'Data - Online Reports (NSW - Regions).xlsx', 'Data - Online Reports (VIC_WA_TAS - Regions).xlsx'];
const SKIP = /guide|^v2 |dashboard|charts|^australia$/i;
const slug = s => String(s).replace(/\(.*?\)/g, '').split(',')[0].trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const label = s => { const sl = slug(s); return sl.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '); };
const monthStart = s => { if (typeof s !== 'number') return null; const d = new Date(Date.UTC(1899, 11, 30) + Math.round(s) * 86400000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-01'; };

const regions = {};
for (const f of FILES) {
  const p = join(DL, f); if (!existsSync(p)) { console.error('Missing file:', p); process.exit(1); }
  const wb = XLSX.read(readFileSync(p), { type: 'buffer' });
  for (const tab of wb.SheetNames) {
    if (SKIP.test(tab)) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[tab], { header: 1, raw: true, blankrows: false });
    const hdr = rows[0] || [];
    const cD = hdr.findIndex(h => /date.*month/i.test(String(h))), cH = hdr.findIndex(h => /median house per month/i.test(String(h))), cU = hdr.findIndex(h => /median unit per month/i.test(String(h)));
    if (cD < 0 || cH < 0) continue;
    const months = [], h = [], u = [];
    for (let r = 1; r < rows.length; r++) {
      const mo = monthStart(rows[r][cD]); if (!mo) continue;
      const hv = Number(rows[r][cH]), uv = Number(rows[r][cU]);
      months.push(mo); h.push(hv > 0 ? hv : null); u.push(uv > 0 ? uv : null);   // 0 / blank → missing
    }
    // trim trailing all-null rows (the sheet pads future months)
    let end = months.length; while (end > 0 && h[end - 1] == null && u[end - 1] == null) end--;
    if (end) regions[slug(tab)] = { label: label(tab), months: months.slice(0, end), h: h.slice(0, end), u: u.slice(0, end) };
  }
}

const slugs = Object.keys(regions).sort();
console.log(`Monthly median price — ${slugs.length} regions from ${FILES.length} cluster sheets\n`);
for (const s of slugs) { const r = regions[s]; const lastH = [...r.h].reverse().find(v => v != null), lastU = [...r.u].reverse().find(v => v != null); console.log('  ' + s.padEnd(16), r.months.length + ' mo', r.months[0].slice(0, 7) + '→' + r.months[r.months.length - 1].slice(0, 7), '| latest H $' + (lastH || 0).toLocaleString() + ' · U $' + (lastU || 0).toLocaleString()); }

if (!slugs.length) { console.error('\n✗ No monthly data extracted — check the cluster sheet column headers.'); process.exit(1); }
if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert forge_monthly_price.'); process.exit(0); }

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const now = new Date().toISOString();
const { error } = await sb.from('forge_monthly_price').upsert({ id: 'latest', data: { regions }, uploaded_at: now, updated_at: now, uploaded_by: 'seed-monthly-price' }, { onConflict: 'id' });
if (error) { console.error('\n', error.message); process.exit(1); }
try { await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `monthly price seed ${now.slice(0, 7)}`, row_count: slugs.length, status: 'ok', notes: `forge_monthly_price seeded from cluster sheets, ${slugs.length} regions` }); } catch {}
console.log(`\n✓ Seeded forge_monthly_price for ${slugs.length} regions.`);
process.exit(0);
