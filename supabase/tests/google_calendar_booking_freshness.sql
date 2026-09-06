\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(41);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select (
  current_date + 7 + mod(8 - extract(isodow from current_date)::integer, 7)
)::date as test_date
\gset

update public.app_settings
set automations_enabled = true,
    timezone = 'America/Argentina/Buenos_Aires',
    minimum_booking_notice_minutes = 0,
    appointment_buffer_minutes = 15,
    deposit_enabled = true,
    deposit_amount_ars = 12345,
    deposit_alias = 'calendar.test.alias',
    deposit_holder = 'Calendar Test Holder',
    booking_hold_minutes = 60,
    ioma_duration_minutes = 30,
    private_duration_minutes = 60
where id = true;

insert into public.professionals (
  id, name, specialty, appointment_duration_minutes, active
) values (
  '92300000-0000-4000-8000-000000000001',
  'Booking Freshness Professional', 'Test', 30, true
);
insert into public.services (id, name, duration_minutes, active, sort_order)
values (
  '92300000-0000-4000-8000-000000000002',
  'Booking Freshness Service', 30, true, 9230
);
insert into public.availability_rules (
  professional_id, weekday, start_time, end_time, slot_minutes, active
) values (
  '92300000-0000-4000-8000-000000000001',
  1, '08:00', '18:00', 15, true
);
insert into public.contacts (id, phone_e164, name, coverage)
values
  ('92300000-0000-4000-8000-000000000010', '+12025550110', 'Fresh A', 'ioma'),
  ('92300000-0000-4000-8000-000000000011', '+12025550111', 'Fresh B', 'ioma'),
  ('92300000-0000-4000-8000-000000000012', '+12025550112', 'Fresh C', 'ioma'),
  ('92300000-0000-4000-8000-000000000013', '+12025550113', 'Fresh D', 'ioma'),
  ('92300000-0000-4000-8000-000000000014', '+12025550114', 'Fresh E', 'ioma'),
  ('92300000-0000-4000-8000-000000000015', '+12025550115', 'Fresh F', 'ioma'),
  ('92300000-0000-4000-8000-000000000016', '+12025550116', 'Fresh G', 'ioma'),
  ('92300000-0000-4000-8000-000000000017', '+12025550117', 'Fresh H', 'ioma'),
  ('92300000-0000-4000-8000-000000000018', '+12025550118', 'Fresh I', 'ioma');

insert into public.conversations (id, contact_id, automation_mode)
values
  ('92300000-0000-4000-8000-000000000020', '92300000-0000-4000-8000-000000000010', 'auto'),
  ('92300000-0000-4000-8000-000000000021', '92300000-0000-4000-8000-000000000011', 'auto'),
  ('92300000-0000-4000-8000-000000000022', '92300000-0000-4000-8000-000000000012', 'auto'),
  ('92300000-0000-4000-8000-000000000023', '92300000-0000-4000-8000-000000000014', 'auto'),
  ('92300000-0000-4000-8000-000000000024', '92300000-0000-4000-8000-000000000015', 'auto'),
  ('92300000-0000-4000-8000-000000000025', '92300000-0000-4000-8000-000000000016', 'auto'),
  ('92300000-0000-4000-8000-000000000026', '92300000-0000-4000-8000-000000000018', 'auto');
insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, created_at
) values
  ('92300000-0000-4000-8000-000000000030', '92300000-0000-4000-8000-000000000020', '92300000-0000-4000-8000-000000000010', 'inbound', 'text', 'confirm stale', 'read', clock_timestamp()),
  ('92300000-0000-4000-8000-000000000031', '92300000-0000-4000-8000-000000000021', '92300000-0000-4000-8000-000000000011', 'inbound', 'text', 'confirm fresh', 'read', clock_timestamp() + interval '1 second'),
  ('92300000-0000-4000-8000-000000000032', '92300000-0000-4000-8000-000000000021', '92300000-0000-4000-8000-000000000011', 'inbound', 'text', 'reschedule conflict', 'read', clock_timestamp() + interval '2 seconds');

with secret as (
  select vault.create_secret(
    'opaque-booking-freshness-token',
    'calendar_booking_freshness_fixture',
    'pgTAP only'
  ) as id
)
update public.google_calendar_connections connection
set status = 'connected',
    google_account_id = 'booking-fresh-account',
    google_account_email = 'booking-fresh@example.test',
    google_calendar_id = 'booking-fresh-calendar',
    google_calendar_name = 'Booking Fresh Calendar',
    google_calendar_timezone = 'America/Argentina/Buenos_Aires',
    refresh_token_secret_id = (select id from secret),
    connected_at = clock_timestamp(),
    connection_generation = 923,
    sync_scope_google_account_id = 'booking-fresh-account',
    sync_scope_google_calendar_id = 'booking-fresh-calendar',
    sync_scope_generation = 923,
    inbound_first_import_approved_at = clock_timestamp(),
    inbound_sync_state = 'incremental',
    inbound_sync_token = 'booking-fresh-token',
    inbound_sync_token_generation = 923,
    inbound_sync_contract_version = 2,
    inbound_sync_timezone = 'America/Argentina/Buenos_Aires',
    inbound_coverage_starts_at = (current_date - 1)::timestamp
      at time zone 'America/Argentina/Buenos_Aires',
    inbound_coverage_ends_at = (current_date + 20)::timestamp
      at time zone 'America/Argentina/Buenos_Aires',
    last_sync_completed_at = clock_timestamp() - interval '4 minutes',
    last_sync_error = null,
    inbound_lease_token = null,
    inbound_lease_expires_at = null,
    automation_enabled = true,
    automation_epoch = '92300000-0000-4000-8000-000000000090',
    automation_activated_at = clock_timestamp() - interval '1 minute',
    automation_google_account_id = 'booking-fresh-account',
    automation_google_calendar_id = 'booking-fresh-calendar',
    automation_connection_generation = 923
