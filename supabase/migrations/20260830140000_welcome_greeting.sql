-- El saludo que Gisela usa al recibir un mensaje. Antes la bienvenida sólo
-- aparecía cuando el paciente no pedía nada concreto: si el primer mensaje ya
-- decía "quiero un turno", el bot entraba directo al flujo y nunca saludaba.
-- Ahora sale siempre como primer mensaje, antes de pedir cualquier dato.
update public.app_settings
set automation_welcome_message =
  E'Hola!!!☺️ Gracias por comunicarte con el Consultorio Odontológico Lentz Gisela.\n\nPara agendar tu turno envíanos:'
where id = true;
