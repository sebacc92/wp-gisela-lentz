-- WhatsApp policy controls are deliberately fail-closed.  Edge Functions still
-- perform friendly preflight checks, but this migration is the final authority
-- before an outbound message can be reserved in `messages`.

alter table public.contacts
  add column whatsapp_consent_status text not null default 'unknown',
  add constraint contacts_whatsapp_consent_status_check
    check (whatsapp_consent_status in ('unknown', 'opted_in', 'opted_out'));

alter table public.messages
  add column idempotency_key text;

update public.messages
set idempotency_key = 'legacy:' || id::text
where direction = 'outbound' and idempotency_key is null;

alter table public.messages
  add constraint messages_outbound_idempotency_required check (
    direction = 'inbound'
    or (
      idempotency_key is not null
      and char_length(idempotency_key) between 8 and 200
    )
  );

create unique index messages_idempotency_key_idx
  on public.messages (idempotency_key)
  where idempotency_key is not null;

alter table public.reminders
  add column processing_started_at timestamptz;

alter table public.message_templates
  add column meta_template_id text,
  add column meta_status text not null default 'UNVERIFIED',
  add column quality_rating text,
  add column last_synced_at timestamptz,
  add constraint message_templates_meta_status_check check (
    meta_status in (
      'UNVERIFIED', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'
    )
  ),
  add constraint message_templates_quality_rating_check check (
    quality_rating is null
    or quality_rating in ('GREEN', 'YELLOW', 'RED', 'UNKNOWN')
  );

create unique index message_templates_meta_template_id_idx
  on public.message_templates (meta_template_id)
  where meta_template_id is not null;

alter table public.whatsapp_settings
  add column quality_rating text not null default 'UNKNOWN',
  add column quality_updated_at timestamptz,
  add column sending_paused boolean not null default false,
  add column sending_pause_reason text,
  add column policy_version text not null default '2026-08-10',
  add column policy_reviewed_at timestamptz not null default now(),
  add constraint whatsapp_settings_quality_rating_check check (
    quality_rating in ('GREEN', 'YELLOW', 'RED', 'UNKNOWN')
  ),
  add constraint whatsapp_settings_pause_reason_check check (
    not sending_paused or nullif(trim(sending_pause_reason), '') is not null
  );

create table public.whatsapp_consent_events (
  id uuid primary key default gen_random_uuid(),
  sequence_number bigint generated always as identity unique,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  decision text not null check (decision in ('opt_in', 'opt_out')),
  purpose text not null check (
    purpose in ('appointment_updates', 'customer_service', 'all')
  ),
  source text not null check (
    source in ('whatsapp', 'operator', 'web', 'phone', 'paper', 'in_person', 'other')
  ),
  evidence_ref text not null check (char_length(trim(evidence_ref)) between 1 and 200),
  policy_version text not null check (char_length(trim(policy_version)) between 1 and 80),
  whatsapp_message_id text,
  actor_user_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index whatsapp_consent_events_contact_created_idx
  on public.whatsapp_consent_events (contact_id, sequence_number desc);

create unique index whatsapp_consent_events_message_idx
  on public.whatsapp_consent_events (whatsapp_message_id)
  where whatsapp_message_id is not null;

alter table public.whatsapp_consent_events enable row level security;

create policy whatsapp_consent_events_read on public.whatsapp_consent_events
  for select to authenticated
  using (public.current_user_is_active());

revoke all on public.whatsapp_consent_events from public, anon, authenticated;
grant select on public.whatsapp_consent_events to authenticated;
grant all on public.whatsapp_consent_events to service_role;

-- Consent can only be recorded through the audited RPC below.  The transaction
-- local flag also prevents service-role code from silently editing the summary.
create or replace function public.guard_whatsapp_consent_event_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_setting('app.whatsapp_consent_write', true) is distinct from 'on' then
    raise exception 'CONSENT_EVENT_RPC_REQUIRED' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger whatsapp_consent_events_guard_insert
  before insert on public.whatsapp_consent_events
  for each row execute function public.guard_whatsapp_consent_event_write();

create or replace function public.prevent_whatsapp_consent_event_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'CONSENT_EVENTS_ARE_APPEND_ONLY' using errcode = '42501';
end;
$$;

create trigger whatsapp_consent_events_append_only
  before update or delete on public.whatsapp_consent_events
  for each row execute function public.prevent_whatsapp_consent_event_change();

create or replace function public.guard_contact_consent_summary()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_setting('app.whatsapp_consent_write', true) is distinct from 'on' then
    raise exception 'CONSENT_EVENT_RPC_REQUIRED' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger contacts_guard_consent_summary
  before update of whatsapp_opt_in_at, whatsapp_opt_out_at, whatsapp_consent_status
  on public.contacts
  for each row execute function public.guard_contact_consent_summary();

create or replace function public.has_active_whatsapp_consent(
  p_contact_id uuid,
  p_purpose text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select event.decision = 'opt_in'
    from public.whatsapp_consent_events event
    where event.contact_id = p_contact_id
      and event.purpose in (p_purpose, 'all')
    order by event.sequence_number desc
    limit 1
  ), false);
