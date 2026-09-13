// =============================================================================
// apply-ai-ceilings.mjs — write the 3-peak AI ceilings from the AI Ceiling workbook
// into rdp_runway_config.ai_ceiling (the constant the runway mart is built from).
//
// Prepared 2026-09-13 for the decision Van is taking to Saskia/Shaene (IC item 4,
// parked 09-08: "apply at the September publish"). Source = the workbook's
// "AI - Summary" sheet in its 2026-09 layout:
//   A Market | B Type (H/U) | C Currently used ceiling | D runway @ current rate |
//   E 3-peak average, EXCLUDING 2026 | F runway @ 4.90% | G/H the same at the 3-peak | I diff
// Section rows ("Capital cities", "Regional …") carry no Type and are skipped.
//
// What --write does (nothing happens without it):
//   1. copies the current ai_ceiling value to a new config key ai_ceiling_backup_<YYYYMMDD>
//      (rdp_runway_config is key/value — the backup lives next to it, restorable in one update)
//   2. rewrites ai_ceiling with the 72 col-E values (36 markets × h/u)
// It does NOT rebuild the mart: PUBLISH's build-runway step does that (or a targeted
// `node scripts/build-runway.mjs --write` if the team wants it off-cycle). After the
// rebuild, run `node scripts/rerate-runway-snapshots.mjs` for the history, then
// `node scripts/apply-ai-ceilings.mjs --verify` to compare the mart with the sheet.
//
//   node scripts/apply-ai-ceilings.mjs               # diff: sheet col E v config, movers, sanity
//   node scripts/apply-ai-ceilings.mjs --write       # backup + write the 72 ceilings
//   node scripts/apply-ai-ceilings.mjs --verify      # after the mart rebuild: mart runway v sheet cols D/F (or G/H)
//   node scripts/apply-ai-ceilings.mjs --restore=ai_ceiling_backup_20260914 --write   # put a backup back
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const VERIFY = process.argv.includes('--verify');
// --from-hub: recompute the 3-peak from the hub's own affordability-index history
// (rdp_report_feed years[].ai_pi_house / ai_pi_unit = annual P&I ÷ annual income, the
// sheet's definition; years ≤ EXCLUDE_FROM − 1, top three averaged). Shaene, 2026-09-14:
// "column E is the new ceiling, but recompute it because the hub's data may differ" —
// the hub's newer 2023–25 medians/incomes lift 34 of 72 series by up to 2.9 pt. The
// sheet still gates the run (its market list and "currently used" column) and is shown
// beside the hub figure for the record.
const FROM_HUB = process.argv.includes('--from-hub');
const EXCLUDE_FROM = 2026;   // "excluding the current year"
const RESTORE = (process.argv.find(a => a.startsWith('--restore=')) || '').split('=')[1] || null;
const FILE = (process.argv.find(a => a.startsWith('--file=')) || '').split('=')[1] || join(homedir(), 'Downloads', 'AI Ceiling (Average).xlsx');
const SHEET = 'AI - Summary';
const slugify = s => String(s).trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pct = v => v == null ? '  —  ' : (v * 100).toFixed(1).padStart(5) + '%';
const num = v => { if (typeof v === 'number') return v; const s = String(v ?? '').replace(/[−–]/g, '-').replace(/[%,\s]/g, ''); if (!s) return null; const n = parseFloat(s); if (!Number.isFinite(n)) return null; return /%/.test(String(v)) ? n / 100 : n; };

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

// ── config ──
const { data: cfgRows, error: cerr } = await sb.from('rdp_runway_config').select('key,value,updated_at');
if (cerr) { console.error(cerr.message); process.exit(1); }
const cfg = Object.fromEntries((cfgRows || []).map(r => [r.key, r.value]));
const current = cfg.ai_ceiling || {};
const backups = (cfgRows || []).filter(r => /^ai_ceiling_backup_/.test(r.key)).map(r => r.key).sort();

