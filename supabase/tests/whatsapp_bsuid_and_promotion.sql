\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(16);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select (public.upsert_whatsapp_coexistence_account(
  '523456789012345',
  '587654321098765',
  '+1 555 000 4444',
  'active',
  '{"test":"bsuid"}'::jsonb
)).id::text as account_id
\gset bsuid_

select (public.enqueue_whatsapp_coexistence_event(
  :'bsuid_account_id'::uuid,
  'change:smb_app_state_sync:bsuid-only-contact',
  'smb_app_state_sync',
  '{"state_sync":[]}'::jsonb,
  '{}'::jsonb
)).id::text as queued_id
\gset state_

select id::text as event_id, lease_token::text as lease_token
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'change:smb_app_state_sync:bsuid-only-contact'
\gset state_

select (public.ingest_whatsapp_coexistence_contact(
  :'bsuid_account_id'::uuid,
  :'state_event_id'::uuid,
  :'state_lease_token'::uuid,
  'add',
  null,
  null,
  'user.9373795779eb6441c8adb2eaee5b848e7dd174ddd302d7db62142f4722d574b6',
  '@paciente_privado',
  '2026-08-26T12:00:00Z'::timestamptz,
  '{"username":"@paciente_privado","country_code":"AR"}'::jsonb
)).id::text as contact_id
\gset bsuid_

select ok(
  (
    select phone_e164 is null
      and whatsapp_id is null
      and whatsapp_user_id =
        'user.9373795779eb6441c8adb2eaee5b848e7dd174ddd302d7db62142f4722d574b6'
      and name = '@paciente_privado'
    from public.contacts
    where id = :'bsuid_contact_id'::uuid
  ),
  'state sync creates a real BSUID-only contact without a fabricated phone'
);

select ok(
  (
    select phone_e164 is null
      and whatsapp_user_id =
        'user.9373795779eb6441c8adb2eaee5b848e7dd174ddd302d7db62142f4722d574b6'
      and contact_id = :'bsuid_contact_id'::uuid
      and metadata ->> 'username' = '@paciente_privado'
    from public.whatsapp_coexistence_contacts
    where account_id = :'bsuid_account_id'::uuid
  ),
  'the durable Coexistence identity map stores BSUID and profile metadata'
);

select throws_ok(
  $$insert into public.contacts (whatsapp_user_id, name)
    values (
      'user.9373795779eb6441c8adb2eaee5b848e7dd174ddd302d7db62142f4722d574b6',
      'Duplicado'
    )$$,
  '23505',
  null,
  'a real BSUID cannot be assigned to two contacts'
);

insert into public.conversations (contact_id, automation_mode, needs_human)
values (:'bsuid_contact_id'::uuid, 'auto', true)
returning id::text as conversation_id
\gset bsuid_

select is(
  public.pause_whatsapp_automation_for_app_echo(
    null,
    'user.9373795779eb6441c8adb2eaee5b848e7dd174ddd302d7db62142f4722d574b6'
  ),
  1,
  'an authenticated app echo synchronously records the human-reply barrier by BSUID'
);

select ok(
  (
    select automation_mode = 'auto'
      and needs_human
      and automation_pause_source is null
      and automation_pause_message_id is null
      and automation_human_barrier_ingest_sequence = 0
    from public.conversations
    where id = :'bsuid_conversation_id'::uuid
  ),
  'the app-echo barrier preserves the exact pre-existing conversation preference'
);

select ok(
  public.pause_whatsapp_automation_for_app_echo(
      null,
      'user.9373795779eb6441c8adb2eaee5b848e7dd174ddd302d7db62142f4722d574b6'
    ) = 1
    and (
      select automation_mode = 'auto'
        and needs_human
        and automation_pause_source is null
        and automation_human_barrier_ingest_sequence = 0
      from public.conversations
      where id = :'bsuid_conversation_id'::uuid
    ),
  'replaying the app-echo barrier is state-idempotent'
);

