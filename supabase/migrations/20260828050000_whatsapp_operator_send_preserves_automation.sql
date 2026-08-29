-- A human reply and an explicit automation pause are separate actions.
-- Operator sends create a causal human-reply barrier in the same durable
-- INSERT transaction; the legacy trigger must never infer a persistent pause.
create or replace function public.sync_conversation_after_message()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.whatsapp_origin = 'history' then
    -- Historical messages contribute only to historical activity. They do not
    -- open a customer-service window, become unread, or alter automation.
    update public.conversations
    set last_message_at = greatest(last_message_at, new.created_at)
    where id = new.conversation_id;

    update public.contacts
    set last_message_at = greatest(
      coalesce(last_message_at, new.created_at),
      new.created_at
    )
    where id = new.contact_id;
    return new;
  end if;

  if new.whatsapp_origin in (
    'smb_message_echoes', 'meta_message_mutation'
  ) then
    -- Echoes have a dedicated causal-barrier path; mutations and echoes do not
    -- open a customer-service window or silently alter the preferred mode.
    update public.conversations
    set last_message_at = greatest(last_message_at, new.created_at)
    where id = new.conversation_id;

    update public.contacts
    set last_message_at = greatest(
      coalesce(last_message_at, new.created_at),
      new.created_at
    )
    where id = new.contact_id;
    return new;
  end if;

  -- Ordinary Cloud API messages update activity/window counters only.
  update public.conversations
  set
    last_message_at = greatest(last_message_at, new.created_at),
    last_inbound_message_at = case
      when new.direction = 'inbound' then greatest(
        coalesce(last_inbound_message_at, new.created_at),
        new.created_at
      )
      else last_inbound_message_at
    end,
    unread_count = case
      when new.direction = 'inbound' then unread_count + 1
      else unread_count
    end
  where id = new.conversation_id;

  update public.contacts
  set last_message_at = greatest(
    coalesce(last_message_at, new.created_at),
    new.created_at
  )
  where id = new.contact_id;

  return new;
end;
$$;

revoke execute on function public.sync_conversation_after_message()
  from public, anon, authenticated, service_role;

comment on function public.sync_conversation_after_message() is
  'Maintains message activity without changing the preferred automation mode.';

create or replace function public.stamp_whatsapp_operator_reply_barrier()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  operator_barrier bigint;
begin
  if new.direction = 'outbound'
    and new.sent_by is not null
    and new.whatsapp_origin = 'cloud_api'
    and (new.metadata ->> 'source') in (
      'operator',
      'operator_deposit_request',
      'operator_deposit_confirmation'
    )
  then
    -- This runs inside the INSERT transaction. A duplicate/failed reservation
    -- rolls the barrier back, and a failed -> pending retry is only an UPDATE,
    -- so it cannot claim newer inbound messages as another human reply.
    operator_barrier := public.mark_whatsapp_automation_human_reply(
      new.conversation_id,
      new.contact_id
    );
    new.metadata := new.metadata || jsonb_build_object(
      'human_reply_barrier_ingest_sequence', operator_barrier
    );
  end if;
  return new;
end;
$$;

drop trigger if exists zzzz_messages_stamp_whatsapp_operator_reply_barrier
  on public.messages;
create trigger zzzz_messages_stamp_whatsapp_operator_reply_barrier
  before insert on public.messages
  for each row execute function public.stamp_whatsapp_operator_reply_barrier();

revoke execute on function public.stamp_whatsapp_operator_reply_barrier()
  from public, anon, authenticated, service_role;

comment on function public.stamp_whatsapp_operator_reply_barrier() is
  'Atomically snapshots a human-reply barrier on the first durable operator reservation without pausing automation.';

