// =============================================================================
// build-cl-capital-history.mjs — store the eight capitals' monthly home values
// for January 1980 to June 2018, which the Market cycles page joins to the
// Forge's own months (forge_cotality id `cl_capital_history`).
//
// WHY THIS EXISTS
// ---------------
// Saskia, 2026-11-17: the client presentation opens with two charts. One sets
// the 2026 fall in home values beside the biggest falls since 1980; the other
// shows which capital has grown fastest over time. Both need capital-city
// values back to 1980. The Forge holds them from July 2018 only
// (forge_cl_suburbs, level `capital`); the earlier months are in the one-off
// CoreLogic extract CSTDAT4294. This keeps the three numbers per capital,
// property type and month that the page needs.
//
// WHAT IT WRITES
// --------------
//   forge_cotality / cl_capital_history
//     data.from = '1980-01', data.to = '2018-06'  (462 months)
//     data.cities[<City>][H|U] = { avm: [...], n: [...], med12: [...] }
//   One array entry per month from `from`, null where the file has no figure
//   (it writes 0 for the months before a capital's valuations begin).
//     avm   = "Median AVM value of all dwellings": the median estimated value
//     n     = "# of dwellings with valid AVM": the weight of that leg
//     med12 = "Median sales price last 12 months"
//   "Greater Hobart" is filed as "Hobart".
//
// WHERE IT READS
// --------------
//   CSTDAT4294-CapitalCities_1980-2018.csv (3.6 MB) from the shared drive folder
//   "CoreLogic files / Historic", in ~/Downloads/corelogic-history
//   (--dir=<folder> to look elsewhere). Not in this repo.
//
// The history is closed (it ends June 2018), so this runs once.
//
//   node scripts/build-cl-capital-history.mjs            dry run (default)
//   node scripts/build-cl-capital-history.mjs --write    store it
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
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
const FILE = join(DIR, 'CSTDAT4294-CapitalCities_1980-2018.csv');
const ROW_ID = 'cl_capital_history';
const FROM = '1980-01', TO = '2018-06', N = 462;
const CITIES = ['Adelaide', 'Brisbane', 'Canberra', 'Darwin', 'Hobart', 'Melbourne', 'Perth', 'Sydney'];

const num = v => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : null; };
/* the file writes 0, not a blank, for a month before a capital's valuations begin */
const keep = v => (v == null || v <= 0 ? null : Math.round(v));
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
const idxOf = m => (+m.slice(0, 4) - 1980) * 12 + (+m.slice(5, 7) - 1);
const monthAt = i => (1980 + Math.floor(i / 12)) + '-' + String(i % 12 + 1).padStart(2, '0');

if (!existsSync(FILE)) { console.error('no file ' + FILE + ' — download it there first (see the header)'); process.exit(1); }
const lines = readFileSync(FILE, 'utf8').split(/\r?\n/).filter(Boolean);
const H = splitCsv(lines[0]).map(h => h.replace(/^﻿/, '').replace(/^"+|"+$/g, '').toLowerCase().replace(/\s+/g, ' ').trim());
const find = p => H.findIndex(h => h.startsWith(p));
const C = { city: find('capital city'), pt: find('property type'), mon: H.findIndex(h => h.includes('month end')), avm: find('median avm value'), n: find('# of dwellings with'), med12: find('median sales price last 12') };
if (Object.values(C).some(i => i < 0)) { console.error('header not recognised — stopped, nothing written: ' + JSON.stringify(C)); process.exit(1); }

const cities = {}; let rows = 0, skipped = 0;
for (const line of lines.slice(1)) {
  const r = splitCsv(line), pt = (r[C.pt] || '').trim().toUpperCase(), mon = (r[C.mon] || '').slice(0, 7);
  const city = /hobart/i.test(r[C.city]) ? 'Hobart' : (r[C.city] || '').trim();
  const i = /^\d{4}-\d{2}$/.test(mon) ? idxOf(mon) : -1;
  if (!CITIES.includes(city) || (pt !== 'H' && pt !== 'U') || i < 0 || i >= N) { skipped++; continue; }
  const byType = cities[city] || (cities[city] = {});
  const leg = byType[pt] || (byType[pt] = { avm: Array(N).fill(null), n: Array(N).fill(null), med12: Array(N).fill(null) });
  leg.avm[i] = keep(num(r[C.avm])); leg.n[i] = keep(num(r[C.n])); leg.med12[i] = keep(num(r[C.med12]));
  rows++;
}
console.log('read ' + rows + ' rows (' + skipped + ' skipped) for ' + Object.keys(cities).length + ' capitals, ' + FROM + ' to ' + TO);
const missing = CITIES.filter(c => !cities[c] || !cities[c].H || !cities[c].U);
if (missing.length) { console.error('no rows for: ' + missing.join(', ') + ' — stopped, nothing written'); process.exit(1); }
for (const c of CITIES) {
  for (const pt of ['H', 'U']) {
    const leg = cities[c][pt], first = k => { const i = leg[k].findIndex(v => v != null); return i < 0 ? 'never' : monthAt(i); };
    console.log('  ' + (c + ' ' + (pt === 'H' ? 'houses' : 'units')).padEnd(18) + 'estimated value from ' + first('avm') + ' (' + leg.avm.find(v => v != null) + ' then, ' + leg.avm[N - 1] + ' in June 2018); 12-month median from ' + first('med12'));
  }
}

const payload = {
  note: 'The eight capitals, houses and units, monthly January 1980 to June 2018: median estimated value (avm), the number of dwellings valued (n) and the 12-month median sale price (med12), from the CoreLogic CSTDAT4294 extract. Built once by scripts/build-cl-capital-history.mjs. Read by the Market cycles page, which joins it to forge_cl_suburbs (level capital) from July 2018.',
  updated: new Date().toISOString(), from: FROM, to: TO, cities,
};
console.log('payload ' + Math.round(JSON.stringify(payload).length / 1024) + ' KB');
if (!WRITE) { console.log('dry run — nothing written. Re-run with --write to store it.'); }
else {
  const { error } = await sb.from('forge_cotality').upsert({ id: ROW_ID, data: payload, file_name: 'CSTDAT4294-CapitalCities_1980-2018.csv', uploaded_by: 'build-cl-capital-history', updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) { console.error('write failed: ' + error.message); process.exitCode = 1; }
  else console.log('WRITTEN forge_cotality id=' + ROW_ID);
}
