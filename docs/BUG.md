# Bug — New-user sign-in freeze

**Status:** parked, 2026-05-11. Not fixed.
**Severity:** medium — existing staff with cached sessions sign in fine; only fresh-browser / new-staff onboarding is blocked.
**Affects:** every user signing in on a browser that has no existing Supabase session in `localStorage`, regardless of tier (admin / company / client) or how the auth user was created (Supabase dashboard "Add user" or OTP-register flow).

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

## Next steps when picking this up

1. **Open a Supabase support ticket** with this document. They can see project-side data we can't — edge routing, auth pool state, publication health, log of 200-responses-with-stuck-bodies.
2. **Spin up a fresh Supabase project** as a control. Re-run migrations 001–007 there, create a test user, sign in on a fresh browser. If that works, the issue is project-specific and Supabase support can repair or migrate.
3. **Performance recording** in DevTools (Performance tab → record → click sign in → stop after the freeze). Shows main-thread activity during the hang; might surface a long task we can't see in trace markers.
4. **Last-resort workarounds** if support can't fix it:
   - Server-side proxy in front of PostgREST that re-emits responses with explicit `content-length` (eliminates chunked transfer encoding).
   - Self-hosted Supabase / migration to a different stack for the auth layer.
   - Cookie-based session instead of localStorage so the bootstrap doesn't need to fetch the profile.

---

## Workarounds for new staff in the meantime

If someone needs to onboard before this is fixed:

1. Have them sign up via OTP on a colleague's already-working browser (cached session masks the bug).
2. Or share Vandolf's session by exporting `pp-sb-auth` from localStorage and pasting it into the new user's browser (not a real solution, just unblocks urgent access).
3. Or do all their work in a tab that's already been signed in — never log out.
