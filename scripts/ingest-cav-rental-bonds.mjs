// =============================================================================
// ingest-cav-rental-bonds.mjs — Data Forge: RTBA RENTAL BONDS (Victoria).
//
// Residential Tenancies Bond Authority transaction counts, per FINANCIAL YEAR:
//   bonds_lodged · bonds_repaid · bonds_held      (region st-vic, source 'cav')
// The B/S "RTBA Rental Bonds Held" slide derives Gain/Loss = lodged − repaid.
//
// SOURCE — the Consumer Affairs Victoria ANNUAL REPORTS, not an open-data feed.
// data.vic's "Bonds Held Value" CSV is the wrong series and stops at 2018-19;
// the numbers on the slide live in each annual report's "Output performance /
// Transactions" table. Every report publishes THREE financial years, so the
// reports listed on the download page (2014-15 onward) cover 2012-13 → today.
// The Word (.docx) edition is published alongside the PDF and is real XML, so
// this parses that rather than scraping a PDF.
//
//   page: https://www.consumer.vic.gov.au/annual-report/download-annual-reports
//   table rows matched: "Bonds lodged" / "Bond repayments" / "Bonds held",
//   with the FY column headers taken from the table's own header row.
//
// Overlapping years: the NEWEST report wins (later reports restate).
//
// VICTORIA ONLY — RTBA is a Victorian authority. Other states have separate
// bond authorities with no comparable published series (NSW/SA list theirs as
// website links only, QLD and WA publish none), so this is st-vic and the
// slide only renders on Victorian decks.
//
// Stored freq='A' at the FY START month (2024-25 → 2024-07-01) so a financial
// year is never mistaken for a calendar year.
// ISOLATED: rdp_raw_series + forge_data_status. Upsert-only.
// Dry-run by DEFAULT; --write upserts.
//   node scripts/ingest-cav-rental-bonds.mjs [--write]
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' };
const BASE = 'https://www.consumer.vic.gov.au';
const PAGE = BASE + '/annual-report/download-annual-reports';

/* ── minimal ZIP reader (a .docx is a zip) — pure Node, no `unzip` binary and
      no new dependency, so it behaves the same locally and on the CI runner ── */
function zipRead(buf, wanted) {
  // End of Central Directory, scanning back over the comment field
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const lNameLen = buf.readUInt16LE(lho + 26), lExtraLen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lNameLen + lExtraLen;
      const csize = buf.readUInt32LE(p + 20);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  throw new Error(wanted + ' not found in docx');
}

/* ── docx table extraction ─────────────────────────────────────────────── */
// NOTE: match <w:t> exactly — a loose <w:t[^>]*> also matches <w:tcW>, which
// silently returns raw XML instead of text.
const cellText = tc => [...tc.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => m[1]).join('').replace(/\s+/g, ' ').trim();
const FY = /^(20\d\d)[–-](\d\d)$/;
const num = s => { const n = Number(String(s).replace(/[^0-9.-]/g, '')); return isFinite(n) ? n : null; };

function bondsFromDocx(buf) {
  const xml = zipRead(buf, 'word/document.xml').toString('utf8');
  for (const t of [...xml.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)].map(m => m[1])) {
    const rows = [...t.matchAll(/<w:tr[ >]([\s\S]*?)<\/w:tr>/g)]
      .map(m => [...m[1].matchAll(/<w:tc[ >]([\s\S]*?)<\/w:tc>/g)].map(c => cellText(c[1])).filter(Boolean));
    if (!/Bonds? lodge/i.test(rows.flat().join(' '))) continue;
    const hdr = rows.find(r => r.filter(c => FY.test(c)).length >= 2);
    if (!hdr) continue;
    const years = hdr.filter(c => FY.test(c)).map(c => +c.match(FY)[1]);   // FY start year
    const row = re => { const r = rows.find(x => re.test(x[0] || '')); return r ? r.slice(1).map(num) : null; };
    const lodged = row(/^Bonds? lodge/i), repaid = row(/^Bond repayment|^Bonds? repaid/i), held = row(/^Bonds? held/i);
    if (!lodged) continue;
    const out = [];
    years.forEach((y, i) => out.push({ fy: y, lodged: lodged[i] ?? null, repaid: repaid ? repaid[i] ?? null : null, held: held ? held[i] ?? null : null }));
    return out;
  }
  return null;
}

