# Migration: Netlify + JSONBin → GitHub Pages + Supabase + Resend

This folder is a copy of the production `performance-property/` build, used as
the staging area for the stack migration. **Do not deploy this folder to the
existing Netlify site** — keep the live build untouched as a rollback safety net.

## Status

| Phase | What | Status |
|---|---|---|
| 1 | Confirm migration folder structure | ✅ done (this folder) |
| 2 | Stand up Supabase schema + RLS + client wrapper | 🟡 in progress |
| 3 | Migrate auth (Supabase Auth + Resend SMTP) | ⏸ blocked on Resend |
| 4 | Replace tool data calls (clock / reports / presentation / documents) | ⏸ blocked on phase 3 |
| 5 | Cutover to GitHub Pages | ⏸ blocked on phase 4 |

## Files added by the migration so far

```
supabase/
  migrations/
    001_init.sql        — full schema + RLS policies + triggers
shared/
  supabase-client.js    — browser-side supabase-js wrapper, exposes window.sb
MIGRATION.md            — you are here
```

Nothing else has changed yet. The existing `index.html`, `tools/*`, and
`netlify/functions/*` still work as-is in this folder — they just aren't
deployed anywhere.

---

## How to apply the schema migration

**One-off, ~2 minutes.** Do this once after the SQL file is written.

1. Go to <https://supabase.com/dashboard/project/cannojsxduvlewimwoxa/sql/new>
   (or: dashboard → your project → SQL Editor → "New query")
2. Open `supabase/migrations/001_init.sql` from this folder.
3. Copy the **entire** file contents.
4. Paste into the SQL Editor.
5. Click **Run** (or hit `Ctrl+Enter`).

Expected output: "Success. No rows returned."

If you see an error, paste it here and I'll diagnose. The script is
idempotent — re-running it after a partial failure is safe.

### Verify the schema landed

Still in SQL Editor, run:

```sql
select table_name from information_schema.tables
where table_schema = 'public'
order by table_name;
```

You should see five tables:
- `clock_state`
- `documents_state`
- `presentation_state`
- `profiles`
- `reports_state`

And to confirm RLS is on:

```sql
select tablename, rowsecurity from pg_tables
where schemaname = 'public';
```

`rowsecurity` should be `true` for all five.

---

## Sign Vandolf up as Tier 0 (one-time)

After the schema is applied, you'll need to register an admin account so the
upcoming auth-migration phase has someone to test with. This step has to wait
until Phase 3 (Supabase Auth replaces the EmailJS OTP flow), but the
preparatory SQL upgrade is documented here for reference.

After Vandolf's first signup via the new login UI (Phase 3), run this once
in the SQL Editor to upgrade his tier from `admin` to `dev`:

```sql
update public.profiles
   set tier = 'dev'
 where email = 'vandolf@performanceproperty.com.au';
```

The trigger on `auth.users` defaults `@performanceproperty.com.au` emails
to `tier='admin' / status='active'`, so admins don't need approval. Only
the dev tier requires this manual upgrade.

---

## Roll back

If anything in Supabase goes wrong, drop everything:

```sql
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user      cascade;
drop function if exists public.current_tier         cascade;
drop function if exists public.is_writer            cascade;
drop function if exists public.touch_updated_at     cascade;
drop function if exists public.touch_profile_updated_at cascade;
drop table    if exists public.reports_state        cascade;
drop table    if exists public.documents_state      cascade;
drop table    if exists public.presentation_state   cascade;
drop table    if exists public.clock_state          cascade;
drop table    if exists public.profiles             cascade;
```

The live Netlify site keeps working throughout — Supabase is parallel
infrastructure until cutover.
