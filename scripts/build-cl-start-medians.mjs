// =============================================================================
// build-cl-start-medians.mjs — store the FIRST 12-month median sale price on
// record for every suburb and council area, which the Data Extractor's
// "Long-term growth rate" is measured from (forge_cotality id `cl_start_medians`).
//
// WHY THIS EXISTS
// ---------------
// Van, 2026-11-17: an advisor asked for the Suburb Scoring "Fixed House LT CAGR"
// of two places the tool does not score (Tailem Bend SA 5260, Mount Barker SA
// 5251). That figure is the yearly compound growth from the EARLIEST median on
// record to now. The Forge holds suburb medians from July 2018 only
// (forge_cl_suburbs); the earlier months are in a one-off CoreLogic extract,
// CSTDAT4294, monthly from January 1980 to June 2018. Rather than add places to
// Suburb Scoring, the Extractor offers the rate for any suburb, so this keeps the
// one number per place it needs from that history: the first median and its month.
//
// WHAT IT WRITES
// --------------
//   forge_cotality / cl_start_medians
//     data.suburbs[<key>] = { h: ['YYYY-MM', price], u: ['YYYY-MM', price] }
//     data.lgas[<key>]    = { name, h: [...], u: [...] }
//   suburb key  = lgaKey(state, name_key)  ("SA", "MOUNT BARKER|5251" -> "sa_mount_barker_5251"),
//                 name_key being forge_cl_suburbs.name_key (NAME|postcode, NT postcodes without the leading zero)
//   council key = lgaKey(state, canonLga(council name)): the council's name without its
//                 "(DC)" / "(C)" / "(SA)" suffix, "The", "and", "Shire", "Regional" or "City", because Cotality
//                 has spelled the same council three ways since 2018 ("The Coorong (DC)", "The Coorong", "Coorong").
//   Plain keys, so the Extractor can ask PostgREST for just the places it needs.
//
// WHERE IT READS
// --------------
//   The 13 raw files from the shared drive folder "CoreLogic files / Historic":
//   CSTDAT4294-<STATE>Suburbs_<years>.csv (12 files) and CSTDAT4294-LGA_1980-2018.csv,
//   about 4.6 GB, in ~/Downloads/corelogic-history (--dir=<folder> to look elsewhere).
//   They are not in this repo and never will be. A state split over several year
//   files is read as one. Rows in the files are in no useful order, so every row is read.
//
// The history is closed (it ends June 2018), so this runs once; the row never needs a monthly update.
//
//   node scripts/build-cl-start-medians.mjs            dry run (default)
//   node scripts/build-cl-start-medians.mjs --write    store it
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
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
const DIR = (process.argv.find(a => a.startsWith('--dir=')) || '').slice(6) || join(homedir(), 'Downloads', 'corelogic-history');
const ROW_ID = 'cl_start_medians';

/* The same two rules the Data Extractor uses — keep them in step with tools/data-extractor.html. */
const lgaKey = (st, name) => (String(st || '') + '_' + String(name || '')).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const canonLga = n => String(n || '').toUpperCase().replace(/\s*\([^)]*\)/g, ' ').replace(/&/g, ' ').replace(/[^A-Z0-9]+/g, ' ')
  .replace(/\b(THE|AND)\b/g, ' ').replace(/\s+/g, ' ').trim().replace(/ (SHIRE|REGIONAL|CITY)$/, '');

const EXPECTED = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'];
const num = v => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : null; };
const splitCsv = line => {
  if (line.indexOf('"') < 0) return line.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
};
/* "1993-06-30 0:00:00", "1995-03-31", or day/month/year: a month-end date, so the number above 12 is the day */
const monthOf = v => {
  const s = String(v || '').trim(); let m = s.match(/^(\d{4})-(\d{2})/); if (m) return m[1] + '-' + m[2];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? m[3] + '-' + String(+m[1] > 12 ? +m[2] : +m[1]).padStart(2, '0') : null;
};

