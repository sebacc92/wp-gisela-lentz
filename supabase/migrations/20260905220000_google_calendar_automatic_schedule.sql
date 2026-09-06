-- Scheduler durable para Calendar. La migracion instala solamente la
-- infraestructura inerte: no crea secretos, no programa cron, no llama a la
-- Edge Function y no modifica la cola. La activacion es postgres-only y debe
-- hacerse explicitamente cuando import v2 y el calendario final esten listos.

create extension if not exists supabase_vault;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'supabase_vault')
    or not exists (select 1 from pg_extension where extname = 'pg_net')
    or not exists (select 1 from pg_extension where extname = 'pg_cron')
  then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_EXTENSIONS_UNAVAILABLE'
      using errcode = '55000';
  end if;
end;
$$;

revoke all on table vault.secrets from public, anon, authenticated;
revoke all on table vault.decrypted_secrets from public, anon, authenticated;
revoke execute on function vault.create_secret(text, text, text, uuid)
  from public, anon, authenticated;
revoke execute on function vault.update_secret(uuid, text, text, text, uuid)
  from public, anon, authenticated;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;
grant usage on schema private to postgres;

create table private.google_calendar_automatic_config (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  project_url_secret_id uuid,
  cron_secret_id uuid,
  cron_job_id bigint,
  automation_epoch uuid,
  google_account_id text,
  google_calendar_id text,
  connection_generation bigint,
  activated_at timestamptz,
  deactivated_at timestamptz,
  last_requested_at timestamptz,
  last_response_observed_at timestamptz,
  last_response_outcome text
    check (last_response_outcome in (
      'success', 'http_error', 'invalid_response', 'processor_error',
      'timeout', 'network_error', 'response_missing', 'dispatch_error'
    )),
  last_response_error_code text
    check (
      last_response_error_code is null
      or last_response_error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'
    ),
  updated_at timestamptz not null default clock_timestamp(),
  constraint google_calendar_automatic_complete_config check (
    (
      not enabled
      and project_url_secret_id is null
      and cron_secret_id is null
      and cron_job_id is null
      and automation_epoch is null
      and google_account_id is null
      and google_calendar_id is null
      and connection_generation is null
      and activated_at is null
      and last_requested_at is null
      and last_response_observed_at is null
      and last_response_outcome is null
      and last_response_error_code is null
    )
    or (
      enabled
      and project_url_secret_id is not null
      and cron_secret_id is not null
      and cron_job_id is not null
      and automation_epoch is not null
      and google_account_id is not null
      and google_calendar_id is not null
      and connection_generation is not null
      and connection_generation > 0
      and activated_at is not null
    )
  )
);

insert into private.google_calendar_automatic_config (id)
values (true)
on conflict (id) do nothing;

create table private.google_calendar_automatic_http_attempts (
  request_id bigint primary key,
  automation_epoch uuid not null,
  source text not null check (source in ('cron', 'immediate')),
  requested_at timestamptz not null default clock_timestamp(),
  response_observed_at timestamptz,
  status_code integer,
  timed_out boolean,
  outcome text not null default 'pending'
    check (outcome in (
      'pending', 'success', 'http_error', 'invalid_response',
      'processor_error', 'timeout', 'network_error', 'response_missing'
    )),
  error_code text,
  sanitized_summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(sanitized_summary) = 'object')
);

create index google_calendar_automatic_http_attempts_pending_idx
  on private.google_calendar_automatic_http_attempts (requested_at)
  where outcome = 'pending';

alter table private.google_calendar_automatic_config enable row level security;
alter table private.google_calendar_automatic_http_attempts
  enable row level security;
revoke all on table private.google_calendar_automatic_config
  from public, anon, authenticated, service_role;
revoke all on table private.google_calendar_automatic_http_attempts
  from public, anon, authenticated, service_role;
grant all on table private.google_calendar_automatic_config to postgres;
grant all on table private.google_calendar_automatic_http_attempts to postgres;

comment on table private.google_calendar_automatic_config is
  'Configuracion postgres-only e inerte por defecto. Guarda UUID de Vault y binding exacto, nunca secretos.';
comment on table private.google_calendar_automatic_http_attempts is
  'Auditoria sanitizada de pg_net: nunca persiste URL, headers, body crudo, secretos ni datos clinicos.';

