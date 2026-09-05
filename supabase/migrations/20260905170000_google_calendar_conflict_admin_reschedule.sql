-- Aceptar una reprogramacion que ya fue hecha en Google es una decision ADMIN
-- explicita. El horario observado puede estar fuera de la regla semanal (Google
-- es tambien una fuente operativa), pero no puede saltear las demas defensas de
-- integridad: alcance vigente, snapshot, duracion, anticipacion, excepciones,
-- bloqueos ni solapamientos.

create or replace function public.apply_google_calendar_conflict(
  p_conflict_id uuid
)
returns public.google_calendar_sync_conflicts
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  conflict_row public.google_calendar_sync_conflicts%rowtype;
  connection_row public.google_calendar_connections%rowtype;
  current_appointment public.appointments%rowtype;
  settings_row public.app_settings%rowtype;
  contact_coverage public.patient_coverage;
  effective_duration integer;
  local_start timestamp;
  local_end_with_buffer timestamp;
  local_date date;
  requested_range tstzrange;
  result public.google_calendar_sync_conflicts;
begin
  if not public.current_user_is_admin() or auth.uid() is null then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  -- Serializa apply con una seleccion, reconexion o desconexion. Es el mismo
  -- advisory lock que usa el ciclo de vida de la conexion.
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );

  select * into conflict_row
  from public.google_calendar_sync_conflicts conflict
  where conflict.id = p_conflict_id
  for update;
  if not found then
    raise exception 'CONFLICT_NOT_PENDING' using errcode = 'P0001';
  end if;

  -- El navegador puede repetir el POST si la primera respuesta se pierde. La
  -- segunda llamada solo confirma el mismo resultado ya persistido; nunca
  -- vuelve a disparar triggers, auditoria ni una nueva version del job.
  if conflict_row.status = 'applied'
    and conflict_row.kind in ('reschedule_requested', 'cancellation_requested')
  then
    select * into current_appointment
    from public.appointments appointment
    where appointment.id = conflict_row.appointment_id
    for share;
    if found and (
      (
        conflict_row.kind = 'reschedule_requested'
        and current_appointment.starts_at is not distinct from
          conflict_row.proposed_starts_at
        and current_appointment.ends_at is not distinct from
          conflict_row.proposed_ends_at
      )
      or (
        conflict_row.kind = 'cancellation_requested'
        and current_appointment.status = 'cancelled'
      )
    ) then
      return conflict_row;
    end if;
  end if;

  if conflict_row.status <> 'pending' then
    raise exception 'CONFLICT_NOT_PENDING' using errcode = 'P0001';
  end if;
  if conflict_row.kind = 'metadata_changed' then
    raise exception 'GOOGLE_CALENDAR_METADATA_CONFLICT_REQUIRES_RESTORE'
      using errcode = '55000';
  end if;

  select * into connection_row
  from public.google_calendar_connections connection
  where connection.id = true
  for share;
  if not found
    or connection_row.status <> 'connected'
    or connection_row.connection_generation <> conflict_row.connection_generation
    or connection_row.sync_scope_generation is distinct from
      connection_row.connection_generation
    or connection_row.sync_scope_google_account_id is distinct from
      connection_row.google_account_id
    or connection_row.sync_scope_google_calendar_id is distinct from
      connection_row.google_calendar_id
    or connection_row.inbound_sync_state <> 'incremental'
    or connection_row.inbound_sync_token is null
    or connection_row.inbound_sync_token_generation is distinct from
      connection_row.connection_generation
    or connection_row.inbound_first_import_approved_at is null
  then
    raise exception 'GOOGLE_CALENDAR_CONFLICT_SCOPE_STALE'
      using errcode = '55000';
  end if;

  -- Se lee primero para obtener la clave del advisory lock. La fila se vuelve
  -- a leer con lock despues de serializar al profesional.
  select * into current_appointment
  from public.appointments appointment
  where appointment.id = conflict_row.appointment_id;
  if not found or current_appointment.status not in ('scheduled', 'confirmed') then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(current_appointment.professional_id::text, 0)
  );
  select * into current_appointment
  from public.appointments appointment
  where appointment.id = conflict_row.appointment_id
  for update;
  if not found or current_appointment.status not in ('scheduled', 'confirmed') then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- La decision solo vale para la version que la persona vio. Si la agenda
  -- cambio desde que se abrio el conflicto, no se aplica una propuesta vieja.
  if conflict_row.observed_starts_at is null
    or conflict_row.observed_ends_at is null
    or current_appointment.starts_at is distinct from
      conflict_row.observed_starts_at
    or current_appointment.ends_at is distinct from conflict_row.observed_ends_at
  then
    raise exception 'GOOGLE_CALENDAR_CONFLICT_SNAPSHOT_STALE'
      using errcode = '40001';
  end if;

  if conflict_row.kind = 'cancellation_requested' then
    perform public.update_appointment_status(
      conflict_row.appointment_id,
      'cancelled'::public.appointment_status
    );
  else
    if conflict_row.kind <> 'reschedule_requested'
      or conflict_row.proposed_starts_at is null
      or conflict_row.proposed_ends_at is null
      or conflict_row.proposed_starts_at >= conflict_row.proposed_ends_at
    then
      raise exception 'GOOGLE_CALENDAR_CONFLICT_RANGE_INVALID'
        using errcode = '22023';
    end if;

    select * into settings_row
    from public.app_settings settings
    where settings.id = true
    for share;
    if not found then
      raise exception 'APP_SETTINGS_NOT_FOUND' using errcode = 'P0002';
    end if;

    select contact.coverage into contact_coverage
    from public.contacts contact
    where contact.id = current_appointment.contact_id
    for key share;
    if contact_coverage is null then
      raise exception 'COVERAGE_REQUIRED' using errcode = 'P0001';
    end if;

    effective_duration := case contact_coverage
      when 'ioma' then settings_row.ioma_duration_minutes
      when 'particular' then settings_row.private_duration_minutes
    end;
    if effective_duration is null
      or conflict_row.proposed_ends_at is distinct from
        conflict_row.proposed_starts_at
          + make_interval(mins => effective_duration)
    then
      raise exception 'GOOGLE_CALENDAR_CONFLICT_DURATION_MISMATCH'
        using errcode = 'P0001';
    end if;

    perform 1
    from public.professionals professional
    where professional.id = current_appointment.professional_id
      and professional.active
    for key share;
    if not found then
      raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
    end if;

    begin
      local_start := conflict_row.proposed_starts_at
        at time zone settings_row.timezone;
      local_end_with_buffer := (
        conflict_row.proposed_ends_at
          + make_interval(mins => settings_row.appointment_buffer_minutes)
      ) at time zone settings_row.timezone;
    exception when invalid_parameter_value then
      raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
    end;

    if conflict_row.proposed_starts_at < clock_timestamp()
        + make_interval(mins => settings_row.minimum_booking_notice_minutes)
      or local_start::date <> local_end_with_buffer::date
    then
      raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
    end if;

    local_date := local_start::date;
    requested_range := tstzrange(
      conflict_row.proposed_starts_at,
      conflict_row.proposed_ends_at
        + make_interval(mins => settings_row.appointment_buffer_minutes),
      '[)'
    );

    -- Una excepcion explicita de cierre prevalece sobre la aceptacion del
    -- cambio. La unica excepcion deliberada es la regla semanal normal.
    if exists (
      select 1
      from public.availability_exceptions availability_exception
      where availability_exception.professional_id =
          current_appointment.professional_id
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
      raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
    end if;

    if exists (
      select 1
      from public.google_calendar_external_events external_event
      where external_event.google_calendar_id =
          connection_row.google_calendar_id
        and external_event.connection_generation =
          connection_row.connection_generation
        and external_event.kind = 'unsupported'
        and external_event.status = 'active'
    ) then
      raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
    end if;

    if exists (
      select 1
      from public.google_calendar_external_events external_event
      where external_event.google_calendar_id =
          connection_row.google_calendar_id
        and external_event.connection_generation =
          connection_row.connection_generation
        and external_event.kind = 'block'
        and (
          external_event.status = 'active'
          or (
            external_event.status = 'converted'
            and external_event.external_cleanup_status in ('pending', 'failed')
          )
        )
        and tstzrange(
          external_event.starts_at,
          external_event.ends_at,
          '[)'
        ) && requested_range
    ) then
      raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
    end if;

    if exists (
      select 1
      from public.appointments appointment
      where appointment.professional_id =
          current_appointment.professional_id
        and appointment.id <> current_appointment.id
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
          appointment.ends_at
            + make_interval(mins => settings_row.appointment_buffer_minutes),
          '[)'
        ) && requested_range
    ) then
      raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
    end if;

    begin
      update public.appointments appointment
      set starts_at = conflict_row.proposed_starts_at,
          ends_at = conflict_row.proposed_ends_at,
          coverage = contact_coverage,
          duration_minutes = effective_duration
      where appointment.id = current_appointment.id;
    exception when exclusion_violation then
      raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
    end;
  end if;

  update public.google_calendar_sync_conflicts conflict
  set status = 'applied',
      resolved_at = clock_timestamp(),
      resolved_by = auth.uid(),
      resolution_error = null
  where conflict.id = p_conflict_id
  returning * into result;

  -- El trigger del turno ya encola esta proyeccion. Este llamado explicito
  -- conserva la defensa historica y la unicidad por appointment_id evita jobs
  -- duplicados.
  perform public.enqueue_google_calendar_projection(conflict_row.appointment_id);

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(),
    'google_calendar.conflict_applied',
    'appointment',
    conflict_row.appointment_id,
    jsonb_build_object('conflict_id', p_conflict_id, 'kind', conflict_row.kind)
  );

  return result;
end;
$$;

revoke execute on function public.apply_google_calendar_conflict(uuid)
  from public, anon;
grant execute on function public.apply_google_calendar_conflict(uuid)
  to authenticated, service_role;
