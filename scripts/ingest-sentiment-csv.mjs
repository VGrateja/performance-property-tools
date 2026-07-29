// =============================================================================
// ingest-sentiment-csv.mjs — Data Forge: NAB BUSINESS SURVEY + WESTPAC–MELBOURNE
// INSTITUTE HOUSE PRICE EXPECTATIONS, from Van's exported CSVs.
//
// WHY A CSV AND NOT AN API (checked properly 2026-07-30 — don't redo it):
//   • melbourneinstitute.unimelb.edu.au returns 403 to EVERY server-side request
//     (bare or full browser headers); a real browser loads it. And the HPEI is
//     not on that site anyway — it comes from the Westpac–MI Consumer Sentiment
//     report, published through Westpac IQ, which is behind a subscribe wall.
//   • NAB's articles ARE fetchable and do contain the number, but the phrasing
//     is not safely parseable. Across 6 months: 4 extracted, Nov-2025 missed
//     ("fell 5pts … to +1 index point"), Oct-2025 published only the CHANGE and
//     no level at all, and Mar-2026 ("fell 29 points to –29 index points") uses
//     an EN-DASH so a hyphen pattern silently grabs +29 instead of −29 — a
//     58-point sign error that looks perfectly plausible on a chart.
//   The monthly PDF only exists at a constructible URL for the CURRENT month.
//
// So: Van exports the numbers, this loads them. Upsert-only, so each new export
// extends the history and re-running is safe.
//
//   NAB CSV  → header row "National - Confidence, National - Condition, VIC - …"
//              then " Mon YYYY" rows. National + VIC/WA/QLD/NSW/SA/TAS (no
//              NT/ACT). Index points, can be negative. Oct-2024 is BLANK in the
//              source — skipped, not zero-filled.
//              → metrics business_confidence / business_conditions, source 'nab'
//   Consumer Sentiments CSV → two blocks:
//              (a) an annual block with National House Price Expectation Index
//                  2023-2026 → house_price_expectations, region australia, freq A
//              (b) a monthly block "Month, VIC House Price Expectation Index, …"
//                  May-2025 onward, WITH GAPS (the index isn't published every
//                  month) → house_price_expectations, st-vic, freq M
//              MHP (CL)/(PF) columns are ignored — medians already live in Forge
//              from the Cotality drop. National Consumer Sentiment Index is also
//              ignored: it is a different measure and consumer confidence is
//              already covered by the OECD CCI point.
//
// The CSVs derive from subscription sources (Westpac IQ / NAB) — never commit
// them; point --nab / --cs at wherever they are.
// Dry-run by DEFAULT; --write upserts.
//   node scripts/ingest-sentiment-csv.mjs [--nab <path>] [--cs <path>] [--write]
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const argOf = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const DL = join(homedir(), 'Downloads');
const NAB_CSV = argOf('--nab') || join(DL, 'June 2026 - Buying in Melbourne - NAB Survey.csv');
const CS_CSV = argOf('--cs') || join(DL, 'June 2026 - Buying in Melbourne - Consumer Sentiments.csv');
for (const f of [NAB_CSV, CS_CSV]) if (!existsSync(f)) { console.error('Not found: ' + f); process.exit(1); }

/* CSV split that respects quoted fields ("$865,000") */
function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out.map(s => s.trim());
}
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// " Nov 2023" → 2023-11-01
const monthCell = s => {
  const m = String(s || '').trim().match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/);
  if (!m) return null;
  const n = MON[m[1].toLowerCase()]; if (!n) return null;
  return m[2] + '-' + String(n).padStart(2, '0') + '-01';
};
const num = s => { const t = String(s ?? '').replace(/[$,%\s]/g, ''); if (t === '' || t === '-') return null; const v = Number(t); return isFinite(v) ? v : null; };

const STATE = { National: 'australia', VIC: 'st-vic', NSW: 'st-nsw', QLD: 'st-qld', WA: 'st-wa', SA: 'st-sa', TAS: 'st-tas', NT: 'st-nt', ACT: 'st-act' };
const out = [];

