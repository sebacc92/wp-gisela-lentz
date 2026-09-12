\set ON_ERROR_STOP on

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(27);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

update public.app_settings
set automations_enabled = true, minimum_booking_notice_minutes = 0,
    appointment_buffer_minutes = 0, deposit_enabled = true,
    deposit_amount_ars = 12345, deposit_alias = 'dependent.test.alias',
    deposit_holder = 'Dependent Test Holder', booking_hold_minutes = 60,
    ioma_duration_minutes = 30, private_duration_minutes = 60
where id;
\ir _support/calendar-ready.inc

insert into public.professionals (id, name, appointment_duration_minutes, active)
values ('93100000-0000-4000-8000-000000000001', 'Dependent Test', 30, true);
insert into public.availability_rules (professional_id, weekday, start_time, end_time, slot_minutes)
select '93100000-0000-4000-8000-000000000001', day, '07:00', '23:00', 30
from generate_series(0, 6) day;
insert into public.services (id, name, duration_minutes, active, sort_order)
values ('93100000-0000-4000-8000-000000000002', 'Dependent Service Test', 30, true, 9310);
-- Quien escribe se atiende por IOMA; la persona a cargo, Particular.
insert into public.contacts (id, phone_e164, name, coverage, is_existing_patient)
values
  ('93100000-0000-4000-8000-000000000010', '+12025550310', 'Responsable Prueba', 'ioma', true),
  ('93100000-0000-4000-8000-000000000011', '+12025550311', 'Ajeno Prueba', 'particular', false),
  ('93100000-0000-4000-8000-000000000013', '+12025550313', 'Responsable Duplicado Prueba', 'ioma', true);
insert into public.conversations (id, contact_id, automation_mode)
values
  ('93100000-0000-4000-8000-000000000020', '93100000-0000-4000-8000-000000000010', 'auto'),
  ('93100000-0000-4000-8000-000000000021', '93100000-0000-4000-8000-000000000011', 'auto');

create function pg_temp.dep_slot(p_time text, p_day integer default 7)
returns timestamptz language sql stable as $$
  select (current_date + p_day + p_time::time)
    at time zone 'America/Argentina/Buenos_Aires';
$$;
create temporary table dep_bookings (key text primary key, id uuid not null);

select has_column('public', 'contacts', 'responsible_contact_id',
  'a record knows which WhatsApp contact manages it');
select has_column('public', 'appointments', 'patient_contact_id',
  'an appointment keeps who is attended apart from who manages it');

select throws_ok($$insert into public.contacts (name) values ('Sin Identidad Prueba')$$,
  '23514', null, 'a record without WhatsApp identity still needs someone who manages it');
select lives_ok($$insert into public.contacts (id, name, coverage, responsible_contact_id)
  values ('93100000-0000-4000-8000-000000000012', 'Hija Manual Prueba', 'ioma',
    '93100000-0000-4000-8000-000000000010')$$,
  'a managed patient does not need its own WhatsApp');
select throws_ok($$update public.contacts set responsible_contact_id = id
  where id = '93100000-0000-4000-8000-000000000012'$$,
  '23514', null, 'nobody manages their own record');

select ok(
  has_function_privilege('service_role', 'public.create_whatsapp_automation_patient_appointment(uuid,uuid,uuid,jsonb,uuid,uuid,timestamptz,public.orthodontic_visit_type)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.create_whatsapp_automation_patient_appointment(uuid,uuid,uuid,jsonb,uuid,uuid,timestamptz,public.orthodontic_visit_type)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.create_whatsapp_automation_patient_appointment(uuid,uuid,uuid,jsonb,uuid,uuid,timestamptz,public.orthodontic_visit_type)', 'EXECUTE'),
  'only the automation worker books for a managed patient');
select ok(
  not has_function_privilege('service_role', 'public.create_service_appointment_for_patient(uuid,uuid,uuid,uuid,timestamptz,public.appointment_source,text,public.orthodontic_visit_type)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.create_service_appointment_for_patient(uuid,uuid,uuid,uuid,timestamptz,public.appointment_source,text,public.orthodontic_visit_type)', 'EXECUTE'),
  'the shared booking body is not exposed as an API');

-- Primer pedido: una persona nueva, Particular, sin teléfono propio.
insert into public.messages (id, conversation_id, contact_id, direction, type, body, status)
values ('93100000-0000-4000-8000-000000000030', '93100000-0000-4000-8000-000000000020',
  '93100000-0000-4000-8000-000000000010', 'inbound', 'text', 'Test turno para mi hijo', 'read');
select * from public.claim_whatsapp_automation_execution(
  '93100000-0000-4000-8000-000000000030', '{"delivery_mode":"whatsapp"}', 900) \gset first_
