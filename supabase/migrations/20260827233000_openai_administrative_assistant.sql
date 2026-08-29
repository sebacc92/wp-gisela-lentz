-- Optional, privacy-bounded OpenAI assistance for institutional questions.
-- It is deliberately born disabled. The global WhatsApp automation kill
-- switch remains an independent, authoritative prerequisite.

alter table public.app_settings
  add column ai_enabled boolean not null default false,
  add column ai_model text not null default 'gpt-5.6-luna',
  add constraint app_settings_ai_model_check check (
    ai_model = 'gpt-5.6-luna'
  );

comment on column public.app_settings.ai_enabled is
  'ADMIN-controlled OpenAI administrative answers; global automation must also be enabled.';
comment on column public.app_settings.ai_model is
  'Fixed server-side OpenAI model; never accepted from browser requests.';

-- One reservation per inbound closes the crash window between an external API
-- response and the durable automation decision. The bounded counters are a
-- server-side cost/abuse guard and contain no message text or external IDs.
create table public.openai_administrative_requests (
  inbound_message_id uuid primary key
    references public.messages (id) on delete cascade,
  contact_id uuid not null
    references public.contacts (id) on delete cascade,
  reserved_at timestamptz not null default clock_timestamp()
);

create index openai_administrative_requests_contact_time_idx
  on public.openai_administrative_requests (contact_id, reserved_at desc);
create index openai_administrative_requests_time_idx
  on public.openai_administrative_requests (reserved_at desc);

alter table public.openai_administrative_requests enable row level security;
revoke all on table public.openai_administrative_requests
  from public, anon, authenticated, service_role;

create function public.recall_whatsapp_automation_decision(
  p_message_id uuid,
  p_lease_token uuid,
  p_sequence integer,
  p_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_effect public.whatsapp_automation_effects%rowtype;
  effect_key_value text;
  request_value jsonb;
begin
  perform public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );
  if p_sequence not between 0 and 100
    or char_length(trim(coalesce(p_key, ''))) not between 1 and 80
  then
    raise exception 'WHATSAPP_AUTOMATION_DECISION_INVALID'
      using errcode = '22023';
  end if;

  effect_key_value := 'decision:' || p_sequence::text;
  request_value := jsonb_build_object('key', trim(p_key));
  select effect.* into existing_effect
  from public.whatsapp_automation_effects effect
  where effect.execution_message_id = p_message_id
    and effect.effect_key = effect_key_value;
  if not found then
    return null;
  end if;
  if existing_effect.effect_type <> 'decision'
    or existing_effect.request <> request_value
  then
    raise exception 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT'
      using errcode = '23514';
  end if;
  return existing_effect.result -> 'value';
end;
$$;

create function public.reserve_openai_administrative_request(
  p_message_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  request_time timestamptz := clock_timestamp();
begin
  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );

  -- Serialize the small single-tenant quota check with its insert.
  perform pg_catalog.pg_advisory_xact_lock(847493039104);

  if exists (
    select 1
    from public.openai_administrative_requests request
    where request.inbound_message_id = p_message_id
  ) then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'ALREADY_RESERVED'
    );
  end if;

  if (
    select count(*) >= 3
    from public.openai_administrative_requests request
    where request.contact_id = execution_row.contact_id
      and request.reserved_at >= request_time - interval '1 hour'
  ) then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'CONTACT_HOURLY_LIMIT'
    );
  end if;

  if (
    select count(*) >= 30
    from public.openai_administrative_requests request
    where request.reserved_at >= request_time - interval '1 hour'
  ) then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'TENANT_HOURLY_LIMIT'
    );
  end if;

  if (
    select count(*) >= 100
    from public.openai_administrative_requests request
    where request.reserved_at >= request_time - interval '24 hours'
  ) then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'TENANT_DAILY_LIMIT'
    );
  end if;

  insert into public.openai_administrative_requests (
    inbound_message_id,
    contact_id,
    reserved_at
  ) values (
    p_message_id,
    execution_row.contact_id,
    request_time
  );
  return jsonb_build_object('allowed', true, 'reason', 'RESERVED');
end;
$$;

revoke all on function public.recall_whatsapp_automation_decision(uuid, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.recall_whatsapp_automation_decision(uuid, uuid, integer, text)
  to service_role;
revoke all on function public.reserve_openai_administrative_request(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_openai_administrative_request(uuid, uuid)
  to service_role;

comment on table public.openai_administrative_requests is
  'Content-free reservation and quota ledger for bounded OpenAI administrative calls.';
comment on function public.reserve_openai_administrative_request(uuid, uuid) is
  'Atomically allows one call per inbound, max 3/contact/hour, 30/tenant/hour and 100/tenant/day.';

create function public.audit_openai_administrative_settings_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.ai_enabled is distinct from new.ai_enabled
    or old.ai_model is distinct from new.ai_model
  then
    insert into public.audit_logs (
      actor_user_id,
      action,
      entity_type,
      metadata
    ) values (
      auth.uid(),
      'openai.administrative_settings_updated',
      'app_settings',
      jsonb_build_object(
        'enabled', new.ai_enabled,
        'model', new.ai_model
      )
    );
  end if;
  return new;
end;
$$;

create trigger audit_openai_administrative_settings_change
  after update of ai_enabled, ai_model
  on public.app_settings
  for each row
  execute function public.audit_openai_administrative_settings_change();

revoke all on function public.audit_openai_administrative_settings_change()
  from public, anon, authenticated, service_role;
