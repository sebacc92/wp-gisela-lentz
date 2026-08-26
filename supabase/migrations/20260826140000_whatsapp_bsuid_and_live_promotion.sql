-- Current Meta payloads can identify a WhatsApp user only by business-scoped
-- user ID (BSUID). This migration adds the BSUID-aware state-sync path and the
-- two atomic barriers needed at the live/Coexistence boundary.

create or replace function public.ingest_whatsapp_coexistence_contact(
  p_account_id uuid,
  p_event_id uuid,
  p_lease_token uuid,
  p_action text,
  p_phone_e164 text,
  p_whatsapp_id text,
  p_whatsapp_user_id text,
  p_full_name text,
  p_source_timestamp timestamptz,
  p_metadata jsonb default '{}'::jsonb
)
returns public.contacts
language plpgsql
security definer
set search_path = public
as $$
declare
  current_event public.whatsapp_coexistence_events%rowtype;
  current_mapping public.whatsapp_coexistence_contacts%rowtype;
  candidate_mapping public.whatsapp_coexistence_contacts%rowtype;
  result public.contacts%rowtype;
  candidate_contact public.contacts%rowtype;
  clean_phone text := nullif(trim(coalesce(p_phone_e164, '')), '');
  clean_whatsapp_id text := nullif(
    regexp_replace(coalesce(p_whatsapp_id, ''), '\D', '', 'g'),
    ''
  );
  clean_user_id text := nullif(trim(coalesce(p_whatsapp_user_id, '')), '');
  clean_name text := nullif(left(trim(coalesce(p_full_name, '')), 120), '');
  source_at timestamptz := coalesce(p_source_timestamp, clock_timestamp());
