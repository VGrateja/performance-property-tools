// =============================================================================
// slides-read — authenticated proxy in front of the Google Slides reader
//
// WHY THIS EXISTS. The Slides reader is an Apps Script web app deployed
// "Execute as: Me / Who has access: Anyone", and its /exec URL used to be
// hard-coded in tools/presentation.html — a PUBLIC repo. Anyone who read the
// repo could fetch the full structural contents of any deck the deploying
// account could see, with no credentials at all (demonstrated 2026-08-07).
//
// A shared secret alone cannot fix that: the browser is one of the callers, so
// any secret it holds is published too. So the browser now calls THIS function
// instead, and only this function knows the endpoint and the secret:
//
//     browser (signed-in staff, JWT)  ─┐
//                                      ├─► slides-read ─► Apps Script (+secret)
//     scripts/gslides-watch.mjs  ──────┘   (server-side; it can hold the
//                                           secret itself and may call the
//                                           Apps Script directly)
//
// AUTH — WHY THE PLATFORM DEFAULT IS NOT ENOUGH. Supabase's verify_jwt accepts
// the ANON key as a valid JWT, and the anon key is published in
// shared/supabase-client.js (deliberately — RLS is the real gate). So platform
// verification alone would leave this function callable by anyone who read the
// repo, which is the exact hole we are closing. Measured 2026-08-07: anon key
// -> HTTP 200. Hence the explicit auth.getUser() check below: a real signed-in
// staff SESSION is required, not merely a well-formed key.
//
// Nothing here is dev/admin-gated on purpose — any signed-in staff member can
// already open these decks in the tool.
//
// Env vars (`supabase secrets set …`):
//   SLIDES_IMPORT_URL      the Apps Script /exec URL (required)
//   SLIDES_SHARED_SECRET   appended as ?k=… so the script can refuse the world
//                          (optional until the script enforces it)
// Auto-provided by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY.
//
// Request:  POST { id, mode?, thumb?, img?, inlineImages? }
//   id      deck id or any Slides URL — passed through; the script parses it
//   mode    'snapshot' for the cheap manifest, omitted for full structure
//   thumb   slide index -> that page as a PNG data URL
//   img     image index -> those bytes as a data URL
// Response: the Apps Script's JSON, verbatim.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const EXEC     = Deno.env.get('SLIDES_IMPORT_URL')    ?? '';
const SECRET   = Deno.env.get('SLIDES_SHARED_SECRET') ?? '';
const SB_URL   = Deno.env.get('SUPABASE_URL')         ?? '';
const SB_ANON  = Deno.env.get('SUPABASE_ANON_KEY')    ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'POST only' }, 405);
  if (!EXEC)                    return json({ error: 'SLIDES_IMPORT_URL is not configured' }, 500);

  /* Require a real signed-in USER, not just a valid key (see the AUTH note). */
  try {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Sign-in required' }, 401);
    const { data, error } = await createClient(SB_URL, SB_ANON).auth.getUser(token);
    if (error || !data?.user) return json({ error: 'Sign-in required' }, 401);
  } catch { return json({ error: 'Sign-in required' }, 401); }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body -> caught by the id check */ }

  const id = String(body.id ?? '').trim();
  if (!id) return json({ error: 'Missing deck id' }, 400);
  // Only ever forward the parameters the reader understands — never the raw body.
  const qs = new URLSearchParams({ id });
  if (body.mode)         qs.set('mode', String(body.mode));
  if (body.thumb !== undefined && body.thumb !== null) qs.set('thumb', String(body.thumb));
  if (body.img   !== undefined && body.img   !== null) qs.set('img',   String(body.img));
  if (body.inlineImages) qs.set('inlineImages', '1');
  if (SECRET) qs.set('k', SECRET);

  // The Apps Script 302s to googleusercontent; fetch follows it by default.
  // Generous timeout: a 55-slide structural read runs ~9s, a thumbnail longer.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 110_000);
  try {
    const res  = await fetch(EXEC + '?' + qs.toString(), { redirect: 'follow', signal: ctrl.signal });
    const text = await res.text();
    // Apps Script serves an HTML error page on a transient failure — pass that
    // back as a normal error object so callers can treat it as retryable
    // rather than trying to parse markup as JSON.
    try { return json(JSON.parse(text), 200); }
    catch { return json({ error: 'Reader returned a non-JSON response (HTTP ' + res.status + ') — transient, retry.' }, 502); }
  } catch (e) {
    const msg = (e as Error)?.name === 'AbortError' ? 'Reader timed out' : String((e as Error)?.message ?? e);
    return json({ error: msg }, 504);
  } finally {
    clearTimeout(timer);
  }
});