where connection.id = true;

select ok(
  not public.appointment_slot_is_available(
    '92300000-0000-4000-8000-000000000001',
    (:'test_date'::date + time '09:00') at time zone 'America/Argentina/Buenos_Aires',
    30, null, 'America/Argentina/Buenos_Aires'
  ),
  'an old successful Calendar snapshot fails closed'
);

select * from public.claim_whatsapp_automation_execution(
  '92300000-0000-4000-8000-000000000030',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
) \gset stale_
update public.google_calendar_connections connection
set last_sync_completed_at = execution.processing_started_at
      - interval '1 millisecond'
from public.whatsapp_automation_executions execution
where connection.id = true
  and execution.message_id = '92300000-0000-4000-8000-000000000030';

select is(
  public.create_whatsapp_automation_appointment(
    '92300000-0000-4000-8000-000000000030',
    :'stale_lease_token'::uuid,
    '92300000-0000-4000-8000-000000000010',
    '92300000-0000-4000-8000-000000000001',
    '92300000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '09:00') at time zone 'America/Argentina/Buenos_Aires'
  ) ->> 'error_code',
  'CALENDAR_AVAILABILITY_UNAVAILABLE',
  'the exact bot persistence wrapper rejects a pre-execution observation'
);
select is(
  (select count(*) from public.appointments appointment
   where appointment.contact_id = '92300000-0000-4000-8000-000000000010'),
  0::bigint,
  'a rejected stale wrapper creates no appointment'
);

-- This expired hold is unrelated to the requested destination and must remain
-- byte-for-byte outside the booking mutation.
insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at, status,
  source, coverage, duration_minutes, deposit_status, hold_expires_at,
  hold_expired_notification_status
) values (
  '92300000-0000-4000-8000-000000000040',
  '92300000-0000-4000-8000-000000000013',
  '92300000-0000-4000-8000-000000000001',
  '92300000-0000-4000-8000-000000000002',
  (:'test_date'::date + time '16:00') at time zone 'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '16:30') at time zone 'America/Argentina/Buenos_Aires',
  'scheduled', 'whatsapp', 'ioma', 30, 'pending',
  clock_timestamp() - interval '1 hour', 'pending'
);

select * from public.claim_whatsapp_automation_execution(
  '92300000-0000-4000-8000-000000000031',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
) \gset fresh_
update public.google_calendar_connections
set last_sync_completed_at = clock_timestamp()
where id = true;

select public.create_whatsapp_automation_appointment(
  '92300000-0000-4000-8000-000000000031',
  :'fresh_lease_token'::uuid,
  '92300000-0000-4000-8000-000000000011',
  '92300000-0000-4000-8000-000000000001',
  '92300000-0000-4000-8000-000000000002',
  (:'test_date'::date + time '10:00') at time zone 'America/Argentina/Buenos_Aires'
) ->> 'id' as appointment_id
\gset

select ok(
  :'appointment_id' ~ '^[0-9a-f-]{36}$',
  'a post-execution complete observation allows the bot wrapper to book'
);
select ok(
  (select status = 'scheduled' and deposit_status = 'pending'
   from public.appointments where id = :'appointment_id'::uuid),
  'the bot booking is immediately an active pending-deposit hold'
);
select ok(
  (select status = 'scheduled'
      and deposit_status = 'pending'
      and hold_expired_notification_status = 'pending'
   from public.appointments
   where id = '92300000-0000-4000-8000-000000000040'),
  'booking leaves an unrelated expired real hold untouched'
);
select ok(
  not public.appointment_slot_is_available(
    '92300000-0000-4000-8000-000000000001',
    (:'test_date'::date + time '10:20') at time zone 'America/Argentina/Buenos_Aires',
    30, null, 'America/Argentina/Buenos_Aires'
  ),
  'a pending hold blocks a partial overlap across its configured duration'
);
select public.complete_whatsapp_automation_execution(
  '92300000-0000-4000-8000-000000000031',
  :'fresh_lease_token'::uuid,
  '{"processed":true}'::jsonb
);

insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at, status,
  source, coverage, duration_minutes, deposit_status, hold_expires_at,
  hold_expired_notification_status
) values (
  '92300000-0000-4000-8000-000000000048',
  '92300000-0000-4000-8000-000000000018',
  '92300000-0000-4000-8000-000000000001',
  '92300000-0000-4000-8000-000000000002',
  (:'test_date'::date + time '13:00') at time zone 'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '13:30') at time zone 'America/Argentina/Buenos_Aires',
  'scheduled', 'whatsapp', 'ioma', 30, 'pending',
  clock_timestamp() + interval '1 hour', 'pending'
);
set local session_replication_role = replica;
update public.google_calendar_sync_jobs
set status = 'pending',
    attempts = 1,
    processing_started_at = null,
    last_error = 'SYNTHETIC_RESPONSE_LOST',
    projected_operation = null,
    projected_starts_at = null,
    projected_ends_at = null,
    projected_stage = null
