\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select ok(
  to_regclass('public.whatsapp_embedded_signup_attempts') is not null
    and to_regclass('public.whatsapp_onboarding_outbox') is not null,
  'Embedded Signup attempt and durable outbox tables exist'
);

select ok(
  (
    select bool_and(c.relrowsecurity)
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'whatsapp_embedded_signup_attempts', 'whatsapp_onboarding_outbox',
        'whatsapp_business_token_validations',
        'whatsapp_business_token_validation_jobs'
      )
  ),
  'RLS is enabled on all Embedded Signup and token lifecycle relations'
);

select ok(
  not has_table_privilege(
    'anon', 'public.whatsapp_embedded_signup_attempts', 'SELECT'
  )
    and not has_table_privilege(
      'authenticated', 'public.whatsapp_embedded_signup_attempts', 'SELECT'
    )
    and not has_table_privilege(
      'service_role', 'public.whatsapp_embedded_signup_attempts', 'SELECT'
    )
    and not has_table_privilege(
      'anon', 'public.whatsapp_onboarding_outbox', 'SELECT'
    )
    and not has_table_privilege(
      'authenticated', 'public.whatsapp_onboarding_outbox', 'SELECT'
    )
    and not has_table_privilege(
      'service_role', 'public.whatsapp_business_token_validations', 'SELECT'
    )
    and not has_table_privilege(
      'authenticated',
      'public.whatsapp_business_token_validation_jobs', 'SELECT'
    ),
  'browser and direct service clients cannot read internal ledgers'
);

select ok(
  not has_table_privilege('anon', 'vault.secrets', 'SELECT')
    and not has_table_privilege('authenticated', 'vault.secrets', 'SELECT')
    and not has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT')
    and not has_table_privilege(
      'authenticated', 'vault.decrypted_secrets', 'SELECT'
    ),
  'browser roles cannot read Vault ciphertext or plaintext views'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.create_whatsapp_embedded_signup_attempt(uuid,text,text,text,text,text,text,timestamptz,integer)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'public.whatsapp_embedded_signup_rate_limit_eligible(uuid,text,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.claim_whatsapp_embedded_signup_validations(integer,uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.finalize_whatsapp_coexistence_local_offboarding(uuid,uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.create_whatsapp_embedded_signup_attempt(uuid,text,text,text,text,text,text,timestamptz,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.create_whatsapp_embedded_signup_attempt(uuid,text,text,text,text,text,text,timestamptz,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.whatsapp_embedded_signup_rate_limit_eligible(uuid,text,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.whatsapp_embedded_signup_rate_limit_eligible(uuid,text,integer)',
      'EXECUTE'
    )
    and to_regprocedure(
      'public.create_whatsapp_embedded_signup_attempt(uuid,text,text,text,text,text,text,timestamptz)'
    ) is null
    and not has_function_privilege(
      'anon',
      'public.claim_whatsapp_embedded_signup_validations(integer,uuid)',
      'EXECUTE'
    ),
  'public workflow RPCs are executable only through the service role'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.recompute_whatsapp_embedded_signup_onboarding(uuid,bigint)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'service_role',
      'public.close_whatsapp_coexistence_onboarding_syncs(uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.expire_whatsapp_embedded_signup_attempts()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.is_valid_whatsapp_embedded_signup_asset_ids(jsonb)',
      'EXECUTE'
    ),
  'internal state-transition helpers are not directly callable'
);

select ok(
  to_regprocedure(
    'public.record_whatsapp_embedded_signup_session(uuid,uuid,text,text,text,timestamptz,text,text,text,jsonb,text)'
  ) is not null
    and to_regprocedure(
      'public.complete_whatsapp_embedded_signup(uuid,uuid,text,text,text,text,boolean,text,text[],jsonb,text[],timestamptz,timestamptz,timestamptz,uuid)'
    ) is not null
    and to_regprocedure(
      'public.record_whatsapp_embedded_signup_pre_completion_validation(uuid,uuid,boolean,text,text[],jsonb,text[],timestamptz,timestamptz,timestamptz,text)'
    ) is not null
    and to_regprocedure(
      'public.resolve_whatsapp_account_credentials(text,uuid,text,text,uuid,bigint)'
    ) is not null
    and to_regprocedure(
      'public.apply_whatsapp_coexistence_account_update(text,text,timestamptz,text,text,text)'
    ) is not null,
  'callback, completion and WABA lifecycle RPC signatures are exact'
);

select is(
  (
    select count(*)::integer
    from information_schema.columns
    where table_schema = 'public'
      and table_name in (
        'whatsapp_embedded_signup_attempts',
        'whatsapp_coexistence_accounts'
      )
      and column_name in (
        'access_token', 'business_access_token', 'authorization_code'
      )
  ),
  0,
  'no public table has a plaintext code or access-token column'
);

select ok(
  public.is_valid_whatsapp_embedded_signup_asset_ids(
    '{"ad_account_ids":["12345"],"page_ids":[],"dataset_ids":["23456"],"catalog_ids":[],"instagram_account_ids":[],"waba_ids":["34567"]}'::jsonb
  )
    and not public.is_valid_whatsapp_embedded_signup_asset_ids(
      '{"unknown_ids":["12345"]}'::jsonb
    )
    and not public.is_valid_whatsapp_embedded_signup_asset_ids(
      '{"page_ids":["not-an-id"]}'::jsonb
    ),
  'asset manifest accepts only bounded allowlisted numeric ID arrays'
);

select ok(
  public.is_valid_whatsapp_embedded_signup_asset_ids(
    jsonb_build_object(
      'page_ids', (
        select jsonb_agg((10000 + value)::text order by value)
        from generate_series(1, 100) value
      )
    )
  )
    and not public.is_valid_whatsapp_embedded_signup_asset_ids(
      jsonb_build_object(
        'page_ids', (
          select jsonb_agg((20000 + value)::text order by value)
          from generate_series(1, 60) value
        ),
        'waba_ids', (
          select jsonb_agg((30000 + value)::text order by value)
          from generate_series(1, 41) value
        )
      )
    ),
  'asset manifest permits 100 total IDs and rejects 101 across all lists'
);

select ok(
  (select count(*) = 0 from public.whatsapp_embedded_signup_attempts)
    and (select count(*) = 0 from public.whatsapp_onboarding_outbox)
    and (
      select count(*) = 0 from vault.secrets
      where name like 'whatsapp_embedded_signup_token_%'
        or name like 'whatsapp_business_access_token_%'
    ),
  'migration is inert and creates no onboarding rows or Vault credentials'
);

insert into auth.users (id, email, encrypted_password, aud, role)
values
  ('97000000-0000-4000-8000-000000000001', 'embedded-admin@example.test', '', 'authenticated', 'authenticated'),
  ('97000000-0000-4000-8000-000000000002', 'embedded-operator@example.test', '', 'authenticated', 'authenticated'),
  ('97000000-0000-4000-8000-000000000003', 'embedded-admin-2@example.test', '', 'authenticated', 'authenticated'),
  ('97000000-0000-4000-8000-000000000004', 'embedded-admin-3@example.test', '', 'authenticated', 'authenticated'),
  ('97000000-0000-4000-8000-000000000005', 'embedded-admin-4@example.test', '', 'authenticated', 'authenticated'),
  ('97000000-0000-4000-8000-000000000006', 'embedded-admin-5@example.test', '', 'authenticated', 'authenticated'),
  ('97000000-0000-4000-8000-000000000007', 'embedded-admin-6@example.test', '', 'authenticated', 'authenticated'),
  ('97000000-0000-4000-8000-000000000008', 'embedded-admin-7@example.test', '', 'authenticated', 'authenticated'),
  ('97000000-0000-4000-8000-000000000009', 'embedded-admin-8@example.test', '', 'authenticated', 'authenticated'),
  ('97000000-0000-4000-8000-000000000010', 'embedded-admin-9@example.test', '', 'authenticated', 'authenticated'),
  ('97000000-0000-4000-8000-000000000011', 'embedded-admin-10@example.test', '', 'authenticated', 'authenticated'),
  ('97000000-0000-4000-8000-000000000012', 'embedded-admin-11@example.test', '', 'authenticated', 'authenticated'),
  ('97000000-0000-4000-8000-000000000013', 'embedded-admin-12@example.test', '', 'authenticated', 'authenticated'),
  ('97000000-0000-4000-8000-000000000014', 'embedded-admin-13@example.test', '', 'authenticated', 'authenticated'),
  ('97000000-0000-4000-8000-000000000015', 'embedded-admin-14@example.test', '', 'authenticated', 'authenticated');

update public.profiles
set role = 'ADMIN'
where id in (
  '97000000-0000-4000-8000-000000000001',
  '97000000-0000-4000-8000-000000000003',
  '97000000-0000-4000-8000-000000000004',
  '97000000-0000-4000-8000-000000000005',
  '97000000-0000-4000-8000-000000000006',
  '97000000-0000-4000-8000-000000000007',
  '97000000-0000-4000-8000-000000000008',
  '97000000-0000-4000-8000-000000000009',
  '97000000-0000-4000-8000-000000000010',
  '97000000-0000-4000-8000-000000000011',
  '97000000-0000-4000-8000-000000000012',
  '97000000-0000-4000-8000-000000000013',
  '97000000-0000-4000-8000-000000000014',
  '97000000-0000-4000-8000-000000000015'
);

select throws_ok(
  $$select * from public.create_whatsapp_embedded_signup_attempt(
    '97000000-0000-4000-8000-000000000002', 'operator-scope',
    repeat('1', 64), repeat('2', 64), '123456789012345',
    '234567890123456', 'accepted', clock_timestamp() + interval '10 minutes'
  )$$,
  '42501',
  'WHATSAPP_EMBEDDED_SIGNUP_ADMIN_REQUIRED',
  'an active non-admin cannot start Embedded Signup'
);

select throws_ok(
  $$select * from public.create_whatsapp_embedded_signup_attempt(
    '97000000-0000-4000-8000-000000000001', 'primary-scope',
    repeat('1', 64), repeat('2', 64), '123456789012345',
    '234567890123456', 'accepted', clock_timestamp() + interval '31 minutes'
  )$$,
  '22023',
  'WHATSAPP_EMBEDDED_SIGNUP_ATTEMPT_INVALID',
  'START rejects a transaction TTL greater than thirty minutes'
);

select (public.upsert_whatsapp_coexistence_account(
  '745678901234567', '845678901234567', null, 'active',
  '{"legacy_fixture":true}'::jsonb
)).id::text as account_id
\gset legacy_
update public.whatsapp_coexistence_accounts
set client_scope = 'legacy-scope'
where id = :'legacy_account_id'::uuid;

select is(
  public.whatsapp_embedded_signup_status(
    '97000000-0000-4000-8000-000000000001', 'legacy-scope'
  ) -> 'account',
  'null'::jsonb,
  'Embedded status does not expose a legacy env-managed account'
);

update public.whatsapp_settings
set sending_paused = false,
    sending_pause_reason = null
where id = true;

insert into public.contacts (id, phone_e164, whatsapp_id, name)
values (
  '97000000-0000-4000-8000-000000000090', '+5491100000090',
  '5491100000090', 'Legacy routing fixture'
);
insert into public.conversations (id, contact_id)
values (
  '97000000-0000-4000-8000-000000000091',
  '97000000-0000-4000-8000-000000000090'
);
select is(
  (
    select credential_mode
    from public.resolve_whatsapp_account_credentials(
      'media', null, null, null,
      '97000000-0000-4000-8000-000000000091', null
    )
  ),
  'legacy',
  'unbound legacy conversation resolves only while Embedded manages nothing'
);

select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000001', 'legacy-scope',
  repeat('0', 64), repeat('1', 64), '123456789012345',
  '234567890123456', 'declined', clock_timestamp() + interval '10 minutes'
)
\gset legacy_attempt_
select ok(
  (
    select sending_paused
      and sending_pause_reason = 'COEXISTENCE_ONBOARDING'
    from public.whatsapp_settings
    where id = true
  )
    and (
      select metadata @> '{"sending_paused":true,"sending_pause_reason":"COEXISTENCE_ONBOARDING"}'::jsonb
      from public.audit_logs
      where action = 'whatsapp.embedded_signup.started'
        and entity_id = :'legacy_attempt_attempt_id'::uuid
    ),
  'START atomically enables the fail-closed send pause and audits it'
);
select throws_ok(
  $$select * from public.resolve_whatsapp_account_credentials(
    'media', null, null, null,
    '97000000-0000-4000-8000-000000000091', null
  )$$,
  '55000',
  'WHATSAPP_LEGACY_CREDENTIALS_DISABLED',
  'active Embedded attempt disables legacy even for an unbound conversation'
);
select ok(
  public.cancel_whatsapp_embedded_signup_attempt(
    :'legacy_attempt_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000001', 'USER_CANCELLED'
  ),
  'legacy active account without Embedded state does not block START'
);

select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000005', 'expired-before-code',
  repeat('6', 64), repeat('7', 64), '123456789012345',
  '234567890123456', 'declined', clock_timestamp() + interval '10 minutes'
)
\gset expired_code_
update public.whatsapp_embedded_signup_attempts
set created_at = clock_timestamp() - interval '20 minutes',
    expires_at = clock_timestamp() - interval '1 second'
where id = :'expired_code_attempt_id'::uuid;
select is(
  (
    select count(*)::integer
    from public.claim_whatsapp_embedded_signup_code(
      :'expired_code_attempt_id'::uuid,
      '97000000-0000-4000-8000-000000000005',
      repeat('6', 64), repeat('7', 64), repeat('8', 64)
    )
  ),
  0,
  'expired attempt cannot claim an authorization code'
);
select is(
  (select status from public.whatsapp_embedded_signup_attempts
    where id = :'expired_code_attempt_id'::uuid),
  'expired',
  'expired code claim closes the attempt terminally'
);

select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000006', 'expired-before-finish',
  repeat('7', 64), repeat('8', 64), '123456789012345',
  '234567890123456', 'declined', clock_timestamp() + interval '10 minutes'
)
\gset expired_finish_
update public.whatsapp_embedded_signup_attempts
set created_at = clock_timestamp() - interval '20 minutes',
    expires_at = clock_timestamp() - interval '1 second'
where id = :'expired_finish_attempt_id'::uuid;
select is(
  public.record_whatsapp_embedded_signup_session(
    :'expired_finish_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000006',
    repeat('7', 64), repeat('8', 64), repeat('9', 64),
    clock_timestamp(), null, '645678901234567', null, '{}'::jsonb,
    'declined'
  ),
  false,
  'FINISH received after the transaction expiry is rejected in every state'
);

select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000001', 'primary-scope',
  repeat('a', 64), repeat('b', 64), '123456789012345',
  '234567890123456', 'accepted', clock_timestamp() + interval '10 minutes'
)
\gset primary_

select ok(
  :'primary_attempt_id'::uuid is not null
    and :'primary_status' = 'initiated'
    and (
      select history_sharing_decision = 'accepted'
        and expires_at > created_at + interval '9 minutes'
        and expires_at <= created_at + interval '30 minutes'
      from public.whatsapp_embedded_signup_attempts
      where id = :'primary_attempt_id'::uuid
    ),
  'ADMIN START stores immutable consent and a bounded transaction TTL'
);

select throws_ok(
  format(
    $$select * from public.create_whatsapp_embedded_signup_attempt(
      '97000000-0000-4000-8000-000000000001', 'primary-scope',
      %L, %L, '123456789012345', '234567890123456', 'accepted',
      clock_timestamp() + interval '10 minutes')$$,
    repeat('c', 64), repeat('d', 64)
  ),
  '55000',
  'WHATSAPP_EMBEDDED_SIGNUP_ATTEMPT_ACTIVE',
  'one client scope cannot have two active attempts'
);

select clock_timestamp()::text as received_at
\gset primary_callback_

select throws_ok(
  format(
    $$select public.record_whatsapp_embedded_signup_session(
      %L::uuid, '97000000-0000-4000-8000-000000000001', %L, %L, %L,
      %L::timestamptz, null, '345678901234567', null, '{}'::jsonb,
      'accepted')$$,
    :'primary_attempt_id', repeat('0', 64), repeat('b', 64), repeat('e', 64),
    :'primary_callback_received_at'
  ),
  '42501',
  'WHATSAPP_EMBEDDED_SIGNUP_STATE_INVALID',
  'FINISH rejects a mismatched state hash'
);

select throws_ok(
  format(
    $$select public.record_whatsapp_embedded_signup_session(
      %L::uuid, '97000000-0000-4000-8000-000000000001', %L, %L, %L,
      %L::timestamptz, null, '345678901234567', null, '{}'::jsonb,
      'accepted')$$,
    :'primary_attempt_id', repeat('a', 64), repeat('0', 64), repeat('e', 64),
    :'primary_callback_received_at'
  ),
  '42501',
  'WHATSAPP_EMBEDDED_SIGNUP_STATE_INVALID',
  'FINISH rejects a mismatched nonce hash'
);

select throws_ok(
  format(
    $$select public.record_whatsapp_embedded_signup_session(
      %L::uuid, '97000000-0000-4000-8000-000000000001', %L, %L, %L,
      %L::timestamptz, null, '345678901234567', null,
      '{"page_ids":["invalid"]}'::jsonb, 'accepted')$$,
    :'primary_attempt_id', repeat('a', 64), repeat('b', 64), repeat('e', 64),
    :'primary_callback_received_at'
  ),
  '22023',
  'WHATSAPP_EMBEDDED_SIGNUP_SESSION_INVALID',
  'FINISH rejects a non-allowlisted asset ID manifest'
);

select ok(
  public.record_whatsapp_embedded_signup_session(
    :'primary_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000001',
    repeat('a', 64), repeat('b', 64), repeat('e', 64),
    :'primary_callback_received_at'::timestamptz,
    null, '345678901234567', null,
    '{"ad_account_ids":["456789012345678"],"page_ids":["567890123456789"],"dataset_ids":[],"catalog_ids":[],"instagram_account_ids":[],"waba_ids":["345678901234567"]}'::jsonb,
    'accepted'
  ),
  'FINISH accepts the official WABA-only minimum and sanitized asset IDs'
);

select ok(
  (
    select callback_received_at = :'primary_callback_received_at'::timestamptz
      and submitted_business_portfolio_id is null
      and submitted_phone_number_id is null
      and submitted_asset_ids -> 'page_ids' = '["567890123456789"]'::jsonb
    from public.whatsapp_embedded_signup_attempts
    where id = :'primary_attempt_id'::uuid
  ),
  'the exact server receipt time and full allowlisted asset manifest persist'
);

select throws_ok(
  format(
    $$select public.record_whatsapp_embedded_signup_session(
      %L::uuid, '97000000-0000-4000-8000-000000000001', %L, %L, %L,
      %L::timestamptz, null, '345678901234567', null, '{}'::jsonb,
      'declined')$$,
    :'primary_attempt_id', repeat('a', 64), repeat('b', 64), repeat('e', 64),
    :'primary_callback_received_at'
  ),
  '42501',
  'WHATSAPP_EMBEDDED_SIGNUP_STATE_INVALID',
  'FINISH cannot escalate or change the START history decision'
);

select ok(
  public.record_whatsapp_embedded_signup_session(
    :'primary_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000001',
    repeat('a', 64), repeat('b', 64), repeat('e', 64),
    :'primary_callback_received_at'::timestamptz,
    null, '345678901234567', null,
    '{"ad_account_ids":["456789012345678"],"page_ids":["567890123456789"],"dataset_ids":[],"catalog_ids":[],"instagram_account_ids":[],"waba_ids":["345678901234567"]}'::jsonb,
    'accepted'
  ),
  'an exact FINISH replay is idempotent'
);

select * from public.claim_whatsapp_embedded_signup_code(
  :'primary_attempt_id'::uuid,
  '97000000-0000-4000-8000-000000000001',
  repeat('a', 64), repeat('b', 64), repeat('f', 64)
)
\gset primary_exchange_

select ok(
  :'primary_exchange_attempt_id'::uuid = :'primary_attempt_id'::uuid
    and :'primary_exchange_waba_id' = '345678901234567'
    and :'primary_exchange_history_sharing_decision' = 'accepted'
    and :'primary_exchange_exchange_deadline_at'::timestamptz
      <= clock_timestamp() + interval '25 seconds',
  'authorization code is claimed once with a separate 25-second exchange window'
);

select throws_ok(
  format(
    $$select * from public.claim_whatsapp_embedded_signup_code(
      %L::uuid, '97000000-0000-4000-8000-000000000001', %L, %L, %L)$$,
    :'primary_attempt_id', repeat('a', 64), repeat('b', 64), repeat('f', 64)
  ),
  '55000',
  'WHATSAPP_EMBEDDED_SIGNUP_CODE_REPLAY',
  'authorization-code replay is rejected'
);

update public.whatsapp_embedded_signup_attempts
set exchange_deadline_at = clock_timestamp() - interval '30 seconds'
where id = :'primary_attempt_id'::uuid;

select ok(
  public.store_whatsapp_embedded_signup_exchange_token(
    :'primary_attempt_id'::uuid, repeat('f', 64), 'opaque-primary-token'
  ),
  'a successful Graph exchange is stored even if its response crosses the claim deadline'
);

