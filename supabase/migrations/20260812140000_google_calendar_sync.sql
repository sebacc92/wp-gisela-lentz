-- Sincronización unidireccional y segura: la agenda es la fuente de verdad y
-- Google Calendar recibe una proyección durable de cada turno.

create table public.google_calendar_connections (
  id boolean primary key default true check (id),
  status text not null default 'disconnected'
    check (status in ('disconnected', 'connected', 'reconnect_required')),
  connected_by uuid references public.profiles (id) on delete set null,
  google_account_id text,
  google_account_email text,
  google_calendar_id text,
  google_calendar_name text,
  refresh_token_secret_id uuid,
  connected_at timestamptz,
  disconnected_at timestamptz,
  last_synced_at timestamptz,
  last_error text,
  connection_generation bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_calendar_connected_fields check (
    status <> 'connected'
    or (
      google_account_id is not null
      and google_account_email is not null
      and google_calendar_id is not null
      and refresh_token_secret_id is not null
    )
  )
);

create table public.google_calendar_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references public.profiles (id) on delete cascade,
  code_verifier text not null
    check (char_length(code_verifier) between 43 and 128),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index google_calendar_oauth_states_expiry_idx
  on public.google_calendar_oauth_states (expires_at);

create table public.google_calendar_sync_jobs (
  id uuid not null default gen_random_uuid() unique,
  appointment_id uuid primary key
    references public.appointments (id) on delete cascade,
  operation text not null check (operation in ('upsert', 'delete')),
  desired_version bigint not null default 1 check (desired_version > 0),
  connection_generation bigint not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  processing_started_at timestamptz,
  google_event_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index google_calendar_sync_jobs_due_idx
  on public.google_calendar_sync_jobs (available_at, updated_at)
  where status in ('pending', 'processing');

comment on table public.google_calendar_connections is
  'Estado sanitizado de la única conexión. La credencial vive exclusivamente en Vault.';
comment on table public.google_calendar_oauth_states is
  'Transacciones OAuth de un solo uso. Contiene hash de state y verifier PKCE; service_role solamente.';
comment on table public.google_calendar_sync_jobs is
  'Outbox coalescente: una fila y una versión monotónica por turno.';

alter table public.google_calendar_connections enable row level security;
alter table public.google_calendar_oauth_states enable row level security;
alter table public.google_calendar_sync_jobs enable row level security;

revoke all on table public.google_calendar_connections from public, anon, authenticated;
revoke all on table public.google_calendar_oauth_states from public, anon, authenticated;
revoke all on table public.google_calendar_sync_jobs from public, anon, authenticated;
grant all on table public.google_calendar_connections to service_role;
grant all on table public.google_calendar_oauth_states to service_role;
grant all on table public.google_calendar_sync_jobs to service_role;

-- Vault no debe ser accesible directamente desde roles del navegador.
revoke all on table vault.secrets from public, anon, authenticated;
revoke all on table vault.decrypted_secrets from public, anon, authenticated;
revoke execute on function vault.create_secret(text, text, text, uuid)
  from public, anon, authenticated;
revoke execute on function vault.update_secret(uuid, text, text, text, uuid)
  from public, anon, authenticated;

create trigger set_google_calendar_connections_updated_at
  before update on public.google_calendar_connections
  for each row execute function public.set_updated_at();

create trigger set_google_calendar_sync_jobs_updated_at
  before update on public.google_calendar_sync_jobs
  for each row execute function public.set_updated_at();

create or replace function public.enqueue_google_calendar_appointment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  next_operation text;
begin
  if not exists (
    select 1 from public.google_calendar_connections
    where id = true and status = 'connected'
  ) then
    return new;
  end if;

  next_operation := case
    when new.status in ('scheduled', 'confirmed') then 'upsert'
    else 'delete'
  end;

  insert into public.google_calendar_sync_jobs as current_job (
    appointment_id,
    operation,
    desired_version,
    status,
    attempts,
    available_at,
    processing_started_at,
    last_error,
    connection_generation
  ) values (
    new.id,
    next_operation,
    1,
    'pending',
    0,
    clock_timestamp(),
    null,
    null,
    (select connection_generation from public.google_calendar_connections where id = true)
  )
  on conflict (appointment_id) do update
  set operation = excluded.operation,
      desired_version = current_job.desired_version + 1,
      status = case when current_job.status = 'processing'
        then 'processing' else 'pending' end,
      attempts = case when current_job.status = 'processing'
        then current_job.attempts else 0 end,
      available_at = clock_timestamp(),
      processing_started_at = case when current_job.status = 'processing'
        then current_job.processing_started_at else null end,
      last_error = null,
      connection_generation = greatest(
        current_job.connection_generation,
        excluded.connection_generation
      );

  return new;
end;
$$;

create trigger appointments_google_calendar_sync
  after insert or update of starts_at, ends_at, status, contact_id
  on public.appointments
  for each row execute function public.enqueue_google_calendar_appointment();

create or replace function public.prevent_google_managed_appointment_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.google_calendar_connections where id = true
  ) or exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = old.id
  ) then
    raise exception 'APPOINTMENT_DELETE_REQUIRES_CANCELLATION'
      using errcode = '23503';
  end if;
  return old;
