\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set local search_path = public, extensions;
select plan(9);

-- The source-level contract complements the race below: all three Calendar
-- predicates must be evaluated only after entering the professional critical
-- section, and the durable proof processor must remain the final step.
with definition as (
  select pg_get_functiondef(
    'public.process_automated_deposit_proof(uuid,uuid,uuid,jsonb,text,text,boolean)'::regprocedure
  ) as body
), positions as (
  select
    strpos(body, 'perform pg_advisory_xact_lock(') as professional_lock,
    strpos(body, 'public.google_calendar_booking_observation_covers(')
      as observation_guard,
    strpos(body, 'public.google_calendar_pre_reservation_is_projected(')
      as projection_guard,
    strpos(body, 'public.appointment_slot_is_free_for(') as slot_guard,
    strpos(
      body,
      'public.process_automated_deposit_proof_without_calendar_guard('
    ) as durable_processor
  from definition
)
select ok(
  professional_lock > 0
  and observation_guard > professional_lock
  and projection_guard > professional_lock
  and slot_guard > professional_lock
  and durable_processor > greatest(
    observation_guard,
    projection_guard,
    slot_guard
  ),
  'automatic proof takes the professional lock before every Calendar guard'
)
from positions;

select extensions.dblink_connect(
  'deposit_proof_calendar_lock_setup',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);
select extensions.dblink_connect(
  'deposit_proof_calendar_lock_holder',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);
select extensions.dblink_connect(
  'deposit_proof_calendar_lock_worker',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);

