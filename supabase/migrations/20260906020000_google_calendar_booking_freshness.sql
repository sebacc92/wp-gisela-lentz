-- Booking decisions must be based on a complete Google observation made for
-- the same bot execution. A shared row lock serializes the final database
-- decision with the start/completion of inbound Calendar imports.

-- Keep one lock order around the Calendar barrier. Booking mutations use the
-- shared form; conflict application, connection lifecycle, inbound lease
-- start and outbound claim/completion retain the exclusive form.
-- Enqueue triggers must never wait behind an exclusive waiter while holding an
-- appointment/contact row: they try the shared lock and roll back so the whole
-- domain mutation can be retried safely.
create or replace function public.acquire_google_calendar_enqueue_barrier()
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if not pg_try_advisory_xact_lock_shared(
    hashtextextended('google_calendar_connection', 0)
  ) then
    raise exception 'GOOGLE_CALENDAR_ENQUEUE_BUSY' using errcode = '40001';
  end if;
end;
$$;

revoke execute on function public.acquire_google_calendar_enqueue_barrier()
  from public, anon, authenticated, service_role;

-- While an outbound mutation is processing, or waiting to retry after an
-- attempt, the database cannot prove which remote range Google accepted. The
-- safe fallback is to stop all new booking decisions until that exact current
-- epoch job reaches a successful terminal projection.
create or replace function public.google_calendar_has_uncertain_outbound_mutation()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.google_calendar_sync_jobs job
    join public.google_calendar_connections connection
      on connection.id = true
     and connection.status = 'connected'
     and connection.automation_enabled
     and connection.automation_epoch = job.automation_epoch
     and connection.google_account_id = job.authorized_google_account_id
     and connection.google_calendar_id = job.authorized_google_calendar_id
     and connection.connection_generation =
       job.authorized_connection_generation
     and connection.automation_connection_generation =
       job.authorized_connection_generation
    where job.status = 'processing'
       or (
         job.status in ('pending', 'failed')
         and job.attempts > 0
       )
  );
$$;

revoke execute on function public.google_calendar_has_uncertain_outbound_mutation()
  from public, anon, authenticated, service_role;

