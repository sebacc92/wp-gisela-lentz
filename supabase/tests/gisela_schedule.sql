\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(1);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

create function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if value is not true then
    raise exception 'ASSERTION_FAILED: %', message;
  end if;
end;
$$;

-- Elige un lunes entre 7 y 13 días en el futuro para que el test sea estable
-- sin depender del día en que se ejecute.
select (
  current_date
  + 7
  + mod(8 - extract(isodow from current_date)::integer, 7)
)::date as test_date
\gset

update public.app_settings
set appointment_buffer_minutes = 15,
    minimum_booking_notice_minutes = 0
where id = true;

-- These domain tests require an authorized, freshly observed Calendar.
\ir _support/calendar-ready.inc

insert into public.professionals (
  id, name, specialty, appointment_duration_minutes, active
)
values (
  '92000000-0000-4000-8000-000000000001',
  'Gisela Schedule Test',
  'Odontología',
  30,
  true
);

insert into public.services (
  id, name, duration_minutes, active, sort_order
)
values
  (
    '92000000-0000-4000-8000-000000000002',
    'Limpieza Schedule Test',
    45,
    true,
    9000
  ),
  (
    '92000000-0000-4000-8000-000000000003',
    'Servicio inactivo Schedule Test',
    30,
    false,
    9001
  );

insert into public.availability_rules (
  professional_id, weekday, start_time, end_time, slot_minutes, active
)
values (
  '92000000-0000-4000-8000-000000000001',
  1,
  '09:00',
  '13:00',
  15,
  true
);

insert into public.contacts (
  id, phone_e164, whatsapp_id, name, email, administrative_notes,
  coverage, is_existing_patient
)
values
  (
    '92000000-0000-4000-8000-000000000010',
    '+5491100009910',
    '5491100009910',
    'Paciente Schedule Test A',
    'schedule-a@example.com',
    'Dato administrativo ficticio.',
    'ioma',
    true
  ),
  (
    '92000000-0000-4000-8000-000000000011',
    '+5491100009911',
    '5491100009911',
    'Paciente Schedule Test B',
    null,
    null,
    'ioma',
    false
  );

select public.create_service_appointment(
  '92000000-0000-4000-8000-000000000010',
  '92000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000002',
  (:'test_date'::date + '09:00'::time) at time zone 'America/Argentina/Buenos_Aires',
  'manual',
  'Turno ficticio de prueba'
);

select pg_temp.assert_true(
  (
    select service_id = '92000000-0000-4000-8000-000000000002'
      and ends_at - starts_at = interval '30 minutes'
    from public.appointments
    where contact_id = '92000000-0000-4000-8000-000000000010'
  ),
  'service appointment must retain its reason and use coverage duration'
);

-- La cita IOMA termina 09:30 y el buffer ocupa hasta 09:45.
do $$
declare
  test_date date := current_date
    + 7
    + mod(8 - extract(isodow from current_date)::integer, 7);
begin
  begin
    perform public.create_service_appointment(
      '92000000-0000-4000-8000-000000000011',
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000002',
      (test_date + '09:30'::time) at time zone 'America/Argentina/Buenos_Aires',
      'manual',
      null
    );
    raise exception 'expected buffer conflict';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'SLOT_UNAVAILABLE' then raise; end if;
  end;
end;
$$;

insert into public.availability_exceptions (
  professional_id, date, start_time, end_time, type, reason
)
values (
  '92000000-0000-4000-8000-000000000001',
  :'test_date'::date,
  '11:00',
  '12:00',
  'unavailable',
  'Bloqueo ficticio de prueba'
);

do $$
declare
  test_date date := current_date
    + 7
    + mod(8 - extract(isodow from current_date)::integer, 7);
begin
  begin
    perform public.create_service_appointment(
      '92000000-0000-4000-8000-000000000011',
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000002',
      (test_date + '11:00'::time) at time zone 'America/Argentina/Buenos_Aires',
      'manual',
      null
    );
    raise exception 'expected blocked slot';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'SLOT_UNAVAILABLE' then raise; end if;
  end;
end;
$$;

select public.reschedule_service_appointment(
  (
    select id
    from public.appointments
    where contact_id = '92000000-0000-4000-8000-000000000010'
  ),
  (:'test_date'::date + '12:00'::time) at time zone 'America/Argentina/Buenos_Aires'
);

select pg_temp.assert_true(
  (
    select service_id = '92000000-0000-4000-8000-000000000002'
      and ends_at - starts_at = interval '30 minutes'
      and starts_at =
        (:'test_date'::date + '12:00'::time) at time zone 'America/Argentina/Buenos_Aires'
    from public.appointments
    where contact_id = '92000000-0000-4000-8000-000000000010'
  ),
  'service rescheduling must preserve coverage duration and relation'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from public.get_available_slots_for_service(
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000002',
      :'test_date'::date,
      'America/Argentina/Buenos_Aires',
      100
    ) slot
    where slot.starts_at =
      (:'test_date'::date + '11:00'::time) at time zone 'America/Argentina/Buenos_Aires'
  ),
  'blocked times must not be offered by service availability'
);

do $$
declare
  test_date date := current_date
    + 7
    + mod(8 - extract(isodow from current_date)::integer, 7);
begin
  begin
    perform public.create_service_appointment(
      '92000000-0000-4000-8000-000000000011',
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000003',
      (test_date + '12:00'::time) at time zone 'America/Argentina/Buenos_Aires',
      'manual',
      null
    );
    raise exception 'expected inactive service rejection';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'SERVICE_NOT_AVAILABLE' then raise; end if;
  end;
end;
$$;

select pg_temp.assert_true(
  (
    select email = 'schedule-a@example.com'
      and administrative_notes = 'Dato administrativo ficticio.'
    from public.contacts
    where id = '92000000-0000-4000-8000-000000000010'
  ),
  'patient administrative fields must be persisted'
);

select pass('service duration, buffers, blocks and patient fields passed');
select * from finish();

rollback;
