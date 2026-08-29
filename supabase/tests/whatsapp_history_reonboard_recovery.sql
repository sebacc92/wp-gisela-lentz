\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '97900000-0000-4000-8000-000000000001',
  'history-reonboard-admin@example.test', '',
  'authenticated', 'authenticated'
);
update public.profiles
set role = 'ADMIN'
where id = '97900000-0000-4000-8000-000000000001';

select ok(
  has_function_privilege(
    'service_role',
    'public.complete_whatsapp_embedded_signup(uuid,uuid,text,text,text,text,boolean,text,text[],jsonb,text[],timestamptz,timestamptz,timestamptz,uuid)',
    'EXECUTE'
  )
    and to_regprocedure(
      'public.complete_whatsapp_embedded_signup_without_history_recovery(uuid,uuid,text,text,text,text,boolean,text,text[],jsonb,text[],timestamptz,timestamptz,timestamptz,uuid)'
    ) is null
    and not has_function_privilege(
      'authenticated',
      'public.complete_whatsapp_embedded_signup(uuid,uuid,text,text,text,text,boolean,text,text[],jsonb,text[],timestamptz,timestamptz,timestamptz,uuid)',
      'EXECUTE'
    ),
  'only the service role can call the recovery-aware completion wrapper'
);

create function pg_temp.prepare_history_signup(
  p_state_hash text,
  p_nonce_hash text,
  p_sdk_hash text,
  p_code_hash text,
  p_token text
)
returns table (
  attempt_id uuid,
  validation_lease_token uuid,
  validated_at timestamptz,
  data_access_expires_at timestamptz
)
language plpgsql
as $$
declare
  created_attempt record;
  validation_claim record;
  post_exchange_at timestamptz := clock_timestamp() - interval '1 second';
  pre_completion_at timestamptz := clock_timestamp();
  data_access_at timestamptz := clock_timestamp() + interval '2 hours';
begin
  select * into created_attempt
  from public.create_whatsapp_embedded_signup_attempt(
    '97900000-0000-4000-8000-000000000001',
    'history-reonboard-scope',
    p_state_hash, p_nonce_hash,
    '123456789012345', '234567890123456',
    'accepted', clock_timestamp() + interval '10 minutes'
  );

  perform public.record_whatsapp_embedded_signup_session(
    created_attempt.attempt_id,
    '97900000-0000-4000-8000-000000000001',
    p_state_hash, p_nonce_hash, p_sdk_hash,
    clock_timestamp(), null, '345678901234567', null,
    '{"waba_ids":["345678901234567"]}'::jsonb,
    'accepted'
  );
  perform * from public.claim_whatsapp_embedded_signup_code(
    created_attempt.attempt_id,
    '97900000-0000-4000-8000-000000000001',
    p_state_hash, p_nonce_hash, p_code_hash
  );
  perform public.store_whatsapp_embedded_signup_exchange_token(
    created_attempt.attempt_id, p_code_hash, p_token
  );
  perform public.record_whatsapp_embedded_signup_post_exchange_validation(
    created_attempt.attempt_id, true, '123456789012345',
    array[
      'whatsapp_business_management', 'whatsapp_business_messaging'
    ],
    '[{"scope":"whatsapp_business_management","target_ids":["345678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["345678901234567"]}]'::jsonb,
    array['345678901234567'], null, data_access_at, post_exchange_at
  );
  select * into validation_claim
  from public.claim_whatsapp_embedded_signup_validations(
    1, created_attempt.attempt_id
  );
  perform public.record_whatsapp_embedded_signup_pre_completion_validation(
    created_attempt.attempt_id,
    validation_claim.validation_lease_token,
    true, '123456789012345',
    array[
      'whatsapp_business_management', 'whatsapp_business_messaging'
    ],
    '[{"scope":"whatsapp_business_management","target_ids":["345678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["345678901234567"]}]'::jsonb,
    array['345678901234567'], null, data_access_at, pre_completion_at
  );

  return query select
    created_attempt.attempt_id::uuid,
    validation_claim.validation_lease_token::uuid,
    pre_completion_at,
    data_access_at;
end;
$$;

select * from pg_temp.prepare_history_signup(
  repeat('1', 64), repeat('2', 64), repeat('3', 64), repeat('4', 64),
  'opaque-history-token-generation-one'
)
\gset first_