$$;

create or replace function public.apply_whatsapp_consent_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  appointment_consent boolean;
begin
  appointment_consent := public.has_active_whatsapp_consent(
    new.contact_id,
    'appointment_updates'
  );

  perform set_config('app.whatsapp_consent_write', 'on', true);

  update public.contacts
  set
    whatsapp_opt_in_at = case
      when new.decision = 'opt_in'
        and new.purpose in ('appointment_updates', 'all')
        then greatest(coalesce(whatsapp_opt_in_at, new.created_at), new.created_at)
      else whatsapp_opt_in_at
    end,
    whatsapp_opt_out_at = case
      when new.decision = 'opt_out'
        and new.purpose in ('appointment_updates', 'all')
        then greatest(coalesce(whatsapp_opt_out_at, new.created_at), new.created_at)
      else whatsapp_opt_out_at
    end,
    whatsapp_consent_status = case
      when appointment_consent then 'opted_in'
      when exists (
        select 1
        from public.whatsapp_consent_events event
        where event.contact_id = new.contact_id
          and event.purpose in ('appointment_updates', 'all')
      ) then 'opted_out'
      else 'unknown'
    end
  where id = new.contact_id;

  if new.decision = 'opt_out' then
    update public.conversations
    set automation_mode = 'manual', needs_human = true
    where contact_id = new.contact_id and status = 'open';

    update public.reminders reminder
    set
      status = 'cancelled',
      processing_started_at = null,
      last_error = 'CONSENT_REVOKED'
    from public.appointments appointment
    where reminder.appointment_id = appointment.id
      and appointment.contact_id = new.contact_id
      and reminder.status in ('pending', 'processing');
  elsif new.decision = 'opt_in'
    and new.purpose in ('appointment_updates', 'all') then
    -- Re-evaluate future appointments after a new, explicit grant.  The existing
    -- scheduling trigger only creates reminders that are still timely.
    update public.appointments
    set starts_at = starts_at
    where contact_id = new.contact_id
      and status in ('scheduled', 'confirmed')
      and starts_at > now();
  end if;

  insert into public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    metadata
  ) values (
    new.actor_user_id,
    'whatsapp.consent_' || new.decision,
    'contact',
    new.contact_id,
    jsonb_build_object(
      'purpose', new.purpose,
      'source', new.source,
      'evidence_ref', new.evidence_ref,
      'policy_version', new.policy_version,
      'consent_event_id', new.id
    )
  );

  return new;
end;
$$;

create trigger whatsapp_consent_events_apply
  after insert on public.whatsapp_consent_events
  for each row execute function public.apply_whatsapp_consent_event();

