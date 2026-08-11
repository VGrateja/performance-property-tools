// ============================================================================
// sync-rolling-cash-to-runway-config.mjs — keep the Runway forecast cash rate
// equal to the rolling 216-month average of the RBA cash rate (Van 2026-08-11).
//
// Since Mar 2026 the PP IC's forecast method IS the rolling average, but the
// number lived in rdp_runway_config as a hand-typed assumption: the GATHER
// computed the fresh average every month and only printed it on the Cash Rate
// card — nobody carried it into the config. This step closes that gap, so by
// policy the forecast cash rate is DEFINED as the rolling average; a
// discretionary IC number typed into the Runway Workbook's Assumptions panel
// will be overwritten at the next PUBLISH.
//
// Writes rdp_runway_config key='rates': forecast.cash = avg216 (rounded to
// 2dp of percent, matching how the IC adopted it — so it only moves on a
// genuine basis-point shift) and forecast.rate = cash + margin + apra.
// Margin / APRA / current-side values are never touched.
//
// Consumers of forecast.rate: Runway Workbook (live), build-runway.mjs (baked
// into rdp_runway payloads at publish), Runway v Demand + Demand Score
// (display re-rate basis, fetched at boot).
//
// Dry-run by default; --write applies. Fails loudly if the cash series is
// short (<216 months) or the average is implausible.
// ============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const WRITE = process.argv.includes('--write');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: rows, error: rerr } = await sb.from('rdp_raw_series').select('period,value')
  .eq('source', 'rba').eq('metric', 'cash_rate').eq('freq', 'M')
  .order('period', { ascending: false }).limit(216);
if (rerr) { console.error('✗ cash series read failed: ' + rerr.message); process.exit(1); }
if (!rows || rows.length < 216) { console.error(`✗ cash series too short: ${rows ? rows.length : 0} months (need 216) — refusing to move the average.`); process.exit(1); }

const avg = rows.reduce((s, r) => s + (+r.value), 0) / rows.length;
const cashNew = Math.round(avg * 10000) / 10000;            // 2dp of percent (0.0265 = 2.65%)
if (!(cashNew > 0.005 && cashNew < 0.08)) { console.error(`✗ implausible 216M average ${(cashNew * 100).toFixed(2)}% — refusing to write.`); process.exit(1); }

const { data: cfgRow, error: cerr } = await sb.from('rdp_runway_config').select('value').eq('key', 'rates').maybeSingle();
if (cerr || !cfgRow) { console.error('✗ rdp_runway_config rates read failed: ' + (cerr ? cerr.message : 'no row')); process.exit(1); }
const rates = cfgRow.value, fc = rates.forecast || {};
if (!(fc.margin > 0) || !(fc.apra >= 0)) { console.error('✗ forecast margin/apra missing in config — refusing to derive the rate.'); process.exit(1); }
const rateNew = Math.round((cashNew + fc.margin + fc.apra) * 10000) / 10000;

console.log(`rolling 216M cash avg: ${(avg * 100).toFixed(4)}% → rounded ${(cashNew * 100).toFixed(2)}%  (newest month ${rows[0].period.slice(0, 7)})`);
console.log(`config forecast: cash ${(fc.cash * 100).toFixed(2)}% → ${(cashNew * 100).toFixed(2)}% · rate ${(fc.rate * 100).toFixed(2)}% → ${(rateNew * 100).toFixed(2)}%  (margin ${(fc.margin * 100).toFixed(2)}% + APRA ${(fc.apra * 100).toFixed(2)}% unchanged)`);

/* Email Pre DD + Jonathan when the assumption moves (Saskia 2026-08-10 via
   Van 2026-08-11). Fail-soft: a mail hiccup must never fail the publish.
   --notify-current sends the CURRENT assumption without requiring a change
   (inaugural/baseline note or a test). Needs RESEND_API_KEY (same secret as
   the scorecard reminders); silently skipped when absent (local runs). */
const NOTIFY_TO = (process.env.RATE_NOTIFY_TO || 'ppc@performanceproperty.com.au,jonathan@performanceproperty.com.au').split(',').map(s => s.trim());
const FROM_EMAIL = process.env.SCORECARD_FROM_EMAIL || 'Performance Property Tools <scorecards@performanceproperty.com.au>';
const pct = v => (v * 100).toFixed(2) + '%';
async function notifyRateChange(oldCash, oldRate, newCash, newRate, isBaseline) {
  const KEY = process.env.RESEND_API_KEY;
  if (!KEY) { console.log('  (RESEND_API_KEY not set — email notification skipped)'); return; }
  const subject = isBaseline
    ? `Rolling cash rate assumption — current: ${pct(newCash)} (PP variable ${pct(newRate)})`
    : `Rolling cash rate assumption updated: ${pct(oldCash)} → ${pct(newCash)} (PP variable ${pct(oldRate)} → ${pct(newRate)})`;
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#171B24;line-height:1.6">
      <p><b>${isBaseline ? 'Current rolling cash rate assumption' : 'The rolling cash rate assumption has changed'}.</b></p>
      <table style="border-collapse:collapse;font-size:14px">
        <tr><td style="padding:4px 14px 4px 0;color:#63666A">Forecast cash rate</td><td style="padding:4px 0"><b>${isBaseline ? pct(newCash) : pct(oldCash) + ' → ' + pct(newCash)}</b></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#63666A">PP variable rate</td><td style="padding:4px 0"><b>${isBaseline ? pct(newRate) : pct(oldRate) + ' → ' + pct(newRate)}</b> (cash + ${pct(fc.margin)} margin + ${pct(fc.apra)} APRA)</td></tr>
      </table>
      <p>The forecast cash rate is the <b>rolling 216-month average of the RBA cash rate</b>, refreshed automatically at the monthly data publish. This rate drives the Runway Workbook, Runway v Demand and the Demand Score dashboard.</p>
      <p style="color:#63666A;font-size:12px">Sent automatically by the Data Forge publish pipeline.</p>
    </div>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to: NOTIFY_TO, subject, html }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text().catch(() => '')}`);
    console.log('✓ change notification emailed to ' + NOTIFY_TO.join(', '));
  } catch (e) { console.error('⚠ email notification failed (publish continues): ' + e.message); }
}

if (process.argv.includes('--notify-current')) { await notifyRateChange(null, null, fc.cash, fc.rate, true); process.exit(0); }
if (fc.cash === cashNew && fc.rate === rateNew) { console.log('✓ already in sync — nothing to write.'); process.exit(0); }
if (!WRITE) { console.log('\nDry run — re-run with --write to update rdp_runway_config.'); process.exit(0); }

const next = { ...rates, forecast: { ...fc, cash: cashNew, rate: rateNew } };
const { error: werr } = await sb.from('rdp_runway_config').update({ value: next }).eq('key', 'rates');
if (werr) { console.error('✗ config write failed: ' + werr.message); process.exit(1); }
console.log('✓ rdp_runway_config rates.forecast updated.');
await notifyRateChange(fc.cash, fc.rate, cashNew, rateNew, false);