select * from public.complete_whatsapp_embedded_signup(
  :'first_attempt_id'::uuid,
  '97900000-0000-4000-8000-000000000001',
  '678901234567890', '345678901234567', '789012345678901',
  '+54 9 11 5555 0199', true, '123456789012345',
  array['whatsapp_business_management','whatsapp_business_messaging'],
  '[{"scope":"whatsapp_business_management","target_ids":["345678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["345678901234567"]}]'::jsonb,
  array['345678901234567'], null,
  :'first_data_access_expires_at'::timestamptz,
  :'first_validated_at'::timestamptz,
  :'first_validation_lease_token'::uuid
)
\gset account_

select * from public.claim_whatsapp_onboarding_jobs(1)
\gset first_subscribe_
select is(
  :'first_subscribe_operation'::text, 'subscribe_app'::text,
  'the initial generation claims subscription first'
);
select ok(
  public.complete_whatsapp_onboarding_job(
    :'first_subscribe_id'::uuid,
    :'first_subscribe_lease_token'::uuid,
    null, 'remote_confirmed'
  ),
  'the initial subscription completes'
);

select * from public.claim_whatsapp_onboarding_jobs(1)
\gset first_contacts_
select is(
  :'first_contacts_operation'::text, 'request_contacts_sync'::text,
  'the initial generation claims contacts second'
);
select ok(
  public.complete_whatsapp_onboarding_job(
    :'first_contacts_id'::uuid,
    :'first_contacts_lease_token'::uuid,
    'contacts-request-generation-one', 'remote_confirmed'
  ),
  'the initial contacts request completes'
);

select * from public.claim_whatsapp_onboarding_jobs(1)
\gset first_history_
select is(
  :'first_history_operation'::text, 'request_history_sync'::text,
  'the initial generation performs the one remote history request'
);
select ok(
  public.complete_whatsapp_onboarding_job(
    :'first_history_id'::uuid,
    :'first_history_lease_token'::uuid,
    'history-request-generation-one', 'remote_confirmed'
  ),
  'the one remote history request is durably confirmed'
);

-- Contacts are independent evidence. A prior contacts failure must not make
-- the already-confirmed remote history POST repeat on the next onboarding.
update public.whatsapp_onboarding_outbox
set status = 'failed',
    completion_reason = null,
    completed_at = null,
    failed_at = clock_timestamp(),
    last_error_code = 'CONTACTS_FIXTURE_FAILED'
where id = :'first_contacts_id'::uuid;

select ok(
  public.begin_whatsapp_coexistence_offboarding(
    :'account_account_id'::uuid,
    '97900000-0000-4000-8000-000000000001',
    'history-reonboard-scope'
  ),
  'the original account begins offboarding'
);
select * from public.claim_whatsapp_onboarding_jobs(1)
\gset unsubscribe_
select is(
  :'unsubscribe_operation'::text, 'unsubscribe_app'::text,
  'offboarding claims only the unsubscribe operation'
);
select ok(
  public.complete_whatsapp_onboarding_job(
    :'unsubscribe_id'::uuid,
    :'unsubscribe_lease_token'::uuid,
    null, 'remote_confirmed'
  ),
  'offboarding revokes the old local credential without deleting history evidence'
);

-- The production flow spans user interaction. Keep the fixture outside the
-- legacy same-second lifecycle race guard without adding a blocking sleep.
update public.whatsapp_coexistence_accounts
set offboarding_requested_at = clock_timestamp() - interval '2 seconds',
    offboarded_at = clock_timestamp() - interval '2 seconds'
where id = :'account_account_id'::uuid;
select updated_at::text as updated_at
from public.whatsapp_onboarding_outbox
where id = :'first_history_id'::uuid
\gset source_before_

select * from pg_temp.prepare_history_signup(
  repeat('5', 64), repeat('6', 64), repeat('7', 64), repeat('8', 64),
  'opaque-history-token-generation-two'
)
\gset second_

select lives_ok(
  format(
    $$select * from public.complete_whatsapp_embedded_signup(
      %L::uuid, '97900000-0000-4000-8000-000000000001',
      '678901234567890', '345678901234567', '789012345678901',
      '+54 9 11 5555 0199', true, '123456789012345',
      array['whatsapp_business_management','whatsapp_business_messaging'],
      '[{"scope":"whatsapp_business_management","target_ids":["345678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["345678901234567"]}]'::jsonb,
      array['345678901234567'], null, %L::timestamptz,
      %L::timestamptz, %L::uuid)$$,
    :'second_attempt_id', :'second_data_access_expires_at',
    :'second_validated_at', :'second_validation_lease_token'
  ),
  're-onboarding completes without a second history POST'
);

