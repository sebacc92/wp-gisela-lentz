-- Durable, message-keyed executions make whatsapp-automation safe when the
-- dispatch outbox invokes it at least once. The first claim freezes every
-- input used to choose a branch; retries reuse that snapshot and a ledger
-- makes appointment/session effects idempotent.

create table public.whatsapp_automation_executions (
  message_id uuid primary key
    references public.messages (id) on delete cascade,
  conversation_id uuid not null
    references public.conversations (id) on delete cascade,
  contact_id uuid not null
    references public.contacts (id) on delete cascade,
  message_created_at timestamptz not null,
  message_ingest_sequence bigint not null,
  status text not null default 'processing',
  attempts integer not null default 1,
  retryable boolean not null default true,
  request_snapshot jsonb not null,
  message_snapshot jsonb not null,
  conversation_snapshot jsonb not null,
  contact_snapshot jsonb not null,
  settings_snapshot jsonb not null,
  session_state text not null,
  session_context jsonb not null,
  session_expires_at timestamptz,
  fresh_session boolean not null,
  snapshot_at timestamptz not null default clock_timestamp(),
  processing_started_at timestamptz default clock_timestamp(),
  lease_expires_at timestamptz,
  lease_token uuid,
  outcome jsonb,
  completed_at timestamptz,
  failed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_automation_execution_status_check check (
    status in ('processing', 'completed', 'failed')
  ),
  constraint whatsapp_automation_execution_attempts_check check (
    attempts between 1 and 100
  ),
  constraint whatsapp_automation_execution_request_object check (
    jsonb_typeof(request_snapshot) = 'object'
  ),
  constraint whatsapp_automation_execution_message_object check (
    jsonb_typeof(message_snapshot) = 'object'
  ),
  constraint whatsapp_automation_execution_conversation_object check (
    jsonb_typeof(conversation_snapshot) = 'object'
  ),
  constraint whatsapp_automation_execution_contact_object check (
    jsonb_typeof(contact_snapshot) = 'object'
  ),
  constraint whatsapp_automation_execution_settings_object check (
    jsonb_typeof(settings_snapshot) = 'object'
  ),
  constraint whatsapp_automation_execution_session_context_object check (
    jsonb_typeof(session_context) = 'object'
  ),
  constraint whatsapp_automation_execution_outcome_object check (
    outcome is null or jsonb_typeof(outcome) = 'object'
  ),
  constraint whatsapp_automation_execution_lifecycle_check check (
    (
      status = 'processing'
      and processing_started_at is not null
      and lease_expires_at is not null
      and lease_token is not null
      and completed_at is null
      and failed_at is null
    )
    or (
      status = 'completed'
      and processing_started_at is null
      and lease_expires_at is null
      and lease_token is null
      and outcome is not null
      and completed_at is not null
      and failed_at is null
    )
    or (
      status = 'failed'
      and processing_started_at is null
      and lease_expires_at is null
      and lease_token is null
      and completed_at is null
      and failed_at is not null
    )
  )
);

create index whatsapp_automation_executions_retry_idx
  on public.whatsapp_automation_executions (failed_at, created_at)
  where status = 'failed' and retryable;
create index whatsapp_automation_executions_stale_idx
  on public.whatsapp_automation_executions (lease_expires_at)
  where status = 'processing';
create unique index whatsapp_automation_one_open_execution_per_conversation_idx
  on public.whatsapp_automation_executions (conversation_id)
  where status <> 'completed';

create trigger set_whatsapp_automation_executions_updated_at
  before update on public.whatsapp_automation_executions
  for each row execute function public.set_updated_at();

