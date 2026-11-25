// =============================================================================
// ingest-cotality-daily-hvi.mjs — Cotality's Daily Home Value Index (the five
// capitals and their aggregate) into the Forge, as month-end values plus the
// latest day (forge_cotality id `cl_daily_hvi`).
//
// WHY THIS EXISTS
// ---------------
// Van, 2026-11-25: the Market Cycles falls chart's 2026 line stops at August,
// because the Forge's monthly Cotality capital rows (forge_cl_suburbs, level
// `capital`) arrive about three months late. Cotality publishes a daily index
// for exactly the chart's five capitals (Sydney, Melbourne, Brisbane incl. Gold
// Coast, Adelaide, Perth) and their aggregate, to yesterday. The page joins
// the aggregate's months after its own last month onto the 2026 line, drawn
// faint, a dot per month.
//
// WHAT IT WRITES
// --------------
//   forge_cotality / cl_daily_hvi
//     data.latest = 'YYYY-MM-DD' (the newest day in the file)
//     data.series[<City> | 'Five capitals'] = { monthEnd: { 'YYYY-MM': value }, latest: value,
//                                               ago3: { day: 'YYYY-MM-DD', value } }
//   monthEnd holds only COMPLETE months (the file has a day on or after the
//   month's last day); the month in progress is `latest` alone. ago3 is the
//   last day on or before the same date three months back (Van, 2026-11-25:
//   the falls chart's "pace over the last 3 months" runs to the latest day).
//
// WHERE IT READS
// --------------
//   https://au-indices.cotality.com/asx.json — the public feed behind
//   https://www.cotality.com/au/our-data/indices ("Daily back series", a
//   rolling 365 days). Cotality revises the past 12 months on the 1st of each
//   month, so re-run after the 1st to take the revised months.
//
// RUN
// ---
//   node scripts/ingest-cotality-daily-hvi.mjs           dry run: prints the months
//   node scripts/ingest-cotality-daily-hvi.mjs --write   stores the row
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const ln of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const WRITE = process.argv.includes('--write');
const URL = 'https://au-indices.cotality.com/asx.json', ROW_ID = 'cl_daily_hvi';
const NAMES = { Sydney: 'Sydney', Melbourne: 'Melbourne', 'Brisbane (inc Gold Coast)': 'Brisbane', Adelaide: 'Adelaide', Perth: 'Perth', '5 capital city aggregate': 'Five capitals' };

const res = await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; forge-ingest)', Referer: 'https://www.cotality.com/au/our-data/indices' } });
if (!res.ok) throw new Error('fetch ' + URL + ': HTTP ' + res.status);
const feed = await res.json();
if (!Array.isArray(feed.worm) || !feed.worm.length) throw new Error('the feed has no daily back series (worm) - stop');

const iso = d => { const s = String(d); return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); };
const lastDay = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const series = {}; let latest = '';
for (const s of feed.worm) {
  const name = NAMES[s.label]; if (!name) continue;
  const days = s.data.map(([d, v]) => [iso(d), +v]).filter(([, v]) => Number.isFinite(v)).sort((a, b) => a[0] < b[0] ? -1 : 1);
  const end = days[days.length - 1][0]; if (end > latest) latest = end;
  const monthEnd = {};
  for (const [d, v] of days) { const ym = d.slice(0, 7); if (end >= lastDay(ym)) monthEnd[ym] = v; }   /* the last day seen in each complete month */
  /* ago3: the last day on or before the same date three months back, for the falls chart's pace over the last 3 months */
  const [ey, em, ed] = end.split('-').map(Number), back = new Date(Date.UTC(ey, em - 4, 1)).toISOString().slice(0, 7);
  const want = back + '-' + String(Math.min(ed, +lastDay(back).slice(8, 10))).padStart(2, '0'), prior = days.filter(([d]) => d <= want).pop();
  series[name] = { monthEnd, latest: days[days.length - 1][1], ago3: prior ? { day: prior[0], value: prior[1] } : null };
}
const missing = Object.values(NAMES).filter(n => !series[n]);
if (missing.length) throw new Error('missing from the feed: ' + missing.join(', ') + ' - stop');

const months = Object.keys(series['Five capitals'].monthEnd).sort();
console.log('feed generated ' + feed.generatedDate + ', latest day ' + latest + ', complete months ' + months[0] + ' to ' + months[months.length - 1]);
const pc = (a, b) => ((b / a - 1) * 100).toFixed(2) + '%';
for (const n of Object.values(NAMES)) {
  const me = series[n].monthEnd, ks = Object.keys(me).sort(), tail = ks.slice(-3);
  console.log('  ' + n.padEnd(14) + tail.map((k, i) => k + ' ' + me[k] + (i ? ' (' + pc(me[tail[i - 1]], me[k]) + ')' : '')).join(' | ') + ' | to ' + latest + ' ' + series[n].latest + ' (' + pc(me[tail[tail.length - 1]], series[n].latest) + ')'
    + (series[n].ago3 ? ' | 3 months from ' + series[n].ago3.day + ' ' + series[n].ago3.value + ' (' + pc(series[n].ago3.value, series[n].latest) + ')' : ' | no day 3 months back'));
}

const payload = {
  note: 'Cotality Daily Home Value Index, all dwellings: the five capitals (Brisbane incl. Gold Coast) and their aggregate. monthEnd = the value on the last day of each complete month in the rolling 365-day back series; latest = the newest day; ago3 = the day three months before it. Cotality revises the past 12 months on the 1st of each month.',
  source: URL, generated: String(feed.generatedDate), latest, updated: new Date().toISOString(), series,
};
console.log('payload ' + Math.round(JSON.stringify(payload).length / 1024) + ' KB');
if (!WRITE) console.log('dry run — nothing written. Re-run with --write to store it.');
else {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { error } = await sb.from('forge_cotality').upsert({ id: ROW_ID, data: payload, file_name: 'asx.json ' + latest, uploaded_by: 'ingest-cotality-daily-hvi', updated_at: new Date().toISOString() });
  if (error) { console.error('write failed: ' + error.message); process.exitCode = 1; }
  else console.log('WRITTEN forge_cotality id=' + ROW_ID);
}