select ok(
  (
    select business_token_generation = 2
      and business_token_status = 'active'
      and business_token_secret_id is not null
      and onboarding_status = 'provisioning'
      and history_sharing_decision = 'accepted'
      and history_reonboard_state = 'prior_remote_request_reused'
      and history_reonboard_source_job_id = :'first_history_id'::uuid
      and history_reonboard_recorded_at is not null
      and history_request_id = 'history-request-generation-one'
    from public.whatsapp_coexistence_accounts
    where id = :'account_account_id'::uuid
  ),
  'recovery promotes the token and preserves accepted consent plus explicit review state'
);

select ok(
  (
    select status = 'succeeded'
      and attempts = 0
      and first_attempted_at is null
      and remote_request_id is null
      and completion_reason = 'prior_remote_request'
      and reused_from_job_id = :'first_history_id'::uuid
      and source_remote_request_id = 'history-request-generation-one'
    from public.whatsapp_onboarding_outbox
    where account_id = :'account_account_id'::uuid
      and token_generation = 2
      and operation = 'request_history_sync'
  )
    and (
      select count(*) = 2
        and count(*) filter (
          where operation = 'subscribe_app' and status = 'pending'
        ) = 1
        and count(*) filter (
          where operation = 'request_contacts_sync' and status = 'pending'
        ) = 1
      from public.whatsapp_onboarding_outbox
      where account_id = :'account_account_id'::uuid
        and token_generation = 2
        and status = 'pending'
    )
    and (
      select attempts = 1
        and remote_request_id = 'history-request-generation-one'
        and completion_reason = 'remote_confirmed'
        and updated_at = :'source_before_updated_at'::timestamptz
      from public.whatsapp_onboarding_outbox
      where id = :'first_history_id'::uuid
    ),
  'current history is terminal and unclaimable while subscribe and contacts are recreated'
);

select ok(
  exists (
    select 1
    from public.audit_logs
    where action
      = 'whatsapp.history_reonboard.prior_remote_request_reused'
      and entity_id = :'account_account_id'::uuid
      and metadata ->> 'source_job_id' = :'first_history_id'
      and metadata ->> 'history_decision' = 'accepted'
      and metadata ->> 'remote_history_post_repeated' = 'false'
  ),
  'carry-forward is explicitly audited without secrets'
);

select * from public.claim_whatsapp_onboarding_jobs(1)
\gset second_subscribe_
select is(
  :'second_subscribe_operation'::text, 'subscribe_app'::text,
  'the recovered generation still subscribes the app'
);
select ok(
  public.complete_whatsapp_onboarding_job(
    :'second_subscribe_id'::uuid,
    :'second_subscribe_lease_token'::uuid,
    null, 'remote_confirmed'
  ),
  'the recovered generation completes subscription'
);

select * from public.claim_whatsapp_onboarding_jobs(1)
\gset second_contacts_
select is(
  :'second_contacts_operation'::text, 'request_contacts_sync'::text,
  'the recovered generation requests contacts, never history'
);
select ok(
  public.complete_whatsapp_onboarding_job(
    :'second_contacts_id'::uuid,
    :'second_contacts_lease_token'::uuid,
    'contacts-request-generation-two', 'remote_confirmed'
  ),
  'the recovered generation completes contacts'
);

select is(
  (
    select count(*)::integer
    from public.claim_whatsapp_onboarding_jobs(1)
  ),
  0,
  'no history work remains claimable after carry-forward'
);
select ok(
  (
    select onboarding_status = 'completed'
      and coexistence_status = 'active'
      and history_sharing_decision = 'accepted'
      and history_reonboard_state = 'prior_remote_request_reused'
    from public.whatsapp_coexistence_accounts
    where id = :'account_account_id'::uuid
  )
    and (
      select integration_status = 'connected'
        and sending_paused
      from public.whatsapp_settings
      where id = true
    ),
  'subscribe plus contacts promote the account without a new history request or enabling sends'
);

