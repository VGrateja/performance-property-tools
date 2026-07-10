// =============================================================================
// post-publish-verify.mjs — store↔mart parity check, run as the LAST step of
// PUBLISH.
//
// The readiness gate (first step) checks the INPUTS; this checks the OUTPUTS:
// did the marts actually absorb the stores? A sync/build step that silently
// wrote nothing (or skipped regions) passes `set -e` — this catches it and
// turns the run red. PUBLISH is idempotent, so a red run is simply re-run
// after fixing the cause; nothing needs rolling back.
//
//   FAIL (✗ → exit 1):
//     • any city region (or australia) missing from rdp_report_feed, or with
//       empty payload.years, no payload.extras, or computed_at older than the
//       freshness window (default 3h — this run should have just written it)
//     • arrears parity: what the reports read (payload.extras.arrears /
//       arrears_national, fractions) ≠ forge_arrears (percent ÷ 100)
//     • median parity: each region's latest mart mp_h/mp_u ≠ the Cotality
//       store median (capitals ← cap.rows, regionals ← lga.rows)
//     • rdp_vr_forecast / rdp_runway not recomputed within the window
//     • report_data_cache: any of the 6 sources not rewritten within the
//       window, or _meta.source not 'forge'
//   WARN (⚠): regions riding the stale-rdp fallback for pyramid/industry
//     (extras._sources), reported so the owner can see coverage.
//
//   node scripts/post-publish-verify.mjs [--window=3]   # hours; exit code = verdict
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const winArg = process.argv.find(a => a.startsWith('--window='));
const WINDOW_MS = (winArg ? Number(winArg.split('=')[1]) : 3) * 3600000;
const fresh = iso => iso && (Date.now() - Date.parse(iso)) < WINDOW_MS;

