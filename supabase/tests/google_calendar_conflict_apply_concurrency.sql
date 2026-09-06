\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set local search_path = public, extensions;
select plan(14);

-- This test uses committed dblink fixtures so independent backends exercise
-- the real advisory-lock order. The singleton rows are preserved in durable
-- backup tables and restored explicitly, including recovery from an aborted
-- previous run of this synthetic fixture.
select extensions.dblink_connect(
  'calendar_conflict_apply_setup',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);
select extensions.dblink_connect(
  'calendar_conflict_apply_observer',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);
select extensions.dblink_connect(
  'calendar_conflict_apply_admin',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);
select extensions.dblink_connect(
  'calendar_conflict_apply_finisher',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);

select extensions.dblink_exec(
  'calendar_conflict_apply_setup',
  $setup$
    begin;
    set local session_replication_role = replica;

    do $recover$
    begin
      if to_regclass(
        'public.calendar_conflict_apply_connection_backup'
      ) is not null then
        delete from public.google_calendar_connections;
        execute
          'insert into public.google_calendar_connections ' ||
          'select * from public.calendar_conflict_apply_connection_backup';
        execute
          'drop table public.calendar_conflict_apply_connection_backup';
      end if;
      if to_regclass(
        'public.calendar_conflict_apply_settings_backup'
      ) is not null then
        delete from public.app_settings;
        execute
          'insert into public.app_settings ' ||
          'select * from public.calendar_conflict_apply_settings_backup';
        execute 'drop table public.calendar_conflict_apply_settings_backup';
      end if;
    end;
    $recover$;

    delete from public.reminders
    where appointment_id in (
      '92600000-0000-4000-8000-000000000040',
      '92600000-0000-4000-8000-000000000041'
    );
    delete from public.google_calendar_sync_conflicts
    where appointment_id in (
      '92600000-0000-4000-8000-000000000040',
      '92600000-0000-4000-8000-000000000041'
    );
    delete from public.google_calendar_sync_jobs
    where appointment_id in (
      '92600000-0000-4000-8000-000000000040',
      '92600000-0000-4000-8000-000000000041'
    );
    delete from public.audit_logs
    where actor_user_id = '92600000-0000-4000-8000-000000000099'
       or entity_id in (
         '92600000-0000-4000-8000-000000000040',
         '92600000-0000-4000-8000-000000000041'
       );
    delete from public.appointments
    where id in (
      '92600000-0000-4000-8000-000000000040',
      '92600000-0000-4000-8000-000000000041'
    );
    delete from public.contacts
    where id in (
      '92600000-0000-4000-8000-000000000010',
      '92600000-0000-4000-8000-000000000011'
    );
    delete from public.availability_exceptions
    where professional_id = '92600000-0000-4000-8000-000000000001';
    delete from public.availability_rules
    where professional_id = '92600000-0000-4000-8000-000000000001';
    delete from public.professionals
    where id = '92600000-0000-4000-8000-000000000001';
    delete from public.profiles
    where id = '92600000-0000-4000-8000-000000000099';
    delete from auth.users
    where id = '92600000-0000-4000-8000-000000000099';

    create table public.calendar_conflict_apply_connection_backup as
    select * from public.google_calendar_connections;
    create table public.calendar_conflict_apply_settings_backup as
    select * from public.app_settings;

    update public.app_settings
    set timezone = 'America/Argentina/Buenos_Aires',
        minimum_booking_notice_minutes = 0,
        appointment_buffer_minutes = 15,
        ioma_duration_minutes = 30,
        private_duration_minutes = 60,
        reminder_24h_enabled = false,
        reminder_2h_enabled = false
    where id = true;

    update public.google_calendar_connections
    set status = 'connected',
        connected_by = null,
        google_account_id = 'conflict-apply-account',
        google_account_email = 'conflict-apply@example.test',
        google_calendar_id = 'conflict-apply-calendar',
        google_calendar_name = 'Conflict Apply Calendar',
        google_calendar_timezone = 'America/Argentina/Buenos_Aires',
        refresh_token_secret_id =
          '92600000-0000-4000-8000-000000000092',
        connected_at = clock_timestamp() - interval '1 day',
        disconnected_at = null,
        last_synced_at = clock_timestamp() - interval '1 minute',
        last_error = null,
        connection_generation = 926,
        inbound_sync_token = 'conflict-apply-token-before',
        inbound_sync_token_generation = 926,
        inbound_sync_state = 'incremental',
        inbound_first_import_approved_at =
          clock_timestamp() - interval '1 day',
        inbound_first_import_approved_by = null,
        inbound_lease_token =
          '92600000-0000-4000-8000-000000000090',
        inbound_lease_expires_at = clock_timestamp() + interval '5 minutes',
        last_checked_at = clock_timestamp() - interval '1 minute',
        last_sync_completed_at = clock_timestamp() - interval '1 minute',
        last_sync_summary = '{}'::jsonb,
        last_sync_error = null,
        sync_scope_google_account_id = 'conflict-apply-account',
        sync_scope_google_calendar_id = 'conflict-apply-calendar',
        sync_scope_generation = 926,
        inbound_sync_contract_version = 2,
        inbound_coverage_starts_at = (current_date - 1)::timestamp
          at time zone 'America/Argentina/Buenos_Aires',
        inbound_coverage_ends_at = (current_date + 20)::timestamp
          at time zone 'America/Argentina/Buenos_Aires',
        inbound_sync_timezone = 'America/Argentina/Buenos_Aires',
        inbound_lease_sync_contract_version = 2,
        inbound_lease_coverage_starts_at = (current_date - 1)::timestamp
          at time zone 'America/Argentina/Buenos_Aires',
        inbound_lease_coverage_ends_at = (current_date + 20)::timestamp
          at time zone 'America/Argentina/Buenos_Aires',
        inbound_lease_timezone = 'America/Argentina/Buenos_Aires',
        automation_enabled = true,
        automation_epoch = '92600000-0000-4000-8000-000000000091',
        automation_activated_at = clock_timestamp() - interval '1 hour',
        automation_google_account_id = 'conflict-apply-account',
        automation_google_calendar_id = 'conflict-apply-calendar',
        automation_connection_generation = 926
    where id = true;

    insert into public.professionals (
      id, name, specialty, appointment_duration_minutes, active
    ) values (
      '92600000-0000-4000-8000-000000000001',
      'Conflict Apply Professional', 'Test', 30, true
    );
    insert into public.availability_rules (
      professional_id, weekday, start_time, end_time, slot_minutes, active
    )
    select
      '92600000-0000-4000-8000-000000000001',
      weekday, '08:00', '18:00', 15, true
    from generate_series(0, 6) as weekday;
    insert into public.contacts (id, phone_e164, name, coverage)
    values
      (
        '92600000-0000-4000-8000-000000000010',
        '+12025550126', 'Conflict Apply A', 'ioma'
      ),
      (
        '92600000-0000-4000-8000-000000000011',
        '+12025550127', 'Conflict Apply B', 'ioma'
      );
    insert into public.appointments (
      id, contact_id, professional_id, starts_at, ends_at, status, source,
      coverage, duration_minutes, deposit_status, created_at
    ) values
      (
        '92600000-0000-4000-8000-000000000040',
        '92600000-0000-4000-8000-000000000010',
        '92600000-0000-4000-8000-000000000001',
        (current_date + 7 + time '10:00')
          at time zone 'America/Argentina/Buenos_Aires',
        (current_date + 7 + time '10:30')
          at time zone 'America/Argentina/Buenos_Aires',
        'confirmed', 'manual', 'ioma', 30, 'confirmed', clock_timestamp()
      ),
      (
        '92600000-0000-4000-8000-000000000041',
        '92600000-0000-4000-8000-000000000011',
        '92600000-0000-4000-8000-000000000001',
        (current_date + 8 + time '10:00')
          at time zone 'America/Argentina/Buenos_Aires',
        (current_date + 8 + time '10:30')
          at time zone 'America/Argentina/Buenos_Aires',
        'confirmed', 'manual', 'ioma', 30, 'confirmed', clock_timestamp()
      );
    insert into public.google_calendar_sync_jobs (
      id, appointment_id, operation, desired_version,
      connection_generation, status, attempts, available_at,
      processing_started_at, google_event_id, last_error, google_etag,
      projected_starts_at, projected_ends_at, projected_operation,
      automation_epoch, authorized_google_account_id,
      authorized_google_calendar_id, authorized_connection_generation,
      projection_stage, projected_stage
    )
    select
      case appointment.id
        when '92600000-0000-4000-8000-000000000040'::uuid
          then '92600000-0000-4000-8000-000000000050'::uuid
        else '92600000-0000-4000-8000-000000000051'::uuid
      end,
      appointment.id, 'upsert', 1, 926, 'succeeded', 1,
      clock_timestamp(), null,
      public.google_calendar_automation_event_id(appointment.id), null,
      case appointment.id
        when '92600000-0000-4000-8000-000000000040'::uuid
          then '"conflict-apply-etag-a"'
        else '"conflict-apply-etag-b"'
      end,
      appointment.starts_at, appointment.ends_at, 'upsert',
      '92600000-0000-4000-8000-000000000091',
      'conflict-apply-account', 'conflict-apply-calendar', 926,
      'confirmed', 'confirmed'
    from public.appointments appointment
    where appointment.id in (
      '92600000-0000-4000-8000-000000000040',
      '92600000-0000-4000-8000-000000000041'
    );

    set local session_replication_role = origin;
    insert into auth.users (id, email, encrypted_password, aud, role)
    values (
      '92600000-0000-4000-8000-000000000099',
      'conflict-apply-admin@example.test', '',
      'authenticated', 'authenticated'
    );
    update public.profiles
    set role = 'ADMIN', active = true
    where id = '92600000-0000-4000-8000-000000000099';
    commit;
  $setup$
);

