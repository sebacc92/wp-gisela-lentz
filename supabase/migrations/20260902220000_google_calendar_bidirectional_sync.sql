-- Sincronización bidireccional segura.
--
-- La aplicación sigue siendo la fuente de verdad de los turnos de pacientes:
-- este archivo NO habilita que Google modifique un turno real. Agrega
-- solamente dos capacidades nuevas y explícitas:
--
--   1. Los eventos que alguien crea a mano en el calendario dedicado se
--      importan como BLOQUEOS de agenda (sin paciente, sin seña, sin
--      recordatorios, sin WhatsApp) y ocupan el horario.
--   2. Los cambios que alguien hace en Google sobre un evento administrado por
--      la app se registran como CONFLICTO pendiente para que una persona ADMIN
--      decida, nunca como una reprogramación o cancelación silenciosa.
--
-- Además separa la contabilidad de "última revisión" de la de "último cambio
-- procesado": hasta ahora `last_synced_at` sólo avanzaba al completar un job
-- saliente, así que una ejecución correcta sin trabajo pendiente no dejaba
-- ninguna huella visible en el panel.

-- ---------------------------------------------------------------------------
-- 1. Estado de la conexión: sync token incremental, lease y bitácora de corridas
-- ---------------------------------------------------------------------------

alter table public.google_calendar_connections
  add column inbound_sync_token text
    check (inbound_sync_token is null
      or char_length(inbound_sync_token) between 1 and 8192),
  add column inbound_sync_token_generation bigint,
  add column inbound_sync_state text not null default 'never_synced'
    check (inbound_sync_state in (
      'never_synced',
      'awaiting_first_import',
      'incremental',
      'full_resync_required'
    )),
  add column inbound_first_import_approved_at timestamptz,
  add column inbound_first_import_approved_by uuid
    references public.profiles (id) on delete set null,
  add column inbound_lease_token uuid,
  add column inbound_lease_expires_at timestamptz,
  add column last_checked_at timestamptz,
  add column last_sync_completed_at timestamptz,
  add column last_sync_summary jsonb not null default '{}'::jsonb,
  add column last_sync_error text,
  add constraint google_calendar_last_sync_summary_object
    check (jsonb_typeof(last_sync_summary) = 'object'),
  add constraint google_calendar_sync_token_generation check (
    inbound_sync_token is null or inbound_sync_token_generation is not null
  );

comment on column public.google_calendar_connections.last_synced_at is
  'Último cambio efectivamente procesado. No avanza cuando no hubo trabajo.';
comment on column public.google_calendar_connections.last_checked_at is
  'Último intento de sincronización, exitoso o no. Es lo que ve el panel.';
comment on column public.google_calendar_connections.last_sync_completed_at is
  'Última corrida completa sin errores, aunque no hubiera cambios.';
comment on column public.google_calendar_connections.inbound_sync_token is
  'nextSyncToken de events.list. Sólo válido para inbound_sync_token_generation.';

-- ---------------------------------------------------------------------------
-- 2. Eventos externos del calendario dedicado
-- ---------------------------------------------------------------------------
--
-- Se usa una entidad propia en vez de `availability_exceptions` porque aquélla
-- modela fecha + hora local por profesional, y un evento de Google es un
-- instante con zona horaria que pertenece al consultorio entero. Reutilizarla
-- obligaría a inventar un profesional y a perder la precisión del rango.

create table public.google_calendar_external_events (
  google_event_id text primary key
    check (char_length(google_event_id) between 1 and 1024),
  connection_generation bigint not null,
  kind text not null check (kind in ('block', 'unsupported')),
  status text not null default 'active'
    check (status in ('active', 'removed', 'converted')),
  summary text check (summary is null or char_length(summary) <= 120),
  starts_at timestamptz,
  ends_at timestamptz,
  all_day boolean not null default false,
  recurring boolean not null default false,
  unsupported_reason text check (
    unsupported_reason is null
    or unsupported_reason in (
      'ALL_DAY',
      'RECURRING',
      'MISSING_RANGE',
      'INVALID_RANGE'
    )
  ),
  google_etag text check (google_etag is null or char_length(google_etag) <= 255),
  google_updated_at timestamptz,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{32}$'),
  converted_appointment_id uuid
    references public.appointments (id) on delete set null,
  imported_at timestamptz not null default now(),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_calendar_external_block_range check (
    kind <> 'block'
    or (starts_at is not null and ends_at is not null and starts_at < ends_at)
  ),
  constraint google_calendar_external_unsupported_reason check (
    (kind = 'unsupported') = (unsupported_reason is not null)
  ),
  constraint google_calendar_external_converted check (
    status <> 'converted' or converted_appointment_id is not null
  )
);

