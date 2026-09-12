// =============================================================================
// ingest-westpac-hpei.mjs — Data Forge: WESTPAC–MELBOURNE INSTITUTE HOUSE PRICE
// EXPECTATIONS INDEX, national, monthly — read straight off the public bulletin.
//
// WHY THIS EXISTS (Van, 2026-09-12 — "build the Westpac for now"):
//   The 2026-07-30 check found no machine-readable source for the HPEI and it
//   went into the CSV export. Re-checked 2026-09-12: that finding was half
//   right. The Melbourne Institute SITE does block servers, but the monthly
//   "Westpac–MI Consumer Sentiment Bulletin" PDF is served publicly from
//   Westpac's own library with no login — a plain server GET returns 200 — and
//   its summary table carries the national index as TEXT, so it can be parsed.
//   The STATE series (the VIC index that B/S page 31 charts) is NOT in the free
//   bulletin; that stays on the Sentiment card as a manual/CSV series.
//
// WHERE THE FILE LIVES — the filename embeds the RELEASE DATE, so it cannot be
// built from the month alone; we probe the weekdays of the month, Tuesdays
// first (every release we have seen is a Tuesday: 2023-01-17, 2024-09-10,
// 2025-02-11, 2025-10-07, 2025-11-11, 2026-02-10, 2026-06-09, 2026-07-14).
// Three hosts over the years, all still serving:
//   ≥ 2025-02  library.westpaciq.com.au/…/aus/YYYY/MM/erYYYYMMDDBullConsumerSentiment.pdf
//   ≤ 2024     www.westpac.com.au/content/dam/public/wbc/documents/pdf/aw/economics-research/er….pdf
//   some 2023  www.westpac.com.au/docs/pdf/aw/economics-research/er….pdf
// A month found on no host is REPORTED and skipped — never guessed.
//
// HOW THE NUMBER IS READ — the bulletin's summary table row comes out of the
// PDF text as one run with no spaces, e.g.
//   "House Price Expectations Index130.3163.8166.5150.6128.2–14.9–23.0"
// Every cell has exactly one decimal, so the run splits cleanly into 7 tokens:
//   [long-run avg, (avg since 2009?), year-ago, PREVIOUS month, THIS month,
//    % change m/m, % change y/y]
// THIS month is token 5. Two things make that safe rather than assumed:
//   1. the row's own arithmetic — (this/prev − 1) must equal the printed m/m %
//      and (this/year-ago − 1) the y/y % — is re-checked for every month, and
//   2. the bulletin's prose ("…fell 14.9% to 128.2") is read as a second
//      witness where the sentence exists.
// A month that fails BOTH checks is skipped loudly. Negatives are EN-DASHES in
// the PDF — the same trap that produced a 58-point sign error in the NAB
// article parser (see ingest-sentiment-csv.mjs) — so every dash variant is
// normalised before parsing.
//
// STORAGE — the same lineage the CSV loads into, so the two never fork:
//   rdp_raw_series  source='wmi' · region_slug='australia' · metric
//   'house_price_expectations' · freq='M' · period 'YYYY-MM-01'
// The survey month is the release month (the 9-Jun-2026 bulletin reports June).
// Status → forge_data_status data_key 'hpei_national' (its own card in Forge).
// Upsert-only. Dry-run by DEFAULT; --write upserts.
//
//   node scripts/ingest-westpac-hpei.mjs                      # latest months, dry
//   node scripts/ingest-westpac-hpei.mjs --write              # what GATHER runs
//   node scripts/ingest-westpac-hpei.mjs --from 2023-01 --write   # backfill
//   node scripts/ingest-westpac-hpei.mjs --month 2026-06      # one month
//   node scripts/ingest-westpac-hpei.mjs --month 2026-06 --url <pdf>   # bypass discovery
//
// Default range: from the month AFTER the newest stored national monthly row
// (floor 2023-01 when there is none) to the current month, always re-reading
// the last two months so a late release is caught the following run.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/* pdf-parse's index.js runs a self-test that reads a fixture file when it is
   not `require`d from another CJS module — under ESM that throws ENOENT. The
   lib entry has no such block. */
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const ONLY_MONTH = arg('--month');           // YYYY-MM
const ONLY_URL = arg('--url');
const FROM = arg('--from');                  // YYYY-MM
const TO = arg('--to');                      // YYYY-MM
const FLOOR = '2023-01';

const URL_SB = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const SOURCE = 'wmi', REGION = 'australia', METRIC = 'house_price_expectations', FREQ = 'M';