-- Source shape is asserted in addition to the dynamic interleaving: apply
-- must enter the exclusive Calendar barrier before touching conflict rows,
-- while every managed observation enters through the shared lease assertion.
with definitions as (
  select
    pg_get_functiondef(
      'public.apply_google_calendar_conflict(uuid)'::regprocedure
    ) as apply_body,
    pg_get_functiondef(
      'public.observe_google_calendar_managed_event(bigint,uuid,text,uuid,boolean,timestamptz,timestamptz,timestamptz,text,uuid,text,boolean)'::regprocedure
    ) as observe_body,
    pg_get_functiondef(
      'public.assert_google_calendar_inbound_lease(bigint,uuid)'::regprocedure
    ) as lease_body
), positions as (
  select
    strpos(apply_body, 'perform pg_advisory_xact_lock(') as apply_barrier,
    strpos(
      apply_body,
      'from public.google_calendar_sync_conflicts conflict'
    ) as conflict_read,
    strpos(
      observe_body,
      'perform public.assert_google_calendar_inbound_lease('
    ) as lease_assertion,
    strpos(lease_body, 'pg_advisory_xact_lock_shared(') as shared_barrier
  from definitions
)
select ok(
  apply_barrier > 0
  and conflict_read > apply_barrier
  and lease_assertion > 0
  and shared_barrier > 0,
  'apply enters EXCLUSIVE before conflict rows and observe enters SHARED through its lease assertion'
)
from positions;

