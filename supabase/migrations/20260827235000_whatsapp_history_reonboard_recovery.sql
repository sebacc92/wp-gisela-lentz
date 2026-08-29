-- Carry one already-dispatched Coexistence history request across a later
-- re-onboarding without ever issuing a second Graph history request.
--
-- The recovery is deliberately narrow: it only applies to an offboarded
-- account when the WABA has exactly one remotely-confirmed history request,
-- that request belongs to the same phone/account, and its request ID matches
-- the account ledger. Subscription and contacts remain independent and are
-- always recreated for the new generation. Ambiguous prior evidence is kept
-- as an explicit review state; it never aborts token promotion and never
-- creates a remotely claimable history job.

alter table public.whatsapp_coexistence_accounts
  add column history_reonboard_state text not null default 'not_applicable',
  add column history_reonboard_source_job_id uuid,
  add column history_reonboard_recorded_at timestamptz,
  add constraint whatsapp_coexistence_accounts_history_reonboard_state_check
    check (
      history_reonboard_state in (
        'not_applicable', 'prior_remote_request_reused',
        'prior_history_review_required'
      )
    ),
  add constraint whatsapp_coexistence_accounts_history_reonboard_shape_check
    check (
      (
        history_reonboard_state = 'not_applicable'
        and history_reonboard_source_job_id is null
        and history_reonboard_recorded_at is null
      )
      or (
        history_reonboard_state = 'prior_remote_request_reused'
        and history_reonboard_source_job_id is not null
        and history_reonboard_recorded_at is not null
        and history_sharing_decision = 'accepted'
      )
      or (
        history_reonboard_state = 'prior_history_review_required'
        and history_reonboard_source_job_id is null
        and history_reonboard_recorded_at is not null
        and history_sharing_decision = 'accepted'
      )
    );

alter table public.whatsapp_onboarding_outbox
  add column reused_from_job_id uuid,
  add column source_remote_request_id text,
  add constraint whatsapp_onboarding_outbox_reused_from_job_fk
    foreign key (reused_from_job_id)
    references public.whatsapp_onboarding_outbox (id)
    on delete restrict,
  add constraint whatsapp_onboarding_outbox_source_request_check check (
    source_remote_request_id is null
    or char_length(trim(source_remote_request_id)) between 1 and 240
  ),
  add constraint whatsapp_onboarding_outbox_reuse_not_self_check check (
    reused_from_job_id is null or reused_from_job_id <> id
  );

alter table public.whatsapp_coexistence_accounts
  add constraint whatsapp_coexistence_accounts_history_reonboard_source_fk
    foreign key (history_reonboard_source_job_id)
    references public.whatsapp_onboarding_outbox (id)
    on delete restrict;

alter table public.whatsapp_onboarding_outbox
  drop constraint whatsapp_onboarding_outbox_completion_reason_check,
  add constraint whatsapp_onboarding_outbox_completion_reason_check check (
    completion_reason is null
    or completion_reason in (
      'remote_confirmed', 'already_applied', 'webhook_observed',
      'history_declined', 'remote_already_absent',
      'local_credential_purge', 'prior_remote_request'
    )
  ),
  add constraint whatsapp_onboarding_outbox_history_reuse_check check (
    (
      completion_reason = 'prior_remote_request'
      and operation = 'request_history_sync'
      and status = 'succeeded'
      and attempts = 0
      and first_attempted_at is null
      and remote_request_id is null
      and reused_from_job_id is not null
      and source_remote_request_id is not null
      and completed_at is not null
    )
    or (
      completion_reason is distinct from 'prior_remote_request'
      and reused_from_job_id is null
      and source_remote_request_id is null
    )
  );

comment on column public.whatsapp_coexistence_accounts.history_reonboard_state is
  'Explicit state for a safely reused prior history request or ambiguous evidence requiring review; neither repeats POST history.';
comment on column public.whatsapp_coexistence_accounts.history_reonboard_source_job_id is
  'Exact prior outbox job proving the one remote history request reused by the current onboarding.';
comment on column public.whatsapp_onboarding_outbox.reused_from_job_id is
  'For a terminal local carry-forward job, the exact earlier job that performed the only remote request.';
comment on column public.whatsapp_onboarding_outbox.source_remote_request_id is
  'Immutable copy of the real prior remote request ID; never presented as a response to the current generation.';

