-- Contrato inbound v2: lectura paginada y acotada de Google Calendar.
--
-- El syncToken de Google representa exactamente los parámetros de la consulta
-- que lo produjo. Por eso la versión del contrato y la ventana cubierta viajan
-- junto al token. Ningún estado anterior se adopta implícitamente: las columnas
-- nuevas son nullable y esta migración no modifica la conexión activa.

alter table public.google_calendar_connections
  add column inbound_sync_contract_version integer,
  add column inbound_coverage_starts_at timestamptz,
  add column inbound_coverage_ends_at timestamptz,
  add column inbound_sync_timezone text,
  add column inbound_lease_sync_contract_version integer,
  add column inbound_lease_coverage_starts_at timestamptz,
  add column inbound_lease_coverage_ends_at timestamptz,
  add column inbound_lease_timezone text,
  add constraint google_calendar_inbound_window_contract check (
    (
      inbound_sync_contract_version is null
      and inbound_coverage_starts_at is null
      and inbound_coverage_ends_at is null
      and inbound_sync_timezone is null
    )
    or (
      inbound_sync_contract_version = 2
      and inbound_sync_token is not null
      and inbound_sync_token_generation = connection_generation
      and inbound_coverage_starts_at is not null
      and inbound_coverage_ends_at is not null
      and inbound_coverage_starts_at < inbound_coverage_ends_at
      and inbound_coverage_ends_at
        <= inbound_coverage_starts_at + interval '22 days'
      and inbound_sync_timezone is not null
      and inbound_sync_timezone = google_calendar_timezone
      and inbound_sync_timezone = trim(inbound_sync_timezone)
      and char_length(inbound_sync_timezone) between 1 and 255
    )
  ),
  add constraint google_calendar_inbound_lease_window_contract check (
    (
      inbound_lease_sync_contract_version is null
      and inbound_lease_coverage_starts_at is null
      and inbound_lease_coverage_ends_at is null
      and inbound_lease_timezone is null
    )
    or (
      inbound_lease_token is not null
      and inbound_lease_sync_contract_version = 2
      and inbound_lease_coverage_starts_at is not null
      and inbound_lease_coverage_ends_at is not null
      and inbound_lease_coverage_starts_at < inbound_lease_coverage_ends_at
      and inbound_lease_coverage_ends_at
        <= inbound_lease_coverage_starts_at + interval '22 days'
      and inbound_lease_timezone is not null
      and inbound_lease_timezone = google_calendar_timezone
      and inbound_lease_timezone = trim(inbound_lease_timezone)
      and char_length(inbound_lease_timezone) between 1 and 255
    )
  );

comment on column public.google_calendar_connections.inbound_sync_contract_version is
  'Versión del contrato events.list que produjo inbound_sync_token; v2 expande ocurrencias dentro de una ventana finita.';
comment on column public.google_calendar_connections.inbound_coverage_starts_at is
  'Inicio inclusivo de la disponibilidad comprobada por la última lectura inbound completa.';
comment on column public.google_calendar_connections.inbound_coverage_ends_at is
  'Fin exclusivo de la disponibilidad comprobada por la última lectura inbound completa.';
comment on column public.google_calendar_connections.inbound_sync_timezone is
  'Zona enviada en Events.list al producir inbound_sync_token; forma parte del contrato incremental.';
comment on column public.google_calendar_connections.inbound_lease_sync_contract_version is
  'Versión solicitada por el lease inbound activo; complete debe confirmar exactamente ese contrato.';
comment on column public.google_calendar_connections.inbound_lease_coverage_starts_at is
  'Inicio de ventana solicitado al tomar el lease inbound activo.';
comment on column public.google_calendar_connections.inbound_lease_coverage_ends_at is
  'Fin exclusivo de ventana solicitado al tomar el lease inbound activo.';
comment on column public.google_calendar_connections.inbound_lease_timezone is
  'Zona exacta solicitada por el lease inbound activo.';

