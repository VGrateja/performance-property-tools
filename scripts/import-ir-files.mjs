// =============================================================================
// import-ir-files.mjs — load Investment Report source files into the IR Builder
// (public.ir_files) and publish them to the IR Library (investment_reports),
// exactly the way the Builder's "Publish as example IR" step does.
//
// WHAT IT READS (a folder, e.g. Downloads/Investment Reports)
//   • Property Master File - <Suburb>_<Street>_<No>_<Unit>.xlsx — the 30-tab
//     residential master workbook the Builder was modelled on. Read BY LABEL,
//     never by cell address: the tabs are numbered differently across template
//     versions ("5i"/"5j"/"Copy of 5j - Price Analysis") and rows shift with
//     the number of comparables.
//   • Example Commercial Property Investment Report - <address>.pdf — three
//     sub-templates (Darwin unit block / Melbourne unit block with two
//     cashflows / industrial-medical with a lease summary). Text via pdf.js in
//     headless Chrome (no poppler on this machine); photos via the page's
//     image XObjects, the cover photo = the largest DRAWN image on page 1.
//   • Wholesale Investment Report <budget> <type>.pdf — the wholesale
//     residential template (cover, DD report, IO + normalised cashflows,
//     comparable sales). Mostly redacted addresses.
//   • Research & Case Study Links - Example IRs - 2026.csv — the register the
//     library was seeded from: market, LGA, SOLD MONTH, strategy, budget
//     (= the IR's top price, NOT the price paid), master-file link, notes.
//     Used for the publish step (sold_date / link / notes / market) and to
//     match each file to its existing library row.
//
// WHAT IT WRITES (only with --write; --publish adds the publish step)
//   ir_files: one row per property with setup / dd / inspection / grading /
//   pricing / cashflow / roles / suburb_stats in the Builder's own shapes (the
//   three rows Van entered by hand — Rosewood, Kearney, Aralia — were the
//   reference). Photos go to the ir-evidence bucket under <id>/photos/.
//   Publish mirrors doPublish() in ir-builder.html: find the library row by
//   address (+ suburb), update in place without blanking existing values,
//   else insert; upload the source PDF (PDF-based files only) to ir-library;
//   stamp compliance.published {at, libraryId, sold_date, price_paid, pdf};
//   flip status to 'final'.
//
//   PRICE PAID IS NOT IN ANY OF THESE FILES (they are pre-purchase documents),
//   so compliance.published.price_paid is written as null: the Presentation
//   slide shows "—" and its picker says "no purchase price yet" until the
//   figures arrive (Van 2026-08-27: "get what we can for now").
//
// SUBURB INTELLIGENCE mirrors fetchIntel()/intelAutoMap() in ir-builder.html:
//   suburb_scores (<market>-<h|u>) + forge_cl_suburbs (latest month) →
//   suburb_stats snapshot + pricing.suburb prefill (workbook values win),
//   grading.suburbRating fallback, setup.lga fallback.
//
// USAGE
//   node scripts/import-ir-files.mjs "<folder>"                # dry run: parse + preview
//   node scripts/import-ir-files.mjs "<folder>" --write        # upsert ir_files + photos
//   node scripts/import-ir-files.mjs "<folder>" --write --publish
//   options: --only=<substring of file name>   --refresh (re-import files whose
//   address already has an ir_files row; default skips them)   --no-photos
//   Preview of everything parsed: scratch/_ir-import-preview.json
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const ARGS = process.argv.slice(2);
const FOLDER = ARGS.find(a => !a.startsWith('--'));
const WRITE = ARGS.includes('--write'), PUBLISH = ARGS.includes('--publish'), REFRESH = ARGS.includes('--refresh'), NO_PHOTOS = ARGS.includes('--no-photos');
const ONLY = (ARGS.find(a => a.startsWith('--only=')) || '').split('=').slice(1).join('=') || null;
if (!FOLDER || !existsSync(FOLDER)) { console.error('usage: node scripts/import-ir-files.mjs "<folder>" [--write] [--publish] [--only=<name part>] [--refresh] [--no-photos]'); process.exit(1); }
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co', KEY, { auth: { persistSession: false } });
mkdirSync('scratch', { recursive: true });

// ── small helpers ─────────────────────────────────────────────────────────────
const num = v => { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; const s = String(v).replace(/,/g, ''); const m = s.match(/-?\$?\s*(-?\d+(?:\.\d+)?)/); if (!m) return null; const n = parseFloat(m[1]); return isFinite(n) ? (s.trim().startsWith('-$') ? -Math.abs(n) : n) : null; };
const pct = v => { const n = num(v); return n == null ? null : (String(v).includes('%') || n > 1.5 ? n / 100 : n); };
/* yields/CAGRs typed as 7.3 (meaning 7.3%) in some workbooks, 0.073 in others */
const frac = v => { const n = num(v); return n == null ? null : (Math.abs(n) > 1 ? n / 100 : n); };
const moneyStr = v => v == null ? null : (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-AU') : String(v)) : clean(v));
const money0 = n => n == null ? null : Math.round(n);
const clean = s => s == null ? null : String(s).replace(/\s+/g, ' ').trim() || null;
const excelDate = serial => { if (serial == null || serial === '' || serial === '-') return null; if (typeof serial === 'string') return clean(serial); const d = new Date(Math.round((serial - 25569) * 86400 * 1000)); if (isNaN(d)) return null; return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear(); };
const excelISO = serial => { if (typeof serial !== 'number') return null; const d = new Date(Math.round((serial - 25569) * 86400 * 1000)); return isNaN(d) ? null : d.toISOString().slice(0, 10); };
const GRADES = ['Poor', 'Below Average', 'Average', 'Above Average', 'Excellent'];
const STREET_TYPES = 'street|st|road|rd|crescent|cres|court|ct|drive|dr|avenue|ave|circuit|cct|place|pl|terrace|tce|boulevard|bvd|blvd|way|grove|rise|parade|pde|lane|highway|hwy|close|cl|esplanade|esp|square|sq|walk|mews|track|trk|promenade|prom';
const ABBR = { st: 'street', rd: 'road', cres: 'crescent', ct: 'court', dr: 'drive', ave: 'avenue', av: 'avenue', cct: 'circuit', pl: 'place', tce: 'terrace', bvd: 'boulevard', blvd: 'boulevard', pde: 'parade', hwy: 'highway', cl: 'close', esp: 'esplanade', sq: 'square' };
const STATE_RE = /\b(NT|VIC|Vic|Victoria|QLD|Qld|Queensland|WA|SA|NSW|TAS|Tas|ACT)\b[\s,.]*(\d{4})?\s*\.?\s*$/;
const STATE_OF = { vic: 'VIC', victoria: 'VIC', qld: 'QLD', queensland: 'QLD', nt: 'NT', wa: 'WA', sa: 'SA', nsw: 'NSW', tas: 'TAS', act: 'ACT' };

/* "5/37 Rosewood Cres, Leanyer, NT 0812" / "3 Hare Street Moil NT 0810" /
   "9/12 Irving Street, Malvern , Victoria, 3144" → parts */
function parseAddress(full) {
  if (!full) return null;
  let s = clean(full).replace(/\s+,/g, ',').replace(/,+/g, ',');
  let state = null, postcode = null;
  const m = s.match(STATE_RE);
  if (m) { state = STATE_OF[m[1].toLowerCase()] || m[1].toUpperCase(); postcode = m[2] || null; s = s.slice(0, m.index).replace(/[\s,]+$/, ''); }
  if (!postcode) { const pm = s.match(/\b(\d{4})\s*$/); if (pm) { postcode = pm[1]; s = s.slice(0, pm.index).replace(/[\s,]+$/, ''); } }
  let street, suburb;
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) { street = parts[0]; suburb = parts[parts.length - 1]; }
  else {
    const re = new RegExp('^(.*?\\b(?:' + STREET_TYPES + ')\\b\\.?)\\s+(.+)$', 'i');
    const mm = s.match(re); if (mm) { street = mm[1]; suburb = mm[2]; } else { street = s; suburb = null; }
  }
  if (!state && postcode) state = postcode[0] === '0' ? 'NT' : postcode[0] === '3' ? 'VIC' : postcode[0] === '4' ? 'QLD' : postcode[0] === '5' ? 'SA' : postcode[0] === '6' ? 'WA' : postcode[0] === '7' ? 'TAS' : (postcode[0] === '2' || postcode[0] === '1') ? 'NSW' : null;
  return { street: clean(street), suburb: clean(suburb), state, postcode, full: [clean(street), clean(suburb), [state, postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ') };
}
/* comparison key: unit/number + first street word, suburb-insensitive of punctuation */
function addrKey(street, suburb) {
  const t = String(street || '').toLowerCase().replace(/[^\w\s\/-]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).map(w => ABBR[w] || w);
  const numTok = (t.find(w => /^\d/.test(w)) || '').replace(/^(\d+\/)?(\d+)-\d+.*$/, '$1$2');   // "5/5-6" → "5/5", "228-232" → "228"
  const nameTok = t.find(w => /^[a-z]/.test(w) && !/^(unit|lot|a|b|&)$/.test(w)) || '';
  return (numTok + ' ' + nameTok + ' ' + String(suburb || '').toLowerCase().split(/[\s,]+/)[0]).trim();
}
function inferMarket(state, postcode) {
  const pc = +postcode || 0;
  if (state === 'NT' || (pc >= 800 && pc <= 899)) return 'Darwin';
  if (state === 'WA') return 'Perth';
  if (state === 'SA') return 'Adelaide';
  if (state === 'QLD') { if (pc >= 4810 && pc <= 4818) return 'Townsville'; if (pc >= 4550 && pc <= 4575) return 'Sunshine Coast'; if (pc === 4680) return 'Gladstone'; if (pc >= 4700 && pc <= 4702) return 'Rockhampton'; if (pc === 4740) return 'Mackay'; if (pc >= 4305 && pc <= 4306) return 'Ipswich'; if (pc >= 4350 && pc <= 4352) return 'Toowoomba'; if (pc >= 4207 && pc <= 4230) return 'Gold Coast'; return 'Brisbane'; }
  if (state === 'VIC') { if (pc >= 3350 && pc <= 3357) return 'Ballarat'; if (pc >= 3550 && pc <= 3556) return 'Bendigo'; if (pc >= 3211 && pc <= 3227) return 'Geelong'; if (pc === 3500) return 'Mildura'; if (pc === 3690) return 'Wodonga'; return 'Melbourne'; }
  if (state === 'NSW') { if (pc >= 2000 && pc <= 2249) return 'Sydney'; if (pc >= 2250 && pc <= 2263) return 'Central Coast'; if (pc >= 2280 && pc <= 2310) return 'Newcastle'; if (pc >= 2500 && pc <= 2530) return 'Wollongong'; return 'Sydney'; }
  if (state === 'TAS') return pc >= 7248 && pc <= 7325 ? 'Launceston' : 'Hobart';
  if (state === 'ACT') return 'Canberra';
  return null;
}
const segmentOf = (propertyType, csvType) => {
  const t = String(csvType || propertyType || '').toLowerCase();
  if (/unit block|block of|units/.test(t)) return 'unit_block';
  if (/industrial|warehouse/.test(t)) return 'industrial';
  if (/medical|ppob/.test(t)) return 'medical';
  if (/office/.test(t)) return 'office';
  if (/retail|shop/.test(t)) return 'retail';
  if (/townhouse|villa/.test(t)) return 'villa_townhouse';
  if (/house/.test(t)) return 'house';
  if (/unit|apartment|flat/.test(t)) return 'unit';
  return 'other';
};
const strategyOf = (s, csv) => { const t = String(csv || s || '').toLowerCase(); if (!t) return null; if (/trading/.test(t)) return 'trading'; if (/foundation|passive|long.?term/.test(t)) return 'foundation'; return null; };

// ── the CSV register ──────────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) { const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch; }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function loadRegister(folder) {
  const f = readdirSync(folder).find(x => /research.*case study.*\.csv$/i.test(x)); if (!f) return { rows: [], byKey: new Map() };
  const rows = parseCsv(readFileSync(join(folder, f), 'utf8').replace(/^﻿/, ''));
  const out = []; let section = null;
  for (const r of rows.slice(1)) {
    const [market, lga, sold, strategy, budget, address, link] = r.map(c => clean(c) || null);
    if (market && !lga && !sold && !strategy && !budget && !address) { section = market; continue; }   // "Melbourne - Unit" header
    if (!address && !link) continue;
    if (address && /^No up to date examples/i.test(address)) continue;   // placeholder rows ("Email Ben Hall")
    let soldISO = null; if (sold && sold !== 'NA') { let m = sold.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) soldISO = m[3] + '-' + m[2].padStart(2, '0') + '-01'; else { const d = new Date(sold + ' 1'); if (!isNaN(d)) soldISO = d.toISOString().slice(0, 7) + '-01'; else { const d2 = new Date(sold); if (!isNaN(d2)) soldISO = d2.toISOString().slice(0, 7) + '-01'; } } }
    const commercialType = section && /commercial/i.test(section) ? market : null;   // in the Commercial block col A is the asset type
    const marketLabel = commercialType ? lga : market;                                // …and col B the market
    const rec = { section, market: commercialType ? marketLabel : market, lga: commercialType ? null : (lga && lga !== 'NA' ? lga : null), soldISO, strategy, budget: num(budget), address, addr: address ? parseAddress(address) : null, link: link && /^https?:/.test(link) ? link : null, notes: link && !/^https?:/.test(link) ? link : null, commercialType };
    rec.key = rec.addr ? addrKey(rec.addr.street, rec.addr.suburb) : null;
    out.push(rec);
  }
  const byKey = new Map(); for (const r of out) if (r.key) byKey.set(r.key, r);
  return { rows: out, byKey };
}

// ── residential master workbook ───────────────────────────────────────────────
const rowsOf = (wb, re, exclude) => { const n = wb.SheetNames.find(s => re.test(s) && !(exclude && exclude.test(s))); return n ? { name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }) } : null; };
const cellStr = v => v == null ? null : clean(String(v));
const rightOf = (row, c) => { if (!row) return null; for (let j = c + 1; j < row.length; j++) if (row[j] != null && row[j] !== '') return row[j]; return null; };
const findRow = (rows, re, col = 0, from = 0) => { for (let r = from; r < rows.length; r++) { const v = rows[r] && rows[r][col]; if (typeof v === 'string' && re.test(v.trim())) return r; } return -1; };
const findCell = (rows, re) => { for (let r = 0; r < rows.length; r++) { const row = rows[r]; if (!row) continue; for (let c = 0; c < row.length; c++) if (typeof row[c] === 'string' && re.test(row[c].trim())) return { r, c }; } return null; };
const labelValue = (rows, re) => { const p = findCell(rows, re); if (!p) return null; return rightOf(rows[p.r], p.c); };

