-- Recovery durable para las colas de WhatsApp. Esta migración instala sólo la
-- infraestructura desactivada: la activación remota es un paso explícito una
-- vez que los secretos dedicados existen tanto en Edge Functions como Vault.

create extension if not exists supabase_vault;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'supabase_vault')
    or not exists (select 1 from pg_extension where extname = 'pg_net')
    or not exists (select 1 from pg_extension where extname = 'pg_cron')
  then
    raise exception 'WHATSAPP_RECOVERY_EXTENSIONS_UNAVAILABLE'
      using errcode = '55000';
  end if;
end;
$$;

-- Supabase administra y posee los ACL de pg_net/pg_cron. La frontera de esta
-- integración es el schema `private` postgres-only; `net` y `cron` nunca deben
-- agregarse a los schemas expuestos por PostgREST. El preflight operativo debe
-- verificar ese ajuste externo antes de cargar secretos o crear jobs.

-- Refuerza las revocaciones ya aplicadas por Google Calendar sin quitar el
-- acceso que sus funciones SECURITY DEFINER necesitan como owner.
revoke all on table vault.secrets from public, anon, authenticated;
revoke all on table vault.decrypted_secrets from public, anon, authenticated;
revoke execute on function vault.create_secret(text, text, text, uuid)
  from public, anon, authenticated;
revoke execute on function vault.update_secret(uuid, text, text, text, uuid)
  from public, anon, authenticated;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;
grant usage on schema private to postgres;

create table private.whatsapp_recovery_config (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  project_url_secret_id uuid,
  coexistence_secret_id uuid,
  automation_outbox_secret_id uuid,
  coexistence_job_id bigint,
  automation_outbox_job_id bigint,
  activated_at timestamptz,
  deactivated_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint whatsapp_recovery_enabled_config check (
    not enabled
    or (
      project_url_secret_id is not null
      and coexistence_secret_id is not null
      and automation_outbox_secret_id is not null
      and coexistence_job_id is not null
      and automation_outbox_job_id is not null
    )
  )
);

insert into private.whatsapp_recovery_config (id)
values (true)
on conflict (id) do nothing;

