// =============================================================================
// ingest-abs-population-hist.mjs — Data Forge path: HISTORICAL CAPITAL-CITY
// POPULATION on GCCSA ("Greater") boundaries, 1980 -> latest ERP year.
//
// Requested 2026-07-16: a long-run capitals series for history work.
//   1980-2000  ABS "Historical Population, 2021" release, Population
//              distribution download (HPDC3.xlsx), Table 1 "Population,
//              capital city and rest of state". Capital cities are GCCSA
//              boundaries from 1971 onwards (table footnote a), annual,
//              30 June. Static file (2021-Census vintage, released 16/7/2024).
//   2001+      ABS Data API dataflow ABS_ANNUAL_ERP_ASGS2021, GCCSA codes
//              1GSYD..8ACTE — the SAME data as the Regional Population
//              release's "Population estimates by SA2 and above" download,
//              served programmatically (and revised/extended each release).
//
// Both legs are GCCSA, so the series is continuous — no boundary seam.
//
// NOTE this is DELIBERATELY a separate metric from the live 'population'
// point, which the monthly ingest-abs-population.mjs writes SUA-based (Sydney
// SUA is ~9% smaller than Greater Sydney). CONSUMED since 2026-07-30: every
// PUBLISH runs sync-gccsa-to-population-capitals.mjs, which copies this series
// over the 8 capitals' `population` for the years both carry. So this ingest
// MUST keep pace with the SUA one — a year present in `population` but missing
// here would leave that capital on SUA for that year (a ~9% step down).
// In the monthly GATHER loop (forge-ingests.yml) since 2026-09-14; before that
// it was run once by hand (2026-07-18) and the pipeline board flagged it stale.
//
// ISOLATED: writes ONLY rdp_raw_series (source='abs', metric='population_gccsa',
// freq='A', period 'YYYY-01-01', 8 capital slugs) + logs rdp_runs + records
// health in forge_data_status (data_key='population_gccsa').
//
// LEG 1 IS READ BACK FROM THE DATABASE once seeded: the HPDC3 file is a static
// 2021-Census vintage that never changes, and ABS website downloads (unlike
// the ABS Data API) may be blocked from CI the way the JSA site is. If the
// 1980-2000 rows are complete in rdp_raw_series they are used as-is; otherwise
// (first seed, or --from earlier than what is stored) the file is downloaded.
//
// COMPLETENESS GUARD: every capital must resolve every year 1980..latest
// (the two legs must also butt join exactly — no gap, no overlap conflict).
//
// Dry-run by DEFAULT (prints the series + the 2000->2001 leg seam). Pass
// --write to upsert.
//   --file=path   use a local HPDC3.xlsx instead of the DB copy / download
//   --from=YYYY   history start (default 1980)
//
// Usage:
//   node scripts/ingest-abs-population-hist.mjs            # dry run
//   node scripts/ingest-abs-population-hist.mjs --write    # upsert
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const FROM = +((process.argv.find(a => a.startsWith('--from=')) || '--from=1980').split('=')[1]) || 1980;
const FILE = (process.argv.find(a => a.startsWith('--file=')) || '').split('=')[1] || '';

const HPDC3_URL = 'https://www.abs.gov.au/statistics/people/population/historical-population/2021/HPDC3.xlsx';
const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`ABS ${r.status}: ${t.slice(0, 80)}`); } };

