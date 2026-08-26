-- Secure, durable primitives for WhatsApp Embedded Signup v4.
--
-- This migration is deliberately inert: it creates no Vault secret, cron job,
-- pg_net request, Meta call or onboarding row. Browser code receives only
-- sanitized state through Edge Functions. Authorization codes and business
-- access tokens are never persisted in public tables.

do $$
begin
  if not exists (
    select 1 from pg_extension where extname = 'supabase_vault'
  ) then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_VAULT_UNAVAILABLE'
      using errcode = '55000';
  end if;
end;
$$;

-- Embedded Signup credentials are scoped to one Coexistence account and
-- referenced by UUID only. Every Graph caller must resolve the exact account;
-- legacy credentials are never a fallback for an Embedded-managed identity.
alter table public.whatsapp_coexistence_accounts
  add column client_scope text not null default 'gisela-lentz-wp',
  add column business_portfolio_id text,
  add column business_token_secret_id uuid,
  add column business_token_generation bigint not null default 0,
  add column business_token_status text not null default 'missing',
  add column business_token_is_valid boolean,
  add column business_token_app_id text,
  add column business_token_scopes text[] not null default '{}'::text[],
  add column business_token_granular_scopes jsonb not null default '[]'::jsonb,
  add column business_token_target_ids text[] not null default '{}'::text[],
  add column business_token_expires_at timestamptz,
  add column business_token_data_access_expires_at timestamptz,
  add column business_token_last_validated_at timestamptz,
  add column business_token_validation_due_at timestamptz,
  add column business_token_validation_status text not null default 'missing',
  add column business_token_last_validation_error_code text,
  add column attention_required boolean not null default false,
  add column attention_required_at timestamptz,
  add column attention_required_reason text,
  add column onboarding_status text not null default 'not_started',
  add column onboarded_by uuid references public.profiles (id) on delete set null,
  add column onboarding_completed_at timestamptz,
  add column initial_sync_deadline_at timestamptz,
  add column history_sharing_decision text not null default 'pending',
  add column history_sync_token_generation bigint,
  add column app_state_sync_token_generation bigint,
  add column app_subscription_status text not null default 'not_subscribed',
  add column app_subscribed_at timestamptz,
  add column last_account_update_at timestamptz,
  add column last_account_update_event text,
  add column last_disconnection_reason text,
  add column last_disconnection_initiated_by text,
  add column offboarding_requested_at timestamptz,
  add column offboarded_at timestamptz,
  add column onboarding_last_error_code text,
  add constraint whatsapp_coexistence_accounts_client_scope_check check (
    client_scope ~ '^[a-z0-9][a-z0-9._:-]{2,99}$'
  ),
  add constraint whatsapp_coexistence_accounts_portfolio_check check (
    business_portfolio_id is null
    or business_portfolio_id ~ '^[0-9]{5,64}$'
  ),
  add constraint whatsapp_coexistence_accounts_token_generation_check check (
    business_token_generation >= 0
  ),
  add constraint whatsapp_coexistence_accounts_token_status_check check (
    business_token_status in (
      'missing', 'active', 'unknown', 'invalid', 'expired', 'revoked'
    )
  ),
  add constraint whatsapp_coexistence_accounts_token_reference_check check (
    (
      business_token_status in ('active', 'unknown', 'invalid', 'expired')
      and business_token_secret_id is not null
      and business_token_generation > 0
    )
    or (
      business_token_status = 'missing'
      and business_token_secret_id is null
      and business_token_generation = 0
      and business_token_expires_at is null
      and business_token_data_access_expires_at is null
    )
    or (
      business_token_status = 'revoked'
      and business_token_generation > 0
      and (
        business_token_secret_id is not null
        or (
          business_token_expires_at is null
          and business_token_data_access_expires_at is null
        )
      )
    )
  ),
  add constraint whatsapp_coexistence_accounts_token_metadata_check check (
    (business_token_app_id is null or business_token_app_id ~ '^[0-9]{5,64}$')
    and cardinality(business_token_scopes) <= 100
    and cardinality(business_token_target_ids) <= 500
    and jsonb_typeof(business_token_granular_scopes) = 'array'
    and octet_length(business_token_granular_scopes::text) <= 32768
  ),
  add constraint whatsapp_coexistence_accounts_validation_status_check check (
    business_token_validation_status in (
      'missing', 'valid', 'unknown', 'invalid', 'expired'
    )
  ),
  add constraint whatsapp_coexistence_accounts_validation_state_check check (
    (
      business_token_validation_status = 'missing'
      and business_token_is_valid is null
      and business_token_last_validated_at is null
      and business_token_validation_due_at is null
    )
    or (
      business_token_validation_status = 'valid'
      and business_token_is_valid
      and business_token_app_id is not null
      and business_token_last_validated_at is not null
      and business_token_validation_due_at
        > business_token_last_validated_at
    )
    or (
      business_token_validation_status = 'unknown'
      and business_token_is_valid is null
    )
    or (
      business_token_validation_status in ('invalid', 'expired')
      and business_token_is_valid = false
    )
  ),
  add constraint whatsapp_coexistence_accounts_validation_error_check check (
    business_token_last_validation_error_code is null
    or business_token_last_validation_error_code ~ '^[A-Z0-9_]{3,100}$'
  ),
  add constraint whatsapp_coexistence_accounts_attention_check check (
    (
      not attention_required
      and attention_required_at is null
      and attention_required_reason is null
    )
    or (
      attention_required
      and attention_required_at is not null
      and attention_required_reason ~ '^[A-Z0-9_]{3,100}$'
    )
  ),
  add constraint whatsapp_coexistence_accounts_onboarding_status_check check (
    onboarding_status in (
      'not_started', 'provisioning', 'completed', 'failed',
      'offboarding', 'offboarded'
    )
  ),
  add constraint whatsapp_coexistence_accounts_history_decision_check check (
    history_sharing_decision in ('pending', 'accepted', 'declined')
  ),
  add constraint whatsapp_coexistence_accounts_sync_token_generation_check check (
    (
      history_sync_token_generation is null
      or history_sync_token_generation > 0
    )
    and (
      app_state_sync_token_generation is null
      or app_state_sync_token_generation > 0
    )
  ),
  add constraint whatsapp_coexistence_accounts_subscription_status_check check (
    app_subscription_status in (
      'not_subscribed', 'pending', 'subscribed', 'failed',
      'unsubscribing', 'unsubscribed', 'unknown'
    )
  ),
  add constraint whatsapp_coexistence_accounts_onboarding_window_check check (
    (
      onboarding_completed_at is null
      and initial_sync_deadline_at is null
    )
    or initial_sync_deadline_at
      = onboarding_completed_at + interval '24 hours'
  ),
  add constraint whatsapp_coexistence_accounts_subscription_timestamp_check check (
    (app_subscription_status = 'subscribed' and app_subscribed_at is not null)
    or (app_subscription_status <> 'subscribed')
  ),
  add constraint whatsapp_coexistence_accounts_account_update_check check (
    (
      last_account_update_at is null
      and last_account_update_event is null
    )
    or (
      last_account_update_at is not null
      and last_account_update_event in (
        'PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED', 'ACCOUNT_RECONNECTED'
      )
    )
  ),
  add constraint whatsapp_coexistence_accounts_disconnection_check check (
    (
      last_disconnection_reason is null
      and last_disconnection_initiated_by is null
    )
    or (
      last_account_update_event = 'PARTNER_REMOVED'
      and last_disconnection_reason ~ '^[A-Z0-9_]{3,100}$'
      and last_disconnection_initiated_by in ('USER', 'SYSTEM')
    )
  ),
  add constraint whatsapp_coexistence_accounts_onboarding_error_check check (
    onboarding_last_error_code is null
    or onboarding_last_error_code ~ '^[A-Z0-9_]{3,100}$'
  );

create unique index whatsapp_coexistence_accounts_token_secret_idx
  on public.whatsapp_coexistence_accounts (business_token_secret_id)
  where business_token_secret_id is not null;

create index whatsapp_coexistence_accounts_scope_status_idx
  on public.whatsapp_coexistence_accounts (
    client_scope, onboarding_status, coexistence_status
  );

create or replace function public.is_valid_whatsapp_embedded_signup_asset_ids(
  p_asset_ids jsonb
)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  asset_key text;
  asset_values jsonb;
  asset_id jsonb;
  total_asset_ids integer := 0;
begin
  if jsonb_typeof(p_asset_ids) <> 'object'
    or octet_length(p_asset_ids::text) > 16384
  then
    return false;
  end if;
  for asset_key, asset_values in
    select entry.key, entry.value from jsonb_each(p_asset_ids) entry
  loop
    if asset_key not in (
      'ad_account_ids', 'page_ids', 'dataset_ids', 'catalog_ids',
      'instagram_account_ids', 'waba_ids'
    )
      or jsonb_typeof(asset_values) <> 'array'
      or jsonb_array_length(asset_values) > 100
    then
      return false;
    end if;
    total_asset_ids := total_asset_ids + jsonb_array_length(asset_values);
    if total_asset_ids > 100 then
      return false;
    end if;
    for asset_id in select value from jsonb_array_elements(asset_values)
    loop
      if jsonb_typeof(asset_id) <> 'string'
        or (asset_id #>> '{}') !~ '^[0-9]{5,64}$'
      then
        return false;
      end if;
    end loop;
  end loop;
  return true;
end;
$$;

create or replace function public.is_valid_whatsapp_business_token_metadata(
  p_scopes text[],
  p_granular_scopes jsonb,
  p_target_ids text[]
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  supplied_scope text;
  granular_scope jsonb;
  granular_target jsonb;
  total_targets integer := 0;
begin
  if p_scopes is null
    or cardinality(p_scopes) not between 1 and 100
    or p_granular_scopes is null
    or jsonb_typeof(p_granular_scopes) <> 'array'
    or jsonb_array_length(p_granular_scopes) > 100
    or octet_length(p_granular_scopes::text) > 32768
    or p_target_ids is null
    or cardinality(p_target_ids) not between 1 and 500
  then
    return false;
  end if;

  foreach supplied_scope in array p_scopes loop
    if supplied_scope is null
      or supplied_scope !~ '^[a-z][a-z0-9_]{1,99}$'
    then
      return false;
    end if;
  end loop;
  if cardinality(p_scopes) <> (
    select count(distinct scope_value)
    from unnest(p_scopes) scope_value
  ) then
    return false;
  end if;

  foreach supplied_scope in array p_target_ids loop
    if supplied_scope is null or supplied_scope !~ '^[0-9]{5,64}$' then
      return false;
    end if;
  end loop;
  if cardinality(p_target_ids) <> (
    select count(distinct target_value)
    from unnest(p_target_ids) target_value
  ) then
    return false;
  end if;

  for granular_scope in
    select value from jsonb_array_elements(p_granular_scopes)
  loop
    if jsonb_typeof(granular_scope) <> 'object'
      or not (granular_scope ? 'scope')
      or not (granular_scope ? 'target_ids')
      or granular_scope - 'scope' - 'target_ids' <> '{}'::jsonb
      or jsonb_typeof(granular_scope -> 'scope') <> 'string'
      or (granular_scope ->> 'scope') !~ '^[a-z][a-z0-9_]{1,99}$'
      or jsonb_typeof(granular_scope -> 'target_ids') <> 'array'
      or jsonb_array_length(granular_scope -> 'target_ids') > 500
    then
      return false;
    end if;
    total_targets := total_targets
      + jsonb_array_length(granular_scope -> 'target_ids');
    if total_targets > 1000 then return false; end if;
    for granular_target in
      select value
      from jsonb_array_elements(granular_scope -> 'target_ids')
    loop
      if jsonb_typeof(granular_target) <> 'string'
        or (granular_target #>> '{}') !~ '^[0-9]{5,64}$'
      then
        return false;
      end if;
    end loop;
  end loop;

  return true;
end;
$$;

create or replace function public.whatsapp_business_token_next_validation_at(
  p_validated_at timestamptz,
  p_expires_at timestamptz,
  p_data_access_expires_at timestamptz
)
returns timestamptz
language sql
immutable
set search_path = pg_catalog
as $$
  select min(candidate.due_at)
  from (values
    (p_validated_at + interval '24 hours'),
    (case when p_expires_at is null then null
      else p_expires_at - interval '15 minutes' end),
    (case when p_data_access_expires_at is null then null
      else p_data_access_expires_at - interval '15 minutes' end)
  ) candidate(due_at)
  where candidate.due_at is not null;
$$;

-- Persist the account identity on the conversation boundary. Legacy
-- conversations intentionally remain NULL; once an account is bound it cannot
-- be replaced by a message from another WABA/phone identity.
alter table public.conversations
  add column coexistence_account_id uuid
    references public.whatsapp_coexistence_accounts (id) on delete restrict;

do $conversation_account_backfill$
begin
  if exists (
    select message.conversation_id
    from public.messages message
    where message.coexistence_account_id is not null
    group by message.conversation_id
    having count(distinct message.coexistence_account_id) > 1
  ) then
    raise exception 'WHATSAPP_CONVERSATION_ACCOUNT_BACKFILL_CONFLICT'
      using errcode = '23514';
  end if;

  update public.conversations conversation
  set coexistence_account_id = source.account_id
  from (
    select message.conversation_id,
      (array_agg(message.coexistence_account_id order by message.created_at, message.id))[1] account_id
    from public.messages message
    where message.coexistence_account_id is not null
    group by message.conversation_id
  ) source
  where conversation.id = source.conversation_id;
end;
$conversation_account_backfill$;

create index conversations_coexistence_account_idx
  on public.conversations (coexistence_account_id, last_message_at desc)
  where coexistence_account_id is not null;

create or replace function public.bind_whatsapp_message_conversation_account()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  bound_account_id uuid;
begin
  select conversation.coexistence_account_id into bound_account_id
  from public.conversations conversation
  where conversation.id = new.conversation_id
  for update;
  if not found then
    raise exception 'WHATSAPP_CONVERSATION_NOT_FOUND' using errcode = '23503';
  end if;

  if bound_account_id is not null
    and new.coexistence_account_id is null
  then
    new.coexistence_account_id := bound_account_id;
  elsif bound_account_id is null
    and new.coexistence_account_id is not null
  then
    update public.conversations
    set coexistence_account_id = new.coexistence_account_id
    where id = new.conversation_id
      and coexistence_account_id is null;
  elsif bound_account_id is not null
    and new.coexistence_account_id is distinct from bound_account_id
  then
    raise exception 'WHATSAPP_CONVERSATION_ACCOUNT_MISMATCH'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger a_messages_bind_coexistence_account
  before insert or update of conversation_id, coexistence_account_id
  on public.messages
  for each row execute function public.bind_whatsapp_message_conversation_account();

create or replace function public.guard_whatsapp_conversation_account_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.coexistence_account_id is not null
    and new.coexistence_account_id is distinct from old.coexistence_account_id
  then
    raise exception 'WHATSAPP_CONVERSATION_ACCOUNT_IMMUTABLE'
      using errcode = '23514';
  end if;
  if new.coexistence_account_id is not null and exists (
    select 1
    from public.messages message
    where message.conversation_id = new.id
      and message.coexistence_account_id is not null
      and message.coexistence_account_id <> new.coexistence_account_id
  ) then
    raise exception 'WHATSAPP_CONVERSATION_ACCOUNT_MISMATCH'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger a_conversations_guard_coexistence_account
  before update of coexistence_account_id on public.conversations
  for each row execute function public.guard_whatsapp_conversation_account_change();

-- Keep the existing automation RPC stable while extending its immutable
-- execution snapshots with the routing identity required by every Graph
-- caller. The trigger also covers any future insert path outside that RPC.
create or replace function public.stamp_whatsapp_automation_account_snapshots()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  message_account_id uuid;
  conversation_account_id uuid;
begin
  select message.coexistence_account_id into message_account_id
  from public.messages message
  where message.id = new.message_id
    and message.conversation_id = new.conversation_id;
  if not found then
    raise exception 'WHATSAPP_AUTOMATION_SNAPSHOT_MESSAGE_INVALID'
      using errcode = '23503';
  end if;
  select conversation.coexistence_account_id into conversation_account_id
  from public.conversations conversation
  where conversation.id = new.conversation_id;
  if not found or message_account_id is distinct from conversation_account_id
  then
    raise exception 'WHATSAPP_AUTOMATION_SNAPSHOT_ACCOUNT_MISMATCH'
      using errcode = '23514';
  end if;
  new.message_snapshot := coalesce(new.message_snapshot, '{}'::jsonb)
    || jsonb_build_object('coexistence_account_id', message_account_id);
  new.conversation_snapshot := coalesce(
    new.conversation_snapshot, '{}'::jsonb
  ) || jsonb_build_object(
    'coexistence_account_id', conversation_account_id
  );
  return new;
end;
$$;

create trigger a_whatsapp_automation_stamp_account_snapshots
  before insert on public.whatsapp_automation_executions
  for each row execute function public.stamp_whatsapp_automation_account_snapshots();

update public.whatsapp_automation_executions execution
set message_snapshot = execution.message_snapshot || jsonb_build_object(
      'coexistence_account_id', message.coexistence_account_id
    ),
    conversation_snapshot = execution.conversation_snapshot
      || jsonb_build_object(
        'coexistence_account_id', conversation.coexistence_account_id
      )
from public.messages message
join public.conversations conversation
  on conversation.id = message.conversation_id
where execution.message_id = message.id
  and execution.conversation_id = conversation.id
  and execution.status <> 'completed'
  and (
    not execution.message_snapshot ? 'coexistence_account_id'
    or not execution.conversation_snapshot ? 'coexistence_account_id'
  );

create table public.whatsapp_embedded_signup_attempts (
  id uuid primary key default gen_random_uuid(),
  client_scope text not null,
  initiated_by uuid not null
    references public.profiles (id) on delete restrict,
  account_id uuid
    references public.whatsapp_coexistence_accounts (id) on delete set null,
  status text not null default 'initiated',
  state_hash text not null unique,
  nonce_hash text not null unique,
  code_hash text unique,
  sdk_event_hash text,
  temporary_token_secret_id uuid unique,
  app_id text not null,
  configuration_id text not null,
  session_info_version text not null default '3',
  feature_type text not null default 'whatsapp_business_app_onboarding',
  submitted_business_portfolio_id text,
  submitted_waba_id text,
  submitted_phone_number_id text,
  submitted_asset_ids jsonb not null default '{}'::jsonb,
  history_sharing_decision text not null default 'pending',
  callback_received_at timestamptz,
  state_consumed_at timestamptz,
  exchange_deadline_at timestamptz,
  code_exchanged_at timestamptz,
  validation_deadline_at timestamptz,
  validation_attempts integer not null default 0,
  validation_max_attempts integer not null default 6,
  validation_available_at timestamptz,
  validation_processing_started_at timestamptz,
  validation_lease_expires_at timestamptz,
  validation_lease_token uuid,
  post_exchange_token_is_valid boolean,
  post_exchange_token_app_id text,
  post_exchange_token_scopes text[],
  post_exchange_token_granular_scopes jsonb,
  post_exchange_token_target_ids text[],
  post_exchange_token_expires_at timestamptz,
  post_exchange_token_data_access_expires_at timestamptz,
  post_exchange_token_validated_at timestamptz,
  post_exchange_token_error_code text,
  pre_completion_token_is_valid boolean,
  pre_completion_token_app_id text,
  pre_completion_token_scopes text[],
  pre_completion_token_granular_scopes jsonb,
  pre_completion_token_target_ids text[],
  pre_completion_token_expires_at timestamptz,
  pre_completion_token_data_access_expires_at timestamptz,
  pre_completion_token_validated_at timestamptz,
  pre_completion_token_error_code text,
  pre_completion_validation_attempt integer,
  lifecycle_event_at timestamptz,
  lifecycle_event text,
  completed_at timestamptz,
  cancelled_at timestamptz,
  last_error_code text,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint whatsapp_embedded_signup_attempt_scope_check check (
    client_scope ~ '^[a-z0-9][a-z0-9._:-]{2,99}$'
  ),
  constraint whatsapp_embedded_signup_attempt_status_check check (
    status in (
      'initiated', 'session_received', 'exchanging', 'token_stored', 'validating',
      'completed', 'cancelled', 'failed', 'expired'
    )
  ),
  constraint whatsapp_embedded_signup_attempt_hashes_check check (
    state_hash ~ '^[0-9a-f]{64}$'
    and nonce_hash ~ '^[0-9a-f]{64}$'
    and state_hash <> nonce_hash
    and (code_hash is null or code_hash ~ '^[0-9a-f]{64}$')
    and (sdk_event_hash is null or sdk_event_hash ~ '^[0-9a-f]{64}$')
  ),
  constraint whatsapp_embedded_signup_attempt_config_check check (
    app_id ~ '^[0-9]{5,64}$'
    and configuration_id ~ '^[0-9]{5,128}$'
    and session_info_version = '3'
    and feature_type = 'whatsapp_business_app_onboarding'
  ),
  constraint whatsapp_embedded_signup_attempt_assets_check check (
    (
      submitted_business_portfolio_id is null
      or submitted_business_portfolio_id ~ '^[0-9]{5,64}$'
    )
    and (
      submitted_waba_id is null
      or submitted_waba_id ~ '^[0-9]{5,64}$'
    )
    and (
      submitted_phone_number_id is null
      or submitted_phone_number_id ~ '^[0-9]{5,64}$'
    )
    and public.is_valid_whatsapp_embedded_signup_asset_ids(
      submitted_asset_ids
    )
  ),
  constraint whatsapp_embedded_signup_attempt_history_check check (
    history_sharing_decision in ('pending', 'accepted', 'declined')
  ),
  constraint whatsapp_embedded_signup_attempt_error_check check (
    last_error_code is null
    or last_error_code ~ '^[A-Z0-9_]{3,100}$'
  ),
  constraint whatsapp_embedded_signup_attempt_lifecycle_check check (
    (lifecycle_event_at is null and lifecycle_event is null)
    or (
      lifecycle_event_at is not null
      and lifecycle_event in (
        'PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED', 'ACCOUNT_RECONNECTED'
      )
    )
  ),
  constraint whatsapp_embedded_signup_attempt_expiry_check check (
    expires_at > created_at
    and expires_at <= created_at + interval '30 minutes'
  ),
  constraint whatsapp_embedded_signup_attempt_session_check check (
    callback_received_at is null
    or (
      callback_received_at is not null
      and sdk_event_hash is not null
      and submitted_waba_id is not null
    )
  ),
  constraint whatsapp_embedded_signup_attempt_exchange_check check (
    status not in ('exchanging', 'token_stored', 'validating', 'completed')
    or (
      code_hash is not null
      and state_consumed_at is not null
      and exchange_deadline_at is not null
    )
  ),
  constraint whatsapp_embedded_signup_attempt_token_check check (
    status not in ('token_stored', 'validating', 'completed')
    or (
      temporary_token_secret_id is not null
      and code_exchanged_at is not null
      and validation_deadline_at is not null
    )
  ),
  constraint whatsapp_embedded_signup_validation_attempts_check check (
    validation_attempts between 0 and 100
    and validation_max_attempts between 1 and 20
  ),
  constraint whatsapp_embedded_signup_validation_ready_check check (
    status <> 'validating' or validation_available_at is not null
  ),
  constraint whatsapp_embedded_signup_validation_lease_check check (
    (
      validation_processing_started_at is null
      and validation_lease_expires_at is null
      and validation_lease_token is null
    )
    or (
      status = 'validating'
      and validation_processing_started_at is not null
      and validation_lease_expires_at
        > validation_processing_started_at
      and validation_lease_token is not null
    )
  ),
  constraint whatsapp_embedded_signup_post_exchange_validation_check check (
    (
      post_exchange_token_is_valid is null
      and post_exchange_token_app_id is null
      and post_exchange_token_scopes is null
      and post_exchange_token_granular_scopes is null
      and post_exchange_token_target_ids is null
      and post_exchange_token_expires_at is null
      and post_exchange_token_data_access_expires_at is null
      and post_exchange_token_validated_at is null
      and post_exchange_token_error_code is null
    ) or (
      post_exchange_token_is_valid is true
      and post_exchange_token_app_id = app_id
      and public.is_valid_whatsapp_business_token_metadata(
        post_exchange_token_scopes,
        post_exchange_token_granular_scopes,
        post_exchange_token_target_ids
      )
      and post_exchange_token_validated_at is not null
      and post_exchange_token_error_code is null
      and (
        post_exchange_token_expires_at is null
        or post_exchange_token_expires_at
          > post_exchange_token_validated_at + interval '15 minutes'
      )
      and (
        post_exchange_token_data_access_expires_at is null
        or post_exchange_token_data_access_expires_at
          > post_exchange_token_validated_at + interval '15 minutes'
      )
    ) or (
      -- Meta's raw is_valid value is evidence and must not be rewritten when
      -- a locally enforced app/scope/asset/expiry check rejects the token.
      -- A bounded error code distinguishes this terminal rejection branch
      -- from the accepted is_valid=true branch above.
      post_exchange_token_is_valid is not null
      and (
        post_exchange_token_app_id is null
        or post_exchange_token_app_id ~ '^[0-9]{5,64}$'
      )
      and post_exchange_token_scopes is not null
      and cardinality(post_exchange_token_scopes) <= 100
      and post_exchange_token_granular_scopes is not null
      and jsonb_typeof(post_exchange_token_granular_scopes) = 'array'
      and octet_length(post_exchange_token_granular_scopes::text) <= 32768
      and post_exchange_token_target_ids is not null
      and cardinality(post_exchange_token_target_ids) <= 500
      and post_exchange_token_validated_at is not null
      and post_exchange_token_error_code ~ '^[A-Z0-9_]{3,100}$'
    )
  ),
  constraint whatsapp_embedded_signup_pre_completion_validation_check check (
    (
      pre_completion_token_is_valid is null
      and pre_completion_token_app_id is null
      and pre_completion_token_scopes is null
      and pre_completion_token_granular_scopes is null
      and pre_completion_token_target_ids is null
      and pre_completion_token_expires_at is null
      and pre_completion_token_data_access_expires_at is null
      and pre_completion_token_validated_at is null
      and pre_completion_token_error_code is null
      and pre_completion_validation_attempt is null
    ) or (
      pre_completion_token_is_valid is true
      and pre_completion_token_app_id = app_id
      and public.is_valid_whatsapp_business_token_metadata(
        pre_completion_token_scopes,
        pre_completion_token_granular_scopes,
        pre_completion_token_target_ids
      )
      and pre_completion_token_validated_at is not null
      and pre_completion_token_error_code is null
      and pre_completion_validation_attempt between 1 and 100
      and (
        pre_completion_token_expires_at is null
        or pre_completion_token_expires_at
          > pre_completion_token_validated_at + interval '15 minutes'
      )
      and (
        pre_completion_token_data_access_expires_at is null
        or pre_completion_token_data_access_expires_at
          > pre_completion_token_validated_at + interval '15 minutes'
      )
    ) or (
      pre_completion_token_is_valid is not null
      and (
        pre_completion_token_app_id is null
        or pre_completion_token_app_id ~ '^[0-9]{5,64}$'
      )
      and pre_completion_token_scopes is not null
      and cardinality(pre_completion_token_scopes) <= 100
      and pre_completion_token_granular_scopes is not null
      and jsonb_typeof(pre_completion_token_granular_scopes) = 'array'
      and octet_length(pre_completion_token_granular_scopes::text) <= 32768
      and pre_completion_token_target_ids is not null
      and cardinality(pre_completion_token_target_ids) <= 500
      and pre_completion_token_validated_at is not null
      and pre_completion_token_error_code ~ '^[A-Z0-9_]{3,100}$'
      and pre_completion_validation_attempt between 1 and 100
    )
  ),
  constraint whatsapp_embedded_signup_attempt_completion_check check (
    status <> 'completed'
    or (
      account_id is not null
      and code_exchanged_at is not null
      and completed_at is not null
    )
  )
);

create unique index whatsapp_embedded_signup_one_active_scope_idx
  on public.whatsapp_embedded_signup_attempts (client_scope)
  where status in (
    'initiated', 'session_received', 'exchanging', 'token_stored', 'validating'
  );

create index whatsapp_embedded_signup_admin_created_idx
  on public.whatsapp_embedded_signup_attempts (initiated_by, created_at desc);
create index whatsapp_embedded_signup_expiry_idx
  on public.whatsapp_embedded_signup_attempts (expires_at)
  where status in ('initiated', 'session_received');
create index whatsapp_embedded_signup_validation_claim_idx
  on public.whatsapp_embedded_signup_attempts (
    validation_available_at, created_at
  )
  where status = 'validating';

alter table public.whatsapp_coexistence_accounts
  add column last_onboarding_attempt_id uuid
    references public.whatsapp_embedded_signup_attempts (id) on delete set null;

create table public.whatsapp_onboarding_outbox (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references public.whatsapp_coexistence_accounts (id) on delete restrict,
  onboarding_attempt_id uuid
    references public.whatsapp_embedded_signup_attempts (id) on delete restrict,
  requested_by uuid references public.profiles (id) on delete set null,
  token_generation bigint not null,
  operation text not null,
  idempotency_key text not null unique,
  status text not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 8,
  first_attempted_at timestamptz,
  available_at timestamptz not null default clock_timestamp(),
  processing_started_at timestamptz,
  lease_expires_at timestamptz,
  lease_token uuid,
  deadline_at timestamptz,
  sync_generation_id uuid,
  remote_request_id text,
  completion_reason text,
  last_error_code text,
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint whatsapp_onboarding_outbox_generation_check check (
    token_generation > 0
  ),
  constraint whatsapp_onboarding_outbox_operation_check check (
    operation in (
      'subscribe_app', 'request_contacts_sync',
      'request_history_sync', 'unsubscribe_app'
    )
  ),
  constraint whatsapp_onboarding_outbox_idempotency_check check (
    char_length(idempotency_key) between 8 and 200
    and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9:._-]*$'
  ),
  constraint whatsapp_onboarding_outbox_status_check check (
    status in (
      'pending', 'processing', 'succeeded', 'failed',
      'ambiguous', 'cancelled'
    )
  ),
  constraint whatsapp_onboarding_outbox_attempts_check check (
    attempts between 0 and 100 and max_attempts between 1 and 20
  ),
  constraint whatsapp_onboarding_outbox_lease_check check (
    (
      status = 'processing'
      and processing_started_at is not null
      and lease_expires_at is not null
      and lease_token is not null
    )
    or (
      status <> 'processing'
      and processing_started_at is null
      and lease_expires_at is null
      and lease_token is null
    )
  ),
  constraint whatsapp_onboarding_outbox_sync_context_check check (
    (
      operation in ('request_contacts_sync', 'request_history_sync')
      and sync_generation_id is not null
      and deadline_at is not null
    )
    or (
      operation = 'subscribe_app'
      and sync_generation_id is null
      and deadline_at is not null
    )
    or (
      operation = 'unsubscribe_app'
      and sync_generation_id is null
      and deadline_at is null
    )
  ),
  constraint whatsapp_onboarding_outbox_request_actor_check check (
    (operation = 'unsubscribe_app' and requested_by is not null)
    or (operation <> 'unsubscribe_app' and requested_by is null)
  ),
  constraint whatsapp_onboarding_outbox_remote_request_check check (
    remote_request_id is null
    or char_length(trim(remote_request_id)) between 1 and 240
  ),
  constraint whatsapp_onboarding_outbox_completion_reason_check check (
    completion_reason is null
    or completion_reason in (
      'remote_confirmed', 'already_applied', 'webhook_observed',
      'history_declined', 'remote_already_absent',
      'local_credential_purge'
    )
  ),
  constraint whatsapp_onboarding_outbox_error_check check (
    last_error_code is null
    or last_error_code ~ '^[A-Z0-9_]{3,100}$'
  ),
  unique (account_id, token_generation, operation)
);

create index whatsapp_onboarding_outbox_claim_idx
  on public.whatsapp_onboarding_outbox (available_at, created_at)
  where status = 'pending';
create index whatsapp_onboarding_outbox_stale_idx
  on public.whatsapp_onboarding_outbox (lease_expires_at)
  where status = 'processing';
create index whatsapp_onboarding_outbox_account_idx
  on public.whatsapp_onboarding_outbox (account_id, created_at desc);
create index whatsapp_onboarding_outbox_deadline_idx
  on public.whatsapp_onboarding_outbox (deadline_at)
  where status in ('pending', 'processing', 'ambiguous');

create table public.whatsapp_business_token_validations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid
    references public.whatsapp_coexistence_accounts (id) on delete restrict,
  onboarding_attempt_id uuid
    references public.whatsapp_embedded_signup_attempts (id) on delete set null,
  token_generation bigint,
  checkpoint_attempt integer,
  validation_reason text not null,
  is_valid boolean,
  authorization_valid boolean not null,
  app_id text,
  scopes text[] not null default '{}'::text[],
  granular_scopes jsonb not null default '[]'::jsonb,
  target_ids text[] not null default '{}'::text[],
  expires_at timestamptz,
  data_access_expires_at timestamptz,
  expires_at_epoch bigint,
  data_access_expires_at_epoch bigint,
  validated_at timestamptz not null,
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  constraint whatsapp_business_token_validation_identity_check check (
    (
      account_id is not null
      and token_generation > 0
    ) or (
      account_id is null
      and onboarding_attempt_id is not null
      and token_generation is null
      and validation_reason in ('post_exchange', 'pre_completion')
      and checkpoint_attempt between 0 and 100
    )
  ),
  constraint whatsapp_business_token_validation_reason_check check (
    validation_reason in (
      'post_exchange', 'pre_completion', 'periodic',
      'auth_error', 'critical_operation', 'reconnect'
    )
  ),
  constraint whatsapp_business_token_validation_app_check check (
    app_id is null or app_id ~ '^[0-9]{5,64}$'
  ),
  constraint whatsapp_business_token_validation_metadata_check check (
    (
      authorization_valid
      and is_valid is true
      and app_id is not null
      and public.is_valid_whatsapp_business_token_metadata(
        scopes, granular_scopes, target_ids
      )
      and error_code is null
    ) or (
      not authorization_valid
      and jsonb_typeof(granular_scopes) = 'array'
      and cardinality(scopes) <= 100
      and cardinality(target_ids) <= 500
      and error_code ~ '^[A-Z0-9_]{3,100}$'
    )
  ),
  constraint whatsapp_business_token_validation_epoch_check check (
    (expires_at_epoch is null or expires_at_epoch between 0 and 8640000000000)
    and (
      data_access_expires_at_epoch is null
      or data_access_expires_at_epoch between 0 and 8640000000000
    )
  )
);

create index whatsapp_business_token_validations_account_idx
  on public.whatsapp_business_token_validations (
    account_id, token_generation, validated_at desc, id
  );

create unique index whatsapp_business_token_validations_checkpoint_idx
  on public.whatsapp_business_token_validations (
    onboarding_attempt_id, validation_reason, checkpoint_attempt
  )
  where onboarding_attempt_id is not null
    and validation_reason in ('post_exchange', 'pre_completion');

create table public.whatsapp_business_token_validation_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null unique
    references public.whatsapp_coexistence_accounts (id) on delete restrict,
  token_generation bigint not null,
  validation_reason text not null default 'periodic',
  status text not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 8,
  available_at timestamptz not null,
  processing_started_at timestamptz,
  lease_expires_at timestamptz,
  lease_token uuid,
  last_error_code text,
  pause_observed_at timestamptz,
  pause_error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint whatsapp_business_token_validation_job_generation_check check (
    token_generation > 0
  ),
  constraint whatsapp_business_token_validation_job_reason_check check (
    validation_reason in (
      'periodic', 'auth_error', 'critical_operation', 'reconnect'
    )
  ),
  constraint whatsapp_business_token_validation_job_status_check check (
    status in ('pending', 'processing', 'failed', 'cancelled')
  ),
  constraint whatsapp_business_token_validation_job_attempts_check check (
    attempts between 0 and 100 and max_attempts between 1 and 20
  ),
  constraint whatsapp_business_token_validation_job_lease_check check (
    (
      status = 'processing'
      and processing_started_at is not null
      and lease_expires_at > processing_started_at
      and lease_token is not null
    ) or (
      status <> 'processing'
      and processing_started_at is null
      and lease_expires_at is null
      and lease_token is null
    )
  ),
  constraint whatsapp_business_token_validation_job_error_check check (
    last_error_code is null
    or last_error_code ~ '^[A-Z0-9_]{3,100}$'
  ),
  constraint whatsapp_business_token_validation_job_pause_check check (
    (
      pause_observed_at is null
      and pause_error_code is null
    ) or (
      pause_observed_at is not null
      and pause_error_code ~ '^[A-Z0-9_]{3,100}$'
    )
  )
);

