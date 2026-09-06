\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set local search_path = public, extensions;
select plan(11);

select extensions.dblink_connect(
  'booking_overlap_setup',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);
select extensions.dblink_exec(
  'booking_overlap_setup',
  $setup$
    create table public.booking_overlap_settings_backup as
    select appointment_buffer_minutes, minimum_booking_notice_minutes,
           ioma_duration_minutes, private_duration_minutes,
           deposit_enabled, booking_hold_minutes
    from public.app_settings where id = true;
    update public.app_settings
    set appointment_buffer_minutes = 15,
        minimum_booking_notice_minutes = 0,
        ioma_duration_minutes = 30,
        private_duration_minutes = 30,
        deposit_enabled = true,
        booking_hold_minutes = 60
    where id = true;
    insert into public.professionals (
      id, name, specialty, appointment_duration_minutes, active
    ) values (
      '92400000-0000-4000-8000-000000000001',
      'Concurrent Booking Professional', 'Test', 30, true
    );
    insert into public.services (id, name, duration_minutes, active, sort_order)
    values (
      '92400000-0000-4000-8000-000000000002',
      'Concurrent Booking Service', 30, true, 9240
    );
    insert into public.availability_rules (
      professional_id, weekday, start_time, end_time, slot_minutes, active
    ) values (
      '92400000-0000-4000-8000-000000000001',
      1, '08:00', '18:00', 15, true
    );
    insert into public.contacts (id, phone_e164, name, coverage)
    values
      ('92400000-0000-4000-8000-000000000010', '+12025550120', 'Concurrent A', 'ioma'),
      ('92400000-0000-4000-8000-000000000011', '+12025550121', 'Concurrent B', 'ioma')
  $setup$
);

select extensions.dblink_connect(
  'booking_overlap_a',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);
select extensions.dblink_connect(
  'booking_overlap_b',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);
select extensions.dblink_connect(
  'booking_overlap_c',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);
select extensions.dblink_exec('booking_overlap_a', 'begin');
select extensions.dblink_exec('booking_overlap_b', 'begin');
select extensions.dblink_exec(
  'booking_overlap_a',
  $$set request.jwt.claims = '{"role":"service_role"}'$$
);
select extensions.dblink_exec(
  'booking_overlap_a',
  $$set request.jwt.claim.role = 'service_role'$$
);
select extensions.dblink_exec(
  'booking_overlap_b',
  $$set request.jwt.claims = '{"role":"service_role"}'$$
);
select extensions.dblink_exec(
  'booking_overlap_b',
  $$set request.jwt.claim.role = 'service_role'$$
);
select extensions.dblink_exec(
  'booking_overlap_b',
  $function$
    create function pg_temp.try_overlapping_booking()
    returns text
    language plpgsql
    as $body$
    begin
      perform public.create_service_appointment(
        '92400000-0000-4000-8000-000000000011',
        '92400000-0000-4000-8000-000000000001',
        '92400000-0000-4000-8000-000000000002',
        (
          current_date
          + 7
          + mod(8 - extract(isodow from current_date)::integer, 7)
          + time '10:35'
        ) at time zone 'America/Argentina/Buenos_Aires',
        'whatsapp',
        null
      );
      return 'CREATED';
    exception when sqlstate 'P0001' then
      return sqlerrm;
    end;
    $body$
  $function$
);

select extensions.dblink_send_query(
  'booking_overlap_a',
  $query$
    select (public.create_service_appointment(
      '92400000-0000-4000-8000-000000000010',
      '92400000-0000-4000-8000-000000000001',
      '92400000-0000-4000-8000-000000000002',
      (
        current_date
        + 7
        + mod(8 - extract(isodow from current_date)::integer, 7)
        + time '10:00'
      ) at time zone 'America/Argentina/Buenos_Aires',
      'whatsapp',
      null
    )).id::text
  $query$
);
select appointment_id
from extensions.dblink_get_result('booking_overlap_a')
  as first_booking(appointment_id text)