select throws_ok(
  format(
    $$select public.enqueue_whatsapp_coexistence_event(
      %L::uuid, 'history-too-early-001', 'history', '{}'::jsonb,
      jsonb_build_object(
        'entry_time', (
          select first_attempted_at - interval '1 second'
          from public.whatsapp_onboarding_outbox where id = %L::uuid
        )
      ))$$,
    :'account_account_id', :'first_history_id'
  ),
  '42501',
  'WHATSAPP_COEXISTENCE_SYNC_EVENT_NOT_AUTHORIZED',
  'a callback older than the one proven remote request remains unauthorized'
);

select lives_ok(
  format(
    $$select public.enqueue_whatsapp_coexistence_event(
      %L::uuid, 'history-carried-001', 'history', '{}'::jsonb,
      jsonb_build_object('entry_time', clock_timestamp()))$$,
    :'account_account_id'
  ),
  'a late callback from the unique prior request is accepted into the current local generation'
);
select ok(
  exists (
    select 1
    from public.whatsapp_coexistence_events event
    join public.whatsapp_onboarding_outbox carry_job
      on carry_job.account_id = event.account_id
      and carry_job.token_generation = 2
      and carry_job.operation = 'request_history_sync'
      and carry_job.sync_generation_id = event.sync_generation_id
    where event.external_event_id = 'history-carried-001'
      and event.account_id = :'account_account_id'::uuid
      and carry_job.completion_reason = 'prior_remote_request'
  ),
  'the late callback is bound to the carried current generation'
);

-- A second canonical history job elsewhere in the WABA makes correlation
-- ambiguous. The next onboarding must still retain its token and provision
-- subscribe + contacts, but it must not create any history job.
insert into public.whatsapp_coexistence_accounts (
  client_scope, waba_id, phone_number_id, display_phone,
  coexistence_status, metadata
) values (
  'history-review-sibling', '345678901234567', '789012345678902',
  '+54 9 11 5555 0299', 'disconnected', '{"test_fixture":true}'::jsonb
)
returning id::text as account_id
\gset sibling_

insert into public.whatsapp_onboarding_outbox (
  account_id, token_generation, operation, idempotency_key, status,
  attempts, deadline_at, sync_generation_id
) values (
  :'sibling_account_id'::uuid, 1, 'request_history_sync',
  'history-review-sibling:1:history', 'pending', 0,
  clock_timestamp() + interval '23 hours', gen_random_uuid()
);

select ok(
  public.begin_whatsapp_coexistence_offboarding(
    :'account_account_id'::uuid,
    '97900000-0000-4000-8000-000000000001',
    'history-reonboard-scope'
  ),
  'the carried generation can be offboarded without deleting its audit chain'
);
select * from public.claim_whatsapp_onboarding_jobs(1)
\gset review_unsubscribe_
select is(
  :'review_unsubscribe_operation'::text, 'unsubscribe_app'::text,
  'the carried generation claims unsubscribe before review recovery'
);
select ok(
  public.complete_whatsapp_onboarding_job(
    :'review_unsubscribe_id'::uuid,
    :'review_unsubscribe_lease_token'::uuid,
    null, 'remote_confirmed'
  ),
  'the carried generation completes local offboarding'
);
update public.whatsapp_coexistence_accounts
set offboarding_requested_at = clock_timestamp() - interval '2 seconds',
    offboarded_at = clock_timestamp() - interval '2 seconds'
where id = :'account_account_id'::uuid;

select * from pg_temp.prepare_history_signup(
  repeat('9', 64), repeat('a', 64), repeat('b', 64), repeat('c', 64),
  'opaque-history-token-generation-three'
)
\gset review_

select lives_ok(
  format(
    $$select * from public.complete_whatsapp_embedded_signup(
      %L::uuid, '97900000-0000-4000-8000-000000000001',
      '678901234567890', '345678901234567', '789012345678901',
      '+54 9 11 5555 0199', true, '123456789012345',
      array['whatsapp_business_management','whatsapp_business_messaging'],
      '[{"scope":"whatsapp_business_management","target_ids":["345678901234567"]},{"scope":"whatsapp_business_messaging","target_ids":["345678901234567"]}]'::jsonb,
      array['345678901234567'], null, %L::timestamptz,
      %L::timestamptz, %L::uuid)$$,
    :'review_attempt_id', :'review_data_access_expires_at',
    :'review_validated_at', :'review_validation_lease_token'
  ),
  'ambiguous WABA history evidence no longer aborts credential promotion'
);

