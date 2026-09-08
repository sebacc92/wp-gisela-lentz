-- La agenda privada deja de tener un único destinatario posible. El secreto de
-- servidor puede autorizar más de un teléfono nominado, así que el resumen de
-- las 21:00 se prepara y se envía una vez por destinatario: el día ya no
-- identifica al despacho, lo identifica el par fecha + teléfono. Sin esto, el
-- primer envío de la noche bloquea el del otro número por la clave única.
alter table public.whatsapp_owner_daily_summaries
  add column recipient_phone_e164 text;

update public.whatsapp_owner_daily_summaries s
  set recipient_phone_e164 = c.phone_e164
  from public.contacts c
  where c.id = s.contact_id and s.recipient_phone_e164 is null;

-- Una omisión anterior pudo quedar sin contacto. No se inventa un teléfono: la
-- marca conserva la fila de auditoría y nunca coincide con un destinatario real.
update public.whatsapp_owner_daily_summaries
  set recipient_phone_e164 = 'legacy:' || id::text
  where recipient_phone_e164 is null;

alter table public.whatsapp_owner_daily_summaries
  alter column recipient_phone_e164 set not null,
  add constraint whatsapp_owner_daily_summaries_recipient_valid check (
    recipient_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
    or recipient_phone_e164 like 'legacy:%'
  ),
  drop constraint whatsapp_owner_daily_summaries_summary_date_key,
  add constraint whatsapp_owner_daily_summaries_date_recipient_key
    unique (summary_date, recipient_phone_e164);

-- El destinatario entra al claim y se comprueba contra el contacto: un teléfono
-- que no es el del contacto verificado no puede reclamar su agenda.
drop function public.claim_whatsapp_owner_daily_summary(uuid, uuid, uuid, text, text);

create function public.claim_whatsapp_owner_daily_summary(
  p_recipient_phone text,
  p_contact_id uuid,
  p_conversation_id uuid,
  p_inbound_message_id uuid,
  p_body text,
  p_skip_reason text default null
)
returns setof public.whatsapp_owner_daily_summaries
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_today date := (v_now at time zone 'America/Argentina/Buenos_Aires')::date;
  v_local_time time := (v_now at time zone 'America/Argentina/Buenos_Aires')::time;
  v_summary public.whatsapp_owner_daily_summaries%rowtype;
  v_inserted boolean;
  v_skip text := nullif(p_skip_reason, '');
  v_phone text := nullif(trim(p_recipient_phone), '');
begin
  if v_phone is null or v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'OWNER_SUMMARY_RECIPIENT_INVALID';
  end if;
  if v_local_time < time '21:00' or v_local_time >= time '21:15' then return; end if;
  if not exists (select 1 from public.app_settings where id = true and automations_enabled) then return; end if;
  if v_skip is null and not exists (
    select 1 from public.messages m
    join public.contacts c on c.id = m.contact_id
    join public.conversations conv on conv.id = m.conversation_id and conv.contact_id = c.id
    where m.id = p_inbound_message_id and c.id = p_contact_id
      and conv.id = p_conversation_id and conv.status = 'open'
      and conv.automation_mode = 'auto'
      and c.whatsapp_consent_status <> 'opted_out'
      and c.phone_e164 = v_phone
      and m.direction = 'inbound' and m.whatsapp_origin = 'cloud_api'
      and m.metadata ->> 'sender_identity_source' = 'signed_meta_webhook'
      and m.metadata ->> 'verified_sender_phone_e164' = c.phone_e164
      and m.created_at <= v_now and m.created_at > v_now - interval '24 hours'
      and conv.last_inbound_message_at <= v_now
      and conv.last_inbound_message_at > v_now - interval '24 hours'
  ) then v_skip := 'OWNER_RECIPIENT_UNVERIFIED'; end if;
  if v_skip is null and (p_body is null or char_length(p_body) not between 1 and 4096) then
    raise exception 'OWNER_SUMMARY_BODY_INVALID';
  end if;

  insert into public.whatsapp_owner_daily_summaries (
    summary_date, recipient_phone_e164, contact_id, conversation_id,
    inbound_message_id, body, status, reason, attempts, processing_started_at
  ) values (
    v_today, v_phone, p_contact_id, p_conversation_id, p_inbound_message_id,
    case when v_skip is null then p_body end,
    case when v_skip is null then 'processing' else 'skipped' end,
    v_skip, case when v_skip is null then 1 else 0 end,
    case when v_skip is null then v_now end
  ) on conflict (summary_date, recipient_phone_e164) do nothing returning * into v_summary;
  v_inserted := found;
  if v_inserted then return next v_summary; return; end if;

  select * into v_summary from public.whatsapp_owner_daily_summaries
    where summary_date = v_today and recipient_phone_e164 = v_phone for update;
  if v_summary.status in ('sent', 'skipped') then return; end if;
  if v_skip is not null then
    update public.whatsapp_owner_daily_summaries set status = 'skipped', reason = v_skip,
      processing_started_at = null where id = v_summary.id;
    return;
  end if;
  if v_summary.attempts >= 3 or
     (v_summary.status = 'processing' and v_summary.processing_started_at > v_now - interval '2 minutes') then return; end if;
  if v_summary.contact_id is distinct from p_contact_id or
     v_summary.conversation_id is distinct from p_conversation_id then return; end if;
  return query update public.whatsapp_owner_daily_summaries
    set status = 'processing', processing_started_at = v_now, attempts = attempts + 1, reason = null
    where id = v_summary.id returning *;