\gset first_
select count(*)
from extensions.dblink_get_result('booking_overlap_a')
  as first_booking_drained(appointment_id text);

select ok(
  :'first_appointment_id' ~ '^[0-9a-f-]{36}$',
  'the first transactional booking is persisted in its open transaction'
);

select backend_pid
from extensions.dblink('booking_overlap_b', 'select pg_backend_pid()')
  as backend(backend_pid integer)
\gset overlap_
select extensions.dblink_send_query(
  'booking_overlap_b',
  'select pg_temp.try_overlapping_booking()'
);
select pg_sleep(0.1);
select is(
  (
    select wait_event
    from extensions.dblink(
      'booking_overlap_setup',
      format(
        'select wait_event from pg_stat_activity where pid = %s',
        :'overlap_backend_pid'
      )
    ) as activity(wait_event text)
  ),
  'advisory',
  'the simultaneous buffer-only overlap waits on the professional lock'
);

select extensions.dblink_exec('booking_overlap_a', 'commit');
select outcome
from extensions.dblink_get_result('booking_overlap_b')
  as second_booking(outcome text)
\gset second_
select count(*)
from extensions.dblink_get_result('booking_overlap_b')
  as second_booking_drained(outcome text);

select ok(
  :'second_outcome' = 'SLOT_UNAVAILABLE'
  and (
    select appointment_count = 1
    from extensions.dblink(
      'booking_overlap_setup',
      $$select count(*)::bigint
        from public.appointments
        where professional_id = '92400000-0000-4000-8000-000000000001'$$
    ) as persisted(appointment_count bigint)
  ),
  'exactly one simultaneous buffer-overlapping reservation commits'
);

select extensions.dblink_exec('booking_overlap_b', 'rollback');

-- The booking holds the shared Calendar barrier from availability through the
-- appointment trigger. A concurrent inbound lease request must wait without
-- making the trigger upgrade to an exclusive lock (the former deadlock).
select extensions.dblink_exec('booking_overlap_a', 'begin');
select extensions.dblink_exec('booking_overlap_b', 'begin');
select extensions.dblink_exec(
  'booking_overlap_a',
  $$set request.jwt.claims = '{"role":"service_role"}'$$
);
select extensions.dblink_exec(
  'booking_overlap_a',
  $$set request.jwt.claim.role = 'service_role'$$
);
select extensions.dblink_exec(
  'booking_overlap_b',
  $$set request.jwt.claims = '{"role":"service_role"}'$$
);
select extensions.dblink_exec(
  'booking_overlap_b',
  $$set request.jwt.claim.role = 'service_role'$$
);
select slot_free
from extensions.dblink(
  'booking_overlap_a',
  $query$
    select public.appointment_slot_is_available(
      '92400000-0000-4000-8000-000000000001',
      (
        current_date
        + 7
        + mod(8 - extract(isodow from current_date)::integer, 7)
        + time '12:00'
      ) at time zone 'America/Argentina/Buenos_Aires',
      30, null, 'America/Argentina/Buenos_Aires'
    )
  $query$
) as availability(slot_free boolean)
\gset barrier_
select backend_pid
from extensions.dblink('booking_overlap_b', 'select pg_backend_pid()')
  as backend(backend_pid integer)
\gset inbound_
select extensions.dblink_send_query(
  'booking_overlap_b',
  'select count(*)::integer from public.begin_google_calendar_inbound_sync(0, 30)'
);
select pg_sleep(0.1);
select is(
  (
    select wait_event
    from extensions.dblink(
      'booking_overlap_setup',
      format(
        'select wait_event from pg_stat_activity where pid = %s',
        :'inbound_backend_pid'
      )
    ) as activity(wait_event text)
  ),
  'advisory',
  'inbound lease start waits on the booking Calendar barrier'
);

