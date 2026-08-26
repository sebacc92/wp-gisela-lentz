-- Causal ownership for manual automation pauses.
--
-- A WhatsApp Business App echo and an automation handoff can race in separate
-- transactions. The conversation row is the shared serialization point: each
-- pause records who owns it, and every durable automation effect checks that
-- ownership while holding the same row lock.

create type public.automation_pause_source as enum (
  'app_echo',
  'inbound_handoff',
  'operator',
  'system',
  'legacy_manual'
);

-- Materialize the legacy causal owner without issuing row-level UPDATEs.
--
-- A regular UPDATE would invoke set_conversations_updated_at and would be
-- visible through the existing supabase_realtime publication. A temporary
-- stored generated expression lets PostgreSQL initialize the new value during
-- the ALTER TABLE rewrite instead: row UPDATE triggers and logical row-change
-- events are not produced, and every pre-existing updated_at remains exact.
-- Dropping the expression immediately keeps the column writable for the
-- runtime ownership transitions installed below.
alter table public.conversations
  add column automation_pause_source public.automation_pause_source
    generated always as (
      case
        when automation_mode = 'manual' then
          'legacy_manual'::public.automation_pause_source
        else null::public.automation_pause_source
      end
    ) stored,
  add column automation_pause_message_id uuid;

alter table public.conversations
  alter column automation_pause_source drop expression;

alter table public.conversations
  add constraint conversations_automation_pause_context_check check (
    (
      automation_mode = 'auto'
      and automation_pause_source is null
      and automation_pause_message_id is null
    )
    or (
      automation_mode = 'manual'
      and automation_pause_source is not null
      and (
        (
          automation_pause_source = 'inbound_handoff'
          and automation_pause_message_id is not null
        )
        or (
          automation_pause_source <> 'inbound_handoff'
          and automation_pause_message_id is null
        )
      )
    )
  );

create index conversations_automation_pause_idx
  on public.conversations (
    automation_pause_source,
    automation_pause_message_id
  )
  where automation_mode = 'manual';

create or replace function public.normalize_conversation_automation_pause()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.automation_mode = 'auto' then
    new.automation_pause_source := null;
    new.automation_pause_message_id := null;
    return new;
  end if;

  -- Browser operators already have a narrow UPDATE grant for automation_mode.
  -- They cannot write these new columns directly, and the trigger gives their
  -- manual transition an unspoofable causal source.
  if coalesce(auth.role(), '') = 'authenticated' then
    new.automation_pause_source := 'operator';
    new.automation_pause_message_id := null;
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

create trigger a_conversations_normalize_automation_pause
  before insert or update on public.conversations
  for each row execute function public.normalize_conversation_automation_pause();