-- Las respuestas free/busy ambiguas no se interpretan como disponibilidad.
-- El worker puede conservar el evento como unsupported hasta obtener una
-- clasificación concluyente, sin descartarlo ni inferir por color o título.
alter table public.google_calendar_external_events
  drop constraint google_calendar_external_events_unsupported_reason_check,
  add constraint google_calendar_external_events_unsupported_reason_check
    check (
      unsupported_reason is null
      or unsupported_reason in (
        'ALL_DAY',
        'RECURRING',
        'MISSING_RANGE',
        'INVALID_RANGE',
        'AMBIGUOUS_BUSY_STATE'
      )
    );

-- Centraliza el cutover. Finalize, disconnect, invalidación de token y cambio
-- de alcance ya actualizan alguno de estos campos; el trigger garantiza que no
-- puedan dejar una cobertura v2 perteneciente al alcance anterior.
create or replace function public.clear_stale_google_calendar_inbound_window()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
    and new.status in ('connected', 'reconnect_required')
    and new.connection_generation = old.connection_generation
    and new.google_calendar_timezone is distinct from
      old.google_calendar_timezone
  then
    -- `timeZone` forma parte de Events.list. Aunque dos zonas produzcan los
    -- mismos instantes para esta ventana, un token emitido con una no se puede
    -- reutilizar con la otra.
    new.inbound_sync_token := null;
    new.inbound_sync_token_generation := null;
    new.inbound_sync_state := 'full_resync_required';
    new.inbound_sync_contract_version := null;
    new.inbound_coverage_starts_at := null;
    new.inbound_coverage_ends_at := null;
    new.inbound_sync_timezone := null;
    new.inbound_lease_token := null;
    new.inbound_lease_expires_at := null;
  end if;

  if new.status <> 'connected'
    or new.sync_scope_google_account_id is distinct from new.google_account_id
    or new.sync_scope_google_calendar_id is distinct from new.google_calendar_id
    or new.sync_scope_generation is distinct from new.connection_generation
  then
    new.inbound_sync_token := null;
    new.inbound_sync_token_generation := null;
    new.inbound_lease_token := null;
    new.inbound_lease_expires_at := null;
  end if;

  if new.last_sync_error is not null then
    -- Un error de lectura invalida también el token que dependía de esa
    -- observación. El próximo intento debe releer la ventana completa.
    new.inbound_sync_token := null;
    new.inbound_sync_token_generation := null;
    new.inbound_sync_state := 'full_resync_required';
    new.inbound_sync_contract_version := null;
    new.inbound_coverage_starts_at := null;
    new.inbound_coverage_ends_at := null;
    new.inbound_sync_timezone := null;
  elsif new.status <> 'connected'
    or new.inbound_sync_state <> 'incremental'
    or new.inbound_sync_token is null
    or new.inbound_sync_token_generation is distinct from
      new.connection_generation
    or new.sync_scope_google_account_id is distinct from new.google_account_id
    or new.sync_scope_google_calendar_id is distinct from new.google_calendar_id
    or new.sync_scope_generation is distinct from new.connection_generation
  then
    new.inbound_sync_contract_version := null;
    new.inbound_coverage_starts_at := null;
    new.inbound_coverage_ends_at := null;
    new.inbound_sync_timezone := null;
  elsif new.inbound_sync_contract_version is distinct from 2 then
    -- Un token legacy puede seguir existiendo durante el despliegue, pero no
    -- declara cobertura y nunca abre disponibilidad bajo el contrato nuevo.
    new.inbound_sync_contract_version := null;
    new.inbound_coverage_starts_at := null;
    new.inbound_coverage_ends_at := null;
    new.inbound_sync_timezone := null;
  end if;

  if new.inbound_lease_token is null then
    new.inbound_lease_sync_contract_version := null;
    new.inbound_lease_coverage_starts_at := null;
    new.inbound_lease_coverage_ends_at := null;
    new.inbound_lease_timezone := null;
  end if;
  return new;
end;
$$;

create trigger google_calendar_inbound_window_guard
  before insert or update of
    status,
    google_account_id,
    google_calendar_id,
    google_calendar_timezone,
    connection_generation,
    inbound_sync_token,
    inbound_sync_token_generation,
    inbound_sync_state,
    last_sync_error,
    sync_scope_google_account_id,
    sync_scope_google_calendar_id,
    sync_scope_generation,
    inbound_sync_contract_version,
    inbound_coverage_starts_at,
    inbound_coverage_ends_at,
    inbound_sync_timezone,
    inbound_lease_token,
    inbound_lease_expires_at,
    inbound_lease_sync_contract_version,
    inbound_lease_coverage_starts_at,
    inbound_lease_coverage_ends_at,
    inbound_lease_timezone
  on public.google_calendar_connections
  for each row execute function public.clear_stale_google_calendar_inbound_window();