select pg_temp.calendar_ready();
select public.create_whatsapp_automation_patient_appointment(
  '93100000-0000-4000-8000-000000000030', :'first_lease_token',
  '93100000-0000-4000-8000-000000000010',
  '{"name":"Juan Prueba Dependiente","is_existing_patient":false,"coverage":"particular"}',
  '93100000-0000-4000-8000-000000000001', '93100000-0000-4000-8000-000000000002',
  pg_temp.dep_slot('08:00')
) as result \gset first_created_
insert into dep_bookings values ('first', (:'first_created_result'::jsonb ->> 'id')::uuid);

select ok((select appointment.contact_id = '93100000-0000-4000-8000-000000000010'
    and patient.responsible_contact_id = '93100000-0000-4000-8000-000000000010'
    and patient.name = 'Juan Prueba Dependiente'
    and patient.phone_e164 is null and patient.whatsapp_user_id is null
    and patient.alternate_phone_e164 is null and patient.is_existing_patient = false
  from public.appointments appointment
  join public.contacts patient on patient.id = appointment.patient_contact_id
  where appointment.id = (select id from dep_bookings where key = 'first')),
  'the appointment stays with the WhatsApp contact and points to a new managed record');
select ok((select coverage = 'particular' and duration_minutes = 60
    and status = 'scheduled' and deposit_status = 'pending' and source = 'whatsapp'
    and deposit_expected_amount_ars = 12345
  from public.appointments where id = (select id from dep_bookings where key = 'first')),
  'duration and coverage come from the patient; the deposit policy is unchanged');
select is((select coverage::text from public.contacts
  where id = '93100000-0000-4000-8000-000000000010'),
  'ioma', 'booking for someone else never edits the record of whoever writes');
select is(public.create_whatsapp_automation_patient_appointment(
  '93100000-0000-4000-8000-000000000030', :'first_lease_token',
  '93100000-0000-4000-8000-000000000010',
  '{"name":"Juan Prueba Dependiente","is_existing_patient":false,"coverage":"particular"}',
  '93100000-0000-4000-8000-000000000001', '93100000-0000-4000-8000-000000000002',
  pg_temp.dep_slot('08:00')) ->> 'id',
  :'first_created_result'::jsonb ->> 'id', 'an identical retry returns the same reservation');