function parseResidentialXlsx(file) {
  const wb = XLSX.readFile(file, { bookFiles: true });
  const warn = [];
  const cover = rowsOf(wb, /coversheet/i), dd = rowsOf(wb, /preliminary dd/i), insp = rowsOf(wb, /mobile inspection/i), grad = rowsOf(wb, /ir grading$/i), price = rowsOf(wb, /price analysis/i), comp = rowsOf(wb, /file compliance/i);
  const cash = rowsOf(wb, /^5e - IR Cashflow$/i) || rowsOf(wb, /IR Cashflow/i, /IO|IC|Copy/i) || rowsOf(wb, /cashflow/i, /IO|calcs/i);
  const out = { kind: 'residential', file: basename(file), warn };
  // address: coversheet block or DD tab
  let addrStr = null;
  if (cover) { for (let r = 38; r < Math.min(cover.rows.length, 50); r++) { const v = cellStr(cover.rows[r] && cover.rows[r][0]); if (v && /\d/.test(v) && STATE_RE.test(v)) { addrStr = v; break; } } }
  if (!addrStr && dd) { const r = findRow(dd.rows, /^ADDRESS$/i); if (r >= 0) addrStr = cellStr(dd.rows[r + 1] && dd.rows[r + 1][0]); }
  if (!addrStr && price) addrStr = cellStr(price.rows[0] && price.rows[0][0]);
  out.addr = parseAddress(addrStr); if (!out.addr || !out.addr.street) warn.push('no address found');
  if (cover) {
    const pr = findRow(cover.rows, /^Prepared/i, 4) >= 0 ? cover.rows[findRow(cover.rows, /^Prepared/i, 4)] : (findCell(cover.rows, /^Prepared/i) ? cover.rows[findCell(cover.rows, /^Prepared/i).r] : null);
    if (pr) { const serial = pr.find(v => typeof v === 'number' && v > 40000 && v < 60000); out.preparedISO = excelISO(serial); const by = pr.find(v => typeof v === 'string' && /^by\s+/i.test(v.trim())); out.preparedBy = by ? clean(by.replace(/^by\s+/i, '')) : null; }
    out.strategy = cellStr(labelValue(cover.rows, /^Property Strategy:?$/i));
    out.propertyGrade = cellStr(labelValue(cover.rows, /^Property Grade:?$/i));
    out.suburbRating = cellStr(labelValue(cover.rows, /^Suburb Rating:?$/i));
    for (const row of cover.rows) for (const v of (row || [])) if (typeof v === 'string') {
      const m = v.match(/(\d+(?:\.\d)?)\s*Bedroom\s*\|\s*(\d+(?:\.\d)?)\s*Bathroom\s*\|\s*(\d+(?:\.\d)?)\s*Living\s*\|\s*(\d+(?:\.\d)?)\s*Cars?/i); if (m) { out.beds = +m[1]; out.baths = +m[2]; out.living = +m[3]; out.cars = +m[4]; }
      const l = v.match(/Land Size:\s*([\d,.]+)?\s*(floor size)?/i); if (l) { out.landSize = l[1] ? num(l[1]) : null; if (l[2]) out.landNote = 'floor size'; }
    }
  }
  // DD tab: roles, region/state, items
  out.roles = {}; out.dd = {};
  if (dd) {
    const hr = findRow(dd.rows, /^ADDRESS$/i); if (hr >= 0) { const hdr = dd.rows[hr], val = dd.rows[hr + 1] || []; hdr.forEach((h, c) => { if (typeof h !== 'string') return; const v = cellStr(val[c]); if (/CONSULTANT/i.test(h)) out.roles.consultant = v; else if (/DD SUPPORT/i.test(h)) out.roles.dd_support = v; else if (/SALES ADMIN/i.test(h)) out.roles.sales_admin = v; }); }
    const rr = findRow(dd.rows, /^Region$/i); if (rr >= 0) { out.ddRegion = cellStr(rightOf(dd.rows[rr], 0)); const sc = dd.rows[rr].findIndex(v => typeof v === 'string' && /^State$/i.test(v.trim())); if (sc >= 0) out.ddState = cellStr(rightOf(dd.rows[rr], sc)); const rc = dd.rows[rr].findIndex(v => typeof v === 'string' && /^Rating$/i.test(v.trim())); if (rc >= 0) out.ddResult = cellStr(rightOf(dd.rows[rr], rc)); }
    for (let r = 0; r < dd.rows.length; r++) { const a = cellStr(dd.rows[r] && dd.rows[r][0]); if (!a || !/^\d+\.\d\d\s+\S/.test(a)) continue; const rc = dd.rows[r].findIndex(v => typeof v === 'string' && /^Rating$/i.test(v.trim())); const rating = cellStr(rc >= 0 ? rightOf(dd.rows[r], rc) : null); const notesRow = dd.rows[r + 1] || [], srcRow = dd.rows[r + 2] || []; const notes = /^Notes$/i.test(String(notesRow[0] || '')) ? cellStr(rightOf(notesRow, 0)) : null; out.dd[a] = { rating, notes: notes || null }; if (/^Source$/i.test(String(srcRow[0] || ''))) { const src = cellStr(rightOf(srcRow, 0)); if (src && src !== '#N/A' && src !== 'n/a') out.dd[a].source = src; } }
  }
  // grading
  out.grading = {};
  if (grad) { for (const row of grad.rows) { const a = cellStr(row && row[0]), b = row && row[1]; if (!a) continue; if (/^Property Strategy:?$/i.test(a)) { out.gradStrategy = cellStr(rightOf(row, 0)); continue; } if (/^Property Grade:?$/i.test(a)) { out.gradPropertyGrade = cellStr(rightOf(row, 0)); continue; } if (/^Suburb Rating:?$/i.test(a)) { out.gradSuburbRating = cellStr(rightOf(row, 0)); continue; } const g = cellStr(b); if (g && (GRADES.includes(g) || /^(Property Type|Title Type)$/i.test(a))) out.grading[a] = g; } }
  // cashflow
  out.cashflow = {}; out.cashflowMeta = {};
  if (cash) {
    const F = row => { for (let j = row.length - 1; j >= 1; j--) if (typeof row[j] === 'number') return row[j]; return null; };
    const MAP = [[/^Top Budget/i, 'budget'], [/^Maintenance Allowance/i, 'maintenanceAllowance'], [/^Minimum Rental Standards/i, 'minRentalStdCost'], [/^Cosmetic Works/i, 'cosmeticWorks'], [/^Stamp Duty/i, 'stampDuty'], [/^Engagement Fee/i, 'engagementFee'], [/^Acquisition Fee/i, 'acquisitionFee'], [/Title Transfer/i, 'titleTransfer'], [/^Conveyancing/i, 'conveyancing'], [/Building and Pest/i, 'buildingPest'], [/^Depreciation Schedule/i, 'depreciationSchedule'], [/^Professional Clean/i, 'professionalClean'], [/^Strata Fees/i, 'strata'], [/^Council and Water/i, 'councilWater'], [/^Land Tax/i, 'landTax'], [/^Insurance/i, 'insurance']];
    for (const row of cash.rows) { const a = cellStr(row && row[0]); if (!a) continue;
      const m = MAP.find(([re]) => re.test(a)); if (m) { const v = F(row); if (v != null) out.cashflow[m[1]] = v; continue; }
      const nums = row.map((v, i) => typeof v === 'number' ? { i, v } : null).filter(Boolean);
      if (/^Finance - Interest/i.test(a)) { if (nums[0]) out.cashflow.lvr = nums[0].v; if (nums[1]) out.cashflow.rate = nums[1].v; }
      else if (/^Finance - Principal/i.test(a)) { if (nums[0]) out.cashflow.loanTermYears = nums[0].v; }
      else if (/^Letting Fee/i.test(a)) { if (nums[0]) out.cashflow.lettingFeeWeeks = nums[0].v; }
      else if (/^Property Management Fee/i.test(a)) { const p = nums.find(n => n.v < 1); if (p) out.cashflow.pmFeePct = p.v; }
      else if (/^Repairs & Maintenance/i.test(a)) { const p = nums.find(n => n.v < 1); if (p) out.cashflow.repairsPctOfRent = p.v; }
      else if (/^Rent$/i.test(a)) { const v = F(row); if (v != null) out.cashflow.rent = v; const w = nums.find(n => n.v === 52 || (n.v >= 40 && n.v <= 52)); out.cashflow.weeksLet = w ? w.v : 52; }
      else if (/^Gross Yield/i.test(a)) out.cashflowMeta.grossYield = F(row);
      else if (/^Net Yield/i.test(a)) out.cashflowMeta.netYield = F(row);
      else if (/^Loan Amount/i.test(a)) out.cashflowMeta.loanAmount = F(row);
    }
    if (out.cashflow.weeksLet == null) out.cashflow.weeksLet = 52;
  } else warn.push('no cashflow tab');
  // price analysis
  out.pricing = { adopted: {}, history: [], streetSales: [], compSales: [], compRents: [], suburb: {} };
  if (price) {
    const P = price.rows;
    const roleHdr = findRow(P, /^ADDRESS$/i); if (roleHdr >= 0) { const hdr = P[roleHdr], val = P[roleHdr + 1] || []; hdr.forEach((h, c) => { if (typeof h !== 'string') return; const v = cellStr(val[c]); if (!v) return; if (/ADVISOR/i.test(h)) out.roles.consultant = out.roles.consultant || v; else if (/ASSISTANT/i.test(h)) out.roles.assistant = v; else if (/SALES ADMIN/i.test(h)) out.roles.sales_admin = out.roles.sales_admin || v; }); }
    const subj = (re) => { const r = findRow(P, re); return r >= 0 ? P[r][1] : null; };
    out.listingUrl = cellStr(subj(/^Link$/i)); if (out.listingUrl && !/^https?:/.test(out.listingUrl)) out.listingUrl = null;
    out.beds = out.beds ?? num(subj(/^Bedrooms$/i)); out.baths = out.baths ?? num(subj(/^Bathrooms$/i)); out.cars = out.cars ?? num(subj(/^Car Parks$/i));
    if (out.landSize == null) { const ls = subj(/^Land Size/i); if (ls != null) { out.landSize = num(ls); if (/floor/i.test(String(ls))) out.landNote = 'floor size'; } }
    const sy = frac(subj(/^Suburb Yield$/i)); if (sy != null && sy > 0) out.pricing.suburb.suburbYield = sy;
    const c3 = frac(subj(/^Suburb 3-YR CAGR/i)), c5 = frac(subj(/^Suburb 5-YR CAGR/i)), c7 = frac(subj(/^Suburb 7-YR CAGR/i)), lt = frac(subj(/^Suburb LT CAGR/i));
    if (c3 != null && c3 > -1) out.pricing.suburb.cagr3 = c3; if (c5 != null && c5 > -1) out.pricing.suburb.cagr5 = c5; if (c7 != null && c7 > -1) out.pricing.suburb.cagr7 = c7; if (lt != null && lt > -1) out.pricing.suburb.ltCagr = lt;
    const pg = cellStr(subj(/^Property Grade$/i)), sg = cellStr(subj(/^Suburb Grade$/i)); if (pg) out.pricePropertyGrade = pg; if (sg) out.priceSuburbGrade = sg;
    // sale history: rows labelled in some column with date+price to the right
    for (const row of P) { for (let c = 0; c < row.length; c++) { const v = cellStr(row[c]); if (v && /^(First|Second|Third|Fourth) Time Sold$|^Most Recent Sale$/i.test(v)) { const d = row[c + 1], p = row[c + 2]; if (typeof d === 'number' && typeof p === 'number' && p > 0) out.pricing.history.push({ event: v, date: excelDate(d), price: p }); break; } } }
    // recent street sales (header row with Address … Sold Price … Sold Date)
    const sh = findCell(P, /^Recent Street Sales$/i);
    if (sh) { const hdr = P[sh.r + 1] || []; const ci = name => hdr.findIndex(v => typeof v === 'string' && new RegExp('^' + name + '$', 'i').test(v.trim()));
      const cA = ci('Address'), cB = ci('Bedrooms'), cT = ci('Bathrooms'), cC = ci('Car Parks'), cL = ci('Land Size \\(m2\\)'), cP = ci('Sold Price'), cD = ci('Sold Date');
      for (let r = sh.r + 2; r < P.length; r++) { const row = P[r] || []; const a = cellStr(row[cA]); if (!a || /^(Comparable|N\/A)/i.test(a)) { if (!a && (P[r + 1] || [])[0] && /Comparable Sale/i.test(String((P[r + 1] || [])[0]))) break; if (a == null) { if (cellStr((P[r + 1] || [])[cA]) == null) break; else continue; } continue; } if (!/\d/.test(a)) continue;
        out.pricing.streetSales.push({ address: a, beds: num(row[cB]), baths: num(row[cT]), cars: num(row[cC]), land: num(row[cL]), price: num(row[cP]), date: excelDate(row[cD]) }); } }
    // comparable sales
    const ch = findCell(P, /^Comparable Sale Analysis$/i);
    if (ch) { const hdr = P[ch.r + 1] || []; const ci = name => hdr.findIndex(v => typeof v === 'string' && new RegExp('^' + name + '$', 'i').test(v.trim()));
      const cA = ci('Address'), cK = ci('Link'), cB = ci('Bedrooms'), cT = ci('Bathrooms'), cC = ci('Car Parks'), cL = ci('Land Size \\(m2\\)'), cP = ci('Sold Price'), cD = ci('Sold Date'), cLand = ci('Land'), cAcc = ci('Accommodation'), cLoc = ci('Location'), cQ = ci('Quality'), cCond = ci('Condition'), cO = ci('Overall');
      for (let r = ch.r + 2; r < P.length; r++) { const row = P[r] || []; const tag = cellStr(row[0]); if (!/^Sale \d+/i.test(tag || '')) { if (/^Subject$/i.test(tag || '') && r > ch.r + 2) break; continue; }
        const rec = { address: cellStr(row[cA]), link: cellStr(row[cK]), beds: num(row[cB]), baths: num(row[cT]), cars: num(row[cC]), land: num(row[cL]), price: num(row[cP]), date: excelDate(row[cD]), land_r: cellStr(row[cLand]), accom_r: cellStr(row[cAcc]), loc_r: cellStr(row[cLoc]), qual_r: cellStr(row[cQ]), cond_r: cellStr(row[cCond]), overall_r: cellStr(row[cO]) };
        if (rec.address) { if (rec.link && !/^https?:/.test(rec.link)) rec.link = null; if (rec.price != null && rec.price < 10000 && rec.price > 40000 === false && rec.price > 30000 && rec.price < 60000) rec.dateSerialPrice = true; out.pricing.compSales.push(rec); } } }
    // comparable rentals
    const rh = findCell(P, /^Comparable Rent Analysis$/i);
    if (rh) { const hdr = P[rh.r + 1] || []; const ci = name => hdr.findIndex(v => typeof v === 'string' && new RegExp('^' + name + '$', 'i').test(v.trim())); const cA = ci('Address'), cK = ci('Link'), cCmp = ci('Comparability'), cR = ci('Rent');
      for (let r = rh.r + 2; r < P.length; r++) { const row = P[r] || []; const tag = cellStr(row[0]); if (!/^Rental \d+/i.test(tag || '')) { if (/^Subject$/i.test(tag || '')) break; continue; } const rec = { address: cellStr(row[cA]), link: cellStr(row[cK]), comparability: cellStr(row[cCmp]), rent: num(row[cR]) }; if (rec.address) { if (rec.link && !/^https?:/.test(rec.link)) rec.link = null; out.pricing.compRents.push(rec); } } }
    // adopted figures: the "Appraisal Summary" rows carry Subject/Market in col A
    // and the label in col B — the same labels also appear as CAGR-matrix
    // headers and sale-history rows, so prefer a labelled row whose right-hand
    // value is present, scanning from the bottom (the summary is the last block).
    const lv = (re) => { for (let r = P.length - 1; r >= 0; r--) { const row = P[r] || []; for (let c = 0; c < Math.min(row.length, 4); c++) { const v = row[c]; if (typeof v === 'string' && re.test(v.trim())) { const val = rightOf(row, c); if (val != null && val !== '-' && val !== -1) return val; } } } return null; };
    const ad = out.pricing.adopted;
    ad.comparable = num(lv(/^Adopted Direct Comparable Price$/i));
    const rentV = lv(/^Adopted Rent$/i) ?? lv(/^Adopted Weekly Rent/i); ad.rent = num(rentV);
    ad.marketStrength = cellStr(lv(/^Market Strength$/i));
    ad.negotiationRange = cellStr(lv(/^Negotiation Range$/i));
    ad.topPrice = num(lv(/^Adopted Top Price$/i));
    const smy = frac(lv(/^Suburb Market Yield$/i)); if (smy != null && smy > 0) { ad.suburbYield = smy; if (out.pricing.suburb.suburbYield == null) out.pricing.suburb.suburbYield = smy; }
    const yp = num(lv(/^Investment Yield Price$/i)); if (yp != null && yp > 10000) ad.yieldPrice = Math.round(yp);
    const gy = frac(lv(/^Gross Yield$/i)); if (gy != null && gy > 0 && gy < 1) ad.grossYield = gy;
    const mr = cellStr(lv(/^Market Rent$/i)); if (mr) ad.marketRentRange = mr;
    const f2c = cellStr(lv(/^Floor to Ceiling Prices$/i)); if (f2c) ad.floorToCeiling = f2c;
    const dcr = cellStr(lv(/^Direct Comparison Range$/i)); if (dcr) ad.directComparisonRange = dcr;
    const agentRent = cellStr(lv(/^Agent Rent Appraisal$/i)); if (agentRent) out.agentRentAppraisal = agentRent;
    if (ad.topPrice == null) warn.push('no Adopted Top Price');
  } else warn.push('no price analysis tab');
  // inspection
  out.inspection = { rooms: {} };
  if (insp) {
    const I = insp.rows; const HEAD = [[/^Video Link$/i, 'videoRef'], [/^Property Grade$/i, 'grade'], [/^Agent Price Comments$/i, 'agentPrice'], [/^Agent Rent Comments$/i, 'agentRent'], [/^Why are they Selling/i, 'whySelling'], [/^Current Occupancy$/i, 'occupancy'], [/^Street Appeal$/i, 'streetAppeal'], [/^Approx Year Built$/i, 'yearBuilt'], [/^Approx Refurb age$/i, 'refurbAge'], [/^Approx Kitchen age$/i, 'kitchenAge'], [/^Approx Bathroom age$/i, 'bathroomAge'], [/^Approx Ensuite age$/i, 'ensuiteAge'], [/^Approx Laundry age$/i, 'laundryAge'], [/^Construction Quality$/i, 'constructionQuality'], [/^External Wall Material$/i, 'wallMaterial'], [/^Roof Material$/i, 'roofMaterial'], [/^Number of Storeys$/i, 'storeys'], [/^Pool or Outdoor Spa$/i, 'pool'], [/^Adjoining Properties$/i, 'adjoining'], [/^Overall Condition$/i, 'condition'], [/^Approx\.? Contingency$/i, 'contingency']];
    let room = null, lastFeat = null;
    for (let r = 0; r < I.length; r++) { const row = I[r] || []; const a = cellStr(row[0]); if (!a) continue;
      const h = HEAD.find(([re]) => re.test(a)); if (h) { const v = rightOf(row, 0); out.inspection[h[1]] = v == null ? null : (typeof v === 'number' ? (h[1] === 'contingency' ? '$' + Math.round(v).toLocaleString('en-AU') : (h[1] === 'agentPrice' ? moneyStr(v) : String(v))) : clean(v)); continue; }
      if (/^Accommodation$/i.test(a)) { const hdr = row, val = I[r + 1] || []; hdr.forEach((hh, c) => { const v = num(val[c]); if (typeof hh !== 'string' || v == null) return; if (/^Beds$/i.test(hh)) out.inspection.beds = v; else if (/^Bath/i.test(hh)) out.inspection.baths = v; else if (/^Living$/i.test(hh)) out.inspection.living = v; else if (/^Cars$/i.test(hh)) out.inspection.cars = v; }); continue; }
      if (/^General Notes$/i.test(a)) { out.inspection.summaryNotes = cellStr((I[r + 1] || [])[0]); break; }
      const b = row[1];
      if (typeof b === 'string' && /^(Pres|Present)$/i.test(b.trim())) { room = a; out.inspection.rooms[room] = { features: [] }; lastFeat = null; continue; }
      if (room) { if (typeof b === 'boolean') { lastFeat = { name: a, p: !!row[1], r: !!row[2], m: !!row[3], note: null, cost: typeof row[4] === 'number' ? row[4] : null }; out.inspection.rooms[room].features.push(lastFeat); } else if (b == null && lastFeat) { lastFeat.note = lastFeat.note ? lastFeat.note + ' ' + a : a; } }
    }
  }
  // compliance ticks (manual items = TRUE cells beside a label)
  out.complianceItems = {};
  if (comp) { for (const row of comp.rows) { const a = cellStr(row && row[0]); if (!a) continue; const t = row.find(v => typeof v === 'boolean'); if (t === true && /^[A-Za-z]/.test(a)) out.complianceItems[a] = true; } }   // only the ticked ones (the Builder leaves the rest unset)
  // photos from the workbook's embedded media
  out.photos = [];
  try {
    const dec = new TextDecoder(); const get = k => { const e = wb.files && wb.files[k]; if (!e) return null; return e.content || e; };
    const gets = k => { const c = get(k); return c ? dec.decode(c instanceof Uint8Array ? c : new Uint8Array(c)) : null; };
    const wbx = gets('xl/workbook.xml') || ''; const sheets = [...wbx.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map(m => ({ name: m[1].replace(/&amp;/g, '&'), rid: m[2] }));
    const rels = Object.fromEntries([...(gets('xl/_rels/workbook.xml.rels') || '').matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(m => [m[1], m[2]]));
    const mediaFor = (sheetName) => { const s = sheets.find(x => x.name === sheetName); if (!s || !rels[s.rid]) return []; const sf = 'xl/' + rels[s.rid].replace(/^\/?xl\//, ''); const srels = gets(sf.replace(/worksheets\/(sheet\d+\.xml)/, 'worksheets/_rels/$1.rels')) || ''; const out = []; for (const m of srels.matchAll(/Target="([^"]*drawing[^"]*)"/g)) { const df = 'xl/' + m[1].replace(/^\.\.\//, '').replace(/^\/?xl\//, ''); const drels = gets(df.replace(/drawings\/(drawing\d+\.xml)/, 'drawings/_rels/$1.rels')) || ''; for (const mm of drels.matchAll(/Target="([^"]*media\/([^"]+))"/g)) { const key = 'xl/media/' + mm[2]; const bytes = get(key); if (bytes) out.push({ key, name: mm[2], bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) }); } } return out; };
    const pick = (re, label, all) => { const sn = wb.SheetNames.find(s => re.test(s)); if (!sn) return; const media = mediaFor(sn).filter(m => m.bytes.length > 6000).sort((a, b) => b.bytes.length - a.bytes.length); if (!media.length) return; const list = all ? media : [media[0]]; list.forEach((m, i) => out.photos.push({ label: label + (all && i ? '-' + (i + 1) : ''), ext: /\.jpe?g$/i.test(m.name) ? 'jpg' : 'png', bytes: m.bytes })); };
    pick(/coversheet/i, 'exterior'); pick(/floorplan/i, 'floor-plan'); pick(/ir maps/i, 'map');
  } catch (e) { warn.push('photo extraction failed: ' + e.message); }
  return out;
}

// ── PDF text + images (pdf.js in headless Chrome) ─────────────────────────────
let browser = null, pdfPage = null;
async function pdfReady() {
  if (pdfPage) return pdfPage;
  browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  pdfPage = await browser.newPage();
  await pdfPage.setContent(`<!DOCTYPE html><html><head><script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js"></script></head><body><canvas id="cv"></canvas></body></html>`, { waitUntil: 'networkidle0' });
  await pdfPage.evaluate(() => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js'; });
  return pdfPage;
}
async function readPdf(file, wantImages) {
  const page = await pdfReady();
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(async (b64, wantImages) => {
    const raw = atob(b64); const arr = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    const pdf = await pdfjsLib.getDocument({ data: arr }).promise;
    const pages = [], images = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const pg = await pdf.getPage(p); const tc = await pg.getTextContent();
      const lines = new Map();
      for (const it of tc.items) { if (!it.str) continue; const y = Math.round(it.transform[5]); const k = [...lines.keys()].find(yy => Math.abs(yy - y) <= 2); const key = k == null ? y : k; if (!lines.has(key)) lines.set(key, []); lines.get(key).push({ x: it.transform[4], s: it.str }); }
      pages.push([...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, items]) => items.sort((a, b) => a.x - b.x).map(i => i.s).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean));
      const text = pages[p - 1].join('\n');
      const isCover = p === 1, isPlan = /Floor Plans?/i.test(text) && text.length < 400;
      if (!wantImages || !(isCover || isPlan)) continue;
      const ops = await pg.getOperatorList(); const stack = []; let ctm = [1, 0, 0, 1, 0, 0];
      const mul = (m1, m2) => [m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3], m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3], m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5]];
      const found = [];
      for (let i = 0; i < ops.fnArray.length; i++) { const fn = ops.fnArray[i], a = ops.argsArray[i];
        if (fn === pdfjsLib.OPS.save) stack.push(ctm); else if (fn === pdfjsLib.OPS.restore) ctm = stack.pop() || ctm; else if (fn === pdfjsLib.OPS.transform) ctm = mul(a, ctm);
        else if (fn === pdfjsLib.OPS.paintImageXObject) found.push({ name: a[0], drawnW: Math.hypot(ctm[0], ctm[1]), drawnH: Math.hypot(ctm[2], ctm[3]), x: ctm[4], y: ctm[5] }); }
      for (const f of found) {
        const img = await new Promise(res => { try { pg.objs.get(f.name, res); } catch (e) { res(null); } }); if (!img || !img.width) continue;
        const ratio = f.drawnW / Math.max(1, f.drawnH); if (f.drawnW < 60 || f.drawnH < 60 || ratio > 4.5 || ratio < 0.22) continue;   // logos, strips
        try { const cv = document.getElementById('cv'); cv.width = img.width; cv.height = img.height; const ctx = cv.getContext('2d');
          if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0); else if (img.data) { const id = ctx.createImageData(img.width, img.height); const src = img.data; if (src.length === img.width * img.height * 4) id.data.set(src); else if (src.length === img.width * img.height * 3) { for (let k = 0, j = 0; k < src.length; k += 3, j += 4) { id.data[j] = src[k]; id.data[j + 1] = src[k + 1]; id.data[j + 2] = src[k + 2]; id.data[j + 3] = 255; } } else if (src.length === img.width * img.height) { for (let k = 0, j = 0; k < src.length; k++, j += 4) { id.data[j] = id.data[j + 1] = id.data[j + 2] = src[k]; id.data[j + 3] = 255; } } else continue; ctx.putImageData(id, 0, 0); } else continue;
          images.push({ page: p, kind: isCover ? 'cover' : 'plan', w: img.width, h: img.height, drawnW: f.drawnW, drawnH: f.drawnH, x: f.x, y: f.y, dataUrl: cv.toDataURL('image/jpeg', 0.9) });
        } catch (e) {}
      }
    }
    const n = pdf.numPages; await pdf.destroy(); return { n, pages, images };
  }, b64, !!wantImages);
}
const moneyIn = (s) => { const m = String(s || '').match(/-?\$\s?[\d,]+(?:\.\d+)?/); return m ? num(m[0]) : null; };
const pctIn = (s) => { const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*%/); return m ? +m[1] / 100 : null; };
const gradeIn = (s) => { const m = String(s || '').match(/\b(Poor|Below Average|Above Average|Average|Excellent)\b/); return m ? m[1] : null; };

