-- La bienvenida abre el alta sin adelantar los cuatro datos en una lista.
-- Cada dato se solicita luego en su propio turno de la automatización.
alter table public.app_settings
  alter column automation_welcome_message set default
    'Hola!!!☺️ Gracias por comunicarte con el Consultorio Odontológico Lentz Gisela. Para agendar tu turno envíanos:';

update public.app_settings
set automation_welcome_message =
  'Hola!!!☺️ Gracias por comunicarte con el Consultorio Odontológico Lentz Gisela. Para agendar tu turno envíanos:'
where id = true;

comment on column public.app_settings.automation_welcome_message is
  'Saludo inicial breve. El flujo solicita nombre, paciente anterior, teléfono de contacto y cobertura de a un dato por mensaje.';
