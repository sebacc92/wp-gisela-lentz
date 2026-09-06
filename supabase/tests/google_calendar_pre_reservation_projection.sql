\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set local search_path = public, extensions;
select plan(59);

-- Reproduce PostgREST: session_user=authenticator y current_user=service_role.
-- La conexión dblink mantiene su propia transacción y siempre se revierte, por
-- lo que esta prueba no depende ni altera la fixture principal.
select extensions.dblink_connect(
  'calendar_authenticator_rebind',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);
select extensions.dblink_exec('calendar_authenticator_rebind', 'begin');
select extensions.dblink_exec(
  'calendar_authenticator_rebind',
  'set session authorization postgres'
);
select extensions.dblink_exec(
  'calendar_authenticator_rebind',
  $remote_setup$
    insert into auth.users (id, email, encrypted_password, aud, role)
    values (
      '92100000-0000-4000-8000-000000000091',
      'calendar-authenticator-rebind@example.test',
      '', 'authenticated', 'authenticated'
    );
    update public.profiles
    set role = 'ADMIN', active = true
    where id = '92100000-0000-4000-8000-000000000091';
    with secret as (
      select vault.create_secret(
        'opaque-authenticator-rebind-test',
        'calendar_authenticator_rebind_test',
        'pgTAP only'
      ) as id
    )
    update public.google_calendar_connections connection
    set status = 'connected',
        google_account_id = 'authenticator-rebind-account',
        google_account_email = 'authenticator-rebind@example.test',
        google_calendar_id = 'authenticator-rebind-calendar',
        google_calendar_name = 'Authenticator Rebind Calendar',
        google_calendar_timezone = 'America/Argentina/Buenos_Aires',
        refresh_token_secret_id = (select id from secret),
        connected_at = clock_timestamp(),
        connection_generation = 901,
        sync_scope_google_account_id = 'authenticator-rebind-account',
        sync_scope_google_calendar_id = 'authenticator-rebind-calendar',
        sync_scope_generation = 901,
        automation_enabled = true,
        automation_epoch = '92100000-0000-4000-8000-000000000090',
        automation_activated_at = clock_timestamp(),
        automation_google_account_id = 'authenticator-rebind-account',
        automation_google_calendar_id = 'authenticator-rebind-calendar',
        automation_connection_generation = 901
    where connection.id = true
  $remote_setup$
);
select extensions.dblink_exec(
  'calendar_authenticator_rebind',
  'set session authorization authenticator'
);
select extensions.dblink_exec(
  'calendar_authenticator_rebind',
  'set role service_role'
);
select extensions.dblink_exec(
  'calendar_authenticator_rebind',
  $remote$
    set request.jwt.claims = '{"role":"service_role"}';
    set request.jwt.claim.role = 'service_role'
  $remote$
);

select lives_ok(
  $$select extensions.dblink_exec(
    'calendar_authenticator_rebind',
    $remote$
      update public.google_calendar_connections connection
      set connection_generation = 902,
          sync_scope_generation = 902,
          automation_connection_generation = 902
      where connection.id = true
    $remote$
  )$$,
  'authenticator/service_role may only rebind a generation on the exact same scope'
);

select is(
  (select generation_pair
   from extensions.dblink(
     'calendar_authenticator_rebind',
     $remote$
       select connection_generation::text || ':' ||
              automation_connection_generation::text
       from public.google_calendar_connections
       where id = true
     $remote$
   ) as remote_state(generation_pair text)),
  '902:902',
  'the non-postgres rebind moves connection and automation generation together'
);

select extensions.dblink_exec(
  'calendar_authenticator_rebind',
  'savepoint unauthorized_retarget'
);
select throws_ok(
  $$select extensions.dblink_exec(
    'calendar_authenticator_rebind',
    $remote$
      update public.google_calendar_connections connection
      set automation_google_calendar_id = 'unauthorized-retarget'
      where connection.id = true
    $remote$
  )$$,
  '42501',
  null,
  'the same non-postgres caller cannot activate or retarget the automation binding'
);
select extensions.dblink_exec(
  'calendar_authenticator_rebind',
  'rollback to savepoint unauthorized_retarget'
);

select lives_ok(
  $$select disconnected_count
    from extensions.dblink(
      'calendar_authenticator_rebind',
      $remote$
        select count(*)::integer
        from public.disconnect_google_calendar_with_secrets(
          '92100000-0000-4000-8000-000000000091'
        )
      $remote$
    ) as disconnected(disconnected_count integer)$$,
  'authenticator/service_role can disconnect a drained exact binding via the RPC'
);

select is(
  (select disconnected_state
   from extensions.dblink(
     'calendar_authenticator_rebind',
     $remote$
       select status || ':' || automation_enabled::text || ':' ||
              coalesce(automation_epoch::text, 'null')
       from public.google_calendar_connections
       where id = true
     $remote$
   ) as remote_state(disconnected_state text)),
  'disconnected:false:null',
  'the safe clear generated by disconnect disables and invalidates the epoch'
);

select extensions.dblink_exec('calendar_authenticator_rebind', 'rollback');
select extensions.dblink_disconnect('calendar_authenticator_rebind');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '92100000-0000-4000-8000-000000000099',
  'calendar-epoch-admin@example.test', '', 'authenticated', 'authenticated'
);
update public.profiles
set role = 'ADMIN', active = true
where id = '92100000-0000-4000-8000-000000000099';

update public.app_settings
set timezone = 'America/Argentina/Buenos_Aires',
    minimum_booking_notice_minutes = 0,
    appointment_buffer_minutes = 0,
    deposit_enabled = true,
    booking_hold_minutes = 60
where id = true;

select clock_timestamp() + interval '2 days' as slot_one,
       clock_timestamp() + interval '3 days' as slot_two,
       clock_timestamp() + interval '4 days' as slot_three
\gset

insert into public.professionals (
  id, name, specialty, appointment_duration_minutes, active
) values (
  '92100000-0000-4000-8000-000000000001',
  'Profesional Calendar Epoch', 'Odontologia', 30, true
);