where appointment_id = '92300000-0000-4000-8000-000000000048';
set local session_replication_role = origin;
select public.update_appointment_status(
  '92300000-0000-4000-8000-000000000048',
  'cancelled'::public.appointment_status
);
select ok(
  (select operation = 'delete' and status = 'pending' and attempts = 1
  from public.google_calendar_sync_jobs
   where appointment_id = '92300000-0000-4000-8000-000000000048')
  and public.google_calendar_has_uncertain_outbound_mutation()
  and not public.appointment_slot_is_available(
    '92300000-0000-4000-8000-000000000001',
    (:'test_date'::date + time '15:00') at time zone 'America/Argentina/Buenos_Aires',
    30, null, 'America/Argentina/Buenos_Aires'
  )
  and not public.appointment_slot_is_free_for(:'appointment_id'::uuid),
  'a response-lost mutation stays fail-closed after cancellation coalesces it'
);
set local session_replication_role = replica;
delete from public.google_calendar_sync_jobs
where appointment_id = '92300000-0000-4000-8000-000000000048';
delete from public.appointments
where id = '92300000-0000-4000-8000-000000000048';
set local session_replication_role = origin;

update public.google_calendar_connections
set inbound_lease_token = '92300000-0000-4000-8000-000000000099',
    inbound_lease_expires_at = clock_timestamp() + interval '2 minutes',
    inbound_lease_sync_contract_version = 2,
    inbound_lease_coverage_starts_at = inbound_coverage_starts_at,
    inbound_lease_coverage_ends_at = inbound_coverage_ends_at,
    inbound_lease_timezone = google_calendar_timezone
where id = true;
select ok(
  not public.appointment_slot_is_available(
    '92300000-0000-4000-8000-000000000001',
    (:'test_date'::date + time '12:00') at time zone 'America/Argentina/Buenos_Aires',
    30, null, 'America/Argentina/Buenos_Aires'
  ),
  'an active inbound lease fails closed instead of exposing a partial import'
);
select ok(
  public.fail_google_calendar_inbound_sync(
    923,
    '92300000-0000-4000-8000-000000000099',
    'SYNTHETIC_OWNER_FAILED',
    '{"failed":true}'::jsonb
  ),
  'the inbound owner failure is recorded before releasing its lease'
);
select ok(
  public.record_google_calendar_sync_attempt(
    923,
    '{"skipped":true}'::jsonb,
    0,
    null
  )
  and (select last_sync_error = 'SYNTHETIC_OWNER_FAILED'
       from public.google_calendar_connections where id = true)
  and not public.appointment_slot_is_available(
    '92300000-0000-4000-8000-000000000001',
    (:'test_date'::date + time '12:00') at time zone 'America/Argentina/Buenos_Aires',
    30, null, 'America/Argentina/Buenos_Aires'
  ),
  'a skipped worker cannot erase the owner failure or reopen availability'
);
update public.google_calendar_connections
set inbound_lease_token = null,
    inbound_lease_expires_at = null,
    inbound_lease_sync_contract_version = null,
    inbound_lease_coverage_starts_at = null,
    inbound_lease_coverage_ends_at = null,
    inbound_lease_timezone = null,
    inbound_sync_state = 'incremental',
    inbound_sync_token = 'booking-fresh-token-restored',
    inbound_sync_token_generation = connection_generation,
    inbound_sync_contract_version = 2,
    inbound_sync_timezone = google_calendar_timezone,
    inbound_coverage_starts_at = (current_date - 1)::timestamp
      at time zone 'America/Argentina/Buenos_Aires',
    inbound_coverage_ends_at = (current_date + 20)::timestamp
      at time zone 'America/Argentina/Buenos_Aires',
    last_sync_completed_at = clock_timestamp(),
    last_sync_error = null
where id = true;

select * from public.claim_whatsapp_automation_execution(
  '92300000-0000-4000-8000-000000000032',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
) \gset move_
update public.google_calendar_connections
set last_sync_completed_at = clock_timestamp()
where id = true;
insert into public.google_calendar_sync_conflicts (
  appointment_id, google_event_id, kind, status, proposed_starts_at,
  proposed_ends_at, observed_starts_at, observed_ends_at,
  connection_generation
) select :'appointment_id'::uuid, 'managed-conflict', 'reschedule_requested',
         'pending',
         (:'test_date'::date + time '12:00') at time zone 'America/Argentina/Buenos_Aires',
         (:'test_date'::date + time '12:30') at time zone 'America/Argentina/Buenos_Aires',
         appointment.starts_at, appointment.ends_at, 923
from public.appointments appointment where appointment.id = :'appointment_id'::uuid;

select ok(
  not public.appointment_slot_is_available(
    '92300000-0000-4000-8000-000000000001',
    (:'test_date'::date + time '12:35') at time zone 'America/Argentina/Buenos_Aires',
    30, null, 'America/Argentina/Buenos_Aires'
  ),
  'a managed event moved in Google blocks its proposed remote interval'
);

insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at, status,
  source, coverage, duration_minutes, deposit_status, hold_expires_at,
  hold_expired_notification_status
) values (
  '92300000-0000-4000-8000-000000000045',
  '92300000-0000-4000-8000-000000000018',
  '92300000-0000-4000-8000-000000000001',
  '92300000-0000-4000-8000-000000000002',
  (:'test_date'::date + time '11:35') at time zone 'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '12:05') at time zone 'America/Argentina/Buenos_Aires',
  'scheduled', 'whatsapp', 'ioma', 30, 'pending',
  clock_timestamp() + interval '1 hour', 'pending'
);
select ok(
  not public.appointment_slot_is_free_for(
    '92300000-0000-4000-8000-000000000045'
  ),
  'confirmation also blocks another managed event proposed inside the buffer'
);