select is(
  (
    select count(*)::integer
    from public.claim_whatsapp_embedded_signup_validations(
      1, :'primary_attempt_id'::uuid
    )
  ),
  0,
  'pre-completion validation cannot run before a real post-exchange checkpoint'
);
select (clock_timestamp() - interval '1 second')::text as validated_at
\gset primary_post_exchange_
select ok(
  public.record_whatsapp_embedded_signup_post_exchange_validation(
    :'primary_attempt_id'::uuid, true, '123456789012345',
    array['whatsapp_business_management','whatsapp_business_messaging'],
    '[{"scope":"whatsapp_business_management","target_ids":["345678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["345678901234567"]}]'::jsonb,
    array['345678901234567'], null, null,
    :'primary_post_exchange_validated_at'::timestamptz
  ),
  'first debug_token result is persisted as an attempt-scoped post-exchange checkpoint'
);

select throws_ok(
  format(
    'select * from public.get_whatsapp_embedded_signup_validation_context(%L::uuid)',
    :'primary_attempt_id'
  ),
  '55000',
  'WHATSAPP_EMBEDDED_SIGNUP_VALIDATION_NOT_READY',
  'validation context cannot bypass the durable validation lease'
);

select * from public.claim_whatsapp_embedded_signup_validations(
  1, :'primary_attempt_id'::uuid
)
\gset primary_validation_

select ok(
  :'primary_validation_attempt_id'::uuid = :'primary_attempt_id'::uuid
    and :'primary_validation_business_access_token' = 'opaque-primary-token'
    and :'primary_validation_validation_attempts'::integer = 1
    and (
      select validation_lease_expires_at - validation_processing_started_at
        >= interval '2 minutes 59 seconds'
      from public.whatsapp_embedded_signup_attempts
      where id = :'primary_attempt_id'::uuid
    ),
  'targeted validation claim leases the Vault token for the bounded worst case'
);

select is(
  (
    select count(*)::integer
    from public.claim_whatsapp_embedded_signup_validations(
      1, :'primary_attempt_id'::uuid
    )
  ),
  0,
  'a validation lease prevents concurrent Graph validation'
);

select is(
  public.fail_whatsapp_embedded_signup_validation(
    :'primary_attempt_id'::uuid,
    :'primary_validation_validation_lease_token'::uuid,
    'GRAPH_RATE_LIMITED', true
  ),
  'retrying',
  'retryable Graph validation failure schedules bounded backoff'
);

select ok(
  (
    select status = 'validating'
      and validation_lease_token is null
      and validation_available_at > clock_timestamp()
      and temporary_token_secret_id is not null
    from public.whatsapp_embedded_signup_attempts
    where id = :'primary_attempt_id'::uuid
  ),
  'retry keeps the temporary Vault token and releases its lease'
);

update public.whatsapp_embedded_signup_attempts
set validation_available_at = clock_timestamp()
where id = :'primary_attempt_id'::uuid;

select * from public.claim_whatsapp_embedded_signup_validations(
  1, :'primary_attempt_id'::uuid
)
\gset primary_validation_retry_

select is(
  :'primary_validation_retry_validation_attempts'::integer,
  2,
  'validation retry increments the durable attempt counter'
);

select (clock_timestamp() + interval '2 hours')::text
  as data_access_expires_at,
  clock_timestamp()::text as validated_at
\gset primary_pre_completion_
select ok(
  public.record_whatsapp_embedded_signup_pre_completion_validation(
    :'primary_attempt_id'::uuid,
    :'primary_validation_retry_validation_lease_token'::uuid,
    true, '123456789012345',
    array['whatsapp_business_management','whatsapp_business_messaging'],
    '[{"scope":"whatsapp_business_management","target_ids":["345678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["345678901234567"]}]'::jsonb,
    array['345678901234567'], null,
    :'primary_pre_completion_data_access_expires_at'::timestamptz,
    :'primary_pre_completion_validated_at'::timestamptz
  ),
  'second real debug_token result is persisted before asset lookups and completion'
);
select ok(
  exists (
    select 1 from public.whatsapp_business_token_validations
    where onboarding_attempt_id = :'primary_attempt_id'::uuid
      and account_id is null and token_generation is null
      and validation_reason = 'pre_completion'
      and checkpoint_attempt = 2
      and is_valid and authorization_valid
  ),
  'pre-completion raw metadata exists in the attempt-scoped ledger before account creation'
);

select throws_ok(
  format(
    $$select * from public.complete_whatsapp_embedded_signup(
      %L::uuid, '97000000-0000-4000-8000-000000000001',
      '678901234567890', '999999999999999', '789012345678901',
      '+54 9 11 5555 0000', true, '123456789012345',
      array['whatsapp_business_management','whatsapp_business_messaging'],
      '[{"scope":"whatsapp_business_management","target_ids":["345678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["345678901234567"]}]'::jsonb,
      array['345678901234567'], null, %L::timestamptz,
      %L::timestamptz, %L::uuid)$$,
    :'primary_attempt_id', :'primary_pre_completion_data_access_expires_at',
    :'primary_pre_completion_validated_at',
    :'primary_validation_retry_validation_lease_token'
  ),
  '22023',
  'WHATSAPP_EMBEDDED_SIGNUP_COMPLETION_INVALID',
  'Graph-verified WABA outside the persisted token targets cannot complete onboarding'
);

select throws_ok(
  format(
    $$select * from public.complete_whatsapp_embedded_signup(
      %L::uuid, '97000000-0000-4000-8000-000000000001',
      '678901234567890', '345678901234567', '789012345678901',
      '+54 9 11 5555 0000', true, '123456789012345',
      array['whatsapp_business_management','whatsapp_business_messaging'],
      '[{"scope":"whatsapp_business_management","target_ids":["345678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["345678901234567"]}]'::jsonb,
      array['345678901234567'], clock_timestamp() - interval '1 second',
      clock_timestamp() + interval '60 days', clock_timestamp(), %L::uuid)$$,
    :'primary_attempt_id', :'primary_validation_retry_validation_lease_token'
  ),
  '22023',
  'WHATSAPP_EMBEDDED_SIGNUP_COMPLETION_INVALID',
  'an already-expired Graph token cannot complete onboarding'
);

select * from public.complete_whatsapp_embedded_signup(
  :'primary_attempt_id'::uuid,
  '97000000-0000-4000-8000-000000000001',
  '678901234567890', '345678901234567', '789012345678901',
  '+54 9 11 5555 0000', true, '123456789012345',
  array['whatsapp_business_management','whatsapp_business_messaging'],
  '[{"scope":"whatsapp_business_management","target_ids":["345678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["345678901234567"]}]'::jsonb,
  array['345678901234567'], null,
  :'primary_pre_completion_data_access_expires_at'::timestamptz,
  :'primary_pre_completion_validated_at'::timestamptz,
  :'primary_validation_retry_validation_lease_token'::uuid
)
\gset primary_account_

select ok(
  (
    select business_token_status = 'active'
      and business_token_secret_id is not null
      and business_token_expires_at is null
      and business_token_is_valid
      and business_token_app_id = '123456789012345'
      and business_token_validation_status = 'valid'
      and business_token_last_validated_at is not null
      and business_token_validation_due_at
        = business_token_data_access_expires_at - interval '15 minutes'
      and business_token_validation_due_at
        < business_token_last_validated_at + interval '24 hours'
      and business_token_target_ids = array['345678901234567']
      and onboarding_status = 'provisioning'
      and history_sharing_decision = 'accepted'
      and initial_sync_deadline_at = onboarding_completed_at + interval '24 hours'
      and onboarding_completed_at = :'primary_callback_received_at'::timestamptz
      and history_sync_token_generation = business_token_generation
      and app_state_sync_token_generation = business_token_generation
    from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid
  )
    and exists (
      select 1 from public.whatsapp_business_token_validations
      where account_id = :'primary_account_account_id'::uuid
        and validation_reason = 'pre_completion'
        and token_generation = 1 and is_valid
    )
    and (
      select count(*) = 2
        and count(*) filter (
          where validation_reason = 'post_exchange'
        ) = 1
        and count(*) filter (
          where validation_reason = 'pre_completion'
        ) = 1
        and min(validated_at) < max(validated_at)
      from public.whatsapp_business_token_validations
      where account_id = :'primary_account_account_id'::uuid
        and token_generation = 1
        and validation_reason in ('post_exchange', 'pre_completion')
    )
    and exists (
      select 1 from public.whatsapp_business_token_validation_jobs
      where account_id = :'primary_account_account_id'::uuid
        and token_generation = 1 and status = 'pending'
    ),
  'completion promotes one scoped Vault token and anchors sync to FINISH plus 24 hours'
);

select ok(
  (
    select status = 'completed'
      and validation_lease_token is null
      and validation_lease_expires_at is null
    from public.whatsapp_embedded_signup_attempts
    where id = :'primary_attempt_id'::uuid
  )
    and (
      select count(*) = 1
      from vault.secrets secret
      join public.whatsapp_coexistence_accounts account
        on account.business_token_secret_id = secret.id
      where account.id = :'primary_account_account_id'::uuid
        and secret.name = 'whatsapp_business_access_token_'
          || account.id::text
    ),
  'completion clears validation lease and atomically renames the Vault secret'
);

-- Terminal FINISH and OAuth-code replays must never rewrite lifecycle state,
-- even after the original START transaction TTL has elapsed.
update public.whatsapp_embedded_signup_attempts
set created_at = :'primary_callback_received_at'::timestamptz - interval '10 minutes',
    expires_at = :'primary_callback_received_at'::timestamptz - interval '1 second'
where id = :'primary_attempt_id'::uuid;

select ok(
  public.record_whatsapp_embedded_signup_session(
    :'primary_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000001',
    repeat('a', 64), repeat('b', 64), repeat('e', 64),
    :'primary_callback_received_at'::timestamptz,
    null, '345678901234567', null,
    '{"ad_account_ids":["456789012345678"],"page_ids":["567890123456789"],"dataset_ids":[],"catalog_ids":[],"instagram_account_ids":[],"waba_ids":["345678901234567"]}'::jsonb,
    'accepted'
  )
    and (
      select status = 'completed'
      from public.whatsapp_embedded_signup_attempts
      where id = :'primary_attempt_id'::uuid
    ),
  'exact FINISH replay after START expiry acknowledges without degrading completed'
);

select throws_ok(
  format(
    $$select public.record_whatsapp_embedded_signup_session(
      %L::uuid, '97000000-0000-4000-8000-000000000001', %L, %L, %L,
      %L::timestamptz, null, '345678901234567', null,
      '{"page_ids":["567890123456789"]}'::jsonb, 'accepted')$$,
    :'primary_attempt_id', repeat('a', 64), repeat('b', 64), repeat('e', 64),
    :'primary_callback_received_at'
  ),
  '23514',
  'WHATSAPP_EMBEDDED_SIGNUP_SESSION_CONFLICT',
  'conflicting FINISH replay after expiry is rejected'
);
select is(
  (select status from public.whatsapp_embedded_signup_attempts
   where id = :'primary_attempt_id'::uuid),
  'completed',
  'conflicting terminal FINISH replay leaves completed immutable'
);

select throws_ok(
  format(
    $$select * from public.claim_whatsapp_embedded_signup_code(
      %L::uuid, '97000000-0000-4000-8000-000000000001', %L, %L, %L)$$,
    :'primary_attempt_id', repeat('a', 64), repeat('b', 64), repeat('f', 64)
  ),
  '55000',
  'WHATSAPP_EMBEDDED_SIGNUP_CODE_REPLAY',
  'late OAuth-code replay cannot downgrade a completed attempt'
);
select is(
  (select status from public.whatsapp_embedded_signup_attempts
   where id = :'primary_attempt_id'::uuid),
  'completed',
  'completed remains terminal after a late code replay'
);

select throws_ok(
  $$select * from public.create_whatsapp_embedded_signup_attempt(
    '97000000-0000-4000-8000-000000000003', 'primary-scope',
    repeat('c', 64), repeat('d', 64), '123456789012345',
    '234567890123456', 'declined', clock_timestamp() + interval '10 minutes'
  )$$,
  '55000',
  'WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_ALREADY_CONNECTED',
  'partial or connected Embedded-managed state blocks a second START'
);

select is(
  (
    select count(*)::integer
    from public.whatsapp_onboarding_outbox
    where account_id = :'primary_account_account_id'::uuid
      and token_generation = 1
  ),
  3,
  'accepted history creates exactly one subscribe, contacts and history job'
);

select ok(
  (
    select sending_paused
      and sending_pause_reason = 'COEXISTENCE_ONBOARDING'
    from public.whatsapp_settings where id
  ),
  'onboarding always leaves outbound sending paused'
);

select is(
  public.resolve_whatsapp_coexistence_webhook_account(
    '345678901234567', '789012345678901'
  ),
  :'primary_account_account_id'::uuid,
  'webhook identity resolves only the active Embedded account'
);

select ok(
  public.is_trusted_whatsapp_coexistence_webhook_waba('345678901234567')
    and not public.is_trusted_whatsapp_coexistence_webhook_waba('9999900000'),
  'WABA-scoped lifecycle trust is backed by persisted onboarding state'
);

select ok(
  (
    select business_access_token = 'opaque-primary-token'
      and token_generation = 1
    from public.resolve_whatsapp_account_credentials(
      'onboarding', :'primary_account_account_id'::uuid,
      null, null, null, 1
    )
  ),
  'service-only credential bridge resolves the account Vault token'
);

