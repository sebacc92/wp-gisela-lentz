-- Orthodontic follow-up is an explicit per-booking choice, never inferred
-- from whether the contact has visited the practice before. Existing bookings
-- retain NULL and every deposit already recorded remains unchanged.
create type public.orthodontic_visit_type as enum ('first_visit', 'in_treatment');

alter table public.services
  add column requires_orthodontic_intake boolean not null default false;
alter table public.appointments
  add column orthodontic_visit_type public.orthodontic_visit_type;

do $migration$
begin
  update public.services
  set requires_orthodontic_intake = true
  where id = '51000000-0000-4000-8000-000000000007'::uuid;
  if not found then
    raise exception 'ORTHODONTICS_SERVICE_NOT_FOUND';
  end if;
end;
$migration$;

comment on column public.services.requires_orthodontic_intake is
  'Identidad de servicio que requiere elegir Primera vez o En tratamiento con Gisela al reservar. No depende de su nombre visible.';
comment on column public.appointments.orthodontic_visit_type is
  'Elección inmutable de esta reserva. NULL en otros servicios y turnos históricos; in_treatment no requiere seña, aun al reprogramar.';

alter table public.appointments
  add constraint appointments_orthodontic_treatment_no_deposit_check check (
    orthodontic_visit_type is distinct from 'in_treatment'::public.orthodontic_visit_type
    or (
      deposit_status = 'not_required'
      and status <> 'scheduled'
      and hold_expires_at is null
      and deposit_expected_amount_ars is null
      and deposit_expected_alias is null
      and deposit_expected_holder is null
      and deposit_proof_message_id is null
      and deposit_proof_received_at is null
      and deposit_confirmed_at is null
      and hold_expired_notification_status = 'not_applicable'
    )
  );

create or replace function public.enforce_appointment_orthodontic_intake()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  intake_required boolean := false;
begin
  if tg_op = 'UPDATE' then
    if new.orthodontic_visit_type is distinct from old.orthodontic_visit_type
      or (
        old.orthodontic_visit_type is not null
        and new.service_id is distinct from old.service_id
      )
    then
      raise exception 'ORTHODONTIC_VISIT_TYPE_IMMUTABLE' using errcode = '23514';
    end if;
    -- Editing/rescheduling historical bookings must not reclassify them.
    if new.service_id is not distinct from old.service_id then
      return new;
    end if;
  end if;

  select service.requires_orthodontic_intake into intake_required
  from public.services service
  where service.id = new.service_id
  for share;
  if coalesce(intake_required, false) then
    if new.orthodontic_visit_type is null then
      raise exception 'ORTHODONTIC_VISIT_TYPE_REQUIRED' using errcode = 'P0001';
    end if;
  elsif new.orthodontic_visit_type is not null then
    raise exception 'ORTHODONTIC_VISIT_TYPE_NOT_APPLICABLE' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;

create trigger ab_appointments_orthodontic_intake
before insert or update on public.appointments
for each row execute function public.enforce_appointment_orthodontic_intake();

revoke execute on function public.enforce_appointment_orthodontic_intake()
  from public, anon, authenticated, service_role;

-- Remove old signatures without CASCADE, avoiding ambiguous PostgREST
-- overloads. A trailing default keeps existing non-orthodontic callers valid.
drop function public.create_service_appointment(uuid, uuid, uuid, timestamptz, public.appointment_source, text);
drop function public.create_whatsapp_automation_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz);
drop function public.convert_google_calendar_block_to_appointment(text, uuid, uuid, uuid, timestamptz, text);

