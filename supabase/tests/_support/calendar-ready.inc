-- Synthetic Calendar observations for domain tests. Include inside the test's
-- transaction. This never installs cron or makes a network request.
create or replace function pg_temp.calendar_ready(
  p_coverage_start timestamptz default date_trunc('day', clock_timestamp()) - interval '1 day'
)
returns void language plpgsql as $$
declare
  fixture_timezone text;
  fixture_secret uuid;
begin
  select timezone into fixture_timezone from public.app_settings where id = true;
  fixture_secret := vault.create_secret('synthetic-calendar-test-token');
  update public.google_calendar_connections
  set status = 'connected', connected_by = null,
      google_account_id = 'synthetic-domain-test-account',
      google_account_email = 'calendar-fixture@example.test',
      google_calendar_id = 'synthetic-domain-test-calendar',
      google_calendar_name = 'Synthetic test fixture',
      google_calendar_timezone = fixture_timezone,
      refresh_token_secret_id = fixture_secret,
      connected_at = clock_timestamp(), disconnected_at = null,
      connection_generation = 9900,
      sync_scope_google_account_id = 'synthetic-domain-test-account',
      sync_scope_google_calendar_id = 'synthetic-domain-test-calendar',
      sync_scope_generation = 9900,
      inbound_first_import_approved_at = clock_timestamp(),
      inbound_sync_state = 'incremental',
      inbound_sync_token = 'synthetic-domain-test-observation',
      inbound_sync_token_generation = 9900,
      inbound_sync_contract_version = 2,
      inbound_sync_timezone = fixture_timezone,
      inbound_coverage_starts_at = p_coverage_start,
      inbound_coverage_ends_at = p_coverage_start + interval '21 days',
      last_sync_completed_at = clock_timestamp(),
      last_sync_error = null, last_error = null,
      inbound_lease_token = null, inbound_lease_expires_at = null,
      inbound_lease_sync_contract_version = null,
      inbound_lease_coverage_starts_at = null,
      inbound_lease_coverage_ends_at = null,
      inbound_lease_timezone = null,
      automation_enabled = true,
      automation_epoch = '99ca1000-0000-4000-8000-000000000001',
      automation_activated_at = clock_timestamp() - interval '1 day',
      automation_google_account_id = 'synthetic-domain-test-account',
      automation_google_calendar_id = 'synthetic-domain-test-calendar',
      automation_connection_generation = 9900
  where id = true;
end;
$$;

-- Represents the acknowledged response for this exact synthetic appointment.
-- Tests must call calendar_ready again after claiming a WhatsApp execution so
-- the observation is fresh for that particular execution, as production does.
create or replace function pg_temp.calendar_projection_synced(p_appointment_id uuid)
returns void language plpgsql as $$
begin
  perform public.enqueue_google_calendar_projection(p_appointment_id);
  update public.google_calendar_sync_jobs job
  set status = 'succeeded', attempts = 0, processing_started_at = null,
      operation = 'upsert',
      connection_generation = connection.connection_generation,
      automation_epoch = connection.automation_epoch,
      authorized_google_account_id = connection.google_account_id,
      authorized_google_calendar_id = connection.google_calendar_id,
      authorized_connection_generation = connection.connection_generation,
      google_event_id = public.google_calendar_automation_event_id(appointment.id),
      projection_stage = case when appointment.status = 'confirmed'
        then 'confirmed' else 'pre_reservation' end,
      projected_operation = 'upsert',
      projected_stage = case when appointment.status = 'confirmed'
        then 'confirmed' else 'pre_reservation' end,
      projected_starts_at = appointment.starts_at,
      projected_ends_at = appointment.ends_at,
      google_etag = '"synthetic-domain-test-etag"',
      last_error = null
  from public.appointments appointment
  cross join public.google_calendar_connections connection
  where connection.id = true and job.appointment_id = appointment.id
    and appointment.id = p_appointment_id;
end;
$$;

select pg_temp.calendar_ready();
