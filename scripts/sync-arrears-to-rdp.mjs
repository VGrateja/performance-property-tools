// =============================================================================
// sync-arrears-to-rdp.mjs — wire the manual S&P SPIN arrears drop into the
// arrears series the regional/capital reports read.
//
// Two arrears lineages existed: the Data Forge upload lands in forge_arrears
// (PERCENT values, slugs st-nsw…st-tas + australia), but enrich-marts builds the
// reports' extras.arrears* from rdp_raw_series metric 'arrears' (FRACTION values,
// capital slugs sydney…hobart + australia; sole writer was the local-only
// ingest-deferred.mjs / Data Dump). The National report reads forge_arrears
// directly — so a fresh SPIN drop updated National but NOT the 35 regional/
// capital reports. Same gap class as the (fixed) Cotality median gap.
//
// This closes it: forge_arrears → rdp_raw_series, mapping each state series to
// its capital slug (the Data Dump labelled these by capital; enrich-marts keys
// arrears by capital slug and maps regionals to their state capital) and
// converting percent → fraction (÷100, matching the existing rows' scale).
//
// UPSERT-ONLY on (source,region_slug,metric,freq,period) — source stays 'apra'
// (the existing rows' key) so this UPDATES the same lineage rather than forking
// a second one. Never deletes. Run in PUBLISH right after sync-cotality, before
// enrich-marts.
//
//   node scripts/sync-arrears-to-rdp.mjs           # dry run + parity diff
//   node scripts/sync-arrears-to-rdp.mjs --write   # upsert rdp_raw_series
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

// forge_arrears region slug → rdp_raw_series region slug (state series are
// keyed by their capital in rdp — the lineage enrich-marts consumes).
const SLUG = { australia: 'australia', 'st-nsw': 'sydney', 'st-vic': 'melbourne', 'st-qld': 'brisbane', 'st-wa': 'perth', 'st-sa': 'adelaide', 'st-nt': 'darwin', 'st-act': 'canberra', 'st-tas': 'hobart' };
const SOURCE = 'apra';   // existing rows' upsert key — keep, or we'd fork a second lineage

async function main() {
  const { data: row, error } = await sb.from('forge_arrears').select('data,updated_at').eq('id', 'latest').maybeSingle();
  if (error) throw error;
  if (!row || !row.data || !Array.isArray(row.data.months) || !row.data.regions) {
    console.error('forge_arrears empty — upload the S&P SPIN sheet in Data Forge first.'); process.exit(1);
  }
  const { months, regions } = row.data;
  console.log(`forge_arrears updated ${String(row.updated_at).slice(0, 10)} — ${months.length} months (${months[0]} → ${months[months.length - 1]}), ${Object.keys(regions).length} regions.\n`);

  // ── scale guards ──
  // Store holds PERCENT (e.g. 0.76 = 0.76%). Guard both failure modes:
  //   already-fractions (double division) → all values suspiciously ≤ 0.2
  //   corrupt/percent-of-percent          → values > 20
  const allVals = Object.values(regions).flatMap(r => (r.values || []).filter(v => v != null && !isNaN(v)));
  if (!allVals.length) { console.error('forge_arrears has no numeric values — aborting.'); process.exit(1); }
  const maxV = Math.max(...allVals);
  if (maxV <= 0.2) { console.error(`✗ Scale guard: max store value ${maxV} ≤ 0.2 — store looks like FRACTIONS, not percent. Refusing to divide by 100 again.`); process.exit(1); }
  if (maxV > 20) { console.error(`✗ Scale guard: max store value ${maxV} > 20% — implausible arrears rate; store looks corrupt. Aborting.`); process.exit(1); }

  // current rdp values for the parity diff
  const rdp = {};   // slug -> Map(period -> value)
  for (let from = 0; ; from += 1000) {
    const { data, error: e } = await sb.from('rdp_raw_series').select('region_slug,period,value')
      .eq('metric', 'arrears').eq('freq', 'M').order('region_slug').order('period').range(from, from + 999);
    if (e) throw e;
    for (const r of (data || [])) (rdp[r.region_slug] || (rdp[r.region_slug] = new Map())).set(String(r.period).slice(0, 7), +r.value);
    if (!data || data.length < 1000) break;
  }

  const upserts = []; const skipped = [];
  let overlap = 0, maxDiff = 0, added = 0;
  for (const [storeSlug, reg] of Object.entries(regions)) {
    const slug = SLUG[storeSlug];
    if (!slug) { skipped.push(storeSlug); continue; }
    const vals = reg.values || [];
    let n = 0, latest = null;
    for (let i = 0; i < months.length; i++) {
      const v = vals[i];
      if (v == null || isNaN(v)) continue;
      const frac = v / 100;
      const period = months[i] + '-01';
      upserts.push({ source: SOURCE, region_slug: slug, metric: 'arrears', freq: 'M', period, value: frac });
      n++; latest = { m: months[i], frac };
      const cur = rdp[slug] && rdp[slug].get(months[i]);
      if (cur != null) { overlap++; maxDiff = Math.max(maxDiff, Math.abs(cur - frac)); } else added++;
    }
    console.log(`  ${storeSlug.padEnd(8)} → ${slug.padEnd(10)} ${String(n).padStart(4)} months, latest ${latest ? latest.m + ' = ' + (latest.frac * 100).toFixed(2) + '%' : '—'}`);
  }
  if (skipped.length) console.log(`\nunmapped store regions (skipped): ${skipped.join(', ')}`);
  console.log(`\n${upserts.length} rows · overlap ${overlap} (max |diff| ${maxDiff.toExponential(2)}) · new months ${added}`);
  if (maxDiff > 0.005) console.log(`⚠ overlap diverges >0.5pp from the existing rdp series — expected only if S&P revised history.`);

  if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert rdp_raw_series.'); return; }
  for (let i = 0; i < upserts.length; i += 500) {
    const { error: werr } = await sb.from('rdp_raw_series').upsert(upserts.slice(i, i + 500), { onConflict: 'source,region_slug,metric,freq,period' });
    if (werr) { console.error(werr.message); process.exit(1); }
  }
  try { await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: 'arrears sync ' + new Date().toISOString().slice(0, 7), row_count: upserts.length, status: 'ok', notes: `forge_arrears → rdp_raw_series arrears (÷100, ${Object.keys(SLUG).length} slugs); overlap ${overlap}, new ${added}` }); } catch {}
  console.log(`\n✓ Synced ${upserts.length} arrears rows from forge_arrears into rdp_raw_series.`);
}
main().catch(e => { console.error(e); process.exit(1); });