// ── 1. read the history: the earliest month with a median, per place and type ──
if (!existsSync(DIR)) { console.error('no folder ' + DIR + ' — download the CSTDAT4294 files there first (see the header)'); process.exit(1); }
const files = readdirSync(DIR).filter(f => /^CSTDAT4294-.*\.csv$/i.test(f) && !/CapitalCities/i.test(f)).sort();
const seenStates = new Set(files.map(f => (f.match(/^CSTDAT4294-([A-Z]+)Suburbs/i) || [])[1]).filter(Boolean).map(s => s.toUpperCase()));
const lacking = EXPECTED.filter(s => !seenStates.has(s)).concat(files.some(f => /LGA/i.test(f)) ? [] : ['the council file']);
if (lacking.length) { console.error('missing from ' + DIR + ': ' + lacking.join(', ') + ' — stopped, nothing written'); process.exit(1); }

const first = new Map();          // key -> { level, st, name, pc, lga, pt, mon, med, rows }
let total = 0, unreadable = 0;
for (const f of files) {
  const rl = createInterface({ input: createReadStream(join(DIR, f), { encoding: 'utf8' }), crlfDelay: Infinity });
  let map = null, n = 0;
  for await (const line of rl) {
    if (!line) continue;
    const r = splitCsv(line);
    if (!map) {
      const H = r.map(h => h.replace(/^﻿/, '').replace(/^"+|"+$/g, '').toLowerCase().replace(/\s+/g, ' ').trim());
      const find = p => H.findIndex(h => h.startsWith(p));
      map = { state: find('state'), lga: find('lga name'), pc: find('post'), sub: find('suburb'), pt: find('property type'), mon: H.findIndex(h => h.includes('month end')), med: find('median sales price last 12') };
      if (map.state < 0 || map.lga < 0 || map.pt < 0 || map.mon < 0 || map.med < 0) { console.error(f + ': header not recognised — stopped, nothing written'); process.exit(1); }
      continue;
    }
    const pt = (r[map.pt] || '').trim().toUpperCase(); if (pt !== 'H' && pt !== 'U') continue;
    n++;
    const mon = monthOf(r[map.mon]); if (!mon) { unreadable++; continue; }
    const st = (r[map.state] || '').trim().toUpperCase(), lga = (r[map.lga] || '').trim(), isSub = map.sub >= 0;
    const name = isSub ? (r[map.sub] || '').trim().toUpperCase() : lga, pc = isSub ? (r[map.pc] || '').trim() : '';
    if (!st || !name) continue;
    const k = (isSub ? 's|' : 'l|') + st + '|' + name + '|' + pc + '|' + pt;
    let e = first.get(k); if (!e) { e = { level: isSub ? 'suburb' : 'lga', st, name, pc, lga, pt, mon: null, med: null, rows: 0 }; first.set(k, e); }
    e.rows++;
    const med = num(r[map.med]);
    if (med != null && med > 0 && (e.mon == null || mon < e.mon)) { e.mon = mon; e.med = med; }
  }
  total += n; console.log(f.padEnd(40) + String(n).padStart(9) + ' rows');
}
console.log('read ' + total + ' rows, ' + first.size + ' place-and-type series' + (unreadable ? '; ' + unreadable + ' rows with an unreadable month skipped' : ''));