-- Preview necesita conocer la zona del calendario seleccionado antes de tomar
-- un lease. Se conserva el RPC histórico para un rollout escalonado.
create or replace function public.get_google_calendar_windowed_connection_secret()
returns table (
  status text,
  google_calendar_id text,
  refresh_token text,
  connection_generation bigint,
  google_calendar_timezone text
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  return query
  select connection.status,
         connection.google_calendar_id,
         secret.decrypted_secret,
         connection.connection_generation,
         connection.google_calendar_timezone
  from public.google_calendar_connections connection
  left join vault.decrypted_secrets secret
    on secret.id = connection.refresh_token_secret_id
  where connection.id = true
    and connection.status = 'connected'
    and connection.google_account_id is not null
    and connection.google_calendar_id is not null
    and connection.google_calendar_timezone is not null
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = connection.connection_generation;
end;
$$;

-- Caller legacy: sólo puede tomar lease mientras el token siga siendo legacy.
-- Una vez establecido v2 devuelve cero filas, evitando que una Function vieja
-- degrade la lectura recurrente durante un despliegue escalonado.
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
set search_path = pg_catalog, public
as $$
declare
  granted_lease uuid := gen_random_uuid();
  safe_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 240), 900));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );

  return query
  update public.google_calendar_connections connection
  set inbound_lease_token = granted_lease,
      inbound_lease_expires_at =
        clock_timestamp() + make_interval(secs => safe_lease_seconds),
      inbound_lease_sync_contract_version = null,
      inbound_lease_coverage_starts_at = null,
      inbound_lease_coverage_ends_at = null,
      inbound_lease_timezone = null
  where connection.id = true
    and connection.status = 'connected'
    and connection.connection_generation = p_expected_generation
    and connection.google_calendar_timezone is not null
    and connection.inbound_sync_contract_version is null
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = p_expected_generation
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

-- Contrato v2. Todos los argumentos de ventana son obligatorios para que
-- PostgREST seleccione este overload sin ambigüedad con la firma histórica.
create or replace function public.begin_google_calendar_inbound_sync(
  p_expected_generation bigint,
  p_lease_seconds integer,
  p_sync_contract_version integer,
  p_coverage_starts_at timestamptz,
  p_coverage_ends_at timestamptz
)
returns table (
  lease_token uuid,
  sync_token text,
  sync_state text,
  first_import_approved boolean,
  google_calendar_id text,
  google_calendar_timezone text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  granted_lease uuid := gen_random_uuid();
  safe_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 240), 900));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );

  -- El lock de fila mantiene estable la zona usada para validar medianoches y
  -- para ligar el lease al parámetro exacto enviado a Events.list.
  perform 1
  from public.google_calendar_connections connection
  where connection.id = true
  for update;

  if p_sync_contract_version is distinct from 2
    or p_coverage_starts_at is null
    or p_coverage_ends_at is null
    or p_coverage_starts_at >= p_coverage_ends_at
    or p_coverage_ends_at > p_coverage_starts_at + interval '22 days'
  then
    raise exception 'INVALID_GOOGLE_CALENDAR_SYNC_WINDOW'
      using errcode = '22023';
  end if;

  begin
    if not exists (
      select 1
      from public.google_calendar_connections connection
      where connection.id = true
        and connection.google_calendar_timezone is not null
        and (p_coverage_starts_at at time zone connection.google_calendar_timezone)::time
          = time '00:00:00'
        and (p_coverage_ends_at at time zone connection.google_calendar_timezone)::time
          = time '00:00:00'
        and (p_coverage_ends_at at time zone connection.google_calendar_timezone)::date
          = (p_coverage_starts_at at time zone connection.google_calendar_timezone)::date + 21
    ) then
      raise exception 'INVALID_GOOGLE_CALENDAR_SYNC_WINDOW'
        using errcode = '22023';
    end if;
  exception when invalid_parameter_value then
    raise exception 'INVALID_GOOGLE_CALENDAR_SYNC_WINDOW'
      using errcode = '22023';
  end;

  return query
  update public.google_calendar_connections connection
  set inbound_lease_token = granted_lease,
      inbound_lease_expires_at =
        clock_timestamp() + make_interval(secs => safe_lease_seconds),
      inbound_lease_sync_contract_version = p_sync_contract_version,
      inbound_lease_coverage_starts_at = p_coverage_starts_at,
      inbound_lease_coverage_ends_at = p_coverage_ends_at,
      inbound_lease_timezone = connection.google_calendar_timezone
  where connection.id = true
    and connection.status = 'connected'
    and connection.connection_generation = p_expected_generation
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = p_expected_generation
    and (
      connection.inbound_lease_expires_at is null
      or connection.inbound_lease_expires_at <= clock_timestamp()
    )
  returning granted_lease,
    case
      when connection.inbound_sync_state = 'incremental'
        and connection.inbound_sync_token is not null
        and connection.inbound_sync_token_generation = p_expected_generation
        and connection.inbound_sync_contract_version = p_sync_contract_version
        and connection.inbound_coverage_starts_at = p_coverage_starts_at
        and connection.inbound_coverage_ends_at = p_coverage_ends_at
        and connection.inbound_sync_timezone =
          connection.google_calendar_timezone
      then connection.inbound_sync_token
      else null
    end,
    case
      when connection.inbound_sync_state = 'incremental'
        and connection.inbound_sync_token is not null
        and connection.inbound_sync_token_generation = p_expected_generation
        and connection.inbound_sync_contract_version = p_sync_contract_version
        and connection.inbound_coverage_starts_at = p_coverage_starts_at
        and connection.inbound_coverage_ends_at = p_coverage_ends_at
        and connection.inbound_sync_timezone =
          connection.google_calendar_timezone
      then 'incremental'
      else 'full_resync_required'
    end,
    connection.inbound_first_import_approved_at is not null,
    connection.google_calendar_id,
    connection.google_calendar_timezone;
