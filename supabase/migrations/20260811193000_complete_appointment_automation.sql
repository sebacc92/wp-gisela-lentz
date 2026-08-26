-- El mensaje anterior pedía una carga manual de datos y contradecía el flujo
-- automático. Se preservan las personalizaciones hechas por administradores.
alter table public.app_settings
  alter column automation_welcome_message set default
    E'¡Hola! Soy el asistente virtual de COLP 👋\n\nPuedo ayudarte a sacar, reprogramar o cancelar un turno. También podés consultar tus próximos turnos o hablar con recepción.\n\n¿En qué podemos ayudarte?';

update public.app_settings
set automation_welcome_message =
  E'¡Hola! Soy el asistente virtual de COLP 👋\n\nPuedo ayudarte a sacar, reprogramar o cancelar un turno. También podés consultar tus próximos turnos o hablar con recepción.\n\n¿En qué podemos ayudarte?'
where automation_welcome_message =
  E'¡Hola! Gracias por comunicarte con COLP.\n\n📌 Información importante:\nLos turnos solicitados por este medio pueden presentar demoras. Por favor, aguardá nuestro llamado para la confirmación.\n\nPara gestionar tu solicitud, envianos:\n• Nombre y apellido\n• Obra social o atención particular\n• Email\n• Profesional o especialidad de preferencia\n• Celular de contacto para el turno (obligatorio)\n\nImportante: te llamaremos al celular informado. Por favor, atendé el llamado.\n\nPara proteger tu privacidad, cualquier dato adicional necesario será solicitado durante el contacto.\n\nTambién podés elegir una opción del menú.\n\n¡Muchas gracias!';

-- Una respuesta a un botón viejo nunca debe poder reactivar un turno que fue
-- cancelado o cerrado mientras la conversación seguía abierta.
create or replace function public.reschedule_appointment(
  p_appointment_id uuid,
  p_starts_at timestamptz
)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  duration_minutes integer;
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not exists (
    select 1 from public.profiles where id = auth.uid() and active
  ) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select p.appointment_duration_minutes into duration_minutes
  from public.appointments a
  join public.professionals p on p.id = a.professional_id
  where a.id = p_appointment_id
    and a.status in ('scheduled', 'confirmed')
    and p.active;

  if duration_minutes is null then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  begin
    update public.appointments
    set
      starts_at = p_starts_at,
      ends_at = p_starts_at + make_interval(mins => duration_minutes),
      status = 'scheduled'
    where id = p_appointment_id
      and status in ('scheduled', 'confirmed')
    returning * into result;
  exception when exclusion_violation then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end;

  if result.id is null then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  return result;
end;
$$;
