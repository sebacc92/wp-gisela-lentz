\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(51);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

-- This suite exercises automation mechanics rather than the operational
-- switch. Claims now enforce that switch authoritatively, so make the fixture
-- intent explicit.
update public.app_settings set automations_enabled = true where id;

select (
  current_date + 7 + mod(8 - extract(isodow from current_date)::integer, 7)
)::date as test_date
\gset

update public.app_settings
set minimum_booking_notice_minutes = 0,
    appointment_buffer_minutes = 0,
    deposit_enabled = false,
    ioma_duration_minutes = 30,
    private_duration_minutes = 60
where id = true;

insert into public.professionals (
  id, name, specialty, appointment_duration_minutes, active
) values (
  '97000000-0000-4000-8000-000000000001',
  'Automation Idempotency Professional',
  'Test',
  30,
  true
);

insert into public.services (
  id, name, duration_minutes, active, sort_order
) values (
  '97000000-0000-4000-8000-000000000002',
  'Automation Idempotency Service',
  30,
  true,
  9700
);

insert into public.availability_rules (
  professional_id, weekday, start_time, end_time, slot_minutes, active
) values (
  '97000000-0000-4000-8000-000000000001',
  1,
  '09:00',
  '18:00',
  30,
  true
);

insert into public.contacts (
  id, phone_e164, whatsapp_id, name, coverage, is_existing_patient
) values (
  '97000000-0000-4000-8000-000000000003',
  '+5491100009703',
  '5491100009703',
  'Automation Idempotency Contact',
  'ioma',
  true
);

insert into public.conversations (
  id, contact_id, automation_mode, priority
) values (
  '97000000-0000-4000-8000-000000000004',
  '97000000-0000-4000-8000-000000000003',
  'auto',
  false
);

insert into public.automation_sessions (
  conversation_id, state, context, expires_at
) values (
  '97000000-0000-4000-8000-000000000004',
  'confirming_appointment',
  '{"branch":"original","slots":[{"startsAt":"immutable"}]}'::jsonb,
  clock_timestamp() + interval '1 hour'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, created_at
) values
  (
    '97000000-0000-4000-8000-000000000010',
    '97000000-0000-4000-8000-000000000004',
    '97000000-0000-4000-8000-000000000003',
    'inbound', 'text', 'appointment:confirm', 'read', clock_timestamp()
  ),
  (
    '97000000-0000-4000-8000-000000000011',
    '97000000-0000-4000-8000-000000000004',
    '97000000-0000-4000-8000-000000000003',
    'inbound', 'text', 'reschedule:confirm', 'read',
    clock_timestamp() + interval '1 second'
  ),
  (
    '97000000-0000-4000-8000-000000000012',
    '97000000-0000-4000-8000-000000000004',
    '97000000-0000-4000-8000-000000000003',
    'inbound', 'text', 'cancel:yes', 'read',
    clock_timestamp() + interval '2 seconds'
  ),
  (
    '97000000-0000-4000-8000-000000000013',
    '97000000-0000-4000-8000-000000000004',
    '97000000-0000-4000-8000-000000000003',
    'inbound', 'text', 'old session write', 'read',
    clock_timestamp() + interval '10 seconds'
  ),
  (
    '97000000-0000-4000-8000-000000000014',
    '97000000-0000-4000-8000-000000000004',
    '97000000-0000-4000-8000-000000000003',
    'inbound', 'text', 'new session write', 'read',
    clock_timestamp() + interval '20 seconds'
  );

select *
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000010',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset first_

select is(
  :'first_disposition'::text,
  'claimed'::text,
  'the first delivery claims an execution'
);
select is(
  :'first_session_state'::text,
  'confirming_appointment'::text,
  'the first claim freezes the initial session state'
);
select is(
  (:'first_session_context'::jsonb ->> 'branch'),
  'original',
  'the first claim freezes the initial session context'
);

update public.automation_sessions
set state = 'idle', context = '{"branch":"mutated"}'::jsonb
where conversation_id = '97000000-0000-4000-8000-000000000004';

select is(
  (
    select disposition
    from public.claim_whatsapp_automation_execution(
      '97000000-0000-4000-8000-000000000010',
      '{"delivery_mode":"whatsapp"}'::jsonb,
      900
    )
  ),
  'busy',
  'a live lease prevents concurrent execution of the same inbound message'
);

