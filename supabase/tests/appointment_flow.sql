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

insert into public.professionals (
  id,
  name,
  appointment_duration_minutes
) values (
  '91000000-0000-4000-8000-000000000001',
  'Profesional Appointment Flow Test',
  30
);

-- El RPC ahora valida autoritativamente que el horario esté dentro de una
-- franja de atención. Esta regla amplia mantiene el foco de este test en el
-- ciclo de vida del turno y la exclusión concurrente.
insert into public.availability_rules (
  professional_id,
  weekday,
  start_time,
  end_time,
  slot_minutes
)
select
  '91000000-0000-4000-8000-000000000001',
  weekday,
  '00:00'::time,
  '23:59'::time,
  30
from generate_series(0, 6) weekdays(weekday);

insert into public.contacts (
  id,
  phone_e164,
  whatsapp_id,
  name,
  coverage,
  is_existing_patient
) values (
  '91000000-0000-4000-8000-000000000002',
  '+5492215559998',
  '5492215559998',
  'Paciente Appointment Flow Test',
  'ioma',
  true
);

select public.create_appointment(
  '91000000-0000-4000-8000-000000000002',
  '91000000-0000-4000-8000-000000000001',
  date_trunc('day', now()) + interval '30 days 10 hours',
  'whatsapp',
  null
);

select pg_temp.assert_true(
  (
    select status = 'scheduled'
      and ends_at - starts_at = interval '30 minutes'
    from public.appointments
    where contact_id = '91000000-0000-4000-8000-000000000002'
  ),
  'booking must use the IOMA duration and start as a deposit hold'
);

do $$
begin
  begin
    perform public.create_appointment(
      '91000000-0000-4000-8000-000000000002',
      '91000000-0000-4000-8000-000000000001',
      date_trunc('day', now()) + interval '30 days 10 hours',
      'whatsapp',
      null
    );
    raise exception 'expected unavailable slot';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'SLOT_UNAVAILABLE' then raise; end if;
  end;
end;
$$;

select public.reschedule_appointment(
  (
    select id
    from public.appointments
    where contact_id = '91000000-0000-4000-8000-000000000002'
  ),
  date_trunc('day', now()) + interval '31 days 11 hours'
);

select pg_temp.assert_true(
  (
    select starts_at = date_trunc('day', now()) + interval '31 days 11 hours'
      and status = 'scheduled'
    from public.appointments
    where contact_id = '91000000-0000-4000-8000-000000000002'
  ),
  'an active appointment must be rescheduled'
);

select public.update_appointment_status(
  (
    select id
    from public.appointments
    where contact_id = '91000000-0000-4000-8000-000000000002'
  ),
  'cancelled'
);

do $$
begin
  begin
    perform public.reschedule_appointment(
      (
        select id
        from public.appointments
        where contact_id = '91000000-0000-4000-8000-000000000002'
      ),
      date_trunc('day', now()) + interval '32 days 12 hours'
    );
    raise exception 'expected inactive appointment rejection';
  exception
    when sqlstate 'P0002' then
      if sqlerrm <> 'APPOINTMENT_NOT_FOUND' then raise; end if;
  end;
end;
$$;

select pg_temp.assert_true(
  (
    select status = 'cancelled'
    from public.appointments
    where contact_id = '91000000-0000-4000-8000-000000000002'
  ),
  'a stale reprogramming response must not revive a cancelled appointment'
);

select pass('booking, rescheduling and cancellation assertions passed');
select * from finish();

rollback;
