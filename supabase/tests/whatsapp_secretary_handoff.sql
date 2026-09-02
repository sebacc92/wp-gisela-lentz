\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(8);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

update public.app_settings
set automations_enabled = true
where id;

update public.whatsapp_settings
set sending_paused = false,
    sending_pause_reason = null
where id;

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '95610000-0000-4000-8000-000000000090',
  'secretary-handoff-operator@example.test', '',
  'authenticated', 'authenticated'
);

insert into public.contacts (id, phone_e164, whatsapp_id, name)
values
  (
    '95610000-0000-4000-8000-000000000001',
    '+5491100015601', '5491100015601', 'Secretary handoff fixture'
  ),
  (
    '95610000-0000-4000-8000-000000000002',
    '+5491100015602', '5491100015602', 'Secretary isolation fixture'
  );

insert into public.conversations (
  id, contact_id, automation_mode, needs_human, current_flow
)
values
  (
    '95610000-0000-4000-8000-000000000011',
    '95610000-0000-4000-8000-000000000001',
    'auto', false, 'collecting_patient_profile'
  ),
  (
    '95610000-0000-4000-8000-000000000012',
    '95610000-0000-4000-8000-000000000002',
    'auto', false, 'idle'
  );

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status
)
values (
  '95610000-0000-4000-8000-000000000021',
  '95610000-0000-4000-8000-000000000011',
  '95610000-0000-4000-8000-000000000001',
  'inbound', 'interactive', 'Hablar con la secretaria', 'delivered'
);