const ym = (d) => d.toISOString().slice(0, 7);
const pad = (n) => String(n).padStart(2, '0');
function monthsBetween(a, b) {            // 'YYYY-MM' inclusive → array
  const out = []; let [y, m] = a.split('-').map(Number); const [y2, m2] = b.split('-').map(Number);
  while (y < y2 || (y === y2 && m <= m2)) { out.push(y + '-' + pad(m)); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
function addMonths(s, n) { let [y, m] = s.split('-').map(Number); m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return y + '-' + pad(m); }

/* ── discovery ─────────────────────────────────────────────────────────── */
function hostsFor(year) {
  const iq = (y, m, d) => `https://library.westpaciq.com.au/content/dam/public/westpaciq/secure/economics/documents/aus/${y}/${m}/er${y}${m}${d}BullConsumerSentiment.pdf`;
  const dam = (y, m, d) => `https://www.westpac.com.au/content/dam/public/wbc/documents/pdf/aw/economics-research/er${y}${m}${d}BullConsumerSentiment.pdf`;
  const docs = (y, m, d) => `https://www.westpac.com.au/docs/pdf/aw/economics-research/er${y}${m}${d}BullConsumerSentiment.pdf`;
  return Number(year) >= 2025 ? [iq, dam, docs] : [dam, docs, iq];
}
function candidateDays(year, month) {      // weekdays, Tuesdays first
  const days = []; const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) { const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay(); if (dow >= 1 && dow <= 5) days.push({ d, dow }); }
  const rank = { 2: 0, 3: 1, 4: 2, 1: 3, 5: 4 };
  return days.sort((a, b) => rank[a.dow] - rank[b.dow] || a.d - b.d).map(x => pad(x.d));
}
async function fetchPdf(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' }, redirect: 'follow' });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 20000 || buf.subarray(0, 5).toString() !== '%PDF-') return null;   // an HTML "not found" page, not a bulletin
    return buf;
  } catch { return null; }
}
async function discover(month) {           // → { url, buf } | null
  const [y, m] = month.split('-');
  for (const d of candidateDays(Number(y), Number(m))) {
    for (const mk of hostsFor(y)) {
      const url = mk(y, m, d);
      const buf = await fetchPdf(url);
      if (buf) return { url, buf };
      await new Promise(r => setTimeout(r, 120));
    }
  }
  return null;
}

/* ── parsing ───────────────────────────────────────────────────────────── */
const norm = (s) => s.replace(/[‒–—−]/g, '-');   // figure/en/em dash, minus → hyphen
function parseHpei(text) {
  const t = norm(text);
  const lines = t.split(/\r?\n/).map(l => l.replace(/[ \t]+/g, ' ').trim());
  const row = lines.find(l => /^House Price Expectations Index/.test(l));
  if (!row) return { ok: false, why: 'no "House Price Expectations Index" row in the summary table' };
  const toks = (row.replace(/^House Price Expectations Index/, '').match(/-?\d{1,3}\.\d/g) || []).map(Number);
  /* 6 is tolerated: in the Jul-2024 bulletin the y/y cell came out of the PDF as
     "7. 9" and was lost, but the m/m check below stands on its own. */
  if (toks.length < 6) return { ok: false, why: 'summary row has ' + toks.length + ' numbers, expected 6-7: ' + row };
  const [, , yearAgo, prev, latest, pctM, pctY] = toks;
  const chkM = Math.abs((latest / prev - 1) * 100 - pctM);
  const chkY = Math.abs((latest / yearAgo - 1) * 100 - pctY);
  const prose = t.replace(/\s+/g, ' ').match(/House Price Expectations(?: Index)? (?:fell|rose|lifted|dropped|slipped|jumped|edged|climbed|eased|surged|slumped|was|is)[sS]{0,60}? to (\d{2,3}\.\d)/i);
  const proseVal = prose ? Number(prose[1]) : null;
  const sane = latest >= 50 && latest <= 250;
  const arith = chkM <= 0.15;                                   // the row agrees with its own m/m %
  const witness = proseVal != null && Math.abs(proseVal - latest) < 0.05;
  if (!sane) return { ok: false, why: 'implausible value ' + latest, row };
  if (!arith && !witness) return { ok: false, why: `row arithmetic off (m/m check ${chkM.toFixed(2)}pp, y/y ${chkY.toFixed(2)}pp) and no prose witness`, row };
  return { ok: true, latest, prev, pctM, pctY, arith, witness, yoyOk: chkY <= 0.15, proseVal, row };
}

/* ── main ──────────────────────────────────────────────────────────────── */
const sb = KEY ? createClient(URL_SB, KEY, { auth: { persistSession: false } }) : null;

let months;
if (ONLY_MONTH) months = [ONLY_MONTH];
else {
  const to = TO || ym(new Date());
  let from = FROM;
  if (!from) {
    let newest = null;
    if (sb) {
      const { data } = await sb.from('rdp_raw_series').select('period').eq('source', SOURCE).eq('region_slug', REGION)
        .eq('metric', METRIC).eq('freq', FREQ).order('period', { ascending: false }).limit(1).maybeSingle();
      newest = data ? String(data.period).slice(0, 7) : null;
    }
    // re-read the last two stored months too, so a late release is caught next run
    from = newest ? addMonths(newest, -1) : FLOOR;
    if (from > to) from = to;
  }
  months = monthsBetween(from, to);
}
console.log(`Westpac–MI House Price Expectations Index — national, monthly  (${months[0]} → ${months[months.length - 1]}, ${months.length} month${months.length === 1 ? '' : 's'})`);

