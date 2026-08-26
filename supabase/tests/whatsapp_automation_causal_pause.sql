\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(26);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

-- Exercise the same no-UPDATE materialization used by the migration against
-- representative legacy rows. The normal updated_at trigger is deliberately
-- attached: it would make this assertion fail if the initialization performed
-- a row UPDATE rather than a table rewrite.
create temporary table causal_pause_backfill_probe (
  id uuid primary key,
  automation_mode public.automation_mode not null,
  updated_at timestamptz not null
);

create trigger set_causal_pause_backfill_probe_updated_at
  before update on causal_pause_backfill_probe
  for each row execute function public.set_updated_at();

insert into causal_pause_backfill_probe (id, automation_mode, updated_at)
values
  (
    '95000000-0000-4000-8000-000000000091',
    'manual',
    '2025-01-02T03:04:05.123456Z'
  ),
  (
    '95000000-0000-4000-8000-000000000092',
    'auto',
    '2025-02-03T04:05:06.654321Z'
  );

alter table causal_pause_backfill_probe
  add column automation_pause_source public.automation_pause_source
    generated always as (
      case
        when automation_mode = 'manual' then
          'legacy_manual'::public.automation_pause_source
        else null::public.automation_pause_source
      end
    ) stored;

alter table causal_pause_backfill_probe
  alter column automation_pause_source drop expression;

select ok(
  (
    select updated_at = '2025-01-02T03:04:05.123456Z'::timestamptz
      and automation_pause_source = 'legacy_manual'
    from causal_pause_backfill_probe
    where id = '95000000-0000-4000-8000-000000000091'
  )
  and (
    select updated_at = '2025-02-03T04:05:06.654321Z'::timestamptz
      and automation_pause_source is null
    from causal_pause_backfill_probe
    where id = '95000000-0000-4000-8000-000000000092'
  ),
  'causal-pause materialization preserves exact legacy timestamps and state'
);

select ok(
  not exists (
    select 1
    from public.conversations
    where (
      automation_mode = 'manual'
      and automation_pause_source is null
    ) or (
      automation_mode = 'auto'
      and (
        automation_pause_source is not null
        or automation_pause_message_id is not null
      )
    )
  )
  and coalesce(
    (
      select attribute.attgenerated = ''
      from pg_catalog.pg_attribute attribute
      where attribute.attrelid = 'public.conversations'::regclass
        and attribute.attname = 'automation_pause_source'
        and not attribute.attisdropped
    ),
    false
  ),
  'legacy conversations have valid causal state and the owner remains writable'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_trigger trigger_info
    where trigger_info.tgrelid = 'public.conversations'::regclass
      and trigger_info.tgname = 'set_conversations_updated_at'
      and trigger_info.tgenabled = 'O'
      and not trigger_info.tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_publication_tables publication_table
    where publication_table.pubname = 'supabase_realtime'
      and publication_table.schemaname = 'public'
      and publication_table.tablename = 'conversations'
  ),
  'the conversations timestamp trigger and Realtime publication stay enabled'
);

insert into public.contacts (id, phone_e164, whatsapp_id, name)
values
  (
    '95000000-0000-4000-8000-000000000001',
    '+5491100009501', '5491100009501', 'App Echo Contact'
  ),
  (
    '95000000-0000-4000-8000-000000000002',
    '+5491100009502', '5491100009502', 'Owned Handoff Contact'
  ),
  (
    '95000000-0000-4000-8000-000000000003',
    '+5491100009503', '5491100009503', 'Operator Contact'
  ),
  (
    '95000000-0000-4000-8000-000000000004',
    '+5491100009504', '5491100009504', 'System Contact'
  );

insert into public.conversations (
  id, contact_id, automation_mode, needs_human
) values
  (
    '95000000-0000-4000-8000-000000000011',
    '95000000-0000-4000-8000-000000000001', 'auto', false
  ),
  (
    '95000000-0000-4000-8000-000000000012',
    '95000000-0000-4000-8000-000000000002', 'auto', false
  ),
  (
    '95000000-0000-4000-8000-000000000013',
    '95000000-0000-4000-8000-000000000003', 'auto', false
  );

insert into public.conversations (
  id, contact_id, automation_mode, needs_human
) values (
  '95000000-0000-4000-8000-000000000014',
  '95000000-0000-4000-8000-000000000004',
  'manual',
  true
)
returning automation_pause_source::text as initial_source
\gset system_

update public.conversations
set
  automation_mode = 'auto',
  automation_pause_source = 'app_echo',
  automation_pause_message_id = gen_random_uuid()
where id = '95000000-0000-4000-8000-000000000014';

