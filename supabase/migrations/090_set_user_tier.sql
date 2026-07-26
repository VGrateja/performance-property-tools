-- ============================================================================
-- Migration 090 — set_user_tier(): default-role (tier) changes from the panel
--
-- Van's ask (2026-07-26): full control over the DEFAULT ROLE from the
-- Groups & Roles panel — promote/demote between dev / admin (Editor) /
-- company (Staff = Viewer), same as groups and per-tool roles.
--
-- Same idiom as set_user_team (081): SECURITY DEFINER, DEV-ONLY, granted to
-- authenticated (the function self-checks). Guards:
--   • only the three INTERNAL tiers are assignable (client/guest are the
--     dormant external tiers — managed separately if ever needed)
--   • LOCKOUT GUARD: the last remaining developer cannot be demoted
--     (the Groups/Roles panel + both RPCs are dev-only — demoting the last
--     dev would strand the whole rights system)
-- The 081 guard_profile_privileges trigger allows this path (caller is dev
-- ⇒ is_writer() true for the tier column).
-- ============================================================================

create or replace function public.set_user_tier(target_user uuid, new_tier text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  cur_tier text;
begin
  if public.current_tier() is distinct from 'dev' then
    raise exception 'set_user_tier: dev only';
  end if;
  if new_tier not in ('dev', 'admin', 'company') then
    raise exception 'set_user_tier: tier must be dev, admin or company';
  end if;
  select tier into cur_tier from public.profiles where id = target_user;
  if cur_tier is null then
    raise exception 'set_user_tier: unknown user';
  end if;
  if cur_tier in ('client', 'guest') then
    raise exception 'set_user_tier: externals are managed separately';
  end if;
  if cur_tier = 'dev' and new_tier <> 'dev'
     and (select count(*) from public.profiles where tier = 'dev') <= 1 then
    raise exception 'set_user_tier: cannot demote the last developer';
  end if;
  update public.profiles set tier = new_tier where id = target_user;
end;
$$;

revoke execute on function public.set_user_tier(uuid, text) from public, anon;
grant  execute on function public.set_user_tier(uuid, text) to authenticated;
