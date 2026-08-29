\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '98100000-0000-4000-8000-000000000005',
  'explicit-pause-operator@example.test', '',
  'authenticated', 'authenticated'
);

insert into public.whatsapp_coexistence_accounts (
  id, client_scope, waba_id, phone_number_id,
  coexistence_status, onboarding_status
) values (
  '98100000-0000-4000-8000-000000000001',
  'explicit-pause-test', '981000000000001', '981000000000011',
  'onboarding', 'failed'
);

insert into public.contacts (
  id, phone_e164, whatsapp_id, whatsapp_user_id, name
) values (
  '98100000-0000-4000-8000-000000000002',
  '+5491100000011', '5491100000011', 'AR.syntheticrecipient981',
  'Explicit pause fixture'
);

insert into public.conversations (
  id, contact_id, status, automation_mode, needs_human,
  coexistence_account_id
) values (
  '98100000-0000-4000-8000-000000000003',
  '98100000-0000-4000-8000-000000000002',
  'open', 'auto', false,
  '98100000-0000-4000-8000-000000000001'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.mark_whatsapp_automation_human_reply(uuid,uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'public.mark_whatsapp_automation_human_reply(uuid,uuid)',
      'EXECUTE'
    ),
  'only the service role can record the human-reply barrier'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.resolve_whatsapp_coexistence_recipient(uuid,uuid,uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'public.resolve_whatsapp_coexistence_recipient(uuid,uuid,uuid)',
      'EXECUTE'
    ),
  'only the service role can resolve an account-scoped recipient'
);

select is(
  public.pause_whatsapp_automation_for_app_echo(
    '98100000-0000-4000-8000-000000000001',
    '+5491100000011', null
  ),
  0,
  'an app echo with no earlier inbound has no automation work to suppress'
);

select ok(
  (
    select automation_mode = 'auto'
      and not needs_human
      and automation_pause_source is null
      and automation_pause_message_id is null
      and automation_human_barrier_ingest_sequence = 0
    from public.conversations
    where id = '98100000-0000-4000-8000-000000000003'
  ),
  'a phone-app echo preserves automatic mode'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, metadata
) values (
  '98100000-0000-4000-8000-000000000004',
  '98100000-0000-4000-8000-000000000003',
  '98100000-0000-4000-8000-000000000002',
  'inbound', 'text', 'Necesito un turno', 'delivered',
  '{"whatsapp_user_id":"AR.syntheticrecipient981"}'::jsonb
);

select is(
  public.pause_whatsapp_automation_for_app_echo(
    '98100000-0000-4000-8000-000000000001',
    '+5491100000011', null
  ),
  1,
  'a phone-app echo advances the causal barrier after an inbound'
);

select throws_ok(
  $$
    update public.conversations
    set automation_human_barrier_ingest_sequence = 0
    where id = '98100000-0000-4000-8000-000000000003'
  $$,
  '42501',
  'WHATSAPP_HUMAN_REPLY_BARRIER_RPC_REQUIRED',
  'even service-role code cannot bypass the barrier RPC directly'
);

select is(
  public.mark_whatsapp_automation_human_reply(
    '98100000-0000-4000-8000-000000000003',
    '98100000-0000-4000-8000-000000000002'
  ),
  (
    select whatsapp_ingest_sequence
    from public.messages
    where id = '98100000-0000-4000-8000-000000000004'
  ),
  'a web operator reply is idempotent with the existing causal barrier'
);

select ok(
  (
    select conversation.automation_mode = 'auto'
      and not conversation.needs_human
      and conversation.automation_pause_source is null
      and conversation.automation_human_barrier_ingest_sequence =
        message.whatsapp_ingest_sequence
    from public.conversations conversation
    join public.messages message
      on message.id = '98100000-0000-4000-8000-000000000004'
    where conversation.id = '98100000-0000-4000-8000-000000000003'
  ),
  'the human reply suppresses only the already-existing inbound message'
);

select results_eq(
  $$
    select recipient_value, identity_kind, identity_provenance
    from public.resolve_whatsapp_coexistence_recipient(
      '98100000-0000-4000-8000-000000000001',
      '98100000-0000-4000-8000-000000000003',
      '98100000-0000-4000-8000-000000000002'
    )
  $$,
  $$ values (
    '5491100000011'::text,
    'wa_id'::text,
    'recent_inbound'::text
  ) $$,
  'a recent live inbound resolves the protected wa_id in its account scope'
);

select is(
  (
    select disposition
    from public.claim_whatsapp_automation_execution(
      '98100000-0000-4000-8000-000000000004',
      '{"delivery_mode":"test"}'::jsonb,
      900
    )
  ),
  'claimed',
  'the older inbound can be claimed before a durable effect is attempted'
);

select throws_ok(
  $$
    select public.remember_whatsapp_automation_decision(
      '98100000-0000-4000-8000-000000000004',
      (
        select lease_token
        from public.whatsapp_automation_executions
        where message_id = '98100000-0000-4000-8000-000000000004'
      ),
      0,
      'human-reply-race',
      '{"value":true}'::jsonb
    )
  $$,
  '55000',
  'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_HUMAN_REPLY',
  'the causal barrier rolls back a stale automation effect'
);

update public.conversations
set automation_mode = 'manual',
    needs_human = false,
    automation_pause_source = 'operator',
    automation_pause_message_id = null
where id = '98100000-0000-4000-8000-000000000003';

select ok(
  (
    select automation_mode = 'auto'
      and not needs_human
      and automation_pause_source is null
    from public.conversations
    where id = '98100000-0000-4000-8000-000000000003'
  ),
  'a service-side operator send cannot infer a manual pause'
);