select is(
  public.reschedule_whatsapp_automation_appointment(
    '92300000-0000-4000-8000-000000000032',
    :'move_lease_token'::uuid,
    :'appointment_id'::uuid,
    (:'test_date'::date + time '12:00') at time zone 'America/Argentina/Buenos_Aires'
  ) ->> 'error_code',
  'CALENDAR_AVAILABILITY_UNAVAILABLE',
  'the bot cannot move an appointment while its managed event is in review'
);
select ok(
  (select starts_at =
      (:'test_date'::date + time '10:00') at time zone 'America/Argentina/Buenos_Aires'
   from public.appointments where id = :'appointment_id'::uuid),
  'a rejected reschedule preserves the original occupied interval'
);

delete from public.google_calendar_sync_conflicts
where appointment_id = :'appointment_id'::uuid;
insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind, status,
  summary, starts_at, ends_at, content_hash
) select 'booking-fresh-calendar', 'confirmation-block', 923, 'block',
         'active', 'Synthetic occupied interval', appointment.starts_at,
         appointment.ends_at, md5('confirmation-block')
from public.appointments appointment where appointment.id = :'appointment_id'::uuid;

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '92300000-0000-4000-8000-000000000080',
  'booking-fresh-admin@example.test', '', 'authenticated', 'authenticated'
);
update public.profiles set role = 'ADMIN', active = true
where id = '92300000-0000-4000-8000-000000000080';
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"92300000-0000-4000-8000-000000000080"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  '92300000-0000-4000-8000-000000000080',
  true
);

select throws_ok(
  format(
    'select * from public.admin_confirm_appointment_deposit(%L::uuid)',
    :'appointment_id'
  ),
  'P0001',
  'SLOT_NO_LONGER_AVAILABLE',
  'a live hold cannot be confirmed over a newly observed external block'
);
select ok(
  (select status = 'scheduled' and deposit_status = 'pending'
   from public.appointments where id = :'appointment_id'::uuid),
  'failed confirmation preserves the pending hold for human review'
);

update public.google_calendar_external_events
set status = 'removed', removed_at = clock_timestamp()
where google_event_id = 'confirmation-block';
update public.google_calendar_connections
set last_sync_completed_at = clock_timestamp()
where id = true;
select ok(
  (select not confirmation.already_confirmed
   from public.admin_confirm_appointment_deposit(:'appointment_id'::uuid)
     confirmation),
  'confirmation succeeds once a fresh observation proves the interval free'
);
select ok(
  (select status = 'confirmed' and deposit_status = 'confirmed'
   from public.appointments where id = :'appointment_id'::uuid),
  'the successful confirmation keeps one appointment row'
);

-- Applying an inbound reschedule is also a booking mutation. It must not use
-- a partial/old pull and must consider remote ranges which are not represented
-- by an active local appointment.
insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at, status,
  source, coverage, duration_minutes, deposit_status
) values (
  '92300000-0000-4000-8000-000000000046',
  '92300000-0000-4000-8000-000000000010',
  '92300000-0000-4000-8000-000000000001',
  '92300000-0000-4000-8000-000000000002',
  (:'test_date'::date + time '08:00') at time zone 'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '08:30') at time zone 'America/Argentina/Buenos_Aires',
  'confirmed', 'manual', 'ioma', 30, 'confirmed'
);
insert into public.google_calendar_sync_conflicts (
  id, appointment_id, google_event_id, kind, status, proposed_starts_at,
  proposed_ends_at, observed_starts_at, observed_ends_at,
  connection_generation
) values (
  '92300000-0000-4000-8000-000000000060',
  '92300000-0000-4000-8000-000000000046',
  'apply-freshness-primary', 'reschedule_requested', 'pending',
  (:'test_date'::date + time '09:00') at time zone 'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '09:30') at time zone 'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '08:00') at time zone 'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '08:30') at time zone 'America/Argentina/Buenos_Aires',
  923
);
update public.google_calendar_connections
set last_sync_completed_at = clock_timestamp(),
    inbound_lease_token = '92300000-0000-4000-8000-000000000097',
    inbound_lease_expires_at = clock_timestamp() + interval '2 minutes',
    inbound_lease_sync_contract_version = 2,
    inbound_lease_coverage_starts_at = inbound_coverage_starts_at,
    inbound_lease_coverage_ends_at = inbound_coverage_ends_at,
    inbound_lease_timezone = google_calendar_timezone
where id = true;
select throws_ok(
  $$select * from public.apply_google_calendar_conflict(
    '92300000-0000-4000-8000-000000000060'
  )$$,
  '55000',
  'GOOGLE_CALENDAR_CONFLICT_SCOPE_STALE',
  'an inbound lease prevents applying a conflict from a partial pull'
);
select ok(
  (select starts_at =
      (:'test_date'::date + time '08:00') at time zone 'America/Argentina/Buenos_Aires'
   from public.appointments
   where id = '92300000-0000-4000-8000-000000000046')
  and (select status = 'pending'
       from public.google_calendar_sync_conflicts
       where id = '92300000-0000-4000-8000-000000000060'),
  'the rejected partial-pull apply preserves both appointment and review'
);

update public.google_calendar_connections
set inbound_lease_token = null,
    inbound_lease_expires_at = null,
    inbound_lease_sync_contract_version = null,
    inbound_lease_coverage_starts_at = null,
    inbound_lease_coverage_ends_at = null,
    inbound_lease_timezone = null,
    inbound_coverage_ends_at =
      (:'test_date'::date + time '09:35') at time zone 'America/Argentina/Buenos_Aires',
    last_sync_completed_at = clock_timestamp()
where id = true;
select throws_ok(
  $$select * from public.apply_google_calendar_conflict(
    '92300000-0000-4000-8000-000000000060'
  )$$,
  '55000',
  'GOOGLE_CALENDAR_CONFLICT_SCOPE_STALE',
  'the proposed duration plus buffer must fit inside Calendar coverage'
);

