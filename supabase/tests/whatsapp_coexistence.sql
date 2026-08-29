\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(33);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select (public.upsert_whatsapp_coexistence_account(
  '123456789012345',
  '987654321098765',
  '+1 555 000 1111',
  'active',
  '{"test":true}'::jsonb
)).id::text as account_id
\gset coex_

select ok(
  (
    select waba_id = '123456789012345'
      and phone_number_id = '987654321098765'
      and coexistence_status = 'active'
    from public.whatsapp_coexistence_accounts
    where id = :'coex_account_id'::uuid
  ),
  'the coexistence account stores WABA and phone identity'
);

select
  (public.start_whatsapp_coexistence_sync_generation(
    :'coex_account_id'::uuid,
    'history'
  )).history_sync_generation_id::text as generation_id
\gset graph_failure_

select ok(
  :'graph_failure_generation_id'::uuid is not null
    and (
      select history_sync_status = 'pending'
        and history_request_id is null
      from public.whatsapp_coexistence_accounts
      where id = :'coex_account_id'::uuid
    ),
  'a sync generation is active before its Graph request returns'
);

select
  (public.fail_whatsapp_coexistence_sync_generation(
    :'coex_account_id'::uuid,
    'history',
    :'graph_failure_generation_id'::uuid,
    'GRAPH_HISTORY_REQUEST_FAILED',
    'request_failed',
    '{"stage":"graph_request"}'::jsonb
  )).history_sync_status as history_status
\gset graph_failure_

select ok(
  :'graph_failure_history_status' = 'failed'
    and (
      select history_sync_error = 'GRAPH_HISTORY_REQUEST_FAILED'
        and sync_status = 'failed'
      from public.whatsapp_coexistence_accounts
      where id = :'coex_account_id'::uuid
    )
    and (
      select count(*) = 1
        and bool_and(error = 'GRAPH_HISTORY_REQUEST_FAILED')
        and bool_and(metadata ->> 'stage' = 'graph_request')
      from public.whatsapp_coexistence_sync_generation_failures
      where account_id = :'coex_account_id'::uuid
        and sync_type = 'history'
        and sync_generation_id = :'graph_failure_generation_id'::uuid
    ),
  'a pre-webhook Graph failure is terminal and durably audited'
);

select public.refresh_whatsapp_coexistence_sync_state(
  :'coex_account_id'::uuid
);

select ok(
  (
    select history_sync_status = 'failed'
      and history_sync_error = 'GRAPH_HISTORY_REQUEST_FAILED'
    from public.whatsapp_coexistence_accounts
    where id = :'coex_account_id'::uuid
  ),
  'aggregate refresh preserves a failed generation with no event or batch'
);

select
  (public.start_whatsapp_coexistence_sync_generation(
    :'coex_account_id'::uuid,
    'history'
  )).history_sync_generation_id::text as new_generation_id
\gset graph_failure_

select ok(
  :'graph_failure_new_generation_id'::uuid
      <> :'graph_failure_generation_id'::uuid
    and (
      select history_sync_status = 'pending'
        and history_sync_error is null
      from public.whatsapp_coexistence_accounts
      where id = :'coex_account_id'::uuid
    ),
  'an explicitly failed request can be followed by a fresh generation'
);

select throws_ok(
  format(
    $$select public.fail_whatsapp_coexistence_sync_generation(
      %L::uuid, 'history', %L::uuid, 'LATE_GRAPH_FAILURE'
    )$$,
    :'coex_account_id',
    :'graph_failure_generation_id'
  ),
  '55000',
  'WHATSAPP_COEXISTENCE_SYNC_GENERATION_STALE',
  'a stale Graph callback cannot fail the replacement generation'
);

select (public.enqueue_whatsapp_coexistence_event(
  :'coex_account_id'::uuid,
  'change:history:duplicate-test',
  'history',
  '{"history":[]}'::jsonb,
  '{"fixture":"history"}'::jsonb
)).id::text as first_event_id
\gset history_