create table private.whatsapp_recovery_http_attempts (
  request_id bigint primary key,
  processor text not null
    check (processor in ('coexistence', 'automation_outbox')),
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

create index whatsapp_recovery_http_attempts_pending_idx
  on private.whatsapp_recovery_http_attempts (requested_at)
  where outcome = 'pending';

alter table private.whatsapp_recovery_config enable row level security;
alter table private.whatsapp_recovery_http_attempts enable row level security;
revoke all on table private.whatsapp_recovery_config
  from public, anon, authenticated, service_role;
revoke all on table private.whatsapp_recovery_http_attempts
  from public, anon, authenticated, service_role;
grant all on table private.whatsapp_recovery_config to postgres;
grant all on table private.whatsapp_recovery_http_attempts to postgres;

comment on table private.whatsapp_recovery_config is
  'Configuración postgres-only. Comienza desactivada y referencia secretos cifrados por UUID.';
comment on table private.whatsapp_recovery_http_attempts is
  'Auditoría sanitizada de request IDs y respuestas pg_net; nunca guarda URL, headers, body crudo ni secretos.';

create or replace function private.whatsapp_recovery_vault_value(
  p_secret_id uuid,
  p_expected_name text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  secret_count integer;
  secret_value text;
begin
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  select count(*), min(decrypted_secret)
  into secret_count, secret_value
  from vault.decrypted_secrets
  where id = p_secret_id and name = p_expected_name;

  if secret_count <> 1 or secret_value is null then
    raise exception 'WHATSAPP_RECOVERY_VAULT_SECRET_UNAVAILABLE'
      using errcode = '55000';
  end if;
  return secret_value;
end;
$$;

create or replace function private.capture_whatsapp_recovery_responses()
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  current_response record;
  parsed_body jsonb;
  summary jsonb;
  next_outcome text;
  next_error_code text;
  captured integer := 0;
  missing integer := 0;
begin
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  for current_response in
    select
      attempt.request_id,
      response.status_code,
      response.timed_out,
      response.error_msg,
      response.content,
      response.created
    from private.whatsapp_recovery_http_attempts attempt
    join net._http_response response on response.id = attempt.request_id
    where attempt.outcome = 'pending'
    order by attempt.request_id
    for update of attempt
  loop
    parsed_body := null;
    summary := '{}'::jsonb;
    begin
      if current_response.content is not null then
        parsed_body := current_response.content::jsonb;
      end if;
    exception when others then
      parsed_body := null;
    end;

    if parsed_body is not null and jsonb_typeof(parsed_body) = 'object' then
      summary := jsonb_strip_nulls(jsonb_build_object(
        'processed', parsed_body -> 'processed',
        'claimed', parsed_body -> 'claimed',
        'completed', parsed_body -> 'completed',
        'yielded', parsed_body -> 'yielded',
        'failed', parsed_body -> 'failed',
        'processedItems', parsed_body -> 'processedItems'
      ));
    end if;

    if coalesce(current_response.timed_out, false) then
      next_outcome := 'timeout';
      next_error_code := 'TIMEOUT';
    elsif current_response.error_msg is not null then
      next_outcome := 'network_error';
      next_error_code := 'NETWORK_ERROR';
    elsif current_response.status_code is distinct from 200 then
      next_outcome := 'http_error';
      next_error_code := 'HTTP_' || coalesce(current_response.status_code::text, 'UNKNOWN');
    elsif parsed_body is null
      or jsonb_typeof(parsed_body) <> 'object'
      or parsed_body -> 'processed' is distinct from 'true'::jsonb
      or jsonb_typeof(parsed_body -> 'claimed') is distinct from 'number'
      or jsonb_typeof(parsed_body -> 'failed') is distinct from 'number'
    then
      next_outcome := 'invalid_response';
      next_error_code := 'INVALID_RESPONSE';
    elsif (parsed_body ->> 'failed')::numeric <> 0 then
      next_outcome := 'processor_error';
      next_error_code := 'PROCESSOR_FAILED';
    else
      next_outcome := 'success';
      next_error_code := null;
    end if;

    update private.whatsapp_recovery_http_attempts
    set response_observed_at = coalesce(current_response.created, clock_timestamp()),
        status_code = current_response.status_code,
        timed_out = current_response.timed_out,
        outcome = next_outcome,
        error_code = next_error_code,
        sanitized_summary = summary
    where request_id = current_response.request_id;
    captured := captured + 1;
  end loop;

  update private.whatsapp_recovery_http_attempts
  set response_observed_at = clock_timestamp(),
      outcome = 'response_missing',
      error_code = 'RESPONSE_MISSING'
  where outcome = 'pending'
    and requested_at < clock_timestamp() - interval '15 minutes';
  get diagnostics missing = row_count;

  delete from private.whatsapp_recovery_http_attempts
  where requested_at < clock_timestamp() - interval '30 days';

  return captured + missing;
end;
$$;

create or replace function private.invoke_whatsapp_recovery(
  p_processor text
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  recovery_config private.whatsapp_recovery_config%rowtype;
  project_url text;
  recovery_secret text;
  secret_id uuid;
  secret_name text;
  endpoint_path text;
  expected_job_id bigint;
  expected_job_name text;
  expected_job_command text;
  request_id bigint;
begin
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('whatsapp_recovery_schedule', 0)
  );

  perform private.capture_whatsapp_recovery_responses();

  select * into recovery_config
  from private.whatsapp_recovery_config
  where id = true;
  if not found or not recovery_config.enabled then
    raise exception 'WHATSAPP_RECOVERY_DISABLED' using errcode = '55000';
  end if;

  project_url := private.whatsapp_recovery_vault_value(
    recovery_config.project_url_secret_id,
    'whatsapp_recovery_project_url'
  );
  if project_url <> 'https://qcthvykjlwqdrmpkxisc.supabase.co' then
    raise exception 'WHATSAPP_RECOVERY_PROJECT_URL_MISMATCH'
      using errcode = '22023';
  end if;

  case p_processor
    when 'coexistence' then
      secret_id := recovery_config.coexistence_secret_id;
      secret_name := 'whatsapp_coexistence_recovery_secret';
      endpoint_path := '/functions/v1/process-whatsapp-coexistence';
      expected_job_id := recovery_config.coexistence_job_id;
      expected_job_name := 'whatsapp-coexistence-recovery';
      expected_job_command :=
        'select private.invoke_whatsapp_recovery(''coexistence'');';
    when 'automation_outbox' then
      secret_id := recovery_config.automation_outbox_secret_id;
      secret_name := 'whatsapp_automation_outbox_recovery_secret';
      endpoint_path := '/functions/v1/process-whatsapp-automation-outbox';
      expected_job_id := recovery_config.automation_outbox_job_id;
      expected_job_name := 'whatsapp-automation-outbox-recovery';
      expected_job_command :=
        'select private.invoke_whatsapp_recovery(''automation_outbox'');';
    else
      raise exception 'WHATSAPP_RECOVERY_PROCESSOR_INVALID'
        using errcode = '22023';
  end case;

  if not exists (
    select 1 from cron.job
    where jobid = expected_job_id
      and jobname = expected_job_name
      and schedule = '* * * * *'
      and command = expected_job_command
      and database = current_database()
      and username = 'postgres'
      and active
  ) then
    raise exception 'WHATSAPP_RECOVERY_JOB_MISMATCH' using errcode = '55000';
  end if;

  recovery_secret := private.whatsapp_recovery_vault_value(
    secret_id,
    secret_name
  );
  if octet_length(recovery_secret) < 32
    or recovery_secret ~ E'[\\r\\n]'
  then
    raise exception 'WHATSAPP_RECOVERY_SECRET_INVALID'
      using errcode = '22023';
  end if;

  request_id := net.http_post(
    url := project_url || endpoint_path,
    body := '{}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-recovery-secret', recovery_secret
    ),
    timeout_milliseconds := 30000
  );
  if request_id is null then
    raise exception 'WHATSAPP_RECOVERY_REQUEST_NOT_QUEUED'
      using errcode = '55000';
  end if;

  insert into private.whatsapp_recovery_http_attempts (
    request_id, processor
  ) values (
    request_id, p_processor
  );
  return request_id;
end;
$$;

create or replace function private.install_whatsapp_recovery_schedule()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_config private.whatsapp_recovery_config%rowtype;
  v_existing_job record;
  v_project_url_secret_id uuid;
  v_coexistence_secret_id uuid;
  v_automation_outbox_secret_id uuid;
  v_project_url text;
  v_coexistence_secret text;
  v_automation_outbox_secret text;
  v_matching_count integer;
  v_previous_job_id bigint;
  v_coexistence_job_id bigint;
  v_automation_outbox_job_id bigint;
  v_coexistence_command constant text :=
    'select private.invoke_whatsapp_recovery(''coexistence'');';
  v_automation_outbox_command constant text :=
    'select private.invoke_whatsapp_recovery(''automation_outbox'');';
begin
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('whatsapp_recovery_schedule', 0)
  );

  select * into v_config
  from private.whatsapp_recovery_config
  where id = true
  for update;
  if not found then
    raise exception 'WHATSAPP_RECOVERY_CONFIG_MISSING' using errcode = '55000';
  end if;

  if to_regclass('cron.job') is null
    or to_regclass('cron.job_run_details') is null
    or to_regclass('net._http_response') is null
    or to_regprocedure('cron.schedule(text,text,text)') is null
    or to_regprocedure('cron.unschedule(bigint)') is null
    or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
  then
    raise exception 'WHATSAPP_RECOVERY_EXTENSIONS_UNAVAILABLE'
      using errcode = '55000';
  end if;
  perform net.check_worker_is_up();

  select count(*) into v_matching_count
  from vault.secrets where name = 'whatsapp_recovery_project_url';
  if v_matching_count <> 1 then
    raise exception 'WHATSAPP_RECOVERY_PROJECT_URL_AMBIGUOUS'
      using errcode = '55000';
  end if;
  select id into v_project_url_secret_id
  from vault.secrets where name = 'whatsapp_recovery_project_url';

  select count(*) into v_matching_count
  from vault.secrets where name = 'whatsapp_coexistence_recovery_secret';
  if v_matching_count <> 1 then
    raise exception 'WHATSAPP_COEXISTENCE_RECOVERY_SECRET_AMBIGUOUS'
      using errcode = '55000';
  end if;
  select id into v_coexistence_secret_id
  from vault.secrets where name = 'whatsapp_coexistence_recovery_secret';

  select count(*) into v_matching_count
  from vault.secrets
  where name = 'whatsapp_automation_outbox_recovery_secret';
  if v_matching_count <> 1 then
    raise exception 'WHATSAPP_AUTOMATION_RECOVERY_SECRET_AMBIGUOUS'
      using errcode = '55000';
  end if;
  select id into v_automation_outbox_secret_id
  from vault.secrets
  where name = 'whatsapp_automation_outbox_recovery_secret';

  v_project_url := private.whatsapp_recovery_vault_value(
    v_project_url_secret_id,
    'whatsapp_recovery_project_url'
  );
  v_coexistence_secret := private.whatsapp_recovery_vault_value(
    v_coexistence_secret_id,
    'whatsapp_coexistence_recovery_secret'
  );
  v_automation_outbox_secret := private.whatsapp_recovery_vault_value(
    v_automation_outbox_secret_id,
    'whatsapp_automation_outbox_recovery_secret'
  );

  if v_project_url <> 'https://qcthvykjlwqdrmpkxisc.supabase.co'
    or octet_length(v_coexistence_secret) < 32
    or octet_length(v_automation_outbox_secret) < 32
    or v_coexistence_secret = v_automation_outbox_secret
    or v_coexistence_secret ~ E'[\\r\\n]'
    or v_automation_outbox_secret ~ E'[\\r\\n]'
  then
    raise exception 'WHATSAPP_RECOVERY_CONFIGURATION_INVALID'
      using errcode = '22023';
  end if;

  select count(*) into v_matching_count from cron.job
  where jobname = 'whatsapp-coexistence-recovery';
  if v_matching_count > 1 then
    raise exception 'WHATSAPP_RECOVERY_JOB_DUPLICATE'
      using errcode = '55000';
  elsif v_matching_count = 1 then
    select * into v_existing_job from cron.job
    where jobname = 'whatsapp-coexistence-recovery';
    if v_existing_job.schedule <> '* * * * *'
      or v_existing_job.command <> v_coexistence_command
      or v_existing_job.database <> current_database()
      or v_existing_job.username <> 'postgres'
      or (
        v_config.coexistence_job_id is not null
        and v_existing_job.jobid <> v_config.coexistence_job_id
      )
    then
      raise exception 'WHATSAPP_RECOVERY_JOB_COLLISION'
        using errcode = '55000';
    end if;
    v_previous_job_id := v_existing_job.jobid;
    perform cron.unschedule(v_previous_job_id);
  end if;

  select count(*) into v_matching_count from cron.job
  where jobname = 'whatsapp-automation-outbox-recovery';
  if v_matching_count > 1 then
    raise exception 'WHATSAPP_RECOVERY_JOB_DUPLICATE'
      using errcode = '55000';
  elsif v_matching_count = 1 then
    select * into v_existing_job from cron.job
    where jobname = 'whatsapp-automation-outbox-recovery';
    if v_existing_job.schedule <> '* * * * *'
      or v_existing_job.command <> v_automation_outbox_command
      or v_existing_job.database <> current_database()
      or v_existing_job.username <> 'postgres'
      or (
        v_config.automation_outbox_job_id is not null
        and v_existing_job.jobid <> v_config.automation_outbox_job_id
      )
    then
      raise exception 'WHATSAPP_RECOVERY_JOB_COLLISION'
        using errcode = '55000';
    end if;
    v_previous_job_id := v_existing_job.jobid;
    perform cron.unschedule(v_previous_job_id);
  end if;

  v_coexistence_job_id := cron.schedule(
    'whatsapp-coexistence-recovery',
    '* * * * *',
    v_coexistence_command
  );
  v_automation_outbox_job_id := cron.schedule(
    'whatsapp-automation-outbox-recovery',
    '* * * * *',
    v_automation_outbox_command
  );

  if v_coexistence_job_id is null
    or v_automation_outbox_job_id is null
    or v_coexistence_job_id = v_automation_outbox_job_id
    or not exists (
      select 1 from cron.job
      where jobid = v_coexistence_job_id
        and jobname = 'whatsapp-coexistence-recovery'
        and schedule = '* * * * *'
        and command = v_coexistence_command
        and database = current_database()
        and username = current_user
        and active
    )
    or not exists (
      select 1 from cron.job
      where jobid = v_automation_outbox_job_id
        and jobname = 'whatsapp-automation-outbox-recovery'
        and schedule = '* * * * *'
        and command = v_automation_outbox_command
        and database = current_database()
        and username = current_user
        and active
    )
  then
    raise exception 'WHATSAPP_RECOVERY_JOB_INSTALLATION_FAILED'
      using errcode = '55000';
  end if;

  update private.whatsapp_recovery_config
  set enabled = true,
      project_url_secret_id = v_project_url_secret_id,
      coexistence_secret_id = v_coexistence_secret_id,
      automation_outbox_secret_id = v_automation_outbox_secret_id,
      coexistence_job_id = v_coexistence_job_id,
      automation_outbox_job_id = v_automation_outbox_job_id,
      activated_at = clock_timestamp(),
      deactivated_at = null,
      updated_at = clock_timestamp()
  where id = true;

  if not found then
    raise exception 'WHATSAPP_RECOVERY_CONFIG_MISSING' using errcode = '55000';
  end if;

  return jsonb_build_object(
    'enabled', true,
    'jobs', jsonb_build_array(
      jsonb_build_object(
        'name', 'whatsapp-coexistence-recovery',
        'jobId', v_coexistence_job_id,
        'schedule', '* * * * *'
      ),
      jsonb_build_object(
        'name', 'whatsapp-automation-outbox-recovery',
        'jobId', v_automation_outbox_job_id,
        'schedule', '* * * * *'
      )
    )
  );