select ok(
  (public.whatsapp_embedded_signup_status(
    '97000000-0000-4000-8000-000000000001', 'primary-scope'
  ) #>> '{account,tokenExpiryKnown}')::boolean
    and public.whatsapp_embedded_signup_status(
      '97000000-0000-4000-8000-000000000001', 'primary-scope'
    ) #>> '{account,tokenDataAccessExpiresAt}' is not null
    and public.whatsapp_embedded_signup_status(
      '97000000-0000-4000-8000-000000000001', 'primary-scope'
    )::text not like '%opaque-primary-token%'
    and public.whatsapp_embedded_signup_status(
      '97000000-0000-4000-8000-000000000001', 'primary-scope'
    )::text not like '%' || repeat('f', 64) || '%'
    and public.whatsapp_embedded_signup_status(
      '97000000-0000-4000-8000-000000000001', 'primary-scope'
    )::text not like '%' || (
      select business_token_secret_id::text
      from public.whatsapp_coexistence_accounts
      where id = :'primary_account_account_id'::uuid
    ) || '%',
  'status JSON exposes expiry posture but no token, code hash or Vault UUID'
);

select vault.update_secret(
  (select business_token_secret_id from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid),
  '',
  'whatsapp_business_access_token_' || :'primary_account_account_id',
  'temporarily corrupt pgTAP credential'
);
select throws_ok(
  format(
    $$select * from public.resolve_whatsapp_account_credentials(
      'onboarding', %L::uuid, null, null, null, 1)$$,
    :'primary_account_account_id'
  ),
  '55000',
  'WHATSAPP_BUSINESS_CREDENTIAL_CORRUPT',
  'missing or empty Vault material is distinguished as credential corruption'
);
select vault.update_secret(
  (select business_token_secret_id from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid),
  'opaque-primary-token',
  'whatsapp_business_access_token_' || :'primary_account_account_id',
  'restored pgTAP credential'
);

select id::text as id, lease_token::text as lease
from public.claim_whatsapp_onboarding_jobs(1)
\gset subscribe_

select ok(
  (
    select operation = 'subscribe_app' and status = 'processing'
    from public.whatsapp_onboarding_outbox
    where id = :'subscribe_id'::uuid
  ),
  'subscription is the first leased post-onboarding operation'
);

select ok(
  public.complete_whatsapp_onboarding_job(
    :'subscribe_id'::uuid, :'subscribe_lease'::uuid, null,
    'remote_confirmed'
  )
    and not public.complete_whatsapp_onboarding_job(
      :'subscribe_id'::uuid, :'subscribe_lease'::uuid, null,
      'remote_confirmed'
    ),
  'job completion is lease-bound and idempotent against stale callbacks'
);

select id::text as id, lease_token::text as lease
from public.claim_whatsapp_onboarding_jobs(1)
\gset contacts_

select ok(
  public.complete_whatsapp_onboarding_job(
    :'contacts_id'::uuid, :'contacts_lease'::uuid,
    'contacts-request-1', 'remote_confirmed'
  ),
  'contacts sync request is durably recorded after subscription'
);

select id::text as id, lease_token::text as lease
from public.claim_whatsapp_onboarding_jobs(1)
\gset history_

select ok(
  public.complete_whatsapp_onboarding_job(
    :'history_id'::uuid, :'history_lease'::uuid,
    'history-request-1', 'remote_confirmed'
  ),
  'authorized history sync request is durably recorded'
);

select ok(
  (
    select onboarding_status = 'completed'
      and coexistence_status = 'active'
      and app_subscription_status = 'subscribed'
    from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid
  )
    and (select sending_paused from public.whatsapp_settings where id),
  'central recomputation completes onboarding without enabling sends'
);

-- Meta delivers both sync streams as multiple independent webhooks. A
-- consumed event changes the aggregate to partial/completed, but must not
-- revoke authorization for a later chunk in the same token generation.
select (public.enqueue_whatsapp_coexistence_event(
  :'primary_account_account_id'::uuid,
  'embedded:history:multi-chunk:1', 'history',
  '{"history":[{"chunk":1}]}'::jsonb,
  jsonb_build_object('entry_time', clock_timestamp())
)).id::text as event_id
\gset history_chunk_1_
select id::text as event_id, lease_token::text as lease
from public.claim_whatsapp_coexistence_events(1)
where id = :'history_chunk_1_event_id'::uuid
\gset history_chunk_1_claim_
select (public.upsert_whatsapp_coexistence_sync_batch(
  :'primary_account_account_id'::uuid,
  :'history_chunk_1_claim_event_id'::uuid,
  :'history_chunk_1_claim_lease'::uuid,
  'embedded:history:multi-chunk:1:25', 'history', '1', 1, 25,
  'completed', 0, 0, 0, null, '{}'::jsonb
)).id;
select public.complete_whatsapp_coexistence_event(
  :'history_chunk_1_claim_event_id'::uuid,
  :'history_chunk_1_claim_lease'::uuid, '{}'::jsonb
);
select ok(
  (
    select history_sync_status = 'partial' and history_sync_progress = 25
    from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid
  ),
  'first history chunk completes locally with aggregate progress still partial'
);

select lives_ok(
  format(
    $$select public.enqueue_whatsapp_coexistence_event(
      %L::uuid, 'embedded:history:multi-chunk:2', 'history',
      '{"history":[{"chunk":2}]}'::jsonb,
      jsonb_build_object('entry_time', clock_timestamp()))$$,
    :'primary_account_account_id'
  ),
  'second history webhook remains authorized after first event became partial'
);
select id::text as event_id, lease_token::text as lease
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'embedded:history:multi-chunk:2'
\gset history_chunk_2_
select (public.upsert_whatsapp_coexistence_sync_batch(
  :'primary_account_account_id'::uuid,
  :'history_chunk_2_event_id'::uuid,
  :'history_chunk_2_lease'::uuid,
  'embedded:history:multi-chunk:2:50', 'history', '2', 2, 50,
  'completed', 0, 0, 0, null, '{}'::jsonb
)).id;
select public.complete_whatsapp_coexistence_event(
  :'history_chunk_2_event_id'::uuid,
  :'history_chunk_2_lease'::uuid, '{}'::jsonb
);
select ok(
  (
    select history_sync_status = 'partial' and history_sync_progress = 50
    from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid
  ),
  'second sub-100 history chunk completes without closing its generation'
);

select (public.enqueue_whatsapp_coexistence_event(
  :'primary_account_account_id'::uuid,
  'embedded:app-state:multi-chunk:1', 'smb_app_state_sync',
  '{"state_sync":[{"chunk":1}]}'::jsonb,
  jsonb_build_object('entry_time', clock_timestamp())
)).id::text as event_id
\gset app_chunk_1_
select id::text as event_id, lease_token::text as lease
from public.claim_whatsapp_coexistence_events(1)
where id = :'app_chunk_1_event_id'::uuid
\gset app_chunk_1_claim_
select (public.upsert_whatsapp_coexistence_sync_batch(
  :'primary_account_account_id'::uuid,
  :'app_chunk_1_claim_event_id'::uuid,
  :'app_chunk_1_claim_lease'::uuid,
  'embedded:app-state:multi-chunk:1', 'smb_app_state_sync', null, null,
  null, 'completed', 0, 0, 0, null, '{}'::jsonb
)).id;
select public.complete_whatsapp_coexistence_event(
  :'app_chunk_1_claim_event_id'::uuid,
  :'app_chunk_1_claim_lease'::uuid, '{}'::jsonb
);
select is(
  (select app_state_sync_status from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid),
  'partial',
  'first app-state delivery remains partial because Meta has no global marker'
);

select lives_ok(
  format(
    $$select public.enqueue_whatsapp_coexistence_event(
      %L::uuid, 'embedded:app-state:multi-chunk:2',
      'smb_app_state_sync', '{"state_sync":[{"chunk":2}]}'::jsonb,
      jsonb_build_object('entry_time', clock_timestamp()))$$,
    :'primary_account_account_id'
  ),
  'second app-state webhook remains authorized after first event completed'
);
select id::text as event_id, lease_token::text as lease
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'embedded:app-state:multi-chunk:2'
\gset app_chunk_2_
select (public.upsert_whatsapp_coexistence_sync_batch(
  :'primary_account_account_id'::uuid,
  :'app_chunk_2_event_id'::uuid,
  :'app_chunk_2_lease'::uuid,
  'embedded:app-state:multi-chunk:2', 'smb_app_state_sync', null, null,
  null, 'completed', 0, 0, 0, null, '{}'::jsonb
)).id;
select public.complete_whatsapp_coexistence_event(
  :'app_chunk_2_event_id'::uuid,
  :'app_chunk_2_lease'::uuid, '{}'::jsonb
);
select is(
  (select app_state_sync_status from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid),
  'partial',
  'second app-state delivery is consumed without inventing completion'
);

select (public.enqueue_whatsapp_coexistence_event(
  :'primary_account_account_id'::uuid,
  'embedded:history:final:100', 'history',
  '{"history":[{"progress":100}]}'::jsonb,
  jsonb_build_object('entry_time', clock_timestamp())
)).id::text as event_id
\gset history_final_
select id::text as event_id, lease_token::text as lease
from public.claim_whatsapp_coexistence_events(1)
where id = :'history_final_event_id'::uuid
\gset history_final_claim_
select (public.upsert_whatsapp_coexistence_sync_batch(
  :'primary_account_account_id'::uuid,
  :'history_final_claim_event_id'::uuid,
  :'history_final_claim_lease'::uuid,
  'embedded:history:final:100:batch', 'history', '3', 3, 100,
  'completed', 0, 0, 0, null, '{}'::jsonb
)).id;
select public.complete_whatsapp_coexistence_event(
  :'history_final_claim_event_id'::uuid,
  :'history_final_claim_lease'::uuid, '{}'::jsonb
);
select is(
  (select history_sync_status from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid),
  'completed',
  'history aggregate reaches completed after progress 100'
);

select lives_ok(
  format(
    $$select public.enqueue_whatsapp_coexistence_event(
      %L::uuid, 'embedded:history:media-follow-up', 'history',
      '{"history":[{"type":"image","media_follow_up":true}]}'::jsonb,
      jsonb_build_object('entry_time', clock_timestamp()))$$,
    :'primary_account_account_id'
  ),
  'history media follow-up remains authorized after progress 100 completed'
);
select id::text as event_id, lease_token::text as lease
from public.claim_whatsapp_coexistence_events(1)
where external_event_id = 'embedded:history:media-follow-up'
\gset history_media_
select (public.upsert_whatsapp_coexistence_sync_batch(
  :'primary_account_account_id'::uuid,
  :'history_media_event_id'::uuid,
  :'history_media_lease'::uuid,
  'embedded:history:media-follow-up:batch', 'history', 'media', 4, 100,
  'completed', 1, 1, 0, null, '{"media_follow_up":true}'::jsonb
)).id;
select public.complete_whatsapp_coexistence_event(
  :'history_media_event_id'::uuid,
  :'history_media_lease'::uuid, '{"media_follow_up":true}'::jsonb
);
select ok(
  (
    select status = 'processed'
    from public.whatsapp_coexistence_events
    where id = :'history_media_event_id'::uuid
  ),
  'history media follow-up is fully consumed in the completed generation'
);

select (public.start_whatsapp_coexistence_sync_generation(
  :'primary_account_account_id'::uuid, 'history', null, clock_timestamp()
)).history_sync_generation_id::text as generation_id
\gset ambiguous_history_generation_
update public.whatsapp_onboarding_outbox
set sync_generation_id = :'ambiguous_history_generation_generation_id'::uuid,
    remote_request_id = null,
    deadline_at = clock_timestamp() + interval '1 hour'
where id = :'history_id'::uuid;

update public.whatsapp_onboarding_outbox
set status = 'pending', attempts = 0, available_at = clock_timestamp(),
    completed_at = null, completion_reason = null
where id = :'history_id'::uuid;

select id::text as id, lease_token::text as lease
from public.claim_whatsapp_onboarding_jobs(1)
\gset history_ambiguous_

select is(
  public.fail_whatsapp_onboarding_job(
    :'history_ambiguous_id'::uuid,
    :'history_ambiguous_lease'::uuid,
    'GRAPH_CONNECTION_RESET', 'ambiguous', true
  ),
  'ambiguous',
  'an outcome-unknown sync request is never blindly retried'
);

select is(
  (select count(*)::integer from public.claim_whatsapp_onboarding_jobs(1)),
  0,
  'ambiguous sync request stays out of the automatic retry claim set'
);

select (public.enqueue_whatsapp_coexistence_event(
  :'primary_account_account_id'::uuid,
  'embedded:history:webhook-observed', 'history',
  '{"history":[]}'::jsonb,
  jsonb_build_object('fixture', true, 'entry_time', clock_timestamp())
)).id::text as event_id
\gset observed_

select is(
  (select count(*)::integer from public.claim_whatsapp_onboarding_jobs(1)),
  0,
  'recovery reconciles webhook-observed ambiguous sync without reissuing Graph'
);

select ok(
  (
    select status = 'succeeded'
      and completion_reason = 'webhook_observed'
    from public.whatsapp_onboarding_outbox
    where id = :'history_id'::uuid
  ),
  'webhook observation is the authoritative ambiguous-job outcome'
);

update public.whatsapp_onboarding_outbox
set deadline_at = clock_timestamp() - interval '1 second'
where id = :'history_id'::uuid;

select date_trunc('second', first_attempted_at)::text as entry_time
from public.whatsapp_onboarding_outbox
where id = :'history_id'::uuid
\gset same_second_

select lives_ok(
  format(
    $$select public.enqueue_whatsapp_coexistence_event(
      %L::uuid, 'embedded:history:delivery-after-deadline', 'history',
      '{"history":[]}'::jsonb,
      jsonb_build_object('entry_time', %L::timestamptz))$$,
    :'primary_account_account_id', :'same_second_entry_time'
  ),
  'same-second webhook delivery after 24 hours is accepted for an in-window request'
);

select (public.start_whatsapp_coexistence_sync_generation(
  :'primary_account_account_id'::uuid, 'smb_app_state_sync', null,
  clock_timestamp()
)).app_state_sync_generation_id::text as generation_id
\gset ambiguous_app_generation_
update public.whatsapp_onboarding_outbox
set sync_generation_id = :'ambiguous_app_generation_generation_id'::uuid,
    remote_request_id = null,
    deadline_at = clock_timestamp() + interval '1 hour'
where id = :'contacts_id'::uuid;

update public.whatsapp_onboarding_outbox
set status = 'processing', attempts = 2,
    processing_started_at = clock_timestamp() - interval '2 minutes',
    lease_expires_at = clock_timestamp() - interval '1 minute',
    lease_token = gen_random_uuid(), completed_at = null,
    completion_reason = null
where id = :'contacts_id'::uuid;

select is(
  (select count(*)::integer from public.claim_whatsapp_onboarding_jobs(1)),
  0,
  'stale sync lease with no webhook is not returned to pending'
);

select is(
  (select status from public.whatsapp_onboarding_outbox where id = :'contacts_id'::uuid),
  'ambiguous',
  'stale sync lease becomes outcome-unknown'
);

update public.whatsapp_onboarding_outbox
set deadline_at = clock_timestamp() - interval '1 second'
where id = :'contacts_id'::uuid;
select count(*) from public.claim_whatsapp_onboarding_jobs(1);

select ok(
  (
    select status = 'failed' and last_error_code = 'SYNC_WINDOW_EXPIRED'
    from public.whatsapp_onboarding_outbox
    where id = :'contacts_id'::uuid
  )
    and (
      select onboarding_status = 'failed'
        and app_state_sync_status = 'failed'
      from public.whatsapp_coexistence_accounts
      where id = :'primary_account_account_id'::uuid
    ),
  'ambiguous sync expires fail-closed and closes its generation'
);

update public.whatsapp_onboarding_outbox
set status = 'pending', attempts = max_attempts,
    available_at = clock_timestamp(), deadline_at = clock_timestamp() + interval '1 hour',
    failed_at = null, last_error_code = null
where id = :'subscribe_id'::uuid;
select count(*) from public.claim_whatsapp_onboarding_jobs(1);

select ok(
  (
    select status = 'failed' and last_error_code = 'MAX_ATTEMPTS_EXCEEDED'
    from public.whatsapp_onboarding_outbox where id = :'subscribe_id'::uuid
  )
    and (
      select onboarding_status = 'failed'
        and app_subscription_status = 'failed'
      from public.whatsapp_coexistence_accounts
      where id = :'primary_account_account_id'::uuid
    ),
  'max-attempt sweep updates both queue and product state fail-closed'
);

update public.whatsapp_onboarding_outbox
set status = 'succeeded', attempts = 1, completed_at = clock_timestamp(),
    completion_reason = 'remote_confirmed', last_error_code = null
where id in (:'subscribe_id'::uuid, :'contacts_id'::uuid);
update public.whatsapp_coexistence_accounts
set onboarding_status = 'completed', app_subscription_status = 'subscribed',
    app_subscribed_at = clock_timestamp(), coexistence_status = 'active',
    onboarding_last_error_code = null
where id = :'primary_account_account_id'::uuid;

select vault.create_secret(
  'opaque-sibling-token',
  'whatsapp_business_access_token_97000000-0000-4000-8000-000000000100',
  'pgTAP sibling token'
)::text as secret_id
\gset sibling_

insert into public.whatsapp_coexistence_accounts (
  id, client_scope, waba_id, phone_number_id, coexistence_status,
  business_portfolio_id, business_token_secret_id, business_token_generation,
  business_token_status, business_token_expires_at, onboarding_status,
  onboarding_completed_at, initial_sync_deadline_at, history_sharing_decision,
  app_subscription_status, app_subscribed_at
) values (
  '97000000-0000-4000-8000-000000000100', 'sibling-scope',
  '345678901234567', '890123456789012', 'active', '678901234567890',
  :'sibling_secret_id'::uuid, 1, 'active', null, 'completed',
  transaction_timestamp() - interval '1 hour',
  transaction_timestamp() + interval '23 hours', 'declined', 'subscribed',
  clock_timestamp()
);

select throws_ok(
  format(
    $$select public.begin_whatsapp_coexistence_offboarding(
      %L::uuid, '97000000-0000-4000-8000-000000000001',
      'primary-scope')$$,
    :'primary_account_account_id'
  ),
  '55000',
  'WHATSAPP_COEXISTENCE_WABA_SHARED_SUBSCRIPTION',
  'one phone cannot unsubscribe a WABA still serving another active account'
);

select throws_ok(
  format(
    $$select public.begin_whatsapp_coexistence_offboarding(
      %L::uuid, '97000000-0000-4000-8000-000000000001',
      'different-client-scope')$$,
    :'primary_account_account_id'
  ),
  'P0002',
  'WHATSAPP_COEXISTENCE_ACCOUNT_NOT_FOUND',
  'ADMIN cannot offboard an account outside the requested client scope'
);

delete from vault.secrets where id = :'sibling_secret_id'::uuid;
delete from public.whatsapp_coexistence_accounts
where id = '97000000-0000-4000-8000-000000000100';

select count(*)::text as contacts_before,
  (select count(*) from public.messages)::text as messages_before
from public.contacts
\gset preserved_

select ok(
  public.begin_whatsapp_coexistence_offboarding(
    :'primary_account_account_id'::uuid,
    '97000000-0000-4000-8000-000000000001',
    'primary-scope'
  ),
  'authorized offboarding closes active sync generations and enqueues unsubscribe'
);

select id::text as id, lease_token::text as lease,
  attempts::text as attempts, requested_by::text as requested_by
from public.claim_whatsapp_onboarding_jobs(1)
where operation = 'unsubscribe_app'
\gset unsubscribe_

select ok(
  :'unsubscribe_requested_by'::uuid = '97000000-0000-4000-8000-000000000001'
    and not public.begin_whatsapp_coexistence_offboarding(
      :'primary_account_account_id'::uuid,
      '97000000-0000-4000-8000-000000000001',
      'primary-scope'
    )
    and (
      select status = 'processing'
        and lease_token = :'unsubscribe_lease'::uuid
        and attempts = :'unsubscribe_attempts'::integer
      from public.whatsapp_onboarding_outbox
      where id = :'unsubscribe_id'::uuid
    ),
  'repeated offboarding is idempotent and never resets an in-flight lease'
);

update public.whatsapp_coexistence_accounts
set business_token_expires_at = clock_timestamp() - interval '1 second',
    onboarding_status = 'failed'
where id = :'primary_account_account_id'::uuid;

select ok(
  (public.whatsapp_embedded_signup_status(
    '97000000-0000-4000-8000-000000000001', 'primary-scope'
  ) #>> '{account,connected}')::boolean = false
    and (public.whatsapp_embedded_signup_status(
      '97000000-0000-4000-8000-000000000001', 'primary-scope'
    ) #>> '{account,tokenConfigured}')::boolean = false
    and (public.whatsapp_embedded_signup_status(
      '97000000-0000-4000-8000-000000000001', 'primary-scope'
    ) #>> '{account,tokenExpired}')::boolean
    and (public.whatsapp_embedded_signup_status(
      '97000000-0000-4000-8000-000000000001', 'primary-scope'
    ) #>> '{account,requiresOffboarding}')::boolean,
  'failed account with expired retained credential requires offboarding but is not configured'
);

update public.whatsapp_coexistence_accounts
set onboarding_status = 'offboarding'
where id = :'primary_account_account_id'::uuid;

select lives_ok(
  format(
    $$select * from public.resolve_whatsapp_account_credentials(
      'unsubscribe', %L::uuid, null, null, null, 1)$$,
    :'primary_account_account_id'
  ),
  'unsubscribe may retain an expired credential for best-effort remote cleanup'
);

select ok(
  public.finalize_whatsapp_coexistence_local_offboarding(
    :'unsubscribe_id'::uuid, :'unsubscribe_lease'::uuid, 'TOKEN_EXPIRED'
  ),
  'leased processor can finalize local purge when remote DELETE cannot authenticate'
);

select ok(
  (
    select onboarding_status = 'offboarded'
      and coexistence_status = 'disconnected'
      and business_token_status = 'revoked'
      and business_token_secret_id is null
      and business_token_expires_at is null
      and app_subscription_status = 'unknown'
    from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid
  )
    and (
      select status = 'succeeded'
        and completion_reason = 'local_credential_purge'
      from public.whatsapp_onboarding_outbox
      where id = :'unsubscribe_id'::uuid
    ),
  'local purge is truthful about unknown remote subscription state'
);

-- Keep lifecycle fixtures in distinct timestamp seconds so the production
-- same-second fail-closed barrier is exercised deterministically.
update public.whatsapp_coexistence_accounts
set onboarding_completed_at = statement_timestamp() - interval '10 seconds',
    initial_sync_deadline_at = statement_timestamp()
      + interval '24 hours' - interval '10 seconds',
    offboarding_requested_at = statement_timestamp() - interval '6 seconds',
    offboarded_at = statement_timestamp() - interval '5 seconds'
where id = :'primary_account_account_id'::uuid;
select offboarded_at::text as offboarded_at,
  (select count(*) from public.whatsapp_business_token_validation_jobs
    where account_id = account.id)::text as job_count
from public.whatsapp_coexistence_accounts account
where id = :'primary_account_account_id'::uuid
\gset local_offboard_
select count(*) from public.apply_whatsapp_coexistence_account_update(
  '345678901234567', 'PARTNER_REMOVED',
  :'local_offboard_offboarded_at'::timestamptz - interval '1 second',
  '678901234567890', 'ACCOUNT_DISCONNECTED', 'SYSTEM'
);
select ok(
  (
    select onboarding_status = 'offboarded'
      and coexistence_status = 'disconnected'
      and business_token_status = 'revoked'
      and business_token_secret_id is null
      and last_account_update_at is null
    from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid
  )
    and (select count(*)::text
      from public.whatsapp_business_token_validation_jobs
      where account_id = :'primary_account_account_id'::uuid)
      = :'local_offboard_job_count',
  'account_update older than local offboarding is stale and creates no token work'
);
select (clock_timestamp() - interval '2 seconds')::text as event_at
\gset local_reconnect_
select count(*) from public.apply_whatsapp_coexistence_account_update(
  '345678901234567', 'ACCOUNT_RECONNECTED',
  :'local_reconnect_event_at'::timestamptz,
  '678901234567890', null, null
);
select ok(
  (
    select onboarding_status = 'offboarded'
      and coexistence_status = 'disconnected'
      and business_token_status = 'revoked'
      and business_token_secret_id is null
      and last_account_update_at = :'local_reconnect_event_at'::timestamptz
      and last_account_update_event = 'ACCOUNT_RECONNECTED'
    from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid
  )
    and (select count(*)::text
      from public.whatsapp_business_token_validation_jobs
      where account_id = :'primary_account_account_id'::uuid)
      = :'local_offboard_job_count'
    and exists (
      select 1 from public.audit_logs
      where action = 'whatsapp.coexistence.account_update_ignored'
        and entity_id = :'primary_account_account_id'::uuid
        and metadata @> '{"event":"ACCOUNT_RECONNECTED","reason":"LOCALLY_OFFBOARDED"}'::jsonb
    ),
  'ACCOUNT_RECONNECTED records a causal barrier without reviving a locally offboarded account'
);

-- A clean explicit offboarding cannot retain stale expiry state or masquerade
-- as a live expired credential.
select ok(
  (public.whatsapp_embedded_signup_status(
    '97000000-0000-4000-8000-000000000001', 'primary-scope'
  ) #>> '{account,tokenExpired}')::boolean = false
    and (public.whatsapp_embedded_signup_status(
      '97000000-0000-4000-8000-000000000001', 'primary-scope'
    ) #>> '{account,requiresOffboarding}')::boolean = false,
  'clean revoked state does not block re-onboarding'
);

select ok(
  (select count(*)::text from public.contacts) = :'preserved_contacts_before'
    and (select count(*)::text from public.messages) = :'preserved_messages_before',
  'offboarding preserves all contacts and messages'
);

-- Re-onboard the same phone with history declined. This also exercises the
-- official callback order in which the OAuth code arrives before FINISH.
select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000003', 'primary-scope',
  repeat('1', 64), repeat('2', 64), '123456789012345',
  '234567890123456', 'declined', clock_timestamp() + interval '10 minutes'
)
\gset declined_

select * from public.claim_whatsapp_embedded_signup_code(
  :'declined_attempt_id'::uuid,
  '97000000-0000-4000-8000-000000000003',
  repeat('1', 64), repeat('2', 64), repeat('3', 64)
)
\gset declined_exchange_

select ok(
  public.store_whatsapp_embedded_signup_exchange_token(
    :'declined_attempt_id'::uuid, repeat('3', 64), 'opaque-declined-token'
  ),
  'code-before-FINISH stores its token in Vault'
);
select (clock_timestamp() - interval '1 second')::text as validated_at
\gset declined_post_exchange_
select ok(
  public.record_whatsapp_embedded_signup_post_exchange_validation(
    :'declined_attempt_id'::uuid, true, '123456789012345',
    array['whatsapp_business_management','whatsapp_business_messaging'],
    '[{"scope":"whatsapp_business_management","target_ids":["345678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["345678901234567"]}]'::jsonb,
    array['345678901234567'], null, null,
    :'declined_post_exchange_validated_at'::timestamptz
  ),
  'code-before-FINISH can complete its independent post-exchange validation'
);
select is(
  (select status from public.whatsapp_embedded_signup_attempts
    where id = :'declined_attempt_id'::uuid),
  'token_stored',
  'code-before-FINISH remains token_stored after its checkpoint until FINISH'
);

select clock_timestamp()::text as received_at
\gset declined_callback_

select ok(
  public.record_whatsapp_embedded_signup_session(
    :'declined_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000003',
    repeat('1', 64), repeat('2', 64), repeat('4', 64),
    :'declined_callback_received_at'::timestamptz,
    null, '345678901234567', null,
    '{"ad_account_ids":[],"page_ids":[],"dataset_ids":[],"catalog_ids":[],"instagram_account_ids":[],"waba_ids":["345678901234567"]}'::jsonb,
    'declined'
  ),
  'later FINISH advances token_stored to durable validation'
);

select * from public.claim_whatsapp_embedded_signup_validations(
  1, :'declined_attempt_id'::uuid
)
\gset declined_validation_

select (clock_timestamp() + interval '60 days')::text as expires_at,
  (clock_timestamp() + interval '60 days')::text as data_access_expires_at,
  clock_timestamp()::text as validated_at
\gset declined_pre_completion_
select ok(
  public.record_whatsapp_embedded_signup_pre_completion_validation(
    :'declined_attempt_id'::uuid,
    :'declined_validation_validation_lease_token'::uuid,
    true, '123456789012345',
    array['whatsapp_business_management','whatsapp_business_messaging'],
    '[{"scope":"whatsapp_business_management","target_ids":["345678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["345678901234567"]}]'::jsonb,
    array['345678901234567'],
    :'declined_pre_completion_expires_at'::timestamptz,
    :'declined_pre_completion_data_access_expires_at'::timestamptz,
    :'declined_pre_completion_validated_at'::timestamptz
  ),
  'code-before-FINISH flow records a distinct pre-completion checkpoint'
);

select * from public.complete_whatsapp_embedded_signup(
  :'declined_attempt_id'::uuid,
  '97000000-0000-4000-8000-000000000003',
  '678901234567890', '345678901234567', '789012345678901',
  '+54 9 11 5555 0000', true, '123456789012345',
  array['whatsapp_business_management','whatsapp_business_messaging'],
  '[{"scope":"whatsapp_business_management","target_ids":["345678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["345678901234567"]}]'::jsonb,
  array['345678901234567'],
  :'declined_pre_completion_expires_at'::timestamptz,
  :'declined_pre_completion_data_access_expires_at'::timestamptz,
  :'declined_pre_completion_validated_at'::timestamptz,
  :'declined_validation_validation_lease_token'::uuid
)
\gset declined_account_

select ok(
  :'declined_account_account_id'::uuid = :'primary_account_account_id'::uuid
    and (
      select business_token_generation = 2
        and history_sharing_decision = 'declined'
        and history_sync_token_generation is null
        and app_state_sync_status = 'pending'
      from public.whatsapp_coexistence_accounts
      where id = :'primary_account_account_id'::uuid
    )
    and (
      select count(*) = 2
      from public.whatsapp_onboarding_outbox
      where account_id = :'primary_account_account_id'::uuid
        and token_generation = 2
    ),
  'offboarded account can start fresh generations with declined history and no history job'
);

select throws_ok(
  format(
    $$select public.enqueue_whatsapp_coexistence_event(
      %L::uuid, 'late:old:history:generation', 'history',
      '{"history":[{"id":"old"}]}'::jsonb,
      jsonb_build_object('entry_time', clock_timestamp()))$$,
    :'primary_account_account_id'
  ),
  '42501',
  'WHATSAPP_COEXISTENCE_SYNC_EVENT_NOT_AUTHORIZED',
  'late history from an old generation is rejected after declined re-onboarding'
);

select date_trunc('second', onboarding_completed_at)::text as event_time
from public.whatsapp_coexistence_accounts
where id = :'primary_account_account_id'::uuid
\gset lifecycle_same_second_
select sending_paused::text as paused, updated_at::text as updated_at
from public.whatsapp_settings where id
\gset lifecycle_settings_before_
select count(*) from public.apply_whatsapp_coexistence_account_update(
  '345678901234567', 'PARTNER_REMOVED',
  :'lifecycle_same_second_event_time'::timestamptz,
  '678901234567890', 'ACCOUNT_DISCONNECTED', 'USER'
);
select ok(
  (
    select onboarding_status = 'failed'
      and coexistence_status = 'disconnected'
      and app_subscription_status = 'unknown'
      and business_token_status = 'unknown'
      and business_token_secret_id is not null
      and business_token_generation = 2
      and attention_required
      and offboarded_at is null
      and last_disconnection_reason = 'ACCOUNT_DISCONNECTED'
      and last_disconnection_initiated_by = 'USER'
    from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid
  )
    and (
      select sending_paused::text = :'lifecycle_settings_before_paused'
        and updated_at = :'lifecycle_settings_before_updated_at'::timestamptz
      from public.whatsapp_settings where id
    )
    and (select count(*)::text from public.contacts)
      = :'preserved_contacts_before'
    and (select count(*)::text from public.messages)
      = :'preserved_messages_before',
  'same-second lifecycle disconnects and pauses without deleting retained credentials'
);

select count(*) from public.apply_whatsapp_coexistence_account_update(
  '345678901234567', 'PARTNER_REMOVED',
  :'lifecycle_same_second_event_time'::timestamptz,
  '678901234567890', 'ACCOUNT_DISCONNECTED', 'USER'
);
select ok(
  (
    select last_account_update_event = 'PARTNER_REMOVED'
      and business_token_status = 'unknown'
      and business_token_secret_id is not null
      and business_token_generation = 2
    from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid
  ),
  'exact account_update replay is idempotent and retains token generation'
);

select count(*) from public.apply_whatsapp_coexistence_account_update(
  '345678901234567', 'ACCOUNT_RECONNECTED',
  :'lifecycle_same_second_event_time'::timestamptz - interval '1 second',
  '678901234567890', null, null
);
select is(
  (select last_account_update_event
   from public.whatsapp_coexistence_accounts
   where id = :'primary_account_account_id'::uuid),
  'PARTNER_REMOVED',
  'stale account_update cannot overwrite the causal lifecycle barrier'
);

select count(*) from public.apply_whatsapp_coexistence_account_update(
  '345678901234567', 'ACCOUNT_OFFBOARDED',
  :'lifecycle_same_second_event_time'::timestamptz + interval '1 second',
  '678901234567890', null, null
);
select ok(
  (
    select last_account_update_event = 'ACCOUNT_OFFBOARDED'
      and coexistence_status = 'disconnected'
      and business_token_status = 'unknown'
      and business_token_secret_id is not null
      and business_token_generation = 2
      and attention_required
      and offboarded_at is null
    from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid
  )
    and not exists (
      select 1 from public.whatsapp_onboarding_outbox
      where account_id = :'primary_account_account_id'::uuid
        and status in ('pending', 'processing', 'ambiguous')
    ),
  'ACCOUNT_OFFBOARDED retains data/token for recovery and blocks Graph work'
);

select count(*)::text as outbox_count
from public.whatsapp_onboarding_outbox
where account_id = :'primary_account_account_id'::uuid
\gset offboarded_replay_
select count(*)::text as validation_job_count
from public.whatsapp_business_token_validation_jobs
where account_id = :'primary_account_account_id'::uuid
\gset offboarded_replay_jobs_
select business_token_secret_id::text as secret_id,
  business_token_generation::text as generation,
  onboarding_status as onboarding_status,
  coexistence_status as coexistence_status,
  business_token_status as token_status
from public.whatsapp_coexistence_accounts
where id = :'primary_account_account_id'::uuid
\gset offboarded_replay_account_

select ok(
  public.record_whatsapp_embedded_signup_session(
    :'declined_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000003',
    repeat('1', 64), repeat('2', 64), repeat('4', 64),
    :'declined_callback_received_at'::timestamptz,
    null, '345678901234567', null,
    '{"ad_account_ids":[],"page_ids":[],"dataset_ids":[],"catalog_ids":[],"instagram_account_ids":[],"waba_ids":["345678901234567"]}'::jsonb,
    'declined'
  ),
  'exact FINISH replay after ACCOUNT_OFFBOARDED is acknowledged without mutation'
);
select throws_ok(
  format(
    $$select public.record_whatsapp_embedded_signup_session(
      %L::uuid, '97000000-0000-4000-8000-000000000003',
      %L, %L, %L, %L::timestamptz, null, '345678901234567', null,
      '{"waba_ids":["345678901234567"]}'::jsonb, 'declined')$$,
    :'declined_attempt_id', repeat('1', 64), repeat('2', 64),
    repeat('5', 64), :'declined_callback_received_at'
  ),
  '23514',
  'WHATSAPP_EMBEDDED_SIGNUP_SESSION_CONFLICT',
  'conflicting FINISH after ACCOUNT_OFFBOARDED is rejected'
);
select throws_ok(
  format(
    $$select * from public.claim_whatsapp_embedded_signup_code(
      %L::uuid, '97000000-0000-4000-8000-000000000003',
      %L, %L, %L)$$,
    :'declined_attempt_id', repeat('1', 64), repeat('2', 64), repeat('9', 64)
  ),
  '55000',
  'WHATSAPP_EMBEDDED_SIGNUP_CODE_REPLAY',
  'late OAuth code after ACCOUNT_OFFBOARDED is rejected'
);
select ok(
  (select count(*)::text from public.whatsapp_onboarding_outbox
    where account_id = :'primary_account_account_id'::uuid)
      = :'offboarded_replay_outbox_count'
    and (select count(*)::text
      from public.whatsapp_business_token_validation_jobs
      where account_id = :'primary_account_account_id'::uuid)
      = :'offboarded_replay_jobs_validation_job_count'
    and (
      select business_token_secret_id::text
          = :'offboarded_replay_account_secret_id'
        and business_token_generation::text
          = :'offboarded_replay_account_generation'
        and onboarding_status = :'offboarded_replay_account_onboarding_status'
        and coexistence_status = :'offboarded_replay_account_coexistence_status'
        and business_token_status = :'offboarded_replay_account_token_status'
      from public.whatsapp_coexistence_accounts
      where id = :'primary_account_account_id'::uuid
    )
    and (
      select status = 'completed'
      from public.whatsapp_embedded_signup_attempts
      where id = :'declined_attempt_id'::uuid
    ),
  'post-offboarding callbacks create no work and cannot reactivate token/account state'
);

select count(*) from public.apply_whatsapp_coexistence_account_update(
  '345678901234567', 'ACCOUNT_RECONNECTED',
  :'lifecycle_same_second_event_time'::timestamptz + interval '2 seconds',
  '678901234567890', null, null
);
select ok(
  (
    select last_account_update_event = 'ACCOUNT_RECONNECTED'
      and coexistence_status = 'paused'
      and business_token_status = 'unknown'
      and business_token_secret_id is not null
      and attention_required
    from public.whatsapp_coexistence_accounts
    where id = :'primary_account_account_id'::uuid
  )
    and (
      select status = 'pending' and token_generation = 2
      from public.whatsapp_business_token_validation_jobs
      where account_id = :'primary_account_account_id'::uuid
    ),
  'ACCOUNT_RECONNECTED keeps sending paused and schedules fenced revalidation'
);

select throws_ok(
  format(
    $$select * from public.apply_whatsapp_coexistence_account_update(
      '345678901234567', 'PARTNER_REMOVED', %L::timestamptz,
      '999999999999999', 'ACCOUNT_DISCONNECTED', 'SYSTEM')$$,
    (:'lifecycle_same_second_event_time'::timestamptz
      + interval '3 seconds')::text
  ),
  'P0002',
  'WHATSAPP_COEXISTENCE_ACCOUNT_NOT_FOUND',
  'unexpected owner cannot mutate another portfolio account'
);
select is(
  (select last_account_update_event
   from public.whatsapp_coexistence_accounts
   where id = :'primary_account_account_id'::uuid),
  'ACCOUNT_RECONNECTED',
  'owner mismatch leaves the matched WABA account unchanged'
);

select vault.create_secret(
  'opaque-current-account-token',
  'whatsapp_business_access_token_97000000-0000-4000-8000-000000000120',
  'pgTAP deterministic status account'
)::text as secret_id
\gset current_scope_
insert into public.whatsapp_coexistence_accounts (
  id, client_scope, waba_id, phone_number_id, coexistence_status,
  business_portfolio_id, business_token_secret_id, business_token_generation,
  business_token_status, business_token_is_valid, business_token_app_id,
  business_token_scopes, business_token_granular_scopes,
  business_token_target_ids, business_token_expires_at,
  business_token_data_access_expires_at, business_token_last_validated_at,
  business_token_validation_due_at, business_token_validation_status,
  onboarding_status, onboarding_completed_at,
  initial_sync_deadline_at, history_sharing_decision,
  app_subscription_status, app_subscribed_at, last_onboarding_attempt_id
) values (
  '97000000-0000-4000-8000-000000000120', 'primary-scope',
  '945678901234567', '945678901234568', 'active', '945678901234569',
  :'current_scope_secret_id'::uuid, 1, 'active', true, '123456789012345',
  array['whatsapp_business_management','whatsapp_business_messaging'],
  '[{"scope":"whatsapp_business_management","target_ids":["945678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["945678901234567"]}]'::jsonb,
  array['945678901234567'], transaction_timestamp() + interval '60 days',
  transaction_timestamp() + interval '60 days', transaction_timestamp(),
  transaction_timestamp() + interval '24 hours', 'valid', 'completed',
  transaction_timestamp() - interval '1 hour',
  transaction_timestamp() + interval '23 hours', 'declined',
  'subscribed', transaction_timestamp(),
  :'declined_attempt_id'::uuid
);
select sending_paused::text as paused, updated_at::text as updated_at
from public.whatsapp_settings where id
\gset reconnect_settings_
select (clock_timestamp() - interval '2 seconds')::text as disconnected_at
\gset current_reconnect_
select count(*) from public.apply_whatsapp_coexistence_account_update(
  '945678901234567', 'ACCOUNT_OFFBOARDED',
  :'current_reconnect_disconnected_at'::timestamptz,
  '945678901234569', null, null
);
select count(*) from public.apply_whatsapp_coexistence_account_update(
  '945678901234567', 'ACCOUNT_RECONNECTED',
  :'current_reconnect_disconnected_at'::timestamptz + interval '1 second',
  '945678901234569', null, null
);
update public.whatsapp_business_token_validation_jobs
set available_at = clock_timestamp() + interval '1 day'
where account_id <> '97000000-0000-4000-8000-000000000120';
select id::text as id, lease_token::text as lease
from public.claim_whatsapp_business_token_validation_jobs(1)
\gset reconnect_validation_
select is(
  public.complete_whatsapp_business_token_validation_job(
    :'reconnect_validation_id'::uuid,
    :'reconnect_validation_lease'::uuid,
    true, '123456789012345',
    array['whatsapp_business_management','whatsapp_business_messaging'],
    '[{"scope":"whatsapp_business_management","target_ids":["945678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["945678901234567"]}]'::jsonb,
    array['945678901234567'], clock_timestamp() + interval '60 days',
    clock_timestamp() + interval '60 days', clock_timestamp(), null
  ),
  'rescheduled',
  'real reconnect validation completes under its generation-fenced lease'
);
select ok(
  (
    select coexistence_status = 'active'
      and onboarding_status = 'completed'
      and app_subscription_status = 'subscribed'
      and business_token_status = 'active'
      and business_token_validation_status = 'valid'
      and not attention_required
      and last_account_update_event = 'ACCOUNT_RECONNECTED'
    from public.whatsapp_coexistence_accounts
    where id = '97000000-0000-4000-8000-000000000120'
  )
    and exists (
      select 1 from public.whatsapp_business_token_validations
      where account_id = '97000000-0000-4000-8000-000000000120'
        and validation_reason = 'reconnect'
        and is_valid and authorization_valid
    )
    and (
      select sending_paused::text = :'reconnect_settings_paused'
        and updated_at = :'reconnect_settings_updated_at'::timestamptz
      from public.whatsapp_settings where id
    ),
  'reconnect success restores only the exact account and never global sending state'
);
insert into public.messages (
  id, conversation_id, contact_id, direction, whatsapp_message_id,
  body, status, coexistence_account_id
) values (
  '97000000-0000-4000-8000-000000000121',
  '97000000-0000-4000-8000-000000000091',
  '97000000-0000-4000-8000-000000000090', 'inbound',
  'wamid.coexistence.account.binding', 'bound inbound fixture', 'delivered',
  '97000000-0000-4000-8000-000000000120'
);
select is(
  (select coexistence_account_id
   from public.conversations
   where id = '97000000-0000-4000-8000-000000000091'),
  '97000000-0000-4000-8000-000000000120'::uuid,
  'first Coexistence message atomically binds its conversation account'
);
select throws_ok(
  $$insert into public.messages (
      conversation_id, contact_id, direction, whatsapp_message_id,
      body, status, coexistence_account_id
    ) values (
      '97000000-0000-4000-8000-000000000091',
      '97000000-0000-4000-8000-000000000090', 'inbound',
      'wamid.coexistence.account.mismatch', 'mismatch', 'delivered',
      '97000000-0000-4000-8000-000000000123'
    )$$,
  '23514',
  'WHATSAPP_CONVERSATION_ACCOUNT_MISMATCH',
  'a conversation cannot accept a message routed through another account'
);
insert into public.messages (
  id, conversation_id, contact_id, direction, whatsapp_message_id,
  body, status
) values (
  '97000000-0000-4000-8000-000000000122',
  '97000000-0000-4000-8000-000000000091',
  '97000000-0000-4000-8000-000000000090', 'inbound',
  'wamid.coexistence.account.inherited', 'inherited inbound fixture', 'delivered'
);
select is(
  (select coexistence_account_id from public.messages
   where id = '97000000-0000-4000-8000-000000000122'),
  '97000000-0000-4000-8000-000000000120'::uuid,
  'new messages inherit the immutable conversation account when omitted'
);
select ok(
  (
    select message_snapshot ->> 'coexistence_account_id'
        = '97000000-0000-4000-8000-000000000120'
      and conversation_snapshot ->> 'coexistence_account_id'
        = '97000000-0000-4000-8000-000000000120'
    from public.claim_whatsapp_automation_execution(
      '97000000-0000-4000-8000-000000000121', '{}'::jsonb, 900
    )
  ),
  'automation execution snapshots carry the immutable account routing identity'
);
select
  automation_mode::text as mode,
  needs_human::text as needs_human,
  coalesce(automation_pause_source::text, '') as pause_source,
  coalesce(automation_pause_message_id::text, '') as pause_message_id
from public.conversations
where id = '97000000-0000-4000-8000-000000000091'
\gset account_echo_before_
select public.pause_whatsapp_automation_for_app_echo(
  '97000000-0000-4000-8000-000000000120',
  '+5491100000090', null
) as affected
\gset account_echo_first_
select ok(
  :'account_echo_first_affected'::integer = 1
    and (
      select coexistence_account_id =
          '97000000-0000-4000-8000-000000000120'
        and automation_mode::text = :'account_echo_before_mode'
        and needs_human::text = :'account_echo_before_needs_human'
        and coalesce(automation_pause_source::text, '') =
          :'account_echo_before_pause_source'
        and coalesce(automation_pause_message_id::text, '') =
          :'account_echo_before_pause_message_id'
        and automation_human_barrier_ingest_sequence = (
          select max(whatsapp_ingest_sequence)
          from public.messages
          where conversation_id =
            '97000000-0000-4000-8000-000000000091'
            and direction = 'inbound'
        )
      from public.conversations
      where id = '97000000-0000-4000-8000-000000000091'
    ),
  'account-scoped app echo records the bound conversation barrier without changing its preference'
);
select public.pause_whatsapp_automation_for_app_echo(
  '97000000-0000-4000-8000-000000000120',
  '+5491100000090', null
) as affected
\gset account_echo_replay_
select ok(
  :'account_echo_replay_affected'::integer = 0
    and (
      select automation_mode::text = :'account_echo_before_mode'
        and needs_human::text = :'account_echo_before_needs_human'
        and coalesce(automation_pause_source::text, '') =
          :'account_echo_before_pause_source'
        and coalesce(automation_pause_message_id::text, '') =
          :'account_echo_before_pause_message_id'
        and automation_human_barrier_ingest_sequence = (
          select max(whatsapp_ingest_sequence)
          from public.messages
          where conversation_id =
            '97000000-0000-4000-8000-000000000091'
            and direction = 'inbound'
        )
      from public.conversations
      where id = '97000000-0000-4000-8000-000000000091'
    ),
  'exact account-scoped app echo replay is state-idempotent'
);
select throws_ok(
  format(
    $$select public.pause_whatsapp_automation_for_app_echo(
      %L::uuid, '+5491100000090', null)$$,
    :'primary_account_account_id'
  ),
  '55000',
  'WHATSAPP_ECHO_ACCOUNT_MISMATCH',
  'an app echo from another managed account cannot pause a sibling conversation'
);
select ok(
  (
    select coexistence_account_id = '97000000-0000-4000-8000-000000000120'
      and automation_mode::text = :'account_echo_before_mode'
      and needs_human::text = :'account_echo_before_needs_human'
      and coalesce(automation_pause_source::text, '') =
        :'account_echo_before_pause_source'
      and coalesce(automation_pause_message_id::text, '') =
        :'account_echo_before_pause_message_id'
      and automation_human_barrier_ingest_sequence = (
        select max(whatsapp_ingest_sequence)
        from public.messages
        where conversation_id = '97000000-0000-4000-8000-000000000091'
          and direction = 'inbound'
      )
    from public.conversations
    where id = '97000000-0000-4000-8000-000000000091'
  ),
  'cross-account echo rejection leaves sibling routing, preference, and barrier unchanged'
);
insert into public.contacts (id, phone_e164, whatsapp_id, name) values (
  '97000000-0000-4000-8000-000000000146',
  '+5491100000146', '5491100000146', 'Unbound echo fixture'
);
insert into public.conversations (id, contact_id) values (
  '97000000-0000-4000-8000-000000000147',
  '97000000-0000-4000-8000-000000000146'
);
select is(
  public.pause_whatsapp_automation_for_app_echo(
    '97000000-0000-4000-8000-000000000120',
    '+5491100000146', null
  ),
  0,
  'managed account may bind an unbound conversation without inventing a barrier when no inbound exists'
);
select ok(
  (
    select coexistence_account_id = '97000000-0000-4000-8000-000000000120'
      and automation_mode = 'auto'
      and automation_pause_source is null
      and automation_human_barrier_ingest_sequence = 0
    from public.conversations
    where id = '97000000-0000-4000-8000-000000000147'
  )
    and not has_function_privilege(
      'service_role',
      'public.pause_whatsapp_automation_for_app_echo(text,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.pause_whatsapp_automation_for_app_echo(uuid,text,text)',
      'EXECUTE'
    ),
  'legacy overload is disabled while the scoped overload binds without changing preference'
);
select is(
  public.whatsapp_embedded_signup_status(
    '97000000-0000-4000-8000-000000000003', 'primary-scope'
  ) #>> '{account,accountId}',
  '97000000-0000-4000-8000-000000000120',
  'status deterministically prioritizes the current active account'
);
select ok(
  (
    select credential_mode = 'coexistence'
      and account_id = '97000000-0000-4000-8000-000000000120'::uuid
      and waba_id = '945678901234567'
      and phone_number_id = '945678901234568'
      and business_access_token = 'opaque-current-account-token'
      and token_generation = 1
    from public.resolve_whatsapp_account_credentials(
      'media', null, '945678901234567', '945678901234568', null, 1
    )
  ),
  'account selectors resolve exactly the matching scoped Vault token'
);
select throws_ok(
  $$select * from public.resolve_whatsapp_account_credentials(
    'media', '97000000-0000-4000-8000-000000000120',
    '345678901234567', null, null, 1
  )$$,
  'P0002',
  'WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_NOT_FOUND',
  'a WABA from another account cannot resolve the selected token'
);
select throws_ok(
  $$select * from public.resolve_whatsapp_account_credentials(
    'media', '97000000-0000-4000-8000-000000000120',
    null, null, null, 2
  )$$,
  '55000',
  'WHATSAPP_BUSINESS_CREDENTIAL_GENERATION_STALE',
  'token generation fencing rejects a stale or cross-generation caller'
);

select vault.update_secret(
  :'current_scope_secret_id'::uuid, '',
  'whatsapp_business_access_token_97000000-0000-4000-8000-000000000120',
  'temporarily empty lifecycle fixture'
);
select throws_ok(
  $$select * from public.resolve_whatsapp_account_credentials(
    'media', '97000000-0000-4000-8000-000000000120',
    null, null, null, 1
  )$$,
  '55000',
  'WHATSAPP_BUSINESS_CREDENTIAL_CORRUPT',
  'missing Vault plaintext fails closed without legacy fallback'
);
select vault.update_secret(
  :'current_scope_secret_id'::uuid, 'opaque-current-account-token',
  'whatsapp_business_access_token_97000000-0000-4000-8000-000000000120',
  'restored lifecycle fixture'
);

insert into public.whatsapp_coexistence_accounts (
  id, client_scope, waba_id, phone_number_id
) values (
  '97000000-0000-4000-8000-000000000124', 'sibling-scope',
  '945678901234570', '945678901234571'
);
insert into public.contacts (id, phone_e164, whatsapp_id, name) values
  ('97000000-0000-4000-8000-000000000130', '+5491100000130', '5491100000130', 'Target work'),
  ('97000000-0000-4000-8000-000000000132', '+5491100000132', '5491100000132', 'Sibling work'),
  ('97000000-0000-4000-8000-000000000135', '+5491100000135', '5491100000135', 'Shared identity work');
insert into public.conversations (
  id, contact_id, status, coexistence_account_id
) values
  ('97000000-0000-4000-8000-000000000131', '97000000-0000-4000-8000-000000000130', 'open', '97000000-0000-4000-8000-000000000120'),
  ('97000000-0000-4000-8000-000000000133', '97000000-0000-4000-8000-000000000132', 'open', '97000000-0000-4000-8000-000000000124'),
  ('97000000-0000-4000-8000-000000000136', '97000000-0000-4000-8000-000000000135', 'closed', '97000000-0000-4000-8000-000000000120'),
  ('97000000-0000-4000-8000-000000000137', '97000000-0000-4000-8000-000000000135', 'open', '97000000-0000-4000-8000-000000000124');
insert into public.professionals (id, name, specialty) values (
  '97000000-0000-4000-8000-000000000125', 'Lifecycle Test', 'Testing'
);
insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  deposit_status, hold_expires_at, hold_expired_notification_status,
  hold_expired_notification_attempts, hold_expired_notification_claimed_at
) values
  (
    '97000000-0000-4000-8000-000000000140',
    '97000000-0000-4000-8000-000000000130',
    '97000000-0000-4000-8000-000000000125',
    '2036-01-01 10:00:00+00', '2036-01-01 10:30:00+00',
    'scheduled', 'manual', 'pending', '2036-01-01 09:30:00+00',
    'processing', 1, clock_timestamp()
  ),
  (
    '97000000-0000-4000-8000-000000000141',
    '97000000-0000-4000-8000-000000000132',
    '97000000-0000-4000-8000-000000000125',
    '2036-01-01 11:00:00+00', '2036-01-01 11:30:00+00',
    'scheduled', 'manual', 'pending', '2036-01-01 10:30:00+00',
    'processing', 1, clock_timestamp()
  ),
  (
    '97000000-0000-4000-8000-000000000142',
    '97000000-0000-4000-8000-000000000135',
    '97000000-0000-4000-8000-000000000125',
    '2036-01-01 12:00:00+00', '2036-01-01 12:30:00+00',
    'scheduled', 'manual', 'pending', '2036-01-01 11:30:00+00',
    'processing', 1, clock_timestamp()
  );
insert into public.reminders (
  id, appointment_id, type, scheduled_at, status,
  attempts, processing_started_at
) values
  ('97000000-0000-4000-8000-000000000143', '97000000-0000-4000-8000-000000000140', 'appointment_24h', '2035-12-31 10:00:00+00', 'processing', 1, clock_timestamp()),
  ('97000000-0000-4000-8000-000000000144', '97000000-0000-4000-8000-000000000141', 'appointment_24h', '2035-12-31 11:00:00+00', 'processing', 1, clock_timestamp()),
  ('97000000-0000-4000-8000-000000000145', '97000000-0000-4000-8000-000000000142', 'appointment_24h', '2035-12-31 12:00:00+00', 'processing', 1, clock_timestamp());

select ok(
  public.mark_whatsapp_business_token_attention_required(
    '97000000-0000-4000-8000-000000000120', 1, 'unknown',
    'GRAPH_AUTH_ERROR', clock_timestamp()
  ),
  'Graph authentication errors atomically mark only that account for attention'
);
select ok(
  (
    select status = 'cancelled' and processing_started_at is null
      and last_error = 'GRAPH_AUTH_ERROR'
    from public.reminders
    where id = '97000000-0000-4000-8000-000000000143'
  )
    and (
      select hold_expired_notification_status = 'cancelled'
        and hold_expired_notification_claimed_at is null
        and hold_expired_notification_error = 'GRAPH_AUTH_ERROR'
      from public.appointments
      where id = '97000000-0000-4000-8000-000000000140'
    )
    and (
      select status = 'processing' and processing_started_at is not null
      from public.reminders
      where id = '97000000-0000-4000-8000-000000000144'
    )
    and (
      select hold_expired_notification_status = 'processing'
        and hold_expired_notification_claimed_at is not null
      from public.appointments
      where id = '97000000-0000-4000-8000-000000000141'
    )
    and (
      select status = 'processing'
      from public.reminders
      where id = '97000000-0000-4000-8000-000000000145'
    )
    and (
      select hold_expired_notification_status = 'processing'
      from public.appointments
      where id = '97000000-0000-4000-8000-000000000142'
    ),
  'account pause cancels only unambiguous target reminders/hold notifications and preserves siblings'
);
select ok(
  (
    select coexistence_status = 'paused'
      and attention_required
      and attention_required_reason = 'GRAPH_AUTH_ERROR'
    from public.whatsapp_coexistence_accounts
    where id = '97000000-0000-4000-8000-000000000120'
  )
    and exists (
      select 1 from public.whatsapp_business_token_validation_jobs job
      join public.whatsapp_coexistence_accounts account
        on account.id = job.account_id
      where job.account_id = '97000000-0000-4000-8000-000000000120'
        and job.validation_reason = 'auth_error'
        and job.pause_observed_at = account.attention_required_at
        and job.pause_error_code = account.attention_required_reason
    )
    and exists (
      select 1 from public.whatsapp_business_token_validations
      where account_id = '97000000-0000-4000-8000-000000000120'
        and validation_reason = 'auth_error'
        and is_valid is null and not authorization_valid
        and error_code = 'GRAPH_AUTH_ERROR'
    )
    and exists (
      select 1 from public.audit_logs
      where action = 'whatsapp.business_token.attention_required'
        and entity_id = '97000000-0000-4000-8000-000000000120'
    ),
  'unknown auth result persists account pause, causal job, raw ledger and audit atomically'
);
select public.schedule_whatsapp_business_token_validation(
  '97000000-0000-4000-8000-000000000120', 1,
  clock_timestamp(), 'critical_operation'
);
select ok(
  (
    select validation_reason = 'auth_error'
      and pause_observed_at is not null
      and pause_error_code = 'GRAPH_AUTH_ERROR'
    from public.whatsapp_business_token_validation_jobs
    where account_id = '97000000-0000-4000-8000-000000000120'
  ),
  'concurrent critical scheduling cannot erase a stronger auth-error checkpoint'
);
select ok(
  (
    select business_access_token = 'opaque-current-account-token'
      and business_token_status = 'unknown'
    from public.resolve_whatsapp_account_credentials(
      'token_validation',
      '97000000-0000-4000-8000-000000000120', null, null, null, 1
    )
  ),
  'token_validation can read a retained unknown token to break auth-error circularity'
);
select throws_ok(
  $$select * from public.resolve_whatsapp_account_credentials(
    'media', '97000000-0000-4000-8000-000000000120',
    null, null, null, 1
  )$$,
  '55000',
  'WHATSAPP_BUSINESS_CREDENTIAL_NOT_VALIDATED',
  'normal Graph work is blocked while token validation is unknown'
);
update public.whatsapp_business_token_validation_jobs
set available_at = clock_timestamp() + interval '1 day'
where account_id <> '97000000-0000-4000-8000-000000000120';
select id::text as id, lease_token::text as lease
from public.claim_whatsapp_business_token_validation_jobs(1)
\gset current_validation_
select is(
  public.complete_whatsapp_business_token_validation_job(
    :'current_validation_id'::uuid, :'current_validation_lease'::uuid,
    true, '123456789012345',
    array['whatsapp_business_management','whatsapp_business_messaging'],
    '[{"scope":"whatsapp_business_management","target_ids":["945678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["945678901234567"]}]'::jsonb,
    array['945678901234567'], clock_timestamp() + interval '60 days',
    clock_timestamp() + interval '60 days', clock_timestamp(), null
  ),
  'rescheduled',
  'periodic validation completes under its lease and schedules the next check'
);
select ok(
  (
    select business_token_status = 'active'
      and business_token_validation_status = 'valid'
      and business_token_is_valid and not attention_required
    from public.whatsapp_coexistence_accounts
    where id = '97000000-0000-4000-8000-000000000120'
  )
    and exists (
      select 1 from public.whatsapp_business_token_validations
      where account_id = '97000000-0000-4000-8000-000000000120'
        and validation_reason = 'auth_error'
        and is_valid and authorization_valid
    )
    and (
      select status = 'pending' and attempts = 0
        and available_at > clock_timestamp()
      from public.whatsapp_business_token_validation_jobs
      where account_id = '97000000-0000-4000-8000-000000000120'
    ),
  'successful auth-error revalidation refreshes metadata and releases only its causal pause'
);
update public.whatsapp_coexistence_accounts
set business_token_data_access_expires_at = clock_timestamp() - interval '1 second'
where id = '97000000-0000-4000-8000-000000000120';
select ok(
  (public.whatsapp_embedded_signup_status(
    '97000000-0000-4000-8000-000000000003', 'primary-scope'
  ) #>> '{account,connected}')::boolean = false
    and (public.whatsapp_embedded_signup_status(
      '97000000-0000-4000-8000-000000000003', 'primary-scope'
    ) #>> '{account,tokenConfigured}')::boolean = false
    and (public.whatsapp_embedded_signup_status(
      '97000000-0000-4000-8000-000000000003', 'primary-scope'
    ) #>> '{account,attentionRequired}')::boolean
    and (public.whatsapp_embedded_signup_status(
      '97000000-0000-4000-8000-000000000003', 'primary-scope'
    ) #>> '{account,attentionReason}') = 'TOKEN_DATA_ACCESS_EXPIRED'
    and (public.whatsapp_embedded_signup_status(
      '97000000-0000-4000-8000-000000000003', 'primary-scope'
    ) #>> '{account,tokenExpired}')::boolean,
  'data-access expiry is treated as a token expiry in connected/admin status'
);
update public.whatsapp_coexistence_accounts
set business_token_data_access_expires_at = clock_timestamp() + interval '60 days'
where id = '97000000-0000-4000-8000-000000000120';

select sending_paused::text as paused, updated_at::text as updated_at
from public.whatsapp_settings where id
\gset critical_settings_
update public.whatsapp_coexistence_accounts
set business_token_last_validated_at = clock_timestamp() - interval '2 days',
    business_token_validation_due_at = clock_timestamp() - interval '1 hour'
where id = '97000000-0000-4000-8000-000000000120';
select count(*)::text as ledger_count
from public.whatsapp_business_token_validations
where account_id = '97000000-0000-4000-8000-000000000120'
  and validation_reason = 'critical_operation'
\gset critical_before_
select is(
  (
    select count(*)::integer
    from public.resolve_whatsapp_account_credentials(
      'management', '97000000-0000-4000-8000-000000000120',
      null, null, null, 1
    )
  ),
  0,
  'uncertain critical operation fails closed while scheduling real validation'
);
select ok(
  (
    select validation_reason = 'critical_operation'
      and status = 'pending' and pause_observed_at is null
    from public.whatsapp_business_token_validation_jobs
    where account_id = '97000000-0000-4000-8000-000000000120'
  )
    and (select count(*)::text
      from public.whatsapp_business_token_validations
      where account_id = '97000000-0000-4000-8000-000000000120'
        and validation_reason = 'critical_operation')
      = :'critical_before_ledger_count',
  'critical scheduling does not fabricate a debug_token ledger entry'
);
select id::text as id, lease_token::text as lease
from public.claim_whatsapp_business_token_validation_jobs(1)
\gset critical_first_
select is(
  public.fail_whatsapp_business_token_validation_job(
    :'critical_first_id'::uuid, :'critical_first_lease'::uuid,
    'CRITICAL_GRAPH_UNAVAILABLE', true
  ),
  'retrying',
  'retryable critical validation error records a causal account pause'
);
update public.whatsapp_business_token_validation_jobs
set available_at = clock_timestamp()
where id = :'critical_first_id'::uuid;
select id::text as id, lease_token::text as lease
from public.claim_whatsapp_business_token_validation_jobs(1)
\gset critical_retry_
select is(
  public.complete_whatsapp_business_token_validation_job(
    :'critical_retry_id'::uuid, :'critical_retry_lease'::uuid,
    true, '123456789012345',
    array['whatsapp_business_management','whatsapp_business_messaging'],
    '[{"scope":"whatsapp_business_management","target_ids":["945678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["945678901234567"]}]'::jsonb,
    array['945678901234567'], clock_timestamp() + interval '60 days',
    clock_timestamp() + interval '60 days', clock_timestamp(), null
  ),
  'rescheduled',
  'real retry validation succeeds under the original causal job'
);
select ok(
  (
    select coexistence_status = 'active'
      and business_token_status = 'active'
      and business_token_validation_status = 'valid'
      and not attention_required
    from public.whatsapp_coexistence_accounts
    where id = '97000000-0000-4000-8000-000000000120'
  )
    and exists (
      select 1 from public.whatsapp_business_token_validations
      where account_id = '97000000-0000-4000-8000-000000000120'
        and validation_reason = 'critical_operation'
        and is_valid and authorization_valid
    )
    and (
      select sending_paused::text = :'critical_settings_paused'
        and updated_at = :'critical_settings_updated_at'::timestamptz
      from public.whatsapp_settings where id
    ),
  'critical retry success releases only its exact pause and never global sending pause'
);
update public.whatsapp_coexistence_accounts
set metadata = metadata || '{"late_old_event":true}'::jsonb
where id = :'primary_account_account_id'::uuid;
select is(
  public.whatsapp_embedded_signup_status(
    '97000000-0000-4000-8000-000000000003', 'primary-scope'
  ) #>> '{account,accountId}',
  '97000000-0000-4000-8000-000000000120',
  'late update on an old offboarded account cannot hijack status selection'
);

-- A lifecycle event arriving between a retry claim and its debug_token result
-- is the causal winner; the old lease can never reactivate the account.
update public.whatsapp_coexistence_accounts
set business_token_last_validated_at = clock_timestamp() - interval '2 days',
    business_token_validation_due_at = clock_timestamp() - interval '1 hour'
where id = '97000000-0000-4000-8000-000000000120';
select count(*)
from public.resolve_whatsapp_account_credentials(
  'management', '97000000-0000-4000-8000-000000000120',
  null, null, null, 1
);
select id::text as id, lease_token::text as lease
from public.claim_whatsapp_business_token_validation_jobs(1)
\gset interleaved_first_
select is(
  public.fail_whatsapp_business_token_validation_job(
    :'interleaved_first_id'::uuid, :'interleaved_first_lease'::uuid,
    'INTERLEAVED_GRAPH_RETRY', true
  ),
  'retrying',
  'interleaved lifecycle fixture first records a retryable causal pause'
);
update public.whatsapp_business_token_validation_jobs
set available_at = clock_timestamp()
where id = :'interleaved_first_id'::uuid;
select id::text as id, lease_token::text as lease
from public.claim_whatsapp_business_token_validation_jobs(1)
\gset interleaved_retry_
select clock_timestamp()::text as event_at
\gset interleaved_offboard_
select count(*) from public.apply_whatsapp_coexistence_account_update(
  '945678901234567', 'ACCOUNT_OFFBOARDED',
  :'interleaved_offboard_event_at'::timestamptz,
  '945678901234569', null, null
);
select is(
  public.complete_whatsapp_business_token_validation_job(
    :'interleaved_retry_id'::uuid, :'interleaved_retry_lease'::uuid,
    true, '123456789012345',
    array['whatsapp_business_management','whatsapp_business_messaging'],
    '[{"scope":"whatsapp_business_management","target_ids":["945678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["945678901234567"]}]'::jsonb,
    array['945678901234567'], clock_timestamp() + interval '60 days',
    clock_timestamp() + interval '60 days', clock_timestamp(), null
  ),
  'stale',
  'offboarding cancels the in-flight validation lease before its success can apply'
);
select ok(
  (
    select coexistence_status = 'disconnected'
      and attention_required
      and last_account_update_event = 'ACCOUNT_OFFBOARDED'
    from public.whatsapp_coexistence_accounts
    where id = '97000000-0000-4000-8000-000000000120'
  )
    and (
      select status = 'cancelled'
      from public.whatsapp_business_token_validation_jobs
      where account_id = '97000000-0000-4000-8000-000000000120'
    ),
  'later offboarding remains authoritative and no validation retry reactivates the account'
);

select vault.create_secret(
  'opaque-metadata-mismatch-token',
  'whatsapp_business_access_token_97000000-0000-4000-8000-000000000150',
  'pgTAP raw validation ledger fixture'
)::text as secret_id
\gset mismatch_token_
insert into public.whatsapp_coexistence_accounts (
  id, client_scope, waba_id, phone_number_id, coexistence_status,
  business_portfolio_id, business_token_secret_id, business_token_generation,
  business_token_status, business_token_is_valid, business_token_app_id,
  business_token_scopes, business_token_granular_scopes,
  business_token_target_ids, business_token_expires_at,
  business_token_data_access_expires_at, business_token_last_validated_at,
  business_token_validation_due_at, business_token_validation_status,
  onboarding_status, onboarding_completed_at, initial_sync_deadline_at,
  history_sharing_decision, app_subscription_status, app_subscribed_at,
  last_onboarding_attempt_id
) values (
  '97000000-0000-4000-8000-000000000150', 'ledger-mismatch',
  '955678901234567', '955678901234568', 'active', '955678901234569',
  :'mismatch_token_secret_id'::uuid, 1, 'active', true, '123456789012345',
  array['whatsapp_business_management','whatsapp_business_messaging'],
  '[{"scope":"whatsapp_business_management","target_ids":["955678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["955678901234567"]}]'::jsonb,
  array['955678901234567'], clock_timestamp() + interval '60 days',
  clock_timestamp() + interval '60 days', clock_timestamp() - interval '1 hour',
  clock_timestamp(), 'valid', 'completed',
  transaction_timestamp() - interval '1 hour',
  transaction_timestamp() + interval '23 hours', 'declined', 'subscribed',
  transaction_timestamp() - interval '1 hour', :'declined_attempt_id'::uuid
);
select public.schedule_whatsapp_business_token_validation(
  '97000000-0000-4000-8000-000000000150', 1,
  clock_timestamp(), 'critical_operation'
);
select id::text as id, lease_token::text as lease
from public.claim_whatsapp_business_token_validation_jobs(1)
\gset mismatch_validation_
select is(
  public.complete_whatsapp_business_token_validation_job(
    :'mismatch_validation_id'::uuid, :'mismatch_validation_lease'::uuid,
    true, '123456789012345',
    array['whatsapp_business_management','whatsapp_business_messaging'],
    '[{"scope":"whatsapp_business_management","target_ids":["955678901234599"]},{"scope":"whatsapp_business_messaging","target_ids":["955678901234599"]}]'::jsonb,
    array['955678901234599'], clock_timestamp() + interval '60 days',
    clock_timestamp() + interval '60 days', clock_timestamp(), null
  ),
  'invalid',
  'locally unauthorized raw-valid debug_token result fails the account closed'
);
select ok(
  (
    select business_token_status = 'invalid'
      and business_token_validation_status = 'invalid'
      and business_token_is_valid = false
      and coexistence_status = 'paused' and attention_required
    from public.whatsapp_coexistence_accounts
    where id = '97000000-0000-4000-8000-000000000150'
  )
    and exists (
      select 1 from public.whatsapp_business_token_validations
      where account_id = '97000000-0000-4000-8000-000000000150'
        and validation_reason = 'critical_operation'
        and is_valid and not authorization_valid
        and error_code = 'TOKEN_METADATA_MISMATCH'
    ),
  'periodic ledger preserves Meta is_valid=true separately from local authorization rejection'
);

-- Durable validation recovery and terminal token cleanup.
select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000004', 'validation-recovery',
  repeat('5', 64), repeat('6', 64), '123456789012345',
  '234567890123456', 'declined', clock_timestamp() + interval '10 minutes'
)
\gset recovery_
select clock_timestamp()::text as received_at
\gset recovery_callback_
select public.record_whatsapp_embedded_signup_session(
  :'recovery_attempt_id'::uuid,
  '97000000-0000-4000-8000-000000000004',
  repeat('5', 64), repeat('6', 64), repeat('7', 64),
  :'recovery_callback_received_at'::timestamptz,
  null, '445678901234567', null, '{}'::jsonb, 'declined'
);
select * from public.claim_whatsapp_embedded_signup_code(
  :'recovery_attempt_id'::uuid,
  '97000000-0000-4000-8000-000000000004',
  repeat('5', 64), repeat('6', 64), repeat('8', 64)
);
select public.store_whatsapp_embedded_signup_exchange_token(
  :'recovery_attempt_id'::uuid, repeat('8', 64), 'opaque-recovery-token'
);
select public.record_whatsapp_embedded_signup_post_exchange_validation(
  :'recovery_attempt_id'::uuid, true, '123456789012345',
  array['whatsapp_business_management','whatsapp_business_messaging'],
  '[{"scope":"whatsapp_business_management","target_ids":["445678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["445678901234567"]}]'::jsonb,
  array['445678901234567'], null, null,
  clock_timestamp() - interval '1 second'
);
select * from public.claim_whatsapp_embedded_signup_validations(
  1, :'recovery_attempt_id'::uuid
)
\gset recovery_validation_
update public.whatsapp_embedded_signup_attempts
set validation_processing_started_at = clock_timestamp() - interval '4 minutes',
    validation_lease_expires_at = clock_timestamp() - interval '1 minute'
where id = :'recovery_attempt_id'::uuid;
select * from public.claim_whatsapp_embedded_signup_validations(
  1, :'recovery_attempt_id'::uuid
)
\gset recovery_validation_retry_

select ok(
  :'recovery_validation_retry_validation_attempts'::integer = 2
    and :'recovery_validation_retry_validation_lease_token'::uuid
      <> :'recovery_validation_validation_lease_token'::uuid,
  'stale validation lease is recovered with a fresh lease and attempt count'
);

select is(
  public.fail_whatsapp_embedded_signup_validation(
    :'recovery_attempt_id'::uuid,
    :'recovery_validation_retry_validation_lease_token'::uuid,
    'GRAPH_ASSET_MISMATCH', false
  ),
  'failed',
  'definitive validation failure is terminal'
);

select ok(
  (
    select status = 'failed' and temporary_token_secret_id is null
    from public.whatsapp_embedded_signup_attempts
    where id = :'recovery_attempt_id'::uuid
  )
    and (
      select count(*) = 0 from vault.secrets
      where name = 'whatsapp_embedded_signup_token_' || :'recovery_attempt_id'
    ),
  'definitive validation failure deletes its temporary Vault token'
);
select ok(
  public.record_whatsapp_embedded_signup_session(
    :'recovery_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000004',
    repeat('5', 64), repeat('6', 64), repeat('7', 64),
    :'recovery_callback_received_at'::timestamptz,
    null, '445678901234567', null, '{}'::jsonb, 'declined'
  )
    and (
      select status = 'failed'
      from public.whatsapp_embedded_signup_attempts
      where id = :'recovery_attempt_id'::uuid
    ),
  'exact FINISH replay acknowledges failed without changing terminal state'
);

-- Recovery processor path expires abandoned validating sessions and tokens.
select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000004', 'cleanup-recovery',
  repeat('9', 64), repeat('a', 64), '123456789012345',
  '234567890123456', 'declined', clock_timestamp() + interval '10 minutes'
)
\gset cleanup_
select clock_timestamp()::text as received_at
\gset cleanup_callback_
select public.record_whatsapp_embedded_signup_session(
  :'cleanup_attempt_id'::uuid,
  '97000000-0000-4000-8000-000000000004',
  repeat('9', 64), repeat('a', 64), repeat('b', 64),
  :'cleanup_callback_received_at'::timestamptz,
  null, '545678901234567', null, '{}'::jsonb, 'declined'
);
select * from public.claim_whatsapp_embedded_signup_code(
  :'cleanup_attempt_id'::uuid,
  '97000000-0000-4000-8000-000000000004',
  repeat('9', 64), repeat('a', 64), repeat('c', 64)
);
select public.store_whatsapp_embedded_signup_exchange_token(
  :'cleanup_attempt_id'::uuid, repeat('c', 64), 'opaque-cleanup-token'
);
update public.whatsapp_embedded_signup_attempts
set validation_deadline_at = clock_timestamp() - interval '1 second'
where id = :'cleanup_attempt_id'::uuid;
select count(*) from public.claim_whatsapp_onboarding_jobs(1);

select ok(
  (
    select status = 'expired' and temporary_token_secret_id is null
    from public.whatsapp_embedded_signup_attempts
    where id = :'cleanup_attempt_id'::uuid
  )
    and (
      select count(*) = 0 from vault.secrets
      where name = 'whatsapp_embedded_signup_token_' || :'cleanup_attempt_id'
    ),
  'existing recovery claim path cleans abandoned temporary Vault tokens'
);
select ok(
  public.record_whatsapp_embedded_signup_session(
    :'cleanup_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000004',
    repeat('9', 64), repeat('a', 64), repeat('b', 64),
    :'cleanup_callback_received_at'::timestamptz,
    null, '545678901234567', null, '{}'::jsonb, 'declined'
  )
    and (
      select status = 'expired'
      from public.whatsapp_embedded_signup_attempts
      where id = :'cleanup_attempt_id'::uuid
    ),
  'exact FINISH replay acknowledges expired without changing terminal state'
);

-- Cancel after reload needs only attempt/admin, and it must clean token state.
select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000004', 'cancel-token',
  repeat('d', 64), repeat('e', 64), '123456789012345',
  '234567890123456', 'declined', clock_timestamp() + interval '10 minutes'
)
\gset cancel_
select * from public.claim_whatsapp_embedded_signup_code(
  :'cancel_attempt_id'::uuid,
  '97000000-0000-4000-8000-000000000004',
  repeat('d', 64), repeat('e', 64), repeat('0', 64)
);
select public.store_whatsapp_embedded_signup_exchange_token(
  :'cancel_attempt_id'::uuid, repeat('0', 64), 'opaque-cancel-token'
);
update public.whatsapp_embedded_signup_attempts
set created_at = clock_timestamp() - interval '10 minutes',
    expires_at = clock_timestamp() - interval '1 second'
where id = :'cancel_attempt_id'::uuid;
select throws_ok(
  format(
    $$select * from public.claim_whatsapp_embedded_signup_code(
      %L::uuid, '97000000-0000-4000-8000-000000000004', %L, %L, %L)$$,
    :'cancel_attempt_id', repeat('d', 64), repeat('e', 64), repeat('0', 64)
  ),
  '55000',
  'WHATSAPP_EMBEDDED_SIGNUP_CODE_REPLAY',
  'late code replay cannot reinterpret START expiry as token expiry'
);
select ok(
  (
    select status = 'token_stored' and temporary_token_secret_id is not null
    from public.whatsapp_embedded_signup_attempts
    where id = :'cancel_attempt_id'::uuid
  )
    and (
      select count(*) = 1
      from vault.secrets
      where name = 'whatsapp_embedded_signup_token_' || :'cancel_attempt_id'
    ),
  'token_stored survives START-TTL replay and remains owned by validation cleanup'
);
select ok(
  public.cancel_whatsapp_embedded_signup_attempt(
    :'cancel_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000004', 'USER_CANCELLED'
  ),
  'USER_CANCELLED closes an active attempt after reload'
);
select ok(
  not public.cancel_whatsapp_embedded_signup_attempt(
    :'cancel_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000004', 'USER_CANCELLED'
  ),
  'USER_CANCELLED replay is idempotently rejected'
);
select ok(
  (
    select status = 'cancelled' and temporary_token_secret_id is null
    from public.whatsapp_embedded_signup_attempts
    where id = :'cancel_attempt_id'::uuid
  ),
  'USER_CANCELLED removes its temporary Vault reference'
);
select is(
  public.record_whatsapp_embedded_signup_session(
    :'cancel_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000004',
    repeat('d', 64), repeat('e', 64), repeat('1', 64),
    clock_timestamp(), null, '645678901234568', null, '{}'::jsonb,
    'declined'
  ),
  false,
  'FINISH received after cancellation is rejected without mutation'
);
select is(
  (select status from public.whatsapp_embedded_signup_attempts
   where id = :'cancel_attempt_id'::uuid),
  'cancelled',
  'cancelled remains immutable after a late FINISH'
);

-- The fixed burst guard remains 3/15m and is scoped to ADMIN + client.
insert into public.whatsapp_embedded_signup_attempts (
  client_scope, initiated_by, status, state_hash, nonce_hash, app_id,
  configuration_id, history_sharing_decision, expires_at, created_at, updated_at
)
select
  'burst-rate-limit',
  '97000000-0000-4000-8000-000000000015'::uuid,
  'cancelled',
  lpad(to_hex(150000 + value), 64, '0'),
  lpad(to_hex(160000 + value), 64, '0'),
  '123456789012345', '234567890123456', 'declined',
  created_at_value + interval '10 minutes',
  created_at_value,
  created_at_value
from generate_series(1, 3) value
cross join lateral (
  select clock_timestamp() - interval '5 minutes'
    - value * interval '1 second' as created_at_value
) fixture;

select is(
  (
    select status
    from public.create_whatsapp_embedded_signup_attempt(
      '97000000-0000-4000-8000-000000000015', 'burst-rate-limit',
      lpad(to_hex(159999), 64, '0'), lpad(to_hex(169999), 64, '0'),
      '123456789012345', '234567890123456', 'declined',
      clock_timestamp() + interval '10 minutes', 25
    )
  ),
  'rate_limited',
  'three attempts in fifteen minutes still reject the next START with daily max 25'
);
select is(
  (
    select count(*)::integer
    from public.whatsapp_embedded_signup_attempts
    where initiated_by = '97000000-0000-4000-8000-000000000015'
      and client_scope = 'burst-rate-limit'
  ),
  3,
  'a burst-rate rejection does not create or count another attempt'
);

-- Daily fixtures deliberately mix terminal states: every persisted START
-- counts, while the rejected request itself never enters the attempts table.
insert into public.whatsapp_embedded_signup_attempts (
  client_scope, initiated_by, status, state_hash, nonce_hash, app_id,
  configuration_id, history_sharing_decision, expires_at, created_at, updated_at
)
select
  'daily-rate-limit',
  '97000000-0000-4000-8000-000000000013'::uuid,
  case value % 3
    when 0 then 'expired'
    when 1 then 'cancelled'
    else 'failed'
  end,
  lpad(to_hex(130000 + value), 64, '0'),
  lpad(to_hex(140000 + value), 64, '0'),
  '123456789012345', '234567890123456', 'declined',
  created_at_value + interval '10 minutes',
  created_at_value,
  created_at_value
from generate_series(1, 10) value
cross join lateral (
  select clock_timestamp() - interval '2 hours'
    - value * interval '1 minute' as created_at_value
) fixture;

select is(
  public.whatsapp_embedded_signup_rate_limit_eligible(
    '97000000-0000-4000-8000-000000000013', 'daily-rate-limit'
  ),
  false,
  'the server-only safe read reports default-limit ineligibility without START'
);
select is(
  public.whatsapp_embedded_signup_rate_limit_eligible(
    '97000000-0000-4000-8000-000000000013', 'daily-rate-limit', 25
  ),
  true,
  'the same safe read reports eligibility with configured limit 25'
);
select ok(
  not public.whatsapp_embedded_signup_rate_limit_eligible(
    '97000000-0000-4000-8000-000000000013', 'daily-rate-limit', 1
  )
    and public.whatsapp_embedded_signup_rate_limit_eligible(
      '97000000-0000-4000-8000-000000000013', 'daily-rate-limit', 500
    )
    and not exists (
      select 1
      from public.audit_logs
      where actor_user_id = '97000000-0000-4000-8000-000000000013'
        and action = 'whatsapp.embedded_signup.rate_limited'
        and metadata ->> 'client_scope' = 'daily-rate-limit'
    ),
  'SQL clamps 1/500 to 5/50 and the eligibility read writes no audit row'
);

update public.whatsapp_settings
set sending_paused = false,
    sending_pause_reason = null
where id = true;

select is(
  (
    select status
    from public.create_whatsapp_embedded_signup_attempt(
      '97000000-0000-4000-8000-000000000013', 'daily-rate-limit',
      lpad(to_hex(139999), 64, '0'), lpad(to_hex(149999), 64, '0'),
      '123456789012345', '234567890123456', 'declined',
      clock_timestamp() + interval '10 minutes'
    )
  ),
  'rate_limited',
  'ten persisted attempts with the default daily limit 10 reject the next START'
);
select is(
  (
    select status
    from public.create_whatsapp_embedded_signup_attempt(
      '97000000-0000-4000-8000-000000000013', 'daily-rate-limit',
      lpad(to_hex(139998), 64, '0'), lpad(to_hex(149998), 64, '0'),
      '123456789012345', '234567890123456', 'declined',
      clock_timestamp() + interval '10 minutes'
    )
  ),
  'rate_limited',
  'a duplicate rejection remains idempotently rate-limited'
);
select ok(
  (
    select count(*) = 10
    from public.whatsapp_embedded_signup_attempts
    where initiated_by = '97000000-0000-4000-8000-000000000013'
      and client_scope = 'daily-rate-limit'
  ) and (
    select count(*) = 1
    from public.audit_logs
    where actor_user_id = '97000000-0000-4000-8000-000000000013'
      and action = 'whatsapp.embedded_signup.rate_limited'
      and metadata @> '{"client_scope":"daily-rate-limit","daily_limit_reached":true}'::jsonb
      and not metadata ? 'max_attempts_24h'
  ) and (
    select not sending_paused and sending_pause_reason is null
    from public.whatsapp_settings
    where id = true
  ),
  'rejections preserve attempts/settings and deduplicate their audit event'
);

select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000013', 'daily-rate-limit',
  lpad(to_hex(131000), 64, '0'), lpad(to_hex(141000), 64, '0'),
  '123456789012345', '234567890123456', 'declined',
  clock_timestamp() + interval '10 minutes', 25
)
\gset daily_25_
select is(
  :'daily_25_status'::text,
  'initiated'::text,
  'ten persisted attempts with configured daily limit 25 allow the next START'
);
select ok(
  public.cancel_whatsapp_embedded_signup_attempt(
    :'daily_25_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000013',
    'USER_CANCELLED'
  ),
  'the configurable-limit fixture is closed before isolation checks'
);

select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000014', 'daily-rate-limit',
  lpad(to_hex(142000), 64, '0'), lpad(to_hex(143000), 64, '0'),
  '123456789012345', '234567890123456', 'declined',
  clock_timestamp() + interval '10 minutes', 10
)
\gset other_user_
select is(
  :'other_user_status'::text,
  'initiated'::text,
  'attempts from ADMIN A do not consume ADMIN B quota in the same client scope'
);
select ok(
  public.cancel_whatsapp_embedded_signup_attempt(
    :'other_user_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000014',
    'USER_CANCELLED'
  ),
  'the second-user isolation fixture is closed'
);

select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000013', 'daily-rate-other',
  lpad(to_hex(144000), 64, '0'), lpad(to_hex(145000), 64, '0'),
  '123456789012345', '234567890123456', 'declined',
  clock_timestamp() + interval '10 minutes', 10
)
\gset other_scope_
select is(
  :'other_scope_status'::text,
  'initiated'::text,
  'attempts from client scope A do not consume the same ADMIN quota in scope B'
);
select ok(
  public.cancel_whatsapp_embedded_signup_attempt(
    :'other_scope_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000013',
    'USER_CANCELLED'
  ),
  'the second-client isolation fixture is closed'
);

select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000005', 'meta-cancel',
  repeat('2', 64), repeat('3', 64), '123456789012345',
  '234567890123456', 'declined', clock_timestamp() + interval '10 minutes'
)
\gset meta_cancel_
select ok(
  public.cancel_whatsapp_embedded_signup_attempt(
    :'meta_cancel_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000005', 'META_CANCELLED'
  ),
  'META_CANCELLED is accepted'
);
select is(
  (select status from public.whatsapp_embedded_signup_attempts
    where id = :'meta_cancel_attempt_id'::uuid),
  'cancelled',
  'META_CANCELLED records a terminal cancellation'
);

select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000006', 'meta-error',
  repeat('4', 64), repeat('5', 64), '123456789012345',
  '234567890123456', 'declined', clock_timestamp() + interval '10 minutes'
)
\gset meta_error_
select ok(
  public.cancel_whatsapp_embedded_signup_attempt(
    :'meta_error_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000006', 'META_ERROR'
  ),
  'META_ERROR is accepted'
);
select is(
  (select status from public.whatsapp_embedded_signup_attempts
    where id = :'meta_error_attempt_id'::uuid),
  'failed',
  'META_ERROR records a terminal failed attempt'
);

-- Meta can report is_valid=true while the local app/scope/asset trust
-- boundary rejects the token. Preserve that raw evidence, but fail closed
-- and remove the temporary credential.
select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000007', 'post-exchange-rejected',
  repeat('6', 63) || 'a', repeat('7', 63) || 'a', '123456789012345',
  '234567890123456', 'declined', clock_timestamp() + interval '10 minutes'
)
\gset post_rejected_
select * from public.claim_whatsapp_embedded_signup_code(
  :'post_rejected_attempt_id'::uuid,
  '97000000-0000-4000-8000-000000000007',
  repeat('6', 63) || 'a', repeat('7', 63) || 'a', repeat('8', 63) || 'a'
);
select public.store_whatsapp_embedded_signup_exchange_token(
  :'post_rejected_attempt_id'::uuid, repeat('8', 63) || 'a',
  'opaque-post-rejected-token'
);
select (clock_timestamp() - interval '1 second')::text as validated_at
\gset post_rejected_validation_
select ok(
  public.record_whatsapp_embedded_signup_post_exchange_validation(
    :'post_rejected_attempt_id'::uuid, true, '123456789012345',
    array['whatsapp_business_management'],
    '[{"scope":"whatsapp_business_management","target_ids":["645678901234567"]}]'::jsonb,
    array['645678901234567'], null, null,
    :'post_rejected_validation_validated_at'::timestamptz,
    'POST_EXCHANGE_SCOPE_MISSING'
  ),
  'rejected debug_token evidence is durably acknowledged without claiming acceptance'
);
select ok(
  (
    select status = 'failed'
      and post_exchange_token_is_valid
      and post_exchange_token_app_id = '123456789012345'
      and post_exchange_token_scopes
        = array['whatsapp_business_management']
      and post_exchange_token_target_ids = array['645678901234567']
      and post_exchange_token_error_code = 'POST_EXCHANGE_SCOPE_MISSING'
      and temporary_token_secret_id is null
    from public.whatsapp_embedded_signup_attempts
    where id = :'post_rejected_attempt_id'::uuid
  )
    and not exists (
      select 1 from vault.secrets
      where name = 'whatsapp_embedded_signup_token_'
        || :'post_rejected_attempt_id'
    )
    and exists (
      select 1 from public.audit_logs
      where action = 'whatsapp.embedded_signup.post_exchange_rejected'
        and entity_id = :'post_rejected_attempt_id'::uuid
        and metadata @> '{"is_valid":true,"error_code":"POST_EXCHANGE_SCOPE_MISSING"}'::jsonb
    )
    and exists (
      select 1 from public.whatsapp_business_token_validations
      where onboarding_attempt_id = :'post_rejected_attempt_id'::uuid
        and account_id is null and token_generation is null
        and validation_reason = 'post_exchange'
        and checkpoint_attempt = 0
        and is_valid and not authorization_valid
        and error_code = 'POST_EXCHANGE_SCOPE_MISSING'
    ),
  'local scope rejection retains raw Meta metadata and deletes the temporary token'
);
select ok(
  public.record_whatsapp_embedded_signup_post_exchange_validation(
    :'post_rejected_attempt_id'::uuid, true, '123456789012345',
    array['whatsapp_business_management'],
    '[{"scope":"whatsapp_business_management","target_ids":["645678901234567"]}]'::jsonb,
    array['645678901234567'], null, null,
    :'post_rejected_validation_validated_at'::timestamptz,
    'POST_EXCHANGE_SCOPE_MISSING'
  ),
  'an exact rejected post-exchange checkpoint replay is idempotent'
);

select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000008', 'pre-completion-rejected',
  repeat('a', 63) || '1', repeat('b', 63) || '1', '123456789012345',
  '234567890123456', 'declined', clock_timestamp() + interval '10 minutes'
)
\gset pre_rejected_
select clock_timestamp()::text as received_at
\gset pre_rejected_callback_
select public.record_whatsapp_embedded_signup_session(
  :'pre_rejected_attempt_id'::uuid,
  '97000000-0000-4000-8000-000000000008',
  repeat('a', 63) || '1', repeat('b', 63) || '1', repeat('c', 63) || '1',
  :'pre_rejected_callback_received_at'::timestamptz,
  null, '745678901234567', null,
  '{"waba_ids":["745678901234567"]}'::jsonb, 'declined'
);
select * from public.claim_whatsapp_embedded_signup_code(
  :'pre_rejected_attempt_id'::uuid,
  '97000000-0000-4000-8000-000000000008',
  repeat('a', 63) || '1', repeat('b', 63) || '1', repeat('d', 63) || '1'
);
select public.store_whatsapp_embedded_signup_exchange_token(
  :'pre_rejected_attempt_id'::uuid, repeat('d', 63) || '1',
  'opaque-pre-rejected-token'
);
select public.record_whatsapp_embedded_signup_post_exchange_validation(
  :'pre_rejected_attempt_id'::uuid, true, '123456789012345',
  array['whatsapp_business_management','whatsapp_business_messaging'],
  '[{"scope":"whatsapp_business_management","target_ids":["745678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["745678901234567"]}]'::jsonb,
  array['745678901234567'], null, null,
  clock_timestamp() - interval '1 second'
);
select * from public.claim_whatsapp_embedded_signup_validations(
  1, :'pre_rejected_attempt_id'::uuid
)
\gset pre_rejected_validation_
select (clock_timestamp() + interval '60 days')::text as expires_at,
  clock_timestamp()::text as validated_at
