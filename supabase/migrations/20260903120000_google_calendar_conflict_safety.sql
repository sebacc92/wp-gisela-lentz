-- Correcciones de seguridad sobre la sincronización bidireccional.
--
-- Tres fallas reales del diseño anterior:
--
--   1. El push corría antes del pull y no comparaba contra lo último enviado,
--      así que una reproyección periódica pendiente pisaba en Google un cambio
--      externo antes de que nadie lo leyera. `ignored_pending_push` además
--      descartaba esa observación de forma definitiva mientras el syncToken
--      avanzaba: el cambio quedaba sin ninguna forma de recuperarse.
--   2. `convert_google_calendar_block` exigía un turno ya creado, pero el
--      bloqueo activo hacía imposible crearlo. La única forma de usarlo era
--      liberar el bloqueo primero, abriendo una ventana de reserva ajena.
--   3. Los bloqueos no estaban asociados a un calendario concreto: al cambiar
--      de cuenta seguían ocupando la agenda nueva.

-- ---------------------------------------------------------------------------
-- 1. Cada bloqueo pertenece a un calendario concreto
-- ---------------------------------------------------------------------------

alter table public.google_calendar_external_events
  add column google_calendar_id text;

update public.google_calendar_external_events event
set google_calendar_id = coalesce(
  (select connection.google_calendar_id
   from public.google_calendar_connections connection where connection.id = true),
  'unknown'
);

alter table public.google_calendar_external_events
  alter column google_calendar_id set not null,
  add constraint google_calendar_external_events_calendar_id_check
    check (char_length(google_calendar_id) between 1 and 1024);

-- `google_event_id` sólo es único dentro de su calendario: dos agendas
-- distintas pueden reutilizar el mismo identificador.
alter table public.google_calendar_external_events
  drop constraint google_calendar_external_events_pkey;
alter table public.google_calendar_external_events
  add primary key (google_calendar_id, google_event_id);

alter table public.google_calendar_external_events
  drop constraint google_calendar_external_events_status_check;
alter table public.google_calendar_external_events
  add constraint google_calendar_external_events_status_check
    check (status in ('active', 'removed', 'converted', 'superseded'));

comment on column public.google_calendar_external_events.google_calendar_id is
  'Calendario dueño del evento. Un bloqueo nunca cruza de una cuenta a otra.';

-- Al cambiar de cuenta o desconectar, los bloqueos viejos dejan de ocupar la
-- agenda pero se conservan como historia. Nunca se borra un evento en Google
-- como efecto lateral. Reconectar la MISMA agenda los mantiene vigentes.
create or replace function public.rescope_google_calendar_external_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.connection_generation is not distinct from old.connection_generation
    and new.status is not distinct from old.status
    and new.google_calendar_id is not distinct from old.google_calendar_id
  then
    return new;
  end if;

  if new.status = 'connected'
    and new.google_calendar_id is not distinct from old.google_calendar_id
  then
    update public.google_calendar_external_events
    set connection_generation = new.connection_generation
    where status = 'active'
      and google_calendar_id = new.google_calendar_id
      and connection_generation <> new.connection_generation;
    update public.google_calendar_sync_conflicts
    set connection_generation = new.connection_generation
    where status = 'pending'
      and connection_generation <> new.connection_generation;
    return new;
  end if;

  update public.google_calendar_external_events
  set status = 'superseded',
      removed_at = coalesce(removed_at, clock_timestamp())
  where status = 'active'
    and (
      new.status <> 'connected'
      or google_calendar_id is distinct from new.google_calendar_id
    );

  update public.google_calendar_sync_conflicts
  set status = 'superseded', resolved_at = clock_timestamp()
  where status = 'pending';

  return new;
end;
$$;

create trigger google_calendar_connection_rescope
  after update on public.google_calendar_connections
  for each row execute function public.rescope_google_calendar_external_events();