end;
$$;

create trigger appointments_prevent_google_managed_delete
  before delete on public.appointments
  for each row execute function public.prevent_google_managed_appointment_delete();

create or replace function public.enqueue_google_calendar_contact_appointments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.name is not distinct from new.name then return new; end if;

  insert into public.google_calendar_sync_jobs as current_job (
    appointment_id, operation, desired_version, status, attempts,
    available_at, processing_started_at, last_error, connection_generation
  )
  select appointment.id, 'upsert', 1, 'pending', 0,
         clock_timestamp(), null, null, connection.connection_generation
  from public.appointments appointment
  join public.google_calendar_connections connection
    on connection.id = true and connection.status = 'connected'
  where appointment.contact_id = new.id
    and appointment.status in ('scheduled', 'confirmed')
    and appointment.ends_at > clock_timestamp()
  on conflict (appointment_id) do update
  set operation = 'upsert',
      desired_version = current_job.desired_version + 1,
      status = case when current_job.status = 'processing'
        then 'processing' else 'pending' end,
      attempts = case when current_job.status = 'processing'
        then current_job.attempts else 0 end,
      available_at = clock_timestamp(),
      processing_started_at = case when current_job.status = 'processing'
        then current_job.processing_started_at else null end,
      last_error = null,
      connection_generation = greatest(
        current_job.connection_generation,
        excluded.connection_generation
      );

  return new;
end;
$$;

create trigger contacts_google_calendar_sync
  after update of name on public.contacts
  for each row execute function public.enqueue_google_calendar_contact_appointments();

