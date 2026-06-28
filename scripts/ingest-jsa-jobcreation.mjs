// =============================================================================
// ingest-jsa-jobcreation.mjs — Data Forge path: JOB CREATION INDEX (JSA IVI)
// + the national Internet Job Vacancies series.
//
// Source: Jobs & Skills Australia — Internet Vacancy Index (IVI). NOT the ABS,
// and there is NO clean API: data.gov.au only links to the old LMIP page. But
// the monthly .xlsx files have predictable URLs on jobsandskills.gov.au, so
// this AUTO-DISCOVERS the latest month's files off the IVI page and downloads
// them (same pattern as the Retail/MHSI ingest). ingest type = 'file'.
//
//   • Job Creation Index  → "Internet Vacancies, ANZSCO2 Occupations, IVI
//     Regions" .xlsx → sheet "Indexed" → Level-1 rows (ANZSCO_CODE 0 = all
//     occupations) = the index per IVI region. Each of the 8 capitals IS its
//     own IVI region; each of the 28 regional cities maps to a broader IVI
//     region (CITY_MAP below — taken verbatim from the user's Data Dump JCI
//     tab). Stored monthly per city slug. (Indexed = raw monthly index, NOT
//     seasonally adjusted; past months don't revise, so it matches exactly.)
//   • National Internet Job Vacancies → "…States and Territories" .xlsx →
//     AUSTRALIAN TOTAL, Seasonally Adjusted (count) + Seasonally Adjusted
//     Index. Stored monthly for region 'australia'.
//
// Metrics (freq='M'): job_creation_index (36 cities), internet_vacancies
// (national SA count), internet_vacancies_index (national SA index).
// ISOLATED: rdp_raw_series + rdp_runs + forge_data_status. Upsert-only.
// Dry-run by DEFAULT; --write upserts. Optional arg: an IVI-Regions .xlsx
// url/path to override auto-discovery (states file still auto-discovered).
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const OVERRIDE = process.argv.slice(2).find(a => !a.startsWith('--'));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120' };
const IVI_PAGE = 'https://www.jobsandskills.gov.au/data/internet-vacancy-index';

// slug -> exact IVI-region name in the "Indexed"/"region" column (Data Dump JCI tab)
const CITY_MAP = {
  sydney: 'Sydney', melbourne: 'Melbourne', brisbane: 'Brisbane', perth: 'Perth', adelaide: 'Adelaide',
  canberra: 'Canberra & ACT', hobart: 'Hobart & Southeast Tasmania', darwin: 'Darwin',
  mackay: 'Central Queensland', bundaberg: 'Central Queensland', ipswich: 'Toowoomba and South West QLD',
  rockhampton: 'Central Queensland', gladstone: 'Central Queensland', cairns: 'Far North Queensland',
  townsville: 'Far North Queensland', 'sunshine-coast': 'Sunshine Coast', toowoomba: 'Toowoomba and South West QLD',
  'gold-coast': 'Gold Coast', albury: 'Riverina & Murray', 'central-coast': 'Gosford & Central Coast',
  'coffs-harbour': 'NSW North Coast', orange: 'Blue Mountains, Bathurst & Central West NSW',
  'port-macquarie': 'NSW North Coast', newcastle: 'Newcastle & Hunter', tamworth: 'Gosford & Central Coast',
  'wagga-wagga': 'Riverina & Murray', wollongong: 'Illawarra & South Coast', ballarat: 'Ballarat & Central Highlands',
  bendigo: 'Bendigo & High Country', geelong: 'Geelong & Surf Coast', wodonga: 'Riverina & Murray',
  mildura: 'Riverina & Murray', mandurah: 'South West WA', rockingham: 'South West WA', bunbury: 'South West WA',
  launceston: 'Launceston and Northeast Tasmania',
};

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const FSOURCE = 'Jobs & Skills Australia — Internet Vacancy Index';
async function recordStatus(key, label, status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: key, label, source: FSOURCE, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated? ' + error.message + ')');
}
const period = d => (d instanceof Date ? d.toISOString().slice(0, 7) : String(d).slice(0, 7)) + '-01';

