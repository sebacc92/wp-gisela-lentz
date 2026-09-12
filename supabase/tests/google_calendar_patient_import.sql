\set ON_ERROR_STOP on
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
update public.app_settings set appointment_buffer_minutes = 0,
  deposit_enabled = true, minimum_booking_notice_minutes = 1440,
  private_duration_minutes = 60, ioma_duration_minutes = 30 where id;
\ir _support/calendar-ready.inc

insert into auth.users (id, email, encrypted_password, aud, role)
values ('92900000-0000-4000-8000-000000000001', 'calendar-import-admin@example.test', '', 'authenticated', 'authenticated');
update public.profiles set role = 'ADMIN', active = true where id = '92900000-0000-4000-8000-000000000001';
insert into public.professionals (id, name, appointment_duration_minutes, active)
values ('92900000-0000-4000-8000-000000000002', 'Calendar Import Test', 30, true);
-- No availability rules: importing a committed Google appointment is not a
-- request for an offered slot. In particular it keeps Gisela's exact range.
insert into public.services (id, name, duration_minutes, active)
values ('92900000-0000-4000-8000-000000000003', 'Import Consulta Test', 30, true);
insert into public.contacts (id, name, phone_e164, coverage, is_existing_patient)
values
  ('92900000-0000-4000-8000-000000000010', 'Matías Icardo', '+5492234541374', 'ioma', false),
  ('92900000-0000-4000-8000-000000000011', 'Paciente Incompleto', '+5492234000011', null, null),
  ('92900000-0000-4000-8000-000000000012', 'Madre Familia', '+5492234000012', 'particular', true);

create function pg_temp.import_slot(p_day integer, p_time text default '20:00')
returns timestamptz language sql stable as $$
  select (current_date + p_day + p_time::time) at time zone 'America/Argentina/Buenos_Aires';
$$;
create function pg_temp.import_event(p_event text, p_day integer, p_minutes integer default 45)
returns void language sql as $$
  insert into public.google_calendar_external_events (
    google_calendar_id, google_event_id, connection_generation, kind, status,
    summary, starts_at, ends_at, content_hash
  ) values ('synthetic-domain-test-calendar', p_event, 9900, 'block', 'active',
    p_event, pg_temp.import_slot(p_day), pg_temp.import_slot(p_day) + make_interval(mins => p_minutes), md5(p_event));
$$;
create function pg_temp.import_auto(
  p_event text, p_contact uuid default null, p_name text default 'Paciente Nuevo',
  p_phone text default '+5492234000020', p_coverage public.patient_coverage default 'particular',
  p_existing boolean default false, p_generation bigint default 9900,
  p_calendar text default 'synthetic-domain-test-calendar',
  p_epoch uuid default '99ca1000-0000-4000-8000-000000000001',
  p_summary text default null, p_end timestamptz default null
) returns table (appointment_id uuid, created boolean) language sql as $$
  select result.* from public.google_calendar_external_events event
  cross join lateral public.import_google_calendar_patient_appointment(
    p_event, p_contact, p_name, p_phone, p_coverage,
    '92900000-0000-4000-8000-000000000002', '92900000-0000-4000-8000-000000000003',
    event.starts_at, 'Test imported booking', null, p_existing, p_generation,
    p_calendar, p_epoch, coalesce(p_summary, event.summary), coalesce(p_end, event.ends_at)
  ) result where event.google_calendar_id = 'synthetic-domain-test-calendar' and event.google_event_id = p_event;
$$;
create function pg_temp.import_admin()
returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"authenticated","sub":"92900000-0000-4000-8000-000000000001"}', true);
  select set_config('request.jwt.claim.role', 'authenticated', true);
  select set_config('request.jwt.claim.sub', '92900000-0000-4000-8000-000000000001', true);
$$;
create function pg_temp.import_service()
returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select set_config('request.jwt.claim.role', 'service_role', true);
  select set_config('request.jwt.claim.sub', '', true);
$$;
create temporary table imported_bookings (key text primary key, id uuid not null);

select ok(not has_function_privilege('authenticated',
  'public.import_google_calendar_patient_appointment(text,uuid,text,text,patient_coverage,uuid,uuid,timestamptz,text,orthodontic_visit_type,boolean,bigint,text,uuid,text,timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role',
  'public.import_google_calendar_patient_appointment(text,uuid,text,text,patient_coverage,uuid,uuid,timestamptz,text,orthodontic_visit_type,boolean,bigint,text,uuid,text,timestamptz)', 'EXECUTE'),
  'only service_role may invoke automatic import');
