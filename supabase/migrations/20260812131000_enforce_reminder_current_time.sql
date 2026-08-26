-- Hardening incremental para instalaciones que ya aplicaron 130000. Además de
-- respetar scheduled_at, el claim vuelve a evaluar la hora actualmente
-- configurada. Así, mover la apertura de 20:00 a 21:00 no permite despachar un
-- recordatorio pendiente durante la hora intermedia.

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

revoke execute on function public.claim_due_reminders(integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_reminders(integer) to service_role;

