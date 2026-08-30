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

insert into auth.users (id, email, encrypted_password, aud, role)
values
  (
    '97000000-0000-4000-8000-000000000001',
    'odontogram-admin@example.test', '', 'authenticated', 'authenticated'
  ),
  (
    '97000000-0000-4000-8000-000000000002',
    'odontogram-operator@example.test', '', 'authenticated', 'authenticated'
  );

update public.profiles
set role = 'ADMIN'
where id = '97000000-0000-4000-8000-000000000001';

insert into public.contacts (id, phone_e164, whatsapp_id, name, coverage)
values (
  '97000000-0000-4000-8000-000000000010',
  '+5491100009970',
  '5491100009970',
  'Paciente Odontograma Test',
  'particular'
);

-- La historia clínica nunca se expone a un visitante anónimo.
select pg_temp.assert_true(
  not has_table_privilege('anon', 'public.odontogram_entries', 'SELECT'),
  'anon must not read odontogram entries'
);
select pg_temp.assert_true(
  not has_table_privilege('anon', 'public.odontogram_current', 'SELECT'),
  'anon must not read the current odontogram view'
);

select pg_temp.assert_true(
  (
    select relrowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'odontogram_entries'
  ),
  'row-level security must be enabled on odontogram entries'
);

-- Append-only: el permiso de corregir o borrar no existe para nadie logueado,
-- así que no depende de que una política esté bien escrita.
select pg_temp.assert_true(
  not has_table_privilege('authenticated', 'public.odontogram_entries', 'UPDATE'),
  'no authenticated role may update a clinical entry'
);
select pg_temp.assert_true(
  not has_table_privilege('authenticated', 'public.odontogram_entries', 'DELETE'),
  'no authenticated role may delete a clinical entry'
);
select pg_temp.assert_true(
  not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'odontogram_entries'
      and cmd in ('UPDATE', 'DELETE')
  ),
  'no update or delete policy may exist on odontogram entries'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"97000000-0000-4000-8000-000000000001"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

insert into public.odontogram_entries (
  contact_id, tooth, condition, surfaces, note, recorded_by, recorded_at
) values (
  '97000000-0000-4000-8000-000000000010',
  16,
  'caries',
  '{"oclusal": "caries"}'::jsonb,
  'Hallazgo ficticio de prueba.',
  '97000000-0000-4000-8000-000000000001',
  -- Fecha del cliente deliberadamente absurda: el servidor debe ignorarla.
  '2000-01-01T00:00:00Z'
);

select pg_temp.assert_true(
  (
    select recorded_at > now() - interval '1 minute'
    from public.odontogram_entries
    where contact_id = '97000000-0000-4000-8000-000000000010'
  ),
  'the server must stamp the clinical entry date, not the client'
);

-- Una pieza ausente no tiene caras que describir.
do $$
begin
  begin
    insert into public.odontogram_entries (
      contact_id, tooth, condition, surfaces, recorded_by
    ) values (
      '97000000-0000-4000-8000-000000000010',
      17, 'ausente', '{"oclusal": "caries"}'::jsonb,
      '97000000-0000-4000-8000-000000000001'
    );
    raise exception 'expected whole tooth rejection';
  exception when check_violation then null;
  end;

  -- Numeración FDI: 19 no existe.
  begin
    insert into public.odontogram_entries (
      contact_id, tooth, condition, recorded_by
    ) values (
      '97000000-0000-4000-8000-000000000010', 19, 'sano',
      '97000000-0000-4000-8000-000000000001'
    );
    raise exception 'expected tooth number rejection';
  exception when check_violation then null;
  end;

  -- Una cara inventada, o un hallazgo que no es localizable por cara.
  begin
    insert into public.odontogram_entries (
      contact_id, tooth, condition, surfaces, recorded_by
    ) values (
      '97000000-0000-4000-8000-000000000010', 18, 'caries',
      '{"cervical": "caries"}'::jsonb,
      '97000000-0000-4000-8000-000000000001'
    );
    raise exception 'expected surface key rejection';
  exception when check_violation then null;
  end;

  begin
    insert into public.odontogram_entries (
      contact_id, tooth, condition, surfaces, recorded_by
    ) values (
      '97000000-0000-4000-8000-000000000010', 18, 'caries',
      '{"oclusal": "implante"}'::jsonb,
      '97000000-0000-4000-8000-000000000001'
    );
    raise exception 'expected surface value rejection';
  exception when check_violation then null;
  end;
end;
$$;

-- Una corrección es un asiento nuevo, y el estado vigente pasa a ser ese.
insert into public.odontogram_entries (
  contact_id, tooth, condition, surfaces, note, recorded_by
) values (
  '97000000-0000-4000-8000-000000000010',
  16,
  'obturado',
  '{"oclusal": "obturado"}'::jsonb,
  'Tratada en la consulta siguiente.',
  '97000000-0000-4000-8000-000000000001'
);

select pg_temp.assert_true(
  (
    select count(*) = 2
    from public.odontogram_entries
    where contact_id = '97000000-0000-4000-8000-000000000010' and tooth = 16
  ),
  'a correction must add an entry instead of replacing the previous one'
);

select pg_temp.assert_true(
  (
    select condition = 'obturado'
    from public.odontogram_current
    where contact_id = '97000000-0000-4000-8000-000000000010' and tooth = 16
  ),
  'the current view must expose the latest entry for a tooth'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select pg_temp.assert_true(
  (
    select count(*) = 2
    from public.audit_logs
    where action = 'odontogram.entry_recorded'
      and entity_id = '97000000-0000-4000-8000-000000000010'
  ),
  'every accepted entry is audited, and a rejected one leaves no trace'
);

-- El rol operativo gestiona turnos y mensajes y no ve nada clínico.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"97000000-0000-4000-8000-000000000002"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select pg_temp.assert_true(
  (select count(*) = 0 from public.odontogram_entries),
  'an OPERADOR must not read any clinical entry'
);
select pg_temp.assert_true(
  (select count(*) = 0 from public.odontogram_current),
  'an OPERADOR must not read the current odontogram'
);

do $$
begin
  begin
    insert into public.odontogram_entries (
      contact_id, tooth, condition, recorded_by
    ) values (
      '97000000-0000-4000-8000-000000000010', 21, 'sano',
      '97000000-0000-4000-8000-000000000002'
    );
    raise exception 'expected operator insert rejection';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select pass('the odontogram stays admin-only, append-only and audited');
select * from finish();

rollback;
