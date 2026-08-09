// =============================================================================
// ingest-oecd-consumer-confidence.mjs — Data Forge: CONSUMER CONFIDENCE (CCI).
//
// OECD Consumer Confidence Index for AUSTRALIA, monthly. Per the B/S data
// guide: "Consumer confidence index (CCI) | OECD — choose Australia, uncheck
// OECD from the drop down", i.e. the country series only, not the OECD total.
//
// OECD Data Explorer SDMX-JSON (no key required):
//   dataflow OECD.SDD.STES,DSD_STES@DF_CLI,4.1
//   key AUS.M.CCICP...AA...H
//        REF_AREA=AUS · FREQ=M · MEASURE=CCICP (consumer confidence) ·
//        ADJUSTMENT=AA (amplitude adjusted) · METHODOLOGY=H
//   History runs from 1974-09. The index is centred on 100 = the long-run
//   average, so it sits in a narrow band (~96-102) — a chart of it MUST NOT
//   start its y-axis at zero or the whole series flatlines.
//
// NOTE the observations come back UNORDERED in the JSON — always sort.
//
// ISOLATED: rdp_raw_series (source='oecd', metric 'consumer_confidence',
// region 'australia', freq 'M') + forge_data_status. Upsert-only.
// Dry-run by DEFAULT; --write upserts.
//   node scripts/ingest-oecd-consumer-confidence.mjs [--write]
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const SRC = 'https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI,4.1/AUS.M.CCICP...AA...H?format=jsondata';

/* OECD's SDMX API fails in ways that are REGION-DEPENDENT: during the 2026-08
   gather, GitHub's US runners got HTTP 500 "languageTag1" on every attempt
   (6+ consecutive over two runs, retries included) while the identical request
   from Australia returned 200 — their US edge/backend was broken, ours wasn't.
   So retrying alone can't save a CI run. Three layers instead:
     1. SDMX-JSON, 4 attempts with >4s backoff (Node closes idle keep-alive
        sockets after ~4s, so each retry opens a fresh connection);
     2. the CSV endpoint (?format=csvfilewithlabels) — a different serializer,
        which a broken JSON writer may not take down;
     3. if OECD is fully unreachable but the DB's newest CCI row is recent
        (≤75 days — it's a MONTHLY national series that OECD publishes ~6
        weeks in arrears), SKIP with exit 0 so one upstream outage doesn't
        redden the whole GATHER. A genuinely stale series still fails hard. */
