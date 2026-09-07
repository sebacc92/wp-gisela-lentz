-- Refresh the agenda after Google imports without publishing external events.
-- Realtime DELETE cannot apply a deleted row's RLS, so its publication must
-- never carry calendar identifiers, event titles or patient-related content.
create table if not exists public.calendar_availability_updates (
  id boolean primary key default true check (id),
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default clock_timestamp()
);

insert into public.calendar_availability_updates (id)
values (true) on conflict (id) do nothing;

alter table public.calendar_availability_updates enable row level security;
revoke all on table public.calendar_availability_updates
  from public, anon, authenticated, service_role;
grant select on table public.calendar_availability_updates to authenticated;

drop policy if exists calendar_availability_updates_read
  on public.calendar_availability_updates;
create policy calendar_availability_updates_read
  on public.calendar_availability_updates
  for select to authenticated
  using (public.current_user_is_admin());

comment on table public.calendar_availability_updates is
  'Señal de recarga para la agenda. Sólo revisión y fecha técnica; nunca contiene IDs de Google, nombres, turnos ni datos clínicos.';

create or replace function public.notify_calendar_availability_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  -- Empty reconciliation statements should not produce a reload heartbeat.
  if tg_op = 'DELETE' then
    if not exists (select 1 from availability_old_rows) then return null; end if;
  else
    if not exists (select 1 from availability_new_rows) then return null; end if;
  end if;

  insert into public.calendar_availability_updates as signal (id, revision, updated_at)
  values (true, 1, clock_timestamp())
  on conflict (id) do update
  set revision = signal.revision + 1, updated_at = clock_timestamp();
  return null;
end;
$function$;

revoke execute on function public.notify_calendar_availability_update()
  from public, anon, authenticated, service_role;

-- Transition tables coalesce each batch into one signal, including deletions.
drop trigger if exists calendar_availability_notify_insert
  on public.google_calendar_external_events;
create trigger calendar_availability_notify_insert
after insert on public.google_calendar_external_events
referencing new table as availability_new_rows
for each statement execute function public.notify_calendar_availability_update();

drop trigger if exists calendar_availability_notify_update
  on public.google_calendar_external_events;
create trigger calendar_availability_notify_update
after update on public.google_calendar_external_events
referencing new table as availability_new_rows
for each statement execute function public.notify_calendar_availability_update();

drop trigger if exists calendar_availability_notify_delete
  on public.google_calendar_external_events;
create trigger calendar_availability_notify_delete
after delete on public.google_calendar_external_events
referencing old table as availability_old_rows
for each statement execute function public.notify_calendar_availability_update();

do $migration$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    raise exception 'SUPABASE_REALTIME_PUBLICATION_NOT_FOUND';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'calendar_availability_updates'
  ) then
    alter publication supabase_realtime
      add table public.calendar_availability_updates;
  end if;
end;
$migration$;
