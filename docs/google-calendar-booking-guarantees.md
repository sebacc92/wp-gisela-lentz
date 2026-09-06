# Reservas y confirmaciones con Google Calendar

La agenda de esta aplicación pertenece a Gisela Lentz y necesita el calendario
autorizado para reservar. La migración
`20260906183000_google_calendar_booking_projection_required.sql` elimina la
disponibilidad basada sólo en la base local cuando la conexión está desconectada
o la automatización no tiene una autorización vigente. La lectura entrante
completa debe seguir dentro de la antigüedad máxima de tres minutos y cubrir el
turno y su margen; el bot también exige una actualización de Google en su
ejecución antes de reservar.

## Guardar y confirmar

1. La base valida los horarios y guarda el turno junto con su trabajo de
   sincronización en una transacción. Los reintentos conservan el mismo turno.
2. El worker importa cambios de Google y, antes de cada POST o PATCH, vuelve a
   consultar el intervalo concreto, incluido el margen final. Pagina la respuesta
   y contempla eventos de todo el día y ocurrencias recurrentes. Un error,
   resultado incompleto u ocupación bloquea la escritura.
3. La aplicación consulta `appointment_google_calendar_projection`. Sólo
   `synced` prueba que Google confirmó el mismo intervalo y etapa del turno en
   la cuenta, calendario, generación y autorización actuales. Un trabajo en cola
   o una respuesta exitosa de un worker que procesó otros turnos no alcanzan.
4. Si falta esa prueba, se conserva el turno y se muestra que necesita revisión.
   El bot deriva a la secretaria; no solicita la seña ni promete la confirmación.
   Los avisos de seña y confirmación también verifican esta condición en el
   servidor inmediatamente antes del envío a WhatsApp.

Un cambio de horario no confirmado por Google conserva ambos datos necesarios
para recuperar el trabajo. No se borra el evento remoto ni se vuelve a crear el
turno a ciegas. La vista interna puede mostrar un turno guardado pendiente de
verificación; eso no debe comunicarse al paciente como un horario confirmado.

## Límite de concurrencia

Las comprobaciones evitan reservar sobre la ocupación conocida o detectada al
escribir. Google ofrece modificaciones condicionales con `If-Match` sobre un
evento individual; eso protege las ediciones humanas del mismo evento. No ofrece
una transacción de inserción condicionada a que ningún otro evento ocupe el
intervalo. Por lo tanto, otra persona todavía puede crear un evento exactamente
entre la última lectura y la escritura, o superponerlo después. Esa situación
necesita sincronización y revisión operativa; no corresponde prometer una
garantía absoluta de exclusión entre dos sistemas independientes.

Las reglas de filtros de tiempo, paginación y expansión de recurrencias siguen
la documentación de [Events: list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).
El alcance de `If-Match` se explica en
[versiones de recursos](https://developers.google.com/workspace/calendar/api/guides/version-resources).

## Publicación

Aplicar la migración después de las anteriores y publicar juntos
`process-calendar-sync`, `whatsapp-automation`, `whatsapp-send` y las Functions
que empaquetan `_shared/whatsapp.ts`, incluido `process-reminders`. Publicar el
frontend con el RPC disponible. La migración no activa cron, no conecta una
cuenta y no envía mensajes; mientras Google no esté operativo las nuevas
reservas se bloquean. Verificar la conexión real, permisos, cron y versiones
publicadas antes de dar por terminado el despliegue.

Pruebas locales específicas: `google_calendar_booking_projection_required.sql`,
`google_calendar_booking_freshness.sql`, `google-calendar-slot.test.ts`,
`calendar-booking-availability.test.ts`, `whatsapp-calendar-projection.test.ts`
y `process-calendar-sync/orchestration.test.ts`.
