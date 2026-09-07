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

## Actualización automática y pantalla de agenda

El cron autorizado sincroniza cada minuto. Un cambio manual de Google se
importa normalmente en la siguiente ejecución, más la latencia de Google y del
procesamiento. El bot actualiza Google antes de ofrecer horarios y vuelve a
comprobarlo al reservar; no depende de que alguien abra la agenda o toque el
botón de sincronización.

La pantalla recibe cambios importados mediante `calendar_availability_updates`.
Es una señal de revisión y fecha para ADMIN, sin nombres ni identificadores de
Google. Los eventos externos no se publican directamente en Realtime, para
evitar difundir sus claves en notificaciones de borrado. Al recibir la señal se
recarga por las consultas y permisos habituales; varios avisos se agrupan en
200 ms. Se conserva el refresco cada 60 segundos y al volver a la pestaña como
respaldo si el canal en vivo no está disponible. El botón manual es opcional.

Sólo se importa el calendario seleccionado y autorizado. Los eventos marcados
como «Ocupado», incluidos los de día completo y las ocurrencias recurrentes,
bloquean disponibilidad; «Libre» y los cancelados no lo hacen. La proyección de
turnos sigue teniendo las comprobaciones adicionales descritas arriba.

## Cómo aparece una pre-reserva

Google muestra **Nombre Apellido · TF · +549… · IOMA · Pendiente de seña**,
con la descripción “Reserva pendiente administrada desde la agenda de Gisela
Lentz.” El inicio y el fin
representan el horario y la duración de la atención. **No muestran el plazo
para pagar ni la fecha y hora de vencimiento de la pre-reserva.** El plazo se
calcula al crearla con `booking_hold_minutes`, configurable en la aplicación,
y queda guardado en `hold_expires_at`.

El evento contiene nombre y apellido, **TF** (tiene ficha) o **1ra vez**, celular,
la cobertura del turno (**Particular** o **IOMA**), el horario, la zona y
marcadores privados de asociación. Si falta ficha, celular o cobertura, el dato
figura como **sin confirmar**. No exporta servicio, notas clínicas, comprobantes
ni datos de transferencia. Se marca con visibilidad privada y sin asistentes ni
notificaciones de Google. El campo técnico de
Google `status=confirmed` se usa también en pre-reservas: la diferencia
operativa está en el título y la etapa registrada por el sistema.

- Al aprobar la seña, se actualiza **el mismo evento** a **Nombre Apellido · TF ·
  +549… · IOMA**, quitando el aviso pendiente. La reprogramación también conserva
  su identidad.
- Un comprobante recibido a tiempo que sigue procesándose protege la reserva
  mientras su trabajo permanece activo. Si queda en revisión
  (`proof_received`), conserva el bloqueo y sigue apareciendo como **Pendiente
  de seña**, aunque haya pasado el plazo original. El título actual no distingue
  ese caso de una transferencia todavía pendiente.
- Sin comprobante puntual protegido, el vencimiento cancela la pre-reserva
  pendiente y encola eliminar su evento administrado. El turno local se
  conserva como historial. Si nunca llegó a crearse un evento, se limpia el
  trabajo local sin enviar un borrado a Google.

Google no aplica un vencimiento automático a estos eventos. La eliminación
depende del worker y de una sincronización autorizada y exitosa. El cron de
Calendar está definido para ejecutarse cada minuto cuando está activado, además
de las actualizaciones inmediatas; eso no garantiza que el evento desaparezca
en el instante del vencimiento. Pausas, errores o cambios manuales que requieran
revisión pueden demorar la limpieza.

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