// ── restore path ──
if (RESTORE) {
  const bk = cfg[RESTORE]; if (!bk) { console.error(`no config key ${RESTORE}; backups present: ${backups.join(', ') || 'none'}`); process.exit(1); }
  console.log(`Restoring ai_ceiling from ${RESTORE} (${Object.keys(bk).length} markets)`);
  if (!WRITE) { console.log('Dry run — add --write to restore.'); process.exit(0); }
  const { error } = await sb.from('rdp_runway_config').update({ value: bk, updated_at: new Date().toISOString() }).eq('key', 'ai_ceiling');
  if (error) { console.error(error.message); process.exit(1); }
  console.log('✓ restored. Rebuild the mart (PUBLISH or build-runway --write) and re-rate the snapshots back.');
  process.exit(0);
}

// ── sheet ──
if (!existsSync(FILE)) { console.error('workbook not found: ' + FILE + '  (pass --file=<path>)'); process.exit(1); }
const wb = XLSX.readFile(FILE);
if (!wb.SheetNames.includes(SHEET)) { console.error(`sheet "${SHEET}" not in the workbook (${wb.SheetNames.join(', ')})`); process.exit(1); }
const g = XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { header: 1, defval: '' });
const hdr = g[0].map(h => String(h).toLowerCase());
if (!/market/.test(hdr[0]) || !/type/.test(hdr[1]) || !/currently used/.test(hdr[2]) || !/3-peak/.test(hdr[4])) { console.error('unexpected header row — layout changed? ' + JSON.stringify(g[0].slice(0, 6))); process.exit(1); }
const rows = [];   // { slug, market, t, cur, p3, rwCur672, rwCur490, rwP3_672, rwP3_490 }
for (const r of g.slice(1)) {
  const t = String(r[1] || '').trim().toUpperCase(); if (t !== 'H' && t !== 'U') continue;
  const p3 = num(r[4]), cur = num(r[2]); if (p3 == null) continue;
  rows.push({ slug: slugify(r[0]), market: String(r[0]).trim(), t: t.toLowerCase(), cur, p3, rwCur672: num(r[3]), rwCur490: num(r[5]), rwP3_672: num(r[6]), rwP3_490: num(r[7]) });
}
const slugs = [...new Set(rows.map(r => r.slug))];
const unknown = slugs.filter(s => !current[s]);
const missingFromSheet = Object.keys(current).filter(s => !slugs.includes(s));
console.log(`${FILE.split(/[\\/]/).pop()} · ${SHEET}: ${rows.length} rows, ${slugs.length} markets · config has ${Object.keys(current).length} markets` + (backups.length ? ` · backups: ${backups.join(', ')}` : ''));
if (unknown.length || missingFromSheet.length) { console.error(`✗ market mismatch — not in config: ${unknown.join(', ') || '—'}; not on the sheet: ${missingFromSheet.join(', ') || '—'}`); process.exit(1); }
if (rows.length !== 72) { console.error(`✗ expected 72 rows (36 × H/U), got ${rows.length}`); process.exit(1); }
for (const r of rows) if (r.p3 < 0.2 || r.p3 > 1.2) { console.error(`✗ implausible 3-peak ${r.p3} for ${r.market} ${r.t}`); process.exit(1); }