const fails = [], warns = [], oks = [];
const close = (a, b, tol = 1e-6) => a != null && b != null && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// slug maps (mirror sync-cotality / sync-arrears)
const COT_ALIAS = { 'greater-hobart': 'hobart', 'greater-bendigo': 'bendigo', 'greater-geelong': 'geelong', 'central-coast-nsw': 'central-coast', 'port-macquarie-hastings': 'port-macquarie', 'greater-sydney': 'sydney', 'greater-perth': 'perth', 'tamworth-regional': 'tamworth' };
const ARR_SLUG = { australia: 'australia', 'st-nsw': 'sydney', 'st-vic': 'melbourne', 'st-qld': 'brisbane', 'st-wa': 'perth', 'st-sa': 'adelaide', 'st-nt': 'darwin', 'st-act': 'canberra', 'st-tas': 'hobart' };
const slugify = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const num = s => { const n = Number(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };

async function main() {
  const [regQ, martQ, cotQ, arrQ] = await Promise.all([
    sb.from('rdp_regions').select('slug,cluster,state').in('cluster', ['capital', 'qld', 'nsw', 'vicwatas', 'national']),
    sb.from('rdp_report_feed').select('region_slug,cluster,payload,computed_at'),
    sb.from('forge_cotality').select('data').eq('id', 'latest').maybeSingle(),
    sb.from('forge_arrears').select('data').eq('id', 'latest').maybeSingle(),
  ]);
  // a verifier that can't read its inputs must FAIL, not shrug — an unreadable
  // region list would otherwise reduce every check below to a no-op green.
  for (const [name, q] of [['rdp_regions', regQ], ['rdp_report_feed', martQ], ['forge_cotality', cotQ], ['forge_arrears', arrQ]]) {
    if (q.error) fails.push(`${name} read failed: ${q.error.message} — verification incomplete`);
  }
  const regions = regQ.data, marts = martQ.data, cot = cotQ.data, arr = arrQ.data;
  const martBy = Object.fromEntries((marts || []).map(m => [m.region_slug, m]));
  const cities = (regions || []).filter(r => r.slug !== 'australia' && r.slug !== 'dubbo' && r.cluster !== 'national');
  if (!cities.length) fails.push('rdp_regions returned no city regions — cannot verify mart completeness');

  // ── 1. mart completeness + freshness ──
  let staleN = 0, missingN = 0, noExtrasN = 0;
  for (const r of [...cities, { slug: 'australia' }]) {
    const m = martBy[r.slug];
    if (!m || !m.payload || !(m.payload.years || []).length) { fails.push(`mart[${r.slug}]: missing or empty payload.years`); missingN++; continue; }
    if (!m.payload.extras || Object.keys(m.payload.extras).length < 3) { fails.push(`mart[${r.slug}]: payload.extras missing/near-empty — enrich-marts did not run after the feed build`); noExtrasN++; }
    if (!fresh(m.computed_at)) { fails.push(`mart[${r.slug}]: computed_at ${m.computed_at} outside the freshness window`); staleN++; }
  }
  if (!missingN && !staleN && !noExtrasN) oks.push(`rdp_report_feed: all ${cities.length}+national rows fresh, with years + extras`);

  // ── 2. arrears parity (store → what the reports read) ──
  if (arr && arr.data && arr.data.regions && arr.data.months) {
    const months = arr.data.months;
    const lastVal = storeSlug => { const v = (arr.data.regions[storeSlug] || {}).values || []; for (let i = v.length - 1; i >= 0; i--) if (v[i] != null && !isNaN(v[i])) return { month: months[i], frac: v[i] / 100 }; return null; };
    let arrOk = 0, arrBad = 0;
    for (const [storeSlug, capSlug] of Object.entries(ARR_SLUG)) {
      const want = lastVal(storeSlug);
      if (!want) continue;
      const m = martBy[capSlug];
      const ex = m && m.payload && m.payload.extras;
      // Compare MONTH-ALIGNED: rdp legitimately keeps months newer than the
      // current store upload (upsert-only, never deletes), so the mart's
      // "latest" scalar can be a different month than the store's last row.
      // Look the store's month up in the mart's monthly series; fall back to
      // the latest scalar only if that series is missing.
      const series = capSlug === 'australia' ? (ex && ex.arrears_national_monthly) : (ex && ex.arrears_monthly);
      let got = null, at = 'latest';
      if (series && Array.isArray(series.months)) {
        const i = series.months.findIndex(x => String(x).slice(0, 7) === want.month);
        if (i >= 0) { got = series.values[i]; at = want.month; }
      }
      if (got == null && at === 'latest') got = capSlug === 'australia' ? (ex && ex.arrears_national) : (ex && ex.arrears);
      if (got == null) { fails.push(`arrears[${capSlug}]: store has ${(want.frac * 100).toFixed(2)}% @ ${want.month} but mart extras carry none`); arrBad++; }
      else if (!close(got, want.frac, 1e-6)) { fails.push(`arrears[${capSlug}]: mart ${got} (@${at}) ≠ store ${want.frac} (${want.month}) — sync-arrears/enrich mismatch`); arrBad++; }
      else arrOk++;
    }
    if (arrOk && !arrBad) oks.push(`arrears parity: ${arrOk}/${arrOk} slugs match forge_arrears (month-aligned, ÷100)`);
  } else warns.push('forge_arrears unreadable — arrears parity skipped');

  // ── 3b. vacancy-rate parity (rentvacancy store → mart latest-year, ÷100) ──
  // Added after Sydney showed 2.23% in Forge but 2.18% in the reports — the
  // sync now carries the full drop, and this catches any future stranding.
  try {
    const { data: rvRow } = await sb.from('forge_cotality').select('data').eq('id', 'rentvacancy').maybeSingle();
    if (rvRow && rvRow.data) {
      const rvAll = [...(rvRow.data.capitals || []), ...(rvRow.data.regions || [])];
      let vrOk = 0, vrBad = 0;
      for (const r of rvAll) {
        if (r.vacHouse == null) continue;
        const rgSlug = COT_ALIAS[slugify(r.name)] || slugify(r.name);
        const m = martBy[rgSlug]; if (!m) continue;
        const last = [...(m.payload.years || [])].reverse().find(y => y.vacancy_rate != null);
        if (!last) continue;
        if (!close(last.vacancy_rate, Number(r.vacHouse) / 100, 1e-6)) { fails.push(`vacancy[${rgSlug}]: mart ${last.vacancy_rate} (${last.year}) ≠ store ${Number(r.vacHouse) / 100} — Cotality sync/feed mismatch`); vrBad++; }
        else vrOk++;
      }
      if (vrOk && !vrBad) oks.push(`vacancy-rate parity: ${vrOk} regions match the rentvacancy store (÷100)`);
    } else warns.push('rentvacancy store unreadable — vacancy parity skipped');
  } catch (e) { warns.push('vacancy parity check errored: ' + (e.message || e)); }

  // ── 3. median parity (Cotality store → mart latest-year mp_h/mp_u) ──
  if (cot && cot.data && cot.data.cap) {
    const priceMap = rows => { const m = {}; for (const r of (rows || [])) { const k = COT_ALIAS[slugify(r[1])] || slugify(r[1]); const ty = String(r[2] || '').toUpperCase()[0]; if (!m[k]) m[k] = {}; if (ty === 'H') m[k].H = num(r[4]); else if (ty === 'U') m[k].U = num(r[4]); } return m; };
    const capM = priceMap(cot.data.cap.rows), lgaM = priceMap(cot.data.lga && cot.data.lga.rows);
    let medOk = 0, medBad = 0;
    for (const c of cities) {
      const storePrices = (c.cluster === 'capital' ? capM : lgaM)[c.slug];
      if (!storePrices) continue;   // region absent from the drop — sync skipped it by design
      const m = martBy[c.slug]; if (!m) continue;
      const years = m.payload.years || [];
      const lastH = [...years].reverse().find(y => y.mp_h != null);
      const lastU = [...years].reverse().find(y => y.mp_u != null);
      for (const [field, row, want] of [['mp_h', lastH, storePrices.H], ['mp_u', lastU, storePrices.U]]) {
        if (want == null || !row) continue;
        if (!close(row[field], want, 1e-6)) { fails.push(`median[${c.slug}].${field}: mart ${row[field]} (${row.year}) ≠ Cotality ${want} — sync-cotality/feed mismatch`); medBad++; }
        else medOk++;
      }
    }
    if (medOk && !medBad) oks.push(`median parity: ${medOk} region-fields match the Cotality store`);
  } else warns.push('forge_cotality unreadable — median parity skipped');

  // ── 4. downstream marts recomputed ──
  for (const t of ['rdp_vr_forecast', 'rdp_runway']) {
    const { data } = await sb.from(t).select('computed_at').order('computed_at', { ascending: false }).limit(1);
    const newest = data && data[0] && data[0].computed_at;
    if (!fresh(newest)) fails.push(`${t}: newest computed_at ${newest || '—'} outside the freshness window — its rebuild step did not run`);
    else oks.push(`${t}: recomputed within the window`);
  }

  // ── 5. snapshots rewritten from Forge ──
  const { data: snaps } = await sb.from('report_data_cache').select('source,updated_at,data');
  const snapBy = Object.fromEntries((snaps || []).map(s => [s.source, s]));
  for (const src of ['capital', 'qld', 'nsw', 'vicwatas', 'national', 'commercial']) {
    const s = snapBy[src];
    if (!s) { fails.push(`report_data_cache[${src}]: missing`); continue; }
    if (!fresh(s.updated_at)) { fails.push(`report_data_cache[${src}]: updated_at ${s.updated_at} outside the window — refresh-snapshots did not run`); continue; }
    const metaSrc = s.data && s.data._meta && s.data._meta.source;
    // adapters stamp specific sources ('forge', 'forge_national', 'forge_commercial') — anything forge* is ours
    if (metaSrc && !String(metaSrc).startsWith('forge')) { fails.push(`report_data_cache[${src}]: _meta.source='${metaSrc}' — a non-Forge writer touched the snapshot`); continue; }
    oks.push(`report_data_cache[${src}]: fresh${metaSrc ? ' (' + metaSrc + ')' : ''}`);
  }

  // ── 6. fallback coverage (warn only) ──
  const fb = { pyramid: [], industry: [] };
  for (const m of (marts || [])) { const s = m.payload && m.payload.extras && m.payload.extras._sources; if (!s) continue; if (s.pyramid === 'rdp_stale') fb.pyramid.push(m.region_slug); if (s.industry === 'rdp_stale') fb.industry.push(m.region_slug); }
  for (const [k, list] of Object.entries(fb)) if (list.length) warns.push(`${k}: ${list.length} region(s) on the STALE rdp fallback (store lacks them): ${list.join(', ')}`);

  // ── report ──
  console.log('══ post-publish verify ══\n');
  for (const m of oks) console.log('  ✓ ' + m);
  for (const m of warns) console.log('  ⚠ ' + m);
  for (const m of fails) console.log('  ✗ ' + m);
  console.log(`\n${oks.length} ok · ${warns.length} warnings · ${fails.length} failures`);
  if (fails.length) { console.error('\n✗ PUBLISH VERIFY FAILED — a mart did not absorb its store. Fix the cause and re-dispatch PUBLISH (it is idempotent).'); process.exit(1); }
  console.log('\n✓ VERIFIED — every mart reflects its Forge store; tools are serving this publish.');
}
main().catch(e => { console.error(e); process.exit(1); });
