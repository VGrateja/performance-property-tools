// =============================================================================
// ingest-abs-income.mjs — Data Forge path: MEDIAN WEEKLY INCOME (national + 8
// states) straight from the ABS Data API (https://data.api.abs.gov.au). No key.
//
// The DB's `median_income` is ABS Average Weekly Earnings, pinned to this exact
// series (verified 27/27 vs the DB across 9 regions × 3 years):
//   dataflow AWE
//   MEASURE=3       Full-time adult average weekly ORDINARY time earnings
//   ESTIMATE_TYPE=1 Earnings ($)            (2 = Standard Error — skip)
//   SEX=3           Persons
//   SECTOR=7        Private and Public
//   INDUSTRY=TOT    All Industries
//   TSEST=10        Original                (national Original == Seas.Adj here)
//   FREQ=S          half-yearly (S1=May, S2=Nov)
//   REGION          AUS → 'australia', 1..8 → st-nsw..st-act
//
// HALF-YEAR RULE (user's): AWE releases twice a year. The WHOLE series is
// re-based to whichever half the LATEST release is — if the newest data is May
// (S1) every year uses its May value; if November (S2) every year uses Nov.
// The script derives the half from the latest period in the data (no hardcode).
//
// CARRY-FORWARD: the next period isn't out yet, so (like the existing DB) the
// latest year's value is carried forward one year so "current year" income
// lookups in the reports/runway always resolve.
//
// ISOLATED: writes ONLY to rdp_raw_series (source='abs', metric='median_income',
// freq='A', period 'YYYY-01-01') + logs rdp_runs + records health in
// forge_data_status (data_key='income'). COMPLETENESS GUARD over all 9 regions.
//
// Dry-run by DEFAULT; --write upserts; --from=YYYY limits the start year.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const FROM = +((process.argv.find(a => a.startsWith('--from=')) || '--from=2001').split('=')[1]) || 2001;

const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`ABS ${r.status}: ${t.slice(0, 80)}`); } };

const REG = { AUS: 'australia', '1': 'st-nsw', '2': 'st-vic', '3': 'st-qld', '4': 'st-sa', '5': 'st-wa', '6': 'st-tas', '7': 'st-nt', '8': 'st-act' };

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const FK = 'income', FLABEL = 'Income Data', FSOURCE = 'ABS Average Weekly Earnings (AWE)';
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: FK, label: FLABEL, source: FSOURCE, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated — apply migration 053? ' + error.message + ')');
}

const rows = [];
let latestHalf = 'S2';
try {
  // AWE: pull /all from FROM, filter the one series, collect both half-years
  const j = await getJson(`${API}/data/AWE/all?startPeriod=${FROM}-S1&format=jsondata&dimensionAtObservation=AllDimensions`);
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const i = id => od.findIndex(d => d.id === id);
  const mI = i('MEASURE'), etI = i('ESTIMATE_TYPE'), sxI = i('SEX'), scI = i('SECTOR'), inI = i('INDUSTRY'), tsI = i('TSEST'), rI = i('REGION'), tI = i('TIME_PERIOD');
  const raw = [];
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    if (od[mI].values[ix[mI]].id !== '3' || od[etI].values[ix[etI]].id !== '1' || od[sxI].values[ix[sxI]].id !== '3'
      || od[scI].values[ix[scI]].id !== '7' || od[inI].values[ix[inI]].id !== 'TOT' || od[tsI].values[ix[tsI]].id !== '10') continue;
    const slug = REG[od[rI].values[ix[rI]].id]; if (!slug) continue;
    const m = od[tI].values[ix[tI]].id.match(/^(\d{4})-S([12])$/); if (!m) continue;
    raw.push({ slug, year: +m[1], half: 'S' + m[2], value: v[0] });
  }
  // RULE: re-base the WHOLE series to whichever half the LATEST release is —
  // when the newest data is May (S1) every year uses its May value; when it's
  // November (S2) every year uses November. (AWE releases twice a year.)
  const keyOf = r => r.year * 10 + (r.half === 'S2' ? 2 : 1);
  const maxKey = raw.length ? Math.max(...raw.map(keyOf)) : 0;
  latestHalf = (maxKey % 10 === 2) ? 'S2' : 'S1';
  for (const r of raw) if (r.half === latestHalf) rows.push({ source: 'abs', region_slug: r.slug, metric: 'median_income', freq: 'A', period: `${r.year}-01-01`, value: r.value });
} catch (e) {
  console.error('\n✗ ABS fetch failed:', e.message);
  await recordStatus('error', `ABS fetch failed: ${e.message}`);
  process.exit(1);
}
const halfLabel = latestHalf === 'S2' ? 'Nov' : 'May';