// ── hub recompute: replace the sheet's col E with the feed's own top-3 mean ──
let basisLabel = 'sheet col E (3-peak average, excluding ' + EXCLUDE_FROM + ')';
if (FROM_HUB) {
  const { data: feeds, error: ferr } = await sb.from('rdp_report_feed').select('region_slug,payload');
  if (ferr) { console.error(ferr.message); process.exit(1); }
  const byRegion = Object.fromEntries((feeds || []).map(f => [f.region_slug, (f.payload && f.payload.years) || []]));
  const top3 = vals => { const v = vals.filter(x => Number.isFinite(x) && x > 0).sort((a, b) => b - a).slice(0, 3); return v.length === 3 ? v.reduce((a, b) => a + b, 0) / 3 : null; };
  let replaced = 0, maxd = ['', 0];
  for (const r of rows) {
    const ys = byRegion[r.slug]; if (!ys) { console.error(`✗ ${r.market}: no report feed row`); process.exit(1); }
    const key = r.t === 'h' ? 'ai_pi_house' : 'ai_pi_unit';
    const hist = ys.filter(y => +y.year < EXCLUDE_FROM).map(y => +y[key]);
    const hub = top3(hist); if (hub == null) { console.error(`✗ ${r.market} ${r.t}: fewer than 3 affordability-index years in the feed`); process.exit(1); }
    r.sheetP3 = r.p3; r.p3 = Math.round(hub * 10000) / 10000; r.hubYears = hist.filter(v => Number.isFinite(v) && v > 0).length; replaced++;
    if (Math.abs(r.p3 - r.sheetP3) > maxd[1]) maxd = [`${r.market} ${r.t.toUpperCase()} ${(r.sheetP3 * 100).toFixed(1)}→${(r.p3 * 100).toFixed(1)}`, Math.abs(r.p3 - r.sheetP3)];
  }
  basisLabel = 'HUB recompute: top-3 mean of rdp_report_feed ai_pi_* over years < ' + EXCLUDE_FROM;
  console.log(`hub recompute: ${replaced} series · biggest difference from the sheet: ${maxd[0]} (${(maxd[1] * 100).toFixed(1)} pt)`);
}

// ── verify mode: mart runway v the sheet ──
if (VERIFY) {
  const { data: mart } = await sb.from('rdp_runway').select('region_slug,payload,computed_at');
  const M = Object.fromEntries((mart || []).map(m => [m.region_slug, m.payload]));
  const rates = cfg.rates || {}; const r672 = rates.current && rates.current.rate, r490 = rates.forecast && rates.forecast.rate;
  console.log(`\nVERIFY — mart (computed ${(mart || [])[0]?.computed_at?.slice(0, 10) || '?'}) v sheet, rates current=${r672} forecast=${r490}`);
  console.log('market            ceiling mart/sheet   runway@cur mart/sheet   runway@fc mart/sheet');
  let bad = 0;
  for (const r of rows) {
    const p = M[r.slug] && M[r.slug][r.t === 'h' ? 'house' : 'unit']; const ceilingMart = M[r.slug] && M[r.slug].ai_ceiling && M[r.slug].ai_ceiling[r.t];
    const usingP3 = ceilingMart != null && Math.abs(ceilingMart - r.p3) < 0.0006;
    const sCur = usingP3 ? r.rwP3_672 : r.rwCur672, sFc = usingP3 ? r.rwP3_490 : r.rwCur490;
    const dCur = (p && sCur != null) ? Math.abs(p.runway_pct - sCur) : null, dFc = (p && sFc != null) ? Math.abs(p.forecast_pct - sFc) : null;
    const flag = (dCur != null && dCur > 0.02) || (dFc != null && dFc > 0.02) ? ' ⚠' : '';
    if (flag) bad++;
    console.log(`${(r.market + ' ' + r.t.toUpperCase()).padEnd(18)}${pct(ceilingMart)} / ${pct(usingP3 ? r.p3 : r.cur)}     ${pct(p && p.runway_pct)} / ${pct(sCur)}       ${pct(p && p.forecast_pct)} / ${pct(sFc)}${flag}`);
  }
  console.log(bad ? `\n⚠ ${bad} series differ from the sheet by more than 2 pt (the sheet's medians/incomes may be a different month — compare inputs before worrying)` : '\n✓ every series within 2 pt of the sheet');
  process.exit(0);
}

