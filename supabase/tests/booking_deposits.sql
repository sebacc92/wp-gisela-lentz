\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(18);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select (
  current_date + 7 + mod(8 - extract(isodow from current_date)::integer, 7)
)::date as test_date
\gset

update public.app_settings
set minimum_booking_notice_minutes = 0,
    appointment_buffer_minutes = 0,
    deposit_enabled = true,
    booking_hold_minutes = 60,
    ioma_duration_minutes = 30,
    private_duration_minutes = 60,
    reminder_24h_enabled = true,
    reminder_2h_enabled = false
where id = true;

-- These domain tests require an authorized, freshly observed Calendar.
\ir _support/calendar-ready.inc

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '95000000-0000-4000-8000-000000000001',
  'deposit-operator@example.test', '', 'authenticated', 'authenticated'
);

insert into public.professionals (
  id, name, specialty, appointment_duration_minutes, active
) values (
  '95000000-0000-4000-8000-000000000002',
  'Gisela Deposit Test', 'Odontología', 45, true
);

insert into public.services (id, name, duration_minutes, active, sort_order)
values (
  '95000000-0000-4000-8000-000000000003',
  'Motivo Deposit Test', 90, true, 9500
);

insert into public.availability_rules (
  professional_id, weekday, start_time, end_time, slot_minutes, active
) values (
  '95000000-0000-4000-8000-000000000002', 1,
  '09:00', '17:00', 30, true
);

insert into public.contacts (
  id, phone_e164, whatsapp_id, name, coverage, is_existing_patient
) values
  (
    '95000000-0000-4000-8000-000000000010', '+5491100009510',
    '5491100009510', 'Paciente IOMA Deposit Test', 'ioma', true
  ),
  (
    '95000000-0000-4000-8000-000000000011', '+5491100009511',
    '5491100009511', 'Paciente Particular Deposit Test', 'particular', false
  ),
  (
    '95000000-0000-4000-8000-000000000012', '+5491100009512',
    '5491100009512', 'Paciente Proof Deposit Test', 'ioma', false
  ),
  (
    '95000000-0000-4000-8000-000000000013', '+5491100009513',
    '5491100009513', 'Paciente Late Deposit Test', 'ioma', false
  ),
  (
    '95000000-0000-4000-8000-000000000014', '+5491100009514',
    '5491100009514', 'Paciente Reschedule Deposit Test', 'ioma', true
  );

insert into public.conversations (id, contact_id)
values
  ('95000000-0000-4000-8000-000000000020', '95000000-0000-4000-8000-000000000012'),
  ('95000000-0000-4000-8000-000000000021', '95000000-0000-4000-8000-000000000013'),
  ('95000000-0000-4000-8000-000000000022', '95000000-0000-4000-8000-000000000011');

select public.record_whatsapp_consent(
  '95000000-0000-4000-8000-000000000012', 'opt_in',
  'appointment_updates', 'operator', 'deposit-test', 'test-policy', null
);

select public.create_service_appointment(
  '95000000-0000-4000-8000-000000000010',
  '95000000-0000-4000-8000-000000000002',
  '95000000-0000-4000-8000-000000000003',
  (:'test_date'::date + time '09:00') at time zone 'America/Argentina/Buenos_Aires',
  'manual', null
);

select ok(
  (
    select coverage = 'ioma'
      and duration_minutes = 30
      and ends_at - starts_at = interval '30 minutes'
      and status = 'scheduled'
      and deposit_status = 'pending'
      and hold_expires_at > clock_timestamp()
    from public.appointments
    where contact_id = '95000000-0000-4000-8000-000000000010'
  ),
  'IOMA creates a 30-minute deposit hold'
);

select ok(
  not exists (
    select 1 from public.get_available_slots_for_coverage(
      '95000000-0000-4000-8000-000000000002', 'particular',
      :'test_date'::date, 'America/Argentina/Buenos_Aires', 100
    ) slot
    where slot.starts_at =
      (:'test_date'::date + time '09:00') at time zone 'America/Argentina/Buenos_Aires'
  ),
  'an active hold blocks the slot'
);

select throws_ok(
  format(
    $$select public.create_service_appointment(
      '95000000-0000-4000-8000-000000000011',
      '95000000-0000-4000-8000-000000000002',
      '95000000-0000-4000-8000-000000000003',
      %L::timestamptz, 'manual', null
    )$$,
    ((:'test_date'::date + time '09:00') at time zone 'America/Argentina/Buenos_Aires')::text
  ),
  'P0001',
  'SLOT_UNAVAILABLE',
  'double booking is rejected while the hold is active'
);

update public.appointments
set hold_expires_at = clock_timestamp() - interval '1 second'
where contact_id = '95000000-0000-4000-8000-000000000010';