select ok(not has_function_privilege('anon',
  'public.convert_google_calendar_block_with_patient(text,uuid,text,text,patient_coverage,uuid,uuid,timestamptz,text,orthodontic_visit_type,boolean)', 'EXECUTE')
  and has_function_privilege('authenticated',
  'public.convert_google_calendar_block_with_patient(text,uuid,text,text,patient_coverage,uuid,uuid,timestamptz,text,orthodontic_visit_type,boolean)', 'EXECUTE'),
  'browser import has an authenticated entrypoint, not anonymous access');
select ok(not has_function_privilege('service_role',
  'public.convert_google_calendar_patient_import(text,uuid,text,text,patient_coverage,uuid,uuid,timestamptz,text,orthodontic_visit_type,boolean,boolean,bigint,text,uuid,text,timestamptz)', 'EXECUTE'),
  'even service_role cannot bypass wrapper validation through the private core');
select is(public.google_calendar_patient_name_key('Icardo Matias'), public.google_calendar_patient_name_key('Matías Icardo'),
  'name matching ignores accents and complete word order');

select pg_temp.import_event('new-patient', 2);
insert into imported_bookings select 'new', appointment_id from pg_temp.import_auto('new-patient');
select ok((select status = 'confirmed' and deposit_status = 'not_required'
  and hold_expires_at is null and deposit_confirmed_at is null
  and deposit_expected_amount_ars is null and hold_expired_notification_status = 'not_applicable'
  and duration_minutes = 45 and google_calendar_imported and created_by is null
  from public.appointments where id = (select id from imported_bookings where key = 'new')),
  'Google booking is confirmed for its original 45 minutes with no invented deposit or actor');
select ok((select count(*) = 1 from public.contacts where phone_e164 = '+5492234000020'),
  'a new patient is created atomically');
select ok((select not created and appointment_id = (select id from imported_bookings where key = 'new')
  from pg_temp.import_auto('new-patient')), 'automatic replay returns the same booking without duplication');
select ok(not exists(select 1 from public.google_calendar_sync_jobs where appointment_id = (select id from imported_bookings where key = 'new')),
  'readonly import cannot enqueue a second remote event');
select is(public.appointment_google_calendar_projection((select id from imported_bookings where key = 'new')) ->> 'state', 'synced',
  'fresh exact linked Google source satisfies projection truthfully');
select ok((select status = 'converted' and external_cleanup_status = 'pending' and removed_at is null
  from public.google_calendar_external_events where google_event_id = 'new-patient'),
  'the linked original remains occupied under the existing readonly source contract');

select pg_temp.import_event('existing-patient', 3, 75);
insert into imported_bookings select 'existing', appointment_id from pg_temp.import_auto('existing-patient',
  '92900000-0000-4000-8000-000000000010', 'Icardo Matias', null, 'particular', true);
select ok((select coverage = 'particular' and duration_minutes = 75 from public.appointments
  where id = (select id from imported_bookings where key = 'existing')),
  'explicit event coverage and duration are appointment snapshots');
select ok((select coverage = 'ioma' and is_existing_patient = false from public.contacts
  where id = '92900000-0000-4000-8000-000000000010'), 'existing known patient details are not overwritten');
select pg_temp.import_event('incomplete-patient', 4);
select * from pg_temp.import_auto('incomplete-patient', '92900000-0000-4000-8000-000000000011',
  'Incompleto Paciente', '+5492234000011', 'particular', true);
select ok((select coverage = 'particular' and is_existing_patient = true from public.contacts
  where id = '92900000-0000-4000-8000-000000000011'), 'only absent patient coverage and history are filled');

-- La agenda de Gisela casi nunca escribe el celular en el título: el nombre
-- completo alcanza para crear la ficha, y el mismo nombre repetido no.
select pg_temp.import_event('agenda-sin-telefono', 6);
insert into imported_bookings select 'sin-telefono', appointment_id
from pg_temp.import_auto('agenda-sin-telefono', null, 'Silvina Llona', null, 'ioma', true);
select ok((select count(*) = 1 from public.contacts
  where name = 'Silvina Llona' and phone_e164 is null
    and coverage = 'ioma' and is_existing_patient),
  'a title without a phone still creates the agenda patient');
select ok((select appointment.google_calendar_imported
    and contact.name = 'Silvina Llona'
  from public.appointments appointment
  join public.contacts contact on contact.id = appointment.contact_id
  where appointment.id = (select id from imported_bookings where key = 'sin-telefono')),
  'the imported turno belongs to that patient');

