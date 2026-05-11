# Bug — New-user sign-in freeze

**Status (2026-05-11, second session):** root cause is identity-bound to the org-owner email. **All known client-side fixes have been tried and failed.** Codebase reverted to clean baseline. Waiting on Supabase support, or moving to a server-side auth proxy / different auth provider.
**Severity:** medium — existing staff with cached sessions sign in fine; only fresh-browser / new-staff onboarding is blocked.
**Affects:** every user signing in on a browser that has no existing Supabase session in `localStorage`, **except** the Supabase org owner's email, regardless of tier (admin / company / client) or how the auth user was created (Supabase dashboard "Add user" or OTP-register flow). The org-owner email signs in cleanly from any browser, any project, any network.

---

## Symptom

1. User opens the live site in a browser that has never signed in (or whose data has been cleared).
2. Enters email + password (or email + OTP).
3. Clicks "Sign In".
4. Button shows the spinning "SIGNING IN…" state.
5. **Either** the button stays spinning forever (auth handshake hung), **or** the welcome overlay appears, fades, and the page goes blank.
6. Tab is then either fully frozen (CPU pegged, browser shows "site is not responding") or visibly blank but technically responsive depending on which code path hung.
7. Closing and reopening the tab does not help — the bad state persists via the session token in `localStorage`, so the next page load auto-rehydrates and re-triggers the same hang.

Only Vandolf can sign in cleanly on a fresh browser. Every other account — `test@`, `researchsupport@`, `d.robbins@`, an OTP-registered colleague — freezes the same way.

---

## What we ruled out

After ~8 hours of debugging across multiple sessions:

