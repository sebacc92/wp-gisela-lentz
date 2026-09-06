\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set local search_path = public, extensions;
select plan(6);

select extensions.dblink_connect(
  'calendar_inbound_barrier_setup',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);
select extensions.dblink_connect(
  'calendar_inbound_barrier_observer',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);
select extensions.dblink_connect(
  'calendar_inbound_barrier_finisher',
  'host=host.docker.internal port=55322 dbname=postgres ' ||
  'user=supabase_admin password=postgres'
);

select extensions.dblink_exec(
  'calendar_inbound_barrier_setup',
  $setup$
    create table public.calendar_inbound_barrier_connection_backup as
    select * from public.google_calendar_connections;
    set session_replication_role = replica;
    do $body$
    declare
      secret_id uuid;
    begin
      select vault.create_secret(
        'opaque-inbound-barrier-token',
        'calendar_inbound_barrier_fixture',
        'pgTAP only'
      ) into secret_id;
      update public.google_calendar_connections connection
      set status = 'connected',
          google_account_id = 'inbound-barrier-account',
          google_account_email = 'inbound-barrier@example.test',
          google_calendar_id = 'inbound-barrier-calendar',
          google_calendar_name = 'Inbound Barrier Calendar',
          google_calendar_timezone = 'America/Argentina/Buenos_Aires',
          refresh_token_secret_id = secret_id,
          connected_at = clock_timestamp(),
          connection_generation = 924,
          sync_scope_google_account_id = 'inbound-barrier-account',
          sync_scope_google_calendar_id = 'inbound-barrier-calendar',
          sync_scope_generation = 924,
          inbound_first_import_approved_at = clock_timestamp(),
          inbound_sync_state = 'incremental',
          inbound_sync_token = 'inbound-barrier-token-before',
          inbound_sync_token_generation = 924,
          inbound_sync_contract_version = 2,
          inbound_sync_timezone = 'America/Argentina/Buenos_Aires',
          inbound_coverage_starts_at = (current_date - 1)::timestamp
            at time zone 'America/Argentina/Buenos_Aires',
          inbound_coverage_ends_at = (current_date + 20)::timestamp
            at time zone 'America/Argentina/Buenos_Aires',
          last_sync_completed_at = clock_timestamp() - interval '1 minute',
          last_sync_error = null,
          inbound_lease_token =
            '92400000-0000-4000-8000-000000000090',
          inbound_lease_expires_at = clock_timestamp() + interval '5 minutes',
          inbound_lease_sync_contract_version = 2,
          inbound_lease_coverage_starts_at = (current_date - 1)::timestamp
            at time zone 'America/Argentina/Buenos_Aires',
          inbound_lease_coverage_ends_at = (current_date + 20)::timestamp
            at time zone 'America/Argentina/Buenos_Aires',
          inbound_lease_timezone = 'America/Argentina/Buenos_Aires',
          automation_enabled = false,
          automation_epoch = null,
          automation_activated_at = null,
          automation_google_account_id = null,
          automation_google_calendar_id = null,
          automation_connection_generation = null
      where connection.id = true;
    end;
    $body$;
    set session_replication_role = origin;
  $setup$
);

select ok(
  pg_get_functiondef(
    'public.assert_google_calendar_inbound_lease(bigint,uuid)'::regprocedure
  ) like '%pg_advisory_xact_lock_shared%'
  and pg_get_functiondef(
    'public.complete_google_calendar_inbound_sync(bigint,uuid,text,jsonb,integer,integer,timestamptz,timestamptz)'::regprocedure
  ) like '%pg_advisory_xact_lock(%'
  and pg_get_functiondef(
    'public.fail_google_calendar_inbound_sync(bigint,uuid,text,jsonb)'::regprocedure
  ) like '%pg_advisory_xact_lock(%'
  and pg_get_functiondef(
    'public.release_google_calendar_inbound_lease(bigint,uuid)'::regprocedure
  ) like '%pg_advisory_xact_lock(%'
  and pg_get_functiondef(
    'public.mark_google_calendar_reconnect_required(text,bigint)'::regprocedure
  ) like '%pg_advisory_xact_lock(%',
  'all inbound consumers/finalizers use the shared/exclusive barrier contract'
);

select extensions.dblink_exec(
  'calendar_inbound_barrier_observer',
  $$set request.jwt.claims = '{"role":"service_role"}'$$
);
select extensions.dblink_exec(
  'calendar_inbound_barrier_observer',
  $$set request.jwt.claim.role = 'service_role'$$
);
select extensions.dblink_exec(
  'calendar_inbound_barrier_finisher',
  $$set request.jwt.claims = '{"role":"service_role"}'$$
);
select extensions.dblink_exec(
  'calendar_inbound_barrier_finisher',
  $$set request.jwt.claim.role = 'service_role'$$
);
select extensions.dblink_exec('calendar_inbound_barrier_observer', 'begin');
select extensions.dblink_exec('calendar_inbound_barrier_finisher', 'begin');

