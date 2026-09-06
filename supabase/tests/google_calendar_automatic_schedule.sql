\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(49);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select ok(
  (
    select count(*) = 3
    from pg_catalog.pg_extension
    where extname in ('supabase_vault', 'pg_net', 'pg_cron')
  ),
  'automatic Calendar dependencies are installed'
);

select ok(
  to_regclass('private.google_calendar_automatic_config') is not null
    and to_regclass(
      'private.google_calendar_automatic_http_attempts'
    ) is not null
    and to_regclass('cron.job') is not null
    and to_regclass('net.http_request_queue') is not null,
  'private scheduler, cron and pg_net relations exist'
);

select ok(
  to_regprocedure(
    'private.google_calendar_automatic_vault_value(uuid,text)'
  ) is not null
    and to_regprocedure(
      'private.google_calendar_automatic_schedule_is_consistent()'
    ) is not null
    and to_regprocedure(
      'private.google_calendar_automatic_operational_error()'
    ) is not null
    and to_regprocedure(
      'private.capture_google_calendar_automatic_responses()'
    ) is not null
    and to_regprocedure(
      'private.dispatch_google_calendar_automatic_sync(text)'
    ) is not null
    and to_regprocedure(
      'private.invoke_google_calendar_automatic_sync()'
    ) is not null
    and to_regprocedure(
      'private.google_calendar_automatic_job_dispatch()'
    ) is not null
    and to_regprocedure(
      'private.sync_google_calendar_automatic_binding()'
    ) is not null
    and to_regprocedure(
      'private.install_google_calendar_automatic_schedule(bigint)'
    ) is not null
    and to_regprocedure(
      'private.uninstall_google_calendar_automatic_schedule()'
    ) is not null,
  'all private automatic Calendar functions exist'
);

select ok(
  (
    select not enabled
      and project_url_secret_id is null
      and cron_secret_id is null
      and cron_job_id is null
      and automation_epoch is null
      and connection_generation is null
      and last_requested_at is null
      and last_response_outcome is null
    from private.google_calendar_automatic_config
    where id
  ),
  'the migration leaves one inert disabled configuration'
);

select is(
  (
    select count(*)::integer
    from cron.job
    where jobname = 'google-calendar-automatic-sync'
  ),
  0,
  'the migration creates no automatic Calendar cron job'
);

select ok(
  (select count(*) = 0
   from private.google_calendar_automatic_http_attempts)
    and (
      select count(*) = 0
      from vault.secrets
      where name in (
        'google_calendar_automation_project_url',
        'google_calendar_automation_cron_secret'
      )
    ),
  'the migration creates neither requests nor secrets'
);

select throws_ok(
  $$select private.install_google_calendar_automatic_schedule(77)$$,
  '55000',
  'GOOGLE_CALENDAR_AUTOMATION_GENERATION_MISMATCH',
  'installation fails closed before a matching connection exists'
);

select ok(
  not private.google_calendar_automatic_schedule_is_consistent()
    and (
      select count(*) = 0 from cron.job
      where jobname = 'google-calendar-automatic-sync'
    ),
  'failed installation remains inert without cron'
);

select is(
  private.dispatch_google_calendar_automatic_sync('immediate'),
  null::bigint,
  'disabled immediate dispatch is a no-op'
);

select ok(
  (select count(*) = 0 from private.google_calendar_automatic_http_attempts)
    and (select count(*) = 0 from net.http_request_queue),
  'disabled dispatch queues no request or audit row'
);

select clock_timestamp() + interval '3 days' as future_slot
\gset automatic_

update public.app_settings
set timezone = 'America/Argentina/Buenos_Aires',
    minimum_booking_notice_minutes = 0,
    appointment_buffer_minutes = 0,
    deposit_enabled = true,
    booking_hold_minutes = 60
where id = true;

insert into public.professionals (
  id, name, specialty, appointment_duration_minutes, active
) values (
  '92200000-0000-4000-8000-000000000001',
  'Profesional Scheduler Test', 'Odontologia', 30, true
);