insert into public.contacts (
  id, phone_e164, whatsapp_id, name, coverage, is_existing_patient
) values
  (
    '92100000-0000-4000-8000-000000000010', '+5491100002110',
    '5491100002110', 'Paciente Epoch Uno', 'ioma', true
  ),
  (
    '92100000-0000-4000-8000-000000000011', '+5491100002111',
    '5491100002111', 'Paciente Epoch Dos', 'ioma', true
  ),
  (
    '92100000-0000-4000-8000-000000000012', '+5491100002112',
    '5491100002112', 'Paciente Epoch Tres', 'ioma', true
  ),
  (
    '92100000-0000-4000-8000-000000000013', '+5491100002113',
    '5491100002113', 'Paciente Epoch Cuatro', 'ioma', true
  );

-- Dos registros anteriores al cutoff y una fila de cola legacy simulan el
-- estado que la migracion encuentra. El trigger se deshabilita solamente para
-- construir esa fixture historica dentro de esta transaccion de test.
insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status, hold_expires_at, created_at
) values
  (
    '92100000-0000-4000-8000-000000000020',
    '92100000-0000-4000-8000-000000000010',
    '92100000-0000-4000-8000-000000000001',
    :'slot_one'::timestamptz,
    :'slot_one'::timestamptz + interval '30 minutes',
    'confirmed', 'manual', 'ioma', 30, 'confirmed', null,
    clock_timestamp() - interval '1 day'
  ),
  (
    '92100000-0000-4000-8000-000000000021',
    '92100000-0000-4000-8000-000000000011',
    '92100000-0000-4000-8000-000000000001',
    :'slot_one'::timestamptz + interval '1 hour',
    :'slot_one'::timestamptz + interval '90 minutes',
    'scheduled', 'manual', 'ioma', 30, 'pending',
    clock_timestamp() + interval '1 hour',
    clock_timestamp() - interval '1 day'
  );

alter table public.google_calendar_sync_jobs
  disable trigger aa_google_calendar_confirmed_only;
insert into public.google_calendar_sync_jobs (
  appointment_id, operation, desired_version, connection_generation, status,
  attempts, available_at, google_event_id
) values (
  '92100000-0000-4000-8000-000000000020', 'upsert', 7, 41, 'pending',
  2, clock_timestamp(), 'legacy-event-id'
);
alter table public.google_calendar_sync_jobs
  enable trigger aa_google_calendar_confirmed_only;

select ok(
  not (select automation_enabled
       from public.google_calendar_connections where id = true),
  'the additive migration is inert by default'
);

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '92100000-0000-4000-8000-000000000020'
      and automation_epoch is null
      and authorized_google_calendar_id is null
      and projection_stage is null
  ),
  'a legacy job has no implicit authorization association'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.activate_google_calendar_automation(bigint)',
    'EXECUTE'
  ),
  'the API service role cannot activate the scheduler projection'
);

select vault.create_secret(
  'opaque-calendar-pre-reservation-test-token',
  'calendar_pre_reservation_projection_test',
  'pgTAP only'
)::text as refresh_secret_id
\gset calendar_

update public.google_calendar_connections connection
set status = 'connected',
    google_account_id = 'account-epoch-test',
    google_account_email = 'calendar-epoch@example.test',
    google_calendar_id = 'calendar-epoch-test',
    google_calendar_name = 'Calendar Epoch Test',
    google_calendar_timezone = 'America/Argentina/Buenos_Aires',
    refresh_token_secret_id = :'calendar_refresh_secret_id'::uuid,
    connected_at = clock_timestamp(),
    connection_generation = 41,
    sync_scope_google_account_id = 'account-epoch-test',
    sync_scope_google_calendar_id = 'calendar-epoch-test',
    sync_scope_generation = 41,
    inbound_sync_token = 'window-token-41',
    inbound_sync_token_generation = 41,
    inbound_sync_state = 'incremental',
    inbound_first_import_approved_at = clock_timestamp(),
    inbound_sync_contract_version = 2,
    inbound_coverage_starts_at = (
      (((current_date - 1)::text || ' 00:00')::timestamp)
        at time zone 'America/Argentina/Buenos_Aires'
    ),
    inbound_coverage_ends_at = (
      (((current_date + 20)::text || ' 00:00')::timestamp)
        at time zone 'America/Argentina/Buenos_Aires'
    ),
    inbound_sync_timezone = 'America/Argentina/Buenos_Aires',
    last_sync_completed_at = clock_timestamp(),
    last_sync_error = null
where connection.id = true;

select public.activate_google_calendar_automation(41)::text as epoch
\gset automation_

select ok(
  :'automation_epoch'::uuid is not null
  and (
    select automation_enabled
      and automation_epoch = :'automation_epoch'::uuid
      and automation_google_account_id = google_account_id
      and automation_google_calendar_id = google_calendar_id
      and automation_connection_generation = connection_generation
    from public.google_calendar_connections where id = true
  ),
  'activation binds one epoch to the exact account calendar and generation'
);

select is(
  public.activate_google_calendar_automation(41),
  :'automation_epoch'::uuid,
  'activation is idempotent only for the same bound generation'
);

select is(
  (select count(*)::integer
   from public.google_calendar_sync_jobs
   where automation_epoch is not null),
  0,
  'activation performs no backlog association or enqueue'
);

select is(
  (select pending_count::integer from public.google_calendar_status()),
  0,
  'status ignores a pending legacy job without the current epoch'
);

update public.google_calendar_sync_jobs
set automation_epoch = :'automation_epoch'::uuid,
    authorized_google_account_id = 'account-epoch-test',
    authorized_google_calendar_id = 'calendar-epoch-test',
    authorized_connection_generation = 41,
    projection_stage = 'confirmed',
    projected_stage = 'confirmed'
where appointment_id = '92100000-0000-4000-8000-000000000020';

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '92100000-0000-4000-8000-000000000020'
      and automation_epoch is null
      and authorized_google_account_id is null
      and authorized_google_calendar_id is null
      and projection_stage is null
      and projected_stage is null
  ),
  'an UPDATE cannot adopt a pre-cutoff legacy job into the active epoch'
);

