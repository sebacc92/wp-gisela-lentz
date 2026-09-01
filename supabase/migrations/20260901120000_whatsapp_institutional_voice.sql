-- Los mensajes generados por el sistema hablan como asistente o desde la voz
-- institucional del consultorio. Los mensajes libres y las respuestas rápidas
-- siguen perteneciendo a la persona que los redacta y no pasan por esta regla.

alter table public.app_settings
  drop constraint if exists app_settings_gisela_patient_voice_check;

alter table public.quick_replies
  drop constraint if exists quick_replies_gisela_patient_voice_check;

alter table public.message_templates
  drop constraint if exists message_templates_gisela_patient_voice_check;

drop function if exists public.gisela_patient_message_uses_singular_voice(text);

create function public.automatic_patient_message_avoids_gisela_impersonation(
  p_message text
)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select p_message is null or (
    normalized_message !~ E'\\m(soy|me llamo|mi nombre es)[[:space:]]+(gisela([[:space:]]+lentz)?|((la|tu|su)[[:space:]]+)?(dra|doctora|odontologa|dentista)([[:space:]]+(gisela([[:space:]]+lentz)?|lentz))?)\\M'
    and normalized_message !~ E'\\m(te[[:space:]]+(habla|escribe)|habla)[[:space:]]+((la|tu|su)[[:space:]]+)?((dra|doctora|odontologa|dentista)[[:space:]]+)?(gisela([[:space:]]+lentz)?|lentz)\\M'
    and normalized_message !~ E'\\mgisela([[:space:]]+lentz)?[[:space:]]+por[[:space:]]+aca\\M'
    and normalized_message !~ E'\\m(mi (consultorio|agenda|horario|paciente|pacientes)|mis pacientes|cuando vengas a verme|quedo atenta|te espero|escribime|mandame|no me llego|te busco)\\M'
    and accented_message !~ E'\\m(yo[[:space:]]+)?(recibí|reservé|reservo|agendé|agendo|confirmé|confirmo|cancelé|cancelo|reprogramé|reprogramo|atiendo|revisé|reviso)([[:space:]]|$)'
    and accented_message !~ E'^recibo[[:space:]]+(tu|el|la|este|esta)\\M'
    and normalized_message !~ E'(^trabajo([[:space:]]|$)|\\myo[[:space:]]+trabajo\\M)'
    and normalized_message !~ E'\\matender(te|se)?[[:space:]]+conmigo\\M'
    and accented_message !~ E'\\m(yo[[:space:]]+)?(ya[[:space:]]+)?dejé[[:space:]]+(reservado|reservada|agendado|agendada|confirmado|confirmada)\\M'
    and accented_message !~ E'\\m(te|yo)[[:space:]]+anoté([[:space:]]+(el|un|tu))?\\M'
    and accented_message !~ E'\\m(he|yo[[:space:]]+había)[[:space:]]+(recibido|reservado|agendado|confirmado|cancelado|reprogramado|revisado)\\M'
    and normalized_message !~ E'\\macabo[[:space:]]+de[[:space:]]+(recibir|reservar|agendar|confirmar|cancelar|reprogramar|revisar)(te|lo|la)?\\M'
    and normalized_message !~ E'\\m(yo[[:space:]]+)?(voy a|necesito|debo)[[:space:]]+(revisar|verificar)(lo|la)?\\M'
    and normalized_message !~ E'\\m(yo[[:space:]]+)?voy[[:space:]]+a[[:space:]]+atender(te|lo|la)?\\M'
    and accented_message !~ E'\\matenderé\\M'
    and normalized_message !~ E'\\mte[[:space:]]+respondo[[:space:]]+personalmente\\M'
  )
  from (
    select
      btrim(
        regexp_replace(
          translate(lower(coalesce(p_message, '')), 'áéíóúüñ', 'aeiouun'),
          '[^a-z0-9]+',
          ' ',
          'g'
        )
      ) as normalized_message,
      btrim(
        regexp_replace(
          lower(coalesce(p_message, '')),
          '[^a-z0-9áéíóúüñ]+',
          ' ',
          'g'
        )
      ) as accented_message
  ) as voice;
$$;

revoke all on function public.automatic_patient_message_avoids_gisela_impersonation(text)
  from public, anon, authenticated;
grant execute on function public.automatic_patient_message_avoids_gisela_impersonation(text)
  to authenticated, service_role;