end;
$$;

create or replace function private.uninstall_whatsapp_recovery_schedule()
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_coexistence_job_id bigint;
  v_automation_outbox_job_id bigint;
  v_named_job_count integer;
  removed integer := 0;
begin
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('whatsapp_recovery_schedule', 0)
  );

  select coexistence_job_id, automation_outbox_job_id
  into v_coexistence_job_id, v_automation_outbox_job_id
  from private.whatsapp_recovery_config
  where id = true
  for update;
  if not found then
    raise exception 'WHATSAPP_RECOVERY_CONFIG_MISSING' using errcode = '55000';
  end if;

  select count(*) into v_named_job_count
  from cron.job
  where jobname in (
    'whatsapp-coexistence-recovery',
    'whatsapp-automation-outbox-recovery'
  );

  if v_coexistence_job_id is null
    and v_automation_outbox_job_id is null
  then
    if v_named_job_count <> 0 then
      raise exception 'WHATSAPP_RECOVERY_JOB_COLLISION'
        using errcode = '55000';
    end if;
  elsif v_coexistence_job_id is null
    or v_automation_outbox_job_id is null
    or v_named_job_count <> 2
    or not exists (
      select 1 from cron.job
      where jobid = v_coexistence_job_id
        and jobname = 'whatsapp-coexistence-recovery'
        and schedule = '* * * * *'
        and command =
          'select private.invoke_whatsapp_recovery(''coexistence'');'
        and database = current_database()
        and username = 'postgres'
    )
    or not exists (
      select 1 from cron.job
      where jobid = v_automation_outbox_job_id
        and jobname = 'whatsapp-automation-outbox-recovery'
        and schedule = '* * * * *'
        and command =
          'select private.invoke_whatsapp_recovery(''automation_outbox'');'
        and database = current_database()
        and username = 'postgres'
    )
  then
    raise exception 'WHATSAPP_RECOVERY_JOB_MISMATCH'
      using errcode = '55000';
  end if;

  if v_coexistence_job_id is not null then
    if not cron.unschedule(v_coexistence_job_id) then
      raise exception 'WHATSAPP_RECOVERY_UNSCHEDULE_FAILED'
        using errcode = '55000';
    end if;
    removed := removed + 1;
  end if;
  if v_automation_outbox_job_id is not null then
    if not cron.unschedule(v_automation_outbox_job_id) then
      raise exception 'WHATSAPP_RECOVERY_UNSCHEDULE_FAILED'
        using errcode = '55000';
    end if;
    removed := removed + 1;
  end if;

  if exists (
    select 1 from cron.job
    where jobname in (
      'whatsapp-coexistence-recovery',
      'whatsapp-automation-outbox-recovery'
    )
  ) then
    raise exception 'WHATSAPP_RECOVERY_UNSCHEDULE_INCOMPLETE'
      using errcode = '55000';
  end if;

  update private.whatsapp_recovery_config
  set enabled = false,
      coexistence_job_id = null,
      automation_outbox_job_id = null,
      deactivated_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = true;
  return removed;