create or replace function public.create_service_appointment(
  p_contact_id uuid,
  p_professional_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_source public.appointment_source default 'manual',
  p_internal_note text default null,
  p_orthodontic_visit_type public.orthodontic_visit_type default null
)
returns public.appointments
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  contact_coverage public.patient_coverage;
  intake_required boolean;
  requires_deposit boolean;
  effective_duration integer;
  settings public.app_settings%rowtype;
  requested_ends_with_buffer timestamptz;
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not public.current_user_is_active() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  select service.requires_orthodontic_intake into intake_required
  from public.services service
  where service.id = p_service_id and service.active
  for share;
  if not found then
    raise exception 'SERVICE_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  if intake_required and p_orthodontic_visit_type is null then
    raise exception 'ORTHODONTIC_VISIT_TYPE_REQUIRED' using errcode = 'P0001';
  end if;
  if not intake_required and p_orthodontic_visit_type is not null then
    raise exception 'ORTHODONTIC_VISIT_TYPE_NOT_APPLICABLE' using errcode = 'P0001';
  end if;

  select contact.coverage into contact_coverage
  from public.contacts contact where contact.id = p_contact_id;
  if contact_coverage is null then
    raise exception 'COVERAGE_REQUIRED' using errcode = 'P0001';
  end if;
  select * into settings from public.app_settings app_settings
  where app_settings.id = true;
  if not found then
    raise exception 'APP_SETTINGS_NOT_FOUND' using errcode = 'P0002';
  end if;
  requires_deposit := settings.deposit_enabled
    and p_orthodontic_visit_type is distinct from 'in_treatment'::public.orthodontic_visit_type;
  effective_duration := case contact_coverage
    when 'ioma' then settings.ioma_duration_minutes
    when 'particular' then settings.private_duration_minutes
  end;
  requested_ends_with_buffer := p_starts_at + make_interval(
    mins => effective_duration + settings.appointment_buffer_minutes
  );

  perform pg_advisory_xact_lock(
    hashtextextended(p_professional_id::text, 0)
  );

  -- First validate without changing any hold. In particular, a stale or
  -- partial Calendar observation cannot cause cleanup as a side effect.
  if not public.google_calendar_automation_scope_is_current(false) then
    raise exception 'CALENDAR_NOT_READY' using errcode = 'P0001';
  end if;

  if not public.appointment_slot_is_available(
    p_professional_id, p_starts_at, effective_duration, null, settings.timezone
  ) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  perform public.expire_overlapping_booking_holds(
    p_professional_id,
    p_starts_at,
    requested_ends_with_buffer,
    null,
    clock_timestamp()
  );
  if not public.google_calendar_automation_scope_is_current(false) then
    raise exception 'CALENDAR_NOT_READY' using errcode = 'P0001';
  end if;

  if not public.appointment_slot_is_available(
    p_professional_id, p_starts_at, effective_duration, null, settings.timezone
  ) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  begin
    insert into public.appointments (
      contact_id, professional_id, service_id, starts_at, ends_at,
      status, source, created_by, internal_note, coverage, duration_minutes,
      deposit_status, hold_expires_at, hold_expired_notification_status,
      orthodontic_visit_type
    ) values (
      p_contact_id, p_professional_id, p_service_id, p_starts_at,
      p_starts_at + make_interval(mins => effective_duration),
      case when requires_deposit
        then 'scheduled'::public.appointment_status
        else 'confirmed'::public.appointment_status end,
      p_source, auth.uid(), p_internal_note, contact_coverage,
      effective_duration,
      case when requires_deposit
        then 'pending'::public.deposit_status
        else 'not_required'::public.deposit_status end,
      case when requires_deposit
        then clock_timestamp()
          + make_interval(mins => settings.booking_hold_minutes)
        else null end,
      case when requires_deposit then 'pending' else 'not_applicable' end,
      p_orthodontic_visit_type
    ) returning * into result;
  exception when exclusion_violation then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end;
  return result;
end;
$function$;