select ok(
  public.fail_whatsapp_automation_execution(
    '97000000-0000-4000-8000-000000000010',
    :'first_lease_token'::uuid,
    'crash after domain commit',
    true
  ),
  'a failed attempt is durably marked retryable'
);

select *
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000010',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset create_retry_

select ok(
  :'create_retry_disposition' = 'claimed'
    and :'create_retry_attempts'::integer = 2
    and :'create_retry_lease_token' <> :'first_lease_token'
    and :'create_retry_session_state' = 'confirming_appointment'
    and (:'create_retry_session_context'::jsonb ->> 'branch') = 'original',
  'retry gets a new lease but reuses the immutable initial snapshot'
);

select is(
  public.remember_whatsapp_automation_decision(
    '97000000-0000-4000-8000-000000000010',
    :'create_retry_lease_token'::uuid,
    0,
    'available_slots',
    '{"value":["slot-a"]}'::jsonb
  ) -> 'value',
  '["slot-a"]'::jsonb,
  'the first dynamic decision is written to the execution ledger'
);
select is(
  public.remember_whatsapp_automation_decision(
    '97000000-0000-4000-8000-000000000010',
    :'create_retry_lease_token'::uuid,
    0,
    'available_slots',
    '{"value":["slot-b"]}'::jsonb
  ) -> 'value',
  '["slot-a"]'::jsonb,
  'retry reuses the first decision even when the live query changed'
);
select throws_ok(
  format(
    $$select public.remember_whatsapp_automation_decision(
      '97000000-0000-4000-8000-000000000010', %L::uuid, 0,
      'different_decision', '{"value":true}'::jsonb
    )$$,
    :'create_retry_lease_token'
  ),
  '23514',
  'WHATSAPP_AUTOMATION_EFFECT_CONFLICT',
  'a decision sequence cannot be reused for another branch input'
);

select is(
  public.apply_whatsapp_automation_profile(
    '97000000-0000-4000-8000-000000000010',
    :'create_retry_lease_token'::uuid,
    '{"name":"Profile From Inbound"}'::jsonb
  ) ->> 'name',
  'Profile From Inbound',
  'profile mutation is committed together with its effect ledger'
);
update public.contacts
set name = 'Operator Override'
where id = '97000000-0000-4000-8000-000000000003';
select ok(
  public.apply_whatsapp_automation_profile(
    '97000000-0000-4000-8000-000000000010',
    :'create_retry_lease_token'::uuid,
    '{"name":"Profile From Inbound"}'::jsonb
  ) ->> 'name' = 'Profile From Inbound'
  and (
    select name = 'Operator Override'
    from public.contacts
    where id = '97000000-0000-4000-8000-000000000003'
  )
  and (
    select count(*) = 1
    from public.whatsapp_automation_effects
    where execution_message_id = '97000000-0000-4000-8000-000000000010'
      and effect_type = 'profile_update'
  ),
  'profile retry returns its snapshot without overwriting a later operator edit'
);
select throws_ok(
  format(
    $$select public.apply_whatsapp_automation_profile(
      '97000000-0000-4000-8000-000000000010', %L::uuid,
      '{"name":"Different Retry"}'::jsonb
    )$$,
    :'create_retry_lease_token'
  ),
  '23514',
  'WHATSAPP_AUTOMATION_EFFECT_CONFLICT',
  'the same inbound cannot apply a different profile mutation on retry'
);

select public.create_whatsapp_automation_appointment(
  '97000000-0000-4000-8000-000000000010',
  :'create_retry_lease_token'::uuid,
  '97000000-0000-4000-8000-000000000003',
  '97000000-0000-4000-8000-000000000001',
  '97000000-0000-4000-8000-000000000002',
  (:'test_date'::date + time '14:00')
    at time zone 'America/Argentina/Buenos_Aires'
) ->> 'id' as appointment_id
\gset