select ok(
  (
    select business_token_generation = 3
      and business_token_status = 'active'
      and business_token_secret_id is not null
      and onboarding_status = 'provisioning'
      and coexistence_status = 'onboarding'
      and history_sharing_decision = 'accepted'
      and history_reonboard_state = 'prior_history_review_required'
      and history_reonboard_source_job_id is null
      and history_reonboard_recorded_at is not null
      and history_sync_status = 'idle'
      and history_sync_token_generation is null
      and history_request_id is null
      and attention_required
      and attention_required_at is not null
      and attention_required_reason
        = 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
      and onboarding_last_error_code
        = 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
    from public.whatsapp_coexistence_accounts
    where id = :'account_account_id'::uuid
  )
    and not exists (
      select 1
      from public.whatsapp_onboarding_outbox
      where account_id = :'account_account_id'::uuid
        and token_generation = 3
        and operation = 'request_history_sync'
    )
    and (
      select count(*) = 2
      from public.whatsapp_onboarding_outbox
      where account_id = :'account_account_id'::uuid
        and token_generation = 3
        and operation in ('subscribe_app', 'request_contacts_sync')
        and status = 'pending'
    )
    and (
      select integration_status = 'incomplete'
        and sending_paused
        and sending_pause_reason
          = 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
      from public.whatsapp_settings
      where id = true
    ),
  'review state keeps accepted consent and creates only subscribe plus contacts'
);

select ok(
  exists (
    select 1
    from public.audit_logs
    where action = 'whatsapp.history_reonboard.review_required'
      and entity_id = :'account_account_id'::uuid
      and metadata ->> 'current_attempt_id' = :'review_attempt_id'
      and (metadata ->> 'prior_evidence_count')::integer = 2
      and metadata ->> 'history_decision' = 'accepted'
      and metadata ->> 'remote_history_post_repeated' = 'false'
  ),
  'ambiguous evidence is durably and explicitly audited for review'
);

select * from public.claim_whatsapp_onboarding_jobs(1)
\gset review_subscribe_
select is(
  :'review_subscribe_operation'::text, 'subscribe_app'::text,
  'review recovery claims subscription first'
);
select ok(
  public.complete_whatsapp_onboarding_job(
    :'review_subscribe_id'::uuid,
    :'review_subscribe_lease_token'::uuid,
    null, 'remote_confirmed'
  ),
  'review recovery completes subscription'
);
select * from public.claim_whatsapp_onboarding_jobs(1)
\gset review_contacts_
select is(
  :'review_contacts_operation'::text, 'request_contacts_sync'::text,
  'review recovery claims contacts and not history'
);
select ok(
  public.complete_whatsapp_onboarding_job(
    :'review_contacts_id'::uuid,
    :'review_contacts_lease_token'::uuid,
    'contacts-request-generation-three', 'remote_confirmed'
  ),
  'review recovery completes contacts'
);
select ok(
  (
    select onboarding_status = 'provisioning'
      and coexistence_status = 'onboarding'
      and history_sharing_decision = 'accepted'
      and history_reonboard_state = 'prior_history_review_required'
      and attention_required
      and attention_required_reason
        = 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
      and onboarding_last_error_code
        = 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
      and app_subscription_status = 'subscribed'
    from public.whatsapp_coexistence_accounts
    where id = :'account_account_id'::uuid
  )
    and (
      select integration_status = 'incomplete'
        and sending_paused
        and sending_pause_reason
          = 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
      from public.whatsapp_settings where id = true
    )
    and (
      select count(*) = 0
      from public.whatsapp_onboarding_outbox
      where account_id = :'account_account_id'::uuid
        and token_generation = 3
        and status in ('pending', 'processing')
    )
    and (
      select count(*) = 1
        and bool_and(account_id = :'sibling_account_id'::uuid)
        and bool_and(status = 'pending' and attempts = 0)
      from public.whatsapp_onboarding_outbox root_job
      join public.whatsapp_coexistence_accounts root_account
        on root_account.id = root_job.account_id
      where root_account.waba_id = '345678901234567'
        and root_job.operation = 'request_history_sync'
        and root_job.reused_from_job_id is null
        and root_job.status in ('pending', 'processing')
    ),
  'review remains non-connected after subscribe plus contacts and creates no second claimable history job'
);

