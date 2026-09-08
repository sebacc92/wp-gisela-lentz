\set ON_ERROR_STOP on
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(20);

-- Fixed clock only inside this rolled-back test transaction; production never
-- accepts a caller-supplied current time for private-message authorization.
do $$
begin
  execute replace(pg_get_functiondef('public.claim_whatsapp_owner_daily_summary(text,uuid,uuid,uuid,text,text)'::regprocedure),
    'v_now timestamptz := clock_timestamp();',
    'v_now timestamptz := ''2026-09-07T00:00:00Z''::timestamptz;');
  execute replace(pg_get_functiondef('public.enforce_whatsapp_private_owner_message()'::regprocedure),
    'v_now timestamptz := clock_timestamp();',
    'v_now timestamptz := ''2026-09-07T00:00:00Z''::timestamptz;');
end $$;
select set_config('app.whatsapp_policy_seed_bypass', 'on', true);
update public.app_settings set automations_enabled = true where id = true;
delete from public.whatsapp_owner_daily_summaries where summary_date = date '2026-09-06';
insert into public.contacts(id,phone_e164,whatsapp_id,name)
values ('97000000-0000-4000-8000-000000000001', '+5491112345678','5491112345678','Gisela sintética');
insert into public.conversations(id,contact_id,last_inbound_message_at,automation_mode)
values ('97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000001','2026-09-06T23:00:00Z','auto');
insert into public.messages(id,conversation_id,contact_id,direction,type,status,created_at,metadata)
values ('97000000-0000-4000-8000-000000000003','97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000001',
'inbound','text','delivered','2026-09-06T23:00:00Z','{"sender_identity_source":"signed_meta_webhook","verified_sender_phone_e164":"+5491112345678"}');
-- Segundo teléfono autorizado por el secreto, con su propia evidencia firmada.
insert into public.contacts(id,phone_e164,whatsapp_id,name)
values ('97000000-0000-4000-8000-000000000011', '+5491112345679','5491112345679','Segundo autorizado sintético');
insert into public.conversations(id,contact_id,last_inbound_message_at,automation_mode)
values ('97000000-0000-4000-8000-000000000012','97000000-0000-4000-8000-000000000011','2026-09-06T23:00:00Z','auto');
insert into public.messages(id,conversation_id,contact_id,direction,type,status,created_at,metadata)
values ('97000000-0000-4000-8000-000000000013','97000000-0000-4000-8000-000000000012','97000000-0000-4000-8000-000000000011',
'inbound','text','delivered','2026-09-06T23:00:00Z','{"sender_identity_source":"signed_meta_webhook","verified_sender_phone_e164":"+5491112345679"}');

