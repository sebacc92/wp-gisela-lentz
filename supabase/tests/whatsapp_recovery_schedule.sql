\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(45);

select ok(
  (
    select count(*) = 3
    from pg_catalog.pg_extension
    where extname in ('supabase_vault', 'pg_net', 'pg_cron')
  ),
  'recovery dependencies are installed'
);

select ok(
  to_regclass('private.whatsapp_recovery_config') is not null
    and to_regclass('private.whatsapp_recovery_http_attempts') is not null
    and to_regclass('cron.job') is not null
    and to_regclass('cron.job_run_details') is not null
    and to_regclass('net.http_request_queue') is not null
    and to_regclass('net._http_response') is not null,
  'recovery, cron and pg_net relations exist'
);

select ok(
  to_regprocedure(
    'private.whatsapp_recovery_vault_value(uuid,text)'
  ) is not null
    and to_regprocedure(
      'private.capture_whatsapp_recovery_responses()'
    ) is not null
    and to_regprocedure(
      'private.invoke_whatsapp_recovery(text)'
    ) is not null
    and to_regprocedure(
      'private.install_whatsapp_recovery_schedule()'
    ) is not null
    and to_regprocedure(
      'private.uninstall_whatsapp_recovery_schedule()'
    ) is not null
    and to_regprocedure(
      'private.whatsapp_recovery_schedule_status()'
    ) is not null,
  'all private recovery functions exist'
);

select is(
  (
    select count(*)::integer
    from private.whatsapp_recovery_config
    where id
      and not enabled
      and project_url_secret_id is null
      and coexistence_secret_id is null
      and automation_outbox_secret_id is null
      and coexistence_job_id is null
      and automation_outbox_job_id is null
      and activated_at is null
  ),
  1,
  'post-reset recovery configuration is a single disabled inert row'
);

select is(
  private.whatsapp_recovery_schedule_status(),
  jsonb_build_object(
    'enabled', false,
    'configuredJobs', 0,
    'activeJobs', 0,
    'matchingJobs', 0,
    'configurationConsistent', true,
    'pendingResponses', 0,
    'successfulResponses', 0,
    'failedResponses', 0,
    'lastRequestId', null
  ),
  'post-reset status reports no configured or observed recovery activity'
);

select is(
  (select count(*)::integer from cron.job),
  0,
  'post-reset creates zero cron jobs'
);

select is(
  (select count(*)::integer from cron.job_run_details),
  0,
  'post-reset has zero cron executions'
);

select is(
  (select count(*)::integer from net.http_request_queue),
  0,
  'post-reset queues zero pg_net requests'
);

select is(
  (select count(*)::integer from net._http_response),
  0,
  'post-reset observes zero pg_net responses'
);

select is(
  (
    select count(*)::integer
    from private.whatsapp_recovery_http_attempts
  ),
  0,
  'post-reset contains zero recovery HTTP audit attempts'
);

select is(
  (
    select count(*)::integer
    from vault.secrets
    where name in (
      'whatsapp_recovery_project_url',
      'whatsapp_coexistence_recovery_secret',
      'whatsapp_automation_outbox_recovery_secret'
    )
  ),
  0,
  'the inert migration creates no project URL or recovery secrets in Vault'
);

select throws_ok(
  $$select private.install_whatsapp_recovery_schedule()$$,
  '55000',
  'WHATSAPP_RECOVERY_PROJECT_URL_AMBIGUOUS',
  'installation fails closed when its Vault configuration is absent'
);

select is(
  (
    select count(*)::integer
    from private.whatsapp_recovery_config
    where id
      and not enabled
      and project_url_secret_id is null
      and coexistence_secret_id is null
      and automation_outbox_secret_id is null
      and coexistence_job_id is null
      and automation_outbox_job_id is null
  ),
  1,
  'failed installation leaves the configuration inert'
);

select ok(
  (select count(*) = 0 from cron.job)
    and (select count(*) = 0 from net.http_request_queue)
    and (
      select count(*) = 0
      from private.whatsapp_recovery_http_attempts
    ),
  'failed installation leaves no jobs, requests or audit attempts'
);

select throws_ok(
  $$select private.invoke_whatsapp_recovery('coexistence')$$,
  '55000',
  'WHATSAPP_RECOVERY_DISABLED',
  'the coexistence invocation fails closed while recovery is disabled'
);

select throws_ok(
  $$select private.invoke_whatsapp_recovery('automation_outbox')$$,
  '55000',
  'WHATSAPP_RECOVERY_DISABLED',
  'the automation-outbox invocation fails closed while recovery is disabled'
);

select ok(
  (select count(*) = 0 from net.http_request_queue)
    and (select count(*) = 0 from net._http_response)
    and (
      select count(*) = 0
      from private.whatsapp_recovery_http_attempts
    ),
  'disabled invocations produce no network request, response or audit row'
);