insert into public.contacts (
  id, phone_e164, whatsapp_id, name, coverage, is_existing_patient
) values
  (
    '92200000-0000-4000-8000-000000000010', '+5491100002210',
    '5491100002210', 'Paciente Scheduler Viejo', 'ioma', true
  ),
  (
    '92200000-0000-4000-8000-000000000011', '+5491100002211',
    '5491100002211', 'Paciente Scheduler Nuevo', 'ioma', true
  );

select vault.create_secret(
  'opaque-calendar-schedule-refresh-token',
  'calendar_automatic_schedule_refresh_fixture',
  'pgTAP only'
)::text as refresh_secret_id
\gset automatic_

update public.google_calendar_connections connection
set status = 'connected',
    google_account_id = 'account-scheduler-test',
    google_account_email = 'scheduler@example.test',
    google_calendar_id = 'calendar-scheduler-test',
    google_calendar_name = 'Calendar Scheduler Test',
    google_calendar_timezone = 'America/Argentina/Buenos_Aires',
    refresh_token_secret_id = :'automatic_refresh_secret_id'::uuid,
    connected_at = clock_timestamp(),
    connection_generation = 77,
    sync_scope_google_account_id = 'account-scheduler-test',
    sync_scope_google_calendar_id = 'calendar-scheduler-test',
    sync_scope_generation = 77,
    inbound_sync_token = 'scheduler-window-token-77',
    inbound_sync_token_generation = 77,
    inbound_sync_state = 'incremental',
    inbound_first_import_approved_at = clock_timestamp(),
    inbound_sync_contract_version = 2,
    inbound_coverage_starts_at = clock_timestamp() - interval '1 hour',
    inbound_coverage_ends_at = clock_timestamp() + interval '21 days',
    inbound_sync_timezone = 'America/Argentina/Buenos_Aires',
    last_sync_completed_at = clock_timestamp(),
    last_sync_error = null
where connection.id = true;

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status, created_at
) values (
  '92200000-0000-4000-8000-000000000020',
  '92200000-0000-4000-8000-000000000010',
  '92200000-0000-4000-8000-000000000001',
  :'automatic_future_slot'::timestamptz,
  :'automatic_future_slot'::timestamptz + interval '30 minutes',
  'confirmed', 'manual', 'ioma', 30, 'confirmed',
  clock_timestamp() - interval '1 day'
);

select ok(
  not exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '92200000-0000-4000-8000-000000000020'
  ),
  'an appointment before activation is not backfilled'
);

do $$
begin
  perform vault.create_secret(
    'https://qcthvykjlwqdrmpkxisc.supabase.co',
    'google_calendar_automation_project_url',
    'pgTAP fixture rolled back with this transaction'
  );
  perform vault.create_secret(
    repeat('c', 64),
    'google_calendar_automation_cron_secret',
    'non-production pgTAP fixture rolled back with this transaction'
  );
end;
$$;

select lives_ok(
  $$select private.install_google_calendar_automatic_schedule(77)$$,
  'explicit installation succeeds for an exact ready v2 scope'
);

select ok(
  (
    select count(*) = 1
      and count(*) filter (where active) = 1
      and bool_and(schedule = '* * * * *')
      and bool_and(command =
        'select private.invoke_google_calendar_automatic_sync();')
      and bool_and(database = current_database())
      and bool_and(username = 'postgres')
    from cron.job
    where jobname = 'google-calendar-automatic-sync'
  ),
  'installation creates exactly one active one-minute postgres cron'
);

select automation_epoch::text as epoch,
       cron_job_id::text as job_id
from private.google_calendar_automatic_config
where id
\gset automatic_

select ok(
  (
    select enabled
      and automation_epoch = :'automatic_epoch'::uuid
      and google_account_id = 'account-scheduler-test'
      and google_calendar_id = 'calendar-scheduler-test'
      and connection_generation = 77
    from private.google_calendar_automatic_config where id
  )
    and (
      select automation_enabled
        and automation_epoch = :'automatic_epoch'::uuid
        and automation_connection_generation = 77
      from public.google_calendar_connections where id
    ),
  'private config and public gate share the exact epoch and scope'
);

