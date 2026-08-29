\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select vault.create_secret(
  'opaque-partial-contacts-token',
  'whatsapp_business_access_token_98000000-0000-4000-8000-000000000001',
  'pgTAP partial contacts token'
)::text as secret_id
\gset partial_

select vault.create_secret(
  'opaque-blocked-contacts-token',
  'whatsapp_business_access_token_98000000-0000-4000-8000-000000000002',
  'pgTAP blocked contacts token'
)::text as secret_id
\gset blocked_

insert into public.whatsapp_coexistence_accounts (
  id, client_scope, waba_id, phone_number_id, display_phone,
  coexistence_status, sync_status, app_state_sync_status,
  app_state_sync_generation_id, app_state_sync_requested_at,
  app_state_sync_error, app_state_sync_token_generation,
  history_sync_status, history_sync_generation_id,
  history_request_id, history_requested_at, history_sync_token_generation,
  business_portfolio_id, business_token_secret_id,
  business_token_generation, business_token_status,
  business_token_is_valid, business_token_app_id,
  business_token_last_validated_at, business_token_validation_due_at,
  business_token_validation_status, attention_required,
  onboarding_status, onboarding_completed_at, initial_sync_deadline_at,
  history_sharing_decision, app_subscription_status, app_subscribed_at,
  onboarding_last_error_code
) values
  (
    '98000000-0000-4000-8000-000000000001', 'partial-contacts',
    '980000000000001', '980000000000011', '+54 9 11 0000 0011',
    'onboarding', 'failed', 'failed',
    '98000000-0000-4000-8000-000000000101', clock_timestamp(),
    'APP_DATA_SYNC_REJECTED', 2,
    'pending', '98000000-0000-4000-8000-000000000121',
    'history-request-prior', clock_timestamp() - interval '10 minutes', 2,
    '980000000000099', :'partial_secret_id'::uuid,
    2, 'active', true, '980000000000088',
    transaction_timestamp() - interval '1 minute',
    transaction_timestamp() + interval '1 day',
    'valid', false,
    'failed', transaction_timestamp() - interval '1 hour',
    transaction_timestamp() + interval '23 hours',
    'accepted', 'subscribed', clock_timestamp(),
    'APP_DATA_SYNC_REJECTED'
  ),
  (
    '98000000-0000-4000-8000-000000000002', 'blocked-contacts',
    '980000000000002', '980000000000012', '+54 9 11 0000 0012',
    'onboarding', 'failed', 'failed',
    '98000000-0000-4000-8000-000000000102', clock_timestamp(),
    'CONTACTS_SCOPE_DENIED', 1,
    'idle', '98000000-0000-4000-8000-000000000122',
    null, null, null,
    '980000000000099', :'blocked_secret_id'::uuid,
    1, 'active', true, '980000000000088',
    transaction_timestamp() - interval '1 minute',
    transaction_timestamp() + interval '1 day',
    'valid', false,
    'failed', transaction_timestamp() - interval '1 hour',
    transaction_timestamp() + interval '23 hours',
    'declined', 'subscribed', clock_timestamp(),
    'CONTACTS_SCOPE_DENIED'
  );

insert into public.whatsapp_onboarding_outbox (
  account_id, token_generation, operation, idempotency_key,
  status, attempts, max_attempts, first_attempted_at, deadline_at,
  sync_generation_id, completion_reason, last_error_code,
  completed_at, failed_at
) values
  (
    '98000000-0000-4000-8000-000000000001', 2, 'subscribe_app',
    'partial-contacts:2:subscribe', 'succeeded', 1, 8,
    clock_timestamp() - interval '5 minutes',
    clock_timestamp() + interval '1 hour', null,
    'remote_confirmed', null, clock_timestamp() - interval '4 minutes', null
  ),
  (
    '98000000-0000-4000-8000-000000000001', 2,
    'request_contacts_sync', 'partial-contacts:2:contacts',
    'failed', 8, 8, clock_timestamp() - interval '4 minutes',
    clock_timestamp() + interval '1 hour',
    '98000000-0000-4000-8000-000000000101',
    null, 'APP_DATA_SYNC_REJECTED', null, clock_timestamp()
  ),
  (
    '98000000-0000-4000-8000-000000000002', 1, 'subscribe_app',
    'blocked-contacts:1:subscribe', 'succeeded', 1, 8,
    clock_timestamp() - interval '5 minutes',
    clock_timestamp() + interval '1 hour', null,
    'remote_confirmed', null, clock_timestamp() - interval '4 minutes', null
  ),
  (
    '98000000-0000-4000-8000-000000000002', 1,
    'request_contacts_sync', 'blocked-contacts:1:contacts',
    'failed', 8, 8, clock_timestamp() - interval '4 minutes',
    clock_timestamp() + interval '1 hour',
    '98000000-0000-4000-8000-000000000102',
    null, 'CONTACTS_SCOPE_DENIED', null, clock_timestamp()
  );

