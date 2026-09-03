\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(17);

select ok(
  has_function_privilege('authenticated', 'public.admin_confirm_appointment_deposit(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_confirm_appointment_deposit(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_deposit_proof_review(uuid,uuid,timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.claim_deposit_proof_review(uuid,uuid,timestamptz)', 'EXECUTE'),
  'la decisión humana es de un usuario autenticado y el acuse es del worker'
);

select ok(
  has_table_privilege('authenticated', 'public.deposit_proof_reviews', 'SELECT')
  and not has_table_privilege('authenticated', 'public.deposit_proof_reviews', 'UPDATE')
  and not has_table_privilege('anon', 'public.deposit_proof_reviews', 'SELECT'),
  'la cola de revisión se lee desde el panel pero no se edita a mano'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '96000000-0000-4000-8000-000000000001',
  'deposit-admin@example.test', '', 'authenticated', 'authenticated'
);
update public.profiles set role = 'ADMIN', active = true
where id = '96000000-0000-4000-8000-000000000001';

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '96000000-0000-4000-8000-000000000002',
  'deposit-operator@example.test', '', 'authenticated', 'authenticated'
);
update public.profiles set role = 'OPERADOR', active = true
where id = '96000000-0000-4000-8000-000000000002';

insert into public.professionals (id, name, appointment_duration_minutes, active)
values ('96000000-0000-4000-8000-000000000003', 'Profesional Seña', 30, true);

insert into public.contacts (id, phone_e164, name, coverage)
values (
  '96000000-0000-4000-8000-000000000004', '+5491100009601',
  'Paciente Seña Sintético', 'particular'
);

insert into public.conversations (id, contact_id, status, automation_mode, needs_human)
values (
  '96000000-0000-4000-8000-000000000005',
  '96000000-0000-4000-8000-000000000004',
  'open', 'manual', true
);

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status, hold_expires_at
) values (
  '96000000-0000-4000-8000-000000000006',
  '96000000-0000-4000-8000-000000000004',
  '96000000-0000-4000-8000-000000000003',
  clock_timestamp() + interval '9 days',
  clock_timestamp() + interval '9 days 60 minutes',
  'scheduled', 'manual', 'particular', 60, 'pending',
  -- Hold ya vencido: el flujo automático deja de poder confirmar acá.
  clock_timestamp() - interval '1 hour'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status,
  whatsapp_message_id
) values (
  '96000000-0000-4000-8000-000000000007',
  '96000000-0000-4000-8000-000000000005',
  '96000000-0000-4000-8000-000000000004',
  'inbound', 'image', 'Comprobante sintético de prueba', 'delivered',
  'wamid.sintetico.deposito.1'
);

-- ---------------------------------------------------------------------------
-- Acuse de recibo idempotente
-- ---------------------------------------------------------------------------

select ok(
  (
    select claim.recognized and claim.acknowledge
      and claim.appointment_id = '96000000-0000-4000-8000-000000000006'
    from public.claim_deposit_proof_review(
      '96000000-0000-4000-8000-000000000004',
      '96000000-0000-4000-8000-000000000007',
      clock_timestamp()
    ) claim
  ),
  'el primer comprobante se asocia al turno y habilita un acuse de recibo'
);

-- Mientras el acuse no se haya entregado, un reintento debe volver a
-- intentarlo: darlo por enviado dejaría al paciente sin ninguna respuesta.
select ok(
  (
    select claim.recognized and claim.acknowledge
    from public.claim_deposit_proof_review(
      '96000000-0000-4000-8000-000000000004',
      '96000000-0000-4000-8000-000000000007',
      clock_timestamp()
    ) claim
  ),
  'un acuse todavía sin entregar se puede reintentar'
);

select ok(
  public.mark_deposit_proof_acknowledged(
    '96000000-0000-4000-8000-000000000007'
  ),
  'el acuse se marca recién después de entregarlo'
);

