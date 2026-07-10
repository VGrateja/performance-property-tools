// =============================================================================
// refresh-snapshots-from-forge.mjs — repoint the presentation snapshot
// (report_data_cache) at Data Forge instead of the (now-retired) Apps Script
// feeds. Assembles each source with the SAME adapters the live reports use, so
// the presentation embed + any snapshot fallback show Forge-consistent data:
//   capital/qld/nsw/vicwatas → {_meta, regions:{slug: forgeRegionToFeed}}
//   national                 → {_meta, data:{…}}  (ForgeNationalAdapter)
//   commercial               → {_meta, tabs:{…}}  (ForgeCommercialAdapter)
//
// Intended to run in CI right after the mart rebuild. Dry-run by DEFAULT;
// --write upserts report_data_cache. ISOLATED to report_data_cache.
// =============================================================================
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import '../shared/forge-report-starts.js';
import '../shared/forge-report-adapter.js';
import '../shared/forge-national-adapter.js';
import '../shared/forge-commercial-adapter.js';
try { for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const sb = createClient(process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const now = new Date().toISOString();
const page = async (q) => { let out = [], from = 0; for (;;) { const { data } = await q(from); out.push(...(data || [])); if (!data || data.length < 1000) break; from += 1000; } return out; };
const G = globalThis;
const out = {};

// ── regional/capital clusters (from the mart) ──
const { data: marts } = await sb.from('rdp_report_feed').select('region_slug,cluster,payload');
for (const cl of ['capital', 'qld', 'nsw', 'vicwatas']) {
  const regions = {};
  for (const m of (marts || []).filter(x => x.cluster === cl)) regions[m.region_slug] = G.ForgeReportAdapter.forgeRegionToFeed(m.payload, m.region_slug);
  out[cl] = { _meta: { source: 'forge', generated: now }, regions };
}

// ── national ──
const [{ data: no }, rdpNat, st, { data: arr }, { data: pyr }, { data: rv }] = await Promise.all([
  sb.from('forge_national_only').select('data').eq('id', 'latest').maybeSingle(),
  page(f => sb.from('rdp_raw_series').select('metric,period,value,freq').eq('region_slug', 'australia').in('freq', ['A', 'M', 'Q']).order('metric').order('period').range(f, f + 999)),
  sb.from('rdp_raw_series').select('region_slug,metric,period,value').in('region_slug', ['st-nsw', 'st-vic', 'st-qld', 'st-sa', 'st-wa']).in('metric', ['nim', 'nom']).eq('freq', 'A'),
  sb.from('forge_arrears').select('data').eq('id', 'latest').maybeSingle(),
  sb.from('forge_population_pyramid').select('data').eq('id', 'latest').maybeSingle(),
  sb.from('forge_cotality').select('data').eq('id', 'rentvacancy').maybeSingle(),
]);
out.national = G.ForgeNationalAdapter.assemble(no && no.data, rdpNat, marts || [], (st.data) || [], (arr && arr.data) || {}, (pyr && pyr.data && pyr.data.regions) || {}, (rv && rv.data && rv.data.monthEnd) || null);

// ── commercial ──
const { data: com } = await sb.from('forge_commercial').select('data').eq('id', 'latest').maybeSingle();
out.commercial = Object.assign({ _meta: { source: 'forge', generated: now } }, G.ForgeCommercialAdapter.forgeCommercialToFeed(com.data));

// ── report + write ──
for (const src of Object.keys(out)) {
  const d = out[src];
  const n = d.regions ? Object.keys(d.regions).length + ' regions' : d.data ? Object.keys(d.data).length + ' fields' : d.tabs ? Object.keys(d.tabs).length + ' tabs' : '?';
  console.log('  ' + src.padEnd(11) + ' → ' + n);
}
if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert report_data_cache.'); process.exit(0); }
for (const src of Object.keys(out)) {
  const { error } = await sb.from('report_data_cache').upsert({ source: src, data: out[src], updated_at: now }, { onConflict: 'source' });
  if (error) { console.error('✗ ' + src + ':', error.message); process.exit(1); }
}
// lineage log — this was the one PUBLISH step writing no rdp_runs row
try { await sb.from('rdp_runs').insert({ dataset: 'snapshots', source_month: 'snapshots ' + now.slice(0, 7), row_count: Object.keys(out).length, status: 'ok', notes: 'report_data_cache repointed at Forge: ' + Object.keys(out).join(', ') }); } catch {}
console.log('\n✓ Repointed report_data_cache (' + Object.keys(out).length + ' sources) at Data Forge.');
process.exit(0);