insert into public.whatsapp_onboarding_outbox (
  id, account_id, token_generation, operation, idempotency_key,
  status, attempts, max_attempts, first_attempted_at, deadline_at,
  sync_generation_id, remote_request_id, completion_reason,
  completed_at, reused_from_job_id, source_remote_request_id
) values
  (
    '98000000-0000-4000-8000-000000000201',
    '98000000-0000-4000-8000-000000000001', 1,
    'request_history_sync', 'partial-contacts:1:history-source',
    'succeeded', 1, 8, clock_timestamp() - interval '10 minutes',
    clock_timestamp() + interval '1 hour',
    '98000000-0000-4000-8000-000000000111',
    'history-request-prior', 'remote_confirmed',
    clock_timestamp() - interval '9 minutes', null, null
  ),
  (
    '98000000-0000-4000-8000-000000000202',
    '98000000-0000-4000-8000-000000000001', 2,
    'request_history_sync', 'partial-contacts:2:history-carry',
    'succeeded', 0, 8, null,
    clock_timestamp() + interval '1 hour',
    '98000000-0000-4000-8000-000000000121',
    null, 'prior_remote_request', clock_timestamp(),
    '98000000-0000-4000-8000-000000000201',
    'history-request-prior'
  );

update public.whatsapp_coexistence_accounts
set history_reonboard_state = 'prior_remote_request_reused',
    history_reonboard_source_job_id =
      '98000000-0000-4000-8000-000000000201',
    history_reonboard_recorded_at = clock_timestamp()
where id = '98000000-0000-4000-8000-000000000001';

insert into public.whatsapp_coexistence_sync_generation_failures (
  account_id, sync_type, sync_generation_id,
  failure_kind, error, failed_at
) values
  (
    '98000000-0000-4000-8000-000000000001',
    'smb_app_state_sync',
    '98000000-0000-4000-8000-000000000101',
    'request_failed', 'APP_DATA_SYNC_REJECTED', clock_timestamp()
  ),
  (
    '98000000-0000-4000-8000-000000000002',
    'smb_app_state_sync',
    '98000000-0000-4000-8000-000000000102',
    'request_failed', 'CONTACTS_SCOPE_DENIED', clock_timestamp()
  );

update public.whatsapp_settings
set integration_status = 'incomplete',
    sending_paused = true,
    sending_pause_reason = 'COEXISTENCE_ONBOARDING'
where id = true;

select is(
  public.recompute_whatsapp_embedded_signup_onboarding(
    '98000000-0000-4000-8000-000000000001', 2
  ),
  true,
  'an exhausted APP_DATA_SYNC_REJECTED contacts job no longer disables a verified subscription'
);

select ok(
  (
    select onboarding_status = 'completed'
      and coexistence_status = 'active'
      and app_subscription_status = 'subscribed'
      and business_token_status = 'active'
      and business_token_is_valid
      and app_state_sync_status = 'failed'
      and app_state_sync_error = 'APP_DATA_SYNC_REJECTED'
      and sync_status = 'failed'
      and onboarding_last_error_code = 'APP_DATA_SYNC_REJECTED'
      and history_sync_status = 'pending'
      and history_reonboard_state = 'prior_remote_request_reused'
    from public.whatsapp_coexistence_accounts
    where id = '98000000-0000-4000-8000-000000000001'
  ),
  'connection becomes operational without misreporting the contacts import'
);

select ok(
  (
    select count(*) = 3
      and count(*) filter (
        where operation = 'request_history_sync'
          and status = 'succeeded'
          and attempts = 0
          and completion_reason = 'prior_remote_request'
      ) = 1
    from public.whatsapp_onboarding_outbox
    where account_id = '98000000-0000-4000-8000-000000000001'
      and token_generation = 2
  ),
  'recovery preserves the pending carried history request without creating or retrying another job'
);