\gset pre_rejected_debug_
select ok(
  public.record_whatsapp_embedded_signup_pre_completion_validation(
    :'pre_rejected_attempt_id'::uuid,
    :'pre_rejected_validation_validation_lease_token'::uuid,
    true, '123456789012345',
    array['whatsapp_business_management','whatsapp_business_messaging'],
    '[{"scope":"whatsapp_business_management","target_ids":["755678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["755678901234567"]}]'::jsonb,
    array['755678901234567'],
    :'pre_rejected_debug_expires_at'::timestamptz, null,
    :'pre_rejected_debug_validated_at'::timestamptz
  ),
  'pre-completion raw debug metadata is acknowledged even when local WABA authorization rejects it'
);
select ok(
  (
    select status = 'failed'
      and pre_completion_token_is_valid
      and pre_completion_token_target_ids = array['755678901234567']
      and pre_completion_token_error_code = 'PRE_COMPLETION_ASSET_MISMATCH'
      and temporary_token_secret_id is null
    from public.whatsapp_embedded_signup_attempts
    where id = :'pre_rejected_attempt_id'::uuid
  )
    and exists (
      select 1 from public.whatsapp_business_token_validations
      where onboarding_attempt_id = :'pre_rejected_attempt_id'::uuid
        and validation_reason = 'pre_completion'
        and checkpoint_attempt = 1
        and is_valid and not authorization_valid
        and error_code = 'PRE_COMPLETION_ASSET_MISMATCH'
        and account_id is null and token_generation is null
    )
    and not exists (
      select 1 from vault.secrets
      where name = 'whatsapp_embedded_signup_token_'
        || :'pre_rejected_attempt_id'
    ),
  'pre-completion WABA rejection retains raw evidence and deletes the temporary token'
);

