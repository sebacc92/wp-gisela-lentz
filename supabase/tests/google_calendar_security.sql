\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(11);

select ok(
  not has_table_privilege('anon', 'public.google_calendar_connections', 'SELECT')
  and not has_table_privilege('authenticated', 'public.google_calendar_connections', 'SELECT')
  and not has_table_privilege('anon', 'public.google_calendar_oauth_states', 'SELECT')
  and not has_table_privilege('authenticated', 'public.google_calendar_oauth_states', 'SELECT')
  and not has_table_privilege('anon', 'public.google_calendar_sync_jobs', 'SELECT')
  and not has_table_privilege('authenticated', 'public.google_calendar_sync_jobs', 'SELECT'),
  'browser roles cannot read calendar connection, OAuth state or sync jobs'
);

select ok(
  not has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT')
  and not has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT')
  and not has_table_privilege('anon', 'vault.secrets', 'SELECT')
  and not has_table_privilege('authenticated', 'vault.secrets', 'SELECT'),
  'browser roles cannot read encrypted or decrypted Vault secrets'
);

select ok(
  not has_function_privilege('anon', 'public.google_calendar_status()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.google_calendar_status()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.google_calendar_status()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_google_calendar_connection_secret()', 'EXECUTE'),
  'calendar RPCs are service-role only'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '94000000-0000-4000-8000-000000000001',
  'calendar-admin@example.test', '', 'authenticated', 'authenticated'
);
update public.profiles set role = 'ADMIN'
where id = '94000000-0000-4000-8000-000000000001';

select public.create_google_calendar_oauth_state(
  '94000000-0000-4000-8000-000000000001',
  repeat('a', 64), repeat('v', 48), clock_timestamp() + interval '10 minutes'
);

select is(
  (select count(*)::integer from public.consume_google_calendar_oauth_state(repeat('a', 64))),
  1,
  'valid OAuth state is consumed once'
);

select is(
  (select count(*)::integer from public.consume_google_calendar_oauth_state(repeat('a', 64))),
  0,
  'OAuth state replay is rejected'
);

insert into public.professionals (id, name, appointment_duration_minutes)
values ('94000000-0000-4000-8000-000000000002', 'Profesional Calendar Test', 30);
insert into public.contacts (id, phone_e164, name)
values ('94000000-0000-4000-8000-000000000003', '+5491100009403', 'Paciente Calendar Test');
insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source
) values (
  '94000000-0000-4000-8000-000000000004',
  '94000000-0000-4000-8000-000000000003',
  '94000000-0000-4000-8000-000000000002',
  clock_timestamp() + interval '2 days',
  clock_timestamp() + interval '2 days 30 minutes',
  'confirmed', 'manual'
);

-- El seed local incluye otros turnos futuros. Este test de concurrencia debe
-- reclamar únicamente su fixture para no confundir un segundo job legítimo con
-- una segunda versión del mismo turno.
update public.appointments
set status = 'cancelled'
where id <> '94000000-0000-4000-8000-000000000004'
  and status in ('scheduled', 'confirmed');

do $calendar_connect$
declare
  oauth_attempt record;
  candidate_id uuid;
begin
  perform public.create_google_calendar_oauth_state(
    '94000000-0000-4000-8000-000000000001', repeat('b', 64),
    repeat('v', 64), clock_timestamp() + interval '10 minutes'
  );
  select * into oauth_attempt
  from public.consume_google_calendar_oauth_state(repeat('b', 64));
  select candidate.candidate_id into candidate_id
  from public.stage_google_calendar_connection_candidate(
    '94000000-0000-4000-8000-000000000001',
    'google-user-test', 'calendar@example.test',
    'fake-refresh-token-for-database-test',
    oauth_attempt.connection_generation,
    oauth_attempt.oauth_attempt_generation
  ) candidate;
  perform 1 from public.get_google_calendar_connection_candidate_secret(
    '94000000-0000-4000-8000-000000000001'
  );
  perform public.finalize_google_calendar_connection_selection(
    '94000000-0000-4000-8000-000000000001',
    candidate_id,
    'calendar-id-test', 'Gisela Lentz · Turnos',
    'America/Argentina/Buenos_Aires'
  );
end;
$calendar_connect$;

do $$
declare
  claimed record;
  claimed_second record;
  next_version bigint;