// GCCSA code -> capital slug (matches the live population point's slugs)
const GCCSA = {
  '1GSYD': 'sydney', '2GMEL': 'melbourne', '3GBRI': 'brisbane', '4GADE': 'adelaide',
  '5GPER': 'perth', '6GHOB': 'hobart', '7GDAR': 'darwin', '8ACTE': 'canberra',
};
// HPDC3 Table 1 "Geography" label -> slug (footnote markers stripped before match;
// Canberra's GCCSA is the ACT, which Table 1 carries under the ACT rows)
const T1_NAME = {
  sydney: 'Sydney', melbourne: 'Melbourne', brisbane: 'Brisbane', adelaide: 'Adelaide',
  perth: 'Perth', hobart: 'Hobart', darwin: 'Darwin', canberra: 'Canberra',
};
const SLUGS = Object.values(GCCSA);

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const FK = 'population_gccsa', FLABEL = 'Population — Capitals (GCCSA, 1980+)',
  FSOURCE = 'ABS Historical Population HPDC3 (1980-2000) + ABS Data API ASGS2021 GCCSA (2001+)';
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;                                  // dry-run is read-only
  const now = new Date().toISOString();
  const row = { data_key: FK, label: FLABEL, source: FSOURCE, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated: ' + error.message + ')');
}

const rows = [];
let leg1From = 'HPDC3 download';
try {

// ── LEG 1: HPDC3 Table 1, 1980-2000 (GCCSA from 1971; static 2021-vintage file) ──
// Database first: the file never changes, so once the FROM..2000 rows are stored
// they are the file. Only a --file, an incomplete store, or an earlier --from
// goes back to the spreadsheet.
let leg1Done = false;
if (!FILE) {
  const { data: stored, error } = await sb.from('rdp_raw_series').select('region_slug,period,value')
    .eq('source', 'abs').eq('metric', 'population_gccsa').eq('freq', 'A')
    .in('region_slug', SLUGS).gte('period', `${FROM}-01-01`).lt('period', '2001-01-01');
  if (error) throw new Error('rdp_raw_series read failed: ' + error.message);
  const want = SLUGS.length * (2000 - FROM + 1);
  const seen = new Set((stored || []).map(r => r.region_slug + '|' + r.period.slice(0, 4)));
  if (seen.size === want && (stored || []).every(r => Number.isFinite(+r.value) && +r.value > 0)) {
    for (const r of stored) rows.push({ source: 'abs', region_slug: r.region_slug, metric: 'population_gccsa', freq: 'A', period: r.period.slice(0, 10), value: +r.value });
    leg1From = 'rdp_raw_series (stored HPDC3 rows)';
    leg1Done = true;
    console.log(`Leg 1 (${FROM}-2000): ${stored.length} rows read back from rdp_raw_series — HPDC3 not downloaded.`);
  } else {
    console.log(`Leg 1 (${FROM}-2000): store has ${seen.size}/${want} city-years — fetching HPDC3.`);
  }
}
if (!leg1Done) {
  let buf;
  if (FILE) { buf = readFileSync(FILE); leg1From = 'HPDC3 local file'; }
  else {
    const cache = join(tmpdir(), 'HPDC3.xlsx');
    if (existsSync(cache)) buf = readFileSync(cache);
    else {
      const r = await fetch(HPDC3_URL);
      if (!r.ok) throw new Error(`HPDC3 download failed: HTTP ${r.status} (pass --file=path to use a local copy)`);
      buf = Buffer.from(await r.arrayBuffer());
      try { writeFileSync(cache, buf); } catch {}
    }
  }
  const wb = XLSX.read(buf, { type: 'buffer' });
  const t1 = XLSX.utils.sheet_to_json(wb.Sheets['Table 1'], { header: 1, raw: false });
  const hdr = t1.find(r => r && r.includes('1980'));           // the year header row
  if (!hdr) throw new Error('HPDC3 Table 1: year header row not found');
  const clean = s => String(s || '').replace(/\([a-z]\)/gi, '').trim();   // strip footnote markers like (d)
  for (const [slug, name] of Object.entries(T1_NAME)) {
    const row = t1.find(r => r && clean(r[1]) === name);
    if (!row) throw new Error(`HPDC3 Table 1: no row for ${name}`);
    for (let c = 2; c < hdr.length; c++) {
      const yr = +hdr[c];
      if (!yr || yr < FROM || yr > 2000) continue;             // API owns 2001+
      const v = +String(row[c] ?? '').replace(/,/g, '');
      if (!Number.isFinite(v) || v <= 0) throw new Error(`HPDC3: bad value for ${name} ${yr}`);
      rows.push({ source: 'abs', region_slug: slug, metric: 'population_gccsa', freq: 'A', period: `${yr}-01-01`, value: v });
    }
  }
}

// ── LEG 2: ABS Data API, GCCSA annual ERP 2001 -> latest ──
{
  const j = await getJson(`${API}/data/ABS_ANNUAL_ERP_ASGS2021/....A?startPeriod=2001&format=jsondata&dimensionAtObservation=AllDimensions`);
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const aI = od.findIndex(d => d.id === 'ASGS_2021'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    const slug = GCCSA[od[aI].values[ix[aI]].id]; if (!slug) continue;   // only the 8 GCCSAs
    const yr = +od[tI].values[ix[tI]].id; if (!yr || yr < 2001) continue;
    rows.push({ source: 'abs', region_slug: slug, metric: 'population_gccsa', freq: 'A', period: `${yr}-01-01`, value: v[0] });
  }
}

} catch (e) {
  console.error('\n✗ fetch/parse failed:', e.message);
  await recordStatus('error', `fetch/parse failed: ${e.message}`);
  process.exit(1);
}