create index whatsapp_business_token_validation_jobs_claim_idx
  on public.whatsapp_business_token_validation_jobs (available_at, created_at)
  where status = 'pending';
create index whatsapp_business_token_validation_jobs_stale_idx
  on public.whatsapp_business_token_validation_jobs (lease_expires_at)
  where status = 'processing';

alter table public.whatsapp_embedded_signup_attempts enable row level security;
alter table public.whatsapp_onboarding_outbox enable row level security;
alter table public.whatsapp_business_token_validations enable row level security;
alter table public.whatsapp_business_token_validation_jobs enable row level security;

revoke all on public.whatsapp_embedded_signup_attempts
  from public, anon, authenticated, service_role;
revoke all on public.whatsapp_onboarding_outbox
  from public, anon, authenticated, service_role;
revoke all on public.whatsapp_business_token_validations
  from public, anon, authenticated, service_role;
revoke all on public.whatsapp_business_token_validation_jobs
  from public, anon, authenticated, service_role;
grant all on public.whatsapp_embedded_signup_attempts to postgres;
grant all on public.whatsapp_onboarding_outbox to postgres;
grant all on public.whatsapp_business_token_validations to postgres;
grant all on public.whatsapp_business_token_validation_jobs to postgres;

-- Keep Vault completely outside browser roles. The account table stores only
-- an opaque UUID and never the token or a reversible derivative of it.
revoke all on table vault.secrets from public, anon, authenticated;
revoke all on table vault.decrypted_secrets from public, anon, authenticated;
revoke execute on function vault.create_secret(text, text, text, uuid)
  from public, anon, authenticated;
revoke execute on function vault.update_secret(uuid, text, text, text, uuid)
  from public, anon, authenticated;

create trigger set_whatsapp_embedded_signup_attempts_updated_at
  before update on public.whatsapp_embedded_signup_attempts
  for each row execute function public.set_updated_at();

create trigger set_whatsapp_onboarding_outbox_updated_at
  before update on public.whatsapp_onboarding_outbox
  for each row execute function public.set_updated_at();

create trigger set_whatsapp_business_token_validation_jobs_updated_at
  before update on public.whatsapp_business_token_validation_jobs
  for each row execute function public.set_updated_at();

create or replace function public.assert_whatsapp_embedded_signup_admin(
  p_admin_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if p_admin_user_id is null or not exists (
    select 1
    from public.profiles profile
    where profile.id = p_admin_user_id
      and profile.active
      and profile.role = 'ADMIN'
  ) then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_ADMIN_REQUIRED'
      using errcode = '42501';
  end if;
end;
$$;

create or replace function public.expire_whatsapp_embedded_signup_attempts()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempt public.whatsapp_embedded_signup_attempts%rowtype;
  expired_count integer := 0;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  for attempt in
    select candidate.*
    from public.whatsapp_embedded_signup_attempts candidate
    where (
        candidate.status in ('initiated', 'session_received')
        and candidate.expires_at <= clock_timestamp()
      ) or (
        candidate.status = 'exchanging'
        and candidate.exchange_deadline_at + interval '2 minutes'
          <= clock_timestamp()
      ) or (
        candidate.status in ('token_stored', 'validating')
        and candidate.validation_deadline_at <= clock_timestamp()
      )
    order by candidate.created_at
    for update skip locked
  loop
    if attempt.temporary_token_secret_id is not null then
      delete from vault.secrets secret
      where secret.id = attempt.temporary_token_secret_id
        and secret.name = 'whatsapp_embedded_signup_token_' || attempt.id::text;
    end if;
    update public.whatsapp_embedded_signup_attempts
    set status = 'expired',
        temporary_token_secret_id = null,
        validation_processing_started_at = null,
        validation_lease_expires_at = null,
        validation_lease_token = null,
        last_error_code = 'ONBOARDING_ATTEMPT_EXPIRED'
    where id = attempt.id;
    expired_count := expired_count + 1;
  end loop;
  return expired_count;
end;
$$;

create or replace function public.create_whatsapp_embedded_signup_attempt(
  p_admin_user_id uuid,
  p_client_scope text,
  p_state_hash text,
  p_nonce_hash text,
  p_app_id text,
  p_configuration_id text,
  p_history_sharing_decision text,
  p_expires_at timestamptz
)
returns table (
  attempt_id uuid,
  status text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  clean_scope text := lower(trim(coalesce(p_client_scope, '')));
  created_at_value timestamptz := clock_timestamp();
  result_id uuid;
begin
  perform public.assert_whatsapp_embedded_signup_admin(p_admin_user_id);
  if clean_scope !~ '^[a-z0-9][a-z0-9._:-]{2,99}$'
    or p_state_hash !~ '^[0-9a-f]{64}$'
    or p_nonce_hash !~ '^[0-9a-f]{64}$'
    or p_state_hash = p_nonce_hash
    or trim(coalesce(p_app_id, '')) !~ '^[0-9]{5,64}$'
    or trim(coalesce(p_configuration_id, '')) !~ '^[0-9]{5,128}$'
    or p_history_sharing_decision not in ('accepted', 'declined')
    or p_expires_at is null
    or p_expires_at <= created_at_value + interval '5 seconds'
    or p_expires_at > created_at_value + interval '30 minutes'
  then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_ATTEMPT_INVALID'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('whatsapp-embedded-signup:' || clean_scope, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('whatsapp-embedded-signup-admin:' || p_admin_user_id::text, 0)
  );
  perform public.expire_whatsapp_embedded_signup_attempts();

  if exists (
    select 1
    from public.whatsapp_embedded_signup_attempts attempt
    where attempt.client_scope = clean_scope
      and attempt.status in (
        'initiated', 'session_received', 'exchanging', 'token_stored', 'validating'
      )
  ) then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_ATTEMPT_ACTIVE'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.whatsapp_coexistence_accounts account
    where account.client_scope = clean_scope
      and (
        account.last_onboarding_attempt_id is not null
        or account.business_token_generation > 0
        or account.business_token_secret_id is not null
        or account.onboarding_status <> 'not_started'
      )
      and (
        account.business_token_status = 'active'
        or account.business_token_secret_id is not null
        or account.onboarding_status in (
          'provisioning', 'completed', 'offboarding'
        )
        or account.app_subscription_status in (
          'pending', 'subscribed', 'unsubscribing'
        )
        or account.coexistence_status in ('onboarding', 'active', 'paused')
      )
  ) then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_ALREADY_CONNECTED'
      using errcode = '55000';
  end if;

  if (
    select count(*)
    from public.whatsapp_embedded_signup_attempts attempt
    where attempt.initiated_by = p_admin_user_id
      and attempt.created_at > created_at_value - interval '15 minutes'
  ) >= 3 or (
    select count(*)
    from public.whatsapp_embedded_signup_attempts attempt
    where attempt.initiated_by = p_admin_user_id
      and attempt.created_at > created_at_value - interval '24 hours'
  ) >= 10 then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_RATE_LIMITED'
      using errcode = 'P0001';
  end if;

  -- START and the fail-closed send pause are one transaction. Locking/updating
  -- the singleton before creating the attempt prevents a popup or callback
  -- from observing an active onboarding attempt while outbound sending is
  -- still enabled.
  update public.whatsapp_settings
  set sending_paused = true,
      sending_pause_reason = 'COEXISTENCE_ONBOARDING',
      updated_at = created_at_value
  where id = true;
  if not found then
    raise exception 'WHATSAPP_SETTINGS_UNAVAILABLE'
      using errcode = '55000';
  end if;

  insert into public.whatsapp_embedded_signup_attempts (
    client_scope,
    initiated_by,
    state_hash,
    nonce_hash,
    app_id,
    configuration_id,
    history_sharing_decision,
    expires_at,
    created_at,
    updated_at
  ) values (
    clean_scope,
    p_admin_user_id,
    p_state_hash,
    p_nonce_hash,
    trim(p_app_id),
    trim(p_configuration_id),
    p_history_sharing_decision,
    p_expires_at,
    created_at_value,
    created_at_value
  ) returning id into result_id;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    p_admin_user_id,
    'whatsapp.embedded_signup.started',
    'whatsapp_embedded_signup_attempt',
    result_id,
    jsonb_build_object(
      'client_scope', clean_scope,
      'sending_paused', true,
      'sending_pause_reason', 'COEXISTENCE_ONBOARDING'
    )
  );

  return query
  select result_id, 'initiated'::text, p_expires_at;
end;
$$;

create or replace function public.record_whatsapp_embedded_signup_session(
  p_attempt_id uuid,
  p_admin_user_id uuid,
  p_state_hash text,
  p_nonce_hash text,
  p_sdk_event_hash text,
  p_callback_received_at timestamptz,
  p_business_portfolio_id text,
  p_waba_id text,
  p_phone_number_id text,
  p_asset_ids jsonb,
  p_history_sharing_decision text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempt public.whatsapp_embedded_signup_attempts%rowtype;
  clean_portfolio_id text := nullif(trim(coalesce(p_business_portfolio_id, '')), '');
  clean_phone_number_id text := nullif(trim(coalesce(p_phone_number_id, '')), '');
  clean_asset_ids jsonb := coalesce(p_asset_ids, '{}'::jsonb);
  exact_session_replay boolean;
begin
  perform public.assert_whatsapp_embedded_signup_admin(p_admin_user_id);
  if p_sdk_event_hash !~ '^[0-9a-f]{64}$'
    or p_callback_received_at is null
    or p_callback_received_at > clock_timestamp() + interval '5 seconds'
    or (clean_portfolio_id is not null and clean_portfolio_id !~ '^[0-9]{5,64}$')
    or trim(coalesce(p_waba_id, '')) !~ '^[0-9]{5,64}$'
    or (
      clean_phone_number_id is not null
      and clean_phone_number_id !~ '^[0-9]{5,64}$'
    )
    or not public.is_valid_whatsapp_embedded_signup_asset_ids(clean_asset_ids)
    or p_history_sharing_decision not in ('accepted', 'declined')
  then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_SESSION_INVALID'
      using errcode = '22023';
  end if;

  -- Publish FINISH and its WABA mapping under the same lock used by webhook
  -- trust/apply and completion. A concurrent lifecycle webhook therefore
  -- waits for this transaction and cannot miss a just-authenticated mapping.
  perform pg_advisory_xact_lock(hashtextextended(
    'whatsapp-embedded-signup-waba:' || trim(p_waba_id),
    0
  ));

  select * into attempt
  from public.whatsapp_embedded_signup_attempts candidate
  where candidate.id = p_attempt_id
  for update;
  if not found
    or attempt.initiated_by <> p_admin_user_id
    or attempt.state_hash <> p_state_hash
    or attempt.nonce_hash <> p_nonce_hash
    or attempt.history_sharing_decision <> p_history_sharing_decision
    or p_callback_received_at < attempt.created_at
  then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_STATE_INVALID'
      using errcode = '42501';
  end if;

  exact_session_replay := attempt.callback_received_at is not null
    and attempt.sdk_event_hash = p_sdk_event_hash
    and attempt.submitted_business_portfolio_id is not distinct from clean_portfolio_id
    and attempt.submitted_waba_id = trim(p_waba_id)
    and attempt.submitted_phone_number_id is not distinct from clean_phone_number_id
    and attempt.submitted_asset_ids = clean_asset_ids
    and attempt.history_sharing_decision = p_history_sharing_decision;

  -- Terminal attempts are immutable. Meta may replay FINISH long after the
  -- attempt TTL, so acknowledge an exact stored callback without rewriting
  -- completed/failed/cancelled/expired state. A terminal attempt that never
  -- stored FINISH is simply rejected without mutation.
  if attempt.status in ('completed', 'failed', 'cancelled', 'expired') then
    if exact_session_replay then
      return true;
    end if;
    if attempt.callback_received_at is not null then
      raise exception 'WHATSAPP_EMBEDDED_SIGNUP_SESSION_CONFLICT'
        using errcode = '23514';
    end if;
    return false;
  end if;

  if p_callback_received_at > attempt.expires_at or (
      (
        attempt.status = 'exchanging'
        and attempt.exchange_deadline_at + interval '2 minutes'
          <= clock_timestamp()
      ) or (
        attempt.status in ('token_stored', 'validating')
        and attempt.validation_deadline_at <= clock_timestamp()
      )
    )
  then
    if attempt.temporary_token_secret_id is not null then
      delete from vault.secrets secret
      where secret.id = attempt.temporary_token_secret_id
        and secret.name = 'whatsapp_embedded_signup_token_' || attempt.id::text;
    end if;
    update public.whatsapp_embedded_signup_attempts
    set status = 'expired',
        temporary_token_secret_id = null,
        validation_processing_started_at = null,
        validation_lease_expires_at = null,
        validation_lease_token = null,
        last_error_code = 'ONBOARDING_ATTEMPT_EXPIRED'
    where id = attempt.id
      and status in (
        'initiated', 'session_received', 'exchanging',
        'token_stored', 'validating'
      );
    return false;
  end if;

  if attempt.callback_received_at is not null then
    if exact_session_replay then
      return true;
    end if;
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_SESSION_CONFLICT'
      using errcode = '23514';
  end if;
  if attempt.status not in ('initiated', 'exchanging', 'token_stored') then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_ATTEMPT_NOT_ACTIVE'
      using errcode = '55000';
  end if;

  update public.whatsapp_embedded_signup_attempts
  set status = case attempt.status
        when 'initiated' then 'session_received'
        when 'token_stored' then 'validating'
        else attempt.status
      end,
      sdk_event_hash = p_sdk_event_hash,
      submitted_business_portfolio_id = clean_portfolio_id,
      submitted_waba_id = trim(p_waba_id),
      submitted_phone_number_id = clean_phone_number_id,
      submitted_asset_ids = clean_asset_ids,
      callback_received_at = p_callback_received_at,
      validation_available_at = case
        when attempt.status = 'token_stored'
          and attempt.post_exchange_token_validated_at is not null
        then clock_timestamp()
        else validation_available_at
      end,
      last_error_code = null
  where id = attempt.id;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    p_admin_user_id,
    'whatsapp.embedded_signup.session_received',
    'whatsapp_embedded_signup_attempt',
    attempt.id,
    jsonb_build_object('history_decision', p_history_sharing_decision)
  );
  return true;
