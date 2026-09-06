\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(51);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

update public.app_settings set automations_enabled = true where id;

-- These proof tests observe a synthetic Calendar; disconnected booking is no
-- longer a supported operational state. No real API requests are performed.
\ir _support/calendar-ready.inc

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '98000000-0000-4000-8000-000000000099',
  'automated-deposit-operator@example.test', '',
  'authenticated', 'authenticated'
);

select (
  current_date + 7 + mod(8 - extract(isodow from current_date)::integer, 7)
)::date as test_date
\gset

update public.app_settings
set deposit_enabled = true,
    deposit_amount_ars = 10000,
    deposit_alias = 'odontologa.gisela.mp',
    deposit_holder = 'Gisela Vanesa Lentz',
    booking_hold_minutes = 60,
    reminder_24h_enabled = false,
    reminder_2h_enabled = false
where id = true;

insert into public.professionals (
  id, name, specialty, appointment_duration_minutes, active
) values (
  '98000000-0000-4000-8000-000000000001',
  'Gisela Automated Deposit Test', 'Odontología', 30, true
);

insert into public.services (
  id, name, duration_minutes, active, sort_order
) values (
  '98000000-0000-4000-8000-000000000002',
  'Automated Deposit Test', 30, true, 9800
);

insert into public.whatsapp_coexistence_accounts (
  id, client_scope, waba_id, phone_number_id,
  coexistence_status, onboarding_status
) values (
  '98000000-0000-4000-8000-000000000060',
  'automated-deposit-account-block-test',
  '980000000000060', '980000000000061',
  'onboarding', 'failed'
);

insert into public.contacts (
  id, phone_e164, whatsapp_id, name, coverage, is_existing_patient
) values
  (
    '98000000-0000-4000-8000-000000000010', '+5491100009810',
    '5491100009810', 'Auto Confirm Contact', 'ioma', true
  ),
  (
    '98000000-0000-4000-8000-000000000011', '+5491100009811',
    '5491100009811', 'Review Contact', 'ioma', true
  ),
  (
    '98000000-0000-4000-8000-000000000012', '+5491100009812',
    '5491100009812', 'Manual Review Contact', 'ioma', true
  ),
  (
    '98000000-0000-4000-8000-000000000013', '+5491100009813',
    '5491100009813', 'Late Contact', 'ioma', true
  ),
  (
    '98000000-0000-4000-8000-000000000014', '+5491100009814',
    '5491100009814', 'Operator Pause Contact', 'ioma', true
  ),
  (
    '98000000-0000-4000-8000-000000000015', '+5491100009815',
    '5491100009815', 'Reupload Contact', 'ioma', true
  ),
  (
    '98000000-0000-4000-8000-000000000016', '+5491100009816',
    '5491100009816', 'Human Barrier Contact', 'ioma', true
  );

insert into public.conversations (
  id, contact_id, automation_mode, needs_human, priority,
  automation_pause_source, automation_pause_message_id,
  coexistence_account_id
) values
  (
    '98000000-0000-4000-8000-000000000020',
    '98000000-0000-4000-8000-000000000010',
    'auto', false, false, null, null, null
  ),
  (
    '98000000-0000-4000-8000-000000000021',
    '98000000-0000-4000-8000-000000000011',
    'auto', false, false, null, null, null
  ),
  (
    '98000000-0000-4000-8000-000000000022',
    '98000000-0000-4000-8000-000000000012',
    'auto', false, false, null, null, null
  ),
  (
    '98000000-0000-4000-8000-000000000023',
    '98000000-0000-4000-8000-000000000013',
    'auto', false, false, null, null, null
  ),
  (
    '98000000-0000-4000-8000-000000000024',
    '98000000-0000-4000-8000-000000000014',
    'auto', false, false, null, null, null
  ),
  (
    '98000000-0000-4000-8000-000000000025',
    '98000000-0000-4000-8000-000000000015',
    'auto', false, false, null, null,
    '98000000-0000-4000-8000-000000000060'
  ),
  (
    '98000000-0000-4000-8000-000000000026',
    '98000000-0000-4000-8000-000000000016',
    'auto', false, false, null, null, null
  );

insert into public.automation_sessions (
  conversation_id, state, context, expires_at
)
select conversation.id, 'waiting_deposit',
  jsonb_build_object(
    'appointmentId',
    case conversation.id
      when '98000000-0000-4000-8000-000000000020' then
        '98000000-0000-4000-8000-000000000030'
      when '98000000-0000-4000-8000-000000000021' then
        '98000000-0000-4000-8000-000000000031'
      when '98000000-0000-4000-8000-000000000022' then
        '98000000-0000-4000-8000-000000000032'
      when '98000000-0000-4000-8000-000000000023' then
        '98000000-0000-4000-8000-000000000033'
      when '98000000-0000-4000-8000-000000000024' then
        '98000000-0000-4000-8000-000000000034'
      when '98000000-0000-4000-8000-000000000025' then
        '98000000-0000-4000-8000-000000000035'
      else '98000000-0000-4000-8000-000000000039'
    end
  ),
  clock_timestamp() + interval '1 hour'
from public.conversations conversation
where conversation.id in (
  '98000000-0000-4000-8000-000000000020',
  '98000000-0000-4000-8000-000000000021',
  '98000000-0000-4000-8000-000000000022',
  '98000000-0000-4000-8000-000000000023',
  '98000000-0000-4000-8000-000000000024',
  '98000000-0000-4000-8000-000000000025',
  '98000000-0000-4000-8000-000000000026'
);

insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at,
  status, source, coverage, duration_minutes, deposit_status,
  hold_expires_at, hold_expired_notification_status
) values
  (
    '98000000-0000-4000-8000-000000000030',
    '98000000-0000-4000-8000-000000000010',
    '98000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '09:00') at time zone
      'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '09:30') at time zone
      'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'ioma', 30, 'pending',
    clock_timestamp() + interval '1 hour', 'pending'
  ),
  (
    '98000000-0000-4000-8000-000000000031',
    '98000000-0000-4000-8000-000000000011',
    '98000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '10:00') at time zone
      'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '10:30') at time zone
      'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'ioma', 30, 'pending',
    clock_timestamp() + interval '1 hour', 'pending'
  ),
  (
    '98000000-0000-4000-8000-000000000032',
    '98000000-0000-4000-8000-000000000012',
    '98000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '11:00') at time zone
      'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '11:30') at time zone
      'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'ioma', 30, 'pending',
    clock_timestamp() + interval '1 hour', 'pending'
  ),
  (
    '98000000-0000-4000-8000-000000000033',
    '98000000-0000-4000-8000-000000000013',
    '98000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '12:00') at time zone
      'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '12:30') at time zone
      'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'ioma', 30, 'pending',
    clock_timestamp() - interval '1 minute', 'pending'
  ),
  (
    '98000000-0000-4000-8000-000000000034',
    '98000000-0000-4000-8000-000000000014',
    '98000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '13:00') at time zone
      'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '13:30') at time zone
      'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'ioma', 30, 'pending',
    clock_timestamp() + interval '1 hour', 'pending'
  ),
  (
    '98000000-0000-4000-8000-000000000035',
    '98000000-0000-4000-8000-000000000015',
    '98000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '14:00') at time zone
      'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '14:30') at time zone
      'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'ioma', 30, 'pending',
    clock_timestamp() + interval '1 hour', 'pending'
  );

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, metadata,
  created_at
) values
  (
    '98000000-0000-4000-8000-000000000040',
    '98000000-0000-4000-8000-000000000020',
    '98000000-0000-4000-8000-000000000010',
    'inbound', 'image', 'Comprobante válido', 'delivered',
    jsonb_build_object(
      'media_sha256', repeat('a', 64),
      'preserved_concurrent_key', 'keep-me',
      'deposit_proof_reading',
      '{"legible":true,"amount":10000,"currency":"ARS","date":null,"destination":"odontologa.gisela.mp","holder":"Gisela Vanesa Lentz","operationId":"ok-1"}'::jsonb
    ),
    clock_timestamp()
  ),
  (
    '98000000-0000-4000-8000-000000000045',
    '98000000-0000-4000-8000-000000000021',
    '98000000-0000-4000-8000-000000000011',
    'inbound', 'text', 'No soy un archivo', 'delivered', '{}'::jsonb,
    clock_timestamp()
  ),
  (
    '98000000-0000-4000-8000-000000000049',
    '98000000-0000-4000-8000-000000000020',
    '98000000-0000-4000-8000-000000000010',
    'inbound', 'text', 'Mensaje posterior ya en cola', 'delivered',
    '{}'::jsonb, clock_timestamp()
  ),
  (
    '98000000-0000-4000-8000-000000000041',
    '98000000-0000-4000-8000-000000000021',
    '98000000-0000-4000-8000-000000000011',
    'inbound', 'image', 'Monto incorrecto', 'delivered', '{}'::jsonb,
    clock_timestamp()
  ),
  (
    '98000000-0000-4000-8000-000000000042',
    '98000000-0000-4000-8000-000000000022',
    '98000000-0000-4000-8000-000000000012',
    'inbound', 'document', 'Revisión solicitada.pdf', 'delivered', '{}'::jsonb,
    clock_timestamp()
  ),
  (
    '98000000-0000-4000-8000-000000000043',
    '98000000-0000-4000-8000-000000000023',
    '98000000-0000-4000-8000-000000000013',
    'inbound', 'image', 'Comprobante tardío', 'delivered', '{}'::jsonb,
    clock_timestamp()
  ),
  (
    '98000000-0000-4000-8000-000000000044',
    '98000000-0000-4000-8000-000000000024',
    '98000000-0000-4000-8000-000000000014',
    'inbound', 'image', 'Comprobante durante pausa', 'delivered', '{}'::jsonb,
    clock_timestamp()
  );

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000040', '{}'::jsonb, 900
)
\gset proof_claim_