// ── report + guards ──
const latest = Math.max(...rows.map(r => +r.period.slice(0, 4)));
const byCity = slug => rows.filter(r => r.region_slug === slug).sort((a, b) => a.period.localeCompare(b.period));
console.log(`GCCSA capitals population — ${rows.length} rows, ${FROM}..${latest}\n`);
console.log('city        first     ' + FROM + '        2000 (hist)   2001 (API)   seam%      ' + latest);
for (const slug of SLUGS) {
  const s = byCity(slug);
  const at = y => s.find(r => r.period.startsWith(y + '-'))?.value;
  const seam = at(2000) && at(2001) ? ((at(2001) - at(2000)) / at(2000) * 100).toFixed(2) + '%' : '—';
  console.log(slug.padEnd(11), String(s[0]?.period.slice(0, 4)).padStart(5), String(at(FROM) ?? '—').padStart(9), String(at(2000) ?? '—').padStart(13), String(at(2001) ?? '—').padStart(12), String(seam).padStart(8), String(at(latest) ?? '—').padStart(10));
}

// completeness: every capital, every year FROM..latest, exactly once
const problems = [];
for (const slug of SLUGS) {
  const s = byCity(slug);
  for (let y = FROM; y <= latest; y++) {
    const n = s.filter(r => r.period.startsWith(y + '-')).length;
    if (n !== 1) problems.push(`${slug}:${y}${n ? ' x' + n : ' missing'}`);
  }
}
if (problems.length) console.error(`\n✗ COMPLETENESS FAIL (${problems.length}): ${problems.slice(0, 12).join(', ')}${problems.length > 12 ? ' …' : ''}`);
else console.log(`\n✓ Completeness: all ${SLUGS.length} capitals, every year ${FROM}..${latest}, exactly once.`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series (metric population_gccsa).'); process.exit(problems.length ? 1 : 0); }
if (problems.length) { await recordStatus('error', `completeness fail: ${problems.length} city-year(s), e.g. ${problems[0]}`); process.exit(1); }

let written = 0;
for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500);
  const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' });
  if (error) { console.error('\n', error.message); await recordStatus('error', error.message); process.exit(1); }
  written += chunk.length; process.stdout.write(`\r  upserted ${written}/${rows.length}`);
}
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS GCCSA hist ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: 'ok', notes: `population_gccsa: HPDC3 Table 1 (${FROM}-2000, via ${leg1From}) + ABS API GCCSA (2001-${latest}), 8 capitals` });
await recordStatus('ok', `All 8 capitals continuous ${FROM}..${latest} (GCCSA).`, { row_count: written, region_count: SLUGS.length, latest_year: latest });
console.log(`\n✓ Upserted ${written} rows (metric population_gccsa).`);
