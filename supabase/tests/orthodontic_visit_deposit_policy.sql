\set ON_ERROR_STOP on

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(47);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

update public.app_settings
set automations_enabled = true, minimum_booking_notice_minutes = 0,
    appointment_buffer_minutes = 0, deposit_enabled = true,
    deposit_amount_ars = 12345, deposit_alias = 'orthodontic.test.alias',
    deposit_holder = 'Orthodontic Test Holder', booking_hold_minutes = 60,
    ioma_duration_minutes = 30, private_duration_minutes = 60
where id;
\ir _support/calendar-ready.inc

insert into public.professionals (id, name, appointment_duration_minutes, active)
values ('92800000-0000-4000-8000-000000000001', 'Orthodontic Test', 30, true);
insert into public.availability_rules (professional_id, weekday, start_time, end_time, slot_minutes)
select '92800000-0000-4000-8000-000000000001', day, '07:00', '23:00', 30
from generate_series(0, 6) day;
insert into public.services (id, name, duration_minutes, active, sort_order)
values
  ('92800000-0000-4000-8000-000000000002', 'Other Test', 30, true, 9280),
  ('92800000-0000-4000-8000-000000000003', 'Historical Orthodontic Test', 30, true, 9281);
insert into public.contacts (id, phone_e164, name, coverage, is_existing_patient)
values
  ('92800000-0000-4000-8000-000000000010', '+12025550128', 'Orthodontic IOMA Test', 'ioma', true),
  ('92800000-0000-4000-8000-000000000011', '+12025550129', 'Orthodontic Private Test', 'particular', false);
insert into public.conversations (id, contact_id, automation_mode)
values
  ('92800000-0000-4000-8000-000000000020', '92800000-0000-4000-8000-000000000010', 'auto'),
  ('92800000-0000-4000-8000-000000000021', '92800000-0000-4000-8000-000000000011', 'auto');

create function pg_temp.ortho_slot(p_time text, p_day integer default 7)
returns timestamptz language sql stable as $$
  select (current_date + p_day + p_time::time)
    at time zone 'America/Argentina/Buenos_Aires';
$$;
create function pg_temp.ortho_create(
  p_time text,
  p_visit public.orthodontic_visit_type default null,
  p_service uuid default '51000000-0000-4000-8000-000000000007',
  p_contact uuid default '92800000-0000-4000-8000-000000000010'
) returns public.appointments language sql as $$
  select public.create_service_appointment(
    p_contact, '92800000-0000-4000-8000-000000000001', p_service,
    pg_temp.ortho_slot(p_time), 'manual', null, p_visit
  );
$$;
create temporary table ortho_bookings (key text primary key, id uuid not null);

select is(enum_range(null::public.orthodontic_visit_type)::text,
  '{first_visit,in_treatment}', 'only the two explicit visit types are accepted');
select ok((select requires_orthodontic_intake from public.services
  where id = '51000000-0000-4000-8000-000000000007'),
  'the stable canonical orthodontic service requires intake');
select ok((select not requires_orthodontic_intake from public.services
  where id = '92800000-0000-4000-8000-000000000002'),
  'other services default to no orthodontic intake');
select ok((select count(*) = 3 from pg_proc where pronamespace = 'public'::regnamespace
  and proname in ('create_service_appointment', 'create_whatsapp_automation_appointment',
    'convert_google_calendar_block_to_appointment')),
  'each changed RPC has exactly one signature, without ambiguous overloads');
select ok(
  has_function_privilege('authenticated', 'public.create_service_appointment(uuid,uuid,uuid,timestamptz,public.appointment_source,text,public.orthodontic_visit_type)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.create_service_appointment(uuid,uuid,uuid,timestamptz,public.appointment_source,text,public.orthodontic_visit_type)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.create_whatsapp_automation_appointment(uuid,uuid,uuid,uuid,uuid,timestamptz,public.orthodontic_visit_type)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.create_whatsapp_automation_appointment(uuid,uuid,uuid,uuid,uuid,timestamptz,public.orthodontic_visit_type)', 'EXECUTE'),
  'the replacement signatures preserve browser and service-role authorization');

