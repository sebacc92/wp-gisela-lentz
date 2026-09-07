-- Calendar appointments are already committed bookings, not deposit holds.
-- Their original Google event remains read-only and is the remote occupancy.
alter table public.appointments
  add column google_calendar_imported boolean not null default false;

update public.appointments appointment
set google_calendar_imported = true
where exists (
  select 1 from public.google_calendar_external_events event
  where event.converted_appointment_id = appointment.id
);

comment on column public.appointments.google_calendar_imported is
  'Turno importado de un evento manual de Google, que sigue siendo la fuente del horario. No se exporta otro evento ni se exige seña retroactiva.';

-- Full names must agree; neither a shared family phone nor a first-name-only
-- match is permission to merge identities. Word order and accents may differ.
create function public.google_calendar_patient_name_key(p_name text)
returns text language sql immutable
set search_path = pg_catalog, public
as $$
  select coalesce(string_agg(word, ' ' order by word collate "C"), '')
  from regexp_split_to_table(
    regexp_replace(translate(lower(coalesce(p_name, '')),
      'áàäâãåéèëêíìïîóòöôõúùüûñç',
      'aaaaaaeeeeiiiiooooouuuunc'), '[^a-z]+', ' ', 'g'), '\s+'
  ) word
  where word <> '';
$$;

-- The private core is shared by the admin and service entrypoints. It never
-- changes JWT claims or impersonates an administrator.
create function public.convert_google_calendar_patient_import(
  p_google_event_id text,
  p_contact_id uuid,
  p_patient_name text,
  p_patient_phone text,
  p_coverage public.patient_coverage,
  p_professional_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_internal_note text,
  p_orthodontic_visit_type public.orthodontic_visit_type,
  p_is_existing_patient boolean,
  p_automatic boolean,
  p_expected_generation bigint,
  p_expected_google_calendar_id text,
  p_automation_epoch uuid,
  p_expected_summary text,
  p_expected_ends_at timestamptz
)
returns table (appointment_id uuid, created boolean)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  connection_row public.google_calendar_connections%rowtype;
  event_row public.google_calendar_external_events%rowtype;
  contact_row public.contacts%rowtype;
  appointment_row public.appointments%rowtype;
  clean_name text := nullif(btrim(p_patient_name), '');
  clean_phone text := nullif(btrim(p_patient_phone), '');
  name_key text := public.google_calendar_patient_name_key(p_patient_name);
  effective_coverage public.patient_coverage;
  effective_duration integer;
  intake_required boolean;
  contact_created boolean := false;
