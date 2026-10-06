// =============================================================================
// scripts/sold-check/record.mjs — record what the scheduled checker found.
//
//   node scripts/sold-check/record.mjs <results.json> [--run-id=…] [--dry-run]
//
// <results.json> = [{ id, verdict, sale_date, sale_price, source_url,
//                     confidence, notes }]
//   id          the property id from pending.json
//   verdict     sold | listed | not_sold | unknown
//   sale_date   YYYY-MM-DD or null       sale_price  number or null
//   source_url  http(s) link or null     confidence  high | medium | low | null
//   notes       short text or null
//
// Inserts one sold_check_results row per entry with checked_by='schedule' and
// one run_id for the whole file (default sched-<UTC yyyymmdd-hhmm>). It NEVER
// changes a property's status — a sold/listed result goes to the tool's Verify
// queue and only a person's Confirm marks the property sold. Entries that fail
// validation are skipped and reported by position and reason (no content).
// Prints counts only. Runbook: docs/SOLD_CHECK.md.
// =============================================================================
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { admin, fetchAll, parseArgs, ROOT } from './_env.mjs';

const { opts, pos } = parseArgs(process.argv.slice(2));
if (!pos[0]) { console.error('usage: node scripts/sold-check/record.mjs <results.json> [--run-id=…] [--dry-run]'); process.exit(1); }
let input;
try { input = JSON.parse(readFileSync(resolve(ROOT, pos[0]), 'utf8')); } catch (e) { console.error('could not read the results file as JSON'); process.exit(1); }
if (!Array.isArray(input)) { console.error('the results file must be a JSON array'); process.exit(1); }
const stamp = new Date().toISOString();
const runId = typeof opts['run-id'] === 'string' && opts['run-id'].trim()
  ? opts['run-id'].trim()
  : 'sched-' + stamp.slice(0, 10).replace(/-/g, '') + '-' + stamp.slice(11, 16).replace(':', '');

const VERDICTS = new Set(['sold', 'listed', 'not_sold', 'unknown']);
const CONF = new Set(['high', 'medium', 'low']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const known = new Set((await fetchAll('sold_check_properties', 'id')).map(p => p.id));
const rows = [], skipped = [];
input.forEach((e, i) => {
  const why = [];
  if (!e || typeof e !== 'object') { skipped.push([i, 'not an object']); return; }
  if (!UUID.test(String(e.id || ''))) why.push('id is not a property id');
  else if (!known.has(e.id)) why.push('id is not in the register');
  if (!VERDICTS.has(e.verdict)) why.push('verdict must be sold/listed/not_sold/unknown');
  const conf = e.confidence == null || e.confidence === '' ? null : String(e.confidence).toLowerCase();
  if (conf !== null && !CONF.has(conf)) why.push('confidence must be high/medium/low');
  const date = e.sale_date == null || e.sale_date === '' ? null : String(e.sale_date);
  if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + 'T00:00:00Z')))) why.push('sale_date must be YYYY-MM-DD');
  const price = e.sale_price == null || e.sale_price === '' ? null : Number(String(e.sale_price).replace(/[$,\s]/g, ''));
  if (price !== null && !Number.isFinite(price)) why.push('sale_price must be a number');
  const url = e.source_url == null || e.source_url === '' ? null : String(e.source_url).trim();
  if (url !== null && !/^https?:\/\//i.test(url)) why.push('source_url must start with http');
  if (why.length) { skipped.push([i, why.join('; ')]); return; }
  rows.push({ property_id: e.id, checked_by: 'schedule', run_id: runId, verdict: e.verdict, sale_date: date, sale_price: price,
    source_url: url, confidence: conf, notes: e.notes == null || e.notes === '' ? null : String(e.notes).slice(0, 2000) });
});
const by = v => rows.filter(r => r.verdict === v).length;
let inserted = 0;
if (!opts['dry-run']) {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await admin.from('sold_check_results').insert(rows.slice(i, i + 200));
    if (error) { console.error('insert failed after ' + inserted + ' rows: ' + error.message); process.exit(1); }
    inserted += Math.min(200, rows.length - i);
  }
}
console.log('run id: ' + runId + (opts['dry-run'] ? ' (dry run — nothing written)' : ''));
console.log('entries read: ' + input.length + ' · valid: ' + rows.length + ' · inserted: ' + inserted);
console.log('verdicts: sold ' + by('sold') + ' · listed ' + by('listed') + ' · not_sold ' + by('not_sold') + ' · unknown ' + by('unknown'));
console.log('to verify in the tool: ' + (by('sold') + by('listed')));
if (skipped.length) { console.log('skipped: ' + skipped.length); for (const [i, w] of skipped) console.log('  entry #' + i + ': ' + w); }