-- Rejecting an externally moved managed event asks the outbound worker to
-- restore the authoritative local projection. Until Google acknowledges that
-- exact restore (or an exact delete), the remotely observed destination stays
-- occupied. Merely changing the conflict status must never reopen the range.
create or replace function public.google_calendar_conflict_range_is_occupied(
  p_conflict_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce((
    select case
      when conflict.kind <> 'reschedule_requested' then false
      when conflict.status = 'pending' then true
      when conflict.status <> 'rejected'
        or conflict.resolved_at is null then false
      else not exists (
        select 1
        from public.google_calendar_sync_jobs job
        join public.google_calendar_connections connection
          on connection.id = true
         and connection.connection_generation =
           conflict.connection_generation
         and connection.automation_enabled
         and connection.automation_epoch = job.automation_epoch
         and connection.google_account_id =
           job.authorized_google_account_id
         and connection.google_calendar_id =
           job.authorized_google_calendar_id
         and connection.connection_generation =
           job.authorized_connection_generation
        where job.appointment_id = conflict.appointment_id
          and job.google_event_id = conflict.google_event_id
          and job.status = 'succeeded'
          and job.updated_at >= conflict.resolved_at
          and (
            (
              job.projected_operation = 'upsert'
              and job.projected_starts_at is not distinct from
                conflict.observed_starts_at
              and job.projected_ends_at is not distinct from
                conflict.observed_ends_at
            )
            or job.projected_operation = 'delete'
          )
      )
    end
    from public.google_calendar_sync_conflicts conflict
    where conflict.id = p_conflict_id
  ), false);
$$;

revoke execute on function public.google_calendar_conflict_range_is_occupied(uuid)
  from public, anon, authenticated, service_role;

-- A pending conflict can only be applied after the inbound pull that created
-- (or most recently changed) it finished successfully. In particular, an
-- expired-but-still-owned lease is not treated as a complete observation: the
-- worker that owns it may still be writing the remaining occurrences.
create or replace function public.google_calendar_conflict_observation_covers(
  p_conflict_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  conflict_row public.google_calendar_sync_conflicts%rowtype;
  connection_row public.google_calendar_connections%rowtype;
  buffer_minutes integer;
  observed_starts_at timestamptz;
  observed_ends_at timestamptz;
begin
  select conflict.* into conflict_row
  from public.google_calendar_sync_conflicts conflict
  where conflict.id = p_conflict_id;
  if not found
    or conflict_row.status <> 'pending'
    or conflict_row.kind not in (
      'reschedule_requested', 'cancellation_requested'
    )
  then
    return false;
  end if;

  select settings.appointment_buffer_minutes into buffer_minutes
  from public.app_settings settings
  where settings.id = true;
  if buffer_minutes is null then return false; end if;

  if conflict_row.kind = 'reschedule_requested' then
    observed_starts_at := conflict_row.proposed_starts_at;
    observed_ends_at := conflict_row.proposed_ends_at;
  else
    observed_starts_at := conflict_row.observed_starts_at;
    observed_ends_at := conflict_row.observed_ends_at;
  end if;
  if observed_starts_at is null
    or observed_ends_at is null
    or observed_starts_at >= observed_ends_at
  then
    return false;
  end if;

  select connection.* into connection_row
  from public.google_calendar_connections connection
  where connection.id = true
  for share;
  if not found then return false; end if;

  if connection_row.status <> 'connected'
    or connection_row.connection_generation <>
      conflict_row.connection_generation
    or connection_row.sync_scope_generation is distinct from
      connection_row.connection_generation
    or connection_row.sync_scope_google_account_id is distinct from
      connection_row.google_account_id
    or connection_row.sync_scope_google_calendar_id is distinct from
      connection_row.google_calendar_id
    or connection_row.inbound_first_import_approved_at is null
    or connection_row.inbound_sync_state <> 'incremental'
    or connection_row.inbound_sync_token is null
    or connection_row.inbound_sync_token_generation is distinct from
      connection_row.connection_generation
    or connection_row.inbound_sync_contract_version <> 2
    or connection_row.inbound_sync_timezone is distinct from
      connection_row.google_calendar_timezone
    or connection_row.inbound_coverage_starts_at is null
    or connection_row.inbound_coverage_ends_at is null
    or observed_starts_at < connection_row.inbound_coverage_starts_at
    or observed_ends_at + make_interval(mins => buffer_minutes) >
      connection_row.inbound_coverage_ends_at
    or connection_row.last_sync_completed_at is null
    or connection_row.last_sync_completed_at < greatest(
      conflict_row.detected_at,
      conflict_row.updated_at
    )
    or connection_row.last_sync_completed_at <
      clock_timestamp() - interval '3 minutes'
    or connection_row.last_sync_error is not null
    or connection_row.last_error is not null
    or connection_row.inbound_lease_token is not null
    or connection_row.inbound_lease_expires_at is not null
    or public.google_calendar_has_uncertain_outbound_mutation()
  then
    return false;
  end if;

  return true;
end;
$$;

create or replace function public.google_calendar_conflict_slot_is_free(
  p_conflict_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  conflict_row public.google_calendar_sync_conflicts%rowtype;
  connection_row public.google_calendar_connections%rowtype;
  buffer_minutes integer;
  requested_range tstzrange;
  appointment_professional_id uuid;
begin
  select conflict.* into conflict_row
  from public.google_calendar_sync_conflicts conflict
  where conflict.id = p_conflict_id
    and conflict.status = 'pending'
    and conflict.kind = 'reschedule_requested';
  if not found
    or conflict_row.proposed_starts_at is null
    or conflict_row.proposed_ends_at is null
    or conflict_row.proposed_starts_at >= conflict_row.proposed_ends_at
  then
    return false;
  end if;

  select settings.appointment_buffer_minutes into buffer_minutes
  from public.app_settings settings
  where settings.id = true;
  if buffer_minutes is null then return false; end if;

  select connection.* into connection_row
  from public.google_calendar_connections connection
  where connection.id = true;
  if not found
    or connection_row.connection_generation <>
      conflict_row.connection_generation
  then
    return false;
  end if;

  requested_range := tstzrange(
    conflict_row.proposed_starts_at,
    conflict_row.proposed_ends_at + make_interval(mins => buffer_minutes),
    '[)'
  );

  if public.google_calendar_has_uncertain_outbound_mutation() then
    return false;
  end if;

  select appointment.professional_id into appointment_professional_id
  from public.appointments appointment
  where appointment.id = conflict_row.appointment_id;
  if appointment_professional_id is null then return false; end if;

  if exists (
    select 1
    from public.appointments other
    where other.id <> conflict_row.appointment_id
      and other.professional_id = appointment_professional_id
      and (
        other.status = 'confirmed'
        or (
          other.status = 'scheduled'
          and (
            other.deposit_status in ('proof_received', 'not_required')
            or (
              other.deposit_status = 'pending'
              and (
                other.hold_expires_at > clock_timestamp()
                or public.appointment_has_timely_deposit_proof_work(
                  other.id,
                  clock_timestamp()
                )
              )
            )
          )
        )
      )
      and tstzrange(
        other.starts_at,
        other.ends_at + make_interval(mins => buffer_minutes),
        '[)'
      ) && requested_range
  ) then
    return false;
  end if;

  if exists (
    select 1
    from public.google_calendar_sync_conflicts other_conflict
    where other_conflict.id <> conflict_row.id
      and public.google_calendar_conflict_range_is_occupied(other_conflict.id)
      and other_conflict.connection_generation =
        connection_row.connection_generation
      and other_conflict.proposed_starts_at is not null
      and other_conflict.proposed_ends_at is not null
      and other_conflict.proposed_starts_at < other_conflict.proposed_ends_at
      and tstzrange(
        other_conflict.proposed_starts_at,
        other_conflict.proposed_ends_at
          + make_interval(mins => buffer_minutes),
        '[)'
      ) && requested_range
  ) then
    return false;
  end if;

  if exists (
    select 1
    from public.google_calendar_sync_jobs job
    where job.appointment_id <> conflict_row.appointment_id
      and job.automation_epoch = connection_row.automation_epoch
      and job.authorized_google_account_id = connection_row.google_account_id
      and job.authorized_google_calendar_id = connection_row.google_calendar_id
      and job.authorized_connection_generation =
        connection_row.connection_generation
      and job.projected_operation = 'upsert'
      and job.projected_stage in ('pre_reservation', 'confirmed')
      and job.projected_starts_at is not null
      and job.projected_ends_at is not null
      and job.projected_starts_at < job.projected_ends_at
      and tstzrange(
        job.projected_starts_at,
        job.projected_ends_at + make_interval(mins => buffer_minutes),
        '[)'
      ) && requested_range
  ) then
    return false;
  end if;

  return true;
end;
$$;

revoke execute on function public.google_calendar_conflict_observation_covers(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.google_calendar_conflict_slot_is_free(uuid)
  from public, anon, authenticated, service_role;

-- These transformations are deliberately asserted against the immediately
-- previous definitions so a future drift aborts this migration instead of
-- weakening serialization silently.
do $migration$
declare
  target regprocedure;
  prior_definition text;
  guarded_definition text;
  exclusive_statement text := E'perform pg_advisory_xact_lock(\n    hashtextextended(''google_calendar_connection'', 0)\n  );';
  guarded_statement text :=
    'perform public.acquire_google_calendar_enqueue_barrier();';
begin
  foreach target in array array[
    'public.enqueue_google_calendar_appointment()'::regprocedure,
    'public.enqueue_google_calendar_contact_appointments()'::regprocedure
  ] loop
    prior_definition := pg_get_functiondef(target);
    guarded_definition := replace(
      prior_definition,
      exclusive_statement,
      guarded_statement
    );
    if guarded_definition = prior_definition
      or position(guarded_statement in prior_definition) > 0
      or position(exclusive_statement in guarded_definition) > 0
    then
      raise exception 'GOOGLE_CALENDAR_LOCK_DEFINITION_DRIFT: %', target;
    end if;
    execute guarded_definition;
  end loop;
end;
$migration$;

-- Coalescing a new local state after a response-lost Google attempt must not
-- erase the only durable evidence that a remote mutation may exist. A job
-- which was fully acknowledged (`succeeded`) starts the next change at zero;
-- pending/failed/processing attempts keep their counter until completion.
do $migration$
declare
  target regprocedure;
  prior_definition text;
  guarded_definition text;
  attempts_marker text := E'      attempts = case\n        when current_job.status = ''processing'' then current_job.attempts\n        else 0\n      end,';
  guarded_attempts_marker text := E'      attempts = case\n        when current_job.status = ''succeeded'' then 0\n        else current_job.attempts\n      end,';
begin
  foreach target in array array[
    'public.enqueue_google_calendar_appointment()'::regprocedure,
    'public.enqueue_google_calendar_contact_appointments()'::regprocedure
  ] loop
    prior_definition := pg_get_functiondef(target);
    guarded_definition := replace(
      prior_definition,
      attempts_marker,
      guarded_attempts_marker
    );
    if guarded_definition = prior_definition
      or position(guarded_attempts_marker in prior_definition) > 0
      or position(guarded_attempts_marker in guarded_definition) = 0
    then
      raise exception 'GOOGLE_CALENDAR_ATTEMPT_PRESERVATION_DRIFT: %', target;
    end if;
    execute guarded_definition;
  end loop;
end;
$migration$;

do $migration$
declare
  prior_definition text;
  guarded_definition text;
  attempts_marker text := E'        attempts = case\n          when current_job.status = ''processing'' then current_job.attempts\n          else 0\n        end,';
  guarded_attempts_marker text := E'        attempts = case\n          when current_job.status = ''succeeded'' then 0\n          else current_job.attempts\n        end,';
begin
  prior_definition := pg_get_functiondef(
    'public.reconcile_google_calendar_sync()'::regprocedure
  );
  guarded_definition := replace(
    prior_definition,
    attempts_marker,
    guarded_attempts_marker
  );
  if guarded_definition = prior_definition
    or position(guarded_attempts_marker in prior_definition) > 0
    or position(guarded_attempts_marker in guarded_definition) = 0
  then
    raise exception 'GOOGLE_CALENDAR_ATTEMPT_PRESERVATION_DRIFT: %',
      'public.reconcile_google_calendar_sync()'::regprocedure;
  end if;
  execute guarded_definition;
end;
$migration$;

do $migration$
declare
  prior_definition text;
  guarded_definition text;
  attempts_marker text := E'      attempts = case when current_job.status = ''processing''\n        then current_job.attempts else 0 end,';
  guarded_attempts_marker text := E'      attempts = case when current_job.status = ''succeeded''\n        then 0 else current_job.attempts end,';
begin
  prior_definition := pg_get_functiondef(
    'public.enqueue_google_calendar_projection(uuid)'::regprocedure
  );
  guarded_definition := replace(
    prior_definition,
    attempts_marker,
    guarded_attempts_marker
  );
  if guarded_definition = prior_definition
    or position(guarded_attempts_marker in prior_definition) > 0
    or position(guarded_attempts_marker in guarded_definition) = 0
  then
    raise exception 'GOOGLE_CALENDAR_LEGACY_PROJECTION_ATTEMPT_DRIFT';
  end if;
  execute guarded_definition;
end;
$migration$;

-- Reject also locks the conflict before it enqueues a restoring projection.
-- Take the exclusive barrier first so an inbound observer (shared barrier,
-- then job, then conflict) can never form a conflict/job lock-order cycle.
do $migration$
declare
  prior_definition text;
  guarded_definition text;
  begin_marker text := E'begin\n  if not public.current_user_is_admin()';
  guarded_begin_marker text := E'begin\n  perform pg_catalog.pg_advisory_xact_lock(\n    pg_catalog.hashtextextended(''google_calendar_connection'', 0)\n  );\n\n  if not public.current_user_is_admin()';
begin
  prior_definition := pg_get_functiondef(
    'public.reject_google_calendar_conflict(uuid)'::regprocedure
  );
  guarded_definition := replace(
    prior_definition,
    begin_marker,
    guarded_begin_marker
  );
  if guarded_definition = prior_definition
    or position(guarded_begin_marker in prior_definition) > 0
    or position(guarded_begin_marker in guarded_definition) = 0
  then
    raise exception 'GOOGLE_CALENDAR_REJECT_LOCK_DEFINITION_DRIFT';
  end if;
  execute guarded_definition;
end;
$migration$;

do $migration$
declare
  prior_definition text;
  guarded_definition text;
  exclusive_call text := E'pg_advisory_xact_lock(\n    hashtextextended(''google_calendar_connection'', 0)\n  )';
  scope_marker text := E'    or connection_row.inbound_first_import_approved_at is null\n  then';
  guarded_scope_marker text := E'    or connection_row.inbound_first_import_approved_at is null\n    or not public.google_calendar_conflict_observation_covers(\n      conflict_row.id\n    )\n  then';
  cancellation_marker text := E'  if conflict_row.kind = ''cancellation_requested'' then\n';
  guarded_cancellation_marker text := E'  if conflict_row.kind = ''cancellation_requested'' then\n    if not public.google_calendar_conflict_observation_covers(conflict_row.id) then\n      raise exception ''GOOGLE_CALENDAR_CONFLICT_SCOPE_STALE''\n        using errcode = ''55000'';\n    end if;\n';
  update_marker text := E'    begin\n      update public.appointments appointment\n';
  guarded_update_marker text := E'    if not public.google_calendar_conflict_observation_covers(conflict_row.id) then\n      raise exception ''GOOGLE_CALENDAR_CONFLICT_SCOPE_STALE''\n        using errcode = ''55000'';\n    end if;\n    if not public.google_calendar_conflict_slot_is_free(conflict_row.id) then\n      raise exception ''SLOT_UNAVAILABLE'' using errcode = ''P0001'';\n    end if;\n\n    begin\n      update public.appointments appointment\n';
begin
  prior_definition := pg_get_functiondef(
    'public.apply_google_calendar_conflict(uuid)'::regprocedure
  );
  guarded_definition := prior_definition;
  guarded_definition := replace(
    guarded_definition,
    scope_marker,
    guarded_scope_marker
  );
  guarded_definition := replace(
    guarded_definition,
    cancellation_marker,
    guarded_cancellation_marker
  );
  guarded_definition := replace(
    guarded_definition,
    update_marker,
    guarded_update_marker
  );
  if guarded_definition = prior_definition
    or position(exclusive_call in prior_definition) = 0
    or position(exclusive_call in guarded_definition) = 0
    or position(scope_marker in guarded_definition) > 0
    or position(guarded_scope_marker in prior_definition) > 0
    or position(guarded_cancellation_marker in prior_definition) > 0
    or position(guarded_update_marker in prior_definition) > 0
    or position(guarded_scope_marker in guarded_definition) = 0
    or position(guarded_cancellation_marker in guarded_definition) = 0
    or position(guarded_update_marker in guarded_definition) = 0
  then
    raise exception 'GOOGLE_CALENDAR_LOCK_DEFINITION_DRIFT: %',
      'public.apply_google_calendar_conflict(uuid)'::regprocedure;
  end if;
  execute guarded_definition;
end;
$migration$;

do $migration$
declare
  target regprocedure;
  prior_definition text;
  guarded_definition text;
  update_marker text := E'\n  update public.google_calendar_sync_jobs job\n';
  guarded_update_marker text := E'\n  perform pg_advisory_xact_lock(\n    hashtextextended(''google_calendar_connection'', 0)\n  );\n\n  update public.google_calendar_sync_jobs job\n';
begin
  foreach target in array array[
    'public.complete_google_calendar_sync_job(uuid,bigint,text,bigint,text,timestamptz,timestamptz,uuid,text)'::regprocedure,
    'public.fail_google_calendar_sync_job(uuid,bigint,bigint,text,timestamptz,boolean,uuid,text)'::regprocedure
  ] loop
    prior_definition := pg_get_functiondef(target);
    guarded_definition := regexp_replace(
      prior_definition,
      update_marker,
      guarded_update_marker
    );
    if guarded_definition = prior_definition
      or position(guarded_update_marker in prior_definition) > 0
    then
      raise exception 'GOOGLE_CALENDAR_COMPLETION_LOCK_DRIFT: %', target;
    end if;
    execute guarded_definition;
  end loop;
end;
$migration$;

-- An inbound lease spans several HTTP/RPC calls. Each RPC that mutates the
-- observed state takes SHARED before touching rows; publishing completion (or
-- releasing/failing the lease) takes EXCLUSIVE before touching the connection.
-- Therefore completion cannot advertise a partial snapshot, even if a timed
-- out worker call is still committing in another database transaction.
do $migration$
declare
  prior_definition text;
  guarded_definition text;
  assertion_marker text := E'begin\n  if not exists (\n';
  guarded_assertion_marker text := E'begin\n  perform pg_catalog.pg_advisory_xact_lock_shared(\n    pg_catalog.hashtextextended(''google_calendar_connection'', 0)\n  );\n\n  if not exists (\n';
begin
  prior_definition := pg_get_functiondef(
    'public.assert_google_calendar_inbound_lease(bigint,uuid)'::regprocedure
  );
  guarded_definition := replace(
    prior_definition,
    assertion_marker,
    guarded_assertion_marker
  );
  if guarded_definition = prior_definition
    or position(guarded_assertion_marker in prior_definition) > 0
    or position(guarded_assertion_marker in guarded_definition) = 0
  then
    raise exception 'GOOGLE_CALENDAR_INBOUND_SHARED_LOCK_DRIFT: %',
      'public.assert_google_calendar_inbound_lease(bigint,uuid)'::regprocedure;
  end if;
  execute guarded_definition;
end;
$migration$;

do $migration$
declare
  prior_definition text;
  guarded_definition text;
  update_marker text := E'  update public.google_calendar_connections connection\n';
  guarded_update_marker text := E'  perform pg_catalog.pg_advisory_xact_lock_shared(\n    pg_catalog.hashtextextended(''google_calendar_connection'', 0)\n  );\n\n  update public.google_calendar_connections connection\n';
begin
  prior_definition := pg_get_functiondef(
    'public.invalidate_google_calendar_sync_token(bigint,uuid)'::regprocedure
  );
  guarded_definition := replace(
    prior_definition,
    update_marker,
    guarded_update_marker
  );
  if guarded_definition = prior_definition
    or position(guarded_update_marker in prior_definition) > 0
    or position(guarded_update_marker in guarded_definition) = 0
  then
    raise exception 'GOOGLE_CALENDAR_INBOUND_SHARED_LOCK_DRIFT: %',
      'public.invalidate_google_calendar_sync_token(bigint,uuid)'::regprocedure;
  end if;
  execute guarded_definition;
end;
$migration$;

do $migration$
declare
  target regprocedure;
  prior_definition text;
  guarded_definition text;
  update_marker text := E'  update public.google_calendar_connections connection\n';
  guarded_update_marker text := E'  perform pg_catalog.pg_advisory_xact_lock(\n    pg_catalog.hashtextextended(''google_calendar_connection'', 0)\n  );\n\n  update public.google_calendar_connections connection\n';
begin
  foreach target in array array[
    'public.complete_google_calendar_inbound_sync(bigint,uuid,text,jsonb,integer,integer,timestamptz,timestamptz)'::regprocedure,
    'public.complete_google_calendar_inbound_sync(bigint,uuid,text,jsonb,integer)'::regprocedure,
    'public.fail_google_calendar_inbound_sync(bigint,uuid,text,jsonb)'::regprocedure,
    'public.release_google_calendar_inbound_lease(bigint,uuid)'::regprocedure,
    'public.mark_google_calendar_reconnect_required(text,bigint)'::regprocedure
  ] loop
    prior_definition := pg_get_functiondef(target);
    guarded_definition := replace(
      prior_definition,
      update_marker,
      guarded_update_marker
    );
    if guarded_definition = prior_definition
      or position(guarded_update_marker in prior_definition) > 0
      or position(guarded_update_marker in guarded_definition) = 0
    then
      raise exception 'GOOGLE_CALENDAR_INBOUND_EXCLUSIVE_LOCK_DRIFT: %', target;
    end if;
    execute guarded_definition;
  end loop;
end;
$migration$;

-- A worker which could not acquire the inbound lease must not erase the last
-- owner's failure merely by recording that it checked. Only a successful
-- complete_* call is allowed to clear last_sync_error.
do $migration$
declare
  prior_definition text;
  guarded_definition text;
  error_marker text := '      last_sync_error = clean_note,';
  guarded_error_marker text :=
    '      last_sync_error = coalesce(clean_note, connection.last_sync_error),';
begin
  prior_definition := pg_get_functiondef(
    'public.record_google_calendar_sync_attempt(bigint,jsonb,integer,text)'::regprocedure
  );
  guarded_definition := replace(
    prior_definition,
    error_marker,
    guarded_error_marker
  );
  if guarded_definition = prior_definition
    or position(guarded_error_marker in prior_definition) > 0
    or position(guarded_error_marker in guarded_definition) = 0
  then
    raise exception 'GOOGLE_CALENDAR_ATTEMPT_ERROR_GUARD_DRIFT';
  end if;
  execute guarded_definition;
end;
$migration$;

create or replace function public.google_calendar_booking_observation_covers(
  p_observed_after timestamptz,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_appointment_id uuid default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  connection_row public.google_calendar_connections%rowtype;
begin
  if p_observed_after is null
    or p_starts_at is null
    or p_ends_at is null
    or p_starts_at >= p_ends_at
  then
    return false;
  end if;

  if not pg_try_advisory_xact_lock_shared(
    hashtextextended('google_calendar_connection', 0)
  ) then
    return false;
  end if;

  select connection.* into connection_row
  from public.google_calendar_connections connection
  where connection.id = true
  for share;
  if not found then return false; end if;

  if connection_row.status <> 'connected'
    or not connection_row.automation_enabled
    or connection_row.automation_epoch is null
    or connection_row.automation_activated_at is null
    or connection_row.automation_google_account_id is distinct from
      connection_row.google_account_id
    or connection_row.automation_google_calendar_id is distinct from
      connection_row.google_calendar_id
    or connection_row.automation_connection_generation is distinct from
      connection_row.connection_generation
    or connection_row.sync_scope_google_account_id is distinct from
      connection_row.google_account_id
    or connection_row.sync_scope_google_calendar_id is distinct from
      connection_row.google_calendar_id
    or connection_row.sync_scope_generation is distinct from
      connection_row.connection_generation
    or connection_row.inbound_first_import_approved_at is null
    or connection_row.inbound_sync_state <> 'incremental'
    or connection_row.inbound_sync_token is null
    or connection_row.inbound_sync_token_generation is distinct from
      connection_row.connection_generation
    or connection_row.inbound_sync_contract_version <> 2
    or connection_row.inbound_sync_timezone is distinct from
      connection_row.google_calendar_timezone
    or connection_row.inbound_coverage_starts_at is null
    or connection_row.inbound_coverage_ends_at is null
    or p_starts_at < connection_row.inbound_coverage_starts_at
    or p_ends_at > connection_row.inbound_coverage_ends_at
    or connection_row.last_sync_completed_at is null
    or connection_row.last_sync_completed_at < p_observed_after
    or connection_row.last_sync_completed_at <
      clock_timestamp() - interval '3 minutes'
    or connection_row.last_sync_error is not null
    or connection_row.last_error is not null
    or connection_row.inbound_lease_token is not null
    or connection_row.inbound_lease_expires_at is not null
    or public.google_calendar_has_uncertain_outbound_mutation()
  then
    return false;
  end if;

  if p_appointment_id is not null and exists (
    select 1
    from public.google_calendar_sync_conflicts conflict
    where conflict.appointment_id = p_appointment_id
      and conflict.status = 'pending'
      and conflict.connection_generation = connection_row.connection_generation
  ) then
    return false;
  end if;

  return true;
end;
$$;

create or replace function public.appointment_slot_is_free_for(
  p_appointment_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  appointment_row public.appointments%rowtype;
  connection_row public.google_calendar_connections%rowtype;
  buffer_minutes integer;
  requested_range tstzrange;
begin
  select appointment.* into appointment_row
  from public.appointments appointment
  where appointment.id = p_appointment_id;
  if not found then return false; end if;

  select settings.appointment_buffer_minutes into buffer_minutes
  from public.app_settings settings where settings.id = true;
  if buffer_minutes is null then return false; end if;

  requested_range := tstzrange(
    appointment_row.starts_at,
    appointment_row.ends_at + make_interval(mins => buffer_minutes),
    '[)'
  );

  if not pg_try_advisory_xact_lock_shared(
    hashtextextended('google_calendar_connection', 0)
  ) then
    return false;
  end if;

  select connection.* into connection_row
  from public.google_calendar_connections connection
  where connection.id = true
  for share;
  if not found then return false; end if;

  if connection_row.status in ('connected', 'reconnect_required') and not (
    connection_row.status = 'connected'
    and connection_row.inbound_first_import_approved_at is not null
    and connection_row.inbound_sync_state = 'incremental'
    and connection_row.inbound_sync_token is not null
    and connection_row.inbound_sync_token_generation =
      connection_row.connection_generation
    and connection_row.inbound_sync_contract_version = 2
    and connection_row.inbound_sync_timezone is not distinct from
      connection_row.google_calendar_timezone
    and connection_row.inbound_coverage_starts_at is not null
    and connection_row.inbound_coverage_ends_at is not null
    and appointment_row.starts_at >= connection_row.inbound_coverage_starts_at
    and appointment_row.ends_at + make_interval(mins => buffer_minutes)
      <= connection_row.inbound_coverage_ends_at
    and connection_row.last_sync_completed_at is not null
    and connection_row.last_sync_completed_at >=
      clock_timestamp() - interval '3 minutes'
    and connection_row.last_sync_error is null
    and connection_row.last_error is null
    and connection_row.inbound_lease_token is null
    and connection_row.inbound_lease_expires_at is null
    and not public.google_calendar_has_uncertain_outbound_mutation()
    and connection_row.sync_scope_google_account_id is not distinct from
      connection_row.google_account_id
    and connection_row.sync_scope_google_calendar_id is not distinct from
      connection_row.google_calendar_id
    and connection_row.sync_scope_generation =
      connection_row.connection_generation
  ) then
    return false;
  end if;

  if exists (
    select 1
    from public.google_calendar_sync_conflicts conflict
    where conflict.appointment_id = p_appointment_id
      and conflict.status = 'pending'
      and conflict.connection_generation = connection_row.connection_generation
  ) then
    return false;
  end if;

  -- A managed event moved in Google remains occupied at its observed range.
  -- The appointment being checked is rejected above when its own conflict is
  -- pending; only another appointment's proposed range is considered here.
  if exists (
    select 1
    from public.google_calendar_sync_conflicts conflict
    where public.google_calendar_conflict_range_is_occupied(conflict.id)
      and conflict.connection_generation = connection_row.connection_generation
      and conflict.appointment_id <> p_appointment_id
      and conflict.proposed_starts_at is not null
      and conflict.proposed_ends_at is not null
      and conflict.proposed_starts_at < conflict.proposed_ends_at
      and tstzrange(
        conflict.proposed_starts_at,
        conflict.proposed_ends_at + make_interval(mins => buffer_minutes),
        '[)'
      ) && requested_range
  ) then
    return false;
  end if;

  -- projected_* is the last range proven to exist in Google. In particular,
  -- a cancelled appointment keeps blocking until its DELETE is acknowledged;
  -- successful DELETE completion clears these columns atomically.
  if exists (
    select 1
    from public.google_calendar_sync_jobs job
    where job.appointment_id <> p_appointment_id
      and job.automation_epoch = connection_row.automation_epoch
      and job.authorized_google_account_id = connection_row.google_account_id
      and job.authorized_google_calendar_id = connection_row.google_calendar_id
      and job.authorized_connection_generation =
        connection_row.connection_generation
      and job.projected_operation = 'upsert'
      and job.projected_stage in ('pre_reservation', 'confirmed')
      and job.projected_starts_at is not null
      and job.projected_ends_at is not null
      and job.projected_starts_at < job.projected_ends_at
      and tstzrange(
        job.projected_starts_at,
        job.projected_ends_at + make_interval(mins => buffer_minutes),
        '[)'
      ) && requested_range
  ) then
    return false;
  end if;

  if exists (
    select 1
    from public.google_calendar_external_events external_event
    where external_event.google_calendar_id = connection_row.google_calendar_id
      and external_event.connection_generation =
        connection_row.connection_generation
      and external_event.kind = 'unsupported'
      and external_event.status = 'active'
  ) then
    return false;
  end if;

  if exists (
    select 1 from public.appointments other
    where other.id <> p_appointment_id
      and other.professional_id = appointment_row.professional_id
      and (
        other.status = 'confirmed'
        or (
          other.status = 'scheduled'
          and (
            other.deposit_status in ('proof_received', 'not_required')
            or (
              other.deposit_status = 'pending'
              and (
                other.hold_expires_at > clock_timestamp()
                or public.appointment_has_timely_deposit_proof_work(
                  other.id,
                  clock_timestamp()
                )
              )
            )
          )
        )
      )
      and tstzrange(
        other.starts_at,
        other.ends_at + make_interval(mins => buffer_minutes),
        '[)'
      ) && requested_range
  ) then
    return false;
  end if;

  return not exists (
    select 1
    from public.google_calendar_external_events external_event
    where external_event.google_calendar_id = connection_row.google_calendar_id
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
      and not (
        external_event.status = 'converted'
        and external_event.converted_appointment_id = p_appointment_id
      )
      and tstzrange(
        external_event.starts_at,
        external_event.ends_at,
        '[)'
      ) && requested_range
  );
end;
$$;

-- Human confirmations use this guard even while the original hold is live.
-- Service-role automated confirmation is wrapped separately below so it can
-- turn a failed observation into a durable human-review outcome.
create or replace function public.enforce_google_calendar_confirmation_slot()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'confirmed'
    and old.status is distinct from 'confirmed'
    and coalesce(auth.role(), '') <> 'service_role'
    and not public.appointment_slot_is_free_for(old.id)
  then
    raise exception 'SLOT_NO_LONGER_AVAILABLE' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists appointments_google_calendar_confirmation_guard
  on public.appointments;
create trigger appointments_google_calendar_confirmation_guard
  before update of status, deposit_status on public.appointments
  for each row execute function public.enforce_google_calendar_confirmation_slot();

revoke execute on function public.enforce_google_calendar_confirmation_slot()
  from public, anon, authenticated, service_role;

-- The idempotent WhatsApp wrappers correlate the committed Google pull with
-- the current execution. Replaying an already committed effect remains purely
-- idempotent and does not require another network observation.
create or replace function public.create_whatsapp_automation_appointment(
  p_message_id uuid,
  p_lease_token uuid,
  p_contact_id uuid,
  p_professional_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
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
    'starts_at', p_starts_at
  );

  select effect.* into existing_effect
  from public.whatsapp_automation_effects effect
  where effect.execution_message_id = p_message_id
    and effect.effect_key = 'appointment:create';
  if found then
    if existing_effect.effect_type <> 'appointment_create'
      or existing_effect.request <> request_value then
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

  if coalesce(calendar_requires_observation, false)
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
        null
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
$$;

create or replace function public.reschedule_whatsapp_automation_appointment(
  p_message_id uuid,
  p_lease_token uuid,
  p_appointment_id uuid,
  p_starts_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
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
  request_value := jsonb_build_object(
    'appointment_id', p_appointment_id,
    'starts_at', p_starts_at
  );

  select effect.* into existing_effect
  from public.whatsapp_automation_effects effect
  where effect.execution_message_id = p_message_id
    and effect.effect_key = 'appointment:reschedule';
  if found then
    if existing_effect.effect_type <> 'appointment_reschedule'
      or existing_effect.request <> request_value then
      raise exception 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT'
        using errcode = '23514';
    end if;
    return existing_effect.result;
  end if;

  select appointment.* into appointment_row
  from public.appointments appointment
  where appointment.id = p_appointment_id
    and appointment.contact_id = execution_row.contact_id;
  if not found then
    result_value := jsonb_build_object(
      'effect_status', 'rejected',
      'error_code', 'APPOINTMENT_NOT_FOUND'
    );
  else
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
    where contact.id = appointment_row.contact_id and settings.id = true;

    if coalesce(calendar_requires_observation, false)
      and not public.google_calendar_booking_observation_covers(
        execution_row.processing_started_at,
        p_starts_at,
        target_ends_with_buffer,
        p_appointment_id
      )
    then
      result_value := jsonb_build_object(
        'effect_status', 'rejected',
        'error_code', 'CALENDAR_AVAILABILITY_UNAVAILABLE'
      );
    else
      begin
        appointment_row := public.reschedule_service_appointment(
          p_appointment_id,
          p_starts_at
        );
        result_value := to_jsonb(appointment_row);
      exception when raise_exception or no_data_found then
        if sqlerrm in ('SLOT_UNAVAILABLE', 'APPOINTMENT_NOT_FOUND') then
          result_value := jsonb_build_object(
            'effect_status', 'rejected',
            'error_code', sqlerrm
          );
        else
          raise;
        end if;
      end;
    end if;
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
    'appointment:reschedule',
    'appointment_reschedule',
    request_value,
    result_value,
    case
      when result_value ->> 'effect_status' = 'rejected' then null
      else appointment_row.id
    end
  );
  return result_value;
end;
$$;

-- Creating or moving one appointment must not sweep unrelated expired holds.
-- Only stale holds that physically overlap the requested destination can
-- obstruct the exclusion constraint and are eligible for cleanup here.
create or replace function public.expire_overlapping_booking_holds(
  p_professional_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_exclude_appointment_id uuid default null,
  p_now timestamptz default clock_timestamp()
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  buffer_minutes integer;
  expired_count bigint;
begin
  if p_professional_id is null
    or p_starts_at is null
    or p_ends_at is null
    or p_starts_at >= p_ends_at
    or p_now is null
  then
    raise exception 'INVALID_BOOKING_HOLD_EXPIRATION_SCOPE'
      using errcode = '22023';
  end if;

  select settings.appointment_buffer_minutes into buffer_minutes
  from public.app_settings settings
  where settings.id = true;
  if buffer_minutes is null then
    raise exception 'APP_SETTINGS_NOT_FOUND' using errcode = 'P0002';
  end if;

  with expired as (
    update public.appointments appointment
    set status = 'cancelled',
        deposit_status = 'expired',
        hold_expired_notification_status = case
          when appointment.hold_expired_notification_status = 'not_applicable'
            then 'pending'
          else appointment.hold_expired_notification_status
        end,
        hold_expired_notification_claimed_at = null,
        hold_expired_notification_error = null
    where appointment.professional_id = p_professional_id
      and (
        p_exclude_appointment_id is null
        or appointment.id <> p_exclude_appointment_id
      )
      and appointment.status = 'scheduled'
      and appointment.deposit_status = 'pending'
      and appointment.hold_expires_at is not null
      and appointment.hold_expires_at <= p_now
      and not public.appointment_has_timely_deposit_proof_work(
        appointment.id,
        p_now
      )
      and tstzrange(
        appointment.starts_at,
        appointment.ends_at + make_interval(mins => buffer_minutes),
        '[)'
      ) && tstzrange(p_starts_at, p_ends_at, '[)')
    returning 1
  )
  select count(*) into expired_count from expired;

  return expired_count;
end;
$$;

revoke execute on function public.expire_overlapping_booking_holds(
  uuid, timestamptz, timestamptz, uuid, timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.create_service_appointment(
  p_contact_id uuid,
  p_professional_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_source public.appointment_source default 'manual',
  p_internal_note text default null
)
returns public.appointments
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  contact_coverage public.patient_coverage;
  effective_duration integer;
  settings public.app_settings%rowtype;
  requested_ends_with_buffer timestamptz;
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not public.current_user_is_active() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.services service
    where service.id = p_service_id and service.active
  ) then
    raise exception 'SERVICE_NOT_AVAILABLE' using errcode = 'P0001';
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
  if not public.appointment_slot_is_available(
    p_professional_id, p_starts_at, effective_duration, null, settings.timezone
  ) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  begin
    insert into public.appointments (
      contact_id, professional_id, service_id, starts_at, ends_at,
      status, source, created_by, internal_note, coverage, duration_minutes,
      deposit_status, hold_expires_at, hold_expired_notification_status
    ) values (
      p_contact_id, p_professional_id, p_service_id, p_starts_at,
      p_starts_at + make_interval(mins => effective_duration),
      case when settings.deposit_enabled
        then 'scheduled'::public.appointment_status
        else 'confirmed'::public.appointment_status end,
      p_source, auth.uid(), p_internal_note, contact_coverage,
      effective_duration,
      case when settings.deposit_enabled
        then 'pending'::public.deposit_status
        else 'not_required'::public.deposit_status end,
      case when settings.deposit_enabled
        then clock_timestamp()
          + make_interval(mins => settings.booking_hold_minutes)
        else null end,
      case when settings.deposit_enabled then 'pending' else 'not_applicable' end
    ) returning * into result;
  exception when exclusion_violation then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end;
  return result;
end;
$$;

create or replace function public.reschedule_appointment(
  p_appointment_id uuid,
  p_starts_at timestamptz
)
returns public.appointments
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_appointment public.appointments%rowtype;
  contact_coverage public.patient_coverage;
  effective_duration integer;
  settings public.app_settings%rowtype;
  requested_ends_with_buffer timestamptz;
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not public.current_user_is_active() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  select appointment.* into current_appointment
  from public.appointments appointment
  where appointment.id = p_appointment_id
    and appointment.status in ('scheduled', 'confirmed');
  if not found then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(current_appointment.professional_id::text, 0)
  );
  select appointment.* into current_appointment
  from public.appointments appointment
  where appointment.id = p_appointment_id
  for update;
  if current_appointment.status not in ('scheduled', 'confirmed') then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if current_appointment.status = 'scheduled'
    and current_appointment.deposit_status = 'pending'
    and current_appointment.hold_expires_at is not null
    and current_appointment.hold_expires_at <= clock_timestamp()
    and not public.appointment_has_timely_deposit_proof_work(
      current_appointment.id,
      clock_timestamp()
    )
  then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select contact.coverage into contact_coverage
  from public.contacts contact
  where contact.id = current_appointment.contact_id
  for key share;
  if contact_coverage is null then
    raise exception 'COVERAGE_REQUIRED' using errcode = 'P0001';
  end if;
  select * into settings from public.app_settings app_settings
  where app_settings.id = true;
  if not found then
    raise exception 'APP_SETTINGS_NOT_FOUND' using errcode = 'P0002';
  end if;
  effective_duration := case contact_coverage
    when 'ioma' then settings.ioma_duration_minutes
    when 'particular' then settings.private_duration_minutes
  end;
  requested_ends_with_buffer := p_starts_at + make_interval(
    mins => effective_duration + settings.appointment_buffer_minutes
  );

  if not public.appointment_slot_is_available(
    current_appointment.professional_id,
    p_starts_at,
    effective_duration,
    p_appointment_id,
    settings.timezone
  ) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;
  perform public.expire_overlapping_booking_holds(
    current_appointment.professional_id,
    p_starts_at,
    requested_ends_with_buffer,
    p_appointment_id,
    clock_timestamp()
  );
  if not public.appointment_slot_is_available(
    current_appointment.professional_id,
    p_starts_at,
    effective_duration,
    p_appointment_id,
    settings.timezone
  ) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  begin
    update public.appointments appointment
    set starts_at = p_starts_at,
        ends_at = p_starts_at + make_interval(mins => effective_duration),
        coverage = contact_coverage,
        duration_minutes = effective_duration
    where appointment.id = p_appointment_id
    returning appointment.* into result;
  exception when exclusion_violation then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end;
  return result;
end;
$$;

revoke execute on function public.google_calendar_booking_observation_covers(
  timestamptz, timestamptz, timestamptz, uuid
) from public, anon, authenticated, service_role;

-- Automatic confirmation is allowed only after the same post-cutoff hold has
-- been acknowledged as a pre-reservation in the exact authorized calendar.
-- A fresh inbound read alone cannot prove that a failed outbound POST exists.
create or replace function public.google_calendar_pre_reservation_is_projected(
  p_appointment_id uuid
)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.appointments appointment
    join public.google_calendar_sync_jobs job
      on job.appointment_id = appointment.id
    join public.google_calendar_connections connection
      on connection.id = true
     and connection.status = 'connected'
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
    where appointment.id = p_appointment_id
      and appointment.created_at >= connection.automation_activated_at
      and job.status = 'succeeded'
      and job.operation = 'upsert'
      and job.projected_operation = 'upsert'
      and job.projection_stage = 'pre_reservation'
      and job.projected_stage = 'pre_reservation'
      and job.google_event_id =
        public.google_calendar_automation_event_id(appointment.id)
      and job.projected_starts_at is not distinct from appointment.starts_at
      and job.projected_ends_at is not distinct from appointment.ends_at
  );
$$;

revoke execute on function public.google_calendar_pre_reservation_is_projected(
  uuid
) from public, anon, authenticated, service_role;

-- All availability callers fail closed while an import is in progress or the
-- last complete observation is older than three scheduler periods.
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

  -- The shared barrier is kept until the caller commits. A new inbound lease
  -- cannot start between this check and an appointment insert/update; the
  -- appointment trigger re-enters the same shared advisory without upgrade.
  if not pg_try_advisory_xact_lock_shared(
    hashtextextended('google_calendar_connection', 0)
  ) then
    return false;
  end if;
  perform 1
  from public.google_calendar_connections connection
  where connection.id = true
  for share;
  if not found then return false; end if;

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
        and connection.last_sync_completed_at is not null
        and connection.last_sync_completed_at >=
          clock_timestamp() - interval '3 minutes'
        and connection.last_sync_error is null
        and connection.last_error is null
        and connection.inbound_lease_token is null
        and connection.inbound_lease_expires_at is null
        and not public.google_calendar_has_uncertain_outbound_mutation()
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

  if p_exclude_appointment_id is not null and exists (
    select 1
    from public.google_calendar_sync_conflicts conflict
    join public.google_calendar_connections connection
      on connection.id = true
     and connection.connection_generation = conflict.connection_generation
    where conflict.appointment_id = p_exclude_appointment_id
      and conflict.status = 'pending'
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
      and not (
        p_exclude_appointment_id is not null
        and external_event.status = 'converted'
        and external_event.converted_appointment_id = p_exclude_appointment_id
      )
      and tstzrange(external_event.starts_at, external_event.ends_at, '[)')
        && requested_range
  ) then
    return false;
  end if;

  if exists (
    select 1
    from public.google_calendar_sync_conflicts conflict
    join public.google_calendar_connections connection
      on connection.id = true
     and connection.connection_generation = conflict.connection_generation
    where public.google_calendar_conflict_range_is_occupied(conflict.id)
      and (
        p_exclude_appointment_id is null
        or conflict.appointment_id <> p_exclude_appointment_id
      )
      and conflict.proposed_starts_at is not null
      and conflict.proposed_ends_at is not null
      and conflict.proposed_starts_at < conflict.proposed_ends_at
      and tstzrange(
        conflict.proposed_starts_at,
        conflict.proposed_ends_at + make_interval(mins => buffer_minutes),
        '[)'
      ) && requested_range
  ) then
    return false;
  end if;

  if exists (
    select 1
    from public.google_calendar_sync_jobs job
    join public.google_calendar_connections connection
      on connection.id = true
     and connection.automation_epoch = job.automation_epoch
     and connection.google_account_id = job.authorized_google_account_id
     and connection.google_calendar_id = job.authorized_google_calendar_id
     and connection.connection_generation =
       job.authorized_connection_generation
    where (
        p_exclude_appointment_id is null
        or job.appointment_id <> p_exclude_appointment_id
      )
      and job.projected_operation = 'upsert'
      and job.projected_stage in ('pre_reservation', 'confirmed')
      and job.projected_starts_at is not null
      and job.projected_ends_at is not null
      and job.projected_starts_at < job.projected_ends_at
      and tstzrange(
        job.projected_starts_at,
        job.projected_ends_at + make_interval(mins => buffer_minutes),
        '[)'
      ) && requested_range
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

-- Automatic deposit approval keeps the existing durable proof processor, but
-- downgrades an approval to review when Calendar cannot be proven current for
-- this exact WhatsApp execution. The renamed implementation is not callable
-- directly by API roles.
alter function public.process_automated_deposit_proof(
  uuid, uuid, uuid, jsonb, text, text, boolean
) rename to process_automated_deposit_proof_without_calendar_guard;

revoke execute on function public.process_automated_deposit_proof_without_calendar_guard(
  uuid, uuid, uuid, jsonb, text, text, boolean
) from public, anon, authenticated, service_role;

create or replace function public.process_automated_deposit_proof(
  p_message_id uuid,
  p_lease_token uuid,
  p_appointment_id uuid,
  p_reading jsonb,
  p_media_sha256 text,
  p_policy_version text,
  p_auto_approve boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  appointment_row public.appointments%rowtype;
  appointment_professional_id uuid;
  existing_result public.automated_deposit_proof_results%rowtype;
  buffer_minutes integer;
  calendar_requires_observation boolean := false;
  calendar_refresh_failed boolean :=
    p_reading ->> 'calendarAvailabilityVerified' = 'false';
  effective_auto_approve boolean := p_auto_approve;
  forced_calendar_review boolean := false;
  result_value jsonb;
  review_reasons jsonb;
  first_application boolean;
begin
  if calendar_refresh_failed then
    effective_auto_approve := false;
    forced_calendar_review := true;
  elsif p_auto_approve then
    select result.* into existing_result
    from public.automated_deposit_proof_results result
    where result.appointment_id = p_appointment_id;

    if found and existing_result.result ->>
      'calendar_availability_verified' = 'false'
    then
      effective_auto_approve := false;
      forced_calendar_review := true;
    elsif not found then
      execution_row := public.require_whatsapp_automation_execution(
        p_message_id,
        p_lease_token
      );
      select appointment.professional_id into appointment_professional_id
      from public.appointments appointment
      where appointment.id = p_appointment_id;
      if appointment_professional_id is null then
        raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
      end if;

      -- Keep the availability proof and the eventual confirmation in the same
      -- professional critical section. Otherwise a buffer-only booking could
      -- commit while this call waits inside the durable proof implementation.
      perform pg_advisory_xact_lock(
        hashtextextended(appointment_professional_id::text, 0)
      );
      select appointment.* into appointment_row
      from public.appointments appointment
      where appointment.id = p_appointment_id
      for update;
      if not found then
        raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
      end if;

      select connection.status in ('connected', 'reconnect_required')
        into calendar_requires_observation
      from public.google_calendar_connections connection
      where connection.id = true;
      if coalesce(calendar_requires_observation, false) then
        select settings.appointment_buffer_minutes into buffer_minutes
        from public.app_settings settings where settings.id = true;
        effective_auto_approve :=
          buffer_minutes is not null
          and public.google_calendar_booking_observation_covers(
            execution_row.processing_started_at,
            appointment_row.starts_at,
            appointment_row.ends_at + make_interval(mins => buffer_minutes),
            appointment_row.id
          )
          and public.google_calendar_pre_reservation_is_projected(
            appointment_row.id
          )
          and public.appointment_slot_is_free_for(appointment_row.id);
        forced_calendar_review := not effective_auto_approve;
      end if;
    end if;
  end if;

  result_value := public.process_automated_deposit_proof_without_calendar_guard(
    p_message_id,
    p_lease_token,
    p_appointment_id,
    p_reading,
    p_media_sha256,
    p_policy_version,
    effective_auto_approve
  );

  if not forced_calendar_review then return result_value; end if;

  first_application := coalesce(
    (result_value ->> 'idempotent')::boolean,
    false
  ) is false;
  review_reasons := coalesce(result_value -> 'review_reasons', '[]'::jsonb);
  if not review_reasons @> '["CALENDAR_AVAILABILITY_UNVERIFIED"]'::jsonb then
    review_reasons := review_reasons
      || '["CALENDAR_AVAILABILITY_UNVERIFIED"]'::jsonb;
  end if;
  result_value := jsonb_set(
    result_value,
    '{review_reasons}',
    review_reasons,
    true
  ) || jsonb_build_object(
    'auto_approve_requested', true,
    'calendar_availability_verified', false
  );

  update public.automated_deposit_proof_results result
  set result = result_value
  where result.appointment_id = p_appointment_id
    and result.proof_message_id = p_message_id;
  update public.whatsapp_automation_effects effect
  set result = result_value || jsonb_build_object('effect_status', 'applied')
  where effect.execution_message_id = p_message_id
    and effect.effect_type = 'appointment_deposit_process'
    and effect.appointment_id = p_appointment_id;

  if first_application then
    insert into public.audit_logs (action, entity_type, entity_id, metadata)
    values (
      'deposit.calendar_availability_review_required',
      'appointment',
      p_appointment_id,
      jsonb_build_object(
        'proof_message_id', p_message_id,
        'reason', 'CALENDAR_AVAILABILITY_UNVERIFIED',
        'confirmed', false
      )
    );
  end if;

  return result_value;
end;
$$;

revoke execute on function public.process_automated_deposit_proof(
  uuid, uuid, uuid, jsonb, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.process_automated_deposit_proof(
  uuid, uuid, uuid, jsonb, text, text, boolean
) to service_role;