-- Simula el INSERT de backfill de finalize. La fila legacy puede conservarse
-- para rollout/rollback, pero no obtiene autorización del epoch ni es visible
-- para status/claim.
insert into public.google_calendar_sync_jobs (
  appointment_id, operation, desired_version, connection_generation, status,
  attempts, available_at
) values (
  '92100000-0000-4000-8000-000000000021', 'upsert', 1, 41, 'pending',
  0, clock_timestamp()
);

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '92100000-0000-4000-8000-000000000021'
      and automation_epoch is null
      and projection_stage is null
  ),
  'a finalize-style legacy row remains stored but cannot join the active epoch'
);

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status, hold_expires_at, created_at
) values (
  '92100000-0000-4000-8000-000000000030',
  '92100000-0000-4000-8000-000000000012',
  '92100000-0000-4000-8000-000000000001',
  :'slot_two'::timestamptz,
  :'slot_two'::timestamptz + interval '30 minutes',
  'scheduled', 'manual', 'ioma', 30, 'pending',
  clock_timestamp() + interval '1 hour', clock_timestamp()
);

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs job
    where job.appointment_id = '92100000-0000-4000-8000-000000000030'
      and job.operation = 'upsert'
      and job.projection_stage = 'pre_reservation'
      and job.automation_epoch = :'automation_epoch'::uuid
      and job.authorized_google_account_id = 'account-epoch-test'
      and job.authorized_google_calendar_id = 'calendar-epoch-test'
      and job.authorized_connection_generation = 41
  ),
  'a new live pre-reservation is associated and enqueued atomically'
);

select is(
  (select google_event_id from public.google_calendar_sync_jobs
   where appointment_id = '92100000-0000-4000-8000-000000000030'),
  'gl92100000000040008000000000000030',
  'the deterministic event ID is persisted before remote I/O'
);

select is(
  (select count(*)::integer
   from public.claim_google_calendar_sync_jobs(10, 41)),
  0,
  'the two-argument legacy claim cannot authorize remote I/O during rollout'
);

select id::text as initial_job_id
from public.google_calendar_sync_jobs
where appointment_id = '92100000-0000-4000-8000-000000000030'
\gset lifecycle_

select *
from public.claim_google_calendar_sync_jobs(1, 41, 2)
\gset first_claim_

select ok(
  :'first_claim_appointment_id'::uuid =
    '92100000-0000-4000-8000-000000000030'::uuid
  and :'first_claim_projection_stage' = 'pre_reservation'
  and :'first_claim_automation_epoch'::uuid = :'automation_epoch'::uuid
  and :'first_claim_authorized_google_calendar_id' = 'calendar-epoch-test',
  'claim returns the exact persisted epoch calendar event and stage'
);

select ok(
  (select authorized
   from public.authorize_google_calendar_sync_job(
     :'first_claim_job_id'::uuid,
     :'first_claim_desired_version'::bigint,
     :'automation_epoch'::uuid,
     'pre_reservation'
   )),
  'the claimed pre-reservation reauthorizes immediately before I/O'
);

update public.appointments
set starts_at = starts_at + interval '30 minutes',
    ends_at = ends_at + interval '30 minutes'
where id = '92100000-0000-4000-8000-000000000030';

select ok(
  (select id = :'lifecycle_initial_job_id'::uuid
          and desired_version > :'first_claim_desired_version'::bigint
          and status = 'processing'
   from public.google_calendar_sync_jobs
   where appointment_id = '92100000-0000-4000-8000-000000000030'),
  'rescheduling advances the same in-flight outbox row'
);

select ok(
  not public.complete_google_calendar_sync_job(
    :'first_claim_job_id'::uuid,
    :'first_claim_desired_version'::bigint,
    :'first_claim_google_event_id',
    41,
    'etag-pre-v1',
    :'first_claim_starts_at'::timestamptz,
    :'first_claim_ends_at'::timestamptz,
    :'automation_epoch'::uuid,
    'pre_reservation'
  ),
  'a stale completion cannot complete the newer reschedule version'
);

select ok(
  (select status = 'pending'
          and google_etag = 'etag-pre-v1'
          and projected_operation = 'upsert'
          and projected_stage = 'pre_reservation'
          and projected_starts_at = :'first_claim_starts_at'::timestamptz
   from public.google_calendar_sync_jobs
   where id = :'lifecycle_initial_job_id'::uuid),
  'stale completion preserves the real remote ETag and projection evidence'
);

select *
from public.claim_google_calendar_sync_jobs(1, 41, 2)
\gset second_claim_

update public.appointments
set status = 'confirmed', deposit_status = 'confirmed'
where id = '92100000-0000-4000-8000-000000000030';

select ok(
  (select id = :'lifecycle_initial_job_id'::uuid
          and operation = 'upsert'
          and projection_stage = 'confirmed'
          and desired_version > :'second_claim_desired_version'::bigint
   from public.google_calendar_sync_jobs
   where appointment_id = '92100000-0000-4000-8000-000000000030'),
  'confirmation advances the same event to the confirmed stage'
);

select public.complete_google_calendar_sync_job(
    :'second_claim_job_id'::uuid,
    :'second_claim_desired_version'::bigint,
    :'second_claim_google_event_id',
    41,
    'etag-pre-v2',
    :'second_claim_starts_at'::timestamptz,
    :'second_claim_ends_at'::timestamptz,
    :'automation_epoch'::uuid,
    'pre_reservation'
) as completed
\gset confirm_stale_

select ok(
  not :'confirm_stale_completed'::boolean
  and (
    select status = 'pending'
      and projection_stage = 'confirmed'
      and projected_stage = 'pre_reservation'
      and google_etag = 'etag-pre-v2'
    from public.google_calendar_sync_jobs
    where id = :'lifecycle_initial_job_id'::uuid
  ),
  'an in-flight pre-reservation completion preserves evidence while confirmed stays pending'
);

select *
from public.claim_google_calendar_sync_jobs(1, 41, 2)
\gset confirmed_claim_

select public.complete_google_calendar_sync_job(
    :'confirmed_claim_job_id'::uuid,
    :'confirmed_claim_desired_version'::bigint,
    :'confirmed_claim_google_event_id',
    41,
    'etag-confirmed',
    :'confirmed_claim_starts_at'::timestamptz,
    :'confirmed_claim_ends_at'::timestamptz,
    :'automation_epoch'::uuid,
    'confirmed'
) as completed
\gset confirmed_complete_

select ok(
  :'confirmed_complete_completed'::boolean
  and (
    select projected_stage = 'confirmed' and status = 'succeeded'
    from public.google_calendar_sync_jobs
    where id = :'lifecycle_initial_job_id'::uuid
  ),
  'the current confirmed version completes on the same outbox identity'
);

update public.appointments
set status = 'scheduled',
    deposit_status = 'pending',
    hold_expires_at = clock_timestamp() + interval '1 hour'
where id = '92100000-0000-4000-8000-000000000030';