select public.pause_whatsapp_automation_for_inbound_handoff(
  '98000000-0000-4000-8000-000000000040', false,
  'deposit_proof_received'
);
select public.pause_whatsapp_automation_for_inbound_handoff(
  '98000000-0000-4000-8000-000000000041', false,
  'deposit_proof_received'
);
select public.pause_whatsapp_automation_for_inbound_handoff(
  '98000000-0000-4000-8000-000000000042', false,
  'deposit_proof_received'
);
select public.pause_whatsapp_automation_for_inbound_handoff(
  '98000000-0000-4000-8000-000000000043', false,
  'deposit_proof_received'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.process_automated_deposit_proof(uuid,uuid,uuid,jsonb,text,text,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.process_automated_deposit_proof(uuid,uuid,uuid,jsonb,text,text,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.process_automated_deposit_proof(uuid,uuid,uuid,jsonb,text,text,boolean)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.route_automated_deposit_proof_to_review(uuid,uuid,uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.route_automated_deposit_proof_to_review(uuid,uuid,uuid,text)',
    'EXECUTE'
  ),
  'both automated proof RPCs are service-role only'
);

create function pg_temp.invalid_deposit_lease_rolls_back()
returns boolean
language plpgsql
as $$
declare
  blocked boolean := false;
begin
  begin
    perform public.process_automated_deposit_proof(
      '98000000-0000-4000-8000-000000000040',
      '99999999-9999-4999-8999-999999999999',
      '98000000-0000-4000-8000-000000000030',
      '{"legible":true,"amount":10000,"currency":"ARS","date":null,"destination":"odontologa.gisela.mp","holder":"Gisela Vanesa Lentz","operationId":"ok-1"}'::jsonb,
      repeat('a', 64), 'deposit-proof-basic/v1', true
    );
  exception
    when sqlstate '55000' then
      blocked := sqlerrm = 'WHATSAPP_AUTOMATION_EXECUTION_LEASE_INVALID';
  end;

  return blocked
    and exists (
      select 1 from public.appointments
      where id = '98000000-0000-4000-8000-000000000030'
        and status = 'scheduled'
        and deposit_status = 'pending'
        and deposit_proof_message_id is null
    )
    and not exists (
      select 1 from public.automated_deposit_proof_results
      where appointment_id = '98000000-0000-4000-8000-000000000030'
    )
    and not exists (
      select 1 from public.whatsapp_automation_effects
      where execution_message_id =
        '98000000-0000-4000-8000-000000000040'
        and effect_type = 'appointment_deposit_process'
    )
    and not (
      select metadata ? 'deposit_proof'
      from public.messages
      where id = '98000000-0000-4000-8000-000000000040'
    );
end;
$$;

select ok(
  pg_temp.invalid_deposit_lease_rolls_back(),
  'an invalid lease changes no appointment, ledger, metadata or effect'
);

-- La transferencia debe compararse con lo que se informó al crear el hold,
-- aunque la configuración comercial cambie antes de terminar el OCR.
update public.app_settings
set deposit_amount_ars = 12000,
    deposit_alias = 'nuevo.alias.no.anunciado',
    deposit_holder = 'Otra Titular Nueva'
where id = true;

update public.appointments
set starts_at = starts_at + interval '15 minutes',
    ends_at = ends_at + interval '15 minutes'
where id = '98000000-0000-4000-8000-000000000030';

select ok(
  (
    select deposit_expected_amount_ars = 10000
      and deposit_expected_alias = 'odontologa.gisela.mp'
      and deposit_expected_holder = 'Gisela Vanesa Lentz'
    from public.appointments
    where id = '98000000-0000-4000-8000-000000000030'
  ),
  'rescheduling a pending hold preserves the deposit data already announced'
);

select pg_temp.calendar_ready();
select pg_temp.calendar_projection_synced('98000000-0000-4000-8000-000000000030');

select public.process_automated_deposit_proof(
  '98000000-0000-4000-8000-000000000040',
  (select lease_token from public.whatsapp_automation_executions
   where message_id = '98000000-0000-4000-8000-000000000040'),
  '98000000-0000-4000-8000-000000000030',
  '{"legible":true,"amount":10000,"currency":"ARS","date":null,"destination":"odontologa.gisela.mp","holder":"Gisela Vanesa Lentz","operationId":"ok-1"}'::jsonb,
  repeat('a', 64), 'deposit-proof-basic/v1', true
) as result
\gset confirmed_

select ok(
  :'confirmed_result'::jsonb ->> 'status' = 'confirmed'
  and (:'confirmed_result'::jsonb #>>
    '{expected_deposit,amount_ars}')::integer = 10000
  and :'confirmed_result'::jsonb #>> '{expected_deposit,alias}' =
    'odontologa.gisela.mp'
  and (select deposit_amount_ars = 12000 from public.app_settings where id)
  and (:'confirmed_result'::jsonb ->> 'starts_at')::timestamptz = (
    select starts_at from public.appointments
    where id = '98000000-0000-4000-8000-000000000030'
  ),
  'proof uses the hold snapshot, not settings changed after it was announced'
);

update public.app_settings
set deposit_amount_ars = 10000,
    deposit_alias = 'odontologa.gisela.mp',
    deposit_holder = 'Gisela Vanesa Lentz'
where id = true;

select throws_ok(
  $$update public.appointments
    set deposit_expected_amount_ars = 12000
    where id = '98000000-0000-4000-8000-000000000030'$$,
  '23514',
  'APPOINTMENT_DEPOSIT_EXPECTATION_IMMUTABLE',
  'the economic snapshot cannot be rewritten after it was announced'
);

select throws_ok(
  $$update public.appointments
    set deposit_expected_alias = null
    where id = '98000000-0000-4000-8000-000000000030'$$,
  '23514',
  'APPOINTMENT_DEPOSIT_EXPECTATION_IMMUTABLE',
  'null cannot bypass the immutable deposit snapshot'
);

select ok(
  (
    select status = 'confirmed'
      and deposit_status = 'confirmed'
      and deposit_confirmed_at is not null
      and deposit_confirmed_by is null
      and deposit_confirmation_actor = 'automatic_system'
      and deposit_confirmation_policy_version = 'deposit-proof-basic/v1'
    from public.appointments
    where id = '98000000-0000-4000-8000-000000000030'
  ),
  'automatic confirmation records an explicit system actor without auth.uid'
);

select ok(
  (
    select proof_message_id = '98000000-0000-4000-8000-000000000040'
      and media_sha256 = repeat('a', 64)
      and actor = 'automatic_system'
      and status = 'confirmed'
      and reading ->> 'operationId' = 'ok-1'
      and (result ->> 'starts_at')::timestamptz = (
        select starts_at from public.appointments
        where id = '98000000-0000-4000-8000-000000000030'
      )
    from public.automated_deposit_proof_results
    where appointment_id = '98000000-0000-4000-8000-000000000030'
  )
  and (
    select metadata ->> 'preserved_concurrent_key' = 'keep-me'
      and (metadata ->> 'deposit_proof')::boolean
      and metadata ->> 'appointment_id' =
        '98000000-0000-4000-8000-000000000030'
    from public.messages
    where id = '98000000-0000-4000-8000-000000000040'
  )
  and exists (
    select 1 from public.whatsapp_automation_effects
    where execution_message_id =
        '98000000-0000-4000-8000-000000000040'
      and effect_key = 'appointment:deposit_process'
      and effect_type = 'appointment_deposit_process'
      and appointment_id = '98000000-0000-4000-8000-000000000030'
      and result ->> 'effect_status' = 'applied'
  ),
  'ledger, metadata and durable execution effect commit atomically'
);

select ok(
  exists (
    select 1 from public.audit_logs
    where action = 'deposit.automatically_confirmed'
      and entity_id = '98000000-0000-4000-8000-000000000030'
      and actor_user_id is null
      and metadata #>> '{actor,name}' = 'automatic_system'
      and metadata -> 'reading' ->> 'operationId' = 'ok-1'
      and metadata -> 'result' ->> 'status' = 'confirmed'
  ),
  'the audit event attributes the evidence and result to the system actor'
);

select ok(
  (
    select automation_mode = 'auto'
      and not needs_human
      and current_flow is null
      and automation_pause_source is null
      and automation_pause_message_id is null
    from public.conversations
    where id = '98000000-0000-4000-8000-000000000020'
  ),
  'confirmation resumes only its own causal inbound handoff'
);

select ok(
  (
    select state = 'idle'
      and context = '{}'::jsonb
      and expires_at is null
      and last_automation_message_id =
        '98000000-0000-4000-8000-000000000040'
      and last_automation_session_sequence = 100
    from public.automation_sessions
    where conversation_id = '98000000-0000-4000-8000-000000000020'
  ),
  'the proof session becomes idle even with a later inbound already queued'
);

select pg_temp.calendar_ready();
select pg_temp.calendar_projection_synced('98000000-0000-4000-8000-000000000030');

select public.process_automated_deposit_proof(
  '98000000-0000-4000-8000-000000000040',
  (select lease_token from public.whatsapp_automation_executions
   where message_id = '98000000-0000-4000-8000-000000000040'),
  '98000000-0000-4000-8000-000000000030',
  '{"legible":true,"amount":10000,"currency":"ARS","date":null,"destination":"odontologa.gisela.mp","holder":"Gisela Vanesa Lentz","operationId":"ok-1"}'::jsonb,
  repeat('a', 64), 'deposit-proof-basic/v1', true
) as result
\gset retry_

select ok(
  :'retry_result'::jsonb ->> 'status' = 'already_confirmed'
  and (:'retry_result'::jsonb ->> 'idempotent')::boolean
  and (:'retry_result'::jsonb ->> 'starts_at')::timestamptz = (
    select starts_at from public.appointments
    where id = '98000000-0000-4000-8000-000000000030'
  ),
  'an exact retry is already_confirmed and preserves starts_at'
);

select ok(
  (
    select count(*) = 1
    from public.automated_deposit_proof_results
    where appointment_id = '98000000-0000-4000-8000-000000000030'
  )
  and (
    select count(*) = 1
    from public.audit_logs
    where action = 'deposit.automatically_confirmed'
      and entity_id = '98000000-0000-4000-8000-000000000030'
  ),
  'an exact retry duplicates neither ledger nor audit effect'
);

select public.handoff_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000040',
  (select lease_token from public.whatsapp_automation_executions
   where message_id = '98000000-0000-4000-8000-000000000040'),
  'deposit_confirmation_send_failed',
  '98000000-0000-4000-8000-000000000030'
) as result
\gset confirmed_handoff_

select ok(
  :'confirmed_handoff_result'::jsonb ->> 'state' = 'human_handoff'
  and :'confirmed_handoff_result'::jsonb ->> 'appointmentId' =
    '98000000-0000-4000-8000-000000000030',
  'handoff RPC recovers an applied confirmed deposit effect'
);

-- La prueba continúa usando esta conversación para otra carrera causal.
update public.conversations
set automation_mode = 'auto', needs_human = false, priority = false,
    current_flow = null
where id = '98000000-0000-4000-8000-000000000020';
update public.automation_sessions
set state = 'idle', context = '{}'::jsonb, expires_at = null
where conversation_id = '98000000-0000-4000-8000-000000000020';

select throws_ok(
  $$select public.process_automated_deposit_proof(
    '98000000-0000-4000-8000-000000000040',
    (select lease_token from public.whatsapp_automation_executions
     where message_id = '98000000-0000-4000-8000-000000000040'),
    '98000000-0000-4000-8000-000000000030',
    '{"legible":true,"amount":10000,"currency":"ARS","date":null,"destination":"odontologa.gisela.mp","holder":"Gisela Vanesa Lentz","operationId":"changed"}'::jsonb,
    repeat('a', 64), 'deposit-proof-basic/v1', true
  )$$,
  '23514',
  'DEPOSIT_PROOF_READING_MISMATCH',
  'a retry cannot replace the canonical message reading'
);

select throws_ok(
  $$select public.process_automated_deposit_proof(
    '98000000-0000-4000-8000-000000000040',
    (select lease_token from public.whatsapp_automation_executions
     where message_id = '98000000-0000-4000-8000-000000000040'),
    '98000000-0000-4000-8000-000000000035',
    '{"legible":true,"amount":10000,"currency":"ARS","date":null,"destination":"odontologa.gisela.mp","holder":"Gisela Vanesa Lentz","operationId":"ok-1"}'::jsonb,
    repeat('a', 64), 'deposit-proof-basic/v1', true
  )$$,
  '23514',
  'DEPOSIT_PROOF_CONTEXT_MISMATCH',
  'one proof message cannot be rebound to another contact appointment'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, metadata
) values (
  '98000000-0000-4000-8000-000000000048',
  '98000000-0000-4000-8000-000000000025',
  '98000000-0000-4000-8000-000000000015',
  'inbound', 'image', 'Reupload de los mismos bytes', 'delivered', '{}'::jsonb
);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000048', '{}'::jsonb, 900
)
\gset reupload_claim_

