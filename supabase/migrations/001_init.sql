-- ============================================================================
-- Performance Property — initial Supabase schema
-- Migration target: Supabase Postgres (project cannojsxduvlewimwoxa)
--
-- Replaces the JSONBin-backed bins used by the Netlify build:
--   ppa-users          → public.profiles
--   ppa-clock          → public.clock_state
--   ppa-presentation   → public.presentation_state
--   ppa-documents      → public.documents_state
--   reports (35 bins)  → public.reports_state (one row per region)
--
-- How to apply:
--   1. Open Supabase dashboard → your project → SQL Editor.
--   2. Paste this entire file into a new query.
--   3. Click "Run".
--   4. Verify in Table Editor that the tables exist and RLS is enabled.
--
-- Idempotent: re-running this file is safe. Tables/policies/triggers use
-- IF NOT EXISTS / OR REPLACE / DROP-IF-EXISTS-then-CREATE so the script
-- can be applied repeatedly without errors.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- profiles: every Supabase Auth user has a row here. Tier + status drive
-- access control via RLS. id mirrors auth.users(id) so policies can use
-- auth.uid() directly.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid        primary key references auth.users(id) on delete cascade,
  email       text        unique not null,
  full_name   text,
  tier        text        not null default 'client'
              check (tier in ('dev','admin','company','client','guest')),
  status      text        not null default 'active'
              check (status in ('pending','active','rejected')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists profiles_tier_idx   on public.profiles (tier);
create index if not exists profiles_status_idx on public.profiles (status);


-- ---------------------------------------------------------------------------
-- Auto-create a profile when a new auth.users row appears (on signup).
-- Email pattern decides default tier:
--   *@performanceproperty.com.au → 'admin' / active
--   anything else                → 'client' / pending  (admin must approve)
--
-- Vandolf manually upgrades his own row to tier='dev' once via SQL Editor:
--   update public.profiles set tier='dev' where email='vandolf@performanceproperty.com.au';
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger as $$
declare
  is_pp_email boolean := new.email ilike '%@performanceproperty.com.au';
begin
  insert into public.profiles (id, email, tier, status)
  values (
    new.id,
    new.email,
    case when is_pp_email then 'admin' else 'client' end,
    case when is_pp_email then 'active' else 'pending' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------------
-- Tier helpers used by RLS policies. SECURITY DEFINER lets policies call
-- them without extra grants. STABLE means Postgres caches results inside a
-- single statement.
-- ---------------------------------------------------------------------------
create or replace function public.current_tier() returns text as $$
  select tier from public.profiles where id = auth.uid();
$$ language sql stable security definer;

create or replace function public.is_writer() returns boolean as $$
  select coalesce(public.current_tier() in ('dev','admin'), false);
$$ language sql stable security definer;


-- ---------------------------------------------------------------------------
-- App state tables — single-row JSONB pattern per tool. Mirrors the
-- one-bin-per-tool architecture; we can normalise into proper schemas
-- later once the migration is stable.
-- ---------------------------------------------------------------------------
create table if not exists public.clock_state (
  id          int          primary key default 1 check (id = 1),
  payload     jsonb        not null default '{}'::jsonb,
  updated_at  timestamptz  not null default now(),
  updated_by  uuid         references public.profiles(id)
);

create table if not exists public.presentation_state (
  id          int          primary key default 1 check (id = 1),
  payload     jsonb        not null default '{"customDecks":[],"overlays":{},"slideBgs":{}}'::jsonb,
  updated_at  timestamptz  not null default now(),
  updated_by  uuid         references public.profiles(id)
);

create table if not exists public.documents_state (
  id          int          primary key default 1 check (id = 1),
  payload     jsonb        not null default '{"sections":[]}'::jsonb,
  updated_at  timestamptz  not null default now(),
  updated_by  uuid         references public.profiles(id)
);

-- Reports has one row per region (Sydney, Melbourne, etc.).
create table if not exists public.reports_state (
  region      text         primary key,
  payload     jsonb        not null default '{}'::jsonb,
  updated_at  timestamptz  not null default now(),
  updated_by  uuid         references public.profiles(id)
);


-- ---------------------------------------------------------------------------
-- updated_at auto-touch + remember who wrote (set updated_by = auth.uid()).
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_clock_updated_at         on public.clock_state;
drop trigger if exists trg_presentation_updated_at  on public.presentation_state;
drop trigger if exists trg_documents_updated_at     on public.documents_state;
drop trigger if exists trg_reports_updated_at       on public.reports_state;

create trigger trg_clock_updated_at         before update on public.clock_state         for each row execute function public.touch_updated_at();
create trigger trg_presentation_updated_at  before update on public.presentation_state  for each row execute function public.touch_updated_at();
create trigger trg_documents_updated_at     before update on public.documents_state     for each row execute function public.touch_updated_at();
create trigger trg_reports_updated_at       before update on public.reports_state       for each row execute function public.touch_updated_at();

-- profiles touches its own updated_at without setting updated_by (no FK).
create or replace function public.touch_profile_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at before update on public.profiles for each row execute function public.touch_profile_updated_at();


-- ---------------------------------------------------------------------------
-- Row-Level Security
--
-- Reads:  any authenticated user can read every state table. UI gates what
--         each tier sees; the DB doesn't fragment data by tier (Tier 4
--         guests are still allowed to read clock/reports etc., they just
--         see Lite UIs in the browser).
-- Writes: only dev/admin (Tier 0/1) can write. Tier 2-4 are blocked at
--         the DB layer regardless of UI bugs or page-source token leaks.
-- ---------------------------------------------------------------------------

alter table public.profiles            enable row level security;
alter table public.clock_state         enable row level security;
alter table public.presentation_state  enable row level security;
alter table public.documents_state     enable row level security;
alter table public.reports_state       enable row level security;

-- Drop existing policies if rerunning, then recreate.
drop policy if exists "users read own profile"      on public.profiles;
drop policy if exists "writers read all profiles"   on public.profiles;
drop policy if exists "users update own profile"    on public.profiles;
drop policy if exists "writers update any profile"  on public.profiles;

create policy "users read own profile"      on public.profiles  for select to authenticated using (id = auth.uid());
create policy "writers read all profiles"   on public.profiles  for select to authenticated using (public.is_writer());
create policy "users update own profile"    on public.profiles  for update to authenticated using (id = auth.uid());
create policy "writers update any profile"  on public.profiles  for update to authenticated using (public.is_writer());

-- Generic helper to (re)create read+write policies on a state table.
do $$
declare
  t text;
begin
  for t in select unnest(array['clock_state','presentation_state','documents_state','reports_state']) loop
    execute format('drop policy if exists "authenticated read %1$s" on public.%1$s', t);
    execute format('drop policy if exists "writers update %1$s"     on public.%1$s', t);
    execute format('drop policy if exists "writers insert %1$s"     on public.%1$s', t);

    execute format('create policy "authenticated read %1$s" on public.%1$s for select to authenticated using (true)', t);
    execute format('create policy "writers update %1$s"     on public.%1$s for update to authenticated using (public.is_writer())', t);
    execute format('create policy "writers insert %1$s"     on public.%1$s for insert to authenticated with check (public.is_writer())', t);
  end loop;
end$$;


-- ---------------------------------------------------------------------------
-- Seed singleton rows so updates don't 404. Idempotent on re-run.
-- ---------------------------------------------------------------------------
insert into public.clock_state         (id) values (1) on conflict (id) do nothing;
insert into public.presentation_state  (id) values (1) on conflict (id) do nothing;
insert into public.documents_state     (id) values (1) on conflict (id) do nothing;


-- Done. Verify with:
--   select * from public.profiles;            -- empty until first signup
--   select id, payload from public.clock_state;          -- {} default
--   select id, payload from public.presentation_state;   -- empty seed
--   select id, payload from public.documents_state;      -- empty sections