-- Completion is replaced explicitly below. It never mutates or temporarily
-- hides historical outbox evidence.
create or replace function public.complete_whatsapp_embedded_signup(
  p_attempt_id uuid,
  p_admin_user_id uuid,
  p_verified_business_portfolio_id text,
  p_verified_waba_id text,
  p_verified_phone_number_id text,
  p_display_phone text,
  p_token_is_valid boolean,
  p_token_app_id text,
  p_token_scopes text[],
  p_token_granular_scopes jsonb,
  p_token_target_ids text[],
  p_token_expires_at timestamptz,
  p_token_data_access_expires_at timestamptz,
  p_token_validated_at timestamptz,
  p_validation_lease_token uuid
)
returns table (
  account_id uuid,
  onboarding_status text,
  subscription_status text,
  contacts_status text,
  history_status text,
  sync_deadline_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  attempt public.whatsapp_embedded_signup_attempts%rowtype;
  account public.whatsapp_coexistence_accounts%rowtype;
  source_job public.whatsapp_onboarding_outbox%rowtype;
  app_generation_id uuid;
  history_generation_id uuid;
  current_history_job_id uuid;
  token_secret_id uuid;
  next_token_generation bigint;
  secret_name text;
  secret_count integer;
  secret_value text;
  checkpoint_count integer;
  history_evidence_count integer := 0;
  provisioned_at_value timestamptz := clock_timestamp();
  finish_received_at_value timestamptz;
  deadline_value timestamptz;
  source_history_requested_at timestamptz;
  reuse_prior_history boolean := false;
  history_review_required boolean := false;
  history_reonboard_state_value text := 'not_applicable';
begin
  perform public.assert_whatsapp_embedded_signup_admin(p_admin_user_id);
  if trim(coalesce(p_verified_business_portfolio_id, '')) !~ '^[0-9]{5,64}$'
    or trim(coalesce(p_verified_waba_id, '')) !~ '^[0-9]{5,64}$'
    or trim(coalesce(p_verified_phone_number_id, '')) !~ '^[0-9]{5,64}$'
    or p_token_is_valid is distinct from true
    or trim(coalesce(p_token_app_id, '')) !~ '^[0-9]{5,64}$'
    or not public.is_valid_whatsapp_business_token_metadata(
      p_token_scopes, p_token_granular_scopes, p_token_target_ids
    )
    or not ('whatsapp_business_management' = any(p_token_scopes))
    or not ('whatsapp_business_messaging' = any(p_token_scopes))
    or not (trim(p_verified_waba_id) = any(p_token_target_ids))
    or (
      p_token_expires_at is not null
      and p_token_expires_at
        <= provisioned_at_value + interval '15 minutes'
    )
    or (
      p_token_data_access_expires_at is not null
      and p_token_data_access_expires_at
        <= provisioned_at_value + interval '15 minutes'
    )
    or p_token_validated_at is null
    or p_token_validated_at > provisioned_at_value + interval '5 minutes'
    or p_token_validated_at < provisioned_at_value - interval '10 minutes'
  then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_COMPLETION_INVALID'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'whatsapp-embedded-signup-waba:' || trim(p_verified_waba_id),
    0
  ));
  select * into attempt
  from public.whatsapp_embedded_signup_attempts candidate
  where candidate.id = p_attempt_id
  for update;
  if not found
    or attempt.initiated_by <> p_admin_user_id
    or attempt.status <> 'validating'
    or attempt.code_exchanged_at is null
    or attempt.temporary_token_secret_id is null
    or attempt.validation_deadline_at <= clock_timestamp()
    or attempt.validation_lease_token is distinct from p_validation_lease_token
    or attempt.validation_lease_expires_at <= clock_timestamp()
    or attempt.post_exchange_token_validated_at is null
    or attempt.pre_completion_token_is_valid is distinct from true
    or attempt.pre_completion_token_error_code is not null
    or attempt.pre_completion_token_validated_at is null
    or attempt.pre_completion_token_validated_at
      <= attempt.post_exchange_token_validated_at
    or p_token_is_valid is distinct from attempt.pre_completion_token_is_valid
    or trim(p_token_app_id)
      is distinct from attempt.pre_completion_token_app_id
    or p_token_scopes is distinct from attempt.pre_completion_token_scopes
    or p_token_granular_scopes
      is distinct from attempt.pre_completion_token_granular_scopes
    or p_token_target_ids
      is distinct from attempt.pre_completion_token_target_ids
    or p_token_expires_at
      is distinct from attempt.pre_completion_token_expires_at
    or p_token_data_access_expires_at
      is distinct from attempt.pre_completion_token_data_access_expires_at
    or p_token_validated_at
      is distinct from attempt.pre_completion_token_validated_at
  then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_COMPLETION_STATE_INVALID'
      using errcode = '55000';
  end if;
  finish_received_at_value := attempt.callback_received_at;
  deadline_value := finish_received_at_value + interval '24 hours';
  if attempt.pre_completion_token_app_id <> attempt.app_id
    or not exists (
      select 1
      from jsonb_array_elements(
        attempt.pre_completion_token_granular_scopes
      ) granular
      where granular ->> 'scope' = 'whatsapp_business_management'
        and granular -> 'target_ids' ? trim(p_verified_waba_id)
    )
    or not exists (
      select 1
      from jsonb_array_elements(
        attempt.pre_completion_token_granular_scopes
      ) granular
      where granular ->> 'scope' = 'whatsapp_business_messaging'
        and granular -> 'target_ids' ? trim(p_verified_waba_id)
    )
  then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_TOKEN_METADATA_MISMATCH'
      using errcode = '23514';
  end if;
  if (
      attempt.submitted_business_portfolio_id is not null
      and attempt.submitted_business_portfolio_id
        <> trim(p_verified_business_portfolio_id)
    )
    or attempt.submitted_waba_id <> trim(p_verified_waba_id)
    or (
      attempt.submitted_phone_number_id is not null
      and attempt.submitted_phone_number_id <> trim(p_verified_phone_number_id)
    )
    or attempt.history_sharing_decision = 'pending'
  then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_ASSET_MISMATCH'
      using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'whatsapp-embedded-signup-phone:' || trim(p_verified_phone_number_id),
    0
  ));
  select * into account
  from public.whatsapp_coexistence_accounts candidate
  where candidate.phone_number_id = trim(p_verified_phone_number_id)
  for update;

  if not found then
    insert into public.whatsapp_coexistence_accounts (
      client_scope,
      waba_id,
      phone_number_id,
      display_phone,
      coexistence_status,
      metadata
    ) values (
      attempt.client_scope,
      trim(p_verified_waba_id),
      trim(p_verified_phone_number_id),
      nullif(trim(coalesce(p_display_phone, '')), ''),
      'onboarding',
      jsonb_build_object('embedded_signup', true)
    ) returning * into account;
  elsif account.waba_id <> trim(p_verified_waba_id)
    or account.client_scope <> attempt.client_scope
    or (
      account.business_portfolio_id is not null
      and account.business_portfolio_id <> trim(p_verified_business_portfolio_id)
    )
  then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_IDENTITY_CONFLICT'
      using errcode = '23505';
  elsif (
      account.last_account_update_at is not null
      and account.last_account_update_at
        >= date_trunc('second', attempt.created_at)
    ) or (
      account.offboarding_requested_at is not null
      and account.offboarding_requested_at
        >= date_trunc('second', attempt.created_at)
    ) or (
      account.offboarded_at is not null
      and account.offboarded_at
        >= date_trunc('second', attempt.created_at)
    )
  then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_LIFECYCLE_CONFLICT'
      using errcode = '55000';
  elsif account.business_token_status = 'active'
    or account.onboarding_status in ('provisioning', 'completed', 'offboarding')
  then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_ALREADY_CONNECTED'
      using errcode = '55000';
  end if;

  -- Classify immutable prior evidence without changing it. A single exact
  -- root request may be carried. Every other topology enters durable review,
  -- promotes the valid credential, and suppresses any new history request.
  if attempt.history_sharing_decision = 'accepted' then
    select count(*) into history_evidence_count
    from public.whatsapp_onboarding_outbox prior_job
    join public.whatsapp_coexistence_accounts prior_account
      on prior_account.id = prior_job.account_id
    where prior_account.waba_id = trim(p_verified_waba_id)
      and prior_job.operation = 'request_history_sync'
      and prior_job.reused_from_job_id is null
      and (
        prior_job.attempts > 0
        or prior_job.remote_request_id is not null
        or prior_job.status in ('pending', 'processing', 'ambiguous')
      );

    if history_evidence_count = 1 then
      select prior_job.* into source_job
      from public.whatsapp_onboarding_outbox prior_job
      where prior_job.account_id = account.id
        and prior_job.operation = 'request_history_sync'
        and prior_job.reused_from_job_id is null
        and prior_job.status = 'succeeded'
        and prior_job.attempts > 0
        and prior_job.first_attempted_at is not null
        and prior_job.remote_request_id is not null
        and prior_job.completion_reason = 'remote_confirmed'
        and prior_job.completed_at is not null
        and prior_job.sync_generation_id is not null
      for share;

      source_history_requested_at := account.history_requested_at;
      reuse_prior_history := source_job.id is not null
        and account.onboarding_status = 'offboarded'
        and account.business_token_status = 'revoked'
        and account.offboarded_at is not null
        and account.history_sharing_decision = 'accepted'
        and (
          account.history_sync_generation_id = source_job.sync_generation_id
          or (
            account.history_reonboard_state
              = 'prior_remote_request_reused'
            and account.history_reonboard_source_job_id = source_job.id
          )
        )
        and account.history_request_id = source_job.remote_request_id
        and source_history_requested_at is not null;
    end if;

    if reuse_prior_history then
      history_reonboard_state_value := 'prior_remote_request_reused';
    elsif history_evidence_count > 0 then
      history_review_required := true;
      history_reonboard_state_value := 'prior_history_review_required';
    end if;
  end if;

  next_token_generation := account.business_token_generation + 1;
  secret_name := 'whatsapp_business_access_token_' || account.id::text;
  select count(*), min(secret.decrypted_secret)
  into secret_count, secret_value
  from vault.decrypted_secrets secret
  where secret.id = attempt.temporary_token_secret_id
    and secret.name = 'whatsapp_embedded_signup_token_' || attempt.id::text;
  if secret_count <> 1 or coalesce(secret_value, '') = ''
    or secret_value ~ E'[\\r\\n]' then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_TOKEN_UNAVAILABLE'
      using errcode = '55000';
  end if;
  if exists (
    select 1 from vault.secrets secret
    where secret.name = secret_name
      and secret.id <> attempt.temporary_token_secret_id
  ) then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_VAULT_SECRET_CONFLICT'
      using errcode = '55000';
  end if;
  perform vault.update_secret(
    attempt.temporary_token_secret_id,
    secret_value,
    secret_name,
    'WhatsApp business access token scoped to Coexistence account '
      || account.id::text
  );
  token_secret_id := attempt.temporary_token_secret_id;

  update public.whatsapp_coexistence_accounts
  set client_scope = attempt.client_scope,
      business_portfolio_id = trim(p_verified_business_portfolio_id),
      business_token_secret_id = token_secret_id,
      business_token_generation = next_token_generation,
      business_token_status = 'active',
      business_token_is_valid = true,
      business_token_app_id = attempt.pre_completion_token_app_id,
      business_token_scopes = attempt.pre_completion_token_scopes,
      business_token_granular_scopes =
        attempt.pre_completion_token_granular_scopes,
      business_token_target_ids = attempt.pre_completion_token_target_ids,
      business_token_expires_at = attempt.pre_completion_token_expires_at,
      business_token_data_access_expires_at =
        attempt.pre_completion_token_data_access_expires_at,
      business_token_last_validated_at =
        attempt.pre_completion_token_validated_at,
      business_token_validation_due_at =
        public.whatsapp_business_token_next_validation_at(
          attempt.pre_completion_token_validated_at,
          attempt.pre_completion_token_expires_at,
          attempt.pre_completion_token_data_access_expires_at
        ),
      business_token_validation_status = 'valid',
      business_token_last_validation_error_code = null,
      attention_required = history_review_required,
      attention_required_at = case
        when history_review_required then provisioned_at_value else null
      end,
      attention_required_reason = case
        when history_review_required
          then 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
        else null
      end,
      onboarding_status = 'provisioning',
      onboarded_by = p_admin_user_id,
      onboarding_completed_at = finish_received_at_value,
      initial_sync_deadline_at = deadline_value,
      history_sharing_decision = attempt.history_sharing_decision,
      history_reonboard_state = history_reonboard_state_value,
      history_reonboard_source_job_id = case
        when reuse_prior_history then source_job.id else null
      end,
      history_reonboard_recorded_at = case
        when history_reonboard_state_value <> 'not_applicable'
          then provisioned_at_value
        else null
      end,
      app_subscription_status = 'pending',
      app_subscribed_at = null,
      last_account_update_at = null,
      last_account_update_event = null,
      last_disconnection_reason = null,
      last_disconnection_initiated_by = null,
      offboarding_requested_at = null,
      offboarded_at = null,
      onboarding_last_error_code = case
        when history_review_required
          then 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
        else null
      end,
      coexistence_status = 'onboarding',
      display_phone = coalesce(
        nullif(trim(coalesce(p_display_phone, '')), ''),
        display_phone
      )
  where id = account.id
  returning * into account;

  update public.whatsapp_business_token_validations validation
  set account_id = account.id,
      token_generation = next_token_generation
  where validation.onboarding_attempt_id = attempt.id
    and validation.validation_reason in ('post_exchange', 'pre_completion')
    and validation.authorization_valid;
  get diagnostics checkpoint_count = row_count;
  if checkpoint_count < 2 then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_CHECKPOINT_LEDGER_INCOMPLETE'
      using errcode = '55000';
  end if;

  perform public.schedule_whatsapp_business_token_validation(
    account.id,
    next_token_generation,
    public.whatsapp_business_token_next_validation_at(
      attempt.pre_completion_token_validated_at,
      attempt.pre_completion_token_expires_at,
      attempt.pre_completion_token_data_access_expires_at
    ),
    'periodic'
  );

  select app_state_sync_generation_id into app_generation_id
  from public.start_whatsapp_coexistence_sync_generation(
    account.id,
    'smb_app_state_sync',
    null,
    provisioned_at_value
  );
  if attempt.history_sharing_decision = 'accepted'
    and not history_review_required
  then
    select history_sync_generation_id into history_generation_id
    from public.start_whatsapp_coexistence_sync_generation(
      account.id,
      'history',
      null,
      provisioned_at_value
    );
  elsif history_review_required then
    history_generation_id := gen_random_uuid();
    update public.whatsapp_coexistence_accounts
    set history_sync_generation_id = history_generation_id,
        history_sync_status = 'idle',
        history_sync_progress = null,
        history_request_id = null,
        history_requested_at = null,
        history_sync_started_at = null,
        history_sync_completed_at = null,
        history_sync_error = null
    where id = account.id;
    perform public.refresh_whatsapp_coexistence_sync_state(account.id);
  end if;

  update public.whatsapp_coexistence_accounts
  set app_state_sync_token_generation = next_token_generation,
      history_sync_token_generation = case
        when attempt.history_sharing_decision = 'accepted'
          and not history_review_required
          then next_token_generation
        else null
      end,
      history_request_id = case
        when reuse_prior_history then source_job.remote_request_id
        else history_request_id
      end,
      history_requested_at = case
        when reuse_prior_history then source_history_requested_at
        else history_requested_at
      end
  where id = account.id;

  insert into public.whatsapp_onboarding_outbox (
    account_id, onboarding_attempt_id, token_generation, operation,
    idempotency_key, deadline_at, sync_generation_id
  ) values
  (
    account.id, attempt.id, next_token_generation, 'subscribe_app',
    'embedded:' || account.id::text || ':'
      || next_token_generation::text || ':subscribe',
    deadline_value, null
  ),
  (
    account.id, attempt.id, next_token_generation, 'request_contacts_sync',
    'embedded:' || account.id::text || ':'
      || next_token_generation::text || ':contacts',
    deadline_value, app_generation_id
  );

  if history_generation_id is not null and not history_review_required then
    if reuse_prior_history then
      insert into public.whatsapp_onboarding_outbox (
        account_id, onboarding_attempt_id, token_generation, operation,
        idempotency_key, status, attempts, deadline_at, sync_generation_id,
        completion_reason, reused_from_job_id, source_remote_request_id,
        completed_at
      ) values (
        account.id, attempt.id, next_token_generation,
        'request_history_sync',
        'embedded:' || account.id::text || ':'
          || next_token_generation::text || ':history',
        'succeeded', 0, deadline_value, history_generation_id,
        'prior_remote_request', source_job.id, source_job.remote_request_id,
        provisioned_at_value
      ) returning id into current_history_job_id;
    else
      insert into public.whatsapp_onboarding_outbox (
        account_id, onboarding_attempt_id, token_generation, operation,
        idempotency_key, deadline_at, sync_generation_id
      ) values (
        account.id, attempt.id, next_token_generation,
        'request_history_sync',
        'embedded:' || account.id::text || ':'
          || next_token_generation::text || ':history',
        deadline_value, history_generation_id
      );
    end if;
  end if;

  update public.whatsapp_embedded_signup_attempts
  set status = 'completed',
      account_id = account.id,
      completed_at = provisioned_at_value,
      validation_processing_started_at = null,
      validation_lease_expires_at = null,
      validation_lease_token = null,
      last_error_code = null
  where id = attempt.id;
  update public.whatsapp_coexistence_accounts
  set last_onboarding_attempt_id = attempt.id
  where id = account.id;

  update public.whatsapp_settings
  set display_phone = coalesce(account.display_phone, display_phone),
      integration_status = 'incomplete',
      sending_paused = true,
      sending_pause_reason = case
        when history_review_required
          then 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
        else 'COEXISTENCE_ONBOARDING'
      end,
      last_error = null,
      updated_at = clock_timestamp()
  where id = true;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    p_admin_user_id,
    'whatsapp.embedded_signup.completed',
    'whatsapp_coexistence_account',
    account.id,
    jsonb_build_object(
      'token_generation', next_token_generation,
      'history_decision', attempt.history_sharing_decision,
      'history_reonboard_state', history_reonboard_state_value,
      'sync_deadline_at', deadline_value
    )
  );

  if reuse_prior_history then
    insert into public.audit_logs (
      actor_user_id, action, entity_type, entity_id, metadata
    ) values (
      p_admin_user_id,
      'whatsapp.history_reonboard.prior_remote_request_reused',
      'whatsapp_coexistence_account',
      account.id,
      jsonb_build_object(
        'current_attempt_id', attempt.id,
        'current_history_job_id', current_history_job_id,
        'token_generation', next_token_generation,
        'source_job_id', source_job.id,
        'source_token_generation', source_job.token_generation,
        'source_sync_generation_id', source_job.sync_generation_id,
        'history_decision', 'accepted',
        'remote_history_post_repeated', false
      )
    );
  elsif history_review_required then
    insert into public.audit_logs (
      actor_user_id, action, entity_type, entity_id, metadata
    ) values (
      p_admin_user_id,
      'whatsapp.history_reonboard.review_required',
      'whatsapp_coexistence_account',
      account.id,
      jsonb_build_object(
        'current_attempt_id', attempt.id,
        'token_generation', next_token_generation,
        'prior_evidence_count', history_evidence_count,
        'history_decision', 'accepted',
        'remote_history_post_repeated', false
      )
    );
  end if;

  return query
  select
    account.id,
    'provisioning'::text,
    'pending'::text,
    'pending'::text,
    case
      when history_review_required then 'review_required'
      when attempt.history_sharing_decision = 'accepted' then 'pending'
      else 'declined'
    end,
    deadline_value;