select pg_temp.calendar_ready();
select pg_temp.calendar_projection_synced('98000000-0000-4000-8000-000000000035');

select public.process_automated_deposit_proof(
  '98000000-0000-4000-8000-000000000048',
  (select lease_token from public.whatsapp_automation_executions
   where message_id = '98000000-0000-4000-8000-000000000048'),
  '98000000-0000-4000-8000-000000000035',
  '{"legible":true,"amount":10000,"currency":"USD","date":"1900-01-01","destination":null,"holder":"GISELA V LENTZ","operationId":"ok-1"}'::jsonb,
  repeat('a', 64), 'deposit-proof-basic/v1', true
) as result
\gset reupload_

select ok(
  :'reupload_result'::jsonb ->> 'status' = 'confirmed'
  and (
    select count(*) = 2
    from public.automated_deposit_proof_results
    where media_sha256 = repeat('a', 64)
  ),
  'an identical reupload, abbreviated holder and auxiliary currency/date pass the basic policy'
);

select public.block_whatsapp_account_graph_work(
  '98000000-0000-4000-8000-000000000060',
  'ACCOUNT_OFFBOARDED'
);

select ok(
  (
    select status = 'completed'
      and not retryable
      and lease_token is null
      and outcome ->> 'reason' =
        'ACCOUNT_BLOCKED_AFTER_COMMITTED_EFFECT'
      and outcome ->> 'appointmentId' =
        '98000000-0000-4000-8000-000000000035'
    from public.whatsapp_automation_executions
    where message_id = '98000000-0000-4000-8000-000000000048'
  )
  and (
    select automation_mode = 'manual'
      and needs_human
      and automation_pause_message_id =
        '98000000-0000-4000-8000-000000000048'
    from public.conversations
    where id = '98000000-0000-4000-8000-000000000025'
  )
  and (
    select state = 'human_handoff'
      and context ->> 'reason' =
        'ACCOUNT_BLOCKED_AFTER_COMMITTED_EFFECT'
      and context ->> 'appointmentId' =
        '98000000-0000-4000-8000-000000000035'
    from public.automation_sessions
    where conversation_id = '98000000-0000-4000-8000-000000000025'
  ),
  'account blocking terminalizes a committed deposit confirmation for recovery'
);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000045', '{}'::jsonb, 900
)
\gset invalid_type_claim_

select throws_ok(
  $$select public.process_automated_deposit_proof(
    '98000000-0000-4000-8000-000000000045',
    (select lease_token from public.whatsapp_automation_executions
     where message_id = '98000000-0000-4000-8000-000000000045'),
    '98000000-0000-4000-8000-000000000031',
    '{"legible":true,"amount":10000,"currency":"ARS","date":null,"destination":"odontologa.gisela.mp","holder":"Gisela Vanesa Lentz","operationId":null}'::jsonb,
    repeat('b', 64), 'deposit-proof-basic/v1', true
  )$$,
  '22023',
  'DEPOSIT_PROOF_MESSAGE_INVALID',
  'text cannot be presented as transfer evidence'
);

select ok(
  (
    select deposit_status = 'pending'
      and deposit_proof_message_id is null
    from public.appointments
    where id = '98000000-0000-4000-8000-000000000031'
  ),
  'invalid media leaves the exact appointment untouched'
);

select public.complete_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000045',
  :'invalid_type_claim_lease_token'::uuid,
  '{"processed":true,"state":"idle","reason":"invalid_media_test"}'::jsonb
);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000041', '{}'::jsonb, 900
)
\gset review_claim_

select pg_temp.calendar_ready();
select pg_temp.calendar_projection_synced('98000000-0000-4000-8000-000000000031');

select public.process_automated_deposit_proof(
  '98000000-0000-4000-8000-000000000041',
  (select lease_token from public.whatsapp_automation_executions
   where message_id = '98000000-0000-4000-8000-000000000041'),
  '98000000-0000-4000-8000-000000000031',
  '{"legible":true,"amount":9999.99,"currency":"ARS","date":null,"destination":null,"holder":"Gisela","operationId":"review-1"}'::jsonb,
  repeat('c', 64), 'deposit-proof-basic/v1', true
) as result
\gset review_

select ok(
  :'review_result'::jsonb ->> 'status' = 'review'
  and (:'review_result'::jsonb -> 'review_reasons') ? 'AMOUNT_MISMATCH'
  and (:'review_result'::jsonb -> 'review_reasons') ? 'RECIPIENT_MISMATCH'
  and (:'review_result'::jsonb ->> 'starts_at')::timestamptz = (
    select starts_at from public.appointments
    where id = '98000000-0000-4000-8000-000000000031'
  ),
  'SQL requires an exact amount and a matching recipient before confirming'
);

select ok(
  (
    select status = 'scheduled'
      and deposit_status = 'proof_received'
      and deposit_proof_message_id =
        '98000000-0000-4000-8000-000000000041'
      and deposit_confirmed_at is null
    from public.appointments
    where id = '98000000-0000-4000-8000-000000000031'
  )
  and (
    select automation_mode = 'manual'
      and needs_human
      and automation_pause_source = 'inbound_handoff'
      and automation_pause_message_id =
        '98000000-0000-4000-8000-000000000041'
    from public.conversations
    where id = '98000000-0000-4000-8000-000000000021'
  )
  and (
    select state = 'human_handoff'
      and context ->> 'appointmentId' =
        '98000000-0000-4000-8000-000000000031'
      and context ->> 'reason' = 'deposit_proof_review'
      and last_automation_message_id =
        '98000000-0000-4000-8000-000000000041'
      and last_automation_ingest_sequence = (
        select whatsapp_ingest_sequence from public.messages
        where id = '98000000-0000-4000-8000-000000000041'
      )
    from public.automation_sessions
    where conversation_id = '98000000-0000-4000-8000-000000000021'
  ),
  'review preserves proof_received and a durable exact manual handoff'
);

