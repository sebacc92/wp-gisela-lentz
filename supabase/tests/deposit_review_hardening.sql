\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(9);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '99000000-0000-4000-8000-000000000001',
  'hardening-admin@example.test', '', 'authenticated', 'authenticated'
);
update public.profiles set role = 'ADMIN', active = true
where id = '99000000-0000-4000-8000-000000000001';

insert into public.professionals (id, name, appointment_duration_minutes, active)
values ('99000000-0000-4000-8000-000000000002', 'Profesional Hardening', 30, true);

-- Dos pacientes distintos: un comprobante nunca puede cruzarse entre ellos.
insert into public.contacts (id, phone_e164, name, coverage)
values
  ('99000000-0000-4000-8000-000000000003', '+5491100009901', 'Paciente A', 'particular'),
  ('99000000-0000-4000-8000-000000000013', '+5491100009902', 'Paciente B', 'particular');

insert into public.conversations (id, contact_id, status, automation_mode, needs_human)
values
  ('99000000-0000-4000-8000-000000000005', '99000000-0000-4000-8000-000000000003', 'open', 'manual', true),
  ('99000000-0000-4000-8000-000000000015', '99000000-0000-4000-8000-000000000013', 'open', 'auto', false);

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status, hold_expires_at
) values (
  '99000000-0000-4000-8000-000000000006',
  '99000000-0000-4000-8000-000000000003',
  '99000000-0000-4000-8000-000000000002',
  clock_timestamp() + interval '9 days',
  clock_timestamp() + interval '9 days 60 minutes',
  'scheduled', 'manual', 'particular', 60, 'pending',
  clock_timestamp() - interval '1 hour'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status,
  whatsapp_message_id
) values (
  '99000000-0000-4000-8000-000000000016',
  '99000000-0000-4000-8000-000000000015',
  '99000000-0000-4000-8000-000000000013',
  'inbound', 'image', 'Comprobante sintético del paciente B', 'delivered',
  'wamid.sintetico.hardening.b'
);

-- ---------------------------------------------------------------------------
-- Un comprobante no puede asociarse al turno de otra persona
-- ---------------------------------------------------------------------------

select throws_ok(
  $sql$select * from public.claim_deposit_proof_review(
    '99000000-0000-4000-8000-000000000003',
    '99000000-0000-4000-8000-000000000016',
    clock_timestamp()
  )$sql$,
  '22023',
  null,
  'un mensaje de otro contacto no se puede reclamar como comprobante propio'
);

select ok(
  (
    select not claim.recognized and claim.appointment_id is null
    from public.claim_deposit_proof_review(
      '99000000-0000-4000-8000-000000000013',
      '99000000-0000-4000-8000-000000000016',
      clock_timestamp()
    ) claim
  ),
  'el comprobante del paciente B no se asocia al turno del paciente A'
);

select is(
  (
    select deposit_proof_message_id from public.appointments
    where id = '99000000-0000-4000-8000-000000000006'
  ),
  null,
  'el turno del paciente A queda sin evidencia ajena enlazada'
);

-- ---------------------------------------------------------------------------
-- Hold vencido: no se confirma saltando la disponibilidad
-- ---------------------------------------------------------------------------

do $calendar_connect$
declare
  oauth_attempt record;
  candidate_id uuid;
begin
  perform public.create_google_calendar_oauth_state(
    '99000000-0000-4000-8000-000000000001', repeat('a', 64),
    repeat('v', 64), clock_timestamp() + interval '10 minutes'
  );
  select * into oauth_attempt
  from public.consume_google_calendar_oauth_state(repeat('a', 64));
  select candidate.candidate_id into candidate_id
  from public.stage_google_calendar_connection_candidate(
    '99000000-0000-4000-8000-000000000001',
    'google-user-hardening', 'hardening@example.test',
    'fake-refresh-token-for-hardening-test',
    oauth_attempt.connection_generation,
    oauth_attempt.oauth_attempt_generation
  ) candidate;
  perform 1 from public.get_google_calendar_connection_candidate_secret(
    '99000000-0000-4000-8000-000000000001'
  );
  perform public.finalize_google_calendar_connection_selection(
    '99000000-0000-4000-8000-000000000001',
    candidate_id,
    'calendar-hardening', 'Gisela Lentz · Turnos',
    'America/Argentina/Buenos_Aires'
  );
end;
$calendar_connect$;

-- Un bloqueo importado ocupa exactamente el horario de la pre-reserva vencida.
insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind, status,
  summary, starts_at, ends_at, content_hash
)
select 'calendar-hardening', 'bloque-sobre-el-turno',
       connection.connection_generation, 'block', 'active',
       'Evento sintético superpuesto',
       appointment.starts_at, appointment.ends_at, md5('bloqueo')
from public.google_calendar_connections connection,
     public.appointments appointment
where connection.id = true
  and appointment.id = '99000000-0000-4000-8000-000000000006';

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"99000000-0000-4000-8000-000000000001"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '99000000-0000-4000-8000-000000000001', true);

select throws_ok(
  'select * from public.admin_confirm_appointment_deposit(''99000000-0000-4000-8000-000000000006'')',
  'P0001',
  'SLOT_NO_LONGER_AVAILABLE',
  'con el hold vencido y el horario ocupado la confirmación se rechaza con un motivo'
);

select is(
  (
    select status::text from public.appointments
    where id = '99000000-0000-4000-8000-000000000006'
  ),
  'scheduled',
  'el turno no queda confirmado sobre un horario ya reservado'
);

-- Liberado el horario, la misma persona ADMIN sí puede confirmar.
update public.google_calendar_external_events
set status = 'removed', removed_at = clock_timestamp()
where google_event_id = 'bloque-sobre-el-turno';

select ok(
  (
    select not confirmation.already_confirmed
    from public.admin_confirm_appointment_deposit(
      '99000000-0000-4000-8000-000000000006'
    ) confirmation
  ),
  'liberado el horario, la confirmación manual procede'
);

-- La revisión es una decisión del operador, no una acreditación bancaria.
select ok(
  (
    select metadata ->> 'decision' = 'operator_manual_review'
      and (metadata ->> 'verifies_bank_transfer')::boolean = false
      and (metadata ->> 'hold_expired')::boolean = true
      and actor_user_id = '99000000-0000-4000-8000-000000000001'
    from public.audit_logs
    where entity_id = '99000000-0000-4000-8000-000000000006'
      and action = 'deposit.confirmed_manually'
  ),
  'la auditoría registra quién decidió y que no se verificó ninguna transferencia'
);

-- ---------------------------------------------------------------------------
-- Hold vencido sobre un turno que ya pasó
-- ---------------------------------------------------------------------------

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status, hold_expires_at
) values (
  '99000000-0000-4000-8000-000000000026',
  '99000000-0000-4000-8000-000000000013',
  '99000000-0000-4000-8000-000000000002',
  clock_timestamp() - interval '3 hours',
  clock_timestamp() - interval '2 hours',
  'scheduled', 'manual', 'particular', 60, 'pending',
  clock_timestamp() - interval '4 hours'
);

select throws_ok(
  'select * from public.admin_confirm_appointment_deposit(''99000000-0000-4000-8000-000000000026'')',
  'P0001',
  'APPOINTMENT_ALREADY_STARTED',
  'una pre-reserva vencida cuyo horario ya pasó explica que hay que reprogramar'
);

select is(
  (
    select count(*)::integer from public.audit_logs
    where entity_id = '99000000-0000-4000-8000-000000000026'
      and action = 'deposit.confirmed_manually'
  ),
  0,
  'un rechazo no deja auditoría de confirmación'
);

select * from finish();
rollback;