select ok(
  (select operation = 'delete'
      and projection_stage = 'absent'
      and projected_stage = 'confirmed'
   from public.google_calendar_sync_jobs
   where id = :'lifecycle_initial_job_id'::uuid),
  'a projected confirmed event never degrades to pre_reservation'
);

update public.appointments
set status = 'confirmed',
    deposit_status = 'confirmed',
    hold_expires_at = null
where id = '92100000-0000-4000-8000-000000000030';

update public.appointments
set status = 'cancelled'
where id = '92100000-0000-4000-8000-000000000030';

select ok(
  (select id = :'lifecycle_initial_job_id'::uuid
          and operation = 'delete'
          and projection_stage = 'absent'
          and google_event_id = 'gl92100000000040008000000000000030'
   from public.google_calendar_sync_jobs
   where appointment_id = '92100000-0000-4000-8000-000000000030'),
  'cancellation targets only the persistently associated event'
);

select *
from public.claim_google_calendar_sync_jobs(1, 41, 2)
\gset delete_claim_

insert into public.google_calendar_sync_conflicts (
  appointment_id, google_event_id, kind, connection_generation
) values (
  '92100000-0000-4000-8000-000000000030',
  'gl92100000000040008000000000000030',
  'cancellation_requested', 41
);

select ok(
  not (select authorized
       from public.authorize_google_calendar_sync_job(
         :'delete_claim_job_id'::uuid,
         :'delete_claim_desired_version'::bigint,
         :'automation_epoch'::uuid,
         'absent'
       )),
  'a pending human conflict blocks delete reauthorization after claim'
);

delete from public.google_calendar_sync_conflicts conflict
where conflict.appointment_id = '92100000-0000-4000-8000-000000000030'
  and conflict.status = 'pending';

select public.complete_google_calendar_sync_job(
    :'delete_claim_job_id'::uuid,
    :'delete_claim_desired_version'::bigint,
    :'delete_claim_google_event_id',
    41,
    null,
    :'delete_claim_starts_at'::timestamptz,
    :'delete_claim_ends_at'::timestamptz,
    :'automation_epoch'::uuid,
    'absent'
) as completed
\gset delete_complete_

select ok(
  :'delete_complete_completed'::boolean
  and (
    select google_event_id = 'gl92100000000040008000000000000030'
      and projected_stage = 'absent'
      and projected_operation = 'delete'
    from public.google_calendar_sync_jobs
    where id = :'lifecycle_initial_job_id'::uuid
  ),
  'delete completion preserves the deterministic association and records absence'
);

update public.appointments
set status = 'scheduled',
    deposit_status = 'pending',
    hold_expires_at = clock_timestamp() + interval '1 hour'
where id = '92100000-0000-4000-8000-000000000030';

select ok(
  (select id = :'lifecycle_initial_job_id'::uuid
      and google_event_id = 'gl92100000000040008000000000000030'
      and operation = 'upsert'
      and projection_stage = 'pre_reservation'
   from public.google_calendar_sync_jobs
   where appointment_id = '92100000-0000-4000-8000-000000000030'),
  'a valid restoration reuses the same row and event ID'
);

update public.appointments
set hold_expires_at = clock_timestamp() - interval '1 second'
where id = '92100000-0000-4000-8000-000000000030';

select ok(
  not exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '92100000-0000-4000-8000-000000000030'
  ),
  'an expired never-recreated pre-reservation is pruned without a remote delete'
);

-- La conversión inserta primero el appointment y lo asocia al bloqueo manual
-- dentro de la misma transacción. Aunque el trigger alcance a crear un job,
-- claim/authorize deben observar la asociación final y no duplicar Google.
insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status, hold_expires_at, created_at
) values (
  '92100000-0000-4000-8000-000000000060',
  '92100000-0000-4000-8000-000000000012',
  '92100000-0000-4000-8000-000000000001',
  :'slot_two'::timestamptz + interval '2 hours',
  :'slot_two'::timestamptz + interval '150 minutes',
  'scheduled', 'manual', 'ioma', 30, 'pending',
  clock_timestamp() + interval '1 hour', clock_timestamp()
);

insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind, status,
  summary, starts_at, ends_at, all_day, recurring, unsupported_reason,
  google_etag, google_updated_at, content_hash, converted_appointment_id,
  external_cleanup_status
) values (
  'calendar-epoch-test', 'converted-manual-fixture', 41, 'block', 'converted',
  'BLOQUE CONVERTIDO FICTICIO',
  :'slot_two'::timestamptz + interval '2 hours',
  :'slot_two'::timestamptz + interval '150 minutes',
  false, false, null, 'etag-converted-fixture', clock_timestamp(),
  repeat('c', 32), '92100000-0000-4000-8000-000000000060', 'pending'
);

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '92100000-0000-4000-8000-000000000060'
      and automation_epoch = :'automation_epoch'::uuid
  )
  and not exists (
    select 1 from public.claim_google_calendar_sync_jobs(10, 41, 2) claimed
    where claimed.appointment_id = '92100000-0000-4000-8000-000000000060'
  ),
  'a converted manual block is never claimable as a second managed event'
);

select * from public.reconcile_google_calendar_sync();

select ok(
  not exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '92100000-0000-4000-8000-000000000060'
  ),
  'reconcile prunes the unattempted transient conversion job locally'
);

-- Pending vencido con comprobante recibido antes del plazo y dispatch durable.
insert into public.conversations (id, contact_id, status)
values (
  '92100000-0000-4000-8000-000000000040',
  '92100000-0000-4000-8000-000000000013', 'open'
);

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status, hold_expires_at, created_at
) values (
  '92100000-0000-4000-8000-000000000041',
  '92100000-0000-4000-8000-000000000013',
  '92100000-0000-4000-8000-000000000001',
  :'slot_three'::timestamptz,
  :'slot_three'::timestamptz + interval '30 minutes',
  'scheduled', 'whatsapp', 'ioma', 30, 'pending',
  clock_timestamp() + interval '5 minutes', clock_timestamp()
);

insert into public.automation_sessions (
  conversation_id, state, context, expires_at
) values (
  '92100000-0000-4000-8000-000000000040',
  'waiting_deposit',
  jsonb_build_object(
    'appointmentId', '92100000-0000-4000-8000-000000000041'
  ),
  clock_timestamp() + interval '5 minutes'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, metadata,
  created_at
) values (
  '92100000-0000-4000-8000-000000000042',
  '92100000-0000-4000-8000-000000000040',
  '92100000-0000-4000-8000-000000000013',
  'inbound', 'image', 'comprobante ficticio', 'delivered', '{}'::jsonb,
  clock_timestamp()
);

