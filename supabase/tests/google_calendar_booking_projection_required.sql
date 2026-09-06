\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(14);

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

update public.google_calendar_connections
set last_sync_completed_at = clock_timestamp(), last_error = null
where id = true;

select ok(public.appointment_slot_is_available(
  '92300000-0000-4000-8000-000000000001',
  (:'test_date'::date + time '09:00') at time zone 'America/Argentina/Buenos_Aires',
  30, null, 'America/Argentina/Buenos_Aires'
), 'fresh authorized Calendar permits the slot');

select (public.create_service_appointment(
  '92300000-0000-4000-8000-000000000010',
  '92300000-0000-4000-8000-000000000001',
  '92300000-0000-4000-8000-000000000002',
  (:'test_date'::date + time '09:00') at time zone 'America/Argentina/Buenos_Aires'
)).id as appointment_id
\gset

select is(public.appointment_google_calendar_projection(:'appointment_id') ->> 'state',
  'pending', 'local commit and a queued job are not proof of remote persistence');

update public.google_calendar_sync_jobs job
set status = 'succeeded',
    projected_operation = 'upsert',
    projected_stage = 'pre_reservation',
    projected_starts_at = appointment.starts_at,
    projected_ends_at = appointment.ends_at,
    last_error = null
from public.appointments appointment
where job.appointment_id = appointment.id and appointment.id = :'appointment_id';

select is(public.appointment_google_calendar_projection(:'appointment_id') ->> 'state',
  'synced', 'acknowledged exact pre-reservation is synced');
select is(public.appointment_google_calendar_projection(:'appointment_id') ->> 'projectionStage',
  'pre_reservation', 'returns the projected stage without patient or Google identifiers');

update public.google_calendar_sync_jobs
set projected_starts_at = projected_starts_at + interval '1 minute'
where appointment_id = :'appointment_id';
select is(public.appointment_google_calendar_projection(:'appointment_id') ->> 'state',
  'pending', 'a different projected range never confirms the current appointment');

update public.google_calendar_sync_jobs job
set projected_starts_at = appointment.starts_at, status = 'failed', last_error = 'GOOGLE_CALENDAR_SLOT_OCCUPIED'
from public.appointments appointment
where job.appointment_id = appointment.id and appointment.id = :'appointment_id';
select is(public.appointment_google_calendar_projection(:'appointment_id') ->> 'state',
  'pending', 'a failed push remains pending even if a previous range was projected');

update public.google_calendar_sync_jobs
set status = 'succeeded', last_error = null, projected_stage = 'confirmed'
where appointment_id = :'appointment_id';
select is(public.appointment_google_calendar_projection(:'appointment_id') ->> 'state',
  'pending', 'an incompatible projection stage cannot acknowledge this hold');

update public.google_calendar_connections
set automation_enabled = false, automation_epoch = null,
    automation_activated_at = null, automation_google_account_id = null,
    automation_google_calendar_id = null, automation_connection_generation = null
where id = true;
select is(public.appointment_google_calendar_projection(:'appointment_id') ->> 'state',
  'unavailable', 'disabled automation cannot authorize patient confirmations');
select ok(not public.appointment_slot_is_available(
  '92300000-0000-4000-8000-000000000001',
  (:'test_date'::date + time '11:00') at time zone 'America/Argentina/Buenos_Aires',
  30, null, 'America/Argentina/Buenos_Aires'
), 'disabled automation cannot offer a new slot');
select ok(not public.appointment_slot_is_free_for(:'appointment_id'),
  'disabled automation cannot confirm an existing hold');

update public.google_calendar_connections
set status = 'disconnected', connected_by = null,
    google_account_id = null, google_account_email = null,
    google_calendar_id = null, google_calendar_name = null,
    google_calendar_timezone = null, refresh_token_secret_id = null,
    connected_at = null, sync_scope_google_account_id = null,
    sync_scope_google_calendar_id = null, sync_scope_generation = null,
    inbound_sync_token = null, inbound_sync_token_generation = null,
    inbound_sync_state = 'never_synced', inbound_first_import_approved_at = null,
    inbound_first_import_approved_by = null, inbound_lease_token = null,
    inbound_lease_expires_at = null
where id = true;
select ok(not public.appointment_slot_is_available(
  '92300000-0000-4000-8000-000000000001',
  (:'test_date'::date + time '11:00') at time zone 'America/Argentina/Buenos_Aires',
  30, null, 'America/Argentina/Buenos_Aires'
), 'disconnection never falls back to local-only availability');
select is(public.appointment_google_calendar_projection(:'appointment_id') ->> 'state',
  'unavailable', 'disconnection cannot report a stale projection as synced');
select throws_ok(format(
  'select public.create_service_appointment(%L, %L, %L, %L)',
  '92300000-0000-4000-8000-000000000011',
  '92300000-0000-4000-8000-000000000001',
  '92300000-0000-4000-8000-000000000002',
  (:'test_date'::date + time '11:00') at time zone 'America/Argentina/Buenos_Aires'
), 'P0001', 'CALENDAR_NOT_READY', 'manual submit distinguishes unavailable Calendar from an occupied slot');

select set_config('request.jwt.claims', '{"role":"anon"}', true);
select set_config('request.jwt.claim.role', 'anon', true);
select throws_ok(format('select public.appointment_google_calendar_projection(%L)', :'appointment_id'),
  '42501', 'NOT_AUTHORIZED', 'anonymous callers cannot read appointment synchronization');

select * from finish();
rollback;