select throws_ok($$select pg_temp.ortho_create('08:00')$$,
  'P0001', 'ORTHODONTIC_VISIT_TYPE_REQUIRED',
  'an existing patient still must choose an orthodontic visit type');
select throws_ok($$select pg_temp.ortho_create('08:00', null,
  '51000000-0000-4000-8000-000000000007', '92800000-0000-4000-8000-000000000011')$$,
  'P0001', 'ORTHODONTIC_VISIT_TYPE_REQUIRED',
  'a new patient also must choose an orthodontic visit type');
select throws_ok($$select pg_temp.ortho_create('08:00', 'in_treatment',
  '92800000-0000-4000-8000-000000000002')$$,
  'P0001', 'ORTHODONTIC_VISIT_TYPE_NOT_APPLICABLE',
  'another service cannot claim the orthodontic deposit exemption');
select throws_ok($$select 'returning'::public.orthodontic_visit_type$$,
  '22P02', null, 'unknown visit types are rejected by the database enum');

insert into ortho_bookings values ('first', (pg_temp.ortho_create('08:00', 'first_visit')).id);
insert into ortho_bookings values ('treatment', (pg_temp.ortho_create('09:00', 'in_treatment')).id);
insert into ortho_bookings values ('private', (pg_temp.ortho_create('10:00', 'in_treatment',
  '51000000-0000-4000-8000-000000000007', '92800000-0000-4000-8000-000000000011')).id);
insert into ortho_bookings values ('other', (public.create_service_appointment(
  '92800000-0000-4000-8000-000000000010', '92800000-0000-4000-8000-000000000001',
  '92800000-0000-4000-8000-000000000002', pg_temp.ortho_slot('11:00')
)).id);
insert into ortho_bookings values ('historical', (pg_temp.ortho_create('12:00', null,
  '92800000-0000-4000-8000-000000000003')).id);

select ok((select status = 'scheduled' and deposit_status = 'pending'
  and orthodontic_visit_type = 'first_visit' and hold_expires_at > clock_timestamp()
  and deposit_expected_amount_ars = 12345 and deposit_expected_alias = 'orthodontic.test.alias'
  from public.appointments where id = (select id from ortho_bookings where key = 'first')),
  'first visit follows the existing deposit and hold policy');
select ok((select status = 'confirmed' and deposit_status = 'not_required'
  and orthodontic_visit_type = 'in_treatment' and hold_expires_at is null
  and deposit_expected_amount_ars is null and deposit_expected_alias is null
  and deposit_expected_holder is null and hold_expired_notification_status = 'not_applicable'
  and duration_minutes = 30
  from public.appointments where id = (select id from ortho_bookings where key = 'treatment')),
  'ongoing IOMA treatment is confirmed without any deposit instructions or hold');
select ok((select status = 'confirmed' and deposit_status = 'not_required'
  and orthodontic_visit_type = 'in_treatment' and duration_minutes = 60
  and ends_at - starts_at = interval '60 minutes'
  from public.appointments where id = (select id from ortho_bookings where key = 'private')),
  'explicit ongoing treatment also works for Particular regardless of patient-history flag');
select ok((select status = 'scheduled' and deposit_status = 'pending'
  and orthodontic_visit_type is null and deposit_expected_amount_ars = 12345
  from public.appointments where id = (select id from ortho_bookings where key = 'other')),
  'the old four-argument RPC remains compatible for other services');
select ok((select job.operation = 'upsert' and job.projection_stage = 'confirmed'
  and job.status = 'pending' from public.google_calendar_sync_jobs job
  where job.appointment_id = (select id from ortho_bookings where key = 'treatment')),
  'no-deposit treatment still queues the exact confirmed Calendar projection');
select is(public.appointment_google_calendar_projection((select id from ortho_bookings where key = 'treatment')) ->> 'state',
  'pending', 'local no-deposit confirmation is not evidence that Google saved the turn');