-- Account lifecycle pauses must close durable automation executions as well
-- as their dispatch rows. This fixture includes an historical message whose
-- account column is NULL while its conversation is already account-bound.
insert into public.whatsapp_coexistence_accounts (
  id, client_scope, waba_id, phone_number_id, coexistence_status,
  onboarding_status, history_sharing_decision, app_subscription_status,
  app_subscribed_at
) values
  (
    '97000000-0000-4000-8000-000000000200', 'execution-target',
    '970000000000200', '970000000000201', 'active', 'completed',
    'declined', 'subscribed', clock_timestamp()
  ),
  (
    '97000000-0000-4000-8000-000000000202', 'execution-sibling',
    '970000000000202', '970000000000203', 'active', 'completed',
    'declined', 'subscribed', clock_timestamp()
  );
insert into public.contacts (id, phone_e164, whatsapp_id, name) values
  (
    '97000000-0000-4000-8000-000000000210',
    '+5491100000210', '5491100000210', 'Execution live target'
  ),
  (
    '97000000-0000-4000-8000-000000000212',
    '+5491100000212', '5491100000212', 'Execution retry target'
  ),
  (
    '97000000-0000-4000-8000-000000000214',
    '+5491100000214', '5491100000214', 'Execution sibling'
  ),
  (
    '97000000-0000-4000-8000-000000000216',
    '+5491100000216', '5491100000216', 'Committed-effect target'
  );
