/* ===========================================================================
 * ingest-abs-building-price-index.mjs — Building Price Index (house
 * construction INPUT prices) into rdp_raw_series.
 *
 * SOURCES — two, because one of them cannot be automated:
 *   • ABS PPI, dataflow `PPI`, index group T18 "House Construction Inputs",
 *     series "All groups ; <city>". This is exactly the published Table 18
 *     ("Input to the House construction industry, six state capital cities"),
 *     columns C-H, and it is available over the SDMX API — quarterly, back to
 *     1980-Q1, currently through 2026-Q2. Six state capitals + the weighted
 *     average of the 6.
 *   • CANBERRA and DARWIN are NOT in that ABS series (it is six STATE capitals
 *     only). They come from Rawlinsons, which is a paid publication with no
 *     API, so they are loaded from the exported CSV and are STATIC until
 *     someone refreshes that export. Source tag `rawlinsons` keeps them
 *     distinguishable from the automated rows.
 *
 * PERIOD CONVENTION: the annual figure is the average of the four quarters of
 * the FINANCIAL year ending 30 June (Sep, Dec, Mar, Jun) — the convention the
 * existing sheet used ("Period/Year (JUNE 30)", "Average per year"). Verified:
 * FY2012 computes to exactly 100.00, i.e. the ABS 2011-12 = 100 base, which
 * confirms it. Stored at `<FY end year>-01-01` to match how every other
 * annual Forge series is keyed.
 *
 * ⚠ The ABS series does NOT reconcile with the old Looker CSV: Sydney FY1983
 * is 33.33 on ABS vs 27.28 in the CSV, and the ratio drifts (0.80 → 1.01 →
 * 0.98), so it is not a rebase — the CSV appears to splice older vintages.
 * This script loads the OFFICIAL ABS series. Anything still reading the CSV
 * numbers will differ.
 *
 * Usage: node scripts/ingest-abs-building-price-index.mjs [--write]
 * =========================================================================== */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const API = 'https://data.api.abs.gov.au/rest';
const METRIC = 'building_price_index';

/* ABS PPI index codes — "All groups ; <city>" under T18 House Construction Inputs */
const ABS_CITIES = {
  '8102560': 'sydney',
  '8102576': 'melbourne',
  '8102591': 'brisbane',
  '8104018': 'adelaide',
  '8104034': 'perth',
  '8104049': 'hobart',
  '8102825': 'australia',   // weighted average of the 6 capitals
};

const CSV_PATH = 'C:/Users/vandolf_performancep/Downloads/Commercial Report Data for Looker - Building Price Indices Data.csv';
/* Rawlinsons columns in that export. The index was formatted as currency on
   the way out of Looker, so the value is the index x 10000 — verified against
   the published table (1983 Canberra 30.85, Darwin 30.61; 2024 157.67 /
   129.44). Hobart's column in the same CSV is a genuine dollar figure and is
   deliberately NOT used — Hobart is a state capital and comes from ABS. */
const CSV_COLS = { 6: 'canberra', 7: 'darwin' };
const CSV_SCALE = 1 / 10000;

const getJson = async (u) => {
  const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } });
  const t = await r.text();
  if (!r.ok) throw new Error(`ABS ${r.status}: ${t.slice(0, 160)}`);
  return JSON.parse(t);
};

/* ── ABS: quarterly index per city ─────────────────────────────────────── */
const quarters = {};   // slug -> { '1980-Q1': v, … }
for (const [code, slug] of Object.entries(ABS_CITIES)) {
  const j = await getJson(`${API}/data/ABS,PPI/1.${code}..Q?startPeriod=1980-Q1&dimensionAtObservation=AllDimensions`);
  const dims = j.data.structures[0].dimensions.observation;
  const ti = dims.findIndex(d => d.id === 'TIME_PERIOD');
  const tv = dims[ti].values;
  const q = {};
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) q[tv[+k.split(':')[ti]].id] = v[0];
  quarters[slug] = q;
  const ks = Object.keys(q).sort();
  console.log(`ABS ${slug.padEnd(10)} ${ks.length} quarters · ${ks[0]} → ${ks.at(-1)} · latest ${q[ks.at(-1)]}`);
}

