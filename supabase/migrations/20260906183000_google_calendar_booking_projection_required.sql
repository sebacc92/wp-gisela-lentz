-- This is a single Calendar-backed practice. Offline local bookings must not
-- bypass Calendar, and a durable queue item must not be presented as synced.
do $migration$
declare
  target regprocedure;
  prior_definition text;
  guarded_definition text;
  marker text := E'  for share;\n  if not found then return false; end if;\n';
  guard text := E'  for share;\n  if not found then return false; end if;\n\n  if not public.google_calendar_automation_scope_is_current(false) then\n    return false;\n  end if;\n';
begin
  foreach target in array array[
    'public.appointment_slot_is_available(uuid,timestamptz,integer,uuid,text)'::regprocedure,
    'public.appointment_slot_is_free_for(uuid)'::regprocedure
  ] loop
    prior_definition := pg_get_functiondef(target);
    -- The existing shared Calendar barrier remains held until commit.
    guarded_definition := replace(prior_definition, marker, guard);
    if guarded_definition = prior_definition then
      raise exception 'GOOGLE_CALENDAR_REQUIRED_BOOKING_DEFINITION_DRIFT: %', target;
    end if;
    execute guarded_definition;
  end loop;

  foreach target in array array[
    'public.create_whatsapp_automation_appointment(uuid,uuid,uuid,uuid,uuid,timestamptz)'::regprocedure,
    'public.reschedule_whatsapp_automation_appointment(uuid,uuid,uuid,timestamptz)'::regprocedure,
    'public.process_automated_deposit_proof(uuid,uuid,uuid,jsonb,text,text,boolean)'::regprocedure
  ] loop
    prior_definition := pg_get_functiondef(target);
    guarded_definition := replace(
      prior_definition,
      'coalesce(calendar_requires_observation, false)',
      'true'
    );
    if guarded_definition = prior_definition then
      raise exception 'GOOGLE_CALENDAR_REQUIRED_OBSERVATION_DEFINITION_DRIFT: %', target;
    end if;
    execute guarded_definition;
  end loop;
end;
$migration$;

-- Keep availability enumeration boolean, but distinguish a disconnected
-- integration from a busy slot when a person submits a reservation.
do $migration$
declare
  target regprocedure;
  prior_definition text;
  guarded_definition text;
  marker text := '  if not public.appointment_slot_is_available(';
  guard text := E'  if not public.google_calendar_automation_scope_is_current(false) then\n    raise exception ''CALENDAR_NOT_READY'' using errcode = ''P0001'';\n  end if;\n\n  if not public.appointment_slot_is_available(';
begin
  foreach target in array array[
    'public.create_service_appointment(uuid,uuid,uuid,timestamptz,public.appointment_source,text)'::regprocedure,
    'public.reschedule_appointment(uuid,timestamptz)'::regprocedure
  ] loop
    prior_definition := pg_get_functiondef(target);
    guarded_definition := replace(prior_definition, marker, guard);
    if guarded_definition = prior_definition then
      raise exception 'GOOGLE_CALENDAR_BOOKING_ERROR_DEFINITION_DRIFT: %', target;
    end if;
    execute guarded_definition;
  end loop;
end;
$migration$;

create or replace function public.appointment_google_calendar_projection(
  p_appointment_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  appointment_row public.appointments%rowtype;
  connection_row public.google_calendar_connections%rowtype;
  job_row public.google_calendar_sync_jobs%rowtype;
  expected_stage text;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.current_user_is_active()
  then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  if not pg_try_advisory_xact_lock_shared(
    hashtextextended('google_calendar_connection', 0)
  ) then
    return jsonb_build_object('state', 'pending', 'projectionStage', null);
  end if;
  select * into connection_row
  from public.google_calendar_connections where id = true for share;
  if not found or not public.google_calendar_automation_scope_is_current(false)
  then
    return jsonb_build_object('state', 'unavailable', 'projectionStage', null);
  end if;

  select * into appointment_row
  from public.appointments where id = p_appointment_id for share;
  if not found then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.google_calendar_sync_conflicts conflict
    where conflict.appointment_id = p_appointment_id
      and conflict.connection_generation = connection_row.connection_generation
      and conflict.status = 'pending'
  ) then
    return jsonb_build_object('state', 'conflict', 'projectionStage', null);
  end if;

  select * into job_row
  from public.google_calendar_sync_jobs job
  where job.appointment_id = p_appointment_id
    and job.automation_epoch = connection_row.automation_epoch
    and job.authorized_google_account_id = connection_row.google_account_id
    and job.authorized_google_calendar_id = connection_row.google_calendar_id
    and job.authorized_connection_generation = connection_row.connection_generation;
  if not found then
    return jsonb_build_object('state', 'pending', 'projectionStage', null);
  end if;
  expected_stage := public.google_calendar_automation_appointment_stage(
    p_appointment_id,
    job_row.automation_epoch,
    job_row.authorized_google_account_id,
    job_row.authorized_google_calendar_id,
    job_row.authorized_connection_generation,
    clock_timestamp()
  );
  if expected_stage is null then
    return jsonb_build_object('state', 'unavailable', 'projectionStage', null);
  end if;

  if job_row.status = 'succeeded'
    and job_row.operation = 'upsert'
    and job_row.projected_operation = 'upsert'
    and job_row.google_event_id is not null
    and job_row.projection_stage = expected_stage
    and job_row.projected_stage = expected_stage
    and job_row.projected_starts_at = appointment_row.starts_at
    and job_row.projected_ends_at = appointment_row.ends_at
    and job_row.last_error is null
    and public.appointment_slot_is_free_for(p_appointment_id)
  then
    return jsonb_build_object('state', 'synced', 'projectionStage', expected_stage);
  end if;
  return jsonb_build_object('state', 'pending', 'projectionStage', expected_stage);
end;
$$;

revoke execute on function public.appointment_google_calendar_projection(uuid)
  from public, anon;
grant execute on function public.appointment_google_calendar_projection(uuid)
  to authenticated, service_role;
