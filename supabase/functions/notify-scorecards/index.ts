// =============================================================================
// notify-scorecards — "ready to sign off" email when the AU Manager signs.
//
// Triggered by tools/scorecards.html the moment a manager clicks Sign on a
// MONTHLY scorecard. Emails the Employee + P&C that the manager has signed and
// it's their turn.
//
// Flow:
//   1. Client POSTs { event:'manager-signed', scorecardId } with their JWT.
//   2. Verify the caller is the AU Manager linked to that scorecard.
//   3. Resolve Employee + P&C emails (service role — the manager can't read
//      other people's profiles under RLS).
//   4. Email each of them via Resend.
//
// The scheduled *reminders* are a separate GitHub Actions job
// (scripts/scorecard-reminders.mjs) — this function only handles the
// event-driven sign-off nudge.
//
// Env: RESEND_API_KEY, SCORECARD_FROM_EMAIL, SCORECARD_APP_URL.
// Auto-provided: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')            ?? '';
const FROM_EMAIL     = Deno.env.get('SCORECARD_FROM_EMAIL')      ?? 'Performance Scorecards <scorecards@performanceproperty.com.au>';
const APP_URL        = Deno.env.get('SCORECARD_APP_URL')         ?? 'https://tools.performanceproperty.com.au/tools/scorecards.html';
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')              ?? '';
const ANON_KEY       = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';
const SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function jsonResp(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
function monthLabel(ym: string): string {
  const [y, m] = String(ym || '').split('-').map(Number);
  return (m >= 1 && m <= 12) ? `${MONTHS[m - 1]} ${y}` : (ym || '');
}

function buildEmail(empName: string, firstName: string, ml: string) {
  const hi = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,';
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
  <table cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f1f5f9;padding:24px 12px"><tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.1)">
      <tr><td style="padding:24px 28px 4px"><div style="font-size:11px;letter-spacing:2px;color:#0891b2;text-transform:uppercase;font-weight:700">Performance Property · Scorecards</div></td></tr>
      <tr><td style="padding:6px 28px 4px"><h1 style="margin:0;font-size:21px;color:#0f172a;font-weight:800">✍️&nbsp; Ready for your sign-off</h1></td></tr>
      <tr><td style="padding:8px 28px 4px">
        <p style="margin:0 0 8px;color:#475569;font-size:14px;line-height:1.55">${hi}</p>
        <p style="margin:0;color:#475569;font-size:14px;line-height:1.55">The AU Line Manager has signed <b>${escapeHtml(empName)}</b>'s <b>${escapeHtml(ml)}</b> scorecard. Please review it and add your signature to complete the three-party sign-off.</p>
      </td></tr>
      <tr><td style="padding:16px 28px 24px"><a href="${escapeHtml(APP_URL)}" style="display:inline-block;background:#00b6cb;color:#04121c;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-size:13px">Review &amp; sign off →</a></td></tr>
      <tr><td style="padding:14px 28px;background:#f8fafc;color:#94a3b8;font-size:11px;border-top:1px solid #e2e8f0">Automated notification · ${escapeHtml(ml)} scorecard</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { subject: `Sign-off needed — ${empName} (${ml})`, html };
}

async function sendResend(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY not set' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) return { ok: false, status: res.status, error: await res.text().catch(() => '') };
  const j = await res.json().catch(() => ({} as any));
  return { ok: true, id: j.id, to };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')    return jsonResp({ error: 'method_not_allowed' }, 405);

  let body: { event?: string; scorecardId?: string };
  try { body = await req.json(); } catch { return jsonResp({ error: 'invalid_json' }, 400); }
  if (body.event !== 'manager-signed') return jsonResp({ error: 'invalid_event' }, 400);
  if (!body.scorecardId)               return jsonResp({ error: 'missing_scorecardId' }, 400);

  /* Who's calling? (JWT already validated by the platform.) */
  const authClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: userData } = await authClient.auth.getUser();
  const callerId = userData?.user?.id;
  if (!callerId) return jsonResp({ error: 'unauthenticated' }, 401);

  /* Service-role reads: the manager can't read the other parties' profiles. */
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: card, error: cardErr } = await admin
    .from('scorecards').select('id, employee_id, ym, signoffs').eq('id', body.scorecardId).single();
  if (cardErr || !card) return jsonResp({ error: 'scorecard_not_found' }, 404);

  const { data: emp, error: empErr } = await admin
    .from('scorecard_employees')
    .select('name, employee_user_id, manager_user_id, pc_user_id')
    .eq('id', card.employee_id).single();
  if (empErr || !emp) return jsonResp({ error: 'employee_not_found' }, 404);

  /* Only the linked AU Manager may trigger this. */
  if (callerId !== emp.manager_user_id) return jsonResp({ error: 'not_the_manager' }, 403);

  const targetIds = [emp.employee_user_id, emp.pc_user_id].filter(Boolean) as string[];
  if (!targetIds.length) return jsonResp({ ok: true, skipped: 'no_linked_recipients' });

  const { data: profs } = await admin.from('profiles').select('id, email, full_name').in('id', targetIds);
  const ml = monthLabel(card.ym);
  const results = [];
  for (const p of (profs || [])) {
    if (!p.email) continue;
    const { subject, html } = buildEmail(emp.name, (p.full_name || '').split(' ')[0], ml);
    results.push(await sendResend(p.email, subject, html));
  }
  return jsonResp({ ok: true, sent: results });
});