select outcome
from extensions.dblink(
  'calendar_inbound_barrier_observer',
  $observe$
    select public.apply_google_calendar_external_event(
      924,
      '92400000-0000-4000-8000-000000000090',
      'synthetic-inbound-barrier-event',
      'block',
      false,
      'Synthetic occupied interval',
      (current_date + 7 + time '10:00')
        at time zone 'America/Argentina/Buenos_Aires',
      (current_date + 7 + time '10:30')
        at time zone 'America/Argentina/Buenos_Aires',
      false,
      false,
      null::text,
      '"synthetic-inbound-etag"',
      clock_timestamp()
    )
  $observe$
) as observed(outcome text)
\gset observed_
select is(
  :'observed_outcome'::text,
  'created'::text,
  'the real inbound event RPC mutates under a transaction-scoped shared lock'
);

select backend_pid
from extensions.dblink(
  'calendar_inbound_barrier_finisher',
  'select pg_backend_pid()'
) as backend(backend_pid integer)
\gset finisher_
select extensions.dblink_send_query(
  'calendar_inbound_barrier_finisher',
  $complete$
    select public.complete_google_calendar_inbound_sync(
      924,
      '92400000-0000-4000-8000-000000000090',
      'inbound-barrier-token-after',
      '{"blocksImported":1}'::jsonb,
      1,
      2,
      (current_date - 1)::timestamp
        at time zone 'America/Argentina/Buenos_Aires',
      (current_date + 20)::timestamp
        at time zone 'America/Argentina/Buenos_Aires'
    )
  $complete$
);
select pg_sleep(0.1);
select is(
  (
    select wait_event
    from extensions.dblink(
      'calendar_inbound_barrier_setup',
      format(
        'select wait_event from pg_stat_activity where pid = %s',
        :'finisher_backend_pid'
      )
    ) as activity(wait_event text)
  ),
  'advisory',
  'completion waits until the last inbound mutation commits'
);

select extensions.dblink_exec(
  'calendar_inbound_barrier_observer',
  'commit'
);
select completed
from extensions.dblink_get_result('calendar_inbound_barrier_finisher')
  as completed_result(completed boolean)
\gset completed_
select count(*)
from extensions.dblink_get_result('calendar_inbound_barrier_finisher')
  as completed_result_drained(completed boolean);
select ok(
  :'completed_completed'::boolean,
  'completion succeeds only after the observed block is durable'
);
select extensions.dblink_exec(
  'calendar_inbound_barrier_finisher',
  'commit'
);

select ok(
  (
    select state_ok
    from extensions.dblink(
      'calendar_inbound_barrier_setup',
      $verify$
        select connection.inbound_lease_token is null
          and connection.last_sync_completed_at is not null
          and connection.inbound_sync_token = 'inbound-barrier-token-after'
          and exists (
            select 1
            from public.google_calendar_external_events external_event
            where external_event.google_calendar_id =
                'inbound-barrier-calendar'
              and external_event.google_event_id =
                'synthetic-inbound-barrier-event'
              and external_event.status = 'active'
          )
        from public.google_calendar_connections connection
        where connection.id = true
      $verify$
    ) as verified(state_ok boolean)
  ),
  'the published complete snapshot includes the committed inbound block'
);

select ok(
  not exists (
    select 1
    from pg_locks lock
    where lock.locktype = 'advisory'
      and lock.granted
      and lock.objid = (
        hashtextextended('google_calendar_connection', 0) & 4294967295
      )::oid
      and lock.pid in (
        :'finisher_backend_pid'::integer
      )
  ),
  'the finalizer releases its Calendar advisory lock at commit'
);

select extensions.dblink_exec(
  'calendar_inbound_barrier_setup',
  $cleanup$
    begin;
    set local session_replication_role = replica;
    delete from public.google_calendar_external_events
    where google_calendar_id = 'inbound-barrier-calendar'
      and google_event_id = 'synthetic-inbound-barrier-event';
    delete from public.google_calendar_connections;
    insert into public.google_calendar_connections
    select * from public.calendar_inbound_barrier_connection_backup;
    drop table public.calendar_inbound_barrier_connection_backup;
    delete from vault.secrets
    where name = 'calendar_inbound_barrier_fixture';
    commit;
  $cleanup$
);

select extensions.dblink_disconnect('calendar_inbound_barrier_observer');
select extensions.dblink_disconnect('calendar_inbound_barrier_finisher');
select extensions.dblink_disconnect('calendar_inbound_barrier_setup');

select * from finish();
rollback;