create or replace function private.google_calendar_automatic_vault_value(
  p_secret_id uuid,
  p_expected_name text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_count integer;
  v_value text;
begin
  select count(*), min(secret.decrypted_secret)
  into v_count, v_value
  from vault.decrypted_secrets secret
  where secret.id = p_secret_id
    and secret.name = p_expected_name;

  if v_count <> 1 or v_value is null then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_VAULT_SECRET_UNAVAILABLE'
      using errcode = '55000';
  end if;
  return v_value;
end;
$$;

create or replace function private.google_calendar_automatic_schedule_is_consistent()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select coalesce((
    select config.enabled
      and config.cron_job_id is not null
      and config.automation_epoch is not null
      and (
        select count(*) = 1
        from cron.job job
        where job.jobname = 'google-calendar-automatic-sync'
      )
      and exists (
        select 1
        from cron.job job
        where job.jobid = config.cron_job_id
          and job.jobname = 'google-calendar-automatic-sync'
          and job.schedule = '* * * * *'
          and job.command =
            'select private.invoke_google_calendar_automatic_sync();'
          and job.database = current_database()
          and job.username = 'postgres'
          and job.active
      )
      and exists (
        select 1
        from public.google_calendar_connections connection
        where connection.id = true
          and connection.automation_enabled
          and connection.automation_epoch = config.automation_epoch
          and connection.automation_google_account_id = config.google_account_id
          and connection.automation_google_calendar_id = config.google_calendar_id
          and connection.automation_connection_generation =
            config.connection_generation
          and connection.google_account_id = config.google_account_id
          and connection.google_calendar_id = config.google_calendar_id
          and connection.connection_generation = config.connection_generation
      )
    from private.google_calendar_automatic_config config
    where config.id = true
  ), false);
$$;

create or replace function private.google_calendar_automatic_operational_error()
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select case
    when config.enabled
      and not private.google_calendar_automatic_schedule_is_consistent()
    then 'CALENDAR_AUTOMATION_CONFIGURATION_MISMATCH'
    when config.enabled and config.last_response_error_code is not null
    then config.last_response_error_code
    else null
  end
  from private.google_calendar_automatic_config config
  where config.id = true;
$$;

create or replace function private.capture_google_calendar_automatic_responses()
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_response record;
  v_body jsonb;
  v_summary jsonb;
  v_outcome text;
  v_error_code text;
  v_captured integer := 0;
  v_missing integer := 0;
begin
  for v_response in
    select attempt.request_id,
           response.status_code,
           response.timed_out,
           response.error_msg,
           response.content,
           response.created
    from private.google_calendar_automatic_http_attempts attempt
    join net._http_response response on response.id = attempt.request_id
    where attempt.outcome = 'pending'
    order by attempt.request_id
    for update of attempt
  loop
    v_body := null;
    v_summary := '{}'::jsonb;
    begin
      if v_response.content is not null then
        v_body := v_response.content::jsonb;
      end if;
    exception when others then
      v_body := null;
    end;

    if v_body is not null and jsonb_typeof(v_body) = 'object' then
      v_summary := jsonb_strip_nulls(jsonb_build_object(
        'processed', v_body -> 'processed',
        'outcome', v_body -> 'outcome',
        'mode', v_body -> 'mode',
        'claimed', v_body -> 'claimed',
        'synced', v_body -> 'synced',
        'adopted', v_body -> 'adopted',
        'deleted', v_body -> 'deleted',
        'retried', v_body -> 'retried',
        'failed', v_body -> 'failed',
        'expiredHolds', v_body -> 'expiredHolds',
        'inboundSkippedReason', case
          when v_body #>> '{inbound,skippedReason}' =
            'INBOUND_SYNC_IN_PROGRESS'
          then to_jsonb('INBOUND_SYNC_IN_PROGRESS'::text)
          else null
        end
      ));
    end if;

    if coalesce(v_response.timed_out, false) then
      v_outcome := 'timeout';
      v_error_code := 'TIMEOUT';
    elsif v_response.error_msg is not null then
      v_outcome := 'network_error';
      v_error_code := 'NETWORK_ERROR';
    elsif v_response.status_code is distinct from 200 then
      v_outcome := 'http_error';
      v_error_code := 'HTTP_' ||
        coalesce(v_response.status_code::text, 'UNKNOWN');
    elsif v_body is null
      or jsonb_typeof(v_body) <> 'object'
      or v_body ->> 'mode' is distinct from 'automatic'
    then
      v_outcome := 'invalid_response';
      v_error_code := 'INVALID_RESPONSE';
    elsif v_body -> 'processed' is distinct from 'true'::jsonb
      and not (
        v_body -> 'processed' is not distinct from 'false'::jsonb
        and v_body ->> 'outcome' = 'skipped'
        and v_body ->> 'reason' = 'AUTOMATION_DISABLED'
      )
    then
      v_outcome := 'invalid_response';
      v_error_code := 'INVALID_RESPONSE';
    elsif v_body -> 'processed' is not distinct from 'false'::jsonb then
      v_outcome := 'success';
      v_error_code := null;
    elsif jsonb_typeof(v_body -> 'failed') is distinct from 'number'
      or jsonb_typeof(v_body -> 'retried') is distinct from 'number'
    then
      v_outcome := 'invalid_response';
      v_error_code := 'INVALID_RESPONSE';
    elsif (v_body ->> 'failed')::numeric <> 0
      or (v_body ->> 'retried')::numeric <> 0
    then
      v_outcome := 'processor_error';
      v_error_code := 'PROCESSOR_INCOMPLETE';
    elsif v_body ->> 'outcome' = 'completed'
      or (
        v_body ->> 'outcome' = 'skipped'
        and v_body #>> '{inbound,skippedReason}' =
          'INBOUND_SYNC_IN_PROGRESS'
      )
    then
      v_outcome := 'success';
      v_error_code := null;
    else
      v_outcome := 'processor_error';
      v_error_code := 'PROCESSOR_INCOMPLETE';
    end if;

    update private.google_calendar_automatic_http_attempts attempt
    set response_observed_at = coalesce(v_response.created, clock_timestamp()),
        status_code = v_response.status_code,
        timed_out = v_response.timed_out,
        outcome = v_outcome,
        error_code = v_error_code,
        sanitized_summary = v_summary
    where attempt.request_id = v_response.request_id;
    v_captured := v_captured + 1;
  end loop;

  update private.google_calendar_automatic_http_attempts attempt
  set response_observed_at = clock_timestamp(),
      outcome = 'response_missing',
      error_code = 'RESPONSE_MISSING'
  where attempt.outcome = 'pending'
    and attempt.requested_at < clock_timestamp() - interval '15 minutes';
  get diagnostics v_missing = row_count;

  delete from private.google_calendar_automatic_http_attempts attempt
  where attempt.requested_at < clock_timestamp() - interval '30 days';

  update private.google_calendar_automatic_config config
  set last_response_observed_at = latest.response_observed_at,
      last_response_outcome = latest.outcome,
      last_response_error_code = latest.error_code,
      updated_at = clock_timestamp()
  from (
    select distinct on (attempt.automation_epoch)
           attempt.automation_epoch,
           attempt.response_observed_at,
           attempt.outcome,
           attempt.error_code
    from private.google_calendar_automatic_http_attempts attempt
    where attempt.outcome <> 'pending'
      and attempt.response_observed_at is not null
    order by attempt.automation_epoch,
             attempt.response_observed_at desc,
             attempt.request_id desc
  ) latest
  where config.id = true
    and config.enabled
    and config.automation_epoch = latest.automation_epoch
    and (
      config.last_response_observed_at is null
      or config.last_response_observed_at <= latest.response_observed_at
    );

  return v_captured + v_missing;
end;
$$;

create or replace function private.dispatch_google_calendar_automatic_sync(
  p_source text
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_config private.google_calendar_automatic_config%rowtype;
  v_project_url text;
  v_cron_secret text;
  v_request_id bigint;
begin
  if p_source not in ('cron', 'immediate') then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_SOURCE_INVALID'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_automatic_dispatch', 0)
  );

  begin
    perform private.capture_google_calendar_automatic_responses();

  select config.* into v_config
  from private.google_calendar_automatic_config config
  where config.id = true
  for update;
  if not found or not v_config.enabled then
    return null;
  end if;
  if not private.google_calendar_automatic_schedule_is_consistent() then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_CONFIGURATION_MISMATCH'
      using errcode = '55000';
  end if;

  -- Una reserva nueva nunca se omite por una request previa: cada transaccion
  -- immediate puede encolar. Solo cron evita solaparse por pocos segundos con
  -- un disparo inmediato; lease inbound y outbox aportan idempotencia durable.
  if p_source = 'cron'
    and v_config.last_requested_at is not null
    and v_config.last_requested_at > clock_timestamp() - interval '10 seconds'
  then
    return null;
  end if;

  v_project_url := private.google_calendar_automatic_vault_value(
    v_config.project_url_secret_id,
    'google_calendar_automation_project_url'
  );
  v_cron_secret := private.google_calendar_automatic_vault_value(
    v_config.cron_secret_id,
    'google_calendar_automation_cron_secret'
  );
  if v_project_url <> 'https://qcthvykjlwqdrmpkxisc.supabase.co'
    or octet_length(v_cron_secret) < 32
    or v_cron_secret ~ E'[\\r\\n]'
  then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_CONFIGURATION_INVALID'
      using errcode = '22023';
  end if;

  -- El helper vuelve a leer cron, scope y epoch inmediatamente antes del I/O.
  if not private.google_calendar_automatic_schedule_is_consistent() then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_CONFIGURATION_CHANGED'
      using errcode = '55000';
  end if;

  v_request_id := net.http_post(
    url := v_project_url || '/functions/v1/process-calendar-sync',
    body := '{}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-google-calendar-cron-secret', v_cron_secret
    ),
    timeout_milliseconds := 30000
  );
  if v_request_id is null then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_REQUEST_NOT_QUEUED'
      using errcode = '55000';
  end if;

  update private.google_calendar_automatic_config config
  set last_requested_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where config.id = true
    and config.enabled
    and config.automation_epoch = v_config.automation_epoch;
  if not found then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_CONFIGURATION_CHANGED'
      using errcode = '40001';
  end if;

  insert into private.google_calendar_automatic_http_attempts (
    request_id, automation_epoch, source
  ) values (
    v_request_id, v_config.automation_epoch, p_source
  );
    return v_request_id;
  exception when others then
    -- La UI recibe solamente un codigo fijo. La excepcion, URL y secretos no
    -- se copian a tablas ni respuestas publicas.
    update private.google_calendar_automatic_config config
    set last_response_observed_at = clock_timestamp(),
        last_response_outcome = 'dispatch_error',
        last_response_error_code = 'CALENDAR_AUTOMATION_DISPATCH_FAILED',
        updated_at = clock_timestamp()
    where config.id = true and config.enabled;
    return null;
  end;
