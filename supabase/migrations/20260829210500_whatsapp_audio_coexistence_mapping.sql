-- El camino de Coexistence sí conservaba los audios, pero los degradaba al tipo
-- `document` porque la bandeja tenía un único renderizador genérico de adjuntos.
-- Ahora que existe el tipo propio, los mensajes nuevos lo usan y la bandeja
-- puede ofrecer un reproductor en vez de un enlace de descarga.
--
-- Las filas históricas conservan el tipo con el que se guardaron. No se
-- reescriben: `whatsapp_message_type` ya retiene el tipo original de Meta y
-- reinterpretar mensajes ya entregados no aportaría nada.
create or replace function public.map_whatsapp_coexistence_message_type(
  p_whatsapp_message_type text
)
returns public.message_type
language sql
immutable
set search_path = public
as $$
  select case lower(trim(coalesce(p_whatsapp_message_type, '')))
    when 'text' then 'text'::public.message_type
    when 'image' then 'image'::public.message_type
    when 'document' then 'document'::public.message_type
    when 'audio' then 'audio'::public.message_type
    -- Video y sticker siguen usando el renderizador genérico de adjuntos.
    -- El tipo original de Meta siempre queda en whatsapp_message_type.
    when 'video' then 'document'::public.message_type
    when 'sticker' then 'document'::public.message_type
    when 'interactive' then 'interactive'::public.message_type
    when 'button' then 'interactive'::public.message_type
    when 'template' then 'template'::public.message_type
    else 'system'::public.message_type
  end;
$$;
