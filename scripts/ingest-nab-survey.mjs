// =============================================================================
// ingest-nab-survey.mjs — Data Forge: NAB BUSINESS CONFIDENCE + BUSINESS
// CONDITIONS, monthly, by state — read off NAB's public monthly survey PDF.
//
// WHY THIS EXISTS (Van, 2026-10-12 — "build it"):
//   The 2026-07-29 and 2026-09-12 checks looked at the survey's CHART PACK and
//   the news page, found the numbers only as charts, and kept NAB on the
//   Sentiment card as hand entry. Re-checked 2026-10-12: the full "NAB Monthly
//   Business Survey" PDF (not the chart pack) is public and its Table 1
//   "Confidence and Conditions by Industry and State" prints S.A. and Trend
//   values for the last three months for NSW, Vic, Qld, SA, WA, Tas and
//   Australia as TEXT.
//
// WHERE THE FILE LIVES — the filename changes month to month (June 2026 ends
// " mnb.pdf", July " sdlfkh.pdf", August plain ".pdf"), so it is never built
// from the month. We read nab.com.au/news/economy-markets, open each linked
// business-survey article, and take its "YYYYmMM NAB Monthly Business Survey"
// PDF (the chart pack and the QUARTERLY survey are ignored).
//
// HOW THE NUMBERS ARE READ — plain pdf-parse text runs the cells together
// ("34-1" is 3 | 4 | -1), so the table is read by POSITION: pdfjs text items
// with their x/y, grouped into rows by y. The state half is the right column;
// each state block is four rows (Confidence S.A., Confidence Trend, Conditions
// S.A., Conditions Trend) under three month headers. Only the S.A. rows are
// stored — that is the basis of the series already in the store (the June
// 2026 report's May figures match the CSV export: Australia confidence −14,
// conditions 3; Vic confidence −16). Every report revises its earlier months,
// so editions are applied oldest → newest and the newest wins.
//
// Writes → rdp_raw_series, source 'nab', freq 'M', period = month start,
//   metrics business_confidence + business_conditions,
//   regions australia, st-nsw, st-vic, st-qld, st-sa, st-wa, st-tas.
// Status → forge_data_status 'nab_survey' (its own card in Forge).
//
// Dry-run by DEFAULT; --write upserts.
//   node scripts/ingest-nab-survey.mjs                # newest monthly report, print
//   node scripts/ingest-nab-survey.mjs --write        # newest monthly report, upsert
//   node scripts/ingest-nab-survey.mjs --all --write  # every monthly report the news page links
//   node scripts/ingest-nab-survey.mjs <pdf-file|url> --month=2026-08 [--write]
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');   // index.js runs a fixture self-test under ESM → ENOENT

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const ALL = process.argv.includes('--all');
const MONTH = (process.argv.find(a => a.startsWith('--month=')) || '').split('=')[1] || null;
const OVERRIDE = process.argv.slice(2).find(a => !a.startsWith('--'));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', 'Accept-Language': 'en' };
const NEWS = 'https://www.nab.com.au/news/economy-markets';

const SOURCE = 'nab', FREQ = 'M';
const STATE = { NEWSOUTHWALES: 'st-nsw', VICTORIA: 'st-vic', QUEENSLAND: 'st-qld', SOUTHAUSTRALIA: 'st-sa', WESTERNAUSTRALIA: 'st-wa', TASMANIA: 'st-tas', AUSTRALIA: 'australia' };
const ROW = { 'BUSINESSCONFIDENCE(S.A.)': 'business_confidence', 'BUSINESSCONDITIONS(S.A.)': 'business_conditions' };
const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const squash = s => String(s).replace(/\s+/g, '').toUpperCase();

const URL_ = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sb = KEY ? createClient(URL_, KEY, { auth: { persistSession: false } }) : null;