select (public.enqueue_whatsapp_coexistence_event(
  :'coex_account_id'::uuid,
  'change:history:duplicate-test',
  'history',
  '{"history":[]}'::jsonb,
  '{"fixture":"history"}'::jsonb
)).id::text as duplicate_event_id
\gset history_

select ok(
  :'history_first_event_id' = :'history_duplicate_event_id'
    and (
      select count(*) = 1
      from public.whatsapp_coexistence_events
      where external_event_id = 'change:history:duplicate-test'
    ),
  'duplicate change delivery produces one queue event'
);

select id::text as event_id, lease_token::text as lease_token
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'change:history:duplicate-test'
\gset history_

select ok(
  :'history_event_id'::uuid is not null
    and :'history_lease_token'::uuid is not null
    and (
      select status = 'processing'
      from public.whatsapp_coexistence_events
      where id = :'history_event_id'::uuid
    ),
  'queue claim owns a leased processing event'
);

select (public.upsert_whatsapp_coexistence_sync_batch(
  :'coex_account_id'::uuid,
  :'history_event_id'::uuid,
  :'history_lease_token'::uuid,
  'change:history:duplicate-test:history:1:2:50',
  'history',
  '1',
  2,
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
  :'coex_account_id'::uuid,
  :'history_event_id'::uuid,
  :'history_lease_token'::uuid,
  :'history_batch_id'::uuid,
  'history',
  'wamid.test.history.1',
  '+5491100008801',
  '5491100008801',
  null,
  'Paciente',
  'inbound',
  'text',
  'Mensaje histórico',
  'delivered',
  '2026-01-01T10:00:00Z'::timestamptz,
  null,
  '{"source":"history"}'::jsonb
)).id::text as message_id
\gset history_

select (public.upsert_whatsapp_coexistence_sync_batch(
  :'coex_account_id'::uuid,
  :'history_event_id'::uuid,
  :'history_lease_token'::uuid,
  'change:history:duplicate-test:history:1:2:50',
  'history',
  '1',
  2,
  50,
  'completed',
  1,
  1,
  0,
  null,
  '{}'::jsonb
)).id::text as completed_batch_id
\gset history_

select (public.upsert_whatsapp_coexistence_sync_batch(
  :'coex_account_id'::uuid,
  :'history_event_id'::uuid,
  :'history_lease_token'::uuid,
  'change:history:duplicate-test:history:1:2:50',
  'history',
  '1',
  2,
  25,
  'completed',
  1,
  1,
  0,
  null,
  '{}'::jsonb
)).id::text as stale_batch_id
\gset history_

select ok(
  (
    select progress = 50 and status = 'completed'
    from public.whatsapp_coexistence_sync_batches
    where id = :'history_batch_id'::uuid
  ) and (
    select history_sync_progress = 50
      and history_sync_status = 'in_progress'
    from public.whatsapp_coexistence_accounts
    where id = :'coex_account_id'::uuid
  ),
  'an out-of-order batch cannot reduce progress or complete an active event'
);

select ok(
  (
    select whatsapp_origin = 'history'
      and direction = 'inbound'
      and whatsapp_message_type = 'text'
      and body = 'Mensaje histórico'
    from public.messages
    where id = :'history_message_id'::uuid
  ),
  'history is stored with its origin, direction, type and body'
);

select ok(
  (
    select unread_count = 0
      and last_inbound_message_at is null
      and automation_mode = 'auto'
      and needs_human is false
    from public.conversations
    where contact_id = (
      select contact_id from public.messages
      where id = :'history_message_id'::uuid
    )
  ),
  'history does not create unread, customer window, handoff or automation effects'
);

select (public.ingest_whatsapp_coexistence_message(
  :'coex_account_id'::uuid,
  :'history_event_id'::uuid,
  :'history_lease_token'::uuid,
  :'history_batch_id'::uuid,
  'history',
  'wamid.test.history.1',
  '+5491100008801',
  '5491100008801',
  null,
  'Paciente',
  'inbound',
  'text',
  'Mensaje histórico',
  'delivered',
  '2026-01-01T10:00:00Z'::timestamptz,
  null,
  '{"source":"history"}'::jsonb
)).id::text as duplicate_message_id
\gset history_

