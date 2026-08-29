-- A successful/idempotent onboarding reconciliation must not overwrite the
-- operational sending control. START/completion establishes the initial
-- fail-closed COEXISTENCE_ONBOARDING pause; after an authorized, audited
-- resume, later recovery passes preserve that explicit decision. Review and
-- incomplete branches below continue to force their safety pauses.
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
  subscription_succeeded boolean := false;
  contacts_succeeded boolean := false;
  contacts_failure_tolerated boolean := false;
  history_ready boolean := false;
  all_required_succeeded boolean := false;
  operational_failure boolean := false;
  operational_error_code text;
  was_connected boolean := false;
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

  -- An ambiguous prior history request remains a hard manual-review gate.
  -- This exception is only for a proven terminal contacts rejection and must
  -- never weaken the history recovery rules.
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
      select 1
      from public.whatsapp_onboarding_outbox job
      where job.account_id = account.id
        and job.token_generation = p_token_generation
        and job.operation = 'subscribe_app'
        and job.status = 'succeeded'
    ),
    exists (
      select 1
      from public.whatsapp_onboarding_outbox job
      where job.account_id = account.id
        and job.token_generation = p_token_generation
        and job.operation = 'request_contacts_sync'
        and job.status = 'succeeded'
    ),
    exists (
      select 1
      from public.whatsapp_onboarding_outbox job
      where job.account_id = account.id
        and job.token_generation = p_token_generation
        and job.operation = 'request_contacts_sync'
        and job.status = 'failed'
        and job.last_error_code = 'APP_DATA_SYNC_REJECTED'
        and job.attempts >= job.max_attempts
        and job.failed_at is not null
        and job.sync_generation_id = account.app_state_sync_generation_id
        and account.app_state_sync_token_generation = p_token_generation
        and account.app_state_sync_status = 'failed'
        and account.app_state_sync_error = 'APP_DATA_SYNC_REJECTED'
        and exists (
          select 1
          from public.whatsapp_coexistence_sync_generation_failures failure
          where failure.account_id = account.id
            and failure.sync_type = 'smb_app_state_sync'
            and failure.sync_generation_id = job.sync_generation_id
            and failure.failure_kind = 'request_failed'
            and failure.error = 'APP_DATA_SYNC_REJECTED'
        )
    ) and not exists (
      select 1
      from public.whatsapp_onboarding_outbox job
      where job.account_id = account.id
        and job.token_generation = p_token_generation
        and job.operation = 'request_contacts_sync'
        and job.status in ('pending', 'processing', 'ambiguous')
    ),
    account.history_sharing_decision = 'declined'
      or (
        account.history_sharing_decision = 'accepted'
        and account.history_sync_token_generation = p_token_generation
        and account.history_sync_status in (
          'pending', 'in_progress', 'partial', 'completed'
        )
        and exists (
          select 1
          from public.whatsapp_onboarding_outbox history_job
          where history_job.account_id = account.id
            and history_job.token_generation = p_token_generation
            and history_job.operation = 'request_history_sync'
            and history_job.status = 'succeeded'
            and history_job.sync_generation_id
              = account.history_sync_generation_id
            and (
              (
                history_job.attempts > 0
                and history_job.first_attempted_at is not null
                and history_job.remote_request_id is not null
                and history_job.remote_request_id = account.history_request_id
                and history_job.completion_reason in (
                  'remote_confirmed', 'already_applied', 'webhook_observed'
                )
                and history_job.reused_from_job_id is null
                and history_job.source_remote_request_id is null
              )
              or (
                account.history_reonboard_state
                  = 'prior_remote_request_reused'
                and history_job.attempts = 0
                and history_job.first_attempted_at is null
                and history_job.remote_request_id is null
                and history_job.completion_reason = 'prior_remote_request'
                and history_job.reused_from_job_id is not null
                and history_job.source_remote_request_id is not null
                and history_job.source_remote_request_id
                  = account.history_request_id
                and exists (
                  select 1
                  from public.whatsapp_onboarding_outbox source_job
                  where source_job.id = history_job.reused_from_job_id
                    and source_job.id
                      = account.history_reonboard_source_job_id
                    and source_job.account_id = account.id
                    and source_job.operation = 'request_history_sync'
                    and source_job.status = 'succeeded'
                    and source_job.attempts > 0
                    and source_job.first_attempted_at is not null
                    and source_job.remote_request_id is not null
                    and source_job.remote_request_id
                      = history_job.source_remote_request_id
                    and source_job.completion_reason = 'remote_confirmed'
                    and source_job.reused_from_job_id is null
                    and source_job.source_remote_request_id is null
                )
              )
            )
        )
      )
  into subscription_succeeded, contacts_succeeded,
    contacts_failure_tolerated, history_ready;

  all_required_succeeded := subscription_succeeded
    and account.app_subscription_status = 'subscribed'
    and (contacts_succeeded or contacts_failure_tolerated)
    and history_ready
    and not account.attention_required
    and (
      not contacts_failure_tolerated
      or (
        account.business_token_secret_id is not null
        and account.business_token_validation_status = 'valid'
        and account.business_token_is_valid
        and account.business_token_validation_due_at > clock_timestamp()
        and (
          account.business_token_expires_at is null
          or account.business_token_expires_at > clock_timestamp()
        )
        and (
          account.business_token_data_access_expires_at is null
          or account.business_token_data_access_expires_at
            > clock_timestamp()
        )
        and account.offboarded_at is null
      )
    );

  if not all_required_succeeded then
    return false;
  end if;

  was_connected := account.onboarding_status = 'completed'
    and account.coexistence_status = 'active';

  update public.whatsapp_coexistence_accounts
  set onboarding_status = 'completed',
      coexistence_status = 'active',
      onboarding_last_error_code = case
        when contacts_failure_tolerated then 'APP_DATA_SYNC_REJECTED'
        else null
      end
  where id = account.id
    and business_token_generation = p_token_generation;

  -- Reconciliation owns connection health, not the operator's sending
  -- control. Initial onboarding remains paused because completion establishes
  -- that pause before this function is called.
  update public.whatsapp_settings
  set integration_status = 'connected',
      updated_at = clock_timestamp()
  where id = true
    and integration_status is distinct from 'connected';

  if contacts_failure_tolerated and not was_connected then
    insert into public.audit_logs (
      action, entity_type, entity_id, metadata
    ) values (
      'whatsapp.onboarding.connected_with_contacts_sync_failure',
      'whatsapp_coexistence_account',
      account.id,
      jsonb_build_object(
        'token_generation', p_token_generation,
        'contacts_error_code', 'APP_DATA_SYNC_REJECTED',
        'contacts_status', 'failed',
        'outbound_sending_paused', true
      )
    );
  end if;
  return true;
end;
$$;

revoke execute on function
  public.recompute_whatsapp_embedded_signup_onboarding(uuid, bigint)
  from public, anon, authenticated, service_role;
