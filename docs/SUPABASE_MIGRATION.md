# Migrating user storage from JSONBin to Supabase

This is the playbook for moving Tier-3 / Tier-4 user accounts off JSONBin
and onto Supabase. Trigger this migration when:

- The userbase grows past a few hundred (whole-array reads start to
  feel slow), OR
- You want real authentication primitives — Supabase-managed bcrypt,
  rate limiting, magic-link / social login, RLS, audit logs, OR
- A stakeholder asks "where do you store passwords?" and the answer
  needs to be more impressive than "in a JSON file behind a master
  key."

The current architecture was designed to make this swap easy. Most of
the surface area is already isolated.

## What stays the same

- All client code in `shared/auth.js` — the helpers
  `registerOnServer`, `verifyPasswordOnServer`, `approveUserOnServer`,
  `rejectUserOnServer`, and `fetchUsersFromServer` keep their shapes.
  They only call `/.netlify/functions/users`. They don't know JSONBin
  exists.
- `shared/auth.js` constants `USERS_STATE_URL` (still
  `/.netlify/functions/users`) and `USERS_ADMIN_TOKEN` (you may still
  use one, see notes below).
- The hub admin UI (`index.html` pending-approvals modal). Reads from
  the cache, calls the same client helpers — no change.
- The user record schema:
  ```
  {
    id:         <uuid>,
    email:      <lowercased>,
    firstName:  <string>,
    role:       'client' | 'guest',
    status:     'active' | 'pending',
    createdAt:  <iso8601>,
    updatedAt:  <iso8601>
  }
  ```
  These map 1:1 onto a Supabase `users` table. The `password` field
  lives in Supabase Auth's `auth.users` table separately, not in
  your custom `public.users` table.

## What changes

| Layer | JSONBin (now) | Supabase (after) |
|---|---|---|
| Storage | One JSONBin holding `{ users: [...] }` | Postgres `public.users` table + Supabase `auth.users` |
| Hashing | `bcryptjs` inside `users.js` | Supabase Auth (built-in bcrypt) |
| Function backend | `users.js` reads/writes JSONBin via master key | `users.js` reads/writes Supabase via service-role key |
| Auth | Custom OTP via EmailJS | **Optional:** keep custom OTP, OR switch to Supabase Auth (magic link / OTP / password). See "Auth strategy" below. |
| Admin protection | Bearer `USERS_ADMIN_SECRET` | Same Bearer pattern, OR Supabase RLS policy + service-role key |
| Audit log | None | Supabase logs every query |

## Step-by-step migration

### 1. Set up Supabase

- Create a free Supabase project at supabase.com.
- In the Supabase SQL editor, run:

  ```sql
  create table public.users (
    id           uuid primary key default gen_random_uuid(),
    email        text not null unique,
    first_name   text not null,
    role         text not null check (role in ('client', 'guest')),
    status       text not null check (status in ('active', 'pending')),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
  );

  create index users_email_idx on public.users (lower(email));
  create index users_status_idx on public.users (status) where status = 'pending';
  ```

  This is the metadata table. Passwords live in `auth.users`, managed
  by Supabase Auth.

- Note your project URL and **service-role** key (Settings → API).
  The service-role key is the equivalent of `JSONBIN_MASTER_KEY` —
  never let it reach the browser.

### 2. Export current users from JSONBin

```bash
# From the project root
curl https://api.jsonbin.io/v3/b/$JSONBIN_USERS_BIN_ID/latest \
  -H "X-Master-Key: $JSONBIN_MASTER_KEY" \
  > users-export.json
```

The export is a JSON object like `{ record: { users: [...] } }`. The
`users` array is what you import.

### 3. Import users into Supabase

Two choices:

#### Option A — Import metadata only, force password resets

Use this if the existing users are mostly test accounts (true today
2026-04-29). It's the simplest path.

```sql
-- Run in Supabase SQL editor. Adjust the JSON path to wherever you
-- pasted the exported users array.
insert into public.users (id, email, first_name, role, status, created_at, updated_at)
select
  (u->>'id')::uuid,
  lower(u->>'email'),
  u->>'firstName',
  u->>'role',
  u->>'status',
  (u->>'createdAt')::timestamptz,
  (u->>'updatedAt')::timestamptz
from jsonb_array_elements('<paste users array here>'::jsonb) as u;
```

