\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(48);

select ok(
  public.gisela_patient_message_uses_singular_voice(
    'Soy Gisela. Mi consultorio está en Miramar y te respondo por este WhatsApp.'
  ),
  'acepta la presentación y la primera persona singular'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Recibimos tu mensaje y te responderemos en breve.'
  ),
  false,
  'rechaza la voz institucional plural'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Te responderemos en breve.'
  ),
  false,
  'rechaza responderemos aunque no haya otro verbo plural'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Confirmaremos tu turno cuando llegue el comprobante.'
  ),
  false,
  'rechaza confirmaremos'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Te enviaremos la ubicación.'
  ),
  false,
  'rechaza enviaremos'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Tendremos disponibilidad mañana.'
  ),
  false,
  'rechaza futuros plurales irregulares'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Te responderíamos mañana.'
  ),
  false,
  'rechaza condicionales institucionales plurales'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Cuando podamos, te confirmo.'
  ),
  false,
  'rechaza subjuntivos institucionales plurales'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'La dentista te responde mañana.'
  ),
  false,
  'rechaza sinónimos que presentan a Gisela en tercera persona'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Te respondimos ayer.'
  ),
  false,
  'rechaza pretéritos institucionales plurales'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Te contestamos en breve.'
  ),
  false,
  'rechaza verbos institucionales plurales no enumerados'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'La Dra. Lentz te responde mañana.'
  ),
  false,
  'rechaza el apellido profesional en tercera persona'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Podés escribirnos por WhatsApp.'
  ),
  false,
  'rechaza infinitivos con pronombre plural'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Podés contactarnos cuando quieras.'
  ),
  false,
  'rechaza otros infinitivos con pronombre plural'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Dejanos ayudarte.'
  ),
  false,
  'rechaza imperativos con pronombre plural'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'La Dra. te responde mañana.'
  ),
  false,
  'rechaza el título profesional aislado en tercera persona'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Escríbenos por WhatsApp.'
  ),
  false,
  'rechaza imperativos de tuteo con pronombre plural'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Contáctenos por WhatsApp.'
  ),
  false,
  'rechaza imperativos formales con pronombre plural'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Confirmémoslo ahora.'
  ),
  false,
  'rechaza conjugaciones plurales con otro pronombre enclítico'
);

select ok(
  public.gisela_patient_message_uses_singular_voice(
    'Mi consultorio está entre dos puntos extremos.'
  ),
  'no confunde extremos con un futuro plural'
);

select ok(
  public.gisela_patient_message_uses_singular_voice(
    'Los próximos horarios disponibles son el lunes y el martes.'
  ),
  'no confunde próximos con un verbo plural'
);

select ok(
  public.gisela_patient_message_uses_singular_voice(
    'Atiendo consultas sobre traumatismos dentales.'
  ),
  'no confunde vocabulario odontológico con un verbo plural'
);

select ok(
  public.gisela_patient_message_uses_singular_voice(
    'Trabajo con insumos descartables.'
  ),
  'no confunde insumos con un verbo plural'
);

select ok(
  public.gisela_patient_message_uses_singular_voice(
    'Realizo pernos y coronas.'
  ),
  'no confunde pernos con un infinitivo y pronombre plural'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Gisela lo revisa y la odontóloga te responde.'
  ),
  false,
  'rechaza referencias a Gisela en tercera persona'
);

select is(
  public.gisela_patient_message_uses_singular_voice(
    'Gisela confirmó tu turno y te responderá en breve.'
  ),
  false,
  'rechaza a Gisela en tercera persona sin depender del tiempo verbal'
);

select is(
  (select automation_welcome_message from public.app_settings where id = true),
  '¡Hola! Soy Gisela 😊 Para agendar tu turno voy a pedirte algunos datos.',
  'el saludo vigente habla directamente como Gisela'
);

select ok(
  not exists (
    select 1
    from public.app_settings settings
    where settings.id = true
      and not (
        public.gisela_patient_message_uses_singular_voice(settings.automation_welcome_message)
        and public.gisela_patient_message_uses_singular_voice(settings.out_of_hours_message)
        and public.gisela_patient_message_uses_singular_voice(settings.urgent_message)
        and public.gisela_patient_message_uses_singular_voice(settings.general_info_message)
        and public.gisela_patient_message_uses_singular_voice(settings.deposit_request_message_template)
        and public.gisela_patient_message_uses_singular_voice(settings.deposit_proof_received_message_template)
        and public.gisela_patient_message_uses_singular_voice(settings.deposit_confirmed_message_template)
        and public.gisela_patient_message_uses_singular_voice(settings.booking_hold_expired_message_template)
      )
  ),
  'todos los mensajes configurables respetan la voz singular'
);

