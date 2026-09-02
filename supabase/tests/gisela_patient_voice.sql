\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(78);

select ok(
  public.automatic_patient_message_avoids_gisela_impersonation(
    '👋 ¡Hola! Gracias por comunicarte con el consultorio de la Dra. Gisela Lentz. Estoy para ayudarte.'
  ),
  'acepta la presentación natural del asistente del consultorio'
);
select ok(
  public.automatic_patient_message_avoids_gisela_impersonation(
    'Recibimos tu mensaje y te respondemos en breve.'
  ),
  'acepta la voz institucional plural'
);
select ok(
  public.automatic_patient_message_avoids_gisela_impersonation(
    'Voy a derivar tu consulta para que puedan ayudarte.'
  ),
  'acepta el singular propio de un asistente'
);
select ok(
  public.automatic_patient_message_avoids_gisela_impersonation(
    'Soy asistente del consultorio.'
  ),
  'acepta una presentación honesta del asistente'
);
select ok(
  public.automatic_patient_message_avoids_gisela_impersonation(
    'La Dra. Gisela Lentz atiende en Miramar.'
  ),
  'acepta mencionar a la profesional en tercera persona'
);
select ok(
  public.automatic_patient_message_avoids_gisela_impersonation(
    'El trabajo del consultorio se organiza por turnos.'
  ),
  'acepta trabajo como sustantivo institucional'
);
select ok(
  public.automatic_patient_message_avoids_gisela_impersonation(
    'El consultorio confirmó el horario.'
  ),
  'no confunde confirmó en tercera persona con confirmo en primera'
);
select ok(
  public.automatic_patient_message_avoids_gisela_impersonation(
    'La Dra. Gisela había confirmado el horario.'
  ),
  'no confunde había en tercera persona con una afirmación propia'
);
select ok(
  public.automatic_patient_message_avoids_gisela_impersonation(
    'El recibo de transferencia quedó registrado.'
  ),
  'no confunde el sustantivo recibo con recibir en primera persona'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Soy Gisela.'),
  false,
  'rechaza presentarse como Gisela'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Me llamo Gisela Lentz.'),
  false,
  'rechaza afirmar la identidad de la profesional'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Soy la Dra. Gisela Lentz.'),
  false,
  'rechaza la presentación profesional aunque incluya puntuación'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Soy Dra. Gisela Lentz.'),
  false,
  'rechaza la presentación profesional sin artículo'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Soy la Dra. Lentz.'),
  false,
  'rechaza presentarse como la profesional sólo por apellido'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Soy tu odontóloga.'),
  false,
  'rechaza presentarse como la odontóloga del paciente'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation(
    'Soy la odontóloga que va a atenderte.'
  ),
  false,
  'rechaza presentarse como la profesional aunque no nombre a Gisela'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Te habla Gisela.'),
  false,
  'rechaza una autoidentificación indirecta con habla'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Habla la Dra. Lentz.'),
  false,
  'rechaza una autoidentificación profesional por apellido'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Gisela por acá.'),
  false,
  'rechaza una autoidentificación coloquial'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Te escribe Gisela.'),
  false,
  'rechaza una autoidentificación indirecta con escribe'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Mi consultorio está en Miramar.'),
  false,
  'rechaza apropiarse del consultorio'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Mi agenda está completa.'),
  false,
  'rechaza apropiarse de la agenda profesional'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Mi horario es de 9 a 15.'),
  false,
  'rechaza apropiarse del horario profesional'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Atiendo los lunes.'),
  false,
  'rechaza hablar como la profesional que atiende'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Trabajo los lunes.'),
  false,
  'rechaza hablar como la profesional que trabaja en el consultorio'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Te espero el lunes.'),
  false,
  'rechaza una espera personal de la profesional'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Voy a atenderte el lunes.'),
  false,
  'rechaza prometer atención como la profesional'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation(
    'Cuando vengas al consultorio, voy a atenderte.'
  ),
  false,
  'rechaza insinuar atención clínica personal dentro de una frase más larga'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation(
    'Podés atenderte conmigo el lunes.'
  ),
  false,
  'rechaza ofrecer atención profesional conmigo'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Vas a atenderte conmigo.'),
  false,
  'rechaza una referencia futura a atenderse con quien escribe'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Reservé tu turno.'),
  false,
  'rechaza adjudicarse la reserva'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Confirmé tu turno.'),
  false,
  'rechaza adjudicarse la confirmación'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Confirmo tu turno.'),
  false,
  'rechaza adjudicarse una confirmación en presente'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('He confirmado tu turno.'),
  false,
  'rechaza adjudicarse una confirmación compuesta'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Acabo de reservarte el turno.'),
  false,
  'rechaza adjudicarse una reserva con pronombre enclítico'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation(
    'Ya dejé reservado tu horario.'
  ),
  false,
  'rechaza adjudicarse una reserva con dejé'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Te anoté el turno.'),
  false,
  'rechaza adjudicarse personalmente la carga del turno'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Recibí tu comprobante.'),
  false,
  'rechaza adjudicarse personalmente la recepción'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Reviso tu comprobante.'),
  false,
  'rechaza adjudicarse una revisión en presente'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Yo voy a revisar tu comprobante.'),
  false,
  'rechaza prometer una revisión como si fuera la profesional'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Te respondo personalmente.'),
  false,
  'rechaza prometer una respuesta personal de la profesional'
);
select is(
  public.automatic_patient_message_avoids_gisela_impersonation('Cuando vengas a verme, traé el estudio.'),
  false,
  'rechaza insinuar que el asistente es la profesional'
);
select ok(
  public.automatic_patient_message_avoids_gisela_impersonation(
    'Los próximos horarios disponibles son el lunes y el martes.'
  ),
  'acepta una respuesta automática neutral'
);