end;
$$;

-- Caller legacy: su token no demuestra una ventana, por lo que cualquier
-- cierre exitoso borra metadatos v2 y mantiene la disponibilidad cerrada.
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
set search_path = pg_catalog, public
as $$
declare
  clean_token text := nullif(trim(coalesce(p_next_sync_token, '')), '');
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  update public.google_calendar_connections connection
  set inbound_sync_token = coalesce(clean_token, connection.inbound_sync_token),
      inbound_sync_token_generation = case
        when clean_token is not null then p_expected_generation
        else connection.inbound_sync_token_generation
      end,
      inbound_sync_state = case
        when clean_token is not null then 'incremental'
        else connection.inbound_sync_state
      end,
      inbound_sync_contract_version = null,
      inbound_coverage_starts_at = null,
      inbound_coverage_ends_at = null,
      inbound_sync_timezone = null,
      last_checked_at = clock_timestamp(),
      last_sync_completed_at = clock_timestamp(),
      last_synced_at = case
        when coalesce(p_changes, 0) > 0 then clock_timestamp()
        else connection.last_synced_at
      end,
      last_sync_summary = public.sanitized_google_calendar_summary(p_summary),
      last_sync_error = null,
      inbound_lease_token = null,
      inbound_lease_expires_at = null,
      inbound_lease_sync_contract_version = null,
      inbound_lease_coverage_starts_at = null,
      inbound_lease_coverage_ends_at = null,
      inbound_lease_timezone = null
  where connection.id = true
    and connection.status = 'connected'
    and connection.connection_generation = p_expected_generation
    and connection.inbound_sync_contract_version is null
    and connection.inbound_lease_sync_contract_version is null
    and connection.inbound_lease_coverage_starts_at is null
    and connection.inbound_lease_coverage_ends_at is null
    and connection.inbound_lease_timezone is null
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = p_expected_generation
    and connection.inbound_lease_token = p_lease_token
    and connection.inbound_lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create or replace function public.complete_google_calendar_inbound_sync(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_next_sync_token text,
  p_summary jsonb,
  p_changes integer,
  p_sync_contract_version integer,
  p_coverage_starts_at timestamptz,
  p_coverage_ends_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  clean_token text := nullif(trim(coalesce(p_next_sync_token, '')), '');
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if clean_token is null
    or char_length(clean_token) > 8192
    or p_sync_contract_version is distinct from 2
    or p_coverage_starts_at is null
    or p_coverage_ends_at is null
    or p_coverage_starts_at >= p_coverage_ends_at
    or p_coverage_ends_at > p_coverage_starts_at + interval '22 days'
  then
    raise exception 'INVALID_GOOGLE_CALENDAR_SYNC_WINDOW'
      using errcode = '22023';
  end if;

  update public.google_calendar_connections connection
  set inbound_sync_token = clean_token,
      inbound_sync_token_generation = p_expected_generation,
      inbound_sync_state = 'incremental',
      inbound_sync_contract_version = p_sync_contract_version,
      inbound_coverage_starts_at = p_coverage_starts_at,
      inbound_coverage_ends_at = p_coverage_ends_at,
      inbound_sync_timezone = connection.google_calendar_timezone,
      last_checked_at = clock_timestamp(),
      last_sync_completed_at = clock_timestamp(),
      last_synced_at = case
        when coalesce(p_changes, 0) > 0 then clock_timestamp()
        else connection.last_synced_at
      end,
      last_sync_summary = public.sanitized_google_calendar_summary(p_summary),
      last_sync_error = null,
      inbound_lease_token = null,
      inbound_lease_expires_at = null,
      inbound_lease_sync_contract_version = null,
      inbound_lease_coverage_starts_at = null,
      inbound_lease_coverage_ends_at = null,
      inbound_lease_timezone = null
  where connection.id = true
    and connection.status = 'connected'
    and connection.connection_generation = p_expected_generation
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = p_expected_generation
    and connection.inbound_lease_token = p_lease_token
    and connection.inbound_lease_sync_contract_version =
      p_sync_contract_version
    and connection.inbound_lease_coverage_starts_at = p_coverage_starts_at
    and connection.inbound_lease_coverage_ends_at = p_coverage_ends_at
    and connection.inbound_lease_timezone =
      connection.google_calendar_timezone
    and connection.inbound_lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create or replace function public.invalidate_google_calendar_sync_token(
  p_expected_generation bigint,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  update public.google_calendar_connections connection
  set inbound_sync_token = null,
      inbound_sync_token_generation = null,
      inbound_sync_contract_version = null,
      inbound_coverage_starts_at = null,
      inbound_coverage_ends_at = null,
      inbound_sync_timezone = null,
      inbound_sync_state = 'full_resync_required'
  where connection.id = true
    and connection.status = 'connected'
    and connection.connection_generation = p_expected_generation
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = p_expected_generation
    and connection.inbound_lease_token = p_lease_token;
  return found;
end;
$$;

-- Disponibilidad fail-closed: con una conexión activa sólo se ofrecen slots
-- completamente contenidos en la ventana comprobada bajo v2. `ends_at` es
-- exclusivo y también cubre el buffer operativo del consultorio.
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
set search_path = pg_catalog, public
as $$
declare
  settings public.app_settings%rowtype;
  effective_timezone text;
  buffer_minutes integer;
  requested_ends_at timestamptz;
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
      select 1 from public.professionals professional
      where professional.id = p_professional_id and professional.active
    )
  then
    return false;
  end if;

  select * into settings from public.app_settings app_settings
  where app_settings.id = true;
  if not found then return false; end if;

  buffer_minutes := settings.appointment_buffer_minutes;
  requested_ends_at := p_starts_at
    + make_interval(mins => p_duration_minutes + buffer_minutes);

  -- No se infiere disponibilidad fuera de la lectura confirmada. Una corrida
  -- fallida conserva los bloqueos históricos, invalida su cobertura y cierra
  -- la oferta hasta que otra lectura completa vuelva a verificar la ventana.
  if exists (
    select 1
    from public.google_calendar_connections connection
    where connection.id = true
      and connection.status in ('connected', 'reconnect_required')
      and not (
        connection.status = 'connected'
        and connection.inbound_sync_state = 'incremental'
        and connection.inbound_sync_token is not null
        and connection.inbound_sync_token_generation = connection.connection_generation
        and connection.inbound_sync_contract_version = 2
        and connection.inbound_sync_timezone is not null
        and connection.inbound_sync_timezone =
          connection.google_calendar_timezone
        and connection.inbound_coverage_starts_at is not null
        and connection.inbound_coverage_ends_at is not null
        and p_starts_at >= connection.inbound_coverage_starts_at
        and requested_ends_at <= connection.inbound_coverage_ends_at
        and connection.last_sync_error is null
        and connection.inbound_first_import_approved_at is not null
        and connection.sync_scope_google_account_id is not distinct from
          connection.google_account_id
        and connection.sync_scope_google_calendar_id is not distinct from
          connection.google_calendar_id
        and connection.sync_scope_generation = connection.connection_generation
      )
  ) then
    return false;
  end if;

  -- Un estado busy ambiguo o rango todavía no representable nunca se interpreta
  -- como libre. Se conserva para revisión y la agenda queda cerrada.
  if exists (
    select 1
    from public.google_calendar_external_events external_event
    join public.google_calendar_connections connection
      on connection.id = true
     and connection.status = 'connected'
     and connection.google_calendar_id = external_event.google_calendar_id
     and connection.connection_generation = external_event.connection_generation
     and connection.sync_scope_google_account_id is not distinct from
       connection.google_account_id
     and connection.sync_scope_google_calendar_id is not distinct from
       connection.google_calendar_id
     and connection.sync_scope_generation = connection.connection_generation
    where external_event.kind = 'unsupported'
      and external_event.status = 'active'
  ) then
    return false;
  end if;

  effective_timezone := coalesce(nullif(trim(p_timezone), ''), settings.timezone);
  begin
    local_start := p_starts_at at time zone effective_timezone;
    local_end_with_buffer := requested_ends_at at time zone effective_timezone;
  exception when invalid_parameter_value then
    return false;
  end;

  if p_starts_at < clock_timestamp()
      + make_interval(mins => settings.minimum_booking_notice_minutes)
    or local_start::date <> local_end_with_buffer::date
  then
    return false;
  end if;
  local_date := local_start::date;
  requested_range := tstzrange(p_starts_at, requested_ends_at, '[)');

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
          (
            availability_exception.start_time is null
            and availability_exception.end_time is null
          )
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
        (
          availability_exception.start_time is null
          and availability_exception.end_time is null
        )
        or (
          availability_exception.start_time < local_end_with_buffer::time
          and availability_exception.end_time > local_start::time
        )
      )
  ) then
    return false;
  end if;

  if exists (
    select 1
    from public.google_calendar_external_events external_event
    join public.google_calendar_connections connection
      on connection.id = true
      and connection.status in ('connected', 'reconnect_required')
      and connection.google_calendar_id = external_event.google_calendar_id
      and connection.connection_generation = external_event.connection_generation
      and connection.sync_scope_google_account_id is not distinct from
        connection.google_account_id
      and connection.sync_scope_google_calendar_id is not distinct from
        connection.google_calendar_id
      and connection.sync_scope_generation = connection.connection_generation
    where external_event.kind = 'block'
      and (
        external_event.status = 'active'
        or (
          external_event.status = 'converted'
          and external_event.external_cleanup_status in ('pending', 'failed')
        )
      )
      and tstzrange(external_event.starts_at, external_event.ends_at, '[)')
        && requested_range
  ) then
    return false;
  end if;

  if exists (
    select 1 from public.appointments appointment
    where appointment.professional_id = p_professional_id
      and (
        p_exclude_appointment_id is null
        or appointment.id <> p_exclude_appointment_id
      )
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

revoke execute on function public.clear_stale_google_calendar_inbound_window()
  from public, anon, authenticated;
revoke execute on function public.get_google_calendar_windowed_connection_secret()
  from public, anon, authenticated;
grant execute on function public.get_google_calendar_windowed_connection_secret()
  to service_role;

revoke execute on function public.begin_google_calendar_inbound_sync(
  bigint, integer, integer, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.begin_google_calendar_inbound_sync(
  bigint, integer, integer, timestamptz, timestamptz
) to service_role;

revoke execute on function public.complete_google_calendar_inbound_sync(
  bigint, uuid, text, jsonb, integer, integer, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.complete_google_calendar_inbound_sync(
  bigint, uuid, text, jsonb, integer, integer, timestamptz, timestamptz
) to service_role;