begin
  select * into claimed
  from public.claim_google_calendar_sync_jobs(
    1,
    (select connection_generation
     from public.google_calendar_connections where id = true)
  );
  if claimed.job_id is null then raise exception 'expected claimed calendar job'; end if;

  update public.appointments
  set starts_at = starts_at + interval '1 hour',
      ends_at = ends_at + interval '1 hour'
  where id = claimed.appointment_id;

  if exists (
    select 1 from public.claim_google_calendar_sync_jobs(
      1,
      claimed.connection_generation
    )
  ) then raise exception 'newer version was claimed while prior call was in flight'; end if;

  if public.complete_google_calendar_sync_job(
    claimed.job_id,
    claimed.desired_version,
    'stale-event-id',
    claimed.connection_generation
  ) then raise exception 'stale calendar version was completed'; end if;

  select desired_version into next_version
  from public.google_calendar_sync_jobs where id = claimed.job_id;
  if next_version <= claimed.desired_version then
    raise exception 'calendar version did not advance';
  end if;
  if not exists (
    select 1 from public.google_calendar_sync_jobs
    where id = claimed.job_id
      and status = 'pending'
      and desired_version = next_version
  ) then raise exception 'stale worker did not release the newer version'; end if;

  select * into claimed_second
  from public.claim_google_calendar_sync_jobs(
    1,
    claimed.connection_generation
  );
  update public.appointments
  set starts_at = starts_at + interval '1 hour',
      ends_at = ends_at + interval '1 hour'
  where id = claimed.appointment_id;
  if public.fail_google_calendar_sync_job(
    claimed_second.job_id,
    claimed_second.desired_version,
    claimed_second.connection_generation,
    'GOOGLE_NETWORK_FAILED',
    clock_timestamp() + interval '1 minute',
    false
  ) then raise exception 'stale failure changed a newer version'; end if;
  if not exists (
    select 1 from public.google_calendar_sync_jobs
    where id = claimed.job_id
      and status = 'pending'
      and desired_version > claimed_second.desired_version
  ) then raise exception 'stale failure did not release the newer version'; end if;
end;
$$;

select pass('a stale worker cannot overwrite a newer appointment version');

update public.google_calendar_sync_jobs
set status = 'failed', attempts = 8, last_error = 'GOOGLE_EVENT_TOMBSTONED'
where appointment_id = '94000000-0000-4000-8000-000000000004';
select * from public.reconcile_google_calendar_sync();

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '94000000-0000-4000-8000-000000000004'
      and status = 'failed'
      and attempts = 8
  ),
  'terminal jobs are not reopened by automatic reconciliation'
);

update public.google_calendar_sync_jobs
set status = 'pending', connection_generation = 100
where appointment_id = '94000000-0000-4000-8000-000000000004';
update public.appointments set starts_at = starts_at
where id = '94000000-0000-4000-8000-000000000004';
select is(
  (select connection_generation
   from public.google_calendar_sync_jobs
   where appointment_id = '94000000-0000-4000-8000-000000000004'),
  100::bigint,
  'a stale enqueue can never lower the monotonic connection generation'
);

update public.google_calendar_sync_jobs
set connection_generation = 0, status = 'pending'
where appointment_id = '94000000-0000-4000-8000-000000000004';
select * from public.reconcile_google_calendar_sync();
select is(
  (select job.connection_generation
   from public.google_calendar_sync_jobs job
   where job.appointment_id = '94000000-0000-4000-8000-000000000004'),
  (select connection.connection_generation
   from public.google_calendar_connections connection where connection.id = true),
  'reconciliation promotes a newly inserted job from a stale connection snapshot'
);

do $$
declare
  claimed record;
begin
  update public.appointments
  set status = 'confirmed'
  where id = '94000000-0000-4000-8000-000000000004';

  select * into claimed
  from public.claim_google_calendar_sync_jobs(
    1,
    (select connection_generation
     from public.google_calendar_connections where id = true)
  );
  if claimed.job_id is null or claimed.operation <> 'upsert' then
    raise exception 'expected claimed upsert before cancellation race';
  end if;

  update public.appointments
  set status = 'cancelled'
  where id = claimed.appointment_id;

  if not exists (
    select 1 from public.google_calendar_sync_jobs
    where id = claimed.job_id
      and status = 'processing'
      and operation = 'delete'
      and desired_version > claimed.desired_version
  ) then
    raise exception 'cancellation destroyed the in-flight claim';
  end if;

  if public.complete_google_calendar_sync_job(
    claimed.job_id,
    claimed.desired_version,
    'inserted-after-cancellation',
    claimed.connection_generation
  ) then
    raise exception 'cancelled appointment completed stale upsert';
  end if;

  if not exists (
    select 1 from public.google_calendar_sync_jobs
    where id = claimed.job_id
      and status = 'pending'
      and operation = 'delete'
      and desired_version > claimed.desired_version
  ) then
    raise exception 'stale upsert was not released as deterministic delete';
  end if;
end;
$$;

select pass('cancelling during an in-flight upsert preserves a deterministic delete');

select throws_ok(
  $$delete from public.appointments
    where id = '94000000-0000-4000-8000-000000000004'$$,
  '23503',
  'APPOINTMENT_DELETE_REQUIRES_CANCELLATION',
  'a Google-managed appointment must be cancelled instead of hard-deleted'
);

select * from finish();
rollback;