// ── locate + download the two IVI .xlsx files ──
let iviBuf, stBuf, iviSrc, stSrc;
try {
  let iviUrl = (OVERRIDE && /ivi_regions/i.test(OVERRIDE)) ? OVERRIDE : null, stUrl = null;
  if (!iviUrl || !stUrl) {
    const html = await (await fetch(IVI_PAGE, { headers: UA })).text();
    const find = re => { const m = html.match(re); return m ? (m[1].startsWith('http') ? m[1] : 'https://www.jobsandskills.gov.au' + m[1]) : null; };
    iviUrl = iviUrl || find(/(\/[^"']*internet_vacancies_anzsco2_occupations_ivi_regions[^"']*\.xlsx)/i);
    stUrl = find(/(\/[^"']*internet_vacancies_anzsco2_occupations_states_and_territories[^"']*\.xlsx)/i);
  }
  if (!iviUrl) throw new Error('could not find the IVI Regions .xlsx link on the JSA page');
  if (!stUrl) throw new Error('could not find the States & Territories .xlsx link on the JSA page');
  iviSrc = iviUrl; stSrc = stUrl;
  if (OVERRIDE && existsSync(OVERRIDE) && /ivi_regions/i.test(OVERRIDE)) iviBuf = readFileSync(OVERRIDE);
  else iviBuf = Buffer.from(await (await fetch(iviUrl, { headers: UA })).arrayBuffer());
  stBuf = Buffer.from(await (await fetch(stUrl, { headers: UA })).arrayBuffer());
} catch (e) { console.error('\n✗ download failed:', e.message); await recordStatus('job_creation_index', 'Job Creation Index', 'error', `download failed: ${e.message}`); process.exit(1); }
console.log('IVI Regions:', iviSrc.split('/').pop());
console.log('States/Terr:', stSrc.split('/').pop());

// ── 1) Job Creation Index — Indexed sheet, Level-1 region totals ──
const rows = [];
let latestM = '';
try {
  const g = XLSX.utils.sheet_to_json(XLSX.read(iviBuf, { type: 'buffer', cellDates: true }).Sheets['Indexed'], { header: 1, raw: true, defval: '' });
  const hdr = g[0]; const dateCols = []; for (let c = 5; c < hdr.length; c++) if (hdr[c] instanceof Date) dateCols.push([c, period(hdr[c])]);
  latestM = dateCols[dateCols.length - 1][1];
  const regionSeries = {};   // region name -> { period -> index }
  for (let r = 1; r < g.length; r++) { if (g[r][0] !== 1) continue; const name = String(g[r][2]).trim(); const s = regionSeries[name] ||= {}; for (const [c, p] of dateCols) { const v = g[r][c]; if (typeof v === 'number') s[p] = v; } }
  for (const [slug, region] of Object.entries(CITY_MAP)) {
    const s = regionSeries[region];
    if (!s) { console.error(`  ✗ IVI region not found for ${slug}: "${region}"`); continue; }
    for (const [p, v] of Object.entries(s)) rows.push({ source: 'jsa', region_slug: slug, metric: 'job_creation_index', freq: 'M', period: p, value: v });
  }
} catch (e) { console.error('\n✗ IVI Regions parse failed:', e.message); await recordStatus('job_creation_index', 'Job Creation Index', 'error', `parse failed: ${e.message}`); process.exit(1); }

// ── 2) National Internet Job Vacancies — Seasonally Adjusted count + index ──
const natRows = [];
try {
  const wb = XLSX.read(stBuf, { type: 'buffer', cellDates: true });
  const pull = (sheet, metric) => {
    const g = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: '' });
    const hdr = g[0]; const dateCols = []; for (let c = 4; c < hdr.length; c++) if (hdr[c] instanceof Date) dateCols.push([c, period(hdr[c])]);
    for (let r = 1; r < g.length; r++) { if (String(g[r][3]).trim() === 'AUST' && (g[r][1] === 0 || g[r][1] === '0')) { for (const [c, p] of dateCols) { const v = g[r][c]; if (typeof v === 'number') natRows.push({ source: 'jsa', region_slug: 'australia', metric, freq: 'M', period: p, value: metric === 'internet_vacancies' ? Math.round(v) : v }); } return true; } }
    return false;
  };
  const okCount = pull('Seasonally Adjusted', 'internet_vacancies');
  const okIndex = pull('Seasonally Adjusted Index', 'internet_vacancies_index');
  if (!okCount || !okIndex) throw new Error('AUSTRALIAN TOTAL row not found in states file');
} catch (e) { console.error('\n✗ States parse failed:', e.message); await recordStatus('internet_vacancies', 'Internet Job Vacancies (National)', 'error', `parse failed: ${e.message}`); }

// ── report + completeness ──
const slugs = Object.keys(CITY_MAP);
const missing = slugs.filter(s => !rows.some(r => r.region_slug === s && r.period === latestM));
console.log(`\nJob Creation Index — ${rows.length} monthly rows, ${slugs.length} cities (latest ${latestM}):`);
for (const slug of slugs) { const r = rows.find(x => x.region_slug === slug && x.period === latestM); console.log('  ' + slug.padEnd(15), CITY_MAP[slug].slice(0, 30).padEnd(32), r ? r.value : '—'); }
const natLatest = {};
for (const r of natRows) if (!natLatest[r.metric] || r.period > natLatest[r.metric].period) natLatest[r.metric] = r;
console.log('\nNational (latest): SA count =', natLatest.internet_vacancies && natLatest.internet_vacancies.value, '| SA index =', natLatest.internet_vacancies_index && natLatest.internet_vacancies_index.value, '@', (natLatest.internet_vacancies || {}).period);
if (missing.length) console.error(`\n✗ COMPLETENESS FAIL: missing ${latestM} for ${missing.join(', ')}`);
else console.log(`\n✓ all ${slugs.length} cities have ${latestM}.`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(missing.length ? 1 : 0); }

const all = rows.concat(natRows);
let written = 0;
for (let k = 0; k < all.length; k += 500) { const chunk = all.slice(k, k + 500); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\n', error.message); process.exit(1); } written += chunk.length; }
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `JSA jobcreation ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: missing.length ? 'partial' : 'ok', notes: `JSA IVI: job_creation_index (${slugs.length} cities) + national internet vacancies (SA count + index), through ${latestM}${missing.length ? '; MISSING: ' + missing.join(', ') : ''}` });
await recordStatus('job_creation_index', 'Job Creation Index', missing.length ? 'error' : 'ok', missing.length ? `Missing ${latestM} for ${missing.join(', ')}` : `Current through ${latestM} (JSA IVI, ${slugs.length} cities).`, { row_count: rows.length, region_count: slugs.length, latest_year: +latestM.slice(0, 4) });
await recordStatus('national_vacancies', 'National Job Vacancies', 'ok', `Internet vacancies current through ${latestM} (JSA, seasonally adjusted).`, { latest_year: +latestM.slice(0, 4) });
console.log(`\n✓ Upserted ${written} rows (job_creation_index + national internet vacancies).`);
process.exit(missing.length ? 1 : 0);