async function getText(url) {
  const r = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

// ── 1. which reports: [{ month:'YYYY-MM', url }] ──
async function discover() {
  const html = await getText(NEWS);
  const articles = [...new Set([...html.matchAll(/href="(\/news\/economy-markets\/[^"#?]*business-survey[^"#?]*)"/gi)].map(m => m[1]))];
  if (!articles.length) throw new Error('no business-survey articles linked from ' + NEWS);
  const found = new Map();
  for (const a of articles) {
    let page;
    try { page = await getText('https://www.nab.com.au' + a); } catch (e) { console.warn('  skip article ' + a + ': ' + e.message); continue; }
    /* both spellings seen: ".../pdf/2026m08%20NAB%20Monthly%20Business%20Survey.pdf" and the relative
       "/content/dam/nab/documents/news/2026m06-nab-monthly-business-survey-mnb.pdf" */
    for (const m of page.matchAll(/href="([^"]*?(20\d{2})m(\d{2})(?:%20|-)NAB(?:%20|-)Monthly(?:%20|-)Business(?:%20|-)Survey[^"]*?\.pdf)"/gi)) {
      if (/chart/i.test(m[1])) continue;
      const month = `${m[2]}-${m[3]}`;
      if (!found.has(month)) found.set(month, new URL(m[1], 'https://www.nab.com.au').href);
    }
  }
  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, url]) => ({ month, url }));
}

// ── 2. Table 1 → [{ region, metric, period, value }] ──
async function parseReport(buf) {
  const pages = [];
  await pdfParse(buf, { pagerender: async pg => {
    const tc = await pg.getTextContent();
    pages.push(tc.items.map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5] })).filter(it => it.s.trim()));
    return '';
  } });
  const page = pages.find(items => /Table\s*1\s*:?\s*Confidence and Conditions by Industry and State/i.test(items.map(i => i.s).join(' ')));
  if (!page) throw new Error('no "Table 1: Confidence and Conditions by Industry and State"');
  // rows by y (items on one printed line share y to within a point)
  const rows = [];
  for (const it of [...page].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find(r => Math.abs(r.y - it.y) < 2);
    if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  rows.forEach(r => r.items.sort((a, b) => a.x - b.x));
  const head = rows.find(r => r.items.filter(i => /^[A-Z][a-z]{2}-\d{2}$/.test(i.s.trim())).length === 6);
  if (!head) throw new Error('Table 1: no row with six month headers');
  const months = head.items.filter(i => /^[A-Z][a-z]{2}-\d{2}$/.test(i.s.trim())).slice(3).map(i => {
    const [mo, yy] = i.s.trim().split('-'); return { x: i.x, period: `20${yy}-${MON[mo]}-01` };
  });
  const out = [];
  let region = null, splitX = null;
  for (const r of rows.filter(r => r.y < head.y)) {
    const st = r.items.find(i => STATE[squash(i.s)]);
    if (st) { region = STATE[squash(st.s)]; splitX = st.x - 5; continue; }
    if (!region) continue;
    const right = r.items.filter(i => i.x >= splitX);
    const label = right.find(i => /business/i.test(i.s));
    const metric = label && ROW[squash(label.s)];
    if (!metric) continue;
    const nums = right.filter(i => i.x > label.x && /^-?\d+$/.test(i.s.trim()));
    if (nums.length !== 3) throw new Error(`Table 1: ${region} ${metric} has ${nums.length} values, expected 3`);
    nums.forEach((n, k) => out.push({ region, metric, period: months[k].period, value: +n.s.trim() }));
  }
  const regions = new Set(out.map(o => o.region));
  if (regions.size !== 7 || out.length !== 7 * 2 * 3) throw new Error(`Table 1: read ${out.length} values over ${regions.size} regions, expected 42 over 7`);
  if (out.some(o => o.value < -100 || o.value > 100)) throw new Error('Table 1: a net balance outside −100…100');
  return { months: months.map(m => m.period.slice(0, 7)), values: out };
}