const out = [], missing = [], rejected = [];
for (const month of months) {
  const found = ONLY_URL ? { url: ONLY_URL, buf: await fetchPdf(ONLY_URL) } : await discover(month);
  if (!found || !found.buf) { missing.push(month); console.log(`  ${month}   — no bulletin found on any known path`); continue; }
  let text = '';
  try { text = (await pdfParse(found.buf)).text || ''; } catch (e) { rejected.push(month + ' (pdf unreadable: ' + String(e.message).slice(0, 60) + ')'); continue; }
  const p = parseHpei(text);
  const rel = found.url.match(/er(\d{4})(\d{2})(\d{2})/); const relDate = rel ? `${rel[1]}-${rel[2]}-${rel[3]}` : '?';
  if (!p.ok) { rejected.push(month + ' — ' + p.why); console.log(`  ${month}   ✗ ${p.why}`); continue; }
  const how = p.arith ? (p.witness ? 'row+prose agree' : 'row arithmetic') : 'prose witness only';
  console.log(`  ${month}   ${p.latest.toFixed(1)}   (prev ${p.prev.toFixed(1)}, ${p.pctM > 0 ? '+' : ''}${p.pctM.toFixed(1)}% m/m, ${p.pctY == null ? 'y/y cell unreadable' : (p.pctY > 0 ? '+' : '') + p.pctY.toFixed(1) + '% y/y'})   released ${relDate}   ✓ ${how}${p.yoyOk ? '' : '  [y/y column did not reconcile — noted, not fatal]'}`);
  out.push({ source: SOURCE, region_slug: REGION, metric: METRIC, freq: FREQ, period: month + '-01', value: Math.round(p.latest * 10) / 10 });
}

console.log('');
console.log(`Parsed ${out.length} of ${months.length} month(s)` + (missing.length ? ` · not found: ${missing.join(', ')}` : '') + (rejected.length ? ` · REJECTED: ${rejected.join(' | ')}` : ''));

/* Nothing parsed at all is only a failure if the stored series has gone stale
   (the bulletin is monthly; >75 days means we have missed at least two). */
if (!out.length) {
  let ageDays = Infinity;
  if (sb) {
    const { data } = await sb.from('rdp_raw_series').select('period').eq('source', SOURCE).eq('region_slug', REGION)
      .eq('metric', METRIC).eq('freq', FREQ).order('period', { ascending: false }).limit(1).maybeSingle();
    if (data) ageDays = (Date.now() - new Date(data.period).getTime()) / 86400000;
  }
  if (ageDays <= 75) console.log(`No new bulletin readable this run, but the stored series is current (${Math.round(ageDays)} days) — skipping, not failing.`);
  else { console.error('No bulletin could be read and the stored series is stale — failing the run.'); process.exitCode = 1; }
}

/* ── write (no process.exit on the success path — see ingest-oecd note) ── */
if (out.length && !WRITE) {
  console.log('\nDry run — nothing written. Re-run with --write to upsert.');
} else if (out.length) {
  if (!sb) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exitCode = 1; }
  else {
    let failed = false;
    for (let i = 0; i < out.length && !failed; i += 500) {
      const { error } = await sb.from('rdp_raw_series').upsert(out.slice(i, i + 500), { onConflict: 'source,region_slug,metric,freq,period' });
      if (error) { console.error('Upsert failed at row ' + i + ': ' + error.message); process.exitCode = 1; failed = true; }
    }
    if (!failed) {
      const now = new Date().toISOString();
      const { data: span } = await sb.from('rdp_raw_series').select('period').eq('source', SOURCE).eq('region_slug', REGION)
        .eq('metric', METRIC).eq('freq', FREQ).order('period');
      const first = span && span.length ? String(span[0].period).slice(0, 7) : out[0].period.slice(0, 7);
      const last = span && span.length ? String(span[span.length - 1].period).slice(0, 7) : out[out.length - 1].period.slice(0, 7);
      const { error: sErr } = await sb.from('forge_data_status').upsert({
        data_key: 'hpei_national', label: 'House Price Expectations (national)',
        source: 'Westpac–Melbourne Institute Consumer Sentiment bulletin (public PDF, Westpac IQ library)',
        status: 'ok', message: (span ? span.length : out.length) + ' months · ' + first + '–' + last + (missing.length ? ' · not found: ' + missing.join(', ') : ''),
        last_run_at: now, last_ok_at: now, updated_at: now,
      }, { onConflict: 'data_key' });
      if (sErr) console.warn('  (forge_data_status not updated? ' + sErr.message + ')');
      console.log('\n✓ Upserted ' + out.length + ' house-price-expectations rows (national, monthly).');
    }
  }
}
