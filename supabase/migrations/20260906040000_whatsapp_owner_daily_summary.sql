-- Agenda privada de la única profesional. La allowlist permanece como secreto
-- del backend; el navegador no puede autorizar destinatarios ni mutar evidencia.
create table public.whatsapp_owner_daily_summaries (
  id uuid primary key default gen_random_uuid(),
  summary_date date not null unique,
  contact_id uuid references public.contacts(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  inbound_message_id uuid references public.messages(id) on delete set null,
  body text check (body is null or char_length(body) between 1 and 4096),
  status text not null check (status in ('processing', 'sent', 'skipped', 'failed')),
  reason text,
  attempts integer not null default 0 check (attempts between 0 and 3),
  processing_started_at timestamptz,
  message_id uuid references public.messages(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.whatsapp_owner_daily_summaries enable row level security;
revoke all on public.whatsapp_owner_daily_summaries from public, anon, authenticated;
grant all on public.whatsapp_owner_daily_summaries to service_role;

-- El día, la hora y la vigencia no vienen del request. El snapshot de cuerpo y
-- destinatario del primer intento se conserva para todos los reintentos.
create function public.claim_whatsapp_owner_daily_summary(
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
begin
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
    summary_date, contact_id, conversation_id, inbound_message_id, body,
    status, reason, attempts, processing_started_at
  ) values (
    v_today, p_contact_id, p_conversation_id, p_inbound_message_id,
    case when v_skip is null then p_body end,
    case when v_skip is null then 'processing' else 'skipped' end,
    v_skip, case when v_skip is null then 1 else 0 end,
    case when v_skip is null then v_now end
  ) on conflict (summary_date) do nothing returning * into v_summary;
  v_inserted := found;
  if v_inserted then return next v_summary; return; end if;

  select * into v_summary from public.whatsapp_owner_daily_summaries
    where summary_date = v_today for update;
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
revoke all on function public.claim_whatsapp_owner_daily_summary(uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_whatsapp_owner_daily_summary(uuid, uuid, uuid, text, text) to service_role;

-- Defensa adicional en persistencia; el guard final del backend comprueba
-- también la allowlist de servidor y el destinatario real que recibe Graph.
create function public.enforce_whatsapp_private_owner_message()
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
  ) then raise exception 'POLICY_OWNER_SUMMARY_NOT_DUE'; end if;
  return new;
end;
$$;
revoke all on function public.enforce_whatsapp_private_owner_message() from public, anon, authenticated, service_role;
create trigger enforce_whatsapp_private_owner_message
  before insert or update on public.messages
  for each row execute function public.enforce_whatsapp_private_owner_message();
