-- Datos exclusivamente locales y ficticios para `supabase db reset`.
-- No ejecutar este archivo en producción.

-- El seed recrea conversaciones históricas de demostración. Sólo el rol de
-- administración de la base puede activar este bypass; las API roles no pueden.
select set_config('app.whatsapp_policy_seed_bypass', 'on', true);

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

insert into public.services (
  id, name, description, duration_minutes, active, sort_order
)
values
  ('51000000-0000-4000-8000-000000000001', 'Consulta', null, 30, true, 10),
  ('51000000-0000-4000-8000-000000000002', 'Control', null, 30, true, 20),
  ('51000000-0000-4000-8000-000000000003', 'Limpieza', null, 45, true, 30),
  ('51000000-0000-4000-8000-000000000004', 'Urgencia / dolor', null, 30, true, 40),
  ('51000000-0000-4000-8000-000000000005', 'Extracción', null, 60, true, 50),
  ('51000000-0000-4000-8000-000000000006', 'Blanqueamiento', null, 60, true, 60),
  ('51000000-0000-4000-8000-000000000007', 'Ortodoncia', null, 45, true, 70)
on conflict (id) do update
set name = excluded.name,
    description = excluded.description,
    duration_minutes = excluded.duration_minutes,
    active = excluded.active,
    sort_order = excluded.sort_order;

-- Horario ilustrativo local. Debe reemplazarse por el horario real antes de
-- conectar automatizaciones productivas.
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

insert into public.contacts (
  id, phone_e164, whatsapp_id, name, email, administrative_notes,
  coverage, is_existing_patient, last_message_at
)
values
  (
    '20000000-0000-4000-8000-000000000001',
    '+5491100000001',
    '5491100000001',
    'María López',
    'maria.lopez@example.com',
    'Prefiere turnos por la mañana.',
    'ioma',
    true,
    now() - interval '20 minutes'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '+5491100000002',
    '5491100000002',
    'Juan Pérez',
    null,
    null,
    'particular',
    false,
    now() - interval '1 hour'
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    '+5491100000003',
    '5491100000003',
    'Ana García',
    'ana.garcia@example.com',
    null,
    'ioma',
    true,
    now() - interval '1 day'
  );

insert into public.conversations (
  id, contact_id, automation_mode, needs_human, priority,
  last_message_at, last_inbound_message_at, unread_count
)
values
  (
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'manual', true, false,
    now() - interval '20 minutes', now() - interval '20 minutes', 0
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'auto', false, false,
    now() - interval '1 hour', now() - interval '1 hour', 0
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000003',
    'manual', true, true,
    now() - interval '1 day', now() - interval '1 day', 0
  );

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status,
  idempotency_key, created_at
)
values
  (
    '31000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'outbound', 'text',
    'Hola 👋 Soy el asistente virtual de Gisela Lentz. ¿En qué podemos ayudarte?',
    'read', 'seed:message:1', now() - interval '28 minutes'
  ),
  (
    '31000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'inbound', 'text', 'Necesito reprogramar mi turno.',
    'delivered', null, now() - interval '20 minutes'
  ),
  (
    '31000000-0000-4000-8000-000000000003',
    '30000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'outbound', 'text', '¡Listo! Tu turno quedó reservado.',
    'read', 'seed:message:3', now() - interval '70 minutes'
  ),
  (
    '31000000-0000-4000-8000-000000000004',
    '30000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'inbound', 'text', 'Muchas gracias.',
    'delivered', null, now() - interval '1 hour'
  ),
  (
    '31000000-0000-4000-8000-000000000005',
    '30000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000003',
    'inbound', 'document', 'Comprobante-demo.pdf',
    'delivered', null, now() - interval '1 day'
  );

-- Los triggers incrementan unread_count al cargar mensajes; dejamos el estado
-- deseado para la demo.
update public.conversations
set unread_count = case id
  when '30000000-0000-4000-8000-000000000001' then 1
  when '30000000-0000-4000-8000-000000000003' then 1
  else 0
end;

insert into public.appointments (
  id, contact_id, professional_id, service_id,
  starts_at, ends_at, status, source, coverage, duration_minutes,
  deposit_status, hold_expires_at, deposit_proof_message_id,
  deposit_proof_received_at, hold_expired_notification_status
)
values
  (
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '67697365-6c61-4765-8a2d-6c656e747a01',
    '51000000-0000-4000-8000-000000000003',
    ((current_date + 1) + '09:00'::time) at time zone 'America/Argentina/Buenos_Aires',
    ((current_date + 1) + '09:30'::time) at time zone 'America/Argentina/Buenos_Aires',
    'confirmed', 'manual', 'ioma', 30, 'not_required', null, null, null,
    'not_applicable'
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    '67697365-6c61-4765-8a2d-6c656e747a01',
    '51000000-0000-4000-8000-000000000001',
    ((current_date + 2) + '10:30'::time) at time zone 'America/Argentina/Buenos_Aires',
    ((current_date + 2) + '11:30'::time) at time zone 'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'particular', 60, 'pending',
    now() + interval '60 minutes', null, null, 'pending'
  ),
  (
    '40000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000003',
    '67697365-6c61-4765-8a2d-6c656e747a01',
    '51000000-0000-4000-8000-000000000002',
    ((current_date + 3) + '16:00'::time) at time zone 'America/Argentina/Buenos_Aires',
    ((current_date + 3) + '16:30'::time) at time zone 'America/Argentina/Buenos_Aires',
    'scheduled', 'manual', 'ioma', 30, 'proof_received',
    now() + interval '60 minutes',
    '31000000-0000-4000-8000-000000000005', now() - interval '1 day',
    'cancelled'
  );

select set_config('app.whatsapp_policy_seed_bypass', 'off', true);
