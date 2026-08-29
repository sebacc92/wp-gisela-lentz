-- Keep the short burst guard fixed while allowing a bounded, server-owned
-- daily limit. The quota is scoped to the initiating ADMIN and client scope;
-- a different administrator or tenant never consumes this pair's allowance.

create index if not exists whatsapp_embedded_signup_admin_scope_created_idx
  on public.whatsapp_embedded_signup_attempts (
    initiated_by, client_scope, created_at desc
  );

-- Server-only, read-only eligibility probe used for operational verification.
-- It deliberately returns no threshold, counts, IDs or timestamps.
create function public.whatsapp_embedded_signup_rate_limit_eligible(
  p_admin_user_id uuid,
  p_client_scope text,
  p_max_attempts_24h integer default 10
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  clean_scope text := lower(trim(coalesce(p_client_scope, '')));
  checked_at_value timestamptz := clock_timestamp();
  effective_max_attempts_24h integer := greatest(
    5,
    least(50, coalesce(p_max_attempts_24h, 10))
  );
  attempts_15m integer;
  attempts_24h integer;
begin
  perform public.assert_whatsapp_embedded_signup_admin(p_admin_user_id);
  if clean_scope !~ '^[a-z0-9][a-z0-9._:-]{2,99}$' then
    raise exception 'WHATSAPP_EMBEDDED_SIGNUP_ATTEMPT_INVALID'
      using errcode = '22023';
  end if;

  select
    count(*) filter (
      where attempt.created_at > checked_at_value - interval '15 minutes'
    )::integer,
    count(*) filter (
      where attempt.created_at > checked_at_value - interval '24 hours'
    )::integer
  into attempts_15m, attempts_24h
  from public.whatsapp_embedded_signup_attempts attempt
  where attempt.initiated_by = p_admin_user_id
    and attempt.client_scope = clean_scope;

  return attempts_15m < 3
    and attempts_24h < effective_max_attempts_24h;
end;
$$;

drop function public.create_whatsapp_embedded_signup_attempt(
  uuid, text, text, text, text, text, text, timestamptz
);

create function public.create_whatsapp_embedded_signup_attempt(
  p_admin_user_id uuid,
  p_client_scope text,
  p_state_hash text,
  p_nonce_hash text,
  p_app_id text,
  p_configuration_id text,
  p_history_sharing_decision text,
  p_expires_at timestamptz,
  p_max_attempts_24h integer default 10
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
  effective_max_attempts_24h integer := greatest(
    5,
    least(50, coalesce(p_max_attempts_24h, 10))
  );
  attempts_15m integer;
  attempts_24h integer;
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
    hashtextextended(
      'whatsapp-embedded-signup-admin:'
        || p_admin_user_id::text || ':' || clean_scope,
      0
    )
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

  -- Every persisted attempt is a real START and counts regardless of its
  -- eventual state. A rate-limited request never inserts into this ledger.
  select
    count(*) filter (
      where attempt.created_at > created_at_value - interval '15 minutes'
    )::integer,
    count(*) filter (
      where attempt.created_at > created_at_value - interval '24 hours'
    )::integer
  into attempts_15m, attempts_24h
  from public.whatsapp_embedded_signup_attempts attempt
  where attempt.initiated_by = p_admin_user_id
    and attempt.client_scope = clean_scope;

  if attempts_15m >= 3 or attempts_24h >= effective_max_attempts_24h then
    -- Persist at most one rejection audit per pair and 15-minute window. The
    -- RPC returns a sentinel instead of raising so this audit is not rolled
    -- back; the Edge Function canonicalizes it to HTTP 409.
    if not exists (
      select 1
      from public.audit_logs audit
      where audit.actor_user_id = p_admin_user_id
        and audit.action = 'whatsapp.embedded_signup.rate_limited'
        and audit.created_at > created_at_value - interval '15 minutes'
        and audit.metadata ->> 'client_scope' = clean_scope
    ) then
      insert into public.audit_logs (
        actor_user_id, action, entity_type, metadata
      ) values (
        p_admin_user_id,
        'whatsapp.embedded_signup.rate_limited',
        'whatsapp_embedded_signup_attempt',
        jsonb_build_object(
          'client_scope', clean_scope,
          'scope', 'initiated_by+client_scope',
          'burst_limit_reached', attempts_15m >= 3,
          'daily_limit_reached',
            attempts_24h >= effective_max_attempts_24h
        )
      );
    end if;

    return query
    select null::uuid, 'rate_limited'::text, null::timestamptz;
    return;
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
      'rate_limit_scope', 'initiated_by+client_scope',
      'sending_paused', true,
      'sending_pause_reason', 'COEXISTENCE_ONBOARDING'
    )
  );

  return query
  select result_id, 'initiated'::text, p_expires_at;
end;
$$;

revoke all on function public.create_whatsapp_embedded_signup_attempt(
  uuid, text, text, text, text, text, text, timestamptz, integer
) from public, anon, authenticated, service_role;
revoke all on function public.whatsapp_embedded_signup_rate_limit_eligible(
  uuid, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.create_whatsapp_embedded_signup_attempt(
  uuid, text, text, text, text, text, text, timestamptz, integer
) to service_role;
grant execute on function public.whatsapp_embedded_signup_rate_limit_eligible(
  uuid, text, integer
) to service_role;
