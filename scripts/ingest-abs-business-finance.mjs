// =============================================================================
// ingest-abs-business-finance.mjs — Data Forge path: BUSINESS FINANCE, quarterly.
//
// ABS Lending Indicators (5601.0) — new loan commitments to SMALL businesses,
// fixed term loans, split by the two purposes the B/S data guide names:
//     Construction          (LOAN_PURPOSE DV5185)  → metric bus_fin_construction
//     Purchase of property  (LOAN_PURPOSE DV5186)  → metric bus_fin_property
//
// Verified against the guide's two Victoria series IDs:
//   A130267721W  Fixed term loans; Small businesses; Construction; Victoria
//   A130267737R  Fixed term loans; Small businesses; Purchase of property; Victoria
// The guide only named VIC — "other states also available, please import to hub
// as well" — so this pulls national + all 8 states in one call per purpose.
//
// ABS Data API (dataflow LEND_BUSINESS), dimension order:
//   MEASURE.DATA_ITEM.LOAN_TYPE.LOAN_PURPOSE.LENDER_TYPE.BUSINESS_SIZE.TSEST.REGION.FREQ
//   FIN_VAL.NEWCOMMITS.DV8270.<purpose>.TOT.DV8605.10.<region>.Q
//   = value ($m) · new loan commitments · fixed term loans · all lenders ·
//     small businesses · Original · quarterly. History starts 2019-Q3.
//
// MEDIUM businesses (BUSINESS_SIZE DV8604) are equally available on the same
// key — the guide cites ABS Table 32 for them — but the two series it actually
// names are both SMALL, so only small is ingested. Flip SIZE below to add them.
//
// Stored freq='Q' at the quarter-START month (2026-Q1 → 2026-01-01), which is
// the existing convention for quarterly series here (cf. mineral_exploration).
// ISOLATED: rdp_raw_series (source='abs') + forge_data_status. Upsert-only.
// Dry-run by DEFAULT; --write upserts.
//   node scripts/ingest-abs-business-finance.mjs [--write]
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`ABS ${r.status}: ${t.slice(0, 120)}`); } };

const REG = { AUS: 'australia', '1': 'st-nsw', '2': 'st-vic', '3': 'st-qld', '4': 'st-sa', '5': 'st-wa', '6': 'st-tas', '7': 'st-nt', '8': 'st-act' };
const SIZE = 'DV8605';                                    // small businesses
const PURPOSES = [
  { code: 'DV5185', metric: 'bus_fin_construction', label: 'Construction' },
  { code: 'DV5186', metric: 'bus_fin_property', label: 'Purchase of property' },
];
// 2026-Q1 → 2026-01-01 (quarter START month, the convention here)
const qToPeriod = q => { const [y, n] = q.split('-Q'); return `${y}-${String((+n - 1) * 3 + 1).padStart(2, '0')}-01`; };

const out = [];
const seen = {};
for (const p of PURPOSES) {
  const key = `FIN_VAL.NEWCOMMITS.DV8270.${p.code}.TOT.${SIZE}.10.AUS+1+2+3+4+5+6+7+8.Q`;
  const j = await getJson(`${API}/data/ABS,LEND_BUSINESS/${key}?dimensionAtObservation=AllDimensions`);
  const dims = j.data.structures[0].dimensions.observation;
  const rI = dims.findIndex(d => d.id === 'REGION'), tI = dims.findIndex(d => d.id === 'TIME_PERIOD');
  const obs = j.data.dataSets[0].observations || {};
  let n = 0;
  for (const [k, v] of Object.entries(obs)) {
    const ix = k.split(':').map(Number);
    const slug = REG[dims[rI].values[ix[rI]].id];
    const val = Number(v[0]);
    if (!slug || !isFinite(val)) continue;
    out.push({ source: 'abs', region_slug: slug, metric: p.metric, freq: 'Q', period: qToPeriod(dims[tI].values[ix[tI]].id), value: Math.round(val * 100) / 100 });
    n++;
  }
  seen[p.metric] = n;
}

/* ── report ───────────────────────────────────────────────────────────── */
const periods = [...new Set(out.map(o => o.period))].sort();
console.log('ABS Lending Indicators — Business Finance (small businesses, fixed term loans, new commitments, $m)');
console.log('Quarters : ' + periods.length + '  ' + periods[0] + ' → ' + periods[periods.length - 1]);
console.log('Regions  : ' + new Set(out.map(o => o.region_slug)).size + '   Rows: ' + out.length);
PURPOSES.forEach(p => console.log('  ' + p.metric.padEnd(22) + String(seen[p.metric]).padStart(4) + '  (' + p.label + ')'));
const last = periods[periods.length - 1];
console.log('\nLatest quarter (' + last + '):');
['australia', 'st-nsw', 'st-vic', 'st-qld', 'st-wa'].forEach(s => {
  const g = m => { const r = out.find(o => o.region_slug === s && o.metric === m && o.period === last); return r ? '$' + r.value.toLocaleString() + 'm' : '—'; };
  console.log('  ' + s.padEnd(12) + 'construction ' + g('bus_fin_construction').padEnd(12) + 'property ' + g('bus_fin_property'));
});

if (!WRITE) { console.log('\nDry run — nothing written. Re-run with --write to upsert.'); process.exit(0); }

/* ── write ────────────────────────────────────────────────────────────── */
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

for (let i = 0; i < out.length; i += 500) {
  const { error } = await sb.from('rdp_raw_series').upsert(out.slice(i, i + 500), { onConflict: 'source,region_slug,metric,freq,period' });
  if (error) { console.error('Upsert failed at row ' + i + ': ' + error.message); process.exit(1); }
}
const now = new Date().toISOString();
const { error: sErr } = await sb.from('forge_data_status').upsert({
  data_key: 'business_finance', label: 'Business Finance',
  source: 'ABS Lending Indicators (5601.0) — LEND_BUSINESS, new loan commitments, small businesses',
  status: 'ok', message: out.length + ' rows · ' + periods[0].slice(0, 7) + '–' + last.slice(0, 7),
  last_run_at: now, last_ok_at: now, updated_at: now,
}, { onConflict: 'data_key' });
if (sErr) console.warn('  (forge_data_status not updated? ' + sErr.message + ')');
console.log('\n✓ Upserted ' + out.length + ' business-finance rows.');