update public.google_calendar_connections
set inbound_coverage_ends_at = (current_date + 20)::timestamp
      at time zone 'America/Argentina/Buenos_Aires',
    last_sync_completed_at = clock_timestamp()
where id = true;

insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at, status,
  source, coverage, duration_minutes, deposit_status, hold_expires_at,
  hold_expired_notification_status, created_at
) values (
  '92300000-0000-4000-8000-000000000047',
  '92300000-0000-4000-8000-000000000013',
  '92300000-0000-4000-8000-000000000001',
  '92300000-0000-4000-8000-000000000002',
  (:'test_date'::date + time '08:30') at time zone 'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '09:00') at time zone 'America/Argentina/Buenos_Aires',
  'scheduled', 'whatsapp', 'ioma', 30, 'pending',
  clock_timestamp() - interval '1 hour', 'pending',
  clock_timestamp() - interval '2 hours'
);
insert into public.conversations (id, contact_id, automation_mode)
values (
  '92300000-0000-4000-8000-000000000027',
  '92300000-0000-4000-8000-000000000013',
  'auto'
);
insert into public.automation_sessions (
  conversation_id, state, context, expires_at
) values (
  '92300000-0000-4000-8000-000000000027',
  'waiting_deposit',
  '{"appointmentId":"92300000-0000-4000-8000-000000000047"}'::jsonb,
  clock_timestamp() + interval '1 hour'
);
insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, created_at
) values (
  '92300000-0000-4000-8000-000000000037',
  '92300000-0000-4000-8000-000000000027',
  '92300000-0000-4000-8000-000000000013',
  'inbound', 'image', 'Synthetic timely proof work', 'delivered',
  clock_timestamp() - interval '90 minutes'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select * from public.claim_whatsapp_automation_execution(
  '92300000-0000-4000-8000-000000000037', '{}'::jsonb, 900
) \gset overlap_proof_
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"92300000-0000-4000-8000-000000000080"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  '92300000-0000-4000-8000-000000000080',
  true
);
select ok(
  public.appointment_has_timely_deposit_proof_work(
    '92300000-0000-4000-8000-000000000047',
    clock_timestamp()
  ),
  'timely proof work keeps an expired hold operationally occupied'
);
select throws_ok(
  $$select * from public.apply_google_calendar_conflict(
    '92300000-0000-4000-8000-000000000060'
  )$$,
  'P0001',
  'SLOT_UNAVAILABLE',
  'conflict apply respects a buffer-only overlap protected by timely proof work'
);
delete from public.conversations
where id = '92300000-0000-4000-8000-000000000027';
set local session_replication_role = replica;
delete from public.google_calendar_sync_jobs
where appointment_id = '92300000-0000-4000-8000-000000000047';
delete from public.appointments
where id = '92300000-0000-4000-8000-000000000047';
set local session_replication_role = origin;

insert into public.google_calendar_sync_conflicts (
  id, appointment_id, google_event_id, kind, status, proposed_starts_at,
  proposed_ends_at, observed_starts_at, observed_ends_at,
  connection_generation
) values (
  '92300000-0000-4000-8000-000000000061',
  '92300000-0000-4000-8000-000000000040',
  'apply-freshness-other-conflict', 'reschedule_requested', 'pending',
  (:'test_date'::date + time '08:40') at time zone 'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '09:00') at time zone 'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '16:00') at time zone 'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '16:30') at time zone 'America/Argentina/Buenos_Aires',
  923
);
update public.google_calendar_connections
set last_sync_completed_at = clock_timestamp()
where id = true;
select throws_ok(
  $$select * from public.apply_google_calendar_conflict(
    '92300000-0000-4000-8000-000000000060'
  )$$,
  'P0001',
  'SLOT_UNAVAILABLE',
  'another pending Google move occupies a buffer-only overlap'
);
delete from public.google_calendar_sync_conflicts
where id = '92300000-0000-4000-8000-000000000061';

insert into public.google_calendar_sync_jobs (
  appointment_id, operation, desired_version, connection_generation, status,
  google_event_id, projected_starts_at, projected_ends_at,
  projected_operation, automation_epoch, authorized_google_account_id,
  authorized_google_calendar_id, authorized_connection_generation,
  projection_stage, projected_stage
) values (
  '92300000-0000-4000-8000-000000000040', 'delete', 1, 923, 'failed',
  public.google_calendar_automation_event_id(
    '92300000-0000-4000-8000-000000000040'
  ),
  (:'test_date'::date + time '08:40') at time zone 'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '09:00') at time zone 'America/Argentina/Buenos_Aires',
  'upsert', '92300000-0000-4000-8000-000000000090',
  'booking-fresh-account', 'booking-fresh-calendar', 923,
  'absent', 'pre_reservation'
);
select throws_ok(
  $$select * from public.apply_google_calendar_conflict(
    '92300000-0000-4000-8000-000000000060'
  )$$,
  'P0001',
  'SLOT_UNAVAILABLE',
  'a managed projected event occupies a buffer-only overlap regardless of job status'
);
delete from public.google_calendar_sync_jobs
where appointment_id = '92300000-0000-4000-8000-000000000040';

select is(
  (public.apply_google_calendar_conflict(
    '92300000-0000-4000-8000-000000000060'
  )).status,
  'applied',
  'a current complete observation permits the conflict apply once free'
);
select ok(
  (select starts_at =
      (:'test_date'::date + time '09:00') at time zone 'America/Argentina/Buenos_Aires'
      and ends_at =
      (:'test_date'::date + time '09:30') at time zone 'America/Argentina/Buenos_Aires'
   from public.appointments
   where id = '92300000-0000-4000-8000-000000000046')
  and (select count(*) = 1 from public.appointments
       where id = '92300000-0000-4000-8000-000000000046'),
  'the successful apply moves exactly one appointment without duplication'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '', true);

