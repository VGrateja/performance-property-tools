// =============================================================================
// scripts/sold-check/pending.mjs — the scheduled checker's work list.
//
//   node scripts/sold-check/pending.mjs [--days=30] [--market=X] [--limit=N]
//                                       [--out=path] [--include-unknown]
//                                       [--include-awaiting]
//
// Lists HELD properties (add --include-unknown for status 'unknown' too) whose
// last check is older than --days (default 30) or that were never checked —
// never-checked first, then the oldest check first. A property that already
// has a sold/listed result waiting in the Verify queue is left out (a person
// has to look at that one first) unless --include-awaiting.
//
// Output: JSON [{ id, market, address, listing_url, purchase_date }] — NO client
// names, NO HubSpot links, nothing else from the register — written to --out
// (default scratch/sold-check/pending.json, gitignored). Prints counts only.
// Runbook: docs/SOLD_CHECK.md.
// =============================================================================
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fetchAll, parseArgs, ROOT } from './_env.mjs';

const { opts } = parseArgs(process.argv.slice(2));
const days = opts.days === undefined ? 30 : Number(opts.days);
if (!Number.isFinite(days) || days < 0) { console.error('--days must be a number of days (0 = everything)'); process.exit(1); }
const limit = opts.limit === undefined ? null : Number(opts.limit);
if (limit !== null && (!Number.isInteger(limit) || limit < 1)) { console.error('--limit must be a whole number'); process.exit(1); }
const market = typeof opts.market === 'string' ? opts.market.trim().toLowerCase() : null;
const out = resolve(ROOT, typeof opts.out === 'string' ? opts.out : 'scratch/sold-check/pending.json');
const statuses = opts['include-unknown'] ? ['held', 'unknown'] : ['held'];

const props = await fetchAll('sold_check_properties', 'id,market,address,listing_url,purchase_date,status', q => q.in('status', statuses));
const results = await fetchAll('sold_check_results', 'id,property_id,checked_at,verdict,review');
const last = new Map(), awaiting = new Set();
for (const r of results) {
  const t = Date.parse(r.checked_at);
  if (!last.has(r.property_id) || t > last.get(r.property_id)) last.set(r.property_id, t);
  if ((r.verdict === 'sold' || r.verdict === 'listed') && !r.review) awaiting.add(r.property_id);
}
const cutoff = Date.now() - days * 86400e3;
let inScope = 0, fresh = 0, waiting = 0;
const due = [];
for (const p of props) {
  if (market && String(p.market).toLowerCase() !== market) continue;
  inScope++;
  const t = last.get(p.id);
  if (t !== undefined && t > cutoff) { fresh++; continue; }
  if (awaiting.has(p.id) && !opts['include-awaiting']) { waiting++; continue; }
  due.push({ p, t: t === undefined ? -Infinity : t });
}
due.sort((a, b) => a.t - b.t || String(a.p.market).localeCompare(String(b.p.market)) || String(a.p.address).localeCompare(String(b.p.address)));
const list = (limit ? due.slice(0, limit) : due).map(({ p }) => ({ id: p.id, market: p.market, address: p.address, listing_url: p.listing_url || null, purchase_date: p.purchase_date || null }));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(list, null, 1));
console.log('properties (' + statuses.join('+') + (market ? ', one market' : '') + '): ' + inScope);
console.log('checked within ' + days + ' days (skipped): ' + fresh);
console.log('awaiting verification (skipped): ' + waiting);
console.log('due: ' + due.length + ' (never checked: ' + due.filter(d => d.t === -Infinity).length + ')');
console.log('written: ' + list.length + ' -> ' + relative(ROOT, out).replace(/\\/g, '/'));