end;
$$;

create or replace function public.claim_whatsapp_embedded_signup_code(
  p_attempt_id uuid,
  p_admin_user_id uuid,
  p_state_hash text,
  p_nonce_hash text,
  p_code_hash text
)
returns table (
  attempt_id uuid,
  business_portfolio_id text,
  waba_id text,
  phone_number_id text,
  history_sharing_decision text,
  exchange_deadline_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempt public.whatsapp_embedded_signup_attempts%rowtype;
  deadline timestamptz;
begin
  perform public.assert_whatsapp_embedded_signup_admin(p_admin_user_id);
  if p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_CODE_INVALID'
      using errcode = '22023';
  end if;

  select * into attempt
  from public.whatsapp_embedded_signup_attempts candidate
  where candidate.id = p_attempt_id
  for update;
  if not found
    or attempt.initiated_by <> p_admin_user_id
    or attempt.state_hash <> p_state_hash
    or attempt.nonce_hash <> p_nonce_hash
  then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_STATE_INVALID'
      using errcode = '42501';
  end if;
  -- A consumed code, validation in progress, and every terminal state are
  -- immutable to OAuth replays. In particular, the START transaction TTL is
  -- not a validation-token expiry and must never downgrade token_stored or a
  -- completed attempt. Token-bearing attempts are expired (and their Vault
  -- secret removed) by expire_whatsapp_embedded_signup_attempts using the
  -- separate validation deadline.
  if attempt.status not in ('initiated', 'session_received') then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_CODE_REPLAY'
      using errcode = '55000';
  end if;
  if attempt.expires_at <= clock_timestamp() then
    if attempt.temporary_token_secret_id is not null then
      delete from vault.secrets secret
      where secret.id = attempt.temporary_token_secret_id
        and secret.name = 'whatsapp_embedded_signup_token_' || attempt.id::text;
    end if;
    update public.whatsapp_embedded_signup_attempts
    set status = 'expired',
        temporary_token_secret_id = null,
        validation_processing_started_at = null,
        validation_lease_expires_at = null,
        validation_lease_token = null,
        last_error_code = 'ONBOARDING_ATTEMPT_EXPIRED'
    where id = attempt.id
      and status in ('initiated', 'session_received');
    return;
  end if;
  if exists (
    select 1
    from public.whatsapp_embedded_signup_attempts prior
    where prior.code_hash = p_code_hash
      and prior.id <> attempt.id
  ) then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_CODE_REPLAY'
      using errcode = '23505';
  end if;

  deadline := clock_timestamp() + interval '25 seconds';
  update public.whatsapp_embedded_signup_attempts
  set status = 'exchanging',
      code_hash = p_code_hash,
      state_consumed_at = clock_timestamp(),
      exchange_deadline_at = deadline,
      last_error_code = null
  where id = attempt.id;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    p_admin_user_id,
    'whatsapp.embedded_signup.code_claimed',
    'whatsapp_embedded_signup_attempt',
    attempt.id,
    '{}'::jsonb
  );

  return query
  select
    attempt.id,
    attempt.submitted_business_portfolio_id,
    attempt.submitted_waba_id,
    attempt.submitted_phone_number_id,
    attempt.history_sharing_decision,
    deadline;
end;
$$;

create or replace function public.store_whatsapp_embedded_signup_exchange_token(
  p_attempt_id uuid,
  p_code_hash text,
  p_business_access_token text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  attempt public.whatsapp_embedded_signup_attempts%rowtype;
  secret_id uuid;
  validation_deadline timestamptz;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  -- Meta access tokens are opaque and have no contractual fixed length.
  if coalesce(p_business_access_token, '') = ''
    or p_business_access_token ~ E'[\\r\\n]' then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_TOKEN_INVALID'
      using errcode = '22023';
  end if;
  select * into attempt
  from public.whatsapp_embedded_signup_attempts candidate
  where candidate.id = p_attempt_id
  for update;
  if not found or attempt.status <> 'exchanging'
    or attempt.code_hash <> p_code_hash then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_EXCHANGE_INVALID'
      using errcode = '55000';
  end if;
  if exists (
    select 1 from vault.secrets secret
    where secret.name = 'whatsapp_embedded_signup_token_' || attempt.id::text
  ) then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_VAULT_SECRET_CONFLICT'
      using errcode = '55000';
  end if;
  secret_id := vault.create_secret(
    p_business_access_token,
    'whatsapp_embedded_signup_token_' || attempt.id::text,
    'Temporary WhatsApp Embedded Signup token pending Graph validation'
  );
  if secret_id is null then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_VAULT_WRITE_FAILED'
      using errcode = '55000';
  end if;
  validation_deadline := clock_timestamp() + interval '5 minutes';
  update public.whatsapp_embedded_signup_attempts
  -- A stored token is not validation-ready until the independent
  -- post-exchange debug_token checkpoint is durably recorded.
  set status = 'token_stored',
      temporary_token_secret_id = secret_id,
      code_exchanged_at = clock_timestamp(),
      validation_deadline_at = validation_deadline,
      validation_available_at = null
  where id = attempt.id;
  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    attempt.initiated_by,
    'whatsapp.embedded_signup.code_exchanged',
    'whatsapp_embedded_signup_attempt',
    attempt.id,
    '{}'::jsonb
  );
  return true;
end;
$$;

create or replace function public.record_whatsapp_embedded_signup_post_exchange_validation(
  p_attempt_id uuid,
  p_token_is_valid boolean,
  p_token_app_id text,
  p_token_scopes text[],
  p_token_granular_scopes jsonb,
  p_token_target_ids text[],
  p_token_expires_at timestamptz,
  p_token_data_access_expires_at timestamptz,
  p_token_validated_at timestamptz,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  attempt public.whatsapp_embedded_signup_attempts%rowtype;
  now_value timestamptz := clock_timestamp();
  clean_app_id text := nullif(trim(coalesce(p_token_app_id, '')), '');
  clean_error text := nullif(upper(trim(coalesce(p_error_code, ''))), '');
  clean_scopes text[] := coalesce(p_token_scopes, '{}'::text[]);
  clean_granular_scopes jsonb := coalesce(
    p_token_granular_scopes, '[]'::jsonb
  );
  clean_target_ids text[] := coalesce(p_token_target_ids, '{}'::text[]);
  accepted boolean;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if p_token_is_valid is null or p_token_validated_at is null
    or p_token_validated_at < now_value - interval '10 minutes'
    or p_token_validated_at > now_value + interval '5 minutes'
    or jsonb_typeof(clean_granular_scopes) <> 'array'
    or octet_length(clean_granular_scopes::text) > 32768
    or cardinality(clean_scopes) > 100
    or cardinality(clean_target_ids) > 500
    or (clean_error is not null and clean_error !~ '^[A-Z0-9_]{3,100}$')
    or (clean_app_id is not null and clean_app_id !~ '^[0-9]{5,64}$')
    or (not p_token_is_valid and clean_error is null)
  then
    raise exception 'WHATSAPP_POST_EXCHANGE_VALIDATION_INVALID'
      using errcode = '22023';
  end if;
  select * into attempt
  from public.whatsapp_embedded_signup_attempts candidate
  where candidate.id = p_attempt_id
  for update;
  if not found then
    raise exception 'WHATSAPP_POST_EXCHANGE_VALIDATION_STATE_INVALID'
      using errcode = '55000';
  end if;

  -- Persist the exact debug_token result even when a local trust boundary
  -- rejects it. The rejection reason is derived server-side when the caller
  -- did not already provide a bounded, non-sensitive reason.
  if p_token_is_valid and clean_error is null then
    clean_error := case
      when clean_app_id is null or clean_app_id <> attempt.app_id
        then 'POST_EXCHANGE_APP_MISMATCH'
      when not public.is_valid_whatsapp_business_token_metadata(
        clean_scopes, clean_granular_scopes, clean_target_ids
      ) then 'POST_EXCHANGE_METADATA_INVALID'
      when not ('whatsapp_business_management' = any(clean_scopes))
        or not ('whatsapp_business_messaging' = any(clean_scopes))
        then 'POST_EXCHANGE_SCOPE_MISSING'
      when attempt.submitted_waba_id is not null and (
        not (attempt.submitted_waba_id = any(clean_target_ids))
        or not exists (
          select 1
          from jsonb_array_elements(clean_granular_scopes) granular
          where granular ->> 'scope' = 'whatsapp_business_management'
            and granular -> 'target_ids' ? attempt.submitted_waba_id
        )
        or not exists (
          select 1
          from jsonb_array_elements(clean_granular_scopes) granular
          where granular ->> 'scope' = 'whatsapp_business_messaging'
            and granular -> 'target_ids' ? attempt.submitted_waba_id
        )
      ) then 'POST_EXCHANGE_ASSET_MISMATCH'
      when p_token_expires_at is not null
        and p_token_expires_at <= now_value + interval '15 minutes'
        then 'POST_EXCHANGE_TOKEN_EXPIRES_SOON'
      when p_token_data_access_expires_at is not null
        and p_token_data_access_expires_at
          <= now_value + interval '15 minutes'
        then 'POST_EXCHANGE_DATA_ACCESS_EXPIRES_SOON'
      else null
    end;
  end if;
  accepted := p_token_is_valid and clean_error is null;

  if attempt.post_exchange_token_validated_at is not null then
    if attempt.post_exchange_token_is_valid = p_token_is_valid
      and attempt.post_exchange_token_app_id is not distinct from clean_app_id
      and attempt.post_exchange_token_scopes = clean_scopes
      and attempt.post_exchange_token_granular_scopes
        = clean_granular_scopes
      and attempt.post_exchange_token_target_ids = clean_target_ids
      and attempt.post_exchange_token_expires_at
        is not distinct from p_token_expires_at
      and attempt.post_exchange_token_data_access_expires_at
        is not distinct from p_token_data_access_expires_at
      and attempt.post_exchange_token_validated_at = p_token_validated_at
      and attempt.post_exchange_token_error_code is not distinct from clean_error
    then
      return true;
    end if;
    raise exception 'WHATSAPP_POST_EXCHANGE_VALIDATION_CONFLICT'
      using errcode = '23514';
  end if;
  if attempt.status not in ('token_stored', 'validating')
    or attempt.temporary_token_secret_id is null
    or attempt.code_exchanged_at is null
    or attempt.validation_deadline_at <= now_value
  then
    raise exception 'WHATSAPP_POST_EXCHANGE_VALIDATION_STATE_INVALID'
      using errcode = '55000';
  end if;
  update public.whatsapp_embedded_signup_attempts
  set post_exchange_token_is_valid = p_token_is_valid,
      post_exchange_token_app_id = clean_app_id,
      post_exchange_token_scopes = clean_scopes,
      post_exchange_token_granular_scopes = clean_granular_scopes,
      post_exchange_token_target_ids = clean_target_ids,
      post_exchange_token_expires_at = p_token_expires_at,
      post_exchange_token_data_access_expires_at =
        p_token_data_access_expires_at,
      post_exchange_token_validated_at = p_token_validated_at,
      post_exchange_token_error_code = clean_error,
      status = case
        when not accepted then 'failed'
        when callback_received_at is not null then 'validating'
        else status
      end,
      temporary_token_secret_id = case when accepted
        then temporary_token_secret_id else null end,
      validation_available_at = case
        when accepted and callback_received_at is not null
          then clock_timestamp()
        else null
      end,
      validation_processing_started_at = case when accepted
        then validation_processing_started_at else null end,
      validation_lease_expires_at = case when accepted
        then validation_lease_expires_at else null end,
      validation_lease_token = case when accepted
        then validation_lease_token else null end,
      last_error_code = clean_error
  where id = attempt.id;
  if not accepted then
    delete from vault.secrets secret
    where secret.id = attempt.temporary_token_secret_id
      and secret.name = 'whatsapp_embedded_signup_token_' || attempt.id::text;
  end if;
  insert into public.whatsapp_business_token_validations (
    account_id, onboarding_attempt_id, token_generation,
    checkpoint_attempt, validation_reason, is_valid,
    authorization_valid, app_id, scopes, granular_scopes, target_ids,
    expires_at, data_access_expires_at, expires_at_epoch,
    data_access_expires_at_epoch, validated_at, error_code
  ) values (
    null, attempt.id, null, 0, 'post_exchange', p_token_is_valid,
    accepted, clean_app_id, clean_scopes, clean_granular_scopes,
    clean_target_ids, p_token_expires_at,
    p_token_data_access_expires_at,
    case when p_token_expires_at is null then null
      else extract(epoch from p_token_expires_at)::bigint end,
    case when p_token_data_access_expires_at is null then null
      else extract(epoch from p_token_data_access_expires_at)::bigint end,
    p_token_validated_at, clean_error
  );
  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    attempt.initiated_by,
    case when accepted
      then 'whatsapp.embedded_signup.post_exchange_validated'
      else 'whatsapp.embedded_signup.post_exchange_rejected' end,
    'whatsapp_embedded_signup_attempt',
    attempt.id,
    jsonb_build_object(
      'validated_at', p_token_validated_at,
      'is_valid', p_token_is_valid,
      'error_code', clean_error
    )
  );
  -- true means the evidence was durably recorded, not that it was accepted.
  return true;
end;
$$;

