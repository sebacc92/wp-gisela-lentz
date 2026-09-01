-- Per-conversation, short-lived test enablement for the production automation.
--
-- This is deliberately an operational exception only. The environment kill
-- switch, account/recipient policy, consent, idempotency, leases, explicit
-- pauses and every other send-time control remain independent and fail closed.

alter table public.conversations
  add column automation_test_override_activated_at timestamptz,
  add column automation_test_override_until timestamptz,
  add column automation_test_override_activated_by uuid
    references public.profiles (id) on delete set null,
  add constraint conversations_automation_test_override_window_check check (
    (
      automation_test_override_activated_at is null
      and automation_test_override_until is null
      and automation_test_override_activated_by is null
    )
    or (
      automation_test_override_activated_at is not null
      and automation_test_override_until is not null
      and automation_test_override_until
        > automation_test_override_activated_at
    )
  );

comment on column
  public.conversations.automation_test_override_activated_at is
  'Start of the current short-lived per-conversation automation test window.';
comment on column public.conversations.automation_test_override_until is
  'Exclusive end of the current test window; active only while this is later than the live database clock.';
comment on column
  public.conversations.automation_test_override_activated_by is
  'Admin who opened the current test window. Historical actors remain in the append-only event ledger.';

-- Authenticated users have a legacy table-level INSERT grant on conversations,
-- so column grants alone are not an authorization boundary for newly added
-- fields. Only the SECURITY DEFINER admin RPCs below open this transaction-local
-- write capability; ordinary INSERT/UPDATE calls fail even if their table grant
-- would otherwise reach the row.
create or replace function public.guard_conversation_automation_test_override()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  override_changed boolean;
  capability_enabled boolean := coalesce(
    current_setting('app.whatsapp_automation_test_override_write', true),
    ''
  ) = 'on';
begin
  override_changed := case
    when tg_op = 'INSERT' then
      new.automation_test_override_activated_at is not null
      or new.automation_test_override_until is not null
      or new.automation_test_override_activated_by is not null
    else
      new.automation_test_override_activated_at is distinct from
        old.automation_test_override_activated_at
      or new.automation_test_override_until is distinct from
        old.automation_test_override_until
      or new.automation_test_override_activated_by is distinct from
        old.automation_test_override_activated_by
  end;

  if override_changed and not (
    capability_enabled
    and current_user in ('postgres', 'supabase_admin')
  ) then
    raise exception 'WHATSAPP_AUTOMATION_TEST_OVERRIDE_RPC_REQUIRED'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger aa_conversations_guard_automation_test_override
  before insert or update of
    automation_test_override_activated_at,
    automation_test_override_until,
    automation_test_override_activated_by
  on public.conversations
  for each row execute function
    public.guard_conversation_automation_test_override();

revoke execute on function
  public.guard_conversation_automation_test_override()
  from public, anon, authenticated, service_role;

-- Keep a compact append-only history without copying message bodies, contact
-- names, phone numbers or any other patient data.
create table public.whatsapp_automation_test_override_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null
    references public.conversations (id) on delete cascade,
  action text not null,
  actor_user_id uuid references public.profiles (id) on delete set null,
  occurred_at timestamptz not null default clock_timestamp(),
  effective_until timestamptz,
  constraint whatsapp_automation_test_override_events_action_check check (
    action in ('activated', 'extended', 'revoked')
  ),
  constraint whatsapp_automation_test_override_events_window_check check (
    (
      action in ('activated', 'extended')
      and effective_until is not null
      and effective_until > occurred_at
    )
    or action = 'revoked'
  )
);

create index whatsapp_automation_test_override_events_conversation_idx
  on public.whatsapp_automation_test_override_events (
    conversation_id, occurred_at desc
  );

alter table public.whatsapp_automation_test_override_events
  enable row level security;

create policy whatsapp_automation_test_override_events_admin_read
  on public.whatsapp_automation_test_override_events
  for select to authenticated
  using (public.current_user_is_admin());

revoke all on public.whatsapp_automation_test_override_events
  from public, anon, authenticated, service_role;
grant select on public.whatsapp_automation_test_override_events
  to authenticated;

-- This helper intentionally answers only the operational layer. Environment
-- kill switches cannot safely live in SQL and are still required by every
-- Function caller before it reaches this gate.
create or replace function
  public.whatsapp_conversation_automation_operationally_enabled(
    p_conversation_id uuid,
    p_at timestamptz default clock_timestamp()
  )
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.conversations conversation
    join public.app_settings settings on settings.id
    where conversation.id = p_conversation_id
      and (
        settings.automations_enabled
        or coalesce(
          conversation.automation_test_override_until > p_at,
          false
        )
      )
  );
$$;

revoke execute on function
  public.whatsapp_conversation_automation_operationally_enabled(
    uuid, timestamptz
  ) from public, anon, authenticated;
grant execute on function
  public.whatsapp_conversation_automation_operationally_enabled(
    uuid, timestamptz
  ) to service_role;