/* ── discover + fetch every annual report ──────────────────────────────── */
const html = await (await fetch(PAGE, { headers: UA, redirect: 'follow' })).text();
const docxLinks = [...new Set([...html.matchAll(/href="([^"]+\.docx)"/gi)].map(m => m[1]))]
  .filter(u => /annual-report|report-on-operations/i.test(u));
if (!docxLinks.length) { console.error('No .docx links found on ' + PAGE + ' — has the page changed?'); process.exit(1); }
console.log('Consumer Affairs Victoria — annual reports: ' + docxLinks.length + ' Word editions found');

/* newest first so later reports win on overlapping years */
const ordered = docxLinks.map(u => ({ u, y: +((u.match(/20(\d\d)[-–]?(\d\d)/) || [])[0] || '').replace(/\D/g, '').slice(0, 4) || 0 }))
  .sort((a, b) => b.y - a.y).map(x => x.u);

const byFy = new Map();          // fy(start year) → {lodged, repaid, held}
for (const path of ordered) {
  const url = path.startsWith('http') ? path : BASE + path;
  try {
    const r = await fetch(url, { headers: UA, redirect: 'follow' });
    if (!r.ok) { console.log('  ' + r.status + '  ' + path.slice(-60)); continue; }
    const rows = bondsFromDocx(Buffer.from(await r.arrayBuffer()));
    if (!rows) { console.log('  no bonds table  ' + path.slice(-60)); continue; }
    let added = 0;
    for (const row of rows) { if (!byFy.has(row.fy)) { byFy.set(row.fy, row); added++; } }
    console.log('  ok  ' + rows.map(r => r.fy + '-' + String(r.fy + 1).slice(2)).join(' ') + '   (+' + added + ' new)   ' + path.split('/').pop().slice(0, 44));
  } catch (e) { console.log('  ERR ' + String(e.message).slice(0, 60) + '  ' + path.slice(-50)); }
}

const fys = [...byFy.keys()].sort((a, b) => a - b);
if (!fys.length) { console.error('No bond data parsed.'); process.exit(1); }

const METRIC = { lodged: 'bonds_lodged', repaid: 'bonds_repaid', held: 'bonds_held' };
const out = [];
for (const fy of fys) {
  const r = byFy.get(fy);
  for (const k of ['lodged', 'repaid', 'held']) {
    if (r[k] == null) continue;
    out.push({ source: 'cav', region_slug: 'st-vic', metric: METRIC[k], freq: 'A', period: fy + '-07-01', value: r[k] });
  }
}

/* ── report ───────────────────────────────────────────────────────────── */
console.log('\nFinancial years: ' + fys.length + '   ' + fys[0] + '-' + String(fys[0] + 1).slice(2) + ' → ' + fys[fys.length - 1] + '-' + String(fys[fys.length - 1] + 1).slice(2));
console.log('Rows: ' + out.length + '   (region st-vic, freq A at the FY start month)\n');
console.log('  FY        lodged    repaid      held   gain/loss');
for (const fy of fys) {
  const r = byFy.get(fy), gl = (r.lodged != null && r.repaid != null) ? r.lodged - r.repaid : null;
  console.log('  ' + (fy + '-' + String(fy + 1).slice(2)).padEnd(9)
    + String(r.lodged ?? '—').padStart(8) + String(r.repaid ?? '—').padStart(10)
    + String(r.held ?? '—').padStart(10) + (gl == null ? '        —' : ((gl >= 0 ? '+' : '') + gl.toLocaleString()).padStart(11)));
}

if (!WRITE) { console.log('\nDry run — nothing written. Re-run with --write to upsert.'); }
else {
  const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exitCode = 1; }
  else {
    const sb = createClient(URL, KEY, { auth: { persistSession: false } });
    const { error } = await sb.from('rdp_raw_series').upsert(out, { onConflict: 'source,region_slug,metric,freq,period' });
    if (error) { console.error('Upsert failed: ' + error.message); process.exitCode = 1; }
    else {
      const now = new Date().toISOString();
      await sb.from('forge_data_status').upsert({
        data_key: 'rental_bonds', label: 'RTBA Rental Bonds (VIC)',
        source: 'Residential Tenancies Bond Authority / Consumer Affairs Victoria annual reports',
        status: 'ok', message: fys.length + ' financial years · to ' + fys[fys.length - 1] + '-' + String(fys[fys.length - 1] + 1).slice(2),
        last_run_at: now, last_ok_at: now, updated_at: now,
      }, { onConflict: 'data_key' });
      console.log('\n✓ Upserted ' + out.length + ' rental-bond rows.');
    }
  }
}