select appointment_id
from extensions.dblink(
  'booking_overlap_a',
  $query$
    select (public.create_service_appointment(
      '92400000-0000-4000-8000-000000000011',
      '92400000-0000-4000-8000-000000000001',
      '92400000-0000-4000-8000-000000000002',
      (
        current_date
        + 7
        + mod(8 - extract(isodow from current_date)::integer, 7)
        + time '12:00'
      ) at time zone 'America/Argentina/Buenos_Aires',
      'whatsapp',
      null
    )).id::text
  $query$
) as created(appointment_id text)
\gset barrier_create_
select ok(
  :'barrier_slot_free'::boolean
  and :'barrier_create_appointment_id' ~ '^[0-9a-f-]{36}$',
  'booking re-enters the shared barrier and enqueues without deadlock'
);

select extensions.dblink_exec('booking_overlap_a', 'commit');
select acquired_rows
from extensions.dblink_get_result('booking_overlap_b')
  as inbound_result(acquired_rows integer)
\gset inbound_result_
select count(*)
from extensions.dblink_get_result('booking_overlap_b')
  as inbound_result_drained(acquired_rows integer);
select ok(
  :'inbound_result_acquired_rows'::integer = 0,
  'inbound lease request completes only after the booking transaction commits'
);
select extensions.dblink_exec('booking_overlap_b', 'rollback');

-- Outbound completion and failure take the exclusive Calendar barrier before
-- touching a job. These two probes catch the opposite job->connection order
-- that could otherwise deadlock an appointment trigger holding the snapshot.
select extensions.dblink_exec('booking_overlap_a', 'begin');
select extensions.dblink_exec('booking_overlap_b', 'begin');
select extensions.dblink_exec(
  'booking_overlap_a',
  $$set request.jwt.claims = '{"role":"service_role"}'$$
);
select extensions.dblink_exec(
  'booking_overlap_a',
  $$set request.jwt.claim.role = 'service_role'$$
);
select extensions.dblink_exec(
  'booking_overlap_b',
  $$set request.jwt.claims = '{"role":"service_role"}'$$
);
select extensions.dblink_exec(
  'booking_overlap_b',
  $$set request.jwt.claim.role = 'service_role'$$
);
select slot_free
from extensions.dblink(
  'booking_overlap_a',
  $query$
    select public.appointment_slot_is_available(
      '92400000-0000-4000-8000-000000000001',
      (
        current_date
        + 7
        + mod(8 - extract(isodow from current_date)::integer, 7)
        + time '14:00'
      ) at time zone 'America/Argentina/Buenos_Aires',
      30, null, 'America/Argentina/Buenos_Aires'
    )
  $query$
) as availability(slot_free boolean)
\gset completion_barrier_
select backend_pid
from extensions.dblink('booking_overlap_b', 'select pg_backend_pid()')
  as backend(backend_pid integer)
\gset completion_
select extensions.dblink_send_query(
  'booking_overlap_b',
  $query$
    select public.complete_google_calendar_sync_job(
      '92400000-0000-4000-8000-000000000098', 1,
      'synthetic-missing-event', 0, '"etag"',
      clock_timestamp(), clock_timestamp() + interval '30 minutes',
      '92400000-0000-4000-8000-000000000090', 'pre_reservation'
    )
  $query$
);
select pg_sleep(0.1);
select is(
  (
    select wait_event
    from extensions.dblink(
      'booking_overlap_setup',
      format(
        'select wait_event from pg_stat_activity where pid = %s',
        :'completion_backend_pid'
      )
    ) as activity(wait_event text)
  ),
  'advisory',
  'outbound completion waits before touching a job held behind booking'
);
select appointment_id
from extensions.dblink(
  'booking_overlap_a',
  $query$
    select (public.create_service_appointment(
      '92400000-0000-4000-8000-000000000010',
      '92400000-0000-4000-8000-000000000001',
      '92400000-0000-4000-8000-000000000002',
      (
        current_date
        + 7
        + mod(8 - extract(isodow from current_date)::integer, 7)
        + time '14:00'
      ) at time zone 'America/Argentina/Buenos_Aires',
      'whatsapp', null
    )).id::text
  $query$
) as created(appointment_id text)
\gset completion_create_
select extensions.dblink_exec('booking_overlap_a', 'commit');
select completed
from extensions.dblink_get_result('booking_overlap_b')
  as completion_result(completed boolean)
