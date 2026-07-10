// =============================================================================
// sync-cotality-medians-to-rdp.mjs — wire the monthly Cotality drop into the
// report's annual median-price series.
//
// The Online Reports chart median house/unit price from rdp_raw_series
// (metric mp_h / mp_u, freq 'A', source 'corelogic'), which build-report-feed
// reshapes into the mart. Historically those annual values only moved when a new
// Data Dump was loaded (ingest-data-dump.mjs) — the monthly Cotality drop
// (forge_cotality) updated the CIV/yield card + vacancy + monthly store, but NOT
// the annual median series the reports chart. So a fresh Cotality drop never
// reached the reports.
//
// This closes that gap: it reads the current Cotality snapshot (forge_cotality
// 'latest' — the CoreLogic "Median sales price last 3 months") and writes each
// region's latest house/unit median into the CURRENT calendar year's annual row.
//   • capitals (cluster 'capital')  ← cap.rows
//   • regionals (qld/nsw/vicwatas)  ← lga.rows
// Cotality uses a few longer official names; ALIAS maps them to report slugs.
//
// UPSERT-ONLY on the current year (source,region_slug,metric,freq,period) — every
// prior year (from the Data Dump) is preserved untouched. Run this BEFORE
// build-report-feed in PUBLISH so the mart picks up the fresh medians.
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
const SOURCE = 'corelogic';
// Cotality official name (slugified) → report region slug, where they differ.
const ALIAS = { 'greater-hobart': 'hobart', 'greater-bendigo': 'bendigo', 'greater-geelong': 'geelong', 'central-coast-nsw': 'central-coast', 'port-macquarie-hastings': 'port-macquarie' };
const SKIP = new Set(['australia', 'dubbo']);   // national (no city median) / hidden region
const slug = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const num = s => { const n = Number(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };

// name → {H,U} median from a Cotality rowset ([State, Name, Type, #sales, MedianPrice, …])
function priceMap(rows) {
  const m = {};
  for (const r of (rows || [])) {
    const key = ALIAS[slug(r[1])] || slug(r[1]);
    const ty = String(r[2] || '').toUpperCase()[0];
    if (!m[key]) m[key] = {};
    if (ty === 'H') m[key].H = num(r[4]);
    else if (ty === 'U') m[key].U = num(r[4]);
  }
  return m;
}

async function main() {
  const { data: cot, error: ce } = await sb.from('forge_cotality').select('data,updated_at').eq('id', 'latest').maybeSingle();
  if (ce) throw ce;
  if (!cot || !cot.data || !cot.data.cap) { console.error('forge_cotality empty — drop the CoreLogic Market Trends .xlsx in the Cotality view first.'); process.exit(1); }
  const capM = priceMap(cot.data.cap.rows), lgaM = priceMap(cot.data.lga && cot.data.lga.rows);
  console.log(`Cotality snapshot updated ${String(cot.data && cot.updated_at).slice(0, 10)} → writing ${YEAR} annual medians (source '${SOURCE}').\n`);

  const { data: regions, error: re } = await sb.from('rdp_regions').select('slug,cluster').in('cluster', ['capital', 'qld', 'nsw', 'vicwatas']);
  if (re) throw re;

  // current stored value for THIS year, for the parity diff
  const { data: curRows } = await sb.from('rdp_raw_series').select('region_slug,metric,value').eq('source', SOURCE).eq('freq', 'A').eq('period', PERIOD).in('metric', ['mp_h', 'mp_u']);
  const cur = {}; for (const r of (curRows || [])) { (cur[r.region_slug] || (cur[r.region_slug] = {}))[r.metric] = +r.value; }

  const upserts = []; const skipped = [];
  for (const rg of regions) {
    if (SKIP.has(rg.slug)) continue;
    const M = rg.cluster === 'capital' ? capM : lgaM;
    const c = M[rg.slug];
    if (!c || (c.H == null && c.U == null)) { skipped.push(rg.slug); continue; }
    for (const [metric, val] of [['mp_h', c.H], ['mp_u', c.U]]) {
      if (val == null) continue;
      const old = cur[rg.slug] && cur[rg.slug][metric];
      const pct = (old && old !== 0) ? ((val - old) / old * 100) : null;
      console.log(`  ${rg.slug.padEnd(16)} ${metric}  ${String(old ?? '—').padStart(9)} → ${String(val).padStart(9)}` + (pct != null ? `  (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : '  (new)') + (pct != null && Math.abs(pct) > 25 ? '  ⚠ large jump' : ''));
      upserts.push({ source: SOURCE, region_slug: rg.slug, metric, freq: 'A', period: PERIOD, value: val });
    }
  }
  if (skipped.length) console.log(`\nno Cotality row (left as-is): ${skipped.join(', ')}`);
  console.log(`\n${upserts.length} rows for ${YEAR} across ${new Set(upserts.map(u => u.region_slug)).size} regions.`);

  if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert rdp_raw_series.'); return; }
  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await sb.from('rdp_raw_series').upsert(upserts.slice(i, i + 500), { onConflict: 'source,region_slug,metric,freq,period' });
    if (error) { console.error(error.message); process.exit(1); }
  }
  try { await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `cotality medians ${YEAR}`, row_count: upserts.length, status: 'ok', notes: `synced ${YEAR} mp_h/mp_u from forge_cotality into rdp_raw_series` }); } catch {}
  console.log(`\n✓ Wrote ${upserts.length} ${YEAR} median rows from the Cotality drop. Run build-report-feed (PUBLISH) to push to the reports.`);
}
main().catch(e => { console.error(e); process.exit(1); });
