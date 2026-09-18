// =============================================================================
// make-cot-capture-sep.mjs — the FULL Cotality capture for Sep 2026.
//
// Van wants compare notes on Aug->Sep 2026 and nowhere earlier. A note is only
// possible where the capture carries the INPUTS behind the score, so those two
// months get the full shape and the other nineteen carry the numbers alone.
//
// The demand score and runway are COPIED from the Runway v Demand V3 timeline,
// not recomputed — the same rule as the rest of the backfill, so the dashboard
// and the chart cannot disagree. The inputs beside them are read from the very
// sources V3 was built from, so the note explains the move that actually
// happened rather than one derived a second way.
//
// Sep 2026 has no SQM capture to borrow the basis-independent fields from, so
// population, listings and median price come from the live marts and the live
// demand-inputs card — which is what a capture taken this month would have
// frozen anyway.
//
// Dry-run by DEFAULT; --write upserts cot-2026-09.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const sb = createClient(process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');
const VER = 'cot-2026-09', LABEL = 'Sep 2026', DATA_MONTH = '2026-06', BACK_MONTH = '2023-06';
const DIR = join(homedir(), 'Downloads');

const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const slugOf = s => String(s == null ? '' : s).trim()
  .replace(/\([^)]*\)/g, ' ').replace(/,\s*(act|nsw|nt|qld|sa|tas|vic|wa)\b/ig, ' ')
  .replace(/\bgreater\b/ig, ' ').replace(/\bregional\b/ig, ' ').replace(/-hastings/ig, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const monthOf = v => { if (typeof v === 'number' && isFinite(v)) { const d = new Date(Date.UTC(1899, 11, 30)); d.setUTCDate(d.getUTCDate() + Math.floor(v)); return d.toISOString().slice(0, 7); }
  const m = String(v == null ? '' : v).trim().match(/^(\d{4})-(\d{2})-\d{2}/); return m ? m[1] + '-' + m[2] : null; };

/* Cotality vacancy + rent — xlsx exports AND the csv drops, same as the builder */
const VR = {};
const files = [];
for (const e of readdirSync(DIR, { withFileTypes: true })) {
  if (e.isFile() && /VR and Rent\.xlsx$/i.test(e.name)) files.push([DIR, e.name]);
  else if (e.isDirectory() && /^CSTDAT/i.test(e.name)) for (const f of readdirSync(join(DIR, e.name))) if (/\.csv$/i.test(f)) files.push([join(DIR, e.name), f]);
}
for (const [d, f] of files) {
  let rows; try { const wb = XLSX.readFile(join(d, f), { raw: true }); rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false }); } catch { continue; }
  for (const r of rows.slice(1)) {
    const slug = slugOf(r[1]), month = monthOf(r[3]); if (!slug || !month) continue;
    const t = String(r[2]).toUpperCase() === 'U' ? 'u' : 'h';
    const vr = num(+r[4]); if (vr == null) continue;
    const b = (VR[slug] || (VR[slug] = {}))[month] || (VR[slug][month] = {});
    if (b[t]) continue;
    b[t] = { vr: vr <= 1 ? vr * 100 : vr, rent: num(+r[5]) };
  }
}

/* days on market at the same vintage */
const clRows = [];
for (let from = 0; ; from += 1000) {
  const { data } = await sb.from('forge_cl_suburbs').select('name,level,ptype,metrics').eq('month', DATA_MONTH).in('level', ['capital', 'lga']).order('name').range(from, from + 999);
  clRows.push(...(data || [])); if (!data || data.length < 1000) break;
}
const DOM = {};
for (const pass of ['capital', 'lga']) for (const r of clRows) {
  if (r.level !== pass) continue; const slug = slugOf(r.name); if (!slug) continue;
  const t = String(r.ptype).toUpperCase() === 'U' ? 'u' : 'h';
  (DOM[slug] || (DOM[slug] = {})); if (DOM[slug][t] !== undefined) continue;
  DOM[slug][t] = num(+(r.metrics || {}).dom);
}