select ok(
  :'history_message_id' = :'history_duplicate_message_id'
    and (
      select count(*) = 1
      from public.messages
      where whatsapp_message_id = 'wamid.test.history.1'
    )
    and (
      select unread_count = 0
      from public.conversations
      where contact_id = (
        select contact_id from public.messages
        where id = :'history_message_id'::uuid
      )
    ),
  'a duplicate history message is idempotent and remains unread-neutral'
);

select (public.upsert_whatsapp_coexistence_sync_batch(
  :'coex_account_id'::uuid,
  :'history_event_id'::uuid,
  :'history_lease_token'::uuid,
  'change:history:duplicate-test:history:2:4:100',
  'history',
  '2',
  4,
  100,
  'completed',
  0,
  0,
  0,
  null,
  '{}'::jsonb
)).id::text as final_batch_id
\gset history_

select public.complete_whatsapp_coexistence_event(
  :'history_event_id'::uuid,
  :'history_lease_token'::uuid,
  '{"operation_index":4}'::jsonb
) as completed
\gset history_

select ok(
  (
    select history_sync_status = 'completed'
      and history_sync_progress = 100
      and history_sync_completed_at is not null
    from public.whatsapp_coexistence_accounts
    where id = :'coex_account_id'::uuid
  ),
  'history becomes complete only at progress 100 and a completed event'
);

select (public.enqueue_whatsapp_coexistence_event(
  :'coex_account_id'::uuid,
  'change:history:completed-batch-retry',
  'history',
  '{"history":[]}'::jsonb,
  '{}'::jsonb
)).id::text as queued_id
\gset retry_

select id::text as event_id, lease_token::text as lease_token
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'change:history:completed-batch-retry'
\gset retry_

select (public.upsert_whatsapp_coexistence_sync_batch(
  :'coex_account_id'::uuid,
  :'retry_event_id'::uuid,
  :'retry_lease_token'::uuid,
  'change:history:completed-batch-retry:history:2:5:100',
  'history',
  '2',
  5,
  100,
  'completed',
  0,
  0,
  0,
  null,
  '{}'::jsonb
)).id::text as batch_id
\gset retry_

select public.fail_whatsapp_coexistence_event(
  :'retry_event_id'::uuid,
  :'retry_lease_token'::uuid,
  'TRANSIENT_CHECKPOINT_FAILURE',
  true,
  '{"operation_index":1}'::jsonb
) as scheduled
\gset retry_

select ok(
  :'retry_scheduled'::boolean
    and (
      select status = 'pending' and last_error = 'TRANSIENT_CHECKPOINT_FAILURE'
      from public.whatsapp_coexistence_events
      where id = :'retry_event_id'::uuid
    )
    and (
      select status = 'completed' and last_error is null
      from public.whatsapp_coexistence_sync_batches
      where id = :'retry_batch_id'::uuid
    ),
  'a transient event retry never contaminates an already-completed batch'
);

update public.whatsapp_coexistence_events
set available_at = clock_timestamp()
where id = :'retry_event_id'::uuid;

select id::text as reclaimed_event_id, lease_token::text as reclaimed_lease_token
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'change:history:completed-batch-retry'
\gset retry_

select public.complete_whatsapp_coexistence_event(
  :'retry_reclaimed_event_id'::uuid,
  :'retry_reclaimed_lease_token'::uuid,
  '{"operation_index":1,"total_operations":1}'::jsonb
) as completed
\gset retry_

select ok(
  :'retry_completed'::boolean
    and (
      select status = 'processed' and last_error is null
      from public.whatsapp_coexistence_events
      where id = :'retry_event_id'::uuid
    )
    and (
      select status = 'completed' and last_error is null
      from public.whatsapp_coexistence_sync_batches
      where id = :'retry_batch_id'::uuid
    ),
  'a successful retry finishes without leaving the generation falsely partial'
);