end;
$$;

create or replace function private.whatsapp_recovery_schedule_status()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  result jsonb;
begin
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'enabled', config.enabled,
    'configuredJobs', (
      select count(*) from cron.job
      where jobname in (
        'whatsapp-coexistence-recovery',
        'whatsapp-automation-outbox-recovery'
      )
    ),
    'activeJobs', (
      select count(*) from cron.job
      where jobname in (
        'whatsapp-coexistence-recovery',
        'whatsapp-automation-outbox-recovery'
      ) and active
    ),
    'matchingJobs', (
      select count(*) from cron.job
      where (
        jobid = config.coexistence_job_id
        and jobname = 'whatsapp-coexistence-recovery'
        and schedule = '* * * * *'
        and command =
          'select private.invoke_whatsapp_recovery(''coexistence'');'
        and database = current_database()
        and username = 'postgres'
        and active
      ) or (
        jobid = config.automation_outbox_job_id
        and jobname = 'whatsapp-automation-outbox-recovery'
        and schedule = '* * * * *'
        and command =
          'select private.invoke_whatsapp_recovery(''automation_outbox'');'
        and database = current_database()
        and username = 'postgres'
        and active
      )
    ),
    'configurationConsistent', case
      when config.enabled then
        config.coexistence_job_id is not null
        and config.automation_outbox_job_id is not null
        and (
          select count(*) = 2 from cron.job
          where jobname in (
            'whatsapp-coexistence-recovery',
            'whatsapp-automation-outbox-recovery'
          )
        )
        and (
          select count(*) = 2 from cron.job
          where (
            jobid = config.coexistence_job_id
            and jobname = 'whatsapp-coexistence-recovery'
            and schedule = '* * * * *'
            and command =
              'select private.invoke_whatsapp_recovery(''coexistence'');'
            and database = current_database()
            and username = 'postgres'
            and active
          ) or (
            jobid = config.automation_outbox_job_id
            and jobname = 'whatsapp-automation-outbox-recovery'
            and schedule = '* * * * *'
            and command =
              'select private.invoke_whatsapp_recovery(''automation_outbox'');'
            and database = current_database()
            and username = 'postgres'
            and active
          )
        )
      else
        config.coexistence_job_id is null
        and config.automation_outbox_job_id is null
        and (
          select count(*) = 0 from cron.job
          where jobname in (
            'whatsapp-coexistence-recovery',
            'whatsapp-automation-outbox-recovery'
          )
        )
      end,
    'pendingResponses', (
      select count(*) from private.whatsapp_recovery_http_attempts
      where outcome = 'pending'
    ),
    'successfulResponses', (
      select count(*) from private.whatsapp_recovery_http_attempts
      where outcome = 'success'
    ),
    'failedResponses', (
      select count(*) from private.whatsapp_recovery_http_attempts
      where outcome not in ('pending', 'success')
    ),
    'lastRequestId', (
      select max(request_id) from private.whatsapp_recovery_http_attempts
    )
  ) into result
  from private.whatsapp_recovery_config config
  where config.id = true;
  return result;