select ok(
  :'appointment_id' ~ '^[0-9a-f-]{36}$',
  'create wrapper returns the committed appointment snapshot'
);
select is(
  public.create_whatsapp_automation_appointment(
    '97000000-0000-4000-8000-000000000010',
    :'create_retry_lease_token'::uuid,
    '97000000-0000-4000-8000-000000000003',
    '97000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000002',
    (:'test_date'::date + time '14:00')
      at time zone 'America/Argentina/Buenos_Aires'
  ) ->> 'id',
  :'appointment_id',
  'duplicate create returns the same appointment instead of creating another'
);
select ok(
  (
    select count(*) = 1
    from public.appointments appointment
    where appointment.contact_id = '97000000-0000-4000-8000-000000000003'
  )
  and (
    select count(*) = 1
    from public.whatsapp_automation_effects effect
    where effect.execution_message_id = '97000000-0000-4000-8000-000000000010'
      and effect.effect_type = 'appointment_create'
  ),
  'create has exactly one domain row and one ledger row'
);
select throws_ok(
  format(
    $$select public.create_whatsapp_automation_appointment(
      '97000000-0000-4000-8000-000000000010', %L::uuid,
      '97000000-0000-4000-8000-000000000003',
      '97000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000002', %L::timestamptz
    )$$,
    :'create_retry_lease_token',
    (
      (:'test_date'::date + time '14:30')
        at time zone 'America/Argentina/Buenos_Aires'
    )::text
  ),
  '23514',
  'WHATSAPP_AUTOMATION_EFFECT_CONFLICT',
  'the same inbound cannot create a different appointment on retry'
);

select ok(
  public.save_whatsapp_automation_session(
    '97000000-0000-4000-8000-000000000010',
    :'create_retry_lease_token'::uuid,
    0,
    'waiting_deposit',
    jsonb_build_object('appointmentId', :'appointment_id'),
    :'test_date'::date + time '15:00'
  ),
  'the first session effect is applied'
);
select public.save_whatsapp_automation_session(
  '97000000-0000-4000-8000-000000000010',
  :'create_retry_lease_token'::uuid,
  0,
  'waiting_deposit',
  jsonb_build_object('appointmentId', :'appointment_id'),
  :'test_date'::date + time '15:00'
) as retry_applied
\gset session_retry_
select public.save_whatsapp_automation_session(
  '97000000-0000-4000-8000-000000000010',
  :'create_retry_lease_token'::uuid,
  1,
  'idle',
  '{}'::jsonb,
  :'test_date'::date + time '16:00'
) as next_applied
\gset session_next_
select ok(
  :'session_retry_retry_applied'::boolean
  and :'session_next_next_applied'::boolean
  and (
    select state = 'idle' and last_automation_session_sequence = 1
    from public.automation_sessions
    where conversation_id = '97000000-0000-4000-8000-000000000004'
  ),
  'session effects are idempotent and preserve their deterministic sequence'
);

select ok(
  public.complete_whatsapp_automation_execution(
    '97000000-0000-4000-8000-000000000010',
    :'create_retry_lease_token'::uuid,
    '{"processed":true,"state":"idle"}'::jsonb
  ),
  'the claimed execution is completed with a durable outcome'
);
select ok(
  (
    select disposition = 'completed'
      and outcome = '{"processed":true,"state":"idle"}'::jsonb
    from public.claim_whatsapp_automation_execution(
      '97000000-0000-4000-8000-000000000010',
      '{"delivery_mode":"whatsapp"}'::jsonb,
      900
    )
  ),
  'a delivery after completion is a durable no-op with the original outcome'
);
select throws_ok(
  format(
    $$select public.claim_whatsapp_automation_execution(
      '97000000-0000-4000-8000-000000000010',
      '{"delivery_mode":"conflicting_retry"}'::jsonb,
      900
    )$$
  ),
  '23514',
  'WHATSAPP_AUTOMATION_REQUEST_CONFLICT',
  'the same inbound cannot be replayed with a different invocation context'
);
select throws_ok(
  format(
    $$select public.cancel_whatsapp_automation_appointment(
      '97000000-0000-4000-8000-000000000010', %L::uuid, %L::uuid
    )$$,
    :'create_retry_lease_token',
    :'appointment_id'
  ),
  '55000',
  'WHATSAPP_AUTOMATION_EXECUTION_LEASE_INVALID',
  'domain effects cannot run after execution completion'
);

select *
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000011',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset reschedule_

select public.reschedule_whatsapp_automation_appointment(
  '97000000-0000-4000-8000-000000000011',
  :'reschedule_lease_token'::uuid,
  :'appointment_id'::uuid,
  (:'test_date'::date + time '15:00')
    at time zone 'America/Argentina/Buenos_Aires'
) ->> 'starts_at' as rescheduled_at
\gset