select pg_temp.calendar_projection_synced((select id from ortho_bookings where key = 'treatment'));
select is(public.appointment_google_calendar_projection((select id from ortho_bookings where key = 'treatment')) ->> 'state',
  'synced', 'the existing exact Google acknowledgement gate also supports treatment');

update public.app_settings set deposit_enabled = false where id;
insert into ortho_bookings values ('first_no_deposit', (pg_temp.ortho_create('13:00', 'first_visit')).id);
select ok((select status = 'confirmed' and deposit_status = 'not_required'
  and orthodontic_visit_type = 'first_visit' and hold_expires_at is null
  from public.appointments where id = (select id from ortho_bookings where key = 'first_no_deposit')),
  'first visit still follows the global policy when deposits are disabled');
update public.app_settings set deposit_enabled = true, deposit_amount_ars = 54321,
  deposit_alias = 'changed.test.alias' where id;
update public.services set name = 'Renamed Orthodontic Test', requires_orthodontic_intake = false
where id = '51000000-0000-4000-8000-000000000007';
update public.contacts set is_existing_patient = false
where id = '92800000-0000-4000-8000-000000000010';
select public.reschedule_service_appointment((select id from ortho_bookings where key = 'treatment'), pg_temp.ortho_slot('09:00', 8));
select public.reschedule_appointment((select id from ortho_bookings where key = 'first'), pg_temp.ortho_slot('08:00', 8));
select ok((select orthodontic_visit_type = 'in_treatment' and status = 'confirmed'
  and deposit_status = 'not_required' and hold_expires_at is null
  and deposit_expected_amount_ars is null
  from public.appointments where id = (select id from ortho_bookings where key = 'treatment')),
  'rescheduling retains exemption after service identity and contact-history edits');
select ok((select orthodontic_visit_type = 'first_visit' and deposit_status = 'pending'
  and deposit_expected_amount_ars = 12345 and deposit_expected_alias = 'orthodontic.test.alias'
  from public.appointments where id = (select id from ortho_bookings where key = 'first')),
  'rescheduling first visit retains the original deposit snapshot');
update public.services set requires_orthodontic_intake = true
where id in ('51000000-0000-4000-8000-000000000007', '92800000-0000-4000-8000-000000000003');
select public.reschedule_appointment((select id from ortho_bookings where key = 'historical'), pg_temp.ortho_slot('12:00', 8));
select ok((select orthodontic_visit_type is null and deposit_status = 'pending'
  and deposit_expected_amount_ars = 12345
  from public.appointments where id = (select id from ortho_bookings where key = 'historical')),
  'a previously booked appointment remains unclassified and retains its deposit');
select throws_ok($$update public.appointments set orthodontic_visit_type = 'in_treatment'
  where id = (select id from ortho_bookings where key = 'first')$$,
  '23514', 'ORTHODONTIC_VISIT_TYPE_IMMUTABLE', 'first visits cannot be reclassified to discard a deposit');
select throws_ok($$update public.appointments set orthodontic_visit_type = 'in_treatment'
  where id = (select id from ortho_bookings where key = 'historical')$$,
  '23514', 'ORTHODONTIC_VISIT_TYPE_IMMUTABLE', 'historical appointments cannot be retrospectively exempted');
select throws_ok($$update public.appointments set orthodontic_visit_type = null
  where id = (select id from ortho_bookings where key = 'treatment')$$,
  '23514', 'ORTHODONTIC_VISIT_TYPE_IMMUTABLE', 'a saved treatment choice cannot be erased');
select throws_ok($$update public.appointments set service_id = '92800000-0000-4000-8000-000000000002'
  where id = (select id from ortho_bookings where key = 'treatment')$$,
  '23514', 'ORTHODONTIC_VISIT_TYPE_IMMUTABLE', 'the exemption cannot be transferred to another service');
select throws_ok($$update public.appointments set service_id = '51000000-0000-4000-8000-000000000007'
  where id = (select id from ortho_bookings where key = 'other')$$,
  'P0001', 'ORTHODONTIC_VISIT_TYPE_REQUIRED', 'updating another service cannot bypass intake');
