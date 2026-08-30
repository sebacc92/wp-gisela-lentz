-- "Reactivar bot" devolvía la conversación a modo automático, pero el bot
-- recién contestaba el mensaje siguiente: lo que había quedado sin responder
-- seguía sin respuesta. Pasa cuando algo pausa la conversación —una nota de
-- voz, un comprobante— y nadie llega a contestar a mano.
--
-- Esta función reanuda y, además, vuelve a poner en cola el último mensaje
-- entrante para que la automatización lo conteste.
--
-- La idempotencia se mantiene: sólo se reabre un despacho que nunca corrió. Si
-- la automatización ya procesó ese mensaje, repetirlo duplicaría sus efectos
-- —una pre-reserva, un pedido de seña— así que no se reabre.
create or replace function public.resume_whatsapp_automation_for_last_inbound(
  p_conversation_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  conversation_row public.conversations%rowtype;
  contact_row public.contacts%rowtype;
  message_row public.messages%rowtype;
  dispatch_row public.whatsapp_automation_dispatches%rowtype;
begin
  if auth.role() <> 'service_role' and not exists (
    select 1 from public.profiles where id = auth.uid() and active
  ) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select * into conversation_row
  from public.conversations
  where id = p_conversation_id
  for update;
  if not found then
    raise exception 'CONVERSATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into contact_row
  from public.contacts
  where id = conversation_row.contact_id;

  -- Una baja de WhatsApp no se puede revertir desde acá.
  if contact_row.whatsapp_consent_status = 'opted_out' then
    return 'CONTACT_OPTED_OUT';
  end if;

  update public.conversations
  set automation_mode = 'auto',
      needs_human = false,
      priority = false,
      automation_pause_source = null,
      automation_pause_message_id = null
  where id = p_conversation_id;

  select message.* into message_row
  from public.messages message
  where message.conversation_id = p_conversation_id
    and message.direction = 'inbound'
  -- `whatsapp_ingest_sequence` es monotónica; `created_at` no sirve para
  -- ordenar porque devuelve la hora de la transacción y dos mensajes de la
  -- misma pueden empatar.
  order by message.whatsapp_ingest_sequence desc
  limit 1;
  if not found then
    return 'RESUMED_WITHOUT_PENDING_MESSAGE';
  end if;

  -- Si ya salió una respuesta posterior, manual o del bot, no hay nada
  -- pendiente que contestar.
  if exists (
    select 1
    from public.messages message
    where message.conversation_id = p_conversation_id
      and message.direction = 'outbound'
      and message.whatsapp_ingest_sequence > message_row.whatsapp_ingest_sequence
  ) then
    return 'ALREADY_ANSWERED';
  end if;

  select dispatch.* into dispatch_row
  from public.whatsapp_automation_dispatches dispatch
  where dispatch.message_id = message_row.id
  for update;
  if not found then
    return 'RESUMED_WITHOUT_PENDING_MESSAGE';
  end if;

  if dispatch_row.status <> 'completed'
    or exists (
      select 1
      from public.whatsapp_automation_executions execution
      where execution.message_id = message_row.id
    ) then
    return 'ALREADY_PROCESSED';
  end if;

  update public.whatsapp_automation_dispatches
  set status = 'pending',
      attempts = 0,
      available_at = now(),
      processing_started_at = null,
      lease_expires_at = null,
      lease_token = null,
      completed_at = null,
      completion_reason = null,
      last_error = null
  where id = dispatch_row.id;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(),
    'whatsapp.automation_resumed_for_last_inbound',
    'conversation',
    p_conversation_id,
    jsonb_build_object('message_id', message_row.id)
  );

  return 'DISPATCHED';
end;
$$;

revoke execute on function public.resume_whatsapp_automation_for_last_inbound(uuid)
  from public, anon;
grant execute on function public.resume_whatsapp_automation_for_last_inbound(uuid)
  to authenticated, service_role;
