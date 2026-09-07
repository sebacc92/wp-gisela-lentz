\set ON_ERROR_STOP on

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(18);

select ok(exists (
  select 1 from pg_publication_tables
  where pubname = 'supabase_realtime' and schemaname = 'public'
    and tablename = 'calendar_availability_updates'
), 'the agenda subscribes to a published, sanitized availability signal');
select ok(not exists (
  select 1 from pg_publication_tables
  where pubname = 'supabase_realtime' and schemaname = 'public'
    and tablename = 'google_calendar_external_events'
), 'raw Google identifiers and event content are not published through Realtime');
select is(
  (select jsonb_agg(column_name order by ordinal_position) from information_schema.columns
    where table_schema = 'public' and table_name = 'calendar_availability_updates'),
  '["id", "revision", "updated_at"]'::jsonb,
  'the signal payload contains only a constant identity, revision and timestamp');
select ok((select count(*) = 1 and bool_and(id and revision >= 0)
  from public.calendar_availability_updates), 'the signal is initialized as one singleton row');
select is((select relreplident::text from pg_class
  where oid = 'public.calendar_availability_updates'::regclass), 'd',
  'signal replication does not require full old rows');
select ok((select bool_and(relrowsecurity) from pg_class
  where oid in ('public.calendar_availability_updates'::regclass,
    'public.google_calendar_external_events'::regclass)),
  'row-level security stays enabled on both the signal and the underlying events');
select ok(
  not has_table_privilege('anon', 'public.calendar_availability_updates', 'SELECT')
  and not has_table_privilege('anon', 'public.google_calendar_external_events', 'SELECT')
  and has_table_privilege('authenticated', 'public.calendar_availability_updates', 'SELECT')
  and not has_table_privilege('authenticated', 'public.calendar_availability_updates', 'INSERT')
  and not has_table_privilege('authenticated', 'public.calendar_availability_updates', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.calendar_availability_updates', 'DELETE')
  and not has_table_privilege('authenticated', 'public.google_calendar_external_events', 'UPDATE')
  and not has_function_privilege('authenticated', 'public.notify_calendar_availability_update()', 'EXECUTE'),
  'anonymous reads and browser writes remain denied; only the trigger updates the signal');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
\ir _support/calendar-ready.inc
select revision as prior_revision from public.calendar_availability_updates where id \gset

insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind,
  starts_at, ends_at, content_hash, summary
) values
  ('synthetic-domain-test-calendar', 'signal-current', 9900, 'block',
    clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day 1 hour',
    md5('signal-current'), 'Synthetic current block'),
  ('synthetic-domain-test-calendar', 'signal-old-generation', 9899, 'block',
    clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day 1 hour',
    md5('signal-old-generation'), 'Synthetic previous generation'),
  ('synthetic-other-calendar', 'signal-other-calendar', 9900, 'block',
    clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day 1 hour',
    md5('signal-other-calendar'), 'Synthetic unrelated calendar');
select is((select revision from public.calendar_availability_updates where id),
  :'prior_revision'::bigint + 1, 'a multi-row import produces one refresh signal');

update public.google_calendar_external_events set summary = 'Updated synthetic block'
where google_event_id in ('signal-old-generation', 'signal-other-calendar');
select is((select revision from public.calendar_availability_updates where id),
  :'prior_revision'::bigint + 2, 'a multi-row update produces one refresh signal');

delete from public.google_calendar_external_events
where google_event_id in ('signal-old-generation', 'signal-other-calendar');
select is((select revision from public.calendar_availability_updates where id),
  :'prior_revision'::bigint + 3, 'deleting blocks signals a reload without broadcasting their keys');

update public.google_calendar_external_events set summary = 'No match'
where google_event_id = 'signal-does-not-exist';
delete from public.google_calendar_external_events where google_event_id = 'signal-does-not-exist';
insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind, content_hash
) select 'empty', 'empty', 9900, 'unsupported', md5('empty') where false;
select is((select revision from public.calendar_availability_updates where id),
  :'prior_revision'::bigint + 3, 'empty reconciliation statements do not trigger redundant refreshes');

insert into auth.users (id, email, encrypted_password, aud, role)
values
  ('92900000-0000-4000-8000-000000000001', 'signal-admin@example.test', '', 'authenticated', 'authenticated'),
  ('92900000-0000-4000-8000-000000000002', 'signal-operator@example.test', '', 'authenticated', 'authenticated'),
  ('92900000-0000-4000-8000-000000000003', 'signal-disabled-admin@example.test', '', 'authenticated', 'authenticated');
update public.profiles set role = 'ADMIN', active = true
where id = '92900000-0000-4000-8000-000000000001';
update public.profiles set role = 'OPERADOR', active = true
where id = '92900000-0000-4000-8000-000000000002';
update public.profiles set role = 'ADMIN', active = false
where id = '92900000-0000-4000-8000-000000000003';

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"92900000-0000-4000-8000-000000000001"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is((select count(*)::integer from public.calendar_availability_updates), 1,
  'an active administrator can receive the availability signal');
select results_eq(
  $$select google_event_id from public.google_calendar_external_events
    where google_event_id like 'signal-%' order by google_event_id$$,
  $$values ('signal-current'::text)$$,
  'underlying Google data remains accessible through its original scope policy');

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"92900000-0000-4000-8000-000000000002"}', true);
select is((select count(*)::integer from public.calendar_availability_updates), 0,
  'operators cannot receive the admin signal');
select is((select count(*)::integer from public.google_calendar_external_events
  where google_event_id like 'signal-%'), 0,
  'operators still cannot read underlying Google event content');

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"92900000-0000-4000-8000-000000000003"}', true);
select is((select count(*)::integer from public.calendar_availability_updates), 0,
  'disabled administrators cannot receive the signal');

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select set_config('request.jwt.claim.role', 'anon', true);
select throws_ok($$select * from public.calendar_availability_updates$$,
  '42501', null, 'anonymous users cannot read the signal table');
select throws_ok($$select google_event_id from public.google_calendar_external_events$$,
  '42501', null, 'anonymous users cannot read Google events');

reset role;
select * from finish();
rollback;