// ── diff: sheet col E v config ──
console.log(`\nbasis: ${basisLabel}`);
console.log('market             config → new      move' + (FROM_HUB ? '     sheet E   hub−sheet  yrs' : '') + '    (sheet "currently used" v config)');
let up = 0, down = 0, same = 0, curMismatch = 0; const movers = [];
for (const r of rows) {
  const c = current[r.slug][r.t]; const d = r.p3 - c;
  if (Math.abs(d) < 0.0005) same++; else if (d > 0) up++; else down++;
  if (Math.abs(d) >= 0.05) movers.push(`${r.market} ${r.t.toUpperCase()} ${(d * 100).toFixed(1)}pt`);
  const cm = r.cur != null && Math.abs(r.cur - c) > 0.0006; if (cm) curMismatch++;
  const hubCols = FROM_HUB ? `   ${pct(r.sheetP3)}  ${((r.p3 - r.sheetP3) * 100).toFixed(1).padStart(6)}pt  ${String(r.hubYears).padStart(3)}` : '';
  console.log(`${(r.market + ' ' + r.t.toUpperCase()).padEnd(18)} ${pct(c)} → ${pct(r.p3)}  ${((d) * 100).toFixed(1).padStart(6)}pt${hubCols}${cm ? `   ⚠ sheet says currently ${pct(r.cur)}` : ''}`);
}
console.log(`\n${up} up · ${down} down · ${same} unchanged · movers ≥5pt: ${movers.length ? movers.join(', ') : 'none'}`);
// The sheet's "currently used" column is the gate that the workbook is current. Once
// a 3-peak has been applied the live config no longer equals that column, so the gate
// is only enforced while the config still holds the pre-3-peak values (no backup key yet).
const alreadyApplied = backups.length > 0;
console.log(curMismatch ? (alreadyApplied ? `ℹ sheet "currently used" differs from the live config on ${curMismatch} series — expected, a 3-peak set is already applied (backup ${backups[0]} holds the originals)` : `⚠ ${curMismatch} sheet "currently used" cells differ from the live config — check the workbook is the current one`) : '✓ the sheet\'s "currently used" column matches the live config for all 72');

if (!WRITE) { console.log('\nDry run. --write writes the 72 ceilings (the ORIGINAL config is backed up once, under ai_ceiling_backup_<date>, and never overwritten); then PUBLISH (or build-runway --write) rebuilds the mart.'); process.exit(0); }
if (curMismatch && !alreadyApplied) { console.error('✗ refusing to write while the sheet\'s "currently used" disagrees with the live config'); process.exit(1); }
const now = new Date().toISOString(); const stamp = now.slice(0, 10).replace(/-/g, '');
const next = JSON.parse(JSON.stringify(current));
for (const r of rows) next[r.slug][r.t] = Math.round(r.p3 * 10000) / 10000;
// back up ONCE: the first backup key holds the pre-3-peak originals and is what the
// snapshot re-rate uses as OLD; a re-apply (e.g. a hub recompute over a sheet apply)
// must not replace it with intermediate values. (updated_by is a uuid column — left null.)
let bkKey = backups[0];
if (!bkKey) {
  bkKey = `ai_ceiling_backup_${stamp}`;
  const { error: e1 } = await sb.from('rdp_runway_config').upsert({ key: bkKey, value: current, updated_at: now }, { onConflict: 'key' });
  if (e1) { console.error(e1.message); process.exit(1); }
} else console.log(`(original ceilings already backed up as ${bkKey} — kept; not overwriting with the current values)`);
const { error: e2 } = await sb.from('rdp_runway_config').update({ value: next, updated_at: now }).eq('key', 'ai_ceiling');
if (e2) { console.error(e2.message); process.exit(1); }
const meta = { basis: FROM_HUB ? 'hub 3-peak' : 'sheet 3-peak', rule: `top-3 mean of the affordability index (annual P&I ÷ annual income), years < ${EXCLUDE_FROM}`, source: FROM_HUB ? 'rdp_report_feed years[].ai_pi_house / ai_pi_unit' : FILE.split(/[\\/]/).pop(), appliedAt: now, originals: bkKey };
const { error: e3 } = await sb.from('rdp_runway_config').upsert({ key: 'ai_ceiling_meta', value: meta, updated_at: now }, { onConflict: 'key' });
if (e3) console.warn('  (ai_ceiling_meta not written: ' + e3.message + ')');
console.log(`\n✓ ai_ceiling rewritten (72 values, ${meta.basis}); originals kept as ${bkKey}.\n  Next: PUBLISH (build-runway rebuilds rdp_runway) → node scripts/rerate-runway-snapshots.mjs --write → node scripts/apply-ai-ceilings.mjs --verify`);
