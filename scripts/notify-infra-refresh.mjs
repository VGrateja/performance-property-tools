// ============================================================================
// notify-infra-refresh.mjs — quarterly email nudge to refresh the B/S Slides
// "Major Infrastructure Projects" page (Van 2026-08-11: the numbers are
// hardcoded in tools/buying-selling-slides.html INFRA_PROJECTS and only
// update quarterly — "notify me about them every quarter").
//
// Fired by .github/workflows/infra-projects-reminder.yml on the 1st of
// Feb / May / Aug / Nov. Stateless — one email per run, no DB involved.
//
// Secrets: RESEND_API_KEY (same key the scorecard reminders use).
// ============================================================================
const RESEND_KEY = process.env.RESEND_API_KEY;
const TO         = process.env.INFRA_REMINDER_TO || 'vandolf@performanceproperty.com.au';
const FROM_EMAIL = process.env.SCORECARD_FROM_EMAIL || 'Performance Property Tools <scorecards@performanceproperty.com.au>';
if (!RESEND_KEY) { console.error('RESEND_API_KEY missing'); process.exit(1); }

const REGIONS = ['Rockingham', 'Mandurah', 'Townsville', 'Darwin'];
const html = `
  <div style="font-family:Arial,sans-serif;font-size:14px;color:#171B24;line-height:1.6">
    <p><b>Quarterly refresh due — B/S Slides “Major Infrastructure Projects”.</b></p>
    <p>The hardcoded project tables for <b>${REGIONS.join(' · ')}</b> update quarterly.
    Re-check the top-5 projects per region (budget, timeline, construction jobs, operational jobs)
    and update <code>INFRA_PROJECTS</code> in <code>tools/buying-selling-slides.html</code>.</p>
    <p style="color:#63666A;font-size:12px">Sent by infra-projects-reminder.yml (1 Feb / May / Aug / Nov).</p>
  </div>`;

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ from: FROM_EMAIL, to: TO, subject: 'Quarterly refresh: B/S Major Infrastructure Projects (4 regions)', html }),
});
if (!res.ok) { console.error(`Resend ${res.status}: ${await res.text().catch(() => '')}`); process.exit(1); }
console.log('✓ reminder sent to', TO);