end;
$$;

revoke all on function private.whatsapp_recovery_vault_value(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.capture_whatsapp_recovery_responses()
  from public, anon, authenticated, service_role;
revoke all on function private.invoke_whatsapp_recovery(text)
  from public, anon, authenticated, service_role;
revoke all on function private.install_whatsapp_recovery_schedule()
  from public, anon, authenticated, service_role;
revoke all on function private.uninstall_whatsapp_recovery_schedule()
  from public, anon, authenticated, service_role;
revoke all on function private.whatsapp_recovery_schedule_status()
  from public, anon, authenticated, service_role;

grant execute on function private.whatsapp_recovery_vault_value(uuid, text)
  to postgres;
grant execute on function private.capture_whatsapp_recovery_responses()
  to postgres;
grant execute on function private.invoke_whatsapp_recovery(text)
  to postgres;
grant execute on function private.install_whatsapp_recovery_schedule()
  to postgres;
grant execute on function private.uninstall_whatsapp_recovery_schedule()
  to postgres;
grant execute on function private.whatsapp_recovery_schedule_status()
  to postgres;

comment on function private.install_whatsapp_recovery_schedule() is
  'Activación explícita postgres-only. Valida Vault y reemplaza transaccionalmente sólo los dos jobs WhatsApp.';
comment on function private.uninstall_whatsapp_recovery_schedule() is
  'Rollback idempotente: desactiva y elimina únicamente los dos jobs WhatsApp sin tocar Vault ni extensiones.';