select is(
  (select automation_welcome_message from public.app_settings where id = true),
  '👋 ¡Hola! Gracias por comunicarte con el consultorio de la Dra. Gisela Lentz. Estoy para ayudarte con turnos y consultas.',
  'la bienvenida identifica al consultorio sin hacerse pasar por Gisela'
);
select is(
  (select out_of_hours_message from public.app_settings where id = true),
  'Gracias por escribirnos. Ahora estamos fuera del horario de atención, pero recibimos tu mensaje y te respondemos cuando retomemos.',
  'el aviso fuera de horario usa voz institucional'
);
select is(
  (select urgent_message from public.app_settings where id = true),
  'Recibimos tu mensaje y lo marcamos como urgente para que puedan responderte lo antes posible. Las urgencias se atienden de forma particular y tienen un valor diferente. Si es una emergencia grave, acercate a una guardia.',
  'el aviso urgente no promete que responde Gisela personalmente'
);
select is(
  (select general_info_message from public.app_settings where id = true),
  E'El consultorio está en calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires.\n\nLa atención es con turno: lunes de 9:30 a 15, martes de 13:30 a 17, miércoles de 9:30 a 12 y de 16 a 21, jueves de 10 a 15 y viernes de 9:30 a 11. Los feriados nacionales el consultorio permanece cerrado.\n\nPodés escribirnos siempre por este WhatsApp.',
  'la información general habla desde el consultorio'
);
select ok(
  (select deposit_request_message_template from public.app_settings where id = true)
    like '%Para confirmar tu turno necesitamos una seña de {deposit_amount}.%',
  'el pedido de seña usa voz institucional'
);
select is(
  (select deposit_proof_received_message_template from public.app_settings where id = true),
  '¡Gracias! 😊 Recibimos tu comprobante.',
  'el acuse del comprobante usa voz institucional'
);
select ok(
  (select deposit_confirmed_message_template from public.app_settings where id = true)
    like '%Tu turno quedó confirmado.%',
  'la confirmación del turno es neutral'
);
select ok(
  (select booking_hold_expired_message_template from public.app_settings where id = true)
    like '%no recibimos el comprobante%',
  'el vencimiento de la pre-reserva usa voz institucional'
);
select ok(
  not exists (
    select 1
    from public.app_settings settings
    where settings.id = true
      and not (
        public.automatic_patient_message_avoids_gisela_impersonation(settings.automation_welcome_message)
        and public.automatic_patient_message_avoids_gisela_impersonation(settings.out_of_hours_message)
        and public.automatic_patient_message_avoids_gisela_impersonation(settings.urgent_message)
        and public.automatic_patient_message_avoids_gisela_impersonation(settings.general_info_message)
        and public.automatic_patient_message_avoids_gisela_impersonation(settings.deposit_request_message_template)
        and public.automatic_patient_message_avoids_gisela_impersonation(settings.deposit_proof_received_message_template)
        and public.automatic_patient_message_avoids_gisela_impersonation(settings.deposit_confirmed_message_template)
        and public.automatic_patient_message_avoids_gisela_impersonation(settings.booking_hold_expired_message_template)
      )
  ),
  'todos los mensajes configurables automáticos evitan la suplantación'
);

