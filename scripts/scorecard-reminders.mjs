// =============================================================================
// scorecard-reminders.mjs — monthly Performance Scorecard email reminders
//
// Run by the "Scorecard Reminders" GitHub Actions workflow across a UTC window
// several times a day; this script figures out the real Australia/Sydney local
// date + hour and only acts on the right day/time. A de-dupe log
// (scorecard_notify_log, migration 075) guarantees each party is emailed at
// most once per month / role / phase, so repeated runs and GitHub's timing
// drift are harmless.
//
// Schedule (AEST/AEDT), per active scorecard for the CURRENT month. Each reminder
// has a CATCH-UP WINDOW (send day → endDay) so a dropped cron run (GitHub cron is
// best-effort and skips whole hour-blocks) doesn't permanently miss it:
//   Employee   — section 1 "Actual" + section 2 self-assessment
//                · first  3rd 08:00 (catch-up to 4th) · final 5th 12:00 (to 7th)
//   P&C        — section 2 "Achieved"
//                · first  8th 08:00 (to 9th)          · final 10th 12:00 (to 12th)
//   AU Manager — section 1 "Achieved" + section 3 comment
//                · first 13th 08:00 (to 14th)         · final 15th 12:00 (to 17th)
// A reminder is sent ONLY if that party's section is still incomplete and their
// account is email-linked. Completed → nothing. The de-dupe log keeps it once-only.
//
// Env (GitHub Secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   — read all scorecards, write log
//   RESEND_API_KEY                            — send email
//   SCORECARD_FROM_EMAIL   (optional)         — verified sender
//   SCORECARD_APP_URL      (optional)         — "Open your scorecard" link
// =============================================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = process.env.SUPABASE_URL || '';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RESEND_KEY    = process.env.RESEND_API_KEY || '';
const FROM_EMAIL    = process.env.SCORECARD_FROM_EMAIL || 'Performance Scorecards <scorecards@performanceproperty.com.au>';
const APP_URL       = process.env.SCORECARD_APP_URL || 'https://tools.performanceproperty.com.au/tools/scorecards.html';

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!RESEND_KEY) { console.error('Missing RESEND_API_KEY'); process.exit(1); }

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

