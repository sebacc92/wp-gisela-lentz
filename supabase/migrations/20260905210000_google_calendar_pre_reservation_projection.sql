-- Proyeccion saliente acotada para pre-reservas creadas despues de una
-- activacion explicita. La migracion es deliberadamente inerte: no activa la
-- automatizacion, no modifica turnos ni jobs existentes y no ejecuta cron.

alter table public.google_calendar_connections
  add column automation_enabled boolean not null default false,
  add column automation_epoch uuid,
  add column automation_activated_at timestamptz,
  add column automation_google_account_id text,
  add column automation_google_calendar_id text,
  add column automation_connection_generation bigint,
  add constraint google_calendar_automation_binding_check check (
    (
      not automation_enabled
      and automation_epoch is null
      and automation_activated_at is null
      and automation_google_account_id is null
      and automation_google_calendar_id is null
      and automation_connection_generation is null
    )
    or (
      automation_enabled
      and automation_epoch is not null
      and automation_activated_at is not null
      and automation_google_account_id is not null
      and automation_google_calendar_id is not null
      and automation_connection_generation is not null
      and automation_connection_generation > 0
    )
  );

comment on column public.google_calendar_connections.automation_epoch is
  'Epoch no reutilizable que autoriza proyecciones creadas despues de automation_activated_at para una cuenta, calendario y generacion exactos.';
comment on column public.google_calendar_connections.automation_activated_at is
  'Cutoff inclusivo de created_at. NULL mantiene la automatizacion saliente completamente inerte.';

alter table public.google_calendar_sync_jobs
  add column automation_epoch uuid,
  add column authorized_google_account_id text,
  add column authorized_google_calendar_id text,
  add column authorized_connection_generation bigint,
  add column projection_stage text,
  add column projected_stage text,
  add constraint google_calendar_sync_jobs_automation_binding_check check (
    (
      automation_epoch is null
      and authorized_google_account_id is null
      and authorized_google_calendar_id is null
      and authorized_connection_generation is null
      and projection_stage is null
      and projected_stage is null
    )
    or (
      automation_epoch is not null
      and authorized_google_account_id is not null
      and authorized_google_calendar_id is not null
      and authorized_connection_generation is not null
      and authorized_connection_generation > 0
      and projection_stage in ('pre_reservation', 'confirmed', 'absent')
      and (
        projected_stage is null
        or projected_stage in ('pre_reservation', 'confirmed', 'absent')
      )
      and not (
        projected_stage = 'confirmed'
        and projection_stage = 'pre_reservation'
      )
    )
  );

comment on column public.google_calendar_sync_jobs.automation_epoch is
  'Asociacion durable con la activacion que autorizo este unico appointment_id.';
comment on column public.google_calendar_sync_jobs.authorized_google_calendar_id is
  'Calendario exacto autorizado. PATCH y DELETE nunca deben derivarlo de titulo, prefijo ni configuracion posterior.';
comment on column public.google_calendar_sync_jobs.projection_stage is
  'Estado remoto deseado: pre_reservation, confirmed o absent.';
comment on column public.google_calendar_sync_jobs.projected_stage is
  'Ultimo estado remoto confirmado por complete_google_calendar_sync_job.';

create index google_calendar_sync_jobs_automation_due_idx
  on public.google_calendar_sync_jobs (
    automation_epoch,
    authorized_connection_generation,
    available_at,
    updated_at
  )
  where automation_epoch is not null
    and status in ('pending', 'processing');

-- El identificador queda persistido en el job antes del primer I/O. Sigue el
-- mismo contrato que deterministicGoogleEventId en la Edge Function.
create or replace function public.google_calendar_automation_event_id(
  p_appointment_id uuid
)
returns text
language sql
immutable
strict
security definer
set search_path = pg_catalog, public
as $$
  select 'gl' || replace(lower(p_appointment_id::text), '-', '');
$$;

revoke execute on function public.google_calendar_automation_event_id(uuid)
  from public, anon, authenticated, service_role;

-- El binding y la lectura inbound v2 deben seguir vigentes antes de cualquier
-- claim/I/O. Un error de lectura pausa la salida, pero no reescribe la cola.
create or replace function public.google_calendar_automation_scope_is_current(
  p_require_inbound boolean default false
)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.google_calendar_connections connection
    where connection.id = true
      and connection.status = 'connected'
      and connection.automation_enabled
      and connection.automation_epoch is not null
      and connection.automation_activated_at is not null
      and connection.automation_google_account_id = connection.google_account_id
      and connection.automation_google_calendar_id = connection.google_calendar_id
      and connection.automation_connection_generation =
        connection.connection_generation
      and connection.sync_scope_google_account_id is not distinct from
        connection.google_account_id
      and connection.sync_scope_google_calendar_id is not distinct from
        connection.google_calendar_id
      and connection.sync_scope_generation = connection.connection_generation
      and (
        not coalesce(p_require_inbound, false)
        or (
          connection.inbound_first_import_approved_at is not null
          and connection.inbound_sync_state = 'incremental'
          and connection.inbound_sync_token is not null
          and connection.inbound_sync_token_generation =
            connection.connection_generation
          and connection.inbound_sync_contract_version = 2
          and connection.inbound_sync_timezone =
            connection.google_calendar_timezone
          and connection.inbound_coverage_starts_at is not null
          and connection.inbound_coverage_ends_at is not null
          and connection.inbound_coverage_starts_at <= clock_timestamp()
          and connection.inbound_coverage_ends_at > clock_timestamp()
          and connection.last_sync_error is null
        )
      )
  );
$$;

revoke execute on function public.google_calendar_automation_scope_is_current(boolean)
  from public, anon, authenticated, service_role;