select ok(
  (select automation_enabled from public.google_calendar_status())
    and (select automation_activated_at is not null
         from public.google_calendar_status()),
  'public status reports automation only after cron and binding agree'
);

select ok(
  not exists (
    select 1 from public.google_calendar_sync_jobs
    where automation_epoch = :'automatic_epoch'::uuid
  )
    and (select count(*) = 0
         from private.google_calendar_automatic_http_attempts)
    and (select count(*) = 0 from net.http_request_queue),
  'installation performs no backlog DML and no HTTP request'
);

select lives_ok(
  $$select private.install_google_calendar_automatic_schedule(77)$$,
  'reinstall is idempotent for the same exact live schedule'
);

select ok(
  (select count(*) = 1 from cron.job
   where jobname = 'google-calendar-automatic-sync')
    and (
      select automation_epoch = :'automatic_epoch'::uuid
        and cron_job_id = :'automatic_job_id'::bigint
      from private.google_calendar_automatic_config where id
    ),
  'idempotent install neither duplicates cron nor rotates epoch'
);

-- Simula una request inmediatamente anterior. La reserva nueva igual debe
-- encolar su request propia. pg_net procesa solo despues de COMMIT y esta
-- transaccion siempre termina en ROLLBACK, por lo que no sale a produccion.
update private.google_calendar_automatic_config
set last_requested_at = clock_timestamp()
where id;

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status, hold_expires_at, created_at
) values (
  '92200000-0000-4000-8000-000000000021',
  '92200000-0000-4000-8000-000000000011',
  '92200000-0000-4000-8000-000000000001',
  :'automatic_future_slot'::timestamptz + interval '1 hour',
  :'automatic_future_slot'::timestamptz + interval '90 minutes',
  'scheduled', 'manual', 'ioma', 30, 'pending',
  clock_timestamp() + interval '1 hour',
  clock_timestamp() + interval '1 second'
);

select request_id::text as immediate_request_id
from private.google_calendar_automatic_http_attempts
where source = 'immediate'
order by requested_at desc
limit 1
\gset automatic_

select ok(
  :'automatic_immediate_request_id'::bigint is not null
    and exists (
      select 1 from net.http_request_queue request
      where request.id = :'automatic_immediate_request_id'::bigint
    ),
  'a new reservation queues immediate even after a recent prior request'
);

select ok(
  position(
    'pg_advisory_xact_lock' in
    pg_get_functiondef(
      'private.dispatch_google_calendar_automatic_sync(text)'::regprocedure
    )
  ) > 0
    and position(
      'pg_try_advisory' in
      pg_get_functiondef(
        'private.dispatch_google_calendar_automatic_sync(text)'::regprocedure
      )
    ) = 0,
  'concurrent immediate dispatches serialize instead of dropping a request'
);

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs job
    where job.appointment_id = '92200000-0000-4000-8000-000000000021'
      and job.status = 'pending'
      and job.projection_stage = 'pre_reservation'
      and job.automation_epoch = :'automatic_epoch'::uuid
      and job.authorized_connection_generation = 77
  ),
  'immediate dispatch is tied to a pending job in the exact epoch'
);

select ok(
  position(
    'claim_google_calendar_external_cleanup' in
    pg_get_functiondef(
      'private.dispatch_google_calendar_automatic_sync(text)'::regprocedure
    )
  ) = 0,
  'automatic dispatcher never processes external Calendar cleanup'
);

select throws_ok(
  $$select private.uninstall_google_calendar_automatic_schedule()$$,
  '55000',
  'GOOGLE_CALENDAR_AUTOMATION_MAPPINGS_PENDING',
  'uninstall refuses a pending mapping'
);

select throws_ok(
  $$update public.google_calendar_connections
      set google_calendar_id = 'retarget-not-allowed',
          connection_generation = 78,
          sync_scope_google_calendar_id = 'retarget-not-allowed',
          sync_scope_generation = 78
      where id$$,
  '55000',
  'GOOGLE_CALENDAR_AUTOMATION_DRAIN_REQUIRED',
  'retarget refuses an active or pending mapping'
);

