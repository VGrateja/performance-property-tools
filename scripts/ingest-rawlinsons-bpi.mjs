// =============================================================================
// ingest-rawlinsons-bpi.mjs — Data Forge path: BUILDING PRICE INDEX, the
// Rawlinsons half. Rawlinsons publish a FREE quarterly "Market Insight" PDF on
// rawlhouse.com.au (Jan / Apr / Jul / Oct); from the April 2026 edition its
// annexure carries "RAWLINSONS BUILDING PRICE INDEX" — quarterly index levels
// for all eight capitals (Adelaide, Brisbane, Canberra, Darwin, Hobart,
// Melbourne, Perth, Sydney), actuals plus "(F)" forecasts for the quarters
// ahead. That is the same index the Canberra/Darwin handbook export in Forge
// came from (Canberra Jun-2025 164.02 v the handbook's 2025 figure 164.97), so
// the two territories the ABS PPI (state capitals only) leaves out can now
// extend themselves. Found 2026-09-12.
//
// Writes → rdp_raw_series, source `rawlinsons`, metric `building_price_index`:
//   freq Q — every ACTUAL quarter for the eight capitals (forecast rows skipped);
//            period = quarter START, matching the ABS rows (June quarter = YYYY-04-01)
//   freq A — Canberra + Darwin only, calendar-year MEAN of the four actual quarters
//            (the Commercial tab's convention); years with fewer than 4 actuals are
//            left to the builder, which averages what exists.
// Newer editions revise the previous quarter, so editions are applied oldest →
// newest and the upsert lets the newest win. Older "Quarterly Update" editions
// (to Oct-2025) have no index table and are skipped with a note.
// Status → forge_data_status 'rawlinsons_bpi' (shown on the Building Price
// Index card's Rawlinsons panels; the card's own freshness stays with the ABS run).
//
// Dry-run by DEFAULT; --write upserts.
//   node scripts/ingest-rawlinsons-bpi.mjs                 # newest edition, print
//   node scripts/ingest-rawlinsons-bpi.mjs --write         # newest edition, upsert
//   node scripts/ingest-rawlinsons-bpi.mjs --all --write   # every edition that carries the table
//   node scripts/ingest-rawlinsons-bpi.mjs <pdf-file|url> --edition=2026-07 [--write]
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');   // index.js runs a fixture self-test under ESM → ENOENT

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const ALL = process.argv.includes('--all');
const EDITION = (process.argv.find(a => a.startsWith('--edition=')) || '').split('=')[1] || null;
const OVERRIDE = process.argv.slice(2).find(a => !a.startsWith('--'));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', Accept: 'text/html,application/pdf,*/*' };
const INSIGHTS = 'https://www.rawlhouse.com.au/insights';
const FIRST_TABLE_EDITION = '2026-04';   // the index table first appears in the April 2026 Market Insight

const SOURCE = 'rawlinsons', METRIC = 'building_price_index';
const CITY = { ADELAIDE: 'adelaide', BRISBANE: 'brisbane', CANBERRA: 'canberra', DARWIN: 'darwin', HOBART: 'hobart', MELBOURNE: 'melbourne', PERTH: 'perth', SYDNEY: 'sydney' };
const ANNUAL_FOR = ['canberra', 'darwin'];   // the two the ABS series lacks
const QSTART = { March: '01', June: '04', September: '07', December: '10' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const norm = s => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// ── Supabase only needed for --write ──
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
let sb = null;
if (WRITE) {
  if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env (needed only for --write)'); process.exit(1); }
  sb = createClient(URL, KEY, { auth: { persistSession: false } });
}
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: 'rawlinsons_bpi', label: 'Building Price Index — Rawlinsons (quarterly)', source: 'Rawlinsons Market Insight (free quarterly PDF, rawlhouse.com.au) — "Rawlinsons Building Price Index", eight capitals', status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated? ' + error.message + ')');
}
const fail = async (msg) => { console.error('\n✗ ' + msg); await recordStatus('error', msg); process.exit(1); };

// "Market Insight - July 2026 - Compressed.pdf" | "QU- Apr 25 - Public.pdf" | "July 2025 Market Insight.pdf" → "2026-07" | "2025-04" | "2025-07"
function editionOf(filename) {
  const s = decodeURIComponent(filename).replace(/[_\-]+/g, ' ');
  const m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(20\d{2}|\d{2})\b/i);
  if (!m) return null;
  const y = m[2].length === 2 ? 2000 + +m[2] : +m[2];
  return `${y}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}`;
}

// ── the table → [{ year, quarter, values:{slug:value}, forecast }] ──
function parseTable(text, edition) {
  const lines = text.replace(/ /g, ' ').split(/\n/).map(l => l.trim()).filter(Boolean);
  const k = lines.findIndex(l => /^RAWLINSONS BUILDING PRICE INDEX$/i.test(l));
  if (k < 0) return null;
  // The Oct-2026 PDF runs the city names together ("ADELAIDEBRISBANE…"), so split on the names, not on spaces.
  const flat = norm(lines[k + 1]).toUpperCase().replace(/\s+/g, '');
  const header = flat.match(new RegExp(Object.keys(CITY).join('|'), 'g')) || [];
  const slugs = header.map(h => CITY[h]);
  if (slugs.length !== 8 || header.join('') !== flat || new Set(slugs).size !== 8) throw new Error('unexpected city header: ' + lines[k + 1]);
  if (/^(March|June|September|December)$/i.test(lines[k + 2])) return parseColumns(text, slugs, edition);
  const rows = [];
  let year = null, pendingQ = null;
  const takeValues = (str, quarter) => {
    const toks = [...norm(str).matchAll(/(\d{2,3}\.\d{1,2})(\s*\(F\))?/g)];
    if (toks.length !== 8) return false;
    const forecast = toks.some(t => t[2]);
    const values = {}; toks.forEach((t, i) => { values[slugs[i]] = +t[1]; });
    rows.push({ year, quarter, values, forecast });
    return true;
  };
  for (let i = k + 2; i < lines.length; i++) {
    const l = norm(lines[i]);
    if (/^F\s*=\s*Forecast/i.test(l) || /CONSUMER PRICE INDEX/i.test(l)) break;
    const ym = l.match(/^(20\d{2})$/); if (ym) { year = +ym[1]; pendingQ = null; continue; }
    const mm = l.match(/^(March|June|September|December)\b\s*(.*)$/i);
    if (mm) {
      const q = mm[1][0].toUpperCase() + mm[1].slice(1).toLowerCase();
      if (!year) throw new Error('quarter row before any year row: ' + l);
      if (mm[2] && takeValues(mm[2], q)) { pendingQ = null; continue; }
      pendingQ = q; continue;
    }
    if (pendingQ && takeValues(l, pendingQ)) { pendingQ = null; continue; }
    if (rows.length) break;   // past the table
  }
  return rows;
}

// The Oct-2026 layout: the PDF text runs the table city by city with no year labels. After the header come the quarter
// names, one blank-separated group per year; then, per city, one block per year (the latest year's block stops at the
// quarters it holds); then the latest year's remaining quarters, city by city ("161.46", "163.77 (F)", …).
// The years are not in the text: the last quarter is the edition's own quarter (the Oct edition forecasts December),
// and the last group is the edition's year. Anything that does not fit that shape throws.
function parseColumns(text, slugs, edition) {
  const ls = text.split(/\n/).map(norm);
  let i = ls.findIndex(l => /^RAWLINSONS BUILDING PRICE INDEX$/i.test(l)) + 2;
  const qGroups = [], nGroups = [];
  let g = null;
  for (; i < ls.length; i++) {
    if (!ls[i]) { g = null; continue; }
    const m = ls[i].match(/^(March|June|September|December)$/i);
    if (!m) break;
    if (!g) qGroups.push(g = []);
    g.push(m[1][0].toUpperCase() + m[1].slice(1).toLowerCase());
  }
  g = null;
  for (; i < ls.length; i++) {
    if (/^F\s*=\s*Forecast/i.test(ls[i])) break;
    if (!ls[i]) { g = null; continue; }
    const m = ls[i].match(/^(\d{2,3}\.\d{1,2})(\s*\(F\))?$/);
    if (!m) break;
    if (!g) nGroups.push(g = []);
    g.push({ v: +m[1], f: !!m[2] });
  }
  const Y = qGroups.length;
  if (Y < 1 || nGroups.length < Y) throw new Error('column layout: no quarter or value groups');
  const held = nGroups.slice(0, Y).map(x => x.length);   // what the first city's block holds per year
  if (held.slice(0, -1).some((n, y) => n !== qGroups[y].length)) throw new Error('column layout: an earlier year is incomplete');
  const perCity = held.reduce((a, b) => a + b, 0), rest = qGroups[Y - 1].length - held[Y - 1];
  const vals = nGroups.flat();
  if (vals.length !== 8 * (perCity + rest)) throw new Error(`column layout: ${vals.length} values, expected ${8 * (perCity + rest)}`);

  const lastQ = qGroups[Y - 1][qGroups[Y - 1].length - 1];
  const edQ = ['March', 'June', 'September', 'December'][Math.floor((+edition.slice(5, 7) - 1) / 3)];
  if (lastQ !== edQ) throw new Error(`column layout: the table ends at ${lastQ}, the ${edition} edition's quarter is ${edQ} — cannot place the years`);
  const year0 = +edition.slice(0, 4) - (Y - 1);

  const quarters = qGroups.flatMap((qs, y) => qs.map(q => ({ year: year0 + y, quarter: q })));
  const rows = quarters.map(q => ({ ...q, values: {}, forecast: false }));
  slugs.forEach((slug, c) => {
    const mine = [...vals.slice(c * perCity, (c + 1) * perCity), ...vals.slice(8 * perCity + c * rest, 8 * perCity + (c + 1) * rest)];
    mine.forEach((t, j) => { rows[j].values[slug] = t.v; if (t.f) rows[j].forecast = true; });
  });
  return rows;
}

// ── 1. which editions ──
const jobs = [];   // [{ edition:'YYYY-MM', url }]
try {
  if (OVERRIDE) {
    if (!EDITION) throw new Error('an override PDF needs --edition=YYYY-MM');
    jobs.push({ edition: EDITION, url: OVERRIDE });
  } else {
    const r = await fetch(INSIGHTS, { headers: UA });
    if (!r.ok) throw new Error(`insights page HTTP ${r.status}`);
    const html = await r.text();
    const seen = new Map();
    for (const m of html.matchAll(/href="(https:\/\/cdn\.prod\.website-files\.com\/[^"]+\.pdf)"/gi)) {
      const url = m[1], name = url.split('/').pop();
      if (/fuel/i.test(decodeURIComponent(name))) continue;
      const ed = editionOf(name); if (!ed) continue;
      if (!seen.has(ed)) seen.set(ed, url);
    }
    const eds = [...seen.keys()].sort();
    console.log(`rawlhouse.com.au/insights: ${eds.length} editions found (${eds[0]} → ${eds[eds.length - 1]}); table expected from ${FIRST_TABLE_EDITION}`);
    if (!eds.length) throw new Error('no Market Insight PDFs found on the insights page');
    const usable = eds.filter(e => e >= FIRST_TABLE_EDITION);
    if (!usable.length) throw new Error('no edition on or after ' + FIRST_TABLE_EDITION);
    for (const e of (ALL ? usable : usable.slice(-1))) jobs.push({ edition: e, url: seen.get(e) });
  }
} catch (e) { await fail('discovery failed: ' + e.message); }

// ── 2. parse each edition (oldest first; the newest MUST parse, older ones may not carry the table) ──
const parsed = [];   // [{ edition, rows }]
for (const job of jobs) {
  try {
    let buf;
    if (existsSync(job.url)) buf = readFileSync(job.url);
    else { const r = await fetch(job.url, { headers: UA, redirect: 'follow' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); buf = Buffer.from(await r.arrayBuffer()); }
    if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
    const text = (await pdfParse(buf)).text;
    const rows = parseTable(text, job.edition);
    if (!rows) throw new Error('no "RAWLINSONS BUILDING PRICE INDEX" table');
    const actual = rows.filter(r => !r.forecast);
    if (!actual.length) throw new Error('table has no actual (non-forecast) quarters');
    for (const r of actual) for (const [s, v] of Object.entries(r.values)) if (v < 50 || v > 400) throw new Error(`implausible ${s} ${r.quarter} ${r.year} = ${v}`);
    parsed.push({ edition: job.edition, rows });
    console.log(`\n${job.edition} edition — ${actual.length} actual quarter(s), ${rows.length - actual.length} forecast skipped:`);
    for (const r of actual) console.log(`  ${r.year} ${r.quarter.padEnd(9)} ` + Object.entries(r.values).map(([s, v]) => `${s}=${v}`).join('  '));
  } catch (e) {
    const isNewest = job === jobs[jobs.length - 1];
    if (isNewest) await fail(`${job.edition} edition: ${e.message}`);
    console.warn(`  ${job.edition} edition skipped: ${e.message}`);
  }
}

// ── 3. merge (newest edition wins on overlaps) → rows ──
const q = new Map();   // `${slug}|${period}` → value
for (const p of parsed.sort((a, b) => a.edition.localeCompare(b.edition))) for (const r of p.rows) if (!r.forecast) for (const [slug, v] of Object.entries(r.values)) q.set(`${slug}|${r.year}-${QSTART[r.quarter]}-01`, v);
const out = [...q.entries()].map(([k, v]) => { const [slug, period] = k.split('|'); return { source: SOURCE, region_slug: slug, metric: METRIC, freq: 'Q', period, value: v }; });
const annual = [];
for (const slug of ANNUAL_FOR) {
  const byYear = {};
  for (const r of out) if (r.region_slug === slug) (byYear[r.period.slice(0, 4)] ||= []).push(r.value);
  for (const [y, vals] of Object.entries(byYear)) if (vals.length === 4) annual.push({ source: SOURCE, region_slug: slug, metric: METRIC, freq: 'A', period: `${y}-01-01`, value: Math.round(vals.reduce((a, b) => a + b, 0) / 4 * 100) / 100 });
}
const periods = [...new Set(out.map(r => r.period))].sort();
const qLabel = p => ({ '01': 'Mar', '04': 'Jun', '07': 'Sep', '10': 'Dec' })[p.slice(5, 7)] + '-' + p.slice(0, 4);
console.log(`\nQuarterly rows: ${out.length} (${periods.length} quarters ${qLabel(periods[0])} → ${qLabel(periods[periods.length - 1])}, 8 capitals)`);
console.log(`Annual (calendar-year mean, complete years only): ` + (annual.length ? annual.map(r => `${r.region_slug} ${r.period.slice(0, 4)}=${r.value}`).join('  ') : 'none yet'));

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert rdp_raw_series + forge_data_status.'); process.exit(0); }

const rows = [...out, ...annual];
for (let i = 0; i < rows.length; i += 500) {
  const { error } = await sb.from('rdp_raw_series').upsert(rows.slice(i, i + 500), { onConflict: 'source,region_slug,metric,freq,period' });
  if (error) await fail('upsert failed: ' + error.message);
}
const newest = parsed[parsed.length - 1];
try { await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `Rawlinsons BPI ${newest.edition}`, row_count: rows.length, status: 'ok', notes: `Rawlinsons Market Insight ${parsed.map(p => p.edition).join(', ')}: ${out.length} quarterly rows (8 capitals, actuals to ${qLabel(periods[periods.length - 1])}) + ${annual.length} annual (Canberra/Darwin calendar-year mean)` }); } catch {}
await recordStatus('ok', `${newest.edition} edition · actuals to ${qLabel(periods[periods.length - 1])} · ${out.length} quarterly rows, 8 capitals`, { row_count: rows.length, region_count: 8, latest_year: +periods[periods.length - 1].slice(0, 4) });
console.log(`\n✓ Upserted ${rows.length} rows → rdp_raw_series; status 'rawlinsons_bpi' ok.`);