-- Exercise the legacy after-message trigger from an automatic conversation.
-- The shared sender records the causal barrier separately; inserting the
-- durable operator message itself must not change the preferred mode.
select set_config('app.whatsapp_policy_seed_bypass', 'on', true);
insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, sent_by,
  idempotency_key, metadata
) values (
  '98100000-0000-4000-8000-000000000007',
  '98100000-0000-4000-8000-000000000003',
  '98100000-0000-4000-8000-000000000002',
  'outbound', 'text', 'Respuesta web sin pausa', 'sent',
  '98100000-0000-4000-8000-000000000005',
  'explicit-pause-auto-operator-message',
  '{"source":"operator"}'::jsonb
);
select set_config('app.whatsapp_policy_seed_bypass', 'off', true);

select ok(
  (
    select automation_mode = 'auto'
      and not needs_human
      and automation_pause_source is null
      and automation_human_barrier_ingest_sequence =
        (
          select whatsapp_ingest_sequence
          from public.messages
          where id = '98100000-0000-4000-8000-000000000004'
        )
    from public.conversations
    where id = '98100000-0000-4000-8000-000000000003'
  ),
  'inserting an operator reply preserves automatic mode and its causal barrier'
);

select ok(
  (
    select (metadata ->> 'human_reply_barrier_ingest_sequence')::bigint =
      (
        select whatsapp_ingest_sequence
        from public.messages
        where id = '98100000-0000-4000-8000-000000000004'
      )
    from public.messages
    where id = '98100000-0000-4000-8000-000000000007'
  ),
  'the first operator reservation snapshots its causal barrier atomically'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status
) values (
  '98100000-0000-4000-8000-000000000008',
  '98100000-0000-4000-8000-000000000003',
  '98100000-0000-4000-8000-000000000002',
  'inbound', 'text', 'Mensaje posterior', 'delivered'
);

select set_config('app.whatsapp_policy_seed_bypass', 'on', true);
update public.messages
set status = 'failed'
where id = '98100000-0000-4000-8000-000000000007';
update public.messages
set status = 'pending'
where id = '98100000-0000-4000-8000-000000000007';
select set_config('app.whatsapp_policy_seed_bypass', 'off', true);

select ok(
  (
    select conversation.automation_human_barrier_ingest_sequence =
      original.whatsapp_ingest_sequence
      and conversation.automation_human_barrier_ingest_sequence <
        later.whatsapp_ingest_sequence
    from public.conversations conversation
    join public.messages original
      on original.id = '98100000-0000-4000-8000-000000000004'
    join public.messages later
      on later.id = '98100000-0000-4000-8000-000000000008'
    where conversation.id = '98100000-0000-4000-8000-000000000003'
  ),
  'a failed reservation retry does not claim a later inbound as another reply'
);

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

update public.conversations
set automation_mode = 'manual', needs_human = false
where id = '98100000-0000-4000-8000-000000000003';

select ok(
  (
    select automation_mode = 'manual'
      and not needs_human
      and automation_pause_source = 'operator'
      and automation_pause_message_id is null
    from public.conversations
    where id = '98100000-0000-4000-8000-000000000003'
  ),
  'the authenticated pause button remains authoritative'
);

update public.conversations
set automation_mode = 'auto', needs_human = false
where id = '98100000-0000-4000-8000-000000000003';

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

update public.conversations
set automation_mode = 'manual',
    needs_human = true,
    automation_pause_source = 'inbound_handoff',
    automation_pause_message_id =
      '98100000-0000-4000-8000-000000000004'
where id = '98100000-0000-4000-8000-000000000003';

select ok(
  (
    select automation_mode = 'manual'
      and needs_human
      and automation_pause_source = 'inbound_handoff'
      and automation_pause_message_id =
        '98100000-0000-4000-8000-000000000004'
    from public.conversations
    where id = '98100000-0000-4000-8000-000000000003'
  ),
  'an explicit safety handoff remains fail-closed'
);

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

update public.conversations
set unread_count = unread_count + 1
where id = '98100000-0000-4000-8000-000000000003';

select ok(
  (
    select automation_mode = 'manual'
      and needs_human
      and automation_pause_source = 'inbound_handoff'
      and automation_pause_message_id =
        '98100000-0000-4000-8000-000000000004'
    from public.conversations
    where id = '98100000-0000-4000-8000-000000000003'
  ),
  'an unrelated authenticated edit cannot rewrite a safety handoff as operator'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

-- The historical sent_by trigger tries to clear needs_human after an operator
-- message. Exercise the real trigger, not a synthetic conversation update.
select set_config('app.whatsapp_policy_seed_bypass', 'on', true);
insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status, sent_by,
  idempotency_key, metadata
) values (
  '98100000-0000-4000-8000-000000000006',
  '98100000-0000-4000-8000-000000000003',
  '98100000-0000-4000-8000-000000000002',
  'outbound', 'text', 'Te respondo personalmente', 'sent',
  '98100000-0000-4000-8000-000000000005',
  'explicit-pause-operator-message',
  '{"source":"operator"}'::jsonb
);
select set_config('app.whatsapp_policy_seed_bypass', 'off', true);

select ok(
  (
    select automation_mode = 'manual'
      and needs_human
      and automation_pause_source = 'inbound_handoff'
      and automation_pause_message_id =
        '98100000-0000-4000-8000-000000000004'
    from public.conversations
    where id = '98100000-0000-4000-8000-000000000003'
  ),
  'an operator reply cannot erase an existing safety handoff'
);

select * from finish();
rollback;
