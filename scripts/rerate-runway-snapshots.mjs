// =============================================================================
// rerate-runway-snapshots.mjs — re-rate the Runway v Demand history after an
// AI-ceiling change, so the 20 monthly captures (Jan-25 → …) and the rvd-* mirrors
// in forge_demand_snapshots sit on the same ceilings as the rebuilt mart.
//
// Prepared 2026-09-13 for IC item 4 (3-peak ceilings; parked 09-08, plan on file).
// Math: the affordability ceiling is LINEAR in the AI ceiling, so for an UNCAPPED
// stored runway   rw_new = min(1.3, (1 + rw_old) × ai_new / ai_old − 1)   exactly.
// A CAPPED value (rw_old = 1.3, 48 unit readings across Gladstone, Mildura, Mackay,
// Townsville, Darwin, Rockhampton) has lost its true level, so it is RECOMPUTED from
// inputs on the same basis the captures use — the forecast-rate runway with wage
// growth applied (verified: 2026-08 Perth H stored 0.4774 v mart forecast_wg 0.4791):
//   income  = rdp_report_feed years[capture year].median_income (weekly), grown
//             (1 + wage growth)^years (capital 3% / regional 2%, 5 yrs — from config)
//   ceiling = PV(forecast rate, 360, income × 52 × ai_new / 12) / 0.8 ; rw = (ceiling − median)/median
//   median  = the snapshot's own median for that market/month.
// ds (the demand score) is left as captured — it embeds the old runway too; recomputing
// it needs the Demand Score engine (tools/demand-score.html, client-side) and is a
// separate decision. The rvd-* mirror rows store rw in PERCENT — same ratio, cap 130.
//
// OLD ceilings default to the newest rdp_runway_config key ai_ceiling_backup_* (written
// by apply-ai-ceilings --write); NEW = the live ai_ceiling. For a preview BEFORE
// applying, pass --new-from-sheet (reads col E of the AI Ceiling workbook) with OLD =
// the live config.
//
//   node scripts/rerate-runway-snapshots.mjs --new-from-sheet          # preview today
//   node scripts/rerate-runway-snapshots.mjs                           # after apply: dry run
//   node scripts/rerate-runway-snapshots.mjs --write                   # rewrite the snapshot rows
//   options: --old=<config key> --file=<workbook path>
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import './../shared/runway-calc.js';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const FROM_SHEET = process.argv.includes('--new-from-sheet');
const OLD_KEY = (process.argv.find(a => a.startsWith('--old=')) || '').split('=')[1] || null;
const FILE = (process.argv.find(a => a.startsWith('--file=')) || '').split('=')[1] || join(homedir(), 'Downloads', 'AI Ceiling (Average).xlsx');
const CAP = 1.3;
const CAPITALS = new Set(['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'hobart', 'darwin', 'canberra']);
const slugify = s => String(s).trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const RC = globalThis.RunwayCalc;

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

// ── ceilings: old + new ──
const { data: cfgRows } = await sb.from('rdp_runway_config').select('key,value,updated_at');
const cfg = Object.fromEntries((cfgRows || []).map(r => [r.key, r.value]));
let OLD, NEW, oldLabel, newLabel;
if (FROM_SHEET) {
  OLD = cfg.ai_ceiling; oldLabel = 'live ai_ceiling';
  if (!existsSync(FILE)) { console.error('workbook not found: ' + FILE); process.exit(1); }
  const g = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets['AI - Summary'], { header: 1, defval: '' });
  NEW = {}; for (const r of g.slice(1)) { const t = String(r[1] || '').trim().toLowerCase(); if (t !== 'h' && t !== 'u') continue; const v = typeof r[4] === 'number' ? r[4] : parseFloat(String(r[4]).replace(/[%,\s]/g, '')) / (/%/.test(String(r[4])) ? 100 : 1); if (!Number.isFinite(v)) continue; (NEW[slugify(r[0])] ||= {})[t] = v; }
  newLabel = 'sheet col E (3-peak excl 2026)';
} else {
  const backups = (cfgRows || []).filter(r => /^ai_ceiling_backup_/.test(r.key)).map(r => r.key).sort();
  const key = OLD_KEY || backups[backups.length - 1];
  if (!key || !cfg[key]) { console.error('no old-ceiling source: run apply-ai-ceilings --write first (creates ai_ceiling_backup_<date>), or pass --old=<key>, or use --new-from-sheet for a preview. Keys: ' + (backups.join(', ') || 'none')); process.exit(1); }
  OLD = cfg[key]; oldLabel = key; NEW = cfg.ai_ceiling; newLabel = 'live ai_ceiling';
}
const rates = cfg.rates || {}, wg = cfg.wage_growth || { years: 5, capital: 0.03, regional: 0.02 };
const fcRate = rates.forecast && rates.forecast.rate;
if (!fcRate) { console.error('rdp_runway_config.rates.forecast.rate missing'); process.exit(1); }
console.log(`Re-rate basis: OLD = ${oldLabel} · NEW = ${newLabel} · forecast rate ${fcRate} · wage growth capital ${wg.capital} / regional ${wg.regional} over ${wg.years} yrs`);
const changed = []; for (const s of Object.keys(NEW)) for (const t of ['h', 'u']) { const a = OLD[s] && OLD[s][t], b = NEW[s] && NEW[s][t]; if (a != null && b != null && Math.abs(a - b) > 0.0005) changed.push(s + '/' + t); }
console.log(`${changed.length} of 72 ceilings differ → only those series move`);
if (!changed.length) { console.log('Nothing to re-rate.'); process.exit(0); }

// ── incomes by year from the feed (for the capped recompute) ──
const { data: feeds } = await sb.from('rdp_report_feed').select('region_slug,payload');
const incomeOf = {};   // slug -> { year -> weekly income }
for (const f of feeds || []) { incomeOf[f.region_slug] = {}; for (const y of (f.payload && f.payload.years) || []) if (y.median_income != null) incomeOf[f.region_slug][String(y.year)] = +y.median_income; }
const incomeFor = (slug, year) => { const m = incomeOf[slug] || {}; if (m[year] != null) return m[year]; const ys = Object.keys(m).map(Number).filter(y => y <= +year).sort(); return ys.length ? m[ys[ys.length - 1]] : null; };
const { data: regRows } = await sb.from('rdp_regions').select('slug,cluster');   // same cluster source as build-runway
const clusterOf = Object.fromEntries((regRows || []).map(r => [r.slug, r.cluster]));
const wgRate = slug => ((clusterOf[slug] || (CAPITALS.has(slug) ? 'capital' : 'regional')) === 'capital') ? (wg.capital || 0) : (wg.regional || 0);

const ratio = (rw, s, t) => Math.min(CAP, (1 + rw) * NEW[s][t] / OLD[s][t] - 1);
// a reading is CAPPED only when it sits exactly on 1.3; the Jan–Aug 2025 captures pre-date
// the cap and hold true values above it (e.g. Gladstone U 2.0853) — those re-rate by ratio
// like any other and then meet today's 1.3 cap.
const isCapped = rw => Math.abs(rw - CAP) < 1e-6 || Math.abs(rw - 1.5) < 1e-6;   // 1.5 = the cap the Apr-25 → Feb-26 captures used before the 130% rule
// some 2025 captures stored the median as text ("$353,000")
const medianOf = row => { const m = row.median; if (typeof m === 'number') return m; const n = parseFloat(String(m ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
const recompute = (slug, t, median, year) => {
  const inc = incomeFor(slug, year); if (inc == null || !median) return null;
  const grown = inc * Math.pow(1 + wgRate(slug), wg.years || 1);
  return RC.computeRunway({ median, income: grown, aiCeiling: NEW[slug][t], currentRate: fcRate, forecastRate: fcRate }).runway_pct;
};

// ── snapshots ──
const { data: snaps } = await sb.from('forge_demand_snapshots').select('*').order('captured_at');
const updates = []; const cappedLog = []; let aboveCap = 0;
console.log('\nversion      changed  recomputed(capped)  largest move');
for (const s of snaps || []) {
  const d = JSON.parse(JSON.stringify(s.data)); let n = 0, nc = 0, big = ['', 0];
  const year = (s.version.match(/(20\d{2})-\d{2}/) || [])[1] || s.captured_at.slice(0, 4);
  for (const [t, keyName] of [['h', 'houses'], ['u', 'units']]) {
    const block = d[keyName]; if (!block) continue;
    if (Array.isArray(block)) {   // rvd-* mirrors: [{ds, rw(%), city}]
      for (const row of block) { const slug = slugify(row.city || ''); if (!OLD[slug] || !NEW[slug] || !changed.includes(slug + '/' + t) || typeof row.rw !== 'number') continue; const rw = row.rw / 100; const nv = rw >= CAP - 1e-9 ? null : ratio(rw, slug, t); if (nv == null) continue; const out = Math.round(nv * 10000) / 100; if (Math.abs(out - row.rw) > big[1]) big = [slug + '/' + t + ' ' + row.rw + '→' + out, Math.abs(out - row.rw)]; row.rw = out; n++; }
    } else {                      // monthly captures: { slug: {rw, median, …} }
      for (const [slug, row] of Object.entries(block)) { if (!OLD[slug] || !NEW[slug] || !changed.includes(slug + '/' + t) || typeof row.rw !== 'number') continue;
        let nv, method;
        if (isCapped(row.rw)) {
          const med = medianOf(row);
          nv = recompute(slug, t, med, year); method = 'recomputed';
          if (nv == null) { const why = med == null ? `no usable median in this capture (${JSON.stringify(row.median)})` : `no income for ${year}`; cappedLog.push(`${s.version} ${slug}/${t}: capped — ${why} — left at 1.3`); continue; }
          nc++; cappedLog.push(`${s.version} ${slug}/${t}: ${row.rw} (capped) → ${nv.toFixed(4)} (median ${med}, income ${incomeFor(slug, year)}, ai ${OLD[slug][t]}→${NEW[slug][t]})`);
        }
        else if (row.rw > CAP) { nv = ratio(row.rw, slug, t); method = 'ratio (pre-cap value)'; aboveCap++; }
        else { nv = ratio(row.rw, slug, t); method = 'ratio'; }
        const out = Math.round(nv * 10000) / 10000; if (Math.abs(out - row.rw) > big[1]) big = [slug + '/' + t + ' ' + row.rw + '→' + out, Math.abs(out - row.rw)]; row.rw = out; n++; }
    }
  }
  d.rerated = { at: new Date().toISOString(), old: oldLabel, new: newLabel, changed: n, recomputed: nc };
  updates.push({ version: s.version, data: d });
  console.log(`${s.version.padEnd(12)} ${String(n).padStart(7)}  ${String(nc).padStart(18)}  ${big[0]}`);
}
console.log(`\nCapped readings handled (${cappedLog.length}):\n  ` + (cappedLog.join('\n  ') || 'none'));
console.log(`Pre-cap readings above 1.3 re-rated by ratio then capped at 1.3: ${aboveCap}`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to rewrite the snapshot rows (back them up first: scratch/demand-snapshots-backup-*.json).'); process.exit(0); }
if (FROM_SHEET) { console.error('✗ --write with --new-from-sheet is not allowed: apply the ceilings first (apply-ai-ceilings --write), rebuild the mart, then re-rate against the live config.'); process.exit(1); }
let w = 0;
for (const u of updates) { const { error } = await sb.from('forge_demand_snapshots').update({ data: u.data }).eq('version', u.version); if (error) { console.error(u.version + ': ' + error.message); process.exit(1); } w++; }
try { await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `runway snapshots re-rate ${new Date().toISOString().slice(0, 7)}`, row_count: w, status: 'ok', notes: `forge_demand_snapshots re-rated ${oldLabel} → ${newLabel}; ${cappedLog.length} capped readings recomputed from inputs` }); } catch {}
console.log(`\n✓ ${w} snapshot rows re-rated.`);