select is(
  (select starts_at from public.appointments where id = :'appointment_id'),
  :'rescheduled_at'::timestamptz,
  'reschedule wrapper commits the requested slot'
);
select ok(
  public.fail_whatsapp_automation_execution(
    '97000000-0000-4000-8000-000000000011',
    :'reschedule_lease_token'::uuid,
    'crash after reschedule commit',
    true
  ),
  'reschedule execution can fail after its domain commit'
);
select *
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000011',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset reschedule_retry_
select is(
  public.reschedule_whatsapp_automation_appointment(
    '97000000-0000-4000-8000-000000000011',
    :'reschedule_retry_lease_token'::uuid,
    :'appointment_id'::uuid,
    (:'test_date'::date + time '15:00')
      at time zone 'America/Argentina/Buenos_Aires'
  ) ->> 'starts_at',
  :'rescheduled_at',
  'reschedule retry returns the original committed effect snapshot'
);
select is(
  (
    select count(*)::text
    from public.whatsapp_automation_effects
    where execution_message_id = '97000000-0000-4000-8000-000000000011'
      and effect_type = 'appointment_reschedule'
  ),
  '1',
  'reschedule retry does not duplicate its ledger effect'
);
select throws_ok(
  format(
    $$select public.reschedule_whatsapp_automation_appointment(
      '97000000-0000-4000-8000-000000000011', %L::uuid, %L::uuid,
      %L::timestamptz
    )$$,
    :'reschedule_retry_lease_token',
    :'appointment_id',
    (
      (:'test_date'::date + time '15:30')
        at time zone 'America/Argentina/Buenos_Aires'
    )::text
  ),
  '23514',
  'WHATSAPP_AUTOMATION_EFFECT_CONFLICT',
  'reschedule retry cannot change the requested slot'
);
select public.complete_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000011',
  :'reschedule_retry_lease_token'::uuid,
  '{"processed":true}'::jsonb
);

select *
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000012',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset cancel_
select public.cancel_whatsapp_automation_appointment(
  '97000000-0000-4000-8000-000000000012',
  :'cancel_lease_token'::uuid,
  :'appointment_id'::uuid
) ->> 'status' as cancelled_status
\gset
select is(
  :'cancelled_status'::text,
  'cancelled'::text,
  'cancel wrapper commits cancellation'
);
select ok(
  public.fail_whatsapp_automation_execution(
    '97000000-0000-4000-8000-000000000012',
    :'cancel_lease_token'::uuid,
    'crash after cancellation commit',
    true
  ),
  'cancel execution can fail after its domain commit'
);
select *
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000012',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset cancel_retry_
select is(
  public.cancel_whatsapp_automation_appointment(
    '97000000-0000-4000-8000-000000000012',
    :'cancel_retry_lease_token'::uuid,
    :'appointment_id'::uuid
  ) ->> 'status',
  'cancelled',
  'cancel retry succeeds from its ledger after the appointment is inactive'
);
select is(
  (
    select count(*)::text
    from public.whatsapp_automation_effects
    where execution_message_id = '97000000-0000-4000-8000-000000000012'
      and effect_type = 'appointment_cancel'
  ),
  '1',
  'cancel retry does not duplicate its ledger effect'
);
select public.pause_whatsapp_automation_for_inbound_handoff(
  '97000000-0000-4000-8000-000000000012',
  true,
  'post_cancel_handoff'
) as claimed
\gset cancel_handoff_
select public.handoff_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000012',
  :'cancel_retry_lease_token'::uuid,
  'POST_CANCEL_SEND_FAILED',
  :'appointment_id'::uuid
) ->> 'reason' as reason
\gset handoff_first_
select public.handoff_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000012',
  :'cancel_retry_lease_token'::uuid,
  'POST_CANCEL_SEND_FAILED',
  :'appointment_id'::uuid
) ->> 'reason' as reason
\gset handoff_retry_
select ok(
  :'cancel_handoff_claimed'::boolean
  and :'handoff_first_reason'::text = 'POST_CANCEL_SEND_FAILED'
  and :'handoff_retry_reason'::text = 'POST_CANCEL_SEND_FAILED'
  and (
    select count(*) = 1
    from public.whatsapp_automation_effects
    where execution_message_id = '97000000-0000-4000-8000-000000000012'
      and effect_type = 'handoff'
  ),
  'post-domain handoff is idempotent for the same appointment and reason'
);
select throws_ok(
  format(
    $$select public.handoff_whatsapp_automation_execution(
      '97000000-0000-4000-8000-000000000012', %L::uuid,
      'DIFFERENT_REASON', %L::uuid
    )$$,
    :'cancel_retry_lease_token',
    :'appointment_id'
  ),
  '23514',
  'WHATSAPP_AUTOMATION_EFFECT_CONFLICT',
  'post-domain handoff cannot silently deduplicate different retry inputs'
);
select public.complete_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000012',
  :'cancel_retry_lease_token'::uuid,
  '{"processed":true}'::jsonb
);