/* Commercial IR PDF → structured record (three sub-templates) */
function parseCommercialPdf(pages, file) {
  const all = pages.map(p => p.join('\n')); const warn = [];
  const out = { kind: 'commercial', file: basename(file), warn, attributes: [], strategyLines: [], grading: {}, pricing: { adopted: {}, compRents: [], compSales: [], history: [], streetSales: [], suburb: {} }, cashflow: {}, cashflowMeta: {}, units: [], outgoings: [], lease: null };
  const p1 = pages[0] || []; const prep = p1.find(l => /^Prepared\s+\d/.test(l)); if (prep) { const m = prep.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) out.preparedISO = m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0'); }
  const addrLine = p1.find(l => STATE_RE.test(l) && /\d/.test(l) && !/Prepared|Report/i.test(l)); out.addr = parseAddress(addrLine); if (!out.addr) warn.push('no address on cover');
  const sumIdx = pages.findIndex(p => p.some(l => /Summary and Property Attributes/i.test(l)) && p.some(l => /^Address /i.test(l)));
  const S = sumIdx >= 0 ? pages[sumIdx] : [];
  let i0 = S.findIndex(l => /^Address /i.test(l)), iLand = S.findIndex(l => /^Land Area/i.test(l));
  if (i0 >= 0 && iLand > i0) { const block = S.slice(i0 + 1, iLand); for (const raw of block) { const l = raw.replace(/^Strategy\s+/i, '').replace(/^Attributes\s+/i, '').trim(); if (!l) continue; if (/^-\s/.test(l)) out.attributes.push(l.replace(/^-\s*/, '')); else if (/:$/.test(l) && !out.strategyHeadline) out.strategyHeadline = l.replace(/:$/, ''); else out.strategyLines.push(l); } }
  const g = (re, src = S) => { const l = src.find(x => re.test(x)); return l || null; };
  const landL = g(/^Land Area/i); if (landL) out.landSize = num(landL.replace(/^Land Area/i, ''));
  const unitsL = g(/^Total Number of Units/i); if (unitsL) out.units_n = num(unitsL.replace(/^Total Number of Units/i, ''));
  const bedsL = g(/^- Total Bedrooms/i); if (bedsL) out.beds = num(bedsL.replace(/^- Total Bedrooms/i, ''));
  const bathsL = g(/^- Total Bathrooms/i); if (bathsL) out.baths = num(bathsL.replace(/^- Total Bathrooms/i, ''));
  const bldL = g(/^Total Building Area/i); if (bldL) out.buildingArea = num(bldL.replace(/^Total Building Area/i, ''));
  const whL = g(/^- Warehouse /i); if (whL) out.warehouseArea = num(whL.replace(/^- Warehouse/i, ''));
  const ofL = g(/^- Office/i); if (ofL) out.officeArea = num(ofL.replace(/^- Office\S*/i, ''));
  const carL = g(/# of cars/i); if (carL) { const m = carL.match(/# of cars\s+(\d+)/i); if (m) out.cars = +m[1]; }
  const tenL = g(/^Tenant\(s\)/i); if (tenL) out.tenants = clean(tenL.replace(/^Tenant\(s\)/i, ''));
  const zI = S.findIndex(l => /^Current Zoning/i.test(l)); if (zI >= 0) { let z = clean(S[zI].replace(/^Current Zoning/i, '')); if (!z && S[zI + 1] && !/Replacement/i.test(S[zI + 1])) z = S[zI + 1]; out.zoning = z; }
  const rng = (re) => { const l = g(re); if (!l) return null; const ms = [...l.matchAll(/\$\s?[\d,]+/g)].map(m => num(m[0])); return ms.length >= 2 ? { low: ms[0], high: ms[1] } : (ms.length ? { low: ms[0], high: ms[0] } : null); };
  out.replacementBuilding = rng(/^Building Replacement Cost/i); out.landValue = rng(/^Land Value/i); out.replacementTotal = rng(/^Total Replacement Cost/i);
  const discL = g(/^Discount to Replacement Cost/i) || g(/^Replacement Cost\s+\d/i); if (discL) { const ms = [...discL.matchAll(/(\d+(?:\.\d+)?)%/g)].map(m => m[1] + '%'); out.discountToReplacement = ms.join(' to '); out.discountIsGrowth = !!g(/Growth Required/i); }
  const topL = g(/^(Top Purchase Price|Purchase Price|PROPOSED TOP PURCHASE PRICE)\s+\$/i); if (topL) out.topPrice = moneyIn(topL);
  const cvL = g(/^Capital Value/i); if (cvL) { out.capitalValue = moneyIn(cvL); out.capitalValueBasis = /unit/i.test(cvL) ? 'per unit' : 'per m2'; }
  for (const l of S) {
    let m;
    if ((m = l.match(/^Net Rent \| Net Rent \$\/m2\s+(\$[\d,]+)\s+(\$[\d,]+)/i))) { out.netRent = num(m[1]); out.netRentPerSqm = num(m[2]); }
    else if ((m = l.match(/^Market Net Rent \| Market Net Rent \$\/m2\s+(\$[\d,]+)\s+(\$[\d,]+)/i))) { out.marketNetRent = num(m[1]); out.marketNetRentPerSqm = num(m[2]); }
    else if ((m = l.match(/^Net Rent\s+(\$[\d,]+)/i))) out.netRent = num(m[1]);
    else if ((m = l.match(/^Market Net Rent\s+(\$[\d,]+)/i))) out.marketNetRent = num(m[1]);
    else if ((m = l.match(/^Initial Net Yield\s+([\d.]+)%/i))) out.netYield = +m[1] / 100;
    else if ((m = l.match(/^Market Net Yield\s+([\d.]+)%/i))) out.marketNetYield = +m[1] / 100;
    else if ((m = l.match(/^Initial Net Rent and Net Yield\s+(\$[\d,]+)\s+([\d.]+)%/i))) { out.netRent = num(m[1]); out.netYield = +m[2] / 100; }
    else if ((m = l.match(/^Market Net Rent and Net Yield\s+(\$[\d,]+)\s+([\d.]+)%/i))) { out.marketNetRent = num(m[1]); out.marketNetYield = +m[2] / 100; }
    else if ((m = l.match(/^Market Gross Rent and Gross Yield\s+(\$[\d,]+)\s+([\d.]+)%/i))) { out.grossMarketRent = num(m[1]); out.grossYield = +m[2] / 100; }
  }
  // investment matrix (grading) — optional page
  const M = pages.find(p => p.some(l => /^Investment Matrix$/i.test(l) || /Investment Matrix$/i.test(l)) && p.some(l => /Property\/Site Grade/i.test(l)));
  if (M) { const items = ['Location Quality', 'Building Quality', 'Land Content', 'Stand Alone', 'Value Add Opportunity', 'Tenant Quality', 'Vacancy/Letting up Period', 'Lease Terms', 'Lease Increases', 'Replacement Cost VS Purchase Price'];
    for (const it of items) { const l = M.find(x => x.startsWith(it)); const gr = l ? gradeIn(l.slice(it.length)) : null; if (gr) out.grading[it] = gr; }
    const pg = M.find(l => /Property\/Site Grade:/i.test(l)); if (pg) out.propertyGrade = clean(pg.split(':')[1]);
    const rr = M.find(l => /^Risk Rating:/i.test(l)); if (rr) out.riskRating = clean(rr.split(':')[1]);
    const orr = M.find(l => /^Overall Rating:/i.test(l)); if (orr) out.overallRating = clean(orr.split(':')[1]);
    const st = M.find(l => /^Strategy\s+\S/.test(l) && !/^Strategy\s+-/.test(l)); if (st) out.matrixStrategy = clean(st.replace(/^Strategy\s+/, ''));
    const ye = M.find(l => /^Yield Expectation/i.test(l)); if (ye) out.yieldExpectation = clean(ye.replace(/^Yield Expectation/i, '')); }
  // tenancy & outgoings
  const T = pages.find(p => p.some(l => /^TENANCY SCHEDULE$/i.test(l)));
  if (T) { for (const l of T) { let m;
      if ((m = l.match(/^(\d{1,2})\s+\$([\d,]+)\s+\$([\d,]+)\s+(.*)$/))) out.units.push({ unit: +m[1], annualRent: num(m[2]), weeklyRent: num(m[3]), detail: clean(m[4]) });
      else if ((m = l.match(/^Current Gross Rent\s+\$([\d,]+)/i))) out.currentGrossRent = num(m[1]);
      else if ((m = l.match(/^Total Outgoings\s+\$([\d,.]+)/i))) out.totalOutgoings = num(m[1]);
      else if ((m = l.match(/^Recoverable Outgoings\s+\$([\d,.]+)/i))) out.recoverableOutgoings = num(m[1]);
      else if ((m = l.match(/^Unrecoverable Outgoings\s+\$([\d,.]+)/i))) out.unrecoverableOutgoings = num(m[1]);
      else if ((m = l.match(/^(Council Rates|Water(?: & Sewerage| Rates)?|Electricity|Insurance(?: \(TBC\))?|Land Tax[^$]*|Fire Services Property Levy|Admin\/Property Management[^$]*|Property Management[^$]*|Maintenance[^$]*|General Maintenance[^$]*|Gardening[^$]*|Audit fees[^$]*|Building Insurance[^$]*|Water Usage[^$]*|Common Electricity|Fire and Mechanical[^$]*|Other[^$]*)\s+\$([\d,.]+)/i))) out.outgoings.push({ label: clean(m[1]).replace(/\s*-\s*$/, ''), amount: num(m[2]) });
    }
    const hdrI = T.findIndex(l => /^Tenant NLA Rent/i.test(l)); if (hdrI >= 0) { for (let k = hdrI + 1; k < Math.min(T.length, hdrI + 6); k++) { const m = T[k].match(/^(.+?)\s+([\d,]+)\s+\$([\d,]+)\s+\$([\d,]+)/); if (m && !/TOTALS/i.test(m[1])) { out.tenantRow = { tenant: clean(m[1]), nla: num(m[2]), rent: num(m[3]), rentPerSqm: num(m[4]), raw: T[k] }; break; } } } }
  // lease summary
  const L = pages.find(p => p.some(l => /^LEASE SUMMARY$/i.test(l)));
  if (L) { const idx = re => L.findIndex(l => re.test(l)); const lessee = idx(/^Lessee$/i) >= 0 ? L[idx(/^Lessee$/i) + 1] : null; const termI = idx(/^Term Current Rent$/i); const termLine = termI >= 0 ? L[termI + 1] : null; const commI = idx(/^Commencement Date NLA$/i); const commLine = commI >= 0 ? L[commI + 1] : null; const optI = idx(/^Annual rent reviews Options$/i); out.lease = { lessee: clean(lessee), term: termLine ? clean(termLine.replace(/\$[\d,.]+/, '')) : null, currentRent: termLine ? moneyIn(termLine) : null, commencement: commLine ? clean(commLine.replace(/\s+\d[\d,]*$/, '')) : null, nla: commLine ? num((commLine.match(/(\d[\d,]*)\s*$/) || [])[1]) : null, reviewsOptions: optI >= 0 ? clean((L[optI + 1] || '') + ' ' + (L[optI + 2] || '')) : null }; }
  // pricing analysis pages (may span two)
  const PA = pages.filter(p => p.some(l => /^Pricing Analysis$/i.test(l)) || p.some(l => /Market Capitalisation Adopted Value/i.test(l)) || p.some(l => /^(PROPOSED TOP PURCHASE PRICE|PURCHASE PRICE)\s+\$/i.test(l))).flat();
  const ad = out.pricing.adopted;
  for (const l of PA) { let m;
    if ((m = l.match(/^Comparable Rent \$\/(SQM|Week) Range\s+\$([\d,]+)\s+to\s+\$([\d,]+)/i))) ad.comparableRentRange = '$' + m[2] + ' to $' + m[3] + (m[1].toUpperCase() === 'SQM' ? ' /sqm' : ' /wk');
    else if ((m = l.match(/^Adopted Market Rent \$\/Week - Top Floor\s+\$([\d,]+)/i))) ad.adoptedMarketRentTop = num(m[1]);
    else if ((m = l.match(/^Adopted Market Rent \$\/Week - Ground Floor\s+\$([\d,]+)/i))) ad.adoptedMarketRentGround = num(m[1]);
    else if ((m = l.match(/^Adopted Market Rent \$\/Week \(([^)]+)\)\s+\$([\d,]+)/i))) (ad.adoptedMarketRentByType = ad.adoptedMarketRentByType || {})[m[1]] = num(m[2]);
    else if ((m = l.match(/^Adopted Market Rent \$\/SQM\s+\$([\d,.]+)/i))) ad.adoptedMarketRentPerSqm = num(m[1]);
    else if ((m = l.match(/^GROSS MARKET RENT\s+\$([\d,]+)/i))) ad.grossMarketRent = num(m[1]);
    else if ((m = l.match(/^MARKET (?:NET )?RENT\s+\$([\d,]+)/i))) ad.marketRentPa = num(m[1]);
    else if ((m = l.match(/^CURRENT GROSS RENT\s+\$([\d,]+)/i))) ad.currentGrossRent = num(m[1]);
    else if ((m = l.match(/^INITIAL NET RENT\s+\$([\d,]+)/i))) ad.initialNetRent = num(m[1]);
    else if ((m = l.match(/^Market Cap Rates\s+(.*)$/i))) ad.marketCapRates = clean(m[1]).replace(/\s+/g, ' / ');
    else if ((m = l.match(/^Market Capitalisation Adopted Value\s+\$([\d,]+)/i))) ad.capitalisationAdoptedValue = num(m[1]);
    else if ((m = l.match(/^(?:SUMMATION ADOPTED VALUE|Summation Adopted Value)\s+\$([\d,]+)/i))) ad.summationAdoptedValue = num(m[1]);
    else if ((m = l.match(/^GLA \$\/sqm Adopted Value\s+\$([\d,]+)/i))) ad.glaAdoptedValue = num(m[1]);
    else if ((m = l.match(/^ADOPTED COMPARABLE GLA \$\/SQM\s+\$([\d,.]+)/i))) ad.adoptedGlaPerSqm = num(m[1]);
    else if ((m = l.match(/^ADOPTED COMPARABLE UNIT PRICE[^$]*\(?([^)$]*)\)?\s*\$([\d,.]+)/i))) (ad.adoptedComparableUnitPrice = ad.adoptedComparableUnitPrice || {})[clean(m[1]) || 'unit'] = num(m[2]);
    else if ((m = l.match(/^COMPARABLE (?:UNIT RANGE|SUMMATION RANGE)[^$]*\$([\d,]+)\s+to\s+\$([\d,]+)/i))) ad.comparableUnitRange = '$' + m[1] + ' to $' + m[2];
    else if ((m = l.match(/^COMPARABLE YIELD RANGE\s+(.*)$/i))) ad.comparableYieldRange = clean(m[1]);
    else if ((m = l.match(/^(?:PROPOSED TOP PURCHASE PRICE|PURCHASE PRICE)\s+\$([\d,]+)/i))) ad.topPrice = num(m[1]);
  }
  // comparable sales + rentals. Two layouts: (a) the address sits on the line(s)
  // above the "$price date …" line, with the suburb line often BELOW it;
  // (b) address, price and date all on one line (Melbourne unit-block template).
  const addrish = l => /\d/.test(l) && new RegExp('\\b(' + STREET_TYPES + ')\\b', 'i').test(l) && !/\$/.test(l);
  const SUBURB_LINE = /^[A-Za-z][A-Za-z' .-]+,?\s+(NT|VIC|Vic|QLD|Qld|WA|SA|NSW|TAS|Tas|ACT)\b\s*\d{0,4}\s*$/;
  const nearestAddr = (k) => { for (let j = k - 1; j >= Math.max(0, k - 3); j--) if (addrish(PA[j])) { let addr = PA[j].replace(/,\s*$/, ''); if (!STATE_RE.test(addr) && PA[k + 1] && SUBURB_LINE.test(PA[k + 1])) addr += ', ' + PA[k + 1]; else if (!STATE_RE.test(addr) && PA[j + 1] && j + 1 < k && SUBURB_LINE.test(PA[j + 1])) addr += ', ' + PA[j + 1]; return addr; } return null; };
  const pushSale = (addr, price, date, rest) => { const yieldM = rest.match(/^([\d.]+)%/); const bb = rest.match(/(\d+(?:\.\d)?)\s*Bed(?:room)?s?\s*(?:x\s*)?(\d+(?:\.\d)?)?\s*Bath/i); const sqm = rest.match(/^(?:[\d.]+\s+)?([\d,]+)\s+\$([\d,]+)/);
    const rec = { address: clean(addr), price: num(price), date }; if (yieldM) rec.yield = +yieldM[1] / 100; if (bb) { rec.beds = +bb[1]; if (bb[2]) rec.baths = +bb[2]; } if (sqm && !bb) { rec.area = num(sqm[1]); rec.pricePerSqm = num(sqm[2]); } const ov = rest.match(/\b(Superior|Slightly Superior|Comparable|Slightly Inferior|Inferior)\b/i); if (ov) rec.overall_r = ov[1]; rec.comments = clean(rest.replace(/^[\d.]+%\s*/, '')) || null;
    if (!out.pricing.compSales.find(x => x.address === rec.address && x.price === rec.price)) out.pricing.compSales.push(rec); };
  for (let k = 0; k < PA.length; k++) { const l = PA[k]; let m;
    if ((m = l.match(/^\$([\d,]+)\s+(\d{2}\/\d{2}\/\d{4})\s*(.*)$/))) { const addr = nearestAddr(k); if (addr) pushSale(addr, m[1], m[2], m[3]); }
    else if ((m = l.match(/^(.+?\b(?:NT|VIC|Vic|QLD|Qld|WA|SA|NSW|TAS|Tas)\b\s*\d{0,4})\s+\$([\d,]+)\s+(\d{2}\/\d{2}\/\d{4})\s*(.*)$/))) pushSale(m[1], m[2], m[3], m[4]);
    else if ((m = l.match(/^(?:(On Market|Leased)\s+)?(\d+ Bed \d+ Bath)\s+\$([\d,]+)\s*(.*)$/i))) { const addr = nearestAddr(k); if (!addr) continue;
      const ov = (m[4] || '').match(/\b(Superior|Slightly Superior|Comparable|Slightly Inferior|Inferior)\b/i); out.pricing.compRents.push({ address: clean(addr), status: m[1] ? clean(m[1]) : null, accommodation: m[2], rent: num(m[3]), comparability: ov ? ov[1] : null, comments: clean(m[4]) || null }); }
    else if ((m = l.match(/^\$([\d,]+)\s+([\d,]+)\s+\$([\d,]+)\s*(.*)$/)) && /Total Rent|Lettable Area/.test(PA.slice(0, k).reverse().find(x => /Property Address/.test(x)) || '')) { const addr = nearestAddr(k); if (!addr) continue; out.pricing.compRents.push({ address: clean(addr), rentPa: num(m[1]), area: num(m[2]), rentPerSqm: num(m[3]), comments: clean(m[4]) || null }); }
    else if ((m = l.match(/^([\dA-Za-z\/ ,.'-]+?\s+(?:Vic|VIC|NT|QLD|Qld|WA|SA|NSW)\s+\d{3,4})\s+\$([\d,]+)\s+(\d+(?:\.\d)?)\s*Bed\s+(\d+(?:\.\d)?)\s*Bath\s+\$([\d,]+)\s*(.*)$/i))) out.pricing.compRents.push({ address: clean(m[1]), rentPa: num(m[2]), beds: +m[3], baths: +m[4], rent: num(m[5]), comments: clean(m[6]) || null });
  }
  // cashflow page(s)
  const C = pages.find(p => p.some(l => /Cashflow - \d+ Year$/i.test(l)) && p.some(l => /^COST OF PROPERTY$/i.test(l)));
  if (C) { const cf = out.cashflow; const cfTitle = C.find(l => /^Cashflow \d - /i.test(l)); if (cfTitle) out.cashflowMeta.variant = cfTitle; for (const l of C) { let m;
      if ((m = l.match(/^(?:Top Budget|Purchase Price)\s+\$([\d,]+)/i))) cf.budget = num(m[1]);
      else if ((m = l.match(/^Stamp Duty\s+\$([\d,.]+)/i))) cf.stampDuty = num(m[1]);
      else if ((m = l.match(/^Title Transfer Fees\s+\$([\d,.]+)/i))) cf.titleTransfer = num(m[1]);
      else if ((m = l.match(/^PPA Fee \(inc GST\)\s+([\d.]+)%\s+\$([\d,.]+)/i))) { cf.acquisitionFee = num(m[2]); out.cashflowMeta.ppaFeePct = +m[1] / 100; }
      else if ((m = l.match(/^Conveyancing\/legal\s+\$([\d,.]+)/i))) cf.conveyancing = num(m[1]);
      else if ((m = l.match(/^DD Reports\s+\$([\d,.]+)/i))) cf.buildingPest = num(m[1]);
      else if ((m = l.match(/^LVR\s+([\d.]+)%/i))) cf.lvr = +m[1] / 100;
      else if ((m = l.match(/^Interest Rate\s+([\d.]+)%/i))) cf.rate = +m[1] / 100;
      else if ((m = l.match(/^Loan Amount\s+\$([\d,.]+)/i))) out.cashflowMeta.loanAmount = num(m[1]);
      else if ((m = l.match(/^Required Capital\s+\$([\d,.]+)/i))) out.cashflowMeta.requiredCapital = num(m[1]);
      else if ((m = l.match(/^NET INCOME \(GOING IN\)\s+\$([\d,.]+)/i))) out.cashflowMeta.netIncomeGoingIn = num(m[1]);
      else if ((m = l.match(/^NET YIELD \(GOING IN\)\s+([\d.]+)%/i))) out.cashflowMeta.netYieldGoingIn = +m[1] / 100;
      else if ((m = l.match(/^MARKET NET INCOME\s+\$([\d,.]+)/i))) out.cashflowMeta.marketNetIncome = num(m[1]);
      else if ((m = l.match(/^MARKET NET YIELD\s+([\d.]+)%/i))) out.cashflowMeta.marketNetYield = +m[1] / 100;
      else if ((m = l.match(/^START DATE\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i))) out.cashflowMeta.startDate = m[1];
      else if ((m = l.match(/^Annual Equity IRR\s+([\d.]+)%/i))) out.cashflowMeta.equityIrr = +m[1] / 100;
    }
    // running costs: year-1 amount = first $ on the line, within the RUNNING COSTS block
    const rc0 = C.findIndex(l => /^RUNNING COSTS$/i.test(l)), rc1 = C.findIndex((l, i) => i > rc0 && /^TOTAL OPERATING EXPENSES/i.test(l));
    if (rc0 >= 0 && rc1 > rc0) { cf.feeLines = []; for (const l of C.slice(rc0 + 1, rc1)) { const m = l.match(/^(.+?)\s+\$([\d,.]+)/); if (!m) continue; const label = clean(m[1]), amt = num(m[2]); if (/Council|Water Rates|Water & Sewerage/i.test(label)) cf.councilWater = (cf.councilWater || 0) + amt; else if (/^Land Tax/i.test(label)) cf.landTax = (cf.landTax || 0) + amt; else if (/Insurance/i.test(label)) cf.insurance = (cf.insurance || 0) + amt; else cf.feeLines.push({ label, amount: amt }); } }
  } else warn.push('no cashflow page');
  if (ad.topPrice == null && out.topPrice != null) ad.topPrice = out.topPrice; if (out.topPrice == null && ad.topPrice != null) out.topPrice = ad.topPrice;
  if (out.topPrice == null) warn.push('no top/purchase price');
  return out;
}

/* Wholesale IR PDF → record */
function parseWholesalePdf(pages, file) {
  const all = pages.flat(); const warn = [];
  const out = { kind: 'wholesale', file: basename(file), warn, grading: {}, dd: {}, cashflow: {}, cashflowMeta: {}, pricing: { adopted: {}, compSales: [], compRents: [], history: [], streetSales: [], suburb: {} } };
  const cover = pages[0] || [];
  const prep = cover.find(l => /^Prepared\s+/.test(l)); if (prep) { const m = prep.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/); if (m) { const d = new Date(m[1] + ' ' + m[2] + ' ' + m[3]); if (!isNaN(d)) out.preparedISO = d.toISOString().slice(0, 10); } const by = prep.match(/\bby\s+(\S+)/); out.preparedBy = by ? by[1] : null; }
  const lv = (re, src = cover) => { const l = src.find(x => re.test(x)); return l ? clean(l.replace(re, '')) : null; };
  out.strategy = lv(/^Property Strategy:\s*/i); out.propertyGrade = lv(/^Property Grade:\s*/i); out.suburbRating = lv(/^Suburb Rating:\s*/i);
  const spec = cover.find(l => /Bedroom \|/i.test(l)); if (spec) { const m = spec.match(/(\d+(?:\.\d)?)\s*Bedroom\s*\|\s*(\d+(?:\.\d)?)\s*Bathroom\s*\|\s*(\d+(?:\.\d)?)\s*Living\s*\|\s*(\d+(?:\.\d)?)\s*Cars?/i); if (m) { out.beds = +m[1]; out.baths = +m[2]; out.living = +m[3]; out.cars = +m[4]; } }
  const land = cover.find(l => /^Land Area:/i.test(l)); if (land) out.landSize = num(land.replace(/^Land Area:/i, ''));
  // DD report page
  const D = pages.find(p => p.some(l => /Preliminary Due Diligence Report/i.test(l)));
  if (D) { const ddr = D.find(l => /^DD Result/i.test(l)); if (ddr) out.ddResult = clean(ddr.replace(/^DD Result/i, ''));
    for (let k = 0; k < D.length; k++) { const l = D[k]; const m = l.match(/^(.+?)\s+(Approved|Review|Failed)\s*(.*)$/); if (!m || /Rating Notes/i.test(l) || /^DD Result/i.test(l)) continue; const name = clean(m[1]); if (/^(Subject Property|Adjoining Property|Other Negative)/i.test(name)) continue; let notes = clean(m[3]) || ''; if (!notes && D[k - 1] && !/(Approved|Review|Failed)\s*/.test(D[k - 1]) && !/Rating Notes|Checks/.test(D[k - 1])) notes = D[k - 1]; if (D[k + 1] && !/(Approved|Review|Failed)\b/.test(D[k + 1]) && !/^(Adjoining|Other Negative|Subject)/i.test(D[k + 1]) && /^[a-z(]/.test(D[k + 1])) notes = (notes + ' ' + D[k + 1]).trim(); out.dd[name] = { rating: m[2], notes: notes || null }; } }
  // grading page
  const G = pages.find(p => p.some(l => /^Property Grading$/i.test(l)));
  if (G) { for (const l of G) { const m = l.match(/^(Property Type|Title Type)\s+(\S+)/); if (m) { out.grading[m[1]] = m[2]; continue; } const gm = l.match(/^([A-Za-z\/ '.-]+?)\s+(Poor|Below Average|Above Average|Average|Excellent)\b/); if (gm && !/^Property Grade|^Suburb Rating/.test(gm[1])) out.grading[clean(gm[1])] = gm[2]; }
    const st = G.find(l => /^Property Strategy:/i.test(l)); if (st) out.gradStrategy = clean(st.split(':')[1]); const pg = G.find(l => /^Property Grade:/i.test(l)); if (pg) out.propertyGrade = out.propertyGrade || clean(pg.split(':')[1]); const sr = G.find(l => /^Suburb Rating:/i.test(l)); if (sr) out.suburbRating = out.suburbRating || clean(sr.split(':')[1]); }
  // cashflow (Interest Only, the first cashflow page)
  const C = pages.find(p => p.some(l => /^Interest Only Cash\s?fl?\s?ow$/i.test(l.replace(/\s/g, ' ')) || /^Interest Only Cash/i.test(l)) && p.some(l => /^COST OF PROPERTY$/i.test(l)));
  if (C) { const cf = out.cashflow; for (const l of C) { let m;
      if ((m = l.match(/^Land Value\s+\$([\d,]+)/i))) out.cashflowMeta.landValue = num(m[1]);
      else if ((m = l.match(/^Build Value\s+\$([\d,]+)/i))) out.cashflowMeta.buildValue = num(m[1]);
      else if ((m = l.match(/^Property Value \(Total\)\s+\$([\d,]+)/i))) cf.budget = num(m[1]);
      else if ((m = l.match(/^Stamp Duty[^$]*\$([\d,]+)/i))) cf.stampDuty = num(m[1]);
      else if ((m = l.match(/^Mortgage and Title Transfer Fee\s+\$([\d,]+)/i))) cf.titleTransfer = num(m[1]);
      else if ((m = l.match(/^(?:Priority List|Waitlist) Fee inc GST\s+\$([\d,]+)/i))) cf.acquisitionFee = num(m[1]);
      else if ((m = l.match(/^Conveyancing\/Legal\s+\$([\d,]+)/i))) cf.conveyancing = num(m[1]);
      else if ((m = l.match(/^(?:Stage Inspections|Handover Inspection)\s+\$([\d,]+)/i))) cf.buildingPest = num(m[1]);
      else if ((m = l.match(/^Depreciation Schedule\s+\$([\d,]+)/i))) cf.depreciationSchedule = num(m[1]);
      else if ((m = l.match(/^Finance - Interest\s+([\d.]+)%\s+([\d.]+)%/i))) { cf.lvr = +m[1] / 100; cf.rate = +m[2] / 100; }
      else if ((m = l.match(/^Finance - Principal Loan Term of\s+(\d+)\s+years/i))) cf.loanTermYears = +m[1];
      else if ((m = l.match(/^Letting Fee & Marketing Letting Fee of\s+([\d.]+)\s+weeks/i))) cf.lettingFeeWeeks = +m[1];
      else if ((m = l.match(/^Property Management Fee\s+([\d.]+)%/i))) cf.pmFeePct = +m[1] / 100;
      else if ((m = l.match(/^Repairs & Maintenance\s+([\d.]+)%/i))) cf.repairsPctOfRent = +m[1] / 100;
      else if ((m = l.match(/^Strata Fees\s+\$([\d,]+)/i))) cf.strata = num(m[1]);
      else if ((m = l.match(/^Council and Water Rates\s+\$([\d,]+)/i))) cf.councilWater = num(m[1]);
      else if ((m = l.match(/^Land Tax\s+\$([\d,]+)/i))) cf.landTax = num(m[1]);
      else if ((m = l.match(/^Insurance Estimate\s+\$([\d,]+)/i))) cf.insurance = num(m[1]);
      else if ((m = l.match(/^Rent\s+\$([\d,]+)/i))) cf.rent = num(m[1]);
      else if ((m = l.match(/^Income - Annual with full occupancy\s+\d+\s+(\d+)\s+\$/i))) cf.weeksLet = +m[1];
      else if ((m = l.match(/^Gross Yield\s+([\d.]+)%/i))) out.cashflowMeta.grossYield = +m[1] / 100;
      else if ((m = l.match(/^Net Yield\s+([\d.]+)%/i))) out.cashflowMeta.netYield = +m[1] / 100;
      else if ((m = l.match(/^Loan Amount\s+\$([\d,]+)/i))) out.cashflowMeta.loanAmount = num(m[1]);
    } cf.weeksLet = cf.weeksLet || 52; cf.maintenanceAllowance = 0; cf.cosmeticWorks = 0; cf.engagementFee = 0; cf.professionalClean = 0; cf.minRentalStdCost = 0; }
  // comparable sales
  const S = pages.find(p => p.some(l => /^Comparable Sales? Analysis/i.test(l)));
  if (S) {
    // the Subject row: "Subject <address> [link/brochure note] beds baths cars [land] $price"
    const subj = S.find(l => /^Subject\s+\S/.test(l) && /\$[\d,]+/.test(l) && !/Floor to Ceiling|Adopted|Average|Market Rent|Gross Yield/i.test(l));
    if (subj) { let addrTxt = subj.replace(/^Subject\s+/, '').replace(/\s+(No [Ll]ink|https?:\/\/|M3_|\*\*\*REDACTED).*$/, '').trim(); addrTxt = addrTxt.replace(/\s+\d+(?:\.\d)?\s+\d+(?:\.\d)?\s+\d+.*$/, '');
      if (!/REDACTED/i.test(addrTxt) && addrTxt) { let a = parseAddress(addrTxt); if (a && a.suburb && /\(/.test(a.suburb)) { const mm = a.suburb.match(/^([^(]*)\(([^)]*)\)/); a.estateNote = mm ? clean(mm[2]) : null; a.suburb = mm ? clean(mm[1]) || null : null; } if (a && a.street) a.street = a.street.replace(/\s*\([^)]*\)\s*$/, ''); out.addr = a; }
      const pm = subj.match(/\$([\d,]+)(?:\s+\$[\d,]+)?\s*(?:Not Sold)?\s*$/); if (pm) out.pricing.adopted.topPrice = num(pm[1]); }
    // "Sale n <address> <link> beds baths cars … $price date …" (ratings may sit before OR after the date)
    for (const l of S) { const m = l.match(/^Sale (\d+)\s+(.+?)\s+(\d+)\s+(\d+(?:\.\d)?)\s+(\d+)\s+(.*?)\$([\d,]+)\s+(\d{2}\/\d{2}\/\d{4})(.*)$/); if (!m) continue; const addrTxt = m[2].replace(/\s+https?:\S+/, '').replace(/\s+\*\*\*REDACTED\*\*\*/g, ''); const around = m[6] + ' ' + m[9]; const ovs = [...around.matchAll(/\b(Superior|Slightly Superior|Comparable|Slightly Inferior|Inferior)\b/g)].map(x => x[1]);
      out.pricing.compSales.push({ address: /REDACTED/i.test(addrTxt) ? 'redacted' : clean(addrTxt), beds: +m[3], baths: +m[4], cars: +m[5], land: num((m[6].match(/(\d{2,4})\s*$/) || [])[1]), price: num(m[7]), date: m[8], overall_r: ovs.length ? ovs[ovs.length - 1] : null }); }
    // land-only rows ("Sale n <address> <link> land $price $/sqm date") are the land analysis — keep separately
    for (const l of S) { const m = l.match(/^Sale (\d+)\s+(.+?)\s+(\d{2,4})\s+\$([\d,]+)\s+\$([\d,]+)\s+(\d{2}\/\d{2}\/\d{4})/); if (!m) continue; (out.pricing.landSales = out.pricing.landSales || []).push({ address: /REDACTED/i.test(m[2]) ? 'redacted' : clean(m[2].replace(/\s+https?:\S+/, '')), land: +m[3], price: num(m[4]), pricePerSqm: num(m[5]), date: m[6] }); }
    // when the subject has no suburb, take the suburb most of the comparables share
    if (out.addr && !out.addr.suburb) { const subs = out.pricing.compSales.map(c => parseAddress(c.address)).filter(a => a && a.suburb).map(a => a.suburb + '|' + (a.state || '') + '|' + (a.postcode || '')); const mode = subs.sort((a, b) => subs.filter(x => x === b).length - subs.filter(x => x === a).length)[0]; if (mode) { const [sub, st, pc] = mode.split('|'); out.addr.suburb = sub; out.addr.state = out.addr.state || st || null; out.addr.postcode = out.addr.postcode || pc || null; out.addr.suburbInferred = true; out.addr.full = [out.addr.street, sub, [out.addr.state, out.addr.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', '); warn.push('suburb inferred from the comparable sales (' + sub + ')'); } }
    const f2c = S.find(l => /^Subject Floor to Ceiling Prices/i.test(l)); if (f2c) out.pricing.adopted.floorToCeiling = clean(f2c.replace(/^Subject Floor to Ceiling Prices/i, ''));
    // dwelling comparable = the LARGEST adopted comparable figure on the page (the land analysis repeats the label with a smaller number)
    const comps = S.filter(l => /^(Subject Adopted Direct Comparable Price|Average Direct Comparable sold price|Subject Average Price)/i.test(l)).map(l => { const ms = [...l.matchAll(/\$([\d,]+)/g)].map(x => num(x[1])); return ms.length ? Math.max(...ms) : null; }).filter(v => v != null); if (comps.length) { out.pricing.adopted.comparable = Math.max(...comps); if (comps.length > 1) out.pricing.adopted.landComparable = Math.min(...comps); }
    const prem = S.find(l => /^Price Premium %/i.test(l)); if (prem) out.pricing.adopted.pricePremiumPct = pctIn(prem);
    for (const l of S) { const m = l.match(/^Rental (\d+)\s+(.+?)\s+(Superior|Slightly Superior|Comparable|Slightly Inferior|Inferior)\s+\$([\d,]+)/); if (m) out.pricing.compRents.push({ address: /REDACTED/i.test(m[2]) ? 'redacted' : clean(m[2]), comparability: m[3], rent: num(m[4]) }); }
    const mr = S.find(l => /^Subject Market Rent/i.test(l)); if (mr) out.pricing.adopted.marketRentRange = clean(mr.replace(/^Subject Market Rent/i, ''));
    const ar = S.find(l => /^Subject Adopted Rent/i.test(l)); if (ar) out.pricing.adopted.rent = moneyIn(ar); }
  if (out.pricing.adopted.topPrice == null && out.cashflow.budget != null) out.pricing.adopted.topPrice = out.cashflow.budget;
  if (out.pricing.adopted.rent == null && out.cashflow.rent != null) out.pricing.adopted.rent = out.cashflow.rent;
  if (!out.addr) warn.push('address redacted — using the file name as the label');
  return out;
}

// ── suburb intelligence (mirrors ir-builder fetchIntel / intelAutoMap) ────────
const CFG = { regions: [] }; const scoresCache = new Map();
async function loadConfig() {
  const { data } = await sb.from('ir_config').select('key,payload');
  for (const r of (data || [])) CFG[r.key] = r.payload;
  CFG.regions = ((CFG.regions || {}).regions) || [];
}
async function fetchIntel(marketLabel, suburb, state, ptype) {
  if (!suburb) return null;
  const reg = CFG.regions.find(r => r.label === marketLabel);
  const out = { asof: new Date().toISOString().slice(0, 10), ptype };
  if (reg) { const key = reg.slug + '-' + (ptype === 'U' ? 'u' : 'h'); if (!scoresCache.has(key)) { const { data } = await sb.from('suburb_scores').select('payload').eq('key', key).maybeSingle(); scoresCache.set(key, (data && data.payload && data.payload.rows) || []); }
    const row = scoresCache.get(key).find(r => String(r.suburb || '').toLowerCase() === suburb.toLowerCase());
    if (row) out.scores = { lt: row.lt, quality: row.quality, yield: row.yield, price: row.price, rent: row.rent, dom: row.dom, demand: row.demand, runway: row.runway, rec: row.rec, topPrice: row.topPrice, source: 'suburb_scores/' + key }; }
  try { let q = sb.from('forge_cl_suburbs').select('month,postcode,lga,metrics').eq('level', 'suburb').eq('ptype', ptype).ilike('name', suburb).order('month', { ascending: false }).limit(1); if (state) q = q.eq('state', state); const { data } = await q;
    if (data && data[0]) { const m = data[0].metrics || {}; out.cl = { month: data[0].month, lga: data[0].lga, postcode: data[0].postcode, med12: m.med12, med3: m.med3, medChg12: m.medChg12, medChg36: m.medChg36, medChg60: m.medChg60, cagr5: m.cagr5, cagr10: m.cagr10, cagr20: m.cagr20, cagr3_derived: m.medChg36 != null ? Math.pow(1 + m.medChg36, 1 / 3) - 1 : null, dom: m.dom, rent: m.rent, rentChg12: m.rentChg12, yield: m.yield, avm: m.avm, p25: m.p25, p75: m.p75, income: m.income, distCbd: m.dist, holdPeriod: m.holdPeriod, sales12: m.sales12, listings: m.listings1 }; } } catch (e) {}
  return (out.scores || out.cl) ? out : null;
}
const intelAutoMap = ss => { const sc = (ss && ss.scores) || {}, cl = (ss && ss.cl) || {}; return { suburbYield: cl.yield != null ? cl.yield : sc.yield, cagr3: cl.cagr3_derived, cagr5: cl.cagr5, cagr10: cl.cagr10, cagr20: cl.cagr20, ltCagr: sc.lt, suburbRating: sc.quality, dom: cl.dom != null ? cl.dom : sc.dom, suburbRent: cl.rent != null ? cl.rent : sc.rent, suburbMedian: cl.med12 != null ? cl.med12 : sc.price, avm: cl.avm, p25: cl.p25, p75: cl.p75 }; };

// ── assemble Builder rows ─────────────────────────────────────────────────────
function marketFor(parsed, csv) {
  const st = parsed.addr && parsed.addr.state, pc = parsed.addr && parsed.addr.postcode;
  let label = (csv && csv.market && CFG.regions.find(r => r.label === csv.market)) ? csv.market : null;
  if (!label) label = inferMarket(st, pc);
  if (!label && parsed.ddRegion && CFG.regions.find(r => r.label === parsed.ddRegion)) label = parsed.ddRegion;
  const reg = CFG.regions.find(r => r.label === label);
  return { label: label || parsed.ddRegion || null, slug: reg ? reg.slug : null, state: st || (reg ? reg.state : null) };
}
/* suburb → state/postcode from the Cotality suburb store (for addresses that
   carry no state, e.g. wholesale estate lots) */
async function resolveSuburbState(suburb) {
  if (!suburb) return null;
  const { data } = await sb.from('forge_cl_suburbs').select('state,postcode,month').eq('level', 'suburb').ilike('name', suburb).order('month', { ascending: false }).limit(5);
  const hit = (data || []).find(r => r.state); return hit ? { state: hit.state, postcode: hit.postcode ? String(hit.postcode).padStart(4, '0') : null } : null;
}
async function assemble(parsed, csv) {
  if (parsed.addr && parsed.addr.suburb && !parsed.addr.state) { const r = await resolveSuburbState(parsed.addr.suburb); if (r) { parsed.addr.state = r.state; parsed.addr.postcode = parsed.addr.postcode || r.postcode; parsed.addr.full = [parsed.addr.street, parsed.addr.suburb, [r.state, parsed.addr.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', '); } }
  const addr = parsed.addr || {}; const mk = parsed.kind === 'wholesale' && !parsed.addr ? { label: 'Wholesale', slug: null, state: null } : marketFor(parsed, csv);
  const label = parsed.kind === 'wholesale' && !parsed.addr ? ('Wholesale example — ' + basename(parsed.file, '.pdf').replace(/^Wholesale Investment Report\s*/i, '').replace(/[_]/g, ' / ').replace(/\s*\(\d+\)\s*$/, '')) : addr.street;
  const row = { address: label, suburb: addr.suburb || null, state: mk.state || addr.state || null, postcode: addr.postcode || null, market_label: mk.label, market_slug: mk.slug, status: 'active', roles: parsed.roles || {}, setup: {}, dd: { items: parsed.dd || {} }, inspection: parsed.inspection || { rooms: {} }, grading: {}, pricing: parsed.pricing || { adopted: {}, compRents: [], compSales: [], history: [], streetSales: [], suburb: {} }, cashflow: parsed.cashflow || {}, compliance: {}, suburb_stats: {} };
  const s = row.setup;
  if (parsed.kind === 'residential') {
    const pt = parsed.grading['Property Type'] || null;
    s.propertyType = pt ? (/apartment|flat/i.test(pt) ? 'Unit' : pt) : (Object.values(parsed.dd || {}).some(d => /is a unit|is an apartment/i.test(d.notes || '')) ? 'Unit' : 'House');
    s.beds = parsed.beds ?? parsed.inspection.beds ?? null; s.baths = parsed.baths ?? parsed.inspection.baths ?? null; s.cars = parsed.cars ?? parsed.inspection.cars ?? null; s.living = parsed.living ?? parsed.inspection.living ?? null;
    s.landSize = parsed.landSize ?? null; if (parsed.landNote) s.landSizeNote = parsed.landNote;
    s.strategy = parsed.strategy || parsed.gradStrategy || null; s.listingUrl = parsed.listingUrl || null; s.crmUrl = null; s.driveUrl = (csv && csv.link) || null; s.lga = (csv && csv.lga) || null;
    row.grading = { items: parsed.grading, propertyGrade: parsed.propertyGrade || parsed.gradPropertyGrade || parsed.pricePropertyGrade || null, strategy: parsed.strategy || parsed.gradStrategy || null, suburbRating: parsed.suburbRating || parsed.gradSuburbRating || parsed.priceSuburbGrade || null };
    if (parsed.agentRentAppraisal && !row.inspection.agentRent) row.inspection.agentRent = parsed.agentRentAppraisal;
    if (parsed.complianceItems && Object.keys(parsed.complianceItems).length) row.compliance.items = parsed.complianceItems;
    if (parsed.ddResult) row.dd.result = parsed.ddResult;
  } else if (parsed.kind === 'commercial') {
    const csvType = csv && csv.commercialType; const txt = (parsed.strategyLines.join(' ') + ' ' + parsed.attributes.join(' ')).toLowerCase();
    s.propertyType = csvType ? (/^medical/i.test(csvType) ? 'Medical' : csvType.replace(/\s*\/.*$/, '')) : (parsed.units_n ? 'Unit Block' : /warehouse|industrial/.test(txt) ? 'Industrial' : /medical|clinic|pathology/.test(txt) ? 'Medical' : /office/.test(txt) ? 'Office' : /retail|shop/.test(txt) ? 'Retail' : 'Commercial');
    s.commercial = true; s.units = parsed.units_n ?? null; s.beds = parsed.beds ?? null; s.baths = parsed.baths ?? null; s.cars = parsed.cars ?? null; s.landSize = parsed.landSize ?? null;
    if (parsed.buildingArea != null) s.buildingArea = parsed.buildingArea; if (parsed.warehouseArea != null) s.warehouseArea = parsed.warehouseArea; if (parsed.officeArea != null) s.officeArea = parsed.officeArea;
    s.tenants = parsed.tenants || (parsed.lease && parsed.lease.lessee) || null; s.zoning = parsed.zoning || null;
    s.attributes = parsed.attributes.join('. ').replace(/\.\./g, '.') || null; s.strategy = parsed.strategyHeadline || parsed.matrixStrategy || (csv && csv.strategy) || null; s.strategyDetail = [parsed.strategyHeadline ? parsed.strategyHeadline + ':' : null, ...parsed.strategyLines].filter(Boolean).join(' ') || null; if (parsed.matrixStrategy) s.matrixStrategy = parsed.matrixStrategy;
    s.listingUrl = null; s.crmUrl = null; s.driveUrl = (csv && csv.link) || null; s.lga = (csv && csv.lga) || null;
    if (parsed.lease) s.lease = parsed.lease; if (parsed.tenantRow) s.tenantSchedule = parsed.tenantRow; if (parsed.units.length) s.unitSchedule = parsed.units; if (parsed.outgoings.length) s.outgoings = { lines: parsed.outgoings, total: parsed.totalOutgoings, recoverable: parsed.recoverableOutgoings, unrecoverable: parsed.unrecoverableOutgoings };
    row.grading = { items: parsed.grading, propertyGrade: parsed.propertyGrade || null, riskRating: parsed.riskRating || null, overallRating: parsed.overallRating || null, strategy: s.strategy, suburbRating: null, yieldExpectation: parsed.yieldExpectation || null };
    const storeys = (parsed.strategyLines.join(' ').match(/\b(Two|Three|Single|One|Double)[- ]Storey/i) || [])[1]; const built = (parsed.strategyLines.join(' ').match(/Built (?:in )?(?:circa|approx\.?|approximately)?\s*(\d{4})\*?/i) || [])[1];
    row.inspection = { condition: null, occupancy: parsed.tenants || parsed.units.length ? 'Rented - Leased' : null, roofMaterial: (parsed.attributes.find(a => /roof/i.test(a)) || null), storeys: storeys ? ({ single: '1', one: '1', two: '2', double: '2', three: '3' })[storeys.toLowerCase()] : null, wallMaterial: (parsed.strategyLines.join(' ').match(/\b(solid brick|brick veneer|brick|tilt slab|concrete|weatherboard|besser block|beso brick|rendered)\b/i) || [])[1] || null, yearBuilt: built ? 'Circa ' + built : null, summaryNotes: s.strategyDetail, rooms: {} };
    const ad = row.pricing.adopted;
    ad.topPrice = ad.topPrice ?? parsed.topPrice ?? null; ad.comparable = ad.summationAdoptedValue ?? ad.glaAdoptedValue ?? ad.capitalisationAdoptedValue ?? null;
    if (parsed.capitalValue != null) { if (parsed.capitalValueBasis === 'per unit') ad.capitalValuePerUnit = parsed.capitalValue; else ad.capitalValuePerSqm = parsed.capitalValue; }
    if (parsed.netRent != null) ad.netRentGoingIn = parsed.netRent; if (parsed.netYield != null) ad.netYieldGoingIn = parsed.netYield; if (parsed.marketNetRent != null) ad.marketNetRent = parsed.marketNetRent; if (parsed.marketNetYield != null) ad.marketNetYield = parsed.marketNetYield;
    if (parsed.grossMarketRent != null && ad.grossMarketRent == null) ad.grossMarketRent = parsed.grossMarketRent; if (parsed.grossYield != null) ad.grossYield = parsed.grossYield;
    if (parsed.currentGrossRent != null) ad.currentGrossRent = parsed.currentGrossRent; if (parsed.netRentPerSqm != null) ad.netRentPerSqm = parsed.netRentPerSqm; if (parsed.marketNetRentPerSqm != null) ad.marketNetRentPerSqm = parsed.marketNetRentPerSqm;
    if (parsed.replacementTotal) { ad.replacementCostLow = parsed.replacementTotal.low; ad.replacementCostHigh = parsed.replacementTotal.high; } if (parsed.replacementBuilding) ad.buildingReplacementCost = parsed.replacementBuilding; if (parsed.landValue) ad.landValueRange = parsed.landValue;
    if (parsed.discountToReplacement) ad[parsed.discountIsGrowth ? 'growthToReplacementCost' : 'discountToReplacementCost'] = parsed.discountToReplacement;
    if (ad.marketRentPa != null && ad.grossMarketRent == null && !parsed.units_n) ad.marketNetRent = ad.marketNetRent ?? ad.marketRentPa;
    const cf = row.cashflow; cf.budget = cf.budget ?? ad.topPrice ?? null; cf.loanTermYears = cf.loanTermYears ?? 20; cf.weeksLet = 52; cf.rent = cf.rent ?? (parsed.currentGrossRent != null ? Math.round(parsed.currentGrossRent / 52) : (parsed.netRent != null ? Math.round(parsed.netRent / 52) : null));
    for (const k of ['cosmeticWorks', 'depreciationSchedule', 'engagementFee', 'landTax', 'lettingFeeWeeks', 'maintenanceAllowance', 'minRentalStdCost', 'pmFeePct', 'professionalClean', 'repairsPctOfRent', 'strata', 'insurance', 'councilWater']) if (cf[k] == null) cf[k] = 0;
    row.cashflowMeta = parsed.cashflowMeta;
  } else if (parsed.kind === 'wholesale') {
    const fname = basename(parsed.file, '.pdf'); const typeM = fname.match(/(House_Villa|House_Townhouse|Townhouse|Villa|House)/i);
    s.propertyType = parsed.grading['Property Type'] || (typeM ? typeM[1].replace('House_', '').replace(/_/g, '/') : 'House'); s.wholesale = true;
    s.beds = parsed.beds ?? null; s.baths = parsed.baths ?? null; s.cars = parsed.cars ?? null; s.living = parsed.living ?? null; s.landSize = parsed.landSize ?? null;
    s.strategy = parsed.strategy || 'Wholesale Trading'; s.listingUrl = null; s.crmUrl = null; s.driveUrl = (csv && csv.link) || null; s.lga = null;
    if (parsed.addr && parsed.addr.estateNote) s.estate = parsed.addr.estateNote; if (parsed.addr && parsed.addr.suburbInferred) s.suburbInferred = true;
    if (parsed.cashflowMeta && parsed.cashflowMeta.landValue != null) { s.landValue = parsed.cashflowMeta.landValue; s.buildValue = parsed.cashflowMeta.buildValue; }
    row.grading = { items: parsed.grading, propertyGrade: parsed.propertyGrade || null, strategy: parsed.strategy || parsed.gradStrategy || null, suburbRating: parsed.suburbRating || null };
    row.inspection = { rooms: {}, summaryNotes: 'Wholesale (new build) example — ' + fname };
    if (parsed.ddResult) row.dd.result = parsed.ddResult;
    row.cashflowMeta = parsed.cashflowMeta;
  }
  // suburb intelligence → suburb_stats + prefills (workbook values win)
  const ptype = /unit|apartment|townhouse|villa|block/i.test(s.propertyType || '') ? 'U' : 'H';
  if (row.suburb && row.market_label && row.market_label !== 'Wholesale') {
    const ss = await fetchIntel(row.market_label, row.suburb, row.state, ptype);
    if (ss) { row.suburb_stats = ss; const auto = intelAutoMap(ss); const subj = { ...(row.pricing.suburb || {}) }; for (const [k, v] of Object.entries(auto)) { if (k === 'suburbRating') continue; if (v != null && (subj[k] == null || subj[k] === '')) subj[k] = v; } row.pricing.suburb = subj;
      if (!row.grading.suburbRating && auto.suburbRating) row.grading.suburbRating = auto.suburbRating; if (!s.lga && ss.cl && ss.cl.lga) s.lga = ss.cl.lga.replace(/\s*\(.*\)\s*$/, ''); }
  }
  row.provenance = { importedFrom: parsed.file, importedAt: new Date().toISOString(), kind: parsed.kind, preparedISO: parsed.preparedISO || null, preparedBy: parsed.preparedBy || null, csvMatched: !!csv, warnings: parsed.warn };
  return row;
}

// ── main ──────────────────────────────────────────────────────────────────────
await loadConfig();
const register = loadRegister(FOLDER);
const files = readdirSync(FOLDER).filter(f => /\.(xlsx|pdf)$/i.test(f) && !/^~\$/.test(f) && (!ONLY || f.toLowerCase().includes(ONLY.toLowerCase()))).sort();
console.log(`folder: ${FOLDER}\nfiles: ${files.length} (${files.filter(f => /\.xlsx$/i.test(f)).length} xlsx, ${files.filter(f => /\.pdf$/i.test(f)).length} pdf) · register rows: ${register.rows.length}${WRITE ? '' : ' · DRY RUN'}${PUBLISH ? ' · PUBLISH' : ''}`);
const { data: existingFiles } = await sb.from('ir_files').select('id,address,suburb,state,compliance,setup');
const existingByKey = new Map(); for (const r of (existingFiles || [])) existingByKey.set(addrKey(r.address, r.suburb), r);
const { data: libRows } = await sb.from('investment_reports').select('id,address,suburb,link_url,budget,sold_date,domain,segment,strategy,market_label,lga,notes,metrics,source');
const libByKey = new Map(); for (const r of (libRows || [])) { if (r.address) { const a = parseAddress(r.address); if (a) libByKey.set(addrKey(a.street, a.suburb), r); } }
const libByLink = new Map(); for (const r of (libRows || [])) if (r.link_url) libByLink.set(r.link_url.replace(/\/view.*$/, ''), r);

const parsedAll = [];
for (const f of files) {
  const full = join(FOLDER, f);
  try {
    let parsed, images = [];
    if (/\.xlsx$/i.test(f)) parsed = parseResidentialXlsx(full);
    else { const pdf = await readPdf(full, !NO_PHOTOS); const isWholesale = /wholesale/i.test(f) || (pdf.pages[0] || []).some(l => /Wholesale Trading/i.test(l)); parsed = isWholesale ? parseWholesalePdf(pdf.pages, full) : parseCommercialPdf(pdf.pages, full); images = pdf.images; parsed.pageCount = pdf.n; }
    parsed.mtime = statSync(full).mtimeMs; parsed.path = full; parsed.pdfImages = images;
    parsedAll.push(parsed);
  } catch (e) { console.log('  ✗ ' + f + ': ' + e.message); parsedAll.push({ kind: 'error', file: f, warn: [e.message] }); }
}
// dedupe by address (later file wins); wholesale files dedupe by content size+name stem
const byKey = new Map();
for (const p of parsedAll) { if (p.kind === 'error') continue; const key = p.addr ? addrKey(p.addr.street, p.addr.suburb) : ('file:' + basename(p.file).replace(/\s*\(\d+\)\s*(?=\.pdf$)/i, '').toLowerCase()); const prev = byKey.get(key); if (!prev || (p.mtime || 0) > (prev.mtime || 0)) { if (prev) prev.duplicateOf = p.file; byKey.set(key, p); } else p.duplicateOf = prev.file; p.key = key; }

const preview = [];
const fmt = v => v == null ? '—' : typeof v === 'number' ? (v >= 1000 ? Math.round(v).toLocaleString('en-AU') : String(v)) : String(v);
console.log('\n' + 'address'.padEnd(44) + 'market'.padEnd(11) + 'type'.padEnd(12) + 'top price'.padStart(10) + 'rent'.padStart(7) + 'grade'.padEnd(18) + 'sub.rating'.padEnd(18) + 'comps'.padStart(6) + 'photos'.padStart(7) + 'csv'.padStart(4) + 'lib'.padStart(4) + 'existing'.padStart(9) + '  warnings');
const plan = [];
for (const p of parsedAll) {
  if (p.kind === 'error') { console.log('  ERROR '.padEnd(44) + p.file + ' — ' + p.warn.join('; ')); continue; }
  if (p.duplicateOf) { console.log(('  dup → ' + p.duplicateOf).padEnd(44) + p.file); continue; }
  let csv = p.key && register.byKey.get(p.key) || null;
  if (!csv && p.kind === 'wholesale') { const stem = basename(p.file, '.pdf').toLowerCase(); csv = register.rows.find(r => r.section && /wholesale/i.test(r.section) && r.market && (stem.includes(r.market.toLowerCase().replace(/wholesale investment report\s*/i, '').replace(/\.pdf$/, '').replace(/_/g, ' ').replace(/house.villa/, 'house_villa')) || (r.budget && (stem.includes('$' + Math.round(r.budget / 1000) + 'k') || stem.includes('$' + (r.budget / 1e6) + 'm'))))) || null; }
  const row = await assemble(p, csv);
  const lib = (p.key && libByKey.get(p.key)) || (csv && csv.link && libByLink.get(csv.link.replace(/\/view.*$/, ''))) || null;
  const existing = p.key ? existingByKey.get(p.key) : null;
  const ad = row.pricing.adopted || {};
  console.log(((row.address || '?') + (row.suburb ? ', ' + row.suburb : '')).slice(0, 43).padEnd(44) + String(row.market_label || '?').padEnd(11) + String(row.setup.propertyType || '?').slice(0, 11).padEnd(12) + fmt(ad.topPrice).padStart(10) + fmt(row.cashflow.rent).padStart(7) + String(row.grading.propertyGrade || '—').slice(0, 17).padEnd(18) + String(row.grading.suburbRating || '—').slice(0, 17).padEnd(18) + String((row.pricing.compSales || []).length).padStart(6) + String((p.photos || []).length + (p.pdfImages || []).length).padStart(7) + (csv ? '  ✓' : '  ·').padStart(4) + (lib ? '  ✓' : '  ·').padStart(4) + (existing ? (REFRESH ? '  refresh' : '     skip') : '      new') + '  ' + (p.warn || []).join('; '));
  plan.push({ p, row, csv, lib, existing });
  preview.push({ file: p.file, key: p.key, csv: csv ? { market: csv.market, soldISO: csv.soldISO, budget: csv.budget, strategy: csv.strategy, link: csv.link } : null, lib: lib ? { id: lib.id, address: lib.address, budget: lib.budget, sold_date: lib.sold_date } : null, existing: existing ? existing.id : null, row: { ...row, pricing: { ...row.pricing }, suburb_stats: row.suburb_stats && { asof: row.suburb_stats.asof, has: { scores: !!row.suburb_stats.scores, cl: !!row.suburb_stats.cl } } }, photos: (p.photos || []).map(x => x.label + '.' + x.ext + ' ' + Math.round(x.bytes.length / 1024) + 'KB').concat((p.pdfImages || []).map(x => x.kind + ' ' + x.w + 'x' + x.h + ' drawn ' + Math.round(x.drawnW) + 'x' + Math.round(x.drawnH))) });
}
writeFileSync('scratch/_ir-import-preview.json', JSON.stringify(preview, null, 1));
console.log(`\npreview → scratch/_ir-import-preview.json (${plan.length} properties)`);
const unmatchedCsv = register.rows.filter(r => r.addr && !plan.some(x => x.csv === r));
console.log(`register rows without a file in this folder: ${unmatchedCsv.length}` + (unmatchedCsv.length ? ' (e.g. ' + unmatchedCsv.slice(0, 5).map(r => r.address).join(' · ') + ')' : ''));

if (!WRITE) { if (browser) await browser.close(); console.log('\nDry run. Re-run with --write to load the IR Builder' + ', --write --publish to also publish to the IR Library.'); process.exit(0); }

// ── write ─────────────────────────────────────────────────────────────────────
const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const stamp = () => new Date().toISOString();
let nNew = 0, nUpd = 0, nSkip = 0, nPub = 0, nPhotos = 0; const errors = [];
for (const item of plan) {
  const { p, row, csv, lib, existing } = item;
  try {
    if (existing && !REFRESH) { nSkip++; continue; }   // a row the team already keyed by hand — leave it (and its publish stamp) alone
    let fileId = existing ? existing.id : null;
    const cols = { address: row.address, suburb: row.suburb, state: row.state, postcode: row.postcode, market_slug: row.market_slug, market_label: row.market_label, roles: row.roles, setup: { ...row.setup, importedFrom: row.provenance.importedFrom, importedAt: row.provenance.importedAt, preparedAt: row.provenance.preparedISO, preparedBy: row.provenance.preparedBy }, dd: row.dd, inspection: row.inspection, grading: row.grading, pricing: row.pricing, cashflow: row.cashflow, suburb_stats: row.suburb_stats || {} };
    if (row.cashflowMeta && Object.keys(row.cashflowMeta).length) cols.cashflow = { ...cols.cashflow, sourceSummary: row.cashflowMeta };
    if (!existing) { const { data, error } = await sb.from('ir_files').insert({ ...cols, status: 'active', compliance: row.compliance }).select('id').single(); if (error) throw new Error('insert: ' + error.message); fileId = data.id; nNew++; }
    else if (REFRESH) { const { error } = await sb.from('ir_files').update(cols).eq('id', fileId); if (error) throw new Error('update: ' + error.message); nUpd++; }
    item.fileId = fileId;
    // photos (skip if the row already has some)
    const existingPhotos = (existing && existing.setup && existing.setup.photos) || [];
    if (!NO_PHOTOS && !existingPhotos.length) {
      const photos = [];
      const upload = async (label, ext, bytes) => { const path = fileId + '/photos/' + Date.now() + '-' + label + '.' + ext; const { error } = await sb.storage.from('ir-evidence').upload(path, bytes, { contentType: ext === 'png' ? 'image/png' : 'image/jpeg', upsert: false }); if (error) { errors.push(p.file + ' photo ' + label + ': ' + error.message); return; } photos.push({ path, name: label + '.' + ext, at: stamp() }); nPhotos++; };
      for (const ph of (p.photos || [])) await upload(ph.label, ph.ext, Buffer.from(ph.bytes));
      if (p.pdfImages && p.pdfImages.length) { const cover = p.pdfImages.filter(i => i.kind === 'cover').sort((a, b) => (b.drawnW * b.drawnH) - (a.drawnW * a.drawnH)); const plans = p.pdfImages.filter(i => i.kind === 'plan').sort((a, b) => (b.drawnW * b.drawnH) - (a.drawnW * a.drawnH));
        if (cover[0]) await upload('exterior', 'jpg', Buffer.from(cover[0].dataUrl.split(',')[1], 'base64'));
        for (const [i, im] of cover.slice(1, 4).entries()) await upload('interior-' + (i + 1), 'jpg', Buffer.from(im.dataUrl.split(',')[1], 'base64'));
        if (plans[0]) await upload('floor-plan', 'jpg', Buffer.from(plans[0].dataUrl.split(',')[1], 'base64')); }
      if (photos.length) { const { error } = await sb.from('ir_files').update({ setup: { ...cols.setup, photos } }).eq('id', fileId); if (error) errors.push(p.file + ' photos save: ' + error.message); }
    }
    // publish
    if (PUBLISH) {
      const { data: cur } = await sb.from('ir_files').select('compliance,setup,pricing,grading,cashflow,address,suburb,state,postcode,market_label,market_slug').eq('id', fileId).single();
      const pub = (cur.compliance || {}).published || null;
      const ad = (cur.pricing || {}).adopted || {}; const top = ad.topPrice ?? (cur.cashflow || {}).budget ?? (csv && csv.budget) ?? null;
      const domain = cur.setup && cur.setup.wholesale ? 'wholesale' : (cur.setup && cur.setup.commercial ? 'commercial' : 'residential');
      const fullAddr = [cur.address, cur.suburb, [cur.state, cur.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      const soldISO = (lib && lib.sold_date) || (csv && csv.soldISO) || (pub && pub.sold_date) || null;
      let pdfPath = pub && pub.pdf || null;
      if (/\.pdf$/i.test(p.file) && !pdfPath) { pdfPath = 'published/' + fileId + '/IR-' + slugify(cur.address) + '-' + Date.now() + '.pdf'; const { error } = await sb.storage.from('ir-library').upload(pdfPath, readFileSync(p.path), { contentType: 'application/pdf' }); if (error) { errors.push(p.file + ' pdf: ' + error.message); pdfPath = null; } }
      const metrics = { ...((lib && lib.metrics) || {}) }; const rent = ad.rent ?? (cur.cashflow || {}).rent; const grossPa = ad.grossMarketRent ?? (rent && cur.setup && !cur.setup.commercial ? rent * 52 : null);
      if (grossPa && top) metrics.gross_yield_pct = +((grossPa / top) * 100).toFixed(2); if (ad.netYieldGoingIn != null) metrics.net_yield_pct = +(ad.netYieldGoingIn * 100).toFixed(2); else if (row.cashflowMeta && row.cashflowMeta.netYield != null) metrics.net_yield_pct = +(row.cashflowMeta.netYield * 100).toFixed(2);
      if (pdfPath) metrics.report_pdf = pdfPath; metrics.imported_from = p.file;
      const rec = { domain, market_label: cur.market_label, market_slug: cur.market_slug, segment: segmentOf(cur.setup && cur.setup.propertyType, csv && csv.commercialType), strategy: strategyOf((cur.grading || {}).strategy || (cur.setup || {}).strategy, csv && csv.strategy), budget: top, address: fullAddr, suburb: cur.suburb, state: cur.state, lga: (cur.setup || {}).lga || null, sold_date: soldISO, link_url: (csv && csv.link) || null, notes: (csv && csv.notes) || null, status: 'current', source: 'ir-builder' };
      let libId;
      if (lib) { const patch = {}; for (const [k, v] of Object.entries(rec)) if (v != null) patch[k] = v; if (lib.sold_date) delete patch.sold_date; if (lib.link_url) delete patch.link_url; if (lib.notes) delete patch.notes; if (lib.lga) delete patch.lga;
        if (lib.segment) delete patch.segment; if (lib.domain) delete patch.domain;   // the library's own classification stands (seed rows were filed by the register's sections)
        if (lib.budget != null && lib.budget !== patch.budget) metrics.register_budget = lib.budget;   // keep the register's figure visible when the IR's top price differs
        patch.metrics = { ...(lib.metrics || {}), ...metrics }; const { error } = await sb.from('investment_reports').update(patch).eq('id', lib.id); if (error) throw new Error('library update: ' + error.message); libId = lib.id; }
      else { const { data, error } = await sb.from('investment_reports').insert({ ...rec, metrics }).select('id').single(); if (error) throw new Error('library insert: ' + error.message); libId = data.id; }
      const comp = { ...(cur.compliance || {}), published: { at: stamp(), libraryId: libId, sold_date: soldISO, price_paid: pub && pub.price_paid != null ? pub.price_paid : null, pdf: pdfPath, importedFrom: p.file } };
      const { error: e2 } = await sb.from('ir_files').update({ compliance: comp, status: 'final' }).eq('id', fileId); if (e2) throw new Error('publish stamp: ' + e2.message);
      nPub++;
    }
  } catch (e) { errors.push(p.file + ': ' + e.message); }
}
if (browser) await browser.close();
console.log(`\n✓ ir_files: ${nNew} inserted, ${nUpd} refreshed, ${nSkip} already present${REFRESH ? '' : ' (skipped)'} · photos uploaded: ${nPhotos}` + (PUBLISH ? ` · published: ${nPub}` : ''));
if (errors.length) { console.log('\nERRORS (' + errors.length + '):'); errors.forEach(e => console.log('  ' + e)); }