create or replace function public.record_whatsapp_consent(
  p_contact_id uuid,
  p_decision text,
  p_purpose text,
  p_source text,
  p_evidence_ref text,
  p_policy_version text,
  p_whatsapp_message_id text default null
)
returns public.whatsapp_consent_events
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.whatsapp_consent_events%rowtype;
  caller_role text := coalesce(auth.role(), '');
begin
  if caller_role <> 'service_role' and not public.current_user_is_active() then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  if p_decision not in ('opt_in', 'opt_out')
    or p_purpose not in ('appointment_updates', 'customer_service', 'all')
    or p_source not in ('whatsapp', 'operator', 'web', 'phone', 'paper', 'in_person', 'other')
    or nullif(trim(p_evidence_ref), '') is null
    or nullif(trim(p_policy_version), '') is null then
    raise exception 'INVALID_CONSENT_EVENT' using errcode = '22023';
  end if;

  if p_source = 'whatsapp' and nullif(trim(coalesce(p_whatsapp_message_id, '')), '') is null then
    raise exception 'WHATSAPP_EVIDENCE_REQUIRED' using errcode = '22023';
  end if;

  perform 1 from public.contacts where id = p_contact_id for update;
  if not found then
    raise exception 'CONTACT_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform set_config('app.whatsapp_consent_write', 'on', true);
  insert into public.whatsapp_consent_events (
    contact_id,
    decision,
    purpose,
    source,
    evidence_ref,
    policy_version,
    whatsapp_message_id,
    actor_user_id,
    created_at
  ) values (
    p_contact_id,
    p_decision,
    p_purpose,
    p_source,
    trim(p_evidence_ref),
    trim(p_policy_version),
    nullif(trim(coalesce(p_whatsapp_message_id, '')), ''),
    auth.uid(),
    clock_timestamp()
  )
  on conflict (whatsapp_message_id) where whatsapp_message_id is not null
  do nothing
  returning * into result;

  if result.id is null and p_whatsapp_message_id is not null then
    select * into result
    from public.whatsapp_consent_events
    where whatsapp_message_id = trim(p_whatsapp_message_id);
  end if;

  return result;
end;
$$;

-- Existing appointments do not become proactive messages by default.  Both
-- switches stay off until Meta templates are synced and consent is collected.
update public.app_settings
set reminder_24h_enabled = false,
    reminder_2h_enabled = false
where id = true;

update public.reminders
set status = 'cancelled',
    processing_started_at = null,
    last_error = 'POLICY_ROLLOUT_PAUSED'
where status in ('pending', 'processing');

create or replace function public.schedule_appointment_reminders()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.app_settings%rowtype;
  has_consent boolean;
  reminder_at timestamptz;
begin
  select * into settings from public.app_settings where id = true;
  has_consent := public.has_active_whatsapp_consent(
    new.contact_id,
    'appointment_updates'
  );

  if new.status not in ('scheduled', 'confirmed')
    or new.starts_at <= now()
    or not has_consent then
    update public.reminders
    set status = 'cancelled', processing_started_at = null
    where appointment_id = new.id and status in ('pending', 'processing');
    return new;
  end if;

  reminder_at := new.starts_at - make_interval(mins => settings.reminder_24h_minutes);
  if settings.reminder_24h_enabled and reminder_at > now() then
    insert into public.reminders (appointment_id, type, scheduled_at, status)
    values (new.id, 'appointment_24h', reminder_at, 'pending')
    on conflict (appointment_id, type) do update
    set scheduled_at = excluded.scheduled_at,
        status = 'pending',
        message_id = null,
        attempts = 0,
        last_error = null,
        sent_at = null,
        processing_started_at = null;
  else
    update public.reminders
    set status = 'cancelled', processing_started_at = null
    where appointment_id = new.id
      and type = 'appointment_24h'
      and status in ('pending', 'processing');
  end if;

  reminder_at := new.starts_at - make_interval(mins => settings.reminder_2h_minutes);
  if settings.reminder_2h_enabled and reminder_at > now() then
    insert into public.reminders (appointment_id, type, scheduled_at, status)
    values (new.id, 'appointment_2h', reminder_at, 'pending')
    on conflict (appointment_id, type) do update
    set scheduled_at = excluded.scheduled_at,
        status = 'pending',
        message_id = null,
        attempts = 0,
        last_error = null,
        sent_at = null,
        processing_started_at = null;
  else
    update public.reminders
    set status = 'cancelled', processing_started_at = null
    where appointment_id = new.id
      and type = 'appointment_2h'
      and status in ('pending', 'processing');
  end if;

  return new;