select throws_ok(
  $$select public.handoff_whatsapp_automation_execution(
    '98000000-0000-4000-8000-000000000041',
    (select lease_token from public.whatsapp_automation_executions
     where message_id = '98000000-0000-4000-8000-000000000041'),
    'deposit_review_send_failed',
    '98000000-0000-4000-8000-000000000031'
  )$$,
  '55000',
  'WHATSAPP_AUTOMATION_COMMITTED_EFFECT_NOT_FOUND',
  'handoff RPC never treats review as a recoverable committed confirmation'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, metadata
) values (
  '98000000-0000-4000-8000-000000000053',
  '98000000-0000-4000-8000-000000000021',
  '98000000-0000-4000-8000-000000000011',
  'inbound', 'text', 'Mensaje B posterior a la revisión A', 'delivered',
  '{}'::jsonb
);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000042', '{}'::jsonb, 900
)
\gset manual_claim_

select pg_temp.calendar_ready();
select pg_temp.calendar_projection_synced('98000000-0000-4000-8000-000000000032');

select public.process_automated_deposit_proof(
  '98000000-0000-4000-8000-000000000042',
  (select lease_token from public.whatsapp_automation_executions
   where message_id = '98000000-0000-4000-8000-000000000042'),
  '98000000-0000-4000-8000-000000000032',
  '{"legible":true,"amount":10000,"currency":null,"date":null,"destination":null,"holder":"Gisela Vanesa Lentz","operationId":"manual-1"}'::jsonb,
  repeat('d', 64), 'deposit-proof-basic/v1', false
) as result
\gset manual_

select ok(
  :'manual_result'::jsonb ->> 'status' = 'review'
  and (:'manual_result'::jsonb -> 'review_reasons') ?
    'AUTO_APPROVAL_DISABLED'
  and (:'manual_result'::jsonb ->> 'starts_at') is not null,
  'auto_approve false deterministically forces review'
);

select ok(
  (
    select status = 'scheduled'
      and deposit_status = 'proof_received'
      and deposit_confirmed_at is null
    from public.appointments
    where id = '98000000-0000-4000-8000-000000000032'
  )
  and (
    select automation_mode = 'manual' and needs_human
    from public.conversations
    where id = '98000000-0000-4000-8000-000000000022'
  )
  and (
    select state = 'human_handoff'
      and context ->> 'appointmentId' =
        '98000000-0000-4000-8000-000000000032'
    from public.automation_sessions
    where conversation_id = '98000000-0000-4000-8000-000000000022'
  ),
  'forced review never confirms and keeps human attention active'
);

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"98000000-0000-4000-8000-000000000099"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select public.confirm_appointment_deposit(
  '98000000-0000-4000-8000-000000000032'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select ok(
  (
    select status = 'confirmed'
      and deposit_status = 'confirmed'
      and deposit_confirmed_by =
        '98000000-0000-4000-8000-000000000099'
    from public.appointments
    where id = '98000000-0000-4000-8000-000000000032'
  )
  and (
    select state = 'idle'
      and context = '{}'::jsonb
      and expires_at is null
      and last_automation_message_id =
        '98000000-0000-4000-8000-000000000042'
    from public.automation_sessions
    where conversation_id = '98000000-0000-4000-8000-000000000022'
  )
  and (
    select automation_mode = 'manual'
      and not needs_human
      and current_flow is null
    from public.conversations
    where id = '98000000-0000-4000-8000-000000000022'
  ),
  'manual confirmation clears only its review session to idle'
);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000043', '{}'::jsonb, 900
)
\gset late_claim_

select pg_temp.calendar_ready();
select pg_temp.calendar_projection_synced('98000000-0000-4000-8000-000000000033');

select public.process_automated_deposit_proof(
  '98000000-0000-4000-8000-000000000043',
  (select lease_token from public.whatsapp_automation_executions
   where message_id = '98000000-0000-4000-8000-000000000043'),
  '98000000-0000-4000-8000-000000000033',
  '{"legible":true,"amount":10000,"currency":"ARS","date":null,"destination":"odontologa.gisela.mp","holder":"Gisela Vanesa Lentz","operationId":"late-1"}'::jsonb,
  repeat('e', 64), 'deposit-proof-basic/v1', true
) as result
\gset late_

select ok(
  :'late_result'::jsonb ->> 'status' = 'late'
  and (:'late_result'::jsonb -> 'review_reasons') ? 'HOLD_EXPIRED'
  and (:'late_result'::jsonb ->> 'starts_at')::timestamptz = (
    select starts_at from public.appointments
    where id = '98000000-0000-4000-8000-000000000033'
  ),
  'an expired hold returns late with the exact starts_at'
);

select ok(
  (
    select status = 'cancelled'
      and deposit_status = 'expired'
      and deposit_proof_late
      and deposit_proof_message_id =
        '98000000-0000-4000-8000-000000000043'
    from public.appointments
    where id = '98000000-0000-4000-8000-000000000033'
  )
  and (
    select automation_mode = 'manual'
      and needs_human
      and priority
      and current_flow = 'late_deposit_proof'
      and automation_pause_message_id =
        '98000000-0000-4000-8000-000000000043'
    from public.conversations
    where id = '98000000-0000-4000-8000-000000000023'
  )
  and (
    select state = 'human_handoff'
      and context ->> 'appointmentId' =
        '98000000-0000-4000-8000-000000000033'
      and context ->> 'reason' = 'deposit_proof_late'
      and last_automation_message_id =
        '98000000-0000-4000-8000-000000000043'
    from public.automation_sessions
    where conversation_id = '98000000-0000-4000-8000-000000000023'
  )
  and (
    select metadata -> 'deposit_proof_late' = 'true'::jsonb
    from public.messages
    where id = '98000000-0000-4000-8000-000000000043'
  ),
  'late evidence is explicit in the inbox and durable review handoff'
);

-- Simula la acción explícita del navegador después de recibir el inbound.
-- Ese control cambia la preferencia a manual, pero no crea una barrera de
-- respuesta humana sobre el mensaje que la precede.
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"98000000-0000-4000-8000-000000000099"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
update public.conversations
set automation_mode = 'manual'
where id = '98000000-0000-4000-8000-000000000024';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000044', '{}'::jsonb, 900
)
\gset operator_claim_

select throws_ok(
  $$select public.process_automated_deposit_proof(
    '98000000-0000-4000-8000-000000000044',
    (select lease_token from public.whatsapp_automation_executions
     where message_id = '98000000-0000-4000-8000-000000000044'),
    '98000000-0000-4000-8000-000000000034',
    '{"legible":true,"amount":9000,"currency":"ARS","date":null,"destination":null,"holder":"Gisela","operationId":"operator-review"}'::jsonb,
    repeat('f', 64), 'deposit-proof-basic/v1', true
  )$$,
  '55000',
  'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL',
  'an operator-owned pause rolls back the review domain effect'
);

select ok(
  (
    select automation_mode = 'manual'
      and automation_pause_source = 'operator'
      and automation_pause_message_id is null
    from public.conversations
    where id = '98000000-0000-4000-8000-000000000024'
  ),
  'an explicit operator pause remains owned by the operator'
);

select ok(
  (
    select state = 'waiting_deposit'
      and last_automation_message_id is null
    from public.automation_sessions
    where conversation_id = '98000000-0000-4000-8000-000000000024'
  )
  and (
    select status = 'scheduled'
      and deposit_status = 'pending'
      and deposit_proof_message_id is null
    from public.appointments
    where id = '98000000-0000-4000-8000-000000000034'
  )
  and not exists (
    select 1 from public.automated_deposit_proof_results
    where appointment_id = '98000000-0000-4000-8000-000000000034'
  )
  and not exists (
    select 1 from public.whatsapp_automation_effects
    where execution_message_id =
      '98000000-0000-4000-8000-000000000044'
      and effect_type = 'appointment_deposit_process'
  )
  and not exists (
    select 1 from public.audit_logs
    where entity_id = '98000000-0000-4000-8000-000000000034'
      and action like 'deposit.automated%'
  )
  and not (
    select metadata ? 'deposit_proof'
    from public.messages
    where id = '98000000-0000-4000-8000-000000000044'
  ),
  'operator blocking rolls back appointment, ledger, session and metadata'
);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000040', '{}'::jsonb, 900
)
\gset snapshot_

select ok(
  :'snapshot_message_snapshot'::jsonb ->> 'type' = 'image'
  and (:'snapshot_message_snapshot'::jsonb ? 'coexistence_account_id'),
  'claim snapshots expose media type and immutable account routing context'
);

update public.appointments
set status = 'cancelled'
where id = '98000000-0000-4000-8000-000000000030';

select pg_temp.calendar_ready();
select pg_temp.calendar_projection_synced('98000000-0000-4000-8000-000000000030');

select public.process_automated_deposit_proof(
  '98000000-0000-4000-8000-000000000040',
  (select lease_token from public.whatsapp_automation_executions
   where message_id = '98000000-0000-4000-8000-000000000040'),
  '98000000-0000-4000-8000-000000000030',
  '{"legible":true,"amount":10000,"currency":"ARS","date":null,"destination":"odontologa.gisela.mp","holder":"Gisela Vanesa Lentz","operationId":"ok-1"}'::jsonb,
  repeat('a', 64), 'deposit-proof-basic/v1', true
) as result
\gset superseded_confirmed_

select ok(
  :'superseded_confirmed_result'::jsonb ->> 'status' = 'superseded'
  and :'superseded_confirmed_result'::jsonb ->> 'original_status' =
    'confirmed'
  and :'superseded_confirmed_result'::jsonb ->>
    'current_appointment_status' = 'cancelled'
  and (:'superseded_confirmed_result'::jsonb ->> 'starts_at') is not null,
  'a cancelled confirmation retry is superseded instead of sending stale text'
);

