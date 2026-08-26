\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(1);

select set_config('app.whatsapp_policy_seed_bypass', 'off', true);
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

insert into public.professionals (
  id,
  name,
  appointment_duration_minutes
) values (
  '90000000-0000-4000-8000-000000000001',
  'Profesional Policy Test',
  30
);

insert into public.contacts (
  id,
  phone_e164,
  whatsapp_id,
  name
) values (
  '90000000-0000-4000-8000-000000000002',
  '+5492215559999',
  '5492215559999',
  'Paciente Policy Test'
);

insert into public.conversations (
  id,
  contact_id,
  last_inbound_message_at
) values (
  '90000000-0000-4000-8000-000000000003',
  '90000000-0000-4000-8000-000000000002',
  now() - interval '1 minute'
);

insert into public.appointments (
  id,
  contact_id,
  professional_id,
  starts_at,
  ends_at,
  status,
  source
) values (
  '90000000-0000-4000-8000-000000000004',
  '90000000-0000-4000-8000-000000000002',
  '90000000-0000-4000-8000-000000000001',
  now() + interval '2 days',
  now() + interval '2 days 30 minutes',
  'confirmed',
  'manual'
);

-- No direct writer, including service role, can forge the contact summary.
do $$
begin
  begin
    update public.contacts
    set whatsapp_opt_in_at = now()
    where id = '90000000-0000-4000-8000-000000000002';
    raise exception 'expected consent summary guard';
  exception
    when sqlstate '42501' then
      if sqlerrm <> 'CONSENT_EVENT_RPC_REQUIRED' then raise; end if;
  end;
end;
$$;

-- A service reply is allowed only while the user-opened 24 hour window exists.
insert into public.messages (
  id,
  conversation_id,
  contact_id,
  direction,
  type,
  body,
  status,
  idempotency_key,
  metadata
) values (
  '90000000-0000-4000-8000-000000000010',
  '90000000-0000-4000-8000-000000000003',
  '90000000-0000-4000-8000-000000000002',
  'outbound',
  'text',
  'Respuesta administrativa de prueba',
  'sent',
  'test:service:allowed',
  '{"source":"operator"}'::jsonb
);

select pg_temp.assert_true(
  (
    select metadata ->> 'policy_basis' = 'customer_service_window'
    from public.messages
    where id = '90000000-0000-4000-8000-000000000010'
  ),
  'service reply must record its policy basis'
);

do $$
begin
  begin
    insert into public.messages (
      conversation_id, contact_id, direction, type, body, status,
      idempotency_key, metadata
    ) values (
      '90000000-0000-4000-8000-000000000003',
      '90000000-0000-4000-8000-000000000002',
      'outbound', 'text', 'Duplicado', 'pending',
      'test:service:allowed', '{"source":"operator"}'::jsonb
    );
    raise exception 'expected idempotency conflict';
  exception
    when unique_violation then null;
  end;
end;
$$;

update public.conversations
set last_inbound_message_at = now() - interval '24 hours'
where id = '90000000-0000-4000-8000-000000000003';

do $$
begin
  begin
    insert into public.messages (
      conversation_id, contact_id, direction, type, body, status,
      idempotency_key, metadata
    ) values (
      '90000000-0000-4000-8000-000000000003',
      '90000000-0000-4000-8000-000000000002',
      'outbound', 'text', 'Fuera de ventana', 'pending',
      'test:service:closed', '{"source":"operator"}'::jsonb
    );
    raise exception 'expected closed window';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'POLICY_CUSTOMER_SERVICE_WINDOW_CLOSED' then raise; end if;
  end;
end;
$$;

-- Templates stay blocked without an explicit, evidenced appointment consent.
update public.message_templates
set meta_status = 'APPROVED', quality_rating = 'GREEN'
where key = 'appointment_reminder_24h';

update public.whatsapp_settings
set quality_rating = 'GREEN', quality_updated_at = now()
where id = true;

do $$
begin
  begin
    insert into public.messages (
      conversation_id, contact_id, direction, type, body, template_name,
      status, idempotency_key, metadata
    ) values (
      '90000000-0000-4000-8000-000000000003',
      '90000000-0000-4000-8000-000000000002',
      'outbound', 'template', 'Recordatorio', 'appointment_reminder_24h',
      'pending', 'test:template:no-consent',
      jsonb_build_object(
        'source', 'reminder',
        'template_key', 'appointment_reminder_24h',
        'appointment_id', '90000000-0000-4000-8000-000000000004'
      )
    );
    raise exception 'expected consent requirement';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'POLICY_CONSENT_REQUIRED' then raise; end if;
  end;
end;
$$;

select public.record_whatsapp_consent(
  '90000000-0000-4000-8000-000000000002',
  'opt_in',
  'appointment_updates',
  'whatsapp',
  'whatsapp_message:wamid.policy.optin',
  '2026-08-10',
  'wamid.policy.optin'
);

-- The same webhook retry is idempotent and does not duplicate evidence.
select public.record_whatsapp_consent(
  '90000000-0000-4000-8000-000000000002',
  'opt_in',
  'appointment_updates',
  'whatsapp',
  'whatsapp_message:wamid.policy.optin',
  '2026-08-10',
  'wamid.policy.optin'
);