end;
$$;

create or replace function private.invoke_google_calendar_automatic_sync()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  return private.dispatch_google_calendar_automatic_sync('cron');
end;
$$;

create or replace function private.google_calendar_automatic_job_dispatch()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_current_stage text;
begin
  if new.status <> 'pending'
    or new.available_at > clock_timestamp()
    or new.automation_epoch is null
    or new.google_event_id is null
    or new.projection_stage not in ('pre_reservation', 'confirmed', 'absent')
    or (
      new.projected_stage = 'confirmed'
      and new.projection_stage = 'pre_reservation'
    )
  then
    return new;
  end if;

  if not private.google_calendar_automatic_schedule_is_consistent() then
    return new;
  end if;
  if not exists (
    select 1
    from private.google_calendar_automatic_config config
    where config.id = true
      and config.enabled
      and config.automation_epoch = new.automation_epoch
      and config.google_account_id = new.authorized_google_account_id
      and config.google_calendar_id = new.authorized_google_calendar_id
      and config.connection_generation = new.connection_generation
      and config.connection_generation =
        new.authorized_connection_generation
  ) then
    return new;
  end if;
  if not public.google_calendar_automation_scope_is_current(true) then
    return new;
  end if;
  if exists (
    select 1
    from public.google_calendar_sync_conflicts conflict
    where conflict.appointment_id = new.appointment_id
      and conflict.status = 'pending'
      and conflict.connection_generation = new.connection_generation
  ) then
    return new;
  end if;

  v_current_stage := public.google_calendar_automation_appointment_stage(
    new.appointment_id,
    new.automation_epoch,
    new.authorized_google_account_id,
    new.authorized_google_calendar_id,
    new.authorized_connection_generation,
    clock_timestamp()
  );
  if not (
    (
      new.operation = 'upsert'
      and new.projection_stage in ('pre_reservation', 'confirmed')
      and v_current_stage = new.projection_stage
    )
    or (
      new.operation = 'delete'
      and new.projection_stage = 'absent'
      and v_current_stage is null
    )
  ) then
    return new;
  end if;

  perform private.dispatch_google_calendar_automatic_sync('immediate');
  return new;