select ok(
  exists (
    select 1 from public.get_available_slots_for_coverage(
      '95000000-0000-4000-8000-000000000002', 'particular',
      :'test_date'::date, 'America/Argentina/Buenos_Aires', 100
    ) slot
    where slot.starts_at =
      (:'test_date'::date + time '09:00') at time zone 'America/Argentina/Buenos_Aires'
  ),
  'availability treats an expired hold as free before cleanup cron'
);

select public.create_service_appointment(
  '95000000-0000-4000-8000-000000000011',
  '95000000-0000-4000-8000-000000000002',
  '95000000-0000-4000-8000-000000000003',
  (:'test_date'::date + time '09:00') at time zone 'America/Argentina/Buenos_Aires',
  'manual', null
);

select ok(
  (
    select status = 'cancelled' and deposit_status = 'expired'
    from public.appointments
    where contact_id = '95000000-0000-4000-8000-000000000010'
  )
  and (
    select coverage = 'particular'
      and duration_minutes = 60
      and ends_at - starts_at = interval '60 minutes'
    from public.appointments
    where contact_id = '95000000-0000-4000-8000-000000000011'
  ),
  'creating after expiry cancels the old hold and uses Particular 60 minutes'
);

select public.create_service_appointment(
  '95000000-0000-4000-8000-000000000014',
  '95000000-0000-4000-8000-000000000002',
  '95000000-0000-4000-8000-000000000003',
  (:'test_date'::date + time '14:00') at time zone 'America/Argentina/Buenos_Aires',
  'manual', null
);

update public.contacts
set coverage = 'particular'
where id = '95000000-0000-4000-8000-000000000014';

select public.reschedule_service_appointment(
  (select id from public.appointments
   where contact_id = '95000000-0000-4000-8000-000000000014'),
  (:'test_date'::date + time '15:00') at time zone 'America/Argentina/Buenos_Aires'
);

select ok(
  (
    select coverage = 'particular'
      and duration_minutes = 60
      and ends_at - starts_at = interval '60 minutes'
      and starts_at =
        (:'test_date'::date + time '15:00') at time zone 'America/Argentina/Buenos_Aires'
    from public.appointments
    where contact_id = '95000000-0000-4000-8000-000000000014'
  ),
  'rescheduling refreshes coverage and duration from the current patient profile'
);

select public.create_service_appointment(
  '95000000-0000-4000-8000-000000000012',
  '95000000-0000-4000-8000-000000000002',
  '95000000-0000-4000-8000-000000000003',
  (:'test_date'::date + time '11:00') at time zone 'America/Argentina/Buenos_Aires',
  'whatsapp', null
);

select ok(
  not exists (
    select 1 from public.reminders reminder
    join public.appointments appointment on appointment.id = reminder.appointment_id
    where appointment.contact_id = '95000000-0000-4000-8000-000000000012'
  ),
  'a hold waiting for deposit never schedules reminders'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, created_at
) values (
  '95000000-0000-4000-8000-000000000030',
  '95000000-0000-4000-8000-000000000020',
  '95000000-0000-4000-8000-000000000012',
  'inbound', 'image', 'Comprobante de prueba', 'delivered', clock_timestamp()
);

select * from public.record_deposit_proof(
  '95000000-0000-4000-8000-000000000012',
  '95000000-0000-4000-8000-000000000030',
  clock_timestamp()
);

select ok(
  (
    select deposit_status = 'proof_received'
      and status = 'scheduled'
      and deposit_proof_message_id = '95000000-0000-4000-8000-000000000030'
      and not deposit_proof_late
    from public.appointments
    where contact_id = '95000000-0000-4000-8000-000000000012'
  ),
  'an on-time media message marks proof received without confirming payment'
);

update public.conversations
set current_flow = 'deposit_proof_received'
where contact_id = '95000000-0000-4000-8000-000000000012';

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95000000-0000-4000-8000-000000000001"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select throws_ok(
  format(
    $$select public.update_appointment_status(%L::uuid, 'confirmed')$$,
    (select id from public.appointments
     where contact_id = '95000000-0000-4000-8000-000000000012')::text
  ),
  'P0001',
  'DEPOSIT_CONFIRMATION_REQUIRED',
  'the generic status RPC cannot bypass manual deposit confirmation'
);

set local role authenticated;

update public.app_settings
set deposit_amount_ars = 11000
where id = true;

select is(
  (select deposit_amount_ars from public.app_settings where id = true),
  10000,
  'an operator cannot modify deposit configuration'
);

reset role;

select public.confirm_appointment_deposit(
  (select id from public.appointments
   where contact_id = '95000000-0000-4000-8000-000000000012')
);

select ok(
  (
    select status = 'confirmed'
      and deposit_status = 'confirmed'
      and deposit_confirmed_at is not null
      and deposit_confirmed_by = '95000000-0000-4000-8000-000000000001'
    from public.appointments
    where contact_id = '95000000-0000-4000-8000-000000000012'
  )
  and (
    select automation_mode = 'manual'
      and not needs_human
      and current_flow is null
    from public.conversations
    where contact_id = '95000000-0000-4000-8000-000000000012'
  ),
  'manual confirmation resolves review while keeping the conversation manual'
);