select (public.enqueue_whatsapp_coexistence_event(
  :'coex_account_id'::uuid,
  'change:smb_message_echoes:test',
  'smb_message_echoes',
  '{"message_echoes":[]}'::jsonb,
  '{}'::jsonb
)).id::text as queued_id
\gset echo_

select id::text as event_id, lease_token::text as lease_token
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'change:smb_message_echoes:test'
\gset echo_

select (public.ingest_whatsapp_coexistence_message(
  :'coex_account_id'::uuid,
  :'echo_event_id'::uuid,
  :'echo_lease_token'::uuid,
  null,
  'smb_message_echoes',
  'wamid.test.echo.1',
  '+5491100008801',
  null,
  null,
  null,
  'outbound',
  'text',
  'Respuesta manual',
  'sent',
  '2026-01-02T10:00:00Z'::timestamptz,
  null,
  '{"source":"smb_message_echoes"}'::jsonb
)).id::text as message_id
\gset echo_

select ok(
  (
    select whatsapp_origin = 'smb_message_echoes'
      and direction = 'outbound'
      and status = 'sent'
    from public.messages
    where id = :'echo_message_id'::uuid
  ),
  'an echo is an already-sent outbound message'
);

select ok(
  (
    select not (metadata ? 'policy_decision')
    from public.messages
    where id = :'echo_message_id'::uuid
  ),
  'an echo bypasses the policy used to authorize a new Graph send'
);

select ok(
  (
    select automation_mode = 'auto'
      and not needs_human
      and automation_pause_source is null
      and automation_pause_message_id is null
      and automation_human_barrier_ingest_sequence = (
        select max(whatsapp_ingest_sequence)
        from public.messages inbound_message
        where inbound_message.conversation_id = conversations.id
          and inbound_message.direction = 'inbound'
      )
      and last_inbound_message_at is null
    from public.conversations
    where id = (
      select conversation_id from public.messages
      where id = :'echo_message_id'::uuid
    )
  ),
  'an app echo preserves auto mode and opens neither a barrier nor a customer-service window without prior inbound'
);

select (public.ingest_whatsapp_coexistence_message(
  :'coex_account_id'::uuid,
  :'echo_event_id'::uuid,
  :'echo_lease_token'::uuid,
  null,
  'smb_message_echoes',
  'wamid.test.echo.1',
  '+5491100008801',
  null,
  null,
  null,
  'outbound',
  'text',
  'Respuesta manual',
  'sent',
  '2026-01-02T10:00:00Z'::timestamptz,
  null,
  '{"source":"smb_message_echoes"}'::jsonb
)).id::text as duplicate_message_id
\gset echo_

select ok(
  :'echo_message_id' = :'echo_duplicate_message_id'
    and (
      select count(*) = 1
      from public.messages
      where whatsapp_message_id = 'wamid.test.echo.1'
    ),
  'a duplicate echo creates no duplicate outbound row'
);

select public.complete_whatsapp_coexistence_event(
  :'echo_event_id'::uuid,
  :'echo_lease_token'::uuid,
  '{}'::jsonb
) as completed
\gset echo_

select (public.enqueue_whatsapp_coexistence_event(
  :'coex_account_id'::uuid,
  'change:smb_app_state_sync:test',
  'smb_app_state_sync',
  '{"state_sync":[]}'::jsonb,
  '{}'::jsonb
)).id::text as queued_id
\gset state_

select id::text as event_id, lease_token::text as lease_token
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'change:smb_app_state_sync:test'
\gset state_

select (public.ingest_whatsapp_coexistence_contact(
  :'coex_account_id'::uuid,
  :'state_event_id'::uuid,
  :'state_lease_token'::uuid,
  'add',
  '+5491100008801',
  null,
  'Paciente sincronizado',
  '2026-01-03T12:00:00Z'::timestamptz,
  '{}'::jsonb
)).id::text as contact_id
\gset state_