select public.complete_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000040',
  :'proof_claim_lease_token'::uuid,
  '{"processed":true,"state":"idle","reason":"superseded_test"}'::jsonb
);

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"98000000-0000-4000-8000-000000000099"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select public.update_appointment_status(
  '98000000-0000-4000-8000-000000000031',
  'cancelled'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select pg_temp.calendar_ready();
select pg_temp.calendar_projection_synced('98000000-0000-4000-8000-000000000031');

select public.process_automated_deposit_proof(
  '98000000-0000-4000-8000-000000000041',
  (select lease_token from public.whatsapp_automation_executions
   where message_id = '98000000-0000-4000-8000-000000000041'),
  '98000000-0000-4000-8000-000000000031',
  '{"legible":true,"amount":9999.99,"currency":"ARS","date":null,"destination":null,"holder":"Gisela","operationId":"review-1"}'::jsonb,
  repeat('c', 64), 'deposit-proof-basic/v1', true
) as result
\gset superseded_review_

select ok(
  :'superseded_review_result'::jsonb ->> 'status' = 'superseded'
  and :'superseded_review_result'::jsonb ->> 'original_status' = 'review'
  and (:'superseded_review_result'::jsonb ->> 'starts_at') is not null
  and (
    select state = 'human_handoff'
      and context ->> 'appointmentId' =
        '98000000-0000-4000-8000-000000000031'
      and last_automation_message_id =
        '98000000-0000-4000-8000-000000000041'
    from public.automation_sessions
    where conversation_id = '98000000-0000-4000-8000-000000000021'
  )
  and (
    select needs_human
      and current_flow = 'deposit_proof_received'
      and automation_pause_source = 'inbound_handoff'
      and automation_pause_message_id =
        '98000000-0000-4000-8000-000000000041'
    from public.conversations
    where id = '98000000-0000-4000-8000-000000000021'
  ),
  'a later inbound keeps review A in handoff when A is cancelled and superseded'
);

select public.complete_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000041',
  :'review_claim_lease_token'::uuid,
  '{"processed":true,"state":"idle","reason":"superseded_test"}'::jsonb
);

-- El mensaje entra a tiempo, pero el cleanup vence el hold mientras termina
-- el OCR. Si el horario continúa libre, conserva el comprobante para revisión;
-- no confirma una pre-reserva cuya proyección en Google ya fue retirada.
insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at,
  status, source, coverage, duration_minutes, deposit_status,
  hold_expires_at, hold_expired_notification_status
) values (
  '98000000-0000-4000-8000-000000000036',
  '98000000-0000-4000-8000-000000000010',
  '98000000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000002',
  (:'test_date'::date + time '15:00') at time zone
    'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '15:30') at time zone
    'America/Argentina/Buenos_Aires',
  'scheduled', 'whatsapp', 'ioma', 30, 'pending',
  clock_timestamp() + interval '1 hour', 'pending'
);

update public.automation_sessions
set state = 'waiting_deposit',
    context = jsonb_build_object(
      'appointmentId', '98000000-0000-4000-8000-000000000036'
    ),
    expires_at = clock_timestamp() + interval '1 hour',
    last_automation_message_id = null,
    last_automation_ingest_sequence = null,
    last_automation_session_sequence = null
where conversation_id = '98000000-0000-4000-8000-000000000020';

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, metadata
) values (
  '98000000-0000-4000-8000-000000000046',
  '98000000-0000-4000-8000-000000000020',
  '98000000-0000-4000-8000-000000000010',
  'inbound', 'image', 'Llegó antes del cleanup', 'delivered', '{}'::jsonb
);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000046', '{}'::jsonb, 900
)
\gset recovered_claim_

update public.appointments
set status = 'cancelled',
    deposit_status = 'expired',
    hold_expired_notification_status = 'pending'
where id = '98000000-0000-4000-8000-000000000036';

select pg_temp.calendar_ready();
select pg_temp.calendar_projection_synced('98000000-0000-4000-8000-000000000036');

select public.process_automated_deposit_proof(
  '98000000-0000-4000-8000-000000000046',
  (select lease_token from public.whatsapp_automation_executions
   where message_id = '98000000-0000-4000-8000-000000000046'),
  '98000000-0000-4000-8000-000000000036',
  '{"legible":true,"amount":10000,"currency":"ARS","date":null,"destination":"odontologa.gisela.mp","holder":"Gisela Vanesa Lentz","operationId":"ocr-race"}'::jsonb,
  repeat('1', 64), 'deposit-proof-basic/v1', true
) as result
\gset recovered_

select ok(
  :'recovered_result'::jsonb ->> 'status' = 'review'
  and (:'recovered_result'::jsonb -> 'review_reasons') @> '["CALENDAR_AVAILABILITY_UNVERIFIED"]'::jsonb
  and (
    select status = 'scheduled'
      and deposit_status = 'proof_received'
      and not deposit_proof_late
    from public.appointments
    where id = '98000000-0000-4000-8000-000000000036'
  ),
  'a timely proof survives cleanup for review without confirming an unprojected hold'
);

-- Mismo borde, pero el horario ya fue tomado. La exclusión debe ganar y el
-- turno vencido nunca puede desplazar al vigente.
update public.conversations
set automation_mode = 'auto', needs_human = false, priority = false,
    current_flow = null
where id = '98000000-0000-4000-8000-000000000021';

update public.automation_sessions
set state = 'waiting_deposit',
    context = jsonb_build_object(
      'appointmentId', '98000000-0000-4000-8000-000000000037'
    ),
    expires_at = clock_timestamp() + interval '1 hour',
    last_automation_message_id = null,
    last_automation_ingest_sequence = null,
    last_automation_session_sequence = null
where conversation_id = '98000000-0000-4000-8000-000000000021';

insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at,
  status, source, coverage, duration_minutes, deposit_status,
  hold_expires_at, hold_expired_notification_status
) values
  (
    '98000000-0000-4000-8000-000000000037',
    '98000000-0000-4000-8000-000000000011',
    '98000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '16:00') at time zone
      'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '16:30') at time zone
      'America/Argentina/Buenos_Aires',
    'cancelled', 'whatsapp', 'ioma', 30, 'expired',
    clock_timestamp() + interval '1 hour', 'pending'
  ),
  (
    '98000000-0000-4000-8000-000000000038',
    '98000000-0000-4000-8000-000000000014',
    '98000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '16:00') at time zone
      'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '16:30') at time zone
      'America/Argentina/Buenos_Aires',
    'confirmed', 'manual', 'ioma', 30, 'not_required',
    null, 'not_applicable'
  );

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, metadata
) values (
  '98000000-0000-4000-8000-000000000047',
  '98000000-0000-4000-8000-000000000021',
  '98000000-0000-4000-8000-000000000011',
  'inbound', 'image', 'Llegó antes, horario ocupado', 'delivered', '{}'::jsonb
);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000047', '{}'::jsonb, 900
)
\gset occupied_claim_

select pg_temp.calendar_ready();
select pg_temp.calendar_projection_synced('98000000-0000-4000-8000-000000000037');

select public.process_automated_deposit_proof(
  '98000000-0000-4000-8000-000000000047',
  (select lease_token from public.whatsapp_automation_executions
   where message_id = '98000000-0000-4000-8000-000000000047'),
  '98000000-0000-4000-8000-000000000037',
  '{"legible":true,"amount":10000,"currency":"ARS","date":null,"destination":"odontologa.gisela.mp","holder":"Gisela Vanesa Lentz","operationId":"ocr-race-taken"}'::jsonb,
  repeat('2', 64), 'deposit-proof-basic/v1', true
) as result
\gset occupied_

select ok(
  :'occupied_result'::jsonb ->> 'status' = 'late'
  and (:'occupied_result'::jsonb -> 'review_reasons') ?
    'SLOT_NO_LONGER_AVAILABLE'
  and (
    select status = 'cancelled' and deposit_status = 'expired'
    from public.appointments
    where id = '98000000-0000-4000-8000-000000000037'
  )
  and (
    select status = 'confirmed'
    from public.appointments
    where id = '98000000-0000-4000-8000-000000000038'
  ),
  'an occupied slot remains exclusive and the expired hold stays cancelled'
);

-- El archivo llegó dentro de la espera, pero la cola lo reclama después del
-- vencimiento. El claim debe preservar waiting_deposit y el cron debe respetar
-- sólo el lease activo; al completarlo, el hold vuelve a ser expirable.
insert into public.contacts (
  id, phone_e164, whatsapp_id, name, coverage, is_existing_patient
) values (
  '98000000-0000-4000-8000-000000000017', '+5491100009817',
  '5491100009817', 'Expired Claim Contact', 'ioma', true
);

insert into public.conversations (
  id, contact_id, automation_mode, needs_human, priority
) values (
  '98000000-0000-4000-8000-000000000027',
  '98000000-0000-4000-8000-000000000017',
  'auto', false, false
);

insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at,
  status, source, coverage, duration_minutes, deposit_status,
  hold_expires_at, hold_expired_notification_status, created_at
) values (
  '98000000-0000-4000-8000-000000000040',
  '98000000-0000-4000-8000-000000000017',
  '98000000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000002',
  (:'test_date'::date + time '18:00') at time zone
    'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '18:30') at time zone
    'America/Argentina/Buenos_Aires',
  'scheduled', 'whatsapp', 'ioma', 30, 'pending',
  clock_timestamp() - interval '1 minute', 'pending',
  clock_timestamp() - interval '3 minutes'
);