select extensions.dblink_exec(
  'calendar_conflict_apply_observer',
  $$set request.jwt.claims = '{"role":"service_role"}'$$
);
select extensions.dblink_exec(
  'calendar_conflict_apply_observer',
  $$set request.jwt.claim.role = 'service_role'$$
);
select extensions.dblink_exec(
  'calendar_conflict_apply_finisher',
  $$set request.jwt.claims = '{"role":"service_role"}'$$
);
select extensions.dblink_exec(
  'calendar_conflict_apply_finisher',
  $$set request.jwt.claim.role = 'service_role'$$
);
select extensions.dblink_exec(
  'calendar_conflict_apply_admin',
  $$set request.jwt.claims = '{"role":"authenticated","sub":"92600000-0000-4000-8000-000000000099"}'$$
);
select extensions.dblink_exec(
  'calendar_conflict_apply_admin',
  $$set request.jwt.claim.role = 'authenticated'$$
);
select extensions.dblink_exec(
  'calendar_conflict_apply_admin',
  $$set request.jwt.claim.sub = '92600000-0000-4000-8000-000000000099'$$
);
select extensions.dblink_exec(
  'calendar_conflict_apply_admin',
  $admin_helpers$
    create function pg_temp.run_calendar_conflict_apply(p_conflict_id uuid)
    returns jsonb
    language plpgsql
    as $body$
    declare
      conflict_result public.google_calendar_sync_conflicts%rowtype;
      error_state text;
      error_message text;
    begin
      begin
        conflict_result := public.apply_google_calendar_conflict(p_conflict_id);
      exception when others then
        error_state := sqlstate;
        error_message := sqlerrm;
      end;
      return jsonb_build_object(
        'result', to_jsonb(conflict_result),
        'exceptionState', error_state,
        'exceptionMessage', error_message
      );
    end;
    $body$;

    create function pg_temp.run_calendar_conflict_reject(p_conflict_id uuid)
    returns jsonb
    language plpgsql
    as $body$
    declare
      conflict_result public.google_calendar_sync_conflicts%rowtype;
      error_state text;
      error_message text;
    begin
      begin
        conflict_result := public.reject_google_calendar_conflict(p_conflict_id);
      exception when others then
        error_state := sqlstate;
        error_message := sqlerrm;
      end;
      return jsonb_build_object(
        'result', to_jsonb(conflict_result),
        'exceptionState', error_state,
        'exceptionMessage', error_message
      );
    end;
    $body$;
  $admin_helpers$
);