let jobs = [];
const missing = [];
try {
  if (OVERRIDE) {
    if (!MONTH) throw new Error('an override PDF needs --month=YYYY-MM');
    jobs = [{ month: MONTH, url: OVERRIDE }];
  } else {
    const all = await discover();
    console.log(`nab.com.au/news/economy-markets: ${all.length} monthly survey report(s) linked (${all.map(j => j.month).join(', ')})`);
    if (!all.length) throw new Error('no monthly survey PDF found on the linked articles');
    jobs = ALL ? all : all.slice(-1);
  }
} catch (e) { missing.push('discovery: ' + e.message); }

const merged = new Map();   // `${region}|${metric}|${period}` → value (newest report wins)
for (const job of jobs) {
  try {
    const buf = existsSync(job.url) ? readFileSync(job.url) : Buffer.from(await (await fetch(job.url, { headers: UA })).arrayBuffer());
    if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
    const { months, values } = await parseReport(buf);
    if (months[2] !== job.month) throw new Error(`table ends ${months[2]}, the file says ${job.month}`);
    for (const v of values) merged.set(`${v.region}|${v.metric}|${v.period}`, v.value);
    console.log(`\n${job.month} report — months ${months.join(', ')} (S.A.):`);
    const show = (metric) => Object.values(STATE).map(r => `${r.replace('st-', '')} ${values.filter(v => v.region === r && v.metric === metric).map(v => v.value).join('/')}`).join('  ');
    console.log('  confidence  ' + show('business_confidence'));
    console.log('  conditions  ' + show('business_conditions'));
  } catch (e) { missing.push(`${job.month}: ${e.message}`); console.warn(`  ${job.month} report skipped: ${e.message}`); }
}

const out = [...merged.entries()].map(([k, value]) => { const [region_slug, metric, period] = k.split('|'); return { source: SOURCE, region_slug, metric, freq: FREQ, period, value }; });

if (!out.length) {
  /* nothing readable: skip if the stored series is still current (released ~2nd Tuesday; the gather runs on the 10th) */
  console.warn('\nNo NAB report could be read: ' + missing.join('; '));
  let ageDays = Infinity;
  if (sb) {
    const { data } = await sb.from('rdp_raw_series').select('period').eq('source', SOURCE).eq('region_slug', 'australia')
      .eq('metric', 'business_conditions').eq('freq', FREQ).order('period', { ascending: false }).limit(1).maybeSingle();
    if (data) ageDays = (Date.now() - new Date(data.period).getTime()) / 86400000;
  }
  if (ageDays <= 75) console.log(`The stored series is current (${Math.round(ageDays)} days) — skipping, not failing.`);
  else {
    console.error('The stored series is stale — failing the run.');
    if (WRITE && sb) await sb.from('forge_data_status').upsert({ data_key: 'nab_survey', label: 'NAB business confidence & conditions', status: 'error',
      message: 'No NAB report readable: ' + missing.join('; ').slice(0, 300), last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'data_key' });
    process.exitCode = 1;
  }
} else if (!WRITE) {
  console.log(`\n${out.length} rows. Dry run — nothing written. Re-run with --write to upsert.`);
} else if (!sb) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exitCode = 1;
} else {
  /* no process.exit on the success path — see the ingest-oecd note */
  const { error } = await sb.from('rdp_raw_series').upsert(out, { onConflict: 'source,region_slug,metric,freq,period' });
  if (error) { console.error('Upsert failed: ' + error.message); process.exitCode = 1; }
  else {
    const now = new Date().toISOString();
    const last = out.map(o => o.period).sort().pop().slice(0, 7);
    const { error: sErr } = await sb.from('forge_data_status').upsert({
      data_key: 'nab_survey', label: 'NAB business confidence & conditions',
      source: 'NAB Monthly Business Survey — Table 1, by state, S.A. (public PDF, nab.com.au)',
      status: 'ok', message: `to ${last} · 7 regions × confidence + conditions` + (missing.length ? ' · skipped: ' + missing.join('; ').slice(0, 200) : ''),
      last_run_at: now, last_ok_at: now, updated_at: now,
    }, { onConflict: 'data_key' });
    if (sErr) console.warn('  (forge_data_status not updated? ' + sErr.message + ')');
    console.log(`\n✓ Upserted ${out.length} NAB rows (to ${last}).`);
  }
}