insert into public.conversations (
  id, contact_id, status, coexistence_account_id
) values
  (
    '97000000-0000-4000-8000-000000000211',
    '97000000-0000-4000-8000-000000000210', 'open',
    '97000000-0000-4000-8000-000000000200'
  ),
  (
    '97000000-0000-4000-8000-000000000213',
    '97000000-0000-4000-8000-000000000212', 'open',
    '97000000-0000-4000-8000-000000000200'
  ),
  (
    '97000000-0000-4000-8000-000000000215',
    '97000000-0000-4000-8000-000000000214', 'open',
    '97000000-0000-4000-8000-000000000202'
  ),
  (
    '97000000-0000-4000-8000-000000000217',
    '97000000-0000-4000-8000-000000000216', 'open',
    '97000000-0000-4000-8000-000000000200'
  );
insert into public.messages (
  id, conversation_id, contact_id, direction, whatsapp_message_id,
  body, status, coexistence_account_id
) values
  (
    '97000000-0000-4000-8000-000000000220',
    '97000000-0000-4000-8000-000000000211',
    '97000000-0000-4000-8000-000000000210', 'inbound',
    'wamid.execution.target.live', 'target live', 'delivered',
    '97000000-0000-4000-8000-000000000200'
  ),
  (
    '97000000-0000-4000-8000-000000000222',
    '97000000-0000-4000-8000-000000000213',
    '97000000-0000-4000-8000-000000000212', 'inbound',
    'wamid.execution.target.retry', 'target retry', 'delivered',
    '97000000-0000-4000-8000-000000000200'
  ),
  (
    '97000000-0000-4000-8000-000000000224',
    '97000000-0000-4000-8000-000000000215',
    '97000000-0000-4000-8000-000000000214', 'inbound',
    'wamid.execution.sibling.live', 'sibling live', 'delivered',
    '97000000-0000-4000-8000-000000000202'
  ),
  (
    '97000000-0000-4000-8000-000000000226',
    '97000000-0000-4000-8000-000000000217',
    '97000000-0000-4000-8000-000000000216', 'inbound',
    'wamid.execution.committed.effect', 'committed effect', 'delivered',
    '97000000-0000-4000-8000-000000000200'
  );