select is(
  public.pause_whatsapp_automation_for_app_echo(
    null,
    'user.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  ),
  1,
  'an echo for an unknown BSUID creates the barrier before live ingestion'
);

select ok(
  exists (
    select 1
    from public.contacts contact
    join public.conversations conversation
      on conversation.contact_id = contact.id
    where contact.whatsapp_user_id =
        'user.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      and contact.phone_e164 is null
      and conversation.status = 'open'
      and conversation.automation_mode = 'auto'
      and not conversation.needs_human
      and conversation.automation_pause_source is null
      and conversation.automation_human_barrier_ingest_sequence = 0
  ),
  'the unknown-contact echo barrier creates a durable auto-preference conversation'
);

select (public.enqueue_whatsapp_coexistence_event(
  :'bsuid_account_id'::uuid,
  'change:history:bsuid-live-promotion',
  'history',
  '{"history":[]}'::jsonb,
  '{}'::jsonb
)).id::text as queued_id
\gset history_

select id::text as event_id, lease_token::text as lease_token
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'change:history:bsuid-live-promotion'
\gset history_

select (public.upsert_whatsapp_coexistence_sync_batch(
  :'bsuid_account_id'::uuid,
  :'history_event_id'::uuid,
  :'history_lease_token'::uuid,
  'change:history:bsuid-live-promotion:history:1:1:50',
  'history',
  '1',
  1,
  50,
  'processing',
  1,
  0,
  0,
  null,
  '{}'::jsonb
)).id::text as batch_id
\gset history_

select (public.ingest_whatsapp_coexistence_message(
  :'bsuid_account_id'::uuid,
  :'history_event_id'::uuid,
  :'history_lease_token'::uuid,
  :'history_batch_id'::uuid,
  'history',
  'wamid.test.bsuid.promotion.1',
  null,
  null,
  'user.9373795779eb6441c8adb2eaee5b848e7dd174ddd302d7db62142f4722d574b6',
  '@paciente_privado',
  'inbound',
  'text',
  'Mensaje importado',
  'delivered',
  '2026-08-26T12:01:00Z'::timestamptz,
  null,
  '{"source":"history"}'::jsonb
)).id::text as message_id
\gset history_

select ok(
  (
    select message.whatsapp_origin = 'history'
      and conversation.unread_count = 0
      and conversation.last_inbound_message_at is null
      and not exists (
        select 1
        from public.whatsapp_automation_dispatches dispatch
        where dispatch.message_id = message.id
      )
    from public.messages message
    join public.conversations conversation
      on conversation.id = message.conversation_id
    where message.id = :'history_message_id'::uuid
  ),
  'BSUID history remains side-effect free before a live observation'
);

select promoted::text as promoted
from public.promote_whatsapp_history_message_to_live(
  'wamid.test.bsuid.promotion.1',
  :'bsuid_contact_id'::uuid,
  :'bsuid_conversation_id'::uuid,
  'text',
  'Mensaje vivo',
  '2026-08-26T12:01:01Z'::timestamptz,
  '{"source":"messages"}'::jsonb
)
\gset promotion_

select ok(
  :'promotion_promoted'::boolean,
  'history-first WAMID is promoted by the first live delivery'
);

select ok(
  (
    select message.whatsapp_origin = 'cloud_api'
      and message.body = 'Mensaje vivo'
      and message.metadata ->> 'promoted_from_history' = 'true'
      and conversation.unread_count = 1
      and conversation.last_inbound_message_at =
        '2026-08-26T12:01:01Z'::timestamptz
    from public.messages message
    join public.conversations conversation
      on conversation.id = message.conversation_id
    where message.id = :'history_message_id'::uuid
  ),
  'promotion applies live origin, unread and service-window effects once'
);

select is(
  (
    select count(*)::integer
    from public.whatsapp_automation_dispatches
    where message_id = :'history_message_id'::uuid
      and external_event_id = 'wamid.test.bsuid.promotion.1'
      and status = 'reserved'
  ),
  1,
  'promotion transaction reserves exactly one automation dispatch'
);

select promoted::text as promoted
from public.promote_whatsapp_history_message_to_live(
  'wamid.test.bsuid.promotion.1',
  :'bsuid_contact_id'::uuid,
  :'bsuid_conversation_id'::uuid,
  'text',
  'Mensaje vivo',
  '2026-08-26T12:01:01Z'::timestamptz,
  '{"source":"messages"}'::jsonb
)
\gset promotion_retry_

select ok(
  not :'promotion_retry_promoted'::boolean
    and (
      select unread_count = 1
      from public.conversations
      where id = :'bsuid_conversation_id'::uuid
    )
    and (
      select count(*) = 1
      from public.whatsapp_automation_dispatches
      where message_id = :'history_message_id'::uuid
    ),
  'a live retry cannot replay promotion side effects or reservations'
);

insert into public.contacts (id, phone_e164, whatsapp_id, name)
values (
  '96000000-0000-4000-8000-000000000001',
  '+5491100009601',
  '5491100009601',
  'Status BSUID'
);
insert into public.conversations (id, contact_id)
values (
  '96000000-0000-4000-8000-000000000002',
  '96000000-0000-4000-8000-000000000001'
);

select ok(
  public.apply_whatsapp_message_status(
    'wamid.test.bsuid.status.before.message',
    'delivered',
    '2026-08-26T12:05:00Z'::timestamptz,
    '{}'::jsonb,
    'user.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  ),
  'a BSUID-bearing status is durably accepted before its message'
);

insert into public.messages (
  conversation_id,
  contact_id,
  direction,
  whatsapp_message_id,
  type,
  body,
  status,
  created_at
) values (
  '96000000-0000-4000-8000-000000000002',
  '96000000-0000-4000-8000-000000000001',
  'inbound',
  'wamid.test.bsuid.status.before.message',
  'text',
  'Status adelantado',
  'delivered',
  '2026-08-26T12:04:59Z'::timestamptz
);

select ok(
  (
    select whatsapp_user_id =
      'user.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    from public.contacts
    where id = '96000000-0000-4000-8000-000000000001'
  ),
  'message reconciliation attaches a previously queued status BSUID'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.pause_whatsapp_automation_for_app_echo(text,text)',
    'EXECUTE'
  ) and not has_function_privilege(
    'anon',
    'public.promote_whatsapp_history_message_to_live(text,uuid,uuid,public.message_type,text,timestamptz,jsonb)',
    'EXECUTE'
  ),
  'browser roles cannot pause automations or promote history rows'
);

select * from finish();

rollback;
