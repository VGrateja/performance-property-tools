// =============================================================================
// ingest-sqm-history.mjs — SQM Research's FULL monthly history → Forge.
//
// WHY THIS EXISTS
// ---------------
// `ingest-sqm-vacancy.mjs` and `ingest-sqm-rents.mjs` fetch pages that embed the
// whole series and then keep only the last point:
//
//     const last = arr[arr.length - 1];        // ingest-sqm-vacancy.mjs
//
// So every month we downloaded twenty years of vacancy history and threw it
// away, and `forge_demand_inputs` (one row, id `latest`) overwrote the previous
// month. When the Runway v Demand V3 question needed monthly SQM vacancy and
// rent for Jan 2025 onward, the database had none of it -- only an ANNUAL
// series, one January reading per year. Measured at the source on 2026-09-17:
//
//     vacancy   260 monthly points   2005-01 .. 2026-08   per region
//     rents     816 weekly points    2009-08 .. 2026-09   per region
//
// Nothing was lost; it was never kept. This keeps it.
//
// WHERE IT WRITES, AND WHY NOT `rdp_raw_series`
// ---------------------------------------------
// The obvious home is `rdp_raw_series`, which already carries sqm/vacancy_rate
// and sqm/rent_h|rent_u -- but as ANNUAL rows, and its readers do not filter on
// `freq`. `tools/buying-selling-slides.html` reads those three metrics with no
// frequency filter at all: `getGlance()` keys everything by period and feeds
// `last()`, the year-on-year trends and the sparklines, and a second reader
// takes `order(period desc).limit(1)` as "the current vacancy". Writing ~250
// monthly rows per region under the same metric names would silently change a
// manager-approved client deck -- more data, different numbers, no error.
//
// So the history goes to `forge_demand_inputs` under its own ids. Every reader
// of that table filters `.eq('id', 'latest')` (checked, 2026-09-17), so extra
// ids are invisible to them. Same table as the card these series already feed,
// no migration, and no shared-series blast radius.
//
//   id `sqm_vacancy_history`  { updated, regions: { <slug>: { 'YYYY-MM': vrPct } } }
//   id `sqm_rent_history`     { updated, regions: { <slug>: { 'YYYY-MM': { h, u } } } }
//
// Rents are published weekly; a month takes its LAST published week, which is
// what a month-end reading means for a series the demand engine samples at a
// point in time.
//
// Dry-run by DEFAULT; --write upserts.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { SQM_REGIONS, SQM_UA, sqmUrl } from './sqm-regions.mjs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL_SB = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL_SB, KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function html(url) {
  const res = await fetch(url, { headers: { 'User-Agent': SQM_UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

/* vacancy: var data = [{year, month, properties, listings, vr}, …], vr decimal */
function vacancySeries(page) {
  const m = page.match(/var data = (\[[\s\S]*?\])\s*;/);
  if (!m) return null;
  let arr; try { arr = JSON.parse(m[1]); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const out = {};
  for (const p of arr) {
    const v = parseFloat(p && p.vr);
    if (!isFinite(v) || !p.year || !p.month) continue;
    out[p.year + '-' + String(p.month).padStart(2, '0')] = Math.round(v * 100 * 100) / 100;
  }
  return out;
}

/* rents: weekly {date, houses_all, units_all, …}; a month keeps its LAST week */
function rentSeries(page) {
  const pts = [...page.matchAll(/\{"date":"(\d{4})-(\d{2})-(\d{2})"([^}]*)\}/g)];
  if (!pts.length) return null;
  const out = {};
  for (const p of pts) {
    const key = p[1] + '-' + p[2];
    const body = p[4];
    const h = body.match(/"houses_all":([\d.]+)/);
    const u = body.match(/"units_all":([\d.]+)/);
    if (!h && !u) continue;
    const prev = out[key];
    /* later date in the same month wins */
    if (prev && prev._d >= p[3]) continue;
    out[key] = { h: h ? Number(h[1]) : null, u: u ? Number(u[1]) : null, _d: p[3] };
  }
  for (const k of Object.keys(out)) delete out[k]._d;
  return out;
}

const vac = {}, rent = {};
const fails = [];
for (const r of SQM_REGIONS) {
  try {
    const v = vacancySeries(await html(sqmUrl('vacancy-rates', r.qs)));
    if (v && Object.keys(v).length) vac[r.slug] = v; else fails.push(r.slug + ' vacancy: no series');
  } catch (e) { fails.push(r.slug + ' vacancy: ' + e.message); }
  await sleep(350);
  try {
    const t = rentSeries(await html(sqmUrl('weekly-rents', r.qs)));
    if (t && Object.keys(t).length) rent[r.slug] = t; else fails.push(r.slug + ' rents: no series');
  } catch (e) { fails.push(r.slug + ' rents: ' + e.message); }
  await sleep(350);
  const vm = Object.keys(vac[r.slug] || {}), rm = Object.keys(rent[r.slug] || {});
  console.log(r.slug.padEnd(18)
    + ' vacancy ' + String(vm.length).padStart(4) + (vm.length ? ' (' + vm.sort()[0] + '..' + vm.sort().pop() + ')' : '')
    + '   rents ' + String(rm.length).padStart(4) + (rm.length ? ' (' + rm.sort()[0] + '..' + rm.sort().pop() + ')' : ''));
}

const allV = Object.values(vac).reduce((n, o) => n + Object.keys(o).length, 0);
const allR = Object.values(rent).reduce((n, o) => n + Object.keys(o).length, 0);
console.log('\nregions with vacancy: ' + Object.keys(vac).length + '/' + SQM_REGIONS.length + '   monthly points: ' + allV);
console.log('regions with rents  : ' + Object.keys(rent).length + '/' + SQM_REGIONS.length + '   monthly points: ' + allR);
if (fails.length) { console.log('\nFAILURES (' + fails.length + '):'); fails.forEach(f => console.log('   ' + f)); }

if (!WRITE) { console.log('\nDry run. Re-run with --write to store.'); process.exit(0); }
const now = new Date().toISOString();
for (const [id, payload] of [['sqm_vacancy_history', { updated: now, regions: vac }], ['sqm_rent_history', { updated: now, regions: rent }]]) {
  const { error } = await sb.from('forge_demand_inputs')
    .upsert({ id, data: payload, updated_at: now, uploaded_at: now, uploaded_by: 'ingest-sqm-history' }, { onConflict: 'id' });
  if (error) { console.error('write failed for ' + id + ': ' + error.message); process.exit(1); }
  console.log('stored ' + id + '  (' + (JSON.stringify(payload).length / 1024).toFixed(0) + ' kB)');
}
