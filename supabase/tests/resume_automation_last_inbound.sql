\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(1);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

update public.app_settings set automations_enabled = true where id;

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

insert into public.contacts (id, phone_e164, whatsapp_id, name, coverage)
values (
  '96000000-0000-4000-8000-000000000010',
  '+5491100009960', '5491100009960', 'Paciente Reanudar Test', 'particular'
);

insert into public.conversations (id, contact_id, automation_mode, needs_human)
values (
  '96000000-0000-4000-8000-000000000020',
  '96000000-0000-4000-8000-000000000010',
  'manual',
  true
);

-- `automation_dispatch_reserved` es la marca que usa el webhook real para que
-- la base reserve el despacho en la misma transacción del INSERT.
insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, whatsapp_message_id,
  metadata
) values (
  '96000000-0000-4000-8000-000000000030',
  '96000000-0000-4000-8000-000000000020',
  '96000000-0000-4000-8000-000000000010',
  'inbound', 'text', 'Me das los turnos de mañana', 'wamid.resume.test.1',
  '{"automation_dispatch_reserved": true}'::jsonb
);

-- El trigger del INSERT crea el despacho; la automatización no corrió, así que
-- quedó completado sin ejecución. Es el caso que el botón tiene que reabrir.
update public.whatsapp_automation_dispatches
set status = 'completed', completed_at = now(), completion_reason = 'skipped'
where message_id = '96000000-0000-4000-8000-000000000030';

select pg_temp.assert_true(
  public.resume_whatsapp_automation_for_last_inbound(
    '96000000-0000-4000-8000-000000000020'
  ) = 'DISPATCHED',
  'a paused conversation with an unanswered message must be dispatched again'
);

select pg_temp.assert_true(
  (
    select automation_mode = 'auto' and not needs_human
    from public.conversations
    where id = '96000000-0000-4000-8000-000000000020'
  ),
  'the conversation must return to automatic mode'
);

select pg_temp.assert_true(
  (
    select status = 'pending' and attempts = 0
    from public.whatsapp_automation_dispatches
    where message_id = '96000000-0000-4000-8000-000000000030'
  ),
  'the dispatch must be queued again for the processor'
);

-- Reabrir dos veces no debe encolar dos veces: el despacho ya no está
-- completado, así que la segunda llamada no hace nada. La función además
-- rechaza cualquier mensaje que ya tenga una ejecución registrada, que es la
-- garantía de fondo contra duplicar una pre-reserva o un pedido de seña.
select pg_temp.assert_true(
  public.resume_whatsapp_automation_for_last_inbound(
    '96000000-0000-4000-8000-000000000020'
  ) = 'ALREADY_PROCESSED',
  'a dispatch already queued must not be queued twice'
);

select pg_temp.assert_true(
  (
    select count(*) = 1
    from public.whatsapp_automation_dispatches
    where message_id = '96000000-0000-4000-8000-000000000030'
  ),
  'reopening must never create a second dispatch for the same message'
);

-- Con una respuesta posterior no hay nada pendiente que contestar.
insert into public.messages (
  id, conversation_id, contact_id, direction, type, body, whatsapp_message_id,
  idempotency_key, metadata
) values (
  '96000000-0000-4000-8000-000000000031',
  '96000000-0000-4000-8000-000000000020',
  '96000000-0000-4000-8000-000000000010',
  'outbound', 'text', 'Respuesta manual', 'wamid.resume.test.2',
  'test:resume:1', '{"source": "operator_message"}'::jsonb
);

select pg_temp.assert_true(
  public.resume_whatsapp_automation_for_last_inbound(
    '96000000-0000-4000-8000-000000000020'
  ) = 'ALREADY_ANSWERED',
  'a message that already got an answer is not answered again'
);

select pass('resuming the bot never reprocesses an answered message');
select * from finish();

rollback;