select pg_temp.import_event('validation', 5);
select throws_ok($$select pg_temp.import_auto('validation', null, null)$$,
  'P0001', 'PATIENT_NAME_REQUIRED', 'new patient requires a name');
select throws_ok($$select pg_temp.import_auto('validation', null, 'Silvina Llona', null)$$,
  '23514', 'CONTACT_IDENTITY_CONFLICT',
  'a second patient with the same name still requires human review');
select throws_ok($$select pg_temp.import_auto('validation', null, 'Otra Persona', '223123')$$,
  'P0001', 'PATIENT_PHONE_INVALID', 'new phone must already be normalized E164');
select throws_ok($$select pg_temp.import_auto('validation', null, 'Hijo Familia', '+5492234000012')$$,
  '23514', 'CONTACT_IDENTITY_CONFLICT', 'a family number cannot merge a different patient');
select throws_ok($$select pg_temp.import_auto('validation', null, 'Icardo Matias', '+5492234000099')$$,
  '23514', 'CONTACT_IDENTITY_CONFLICT', 'creating another exact-name patient with a different phone requires human review');
select throws_ok($$select pg_temp.import_auto('validation', '92900000-0000-4000-8000-000000000010', 'Madre Familia', null)$$,
  '23514', 'CONTACT_IDENTITY_CONFLICT', 'service matching cannot substitute an unrelated contact id');
select throws_ok($$select pg_temp.import_auto('validation', '92900000-0000-4000-8000-000000000099', 'Missing Patient', null)$$,
  'P0002', 'CONTACT_NOT_FOUND', 'missing contact is explicit');
select throws_ok($$select pg_temp.import_auto('validation', null, 'Paciente Scope', '+5492234000030', 'particular', false, 9899)$$,
  '55000', 'GOOGLE_CALENDAR_IMPORT_SCOPE_STALE', 'old connection generation cannot import');
select throws_ok($$select pg_temp.import_auto('validation', null, 'Paciente Scope', '+5492234000030', 'particular', false, 9900, 'other-calendar')$$,
  '55000', 'GOOGLE_CALENDAR_IMPORT_SCOPE_STALE', 'another calendar scope cannot import');
select throws_ok($$select pg_temp.import_auto('validation', null, 'Paciente Scope', '+5492234000030', 'particular', false, 9900, 'synthetic-domain-test-calendar', '99ca1000-0000-4000-8000-000000000099')$$,
  '55000', 'GOOGLE_CALENDAR_IMPORT_SCOPE_STALE', 'revoked automation epoch cannot import');
select throws_ok($$select pg_temp.import_auto('validation', null, 'Paciente Scope', '+5492234000030', 'particular', false, 9900, 'synthetic-domain-test-calendar', '99ca1000-0000-4000-8000-000000000001', 'changed-title')$$,
  '55000', 'CALENDAR_BLOCK_STALE', 'title race invalidates parsed identity');
select throws_ok($$select pg_temp.import_auto('validation', null, 'Paciente Scope', '+5492234000030', 'particular', false, 9900, 'synthetic-domain-test-calendar', '99ca1000-0000-4000-8000-000000000001', null, pg_temp.import_slot(5, '21:00'))$$,
  '55000', 'CALENDAR_BLOCK_STALE', 'changed Google end cannot silently overwrite the observed range');
update public.google_calendar_external_events set recurring = true where google_event_id = 'validation';
select throws_ok($$select pg_temp.import_auto('validation')$$, 'P0001', 'CALENDAR_BLOCK_UNSUPPORTED', 'recurring events require review');
update public.google_calendar_external_events set recurring = false, all_day = true where google_event_id = 'validation';
select throws_ok($$select pg_temp.import_auto('validation')$$, 'P0001', 'CALENDAR_BLOCK_UNSUPPORTED', 'all-day events require review');
update public.google_calendar_external_events set all_day = false where google_event_id = 'validation';

select pg_temp.import_event('collision', 6);
select pg_temp.import_event('other-occupancy', 6);
select throws_ok($$select pg_temp.import_auto('collision', null, 'Paciente Rollback', '+5492234000040')$$,
  'P0001', 'SLOT_UNAVAILABLE', 'another Google event prevents committing an import');
select ok(not exists(select 1 from public.contacts where phone_e164 = '+5492234000040')
  and (select status = 'active' and converted_appointment_id is null from public.google_calendar_external_events where google_event_id = 'collision'),
  'late collision rolls back patient, booking and original occupancy atomically');