begin
  current_event := public.require_whatsapp_coexistence_event_lease(
    p_event_id,
    p_lease_token
  );

  if current_event.account_id <> p_account_id
    or current_event.field <> 'smb_app_state_sync'
    or p_action not in ('add', 'remove')
    or (clean_phone is null and clean_user_id is null)
    or (
      clean_phone is not null
      and clean_phone !~ '^\+[1-9][0-9]{7,14}$'
    )
    or (
      clean_whatsapp_id is not null
      and clean_whatsapp_id !~ '^[0-9]{8,15}$'
    )
    or (
      clean_user_id is not null
      and (
        char_length(clean_user_id) not between 1 and 256
        or clean_user_id !~ '^[A-Za-z0-9.]+$'
      )
    )
    or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'WHATSAPP_COEXISTENCE_CONTACT_INVALID'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(identity_key, 812))
  from (
    select distinct identity_key
    from unnest(array[
      case when clean_phone is not null
        then p_account_id::text || ':phone:' || clean_phone end,
      case when clean_whatsapp_id is not null
        then p_account_id::text || ':wa:' || clean_whatsapp_id end,
      case when clean_user_id is not null
        then p_account_id::text || ':user:' || clean_user_id end
    ]) supplied(identity_key)
    where identity_key is not null
    order by identity_key
  ) locked_identity;

  for candidate_mapping in
    select mapping.*
    from public.whatsapp_coexistence_contacts mapping
    where mapping.account_id = p_account_id
      and (
        (clean_phone is not null and mapping.phone_e164 = clean_phone)
        or (
          clean_whatsapp_id is not null
          and mapping.whatsapp_id = clean_whatsapp_id
        )
        or (
          clean_user_id is not null
          and mapping.whatsapp_user_id = clean_user_id
        )
      )
    order by mapping.id
    for update
  loop
    if current_mapping.id is not null
      and current_mapping.id <> candidate_mapping.id then
      raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
        using errcode = '23505';
    end if;
    current_mapping := candidate_mapping;
  end loop;

  if current_mapping.id is not null and (
    source_at < current_mapping.source_timestamp
    or (
      source_at = current_mapping.source_timestamp
      and current_mapping.app_state = 'removed'
      and p_action = 'add'
    )
  ) then
    if current_mapping.contact_id is not null then
      select * into result
      from public.contacts
      where id = current_mapping.contact_id;
    end if;
    return result;
  end if;

  if p_action = 'add' then
    result := public.get_or_create_whatsapp_coexistence_contact(
      clean_phone,
      clean_whatsapp_id,
      clean_user_id,
      clean_name
    );
  else
    for candidate_contact in
      select contact.*
      from public.contacts contact
      where (
          (clean_phone is not null and contact.phone_e164 = clean_phone)
          or (
            clean_whatsapp_id is not null
            and contact.whatsapp_id = clean_whatsapp_id
          )
          or (
            clean_user_id is not null
            and contact.whatsapp_user_id = clean_user_id
          )
        )
      order by contact.id
      for update
    loop
      if result.id is not null and result.id <> candidate_contact.id then
        raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
          using errcode = '23505';
      end if;
      result := candidate_contact;
    end loop;
  end if;

  if current_mapping.id is not null then
    if (
      current_mapping.phone_e164 is not null
      and clean_phone is not null
      and current_mapping.phone_e164 <> clean_phone
    ) or (
      current_mapping.whatsapp_id is not null
      and clean_whatsapp_id is not null
      and current_mapping.whatsapp_id <> clean_whatsapp_id
    ) or (
      current_mapping.whatsapp_user_id is not null
      and clean_user_id is not null
      and current_mapping.whatsapp_user_id <> clean_user_id
    ) or (
      current_mapping.contact_id is not null
      and result.id is not null
      and current_mapping.contact_id <> result.id
    ) then
      raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
        using errcode = '23505';
    end if;

    update public.whatsapp_coexistence_contacts mapping
    set
      last_event_id = p_event_id,
      contact_id = coalesce(mapping.contact_id, result.id),
      whatsapp_id = coalesce(mapping.whatsapp_id, clean_whatsapp_id),
      whatsapp_user_id = coalesce(
        mapping.whatsapp_user_id,
        clean_user_id
      ),
      phone_e164 = coalesce(mapping.phone_e164, clean_phone),
      profile_name = coalesce(clean_name, mapping.profile_name),
      app_state = case when p_action = 'remove' then 'removed' else 'active' end,
      source_timestamp = source_at,
      metadata = mapping.metadata || coalesce(p_metadata, '{}'::jsonb)
    where mapping.id = current_mapping.id;
  else
    insert into public.whatsapp_coexistence_contacts (
      account_id,
      last_event_id,
      contact_id,
      whatsapp_id,
      whatsapp_user_id,
      phone_e164,
      profile_name,
      app_state,
      source_timestamp,
      metadata
    ) values (
      p_account_id,
      p_event_id,
      result.id,
      clean_whatsapp_id,
      clean_user_id,
      clean_phone,
      clean_name,
      case when p_action = 'remove' then 'removed' else 'active' end,
      source_at,
      coalesce(p_metadata, '{}'::jsonb)
    );
  end if;

  return result;
end;
$$;

-- Apply the manual-app barrier synchronously in the authenticated webhook
-- transaction. If the contact has not been imported yet, echo ingestion will
-- still create it in manual mode later.
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

  -- Creating the identity/open conversation here is intentional. A no-op for
  -- an unknown contact would leave a same-delivery live inbound free to create
  -- an auto conversation before the asynchronous echo consumer runs.
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
  set automation_mode = 'manual', needs_human = false
  where conversation.id = conversation_row.id
    and conversation.contact_id = contact_row.id
    and (
      conversation.automation_mode <> 'manual'
      or conversation.needs_human
    );
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

