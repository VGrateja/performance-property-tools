-- =============================================================================
-- 054_forge_cotality.sql
-- Stores the LAST Cotality (CoreLogic) upload so the Data Forge "Cotality"
-- view shows the latest dropped data without re-dropping the file. Single row
-- (id='latest'), the filtered result as jsonb. Isolated, writer-only write —
-- like the rest of the rdp_*/forge_* store. (Licensed CoreLogic data: only the
-- already-filtered columns/regions are stored, not the raw workbook.)
-- =============================================================================

create table if not exists forge_cotality (
  id          text primary key default 'latest',
  data        jsonb not null,           -- { fileName, tabs, headers, cap:{rows,cities}, lga:{rows,matched,missing} }
  file_name   text,
  uploaded_at timestamptz default now(),
  uploaded_by text,
  updated_at  timestamptz default now()
);

alter table forge_cotality enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'forge_cotality' and policyname = 'forge_cotality_read') then
    create policy forge_cotality_read on forge_cotality for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'forge_cotality' and policyname = 'forge_cotality_write') then
    create policy forge_cotality_write on forge_cotality for all to authenticated using (is_writer()) with check (is_writer());
  end if;
end $$;
