-- Este WhatsApp lo contesta una única odontóloga. Toda copia dirigida a
-- pacientes habla como Gisela en primera persona singular: no existe una
-- recepción colectiva ni otra "Gisela" a la que derivar.

create or replace function public.gisela_patient_message_uses_singular_voice(
  p_message text
)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select p_message is null or (
    normalized_message !~* E'\\m(nosotros|nosotras|nos|nuestro|nuestra|nuestros|nuestras|acompa[nñ]anos|agendanos|agendenos|anotanos|anotenos|atendenos|atiendanos|atiendenos|avisanos|avisenos|ayudanos|ayudenos|buscanos|busquenos|compartanos|compartenos|compartinos|confirmanos|confirmenos|consultanos|consultenos|contactanos|contactenos|contanos|cuentanos|cuentenos|danos|denos|dejanos|dejenos|derivanos|derivenos|escribanos|escr[ií]benos|escribinos|encontranos|encuentranos|encuentrenos|env[ií]anos|env[ií]enos|esperanos|esperenos|indicanos|indiquenos|informanos|informenos|llamanos|llamenos|mandanos|mandenos|mostranos|muestranos|muestrenos|ofrecenos|ofrezcanos|pas[aá]nos|pasenos|recordanos|recuerdanos|recuerdenos|respondanos|respondenos|seguinos|siganos|siguenos|solicitanos|solicitenos|validanos|validenos|visitanos|visitenos)\\M'
    -- Todas las conjugaciones en primera persona plural terminan en -mos.
    -- Se quita primero una lista acotada de sustantivos/adjetivos frecuentes.
    and regexp_replace(
      normalized_message,
      E'\\m(cent[ií]metros|consumos|enfermos|extremos|gramos|insumos|kilogramos|kil[oó]metros|m[aá]ximos|mil[ií]metros|m[ií]nimos|mismos|[oó]ptimos|pr[oó]ximos|t[eé]rminos|[uú]ltimos|[[:alpha:]áéíóúüñ]*ismos)\\M',
      '',
      'gi'
    ) !~* E'\\m[[:alpha:]áéíóúüñ]+mos\\M'
    and normalized_message !~* E'\\m[[:alpha:]áéíóúüñ]+mos(lo|la|los|las|le|les|se|te)\\M'
    and regexp_replace(
      normalized_message,
      E'\\m(alternos|cuadernos|cuernos|eternos|externos|fraternos|gobiernos|infiernos|internos|inviernos|maternos|modernos|paternos|pernos|subalternos|tiernos|yernos)\\M',
      '',
      'gi'
    ) !~* E'\\m[[:alpha:]áéíóúüñ]+(ar|er|ir)nos\\M'
    and regexp_replace(
      normalized_message,
      E'\\m(soy|me llamo|mi nombre es)[[:space:]]+Gisela( Lentz)?\\M',
      '',
      'gi'
    ) !~* E'\\mGisela( Lentz)?\\M'
    and normalized_message !~* E'\\m((la|tu|su)[[:space:]]+(dra\\.?|odont[oó]loga|dentista|doctora|profesional|especialista)|ella|(dra\\.?|doctora|odont[oó]loga|dentista)[[:space:]]+(Gisela([[:space:]]+Lentz)?|Lentz))\\M'
  )
  from (
    select translate(
      lower(coalesce(p_message, '')),
      'áéíóúüñ',
      'aeiouun'
    ) as normalized_message
  ) as voice;
$$;

revoke all on function public.gisela_patient_message_uses_singular_voice(text)
  from public, anon, authenticated;
grant execute on function public.gisela_patient_message_uses_singular_voice(text)
  to authenticated, service_role;

alter table public.app_settings
  alter column automation_welcome_message set default
    '¡Hola! Soy Gisela 😊 Para agendar tu turno voy a pedirte algunos datos.',
  alter column out_of_hours_message set default
    'Gracias por escribirme. Ahora estoy fuera del horario de atención, pero leo tu mensaje y te respondo cuando vuelva.',
  alter column urgent_message set default
    'Le doy prioridad a tu mensaje y te respondo apenas lo vea para darte un turno lo antes posible. Las urgencias las atiendo de forma particular y tienen un valor diferente. Si es una emergencia grave, acercate a una guardia.',
  alter column general_info_message set default
    E'Mi consultorio está en calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires.\n\nAtiendo con turno: lunes de 9:30 a 15, martes de 13:30 a 17, miércoles de 9:30 a 12 y de 16 a 21, jueves de 10 a 15 y viernes de 9:30 a 11. Los feriados nacionales el consultorio permanece cerrado.\n\nEscribime siempre por acá, este WhatsApp.',
  alter column deposit_request_message_template set default
    E'¡Hola! 😊\n\nPara confirmar tu turno te pido una seña de {deposit_amount}.\n\nLa descuento del valor de la consulta el día del turno. Es para asegurar el lugar y evitar ausencias.\n\nDatos para transferir:\n\nAlias: {deposit_alias}\n\nTitular: {deposit_holder}\n\nQuedo atenta al comprobante. ¡Gracias! 💛✨',
  alter column deposit_proof_received_message_template set default
    '¡Gracias! 😊 Recibí tu comprobante.',
  alter column deposit_confirmed_message_template set default
    E'¡Listo! 😊 Confirmé tu turno.\n\nTe espero el {date} a las {time}.\n\n¡Gracias! 💛',
  alter column booking_hold_expired_message_template set default
    E'El horario que te había reservado quedó nuevamente disponible porque no me llegó el comprobante dentro del tiempo previsto.\n\nSi querés, te busco otro horario 😊';

