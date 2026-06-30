// =============================================================================
// build-report-feed.mjs  —  L2 mart builder for rdp_report_feed.
//
// Reads the canonical raw series from rdp_raw_series, runs ReportFeedCalc for
// every city region, and upserts a per-region jsonb payload (the report-ready
// yearly rows) into rdp_report_feed. Verified to reproduce the cluster sheets
// (see verify-report-feed.mjs: 527/528 vs Adelaide, the 1 diff a stale cell).
//
// National ('australia') report_feed is a separate aggregation step (median
// across regions) — deferred. Monthly columns are deferred with their raw.
//
// Dry-run by DEFAULT; --write upserts + logs rdp_runs. Needs migration 050 + .env.
//   node scripts/build-report-feed.mjs            # dry run
//   node scripts/build-report-feed.mjs --write     # upsert
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import './../shared/report-feed-calc.js';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');

// region dimension (cities only — exclude states + national)
const { data: regions, error: rerr } = await sb.from('rdp_regions').select('slug,state,cluster').in('cluster', ['capital', 'qld', 'nsw', 'vicwatas']);
if (rerr) { console.error(rerr.message); process.exit(1); }
const cities = regions.filter(r => r.slug !== 'australia');

// all annual raw (ordered for stable pagination)
let rows = [], from = 0;
for (;;) {
  const { data, error } = await sb.from('rdp_raw_series').select('region_slug,metric,source,period,value').eq('freq', 'A').order('region_slug').order('metric').order('period').range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  rows.push(...data.map(r => ({ ...r, value: Number(r.value) }))); if (data.length < 1000) break; from += 1000;
}
console.log('loaded', rows.length, 'raw rows;', cities.length, 'city regions');

const years = []; for (let y = 1975; y <= 2026; y++) years.push(y);
// Capital-City-Comparison benchmark: capitals compare to Sydney; regional cities
// compare to THEIR OWN state capital (Mackay→Brisbane, Ballarat→Melbourne), like
// the report does — not Sydney.
const STATECAP = { nsw: 'sydney', vic: 'melbourne', qld: 'brisbane', wa: 'perth', sa: 'adelaide', nt: 'darwin', act: 'canberra', tas: 'hobart' };
const payloads = [];
for (const c of cities) {
  const state = c.state ? 'st-' + c.state.toLowerCase() : null;
  // capCityComparison benchmark = the region's PEER capital: Sydney→Melbourne
  // (it can't compare to itself), every other capital→Sydney, regionals→state capital.
  const benchmark = (c.slug === 'sydney') ? 'melbourne'
    : (c.cluster === 'capital') ? 'sydney'
    : (STATECAP[(c.state || '').toLowerCase()] || 'sydney');
  const feed = globalThis.ReportFeedCalc.computeReportFeed({ region: c.slug, state, benchmark, rows, years });
  const nonEmpty = feed.filter(r => Object.keys(r).some(k => k !== 'year' && r[k] != null));   // trim only fully-empty leading years (keep national-only early years, e.g. inflation 1975)
  payloads.push({ region_slug: c.slug, cluster: c.cluster, rows: nonEmpty });
}

// dry-run summary
const sample = payloads.find(p => p.region_slug === 'adelaide');
const sRow = sample && sample.rows.find(r => r.year === 2025);
console.log('\nper-region rows:', payloads.map(p => p.region_slug + ':' + p.rows.length).slice(0, 8).join(', '), '…');
if (sRow) console.log('adelaide 2025 sample: mp_h=' + sRow.mp_h + ' p2i_house=' + (sRow.p2i_house || 0).toFixed(2) + ' yield_house=' + (sRow.yield_house || 0).toFixed(4) + ' pi_house=' + Math.round(sRow.pi_house));
console.log('TOTAL regions:', payloads.length);

if (!WRITE) { console.log('\nDry run complete. Re-run with --write to upsert into rdp_report_feed.'); process.exit(0); }

const stamp = new Date().toISOString();
let n = 0;
for (const p of payloads) {
  const { error } = await sb.from('rdp_report_feed').upsert({ region_slug: p.region_slug, cluster: p.cluster, payload: { years: p.rows }, source_month: 'Data Dump 2026-06', computed_at: stamp }, { onConflict: 'region_slug' });
  if (error) { console.error('upsert', p.region_slug, error.message); process.exit(1); }
  n++; process.stdout.write(`\r  upserted ${n}/${payloads.length}`);
}
console.log('');
await sb.from('rdp_runs').insert({ dataset: 'report_feed', source_month: 'Data Dump 2026-06', row_count: n, status: 'ok', notes: `${n} city regions; ReportFeedCalc` });
console.log(`✓ Built rdp_report_feed for ${n} regions.`);
