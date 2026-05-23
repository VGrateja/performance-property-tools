// =============================================================================
// ai-concierge — Hub AI chat proxy (Groq Llama 3.3 70B)
//
// The hub chat panel sends OpenAI-style chat-completion requests through this
// function so the Groq API key stays server-side. Browser code never sees it.
//
// Flow:
//   1. Client posts a Groq-compatible chat-completion body + its Supabase JWT.
//   2. Function validates the JWT by calling auth.getUser — only signed-in
//      staff get to proxy through.
//   3. Function strips/forces a fixed model (so a hostile client can't ask
//      for an off-allowlist model) and forwards to Groq.
//   4. Groq's response is passed through unchanged.
//
// Scope is intentionally minimal: this is a thin proxy, not a tool-execution
// layer. The 8 hub navigation actions (openHubPage, openTool, etc.) run
// CLIENT-SIDE — the model returns tool_calls, the browser executes them on
// the hub itself (navigation only, no writes). That keeps this function
// trivially auditable.
//
// Env vars (set via `supabase secrets set …`):
//   GROQ_API_KEY  Groq secret (required). Get one at console.groq.com.
//
// Auto-provided by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const GROQ_API_KEY      = Deno.env.get('GROQ_API_KEY')      ?? '';
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')      ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const GROQ_URL    = 'https://api.groq.com/openai/v1/chat/completions';
/* Hard-coded model whitelist. The spec defaults to Llama 3.3 70B; expanding
   this list later is a one-line change. Anything the client asks for that
   isn't in here gets quietly clamped to the default — no per-user model
   choice, so token spend stays predictable. */
const ALLOWED_MODELS = new Set([
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
]);
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResp(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')    return jsonResp({ error: 'method_not_allowed' }, 405);

  if (!GROQ_API_KEY) {
    /* Misconfiguration — secret never set. Don't try to reach Groq; surface
       the cause clearly so the admin can fix it. */
    return jsonResp({ error: 'server_misconfigured', detail: 'GROQ_API_KEY not set' }, 500);
  }

  /* Auth gate. We don't care WHICH staff user is calling, only that they're
     signed in (the hub already gates by tier; this is one more layer that
     stops random anon traffic from running up Groq tokens). RLS-style
     gating could be added later if specific tiers shouldn't have AI access,
     but the spec says every signed-in tier gets the concierge. */
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResp({ error: 'unauthorized', detail: 'missing bearer token' }, 401);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return jsonResp({ error: 'unauthorized', detail: 'invalid session' }, 401);
  }

  /* Body validation. We don't try to be too clever here — Groq's OpenAI-
     compatible schema is large; just sanity-check the bits we care about
     and pass the rest through. */
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return jsonResp({ error: 'invalid_json' }, 400); }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResp({ error: 'invalid_messages' }, 400);
  }

  /* Force model onto the whitelist. Silent clamp (not a 400) so the client
     UX doesn't break if it sent a model we don't permit yet. */
  const requestedModel = typeof body.model === 'string' ? body.model : DEFAULT_MODEL;
  const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : DEFAULT_MODEL;

  /* Forward to Groq. Pass `tools` / `tool_choice` / `temperature` /
     `max_tokens` through unchanged — the client controls them. We
     overwrite `model` (whitelist) and DROP `stream` since the client
     proxy is non-streaming for v1 (simpler error handling; streaming
     can be added later behind a query param). */
  const upstreamBody = {
    ...body,
    model,
    stream: false,
  };

  let upstream: Response;
  try {
    upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    return jsonResp({ error: 'upstream_unreachable', detail: String(e) }, 502);
  }

  /* Pass Groq's status + body through. Errors (rate-limit, bad request,
     etc.) reach the client unchanged so debugging is direct. */
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