exception when others then
  -- Nunca se propaga un fallo de scheduling hacia la mutacion del turno. El
  -- cron sigue siendo la recuperacion durable y el log no incluye el error.
  raise warning 'GOOGLE_CALENDAR_AUTOMATION_IMMEDIATE_DISPATCH_FAILED';
  return new;
end;
$$;

create trigger google_calendar_sync_jobs_automatic_dispatch
  after insert or update of
    status,
    available_at,
    desired_version,
    operation,
    automation_epoch,
    projection_stage
  on public.google_calendar_sync_jobs
  for each row execute function
    private.google_calendar_automatic_job_dispatch();

-- El contrato publico conserva epoch y mappings cuando OAuth reautoriza la
-- misma cuenta/calendario con una generacion nueva. La configuracion de cron
-- acompana solamente ese rebind exacto. Un retarget drenado limpia cron en la
-- misma transaccion; uno con mappings activos ya fue rechazado por el guard
-- publico antes de alcanzar este AFTER trigger.
create or replace function private.sync_google_calendar_automatic_binding()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_config private.google_calendar_automatic_config%rowtype;
  v_named_jobs integer;
begin
  select config.* into v_config
  from private.google_calendar_automatic_config config
  where config.id = true
  for update;
  if not found or not v_config.enabled then
    return new;
  end if;

  if new.automation_enabled
    and new.automation_epoch = v_config.automation_epoch
    and new.automation_google_account_id = v_config.google_account_id
    and new.automation_google_calendar_id = v_config.google_calendar_id
    and new.google_account_id = v_config.google_account_id
    and new.google_calendar_id = v_config.google_calendar_id
    and new.automation_connection_generation = new.connection_generation
  then
    update private.google_calendar_automatic_config config
    set connection_generation = new.connection_generation,
        updated_at = clock_timestamp()
    where config.id = true
      and config.enabled
      and config.automation_epoch = v_config.automation_epoch
      and config.google_account_id = v_config.google_account_id
      and config.google_calendar_id = v_config.google_calendar_id;
    return new;
  end if;

  if old.automation_epoch = v_config.automation_epoch
    and not new.automation_enabled
    and new.automation_epoch is null
  then
    if exists (
      select 1
      from public.google_calendar_sync_jobs job
      where job.automation_epoch = v_config.automation_epoch
        and (
          job.status <> 'succeeded'
          or job.projection_stage <> 'absent'
          or job.projected_stage <> 'absent'
        )
    ) then
      raise exception 'GOOGLE_CALENDAR_AUTOMATION_MAPPINGS_PENDING'
        using errcode = '55000';
    end if;

    select count(*) into v_named_jobs
    from cron.job job
    where job.jobname = 'google-calendar-automatic-sync';
    if v_named_jobs > 1
      or (
        v_named_jobs = 1
        and not exists (
          select 1 from cron.job job
          where job.jobid = v_config.cron_job_id
            and job.jobname = 'google-calendar-automatic-sync'
            and job.schedule = '* * * * *'
            and job.command =
              'select private.invoke_google_calendar_automatic_sync();'
            and job.database = current_database()
            and job.username = 'postgres'
        )
      )
    then
      raise exception 'GOOGLE_CALENDAR_AUTOMATION_JOB_MISMATCH'
        using errcode = '55000';
    end if;
    if v_named_jobs = 1
      and not cron.unschedule(v_config.cron_job_id)
    then
      raise exception 'GOOGLE_CALENDAR_AUTOMATION_UNSCHEDULE_FAILED'
        using errcode = '55000';
    end if;

    update private.google_calendar_automatic_config config
    set enabled = false,
        project_url_secret_id = null,
        cron_secret_id = null,
        cron_job_id = null,
        automation_epoch = null,
        google_account_id = null,
        google_calendar_id = null,
        connection_generation = null,
        activated_at = null,
        deactivated_at = clock_timestamp(),
        last_requested_at = null,
        last_response_observed_at = null,
        last_response_outcome = null,
        last_response_error_code = null,
        updated_at = clock_timestamp()
    where config.id = true;
    return new;
  end if;

  -- Nunca se retargetea ni se inventa un epoch desde la configuracion privada.
  raise exception 'GOOGLE_CALENDAR_AUTOMATION_BINDING_MISMATCH'
    using errcode = '55000';