select ok(
  exists (
    select 1 from public.audit_logs
    where action = 'deposit.confirmed'
      and entity_id = (
        select id from public.appointments
        where contact_id = '95000000-0000-4000-8000-000000000012'
      )
      and actor_user_id = '95000000-0000-4000-8000-000000000001'
  ),
  'deposit confirmation records actor and time in the audit log'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select ok(
  exists (
    select 1 from public.reminders reminder
    join public.appointments appointment on appointment.id = reminder.appointment_id
    where appointment.contact_id = '95000000-0000-4000-8000-000000000012'
      and appointment.status = 'confirmed'
  ),
  'only the confirmed appointment receives a reminder'
);

select public.update_appointment_status(
  (select id from public.appointments
   where contact_id = '95000000-0000-4000-8000-000000000012'),
  'cancelled'
);

select throws_ok(
  format(
    $$select public.update_appointment_status(%L::uuid, 'confirmed')$$,
    (select id from public.appointments
     where contact_id = '95000000-0000-4000-8000-000000000012')::text
  ),
  'P0001',
  'DEPOSIT_CONFIRMATION_REQUIRED',
  'a final appointment cannot be revived through the generic status RPC'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, created_at
) values (
  '95000000-0000-4000-8000-000000000032',
  '95000000-0000-4000-8000-000000000021',
  '95000000-0000-4000-8000-000000000013',
  'inbound', 'image', 'Imagen anterior a la reserva', 'delivered',
  clock_timestamp() - interval '2 hours'
);

select public.create_service_appointment(
  '95000000-0000-4000-8000-000000000013',
  '95000000-0000-4000-8000-000000000002',
  '95000000-0000-4000-8000-000000000003',
  (:'test_date'::date + time '12:00') at time zone 'America/Argentina/Buenos_Aires',
  'whatsapp', null
);

select ok(
  not (
    select recognized
    from public.record_deposit_proof(
      '95000000-0000-4000-8000-000000000013',
      '95000000-0000-4000-8000-000000000032',
      clock_timestamp() - interval '2 hours'
    )
  )
  and (
    select deposit_status = 'pending' and deposit_proof_message_id is null
    from public.appointments
    where contact_id = '95000000-0000-4000-8000-000000000013'
  ),
  'media received before the hold was created is not associated as proof'
);

update public.appointments
set hold_expires_at = clock_timestamp() - interval '1 minute'
where contact_id = '95000000-0000-4000-8000-000000000013';

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, created_at
) values (
  '95000000-0000-4000-8000-000000000031',
  '95000000-0000-4000-8000-000000000021',
  '95000000-0000-4000-8000-000000000013',
  'inbound', 'document', 'Comprobante tardío.pdf', 'delivered', clock_timestamp()
);

select * from public.record_deposit_proof(
  '95000000-0000-4000-8000-000000000013',
  '95000000-0000-4000-8000-000000000031',
  clock_timestamp()
);

select ok(
  (
    select status = 'cancelled'
      and deposit_status = 'expired'
      and deposit_proof_late
      and deposit_proof_message_id = '95000000-0000-4000-8000-000000000031'
    from public.appointments
    where contact_id = '95000000-0000-4000-8000-000000000013'
  )
  and (
    select automation_mode = 'manual' and needs_human
    from public.conversations
    where contact_id = '95000000-0000-4000-8000-000000000013'
  ),
  'a late proof is saved for human review without waiting for cleanup or reviving the appointment'
);

update public.appointments
set hold_expires_at = clock_timestamp() - interval '25 hours'
where contact_id = '95000000-0000-4000-8000-000000000011';

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, created_at
) values (
  '95000000-0000-4000-8000-000000000033',
  '95000000-0000-4000-8000-000000000022',
  '95000000-0000-4000-8000-000000000011',
  'inbound', 'document', 'Comprobante fuera de ventana.pdf', 'delivered',
  clock_timestamp()
);

select recognized as proof_outside_window_recognized
from public.record_deposit_proof(
  '95000000-0000-4000-8000-000000000011',
  '95000000-0000-4000-8000-000000000033',
  clock_timestamp()
)
\gset

select ok(
  not :'proof_outside_window_recognized'::boolean
  and (
    select status = 'cancelled'
      and deposit_status = 'expired'
      and deposit_proof_message_id is null
      and not deposit_proof_late
    from public.appointments
    where contact_id = '95000000-0000-4000-8000-000000000011'
  ),
  'proof received more than 24 hours late expires the hold but is not associated'
);

select ok(
  not has_function_privilege('anon',
    'public.confirm_appointment_deposit(uuid)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.record_deposit_proof(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  and has_function_privilege('authenticated',
    'public.confirm_appointment_deposit(uuid)', 'EXECUTE'),
  'deposit writes are unavailable to anonymous users'
);

select * from finish();
rollback;