create or replace function public.create_google_calendar_oauth_state(
  p_user_id uuid,
  p_state_hash text,
  p_code_verifier text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if p_user_id is null
    or p_state_hash !~ '^[0-9a-f]{64}$'
    or char_length(coalesce(p_code_verifier, '')) not between 43 and 128
    or p_expires_at <= clock_timestamp()
    or p_expires_at > clock_timestamp() + interval '15 minutes'
    or not exists (
      select 1 from public.profiles
      where id = p_user_id and active and role = 'ADMIN'
    ) then
    raise exception 'INVALID_OAUTH_STATE' using errcode = '22023';
  end if;

  delete from public.google_calendar_oauth_states
  where expires_at <= clock_timestamp() or user_id = p_user_id;

  insert into public.google_calendar_oauth_states (
    state_hash, user_id, code_verifier, expires_at
  ) values (p_state_hash, p_user_id, p_code_verifier, p_expires_at);
end;
$$;

create or replace function public.consume_google_calendar_oauth_state(
  p_state_hash text
)
returns table (user_id uuid, code_verifier text)
language sql
security definer
set search_path = public
as $$
  with consumed as (
    delete from public.google_calendar_oauth_states state
    where state.state_hash = p_state_hash
    returning state.user_id, state.code_verifier, state.expires_at
  )
  select consumed.user_id, consumed.code_verifier
  from consumed
  where consumed.expires_at > clock_timestamp()
    and exists (
      select 1 from public.profiles profile
      where profile.id = consumed.user_id and profile.active and profile.role = 'ADMIN'
    );
$$;

create or replace function public.complete_google_calendar_connection(
  p_user_id uuid,
  p_google_account_id text,
  p_google_account_email text,
  p_google_calendar_id text,
  p_google_calendar_name text,
  p_refresh_token text
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  current_secret_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
      select 1 from public.profiles
      where id = p_user_id and active and role = 'ADMIN'
    )
    or char_length(trim(coalesce(p_google_account_id, ''))) not between 1 and 255
    or char_length(trim(coalesce(p_google_account_email, ''))) not between 3 and 320
    or char_length(trim(coalesce(p_google_calendar_id, ''))) not between 1 and 1024
    or char_length(coalesce(p_refresh_token, '')) not between 16 and 8192 then
    raise exception 'INVALID_GOOGLE_CONNECTION' using errcode = '22023';
  end if;

  select refresh_token_secret_id into current_secret_id
  from public.google_calendar_connections where id = true for update;

  -- Una primera conexión no tiene todavía fila que bloquear. Este advisory
  -- lock serializa callbacks duplicados y evita crear dos secretos/calendarios.
  perform pg_advisory_xact_lock(hashtextextended('google_calendar_connection', 0));
  if current_secret_id is null then
    select refresh_token_secret_id into current_secret_id
    from public.google_calendar_connections where id = true for update;
  end if;

  if current_secret_id is null then
    current_secret_id := vault.create_secret(
      p_refresh_token,
      'gisela_google_calendar_refresh_token',
      'Google Calendar OAuth refresh token'
    );
  else
    perform vault.update_secret(current_secret_id, p_refresh_token);
  end if;

  insert into public.google_calendar_connections (
    id, status, connected_by, google_account_id, google_account_email,
    google_calendar_id, google_calendar_name, refresh_token_secret_id,
    connected_at, disconnected_at, last_error
  ) values (
    true, 'connected', p_user_id, trim(p_google_account_id),
    trim(p_google_account_email), trim(p_google_calendar_id),
    coalesce(nullif(trim(p_google_calendar_name), ''), 'Gisela Lentz · Turnos'),
    current_secret_id, clock_timestamp(), null, null
  )
  on conflict (id) do update
  set status = 'connected', connected_by = excluded.connected_by,
      google_account_id = excluded.google_account_id,
      google_account_email = excluded.google_account_email,
      google_calendar_id = excluded.google_calendar_id,
      google_calendar_name = excluded.google_calendar_name,
      refresh_token_secret_id = excluded.refresh_token_secret_id,
      connected_at = excluded.connected_at, disconnected_at = null,
      last_error = null,
      connection_generation = google_calendar_connections.connection_generation + 1;

  -- La primera inserción también inicia una generación distinta de cero.
  update public.google_calendar_connections
  set connection_generation = 1
  where id = true and connection_generation = 0;

  update public.google_calendar_sync_jobs job
  set status = 'cancelled', processing_started_at = null,
      last_error = 'CONNECTION_GENERATION_REPLACED'
  where job.status in ('pending', 'processing', 'failed')
    and job.connection_generation <> (
      select connection.connection_generation
      from public.google_calendar_connections connection
      where connection.id = true
    );

  insert into public.google_calendar_sync_jobs as current_job (
    appointment_id, operation, desired_version, status, attempts,
    available_at, processing_started_at, last_error, connection_generation
  )
  select appointment.id,
         case when appointment.status in ('scheduled', 'confirmed')
           then 'upsert' else 'delete' end,
         1, 'pending', 0, clock_timestamp(), null, null,
         (select connection_generation from public.google_calendar_connections where id = true)
  from public.appointments appointment
  where (
      appointment.status in ('scheduled', 'confirmed')
      and appointment.ends_at > clock_timestamp()
    )
    or (
      appointment.status not in ('scheduled', 'confirmed')
      and exists (
        select 1 from public.google_calendar_sync_jobs prior
        where prior.appointment_id = appointment.id
          and prior.google_event_id is not null
      )
    )
  on conflict (appointment_id) do update
  set operation = excluded.operation,
      desired_version = current_job.desired_version + 1,
      status = case when current_job.status = 'processing'
        then 'processing' else 'pending' end,
      attempts = case when current_job.status = 'processing'
        then current_job.attempts else 0 end,
      available_at = clock_timestamp(),
      processing_started_at = case when current_job.status = 'processing'
        then current_job.processing_started_at else null end,
      last_error = null,
      connection_generation = greatest(
        current_job.connection_generation,
        excluded.connection_generation
      );

  insert into public.audit_logs (
    actor_user_id, action, entity_type, metadata
  ) values (
    p_user_id, 'google_calendar.connected', 'google_calendar',
    jsonb_build_object('calendar_name', coalesce(nullif(trim(p_google_calendar_name), ''), 'Gisela Lentz · Turnos'))
  );
end;
$$;

create or replace function public.get_google_calendar_connection_metadata()
returns table (status text, google_calendar_id text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  return query
  select connection.status, connection.google_calendar_id
  from public.google_calendar_connections connection where id = true;
end;
$$;

create or replace function public.get_google_calendar_connection_secret()
returns table (
  status text,
  google_calendar_id text,
  refresh_token text,
  connection_generation bigint
)
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  return query
  select connection.status,
         connection.google_calendar_id,
         secret.decrypted_secret,
         connection.connection_generation
  from public.google_calendar_connections connection
  left join vault.decrypted_secrets secret
    on secret.id = connection.refresh_token_secret_id
  where connection.id = true;
end;
$$;

create or replace function public.google_calendar_status()
returns table (
  connected boolean,
  status text,
  google_account_email text,
  google_calendar_name text,
  last_synced_at timestamptz,
  last_error text,
  pending_count bigint,
  failed_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  return query
  select connection.status = 'connected', connection.status,
         connection.google_account_email, connection.google_calendar_name,
         connection.last_synced_at, connection.last_error,
         (select count(*) from public.google_calendar_sync_jobs job
          where job.status in ('pending', 'processing')),
         (select count(*) from public.google_calendar_sync_jobs job
          where job.status = 'failed')
  from public.google_calendar_connections connection where id = true;
end;
$$;

create or replace function public.disconnect_google_calendar(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  current_secret_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_user_id and active and role = 'ADMIN'
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select refresh_token_secret_id into current_secret_id
  from public.google_calendar_connections where id = true for update;

  update public.google_calendar_connections
  set status = 'disconnected', refresh_token_secret_id = null,
      disconnected_at = clock_timestamp(), last_error = null,
      connection_generation = connection_generation + 1
  where id = true;
  update public.google_calendar_sync_jobs
  set status = 'cancelled', processing_started_at = null,
      last_error = 'CALENDAR_DISCONNECTED'
  where status in ('pending', 'processing');
  if current_secret_id is not null then
    delete from vault.secrets where id = current_secret_id;
  end if;

  insert into public.audit_logs (actor_user_id, action, entity_type, metadata)
  values (p_user_id, 'google_calendar.disconnected', 'google_calendar', '{}'::jsonb);
end;
$$;

create or replace function public.reconcile_google_calendar_sync()
returns table (queued bigint, already_queued bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.google_calendar_connections
    where id = true and status = 'connected'
  ) then
    return query select 0::bigint, 0::bigint;
    return;
  end if;

  return query
  with candidates as materialized (
    select appointment.id as appointment_id,
           case when appointment.status in ('scheduled', 'confirmed')
             then 'upsert' else 'delete' end as operation
    from public.appointments appointment
    left join public.google_calendar_sync_jobs job
      on job.appointment_id = appointment.id
    where (appointment.status in ('scheduled', 'confirmed')
           and appointment.ends_at > clock_timestamp())
       or (
         appointment.status not in ('scheduled', 'confirmed')
         and job.google_event_id is not null
       )
  ), changed as (
    insert into public.google_calendar_sync_jobs as current_job (
      appointment_id, operation, desired_version, status, attempts,
      available_at, processing_started_at, last_error, connection_generation
    )
    select candidate.appointment_id, candidate.operation, 1, 'pending', 0,
           clock_timestamp(), null, null, connection.connection_generation
    from candidates candidate
    join public.google_calendar_connections connection
      on connection.id = true and connection.status = 'connected'
    on conflict (appointment_id) do update
    set operation = excluded.operation,
        desired_version = current_job.desired_version + 1,
        status = case when current_job.status = 'processing'
          then 'processing' else 'pending' end,
        attempts = case when current_job.status = 'processing'
          then current_job.attempts else 0 end,
        available_at = clock_timestamp(),
        processing_started_at = case when current_job.status = 'processing'
          then current_job.processing_started_at else null end,
        last_error = null,
        connection_generation = greatest(
          current_job.connection_generation,
          excluded.connection_generation
        )
    where current_job.operation is distinct from excluded.operation
       or current_job.connection_generation is distinct from excluded.connection_generation
       or current_job.status = 'cancelled'
       or (
         excluded.operation = 'upsert'
         and current_job.status = 'succeeded'
         and current_job.updated_at < clock_timestamp() - interval '1 hour'
       )
    returning appointment_id
  )
  select (select count(*) from changed),
         (select count(*) from candidates) - (select count(*) from changed);
end;
$$;

create or replace function public.claim_google_calendar_sync_jobs(
  p_limit integer default 10,
  p_expected_generation bigint default null
)
returns table (
  job_id uuid,
  appointment_id uuid,
  operation text,
  desired_version bigint,
  attempts integer,
  starts_at timestamptz,
  ends_at timestamptz,
  patient_name text,
  timezone text,
  connection_generation bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.google_calendar_connections connection
    where connection.id = true and connection.status = 'connected'
      and connection.connection_generation = p_expected_generation
  ) then return; end if;

  update public.google_calendar_sync_jobs job
  set status = 'pending', processing_started_at = null,
      available_at = clock_timestamp(), last_error = 'STALE_CLAIM_RECOVERED'
  where job.status = 'processing'
    and job.connection_generation = p_expected_generation
    and job.processing_started_at < clock_timestamp() - interval '10 minutes';

  return query
  with due as (
    select job.id, job.appointment_id
    from public.google_calendar_sync_jobs job
    where job.status = 'pending' and job.available_at <= clock_timestamp()
      and job.connection_generation = p_expected_generation
      and exists (
        select 1 from public.google_calendar_connections connection
        where connection.id = true and connection.status = 'connected'
          and connection.connection_generation = p_expected_generation
      )
    order by job.available_at, job.updated_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 20))
  ), claimed as (
    update public.google_calendar_sync_jobs job
    set status = 'processing', attempts = job.attempts + 1,
        processing_started_at = clock_timestamp()
    from due
    where job.id = due.id
    returning job.*
  )
  select claimed.id, claimed.appointment_id, claimed.operation,
         claimed.desired_version, claimed.attempts,
         appointment.starts_at, appointment.ends_at, contact.name,
         settings.timezone, connection.connection_generation
  from claimed
  join public.appointments appointment on appointment.id = claimed.appointment_id
  join public.contacts contact on contact.id = appointment.contact_id
  join public.app_settings settings on settings.id = true
  join public.google_calendar_connections connection
    on connection.id = true and connection.status = 'connected';
end;
$$;

create or replace function public.complete_google_calendar_sync_job(
  p_job_id uuid,
  p_claimed_version bigint,
  p_google_event_id text,
  p_connection_generation bigint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  completed boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  update public.google_calendar_sync_jobs
  set status = 'succeeded', processing_started_at = null,
      google_event_id = case when operation = 'delete' then null
        else p_google_event_id end,
      last_error = null
  where id = p_job_id and status = 'processing'
    and desired_version = p_claimed_version
    and exists (
      select 1 from public.google_calendar_connections connection
      where connection.id = true and connection.status = 'connected'
        and connection.connection_generation = p_connection_generation
    );
  completed := found;

  if not completed then
    update public.google_calendar_sync_jobs
    set status = 'pending', processing_started_at = null,
        available_at = clock_timestamp()
    where id = p_job_id and status = 'processing'
      and connection_generation = p_connection_generation;
  else
    update public.google_calendar_connections
    set last_synced_at = clock_timestamp(), last_error = null
    where id = true and status = 'connected';
  end if;
  return completed;
end;
$$;

create or replace function public.fail_google_calendar_sync_job(
  p_job_id uuid,
  p_claimed_version bigint,
  p_connection_generation bigint,
  p_error_code text,
  p_retry_at timestamptz,
  p_terminal boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  changed boolean := false;
  clean_error text := upper(trim(coalesce(p_error_code, '')));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if clean_error !~ '^[A-Z0-9_]{3,100}$' or p_retry_at is null then
    raise exception 'INVALID_SYNC_FAILURE' using errcode = '22023';
  end if;

  update public.google_calendar_sync_jobs
  set status = case when p_terminal then 'failed' else 'pending' end,
      processing_started_at = null,
      available_at = case when p_terminal then available_at else p_retry_at end,
      last_error = clean_error
  where id = p_job_id and status = 'processing'
    and desired_version = p_claimed_version
    and connection_generation = p_connection_generation;
  changed := found;

  if not changed then
    update public.google_calendar_sync_jobs
    set status = 'pending', processing_started_at = null,
        available_at = clock_timestamp()
    where id = p_job_id and status = 'processing'
      and connection_generation = p_connection_generation;
  elsif p_terminal then
    update public.google_calendar_connections
    set last_error = clean_error where id = true and status = 'connected';
  end if;
  return changed;
end;
$$;

create or replace function public.mark_google_calendar_reconnect_required(
  p_error_code text,
  p_expected_generation bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_error text := upper(trim(coalesce(p_error_code, '')));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if clean_error !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'INVALID_SYNC_FAILURE' using errcode = '22023';
  end if;
  update public.google_calendar_connections
  set status = 'reconnect_required', last_error = clean_error
  where id = true and connection_generation = p_expected_generation;
end;
$$;

do $$
declare
  signature regprocedure;
begin
  for signature in
    select procedure_oid
    from (values
      ('public.create_google_calendar_oauth_state(uuid,text,text,timestamptz)'::regprocedure),
      ('public.consume_google_calendar_oauth_state(text)'::regprocedure),
      ('public.complete_google_calendar_connection(uuid,text,text,text,text,text)'::regprocedure),
      ('public.get_google_calendar_connection_metadata()'::regprocedure),
      ('public.get_google_calendar_connection_secret()'::regprocedure),
      ('public.google_calendar_status()'::regprocedure),
      ('public.disconnect_google_calendar(uuid)'::regprocedure),
      ('public.reconcile_google_calendar_sync()'::regprocedure),
      ('public.claim_google_calendar_sync_jobs(integer,bigint)'::regprocedure),
      ('public.complete_google_calendar_sync_job(uuid,bigint,text,bigint)'::regprocedure),
      ('public.fail_google_calendar_sync_job(uuid,bigint,bigint,text,timestamptz,boolean)'::regprocedure),
      ('public.mark_google_calendar_reconnect_required(text,bigint)'::regprocedure)
    ) functions(procedure_oid)
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', signature);
    execute format('grant execute on function %s to service_role', signature);
  end loop;
end;
$$;

revoke execute on function public.enqueue_google_calendar_appointment()
  from public, anon, authenticated;
revoke execute on function public.enqueue_google_calendar_contact_appointments()
  from public, anon, authenticated;
revoke execute on function public.prevent_google_managed_appointment_delete()
  from public, anon, authenticated;
