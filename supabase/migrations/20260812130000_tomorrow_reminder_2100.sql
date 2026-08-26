-- El identificador histórico `appointment_24h` se conserva por compatibilidad
-- con Meta, la UI y los registros ya existentes. Desde esta migración representa
-- el recordatorio del día anterior, a una hora local configurable (21:00 por
-- defecto), y no un desplazamiento exacto de 24 horas.

alter table public.app_settings
  add column reminder_day_before_time time without time zone not null
    default time '21:00';

comment on column public.app_settings.reminder_day_before_time is
  'Hora local del negocio para enviar el recordatorio de los turnos del día siguiente.';

comment on column public.app_settings.reminder_24h_minutes is
  'Campo legado conservado por compatibilidad. appointment_24h usa reminder_day_before_time.';

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
  appointment_local_date date;
  today_local date;
begin
  select * into settings from public.app_settings where id = true;
  if not found then
    raise exception 'APP_SETTINGS_NOT_FOUND' using errcode = 'P0002';
  end if;

  has_consent := public.has_active_whatsapp_consent(
    new.contact_id,
    'appointment_updates'
  );

  if new.status not in ('scheduled', 'confirmed')
    or new.starts_at <= clock_timestamp()
    or not has_consent then
    update public.reminders
    set status = 'cancelled',
        processing_started_at = null,
        last_error = 'POLICY_NOT_AUTHORIZED'
    where appointment_id = new.id
      and status in ('pending', 'processing');
    return new;
  end if;

  appointment_local_date :=
    (new.starts_at at time zone settings.timezone)::date;
  today_local :=
    (clock_timestamp() at time zone settings.timezone)::date;
  reminder_at := (
    (appointment_local_date - 1) + settings.reminder_day_before_time
  ) at time zone settings.timezone;

  if settings.reminder_24h_enabled
    and appointment_local_date > today_local then
    insert into public.reminders as existing (
      appointment_id,
      type,
      scheduled_at,
      status
    )
    values (new.id, 'appointment_24h', reminder_at, 'pending')
    on conflict (appointment_id, type) do update
    set scheduled_at = excluded.scheduled_at,
        status = 'pending',
        message_id = null,
        attempts = 0,
        last_error = null,
        sent_at = null,
        processing_started_at = null
    -- Un recordatorio ya enviado no se vuelve a abrir aunque cambie el turno.
    -- La idempotency key de Edge Function ofrece una segunda barrera.
    where existing.status <> 'sent';
  else
    update public.reminders
    set status = 'cancelled',
        processing_started_at = null,
        last_error = case
          when settings.reminder_24h_enabled
            then 'REMINDER_WINDOW_EXPIRED'
          else 'REMINDER_DISABLED'
        end
    where appointment_id = new.id
      and type = 'appointment_24h'
      and status in ('pending', 'processing');
  end if;

  reminder_at :=
    new.starts_at - make_interval(mins => settings.reminder_2h_minutes);
  if settings.reminder_2h_enabled and reminder_at > clock_timestamp() then
    insert into public.reminders as existing (
      appointment_id,
      type,
      scheduled_at,
      status
    )
    values (new.id, 'appointment_2h', reminder_at, 'pending')
    on conflict (appointment_id, type) do update
    set scheduled_at = excluded.scheduled_at,
        status = 'pending',
        message_id = null,
        attempts = 0,
        last_error = null,
        sent_at = null,
        processing_started_at = null
    where existing.status <> 'sent';
  else
    update public.reminders
    set status = 'cancelled',
        processing_started_at = null,
        last_error = case
          when settings.reminder_2h_enabled
            then 'REMINDER_WINDOW_EXPIRED'
          else 'REMINDER_DISABLED'
        end
    where appointment_id = new.id
      and type = 'appointment_2h'
      and status in ('pending', 'processing');
  end if;

  return new;
end;
$$;