revoke execute on function public.rescope_google_calendar_external_events()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Sólo los bloqueos de la conexión vigente ocupan la agenda
-- ---------------------------------------------------------------------------

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

  -- Bloqueos importados: sólo los de la conexión y el calendario vigentes. Un
  -- bloqueo de la cuenta anterior no puede seguir ocupando la agenda nueva.
  if exists (
    select 1
    from public.google_calendar_external_events external_event
    join public.google_calendar_connections connection
      on connection.id = true
      and connection.status = 'connected'
      and connection.google_calendar_id = external_event.google_calendar_id
      and connection.connection_generation = external_event.connection_generation
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
-- 3. La cola recuerda qué se proyectó y con qué ETag
-- ---------------------------------------------------------------------------
--
-- Sin esto es imposible distinguir «Google difiere porque todavía no le
-- enviamos nuestro cambio» de «alguien editó Google». La primera situación no
-- contiene información externa que perder; la segunda sí.

alter table public.google_calendar_sync_jobs
  add column google_etag text
    check (google_etag is null or char_length(google_etag) <= 255),
  add column projected_starts_at timestamptz,
  add column projected_ends_at timestamptz,
  add column projected_operation text
    check (projected_operation is null or projected_operation in ('upsert', 'delete'));

comment on column public.google_calendar_sync_jobs.projected_starts_at is
  'Último horario efectivamente enviado a Google. Es la referencia para decidir si una diferencia es nuestra o externa.';
comment on column public.google_calendar_sync_jobs.google_etag is
  'ETag observado del evento. Habilita If-Match para no pisar una edición ajena.';

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
language plpgsql
security definer
set search_path = public
as $$
declare
  completed boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  update public.google_calendar_sync_jobs
  set status = 'succeeded', processing_started_at = null,
      google_event_id = case when operation = 'delete' then null
        else p_google_event_id end,
      google_etag = case when operation = 'delete' then null
        else nullif(trim(coalesce(p_google_etag, '')), '') end,
      projected_operation = operation,
      projected_starts_at = case when operation = 'delete' then null
        else p_projected_starts_at end,
      projected_ends_at = case when operation = 'delete' then null
        else p_projected_ends_at end,
      last_error = null
  where id = p_job_id and status = 'processing'
    and desired_version = p_claimed_version
    and exists (
      select 1 from public.google_calendar_connections connection
      where connection.id = true and connection.status = 'connected'
        and connection.connection_generation = p_connection_generation
    );
  completed := found;

  if not completed then
    update public.google_calendar_sync_jobs
    set status = 'pending', processing_started_at = null,
        available_at = clock_timestamp()
    where id = p_job_id and status = 'processing'
      and connection_generation = p_connection_generation;
  else
    update public.google_calendar_connections
    set last_synced_at = clock_timestamp(), last_error = null
    where id = true and status = 'connected';
  end if;
  return completed;
end;
$$;

-- Compatibilidad temporal: el worker desplegado todavía llama a la firma de
-- cuatro argumentos. Se conserva delegando, para que la migración pueda
-- aplicarse antes de desplegar las Functions sin romper la cola.
create or replace function public.complete_google_calendar_sync_job(
  p_job_id uuid,
  p_claimed_version bigint,
  p_google_event_id text,
  p_connection_generation bigint
)
returns boolean
language sql
security definer
set search_path = public
as $$
  select public.complete_google_calendar_sync_job(
    p_job_id, p_claimed_version, p_google_event_id, p_connection_generation,
    null, null, null
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. El push se retiene mientras haya un conflicto pendiente
-- ---------------------------------------------------------------------------

drop function if exists public.claim_google_calendar_sync_jobs(integer, bigint);

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
  google_etag text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.google_calendar_connections connection
    where connection.id = true and connection.status = 'connected'
      and connection.connection_generation = p_expected_generation
  ) then return; end if;

  update public.google_calendar_sync_jobs job
  set status = 'pending', processing_started_at = null,
      available_at = clock_timestamp(), last_error = 'STALE_CLAIM_RECOVERED'
  where job.status = 'processing'
    and job.connection_generation = p_expected_generation
    and job.processing_started_at < clock_timestamp() - interval '10 minutes';

  return query
  with due as (
    select job.id, job.appointment_id
    from public.google_calendar_sync_jobs job
    where job.status = 'pending' and job.available_at <= clock_timestamp()
      and job.connection_generation = p_expected_generation
      -- Un upsert reproyectaría el estado de la app sobre un evento que
      -- alguien editó, borrando la propuesta antes de que nadie la vea. Se
      -- retiene hasta que una persona ADMIN resuelva el conflicto. Un delete
      -- no destruye información: la propuesta ya está guardada en la tabla.
      and not (
        job.operation = 'upsert'
        and exists (
          select 1 from public.google_calendar_sync_conflicts conflict
          where conflict.appointment_id = job.appointment_id
            and conflict.status = 'pending'
        )
      )
      and exists (
        select 1 from public.google_calendar_connections connection
        where connection.id = true and connection.status = 'connected'
          and connection.connection_generation = p_expected_generation
      )
    order by job.available_at, job.updated_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 20))
  ), claimed as (
    update public.google_calendar_sync_jobs job
    set status = 'processing', attempts = job.attempts + 1,
        processing_started_at = clock_timestamp()
    from due
    where job.id = due.id
    returning job.*
  )
  select claimed.id, claimed.appointment_id, claimed.operation,
         claimed.desired_version, claimed.attempts,
         appointment.starts_at, appointment.ends_at, contact.name,
         settings.timezone, connection.connection_generation,
         claimed.google_etag
  from claimed
  join public.appointments appointment on appointment.id = claimed.appointment_id
  join public.contacts contact on contact.id = appointment.contact_id
  join public.app_settings settings on settings.id = true
  join public.google_calendar_connections connection
    on connection.id = true and connection.status = 'connected';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Observación: distinguir «todavía no lo enviamos» de «alguien lo editó»