const slugs = Object.values(REG);
const latest = rows.length ? Math.max(...rows.map(r => +r.period.slice(0, 4))) : 0;

// carry the latest year forward one year (AWE next-year release not out yet)
for (const slug of slugs) {
  const r = rows.find(x => x.region_slug === slug && +x.period.slice(0, 4) === latest);
  if (r) rows.push({ ...r, period: `${latest + 1}-01-01` });
}

// compare vs current DB (latest real year)
const { data: cur } = await sb.from('rdp_raw_series').select('region_slug,value').eq('source', 'abs').eq('metric', 'median_income').eq('period', `${latest}-01-01`).in('region_slug', slugs);
const curMap = Object.fromEntries((cur || []).map(r => [r.region_slug, +r.value]));
console.log(`ABS income (AWE) — ${rows.length} rows (${FROM}..${latest}, half=${latestHalf}/${halfLabel}, +${latest + 1} carry-forward) for ${slugs.length} regions\n`);
console.log(`Latest real year (${latest}) — fetched vs current DB:`);
console.log('region       fetched     DB          diff');
let exact = 0, compared = 0;
for (const slug of slugs) {
  const r = rows.find(x => x.region_slug === slug && +x.period.slice(0, 4) === latest); if (!r) continue;
  const db = curMap[slug]; const diff = db == null ? null : +(r.value - db).toFixed(2); if (diff != null) { compared++; if (Math.abs(diff) < 0.05) exact++; }
  console.log(slug.padEnd(11), String(r.value).padStart(9), String(db ?? '—').padStart(11), (diff == null ? '—' : String(diff)).padStart(8), Math.abs(diff || 0) < 0.05 ? '  EXACT' : '');
}
console.log(`\n${exact}/${compared} exact at ${latest}.`);

// completeness guard
const missing = slugs.filter(s => !rows.some(r => r.region_slug === s && +r.period.slice(0, 4) === latest));
if (missing.length) console.error(`\n✗ COMPLETENESS FAIL: ${missing.length}/${slugs.length} region(s) have no ${latest} value → ${missing.join(', ')}`);
else console.log(`✓ Completeness: all ${slugs.length} regions resolved a ${latest} value.`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(missing.length ? 1 : 0); }

let written = 0;
for (let k = 0; k < rows.length; k += 500) {
  const chunk = rows.slice(k, k + 500);
  const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' });
  if (error) { console.error('\n', error.message); process.exit(1); }
  written += chunk.length; process.stdout.write(`\r  upserted ${written}/${rows.length}`);
}
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS income ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: missing.length ? 'partial' : 'ok', notes: `ABS AWE (half=${latestHalf}/${halfLabel}): ${slugs.length} regions (national + 8 states), ${FROM}..${latest} (+${latest + 1} carry-forward)${missing.length ? `; MISSING ${latest}: ${missing.join(', ')}` : ''}` });
await recordStatus(missing.length ? 'error' : 'ok',
  missing.length ? `${missing.length} region(s) missing a ${latest} value: ${missing.join(', ')}` : `All ${slugs.length} regions current through ${latest} (${halfLabel} release).`,
  { row_count: written, region_count: slugs.length - missing.length, latest_year: latest });
console.log(`\n✓ Upserted ${written} ABS income rows into rdp_raw_series.${missing.length ? ' (with completeness warnings)' : ''}`);
process.exit(missing.length ? 1 : 0);
