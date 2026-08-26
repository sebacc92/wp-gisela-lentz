create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'profiles', 'contacts', 'conversations', 'messages', 'professionals',
    'availability_rules', 'availability_exceptions', 'appointments',
    'automation_sessions', 'reminders', 'message_templates', 'quick_replies',
    'app_settings', 'whatsapp_settings'
  ]
  loop
    execute format(
      'create trigger set_%I_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      table_name,
      table_name
    );
  end loop;
end;
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1), 'Usuario'),
    'OPERADOR'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- The first project user may already exist when these migrations are applied.
insert into public.profiles (id, full_name, role)
select
  id,
  coalesce(
    nullif(trim(raw_user_meta_data ->> 'full_name'), ''),
    nullif(split_part(email, '@', 1), ''),
    'Usuario'
  ),
  'OPERADOR'
from auth.users
on conflict (id) do nothing;

create or replace function public.assign_message_contact()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  conversation_contact_id uuid;
begin
  select contact_id into conversation_contact_id
  from public.conversations
  where id = new.conversation_id;

  if conversation_contact_id is null then
    raise exception 'CONVERSATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if new.contact_id is not null and new.contact_id <> conversation_contact_id then
    raise exception 'MESSAGE_CONTACT_MISMATCH' using errcode = '23514';
  end if;

  new.contact_id = conversation_contact_id;
  return new;
end;
$$;

create trigger messages_assign_contact
  before insert or update of conversation_id, contact_id on public.messages
  for each row execute function public.assign_message_contact();

create or replace function public.sync_conversation_after_message()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.conversations
  set
    last_message_at = greatest(last_message_at, new.created_at),
    last_inbound_message_at = case
      when new.direction = 'inbound' then greatest(coalesce(last_inbound_message_at, new.created_at), new.created_at)
      else last_inbound_message_at
    end,
    unread_count = case
      when new.direction = 'inbound' then unread_count + 1
      else unread_count
    end,
    automation_mode = case
      when new.direction = 'outbound' and new.sent_by is not null then 'manual'::public.automation_mode
      else automation_mode
    end,
    needs_human = case
      when new.direction = 'outbound' and new.sent_by is not null then false
      else needs_human
    end
  where id = new.conversation_id;

  update public.contacts
  set last_message_at = greatest(coalesce(last_message_at, new.created_at), new.created_at)
  where id = new.contact_id;

  return new;
end;
$$;

create trigger messages_sync_conversation
  after insert on public.messages
  for each row execute function public.sync_conversation_after_message();

create or replace function public.schedule_appointment_reminders()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.app_settings%rowtype;
begin
  select * into settings from public.app_settings where id = true;

  if new.status not in ('scheduled', 'confirmed') then
    update public.reminders
    set status = 'cancelled'
    where appointment_id = new.id and status in ('pending', 'processing');
    return new;
  end if;

  if settings.reminder_24h_enabled then
    insert into public.reminders (appointment_id, type, scheduled_at, status)
    values (new.id, 'appointment_24h', new.starts_at - make_interval(mins => settings.reminder_24h_minutes), 'pending')
    on conflict (appointment_id, type) do update
    set
      scheduled_at = excluded.scheduled_at,
      status = 'pending',
      message_id = null,
      attempts = 0,
      last_error = null,
      sent_at = null;
  else
    update public.reminders
    set status = 'cancelled'
    where appointment_id = new.id and type = 'appointment_24h' and status in ('pending', 'processing');
  end if;

  if settings.reminder_2h_enabled then
    insert into public.reminders (appointment_id, type, scheduled_at, status)
    values (new.id, 'appointment_2h', new.starts_at - make_interval(mins => settings.reminder_2h_minutes), 'pending')
    on conflict (appointment_id, type) do update
    set
      scheduled_at = excluded.scheduled_at,
      status = 'pending',
      message_id = null,
      attempts = 0,
      last_error = null,
      sent_at = null;
  else
    update public.reminders
    set status = 'cancelled'
    where appointment_id = new.id and type = 'appointment_2h' and status in ('pending', 'processing');
  end if;

  return new;
end;
$$;

create trigger appointments_schedule_reminders
  after insert or update of starts_at, ends_at, status on public.appointments
  for each row execute function public.schedule_appointment_reminders();

create or replace function public.audit_appointment_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  action_name text;
begin
  action_name := case
    when tg_op = 'INSERT' then 'appointment.created'
    when new.status = 'cancelled' and old.status is distinct from new.status then 'appointment.cancelled'
    else 'appointment.updated'
  end;

  insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  values (
    auth.uid(),
    action_name,
    'appointment',
    new.id,
    jsonb_strip_nulls(jsonb_build_object(
      'status', new.status,
      'starts_at', new.starts_at,
      'professional_id', new.professional_id,
      'source', new.source
    ))
  );
  return new;
end;
$$;

create trigger appointments_audit
  after insert or update on public.appointments
  for each row execute function public.audit_appointment_change();

create or replace function public.audit_conversation_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.automation_mode is distinct from new.automation_mode
    or old.needs_human is distinct from new.needs_human
    or old.status is distinct from new.status then
    insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
    values (
      auth.uid(),
      'conversation.state_changed',
      'conversation',
      new.id,
      jsonb_build_object(
        'automation_mode', new.automation_mode,
        'needs_human', new.needs_human,
        'status', new.status
      )
    );
  end if;
  return new;
end;
$$;

create trigger conversations_audit
  after update on public.conversations
  for each row execute function public.audit_conversation_change();