-- ---------------------------------------------------------------------------

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
language plpgsql
security definer
set search_path = public
as $$
declare
  appointment_row public.appointments%rowtype;
  job_row public.google_calendar_sync_jobs%rowtype;
  conflict_kind text;
  matches_appointment boolean;
  matches_projection boolean;
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );

  select * into appointment_row
  from public.appointments where id = p_appointment_id;
  if not found then return 'ignored_unknown_appointment'; end if;

  select * into job_row
  from public.google_calendar_sync_jobs
  where appointment_id = p_appointment_id
  for update;

  -- El ETag observado habilita If-Match en la próxima escritura: sin él el
  -- push sería incondicional y pisaría cualquier edición ajena.
  if found and nullif(trim(coalesce(p_google_etag, '')), '') is not null then
    update public.google_calendar_sync_jobs
    set google_etag = p_google_etag
    where appointment_id = p_appointment_id;
  end if;

  if appointment_row.status not in ('scheduled', 'confirmed') then
    return 'ignored_final_appointment';
  end if;

  if coalesce(p_cancelled, false) then
    -- Si el borrado lo hicimos nosotros, Google sólo está reflejando la app.
    if job_row.projected_operation = 'delete'
      or (job_row.operation = 'delete' and job_row.status in ('pending', 'processing'))
    then
      return 'in_sync';
    end if;
    conflict_kind := 'cancellation_requested';
  else
    matches_appointment :=
      p_starts_at is not distinct from appointment_row.starts_at
      and p_ends_at is not distinct from appointment_row.ends_at;
    if matches_appointment then return 'in_sync'; end if;

    -- Google refleja exactamente lo último que le enviamos. La diferencia es
    -- un cambio NUESTRO todavía sin proyectar, no una edición externa: no hay
    -- información ajena que preservar y el push puede seguir su curso.
    matches_projection :=
      job_row.projected_starts_at is not null
      and p_starts_at is not distinct from job_row.projected_starts_at
      and p_ends_at is not distinct from job_row.projected_ends_at;
    if matches_projection then return 'pending_push'; end if;

    if p_starts_at is null or p_ends_at is null or p_starts_at >= p_ends_at then
      return 'ignored_invalid_range';
    end if;
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

-- Compatibilidad temporal con el worker anterior, que todavía no envía ETag.
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
set search_path = public
as $$
  select public.observe_google_calendar_managed_event(
    p_expected_generation, p_lease_token, p_google_event_id, p_appointment_id,
    p_cancelled, p_starts_at, p_ends_at, p_google_updated_at, null
  );
$$;

-- Un evento borrado llega con `id` y `status` solamente, sin
-- extendedProperties. El mapeo guardado en la cola alcanza para reconocerlo.
create or replace function public.google_calendar_managed_appointment_for_event(
  p_google_event_id text
)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select job.appointment_id
  from public.google_calendar_sync_jobs job
  where job.google_event_id = p_google_event_id
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 6. Convertir un bloqueo en turno, en una sola transacción
-- ---------------------------------------------------------------------------
--
-- El evento original de Google no se puede reutilizar como evento del turno:
-- la exportación usa un id determinista derivado del appointment_id, que es lo
-- que impide duplicados en todo el resto del sistema. Para no dejar dos
-- eventos en la agenda, la conversión deja marcado el evento original para que
-- el worker lo elimine DESPUÉS de confirmar que el evento del turno existe.

alter table public.google_calendar_external_events
  add column external_cleanup_status text not null default 'not_required'
    check (external_cleanup_status in ('not_required', 'pending', 'done', 'failed')),
  add column external_cleanup_error text;

create index google_calendar_external_events_cleanup_idx
  on public.google_calendar_external_events (external_cleanup_status)
  where external_cleanup_status = 'pending';

comment on column public.google_calendar_external_events.external_cleanup_status is
  'Sólo se marca pending al convertir un bloqueo en turno: el evento manual se retira de Google una vez que existe el evento del turno.';