/* FY ending 30 June Y = (Y-1)Q3, (Y-1)Q4, YQ1, YQ2 */
const fyAvg = (q, Y) => {
  const p = [`${Y - 1}-Q3`, `${Y - 1}-Q4`, `${Y}-Q1`, `${Y}-Q2`].map(k => q[k]);
  if (p.some(v => v == null)) return null;
  return Math.round((p.reduce((a, b) => a + b, 0) / 4) * 100) / 100;
};

const rows = [];
for (const [slug, q] of Object.entries(quarters)) {
  /* quarterly, keyed at the quarter's START month (the convention elsewhere) */
  for (const [p, v] of Object.entries(q)) {
    const [y, qq] = p.split('-Q');
    rows.push({ source: 'abs', region_slug: slug, metric: METRIC, freq: 'Q',
      period: `${y}-${String((+qq - 1) * 3 + 1).padStart(2, '0')}-01`, value: v });
  }
  const years = [...new Set(Object.keys(q).map(k => +k.slice(0, 4)))].sort();
  for (const Y of years) {
    const v = fyAvg(q, Y);
    if (v != null) rows.push({ source: 'abs', region_slug: slug, metric: METRIC, freq: 'A', period: `${Y}-01-01`, value: v });
  }
}

/* ── Rawlinsons: Canberra + Darwin, annual only ────────────────────────── */
let csvCount = 0;
if (existsSync(CSV_PATH)) {
  const parse = (l) => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  const num = (s) => { const n = +String(s || '').replace(/[$,\s]/g, ''); return Number.isFinite(n) && n !== 0 ? n : null; };
  for (const ln of readFileSync(CSV_PATH, 'utf8').split(/\r?\n/).slice(1)) {
    const f = parse(ln); const Y = +f[1];
    if (!Y || Y < 1900) continue;
    for (const [i, slug] of Object.entries(CSV_COLS)) {
      const raw = num(f[+i]); if (raw == null) continue;
      rows.push({ source: 'rawlinsons', region_slug: slug, metric: METRIC, freq: 'A',
        period: `${Y}-01-01`, value: Math.round(raw * CSV_SCALE * 100) / 100 });
      csvCount++;
    }
  }
  console.log(`Rawlinsons  ${csvCount} annual rows (canberra + darwin) from the CSV export`);
} else {
  console.warn(`⚠ Rawlinsons CSV not found at ${CSV_PATH} — Canberra/Darwin skipped`);
}

/* ── sanity ─────────────────────────────────────────────────────────────── */
const annual = rows.filter(r => r.freq === 'A');
console.log(`\ntotal rows ${rows.length} (quarterly ${rows.length - annual.length} · annual ${annual.length})`);
const fy2012 = annual.find(r => r.region_slug === 'sydney' && r.period === '2012-01-01');
console.log(`base check — Sydney FY2012 = ${fy2012 && fy2012.value} (ABS base 2011-12 = 100)`);
for (const s of ['sydney', 'canberra', 'darwin']) {
  const a = annual.filter(r => r.region_slug === s).sort((x, y) => x.period.localeCompare(y.period));
  if (a.length) console.log(`  ${s.padEnd(10)} ${a.length} yrs · ${a[0].period.slice(0, 4)}=${a[0].value} → ${a.at(-1).period.slice(0, 4)}=${a.at(-1).value}`);
}

if (!WRITE) { console.log('\nDry run — re-run with --write to upsert.'); process.exit(0); }

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let written = 0;
for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500);
  const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' });
  if (error) { console.error('✗ ' + error.message); process.exit(1); }
  written += chunk.length;
}
const now = new Date().toISOString();
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `Building price index ${now.slice(0, 7)}`,
  row_count: written, status: 'ok', notes: 'ABS PPI T18 house construction inputs (6 capitals + weighted avg, quarterly + FY-to-June annual) · Canberra/Darwin from the Rawlinsons CSV export' });
await sb.from('forge_data_status').upsert({
  data_key: 'building_price_index', label: 'Building Price Index',
  source: 'ABS PPI Table 18 (house construction inputs) · Rawlinsons for Canberra & Darwin',
  status: 'ok',
  message: `ABS via API back to 1980 (6 capitals + weighted average); Canberra/Darwin static from the Rawlinsons export`,
  row_count: written, region_count: 9, latest_year: +(annual.at(-1) || {}).period?.slice(0, 4) || null,
  last_run_at: now, last_ok_at: now, updated_at: now,
}, { onConflict: 'data_key' });
console.log(`\n✓ wrote ${written} rows.`);