select ok(
  private.google_calendar_automatic_schedule_is_consistent()
    and (
      select google_calendar_id = 'calendar-scheduler-test'
        and connection_generation = 77
      from public.google_calendar_connections where id
    ),
  'failed uninstall and retarget preserve cron epoch and scope'
);

update public.google_calendar_sync_jobs
set google_etag = '"etag-preserved-across-reauth"',
    projected_operation = 'upsert',
    projected_stage = 'pre_reservation',
    projected_starts_at = :'automatic_future_slot'::timestamptz +
      interval '1 hour',
    projected_ends_at = :'automatic_future_slot'::timestamptz +
      interval '90 minutes'
where appointment_id = '92200000-0000-4000-8000-000000000021';

select lives_ok(
  $$update public.google_calendar_connections
      set connection_generation = 78,
          sync_scope_generation = 78,
          inbound_sync_token = null,
          inbound_sync_token_generation = null,
          inbound_sync_state = 'awaiting_first_import',
          inbound_sync_contract_version = 0,
          inbound_coverage_starts_at = null,
          inbound_coverage_ends_at = null,
          inbound_sync_timezone = null,
          last_sync_error = null
      where id$$,
  'same account and calendar can rotate generation without losing epoch'
);

select ok(
  (
    select enabled
      and automation_epoch = :'automatic_epoch'::uuid
      and connection_generation = 78
      and cron_job_id = :'automatic_job_id'::bigint
    from private.google_calendar_automatic_config where id
  )
    and exists (
      select 1 from public.google_calendar_sync_jobs job
      where job.appointment_id = '92200000-0000-4000-8000-000000000021'
        and job.automation_epoch = :'automatic_epoch'::uuid
        and job.connection_generation = 78
        and job.authorized_connection_generation = 78
        and job.google_event_id = 'gl92200000000040008000000000000021'
        and job.google_etag = '"etag-preserved-across-reauth"'
    ),
  'same-scope reauth rebinds config and jobs but preserves cron and epoch'
);

select ok(
  private.google_calendar_automatic_schedule_is_consistent()
    and (select automation_enabled from public.google_calendar_status())
    and not public.google_calendar_automation_scope_is_current(true)
    and exists (
      select 1 from cron.job
      where jobid = :'automatic_job_id'::bigint and active
    ),
  'same-scope reauth keeps scheduler active while outgoing work stays paused until inbound v2'
);

update public.google_calendar_connections
set inbound_first_import_approved_at = clock_timestamp(),
    inbound_sync_token = 'scheduler-window-token-78',
    inbound_sync_token_generation = 78,
    inbound_sync_state = 'incremental',
    inbound_sync_contract_version = 2,
    inbound_coverage_starts_at = clock_timestamp() - interval '1 hour',
    inbound_coverage_ends_at = clock_timestamp() + interval '21 days',
    inbound_sync_timezone = 'America/Argentina/Buenos_Aires',
    last_sync_completed_at = clock_timestamp(),
    last_sync_error = null
where id;

select lives_ok(
  $$update public.google_calendar_connections
      set status = 'reconnect_required'
      where id$$,
  'reconnect-required pauses without invalidating the automatic binding'
);

select ok(
  private.google_calendar_automatic_schedule_is_consistent()
    and (select automation_enabled from public.google_calendar_status())
    and not public.google_calendar_automation_scope_is_current(false)
    and exists (
      select 1 from public.google_calendar_sync_jobs job
      where job.appointment_id = '92200000-0000-4000-8000-000000000021'
        and job.automation_epoch = :'automatic_epoch'::uuid
        and job.google_event_id = 'gl92200000000040008000000000000021'
        and job.google_etag = '"etag-preserved-across-reauth"'
    ),
  'reconnect-required keeps cron, epoch, event ID and ETag while writes stay paused'
);

update public.google_calendar_connections set status = 'connected' where id;

select cron.alter_job(
  job_id := :'automatic_job_id'::bigint,
  active := false
);

select ok(
  not (select automation_enabled from public.google_calendar_status())
    and (
      select last_sync_error =
        'CALENDAR_AUTOMATION_CONFIGURATION_MISMATCH'
      from public.google_calendar_status()
    ),
  'public status turns automation off and reports a sanitized cron mismatch'
);