end;
$$;

create or replace function public.claim_due_reminders(p_limit integer default 25)
returns setof public.reminders
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A crashed worker may be retried, but the immutable reminder idempotency key
  -- still guarantees at most one Graph dispatch.
  update public.reminders
  set status = 'pending', processing_started_at = null, last_error = 'STALE_CLAIM_RECOVERED'
  where status = 'processing'
    and processing_started_at < now() - interval '15 minutes';

  update public.reminders reminder
  set status = 'cancelled', processing_started_at = null, last_error = 'POLICY_NOT_AUTHORIZED'
  from public.appointments appointment
  where reminder.appointment_id = appointment.id
    and reminder.status in ('pending', 'processing')
    and (
      appointment.status not in ('scheduled', 'confirmed')
      or appointment.starts_at <= now()
      or not public.has_active_whatsapp_consent(
        appointment.contact_id,
        'appointment_updates'
      )
    );

  return query
  with due as (
    select reminder.id
    from public.reminders reminder
    join public.appointments appointment on appointment.id = reminder.appointment_id
    join public.app_settings settings on settings.id = true
    where reminder.status = 'pending'
      and reminder.scheduled_at <= now()
      and reminder.scheduled_at < appointment.starts_at
      and appointment.starts_at > now()
      and appointment.status in ('scheduled', 'confirmed')
      and public.has_active_whatsapp_consent(
        appointment.contact_id,
        'appointment_updates'
      )
      and case reminder.type
        when 'appointment_24h' then settings.reminder_24h_enabled
        when 'appointment_2h' then settings.reminder_2h_enabled
      end
    order by reminder.scheduled_at
    for update of reminder skip locked
    limit greatest(1, least(p_limit, 100))
  )
  update public.reminders reminder
  set status = 'processing',
      attempts = attempts + 1,
      processing_started_at = now()
  from due
  where reminder.id = due.id
  returning reminder.*;
end;
$$;

create or replace function public.enforce_whatsapp_outbound_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.whatsapp_settings%rowtype;
  contact public.contacts%rowtype;
  conversation public.conversations%rowtype;
  template public.message_templates%rowtype;
  consent_event_id uuid;
  appointment_is_valid boolean;
  recent_count integer;
  policy_basis text;
