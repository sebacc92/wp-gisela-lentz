\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(1);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

create function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if value is not true then
    raise exception 'ASSERTION_FAILED: %', message;
  end if;
end;
$$;

-- El bot nace apagado y sólo se enciende por una decisión explícita.
select pg_temp.assert_true(
  (select not automations_enabled from public.app_settings where id),
  'automations must default to disabled'
);

select pg_temp.assert_true(
  (
    select pg_get_expr(defaults.adbin, defaults.adrelid) = 'false'
    from pg_catalog.pg_attrdef defaults
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = defaults.adrelid
      and attribute.attnum = defaults.adnum
    join pg_catalog.pg_class relation
      on relation.oid = defaults.adrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'app_settings'
      and attribute.attname = 'automations_enabled'
  ),
  'new app_settings rows must also default to disabled'
);

insert into auth.users (id, email, encrypted_password, aud, role)
values
  (
    '95000000-0000-4000-8000-000000000001',
    'toggle-admin@example.test', '', 'authenticated', 'authenticated'
  ),
  (
    '95000000-0000-4000-8000-000000000002',
    'toggle-operator@example.test', '', 'authenticated', 'authenticated'
  );

update public.profiles
set role = 'ADMIN'
where id = '95000000-0000-4000-8000-000000000001';

select pg_temp.assert_true(
  (
    select role = 'OPERADOR' and active
    from public.profiles
    where id = '95000000-0000-4000-8000-000000000002'
  ),
  'the operator fixture must exist and be active'
);

-- Un operador no puede apagar ni encender el bot.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95000000-0000-4000-8000-000000000002"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

with attempted as (
  update public.app_settings
  set automations_enabled = true
  where id
  returning automations_enabled
)
select pg_temp.assert_true(
  not exists (select 1 from attempted),
  'an RLS-blocked update must return zero rows'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select pg_temp.assert_true(
  (select not automations_enabled from public.app_settings where id),
  'an OPERADOR must not switch the bot on'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from public.audit_logs
    where action = 'whatsapp.automations_toggled'
      and actor_user_id = '95000000-0000-4000-8000-000000000002'
  ),
  'a blocked OPERADOR update must not create an audit event'
);

-- Una ADMIN sí, y el cambio queda auditado con su autor.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95000000-0000-4000-8000-000000000001"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

with changed as (
  update public.app_settings
  set automations_enabled = true
  where id
  returning automations_enabled
)
select pg_temp.assert_true(
  (select count(*) = 1 and bool_and(automations_enabled) from changed),
  'an ADMIN update must return the enabled singleton'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select pg_temp.assert_true(
  (select automations_enabled from public.app_settings where id),
  'an ADMIN can switch the bot on'
);

select pg_temp.assert_true(
  (
    select count(*) = 1
    from public.audit_logs
    where action = 'whatsapp.automations_toggled'
      and actor_user_id = '95000000-0000-4000-8000-000000000001'
      and metadata = jsonb_build_object('enabled', true)
  ),
  'switching the bot on must be audited with its author'
);

-- El mismo control también vuelve a apagarlo y audita esa decisión.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95000000-0000-4000-8000-000000000001"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

with changed as (
  update public.app_settings
  set automations_enabled = false
  where id
  returning automations_enabled
)
select pg_temp.assert_true(
  (select count(*) = 1 and not bool_or(automations_enabled) from changed),
  'an ADMIN update must return the disabled singleton'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select pg_temp.assert_true(
  (select not automations_enabled from public.app_settings where id),
  'an ADMIN can switch the bot off again'
);

select pg_temp.assert_true(
  (
    select count(*) = 1
    from public.audit_logs
    where action = 'whatsapp.automations_toggled'
      and actor_user_id = '95000000-0000-4000-8000-000000000001'
      and metadata = jsonb_build_object('enabled', false)
  ),
  'switching the bot off must be audited with its author'
);

select pass('the bot switch is bidirectional, admin-only, audited and defaults to off');
select * from finish();

rollback;