-- A human/operator explicitly returns the conversation to automation before
-- the independent ingest-order scenario below.
update public.conversations
set automation_mode = 'auto', needs_human = false
where id = '97000000-0000-4000-8000-000000000004';

select * from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000013',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
) \gset older_
select is(
  (
    select disposition
    from public.claim_whatsapp_automation_execution(
      '97000000-0000-4000-8000-000000000014',
      '{"delivery_mode":"whatsapp"}'::jsonb,
      900
    )
  ),
  'busy',
  'a later inbound cannot snapshot while an earlier conversation execution is open'
);
select ok(
  public.save_whatsapp_automation_session(
    '97000000-0000-4000-8000-000000000013',
    :'older_lease_token'::uuid,
    0,
    'older_state',
    '{"source":"older"}'::jsonb,
    clock_timestamp() + interval '1 hour'
  )
  and public.complete_whatsapp_automation_execution(
    '97000000-0000-4000-8000-000000000013',
    :'older_lease_token'::uuid,
    '{"processed":true}'::jsonb
  ),
  'the earlier execution writes and completes before releasing the conversation'
);
select * from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000014',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
) \gset newer_
select public.save_whatsapp_automation_session(
  '97000000-0000-4000-8000-000000000014',
  :'newer_lease_token'::uuid,
  0,
  'newer_state',
  '{"source":"newer"}'::jsonb,
  clock_timestamp() + interval '1 hour'
) as applied
\gset newer_write_
select ok(
  :'newer_write_applied'::boolean
  and (
    select state = 'newer_state'
      and context ->> 'source' = 'newer'
      and last_automation_message_id =
        '97000000-0000-4000-8000-000000000014'
      and last_automation_ingest_sequence = (
        select whatsapp_ingest_sequence
        from public.messages
        where id = '97000000-0000-4000-8000-000000000014'
      )
    from public.automation_sessions
    where conversation_id = '97000000-0000-4000-8000-000000000004'
  ),
  'the newer session marker follows the authoritative ingest sequence'
);

update public.conversations
set current_flow = 'side-query-sentinel'
where id = '97000000-0000-4000-8000-000000000004';

select clock_timestamp() + interval '1 hour 30.321 seconds' as resume_expiry
\gset

select public.save_whatsapp_automation_session(
  '97000000-0000-4000-8000-000000000014',
  :'newer_lease_token'::uuid,
  1,
  'collecting_patient_profile',
  '{"expectedProfileField":"coverage","serviceId":"service-1"}'::jsonb,
  :'resume_expiry'::timestamptz
) as applied
\gset lateral_first_

select public.save_whatsapp_automation_session(
  '97000000-0000-4000-8000-000000000014',
  :'newer_lease_token'::uuid,
  1,
  'collecting_patient_profile',
  '{"expectedProfileField":"coverage","serviceId":"service-1"}'::jsonb,
  :'resume_expiry'::timestamptz
) as applied
\gset lateral_retry_

select ok(
  :'lateral_first_applied'::boolean
  and :'lateral_retry_applied'::boolean
  and (
    select state = 'collecting_patient_profile'
      and context =
        '{"expectedProfileField":"coverage","serviceId":"service-1"}'::jsonb
      and expires_at = :'resume_expiry'::timestamptz
    from public.automation_sessions
    where conversation_id = '97000000-0000-4000-8000-000000000004'
  )
  and (
    select current_flow = 'side-query-sentinel'
    from public.conversations
    where id = '97000000-0000-4000-8000-000000000004'
  ),
  'restoring a lateral flow is idempotent and preserves exact expiry and current_flow'
);
select throws_ok(
  format(
    $$select public.save_whatsapp_automation_session(
      '97000000-0000-4000-8000-000000000013', %L::uuid, 1,
      'stale_state', '{"source":"stale"}'::jsonb, clock_timestamp()
    )$$,
    :'older_lease_token'
  ),
  '55000',
  'WHATSAPP_AUTOMATION_EXECUTION_LEASE_INVALID',
  'a completed older execution cannot regress the newer session'
);

select public.complete_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000014',
  :'newer_lease_token'::uuid,
  '{"processed":true}'::jsonb
);