select extensions.dblink_exec('calendar_conflict_apply_observer', 'begin');
select outcome
from extensions.dblink(
  'calendar_conflict_apply_observer',
  $observe$
    select public.observe_google_calendar_managed_event(
      926,
      '92600000-0000-4000-8000-000000000090',
      public.google_calendar_automation_event_id(
        '92600000-0000-4000-8000-000000000040'
      ),
      '92600000-0000-4000-8000-000000000040',
      false,
      (current_date + 7 + time '12:00')
        at time zone 'America/Argentina/Buenos_Aires',
      (current_date + 7 + time '12:30')
        at time zone 'America/Argentina/Buenos_Aires',
      clock_timestamp(),
      '"conflict-apply-observed-etag-a"',
      '92600000-0000-4000-8000-000000000091',
      'confirmed',
      false
    )
  $observe$
) as observation(outcome text)
\gset observed_
select is(
  :'observed_outcome'::text,
  'conflict_recorded'::text,
  'the managed observer records the synthetic external move under SHARED'
);

select conflict_id
from extensions.dblink(
  'calendar_conflict_apply_observer',
  $conflict$
    select id
    from public.google_calendar_sync_conflicts
    where appointment_id = '92600000-0000-4000-8000-000000000040'
      and status = 'pending'
  $conflict$
) as pending_conflict(conflict_id uuid)
\gset race_

select backend_pid
from extensions.dblink(
  'calendar_conflict_apply_observer',
  'select pg_backend_pid()'
) as observer_pid(backend_pid integer)
\gset observer_
select backend_pid
from extensions.dblink(
  'calendar_conflict_apply_admin',
  'select pg_backend_pid()'
) as admin_pid(backend_pid integer)
\gset admin_

create function pg_temp.wait_for_calendar_conflict_apply_barrier(
  p_admin_pid integer,
  p_observer_pid integer
)
returns boolean
language plpgsql
as $$
declare
  deadline timestamptz := clock_timestamp() + interval '3 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if p_observer_pid = any(pg_blocking_pids(p_admin_pid))
      and exists (
        select 1
        from pg_locks waiting
        join pg_locks holding
          on holding.locktype = waiting.locktype
         and holding.database is not distinct from waiting.database
         and holding.classid is not distinct from waiting.classid
         and holding.objid is not distinct from waiting.objid
         and holding.objsubid is not distinct from waiting.objsubid
        where waiting.pid = p_admin_pid
          and waiting.locktype = 'advisory'
          and waiting.mode = 'ExclusiveLock'
          and not waiting.granted
          and holding.pid = p_observer_pid
          and holding.mode = 'ShareLock'
          and holding.granted
      )
    then
      return true;
    end if;
    if clock_timestamp() >= deadline then return false; end if;
    perform pg_sleep(0.02);
  end loop;
end;
$$;

