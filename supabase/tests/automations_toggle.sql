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

-- El bot nace encendido: apagarlo es una decisión explícita.
select pg_temp.assert_true(
  (select automations_enabled from public.app_settings where id),
  'automations must default to enabled'
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

-- Un operador no puede apagar ni encender el bot.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95000000-0000-4000-8000-000000000002"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

update public.app_settings set automations_enabled = false where id;

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select pg_temp.assert_true(
  (select automations_enabled from public.app_settings where id),
  'an OPERADOR must not switch the bot off'
);

-- Una ADMIN sí, y el cambio queda auditado con su autor.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"95000000-0000-4000-8000-000000000001"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

update public.app_settings set automations_enabled = false where id;

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select pg_temp.assert_true(
  (select not automations_enabled from public.app_settings where id),
  'an ADMIN can switch the bot off'
);

select pg_temp.assert_true(
  exists (
    select 1
    from public.audit_logs
    where action = 'whatsapp.automations_toggled'
      and actor_user_id = '95000000-0000-4000-8000-000000000001'
      and metadata = jsonb_build_object('enabled', false)
  ),
  'switching the bot off must be audited with its author'
);

select pass('the bot switch is admin-only, audited and defaults to on');
select * from finish();

rollback;
