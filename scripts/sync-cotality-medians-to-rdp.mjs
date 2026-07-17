// =============================================================================
// sync-cotality-medians-to-rdp.mjs — wire the monthly Cotality drop into the
// reports' annual series (the FULL drop, not just medians).
//
// The Online Reports chart their annual series from rdp_raw_series, which
// build-report-feed reshapes into the mart. Historically those values only
// moved when a new Data Dump was loaded — the monthly Cotality drop
// (forge_cotality) updated the CIV/yield card + monthly store but NOT the
// annual series, so a fresh drop never reached the reports. First shipped for
// mp_h/mp_u; extended 2026-07-10 when Sydney's vacancy rate showed 2.23% in
// Forge but 2.18% in the reports — the drop carries far more than medians:
//
//   from 'latest' cap.rows / lga.rows  [State, Name, Type, #sales 12m,
//                                       Median 3m, #listings 1m, DOM 12m]:
//     mp_h / mp_u        (source corelogic — median sales price)
//     sales_h / sales_u  (source corelogic — sales last 12 months)
//     adom_h / adom_u    (source corelogic — median days on market)
//     som_h / som_u      (source sqm       — listings last month; the report's
//                         stock-on-market series carries the legacy sqm tag)
//   from 'rentvacancy' capitals / regions  {name, vacHouse, rentHouse, rentUnit}:
//     vacancy_rate       (source tag 'sqm' = LEGACY sheet-header label ONLY —
//                         the data is Van's monthly COTALITY upload, not SQM;
//                         store holds PERCENT (2.23), rdp holds
//                         FRACTION (0.0223) → ÷100; house basis, per the
//                         2026-07-01 all-Cotality decision)
//     rent_h / rent_u    (source sqm — the calc PREFERS sqm over the duplicate
//                         corelogic rent rows, so sqm is the row that must move)
//
// Source tags MUST match the existing rows' tags (source is in the upsert key)
// or we'd fork a second lineage the calc may not read.
//
// UPSERT-ONLY on the current year (source,region_slug,metric,freq,period) — every
// prior year (from the Data Dump) is preserved untouched. Run this BEFORE
// build-report-feed in PUBLISH so the mart picks up the fresh values.
//
//   node scripts/sync-cotality-medians-to-rdp.mjs           # dry run + parity diff
//   node scripts/sync-cotality-medians-to-rdp.mjs --write   # upsert rdp_raw_series
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const YEAR = new Date().getUTCFullYear();
const PERIOD = `${YEAR}-01-01`;
// Cotality official name (slugified) → report region slug, where they differ.
const ALIAS = { 'greater-hobart': 'hobart', 'greater-bendigo': 'bendigo', 'greater-geelong': 'geelong', 'central-coast-nsw': 'central-coast', 'port-macquarie-hastings': 'port-macquarie', 'greater-sydney': 'sydney', 'greater-perth': 'perth', 'central-coast': 'central-coast', 'tamworth-regional': 'tamworth' };
const SKIP = new Set(['australia', 'dubbo']);   // national (no city median) / hidden region
const slug = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const num = s => { const n = Number(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };

// per-metric spec: value extractor + rdp source tag + sanity range (guards a
// wrong-column / wrong-scale slip before it reaches the reports)
const inRange = (v, lo, hi) => v != null && v >= lo && v <= hi;

// cap/lga rowsets → per-slug { H:{sales,median,listings,dom}, U:{...} }
function tradeMap(rows) {
  const m = {};
  for (const r of (rows || [])) {
    const key = ALIAS[slug(r[1])] || slug(r[1]);
    const ty = String(r[2] || '').toUpperCase()[0];
    if (ty !== 'H' && ty !== 'U') continue;
    if (!m[key]) m[key] = {};
    m[key][ty] = { sales: num(r[3]), median: num(r[4]), listings: num(r[5]), dom: num(r[6]) };
  }
  return m;
}
// rentvacancy capitals[] / regions[] → per-slug { vac, rentH, rentU }
function rentMap(list) {
  const m = {};
  for (const r of (list || [])) {
    const key = ALIAS[slug(r.name)] || slug(r.name);
    m[key] = { vac: r.vacHouse != null ? Number(r.vacHouse) : null, rentH: r.rentHouse != null ? Number(r.rentHouse) : null, rentU: r.rentUnit != null ? Number(r.rentUnit) : null };
  }
  return m;
}

async function main() {
  const [{ data: cot, error: ce }, { data: rv, error: re2 }] = await Promise.all([
    sb.from('forge_cotality').select('data,updated_at').eq('id', 'latest').maybeSingle(),
    sb.from('forge_cotality').select('data,updated_at').eq('id', 'rentvacancy').maybeSingle(),
  ]);
  if (ce) throw ce;
  if (re2) throw re2;
  if (!cot || !cot.data || !cot.data.cap) { console.error('forge_cotality empty — drop the CoreLogic Market Trends .xlsx in the Cotality view first.'); process.exit(1); }
  const capM = tradeMap(cot.data.cap.rows), lgaM = tradeMap(cot.data.lga && cot.data.lga.rows);
  const rvCap = rentMap(rv && rv.data && rv.data.capitals), rvReg = rentMap(rv && rv.data && rv.data.regions);
  if (!rv || !rv.data) console.log('⚠ rentvacancy row missing — vacancy/rents will not sync this run.');
  console.log(`Cotality snapshot ${String(cot.updated_at).slice(0, 10)} + rent/vacancy ${rv ? String(rv.updated_at).slice(0, 10) : '—'} → writing ${YEAR} annual rows.\n`);

  const { data: regions, error: re } = await sb.from('rdp_regions').select('slug,cluster').in('cluster', ['capital', 'qld', 'nsw', 'vicwatas']);
  if (re) throw re;

  // current stored values for THIS year, for the parity diff (all synced metrics)
  const METRICS = ['mp_h', 'mp_u', 'sales_h', 'sales_u', 'adom_h', 'adom_u', 'som_h', 'som_u', 'vacancy_rate', 'rent_h', 'rent_u'];
  const { data: curRows } = await sb.from('rdp_raw_series').select('region_slug,metric,source,value').eq('freq', 'A').eq('period', PERIOD).in('metric', METRICS);
  const cur = {}; for (const r of (curRows || [])) { (cur[r.region_slug] || (cur[r.region_slug] = {}))[r.metric + '|' + r.source] = +r.value; }

  const upserts = []; const skipped = []; const guards = [];
  const changes = [];   // { slug, metric, old, val }
  const push = (rgSlug, metric, source, val, lo, hi) => {
    if (val == null) return;
    if (!inRange(val, lo, hi)) { guards.push(`${rgSlug}.${metric}: ${val} outside sane range [${lo}, ${hi}] — skipped`); return; }
    const old = cur[rgSlug] && cur[rgSlug][metric + '|' + source];
    if (old == null || Math.abs(old - val) > 1e-12) changes.push({ slug: rgSlug, metric, old, val });
    upserts.push({ source, region_slug: rgSlug, metric, freq: 'A', period: PERIOD, value: val });
  };

  for (const rg of regions) {
    if (SKIP.has(rg.slug)) continue;
    const isCap = rg.cluster === 'capital';
    const t = (isCap ? capM : lgaM)[rg.slug];
    const rvR = (isCap ? rvCap : rvReg)[rg.slug];
    if (!t && !rvR) { skipped.push(rg.slug); continue; }
    if (t) {
      if (t.H) { push(rg.slug, 'mp_h', 'corelogic', t.H.median, 50000, 20000000); push(rg.slug, 'sales_h', 'corelogic', t.H.sales, 1, 500000); push(rg.slug, 'adom_h', 'corelogic', t.H.dom, 1, 365); push(rg.slug, 'som_h', 'sqm', t.H.listings, 1, 200000); }
      if (t.U) { push(rg.slug, 'mp_u', 'corelogic', t.U.median, 50000, 20000000); push(rg.slug, 'sales_u', 'corelogic', t.U.sales, 1, 500000); push(rg.slug, 'adom_u', 'corelogic', t.U.dom, 1, 365); push(rg.slug, 'som_u', 'sqm', t.U.listings, 1, 200000); }
    }
    if (rvR) {
      if (rvR.vac != null) push(rg.slug, 'vacancy_rate', 'sqm', inRange(rvR.vac, 0.05, 20) ? rvR.vac / 100 : rvR.vac, 0.0005, 0.2);   // store PERCENT → rdp FRACTION
      push(rg.slug, 'rent_h', 'sqm', rvR.rentH, 50, 5000);
      push(rg.slug, 'rent_u', 'sqm', rvR.rentU, 50, 5000);
    }
  }

  // report: changed values grouped by metric (unchanged rows are silent no-ops)
  const byMet = {};
  for (const c of changes) (byMet[c.metric] || (byMet[c.metric] = [])).push(c);
  for (const met of METRICS) {
    const list = byMet[met];
    if (!list || !list.length) { console.log(`  ${met.padEnd(13)} no changes`); continue; }
    const show = list.slice(0, 6).map(c => `${c.slug} ${c.old ?? '—'}→${c.val}`).join(', ');
    console.log(`  ${met.padEnd(13)} ${String(list.length).padStart(2)} changed: ${show}${list.length > 6 ? ', …' : ''}`);
  }
  if (skipped.length) console.log(`\nno Cotality data (left as-is): ${skipped.join(', ')}`);
  if (guards.length) { console.log('\n⚠ sanity-guard skips:'); for (const gm of guards) console.log('  ' + gm); }
  console.log(`\n${upserts.length} rows for ${YEAR} across ${new Set(upserts.map(u => u.region_slug)).size} regions (${changes.length} value changes).`);

  if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert rdp_raw_series.'); return; }
  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await sb.from('rdp_raw_series').upsert(upserts.slice(i, i + 500), { onConflict: 'source,region_slug,metric,freq,period' });
    if (error) { console.error(error.message); process.exit(1); }
  }
  try { await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `cotality sync ${YEAR}`, row_count: upserts.length, status: 'ok', notes: `synced ${YEAR} annual rows from the Cotality drop (${METRICS.join(', ')}); ${changes.length} changed` }); } catch {}
  console.log(`\n✓ Wrote ${upserts.length} ${YEAR} annual rows from the Cotality drop. Run the mart rebuild to push to the reports.`);
}
main().catch(e => { console.error(e); process.exit(1); });