select extensions.dblink_exec('calendar_conflict_apply_admin', 'begin');
select extensions.dblink_send_query(
  'calendar_conflict_apply_admin',
  format(
    'select pg_temp.run_calendar_conflict_apply(%L::uuid)',
    :'race_conflict_id'
  )
);
select ok(
  pg_temp.wait_for_calendar_conflict_apply_barrier(
    :'admin_backend_pid'::integer,
    :'observer_backend_pid'::integer
  ),
  'apply waits without a row-lock cycle behind the observer SHARED barrier'
);

-- The observer commits its conflict, but the inbound lease deliberately stays
-- active. Apply may now obtain EXCLUSIVE, yet it must still reject the partial
-- observation rather than mutate the appointment.
select extensions.dblink_exec(
  'calendar_conflict_apply_observer',
  'commit'
);
select outcome
from extensions.dblink_get_result('calendar_conflict_apply_admin')
  as raced(outcome jsonb)
\gset raced_
select count(*)
from extensions.dblink_get_result('calendar_conflict_apply_admin')
  as raced_result_drained(outcome jsonb);
select ok(
  :'raced_outcome'::jsonb ->> 'exceptionState' = '55000'
  and :'raced_outcome'::jsonb ->> 'exceptionMessage' =
    'GOOGLE_CALENDAR_CONFLICT_SCOPE_STALE',
  'after SHARED commits, apply fails closed while the inbound lease is active'
);
select extensions.dblink_exec('calendar_conflict_apply_admin', 'commit');

select ok(
  (
    select state_ok
    from extensions.dblink(
      'calendar_conflict_apply_setup',
      format(
        $verify$
          select
            appointment.starts_at =
              (current_date + 7 + time '10:00')
                at time zone 'America/Argentina/Buenos_Aires'
            and appointment.ends_at =
              (current_date + 7 + time '10:30')
                at time zone 'America/Argentina/Buenos_Aires'
            and conflict.status = 'pending'
            and connection.inbound_lease_token =
              '92600000-0000-4000-8000-000000000090'
            and (
              select count(*) from public.appointments duplicate
              where duplicate.id = appointment.id
            ) = 1
          from public.appointments appointment
          join public.google_calendar_sync_conflicts conflict
            on conflict.id = %L::uuid
          join public.google_calendar_connections connection
            on connection.id = true
          where appointment.id =
            '92600000-0000-4000-8000-000000000040'
        $verify$,
        :'race_conflict_id'
      )
    ) as persisted(state_ok boolean)
  ),
  'the failed apply preserves one original appointment and the pending review'
);

select completed
from extensions.dblink(
  'calendar_conflict_apply_finisher',
  $complete_inbound$
    select public.complete_google_calendar_inbound_sync(
      926,
      '92600000-0000-4000-8000-000000000090',
      'conflict-apply-token-after',
      '{"conflictsOpened":1}'::jsonb,
      1,
      2,
      (current_date - 1)::timestamp
        at time zone 'America/Argentina/Buenos_Aires',
      (current_date + 20)::timestamp
        at time zone 'America/Argentina/Buenos_Aires'
    )
  $complete_inbound$
) as inbound_completion(completed boolean)
\gset inbound_
select ok(
  :'inbound_completed'::boolean
  and (
    select completion_current
    from extensions.dblink(
      'calendar_conflict_apply_setup',
      format(
        $verify$
          select connection.inbound_lease_token is null
            and connection.inbound_lease_expires_at is null
            and connection.last_sync_completed_at >= greatest(
              conflict.detected_at,
              conflict.updated_at
            )
          from public.google_calendar_connections connection
          join public.google_calendar_sync_conflicts conflict
            on conflict.id = %L::uuid
          where connection.id = true
        $verify$,
        :'race_conflict_id'
      )
    ) as completion(completion_current boolean)
  ),
  'the real inbound completion clears the lease and publishes a fresh snapshot'
);

