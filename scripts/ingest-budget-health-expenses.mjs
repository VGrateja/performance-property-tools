// =============================================================================
// ingest-budget-health-expenses.mjs — Data Forge path: FEDERAL HEALTH BUDGET
// (Australian Government expenses on the HEALTH function, $m, by financial year).
//
// Source: the Department of Finance publishes every Budget's tables on data.gov.au
// as "Budget YYYY-YYYY and Portfolio Budget Statements (PBS) - Tables and Data";
// the "Budget Paper No.1 Tables" zip holds Statement "Estimates of expenses by
// function" as CSV (Table 6.3 in 2026-27, Table 5.3 in 2025-26 — numbering moves,
// so the table is found by its ROWS: Health, Defence, Education, …). Machine-
// readable BP1 tables exist from the 2025-26 Budget on; earlier years stay seeded.
//
// Vintage rule (the Commercial tab's own convention — its last three points were
// all copied from the 2024-25 Budget): every year a Budget covers takes THAT
// Budget's estimate, so the newest Budget restates the years it overlaps and the
// older Budgets keep the years it doesn't. Upsert-only on the 5-column key.
//
// Metric → rdp_raw_series: source `budget`, region `australia`,
//   metric `fed_health_expenses`, freq `A`, period = FY START (1 July; "2026-27" is
//   2026-07-01), value = $m (integer, as printed).
// Status → forge_data_status data_key 'fed_health_budget' (its own Forge card).
// Feeds forge_commercial tab fed-gov-health-budget-data via build-commercial-from-rdp.
//
// Dry-run by DEFAULT; --write upserts.
//   node scripts/ingest-budget-health-expenses.mjs                # newest Budget, print
//   node scripts/ingest-budget-health-expenses.mjs --write        # newest Budget, upsert
//   node scripts/ingest-budget-health-expenses.mjs --all --write  # every Budget with BP1 tables, oldest first
//   node scripts/ingest-budget-health-expenses.mjs --year=2025    # the 2025-26 Budget only
//   node scripts/ingest-budget-health-expenses.mjs <zip-file|url> --year=2026   # a zip you already have
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const ALL = process.argv.includes('--all');
const YEAR = +((process.argv.find(a => a.startsWith('--year=')) || '').split('=')[1] || 0) || null;
const OVERRIDE = process.argv.slice(2).find(a => !a.startsWith('--'));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' };
const CKAN = 'https://data.gov.au/data/api/3/action/package_search?rows=40&q=' + encodeURIComponent('"Portfolio Budget Statements" "Tables and Data"');
const TITLE_RE = /^Budget (\d{4})-(\d{4}) and Portfolio Budget Statements/i;
const BP1_RES_RE = /budget paper no\.?\s*1 tables/i;