create or replace function public.create_whatsapp_automation_appointment(
  p_message_id uuid,
  p_lease_token uuid,
  p_contact_id uuid,
  p_professional_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_orthodontic_visit_type public.orthodontic_visit_type default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  existing_effect public.whatsapp_automation_effects%rowtype;
  appointment_row public.appointments%rowtype;
  request_value jsonb;
  result_value jsonb;
  target_ends_with_buffer timestamptz;
  calendar_requires_observation boolean;
begin
  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );
  if execution_row.contact_id <> p_contact_id then
    raise exception 'WHATSAPP_AUTOMATION_CONTACT_MISMATCH'
      using errcode = '23514';
  end if;
  request_value := jsonb_build_object(
    'contact_id', p_contact_id,
    'professional_id', p_professional_id,
    'service_id', p_service_id,
    'starts_at', p_starts_at,
    'orthodontic_visit_type', p_orthodontic_visit_type
  );

  select effect.* into existing_effect
  from public.whatsapp_automation_effects effect
  where effect.execution_message_id = p_message_id
    and effect.effect_key = 'appointment:create';
  if found then
    if existing_effect.effect_type <> 'appointment_create'
      or (existing_effect.request || jsonb_build_object(
        'orthodontic_visit_type', existing_effect.request -> 'orthodontic_visit_type'
      )) <> request_value then
      raise exception 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT'
        using errcode = '23514';
    end if;
    return existing_effect.result;
  end if;

  select connection.status in ('connected', 'reconnect_required')
    into calendar_requires_observation
  from public.google_calendar_connections connection
  where connection.id = true;

  select p_starts_at + make_interval(
    mins => public.coverage_duration_minutes(contact.coverage)
      + settings.appointment_buffer_minutes
  ) into target_ends_with_buffer
  from public.contacts contact
  cross join public.app_settings settings
  where contact.id = p_contact_id and settings.id = true;

  if true
    and not public.google_calendar_booking_observation_covers(
      execution_row.processing_started_at,
      p_starts_at,
      target_ends_with_buffer,
      null
    )
  then
    result_value := jsonb_build_object(
      'effect_status', 'rejected',
      'error_code', 'CALENDAR_AVAILABILITY_UNAVAILABLE'
    );
  else
    begin
      appointment_row := public.create_service_appointment(
        p_contact_id,
        p_professional_id,
        p_service_id,
        p_starts_at,
        'whatsapp'::public.appointment_source,
        null,
        p_orthodontic_visit_type
      );
      result_value := to_jsonb(appointment_row);
    exception when raise_exception then
      if sqlerrm = 'SLOT_UNAVAILABLE' then
        result_value := jsonb_build_object(
          'effect_status', 'rejected',
          'error_code', 'SLOT_UNAVAILABLE'
        );
      else
        raise;
      end if;
    end;
  end if;

  insert into public.whatsapp_automation_effects (
    execution_message_id,
    effect_key,
    effect_type,
    request,
    result,
    appointment_id
  ) values (
    p_message_id,
    'appointment:create',
    'appointment_create',
    request_value,
    result_value,
    case
      when result_value ->> 'effect_status' = 'rejected' then null
      else appointment_row.id
    end
  );
  return result_value;
end;
$function$;

