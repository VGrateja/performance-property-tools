// =============================================================================
// ingest-sqm-rents.mjs — SQM Research weekly rents (house & unit) → Forge.
//
// Port of the user's Apps Script (fetchSQMRentsData). SQM Research is fetchable
// server-side (HTTP 200, full HTML table — unlike REA which is Kasada-blocked),
// so this runs as a normal Forge ingest. For each region it reads the SQM
// "weekly-rents" page, pulls the "All Houses" / "All Units" current rent + the
// 3-year p.a. growth %, and derives the rent 3 years ago:
//     rent_3yr_ago = current / (1 + pa/100)^3
// which is exactly what the Demand Score model's 36-month rental growth needs
// (growth = (current - rent_3yr_ago) / rent_3yr_ago).
//
// Writes the rent fields into forge_demand_inputs (the "Demand Score Dashboard
// Data" card's store), MERGING with the manual listings so both live per region:
//   regions[slug] += { rent_h, rent_u, rent_h_3yr, rent_u_3yr,
//                      rent_h_pa, rent_u_pa, rent_week_ending, rent_fetched_at }
//
// Dry-run by DEFAULT; --write upserts + logs rdp_runs.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { SQM_REGIONS, SQM_UA, sqmUrl } from './sqm-regions.mjs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL_SB = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL_SB, KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');
const UA = SQM_UA;

// slug → SQM weekly-rents URL (shared region map; National kept as 'australia').
const REGIONS = SQM_REGIONS.map(r => [r.slug, sqmUrl('weekly-rents', r.qs)]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }, redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// Port of parseRegionData: find the Houses/Units table, read "All Houses" /
// "All Units" rows → current rent (col) + 3-year p.a. growth % (col).
function parseRegionData(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const table of tables) {
    if (!table.includes('Houses') && !table.includes('Units')) continue;
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const d = {};
    for (const row of rows) {
      const cells = []; let m; const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      while ((m = re.exec(row)) !== null) {
        cells.push(m[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
      }
      if (!cells.length) continue;
      let label = '', rent = NaN, pa = NaN;
      if (cells.length >= 10) { label = cells[1].trim(); rent = parseFloat(cells[2].replace(/,/g, '')); pa = parseFloat(cells[7].replace(/,/g, '')); }
      else if (cells.length >= 9) { label = cells[0].trim(); rent = parseFloat(cells[1].replace(/,/g, '')); pa = parseFloat(cells[6].replace(/,/g, '')); }
      if (label === 'All Houses') { d.houseRent = rent; d.house3YrPa = pa; }
      else if (label === 'All Units') { d.unitRent = rent; d.unit3YrPa = pa; }
    }
    if (d.houseRent && d.unitRent && !isNaN(d.house3YrPa) && !isNaN(d.unit3YrPa)) return d;
  }
  return null;
}

function getWeekEnding(html) {
  for (const p of [/week ending[\s\S]{0,60}?(\d{1,2}\s+\w+\s+\d{4})/i, /week ending[\s\S]{0,60}?(\d{1,2}\/\d{1,2}\/\d{4})/i, /(\d{1,2}\s+\w+\s+\d{4})/i]) {
    const m = html.match(p); if (m) return m[1].trim();
  }
  return null;
}
const round2 = n => Math.round(n * 100) / 100;

const results = {}; let weekEnding = null, ok = 0; const failed = [];
for (let i = 0; i < REGIONS.length; i++) {
  const [slug, url] = REGIONS[i];
  try {
    const html = await fetchHtml(url);
    if (weekEnding == null) weekEnding = getWeekEnding(html);
    const d = parseRegionData(html);
    if (!d) { console.log(`  ${slug}: no data parsed`); failed.push(slug); continue; }
    const h3 = d.houseRent / Math.pow(1 + d.house3YrPa / 100, 3);
    const u3 = d.unitRent / Math.pow(1 + d.unit3YrPa / 100, 3);
    results[slug] = {
      rent_h: round2(d.houseRent), rent_u: round2(d.unitRent),
      rent_h_3yr: round2(h3), rent_u_3yr: round2(u3),
      rent_h_pa: d.house3YrPa, rent_u_pa: d.unit3YrPa,
    };
    ok++;
    console.log(`  ${slug}: H $${d.houseRent} U $${d.unitRent} (3yr-ago H $${round2(h3)} U $${round2(u3)})`);
  } catch (e) {
    console.log(`  ${slug}: ERROR ${e.message}`); failed.push(slug);
  }
  await sleep(500);
}
console.log(`\nParsed ${ok}/${REGIONS.length} regions (${failed.length} failed). Week ending: ${weekEnding || 'unknown'}`);

// forge_data_status under 'demand_inputs' so a broken SQM run flags the Demand
// Score Dashboard Data card red in the Data Forge UI (not just the Actions log).
async function recordStatus(status, message) {
  try { const now = new Date().toISOString();
    const row = { data_key: 'demand_inputs', label: 'Demand Score Dashboard Data', source: 'SQM rents + vacancy (auto) / REA listings (manual)', status, message, last_run_at: now, updated_at: now };
    if (status === 'ok') row.last_ok_at = now;
    await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  } catch {}
}

if (!WRITE) { console.log('\nDry run — re-run with --write to merge into forge_demand_inputs.'); process.exit(0); }
if (!ok) { console.error('Nothing parsed — refusing to write.'); await recordStatus('error', 'SQM rents: nothing parsed'); process.exit(1); }

// Merge into the existing forge_demand_inputs row (preserve manual listings).
const { data: existing } = await sb.from('forge_demand_inputs').select('data').eq('id', 'latest').maybeSingle();
const store = (existing && existing.data) || { regions: {} };
if (!store.regions) store.regions = {};
const nowIso = new Date().toISOString();
for (const [slug, r] of Object.entries(results)) {
  const rec = store.regions[slug] || (store.regions[slug] = {});
  Object.assign(rec, r, { rent_week_ending: weekEnding || null, rent_fetched_at: nowIso });
}
store.rent_week_ending = weekEnding || null;
const { error } = await sb.from('forge_demand_inputs').upsert({ id: 'latest', data: store, updated_at: nowIso, uploaded_at: nowIso, uploaded_by: 'ingest-sqm-rents' }, { onConflict: 'id' });
if (error) { console.error('Upsert failed:', error.message); await recordStatus('error', 'SQM rents upsert failed: ' + error.message); process.exit(1); }
try { await sb.from('rdp_runs').insert({ dataset: 'sqm_rents', source_month: weekEnding || nowIso.slice(0, 7), row_count: ok, status: 'ok', notes: `${ok} regions; SQM weekly rents (house & unit) + 3yr-ago derived` }); } catch {}
await recordStatus(failed.length > 5 ? 'error' : 'ok', `SQM rents: ${ok}/${REGIONS.length} regions (week ending ${weekEnding || 'unknown'})${failed.length ? ', failed: ' + failed.join(', ') : ''}`);
console.log(`\n✓ Merged SQM rents for ${ok} regions into forge_demand_inputs (week ending ${weekEnding || 'unknown'}).`);