create or replace function public.get_or_create_open_conversation(p_contact_id uuid)
returns public.conversations
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.conversations;
begin
  select * into result
  from public.conversations
  where contact_id = p_contact_id and status = 'open'
  limit 1;

  if found then
    return result;
  end if;

  begin
    insert into public.conversations (contact_id)
    values (p_contact_id)
    returning * into result;
  exception when unique_violation then
    select * into result
    from public.conversations
    where contact_id = p_contact_id and status = 'open'
    limit 1;
  end;

  return result;
end;
$$;

create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void
language sql
set search_path = public
as $$
  update public.conversations
  set unread_count = 0
  where id = p_conversation_id;
$$;

create or replace function public.get_available_slots(
  p_professional_id uuid,
  p_date date,
  p_timezone text default 'America/Argentina/Buenos_Aires',
  p_limit integer default 40
)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
set search_path = public
as $$
  with professional as (
    select appointment_duration_minutes
    from public.professionals
    where id = p_professional_id and active
  ),
  windows as (
    select
      (p_date + ar.start_time) at time zone p_timezone as window_start,
      (p_date + ar.end_time) at time zone p_timezone as window_end,
      ar.slot_minutes
    from public.availability_rules ar
    where ar.professional_id = p_professional_id
      and ar.active
      and ar.weekday = extract(dow from p_date)::smallint

    union all

    select
      (ae.date + ae.start_time) at time zone p_timezone,
      (ae.date + ae.end_time) at time zone p_timezone,
      p.appointment_duration_minutes
    from public.availability_exceptions ae
    cross join professional p
    where ae.professional_id = p_professional_id
      and ae.date = p_date
      and ae.type = 'available'
      and ae.start_time is not null
      and ae.end_time is not null
  ),
  generated as (
    select
      slot_start as starts_at,
      slot_start + make_interval(mins => least(w.slot_minutes, p.appointment_duration_minutes)) as ends_at
    from windows w
    cross join professional p
    cross join lateral generate_series(
      w.window_start,
      w.window_end - make_interval(mins => least(w.slot_minutes, p.appointment_duration_minutes)),
      make_interval(mins => w.slot_minutes)
    ) slot_start
  )
  select distinct g.starts_at, g.ends_at
  from generated g
  where g.starts_at > now()
    and not exists (
      select 1
      from public.availability_exceptions ae
      where ae.professional_id = p_professional_id
        and ae.date = p_date
        and ae.type = 'unavailable'
        and (
          (ae.start_time is null and ae.end_time is null)
          or tstzrange(
            (ae.date + ae.start_time) at time zone p_timezone,
            (ae.date + ae.end_time) at time zone p_timezone,
            '[)'
          ) && tstzrange(g.starts_at, g.ends_at, '[)')
        )
    )
    and not exists (
      select 1
      from public.appointments a
      where a.professional_id = p_professional_id
        and a.status in ('scheduled', 'confirmed')
        and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(g.starts_at, g.ends_at, '[)')
    )
  order by g.starts_at
  limit greatest(1, least(p_limit, 200));
$$;

create or replace function public.create_appointment(
  p_contact_id uuid,
  p_professional_id uuid,
  p_starts_at timestamptz,
  p_source public.appointment_source default 'manual',
  p_internal_note text default null
)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  duration_minutes integer;
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not exists (
    select 1 from public.profiles where id = auth.uid() and active
  ) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select appointment_duration_minutes into duration_minutes
  from public.professionals
  where id = p_professional_id and active;

  if duration_minutes is null then
    raise exception 'PROFESSIONAL_NOT_AVAILABLE' using errcode = 'P0001';
  end if;

  begin
    insert into public.appointments (
      contact_id,
      professional_id,
      starts_at,
      ends_at,
      source,
      created_by,
      internal_note
    )
    values (
      p_contact_id,
      p_professional_id,
      p_starts_at,
      p_starts_at + make_interval(mins => duration_minutes),
      p_source,
      auth.uid(),
      p_internal_note
    )
    returning * into result;
  exception when exclusion_violation then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end;

  return result;
end;
$$;

create or replace function public.update_appointment_status(
  p_appointment_id uuid,
  p_status public.appointment_status
)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not exists (
    select 1 from public.profiles where id = auth.uid() and active
  ) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  update public.appointments
  set status = p_status
  where id = p_appointment_id
  returning * into result;

  if result.id is null then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  return result;
end;
$$;

create or replace function public.reschedule_appointment(
  p_appointment_id uuid,
  p_starts_at timestamptz
)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  duration_minutes integer;
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not exists (
    select 1 from public.profiles where id = auth.uid() and active
  ) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select p.appointment_duration_minutes into duration_minutes
  from public.appointments a
  join public.professionals p on p.id = a.professional_id
  where a.id = p_appointment_id and p.active;

  if duration_minutes is null then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  begin
    update public.appointments
    set
      starts_at = p_starts_at,
      ends_at = p_starts_at + make_interval(mins => duration_minutes),
      status = 'scheduled'
    where id = p_appointment_id
    returning * into result;
  exception when exclusion_violation then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end;

  return result;
end;
$$;

create or replace function public.claim_due_reminders(p_limit integer default 25)
returns setof public.reminders
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with due as (
    select id
    from public.reminders
    where status = 'pending' and scheduled_at <= now()
    order by scheduled_at
    for update skip locked
    limit greatest(1, least(p_limit, 100))
  )
  update public.reminders r
  set status = 'processing', attempts = attempts + 1
  from due
  where r.id = due.id
  returning r.*;
end;
$$;

create or replace function public.cleanup_webhook_events(p_retention_days integer default 30)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  delete from public.webhook_events
  where created_at < now() - make_interval(days => greatest(7, p_retention_days));
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;
