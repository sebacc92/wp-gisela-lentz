\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(52);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

insert into auth.users (id, email, encrypted_password, aud, role)
values
  (
    '95100000-0000-4000-8000-000000000001',
    'conversation-override-admin@example.test', '',
    'authenticated', 'authenticated'
  ),
  (
    '95100000-0000-4000-8000-000000000002',
    'conversation-override-operator@example.test', '',
    'authenticated', 'authenticated'
  );

update public.profiles
set role = 'ADMIN'
where id = '95100000-0000-4000-8000-000000000001';

insert into public.contacts (id, phone_e164, whatsapp_id, name)
values
  (
    '95100000-0000-4000-8000-000000000011',
    '+5491100010011', '5491100010011', 'Override Fixture A'
  ),
  (
    '95100000-0000-4000-8000-000000000012',
    '+5491100010012', '5491100010012', 'Override Fixture B'
  ),
  (
    '95100000-0000-4000-8000-000000000013',
    '+5491100010013', '5491100010013', 'Override Fixture C'
  );

insert into public.conversations (id, contact_id, automation_mode, needs_human)
values
  (
    '95100000-0000-4000-8000-000000000021',
    '95100000-0000-4000-8000-000000000011', 'auto', false
  ),
  (
    '95100000-0000-4000-8000-000000000022',
    '95100000-0000-4000-8000-000000000012', 'auto', false
  ),
  (
    '95100000-0000-4000-8000-000000000023',
    '95100000-0000-4000-8000-000000000013', 'auto', false
  );

update public.app_settings set automations_enabled = false where id;
update public.whatsapp_settings
set sending_paused = false, sending_pause_reason = null
where id;