\gset completion_result_
select count(*)
from extensions.dblink_get_result('booking_overlap_b')
  as completion_result_drained(completed boolean);
select ok(
  :'completion_barrier_slot_free'::boolean
  and :'completion_create_appointment_id' ~ '^[0-9a-f-]{36}$'
  and not :'completion_result_completed'::boolean,
  'booking commits without deadlock before outbound completion continues'
);
select extensions.dblink_exec('booking_overlap_b', 'rollback');

select extensions.dblink_exec('booking_overlap_a', 'begin');
select extensions.dblink_exec('booking_overlap_b', 'begin');
select extensions.dblink_exec(
  'booking_overlap_a',
  $$set request.jwt.claims = '{"role":"service_role"}'$$
);
select extensions.dblink_exec(
  'booking_overlap_a',
  $$set request.jwt.claim.role = 'service_role'$$
);
select extensions.dblink_exec(
  'booking_overlap_b',
  $$set request.jwt.claims = '{"role":"service_role"}'$$
);
select extensions.dblink_exec(
  'booking_overlap_b',
  $$set request.jwt.claim.role = 'service_role'$$
);
select slot_free
from extensions.dblink(
  'booking_overlap_a',
  $query$
    select public.appointment_slot_is_available(
      '92400000-0000-4000-8000-000000000001',
      (
        current_date
        + 7
        + mod(8 - extract(isodow from current_date)::integer, 7)
        + time '16:00'
      ) at time zone 'America/Argentina/Buenos_Aires',
      30, null, 'America/Argentina/Buenos_Aires'
    )
  $query$
) as availability(slot_free boolean)
\gset failure_barrier_
select backend_pid
from extensions.dblink('booking_overlap_b', 'select pg_backend_pid()')
  as backend(backend_pid integer)
\gset failure_
select extensions.dblink_send_query(
  'booking_overlap_b',
  $query$
    select public.fail_google_calendar_sync_job(
      '92400000-0000-4000-8000-000000000099', 1, 0,
      'SYNTHETIC_FAILURE', clock_timestamp() + interval '1 minute', false,
      '92400000-0000-4000-8000-000000000090', 'pre_reservation'
    )
  $query$
);
select pg_sleep(0.1);
select is(
  (
    select wait_event
    from extensions.dblink(
      'booking_overlap_setup',
      format(
        'select wait_event from pg_stat_activity where pid = %s',
        :'failure_backend_pid'
      )
    ) as activity(wait_event text)
  ),
  'advisory',
  'outbound failure waits before touching a job held behind booking'
);
select appointment_id
from extensions.dblink(
  'booking_overlap_a',
  $query$
    select (public.create_service_appointment(
      '92400000-0000-4000-8000-000000000011',
      '92400000-0000-4000-8000-000000000001',
      '92400000-0000-4000-8000-000000000002',
      (
        current_date
        + 7
        + mod(8 - extract(isodow from current_date)::integer, 7)
        + time '16:00'
      ) at time zone 'America/Argentina/Buenos_Aires',
      'whatsapp', null
    )).id::text
  $query$
) as created(appointment_id text)
\gset failure_create_
select extensions.dblink_exec('booking_overlap_a', 'commit');
select failed
from extensions.dblink_get_result('booking_overlap_b')
  as failure_result(failed boolean)
\gset failure_result_
select count(*)
from extensions.dblink_get_result('booking_overlap_b')
  as failure_result_drained(failed boolean);
select ok(
  :'failure_barrier_slot_free'::boolean
  and :'failure_create_appointment_id' ~ '^[0-9a-f-]{36}$'
  and not :'failure_result_failed'::boolean,
  'booking commits without deadlock before outbound failure continues'
);
select extensions.dblink_exec('booking_overlap_b', 'rollback');