do $$
begin
  perform vault.create_secret(
    'https://qcthvykjlwqdrmpkxisc.supabase.co',
    'whatsapp_recovery_project_url',
    'pgTAP fixture rolled back with this transaction'
  );
  perform vault.create_secret(
    repeat('a', 64),
    'whatsapp_coexistence_recovery_secret',
    'non-production pgTAP fixture rolled back with this transaction'
  );
  perform vault.create_secret(
    repeat('b', 64),
    'whatsapp_automation_outbox_recovery_secret',
    'non-production pgTAP fixture rolled back with this transaction'
  );
end;
$$;

select lives_ok(
  $$select private.install_whatsapp_recovery_schedule()$$,
  'explicit installation succeeds with complete, distinct Vault fixtures'
);

select ok(
  (
    select count(*) = 2
      and count(*) filter (where active) = 2
      and count(*) filter (where schedule = '* * * * *') = 2
      and count(distinct jobname) = 2
      and bool_and(database = current_database())
      and bool_and(username = 'postgres')
    from cron.job
    where jobname in (
      'whatsapp-coexistence-recovery',
      'whatsapp-automation-outbox-recovery'
    )
  ),
  'installation creates exactly two distinct active one-minute jobs'
);

select ok(
  (
    select enabled
      and project_url_secret_id is not null
      and coexistence_secret_id is not null
      and automation_outbox_secret_id is not null
      and coexistence_job_id is not null
      and automation_outbox_job_id is not null
      and coexistence_job_id <> automation_outbox_job_id
    from private.whatsapp_recovery_config
    where id
  ),
  'installation enables a complete configuration with two different job IDs'
);

select lives_ok(
  $$select private.install_whatsapp_recovery_schedule()$$,
  'reinstall deliberately replaces the two managed jobs without duplication'
);

select is(
  (
    select count(*)::integer
    from cron.job
    where jobname in (
      'whatsapp-coexistence-recovery',
      'whatsapp-automation-outbox-recovery'
    )
  ),
  2,
  'reinstall still leaves exactly two managed jobs'
);

select is(
  private.uninstall_whatsapp_recovery_schedule(),
  2,
  'rollback removes the two jobs recorded by the recovery configuration'
);

select ok(
  (
    select not enabled
      and coexistence_job_id is null
      and automation_outbox_job_id is null
      and deactivated_at is not null
    from private.whatsapp_recovery_config
    where id
  )
    and (
      select count(*) = 0
      from cron.job
      where jobname in (
        'whatsapp-coexistence-recovery',
        'whatsapp-automation-outbox-recovery'
      )
    ),
  'rollback disables recovery and leaves no managed job behind'
);

select is(
  private.uninstall_whatsapp_recovery_schedule(),
  0,
  'rollback is idempotent and removes no unrelated job on a second call'
);

select is(
  (select count(*)::integer from net.http_request_queue),
  0,
  'transactional schedule tests never queue an HTTP request'
);

insert into private.whatsapp_recovery_http_attempts (request_id, processor)
values
  (-9101, 'coexistence'),
  (-9102, 'coexistence'),
  (-9103, 'automation_outbox');

insert into net._http_response (
  id, status_code, content_type, headers, content, timed_out, error_msg
) values
  (-9101, 200, 'application/json', '{}'::jsonb, '{}', false, null),
  (
    -9102,
    200,
    'application/json',
    '{}'::jsonb,
    '{"processed":true}',
    false,
    null
  ),
  (
    -9103,
    200,
    'application/json',
    '{}'::jsonb,
    '{"processed":false,"claimed":0,"failed":0}',
    false,
    null
  );

select private.capture_whatsapp_recovery_responses();

select is(
  (
    select outcome
    from private.whatsapp_recovery_http_attempts
    where request_id = -9101
  ),
  'invalid_response',
  'HTTP 200 with an empty JSON object is not classified as success'
);

select is(
  (
    select outcome
    from private.whatsapp_recovery_http_attempts
    where request_id = -9102
  ),
  'invalid_response',
  'HTTP 200 missing claimed and failed counters is not classified as success'
);

select is(
  (
    select outcome
    from private.whatsapp_recovery_http_attempts
    where request_id = -9103
  ),
  'invalid_response',
  'HTTP 200 with processed=false is not classified as success'
);

delete from net._http_response where id between -9103 and -9101;
delete from private.whatsapp_recovery_http_attempts
where request_id between -9103 and -9101;

select ok(
  (
    select bool_and(
      not has_schema_privilege(role_name, 'private', 'USAGE')
    )
    from unnest(array['anon', 'authenticated', 'service_role'])
      as api_roles(role_name)
  ),
  'API roles cannot use the private recovery schema'
);