let lastErr = '';
async function fetchAttempt(url, accept) {
  try {
    const r = await fetch(url, accept ? { headers: { Accept: accept } } : undefined);
    const t = await r.text();
    if (r.ok) return t;
    lastErr = `OECD ${r.status}: ${t.slice(0, 100)}`;
  } catch (e) { lastErr = String(e && e.message || e).slice(0, 100); }
  return null;
}
function parseJsonObs(text) {
  try {
    const j = JSON.parse(text);
    const struct = (j.data.structures || [j.data.structure])[0];
    const timeDim = struct.dimensions.observation[0];
    const series = Object.values(j.data.dataSets[0].series || {})[0];
    if (!series) { lastErr = 'no series for AUS in JSON — dataflow moved past 4.1?'; return null; }
    return Object.entries(series.observations).map(([i, v]) => [timeDim.values[+i].id, Number(v[0])]);
  } catch (e) { lastErr = 'JSON parse: ' + String(e && e.message || e).slice(0, 80); return null; }
}
function parseCsvObs(text) {
  try {
    const rows = text.split(/\r?\n/).filter(Boolean);
    const split = ln => (ln.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map(c => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
    const head = split(rows[0]);
    const iT = head.indexOf('TIME_PERIOD'), iV = head.indexOf('OBS_VALUE');
    if (iT < 0 || iV < 0) { lastErr = 'CSV missing TIME_PERIOD/OBS_VALUE columns'; return null; }
    return rows.slice(1).map(split).map(c => [c[iT], Number(c[iV])]);
  } catch (e) { lastErr = 'CSV parse: ' + String(e && e.message || e).slice(0, 80); return null; }
}

let raw = null;
for (let attempt = 1; attempt <= 4 && !raw; attempt++) {
  if (attempt > 1) { console.log(`  OECD retry ${attempt}/4 (${lastErr})…`); await new Promise(res => setTimeout(res, 5000 * (attempt - 1))); }
  const t = await fetchAttempt(SRC, 'application/vnd.sdmx.data+json');
  if (t) raw = parseJsonObs(t);
}
if (!raw) {
  console.log(`  JSON endpoint down (${lastErr}) — trying the CSV endpoint…`);
  const t = await fetchAttempt(SRC.replace('format=jsondata', 'format=csvfilewithlabels'), null);
  if (t) raw = parseCsvObs(t);
}

let skipped = false;
if (!raw) {
  /* both formats down — skip gracefully if the stored series is still fresh */
  const KEY0 = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (KEY0) {
    const sb0 = createClient(process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co', KEY0, { auth: { persistSession: false } });
    const { data: newest } = await sb0.from('rdp_raw_series').select('period')
      .eq('source', 'oecd').eq('metric', 'consumer_confidence').eq('region_slug', 'australia')
      .order('period', { ascending: false }).limit(1).maybeSingle();
    const ageDays = newest ? (Date.now() - new Date(newest.period).getTime()) / 86400000 : Infinity;
    if (ageDays <= 75) {
      console.log(`OECD unreachable (${lastErr}), but the stored CCI series is current `
        + `(latest ${String(newest.period).slice(0, 7)}, ${Math.round(ageDays)} days old — it publishes ~6 weeks in arrears).`);
      console.log('SKIPPING this month rather than failing the gather. It will catch up next run.');
      skipped = true;
    }
  }
  if (!skipped) { console.error(`OECD unreachable after JSON retries + CSV fallback — last: ${lastErr}`); process.exitCode = 1; }
}

const obs = skipped || !raw ? [] : raw
  .filter(([ym, v]) => /^\d{4}-\d{2}$/.test(ym) && isFinite(v))
  .sort((a, b) => a[0].localeCompare(b[0]));

if (obs.length) {
const out = obs.map(([ym, v]) => ({
  source: 'oecd', region_slug: 'australia', metric: 'consumer_confidence',
  freq: 'M', period: ym + '-01', value: Math.round(v * 1000) / 1000,
}));

/* ── report ───────────────────────────────────────────────────────────── */
const vals = out.map(o => o.value);
console.log('OECD Consumer Confidence Index (CCI) — Australia, monthly, amplitude adjusted (100 = long-run average)');
console.log('Rows    : ' + out.length + '   ' + out[0].period.slice(0, 7) + ' → ' + out[out.length - 1].period.slice(0, 7));
console.log('Range   : ' + Math.min(...vals).toFixed(2) + ' – ' + Math.max(...vals).toFixed(2));
console.log('\nLatest 6:');
out.slice(-6).forEach(o => console.log('   ' + o.period.slice(0, 7) + '   ' + o.value.toFixed(2) + (o.value >= 100 ? '  (above average)' : '  (below average)')));

/* ── write ────────────────────────────────────────────────────────────────
   NOTE: no process.exit() on the success paths. Node on Windows aborts with a
   libuv assertion (UV_HANDLE_CLOSING) if it exits while the undici keep-alive
   socket from the fetch above is still open — which looked like a crash and
   would fail the CI step even though the run succeeded. Falling off the end
   lets the socket close on its own. */
if (!WRITE) {
  console.log('\nDry run — nothing written. Re-run with --write to upsert.');
} else {
  const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exitCode = 1; }
  else {
    const sb = createClient(URL, KEY, { auth: { persistSession: false } });
    let failed = false;
    for (let i = 0; i < out.length && !failed; i += 500) {
      const { error } = await sb.from('rdp_raw_series').upsert(out.slice(i, i + 500), { onConflict: 'source,region_slug,metric,freq,period' });
      if (error) { console.error('Upsert failed at row ' + i + ': ' + error.message); process.exitCode = 1; failed = true; }
    }
    if (!failed) {
      const now = new Date().toISOString();
      const { error: sErr } = await sb.from('forge_data_status').upsert({
        data_key: 'consumer_confidence', label: 'Consumer Confidence',
        source: 'OECD Consumer Confidence Index (CCI), Australia — SDMX DSD_STES@DF_CLI',
        status: 'ok', message: out.length + ' months · ' + out[0].period.slice(0, 7) + '–' + out[out.length - 1].period.slice(0, 7),
        last_run_at: now, last_ok_at: now, updated_at: now,
      }, { onConflict: 'data_key' });
      if (sErr) console.warn('  (forge_data_status not updated? ' + sErr.message + ')');
      console.log('\n✓ Upserted ' + out.length + ' consumer-confidence rows.');
    }
  }
}
}