select outcome
from extensions.dblink(
  'calendar_conflict_apply_admin',
  format(
    'select pg_temp.run_calendar_conflict_apply(%L::uuid)',
    :'race_conflict_id'
  )
) as retried(outcome jsonb)
\gset retried_
select ok(
  :'retried_outcome'::jsonb ->> 'exceptionState' is null
  and :'retried_outcome'::jsonb #>> '{result,status}' = 'applied',
  'the same conflict can be applied after the fresh completion'
);
select ok(
  (
    select state_ok
    from extensions.dblink(
      'calendar_conflict_apply_setup',
      format(
        $verify$
          select appointment.starts_at =
              (current_date + 7 + time '12:00')
                at time zone 'America/Argentina/Buenos_Aires'
            and appointment.ends_at =
              (current_date + 7 + time '12:30')
                at time zone 'America/Argentina/Buenos_Aires'
            and conflict.status = 'applied'
            and (
              select count(*) from public.appointments duplicate
              where duplicate.id = appointment.id
            ) = 1
          from public.appointments appointment
          join public.google_calendar_sync_conflicts conflict
            on conflict.id = %L::uuid
          where appointment.id =
            '92600000-0000-4000-8000-000000000040'
        $verify$,
        :'race_conflict_id'
      )
    ) as applied(state_ok boolean)
  ),
  'fresh apply moves exactly one appointment and resolves exactly that review'
);

-- A rejected external move requests a restoring upsert. Its remotely observed
-- destination remains occupied until the current job records a later,
-- identity-matched successful completion of that exact restoration.
select extensions.dblink_exec(
  'calendar_conflict_apply_setup',
  $rejected_fixture$
    insert into public.google_calendar_sync_conflicts (
      id, appointment_id, google_event_id, kind, status,
      proposed_starts_at, proposed_ends_at,
      observed_starts_at, observed_ends_at,
      google_updated_at, connection_generation
    )
    select
      '92600000-0000-4000-8000-000000000061',
      appointment.id,
      public.google_calendar_automation_event_id(appointment.id),
      'reschedule_requested', 'pending',
      (current_date + 8 + time '12:00')
        at time zone 'America/Argentina/Buenos_Aires',
      (current_date + 8 + time '12:30')
        at time zone 'America/Argentina/Buenos_Aires',
      appointment.starts_at, appointment.ends_at,
      clock_timestamp(), 926
    from public.appointments appointment
    where appointment.id = '92600000-0000-4000-8000-000000000041'
  $rejected_fixture$
);
select outcome
from extensions.dblink(
  'calendar_conflict_apply_admin',
  $$select pg_temp.run_calendar_conflict_reject(
    '92600000-0000-4000-8000-000000000061'
  )$$
) as rejected(outcome jsonb)
\gset rejected_
select ok(
  :'rejected_outcome'::jsonb ->> 'exceptionState' is null
  and :'rejected_outcome'::jsonb #>> '{result,status}' = 'rejected'
  and (
    select restore_pending
    from extensions.dblink(
      'calendar_conflict_apply_setup',
      $verify$
        select job.status = 'pending'
          and job.operation = 'upsert'
          and job.projected_operation = 'upsert'
          and job.projected_starts_at = conflict.observed_starts_at
          and job.projected_ends_at = conflict.observed_ends_at
        from public.google_calendar_sync_jobs job
        join public.google_calendar_sync_conflicts conflict
          on conflict.appointment_id = job.appointment_id
        where conflict.id = '92600000-0000-4000-8000-000000000061'
      $verify$
    ) as restore(restore_pending boolean)
  ),
  'reject keeps the observed destination tied to a pending restoring upsert'
);

select ok(
  (
    select range_occupied
    from extensions.dblink(
      'calendar_conflict_apply_setup',
      $occupied$
        select
          public.google_calendar_conflict_range_is_occupied(
            '92600000-0000-4000-8000-000000000061'
          )
          and not public.appointment_slot_is_available(
            '92600000-0000-4000-8000-000000000001',
            (current_date + 8 + time '12:00')
              at time zone 'America/Argentina/Buenos_Aires',
            30, null, 'America/Argentina/Buenos_Aires'
          )
      $occupied$
    ) as occupied(range_occupied boolean)
  ),
  'the rejected proposed range stays occupied while restore is pending'
);

