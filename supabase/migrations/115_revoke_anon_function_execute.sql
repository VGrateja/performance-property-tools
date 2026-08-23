-- 115_revoke_anon_function_execute.sql
--
-- Closes the security advisor's 32 "Public Can Execute SECURITY DEFINER
-- Function" warnings (parked at the 2026-08-21 sweep, cleared by Van
-- 2026-08-23): every SECURITY DEFINER function in public was executable by
-- the ANON role via /rest/v1/rpc/*, because Postgres grants EXECUTE to
-- PUBLIC on creation and anon inherits it.
--
-- Nothing legitimate calls any RPC before sign-in — every tool page sits
-- behind auth-gate.js, registration is off, and the login screen itself
-- makes no RPC calls (verified across the codebase before this migration).
-- The functions are Arena game RPCs, scorecard helpers and utility
-- predicates; all of their callers are authenticated. Edge Functions and
-- the Actions renderers use the service role.
--
-- Catalog-driven on purpose: it revokes from PUBLIC and anon, then grants
-- authenticated + service_role explicitly, for every SECURITY DEFINER
-- function in public that anon could execute — so it needs no per-function
-- maintenance. NOTE for future functions: a new SECURITY DEFINER function
-- gets PUBLIC execute again by default; the advisor will re-flag it, and
-- its migration should carry its own revoke lines.

do $$
declare
  f record;
  n int := 0;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.prosecdef
      and has_function_privilege('anon', p.oid, 'execute')
  loop
    execute format('revoke execute on function %s from public', f.sig);
    execute format('revoke execute on function %s from anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    n := n + 1;
  end loop;
  raise notice 'anon EXECUTE revoked on % security definer function(s)', n;
end $$;
