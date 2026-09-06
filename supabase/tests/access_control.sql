\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(4);

select ok(
  (
    select bool_and(not has_table_privilege('anon', format('public.%I', table_name), 'SELECT'))
    from unnest(array[
      'contacts',
      'conversations',
      'messages',
      'appointments',
      'app_settings',
      'services'
    ]) as sensitive_tables(table_name)
  ),
  'anonymous users cannot read operational tables'
);

select ok(
  (
    select bool_and(c.relrowsecurity)
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any(array[
        'contacts',
        'conversations',
        'messages',
        'appointments',
        'app_settings',
        'services'
      ])
  ),
  'row-level security is enabled on every operational table'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.get_available_slots_for_service(uuid, uuid, date, text, integer)',
    'EXECUTE'
  ),
  'anonymous users cannot query service availability'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.create_service_appointment(uuid, uuid, uuid, timestamptz, public.appointment_source, text, public.orthodontic_visit_type)',
    'EXECUTE'
  ),
  'anonymous users cannot create appointments through the RPC'
);

select * from finish();

rollback;