select throws_ok(
  $$update public.app_settings
    set deposit_confirmed_message_template =
      'Tu turno quedó confirmado para {date}: {placeholder_desconocido}.'
    where id = true$$,
  '23514',
  null,
  'la confirmación rechaza placeholders desconocidos'
);
select throws_ok(
  $$update public.app_settings
    set deposit_request_message_template =
      'Transferí {deposit_amount} a {cuenta_no_admitida}.'
    where id = true$$,
  '23514',
  null,
  'el pedido de seña admite sólo monto, alias y titular'
);
select throws_ok(
  $$update public.app_settings
    set deposit_proof_received_message_template = 'Recibimos {operation_id}.'
    where id = true$$,
  '23514',
  null,
  'el acuse del comprobante no admite placeholders'
);

select is((select title from public.quick_replies where shortcut = '/horarios'), 'Mis horarios de atención', 'conserva el título manual de horarios');
select is(
  (select body from public.quick_replies where shortcut = '/horarios'),
  'Atiendo con turno: lunes de 9:30 a 15, martes de 13:30 a 17, miércoles de 9:30 a 12 y de 16 a 21, jueves de 10 a 15 y viernes de 9:30 a 11.',
  'conserva la respuesta rápida manual de horarios'
);
select is((select title from public.quick_replies where shortcut = '/ubicacion'), 'Ubicación de mi consultorio', 'conserva el título manual de ubicación');
select is(
  (select body from public.quick_replies where shortcut = '/ubicacion'),
  E'Mi consultorio está en Calle 11 1375, Miramar, Provincia de Buenos Aires, Argentina.\n\nMapa: https://www.google.com/maps/search/?api=1&query=Centro%20de%20Atenci%C3%B3n%20Profesional%20%28C.A.P.%29&query_place_id=ChIJK5iJNYYQhZURBREHhxeQ9PQ',
  'conserva la respuesta rápida manual de ubicación con su mapa'
);
select is((select title from public.quick_replies where shortcut = '/espera'), 'En breve te respondo', 'conserva el título manual de espera');
select is((select body from public.quick_replies where shortcut = '/espera'), 'Recibí tu mensaje. Te respondo en breve.', 'conserva la respuesta rápida manual de espera');
select lives_ok(
  $$update public.quick_replies
    set body = 'Soy Gisela y te respondo personalmente.'
    where shortcut = '/espera'$$,
  'la política automática no reescribe ni bloquea respuestas humanas'
);