select ok(
  (
    select name = 'Paciente sincronizado'
    from public.contacts
    where id = :'state_contact_id'::uuid
  ) and (
    select app_state = 'active'
    from public.whatsapp_coexistence_contacts
    where account_id = :'coex_account_id'::uuid
      and phone_e164 = '+5491100008801'
  ),
  'state sync adds or enriches one normalized contact'
);

select (public.ingest_whatsapp_coexistence_contact(
  :'coex_account_id'::uuid,
  :'state_event_id'::uuid,
  :'state_lease_token'::uuid,
  'remove',
  '+5491100008801',
  null,
  null,
  '2026-01-03T11:00:00Z'::timestamptz,
  '{}'::jsonb
)).id::text as stale_contact_id
\gset state_

select ok(
  (
    select app_state = 'active'
      and source_timestamp = '2026-01-03T12:00:00Z'::timestamptz
    from public.whatsapp_coexistence_contacts
    where account_id = :'coex_account_id'::uuid
      and phone_e164 = '+5491100008801'
  ),
  'an older state-sync removal cannot overwrite a newer add'
);

select (public.ingest_whatsapp_coexistence_contact(
  :'coex_account_id'::uuid,
  :'state_event_id'::uuid,
  :'state_lease_token'::uuid,
  'remove',
  '+5491100008801',
  null,
  null,
  '2026-01-03T13:00:00Z'::timestamptz,
  '{}'::jsonb
)).id::text as removed_contact_id
\gset state_

select ok(
  (
    select app_state = 'removed'
    from public.whatsapp_coexistence_contacts
    where account_id = :'coex_account_id'::uuid
      and phone_e164 = '+5491100008801'
  ) and exists (
    select 1 from public.contacts where id = :'state_contact_id'::uuid
  ),
  'a newer removal marks app state without deleting the administrative contact'
);

select (public.ingest_whatsapp_coexistence_contact(
  :'coex_account_id'::uuid,
  :'state_event_id'::uuid,
  :'state_lease_token'::uuid,
  'remove',
  '+5491100008899',
  null,
  null,
  '2026-01-03T15:00:00Z'::timestamptz,
  '{}'::jsonb
)).id is null as unknown_remove_ignored
\gset state_

select (public.ingest_whatsapp_coexistence_contact(
  :'coex_account_id'::uuid,
  :'state_event_id'::uuid,
  :'state_lease_token'::uuid,
  'add',
  '+5491100008899',
  null,
  'Alta atrasada',
  '2026-01-03T14:00:00Z'::timestamptz,
  '{}'::jsonb
)).id is null as stale_unknown_add_ignored
\gset state_

select ok(
  :'state_unknown_remove_ignored'::boolean
    and :'state_stale_unknown_add_ignored'::boolean
    and (
      select app_state = 'removed'
        and contact_id is null
      from public.whatsapp_coexistence_contacts
      where account_id = :'coex_account_id'::uuid
        and phone_e164 = '+5491100008899'
    ),
  'an older add after an unknown removal is acknowledged without recreating it'
);

select (public.upsert_whatsapp_coexistence_sync_batch(
  :'coex_account_id'::uuid,
  :'state_event_id'::uuid,
  :'state_lease_token'::uuid,
  'change:smb_app_state_sync:test:app-state:event',
  'smb_app_state_sync',
  null,
  null,
  null,
  'completed',
  3,
  3,
  0,
  null,
  '{}'::jsonb
)).id::text as batch_id
\gset state_

select public.complete_whatsapp_coexistence_event(
  :'state_event_id'::uuid,
  :'state_lease_token'::uuid,
  '{}'::jsonb
) as completed
\gset state_

select ok(
  (
    select app_state_sync_status = 'partial'
      and app_state_sync_completed_at is null
    from public.whatsapp_coexistence_accounts
    where id = :'coex_account_id'::uuid
  ),
  'one state-sync delivery does not invent a global completion marker'
);