insert into public.webhook_events (
  external_event_id, event_type, status, metadata, attempts,
  processing_started_at
) values
  (
    'wamid.automation.order.015', 'messages', 'pending', '{}'::jsonb, 1,
    clock_timestamp()
  ),
  (
    'wamid.automation.order.016', 'messages', 'pending', '{}'::jsonb, 1,
    clock_timestamp()
  );

insert into public.messages (
  id, conversation_id, contact_id, direction, whatsapp_message_id, type,
  body, status, metadata, created_at
) values
  (
    '97000000-0000-4000-8000-000000000015',
    '97000000-0000-4000-8000-000000000004',
    '97000000-0000-4000-8000-000000000003',
    'inbound', 'wamid.automation.order.015', 'text',
    'first reserved dispatch', 'read',
    '{"automation_dispatch_reserved":true}'::jsonb,
    clock_timestamp() + interval '40 seconds'
  ),
  (
    '97000000-0000-4000-8000-000000000016',
    '97000000-0000-4000-8000-000000000004',
    '97000000-0000-4000-8000-000000000003',
    'inbound', 'wamid.automation.order.016', 'text',
    'second pending dispatch', 'read',
    '{"automation_dispatch_reserved":true}'::jsonb,
    clock_timestamp() - interval '40 seconds'
  );

select public.finalize_whatsapp_inbound_webhook(
  '97000000-0000-4000-8000-000000000016',
  'wamid.automation.order.016',
  true
);

select is(
  (
    select count(*)::text
    from public.claim_whatsapp_automation_dispatches(100) dispatch
    where dispatch.message_id = '97000000-0000-4000-8000-000000000016'
  ),
  '0',
  'an earlier reserved dispatch blocks claiming a later pending dispatch'
);
select is(
  (
    select status || ':' || attempts::text
    from public.whatsapp_automation_dispatches
    where message_id = '97000000-0000-4000-8000-000000000016'
  ),
  'pending:0',
  'the blocked later dispatch does not burn an attempt or acquire a lease'
);

select public.finalize_whatsapp_inbound_webhook(
  '97000000-0000-4000-8000-000000000015',
  'wamid.automation.order.015',
  true
);
select *
from public.claim_whatsapp_automation_dispatches(100)
where message_id = '97000000-0000-4000-8000-000000000015'
\gset ordered_first_

select is(
  :'ordered_first_message_id'::text,
  '97000000-0000-4000-8000-000000000015'::text,
  'after finalization the earliest ingest sequence is claimed first'
);

select public.complete_whatsapp_automation_dispatch(
  :'ordered_first_id'::uuid,
  :'ordered_first_lease_token'::uuid
);
select *
from public.claim_whatsapp_automation_dispatches(100)
where message_id = '97000000-0000-4000-8000-000000000016'
\gset ordered_second_

select is(
  :'ordered_second_message_id'::text,
  '97000000-0000-4000-8000-000000000016'::text,
  'the later dispatch becomes claimable only after the earlier one completes'
);

select public.complete_whatsapp_automation_dispatch(
  :'ordered_second_id'::uuid,
  :'ordered_second_lease_token'::uuid
);

select ok(
  (
    select column_info.is_identity = 'NO'
      and column_info.column_default is null
      and column_info.is_nullable = 'NO'
    from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = 'messages'
      and column_info.column_name = 'whatsapp_ingest_sequence'
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_info
    where trigger_info.tgrelid = 'public.messages'::regclass
      and trigger_info.tgname = 'aa0_messages_assign_whatsapp_ingest_sequence'
      and trigger_info.tgenabled = 'O'
  )
  and (
    select position('pg_advisory_xact_lock' in definition)
      < position('nextval' in definition)
    from (
      select pg_get_functiondef(
        'public.assign_whatsapp_ingest_sequence()'::regprocedure
      ) as definition
    ) function_info
  )
  and to_regclass('public.messages_whatsapp_ingest_sequence_idx') is not null
  and has_sequence_privilege(
    'service_role',
    'public.messages_whatsapp_ingest_sequence_seq',
    'USAGE'
  )
  and not has_sequence_privilege(
    'authenticated',
    'public.messages_whatsapp_ingest_sequence_seq',
    'USAGE'
  ),
  'message sequence allocation occurs under the per-conversation transaction lock'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, created_at
) values (
  '97000000-0000-4000-8000-000000000017',
  '97000000-0000-4000-8000-000000000004',
  '97000000-0000-4000-8000-000000000003',
  'inbound', 'text', 'dispatch exhaustion retry', 'read',
  clock_timestamp() + interval '50 seconds'
);
insert into public.whatsapp_automation_dispatches (
  message_id, external_event_id, status
) values (
  '97000000-0000-4000-8000-000000000017',
  'wamid.automation.requeue.017',
  'pending'
)
returning id::text as dispatch_id
\gset dispatch_exhaust_