begin
  -- Match the booking lock order. The shared connection barrier is retained
  -- through commit, so inbound import/reconnection cannot race this snapshot.
  perform pg_advisory_xact_lock(hashtextextended(p_professional_id::text, 0));
  if not pg_try_advisory_xact_lock_shared(
    hashtextextended('google_calendar_connection', 0)
  ) then
    raise exception 'CALENDAR_NOT_READY' using errcode = 'P0001';
  end if;
  select * into connection_row
  from public.google_calendar_connections where id = true for share;
  if not found or connection_row.status <> 'connected'
    or connection_row.sync_scope_google_account_id is distinct from connection_row.google_account_id
    or connection_row.sync_scope_google_calendar_id is distinct from connection_row.google_calendar_id
    or connection_row.sync_scope_generation is distinct from connection_row.connection_generation
  then
    raise exception 'CALENDAR_NOT_CONNECTED' using errcode = 'P0001';
  end if;
  if not public.google_calendar_automation_scope_is_current(true) then
    raise exception 'CALENDAR_NOT_READY' using errcode = 'P0001';
  end if;
  if p_automatic and (
    p_expected_generation is distinct from connection_row.connection_generation
    or p_expected_google_calendar_id is distinct from connection_row.google_calendar_id
    or p_automation_epoch is distinct from connection_row.automation_epoch
  ) then
    raise exception 'GOOGLE_CALENDAR_IMPORT_SCOPE_STALE' using errcode = '55000';
  end if;

  select * into event_row from public.google_calendar_external_events event
  where event.google_calendar_id = connection_row.google_calendar_id
    and event.google_event_id = p_google_event_id
    and event.connection_generation = connection_row.connection_generation
  for update;
  if not found then
    raise exception 'CALENDAR_BLOCK_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_starts_at is null or p_starts_at is distinct from event_row.starts_at
    or (p_automatic and (
      p_expected_summary is distinct from event_row.summary
      or p_expected_ends_at is distinct from event_row.ends_at
    ))
  then
    raise exception 'CALENDAR_BLOCK_STALE' using errcode = '55000';
  end if;
  if event_row.status not in ('active', 'converted') or event_row.kind <> 'block'
    or event_row.removed_at is not null
  then
    raise exception 'CALENDAR_BLOCK_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if event_row.all_day or event_row.recurring then
    raise exception 'CALENDAR_BLOCK_UNSUPPORTED' using errcode = 'P0001';
  end if;
  if extract(epoch from (event_row.ends_at - event_row.starts_at)) / 60
    not between 5 and 480
    or mod(extract(epoch from (event_row.ends_at - event_row.starts_at)), 60) <> 0
  then
    raise exception 'CALENDAR_BLOCK_DURATION_INVALID' using errcode = 'P0001';
  end if;
  effective_duration := (extract(epoch from (event_row.ends_at - event_row.starts_at)) / 60)::integer;

  if clean_phone is not null and clean_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'PATIENT_PHONE_INVALID' using errcode = 'P0001';
  end if;
  if (p_contact_id is null or p_automatic) and (clean_name is null or name_key = '') then
    raise exception 'PATIENT_NAME_REQUIRED' using errcode = 'P0001';
  end if;
  if clean_name is not null and char_length(clean_name) > 120 then
    raise exception 'PATIENT_NAME_INVALID' using errcode = 'P0001';
  end if;
  if p_automatic and (p_coverage is null or p_is_existing_patient is null) then
    raise exception 'CALENDAR_PATIENT_DETAILS_REQUIRED' using errcode = 'P0001';
  end if;
  if clean_phone is not null then
    perform pg_advisory_xact_lock(hashtextextended('calendar_patient_phone:' || clean_phone, 0));
  end if;
  if name_key <> '' then
    perform pg_advisory_xact_lock(hashtextextended('calendar_patient_name:' || name_key, 0));
  end if;

  if p_contact_id is not null then
    select * into contact_row from public.contacts where id = p_contact_id for update;
    if not found then
      raise exception 'CONTACT_NOT_FOUND' using errcode = 'P0002';
    end if;
    if (clean_name is not null and public.google_calendar_patient_name_key(contact_row.name) <> name_key)
      or (clean_phone is not null and clean_phone is distinct from contact_row.phone_e164
        and clean_phone is distinct from contact_row.alternate_phone_e164)
    then
      raise exception 'CONTACT_IDENTITY_CONFLICT' using errcode = '23514';
    end if;
  else
    if clean_phone is null then
      raise exception 'PATIENT_PHONE_REQUIRED' using errcode = 'P0001';
    end if;
    select * into contact_row from public.contacts where phone_e164 = clean_phone for update;
    if found and public.google_calendar_patient_name_key(contact_row.name) <> name_key then
      raise exception 'CONTACT_IDENTITY_CONFLICT' using errcode = '23514';
    end if;
  end if;

  -- Alternate numbers may be shared by relatives. Even a unique primary phone
  -- cannot silently override another patient's recorded association.
  if clean_phone is not null and exists (
    select 1 from public.contacts contact
    where (contact.phone_e164 = clean_phone or contact.alternate_phone_e164 = clean_phone)
      and contact.id is distinct from contact_row.id
  ) then
    raise exception 'CONTACT_IDENTITY_CONFLICT' using errcode = '23514';
  end if;
  if name_key <> '' and (p_contact_id is null or p_automatic) and exists (
    select 1 from public.contacts contact
    where public.google_calendar_patient_name_key(contact.name) = name_key
      and contact.id is distinct from contact_row.id
  ) then
    raise exception 'CONTACT_IDENTITY_CONFLICT' using errcode = '23514';
  end if;

  if event_row.status = 'converted' then
    select * into appointment_row from public.appointments
    where id = event_row.converted_appointment_id;
    if not found or appointment_row.contact_id is distinct from contact_row.id
      or appointment_row.professional_id is distinct from p_professional_id
      or appointment_row.service_id is distinct from p_service_id
      or appointment_row.orthodontic_visit_type is distinct from p_orthodontic_visit_type
      or appointment_row.starts_at is distinct from event_row.starts_at
      or appointment_row.ends_at is distinct from event_row.ends_at
      or (p_coverage is not null and appointment_row.coverage is distinct from p_coverage)
    then
      raise exception 'CALENDAR_BLOCK_CONVERSION_CONFLICT' using errcode = '23514';
    end if;
    return query select appointment_row.id, false;
    return;
  end if;
  if event_row.starts_at <= clock_timestamp() then
    raise exception 'CALENDAR_BLOCK_IN_PAST' using errcode = 'P0001';
  end if;
  perform 1 from public.professionals
  where id = p_professional_id and active for share;
  if not found then
    raise exception 'PROFESSIONAL_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  select requires_orthodontic_intake into intake_required
  from public.services where id = p_service_id and active for share;
  if not found then
    raise exception 'SERVICE_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  if intake_required and p_orthodontic_visit_type is null then
    raise exception 'ORTHODONTIC_VISIT_TYPE_REQUIRED' using errcode = 'P0001';
  end if;
  if not intake_required and p_orthodontic_visit_type is not null then
    raise exception 'ORTHODONTIC_VISIT_TYPE_NOT_APPLICABLE' using errcode = 'P0001';
  end if;
  effective_coverage := coalesce(p_coverage, contact_row.coverage);
  if effective_coverage is null then
    raise exception 'COVERAGE_REQUIRED' using errcode = 'P0001';
  end if;

  if contact_row.id is null then
    begin
      insert into public.contacts (name, phone_e164, coverage, is_existing_patient)
      values (clean_name, clean_phone, effective_coverage, p_is_existing_patient)
      returning * into contact_row;
    exception when unique_violation then
      raise exception 'CONTACT_IDENTITY_CONFLICT' using errcode = '23514';
    end;
    contact_created := true;
  elsif (contact_row.coverage is null and p_coverage is not null)
    or (contact_row.is_existing_patient is null and p_is_existing_patient is not null)
  then
    update public.contacts
    set coverage = coalesce(coverage, p_coverage),
        is_existing_patient = coalesce(is_existing_patient, p_is_existing_patient)
    where id = contact_row.id;
  end if;

  begin
    insert into public.appointments (
      contact_id, professional_id, service_id, starts_at, ends_at,
      status, source, created_by, internal_note, coverage, duration_minutes,
      deposit_status, hold_expires_at, hold_expired_notification_status,
      orthodontic_visit_type, google_calendar_imported
    ) values (
      contact_row.id, p_professional_id, p_service_id, event_row.starts_at, event_row.ends_at,
      'confirmed', 'manual', case when p_automatic then null else auth.uid() end,
      p_internal_note, effective_coverage, effective_duration, 'not_required', null,
      'not_applicable', p_orthodontic_visit_type, true
    ) returning * into appointment_row;
  exception when exclusion_violation then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end;
  update public.google_calendar_external_events
  set status = 'converted', converted_appointment_id = appointment_row.id,
      external_cleanup_status = 'pending', external_cleanup_error = null, removed_at = null
  where google_calendar_id = event_row.google_calendar_id
    and google_event_id = event_row.google_event_id;

  -- INSERT may queue before the relationship exists. No worker can see this
  -- new appointment before commit; remove only its untouched transient job.
  -- The established stage/claim guards also exclude linked manual events.
  delete from public.google_calendar_sync_jobs
  where public.google_calendar_sync_jobs.appointment_id = appointment_row.id
    and status = 'pending' and attempts = 0 and projected_operation is null;
  -- This imports a booking Gisela already made, including legitimate
  -- after-hours or short-notice bookings. The established confirmation guard
  -- checks full-window freshness and every collision without reapplying the
  -- weekly offer/notice policy for NEW reservations. A failure rolls back the
  -- patient, appointment and source association together.
  if not public.appointment_slot_is_free_for(appointment_row.id) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;
  insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  values (case when p_automatic then null else auth.uid() end,
    case when p_automatic then 'google_calendar.patient_imported' else 'google_calendar.block_converted' end,
    'appointment', appointment_row.id,
    jsonb_build_object('source', 'google_calendar', 'patient_created', contact_created, 'automatic', p_automatic));
  return query select appointment_row.id, true;