select (public.enqueue_whatsapp_coexistence_event(
  :'coex_account_id'::uuid,
  'change:history:media-followup-test',
  'history',
  '{"messages":[]}'::jsonb,
  '{}'::jsonb
)).id::text as queued_id
\gset media_

select id::text as event_id, lease_token::text as lease_token
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'change:history:media-followup-test'
\gset media_

select (public.upsert_whatsapp_coexistence_sync_batch(
  :'coex_account_id'::uuid,
  :'media_event_id'::uuid,
  :'media_lease_token'::uuid,
  'change:history:media-followup-test:history:1:1:100',
  'history',
  '1',
  1,
  100,
  'processing',
  1,
  0,
  0,
  null,
  '{}'::jsonb
)).id::text as batch_id
\gset media_

select is(
  public.ingest_whatsapp_history_media_followup(
    :'coex_account_id'::uuid,
    :'media_event_id'::uuid,
    :'media_lease_token'::uuid,
    'wamid.test.media.1',
    'image',
    'Imagen histórica',
    '{"media_id":"media.test.1","mime_type":"image/jpeg"}'::jsonb
  ),
  false,
  'a media follow-up received before its placeholder remains pending'
);

select (public.ingest_whatsapp_coexistence_message(
  :'coex_account_id'::uuid,
  :'media_event_id'::uuid,
  :'media_lease_token'::uuid,
  :'media_batch_id'::uuid,
  'history',
  'wamid.test.media.1',
  '+5491100008802',
  null,
  null,
  null,
  'outbound',
  'media_placeholder',
  'Medio pendiente de sincronización',
  'sent',
  '2026-01-04T10:00:00Z'::timestamptz,
  null,
  '{"source":"history"}'::jsonb
)).id::text as message_id
\gset media_

select (public.upsert_whatsapp_coexistence_sync_batch(
  :'coex_account_id'::uuid,
  :'media_event_id'::uuid,
  :'media_lease_token'::uuid,
  'change:history:media-followup-test:history:1:1:100',
  'history',
  '1',
  1,
  100,
  'completed',
  1,
  1,
  0,
  null,
  '{}'::jsonb
)).id::text as completed_batch_id
\gset media_

select ok(
  (
    select type = 'image'
      and whatsapp_message_type = 'image'
      and direction = 'outbound'
      and body = 'Imagen histórica'
      and metadata ->> 'media_id' = 'media.test.1'
    from public.messages
    where id = :'media_message_id'::uuid
  ) and (
    select applied_at is not null
    from public.whatsapp_coexistence_message_enrichments
    where whatsapp_message_id = 'wamid.test.media.1'
  ),
  'the placeholder is enriched by wamid without replacing direction or contact'
);

select public.complete_whatsapp_coexistence_event(
  :'media_event_id'::uuid,
  :'media_lease_token'::uuid,
  '{}'::jsonb
) as completed
\gset media_

select public.apply_whatsapp_message_status(
  'wamid.test.status.1',
  'read',
  '2026-01-05T11:00:00Z'::timestamptz,
  '{"fixture":"out_of_order"}'::jsonb
) as accepted
\gset status_

select ok(
  :'status_accepted'::boolean and exists (
    select 1
    from public.whatsapp_message_status_events
    where whatsapp_message_id = 'wamid.test.status.1'
      and applied_at is null
  ),
  'a status received before its message is accepted durably'
);

select (public.enqueue_whatsapp_coexistence_event(
  :'coex_account_id'::uuid,
  'change:history:status-target-test',
  'history',
  '{"history":[]}'::jsonb,
  '{}'::jsonb
)).id::text as queued_id
\gset status_

select id::text as event_id, lease_token::text as lease_token
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'change:history:status-target-test'
\gset status_