select throws_ok($$update public.appointments set status = 'scheduled', deposit_status = 'pending',
  hold_expires_at = clock_timestamp() + interval '1 hour'
  where id = (select id from ortho_bookings where key = 'treatment')$$,
  '23514', null, 'future writers cannot turn an exempt treatment into a deposit hold');
select throws_ok($$insert into public.appointments (
  contact_id, professional_id, service_id, starts_at, ends_at, status, deposit_status)
  values ('92800000-0000-4000-8000-000000000010', '92800000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000007', pg_temp.ortho_slot('14:00'),
  pg_temp.ortho_slot('14:30'), 'confirmed', 'not_required')$$,
  'P0001', 'ORTHODONTIC_VISIT_TYPE_REQUIRED', 'direct inserts cannot bypass required intake');

insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind, status, starts_at, ends_at, content_hash)
values ('synthetic-domain-test-calendar', 'orthodontic-busy', 9900, 'block', 'active',
  pg_temp.ortho_slot('14:00'), pg_temp.ortho_slot('15:00'), md5('orthodontic-busy'));
select throws_ok($$select pg_temp.ortho_create('14:00', 'in_treatment')$$,
  'P0001', 'SLOT_UNAVAILABLE', 'exempt treatment cannot overlap a Google event');
update public.google_calendar_connections set last_sync_completed_at = clock_timestamp() - interval '20 minutes' where id;
select throws_ok($$select pg_temp.ortho_create('15:00', 'in_treatment')$$,
  'P0001', 'SLOT_UNAVAILABLE', 'exempt treatment cannot book against stale Google observations');
select pg_temp.calendar_ready();
update public.google_calendar_connections set automation_enabled = false,
  automation_epoch = null, automation_activated_at = null,
  automation_google_account_id = null, automation_google_calendar_id = null,
  automation_connection_generation = null where id;
select throws_ok($$select pg_temp.ortho_create('15:00', 'in_treatment')$$,
  'P0001', 'CALENDAR_NOT_READY', 'the exemption does not bypass a paused Google integration');
select pg_temp.calendar_ready();

-- Real idempotent automation RPCs with synthetic inbound messages only.
insert into public.messages (id, conversation_id, contact_id, direction, type, body, status)
values ('92800000-0000-4000-8000-000000000030', '92800000-0000-4000-8000-000000000020',
  '92800000-0000-4000-8000-000000000010', 'inbound', 'text', 'Test appointment confirmation', 'read');
select * from public.claim_whatsapp_automation_execution(
  '92800000-0000-4000-8000-000000000030', '{"delivery_mode":"whatsapp"}', 900) \gset wa_
select pg_temp.calendar_ready();
select throws_ok(format($sql$select public.create_whatsapp_automation_appointment(
  '92800000-0000-4000-8000-000000000030', %L,
  '92800000-0000-4000-8000-000000000010', '92800000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000007', pg_temp.ortho_slot('16:00'))$sql$,
  :'wa_lease_token'), 'P0001', 'ORTHODONTIC_VISIT_TYPE_REQUIRED',
  'an old WhatsApp caller without a visit type cannot create an orthodontic appointment');
select ok(not exists (select 1 from public.whatsapp_automation_effects
  where execution_message_id = '92800000-0000-4000-8000-000000000030' and effect_key = 'appointment:create'),
  'missing intake commits neither a reservation nor an idempotent booking effect');
select public.create_whatsapp_automation_appointment(
  '92800000-0000-4000-8000-000000000030', :'wa_lease_token',
  '92800000-0000-4000-8000-000000000010', '92800000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000007', pg_temp.ortho_slot('16:00'), 'in_treatment'
) as result \gset wa_created_
insert into ortho_bookings values ('wa', (:'wa_created_result'::jsonb ->> 'id')::uuid);
select is(:'wa_created_result'::jsonb ->> 'deposit_status', 'not_required',
  'WhatsApp creation passes the chosen treatment type to the authoritative booking RPC');