-- Apply the app ownership barrier synchronously in the authenticated webhook
-- transaction. Replays are no-ops once this exact causal state is present.
create or replace function public.pause_whatsapp_automation_for_app_echo(
  p_phone_e164 text,
  p_whatsapp_user_id text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_phone text := nullif(trim(coalesce(p_phone_e164, '')), '');
  clean_user_id text := nullif(trim(coalesce(p_whatsapp_user_id, '')), '');
  contact_row public.contacts%rowtype;
  conversation_row public.conversations%rowtype;
  updated_count integer := 0;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if (clean_phone is null and clean_user_id is null)
    or (
      clean_phone is not null
      and clean_phone !~ '^\+[1-9][0-9]{7,14}$'
    )
    or (
      clean_user_id is not null
      and (
        char_length(clean_user_id) not between 1 and 256
        or clean_user_id !~ '^[A-Za-z0-9.]+$'
      )
    ) then
    raise exception 'WHATSAPP_ECHO_IDENTITY_INVALID' using errcode = '22023';
  end if;

  contact_row := public.get_or_create_whatsapp_coexistence_contact(
    clean_phone,
    null,
    clean_user_id,
    'Paciente'
  );
  conversation_row := public.get_or_create_whatsapp_coexistence_conversation(
    contact_row.id,
    clock_timestamp()
  );

  update public.conversations conversation
  set
    automation_mode = 'manual',
    needs_human = false,
    automation_pause_source = 'app_echo',
    automation_pause_message_id = null
  where conversation.id = conversation_row.id
    and conversation.contact_id = contact_row.id
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

-- Claim a manual pause for one inbound automation execution. Only an auto
-- conversation or an idempotent replay by the same inbound message may be
-- changed; app/operator ownership is never overwritten by a late handoff.
create or replace function public.pause_whatsapp_automation_for_inbound_handoff(
  p_message_id uuid,
  p_priority boolean,
  p_current_flow text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  message_row public.messages%rowtype;
  conversation_row public.conversations%rowtype;
  clean_current_flow text := nullif(
    left(trim(coalesce(p_current_flow, '')), 120),
    ''
  );
begin
  perform public.assert_whatsapp_automation_service_role();
  if p_message_id is null or p_priority is null then
    raise exception 'WHATSAPP_AUTOMATION_INBOUND_HANDOFF_INVALID'
      using errcode = '22023';
  end if;

  select message.* into message_row
  from public.messages message
  where message.id = p_message_id
    and message.direction = 'inbound';
  if not found then
    raise exception 'WHATSAPP_AUTOMATION_INBOUND_MESSAGE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select conversation.* into conversation_row
  from public.conversations conversation
  where conversation.id = message_row.conversation_id
    and conversation.contact_id = message_row.contact_id
  for update;
  if not found then
    raise exception 'WHATSAPP_AUTOMATION_CONVERSATION_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if conversation_row.automation_mode = 'manual'
    and not (
      conversation_row.automation_pause_source = 'inbound_handoff'
      and conversation_row.automation_pause_message_id = p_message_id
    ) then
    return false;
  end if;

  update public.conversations conversation
  set
    automation_mode = 'manual',
    needs_human = true,
    priority = conversation.priority or p_priority,
    current_flow = coalesce(clean_current_flow, conversation.current_flow),
    automation_pause_source = 'inbound_handoff',
    automation_pause_message_id = p_message_id
  where conversation.id = conversation_row.id;

  return true;
end;
$$;

-- The ledger INSERT is the commit barrier for every automation mutation. All
-- domain RPCs insert their effect in the same transaction after changing the
-- domain row, so raising here rolls that prior mutation back atomically.
create or replace function public.guard_whatsapp_automation_effect_manual_pause()
returns trigger
language plpgsql
security definer
set search_path = public
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

  if conversation_row.automation_mode = 'manual'
    and not (
      conversation_row.automation_pause_source = 'inbound_handoff'
      and conversation_row.automation_pause_message_id = new.execution_message_id
      and new.effect_type in ('session_write', 'handoff')
    ) then
    raise exception 'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger a_whatsapp_automation_effects_manual_pause
  before insert on public.whatsapp_automation_effects
  for each row
  execute function public.guard_whatsapp_automation_effect_manual_pause();

-- Ingestion itself is a second durable source of the app-echo marker. The
-- metadata branch also covers a duplicate echo that enriches a history row.
create or replace function public.mark_whatsapp_app_echo_pause_after_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
      (
        tg_op = 'INSERT'
        and (
          new.whatsapp_origin = 'smb_message_echoes'
          or new.metadata ->> 'last_observed_origin' = 'smb_message_echoes'
        )
      )
      or (
        tg_op = 'UPDATE'
        and (
          (
            new.whatsapp_origin = 'smb_message_echoes'
            and old.whatsapp_origin is distinct from new.whatsapp_origin
          )
          or (
            new.metadata ->> 'last_observed_origin' = 'smb_message_echoes'
            and old.metadata ->> 'last_observed_origin'
              is distinct from new.metadata ->> 'last_observed_origin'
          )
        )
      )
    ) then
    update public.conversations conversation
    set
      automation_mode = 'manual',
      needs_human = false,
      automation_pause_source = 'app_echo',
      automation_pause_message_id = null
    where conversation.id = new.conversation_id
      and (
        conversation.automation_mode <> 'manual'
        or conversation.needs_human
        or conversation.automation_pause_source is distinct from 'app_echo'
        or conversation.automation_pause_message_id is not null
      );
  end if;
  return new;
end;
$$;

create trigger zz_messages_mark_whatsapp_app_echo_pause
  after insert or update of whatsapp_origin, metadata on public.messages
  for each row execute function public.mark_whatsapp_app_echo_pause_after_message();

-- Adding columns must not silently expand the browser UPDATE surface.
revoke update (automation_pause_source, automation_pause_message_id)
  on public.conversations from public, anon, authenticated;

revoke execute on function public.normalize_conversation_automation_pause()
  from public, anon, authenticated, service_role;
revoke execute on function public.guard_whatsapp_automation_effect_manual_pause()
  from public, anon, authenticated, service_role;
revoke execute on function public.mark_whatsapp_app_echo_pause_after_message()
  from public, anon, authenticated, service_role;

revoke execute on function public.pause_whatsapp_automation_for_app_echo(
  text, text
) from public, anon, authenticated;
grant execute on function public.pause_whatsapp_automation_for_app_echo(
  text, text
) to service_role;

revoke execute on function public.pause_whatsapp_automation_for_inbound_handoff(
  uuid, boolean, text
) from public, anon, authenticated;
grant execute on function public.pause_whatsapp_automation_for_inbound_handoff(
  uuid, boolean, text
) to service_role;