select ok(
  :'system_initial_source' = 'system'
    and (
      select automation_mode = 'auto'
        and automation_pause_source is null
        and automation_pause_message_id is null
      from public.conversations
      where id = '95000000-0000-4000-8000-000000000014'
    ),
  'the conversation trigger assigns system ownership and clears markers in auto mode'
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status
) values
  (
    '95000000-0000-4000-8000-000000000021',
    '95000000-0000-4000-8000-000000000011',
    '95000000-0000-4000-8000-000000000001',
    'inbound', 'text', 'urgent app race', 'read'
  ),
  (
    '95000000-0000-4000-8000-000000000022',
    '95000000-0000-4000-8000-000000000012',
    '95000000-0000-4000-8000-000000000002',
    'inbound', 'text', 'owned urgent flow', 'read'
  ),
  (
    '95000000-0000-4000-8000-000000000024',
    '95000000-0000-4000-8000-000000000013',
    '95000000-0000-4000-8000-000000000003',
    'inbound', 'text', 'operator owned flow', 'read'
  );

select *
from public.claim_whatsapp_automation_execution(
  '95000000-0000-4000-8000-000000000021',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset app_execution_

select *
from public.claim_whatsapp_automation_execution(
  '95000000-0000-4000-8000-000000000022',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset owned_execution_

select *
from public.claim_whatsapp_automation_execution(
  '95000000-0000-4000-8000-000000000024',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset operator_execution_

select public.pause_whatsapp_automation_for_inbound_handoff(
  '95000000-0000-4000-8000-000000000021',
  true,
  'urgent_handoff'
) as claimed
\gset app_handoff_

select ok(
  :'app_handoff_claimed'::boolean and (
    select automation_mode = 'manual'
      and needs_human
      and priority
      and current_flow = 'urgent_handoff'
      and automation_pause_source = 'inbound_handoff'
      and automation_pause_message_id =
        '95000000-0000-4000-8000-000000000021'
    from public.conversations
    where id = '95000000-0000-4000-8000-000000000011'
  ),
  'an inbound handoff atomically owns an auto conversation'
);

select public.pause_whatsapp_automation_for_inbound_handoff(
  '95000000-0000-4000-8000-000000000021',
  false,
  null
) as claimed
\gset app_replay_

select ok(
  :'app_replay_claimed'::boolean and (
    select priority and current_flow = 'urgent_handoff'
      and automation_pause_message_id =
        '95000000-0000-4000-8000-000000000021'
    from public.conversations
    where id = '95000000-0000-4000-8000-000000000011'
  ),
  'same-message handoff replay is idempotent and preserves priority/flow'
);

select public.pause_whatsapp_automation_for_app_echo(
  '+5491100009501',
  null
) as affected
\gset app_echo_

select ok(
  :'app_echo_affected'::integer = 1 and (
    select automation_mode = 'manual'
      and needs_human is false
      and automation_pause_source = 'app_echo'
      and automation_pause_message_id is null
    from public.conversations
    where id = '95000000-0000-4000-8000-000000000011'
  ),
  'an app echo takes causal ownership before asynchronous ingestion'
);

select public.pause_whatsapp_automation_for_inbound_handoff(
  '95000000-0000-4000-8000-000000000021',
  true,
  'late_handoff'
) as claimed
\gset late_app_handoff_

select ok(
  not :'late_app_handoff_claimed'::boolean and (
    select automation_pause_source = 'app_echo'
      and automation_pause_message_id is null
      and needs_human is false
    from public.conversations
    where id = '95000000-0000-4000-8000-000000000011'
  ),
  'a late inbound handoff cannot overwrite app-echo ownership'
);

select throws_ok(
  format(
    $$select public.apply_whatsapp_automation_profile(
      '95000000-0000-4000-8000-000000000021', %L::uuid,
      '{"name":"MUST ROLLBACK"}'::jsonb
    )$$,
    :'app_execution_lease_token'
  ),
  '55000',
  'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL',
  'profile effects are blocked after an app echo'
);

select ok(
  (
    select name = 'App Echo Contact'
    from public.contacts
    where id = '95000000-0000-4000-8000-000000000001'
  ) and not exists (
    select 1
    from public.whatsapp_automation_effects
    where execution_message_id = '95000000-0000-4000-8000-000000000021'
  ),
  'the ledger barrier rolls the preceding profile mutation back atomically'
);

select throws_ok(
  format(
    $$select public.remember_whatsapp_automation_decision(
      '95000000-0000-4000-8000-000000000021', %L::uuid, 0,
      'blocked_decision', '{"value":true}'::jsonb
    )$$,
    :'app_execution_lease_token'
  ),
  '55000',
  'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL',
  'decision effects are blocked after an app echo'
);

select throws_ok(
  $$insert into public.whatsapp_automation_effects (
      execution_message_id, effect_key, effect_type, request, result
    ) values (
      '95000000-0000-4000-8000-000000000021',
      'blocked:appointment', 'appointment_create', '{}'::jsonb, '{}'::jsonb
    )$$,
  '55000',
  'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL',
  'appointment effects are blocked after an app echo'
);

select throws_ok(
  format(
    $$select public.save_whatsapp_automation_session(
      '95000000-0000-4000-8000-000000000021', %L::uuid, 0,
      'human_handoff', '{}'::jsonb, clock_timestamp() + interval '1 hour'
    )$$,
    :'app_execution_lease_token'
  ),
  '55000',
  'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL',
  'even session effects are blocked when the app owns the pause'
);

select public.pause_whatsapp_automation_for_inbound_handoff(
  '95000000-0000-4000-8000-000000000022',
  true,
  'urgent_handoff'
) as claimed
\gset owned_handoff_

select ok(
  :'owned_handoff_claimed'::boolean and (
    select automation_pause_source = 'inbound_handoff'
      and automation_pause_message_id =
        '95000000-0000-4000-8000-000000000022'
    from public.conversations
    where id = '95000000-0000-4000-8000-000000000012'
  ),
  'the owning inbound message records its urgent handoff marker'
);

select ok(
  public.save_whatsapp_automation_session(
    '95000000-0000-4000-8000-000000000022',
    :'owned_execution_lease_token'::uuid,
    0,
    'human_handoff',
    '{"reason":"urgent"}'::jsonb,
    clock_timestamp() + interval '30 days'
  ),
  'the owning inbound handoff may persist its session effect'
);

insert into public.whatsapp_automation_effects (
  execution_message_id, effect_key, effect_type, request, result
) values (
  '95000000-0000-4000-8000-000000000022',
  'causal:test:handoff',
  'handoff',
  '{"reason":"urgent"}'::jsonb,
  '{"state":"human_handoff"}'::jsonb
);

select ok(
  exists (
    select 1
    from public.whatsapp_automation_effects
    where execution_message_id = '95000000-0000-4000-8000-000000000022'
      and effect_key = 'causal:test:handoff'
      and effect_type = 'handoff'
  ),
  'the owning inbound handoff may persist its handoff effect'
);

select throws_ok(
  format(
    $$select public.remember_whatsapp_automation_decision(
      '95000000-0000-4000-8000-000000000022', %L::uuid, 1,
      'forbidden_after_handoff', '{"value":true}'::jsonb
    )$$,
    :'owned_execution_lease_token'
  ),
  '55000',
  'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL',
  'an owned handoff still cannot create decision/domain effects'
);

select public.complete_whatsapp_automation_execution(
  '95000000-0000-4000-8000-000000000022',
  :'owned_execution_lease_token'::uuid,
  '{"processed":true,"state":"human_handoff"}'::jsonb
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status
) values (
  '95000000-0000-4000-8000-000000000023',
  '95000000-0000-4000-8000-000000000012',
  '95000000-0000-4000-8000-000000000002',
  'inbound', 'text', 'later inbound', 'read'
);

select *
from public.claim_whatsapp_automation_execution(
  '95000000-0000-4000-8000-000000000023',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset later_execution_

select throws_ok(
  format(
    $$select public.save_whatsapp_automation_session(
      '95000000-0000-4000-8000-000000000023', %L::uuid, 0,
      'human_handoff', '{}'::jsonb, clock_timestamp() + interval '1 hour'
    )$$,
    :'later_execution_lease_token'
  ),
  '55000',
  'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL',
  'a later inbound cannot borrow the prior message session permission'
);

select throws_ok(
  $$insert into public.whatsapp_automation_effects (
      execution_message_id, effect_key, effect_type, request, result
    ) values (
      '95000000-0000-4000-8000-000000000023',
      'blocked:later:handoff', 'handoff', '{}'::jsonb, '{}'::jsonb
    )$$,
  '55000',
  'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL',
  'a later inbound cannot borrow the prior message handoff permission'
);

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
update public.conversations
set automation_mode = 'manual', needs_human = true
where id = '95000000-0000-4000-8000-000000000013';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select ok(
  (
    select automation_pause_source = 'operator'
      and automation_pause_message_id is null
    from public.conversations
    where id = '95000000-0000-4000-8000-000000000013'
  ),
  'an authenticated manual transition is causally owned by the operator'
);

select public.pause_whatsapp_automation_for_inbound_handoff(
  '95000000-0000-4000-8000-000000000024',
  true,
  'late_operator_handoff'
) as claimed
\gset late_operator_handoff_

select ok(
  not :'late_operator_handoff_claimed'::boolean and (
    select automation_pause_source = 'operator'
    from public.conversations
    where id = '95000000-0000-4000-8000-000000000013'
  ),
  'an inbound handoff cannot overwrite operator ownership'
);

select throws_ok(
  format(
    $$select public.remember_whatsapp_automation_decision(
      '95000000-0000-4000-8000-000000000024', %L::uuid, 0,
      'operator_block', '{"value":true}'::jsonb
    )$$,
    :'operator_execution_lease_token'
  ),
  '55000',
  'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL',
  'operator ownership blocks every automation effect'
);

select (public.upsert_whatsapp_coexistence_account(
  '623456789012345',
  '687654321098765',
  '+54 9 11 0000 9599',
  'active',
  '{"test":"causal-echo"}'::jsonb
)).id::text as account_id
\gset echo_

select (public.enqueue_whatsapp_coexistence_event(
  :'echo_account_id'::uuid,
  'change:smb_message_echoes:causal-pause',
  'smb_message_echoes',
  '{"message_echoes":[]}'::jsonb,
  '{}'::jsonb
)).id::text as queued_id
\gset echo_

select id::text as event_id, lease_token::text as lease_token
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'change:smb_message_echoes:causal-pause'
\gset echo_

select (public.ingest_whatsapp_coexistence_message(
  :'echo_account_id'::uuid,
  :'echo_event_id'::uuid,
  :'echo_lease_token'::uuid,
  null,
  'smb_message_echoes',
  'wamid.test.causal.echo.1',
  '+5491100009599',
  '5491100009599',
  null,
  'Echo Contact',
  'outbound',
  'text',
  'Manual app reply',
  'sent',
  '2026-08-26T15:00:00Z'::timestamptz,
  null,
  '{"source":"smb_message_echoes"}'::jsonb
)).id::text as message_id
\gset echo_

select id::text as conversation_id
from public.conversations
where contact_id = (
  select contact_id
  from public.messages
  where id = :'echo_message_id'::uuid
)
\gset echo_

select ok(
  (
    select automation_mode = 'manual'
      and needs_human is false
      and automation_pause_source = 'app_echo'
      and automation_pause_message_id is null
    from public.conversations
    where id = :'echo_conversation_id'::uuid
  ),
  'a newly ingested smb_message_echo marks app-echo ownership'
);

update public.conversations
set automation_mode = 'auto', needs_human = false
where id = :'echo_conversation_id'::uuid;
update public.messages
set metadata = metadata || '{"late_status_metadata":true}'::jsonb
where id = :'echo_message_id'::uuid;

select ok(
  (
    select automation_mode = 'auto'
      and automation_pause_source is null
      and automation_pause_message_id is null
    from public.conversations
    where id = :'echo_conversation_id'::uuid
  ),
  'late metadata/status enrichment of an old echo does not pause a reactivated conversation'
);

select public.pause_whatsapp_automation_for_app_echo(
  '+5491100009599',
  null
);
select (public.ingest_whatsapp_coexistence_message(
  :'echo_account_id'::uuid,
  :'echo_event_id'::uuid,
  :'echo_lease_token'::uuid,
  null,
  'smb_message_echoes',
  'wamid.test.causal.echo.1',
  '+5491100009599',
  '5491100009599',
  null,
  'Echo Contact',
  'outbound',
  'text',
  'Manual app reply',
  'sent',
  '2026-08-26T15:00:00Z'::timestamptz,
  null,
  '{"source":"smb_message_echoes"}'::jsonb
)).id::text as duplicate_message_id
\gset echo_

select ok(
  :'echo_duplicate_message_id' = :'echo_message_id'
    and (
      select automation_mode = 'manual'
        and automation_pause_source = 'app_echo'
        and automation_pause_message_id is null
      from public.conversations
      where id = :'echo_conversation_id'::uuid
    )
    and (
      select count(*) = 1
      from public.messages
      where whatsapp_message_id = 'wamid.test.causal.echo.1'
    ),
  'the synchronous pre-pass keeps a duplicate echo causally owned and idempotent'
);

select ok(
  not has_column_privilege(
    'authenticated',
    'public.conversations',
    'automation_pause_source',
    'UPDATE'
  )
  and not has_column_privilege(
    'authenticated',
    'public.conversations',
    'automation_pause_message_id',
    'UPDATE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.pause_whatsapp_automation_for_inbound_handoff(uuid,boolean,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.pause_whatsapp_automation_for_inbound_handoff(uuid,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.guard_whatsapp_automation_effect_manual_pause()',
    'EXECUTE'
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_info
    where trigger_info.tgrelid = 'public.whatsapp_automation_effects'::regclass
      and trigger_info.tgname = 'a_whatsapp_automation_effects_manual_pause'
      and trigger_info.tgenabled = 'O'
  )
  and position(
    'for update' in lower(pg_get_functiondef(
      'public.guard_whatsapp_automation_effect_manual_pause()'::regprocedure
    ))
  ) > 0,
  'causal pause columns remain non-writable and the service-only locked barrier is installed'
);

select * from finish();

rollback;