-- Three-way queue safety: a trigger session must never wait for SHARED while
-- an EXCLUSIVE Calendar waiter sits behind another SHARED holder. It either
-- reuses/acquires the compatible lock or aborts the domain mutation with a
-- serialization error that is safe to retry.
select extensions.dblink_exec('booking_overlap_a', 'begin');
select extensions.dblink_exec('booking_overlap_b', 'begin');
select extensions.dblink_exec('booking_overlap_c', 'begin');
select extensions.dblink_exec(
  'booking_overlap_a',
  $lock$
    do $body$
    begin
      perform pg_advisory_xact_lock_shared(
        hashtextextended('google_calendar_connection', 0)
      );
    end;
    $body$
  $lock$
);
select extensions.dblink_exec(
  'booking_overlap_b',
  $$set local statement_timeout = '500ms'$$
);
select extensions.dblink_exec(
  'booking_overlap_b',
  $function$
    create function pg_temp.try_enqueue_calendar_barrier()
    returns text
    language plpgsql
    as $body$
    begin
      perform public.acquire_google_calendar_enqueue_barrier();
      return 'ACQUIRED';
    exception
      when serialization_failure then return 'BUSY';
      when query_canceled then return 'TIMEOUT';
    end;
    $body$
  $function$
);
select extensions.dblink_send_query(
  'booking_overlap_c',
  $$select true as acquired
    from (
      select pg_advisory_xact_lock(
        hashtextextended('google_calendar_connection', 0)
      )
    ) lock$$
);
select pg_sleep(0.1);
select outcome
from extensions.dblink(
  'booking_overlap_b',
  'select pg_temp.try_enqueue_calendar_barrier()'
) as barrier(outcome text)
\gset enqueue_barrier_
select ok(
  :'enqueue_barrier_outcome' in ('ACQUIRED', 'BUSY')
  and pg_get_functiondef(
    'public.enqueue_google_calendar_appointment()'::regprocedure
  ) like '%acquire_google_calendar_enqueue_barrier%'
  and pg_get_functiondef(
    'public.enqueue_google_calendar_contact_appointments()'::regprocedure
  ) like '%acquire_google_calendar_enqueue_barrier%',
  'enqueue triggers never wait behind an exclusive Calendar waiter'
);
select extensions.dblink_exec('booking_overlap_b', 'rollback');
select extensions.dblink_exec('booking_overlap_a', 'commit');
select count(*)
from extensions.dblink_get_result('booking_overlap_c')
  as exclusive_result(acquired boolean);
select count(*)
from extensions.dblink_get_result('booking_overlap_c')
  as exclusive_result_drained(acquired boolean);
select extensions.dblink_exec('booking_overlap_c', 'rollback');

select extensions.dblink_disconnect('booking_overlap_a');
select extensions.dblink_disconnect('booking_overlap_b');
select extensions.dblink_disconnect('booking_overlap_c');
select extensions.dblink_exec(
  'booking_overlap_setup',
  $cleanup$
    begin;
    set local session_replication_role = replica;
    delete from public.appointments
    where professional_id = '92400000-0000-4000-8000-000000000001';
    delete from public.contacts
    where id in (
      '92400000-0000-4000-8000-000000000010',
      '92400000-0000-4000-8000-000000000011'
    );
    delete from public.services
    where id = '92400000-0000-4000-8000-000000000002';
    delete from public.availability_rules
    where professional_id = '92400000-0000-4000-8000-000000000001';
    delete from public.professionals
    where id = '92400000-0000-4000-8000-000000000001';
    update public.app_settings settings
    set appointment_buffer_minutes = backup.appointment_buffer_minutes,
        minimum_booking_notice_minutes = backup.minimum_booking_notice_minutes,
        ioma_duration_minutes = backup.ioma_duration_minutes,
        private_duration_minutes = backup.private_duration_minutes,
        deposit_enabled = backup.deposit_enabled,
        booking_hold_minutes = backup.booking_hold_minutes
    from public.booking_overlap_settings_backup backup
    where settings.id = true;
    drop table public.booking_overlap_settings_backup;
    commit
  $cleanup$
);
select extensions.dblink_disconnect('booking_overlap_setup');

select * from finish();
rollback;