/* ── Australia/Sydney local parts (handles AEST/AEDT automatically) ── */
function sydneyNow() {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = (t) => parts.find(p => p.type === t)?.value;
  return { year: +g('year'), month: +g('month'), day: +g('day'), hour: +g('hour') };
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/* Reminder schedule: which party/phase is due, with a CATCH-UP WINDOW.
 * `day`/`hour` = the intended send (local Sydney); `endDay` = last day the
 * reminder may still go out. GitHub Actions cron is best-effort and regularly
 * drops entire hour-blocks (e.g. the 00:00-03:00 UTC = ~noon-Sydney window),
 * so a single-day gate meant a dropped window = a permanently missed reminder.
 * With a window, any surviving run on the due day (at/after `hour`) OR on a
 * later day up to `endDay` sends it. The de-dupe log (scorecard_notify_log,
 * keyed month/role/phase) still guarantees each reminder goes out at most once.
 * Windows don't overlap within a role, so a catch-up never fires first+final
 * together; if a "first" window is dropped entirely, its later "final" covers it. */
const SCHEDULE = [
  { role: 'employee', phase: 'first', day: 3,  hour: 8,  endDay: 4  },
  { role: 'employee', phase: 'final', day: 5,  hour: 12, endDay: 7  },
  { role: 'pc',       phase: 'first', day: 8,  hour: 8,  endDay: 9  },
  { role: 'pc',       phase: 'final', day: 10, hour: 12, endDay: 12 },
  { role: 'manager',  phase: 'first', day: 13, hour: 8,  endDay: 14 },
  { role: 'manager',  phase: 'final', day: 15, hour: 12, endDay: 17 },
];

const rated = (v) => v === 'Yes' || v === 'Partial' || v === 'No';
const filled = (v) => String(v ?? '').trim() !== '';

/* Is a given party's section complete for this employee's card? */
function isDone(role, emp, behaviours, card) {
  const kpis = emp.kpis || [];
  const kr = (card && card.data && card.data.kpis) || [];
  const br = (card && card.data && card.data.behaviours) || [];
  if (role === 'employee') {
    return kpis.every((_, i) => filled(kr[i] && kr[i].actual)) &&
           behaviours.every((_, i) => !!(br[i] && br[i].self));
  }
  if (role === 'pc') {
    return behaviours.every((_, i) => rated(br[i] && br[i].achieved));
  }
  if (role === 'manager') {
    return kpis.every((_, i) => rated(kr[i] && kr[i].achieved)) &&
           filled(card && card.data && card.data.comments);
  }
  return false;
}

function userIdFor(role, emp) {
  return role === 'employee' ? emp.employee_user_id
       : role === 'pc'       ? emp.pc_user_id
       :                       emp.manager_user_id;
}

/* Per-role email copy. `emp.name` is the person being reviewed. */
function buildEmail(role, phase, emp, monthLabel, recipientName) {
  const finalTag = phase === 'final' ? 'Final reminder — ' : '';
  const hi = recipientName ? `Hi ${escapeHtml(recipientName.split(' ')[0])},` : 'Hi,';
  let heading, body, dueBy;
  if (role === 'employee') {
    heading = `${finalTag}Complete your ${monthLabel} scorecard`;
    body    = `Please fill in <b>Section 1 — your "Actual" KPI figures</b> and <b>Section 2 — your self-assessment</b> for ${escapeHtml(monthLabel)}.`;
    dueBy   = 'Due by the 5th.';
  } else if (role === 'pc') {
    heading = `${finalTag}Behaviour ratings needed — ${escapeHtml(emp.name)}`;
    body    = `Please rate <b>Section 2 — Behaviours &amp; Compliance</b> for <b>${escapeHtml(emp.name)}</b>'s ${escapeHtml(monthLabel)} scorecard.`;
    dueBy   = 'Due by the 10th.';
  } else {
    heading = `${finalTag}KPI ratings + comment needed — ${escapeHtml(emp.name)}`;
    body    = `Please complete <b>Section 1 — Achieved ratings &amp; notes</b> and your <b>Section 3 — Manager Comment</b> for <b>${escapeHtml(emp.name)}</b>'s ${escapeHtml(monthLabel)} scorecard.`;
    dueBy   = 'Due by the 15th.';
  }
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
  <table cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f1f5f9;padding:24px 12px"><tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.1)">
      <tr><td style="padding:24px 28px 4px"><div style="font-size:11px;letter-spacing:2px;color:#0891b2;text-transform:uppercase;font-weight:700">Performance Property · Scorecards</div></td></tr>
      <tr><td style="padding:6px 28px 4px"><h1 style="margin:0;font-size:21px;color:#0f172a;font-weight:800">🏅&nbsp; ${heading}</h1></td></tr>
      <tr><td style="padding:8px 28px 4px"><p style="margin:0 0 8px;color:#475569;font-size:14px;line-height:1.55">${hi}</p>
        <p style="margin:0;color:#475569;font-size:14px;line-height:1.55">${body} <b>${escapeHtml(dueBy)}</b></p></td></tr>
      <tr><td style="padding:16px 28px 24px"><a href="${escapeHtml(APP_URL)}" style="display:inline-block;background:#00b6cb;color:#04121c;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-size:13px">Open your scorecard →</a></td></tr>
      <tr><td style="padding:14px 28px;background:#f8fafc;color:#94a3b8;font-size:11px;border-top:1px solid #e2e8f0">Automated reminder · ${escapeHtml(monthLabel)} scorecard</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  const subject = role === 'employee'
    ? `${finalTag}Your ${monthLabel} scorecard needs completing`
    : `${finalTag}${role === 'pc' ? 'Behaviour ratings' : 'KPI ratings + comment'} needed — ${emp.name} (${monthLabel})`;
  return { subject, html };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function sendResend(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json().catch(() => ({}));
}

async function main() {
  const now = sydneyNow();
  const ym  = `${now.year}-${String(now.month).padStart(2, '0')}`;
  const fy  = now.month >= 7 ? now.year : now.year - 1;
  const monthLabel = `${MONTHS[now.month - 1]} ${now.year}`;

  // Due if: on the intended day at/after the send hour, OR any later day within
  // the catch-up window (any hour — the intended send was earlier and was missed).
  const due = SCHEDULE.filter(s =>
    (now.day === s.day && now.hour >= s.hour) ||
    (now.day > s.day && now.day <= (s.endDay ?? s.day)));
  if (!due.length) {
    console.log(`[scorecard-reminders] Sydney ${ym}-${String(now.day).padStart(2,'0')} ${now.hour}:00 — no reminders due. Exit.`);
    return;
  }
  console.log(`[scorecard-reminders] Sydney day ${now.day} ${now.hour}:00 — due: ${due.map(d => `${d.role}/${d.phase}`).join(', ')}`);

  const { data: cfgRow } = await sb.from('scorecard_config').select('data').eq('id', 1).maybeSingle();
  const behaviours = (cfgRow && cfgRow.data && cfgRow.data.behaviours) || [];

  const { data: roster, error: rErr } = await sb.from('scorecard_employees')
    .select('*').eq('fy', fy).neq('active', false);
  if (rErr) throw rErr;
  if (!roster || !roster.length) { console.log(`[scorecard-reminders] no active roster for FY ${fy}.`); return; }

  const empIds = roster.map(e => e.id);
  const { data: cards } = await sb.from('scorecards').select('employee_id, data').eq('ym', ym).in('employee_id', empIds);
  const cardBy = new Map((cards || []).map(c => [c.employee_id, c]));

  const { data: logRows } = await sb.from('scorecard_notify_log').select('employee_id, role, phase').eq('ym', ym);
  const sent = new Set((logRows || []).map(l => `${l.employee_id}|${l.role}|${l.phase}`));

  /* Resolve emails for every linked account we might need, in one query. */
  const uids = [...new Set(roster.flatMap(e => [e.employee_user_id, e.manager_user_id, e.pc_user_id]).filter(Boolean))];
  const emailBy = new Map();
  if (uids.length) {
    const { data: profs } = await sb.from('profiles').select('id, email, full_name').in('id', uids);
    (profs || []).forEach(p => emailBy.set(p.id, p));
  }

  let sentCount = 0, skipDone = 0, skipNoAccount = 0, skipAlready = 0;
  for (const s of due) {
    for (const emp of roster) {
      if (isDone(s.role, emp, behaviours, cardBy.get(emp.id))) { skipDone++; continue; }
      const key = `${emp.id}|${s.role}|${s.phase}`;
      if (sent.has(key)) { skipAlready++; continue; }
      const uid = userIdFor(s.role, emp);
      const prof = uid && emailBy.get(uid);
      if (!prof || !prof.email) { skipNoAccount++; console.log(`  skip ${emp.name}/${s.role}: no linked account/email`); continue; }
      const { subject, html } = buildEmail(s.role, s.phase, emp, monthLabel, prof.full_name || '');
      try {
        await sendResend(prof.email, subject, html);
        await sb.from('scorecard_notify_log').upsert(
          { employee_id: emp.id, ym, role: s.role, phase: s.phase },
          { onConflict: 'employee_id,ym,role,phase', ignoreDuplicates: true },
        );
        sent.add(key);
        sentCount++;
        console.log(`  sent ${s.role}/${s.phase} → ${prof.email} (${emp.name})`);
      } catch (err) {
        console.error(`  FAILED ${s.role}/${s.phase} for ${emp.name}: ${err.message}`);
      }
    }
  }
  console.log(`[scorecard-reminders] done. sent=${sentCount} skip(done)=${skipDone} skip(already)=${skipAlready} skip(no-account)=${skipNoAccount}`);
}

main().catch(err => { console.error(err); process.exit(1); });
