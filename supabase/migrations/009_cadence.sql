-- =============================================================================
-- 009_cadence.sql — Performance Property Cadence
--
-- Cadence is a multi-board task tracker for Property Managers and the PH Team.
-- Each "board" represents a category of recurring work (Lease Agreement,
-- Maintenance, Compliance, Onboarding, Marketing requests, etc.). Each "card"
-- is a single task instance with both data fields (PM fills in once) and stage
-- checkboxes (PH Team ticks as work progresses).
--
-- Two tables, not one:
--   - cadence_boards (24-30 rows total) — board definitions + schema. Per-board
--     schemas live in a jsonb column so the Admin UI (Phase 2) can edit fields
--     without DB migrations.
--   - cadence_cards (~50-60 new rows per month, ~500-700/year) — task
--     instances. Card-level data lives in a jsonb column so the same table
--     stores cards from every board regardless of field shape.
--
-- RLS:
--   - Staff (dev/admin/company) read all boards + cards.
--   - Writers (dev/admin) write boards. Admin UI is gated to writers; PMs
--     can't redesign the schema, only fill cards against it.
--   - Staff write cards (insert + update). PMs create the request, PH Team
--     ticks the stages — both flows land in the same table.
--   - Nobody at tier client/guest sees Cadence at all (no policy match).
--
-- Run order: after 008_*.sql. Idempotent — re-running the file is safe.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tier helper — wider than is_writer (which is dev/admin only). Cadence
-- needs the company tier in too because PMs sit there. Keeping this in this
-- migration rather than 001_init.sql so older migrations stay independent.
-- ---------------------------------------------------------------------------
create or replace function public.is_staff() returns boolean as $$
  select coalesce(public.current_tier() in ('dev','admin','company'), false);
$$ language sql stable security definer;


-- ---------------------------------------------------------------------------
-- Boards — one row per category. schema jsonb shape:
--   {
--     "fields": [
--       { "key": "<snake_case>", "label": "<Human Label>",
--         "type": "text"|"textarea"|"number"|"date"|"checkbox"|"select",
--         "kind": "data"|"stage",
--         "required": true,                 // optional, defaults to false
--         "options": ["NSW","VIC", …],     // for type:"select" only
--         "prefix": "$",                    // optional, e.g. for currency
--         "is_completion": true             // optional, marks the "Completed"
--                                           // stage — toggling it sets
--                                           // cards.completed_at + fires the
--                                           // "completed" Resend email
--       },
--       …
--     ]
--   }
-- ---------------------------------------------------------------------------
create table if not exists public.cadence_boards (
  id              uuid          primary key default gen_random_uuid(),
  slug            text          not null unique,
  name            text          not null,
  icon            text,                                 -- emoji, e.g. '📝'
  description     text,
  schema          jsonb         not null default '{"fields":[]}'::jsonb,
  display_order   int           not null default 0,
  archived        boolean       not null default false,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  updated_by      uuid          references public.profiles(id)
);

create index if not exists cadence_boards_slug_idx          on public.cadence_boards (slug);
create index if not exists cadence_boards_display_order_idx on public.cadence_boards (display_order);
create index if not exists cadence_boards_archived_idx      on public.cadence_boards (archived) where archived = false;


-- ---------------------------------------------------------------------------
-- Cards — one row per task instance. data jsonb holds BOTH the data fields
-- (PM-supplied) AND the stage flags (PH Team ticks), keyed by the field's
-- `key` from the board's schema. Mixing them in one blob keeps the storage
-- simple — the UI knows from the schema which keys are data vs stage.
-- ---------------------------------------------------------------------------
create table if not exists public.cadence_cards (
  id              uuid          primary key default gen_random_uuid(),
  board_slug      text          not null references public.cadence_boards(slug) on delete restrict,
  data            jsonb         not null default '{}'::jsonb,
  created_at      timestamptz   not null default now(),
  created_by      uuid          references public.profiles(id),
  -- Denormalised creator email so the UI can show "Filed by …" without
  -- joining profiles every read.
  created_by_email text,
  updated_at      timestamptz   not null default now(),
  updated_by      uuid          references public.profiles(id),
  -- Set when the user toggles the schema field marked is_completion=true.
  -- Drives the "Completed" filter + the "completed" Resend email.
  completed_at    timestamptz
);

create index if not exists cadence_cards_board_idx        on public.cadence_cards (board_slug);
create index if not exists cadence_cards_created_idx      on public.cadence_cards (created_at desc);
create index if not exists cadence_cards_completed_idx    on public.cadence_cards (completed_at) where completed_at is not null;
create index if not exists cadence_cards_open_idx         on public.cadence_cards (board_slug, created_at desc) where completed_at is null;


-- ---------------------------------------------------------------------------
-- updated_at + updated_by auto-touch. Same pattern as the rest of the suite.
-- ---------------------------------------------------------------------------
create or replace function public.touch_cadence_boards() returns trigger as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_cadence_boards_updated on public.cadence_boards;
create trigger trg_cadence_boards_updated
  before update on public.cadence_boards
  for each row execute function public.touch_cadence_boards();