-- Devuelve la etapa clinica proyectable. Una asociacion ya emitida conserva el
-- mismo appointment/event ID a traves de confirmacion y reprogramacion. Sin
-- asociacion previa, created_at debe pertenecer estrictamente al epoch actual.
create or replace function public.google_calendar_automation_appointment_stage(
  p_appointment_id uuid,
  p_job_automation_epoch uuid default null,
  p_authorized_google_account_id text default null,
  p_authorized_google_calendar_id text default null,
  p_authorized_connection_generation bigint default null,
  p_now timestamptz default clock_timestamp()
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  appointment_row public.appointments%rowtype;
  connection_row public.google_calendar_connections%rowtype;
  association_matches boolean;
begin
  if p_now is null then return null; end if;

  select appointment.* into appointment_row
  from public.appointments appointment
  where appointment.id = p_appointment_id;
  if not found then return null; end if;

  select connection.* into connection_row
  from public.google_calendar_connections connection
  where connection.id = true
    and connection.status in ('connected', 'reconnect_required')
    and connection.automation_enabled
    and connection.automation_epoch is not null
    and connection.automation_activated_at is not null
    and connection.automation_google_account_id = connection.google_account_id
    and connection.automation_google_calendar_id = connection.google_calendar_id
    and connection.automation_connection_generation =
      connection.connection_generation
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = connection.connection_generation;
  if not found then return null; end if;

  association_matches :=
    p_job_automation_epoch is not distinct from connection_row.automation_epoch
    and p_authorized_google_account_id is not distinct from
      connection_row.automation_google_account_id
    and p_authorized_google_calendar_id is not distinct from
      connection_row.automation_google_calendar_id
    and p_authorized_connection_generation is not distinct from
      connection_row.automation_connection_generation;

  if not association_matches then
    if connection_row.status <> 'connected'
      or appointment_row.created_at < connection_row.automation_activated_at
      or not public.google_calendar_automation_scope_is_current(true)
    then
      return null;
    end if;
  end if;

  -- Un bloqueo convertido conserva el evento manual de Google como la única
  -- ocupación remota. La conversión crea el appointment antes de asociarlo al
  -- external_event dentro de la misma transacción, por lo que enqueue puede
  -- haber creado transitoriamente una fila; claim/authorize vuelven a evaluar
  -- esta relación y nunca proyectan un segundo evento determinístico.
  if exists (
    select 1
    from public.google_calendar_external_events external_event
    where external_event.converted_appointment_id = appointment_row.id
      and external_event.google_calendar_id =
        connection_row.automation_google_calendar_id
      and external_event.connection_generation =
        connection_row.automation_connection_generation
  ) then
    return null;
  end if;

  if appointment_row.status = 'confirmed'
    and (
      appointment_row.created_at >= connection_row.automation_activated_at
      or association_matches
    )
  then
    return 'confirmed';
  end if;

  if appointment_row.status = 'scheduled'
    and appointment_row.created_at >= connection_row.automation_activated_at
    and (
      (
        appointment_row.deposit_status = 'pending'
        and appointment_row.hold_expires_at is not null
        and (
          appointment_row.hold_expires_at > p_now
          or public.appointment_has_timely_deposit_proof_work(
            appointment_row.id,
            p_now
          )
        )
      )
      or (
        appointment_row.deposit_status = 'proof_received'
        and appointment_row.deposit_proof_message_id is not null
        and not appointment_row.deposit_proof_late
      )
    )
  then
    return 'pre_reservation';
  end if;

  return null;
end;
$$;

revoke execute on function public.google_calendar_automation_appointment_stage(
  uuid, uuid, text, text, bigint, timestamptz
) from public, anon, authenticated, service_role;

-- expire_booking_holds conserva deliberadamente un pending vencido mientras
-- existe trabajo causal y puntual sobre un comprobante recibido a tiempo. La
-- disponibilidad debe conservar exactamente el mismo bloqueo durante esa
-- ventana; de otro modo la UI ofreceria un slot que la exclusion de la tabla
-- igualmente impediria reservar.
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

  if exists (
    select 1
    from public.google_calendar_connections connection
    where connection.id = true
      and connection.status in ('connected', 'reconnect_required')
      and not (
        connection.status = 'connected'
        and connection.inbound_sync_state = 'incremental'
        and connection.inbound_sync_token is not null
        and connection.inbound_sync_token_generation =
          connection.connection_generation
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
              and (
                appointment.hold_expires_at > clock_timestamp()
                or public.appointment_has_timely_deposit_proof_work(
                  appointment.id,
                  clock_timestamp()
                )
              )
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

-- Finalize/disconnect no conocen las columnas nuevas. Un retarget real o una
-- desconexion no pueden perder una asociacion remota; una rotacion OAuth de la
-- misma cuenta/calendario, en cambio, conserva el epoch y re-bindea la nueva
-- generacion. La salida sigue pausada hasta completar nuevamente inbound v2.
create or replace function public.clear_stale_google_calendar_automation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  scope_would_invalidate boolean;
  same_scope_generation_rotation boolean;
begin
  scope_would_invalidate :=
    new.status = 'disconnected'
    or new.google_account_id is distinct from old.automation_google_account_id
    or new.google_calendar_id is distinct from old.automation_google_calendar_id;

  same_scope_generation_rotation :=
    old.automation_enabled
    and old.automation_epoch is not null
    and not scope_would_invalidate
    and new.connection_generation is distinct from
      old.automation_connection_generation;

  if old.automation_enabled
    and old.automation_epoch is not null
    and scope_would_invalidate
    and exists (
      select 1
      from public.google_calendar_sync_jobs job
      where job.automation_epoch = old.automation_epoch
        and job.authorized_google_account_id =
          old.automation_google_account_id
        and job.authorized_google_calendar_id =
          old.automation_google_calendar_id
        and job.authorized_connection_generation =
          old.automation_connection_generation
        and (
          job.status in ('pending', 'processing', 'failed')
          or job.projected_stage in ('pre_reservation', 'confirmed')
          or job.projected_operation = 'upsert'
        )
    )
  then
    -- Revocar OAuth o cambiar el scope ahora dejaria eventos propios sin una
    -- asociacion capaz de actualizarlos o retirarlos. Primero debe drenarse la
    -- cola bajo el mismo calendario/epoch; la automatizacion inactiva
    -- historica no entra aqui.
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_DRAIN_REQUIRED'
      using errcode = '55000';
  end if;

  if old.automation_epoch is not null
    and scope_would_invalidate
  then
    -- El job conserva historia solo mientras su asociacion sigue siendo la
    -- autorizada. Al cambiar scope se cancela localmente y se elimina el
    -- binding; jamas se emite un DELETE hacia la cuenta/calendario nuevos.
    update public.google_calendar_sync_jobs job
    set status = 'cancelled',
        processing_started_at = null,
        last_error = 'AUTOMATION_SCOPE_INVALIDATED',
        google_event_id = null,
        google_etag = null,
        projected_operation = null,
        projected_starts_at = null,
        projected_ends_at = null,
        automation_epoch = null,
        authorized_google_account_id = null,
        authorized_google_calendar_id = null,
        authorized_connection_generation = null,
        projection_stage = null,
        projected_stage = null
    where job.automation_epoch = old.automation_epoch
      and job.authorized_google_account_id =
        old.automation_google_account_id
      and job.authorized_google_calendar_id =
        old.automation_google_calendar_id
      and job.authorized_connection_generation =
        old.automation_connection_generation;

    perform set_config(
      'gisela.google_calendar_safe_clear_epoch',
      old.automation_epoch::text,
      true
    );
    new.automation_enabled := false;
    new.automation_epoch := null;
    new.automation_activated_at := null;
    new.automation_google_account_id := null;
    new.automation_google_calendar_id := null;
    new.automation_connection_generation := null;
  elsif same_scope_generation_rotation then
    -- OAuth puede rotar el token y la generacion sin cambiar el dueño remoto.
    -- El AFTER trigger mueve exclusivamente los jobs ya ligados a este epoch;
    -- los jobs legacy NULL nunca se adoptan ni se backfillean.
    perform set_config(
      'gisela.google_calendar_safe_rebind_epoch',
      old.automation_epoch::text,
      true
    );
    new.automation_connection_generation := new.connection_generation;
  end if;
  return new;
end;
$$;

create or replace function public.rebind_google_calendar_automation_generation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.automation_enabled
    and new.automation_enabled
    and old.automation_epoch is not null
    and new.automation_epoch = old.automation_epoch
    and new.google_account_id is not distinct from
      old.automation_google_account_id
    and new.google_calendar_id is not distinct from
      old.automation_google_calendar_id
    and new.connection_generation is distinct from
      old.automation_connection_generation
    and new.automation_connection_generation = new.connection_generation
  then
    update public.google_calendar_sync_jobs job
    set connection_generation = new.connection_generation,
        authorized_connection_generation = new.connection_generation
    where job.automation_epoch = old.automation_epoch
      and job.authorized_google_account_id =
        old.automation_google_account_id
      and job.authorized_google_calendar_id =
        old.automation_google_calendar_id
      and job.authorized_connection_generation =
        old.automation_connection_generation;
  end if;
  return null;
end;
$$;

create trigger google_calendar_automation_generation_rebind
  after update of connection_generation
  on public.google_calendar_connections
  for each row execute function
    public.rebind_google_calendar_automation_generation();

revoke execute on function
  public.rebind_google_calendar_automation_generation()
  from public, anon, authenticated, service_role;

-- Aun service_role de la API es incapaz de encender o retargetear el epoch.
-- Solo una migracion postgres (la que instala el scheduler) puede escribirlo.
create or replace function public.protect_google_calendar_automation_binding()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if session_user <> 'postgres'
    and not (
      tg_op = 'UPDATE'
      and coalesce(
        current_setting(
          'gisela.google_calendar_safe_rebind_epoch', true
        ) = old.automation_epoch::text,
        false
      )
      and old.automation_enabled
      and new.automation_enabled
      and old.automation_epoch is not null
      and new.automation_epoch = old.automation_epoch
      and new.automation_activated_at is not distinct from
        old.automation_activated_at
      and new.automation_google_account_id is not distinct from
        old.automation_google_account_id
      and new.automation_google_calendar_id is not distinct from
        old.automation_google_calendar_id
      and old.google_account_id is not distinct from
        old.automation_google_account_id
      and old.google_calendar_id is not distinct from
        old.automation_google_calendar_id
      and new.google_account_id is not distinct from
        old.automation_google_account_id
      and new.google_calendar_id is not distinct from
        old.automation_google_calendar_id
      and new.connection_generation is distinct from
        old.connection_generation
      and new.automation_connection_generation = new.connection_generation
    )
    and not (
      tg_op = 'UPDATE'
      and coalesce(
        current_setting(
          'gisela.google_calendar_safe_clear_epoch', true
        ) = old.automation_epoch::text,
        false
      )
      and old.automation_enabled
      and old.automation_epoch is not null
      and not new.automation_enabled
      and new.automation_epoch is null
      and new.automation_activated_at is null
      and new.automation_google_account_id is null
      and new.automation_google_calendar_id is null
      and new.automation_connection_generation is null
      and (
        new.status = 'disconnected'
        or new.google_account_id is distinct from
          old.automation_google_account_id
        or new.google_calendar_id is distinct from
          old.automation_google_calendar_id
      )
    )
  then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_BINDING_READ_ONLY'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger ab_google_calendar_automation_binding_guard
  before update of
    automation_enabled,
    automation_epoch,
    automation_activated_at,
    automation_google_account_id,
    automation_google_calendar_id,
    automation_connection_generation
  on public.google_calendar_connections
  for each row execute function public.protect_google_calendar_automation_binding();

revoke execute on function public.protect_google_calendar_automation_binding()
  from public, anon, authenticated, service_role;

create trigger aa_google_calendar_automation_scope_guard
  before update of
    status,
    google_account_id,
    google_calendar_id,
    connection_generation,
    sync_scope_google_account_id,
    sync_scope_google_calendar_id,
    sync_scope_generation
  on public.google_calendar_connections
  for each row execute function public.clear_stale_google_calendar_automation();

revoke execute on function public.clear_stale_google_calendar_automation()
  from public, anon, authenticated, service_role;

create or replace function public.activate_google_calendar_automation(
  p_expected_generation bigint
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  connection_row public.google_calendar_connections%rowtype;
  activated_epoch uuid := gen_random_uuid();
begin
  -- No es una RPC operativa. La migracion que instala el scheduler la invoca
  -- en la misma transaccion; una llamada API (incluso service_role) no puede
  -- dejar la UI en "activa" sin haber instalado la ejecucion automatica.
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if p_expected_generation is null then
    raise exception 'INVALID_CONNECTION_GENERATION' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );
  select connection.* into connection_row
  from public.google_calendar_connections connection
  where connection.id = true
  for update;
  if not found then
    raise exception 'GOOGLE_CALENDAR_NOT_CONNECTED' using errcode = '55000';
  end if;

  if connection_row.automation_enabled then
    if connection_row.automation_connection_generation = p_expected_generation
      and connection_row.automation_google_account_id =
        connection_row.google_account_id
      and connection_row.automation_google_calendar_id =
        connection_row.google_calendar_id
      and connection_row.automation_connection_generation =
        connection_row.connection_generation
    then
      return connection_row.automation_epoch;
    end if;
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_ALREADY_ACTIVATED'
      using errcode = '55000';
  end if;

  if connection_row.automation_epoch is not null
    or connection_row.automation_activated_at is not null
    or connection_row.automation_google_account_id is not null
    or connection_row.automation_google_calendar_id is not null
    or connection_row.automation_connection_generation is not null
  then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_STATE_INVALID'
      using errcode = '55000';
  end if;

  if connection_row.status <> 'connected'
    or connection_row.connection_generation <> p_expected_generation
    or connection_row.sync_scope_google_account_id is distinct from
      connection_row.google_account_id
    or connection_row.sync_scope_google_calendar_id is distinct from
      connection_row.google_calendar_id
    or connection_row.sync_scope_generation <> p_expected_generation
    or connection_row.inbound_first_import_approved_at is null
    or connection_row.inbound_sync_state <> 'incremental'
    or connection_row.inbound_sync_token is null
    or connection_row.inbound_sync_token_generation <> p_expected_generation
    or connection_row.inbound_sync_contract_version <> 2
    or connection_row.inbound_sync_timezone is distinct from
      connection_row.google_calendar_timezone
    or connection_row.inbound_coverage_starts_at is null
    or connection_row.inbound_coverage_ends_at is null
    or connection_row.inbound_coverage_starts_at > clock_timestamp()
    or connection_row.inbound_coverage_ends_at <= clock_timestamp()
    or connection_row.last_sync_completed_at is null
    or connection_row.last_sync_error is not null
    or (
      connection_row.inbound_lease_token is not null
      and connection_row.inbound_lease_expires_at > clock_timestamp()
    )
  then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_NOT_READY'
      using errcode = '55000';
  end if;

  update public.google_calendar_connections connection
  set automation_enabled = true,
      automation_epoch = activated_epoch,
      automation_activated_at = clock_timestamp(),
      automation_google_account_id = connection.google_account_id,
      automation_google_calendar_id = connection.google_calendar_id,
      automation_connection_generation = connection.connection_generation
  where connection.id = true
    and not connection.automation_enabled
    and connection.automation_epoch is null
    and connection.connection_generation = p_expected_generation;
  if not found then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_ACTIVATION_RACE'
      using errcode = '40001';
  end if;

  insert into public.audit_logs (action, entity_type, metadata)
  values (
    'google_calendar.automation_activated',
    'google_calendar',
    jsonb_build_object(
      'automation_epoch', activated_epoch,
      'connection_generation', p_expected_generation
    )
  );
  return activated_epoch;
end;
$$;

revoke execute on function public.activate_google_calendar_automation(bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.activate_google_calendar_automation(bigint)
  to postgres;

create or replace function public.get_google_calendar_automation_gate()
returns table (
  automation_enabled boolean,
  automation_epoch uuid,
  automation_activated_at timestamptz,
  google_calendar_id text,
  connection_generation bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  return query
  -- El scheduler debe poder correr para reparar un token/coverage invalido. El
  -- pull decide luego si la observacion quedo segura; reconcile/claim exigen
  -- scope_is_current(true) y no hacen salida hasta entonces.
  select public.google_calendar_automation_scope_is_current(false)
           and connection.inbound_first_import_approved_at is not null,
         connection.automation_epoch,
         connection.automation_activated_at,
         connection.automation_google_calendar_id,
         connection.automation_connection_generation
  from public.google_calendar_connections connection
  where connection.id = true;
end;
$$;

revoke execute on function public.get_google_calendar_automation_gate()
  from public, anon, authenticated;
grant execute on function public.get_google_calendar_automation_gate()
  to service_role;

-- El trigger de proteccion tambien neutraliza callers legacy de finalize: un
-- INSERT/UPDATE sin epoch no crea ni adopta jobs. Los updates de desconexion o
-- reemplazo de generacion pueden cancelar una asociacion, pero la limpian.
create or replace function public.guard_google_calendar_confirmed_appointment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_stage text;
  deterministic_event_id text;
begin
  -- Rollout/rollback: las filas históricas pueden seguir siendo mantenidas por
  -- finalize/disconnect y conservar sus contratos de almacenamiento. Epoch
  -- NULL es la barrera de autorización: status/reconcile/claim/observe nunca
  -- las consideran para I/O y ningún UPDATE legacy adopta un epoch existente.
  if new.automation_epoch is null
    and (
      tg_op = 'INSERT'
      or (tg_op = 'UPDATE' and old.automation_epoch is null)
    )
  then
    return new;
  end if;

  -- Una fila histórica no puede adquirir autorización por UPDATE, aunque el
  -- caller conozca el binding vigente. Las asociaciones nuevas nacen sólo del
  -- trigger de appointments, en el mismo INSERT que creó la pre-reserva.
  if tg_op = 'UPDATE'
    and old.automation_epoch is null
    and new.automation_epoch is not null
  then
    return null;
  end if;

  -- Los jobs legacy siguen excluidos de reconcile/claim, pero los RPC de
  -- finalize/disconnect deben poder recuperar un lease abandonado y cancelar
  -- la fila. De otro modo un processing historico bloquearia la desconexion
  -- para siempre.
  if tg_op = 'UPDATE'
    and old.automation_epoch is null
    and new.automation_epoch is null
    and (
      (
        old.status = 'processing'
        and new.status = 'pending'
        and new.last_error = 'STALE_CLAIM_RECOVERED'
      )
      or (
        new.status = 'cancelled'
        and new.last_error in (
          'CALENDAR_DISCONNECTED',
          'CONNECTION_GENERATION_REPLACED'
        )
      )
      or (
        new.google_event_id is null
        and new.projected_operation is null
        and new.projected_starts_at is null
        and new.projected_ends_at is null
        and exists (
          select 1
          from public.google_calendar_connections connection
          where connection.id = true
            and (
              connection.status <> 'connected'
              or connection.connection_generation <>
                old.connection_generation
            )
        )
      )
    )
  then
    return new;
  end if;

  if tg_op = 'UPDATE'
    and old.automation_epoch is not null
    and new.status = 'cancelled'
    and new.last_error = 'AUTOMATION_SCOPE_INVALIDATED'
    and new.automation_epoch is null
    and new.authorized_google_account_id is null
    and new.authorized_google_calendar_id is null
    and new.authorized_connection_generation is null
    and new.projection_stage is null
    and new.projected_stage is null
  then
    return new;
  end if;

  if tg_op = 'UPDATE'
    and old.automation_epoch is not null
    and new.automation_epoch is not distinct from old.automation_epoch
    and new.authorized_google_account_id is not distinct from
      old.authorized_google_account_id
    and new.authorized_google_calendar_id is not distinct from
      old.authorized_google_calendar_id
    and new.authorized_connection_generation is not distinct from
      old.authorized_connection_generation
    and new.status = 'cancelled'
    and new.last_error in ('CALENDAR_DISCONNECTED', 'CONNECTION_GENERATION_REPLACED')
  then
    new.automation_epoch := null;
    new.authorized_google_account_id := null;
    new.authorized_google_calendar_id := null;
    new.authorized_connection_generation := null;
    new.projection_stage := null;
    new.projected_stage := null;
    return new;
  end if;

  if new.automation_epoch is null
    or new.authorized_google_account_id is null
    or new.authorized_google_calendar_id is null
    or new.authorized_connection_generation is null
    or not exists (
      select 1
      from public.google_calendar_connections connection
      where connection.id = true
        and connection.status in ('connected', 'reconnect_required')
        and connection.automation_enabled
        and connection.automation_epoch = new.automation_epoch
        and connection.automation_google_account_id =
          new.authorized_google_account_id
        and connection.automation_google_calendar_id =
          new.authorized_google_calendar_id
        and connection.automation_connection_generation =
          new.authorized_connection_generation
        and connection.google_account_id = new.authorized_google_account_id
        and connection.google_calendar_id = new.authorized_google_calendar_id
        and connection.connection_generation =
          new.authorized_connection_generation
        and connection.sync_scope_google_account_id is not distinct from
          connection.google_account_id
        and connection.sync_scope_google_calendar_id is not distinct from
          connection.google_calendar_id
        and connection.sync_scope_generation = connection.connection_generation
    )
  then
    -- RETURN NULL omite tanto INSERT como UPDATE: una funcion legacy no puede
    -- fabricar ni revivir una fila sin autorizacion explicita.
    return null;
  end if;

  deterministic_event_id :=
    public.google_calendar_automation_event_id(new.appointment_id);
  if new.google_event_id is null then
    new.google_event_id := deterministic_event_id;
  elsif new.google_event_id <> deterministic_event_id then
    return null;
  end if;

  current_stage := public.google_calendar_automation_appointment_stage(
    new.appointment_id,
    new.automation_epoch,
    new.authorized_google_account_id,
    new.authorized_google_calendar_id,
    new.authorized_connection_generation,
    clock_timestamp()
  );

  if current_stage = 'pre_reservation'
    and new.projected_stage = 'confirmed'
  then
    current_stage := null;
  end if;
  if tg_op = 'UPDATE'
    and current_stage = 'pre_reservation'
    and old.projected_stage = 'confirmed'
  then
    current_stage := null;
  end if;

  if current_stage is not null then
    new.operation := 'upsert';
    new.projection_stage := current_stage;
  else
    new.operation := 'delete';
    new.projection_stage := 'absent';
  end if;
  return new;
end;
$$;

create or replace function public.enqueue_google_calendar_appointment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  connection_row public.google_calendar_connections%rowtype;
  existing_job public.google_calendar_sync_jobs%rowtype;
  current_stage text;
  external_event_may_exist boolean := false;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );

  select connection.* into connection_row
  from public.google_calendar_connections connection
  where connection.id = true
    and connection.status = 'connected'
    and connection.automation_enabled
    and connection.automation_epoch is not null
    and connection.automation_google_account_id = connection.google_account_id
    and connection.automation_google_calendar_id = connection.google_calendar_id
    and connection.automation_connection_generation =
      connection.connection_generation
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = connection.connection_generation;
  if not found then return new; end if;

  select job.* into existing_job
  from public.google_calendar_sync_jobs job
  where job.appointment_id = new.id
  for update;

  current_stage := public.google_calendar_automation_appointment_stage(
    new.id,
    existing_job.automation_epoch,
    existing_job.authorized_google_account_id,
    existing_job.authorized_google_calendar_id,
    existing_job.authorized_connection_generation,
    clock_timestamp()
  );

  if current_stage = 'pre_reservation'
    and existing_job.projected_stage = 'confirmed'
  then
    -- Una etapa confirmada solo puede permanecer confirmada o pasar a absent.
    -- Nunca se degrada el mismo evento remoto a una pre-reserva.
    current_stage := null;
  end if;

  if current_stage is null then
    if existing_job.appointment_id is null
      or existing_job.automation_epoch is distinct from
        connection_row.automation_epoch
      or existing_job.authorized_google_account_id is distinct from
        connection_row.automation_google_account_id
      or existing_job.authorized_google_calendar_id is distinct from
        connection_row.automation_google_calendar_id
      or existing_job.authorized_connection_generation is distinct from
        connection_row.automation_connection_generation
    then
      return new;
    end if;

    external_event_may_exist := coalesce(
      existing_job.projected_stage in ('pre_reservation', 'confirmed')
      or existing_job.projected_operation = 'upsert'
      or existing_job.attempts > 0
      or (
        existing_job.status = 'processing'
        and existing_job.operation = 'upsert'
      ),
      false
    );
    if not external_event_may_exist then
      delete from public.google_calendar_sync_jobs job
      where job.appointment_id = new.id
        and job.automation_epoch = connection_row.automation_epoch
        and job.authorized_google_account_id =
          connection_row.automation_google_account_id
        and job.authorized_google_calendar_id =
          connection_row.automation_google_calendar_id
        and job.authorized_connection_generation =
          connection_row.automation_connection_generation;
      return new;
    end if;
    current_stage := 'absent';
  end if;

  insert into public.google_calendar_sync_jobs as current_job (
    appointment_id,
    operation,
    desired_version,
    status,
    attempts,
    available_at,
    processing_started_at,
    last_error,
    connection_generation,
    google_event_id,
    automation_epoch,
    authorized_google_account_id,
    authorized_google_calendar_id,
    authorized_connection_generation,
    projection_stage
  ) values (
    new.id,
    case when current_stage = 'absent' then 'delete' else 'upsert' end,
    1,
    'pending',
    0,
    clock_timestamp(),
    null,
    null,
    connection_row.connection_generation,
    public.google_calendar_automation_event_id(new.id),
    connection_row.automation_epoch,
    connection_row.automation_google_account_id,
    connection_row.automation_google_calendar_id,
    connection_row.automation_connection_generation,
    current_stage
  )
  on conflict (appointment_id) do update
  set operation = excluded.operation,
      desired_version = current_job.desired_version + 1,
      status = case
        when current_job.status = 'processing' then 'processing'
        else 'pending'
      end,
      attempts = case
        when current_job.status = 'processing' then current_job.attempts
        else 0
      end,
      available_at = clock_timestamp(),
      processing_started_at = case
        when current_job.status = 'processing'
          then current_job.processing_started_at
        else null
      end,
      last_error = case
        when current_job.status = 'processing'
          and current_job.operation = 'upsert'
          and excluded.operation = 'delete'
        then 'DELETE_AFTER_IN_FLIGHT_UPSERT'
        else null
      end,
      connection_generation = excluded.connection_generation,
      google_event_id = excluded.google_event_id,
      google_etag = case
        when current_job.automation_epoch = excluded.automation_epoch
          then current_job.google_etag
        else null
      end,
      projected_operation = case
        when current_job.automation_epoch = excluded.automation_epoch
          then current_job.projected_operation
        else null
      end,
      projected_starts_at = case
        when current_job.automation_epoch = excluded.automation_epoch
          then current_job.projected_starts_at
        else null
      end,
      projected_ends_at = case
        when current_job.automation_epoch = excluded.automation_epoch
          then current_job.projected_ends_at
        else null
      end,
      projected_stage = case
        when current_job.automation_epoch = excluded.automation_epoch
          then current_job.projected_stage
        else null
      end,
      automation_epoch = excluded.automation_epoch,
      authorized_google_account_id = excluded.authorized_google_account_id,
      authorized_google_calendar_id = excluded.authorized_google_calendar_id,
      authorized_connection_generation =
        excluded.authorized_connection_generation,
      projection_stage = excluded.projection_stage
  where (
    current_job.automation_epoch is null
    or (
      current_job.automation_epoch = excluded.automation_epoch
      and current_job.authorized_google_account_id =
        excluded.authorized_google_account_id
      and current_job.authorized_google_calendar_id =
        excluded.authorized_google_calendar_id
      and current_job.authorized_connection_generation =
        excluded.authorized_connection_generation
    )
  );

  return new;
end;
$$;

drop trigger appointments_google_calendar_sync on public.appointments;
create trigger appointments_google_calendar_sync
  after insert or update of
    starts_at,
    ends_at,
    status,
    contact_id,
    deposit_status,
    hold_expires_at,
    deposit_proof_message_id,
    deposit_proof_late
  on public.appointments
  for each row execute function public.enqueue_google_calendar_appointment();

create or replace function public.enqueue_google_calendar_contact_appointments()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.name is not distinct from new.name then return new; end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );

  insert into public.google_calendar_sync_jobs as current_job (
    appointment_id,
    operation,
    desired_version,
    status,
    attempts,
    available_at,
    processing_started_at,
    last_error,
    connection_generation,
    google_event_id,
    automation_epoch,
    authorized_google_account_id,
    authorized_google_calendar_id,
    authorized_connection_generation,
    projection_stage
  )
  select appointment.id,
         'upsert',
         1,
         'pending',
         0,
         clock_timestamp(),
         null,
         null,
         connection.connection_generation,
         public.google_calendar_automation_event_id(appointment.id),
         connection.automation_epoch,
         connection.automation_google_account_id,
         connection.automation_google_calendar_id,
         connection.automation_connection_generation,
         stage.current_stage
  from public.appointments appointment
  join public.google_calendar_connections connection
    on connection.id = true
   and connection.status = 'connected'
   and connection.automation_enabled
   and connection.automation_google_account_id = connection.google_account_id
   and connection.automation_google_calendar_id = connection.google_calendar_id
   and connection.automation_connection_generation =
     connection.connection_generation
   and connection.sync_scope_google_account_id is not distinct from
     connection.google_account_id
   and connection.sync_scope_google_calendar_id is not distinct from
     connection.google_calendar_id
   and connection.sync_scope_generation = connection.connection_generation
  left join public.google_calendar_sync_jobs existing_job
    on existing_job.appointment_id = appointment.id
  cross join lateral (
    select public.google_calendar_automation_appointment_stage(
      appointment.id,
      existing_job.automation_epoch,
      existing_job.authorized_google_account_id,
      existing_job.authorized_google_calendar_id,
      existing_job.authorized_connection_generation,
      clock_timestamp()
    ) as current_stage
  ) stage
  where appointment.contact_id = new.id
    and appointment.ends_at > clock_timestamp()
    and stage.current_stage is not null
    and (
      existing_job.automation_epoch is null
      or (
        existing_job.automation_epoch = connection.automation_epoch
        and existing_job.authorized_google_account_id =
          connection.automation_google_account_id
        and existing_job.authorized_google_calendar_id =
          connection.automation_google_calendar_id
        and existing_job.authorized_connection_generation =
          connection.automation_connection_generation
      )
    )
  on conflict (appointment_id) do update
  set operation = 'upsert',
      desired_version = current_job.desired_version + 1,
      status = case
        when current_job.status = 'processing' then 'processing'
        else 'pending'
      end,
      attempts = case
        when current_job.status = 'processing' then current_job.attempts
        else 0
      end,
      available_at = clock_timestamp(),
      processing_started_at = case
        when current_job.status = 'processing'
          then current_job.processing_started_at
        else null
      end,
      last_error = null,
      connection_generation = excluded.connection_generation,
      google_event_id = excluded.google_event_id,
      automation_epoch = excluded.automation_epoch,
      authorized_google_account_id = excluded.authorized_google_account_id,
      authorized_google_calendar_id = excluded.authorized_google_calendar_id,
      authorized_connection_generation =
        excluded.authorized_connection_generation,
      projection_stage = excluded.projection_stage
  where current_job.automation_epoch = excluded.automation_epoch
    and current_job.authorized_google_account_id =
      excluded.authorized_google_account_id
    and current_job.authorized_google_calendar_id =
      excluded.authorized_google_calendar_id
    and current_job.authorized_connection_generation =
      excluded.authorized_connection_generation;

  return new;
end;
$$;

create or replace function public.reconcile_google_calendar_sync()
returns table (queued bigint, already_queued bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );
  if not public.google_calendar_automation_scope_is_current(true) then
    return query select 0::bigint, 0::bigint;
    return;
  end if;

  -- Una pre-reserva nunca enviada puede desaparecer sin generar un DELETE. La
  -- asociacion por epoch permite recrear el mismo ID si luego vuelve a un estado
  -- valido; ningun job legacy entra en este DELETE.
  delete from public.google_calendar_sync_jobs job
  using public.appointments appointment,
        public.google_calendar_connections connection
  where connection.id = true
    and job.appointment_id = appointment.id
    and job.automation_epoch = connection.automation_epoch
    and job.authorized_google_account_id =
      connection.automation_google_account_id
    and job.authorized_google_calendar_id =
      connection.automation_google_calendar_id
    and job.authorized_connection_generation =
      connection.automation_connection_generation
    and public.google_calendar_automation_appointment_stage(
      appointment.id,
      job.automation_epoch,
      job.authorized_google_account_id,
      job.authorized_google_calendar_id,
      job.authorized_connection_generation,
      clock_timestamp()
    ) is null
    and job.status <> 'processing'
    and job.attempts = 0
    and job.projected_operation is distinct from 'upsert'
    and job.projected_stage is null;

  return query
  with connection as materialized (
    select current_connection.*
    from public.google_calendar_connections current_connection
    where current_connection.id = true
  ), classified as materialized (
    select appointment.id as appointment_id,
           appointment.created_at,
           job.automation_epoch as job_epoch,
           job.authorized_google_account_id as job_account_id,
           job.authorized_google_calendar_id as job_calendar_id,
           job.authorized_connection_generation as job_generation,
           job.google_event_id,
           job.projected_operation,
           job.projected_stage,
           job.attempts,
           job.status as job_status,
           case
             when job.projected_stage = 'confirmed'
               and public.google_calendar_automation_appointment_stage(
                 appointment.id,
                 job.automation_epoch,
                 job.authorized_google_account_id,
                 job.authorized_google_calendar_id,
                 job.authorized_connection_generation,
                 clock_timestamp()
               ) = 'pre_reservation'
             then null
             else public.google_calendar_automation_appointment_stage(
               appointment.id,
               job.automation_epoch,
               job.authorized_google_account_id,
               job.authorized_google_calendar_id,
               job.authorized_connection_generation,
               clock_timestamp()
             )
           end as current_stage
    from public.appointments appointment
    cross join connection
    left join public.google_calendar_sync_jobs job
      on job.appointment_id = appointment.id
    where appointment.created_at >= connection.automation_activated_at
       or (
         job.automation_epoch = connection.automation_epoch
         and job.authorized_google_account_id =
           connection.automation_google_account_id
         and job.authorized_google_calendar_id =
           connection.automation_google_calendar_id
         and job.authorized_connection_generation =
           connection.automation_connection_generation
       )
  ), candidates as materialized (
    select classified.appointment_id,
           case when classified.current_stage is null
             then 'delete' else 'upsert' end as operation,
           coalesce(classified.current_stage, 'absent') as projection_stage
    from classified, connection
    where classified.current_stage is not null
       or (
         classified.job_epoch = connection.automation_epoch
         and classified.job_account_id = connection.automation_google_account_id
         and classified.job_calendar_id = connection.automation_google_calendar_id
         and classified.job_generation =
           connection.automation_connection_generation
         and (
           classified.projected_stage in ('pre_reservation', 'confirmed')
           or classified.projected_operation = 'upsert'
           or classified.attempts > 0
           or classified.job_status = 'processing'
         )
       )
  ), changed as (
    insert into public.google_calendar_sync_jobs as current_job (
      appointment_id,
      operation,
      desired_version,
      status,
      attempts,
      available_at,
      processing_started_at,
      last_error,
      connection_generation,
      google_event_id,
      automation_epoch,
      authorized_google_account_id,
      authorized_google_calendar_id,
      authorized_connection_generation,
      projection_stage
    )
    select candidate.appointment_id,
           candidate.operation,
           1,
           'pending',
           0,
           clock_timestamp(),
           null,
           null,
           connection.connection_generation,
           public.google_calendar_automation_event_id(candidate.appointment_id),
           connection.automation_epoch,
           connection.automation_google_account_id,
           connection.automation_google_calendar_id,
           connection.automation_connection_generation,
           candidate.projection_stage
    from candidates candidate
    cross join connection
    on conflict (appointment_id) do update
    set operation = excluded.operation,
        desired_version = current_job.desired_version + 1,
        status = case
          when current_job.status = 'processing' then 'processing'
          else 'pending'
        end,
        attempts = case
          when current_job.status = 'processing' then current_job.attempts
          else 0
        end,
        available_at = clock_timestamp(),
        processing_started_at = case
          when current_job.status = 'processing'
            then current_job.processing_started_at
          else null
        end,
        last_error = null,
        connection_generation = excluded.connection_generation,
        google_event_id = excluded.google_event_id,
        automation_epoch = excluded.automation_epoch,
        authorized_google_account_id = excluded.authorized_google_account_id,
        authorized_google_calendar_id = excluded.authorized_google_calendar_id,
        authorized_connection_generation =
          excluded.authorized_connection_generation,
        projection_stage = excluded.projection_stage
    where (
      current_job.automation_epoch is null
      or (
        current_job.automation_epoch = excluded.automation_epoch
        and current_job.authorized_google_account_id =
          excluded.authorized_google_account_id
        and current_job.authorized_google_calendar_id =
          excluded.authorized_google_calendar_id
        and current_job.authorized_connection_generation =
          excluded.authorized_connection_generation
      )
    )
      and (
        current_job.operation is distinct from excluded.operation
        or current_job.projection_stage is distinct from
          excluded.projection_stage
        or current_job.connection_generation is distinct from
          excluded.connection_generation
        or current_job.status = 'cancelled'
        or (
          excluded.operation = 'upsert'
          and current_job.status = 'succeeded'
          and current_job.updated_at < clock_timestamp() - interval '1 hour'
        )
      )
    returning appointment_id
  )
  select (select count(*) from changed),
         (select count(*) from candidates) - (select count(*) from changed);
end;
$$;

drop function public.claim_google_calendar_sync_jobs(integer, bigint);
create or replace function public.claim_google_calendar_sync_jobs(
  p_limit integer,
  p_expected_generation bigint,
  p_projection_contract_version integer
)
returns table (
  job_id uuid,
  appointment_id uuid,
  operation text,
  desired_version bigint,
  attempts integer,
  starts_at timestamptz,
  ends_at timestamptz,
  patient_name text,
  timezone text,
  connection_generation bigint,
  google_etag text,
  google_event_id text,
  automation_epoch uuid,
  projection_stage text,
  projected_stage text,
  authorized_google_calendar_id text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if p_projection_contract_version is distinct from 2 then
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );
  if not public.google_calendar_automation_scope_is_current(true)
    or not exists (
      select 1
      from public.google_calendar_connections connection
      where connection.id = true
        and connection.connection_generation = p_expected_generation
        and connection.automation_connection_generation = p_expected_generation
    )
  then
    return;
  end if;

  update public.google_calendar_sync_jobs job
  set status = 'pending',
      processing_started_at = null,
      available_at = clock_timestamp(),
      last_error = 'STALE_CLAIM_RECOVERED'
  from public.google_calendar_connections connection
  where connection.id = true
    and job.status = 'processing'
    and job.automation_epoch = connection.automation_epoch
    and job.authorized_google_account_id =
      connection.automation_google_account_id
    and job.authorized_google_calendar_id =
      connection.automation_google_calendar_id
    and job.authorized_connection_generation = p_expected_generation
    and (
      job.processing_started_at is null
      or job.processing_started_at < clock_timestamp() - interval '10 minutes'
    );

  return query
  with due as (
    select job.id, job.appointment_id
    from public.google_calendar_sync_jobs job
    join public.appointments appointment
      on appointment.id = job.appointment_id
    join public.google_calendar_connections current_connection
      on current_connection.id = true
     and current_connection.automation_epoch = job.automation_epoch
     and current_connection.automation_google_account_id =
       job.authorized_google_account_id
     and current_connection.automation_google_calendar_id =
       job.authorized_google_calendar_id
     and current_connection.automation_connection_generation =
       job.authorized_connection_generation
    cross join lateral (
      select public.google_calendar_automation_appointment_stage(
        appointment.id,
        job.automation_epoch,
        job.authorized_google_account_id,
        job.authorized_google_calendar_id,
        job.authorized_connection_generation,
        clock_timestamp()
      ) as current_stage
    ) stage
    where job.status = 'pending'
      and job.available_at <= clock_timestamp()
      and job.connection_generation = p_expected_generation
      and job.authorized_connection_generation = p_expected_generation
      and job.google_event_id is not null
      and (
        (
          job.operation = 'upsert'
          and job.projection_stage = stage.current_stage
          and stage.current_stage in ('pre_reservation', 'confirmed')
        )
        or (
          job.operation = 'delete'
          and job.projection_stage = 'absent'
          and stage.current_stage is null
        )
      )
      and not exists (
          select 1 from public.google_calendar_sync_conflicts conflict
          where conflict.appointment_id = job.appointment_id
            and conflict.status = 'pending'
            and conflict.connection_generation = p_expected_generation
      )
      and not (
        job.operation = 'upsert'
        and exists (
          select 1
          from public.google_calendar_external_events external_event
          where external_event.connection_generation = p_expected_generation
            and external_event.google_calendar_id =
              current_connection.automation_google_calendar_id
            and (
              (
                external_event.kind = 'unsupported'
                and external_event.status = 'active'
              )
              or (
                external_event.kind = 'block'
                and (
                  external_event.status = 'active'
                  or (
                    external_event.status = 'converted'
                    and external_event.external_cleanup_status in ('pending', 'failed')
                  )
                )
                and tstzrange(
                  external_event.starts_at, external_event.ends_at, '[)'
                ) && tstzrange(
                  appointment.starts_at, appointment.ends_at, '[)'
                )
              )
            )
        )
      )
    order by job.available_at, job.updated_at
    for update of job skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 20))
  ), claimed as (
    update public.google_calendar_sync_jobs job
    set status = 'processing',
        attempts = job.attempts + 1,
        processing_started_at = clock_timestamp()
    from due
    where job.id = due.id
    returning job.*
  )
  select claimed.id,
         claimed.appointment_id,
         claimed.operation,
         claimed.desired_version,
         claimed.attempts,
         appointment.starts_at,
         appointment.ends_at,
         contact.name,
         settings.timezone,
         claimed.connection_generation,
         claimed.google_etag,
         claimed.google_event_id,
         claimed.automation_epoch,
         claimed.projection_stage,
         claimed.projected_stage,
         claimed.authorized_google_calendar_id
  from claimed
  join public.appointments appointment
    on appointment.id = claimed.appointment_id
  join public.contacts contact on contact.id = appointment.contact_id
  join public.app_settings settings on settings.id = true;
end;
$$;

-- El worker anterior no conoce epoch/stage/fingerprint. Aunque los wrappers de
-- complete/fail sean fail-closed, entregarle un job ya autorizaría el I/O
-- remoto. La firma legacy se conserva durante rollout pero no reclama filas.
create or replace function public.claim_google_calendar_sync_jobs(
  p_limit integer default 10,
  p_expected_generation bigint default null
)
returns table (
  job_id uuid,
  appointment_id uuid,
  operation text,
  desired_version bigint,
  attempts integer,
  starts_at timestamptz,
  ends_at timestamptz,
  patient_name text,
  timezone text,
  connection_generation bigint,
  google_etag text,
  google_event_id text,
  automation_epoch uuid,
  projection_stage text,
  projected_stage text,
  authorized_google_calendar_id text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  return;
end;
$$;

create or replace function public.authorize_google_calendar_sync_job(
  p_job_id uuid,
  p_claimed_version bigint,
  p_automation_epoch uuid,
  p_expected_stage text
)
returns table (
  authorized boolean,
  google_calendar_id text,
  google_event_id text,
  operation text,
  projection_stage text,
  connection_generation bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if p_expected_stage not in ('pre_reservation', 'confirmed', 'absent') then
    raise exception 'INVALID_PROJECTION_STAGE' using errcode = '22023';
  end if;

  return query
  with authorized_job as (
    select job.*
    from public.google_calendar_sync_jobs job
    join public.google_calendar_connections connection
      on connection.id = true
     and connection.automation_enabled
     and connection.automation_epoch = job.automation_epoch
     and connection.automation_google_account_id =
       job.authorized_google_account_id
     and connection.automation_google_calendar_id =
       job.authorized_google_calendar_id
     and connection.automation_connection_generation =
       job.authorized_connection_generation
     and connection.google_account_id = job.authorized_google_account_id
     and connection.google_calendar_id = job.authorized_google_calendar_id
     and connection.connection_generation =
       job.authorized_connection_generation
     and connection.sync_scope_google_account_id is not distinct from
       connection.google_account_id
     and connection.sync_scope_google_calendar_id is not distinct from
       connection.google_calendar_id
     and connection.sync_scope_generation = connection.connection_generation
    cross join lateral (
      select public.google_calendar_automation_appointment_stage(
        job.appointment_id,
        job.automation_epoch,
        job.authorized_google_account_id,
        job.authorized_google_calendar_id,
        job.authorized_connection_generation,
        clock_timestamp()
      ) as current_stage
    ) stage
    where job.id = p_job_id
      and job.status = 'processing'
      and job.desired_version = p_claimed_version
      and job.automation_epoch = p_automation_epoch
      and job.projection_stage = p_expected_stage
      and job.google_event_id is not null
      and public.google_calendar_automation_scope_is_current(true)
      and not coalesce(
        job.projected_stage = 'confirmed'
        and p_expected_stage = 'pre_reservation',
        false
      )
      and not exists (
        select 1
        from public.google_calendar_sync_conflicts conflict
        where conflict.appointment_id = job.appointment_id
          and conflict.status = 'pending'
          and conflict.connection_generation = job.connection_generation
      )
      and (
        (
          job.operation = 'upsert'
          and stage.current_stage = p_expected_stage
          and p_expected_stage in ('pre_reservation', 'confirmed')
        )
        or (
          job.operation = 'delete'
          and stage.current_stage is null
          and p_expected_stage = 'absent'
        )
      )
  )
  select exists (select 1 from authorized_job),
         (select job.authorized_google_calendar_id from authorized_job job),
         (select job.google_event_id from authorized_job job),
         (select job.operation from authorized_job job),
         (select job.projection_stage from authorized_job job),
         (select job.connection_generation from authorized_job job);
end;
$$;

revoke execute on function public.authorize_google_calendar_sync_job(
  uuid, bigint, uuid, text
) from public, anon, authenticated;
grant execute on function public.authorize_google_calendar_sync_job(
  uuid, bigint, uuid, text
) to service_role;

create or replace function public.complete_google_calendar_sync_job(
  p_job_id uuid,
  p_claimed_version bigint,
  p_google_event_id text,
  p_connection_generation bigint,
  p_google_etag text,
  p_projected_starts_at timestamptz,
  p_projected_ends_at timestamptz,
  p_automation_epoch uuid,
  p_projection_stage text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  completed boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  update public.google_calendar_sync_jobs job
  set status = 'succeeded',
      processing_started_at = null,
      google_event_id = job.google_event_id,
      google_etag = case when job.operation = 'delete' then null
        else nullif(trim(coalesce(p_google_etag, '')), '') end,
      projected_operation = job.operation,
      projected_starts_at = case when job.operation = 'delete' then null
        else p_projected_starts_at end,
      projected_ends_at = case when job.operation = 'delete' then null
        else p_projected_ends_at end,
      projected_stage = job.projection_stage,
      last_error = null
  where job.id = p_job_id
    and job.status = 'processing'
    and job.desired_version = p_claimed_version
    and job.connection_generation = p_connection_generation
    and job.authorized_connection_generation = p_connection_generation
    and job.automation_epoch = p_automation_epoch
    and job.projection_stage = p_projection_stage
    and job.google_event_id = p_google_event_id
    and exists (
      select 1
      from public.authorize_google_calendar_sync_job(
        p_job_id,
        p_claimed_version,
        p_automation_epoch,
        p_projection_stage
      ) authorized_job_result
      where authorized_job_result.authorized
        and authorized_job_result.google_event_id = p_google_event_id
    );
  completed := found;

  if not completed then
    update public.google_calendar_sync_jobs job
    set status = 'pending',
        processing_started_at = null,
        available_at = clock_timestamp(),
        -- Google ya respondio para la version reclamada. Aunque desired_version
        -- haya avanzado durante el I/O, esta evidencia no se pierde: la version
        -- nueva queda pending y podra PATCH/DELETE con el ETag real.
        google_etag = case
          when p_projection_stage = 'absent' then null
          else nullif(trim(coalesce(p_google_etag, '')), '')
        end,
        projected_operation = case
          when p_projection_stage = 'absent' then 'delete'
          else 'upsert'
        end,
        projected_starts_at = case
          when p_projection_stage = 'absent' then null
          else p_projected_starts_at
        end,
        projected_ends_at = case
          when p_projection_stage = 'absent' then null
          else p_projected_ends_at
        end,
        projected_stage = p_projection_stage
    where job.id = p_job_id
      and job.status = 'processing'
      and job.connection_generation = p_connection_generation
      and job.authorized_connection_generation = p_connection_generation
      and job.automation_epoch = p_automation_epoch
      and job.google_event_id = p_google_event_id;
  else
    update public.google_calendar_connections connection
    set last_synced_at = clock_timestamp(),
        last_error = null
    where connection.id = true
      and connection.status = 'connected'
      and connection.automation_epoch = p_automation_epoch
      and connection.connection_generation = p_connection_generation;
  end if;
  return completed;
end;
$$;

-- Wrappers de rollout. Un worker anterior no posee epoch/stage y por lo tanto
-- no puede completar una proyeccion autorizada por el contrato nuevo.
create or replace function public.complete_google_calendar_sync_job(
  p_job_id uuid,
  p_claimed_version bigint,
  p_google_event_id text,
  p_connection_generation bigint,
  p_google_etag text,
  p_projected_starts_at timestamptz,
  p_projected_ends_at timestamptz
)
returns boolean
language sql
security definer
set search_path = pg_catalog, public
as $$
  select false;
$$;

create or replace function public.complete_google_calendar_sync_job(
  p_job_id uuid,
  p_claimed_version bigint,
  p_google_event_id text,
  p_connection_generation bigint
)
returns boolean
language sql
security definer
set search_path = pg_catalog, public
as $$
  select false;
$$;

create or replace function public.fail_google_calendar_sync_job(
  p_job_id uuid,
  p_claimed_version bigint,
  p_connection_generation bigint,
  p_error_code text,
  p_retry_at timestamptz,
  p_terminal boolean,
  p_automation_epoch uuid,
  p_projection_stage text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed boolean := false;
  clean_error text := upper(trim(coalesce(p_error_code, '')));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if clean_error !~ '^[A-Z0-9_]{3,100}$'
    or p_retry_at is null
    or p_projection_stage not in ('pre_reservation', 'confirmed', 'absent')
  then
    raise exception 'INVALID_SYNC_FAILURE' using errcode = '22023';
  end if;

  update public.google_calendar_sync_jobs job
  set status = case when p_terminal then 'failed' else 'pending' end,
      processing_started_at = null,
      available_at = case when p_terminal then job.available_at else p_retry_at end,
      last_error = clean_error
  where job.id = p_job_id
    and job.status = 'processing'
    and job.desired_version = p_claimed_version
    and job.connection_generation = p_connection_generation
    and job.authorized_connection_generation = p_connection_generation
    and job.automation_epoch = p_automation_epoch
    and job.projection_stage = p_projection_stage
    and exists (
      select 1
      from public.google_calendar_connections connection
      where connection.id = true
        and connection.automation_epoch = p_automation_epoch
        and connection.automation_connection_generation =
          p_connection_generation
    );
  changed := found;

  if not changed then
    update public.google_calendar_sync_jobs job
    set status = 'pending',
        processing_started_at = null,
        available_at = clock_timestamp()
    where job.id = p_job_id
      and job.status = 'processing'
      and job.connection_generation = p_connection_generation
      and job.automation_epoch = p_automation_epoch;
  elsif p_terminal then
    update public.google_calendar_connections connection
    set last_error = clean_error
    where connection.id = true
      and connection.status = 'connected'
      and connection.automation_epoch = p_automation_epoch
      and connection.connection_generation = p_connection_generation;
  end if;
  return changed;
end;
$$;

create or replace function public.fail_google_calendar_sync_job(
  p_job_id uuid,
  p_claimed_version bigint,
  p_connection_generation bigint,
  p_error_code text,
  p_retry_at timestamptz,
  p_terminal boolean
)
returns boolean
language sql
security definer
set search_path = pg_catalog, public
as $$
  select false;
$$;

-- Rollout/rollback read-only: la Function anterior intentaba borrar el evento
-- manual luego de una conversión. Desde este contrato ningún caller obtiene
-- esa autorización; los estados históricos se conservan sin mutación.
create or replace function public.claim_google_calendar_external_cleanup(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_limit integer default 3
)
returns table (google_event_id text, appointment_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  return;
end;
$$;

-- La marca remota por si sola no alcanza: observar un evento administrado
-- requiere la asociacion local exacta que autorizo su escritura.
create or replace function public.observe_google_calendar_managed_event(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_google_event_id text,
  p_appointment_id uuid,
  p_cancelled boolean,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_google_updated_at timestamptz,
  p_google_etag text,
  p_automation_epoch uuid,
  p_remote_projection_stage text,
  p_payload_fingerprint_valid boolean
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  appointment_row public.appointments%rowtype;
  job_row public.google_calendar_sync_jobs%rowtype;
  conflict_kind text;
  matches_appointment boolean;
  matches_projection boolean;
  observed_etag text := nullif(trim(coalesce(p_google_etag, '')), '');
  metadata_changed boolean;
  trusted_remote_payload boolean;
  matches_desired boolean;
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );

  if p_automation_epoch is null
    or (
      p_remote_projection_stage is null
      and not coalesce(p_cancelled, false)
    )
    or (
      p_remote_projection_stage is not null
      and p_remote_projection_stage not in ('pre_reservation', 'confirmed')
    )
  then
    return 'ignored_unknown_appointment';
  end if;

  select job.* into job_row
  from public.google_calendar_sync_jobs job
  join public.google_calendar_connections connection
    on connection.id = true
   and connection.status = 'connected'
   and connection.connection_generation = p_expected_generation
   and connection.automation_enabled
   and connection.automation_epoch = p_automation_epoch
   and connection.automation_epoch = job.automation_epoch
   and connection.automation_google_account_id =
     job.authorized_google_account_id
   and connection.automation_google_calendar_id =
     job.authorized_google_calendar_id
   and connection.automation_connection_generation =
     job.authorized_connection_generation
   and connection.google_account_id = job.authorized_google_account_id
   and connection.google_calendar_id = job.authorized_google_calendar_id
   and connection.sync_scope_google_account_id is not distinct from
     connection.google_account_id
   and connection.sync_scope_google_calendar_id is not distinct from
     connection.google_calendar_id
   and connection.sync_scope_generation = connection.connection_generation
  where job.appointment_id = p_appointment_id
    and job.google_event_id = p_google_event_id
    and job.connection_generation = p_expected_generation
  for update of job;
  if not found then return 'ignored_unknown_appointment'; end if;

  trusted_remote_payload :=
    not coalesce(p_cancelled, false)
    and coalesce(p_payload_fingerprint_valid, false)
    and observed_etag is not null
    and p_starts_at is not null
    and p_ends_at is not null
    and p_starts_at < p_ends_at;
  metadata_changed := not trusted_remote_payload;

  select appointment.* into appointment_row
  from public.appointments appointment
  where appointment.id = p_appointment_id;
  if not found then return 'ignored_unknown_appointment'; end if;

  -- Se compara primero contra el baseline. Después se conserva el ETag que la
  -- persona revisará, para que un restore posterior use If-Match exacto. Un
  -- payload con fingerprint íntegro es además evidencia suficiente para
  -- recuperar un POST/PATCH cuyo response se perdió: se adopta sólo como
  -- baseline y la versión local vigente continúa pending si difiere.
  if coalesce(p_cancelled, false) or observed_etag is not null then
    update public.google_calendar_sync_jobs job
    set google_etag = observed_etag,
        projected_operation = case
          when trusted_remote_payload then 'upsert'
          else job.projected_operation
        end,
        projected_starts_at = case
          when trusted_remote_payload then p_starts_at
          else job.projected_starts_at
        end,
        projected_ends_at = case
          when trusted_remote_payload then p_ends_at
          else job.projected_ends_at
        end,
        projected_stage = case
          when trusted_remote_payload then p_remote_projection_stage
          else job.projected_stage
        end
    where job.appointment_id = p_appointment_id
      and job.google_event_id = p_google_event_id
      and job.automation_epoch = p_automation_epoch
      and job.authorized_connection_generation = p_expected_generation;
  end if;

  if appointment_row.status not in ('scheduled', 'confirmed') then
    if coalesce(p_cancelled, false)
      and (
        job_row.projected_operation = 'delete'
        or (
          job_row.operation = 'delete'
          and job_row.status in ('pending', 'processing')
        )
      )
    then
      return 'in_sync';
    elsif trusted_remote_payload
      and job_row.operation = 'delete'
      and job_row.projection_stage = 'absent'
    then
      return 'pending_push';
    end if;

    -- Un evento todavía presente pero ya editado por una persona nunca puede
    -- prestar su ETag a un DELETE local silencioso. La observación queda ligada
    -- a un conflicto pendiente y claim/authorize bloquean toda salida.
    conflict_kind := 'metadata_changed';
  elsif coalesce(p_cancelled, false) then
    if job_row.projected_operation = 'delete'
      or (
        job_row.operation = 'delete'
        and job_row.status in ('pending', 'processing')
      )
    then
      return 'in_sync';
    end if;
    conflict_kind := 'cancellation_requested';
  else
    matches_appointment :=
      p_starts_at is not distinct from appointment_row.starts_at
      and p_ends_at is not distinct from appointment_row.ends_at;
    matches_projection :=
      job_row.projected_starts_at is not null
      and p_starts_at is not distinct from job_row.projected_starts_at
      and p_ends_at is not distinct from job_row.projected_ends_at
      and p_remote_projection_stage is not distinct from
        job_row.projected_stage;
    matches_desired :=
      matches_appointment
      and job_row.operation = 'upsert'
      and p_remote_projection_stage is not distinct from
        job_row.projection_stage;

    if trusted_remote_payload then
      -- El hash cubre todo el payload administrado, incluida identidad, rango
      -- y stage. Si refleja una versión anterior, se conserva como baseline
      -- para que la versión local actual PATCH/DELETE el mismo event ID.
      if matches_desired then
        return 'in_sync';
      end if;
      return 'pending_push';
    elsif not matches_appointment and not matches_projection then
      if p_starts_at is null
        or p_ends_at is null
        or p_starts_at >= p_ends_at
      then
        -- La asociación local exacta ya prueba que éste no es un evento
        -- externo cualquiera. Un payload incompleto es ambiguo y debe frenar
        -- PATCH/DELETE hasta revisión, no desaparecer como "ignored".
        conflict_kind := 'metadata_changed';
      else
        conflict_kind := 'reschedule_requested';
      end if;
    elsif metadata_changed then
      conflict_kind := 'metadata_changed';
    elsif matches_appointment then
      return 'in_sync';
    else
      return 'pending_push';
    end if;
  end if;

  insert into public.google_calendar_sync_conflicts as current_conflict (
    appointment_id,
    google_event_id,
    kind,
    status,
    proposed_starts_at,
    proposed_ends_at,
    observed_starts_at,
    observed_ends_at,
    google_updated_at,
    connection_generation
  ) values (
    p_appointment_id,
    p_google_event_id,
    conflict_kind,
    'pending',
    case when conflict_kind = 'reschedule_requested' then p_starts_at end,
    case when conflict_kind = 'reschedule_requested' then p_ends_at end,
    appointment_row.starts_at,
    appointment_row.ends_at,
    p_google_updated_at,
    p_expected_generation
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
     or current_conflict.proposed_starts_at is distinct from
       excluded.proposed_starts_at
     or current_conflict.proposed_ends_at is distinct from
       excluded.proposed_ends_at
     or current_conflict.google_updated_at is distinct from
       excluded.google_updated_at;

  return case when found then 'conflict_recorded' else 'conflict_pending' end;
end;
$$;

-- Compatibilidad fail-closed durante el rollout: sin la prueba criptográfica
-- del payload el worker anterior puede detectar conflictos, pero nunca adoptar
-- una respuesta perdida como si hubiese sido emitida por esta versión.
create or replace function public.observe_google_calendar_managed_event(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_google_event_id text,
  p_appointment_id uuid,
  p_cancelled boolean,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_google_updated_at timestamptz,
  p_google_etag text,
  p_automation_epoch uuid,
  p_remote_projection_stage text
)
returns text
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.observe_google_calendar_managed_event(
    p_expected_generation,
    p_lease_token,
    p_google_event_id,
    p_appointment_id,
    p_cancelled,
    p_starts_at,
    p_ends_at,
    p_google_updated_at,
    p_google_etag,
    p_automation_epoch,
    p_remote_projection_stage,
    false
  );
$$;

-- Callers legacy carecen del epoch remoto/local y no pueden autorizar una
-- observacion. El worker nuevo reclasifica este resultado como evento externo.
create or replace function public.observe_google_calendar_managed_event(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_google_event_id text,
  p_appointment_id uuid,
  p_cancelled boolean,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_google_updated_at timestamptz,
  p_google_etag text
)
returns text
language sql
security definer
set search_path = pg_catalog, public
as $$
  select 'ignored_unknown_appointment'::text;
$$;

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
language sql
security definer
set search_path = pg_catalog, public
as $$
  select 'ignored_unknown_appointment'::text;
$$;

create or replace function public.google_calendar_managed_event_is_current(
  p_google_event_id text,
  p_appointment_id uuid,
  p_automation_epoch uuid
)
returns boolean
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  return exists (
    select 1
    from public.google_calendar_sync_jobs job
    join public.google_calendar_connections connection
      on connection.id = true
     and connection.status = 'connected'
     and connection.automation_enabled
     and connection.automation_epoch = p_automation_epoch
     and connection.automation_epoch = job.automation_epoch
     and connection.automation_google_account_id =
       job.authorized_google_account_id
     and connection.automation_google_calendar_id =
       job.authorized_google_calendar_id
     and connection.automation_connection_generation =
       job.authorized_connection_generation
     and connection.google_account_id = job.authorized_google_account_id
     and connection.google_calendar_id = job.authorized_google_calendar_id
     and connection.connection_generation = job.authorized_connection_generation
     and connection.sync_scope_google_account_id is not distinct from
       connection.google_account_id
     and connection.sync_scope_google_calendar_id is not distinct from
       connection.google_calendar_id
     and connection.sync_scope_generation = connection.connection_generation
    where job.google_event_id = p_google_event_id
      and job.appointment_id = p_appointment_id
      and job.automation_epoch = p_automation_epoch
  );
end;
$$;

-- Los lookups inbound tampoco adoptan mappings de una cuenta/epoch anterior.
create or replace function public.google_calendar_managed_appointment_for_event(
  p_google_event_id text
)
returns uuid
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select job.appointment_id
  from public.google_calendar_sync_jobs job
  join public.google_calendar_connections connection
    on connection.id = true
   and connection.automation_enabled
   and connection.automation_epoch = job.automation_epoch
   and connection.automation_google_account_id =
     job.authorized_google_account_id
   and connection.automation_google_calendar_id =
     job.authorized_google_calendar_id
   and connection.automation_connection_generation =
     job.authorized_connection_generation
   and connection.google_account_id = job.authorized_google_account_id
   and connection.google_calendar_id = job.authorized_google_calendar_id
   and connection.connection_generation = job.authorized_connection_generation
  where job.google_event_id = p_google_event_id
  limit 1;
$$;

create or replace function public.list_google_calendar_full_resync_managed_candidates(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_after_appointment_id uuid default null,
  p_limit integer default 100
)
returns table (
  appointment_id uuid,
  google_event_id text,
  remote_known boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );

  return query
  select appointment.id,
         job.google_event_id,
         coalesce(
           job.projected_stage in ('pre_reservation', 'confirmed')
           and job.projected_operation = 'upsert'
           and job.projected_starts_at is not null
           and job.projected_ends_at is not null
           and job.projected_starts_at < job.projected_ends_at,
           false
         )
  from public.google_calendar_sync_jobs job
  join public.appointments appointment on appointment.id = job.appointment_id
  join public.google_calendar_connections connection
    on connection.id = true
   and connection.status = 'connected'
   and connection.connection_generation = p_expected_generation
   and connection.automation_enabled
   and connection.automation_epoch = job.automation_epoch
   and connection.automation_google_account_id =
     job.authorized_google_account_id
   and connection.automation_google_calendar_id =
     job.authorized_google_calendar_id
   and connection.automation_connection_generation =
     job.authorized_connection_generation
   and connection.sync_scope_google_account_id is not distinct from
     connection.google_account_id
   and connection.sync_scope_google_calendar_id is not distinct from
     connection.google_calendar_id
   and connection.sync_scope_generation = connection.connection_generation
  where job.connection_generation = p_expected_generation
    and job.projection_stage in ('pre_reservation', 'confirmed')
    and appointment.status in ('scheduled', 'confirmed')
    and appointment.ends_at > clock_timestamp()
    and (
      p_after_appointment_id is null
      or appointment.id > p_after_appointment_id
    )
  order by appointment.id
  limit greatest(1, least(coalesce(p_limit, 100), 200));
end;
$$;

drop function public.google_calendar_status();
create or replace function public.google_calendar_status()
returns table (
  connected boolean,
  status text,
  selection_pending boolean,
  google_account_email text,
  google_calendar_name text,
  google_calendar_timezone text,
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
  pending_conflict_count bigint,
  automation_enabled boolean,
  automation_activated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  perform public.purge_expired_google_calendar_connection_candidate();

  return query
  select connection.status = 'connected',
         connection.status,
         exists (
           select 1
           from public.google_calendar_connection_candidates candidate
           join public.google_calendar_connections current_connection
             on current_connection.id = true
            and current_connection.connection_generation =
              candidate.connection_generation
            and current_connection.oauth_attempt_generation =
              candidate.oauth_attempt_generation
           where candidate.id = true
             and candidate.expires_at > clock_timestamp()
         ),
         connection.google_account_email,
         connection.google_calendar_name,
         connection.google_calendar_timezone,
         connection.last_synced_at,
         connection.last_checked_at,
         connection.last_sync_completed_at,
         connection.last_sync_summary,
         connection.last_sync_error,
         connection.last_error,
         connection.inbound_sync_state,
         connection.inbound_first_import_approved_at is not null
           and connection.sync_scope_google_account_id is not distinct from
             connection.google_account_id
           and connection.sync_scope_google_calendar_id is not distinct from
             connection.google_calendar_id
           and connection.sync_scope_generation = connection.connection_generation,
         (select count(*)
          from public.google_calendar_sync_jobs job
          where job.status in ('pending', 'processing')
            and job.automation_epoch = connection.automation_epoch
            and job.authorized_google_account_id =
              connection.automation_google_account_id
            and job.authorized_google_calendar_id =
              connection.automation_google_calendar_id
            and job.authorized_connection_generation =
              connection.automation_connection_generation),
         (select count(*)
          from public.google_calendar_sync_jobs job
          where job.status = 'failed'
            and job.automation_epoch = connection.automation_epoch
            and job.authorized_google_account_id =
              connection.automation_google_account_id
            and job.authorized_google_calendar_id =
              connection.automation_google_calendar_id
            and job.authorized_connection_generation =
              connection.automation_connection_generation),
         (select count(*)
          from public.google_calendar_external_events event
          where event.kind = 'block'
            and (
              event.status = 'active'
              or (
                event.status = 'converted'
                and event.external_cleanup_status in ('pending', 'failed')
              )
            )
            and event.google_calendar_id = connection.google_calendar_id
            and event.connection_generation = connection.connection_generation),
         (select count(*)
          from public.google_calendar_external_events event
          where event.kind = 'unsupported'
            and event.status = 'active'
            and event.google_calendar_id = connection.google_calendar_id
            and event.connection_generation = connection.connection_generation),
         (select count(*)
          from public.google_calendar_sync_conflicts conflict
          where conflict.status = 'pending'
            and conflict.connection_generation = connection.connection_generation),
         public.google_calendar_automation_scope_is_current(false),
         case when public.google_calendar_automation_scope_is_current(false)
           then connection.automation_activated_at else null end
  from public.google_calendar_connections connection
  where connection.id = true;
end;
$$;

revoke execute on function public.google_calendar_status()
  from public, anon, authenticated;
grant execute on function public.google_calendar_status() to service_role;

revoke execute on function public.guard_google_calendar_confirmed_appointment()
  from public, anon, authenticated, service_role;
revoke execute on function public.enqueue_google_calendar_appointment()
  from public, anon, authenticated, service_role;
revoke execute on function public.enqueue_google_calendar_contact_appointments()
  from public, anon, authenticated, service_role;
revoke execute on function public.reconcile_google_calendar_sync()
  from public, anon, authenticated;
grant execute on function public.reconcile_google_calendar_sync()
  to service_role;
revoke execute on function public.claim_google_calendar_sync_jobs(integer, bigint)
  from public, anon, authenticated;
grant execute on function public.claim_google_calendar_sync_jobs(integer, bigint)
  to service_role;
revoke execute on function public.claim_google_calendar_sync_jobs(
  integer, bigint, integer
) from public, anon, authenticated;
grant execute on function public.claim_google_calendar_sync_jobs(
  integer, bigint, integer
) to service_role;
revoke execute on function public.complete_google_calendar_sync_job(
  uuid, bigint, text, bigint, text, timestamptz, timestamptz, uuid, text
) from public, anon, authenticated;
grant execute on function public.complete_google_calendar_sync_job(
  uuid, bigint, text, bigint, text, timestamptz, timestamptz, uuid, text
) to service_role;
revoke execute on function public.fail_google_calendar_sync_job(
  uuid, bigint, bigint, text, timestamptz, boolean, uuid, text
) from public, anon, authenticated;
grant execute on function public.fail_google_calendar_sync_job(
  uuid, bigint, bigint, text, timestamptz, boolean, uuid, text
) to service_role;
revoke execute on function public.claim_google_calendar_external_cleanup(
  bigint, uuid, integer
) from public, anon, authenticated;
grant execute on function public.claim_google_calendar_external_cleanup(
  bigint, uuid, integer
) to service_role;
revoke execute on function public.observe_google_calendar_managed_event(
  bigint, uuid, text, uuid, boolean, timestamptz, timestamptz, timestamptz,
  text, uuid, text, boolean
) from public, anon, authenticated;
grant execute on function public.observe_google_calendar_managed_event(
  bigint, uuid, text, uuid, boolean, timestamptz, timestamptz, timestamptz,
  text, uuid, text, boolean
) to service_role;
revoke execute on function public.observe_google_calendar_managed_event(
  bigint, uuid, text, uuid, boolean, timestamptz, timestamptz, timestamptz,
  text, uuid, text
) from public, anon, authenticated;
grant execute on function public.observe_google_calendar_managed_event(
  bigint, uuid, text, uuid, boolean, timestamptz, timestamptz, timestamptz,
  text, uuid, text
) to service_role;
revoke execute on function public.google_calendar_managed_event_is_current(
  text, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.google_calendar_managed_event_is_current(
  text, uuid, uuid
) to service_role;
revoke execute on function public.google_calendar_managed_appointment_for_event(text)
  from public, anon, authenticated;
grant execute on function public.google_calendar_managed_appointment_for_event(text)
  to service_role;
revoke execute on function public.list_google_calendar_full_resync_managed_candidates(
  bigint, uuid, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_google_calendar_full_resync_managed_candidates(
  bigint, uuid, uuid, integer
) to service_role;