insert into public.whatsapp_automation_dispatches (
  message_id, external_event_id, status
) values (
  '92100000-0000-4000-8000-000000000042',
  'calendar-epoch-causal-proof', 'pending'
);

update public.appointments
set hold_expires_at = (
  select message.created_at
  from public.messages message
  where message.id = '92100000-0000-4000-8000-000000000042'
)
where id = '92100000-0000-4000-8000-000000000041';

insert into public.availability_exceptions (
  professional_id, date, type, reason
) values (
  '92100000-0000-4000-8000-000000000001',
  (:'slot_three'::timestamptz at time zone
    'America/Argentina/Buenos_Aires')::date,
  'available', 'fixture causal'
);

select ok(
  public.appointment_has_timely_deposit_proof_work(
    '92100000-0000-4000-8000-000000000041', clock_timestamp()
  )
  and exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '92100000-0000-4000-8000-000000000041'
      and projection_stage = 'pre_reservation'
  )
  and not public.appointment_slot_is_available(
    '92100000-0000-4000-8000-000000000001',
    :'slot_three'::timestamptz,
    30,
    null,
    'America/Argentina/Buenos_Aires'
  ),
  'timely causal proof work keeps both Calendar projection and availability blocked'
);

select * from public.expire_booking_holds(clock_timestamp());

select ok(
  (select status = 'scheduled' and deposit_status = 'pending'
   from public.appointments
   where id = '92100000-0000-4000-8000-000000000041'),
  'expiration preserves the exact hold while timely proof work remains actionable'
);

update public.whatsapp_automation_dispatches
set status = 'completed',
    completion_reason = 'skipped',
    completed_at = clock_timestamp()
where message_id = '92100000-0000-4000-8000-000000000042';
select * from public.expire_booking_holds(clock_timestamp());

select ok(
  (select status = 'cancelled' and deposit_status = 'expired'
   from public.appointments
   where id = '92100000-0000-4000-8000-000000000041')
  and not exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '92100000-0000-4000-8000-000000000041'
  ),
  'terminal proof work lets expiration cancel and prune an unprojected job'
);

-- Recuperación de un POST cuyo response se perdió. La huella se valida en el
-- worker sobre el payload completo; SQL sólo confía en ese booleano bajo el
-- lease, event ID y epoch exactos.
create temporary table projection_observe_lease as
select lease.lease_token
from public.google_calendar_connections connection,
lateral public.begin_google_calendar_inbound_sync(
  connection.connection_generation,
  600,
  2,
  connection.inbound_coverage_starts_at,
  connection.inbound_coverage_ends_at
) lease
where connection.id = true;

select is(
  (select count(*)::integer
   from projection_observe_lease lease,
     lateral public.claim_google_calendar_external_cleanup(
       41, lease.lease_token, 10
     )),
  0,
  'the legacy cleanup claim is fail-closed and cannot authorize deleting externals'
);

create temporary table lost_response_ranges as
select :'slot_one'::timestamptz + interval '5 hours' as reprogram_start,
       :'slot_one'::timestamptz + interval '6 hours' as cancel_start,
       :'slot_one'::timestamptz + interval '7 hours' as current_start,
       :'slot_one'::timestamptz + interval '8 hours' as human_start,
       :'slot_one'::timestamptz + interval '9 hours' as human_cancel_start;

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status, hold_expires_at, created_at
)
select appointment_id,
       '92100000-0000-4000-8000-000000000012'::uuid,
       '92100000-0000-4000-8000-000000000001'::uuid,
       starts_at, starts_at + interval '30 minutes', 'scheduled', 'manual',
       'ioma', 30, 'pending', clock_timestamp() + interval '1 hour',
       clock_timestamp()
from lost_response_ranges ranges
cross join lateral (values
  ('92100000-0000-4000-8000-000000000070'::uuid, ranges.reprogram_start),
  ('92100000-0000-4000-8000-000000000071'::uuid, ranges.cancel_start),
  ('92100000-0000-4000-8000-000000000072'::uuid, ranges.current_start),
  ('92100000-0000-4000-8000-000000000073'::uuid, ranges.human_start),
  ('92100000-0000-4000-8000-000000000074'::uuid,
    ranges.human_cancel_start)
) fixture(appointment_id, starts_at);

update public.google_calendar_sync_jobs
set attempts = 1
where appointment_id in (
  '92100000-0000-4000-8000-000000000070',
  '92100000-0000-4000-8000-000000000071',
  '92100000-0000-4000-8000-000000000072',
  '92100000-0000-4000-8000-000000000073',
  '92100000-0000-4000-8000-000000000074'
);

update public.appointments
set starts_at = starts_at + interval '30 minutes',
    ends_at = ends_at + interval '30 minutes'
where id = '92100000-0000-4000-8000-000000000070';

create temporary table lost_reprogram_observation as
select public.observe_google_calendar_managed_event(
  41,
  lease.lease_token,
  'gl92100000000040008000000000000070',
  '92100000-0000-4000-8000-000000000070',
  false,
  ranges.reprogram_start,
  ranges.reprogram_start + interval '30 minutes',
  clock_timestamp(),
  'etag-lost-reprogram-v1',
  :'automation_epoch'::uuid,
  'pre_reservation',
  true
) as outcome
from projection_observe_lease lease, lost_response_ranges ranges;

select ok(
  (select outcome = 'pending_push' from lost_reprogram_observation)
  and exists (
    select 1 from public.google_calendar_sync_jobs job,
      lost_response_ranges ranges
    where job.appointment_id = '92100000-0000-4000-8000-000000000070'
      and job.status = 'pending'
      and job.google_etag = 'etag-lost-reprogram-v1'
      and job.projected_stage = 'pre_reservation'
      and job.projected_starts_at = ranges.reprogram_start
  )
  and not exists (
    select 1 from public.google_calendar_sync_conflicts
    where appointment_id = '92100000-0000-4000-8000-000000000070'
      and status = 'pending'
  ),
  'a valid lost v1 is adopted as baseline while local reprogram v2 stays pending'
);

update public.appointments
set status = 'cancelled'
where id = '92100000-0000-4000-8000-000000000071';