-- dblink sessions cannot observe the caller's outer transaction, so this
-- fixture is committed deliberately. Preserve complete singleton rows in the
-- setup session and restore them byte-for-byte during explicit cleanup.
select extensions.dblink_exec(
  'deposit_proof_calendar_lock_setup',
  $setup$
    begin;

    create temporary table deposit_proof_calendar_lock_connection_backup
      on commit preserve rows
      as select * from public.google_calendar_connections;
    create temporary table deposit_proof_calendar_lock_settings_backup
      on commit preserve rows
      as select * from public.app_settings;

    set local session_replication_role = replica;

    -- Make an interrupted assertion phase rerunnable without touching any
    -- non-synthetic domain row.
    delete from public.whatsapp_automation_effects
    where execution_message_id =
      '92500000-0000-4000-8000-000000000030';
    delete from public.automated_deposit_proof_results
    where appointment_id = '92500000-0000-4000-8000-000000000040'
       or proof_message_id = '92500000-0000-4000-8000-000000000030';
    delete from public.deposit_proof_reviews
    where appointment_id = '92500000-0000-4000-8000-000000000040'
       or proof_message_id = '92500000-0000-4000-8000-000000000030';
    delete from public.whatsapp_automation_dispatches
    where message_id = '92500000-0000-4000-8000-000000000030';
    delete from public.whatsapp_automation_executions
    where message_id = '92500000-0000-4000-8000-000000000030';
    delete from public.reminders
    where appointment_id = '92500000-0000-4000-8000-000000000040'
       or message_id = '92500000-0000-4000-8000-000000000030';
    delete from public.google_calendar_sync_conflicts
    where appointment_id = '92500000-0000-4000-8000-000000000040';
    delete from public.google_calendar_sync_jobs
    where appointment_id = '92500000-0000-4000-8000-000000000040';
    delete from public.audit_logs
    where entity_id in (
      '92500000-0000-4000-8000-000000000040',
      '92500000-0000-4000-8000-000000000030',
      '92500000-0000-4000-8000-000000000020'
    );
    delete from public.appointments
    where id = '92500000-0000-4000-8000-000000000040';
    delete from public.automation_sessions
    where conversation_id = '92500000-0000-4000-8000-000000000020';
    delete from public.messages
    where id = '92500000-0000-4000-8000-000000000030';
    delete from public.conversations
    where id = '92500000-0000-4000-8000-000000000020';
    delete from public.contacts
    where id = '92500000-0000-4000-8000-000000000010';
    delete from public.availability_exceptions
    where professional_id = '92500000-0000-4000-8000-000000000001';
    delete from public.availability_rules
    where professional_id = '92500000-0000-4000-8000-000000000001';
    delete from public.services
    where id = '92500000-0000-4000-8000-000000000002';
    delete from public.professionals
    where id = '92500000-0000-4000-8000-000000000001';

    update public.app_settings
    set timezone = 'America/Argentina/Buenos_Aires',
        appointment_buffer_minutes = 15,
        deposit_enabled = true,
        deposit_amount_ars = 12345,
        deposit_alias = 'calendar.lock.alias',
        deposit_holder = 'Calendar Lock Holder',
        booking_hold_minutes = 60,
        reminder_24h_enabled = false,
        reminder_2h_enabled = false
    where id = true;

    update public.google_calendar_connections
    set status = 'connected',
        connected_by = null,
        google_account_id = 'deposit-proof-lock-account',
        google_account_email = 'deposit-proof-lock@example.test',
        google_calendar_id = 'deposit-proof-lock-calendar',
        google_calendar_name = 'Deposit Proof Lock Calendar',
        google_calendar_timezone = 'America/Argentina/Buenos_Aires',
        refresh_token_secret_id =
          '92500000-0000-4000-8000-000000000092',
        connected_at = clock_timestamp() - interval '1 day',
        disconnected_at = null,
        last_synced_at = clock_timestamp(),
        last_error = null,
        connection_generation = 925,
        inbound_sync_token = 'deposit-proof-lock-token',
        inbound_sync_token_generation = 925,
        inbound_sync_state = 'incremental',
        inbound_first_import_approved_at =
          clock_timestamp() - interval '1 day',
        inbound_first_import_approved_by = null,
        inbound_lease_token = null,
        inbound_lease_expires_at = null,
        last_checked_at = clock_timestamp(),
        last_sync_completed_at = clock_timestamp(),
        last_sync_summary = '{}'::jsonb,
        last_sync_error = null,
        sync_scope_google_account_id = 'deposit-proof-lock-account',
        sync_scope_google_calendar_id = 'deposit-proof-lock-calendar',
        sync_scope_generation = 925,
        inbound_sync_contract_version = 2,
        inbound_coverage_starts_at = (
          current_date
          + 6
          + mod(8 - extract(isodow from current_date)::integer, 7)
        )::timestamp at time zone 'America/Argentina/Buenos_Aires',
        inbound_coverage_ends_at = (
          current_date
          + 27
          + mod(8 - extract(isodow from current_date)::integer, 7)
        )::timestamp at time zone 'America/Argentina/Buenos_Aires',
        inbound_sync_timezone = 'America/Argentina/Buenos_Aires',
        inbound_lease_sync_contract_version = null,
        inbound_lease_coverage_starts_at = null,
        inbound_lease_coverage_ends_at = null,
        inbound_lease_timezone = null,
        automation_enabled = true,
        automation_epoch = '92500000-0000-4000-8000-000000000091',
        automation_activated_at = clock_timestamp() - interval '10 minutes',
        automation_google_account_id = 'deposit-proof-lock-account',
        automation_google_calendar_id = 'deposit-proof-lock-calendar',
        automation_connection_generation = 925
    where id = true;

    insert into public.professionals (
      id, name, specialty, appointment_duration_minutes, active
    ) values (
      '92500000-0000-4000-8000-000000000001',
      'Calendar Lock Professional', 'Test', 30, true
    );
    insert into public.services (
      id, name, duration_minutes, active, sort_order
    ) values (
      '92500000-0000-4000-8000-000000000002',
      'Calendar Lock Service', 30, true, 9250
    );
    insert into public.contacts (
      id, phone_e164, whatsapp_id, name, coverage, is_existing_patient
    ) values (
      '92500000-0000-4000-8000-000000000010',
      '+12025550125', '12025550125', 'Calendar Lock Contact', 'ioma', true
    );
    insert into public.conversations (
      id, contact_id, status, automation_mode, needs_human, priority,
      last_message_at, last_inbound_message_at,
      automation_test_override_activated_at,
      automation_test_override_until
    ) values (
      '92500000-0000-4000-8000-000000000020',
      '92500000-0000-4000-8000-000000000010',
      'open', 'auto', false, false,
      clock_timestamp() - interval '1 second',
      clock_timestamp() - interval '1 second',
      clock_timestamp() - interval '1 minute',
      clock_timestamp() + interval '1 hour'
    );
    insert into public.appointments (
      id, contact_id, professional_id, service_id, starts_at, ends_at,
      status, source, coverage, duration_minutes, deposit_status,
      hold_expires_at, hold_expired_notification_status,
      deposit_expected_amount_ars, deposit_expected_alias,
      deposit_expected_holder, created_at
    ) values (
      '92500000-0000-4000-8000-000000000040',
      '92500000-0000-4000-8000-000000000010',
      '92500000-0000-4000-8000-000000000001',
      '92500000-0000-4000-8000-000000000002',
      (
        current_date
        + 7
        + mod(8 - extract(isodow from current_date)::integer, 7)
        + time '10:00'
      ) at time zone 'America/Argentina/Buenos_Aires',
      (
        current_date
        + 7
        + mod(8 - extract(isodow from current_date)::integer, 7)
        + time '10:30'
      ) at time zone 'America/Argentina/Buenos_Aires',
      'scheduled', 'whatsapp', 'ioma', 30, 'pending',
      clock_timestamp() + interval '1 hour', 'pending',
      12345, 'calendar.lock.alias', 'Calendar Lock Holder',
      clock_timestamp() - interval '2 seconds'
    );
    insert into public.automation_sessions (
      conversation_id, state, context, expires_at
    ) values (
      '92500000-0000-4000-8000-000000000020',
      'waiting_deposit',
      jsonb_build_object(
        'appointmentId', '92500000-0000-4000-8000-000000000040'
      ),
      clock_timestamp() + interval '1 hour'
    );
    insert into public.messages (
      id, conversation_id, contact_id, direction, type, body, status,
      metadata, whatsapp_ingest_sequence, created_at
    ) values (
      '92500000-0000-4000-8000-000000000030',
      '92500000-0000-4000-8000-000000000020',
      '92500000-0000-4000-8000-000000000010',
      'inbound', 'image', 'Synthetic Calendar lock proof', 'delivered',
      '{}'::jsonb, 925000000001,
      clock_timestamp() - interval '1 second'
    );
    insert into public.whatsapp_automation_executions (
      message_id, conversation_id, contact_id, message_created_at,
      message_ingest_sequence, status, attempts, retryable,
      request_snapshot, message_snapshot, conversation_snapshot,
      contact_snapshot, settings_snapshot, session_state, session_context,
      session_expires_at, fresh_session, snapshot_at,
      processing_started_at, lease_expires_at, lease_token
    ) values (
      '92500000-0000-4000-8000-000000000030',
      '92500000-0000-4000-8000-000000000020',
      '92500000-0000-4000-8000-000000000010',
      (select created_at from public.messages
       where id = '92500000-0000-4000-8000-000000000030'),
      925000000001, 'processing', 1, true, '{}'::jsonb,
      jsonb_build_object(
        'id', '92500000-0000-4000-8000-000000000030',
        'conversation_id', '92500000-0000-4000-8000-000000000020',
        'contact_id', '92500000-0000-4000-8000-000000000010',
        'body', 'Synthetic Calendar lock proof',
        'direction', 'inbound',
        'metadata', '{}'::jsonb,
        'whatsapp_ingest_sequence', 925000000001,
        'type', 'image',
        'coexistence_account_id', null
      ),
      jsonb_build_object(
        'id', '92500000-0000-4000-8000-000000000020',
        'contact_id', '92500000-0000-4000-8000-000000000010',
        'automation_mode', 'auto',
        'needs_human', false,
        'priority', false,
        'coexistence_account_id', null
      ),
      jsonb_build_object(
        'id', '92500000-0000-4000-8000-000000000010',
        'phone_e164', '+12025550125',
        'whatsapp_id', '12025550125',
        'name', 'Calendar Lock Contact',
        'coverage', 'ioma',
        'is_existing_patient', true
      ),
      (select to_jsonb(settings) from public.app_settings settings where id),
      'waiting_deposit',
      jsonb_build_object(
        'appointmentId', '92500000-0000-4000-8000-000000000040'
      ),
      clock_timestamp() + interval '1 hour', false,
      clock_timestamp() - interval '500 milliseconds',
      clock_timestamp() - interval '500 milliseconds',
      clock_timestamp() + interval '10 minutes',
      '92500000-0000-4000-8000-000000000090'
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
      '92500000-0000-4000-8000-000000000050', appointment.id,
      'upsert', 1, 925, 'succeeded', 1, clock_timestamp(), null,
      public.google_calendar_automation_event_id(appointment.id), null,
      '"synthetic-calendar-lock-etag"',
      appointment.starts_at, appointment.ends_at, 'upsert',
      '92500000-0000-4000-8000-000000000091',
      'deposit-proof-lock-account', 'deposit-proof-lock-calendar', 925,
      'pre_reservation', 'pre_reservation'
    from public.appointments appointment
    where appointment.id = '92500000-0000-4000-8000-000000000040';

    -- This timestamp is deliberately after the durable execution started.
    update public.google_calendar_connections
    set last_checked_at = clock_timestamp(),
        last_synced_at = clock_timestamp(),
        last_sync_completed_at = clock_timestamp(),
        last_sync_error = null
    where id = true;

    commit;
  $setup$
);

select extensions.dblink_exec(
  'deposit_proof_calendar_lock_worker',
  $$set request.jwt.claims = '{"role":"service_role"}'$$
);
select extensions.dblink_exec(
  'deposit_proof_calendar_lock_worker',
  $$set request.jwt.claim.role = 'service_role'$$
);
select extensions.dblink_exec(
  'deposit_proof_calendar_lock_worker',
  $worker_function$
    create function pg_temp.run_deposit_proof_calendar_lock()
    returns jsonb
    language plpgsql
    as $body$
    declare
      first_result jsonb;
      retry_result jsonb;
      error_state text;
      error_message text;
    begin
      begin
        first_result := public.process_automated_deposit_proof(
          '92500000-0000-4000-8000-000000000030',
          '92500000-0000-4000-8000-000000000090',
          '92500000-0000-4000-8000-000000000040',
          '{"legible":true,"amount":12345,"currency":"ARS","date":null,"destination":"calendar.lock.alias","holder":"Calendar Lock Holder","operationId":"calendar-lock-order"}'::jsonb,
          repeat('a', 64),
          'deposit-proof-basic/v1',
          true
        );
        retry_result := public.process_automated_deposit_proof(
          '92500000-0000-4000-8000-000000000030',
          '92500000-0000-4000-8000-000000000090',
          '92500000-0000-4000-8000-000000000040',
          '{"legible":true,"amount":12345,"currency":"ARS","date":null,"destination":"calendar.lock.alias","holder":"Calendar Lock Holder","operationId":"calendar-lock-order"}'::jsonb,
          repeat('a', 64),
          'deposit-proof-basic/v1',
          true
        );
      exception when others then
        error_state := sqlstate;
        error_message := sqlerrm;
      end;

      return jsonb_build_object(
        'first', first_result,
        'retry', retry_result,
        'exceptionState', error_state,
        'exceptionMessage', error_message,
        'appointmentStatus', (
          select appointment.status::text
          from public.appointments appointment
          where appointment.id = '92500000-0000-4000-8000-000000000040'
        ),
        'depositStatus', (
          select appointment.deposit_status::text
          from public.appointments appointment
          where appointment.id = '92500000-0000-4000-8000-000000000040'
        ),
        'depositConfirmedAt', (
          select appointment.deposit_confirmed_at
          from public.appointments appointment
          where appointment.id = '92500000-0000-4000-8000-000000000040'
        ),
        'proofResultCount', (
          select count(*)
          from public.automated_deposit_proof_results result
          where result.appointment_id =
            '92500000-0000-4000-8000-000000000040'
        ),
        'storedAutoApprove', (
          select result.auto_approve
          from public.automated_deposit_proof_results result
          where result.appointment_id =
            '92500000-0000-4000-8000-000000000040'
        ),
        'effectCount', (
          select count(*)
          from public.whatsapp_automation_effects effect
          where effect.execution_message_id =
            '92500000-0000-4000-8000-000000000030'
            and effect.effect_type = 'appointment_deposit_process'
        ),
        'calendarReviewAuditCount', (
          select count(*)
          from public.audit_logs audit
          where audit.action =
              'deposit.calendar_availability_review_required'
            and audit.entity_id =
              '92500000-0000-4000-8000-000000000040'
        )
      );
    end;
    $body$;
  $worker_function$
);

select ok(
  (
    select observation_ok and projection_ok and slot_ok
    from extensions.dblink(
      'deposit_proof_calendar_lock_setup',
      $baseline$
        select
          public.google_calendar_booking_observation_covers(
            execution.processing_started_at,
            appointment.starts_at,
            appointment.ends_at + interval '15 minutes',
            appointment.id
          ),
          public.google_calendar_pre_reservation_is_projected(appointment.id),
          public.appointment_slot_is_free_for(appointment.id)
        from public.appointments appointment
        join public.whatsapp_automation_executions execution
          on execution.message_id =
            '92500000-0000-4000-8000-000000000030'
        where appointment.id =
          '92500000-0000-4000-8000-000000000040'
      $baseline$
    ) as baseline(
      observation_ok boolean,
      projection_ok boolean,
      slot_ok boolean
    )
  ),
  'the committed control fixture begins with a complete fresh Calendar proof'
);

-- Prove that this exact proof/context is capable of confirmation. Rollback
-- leaves the committed baseline unchanged for the adversarial interleaving.
select extensions.dblink_exec(
  'deposit_proof_calendar_lock_worker',
  'begin'
);
select outcome
from extensions.dblink(
  'deposit_proof_calendar_lock_worker',
  'select pg_temp.run_deposit_proof_calendar_lock()'
) as control(outcome jsonb)
\gset control_
select ok(
  :'control_outcome'::jsonb ->> 'exceptionState' is null
  and :'control_outcome'::jsonb #>> '{first,status}' = 'confirmed'
  and :'control_outcome'::jsonb #>> '{retry,status}' = 'already_confirmed'
  and (:'control_outcome'::jsonb #>> '{retry,idempotent}')::boolean
  and :'control_outcome'::jsonb ->> 'appointmentStatus' = 'confirmed'
  and :'control_outcome'::jsonb ->> 'depositStatus' = 'confirmed'
  and (:'control_outcome'::jsonb ->> 'depositConfirmedAt') is not null
  and (:'control_outcome'::jsonb ->> 'proofResultCount')::integer = 1
  and (:'control_outcome'::jsonb ->> 'effectCount')::integer = 1,
  'the baseline confirms once and an exact retry is idempotent'
);
select extensions.dblink_exec(
  'deposit_proof_calendar_lock_worker',
  'rollback'
);

create function pg_temp.wait_for_deposit_proof_calendar_lock(
  p_worker_pid integer,
  p_holder_pid integer
)
returns boolean
language plpgsql
as $$
declare
  deadline timestamptz := clock_timestamp() + interval '3 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if p_holder_pid = any(pg_blocking_pids(p_worker_pid))
      and exists (
        select 1
        from pg_locks waiting
        join pg_locks holding
          on holding.locktype = waiting.locktype
         and holding.database is not distinct from waiting.database
         and holding.classid is not distinct from waiting.classid
         and holding.objid is not distinct from waiting.objid
         and holding.objsubid is not distinct from waiting.objsubid
        where waiting.pid = p_worker_pid
          and waiting.locktype = 'advisory'
          and waiting.mode = 'ExclusiveLock'
          and not waiting.granted
          and holding.pid = p_holder_pid
          and holding.mode = 'ExclusiveLock'
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

select backend_pid
from extensions.dblink(
  'deposit_proof_calendar_lock_holder',
  'select pg_backend_pid()'
) as holder(backend_pid integer)
\gset holder_
select backend_pid
from extensions.dblink(
  'deposit_proof_calendar_lock_worker',
  'select pg_backend_pid()'
) as worker(backend_pid integer)
\gset worker_

select extensions.dblink_exec(
  'deposit_proof_calendar_lock_holder',
  'begin'
);
select extensions.dblink_exec(
  'deposit_proof_calendar_lock_holder',
  $hold_professional$
    do $body$
    begin
      perform pg_advisory_xact_lock(hashtextextended(
        '92500000-0000-4000-8000-000000000001', 0
      ));
    end;
    $body$;
  $hold_professional$
);
select extensions.dblink_exec(
  'deposit_proof_calendar_lock_worker',
  'begin'
);
select extensions.dblink_send_query(
  'deposit_proof_calendar_lock_worker',
  'select pg_temp.run_deposit_proof_calendar_lock()'
);

select pg_temp.wait_for_deposit_proof_calendar_lock(
  :'worker_backend_pid'::integer,
  :'holder_backend_pid'::integer
) as observed
\gset professional_wait_
select ok(
  :'professional_wait_observed'::boolean
  and not exists (
    select 1
    from pg_locks worker_lock
    where worker_lock.pid = :'worker_backend_pid'::integer
      and worker_lock.locktype = 'advisory'
      and worker_lock.mode = 'ShareLock'
      and worker_lock.granted
  ),
  'the worker waits on the held professional lock before taking a Calendar shared lock'
);

-- Publish only one causal change while the proof waits: revoke evidence that
-- its own pre-reservation still exists in Google. Observation freshness and
-- all competing-slot checks remain valid.
select extensions.dblink_exec(
  'deposit_proof_calendar_lock_holder',
  $revoke_projection$
    update public.google_calendar_sync_jobs
    set projected_stage = null
    where appointment_id = '92500000-0000-4000-8000-000000000040'
  $revoke_projection$
);
select observation_ok, projection_ok, slot_ok
from extensions.dblink(
  'deposit_proof_calendar_lock_holder',
  $post_change$
    select
      public.google_calendar_booking_observation_covers(
        execution.processing_started_at,
        appointment.starts_at,
        appointment.ends_at + interval '15 minutes',
        appointment.id
      ),
      public.google_calendar_pre_reservation_is_projected(appointment.id),
      public.appointment_slot_is_free_for(appointment.id)
    from public.appointments appointment
    join public.whatsapp_automation_executions execution
      on execution.message_id =
        '92500000-0000-4000-8000-000000000030'
    where appointment.id = '92500000-0000-4000-8000-000000000040'
  $post_change$
) as changed(
  observation_ok boolean,
  projection_ok boolean,
  slot_ok boolean
)
\gset changed_
select ok(
  :'changed_observation_ok'::boolean
  and not :'changed_projection_ok'::boolean
  and :'changed_slot_ok'::boolean,
  'the concurrent commit changes only pre-reservation projection evidence'
);

select extensions.dblink_exec(
  'deposit_proof_calendar_lock_holder',
  'commit'
);
select outcome
from extensions.dblink_get_result('deposit_proof_calendar_lock_worker')
  as raced(outcome jsonb)
\gset raced_
select count(*)
from extensions.dblink_get_result('deposit_proof_calendar_lock_worker')
  as raced_result_drained(outcome jsonb);

select ok(
  :'raced_outcome'::jsonb ->> 'exceptionState' is null
  and :'raced_outcome'::jsonb #>> '{first,status}' = 'review'
  and :'raced_outcome'::jsonb #>>
    '{first,calendar_availability_verified}' = 'false'
  and (:'raced_outcome'::jsonb #> '{first,review_reasons}')
    @> '["CALENDAR_AVAILABILITY_UNVERIFIED"]'::jsonb
  and :'raced_outcome'::jsonb #>> '{retry,status}' = 'review'
  and (:'raced_outcome'::jsonb #>> '{retry,idempotent}')::boolean
  and :'raced_outcome'::jsonb ->> 'appointmentStatus' = 'scheduled'
  and :'raced_outcome'::jsonb ->> 'depositStatus' = 'proof_received'
  and (:'raced_outcome'::jsonb ->> 'depositConfirmedAt') is null,
  'post-lock projection loss routes the proof to review without confirmation'
);
select ok(
  (:'raced_outcome'::jsonb ->> 'proofResultCount')::integer = 1
  and not (:'raced_outcome'::jsonb ->> 'storedAutoApprove')::boolean
  and (:'raced_outcome'::jsonb ->> 'effectCount')::integer = 1
  and (:'raced_outcome'::jsonb ->> 'calendarReviewAuditCount')::integer = 1,
  'the race and its retry persist one conservative result, effect and audit'
);
select extensions.dblink_exec(
  'deposit_proof_calendar_lock_worker',
  'rollback'
);

select ok(
  (
    select fixture_intact
    from extensions.dblink(
      'deposit_proof_calendar_lock_setup',
      $intact$
        select
          appointment.status = 'scheduled'
          and appointment.deposit_status = 'pending'
          and appointment.deposit_proof_message_id is null
          and appointment.deposit_confirmed_at is null
          and job.projected_stage is null
          and not exists (
            select 1
            from public.automated_deposit_proof_results result
            where result.appointment_id = appointment.id
          )
          and not exists (
            select 1
            from public.whatsapp_automation_effects effect
            where effect.execution_message_id =
              '92500000-0000-4000-8000-000000000030'
          )
        from public.appointments appointment
        join public.google_calendar_sync_jobs job
          on job.appointment_id = appointment.id
        where appointment.id =
          '92500000-0000-4000-8000-000000000040'
      $intact$
    ) as intact(fixture_intact boolean)
  ),
  'worker rollbacks leave no proof mutation beyond the deliberate projection loss'
);

select extensions.dblink_exec(
  'deposit_proof_calendar_lock_setup',
  $cleanup$
    begin;
    set local session_replication_role = replica;

    delete from public.whatsapp_automation_effects
    where execution_message_id =
      '92500000-0000-4000-8000-000000000030';
    delete from public.automated_deposit_proof_results
    where appointment_id = '92500000-0000-4000-8000-000000000040'
       or proof_message_id = '92500000-0000-4000-8000-000000000030';
    delete from public.deposit_proof_reviews
    where appointment_id = '92500000-0000-4000-8000-000000000040'
       or proof_message_id = '92500000-0000-4000-8000-000000000030';
    delete from public.whatsapp_automation_dispatches
    where message_id = '92500000-0000-4000-8000-000000000030';
    delete from public.whatsapp_automation_executions
    where message_id = '92500000-0000-4000-8000-000000000030';
    delete from public.reminders
    where appointment_id = '92500000-0000-4000-8000-000000000040'
       or message_id = '92500000-0000-4000-8000-000000000030';
    delete from public.google_calendar_sync_conflicts
    where appointment_id = '92500000-0000-4000-8000-000000000040';
    delete from public.google_calendar_sync_jobs
    where appointment_id = '92500000-0000-4000-8000-000000000040';
    delete from public.audit_logs
    where entity_id in (
      '92500000-0000-4000-8000-000000000040',
      '92500000-0000-4000-8000-000000000030',
      '92500000-0000-4000-8000-000000000020'
    );
    delete from public.appointments
    where id = '92500000-0000-4000-8000-000000000040';
    delete from public.automation_sessions
    where conversation_id = '92500000-0000-4000-8000-000000000020';
    delete from public.messages
    where id = '92500000-0000-4000-8000-000000000030';
    delete from public.conversations
    where id = '92500000-0000-4000-8000-000000000020';
    delete from public.contacts
    where id = '92500000-0000-4000-8000-000000000010';
    delete from public.availability_exceptions
    where professional_id = '92500000-0000-4000-8000-000000000001';
    delete from public.availability_rules
    where professional_id = '92500000-0000-4000-8000-000000000001';
    delete from public.services
    where id = '92500000-0000-4000-8000-000000000002';
    delete from public.professionals
    where id = '92500000-0000-4000-8000-000000000001';

    delete from public.google_calendar_connections;
    insert into public.google_calendar_connections
    select *
    from pg_temp.deposit_proof_calendar_lock_connection_backup;
    delete from public.app_settings;
    insert into public.app_settings
    select *
    from pg_temp.deposit_proof_calendar_lock_settings_backup;

    commit;
  $cleanup$
);

select ok(
  (
    select restored
    from extensions.dblink(
      'deposit_proof_calendar_lock_setup',
      $restored$
        select
          (select jsonb_agg(to_jsonb(connection) order by connection.id)
           from public.google_calendar_connections connection)
          is not distinct from
          (select jsonb_agg(to_jsonb(backup) order by backup.id)
           from pg_temp.deposit_proof_calendar_lock_connection_backup backup)
          and
          (select jsonb_agg(to_jsonb(settings) order by settings.id)
           from public.app_settings settings)
          is not distinct from
          (select jsonb_agg(to_jsonb(backup) order by backup.id)
           from pg_temp.deposit_proof_calendar_lock_settings_backup backup)
          and not exists (
            select 1 from public.appointments
            where id = '92500000-0000-4000-8000-000000000040'
          )
          and not exists (
            select 1 from public.messages
            where id = '92500000-0000-4000-8000-000000000030'
          )
          and not exists (
            select 1 from public.professionals
            where id = '92500000-0000-4000-8000-000000000001'
          )
      $restored$
    ) as restored(restored boolean)
  ),
  'cleanup removes the fixture and restores both singleton rows byte-for-byte'
);

select extensions.dblink_disconnect('deposit_proof_calendar_lock_holder');
select extensions.dblink_disconnect('deposit_proof_calendar_lock_worker');
select extensions.dblink_disconnect('deposit_proof_calendar_lock_setup');

select * from finish();
rollback;