comment on function
  public.whatsapp_conversation_automation_operationally_enabled(
    uuid, timestamptz
  ) is
  'Service-only live operational gate: global panel switch OR an unexpired conversation test override. It does not replace any backend or send-safety gate.';

create or replace function public.get_whatsapp_conversation_automation_state(
  p_conversation_id uuid
)
returns table (
  conversation_id uuid,
  global_automations_enabled boolean,
  test_override_active boolean,
  test_override_activated_at timestamptz,
  test_override_until timestamptz,
  effective_operational_enabled boolean,
  effective_automation_enabled boolean,
  automation_mode public.automation_mode,
  needs_human boolean,
  conversation_status public.conversation_status
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  read_at timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.current_user_is_active()
  then
    raise exception 'WHATSAPP_AUTOMATION_STATE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  return query
  select
    conversation.id,
    settings.automations_enabled,
    coalesce(conversation.automation_test_override_until > read_at, false),
    conversation.automation_test_override_activated_at,
    conversation.automation_test_override_until,
    (
      settings.automations_enabled
      or coalesce(
        conversation.automation_test_override_until > read_at,
        false
      )
    ),
    (
      settings.automations_enabled
      or coalesce(
        conversation.automation_test_override_until > read_at,
        false
      )
    )
      and conversation.status = 'open'
      and conversation.automation_mode = 'auto'
      and not conversation.needs_human,
    conversation.automation_mode,
    conversation.needs_human,
    conversation.status
  from public.conversations conversation
  join public.app_settings settings on settings.id
  where conversation.id = p_conversation_id;

  if not found then
    raise exception 'WHATSAPP_AUTOMATION_CONVERSATION_NOT_FOUND'
      using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function
  public.get_whatsapp_conversation_automation_state(uuid)
  from public, anon;
grant execute on function
  public.get_whatsapp_conversation_automation_state(uuid)
  to authenticated, service_role;

create or replace function
  public.activate_whatsapp_conversation_test_override(
    p_conversation_id uuid
  )
returns table (
  conversation_id uuid,
  global_automations_enabled boolean,
  test_override_active boolean,
  test_override_activated_at timestamptz,
  test_override_until timestamptz,
  effective_operational_enabled boolean,
  effective_automation_enabled boolean,
  automation_mode public.automation_mode,
  needs_human boolean,
  conversation_status public.conversation_status
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  conversation_row public.conversations%rowtype;
  activated_at_value timestamptz;
  until_value timestamptz;
  action_value text;
  actor_id uuid := auth.uid();
  activated_now timestamptz := clock_timestamp();
begin
  if not public.current_user_is_admin() then
    raise exception 'WHATSAPP_AUTOMATION_TEST_OVERRIDE_ADMIN_REQUIRED'
      using errcode = '42501';
  end if;

  select conversation.* into conversation_row
  from public.conversations conversation
  where conversation.id = p_conversation_id
  for update;
  if not found then
    raise exception 'WHATSAPP_AUTOMATION_CONVERSATION_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if conversation_row.automation_test_override_until > activated_now then
    action_value := 'extended';
    activated_at_value :=
      conversation_row.automation_test_override_activated_at;
  else
    action_value := 'activated';
    activated_at_value := activated_now;
  end if;
  until_value := activated_now + interval '24 hours';

  perform set_config(
    'app.whatsapp_automation_test_override_write', 'on', true
  );
  update public.conversations conversation
  set
    automation_test_override_activated_at = activated_at_value,
    automation_test_override_until = until_value,
    automation_test_override_activated_by = case
      when action_value = 'extended'
        then conversation.automation_test_override_activated_by
      else actor_id
    end
  where conversation.id = p_conversation_id;
  perform set_config(
    'app.whatsapp_automation_test_override_write', 'off', true
  );

  insert into public.whatsapp_automation_test_override_events (
    conversation_id,
    action,
    actor_user_id,
    occurred_at,
    effective_until
  ) values (
    p_conversation_id,
    action_value,
    actor_id,
    activated_now,
    until_value
  );

  insert into public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    metadata
  ) values (
    actor_id,
    'whatsapp.automation_test_override_' || action_value,
    'conversation',
    p_conversation_id,
    jsonb_build_object(
      'activated_at', activated_at_value,
      'until', until_value
    )
  );

  return query
  select *
  from public.get_whatsapp_conversation_automation_state(p_conversation_id);
end;
$$;

create or replace function
  public.deactivate_whatsapp_conversation_test_override(
    p_conversation_id uuid
  )
returns table (
  conversation_id uuid,
  global_automations_enabled boolean,
  test_override_active boolean,
  test_override_activated_at timestamptz,
  test_override_until timestamptz,
  effective_operational_enabled boolean,
  effective_automation_enabled boolean,
  automation_mode public.automation_mode,
  needs_human boolean,
  conversation_status public.conversation_status
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  conversation_row public.conversations%rowtype;
  actor_id uuid := auth.uid();
  revoked_now timestamptz := clock_timestamp();
begin
  if not public.current_user_is_admin() then
    raise exception 'WHATSAPP_AUTOMATION_TEST_OVERRIDE_ADMIN_REQUIRED'
      using errcode = '42501';
  end if;

  select conversation.* into conversation_row
  from public.conversations conversation
  where conversation.id = p_conversation_id
  for update;
  if not found then
    raise exception 'WHATSAPP_AUTOMATION_CONVERSATION_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if conversation_row.automation_test_override_until is not null then
    perform set_config(
      'app.whatsapp_automation_test_override_write', 'on', true
    );
    update public.conversations conversation
    set
      automation_test_override_activated_at = null,
      automation_test_override_until = null,
      automation_test_override_activated_by = null
    where conversation.id = p_conversation_id;
    perform set_config(
      'app.whatsapp_automation_test_override_write', 'off', true
    );

    insert into public.whatsapp_automation_test_override_events (
      conversation_id,
      action,
      actor_user_id,
      occurred_at,
      effective_until
    ) values (
      p_conversation_id,
      'revoked',
      actor_id,
      revoked_now,
      conversation_row.automation_test_override_until
    );

    insert into public.audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      metadata
    ) values (
      actor_id,
      'whatsapp.automation_test_override_revoked',
      'conversation',
      p_conversation_id,
      jsonb_build_object(
        'activated_at',
          conversation_row.automation_test_override_activated_at,
        'until', conversation_row.automation_test_override_until,
        'revoked_at', revoked_now
      )
    );
  end if;

  return query
  select *
  from public.get_whatsapp_conversation_automation_state(p_conversation_id);
end;
$$;

revoke execute on function
  public.activate_whatsapp_conversation_test_override(uuid)
  from public, anon, service_role;
revoke execute on function
  public.deactivate_whatsapp_conversation_test_override(uuid)
  from public, anon, service_role;
grant execute on function
  public.activate_whatsapp_conversation_test_override(uuid)
  to authenticated;
grant execute on function
  public.deactivate_whatsapp_conversation_test_override(uuid)
  to authenticated;

comment on function
  public.activate_whatsapp_conversation_test_override(uuid) is
  'ADMIN-only activation or extension of one conversation test window to 24 hours from the live database clock.';
comment on function
  public.deactivate_whatsapp_conversation_test_override(uuid) is
  'ADMIN-only, idempotent revocation of one conversation test window.';

-- Keep the v1 finalizer byte-for-byte compatible during rolling deploys: old
-- Functions require `pending` when they pass true. New Functions call this
-- additive v2, while the authoritative claim below safely terminalizes any v1
-- pending row that arrives after its operational authorization disappeared.
create or replace function
  public.finalize_whatsapp_inbound_webhook_with_operational_gate(
  p_message_id uuid,
  p_external_event_id text,
  p_should_run_automation boolean
)
returns public.whatsapp_automation_dispatches
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_conversation_id uuid;
  effective_should_run boolean;
begin
  select message.conversation_id into target_conversation_id
  from public.messages message
  where message.id = p_message_id;

  effective_should_run := p_should_run_automation
    and public.whatsapp_conversation_automation_operationally_enabled(
      target_conversation_id,
      clock_timestamp()
    );

  return public.finalize_whatsapp_inbound_webhook(
    p_message_id,
    p_external_event_id,
    effective_should_run
  );
end;
$$;

revoke execute on function
  public.finalize_whatsapp_inbound_webhook_with_operational_gate(
    uuid, text, boolean
  )
  from public, anon, authenticated;
grant execute on function
  public.finalize_whatsapp_inbound_webhook_with_operational_gate(
    uuid, text, boolean
  )
  to service_role;

-- A failed Function execution may ask the outbox to retry after an override
-- was revoked. Preserve the v1 failure algorithm, then atomically terminalize
-- both durable rows if its result became pending without live authorization.
alter function public.fail_whatsapp_automation_dispatch(
  uuid, uuid, text, boolean
)
  rename to fail_whatsapp_automation_dispatch_before_test_override;

create or replace function public.fail_whatsapp_automation_dispatch(
  p_id uuid,
  p_lease_token uuid,
  p_error text,
  p_retry boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  failed boolean;
  target_message_id uuid;
  target_conversation_id uuid;
  dispatch_status text;
  blocked_now timestamptz;
begin
  perform public.assert_whatsapp_automation_service_role();

  failed := public.fail_whatsapp_automation_dispatch_before_test_override(
    p_id,
    p_lease_token,
    p_error,
    p_retry
  );
  if not failed then
    return false;
  end if;

  select dispatch.message_id, dispatch.status, message.conversation_id
    into target_message_id, dispatch_status, target_conversation_id
  from public.whatsapp_automation_dispatches dispatch
  join public.messages message on message.id = dispatch.message_id
  where dispatch.id = p_id;

  if dispatch_status = 'pending'
    and not public.whatsapp_conversation_automation_operationally_enabled(
      target_conversation_id,
      clock_timestamp()
    )
  then
    blocked_now := clock_timestamp();
    update public.whatsapp_automation_executions execution
    set
      status = 'completed',
      retryable = false,
      outcome = jsonb_build_object(
        'processed', false,
        'blocked', true,
        'reason', 'AUTOMATIONS_DISABLED'
      ),
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      completed_at = blocked_now,
      failed_at = null,
      last_error = null
    where execution.message_id = target_message_id
      and execution.status <> 'completed';

    update public.whatsapp_automation_dispatches dispatch
    set
      status = 'completed',
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      completed_at = blocked_now,
      failed_at = null,
      completion_reason = 'skipped',
      last_error = null
    where dispatch.id = p_id
      and dispatch.status = 'pending';
  end if;

  return true;
end;
$$;

revoke execute on function
  public.fail_whatsapp_automation_dispatch_before_test_override(
    uuid, uuid, text, boolean
  ) from public, anon, authenticated, service_role;
revoke execute on function
  public.fail_whatsapp_automation_dispatch(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function
  public.fail_whatsapp_automation_dispatch(uuid, uuid, text, boolean)
  to service_role;

-- Manual requeue first reopens its durable execution and only then moves the
-- dispatch to pending. Gate it before that first mutation and reconcile both
-- rows if authorization expires in the narrow window between the two steps.
alter function public.requeue_whatsapp_automation_dispatch(uuid)
  rename to requeue_whatsapp_automation_dispatch_before_test_override;

create or replace function public.requeue_whatsapp_automation_dispatch(
  p_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_message_id uuid;
  target_conversation_id uuid;
  requeued boolean;
  dispatch_status text;
  blocked_now timestamptz;
begin
  perform public.assert_whatsapp_automation_service_role();

  select dispatch.message_id, message.conversation_id
    into target_message_id, target_conversation_id
  from public.whatsapp_automation_dispatches dispatch
  join public.messages message on message.id = dispatch.message_id
  where dispatch.id = p_id;

  if not found or not
    public.whatsapp_conversation_automation_operationally_enabled(
      target_conversation_id,
      clock_timestamp()
    )
  then
    return false;
  end if;

  requeued :=
    public.requeue_whatsapp_automation_dispatch_before_test_override(p_id);
  if not requeued then
    return false;
  end if;

  select dispatch.status into dispatch_status
  from public.whatsapp_automation_dispatches dispatch
  where dispatch.id = p_id;

  if dispatch_status <> 'pending'
    or not public.whatsapp_conversation_automation_operationally_enabled(
      target_conversation_id,
      clock_timestamp()
    )
  then
    blocked_now := clock_timestamp();
    update public.whatsapp_automation_executions execution
    set
      status = 'completed',
      retryable = false,
      outcome = jsonb_build_object(
        'processed', false,
        'blocked', true,
        'reason', 'AUTOMATIONS_DISABLED'
      ),
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      completed_at = blocked_now,
      failed_at = null,
      last_error = null
    where execution.message_id = target_message_id
      and execution.status <> 'completed';

    update public.whatsapp_automation_dispatches dispatch
    set
      status = 'completed',
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      completed_at = blocked_now,
      failed_at = null,
      completion_reason = 'skipped',
      last_error = null
    where dispatch.id = p_id
      and dispatch.status in ('pending', 'processing');
    return false;
  end if;

  return true;
end;
$$;

revoke execute on function
  public.requeue_whatsapp_automation_dispatch_before_test_override(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function
  public.requeue_whatsapp_automation_dispatch(uuid)
  from public, anon, authenticated;
grant execute on function
  public.requeue_whatsapp_automation_dispatch(uuid)
  to service_role;

-- The inbox "resume for last inbound" RPC predates the operational switch.
-- Preserve its authorization and idempotency semantics, but never report a
-- dispatch if authorization expires before the row is durably requeued.
create or replace function public.resume_whatsapp_automation_for_last_inbound(
  p_conversation_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  conversation_row public.conversations%rowtype;
  contact_row public.contacts%rowtype;
  message_row public.messages%rowtype;
  dispatch_row public.whatsapp_automation_dispatches%rowtype;
begin
  if auth.role() <> 'service_role' and not exists (
    select 1 from public.profiles where id = auth.uid() and active
  ) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select conversation.* into conversation_row
  from public.conversations conversation
  where conversation.id = p_conversation_id
  for update;
  if not found then
    raise exception 'CONVERSATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select contact.* into contact_row
  from public.contacts contact
  where contact.id = conversation_row.contact_id;
  if contact_row.whatsapp_consent_status = 'opted_out' then
    return 'CONTACT_OPTED_OUT';
  end if;

  update public.conversations conversation
  set
    automation_mode = 'auto',
    needs_human = false,
    priority = false,
    automation_pause_source = null,
    automation_pause_message_id = null
  where conversation.id = p_conversation_id;

  select message.* into message_row
  from public.messages message
  where message.conversation_id = p_conversation_id
    and message.direction = 'inbound'
  order by message.whatsapp_ingest_sequence desc
  limit 1;
  if not found then
    return 'RESUMED_WITHOUT_PENDING_MESSAGE';
  end if;

  if exists (
    select 1
    from public.messages message
    where message.conversation_id = p_conversation_id
      and message.direction = 'outbound'
      and message.whatsapp_ingest_sequence >
        message_row.whatsapp_ingest_sequence
  ) then
    return 'ALREADY_ANSWERED';
  end if;

  select dispatch.* into dispatch_row
  from public.whatsapp_automation_dispatches dispatch
  where dispatch.message_id = message_row.id
  for update;
  if not found then
    return 'RESUMED_WITHOUT_PENDING_MESSAGE';
  end if;

  if dispatch_row.status <> 'completed'
    or exists (
      select 1
      from public.whatsapp_automation_executions execution
      where execution.message_id = message_row.id
    )
  then
    return 'ALREADY_PROCESSED';
  end if;

  if not public.whatsapp_conversation_automation_operationally_enabled(
    p_conversation_id,
    clock_timestamp()
  ) then
    return 'AUTOMATIONS_DISABLED';
  end if;

  update public.whatsapp_automation_dispatches dispatch
  set
    status = 'pending',
    attempts = 0,
    available_at = clock_timestamp(),
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    completed_at = null,
    completion_reason = null,
    last_error = null
  where dispatch.id = dispatch_row.id
  returning dispatch.* into dispatch_row;

  if dispatch_row.status <> 'pending'
    or not public.whatsapp_conversation_automation_operationally_enabled(
      p_conversation_id,
      clock_timestamp()
    )
  then
    update public.whatsapp_automation_dispatches dispatch
    set
      status = 'completed',
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      completed_at = clock_timestamp(),
      failed_at = null,
      completion_reason = 'skipped',
      last_error = null
    where dispatch.id = dispatch_row.id
      and dispatch.status = 'pending';
    return 'AUTOMATIONS_DISABLED';
  end if;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(),
    'whatsapp.automation_resumed_for_last_inbound',
    'conversation',
    p_conversation_id,
    jsonb_build_object('message_id', message_row.id)
  );

  return 'DISPATCHED';
end;
$$;

revoke execute on function
  public.resume_whatsapp_automation_for_last_inbound(uuid)
  from public, anon;
grant execute on function
  public.resume_whatsapp_automation_for_last_inbound(uuid)
  to authenticated, service_role;

-- Recovery is evaluated with the same live gate as new claims. Pending and
-- expired leased rows that lost their operational authorization are terminally
-- skipped. Active leases are left to the execution/send gates below so another
-- worker cannot steal them, while the old worker still cannot send.
create or replace function public.claim_whatsapp_automation_dispatches(
  p_limit integer default 10
)
returns setof public.whatsapp_automation_dispatches
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim_now timestamptz := clock_timestamp();
begin
  perform public.assert_whatsapp_coexistence_service_role();

  update public.whatsapp_automation_executions execution
  set
    status = 'completed',
    retryable = false,
    outcome = jsonb_build_object(
      'processed', false,
      'blocked', true,
      'reason', 'AUTOMATIONS_DISABLED'
    ),
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    completed_at = claim_now,
    failed_at = null,
    last_error = null
  where execution.status <> 'completed'
    and exists (
      select 1
      from public.whatsapp_automation_dispatches dispatch
      join public.messages message on message.id = dispatch.message_id
      where dispatch.message_id = execution.message_id
        and (
          dispatch.status = 'pending'
          or (
            dispatch.status = 'processing'
            and dispatch.lease_expires_at <= claim_now
          )
        )
        and not public.whatsapp_conversation_automation_operationally_enabled(
          message.conversation_id,
          claim_now
        )
    );

  update public.whatsapp_automation_dispatches dispatch
  set
    status = 'completed',
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    completed_at = claim_now,
    failed_at = null,
    completion_reason = 'skipped',
    last_error = null
  from public.messages message
  where message.id = dispatch.message_id
    and (
      dispatch.status = 'pending'
      or (
        dispatch.status = 'processing'
        and dispatch.lease_expires_at <= claim_now
      )
    )
    and not public.whatsapp_conversation_automation_operationally_enabled(
      message.conversation_id,
      claim_now
    );

  update public.whatsapp_automation_dispatches dispatch
  set
    status = 'pending',
    available_at = claim_now,
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    last_error = coalesce(dispatch.last_error, 'STALE_LEASE_RECOVERED')
  from public.messages message
  where message.id = dispatch.message_id
    and dispatch.status = 'processing'
    and dispatch.lease_expires_at <= claim_now
    and public.whatsapp_conversation_automation_operationally_enabled(
      message.conversation_id,
      claim_now
    );

  update public.whatsapp_automation_dispatches dispatch
  set
    status = 'failed',
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    failed_at = claim_now,
    last_error = coalesce(dispatch.last_error, 'MAX_ATTEMPTS_EXCEEDED')
  where dispatch.status = 'pending'
    and dispatch.attempts >= dispatch.max_attempts;

  return query
  with candidates as (
    select dispatch.id
    from public.whatsapp_automation_dispatches dispatch
    join public.messages candidate_message
      on candidate_message.id = dispatch.message_id
    where dispatch.status = 'pending'
      and dispatch.available_at <= claim_now
      and dispatch.attempts < dispatch.max_attempts
      and public.whatsapp_conversation_automation_operationally_enabled(
        candidate_message.conversation_id,
        claim_now
      )
      and not exists (
        select 1
        from public.whatsapp_automation_dispatches earlier_dispatch
        join public.messages earlier_message
          on earlier_message.id = earlier_dispatch.message_id
        where earlier_message.conversation_id =
            candidate_message.conversation_id
          and earlier_message.whatsapp_ingest_sequence
            < candidate_message.whatsapp_ingest_sequence
          and earlier_dispatch.status in ('reserved', 'pending', 'processing')
      )
    order by dispatch.available_at, dispatch.created_at
    for update of dispatch skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 100))
  )
  update public.whatsapp_automation_dispatches dispatch
  set
    status = 'processing',
    attempts = dispatch.attempts + 1,
    processing_started_at = claim_now,
    lease_expires_at = claim_now + interval '15 minutes',
    lease_token = gen_random_uuid(),
    completed_at = null,
    failed_at = null,
    completion_reason = null
  from candidates, public.messages message
  where dispatch.id = candidates.id
    and message.id = dispatch.message_id
    and public.whatsapp_conversation_automation_operationally_enabled(
      message.conversation_id,
      clock_timestamp()
    )
  returning dispatch.*;
end;
$$;

revoke execute on function
  public.claim_whatsapp_automation_dispatches(integer)
  from public, anon, authenticated;
grant execute on function
  public.claim_whatsapp_automation_dispatches(integer)
  to service_role;

-- Direct/retry execution claims receive the same authoritative decision as the
-- outbox. Returning the existing `completed` disposition keeps old workers
-- rolling-deploy compatible and gives them a successful no-send terminal path.
alter function public.claim_whatsapp_automation_execution(uuid, jsonb, integer)
  rename to claim_whatsapp_automation_execution_before_test_override;

create or replace function public.claim_whatsapp_automation_execution(
  p_message_id uuid,
  p_request_snapshot jsonb,
  p_stale_after_seconds integer default 900
)
returns table (
  disposition text,
  lease_token uuid,
  attempts integer,
  snapshot_at timestamptz,
  message_snapshot jsonb,
  conversation_snapshot jsonb,
  contact_snapshot jsonb,
  settings_snapshot jsonb,
  session_state text,
  session_context jsonb,
  session_expires_at timestamptz,
  fresh_session boolean,
  outcome jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim_now timestamptz := clock_timestamp();
  target_conversation_id uuid;
  execution_row public.whatsapp_automation_executions%rowtype;
  claimed record;
  blocked_outcome jsonb := jsonb_build_object(
    'processed', false,
    'blocked', true,
    'reason', 'AUTOMATIONS_DISABLED'
  );
begin
  perform public.assert_whatsapp_automation_service_role();

  select message.conversation_id into target_conversation_id
  from public.messages message
  where message.id = p_message_id
    and message.direction = 'inbound';

  if found and not
    public.whatsapp_conversation_automation_operationally_enabled(
      target_conversation_id,
      claim_now
    )
  then
    perform pg_advisory_xact_lock(hashtextextended(p_message_id::text, 0));
    select execution.* into execution_row
    from public.whatsapp_automation_executions execution
    where execution.message_id = p_message_id
    for update;

    if found then
      if execution_row.request_snapshot <> p_request_snapshot then
        raise exception 'WHATSAPP_AUTOMATION_REQUEST_CONFLICT'
          using errcode = '23514';
      end if;

      if execution_row.status <> 'completed' then
        update public.whatsapp_automation_executions execution
        set
          status = 'completed',
          retryable = false,
          outcome = blocked_outcome,
          processing_started_at = null,
          lease_expires_at = null,
          lease_token = null,
          completed_at = claim_now,
          failed_at = null,
          last_error = null
        where execution.message_id = p_message_id
        returning execution.* into execution_row;
      end if;

      return query select
        'completed'::text,
        null::uuid,
        execution_row.attempts,
        execution_row.snapshot_at,
        execution_row.message_snapshot,
        execution_row.conversation_snapshot,
        execution_row.contact_snapshot,
        execution_row.settings_snapshot,
        execution_row.session_state,
        execution_row.session_context,
        execution_row.session_expires_at,
        execution_row.fresh_session,
        execution_row.outcome;
      return;
    end if;

    return query select
      'completed'::text,
      null::uuid,
      0,
      claim_now,
      '{}'::jsonb,
      '{}'::jsonb,
      '{}'::jsonb,
      '{}'::jsonb,
      'idle'::text,
      '{}'::jsonb,
      null::timestamptz,
      true,
      blocked_outcome;
    return;
  end if;

  select * into claimed
  from public.claim_whatsapp_automation_execution_before_test_override(
    p_message_id,
    p_request_snapshot,
    p_stale_after_seconds
  );

  if claimed.disposition = 'claimed'
    and not public.whatsapp_conversation_automation_operationally_enabled(
      (claimed.message_snapshot ->> 'conversation_id')::uuid,
      clock_timestamp()
    )
  then
    update public.whatsapp_automation_executions execution
    set
      status = 'completed',
      retryable = false,
      outcome = blocked_outcome,
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      completed_at = clock_timestamp(),
      failed_at = null,
      last_error = null
    where execution.message_id = p_message_id
      and execution.status = 'processing'
      and execution.lease_token = claimed.lease_token;

    claimed.disposition := 'completed';
    claimed.lease_token := null;
    claimed.outcome := blocked_outcome;
  end if;

  return query select
    claimed.disposition::text,
    claimed.lease_token::uuid,
    claimed.attempts::integer,
    claimed.snapshot_at::timestamptz,
    claimed.message_snapshot::jsonb,
    claimed.conversation_snapshot::jsonb,
    claimed.contact_snapshot::jsonb,
    claimed.settings_snapshot::jsonb,
    claimed.session_state::text,
    claimed.session_context::jsonb,
    claimed.session_expires_at::timestamptz,
    claimed.fresh_session::boolean,
    claimed.outcome::jsonb;
end;
$$;

revoke execute on function
  public.claim_whatsapp_automation_execution_before_test_override(
    uuid, jsonb, integer
  ) from public, anon, authenticated, service_role;
revoke execute on function
  public.claim_whatsapp_automation_execution(uuid, jsonb, integer)
  from public, anon, authenticated;
grant execute on function
  public.claim_whatsapp_automation_execution(uuid, jsonb, integer)
  to service_role;

-- All durable automation mutations commit through the effects ledger. Adding
-- the live operational check here rolls back the entire domain/session RPC if
-- an override expires or is revoked while its worker still owns a lease.
-- A terminal handoff remains allowed because it is a safety action, not an
-- automated reply or business mutation.
create or replace function
  public.guard_whatsapp_automation_effect_manual_pause()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  conversation_row public.conversations%rowtype;
begin
  select execution.* into execution_row
  from public.whatsapp_automation_executions execution
  where execution.message_id = new.execution_message_id;
  if not found then
    raise exception 'WHATSAPP_AUTOMATION_EXECUTION_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select conversation.* into conversation_row
  from public.conversations conversation
  where conversation.id = execution_row.conversation_id
  for update;
  if not found then
    raise exception 'WHATSAPP_AUTOMATION_CONVERSATION_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if execution_row.message_ingest_sequence <=
    conversation_row.automation_human_barrier_ingest_sequence
  then
    raise exception 'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_HUMAN_REPLY'
      using errcode = '55000';
  end if;

  if conversation_row.automation_mode = 'manual'
    and not (
      conversation_row.automation_pause_source = 'inbound_handoff'
      and conversation_row.automation_pause_message_id =
        new.execution_message_id
      and new.effect_type in (
        'session_write',
        'handoff',
        'appointment_deposit_process'
      )
    )
  then
    raise exception 'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL'
      using errcode = '55000';
  end if;

  if new.effect_type <> 'handoff'
    and not public.whatsapp_conversation_automation_operationally_enabled(
      conversation_row.id,
      clock_timestamp()
    )
  then
    raise exception 'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_OPERATIONAL'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

revoke execute on function
  public.guard_whatsapp_automation_effect_manual_pause()
  from public, anon, authenticated, service_role;

-- Live, service-only final gate for causal sends from whatsapp-automation.
-- It validates the execution lease and conversation safety before consulting
-- the operational exception. Account credentials, recipient resolution,
-- consent/customer-service policy, test-mode recipients and the environment
-- kill switch remain mandatory independent checks in the existing send path;
-- this RPC is called only after those checks and immediately before Graph.
create or replace function public.check_whatsapp_automation_send_eligibility(
  p_message_id uuid,
  p_lease_token uuid
)
returns table (
  eligible boolean,
  reason text,
  conversation_id uuid,
  global_automations_enabled boolean,
  test_override_active boolean,
  test_override_until timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  checked_at timestamptz := clock_timestamp();
  execution_row public.whatsapp_automation_executions%rowtype;
  conversation_row public.conversations%rowtype;
  settings_row public.app_settings%rowtype;
  sending_paused_value boolean := true;
  causal_handoff boolean := false;
  snapshot_mode text;
  snapshot_needs_human boolean;
begin
  perform public.assert_whatsapp_automation_service_role();

  eligible := false;
  reason := 'INVALID_CONTEXT';
  conversation_id := null;
  global_automations_enabled := false;
  test_override_active := false;
  test_override_until := null;

  if p_message_id is null or p_lease_token is null then
    return next;
    return;
  end if;

  select execution.* into execution_row
  from public.whatsapp_automation_executions execution
  where execution.message_id = p_message_id;
  if not found
    or execution_row.status <> 'processing'
    or execution_row.lease_token is distinct from p_lease_token
    or execution_row.lease_expires_at <= checked_at
  then
    reason := 'EXECUTION_LEASE_INVALID';
    return next;
    return;
  end if;

  conversation_id := execution_row.conversation_id;
  if not exists (
    select 1
    from public.messages message
    where message.id = p_message_id
      and message.direction = 'inbound'
      and message.conversation_id = execution_row.conversation_id
      and message.contact_id = execution_row.contact_id
  ) then
    reason := 'MESSAGE_CONTEXT_INVALID';
    return next;
    return;
  end if;

  select conversation.* into conversation_row
  from public.conversations conversation
  where conversation.id = execution_row.conversation_id
    and conversation.contact_id = execution_row.contact_id;
  if not found then
    reason := 'CONVERSATION_NOT_FOUND';
    return next;
    return;
  end if;

  select settings.* into settings_row
  from public.app_settings settings
  where settings.id;
  if found then
    global_automations_enabled := settings_row.automations_enabled;
  end if;
  test_override_until := conversation_row.automation_test_override_until;
  test_override_active := coalesce(
    test_override_until > checked_at,
    false
  );

  if conversation_row.status <> 'open' then
    reason := 'CONVERSATION_CLOSED';
    return next;
    return;
  end if;

  if execution_row.message_ingest_sequence <=
    conversation_row.automation_human_barrier_ingest_sequence
  then
    reason := 'HUMAN_REPLY_BARRIER';
    return next;
    return;
  end if;

  causal_handoff :=
    conversation_row.automation_pause_source = 'inbound_handoff'
    and conversation_row.automation_pause_message_id = p_message_id;
  snapshot_mode := execution_row.conversation_snapshot ->> 'automation_mode';
  snapshot_needs_human := coalesce(
    (execution_row.conversation_snapshot ->> 'needs_human')::boolean,
    false
  );

  -- Preserve the existing owner/inbound-review semantics when an execution was
  -- intentionally created from an already-manual snapshot. A new pause after
  -- an auto snapshot is authoritative unless owned by this exact handoff.
  if conversation_row.automation_mode = 'manual'
    and snapshot_mode = 'auto'
    and not causal_handoff
  then
    reason := 'AUTOMATION_PAUSED';
    return next;
    return;
  end if;
  if conversation_row.needs_human
    and not snapshot_needs_human
    and not causal_handoff
  then
    reason := 'AUTOMATION_PAUSED';
    return next;
    return;
  end if;

  select coalesce(settings.sending_paused, true)
    into sending_paused_value
  from public.whatsapp_settings settings
  where settings.id;
  if not found or sending_paused_value then
    reason := 'SENDING_PAUSED';
    return next;
    return;
  end if;

  -- Linearize the two mutable authorizations as late as possible. This second
  -- read catches a lease cancellation or an override expiry/revocation that
  -- committed while the earlier context and safety checks were running.
  checked_at := clock_timestamp();
  if not exists (
    select 1
    from public.whatsapp_automation_executions execution
    where execution.message_id = p_message_id
      and execution.status = 'processing'
      and execution.lease_token is not distinct from p_lease_token
      and execution.lease_expires_at > checked_at
  ) then
    reason := 'EXECUTION_LEASE_INVALID';
    return next;
    return;
  end if;

  select
    coalesce(settings.automations_enabled, false),
    conversation.automation_test_override_until
  into
    global_automations_enabled,
    test_override_until
  from public.conversations conversation
  left join public.app_settings settings on settings.id
  where conversation.id = conversation_id
    and conversation.contact_id = execution_row.contact_id;
  if not found then
    reason := 'CONVERSATION_NOT_FOUND';
    return next;
    return;
  end if;

  test_override_active := coalesce(
    test_override_until > checked_at,
    false
  );
  if not public.whatsapp_conversation_automation_operationally_enabled(
    conversation_id,
    checked_at
  ) then
    reason := 'AUTOMATIONS_DISABLED';
    return next;
    return;
  end if;

  eligible := true;
  reason := 'ELIGIBLE';
  return next;
end;
$$;

revoke execute on function
  public.check_whatsapp_automation_send_eligibility(uuid, uuid)
  from public, anon, authenticated;
grant execute on function
  public.check_whatsapp_automation_send_eligibility(uuid, uuid)
  to service_role;

comment on function
  public.check_whatsapp_automation_send_eligibility(uuid, uuid) is
  'Last live SQL gate for causal automation sends: current lease, conversation pause/barrier, sending pause, then global-or-test-override. Environment/test-recipient/account/consent gates remain mandatory afterward.';
