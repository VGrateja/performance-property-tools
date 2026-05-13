// =============================================================================
// notify-cadence — Cadence email notifications via Resend
//
// Triggered by cadence.html on card create + completion.
//
// Flow:
//   1. Client posts { event:'created'|'completed', cardId } with their JWT.
//   2. Function loads the card + board using an authenticated supabase
//      client (RLS applies — only staff can read).
//   3. If the board has notify=false, skip silently.
//   4. Resolve recipient:
//        - created    → CADENCE_ALIAS_EMAIL (the PH Team alias)
//        - completed  → card.created_by_email (the original filer)
//   5. Build a small HTML email summarising the card's data fields.
//   6. POST to Resend; return success/failure to the client.
//
// Env vars (set via `supabase secrets set …`):
//   RESEND_API_KEY        Resend secret (required)
//   CADENCE_ALIAS_EMAIL   PH Team destination for "created" events
//                         (default: vandolf@performanceproperty.com.au)
//   CADENCE_FROM_EMAIL    Verified sender, e.g. "Cadence <cadence@…>"
//                         (default: Cadence <cadence@performanceproperty.com.au>)
//   CADENCE_APP_URL       Deep link target for the "Open in Cadence" button
//                         (default: empty — button omitted if not set)
//
// Auto-provided by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const RESEND_API_KEY    = Deno.env.get('RESEND_API_KEY')      ?? '';
const CADENCE_ALIAS     = Deno.env.get('CADENCE_ALIAS_EMAIL') ?? 'vandolf@performanceproperty.com.au';
const CADENCE_FROM      = Deno.env.get('CADENCE_FROM_EMAIL')  ?? 'Cadence <cadence@performanceproperty.com.au>';
const CADENCE_APP_URL   = Deno.env.get('CADENCE_APP_URL')     ?? '';
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')        ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')   ?? '';

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

/* Format a single field value the same way the table does in cadence.html
   — keeps the email visually consistent with the in-app view. */
function fmtValue(field: { kind?: string; type?: string; prefix?: string }, v: unknown): string {
  if (v == null || v === '') return '—';
  if (field.kind === 'stage' || field.type === 'checkbox') return v ? 'Yes' : 'No';
  if (field.type === 'number') return (field.prefix || '') + Number(v).toLocaleString('en-AU');
  if (field.type === 'date') {
    try {
      return new Date(String(v)).toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' });
    } catch { return String(v); }
  }
  return String(v);
}

function fmtTimestamp(ts: string | null | undefined): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-AU', {
      day:'numeric', month:'short', year:'numeric',
      hour:'numeric', minute:'2-digit',
    });
  } catch { return ts; }
}

interface Board { slug: string; name: string; icon: string | null; schema: any; notify: boolean }
interface Card  { id: string; board_slug: string; data: any; created_at: string; created_by_email: string | null; completed_at: string | null }