select lease_token::text as lease
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000220', '{}'::jsonb, 900
)
\gset execution_live_
select lease_token::text as lease
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000222', '{}'::jsonb, 900
)
\gset execution_retry_
select lease_token::text as lease
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000224', '{}'::jsonb, 900
)
\gset execution_sibling_
select lease_token::text as lease
from public.claim_whatsapp_automation_execution(
  '97000000-0000-4000-8000-000000000226', '{}'::jsonb, 900
)
\gset execution_committed_
insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at,
  status, source
) values (
  '97000000-0000-4000-8000-000000000230',
  '97000000-0000-4000-8000-000000000216',
  '67697365-6c61-4765-8a2d-6c656e747a01',
  '51000000-0000-4000-8000-000000000001',
  '2038-01-01 10:00:00+00', '2038-01-01 10:30:00+00',
  'scheduled', 'whatsapp'
);
insert into public.whatsapp_automation_effects (
  execution_message_id, effect_key, effect_type, request, result,
  appointment_id
) values (
  '97000000-0000-4000-8000-000000000226',
  'appointment:create', 'appointment_create',
  '{"fixture":"committed-before-account-block"}'::jsonb,
  '{"id":"97000000-0000-4000-8000-000000000230","status":"scheduled"}'::jsonb,
  '97000000-0000-4000-8000-000000000230'
);
select ok(
  public.fail_whatsapp_automation_execution(
    '97000000-0000-4000-8000-000000000222',
    :'execution_retry_lease'::uuid, 'TRANSIENT_EXECUTION_FAILURE', true
  ),
  'account blocking fixture contains a retryable failed execution'
);
alter table public.messages disable trigger a_messages_bind_coexistence_account;
update public.messages
set coexistence_account_id = null
where id = '97000000-0000-4000-8000-000000000220';
alter table public.messages enable trigger a_messages_bind_coexistence_account;

select public.block_whatsapp_account_graph_work(
  '97000000-0000-4000-8000-000000000200', 'ACCOUNT_OFFBOARDED'
);
select ok(
  (
    select status = 'completed' and not retryable
      and processing_started_at is null and lease_token is null
      and completed_at is not null and failed_at is null
      and outcome @> '{"processed":false,"blocked":true,"state":"account_blocked","reason":"ACCOUNT_OFFBOARDED"}'::jsonb
    from public.whatsapp_automation_executions
    where message_id = '97000000-0000-4000-8000-000000000220'
  )
    and (
      select status = 'completed' and not retryable
        and lease_token is null and failed_at is null
        and outcome ->> 'reason' = 'ACCOUNT_OFFBOARDED'
      from public.whatsapp_automation_executions
      where message_id = '97000000-0000-4000-8000-000000000222'
    )
    and (
      select coexistence_account_id is null
      from public.messages
      where id = '97000000-0000-4000-8000-000000000220'
    ),
  'account block terminalizes processing/failed executions including legacy NULL-message routing'
);
select ok(
  (
    select status = 'completed' and not retryable
      and lease_token is null
      and outcome ->> 'state' = 'human_handoff'
      and outcome ->> 'reason' = 'ACCOUNT_BLOCKED_AFTER_COMMITTED_EFFECT'
      and outcome ->> 'appointmentId'
        = '97000000-0000-4000-8000-000000000230'
    from public.whatsapp_automation_executions
    where message_id = '97000000-0000-4000-8000-000000000226'
  )
    and (
      select automation_mode = 'manual' and needs_human
        and automation_pause_source = 'inbound_handoff'
        and automation_pause_message_id
          = '97000000-0000-4000-8000-000000000226'
      from public.conversations
      where id = '97000000-0000-4000-8000-000000000217'
        and coexistence_account_id
          = '97000000-0000-4000-8000-000000000200'
    )
    and (
      select state = 'human_handoff'
        and context ->> 'appointmentId'
          = '97000000-0000-4000-8000-000000000230'
        and context ->> 'blockReason' = 'ACCOUNT_OFFBOARDED'
        and last_automation_message_id
          = '97000000-0000-4000-8000-000000000226'
      from public.automation_sessions
      where conversation_id = '97000000-0000-4000-8000-000000000217'
    )
    and (
      select count(*) = 1
      from public.whatsapp_automation_effects
      where execution_message_id
        = '97000000-0000-4000-8000-000000000226'
        and effect_key = 'appointment:create'
        and appointment_id = '97000000-0000-4000-8000-000000000230'
    )
    and (
      select count(*) = 1
      from public.whatsapp_automation_effects
      where execution_message_id
        = '97000000-0000-4000-8000-000000000226'
        and effect_key = 'terminal:handoff'
        and effect_type = 'handoff'
    )
    and (
      select status = 'scheduled'
      from public.appointments
      where id = '97000000-0000-4000-8000-000000000230'
    ),
  'committed appointment effect is preserved exactly once with durable account-scoped handoff'
);
select ok(
  (
    select status = 'processing'
      and lease_token = :'execution_sibling_lease'::uuid
      and outcome is null
    from public.whatsapp_automation_executions
    where message_id = '97000000-0000-4000-8000-000000000224'
  )
    and (
      select automation_mode = 'auto' and not needs_human
      from public.conversations
      where id = '97000000-0000-4000-8000-000000000215'
    ),
  'account block leaves sibling execution lease and conversation unchanged'
);
select is(
  public.complete_whatsapp_automation_execution(
    '97000000-0000-4000-8000-000000000220',
    :'execution_live_lease'::uuid, '{"processed":true}'::jsonb
  ),
  false,
  'a stale worker cannot complete an account-blocked execution'
);
select throws_ok(
  format(
    $$select public.remember_whatsapp_automation_decision(
      '97000000-0000-4000-8000-000000000220', %L::uuid,
      0, 'stale_effect', 'true'::jsonb)$$,
    :'execution_live_lease'
  ),
  '55000',
  'WHATSAPP_AUTOMATION_EXECUTION_LEASE_INVALID',
  'a stale execution lease cannot append domain effects after account block'
);
select is(
  public.complete_whatsapp_automation_execution(
    '97000000-0000-4000-8000-000000000226',
    :'execution_committed_lease'::uuid, '{"processed":true}'::jsonb
  ),
  false,
  'committed-effect worker cannot overwrite the durable blocking handoff'
);
select ok(
  not exists (
    select 1 from public.whatsapp_automation_effects
    where execution_message_id in (
      '97000000-0000-4000-8000-000000000220',
      '97000000-0000-4000-8000-000000000222'
    )
  )
    and not exists (
      select 1 from public.automation_sessions
      where conversation_id in (
        '97000000-0000-4000-8000-000000000211',
        '97000000-0000-4000-8000-000000000213'
      )
    )
    and (
      select bool_and(automation_mode = 'auto' and not needs_human)
      from public.conversations
      where id in (
        '97000000-0000-4000-8000-000000000211',
        '97000000-0000-4000-8000-000000000213'
      )
    ),
  'terminalization creates no stale effects, sessions or conversation mutation'
);

-- Build a fully validated attempt without completing it. The two debug_token
-- checkpoints remain distinct and the helper never bypasses production RPCs.
create function pg_temp.prepare_lifecycle_signup(
  p_admin_id uuid,
  p_scope text,
  p_waba_id text,
  p_phone_number_id text,
  p_token text
)
returns table (
  attempt_id uuid,
  validation_lease_token uuid,
  token_expires_at timestamptz,
  data_access_expires_at timestamptz,
  token_validated_at timestamptz
)
language plpgsql
as $$
declare
  state_hash text := md5(p_scope || ':state:1')
    || md5(p_scope || ':state:2');
  nonce_hash text := md5(p_scope || ':nonce:1')
    || md5(p_scope || ':nonce:2');
  sdk_hash text := md5(p_scope || ':sdk:1')
    || md5(p_scope || ':sdk:2');
  code_hash text := md5(p_scope || ':code:1')
    || md5(p_scope || ':code:2');
  created record;
  validation_claim record;
  granular jsonb := jsonb_build_array(
    jsonb_build_object(
      'scope', 'whatsapp_business_management',
      'target_ids', jsonb_build_array(p_waba_id)
    ),
    jsonb_build_object(
      'scope', 'whatsapp_business_messaging',
      'target_ids', jsonb_build_array(p_waba_id)
    )
  );
begin
  select * into created
  from public.create_whatsapp_embedded_signup_attempt(
    p_admin_id, p_scope, state_hash, nonce_hash, '123456789012345',
    '234567890123456', 'declined', clock_timestamp() + interval '10 minutes'
  );
  perform public.record_whatsapp_embedded_signup_session(
    created.attempt_id, p_admin_id, state_hash, nonce_hash, sdk_hash,
    clock_timestamp(), '979000000000999', p_waba_id, p_phone_number_id,
    jsonb_build_object('waba_ids', jsonb_build_array(p_waba_id)),
    'declined'
  );
  perform * from public.claim_whatsapp_embedded_signup_code(
    created.attempt_id, p_admin_id, state_hash, nonce_hash, code_hash
  );
  perform public.store_whatsapp_embedded_signup_exchange_token(
    created.attempt_id, code_hash, p_token
  );
  perform public.record_whatsapp_embedded_signup_post_exchange_validation(
    created.attempt_id, true, '123456789012345',
    array['whatsapp_business_management','whatsapp_business_messaging'],
    granular, array[p_waba_id],
    clock_timestamp() + interval '60 days',
    clock_timestamp() + interval '60 days',
    clock_timestamp() - interval '1 second'
  );
  select * into validation_claim
  from public.claim_whatsapp_embedded_signup_validations(
    1, created.attempt_id
  );
  attempt_id := created.attempt_id;
  validation_lease_token := validation_claim.validation_lease_token;
  token_expires_at := clock_timestamp() + interval '60 days';
  data_access_expires_at := clock_timestamp() + interval '60 days';
  token_validated_at := clock_timestamp();
  perform public.record_whatsapp_embedded_signup_pre_completion_validation(
    attempt_id, validation_lease_token, true, '123456789012345',
    array['whatsapp_business_management','whatsapp_business_messaging'],
    granular, array[p_waba_id], token_expires_at,
    data_access_expires_at, token_validated_at
  );
  return next;
end;
$$;

insert into public.whatsapp_coexistence_accounts (
  id, client_scope, waba_id, phone_number_id, coexistence_status,
  business_portfolio_id, business_token_generation, business_token_status,
  business_token_is_valid, business_token_validation_status,
  onboarding_status, history_sharing_decision, app_subscription_status,
  last_account_update_at, last_account_update_event, offboarded_at
) values
  (
    '97000000-0000-4000-8000-000000000300', 'lifecycle-before-start',
    '970000000000300', '970000000000301', 'disconnected',
    '979000000000999', 1, 'revoked', false, 'invalid', 'offboarded',
    'declined', 'unsubscribed', clock_timestamp() - interval '20 minutes',
    'ACCOUNT_OFFBOARDED', clock_timestamp() - interval '20 minutes'
  ),
  (
    '97000000-0000-4000-8000-000000000302', 'lifecycle-after-start',
    '970000000000302', '970000000000303', 'disconnected',
    '979000000000999', 1, 'revoked', false, 'invalid', 'offboarded',
    'declined', 'unsubscribed', null, null,
    clock_timestamp() - interval '20 minutes'
  );

select * from pg_temp.prepare_lifecycle_signup(
  '97000000-0000-4000-8000-000000000009',
  'lifecycle-before-start', '970000000000300', '970000000000301',
  'opaque-lifecycle-before-start'
)
\gset lifecycle_before_
select * from public.complete_whatsapp_embedded_signup(
  :'lifecycle_before_attempt_id'::uuid,
  '97000000-0000-4000-8000-000000000009',
  '979000000000999', '970000000000300', '970000000000301',
  '+54 9 11 0000 0301', true, '123456789012345',
  array['whatsapp_business_management','whatsapp_business_messaging'],
  '[{"scope":"whatsapp_business_management","target_ids":["970000000000300"]},{"scope":"whatsapp_business_messaging","target_ids":["970000000000300"]}]'::jsonb,
  array['970000000000300'],
  :'lifecycle_before_token_expires_at'::timestamptz,
  :'lifecycle_before_data_access_expires_at'::timestamptz,
  :'lifecycle_before_token_validated_at'::timestamptz,
  :'lifecycle_before_validation_lease_token'::uuid
)
\gset lifecycle_before_complete_
select ok(
  :'lifecycle_before_complete_account_id'::uuid
      = '97000000-0000-4000-8000-000000000300'::uuid
    and (
      select business_token_generation = 2
        and business_token_status = 'active'
        and onboarding_status = 'provisioning'
        and last_account_update_at is null
      from public.whatsapp_coexistence_accounts
      where id = '97000000-0000-4000-8000-000000000300'
    )
    and (
      select count(*) = 2
      from public.whatsapp_onboarding_outbox
      where account_id = '97000000-0000-4000-8000-000000000300'
        and token_generation = 2
    ),
  'a lifecycle event strictly before START may be superseded by validated reauthentication'
);

select * from pg_temp.prepare_lifecycle_signup(
  '97000000-0000-4000-8000-000000000010',
  'lifecycle-after-start', '970000000000302', '970000000000303',
  'opaque-lifecycle-after-start'
)
\gset lifecycle_after_
select clock_timestamp()::text as event_at
\gset lifecycle_after_event_
select count(*) from public.apply_whatsapp_coexistence_account_update(
  '970000000000302', 'ACCOUNT_OFFBOARDED',
  :'lifecycle_after_event_event_at'::timestamptz,
  '979000000000999', null, null
);
select throws_ok(
  format(
    $$select * from public.complete_whatsapp_embedded_signup(
      %L::uuid, '97000000-0000-4000-8000-000000000010',
      '979000000000999', '970000000000302', '970000000000303',
      '+54 9 11 0000 0303', true, '123456789012345',
      array['whatsapp_business_management','whatsapp_business_messaging'],
      '[{"scope":"whatsapp_business_management","target_ids":["970000000000302"]},{"scope":"whatsapp_business_messaging","target_ids":["970000000000302"]}]'::jsonb,
      array['970000000000302'], %L::timestamptz, %L::timestamptz,
      %L::timestamptz, %L::uuid)$$,
    :'lifecycle_after_attempt_id',
    :'lifecycle_after_token_expires_at',
    :'lifecycle_after_data_access_expires_at',
    :'lifecycle_after_token_validated_at',
    :'lifecycle_after_validation_lease_token'
  ),
  '55000',
  'WHATSAPP_EMBEDDED_SIGNUP_LIFECYCLE_CONFLICT',
  'account_update after START aborts completion before credential promotion'
);
select is(
  public.fail_whatsapp_embedded_signup_validation(
    :'lifecycle_after_attempt_id'::uuid,
    :'lifecycle_after_validation_lease_token'::uuid,
    'WHATSAPP_EMBEDDED_SIGNUP_LIFECYCLE_CONFLICT', false
  ),
  'failed',
  'runtime-equivalent lifecycle failure terminalizes the attempt under its lease'
);
select ok(
  (
    select onboarding_status = 'offboarded'
      and coexistence_status = 'disconnected'
      and business_token_generation = 1
      and business_token_secret_id is null
      and last_account_update_at
        = :'lifecycle_after_event_event_at'::timestamptz
      and last_account_update_event = 'ACCOUNT_OFFBOARDED'
    from public.whatsapp_coexistence_accounts
    where id = '97000000-0000-4000-8000-000000000302'
  )
    and not exists (
      select 1 from public.whatsapp_onboarding_outbox
      where account_id = '97000000-0000-4000-8000-000000000302'
    )
    and (
      select status = 'failed'
        and temporary_token_secret_id is null
        and account_id is null
      from public.whatsapp_embedded_signup_attempts
      where id = :'lifecycle_after_attempt_id'::uuid
    )
    and not exists (
      select 1 from vault.secrets
      where name = 'whatsapp_embedded_signup_token_'
        || :'lifecycle_after_attempt_id'
    )
    and not exists (
      select 1 from vault.secrets
      where name = 'whatsapp_business_access_token_97000000-0000-4000-8000-000000000302'
    ),
  'lifecycle conflict purges only temporary state and creates no account work'
);
select ok(
  public.record_whatsapp_embedded_signup_session(
    :'lifecycle_after_attempt_id'::uuid,
    '97000000-0000-4000-8000-000000000010',
    md5('lifecycle-after-start:state:1')
      || md5('lifecycle-after-start:state:2'),
    md5('lifecycle-after-start:nonce:1')
      || md5('lifecycle-after-start:nonce:2'),
    md5('lifecycle-after-start:sdk:1')
      || md5('lifecycle-after-start:sdk:2'),
    (select callback_received_at
      from public.whatsapp_embedded_signup_attempts
      where id = :'lifecycle_after_attempt_id'::uuid),
    '979000000000999', '970000000000302', '970000000000303',
    '{"waba_ids":["970000000000302"]}'::jsonb, 'declined'
  )
    and (
      select status = 'failed' and temporary_token_secret_id is null
      from public.whatsapp_embedded_signup_attempts
      where id = :'lifecycle_after_attempt_id'::uuid
    ),
  'late exact FINISH after lifecycle failure is inert and cannot restore recovery state'
);
select throws_ok(
  format(
    $$select * from public.claim_whatsapp_embedded_signup_code(
      %L::uuid, '97000000-0000-4000-8000-000000000010',
      %L, %L, %L)$$,
    :'lifecycle_after_attempt_id',
    md5('lifecycle-after-start:state:1')
      || md5('lifecycle-after-start:state:2'),
    md5('lifecycle-after-start:nonce:1')
      || md5('lifecycle-after-start:nonce:2'),
    md5('lifecycle-after-start:late-code:1')
      || md5('lifecycle-after-start:late-code:2')
  ),
  '55000',
  'WHATSAPP_EMBEDDED_SIGNUP_CODE_REPLAY',
  'late code after lifecycle failure is rejected without new work'
);

