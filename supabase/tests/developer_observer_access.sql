\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(18);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

insert into auth.users (id, email, encrypted_password, aud, role)
values
  (
    '95200000-0000-4000-8000-000000000001',
    'observer-access-admin@example.test', '',
    'authenticated', 'authenticated'
  ),
  (
    '95200000-0000-4000-8000-000000000002',
    'observer-access-operator@example.test', '',
    'authenticated', 'authenticated'
  ),
  (
    '95200000-0000-4000-8000-000000000003',
    'observer-access-observer@example.test', '',
    'authenticated', 'authenticated'
  ),
  (
    '95200000-0000-4000-8000-000000000004',
    'observer-access-inactive@example.test', '',
    'authenticated', 'authenticated'
  ),
  (
    '95200000-0000-4000-8000-000000000005',
    'observer-access-default@example.test', '',
    'authenticated', 'authenticated'
  );

update public.profiles
set role = 'ADMIN'
where id in (
  '95200000-0000-4000-8000-000000000001',
  '95200000-0000-4000-8000-000000000003'
);

update public.profiles
set preserve_inbox_unread = true
where id = '95200000-0000-4000-8000-000000000003';

update public.profiles
set active = false
where id = '95200000-0000-4000-8000-000000000004';

insert into public.contacts (id, phone_e164, whatsapp_id, name)
values
  (
    '95200000-0000-4000-8000-000000000011',
    '+5491100020011', '5491100020011', 'Observer Fixture A'
  ),
  (
    '95200000-0000-4000-8000-000000000012',
    '+5491100020012', '5491100020012', 'Observer Fixture B'
  ),
  (
    '95200000-0000-4000-8000-000000000013',
    '+5491100020013', '5491100020013', 'Observer Fixture C'
  ),
  (
    '95200000-0000-4000-8000-000000000014',
    '+5491100020014', '5491100020014', 'Observer Fixture D'
  );

insert into public.conversations (id, contact_id, unread_count)
values
  (
    '95200000-0000-4000-8000-000000000021',
    '95200000-0000-4000-8000-000000000011', 7
  ),
  (
    '95200000-0000-4000-8000-000000000022',
    '95200000-0000-4000-8000-000000000012', 8
  ),
  (
    '95200000-0000-4000-8000-000000000023',
    '95200000-0000-4000-8000-000000000013', 9
  ),
  (
    '95200000-0000-4000-8000-000000000024',
    '95200000-0000-4000-8000-000000000014', 10
  );

select has_column(
  'public', 'profiles', 'preserve_inbox_unread',
  'profiles expose the independent inbox observer capability'
);

select ok(
  (
    select attribute.attnotnull
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'public.profiles'::regclass
      and attribute.attname = 'preserve_inbox_unread'
      and attribute.attnum > 0
      and not attribute.attisdropped
  ),
  'the observer capability cannot be null'
);

select ok(
  (
    select pg_catalog.pg_get_expr(definition.adbin, definition.adrelid)
      = 'false'
    from pg_catalog.pg_attrdef definition
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = definition.adrelid
      and attribute.attnum = definition.adnum
    where definition.adrelid = 'public.profiles'::regclass
      and attribute.attname = 'preserve_inbox_unread'
  ),
  'new profiles are non-observers by default'
);

select ok(
  not has_column_privilege(
    'authenticated', 'public.conversations', 'unread_count', 'UPDATE'
  )
  and not has_column_privilege(
    'authenticated', 'public.profiles',
    'preserve_inbox_unread', 'UPDATE'
  ),
  'browser sessions cannot bypass either authoritative mutation boundary'
);

select ok(
  has_function_privilege(
    'authenticated', 'public.mark_conversation_read(uuid)', 'EXECUTE'
  )
  and has_function_privilege(
    'service_role', 'public.mark_conversation_read(uuid)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.mark_conversation_read(uuid)', 'EXECUTE'
  ),
  'only authenticated application users and service_role may call the RPC'
);

select ok(
  (
    select procedure.prosecdef
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'mark_conversation_read'
      and procedure.proargtypes = '2950'::oidvector
  ),
  'the mark-read RPC is SECURITY DEFINER'
);

select ok(
  (
    select coalesce(procedure.proconfig, '{}'::text[])
      @> array['search_path=pg_catalog']
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'mark_conversation_read'
      and procedure.proargtypes = '2950'::oidvector
  ),
  'the SECURITY DEFINER RPC has a fixed pg_catalog search path'
);

select is(
  (
    select owner.rolname
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = procedure.proowner
    where namespace.nspname = 'public'
      and procedure.proname = 'mark_conversation_read'
      and procedure.proargtypes = '2950'::oidvector
  ),
  'postgres',
  'the SECURITY DEFINER RPC has the trusted migration owner'
);

select is(
  (
    select preserve_inbox_unread
    from public.profiles
    where id = '95200000-0000-4000-8000-000000000005'
  ),
  false,
  'the auth-user trigger preserves ordinary inbox behavior by default'
);

select ok(
  (
    select role = 'ADMIN' and preserve_inbox_unread
    from public.profiles
    where id = '95200000-0000-4000-8000-000000000003'
  ),
  'observer access is an ADMIN capability and not a replacement user role'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95200000-0000-4000-8000-000000000001"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select public.mark_conversation_read(
  '95200000-0000-4000-8000-000000000021'
);

reset role;
select is(
  (
    select unread_count
    from public.conversations
    where id = '95200000-0000-4000-8000-000000000021'
  ),
  0,
  'a normal active ADMIN clears the shared unread counter'
);
select is(
  (
    select unread_count
    from public.conversations
    where id = '95200000-0000-4000-8000-000000000022'
  ),
  8,
  'marking one conversation read does not affect another conversation'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95200000-0000-4000-8000-000000000002"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select public.mark_conversation_read(
  '95200000-0000-4000-8000-000000000022'
);

reset role;
select is(
  (
    select unread_count
    from public.conversations
    where id = '95200000-0000-4000-8000-000000000022'
  ),
  0,
  'a normal active OPERADOR keeps the existing mark-read behavior'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95200000-0000-4000-8000-000000000003"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select public.mark_conversation_read(
  '95200000-0000-4000-8000-000000000023'
);

select throws_ok(
  $$update public.conversations
    set unread_count = 0
    where id = '95200000-0000-4000-8000-000000000023'$$,
  '42501',
  'permission denied for table conversations',
  'an observer cannot bypass the RPC with a direct unread update'
);

select throws_ok(
  $$update public.profiles
    set preserve_inbox_unread = false
    where id = '95200000-0000-4000-8000-000000000003'$$,
  '42501',
  'permission denied for table profiles',
  'an observer cannot disable the capability from the browser'
);

reset role;
select is(
  (
    select unread_count
    from public.conversations
    where id = '95200000-0000-4000-8000-000000000023'
  ),
  9,
  'the authoritative RPC is a no-op for an active observer ADMIN'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95200000-0000-4000-8000-000000000004"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select public.mark_conversation_read(
  '95200000-0000-4000-8000-000000000024'
);

reset role;
select is(
  (
    select unread_count
    from public.conversations
    where id = '95200000-0000-4000-8000-000000000024'
  ),
  10,
  'an inactive profile cannot mutate unread state through the definer RPC'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select public.mark_conversation_read(
  '95200000-0000-4000-8000-000000000023'
);

reset role;
select is(
  (
    select unread_count
    from public.conversations
    where id = '95200000-0000-4000-8000-000000000023'
  ),
  0,
  'service_role retains the backend mark-read behavior'
);

select * from finish();

rollback;
