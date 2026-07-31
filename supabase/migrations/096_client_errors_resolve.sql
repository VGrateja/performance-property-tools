-- 096_client_errors_resolve.sql
--
-- Let the dev-only errors card MARK AN ERROR FIXED so it stops showing.
--
-- Why: client_errors (mig 031) is append-only, so a bug stays in the card
-- until its rows age out of the selected range — even after the fix ships.
-- That is exactly the "a fixed issue left sitting here resurfaces months
-- later" trap that killed docs/BUG.md. Without this, every fix leaves the
-- card lying about what is broken.
--
-- Resolution is per (tool, message) FAMILY, not per row: one bug produces
-- many identical rows, and a human fixes the bug, not the occurrence. Rows
-- that arrive AFTER a fix are unresolved again by construction (the RPC only
-- stamps rows that exist when it runs) — so if the bug comes back, the card
-- lights up again, which is the behaviour we want.

alter table public.client_errors
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by uuid references auth.users(id);

-- the card's hot path: unresolved, newest first
create index if not exists client_errors_unresolved_idx
  on public.client_errors (created_at desc)
  where resolved_at is null;

-- Dev-only, SECURITY DEFINER so no UPDATE policy is needed on the table
-- (its RLS stays: users insert own, writers read).
create or replace function public.pp_resolve_errors(p_tool text, p_message text)
returns integer
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  if public.current_tier() <> 'dev' then
    raise exception 'not authorized';
  end if;

  update public.client_errors
     set resolved_at = now(), resolved_by = auth.uid()
   where resolved_at is null
     and coalesce(tool, '') = coalesce(p_tool, '')
     and message = p_message;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.pp_resolve_errors(text,text) from public, anon;
grant execute on function public.pp_resolve_errors(text,text) to authenticated;

-- Undo, in case something is marked fixed by mistake.
create or replace function public.pp_unresolve_errors(p_tool text, p_message text)
returns integer
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  if public.current_tier() <> 'dev' then
    raise exception 'not authorized';
  end if;

  update public.client_errors
     set resolved_at = null, resolved_by = null
   where resolved_at is not null
     and coalesce(tool, '') = coalesce(p_tool, '')
     and message = p_message;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.pp_unresolve_errors(text,text) from public, anon;
grant execute on function public.pp_unresolve_errors(text,text) to authenticated;
