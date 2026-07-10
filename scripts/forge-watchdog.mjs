// =============================================================================
// forge-watchdog.mjs — did the monthly pipeline actually run? (missed-run alarm)
//
// GitHub cron is best-effort: a skipped/failed month leaves forge_data_status
// looking "ok, just old", and nothing red-flags it. This watchdog runs a few
// days AFTER the scheduled GATHER (forge-watchdog.yml, 14th) and checks:
//
//   FAIL (✗ → exit 1, red Actions run):
//     • pipeline_gather.last_ok_at is not in the current calendar month
//       (Australia/Sydney) — GATHER has not succeeded this month. Skipped on
//       Sydney days 1–9 (GATHER isn't due until the 10th, so an early manual
//       dispatch would false-alarm every month's first days).
//     • any forge_data_status row with status='error' (excluding this
//       watchdog's own row) — an ingest is stuck in error
//     • 'job_creation_index' last_ok_at > 25d — the LOCAL JSA scheduled task
//       (this repo's scripts/register-jsa-task.ps1) missed its monthly run on
//       the 10th (25d trips in the SAME month on the 14th-run; 40d would only
//       catch it a month late)
//     • PUBLISH still pending more than 7 days AFTER a newer GATHER
//   WARN (⚠ → report only):
//     • PUBLISH pending 3–7 days after a newer GATHER — PUBLISH is manual
//       (workflow_dispatch), so a short confirm-then-publish lag is normal
//
// The verdict is upserted to forge_data_status (data_key 'pipeline_watchdog')
// so the Data Forge UI shows the missed month without opening GitHub. This
// script only observes — it never re-dispatches or re-runs anything.
//
//   node scripts/forge-watchdog.mjs          # report + exit code
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

/* ── Australia/Sydney calendar month + day of an instant (handles AEST/AEDT) ── */
function sydneyParts(when) {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(when);
  const g = t => parts.find(p => p.type === t)?.value;
  return { month: `${g('year')}-${g('month')}`, day: Number(g('day')) };
}
const sydneyMonth = when => sydneyParts(when).month;

async function main() {
  const { data: statuses, error } = await sb.from('forge_data_status').select('data_key,label,status,message,last_ok_at,last_run_at');
  if (error) { console.error('Could not read forge_data_status: ' + error.message); process.exit(1); }
  const byKey = Object.fromEntries((statuses || []).map(s => [s.data_key, s]));

  // (a) GATHER must have succeeded in the current Sydney calendar month.
  // Skip before the 11th: GATHER's cron fires on the 10th, so a manual dispatch
  // on days 1–9 would false-alarm every month (last month's green run is fine).
  const gather = byKey['pipeline_gather'];
  const gatherOkAt = gather && gather.last_ok_at;
  const nowSyd = sydneyParts(new Date());
  const thisMonth = nowSyd.month;
  if (nowSyd.day < 11) {
    ok(`GATHER not due yet this month (Sydney day ${nowSyd.day} < 11) — last success ${gatherOkAt ? gatherOkAt.slice(0, 10) : 'never'}`);
  } else if (!gatherOkAt || sydneyMonth(new Date(gatherOkAt)) !== thisMonth) {
    fail(`GATHER has not succeeded this month (${thisMonth}) — last success ${gatherOkAt ? gatherOkAt.slice(0, 10) : 'never'}`);
  } else ok(`GATHER succeeded this month (${gatherOkAt.slice(0, 10)})`);

  // (b) PUBLISH should follow GATHER within a few days (it's a manual dispatch).
  // Measure how long GATHER has been WAITING for a publish (now − gatherOkAt),
  // not gather−publish: last month's publish is always ~a month older than this
  // month's GATHER, which would instantly trip a gather−publish threshold.
  const publish = byKey['pipeline_publish'];
  const publishOkAt = publish && publish.last_ok_at;
  if (gatherOkAt) {
    if (publishOkAt && Date.parse(publishOkAt) >= Date.parse(gatherOkAt)) {
      ok(`PUBLISH is current (${publishOkAt.slice(0, 10)} ≥ GATHER ${gatherOkAt.slice(0, 10)})`);
    } else {
      const pendingDays = (Date.now() - Date.parse(gatherOkAt)) / 86400000;
      if (pendingDays > 7) fail(`PUBLISH pending ${Math.floor(pendingDays)}d since GATHER ${gatherOkAt.slice(0, 10)} (last publish ${publishOkAt ? publishOkAt.slice(0, 10) : 'never'}) — tools are serving a stale mart`);
      else if (pendingDays > 3) warn(`PUBLISH pending since GATHER ${gatherOkAt.slice(0, 10)} — dispatch "Data Forge — 2/ PUBLISH" after checking the data`);
      else ok(`PUBLISH pending ${Math.floor(pendingDays)}d (within the confirm-then-publish grace)`);
    }
  }

  // (c) any ingest stuck in error (this watchdog's own row doesn't count)
  const errRows = (statuses || []).filter(s => s.status === 'error' && s.data_key !== 'pipeline_watchdog');
  if (errRows.length) for (const s of errRows) fail(`${s.data_key} = error: ${String(s.message || '').slice(0, 140)}`);
  else ok(`no error rows (${(statuses || []).length} tracked)`);

  // (d) the JSA ingest runs LOCALLY (gov WAF blocks CI) — a dead scheduled task shows up only here
  // 25d (not 40): JSA runs the 10th, watchdog the 14th — last month's run is
  // ~34d old by then, so 40d would only flag a dead task a month late.
  const jsa = byKey['job_creation_index'];
  const dJsa = days(jsa && jsa.last_ok_at);
  if (dJsa == null || dJsa > 25) fail(`JSA local run missed — job_creation_index last ok ${dJsa == null ? 'never' : dJsa + 'd ago'} (check the "Performance Forge - JSA Job Creation (monthly)" task on the laptop; scripts/register-jsa-task.ps1 restores it)`);
  else ok(`JSA local run current (job_creation_index ok ${dJsa}d ago)`);

  // ── report ──
  console.log('══ Data Forge watchdog ══\n');
  for (const m of oks) console.log('  ✓ ' + m);
  for (const m of warns) console.log('  ⚠ ' + m);
  for (const m of fails) console.log('  ✗ ' + m);
  console.log(`\n${oks.length} ok · ${warns.length} warnings · ${fails.length} failures`);

  // upsert the verdict so the Data Forge UI shows it (same shape as the pipeline_* rows)
  const now = new Date().toISOString();
  const summary = fails.length ? fails.join(' | ').slice(0, 600) : `All checks passed${warns.length ? ' (' + warns.length + ' warning' + (warns.length > 1 ? 's' : '') + ': ' + warns.join(' | ').slice(0, 300) + ')' : ''} ${now.slice(0, 10)}`;
  const row = { data_key: 'pipeline_watchdog', label: 'Pipeline watchdog', source: 'forge-watchdog.yml', status: fails.length ? 'error' : 'ok', message: summary, last_run_at: now, updated_at: now };
  if (!fails.length) row.last_ok_at = now;
  const { error: upErr } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (upErr) console.warn('  (forge_data_status not updated? ' + upErr.message + ')');

  if (fails.length) { console.error('\n✗ PIPELINE UNHEALTHY — see failures above (re-dispatch the missed workflow, or fix the errored ingest).'); process.exit(1); }
  console.log('\n✓ Pipeline healthy this month.');
}
main().catch(e => { console.error(e); process.exit(1); });