select cron.alter_job(
  job_id := :'automatic_job_id'::bigint,
  active := true
);

select ok(
  (select automation_enabled from public.google_calendar_status()),
  'public status recovers when the exact cron is active again'
);

insert into net._http_response (
  id, status_code, content_type, headers, content, timed_out, error_msg,
  created
) values (
  :'automatic_immediate_request_id'::bigint,
  503, 'application/json', '{}'::jsonb, '{}', false, null,
  clock_timestamp()
);

select is(
  (select last_sync_error from public.google_calendar_status()),
  'HTTP_503',
  'latest automatic HTTP failure is visible only as a sanitized code'
);

insert into private.google_calendar_automatic_http_attempts (
  request_id, automation_epoch, source, requested_at
) values (
  -922002, :'automatic_epoch'::uuid, 'cron', clock_timestamp()
);
insert into net._http_response (
  id, status_code, content_type, headers, content, timed_out, error_msg,
  created
) values (
  -922002, 200, 'application/json', '{}'::jsonb,
  '{"processed":true,"outcome":"completed","mode":"automatic","failed":0,"retried":0}',
  false, null, clock_timestamp() + interval '1 second'
);

select is(
  (select last_sync_error from public.google_calendar_status()),
  null::text,
  'a newer successful automatic response clears the prior scheduler error'
);

insert into private.google_calendar_automatic_http_attempts (
  request_id, automation_epoch, source, requested_at
) values (
  -922003, :'automatic_epoch'::uuid, 'immediate', clock_timestamp()
);
insert into net._http_response (
  id, status_code, content_type, headers, content, timed_out, error_msg,
  created
) values (
  -922003, 200, 'application/json', '{}'::jsonb,
  '{"processed":true,"outcome":"skipped","mode":"automatic","failed":0,"retried":0,"inbound":{"skippedReason":"INBOUND_SYNC_IN_PROGRESS"}}',
  false, null, clock_timestamp() + interval '2 seconds'
);

select is(
  (select last_sync_error from public.google_calendar_status()),
  null::text,
  'an overlapping run with the inbound lease busy is an expected no-op'
);

insert into private.google_calendar_automatic_http_attempts (
  request_id, automation_epoch, source, requested_at
) values (
  -922005, :'automatic_epoch'::uuid, 'cron', clock_timestamp()
);
insert into net._http_response (
  id, status_code, content_type, headers, content, timed_out, error_msg,
  created
) values (
  -922005, 200, 'application/json', '{}'::jsonb,
  '{"processed":true,"mode":"automatic","failed":0,"retried":0}',
  false, null, clock_timestamp() + interval '3 seconds'
);

select is(
  (select last_sync_error from public.google_calendar_status()),
  'PROCESSOR_INCOMPLETE',
  'a 200 response without an explicit outcome fails closed'
);

insert into private.google_calendar_automatic_http_attempts (
  request_id, automation_epoch, source, requested_at
) values (
  -922004, :'automatic_epoch'::uuid, 'cron', clock_timestamp()
);
insert into net._http_response (
  id, status_code, content_type, headers, content, timed_out, error_msg,
  created
) values (
  -922004, 200, 'application/json', '{}'::jsonb,
  '{"processed":true,"outcome":"skipped","mode":"automatic","failed":0,"retried":0,"inbound":{"skippedReason":"FIRST_IMPORT_APPROVAL_REQUIRED"}}',
  false, null, clock_timestamp() + interval '4 seconds'
);

select is(
  (select last_sync_error from public.google_calendar_status()),
  'PROCESSOR_INCOMPLETE',
  'other skipped outcomes remain visible as incomplete work'
);

delete from public.google_calendar_sync_jobs
where appointment_id = '92200000-0000-4000-8000-000000000021';

select cron.schedule(
         'whatsapp-coexistence-recovery',
         '* * * * *',
         'select private.invoke_whatsapp_recovery(''coexistence'');'
       )::text as whatsapp_coexistence_job_id,
       cron.schedule(
         'whatsapp-automation-outbox-recovery',
         '* * * * *',
         'select private.invoke_whatsapp_recovery(''automation_outbox'');'
       )::text as whatsapp_outbox_job_id