begin
  if new.direction <> 'outbound' then
    return new;
  end if;

  if tg_op = 'UPDATE'
    and not (
      old.direction = 'outbound'
      and old.status = 'failed'
      and new.status = 'pending'
    ) then
    return new;
  end if;

  -- Only local seed/reset sessions running as a database administrator may use
  -- this escape hatch.  API roles cannot bypass the policy trigger.
  if session_user in ('postgres', 'supabase_admin')
    and current_setting('app.whatsapp_policy_seed_bypass', true) = 'on' then
    return new;
  end if;

  if nullif(trim(coalesce(new.idempotency_key, '')), '') is null then
    raise exception 'POLICY_IDEMPOTENCY_REQUIRED' using errcode = 'P0001';
  end if;

  select * into settings
  from public.whatsapp_settings
  where id = true;

  if not found or settings.sending_paused then
    raise exception 'POLICY_SENDING_PAUSED' using errcode = 'P0001';
  end if;

  select * into contact
  from public.contacts
  where id = new.contact_id
  for update;
  if not found then
    raise exception 'POLICY_CONTACT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into conversation
  from public.conversations
  where id = new.conversation_id;
  if not found or conversation.contact_id <> new.contact_id then
    raise exception 'POLICY_CONVERSATION_CONTACT_MISMATCH' using errcode = '23514';
  end if;

  if new.type = 'template' then
    if settings.quality_rating <> 'GREEN' then
      raise exception 'POLICY_NUMBER_QUALITY_UNVERIFIED' using errcode = 'P0001';
    end if;

    select * into template
    from public.message_templates candidate
    where candidate.meta_name = new.template_name
      and candidate.key = new.metadata ->> 'template_key'
    limit 1;

    if not found
      or not template.enabled
      or template.meta_status <> 'APPROVED'
      or upper(coalesce(template.category, '')) <> 'UTILITY'
      or template.quality_rating in ('RED') then
      raise exception 'POLICY_TEMPLATE_NOT_APPROVED' using errcode = 'P0001';
    end if;

    select event.id into consent_event_id
    from public.whatsapp_consent_events event
    where event.contact_id = new.contact_id
      and event.purpose in ('appointment_updates', 'all')
    order by event.sequence_number desc
    limit 1;

    if not public.has_active_whatsapp_consent(
      new.contact_id,
      'appointment_updates'
    ) then
      raise exception 'POLICY_CONSENT_REQUIRED' using errcode = 'P0001';
    end if;

    select exists (
      select 1
      from public.appointments appointment
      where appointment.id::text = new.metadata ->> 'appointment_id'
        and appointment.contact_id = new.contact_id
        and (
          template.key not in ('appointment_reminder_24h', 'appointment_reminder_2h')
          or (
            appointment.status in ('scheduled', 'confirmed')
            and appointment.starts_at > now()
          )
        )
    ) into appointment_is_valid;

    if not appointment_is_valid then
      raise exception 'POLICY_APPOINTMENT_CONTEXT_REQUIRED' using errcode = 'P0001';
    end if;

    select count(*) into recent_count
    from public.messages message
    where message.contact_id = new.contact_id
      and message.direction = 'outbound'
      and message.type = 'template'
      and message.status <> 'failed'
      and message.created_at > now() - interval '24 hours';
    if recent_count >= 3 then
      raise exception 'POLICY_TEMPLATE_RATE_LIMIT' using errcode = 'P0001';
    end if;

    policy_basis := 'explicit_appointment_updates_consent';
  else
    if conversation.last_inbound_message_at is null
      or now() >= conversation.last_inbound_message_at + interval '24 hours' then
      raise exception 'POLICY_CUSTOMER_SERVICE_WINDOW_CLOSED' using errcode = 'P0001';
    end if;

    if contact.whatsapp_opt_out_at is not null
      and conversation.last_inbound_message_at <= contact.whatsapp_opt_out_at then
      raise exception 'POLICY_CONTACT_OPTED_OUT' using errcode = 'P0001';
    end if;

    policy_basis := 'customer_service_window';
  end if;

  select count(*) into recent_count
  from public.messages message
  where message.contact_id = new.contact_id
    and message.direction = 'outbound'
    and message.status <> 'failed'
    and message.created_at > now() - interval '1 hour';
  if recent_count >= 30 then
    raise exception 'POLICY_CONTACT_RATE_LIMIT' using errcode = 'P0001';
  end if;

  if new.metadata ->> 'source' = 'automation' then
    select count(*) into recent_count
    from public.messages message
    where message.contact_id = new.contact_id
      and message.direction = 'outbound'
      and message.status <> 'failed'
      and message.metadata ->> 'source' = 'automation'
      and message.created_at > now() - interval '10 minutes';
    if recent_count >= 10 then
      raise exception 'POLICY_AUTOMATION_RATE_LIMIT' using errcode = 'P0001';
    end if;
  end if;

  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'policy_decision', 'allowed',
    'policy_basis', policy_basis,
    'policy_version', settings.policy_version,
    'policy_authorized_at', clock_timestamp(),
    'consent_event_id', consent_event_id
  );

  return new;