insert into public.automation_sessions (
  conversation_id, state, context, expires_at
) values (
  '98000000-0000-4000-8000-000000000027',
  'waiting_deposit',
  jsonb_build_object(
    'appointmentId', '98000000-0000-4000-8000-000000000040'
  ),
  clock_timestamp() - interval '1 minute'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, metadata,
  created_at
) values (
  '98000000-0000-4000-8000-000000000051',
  '98000000-0000-4000-8000-000000000027',
  '98000000-0000-4000-8000-000000000017',
  'inbound', 'document', 'Comprobante puntual en cola.pdf', 'delivered',
  '{}'::jsonb, clock_timestamp() - interval '2 minutes'
);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000051', '{}'::jsonb, 900
)
\gset expired_session_claim_

create function pg_temp.timely_proof_claim_blocks_cron_only_during_lease()
returns boolean
language plpgsql
as $$
declare
  protected boolean := false;
  claim_lease uuid;
begin
  perform public.expire_booking_holds(clock_timestamp());
  protected := exists (
    select 1 from public.appointments
    where id = '98000000-0000-4000-8000-000000000040'
      and status = 'scheduled'
      and deposit_status = 'pending'
  );

  select execution.lease_token into claim_lease
  from public.whatsapp_automation_executions execution
  where execution.message_id = '98000000-0000-4000-8000-000000000051'
    and execution.status = 'processing'
    and execution.session_state = 'waiting_deposit'
    and not execution.fresh_session
    and execution.session_context ->> 'appointmentId' =
      '98000000-0000-4000-8000-000000000040'
    and execution.session_expires_at < execution.snapshot_at;

  if claim_lease is null then
    return false;
  end if;

  perform public.complete_whatsapp_automation_execution(
    '98000000-0000-4000-8000-000000000051',
    claim_lease,
    '{"processed":true,"state":"idle","reason":"cron_guard_test"}'::jsonb
  );
  perform public.expire_booking_holds(clock_timestamp());

  return protected and exists (
    select 1 from public.appointments
    where id = '98000000-0000-4000-8000-000000000040'
      and status = 'cancelled'
      and deposit_status = 'expired'
  );
end;
$$;

select ok(
  pg_temp.timely_proof_claim_blocks_cron_only_during_lease(),
  'a timely proof keeps expired waiting_deposit through claim and blocks cron only for its active lease'
);

-- Orden inverso: un cleanup antiguo alcanzó a cancelar antes de materializar
-- el dispatch. Al aparecer el dispatch y reclamarse el inbound puntual, el
-- snapshot vencido se conserva y process recupera el comprobante para revisión.
-- La confirmación automática exige además una pre-reserva vigente en Google.
insert into public.contacts (
  id, phone_e164, whatsapp_id, name, coverage, is_existing_patient
) values
  (
    '98000000-0000-4000-8000-000000000020', '+5491100009820',
    '5491100009820', 'Cron Before Claim Contact', 'ioma', true
  ),
  (
    '98000000-0000-4000-8000-000000000021', '+5491100009821',
    '5491100009821', 'Pending Dispatch Guard Contact', 'ioma', true
  );

insert into public.conversations (
  id, contact_id, automation_mode, needs_human, priority
) values
  (
    '98000000-0000-4000-8000-000000000030',
    '98000000-0000-4000-8000-000000000020',
    'auto', false, false
  ),
  (
    '98000000-0000-4000-8000-000000000031',
    '98000000-0000-4000-8000-000000000021',
    'auto', false, false
  );

insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at,
  status, source, coverage, duration_minutes, deposit_status,
  hold_expires_at, hold_expired_notification_status, created_at
) values
  (
    '98000000-0000-4000-8000-000000000043',
    '98000000-0000-4000-8000-000000000020',
    '98000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '21:00') at time zone
      'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '21:30') at time zone
      'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'ioma', 30, 'pending',
    clock_timestamp() - interval '1 minute', 'pending',
    clock_timestamp() - interval '3 minutes'
  ),
  (
    '98000000-0000-4000-8000-000000000044',
    '98000000-0000-4000-8000-000000000021',
    '98000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '22:00') at time zone
      'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '22:30') at time zone
      'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'ioma', 30, 'pending',
    clock_timestamp() - interval '1 minute', 'pending',
    clock_timestamp() - interval '3 minutes'
  );

insert into public.automation_sessions (
  conversation_id, state, context, expires_at
) values
  (
    '98000000-0000-4000-8000-000000000030',
    'waiting_deposit',
    jsonb_build_object(
      'appointmentId', '98000000-0000-4000-8000-000000000043'
    ),
    clock_timestamp() - interval '1 minute'
  ),
  (
    '98000000-0000-4000-8000-000000000031',
    'waiting_deposit',
    jsonb_build_object(
      'appointmentId', '98000000-0000-4000-8000-000000000044'
    ),
    clock_timestamp() - interval '1 minute'
  );

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, metadata,
  created_at
) values
  (
    '98000000-0000-4000-8000-000000000055',
    '98000000-0000-4000-8000-000000000030',
    '98000000-0000-4000-8000-000000000020',
    'inbound', 'image', 'Llegó antes del cron', 'delivered', '{}'::jsonb,
    clock_timestamp() - interval '2 minutes'
  ),
  (
    '98000000-0000-4000-8000-000000000056',
    '98000000-0000-4000-8000-000000000031',
    '98000000-0000-4000-8000-000000000021',
    'inbound', 'document', 'Dispatch pendiente puntual.pdf', 'delivered',
    '{}'::jsonb, clock_timestamp() - interval '2 minutes'
  );

-- El segundo inbound ya tiene trabajo durable: sólo el primero reproduce el
-- estado legado sin dispatch y puede ser alcanzado por el cron.
insert into public.whatsapp_automation_dispatches (
  message_id, external_event_id, status
) values (
  '98000000-0000-4000-8000-000000000056',
  'deposit-proof-pending-dispatch-guard', 'pending'
);

select * from public.expire_booking_holds(clock_timestamp());

insert into public.whatsapp_automation_dispatches (
  message_id, external_event_id, status
) values (
  '98000000-0000-4000-8000-000000000055',
  'deposit-proof-cron-before-claim', 'pending'
);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000055', '{}'::jsonb, 900
)
\gset cron_before_claim_

select pg_temp.calendar_ready();
select pg_temp.calendar_projection_synced('98000000-0000-4000-8000-000000000043');

select public.process_automated_deposit_proof(
  '98000000-0000-4000-8000-000000000055',
  (select lease_token from public.whatsapp_automation_executions
   where message_id = '98000000-0000-4000-8000-000000000055'),
  '98000000-0000-4000-8000-000000000043',
  '{"legible":true,"amount":10000,"currency":"ARS","date":null,"destination":"odontologa.gisela.mp","holder":"Gisela Vanesa Lentz","operationId":"cron-before-claim"}'::jsonb,
  repeat('4', 64), 'deposit-proof-basic/v1', true
) as result
\gset cron_recovered_

select ok(
  :'cron_before_claim_session_state' = 'waiting_deposit'
  and not :'cron_before_claim_fresh_session'::boolean
  and :'cron_recovered_result'::jsonb ->> 'status' = 'review'
  and (:'cron_recovered_result'::jsonb -> 'review_reasons') @> '["CALENDAR_AVAILABILITY_UNVERIFIED"]'::jsonb
  and (
    select status = 'scheduled'
      and deposit_status = 'proof_received'
      and hold_expired_notification_status = 'cancelled'
    from public.appointments
    where id = '98000000-0000-4000-8000-000000000043'
  ),
  'cron before claim preserves timely evidence for review when the Calendar hold is absent'
);

create function pg_temp.pending_dispatch_blocks_expiration_work()
returns boolean
language plpgsql
as $$
declare
  cron_blocked boolean := false;
  notification_blocked boolean := false;
begin
  perform public.expire_booking_holds(clock_timestamp());
  cron_blocked := exists (
    select 1 from public.appointments
    where id = '98000000-0000-4000-8000-000000000044'
      and status = 'scheduled'
      and deposit_status = 'pending'
  );

  -- Simula un vencimiento ya persistido por un ciclo anterior para probar el
  -- claim del aviso independientemente del UPDATE de expiración actual.
  update public.appointments
  set status = 'cancelled',
      deposit_status = 'expired',
      hold_expired_notification_status = 'pending'
  where id = '98000000-0000-4000-8000-000000000044';

  perform public.claim_expired_booking_hold_notifications(100);
  notification_blocked := exists (
    select 1 from public.appointments
    where id = '98000000-0000-4000-8000-000000000044'
      and hold_expired_notification_status = 'pending'
      and hold_expired_notification_attempts = 0
      and hold_expired_notification_claimed_at is null
  );

  update public.whatsapp_automation_dispatches
  set status = 'completed',
      completion_reason = 'skipped',
      completed_at = clock_timestamp()
  where message_id = '98000000-0000-4000-8000-000000000056';

  perform public.claim_expired_booking_hold_notifications(100);
  return cron_blocked
    and notification_blocked
    and exists (
      select 1 from public.appointments
      where id = '98000000-0000-4000-8000-000000000044'
        and hold_expired_notification_status = 'processing'
        and hold_expired_notification_attempts = 1
        and hold_expired_notification_claimed_at is not null
    );
end;
$$;

select ok(
  pg_temp.pending_dispatch_blocks_expiration_work(),
  'a timely pending dispatch blocks hold expiry and notification claim only until terminal'
);

-- Fallback causal cuando la descarga/OCR no puede producir una lectura.
insert into public.contacts (
  id, phone_e164, whatsapp_id, name, coverage, is_existing_patient
) values
  (
    '98000000-0000-4000-8000-000000000018', '+5491100009818',
    '5491100009818', 'Proof Route Contact', 'ioma', true
  ),
  (
    '98000000-0000-4000-8000-000000000019', '+5491100009819',
    '5491100009819', 'Proof Route Guard Contact', 'ioma', true
  );