// ── 2. shape it ───────────────────────────────────────────────────────────────
const SUBS = {}, LGAS = {}; let clashes = 0;
for (const e of first.values()) {
  if (e.mon == null) continue;                              // never had enough sales for a median
  const t = e.pt === 'H' ? 'h' : 'u';
  if (e.level === 'suburb') {
    const o = SUBS[lgaKey(e.st, e.name + '|' + e.pc)] || (SUBS[lgaKey(e.st, e.name + '|' + e.pc)] = {});
    if (o[t] && o[t][0] <= e.mon) { clashes++; continue; }  // two spellings on one key: the longer history stands
    o[t] = [e.mon, e.med];
  } else {
    const key = lgaKey(e.st, canonLga(e.name)), o = LGAS[key] || (LGAS[key] = { name: e.name });
    if (o[t] && o[t][0] <= e.mon) { clashes++; continue; }
    o[t] = [e.mon, e.med];
  }
}
const firstYears = {}; for (const o of Object.values(SUBS)) for (const t of ['h', 'u']) if (o[t]) { const y = o[t][0].slice(0, 4); firstYears[y] = (firstYears[y] || 0) + 1; }
console.log('result: ' + Object.keys(SUBS).length + ' suburbs and ' + Object.keys(LGAS).length + ' council areas with a first median' + (clashes ? '; ' + clashes + ' duplicate spellings folded' : ''));
console.log('  first-median years (suburb series): ' + Object.keys(firstYears).sort().map(y => y + ' ' + firstYears[y]).join(' · '));
for (const [probe, isL] of [['sa_mount_barker_5251', 0], ['vic_richmond_3121', 0], ['nsw_parramatta_2150', 0], ['sa_coorong', 1], ['sa_mount_barker', 1], ['vic_yarra', 1]]) {
  const e = (isL ? LGAS : SUBS)[probe];
  console.log('  ' + probe.padEnd(24) + (e ? 'houses ' + (e.h ? e.h[0] + ' $' + e.h[1] : '—') + '   units ' + (e.u ? e.u[0] + ' $' + e.u[1] : '—') : 'NOT FOUND'));
}

// ── 3. how many of today's places does it cover? ─────────────────────────────
const { data: latest, error: lErr } = await sb.from('forge_cl_suburbs').select('month').order('month', { ascending: false }).limit(1);
if (lErr || !latest || !latest.length) { console.error('could not read the latest month: ' + (lErr ? lErr.message : 'no rows')); process.exit(1); }
const MONTH = latest[0].month, places = new Map();
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from('forge_cl_suburbs').select('state,name_key,lga').eq('level', 'suburb').eq('month', MONTH).order('state').order('name_key').order('ptype').range(from, from + 999);
  if (error) { console.error('could not read the suburbs of ' + MONTH + ': ' + error.message); process.exit(1); }
  for (const r of data || []) places.set(r.state + '|' + r.name_key, r);
  if (!data || data.length < 1000) break;
}
let sHit = 0, lHit = 0, lAsked = 0; const councils = new Map(), noCouncil = [];
for (const r of places.values()) {
  if (SUBS[lgaKey(r.state, r.name_key)]) sHit++;
  if (r.lga) councils.set(lgaKey(r.state, canonLga(r.lga)), r.state + ' ' + r.lga);
}
for (const [k, label] of councils) { lAsked++; if (LGAS[k]) lHit++; else noCouncil.push(label); }
console.log('coverage of ' + MONTH + ': ' + sHit + ' of ' + places.size + ' suburbs have their own first median; ' + lHit + ' of ' + lAsked + ' council areas have one');
if (noCouncil.length) console.log('  council areas with no history under that name (' + noCouncil.length + '): ' + noCouncil.sort().slice(0, 40).join('; ') + (noCouncil.length > 40 ? ' …' : ''));

const payload = {
  note: 'First 12-month median sale price on record (month, dollars) for every suburb and council area, from the CoreLogic CSTDAT4294 extract, January 1980 to June 2018. Built once by scripts/build-cl-start-medians.mjs. Read by the Data Extractor for the long-term growth rate.',
  updated: new Date().toISOString(), from: '1980-01', to: '2018-06', suburbs: SUBS, lgas: LGAS,
};
console.log('payload ' + Math.round(JSON.stringify(payload).length / 1024) + ' KB');
if (!WRITE) { console.log('dry run — nothing written. Re-run with --write to store it.'); }
else {
  const { error } = await sb.from('forge_cotality').upsert({ id: ROW_ID, data: payload, file_name: 'CSTDAT4294 history 1980-2018', uploaded_by: 'build-cl-start-medians', updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) { console.error('write failed: ' + error.message); process.exitCode = 1; }
  else console.log('WRITTEN forge_cotality id=' + ROW_ID);
}