\gset automatic_

select is(
  private.uninstall_google_calendar_automatic_schedule(),
  1,
  'safe uninstall removes the one exact cron after mappings are drained'
);

select ok(
  (
    select not enabled
      and cron_job_id is null
      and automation_epoch is null
      and last_response_error_code is null
    from private.google_calendar_automatic_config where id
  )
    and (
      select not automation_enabled and automation_epoch is null
      from public.google_calendar_connections where id
    )
    and (
      select count(*) = 0 from cron.job
      where jobname = 'google-calendar-automatic-sync'
    )
    and exists (
      select 1 from cron.job
      where jobid = :'automatic_whatsapp_coexistence_job_id'::bigint
        and jobname = 'whatsapp-coexistence-recovery'
        and command =
          'select private.invoke_whatsapp_recovery(''coexistence'');'
    )
    and exists (
      select 1 from cron.job
      where jobid = :'automatic_whatsapp_outbox_job_id'::bigint
        and jobname = 'whatsapp-automation-outbox-recovery'
        and command =
          'select private.invoke_whatsapp_recovery(''automation_outbox'');'
    ),
  'safe uninstall clears private/public gate without touching another cron'
);

select is(
  private.uninstall_google_calendar_automatic_schedule(),
  0,
  'safe uninstall is idempotent'
);

-- Restaura v2, activa sin mappings y verifica que un retarget drenado limpia
-- el cron/config en la misma transaccion.
update public.google_calendar_connections
set inbound_sync_token = 'scheduler-window-token-78',
    inbound_sync_token_generation = 78,
    inbound_sync_state = 'incremental',
    inbound_sync_contract_version = 2,
    inbound_coverage_starts_at = clock_timestamp() - interval '1 hour',
    inbound_coverage_ends_at = clock_timestamp() + interval '21 days',
    inbound_sync_timezone = 'America/Argentina/Buenos_Aires',
    last_sync_completed_at = clock_timestamp(),
    last_sync_error = null
where id;

select lives_ok(
  $$select private.install_google_calendar_automatic_schedule(78)$$,
  'a drained scope can be activated again with a fresh epoch'
);

select lives_ok(
  $$update public.google_calendar_connections
      set google_calendar_id = 'calendar-scheduler-retargeted',
          google_calendar_name = 'Calendar Retargeted',
          connection_generation = 79,
          sync_scope_google_calendar_id = 'calendar-scheduler-retargeted',
          sync_scope_generation = 79,
          inbound_sync_token = null,
          inbound_sync_token_generation = null,
          inbound_sync_state = 'awaiting_first_import',
          inbound_sync_contract_version = 0,
          inbound_coverage_starts_at = null,
          inbound_coverage_ends_at = null,
          inbound_sync_timezone = null
      where id$$,
  'a drained retarget clears automation atomically'
);

select ok(
  (
    select not enabled and automation_epoch is null and cron_job_id is null
    from private.google_calendar_automatic_config where id
  )
    and (
      select not automation_enabled and automation_epoch is null
      from public.google_calendar_connections where id
    )
    and (
      select count(*) = 0 from cron.job
      where jobname = 'google-calendar-automatic-sync'
    )
    and exists (
      select 1 from cron.job
      where jobid = :'automatic_whatsapp_coexistence_job_id'::bigint
        and jobname = 'whatsapp-coexistence-recovery'
        and command =
          'select private.invoke_whatsapp_recovery(''coexistence'');'
    )
    and exists (
      select 1 from cron.job
      where jobid = :'automatic_whatsapp_outbox_job_id'::bigint
        and jobname = 'whatsapp-automation-outbox-recovery'
        and command =
          'select private.invoke_whatsapp_recovery(''automation_outbox'');'
    ),
  'drained retarget leaves no enabled config or orphan cron'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_trigger trigger
    where trigger.tgrelid =
      'public.google_calendar_sync_jobs'::regclass
      and trigger.tgname = 'google_calendar_sync_jobs_automatic_dispatch'
      and trigger.tgenabled = 'O'
  )
    and exists (
      select 1 from pg_catalog.pg_trigger trigger
      where trigger.tgrelid =
        'public.google_calendar_connections'::regclass
        and trigger.tgname = 'zz_google_calendar_automatic_config_binding'
        and trigger.tgenabled = 'O'
    ),
  'immediate dispatch and binding coordination triggers are installed'
);