create or replace function public.convert_google_calendar_block_to_appointment(
  p_google_event_id text,
  p_contact_id uuid,
  p_professional_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz default null,
  p_internal_note text default null
)
returns table (appointment_id uuid, created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_calendar_id text;
  block_row public.google_calendar_external_events%rowtype;
  new_appointment public.appointments;
  effective_start timestamptz;
begin
  if not public.current_user_is_admin() or auth.uid() is null then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select connection.google_calendar_id into current_calendar_id
  from public.google_calendar_connections connection
  where connection.id = true and connection.status = 'connected';
  if current_calendar_id is null then
    raise exception 'CALENDAR_NOT_CONNECTED' using errcode = 'P0001';
  end if;

  -- El row lock serializa el doble clic y dos solicitudes concurrentes: la
  -- segunda espera y encuentra el bloqueo ya convertido.
  select * into block_row
  from public.google_calendar_external_events
  where google_calendar_id = current_calendar_id
    and google_event_id = p_google_event_id
  for update;
  if not found then
    raise exception 'CALENDAR_BLOCK_NOT_FOUND' using errcode = 'P0002';
  end if;

  if block_row.status = 'converted' then
    return query select block_row.converted_appointment_id, false;
    return;
  end if;
  if block_row.status <> 'active' or block_row.kind <> 'block' then
    raise exception 'CALENDAR_BLOCK_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  effective_start := coalesce(p_starts_at, block_row.starts_at);

  -- El bloqueo se retira y el turno se crea dentro de la MISMA transacción:
  -- ninguna otra sesión llega a ver el intervalo libre, y si la creación falla
  -- el rollback conserva el bloqueo intacto.
  update public.google_calendar_external_events
  set status = 'removed', removed_at = clock_timestamp()
  where google_calendar_id = current_calendar_id
    and google_event_id = p_google_event_id;

  -- Reutiliza las validaciones normales: servicio activo, cobertura del
  -- paciente, duración clínica, solapamientos, hold y seña.
  new_appointment := public.create_service_appointment(
    p_contact_id, p_professional_id, p_service_id, effective_start,
    'manual'::public.appointment_source, p_internal_note
  );

  update public.google_calendar_external_events
  set status = 'converted',
      converted_appointment_id = new_appointment.id,
      external_cleanup_status = 'pending',
      external_cleanup_error = null
  where google_calendar_id = current_calendar_id
    and google_event_id = p_google_event_id;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(), 'google_calendar.block_converted', 'appointment',
    new_appointment.id, jsonb_build_object('cleanup', 'pending')
  );

  return query select new_appointment.id, true;
end;
$$;

-- La versión anterior exigía un turno ya creado, lo que era imposible sin
-- liberar antes el bloqueo. Se elimina para que no quede un camino inseguro.
drop function if exists public.convert_google_calendar_block(text, uuid);

create or replace function public.claim_google_calendar_external_cleanup(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_limit integer default 3
)
returns table (google_event_id text, appointment_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );
  return query
  select event.google_event_id, event.converted_appointment_id
  from public.google_calendar_external_events event
  join public.google_calendar_connections connection
    on connection.id = true
    and connection.status = 'connected'
    and connection.google_calendar_id = event.google_calendar_id
  -- Sólo después de que el turno tenga su propio evento exportado, en ESTE
  -- calendario y en ESTA generación: si se borrara antes, o si la proyección
  -- fuera de una conexión anterior, el horario quedaría invisible en Google.
  join public.google_calendar_sync_jobs job
    on job.appointment_id = event.converted_appointment_id
    and job.google_event_id is not null
    and job.projected_operation = 'upsert'
    and job.connection_generation = connection.connection_generation
  where event.external_cleanup_status = 'pending'
    and event.connection_generation = connection.connection_generation
  order by event.updated_at
  limit greatest(1, least(coalesce(p_limit, 3), 10));
end;
$$;

create or replace function public.complete_google_calendar_external_cleanup(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_google_event_id text,
  p_succeeded boolean,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_error text := nullif(upper(trim(coalesce(p_error_code, ''))), '');
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );
  if clean_error is not null and clean_error !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'INVALID_SYNC_FAILURE' using errcode = '22023';
  end if;

  update public.google_calendar_external_events event
  set external_cleanup_status = case when p_succeeded then 'done' else 'failed' end,
      external_cleanup_error = case when p_succeeded then null else clean_error end
  where event.google_event_id = p_google_event_id
    and event.external_cleanup_status = 'pending'
    and exists (
      select 1 from public.google_calendar_connections connection
      where connection.id = true
        and connection.google_calendar_id = event.google_calendar_id
        and connection.connection_generation = p_expected_generation
    );
  return found;