select is(
  public.resolve_whatsapp_coexistence_webhook_account(
    '980000000000001', '980000000000011'
  ),
  '98000000-0000-4000-8000-000000000001'::uuid,
  'live webhooks resolve after partial contacts recovery'
);

select id::text as event_id
from public.enqueue_whatsapp_coexistence_event(
  '98000000-0000-4000-8000-000000000001',
  'history-partial-recovery-001', 'history', '{}'::jsonb,
  jsonb_build_object('entry_time', clock_timestamp())
)
\gset late_history_

select ok(
  :'late_history_event_id'::uuid is not null
    and (
      select history_sync_status = 'pending'
      from public.whatsapp_coexistence_accounts
      where id = '98000000-0000-4000-8000-000000000001'
    )
    and (
      select count(*) = 3
      from public.whatsapp_onboarding_outbox
      where account_id = '98000000-0000-4000-8000-000000000001'
        and token_generation = 2
    ),
  'a late authorized history webhook can enter Messages processing without issuing another history request'
);

select ok(
  (
    select integration_status = 'connected'
      and sending_paused
      and sending_pause_reason = 'COEXISTENCE_ONBOARDING'
    from public.whatsapp_settings
    where id = true
  ),
  'partial contacts recovery keeps all outbound sending paused'
);

select throws_ok(
  $$select * from public.resolve_whatsapp_account_credentials(
    'send', '98000000-0000-4000-8000-000000000001',
    null, null, null, 2
  )$$,
  '55000',
  'WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_BLOCKED',
  'no send credential is released while global sending remains paused'
);

select is(
  public.recompute_whatsapp_embedded_signup_onboarding(
    '98000000-0000-4000-8000-000000000002', 1
  ),
  false,
  'an unrelated terminal contacts error remains fail-closed'
);

select ok(
  (
    select onboarding_status = 'failed'
      and coexistence_status = 'onboarding'
      and onboarding_last_error_code = 'CONTACTS_SCOPE_DENIED'
    from public.whatsapp_coexistence_accounts
    where id = '98000000-0000-4000-8000-000000000002'
  )
    and public.resolve_whatsapp_coexistence_webhook_account(
      '980000000000002', '980000000000012'
    ) is null,
  'the narrow exception cannot activate a different failure'
);

select is(
  (
    select count(*)::integer
    from public.audit_logs
    where entity_id = '98000000-0000-4000-8000-000000000001'
      and action =
        'whatsapp.onboarding.connected_with_contacts_sync_failure'
      and metadata @> '{"contacts_status":"failed","outbound_sending_paused":true}'::jsonb
      and metadata::text not like '%opaque-partial-contacts-token%'
  ),
  1,
  'partial recovery is audited once without credential material'
);

select is(
  public.recompute_whatsapp_embedded_signup_onboarding(
    '98000000-0000-4000-8000-000000000001', 2
  ),
  true,
  'recovery is idempotent'
);

update public.whatsapp_settings
set sending_paused = false,
    sending_pause_reason = null
where id = true;

select is(
  public.recompute_whatsapp_embedded_signup_onboarding(
    '98000000-0000-4000-8000-000000000001', 2
  ),
  true,
  'an idempotent successful reconciliation accepts an explicit sending resume'
);

select ok(
  (
    select integration_status = 'connected'
      and not sending_paused
      and sending_pause_reason is null
    from public.whatsapp_settings
    where id = true
  ),
  'successful recovery preserves an explicit sending resume'
);

update public.whatsapp_settings
set sending_paused = true,
    sending_pause_reason = 'TEST_CIRCUIT_BREAKER'
where id = true;

select is(
  public.recompute_whatsapp_embedded_signup_onboarding(
    '98000000-0000-4000-8000-000000000001', 2
  ),
  true,
  'successful reconciliation remains idempotent under an independent pause'
);

select ok(
  (
    select sending_paused
      and sending_pause_reason = 'TEST_CIRCUIT_BREAKER'
    from public.whatsapp_settings
    where id = true
  ),
  'successful recovery preserves an independent circuit-breaker pause'
);

select is(
  (
    select count(*)::integer
    from public.audit_logs
    where entity_id = '98000000-0000-4000-8000-000000000001'
      and action =
        'whatsapp.onboarding.connected_with_contacts_sync_failure'
  ),
  1,
  'idempotent recompute does not duplicate the audit event'
);

select * from finish();
rollback;