select *
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000017',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset dispatch_exhaust_

select public.remember_whatsapp_automation_decision(
  '97000000-0000-4000-8000-000000000017',
  :'dispatch_exhaust_lease_token'::uuid,
  0,
  'requeue_fixture',
  '{"value":"preserved"}'::jsonb
);
select public.fail_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000017',
  :'dispatch_exhaust_lease_token'::uuid,
  'retryable execution error',
  true
);

select id::text as claimed_dispatch_id, lease_token::text as dispatch_lease_token
from public.claim_whatsapp_automation_dispatches(100)
where message_id = '97000000-0000-4000-8000-000000000017'
\gset dispatch_exhaust_

select public.fail_whatsapp_automation_dispatch(
  :'dispatch_exhaust_claimed_dispatch_id'::uuid,
  :'dispatch_exhaust_dispatch_lease_token'::uuid,
  'dispatch attempts exhausted',
  false
);

select ok(
  (
    select status = 'completed'
      and outcome ->> 'reason' = 'AUTOMATION_DISPATCH_EXHAUSTED'
    from public.whatsapp_automation_executions
    where message_id = '97000000-0000-4000-8000-000000000017'
  ) and (
    select count(*) = 1
      and bool_and(result #>> '{value,value}' = 'preserved')
    from public.whatsapp_automation_effects
    where execution_message_id = '97000000-0000-4000-8000-000000000017'
  ),
  'dispatch exhaustion terminalizes the execution without losing its effect ledger'
);

select public.requeue_whatsapp_automation_dispatch(
  :'dispatch_exhaust_dispatch_id'::uuid
) as requeued
\gset dispatch_exhaust_

select ok(
  :'dispatch_exhaust_requeued'::boolean
    and (
      select status = 'pending' and attempts = 0 and failed_at is null
      from public.whatsapp_automation_dispatches
      where id = :'dispatch_exhaust_dispatch_id'::uuid
    )
    and (
      select status = 'failed'
        and retryable
        and outcome is null
        and message_snapshot ->> 'body' = 'dispatch exhaustion retry'
      from public.whatsapp_automation_executions
      where message_id = '97000000-0000-4000-8000-000000000017'
    )
    and (
      select count(*) = 1
      from public.whatsapp_automation_effects
      where execution_message_id = '97000000-0000-4000-8000-000000000017'
    ),
  'manual requeue reopens only execution lifecycle state and preserves snapshots/effects'
);

select *
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000017',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset dispatch_reclaim_

select ok(
  :'dispatch_reclaim_disposition' = 'claimed'
    and :'dispatch_reclaim_lease_token'::uuid is not null
    and :'dispatch_reclaim_message_snapshot'::jsonb ->> 'body'
      = 'dispatch exhaustion retry',
  'a requeued dispatch-exhausted execution is claimable from its frozen snapshot'
);

select public.complete_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000017',
  :'dispatch_reclaim_lease_token'::uuid,
  '{"processed":true,"requeued":true}'::jsonb
);
select id::text as id, lease_token::text as lease_token
from public.claim_whatsapp_automation_dispatches(100)
where message_id = '97000000-0000-4000-8000-000000000017'
\gset dispatch_reclaim_outbox_
select public.complete_whatsapp_automation_dispatch(
  :'dispatch_reclaim_outbox_id'::uuid,
  :'dispatch_reclaim_outbox_lease_token'::uuid
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, created_at
) values (
  '97000000-0000-4000-8000-000000000018',
  '97000000-0000-4000-8000-000000000004',
  '97000000-0000-4000-8000-000000000003',
  'inbound', 'text', 'execution exhaustion retry', 'read',
  clock_timestamp() + interval '60 seconds'
);
insert into public.whatsapp_automation_dispatches (
  message_id, external_event_id, status
) values (
  '97000000-0000-4000-8000-000000000018',
  'wamid.automation.requeue.018',
  'pending'
)
returning id::text as dispatch_id
\gset execution_exhaust_