- **Our app code.** Every step in the post-login bootstrap was wrapped in instrumentation that wrote progress markers to `localStorage`. Trace endpoints proved the hang was in `_hydrateFromSession` (the profile fetch), not in anything we added (welcome overlay, hub bootstrap, MutationObserver, applyAccessRestrictions, tryUpdate).
- **The welcome overlay.** Skipped entirely for non-admin users — freeze moved to the profile fetch instead.
- **SQL schema additions.** Ran `008_diagnostic_drop_arena.sql` to drop every chess and typing table, view, function, RLS policy, and realtime publication entry. Freeze still reproduced. Migrations 003–007 then re-run to restore.
- **RLS recursion / database hang.** The same `select * from profiles where id = …` query in the Supabase SQL editor with `set role authenticated; set local request.jwt.claims = …;` returns the row instantly. PostgREST + RLS are not at fault.
- **Network / ISP.** Reproduced on a mobile hotspot.
- **Service workers.** Application → Service Workers in DevTools was empty in every test.
- **Browser cache.** Tested with site data fully cleared and in fresh-install browsers.
- **supabase-js's `Promise.race` interaction.** Stripped the timeout wrapper, plain `await builder` still hung.
- **Chrome's `fetch()` body reader.** Replaced with raw `fetch()` → still hung at `res.text()`. Replaced with `XMLHttpRequest` → no `onload` / `onerror` / `ontimeout` ever fired.
- **`localStorage` hydration bypass.** Replaced the supabase-js call with a direct `localStorage.getItem('pp-sb-auth')` read. `signInWithPassword` itself started hanging at that point — even the auth handshake won't return.
- **Publishable key (`sb_publishable_…`) vs legacy anon JWT.** Swapped to the legacy `eyJ…` anon JWT. Same hang.
- **Tier value of the affected user.** Set Shaene's `profiles.tier` from `'admin'` to `'dev'` (matching Vandolf's tier) in the SQL editor and had her retest from a cleared browser. Same hang. Tier is not the differentiator.
- **Resend / SMTP hooks.** No auth hooks point at Resend; no custom SMTP is configured. Resend is not in the auth flow at all for password sign-in. Ruled out.
- **Project state corruption.** Created a brand-new Supabase project (`sjopptjqciyjtqqfnsun`, Tokyo region same as production), ran migrations 001–007, pointed a sandbox folder copy at it, and signed in there. Result: **same identity-bound behaviour on the fresh project** — `vandolf@performanceproperty.com.au` signs in cleanly, every other auth.users email hangs. Confirms the bug is not specific to our production project's state.
- **Org membership.** Invited Shaene as a member of `VGrateja's Org` (Read-only role). She accepted, signed into Supabase, and is visible on the Team page. From a fresh browser, she still freezes. So the trust granted to the org owner's email is **not extended to ordinary org members** — the differentiator is narrower (project ownership or some other per-account flag).
- **supabase-js Web Locks deadlock fix** (GitHub issue #2111 / PR #2106). Passed a `noOpLock` to `createClient({ auth: { lock: ... } })` to disable the `navigator.locks` coordination entirely. Same hang.
- **async `onAuthStateChange` callback anti-pattern** (GitHub auth-js issue #762 / Supabase docs warning). Refactored the callback to be synchronous and dispatched the `PASSWORD_RECOVERY` Supabase work via `setTimeout(..., 0)`. Same hang.
- **`autoRefreshToken: false`.** The sandbox investigation found that clearing `pp-sb-auth` from `localStorage` *before* supabase-js init was what fixed the cold-load freeze — implying the auto-refresh / auto-rehydrate path is one of the hang surfaces. Disabling auto-refresh in `createClient` did not help fresh sign-ins: `signInWithPassword` itself still hangs.
- **JWT-derived profile (skip the profile fetch entirely).** Replaced `_hydrateFromSession`'s SELECT on `public.profiles` with a client-side synthesis from the JWT's `user.email`. Same hang — the hang shifted from the profile fetch to either `signInWithPassword` or the welcome-overlay `setTimeout`.
- **Welcome-overlay bypass.** Called `showMain()` directly from `_completeLogin` instead of `showWelcomeAndProceed(name)`. Same hang (`signInWithPassword` hangs upstream).
- **Pin `supabase-js` to an older version.** Replaced `@supabase/supabase-js@2` (latest from CDN) with `@2.45.6` across all 14 files. Same hang.

---

## What the evidence points to

Network tab consistently shows:
- `GET /rest/v1/profiles?…` returns **200, ~200 ms, ~1 KB** with `content-type: application/json; charset=utf-8` and **no `content-length`** (chunked transfer encoding).
- Yet **every JavaScript retrieval path** (supabase-js's `PostgrestBuilder.then`, `fetch().then(r=>r.text())`, `XMLHttpRequest.onload`) silently fails to fire its resolver callback.
- Setting `xhr.timeout = 10000` also never fires `ontimeout`.

The combined signal is that something in the browser's response-handling layer is consuming the response but never marking it complete to the JS engine. The most plausible culprits, ordered:

1. **Cloudflare / Supabase edge** returning chunked responses without a terminating chunk under specific conditions (account state, key format, region).
2. **Supabase project state** — auth pool / Realtime publication / row-level config in a half-applied state from migration 006's `alter publication supabase_realtime` (it threw an advisor warning that we ran past).
3. **supabase-js v2 from CDN** having a regression that interacts with one of the above.

The data point that most strongly biases toward "Supabase project" over "Chrome bug": **the project's same key + same Chrome works fine for Vandolf** because his localStorage already has a session token. The hang only manifests on the bootstrap that has to fetch fresh state.

**Reinforcing data (2026-05-11):** Vandolf reproducibly signs in on completely-fresh browsers as well — Edge InPrivate, a second-computer Chrome Incognito — both work. Other accounts on the same fresh-browser conditions all freeze. So the differentiator is **identity-bound**, not browser-bound or session-cache-bound. The bug fires on a per-user basis.

**Sandbox-project confirmation (2026-05-11):** Created a brand-new Supabase project (`sjopptjqciyjtqqfnsun`) and reproduced the bug there:
- Brand-new auth.users row for `vandolf@performanceproperty.com.au` on the sandbox → **signs in cleanly**.
- Brand-new `vandolf+test@performanceproperty.com.au` (alias of the same address — local-part still contains "vandolf") on the sandbox → **freezes**.
- Brand-new `zzzfakemail@example.com` on the sandbox → **freezes**.

The literal email `vandolf@performanceproperty.com.au` works on a project where that auth.users row was just created seconds earlier. No tier upgrade, no profile manual edit, no creation history — just the email string itself.

**The thing that's special about that specific email:** it is the email registered as the **Supabase organization owner** for `VGrateja's Org`. Vandolf uses that same email to sign into the Supabase Dashboard itself. So the only structural difference between the email that works and every email that fails is "is this email a Supabase org member for the org that owns the project?".

This points strongly at Supabase/Cloudflare treating org-member emails as **trusted at the auth edge**: their requests pass cleanly, while every non-member email's response is gated by some bot-detection or rate-limit layer whose response stream never terminates from the JS engine's perspective.

**Workaround tested and rejected (2026-05-11):** Shaene was invited as a Read-only org member, accepted, became visible on the Team page, and retested from a fresh browser. **Same hang.** So the auth trust isn't granted to ordinary org members — likely only the org *owner*, or only the original project creator, or some Supabase-internal flag distinct from membership.

**Second debug session, same day, after researching GitHub issues:** found and applied every documented anti-pattern fix Supabase warns about — no-op lock to bypass the Web Locks deadlock, sync `onAuthStateChange` to avoid the deadlock-by-async-callback issue, disabled `autoRefreshToken`, JWT-derived profile to bypass the profile fetch, welcome bypass, supabase-js pinned to `@2.45.6`. **None of them changed the outcome.** The hang point shifts between runs (`signInWithPassword` itself, the profile fetch, the welcome overlay's inner setTimeout) but the bug is unfixable from app code on this stack for non-org-owner accounts.

---

## Chronological log of what we tried

| Commit    | What |
|-----------|------|
| `f7b31e5` | Defensive `try / catch` around hub bootstrap so a thrown error wouldn't blank the page silently. Migration `007_arena_chess_points_security_invoker.sql` to clear a Supabase advisor warning. |
| `754647a` | Promoted `test@` to `ADMIN_EMAILS` as a workaround — same hang, ruled out tier dependency. |
| `e628b48` | Disabled the first-time hub tour temporarily — bug persisted, tour innocent. |
| `a28332a` | Added `localStorage` progress markers across login → showMain → tryUpdate. |
| `d14b8d8` | Bypassed welcome overlay for non-admin users — freeze moved to `_hydrateFromSession`, not gone. |
| `36d9225` | Skipped welcome overlay for everyone, re-added markers (cleaner trace). |
| `dcb8c6f` | Wrapped `_hydrateFromSession` awaits in `Promise.race` with 10 s timeout — timeout never fired either. |
| `0f37d4c` | Removed the `Promise.race` (suspected interaction with `PostgrestBuilder` thenable) — same hang. |
| `376c3ef` | Bypassed supabase-js for the profile call with a raw `fetch()` to `/rest/v1/profiles` — `res.text()` never resolved. |
| `15b38b3` | Split `res.text()` from JSON parse, added content-type / content-length markers, set `cache: 'no-store'` — chunked response, no content-length. |
| `ad5d158` | Replaced raw fetch with `XMLHttpRequest` (different engine) — `onload` / `onerror` / `ontimeout` all never fired. |
| `7430fbd` | Skipped HTTP entirely, derived profile from JWT claims — `signInWithPassword` then started hanging, never reached our derive code. |
| `750f65d` | Read session straight from `localStorage`, skip `getSession()` too — `signInWithPassword` still hung. |
| `0a56ba8` | Switched from publishable key (`sb_publishable_…`) to legacy anon JWT — same hang. |
| `5ae2adb` | **Reverted every debug change** — auth.js, supabase-client.js, index.html all back to the pre-bug-hunt state. Kept the legacy anon JWT in supabase-client.js (no harm). |
| `8b13baf` | Kept `test@` in `DEV_EMAILS` so password sign-in is available for the next investigation. |
| `33bf2e3` | Added `supabase/migrations/008_diagnostic_drop_arena.sql` — dropping every arena table didn't change the freeze either. Restored via 003–007 re-run. |

---

## What changed in the codebase that survived this debug cycle

- Migration `007_arena_chess_points_security_invoker.sql` — flips the chess points view to `security_invoker` to clear the advisor warning. Genuine fix, kept.
- `shared/supabase-client.js` — using the **legacy anon JWT key** instead of the publishable key. Harmless either way; pick whichever is correct policy.
- `test@performanceproperty.com.au` remains in `DEV_EMAILS` so the password field reveals on the login screen for ongoing testing.
- `supabase/migrations/008_diagnostic_drop_arena.sql` lives in the repo as a future diagnostic option. Already run + reverted — no schema effect today.

Everything else (welcome overlay, progress markers, raw-fetch bypass, XHR fallback, JWT-derive workaround, localStorage hydration) was reverted to a clean state in `5ae2adb`.

---

## Next steps

The investigation is exhausted from the app-code side. Real options remaining:

1. **Wait for Supabase support to respond** to the ticket already filed.
2. **Server-side auth proxy** — stand up a serverless function (Cloudflare Workers / Netlify Functions / Vercel Edge) that proxies `/auth/v1/token` and `/rest/v1/profiles` calls. The proxy buffers the full Supabase response server-side before forwarding to the browser, eliminating the chunked-transfer / stream-hang path entirely. Likely 1–2 days of work; durable fix.
3. **Migrate auth provider** — move to Clerk / Auth0 / WorkOS. Keeps Supabase for the database, replaces just the auth surface. ~1–2 weeks of work.
4. **Accept the bug and use session-sharing for onboarding** — for new staff, share Vandolf's session (export `pp-sb-auth` from his localStorage, paste into the new user's browser). Not a real solution; only buys time.

All client-side avenues attempted in two debug sessions (~12 hours combined) have failed.

---

## Workarounds for new staff in the meantime

Read-only org membership has been ruled out. Pending support reply, the working unblocks are still:

1. Have them sign up via OTP on a colleague's already-working browser (cached session masks the bug).
2. Or share Vandolf's session by exporting `pp-sb-auth` from localStorage and pasting it into the new user's browser (not a real solution, just unblocks urgent access).
3. Or do all their work in a tab that's already been signed in — never log out.
4. **Untested:** if promoting the user to org **Administrator** or **Owner** lets them sign in, that's a stop-gap for staff we'd trust with that role.
