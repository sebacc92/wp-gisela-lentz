-- Hasta ahora el asistente administrativo nunca enviaba el contenido original
-- del paciente: sólo una pregunta canónica y los datos institucionales del
-- consultorio. Transcribir una nota de voz o leer un comprobante sí implica
-- mandar ese contenido a un tercero, así que es una decisión distinta y tiene
-- su propio interruptor en vez de colgarse de `ai_enabled`.
--
-- Queda apagado. Encenderlo requiere además `ai_enabled`, el kill switch de
-- servidor `OPENAI_ADMINISTRATIVE_ENABLED` y las automatizaciones globales.
alter table public.app_settings
  add column ai_media_enabled boolean not null default false;

comment on column public.app_settings.ai_media_enabled is
  'Autoriza enviar audios, imágenes y PDF entrantes a OpenAI para transcribirlos o leerlos. La lectura de un comprobante es un dato auxiliar: nunca confirma una seña.';

-- La auditoría existente sólo miraba ai_enabled y ai_model. Encender o apagar
-- el envío de medios es justamente el cambio que hay que poder reconstruir
-- después, así que entra al mismo registro.
create or replace function public.audit_openai_administrative_settings_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.ai_enabled is distinct from new.ai_enabled
    or old.ai_model is distinct from new.ai_model
    or old.ai_media_enabled is distinct from new.ai_media_enabled
  then
    insert into public.audit_logs (
      actor_user_id,
      action,
      entity_type,
      metadata
    ) values (
      auth.uid(),
      'openai.administrative_settings_updated',
      'app_settings',
      jsonb_build_object(
        'enabled', new.ai_enabled,
        'model', new.ai_model,
        'media_enabled', new.ai_media_enabled
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists audit_openai_administrative_settings_change
  on public.app_settings;
create trigger audit_openai_administrative_settings_change
  after update of ai_enabled, ai_model, ai_media_enabled
  on public.app_settings
  for each row
  execute function public.audit_openai_administrative_settings_change();

revoke all on function public.audit_openai_administrative_settings_change()
  from public, anon, authenticated, service_role;