create or replace function public.touch_cadence_cards() returns trigger as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_cadence_cards_updated on public.cadence_cards;
create trigger trg_cadence_cards_updated
  before update on public.cadence_cards
  for each row execute function public.touch_cadence_cards();


-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.cadence_boards enable row level security;
alter table public.cadence_cards  enable row level security;

drop policy if exists "staff read boards"     on public.cadence_boards;
drop policy if exists "writers insert boards" on public.cadence_boards;
drop policy if exists "writers update boards" on public.cadence_boards;
drop policy if exists "writers delete boards" on public.cadence_boards;

create policy "staff read boards"     on public.cadence_boards for select to authenticated using (public.is_staff());
create policy "writers insert boards" on public.cadence_boards for insert to authenticated with check (public.is_writer());
create policy "writers update boards" on public.cadence_boards for update to authenticated using (public.is_writer());
create policy "writers delete boards" on public.cadence_boards for delete to authenticated using (public.is_writer());

drop policy if exists "staff read cards"   on public.cadence_cards;
drop policy if exists "staff insert cards" on public.cadence_cards;
drop policy if exists "staff update cards" on public.cadence_cards;
drop policy if exists "writers delete cards" on public.cadence_cards;

create policy "staff read cards"     on public.cadence_cards for select to authenticated using (public.is_staff());
create policy "staff insert cards"   on public.cadence_cards for insert to authenticated with check (public.is_staff());
create policy "staff update cards"   on public.cadence_cards for update to authenticated using (public.is_staff());
-- Delete kept writer-only on purpose — cards are an audit trail of PM
-- requests. Writers can clean up test rows; PMs can't bin requests they
-- regret filing. If a card needs to be cancelled, mark it via a "Cancelled"
-- stage instead of deleting.
create policy "writers delete cards" on public.cadence_cards for delete to authenticated using (public.is_writer());


-- ---------------------------------------------------------------------------
-- Seed data — Lease Agreement board. Re-running is safe (on conflict ignored).
-- Schema mirrors the 22 fields from the user spec, split into 14 data fields
-- (PM fills in once) + 8 stage checkboxes + Completed.
-- ---------------------------------------------------------------------------
insert into public.cadence_boards (slug, name, icon, description, display_order, schema)
values (
  'lease-agreement',
  'Lease Agreement',
  '📝',
  'New tenant lease drafting + execution. PM submits the property + lease terms; PH Team drafts, tracks sign-off, and confirms first rent + bond + move-in.',
  10,
  $json${
    "fields": [
      { "key": "property_address",       "label": "Property Address",     "type": "text",     "kind": "data", "required": true },
      { "key": "property_manager",       "label": "Property Manager",     "type": "text",     "kind": "data", "required": true },
      { "key": "state",                  "label": "State",                "type": "select",   "kind": "data", "options": ["NSW","VIC","QLD","SA","WA","TAS","ACT","NT"], "required": true },
      { "key": "date",                   "label": "Date",                 "type": "date",     "kind": "data" },
      { "key": "app_id_ire",             "label": "App ID from IRE",      "type": "text",     "kind": "data" },
      { "key": "lease_term",             "label": "Lease Term",           "type": "text",     "kind": "data" },
      { "key": "rent_per_week",          "label": "Rent per Week",        "type": "number",   "kind": "data", "prefix": "$" },
      { "key": "bond_amount",            "label": "Bond Amount",          "type": "number",   "kind": "data", "prefix": "$" },
      { "key": "lease_start_date",       "label": "Lease Start Date",     "type": "date",     "kind": "data" },
      { "key": "lease_end_date",         "label": "Lease End Date",       "type": "date",     "kind": "data" },
      { "key": "rent_increase_during",   "label": "Rent Increase During Lease?", "type": "checkbox", "kind": "data" },
      { "key": "additional_clauses",     "label": "Additional Clauses",   "type": "textarea", "kind": "data" },
      { "key": "strata_laws_inc",        "label": "Strata Laws Included", "type": "checkbox", "kind": "data" },
      { "key": "other_details",          "label": "Other Details",        "type": "textarea", "kind": "data" },

      { "key": "draft_of_lease",         "label": "Draft of Lease",       "type": "checkbox", "kind": "stage" },
      { "key": "draft_sent_to_pm",       "label": "Draft Sent to PM",     "type": "checkbox", "kind": "stage" },
      { "key": "lease_sent_to_tenant",   "label": "Lease sent to Tenant", "type": "checkbox", "kind": "stage" },
      { "key": "tenant_signed_lease",    "label": "Tenant Signed Lease",  "type": "checkbox", "kind": "stage" },
      { "key": "tenant_paid_rent",       "label": "Tenant Paid Rent",     "type": "checkbox", "kind": "stage" },
      { "key": "tenant_paid_bond",       "label": "Tenant Paid Bond",     "type": "checkbox", "kind": "stage" },
      { "key": "fees_entered_checked",   "label": "Fees Entered & Checked","type":"checkbox", "kind": "stage" },
      { "key": "move_in_email",          "label": "Move-in Email Sent",   "type": "checkbox", "kind": "stage" },
      { "key": "completed",              "label": "Completed",            "type": "checkbox", "kind": "stage", "is_completion": true }
    ]
  }$json$::jsonb
)
on conflict (slug) do nothing;
