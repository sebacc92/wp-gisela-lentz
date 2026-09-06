\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(8);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select ok(
  to_regprocedure(
    'public.expire_google_calendar_automation_booking_holds(uuid,bigint,text,timestamptz)'
  ) is not null,
  'the Calendar-scoped hold expiration function exists'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.expire_google_calendar_automation_booking_holds(uuid,bigint,text,timestamptz)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'public.expire_google_calendar_automation_booking_holds(uuid,bigint,text,timestamptz)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.expire_google_calendar_automation_booking_holds(uuid,bigint,text,timestamptz)',
      'EXECUTE'
    ),
  'only service_role may invoke Calendar-scoped expiration'
);

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
  '92300000-0000-4000-8000-000000000001',
  'Profesional Expiration Test', 'Odontologia', 30, true
);

insert into public.contacts (
  id, phone_e164, whatsapp_id, name, coverage, is_existing_patient
) values
  (
    '92300000-0000-4000-8000-000000000010', '+5491100002310',
    '5491100002310', 'Paciente Previo al Corte', 'ioma', true
  ),
  (
    '92300000-0000-4000-8000-000000000011', '+5491100002311',
    '5491100002311', 'Paciente del Epoch', 'ioma', true
  );

select vault.create_secret(
  'opaque-calendar-expiration-refresh-token',
  'calendar_epoch_expiration_refresh_fixture',
  'pgTAP only'
)::text as refresh_secret_id
\gset expiration_

update public.google_calendar_connections connection
set status = 'connected',
    google_account_id = 'account-expiration-test',
    google_account_email = 'expiration@example.test',
    google_calendar_id = 'calendar-expiration-test',
    google_calendar_name = 'Calendar Expiration Test',
    google_calendar_timezone = 'America/Argentina/Buenos_Aires',
    refresh_token_secret_id = :'expiration_refresh_secret_id'::uuid,
    connected_at = clock_timestamp(),
    connection_generation = 78,
    sync_scope_google_account_id = 'account-expiration-test',
    sync_scope_google_calendar_id = 'calendar-expiration-test',
    sync_scope_generation = 78,
    inbound_sync_token = 'expiration-window-token-78',
    inbound_sync_token_generation = 78,
    inbound_sync_state = 'incremental',
    inbound_first_import_approved_at = clock_timestamp(),
    inbound_sync_contract_version = 2,
    inbound_coverage_starts_at = clock_timestamp() - interval '1 hour',
    inbound_coverage_ends_at = clock_timestamp() + interval '21 days',
    inbound_sync_timezone = 'America/Argentina/Buenos_Aires',
    last_sync_completed_at = clock_timestamp(),
    last_sync_error = null
where connection.id = true;

do $$
begin
  perform vault.create_secret(
    'https://qcthvykjlwqdrmpkxisc.supabase.co',
    'google_calendar_automation_project_url',
    'pgTAP fixture rolled back with this transaction'
  );
  perform vault.create_secret(
    repeat('e', 64),
    'google_calendar_automation_cron_secret',
    'non-production pgTAP fixture rolled back with this transaction'
  );
end;
$$;

select lives_ok(
  $$select private.install_google_calendar_automatic_schedule(78)$$,
  'the exact scheduler scope can be activated for the fixture'
);

select automation_epoch::text as epoch
from private.google_calendar_automatic_config
where id
\gset expiration_

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status, hold_expires_at,
  hold_expired_notification_status, created_at
) values
  (
    '92300000-0000-4000-8000-000000000020',
    '92300000-0000-4000-8000-000000000010',
    '92300000-0000-4000-8000-000000000001',
    clock_timestamp() + interval '3 days',
    clock_timestamp() + interval '3 days 30 minutes',
    'scheduled', 'manual', 'ioma', 30, 'pending',
    clock_timestamp() - interval '10 minutes', 'pending',
    (select automation_activated_at - interval '1 second'
     from public.google_calendar_connections where id)
  ),
  (
    '92300000-0000-4000-8000-000000000021',
    '92300000-0000-4000-8000-000000000011',
    '92300000-0000-4000-8000-000000000001',
    clock_timestamp() + interval '4 days',
    clock_timestamp() + interval '4 days 30 minutes',
    'scheduled', 'manual', 'ioma', 30, 'pending',
    clock_timestamp() + interval '10 minutes', 'pending',
    clock_timestamp()
  );

select ok(
  not exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '92300000-0000-4000-8000-000000000020'
  )
    and exists (
      select 1 from public.google_calendar_sync_jobs
      where appointment_id = '92300000-0000-4000-8000-000000000021'
        and automation_epoch = :'expiration_epoch'::uuid
        and projection_stage = 'pre_reservation'
    ),
  'only the appointment created in the current epoch receives a Calendar job'
);

update public.google_calendar_sync_jobs job
set status = 'succeeded',
    attempts = 1,
    google_etag = '"epoch-expiration-etag"',
    projected_operation = 'upsert',
    projected_starts_at = appointment.starts_at,
    projected_ends_at = appointment.ends_at,
    projected_stage = 'pre_reservation'
from public.appointments appointment
where job.appointment_id = appointment.id
  and appointment.id = '92300000-0000-4000-8000-000000000021';

select throws_ok(
  $$select public.expire_google_calendar_automation_booking_holds(
      '92300000-0000-4000-8000-000000000099'::uuid,
      78,
      'calendar-expiration-test',
      clock_timestamp() + interval '20 minutes'
    )$$,
  '55000',
  'GOOGLE_CALENDAR_AUTOMATION_EXPIRATION_SCOPE_CHANGED',
  'a different epoch fails closed'
);

select ok(
  (select count(*) = 2
   from public.appointments
   where id in (
     '92300000-0000-4000-8000-000000000020',
     '92300000-0000-4000-8000-000000000021'
   ) and status = 'scheduled' and deposit_status = 'pending'),
  'a rejected scope mutates neither hold'
);

select is(
  (
    select count(*)::integer
    from public.expire_google_calendar_automation_booking_holds(
      :'expiration_epoch'::uuid,
      78,
      'calendar-expiration-test',
      clock_timestamp() + interval '20 minutes'
    )
  ),
  1,
  'Calendar expiration returns only the eligible current-epoch hold'
);

select ok(
  exists (
    select 1 from public.appointments
    where id = '92300000-0000-4000-8000-000000000020'
      and status = 'scheduled'
      and deposit_status = 'pending'
  )
    and exists (
      select 1 from public.appointments
      where id = '92300000-0000-4000-8000-000000000021'
        and status = 'cancelled'
        and deposit_status = 'expired'
    )
    and exists (
      select 1 from public.google_calendar_sync_jobs
      where appointment_id = '92300000-0000-4000-8000-000000000021'
        and automation_epoch = :'expiration_epoch'::uuid
        and google_event_id = 'gl92300000000040008000000000000021'
        and operation = 'delete'
        and projection_stage = 'absent'
        and projected_stage = 'pre_reservation'
    ),
  'expiration preserves the old hold and moves the same epoch mapping to delete'
);

select * from finish();

rollback;