/* the supply-rule stamp the note quotes */
const { data: fcRows } = await sb.from('rdp_vr_forecast').select('region_slug,payload');
const FC = {}; let vrRule = null, vrAt = null;
for (const r of fcRows || []) {
  const p = r.payload || {}, sr = p.supplyRule || {};
  if (num(p.population) == null || !(num(p.hhSize) > 0)) continue;
  FC[r.region_slug] = { population: p.population, hhSize: p.hhSize, expNewHouseholds: num(p.expNewHouseholds) || 0, expProperties: num(p.expProperties) || 0 };
  if (!vrRule && sr.rule) { vrRule = sr.rule; vrAt = sr.appliedAt || null; }
}
const projectVR = (slug, obs) => { const f = FC[slug]; if (!f || obs == null) return null; const vr = obs / 100; if (!(vr < 1)) return null;
  const H = f.population / f.hhSize, total = H / (1 - vr) + f.expProperties; if (!(total > 0)) return null;
  return Math.max(0.001, (total - H - f.expNewHouseholds) / total) * 100; };

/* live basis-independent fields */
const { data: cardRow } = await sb.from('forge_demand_inputs').select('data').eq('id', 'latest').maybeSingle();
const CARD = (cardRow && cardRow.data && cardRow.data.regions) || {};
const { data: popLive } = await sb.from('rdp_raw_series').select('region_slug,period,value').eq('metric', 'population').gte('period', '2020-01-01');
const POP = {}, AT = {};
for (const r of popLive || []) if (!AT[r.region_slug] || r.period > AT[r.region_slug]) { AT[r.region_slug] = r.period; POP[r.region_slug] = +r.value; }
const { data: mpRow } = await sb.from('forge_monthly_price').select('data').eq('id', 'latest').maybeSingle();
const MP = (mpRow && mpRow.data && mpRow.data.regions) || {};
/* forge_monthly_price stores each region's medians as an ARRAY, newest last. */
const medianOf = (slug, isU) => { const r = MP[slug]; if (!r) return null;
  const arr = isU ? r.u : r.h;
  if (Array.isArray(arr)) { for (let i = arr.length - 1; i >= 0; i--) { const v = num(+arr[i]); if (v) return v; } return null; }
  return num(+arr);
};

/* the numbers themselves — copied from V3 */
const { data: v3row } = await sb.from('forge_cotality').select('data').eq('id', 'rvd_v3').maybeSingle();
const sep = (v3row.data.months || []).find(m => m.label === LABEL);
const { data: regions } = await sb.from('rdp_regions').select('slug,name');
const SLUG = {}; for (const r of regions || []) SLUG[r.name] = r.slug;

const out = { houses: {}, units: {} };
let n = 0; const thin = [];
for (const [grp, t] of [['houses', 'h'], ['units', 'u']]) {
  for (const r of sep[grp] || []) {
    const slug = SLUG[r.city]; if (!slug) continue;
    const c = ((VR[slug] || {})[DATA_MONTH] || {})[t];
    const back = (((VR[slug] || {})[BACK_MONTH] || {})[t] || {}).rent;
    const dom = (DOM[slug] || {})[t];
    const v = CARD[slug] || {};
    const avr = c ? projectVR(slug, c.vr) : null;
    const rgPct = (c && c.rent != null && back > 0) ? (c.rent - back) / back * 100 : null;
    if (!c || dom == null || avr == null || rgPct == null) thin.push(grp + '/' + slug);
    out[grp][slug] = {
      ds: r.ds, rw: r.rw != null ? r.rw / 100 : null,
      pop: POP[slug] ?? null,
      listings: num(Number(t === 'u' ? v.listings_u : v.listings_h)),
      median: medianOf(slug, t === 'u'),
      avr, rg: rgPct, dom, vrr: c ? c.vr : null, rent: c ? c.rent : null, rent3: back ?? null,
      sqm: null, vrRule, vrAt, inc: null, ai: null, rate: null, basis: 'cotality',
    };
    n++;
  }
}
console.log('markets: ' + n + (thin.length ? '   without full inputs: ' + thin.length + ' (' + thin.slice(0, 4).join(', ') + ')' : '   all with full inputs'));
const sample = out.houses[SLUG['Greater Perth']] || Object.values(out.houses)[0];
console.log('sample: ' + JSON.stringify(sample));
if (!WRITE) { console.log('\nDry run. Re-run with --write to store ' + VER + '.'); process.exit(0); }
const { error } = await sb.from('forge_demand_snapshots').upsert({
  version: VER, label: LABEL, data: { houses: out.houses, units: out.units, basis: 'cotality' },
  captured_at: new Date().toISOString(), captured_by: 'make-cot-capture-sep.mjs (scores from rvd_v3)',
}, { onConflict: 'version' });
if (error) { console.error('write failed: ' + error.message); process.exit(1); }
console.log('\nstored ' + VER + '.');