end;
$$;
revoke all on function public.claim_whatsapp_owner_daily_summary(text, uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_whatsapp_owner_daily_summary(text, uuid, uuid, uuid, text, text) to service_role;

-- El guard de persistencia ata el mensaje privado al destinatario del ledger:
-- el resumen preparado para un teléfono no puede salir hacia el otro.
create or replace function public.enforce_whatsapp_private_owner_message()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_source text := new.metadata ->> 'source';
  v_inbound public.messages%rowtype;
begin
  if new.direction <> 'outbound' or coalesce(v_source, '') not in ('owner_access', 'owner_daily_summary') then return new; end if;
  if tg_op = 'UPDATE' and not (old.status = 'failed' and new.status = 'pending') then return new; end if;
  select * into v_inbound from public.messages
    where id::text = new.metadata ->> 'inbound_message_id'
      and contact_id = new.contact_id and conversation_id = new.conversation_id
      and direction = 'inbound' and whatsapp_origin = 'cloud_api';
  if not found or new.type <> 'text'
    or coalesce(v_inbound.metadata ->> 'sender_identity_source', '') <> 'signed_meta_webhook'
    or not exists (select 1 from public.contacts c where c.id = new.contact_id
      and c.phone_e164 = v_inbound.metadata ->> 'verified_sender_phone_e164')
    or v_inbound.created_at > v_now or v_inbound.created_at <= v_now - interval '24 hours'
  then raise exception 'POLICY_OWNER_RECIPIENT_UNVERIFIED'; end if;
  if v_source = 'owner_daily_summary' and not exists (
    select 1 from public.whatsapp_owner_daily_summaries s
    join public.app_settings settings on settings.id = true and settings.automations_enabled
    join public.contacts c on c.id = s.contact_id and c.whatsapp_consent_status <> 'opted_out'
    where s.id::text = new.metadata ->> 'owner_summary_id' and s.status = 'processing'
      and s.summary_date = (v_now at time zone 'America/Argentina/Buenos_Aires')::date
      and (v_now at time zone 'America/Argentina/Buenos_Aires')::time >= time '21:00'
      and (v_now at time zone 'America/Argentina/Buenos_Aires')::time < time '21:15'
      and s.body = new.body and s.contact_id = new.contact_id
      and s.conversation_id = new.conversation_id and s.inbound_message_id = v_inbound.id
      and s.recipient_phone_e164 = c.phone_e164
  ) then raise exception 'POLICY_OWNER_SUMMARY_NOT_DUE'; end if;
  return new;
end;
$$;
revoke all on function public.enforce_whatsapp_private_owner_message() from public, anon, authenticated, service_role;