create temporary table lost_cancel_observation as
select public.observe_google_calendar_managed_event(
  41,
  lease.lease_token,
  'gl92100000000040008000000000000071',
  '92100000-0000-4000-8000-000000000071',
  false,
  ranges.cancel_start,
  ranges.cancel_start + interval '30 minutes',
  clock_timestamp(),
  'etag-lost-cancel-v1',
  :'automation_epoch'::uuid,
  'pre_reservation',
  true
) as outcome
from projection_observe_lease lease, lost_response_ranges ranges;

select ok(
  (select outcome = 'pending_push' from lost_cancel_observation)
  and exists (
    select 1 from public.google_calendar_sync_jobs job,
      lost_response_ranges ranges
    where job.appointment_id = '92100000-0000-4000-8000-000000000071'
      and job.operation = 'delete'
      and job.projection_stage = 'absent'
      and job.google_etag = 'etag-lost-cancel-v1'
      and job.projected_operation = 'upsert'
      and job.projected_starts_at = ranges.cancel_start
  )
  and not exists (
    select 1 from public.google_calendar_sync_conflicts
    where appointment_id = '92100000-0000-4000-8000-000000000071'
      and status = 'pending'
  ),
  'a valid lost v1 is adopted so a later local cancellation can delete by ETag'
);

create temporary table lost_current_observation as
select public.observe_google_calendar_managed_event(
  41,
  lease.lease_token,
  'gl92100000000040008000000000000072',
  '92100000-0000-4000-8000-000000000072',
  false,
  ranges.current_start,
  ranges.current_start + interval '30 minutes',
  clock_timestamp(),
  'etag-lost-current-v1',
  :'automation_epoch'::uuid,
  'pre_reservation',
  true
) as outcome
from projection_observe_lease lease, lost_response_ranges ranges;

select ok(
  (select outcome = 'in_sync' from lost_current_observation)
  and exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '92100000-0000-4000-8000-000000000072'
      and google_etag = 'etag-lost-current-v1'
      and projected_operation = 'upsert'
      and projected_stage = 'pre_reservation'
  ),
  'a valid lost response matching the current desired stage becomes its baseline'
);

create temporary table invalid_fingerprint_observation as
select public.observe_google_calendar_managed_event(
  41,
  lease.lease_token,
  'gl92100000000040008000000000000073',
  '92100000-0000-4000-8000-000000000073',
  false,
  ranges.human_start + interval '1 hour',
  ranges.human_start + interval '90 minutes',
  clock_timestamp(),
  'etag-human-edit',
  :'automation_epoch'::uuid,
  'pre_reservation',
  false
) as outcome
from projection_observe_lease lease, lost_response_ranges ranges;

select ok(
  (select outcome = 'conflict_recorded'
   from invalid_fingerprint_observation)
  and exists (
    select 1 from public.google_calendar_sync_conflicts
    where appointment_id = '92100000-0000-4000-8000-000000000073'
      and status = 'pending'
      and kind = 'reschedule_requested'
  )
  and not exists (
    select 1 from public.claim_google_calendar_sync_jobs(10, 41, 2) claimed
    where claimed.appointment_id =
      '92100000-0000-4000-8000-000000000073'
  ),
  'an invalid fingerprint with time drift opens conflict and blocks outbound claim'
);

create temporary table missing_range_observation as
select public.observe_google_calendar_managed_event(
  41,
  lease.lease_token,
  'gl92100000000040008000000000000073',
  '92100000-0000-4000-8000-000000000073',
  false,
  null,
  null,
  clock_timestamp(),
  'etag-human-invalid-range',
  :'automation_epoch'::uuid,
  'pre_reservation',
  false
) as outcome
from projection_observe_lease lease;

select ok(
  (select outcome = 'conflict_recorded' from missing_range_observation)
  and exists (
    select 1 from public.google_calendar_sync_conflicts
    where appointment_id = '92100000-0000-4000-8000-000000000073'
      and status = 'pending'
      and kind = 'metadata_changed'
  )
  and not exists (
    select 1 from public.claim_google_calendar_sync_jobs(10, 41, 2) claimed
    where claimed.appointment_id =
      '92100000-0000-4000-8000-000000000073'
  ),
  'a managed event with an invalid range opens metadata conflict and cannot push'
);

update public.google_calendar_sync_jobs job
set google_etag = 'etag-before-human-cancel',
    projected_operation = 'upsert',
    projected_starts_at = appointment.starts_at,
    projected_ends_at = appointment.ends_at,
    projected_stage = 'pre_reservation'
from public.appointments appointment
where job.appointment_id = appointment.id
  and appointment.id = '92100000-0000-4000-8000-000000000074';

update public.appointments
set status = 'cancelled'
where id = '92100000-0000-4000-8000-000000000074';

create temporary table human_edit_before_cancel_observation as
select public.observe_google_calendar_managed_event(
  41,
  lease.lease_token,
  'gl92100000000040008000000000000074',
  '92100000-0000-4000-8000-000000000074',
  false,
  ranges.human_cancel_start + interval '1 hour',
  ranges.human_cancel_start + interval '90 minutes',
  clock_timestamp(),
  'etag-human-before-cancel',
  :'automation_epoch'::uuid,
  'pre_reservation',
  false
) as outcome
from projection_observe_lease lease, lost_response_ranges ranges;

select ok(
  (select outcome = 'conflict_recorded'
   from human_edit_before_cancel_observation)
  and exists (
    select 1 from public.google_calendar_sync_conflicts
    where appointment_id = '92100000-0000-4000-8000-000000000074'
      and status = 'pending'
      and kind = 'metadata_changed'
  )
  and exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '92100000-0000-4000-8000-000000000074'
      and operation = 'delete'
      and google_etag = 'etag-human-before-cancel'
  )
  and not exists (
    select 1 from public.claim_google_calendar_sync_jobs(10, 41, 2) claimed
    where claimed.appointment_id =
      '92100000-0000-4000-8000-000000000074'
  ),
  'a human edit observed after local cancellation opens conflict and blocks delete'
);

select public.release_google_calendar_inbound_lease(
  41, (select lease_token from projection_observe_lease)
);
update public.appointments
set status = 'cancelled'
where id in (
  '92100000-0000-4000-8000-000000000070',
  '92100000-0000-4000-8000-000000000071',
  '92100000-0000-4000-8000-000000000072',
  '92100000-0000-4000-8000-000000000073',
  '92100000-0000-4000-8000-000000000074'
)
  and status <> 'cancelled';
