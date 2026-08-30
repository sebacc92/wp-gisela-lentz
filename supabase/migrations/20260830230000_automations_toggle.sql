-- Hasta ahora apagar el bot exigía cambiar un secreto de servidor: rápido para
-- quien tiene la CLI, imposible para Gisela. Este interruptor vive en la base y
-- se maneja desde la aplicación.
--
-- No reemplaza a `WHATSAPP_AUTOMATIONS_ENABLED`, que sigue siendo el kill
-- switch de backend: la automatización exige los dos. El de servidor es la
-- palanca de emergencia; éste es el del día a día.
alter table public.app_settings
  add column automations_enabled boolean not null default true;

comment on column public.app_settings.automations_enabled is
  'Interruptor operativo del bot, manejable desde la aplicación. La automatización además exige el kill switch de servidor WHATSAPP_AUTOMATIONS_ENABLED.';

-- Encender o apagar el bot es el cambio de configuración que más conviene poder
-- reconstruir después, así que queda registrado con su autor.
create or replace function public.audit_automations_toggle()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.automations_enabled is distinct from new.automations_enabled then
    insert into public.audit_logs (
      actor_user_id, action, entity_type, metadata
    ) values (
      auth.uid(),
      'whatsapp.automations_toggled',
      'app_settings',
      jsonb_build_object('enabled', new.automations_enabled)
    );
  end if;
  return new;
end;
$$;

create trigger audit_automations_toggle
  after update of automations_enabled on public.app_settings
  for each row execute function public.audit_automations_toggle();

revoke execute on function public.audit_automations_toggle()
  from public, anon, authenticated, service_role;