-- History may win the WAMID race by milliseconds. Promote that exact row to
-- a real live inbound transactionally, applying the side effects that the
-- original history INSERT deliberately suppressed exactly once.
create or replace function public.promote_whatsapp_history_message_to_live(
  p_whatsapp_message_id text,
  p_contact_id uuid,
  p_conversation_id uuid,
  p_message_type public.message_type,
  p_body text,
  p_message_at timestamptz,
  p_metadata jsonb default '{}'::jsonb
)
returns table (message_id uuid, promoted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_message public.messages%rowtype;
  clean_message_id text := trim(coalesce(p_whatsapp_message_id, ''));
  live_at timestamptz := coalesce(p_message_at, clock_timestamp());
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if char_length(clean_message_id) not between 8 and 240
    or p_contact_id is null
    or p_conversation_id is null
    or p_message_type is null
    or p_message_at is null
    or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'WHATSAPP_HISTORY_PROMOTION_INVALID'
      using errcode = '22023';
  end if;

  perform public.lock_whatsapp_message_wamid(clean_message_id);
  select message.* into current_message
  from public.messages message
  where message.whatsapp_message_id = clean_message_id
  for update;
  if not found then
    raise exception 'WHATSAPP_HISTORY_PROMOTION_MESSAGE_NOT_FOUND'
      using errcode = 'P0002';
  end if;
  if current_message.contact_id <> p_contact_id
    or current_message.direction <> 'inbound'
    or current_message.whatsapp_origin not in ('history', 'cloud_api') then
    raise exception 'WHATSAPP_HISTORY_PROMOTION_IDENTITY_CONFLICT'
      using errcode = '23514';
  end if;

  perform 1
  from public.conversations conversation
  where conversation.id = p_conversation_id
    and conversation.contact_id = p_contact_id
  for update;
  if not found
    or (
      current_message.whatsapp_origin = 'cloud_api'
      and current_message.conversation_id <> p_conversation_id
    ) then
    raise exception 'WHATSAPP_HISTORY_PROMOTION_CONVERSATION_INVALID'
      using errcode = '23514';
  end if;

  if current_message.whatsapp_origin = 'history' then
    update public.messages message
    set
      whatsapp_origin = 'cloud_api',
      conversation_id = p_conversation_id,
      type = p_message_type,
      whatsapp_message_type = coalesce(
        message.whatsapp_message_type,
        p_message_type::text
      ),
      body = coalesce(p_body, ''),
      status = 'delivered',
      created_at = live_at,
      metadata = message.metadata
        || coalesce(p_metadata, '{}'::jsonb)
        || jsonb_build_object(
          'whatsapp_origin', 'cloud_api',
          'promoted_from_history', true,
          'automation_dispatch_reserved', true,
          'live_received_at', live_at
        )
    where message.id = current_message.id;

    update public.conversations conversation
    set
      last_message_at = greatest(conversation.last_message_at, live_at),
      last_inbound_message_at = greatest(
        coalesce(conversation.last_inbound_message_at, live_at),
        live_at
      ),
      unread_count = conversation.unread_count + 1
    where conversation.id = p_conversation_id
      and conversation.contact_id = p_contact_id;
    if not found then
      raise exception 'WHATSAPP_HISTORY_PROMOTION_CONVERSATION_INVALID'
        using errcode = '23514';
    end if;

    update public.contacts contact
    set last_message_at = greatest(
      coalesce(contact.last_message_at, live_at),
      live_at
    )
    where contact.id = p_contact_id;

    insert into public.whatsapp_automation_dispatches (
      message_id,
      external_event_id,
      status
    ) values (
      current_message.id,
      clean_message_id,
      'reserved'
    )
    on conflict on constraint whatsapp_automation_dispatches_message_id_key
      do nothing;

    return query select current_message.id, true;
    return;
  end if;

  -- A webhook retry after a committed promotion must not replay unread/window
  -- effects. Ensure only the durable reservation still exists.
  insert into public.whatsapp_automation_dispatches (
    message_id,
    external_event_id,
    status
  ) values (
    current_message.id,
    clean_message_id,
    'reserved'
  )
  on conflict on constraint whatsapp_automation_dispatches_message_id_key
    do nothing;
  return query select current_message.id, false;
end;
$$;

revoke execute on function public.ingest_whatsapp_coexistence_contact(
  uuid, uuid, uuid, text, text, text, text, text, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.ingest_whatsapp_coexistence_contact(
  uuid, uuid, uuid, text, text, text, text, text, timestamptz, jsonb
) to service_role;

revoke execute on function public.pause_whatsapp_automation_for_app_echo(
  text, text
) from public, anon, authenticated;
grant execute on function public.pause_whatsapp_automation_for_app_echo(
  text, text
) to service_role;

revoke execute on function public.promote_whatsapp_history_message_to_live(
  text, uuid, uuid, public.message_type, text, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.promote_whatsapp_history_message_to_live(
  text, uuid, uuid, public.message_type, text, timestamptz, jsonb
) to service_role;