select throws_ok(
  $$update public.app_settings
    set deposit_confirmed_message_template =
      'Confirmé tu turno para {date}: {placeholder_desconocido}.'
    where id = true$$,
  '23514',
  null,
  'la confirmación rechaza placeholders que el flujo no puede renderizar'
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
    set deposit_proof_received_message_template =
      'Recibí {operation_id}.'
    where id = true$$,
  '23514',
  null,
  'el acuse de comprobante no admite placeholders residuales'
);

select is(
  (select title from public.quick_replies where shortcut = '/horarios'),
  'Mis horarios de atención',
  'la respuesta rápida de horarios tiene título singular'
);
select is(
  (select body from public.quick_replies where shortcut = '/horarios'),
  'Atiendo con turno: lunes de 9:30 a 15, martes de 13:30 a 17, miércoles de 9:30 a 12 y de 16 a 21, jueves de 10 a 15 y viernes de 9:30 a 11.',
  'la respuesta rápida de horarios habla como Gisela'
);
select is(
  (select title from public.quick_replies where shortcut = '/ubicacion'),
  'Ubicación de mi consultorio',
  'la respuesta rápida de ubicación tiene título singular'
);
select is(
  (select body from public.quick_replies where shortcut = '/ubicacion'),
  'Mi consultorio está en calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires.',
  'la respuesta rápida de ubicación habla como Gisela'
);
select is(
  (select title from public.quick_replies where shortcut = '/espera'),
  'En breve te respondo',
  'la respuesta rápida de espera tiene título singular'
);
select is(
  (select body from public.quick_replies where shortcut = '/espera'),
  'Recibí tu mensaje. Te respondo en breve.',
  'la respuesta rápida de espera habla como Gisela'
);
select ok(
  not exists (
    select 1 from public.quick_replies
    where enabled
      and not public.gisela_patient_message_uses_singular_voice(body)
  ),
  'ninguna respuesta rápida habilitada usa voz institucional o tercera persona'
);

select is(
  (select body_preview from public.message_templates where key = 'appointment_created'),
  'Reservé tu turno.',
  'la plantilla de reserva usa primera persona singular'
);
select is(
  (select body_preview from public.message_templates where key = 'appointment_reminder_24h'),
  'Te recuerdo tu turno de mañana.',
  'la plantilla de recordatorio de 24 horas usa primera persona singular'
);
select is(
  (select body_preview from public.message_templates where key = 'appointment_reminder_2h'),
  'Te recuerdo que tu turno es dentro de dos horas.',
  'la plantilla de recordatorio de 2 horas usa primera persona singular'
);
select is(
  (select body_preview from public.message_templates where key = 'appointment_cancelled'),
  'Cancelé tu turno.',
  'la plantilla de cancelación usa primera persona singular'
);
select is(
  (select body_preview from public.message_templates where key = 'appointment_rescheduled'),
  'Reprogramé tu turno.',
  'la plantilla de reprogramación usa primera persona singular'
);
select is(
  (select meta_name from public.message_templates where key = 'appointment_reminder_24h'),
  'gisela_appointment_reminder_24h_v2',
  'el recordatorio de 24 horas no reutiliza la plantilla institucional anterior'
);
select is(
  (select meta_name from public.message_templates where key = 'appointment_reminder_2h'),
  'gisela_appointment_reminder_2h_v2',
  'el recordatorio de 2 horas no reutiliza la plantilla institucional anterior'
);
select ok(
  not exists (
    select 1 from public.message_templates
    where key in ('appointment_reminder_24h', 'appointment_reminder_2h')
      and enabled
  ),
  'las nuevas plantillas de recordatorio esperan aprobación antes de habilitarse'
);
select ok(
  not exists (
    select 1 from public.message_templates
    where key in (
      'appointment_created',
      'appointment_reminder_24h',
      'appointment_reminder_2h',
      'appointment_cancelled',
      'appointment_rescheduled'
    )
      and (
        meta_template_id is not null
        or meta_status <> 'UNVERIFIED'
        or quality_rating is not null
      )
  ),
  'ninguna plantilla v2 hereda aprobación o calidad de una versión anterior'
);
select ok(
  not exists (
    select 1 from public.message_templates
    where enabled
      and not public.gisela_patient_message_uses_singular_voice(body_preview)
  ),
  'ninguna plantilla habilitada usa voz institucional o tercera persona'
);

select * from finish();

rollback;