select ok(
  (
    select bool_and(
      not has_table_privilege(
        role_name,
        format('private.%I', table_name),
        privilege_name
      )
    )
    from unnest(array['anon', 'authenticated', 'service_role'])
      as api_roles(role_name)
    cross join unnest(array[
      'whatsapp_recovery_config',
      'whatsapp_recovery_http_attempts'
    ]) as recovery_tables(table_name)
    cross join unnest(array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]) as table_privileges(privilege_name)
  ),
  'API roles have no privileges on private recovery tables'
);

select ok(
  (
    select count(*) = 18 and bool_and(
      not has_function_privilege(role_name, procedure_oid, 'EXECUTE')
    )
    from unnest(array['anon', 'authenticated', 'service_role'])
      as api_roles(role_name)
    cross join lateral (
      select procedure_oid
      from unnest(array[
        'private.whatsapp_recovery_vault_value(uuid,text)'::regprocedure,
        'private.capture_whatsapp_recovery_responses()'::regprocedure,
        'private.invoke_whatsapp_recovery(text)'::regprocedure,
        'private.install_whatsapp_recovery_schedule()'::regprocedure,
        'private.uninstall_whatsapp_recovery_schedule()'::regprocedure,
        'private.whatsapp_recovery_schedule_status()'::regprocedure
      ]) as recovery_functions(procedure_oid)
    ) functions_by_role
  ),
  'API roles cannot execute any private recovery function'
);

select ok(
  has_schema_privilege('postgres', 'private', 'USAGE')
    and has_table_privilege(
      'postgres',
      'private.whatsapp_recovery_config',
      'SELECT, INSERT, UPDATE, DELETE'
    )
    and has_table_privilege(
      'postgres',
      'private.whatsapp_recovery_http_attempts',
      'SELECT, INSERT, UPDATE, DELETE'
    )
    and has_function_privilege(
      'postgres',
      'private.install_whatsapp_recovery_schedule()',
      'EXECUTE'
    )
    and has_function_privilege(
      'postgres',
      'private.invoke_whatsapp_recovery(text)',
      'EXECUTE'
    ),
  'postgres retains the explicit privileges required to operate recovery'
);

select ok(
  (
    select count(*) = 2 and bool_and(relation.relrowsecurity)
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'private'
      and relation.relname in (
        'whatsapp_recovery_config',
        'whatsapp_recovery_http_attempts'
      )
  ),
  'row-level security is enabled on both private recovery tables'
);

select ok(
  (
    select bool_and(
      not has_table_privilege(
        role_name,
        format('vault.%I', table_name),
        'SELECT'
      )
    )
    from unnest(array['anon', 'authenticated'])
      as browser_roles(role_name)
    cross join unnest(array['secrets', 'decrypted_secrets'])
      as vault_tables(table_name)
  ),
  'browser roles cannot read encrypted or decrypted Vault secrets'
);

select ok(
  (
    select bool_and(
      not has_function_privilege(role_name, procedure_oid, 'EXECUTE')
    )
    from unnest(array['anon', 'authenticated'])
      as browser_roles(role_name)
    cross join lateral (
      select procedure_oid
      from unnest(array[
        'vault.create_secret(text,text,text,uuid)'::regprocedure,
        'vault.update_secret(uuid,text,text,text,uuid)'::regprocedure
      ]) as vault_functions(procedure_oid)
    ) functions_by_role
  ),
  'browser roles cannot create or update Vault secrets'
);

select ok(
  (
    select count(*) = 2
      and bool_and(owner.rolname = 'postgres')
      and not exists (
        select 1
        from pg_catalog.pg_class protected_relation
        join pg_catalog.pg_namespace protected_namespace
          on protected_namespace.oid = protected_relation.relnamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            protected_relation.relacl,
            pg_catalog.acldefault('r', protected_relation.relowner)
          )
        ) privilege
        where protected_namespace.nspname = 'private'
          and protected_relation.relname in (
            'whatsapp_recovery_config',
            'whatsapp_recovery_http_attempts'
          )
          and privilege.grantee <> (
            select oid from pg_catalog.pg_roles where rolname = 'postgres'
          )
      )
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    join pg_catalog.pg_roles owner on owner.oid = relation.relowner
    where namespace.nspname = 'private'
      and relation.relname in (
        'whatsapp_recovery_config',
        'whatsapp_recovery_http_attempts'
      )
  ),
  'private recovery tables are postgres-owned with no non-postgres ACL'
);