select pg_temp.import_event('stale-observation', 7);
update public.google_calendar_connections set last_sync_completed_at = clock_timestamp() - interval '10 minutes' where id;
select throws_ok($$select pg_temp.import_auto('stale-observation', null, 'Paciente Stale', '+5492234000041')$$,
  'P0001', 'SLOT_UNAVAILABLE', 'stale observation cannot authorize import');
select ok(not exists(select 1 from public.contacts where phone_e164 = '+5492234000041'), 'stale observation leaves no orphan patient');
select pg_temp.calendar_ready();
select pg_temp.import_event('past-event', -1);
select throws_ok($$select pg_temp.import_auto('past-event', null, 'Paciente Pasado', '+5492234000042')$$,
  'P0001', 'CALENDAR_BLOCK_IN_PAST', 'past events are not automatically imported');
select pg_temp.import_event('outside-snapshot', 30);
select throws_ok($$select pg_temp.import_auto('outside-snapshot', null, 'Paciente Futuro', '+5492234000043')$$,
  'P0001', 'SLOT_UNAVAILABLE', 'events outside the complete inbound window cannot import');

select pg_temp.import_admin();
select throws_ok($$select pg_temp.import_auto('validation')$$, '42501', 'UNAUTHORIZED', 'an admin JWT cannot impersonate the import worker');
select pg_temp.import_event('manual-new', 8);
insert into imported_bookings select 'manual', appointment_id from public.convert_google_calendar_block_with_patient(
  'manual-new', null, 'Manual Nuevo', '+5492234000050', 'particular',
  '92900000-0000-4000-8000-000000000002', '92900000-0000-4000-8000-000000000003',
  pg_temp.import_slot(8), null, null, false);
select ok((select created_by = '92900000-0000-4000-8000-000000000001' and status = 'confirmed'
  from public.appointments where id = (select id from imported_bookings where key = 'manual')),
  'manual new-patient conversion attributes only the real admin');
select pg_temp.import_event('legacy-conversion', 9);
select lives_ok($$select * from public.convert_google_calendar_block_to_appointment(
  'legacy-conversion', '92900000-0000-4000-8000-000000000010',
  '92900000-0000-4000-8000-000000000002', '92900000-0000-4000-8000-000000000003', pg_temp.import_slot(9))$$,
  'legacy conversion also uses committed readonly import semantics');
select throws_ok($$update public.appointments set starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour'
  where id = (select id from imported_bookings where key = 'new')$$,
  '55000', 'CALENDAR_IMPORTED_APPOINTMENT_READ_ONLY', 'local moves cannot leave the original Google appointment behind');
select throws_ok($$select public.update_appointment_status((select id from imported_bookings where key = 'new'), 'cancelled')$$,
  '55000', 'CALENDAR_IMPORTED_APPOINTMENT_READ_ONLY', 'local cancellation cannot falsely free an existing Google appointment');

-- Observe through the real inbound RPC and lease, without any network calls.
select pg_temp.import_service();
select * from public.begin_google_calendar_inbound_sync(9900, 120, 2,
  pg_temp.import_slot(0, '00:00'), pg_temp.import_slot(21, '00:00')) \gset observation_
select is(public.apply_google_calendar_external_event(9900, :'observation_lease_token', 'new-patient',
  'block', false, 'new-patient', pg_temp.import_slot(10), pg_temp.import_slot(10) + interval '75 minutes',
  false, false, null, '"moved"', clock_timestamp()), 'conflict_recorded', 'Google move of linked event opens a review instead of being skipped');
select ok((select starts_at = pg_temp.import_slot(2) from public.appointments where id = (select id from imported_bookings where key = 'new'))
  and (select starts_at = pg_temp.import_slot(10) from public.google_calendar_external_events where google_event_id = 'new-patient'),
  'old appointment and newly observed Google occupancy remain distinct pending review');
select pg_temp.calendar_ready();
select pg_temp.import_admin();
select lives_ok($$select public.apply_google_calendar_conflict((select id from public.google_calendar_sync_conflicts
  where appointment_id = (select id from imported_bookings where key = 'new') and status = 'pending'))$$,
  'admin can accept the exact observed Google move through review');
select ok((select starts_at = pg_temp.import_slot(10) and duration_minutes = 75 and deposit_status = 'not_required'
  from public.appointments where id = (select id from imported_bookings where key = 'new')),
  'accepted remote move retains its exact duration and no-deposit policy');
