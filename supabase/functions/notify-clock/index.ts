// =============================================================================
// notify-clock — Property Clock "someone else saved" email via Resend
//
// Triggered by tools/property-clock.html after a successful CLOUD save
// (saveState → clock_state update). Emails the owner whenever the person who
// saved is NOT the owner, so the owner knows when a teammate changed the clock.
//
// Flow:
//   1. Client posts { editorName?, summary? } with their JWT (fire-and-forget).
//   2. Function resolves the CALLER from the JWT (auth.getUser) — the editor
//      identity is taken from the token, never from the request body, so it
//      can't be spoofed.
//   3. If the caller's email == the owner's email → skip (no self-notify).
//   4. Build a small HTML email and POST it to Resend.
//
// Env vars (set via `supabase secrets set …`):
//   RESEND_API_KEY      Resend secret (required) — shared with notify-cadence.
//   CLOCK_OWNER_EMAIL   The "me" whose own saves are NOT notified
//                       (default: vandolf@performanceproperty.com.au).
//   CLOCK_NOTIFY_TO     Who receives the alert
//                       (default: same as CLOCK_OWNER_EMAIL).
//   CLOCK_FROM_EMAIL    Verified Resend sender
//                       (default: Property Clock <clock@performanceproperty.com.au>).
//   CLOCK_APP_URL       "Open Property Clock" link target
//                       (default: the live tool URL; button omitted if blank).
//
// Auto-provided by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const RESEND_API_KEY    = Deno.env.get('RESEND_API_KEY')    ?? '';
const OWNER_EMAIL       = (Deno.env.get('CLOCK_OWNER_EMAIL') ?? 'vandolf@performanceproperty.com.au').toLowerCase();
const NOTIFY_TO         = Deno.env.get('CLOCK_NOTIFY_TO')   ?? (Deno.env.get('CLOCK_OWNER_EMAIL') ?? 'vandolf@performanceproperty.com.au');
const FROM_EMAIL        = Deno.env.get('CLOCK_FROM_EMAIL')  ?? 'Property Clock <clock@performanceproperty.com.au>';
const APP_URL           = Deno.env.get('CLOCK_APP_URL')     ?? 'https://tools.performanceproperty.com.au/tools/property-clock.html';
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')      ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTimestamp(d: Date): string {
  try {
    return d.toLocaleString('en-AU', {
      timeZone: 'Australia/Brisbane',
      day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch { return d.toISOString(); }
}

function buildEmail(editorName: string, editorEmail: string, summary: string, when: Date) {
  const who      = editorName || editorEmail || 'A teammate';
  const emailSub = editorEmail && editorEmail.toLowerCase() !== who.toLowerCase()
    ? `<span style="color:#94a3b8">(${escapeHtml(editorEmail)})</span>` : '';
  const linkBlock = APP_URL
    ? `<a href="${escapeHtml(APP_URL)}" style="display:inline-block;background:#00b6cb;color:#0a1520;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-size:13px;font-family:Arial,Helvetica,sans-serif">Open Property Clock →</a>`
    : '';
  const summaryRow = summary
    ? `<tr><td style="padding:8px 28px 4px 28px"><p style="margin:0;color:#475569;font-size:13px;line-height:1.5">${escapeHtml(summary)}</p></td></tr>`
    : '';

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
  <table cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f1f5f9;padding:24px 12px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.10)">
        <tr><td style="padding:24px 28px 4px 28px">
          <div style="font-size:11px;letter-spacing:2px;color:#0891b2;text-transform:uppercase;font-weight:700">Performance Property · Property Clock</div>
        </td></tr>
        <tr><td style="padding:6px 28px 4px 28px">
          <h1 style="margin:0;font-size:22px;color:#0f172a;font-weight:800">🕐&nbsp; Property Clock updated</h1>
        </td></tr>
        <tr><td style="padding:6px 28px 14px 28px">
          <p style="margin:0;color:#475569;font-size:14px;line-height:1.5"><strong>${escapeHtml(who)}</strong> ${emailSub} saved changes to the Property Clock.</p>
        </td></tr>
        ${summaryRow}
        ${linkBlock ? `<tr><td style="padding:14px 28px 24px 28px">${linkBlock}</td></tr>` : ''}
        <tr><td style="padding:14px 28px;background:#f8fafc;color:#94a3b8;font-size:11px;border-top:1px solid #e2e8f0">Saved ${escapeHtml(fmtTimestamp(when))} · You're notified because a teammate (not you) edited the clock.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const subject = `Property Clock · updated by ${who}`;
  return { subject, html };
}

async function sendResend(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) return { ok: false, status: 0, error: 'RESEND_API_KEY not set on the function' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: text || res.statusText };
  }
  const json = await res.json().catch(() => ({} as any));
  return { ok: true, id: json.id };
}

function jsonResp(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')    return jsonResp({ error: 'method_not_allowed' }, 405);

  let body: { editorName?: string; summary?: string } = {};
  try { body = await req.json(); } catch { /* body is optional */ }

  /* Resolve the editor from the JWT — authoritative, not spoofable. */
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return jsonResp({ error: 'not_authenticated', detail: userErr?.message }, 401);

  const editorEmail = (user.email || '').toLowerCase();

  /* The whole point: don't email the owner about the owner's own saves. */
  if (editorEmail && editorEmail === OWNER_EMAIL) return jsonResp({ ok: true, skipped: 'self_edit' });
  if (!NOTIFY_TO) return jsonResp({ ok: true, skipped: 'no_recipient' });

  const editorName = (body.editorName || '').toString().slice(0, 120);
  const summary    = (body.summary || '').toString().slice(0, 300);
  const { subject, html } = buildEmail(editorName, user.email || '', summary, new Date());
  const result = await sendResend(NOTIFY_TO, subject, html);
  return jsonResp(result, result.ok ? 200 : 502);
});