alter table public.app_settings
  alter column automation_welcome_message set default
    '👋 ¡Hola! Gracias por comunicarte con el consultorio de la Dra. Gisela Lentz. Estoy para ayudarte con turnos y consultas.',
  alter column out_of_hours_message set default
    'Gracias por escribirnos. Ahora estamos fuera del horario de atención, pero recibimos tu mensaje y te respondemos cuando retomemos.',
  alter column urgent_message set default
    'Recibimos tu mensaje y lo marcamos como urgente para que puedan responderte lo antes posible. Las urgencias se atienden de forma particular y tienen un valor diferente. Si es una emergencia grave, acercate a una guardia.',
  alter column general_info_message set default
    E'El consultorio está en calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires.\n\nLa atención es con turno: lunes de 9:30 a 15, martes de 13:30 a 17, miércoles de 9:30 a 12 y de 16 a 21, jueves de 10 a 15 y viernes de 9:30 a 11. Los feriados nacionales el consultorio permanece cerrado.\n\nPodés escribirnos siempre por este WhatsApp.',
  alter column deposit_request_message_template set default
    E'¡Hola! 😊\n\nPara confirmar tu turno necesitamos una seña de {deposit_amount}.\n\nSe descuenta del valor de la consulta el día del turno. Es para asegurar el lugar y evitar ausencias.\n\nDatos para transferir:\n\nAlias: {deposit_alias}\n\nTitular: {deposit_holder}\n\nEnviá el comprobante por este chat. ¡Gracias! 💛',
  alter column deposit_proof_received_message_template set default
    '¡Gracias! 😊 Recibimos tu comprobante.',
  alter column deposit_confirmed_message_template set default
    E'¡Listo! 😊 Tu turno quedó confirmado.\n\nTe esperamos el {date} a las {time}.\n\n¡Gracias! 💛',
  alter column booking_hold_expired_message_template set default
    E'El horario que habíamos reservado quedó nuevamente disponible porque no recibimos el comprobante dentro del tiempo previsto.\n\nSi querés, te ayudamos a buscar otro horario 😊';

update public.app_settings
set
  automation_welcome_message = case
    when automation_welcome_message =
      '¡Hola! Soy Gisela 😊 Para agendar tu turno voy a pedirte algunos datos.'
      then '👋 ¡Hola! Gracias por comunicarte con el consultorio de la Dra. Gisela Lentz. Estoy para ayudarte con turnos y consultas.'
    else automation_welcome_message
  end,
  out_of_hours_message = case
    when out_of_hours_message =
      'Gracias por escribirme. Ahora estoy fuera del horario de atención, pero leo tu mensaje y te respondo cuando vuelva.'
      then 'Gracias por escribirnos. Ahora estamos fuera del horario de atención, pero recibimos tu mensaje y te respondemos cuando retomemos.'
    else out_of_hours_message
  end,
  urgent_message = case
    when urgent_message =
      'Le doy prioridad a tu mensaje y te respondo apenas lo vea para darte un turno lo antes posible. Las urgencias las atiendo de forma particular y tienen un valor diferente. Si es una emergencia grave, acercate a una guardia.'
      then 'Recibimos tu mensaje y lo marcamos como urgente para que puedan responderte lo antes posible. Las urgencias se atienden de forma particular y tienen un valor diferente. Si es una emergencia grave, acercate a una guardia.'
    else urgent_message
  end,
  general_info_message = case
    when general_info_message =
      E'Mi consultorio está en calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires.\n\nAtiendo con turno: lunes de 9:30 a 15, martes de 13:30 a 17, miércoles de 9:30 a 12 y de 16 a 21, jueves de 10 a 15 y viernes de 9:30 a 11. Los feriados nacionales el consultorio permanece cerrado.\n\nEscribime siempre por acá, este WhatsApp.'
      then E'El consultorio está en calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires.\n\nLa atención es con turno: lunes de 9:30 a 15, martes de 13:30 a 17, miércoles de 9:30 a 12 y de 16 a 21, jueves de 10 a 15 y viernes de 9:30 a 11. Los feriados nacionales el consultorio permanece cerrado.\n\nPodés escribirnos siempre por este WhatsApp.'
    else general_info_message
  end,
  deposit_request_message_template = case
    when deposit_request_message_template =
      E'¡Hola! 😊\n\nPara confirmar tu turno te pido una seña de {deposit_amount}.\n\nLa descuento del valor de la consulta el día del turno. Es para asegurar el lugar y evitar ausencias.\n\nDatos para transferir:\n\nAlias: {deposit_alias}\n\nTitular: {deposit_holder}\n\nQuedo atenta al comprobante. ¡Gracias! 💛✨'
      then E'¡Hola! 😊\n\nPara confirmar tu turno necesitamos una seña de {deposit_amount}.\n\nSe descuenta del valor de la consulta el día del turno. Es para asegurar el lugar y evitar ausencias.\n\nDatos para transferir:\n\nAlias: {deposit_alias}\n\nTitular: {deposit_holder}\n\nEnviá el comprobante por este chat. ¡Gracias! 💛'
    else deposit_request_message_template
  end,
  deposit_proof_received_message_template = case
    when deposit_proof_received_message_template =
      '¡Gracias! 😊 Recibí tu comprobante.'
      then '¡Gracias! 😊 Recibimos tu comprobante.'
    else deposit_proof_received_message_template
  end,
  deposit_confirmed_message_template = case
    when deposit_confirmed_message_template =
      E'¡Listo! 😊 Confirmé tu turno.\n\nTe espero el {date} a las {time}.\n\n¡Gracias! 💛'
      then E'¡Listo! 😊 Tu turno quedó confirmado.\n\nTe esperamos el {date} a las {time}.\n\n¡Gracias! 💛'
    else deposit_confirmed_message_template
  end,
  booking_hold_expired_message_template = case
    when booking_hold_expired_message_template =
      E'El horario que te había reservado quedó nuevamente disponible porque no me llegó el comprobante dentro del tiempo previsto.\n\nSi querés, te busco otro horario 😊'
      then E'El horario que habíamos reservado quedó nuevamente disponible porque no recibimos el comprobante dentro del tiempo previsto.\n\nSi querés, te ayudamos a buscar otro horario 😊'
    else booking_hold_expired_message_template
  end