end;
$$;

create trigger messages_enforce_whatsapp_policy
  before insert or update of status on public.messages
  for each row execute function public.enforce_whatsapp_outbound_policy();

create or replace function public.apply_whatsapp_message_status(
  p_whatsapp_message_id text,
  p_status public.message_status,
  p_status_at timestamptz,
  p_metadata jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_message public.messages%rowtype;
  current_status_at timestamptz;
  current_rank integer;
  incoming_rank integer;
  next_status public.message_status;
begin
  select * into current_message
  from public.messages
  where whatsapp_message_id = p_whatsapp_message_id
  for update;
  if not found then
    return false;
  end if;

  begin
    current_status_at := nullif(
      current_message.metadata ->> 'status_updated_at',
      ''
    )::timestamptz;
  exception when others then
    current_status_at := null;
  end;

  if current_status_at is not null and p_status_at < current_status_at then
    return true;
  end if;

  current_rank := case current_message.status
    when 'pending' then 0
    when 'sent' then 1
    when 'delivered' then 2
    when 'read' then 3
    when 'failed' then -1
  end;
  incoming_rank := case p_status
    when 'pending' then 0
    when 'sent' then 1
    when 'delivered' then 2
    when 'read' then 3
    when 'failed' then -1
  end;

  next_status := current_message.status;
  if p_status = 'failed' then
    if current_message.status in ('pending', 'sent') then
      next_status := 'failed';
    end if;
  elsif current_message.status = 'failed' or incoming_rank >= current_rank then
    next_status := p_status;
  end if;

  update public.messages
  set
    status = next_status,
    metadata = current_message.metadata
      || coalesce(p_metadata, '{}'::jsonb)
      || jsonb_build_object('status_updated_at', p_status_at)
  where id = current_message.id;

  return true;
end;
$$;

-- Operators may edit identity fields, but consent summaries and Meta approval
-- state are no longer writable directly from the browser.
revoke update (whatsapp_opt_in_at, whatsapp_opt_out_at) on public.contacts
  from authenticated;
grant update (name, phone_e164) on public.contacts to authenticated;

revoke insert on public.contacts from authenticated;
grant insert (name, phone_e164) on public.contacts to authenticated;

revoke insert, update on public.message_templates from authenticated;
grant update (body_preview, enabled) on public.message_templates to authenticated;

revoke execute on function public.guard_whatsapp_consent_event_write()
  from public, anon, authenticated;
revoke execute on function public.prevent_whatsapp_consent_event_change()
  from public, anon, authenticated;
revoke execute on function public.guard_contact_consent_summary()
  from public, anon, authenticated;
revoke execute on function public.has_active_whatsapp_consent(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.apply_whatsapp_consent_event()
  from public, anon, authenticated;
revoke execute on function public.enforce_whatsapp_outbound_policy()
  from public, anon, authenticated;
revoke execute on function public.apply_whatsapp_message_status(
  text, public.message_status, timestamptz, jsonb
) from public, anon, authenticated;

revoke execute on function public.record_whatsapp_consent(
  uuid, text, text, text, text, text, text
) from public, anon;
grant execute on function public.record_whatsapp_consent(
  uuid, text, text, text, text, text, text
) to authenticated, service_role;
grant execute on function public.apply_whatsapp_message_status(
  text, public.message_status, timestamptz, jsonb
) to service_role;
grant execute on function public.has_active_whatsapp_consent(uuid, text)
  to service_role;

revoke execute on function public.claim_due_reminders(integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_reminders(integer) to service_role;
