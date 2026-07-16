-- Per-user desktop pins — the personal pinned-shortcut layout on the
-- Performance OS hub. One row per user; `pins` is a JSON array of pin objects:
--   { id, kind:'tool'|'link', sec, n, label, url, a1, a2, icon, col, row }
--
-- Deliberately a SEPARATE table (not a column on public.profiles): users need
-- full write access to their own pins, and we must never hand them write access
-- to their profile row, where `tier` lives.

create table if not exists public.desktop_pins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  pins       jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.desktop_pins enable row level security;

-- Each user may only read/write their OWN pins.
drop policy if exists "desktop_pins own select" on public.desktop_pins;
create policy "desktop_pins own select" on public.desktop_pins
  for select using (auth.uid() = user_id);

drop policy if exists "desktop_pins own insert" on public.desktop_pins;
create policy "desktop_pins own insert" on public.desktop_pins
  for insert with check (auth.uid() = user_id);

drop policy if exists "desktop_pins own update" on public.desktop_pins;
create policy "desktop_pins own update" on public.desktop_pins
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "desktop_pins own delete" on public.desktop_pins;
create policy "desktop_pins own delete" on public.desktop_pins
  for delete using (auth.uid() = user_id);