select (public.upsert_whatsapp_coexistence_sync_batch(
  :'coex_account_id'::uuid,
  :'status_event_id'::uuid,
  :'status_lease_token'::uuid,
  'change:history:status-target-test:history:1:1:100',
  'history',
  '1',
  1,
  100,
  'processing',
  1,
  0,
  0,
  null,
  '{}'::jsonb
)).id::text as batch_id
\gset status_

select (public.ingest_whatsapp_coexistence_message(
  :'coex_account_id'::uuid,
  :'status_event_id'::uuid,
  :'status_lease_token'::uuid,
  :'status_batch_id'::uuid,
  'history',
  'wamid.test.status.1',
  '+5491100008803',
  '5491100008803',
  null,
  null,
  'inbound',
  'text',
  'Mensaje con status adelantado',
  'delivered',
  '2026-01-05T10:00:00Z'::timestamptz,
  null,
  '{}'::jsonb
)).id::text as message_id
\gset status_

select (public.upsert_whatsapp_coexistence_sync_batch(
  :'coex_account_id'::uuid,
  :'status_event_id'::uuid,
  :'status_lease_token'::uuid,
  'change:history:status-target-test:history:1:1:100',
  'history',
  '1',
  1,
  100,
  'completed',
  1,
  1,
  0,
  null,
  '{}'::jsonb
)).id::text as completed_batch_id
\gset status_

select ok(
  (
    select status = 'read'
    from public.messages
    where id = :'status_message_id'::uuid
  ) and not exists (
    select 1
    from public.whatsapp_message_status_events
    where whatsapp_message_id = 'wamid.test.status.1'
      and applied_at is null
  ),
  'the pending status reconciles when its message arrives without downgrading'
);

select public.complete_whatsapp_coexistence_event(
  :'status_event_id'::uuid,
  :'status_lease_token'::uuid,
  '{}'::jsonb
) as completed
\gset status_

select (public.enqueue_whatsapp_coexistence_event(
  :'coex_account_id'::uuid,
  'change:messages:mutation-test',
  'messages',
  '{"messages":[]}'::jsonb,
  '{}'::jsonb
)).id::text as queued_id
\gset mutation_

select id::text as event_id, lease_token::text as lease_token
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'change:messages:mutation-test'
\gset mutation_

select (public.ingest_whatsapp_coexistence_message(
  :'coex_account_id'::uuid,
  :'mutation_event_id'::uuid,
  :'mutation_lease_token'::uuid,
  null,
  'messages',
  'wamid.test.edit.event',
  '+5491100008801',
  '5491100008801',
  null,
  null,
  'inbound',
  'edit',
  'Texto corregido',
  'delivered',
  '2026-01-06T10:01:00Z'::timestamptz,
  'wamid.test.original.1',
  '{"content_type":"text"}'::jsonb
)).id::text as edit_id
\gset mutation_

select (public.ingest_whatsapp_coexistence_message(
  :'coex_account_id'::uuid,
  :'mutation_event_id'::uuid,
  :'mutation_lease_token'::uuid,
  null,
  'messages',
  'wamid.test.revoke.event',
  '+5491100008801',
  '5491100008801',
  null,
  null,
  'inbound',
  'revoke',
  'Mensaje eliminado',
  'delivered',
  '2026-01-06T10:02:00Z'::timestamptz,
  'wamid.test.original.1',
  '{"content_type":"revoke"}'::jsonb
)).id::text as revoke_id
\gset mutation_

select public.complete_whatsapp_coexistence_event(
  :'mutation_event_id'::uuid,
  :'mutation_lease_token'::uuid,
  '{}'::jsonb
) as completed
\gset mutation_

select (public.enqueue_whatsapp_coexistence_event(
  :'coex_account_id'::uuid,
  'change:history:mutation-original-test',
  'history',
  '{"history":[]}'::jsonb,
  '{}'::jsonb
)).id::text as queued_id
\gset original_

select id::text as event_id, lease_token::text as lease_token
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'change:history:mutation-original-test'
\gset original_

