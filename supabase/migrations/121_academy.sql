-- 121_academy.sql
--
-- Performance Academy (tools/academy.html): the staff learning tool — a shelf
-- of "videotape" volumes whose chapters are sequences of scenes (text,
-- infographics, playable charts that pause on beats, quizzes).
--
-- WHY TABLES AND NOT REPO FILES: the course narrative ("why the team sold
-- Perth", the decisions ledger) is proprietary and the Pages repo is PUBLIC.
-- Same model as the Bookshelf (097_books.sql): content is fetched at runtime
-- behind auth, seeded by a scratch script through the service role, edited
-- later by writers through the tool. Learner progress is per user and private
-- to that user.
--
-- Scene jsonb shape (rendered by tools/academy.html):
--   { type:'text', title, body }                       body = markdown-lite, [[term]] glossary links
--   { type:'infographic', kind, props, caption }       kind = clock-dial | runway-meter | five-dials | quadrants | vr-chain | pipeline
--   { type:'chart-play', chart, region, propertyType, from, to, speed, focus, title, intro, beats:[{at,title,body,highlight,hour}] }
--   { type:'quiz', title, questions:[{q, options, answer, why}] }
--   { type:'compare', caption, left, right }

create table public.academy_volumes (
  slug        text primary key,
  title       text not null,
  subtitle    text,
  sort        integer not null default 100,
  cover       jsonb,                       -- shelf hints {vol, group, minutes, accent, icon}
  summary     text,
  generated   boolean not null default false,   -- built by scripts/build-academy-regions.mjs, never hand-edited
  region_slug text,                        -- regional volumes only
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

create table public.academy_chapters (
  id          text primary key,            -- 'v1-c2'
  volume_slug text not null references public.academy_volumes(slug) on delete cascade,
  title       text not null,
  sort        integer not null default 1,
  scenes      jsonb not null default '[]'::jsonb,
  generated   boolean not null default false,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);
create index academy_chapters_volume_idx on public.academy_chapters (volume_slug, sort);

create table public.academy_glossary (
  term        text primary key,            -- lower-case except proper nouns
  definition  text not null,
  see_also    text[] not null default '{}',
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

-- The decisions ledger: the ONLY source the course may cite for "why the team
-- bought / sold". Human-entered; the course says "not recorded yet" otherwise.
create table public.academy_decisions (
  id            uuid primary key default gen_random_uuid(),
  region_slug   text not null,
  property_type text not null default 'both' check (property_type in ('h','u','both')),
  decided_on    date not null,
  action        text not null check (action in ('buy','hold','sell','exit','watch')),
  rationale     text,
  source        text,                      -- who said so, when
  recorded_by   uuid references auth.users(id),
  created_at    timestamptz not null default now()
);
create index academy_decisions_region_idx on public.academy_decisions (region_slug, decided_on);

-- Learner progress: one row per (user, chapter). Private to the user.
create table public.academy_progress (
  user_id      uuid not null references auth.users(id) on delete cascade,
  chapter_id   text not null references public.academy_chapters(id) on delete cascade,
  completed_at timestamptz not null default now(),
  score        integer,                    -- quiz chapters: percent
  primary key (user_id, chapter_id)
);

alter table public.academy_volumes   enable row level security;
alter table public.academy_chapters  enable row level security;
alter table public.academy_glossary  enable row level security;
alter table public.academy_decisions enable row level security;
alter table public.academy_progress  enable row level security;

-- every signed-in staff member can read the course; the hub's group gating
-- decides who sees the tool at all (registry key 'academy')
create policy "academy_volumes_read"   on public.academy_volumes   for select to authenticated using (true);
create policy "academy_chapters_read"  on public.academy_chapters  for select to authenticated using (true);
create policy "academy_glossary_read"  on public.academy_glossary  for select to authenticated using (true);
create policy "academy_decisions_read" on public.academy_decisions for select to authenticated using (true);

-- writes: dev/admin only (seeding happens via service role, which bypasses RLS)
create policy "academy_volumes_write"   on public.academy_volumes   for all to authenticated using (public.is_writer()) with check (public.is_writer());
create policy "academy_chapters_write"  on public.academy_chapters  for all to authenticated using (public.is_writer()) with check (public.is_writer());
create policy "academy_glossary_write"  on public.academy_glossary  for all to authenticated using (public.is_writer()) with check (public.is_writer());
create policy "academy_decisions_write" on public.academy_decisions for all to authenticated using (public.is_writer()) with check (public.is_writer());

-- progress: a user sees and writes only their own rows
create policy "academy_progress_own_read"  on public.academy_progress for select to authenticated using (auth.uid() = user_id);
create policy "academy_progress_own_write" on public.academy_progress for insert to authenticated with check (auth.uid() = user_id);
create policy "academy_progress_own_update" on public.academy_progress for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "academy_progress_own_delete" on public.academy_progress for delete to authenticated using (auth.uid() = user_id);