create or replace function public.get_whatsapp_embedded_signup_validation_context(
  p_attempt_id uuid
)
returns table (
  attempt_id uuid,
  business_access_token text,
  submitted_business_portfolio_id text,
  submitted_waba_id text,
  submitted_phone_number_id text,
  history_sharing_decision text,
  validation_deadline_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  attempt public.whatsapp_embedded_signup_attempts%rowtype;
  secret_count integer;
  secret_value text;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  select * into attempt
  from public.whatsapp_embedded_signup_attempts candidate
  where candidate.id = p_attempt_id;
  if not found
    or attempt.status <> 'validating'
    or attempt.temporary_token_secret_id is null
    or attempt.validation_deadline_at <= clock_timestamp()
    or attempt.validation_lease_token is null
    or attempt.validation_lease_expires_at <= clock_timestamp()
    or attempt.submitted_waba_id is null
    or attempt.post_exchange_token_validated_at is null
  then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_VALIDATION_NOT_READY'
      using errcode = '55000';
  end if;

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

  return query select
    attempt.id,
    secret_value,
    attempt.submitted_business_portfolio_id,
    attempt.submitted_waba_id,
    attempt.submitted_phone_number_id,
    attempt.history_sharing_decision,
    attempt.validation_deadline_at;
end;
$$;

create or replace function public.record_whatsapp_embedded_signup_pre_completion_validation(
  p_attempt_id uuid,
  p_validation_lease_token uuid,
  p_token_is_valid boolean,
  p_token_app_id text,
  p_token_scopes text[],
  p_token_granular_scopes jsonb,
  p_token_target_ids text[],
  p_token_expires_at timestamptz,
  p_token_data_access_expires_at timestamptz,
  p_token_validated_at timestamptz,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  attempt public.whatsapp_embedded_signup_attempts%rowtype;
  now_value timestamptz := clock_timestamp();
  clean_app_id text := nullif(trim(coalesce(p_token_app_id, '')), '');
  clean_error text := nullif(upper(trim(coalesce(p_error_code, ''))), '');
  clean_scopes text[] := coalesce(p_token_scopes, '{}'::text[]);
  clean_granular_scopes jsonb := coalesce(
    p_token_granular_scopes, '[]'::jsonb
  );
  clean_target_ids text[] := coalesce(p_token_target_ids, '{}'::text[]);
  accepted boolean;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if p_validation_lease_token is null
    or p_token_is_valid is null
    or p_token_validated_at is null
    or p_token_validated_at < now_value - interval '10 minutes'
    or p_token_validated_at > now_value + interval '5 minutes'
    or jsonb_typeof(clean_granular_scopes) <> 'array'
    or octet_length(clean_granular_scopes::text) > 32768
    or cardinality(clean_scopes) > 100
    or cardinality(clean_target_ids) > 500
    or (clean_error is not null and clean_error !~ '^[A-Z0-9_]{3,100}$')
    or (clean_app_id is not null and clean_app_id !~ '^[0-9]{5,64}$')
    or (not p_token_is_valid and clean_error is null)
  then
    raise exception 'WHATSAPP_PRE_COMPLETION_VALIDATION_INVALID'
      using errcode = '22023';
  end if;

  select * into attempt
  from public.whatsapp_embedded_signup_attempts candidate
  where candidate.id = p_attempt_id
  for update;
  if not found then
    raise exception 'WHATSAPP_PRE_COMPLETION_VALIDATION_STATE_INVALID'
      using errcode = '55000';
  end if;

  if p_token_is_valid and clean_error is null then
    clean_error := case
      when clean_app_id is null or clean_app_id <> attempt.app_id
        then 'PRE_COMPLETION_APP_MISMATCH'
      when not public.is_valid_whatsapp_business_token_metadata(
        clean_scopes, clean_granular_scopes, clean_target_ids
      ) then 'PRE_COMPLETION_METADATA_INVALID'
      when not ('whatsapp_business_management' = any(clean_scopes))
        or not ('whatsapp_business_messaging' = any(clean_scopes))
        then 'PRE_COMPLETION_SCOPE_MISSING'
      when attempt.submitted_waba_id is null or (
        not (attempt.submitted_waba_id = any(clean_target_ids))
        or not exists (
          select 1
          from jsonb_array_elements(clean_granular_scopes) granular
          where granular ->> 'scope' = 'whatsapp_business_management'
            and granular -> 'target_ids' ? attempt.submitted_waba_id
        )
        or not exists (
          select 1
          from jsonb_array_elements(clean_granular_scopes) granular
          where granular ->> 'scope' = 'whatsapp_business_messaging'
            and granular -> 'target_ids' ? attempt.submitted_waba_id
        )
      ) then 'PRE_COMPLETION_ASSET_MISMATCH'
      when p_token_expires_at is not null
        and p_token_expires_at <= now_value + interval '15 minutes'
        then 'PRE_COMPLETION_TOKEN_EXPIRES_SOON'
      when p_token_data_access_expires_at is not null
        and p_token_data_access_expires_at
          <= now_value + interval '15 minutes'
        then 'PRE_COMPLETION_DATA_ACCESS_EXPIRES_SOON'
      else null
    end;
  end if;
  accepted := p_token_is_valid and clean_error is null;

  if attempt.pre_completion_token_validated_at is not null
    and attempt.pre_completion_validation_attempt = attempt.validation_attempts
  then
    if attempt.pre_completion_token_is_valid = p_token_is_valid
      and attempt.pre_completion_token_app_id is not distinct from clean_app_id
      and attempt.pre_completion_token_scopes = clean_scopes
      and attempt.pre_completion_token_granular_scopes
        = clean_granular_scopes
      and attempt.pre_completion_token_target_ids = clean_target_ids
      and attempt.pre_completion_token_expires_at
        is not distinct from p_token_expires_at
      and attempt.pre_completion_token_data_access_expires_at
        is not distinct from p_token_data_access_expires_at
      and attempt.pre_completion_token_validated_at = p_token_validated_at
      and attempt.pre_completion_token_error_code is not distinct from clean_error
    then
      return true;
    end if;
    raise exception 'WHATSAPP_PRE_COMPLETION_VALIDATION_CONFLICT'
      using errcode = '23514';
  elsif attempt.pre_completion_validation_attempt is not null
    and attempt.pre_completion_validation_attempt > attempt.validation_attempts
  then
    raise exception 'WHATSAPP_PRE_COMPLETION_VALIDATION_STATE_INVALID'
      using errcode = '55000';
  end if;

  if attempt.status <> 'validating'
    or attempt.temporary_token_secret_id is null
    or attempt.validation_deadline_at <= now_value
    or attempt.validation_lease_token <> p_validation_lease_token
    or attempt.validation_lease_expires_at <= now_value
    or attempt.post_exchange_token_validated_at is null
    or p_token_validated_at <= attempt.post_exchange_token_validated_at
  then
    raise exception 'WHATSAPP_PRE_COMPLETION_VALIDATION_STATE_INVALID'
      using errcode = '55000';
  end if;

  update public.whatsapp_embedded_signup_attempts
  set pre_completion_token_is_valid = p_token_is_valid,
      pre_completion_token_app_id = clean_app_id,
      pre_completion_token_scopes = clean_scopes,
      pre_completion_token_granular_scopes = clean_granular_scopes,
      pre_completion_token_target_ids = clean_target_ids,
      pre_completion_token_expires_at = p_token_expires_at,
      pre_completion_token_data_access_expires_at =
        p_token_data_access_expires_at,
      pre_completion_token_validated_at = p_token_validated_at,
      pre_completion_token_error_code = clean_error,
      pre_completion_validation_attempt = validation_attempts,
      status = case when accepted then status else 'failed' end,
      temporary_token_secret_id = case when accepted
        then temporary_token_secret_id else null end,
      validation_processing_started_at = case when accepted
        then validation_processing_started_at else null end,
      validation_lease_expires_at = case when accepted
        then validation_lease_expires_at else null end,
      validation_lease_token = case when accepted
        then validation_lease_token else null end,
      validation_available_at = case when accepted
        then validation_available_at else null end,
      last_error_code = clean_error
  where id = attempt.id;

  if not accepted then
    delete from vault.secrets secret
    where secret.id = attempt.temporary_token_secret_id
      and secret.name = 'whatsapp_embedded_signup_token_' || attempt.id::text;
  end if;
  insert into public.whatsapp_business_token_validations (
    account_id, onboarding_attempt_id, token_generation,
    checkpoint_attempt, validation_reason, is_valid,
    authorization_valid, app_id, scopes, granular_scopes, target_ids,
    expires_at, data_access_expires_at, expires_at_epoch,
    data_access_expires_at_epoch, validated_at, error_code
  ) values (
    null, attempt.id, null, attempt.validation_attempts,
    'pre_completion', p_token_is_valid, accepted, clean_app_id,
    clean_scopes, clean_granular_scopes, clean_target_ids,
    p_token_expires_at, p_token_data_access_expires_at,
    case when p_token_expires_at is null then null
      else extract(epoch from p_token_expires_at)::bigint end,
    case when p_token_data_access_expires_at is null then null
      else extract(epoch from p_token_data_access_expires_at)::bigint end,
    p_token_validated_at, clean_error
  );
  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    attempt.initiated_by,
    case when accepted
      then 'whatsapp.embedded_signup.pre_completion_validated'
      else 'whatsapp.embedded_signup.pre_completion_rejected' end,
    'whatsapp_embedded_signup_attempt', attempt.id,
    jsonb_build_object(
      'validated_at', p_token_validated_at,
      'is_valid', p_token_is_valid,
      'error_code', clean_error
    )
  );
  return true;
end;
$$;

create or replace function public.claim_whatsapp_embedded_signup_validations(
  p_limit integer default 1,
  p_attempt_id uuid default null
)
returns table (
  attempt_id uuid,
  initiated_by uuid,
  validation_lease_token uuid,
  business_access_token text,
  submitted_business_portfolio_id text,
  submitted_waba_id text,
  submitted_phone_number_id text,
  history_sharing_decision text,
  validation_deadline_at timestamptz,
  validation_attempts integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  candidate public.whatsapp_embedded_signup_attempts%rowtype;
  secret_count integer;
  secret_value text;
  lease_id uuid;
  claimed integer := 0;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  perform public.expire_whatsapp_embedded_signup_attempts();

  update public.whatsapp_embedded_signup_attempts attempt
  set validation_available_at = clock_timestamp(),
      validation_processing_started_at = null,
      validation_lease_expires_at = null,
      validation_lease_token = null,
      last_error_code = 'VALIDATION_STALE_LEASE_RECOVERED'
  where attempt.status = 'validating'
    and (p_attempt_id is null or attempt.id = p_attempt_id)
    and attempt.validation_lease_expires_at <= clock_timestamp();

  -- Exhaustion is definitive. Do not leave an otherwise unreachable token in
  -- Vault while waiting for the broader onboarding deadline.
  for candidate in
    select attempt.*
    from public.whatsapp_embedded_signup_attempts attempt
    where attempt.status = 'validating'
      and (p_attempt_id is null or attempt.id = p_attempt_id)
      and attempt.validation_lease_token is null
      and attempt.validation_attempts >= attempt.validation_max_attempts
    order by attempt.created_at
    for update skip locked
  loop
    if candidate.temporary_token_secret_id is not null then
      delete from vault.secrets secret
      where secret.id = candidate.temporary_token_secret_id
        and secret.name = 'whatsapp_embedded_signup_token_'
          || candidate.id::text;
    end if;
    update public.whatsapp_embedded_signup_attempts
    set status = 'failed',
        temporary_token_secret_id = null,
        validation_processing_started_at = null,
        validation_lease_expires_at = null,
        validation_lease_token = null,
        last_error_code = 'VALIDATION_MAX_ATTEMPTS_EXCEEDED'
    where id = candidate.id;
  end loop;

  for candidate in
    select attempt.*
    from public.whatsapp_embedded_signup_attempts attempt
    where attempt.status = 'validating'
      and (p_attempt_id is null or attempt.id = p_attempt_id)
      and attempt.validation_lease_token is null
      and attempt.validation_available_at <= clock_timestamp()
      and attempt.validation_attempts < attempt.validation_max_attempts
      and attempt.validation_deadline_at > clock_timestamp()
      and attempt.submitted_waba_id is not null
      and attempt.post_exchange_token_validated_at is not null
    order by attempt.validation_available_at, attempt.created_at
    for update skip locked
  loop
    exit when claimed >= greatest(1, least(coalesce(p_limit, 1), 5));
    select count(*), min(secret.decrypted_secret)
    into secret_count, secret_value
    from vault.decrypted_secrets secret
    where secret.id = candidate.temporary_token_secret_id
      and secret.name = 'whatsapp_embedded_signup_token_'
        || candidate.id::text;
    if secret_count <> 1 or coalesce(secret_value, '') = ''
      or secret_value ~ E'[\\r\\n]'
    then
      update public.whatsapp_embedded_signup_attempts
      set status = 'failed',
          temporary_token_secret_id = null,
          last_error_code = 'VALIDATION_TOKEN_UNAVAILABLE'
      where id = candidate.id;
      continue;
    end if;

    lease_id := gen_random_uuid();
    update public.whatsapp_embedded_signup_attempts
    set validation_attempts = candidate.validation_attempts + 1,
        validation_processing_started_at = clock_timestamp(),
        validation_lease_expires_at = least(
          clock_timestamp() + interval '3 minutes',
          candidate.validation_deadline_at
        ),
        validation_lease_token = lease_id,
        last_error_code = null
    where id = candidate.id;

    attempt_id := candidate.id;
    initiated_by := candidate.initiated_by;
    validation_lease_token := lease_id;
    business_access_token := secret_value;
    submitted_business_portfolio_id :=
      candidate.submitted_business_portfolio_id;
    submitted_waba_id := candidate.submitted_waba_id;
    submitted_phone_number_id := candidate.submitted_phone_number_id;
    history_sharing_decision := candidate.history_sharing_decision;
    validation_deadline_at := candidate.validation_deadline_at;
    validation_attempts := candidate.validation_attempts + 1;
    claimed := claimed + 1;
    return next;
  end loop;
end;
$$;

create or replace function public.fail_whatsapp_embedded_signup_validation(
  p_attempt_id uuid,
  p_validation_lease_token uuid,
  p_error_code text,
  p_retryable boolean default false
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempt public.whatsapp_embedded_signup_attempts%rowtype;
  clean_error text := upper(trim(coalesce(p_error_code, '')));
  retry_seconds integer;
  retry_at timestamptz;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if clean_error !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_VALIDATION_ERROR_INVALID'
      using errcode = '22023';
  end if;
  select * into attempt
  from public.whatsapp_embedded_signup_attempts candidate
  where candidate.id = p_attempt_id
    and candidate.status = 'validating'
    and candidate.validation_lease_token = p_validation_lease_token
    and candidate.validation_lease_expires_at > clock_timestamp()
  for update;
  if not found then return 'stale'; end if;

  retry_seconds := least(
    300,
    (5 * power(2, least(greatest(attempt.validation_attempts - 1, 0), 6)))::integer
  );
  retry_at := clock_timestamp() + make_interval(secs => retry_seconds);
  if coalesce(p_retryable, false)
    and attempt.validation_attempts < attempt.validation_max_attempts
    and retry_at < attempt.validation_deadline_at
  then
    update public.whatsapp_embedded_signup_attempts
    set validation_available_at = retry_at,
        validation_processing_started_at = null,
        validation_lease_expires_at = null,
        validation_lease_token = null,
        last_error_code = clean_error
    where id = attempt.id;
    return 'retrying';
  end if;

  if attempt.temporary_token_secret_id is not null then
    delete from vault.secrets secret
    where secret.id = attempt.temporary_token_secret_id
      and secret.name = 'whatsapp_embedded_signup_token_' || attempt.id::text;
  end if;
  if attempt.pre_completion_token_validated_at is not null
    and attempt.pre_completion_validation_attempt = attempt.validation_attempts
    and attempt.pre_completion_token_error_code is null
  then
    update public.whatsapp_business_token_validations validation
    set authorization_valid = false,
        error_code = clean_error
    where validation.onboarding_attempt_id = attempt.id
      and validation.validation_reason = 'pre_completion'
      and validation.checkpoint_attempt = attempt.validation_attempts;
  end if;
  update public.whatsapp_embedded_signup_attempts
  set status = 'failed',
      temporary_token_secret_id = null,
      validation_processing_started_at = null,
      validation_lease_expires_at = null,
      validation_lease_token = null,
      pre_completion_token_error_code = case
        when pre_completion_token_validated_at is not null
          and pre_completion_validation_attempt = validation_attempts
          and pre_completion_token_error_code is null
        then clean_error else pre_completion_token_error_code end,
      last_error_code = clean_error
  where id = attempt.id;
  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    attempt.initiated_by,
    'whatsapp.embedded_signup.validation_failed',
    'whatsapp_embedded_signup_attempt',
    attempt.id,
    jsonb_build_object(
      'error_code', clean_error,
      'attempts', attempt.validation_attempts
    )
  );
  return 'failed';
end;
$$;

create or replace function public.schedule_whatsapp_business_token_validation(
  p_account_id uuid,
  p_token_generation bigint,
  p_available_at timestamptz,
  p_validation_reason text default 'periodic'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job_id uuid;
  existing_job public.whatsapp_business_token_validation_jobs%rowtype;
  clean_reason text := lower(trim(coalesce(p_validation_reason, '')));
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if p_account_id is null or p_token_generation <= 0
    or p_available_at is null
    or clean_reason not in (
      'periodic', 'auth_error', 'critical_operation', 'reconnect'
    )
  then
    raise exception 'WHATSAPP_TOKEN_VALIDATION_SCHEDULE_INVALID'
      using errcode = '22023';
  end if;
  insert into public.whatsapp_business_token_validation_jobs (
    account_id, token_generation, validation_reason, status, attempts,
    available_at
  ) values (
    p_account_id, p_token_generation, clean_reason, 'pending', 0,
    p_available_at
  ) on conflict (account_id) do nothing
  returning id into job_id;
  if job_id is not null then return job_id; end if;

  select * into existing_job
  from public.whatsapp_business_token_validation_jobs candidate
  where candidate.account_id = p_account_id
  for update;
  if not found then
    raise exception 'WHATSAPP_TOKEN_VALIDATION_SCHEDULE_RACE'
      using errcode = '40001';
  end if;

  -- Never clobber an in-flight lease or a causal pause for the same token
  -- generation. In particular a concurrent critical/periodic request cannot
  -- erase an auth_error checkpoint. Reconnect is scheduled only after the
  -- lifecycle transition has cancelled the prior job.
  if existing_job.token_generation = p_token_generation
    and (
      existing_job.status = 'processing'
      or (
        existing_job.pause_observed_at is not null
        and clean_reason <> 'reconnect'
      )
    )
  then
    return existing_job.id;
  end if;

  update public.whatsapp_business_token_validation_jobs target
  set token_generation = p_token_generation,
      validation_reason = clean_reason,
      status = 'pending',
      attempts = 0,
      available_at = p_available_at,
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      last_error_code = null,
      pause_observed_at = null,
      pause_error_code = null
  where target.id = existing_job.id
  returning target.id into job_id;
  return job_id;
end;
$$;

create or replace function public.block_whatsapp_account_graph_work(
  p_account_id uuid,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  clean_reason text := upper(trim(coalesce(p_reason, '')));
  changed integer := 0;
  current_count integer;
  committed record;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if clean_reason !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'WHATSAPP_GRAPH_WORK_BLOCK_REASON_INVALID'
      using errcode = '22023';
  end if;

  update public.whatsapp_onboarding_outbox
  set status = 'cancelled',
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      failed_at = null,
      last_error_code = clean_reason
  where account_id = p_account_id
    -- An explicit administrative offboarding owns this job. Lifecycle and
    -- credential pauses must stop every other Graph operation without
    -- destroying the only durable path that can reconcile/finalize the
    -- unsubscribe.
    and operation <> 'unsubscribe_app'
    and status in ('pending', 'processing', 'ambiguous', 'failed');
  get diagnostics changed = row_count;

  update public.whatsapp_automation_dispatches dispatch
  set status = 'completed',
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      completed_at = clock_timestamp(),
      failed_at = null,
      completion_reason = 'skipped',
      last_error = clean_reason
  from public.messages message
  join public.conversations conversation
    on conversation.id = message.conversation_id
  where dispatch.message_id = message.id
    and (
      message.coexistence_account_id = p_account_id
      or conversation.coexistence_account_id = p_account_id
    )
    and dispatch.status in ('reserved', 'pending', 'processing', 'failed');
  get diagnostics current_count = row_count;
  changed := changed + current_count;

  -- If the domain appointment effect committed before the Graph response was
  -- sent, invalidating the worker lease alone would strand the conversation
  -- in its pre-effect automatic state. Reproduce the durable handoff that the
  -- worker would have written, locking the execution before conversation and
  -- session state. The appointment/effect itself remains exactly-once.
  for committed in
    select
      execution.message_id,
      execution.conversation_id,
      execution.message_ingest_sequence,
      domain_effect.appointment_id
    from public.whatsapp_automation_executions execution
    join public.messages message on message.id = execution.message_id
    join public.conversations conversation
      on conversation.id = execution.conversation_id
    cross join lateral (
      select effect.appointment_id
      from public.whatsapp_automation_effects effect
      where effect.execution_message_id = execution.message_id
        and effect.effect_type in (
          'appointment_create', 'appointment_reschedule', 'appointment_cancel'
        )
        and effect.appointment_id is not null
        and coalesce(effect.result ->> 'effect_status', '') <> 'rejected'
      order by effect.created_at desc, effect.effect_key desc
      limit 1
    ) domain_effect
    where (
        message.coexistence_account_id = p_account_id
        or conversation.coexistence_account_id = p_account_id
      )
      and execution.status in ('processing', 'failed')
    order by execution.message_id
    for update of execution
  loop
    update public.conversations conversation
    set automation_mode = 'manual',
        needs_human = true,
        automation_pause_source = 'inbound_handoff',
        automation_pause_message_id = committed.message_id
    where conversation.id = committed.conversation_id
      and conversation.coexistence_account_id = p_account_id;

    insert into public.automation_sessions (
      conversation_id, state, context, expires_at,
      last_automation_message_id, last_automation_ingest_sequence,
      last_automation_session_sequence
    ) values (
      committed.conversation_id,
      'human_handoff',
      jsonb_build_object(
        'appointmentId', committed.appointment_id,
        'reason', 'ACCOUNT_BLOCKED_AFTER_COMMITTED_EFFECT',
        'blockReason', clean_reason
      ),
      clock_timestamp() + interval '30 days',
      committed.message_id,
      committed.message_ingest_sequence,
      100
    )
    on conflict (conversation_id) do update
    set state = 'human_handoff',
        context = excluded.context,
        expires_at = excluded.expires_at,
        last_automation_message_id = excluded.last_automation_message_id,
        last_automation_ingest_sequence =
          excluded.last_automation_ingest_sequence,
        last_automation_session_sequence =
          excluded.last_automation_session_sequence
    where automation_sessions.last_automation_ingest_sequence is null
      or automation_sessions.last_automation_ingest_sequence
        <= excluded.last_automation_ingest_sequence;

    insert into public.whatsapp_automation_effects (
      execution_message_id, effect_key, effect_type, request, result,
      appointment_id
    ) values (
      committed.message_id,
      'terminal:handoff',
      'handoff',
      jsonb_build_object(
        'appointment_id', committed.appointment_id,
        'reason', 'ACCOUNT_BLOCKED_AFTER_COMMITTED_EFFECT'
      ),
      jsonb_build_object(
        'processed', true,
        'state', 'human_handoff',
        'reason', 'ACCOUNT_BLOCKED_AFTER_COMMITTED_EFFECT',
        'blockReason', clean_reason,
        'appointmentId', committed.appointment_id
      ),
      committed.appointment_id
    ) on conflict (execution_message_id, effect_key) do nothing;
  end loop;

  -- A worker may already hold an automation execution lease when an account
  -- is disconnected. Terminalize both in-flight and retryable executions for
  -- this exact routing identity. Clearing the lease makes every later stale
  -- effect RPC fail, while completed executions and siblings stay immutable.
  update public.whatsapp_automation_executions execution
  set status = 'completed',
      retryable = false,
      outcome = case when exists (
        select 1
        from public.whatsapp_automation_effects effect
        where effect.execution_message_id = execution.message_id
          and effect.effect_key = 'terminal:handoff'
          and effect.effect_type = 'handoff'
      ) then (
        select effect.result
        from public.whatsapp_automation_effects effect
        where effect.execution_message_id = execution.message_id
          and effect.effect_key = 'terminal:handoff'
      ) else jsonb_build_object(
          'processed', false,
          'blocked', true,
          'state', 'account_blocked',
          'reason', clean_reason
        ) end,
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      completed_at = clock_timestamp(),
      failed_at = null,
      last_error = clean_reason
  from public.messages message
  join public.conversations conversation
    on conversation.id = message.conversation_id
  where execution.message_id = message.id
    and execution.conversation_id = conversation.id
    and (
      message.coexistence_account_id = p_account_id
      or conversation.coexistence_account_id = p_account_id
    )
    and execution.status in ('processing', 'failed');
  get diagnostics current_count = row_count;
  changed := changed + current_count;

  update public.reminders reminder
  set status = 'cancelled',
      processing_started_at = null,
      last_error = clean_reason
  from public.appointments appointment
  where reminder.appointment_id = appointment.id
    and reminder.status in ('pending', 'processing', 'failed')
    and exists (
      select 1
      from public.conversations target_conversation
      where target_conversation.contact_id = appointment.contact_id
        and target_conversation.coexistence_account_id = p_account_id
    )
    and not exists (
      select 1
      from public.conversations sibling_conversation
      where sibling_conversation.contact_id = appointment.contact_id
        and sibling_conversation.coexistence_account_id is not null
        and sibling_conversation.coexistence_account_id <> p_account_id
    );
  get diagnostics current_count = row_count;
  changed := changed + current_count;

  -- Booking-hold expiration itself remains durable business state. Only its
  -- outbound notification work is terminalized. Setting a not-yet-expired
  -- hold to cancelled also prevents expire_booking_holds from re-queuing it.
  update public.appointments appointment
  set hold_expired_notification_status = 'cancelled',
      hold_expired_notification_claimed_at = null,
      hold_expired_notification_error = clean_reason
  where (
      (
        appointment.deposit_status = 'pending'
        and appointment.hold_expires_at is not null
      )
      or appointment.hold_expired_notification_status in (
        'pending', 'processing', 'failed'
      )
    )
    and exists (
      select 1
      from public.conversations target_conversation
      where target_conversation.contact_id = appointment.contact_id
        and target_conversation.coexistence_account_id = p_account_id
    )
    and not exists (
      select 1
      from public.conversations sibling_conversation
      where sibling_conversation.contact_id = appointment.contact_id
        and sibling_conversation.coexistence_account_id is not null
        and sibling_conversation.coexistence_account_id <> p_account_id
    );
  get diagnostics current_count = row_count;
  return changed + current_count;
end;
$$;

-- App echoes are account-scoped once Embedded Signup manages an identity.
-- Resolve an existing conversation before calling shared get-or-create
-- helpers so a cross-account echo rolls back without enriching the sibling
-- contact or changing its automation ownership.
create or replace function public.pause_whatsapp_automation_for_app_echo(
  p_account_id uuid,
  p_phone_e164 text,
  p_whatsapp_user_id text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  clean_phone text := nullif(trim(coalesce(p_phone_e164, '')), '');
  clean_user_id text := nullif(trim(coalesce(p_whatsapp_user_id, '')), '');
  contact_row public.contacts%rowtype;
  candidate public.contacts%rowtype;
  conversation_row public.conversations%rowtype;
  updated_count integer := 0;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if p_account_id is null
    or (clean_phone is null and clean_user_id is null)
    or (clean_phone is not null and clean_phone !~ '^\+[1-9][0-9]{7,14}$')
    or (
      clean_user_id is not null
      and (
        char_length(clean_user_id) not between 1 and 256
        or clean_user_id !~ '^[A-Za-z0-9.]+$'
      )
    )
  then
    raise exception 'WHATSAPP_ECHO_IDENTITY_INVALID' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.whatsapp_coexistence_accounts account
    where account.id = p_account_id
      and (
        account.last_onboarding_attempt_id is not null
        or account.business_token_generation > 0
        or account.onboarding_status <> 'not_started'
      )
  ) then
    raise exception 'WHATSAPP_ECHO_ACCOUNT_NOT_MANAGED'
      using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(identity_key, 811))
  from (
    select distinct identity_key
    from unnest(array[
      case when clean_phone is not null then 'phone:' || clean_phone end,
      case when clean_user_id is not null then 'user:' || clean_user_id end
    ]) supplied(identity_key)
    where identity_key is not null
    order by identity_key
  ) locked_identity;

  for candidate in
    select contact.*
    from public.contacts contact
    where (clean_phone is not null and contact.phone_e164 = clean_phone)
      or (
        clean_user_id is not null
        and contact.whatsapp_user_id = clean_user_id
      )
    order by contact.id
    for update
  loop
    if contact_row.id is not null and contact_row.id <> candidate.id then
      raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
        using errcode = '23505';
    end if;
    contact_row := candidate;
  end loop;

  if contact_row.id is not null then
    select * into conversation_row
    from public.conversations conversation
    where conversation.contact_id = contact_row.id
      and conversation.status = 'open'
    limit 1
    for update;
    if found and conversation_row.coexistence_account_id is not null
      and conversation_row.coexistence_account_id <> p_account_id
    then
      raise exception 'WHATSAPP_ECHO_ACCOUNT_MISMATCH'
        using errcode = '55000';
    end if;
  end if;

  contact_row := public.get_or_create_whatsapp_coexistence_contact(
    clean_phone, null, clean_user_id, 'Paciente'
  );
  conversation_row := public.get_or_create_whatsapp_coexistence_conversation(
    contact_row.id, clock_timestamp()
  );
  if conversation_row.coexistence_account_id is not null
    and conversation_row.coexistence_account_id <> p_account_id
  then
    raise exception 'WHATSAPP_ECHO_ACCOUNT_MISMATCH'
      using errcode = '55000';
  end if;
  if conversation_row.coexistence_account_id is null then
    update public.conversations conversation
    set coexistence_account_id = p_account_id
    where conversation.id = conversation_row.id
      and conversation.coexistence_account_id is null
    returning * into conversation_row;
  end if;

  update public.conversations conversation
  set automation_mode = 'manual',
      needs_human = false,
      automation_pause_source = 'app_echo',
      automation_pause_message_id = null
  where conversation.id = conversation_row.id
    and conversation.contact_id = contact_row.id
    and conversation.coexistence_account_id = p_account_id
    and (
      conversation.automation_mode <> 'manual'
      or conversation.needs_human
      or conversation.automation_pause_source is distinct from 'app_echo'
      or conversation.automation_pause_message_id is not null
    );
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

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
  app_generation_id uuid;
  history_generation_id uuid;
  token_secret_id uuid;
  next_token_generation bigint;
  secret_name text;
  secret_count integer;
  secret_value text;
  checkpoint_count integer;
  provisioned_at_value timestamptz := clock_timestamp();
  finish_received_at_value timestamptz;
  deadline_value timestamptz;
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
  -- Shared lock order with account_update: WABA first, then attempt/account.
  -- This prevents completion from holding an attempt row while waiting on a
  -- lifecycle transaction that is itself waiting to terminalize that attempt.
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

  -- The WABA lock above serializes completion with account_update. The phone
  -- lock additionally protects its unique account identity.
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
    -- An older disconnection may be deliberately superseded by a new signup.
    -- A lifecycle/offboarding transition concurrent with this attempt cannot:
    -- the administrator must start a fresh transaction after observing it.
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_LIFECYCLE_CONFLICT'
      using errcode = '55000';
  elsif account.business_token_status = 'active'
    or account.onboarding_status in ('provisioning', 'completed', 'offboarding')
  then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_ALREADY_CONNECTED'
      using errcode = '55000';
  end if;

  -- Coexistence history callbacks do not carry our request/generation ID. If
  -- this WABA has ever started a history request, a later payload cannot be
  -- distinguished from that previous generation. Contacts can be re-synced,
  -- but history must remain declined until Meta exposes correlation or an
  -- explicit manual-review workflow is implemented.
  if attempt.history_sharing_decision = 'accepted'
    and exists (
      select 1
      from public.whatsapp_onboarding_outbox prior_job
      join public.whatsapp_coexistence_accounts prior_account
        on prior_account.id = prior_job.account_id
      where prior_account.waba_id = trim(p_verified_waba_id)
        and prior_job.operation = 'request_history_sync'
        and (
          prior_job.attempts > 0
          or prior_job.remote_request_id is not null
          or prior_job.status = 'ambiguous'
        )
    )
  then
    raise exception 'WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW'
      using errcode = '55000';
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
      attention_required = false,
      attention_required_at = null,
      attention_required_reason = null,
      onboarding_status = 'provisioning',
      onboarded_by = p_admin_user_id,
      -- The 24-hour initial-sync window begins when our backend receives the
      -- official FINISH session, not after later Graph validation latency.
      onboarding_completed_at = finish_received_at_value,
      initial_sync_deadline_at = deadline_value,
      history_sharing_decision = attempt.history_sharing_decision,
      app_subscription_status = 'pending',
      app_subscribed_at = null,
      last_account_update_at = null,
      last_account_update_event = null,
      last_disconnection_reason = null,
      last_disconnection_initiated_by = null,
      offboarding_requested_at = null,
      offboarded_at = null,
      onboarding_last_error_code = null,
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
  if attempt.history_sharing_decision = 'accepted' then
    select history_sync_generation_id into history_generation_id
    from public.start_whatsapp_coexistence_sync_generation(
      account.id,
      'history',
      null,
      provisioned_at_value
    );
  end if;

  update public.whatsapp_coexistence_accounts
  set app_state_sync_token_generation = next_token_generation,
      history_sync_token_generation = case
        when attempt.history_sharing_decision = 'accepted'
          then next_token_generation
        else null
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

  if history_generation_id is not null then
    insert into public.whatsapp_onboarding_outbox (
      account_id, onboarding_attempt_id, token_generation, operation,
      idempotency_key, deadline_at, sync_generation_id
    ) values (
      account.id, attempt.id, next_token_generation, 'request_history_sync',
      'embedded:' || account.id::text || ':'
        || next_token_generation::text || ':history',
      deadline_value, history_generation_id
    );
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

  -- Fail closed: onboarding can never enable sending or automation. Clearing
  -- this pause and changing WHATSAPP_AUTOMATIONS_ENABLED remain separate,
  -- explicitly authorized production operations.
  update public.whatsapp_settings
  set display_phone = coalesce(account.display_phone, display_phone),
      integration_status = 'incomplete',
      sending_paused = true,
      sending_pause_reason = 'COEXISTENCE_ONBOARDING',
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
      'sync_deadline_at', deadline_value
    )
  );

  return query
  select
    account.id,
    'provisioning'::text,
    'pending'::text,
    'pending'::text,
    case when attempt.history_sharing_decision = 'accepted'
      then 'pending' else 'declined' end,
    deadline_value;
end;
$$;

create or replace function public.fail_whatsapp_embedded_signup_attempt(
  p_attempt_id uuid,
  p_admin_user_id uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempt public.whatsapp_embedded_signup_attempts%rowtype;
  clean_error text := upper(trim(coalesce(p_error_code, '')));
begin
  perform public.assert_whatsapp_embedded_signup_admin(p_admin_user_id);
  if clean_error !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_ERROR_INVALID'
      using errcode = '22023';
  end if;
  select * into attempt
  from public.whatsapp_embedded_signup_attempts candidate
  where candidate.id = p_attempt_id
    and candidate.initiated_by = p_admin_user_id
    and candidate.status in (
      'initiated', 'session_received', 'exchanging', 'token_stored', 'validating'
    )
  for update;
  if not found then return false; end if;
  if attempt.temporary_token_secret_id is not null then
    delete from vault.secrets secret
    where secret.id = attempt.temporary_token_secret_id
      and secret.name = 'whatsapp_embedded_signup_token_' || attempt.id::text;
  end if;
  update public.whatsapp_embedded_signup_attempts
  set status = 'failed',
      temporary_token_secret_id = null,
      validation_processing_started_at = null,
      validation_lease_expires_at = null,
      validation_lease_token = null,
      last_error_code = clean_error
  where id = attempt.id;
  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    p_admin_user_id,
    'whatsapp.embedded_signup.failed',
    'whatsapp_embedded_signup_attempt',
    p_attempt_id,
    jsonb_build_object('error_code', clean_error)
  );
  return true;
end;
$$;

create or replace function public.cancel_whatsapp_embedded_signup_attempt(
  p_attempt_id uuid,
  p_admin_user_id uuid,
  p_reason text default 'USER_CANCELLED'
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  clean_reason text := upper(trim(coalesce(p_reason, '')));
  attempt public.whatsapp_embedded_signup_attempts%rowtype;
begin
  perform public.assert_whatsapp_embedded_signup_admin(p_admin_user_id);
  if clean_reason not in ('USER_CANCELLED', 'META_CANCELLED', 'META_ERROR') then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_CANCEL_INVALID'
      using errcode = '22023';
  end if;
  select * into attempt
  from public.whatsapp_embedded_signup_attempts candidate
  where candidate.id = p_attempt_id
    and candidate.initiated_by = p_admin_user_id
    and candidate.status in (
      'initiated', 'session_received', 'exchanging', 'token_stored', 'validating'
    )
  for update;
  if not found then return false; end if;
  if attempt.temporary_token_secret_id is not null then
    delete from vault.secrets secret
    where secret.id = attempt.temporary_token_secret_id
      and secret.name = 'whatsapp_embedded_signup_token_' || attempt.id::text;
  end if;
  update public.whatsapp_embedded_signup_attempts
  set status = case when clean_reason = 'META_ERROR' then 'failed'
        else 'cancelled' end,
      temporary_token_secret_id = null,
      validation_processing_started_at = null,
      validation_lease_expires_at = null,
      validation_lease_token = null,
      cancelled_at = clock_timestamp(),
      last_error_code = clean_reason
  where id = attempt.id;
  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    p_admin_user_id,
    'whatsapp.embedded_signup.cancelled',
    'whatsapp_embedded_signup_attempt',
    p_attempt_id,
    jsonb_build_object('reason', clean_reason)
  );
  return true;
end;
$$;

create or replace function public.resolve_whatsapp_account_credentials(
  p_purpose text,
  p_account_id uuid default null,
  p_waba_id text default null,
  p_phone_number_id text default null,
  p_conversation_id uuid default null,
  p_expected_token_generation bigint default null
)
returns table (
  credential_mode text,
  account_id uuid,
  waba_id text,
  phone_number_id text,
  business_access_token text,
  token_generation bigint,
  coexistence_status text,
  onboarding_status text,
  app_subscription_status text,
  business_token_status text,
  business_token_validation_status text,
  sending_paused boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  clean_purpose text := lower(trim(coalesce(p_purpose, '')));
  clean_waba_id text := nullif(trim(coalesce(p_waba_id, '')), '');
  clean_phone_number_id text := nullif(
    trim(coalesce(p_phone_number_id, '')), ''
  );
  selected_account public.whatsapp_coexistence_accounts%rowtype;
  bound_account_id uuid;
  candidate_count integer;
  managed_account_count integer;
  active_attempt_count integer;
  secret_count integer;
  secret_value text;
  expected_name text;
  globally_paused boolean := true;
  now_value timestamptz := clock_timestamp();
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if clean_purpose not in (
    'send', 'media', 'management', 'onboarding', 'unsubscribe',
    'token_validation'
  ) then
    raise exception 'WHATSAPP_CREDENTIAL_PURPOSE_INVALID'
      using errcode = '22023';
  end if;
  if (clean_waba_id is not null and clean_waba_id !~ '^[0-9]{5,64}$')
    or (
      clean_phone_number_id is not null
      and clean_phone_number_id !~ '^[0-9]{5,64}$'
    )
    or (
      p_expected_token_generation is not null
      and p_expected_token_generation <= 0
    )
  then
    raise exception 'WHATSAPP_CREDENTIAL_SELECTOR_INVALID'
      using errcode = '22023';
  end if;

  select coalesce(settings.sending_paused, true)
  into globally_paused
  from public.whatsapp_settings settings
  where settings.id = true;

  if p_conversation_id is not null then
    select conversation.coexistence_account_id into bound_account_id
    from public.conversations conversation
    where conversation.id = p_conversation_id;
    if not found then
      raise exception 'WHATSAPP_CREDENTIAL_CONVERSATION_NOT_FOUND'
        using errcode = 'P0002';
    end if;
    if bound_account_id is null and (
      p_account_id is not null
      or clean_waba_id is not null
      or clean_phone_number_id is not null
    ) then
      raise exception 'WHATSAPP_CREDENTIAL_CONVERSATION_UNBOUND'
        using errcode = '55000';
    end if;
    if bound_account_id is not null
      and p_account_id is not null
      and p_account_id <> bound_account_id
    then
      raise exception 'WHATSAPP_CREDENTIAL_ACCOUNT_MISMATCH'
        using errcode = '55000';
    end if;
  end if;

  -- With no selector, legacy mode is permitted only when Embedded Signup has
  -- never started managing any identity. The legacy token itself remains an
  -- environment secret and is deliberately not read or returned by SQL.
  if p_account_id is null and clean_waba_id is null
    and clean_phone_number_id is null and bound_account_id is null
  then
    if clean_purpose not in ('send', 'media', 'management') then
      raise exception 'WHATSAPP_CREDENTIAL_ACCOUNT_REQUIRED'
        using errcode = '22023';
    end if;
    select count(*) into managed_account_count
    from public.whatsapp_coexistence_accounts account
    where account.last_onboarding_attempt_id is not null
      or account.business_token_generation > 0
      or account.onboarding_status <> 'not_started';
    select count(*) into active_attempt_count
    from public.whatsapp_embedded_signup_attempts attempt
    where attempt.status in (
      'initiated', 'session_received', 'exchanging', 'token_stored',
      'validating'
    );
    if managed_account_count > 0 or active_attempt_count > 0 then
      raise exception 'WHATSAPP_LEGACY_CREDENTIALS_DISABLED'
        using errcode = '55000';
    end if;
    if clean_purpose = 'send' and globally_paused then
      raise exception 'WHATSAPP_SENDING_PAUSED'
        using errcode = '55000';
    end if;
    return query select
      'legacy'::text, null::uuid, null::text, null::text, null::text,
      null::bigint, null::text, null::text, null::text, null::text,
      null::text, globally_paused;
    return;
  end if;

  select count(*) into candidate_count
  from public.whatsapp_coexistence_accounts candidate
  where (p_account_id is null or candidate.id = p_account_id)
    and (bound_account_id is null or candidate.id = bound_account_id)
    and (clean_waba_id is null or candidate.waba_id = clean_waba_id)
    and (
      clean_phone_number_id is null
      or candidate.phone_number_id = clean_phone_number_id
    )
    and (
      candidate.last_onboarding_attempt_id is not null
      or candidate.business_token_generation > 0
      or candidate.onboarding_status <> 'not_started'
    );
  if candidate_count = 0 then
    raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  elsif candidate_count <> 1 then
    raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_AMBIGUOUS'
      using errcode = '21000';
  end if;
  select candidate.* into selected_account
  from public.whatsapp_coexistence_accounts candidate
  where (p_account_id is null or candidate.id = p_account_id)
    and (bound_account_id is null or candidate.id = bound_account_id)
    and (clean_waba_id is null or candidate.waba_id = clean_waba_id)
    and (
      clean_phone_number_id is null
      or candidate.phone_number_id = clean_phone_number_id
    )
    and (
      candidate.last_onboarding_attempt_id is not null
      or candidate.business_token_generation > 0
      or candidate.onboarding_status <> 'not_started'
    );
  if p_expected_token_generation is not null
    and selected_account.business_token_generation
      <> p_expected_token_generation
  then
    raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_GENERATION_STALE'
      using errcode = '55000';
  end if;
  if selected_account.business_token_secret_id is null
    or selected_account.business_token_generation <= 0
  then
    raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_UNAVAILABLE'
      using errcode = '55000';
  end if;

  if clean_purpose = 'send' then
    if selected_account.onboarding_status <> 'completed'
      or selected_account.coexistence_status <> 'active'
      or selected_account.app_subscription_status <> 'subscribed'
      or selected_account.attention_required
      or globally_paused
    then
      raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_BLOCKED'
        using errcode = '55000';
    end if;
  elsif clean_purpose = 'media' then
    if selected_account.onboarding_status not in ('provisioning', 'completed')
      or selected_account.coexistence_status not in (
        'onboarding', 'active', 'paused'
      )
      or selected_account.app_subscription_status not in (
        'pending', 'subscribed'
      )
    then
      raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_BLOCKED'
        using errcode = '55000';
    end if;
  elsif clean_purpose = 'management' then
    if selected_account.onboarding_status <> 'completed'
      or selected_account.coexistence_status not in ('active', 'paused')
      or selected_account.app_subscription_status <> 'subscribed'
    then
      raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_BLOCKED'
        using errcode = '55000';
    end if;
  elsif clean_purpose = 'onboarding' then
    if selected_account.onboarding_status not in ('provisioning', 'completed')
      or selected_account.coexistence_status not in (
        'onboarding', 'active', 'paused'
      )
    then
      raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_BLOCKED'
        using errcode = '55000';
    end if;
  elsif clean_purpose = 'unsubscribe' then
    if selected_account.onboarding_status <> 'offboarding'
      or selected_account.coexistence_status <> 'paused'
    then
      raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_BLOCKED'
        using errcode = '55000';
    end if;
  elsif selected_account.onboarding_status = 'offboarded'
    or selected_account.business_token_status = 'revoked'
  then
    raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_BLOCKED'
      using errcode = '55000';
  end if;

  -- Unsubscribe and token validation may need a retained token specifically
  -- to confirm or diagnose lifecycle state. Every other Graph purpose is
  -- fail-closed on fresh, valid, correctly scoped debug_token metadata.
  if clean_purpose not in ('unsubscribe', 'token_validation') then
    if selected_account.business_token_status <> 'active'
      or selected_account.business_token_validation_status <> 'valid'
      or selected_account.business_token_is_valid is distinct from true
      or selected_account.business_token_last_validated_at is null
      or selected_account.business_token_validation_due_at is null
      or selected_account.business_token_validation_due_at <= now_value
      or selected_account.business_token_app_id is null
      or selected_account.business_token_expires_at <= now_value
      or selected_account.business_token_data_access_expires_at <= now_value
      or not public.is_valid_whatsapp_business_token_metadata(
        selected_account.business_token_scopes,
        selected_account.business_token_granular_scopes,
        selected_account.business_token_target_ids
      )
      or not (
        'whatsapp_business_management'
          = any(selected_account.business_token_scopes)
      )
      or not (
        'whatsapp_business_messaging'
          = any(selected_account.business_token_scopes)
      )
      or not (
        selected_account.waba_id
          = any(selected_account.business_token_target_ids)
    )
    then
      if clean_purpose in ('management', 'onboarding') then
        perform public.schedule_whatsapp_business_token_validation(
          selected_account.id,
          selected_account.business_token_generation,
          now_value,
          'critical_operation'
        );
        return;
      end if;
      raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_NOT_VALIDATED'
        using errcode = '55000';
    end if;
  elsif clean_purpose = 'unsubscribe'
    and selected_account.business_token_status not in (
      'active', 'unknown', 'invalid', 'expired'
    )
  then
    raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_UNAVAILABLE'
      using errcode = '55000';
  end if;

  expected_name := 'whatsapp_business_access_token_'
    || selected_account.id::text;
  select count(*), min(secret.decrypted_secret)
  into secret_count, secret_value
  from vault.decrypted_secrets secret
  where secret.id = selected_account.business_token_secret_id
    and secret.name = expected_name;
  if secret_count <> 1 or coalesce(secret_value, '') = ''
    or secret_value ~ E'[\\r\\n]' then
    raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_CORRUPT'
      using errcode = '55000';
  end if;

  return query select
    'coexistence'::text,
    selected_account.id,
    selected_account.waba_id,
    selected_account.phone_number_id,
    secret_value,
    selected_account.business_token_generation,
    selected_account.coexistence_status,
    selected_account.onboarding_status,
    selected_account.app_subscription_status,
    selected_account.business_token_status,
    selected_account.business_token_validation_status,
    globally_paused;
end;
$$;

create or replace function public.mark_whatsapp_business_token_attention_required(
  p_account_id uuid,
  p_expected_token_generation bigint,
  p_token_status text,
  p_error_code text,
  p_observed_at timestamptz default clock_timestamp()
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  account public.whatsapp_coexistence_accounts%rowtype;
  clean_status text := lower(trim(coalesce(p_token_status, '')));
  clean_error text := upper(trim(coalesce(p_error_code, '')));
  validation_state text;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if clean_status not in ('unknown', 'invalid', 'expired', 'revoked')
    or clean_error !~ '^[A-Z0-9_]{3,100}$'
    or p_expected_token_generation is null
    or p_expected_token_generation <= 0
    or p_observed_at is null
    or p_observed_at > clock_timestamp() + interval '5 minutes'
  then
    raise exception 'WHATSAPP_TOKEN_ATTENTION_INPUT_INVALID'
      using errcode = '22023';
  end if;
  select * into account
  from public.whatsapp_coexistence_accounts candidate
  where candidate.id = p_account_id
  for update;
  if not found then
    raise exception 'WHATSAPP_COEXISTENCE_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;
  if account.business_token_generation <> p_expected_token_generation then
    return false;
  end if;
  if account.business_token_secret_id is null
    or account.onboarding_status = 'offboarded'
  then
    return false;
  end if;

  validation_state := case clean_status
    when 'expired' then 'expired'
    when 'unknown' then 'unknown'
    else 'invalid'
  end;
  update public.whatsapp_coexistence_accounts
  set business_token_status = clean_status,
      business_token_is_valid = case when clean_status = 'unknown'
        then null else false end,
      business_token_validation_status = validation_state,
      business_token_validation_due_at = p_observed_at,
      business_token_last_validation_error_code = clean_error,
      attention_required = true,
      attention_required_at = p_observed_at,
      attention_required_reason = clean_error,
      coexistence_status = case
        when coexistence_status = 'disconnected' then 'disconnected'
        else 'paused'
      end,
      onboarding_status = case
        when onboarding_status = 'provisioning' then 'failed'
        else onboarding_status
      end,
      onboarding_last_error_code = clean_error
  where id = account.id;

  perform public.block_whatsapp_account_graph_work(account.id, clean_error);
  if clean_status = 'unknown' then
    perform public.schedule_whatsapp_business_token_validation(
      account.id,
      account.business_token_generation,
      greatest(p_observed_at, clock_timestamp()),
      'auth_error'
    );
    update public.whatsapp_business_token_validation_jobs validation_job
    set validation_reason = 'auth_error',
        pause_observed_at = p_observed_at,
        pause_error_code = clean_error
    where validation_job.account_id = account.id
      and validation_job.token_generation = account.business_token_generation;
  else
    insert into public.whatsapp_business_token_validation_jobs (
      account_id, token_generation, validation_reason, status, attempts,
      available_at, last_error_code
    ) values (
      account.id, account.business_token_generation, 'auth_error',
      'failed', 0, p_observed_at, clean_error
    ) on conflict (account_id) do update
    set token_generation = excluded.token_generation,
        validation_reason = excluded.validation_reason,
        status = 'failed',
        processing_started_at = null,
        lease_expires_at = null,
        lease_token = null,
        last_error_code = excluded.last_error_code,
        pause_observed_at = p_observed_at,
        pause_error_code = clean_error;
  end if;
  insert into public.whatsapp_business_token_validations (
    account_id, token_generation, validation_reason, is_valid,
    authorization_valid, app_id,
    scopes, granular_scopes, target_ids, expires_at,
    data_access_expires_at, expires_at_epoch,
    data_access_expires_at_epoch, validated_at, error_code
  ) values (
    account.id, account.business_token_generation, 'auth_error',
    case when clean_status = 'unknown' then null else false end,
    false,
    account.business_token_app_id, account.business_token_scopes,
    account.business_token_granular_scopes,
    account.business_token_target_ids, account.business_token_expires_at,
    account.business_token_data_access_expires_at,
    case when account.business_token_expires_at is null then null
      else extract(epoch from account.business_token_expires_at)::bigint end,
    case when account.business_token_data_access_expires_at is null then null
      else extract(epoch from account.business_token_data_access_expires_at)::bigint end,
    p_observed_at, clean_error
  );
  insert into public.audit_logs (
    action, entity_type, entity_id, metadata
  ) values (
    'whatsapp.business_token.attention_required',
    'whatsapp_coexistence_account',
    account.id,
    jsonb_build_object(
      'token_generation', account.business_token_generation,
      'token_status', clean_status,
      'error_code', clean_error,
      'observed_at', p_observed_at
    )
  );
  return true;
end;
$$;

create or replace function public.claim_whatsapp_business_token_validation_jobs(
  p_limit integer default 5
)
returns setof public.whatsapp_business_token_validation_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.assert_whatsapp_coexistence_service_role();
  update public.whatsapp_business_token_validation_jobs job
  set status = case when job.attempts >= job.max_attempts
        then 'failed' else 'pending' end,
      available_at = case when job.attempts >= job.max_attempts
        then job.available_at else clock_timestamp() end,
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      last_error_code = coalesce(
        job.last_error_code,
        case when job.attempts >= job.max_attempts
          then 'TOKEN_VALIDATION_RETRIES_EXHAUSTED'
          else 'TOKEN_VALIDATION_LEASE_EXPIRED'
        end
      )
  where job.status = 'processing'
    and job.lease_expires_at <= clock_timestamp();

  update public.whatsapp_business_token_validation_jobs job
  set status = 'failed',
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      last_error_code = coalesce(
        job.last_error_code, 'TOKEN_VALIDATION_RETRIES_EXHAUSTED'
      )
  where job.status = 'pending'
    and job.attempts >= job.max_attempts;

  return query
  with candidates as (
    select job.id
    from public.whatsapp_business_token_validation_jobs job
    join public.whatsapp_coexistence_accounts account
      on account.id = job.account_id
     and account.business_token_generation = job.token_generation
     and account.business_token_secret_id is not null
     and account.business_token_status <> 'revoked'
     and account.onboarding_status <> 'offboarded'
    where job.status = 'pending'
      and job.available_at <= clock_timestamp()
      and job.attempts < job.max_attempts
    order by job.available_at, job.created_at, job.id
    for update of job skip locked
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  )
  update public.whatsapp_business_token_validation_jobs job
  set status = 'processing',
      attempts = job.attempts + 1,
      processing_started_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + interval '3 minutes',
      lease_token = gen_random_uuid(),
      last_error_code = null
  from candidates
  where job.id = candidates.id
  returning job.*;
end;
$$;

create or replace function public.complete_whatsapp_business_token_validation_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_token_is_valid boolean,
  p_token_app_id text,
  p_token_scopes text[],
  p_token_granular_scopes jsonb,
  p_token_target_ids text[],
  p_token_expires_at timestamptz,
  p_token_data_access_expires_at timestamptz,
  p_token_validated_at timestamptz,
  p_error_code text default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job public.whatsapp_business_token_validation_jobs%rowtype;
  account public.whatsapp_coexistence_accounts%rowtype;
  clean_error text := upper(trim(coalesce(p_error_code, '')));
  metadata_valid boolean;
  can_reactivate boolean := false;
  causal_pause_waiting boolean := false;
  now_value timestamptz := clock_timestamp();
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if p_token_is_valid is null
    or p_token_validated_at is null
    or p_token_validated_at < now_value - interval '10 minutes'
    or p_token_validated_at > now_value + interval '5 minutes'
  then
    raise exception 'WHATSAPP_TOKEN_VALIDATION_RESULT_INVALID'
      using errcode = '22023';
  end if;
  select * into job
  from public.whatsapp_business_token_validation_jobs candidate
  where candidate.id = p_job_id
    and candidate.status = 'processing'
    and candidate.lease_token = p_lease_token
    and candidate.lease_expires_at > now_value
  for update;
  if not found then return 'stale'; end if;
  select * into account
  from public.whatsapp_coexistence_accounts candidate
  where candidate.id = job.account_id
    and candidate.business_token_generation = job.token_generation
    and candidate.business_token_secret_id is not null
  for update;
  if not found then
    update public.whatsapp_business_token_validation_jobs
    set status = 'cancelled', processing_started_at = null,
        lease_expires_at = null, lease_token = null,
        last_error_code = 'TOKEN_GENERATION_STALE'
    where id = job.id;
    return 'stale';
  end if;

  metadata_valid := p_token_is_valid
    and trim(coalesce(p_token_app_id, '')) = account.business_token_app_id
    and public.is_valid_whatsapp_business_token_metadata(
      p_token_scopes, p_token_granular_scopes, p_token_target_ids
    )
    and 'whatsapp_business_management' = any(p_token_scopes)
    and 'whatsapp_business_messaging' = any(p_token_scopes)
    and account.waba_id = any(p_token_target_ids)
    and (
      p_token_expires_at is null
      or p_token_expires_at > now_value + interval '15 minutes'
    )
    and (
      p_token_data_access_expires_at is null
      or p_token_data_access_expires_at
        > now_value + interval '15 minutes'
    )
    and exists (
      select 1
      from jsonb_array_elements(p_token_granular_scopes) granular
      where granular ->> 'scope' = 'whatsapp_business_management'
        and granular -> 'target_ids' ? account.waba_id
    )
    and exists (
      select 1
      from jsonb_array_elements(p_token_granular_scopes) granular
      where granular ->> 'scope' = 'whatsapp_business_messaging'
        and granular -> 'target_ids' ? account.waba_id
    );
  if not metadata_valid and clean_error = '' then
    clean_error := case
      when p_token_expires_at is not null
        and p_token_expires_at <= now_value + interval '15 minutes'
        then 'TOKEN_EXPIRY_TOO_CLOSE'
      when p_token_data_access_expires_at is not null
        and p_token_data_access_expires_at
          <= now_value + interval '15 minutes'
        then 'TOKEN_DATA_ACCESS_EXPIRY_TOO_CLOSE'
      when p_token_is_valid then 'TOKEN_METADATA_MISMATCH'
      else 'TOKEN_INVALID'
    end;
  end if;
  if clean_error <> '' and clean_error !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'WHATSAPP_TOKEN_VALIDATION_ERROR_INVALID'
      using errcode = '22023';
  end if;

  -- A successful real validation may release only the causal pause recorded
  -- on this exact generation-fenced job. A later lifecycle/auth transition
  -- changes the account checkpoint (or cancels the job) and therefore wins.
  can_reactivate := metadata_valid
    and account.onboarding_status = 'completed'
    and account.app_subscription_status = 'subscribed'
    and account.coexistence_status = 'paused'
    and account.attention_required
    and job.pause_observed_at is not null
    and job.pause_error_code is not null
    and account.attention_required_at = job.pause_observed_at
    and account.attention_required_reason = job.pause_error_code
    and account.business_token_last_validation_error_code
      = job.pause_error_code
    and p_token_validated_at >= job.pause_observed_at
    and (
      job.validation_reason <> 'reconnect'
      or (
        account.last_account_update_event = 'ACCOUNT_RECONNECTED'
        and account.last_account_update_at = job.pause_observed_at
      )
    );
  causal_pause_waiting := metadata_valid
    and not can_reactivate
    and account.onboarding_status = 'completed'
    and account.app_subscription_status = 'subscribed'
    and account.coexistence_status = 'paused'
    and account.attention_required
    and job.pause_observed_at is not null
    and job.pause_error_code is not null
    and account.attention_required_at = job.pause_observed_at
    and account.attention_required_reason = job.pause_error_code
    and account.business_token_last_validation_error_code
      = job.pause_error_code
    and p_token_validated_at < job.pause_observed_at
    and (
      job.validation_reason <> 'reconnect'
      or (
        account.last_account_update_event = 'ACCOUNT_RECONNECTED'
        and account.last_account_update_at = job.pause_observed_at
      )
    );

  insert into public.whatsapp_business_token_validations (
    account_id, token_generation, validation_reason, is_valid,
    authorization_valid, app_id,
    scopes, granular_scopes, target_ids, expires_at,
    data_access_expires_at, expires_at_epoch,
    data_access_expires_at_epoch, validated_at, error_code
  ) values (
    account.id, account.business_token_generation, job.validation_reason,
    p_token_is_valid, metadata_valid,
    nullif(trim(coalesce(p_token_app_id, '')), ''),
    coalesce(p_token_scopes, '{}'::text[]),
    coalesce(p_token_granular_scopes, '[]'::jsonb),
    coalesce(p_token_target_ids, '{}'::text[]),
    p_token_expires_at, p_token_data_access_expires_at,
    case when p_token_expires_at is null then null
      else extract(epoch from p_token_expires_at)::bigint end,
    case when p_token_data_access_expires_at is null then null
      else extract(epoch from p_token_data_access_expires_at)::bigint end,
    p_token_validated_at,
    case when metadata_valid then null else clean_error end
  );

  if metadata_valid then
    update public.whatsapp_coexistence_accounts
    set business_token_status = 'active',
        business_token_is_valid = true,
        business_token_app_id = trim(p_token_app_id),
        business_token_scopes = p_token_scopes,
        business_token_granular_scopes = p_token_granular_scopes,
        business_token_target_ids = p_token_target_ids,
        business_token_expires_at = p_token_expires_at,
        business_token_data_access_expires_at =
          p_token_data_access_expires_at,
        business_token_last_validated_at = p_token_validated_at,
        business_token_validation_due_at =
          public.whatsapp_business_token_next_validation_at(
            p_token_validated_at,
            p_token_expires_at,
            p_token_data_access_expires_at
          ),
        business_token_validation_status = 'valid',
        business_token_last_validation_error_code = null,
        attention_required = case when can_reactivate
          then false else attention_required end,
        attention_required_at = case when can_reactivate
          then null else attention_required_at end,
        attention_required_reason = case when can_reactivate
          then null else attention_required_reason end,
        coexistence_status = case when can_reactivate
          then 'active' else coexistence_status end,
        onboarding_last_error_code = case
          when can_reactivate and (
            onboarding_last_error_code
              is not distinct from account.business_token_last_validation_error_code
            or onboarding_last_error_code in (
            'TOKEN_INVALID', 'TOKEN_EXPIRED', 'TOKEN_METADATA_MISMATCH',
            'TOKEN_VALIDATION_FAILED', 'TOKEN_VALIDATION_UNAVAILABLE',
            'REAUTHENTICATION_REQUIRED'
            )
          ) then null else onboarding_last_error_code end
    where id = account.id;
    update public.whatsapp_business_token_validation_jobs
    set validation_reason = case when causal_pause_waiting
          then job.validation_reason else 'periodic' end,
        status = 'pending', attempts = 0,
        available_at = case when causal_pause_waiting
          then clock_timestamp()
          else public.whatsapp_business_token_next_validation_at(
            p_token_validated_at,
            p_token_expires_at,
            p_token_data_access_expires_at
          )
        end,
        processing_started_at = null, lease_expires_at = null,
        lease_token = null, last_error_code = null,
        pause_observed_at = case when causal_pause_waiting
          then job.pause_observed_at else null end,
        pause_error_code = case when causal_pause_waiting
          then job.pause_error_code else null end
    where id = job.id;
    return 'rescheduled';
  end if;

  update public.whatsapp_coexistence_accounts
  set business_token_status = case
        when (
          p_token_expires_at is not null
          and p_token_expires_at <= now_value
        ) or (
          p_token_data_access_expires_at is not null
          and p_token_data_access_expires_at <= now_value
        ) then 'expired'
        else 'invalid'
      end,
      business_token_is_valid = false,
      business_token_validation_status = case
        when (
          p_token_expires_at is not null
          and p_token_expires_at <= now_value
        ) or (
          p_token_data_access_expires_at is not null
          and p_token_data_access_expires_at <= now_value
        ) then 'expired'
        else 'invalid'
      end,
      business_token_last_validated_at = p_token_validated_at,
      business_token_validation_due_at = p_token_validated_at,
      business_token_last_validation_error_code = clean_error,
      attention_required = true,
      attention_required_at = p_token_validated_at,
      attention_required_reason = clean_error,
      coexistence_status = case when coexistence_status = 'disconnected'
        then 'disconnected' else 'paused' end,
      onboarding_status = case when onboarding_status = 'provisioning'
        then 'failed' else onboarding_status end,
      onboarding_last_error_code = clean_error
  where id = account.id;
  update public.whatsapp_business_token_validation_jobs
  set status = 'failed', processing_started_at = null,
      lease_expires_at = null, lease_token = null,
      last_error_code = clean_error
  where id = job.id;
  perform public.block_whatsapp_account_graph_work(account.id, clean_error);
  insert into public.audit_logs (
    action, entity_type, entity_id, metadata
  ) values (
    'whatsapp.business_token.validation_failed',
    'whatsapp_coexistence_account', account.id,
    jsonb_build_object(
      'token_generation', account.business_token_generation,
      'error_code', clean_error
    )
  );
  return 'invalid';
end;
$$;

create or replace function public.fail_whatsapp_business_token_validation_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_retryable boolean default true
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job public.whatsapp_business_token_validation_jobs%rowtype;
  account public.whatsapp_coexistence_accounts%rowtype;
  clean_error text := upper(trim(coalesce(p_error_code, '')));
  retry_at timestamptz;
  observed_at timestamptz := clock_timestamp();
  outcome text;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if clean_error !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'WHATSAPP_TOKEN_VALIDATION_ERROR_INVALID'
      using errcode = '22023';
  end if;
  select * into job
  from public.whatsapp_business_token_validation_jobs candidate
  where candidate.id = p_job_id
    and candidate.status = 'processing'
    and candidate.lease_token = p_lease_token
  for update;
  if not found then return 'stale'; end if;
  select * into account
  from public.whatsapp_coexistence_accounts candidate
  where candidate.id = job.account_id
    and candidate.business_token_generation = job.token_generation
    and candidate.business_token_secret_id is not null
  for update;
  if not found then
    update public.whatsapp_business_token_validation_jobs
    set status = 'cancelled', processing_started_at = null,
        lease_expires_at = null, lease_token = null,
        last_error_code = 'TOKEN_GENERATION_STALE'
    where id = job.id;
    return 'stale';
  end if;
  retry_at := observed_at
    + least(
      interval '6 hours',
      power(2::numeric, least(job.attempts, 10)) * interval '30 seconds'
    );
  outcome := case
    when coalesce(p_retryable, false) and job.attempts < job.max_attempts
      then 'retrying'
    else 'failed'
  end;
  update public.whatsapp_business_token_validation_jobs
  set status = case when outcome = 'retrying' then 'pending' else 'failed' end,
      available_at = case when outcome = 'retrying'
        then retry_at else available_at end,
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      last_error_code = clean_error,
      pause_observed_at = observed_at,
      pause_error_code = clean_error
  where id = job.id;
  update public.whatsapp_coexistence_accounts
  set business_token_status = 'unknown',
      business_token_is_valid = null,
      business_token_validation_status = 'unknown',
      business_token_validation_due_at = observed_at,
      business_token_last_validation_error_code = clean_error,
      attention_required = true,
      attention_required_at = observed_at,
      attention_required_reason = clean_error,
      coexistence_status = case when coexistence_status = 'disconnected'
        then 'disconnected' else 'paused' end,
      onboarding_status = case when onboarding_status = 'provisioning'
        then 'failed' else onboarding_status end,
      onboarding_last_error_code = clean_error
  where id = account.id;
  perform public.block_whatsapp_account_graph_work(account.id, clean_error);
  insert into public.audit_logs (
    action, entity_type, entity_id, metadata
  ) values (
    'whatsapp.business_token.validation_error',
    'whatsapp_coexistence_account', account.id,
    jsonb_build_object(
      'token_generation', account.business_token_generation,
      'error_code', clean_error,
      'outcome', outcome
    )
  );
  return outcome;
end;
$$;

create or replace function public.close_whatsapp_coexistence_onboarding_syncs(
  p_account_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  account public.whatsapp_coexistence_accounts%rowtype;
  current_sync_type text;
  current_generation_id uuid;
  current_sync_state text;
  clean_reason text := upper(trim(coalesce(p_reason, '')));
  changed boolean := false;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if clean_reason !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'WHATSAPP_COEXISTENCE_SYNC_CLOSE_REASON_INVALID'
      using errcode = '22023';
  end if;
  select * into account
  from public.whatsapp_coexistence_accounts candidate
  where candidate.id = p_account_id
  for update;
  if not found then
    raise exception 'WHATSAPP_COEXISTENCE_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  for current_sync_type, current_generation_id, current_sync_state in
    values
      ('history'::text, account.history_sync_generation_id,
        account.history_sync_status),
      ('smb_app_state_sync'::text, account.app_state_sync_generation_id,
        account.app_state_sync_status)
  loop
    if current_sync_state not in ('pending', 'in_progress')
      and not exists (
        select 1 from public.whatsapp_coexistence_events event
        where event.account_id = account.id
          and event.field = current_sync_type
          and event.sync_generation_id = current_generation_id
          and event.status in ('pending', 'processing')
      )
    then
      continue;
    end if;
    changed := true;
    update public.whatsapp_coexistence_events event
    set status = 'failed',
        processing_started_at = null,
        lease_expires_at = null,
        lease_token = null,
        failed_at = coalesce(event.failed_at, clock_timestamp()),
        last_error = clean_reason
    where event.account_id = account.id
      and event.field = current_sync_type
      and event.sync_generation_id = current_generation_id
      and event.status in ('pending', 'processing');
    update public.whatsapp_coexistence_sync_batches batch
    set status = 'failed',
        completed_at = coalesce(batch.completed_at, clock_timestamp()),
        last_error = clean_reason
    where batch.account_id = account.id
      and batch.sync_type = current_sync_type
      and batch.sync_generation_id = current_generation_id
      and batch.status in ('pending', 'processing');
    insert into public.whatsapp_coexistence_sync_generation_failures (
      account_id, sync_type, sync_generation_id, request_id,
      failure_kind, error, metadata, failed_at
    ) values (
      account.id,
      current_sync_type,
      current_generation_id,
      case current_sync_type when 'history' then account.history_request_id
        else account.app_state_sync_request_id end,
      'cancelled',
      clean_reason,
      jsonb_build_object('source', 'embedded_signup_offboarding'),
      clock_timestamp()
    ) on conflict (account_id, sync_type, sync_generation_id) do nothing;
  end loop;

  if changed then
    perform public.refresh_whatsapp_coexistence_sync_state(account.id);
  end if;
  return changed;
end;
$$;

-- Replace the legacy enqueue implementation with generation/token binding for
-- Embedded Signup accounts. Legacy env-scoped accounts retain their previous
-- behaviour until they are explicitly migrated.
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
          -- A consumed chunk makes the aggregate stream partial, and a final
          -- batch can be followed by media enrichment for the same wamid.
          -- Authorization is generation/job based; aggregate progress must
          -- not close an otherwise current stream.
          or account.history_sync_status not in (
            'pending', 'in_progress', 'partial', 'completed'
          )
        )
      ) or (
        p_field = 'smb_app_state_sync'
        and (
          account.app_state_sync_token_generation
            is distinct from account.business_token_generation
          -- Meta has no global completion marker for app-state sync, so every
          -- completed delivery intentionally leaves this aggregate partial.
          or account.app_state_sync_status not in (
            'pending', 'in_progress', 'partial', 'completed'
          )
        )
      ) or not exists (
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

-- Keep the account state derived from the durable job ledger. This helper is
-- intentionally internal: every caller already runs as the service role and
-- no browser is allowed to force an account into the connected state.
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
      -- The onboarding workflow never enables production sends.
      sending_paused = true,
      sending_pause_reason = 'COEXISTENCE_ONBOARDING',
      updated_at = clock_timestamp()
  where id = true;
  return true;
end;
$$;

create or replace function public.expire_whatsapp_onboarding_jobs()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job public.whatsapp_onboarding_outbox%rowtype;
  expired_count integer := 0;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  for job in
    select queued.*
    from public.whatsapp_onboarding_outbox queued
    where (
        queued.status in ('pending', 'ambiguous')
        or (
          queued.status = 'processing'
          and queued.lease_expires_at <= clock_timestamp()
        )
      )
      and queued.deadline_at is not null
      and queued.deadline_at <= clock_timestamp()
    order by queued.deadline_at, queued.created_at
    for update skip locked
  loop
    if job.operation in ('request_contacts_sync', 'request_history_sync')
      and exists (
        select 1
        from public.whatsapp_coexistence_events event
        where event.account_id = job.account_id
          and event.sync_generation_id = job.sync_generation_id
      )
    then
      update public.whatsapp_onboarding_outbox
      set status = 'succeeded',
          processing_started_at = null,
          lease_expires_at = null,
          lease_token = null,
          completion_reason = 'webhook_observed',
          completed_at = clock_timestamp(),
          failed_at = null,
          last_error_code = null
      where id = job.id;
      perform public.recompute_whatsapp_embedded_signup_onboarding(
        job.account_id,
        job.token_generation
      );
    else
      if job.operation in ('request_contacts_sync', 'request_history_sync') then
        begin
          perform public.fail_whatsapp_coexistence_sync_generation(
            job.account_id,
            case job.operation
              when 'request_contacts_sync' then 'smb_app_state_sync'
              else 'history'
            end,
            job.sync_generation_id,
            'SYNC_WINDOW_EXPIRED',
            'cancelled',
            jsonb_build_object('onboarding_job_id', job.id),
            clock_timestamp()
          );
        exception when sqlstate '55000' then
          -- Close the request-before-delivery race in favour of the webhook.
          if exists (
            select 1
            from public.whatsapp_coexistence_events event
            where event.account_id = job.account_id
              and event.sync_generation_id = job.sync_generation_id
          ) then
            update public.whatsapp_onboarding_outbox
            set status = 'succeeded',
                processing_started_at = null,
                lease_expires_at = null,
                lease_token = null,
                completion_reason = 'webhook_observed',
                completed_at = clock_timestamp(),
                failed_at = null,
                last_error_code = null
            where id = job.id;
            perform public.recompute_whatsapp_embedded_signup_onboarding(
              job.account_id,
              job.token_generation
            );
            expired_count := expired_count + 1;
            continue;
          end if;
          raise;
        end;
      end if;
      update public.whatsapp_onboarding_outbox
      set status = 'failed',
          processing_started_at = null,
          lease_expires_at = null,
          lease_token = null,
          failed_at = clock_timestamp(),
          last_error_code = 'SYNC_WINDOW_EXPIRED'
      where id = job.id;
      update public.whatsapp_coexistence_accounts
      set onboarding_status = 'failed',
          onboarding_last_error_code = 'SYNC_WINDOW_EXPIRED'
      where id = job.account_id
        and onboarding_status not in ('offboarding', 'offboarded');
    end if;
    expired_count := expired_count + 1;
  end loop;
  return expired_count;
end;
$$;

create or replace function public.claim_whatsapp_onboarding_jobs(
  p_limit integer default 1
)
returns setof public.whatsapp_onboarding_outbox
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  exhausted public.whatsapp_onboarding_outbox%rowtype;
  sync_type text;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  -- The existing once-per-minute recovery processor is also the cleanup path
  -- for abandoned browser sessions and their temporary Vault credentials.
  perform public.expire_whatsapp_embedded_signup_attempts();
  perform public.expire_whatsapp_onboarding_jobs();

  -- A webhook is authoritative even when the initiating HTTP response was
  -- lost. Reconcile every non-terminal local outcome before considering any
  -- retry. This also heals a stale lease without reissuing the Graph request.
  update public.whatsapp_onboarding_outbox job
  set status = 'succeeded',
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      completion_reason = 'webhook_observed',
      completed_at = clock_timestamp(),
      failed_at = null,
      last_error_code = null
  where job.operation in ('request_contacts_sync', 'request_history_sync')
    and (
      job.status in ('ambiguous', 'failed')
      or (
        job.status = 'processing'
        and job.lease_expires_at <= clock_timestamp()
      )
    )
    and exists (
      select 1
      from public.whatsapp_coexistence_events event
      where event.account_id = job.account_id
        and event.sync_generation_id = job.sync_generation_id
    );

  perform public.recompute_whatsapp_embedded_signup_onboarding(
    account.id,
    account.business_token_generation
  )
  from public.whatsapp_coexistence_accounts account
  where account.business_token_status = 'active'
    and account.onboarding_status in ('provisioning', 'failed', 'completed')
    and exists (
      select 1
      from public.whatsapp_onboarding_outbox job
      where job.account_id = account.id
        and job.token_generation = account.business_token_generation
    );

  -- A stale sync-request lease has an unknown remote outcome. It must never
  -- return to pending, because doing so could issue a duplicate sync request.
  update public.whatsapp_onboarding_outbox job
  set status = 'ambiguous',
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      last_error_code = coalesce(last_error_code, 'STALE_LEASE_OUTCOME_UNKNOWN')
  where job.status = 'processing'
    and job.operation in ('request_contacts_sync', 'request_history_sync')
    and job.lease_expires_at <= clock_timestamp();

  -- Subscription operations are safe to revisit only because the processor
  -- performs a read/reconciliation with Meta before deciding to mutate.
  update public.whatsapp_onboarding_outbox job
  set status = 'pending',
      available_at = clock_timestamp(),
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      last_error_code = coalesce(last_error_code, 'STALE_LEASE_RECOVERED')
  where job.status = 'processing'
    and job.operation in ('subscribe_app', 'unsubscribe_app')
    and job.lease_expires_at <= clock_timestamp();

  -- Exhaustion is a product-state failure, not merely a queue-state failure.
  -- Close the matching generation and fail the account before moving on.
  for exhausted in
    select candidate.*
    from public.whatsapp_onboarding_outbox candidate
    where candidate.status = 'pending'
      and candidate.attempts >= candidate.max_attempts
    order by candidate.created_at
    for update skip locked
  loop
    if exhausted.operation in (
      'request_contacts_sync', 'request_history_sync'
    ) then
      if exists (
        select 1
        from public.whatsapp_coexistence_events event
        where event.account_id = exhausted.account_id
          and event.sync_generation_id = exhausted.sync_generation_id
      ) then
        update public.whatsapp_onboarding_outbox
        set status = 'succeeded',
            completion_reason = 'webhook_observed',
            completed_at = clock_timestamp(),
            failed_at = null,
            last_error_code = null
        where id = exhausted.id;
        perform public.recompute_whatsapp_embedded_signup_onboarding(
          exhausted.account_id,
          exhausted.token_generation
        );
        continue;
      end if;
      sync_type := case exhausted.operation
        when 'request_contacts_sync' then 'smb_app_state_sync'
        else 'history'
      end;
      begin
        perform public.fail_whatsapp_coexistence_sync_generation(
          exhausted.account_id,
          sync_type,
          exhausted.sync_generation_id,
          'MAX_ATTEMPTS_EXCEEDED',
          'request_failed',
          jsonb_build_object('onboarding_job_id', exhausted.id),
          clock_timestamp()
        );
      exception when sqlstate '55000' then
        if exists (
          select 1
          from public.whatsapp_coexistence_events event
          where event.account_id = exhausted.account_id
            and event.sync_generation_id = exhausted.sync_generation_id
        ) then
          update public.whatsapp_onboarding_outbox
          set status = 'succeeded',
              completion_reason = 'webhook_observed',
              completed_at = clock_timestamp(),
              failed_at = null,
              last_error_code = null
          where id = exhausted.id;
          perform public.recompute_whatsapp_embedded_signup_onboarding(
            exhausted.account_id,
            exhausted.token_generation
          );
          continue;
        end if;
        raise;
      end;
    end if;

    update public.whatsapp_onboarding_outbox
    set status = 'failed',
        processing_started_at = null,
        lease_expires_at = null,
        lease_token = null,
        failed_at = clock_timestamp(),
        last_error_code = 'MAX_ATTEMPTS_EXCEEDED'
    where id = exhausted.id;
    update public.whatsapp_coexistence_accounts
    set onboarding_status = case
          when exhausted.operation = 'unsubscribe_app'
            then 'offboarding'
          else 'failed'
        end,
        app_subscription_status = case
          when exhausted.operation = 'subscribe_app' then 'failed'
          when exhausted.operation = 'unsubscribe_app' then 'unsubscribing'
          else app_subscription_status
        end,
        coexistence_status = case
          when exhausted.operation = 'unsubscribe_app' then 'paused'
          else coexistence_status
        end,
        attention_required = case
          when exhausted.operation = 'unsubscribe_app' then true
          else attention_required
        end,
        attention_required_at = case
          when exhausted.operation = 'unsubscribe_app' then clock_timestamp()
          else attention_required_at
        end,
        attention_required_reason = case
          when exhausted.operation = 'unsubscribe_app'
            then 'MAX_ATTEMPTS_EXCEEDED'
          else attention_required_reason
        end,
        onboarding_last_error_code = 'MAX_ATTEMPTS_EXCEEDED'
    where id = exhausted.account_id
      and onboarding_status not in ('offboarded');
  end loop;

  return query
  with ranked as (
    select
      job.id,
      row_number() over (
        partition by job.account_id
        order by
          case job.operation
            when 'unsubscribe_app' then 0
            when 'subscribe_app' then 1
            when 'request_contacts_sync' then 2
            else 3
          end,
          job.available_at,
          job.created_at
      ) as account_order
    from public.whatsapp_onboarding_outbox job
    join public.whatsapp_coexistence_accounts account
      on account.id = job.account_id
     and account.business_token_generation = job.token_generation
     and (
       (
         job.operation = 'unsubscribe_app'
         and account.onboarding_status = 'offboarding'
         and account.coexistence_status in ('paused', 'disconnected')
         and account.business_token_secret_id is not null
         and account.business_token_status in (
           'active', 'unknown', 'invalid', 'expired'
         )
       )
       or (
         job.operation <> 'unsubscribe_app'
         and account.business_token_status = 'active'
         and (
           account.business_token_expires_at is null
           or account.business_token_expires_at > clock_timestamp()
         )
       )
     )
    where job.status = 'pending'
      and job.available_at <= clock_timestamp()
      and job.attempts < job.max_attempts
      and (
        job.operation in ('subscribe_app', 'unsubscribe_app')
        or exists (
          select 1
          from public.whatsapp_onboarding_outbox dependency
          where dependency.account_id = job.account_id
            and dependency.token_generation = job.token_generation
            and dependency.operation = 'subscribe_app'
            and dependency.status = 'succeeded'
        )
      )
      and not exists (
        select 1
        from public.whatsapp_onboarding_outbox active
        where active.account_id = job.account_id
          and active.status = 'processing'
      )
  ), candidates as (
    select job.id
    from public.whatsapp_onboarding_outbox job
    join ranked on ranked.id = job.id and ranked.account_order = 1
    order by
      case job.operation when 'unsubscribe_app' then 0 else 1 end,
      job.available_at,
      job.created_at
    for update of job skip locked
    limit greatest(1, least(coalesce(p_limit, 1), 5))
  )
  update public.whatsapp_onboarding_outbox job
  set status = 'processing',
      attempts = job.attempts + 1,
      first_attempted_at = coalesce(job.first_attempted_at, clock_timestamp()),
      processing_started_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + interval '2 minutes',
      lease_token = gen_random_uuid(),
      completed_at = null,
      failed_at = null
  from candidates
  where job.id = candidates.id
  returning job.*;
end;
$$;

create or replace function public.complete_whatsapp_onboarding_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_remote_request_id text default null,
  p_completion_reason text default 'remote_confirmed'
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  job public.whatsapp_onboarding_outbox%rowtype;
  account public.whatsapp_coexistence_accounts%rowtype;
  clean_request_id text := nullif(trim(coalesce(p_remote_request_id, '')), '');
  clean_reason text := trim(coalesce(p_completion_reason, ''));
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if clean_reason not in (
      'remote_confirmed', 'already_applied', 'webhook_observed',
      'remote_already_absent'
    )
    or (clean_request_id is not null and char_length(clean_request_id) > 240)
  then
    raise exception 'WHATSAPP_ONBOARDING_JOB_COMPLETION_INVALID'
      using errcode = '22023';
  end if;

  select * into job
  from public.whatsapp_onboarding_outbox candidate
  where candidate.id = p_job_id
    and candidate.status = 'processing'
    and candidate.lease_token = p_lease_token
    and candidate.lease_expires_at > clock_timestamp()
  for update;
  if not found then return false; end if;

  select * into account
  from public.whatsapp_coexistence_accounts candidate
  where candidate.id = job.account_id
    and candidate.business_token_generation = job.token_generation
  for update;
  if not found then
    raise exception 'WHATSAPP_ONBOARDING_JOB_GENERATION_STALE'
      using errcode = '55000';
  end if;

  if job.operation = 'subscribe_app' then
    update public.whatsapp_coexistence_accounts
    set app_subscription_status = 'subscribed',
        app_subscribed_at = coalesce(app_subscribed_at, clock_timestamp()),
        onboarding_last_error_code = null
    where id = account.id;
  elsif job.operation = 'request_contacts_sync' then
    if clean_request_id is null then
      raise exception 'WHATSAPP_ONBOARDING_REQUEST_ID_REQUIRED'
        using errcode = '22023';
    end if;
    perform public.record_whatsapp_coexistence_sync_request(
      account.id,
      'smb_app_state_sync',
      job.sync_generation_id,
      clean_request_id,
      clock_timestamp()
    );
  elsif job.operation = 'request_history_sync' then
    if account.history_sharing_decision <> 'accepted'
      or clean_request_id is null then
      raise exception 'WHATSAPP_ONBOARDING_HISTORY_NOT_AUTHORIZED'
        using errcode = '42501';
    end if;
    perform public.record_whatsapp_coexistence_sync_request(
      account.id,
      'history',
      job.sync_generation_id,
      clean_request_id,
      clock_timestamp()
    );
  elsif job.operation = 'unsubscribe_app' then
    if account.business_token_secret_id is not null then
      delete from vault.secrets secret
      where secret.id = account.business_token_secret_id
        and secret.name = 'whatsapp_business_access_token_' || account.id::text;
      if not found then
        raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_UNAVAILABLE'
          using errcode = '55000';
      end if;
    end if;
    update public.whatsapp_coexistence_accounts
    set business_token_secret_id = null,
        business_token_status = 'revoked',
        business_token_is_valid = false,
        business_token_expires_at = null,
        business_token_data_access_expires_at = null,
        business_token_validation_due_at = null,
        business_token_validation_status = 'invalid',
        business_token_last_validation_error_code = 'ACCOUNT_OFFBOARDED',
        attention_required = false,
        attention_required_at = null,
        attention_required_reason = null,
        onboarding_status = 'offboarded',
        app_subscription_status = 'unsubscribed',
        app_subscribed_at = null,
        coexistence_status = 'disconnected',
        offboarded_at = clock_timestamp(),
        onboarding_last_error_code = null
    where id = account.id;
    update public.whatsapp_business_token_validation_jobs
    set status = 'cancelled', processing_started_at = null,
        lease_expires_at = null, lease_token = null,
        last_error_code = 'ACCOUNT_OFFBOARDED'
    where account_id = account.id;
  end if;

  update public.whatsapp_onboarding_outbox
  set status = 'succeeded',
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      remote_request_id = coalesce(clean_request_id, remote_request_id),
      completion_reason = clean_reason,
      completed_at = clock_timestamp(),
      failed_at = null,
      last_error_code = null
  where id = job.id;

  if job.operation <> 'unsubscribe_app' then
    perform public.recompute_whatsapp_embedded_signup_onboarding(
      account.id,
      job.token_generation
    );
  end if;

  insert into public.audit_logs (
    action, entity_type, entity_id, metadata
  ) values (
    'whatsapp.onboarding_job.completed',
    'whatsapp_coexistence_account',
    account.id,
    jsonb_build_object(
      'operation', job.operation,
      'token_generation', job.token_generation,
      'completion_reason', clean_reason
    )
  );
  return true;
end;
$$;

create or replace function public.fail_whatsapp_onboarding_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_outcome text,
  p_retryable boolean default false
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job public.whatsapp_onboarding_outbox%rowtype;
  clean_error text := upper(trim(coalesce(p_error_code, '')));
  clean_outcome text := lower(trim(coalesce(p_outcome, '')));
  retry_seconds integer;
  retry_at timestamptz;
  next_status text;
  sync_type text;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if clean_error !~ '^[A-Z0-9_]{3,100}$'
    or clean_outcome not in ('definitive', 'ambiguous') then
    raise exception 'WHATSAPP_ONBOARDING_JOB_FAILURE_INVALID'
      using errcode = '22023';
  end if;

  select * into job
  from public.whatsapp_onboarding_outbox candidate
  where candidate.id = p_job_id
    and candidate.status = 'processing'
    and candidate.lease_token = p_lease_token
    and candidate.lease_expires_at > clock_timestamp()
  for update;
  if not found then return 'stale'; end if;

  if clean_outcome = 'ambiguous' then
    -- A timeout or connection reset may have reached Meta. Never resend it
    -- blindly: webhooks or an explicit operator review must resolve it.
    next_status := 'ambiguous';
  else
    retry_seconds := least(
      3600,
      (5 * power(2, least(job.attempts, 9)))::integer
    );
    retry_at := clock_timestamp() + make_interval(secs => retry_seconds);
    next_status := case
      when coalesce(p_retryable, false)
        and job.attempts < job.max_attempts
        and (
          job.deadline_at is null
          or retry_at < job.deadline_at - interval '2 minutes'
        )
      then 'pending'
      else 'failed'
    end;
  end if;

  if job.operation in ('request_contacts_sync', 'request_history_sync')
    and exists (
      select 1
      from public.whatsapp_coexistence_events event
      where event.account_id = job.account_id
        and event.sync_generation_id = job.sync_generation_id
    )
  then
    update public.whatsapp_onboarding_outbox
    set status = 'succeeded',
        processing_started_at = null,
        lease_expires_at = null,
        lease_token = null,
        completion_reason = 'webhook_observed',
        completed_at = clock_timestamp(),
        failed_at = null,
        last_error_code = null
    where id = job.id;
    perform public.recompute_whatsapp_embedded_signup_onboarding(
      job.account_id,
      job.token_generation
    );
    return 'succeeded';
  end if;

  if next_status = 'failed'
    and job.operation in ('request_contacts_sync', 'request_history_sync')
  then
    sync_type := case job.operation
      when 'request_contacts_sync' then 'smb_app_state_sync'
      else 'history'
    end;
    begin
      perform public.fail_whatsapp_coexistence_sync_generation(
        job.account_id,
        sync_type,
        job.sync_generation_id,
        clean_error,
        'request_failed',
        jsonb_build_object('onboarding_job_id', job.id),
        clock_timestamp()
      );
    exception when sqlstate '55000' then
      if exists (
        select 1
        from public.whatsapp_coexistence_events event
        where event.account_id = job.account_id
          and event.sync_generation_id = job.sync_generation_id
      ) then
        update public.whatsapp_onboarding_outbox
        set status = 'succeeded',
            processing_started_at = null,
            lease_expires_at = null,
            lease_token = null,
            completion_reason = 'webhook_observed',
            completed_at = clock_timestamp(),
            failed_at = null,
            last_error_code = null
        where id = job.id;
        perform public.recompute_whatsapp_embedded_signup_onboarding(
          job.account_id,
          job.token_generation
        );
        return 'succeeded';
      end if;
      raise;
    end;
  end if;

  update public.whatsapp_onboarding_outbox
  set status = next_status,
      available_at = case when next_status = 'pending'
        then retry_at else available_at end,
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      failed_at = case when next_status = 'failed'
        then clock_timestamp() else null end,
      last_error_code = clean_error
  where id = job.id;

  if next_status in ('failed', 'ambiguous') then
    update public.whatsapp_coexistence_accounts
    set onboarding_status = case
          when job.operation = 'unsubscribe_app' then 'offboarding'
          when next_status = 'failed' then 'failed'
          else onboarding_status
        end,
        app_subscription_status = case
          when job.operation = 'subscribe_app' and next_status = 'failed'
            then 'failed'
          when job.operation = 'unsubscribe_app' then 'unsubscribing'
          else app_subscription_status
        end,
        coexistence_status = case
          when job.operation = 'unsubscribe_app' then 'paused'
          else coexistence_status
        end,
        attention_required = case
          when job.operation = 'unsubscribe_app' then true
          else attention_required
        end,
        attention_required_at = case
          when job.operation = 'unsubscribe_app' then clock_timestamp()
          else attention_required_at
        end,
        attention_required_reason = case
          when job.operation = 'unsubscribe_app' then clean_error
          else attention_required_reason
        end,
        onboarding_last_error_code = clean_error
    where id = job.account_id;
  end if;

  insert into public.audit_logs (
    action, entity_type, entity_id, metadata
  ) values (
    'whatsapp.onboarding_job.failed',
    'whatsapp_coexistence_account',
    job.account_id,
    jsonb_build_object(
      'operation', job.operation,
      'outcome', clean_outcome,
      'result_status', next_status,
      'error_code', clean_error
    )
  );
  return next_status;
end;
$$;

create or replace function public.begin_whatsapp_coexistence_offboarding(
  p_account_id uuid,
  p_admin_user_id uuid,
  p_client_scope text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  account public.whatsapp_coexistence_accounts%rowtype;
  clean_scope text := lower(trim(coalesce(p_client_scope, '')));
begin
  perform public.assert_whatsapp_embedded_signup_admin(p_admin_user_id);
  if clean_scope !~ '^[a-z0-9][a-z0-9._:-]{2,99}$' then
    raise exception 'WHATSAPP_COEXISTENCE_CLIENT_SCOPE_INVALID'
      using errcode = '22023';
  end if;
  select * into account
  from public.whatsapp_coexistence_accounts candidate
  where candidate.id = p_account_id
    and candidate.client_scope = clean_scope
  for update;
  if not found then
    raise exception 'WHATSAPP_COEXISTENCE_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;
  if account.onboarding_status = 'offboarded'
    and account.business_token_status = 'revoked' then
    return false;
  end if;
  if account.onboarding_status = 'offboarding'
    and exists (
      select 1
      from public.whatsapp_onboarding_outbox job
      where job.account_id = account.id
        and job.token_generation = account.business_token_generation
        and job.operation = 'unsubscribe_app'
        and job.status in (
          'pending', 'processing', 'succeeded'
        )
    )
  then
    return false;
  end if;
  -- Offboarding is the recovery path for a retained credential whose health
  -- is uncertain or failed. Refusing it would strand completed accounts after
  -- a 401/debug_token failure. Missing/revoked credentials remain excluded.
  if account.business_token_status not in (
      'active', 'unknown', 'invalid', 'expired'
    )
    or account.business_token_secret_id is null then
    raise exception 'WHATSAPP_BUSINESS_CREDENTIAL_UNAVAILABLE'
      using errcode = '55000';
  end if;
  if exists (
    select 1
    from public.whatsapp_coexistence_accounts sibling
    where sibling.id <> account.id
      and sibling.waba_id = account.waba_id
      and sibling.business_token_status = 'active'
      and sibling.business_token_secret_id is not null
      and sibling.onboarding_status in (
        'provisioning', 'completed', 'offboarding'
      )
  ) then
    raise exception 'WHATSAPP_COEXISTENCE_WABA_SHARED_SUBSCRIPTION'
      using errcode = '55000';
  end if;

  perform public.close_whatsapp_coexistence_onboarding_syncs(
    account.id,
    'OFFBOARDING_REQUESTED'
  );

  -- Invalidate every unstarted/in-flight provisioning lease. Imported
  -- contacts/messages/events remain untouched.
  update public.whatsapp_onboarding_outbox
  set status = 'cancelled',
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      last_error_code = 'OFFBOARDING_REQUESTED'
  where account_id = account.id
    and token_generation = account.business_token_generation
    and operation <> 'unsubscribe_app'
    and status in ('pending', 'processing', 'ambiguous', 'failed');

  update public.whatsapp_coexistence_accounts
  set onboarding_status = 'offboarding',
      app_subscription_status = 'unsubscribing',
      coexistence_status = 'paused',
      offboarding_requested_at = clock_timestamp(),
      onboarding_last_error_code = null
  where id = account.id;

  insert into public.whatsapp_onboarding_outbox (
    account_id,
    onboarding_attempt_id,
    requested_by,
    token_generation,
    operation,
    idempotency_key,
    deadline_at,
    sync_generation_id
  ) values (
    account.id,
    account.last_onboarding_attempt_id,
    p_admin_user_id,
    account.business_token_generation,
    'unsubscribe_app',
    'embedded:' || account.id::text || ':'
      || account.business_token_generation::text || ':unsubscribe',
    null,
    null
  ) on conflict (account_id, token_generation, operation) do update
  set status = 'pending',
      requested_by = excluded.requested_by,
      attempts = 0,
      first_attempted_at = null,
      available_at = clock_timestamp(),
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      last_error_code = null
  where whatsapp_onboarding_outbox.status in (
    'ambiguous', 'failed', 'cancelled'
  );

  update public.whatsapp_settings
  set sending_paused = true,
      sending_pause_reason = 'COEXISTENCE_OFFBOARDING',
      integration_status = 'incomplete',
      updated_at = clock_timestamp()
  where id = true;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    p_admin_user_id,
    'whatsapp.coexistence.offboarding_requested',
    'whatsapp_coexistence_account',
    account.id,
    jsonb_build_object('token_generation', account.business_token_generation)
  );
  return true;
end;
$$;

create or replace function public.finalize_whatsapp_coexistence_local_offboarding(
  p_job_id uuid,
  p_lease_token uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  job public.whatsapp_onboarding_outbox%rowtype;
  account public.whatsapp_coexistence_accounts%rowtype;
  clean_reason text := upper(trim(coalesce(p_reason, '')));
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if clean_reason not in (
    'CREDENTIAL_INVALID', 'TOKEN_EXPIRED', 'REMOTE_ALREADY_ABSENT'
  ) then
    raise exception 'WHATSAPP_LOCAL_OFFBOARDING_REASON_INVALID'
      using errcode = '22023';
  end if;
  select * into job
  from public.whatsapp_onboarding_outbox candidate
  where candidate.id = p_job_id
    and candidate.operation = 'unsubscribe_app'
    and candidate.status = 'processing'
    and candidate.lease_token = p_lease_token
    and candidate.lease_expires_at > clock_timestamp()
    and candidate.requested_by is not null
  for update;
  if not found then return false; end if;

  select * into account
  from public.whatsapp_coexistence_accounts candidate
  where candidate.id = job.account_id
    and candidate.business_token_generation = job.token_generation
    and candidate.onboarding_status = 'offboarding'
  for update;
  if not found then return false; end if;

  if account.business_token_secret_id is not null then
    delete from vault.secrets secret
    where secret.id = account.business_token_secret_id
      and secret.name = 'whatsapp_business_access_token_' || account.id::text;
  end if;
  update public.whatsapp_coexistence_accounts
  set business_token_secret_id = null,
      business_token_status = case when business_token_generation > 0
        then 'revoked' else 'missing' end,
      business_token_is_valid = case when business_token_generation > 0
        then false else null end,
      business_token_expires_at = null,
      business_token_data_access_expires_at = null,
      business_token_validation_due_at = null,
      business_token_validation_status = case
        when business_token_generation > 0 then 'invalid' else 'missing' end,
      business_token_last_validation_error_code = case
        when business_token_generation > 0 then clean_reason else null end,
      attention_required = false,
      attention_required_at = null,
      attention_required_reason = null,
      onboarding_status = 'offboarded',
      app_subscription_status = 'unknown',
      app_subscribed_at = null,
      coexistence_status = 'disconnected',
      offboarded_at = clock_timestamp(),
      onboarding_last_error_code = clean_reason
  where id = account.id;
  update public.whatsapp_business_token_validation_jobs
  set status = 'cancelled', processing_started_at = null,
      lease_expires_at = null, lease_token = null,
      last_error_code = clean_reason
  where account_id = account.id;
  update public.whatsapp_onboarding_outbox
  set status = 'succeeded',
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      completion_reason = 'local_credential_purge',
      completed_at = clock_timestamp(),
      failed_at = null,
      last_error_code = null
  where id = job.id;
  update public.whatsapp_settings
  set integration_status = 'incomplete',
      sending_paused = true,
      sending_pause_reason = 'COEXISTENCE_OFFBOARDED',
      last_error = clean_reason,
      updated_at = clock_timestamp()
  where id = true;
  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    job.requested_by,
    'whatsapp.coexistence.local_offboarding_finalized',
    'whatsapp_coexistence_account',
    account.id,
    jsonb_build_object(
      'token_generation', job.token_generation,
      'reason', clean_reason
    )
  );
  return true;
end;
$$;

create or replace function public.resolve_whatsapp_coexistence_webhook_account(
  p_waba_id text,
  p_phone_number_id text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  result uuid;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if trim(coalesce(p_waba_id, '')) !~ '^[0-9]{5,64}$'
    or trim(coalesce(p_phone_number_id, '')) !~ '^[0-9]{5,64}$' then
    raise exception 'WHATSAPP_COEXISTENCE_ACCOUNT_IDENTITY_INVALID'
      using errcode = '22023';
  end if;
  select account.id into result
  from public.whatsapp_coexistence_accounts account
  where account.waba_id = trim(p_waba_id)
    and account.phone_number_id = trim(p_phone_number_id)
    and account.business_token_status = 'active'
    and account.business_token_secret_id is not null
    and (
      account.business_token_expires_at is null
      or account.business_token_expires_at > clock_timestamp()
    )
    and account.onboarding_status in ('provisioning', 'completed')
    and account.coexistence_status in ('onboarding', 'active', 'paused')
    and account.app_subscription_status in ('pending', 'subscribed')
    and account.offboarded_at is null;
  return result;
end;
$$;

create or replace function public.is_trusted_whatsapp_coexistence_webhook_waba(
  p_waba_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  trusted boolean;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if trim(coalesce(p_waba_id, '')) !~ '^[0-9]{5,64}$' then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'whatsapp-embedded-signup-waba:' || trim(p_waba_id),
    0
  ));
  select exists (
    select 1
    from public.whatsapp_coexistence_accounts account
    where account.waba_id = trim(p_waba_id)
      and (
        account.last_onboarding_attempt_id is not null
        or account.business_token_generation > 0
      )
    union all
    select 1
    from public.whatsapp_embedded_signup_attempts attempt
    where attempt.submitted_waba_id = trim(p_waba_id)
      and attempt.callback_received_at is not null
      and (
        (
          attempt.status in (
            'session_received', 'exchanging', 'token_stored', 'validating'
          )
          and coalesce(attempt.validation_deadline_at, attempt.expires_at)
            > clock_timestamp()
        )
        or (
          attempt.lifecycle_event_at is not null
          and attempt.lifecycle_event_at
            > clock_timestamp() - interval '24 hours'
        )
      )
  ) into trusted;
  return trusted;
end;
$$;

create or replace function public.apply_whatsapp_coexistence_account_update(
  p_waba_id text,
  p_event text,
  p_event_at timestamptz default clock_timestamp(),
  p_owner_business_id text default null,
  p_disconnection_reason text default null,
  p_disconnection_initiated_by text default null
)
returns table (
  account_id uuid,
  onboarding_status text,
  coexistence_status text,
  credential_revoked boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  account public.whatsapp_coexistence_accounts%rowtype;
  onboarding_attempt public.whatsapp_embedded_signup_attempts%rowtype;
  clean_event text := upper(trim(coalesce(p_event, '')));
  clean_owner text := nullif(trim(coalesce(p_owner_business_id, '')), '');
  clean_reason text := nullif(
    upper(trim(coalesce(p_disconnection_reason, ''))), ''
  );
  clean_initiated_by text := nullif(
    upper(trim(coalesce(p_disconnection_initiated_by, ''))), ''
  );
  event_error text;
  affected integer := 0;
  attempt_seen integer := 0;
  attempt_disposition text;
  exact_replay boolean;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if trim(coalesce(p_waba_id, '')) !~ '^[0-9]{5,64}$'
    or clean_event not in (
      'PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED', 'ACCOUNT_RECONNECTED'
    )
    or (clean_owner is not null and clean_owner !~ '^[0-9]{5,64}$')
    or p_event_at is null
    or p_event_at > clock_timestamp() + interval '5 minutes'
    or (
      (clean_reason is null) <> (clean_initiated_by is null)
    )
    or (
      clean_reason is not null
      and (
        clean_event <> 'PARTNER_REMOVED'
        or clean_reason !~ '^[A-Z0-9_]{3,100}$'
        or clean_initiated_by not in ('USER', 'SYSTEM')
      )
    )
  then
    raise exception 'WHATSAPP_COEXISTENCE_ACCOUNT_UPDATE_INVALID'
      using errcode = '22023';
  end if;

  event_error := case when clean_event = 'ACCOUNT_RECONNECTED'
    then 'REAUTHENTICATION_REQUIRED' else clean_event end;
  perform pg_advisory_xact_lock(hashtextextended(
    'whatsapp-embedded-signup-waba:' || trim(p_waba_id),
    0
  ));

  -- Before the first account row exists, FINISH is the only bounded mapping
  -- between this WABA and a locally authenticated signup transaction. A
  -- lifecycle event at/after FINISH wins the shared WABA lock, terminalizes
  -- that attempt and removes only its temporary Vault credential. Events
  -- from before FINISH remain supersedable by the explicit new signup.
  for onboarding_attempt in
    select candidate.*
    from public.whatsapp_embedded_signup_attempts candidate
    where candidate.submitted_waba_id = trim(p_waba_id)
      and candidate.callback_received_at is not null
      and not exists (
        select 1
        from public.whatsapp_coexistence_accounts managed_account
        where managed_account.waba_id = trim(p_waba_id)
          and (
            managed_account.last_onboarding_attempt_id is not null
            or managed_account.business_token_generation > 0
          )
      )
      and (
        clean_owner is null
        or candidate.submitted_business_portfolio_id = clean_owner
      )
      and (
        (
          candidate.status in (
            'session_received', 'exchanging', 'token_stored', 'validating'
          )
          and coalesce(
            candidate.validation_deadline_at, candidate.expires_at
          ) > clock_timestamp()
        )
        or candidate.lifecycle_event_at is not null
      )
    order by candidate.id
    for update
  loop
    attempt_seen := attempt_seen + 1;
    if onboarding_attempt.lifecycle_event_at is not null then
      if p_event_at > onboarding_attempt.lifecycle_event_at then
        attempt_disposition := 'TERMINAL_ATTEMPT_UPDATED';
        update public.whatsapp_embedded_signup_attempts target
        set lifecycle_event_at = p_event_at,
            lifecycle_event = clean_event,
            last_error_code = event_error
        where target.id = onboarding_attempt.id
        returning * into onboarding_attempt;
      elsif p_event_at = onboarding_attempt.lifecycle_event_at
        and clean_event = onboarding_attempt.lifecycle_event
      then
        attempt_disposition := 'IDEMPOTENT_REPLAY';
      else
        attempt_disposition := 'STALE_EVENT';
      end if;
      insert into public.audit_logs (
        actor_user_id, action, entity_type, entity_id, metadata
      ) values (
        onboarding_attempt.initiated_by,
        'whatsapp.embedded_signup.lifecycle_ignored',
        'whatsapp_embedded_signup_attempt', onboarding_attempt.id,
        jsonb_build_object(
          'event', clean_event,
          'event_at', p_event_at,
          'reason', attempt_disposition
        )
      );
      continue;
    end if;

    if p_event_at < date_trunc(
      'second', onboarding_attempt.callback_received_at
    ) then
      insert into public.audit_logs (
        actor_user_id, action, entity_type, entity_id, metadata
      ) values (
        onboarding_attempt.initiated_by,
        'whatsapp.embedded_signup.lifecycle_ignored',
        'whatsapp_embedded_signup_attempt', onboarding_attempt.id,
        jsonb_build_object(
          'event', clean_event,
          'event_at', p_event_at,
          'reason', 'PRE_FINISH_EVENT'
        )
      );
      continue;
    end if;

    if onboarding_attempt.temporary_token_secret_id is not null then
      delete from vault.secrets secret
      where secret.id = onboarding_attempt.temporary_token_secret_id
        and secret.name = 'whatsapp_embedded_signup_token_'
          || onboarding_attempt.id::text;
    end if;
    update public.whatsapp_embedded_signup_attempts target
    set status = 'failed',
        temporary_token_secret_id = null,
        validation_processing_started_at = null,
        validation_lease_expires_at = null,
        validation_lease_token = null,
        lifecycle_event_at = p_event_at,
        lifecycle_event = clean_event,
        last_error_code = event_error
    where target.id = onboarding_attempt.id
    returning * into onboarding_attempt;
    insert into public.audit_logs (
      actor_user_id, action, entity_type, entity_id, metadata
    ) values (
      onboarding_attempt.initiated_by,
      'whatsapp.embedded_signup.lifecycle_blocked',
      'whatsapp_embedded_signup_attempt', onboarding_attempt.id,
      jsonb_build_object(
        'event', clean_event,
        'event_at', p_event_at,
        'temporary_credential_removed', true
      )
    );
  end loop;

  for account in
    select candidate.*
    from public.whatsapp_coexistence_accounts candidate
    where candidate.waba_id = trim(p_waba_id)
      and (
        candidate.last_onboarding_attempt_id is not null
        or candidate.business_token_generation > 0
      )
      and (
        clean_owner is null
        or candidate.business_portfolio_id = clean_owner
      )
    order by candidate.id
    for update
  loop
    affected := affected + 1;
    exact_replay := account.last_account_update_at = p_event_at
      and account.last_account_update_event = clean_event
      and account.last_disconnection_reason is not distinct from clean_reason
      and account.last_disconnection_initiated_by
        is not distinct from clean_initiated_by;

    -- The entry timestamp is the causal barrier. Delayed lifecycle events and
    -- byte-for-byte semantic replays never change token/account state.
    if (
        account.onboarding_completed_at is not null
        and p_event_at < date_trunc(
          'second', account.onboarding_completed_at
        )
      ) or (
        account.last_account_update_at is not null
        and p_event_at < account.last_account_update_at
      ) or (
        account.offboarding_requested_at is not null
        and p_event_at < account.offboarding_requested_at
      ) or (
        account.offboarded_at is not null
        and p_event_at < account.offboarded_at
      ) or exact_replay
    then
      insert into public.audit_logs (
        action, entity_type, entity_id, metadata
      ) values (
        'whatsapp.coexistence.account_update_ignored',
        'whatsapp_coexistence_account', account.id,
        jsonb_build_object(
          'event', clean_event,
          'event_at', p_event_at,
          'reason', case when exact_replay
            then 'IDEMPOTENT_REPLAY' else 'STALE_EVENT' end
        )
      );
      account_id := account.id;
      onboarding_status := account.onboarding_status;
      coexistence_status := account.coexistence_status;
      credential_revoked := false;
      return next;
      continue;
    end if;

    -- An automatic reconnect callback cannot undo explicit local
    -- offboarding. It is acknowledged/audited, but leaves the disconnected
    -- token-free account eligible for a completely new signup transaction.
    if clean_event = 'ACCOUNT_RECONNECTED'
      and account.onboarding_status = 'offboarded'
    then
      -- Retain this otherwise-ignored callback as a causal barrier. A signup
      -- already in progress must not promote a token over a reconnect that
      -- arrived after START, while a future signup may supersede it.
      update public.whatsapp_coexistence_accounts target
      set last_account_update_at = p_event_at,
          last_account_update_event = clean_event,
          last_disconnection_reason = null,
          last_disconnection_initiated_by = null
      where target.id = account.id
      returning * into account;
      insert into public.audit_logs (
        action, entity_type, entity_id, metadata
      ) values (
        'whatsapp.coexistence.account_update_ignored',
        'whatsapp_coexistence_account', account.id,
        jsonb_build_object(
          'event', clean_event,
          'event_at', p_event_at,
          'reason', 'LOCALLY_OFFBOARDED'
        )
      );
      account_id := account.id;
      onboarding_status := account.onboarding_status;
      coexistence_status := account.coexistence_status;
      credential_revoked := false;
      return next;
      continue;
    end if;

    if account.last_account_update_at = p_event_at then
      perform public.block_whatsapp_account_graph_work(
        account.id, 'ACCOUNT_UPDATE_TIMESTAMP_CONFLICT'
      );
      update public.whatsapp_coexistence_accounts target
      set business_token_status = case
            when target.business_token_secret_id is null
              then target.business_token_status
            else 'unknown'
          end,
          business_token_is_valid = case
            when target.business_token_secret_id is null
              then target.business_token_is_valid else null end,
          business_token_validation_status = case
            when target.business_token_secret_id is null
              then target.business_token_validation_status else 'unknown' end,
          business_token_validation_due_at = case
            when target.business_token_secret_id is null
              then target.business_token_validation_due_at else p_event_at end,
          business_token_last_validation_error_code =
            'ACCOUNT_UPDATE_TIMESTAMP_CONFLICT',
          attention_required = true,
          attention_required_at = p_event_at,
          attention_required_reason = 'ACCOUNT_UPDATE_TIMESTAMP_CONFLICT',
          coexistence_status = case
            when target.coexistence_status = 'disconnected'
            then 'disconnected' else 'paused' end,
          onboarding_status = case
            when target.onboarding_status = 'provisioning'
            then 'failed' else target.onboarding_status end,
          onboarding_last_error_code = 'ACCOUNT_UPDATE_TIMESTAMP_CONFLICT'
      where target.id = account.id
      returning * into account;
      insert into public.audit_logs (
        action, entity_type, entity_id, metadata
      ) values (
        'whatsapp.coexistence.account_update_conflict',
        'whatsapp_coexistence_account', account.id,
        jsonb_build_object(
          'received_event', clean_event,
          'stored_event', account.last_account_update_event,
          'event_at', p_event_at
        )
      );
      account_id := account.id;
      onboarding_status := account.onboarding_status;
      coexistence_status := account.coexistence_status;
      credential_revoked := false;
      return next;
      continue;
    end if;

    -- Explicit administrative offboarding is causally stronger than an
    -- automatic lifecycle callback. Preserve (or recover) its unsubscribe
    -- job and retained credential so the processor can reconcile Meta or use
    -- the explicit local-finalization path. A reconnect cannot silently undo
    -- the administrator's request or start a competing validation job.
    if account.onboarding_status = 'offboarding'
      and account.offboarding_requested_at is not null
    then
      perform public.close_whatsapp_coexistence_onboarding_syncs(
        account.id, event_error
      );
      perform public.block_whatsapp_account_graph_work(
        account.id, event_error
      );
      update public.whatsapp_business_token_validation_jobs
      set status = 'cancelled', processing_started_at = null,
          lease_expires_at = null, lease_token = null,
          last_error_code = event_error
      where whatsapp_business_token_validation_jobs.account_id = account.id
        and status in ('pending', 'processing', 'failed');

      update public.whatsapp_onboarding_outbox unsubscribe_job
      set status = 'pending',
          attempts = 0,
          available_at = clock_timestamp(),
          processing_started_at = null,
          lease_expires_at = null,
          lease_token = null,
          completed_at = null,
          failed_at = null,
          completion_reason = null,
          last_error_code = null
      where unsubscribe_job.account_id = account.id
        and unsubscribe_job.token_generation = account.business_token_generation
        and unsubscribe_job.operation = 'unsubscribe_app'
        and unsubscribe_job.status in ('ambiguous', 'failed', 'cancelled');

      update public.whatsapp_coexistence_accounts target
      set business_token_status = case
            when target.business_token_secret_id is null
              then target.business_token_status
            else 'unknown'
          end,
          business_token_is_valid = case
            when target.business_token_secret_id is null
              then target.business_token_is_valid else null end,
          business_token_validation_status = case
            when target.business_token_secret_id is null
              then target.business_token_validation_status else 'unknown' end,
          business_token_validation_due_at = case
            when target.business_token_secret_id is null
              then target.business_token_validation_due_at else p_event_at end,
          business_token_last_validation_error_code = case
            when target.business_token_secret_id is null
              then target.business_token_last_validation_error_code
            else event_error end,
          attention_required = true,
          attention_required_at = p_event_at,
          attention_required_reason = event_error,
          onboarding_status = 'offboarding',
          app_subscription_status = 'unsubscribing',
          coexistence_status = 'paused',
          offboarding_requested_at = account.offboarding_requested_at,
          offboarded_at = null,
          last_account_update_at = p_event_at,
          last_account_update_event = clean_event,
          last_disconnection_reason = case
            when clean_event = 'PARTNER_REMOVED' then clean_reason else null end,
          last_disconnection_initiated_by = case
            when clean_event = 'PARTNER_REMOVED'
              then clean_initiated_by else null end,
          onboarding_last_error_code = event_error
      where target.id = account.id
      returning * into account;

      insert into public.audit_logs (
        action, entity_type, entity_id, metadata
      ) values (
        'whatsapp.coexistence.account_update',
        'whatsapp_coexistence_account', account.id,
        jsonb_build_object(
          'event', clean_event,
          'event_at', p_event_at,
          'owner_business_id_present', clean_owner is not null,
          'disconnection_reason', clean_reason,
          'disconnection_initiated_by', clean_initiated_by,
          'credential_revoked', false,
          'administrative_offboarding_preserved', true
        )
      );
      account_id := account.id;
      onboarding_status := account.onboarding_status;
      coexistence_status := account.coexistence_status;
      credential_revoked := false;
      return next;
      continue;
    end if;

    perform public.close_whatsapp_coexistence_onboarding_syncs(
      account.id, event_error
    );
    perform public.block_whatsapp_account_graph_work(account.id, event_error);
    update public.whatsapp_business_token_validation_jobs
    set status = 'cancelled', processing_started_at = null,
        lease_expires_at = null, lease_token = null,
        last_error_code = event_error
    where whatsapp_business_token_validation_jobs.account_id = account.id
      and status in ('pending', 'processing', 'failed');

    update public.whatsapp_coexistence_accounts target
    set business_token_status = case
          when target.business_token_secret_id is null
            then target.business_token_status
          else 'unknown'
        end,
        business_token_is_valid = case
          when target.business_token_secret_id is null
            then target.business_token_is_valid else null end,
        business_token_validation_status = case
          when target.business_token_secret_id is null
            then target.business_token_validation_status else 'unknown' end,
        business_token_validation_due_at = case
          when target.business_token_secret_id is null
            then target.business_token_validation_due_at else p_event_at end,
        business_token_last_validation_error_code = case
          when target.business_token_secret_id is null
            then target.business_token_last_validation_error_code
            else event_error end,
        attention_required = true,
        attention_required_at = p_event_at,
        attention_required_reason = event_error,
        onboarding_status = case
          when target.onboarding_status = 'provisioning' then 'failed'
          else target.onboarding_status
        end,
        app_subscription_status = case
          when clean_event = 'PARTNER_REMOVED' then 'unknown'
          else target.app_subscription_status
        end,
        app_subscribed_at = case
          when clean_event = 'PARTNER_REMOVED' then null
          else target.app_subscribed_at
        end,
        coexistence_status = case
          when clean_event = 'ACCOUNT_RECONNECTED' then 'paused'
          else 'disconnected'
        end,
        offboarding_requested_at = case
          when clean_event = 'ACCOUNT_RECONNECTED' then null
          else target.offboarding_requested_at
        end,
        -- account_update is not proof that local retention is no longer
        -- needed. Explicit unsubscribe completion alone sets offboarded_at.
        offboarded_at = case when target.onboarding_status = 'offboarded'
          then target.offboarded_at else null end,
        last_account_update_at = p_event_at,
        last_account_update_event = clean_event,
        last_disconnection_reason = case
          when clean_event = 'PARTNER_REMOVED' then clean_reason else null end,
        last_disconnection_initiated_by = case
          when clean_event = 'PARTNER_REMOVED'
            then clean_initiated_by else null end,
        onboarding_last_error_code = event_error
    where target.id = account.id
    returning * into account;

    if clean_event = 'ACCOUNT_RECONNECTED'
      and account.business_token_secret_id is not null
      and account.onboarding_status <> 'offboarded'
    then
      insert into public.whatsapp_business_token_validations (
        account_id, token_generation, validation_reason, is_valid,
        authorization_valid, app_id,
        scopes, granular_scopes, target_ids, expires_at,
        data_access_expires_at, expires_at_epoch,
        data_access_expires_at_epoch, validated_at, error_code
      ) values (
        account.id, account.business_token_generation, 'reconnect', null,
        false,
        account.business_token_app_id, account.business_token_scopes,
        account.business_token_granular_scopes,
        account.business_token_target_ids,
        account.business_token_expires_at,
        account.business_token_data_access_expires_at,
        case when account.business_token_expires_at is null then null
          else extract(epoch from account.business_token_expires_at)::bigint end,
        case when account.business_token_data_access_expires_at is null
          then null
          else extract(epoch from account.business_token_data_access_expires_at)::bigint end,
        p_event_at, 'REAUTHENTICATION_REQUIRED'
      );
      perform public.schedule_whatsapp_business_token_validation(
        account.id, account.business_token_generation, clock_timestamp(),
        'reconnect'
      );
      update public.whatsapp_business_token_validation_jobs validation_job
      set pause_observed_at = p_event_at,
          pause_error_code = 'REAUTHENTICATION_REQUIRED'
      where validation_job.account_id = account.id
        and validation_job.token_generation = account.business_token_generation
        and validation_job.validation_reason = 'reconnect';
    end if;

    insert into public.audit_logs (
      action, entity_type, entity_id, metadata
    ) values (
      'whatsapp.coexistence.account_update',
      'whatsapp_coexistence_account', account.id,
      jsonb_build_object(
        'event', clean_event,
        'event_at', p_event_at,
        'owner_business_id_present', clean_owner is not null,
        'disconnection_reason', clean_reason,
        'disconnection_initiated_by', clean_initiated_by,
        'credential_revoked', false
      )
    );
    account_id := account.id;
    onboarding_status := account.onboarding_status;
    coexistence_status := account.coexistence_status;
    credential_revoked := false;
    return next;
  end loop;

  if affected = 0 and attempt_seen > 0 then
    account_id := null;
    onboarding_status := 'failed';
    coexistence_status := 'disconnected';
    credential_revoked := false;
    return next;
  elsif affected = 0 then
    raise exception 'WHATSAPP_COEXISTENCE_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.whatsapp_embedded_signup_status(
  p_admin_user_id uuid,
  p_client_scope text default 'gisela-lentz-wp'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  result jsonb;
  clean_scope text := lower(trim(coalesce(p_client_scope, '')));
begin
  perform public.assert_whatsapp_embedded_signup_admin(p_admin_user_id);
  perform public.expire_whatsapp_embedded_signup_attempts();
  select jsonb_build_object(
    'configured', true,
    'onboarding', coalesce((
      select jsonb_build_object(
        'attemptId', attempt.id,
        'status', attempt.status,
        'startedAt', attempt.created_at,
        'expiresAt', attempt.expires_at,
        'lastError', attempt.last_error_code
      )
      from public.whatsapp_embedded_signup_attempts attempt
      where attempt.client_scope = clean_scope
      order by attempt.created_at desc
      limit 1
    ), 'null'::jsonb),
    'account', coalesce((
      select jsonb_build_object(
        'accountId', account.id,
        'connected', account.onboarding_status = 'completed'
          and account.app_subscription_status = 'subscribed'
          and account.coexistence_status = 'active'
          and account.business_token_status = 'active'
          and account.business_token_secret_id is not null
          and account.business_token_validation_status = 'valid'
          and account.business_token_is_valid
          and not account.attention_required
          and account.business_token_validation_due_at
            > clock_timestamp()
          and (
            account.business_token_expires_at is null
            or account.business_token_expires_at > clock_timestamp()
          )
          and (
            account.business_token_data_access_expires_at is null
            or account.business_token_data_access_expires_at
              > clock_timestamp()
          ),
        'onboardingStatus', account.onboarding_status,
        'wabaId', account.waba_id,
        'phoneNumberId', account.phone_number_id,
        'displayPhone', account.display_phone,
        'onboardedAt', account.onboarding_completed_at,
        'subscriptionStatus', account.app_subscription_status,
        'contactsStatus', account.app_state_sync_status,
        'historyStatus', account.history_sync_status,
        'historyDecision', account.history_sharing_decision,
        'syncDeadlineAt', account.initial_sync_deadline_at,
        'syncAtRisk', account.initial_sync_deadline_at is not null
          and account.initial_sync_deadline_at <= clock_timestamp() + interval '1 hour'
          and account.onboarding_status <> 'completed',
        'tokenConfigured', account.business_token_status = 'active'
          and account.business_token_secret_id is not null
          and account.business_token_validation_status = 'valid'
          and account.business_token_is_valid
          and not account.attention_required
          and account.business_token_validation_due_at
            > clock_timestamp()
          and (
            account.business_token_expires_at is null
            or account.business_token_expires_at > clock_timestamp()
          )
          and (
            account.business_token_data_access_expires_at is null
            or account.business_token_data_access_expires_at
              > clock_timestamp()
          ),
        'tokenStatus', account.business_token_status,
        'tokenValidationStatus', account.business_token_validation_status,
        'tokenLastValidatedAt', account.business_token_last_validated_at,
        'tokenValidationDueAt', account.business_token_validation_due_at,
        'attentionRequired', account.attention_required
          or coalesce(
            account.business_token_validation_due_at <= clock_timestamp(),
            false
          )
          or coalesce(
            account.business_token_expires_at <= clock_timestamp(), false
          )
          or coalesce(
            account.business_token_data_access_expires_at
              <= clock_timestamp(),
            false
          ),
        'attentionRequiredAt', account.attention_required_at,
        'attentionReason', coalesce(
          account.attention_required_reason,
          case
            when account.business_token_data_access_expires_at
              <= clock_timestamp() then 'TOKEN_DATA_ACCESS_EXPIRED'
            when account.business_token_expires_at <= clock_timestamp()
              then 'TOKEN_EXPIRED'
            when account.business_token_validation_due_at
              <= clock_timestamp() then 'TOKEN_VALIDATION_OVERDUE'
            else null
          end
        ),
        'lastDisconnectionReason', account.last_disconnection_reason,
        'lastDisconnectionInitiatedBy',
          account.last_disconnection_initiated_by,
        'tokenExpiresAt', account.business_token_expires_at,
        'tokenDataAccessExpiresAt',
          account.business_token_data_access_expires_at,
        'tokenExpiryKnown', account.business_token_expires_at is not null
          or account.business_token_data_access_expires_at is not null,
        'tokenExpired', coalesce((
            account.business_token_expires_at <= clock_timestamp()
            or account.business_token_data_access_expires_at
              <= clock_timestamp()
          ), false)
          and (
            account.business_token_secret_id is not null
            or account.business_token_status = 'active'
          ),
        'requiresOffboarding', account.business_token_secret_id is not null
          or account.business_token_status = 'active'
          or account.onboarding_status in (
            'provisioning', 'completed', 'offboarding'
          ),
        'lastError', account.onboarding_last_error_code,
        'offboardedAt', account.offboarded_at
      )
      from public.whatsapp_coexistence_accounts account
      left join public.whatsapp_embedded_signup_attempts account_attempt
        on account_attempt.id = account.last_onboarding_attempt_id
      where account.client_scope = clean_scope
        and (
          account.last_onboarding_attempt_id is not null
          or account.business_token_generation > 0
        )
      order by
        case
          when account.business_token_status = 'active'
            and account.onboarding_status in ('provisioning', 'completed')
            then 0
          when account.onboarding_status = 'offboarding' then 1
          when account.onboarding_status = 'failed' then 2
          when account.onboarding_status = 'offboarded' then 3
          else 4
        end,
        account_attempt.created_at desc nulls last,
        account.onboarding_completed_at desc nulls last,
        account.created_at desc,
        account.id
      limit 1
    ), 'null'::jsonb),
    'sendingPaused', coalesce((
      select settings.sending_paused
      from public.whatsapp_settings settings where settings.id
    ), true),
    'pendingJobs', (
      select count(*)
      from public.whatsapp_onboarding_outbox job
      join public.whatsapp_coexistence_accounts account
        on account.id = job.account_id
      where account.client_scope = clean_scope
        and job.status in ('pending', 'processing')
    ),
    'ambiguousJobs', (
      select count(*)
      from public.whatsapp_onboarding_outbox job
      join public.whatsapp_coexistence_accounts account
        on account.id = job.account_id
      where account.client_scope = clean_scope
        and job.status = 'ambiguous'
    )
  ) into result;
  return result;
end;
$$;

-- Internal trigger/helper functions stay non-callable. Public RPCs are
-- service-role only and independently validate the initiating active ADMIN
-- wherever an administrator action is represented.
do $$
declare
  signature regprocedure;
begin
  for signature in
    select procedure_oid
    from (values
      ('public.create_whatsapp_embedded_signup_attempt(uuid,text,text,text,text,text,text,timestamptz)'::regprocedure),
      ('public.record_whatsapp_embedded_signup_session(uuid,uuid,text,text,text,timestamptz,text,text,text,jsonb,text)'::regprocedure),
      ('public.claim_whatsapp_embedded_signup_code(uuid,uuid,text,text,text)'::regprocedure),
      ('public.store_whatsapp_embedded_signup_exchange_token(uuid,text,text)'::regprocedure),
      ('public.record_whatsapp_embedded_signup_post_exchange_validation(uuid,boolean,text,text[],jsonb,text[],timestamptz,timestamptz,timestamptz,text)'::regprocedure),
      ('public.get_whatsapp_embedded_signup_validation_context(uuid)'::regprocedure),
      ('public.record_whatsapp_embedded_signup_pre_completion_validation(uuid,uuid,boolean,text,text[],jsonb,text[],timestamptz,timestamptz,timestamptz,text)'::regprocedure),
      ('public.claim_whatsapp_embedded_signup_validations(integer,uuid)'::regprocedure),
      ('public.fail_whatsapp_embedded_signup_validation(uuid,uuid,text,boolean)'::regprocedure),
      ('public.complete_whatsapp_embedded_signup(uuid,uuid,text,text,text,text,boolean,text,text[],jsonb,text[],timestamptz,timestamptz,timestamptz,uuid)'::regprocedure),
      ('public.fail_whatsapp_embedded_signup_attempt(uuid,uuid,text)'::regprocedure),
      ('public.cancel_whatsapp_embedded_signup_attempt(uuid,uuid,text)'::regprocedure),
      ('public.resolve_whatsapp_account_credentials(text,uuid,text,text,uuid,bigint)'::regprocedure),
      ('public.claim_whatsapp_business_token_validation_jobs(integer)'::regprocedure),
      ('public.complete_whatsapp_business_token_validation_job(uuid,uuid,boolean,text,text[],jsonb,text[],timestamptz,timestamptz,timestamptz,text)'::regprocedure),
      ('public.fail_whatsapp_business_token_validation_job(uuid,uuid,text,boolean)'::regprocedure),
      ('public.mark_whatsapp_business_token_attention_required(uuid,bigint,text,text,timestamptz)'::regprocedure),
      ('public.pause_whatsapp_automation_for_app_echo(uuid,text,text)'::regprocedure),
      ('public.claim_whatsapp_onboarding_jobs(integer)'::regprocedure),
      ('public.complete_whatsapp_onboarding_job(uuid,uuid,text,text)'::regprocedure),
      ('public.fail_whatsapp_onboarding_job(uuid,uuid,text,text,boolean)'::regprocedure),
      ('public.begin_whatsapp_coexistence_offboarding(uuid,uuid,text)'::regprocedure),
      ('public.finalize_whatsapp_coexistence_local_offboarding(uuid,uuid,text)'::regprocedure),
      ('public.resolve_whatsapp_coexistence_webhook_account(text,text)'::regprocedure),
      ('public.is_trusted_whatsapp_coexistence_webhook_waba(text)'::regprocedure),
      ('public.apply_whatsapp_coexistence_account_update(text,text,timestamptz,text,text,text)'::regprocedure),
      ('public.whatsapp_embedded_signup_status(uuid,text)'::regprocedure)
    ) functions(procedure_oid)
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated',
      signature
    );
    execute format('grant execute on function %s to service_role', signature);
  end loop;
end;
$$;

revoke execute on function public.assert_whatsapp_embedded_signup_admin(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.expire_whatsapp_embedded_signup_attempts()
  from public, anon, authenticated, service_role;
revoke execute on function public.expire_whatsapp_onboarding_jobs()
  from public, anon, authenticated, service_role;
revoke execute on function public.recompute_whatsapp_embedded_signup_onboarding(uuid, bigint)
  from public, anon, authenticated, service_role;
revoke execute on function public.close_whatsapp_coexistence_onboarding_syncs(uuid, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.schedule_whatsapp_business_token_validation(uuid, bigint, timestamptz, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.block_whatsapp_account_graph_work(uuid, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.pause_whatsapp_automation_for_app_echo(text, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.is_valid_whatsapp_embedded_signup_asset_ids(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.is_valid_whatsapp_business_token_metadata(text[], jsonb, text[])
  from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_business_token_next_validation_at(timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke execute on function public.bind_whatsapp_message_conversation_account()
  from public, anon, authenticated, service_role;
revoke execute on function public.guard_whatsapp_conversation_account_change()
  from public, anon, authenticated, service_role;
revoke execute on function public.stamp_whatsapp_automation_account_snapshots()
  from public, anon, authenticated, service_role;

comment on table public.whatsapp_embedded_signup_attempts is
  'One-shot Embedded Signup transactions. Contains hashes and allowlisted asset IDs only; never codes or tokens.';
comment on table public.whatsapp_onboarding_outbox is
  'Durable post-onboarding Graph operations with leases, bounded backoff, a 24-hour deadline and explicit ambiguous outcomes.';
comment on table public.whatsapp_business_token_validations is
  'Append-only server-side debug_token validation ledger. Contains metadata only and never stores access-token material.';
comment on table public.whatsapp_business_token_validation_jobs is
  'Lease-based periodic token-validation schedule with bounded retries and generation fencing.';
comment on function public.resolve_whatsapp_account_credentials(text, uuid, text, text, uuid, bigint) is
  'Fail-closed service-role Vault bridge. Coexistence identities never fall back to legacy environment credentials and secrets must never reach a browser or log.';