end;
$$;

revoke execute on function public.complete_whatsapp_embedded_signup(
  uuid, uuid, text, text, text, text, boolean, text, text[], jsonb, text[],
  timestamptz, timestamptz, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.complete_whatsapp_embedded_signup(
  uuid, uuid, text, text, text, text, boolean, text, text[], jsonb, text[],
  timestamptz, timestamptz, timestamptz, uuid
) to service_role;

-- Durable manual-review evidence is a fail-closed onboarding gate. Subscription
-- and contacts may finish, but only an exact carried request can satisfy the
-- history branch without issuing another request_history_sync operation.
create or replace function public.recompute_whatsapp_embedded_signup_onboarding(
  p_account_id uuid,
  p_token_generation bigint
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  account public.whatsapp_coexistence_accounts%rowtype;
  all_required_succeeded boolean;
  operational_failure boolean := false;
  operational_error_code text;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  select * into account
  from public.whatsapp_coexistence_accounts candidate
  where candidate.id = p_account_id
    and candidate.business_token_generation = p_token_generation
  for update;
  if not found
    or account.onboarding_status in ('offboarding', 'offboarded')
    or account.business_token_status <> 'active'
  then
    return false;
  end if;

  -- Manual history review is intentionally not a successful onboarding
  -- dependency. Subscription and contacts may finish, but no generic job
  -- completion or periodic reconciliation may promote this account. A real
  -- current-generation operational failure remains authoritative: review is
  -- an additional gate and must never resurrect or hide that failure.
  if account.history_reonboard_state = 'prior_history_review_required' then
    select
      exists (
        select 1
        from public.whatsapp_onboarding_outbox job
        where job.account_id = account.id
          and job.token_generation = p_token_generation
          and job.operation in ('subscribe_app', 'request_contacts_sync')
          and job.status in ('failed', 'ambiguous')
      ),
      coalesce(
        case
          when account.onboarding_last_error_code is distinct from
            'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
            then account.onboarding_last_error_code
          else null
        end,
        (
          select job.last_error_code
          from public.whatsapp_onboarding_outbox job
          where job.account_id = account.id
            and job.token_generation = p_token_generation
            and job.operation in ('subscribe_app', 'request_contacts_sync')
            and job.status in ('failed', 'ambiguous')
            and job.last_error_code is not null
          order by job.updated_at desc, job.id
          limit 1
        )
      )
    into operational_failure, operational_error_code;

    update public.whatsapp_coexistence_accounts
    set onboarding_status = case
          when operational_failure then 'failed' else 'provisioning'
        end,
        coexistence_status = 'onboarding',
        attention_required = true,
        attention_required_at = coalesce(
          attention_required_at,
          history_reonboard_recorded_at,
          clock_timestamp()
        ),
        attention_required_reason =
          'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW',
        onboarding_last_error_code = case
          when operational_failure then coalesce(
            operational_error_code,
            'WHATSAPP_ONBOARDING_OPERATION_FAILED'
          )
          else 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
        end
    where id = account.id
      and business_token_generation = p_token_generation;
    update public.whatsapp_settings
    set integration_status = 'incomplete',
        sending_paused = true,
        sending_pause_reason =
          'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW',
        updated_at = clock_timestamp()
    where id = true;
    return false;
  end if;

  select
    exists (
      select 1 from public.whatsapp_onboarding_outbox job
      where job.account_id = account.id
        and job.token_generation = p_token_generation
        and job.operation = 'subscribe_app'
        and job.status = 'succeeded'
    )
    and exists (
      select 1 from public.whatsapp_onboarding_outbox job
      where job.account_id = account.id
        and job.token_generation = p_token_generation
        and job.operation = 'request_contacts_sync'
        and job.status = 'succeeded'
    )
    and (
      account.history_sharing_decision = 'declined'
      or exists (
        select 1 from public.whatsapp_onboarding_outbox job
        where job.account_id = account.id
          and job.token_generation = p_token_generation
          and job.operation = 'request_history_sync'
          and job.status = 'succeeded'
      )
    )
  into all_required_succeeded;

  if not all_required_succeeded then
    return false;
  end if;

  update public.whatsapp_coexistence_accounts
  set onboarding_status = 'completed',
      coexistence_status = 'active',
      onboarding_last_error_code = null
  where id = account.id
    and business_token_generation = p_token_generation;
  update public.whatsapp_settings
  set integration_status = 'connected',
      sending_paused = true,
      sending_pause_reason = 'COEXISTENCE_ONBOARDING',
      updated_at = clock_timestamp()
  where id = true;
  return true;
end;
$$;

revoke execute on function
  public.recompute_whatsapp_embedded_signup_onboarding(uuid, bigint)
  from public, anon, authenticated, service_role;

-- Current-generation jobs continue to authorize current requests exactly as
-- before. A carried history generation is the sole exception: authorization
-- is bound to the exact root job + real request ID and to events no older than
-- that one remote attempt. The new onboarding timestamp is intentionally not
-- used because Meta may deliver the old request after re-onboarding.
create or replace function public.enqueue_whatsapp_coexistence_event(
  p_account_id uuid,
  p_external_event_id text,
  p_field text,
  p_payload jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns public.whatsapp_coexistence_events
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  result public.whatsapp_coexistence_events%rowtype;
  account public.whatsapp_coexistence_accounts%rowtype;
  clean_external_event_id text := trim(coalesce(p_external_event_id, ''));
  incoming_hash text;
  event_generation_id uuid;
  embedded_account boolean;
  entry_time timestamptz;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  select * into account
  from public.whatsapp_coexistence_accounts candidate
  where candidate.id = p_account_id
  for update;
  if not found then
    raise exception 'WHATSAPP_COEXISTENCE_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;
  if char_length(clean_external_event_id) not between 8 and 240
    or p_field not in (
      'messages', 'history', 'smb_app_state_sync', 'smb_message_echoes'
    )
    or jsonb_typeof(p_payload) <> 'object'
    or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object'
  then
    raise exception 'WHATSAPP_COEXISTENCE_EVENT_INVALID'
      using errcode = '22023';
  end if;

  embedded_account := account.last_onboarding_attempt_id is not null
    or account.business_token_generation > 0;
  if embedded_account and (
      account.business_token_status <> 'active'
      or account.business_token_secret_id is null
      or (
        account.business_token_expires_at is not null
        and account.business_token_expires_at <= clock_timestamp()
      )
      or account.onboarding_status not in ('provisioning', 'completed')
      or account.offboarded_at is not null
    )
  then
    raise exception 'WHATSAPP_COEXISTENCE_EVENT_ACCOUNT_INACTIVE'
      using errcode = '55000';
  end if;

  event_generation_id := case p_field
    when 'history' then account.history_sync_generation_id
    when 'smb_app_state_sync' then account.app_state_sync_generation_id
    else null
  end;
  if embedded_account and p_field in ('history', 'smb_app_state_sync') then
    begin
      entry_time := (p_metadata ->> 'entry_time')::timestamptz;
    exception when others then
      raise exception 'WHATSAPP_COEXISTENCE_SYNC_EVENT_TIME_INVALID'
        using errcode = '22023';
    end;
    if entry_time is null
      or entry_time > clock_timestamp() + interval '5 minutes'
    then
      raise exception 'WHATSAPP_COEXISTENCE_SYNC_EVENT_TIME_INVALID'
        using errcode = '22023';
    end if;
    if (
        p_field = 'history'
        and (
          account.history_sharing_decision <> 'accepted'
          or account.history_sync_token_generation
            is distinct from account.business_token_generation
          or account.history_sync_status not in (
            'pending', 'in_progress', 'partial', 'completed'
          )
        )
      ) or (
        p_field = 'smb_app_state_sync'
        and (
          account.app_state_sync_token_generation
            is distinct from account.business_token_generation
          or account.app_state_sync_status not in (
            'pending', 'in_progress', 'partial', 'completed'
          )
        )
      ) or not (
        exists (
          select 1
          from public.whatsapp_onboarding_outbox job
          where job.account_id = account.id
            and job.token_generation = account.business_token_generation
            and job.sync_generation_id = event_generation_id
            and job.operation = case p_field
              when 'history' then 'request_history_sync'
              else 'request_contacts_sync'
            end
            and job.attempts > 0
            and job.first_attempted_at is not null
            and entry_time >= date_trunc('second', job.first_attempted_at)
            and entry_time >= date_trunc(
              'second', account.onboarding_completed_at
            )
            and job.status in (
              'processing', 'succeeded', 'ambiguous', 'failed'
            )
        )
        or (
          p_field = 'history'
          and account.history_reonboard_state
            = 'prior_remote_request_reused'
          and exists (
            select 1
            from public.whatsapp_onboarding_outbox carry_job
            join public.whatsapp_onboarding_outbox source_job
              on source_job.id = carry_job.reused_from_job_id
            where carry_job.account_id = account.id
              and carry_job.token_generation
                = account.business_token_generation
              and carry_job.sync_generation_id = event_generation_id
              and carry_job.operation = 'request_history_sync'
              and carry_job.status = 'succeeded'
              and carry_job.attempts = 0
              and carry_job.first_attempted_at is null
              and carry_job.completion_reason = 'prior_remote_request'
              and carry_job.source_remote_request_id
                = source_job.remote_request_id
              and carry_job.source_remote_request_id
                = account.history_request_id
              and source_job.id = account.history_reonboard_source_job_id
              and source_job.account_id = account.id
              and source_job.operation = 'request_history_sync'
              and source_job.status = 'succeeded'
              and source_job.attempts > 0
              and source_job.first_attempted_at is not null
              and source_job.remote_request_id is not null
              and source_job.completion_reason = 'remote_confirmed'
              and source_job.reused_from_job_id is null
              and 1 = (
                select count(*)
                from public.whatsapp_onboarding_outbox canonical_job
                join public.whatsapp_coexistence_accounts canonical_account
                  on canonical_account.id = canonical_job.account_id
                where canonical_account.waba_id = account.waba_id
                  and canonical_job.operation = 'request_history_sync'
                  and canonical_job.reused_from_job_id is null
                  and (
                    canonical_job.attempts > 0
                    or canonical_job.remote_request_id is not null
                    or canonical_job.status in (
                      'pending', 'processing', 'ambiguous'
                    )
                  )
              )
              and entry_time >= date_trunc(
                'second', source_job.first_attempted_at
              )
          )
        )
      )
    then
      raise exception 'WHATSAPP_COEXISTENCE_SYNC_EVENT_NOT_AUTHORIZED'
        using errcode = '42501';
    end if;
  end if;

  incoming_hash := md5(p_payload::text);
  insert into public.whatsapp_coexistence_events (
    account_id, external_event_id, field, sync_generation_id,
    payload, payload_hash, metadata
  ) values (
    account.id, clean_external_event_id, p_field, event_generation_id,
    p_payload, incoming_hash, coalesce(p_metadata, '{}'::jsonb)
  ) on conflict (external_event_id) do nothing
  returning * into result;
  if result.id is null then
    select * into result
    from public.whatsapp_coexistence_events event
    where event.external_event_id = clean_external_event_id
    for update;
    if result.account_id <> account.id
      or result.field <> p_field
      or result.payload_hash <> incoming_hash
    then
      raise exception 'WHATSAPP_COEXISTENCE_EVENT_ID_COLLISION'
        using errcode = '23505';
    end if;
  end if;
  update public.whatsapp_coexistence_accounts
  set last_webhook_at = clock_timestamp()
  where id = account.id;
  return result;
end;
$$;

revoke execute on function public.enqueue_whatsapp_coexistence_event(
  uuid, text, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.enqueue_whatsapp_coexistence_event(
  uuid, text, text, jsonb, jsonb
) to service_role;