-- Before the first account row exists, an authenticated FINISH is a bounded
-- WABA trust anchor. A pre-FINISH event is stale; a later lifecycle event
-- terminalizes the attempt under the same WABA lock used by completion.
select * from pg_temp.prepare_lifecycle_signup(
  '97000000-0000-4000-8000-000000000012',
  'first-account-lifecycle', '970000000000320', '970000000000321',
  'opaque-first-account-lifecycle'
)
\gset first_lifecycle_
select callback_received_at::text as callback_at
from public.whatsapp_embedded_signup_attempts
where id = :'first_lifecycle_attempt_id'::uuid
\gset first_lifecycle_callback_
select ok(
  public.is_trusted_whatsapp_coexistence_webhook_waba('970000000000320'),
  'active FINISH makes only its exact first-time WABA trusted for lifecycle routing'
);
select count(*) from public.apply_whatsapp_coexistence_account_update(
  '970000000000320', 'ACCOUNT_OFFBOARDED',
  :'first_lifecycle_callback_callback_at'::timestamptz - interval '1 second',
  '979000000000999', null, null
);
select ok(
  (
    select status = 'validating' and lifecycle_event_at is null
      and temporary_token_secret_id is not null
      and validation_lease_token
        = :'first_lifecycle_validation_lease_token'::uuid
    from public.whatsapp_embedded_signup_attempts
    where id = :'first_lifecycle_attempt_id'::uuid
  )
    and exists (
      select 1 from public.audit_logs
      where entity_id = :'first_lifecycle_attempt_id'::uuid
        and action = 'whatsapp.embedded_signup.lifecycle_ignored'
        and metadata @> '{"reason":"PRE_FINISH_EVENT"}'::jsonb
    ),
  'first-time lifecycle event from before FINISH is ignored without touching its lease/token'
);
select clock_timestamp()::text as event_at
\gset first_lifecycle_event_
select count(*) from public.apply_whatsapp_coexistence_account_update(
  '970000000000320', 'ACCOUNT_OFFBOARDED',
  :'first_lifecycle_event_event_at'::timestamptz,
  '979000000000999', null, null
);
select ok(
  (
    select status = 'failed'
      and temporary_token_secret_id is null
      and validation_processing_started_at is null
      and validation_lease_expires_at is null
      and validation_lease_token is null
      and lifecycle_event_at = :'first_lifecycle_event_event_at'::timestamptz
      and lifecycle_event = 'ACCOUNT_OFFBOARDED'
      and last_error_code = 'ACCOUNT_OFFBOARDED'
    from public.whatsapp_embedded_signup_attempts
    where id = :'first_lifecycle_attempt_id'::uuid
  )
    and not exists (
      select 1 from vault.secrets
      where name = 'whatsapp_embedded_signup_token_'
        || :'first_lifecycle_attempt_id'
    )
    and not exists (
      select 1 from public.whatsapp_coexistence_accounts
      where waba_id = '970000000000320'
        or phone_number_id = '970000000000321'
    )
    and not exists (
      select 1 from public.whatsapp_onboarding_outbox
      where onboarding_attempt_id = :'first_lifecycle_attempt_id'::uuid
    )
    and not exists (
      select 1 from vault.decrypted_secrets
      where decrypted_secret = 'opaque-first-account-lifecycle'
    )
    and exists (
      select 1 from public.whatsapp_business_token_validations
      where onboarding_attempt_id = :'first_lifecycle_attempt_id'::uuid
        and account_id is null and token_generation is null
    ),
  'post-FINISH lifecycle atomically fails first-time attempt and purges only temporary token'
);
select throws_ok(
  format(
    $$select * from public.complete_whatsapp_embedded_signup(
      %L::uuid, '97000000-0000-4000-8000-000000000012',
      '979000000000999', '970000000000320', '970000000000321',
      '+54 9 11 0000 0321', true, '123456789012345',
      array['whatsapp_business_management','whatsapp_business_messaging'],
      '[{"scope":"whatsapp_business_management","target_ids":["970000000000320"]},{"scope":"whatsapp_business_messaging","target_ids":["970000000000320"]}]'::jsonb,
      array['970000000000320'], %L::timestamptz, %L::timestamptz,
      %L::timestamptz, %L::uuid)$$,
    :'first_lifecycle_attempt_id',
    :'first_lifecycle_token_expires_at',
    :'first_lifecycle_data_access_expires_at',
    :'first_lifecycle_token_validated_at',
    :'first_lifecycle_validation_lease_token'
  ),
  '55000',
  'WHATSAPP_EMBEDDED_SIGNUP_COMPLETION_STATE_INVALID',
  'completion cannot promote a first-time attempt after lifecycle won the WABA lock'
);
select count(*) from public.apply_whatsapp_coexistence_account_update(
  '970000000000320', 'ACCOUNT_OFFBOARDED',
  :'first_lifecycle_event_event_at'::timestamptz,
  '979000000000999', null, null
);
select ok(
  public.is_trusted_whatsapp_coexistence_webhook_waba('970000000000320')
    and (
      select status = 'failed' and temporary_token_secret_id is null
        and lifecycle_event_at
          = :'first_lifecycle_event_event_at'::timestamptz
      from public.whatsapp_embedded_signup_attempts
      where id = :'first_lifecycle_attempt_id'::uuid
    )
    and exists (
      select 1 from public.audit_logs
      where entity_id = :'first_lifecycle_attempt_id'::uuid
        and action = 'whatsapp.embedded_signup.lifecycle_ignored'
        and metadata @> '{"reason":"IDEMPOTENT_REPLAY"}'::jsonb
    )
    and not exists (
      select 1 from public.whatsapp_onboarding_outbox
      where onboarding_attempt_id = :'first_lifecycle_attempt_id'::uuid
    ),
  'duplicate first-time lifecycle replay is trusted only for an idempotent terminal no-op'
);

-- Administrative offboarding owns its unsubscribe job even when an official
-- lifecycle callback races with it. The retained credential remains usable
-- only for unsubscribe/reconciliation and every transition is account-scoped.
select vault.create_secret(
  'opaque-offboard-event-token',
  'whatsapp_business_access_token_97000000-0000-4000-8000-000000000400',
  'pgTAP offboarding event token'
)::text as secret_id
\gset offboard_event_token_
select vault.create_secret(
  'opaque-offboard-invalid-token',
  'whatsapp_business_access_token_97000000-0000-4000-8000-000000000402',
  'pgTAP invalid retained token'
)::text as secret_id
\gset offboard_invalid_token_
select vault.create_secret(
  'opaque-offboard-sibling-token',
  'whatsapp_business_access_token_97000000-0000-4000-8000-000000000404',
  'pgTAP offboarding sibling token'
)::text as secret_id
\gset offboard_sibling_token_
insert into public.whatsapp_coexistence_accounts (
  id, client_scope, waba_id, phone_number_id, coexistence_status,
  business_portfolio_id, business_token_secret_id, business_token_generation,
  business_token_status, business_token_is_valid,
  business_token_validation_status, business_token_last_validation_error_code,
  attention_required, attention_required_at, attention_required_reason,
  onboarding_status, history_sharing_decision, app_subscription_status,
  app_subscribed_at
) values
  (
    '97000000-0000-4000-8000-000000000400', 'offboard-event',
    '970000000000400', '970000000000401', 'active', '979000000000999',
    :'offboard_event_token_secret_id'::uuid, 1, 'active', null, 'missing',
    null, false, null, null, 'completed', 'declined', 'subscribed',
    clock_timestamp()
  ),
  (
    '97000000-0000-4000-8000-000000000402', 'offboard-invalid',
    '970000000000402', '970000000000403', 'paused', '979000000000999',
    :'offboard_invalid_token_secret_id'::uuid, 1, 'invalid', false, 'invalid',
    'GRAPH_AUTH_ERROR', true, clock_timestamp(), 'GRAPH_AUTH_ERROR',
    'completed', 'declined', 'subscribed', clock_timestamp()
  ),
  (
    '97000000-0000-4000-8000-000000000404', 'offboard-sibling',
    '970000000000404', '970000000000405', 'active', '979000000000999',
    :'offboard_sibling_token_secret_id'::uuid, 1, 'active', null, 'missing',
    null, false, null, null, 'completed', 'declined', 'subscribed',
    clock_timestamp()
  );
insert into public.contacts (id, phone_e164, whatsapp_id, name) values (
  '97000000-0000-4000-8000-000000000410',
  '+5491100000410', '5491100000410', 'Retained offboarding data'
);
insert into public.conversations (
  id, contact_id, status, coexistence_account_id
) values (
  '97000000-0000-4000-8000-000000000411',
  '97000000-0000-4000-8000-000000000410', 'open',
  '97000000-0000-4000-8000-000000000402'
);
insert into public.messages (
  id, conversation_id, contact_id, direction, whatsapp_message_id,
  body, status, coexistence_account_id
) values (
  '97000000-0000-4000-8000-000000000412',
  '97000000-0000-4000-8000-000000000411',
  '97000000-0000-4000-8000-000000000410', 'inbound',
  'wamid.offboarding.retained.data', 'preserve me', 'delivered',
  '97000000-0000-4000-8000-000000000402'
);

select ok(
  public.begin_whatsapp_coexistence_offboarding(
    '97000000-0000-4000-8000-000000000400',
    '97000000-0000-4000-8000-000000000011', 'offboard-event'
  ),
  'administrative offboarding creates the exact account unsubscribe job'
);
select clock_timestamp()::text as event_at
\gset offboard_event_
select count(*) from public.apply_whatsapp_coexistence_account_update(
  '970000000000400', 'ACCOUNT_OFFBOARDED',
  :'offboard_event_event_at'::timestamptz,
  '979000000000999', null, null
);
select ok(
  (
    select onboarding_status = 'offboarding'
      and coexistence_status = 'paused'
      and business_token_status = 'unknown'
      and business_token_secret_id = :'offboard_event_token_secret_id'::uuid
      and app_subscription_status = 'unsubscribing'
      and offboarding_requested_at is not null
      and offboarded_at is null
      and last_account_update_event = 'ACCOUNT_OFFBOARDED'
    from public.whatsapp_coexistence_accounts
    where id = '97000000-0000-4000-8000-000000000400'
  )
    and (
      select status = 'pending' and requested_by
        = '97000000-0000-4000-8000-000000000011'::uuid
      from public.whatsapp_onboarding_outbox
      where account_id = '97000000-0000-4000-8000-000000000400'
        and operation = 'unsubscribe_app'
    )
    and (
      select business_token_status = 'active'
        and business_token_secret_id = :'offboard_sibling_token_secret_id'::uuid
      from public.whatsapp_coexistence_accounts
      where id = '97000000-0000-4000-8000-000000000404'
    ),
  'ACCOUNT_OFFBOARDED preserves a recoverable unsubscribe and leaves sibling state intact'
);
select lives_ok(
  $$select * from public.resolve_whatsapp_account_credentials(
    'unsubscribe', '97000000-0000-4000-8000-000000000400',
    null, null, null, 1
  )$$,
  'unsubscribe alone can resolve a retained unknown credential'
);
update public.whatsapp_onboarding_outbox
set available_at = clock_timestamp() + interval '1 day'
where status = 'pending'
  and account_id <> '97000000-0000-4000-8000-000000000400';
select id::text as id, lease_token::text as lease
from public.claim_whatsapp_onboarding_jobs(5)
where account_id = '97000000-0000-4000-8000-000000000400'
  and operation = 'unsubscribe_app'
\gset offboard_event_job_
select ok(
  public.complete_whatsapp_onboarding_job(
    :'offboard_event_job_id'::uuid,
    :'offboard_event_job_lease'::uuid,
    null, 'remote_already_absent'
  ),
  'processor can terminalize unsubscribe after lifecycle confirms remote absence'
);
select ok(
  (
    select onboarding_status = 'offboarded'
      and coexistence_status = 'disconnected'
      and business_token_status = 'revoked'
      and business_token_secret_id is null
      and app_subscription_status = 'unsubscribed'
    from public.whatsapp_coexistence_accounts
    where id = '97000000-0000-4000-8000-000000000400'
  )
    and (
      select status = 'succeeded'
        and completion_reason = 'remote_already_absent'
      from public.whatsapp_onboarding_outbox
      where id = :'offboard_event_job_id'::uuid
    )
    and exists (
      select 1 from vault.secrets
      where id = :'offboard_sibling_token_secret_id'::uuid
        and name = 'whatsapp_business_access_token_97000000-0000-4000-8000-000000000404'
    ),
  'terminal offboarding purges only its credential and preserves sibling Vault identity'
);

select ok(
  public.begin_whatsapp_coexistence_offboarding(
    '97000000-0000-4000-8000-000000000402',
    '97000000-0000-4000-8000-000000000011', 'offboard-invalid'
  ),
  'administrator can offboard a completed account with retained invalid credential'
);
update public.whatsapp_onboarding_outbox
set available_at = clock_timestamp() + interval '1 day'
where status = 'pending'
  and account_id <> '97000000-0000-4000-8000-000000000402';
select id::text as id, lease_token::text as lease
from public.claim_whatsapp_onboarding_jobs(5)
where account_id = '97000000-0000-4000-8000-000000000402'
  and operation = 'unsubscribe_app'
\gset offboard_invalid_job_
select clock_timestamp()::text as event_at
\gset offboard_partner_
select count(*) from public.apply_whatsapp_coexistence_account_update(
  '970000000000402', 'PARTNER_REMOVED',
  :'offboard_partner_event_at'::timestamptz,
  '979000000000999', 'ACCOUNT_DISCONNECTED', 'SYSTEM'
);
select ok(
  (
    select status = 'processing'
      and lease_token = :'offboard_invalid_job_lease'::uuid
    from public.whatsapp_onboarding_outbox
    where id = :'offboard_invalid_job_id'::uuid
  )
    and (
      select onboarding_status = 'offboarding'
        and coexistence_status = 'paused'
        and business_token_secret_id
          = :'offboard_invalid_token_secret_id'::uuid
        and last_account_update_event = 'PARTNER_REMOVED'
      from public.whatsapp_coexistence_accounts
      where id = '97000000-0000-4000-8000-000000000402'
    )
    and (
      select business_token_status = 'active'
      from public.whatsapp_coexistence_accounts
      where id = '97000000-0000-4000-8000-000000000404'
    ),
  'PARTNER_REMOVED preserves the in-flight administrative unsubscribe lease only for its account'
);
select is(
  public.fail_whatsapp_onboarding_job(
    :'offboard_invalid_job_id'::uuid,
    :'offboard_invalid_job_lease'::uuid,
    'UNSUBSCRIBE_OUTCOME_UNKNOWN', 'ambiguous', false
  ),
  'ambiguous',
  'ambiguous unsubscribe remains durable without leaving offboarding state'
);
select is(
  public.begin_whatsapp_coexistence_offboarding(
    '97000000-0000-4000-8000-000000000402',
    '97000000-0000-4000-8000-000000000011', 'offboard-invalid'
  ),
  true,
  'explicit retry accepts an ambiguous administrative unsubscribe'
);
select ok(
  (
    select status = 'pending' and attempts = 0 and lease_token is null
    from public.whatsapp_onboarding_outbox
    where id = :'offboard_invalid_job_id'::uuid
  ),
  'explicit retry safely requeues the ambiguous job for reconciliation'
);
select clock_timestamp()::text as event_at
\gset offboard_reconnect_
select count(*) from public.apply_whatsapp_coexistence_account_update(
  '970000000000402', 'ACCOUNT_RECONNECTED',
  :'offboard_reconnect_event_at'::timestamptz,
  '979000000000999', null, null
);
select ok(
  (
    select onboarding_status = 'offboarding'
      and coexistence_status = 'paused'
      and app_subscription_status = 'unsubscribing'
      and last_account_update_event = 'ACCOUNT_RECONNECTED'
      and offboarding_requested_at is not null
    from public.whatsapp_coexistence_accounts
    where id = '97000000-0000-4000-8000-000000000402'
  )
    and (
      select status = 'pending' and lease_token is null
      from public.whatsapp_onboarding_outbox
      where id = :'offboard_invalid_job_id'::uuid
    )
    and not exists (
      select 1 from public.whatsapp_business_token_validation_jobs
      where account_id = '97000000-0000-4000-8000-000000000402'
        and status in ('pending', 'processing', 'failed')
    ),
  'ACCOUNT_RECONNECTED cannot cancel offboarding or schedule competing token work'
);
update public.whatsapp_onboarding_outbox
set available_at = clock_timestamp()
where id = :'offboard_invalid_job_id'::uuid;
select id::text as id, lease_token::text as lease
from public.claim_whatsapp_onboarding_jobs(5)
where id = :'offboard_invalid_job_id'::uuid
\gset offboard_invalid_retry_
select ok(
  public.finalize_whatsapp_coexistence_local_offboarding(
    :'offboard_invalid_retry_id'::uuid,
    :'offboard_invalid_retry_lease'::uuid,
    'CREDENTIAL_INVALID'
  ),
  'invalid retained credential has an explicit terminal local-offboarding path'
);
select * from public.create_whatsapp_embedded_signup_attempt(
  '97000000-0000-4000-8000-000000000011', 'offboard-invalid',
  md5('offboard-invalid:restart:state:1')
    || md5('offboard-invalid:restart:state:2'),
  md5('offboard-invalid:restart:nonce:1')
    || md5('offboard-invalid:restart:nonce:2'),
  '123456789012345',
  '234567890123456', 'declined', clock_timestamp() + interval '10 minutes'
)
\gset offboard_reconnect_start_
select ok(
  :'offboard_reconnect_start_status' = 'initiated'
    and (
      select onboarding_status = 'offboarded'
        and business_token_status = 'revoked'
        and business_token_secret_id is null
      from public.whatsapp_coexistence_accounts
      where id = '97000000-0000-4000-8000-000000000402'
    )
    and exists (
      select 1 from public.contacts
      where id = '97000000-0000-4000-8000-000000000410'
    )
    and exists (
      select 1 from public.conversations
      where id = '97000000-0000-4000-8000-000000000411'
        and coexistence_account_id
          = '97000000-0000-4000-8000-000000000402'
    )
    and exists (
      select 1 from public.messages
      where id = '97000000-0000-4000-8000-000000000412'
        and body = 'preserve me'
    )
    and (
      select business_token_status = 'active'
        and business_token_secret_id = :'offboard_sibling_token_secret_id'::uuid
      from public.whatsapp_coexistence_accounts
      where id = '97000000-0000-4000-8000-000000000404'
    ),
  'terminal invalid-token offboarding preserves data/sibling and permits a fresh START'
);

select ok(
  not exists (
    select 1 from public.audit_logs
    where metadata::text like '%opaque-primary-token%'
      or metadata::text like '%' || repeat('f', 64) || '%'
  ),
  'sanitized audit metadata contains neither tokens nor code hashes'
);

select is(
  (
    select count(*)::integer
    from public.whatsapp_automation_effects
    where execution_message_id
      <> '97000000-0000-4000-8000-000000000226'
  ),
  0,
  'Embedded Signup and recovery create no automation effects outside the explicit race fixture'
);

select is(
  (select count(*)::integer from net.http_request_queue),
  0,
  'database workflow performs no external HTTP request'
);

select * from finish();
rollback;