end;
$$;

create trigger zz_google_calendar_automatic_config_binding
  after update of
    status,
    google_account_id,
    google_calendar_id,
    connection_generation,
    automation_enabled,
    automation_epoch,
    automation_google_account_id,
    automation_google_calendar_id,
    automation_connection_generation
  on public.google_calendar_connections
  for each row execute function
    private.sync_google_calendar_automatic_binding();

create or replace function private.install_google_calendar_automatic_schedule(
  p_expected_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_config private.google_calendar_automatic_config%rowtype;
  v_connection public.google_calendar_connections%rowtype;
  v_project_url_secret_id uuid;
  v_cron_secret_id uuid;
  v_project_url text;
  v_cron_secret text;
  v_count integer;
  v_job_id bigint;
  v_epoch uuid;
  v_command constant text :=
    'select private.invoke_google_calendar_automatic_sync();';
begin
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if p_expected_generation is null or p_expected_generation <= 0 then
    raise exception 'INVALID_CONNECTION_GENERATION' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_automatic_schedule', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );

  select config.* into v_config
  from private.google_calendar_automatic_config config
  where config.id = true
  for update;
  if not found then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_CONFIG_MISSING'
      using errcode = '55000';
  end if;
  if v_config.enabled then
    if v_config.connection_generation = p_expected_generation
      and private.google_calendar_automatic_schedule_is_consistent()
    then
      return jsonb_build_object(
        'enabled', true,
        'automationEpoch', v_config.automation_epoch,
        'jobId', v_config.cron_job_id,
        'schedule', '* * * * *'
      );
    end if;
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_ALREADY_CONFIGURED'
      using errcode = '55000';
  end if;

  if to_regclass('cron.job') is null
    or to_regclass('cron.job_run_details') is null
    or to_regclass('net._http_response') is null
    or to_regprocedure('cron.schedule(text,text,text)') is null
    or to_regprocedure('cron.unschedule(bigint)') is null
    or to_regprocedure(
      'net.http_post(text,jsonb,jsonb,jsonb,integer)'
    ) is null
  then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_EXTENSIONS_UNAVAILABLE'
      using errcode = '55000';
  end if;
  perform net.check_worker_is_up();

  select connection.* into v_connection
  from public.google_calendar_connections connection
  where connection.id = true
  for update;
  if not found or v_connection.connection_generation <> p_expected_generation
  then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_GENERATION_MISMATCH'
      using errcode = '55000';
  end if;

  -- Un lease o worker anterior en curso podria escribir con una fotografia
  -- previa. Los jobs legacy pendientes quedan intactos y fuera del epoch.
  if exists (
    select 1 from public.google_calendar_sync_jobs job
    where job.status = 'processing'
  ) then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_UNSAFE_PRIOR_WORK'
      using errcode = '55000';
  end if;

  -- Estados de cleanup externos anteriores quedan deliberadamente excluidos.
  -- Esta automatizacion no los reclama ni exige mutar Google para activarse.

  select count(*) into v_count
  from vault.secrets secret
  where secret.name = 'google_calendar_automation_project_url';
  if v_count <> 1 then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_PROJECT_URL_AMBIGUOUS'
      using errcode = '55000';
  end if;
  select secret.id into v_project_url_secret_id
  from vault.secrets secret
  where secret.name = 'google_calendar_automation_project_url';

  select count(*) into v_count
  from vault.secrets secret
  where secret.name = 'google_calendar_automation_cron_secret';
  if v_count <> 1 then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_CRON_SECRET_AMBIGUOUS'
      using errcode = '55000';
  end if;
  select secret.id into v_cron_secret_id
  from vault.secrets secret
  where secret.name = 'google_calendar_automation_cron_secret';

  v_project_url := private.google_calendar_automatic_vault_value(
    v_project_url_secret_id,
    'google_calendar_automation_project_url'
  );
  v_cron_secret := private.google_calendar_automatic_vault_value(
    v_cron_secret_id,
    'google_calendar_automation_cron_secret'
  );
  if v_project_url <> 'https://qcthvykjlwqdrmpkxisc.supabase.co'
    or octet_length(v_cron_secret) < 32
    or v_cron_secret ~ E'[\\r\\n]'
  then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_CONFIGURATION_INVALID'
      using errcode = '22023';
  end if;

  select count(*) into v_count
  from cron.job job
  where job.jobname = 'google-calendar-automatic-sync';
  if v_count <> 0 then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_JOB_COLLISION'
      using errcode = '55000';
  end if;

  -- schedule + epoch + config pertenecen a la misma transaccion: cualquier
  -- validacion posterior revierte los tres sin dejar un cron a medias.
  v_job_id := cron.schedule(
    'google-calendar-automatic-sync',
    '* * * * *',
    v_command
  );
  if v_job_id is null or not exists (
    select 1 from cron.job job
    where job.jobid = v_job_id
      and job.jobname = 'google-calendar-automatic-sync'
      and job.schedule = '* * * * *'
      and job.command = v_command
      and job.database = current_database()
      and job.username = 'postgres'
      and job.active
  ) then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_JOB_INSTALLATION_FAILED'
      using errcode = '55000';
  end if;

  v_epoch := public.activate_google_calendar_automation(
    p_expected_generation
  );
  select connection.* into v_connection
  from public.google_calendar_connections connection
  where connection.id = true
    and connection.automation_enabled
    and connection.automation_epoch = v_epoch
    and connection.automation_google_account_id = connection.google_account_id
    and connection.automation_google_calendar_id = connection.google_calendar_id
    and connection.automation_connection_generation = p_expected_generation;
  if not found then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_ACTIVATION_FAILED'
      using errcode = '55000';
  end if;

  update private.google_calendar_automatic_config config
  set enabled = true,
      project_url_secret_id = v_project_url_secret_id,
      cron_secret_id = v_cron_secret_id,
      cron_job_id = v_job_id,
      automation_epoch = v_epoch,
      google_account_id = v_connection.google_account_id,
      google_calendar_id = v_connection.google_calendar_id,
      connection_generation = v_connection.connection_generation,
      activated_at = v_connection.automation_activated_at,
      deactivated_at = null,
      last_requested_at = null,
      last_response_observed_at = null,
      last_response_outcome = null,
      last_response_error_code = null,
      updated_at = clock_timestamp()
  where config.id = true and not config.enabled;
  if not found
    or not private.google_calendar_automatic_schedule_is_consistent()
  then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_INSTALLATION_INCONSISTENT'
      using errcode = '55000';
  end if;

  return jsonb_build_object(
    'enabled', true,
    'automationEpoch', v_epoch,
    'jobId', v_job_id,
    'schedule', '* * * * *'
  );
end;
$$;

create or replace function private.uninstall_google_calendar_automatic_schedule()
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_config private.google_calendar_automatic_config%rowtype;
  v_named_jobs integer;
  v_removed integer := 0;
begin
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_automatic_schedule', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );

  select config.* into v_config
  from private.google_calendar_automatic_config config
  where config.id = true
  for update;
  if not found then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_CONFIG_MISSING'
      using errcode = '55000';
  end if;

  select count(*) into v_named_jobs
  from cron.job job
  where job.jobname = 'google-calendar-automatic-sync';

  if not v_config.enabled then
    if v_named_jobs <> 0 then
      raise exception 'GOOGLE_CALENDAR_AUTOMATION_JOB_COLLISION'
        using errcode = '55000';
    end if;
    return 0;
  end if;

  if not exists (
    select 1
    from public.google_calendar_connections connection
    where connection.id = true
      and connection.automation_enabled
      and connection.automation_epoch = v_config.automation_epoch
      and connection.automation_google_account_id = v_config.google_account_id
      and connection.automation_google_calendar_id = v_config.google_calendar_id
      and connection.automation_connection_generation =
        v_config.connection_generation
  ) then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_BINDING_MISMATCH'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.google_calendar_connections connection
    where connection.id = true
      and connection.inbound_lease_token is not null
      and connection.inbound_lease_expires_at > clock_timestamp()
  ) or exists (
    select 1
    from public.google_calendar_sync_jobs job
    where job.automation_epoch = v_config.automation_epoch
      and (
        job.status <> 'succeeded'
        or job.projection_stage <> 'absent'
        or job.projected_stage <> 'absent'
      )
  ) then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_MAPPINGS_PENDING'
      using errcode = '55000';
  end if;

  if v_named_jobs > 1
    or (
      v_named_jobs = 1
      and not exists (
        select 1 from cron.job job
        where job.jobid = v_config.cron_job_id
          and job.jobname = 'google-calendar-automatic-sync'
          and job.schedule = '* * * * *'
          and job.command =
            'select private.invoke_google_calendar_automatic_sync();'
          and job.database = current_database()
          and job.username = 'postgres'
      )
    )
  then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_JOB_MISMATCH'
      using errcode = '55000';
  end if;

  if v_named_jobs = 1 then
    if not cron.unschedule(v_config.cron_job_id) then
      raise exception 'GOOGLE_CALENDAR_AUTOMATION_UNSCHEDULE_FAILED'
        using errcode = '55000';
    end if;
    v_removed := 1;
  end if;

  update public.google_calendar_connections connection
  set automation_enabled = false,
      automation_epoch = null,
      automation_activated_at = null,
      automation_google_account_id = null,
      automation_google_calendar_id = null,
      automation_connection_generation = null
  where connection.id = true
    and connection.automation_epoch = v_config.automation_epoch;
  if not found then
    raise exception 'GOOGLE_CALENDAR_AUTOMATION_DEACTIVATION_RACE'
      using errcode = '40001';
  end if;

  update private.google_calendar_automatic_config config
  set enabled = false,
      project_url_secret_id = null,
      cron_secret_id = null,
      cron_job_id = null,
      automation_epoch = null,
      google_account_id = null,
      google_calendar_id = null,
      connection_generation = null,
      activated_at = null,
      deactivated_at = clock_timestamp(),
      last_requested_at = null,
      last_response_observed_at = null,
      last_response_outcome = null,
      last_response_error_code = null,
      updated_at = clock_timestamp()
  where config.id = true;

  insert into public.audit_logs (action, entity_type, metadata)
  values (
    'google_calendar.automation_deactivated',
    'google_calendar',
    jsonb_build_object('removed_jobs', v_removed)
  );
  return v_removed;
