alter table public.app_settings
  add column automation_welcome_message text not null default
    E'¡Hola! Gracias por comunicarte con COLP.\n\n📌 Información importante:\nLos turnos solicitados por este medio pueden presentar demoras. Por favor, aguardá nuestro llamado para la confirmación.\n\nPara gestionar tu solicitud, envianos:\n• Nombre y apellido\n• Obra social o atención particular\n• Email\n• Profesional o especialidad de preferencia\n• Celular de contacto para el turno (obligatorio)\n\nImportante: te llamaremos al celular informado. Por favor, atendé el llamado.\n\nPara proteger tu privacidad, cualquier dato adicional necesario será solicitado durante el contacto.\n\nTambién podés elegir una opción del menú.\n\n¡Muchas gracias!';

alter table public.app_settings
  add constraint app_settings_automation_welcome_message_length_check check (
    char_length(trim(automation_welcome_message)) between 1 and 1024
  );

comment on column public.app_settings.automation_welcome_message is
  'Mensaje mostrado en la primera respuesta automática de una sesión. No debe solicitar identificadores sensibles ni información clínica.';
