-- Los cambios de copy que pidió Gisela después de probar el bot:
--
-- - nombrarla "Odontóloga" y no "Dra." en el saludo;
-- - que el pedido de seña diga el día y la hora que se están reservando y deje
--   escrita la política de no reembolso, porque hoy hay quien pre-reserva y no
--   paga y el horario queda bloqueado;
-- - que la confirmación recuerde la dirección y pida puntualidad.
--
-- El día, la hora y la dirección ya existen en el sistema, así que viajan como
-- placeholders en vez de quedar escritos a mano: el check de placeholders se
-- amplía para esas dos columnas.
--
-- Cada texto se reemplaza sólo si todavía es el default anterior: si alguien lo
-- editó desde Configuración, esa edición manda.

alter table public.app_settings
  drop constraint app_settings_automation_template_placeholders_check,
  add constraint app_settings_automation_template_placeholders_check check (
    regexp_replace(
      deposit_request_message_template,
      E'\\{(deposit_amount|deposit_alias|deposit_holder|date|time)\\}',
      '',
      'g'
    ) !~ E'\\{[A-Za-z][A-Za-z0-9_]*\\}'
    and deposit_proof_received_message_template
      !~ E'\\{[A-Za-z][A-Za-z0-9_]*\\}'
    and regexp_replace(
      deposit_confirmed_message_template,
      E'\\{(date|time|address)\\}',
      '',
      'g'
    ) !~ E'\\{[A-Za-z][A-Za-z0-9_]*\\}'
    and booking_hold_expired_message_template
      !~ E'\\{[A-Za-z][A-Za-z0-9_]*\\}'
  );

alter table public.app_settings
  alter column automation_welcome_message set default
    '👋 ¡Hola! Gracias por comunicarte con el consultorio de la Odontóloga Gisela Lentz. Estoy para ayudarte con turnos y consultas.',
  alter column deposit_request_message_template set default
    E'¡Hola! Para poder agendar y confirmar tu turno:\n\n📅 Día y hora: {date} a las {time}\n💰 Seña: {deposit_amount}\n\nPodés transferir a estos datos:\n🏦 Alias / CBU: {deposit_alias}\n👤 Titular: {deposit_holder}\n\n⚠️ Importante: una vez hecho el pago, enviá el comprobante por este medio. La seña no se reembolsa ni se transfiere si el turno se cancela o reprograma con menos de 24 horas de anticipación, o ante la no asistencia.',
  alter column deposit_confirmed_message_template set default
    E'¡Recibido! Muchísimas gracias por el comprobante 👍\n\nTu turno quedó confirmado para el {date} a las {time}.\n\n📍 Te esperamos en {address}.\n🕐 Te pedimos puntualidad.';

update public.app_settings
set
  -- "Od." es la variante que quedó cargada a mano desde Configuración y es la
  -- que Gisela pidió escribir completa.
  automation_welcome_message = case
    when automation_welcome_message in (
      '👋 ¡Hola! Gracias por comunicarte con el consultorio de la Dra. Gisela Lentz. Estoy para ayudarte con turnos y consultas.',
      '👋 ¡Hola! Gracias por comunicarte con el consultorio de la Od. Gisela Lentz. Estoy para ayudarte con turnos y consultas.'
    )
      then '👋 ¡Hola! Gracias por comunicarte con el consultorio de la Odontóloga Gisela Lentz. Estoy para ayudarte con turnos y consultas.'
    else automation_welcome_message
  end,
  deposit_request_message_template = case
    when deposit_request_message_template =
      E'¡Hola! 😊\n\nPara confirmar tu turno necesitamos una seña de {deposit_amount}.\n\nSe descuenta del valor de la consulta el día del turno. Es para asegurar el lugar y evitar ausencias.\n\nDatos para transferir:\n\nAlias: {deposit_alias}\n\nTitular: {deposit_holder}\n\nEnviá el comprobante por este chat. ¡Gracias! 💛'
      then E'¡Hola! Para poder agendar y confirmar tu turno:\n\n📅 Día y hora: {date} a las {time}\n💰 Seña: {deposit_amount}\n\nPodés transferir a estos datos:\n🏦 Alias / CBU: {deposit_alias}\n👤 Titular: {deposit_holder}\n\n⚠️ Importante: una vez hecho el pago, enviá el comprobante por este medio. La seña no se reembolsa ni se transfiere si el turno se cancela o reprograma con menos de 24 horas de anticipación, o ante la no asistencia.'
    else deposit_request_message_template
  end,
  deposit_confirmed_message_template = case
    when deposit_confirmed_message_template =
      E'¡Listo! 😊 Tu turno quedó confirmado.\n\nTe esperamos el {date} a las {time}.\n\n¡Gracias! 💛'
      then E'¡Recibido! Muchísimas gracias por el comprobante 👍\n\nTu turno quedó confirmado para el {date} a las {time}.\n\n📍 Te esperamos en {address}.\n🕐 Te pedimos puntualidad.'
    else deposit_confirmed_message_template
  end
where id;