insert into public.conversations (
  id, contact_id, automation_mode, needs_human, priority
) values
  (
    '98000000-0000-4000-8000-000000000028',
    '98000000-0000-4000-8000-000000000018',
    'auto', false, false
  ),
  (
    '98000000-0000-4000-8000-000000000029',
    '98000000-0000-4000-8000-000000000019',
    'auto', false, false
  );

insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at,
  status, source, coverage, duration_minutes, deposit_status,
  hold_expires_at, hold_expired_notification_status
) values
  (
    '98000000-0000-4000-8000-000000000041',
    '98000000-0000-4000-8000-000000000018',
    '98000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '19:00') at time zone
      'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '19:30') at time zone
      'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'ioma', 30, 'pending',
    clock_timestamp() + interval '1 hour', 'pending'
  ),
  (
    '98000000-0000-4000-8000-000000000042',
    '98000000-0000-4000-8000-000000000019',
    '98000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '20:00') at time zone
      'America/Argentina/Buenos_Aires',
    (:'test_date'::date + time '20:30') at time zone
      'America/Argentina/Buenos_Aires',
    'scheduled', 'whatsapp', 'ioma', 30, 'pending',
    clock_timestamp() + interval '1 hour', 'pending'
  );

insert into public.automation_sessions (
  conversation_id, state, context, expires_at
) values
  (
    '98000000-0000-4000-8000-000000000028',
    'waiting_deposit',
    jsonb_build_object(
      'appointmentId', '98000000-0000-4000-8000-000000000041'
    ),
    clock_timestamp() + interval '1 hour'
  ),
  (
    '98000000-0000-4000-8000-000000000029',
    'waiting_deposit',
    jsonb_build_object(
      'appointmentId', '98000000-0000-4000-8000-000000000042'
    ),
    clock_timestamp() + interval '1 hour'
  );

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, metadata
) values
  (
    '98000000-0000-4000-8000-000000000052',
    '98000000-0000-4000-8000-000000000028',
    '98000000-0000-4000-8000-000000000018',
    'inbound', 'image', 'No se pudo descargar', 'delivered', '{}'::jsonb
  ),
  (
    '98000000-0000-4000-8000-000000000054',
    '98000000-0000-4000-8000-000000000029',
    '98000000-0000-4000-8000-000000000019',
    'inbound', 'document', 'Media apagada.pdf', 'delivered', '{}'::jsonb
  );

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000052', '{}'::jsonb, 900
)
\gset route_claim_

select public.route_automated_deposit_proof_to_review(
  '98000000-0000-4000-8000-000000000052',
  (select lease_token from public.whatsapp_automation_executions
   where message_id = '98000000-0000-4000-8000-000000000052'),
  '98000000-0000-4000-8000-000000000041',
  'DOWNLOAD_FAILED'
) as result
\gset routed_review_

select ok(
  :'routed_review_result'::jsonb ->> 'status' = 'review'
  and :'routed_review_result'::jsonb ->> 'route_reason' = 'DOWNLOAD_FAILED'
  and (:'routed_review_result'::jsonb ->> 'starts_at') is not null
  and (
    select status = 'scheduled'
      and deposit_status = 'proof_received'
      and deposit_proof_message_id =
        '98000000-0000-4000-8000-000000000052'
    from public.appointments
    where id = '98000000-0000-4000-8000-000000000041'
  )
  and (
    select automation_mode = 'manual'
      and needs_human
      and automation_pause_message_id =
        '98000000-0000-4000-8000-000000000052'
    from public.conversations
    where id = '98000000-0000-4000-8000-000000000028'
  )
  and (
    select state = 'human_handoff'
      and context ->> 'appointmentId' =
        '98000000-0000-4000-8000-000000000041'
    from public.automation_sessions
    where conversation_id = '98000000-0000-4000-8000-000000000028'
  )
  and exists (
    select 1 from public.whatsapp_automation_effects
    where execution_message_id =
      '98000000-0000-4000-8000-000000000052'
      and effect_type = 'appointment_deposit_process'
      and result ->> 'status' = 'review'
  )
  and exists (
    select 1 from public.audit_logs
    where entity_id = '98000000-0000-4000-8000-000000000041'
      and action = 'deposit.automated_proof_route_review'
  ),
  'download failure atomically associates the exact proof and durable review handoff'
);

select public.route_automated_deposit_proof_to_review(
  '98000000-0000-4000-8000-000000000052',
  (select lease_token from public.whatsapp_automation_executions
   where message_id = '98000000-0000-4000-8000-000000000052'),
  '98000000-0000-4000-8000-000000000041',
  'DOWNLOAD_FAILED'
) as result
\gset routed_retry_

select ok(
  :'routed_retry_result'::jsonb ->> 'status' = 'review'
  and (:'routed_retry_result'::jsonb ->> 'idempotent')::boolean
  and (
    select count(*) = 1 from public.automated_deposit_proof_results
    where appointment_id = '98000000-0000-4000-8000-000000000041'
  )
  and (
    select count(*) = 1 from public.whatsapp_automation_effects
    where execution_message_id =
      '98000000-0000-4000-8000-000000000052'
      and effect_type = 'appointment_deposit_process'
  )
  and (
    select count(*) = 1 from public.audit_logs
    where entity_id = '98000000-0000-4000-8000-000000000041'
      and action = 'deposit.automated_proof_route_review'
  ),
  'an exact review-route retry duplicates no ledger, effect or audit event'
);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000054', '{}'::jsonb, 900
)
\gset guarded_route_claim_

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"98000000-0000-4000-8000-000000000099"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
update public.conversations
set automation_mode = 'manual'
where id = '98000000-0000-4000-8000-000000000029';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

create function pg_temp.guarded_review_route_rolls_back()
returns boolean
language plpgsql
as $$
declare
  blocked boolean := false;
begin
  begin
    perform public.route_automated_deposit_proof_to_review(
      '98000000-0000-4000-8000-000000000054',
      (select lease_token from public.whatsapp_automation_executions
       where message_id = '98000000-0000-4000-8000-000000000054'),
      '98000000-0000-4000-8000-000000000042',
      'MEDIA_DISABLED'
    );
  exception
    when sqlstate '55000' then
      blocked := sqlerrm = 'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL';
  end;

  return blocked
    and exists (
      select 1 from public.appointments
      where id = '98000000-0000-4000-8000-000000000042'
        and status = 'scheduled'
        and deposit_status = 'pending'
        and deposit_proof_message_id is null
    )
    and not exists (
      select 1 from public.automated_deposit_proof_results
      where appointment_id = '98000000-0000-4000-8000-000000000042'
    )
    and not exists (
      select 1 from public.whatsapp_automation_effects
      where execution_message_id =
        '98000000-0000-4000-8000-000000000054'
        and effect_type = 'appointment_deposit_process'
    )
    and not exists (
      select 1 from public.audit_logs
      where entity_id = '98000000-0000-4000-8000-000000000042'
        and action like 'deposit.automated_proof_route%'
    )
    and not (
      select metadata ? 'deposit_proof'
      from public.messages
      where id = '98000000-0000-4000-8000-000000000054'
    )
    and exists (
      select 1 from public.automation_sessions
      where conversation_id = '98000000-0000-4000-8000-000000000029'
        and state = 'waiting_deposit'
    );
end;
$$;

select ok(
  pg_temp.guarded_review_route_rolls_back(),
  'operator ownership rolls back the entire no-reading review route'
);

-- Una respuesta humana posterior al inbound debe bloquear incluso el camino
-- late: metadata, turno, ledger, conversación y effect son una sola mutación.
insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at,
  status, source, coverage, duration_minutes, deposit_status,
  hold_expires_at, hold_expired_notification_status
) values (
  '98000000-0000-4000-8000-000000000039',
  '98000000-0000-4000-8000-000000000016',
  '98000000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000002',
  (:'test_date'::date + time '17:00') at time zone
    'America/Argentina/Buenos_Aires',
  (:'test_date'::date + time '17:30') at time zone
    'America/Argentina/Buenos_Aires',
  'scheduled', 'whatsapp', 'ioma', 30, 'pending',
  clock_timestamp() - interval '1 minute', 'pending'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, metadata
) values (
  '98000000-0000-4000-8000-000000000050',
  '98000000-0000-4000-8000-000000000026',
  '98000000-0000-4000-8000-000000000016',
  'inbound', 'image', 'Tardío con respuesta humana', 'delivered', '{}'::jsonb
);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000050', '{}'::jsonb, 900
)
\gset barrier_claim_

select public.mark_whatsapp_automation_human_reply(
  '98000000-0000-4000-8000-000000000026',
  '98000000-0000-4000-8000-000000000016'
);

create function pg_temp.human_barrier_rolls_back_late_proof()
returns boolean
language plpgsql
as $$
declare
  blocked boolean := false;