-- Automatic proof confirmation must be tied to a pre-reservation that Google
-- actually acknowledged. A complete inbound pull does not substitute for a
-- failed outbound POST.
insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at, status,
  source, coverage, duration_minutes, deposit_status, hold_expires_at,
  hold_expired_notification_status
) values
  (
    '92300000-0000-4000-8000-000000000041',
    '92300000-0000-4000-8000-000000000014',
    '92300000-0000-4000-8000-000000000001',
    '92300000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '13:00') at time zone 'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '13:30') at time zone 'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'ioma', 30, 'pending',
    clock_timestamp() + interval '1 hour', 'pending'
  ),
  (
    '92300000-0000-4000-8000-000000000042',
    '92300000-0000-4000-8000-000000000015',
    '92300000-0000-4000-8000-000000000001',
    '92300000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '14:30') at time zone 'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '15:00') at time zone 'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'ioma', 30, 'pending',
    clock_timestamp() + interval '1 hour', 'pending'
  ),
  (
    '92300000-0000-4000-8000-000000000043',
    '92300000-0000-4000-8000-000000000016',
    '92300000-0000-4000-8000-000000000001',
    '92300000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '17:00') at time zone 'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '17:30') at time zone 'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'ioma', 30, 'pending',
    clock_timestamp() + interval '1 hour', 'pending'
  ),
  (
    '92300000-0000-4000-8000-000000000044',
    '92300000-0000-4000-8000-000000000017',
    '92300000-0000-4000-8000-000000000001',
    '92300000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '15:30') at time zone 'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '16:00') at time zone 'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'ioma', 30, 'pending',
    clock_timestamp() + interval '1 hour', 'pending'
  );

insert into public.automation_sessions (
  conversation_id, state, context, expires_at
) values
  (
    '92300000-0000-4000-8000-000000000023', 'waiting_deposit',
    '{"appointmentId":"92300000-0000-4000-8000-000000000041"}'::jsonb,
    clock_timestamp() + interval '1 hour'
  ),
  (
    '92300000-0000-4000-8000-000000000024', 'waiting_deposit',
    '{"appointmentId":"92300000-0000-4000-8000-000000000042"}'::jsonb,
    clock_timestamp() + interval '1 hour'
  ),
  (
    '92300000-0000-4000-8000-000000000025', 'waiting_deposit',
    '{"appointmentId":"92300000-0000-4000-8000-000000000043"}'::jsonb,
    clock_timestamp() + interval '1 hour'
  ),
  (
    '92300000-0000-4000-8000-000000000026', 'waiting_deposit',
    '{"appointmentId":"92300000-0000-4000-8000-000000000045"}'::jsonb,
    clock_timestamp() + interval '1 hour'
  );

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, created_at
) values
  (
    '92300000-0000-4000-8000-000000000033',
    '92300000-0000-4000-8000-000000000023',
    '92300000-0000-4000-8000-000000000014',
    'inbound', 'image', 'Synthetic proof without projection', 'delivered',
    clock_timestamp()
  ),
  (
    '92300000-0000-4000-8000-000000000034',
    '92300000-0000-4000-8000-000000000024',
    '92300000-0000-4000-8000-000000000015',
    'inbound', 'image', 'Synthetic proof with projection', 'delivered',
    clock_timestamp()
  ),
  (
    '92300000-0000-4000-8000-000000000035',
    '92300000-0000-4000-8000-000000000025',
    '92300000-0000-4000-8000-000000000016',
    'inbound', 'image', 'Synthetic proof with stale observation', 'delivered',
    clock_timestamp()
  ),
  (
    '92300000-0000-4000-8000-000000000036',
    '92300000-0000-4000-8000-000000000026',
    '92300000-0000-4000-8000-000000000018',
    'inbound', 'image', 'Synthetic proof after failed refresh', 'delivered',
    clock_timestamp()
  );

select * from public.claim_whatsapp_automation_execution(
  '92300000-0000-4000-8000-000000000033', '{}'::jsonb, 900
) \gset proof_review_
update public.google_calendar_connections
set last_sync_completed_at = clock_timestamp()
where id = true;

select ok(
  not public.google_calendar_pre_reservation_is_projected(
    '92300000-0000-4000-8000-000000000041'
  ),
  'a queued hold without a successful Google baseline is not projected'
);

select public.process_automated_deposit_proof(
  '92300000-0000-4000-8000-000000000033',
  :'proof_review_lease_token'::uuid,
  '92300000-0000-4000-8000-000000000041',
  '{"legible":true,"amount":12345,"currency":"ARS","date":null,"destination":"calendar.test.alias","holder":"Calendar Test Holder","operationId":"projection-missing"}'::jsonb,
  repeat('e', 64), 'deposit-proof-basic/v1', true
) as result
\gset proof_review_result_

select ok(
  :'proof_review_result_result'::jsonb ->> 'status' = 'review'
  and :'proof_review_result_result'::jsonb ->>
    'calendar_availability_verified' = 'false'
  and (:'proof_review_result_result'::jsonb -> 'review_reasons')
    @> '["CALENDAR_AVAILABILITY_UNVERIFIED"]'::jsonb
  and (
    select status = 'scheduled' and deposit_status = 'proof_received'
    from public.appointments
    where id = '92300000-0000-4000-8000-000000000041'
  ),
  'automatic proof routes to review when its pre-reservation is absent in Google'
);
select ok(
  (select count(*) = 1 and bool_and(not auto_approve)
   from public.automated_deposit_proof_results
   where appointment_id = '92300000-0000-4000-8000-000000000041')
  and (select count(*) = 1 from public.audit_logs
       where action = 'deposit.calendar_availability_review_required'
         and entity_id = '92300000-0000-4000-8000-000000000041')
  and (select count(*) = 1 from public.whatsapp_automation_effects
       where execution_message_id = '92300000-0000-4000-8000-000000000033'
         and effect_type = 'appointment_deposit_process'),
  'the missing projection creates one durable review result, effect and audit'
);

