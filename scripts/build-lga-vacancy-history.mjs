// =============================================================================
// build-lga-vacancy-history.mjs — seed the council-area vacancy series the
// Data Extractor reads (forge_cotality id `lga_vacancy_history`).
//
// WHY THIS EXISTS
// ---------------
// Saskia, 2026-11-12: George needs "our VR and rent data on a suburb level" for
// rental appraisals. Rent we hold by suburb (forge_cl_suburbs). Vacancy we do
// NOT: Cotality publishes it by capital city and by council area only, in the
// monthly `CSTDAT15969_CustomMT_LGA_<date>.csv`. That file carries EVERY
// council (about 440), but the Data Forge upload kept only our 28 regional
// markets and dropped the rest. The council area is the closest vacancy
// reading a suburb has, so this keeps all of them.
//
// WHAT IT WRITES
// --------------
//   forge_cotality / lga_vacancy_history
//     data.lgas[<key>] = { name, state, months: { 'YYYY-MM': { h:{vr,rent}, u:{vr,rent} } } }
//   key   = lgaKey(state, council name): lower case, non-alphanumerics to "_"
//           ("VIC", "Greater Geelong" -> "vic_greater_geelong"). Plain keys so
//           the Extractor can ask PostgREST for just the councils it needs.
//   vr    = PERCENT, 2 decimals (the Forge store's convention: 1.02, not 0.0102)
//   rent  = Cotality's "Median Asking Rent (3 months)", dollars a week
//
// WHERE THE MONTHS COME FROM
// --------------------------
//   1. every `CSTDAT*_LGA_*.csv` in a `CSTDAT*` folder under Downloads
//      (--dir=<folder> to look elsewhere): all councils, one month per file;
//   2. for the 28 regional markets only, the months already held in
//      forge_cotality / cot_rentvacancy_history (2019 on) — the same Cotality
//      readings, so those councils get their history too. Checked, not assumed:
//      wherever a month is in both, the two must agree or the script stops.
//
// After this seed the Data Forge rent/vacancy upload adds each new month by
// itself (saveLgaVacancy in tools/data-forge.html). Merge-only: a month already
// stored keeps any reading a later run lacks.
//
//   node scripts/build-lga-vacancy-history.mjs            dry run (default)
//   node scripts/build-lga-vacancy-history.mjs --write    store it
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try {
  if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL, KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');
const DIR = (process.argv.find(a => a.startsWith('--dir=')) || '').slice(6) || join(homedir(), 'Downloads');
const ROW_ID = 'lga_vacancy_history';

/* The same three rules the Data Forge upload and the Data Extractor use — keep
   them identical, a council filed under a different key is a council not found. */
const lgaKey = (state, name) => (String(state || '') + '_' + String(name || '')).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const STATE_CANON = { NEWSOUTHWALES:'NSW', VICTORIA:'VIC', QUEENSLAND:'QLD', WESTERNAUSTRALIA:'WA', TASMANIA:'TAS', SOUTHAUSTRALIA:'SA', NORTHERNTERRITORY:'NT', AUSTRALIANCAPITALTERRITORY:'ACT' };
const normState = s => { const u = String(s).toUpperCase().replace(/[^A-Z]/g, ''); return STATE_CANON[u] || u; };
const normalizeName = s => String(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/[-/]/g, ' ').replace(/\s+/g, ' ').trim();
const slugOf = s => String(s == null ? '' : s).trim()
  .replace(/\([^)]*\)/g, ' ').replace(/,\s*(act|nsw|nt|qld|sa|tas|vic|wa)\b/ig, ' ')
  .replace(/\bgreater\b/ig, ' ').replace(/\bregional\b/ig, ' ').replace(/-hastings/ig, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/* The Forge's 28 regional markets (LGA_TARGETS in tools/data-forge.html). */
const LGA_TARGETS = [
  ['Mackay','QLD'],['Bundaberg','QLD'],['Ipswich','QLD'],['Rockhampton','QLD'],['Gladstone','QLD'],
  ['Cairns','QLD'],['Townsville','QLD'],['Sunshine Coast','QLD'],['Toowoomba','QLD'],['Gold Coast','QLD'],
  ['Albury','NSW'],['Central Coast','NSW'],['Coffs Harbour','NSW'],['Orange','NSW'],['Port Macquarie','NSW'],
  ['Newcastle','NSW'],['Tamworth','NSW'],['Wagga Wagga','NSW'],['Wollongong','NSW'],
  ['Ballarat','VIC'],['Bendigo','VIC'],['Geelong','VIC'],['Wodonga','VIC'],['Mildura','VIC'],
  ['Mandurah','WA'],['Rockingham','WA'],['Bunbury','WA'],['Launceston','TAS'],
];
const nameMatches = (fileName, target) => {
  const f = normalizeName(fileName).split(' ').filter(Boolean), t = normalizeName(target).split(' ').filter(Boolean);
  for (let i = 0; i + t.length <= f.length; i++) if (t.every((tok, j) => f[i + j] === tok)) return true;
  return false;
};
const targetOf = (state, council) => LGA_TARGETS.find(([n, s]) => s === state && nameMatches(council, n)) || null;

/* One quoted CSV line -> fields. The export quotes every field but leaves an
   empty last one bare ("…","0.027",), so a split on '","' loses it. */
function csvFields(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}
const numOrNull = v => { const s = String(v == null ? '' : v).replace(/[$,%]/g, '').trim(); if (!s) return null; const n = parseFloat(s); return isFinite(n) ? n : null; };
const round2 = n => Math.round(n * 100) / 100;

// ── 1. every council, from the LGA exports ───────────────────────────────────
const LGAS = {};   // key -> { name, state, months: { 'YYYY-MM': { h:{vr,rent}, u:{vr,rent} } } }
const files = [];
for (const entry of readdirSync(DIR, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^CSTDAT/i.test(entry.name)) continue;
  for (const f of readdirSync(join(DIR, entry.name))) if (/_LGA_.*\.csv$/i.test(f)) files.push(join(DIR, entry.name, f));
}
console.log('reading ' + files.length + ' LGA export(s) under ' + DIR);
const csvMonths = new Set();
for (const file of files) {
  const lines = readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const hdr = csvFields(lines[0]).map(h => h.toLowerCase());
  const ci = lbl => hdr.findIndex(h => h.includes(lbl));
  const cState = ci('state'), cName = ci('council name'), cType = ci('property type'), cMonth = ci('month end'), cVac = ci('vacancy rate'), cRent = ci('median asking rent');
  if ([cState, cName, cType, cMonth, cVac, cRent].some(i => i < 0)) { console.error('  ' + file + ' — unexpected columns, stopped'); process.exit(1); }
  const rows = lines.slice(1).map(csvFields);
  /* Fraction or percent? Decided for the whole file, never per value: a 0.9%
     vacancy written as a percent looks exactly like a 90% fraction. Cotality's
     fractions centre near 0.015 and its percents near 1.5, so the file's median
     tells the two apart with two orders of magnitude to spare. */
  const vacs = rows.map(r => numOrNull(r[cVac])).filter(v => v != null).sort((a, b) => a - b);
  if (!vacs.length) { console.log('  ' + file + ' — no vacancy readings, skipped'); continue; }
  const asFraction = vacs[vacs.length >> 1] < 0.2;
  let n = 0;
  for (const r of rows) {
    const state = normState(r[cState] || ''), name = String(r[cName] || '').trim();
    const iso = String(r[cMonth] || '').match(/^(\d{4})-(\d{2})-\d{2}/);
    if (!state || !name || !iso) continue;
    const month = iso[1] + '-' + iso[2], t = String(r[cType]).toUpperCase() === 'U' ? 'u' : 'h';
    const vac = numOrNull(r[cVac]), rent = numOrNull(r[cRent]);
    if (vac == null && rent == null) continue;
    const key = lgaKey(state, name);
    const e = LGAS[key] || (LGAS[key] = { name, state, months: {} });
    const m = e.months[month] || (e.months[month] = {});
    if (m[t]) continue;                                   // the same drop downloaded twice
    m[t] = { vr: vac == null ? null : round2(asFraction ? vac * 100 : vac), rent };
    csvMonths.add(month); n++;
  }
  console.log('  ' + file.split(/[\\/]/).pop().padEnd(52) + String(n).padStart(6) + ' readings (' + (asFraction ? 'fractions -> percent' : 'already percent') + ')');
}
if (!Object.keys(LGAS).length) { console.error('No LGA export found under ' + DIR + ' — unzip CSTDAT15969_CustomMT_<date>.zip into its own folder there.'); process.exit(1); }
console.log('  -> ' + Object.keys(LGAS).length + ' councils, month(s) ' + [...csvMonths].sort().join(', '));

// ── 2. history for the 28 regional markets, from the stored monthly series ───
const { data: hRow, error: hErr } = await sb.from('forge_cotality').select('data').eq('id', 'cot_rentvacancy_history').maybeSingle();
if (hErr) { console.error('could not read cot_rentvacancy_history: ' + hErr.message); process.exit(1); }
const hist = (hRow && hRow.data && hRow.data.regions) || {};
let spliced = 0, checked = 0; const clashes = [], unmatched = [];
for (const [tName, tState] of LGA_TARGETS) {
  const hits = Object.entries(LGAS).filter(([, e]) => e.state === tState && targetOf(e.state, e.name) && targetOf(e.state, e.name)[0] === tName);
  const series = hist[slugOf(tName)];
  if (hits.length !== 1 || !series) { unmatched.push(tName + ' (' + tState + ')' + (hits.length !== 1 ? ' — ' + hits.length + ' councils match' : ' — no stored series')); continue; }
  const e = hits[0][1];
  for (const [month, byType] of Object.entries(series)) {
    for (const t of ['h', 'u']) {
      const rec = (byType || {})[t]; if (!rec || rec.vr == null) continue;
      const m = e.months[month] || (e.months[month] = {});
      if (m[t]) {                                          // in both: they must be the same reading
        checked++;
        if (m[t].vr != null && Math.abs(m[t].vr - round2(rec.vr)) > 0.011) clashes.push(e.name + ' ' + month + ' ' + t + ': export ' + m[t].vr + ' vs stored ' + rec.vr);
        continue;
      }
      m[t] = { vr: round2(rec.vr), rent: rec.rent == null ? null : rec.rent };
      spliced++;
    }
  }
}
console.log('history for the regional markets: ' + spliced + ' readings added from cot_rentvacancy_history; ' + checked + ' overlapping readings compared');
if (unmatched.length) console.log('  ⚠ no history spliced for: ' + unmatched.join('; '));
if (clashes.length) { console.error('  ✗ the export and the stored series disagree — stopped, nothing written:\n    ' + clashes.slice(0, 12).join('\n    ')); process.exit(1); }

// ── 3. merge onto what is already stored (merge-only) ────────────────────────
const { data: cur, error: cErr } = await sb.from('forge_cotality').select('data').eq('id', ROW_ID).maybeSingle();
if (cErr) { console.error('could not read ' + ROW_ID + ': ' + cErr.message); process.exit(1); }
const stored = (cur && cur.data && cur.data.lgas) || {};
let kept = 0;
for (const [key, e] of Object.entries(stored)) {
  const mine = LGAS[key] || (LGAS[key] = { name: e.name, state: e.state, months: {} });
  for (const [month, byType] of Object.entries(e.months || {})) {
    const m = mine.months[month] || (mine.months[month] = {});
    for (const t of ['h', 'u']) if (!m[t] && byType && byType[t]) { m[t] = byType[t]; kept++; }
  }
}
const allMonths = new Set(); let readings = 0, withHistory = 0;
for (const e of Object.values(LGAS)) { const ms = Object.keys(e.months); if (ms.length > 1) withHistory++; for (const m of ms) { allMonths.add(m); readings += Object.keys(e.months[m]).length; } }
const sorted = [...allMonths].sort();
console.log('result: ' + Object.keys(LGAS).length + ' councils (' + withHistory + ' with more than one month), ' + readings + ' readings, '
  + sorted[0] + ' -> ' + sorted[sorted.length - 1] + (kept ? '; ' + kept + ' stored readings kept that this run did not carry' : ''));
for (const probe of ['vic_yarra', 'vic_ballarat', 'qld_brisbane', 'nsw_central_coast']) {
  const e = LGAS[probe]; if (!e) continue;
  const last = Object.keys(e.months).sort().pop(), v = e.months[last];
  console.log('  ' + (e.name + ', ' + e.state).padEnd(22) + last + '  houses ' + (v.h ? v.h.vr + '% / $' + v.h.rent : '—') + '  units ' + (v.u ? v.u.vr + '% / $' + v.u.rent : '—') + '  (' + Object.keys(e.months).length + ' months)');
}

const payload = {
  note: 'Cotality CustomMT LGA export, every council: vacancy rate (1 month, PERCENT) and median asking rent (3 months, $/week), by month. Seeded by scripts/build-lga-vacancy-history.mjs; each new month is added by the Data Forge rent/vacancy upload. Read by the Data Extractor.',
  updated: new Date().toISOString(), from: sorted[0], to: sorted[sorted.length - 1], lgas: LGAS,
};
console.log('payload ' + Math.round(JSON.stringify(payload).length / 1024) + ' KB');
if (!WRITE) { console.log('dry run — nothing written. Re-run with --write to store it.'); }
else {
  const { error } = await sb.from('forge_cotality').upsert({ id: ROW_ID, data: payload, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) { console.error('write failed: ' + error.message); process.exitCode = 1; }
  else console.log('WRITTEN forge_cotality id=' + ROW_ID);
}
