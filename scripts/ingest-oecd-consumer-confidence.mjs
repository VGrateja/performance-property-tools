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

/* OECD's SDMX API is intermittently flaky server-side: one backend in their
   rotation answers HTTP 500 "languageTag1" while the others are fine — the
   IDENTICAL request succeeds seconds later (reproduced 2026-08-10; it failed
   the 2026-08 monthly gather this way). Retry a few times with backoff so a
   single bad backend doesn't redden the whole GATHER run. */
let text = '', lastErr = '';
for (let attempt = 1; attempt <= 4; attempt++) {
  if (attempt > 1) { console.log(`  OECD retry ${attempt}/4 (${lastErr})…`); await new Promise(res => setTimeout(res, 5000 * (attempt - 1))); }
  try {
    const r = await fetch(SRC, { headers: { Accept: 'application/vnd.sdmx.data+json' } });
    const t = await r.text();
    if (t.trim().startsWith('{')) { text = t; break; }
    lastErr = `OECD ${r.status}: ${t.slice(0, 100)}`;
  } catch (e) { lastErr = String(e && e.message || e).slice(0, 100); }
}
if (!text) { console.error(`OECD unreachable after 4 attempts — last: ${lastErr}`); process.exit(1); }
const j = JSON.parse(text);

const struct = (j.data.structures || [j.data.structure])[0];
const timeDim = struct.dimensions.observation[0];
const series = Object.values(j.data.dataSets[0].series || {})[0];
if (!series) { console.error('OECD returned no series for AUS — has the dataflow version moved past 4.1?'); process.exit(1); }

const obs = Object.entries(series.observations)
  .map(([i, v]) => [timeDim.values[+i].id, Number(v[0])])
  .filter(([ym, v]) => /^\d{4}-\d{2}$/.test(ym) && isFinite(v))
  .sort((a, b) => a[0].localeCompare(b[0]));

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