select public.process_automated_deposit_proof(
  '92300000-0000-4000-8000-000000000033',
  :'proof_review_lease_token'::uuid,
  '92300000-0000-4000-8000-000000000041',
  '{"legible":true,"amount":12345,"currency":"ARS","date":null,"destination":"calendar.test.alias","holder":"Calendar Test Holder","operationId":"projection-missing"}'::jsonb,
  repeat('e', 64), 'deposit-proof-basic/v1', true
) as result
\gset proof_review_retry_
select ok(
  (:'proof_review_retry_result'::jsonb ->> 'idempotent')::boolean
  and :'proof_review_retry_result'::jsonb ->> 'status' = 'review'
  and (select count(*) = 1 from public.automated_deposit_proof_results
       where appointment_id = '92300000-0000-4000-8000-000000000041')
  and (select count(*) = 1 from public.audit_logs
       where action = 'deposit.calendar_availability_review_required'
         and entity_id = '92300000-0000-4000-8000-000000000041'),
  'retry cannot elevate a Calendar review or duplicate its durable evidence'
);

select * from public.claim_whatsapp_automation_execution(
  '92300000-0000-4000-8000-000000000036', '{}'::jsonb, 900
) \gset proof_refresh_failed_
select public.process_automated_deposit_proof(
  '92300000-0000-4000-8000-000000000036',
  :'proof_refresh_failed_lease_token'::uuid,
  '92300000-0000-4000-8000-000000000045',
  '{"legible":true,"amount":12345,"currency":"ARS","date":null,"destination":"calendar.test.alias","holder":"Calendar Test Holder","operationId":"refresh-failed","calendarAvailabilityVerified":false}'::jsonb,
  repeat('c', 64), 'deposit-proof-basic/v1', false
) as result
\gset proof_refresh_failed_result_
select ok(
  :'proof_refresh_failed_result_result'::jsonb ->> 'status' = 'review'
  and :'proof_refresh_failed_result_result'::jsonb ->>
    'auto_approve_requested' = 'true'
  and :'proof_refresh_failed_result_result'::jsonb ->>
    'calendar_availability_verified' = 'false'
  and (:'proof_refresh_failed_result_result'::jsonb -> 'review_reasons')
    @> '["CALENDAR_AVAILABILITY_UNVERIFIED"]'::jsonb
  and (
    select status = 'scheduled' and deposit_status = 'proof_received'
    from public.appointments
    where id = '92300000-0000-4000-8000-000000000045'
  ),
  'the Edge refresh-failure flag becomes a durable Calendar review'
);

select * from public.claim_whatsapp_automation_execution(
  '92300000-0000-4000-8000-000000000035', '{}'::jsonb, 900
) \gset proof_stale_
update public.google_calendar_sync_jobs job
set operation = 'upsert',
    status = 'succeeded',
    processing_started_at = null,
    last_error = null,
    google_event_id = public.google_calendar_automation_event_id(job.appointment_id),
    google_etag = '"synthetic-stale-etag"',
    projected_operation = 'upsert',
    projected_starts_at = appointment.starts_at,
    projected_ends_at = appointment.ends_at,
    projection_stage = 'pre_reservation',
    projected_stage = 'pre_reservation'
from public.appointments appointment
where job.appointment_id = '92300000-0000-4000-8000-000000000043'
  and appointment.id = job.appointment_id;
update public.google_calendar_connections connection
set last_sync_completed_at = execution.processing_started_at
      - interval '1 millisecond'
from public.whatsapp_automation_executions execution
where connection.id = true
  and execution.message_id = '92300000-0000-4000-8000-000000000035';
select ok(
  public.google_calendar_pre_reservation_is_projected(
    '92300000-0000-4000-8000-000000000043'
  )
  and not public.google_calendar_booking_observation_covers(
    (select processing_started_at
     from public.whatsapp_automation_executions
     where message_id = '92300000-0000-4000-8000-000000000035'),
    (select starts_at from public.appointments
     where id = '92300000-0000-4000-8000-000000000043'),
    (select ends_at + interval '15 minutes' from public.appointments
     where id = '92300000-0000-4000-8000-000000000043'),
    '92300000-0000-4000-8000-000000000043'
  ),
  'a projected hold still rejects an observation made before this execution'
);
select public.process_automated_deposit_proof(
  '92300000-0000-4000-8000-000000000035',
  :'proof_stale_lease_token'::uuid,
  '92300000-0000-4000-8000-000000000043',
  '{"legible":true,"amount":12345,"currency":"ARS","date":null,"destination":"calendar.test.alias","holder":"Calendar Test Holder","operationId":"stale-observation"}'::jsonb,
  repeat('d', 64), 'deposit-proof-basic/v1', true
) as result
\gset proof_stale_result_
select ok(
  :'proof_stale_result_result'::jsonb ->> 'status' = 'review'
  and :'proof_stale_result_result'::jsonb ->>
    'calendar_availability_verified' = 'false'
  and (
    select status = 'scheduled' and deposit_status = 'proof_received'
    from public.appointments
    where id = '92300000-0000-4000-8000-000000000043'
  )
  and (select count(*) = 1 from public.audit_logs
       where action = 'deposit.calendar_availability_review_required'
         and entity_id = '92300000-0000-4000-8000-000000000043'),
  'automatic proof cannot confirm against a pre-execution Calendar snapshot'
);

