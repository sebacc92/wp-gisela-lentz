-- An operator reply is not an instruction to disable the bot. Only an
-- authenticated browser action may claim the ordinary `operator` pause.
-- A human reply still creates a causal barrier for the inbound messages that
-- already existed, preventing the bot from racing that reply; later inbound
-- messages remain eligible because their ingest sequence is greater.
alter table public.conversations
  add column automation_human_barrier_ingest_sequence bigint
    not null default 0
    check (automation_human_barrier_ingest_sequence >= 0);

revoke update (automation_human_barrier_ingest_sequence)
  on public.conversations from public, anon, authenticated, service_role;

create or replace function public.normalize_conversation_automation_pause()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  implicit_human_reply boolean := false;
  latest_inbound_sequence bigint := 0;
begin
  if tg_op = 'UPDATE'
    and new.automation_human_barrier_ingest_sequence is distinct from
      old.automation_human_barrier_ingest_sequence
    and coalesce(
      current_setting('app.whatsapp_human_barrier_write', true),
      ''
    ) <> 'on'
  then
    raise exception 'WHATSAPP_HUMAN_REPLY_BARRIER_RPC_REQUIRED'
      using errcode = '42501';
  end if;

  if new.automation_mode = 'auto' then
    new.automation_pause_source := null;
    new.automation_pause_message_id := null;
    return new;
  end if;

  -- Only the actual auto -> manual transition represents the browser's pause
  -- action. Other authenticated edits on an already-manual conversation must
  -- not erase an inbound safety handoff or its causal message.
  if coalesce(auth.role(), '') = 'authenticated' then
    if tg_op = 'UPDATE' and old.automation_mode = 'manual' then
      new.automation_pause_source := old.automation_pause_source;
      new.automation_pause_message_id := old.automation_pause_message_id;
    else
      new.automation_pause_source := 'operator';
      new.automation_pause_message_id := null;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Older code paths infer a pause from a phone-app echo, a web operator
    -- send, or the generic outbound sent_by trigger. The last case can also
    -- try to clear needs_human on an existing safety handoff.
    implicit_human_reply :=
      new.automation_pause_source in ('app_echo', 'operator')
      or (
        old.automation_mode = 'auto'
        and new.automation_mode = 'manual'
        and new.automation_pause_source is null
        and not new.needs_human
      )
      or (
        old.automation_mode = 'manual'
        and old.needs_human
        and new.automation_mode = 'manual'
        and not new.needs_human
        and new.automation_pause_source is not distinct from
          old.automation_pause_source
        and new.automation_pause_message_id is not distinct from
          old.automation_pause_message_id
      );
  end if;

  if implicit_human_reply then
    select coalesce(max(message.whatsapp_ingest_sequence), 0)
      into latest_inbound_sequence
    from public.messages message
    where message.conversation_id = old.id
      and message.direction = 'inbound';

    new.automation_human_barrier_ingest_sequence := greatest(
      old.automation_human_barrier_ingest_sequence,
      latest_inbound_sequence
    );

    -- Preserve the exact preference and any existing safety handoff. Only the
    -- hidden causal barrier changes.
    new.automation_mode := old.automation_mode;
    new.needs_human := old.needs_human;
    new.automation_pause_source := old.automation_pause_source;
    new.automation_pause_message_id := old.automation_pause_message_id;
    return new;
  end if;

  if new.automation_pause_source is null then
    new.automation_pause_source := 'system';
  end if;

  if new.automation_pause_source = 'inbound_handoff' then
    if new.automation_pause_message_id is null then
      raise exception 'WHATSAPP_AUTOMATION_PAUSE_MESSAGE_REQUIRED'
        using errcode = '23514';
    end if;
  else
    new.automation_pause_message_id := null;
  end if;

  return new;
end;
$$;

create or replace function public.mark_whatsapp_automation_human_reply(
  p_conversation_id uuid,
  p_contact_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  conversation_row public.conversations%rowtype;
  latest_inbound_sequence bigint := 0;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if p_conversation_id is null or p_contact_id is null then
    raise exception 'WHATSAPP_HUMAN_REPLY_CONTEXT_INVALID'
      using errcode = '22023';
  end if;

  select conversation.* into conversation_row
  from public.conversations conversation
  where conversation.id = p_conversation_id
    and conversation.contact_id = p_contact_id
  for update;
  if not found then
    raise exception 'WHATSAPP_HUMAN_REPLY_CONVERSATION_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select coalesce(max(message.whatsapp_ingest_sequence), 0)
    into latest_inbound_sequence
  from public.messages message
  where message.conversation_id = p_conversation_id
    and message.direction = 'inbound';

  perform set_config('app.whatsapp_human_barrier_write', 'on', true);
  update public.conversations conversation
  set automation_human_barrier_ingest_sequence = greatest(
    conversation.automation_human_barrier_ingest_sequence,
    latest_inbound_sequence
  )
  where conversation.id = p_conversation_id
  returning conversation.automation_human_barrier_ingest_sequence
    into latest_inbound_sequence;
  perform set_config('app.whatsapp_human_barrier_write', 'off', true);

  return latest_inbound_sequence;
end;
$$;

-- Keep the webhook-facing account-scoped API, but change its durable meaning
-- from "pause forever" to "suppress automation through the latest inbound".
-- Identity locking and account ownership checks remain identical to the
-- Embedded Signup implementation.
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
  previous_barrier bigint := 0;
  current_barrier bigint := 0;
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

  previous_barrier :=
    conversation_row.automation_human_barrier_ingest_sequence;
  current_barrier := public.mark_whatsapp_automation_human_reply(
    conversation_row.id,
    contact_row.id
  );
  return case when current_barrier > previous_barrier then 1 else 0 end;
end;
$$;

-- The ledger insert is the commit barrier for automation mutations. Extend
-- the existing manual-pause guard so a human reply also blocks effects owned
-- by an older inbound, without changing the conversation's preferred mode.
create or replace function public.guard_whatsapp_automation_effect_manual_pause()
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

  if execution_row.message_ingest_sequence
      <= conversation_row.automation_human_barrier_ingest_sequence then
    raise exception 'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_HUMAN_REPLY'
      using errcode = '55000';
  end if;

  if conversation_row.automation_mode = 'manual'
    and not (
      conversation_row.automation_pause_source = 'inbound_handoff'
      and conversation_row.automation_pause_message_id =
        new.execution_message_id
      and new.effect_type in ('session_write', 'handoff')
    ) then
    raise exception 'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

revoke execute on function public.normalize_conversation_automation_pause()
  from public, anon, authenticated, service_role;

revoke execute on function public.mark_whatsapp_automation_human_reply(
  uuid, uuid
) from public, anon, authenticated;
grant execute on function public.mark_whatsapp_automation_human_reply(
  uuid, uuid
) to service_role;

comment on function public.normalize_conversation_automation_pause() is
  'Makes the explicit authenticated pause button authoritative; human replies create a causal barrier without silently changing automation_mode.';

comment on column public.conversations.automation_human_barrier_ingest_sequence
  is 'Highest inbound ingest sequence superseded by a human reply; later inbound messages remain eligible for automation.';

comment on function public.mark_whatsapp_automation_human_reply(uuid, uuid)
  is 'Records a service-authenticated causal reply barrier without changing the conversation automation preference.';