-- Periodic recompute must not turn a concrete current-generation failure back
-- into provisioning or replace it with the more general history-review gate.
update public.whatsapp_onboarding_outbox
set status = 'ambiguous',
    completion_reason = null,
    completed_at = null,
    failed_at = null,
    last_error_code = 'CONTACTS_REMOTE_OUTCOME_UNKNOWN'
where id = :'review_contacts_id'::uuid;

select is(
  public.recompute_whatsapp_embedded_signup_onboarding(
    :'account_account_id'::uuid, 3
  ),
  false,
  'review recompute remains fail-closed for an ambiguous contacts request'
);
select ok(
  (
    select onboarding_status = 'failed'
      and coexistence_status = 'onboarding'
      and onboarding_last_error_code = 'CONTACTS_REMOTE_OUTCOME_UNKNOWN'
      and attention_required
      and attention_required_reason
        = 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
    from public.whatsapp_coexistence_accounts
    where id = :'account_account_id'::uuid
  )
    and (
      select integration_status = 'incomplete' and sending_paused
      from public.whatsapp_settings where id = true
    ),
  'ambiguous contacts stays failed and visible beneath the review gate'
);

update public.whatsapp_onboarding_outbox
set status = 'succeeded',
    completion_reason = 'remote_confirmed',
    completed_at = clock_timestamp(),
    failed_at = null,
    last_error_code = null
where id = :'review_contacts_id'::uuid;

select is(
  public.recompute_whatsapp_embedded_signup_onboarding(
    :'account_account_id'::uuid, 3
  ),
  false,
  'a reconciled contacts request clears only its operational failure'
);
select ok(
  (
    select onboarding_status = 'provisioning'
      and onboarding_last_error_code
        = 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
      and attention_required
      and attention_required_reason
        = 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
    from public.whatsapp_coexistence_accounts
    where id = :'account_account_id'::uuid
  )
    and (
      select integration_status = 'incomplete' and sending_paused
      from public.whatsapp_settings where id = true
    ),
  'recovery returns to provisioning plus review and never connected'
);

update public.whatsapp_onboarding_outbox
set status = 'failed',
    completion_reason = null,
    completed_at = null,
    failed_at = clock_timestamp(),
    last_error_code = 'SUBSCRIPTION_FIXTURE_FAILED'
where id = :'review_subscribe_id'::uuid;

select is(
  public.recompute_whatsapp_embedded_signup_onboarding(
    :'account_account_id'::uuid, 3
  ),
  false,
  'review recompute remains fail-closed for a failed subscription'
);
select ok(
  (
    select onboarding_status = 'failed'
      and onboarding_last_error_code = 'SUBSCRIPTION_FIXTURE_FAILED'
      and attention_required
      and attention_required_reason
        = 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
    from public.whatsapp_coexistence_accounts
    where id = :'account_account_id'::uuid
  )
    and (
      select integration_status = 'incomplete' and sending_paused
      from public.whatsapp_settings where id = true
    ),
  'failed subscription remains failed and keeps its concrete error'
);

update public.whatsapp_onboarding_outbox
set status = 'succeeded',
    completion_reason = 'remote_confirmed',
    completed_at = clock_timestamp(),
    failed_at = null,
    last_error_code = null
where id = :'review_subscribe_id'::uuid;
select is(
  public.recompute_whatsapp_embedded_signup_onboarding(
    :'account_account_id'::uuid, 3
  ),
  false,
  'a reconciled subscription also clears only its operational failure'
);
select ok(
  (
    select onboarding_status = 'provisioning'
      and onboarding_last_error_code
        = 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
      and attention_required
    from public.whatsapp_coexistence_accounts
    where id = :'account_account_id'::uuid
  )
    and (
      select integration_status = 'incomplete' and sending_paused
      from public.whatsapp_settings where id = true
    ),
  'resolved operational jobs remain gated by history review'
);

select throws_ok(
  format(
    $$select public.enqueue_whatsapp_coexistence_event(
      %L::uuid, 'history-review-denied-001', 'history', '{}'::jsonb,
      jsonb_build_object('entry_time', clock_timestamp()))$$,
    :'account_account_id'
  ),
  '42501',
  'WHATSAPP_COEXISTENCE_SYNC_EVENT_NOT_AUTHORIZED',
  'ambiguous review state cannot authorize a late history webhook'
);

select * from finish();
rollback;