select * from public.claim_whatsapp_automation_execution(
  '92300000-0000-4000-8000-000000000034', '{}'::jsonb, 900
) \gset proof_confirm_
update public.google_calendar_connections
set last_sync_completed_at = clock_timestamp()
where id = true;
update public.google_calendar_sync_jobs job
set operation = 'upsert',
    status = 'succeeded',
    processing_started_at = null,
    last_error = null,
    google_event_id = public.google_calendar_automation_event_id(job.appointment_id),
    google_etag = '"synthetic-projection-etag"',
    projected_operation = 'upsert',
    projected_starts_at = appointment.starts_at,
    projected_ends_at = appointment.ends_at,
    projection_stage = 'pre_reservation',
    projected_stage = 'pre_reservation'
from public.appointments appointment
where job.appointment_id = '92300000-0000-4000-8000-000000000042'
  and appointment.id = job.appointment_id;

update public.google_calendar_sync_jobs job
set operation = 'upsert',
    status = 'succeeded',
    google_event_id = public.google_calendar_automation_event_id(job.appointment_id),
    projected_operation = 'upsert',
    projected_starts_at = (:'test_date'::date + time '14:00')
      at time zone 'America/Argentina/Buenos_Aires',
    projected_ends_at = (:'test_date'::date + time '14:30')
      at time zone 'America/Argentina/Buenos_Aires',
    projection_stage = 'pre_reservation',
    projected_stage = 'pre_reservation'
where job.appointment_id = '92300000-0000-4000-8000-000000000044';
select ok(
  not public.appointment_slot_is_free_for(
    '92300000-0000-4000-8000-000000000042'
  ),
  'confirmation does not exclude another managed event occupying the buffer'
);
update public.google_calendar_sync_jobs
set projected_operation = null,
    projected_starts_at = null,
    projected_ends_at = null,
    projected_stage = null
where appointment_id = '92300000-0000-4000-8000-000000000044';
select ok(
  public.appointment_slot_is_free_for(
    '92300000-0000-4000-8000-000000000042'
  ),
  'confirmation excludes only its own exact projected pre-reservation'
);

select ok(
  public.google_calendar_pre_reservation_is_projected(
    '92300000-0000-4000-8000-000000000042'
  ),
  'an exact successful pre-reservation baseline is recognized'
);
select public.process_automated_deposit_proof(
  '92300000-0000-4000-8000-000000000034',
  :'proof_confirm_lease_token'::uuid,
  '92300000-0000-4000-8000-000000000042',
  '{"legible":true,"amount":12345,"currency":"ARS","date":null,"destination":"calendar.test.alias","holder":"Calendar Test Holder","operationId":"projection-present"}'::jsonb,
  repeat('f', 64), 'deposit-proof-basic/v1', true
) as result
\gset proof_confirm_result_
select ok(
  :'proof_confirm_result_result'::jsonb ->> 'status' = 'confirmed'
  and (
    select status = 'confirmed' and deposit_status = 'confirmed'
    from public.appointments
    where id = '92300000-0000-4000-8000-000000000042'
  )
  and (select count(*) = 1 and bool_and(auto_approve)
       from public.automated_deposit_proof_results
       where appointment_id = '92300000-0000-4000-8000-000000000042'),
  'automatic proof confirms exactly one hold after Google acknowledged it'
);

-- A locally cancelled appointment is not free while its last known managed
-- event is still present. DELETE completion clears projected_* and only then
-- releases the range.
update public.google_calendar_sync_jobs job
set operation = 'upsert',
    status = 'succeeded',
    google_event_id = public.google_calendar_automation_event_id(job.appointment_id),
    google_etag = '"synthetic-delete-etag"',
    projected_operation = 'upsert',
    projected_starts_at = appointment.starts_at,
    projected_ends_at = appointment.ends_at,
    projection_stage = 'pre_reservation',
    projected_stage = 'pre_reservation'
from public.appointments appointment
where job.appointment_id = '92300000-0000-4000-8000-000000000044'
  and appointment.id = job.appointment_id;
select public.update_appointment_status(
  '92300000-0000-4000-8000-000000000044',
  'cancelled'::public.appointment_status
);
update public.google_calendar_connections
set last_sync_completed_at = clock_timestamp()
where id = true;

select ok(
  (select operation = 'delete'
      and status = 'pending'
      and projected_operation = 'upsert'
      and projected_stage = 'pre_reservation'
   from public.google_calendar_sync_jobs
   where appointment_id = '92300000-0000-4000-8000-000000000044')
  and not public.appointment_slot_is_available(
    '92300000-0000-4000-8000-000000000001',
    (:'test_date'::date + time '16:05') at time zone 'America/Argentina/Buenos_Aires',
    30, null, 'America/Argentina/Buenos_Aires'
  ),
  'a cancelled appointment and its buffer remain occupied until Google acknowledges DELETE'
);
update public.google_calendar_sync_jobs
set status = 'succeeded',
    projected_operation = 'delete',
    projected_starts_at = null,
    projected_ends_at = null,
    projected_stage = 'absent'
where appointment_id = '92300000-0000-4000-8000-000000000044';
select ok(
  public.appointment_slot_is_available(
    '92300000-0000-4000-8000-000000000001',
    (:'test_date'::date + time '16:05') at time zone 'America/Argentina/Buenos_Aires',
    30, null, 'America/Argentina/Buenos_Aires'
  ),
  'the interval is released only after successful Google deletion evidence'
);

select * from finish();
rollback;