select pg_temp.import_service();
select * from public.begin_google_calendar_inbound_sync(9900, 120, 2,
  pg_temp.import_slot(0, '00:00'), pg_temp.import_slot(21, '00:00')) \gset deletion_
select is(public.apply_google_calendar_external_event(9900, :'deletion_lease_token', 'new-patient',
  'block', true, null, null, null, false, false, null, '"deleted"', clock_timestamp()),
  'conflict_recorded', 'Google removal becomes explicit cancellation review');
select pg_temp.calendar_ready();
select pg_temp.import_admin();
select lives_ok($$select public.apply_google_calendar_conflict((select id from public.google_calendar_sync_conflicts
  where appointment_id = (select id from imported_bookings where key = 'new') and status = 'pending'))$$,
  'admin can accept observed source removal without a remote write');
select ok((select status = 'cancelled' from public.appointments where id = (select id from imported_bookings where key = 'new'))
  and not exists(select 1 from public.google_calendar_sync_jobs where appointment_id = (select id from imported_bookings where key = 'new')),
  'remote removal review cancels locally without exporting or deleting any Google event');
select ok(not exists(select 1 from public.messages where contact_id in (select contact_id from public.appointments
  where id in (select id from imported_bookings))), 'import and reviews do not send WhatsApp messages');

select pg_temp.import_service();
select * from public.begin_google_calendar_inbound_sync(9900, 120, 2,
  pg_temp.import_slot(0, '00:00'), pg_temp.import_slot(21, '00:00')) \gset metadata_
select is(public.apply_google_calendar_external_event(9900, :'metadata_lease_token', 'existing-patient',
  'block', false, 'Different Patient TF particular', pg_temp.import_slot(3), pg_temp.import_slot(3) + interval '75 minutes',
  false, false, null, '"renamed"', clock_timestamp()), 'conflict_recorded',
  'a changed Google patient title requires review without changing patient identity');
select pg_temp.calendar_ready();
select pg_temp.import_admin();
select is(public.appointment_google_calendar_projection((select id from imported_bookings where key = 'existing')) ->> 'state',
  'conflict', 'a changed title cannot be presented as synchronized');
select throws_ok($$select public.reject_google_calendar_conflict((select id from public.google_calendar_sync_conflicts
  where appointment_id = (select id from imported_bookings where key = 'existing') and status = 'pending'))$$,
  '55000', 'CALENDAR_IMPORTED_APPOINTMENT_READ_ONLY', 'reject cannot pretend to overwrite a read-only Google title');
select throws_ok($$select public.apply_google_calendar_conflict((select id from public.google_calendar_sync_conflicts
  where appointment_id = (select id from imported_bookings where key = 'existing') and status = 'pending'))$$,
  '55000', 'GOOGLE_CALENDAR_METADATA_CONFLICT_REQUIRES_RESTORE', 'accept cannot reassign a patient from a changed title');
select pg_temp.import_service();
select * from public.begin_google_calendar_inbound_sync(9900, 120, 2,
  pg_temp.import_slot(0, '00:00'), pg_temp.import_slot(21, '00:00')) \gset restored_
select is(public.apply_google_calendar_external_event(9900, :'restored_lease_token', 'existing-patient',
  'block', false, 'existing-patient', pg_temp.import_slot(3), pg_temp.import_slot(3) + interval '75 minutes',
  false, false, null, '"restored"', clock_timestamp()), 'unchanged',
  'restoring the source in Google resolves the identity discrepancy');
select pg_temp.calendar_ready();
select is(public.appointment_google_calendar_projection((select id from imported_bookings where key = 'existing')) ->> 'state',
  'synced', 'the restored exact source can again support a synchronized appointment');
select * from public.begin_google_calendar_inbound_sync(9900, 120, 2,
  pg_temp.import_slot(0, '00:00'), pg_temp.import_slot(21, '00:00')) \gset filtered_
select is(public.apply_google_calendar_external_event(9900, :'filtered_lease_token', 'manual-new',
  'block', true, 'manual-new', pg_temp.import_slot(-1), pg_temp.import_slot(-1) + interval '45 minutes',
  false, false, 'PAST_EVENT', '"past"', clock_timestamp()), 'conflict_recorded',
  'moving an imported event into the past records a move, not a deletion');