select ok(
  (
    select bool_and(not has_schema_privilege(role_name, 'private', 'USAGE'))
    from unnest(array['anon', 'authenticated', 'service_role'])
      as api_roles(role_name)
  )
    and (
      select bool_and(
        not has_table_privilege(
          role_name,
          format('private.%I', table_name),
          'SELECT, INSERT, UPDATE, DELETE'
        )
      )
      from unnest(array['anon', 'authenticated', 'service_role'])
        as api_roles(role_name)
      cross join unnest(array[
        'google_calendar_automatic_config',
        'google_calendar_automatic_http_attempts'
      ]) as private_tables(table_name)
    ),
  'API roles cannot inspect private scheduler configuration or attempts'
);

select ok(
  (
    select count(*) = 33
      and bool_and(
        not has_function_privilege(role_name, procedure_oid, 'EXECUTE')
      )
    from unnest(array['anon', 'authenticated', 'service_role'])
      as api_roles(role_name)
    cross join lateral (
      select procedure_oid
      from unnest(array[
        'private.google_calendar_automatic_vault_value(uuid,text)'::regprocedure,
        'private.google_calendar_automatic_schedule_is_consistent()'::regprocedure,
        'private.google_calendar_automatic_operational_error()'::regprocedure,
        'private.capture_google_calendar_automatic_responses()'::regprocedure,
        'private.dispatch_google_calendar_automatic_sync(text)'::regprocedure,
        'private.invoke_google_calendar_automatic_sync()'::regprocedure,
        'private.google_calendar_automatic_job_dispatch()'::regprocedure,
        'private.sync_google_calendar_automatic_binding()'::regprocedure,
        'private.install_google_calendar_automatic_schedule(bigint)'::regprocedure,
        'private.uninstall_google_calendar_automatic_schedule()'::regprocedure,
        'private.google_calendar_automatic_schedule_status()'::regprocedure
      ]) as protected_functions(procedure_oid)
    ) functions_by_role
  ),
  'API roles cannot invoke any private scheduler function'
);

select ok(
  (
    select count(*) = 11
      and bool_and(procedure.prosecdef)
      and bool_and(owner.rolname = 'postgres')
      and bool_and(
        coalesce(procedure.proconfig, '{}'::text[])
          @> array['search_path=pg_catalog']
      )
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = procedure.proowner
    where namespace.nspname = 'private'
      and procedure.proname in (
        'google_calendar_automatic_vault_value',
        'google_calendar_automatic_schedule_is_consistent',
        'google_calendar_automatic_operational_error',
        'capture_google_calendar_automatic_responses',
        'dispatch_google_calendar_automatic_sync',
        'invoke_google_calendar_automatic_sync',
        'google_calendar_automatic_job_dispatch',
        'sync_google_calendar_automatic_binding',
        'install_google_calendar_automatic_schedule',
        'uninstall_google_calendar_automatic_schedule',
        'google_calendar_automatic_schedule_status'
      )
  ),
  'private scheduler functions are postgres-owned security definers with fixed search path'
);

select ok(
  (
    select count(*) = 2 and bool_and(relation.relrowsecurity)
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'private'
      and relation.relname in (
        'google_calendar_automatic_config',
        'google_calendar_automatic_http_attempts'
      )
  ),
  'RLS is enabled on both private scheduler tables'
);

select ok(
  not exists (
    select 1
    from cron.job job
    where job.command ~* '(secret|token|https?://|authorization)'
  )
    and not exists (
      select 1
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname in ('public', 'graphql_public')
        and relation.relname like 'google_calendar_automatic%'
    ),
  'cron commands and public schemas expose no secret material'
);

select * from finish();
rollback;