select is(public.create_whatsapp_automation_appointment(
  '92800000-0000-4000-8000-000000000030', :'wa_lease_token',
  '92800000-0000-4000-8000-000000000010', '92800000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000007', pg_temp.ortho_slot('16:00'), 'in_treatment'
) ->> 'id', :'wa_created_result'::jsonb ->> 'id', 'the identical WhatsApp retry returns the same reservation');
select throws_ok(format($sql$select public.create_whatsapp_automation_appointment(
  '92800000-0000-4000-8000-000000000030', %L,
  '92800000-0000-4000-8000-000000000010', '92800000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000007', pg_temp.ortho_slot('16:00'), 'first_visit')$sql$,
  :'wa_lease_token'), '23514', 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT',
  'a retry cannot change the recorded orthodontic visit type');
select public.reschedule_whatsapp_automation_appointment(
  '92800000-0000-4000-8000-000000000030', :'wa_lease_token',
  (select id from ortho_bookings where key = 'wa'), pg_temp.ortho_slot('16:00', 8)) as result \gset wa_moved_
select ok(:'wa_moved_result'::jsonb ->> 'orthodontic_visit_type' = 'in_treatment'
  and :'wa_moved_result'::jsonb ->> 'deposit_status' = 'not_required',
  'WhatsApp rescheduling keeps the existing visit snapshot and exemption');

-- A committed pre-migration ledger entry omitted the new key entirely.
insert into public.messages (id, conversation_id, contact_id, direction, type, body, status)
values ('92800000-0000-4000-8000-000000000031', '92800000-0000-4000-8000-000000000021',
  '92800000-0000-4000-8000-000000000011', 'inbound', 'text', 'Test legacy replay', 'read');
select * from public.claim_whatsapp_automation_execution(
  '92800000-0000-4000-8000-000000000031', '{"delivery_mode":"whatsapp"}', 900) \gset legacy_
select pg_temp.calendar_ready();
select public.create_whatsapp_automation_appointment(
  '92800000-0000-4000-8000-000000000031', :'legacy_lease_token',
  '92800000-0000-4000-8000-000000000011', '92800000-0000-4000-8000-000000000001',
  '92800000-0000-4000-8000-000000000002', pg_temp.ortho_slot('18:00')
) as result \gset legacy_created_
update public.whatsapp_automation_effects
set request = request - 'orthodontic_visit_type'
where execution_message_id = '92800000-0000-4000-8000-000000000031' and effect_key = 'appointment:create';
select is(public.create_whatsapp_automation_appointment(
  '92800000-0000-4000-8000-000000000031', :'legacy_lease_token',
  '92800000-0000-4000-8000-000000000011', '92800000-0000-4000-8000-000000000001',
  '92800000-0000-4000-8000-000000000002', pg_temp.ortho_slot('18:00')
) ->> 'id', :'legacy_created_result'::jsonb ->> 'id', 'old committed requests without the new key replay compatibly');

-- Calendar block conversion must use the same explicit intake and policy.
insert into auth.users (id, email, encrypted_password, aud, role)
values ('92800000-0000-4000-8000-000000000040', 'orthodontic-admin@example.test', '', 'authenticated', 'authenticated');
update public.profiles set role = 'ADMIN', active = true where id = '92800000-0000-4000-8000-000000000040';
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"92800000-0000-4000-8000-000000000040"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind, status, starts_at, ends_at, content_hash)
values ('synthetic-domain-test-calendar', 'orthodontic-conversion', 9900, 'block', 'active',
  pg_temp.ortho_slot('17:00'), pg_temp.ortho_slot('17:30'), md5('orthodontic-conversion'));
select throws_ok($$select public.convert_google_calendar_block_to_appointment(
  'orthodontic-conversion', '92800000-0000-4000-8000-000000000010',
  '92800000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000007',
  pg_temp.ortho_slot('17:00'))$$, 'P0001', 'ORTHODONTIC_VISIT_TYPE_REQUIRED',
  'legacy conversion calls cannot bypass orthodontic intake');