where id = true;

-- Las plantillas reales viven en Meta. Un nombre nuevo evita reutilizar una v2
-- aprobada con la voz anterior. Permanecen apagadas hasta que la copia v3 sea
-- aprobada y sincronizada como UTILITY.
update public.message_templates
set
  meta_name = case key
    when 'appointment_created' then 'gisela_appointment_created_v3'
    when 'appointment_reminder_24h' then 'gisela_appointment_reminder_24h_v3'
    when 'appointment_reminder_2h' then 'gisela_appointment_reminder_2h_v3'
    when 'appointment_cancelled' then 'gisela_appointment_cancelled_v3'
    when 'appointment_rescheduled' then 'gisela_appointment_rescheduled_v3'
    else meta_name
  end,
  body_preview = case key
    when 'appointment_created' then 'Tu turno quedó reservado.'
    when 'appointment_reminder_24h' then 'Te recordamos tu turno de mañana.'
    when 'appointment_reminder_2h' then 'Te recordamos que tu turno es dentro de dos horas.'
    when 'appointment_cancelled' then 'Tu turno quedó cancelado.'
    when 'appointment_rescheduled' then 'Tu turno quedó reprogramado.'
    else body_preview
  end,
  meta_template_id = null,
  meta_status = 'UNVERIFIED',
  quality_rating = null,
  last_synced_at = null,
  enabled = false
where key in (
  'appointment_created',
  'appointment_reminder_24h',
  'appointment_reminder_2h',
  'appointment_cancelled',
  'appointment_rescheduled'
);

-- Una plantilla automática personalizada se conserva, pero no puede seguir
-- activa si habla como la profesional. Puede reescribirse y habilitarse luego.
update public.message_templates
set enabled = false
where enabled
  and not public.automatic_patient_message_avoids_gisela_impersonation(body_preview);

alter table public.app_settings
  add constraint app_settings_automatic_patient_voice_check check (
    public.automatic_patient_message_avoids_gisela_impersonation(automation_welcome_message)
    and public.automatic_patient_message_avoids_gisela_impersonation(out_of_hours_message)
    and public.automatic_patient_message_avoids_gisela_impersonation(urgent_message)
    and public.automatic_patient_message_avoids_gisela_impersonation(general_info_message)
    and public.automatic_patient_message_avoids_gisela_impersonation(deposit_request_message_template)
    and public.automatic_patient_message_avoids_gisela_impersonation(deposit_proof_received_message_template)
    and public.automatic_patient_message_avoids_gisela_impersonation(deposit_confirmed_message_template)
    and public.automatic_patient_message_avoids_gisela_impersonation(booking_hold_expired_message_template)
  ),
  add constraint app_settings_automation_template_placeholders_check check (
    regexp_replace(
      deposit_request_message_template,
      E'\\{(deposit_amount|deposit_alias|deposit_holder)\\}',
      '',
      'g'
    ) !~ E'\\{[A-Za-z][A-Za-z0-9_]*\\}'
    and deposit_proof_received_message_template
      !~ E'\\{[A-Za-z][A-Za-z0-9_]*\\}'
    and regexp_replace(
      deposit_confirmed_message_template,
      E'\\{(date|time)\\}',
      '',
      'g'
    ) !~ E'\\{[A-Za-z][A-Za-z0-9_]*\\}'
    and booking_hold_expired_message_template
      !~ E'\\{[A-Za-z][A-Za-z0-9_]*\\}'
  );

alter table public.message_templates
  add constraint message_templates_automatic_patient_voice_check check (
    not enabled
    or public.automatic_patient_message_avoids_gisela_impersonation(body_preview)
  );

comment on function public.automatic_patient_message_avoids_gisela_impersonation(text) is
  'Impide que una copia automática se presente o actúe como la Dra. Gisela Lentz; permite la voz del asistente y del consultorio.';
comment on column public.app_settings.automation_welcome_message is
  'Saludo del asistente del consultorio. El flujo pide cada dato del alta en un mensaje separado.';
