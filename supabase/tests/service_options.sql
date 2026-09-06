\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(8);

select is(
  (
    select name
    from public.services
    where id = '51000000-0000-4000-8000-000000000006'::uuid
  ),
  'Limpieza dental',
  'the whitening service keeps its id and is shown as Limpieza dental'
);

select ok(
  not exists (
    select 1
    from public.services
    where active
      and lower(trim(name)) = 'blanqueamiento'
  ),
  'the active options no longer include Blanqueamiento'
);

select is(
  (
    select name
    from public.services
    where id = '51000000-0000-4000-8000-000000000007'::uuid
  ),
  'Ortodoncia',
  'the canonical orthodontics service is shown as Ortodoncia'
);

select ok(
  exists (
    select 1
    from public.services
    where name = 'Prótesis'
      and active
  ),
  'Prótesis is an active appointment service with the canonical label'
);

select is(
  (
    select count(*)::integer
    from public.services
    where lower(trim(name)) in ('protesis', 'prótesis')
  ),
  1,
  'there is only one accented or unaccented prosthesis service'
);

select ok(
  (
    select service.duration_minutes = settings.default_appointment_duration_minutes
    from public.services service
    cross join public.app_settings settings
    where service.name = 'Prótesis'
      and settings.id = true
  ),
  'Prótesis only fills the required legacy duration from the configured default'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select (
  current_date + 7 + mod(8 - extract(isodow from current_date)::integer, 7)
)::date as test_date
\gset

update public.app_settings
set minimum_booking_notice_minutes = 0,
    appointment_buffer_minutes = 0,
    deposit_enabled = false,
    ioma_duration_minutes = 30,
    private_duration_minutes = 60
where id = true;

-- These domain tests require an authorized, freshly observed Calendar.
\ir _support/calendar-ready.inc

insert into public.professionals (
  id, name, specialty, appointment_duration_minutes, active
) values (
  '97000000-0000-4000-8000-000000000001',
  'Profesional Service Options Test',
  'Odontología',
  45,
  true
);

insert into public.availability_rules (
  professional_id, weekday, start_time, end_time, slot_minutes, active
) values (
  '97000000-0000-4000-8000-000000000001',
  1,
  '09:00',
  '13:00',
  30,
  true
);

insert into public.contacts (
  id, phone_e164, whatsapp_id, name, coverage, is_existing_patient
) values
  (
    '97000000-0000-4000-8000-000000000010',
    '+5491100009710',
    '5491100009710',
    'Paciente Prótesis IOMA Test',
    'ioma',
    true
  ),
  (
    '97000000-0000-4000-8000-000000000011',
    '+5491100009711',
    '5491100009711',
    'Paciente Prótesis Particular Test',
    'particular',
    false
  );

-- Este valor absurdo vuelve observable que la columna del servicio es legado:
-- ninguna reserva nueva debe heredar estos 180 minutos.
update public.services
set duration_minutes = 180
where name = 'Prótesis';

select public.create_service_appointment(
  '97000000-0000-4000-8000-000000000010',
  '97000000-0000-4000-8000-000000000001',
  (select id from public.services where name = 'Prótesis'),
  (:'test_date'::date + time '09:00')
    at time zone 'America/Argentina/Buenos_Aires',
  'whatsapp',
  null
);

select public.create_service_appointment(
  '97000000-0000-4000-8000-000000000011',
  '97000000-0000-4000-8000-000000000001',
  (select id from public.services where name = 'Prótesis'),
  (:'test_date'::date + time '10:00')
    at time zone 'America/Argentina/Buenos_Aires',
  'whatsapp',
  null
);

select ok(
  (
    select appointment.service_id = service.id
      and service.name = 'Prótesis'
      and appointment.coverage = 'ioma'
      and appointment.duration_minutes = 30
      and appointment.ends_at - appointment.starts_at = interval '30 minutes'
    from public.appointments appointment
    join public.services service on service.id = appointment.service_id
    where appointment.contact_id = '97000000-0000-4000-8000-000000000010'
  ),
  'an IOMA Prótesis appointment uses the configured coverage duration'
);

select ok(
  (
    select appointment.service_id = service.id
      and service.name = 'Prótesis'
      and appointment.coverage = 'particular'
      and appointment.duration_minutes = 60
      and appointment.ends_at - appointment.starts_at = interval '60 minutes'
    from public.appointments appointment
    join public.services service on service.id = appointment.service_id
    where appointment.contact_id = '97000000-0000-4000-8000-000000000011'
  ),
  'a Particular Prótesis appointment uses the configured coverage duration'
);

select * from finish();

rollback;