select is((select status from public.google_calendar_external_events where google_event_id = 'orthodontic-conversion'),
  'active', 'failed intake rolls back conversion and preserves the Google block');
insert into ortho_bookings
select 'conversion', appointment_id from public.convert_google_calendar_block_to_appointment(
  'orthodontic-conversion', '92800000-0000-4000-8000-000000000010',
  '92800000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000007',
  pg_temp.ortho_slot('17:00'), null, 'in_treatment');
select ok((select orthodontic_visit_type = 'in_treatment' and status = 'confirmed'
  and deposit_status = 'not_required' and hold_expires_at is null
  from public.appointments where id = (select id from ortho_bookings where key = 'conversion')),
  'converting a Google block to ongoing treatment also omits the deposit');
select ok((select not created from public.convert_google_calendar_block_to_appointment(
  'orthodontic-conversion', '92800000-0000-4000-8000-000000000010',
  '92800000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000007',
  pg_temp.ortho_slot('17:00'), null, 'in_treatment')),
  'a conversion retry with the same selection creates no duplicate');
select throws_ok($$select public.convert_google_calendar_block_to_appointment(
  'orthodontic-conversion', '92800000-0000-4000-8000-000000000010',
  '92800000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000007',
  pg_temp.ortho_slot('17:00'), null, 'first_visit')$$, '23514', 'CALENDAR_BLOCK_CONVERSION_CONFLICT',
  'a conversion retry cannot silently change the appointment type');

-- A distinct confirmation source remains within the same automation quota.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
update public.whatsapp_settings set sending_paused = false where id;
select set_config('app.whatsapp_policy_seed_bypass', 'on', true);
insert into public.messages (conversation_id, contact_id, direction, type, body, status, idempotency_key, metadata)
select '92800000-0000-4000-8000-000000000021', '92800000-0000-4000-8000-000000000011',
  'outbound', 'text', 'Synthetic quota fixture', 'sent', 'orthodontic-rate-' || n,
  jsonb_build_object('source', case when n % 2 = 0 then 'appointment_confirmation' else 'deposit_confirmation' end)
from generate_series(1, 10) n;
select set_config('app.whatsapp_policy_seed_bypass', 'off', true);
create function pg_temp.ortho_outbound(p_source text) returns void language sql as $$
  insert into public.messages (conversation_id, contact_id, direction, type, body, status, idempotency_key, metadata)
  values ('92800000-0000-4000-8000-000000000021', '92800000-0000-4000-8000-000000000011',
    'outbound', 'text', 'Synthetic quota check', 'pending', 'orthodontic-rate-check-' || p_source,
    jsonb_build_object('source', p_source));
$$;
select throws_ok($$select pg_temp.ortho_outbound('appointment_confirmation')$$,
  'P0001', 'POLICY_AUTOMATION_RATE_LIMIT', 'appointment confirmations cannot reset the automated-message quota');
select throws_ok($$select pg_temp.ortho_outbound('automation')$$,
  'P0001', 'POLICY_AUTOMATION_RATE_LIMIT', 'generic automation counts earlier confirmation messages too');
select throws_ok($$select pg_temp.ortho_outbound('deposit_confirmation')$$,
  'P0001', 'POLICY_AUTOMATION_RATE_LIMIT', 'deposit confirmations share the same automated-message quota');

select public.update_appointment_status((select id from ortho_bookings where key = 'private'), 'cancelled');
select ok((select status = 'cancelled' and deposit_status = 'not_required'
  and orthodontic_visit_type = 'in_treatment' from public.appointments
  where id = (select id from ortho_bookings where key = 'private')),
  'a treatment appointment can still be cancelled without a deposit transition');
select public.update_appointment_status((select id from ortho_bookings where key = 'wa'), 'completed');
select ok((select status = 'completed' and deposit_status = 'not_required'
  and orthodontic_visit_type = 'in_treatment' from public.appointments
  where id = (select id from ortho_bookings where key = 'wa')),
  'a treatment appointment can still be completed without a deposit transition');

select * from finish();
rollback;
