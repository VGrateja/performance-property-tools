// =============================================================================
// publish-readiness-gate.mjs — pre-PUBLISH input-readiness gate.
//
// Runs as the FIRST step of the PUBLISH workflow (before any mart write).
// PUBLISH only reshapes what's already in Forge, so the one thing that can go
// wrong is publishing from bad INPUTS: a missing/empty store, a store a failed
// ingest left in error, or a store whose values are on the wrong scale. This
// gate checks the inputs and exits non-zero on a hard failure, aborting the
// whole publish (the workflow step runs under `set -e`).
//
//   FAIL (✗ → exit 1):
//     • forge_cotality 'latest' missing, or missing cap.rows OR lga.rows
//       (closes the cap-without-lga hole — regionals would silently skip)
//     • any other forge_* input store missing/empty
//     • any forge_data_status row with status='error'
//     • scale sanity: forge_arrears values must look like percents (0–20];
//       forge_cotality medians must look like dollars (≥ $50k)
//   WARN (⚠ → report only):
//     • store age: > 40d aging, > 75d stale
//     • automated points whose last_ok_at is > 40d (GATHER may not have run)
//
// Store↔mart parity is NOT checked here — before the sync steps run the store
// is SUPPOSED to be ahead of the mart. post-publish-verify.mjs (the last step)
// checks the marts actually absorbed the stores.
//
//   node scripts/publish-readiness-gate.mjs          # report + exit code
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const fails = [], warns = [], oks = [];
const ok = m => oks.push(m);
const warn = m => warns.push(m);
const fail = m => fails.push(m);
const days = iso => iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null;
const age = (label, iso) => { const d = days(iso); if (d == null) warn(`${label}: no timestamp`); else if (d > 75) warn(`${label}: STALE — last updated ${d}d ago`); else if (d > 40) warn(`${label}: aging — last updated ${d}d ago`); else ok(`${label}: updated ${d}d ago`); };

// ── the forge_* input stores PUBLISH consumes ──
const STORES = ['forge_cotality', 'forge_arrears', 'forge_industry', 'forge_population_pyramid', 'forge_monthly_price', 'forge_commercial', 'forge_national_only', 'forge_demand_inputs'];

async function main() {
  const rows = {};
  await Promise.all(STORES.map(async t => {
    try { const { data, error } = await sb.from(t).select('data,updated_at').eq('id', 'latest').maybeSingle(); rows[t] = error ? { error } : data; }
    catch (e) { rows[t] = { error: e }; }
  }));

  for (const t of STORES) {
    const r = rows[t];
    if (!r || r.error) { fail(`${t}: ${r && r.error ? 'read failed — ' + (r.error.message || r.error) : 'MISSING (no latest row)'}`); continue; }
    if (!r.data) { fail(`${t}: latest row has no data`); continue; }
    age(t, r.updated_at);
  }

  // cotality shape — must have BOTH cap and lga (cap-only would silently skip all regionals)
  const cot = rows['forge_cotality'];
  if (cot && cot.data) {
    const capN = (cot.data.cap && cot.data.cap.rows || []).length;
    const lgaN = (cot.data.lga && cot.data.lga.rows || []).length;
    if (!capN) fail('forge_cotality: cap.rows empty — capitals would not sync');
    if (!lgaN) fail('forge_cotality: lga.rows empty — ALL regionals would silently skip the median sync');
    if (capN && lgaN) ok(`forge_cotality: cap ${capN} rows, lga ${lgaN} rows`);
    // dollar-scale sanity on the cap medians
    const num = s => { const n = Number(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
    const meds = (cot.data.cap && cot.data.cap.rows || []).map(r => num(r[4])).filter(v => v != null);
    if (meds.length && Math.max(...meds) < 50000) fail(`forge_cotality: cap medians max ${Math.max(...meds)} — not dollar-scaled?`);
  }

  // arrears scale sanity — store must hold percents (0, 20]
  const arr = rows['forge_arrears'];
  if (arr && arr.data && arr.data.regions) {
    const vals = Object.values(arr.data.regions).flatMap(r => (r.values || []).filter(v => v != null && !isNaN(v)));
    if (!vals.length) fail('forge_arrears: no numeric values');
    else {
      const mx = Math.max(...vals);
      if (mx <= 0.2) fail(`forge_arrears: max value ${mx} ≤ 0.2 — looks like fractions, sync would double-divide`);
      else if (mx > 20) fail(`forge_arrears: max value ${mx} > 20% — implausible, store looks corrupt`);
      else ok(`forge_arrears: scale sane (max ${mx.toFixed(2)}%)`);
    }
  }

  // forge_data_status — any DATA-POINT error row blocks; stale automated points warn.
  // pipeline_* heartbeat rows are EXCLUDED from the fail set: a failed PUBLISH
  // writes pipeline_publish='error', and the fix for that is... re-running
  // PUBLISH — which starts with this gate. Failing on our own heartbeat would
  // deadlock the pipeline (warn instead so the history is still visible).
  const { data: allStatuses, error: stErr } = await sb.from('forge_data_status').select('data_key,status,message,last_ok_at');
  if (stErr) fail(`forge_data_status read failed (${stErr.message}) — cannot confirm no ingest errored`);
  else if (!(allStatuses || []).length) warn('forge_data_status is empty — health tracking not seeded yet (apply migration 077)');
  const statuses = (allStatuses || []).filter(s => !String(s.data_key).startsWith('pipeline_'));
  const pipeErr = (allStatuses || []).filter(s => String(s.data_key).startsWith('pipeline_') && s.status === 'error');
  for (const s of pipeErr) warn(`${s.data_key} last run failed (${String(s.message || '').slice(0, 100)}) — this publish will clear it if green`);
  const errRows = statuses.filter(s => s.status === 'error');
  if (errRows.length) for (const s of errRows) fail(`forge_data_status[${s.data_key}] = error: ${String(s.message || '').slice(0, 140)}`);
  else if (!stErr && statuses.length) ok(`forge_data_status: no error rows (${statuses.length} data points tracked)`);
  const lastOk = statuses.map(s => s.last_ok_at).filter(Boolean).sort().pop();
  const dGather = days(lastOk);
  if (dGather != null && dGather > 40) warn(`newest last_ok_at across all points is ${dGather}d old — GATHER may not have run this month`);
  for (const s of statuses) { const d = days(s.last_ok_at); if (d != null && d > 40 && s.status === 'ok') warn(`${s.data_key}: last_ok_at ${d}d ago`); }

  // ── report ──
  console.log('══ PUBLISH readiness gate ══\n');
  for (const m of oks) console.log('  ✓ ' + m);
  for (const m of warns) console.log('  ⚠ ' + m);
  for (const m of fails) console.log('  ✗ ' + m);
  console.log(`\n${oks.length} ok · ${warns.length} warnings · ${fails.length} failures`);
  if (fails.length) { console.error('\n✗ NOT READY — fix the failures above (or re-run GATHER / re-upload the store), then re-dispatch PUBLISH.'); process.exit(1); }
  console.log('\n✓ READY — inputs look sane; proceeding to publish.');
}
main().catch(e => { console.error(e); process.exit(1); });