select *
from public.claim_whatsapp_automation_execution(
  '95610000-0000-4000-8000-000000000021',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset secretary_execution_

select public.pause_whatsapp_automation_for_inbound_handoff(
  '95610000-0000-4000-8000-000000000021',
  false,
  null
) as claimed
\gset secretary_handoff_

select ok(
  :'secretary_handoff_claimed'::boolean
    and (
      select automation_mode = 'manual'
        and needs_human
        and not priority
        and current_flow = 'collecting_patient_profile'
        and automation_pause_source = 'inbound_handoff'
        and automation_pause_message_id =
          '95610000-0000-4000-8000-000000000021'
      from public.conversations
      where id = '95610000-0000-4000-8000-000000000011'
    ),
  'secretary selection atomically creates the authoritative inbound handoff'
);

select ok(
  public.complete_whatsapp_automation_execution(
    '95610000-0000-4000-8000-000000000021',
    :'secretary_execution_lease_token'::uuid,
    '{"processed":true,"state":"human_handoff"}'::jsonb
  ),
  'the handoff owner completes without leaving a recoverable execution'
);

insert into public.webhook_events (
  external_event_id, event_type, status, metadata
)
values (
  'wamid.secretary.synthetic.next', 'messages', 'pending', '{}'::jsonb
);

insert into public.messages (
  id, conversation_id, contact_id, direction, whatsapp_message_id,
  type, body, status, metadata
)
values (
  '95610000-0000-4000-8000-000000000022',
  '95610000-0000-4000-8000-000000000011',
  '95610000-0000-4000-8000-000000000001',
  'inbound', 'wamid.secretary.synthetic.next',
  'text', '¿Me pueden ayudar?', 'delivered',
  '{"automation_dispatch_reserved":true}'::jsonb
);

select *
from public.finalize_whatsapp_inbound_webhook_with_operational_gate(
  '95610000-0000-4000-8000-000000000022',
  'wamid.secretary.synthetic.next',
  false
)
\gset next_dispatch_

select ok(
  :'next_dispatch_status' = 'completed'
    and :'next_dispatch_completion_reason' = 'skipped'
    and not exists (
      select 1
      from public.whatsapp_automation_executions
      where message_id = '95610000-0000-4000-8000-000000000022'
    )
    and (
      select unread_count = 2
      from public.conversations
      where id = '95610000-0000-4000-8000-000000000011'
    ),
  'the next patient message remains unread for inbox and creates no automation execution'
);

select public.requeue_whatsapp_automation_dispatch(
  :'next_dispatch_id'::uuid
) as requeued
\gset next_recovery_

create temporary table secretary_recovery_claims as
select * from public.claim_whatsapp_automation_dispatches(100);

select ok(
  not :'next_recovery_requeued'::boolean
    and not exists (
      select 1
      from secretary_recovery_claims
      where message_id = '95610000-0000-4000-8000-000000000022'
    )
    and (
      select status = 'completed'
        and completion_reason = 'skipped'
      from public.whatsapp_automation_dispatches
      where id = :'next_dispatch_id'::uuid
    ),
  'manual requeue and outbox recovery cannot resurrect the skipped inbound'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status,
  sent_by, idempotency_key, metadata
)
values (
  '95610000-0000-4000-8000-000000000023',
  '95610000-0000-4000-8000-000000000011',
  '95610000-0000-4000-8000-000000000001',
  'outbound', 'text', 'Respuesta sintética de la secretaria', 'pending',
  '95610000-0000-4000-8000-000000000090',
  'secretary-operator-message-1',
  '{"source":"operator"}'::jsonb
);

select ok(
  (
    select metadata ->> 'source' = 'operator'
      and metadata ->> 'policy_decision' = 'allowed'
      and (metadata ->> 'human_reply_barrier_ingest_sequence')::bigint = (
        select whatsapp_ingest_sequence
        from public.messages
        where id = '95610000-0000-4000-8000-000000000022'
      )
    from public.messages
    where id = '95610000-0000-4000-8000-000000000023'
  ),
  'an operator message remains permitted and records its causal reply barrier'
);

select ok(
  (
    select automation_mode = 'manual'
      and needs_human
      and automation_pause_source = 'inbound_handoff'
      and automation_pause_message_id =
        '95610000-0000-4000-8000-000000000021'
      and current_flow = 'collecting_patient_profile'
    from public.conversations
    where id = '95610000-0000-4000-8000-000000000011'
  ),
  'the operator reply preserves the secretary handoff instead of resuming the bot'
);

select ok(
  (
    select automation_mode = 'auto'
      and not needs_human
      and automation_pause_source is null
      and automation_pause_message_id is null
      and automation_human_barrier_ingest_sequence = 0
    from public.conversations
    where id = '95610000-0000-4000-8000-000000000012'
  ),
  'the secretary handoff is isolated from a different conversation'
);

insert into public.webhook_events (
  external_event_id, event_type, status, metadata
)
values (
  'wamid.secretary.synthetic.sibling', 'messages', 'pending', '{}'::jsonb
);

insert into public.messages (
  id, conversation_id, contact_id, direction, whatsapp_message_id,
  type, body, status, metadata
)
values (
  '95610000-0000-4000-8000-000000000024',
  '95610000-0000-4000-8000-000000000012',
  '95610000-0000-4000-8000-000000000002',
  'inbound', 'wamid.secretary.synthetic.sibling',
  'text', 'Quiero sacar un turno', 'delivered',
  '{"automation_dispatch_reserved":true}'::jsonb
);

select *
from public.finalize_whatsapp_inbound_webhook_with_operational_gate(
  '95610000-0000-4000-8000-000000000024',
  'wamid.secretary.synthetic.sibling',
  true
)
\gset sibling_dispatch_

create temporary table secretary_isolation_claims as
select * from public.claim_whatsapp_automation_dispatches(100);

select ok(
  :'sibling_dispatch_status' = 'pending'
    and exists (
      select 1
      from secretary_isolation_claims
      where message_id = '95610000-0000-4000-8000-000000000024'
        and status = 'processing'
    )
    and (
      select automation_mode = 'auto' and not needs_human
      from public.conversations
      where id = '95610000-0000-4000-8000-000000000012'
    ),
  'an unrelated automatic conversation remains claimable by the outbox'
);

select * from finish();
rollback;