select throws_ok(format($sql$select public.create_whatsapp_automation_patient_appointment(
  '93100000-0000-4000-8000-000000000030', %L,
  '93100000-0000-4000-8000-000000000010',
  '{"name":"Otra Persona Prueba","is_existing_patient":false,"coverage":"particular"}',
  '93100000-0000-4000-8000-000000000001', '93100000-0000-4000-8000-000000000002',
  pg_temp.dep_slot('08:00'))$sql$, :'first_lease_token'),
  '23514', 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT', 'a retry cannot switch to a different person');
select is((select count(*)::integer from public.contacts
  where responsible_contact_id = '93100000-0000-4000-8000-000000000010'
    and name ilike 'juan%prueba%dependiente'), 1, 'retries do not duplicate the managed record');

select public.reschedule_whatsapp_automation_appointment(
  '93100000-0000-4000-8000-000000000030', :'first_lease_token',
  (select id from dep_bookings where key = 'first'), pg_temp.dep_slot('08:00', 8)) as result \gset first_moved_
select ok(:'first_moved_result'::jsonb ->> 'coverage' = 'particular'
  and (:'first_moved_result'::jsonb ->> 'duration_minutes')::integer = 60,
  'rescheduling keeps the coverage of whoever is attended');
-- Una conversación procesa un mensaje por vez: se cierra antes del siguiente.
select public.complete_whatsapp_automation_execution(
  '93100000-0000-4000-8000-000000000030', :'first_lease_token',
  '{"processed":true}'::jsonb);

-- Segundo pedido para la misma persona escrita distinto: reutiliza su ficha.
insert into public.messages (id, conversation_id, contact_id, direction, type, body, status)
values ('93100000-0000-4000-8000-000000000031', '93100000-0000-4000-8000-000000000020',
  '93100000-0000-4000-8000-000000000010', 'inbound', 'text', 'Test otro turno', 'read');
select * from public.claim_whatsapp_automation_execution(
  '93100000-0000-4000-8000-000000000031', '{"delivery_mode":"whatsapp"}', 900) \gset second_
select pg_temp.calendar_ready();
select public.create_whatsapp_automation_patient_appointment(
  '93100000-0000-4000-8000-000000000031', :'second_lease_token',
  '93100000-0000-4000-8000-000000000010',
  '{"name":"juan  prueba DEPENDIENTE","is_existing_patient":true,"coverage":"ioma","alternate_phone_e164":"+12025550399"}',
  '93100000-0000-4000-8000-000000000001', '93100000-0000-4000-8000-000000000002',
  pg_temp.dep_slot('10:00')
) as result \gset second_created_
insert into dep_bookings values ('second', (:'second_created_result'::jsonb ->> 'id')::uuid);

select is((select count(*)::integer from public.contacts
  where responsible_contact_id = '93100000-0000-4000-8000-000000000010'
    and name ilike 'juan%prueba%dependiente'), 1,
  'the same person asked for again by the same WhatsApp keeps a single record');
select ok((select second.patient_contact_id = first.patient_contact_id
    and patient.coverage = 'ioma' and patient.is_existing_patient
    and patient.alternate_phone_e164 = '+12025550399'
    and patient.name = 'Juan Prueba Dependiente'
    and second.duration_minutes = 30
  from public.appointments second
  join public.appointments first on first.id = (select id from dep_bookings where key = 'first')
  join public.contacts patient on patient.id = second.patient_contact_id
  where second.id = (select id from dep_bookings where key = 'second')),
  'the reused record takes the latest answers and keeps its original name');
select public.complete_whatsapp_automation_execution(
  '93100000-0000-4000-8000-000000000031', :'second_lease_token',
  '{"processed":true}'::jsonb);

-- Una ficha a cargo se elige por id; una ajena o un contacto distinto no.
insert into public.messages (id, conversation_id, contact_id, direction, type, body, status)
values ('93100000-0000-4000-8000-000000000032', '93100000-0000-4000-8000-000000000020',
  '93100000-0000-4000-8000-000000000010', 'inbound', 'text', 'Test turno para mi hija', 'read');
select * from public.claim_whatsapp_automation_execution(
  '93100000-0000-4000-8000-000000000032', '{"delivery_mode":"whatsapp"}', 900) \gset third_
select pg_temp.calendar_ready();
select throws_ok(format($sql$select public.create_whatsapp_automation_patient_appointment(
  '93100000-0000-4000-8000-000000000032', %L,
  '93100000-0000-4000-8000-000000000010',
  '{"contact_id":"93100000-0000-4000-8000-000000000011"}',
  '93100000-0000-4000-8000-000000000001', '93100000-0000-4000-8000-000000000002',
  pg_temp.dep_slot('12:00'))$sql$, :'third_lease_token'),
  '23514', 'WHATSAPP_AUTOMATION_PATIENT_NOT_MANAGED',
  'a WhatsApp contact cannot book on a record it does not manage');
select throws_ok(format($sql$select public.create_whatsapp_automation_patient_appointment(
  '93100000-0000-4000-8000-000000000032', %L,
  '93100000-0000-4000-8000-000000000011',
  '{"contact_id":"93100000-0000-4000-8000-000000000012"}',
  '93100000-0000-4000-8000-000000000001', '93100000-0000-4000-8000-000000000002',
  pg_temp.dep_slot('12:00'))$sql$, :'third_lease_token'),
  '23514', 'WHATSAPP_AUTOMATION_CONTACT_MISMATCH',
  'the caller cannot claim another conversation contact');
select throws_ok(format($sql$select public.create_whatsapp_automation_patient_appointment(
  '93100000-0000-4000-8000-000000000032', %L,
  '93100000-0000-4000-8000-000000000010',
  '{"name":"Sin Cobertura Prueba","is_existing_patient":false}',
  '93100000-0000-4000-8000-000000000001', '93100000-0000-4000-8000-000000000002',
  pg_temp.dep_slot('12:00'))$sql$, :'third_lease_token'),
  '22023', 'WHATSAPP_AUTOMATION_PATIENT_INVALID',
  'a new person needs the same complete data as a self booking');
select public.create_whatsapp_automation_patient_appointment(
  '93100000-0000-4000-8000-000000000032', :'third_lease_token',
  '93100000-0000-4000-8000-000000000010',
  '{"contact_id":"93100000-0000-4000-8000-000000000012"}',
  '93100000-0000-4000-8000-000000000001', '93100000-0000-4000-8000-000000000002',
  pg_temp.dep_slot('12:00')
) as result \gset third_created_
insert into dep_bookings values ('third', (:'third_created_result'::jsonb ->> 'id')::uuid);
select ok((select patient_contact_id = '93100000-0000-4000-8000-000000000012'
    and coverage = 'ioma' and duration_minutes = 30
  from public.appointments where id = (select id from dep_bookings where key = 'third')),
  'an existing managed record books with its own saved coverage');
select public.complete_whatsapp_automation_execution(
  '93100000-0000-4000-8000-000000000032', :'third_lease_token',
  '{"processed":true}'::jsonb);

-- Si el teléfono es el mismo WhatsApp, no se copia en la ficha nueva.
insert into public.messages (id, conversation_id, contact_id, direction, type, body, status)
values ('93100000-0000-4000-8000-000000000033', '93100000-0000-4000-8000-000000000020',
  '93100000-0000-4000-8000-000000000010', 'inbound', 'text', 'Test turno para mi mamá', 'read');
select * from public.claim_whatsapp_automation_execution(
  '93100000-0000-4000-8000-000000000033', '{"delivery_mode":"whatsapp"}', 900) \gset fourth_
select pg_temp.calendar_ready();
select public.create_whatsapp_automation_patient_appointment(
  '93100000-0000-4000-8000-000000000033', :'fourth_lease_token',
  '93100000-0000-4000-8000-000000000010',
  '{"name":"Maria Prueba Tercera","is_existing_patient":false,"coverage":"ioma","alternate_phone_e164":"+12025550310"}',
  '93100000-0000-4000-8000-000000000001', '93100000-0000-4000-8000-000000000002',
  pg_temp.dep_slot('14:00')
) as result \gset fourth_created_
select ok((select alternate_phone_e164 is null and phone_e164 is null
  from public.contacts where name = 'Maria Prueba Tercera'),
  'the WhatsApp of whoever writes is not duplicated into the managed record');
select public.complete_whatsapp_automation_execution(
  '93100000-0000-4000-8000-000000000033', :'fourth_lease_token',
  '{"processed":true}'::jsonb);

-- Un horario ocupado no deja una ficha huérfana.
insert into public.messages (id, conversation_id, contact_id, direction, type, body, status)
values ('93100000-0000-4000-8000-000000000034', '93100000-0000-4000-8000-000000000020',
  '93100000-0000-4000-8000-000000000010', 'inbound', 'text', 'Test turno ocupado', 'read');
select * from public.claim_whatsapp_automation_execution(
  '93100000-0000-4000-8000-000000000034', '{"delivery_mode":"whatsapp"}', 900) \gset fifth_
select pg_temp.calendar_ready();
select is(public.create_whatsapp_automation_patient_appointment(
  '93100000-0000-4000-8000-000000000034', :'fifth_lease_token',
  '93100000-0000-4000-8000-000000000010',
  '{"name":"Nadie Prueba Ocupado","is_existing_patient":false,"coverage":"particular"}',
  '93100000-0000-4000-8000-000000000001', '93100000-0000-4000-8000-000000000002',
  pg_temp.dep_slot('10:00')) ->> 'error_code',
  'SLOT_UNAVAILABLE', 'an occupied slot is rejected like any other booking');
select ok(not exists (select 1 from public.contacts where name = 'Nadie Prueba Ocupado'),
  'a rejected booking rolls back the new managed record');

select ok((select patient_contact_id is null and coverage = 'particular'
  from public.create_service_appointment(
    '93100000-0000-4000-8000-000000000011', '93100000-0000-4000-8000-000000000001',
    '93100000-0000-4000-8000-000000000002', pg_temp.dep_slot('16:00'))),
  'the public booking RPC keeps booking for the contact itself');

-- Fusiones: las personas a cargo y los turnos siguen a la ficha principal.
insert into public.contacts (id, name, coverage, responsible_contact_id)
values ('93100000-0000-4000-8000-000000000014', 'Hijo Duplicado Prueba', 'particular',
  '93100000-0000-4000-8000-000000000013');
insert into dep_bookings
select 'duplicate', id from public.create_service_appointment_for_patient(
  '93100000-0000-4000-8000-000000000013', '93100000-0000-4000-8000-000000000014',
  '93100000-0000-4000-8000-000000000001', '93100000-0000-4000-8000-000000000002',
  pg_temp.dep_slot('18:00'), 'manual', null, null);

insert into auth.users (id, email, encrypted_password, aud, role)
values ('93100000-0000-4000-8000-000000000040', 'dependent-admin@example.test', '', 'authenticated', 'authenticated');
update public.profiles set role = 'ADMIN', active = true where id = '93100000-0000-4000-8000-000000000040';
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"93100000-0000-4000-8000-000000000040"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select public.merge_patient_records(
  '93100000-0000-4000-8000-000000000010', '93100000-0000-4000-8000-000000000013');
select is((select responsible_contact_id from public.contacts
  where id = '93100000-0000-4000-8000-000000000014'),
  '93100000-0000-4000-8000-000000000010'::uuid,
  'people managed by a duplicate move to the primary record');
select ok((select contact_id = '93100000-0000-4000-8000-000000000010'
    and patient_contact_id = '93100000-0000-4000-8000-000000000014'
  from public.appointments where id = (select id from dep_bookings where key = 'duplicate')),
  'a merged manager keeps the appointment of the person attended');

select public.merge_patient_records(
  '93100000-0000-4000-8000-000000000010', '93100000-0000-4000-8000-000000000012');
select ok((select contact_id = '93100000-0000-4000-8000-000000000010'
    and patient_contact_id is null
  from public.appointments where id = (select id from dep_bookings where key = 'third')),
  'merging the attended person into the manager leaves a regular own appointment');

select * from finish();
rollback;