select pg_temp.assert_true(
  (
    select count(*) = 1
    from public.whatsapp_consent_events
    where whatsapp_message_id = 'wamid.policy.optin'
  ),
  'consent evidence must be idempotent'
);

insert into public.messages (
  id,
  conversation_id,
  contact_id,
  direction,
  whatsapp_message_id,
  type,
  body,
  template_name,
  status,
  idempotency_key,
  metadata
) values (
  '90000000-0000-4000-8000-000000000011',
  '90000000-0000-4000-8000-000000000003',
  '90000000-0000-4000-8000-000000000002',
  'outbound',
  'wamid.policy.outbound',
  'template',
  'Recordatorio',
  'appointment_reminder_24h',
  'sent',
  'test:template:allowed',
  jsonb_build_object(
    'source', 'reminder',
    'template_key', 'appointment_reminder_24h',
    'appointment_id', '90000000-0000-4000-8000-000000000004'
  )
);

select pg_temp.assert_true(
  (
    select metadata ->> 'policy_basis' = 'explicit_appointment_updates_consent'
      and metadata ->> 'consent_event_id' is not null
    from public.messages
    where id = '90000000-0000-4000-8000-000000000011'
  ),
  'template must retain the consent decision used at dispatch'
);

-- Delivery events never regress status and never replace policy metadata.
select public.apply_whatsapp_message_status(
  'wamid.policy.outbound',
  'delivered',
  now(),
  '{"delivery_test":"delivered"}'::jsonb
);
select public.apply_whatsapp_message_status(
  'wamid.policy.outbound',
  'read',
  now() + interval '2 seconds',
  '{"delivery_test":"read"}'::jsonb
);
select public.apply_whatsapp_message_status(
  'wamid.policy.outbound',
  'delivered',
  now() + interval '1 second',
  '{"delivery_test":"stale"}'::jsonb
);

select pg_temp.assert_true(
  (
    select status = 'read'
      and metadata ->> 'delivery_test' = 'read'
      and metadata ->> 'policy_basis' = 'explicit_appointment_updates_consent'
    from public.messages
    where id = '90000000-0000-4000-8000-000000000011'
  ),
  'out-of-order status must not regress or erase policy metadata'
);

update public.conversations
set last_inbound_message_at = clock_timestamp() - interval '1 second'
where id = '90000000-0000-4000-8000-000000000003';

select public.record_whatsapp_consent(
  '90000000-0000-4000-8000-000000000002',
  'opt_out',
  'all',
  'whatsapp',
  'whatsapp_message:wamid.policy.optout',
  '2026-08-10',
  'wamid.policy.optout'
);

select pg_temp.assert_true(
  (
    select whatsapp_consent_status = 'opted_out'
      and whatsapp_opt_out_at is not null
    from public.contacts
    where id = '90000000-0000-4000-8000-000000000002'
  ),
  'opt-out must materialize suppression state'
);

select pg_temp.assert_true(
  (
    select automation_mode = 'manual' and needs_human
    from public.conversations
    where id = '90000000-0000-4000-8000-000000000003'
  ),
  'opt-out must stop automation'
);

do $$
begin
  begin
    insert into public.messages (
      conversation_id, contact_id, direction, type, body, status,
      idempotency_key, metadata
    ) values (
      '90000000-0000-4000-8000-000000000003',
      '90000000-0000-4000-8000-000000000002',
      'outbound', 'text', 'No debe salir', 'pending',
      'test:service:after-optout', '{"source":"automation"}'::jsonb
    );
    raise exception 'expected opt-out block';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'POLICY_CONTACT_OPTED_OUT' then raise; end if;
  end;
end;
$$;

update public.whatsapp_settings
set sending_paused = true, sending_pause_reason = 'TEST_CIRCUIT_BREAKER'
where id = true;

update public.messages
set status = 'failed'
where id = '90000000-0000-4000-8000-000000000010';

do $$
begin
  begin
    update public.messages
    set status = 'pending'
    where id = '90000000-0000-4000-8000-000000000010';
    raise exception 'expected retry circuit breaker';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'POLICY_SENDING_PAUSED' then raise; end if;
  end;
end;
$$;

do $$
begin
  begin
    insert into public.messages (
      conversation_id, contact_id, direction, type, body, status,
      idempotency_key, metadata
    ) values (
      '90000000-0000-4000-8000-000000000003',
      '90000000-0000-4000-8000-000000000002',
      'outbound', 'text', 'No debe salir', 'pending',
      'test:service:paused', '{"source":"operator"}'::jsonb
    );
    raise exception 'expected circuit breaker';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'POLICY_SENDING_PAUSED' then raise; end if;
  end;
end;
$$;

select pg_temp.assert_true(
  (
    select not reminder_24h_enabled and not reminder_2h_enabled
    from public.app_settings
    where id = true
  ),
  'proactive reminders must default to off'
);

select pass('WhatsApp policy assertions passed');
select * from finish();

rollback;

\echo 'whatsapp_policy.sql: all assertions passed'