select ok(
  (
    select count(*) = 6
      and bool_and(owner.rolname = 'postgres')
      and not exists (
        select 1
        from pg_catalog.pg_proc protected_function
        join pg_catalog.pg_namespace protected_namespace
          on protected_namespace.oid = protected_function.pronamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            protected_function.proacl,
            pg_catalog.acldefault('f', protected_function.proowner)
          )
        ) privilege
        where protected_namespace.nspname = 'private'
          and protected_function.proname in (
            'whatsapp_recovery_vault_value',
            'capture_whatsapp_recovery_responses',
            'invoke_whatsapp_recovery',
            'install_whatsapp_recovery_schedule',
            'uninstall_whatsapp_recovery_schedule',
            'whatsapp_recovery_schedule_status'
          )
          and privilege.grantee <> (
            select oid from pg_catalog.pg_roles where rolname = 'postgres'
          )
      )
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = procedure.proowner
    where namespace.nspname = 'private'
      and procedure.proname in (
        'whatsapp_recovery_vault_value',
        'capture_whatsapp_recovery_responses',
        'invoke_whatsapp_recovery',
        'install_whatsapp_recovery_schedule',
        'uninstall_whatsapp_recovery_schedule',
        'whatsapp_recovery_schedule_status'
      )
  ),
  'private recovery functions are postgres-owned with no non-postgres ACL'
);

select ok(
  (
    select count(*) = 4
      and bool_and(namespace.oid <> to_regnamespace('public'))
    from pg_catalog.pg_namespace namespace
    where namespace.nspname in ('private', 'net', 'cron', 'vault')
  )
    and not exists (
      select 1
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname in ('public', 'graphql_public')
        and relation.relname like 'whatsapp_recovery%'
    )
    and not exists (
      select 1
      from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace
        on namespace.oid = procedure.pronamespace
      where namespace.nspname in ('public', 'graphql_public')
        and procedure.proname like '%whatsapp_recovery%'
    ),
  'recovery, net, cron and Vault remain outside public API schemas'
);

select ok(
  (
    select count(*) = 6
      and bool_and(procedure.prosecdef)
      and bool_and(owner.rolname = 'postgres')
      and bool_and(
        coalesce(procedure.proconfig, '{}'::text[])
          @> array['search_path=pg_catalog']
      )
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = procedure.proowner
    where namespace.nspname = 'private'
      and procedure.proname in (
        'whatsapp_recovery_vault_value',
        'capture_whatsapp_recovery_responses',
        'invoke_whatsapp_recovery',
        'install_whatsapp_recovery_schedule',
        'uninstall_whatsapp_recovery_schedule',
        'whatsapp_recovery_schedule_status'
      )
  ),
  'recovery functions are postgres-owned SECURITY DEFINER with a fixed search path'
);

select ok(
  (
    select position(
      $command$select private.invoke_whatsapp_recovery(''coexistence'');$command$
      in procedure.prosrc
    ) > 0
      and position(
        $command$select private.invoke_whatsapp_recovery(''automation_outbox'');$command$
        in procedure.prosrc
      ) > 0
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname = 'install_whatsapp_recovery_schedule'
  ),
  'cron commands call only the private recovery dispatcher'
);

select ok(
  (
    select lower(procedure.prosrc) !~
      '(service_role|x-internal-secret|graph\\.facebook\\.com|whatsapp_access_token|authorization|apikey)'
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname = 'install_whatsapp_recovery_schedule'
  ),
  'cron runtime commands contain no service-role, internal-secret or Graph credential path'
);

select ok(
  (
    select position(
      '/functions/v1/process-whatsapp-coexistence'
      in procedure.prosrc
    ) > 0
      and position(
        '/functions/v1/process-whatsapp-automation-outbox'
        in procedure.prosrc
      ) > 0
      and position('x-recovery-secret' in procedure.prosrc) > 0
      and position('''Content-Type'', ''application/json''' in procedure.prosrc) > 0
      and position('body := ''{}''::jsonb' in procedure.prosrc) > 0
      and position('timeout_milliseconds := 30000' in procedure.prosrc) > 0
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname = 'invoke_whatsapp_recovery'
  ),
  'the dispatcher uses the exact endpoints, recovery header, JSON body and timeout'
);

select ok(
  (
    select lower(procedure.prosrc) !~
      '(service_role|x-internal-secret|graph\\.facebook\\.com|whatsapp_access_token|authorization|apikey)'
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname = 'invoke_whatsapp_recovery'
  ),
  'the HTTP dispatcher never uses service-role, internal-secret or Graph credentials'
);

select ok(
  not exists (
    select 1
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'whatsapp_recovery_http_attempts'
      and column_name in (
        'url', 'headers', 'body', 'content', 'response_body',
        'secret', 'recovery_secret', 'decrypted_secret'
      )
  ),
  'the recovery audit table has no column capable of storing raw requests or secrets'
);

select * from finish();

rollback;
