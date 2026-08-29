-- WhatsApp entrega las notas de voz como mensajes `audio`. El webhook de Cloud
-- API no las contemplaba: caían en la rama final del normalizador, se guardaban
-- como texto con el cuerpo "Mensaje no compatible" y se descartaba el
-- `media_id`, así que el audio quedaba irrecuperable desde la aplicación.
--
-- El valor del enum se agrega solo, sin usarlo: Postgres no permite emplear un
-- valor nuevo dentro de la misma transacción que lo crea. La migración
-- siguiente reescribe el mapeo de Coexistence que hasta ahora lo degradaba a
-- `document`.
alter type public.message_type add value if not exists 'audio';