select extensions.dblink_exec(
  'calendar_conflict_apply_setup',
  $stale_completion$
    set session_replication_role = replica;
    update public.google_calendar_sync_jobs job
    set status = 'succeeded',
        processing_started_at = null,
        projected_operation = 'upsert',
        projected_starts_at = conflict.observed_starts_at,
        projected_ends_at = conflict.observed_ends_at,
        projected_stage = 'confirmed',
        updated_at = conflict.resolved_at - interval '1 millisecond'
    from public.google_calendar_sync_conflicts conflict
    where job.appointment_id = conflict.appointment_id
      and conflict.id = '92600000-0000-4000-8000-000000000061';
    set session_replication_role = origin;
  $stale_completion$
);
select ok(
  (
    select still_occupied
    from extensions.dblink(
      'calendar_conflict_apply_setup',
      $occupied$
        select
          public.google_calendar_conflict_range_is_occupied(
            '92600000-0000-4000-8000-000000000061'
          )
          and not public.appointment_slot_is_available(
            '92600000-0000-4000-8000-000000000001',
            (current_date + 8 + time '12:00')
              at time zone 'America/Argentina/Buenos_Aires',
            30, null, 'America/Argentina/Buenos_Aires'
          )
      $occupied$
    ) as occupied(still_occupied boolean)
  ),
  'a succeeded projection older than rejection cannot release the remote range'
);

select extensions.dblink_exec(
  'calendar_conflict_apply_setup',
  $processing$
    set session_replication_role = replica;
    update public.google_calendar_sync_jobs
    set status = 'processing',
        attempts = greatest(attempts, 1),
        processing_started_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where appointment_id = '92600000-0000-4000-8000-000000000041';
    set session_replication_role = origin;
  $processing$
);
select completed
from extensions.dblink(
  'calendar_conflict_apply_finisher',
  $wrong_ack$
    select public.complete_google_calendar_sync_job(
      '92600000-0000-4000-8000-000000000051',
      (
        select desired_version from public.google_calendar_sync_jobs
        where appointment_id = '92600000-0000-4000-8000-000000000041'
      ),
      'wrong-conflict-apply-event-id',
      926,
      '"wrong-conflict-apply-etag"',
      (current_date + 8 + time '10:00')
        at time zone 'America/Argentina/Buenos_Aires',
      (current_date + 8 + time '10:30')
        at time zone 'America/Argentina/Buenos_Aires',
      '92600000-0000-4000-8000-000000000091',
      'confirmed'
    )
  $wrong_ack$
) as wrong_completion(completed boolean)
\gset wrong_
select ok(
  not :'wrong_completed'::boolean
  and (
    select identity_guarded
    from extensions.dblink(
      'calendar_conflict_apply_setup',
      $verify$
        select job.status = 'processing'
          and public.google_calendar_conflict_range_is_occupied(
            '92600000-0000-4000-8000-000000000061'
          )
        from public.google_calendar_sync_jobs job
        where job.appointment_id =
          '92600000-0000-4000-8000-000000000041'
      $verify$
    ) as guarded(identity_guarded boolean)
  ),
  'a completion for the wrong Google event ID is rejected and releases nothing'
);

select completed
from extensions.dblink(
  'calendar_conflict_apply_finisher',
  $exact_ack$
    select public.complete_google_calendar_sync_job(
      '92600000-0000-4000-8000-000000000051',
      (
        select desired_version from public.google_calendar_sync_jobs
        where appointment_id = '92600000-0000-4000-8000-000000000041'
      ),
      public.google_calendar_automation_event_id(
        '92600000-0000-4000-8000-000000000041'
      ),
      926,
      '"exact-conflict-apply-etag"',
      (current_date + 8 + time '10:00')
        at time zone 'America/Argentina/Buenos_Aires',
      (current_date + 8 + time '10:30')
        at time zone 'America/Argentina/Buenos_Aires',
      '92600000-0000-4000-8000-000000000091',
      'confirmed'
    )
  $exact_ack$
) as exact_completion(completed boolean)
\gset exact_
select ok(
  :'exact_completed'::boolean
  and (
    select released
    from extensions.dblink(
      'calendar_conflict_apply_setup',
      $verify$
        select job.status = 'succeeded'
          and job.updated_at >= conflict.resolved_at
          and job.google_event_id = conflict.google_event_id
          and job.projected_starts_at = conflict.observed_starts_at
          and job.projected_ends_at = conflict.observed_ends_at
          and not public.google_calendar_conflict_range_is_occupied(conflict.id)
          and public.appointment_slot_is_available(
            '92600000-0000-4000-8000-000000000001',
            (current_date + 8 + time '12:00')
              at time zone 'America/Argentina/Buenos_Aires',
            30, null, 'America/Argentina/Buenos_Aires'
          )
        from public.google_calendar_sync_jobs job
        join public.google_calendar_sync_conflicts conflict
          on conflict.appointment_id = job.appointment_id
        where conflict.id = '92600000-0000-4000-8000-000000000061'
      $verify$
    ) as exact(released boolean)
  ),
  'only the later exact successful restore acknowledgement releases the range'
);