end;
$$;

do $$
declare
  signature regprocedure;
begin
  for signature in
    select procedure_oid
    from (values
      ('public.claim_google_calendar_external_cleanup(bigint,uuid,integer)'::regprocedure),
      ('public.complete_google_calendar_external_cleanup(bigint,uuid,text,boolean,text)'::regprocedure),
      ('public.google_calendar_managed_appointment_for_event(text)'::regprocedure),
      ('public.observe_google_calendar_managed_event(bigint,uuid,text,uuid,boolean,timestamptz,timestamptz,timestamptz,text)'::regprocedure),
      ('public.complete_google_calendar_sync_job(uuid,bigint,text,bigint,text,timestamptz,timestamptz)'::regprocedure),
      ('public.claim_google_calendar_sync_jobs(integer,bigint)'::regprocedure)
    ) functions(procedure_oid)
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', signature);
    execute format('grant execute on function %s to service_role', signature);
  end loop;
end;
$$;

revoke execute on function public.convert_google_calendar_block_to_appointment(
  text, uuid, uuid, uuid, timestamptz, text
) from public, anon;
grant execute on function public.convert_google_calendar_block_to_appointment(
  text, uuid, uuid, uuid, timestamptz, text
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. La aplicación de eventos externos también se ancla al calendario
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
  clean_summary text := nullif(
    left(regexp_replace(coalesce(p_summary, ''), '[[:cntrl:]]+', ' ', 'g'), 120),
    ''
  );
  current_calendar_id text;
  existing public.google_calendar_external_events%rowtype;
  next_hash text;
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );
  if clean_event_id = '' or char_length(clean_event_id) > 1024 then
    raise exception 'GOOGLE_EXTERNAL_EVENT_INVALID' using errcode = '22023';
  end if;

  select connection.google_calendar_id into current_calendar_id
  from public.google_calendar_connections connection
  where connection.id = true and connection.status = 'connected';
  if current_calendar_id is null then
    raise exception 'CALENDAR_NOT_CONNECTED' using errcode = 'P0001';
  end if;

  select * into existing
  from public.google_calendar_external_events
  where google_calendar_id = current_calendar_id
    and google_event_id = clean_event_id
  for update;

  -- Un bloqueo que ya se convirtió en turno deja de responder a Google: el
  -- turno pasa a ser la fuente de verdad y tiene su propio evento.
  if found and existing.status = 'converted' then
    return 'skipped_converted';
  end if;

  if coalesce(p_removed, false) then
    if not found or existing.status <> 'active' then
      return 'already_removed';
    end if;
    update public.google_calendar_external_events
    set status = 'removed',
        removed_at = clock_timestamp(),
        google_etag = p_google_etag,
        google_updated_at = p_google_updated_at
    where google_calendar_id = current_calendar_id
      and google_event_id = clean_event_id;
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
    google_calendar_id, google_event_id, connection_generation, kind, status,
    summary, starts_at, ends_at, all_day, recurring, unsupported_reason,
    google_etag, google_updated_at, content_hash, removed_at
  ) values (
    current_calendar_id, clean_event_id, p_expected_generation, p_kind,
    'active', clean_summary, p_starts_at, p_ends_at, coalesce(p_all_day, false),
    coalesce(p_recurring, false), p_unsupported_reason,
    p_google_etag, p_google_updated_at, next_hash, null
  )
  on conflict (google_calendar_id, google_event_id) do update
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
  current_calendar_id text;
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );
  select connection.google_calendar_id into current_calendar_id
  from public.google_calendar_connections connection
  where connection.id = true and connection.status = 'connected';
  if current_calendar_id is null then return 0; end if;

  with retired as (
    update public.google_calendar_external_events
    set status = 'removed', removed_at = clock_timestamp()
    where status = 'active'
      and google_calendar_id = current_calendar_id
      and not (google_event_id = any(coalesce(p_seen_event_ids, array[]::text[])))
    returning 1
  )
  select count(*)::integer into removed_count from retired;
  return removed_count;
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
  update public.google_calendar_external_events event
  set status = 'removed', removed_at = clock_timestamp()
  where event.google_event_id = p_google_event_id
    and event.status = 'active'
    and exists (
      select 1 from public.google_calendar_connections connection
      where connection.id = true
        and connection.google_calendar_id = event.google_calendar_id
    );
  if not found then return false; end if;

  insert into public.audit_logs (actor_user_id, action, entity_type, metadata)
  values (
    auth.uid(), 'google_calendar.block_dismissed', 'google_calendar',
    '{}'::jsonb
  );
  return true;
end;
$$;
