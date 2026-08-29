-- PostgreSQL ARE repetition bounds stop at 255. Keep the 256-character BSUID
-- contract as a length check plus an unbounded allowlisted-character regex.
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

  select count(*)::integer into active_mapping_count
  from public.whatsapp_coexistence_contacts mapping
  where mapping.account_id = p_account_id
    and mapping.contact_id = p_contact_id
    and mapping.app_state = 'active';
  if active_mapping_count > 1 then
    raise exception 'WHATSAPP_RECIPIENT_MAPPING_AMBIGUOUS'
      using errcode = '23505';
  end if;

  if active_mapping_count = 1 then
    select mapping.* into strict mapping_row
    from public.whatsapp_coexistence_contacts mapping
    where mapping.account_id = p_account_id
      and mapping.contact_id = p_contact_id
      and mapping.app_state = 'active';

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
      if char_length(mapping_row.whatsapp_user_id) not between 1 and 256
        or mapping_row.whatsapp_user_id !~ '^[A-Za-z0-9.]+$'
      then
        raise exception 'WHATSAPP_RECIPIENT_MAPPING_INVALID'
          using errcode = '23514';
      end if;
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
    and (
      char_length(latest_inbound_user_id) not between 1 and 256
      or latest_inbound_user_id !~ '^[A-Za-z0-9.]+$'
    )
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
