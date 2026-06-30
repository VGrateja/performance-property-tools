// =============================================================================
// seed-retail-history.mjs — backfill the NATIONAL retail-turnover deep history
// (1983-2012) that the live ABS feed can't reach.
//
// Forge's retail comes from the ABS Monthly Household Spending Indicator
// (5682.0, via ingest-abs-retail.mjs) which only backcasts to ~2012 — and its
// 2012 annual is a partial-year artifact (22,594 vs the report's 21,484). The
// National report's p16 chart runs from 1990, sourced from the legacy ABS
// Retail Trade series (8501.0, discontinued by ABS). That legacy history is
// IMMUTABLE, so we seed it once straight from the report's own "Retail Turnover"
// column (AE) on the AUSTRALIA cluster tab — exact match, no series-splice jump.
//
// Boundary: seed owns 1983-2012 (legacy); ingest-abs-retail owns 2013+ (HSI,
// which reproduces the report to the unit 2013-2025). ingest-abs-retail skips
// australia <= 2012 so this seed isn't clobbered.
//
// ISOLATED: rdp_raw_series (source='abs', region_slug='australia',
// metric='retail_turnover', freq='A'). Dry-run by DEFAULT; --write upserts.
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
const SPLICE = 2012;   // seed owns years <= SPLICE; the HSI feed owns the rest
const DD = join(homedir(), 'Downloads', 'Data - Online Reports (Capital Cities).xlsx');
if (!existsSync(DD)) { console.error('Missing cluster file:', DD); process.exit(1); }

const ws = XLSX.read(readFileSync(DD), { type: 'buffer' }).Sheets['AUSTRALIA'];
const g = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
const hdr = g[0];
const cAE = hdr.findIndex(h => /^retail turnover$/i.test(String(h).trim()));
if (cAE < 0) { console.error('Could not find the "Retail Turnover" column on the AUSTRALIA tab'); process.exit(1); }

const rows = [];
for (let r = 1; r < g.length; r++) {
  const yr = g[r][0], v = g[r][cAE];
  if (typeof yr !== 'number' || yr > SPLICE) continue;
  if (typeof v !== 'number' || !(v > 0)) continue;
  rows.push({ source: 'abs', region_slug: 'australia', metric: 'retail_turnover', freq: 'A', period: `${yr}-01-01`, value: v });
}
rows.sort((a, b) => a.period.localeCompare(b.period));
console.log(`Retail-turnover legacy backfill (national, <=${SPLICE}) — ${rows.length} rows`);
if (rows.length) console.log(`  ${rows[0].period.slice(0, 4)} = ${Math.round(rows[0].value).toLocaleString()} … ${rows[rows.length - 1].period.slice(0, 4)} = ${Math.round(rows[rows.length - 1].value).toLocaleString()}`);

if (!rows.length) { console.error('\n✗ No legacy retail rows extracted — check the AUSTRALIA tab header.'); process.exit(1); }
if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(0); }

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const { error } = await sb.from('rdp_raw_series').upsert(rows, { onConflict: 'source,region_slug,metric,freq,period' });
if (error) { console.error('\n', error.message); process.exit(1); }
try { await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `retail legacy backfill ${new Date().toISOString().slice(0, 7)}`, row_count: rows.length, status: 'ok', notes: `national retail_turnover legacy history (<=${SPLICE}) seeded from AUSTRALIA tab (legacy ABS Retail Trade 8501.0 values)` }); } catch {}
console.log(`\n✓ Seeded ${rows.length} national legacy retail rows into rdp_raw_series.`);
process.exit(0);