delete from public.google_calendar_sync_conflicts
where appointment_id in (
  '92100000-0000-4000-8000-000000000070',
  '92100000-0000-4000-8000-000000000071',
  '92100000-0000-4000-8000-000000000072',
  '92100000-0000-4000-8000-000000000073',
  '92100000-0000-4000-8000-000000000074'
);
delete from public.google_calendar_sync_jobs
where appointment_id in (
  '92100000-0000-4000-8000-000000000070',
  '92100000-0000-4000-8000-000000000071',
  '92100000-0000-4000-8000-000000000072',
  '92100000-0000-4000-8000-000000000073',
  '92100000-0000-4000-8000-000000000074'
);
-- Un error inbound debe pausar salida, pero no impedir que el scheduler corra
-- y repare su propia lectura.
update public.google_calendar_connections
set last_sync_error = 'READ_FAILED'
where id = true;

select ok(
  (select automation_enabled
   from public.get_google_calendar_automation_gate()),
  'runtime gate remains enabled so the scheduler can repair inbound state'
);

select ok(
  (select queued = 0 and already_queued = 0
   from public.reconcile_google_calendar_sync())
  and not exists (
    select 1 from public.claim_google_calendar_sync_jobs(10, 41, 2)
  ),
  'outgoing reconcile and claim remain paused until v2 observation is safe'
);

update public.google_calendar_connections
set inbound_sync_token = 'window-token-41-recovered',
    inbound_sync_token_generation = 41,
    inbound_sync_state = 'incremental',
    inbound_sync_contract_version = 2,
    inbound_coverage_starts_at = (
      (((current_date - 1)::text || ' 00:00')::timestamp)
        at time zone 'America/Argentina/Buenos_Aires'
    ),
    inbound_coverage_ends_at = (
      (((current_date + 20)::text || ' 00:00')::timestamp)
        at time zone 'America/Argentina/Buenos_Aires'
    ),
    inbound_sync_timezone = 'America/Argentina/Buenos_Aires',
    last_sync_completed_at = clock_timestamp(),
    last_sync_error = null
where id = true;

select ok(
  (select automation_enabled
   from public.get_google_calendar_automation_gate())
  and public.google_calendar_automation_scope_is_current(true),
  'a complete v2 read restores the safe outgoing gate'
);

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status, created_at
) values (
  '92100000-0000-4000-8000-000000000050',
  '92100000-0000-4000-8000-000000000013',
  '92100000-0000-4000-8000-000000000001',
  :'slot_three'::timestamptz + interval '1 hour',
  :'slot_three'::timestamptz + interval '90 minutes',
  'confirmed', 'manual', 'ioma', 30, 'confirmed', clock_timestamp()
);

select *
from public.claim_google_calendar_sync_jobs(1, 41, 2)
\gset mapped_claim_

select public.complete_google_calendar_sync_job(
    :'mapped_claim_job_id'::uuid,
    :'mapped_claim_desired_version'::bigint,
    :'mapped_claim_google_event_id',
    41,
    'etag-mapped-50',
    :'mapped_claim_starts_at'::timestamptz,
    :'mapped_claim_ends_at'::timestamptz,
    :'automation_epoch'::uuid,
    'confirmed'
) as completed
\gset mapped_complete_

select ok(
  :'mapped_complete_completed'::boolean
  and not public.google_calendar_managed_event_is_current(
    'legacy-event-id',
    '92100000-0000-4000-8000-000000000020',
    :'automation_epoch'::uuid
  )
  and public.google_calendar_managed_event_is_current(
    'gl92100000000040008000000000000050',
    '92100000-0000-4000-8000-000000000050',
    :'automation_epoch'::uuid
  ),
  'managed-event lookup requires the exact persisted local association'
);

select throws_ok(
  $$select * from public.disconnect_google_calendar_with_secrets(
    '92100000-0000-4000-8000-000000000099'
  )$$,
  '55000',
  'GOOGLE_CALENDAR_AUTOMATION_DRAIN_REQUIRED',
  'disconnect refuses to orphan an active epoch with a remote projection'
);

select ok(
  (select status = 'connected'
      and automation_enabled
      and automation_epoch = :'automation_epoch'::uuid
   from public.google_calendar_connections where id = true)
  and (select google_event_id = 'gl92100000000040008000000000000050'
          and google_etag = 'etag-mapped-50'
       from public.google_calendar_sync_jobs
       where appointment_id = '92100000-0000-4000-8000-000000000050'),
  'a rejected disconnect preserves credentials and the durable mapping'
);

update public.appointments
set starts_at = starts_at + interval '30 minutes',
    ends_at = ends_at + interval '30 minutes'
where id = '92100000-0000-4000-8000-000000000050';

select *
from public.claim_google_calendar_sync_jobs(1, 41, 2)
\gset reconnect_claim_

select public.mark_google_calendar_reconnect_required('AUTH_EXPIRED', 41);

select public.fail_google_calendar_sync_job(
    :'reconnect_claim_job_id'::uuid,
    :'reconnect_claim_desired_version'::bigint,
    41,
    'AUTH_EXPIRED',
    clock_timestamp(),
    false,
    :'automation_epoch'::uuid,
    'confirmed'
) as changed
\gset reconnect_fail_

select ok(
  :'reconnect_fail_changed'::boolean
  and (select status = 'pending'
          and automation_epoch = :'automation_epoch'::uuid
          and google_event_id = 'gl92100000000040008000000000000050'
          and google_etag = 'etag-mapped-50'
       from public.google_calendar_sync_jobs
       where appointment_id = '92100000-0000-4000-8000-000000000050'),
  'an auth failure releases a processing job without losing its mapping'
);

select ok(
  (select status = 'reconnect_required'
      and automation_enabled
      and automation_epoch = :'automation_epoch'::uuid
   from public.google_calendar_connections where id = true)
  and not (select automation_enabled
           from public.get_google_calendar_automation_gate())
  and not exists (
    select 1 from public.claim_google_calendar_sync_jobs(10, 41, 2)
  ),
  'reconnect_required preserves the epoch while pausing scheduler and claims'
);

-- Ejecuta el flujo real de finalize tras renovar OAuth sobre la misma
-- identidad. La generación cambia, pero el evento remoto sigue perteneciendo
-- al mismo account/calendar y por eso conserva asociación y ETag. Esto también
-- cubre el backfill legacy que finalize intenta luego de rotar la conexión.
do $same_scope_finalize$
declare
  oauth_attempt record;
  candidate_id uuid;
  finalized_generation bigint;