/* ── 1) NAB business survey ───────────────────────────────────────────── */
{
  const lines = readFileSync(NAB_CSV, 'utf8').split(/\r?\n/);
  const hi = lines.findIndex(l => /-\s*Confidence/i.test(l));
  if (hi < 0) { console.error('NAB CSV: could not find the "<Region> - Confidence" header row'); process.exit(1); }
  const hdr = splitCsv(lines[hi]);
  const cols = [];
  hdr.forEach((h, i) => {
    const m = h.match(/^(.+?)\s*-\s*(Confidence|Condition)s?$/i);
    if (!m) return;
    const slug = STATE[m[1].trim()];
    if (!slug) { console.warn('  (unmapped NAB region "' + m[1].trim() + '")'); return; }
    cols.push({ i, slug, metric: m[2].toLowerCase().startsWith('confid') ? 'business_confidence' : 'business_conditions' });
  });
  let n = 0, blank = 0;
  for (const line of lines.slice(hi + 1)) {
    const c = splitCsv(line); const period = monthCell(c[0]);
    if (!period) continue;
    let got = 0;
    for (const col of cols) {
      const v = num(c[col.i]);
      if (v == null) continue;                                  // blank month (Oct-2024) → skip, never zero-fill
      out.push({ source: 'nab', region_slug: col.slug, metric: col.metric, freq: 'M', period, value: v });
      got++; n++;
    }
    if (!got) blank++;
  }
  const regions = [...new Set(cols.map(c => c.slug))];
  console.log('NAB business survey  → ' + n + ' rows, ' + regions.length + ' regions (' + regions.join(' ') + ')'
    + (blank ? ', ' + blank + ' blank month(s) skipped' : ''));
}

/* ── 2) Westpac–MI house price expectations ───────────────────────────── */
{
  const lines = readFileSync(CS_CSV, 'utf8').split(/\r?\n/);
  /* (a) annual block — the first header row carries "National House Price
         Expectation Index"; data rows start with a bare year */
  const ai = lines.findIndex(l => /National House Price Expectation Index/i.test(l));
  let na = 0;
  if (ai >= 0) {
    const col = splitCsv(lines[ai]).findIndex(h => /^National House Price Expectation Index$/i.test(h));
    for (const line of lines.slice(ai + 1)) {
      const c = splitCsv(line);
      if (!/^\d{4}$/.test(c[0] || '')) continue;
      const v = num(c[col]); if (v == null) continue;
      out.push({ source: 'wmi', region_slug: 'australia', metric: 'house_price_expectations', freq: 'A', period: c[0] + '-01-01', value: v });
      na++;
    }
  }
  /* (b) monthly block — "Month, VIC House Price Expectation Index, …" */
  const mi = lines.findIndex(l => /^Month,/i.test(l) && /VIC House Price Expectation Index/i.test(l));
  let nm = 0, gaps = 0;
  if (mi >= 0) {
    const col = splitCsv(lines[mi]).findIndex(h => /VIC House Price Expectation Index/i.test(h));
    for (const line of lines.slice(mi + 1)) {
      const c = splitCsv(line); const period = monthCell(c[0]);
      if (!period) continue;
      const v = num(c[col]);
      if (v == null) { gaps++; continue; }                       // the index isn't published every month
      out.push({ source: 'wmi', region_slug: 'st-vic', metric: 'house_price_expectations', freq: 'M', period, value: v });
      nm++;
    }
  }
  console.log('Westpac–MI HPEI      → ' + nm + ' monthly rows (st-vic)' + (gaps ? ', ' + gaps + ' month(s) with no published index' : '')
    + ' + ' + na + ' annual rows (australia)');
}

/* ── report ───────────────────────────────────────────────────────────── */
const key = r => r.metric + '|' + r.region_slug + '|' + r.freq;
const groups = {};
out.forEach(r => { (groups[key(r)] = groups[key(r)] || []).push(r); });
console.log('\n' + out.length + ' rows total\n');
console.log('  metric                     region      freq  n    range                latest');
Object.keys(groups).sort().forEach(k => {
  const g = groups[k].slice().sort((a, b) => a.period.localeCompare(b.period));
  const [metric, region, freq] = k.split('|');
  console.log('  ' + metric.padEnd(26) + region.padEnd(12) + freq.padEnd(6) + String(g.length).padEnd(5)
    + (g[0].period.slice(0, 7) + '→' + g[g.length - 1].period.slice(0, 7)).padEnd(21)
    + String(g[g.length - 1].value));
});

if (!WRITE) { console.log('\nDry run — nothing written. Re-run with --write to upsert.'); }
else {
  const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
  try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exitCode = 1; }
  else {
    const sb = createClient(URL, KEY, { auth: { persistSession: false } });
    let bad = false;
    for (let i = 0; i < out.length && !bad; i += 500) {
      const { error } = await sb.from('rdp_raw_series').upsert(out.slice(i, i + 500), { onConflict: 'source,region_slug,metric,freq,period' });
      if (error) { console.error('Upsert failed at row ' + i + ': ' + error.message); process.exitCode = 1; bad = true; }
    }
    if (!bad) {
      const now = new Date().toISOString();
      const last = out.map(r => r.period).sort().pop();
      await sb.from('forge_data_status').upsert({
        data_key: 'sentiment_manual', label: 'Business & House Price Sentiment',
        source: 'NAB Monthly Business Survey + Westpac–Melbourne Institute (CSV export)',
        status: 'ok', message: out.length + ' rows · to ' + last.slice(0, 7),
        last_run_at: now, last_ok_at: now, updated_at: now,
      }, { onConflict: 'data_key' });
      console.log('\n✓ Upserted ' + out.length + ' rows.');
    }
  }
}