create or replace function public.convert_google_calendar_block_to_appointment(
  p_google_event_id text,
  p_contact_id uuid,
  p_professional_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz default null,
  p_internal_note text default null,
  p_orthodontic_visit_type public.orthodontic_visit_type default null
)
returns table (appointment_id uuid, created boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  current_calendar_id text;
  current_generation bigint;
  block_row public.google_calendar_external_events%rowtype;
  new_appointment public.appointments;
begin
  if not public.current_user_is_admin() or auth.uid() is null then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select connection.google_calendar_id, connection.connection_generation
  into current_calendar_id, current_generation
  from public.google_calendar_connections connection
  where connection.id = true
    and connection.status = 'connected'
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = connection.connection_generation;
  if current_calendar_id is null then
    raise exception 'CALENDAR_NOT_CONNECTED' using errcode = 'P0001';
  end if;

  select * into block_row
  from public.google_calendar_external_events event
  where event.google_calendar_id = current_calendar_id
    and event.google_event_id = p_google_event_id
    and event.connection_generation = current_generation
  for update;
  if not found then
    raise exception 'CALENDAR_BLOCK_NOT_FOUND' using errcode = 'P0002';
  end if;

  if block_row.status = 'converted' then
    if not exists (
      select 1 from public.appointments appointment
      where appointment.id = block_row.converted_appointment_id
        and appointment.contact_id = p_contact_id
        and appointment.professional_id = p_professional_id
        and appointment.service_id is not distinct from p_service_id
        and appointment.orthodontic_visit_type is not distinct from p_orthodontic_visit_type
    ) then
      raise exception 'CALENDAR_BLOCK_CONVERSION_CONFLICT' using errcode = '23514';
    end if;
    return query select block_row.converted_appointment_id, false;
    return;
  end if;
  if block_row.status <> 'active' or block_row.kind <> 'block' then
    raise exception 'CALENDAR_BLOCK_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if p_starts_at is null or p_starts_at is distinct from block_row.starts_at then
    raise exception 'CALENDAR_BLOCK_STALE' using errcode = '55000';
  end if;

  update public.google_calendar_external_events event
  set status = 'removed', removed_at = clock_timestamp()
  where event.google_calendar_id = current_calendar_id
    and event.google_event_id = p_google_event_id
    and event.connection_generation = current_generation;

  new_appointment := public.create_service_appointment(
    p_contact_id, p_professional_id, p_service_id, block_row.starts_at,
    'manual'::public.appointment_source, p_internal_note, p_orthodontic_visit_type
  );

  update public.google_calendar_external_events event
  set status = 'converted',
      converted_appointment_id = new_appointment.id,
      external_cleanup_status = 'pending',
      external_cleanup_error = null
  where event.google_calendar_id = current_calendar_id
    and event.google_event_id = p_google_event_id
    and event.connection_generation = current_generation;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(), 'google_calendar.block_converted', 'appointment',
    new_appointment.id, jsonb_build_object('cleanup', 'pending')
  );

  return query select new_appointment.id, true;
end;
$function$;

revoke execute on function public.create_service_appointment(uuid, uuid, uuid, timestamptz, public.appointment_source, text, public.orthodontic_visit_type)
  from public, anon;
revoke execute on function public.create_whatsapp_automation_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz, public.orthodontic_visit_type)
  from public, anon, authenticated;
revoke execute on function public.convert_google_calendar_block_to_appointment(text, uuid, uuid, uuid, timestamptz, text, public.orthodontic_visit_type)
  from public, anon;
grant execute on function public.create_service_appointment(uuid, uuid, uuid, timestamptz, public.appointment_source, text, public.orthodontic_visit_type)
  to authenticated, service_role;
grant execute on function public.create_whatsapp_automation_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz, public.orthodontic_visit_type)
  to service_role;
grant execute on function public.convert_google_calendar_block_to_appointment(text, uuid, uuid, uuid, timestamptz, text, public.orthodontic_visit_type)
  to authenticated, service_role;

-- Confirmation messages are part of the same automated conversation quota.
-- Giving a no-deposit confirmation its own source must not reset that budget.
do $migration$
declare
  prior_definition text;
  guarded_definition text;
begin
  prior_definition := pg_get_functiondef('public.enforce_whatsapp_outbound_policy()'::regprocedure);
  guarded_definition := replace(
    prior_definition,
    $marker$new.metadata ->> 'source' = 'automation'$marker$,
    $marker$new.metadata ->> 'source' in ('automation', 'deposit_confirmation', 'appointment_confirmation')$marker$
  );
  guarded_definition := replace(
    guarded_definition,
    $marker$message.metadata ->> 'source' = 'automation'$marker$,
    $marker$message.metadata ->> 'source' in ('automation', 'deposit_confirmation', 'appointment_confirmation')$marker$
  );
  if guarded_definition = prior_definition
    or position($marker$metadata ->> 'source' = 'automation'$marker$ in guarded_definition) > 0
  then
    raise exception 'WHATSAPP_AUTOMATION_RATE_POLICY_DEFINITION_DRIFT';
  end if;
  execute guarded_definition;
end;
$migration$;

notify pgrst, 'reload schema';