create index google_calendar_external_events_active_range_idx
  on public.google_calendar_external_events (starts_at, ends_at)
  where kind = 'block' and status = 'active';

create index google_calendar_external_events_status_idx
  on public.google_calendar_external_events (status, kind);

comment on table public.google_calendar_external_events is
  'Eventos creados a mano en el calendario dedicado. Un bloqueo ocupa la agenda pero nunca representa un paciente.';

-- ---------------------------------------------------------------------------
-- 3. Conflictos: cambios hechos en Google sobre turnos reales
-- ---------------------------------------------------------------------------

create table public.google_calendar_sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null
    references public.appointments (id) on delete cascade,
  google_event_id text not null,
  kind text not null check (kind in (
    'reschedule_requested',
    'cancellation_requested'
  )),
  status text not null default 'pending'
    check (status in ('pending', 'applied', 'rejected', 'superseded')),
  proposed_starts_at timestamptz,
  proposed_ends_at timestamptz,
  observed_starts_at timestamptz,
  observed_ends_at timestamptz,
  google_updated_at timestamptz,
  connection_generation bigint not null,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null,
  resolution_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_calendar_conflict_reschedule_range check (
    kind <> 'reschedule_requested'
    or (
      proposed_starts_at is not null
      and proposed_ends_at is not null
      and proposed_starts_at < proposed_ends_at
    )
  ),
  constraint google_calendar_conflict_resolution check (
    (status in ('pending')) = (resolved_at is null)
  )
);

-- Un solo conflicto pendiente por turno: una segunda observación del mismo
-- evento actualiza la propuesta en vez de acumular filas.
create unique index google_calendar_sync_conflicts_pending_idx
  on public.google_calendar_sync_conflicts (appointment_id)
  where status = 'pending';

create index google_calendar_sync_conflicts_status_idx
  on public.google_calendar_sync_conflicts (status, detected_at desc);

comment on table public.google_calendar_sync_conflicts is
  'Propuestas originadas en Google sobre turnos reales. Requieren decisión ADMIN explícita.';

create trigger set_google_calendar_external_events_updated_at
  before update on public.google_calendar_external_events
  for each row execute function public.set_updated_at();

create trigger set_google_calendar_sync_conflicts_updated_at
  before update on public.google_calendar_sync_conflicts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Permisos
-- ---------------------------------------------------------------------------

alter table public.google_calendar_external_events enable row level security;
alter table public.google_calendar_sync_conflicts enable row level security;

revoke all on table public.google_calendar_external_events
  from public, anon, authenticated;
revoke all on table public.google_calendar_sync_conflicts
  from public, anon, authenticated;
grant all on table public.google_calendar_external_events to service_role;
grant all on table public.google_calendar_sync_conflicts to service_role;

-- El panel necesita leer bloqueos y conflictos para mostrarlos en la agenda.
-- Toda mutación pasa por RPCs ADMIN o por el worker con service_role.
grant select on table public.google_calendar_external_events to authenticated;
grant select on table public.google_calendar_sync_conflicts to authenticated;

create policy google_calendar_external_events_read
  on public.google_calendar_external_events
  for select to authenticated
  using (public.current_user_is_active());

create policy google_calendar_sync_conflicts_read
  on public.google_calendar_sync_conflicts
  for select to authenticated
  using (public.current_user_is_active());

-- ---------------------------------------------------------------------------
-- 5. Los bloqueos importados ocupan la agenda
-- ---------------------------------------------------------------------------
--
-- Misma función que ya validaba reglas, excepciones y solapamientos; se agrega
-- un único chequeo nuevo contra los bloqueos activos traídos de Google.