begin
  begin
    perform public.process_automated_deposit_proof(
      '98000000-0000-4000-8000-000000000050',
      (select lease_token from public.whatsapp_automation_executions
       where message_id = '98000000-0000-4000-8000-000000000050'),
      '98000000-0000-4000-8000-000000000039',
      '{"legible":true,"amount":10000,"currency":"ARS","date":null,"destination":"odontologa.gisela.mp","holder":"Gisela Vanesa Lentz","operationId":"barrier-late"}'::jsonb,
      repeat('3', 64), 'deposit-proof-basic/v1', true
    );
  exception
    when sqlstate '55000' then
      blocked := sqlerrm =
        'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_HUMAN_REPLY';
  end;

  return blocked
    and exists (
      select 1 from public.appointments
      where id = '98000000-0000-4000-8000-000000000039'
        and status = 'scheduled'
        and deposit_status = 'pending'
        and deposit_proof_message_id is null
    )
    and not exists (
      select 1 from public.automated_deposit_proof_results
      where appointment_id = '98000000-0000-4000-8000-000000000039'
    )
    and not exists (
      select 1 from public.whatsapp_automation_effects
      where execution_message_id =
        '98000000-0000-4000-8000-000000000050'
        and effect_type = 'appointment_deposit_process'
    )
    and not exists (
      select 1 from public.audit_logs
      where entity_id = '98000000-0000-4000-8000-000000000039'
        and action like 'deposit.automated%'
    )
    and not (
      select metadata ? 'deposit_proof'
      from public.messages
      where id = '98000000-0000-4000-8000-000000000050'
    )
    and exists (
      select 1 from public.conversations
      where id = '98000000-0000-4000-8000-000000000026'
        and automation_mode = 'auto'
        and not needs_human
        and automation_human_barrier_ingest_sequence >= (
          select whatsapp_ingest_sequence from public.messages
          where id = '98000000-0000-4000-8000-000000000050'
        )
    )
    and exists (
      select 1 from public.automation_sessions
      where conversation_id = '98000000-0000-4000-8000-000000000026'
        and state = 'waiting_deposit'
        and last_automation_message_id is null
    );
end;
$$;

select ok(
  pg_temp.human_barrier_rolls_back_late_proof(),
  'a newer human barrier rolls back the whole late-proof mutation'
);

-- Un opt-out detectado en la transcripción conserva como evidencia el audio
-- inbound original y sólo puede escribirse con su ejecución/lease causal.
insert into public.contacts (
  id, phone_e164, whatsapp_id, name, coverage, is_existing_patient
) values
  (
    '98000000-0000-4000-8000-000000000022', '+5491100009822',
    '5491100009822', 'Audio Opt Out Contact', 'ioma', true
  ),
  (
    '98000000-0000-4000-8000-000000000023', '+5491100009823',
    '5491100009823', 'Audio Invalid Context Contact', 'ioma', true
  );

insert into public.conversations (
  id, contact_id, automation_mode, needs_human, priority
) values
  (
    '98000000-0000-4000-8000-000000000032',
    '98000000-0000-4000-8000-000000000022',
    'auto', false, false
  ),
  (
    '98000000-0000-4000-8000-000000000033',
    '98000000-0000-4000-8000-000000000023',
    'auto', false, false
  );

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, metadata,
  whatsapp_message_id
) values
  (
    '98000000-0000-4000-8000-000000000057',
    '98000000-0000-4000-8000-000000000032',
    '98000000-0000-4000-8000-000000000022',
    'inbound', 'audio', '', 'delivered', '{}'::jsonb,
    'wamid.audio-opt-out-57'
  ),
  (
    '98000000-0000-4000-8000-000000000058',
    '98000000-0000-4000-8000-000000000033',
    '98000000-0000-4000-8000-000000000023',
    'inbound', 'audio', '', 'delivered', '{}'::jsonb,
    'wamid.audio-opt-out-58'
  );

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000057', '{}'::jsonb, 900
)
\gset audio_opt_out_claim_

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000058', '{}'::jsonb, 900
)
\gset audio_invalid_context_claim_

select public.record_transcribed_whatsapp_opt_out(
  '98000000-0000-4000-8000-000000000057',
  :'audio_opt_out_claim_lease_token'::uuid
) as recorded
\gset audio_opt_out_result_

select ok(
  :'audio_opt_out_result_recorded'::boolean
  and (
    select whatsapp_consent_status = 'opted_out'
    from public.contacts
    where id = '98000000-0000-4000-8000-000000000022'
  ),
  'a causal audio execution records an all-purpose WhatsApp opt-out'
);

select ok(
  public.record_transcribed_whatsapp_opt_out(
    '98000000-0000-4000-8000-000000000057',
    :'audio_opt_out_claim_lease_token'::uuid
  )
  and (
    select count(*) = 1
      and bool_and(decision = 'opt_out')
      and bool_and(purpose = 'all')
      and bool_and(source = 'whatsapp')
      and bool_and(
        policy_version =
          'whatsapp-business-messaging-policy/2026-08-10'
      )
    from public.whatsapp_consent_events
    where whatsapp_message_id = 'wamid.audio-opt-out-57'
  ),
  'the same audio and lease are idempotent and preserve one exact consent event'
);

select throws_ok(
  $$
    select public.record_transcribed_whatsapp_opt_out(
      '98000000-0000-4000-8000-000000000058',
      '98000000-0000-4000-8000-000000009999'::uuid
    )
  $$,
  '55000',
  'WHATSAPP_AUTOMATION_EXECUTION_LEASE_INVALID',
  'an invalid lease cannot record a transcribed opt-out'
);

update public.whatsapp_automation_executions
set contact_id = '98000000-0000-4000-8000-000000000022'
where message_id = '98000000-0000-4000-8000-000000000058';

create function pg_temp.invalid_audio_context_does_not_record_consent()
returns boolean
language plpgsql
as $$
declare
  blocked boolean := false;
  causal_lease uuid;
begin
  select execution.lease_token into causal_lease
  from public.whatsapp_automation_executions execution
  where execution.message_id =
    '98000000-0000-4000-8000-000000000058';
  begin
    perform public.record_transcribed_whatsapp_opt_out(
      '98000000-0000-4000-8000-000000000058',
      causal_lease
    );
  exception
    when sqlstate '23514' then
      blocked := sqlerrm =
        'WHATSAPP_AUTOMATION_OPT_OUT_CONTEXT_MISMATCH';
  end;
  return blocked and not exists (
    select 1 from public.whatsapp_consent_events
    where whatsapp_message_id = 'wamid.audio-opt-out-58'
  );
end;
$$;

select ok(
  pg_temp.invalid_audio_context_does_not_record_consent(),
  'a mismatched execution contact rolls back without recording consent'
);

update public.whatsapp_automation_executions
set contact_id = '98000000-0000-4000-8000-000000000023'
where message_id = '98000000-0000-4000-8000-000000000058';

select public.record_whatsapp_consent(
  '98000000-0000-4000-8000-000000000023',
  'opt_in', 'all', 'web', 'later explicit web consent',
  'whatsapp-business-messaging-policy/2026-08-10', null
);

select ok(
  public.record_transcribed_whatsapp_opt_out(
    '98000000-0000-4000-8000-000000000058',
    :'audio_invalid_context_claim_lease_token'::uuid
  )
  and (
    select whatsapp_consent_status = 'opted_in'
    from public.contacts
    where id = '98000000-0000-4000-8000-000000000023'
  )
  and not exists (
    select 1 from public.whatsapp_consent_events
    where whatsapp_message_id = 'wamid.audio-opt-out-58'
  ),
  'a later web consent without a WhatsApp message supersedes delayed audio by time'
);

insert into public.contacts (
  id, phone_e164, whatsapp_id, name, coverage, is_existing_patient
) values (
  '98000000-0000-4000-8000-000000000024', '+5491100009824',
  '5491100009824', 'Later Consent Contact', 'ioma', true
);

insert into public.conversations (
  id, contact_id, automation_mode, needs_human, priority
) values (
  '98000000-0000-4000-8000-000000000034',
  '98000000-0000-4000-8000-000000000024',
  'auto', false, false
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, metadata,
  whatsapp_message_id
) values (
  '98000000-0000-4000-8000-000000000059',
  '98000000-0000-4000-8000-000000000034',
  '98000000-0000-4000-8000-000000000024',
  'inbound', 'audio', '', 'delivered', '{}'::jsonb,
  'wamid.audio-superseded-59'
);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000059', '{}'::jsonb, 900
)
\gset audio_superseded_claim_

update public.conversations
set status = 'closed'
where id = '98000000-0000-4000-8000-000000000034';

insert into public.conversations (
  id, contact_id, automation_mode, needs_human, priority
) values (
  '98000000-0000-4000-8000-000000000035',
  '98000000-0000-4000-8000-000000000024',
  'auto', false, false
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, metadata,
  whatsapp_message_id
) values (
  '98000000-0000-4000-8000-000000000060',
  '98000000-0000-4000-8000-000000000035',
  '98000000-0000-4000-8000-000000000024',
  'inbound', 'text', 'Sí, acepto recibir mensajes', 'delivered', '{}'::jsonb,
  'wamid.explicit-opt-in-60'
);

select public.record_whatsapp_consent(
  '98000000-0000-4000-8000-000000000024',
  'opt_in', 'all', 'whatsapp',
  'explicit inbound after delayed audio',
  'whatsapp-business-messaging-policy/2026-08-10',
  'wamid.explicit-opt-in-60'
);

select ok(
  public.record_transcribed_whatsapp_opt_out(
    '98000000-0000-4000-8000-000000000059',
    :'audio_superseded_claim_lease_token'::uuid
  )
  and (
    select whatsapp_consent_status = 'opted_in'
    from public.contacts
    where id = '98000000-0000-4000-8000-000000000024'
  )
  and not exists (
    select 1 from public.whatsapp_consent_events
    where whatsapp_message_id = 'wamid.audio-superseded-59'
  ),
  'an explicit inbound consent at T2 supersedes a delayed audio opt-out from T1'
);

select ok(
  not exists (
    select 1
    from public.automated_deposit_proof_results result
    where result.result ->> 'starts_at' is null
  ),
  'every persisted confirmed, review and late result includes starts_at'
);

select hasnt_table(
  'public',
  'deposit_confirmation_notifications',
  'no second notification outbox can race the durable automation send effect'
);

select * from finish();
rollback;