end;
$$;

create function public.convert_google_calendar_block_with_patient(
  p_google_event_id text, p_contact_id uuid, p_patient_name text, p_patient_phone text,
  p_coverage public.patient_coverage, p_professional_id uuid, p_service_id uuid,
  p_starts_at timestamptz, p_internal_note text default null,
  p_orthodontic_visit_type public.orthodontic_visit_type default null,
  p_is_existing_patient boolean default null
)
returns table (appointment_id uuid, created boolean)
language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if not public.current_user_is_admin() or auth.uid() is null then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  return query select * from public.convert_google_calendar_patient_import(
    p_google_event_id, p_contact_id, p_patient_name, p_patient_phone, p_coverage,
    p_professional_id, p_service_id, p_starts_at, p_internal_note,
    p_orthodontic_visit_type, p_is_existing_patient, false, null, null, null, null, null
  );
end;
$$;

create or replace function public.convert_google_calendar_block_to_appointment(
  p_google_event_id text, p_contact_id uuid, p_professional_id uuid, p_service_id uuid,
  p_starts_at timestamptz default null, p_internal_note text default null,
  p_orthodontic_visit_type public.orthodontic_visit_type default null
)
returns table (appointment_id uuid, created boolean)
language sql security definer set search_path = pg_catalog, public
as $$
  select * from public.convert_google_calendar_block_with_patient(
    p_google_event_id, p_contact_id, null, null, null, p_professional_id,
    p_service_id, p_starts_at, p_internal_note, p_orthodontic_visit_type, null
  );