select ok(not has_table_privilege('authenticated','public.messages','UPDATE'), 'Navegador no puede cambiar evidencia firmada');
select ok(not has_table_privilege('authenticated','public.whatsapp_owner_daily_summaries','SELECT'), 'Ledger privado no se publica al navegador');
select ok(not has_function_privilege('authenticated','public.claim_whatsapp_owner_daily_summary(text,uuid,uuid,uuid,text,text)','EXECUTE'), 'Navegador no puede reclamar agenda privada');
select is((select status from public.claim_whatsapp_owner_daily_summary(
'+5491112345678','97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000003','Primer snapshot',null)),
'processing','Primer claim en 21:00 y ventana vigente');
select is((select count(*) from public.claim_whatsapp_owner_daily_summary(
'+5491112345678','97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000003','Cambió agenda',null)),0::bigint,'Doble cron no reclama un envío en curso');
update public.whatsapp_owner_daily_summaries set status = 'failed', processing_started_at = null where summary_date = '2026-09-06';
select is((select body from public.claim_whatsapp_owner_daily_summary(
'+5491112345678','97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000003','Cambió agenda',null)),
'Primer snapshot','Retry conserva contenido original');
select is((select attempts from public.whatsapp_owner_daily_summaries where summary_date = '2026-09-06'),2,'Retry contado');
select lives_ok($test$ insert into public.messages(conversation_id,contact_id,direction,type,body,status,idempotency_key,metadata)
select conversation_id,contact_id,'outbound','text',body,'pending','owner-summary:2026-09-06',jsonb_build_object(
'source','owner_daily_summary','inbound_message_id',inbound_message_id,'owner_summary_id',id,'owner_summary_date','2026-09-06')
from public.whatsapp_owner_daily_summaries where summary_date = '2026-09-06' $test$, 'Texto privado requiere claim válido y evidencia real');
select throws_ok($test$ insert into public.messages(conversation_id,contact_id,direction,type,body,status,idempotency_key,metadata)
select conversation_id,contact_id,'outbound','template',body,'pending','owner-summary:invalid-template',jsonb_build_object(
'source','owner_daily_summary','inbound_message_id',inbound_message_id,'owner_summary_id',id)
from public.whatsapp_owner_daily_summaries where summary_date = '2026-09-06' $test$, 'P0001','POLICY_OWNER_RECIPIENT_UNVERIFIED','Nunca admite plantilla privada');
select throws_ok($test$ insert into public.messages(conversation_id,contact_id,direction,type,body,status,idempotency_key,metadata)
select conversation_id,contact_id,'outbound','text','Cuerpo modificado','pending','owner-summary:invalid-body',jsonb_build_object(
'source','owner_daily_summary','inbound_message_id',inbound_message_id,'owner_summary_id',id)
from public.whatsapp_owner_daily_summaries where summary_date = '2026-09-06' $test$, 'P0001','POLICY_OWNER_SUMMARY_NOT_DUE','No admite cambiar snapshot privado');
update public.whatsapp_owner_daily_summaries set status = 'sent' where summary_date = '2026-09-06';
select is((select count(*) from public.claim_whatsapp_owner_daily_summary(
'+5491112345678','97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000003','Otro',null)),0::bigint,'Enviado nunca se reclama otra vez');
-- El día dejó de identificar al despacho: lo identifica fecha + destinatario.
delete from public.whatsapp_owner_daily_summaries where summary_date = date '2026-09-06';
select is((select status from public.claim_whatsapp_owner_daily_summary(
'+5491112345679','97000000-0000-4000-8000-000000000011','97000000-0000-4000-8000-000000000012','97000000-0000-4000-8000-000000000013','Agenda del segundo',null)),
'processing','Segundo teléfono autorizado reclama su propia fila');
select is((select count(*) from public.whatsapp_owner_daily_summaries where summary_date = '2026-09-06'),1::bigint,'Un despacho por destinatario');
select is((select status from public.claim_whatsapp_owner_daily_summary(
'+5491112345678','97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000003','Agenda de la profesional',null)),
'processing','El despacho de un teléfono no bloquea el del otro');
select is((select count(*) from public.whatsapp_owner_daily_summaries where summary_date = '2026-09-06'),2::bigint,'Dos filas del mismo día, una por teléfono');
delete from public.whatsapp_owner_daily_summaries where summary_date = date '2026-09-06';
select is((select status from public.claim_whatsapp_owner_daily_summary(
'+5491112345679','97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000003','Agenda cruzada',null)),
'skipped','Un teléfono autorizado no reclama la evidencia de otro contacto');
select throws_ok($test$ select status from public.claim_whatsapp_owner_daily_summary(
'2291575215','97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000003','Sin E.164',null) $test$,
'P0001','OWNER_SUMMARY_RECIPIENT_INVALID','Un destinatario que no es E.164 exacto no reclama nada');

-- New ledger attempt with an exactly expired service window.
delete from public.whatsapp_owner_daily_summaries where summary_date = '2026-09-06';
update public.messages set created_at = '2026-09-06T00:00:00Z' where id = '97000000-0000-4000-8000-000000000003';
select is((select status from public.claim_whatsapp_owner_daily_summary(
'+5491112345678','97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000003','No enviar',null)),
'skipped','A las 24 horas exactas omite resumen');
select is((select body from public.whatsapp_owner_daily_summaries where summary_date = '2026-09-06'),null::text,'No guarda pacientes si omite resumen');
select throws_ok($test$ insert into public.messages(conversation_id,contact_id,direction,type,body,status,idempotency_key,metadata)
values ('97000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000001','outbound','text','Privado','pending','owner-invalid-proof',
'{"source":"owner_access","inbound_message_id":"97000000-0000-4000-8000-000000000003"}') $test$,
'P0001','POLICY_OWNER_RECIPIENT_UNVERIFIED','También protege respuesta directa con evidencia vencida');
select * from finish();
rollback;