-- Resolve an outbound address only inside the immutable Coexistence account
-- boundary. Imported app-state is authoritative. While contacts sync is not
-- available, a recent signed live inbound may authorize the protected wa_id
-- (or its account-scoped BSUID) for the same conversation.
create or replace function public.resolve_whatsapp_coexistence_recipient(
  p_account_id uuid,
  p_conversation_id uuid,
  p_contact_id uuid
)
returns table (
  recipient_value text,
  identity_kind text,
  identity_provenance text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  conversation_row public.conversations%rowtype;
  contact_row public.contacts%rowtype;
  mapping_row public.whatsapp_coexistence_contacts%rowtype;
  candidate_mapping public.whatsapp_coexistence_contacts%rowtype;
  active_mapping_count integer := 0;
  mapping_phone text;
  latest_inbound_user_id text;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if p_account_id is null
    or p_conversation_id is null
    or p_contact_id is null
  then
    raise exception 'WHATSAPP_RECIPIENT_CONTEXT_INVALID'
      using errcode = '22023';
  end if;

  select conversation.* into conversation_row
  from public.conversations conversation
  where conversation.id = p_conversation_id
    and conversation.contact_id = p_contact_id
    and conversation.coexistence_account_id = p_account_id;
  if not found then
    raise exception 'WHATSAPP_RECIPIENT_CONVERSATION_MISMATCH'
      using errcode = '55000';
  end if;

  select contact.* into contact_row
  from public.contacts contact
  where contact.id = p_contact_id;
  if not found then
    raise exception 'WHATSAPP_RECIPIENT_CONTACT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  for candidate_mapping in
    select mapping.*
    from public.whatsapp_coexistence_contacts mapping
    where mapping.account_id = p_account_id
      and mapping.contact_id = p_contact_id
      and mapping.app_state = 'active'
    order by mapping.id
  loop
    active_mapping_count := active_mapping_count + 1;
    mapping_row := candidate_mapping;
  end loop;
  if active_mapping_count > 1 then
    raise exception 'WHATSAPP_RECIPIENT_MAPPING_AMBIGUOUS'
      using errcode = '23505';
  end if;

  if active_mapping_count = 1 then
    mapping_phone := nullif(
      regexp_replace(coalesce(mapping_row.phone_e164, ''), '\D', '', 'g'),
      ''
    );
    if mapping_row.whatsapp_id is not null
      and mapping_phone is not null
      and mapping_row.whatsapp_id <> mapping_phone
    then
      raise exception 'WHATSAPP_RECIPIENT_MAPPING_CONFLICT'
        using errcode = '23505';
    end if;
    if contact_row.whatsapp_id is not null
      and coalesce(mapping_row.whatsapp_id, mapping_phone) is not null
      and contact_row.whatsapp_id <>
        coalesce(mapping_row.whatsapp_id, mapping_phone)
    then
      raise exception 'WHATSAPP_RECIPIENT_MAPPING_CONFLICT'
        using errcode = '23505';
    end if;
    if contact_row.whatsapp_user_id is not null
      and mapping_row.whatsapp_user_id is not null
      and contact_row.whatsapp_user_id <> mapping_row.whatsapp_user_id
    then
      raise exception 'WHATSAPP_RECIPIENT_MAPPING_CONFLICT'
        using errcode = '23505';
    end if;

    recipient_value := coalesce(mapping_row.whatsapp_id, mapping_phone);
    if recipient_value is not null then
      identity_kind := case
        when mapping_row.whatsapp_id is not null then 'wa_id'
        else 'phone'
      end;
      identity_provenance := 'coexistence_mapping';
      return next;
      return;
    end if;
    if mapping_row.whatsapp_user_id is not null then
      recipient_value := mapping_row.whatsapp_user_id;
      identity_kind := 'bsuid';
      identity_provenance := 'coexistence_mapping';
      return next;
      return;
    end if;
    raise exception 'WHATSAPP_RECIPIENT_MAPPING_INVALID'
      using errcode = '23514';
  end if;

  select nullif(trim(message.metadata ->> 'whatsapp_user_id'), '')
    into latest_inbound_user_id
  from public.messages message
  where message.conversation_id = p_conversation_id
    and message.contact_id = p_contact_id
    and message.coexistence_account_id = p_account_id
    and message.direction = 'inbound'
    and message.whatsapp_origin = 'cloud_api'
    and message.created_at >= clock_timestamp() - interval '24 hours'
  order by message.created_at desc, message.whatsapp_ingest_sequence desc
  limit 1;
  if not found then
    raise exception 'WHATSAPP_RECIPIENT_RECENT_IDENTITY_REQUIRED'
      using errcode = '55000';
  end if;
  if latest_inbound_user_id is not null
    and latest_inbound_user_id !~ '^[A-Za-z0-9.]{1,256}$'
  then
    raise exception 'WHATSAPP_RECIPIENT_RECENT_IDENTITY_INVALID'
      using errcode = '23514';
  end if;
  if latest_inbound_user_id is not null
    and contact_row.whatsapp_user_id is distinct from latest_inbound_user_id
  then
    raise exception 'WHATSAPP_RECIPIENT_RECENT_IDENTITY_CONFLICT'
      using errcode = '23505';
  end if;

  if contact_row.whatsapp_id ~ '^[1-9][0-9]{7,14}$' then
    recipient_value := contact_row.whatsapp_id;
    identity_kind := 'wa_id';
    identity_provenance := 'recent_inbound';
    return next;
    return;
  end if;
  if latest_inbound_user_id is not null then
    recipient_value := latest_inbound_user_id;
    identity_kind := 'bsuid';
    identity_provenance := 'recent_inbound';
    return next;
    return;
  end if;
  raise exception 'WHATSAPP_RECIPIENT_RECENT_IDENTITY_INVALID'
    using errcode = '55000';
end;
$$;

revoke execute on function public.resolve_whatsapp_coexistence_recipient(
  uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.resolve_whatsapp_coexistence_recipient(
  uuid, uuid, uuid
) to service_role;

comment on function public.resolve_whatsapp_coexistence_recipient(
  uuid, uuid, uuid
) is
  'Resolves a fail-closed account-scoped outbound identity from active Coexistence state or a recent signed live inbound.';