$$;

create function public.import_google_calendar_patient_appointment(
  p_google_event_id text, p_contact_id uuid, p_patient_name text, p_patient_phone text,
  p_coverage public.patient_coverage, p_professional_id uuid, p_service_id uuid,
  p_starts_at timestamptz, p_internal_note text,
  p_orthodontic_visit_type public.orthodontic_visit_type, p_is_existing_patient boolean,
  p_expected_generation bigint, p_expected_google_calendar_id text,
  p_automation_epoch uuid, p_expected_summary text, p_expected_ends_at timestamptz
)
returns table (appointment_id uuid, created boolean)
language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  return query select * from public.convert_google_calendar_patient_import(
    p_google_event_id, p_contact_id, p_patient_name, p_patient_phone, p_coverage,
    p_professional_id, p_service_id, p_starts_at, p_internal_note,
    p_orthodontic_visit_type, p_is_existing_patient, true, p_expected_generation,
    p_expected_google_calendar_id, p_automation_epoch, p_expected_summary, p_expected_ends_at
  );
end;
$$;

revoke all on function public.google_calendar_patient_name_key(text) from public, anon, authenticated, service_role;
revoke all on function public.convert_google_calendar_patient_import(text, uuid, text, text, public.patient_coverage, uuid, uuid, timestamptz, text, public.orthodontic_visit_type, boolean, boolean, bigint, text, uuid, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.convert_google_calendar_block_with_patient(text, uuid, text, text, public.patient_coverage, uuid, uuid, timestamptz, text, public.orthodontic_visit_type, boolean) from public, anon, authenticated, service_role;
grant execute on function public.convert_google_calendar_block_with_patient(text, uuid, text, text, public.patient_coverage, uuid, uuid, timestamptz, text, public.orthodontic_visit_type, boolean) to authenticated;
revoke all on function public.import_google_calendar_patient_appointment(text, uuid, text, text, public.patient_coverage, uuid, uuid, timestamptz, text, public.orthodontic_visit_type, boolean, bigint, text, uuid, text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.import_google_calendar_patient_appointment(text, uuid, text, text, public.patient_coverage, uuid, uuid, timestamptz, text, public.orthodontic_visit_type, boolean, bigint, text, uuid, text, timestamptz) to service_role;

-- Extend the existing privacy-preserving summary contract, without copying
-- earlier versions of its whitelist or its numeric validation.
do $migration$
declare
  previous text := pg_get_functiondef('public.sanitized_google_calendar_summary(jsonb)'::regprocedure);
  revised text;
begin
  revised := replace(previous, '''blocksImported''',
    '''appointmentsImported'', ''patientImportsNeedReview'', ''patientImportsFailed'', ''blocksImported''');
  if revised = previous then
    raise exception 'GOOGLE_CALENDAR_SUMMARY_DEFINITION_DRIFT';
  end if;
  execute revised;
end;
$migration$;

-- Older conversions may still have pending deposits. Preserve their historic
-- payment fields, but never let generic hold expiry cancel a Google booking
-- or abort a whole expiry batch on the read-only source guard.
do $migration$
declare
  target regprocedure;
  previous text;
  revised text;
begin
  foreach target in array array[
    'public.expire_booking_holds(timestamptz)'::regprocedure,
    'public.expire_overlapping_booking_holds(uuid,timestamptz,timestamptz,uuid,timestamptz)'::regprocedure,
    'public.expire_google_calendar_automation_booking_holds(uuid,bigint,text,timestamptz)'::regprocedure
  ] loop
    previous := pg_get_functiondef(target);
    revised := replace(previous, 'appointment.status = ''scheduled''',
      'appointment.status = ''scheduled'' and not appointment.google_calendar_imported');
    if revised = previous then raise exception 'GOOGLE_CALENDAR_IMPORTED_EXPIRATION_DEFINITION_DRIFT: %', target; end if;
    execute revised;
  end loop;
end;
$migration$;

-- Imported appointments cannot silently diverge from the manual Google event.
-- An ADMIN may accept an observed move/cancellation via the review RPC below;
-- the trigger permits only that exact, already-resolved source-backed change.
create function public.guard_google_calendar_imported_appointment()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if new.google_calendar_imported is distinct from old.google_calendar_imported then
    raise exception 'CALENDAR_IMPORTED_APPOINTMENT_READ_ONLY' using errcode = '55000';
  end if;
  if old.google_calendar_imported and (
    new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
    or (new.status = 'cancelled' and old.status <> 'cancelled')
  ) and not exists (
    select 1 from public.google_calendar_sync_conflicts conflict
    join public.google_calendar_external_events event
      on event.google_event_id = conflict.google_event_id
     and event.converted_appointment_id = old.id
     and event.connection_generation = conflict.connection_generation
    join public.google_calendar_connections connection
      on connection.id = true and connection.status = 'connected'
     and connection.google_calendar_id = event.google_calendar_id
     and connection.connection_generation = event.connection_generation
    where conflict.appointment_id = old.id and conflict.status = 'applied'
      and conflict.observed_starts_at = old.starts_at
      and conflict.observed_ends_at = old.ends_at
      and (
        (conflict.kind = 'reschedule_requested' and event.removed_at is null
          and new.starts_at = conflict.proposed_starts_at and new.ends_at = conflict.proposed_ends_at
          and new.starts_at = event.starts_at and new.ends_at = event.ends_at)
        or (conflict.kind = 'cancellation_requested' and event.removed_at is not null
          and new.status = 'cancelled' and new.starts_at = old.starts_at and new.ends_at = old.ends_at)
      )
  ) then
    raise exception 'CALENDAR_IMPORTED_APPOINTMENT_READ_ONLY' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger ac_google_calendar_imported_appointment_guard
before update on public.appointments
for each row execute function public.guard_google_calendar_imported_appointment();

create function public.observe_google_calendar_imported_event(
  p_event public.google_calendar_external_events,
  p_removed boolean, p_kind text, p_summary text,
  p_starts_at timestamptz, p_ends_at timestamptz,
  p_all_day boolean, p_recurring boolean,
  p_google_etag text, p_google_updated_at timestamptz
)
returns text language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  appointment_row public.appointments%rowtype;
  conflict_kind text;
  valid_range boolean := p_starts_at is not null and p_ends_at is not null and p_starts_at < p_ends_at;
begin
  select * into appointment_row from public.appointments
  where id = p_event.converted_appointment_id;
  if not found then return 'skipped_converted'; end if;

  -- Preserve summary as the identity baseline chosen at conversion. A new
  -- title must not silently assign an existing appointment to another person.
  update public.google_calendar_external_events
  set starts_at = case when not coalesce(p_removed, false) and valid_range then p_starts_at else starts_at end,
      ends_at = case when not coalesce(p_removed, false) and valid_range then p_ends_at else ends_at end,
      all_day = coalesce(p_all_day, false), recurring = coalesce(p_recurring, false),
      google_etag = p_google_etag, google_updated_at = p_google_updated_at,
      removed_at = case when coalesce(p_removed, false) then coalesce(removed_at, clock_timestamp()) else null end,
      external_cleanup_status = case when coalesce(p_removed, false) then 'done' else 'pending' end
  where google_calendar_id = p_event.google_calendar_id and google_event_id = p_event.google_event_id;

  if coalesce(p_removed, false) then
    if appointment_row.status in ('scheduled', 'confirmed') then
      conflict_kind := 'cancellation_requested';
    end if;
  elsif not valid_range or p_kind <> 'block' or coalesce(p_all_day, false) or coalesce(p_recurring, false)
    or p_summary is distinct from p_event.summary
  then
    conflict_kind := 'metadata_changed';
  elsif p_starts_at is distinct from appointment_row.starts_at or p_ends_at is distinct from appointment_row.ends_at then
    conflict_kind := 'reschedule_requested';
  end if;

  if conflict_kind is null then
    update public.google_calendar_sync_conflicts
    set status = 'superseded', resolved_at = clock_timestamp(), resolution_error = null
    where appointment_id = appointment_row.id and google_event_id = p_event.google_event_id
      and connection_generation = p_event.connection_generation and status in ('pending', 'rejected');
    return 'unchanged';
  end if;
  insert into public.google_calendar_sync_conflicts as current_conflict (
    appointment_id, google_event_id, kind, status, proposed_starts_at, proposed_ends_at,
    observed_starts_at, observed_ends_at, google_updated_at, connection_generation
  ) values (
    appointment_row.id, p_event.google_event_id, conflict_kind, 'pending',
    case when conflict_kind = 'reschedule_requested' then p_starts_at end,
    case when conflict_kind = 'reschedule_requested' then p_ends_at end,
    appointment_row.starts_at, appointment_row.ends_at, p_google_updated_at, p_event.connection_generation
  ) on conflict (appointment_id) where status = 'pending' do update
  set kind = excluded.kind, proposed_starts_at = excluded.proposed_starts_at,
      proposed_ends_at = excluded.proposed_ends_at, observed_starts_at = excluded.observed_starts_at,
      observed_ends_at = excluded.observed_ends_at, google_updated_at = excluded.google_updated_at,
      detected_at = clock_timestamp()
  where current_conflict.kind is distinct from excluded.kind
    or current_conflict.proposed_starts_at is distinct from excluded.proposed_starts_at
    or current_conflict.proposed_ends_at is distinct from excluded.proposed_ends_at
    or current_conflict.google_updated_at is distinct from excluded.google_updated_at;
  return case when found then 'conflict_recorded' else 'conflict_pending' end;
end;
$$;

create function public.apply_imported_google_calendar_conflict(p_conflict_id uuid)
returns public.google_calendar_sync_conflicts
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  conflict_row public.google_calendar_sync_conflicts%rowtype;
  appointment_row public.appointments%rowtype;
  event_row public.google_calendar_external_events%rowtype;
  connection_row public.google_calendar_connections%rowtype;
  duration_value numeric;
begin
  if not public.current_user_is_admin() or auth.uid() is null then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  select appointment.* into appointment_row from public.appointments appointment
  join public.google_calendar_sync_conflicts conflict on conflict.appointment_id = appointment.id
  where conflict.id = p_conflict_id and appointment.google_calendar_imported;
  if not found then raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(appointment_row.professional_id::text, 0));
  if not pg_try_advisory_xact_lock_shared(hashtextextended('google_calendar_connection', 0)) then
    raise exception 'CALENDAR_NOT_READY' using errcode = 'P0001';
  end if;
  select * into connection_row from public.google_calendar_connections where id = true for share;
  select * into conflict_row from public.google_calendar_sync_conflicts where id = p_conflict_id for update;
  select * into appointment_row from public.appointments where id = appointment_row.id for update;
  if conflict_row.status = 'applied' then return conflict_row; end if;
  if conflict_row.status <> 'pending' then raise exception 'CONFLICT_NOT_PENDING' using errcode = 'P0001'; end if;
  if conflict_row.kind = 'metadata_changed' then
    raise exception 'GOOGLE_CALENDAR_METADATA_CONFLICT_REQUIRES_RESTORE' using errcode = '55000';
  end if;
  if not public.google_calendar_automation_scope_is_current(true)
    or not public.google_calendar_conflict_observation_covers(p_conflict_id)
  then
    raise exception 'GOOGLE_CALENDAR_CONFLICT_SCOPE_STALE' using errcode = '55000';
  end if;
  select * into event_row from public.google_calendar_external_events
  where converted_appointment_id = appointment_row.id
    and google_event_id = conflict_row.google_event_id
    and google_calendar_id = connection_row.google_calendar_id
    and connection_generation = connection_row.connection_generation for update;
  if not found or appointment_row.status not in ('scheduled', 'confirmed')
    or conflict_row.observed_starts_at is distinct from appointment_row.starts_at
    or conflict_row.observed_ends_at is distinct from appointment_row.ends_at
    or (conflict_row.kind = 'cancellation_requested' and event_row.removed_at is null)
    or (conflict_row.kind = 'reschedule_requested' and (
      event_row.removed_at is not null or event_row.all_day or event_row.recurring
      or conflict_row.proposed_starts_at is distinct from event_row.starts_at
      or conflict_row.proposed_ends_at is distinct from event_row.ends_at
    ))
  then
    raise exception 'GOOGLE_CALENDAR_CONFLICT_SNAPSHOT_STALE' using errcode = '40001';
  end if;

  -- Resolved before UPDATE so the trigger can authenticate the exact review
  -- decision. Any later check failure rolls back the resolution too.
  update public.google_calendar_sync_conflicts
  set status = 'applied', resolved_at = clock_timestamp(), resolved_by = auth.uid(), resolution_error = null
  where id = p_conflict_id returning * into conflict_row;
  if conflict_row.kind = 'cancellation_requested' then
    perform public.update_appointment_status(appointment_row.id, 'cancelled');
  else
    duration_value := extract(epoch from (event_row.ends_at - event_row.starts_at)) / 60;
    if duration_value not between 5 and 480 or duration_value <> trunc(duration_value)
      or event_row.starts_at <= clock_timestamp()
    then
      raise exception 'GOOGLE_CALENDAR_CONFLICT_RANGE_INVALID' using errcode = '22023';
    end if;
    begin
      update public.appointments
      set starts_at = event_row.starts_at, ends_at = event_row.ends_at, duration_minutes = duration_value::integer
      where id = appointment_row.id;
    exception when exclusion_violation then
      raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
    end;
    if not public.appointment_slot_is_free_for(appointment_row.id) then
      raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
    end if;
  end if;
  return conflict_row;
end;
$$;

revoke all on function public.guard_google_calendar_imported_appointment() from public, anon, authenticated, service_role;
revoke all on function public.observe_google_calendar_imported_event(public.google_calendar_external_events, boolean, text, text, timestamptz, timestamptz, boolean, boolean, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.apply_imported_google_calendar_conflict(uuid) from public, anon, authenticated, service_role;

-- Retain the existing inbound lease validation and admin review authorization;
-- replace only the old converted-event early exit and route linked reviews.
do $migration$
declare
  previous text;
  revised text;
begin
  previous := pg_get_functiondef('public.apply_google_calendar_external_event(bigint,uuid,text,text,boolean,text,timestamptz,timestamptz,boolean,boolean,text,text,timestamptz)'::regprocedure);
  revised := replace(previous, 'return ''skipped_converted'';',
    'return public.observe_google_calendar_imported_event(existing, coalesce(p_removed, false) and p_unsupported_reason is distinct from ''PAST_EVENT'' and p_unsupported_reason is distinct from ''TRANSPARENT_EVENT'', p_kind, clean_summary, p_starts_at, p_ends_at, p_all_day, p_recurring, p_google_etag, p_google_updated_at);');
  if revised = previous then raise exception 'GOOGLE_CALENDAR_OBSERVER_DEFINITION_DRIFT'; end if;
  execute revised;

  previous := pg_get_functiondef('public.apply_google_calendar_conflict(uuid)'::regprocedure);
  revised := replace(previous, '  -- Serializa apply', E'  if exists (select 1 from public.appointments appointment join public.google_calendar_sync_conflicts conflict on conflict.appointment_id = appointment.id where conflict.id = p_conflict_id and appointment.google_calendar_imported) then\n    return public.apply_imported_google_calendar_conflict(p_conflict_id);\n  end if;\n\n  -- Serializa apply');
  if revised = previous then raise exception 'GOOGLE_CALENDAR_REVIEW_DEFINITION_DRIFT'; end if;
  execute revised;

  previous := pg_get_functiondef('public.reject_google_calendar_conflict(uuid)'::regprocedure);
  revised := replace(previous, E'  update public.google_calendar_sync_conflicts\n  set status = ''rejected'',',
    E'  if exists (select 1 from public.appointments where id = conflict_row.appointment_id and google_calendar_imported) then\n    raise exception ''CALENDAR_IMPORTED_APPOINTMENT_READ_ONLY'' using errcode = ''55000'';\n  end if;\n\n  update public.google_calendar_sync_conflicts\n  set status = ''rejected'',');
  if revised = previous then raise exception 'GOOGLE_CALENDAR_IMPORTED_REJECT_DEFINITION_DRIFT'; end if;
  execute revised;

  -- A windowed full pull cannot prove that an unseen source was deleted: it
  -- may have moved outside the observation window. Only explicit tombstones
  -- above open cancellation review.

  previous := pg_get_functiondef('public.google_calendar_automation_appointment_stage(uuid,uuid,text,text,bigint,timestamptz)'::regprocedure);
  revised := replace(previous, '  if not found then return null; end if;', E'  if not found then return null; end if;\n  if appointment_row.google_calendar_imported then return null; end if;');
  if revised = previous then raise exception 'GOOGLE_CALENDAR_IMPORTED_STAGE_DEFINITION_DRIFT'; end if;
  execute revised;

  previous := pg_get_functiondef('public.rescope_google_calendar_external_events()'::regprocedure);
  revised := replace(previous, E'where status = ''active''\n      and google_calendar_id = new.google_calendar_id',
    E'where status in (''active'', ''converted'')\n      and google_calendar_id = new.google_calendar_id');
  if revised = previous then raise exception 'GOOGLE_CALENDAR_IMPORTED_RESCOPE_DEFINITION_DRIFT'; end if;
  execute revised;

  previous := pg_get_functiondef('public.appointment_google_calendar_projection(uuid)'::regprocedure);
  revised := replace(previous, '  select * into job_row', E'  if appointment_row.google_calendar_imported then\n    if appointment_row.status = ''confirmed'' and exists (\n      select 1 from public.google_calendar_external_events event\n      where event.converted_appointment_id = appointment_row.id\n        and event.google_calendar_id = connection_row.google_calendar_id\n        and event.connection_generation = connection_row.connection_generation\n        and event.status = ''converted'' and event.removed_at is null\n        and not event.all_day and not event.recurring\n        and event.starts_at = appointment_row.starts_at and event.ends_at = appointment_row.ends_at\n    ) and public.appointment_slot_is_free_for(appointment_row.id) then\n      return jsonb_build_object(''state'', ''synced'', ''projectionStage'', ''confirmed'', ''source'', ''google_calendar'');\n    end if;\n    return jsonb_build_object(''state'', ''unavailable'', ''projectionStage'', null, ''source'', ''google_calendar'');\n  end if;\n\n  select * into job_row');
  if revised = previous then raise exception 'GOOGLE_CALENDAR_IMPORTED_PROJECTION_DEFINITION_DRIFT'; end if;
  execute revised;
end;
$migration$;

notify pgrst, 'reload schema';
