-- Horarios ficticios para la demostración odontológica de Gisela Lentz.
-- Ejecutar explícitamente sólo en un proyecto local o de demo.

begin;

insert into public.professionals (
  id, name, specialty, appointment_duration_minutes, active
)
values (
  '67697365-6c61-4765-8a2d-6c656e747a01',
  'Gisela Lentz',
  'Odontología',
  30,
  true
)
on conflict (id) do update
set name = excluded.name,
    specialty = excluded.specialty,
    appointment_duration_minutes = excluded.appointment_duration_minutes,
    active = true;

update public.professionals
set active = false
where id <> '67697365-6c61-4765-8a2d-6c656e747a01' and active;

insert into public.availability_rules (
  professional_id, weekday, start_time, end_time, slot_minutes, active
)
select
  '67697365-6c61-4765-8a2d-6c656e747a01'::uuid,
  weekday,
  window_start,
  window_end,
  15,
  true
from (
  select weekday, '09:00'::time as window_start, '13:00'::time as window_end
  from generate_series(1, 5) weekdays(weekday)
  union all
  select weekday, '15:00'::time, '19:00'::time
  from generate_series(1, 5) weekdays(weekday)
) schedule
on conflict (professional_id, weekday, start_time, end_time) do update
set slot_minutes = excluded.slot_minutes,
    active = true;

commit;

