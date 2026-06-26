// =============================================================================
// enrich-marts.mjs  —  wire the deferred raw (pyramid / industry / arrears / JCI)
// into rdp_report_feed payloads as a `payload.extras` section.
//
// These are current snapshots, not per-year series, so they live alongside the
// verified `years` array rather than inside it. ISOLATED — touches only
// rdp_report_feed. Dry-run by DEFAULT; --write upserts + logs rdp_runs.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');

// state capital used as the state arrears/migration proxy
const STATECAP = { nsw: 'sydney', vic: 'melbourne', qld: 'brisbane', wa: 'perth', sa: 'adelaide', nt: 'darwin', act: 'canberra', tas: 'hobart' };
const AGE_ORDER = ['0_04','05_09','10_14','15_19','20_24','25_29','30_34','35_39','40_44','45_49','50_54','55_59','60_64','65_69','70_74','75_79','80_84','85_and_over'];

// load the relevant raw
let raw = [], from = 0;
for (;;) { const { data, error } = await sb.from('rdp_raw_series').select('region_slug,metric,freq,period,value').or('metric.like.pyr\\_%,metric.like.ind\\_%,metric.eq.arrears,metric.eq.jci,metric.eq.nom,metric.eq.nim').order('region_slug').order('metric').order('period').range(from, from + 999); if (error) { console.error(error.message); process.exit(1); } raw.push(...data.map(r => ({ ...r, value: Number(r.value) }))); if (data.length < 1000) break; from += 1000; }
const idx = Object.create(null);
for (const r of raw) { const k = r.region_slug + '|' + r.metric; (idx[k] || (idx[k] = [])).push(r); }
const latest = (slug, metric) => { const a = idx[slug + '|' + metric]; if (!a) return null; return a.slice().sort((x, y) => y.period.localeCompare(x.period))[0].value; };
const bandsFor = slug => AGE_ORDER.map(b => ({ age: b, count: latest(slug, 'pyr_' + b) })).filter(x => x.count != null);
function pyramid(slug) {
  const r = bandsFor(slug), n = bandsFor('australia');
  if (!r.length) return null;
  const rt = r.reduce((s, x) => s + x.count, 0), nt = n.reduce((s, x) => s + x.count, 0) || 1;
  const nmap = Object.fromEntries(n.map(x => [x.age, x.count]));
  return r.map(x => ({ age: x.age, metro_pct: x.count / rt, national_pct: (nmap[x.age] || 0) / nt }));
}
function industry(slug) {
  const sectors = Object.keys(idx).filter(k => k.startsWith(slug + '|ind_')).map(k => ({ sector: k.split('|ind_')[1], value: latest(slug, 'ind_' + k.split('|ind_')[1]) })).filter(x => x.value != null);
  if (!sectors.length) return null;
  const total = sectors.reduce((s, x) => s + x.value, 0) || 1;
  return sectors.map(x => ({ sector: x.sector, value: x.value, pct: x.value / total })).sort((a, b) => b.value - a.value);
}

const { data: feeds } = await sb.from('rdp_report_feed').select('region_slug,cluster,payload');
const updates = [];
for (const f of feeds) {
  const slug = f.region_slug;
  const extras = {};
  const py = pyramid(slug); if (py) extras.pyramid = py;
  const ind = industry(slug); if (ind) extras.industry = ind;
  const ar = latest(slug, 'arrears'); if (ar != null) extras.arrears = ar;
  const jc = latest(slug, 'jci'); if (jc != null) extras.jci = jc;
  extras.arrears_national = latest('australia', 'arrears');
  if (slug === 'australia') {  // national-only extras
    extras.arrears_by_state = Object.fromEntries(Object.entries(STATECAP).map(([st, cap]) => [st, latest(cap, 'arrears')]));
    extras.state_migration = Object.fromEntries(Object.keys(STATECAP).map(st => [st, { nom: latest('st-' + st, 'nom'), nim: latest('st-' + st, 'nim') }]));
  }
  const payload = { ...f.payload, extras };
  updates.push({ region_slug: slug, cluster: f.cluster, payload });
}

// spot-check
const adel = updates.find(u => u.region_slug === 'adelaide');
const au = updates.find(u => u.region_slug === 'australia');
console.log('regions enriched:', updates.length);
if (adel) console.log('adelaide extras: pyramid bands=' + (adel.payload.extras.pyramid || []).length + ' (metro 0-4=' + ((adel.payload.extras.pyramid || [])[0]?.metro_pct * 100).toFixed(2) + '%), industry sectors=' + (adel.payload.extras.industry || []).length + ' (top=' + (adel.payload.extras.industry || [])[0]?.sector + '), arrears=' + adel.payload.extras.arrears + ', jci=' + adel.payload.extras.jci);
if (au) console.log('australia extras: pyramid=' + (au.payload.extras.pyramid || []).length + ' bands, arrears_by_state.sa=' + au.payload.extras.arrears_by_state?.sa + ', state_migration.nsw=' + JSON.stringify(au.payload.extras.state_migration?.nsw));

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert.'); process.exit(0); }
const stamp = new Date().toISOString(); let n = 0;
for (const u of updates) { const { error } = await sb.from('rdp_report_feed').upsert({ region_slug: u.region_slug, cluster: u.cluster, payload: u.payload, computed_at: stamp }, { onConflict: 'region_slug' }); if (error) { console.error(u.region_slug, error.message); process.exit(1); } n++; }
await sb.from('rdp_runs').insert({ dataset: 'report_feed', source_month: 'enrich 2026-06', row_count: n, status: 'ok', notes: 'extras: pyramid/industry/arrears/jci (+ national state migration)' });
console.log(`✓ Enriched ${n} report_feed payloads with extras.`);