select (public.upsert_whatsapp_coexistence_sync_batch(
  :'coex_account_id'::uuid,
  :'original_event_id'::uuid,
  :'original_lease_token'::uuid,
  'change:history:mutation-original-test:history:1:1:100',
  'history',
  '1',
  1,
  100,
  'processing',
  1,
  0,
  0,
  null,
  '{}'::jsonb
)).id::text as batch_id
\gset original_

select (public.ingest_whatsapp_coexistence_message(
  :'coex_account_id'::uuid,
  :'original_event_id'::uuid,
  :'original_lease_token'::uuid,
  :'original_batch_id'::uuid,
  'history',
  'wamid.test.original.1',
  '+5491100008801',
  '5491100008801',
  null,
  null,
  'inbound',
  'text',
  'Texto original',
  'delivered',
  '2026-01-06T10:00:00Z'::timestamptz,
  null,
  '{}'::jsonb
)).id::text as message_id
\gset original_

select (public.upsert_whatsapp_coexistence_sync_batch(
  :'coex_account_id'::uuid,
  :'original_event_id'::uuid,
  :'original_lease_token'::uuid,
  'change:history:mutation-original-test:history:1:1:100',
  'history',
  '1',
  1,
  100,
  'completed',
  1,
  1,
  0,
  null,
  '{}'::jsonb
)).id::text as completed_batch_id
\gset original_

select ok(
  (
    select body = 'Mensaje eliminado'
      and edited_at = '2026-01-06T10:01:00Z'::timestamptz
      and revoked_at = '2026-01-06T10:02:00Z'::timestamptz
    from public.messages
    where id = :'original_message_id'::uuid
  ),
  'edit and revoke received before the original reconcile in timestamp order'
);

select ok(
  (
    select unread_count = 0
    from public.conversations
    where id = (
      select conversation_id from public.messages
      where id = :'original_message_id'::uuid
    )
  ),
  'message mutations and their historical original do not create unread work'
);

select public.complete_whatsapp_coexistence_event(
  :'original_event_id'::uuid,
  :'original_lease_token'::uuid,
  '{}'::jsonb
) as completed
\gset original_

select (public.enqueue_whatsapp_coexistence_event(
  :'coex_account_id'::uuid,
  'change:smb_app_state_sync:yield-test',
  'smb_app_state_sync',
  '{"state_sync":[]}'::jsonb,
  '{}'::jsonb
)).id::text as queued_id
\gset yield_

select id::text as event_id, lease_token::text as lease_token
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'change:smb_app_state_sync:yield-test'
\gset yield_

select public.yield_whatsapp_coexistence_event(
  :'yield_event_id'::uuid,
  :'yield_lease_token'::uuid,
  '{"operation_index":100,"total_operations":1000}'::jsonb
) as yielded
\gset yield_

select ok(
  :'yield_yielded'::boolean and (
    select status = 'pending'
      and attempts = 0
      and cursor ->> 'operation_index' = '100'
      and lease_token is null
    from public.whatsapp_coexistence_events
    where id = :'yield_event_id'::uuid
  ),
  'a cooperative page yield saves its cursor without consuming retry budget'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'public.whatsapp_coexistence_events',
    'SELECT'
  ) and not has_table_privilege(
    'anon',
    'public.whatsapp_message_status_events',
    'SELECT'
  ) and not has_table_privilege(
    'authenticated',
    'public.whatsapp_coexistence_sync_generation_failures',
    'SELECT'
  ),
  'browser roles cannot read raw coexistence or status queues'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.ingest_whatsapp_history_media_followup(uuid,uuid,uuid,text,text,text,jsonb)',
    'EXECUTE'
  ) and not has_function_privilege(
    'anon',
    'public.reconcile_whatsapp_history_media(uuid,text)',
    'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'public.fail_whatsapp_coexistence_sync_generation(uuid,text,uuid,text,text,jsonb,timestamptz)',
    'EXECUTE'
  ),
  'browser roles cannot invoke ingestion or internal reconciliation functions'
);

select * from finish();

rollback;