select ok(
  (
    select claim.recognized and not claim.acknowledge
    from public.claim_deposit_proof_review(
      '96000000-0000-4000-8000-000000000004',
      '96000000-0000-4000-8000-000000000007',
      clock_timestamp()
    ) claim
  ),
  'entregado el acuse, reprocesar el mismo archivo no vuelve a saludar'
);

select is(
  (
    select count(*)::integer from public.deposit_proof_reviews
    where proof_message_id = '96000000-0000-4000-8000-000000000007'
  ),
  1,
  'un comprobante genera una sola fila de revisión'
);

select ok(
  (
    select deposit_status = 'pending' and status = 'scheduled'
      and deposit_proof_message_id = '96000000-0000-4000-8000-000000000007'
    from public.appointments
    where id = '96000000-0000-4000-8000-000000000006'
  ),
  'el acuse enlaza la evidencia sin confirmar la seña ni mover el turno'
);

-- ---------------------------------------------------------------------------
-- Confirmación manual
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"96000000-0000-4000-8000-000000000002"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '96000000-0000-4000-8000-000000000002', true);

select throws_ok(
  'select * from public.admin_confirm_appointment_deposit(''96000000-0000-4000-8000-000000000006'')',
  '42501',
  null,
  'una persona sin rol ADMIN no puede confirmar una seña'
);

select throws_ok(
  'select * from public.admin_review_deposit_proof(''96000000-0000-4000-8000-000000000006'', ''rejected'', null)',
  '42501',
  null,
  'una persona sin rol ADMIN tampoco puede rechazar un comprobante'
);

-- El flujo automático ya no puede confirmar esta pre-reserva: el hold venció y
-- el estado de la seña nunca llegó a `proof_received` porque el OCR falló.
select throws_ok(
  'select public.confirm_appointment_deposit(''96000000-0000-4000-8000-000000000006'')',
  'P0001',
  null,
  'la confirmación histórica sigue exigiendo un comprobante ya validado'
);

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"96000000-0000-4000-8000-000000000001"}', true);
select set_config('request.jwt.claim.sub', '96000000-0000-4000-8000-000000000001', true);

select ok(
  (
    select not confirmation.already_confirmed
      and confirmation.appointment_id = '96000000-0000-4000-8000-000000000006'
    from public.admin_confirm_appointment_deposit(
      '96000000-0000-4000-8000-000000000006'
    ) confirmation
  ),
  'ADMIN confirma manualmente aunque el OCR haya fallado y el hold esté vencido'
);

select ok(
  (
    select status = 'confirmed' and deposit_status = 'confirmed'
      and deposit_confirmed_by = '96000000-0000-4000-8000-000000000001'
      and deposit_confirmation_actor is null
    from public.appointments
    where id = '96000000-0000-4000-8000-000000000006'
  ),
  'la confirmación manual queda auditada como decisión humana'
);

select is(
  (
    select status from public.deposit_proof_reviews
    where proof_message_id = '96000000-0000-4000-8000-000000000007'
  ),
  'confirmed',
  'el comprobante queda marcado como revisado'
);

select ok(
  (
    select confirmation.already_confirmed
    from public.admin_confirm_appointment_deposit(
      '96000000-0000-4000-8000-000000000006'
    ) confirmation
  ),
  'confirmar dos veces es idempotente y no vuelve a auditar'
);

select is(
  (
    select count(*)::integer from public.audit_logs
    where entity_id = '96000000-0000-4000-8000-000000000006'
      and action = 'deposit.confirmed_manually'
  ),
  1,
  'la confirmación se audita una sola vez'
);

select is(
  (
    select count(*)::integer from public.google_calendar_sync_jobs
    where appointment_id = '96000000-0000-4000-8000-000000000006'
  ),
  0,
  'sin Google Calendar conectado no se encola nada; la cola no duplica filas'
);

select * from finish();
rollback;