const SOURCE = 'budget', REGION = 'australia', METRIC = 'fed_health_expenses', FREQ = 'A';
const FUNCTIONS = ['Defence', 'Education', 'Health', 'Social security and welfare'];   // rows that identify the table
const norm = s => String(s ?? '').replace(/^﻿/, '').replace(/\s+/g, ' ').trim();
const num = v => { const n = parseFloat(norm(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const fyStart = cell => { const m = norm(cell).match(/(20\d{2})-(\d{2})/); return m ? +m[1] : null; };
const fyLabel = y => `${y}-${String(y + 1).slice(2)}`;

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
  const row = { data_key: 'fed_health_budget', label: 'Federal Health Budget', source: 'Budget Paper No. 1 "Estimates of expenses by function" — Health ($m), Department of Finance tables on data.gov.au', status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated? ' + error.message + ')');
}
const fail = async (msg) => { console.error('\n✗ ' + msg); await recordStatus('error', msg); process.exit(1); };

// ── a minimal zip reader (stored or deflated entries; the BP1 zips are a few dozen KB) ──
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('bad zip local header for ' + name);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = buf.subarray(start, start + csize);
    if (!name.endsWith('/')) out[name] = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : (() => { throw new Error(`zip method ${method} not supported (${name})`); })();
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
// ── a small CSV parser (quotes, embedded commas, CRLF) ──
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
// ── find the functions table in a zip and read the Health row → { fy: $m } ──
function healthFromZip(entries) {
  for (const [name, data] of Object.entries(entries)) {
    if (!/\.csv$/i.test(name)) continue;
    const rows = parseCsv(data.toString('utf8'));
    const first = rows.map(r => norm(r[0]));
    if (!FUNCTIONS.every(f => first.includes(f))) continue;
    const hr = rows.findIndex(r => r.filter(c => fyStart(c) != null).length >= 3);
    const health = rows.find(r => norm(r[0]) === 'Health');
    if (hr < 0 || !health) continue;
    const out = {};
    rows[hr].forEach((c, i) => { const y = fyStart(c); const v = num(health[i]); if (y != null && v != null) out[y] = Math.round(v); });
    if (Object.keys(out).length < 3) continue;
    return { name, title: norm(rows[0][0]) || norm(rows[hr][1]), values: out };
  }
  return null;
}

// ── 1. which Budgets ──
const jobs = [];   // [{ year, label, url, dataset }]
try {
  if (OVERRIDE) {
    if (!YEAR) throw new Error('an override zip needs --year=<budget year>, e.g. --year=2026 for the 2026-27 Budget');
    jobs.push({ year: YEAR, url: OVERRIDE, dataset: 'override' });
  } else {
    const r = await fetch(CKAN, { headers: UA });
    if (!r.ok) throw new Error(`data.gov.au HTTP ${r.status}`);
    const j = await r.json();
    const found = [];
    for (const ds of (j.result && j.result.results) || []) {
      const m = TITLE_RE.exec(norm(ds.title)); if (!m) continue;
      const res = (ds.resources || []).find(x => BP1_RES_RE.test(norm(x.name)) || /bp1\.zip$|budget-paper-no\.?1-tables\.zip$/i.test(x.url || ''));
      found.push({ year: +m[1], dataset: ds.title, url: res ? res.url : null });
    }
    found.sort((a, b) => a.year - b.year);
    const withZip = found.filter(f => f.url);
    console.log('data.gov.au Budget datasets: ' + found.map(f => fyLabel(f.year) + (f.url ? '' : ' (no BP1 tables)')).join(', '));
    if (!withZip.length) throw new Error('no Budget dataset with a "Budget Paper No.1 Tables" zip');
    if (YEAR) { const one = withZip.find(f => f.year === YEAR); if (!one) throw new Error(`no BP1 tables for the ${fyLabel(YEAR)} Budget`); jobs.push(one); }
    else if (ALL) jobs.push(...withZip);
    else jobs.push(withZip[withZip.length - 1]);
  }
} catch (e) { await fail('discovery failed: ' + e.message); }

// ── 2. read each Budget's Health row ──
const results = [];   // [{ year, table, values }]
for (const job of jobs) {
  try {
    let buf;
    if (existsSync(job.url)) buf = readFileSync(job.url);
    else { const r = await fetch(job.url, { headers: UA, redirect: 'follow' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); buf = Buffer.from(await r.arrayBuffer()); }
    const entries = unzip(buf);
    const h = healthFromZip(entries);
    if (!h) throw new Error(`no expenses-by-function table in the zip (${Object.keys(entries).length} files)`);
    const years = Object.keys(h.values).map(Number).sort();
    if (!years.includes(job.year)) throw new Error(`table years ${years.join(',')} don't include the Budget year ${job.year}`);
    for (const [y, v] of Object.entries(h.values)) if (v < 40000 || v > 500000) throw new Error(`implausible Health figure ${v} for ${fyLabel(+y)}`);
    results.push({ year: job.year, table: h.name, values: h.values });
    console.log(`\n${fyLabel(job.year)} Budget — ${h.name} (${h.title.slice(0, 60)}):`);
    console.log('  Health ($m): ' + years.map(y => `${fyLabel(y)}=${h.values[y].toLocaleString()}`).join('  '));
  } catch (e) { await fail(`${fyLabel(job.year)} Budget: ${e.message}`); }
}

// ── 3. merge — newer Budget wins on the years it covers ──
const merged = {};   // fyStart → { value, vintage }
for (const r of results.sort((a, b) => a.year - b.year)) for (const [y, v] of Object.entries(r.values)) merged[y] = { value: v, vintage: r.year };
const yrs = Object.keys(merged).map(Number).sort();
console.log(`\nTo store (${yrs.length} years, newest vintage wins): ` + yrs.map(y => `${fyLabel(y)}=${merged[y].value.toLocaleString()} [${fyLabel(merged[y].vintage)} Budget]`).join('  '));

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert rdp_raw_series + forge_data_status.'); process.exit(0); }

const rows = yrs.map(y => ({ source: SOURCE, region_slug: REGION, metric: METRIC, freq: FREQ, period: `${y}-07-01`, value: merged[y].value }));
const { error } = await sb.from('rdp_raw_series').upsert(rows, { onConflict: 'source,region_slug,metric,freq,period' });
if (error) await fail('upsert failed: ' + error.message);
const newest = results[results.length - 1];
try { await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `Budget ${fyLabel(newest.year)} health`, row_count: rows.length, status: 'ok', notes: `fed_health_expenses ${fyLabel(yrs[0])}→${fyLabel(yrs[yrs.length - 1])} from ${results.map(r => fyLabel(r.year) + ' Budget ' + r.table).join('; ')}` }); } catch {}
await recordStatus('ok', `${fyLabel(newest.year)} Budget · Health ${fyLabel(newest.year)} = $${(newest.values[newest.year] / 1000).toFixed(1)}bn · ${yrs.length} years stored (${fyLabel(yrs[0])}→${fyLabel(yrs[yrs.length - 1])})`, { row_count: rows.length, region_count: 1, latest_year: newest.year });
console.log(`\n✓ Upserted ${rows.length} rows → rdp_raw_series; status 'fed_health_budget' ok.`);