-- El cron puede invocar esta función con frecuencia. La función recién habilita
-- candidatos desde la hora local configurada, vuelve a comprobar estado y
-- consentimiento, y usa la restricción única (appointment_id, type) para
-- deduplicar invocaciones concurrentes o repetidas.
create or replace function public.queue_tomorrow_appointment_reminders(
  p_now timestamptz default clock_timestamp()
)
returns table (queued bigint, already_queued bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.app_settings%rowtype;
  local_today date;
  queue_opens_at timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if p_now is null then
    raise exception 'INVALID_NOW' using errcode = '22023';
  end if;

  select * into settings from public.app_settings where id = true;
  if not found then
    raise exception 'APP_SETTINGS_NOT_FOUND' using errcode = 'P0002';
  end if;

  local_today := (p_now at time zone settings.timezone)::date;
  queue_opens_at := (
    local_today + settings.reminder_day_before_time
  ) at time zone settings.timezone;

  if not settings.reminder_24h_enabled or p_now < queue_opens_at then
    return query select 0::bigint, 0::bigint;
    return;
  end if;

  return query
  with candidates as materialized (
    select appointment.id as appointment_id
    from public.appointments appointment
    where appointment.status in ('scheduled', 'confirmed')
      and appointment.starts_at > p_now
      and (appointment.starts_at at time zone settings.timezone)::date =
        local_today + 1
      and public.has_active_whatsapp_consent(
        appointment.contact_id,
        'appointment_updates'
      )
  ), queued_rows as (
    insert into public.reminders as existing (
      appointment_id,
      type,
      scheduled_at,
      status
    )
    select
      candidate.appointment_id,
      'appointment_24h'::public.reminder_type,
      queue_opens_at,
      'pending'::public.reminder_status
    from candidates candidate
    on conflict (appointment_id, type) do update
    set scheduled_at = excluded.scheduled_at,
        status = 'pending',
        message_id = case
          when existing.status = 'pending' then existing.message_id
          else null
        end,
        attempts = case
          when existing.status = 'pending' then existing.attempts
          else 0
        end,
        last_error = case
          when existing.status = 'pending' then existing.last_error
          else null
        end,
        sent_at = null,
        processing_started_at = null
    -- Corrige pendientes si un administrador cambió hora/zona y sólo reabre
    -- cancelaciones administrativas reversibles. Los envíos, fallos agotados y
    -- bloqueos de test mode permanecen terminales.
    where (
        existing.status = 'pending'
        and existing.scheduled_at is distinct from excluded.scheduled_at
      )
      or (
        existing.status = 'cancelled'
        and existing.sent_at is null
        and existing.last_error in (
          'POLICY_NOT_AUTHORIZED',
          'POLICY_ROLLOUT_PAUSED',
          'REMINDER_DISABLED',
          'REMINDER_WINDOW_EXPIRED',
          'WHATSAPP_POLICY:UTILITY_CONSENT_REQUIRED'
        )
      )
    returning appointment_id
  )
  select
    (select count(*) from queued_rows),
    (select count(*) from candidates) - (select count(*) from queued_rows);
end;
$$;

create or replace function public.claim_due_reminders(p_limit integer default 25)
returns setof public.reminders
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Un worker interrumpido puede reintentarse; la idempotency key inmutable del
  -- reminder sigue impidiendo un segundo despacho a Graph.
  update public.reminders
  set status = 'pending',
      processing_started_at = null,
      last_error = 'STALE_CLAIM_RECOVERED'
  where status = 'processing'
    and (
      processing_started_at is null
      or processing_started_at < clock_timestamp() - interval '15 minutes'
    );

  update public.reminders reminder
  set status = 'cancelled',
      processing_started_at = null,
      last_error = 'POLICY_NOT_AUTHORIZED'
  from public.appointments appointment
  where reminder.appointment_id = appointment.id
    and reminder.status in ('pending', 'processing')
    and (
      appointment.status not in ('scheduled', 'confirmed')
      or appointment.starts_at <= clock_timestamp()
      or not public.has_active_whatsapp_consent(
        appointment.contact_id,
        'appointment_updates'
      )
    );

  -- Nunca enviar al día siguiente si el worker estuvo caído: pasada la
  -- medianoche local, el recordatorio vencido se cancela de forma explícita.
  update public.reminders reminder
  set status = 'cancelled',
      processing_started_at = null,
      last_error = 'REMINDER_WINDOW_EXPIRED'
  from public.appointments appointment,
       public.app_settings settings
  where settings.id = true
    and reminder.appointment_id = appointment.id
    and reminder.type = 'appointment_24h'
    and reminder.status in ('pending', 'processing')
    and reminder.scheduled_at <= clock_timestamp()
    and (appointment.starts_at at time zone settings.timezone)::date <>
      (clock_timestamp() at time zone settings.timezone)::date + 1;

  return query
  with due as (
    select reminder.id
    from public.reminders reminder
    join public.appointments appointment
      on appointment.id = reminder.appointment_id
    join public.app_settings settings on settings.id = true
    where reminder.status = 'pending'
      and reminder.scheduled_at <= clock_timestamp()
      and reminder.scheduled_at < appointment.starts_at
      and appointment.starts_at > clock_timestamp()
      and appointment.status in ('scheduled', 'confirmed')
      and public.has_active_whatsapp_consent(
        appointment.contact_id,
        'appointment_updates'
      )
      and case reminder.type
        when 'appointment_24h' then
          settings.reminder_24h_enabled
          and clock_timestamp() >= (
            (clock_timestamp() at time zone settings.timezone)::date
            + settings.reminder_day_before_time
          ) at time zone settings.timezone
          and (appointment.starts_at at time zone settings.timezone)::date =
            (clock_timestamp() at time zone settings.timezone)::date + 1
        when 'appointment_2h' then settings.reminder_2h_enabled
      end
    order by reminder.scheduled_at
    for update of reminder skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.reminders reminder
  set status = 'processing',
      attempts = attempts + 1,
      processing_started_at = clock_timestamp()
  from due
  where reminder.id = due.id
  returning reminder.*;
end;
$$;

-- Ajuste único de recordatorios todavía no procesados. Nunca se altera un
-- recordatorio enviado, fallido o cancelado por una política de seguridad.
update public.reminders reminder
set status = 'pending',
    scheduled_at = (
      ((appointment.starts_at at time zone settings.timezone)::date - 1)
      + settings.reminder_day_before_time
    ) at time zone settings.timezone,
    processing_started_at = null,
    last_error = null
from public.appointments appointment,
     public.app_settings settings
where settings.id = true
  and reminder.appointment_id = appointment.id
  and reminder.type = 'appointment_24h'
  and reminder.status in ('pending', 'processing')
  and settings.reminder_24h_enabled
  and appointment.status in ('scheduled', 'confirmed')
  and appointment.starts_at > clock_timestamp()
  and (appointment.starts_at at time zone settings.timezone)::date >
    (clock_timestamp() at time zone settings.timezone)::date
  and public.has_active_whatsapp_consent(
    appointment.contact_id,
    'appointment_updates'
  );

update public.reminders reminder
set status = 'cancelled',
    processing_started_at = null,
    last_error = case
      when settings.reminder_24h_enabled
        then 'POLICY_NOT_AUTHORIZED'
      else 'REMINDER_DISABLED'
    end
from public.appointments appointment,
     public.app_settings settings
where settings.id = true
  and reminder.appointment_id = appointment.id
  and reminder.type = 'appointment_24h'
  and reminder.status in ('pending', 'processing')
  and (
    not settings.reminder_24h_enabled
    or appointment.status not in ('scheduled', 'confirmed')
    or appointment.starts_at <= clock_timestamp()
    or (appointment.starts_at at time zone settings.timezone)::date <=
      (clock_timestamp() at time zone settings.timezone)::date
    or not public.has_active_whatsapp_consent(
      appointment.contact_id,
      'appointment_updates'
    )
  );

revoke execute on function public.queue_tomorrow_appointment_reminders(timestamptz)
  from public, anon, authenticated;
grant execute on function public.queue_tomorrow_appointment_reminders(timestamptz)
  to service_role;

revoke execute on function public.claim_due_reminders(integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_reminders(integer) to service_role;