select extensions.dblink_exec(
  'calendar_conflict_apply_setup',
  $cleanup$
    begin;
    set local session_replication_role = replica;
    delete from public.reminders
    where appointment_id in (
      '92600000-0000-4000-8000-000000000040',
      '92600000-0000-4000-8000-000000000041'
    );
    delete from public.google_calendar_sync_conflicts
    where appointment_id in (
      '92600000-0000-4000-8000-000000000040',
      '92600000-0000-4000-8000-000000000041'
    );
    delete from public.google_calendar_sync_jobs
    where appointment_id in (
      '92600000-0000-4000-8000-000000000040',
      '92600000-0000-4000-8000-000000000041'
    );
    delete from public.audit_logs
    where actor_user_id = '92600000-0000-4000-8000-000000000099'
       or entity_id in (
         '92600000-0000-4000-8000-000000000040',
         '92600000-0000-4000-8000-000000000041'
       );
    delete from public.appointments
    where id in (
      '92600000-0000-4000-8000-000000000040',
      '92600000-0000-4000-8000-000000000041'
    );
    delete from public.contacts
    where id in (
      '92600000-0000-4000-8000-000000000010',
      '92600000-0000-4000-8000-000000000011'
    );
    delete from public.availability_exceptions
    where professional_id = '92600000-0000-4000-8000-000000000001';
    delete from public.availability_rules
    where professional_id = '92600000-0000-4000-8000-000000000001';
    delete from public.professionals
    where id = '92600000-0000-4000-8000-000000000001';
    delete from public.profiles
    where id = '92600000-0000-4000-8000-000000000099';
    delete from auth.users
    where id = '92600000-0000-4000-8000-000000000099';

    delete from public.google_calendar_connections;
    insert into public.google_calendar_connections
    select * from public.calendar_conflict_apply_connection_backup;
    delete from public.app_settings;
    insert into public.app_settings
    select * from public.calendar_conflict_apply_settings_backup;
    commit;
  $cleanup$
);

select ok(
  (
    select restored
    from extensions.dblink(
      'calendar_conflict_apply_setup',
      $restored$
        select
          (select jsonb_agg(to_jsonb(connection) order by connection.id)
           from public.google_calendar_connections connection)
          is not distinct from
          (select jsonb_agg(to_jsonb(backup) order by backup.id)
           from public.calendar_conflict_apply_connection_backup backup)
          and
          (select jsonb_agg(to_jsonb(settings) order by settings.id)
           from public.app_settings settings)
          is not distinct from
          (select jsonb_agg(to_jsonb(backup) order by backup.id)
           from public.calendar_conflict_apply_settings_backup backup)
          and not exists (
            select 1 from public.appointments
            where id in (
              '92600000-0000-4000-8000-000000000040',
              '92600000-0000-4000-8000-000000000041'
            )
          )
          and not exists (
            select 1 from auth.users
            where id = '92600000-0000-4000-8000-000000000099'
          )
      $restored$
    ) as cleanup(restored boolean)
  ),
  'cleanup removes the fixture and restores both singleton rows byte-for-byte'
);
select extensions.dblink_exec(
  'calendar_conflict_apply_setup',
  'drop table public.calendar_conflict_apply_connection_backup; ' ||
  'drop table public.calendar_conflict_apply_settings_backup'
);

select extensions.dblink_disconnect('calendar_conflict_apply_observer');
select extensions.dblink_disconnect('calendar_conflict_apply_admin');
select extensions.dblink_disconnect('calendar_conflict_apply_finisher');
select extensions.dblink_disconnect('calendar_conflict_apply_setup');

select * from finish();
rollback;