select is((select body_preview from public.message_templates where key = 'appointment_created'), 'Tu turno quedó reservado.', 'la plantilla de reserva usa una forma neutral');
select is((select body_preview from public.message_templates where key = 'appointment_reminder_24h'), 'Te recordamos tu turno de mañana.', 'el recordatorio de 24 horas usa voz institucional');
select is((select body_preview from public.message_templates where key = 'appointment_reminder_2h'), 'Te recordamos que tu turno es dentro de dos horas.', 'el recordatorio de 2 horas usa voz institucional');
select is((select body_preview from public.message_templates where key = 'appointment_cancelled'), 'Tu turno quedó cancelado.', 'la plantilla de cancelación usa una forma neutral');
select is((select body_preview from public.message_templates where key = 'appointment_rescheduled'), 'Tu turno quedó reprogramado.', 'la plantilla de reprogramación usa una forma neutral');
select ok(
  not exists (
    select 1 from public.message_templates
    where key in ('appointment_created', 'appointment_reminder_24h', 'appointment_reminder_2h', 'appointment_cancelled', 'appointment_rescheduled')
      and meta_name !~ '_v3$'
  ),
  'las plantillas institucionales usan nombres Meta v3'
);
select is(
  (
    select jsonb_object_agg(key, meta_name)
    from public.message_templates
    where key in (
      'appointment_created',
      'appointment_reminder_24h',
      'appointment_reminder_2h',
      'appointment_cancelled',
      'appointment_rescheduled'
    )
  ),
  jsonb_build_object(
    'appointment_created', 'gisela_appointment_created_v3',
    'appointment_reminder_24h', 'gisela_appointment_reminder_24h_v3',
    'appointment_reminder_2h', 'gisela_appointment_reminder_2h_v3',
    'appointment_cancelled', 'gisela_appointment_cancelled_v3',
    'appointment_rescheduled', 'gisela_appointment_rescheduled_v3'
  ),
  'cada flujo conserva el nombre Meta v3 esperado'
);
select ok(
  not exists (
    select 1 from public.message_templates
    where key in ('appointment_created', 'appointment_reminder_24h', 'appointment_reminder_2h', 'appointment_cancelled', 'appointment_rescheduled')
      and enabled
  ),
  'las plantillas v3 esperan aprobación antes de habilitarse'
);
select ok(
  not exists (
    select 1 from public.message_templates
    where key in ('appointment_created', 'appointment_reminder_24h', 'appointment_reminder_2h', 'appointment_cancelled', 'appointment_rescheduled')
      and (
        meta_template_id is not null
        or meta_status <> 'UNVERIFIED'
        or quality_rating is not null
        or last_synced_at is not null
      )
  ),
  'ninguna plantilla v3 hereda aprobación o calidad de v2'
);
select ok(
  not exists (
    select 1 from public.message_templates
    where key in ('appointment_created', 'appointment_reminder_24h', 'appointment_reminder_2h', 'appointment_cancelled', 'appointment_rescheduled')
      and not public.automatic_patient_message_avoids_gisela_impersonation(body_preview)
  ),
  'todos los previews predefinidos evitan la suplantación'
);

select throws_ok(
  $$update public.app_settings set automation_welcome_message = 'Hola, soy Gisela.' where id = true$$,
  '23514',
  null,
  'la base rechaza suplantación en settings automáticos'
);
select throws_ok(
  $$update public.message_templates
    set body_preview = 'Confirmé tu turno.', enabled = true
    where key = 'appointment_created'$$,
  '23514',
  null,
  'la base rechaza suplantación en plantillas automáticas'
);
select lives_ok(
  $$insert into public.message_templates (
      key, meta_name, language_code, category, body_preview, enabled
    ) values (
      'voice_test_custom', 'voice_test_custom', 'es_AR', 'UTILITY',
      'Soy Gisela y confirmé tu turno.', false
    )$$,
  'una plantilla personalizada incompatible puede conservarse apagada para revisión'
);
select throws_ok(
  $$update public.message_templates
    set enabled = true
    where key = 'voice_test_custom'$$,
  '23514',
  null,
  'ninguna plantilla automática incompatible puede habilitarse'
);
select is(
  to_regprocedure('public.gisela_patient_message_uses_singular_voice(text)'),
  null,
  'la antigua política singular ya no queda activa'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.automatic_patient_message_avoids_gisela_impersonation(text)',
    'EXECUTE'
  )
    and has_function_privilege(
      'authenticated',
      'public.automatic_patient_message_avoids_gisela_impersonation(text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.automatic_patient_message_avoids_gisela_impersonation(text)',
      'EXECUTE'
    ),
  'la función de política conserva privilegios mínimos explícitos'
);

select * from finish();

rollback;
