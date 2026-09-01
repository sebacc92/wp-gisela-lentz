\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(13);

select ok(
  (
    select count(*) = 2
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'app_settings'
      and column_name in ('ai_enabled', 'ai_model')
  ),
  'OpenAI administrative controls exist only in server-owned settings'
);

select ok(
  (select ai_enabled is false from public.app_settings where id = true)
    and (
      select ai_model = 'gpt-5.6-luna'
      from public.app_settings
      where id = true
    ),
  'the feature is born disabled with the fixed reference model'
);

select throws_ok(
  $$update public.app_settings set ai_model = 'another-model' where id = true$$,
  '23514',
  null,
  'the database rejects any other model'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.audit_openai_administrative_settings_change()',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'public.audit_openai_administrative_settings_change()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.audit_openai_administrative_settings_change()',
      'EXECUTE'
    ),
  'the audit trigger function cannot be invoked directly'
);

select ok(
  not has_table_privilege(
    'service_role',
    'public.openai_administrative_requests',
    'SELECT'
  )
    and not has_function_privilege(
      'anon',
      'public.recall_whatsapp_automation_decision(uuid,uuid,integer,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.reserve_openai_administrative_request(uuid,uuid)',
      'EXECUTE'
    ),
  'the content-free usage ledger is reachable only through service functions'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

update public.app_settings set automations_enabled = true where id;

insert into public.contacts (
  id, phone_e164, whatsapp_id, name
) values (
  '98000000-0000-4000-8000-000000000010',
  '+5491100009810',
  '5491100009810',
  'OpenAI quota test contact'
);

insert into public.conversations (
  id, contact_id, automation_mode, priority
) values (
  '98000000-0000-4000-8000-000000000011',
  '98000000-0000-4000-8000-000000000010',
  'auto',
  false
);

insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, status
) values (
  '98000000-0000-4000-8000-000000000012',
  '98000000-0000-4000-8000-000000000011',
  '98000000-0000-4000-8000-000000000010',
  'inbound',
  'text',
  '¿Dónde queda?',
  'read'
);

select *
from public.claim_whatsapp_automation_execution(
  '98000000-0000-4000-8000-000000000012',
  '{"delivery_mode":"whatsapp"}'::jsonb,
  900
)
\gset openai_claim_

select ok(
  (
    public.reserve_openai_administrative_request(
      '98000000-0000-4000-8000-000000000012',
      :'openai_claim_lease_token'::uuid
    ) ->> 'allowed'
  )::boolean,
  'the first external AI call is reserved atomically'
);

select ok(
  (
    public.reserve_openai_administrative_request(
      '98000000-0000-4000-8000-000000000012',
      :'openai_claim_lease_token'::uuid
    ) ->> 'reason'
  ) = 'ALREADY_RESERVED'
    and (
      select count(*) = 1
      from public.openai_administrative_requests
      where inbound_message_id =
        '98000000-0000-4000-8000-000000000012'
    ),
  'a retry cannot reserve or count the same inbound twice'
);

select is(
  public.recall_whatsapp_automation_decision(
    '98000000-0000-4000-8000-000000000012',
    :'openai_claim_lease_token'::uuid,
    0,
    'openai_administrative_answer'
  ),
  null::jsonb,
  'a decision is absent before the provider response is remembered'
);

select public.remember_whatsapp_automation_decision(
  '98000000-0000-4000-8000-000000000012',
  :'openai_claim_lease_token'::uuid,
  0,
  'openai_administrative_answer',
  '{"value":{"answer":"Respuesta estable","handoff":false,"responseId":null,"source":"openai"}}'::jsonb
)
\gset openai_remembered_

select is(
  public.recall_whatsapp_automation_decision(
    '98000000-0000-4000-8000-000000000012',
    :'openai_claim_lease_token'::uuid,
    0,
    'openai_administrative_answer'
  ),
  '{"value":{"answer":"Respuesta estable","handoff":false,"responseId":null,"source":"openai"}}'::jsonb,
  'a retry recalls the exact durable answer instead of calling OpenAI again'
);

insert into auth.users (id, email, encrypted_password, aud, role)
values
  (
    '98000000-0000-4000-8000-000000000001',
    'openai-admin@example.test', '', 'authenticated', 'authenticated'
  ),
  (
    '98000000-0000-4000-8000-000000000002',
    'openai-operator@example.test', '', 'authenticated', 'authenticated'
  );

update public.profiles
set role = 'ADMIN'
where id = '98000000-0000-4000-8000-000000000001';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"98000000-0000-4000-8000-000000000002"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

update public.app_settings
set ai_enabled = true
where id = true;

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select ok(
  (select ai_enabled is false from public.app_settings where id = true),
  'a non-admin cannot change AI settings through RLS'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"98000000-0000-4000-8000-000000000001"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

update public.app_settings
set ai_enabled = true,
    ai_model = 'gpt-5.6-luna'
where id = true;

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select ok(
  (
    select ai_enabled
      and ai_model = 'gpt-5.6-luna'
    from public.app_settings
    where id = true
  ),
  'an authenticated ADMIN can enable the bounded feature'
);

select is(
  (
    select count(*)::integer
    from public.audit_logs audit
    where audit.actor_user_id = '98000000-0000-4000-8000-000000000001'
      and audit.action = 'openai.administrative_settings_updated'
  ),
  1,
  'an ADMIN change is audited once'
);

select ok(
  exists (
    select 1
    from public.audit_logs audit
    where audit.actor_user_id = '98000000-0000-4000-8000-000000000001'
      and audit.action = 'openai.administrative_settings_updated'
      and audit.metadata = jsonb_build_object(
        'enabled', true,
        'model', 'gpt-5.6-luna',
        'media_enabled', false
      )
  ),
  'the audit stores only the booleans and the fixed model'
);

select * from finish();
rollback;