select ok((select removed_at is null from public.google_calendar_external_events where google_event_id = 'manual-new')
  and (select kind = 'reschedule_requested' from public.google_calendar_sync_conflicts where status = 'pending'
    and appointment_id = (select id from imported_bookings where key = 'manual')),
  'the worker past-event filter cannot authorize cancellation of a live source');
select is(public.apply_google_calendar_external_event(9900, :'filtered_lease_token', 'manual-new',
  'unsupported', true, null, null, null, false, false, 'TRANSPARENT_EVENT', '"transparent"', clock_timestamp()),
  'conflict_recorded', 'a transparent source requires metadata review');
select ok((select removed_at is null from public.google_calendar_external_events where google_event_id = 'manual-new')
  and (select kind = 'metadata_changed' from public.google_calendar_sync_conflicts where status = 'pending'
    and appointment_id = (select id from imported_bookings where key = 'manual')),
  'transparent is not mistaken for a Google deletion tombstone');
select public.apply_google_calendar_external_event(9900, :'filtered_lease_token', 'manual-new',
  'block', false, 'manual-new', pg_temp.import_slot(8), pg_temp.import_slot(8) + interval '45 minutes',
  false, false, null, '"restored-manual"', clock_timestamp());
select pg_temp.calendar_ready();
select * from public.begin_google_calendar_inbound_sync(9900, 120, 2,
  pg_temp.import_slot(0, '00:00'), pg_temp.import_slot(21, '00:00')) \gset window_
select public.reconcile_google_calendar_external_events(9900, :'window_lease_token', array[]::text[]);
select ok((select removed_at is null and status = 'converted' from public.google_calendar_external_events where google_event_id = 'existing-patient')
  and not exists(select 1 from public.google_calendar_sync_conflicts where status = 'pending'
    and appointment_id = (select id from imported_bookings where key = 'existing')),
  'absence from a rolling full window is not evidence of source deletion');
select pg_temp.calendar_ready();
insert into public.appointments (id, contact_id, professional_id, service_id,
  starts_at, ends_at, status, deposit_status, coverage, duration_minutes, hold_expires_at, google_calendar_imported)
values
  ('92900000-0000-4000-8000-000000000080', '92900000-0000-4000-8000-000000000010',
    '92900000-0000-4000-8000-000000000002', '92900000-0000-4000-8000-000000000003',
    pg_temp.import_slot(11), pg_temp.import_slot(11) + interval '30 minutes',
    'scheduled', 'pending', 'ioma', 30, clock_timestamp() - interval '1 hour', true),
  ('92900000-0000-4000-8000-000000000081', '92900000-0000-4000-8000-000000000010',
    '92900000-0000-4000-8000-000000000002', '92900000-0000-4000-8000-000000000003',
    pg_temp.import_slot(12), pg_temp.import_slot(12) + interval '30 minutes',
    'scheduled', 'pending', 'ioma', 30, clock_timestamp() - interval '1 hour', false);
select lives_ok($$select * from public.expire_booking_holds()$$,
  'a historical imported hold cannot abort the general expiry batch');
select ok((select status = 'scheduled' and deposit_status = 'pending' from public.appointments
    where id = '92900000-0000-4000-8000-000000000080')
  and (select status = 'cancelled' and deposit_status = 'expired' from public.appointments
    where id = '92900000-0000-4000-8000-000000000081'),
  'expiry preserves old imported payment evidence while expiring ordinary holds');
select is(public.expire_overlapping_booking_holds('92900000-0000-4000-8000-000000000002',
  pg_temp.import_slot(11), pg_temp.import_slot(11) + interval '30 minutes'), 0::bigint,
  'overlap cleanup also leaves the historical Google booking unchanged');
update public.google_calendar_connections set connection_generation = 9901,
  sync_scope_generation = 9901 where id;
select ok((select connection_generation = 9901 and converted_appointment_id = (select id from imported_bookings where key = 'existing')
  from public.google_calendar_external_events where google_event_id = 'existing-patient'),
  'same-account same-calendar reconnection preserves the source relationship');
select is(public.google_calendar_automation_appointment_stage(
  (select id from imported_bookings where key = 'existing'), null, null, null, null, clock_timestamp()),
  null::text, 'a generation change never turns a readonly import into a managed export');
update public.google_calendar_external_events set connection_generation = 9800 where google_event_id = 'existing-patient';
select is(public.google_calendar_automation_appointment_stage(
  (select id from imported_bookings where key = 'existing'), null, null, null, null, clock_timestamp()),
  null::text, 'permanent source flag prevents export even when an association is out of scope');
select * from finish();
rollback;
