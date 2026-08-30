-- El kill switch del servidor queda habilitado para que el interruptor de la
-- aplicación pueda gobernar el bot. La posición operativa segura, incluida la
-- que debe quedar aplicada al desplegar este cambio, es apagado.
alter table public.app_settings
  alter column automations_enabled set default false;

update public.app_settings
set automations_enabled = false
where id
  and automations_enabled;