select has_column(
  'public', 'conversations', 'automation_test_override_until',
  'conversations expose an explicit expiring test window'
);
select has_table(
  'public', 'whatsapp_automation_test_override_events',
  'override lifecycle has a dedicated compact audit ledger'
);
select ok(
  not has_column_privilege(
    'authenticated', 'public.conversations',
    'automation_test_override_until', 'UPDATE'
  ),
  'browser roles cannot mutate the override column directly'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.activate_whatsapp_conversation_test_override(uuid)',
    'EXECUTE'
  )
  and not has_table_privilege(
    'service_role',
    'public.whatsapp_automation_test_override_events',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.whatsapp_automation_test_override_events',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.whatsapp_automation_test_override_events',
    'DELETE'
  ),
  'service runtime cannot activate overrides or mutate the append-only ledger'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid =
        'public.whatsapp_automation_test_override_events'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
      and attribute.attname in ('phone', 'phone_e164', 'body', 'message_body')
  ),
  'the audit ledger stores no phone or message body'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95100000-0000-4000-8000-000000000002"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select throws_ok(
  $$select * from public.activate_whatsapp_conversation_test_override(
    '95100000-0000-4000-8000-000000000021'
  )$$,
  '42501',
  'WHATSAPP_AUTOMATION_TEST_OVERRIDE_ADMIN_REQUIRED',
  'an OPERADOR cannot activate a test override'
);
select throws_ok(
  $$insert into public.conversations (
    id, contact_id, automation_test_override_activated_at,
    automation_test_override_until, automation_test_override_activated_by
  ) values (
    '95100000-0000-4000-8000-000000000029',
    '95100000-0000-4000-8000-000000000011',
    clock_timestamp(), clock_timestamp() + interval '24 hours',
    '95100000-0000-4000-8000-000000000002'
  )$$,
  '42501',
  'WHATSAPP_AUTOMATION_TEST_OVERRIDE_RPC_REQUIRED',
  'an OPERADOR cannot bypass the RPC through the legacy conversation INSERT grant'
);
select throws_ok(
  $$update public.conversations
    set automation_test_override_until = clock_timestamp() + interval '24 hours'
    where id = '95100000-0000-4000-8000-000000000021'$$,
  '42501',
  'permission denied for table conversations',
  'an OPERADOR cannot update an override column directly'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95100000-0000-4000-8000-000000000001"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select *
from public.activate_whatsapp_conversation_test_override(
  '95100000-0000-4000-8000-000000000021'
)
\gset activated_

select ok(
  :'activated_test_override_active'::boolean
    and :'activated_effective_operational_enabled'::boolean
    and :'activated_effective_automation_enabled'::boolean
    and not :'activated_global_automations_enabled'::boolean,
  'ADMIN activation makes only this auto/open conversation operational'
);
select ok(
  :'activated_test_override_until'::timestamptz
      > clock_timestamp() + interval '23 hours 59 minutes'
    and :'activated_test_override_until'::timestamptz
      <= clock_timestamp() + interval '24 hours 1 minute',
  'activation expires 24 hours from the live database clock'
);

select *
from public.activate_whatsapp_conversation_test_override(
  '95100000-0000-4000-8000-000000000021'
)
\gset extended_

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select ok(
  :'extended_test_override_activated_at'::timestamptz
      = :'activated_test_override_activated_at'::timestamptz
    and :'extended_test_override_until'::timestamptz
      >= :'activated_test_override_until'::timestamptz,
  'extension preserves the lifecycle start and refreshes its 24-hour end'
);
select ok(
  (
    select count(*) = 2
      and bool_or(action = 'activated')
      and bool_or(action = 'extended')
      and bool_and(
        actor_user_id = '95100000-0000-4000-8000-000000000001'
      )
    from public.whatsapp_automation_test_override_events
    where conversation_id = '95100000-0000-4000-8000-000000000021'
  ),
  'activation and extension are audited with the ADMIN actor'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95100000-0000-4000-8000-000000000002"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select ok(
  (
    select test_override_active and effective_operational_enabled
    from public.get_whatsapp_conversation_automation_state(
      '95100000-0000-4000-8000-000000000021'
    )
  ),
  'an active OPERADOR may read the effective state'
);
select is(
  (
    select count(*)
    from public.whatsapp_automation_test_override_events
    where conversation_id = '95100000-0000-4000-8000-000000000021'
  ),
  0::bigint,
  'an OPERADOR cannot read the ADMIN-only audit ledger'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95100000-0000-4000-8000-000000000001"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select *
from public.deactivate_whatsapp_conversation_test_override(
  '95100000-0000-4000-8000-000000000021'
)
\gset revoked_

select ok(
  not :'revoked_test_override_active'::boolean
    and not :'revoked_effective_operational_enabled'::boolean,
  'ADMIN revocation immediately disables the conversation while global is off'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select ok(
  (
    select count(*) = 1
      and bool_and(
        actor_user_id = '95100000-0000-4000-8000-000000000001'
      )
    from public.whatsapp_automation_test_override_events
    where conversation_id = '95100000-0000-4000-8000-000000000021'
      and action = 'revoked'
  ),
  'explicit revocation is audited separately'
);
select ok(
  not public.whatsapp_conversation_automation_operationally_enabled(
    '95100000-0000-4000-8000-000000000022'
  ),
  'conversation B stays isolated while only A had an override'
);
select ok(
  (
    select test_override_active is false
      and effective_operational_enabled is false
      and effective_automation_enabled is false
    from public.get_whatsapp_conversation_automation_state(
      '95100000-0000-4000-8000-000000000022'
    )
  ),
  'no override returns explicit false booleans rather than NULL'
);

select set_config(
  'app.whatsapp_automation_test_override_write', 'on', true
);
update public.conversations
set
  automation_test_override_activated_at = clock_timestamp() - interval '25 hours',
  automation_test_override_until = clock_timestamp() - interval '1 hour',
  automation_test_override_activated_by =
    '95100000-0000-4000-8000-000000000001'
where id = '95100000-0000-4000-8000-000000000021';
select set_config(
  'app.whatsapp_automation_test_override_write', 'off', true
);

select ok(
  not public.whatsapp_conversation_automation_operationally_enabled(
    '95100000-0000-4000-8000-000000000021'
  ),
  'an expired override is inactive without a cleanup job'
);

update public.app_settings set automations_enabled = true where id;
select ok(
  public.whatsapp_conversation_automation_operationally_enabled(
    '95100000-0000-4000-8000-000000000022'
  ),
  'global ON preserves ordinary automation without an override'
);
update public.conversations
set
  automation_mode = 'manual',
  needs_human = true,
  automation_pause_source = 'system'
where id = '95100000-0000-4000-8000-000000000022';
select ok(
  (
    select effective_operational_enabled
      and not effective_automation_enabled
      and automation_mode = 'manual'
    from public.get_whatsapp_conversation_automation_state(
      '95100000-0000-4000-8000-000000000022'
    )
  ),
  'manual mode remains a safety barrier even when the operational gate is on'
);
update public.conversations
set automation_mode = 'auto', needs_human = false
where id = '95100000-0000-4000-8000-000000000022';
update public.app_settings set automations_enabled = false where id;

-- Open a fresh A window for webhook/outbox/lease race coverage.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95100000-0000-4000-8000-000000000001"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select * from public.activate_whatsapp_conversation_test_override(
  '95100000-0000-4000-8000-000000000021'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

insert into public.webhook_events (
  external_event_id, event_type, status, metadata
) values
  ('wamid.override.a.1', 'messages', 'pending', '{}'::jsonb),
  ('wamid.override.b.1', 'messages', 'pending', '{}'::jsonb),
  ('wamid.override.b.legacy', 'messages', 'pending', '{}'::jsonb);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body,
  whatsapp_message_id, metadata
) values
  (
    '95100000-0000-4000-8000-000000000031',
    '95100000-0000-4000-8000-000000000021',
    '95100000-0000-4000-8000-000000000011',
    'inbound', 'text', 'fixture a1', 'wamid.override.a.1',
    '{"automation_dispatch_reserved":true}'::jsonb
  ),
  (
    '95100000-0000-4000-8000-000000000032',
    '95100000-0000-4000-8000-000000000022',
    '95100000-0000-4000-8000-000000000012',
    'inbound', 'text', 'fixture b1', 'wamid.override.b.1',
    '{"automation_dispatch_reserved":true}'::jsonb
  ),
  (
    '95100000-0000-4000-8000-000000000036',
    '95100000-0000-4000-8000-000000000022',
    '95100000-0000-4000-8000-000000000012',
    'inbound', 'text', 'fixture b legacy', 'wamid.override.b.legacy',
    '{"automation_dispatch_reserved":true}'::jsonb
  );

select is(
  (
    public.finalize_whatsapp_inbound_webhook_with_operational_gate(
      '95100000-0000-4000-8000-000000000031',
      'wamid.override.a.1', true
    )
  ).status,
  'pending',
  'global OFF plus A override ON creates actionable work for A'
);
select ok(
  (
    select finalized.status = 'completed'
      and finalized.completion_reason = 'skipped'
    from public.finalize_whatsapp_inbound_webhook_with_operational_gate(
      '95100000-0000-4000-8000-000000000032',
      'wamid.override.b.1', true
    ) finalized
  ),
  'the same authoritative finalize skips B while global and B override are off'
);
select is(
  (
    public.finalize_whatsapp_inbound_webhook(
      '95100000-0000-4000-8000-000000000036',
      'wamid.override.b.legacy', true
    )
  ).status,
  'pending',
  'legacy v1 finalize preserves its pending return contract during DB-first rollout'
);

select *
from public.claim_whatsapp_automation_dispatches(10)
\gset dispatch_a_

select ok(
  :'dispatch_a_message_id'::uuid =
      '95100000-0000-4000-8000-000000000031'::uuid
    and :'dispatch_a_status' = 'processing',
  'outbox claim isolates the enabled conversation'
);
select ok(
  (
    select status = 'completed' and completion_reason = 'skipped'
    from public.whatsapp_automation_dispatches
    where message_id = '95100000-0000-4000-8000-000000000036'
  ),
  'authoritative claim terminalizes pending work emitted by a legacy caller'
);
select is(
  (
    select disposition
    from public.claim_whatsapp_automation_execution(
      '95100000-0000-4000-8000-000000000036',
      '{"delivery_mode":"whatsapp"}'::jsonb,
      900
    )
  ),
  'completed',
  'a direct execution claim also fails closed without creating a lease'
);

select *
from public.claim_whatsapp_automation_execution(
  '95100000-0000-4000-8000-000000000031',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset execution_a_

select is(
  :'execution_a_disposition'::text,
  'claimed'::text,
  'execution claim is allowed while the A override is live'
);
select ok(
  (
    select eligible and reason = 'ELIGIBLE'
    from public.check_whatsapp_automation_send_eligibility(
      '95100000-0000-4000-8000-000000000031',
      :'execution_a_lease_token'::uuid
    )
  ),
  'the live final gate allows the currently leased A execution'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95100000-0000-4000-8000-000000000001"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select * from public.deactivate_whatsapp_conversation_test_override(
  '95100000-0000-4000-8000-000000000021'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select is(
  (
    select reason
    from public.check_whatsapp_automation_send_eligibility(
      '95100000-0000-4000-8000-000000000031',
      :'execution_a_lease_token'::uuid
    )
  ),
  'AUTOMATIONS_DISABLED',
  'revocation blocks a worker that already owns an execution lease'
);
select throws_ok(
  format(
    $$select public.remember_whatsapp_automation_decision(
      '95100000-0000-4000-8000-000000000031', %L::uuid, 0,
      'after_revoke', '{"value":true}'::jsonb
    )$$,
    :'execution_a_lease_token'
  ),
  '55000',
  'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_OPERATIONAL',
  'revocation rolls back new durable automation effects'
);
select is(
  (select count(*) from public.claim_whatsapp_automation_dispatches(10)),
  0::bigint,
  'recovery does not steal a still-live dispatch lease'
);
select is(
  (
    select status
    from public.whatsapp_automation_dispatches
    where id = :'dispatch_a_id'::uuid
  ),
  'processing',
  'the live unauthorized lease remains owned until its send gate or expiry'
);

update public.whatsapp_automation_dispatches
set lease_expires_at = clock_timestamp() - interval '1 second'
where id = :'dispatch_a_id'::uuid;
select is(
  (select count(*) from public.claim_whatsapp_automation_dispatches(10)),
  0::bigint,
  'stale unauthorized recovery returns no resurrected work'
);
select ok(
  (
    select dispatch.status = 'completed'
      and dispatch.completion_reason = 'skipped'
    from public.whatsapp_automation_dispatches dispatch
    where dispatch.id = :'dispatch_a_id'::uuid
  ) and (
    select execution.status = 'completed'
      and execution.outcome ->> 'reason' = 'AUTOMATIONS_DISABLED'
    from public.whatsapp_automation_executions execution
    where execution.message_id =
      '95100000-0000-4000-8000-000000000031'
  ),
  'stale recovery terminalizes dispatch and execution coherently'
);

-- Expiry and the existing resume RPC use the same authoritative gate.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95100000-0000-4000-8000-000000000001"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select * from public.activate_whatsapp_conversation_test_override(
  '95100000-0000-4000-8000-000000000021'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

insert into public.webhook_events (
  external_event_id, event_type, status, metadata
) values ('wamid.override.a.2', 'messages', 'pending', '{}'::jsonb);
insert into public.messages (
  id, conversation_id, contact_id, direction, type, body,
  whatsapp_message_id, metadata
) values (
  '95100000-0000-4000-8000-000000000033',
  '95100000-0000-4000-8000-000000000021',
  '95100000-0000-4000-8000-000000000011',
  'inbound', 'text', 'fixture a2', 'wamid.override.a.2',
  '{"automation_dispatch_reserved":true}'::jsonb
);
select public.finalize_whatsapp_inbound_webhook_with_operational_gate(
  '95100000-0000-4000-8000-000000000033',
  'wamid.override.a.2', true
);
select set_config(
  'app.whatsapp_automation_test_override_write', 'on', true
);
update public.conversations
set
  automation_test_override_activated_at = clock_timestamp() - interval '25 hours',
  automation_test_override_until = clock_timestamp() - interval '1 hour',
  automation_test_override_activated_by =
    '95100000-0000-4000-8000-000000000001'
where id = '95100000-0000-4000-8000-000000000021';
select set_config(
  'app.whatsapp_automation_test_override_write', 'off', true
);
select is(
  (select count(*) from public.claim_whatsapp_automation_dispatches(10)),
  0::bigint,
  'a pending dispatch is not claimable after its override expires'
);
select ok(
  (
    select status = 'completed' and completion_reason = 'skipped'
    from public.whatsapp_automation_dispatches
    where message_id = '95100000-0000-4000-8000-000000000033'
  ),
  'expiry terminally skips pending work instead of leaving it recoverable'
);

update public.conversations
set automation_mode = 'manual', needs_human = true
where id = '95100000-0000-4000-8000-000000000021';
select is(
  public.resume_whatsapp_automation_for_last_inbound(
    '95100000-0000-4000-8000-000000000021'
  ),
  'AUTOMATIONS_DISABLED',
  'resume reports the disabled operational gate instead of a false dispatch'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95100000-0000-4000-8000-000000000001"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select * from public.activate_whatsapp_conversation_test_override(
  '95100000-0000-4000-8000-000000000021'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
update public.conversations
set automation_mode = 'manual', needs_human = true
where id = '95100000-0000-4000-8000-000000000021';
select is(
  public.resume_whatsapp_automation_for_last_inbound(
    '95100000-0000-4000-8000-000000000021'
  ),
  'DISPATCHED',
  'resume queues the last inbound when the conversation override is live'
);

-- Global ON/OFF remains normal and a later explicit operator pause wins.
update public.app_settings set automations_enabled = true where id;
insert into public.webhook_events (
  external_event_id, event_type, status, metadata
) values ('wamid.override.b.2', 'messages', 'pending', '{}'::jsonb);
insert into public.messages (
  id, conversation_id, contact_id, direction, type, body,
  whatsapp_message_id, metadata
) values (
  '95100000-0000-4000-8000-000000000034',
  '95100000-0000-4000-8000-000000000022',
  '95100000-0000-4000-8000-000000000012',
  'inbound', 'text', 'fixture b2', 'wamid.override.b.2',
  '{"automation_dispatch_reserved":true}'::jsonb
);
select is(
  (
    public.finalize_whatsapp_inbound_webhook_with_operational_gate(
      '95100000-0000-4000-8000-000000000034',
      'wamid.override.b.2', true
    )
  ).status,
  'pending',
  'global ON makes an ordinary no-override conversation actionable'
);
select *
from public.claim_whatsapp_automation_dispatches(10)
where message_id = '95100000-0000-4000-8000-000000000034'
\gset dispatch_b_
select *
from public.claim_whatsapp_automation_execution(
  '95100000-0000-4000-8000-000000000034',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset execution_b_

update public.app_settings set automations_enabled = false where id;
select is(
  (
    select reason
    from public.check_whatsapp_automation_send_eligibility(
      '95100000-0000-4000-8000-000000000034',
      :'execution_b_lease_token'::uuid
    )
  ),
  'AUTOMATIONS_DISABLED',
  'turning global back off blocks a previously leased ordinary conversation'
);
update public.app_settings set automations_enabled = true where id;
select ok(
  (
    select eligible
    from public.check_whatsapp_automation_send_eligibility(
      '95100000-0000-4000-8000-000000000034',
      :'execution_b_lease_token'::uuid
    )
  ),
  'turning global on again restores the normal live gate without duplication'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95100000-0000-4000-8000-000000000002"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
update public.conversations
set automation_mode = 'manual'
where id = '95100000-0000-4000-8000-000000000022';
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select is(
  (
    select reason
    from public.check_whatsapp_automation_send_eligibility(
      '95100000-0000-4000-8000-000000000034',
      :'execution_b_lease_token'::uuid
    )
  ),
  'AUTOMATION_PAUSED',
  'an operator pause after claim blocks the leased automation'
);

-- A causal inbound handoff is the safe exception: it may send its one handoff
-- notice while the exact same inbound owns the manual pause.
insert into public.webhook_events (
  external_event_id, event_type, status, metadata
) values ('wamid.override.c.1', 'messages', 'pending', '{}'::jsonb);
insert into public.messages (
  id, conversation_id, contact_id, direction, type, body,
  whatsapp_message_id, metadata
) values (
  '95100000-0000-4000-8000-000000000035',
  '95100000-0000-4000-8000-000000000023',
  '95100000-0000-4000-8000-000000000013',
  'inbound', 'text', 'fixture c1', 'wamid.override.c.1',
  '{"automation_dispatch_reserved":true}'::jsonb
);
select public.finalize_whatsapp_inbound_webhook_with_operational_gate(
  '95100000-0000-4000-8000-000000000035',
  'wamid.override.c.1', true
);
select *
from public.claim_whatsapp_automation_dispatches(10)
where message_id = '95100000-0000-4000-8000-000000000035'
\gset dispatch_c_
select *
from public.claim_whatsapp_automation_execution(
  '95100000-0000-4000-8000-000000000035',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset execution_c_
select ok(
  public.pause_whatsapp_automation_for_inbound_handoff(
    '95100000-0000-4000-8000-000000000035', false, 'fixture_handoff'
  ),
  'the exact inbound can own its causal handoff pause'
);
select ok(
  (
    select eligible and reason = 'ELIGIBLE'
    from public.check_whatsapp_automation_send_eligibility(
      '95100000-0000-4000-8000-000000000035',
      :'execution_c_lease_token'::uuid
    )
  ),
  'the causal handoff remains eligible despite its own manual mode'
);

-- A retry-to-pending after authorization loss terminalizes both durable rows.
update public.app_settings set automations_enabled = false where id;
select ok(
  public.fail_whatsapp_automation_execution(
    '95100000-0000-4000-8000-000000000034',
    :'execution_b_lease_token'::uuid,
    'fixture retry after disable', true
  ),
  'the execution failure is recorded before the outbox retry decision'
);
select ok(
  public.fail_whatsapp_automation_dispatch(
    :'dispatch_b_id'::uuid,
    :'dispatch_b_lease_token'::uuid,
    'fixture retry after disable', true
  ),
  'the outbox failure path accepts the owned dispatch lease'
);
select ok(
  (
    select status = 'completed' and completion_reason = 'skipped'
    from public.whatsapp_automation_dispatches
    where id = :'dispatch_b_id'::uuid
  ) and (
    select status = 'completed'
      and outcome ->> 'reason' = 'AUTOMATIONS_DISABLED'
    from public.whatsapp_automation_executions
    where message_id = '95100000-0000-4000-8000-000000000034'
  ),
  'retry-to-pending cannot leave a failed execution blocking the conversation'
);

update public.whatsapp_automation_executions
set
  status = 'completed',
  retryable = false,
  outcome = '{"processed":false,"blocked":true,"reason":"AUTOMATION_DISPATCH_EXHAUSTED"}'::jsonb,
  processing_started_at = null,
  lease_expires_at = null,
  lease_token = null,
  completed_at = clock_timestamp(),
  failed_at = null
where message_id = '95100000-0000-4000-8000-000000000035';
update public.whatsapp_automation_dispatches
set
  status = 'failed',
  processing_started_at = null,
  lease_expires_at = null,
  lease_token = null,
  failed_at = clock_timestamp(),
  completion_reason = null
where id = :'dispatch_c_id'::uuid;
select ok(
  not public.requeue_whatsapp_automation_dispatch(:'dispatch_c_id'::uuid),
  'manual requeue refuses work with no global or conversation authorization'
);
select ok(
  (
    select status = 'failed'
    from public.whatsapp_automation_dispatches
    where id = :'dispatch_c_id'::uuid
  ) and (
    select status = 'completed'
    from public.whatsapp_automation_executions
    where message_id = '95100000-0000-4000-8000-000000000035'
  ),
  'an ineligible requeue leaves its terminal execution coherent'
);

select ok(
  position(
    'automation_test_override' in
    pg_get_functiondef('public.claim_due_reminders(integer)'::regprocedure)
  ) = 0,
  'reminder claiming remains independent from conversation test overrides'
);
select ok(
  position(
    'automation_test_override' in pg_get_functiondef(
      'public.queue_tomorrow_appointment_reminders(timestamp with time zone)'::regprocedure
    )
  ) = 0,
  'override activation cannot enqueue reminder or template work'
);

select * from finish();
rollback;