begin
  perform public.create_google_calendar_oauth_state(
    '92100000-0000-4000-8000-000000000099',
    repeat('c', 64), repeat('w', 64),
    clock_timestamp() + interval '10 minutes'
  );
  select * into oauth_attempt
  from public.consume_google_calendar_oauth_state(repeat('c', 64));
  select candidate.candidate_id into candidate_id
  from public.stage_google_calendar_connection_candidate(
    '92100000-0000-4000-8000-000000000099',
    'account-epoch-test', 'calendar-epoch@example.test',
    'opaque-calendar-pre-reservation-reauth-token',
    oauth_attempt.connection_generation,
    oauth_attempt.oauth_attempt_generation
  ) candidate;
  perform 1 from public.get_google_calendar_connection_candidate_secret(
    '92100000-0000-4000-8000-000000000099'
  );
  finalized_generation := public.finalize_google_calendar_connection_selection(
    '92100000-0000-4000-8000-000000000099',
    candidate_id,
    'calendar-epoch-test',
    'Calendar Epoch Test',
    'America/Argentina/Buenos_Aires'
  );
  if finalized_generation <> 42 then
    raise exception 'expected same-scope generation 42, got %',
      finalized_generation;
  end if;
end;
$same_scope_finalize$;

select ok(
  (select automation_enabled
      and automation_epoch = :'automation_epoch'::uuid
      and automation_connection_generation = 42
   from public.google_calendar_connections where id = true)
  and (select connection_generation = 42
          and authorized_connection_generation = 42
          and automation_epoch = :'automation_epoch'::uuid
          and google_event_id = 'gl92100000000040008000000000000050'
          and google_etag = 'etag-mapped-50'
       from public.google_calendar_sync_jobs
       where appointment_id = '92100000-0000-4000-8000-000000000050'),
  'same-scope OAuth generation rotation atomically rebinds only the current epoch'
);

select ok(
  not (select automation_enabled
       from public.get_google_calendar_automation_gate())
  and not public.google_calendar_automation_scope_is_current(true),
  'same-scope reauthorization remains paused until a new v2 import is approved'
);

update public.google_calendar_connections
set inbound_sync_token = 'window-token-42-after-reauth',
    inbound_sync_token_generation = 42,
    inbound_sync_state = 'incremental',
    inbound_first_import_approved_at = clock_timestamp(),
    inbound_sync_contract_version = 2,
    inbound_coverage_starts_at = clock_timestamp() - interval '1 hour',
    inbound_coverage_ends_at = clock_timestamp() + interval '21 days',
    inbound_sync_timezone = 'America/Argentina/Buenos_Aires',
    last_sync_completed_at = clock_timestamp(),
    last_sync_error = null
where id = true;

select ok(
  (select automation_enabled from public.get_google_calendar_automation_gate())
  and public.google_calendar_automation_scope_is_current(true),
  'a safe v2 read resumes the preserved epoch on the new generation'
);

select *
from public.claim_google_calendar_sync_jobs(1, 42, 2)
\gset reauth_claim_

select public.complete_google_calendar_sync_job(
    :'reauth_claim_job_id'::uuid,
    :'reauth_claim_desired_version'::bigint,
    :'reauth_claim_google_event_id',
    42,
    'etag-mapped-50-v2',
    :'reauth_claim_starts_at'::timestamptz,
    :'reauth_claim_ends_at'::timestamptz,
    :'automation_epoch'::uuid,
    'confirmed'
) as completed
\gset reauth_complete_

select throws_ok(
  $$update public.google_calendar_connections
    set google_calendar_id = 'calendar-retarget-test',
        google_calendar_name = 'Calendar Retarget Test',
        connection_generation = 43,
        sync_scope_google_calendar_id = 'calendar-retarget-test',
        sync_scope_generation = 43
    where id = true$$,
  '55000',
  'GOOGLE_CALENDAR_AUTOMATION_DRAIN_REQUIRED',
  'retargeting another calendar cannot orphan a projected managed event'
);

select ok(
  :'reauth_complete_completed'::boolean
  and (select connection_generation = 42
      and google_calendar_id = 'calendar-epoch-test'
      and automation_epoch = :'automation_epoch'::uuid
   from public.google_calendar_connections where id = true)
  and (select google_event_id = 'gl92100000000040008000000000000050'
          and google_etag = 'etag-mapped-50-v2'
       from public.google_calendar_sync_jobs
       where appointment_id = '92100000-0000-4000-8000-000000000050'),
  'a rejected retarget preserves its exact calendar binding and ETag'
);

update public.appointments
set status = 'cancelled'
where id = '92100000-0000-4000-8000-000000000050';

select *
from public.claim_google_calendar_sync_jobs(1, 42, 2)
\gset mapped_delete_claim_

select public.complete_google_calendar_sync_job(
    :'mapped_delete_claim_job_id'::uuid,
    :'mapped_delete_claim_desired_version'::bigint,
    :'mapped_delete_claim_google_event_id',
    42,
    null,
    :'mapped_delete_claim_starts_at'::timestamptz,
    :'mapped_delete_claim_ends_at'::timestamptz,
    :'automation_epoch'::uuid,
    'absent'
) as completed
\gset mapped_delete_complete_

update public.google_calendar_connections
set google_calendar_id = 'calendar-retarget-test',
    google_calendar_name = 'Calendar Retarget Test',
    connection_generation = 43,
    sync_scope_google_calendar_id = 'calendar-retarget-test',
    sync_scope_generation = 43
where id = true;

select ok(
  :'mapped_delete_complete_completed'::boolean
  and not (select automation_enabled
       from public.google_calendar_connections where id = true)
  and (select automation_epoch is null
       from public.google_calendar_connections where id = true),
  'a drained retarget disables and clears the old automation epoch'
);

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '92100000-0000-4000-8000-000000000050'
      and status = 'cancelled'
      and last_error = 'AUTOMATION_SCOPE_INVALIDATED'
      and automation_epoch is null
      and authorized_google_calendar_id is null
      and google_event_id is null
  ),
  'a real scope change clears every authorized job association without remote cleanup'
);

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '92100000-0000-4000-8000-000000000020'
      and automation_epoch is null
      and status = 'pending'
  )
  and (select pending_count = 0 from public.google_calendar_status()),
  'legacy rows remain untouched and excluded after scope invalidation'
);

select * from finish();
rollback;