create table public.whatsapp_automation_effects (
  execution_message_id uuid not null
    references public.whatsapp_automation_executions (message_id)
    on delete cascade,
  effect_key text not null,
  effect_type text not null,
  request jsonb not null,
  result jsonb not null,
  appointment_id uuid
    references public.appointments (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (execution_message_id, effect_key),
  constraint whatsapp_automation_effect_key_check check (
    char_length(trim(effect_key)) between 1 and 120
  ),
  constraint whatsapp_automation_effect_type_check check (
    effect_type in (
      'appointment_create',
      'appointment_reschedule',
      'appointment_cancel',
      'session_write',
      'decision',
      'profile_update',
      'handoff'
    )
  ),
  constraint whatsapp_automation_effect_request_object check (
    jsonb_typeof(request) = 'object'
  ),
  constraint whatsapp_automation_effect_result_object check (
    jsonb_typeof(result) = 'object'
  )
);

create index whatsapp_automation_effects_appointment_idx
  on public.whatsapp_automation_effects (appointment_id)
  where appointment_id is not null;

alter table public.automation_sessions
  add column last_automation_message_id uuid,
  add column last_automation_ingest_sequence bigint,
  add column last_automation_session_sequence integer,
  add constraint automation_sessions_execution_marker_check check (
    (
      last_automation_message_id is null
      and last_automation_ingest_sequence is null
      and last_automation_session_sequence is null
    )
    or (
      last_automation_message_id is not null
      and last_automation_ingest_sequence is not null
      and last_automation_ingest_sequence > 0
      and last_automation_session_sequence between 0 and 100
    )
  );

alter table public.whatsapp_automation_executions enable row level security;
alter table public.whatsapp_automation_effects enable row level security;

revoke all on public.whatsapp_automation_executions
  from public, anon, authenticated;
revoke all on public.whatsapp_automation_effects
  from public, anon, authenticated;
grant all on public.whatsapp_automation_executions to service_role;
grant all on public.whatsapp_automation_effects to service_role;

create or replace function public.assert_whatsapp_automation_service_role()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'WHATSAPP_AUTOMATION_SERVICE_ROLE_REQUIRED'
      using errcode = '42501';
  end if;
end;
$$;

create or replace function public.require_whatsapp_automation_execution(
  p_message_id uuid,
  p_lease_token uuid
)
returns public.whatsapp_automation_executions
language plpgsql
security definer
set search_path = public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
begin
  perform public.assert_whatsapp_automation_service_role();

  select execution.* into execution_row
  from public.whatsapp_automation_executions execution
  where execution.message_id = p_message_id
  for update;

  if not found
    or execution_row.status <> 'processing'
    or execution_row.lease_token is distinct from p_lease_token
    or execution_row.lease_expires_at <= clock_timestamp() then
    raise exception 'WHATSAPP_AUTOMATION_EXECUTION_LEASE_INVALID'
      using errcode = '55000';
  end if;
  return execution_row;
end;
$$;

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
set search_path = public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  message_row public.messages%rowtype;
  conversation_row public.conversations%rowtype;
  contact_row public.contacts%rowtype;
  session_row public.automation_sessions%rowtype;
  effective_session_state text;
  effective_session_context jsonb;
  effective_session_expires_at timestamptz;
  is_fresh_session boolean;
  claim_now timestamptz := clock_timestamp();
  stale_seconds integer := greatest(
    60,
    least(coalesce(p_stale_after_seconds, 900), 3600)
  );
begin
  perform public.assert_whatsapp_automation_service_role();
  if p_message_id is null
    or jsonb_typeof(coalesce(p_request_snapshot, 'null'::jsonb)) <> 'object'
  then
    raise exception 'WHATSAPP_AUTOMATION_CLAIM_INVALID'
      using errcode = '22023';
  end if;

  -- Serialize both the first snapshot and any stale-lease takeover by inbound
  -- message. The execution row does not exist yet on the first invocation.
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

    if execution_row.status = 'completed' then
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

    if execution_row.status = 'processing'
      and execution_row.lease_expires_at > claim_now then
      return query select
        'busy'::text,
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
        null::jsonb;
      return;
    end if;

    if execution_row.status = 'failed' and not execution_row.retryable then
      return query select
        'terminal'::text,
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

    if execution_row.attempts >= 100 then
      raise exception 'WHATSAPP_AUTOMATION_ATTEMPTS_EXHAUSTED'
        using errcode = '54000';
    end if;

    update public.whatsapp_automation_executions execution
    set
      status = 'processing',
      attempts = execution.attempts + 1,
      processing_started_at = claim_now,
      lease_expires_at = claim_now + make_interval(secs => stale_seconds),
      lease_token = gen_random_uuid(),
      completed_at = null,
      failed_at = null,
      last_error = null
    where execution.message_id = p_message_id
    returning execution.* into execution_row;

    return query select
      'claimed'::text,
      execution_row.lease_token,
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
      null::jsonb;
    return;
  end if;

  select message.* into message_row
  from public.messages message
  where message.id = p_message_id
    and message.direction = 'inbound';
  if not found then
    raise exception 'WHATSAPP_AUTOMATION_INBOUND_MESSAGE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select conversation.* into strict conversation_row
  from public.conversations conversation
  where conversation.id = message_row.conversation_id;
  select contact.* into strict contact_row
  from public.contacts contact
  where contact.id = message_row.contact_id
    and contact.id = conversation_row.contact_id;

  -- A worker may claim a later dispatch before an earlier worker finishes.
  -- Refuse to snapshot out of order: only the smallest still-actionable ingest
  -- sequence in the conversation may start an execution.
  if exists (
    select 1
    from public.whatsapp_automation_dispatches dispatch
    join public.messages earlier_message
      on earlier_message.id = dispatch.message_id
    where earlier_message.conversation_id = conversation_row.id
      and earlier_message.whatsapp_ingest_sequence
        < message_row.whatsapp_ingest_sequence
      and dispatch.status in ('reserved', 'pending', 'processing')
  ) then
    return query select
      'busy'::text,
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
      null::jsonb;
    return;
  end if;

  if exists (
    select 1
    from public.whatsapp_automation_executions blocker
    where blocker.conversation_id = conversation_row.id
      and blocker.message_id <> p_message_id
      and blocker.status <> 'completed'
  ) then
    return query select
      'busy'::text,
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
      null::jsonb;
    return;
  end if;

  select session.* into session_row
  from public.automation_sessions session
  where session.conversation_id = conversation_row.id;
  is_fresh_session := not found
    or (
      session_row.expires_at is not null
      and session_row.expires_at < claim_now
    );
  effective_session_state := case
    when is_fresh_session then 'idle'
    else session_row.state
  end;
  effective_session_context := case
    when is_fresh_session then '{}'::jsonb
    else session_row.context
  end;
  effective_session_expires_at := case
    when is_fresh_session then null
    else session_row.expires_at
  end;

  insert into public.whatsapp_automation_executions (
    message_id,
    conversation_id,
    contact_id,
    message_created_at,
    message_ingest_sequence,
    status,
    attempts,
    retryable,
    request_snapshot,
    message_snapshot,
    conversation_snapshot,
    contact_snapshot,
    settings_snapshot,
    session_state,
    session_context,
    session_expires_at,
    fresh_session,
    snapshot_at,
    processing_started_at,
    lease_expires_at,
    lease_token
  ) values (
    message_row.id,
    conversation_row.id,
    contact_row.id,
    message_row.created_at,
    message_row.whatsapp_ingest_sequence,
    'processing',
    1,
    true,
    p_request_snapshot,
    jsonb_build_object(
      'id', message_row.id,
      'conversation_id', message_row.conversation_id,
      'contact_id', message_row.contact_id,
      'body', message_row.body,
      'direction', message_row.direction,
      'metadata', message_row.metadata,
      'whatsapp_ingest_sequence', message_row.whatsapp_ingest_sequence
    ),
    jsonb_build_object(
      'id', conversation_row.id,
      'contact_id', conversation_row.contact_id,
      'last_inbound_message_at', conversation_row.last_inbound_message_at,
      'automation_mode', conversation_row.automation_mode,
      'needs_human', conversation_row.needs_human,
      'priority', conversation_row.priority
    ),
    jsonb_build_object(
      'id', contact_row.id,
      'phone_e164', contact_row.phone_e164,
      'whatsapp_id', contact_row.whatsapp_id,
      'whatsapp_user_id', contact_row.whatsapp_user_id,
      'name', contact_row.name,
      'coverage', contact_row.coverage,
      'is_existing_patient', contact_row.is_existing_patient,
      'alternate_phone_e164', contact_row.alternate_phone_e164
    ),
    coalesce(
      (select to_jsonb(settings) from public.app_settings settings where id),
      '{}'::jsonb
    ),
    effective_session_state,
    effective_session_context,
    effective_session_expires_at,
    is_fresh_session,
    claim_now,
    claim_now,
    claim_now + make_interval(secs => stale_seconds),
    gen_random_uuid()
  )
  returning * into execution_row;

  return query select
    'claimed'::text,
    execution_row.lease_token,
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
    null::jsonb;
end;
$$;

create or replace function public.complete_whatsapp_automation_execution(
  p_message_id uuid,
  p_lease_token uuid,
  p_outcome jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  completed_outcome jsonb;
begin
  perform public.assert_whatsapp_automation_service_role();
  if jsonb_typeof(coalesce(p_outcome, 'null'::jsonb)) <> 'object' then
    raise exception 'WHATSAPP_AUTOMATION_OUTCOME_INVALID'
      using errcode = '22023';
  end if;

  update public.whatsapp_automation_executions execution
  set
    status = 'completed',
    retryable = false,
    outcome = p_outcome,
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    completed_at = clock_timestamp(),
    failed_at = null,
    last_error = null
  where execution.message_id = p_message_id
    and execution.status = 'processing'
    and execution.lease_token = p_lease_token;
  if found then return true; end if;

  select execution.outcome into completed_outcome
  from public.whatsapp_automation_executions execution
  where execution.message_id = p_message_id
    and execution.status = 'completed';
  if found and completed_outcome = p_outcome then return true; end if;
  return false;
end;
$$;

create or replace function public.fail_whatsapp_automation_execution(
  p_message_id uuid,
  p_lease_token uuid,
  p_error text,
  p_retryable boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  dispatch_max_attempts integer;
  terminal_failure boolean;
begin
  perform public.assert_whatsapp_automation_service_role();
  if nullif(trim(coalesce(p_error, '')), '') is null then
    raise exception 'WHATSAPP_AUTOMATION_FAILURE_INVALID'
      using errcode = '22023';
  end if;
  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );
  select dispatch.max_attempts into dispatch_max_attempts
  from public.whatsapp_automation_dispatches dispatch
  where dispatch.message_id = p_message_id;
  terminal_failure := not coalesce(p_retryable, true)
    or execution_row.attempts >= coalesce(dispatch_max_attempts, 8);

  if terminal_failure then
    -- Never leave a failed execution blocking its conversation forever after
    -- the outbox exhausts the same attempt budget. Safe terminal behavior is
    -- a durable human handoff; no later inbound is auto-processed from an
    -- uncertain session state.
    update public.conversations conversation
    set automation_mode = 'manual', needs_human = true
    where conversation.id = execution_row.conversation_id;

    insert into public.automation_sessions (
      conversation_id,
      state,
      context,
      expires_at,
      last_automation_message_id,
      last_automation_ingest_sequence,
      last_automation_session_sequence
    ) values (
      execution_row.conversation_id,
      'human_handoff',
      jsonb_build_object('reason', 'AUTOMATION_RETRIES_EXHAUSTED'),
      clock_timestamp() + interval '30 days',
      p_message_id,
      execution_row.message_ingest_sequence,
      100
    )
    on conflict (conversation_id) do update
    set
      state = 'human_handoff',
      context = automation_sessions.context || jsonb_build_object(
        'reason', 'AUTOMATION_RETRIES_EXHAUSTED'
      ),
      expires_at = excluded.expires_at,
      last_automation_message_id = excluded.last_automation_message_id,
      last_automation_ingest_sequence = excluded.last_automation_ingest_sequence,
      last_automation_session_sequence = excluded.last_automation_session_sequence
    where automation_sessions.last_automation_ingest_sequence is null
      or automation_sessions.last_automation_ingest_sequence
        <= excluded.last_automation_ingest_sequence;
  end if;

  update public.whatsapp_automation_executions execution
  set
    status = case when terminal_failure then 'completed' else 'failed' end,
    retryable = not terminal_failure,
    outcome = case
      when terminal_failure then jsonb_build_object(
        'processed', false,
        'blocked', true,
        'state', 'human_handoff',
        'reason', 'AUTOMATION_RETRIES_EXHAUSTED'
      )
      else null
    end,
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    completed_at = case when terminal_failure then clock_timestamp() else null end,
    failed_at = case when terminal_failure then null else clock_timestamp() end,
    last_error = left(trim(p_error), 2000)
  where execution.message_id = p_message_id
    and execution.status = 'processing'
    and execution.lease_token = p_lease_token;
  return found;
end;
$$;

create or replace function public.terminalize_failed_whatsapp_automation_dispatch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  message_row public.messages%rowtype;
begin
  if new.status <> 'failed' or old.status = 'failed' then return new; end if;

  select message.* into message_row
  from public.messages message
  where message.id = new.message_id;
  if not found then return new; end if;

  -- Dispatch attempts are the authoritative at-least-once budget. They may be
  -- consumed before execution claim (busy/DB timeout), so terminalize here,
  -- not only from execution.attempts.
  update public.conversations conversation
  set automation_mode = 'manual', needs_human = true
  where conversation.id = message_row.conversation_id;

  update public.whatsapp_automation_executions execution
  set
    status = 'completed',
    retryable = false,
    outcome = jsonb_build_object(
      'processed', false,
      'blocked', true,
      'state', 'human_handoff',
      'reason', 'AUTOMATION_DISPATCH_EXHAUSTED'
    ),
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    completed_at = clock_timestamp(),
    failed_at = null,
    last_error = coalesce(
      left(nullif(trim(new.last_error), ''), 2000),
      execution.last_error,
      'AUTOMATION_DISPATCH_EXHAUSTED'
    )
  where execution.message_id = new.message_id
    and execution.status <> 'completed';

  insert into public.automation_sessions (
    conversation_id,
    state,
    context,
    expires_at,
    last_automation_message_id,
    last_automation_ingest_sequence,
    last_automation_session_sequence
  ) values (
    message_row.conversation_id,
    'human_handoff',
    jsonb_build_object('reason', 'AUTOMATION_DISPATCH_EXHAUSTED'),
    clock_timestamp() + interval '30 days',
    message_row.id,
    message_row.whatsapp_ingest_sequence,
    100
  )
  on conflict (conversation_id) do update
  set
    state = 'human_handoff',
    context = automation_sessions.context || jsonb_build_object(
      'reason', 'AUTOMATION_DISPATCH_EXHAUSTED'
    ),
    expires_at = excluded.expires_at,
    last_automation_message_id = excluded.last_automation_message_id,
    last_automation_ingest_sequence = excluded.last_automation_ingest_sequence,
    last_automation_session_sequence = excluded.last_automation_session_sequence
  where automation_sessions.last_automation_ingest_sequence is null
    or automation_sessions.last_automation_ingest_sequence
      <= excluded.last_automation_ingest_sequence;
  return new;
end;
$$;

create trigger whatsapp_automation_dispatch_failure_handoff
  after update of status on public.whatsapp_automation_dispatches
  for each row
  when (new.status = 'failed' and old.status is distinct from new.status)
  execute function public.terminalize_failed_whatsapp_automation_dispatch();

-- The original dispatch requeue predates durable executions. Dispatch
-- exhaustion terminalizes an existing execution as completed/handoff, so
-- merely reviving the outbox row would make the next invocation a no-op.
-- Reopen only the two system-generated exhaustion outcomes; a successful
-- completed execution must remain immutable.
create or replace function public.requeue_whatsapp_automation_dispatch(
  p_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  dispatch_row public.whatsapp_automation_dispatches%rowtype;
  execution_row public.whatsapp_automation_executions%rowtype;
  terminal_reason text;
begin
  perform public.assert_whatsapp_automation_service_role();

  select dispatch.* into dispatch_row
  from public.whatsapp_automation_dispatches dispatch
  where dispatch.id = p_id
    and dispatch.status = 'failed'
  for update;
  if not found then
    return false;
  end if;

  select execution.* into execution_row
  from public.whatsapp_automation_executions execution
  where execution.message_id = dispatch_row.message_id
  for update;

  if found then
    terminal_reason := execution_row.outcome ->> 'reason';
    if execution_row.status <> 'completed'
      or terminal_reason is null
      or terminal_reason not in (
        'AUTOMATION_RETRIES_EXHAUSTED',
        'AUTOMATION_DISPATCH_EXHAUSTED'
      ) then
      return false;
    end if;

    -- The partial unique index permits one actionable execution per
    -- conversation. Refuse an unsafe reopen while newer work is still open.
    if exists (
      select 1
      from public.whatsapp_automation_executions blocker
      where blocker.conversation_id = execution_row.conversation_id
        and blocker.message_id <> execution_row.message_id
        and blocker.status <> 'completed'
    ) then
      return false;
    end if;

    update public.whatsapp_automation_executions execution
    set
      status = 'failed',
      attempts = least(execution.attempts, 99),
      retryable = true,
      outcome = null,
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      completed_at = null,
      failed_at = clock_timestamp(),
      last_error = left(
        'MANUAL_REQUEUE_AFTER_' || terminal_reason,
        2000
      )
    where execution.message_id = dispatch_row.message_id;
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
    failed_at = null,
    completion_reason = null,
    last_error = null
  where dispatch.id = dispatch_row.id;
  return true;
end;
$$;

-- Claim at most the earliest actionable inbound per conversation. This keeps
-- a later message from burning retry budget merely because an earlier worker
-- still owns the conversation state it needs to snapshot.
create or replace function public.claim_whatsapp_automation_dispatches(
  p_limit integer default 10
)
returns setof public.whatsapp_automation_dispatches
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_whatsapp_coexistence_service_role();

  update public.whatsapp_automation_dispatches dispatch
  set
    status = 'pending',
    available_at = clock_timestamp(),
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    last_error = coalesce(dispatch.last_error, 'STALE_LEASE_RECOVERED')
  where dispatch.status = 'processing'
    and dispatch.lease_expires_at <= clock_timestamp();

  update public.whatsapp_automation_dispatches dispatch
  set
    status = 'failed',
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    failed_at = clock_timestamp(),
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
      and dispatch.available_at <= clock_timestamp()
      and dispatch.attempts < dispatch.max_attempts
      and not exists (
        select 1
        from public.whatsapp_automation_dispatches earlier_dispatch
        join public.messages earlier_message
          on earlier_message.id = earlier_dispatch.message_id
        where earlier_message.conversation_id = candidate_message.conversation_id
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
    processing_started_at = clock_timestamp(),
    lease_expires_at = clock_timestamp() + interval '15 minutes',
    lease_token = gen_random_uuid(),
    completed_at = null,
    failed_at = null
  from candidates
  where dispatch.id = candidates.id
  returning dispatch.*;
end;
$$;

create or replace function public.save_whatsapp_automation_session(
  p_message_id uuid,
  p_lease_token uuid,
  p_sequence integer,
  p_state text,
  p_context jsonb,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  existing_effect public.whatsapp_automation_effects%rowtype;
  session_row public.automation_sessions%rowtype;
  effect_key_value text;
  request_value jsonb;
  should_apply boolean := false;
begin
  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );
  if p_sequence not between 0 and 100
    or nullif(trim(coalesce(p_state, '')), '') is null
    or jsonb_typeof(coalesce(p_context, 'null'::jsonb)) <> 'object'
  then
    raise exception 'WHATSAPP_AUTOMATION_SESSION_WRITE_INVALID'
      using errcode = '22023';
  end if;

  effect_key_value := 'session:' || p_sequence::text;
  request_value := jsonb_build_object(
    'state', trim(p_state),
    'context', p_context,
    'expires_at', p_expires_at
  );
  select effect.* into existing_effect
  from public.whatsapp_automation_effects effect
  where effect.execution_message_id = p_message_id
    and effect.effect_key = effect_key_value;
  if found then
    if existing_effect.effect_type <> 'session_write'
      or existing_effect.request <> request_value then
      raise exception 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT'
        using errcode = '23514';
    end if;
    return coalesce((existing_effect.result ->> 'applied')::boolean, false);
  end if;

  select session.* into session_row
  from public.automation_sessions session
  where session.conversation_id = execution_row.conversation_id
  for update;
  if not found then
    insert into public.automation_sessions (
      conversation_id,
      state,
      context,
      expires_at,
      last_automation_message_id,
      last_automation_ingest_sequence,
      last_automation_session_sequence
    ) values (
      execution_row.conversation_id,
      trim(p_state),
      p_context,
      p_expires_at,
      p_message_id,
      execution_row.message_ingest_sequence,
      p_sequence
    );
    should_apply := true;
  else
    should_apply := session_row.last_automation_message_id is null
      or execution_row.message_ingest_sequence
        > session_row.last_automation_ingest_sequence
      or (
        p_message_id = session_row.last_automation_message_id
        and p_sequence >= session_row.last_automation_session_sequence
      );
    if should_apply then
      update public.automation_sessions session
      set
        state = trim(p_state),
        context = p_context,
        expires_at = p_expires_at,
        last_automation_message_id = p_message_id,
        last_automation_ingest_sequence = execution_row.message_ingest_sequence,
        last_automation_session_sequence = p_sequence
      where session.conversation_id = execution_row.conversation_id;
    end if;
  end if;

  insert into public.whatsapp_automation_effects (
    execution_message_id,
    effect_key,
    effect_type,
    request,
    result
  ) values (
    p_message_id,
    effect_key_value,
    'session_write',
    request_value,
    jsonb_build_object('applied', should_apply)
  );
  return should_apply;
end;
$$;

create or replace function public.remember_whatsapp_automation_decision(
  p_message_id uuid,
  p_lease_token uuid,
  p_sequence integer,
  p_key text,
  p_value jsonb
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
    or p_value is null
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
  if found then
    if existing_effect.effect_type <> 'decision'
      or existing_effect.request <> request_value then
      raise exception 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT'
        using errcode = '23514';
    end if;
    return existing_effect.result -> 'value';
  end if;

  insert into public.whatsapp_automation_effects (
    execution_message_id,
    effect_key,
    effect_type,
    request,
    result
  ) values (
    p_message_id,
    effect_key_value,
    'decision',
    request_value,
    jsonb_build_object('value', p_value)
  );
  return p_value;
end;
$$;

create or replace function public.apply_whatsapp_automation_profile(
  p_message_id uuid,
  p_lease_token uuid,
  p_updates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  existing_effect public.whatsapp_automation_effects%rowtype;
  contact_row public.contacts%rowtype;
  result_value jsonb;
begin
  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );
  if jsonb_typeof(coalesce(p_updates, 'null'::jsonb)) <> 'object'
    or p_updates = '{}'::jsonb
    or p_updates - 'name' - 'is_existing_patient' - 'coverage'
      - 'alternate_phone_e164' <> '{}'::jsonb
    or (
      p_updates ? 'name'
      and (
        jsonb_typeof(p_updates -> 'name') <> 'string'
        or char_length(trim(p_updates ->> 'name')) not between 1 and 120
      )
    )
    or (
      p_updates ? 'is_existing_patient'
      and jsonb_typeof(p_updates -> 'is_existing_patient') <> 'boolean'
    )
    or (
      p_updates ? 'coverage'
      and coalesce(p_updates ->> 'coverage', '') not in ('ioma', 'particular')
    )
    or (
      p_updates ? 'alternate_phone_e164'
      and coalesce(p_updates ->> 'alternate_phone_e164', '')
        !~ '^\+[1-9][0-9]{7,14}$'
    )
  then
    raise exception 'WHATSAPP_AUTOMATION_PROFILE_UPDATE_INVALID'
      using errcode = '22023';
  end if;

  select effect.* into existing_effect
  from public.whatsapp_automation_effects effect
  where effect.execution_message_id = p_message_id
    and effect.effect_key = 'contact:profile';
  if found then
    if existing_effect.effect_type <> 'profile_update'
      or existing_effect.request <> p_updates then
      raise exception 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT'
        using errcode = '23514';
    end if;
    return existing_effect.result;
  end if;

  update public.contacts contact
  set
    name = case when p_updates ? 'name'
      then trim(p_updates ->> 'name') else contact.name end,
    is_existing_patient = case when p_updates ? 'is_existing_patient'
      then (p_updates ->> 'is_existing_patient')::boolean
      else contact.is_existing_patient end,
    coverage = case when p_updates ? 'coverage'
      then (p_updates ->> 'coverage')::public.patient_coverage
      else contact.coverage end,
    alternate_phone_e164 = case when p_updates ? 'alternate_phone_e164'
      then p_updates ->> 'alternate_phone_e164'
      else contact.alternate_phone_e164 end
  where contact.id = execution_row.contact_id
  returning * into contact_row;
  if not found then
    raise exception 'CONTACT_NOT_FOUND' using errcode = 'P0002';
  end if;

  result_value := jsonb_build_object(
    'id', contact_row.id,
    'phone_e164', contact_row.phone_e164,
    'whatsapp_id', contact_row.whatsapp_id,
    'whatsapp_user_id', contact_row.whatsapp_user_id,
    'name', contact_row.name,
    'coverage', contact_row.coverage,
    'is_existing_patient', contact_row.is_existing_patient,
    'alternate_phone_e164', contact_row.alternate_phone_e164
  );
  insert into public.whatsapp_automation_effects (
    execution_message_id,
    effect_key,
    effect_type,
    request,
    result
  ) values (
    p_message_id,
    'contact:profile',
    'profile_update',
    p_updates,
    result_value
  );
  return result_value;
end;
$$;

create or replace function public.handoff_whatsapp_automation_execution(
  p_message_id uuid,
  p_lease_token uuid,
  p_reason text,
  p_appointment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  existing_effect public.whatsapp_automation_effects%rowtype;
  request_value jsonb;
  outcome_value jsonb;
begin
  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );
  if char_length(trim(coalesce(p_reason, ''))) not between 1 and 200
    or p_appointment_id is null then
    raise exception 'WHATSAPP_AUTOMATION_HANDOFF_INVALID'
      using errcode = '22023';
  end if;

  request_value := jsonb_build_object(
    'appointment_id', p_appointment_id,
    'reason', left(trim(p_reason), 200)
  );

  select effect.* into existing_effect
  from public.whatsapp_automation_effects effect
  where effect.execution_message_id = p_message_id
    and effect.effect_key = 'terminal:handoff';
  if found then
    if existing_effect.request is distinct from request_value then
      raise exception 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT'
        using errcode = '23514';
    end if;
    return existing_effect.result;
  end if;

  if not exists (
    select 1
    from public.whatsapp_automation_effects domain_effect
    where domain_effect.execution_message_id = p_message_id
      and domain_effect.effect_type in (
        'appointment_create',
        'appointment_reschedule',
        'appointment_cancel'
      )
      and domain_effect.appointment_id = p_appointment_id
      and coalesce(domain_effect.result ->> 'effect_status', '') <> 'rejected'
  ) then
    raise exception 'WHATSAPP_AUTOMATION_COMMITTED_EFFECT_NOT_FOUND'
      using errcode = '55000';
  end if;

  update public.conversations conversation
  set automation_mode = 'manual', needs_human = true
  where conversation.id = execution_row.conversation_id;
  if not found then
    raise exception 'CONVERSATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.automation_sessions (
    conversation_id,
    state,
    context,
    expires_at,
    last_automation_message_id,
    last_automation_ingest_sequence,
    last_automation_session_sequence
  ) values (
    execution_row.conversation_id,
    'human_handoff',
    jsonb_build_object(
      'appointmentId', p_appointment_id,
      'reason', left(trim(p_reason), 200)
    ),
    clock_timestamp() + interval '30 days',
    p_message_id,
    execution_row.message_ingest_sequence,
    100
  )
  on conflict (conversation_id) do update
  set
    state = 'human_handoff',
    context = jsonb_build_object(
      'appointmentId', p_appointment_id,
      'reason', left(trim(p_reason), 200)
    ),
    expires_at = excluded.expires_at,
    last_automation_message_id = excluded.last_automation_message_id,
    last_automation_ingest_sequence = excluded.last_automation_ingest_sequence,
    last_automation_session_sequence = excluded.last_automation_session_sequence
  where automation_sessions.last_automation_ingest_sequence is null
    or automation_sessions.last_automation_ingest_sequence
      <= excluded.last_automation_ingest_sequence;

  outcome_value := jsonb_build_object(
    'processed', true,
    'state', 'human_handoff',
    'reason', left(trim(p_reason), 200),
    'appointmentId', p_appointment_id
  );
  insert into public.whatsapp_automation_effects (
    execution_message_id,
    effect_key,
    effect_type,
    request,
    result,
    appointment_id
  ) values (
    p_message_id,
    'terminal:handoff',
    'handoff',
    request_value,
    outcome_value,
    p_appointment_id
  );
  return outcome_value;
end;
$$;

create or replace function public.create_whatsapp_automation_appointment(
  p_message_id uuid,
  p_lease_token uuid,
  p_contact_id uuid,
  p_professional_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  existing_effect public.whatsapp_automation_effects%rowtype;
  appointment_row public.appointments%rowtype;
  request_value jsonb;
  result_value jsonb;
begin
  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );
  if execution_row.contact_id <> p_contact_id then
    raise exception 'WHATSAPP_AUTOMATION_CONTACT_MISMATCH'
      using errcode = '23514';
  end if;
  request_value := jsonb_build_object(
    'contact_id', p_contact_id,
    'professional_id', p_professional_id,
    'service_id', p_service_id,
    'starts_at', p_starts_at
  );

  select effect.* into existing_effect
  from public.whatsapp_automation_effects effect
  where effect.execution_message_id = p_message_id
    and effect.effect_key = 'appointment:create';
  if found then
    if existing_effect.effect_type <> 'appointment_create'
      or existing_effect.request <> request_value then
      raise exception 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT'
        using errcode = '23514';
    end if;
    return existing_effect.result;
  end if;

  begin
    appointment_row := public.create_service_appointment(
      p_contact_id,
      p_professional_id,
      p_service_id,
      p_starts_at,
      'whatsapp'::public.appointment_source,
      null
    );
    result_value := to_jsonb(appointment_row);
  exception when raise_exception then
    if sqlerrm = 'SLOT_UNAVAILABLE' then
      -- Expected business outcomes also belong in the ledger. Otherwise a
      -- later retry could take a different branch and reuse send sequence 0
      -- for a different payload.
      result_value := jsonb_build_object(
        'effect_status', 'rejected',
        'error_code', 'SLOT_UNAVAILABLE'
      );
    else
      raise;
    end if;
  end;
  insert into public.whatsapp_automation_effects (
    execution_message_id,
    effect_key,
    effect_type,
    request,
    result,
    appointment_id
  ) values (
    p_message_id,
    'appointment:create',
    'appointment_create',
    request_value,
    result_value,
    case
      when result_value ->> 'effect_status' = 'rejected' then null
      else appointment_row.id
    end
  );
  return result_value;
end;
$$;

create or replace function public.reschedule_whatsapp_automation_appointment(
  p_message_id uuid,
  p_lease_token uuid,
  p_appointment_id uuid,
  p_starts_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  existing_effect public.whatsapp_automation_effects%rowtype;
  appointment_row public.appointments%rowtype;
  request_value jsonb;
  result_value jsonb;
begin
  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );
  request_value := jsonb_build_object(
    'appointment_id', p_appointment_id,
    'starts_at', p_starts_at
  );

  select effect.* into existing_effect
  from public.whatsapp_automation_effects effect
  where effect.execution_message_id = p_message_id
    and effect.effect_key = 'appointment:reschedule';
  if found then
    if existing_effect.effect_type <> 'appointment_reschedule'
      or existing_effect.request <> request_value then
      raise exception 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT'
        using errcode = '23514';
    end if;
    return existing_effect.result;
  end if;

  if not exists (
    select 1 from public.appointments appointment
    where appointment.id = p_appointment_id
      and appointment.contact_id = execution_row.contact_id
  ) then
    result_value := jsonb_build_object(
      'effect_status', 'rejected',
      'error_code', 'APPOINTMENT_NOT_FOUND'
    );
  else
    begin
      appointment_row := public.reschedule_service_appointment(
        p_appointment_id,
        p_starts_at
      );
      result_value := to_jsonb(appointment_row);
    exception when raise_exception or no_data_found then
      if sqlerrm in ('SLOT_UNAVAILABLE', 'APPOINTMENT_NOT_FOUND') then
        result_value := jsonb_build_object(
          'effect_status', 'rejected',
          'error_code', sqlerrm
        );
      else
        raise;
      end if;
    end;
  end if;
  insert into public.whatsapp_automation_effects (
    execution_message_id,
    effect_key,
    effect_type,
    request,
    result,
    appointment_id
  ) values (
    p_message_id,
    'appointment:reschedule',
    'appointment_reschedule',
    request_value,
    result_value,
    case
      when result_value ->> 'effect_status' = 'rejected' then null
      else appointment_row.id
    end
  );
  return result_value;
end;
$$;

create or replace function public.cancel_whatsapp_automation_appointment(
  p_message_id uuid,
  p_lease_token uuid,
  p_appointment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  existing_effect public.whatsapp_automation_effects%rowtype;
  appointment_row public.appointments%rowtype;
  request_value jsonb;
  result_value jsonb;
begin
  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );
  request_value := jsonb_build_object('appointment_id', p_appointment_id);

  select effect.* into existing_effect
  from public.whatsapp_automation_effects effect
  where effect.execution_message_id = p_message_id
    and effect.effect_key = 'appointment:cancel';
  if found then
    if existing_effect.effect_type <> 'appointment_cancel'
      or existing_effect.request <> request_value then
      raise exception 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT'
        using errcode = '23514';
    end if;
    return existing_effect.result;
  end if;

  if not exists (
    select 1 from public.appointments appointment
    where appointment.id = p_appointment_id
      and appointment.contact_id = execution_row.contact_id
  ) then
    result_value := jsonb_build_object(
      'effect_status', 'rejected',
      'error_code', 'APPOINTMENT_NOT_FOUND'
    );
  else
    begin
      appointment_row := public.update_appointment_status(
        p_appointment_id,
        'cancelled'::public.appointment_status
      );
      result_value := to_jsonb(appointment_row);
    exception when raise_exception or no_data_found then
      if sqlerrm in ('APPOINTMENT_NOT_FOUND', 'INVALID_STATUS_TRANSITION') then
        result_value := jsonb_build_object(
          'effect_status', 'rejected',
          'error_code', 'APPOINTMENT_NOT_FOUND'
        );
      else
        raise;
      end if;
    end;
  end if;
  insert into public.whatsapp_automation_effects (
    execution_message_id,
    effect_key,
    effect_type,
    request,
    result,
    appointment_id
  ) values (
    p_message_id,
    'appointment:cancel',
    'appointment_cancel',
    request_value,
    result_value,
    case
      when result_value ->> 'effect_status' = 'rejected' then null
      else appointment_row.id
    end
  );
  return result_value;
end;
$$;

-- Internal helpers are reachable only from the security-definer RPCs above.
revoke execute on function public.assert_whatsapp_automation_service_role()
  from public, anon, authenticated, service_role;
revoke execute on function public.require_whatsapp_automation_execution(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.terminalize_failed_whatsapp_automation_dispatch()
  from public, anon, authenticated, service_role;

revoke execute on function public.claim_whatsapp_automation_dispatches(integer)
  from public, anon, authenticated;
grant execute on function public.claim_whatsapp_automation_dispatches(integer)
  to service_role;
revoke execute on function public.requeue_whatsapp_automation_dispatch(uuid)
  from public, anon, authenticated;
grant execute on function public.requeue_whatsapp_automation_dispatch(uuid)
  to service_role;

revoke execute on function public.claim_whatsapp_automation_execution(uuid, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.claim_whatsapp_automation_execution(uuid, jsonb, integer)
  to service_role;
revoke execute on function public.complete_whatsapp_automation_execution(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_whatsapp_automation_execution(uuid, uuid, jsonb)
  to service_role;
revoke execute on function public.fail_whatsapp_automation_execution(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.fail_whatsapp_automation_execution(uuid, uuid, text, boolean)
  to service_role;
revoke execute on function public.save_whatsapp_automation_session(uuid, uuid, integer, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.save_whatsapp_automation_session(uuid, uuid, integer, text, jsonb, timestamptz)
  to service_role;
revoke execute on function public.remember_whatsapp_automation_decision(uuid, uuid, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.remember_whatsapp_automation_decision(uuid, uuid, integer, text, jsonb)
  to service_role;
revoke execute on function public.apply_whatsapp_automation_profile(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_whatsapp_automation_profile(uuid, uuid, jsonb)
  to service_role;
revoke execute on function public.handoff_whatsapp_automation_execution(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.handoff_whatsapp_automation_execution(uuid, uuid, text, uuid)
  to service_role;
revoke execute on function public.create_whatsapp_automation_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_whatsapp_automation_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz)
  to service_role;
revoke execute on function public.reschedule_whatsapp_automation_appointment(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reschedule_whatsapp_automation_appointment(uuid, uuid, uuid, timestamptz)
  to service_role;
revoke execute on function public.cancel_whatsapp_automation_appointment(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_whatsapp_automation_appointment(uuid, uuid, uuid)
  to service_role;