function buildEmail(event: 'created'|'completed', board: Board, card: Card) {
  const icon       = board.icon || '📋';
  const boardName  = board.name || 'Cadence';
  const dataFields = (board.schema?.fields || []).filter((f: any) => f.kind === 'data');

  /* Up to 6 filled data fields — keeps the email short. Empty fields
     ("—") are dropped so PMs don't get an inbox full of placeholders. */
  const rows = dataFields
    .map((f: any) => ({ label: f.label, value: fmtValue(f, card.data?.[f.key]) }))
    .filter((r: any) => r.value !== '—')
    .slice(0, 6);

  const rowsHtml = rows.map((r) => `
    <tr>
      <td style="padding:6px 0;color:#64748b;font-size:13px;width:42%;vertical-align:top">${escapeHtml(r.label)}</td>
      <td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600">${escapeHtml(r.value)}</td>
    </tr>`).join('');

  const heading = event === 'created'
    ? `New ${boardName} card`
    : `${boardName} card completed`;

  const subText = event === 'created'
    ? `A new task has been filed by ${escapeHtml(card.created_by_email || 'someone')}.`
    : `Your Cadence card has been marked complete.`;

  const linkBlock = CADENCE_APP_URL
    ? `<a href="${escapeHtml(CADENCE_APP_URL)}" style="display:inline-block;background:#00b6cb;color:#0a1520;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-size:13px;font-family:Arial,Helvetica,sans-serif">Open in Cadence →</a>`
    : '';

  const footer = event === 'created'
    ? `Filed by ${escapeHtml(card.created_by_email || 'unknown')} · ${escapeHtml(fmtTimestamp(card.created_at))}`
    : `Completed ${escapeHtml(fmtTimestamp(card.completed_at))}`;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
  <table cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f1f5f9;padding:24px 12px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.10)">
        <tr><td style="padding:24px 28px 4px 28px">
          <div style="font-size:11px;letter-spacing:2px;color:#0891b2;text-transform:uppercase;font-weight:700">Performance Property · Cadence</div>
        </td></tr>
        <tr><td style="padding:6px 28px 4px 28px">
          <h1 style="margin:0;font-size:22px;color:#0f172a;font-weight:800">${icon}&nbsp; ${escapeHtml(heading)}</h1>
        </td></tr>
        <tr><td style="padding:6px 28px 14px 28px">
          <p style="margin:0;color:#475569;font-size:14px;line-height:1.5">${subText}</p>
        </td></tr>
        ${rowsHtml ? `<tr><td style="padding:8px 28px 16px 28px">
          <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">${rowsHtml}</table>
        </td></tr>` : ''}
        ${linkBlock ? `<tr><td style="padding:0 28px 24px 28px">${linkBlock}</td></tr>` : ''}
        <tr><td style="padding:14px 28px;background:#f8fafc;color:#94a3b8;font-size:11px;border-top:1px solid #e2e8f0">${footer}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const subject = event === 'created'
    ? `Cadence · New ${boardName} card${card.created_by_email ? ' from ' + card.created_by_email : ''}`
    : `Cadence · ${boardName} card completed`;

  return { subject, html };
}

async function sendResend(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) {
    return { ok: false, status: 0, error: 'RESEND_API_KEY not set on the function' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ from: CADENCE_FROM, to, subject, html }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: text || res.statusText };
  }
  const json = await res.json().catch(() => ({} as any));
  return { ok: true, id: json.id };
}

function jsonResp(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')    return jsonResp({ error: 'method_not_allowed' }, 405);

  let payload: { event?: string; cardId?: string };
  try { payload = await req.json(); }
  catch { return jsonResp({ error: 'invalid_json' }, 400); }

  const event  = payload.event;
  const cardId = payload.cardId;
  if (event !== 'created' && event !== 'completed') return jsonResp({ error: 'invalid_event' }, 400);
  if (!cardId)                                       return jsonResp({ error: 'missing_cardId' }, 400);

  /* Authenticated client — forwards the user's JWT so RLS applies on
     the card + board reads. Anonymous reads would fail (no policy match). */
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });

  const { data: card, error: cardErr } = await supabase
    .from('cadence_cards')
    .select('id, board_slug, data, created_at, created_by_email, completed_at')
    .eq('id', cardId)
    .single();
  if (cardErr || !card) return jsonResp({ error: 'card_not_found', detail: cardErr?.message }, 404);

  const { data: board, error: boardErr } = await supabase
    .from('cadence_boards')
    .select('slug, name, icon, schema, notify')
    .eq('slug', card.board_slug)
    .single();
  if (boardErr || !board) return jsonResp({ error: 'board_not_found', detail: boardErr?.message }, 404);

  /* Per-board mute. */
  if (board.notify === false) return jsonResp({ ok: true, skipped: 'notify_disabled' });

  /* Recipient resolution. */
  let to = '';
  if (event === 'created')        to = CADENCE_ALIAS;
  else if (event === 'completed') to = card.created_by_email || '';
  if (!to) return jsonResp({ ok: true, skipped: 'no_recipient' });

  const { subject, html } = buildEmail(event, board as Board, card as Card);
  const result = await sendResend(to, subject, html);
  return jsonResp(result, result.ok ? 200 : 502);
});