create or replace function public.appointment_slot_is_available(
  p_professional_id uuid,
  p_starts_at timestamptz,
  p_duration_minutes integer,
  p_exclude_appointment_id uuid default null,
  p_timezone text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.app_settings%rowtype;
  effective_timezone text;
  buffer_minutes integer;
  local_start timestamp;
  local_end_with_buffer timestamp;
  local_date date;
  inside_working_window boolean;
  requested_range tstzrange;
begin
  if p_starts_at is null
    or p_duration_minutes is null
    or p_duration_minutes not between 5 and 480
    or not exists (
      select 1 from public.professionals
      where id = p_professional_id and active
    ) then
    return false;
  end if;

  select * into settings from public.app_settings where id = true;
  if not found then return false; end if;

  effective_timezone := coalesce(nullif(trim(p_timezone), ''), settings.timezone);
  buffer_minutes := settings.appointment_buffer_minutes;
  begin
    local_start := p_starts_at at time zone effective_timezone;
    local_end_with_buffer := (
      p_starts_at + make_interval(mins => p_duration_minutes + buffer_minutes)
    ) at time zone effective_timezone;
  exception when invalid_parameter_value then
    return false;
  end;

  if p_starts_at < clock_timestamp()
      + make_interval(mins => settings.minimum_booking_notice_minutes)
    or local_start::date <> local_end_with_buffer::date then
    return false;
  end if;
  local_date := local_start::date;
  requested_range := tstzrange(
    p_starts_at,
    p_starts_at + make_interval(mins => p_duration_minutes + buffer_minutes),
    '[)'
  );

  select (
    exists (
      select 1 from public.availability_rules rule
      where rule.professional_id = p_professional_id
        and rule.active
        and rule.weekday = extract(dow from local_date)::smallint
        and local_start::time >= rule.start_time
        and local_end_with_buffer::time <= rule.end_time
    )
    or exists (
      select 1 from public.availability_exceptions availability_exception
      where availability_exception.professional_id = p_professional_id
        and availability_exception.date = local_date
        and availability_exception.type = 'available'
        and (
          (availability_exception.start_time is null and availability_exception.end_time is null)
          or (
            local_start::time >= availability_exception.start_time
            and local_end_with_buffer::time <= availability_exception.end_time
          )
        )
    )
  ) into inside_working_window;
  if not inside_working_window then return false; end if;

  if exists (
    select 1 from public.availability_exceptions availability_exception
    where availability_exception.professional_id = p_professional_id
      and availability_exception.date = local_date
      and availability_exception.type = 'unavailable'
      and (
        (availability_exception.start_time is null and availability_exception.end_time is null)
        or (
          availability_exception.start_time < local_end_with_buffer::time
          and availability_exception.end_time > local_start::time
        )
      )
  ) then
    return false;
  end if;

  -- Bloqueos importados desde el calendario dedicado de Google. Pertenecen al
  -- consultorio, no a un profesional, por eso no filtran por professional_id.
  if exists (
    select 1 from public.google_calendar_external_events external_event
    where external_event.kind = 'block'
      and external_event.status = 'active'
      and tstzrange(
        external_event.starts_at,
        external_event.ends_at,
        '[)'
      ) && requested_range
  ) then
    return false;
  end if;

  if exists (
    select 1 from public.appointments appointment
    where appointment.professional_id = p_professional_id
      and (p_exclude_appointment_id is null or appointment.id <> p_exclude_appointment_id)
      and (
        appointment.status = 'confirmed'
        or (
          appointment.status = 'scheduled'
          and (
            appointment.deposit_status in ('proof_received', 'not_required')
            or (
              appointment.deposit_status = 'pending'
              and appointment.hold_expires_at > clock_timestamp()
            )
          )
        )
      )
      and tstzrange(
        appointment.starts_at,
        appointment.ends_at + make_interval(mins => buffer_minutes),
        '[)'
      ) && requested_range
  ) then
    return false;
  end if;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Reproyección puntual hacia Google
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_google_calendar_projection(
  p_appointment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.google_calendar_sync_jobs as current_job (
    appointment_id, operation, desired_version, status, attempts,
    available_at, processing_started_at, last_error, connection_generation
  )
  select appointment.id,
         case when appointment.status in ('scheduled', 'confirmed')
           then 'upsert' else 'delete' end,
         1, 'pending', 0, clock_timestamp(), null, null,
         connection.connection_generation
  from public.appointments appointment
  join public.google_calendar_connections connection
    on connection.id = true and connection.status = 'connected'
  where appointment.id = p_appointment_id
  on conflict (appointment_id) do update
  set operation = excluded.operation,
      desired_version = current_job.desired_version + 1,
      status = case when current_job.status = 'processing'
        then 'processing' else 'pending' end,
      attempts = case when current_job.status = 'processing'
        then current_job.attempts else 0 end,
      available_at = clock_timestamp(),
      processing_started_at = case when current_job.status = 'processing'
        then current_job.processing_started_at else null end,
      last_error = null,
      connection_generation = greatest(
        current_job.connection_generation,
        excluded.connection_generation
      );
end;
$$;

revoke execute on function public.enqueue_google_calendar_projection(uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Lease de sincronización entrante
-- ---------------------------------------------------------------------------

create or replace function public.begin_google_calendar_inbound_sync(
  p_expected_generation bigint,
  p_lease_seconds integer default 240
)
returns table (
  lease_token uuid,
  sync_token text,
  sync_state text,
  first_import_approved boolean,
  google_calendar_id text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  granted_lease uuid := gen_random_uuid();
  safe_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 240), 900));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  return query
  update public.google_calendar_connections connection
  set inbound_lease_token = granted_lease,
      inbound_lease_expires_at =
        clock_timestamp() + make_interval(secs => safe_lease_seconds)
  where connection.id = true
    and connection.status = 'connected'
    and connection.connection_generation = p_expected_generation
    and (
      connection.inbound_lease_expires_at is null
      or connection.inbound_lease_expires_at <= clock_timestamp()
    )
  returning granted_lease,
    case
      when connection.inbound_sync_token_generation = p_expected_generation
        then connection.inbound_sync_token
      else null
    end,
    case
      when connection.inbound_sync_token_generation is distinct from p_expected_generation
        and connection.inbound_sync_state = 'incremental'
        then 'full_resync_required'
      else connection.inbound_sync_state
    end,
    connection.inbound_first_import_approved_at is not null,
    connection.google_calendar_id;
end;
$$;

create or replace function public.release_google_calendar_inbound_lease(
  p_expected_generation bigint,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  update public.google_calendar_connections
  set inbound_lease_token = null, inbound_lease_expires_at = null
  where id = true
    and connection_generation = p_expected_generation
    and inbound_lease_token = p_lease_token;
  return found;
end;
$$;

create or replace function public.assert_google_calendar_inbound_lease(
  p_expected_generation bigint,
  p_lease_token uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.google_calendar_connections
    where id = true
      and status = 'connected'
      and connection_generation = p_expected_generation
      and inbound_lease_token = p_lease_token
      and inbound_lease_expires_at > clock_timestamp()
  ) then
    raise exception 'GOOGLE_CALENDAR_INBOUND_LEASE_LOST' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.assert_google_calendar_inbound_lease(bigint, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Aplicación idempotente de eventos externos
-- ---------------------------------------------------------------------------

create or replace function public.apply_google_calendar_external_event(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_google_event_id text,
  p_kind text,
  p_removed boolean,
  p_summary text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_all_day boolean,
  p_recurring boolean,
  p_unsupported_reason text,
  p_google_etag text,
  p_google_updated_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_event_id text := trim(coalesce(p_google_event_id, ''));
  -- El título lo escribió la propia dueña del calendario, pero igual se
  -- normaliza: sin saltos de línea ni caracteres de control, y acotado.
  clean_summary text := nullif(
    left(regexp_replace(coalesce(p_summary, ''), '[[:cntrl:]]+', ' ', 'g'), 120),
    ''
  );
  existing public.google_calendar_external_events%rowtype;
  next_hash text;
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );
  if clean_event_id = '' or char_length(clean_event_id) > 1024 then
    raise exception 'GOOGLE_EXTERNAL_EVENT_INVALID' using errcode = '22023';
  end if;

  select * into existing
  from public.google_calendar_external_events
  where google_event_id = clean_event_id
  for update;

  -- Un bloqueo que ya se convirtió en turno real deja de responder a Google:
  -- el turno pasa a ser la fuente de verdad y tiene su propio evento.
  if found and existing.status = 'converted' then
    return 'skipped_converted';
  end if;

  if coalesce(p_removed, false) then
    if not found then return 'already_removed'; end if;
    if existing.status = 'removed' then return 'already_removed'; end if;
    update public.google_calendar_external_events
    set status = 'removed',
        removed_at = clock_timestamp(),
        google_etag = p_google_etag,
        google_updated_at = p_google_updated_at
    where google_event_id = clean_event_id;
    return 'removed';
  end if;

  if p_kind not in ('block', 'unsupported') then
    raise exception 'GOOGLE_EXTERNAL_EVENT_INVALID' using errcode = '22023';
  end if;
  if p_kind = 'block'
    and (p_starts_at is null or p_ends_at is null or p_starts_at >= p_ends_at)
  then
    raise exception 'GOOGLE_EXTERNAL_EVENT_INVALID' using errcode = '22023';
  end if;
  if (p_kind = 'unsupported') <> (p_unsupported_reason is not null) then
    raise exception 'GOOGLE_EXTERNAL_EVENT_INVALID' using errcode = '22023';
  end if;

  next_hash := md5(
    p_kind
    || '|' || coalesce(clean_summary, '')
    || '|' || coalesce(p_starts_at::text, '')
    || '|' || coalesce(p_ends_at::text, '')
    || '|' || coalesce(p_all_day, false)::text
    || '|' || coalesce(p_recurring, false)::text
    || '|' || coalesce(p_unsupported_reason, '')
  );

  if found
    and existing.status = 'active'
    and existing.content_hash = next_hash
    and existing.connection_generation = p_expected_generation
  then
    return 'unchanged';
  end if;

  insert into public.google_calendar_external_events (
    google_event_id, connection_generation, kind, status, summary,
    starts_at, ends_at, all_day, recurring, unsupported_reason,
    google_etag, google_updated_at, content_hash, removed_at
  ) values (
    clean_event_id, p_expected_generation, p_kind, 'active', clean_summary,
    p_starts_at, p_ends_at, coalesce(p_all_day, false),
    coalesce(p_recurring, false), p_unsupported_reason,
    p_google_etag, p_google_updated_at, next_hash, null
  )
  on conflict (google_event_id) do update
  set connection_generation = p_expected_generation,
      kind = excluded.kind,
      status = 'active',
      summary = excluded.summary,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      all_day = excluded.all_day,
      recurring = excluded.recurring,
      unsupported_reason = excluded.unsupported_reason,
      google_etag = excluded.google_etag,
      google_updated_at = excluded.google_updated_at,
      content_hash = excluded.content_hash,
      removed_at = null;

  return case when existing.google_event_id is null then 'created' else 'updated' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Observación de eventos administrados por la app
-- ---------------------------------------------------------------------------
--
-- Nunca escribe sobre `appointments`. Si Google coincide con la app no toca
-- nada (ni base ni cola saliente): ahí se corta el loop
-- app -> push -> pull -> push.

create or replace function public.observe_google_calendar_managed_event(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_google_event_id text,
  p_appointment_id uuid,
  p_cancelled boolean,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_google_updated_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  appointment_row public.appointments%rowtype;
  conflict_kind text;
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );

  select * into appointment_row
  from public.appointments where id = p_appointment_id;
  if not found then return 'ignored_unknown_appointment'; end if;

  -- Un push todavía en vuelo explica cualquier diferencia sin que nadie haya
  -- tocado Google. Esperar a que la cola termine evita conflictos fantasma.
  if exists (
    select 1 from public.google_calendar_sync_jobs job
    where job.appointment_id = p_appointment_id
      and job.status in ('pending', 'processing')
  ) then
    return 'ignored_pending_push';
  end if;

  if appointment_row.status not in ('scheduled', 'confirmed') then
    return 'ignored_final_appointment';
  end if;

  if coalesce(p_cancelled, false) then
    conflict_kind := 'cancellation_requested';
  elsif p_starts_at is not distinct from appointment_row.starts_at
    and p_ends_at is not distinct from appointment_row.ends_at
  then
    -- Google refleja exactamente lo que dice la app.
    return 'in_sync';
  elsif p_starts_at is null or p_ends_at is null or p_starts_at >= p_ends_at then
    return 'ignored_invalid_range';
  else
    conflict_kind := 'reschedule_requested';
  end if;

  insert into public.google_calendar_sync_conflicts as current_conflict (
    appointment_id, google_event_id, kind, status,
    proposed_starts_at, proposed_ends_at,
    observed_starts_at, observed_ends_at,
    google_updated_at, connection_generation
  ) values (
    p_appointment_id, p_google_event_id, conflict_kind, 'pending',
    case when conflict_kind = 'reschedule_requested' then p_starts_at end,
    case when conflict_kind = 'reschedule_requested' then p_ends_at end,
    appointment_row.starts_at, appointment_row.ends_at,
    p_google_updated_at, p_expected_generation
  )
  on conflict (appointment_id) where status = 'pending' do update
  set google_event_id = excluded.google_event_id,
      kind = excluded.kind,
      proposed_starts_at = excluded.proposed_starts_at,
      proposed_ends_at = excluded.proposed_ends_at,
      observed_starts_at = excluded.observed_starts_at,
      observed_ends_at = excluded.observed_ends_at,
      google_updated_at = excluded.google_updated_at,
      connection_generation = excluded.connection_generation,
      detected_at = clock_timestamp()
  where current_conflict.kind is distinct from excluded.kind
     or current_conflict.proposed_starts_at is distinct from excluded.proposed_starts_at
     or current_conflict.proposed_ends_at is distinct from excluded.proposed_ends_at;

  return case when found then 'conflict_recorded' else 'conflict_pending' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Cierre de la corrida y bitácora visible
-- ---------------------------------------------------------------------------

create or replace function public.sanitized_google_calendar_summary(
  p_summary jsonb
)
returns jsonb
language sql
immutable
set search_path = public
as $$
  -- Sólo contadores enteros y no negativos. Ningún título, nombre ni id llega
  -- nunca al panel ni a los logs por esta vía.
  select coalesce(
    jsonb_object_agg(entry.key, entry.value),
    '{}'::jsonb
  )
  from jsonb_each(coalesce(p_summary, '{}'::jsonb)) as entry
  where entry.key in (
      'pushed', 'updatedInGoogle', 'deletedInGoogle', 'retried', 'failed',
      'blocksImported', 'blocksUpdated', 'blocksRemoved', 'blocksUnchanged',
      'conflictsOpened', 'conflictsPending', 'skipped', 'managedInSync',
      'pagesFetched', 'fullResync'
    )
    and jsonb_typeof(entry.value) in ('number', 'boolean')
$$;

create or replace function public.complete_google_calendar_inbound_sync(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_next_sync_token text,
  p_summary jsonb,
  p_changes integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_token text := nullif(trim(coalesce(p_next_sync_token, '')), '');
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  update public.google_calendar_connections
  set inbound_sync_token = coalesce(clean_token, inbound_sync_token),
      inbound_sync_token_generation = case
        when clean_token is not null then p_expected_generation
        else inbound_sync_token_generation
      end,
      inbound_sync_state = case
        when clean_token is not null then 'incremental'
        else inbound_sync_state
      end,
      last_checked_at = clock_timestamp(),
      last_sync_completed_at = clock_timestamp(),
      -- `last_synced_at` conserva su semántica histórica: último cambio real.
      last_synced_at = case
        when coalesce(p_changes, 0) > 0 then clock_timestamp()
        else last_synced_at
      end,
      last_sync_summary = public.sanitized_google_calendar_summary(p_summary),
      last_sync_error = null,
      inbound_lease_token = null,
      inbound_lease_expires_at = null
  where id = true
    and connection_generation = p_expected_generation
    and inbound_lease_token = p_lease_token;
  return found;
end;
$$;

create or replace function public.fail_google_calendar_inbound_sync(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_error_code text,
  p_summary jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_error text := upper(trim(coalesce(p_error_code, '')));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if clean_error !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'INVALID_SYNC_FAILURE' using errcode = '22023';
  end if;

  update public.google_calendar_connections
  set last_checked_at = clock_timestamp(),
      last_sync_error = clean_error,
      last_sync_summary = public.sanitized_google_calendar_summary(p_summary),
      inbound_lease_token = null,
      inbound_lease_expires_at = null
  where id = true
    and connection_generation = p_expected_generation
    and inbound_lease_token = p_lease_token;
  return found;
end;
$$;

-- HTTP 410: el token caducó. Se descarta el token y se pide un full resync,
-- pero jamás se borran turnos, pacientes ni bloqueos ya importados: la
-- reconciliación posterior los vuelve a ver por su google_event_id.
create or replace function public.invalidate_google_calendar_sync_token(
  p_expected_generation bigint,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  update public.google_calendar_connections
  set inbound_sync_token = null,
      inbound_sync_token_generation = null,
      inbound_sync_state = 'full_resync_required'
  where id = true
    and connection_generation = p_expected_generation
    and inbound_lease_token = p_lease_token;
  return found;
end;
$$;

-- Una corrida completa (full resync o incremental sin token previo) sabe qué
-- eventos siguen existiendo. Los bloqueos que ya no aparecieron se retiran.
create or replace function public.reconcile_google_calendar_external_events(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_seen_event_ids text[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed_count integer;
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );
  with retired as (
    update public.google_calendar_external_events
    set status = 'removed', removed_at = clock_timestamp()
    where status = 'active'
      and not (google_event_id = any(coalesce(p_seen_event_ids, array[]::text[])))
    returning 1
  )
  select count(*)::integer into removed_count from retired;
  return removed_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Primera importación: requiere aprobación ADMIN explícita
-- ---------------------------------------------------------------------------

create or replace function public.approve_google_calendar_first_import(
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_user_id and active and role = 'ADMIN'
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  update public.google_calendar_connections
  set inbound_first_import_approved_at =
        coalesce(inbound_first_import_approved_at, clock_timestamp()),
      inbound_first_import_approved_by =
        coalesce(inbound_first_import_approved_by, p_user_id)
  where id = true and status = 'connected';
  if not found then return false; end if;

  insert into public.audit_logs (actor_user_id, action, entity_type, metadata)
  values (
    p_user_id,
    'google_calendar.inbound_import_approved',
    'google_calendar',
    '{}'::jsonb
  );
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Estado extendido para el panel
-- ---------------------------------------------------------------------------

drop function if exists public.google_calendar_status();

create or replace function public.google_calendar_status()
returns table (
  connected boolean,
  status text,
  google_account_email text,
  google_calendar_name text,
  last_synced_at timestamptz,
  last_checked_at timestamptz,
  last_sync_completed_at timestamptz,
  last_sync_summary jsonb,
  last_sync_error text,
  last_error text,
  inbound_sync_state text,
  inbound_first_import_approved boolean,
  pending_count bigint,
  failed_count bigint,
  active_block_count bigint,
  unsupported_event_count bigint,
  pending_conflict_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  return query
  select connection.status = 'connected',
         connection.status,
         connection.google_account_email,
         connection.google_calendar_name,
         connection.last_synced_at,
         connection.last_checked_at,
         connection.last_sync_completed_at,
         connection.last_sync_summary,
         connection.last_sync_error,
         connection.last_error,
         connection.inbound_sync_state,
         connection.inbound_first_import_approved_at is not null,
         (select count(*) from public.google_calendar_sync_jobs job
          where job.status in ('pending', 'processing')),
         (select count(*) from public.google_calendar_sync_jobs job
          where job.status = 'failed'),
         (select count(*) from public.google_calendar_external_events event
          where event.kind = 'block' and event.status = 'active'),
         (select count(*) from public.google_calendar_external_events event
          where event.kind = 'unsupported' and event.status = 'active'),
         (select count(*) from public.google_calendar_sync_conflicts conflict
          where conflict.status = 'pending')
  from public.google_calendar_connections connection where id = true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Decisiones ADMIN sobre conflictos y bloqueos
-- ---------------------------------------------------------------------------

create or replace function public.apply_google_calendar_conflict(
  p_conflict_id uuid
)
returns public.google_calendar_sync_conflicts
language plpgsql
security definer
set search_path = public
as $$
declare
  conflict_row public.google_calendar_sync_conflicts%rowtype;
  result public.google_calendar_sync_conflicts;
begin
  if not public.current_user_is_admin() or auth.uid() is null then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select * into conflict_row
  from public.google_calendar_sync_conflicts
  where id = p_conflict_id for update;
  if not found or conflict_row.status <> 'pending' then
    raise exception 'CONFLICT_NOT_PENDING' using errcode = 'P0001';
  end if;

  -- Se aplica con las mismas RPCs que usa el panel: validan solapamiento,
  -- cobertura, duración clínica y disparan la proyección a Google y los
  -- recordatorios exactamente igual que un cambio hecho a mano.
  if conflict_row.kind = 'cancellation_requested' then
    perform public.update_appointment_status(
      conflict_row.appointment_id, 'cancelled'::public.appointment_status
    );
  else
    perform public.reschedule_appointment(
      conflict_row.appointment_id, conflict_row.proposed_starts_at
    );
  end if;

  update public.google_calendar_sync_conflicts
  set status = 'applied',
      resolved_at = clock_timestamp(),
      resolved_by = auth.uid(),
      resolution_error = null
  where id = p_conflict_id
  returning * into result;

  perform public.enqueue_google_calendar_projection(conflict_row.appointment_id);

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(), 'google_calendar.conflict_applied', 'appointment',
    conflict_row.appointment_id,
    jsonb_build_object('conflict_id', p_conflict_id, 'kind', conflict_row.kind)
  );
  return result;
end;
$$;

create or replace function public.reject_google_calendar_conflict(
  p_conflict_id uuid
)
returns public.google_calendar_sync_conflicts
language plpgsql
security definer
set search_path = public
as $$
declare
  conflict_row public.google_calendar_sync_conflicts%rowtype;
  result public.google_calendar_sync_conflicts;
begin
  if not public.current_user_is_admin() or auth.uid() is null then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select * into conflict_row
  from public.google_calendar_sync_conflicts
  where id = p_conflict_id for update;
  if not found or conflict_row.status <> 'pending' then
    raise exception 'CONFLICT_NOT_PENDING' using errcode = 'P0001';
  end if;

  update public.google_calendar_sync_conflicts
  set status = 'rejected',
      resolved_at = clock_timestamp(),
      resolved_by = auth.uid()
  where id = p_conflict_id
  returning * into result;

  -- Rechazar significa que la app tiene razón: se vuelve a proyectar su
  -- estado authoritative sobre Google.
  perform public.enqueue_google_calendar_projection(conflict_row.appointment_id);

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(), 'google_calendar.conflict_rejected', 'appointment',
    conflict_row.appointment_id,
    jsonb_build_object('conflict_id', p_conflict_id, 'kind', conflict_row.kind)
  );
  return result;
end;
$$;

create or replace function public.dismiss_google_calendar_block(
  p_google_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_user_is_admin() or auth.uid() is null then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  update public.google_calendar_external_events
  set status = 'removed', removed_at = clock_timestamp()
  where google_event_id = p_google_event_id and status = 'active';
  if not found then return false; end if;

  insert into public.audit_logs (actor_user_id, action, entity_type, metadata)
  values (
    auth.uid(), 'google_calendar.block_dismissed', 'google_calendar',
    '{}'::jsonb
  );
  return true;
end;
$$;

-- "Convertir en turno": el turno se crea con el flujo normal del panel, con
-- paciente, servicio, cobertura y profesional reales. Este RPC sólo libera el
-- bloqueo y deja la trazabilidad. Nunca inventa un contacto.
create or replace function public.convert_google_calendar_block(
  p_google_event_id text,
  p_appointment_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_user_is_admin() or auth.uid() is null then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.appointments where id = p_appointment_id
  ) then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.google_calendar_external_events
  set status = 'converted',
      converted_appointment_id = p_appointment_id,
      removed_at = clock_timestamp()
  where google_event_id = p_google_event_id
    and kind = 'block'
    and status = 'active';
  if not found then return false; end if;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(), 'google_calendar.block_converted', 'appointment',
    p_appointment_id, '{}'::jsonb
  );
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. Grants
-- ---------------------------------------------------------------------------

do $$
declare
  signature regprocedure;
begin
  for signature in
    select procedure_oid
    from (values
      ('public.begin_google_calendar_inbound_sync(bigint,integer)'::regprocedure),
      ('public.release_google_calendar_inbound_lease(bigint,uuid)'::regprocedure),
      ('public.apply_google_calendar_external_event(bigint,uuid,text,text,boolean,text,timestamptz,timestamptz,boolean,boolean,text,text,timestamptz)'::regprocedure),
      ('public.observe_google_calendar_managed_event(bigint,uuid,text,uuid,boolean,timestamptz,timestamptz,timestamptz)'::regprocedure),
      ('public.complete_google_calendar_inbound_sync(bigint,uuid,text,jsonb,integer)'::regprocedure),
      ('public.fail_google_calendar_inbound_sync(bigint,uuid,text,jsonb)'::regprocedure),
      ('public.invalidate_google_calendar_sync_token(bigint,uuid)'::regprocedure),
      ('public.reconcile_google_calendar_external_events(bigint,uuid,text[])'::regprocedure),
      ('public.approve_google_calendar_first_import(uuid)'::regprocedure),
      ('public.google_calendar_status()'::regprocedure)
    ) functions(procedure_oid)
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', signature);
    execute format('grant execute on function %s to service_role', signature);
  end loop;
end;
$$;

do $$
declare
  signature regprocedure;
begin
  for signature in
    select procedure_oid
    from (values
      ('public.apply_google_calendar_conflict(uuid)'::regprocedure),
      ('public.reject_google_calendar_conflict(uuid)'::regprocedure),
      ('public.dismiss_google_calendar_block(text)'::regprocedure),
      ('public.convert_google_calendar_block(text,uuid)'::regprocedure)
    ) functions(procedure_oid)
  loop
    execute format('revoke execute on function %s from public, anon', signature);
    execute format('grant execute on function %s to authenticated, service_role', signature);
  end loop;
end;
$$;

revoke execute on function public.sanitized_google_calendar_summary(jsonb)
  from public, anon, authenticated;

-- Una corrida que sólo procesó la cola saliente —porque otra ejecución tenía
-- el lease, o porque la primera importación todavía no fue aprobada— igual es
-- una revisión y tiene que verse en el panel.
create or replace function public.record_google_calendar_sync_attempt(
  p_expected_generation bigint,
  p_summary jsonb,
  p_changes integer,
  p_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_note text := nullif(upper(trim(coalesce(p_note, ''))), '');
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if clean_note is not null and clean_note !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'INVALID_SYNC_FAILURE' using errcode = '22023';
  end if;

  update public.google_calendar_connections
  set last_checked_at = clock_timestamp(),
      last_sync_summary = public.sanitized_google_calendar_summary(p_summary),
      last_sync_error = clean_note,
      last_synced_at = case
        when coalesce(p_changes, 0) > 0 then clock_timestamp()
        else last_synced_at
      end
  where id = true and connection_generation = p_expected_generation;
  return found;
end;
$$;

revoke execute on function public.record_google_calendar_sync_attempt(bigint, jsonb, integer, text)
  from public, anon, authenticated;
grant execute on function public.record_google_calendar_sync_attempt(bigint, jsonb, integer, text)
  to service_role;