update public.app_settings
set
  automation_welcome_message =
    '¡Hola! Soy Gisela 😊 Para agendar tu turno voy a pedirte algunos datos.',
  out_of_hours_message =
    'Gracias por escribirme. Ahora estoy fuera del horario de atención, pero leo tu mensaje y te respondo cuando vuelva.',
  urgent_message =
    'Le doy prioridad a tu mensaje y te respondo apenas lo vea para darte un turno lo antes posible. Las urgencias las atiendo de forma particular y tienen un valor diferente. Si es una emergencia grave, acercate a una guardia.',
  general_info_message =
    E'Mi consultorio está en calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires.\n\nAtiendo con turno: lunes de 9:30 a 15, martes de 13:30 a 17, miércoles de 9:30 a 12 y de 16 a 21, jueves de 10 a 15 y viernes de 9:30 a 11. Los feriados nacionales el consultorio permanece cerrado.\n\nEscribime siempre por acá, este WhatsApp.',
  deposit_request_message_template =
    E'¡Hola! 😊\n\nPara confirmar tu turno te pido una seña de {deposit_amount}.\n\nLa descuento del valor de la consulta el día del turno. Es para asegurar el lugar y evitar ausencias.\n\nDatos para transferir:\n\nAlias: {deposit_alias}\n\nTitular: {deposit_holder}\n\nQuedo atenta al comprobante. ¡Gracias! 💛✨',
  deposit_proof_received_message_template =
    '¡Gracias! 😊 Recibí tu comprobante.',
  deposit_confirmed_message_template =
    E'¡Listo! 😊 Confirmé tu turno.\n\nTe espero el {date} a las {time}.\n\n¡Gracias! 💛',
  booking_hold_expired_message_template =
    E'El horario que te había reservado quedó nuevamente disponible porque no me llegó el comprobante dentro del tiempo previsto.\n\nSi querés, te busco otro horario 😊'
where id = true;

update public.quick_replies
set
  title = 'Mis horarios de atención',
  body = 'Atiendo con turno: lunes de 9:30 a 15, martes de 13:30 a 17, miércoles de 9:30 a 12 y de 16 a 21, jueves de 10 a 15 y viernes de 9:30 a 11.'
where shortcut = '/horarios';

update public.quick_replies
set
  title = 'Ubicación de mi consultorio',
  body = 'Mi consultorio está en calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires.'
where shortcut = '/ubicacion';

update public.quick_replies
set
  title = 'En breve te respondo',
  body = 'Recibí tu mensaje. Te respondo en breve.'
where shortcut = '/espera';

update public.message_templates
set
  meta_name = case key
    when 'appointment_created' then 'gisela_appointment_created_v2'
    when 'appointment_reminder_24h' then 'gisela_appointment_reminder_24h_v2'
    when 'appointment_reminder_2h' then 'gisela_appointment_reminder_2h_v2'
    when 'appointment_cancelled' then 'gisela_appointment_cancelled_v2'
    when 'appointment_rescheduled' then 'gisela_appointment_rescheduled_v2'
    else meta_name
  end,
  body_preview = case key
    when 'appointment_created' then 'Reservé tu turno.'
    when 'appointment_reminder_24h' then 'Te recuerdo tu turno de mañana.'
    when 'appointment_reminder_2h' then 'Te recuerdo que tu turno es dentro de dos horas.'
    when 'appointment_cancelled' then 'Cancelé tu turno.'
    when 'appointment_rescheduled' then 'Reprogramé tu turno.'
    else body_preview
  end,
  -- La versión anterior podía tener voz institucional y cuatro parámetros.
  -- Un nombre nuevo impide que Health la vuelva a marcar como aprobada por
  -- accidente. Cada v2 se habilita recién después de aprobarla en Meta.
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

-- Si existiera una respuesta personalizada anterior, se conserva para que
-- Gisela pueda reescribirla, pero no se permite que siga saliendo con una voz
-- incompatible. Esto evita que una personalización desconocida bloquee el
-- despliegue completo de la migración.
update public.quick_replies
set enabled = false
where enabled
  and not public.gisela_patient_message_uses_singular_voice(body);

update public.message_templates
set enabled = false
where enabled
  and not public.gisela_patient_message_uses_singular_voice(body_preview);

alter table public.app_settings
  add constraint app_settings_gisela_patient_voice_check check (
    public.gisela_patient_message_uses_singular_voice(automation_welcome_message)
    and public.gisela_patient_message_uses_singular_voice(out_of_hours_message)
    and public.gisela_patient_message_uses_singular_voice(urgent_message)
    and public.gisela_patient_message_uses_singular_voice(general_info_message)
    and public.gisela_patient_message_uses_singular_voice(deposit_request_message_template)
    and public.gisela_patient_message_uses_singular_voice(deposit_proof_received_message_template)
    and public.gisela_patient_message_uses_singular_voice(deposit_confirmed_message_template)
    and public.gisela_patient_message_uses_singular_voice(booking_hold_expired_message_template)
    and regexp_replace(
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

alter table public.quick_replies
  add constraint quick_replies_gisela_patient_voice_check check (
    not enabled
    or public.gisela_patient_message_uses_singular_voice(body)
  );

alter table public.message_templates
  add constraint message_templates_gisela_patient_voice_check check (
    not enabled
    or public.gisela_patient_message_uses_singular_voice(body_preview)
  );

comment on function public.gisela_patient_message_uses_singular_voice(text) is
  'Valida que una copia dirigida a pacientes no use plural institucional ni hable de Gisela en tercera persona.';
comment on column public.app_settings.automation_welcome_message is
  'Saludo de Gisela en primera persona singular. El flujo pide cada dato del alta en un mensaje separado.';