end;
$$;

create or replace function private.google_calendar_automatic_schedule_status()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_result jsonb;
begin
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'enabled', config.enabled,
    'configurationConsistent',
      private.google_calendar_automatic_schedule_is_consistent(),
    'configuredJobs', (
      select count(*) from cron.job job
      where job.jobname = 'google-calendar-automatic-sync'
    ),
    'activeJobs', (
      select count(*) from cron.job job
      where job.jobname = 'google-calendar-automatic-sync' and job.active
    ),
    'pendingResponses', (
      select count(*)
      from private.google_calendar_automatic_http_attempts attempt
      where attempt.outcome = 'pending'
    ),
    'successfulResponses', (
      select count(*)
      from private.google_calendar_automatic_http_attempts attempt
      where attempt.outcome = 'success'
    ),
    'failedResponses', (
      select count(*)
      from private.google_calendar_automatic_http_attempts attempt
      where attempt.outcome not in ('pending', 'success')
    ),
    'lastRequestId', (
      select max(attempt.request_id)
      from private.google_calendar_automatic_http_attempts attempt
    )
  ) into v_result
  from private.google_calendar_automatic_config config
  where config.id = true;
  return v_result;
end;
$$;

revoke all on function private.google_calendar_automatic_vault_value(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.google_calendar_automatic_schedule_is_consistent()
  from public, anon, authenticated, service_role;
revoke all on function private.google_calendar_automatic_operational_error()
  from public, anon, authenticated, service_role;
revoke all on function private.capture_google_calendar_automatic_responses()
  from public, anon, authenticated, service_role;
revoke all on function private.dispatch_google_calendar_automatic_sync(text)
  from public, anon, authenticated, service_role;
revoke all on function private.invoke_google_calendar_automatic_sync()
  from public, anon, authenticated, service_role;
revoke all on function private.google_calendar_automatic_job_dispatch()
  from public, anon, authenticated, service_role;
revoke all on function private.sync_google_calendar_automatic_binding()
  from public, anon, authenticated, service_role;
revoke all on function private.install_google_calendar_automatic_schedule(bigint)
  from public, anon, authenticated, service_role;
revoke all on function private.uninstall_google_calendar_automatic_schedule()
  from public, anon, authenticated, service_role;
revoke all on function private.google_calendar_automatic_schedule_status()
  from public, anon, authenticated, service_role;

grant execute on function private.google_calendar_automatic_vault_value(uuid, text)
  to postgres;
grant execute on function private.google_calendar_automatic_schedule_is_consistent()
  to postgres;
grant execute on function private.google_calendar_automatic_operational_error()
  to postgres;
grant execute on function private.capture_google_calendar_automatic_responses()
  to postgres;
grant execute on function private.dispatch_google_calendar_automatic_sync(text)
  to postgres;
grant execute on function private.invoke_google_calendar_automatic_sync()
  to postgres;
grant execute on function private.google_calendar_automatic_job_dispatch()
  to postgres;
grant execute on function private.sync_google_calendar_automatic_binding()
  to postgres;
grant execute on function private.install_google_calendar_automatic_schedule(bigint)
  to postgres;
grant execute on function private.uninstall_google_calendar_automatic_schedule()
  to postgres;
grant execute on function private.google_calendar_automatic_schedule_status()
  to postgres;

-- El campo publico refleja el scheduler real. Si alguien borra, pausa o cambia
-- cron manualmente, la UI informa inactivo aunque el flag de conexion siga true.
drop function public.google_calendar_status();
create or replace function public.google_calendar_status()
returns table (
  connected boolean,
  status text,
  selection_pending boolean,
  google_account_email text,
  google_calendar_name text,
  google_calendar_timezone text,
  last_synced_at timestamptz,
  last_checked_at timestamptz,
  last_sync_completed_at timestamptz,
  last_sync_summary jsonb,
  last_sync_error text,
  last_error text,
  inbound_sync_state text,
  inbound_first_import_approved boolean,
  pending_count bigint,
  failed_count bigint,
  active_block_count bigint,
  unsupported_event_count bigint,
  pending_conflict_count bigint,
  automation_enabled boolean,
  automation_activated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault, private
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  perform public.purge_expired_google_calendar_connection_candidate();
  perform private.capture_google_calendar_automatic_responses();

  return query
  select connection.status = 'connected',
         connection.status,
         exists (
           select 1
           from public.google_calendar_connection_candidates candidate
           join public.google_calendar_connections current_connection
             on current_connection.id = true
            and current_connection.connection_generation =
              candidate.connection_generation
            and current_connection.oauth_attempt_generation =
              candidate.oauth_attempt_generation
           where candidate.id = true
             and candidate.expires_at > clock_timestamp()
         ),
         connection.google_account_email,
         connection.google_calendar_name,
         connection.google_calendar_timezone,
         connection.last_synced_at,
         connection.last_checked_at,
         connection.last_sync_completed_at,
         connection.last_sync_summary,
         coalesce(
           private.google_calendar_automatic_operational_error(),
           connection.last_sync_error
         ),
         connection.last_error,
         connection.inbound_sync_state,
         connection.inbound_first_import_approved_at is not null
           and connection.sync_scope_google_account_id is not distinct from
             connection.google_account_id
           and connection.sync_scope_google_calendar_id is not distinct from
             connection.google_calendar_id
           and connection.sync_scope_generation =
             connection.connection_generation,
         (select count(*)
          from public.google_calendar_sync_jobs job
          where job.status in ('pending', 'processing')
            and job.automation_epoch = connection.automation_epoch
            and job.authorized_google_account_id =
              connection.automation_google_account_id
            and job.authorized_google_calendar_id =
              connection.automation_google_calendar_id
            and job.authorized_connection_generation =
              connection.automation_connection_generation),
         (select count(*)
          from public.google_calendar_sync_jobs job
          where job.status = 'failed'
            and job.automation_epoch = connection.automation_epoch
            and job.authorized_google_account_id =
              connection.automation_google_account_id
            and job.authorized_google_calendar_id =
              connection.automation_google_calendar_id
            and job.authorized_connection_generation =
              connection.automation_connection_generation),
         (select count(*)
          from public.google_calendar_external_events event
          where event.kind = 'block'
            and (
              event.status = 'active'
              or (
                event.status = 'converted'
                and event.external_cleanup_status in ('pending', 'failed')
              )
            )
            and event.google_calendar_id = connection.google_calendar_id
            and event.connection_generation =
              connection.connection_generation),
         (select count(*)
          from public.google_calendar_external_events event
          where event.kind = 'unsupported'
            and event.status = 'active'
            and event.google_calendar_id = connection.google_calendar_id
            and event.connection_generation =
              connection.connection_generation),
         (select count(*)
          from public.google_calendar_sync_conflicts conflict
          where conflict.status = 'pending'
            and conflict.connection_generation =
              connection.connection_generation),
         private.google_calendar_automatic_schedule_is_consistent(),
         case
           when private.google_calendar_automatic_schedule_is_consistent()
           then connection.automation_activated_at
           else null
         end
  from public.google_calendar_connections connection
  where connection.id = true;
end;
$$;

revoke execute on function public.google_calendar_status()
  from public, anon, authenticated;
grant execute on function public.google_calendar_status() to service_role;