select *
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000018',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset execution_exhaust_
select public.fail_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000018',
  :'execution_exhaust_lease_token'::uuid,
  'execution retries exhausted',
  false
);
select id::text as claimed_dispatch_id, lease_token::text as dispatch_lease_token
from public.claim_whatsapp_automation_dispatches(100)
where message_id = '97000000-0000-4000-8000-000000000018'
\gset execution_exhaust_
select public.fail_whatsapp_automation_dispatch(
  :'execution_exhaust_claimed_dispatch_id'::uuid,
  :'execution_exhaust_dispatch_lease_token'::uuid,
  'outbox observes terminal execution',
  false
);
select public.requeue_whatsapp_automation_dispatch(
  :'execution_exhaust_dispatch_id'::uuid
) as requeued
\gset execution_exhaust_
select *
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000018',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset execution_reclaim_

select ok(
  :'execution_exhaust_requeued'::boolean
    and :'execution_reclaim_disposition' = 'claimed'
    and :'execution_reclaim_lease_token'::uuid is not null,
  'an AUTOMATION_RETRIES_EXHAUSTED execution is also explicitly requeueable'
);

select public.complete_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000018',
  :'execution_reclaim_lease_token'::uuid,
  '{"processed":true,"requeued":true}'::jsonb
);
select id::text as id, lease_token::text as lease_token
from public.claim_whatsapp_automation_dispatches(100)
where message_id = '97000000-0000-4000-8000-000000000018'
\gset execution_reclaim_outbox_
select public.complete_whatsapp_automation_dispatch(
  :'execution_reclaim_outbox_id'::uuid,
  :'execution_reclaim_outbox_lease_token'::uuid
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, created_at
) values (
  '97000000-0000-4000-8000-000000000019',
  '97000000-0000-4000-8000-000000000004',
  '97000000-0000-4000-8000-000000000003',
  'inbound', 'text', 'successful execution stays terminal', 'read',
  clock_timestamp() + interval '70 seconds'
);
insert into public.whatsapp_automation_dispatches (
  message_id, external_event_id, status
) values (
  '97000000-0000-4000-8000-000000000019',
  'wamid.automation.requeue.019',
  'pending'
)
returning id::text as dispatch_id
\gset successful_
select *
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000019',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset successful_
select public.complete_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000019',
  :'successful_lease_token'::uuid,
  '{"processed":true,"state":"idle"}'::jsonb
);
select id::text as claimed_dispatch_id, lease_token::text as dispatch_lease_token
from public.claim_whatsapp_automation_dispatches(100)
where message_id = '97000000-0000-4000-8000-000000000019'
\gset successful_
select public.fail_whatsapp_automation_dispatch(
  :'successful_claimed_dispatch_id'::uuid,
  :'successful_dispatch_lease_token'::uuid,
  'response acknowledgement lost',
  false
);
select public.requeue_whatsapp_automation_dispatch(
  :'successful_dispatch_id'::uuid
) as requeued
\gset successful_

select ok(
  not :'successful_requeued'::boolean
    and (
      select status = 'completed'
        and outcome = '{"processed":true,"state":"idle"}'::jsonb
      from public.whatsapp_automation_executions
      where message_id = '97000000-0000-4000-8000-000000000019'
    )
    and (
      select status = 'failed'
      from public.whatsapp_automation_dispatches
      where id = :'successful_dispatch_id'::uuid
    ),
  'manual requeue never reopens a successfully completed execution'
);

select ok(
  (
    select bool_and(c.relrowsecurity)
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any(array[
        'whatsapp_automation_executions',
        'whatsapp_automation_effects'
      ])
  ),
  'durable automation tables have row-level security enabled'
);
select ok(
  not has_table_privilege(
    'anon', 'public.whatsapp_automation_executions', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'public.whatsapp_automation_executions', 'SELECT'
  )
  and not has_table_privilege(
    'anon', 'public.whatsapp_automation_effects', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'public.whatsapp_automation_effects', 'SELECT'
  ),
  'durable execution and effect rows are service-only'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.claim_whatsapp_automation_execution(uuid,jsonb,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.create_whatsapp_automation_appointment(uuid,uuid,uuid,uuid,uuid,timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.remember_whatsapp_automation_decision(uuid,uuid,integer,text,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.apply_whatsapp_automation_profile(uuid,uuid,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.handoff_whatsapp_automation_execution(uuid,uuid,text,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.cancel_whatsapp_automation_appointment(uuid,uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.require_whatsapp_automation_execution(uuid,uuid)',
    'EXECUTE'
  ),
  'only the public service-role RPC surface is executable'
);

select * from finish();

rollback;
