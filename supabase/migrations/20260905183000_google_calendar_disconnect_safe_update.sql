-- Producción carga `safeupdate` en las sesiones de PostgREST y rechaza
-- actualizaciones sin predicado. La desconexión debe limpiar todas las
-- proyecciones activas o históricas que todavía conserven estado de Google,
-- sin escribir filas que ya están completamente limpias.
create or replace function public.disconnect_google_calendar_with_secrets(
  p_user_id uuid
)
returns table (
  active_refresh_token text,
  candidate_refresh_token text
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  active_secret_id uuid;
  candidate_secret_id uuid;
  captured_active_token text;
  captured_candidate_token text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_user_id and profile.active and profile.role = 'ADMIN'
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection_candidate', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );

  update public.google_calendar_sync_jobs job
  set status = 'pending',
      processing_started_at = null,
      available_at = clock_timestamp(),
      last_error = 'STALE_CLAIM_RECOVERED'
  where job.status = 'processing'
    and (
      job.processing_started_at is null
      or job.processing_started_at <= clock_timestamp() - interval '10 minutes'
    );
  if exists (
    select 1 from public.google_calendar_sync_jobs job
    where job.status = 'processing'
  ) then
    raise exception 'GOOGLE_CALENDAR_SYNC_IN_PROGRESS' using errcode = '55000';
  end if;

  select connection.refresh_token_secret_id
  into active_secret_id
  from public.google_calendar_connections connection
  where connection.id = true
  for update;

  if exists (
    select 1 from public.google_calendar_connections connection
    where connection.id = true
      and connection.inbound_lease_token is not null
      and connection.inbound_lease_expires_at > clock_timestamp()
  ) then
    raise exception 'GOOGLE_CALENDAR_SYNC_IN_PROGRESS' using errcode = '55000';
  end if;

  select candidate.refresh_token_secret_id
  into candidate_secret_id
  from public.google_calendar_connection_candidates candidate
  where candidate.id = true
  for update;

  select nullif(secret.decrypted_secret, '')
  into captured_active_token
  from vault.decrypted_secrets secret
  where secret.id = active_secret_id;
  select nullif(secret.decrypted_secret, '')
  into captured_candidate_token
  from vault.decrypted_secrets secret
  where secret.id = candidate_secret_id;

  update public.google_calendar_connections
  set status = 'disconnected',
      connected_by = null,
      google_account_id = null,
      google_account_email = null,
      google_calendar_id = null,
      google_calendar_name = null,
      google_calendar_timezone = null,
      refresh_token_secret_id = null,
      connected_at = null,
      disconnected_at = clock_timestamp(),
      last_synced_at = null,
      last_error = null,
      connection_generation = connection_generation + 1,
      oauth_attempt_generation = oauth_attempt_generation + 1,
      inbound_sync_token = null,
      inbound_sync_token_generation = null,
      inbound_sync_state = 'never_synced',
      inbound_first_import_approved_at = null,
      inbound_first_import_approved_by = null,
      inbound_lease_token = null,
      inbound_lease_expires_at = null,
      last_checked_at = null,
      last_sync_completed_at = null,
      last_sync_summary = '{}'::jsonb,
      last_sync_error = null,
      sync_scope_google_account_id = null,
      sync_scope_google_calendar_id = null,
      sync_scope_generation = null
  where id = true;

  update public.google_calendar_sync_jobs job
  set status = case
        when job.status in ('pending', 'processing', 'failed') then 'cancelled'
        else job.status
      end,
      processing_started_at = null,
      last_error = case
        when job.status in ('pending', 'processing', 'failed')
          then 'CALENDAR_DISCONNECTED'
        else job.last_error
      end,
      google_event_id = null,
      google_etag = null,
      projected_operation = null,
      projected_starts_at = null,
      projected_ends_at = null
  where job.status in ('pending', 'processing', 'failed')
     or job.processing_started_at is not null
     or job.google_event_id is not null
     or job.google_etag is not null
     or job.projected_operation is not null
     or job.projected_starts_at is not null
     or job.projected_ends_at is not null;

  delete from public.google_calendar_oauth_states oauth_state
  where oauth_state.user_id = p_user_id;
  delete from public.google_calendar_connection_candidates where id = true;
  delete from vault.secrets secret
  where secret.id = active_secret_id
     or secret.id = candidate_secret_id;

  insert into public.audit_logs (actor_user_id, action, entity_type, metadata)
  values (
    p_user_id,
    'google_calendar.disconnected',
    'google_calendar',
    jsonb_build_object('candidate_cleared', candidate_secret_id is not null)
  );

  return query select captured_active_token, captured_candidate_token;
end;
$$;

revoke execute on function public.disconnect_google_calendar_with_secrets(uuid)
  from public, anon, authenticated;
grant execute on function public.disconnect_google_calendar_with_secrets(uuid)
  to service_role;
