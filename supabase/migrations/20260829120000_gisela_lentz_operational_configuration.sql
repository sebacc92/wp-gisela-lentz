-- Configuración operativa real del consultorio de Gisela Lentz.
-- Fuente: respuestas de Gisela de agosto de 2026 sobre datos de contacto, días
-- y horarios, tipos de atención, duración por cobertura, anticipación mínima y
-- mensajes automáticos. Esta migración carga únicamente configuración: no toca
-- pacientes, turnos, conversaciones ni credenciales.

-- 1. Datos del consultorio, duraciones y reglas de turnos.
--
--    - Contacto: sólo WhatsApp. No informó email, así que queda vacío.
--    - IOMA 30 minutos y Particular 60 minutos.
--    - Anticipación mínima de 12 horas (720 minutos).
--    - Sin descanso entre pacientes: no pidió uno.
--    - Fuera de horario apagado: responde ella durante todo el día.
update public.app_settings
set
  business_address =
    'Calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires',
  business_phone = '+54 9 2291 41-4102',
  business_email = null,
  ioma_duration_minutes = 30,
  private_duration_minutes = 60,
  appointment_buffer_minutes = 0,
  minimum_booking_notice_minutes = 720,
  out_of_hours_enabled = false,
  automation_welcome_message =
    E'¡Hola! Soy el asistente virtual de Gisela Lentz 👋\n\nPuedo ayudarte a sacar, reprogramar o cancelar un turno y a consultar los que ya tenés.\n\nSi es una urgencia o preferís hablar con Gisela, escribilo y te responde ella personalmente.',
  urgent_message =
    'Marcamos tu mensaje como urgente. Gisela lo revisa y te responde personalmente para darte un turno lo antes posible. Las urgencias se atienden de forma particular y tienen un valor diferente. Si se trata de una emergencia grave, acercate a una guardia.',
  general_info_message =
    E'El consultorio de Gisela Lentz está en calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires.\n\nHorarios de atención: lunes de 9:30 a 15, martes de 13:30 a 17, miércoles de 9:30 a 12 y de 16 a 21, jueves de 10 a 15 y viernes de 9:30 a 11. Los feriados nacionales el consultorio permanece cerrado.\n\nEl contacto es únicamente por WhatsApp al 2291 41-4102.'
where id = true;

-- 2. Motivos de atención informados por Gisela.
--
--    "Urgencias" no se carga como servicio reservable: las agenda y cotiza ella
--    de forma particular, y el detector de urgencias ya deriva esos mensajes a
--    atención humana con prioridad.
update public.services
set name = 'Extracciones'
where id = '51000000-0000-4000-8000-000000000005'
  and not exists (
    select 1
    from public.services other
    where other.id <> '51000000-0000-4000-8000-000000000005'
      and lower(trim(other.name)) = 'extracciones'
  );

update public.services
set name = 'Ortopedia y ortodoncia'
where id = '51000000-0000-4000-8000-000000000007'
  and not exists (
    select 1
    from public.services other
    where other.id <> '51000000-0000-4000-8000-000000000007'
      and lower(trim(other.name)) = 'ortopedia y ortodoncia'
  );

insert into public.services (id, name, description, duration_minutes, active, sort_order)
select
  '51000000-0000-4000-8000-000000000008',
  'Restauraciones',
  null,
  30,
  true,
  10
where not exists (
  select 1 from public.services where lower(trim(name)) = 'restauraciones'
);

update public.services
set active = true,
    sort_order = ordered.sort_order
from (values
  ('restauraciones', 10),
  ('extracciones', 20),
  ('limpieza', 30),
  ('blanqueamiento', 40),
  ('ortopedia y ortodoncia', 50)
) as ordered(normalized_name, sort_order)
where lower(trim(services.name)) = ordered.normalized_name;

update public.services
set active = false
where active
  and lower(trim(name)) not in (
    'restauraciones',
    'extracciones',
    'limpieza',
    'blanqueamiento',
    'ortopedia y ortodoncia'
  );

-- 3. Horario semanal real y feriados nacionales.
do $$
declare
  gisela_id uuid;
begin
  select id into gisela_id
  from public.professionals
  where lower(trim(name)) = 'gisela lentz'
  order by created_at, id
  limit 1;

  if gisela_id is null then
    raise exception 'GISELA_PROFESSIONAL_NOT_FOUND';
  end if;

  -- Las franjas anteriores quedan cerradas en lugar de borrarse: los turnos ya
  -- creados sobre ellas no se tocan y el cambio queda visible en la aplicación.
  update public.availability_rules
  set active = false
  where professional_id = gisela_id and active;

  insert into public.availability_rules (
    professional_id, weekday, start_time, end_time, slot_minutes, active
  )
  values
    (gisela_id, 1, '09:30', '15:00', 30, true),
    (gisela_id, 2, '13:30', '17:00', 30, true),
    (gisela_id, 3, '09:30', '12:00', 30, true),
    (gisela_id, 3, '16:00', '21:00', 30, true),
    (gisela_id, 4, '10:00', '15:00', 30, true),
    (gisela_id, 5, '09:30', '11:00', 30, true)
  on conflict (professional_id, weekday, start_time, end_time) do update
  set slot_minutes = excluded.slot_minutes,
      active = true;

  -- Feriados nacionales pendientes de 2026 y 2027 que caen de lunes a viernes,
  -- según la ley 27.399. Los puentes turísticos se decretan año a año y deben
  -- cargarse a mano desde Configuración → Días y horarios cerrados, igual que
  -- las vacaciones.
  insert into public.availability_exceptions (
    professional_id, date, start_time, end_time, type, reason
  )
  select
    gisela_id,
    holiday.holiday_date,
    null::time,
    null::time,
    'unavailable'::public.availability_exception_type,
    holiday.reason
  from (values
    (date '2026-10-12', 'Feriado nacional · Día del Respeto a la Diversidad Cultural'),
    (date '2026-11-23', 'Feriado nacional · Día de la Soberanía Nacional'),
    (date '2026-12-08', 'Feriado nacional · Inmaculada Concepción de María'),
    (date '2026-12-25', 'Feriado nacional · Navidad'),
    (date '2027-01-01', 'Feriado nacional · Año Nuevo'),
    (date '2027-02-08', 'Feriado nacional · Carnaval'),
    (date '2027-02-09', 'Feriado nacional · Carnaval'),
    (date '2027-03-24', 'Feriado nacional · Día Nacional de la Memoria'),
    (date '2027-03-26', 'Feriado nacional · Viernes Santo'),
    (date '2027-04-02', 'Feriado nacional · Día del Veterano y de los Caídos en Malvinas'),
    (date '2027-05-25', 'Feriado nacional · Día de la Revolución de Mayo'),
    (date '2027-06-21', 'Feriado nacional · Paso a la Inmortalidad del Gral. Güemes'),
    (date '2027-07-09', 'Feriado nacional · Día de la Independencia'),
    (date '2027-08-16', 'Feriado nacional · Paso a la Inmortalidad del Gral. San Martín'),
    (date '2027-10-11', 'Feriado nacional · Día del Respeto a la Diversidad Cultural'),
    (date '2027-12-08', 'Feriado nacional · Inmaculada Concepción de María')
  ) as holiday(holiday_date, reason)
  where not exists (
    select 1
    from public.availability_exceptions existing
    where existing.professional_id = gisela_id
      and existing.date = holiday.holiday_date
      and existing.type = 'unavailable'
      and existing.start_time is null
      and existing.end_time is null
  );
end;
$$;
