-- El scheduler de Calendar sólo puede vencer pre-reservas que pertenecen a
-- su activación vigente. `expire_booking_holds` conserva su contrato general
-- para los flujos existentes, pero Calendar no debe usarlo porque alcanzaría
-- reservas anteriores al corte autorizado.

create or replace function public.expire_google_calendar_automation_booking_holds(
  p_automation_epoch uuid,
  p_expected_generation bigint,
  p_expected_google_calendar_id text,
  p_now timestamptz default clock_timestamp()
)
returns table (appointment_id uuid, contact_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  connection_row public.google_calendar_connections%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if p_automation_epoch is null
    or p_expected_generation is null
    or p_expected_generation <= 0
    or nullif(trim(coalesce(p_expected_google_calendar_id, '')), '') is null
    or p_now is null
  then
    raise exception 'INVALID_CALENDAR_AUTOMATION_EXPIRATION_SCOPE'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );
  select connection.* into connection_row
  from public.google_calendar_connections connection
  where connection.id = true
    and connection.status = 'connected'
    and connection.automation_enabled
    and connection.automation_epoch = p_automation_epoch
    and connection.automation_activated_at is not null
    and connection.automation_google_account_id = connection.google_account_id
    and connection.automation_google_calendar_id = p_expected_google_calendar_id
    and connection.automation_google_calendar_id = connection.google_calendar_id
    and connection.automation_connection_generation = p_expected_generation
    and connection.automation_connection_generation =
      connection.connection_generation
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = connection.connection_generation
  for update;

  if not found
    or not public.google_calendar_automation_scope_is_current(true)
    or not private.google_calendar_automatic_schedule_is_consistent()
  then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_EXPIRATION_SCOPE_CHANGED'
      using errcode = '55000';
  end if;

  return query
  update public.appointments appointment
  set status = 'cancelled',
      deposit_status = 'expired',
      hold_expired_notification_status = case
        when appointment.hold_expired_notification_status = 'not_applicable'
          then 'pending'
        else appointment.hold_expired_notification_status
      end,
      hold_expired_notification_claimed_at = null,
      hold_expired_notification_error = null
  from public.google_calendar_sync_jobs job
  where job.appointment_id = appointment.id
    and appointment.created_at >= connection_row.automation_activated_at
    and appointment.status = 'scheduled'
    and appointment.deposit_status = 'pending'
    and appointment.hold_expires_at is not null
    and appointment.hold_expires_at <= p_now
    and not public.appointment_has_timely_deposit_proof_work(
      appointment.id,
      p_now
    )
    and job.automation_epoch = connection_row.automation_epoch
    and job.authorized_google_account_id =
      connection_row.automation_google_account_id
    and job.authorized_google_calendar_id =
      connection_row.automation_google_calendar_id
    and job.authorized_connection_generation =
      connection_row.automation_connection_generation
    and job.connection_generation =
      connection_row.automation_connection_generation
    and job.google_event_id =
      public.google_calendar_automation_event_id(appointment.id)
    and job.status in ('pending', 'processing', 'succeeded', 'failed')
    and job.projection_stage = 'pre_reservation'
    and job.projected_stage is distinct from 'confirmed'
    and not exists (
      select 1
      from public.google_calendar_external_events event
      where event.converted_appointment_id = appointment.id
        and event.google_calendar_id =
          connection_row.automation_google_calendar_id
        and event.connection_generation =
          connection_row.automation_connection_generation
    )
  returning appointment.id, appointment.contact_id;
end;
$$;

revoke execute on function public.expire_google_calendar_automation_booking_holds(
  uuid, bigint, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.expire_google_calendar_automation_booking_holds(
  uuid, bigint, text, timestamptz
) to service_role;