Then send every user a "Welcome to the new auth system, please reset
your password" email via Supabase Auth's password reset endpoint.

#### Option B — Import metadata AND password hashes (no resets)

This works because both systems use bcrypt now. Use Supabase's
`auth.admin.createUser()` REST endpoint with `password_hash` set to
the bcrypt string from JSONBin. Same script structure as Option A,
but for each row also call:

```js
await supabase.auth.admin.createUser({
  email: user.email,
  password_hash: user.password,   // existing bcrypt
  email_confirm: true,
  user_metadata: { first_name: user.firstName }
});
```

Run this script once. Existing bcrypt hashes verify natively in
Supabase Auth — no resets needed.

### 4. Replace `netlify/functions/users.js`

Same surface area, different backend. Pseudocode for the verify
endpoint:

```js
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// verify-password
const { data, error } = await sb.auth.signInWithPassword({ email, password });
if (error) return reply(401, { error: 'Invalid email or password' });

const { data: profile } = await sb
  .from('users')
  .select('id, email, first_name, role, status')
  .eq('email', email).single();

if (profile.status === 'pending') {
  return reply(403, { error: 'pending', user: profile });
}
return reply(200, { ok: true, user: profile });
```

Mirror that structure for `register`, `approve`, `reject`, and `GET`.
Each becomes a thin call into Supabase, with the same response shape
the client already expects.

### 5. Swap env vars

In Netlify env:

- **Add:**
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
- **Remove (or keep around for rollback):**
  - `JSONBIN_USERS_BIN_ID`
  - `USERS_ADMIN_SECRET` (or leave it — see auth strategy)

`JSONBIN_MASTER_KEY` stays — Property Clock and Online Reports still
use JSONBin for their per-region state.

### 6. Optional — replace custom OTP with Supabase Auth

If you also want to retire EmailJS + the custom OTP flow:

1. In Supabase Auth settings, enable "Email OTP" or "Magic Link".
2. Replace `sendOTP` and `verifyOTP` in `auth.js` with Supabase's
   `signInWithOtp` and `verifyOtp` calls.
3. Remove the EmailJS service config (`EMAILJS_SERVICE`,
   `EMAILJS_TEMPLATE`, `EMAILJS_KEY`, `EMAILJS_APPROVAL_TEMPLATE`).

This is a separate refactor and not strictly required — you can keep
EmailJS OTP and only swap the storage layer. Doing both at once is
half a day of work; doing storage-only is ~2 hours.

## Rollback plan

If anything goes sideways during the cutover:

1. Keep the old JSONBin bin and master key around until Supabase has
   been live + healthy for at least a week.
2. The previous `users.js` is in git history (look for the bcrypt-on-
   JSONBin commit dated 2026-04-29). Revert the function and the
   relevant env vars and the system is back on JSONBin.
3. Any registrations made against Supabase during the cutover would
   need to be re-imported into JSONBin — straightforward but manual.

## What you don't have to touch

- `shared/auth.js` — every helper already calls
  `/.netlify/functions/users`. Zero changes.
- `index.html` admin UI — calls the same helpers.
- `clock-state.js`, `reports-state.js`, the 35 region bins — all
  unrelated. Stay on JSONBin.
- `setup-users-bin.mjs` — orphan it. The Supabase setup is via the
  SQL migration above.

## Auth strategy (a note)

`USERS_ADMIN_TOKEN` in `auth.js` is the Bearer secret that proves
"this approve/reject call is from an admin" to the Netlify function.
Visible-in-source — relies on the hub's tier gating to keep the UI
admin-only.

In a Supabase world you have two options:

1. **Keep it.** Same shared-secret pattern; the function just checks
   the bearer like before. Fine for an internal tool.
2. **Replace it with proper Supabase RLS.** Admin actions require a
   Supabase-issued JWT for an admin user. The browser obtains the JWT
   via Supabase Auth at login time and sends it as a Bearer to your
   function. Function verifies the JWT signature and reads the
   `role` claim. This is the "real auth" answer — required if you're
   ever audited.

Pick #2 if external clients are using this. Pick #1 if it stays
internal. The current architecture works for both.
