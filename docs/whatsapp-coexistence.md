# WhatsApp Business App Coexistence

Esta integración permite que el número siga activo en WhatsApp Business App y
que la misma conversación se refleje en Cloud API. El código prepara recepción,
persistencia y recuperación; no ejecuta Embedded Signup, no solicita la
sincronización a Meta y no conecta un número por sí solo.

Los formatos implementados siguen las referencias oficiales actuales de Meta:
[`messages`](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages),
[`history`](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/history),
[`smb_app_state_sync`](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_app_state_sync)
y
[`smb_message_echoes`](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes).
La identidad de usuario también sigue el formato actual de
[Business-Scoped User IDs de Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids)
([espejo de la referencia](https://whatsapp-docs.kap.so/documentation/whatsapp/business-scoped-user-ids)):
el BSUID es un identificador opaco y no se interpreta como un número de
teléfono.

## Flujo

```text
Meta (firma HMAC)
  │
  ▼
whatsapp-webhook
  ├─ valida object + WABA + phone_number_id
  ├─ pre-pausa ecos de la app antes de cualquier inbound vivo del POST
  ├─ messages normales ─────► flujo inbound + outbox de automatización
  ├─ statuses ──────────────► registro durable + reconciliación
  ├─ eventos operativos ────► controles de salud existentes
  ├─ campo desconocido ─────► webhook_events: ignored
  └─ Coexistence ───────────► whatsapp_coexistence_events
                                  │ claim + lease + cursor
                                  ▼
                         process-whatsapp-coexistence
                                  │ RPCs service-role
                                  ▼
                  contacts / conversations / messages
```

El webhook persiste el cambio completo antes de responder. Los payloads de
historial pueden contener miles de mensajes, por lo que se consumen por páginas
internas y se guarda un cursor. La cola usa leases, backoff, límite de intentos y
requeue explícito. Cada claim toma eventos de una sola cuenta para evitar locks
cruzados; después de cualquier claim no vacío el worker agenda otra pasada, de
modo que otra cuenta con backlog no dependa del cron de recuperación. Un evento
fallido queda visible y no se revive infinitamente por cada duplicado de Meta.

## Comportamiento por evento

| Campo                | Persistencia                                                                                              | Efectos deliberadamente omitidos                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `messages`           | Mensajes inbound vivos y estados; `edit`/`revoke` se reconcilian por wamid                                | Ninguna regresión del flujo vivo existente                                                                   |
| `history`            | Contacto, conversación, mensaje, dirección, wamid, timestamp, estado, contenido, tipo Meta, lote y origen | Sin unread, bot, respuestas, consentimiento, urgencia, seña, handoff ni ventana de atención                  |
| `smb_app_state_sync` | Alta/actualización por BSUID y/o teléfono; baja marcada en el mapping de Coexistence                      | No elimina el contacto administrativo ni su historial                                                        |
| `smb_message_echoes` | Mensaje outbound ya enviado y barrera causal contra una respuesta automática duplicada                    | No llama a Graph, no pausa el bot, no pasa por política de nuevo envío ni abre/extiende la ventana Cloud API |

## Identidad dual: BSUID y teléfono

`contacts.whatsapp_user_id` guarda el BSUID opaco de hasta 256 caracteres.
`phone_e164` ahora es nullable: una fila real debe tener al menos BSUID o
teléfono, pero nunca se inventa uno a partir del otro. Los índices únicos
parciales y los locks por cada identidad impiden que un mismo BSUID, `wa_id` o
teléfono se una silenciosamente a contactos diferentes.

El adaptador reconoce las variantes actuales de Meta: `contacts[].user_id`,
`messages[].from_user_id`/`to_user_id`, `threads[].context.user_id`,
`state_sync[].contact.user_id` y `message_echoes[].to_user_id`. Conserva además
`username` y `country_code` como metadata cuando llegan. Los campos telefónicos
legacy siguen admitidos, pero pueden venir vacíos. Al enviar, el backend
resuelve la identidad dentro de la cuenta Coexistence: usa primero el mapping
activo y, si la sincronización de contactos no estuvo disponible, permite una
identidad protegida sólo cuando existe un inbound vivo y firmado de esa misma
cuenta durante las últimas 24 horas. Los identificadores numéricos van en `to`;
un BSUID va en `recipient`, nunca simulando ser un teléfono. El destino efectivo
queda ligado a la idempotencia mediante un HMAC sin persistir el identificador
crudo.

Los ecos no copian `to` a `contacts.whatsapp_id`: teléfono, `wa_id` y BSUID no
son equivalentes. Las actualizaciones de contactos usan el timestamp de origen
para que un evento atrasado no revierta uno más nuevo.

`history` acepta bloques fuera de orden. `progress=100` es la única señal usada
para marcar el historial global como completo. `smb_app_state_sync` no ofrece
una señal global de finalización, por lo que consumir una entrega deja el estado
global como parcial, no como una certeza inventada.

Un medio histórico puede llegar primero como `media_placeholder` y después como
follow-up separado: el medio inbound llega en `value.messages[]` y el outbound
en `value.message_echoes[]`. La segunda entrega sólo enriquece por wamid; nunca
cambia el contacto ni la dirección ya importados. Si llega antes que el
placeholder queda pendiente y se reconcilia cuando aparece el original.

Si el historial y un `messages` vivo compiten por el mismo wamid, el RPC
`promote_whatsapp_history_message_to_live(...)` promueve atómicamente la fila
inbound ya importada. En esa misma transacción cambia el origen a `cloud_api`,
aplica una sola vez unread/actividad y reserva el dispatch de automatización.
Un retry posterior detecta la promoción ya confirmada y no repite esos efectos.

Antes de procesar cualquier `messages` vivo de un POST firmado, el webhook hace
una pre-pasada por todos los `smb_message_echoes` confiables y llama la barrera
causal de respuesta humana. Una respuesta desde la app o desde la web invalida
la automatización perteneciente a los inbound ya observados, pero conserva la
preferencia `automation_mode=auto`; sólo el botón explícito o un handoff de
seguridad cambian ese modo. El ledger de efectos toma el mismo lock antes del
commit: si la respuesta humana ganó la carrera, la transacción revierte también
cualquier cambio previo de turno, perfil, decisión o sesión. Todos los orígenes
automáticos vuelven a validar la barrera inmediatamente antes de Graph.

## Persistencia

- `whatsapp_coexistence_accounts`: WABA, Phone Number ID, teléfono visible,
  estado de conexión, estados/progreso/fechas de cada sync, request IDs de inicio
  y último error.
- `whatsapp_coexistence_events`: inbox durable de cambios firmados, payload,
  hash, intentos, lease, cursor, disponibilidad, error y timestamps.
- `whatsapp_coexistence_sync_batches`: fase, orden de chunk, progreso y conteos.
- `whatsapp_coexistence_sync_generation_failures`: fallo o cancelación de una
  solicitud que terminó antes de producir un `request_id`, evento o lote.
- `whatsapp_coexistence_contacts`: BSUID/teléfono, estado activo/removido y
  timestamp del último cambio conocido desde la app.
- `whatsapp_coexistence_message_enrichments`: medios históricos que llegaron
  antes de su mensaje original. Las ediciones y revocaciones se guardan como
  filas de `messages` y se reconcilian mediante triggers.
- `whatsapp_message_status_events`: estados de entrega durables; permite que un
  estado que llegue antes del mensaje se aplique más tarde.
- `whatsapp_automation_dispatches`: outbox con lease y reintentos para que un
  fallo posterior a persistir un mensaje vivo no pierda su automatización. El
  INSERT inbound crea primero una reserva; elegibilidad y cierre del webhook se
  confirman juntos, por lo que un mensaje posterior no puede adelantarse en la
  misma conversación.
- `whatsapp_automation_executions`: ejecución única por mensaje inbound, con
  snapshot estable, lease, resultado y error durable para que un retry no tome
  decisiones con estado distinto al intento original.
- `whatsapp_automation_effects`: ledger de efectos de dominio (sesión, alta,
  reprogramación o cancelación de turno) para no repetirlos después de una
  caída parcial; su trigger de commit aplica la barrera causal de modo manual.
- `conversations.automation_pause_source` y
  `automation_pause_message_id`: dueño durable de la pausa, sin permisos de
  escritura directa para el navegador.
- `messages`: columnas de origen, tipo Meta, cuenta/evento/lote, wamid original,
  edición, revocación y una secuencia monotónica usada por la paginación del
  inbox.

Las tablas internas tienen RLS sin políticas para navegador. La escritura de
mensajes Coexistence sólo es válida dentro de RPCs `service_role` con un contexto
transaccional; una inserción directa no puede falsificar el origen para evadir
las políticas outbound.

Dentro de una conversación, el outbox sólo reclama el menor
`whatsapp_ingest_sequence` todavía accionable. La ejecución y sus efectos usan
lease, locks y secuencias deterministas asignadas antes de cada operación
asíncrona; una ejecución posterior no puede tomar un snapshot o escribir sesión
por delante de una anterior.

## Variables y despliegue futuro

Además de las variables normales de WhatsApp, el backend requiere:

```env
WHATSAPP_COEXISTENCE_INTERNAL_SECRET=
WHATSAPP_COEXISTENCE_RECOVERY_SECRET=
WHATSAPP_COEXISTENCE_CLAIM_LIMIT=5
WHATSAPP_COEXISTENCE_ITEMS_PER_RUN=100
WHATSAPP_WEBHOOK_MAX_BYTES=3145728
AUTOMATION_INTERNAL_SECRET=
WHATSAPP_AUTOMATION_OUTBOX_RECOVERY_SECRET=
WHATSAPP_AUTOMATION_OUTBOX_CLAIM_LIMIT=10
```

`WHATSAPP_COEXISTENCE_INTERNAL_SECRET` debe ser nuevo, aleatorio y distinto de
los secretos de automatización y cron. No debe existir en Vercel ni usar
prefijo `PUBLIC_`.
El límite del webhook se aplica incrementalmente mientras llega el body; evita
bufferizar una solicitud no autenticada de tamaño arbitrario. El valor por
defecto acompaña el máximo actual documentado por Meta.

`AUTOMATION_INTERNAL_SECRET` sigue protegiendo `whatsapp-automation` y las
continuaciones internas existentes. Recovery usa dos credenciales nuevas,
independientes entre sí y de las internas:
`WHATSAPP_COEXISTENCE_RECOVERY_SECRET` y
`WHATSAPP_AUTOMATION_OUTBOX_RECOVERY_SECRET`. Cada una debe tener su copia del
mismo valor en Vault; consultar el procedimiento completo en
[`whatsapp-recovery.md`](./whatsapp-recovery.md). El cron las envía únicamente
como `x-recovery-secret`.

Cuando se autorice el despliegue, el orden seguro es:

1. Aplicar y revisar, exactamente en este orden,
   `20260826120000_whatsapp_coexistence.sql`,
   `20260826130000_whatsapp_automation_idempotency.sql` y
   `20260826140000_whatsapp_bsuid_and_live_promotion.sql`, seguida por
   `20260826150000_whatsapp_automation_causal_pause.sql`. Aplicar después
   `20260826160000_whatsapp_recovery_schedule.sql`, que instala infraestructura
   inerte pero no crea jobs ni tráfico; finalmente ejecutar el lint de base de
   datos y las pruebas SQL.
2. Configurar los secretos internos y los dos pares dedicados de recovery en
   Edge Secrets/Vault, sin imprimir sus valores.
3. Desplegar `whatsapp-automation`, `process-whatsapp-automation-outbox`,
   `process-whatsapp-coexistence` y, al final, `whatsapp-webhook`. El orden evita
   que el webhook nuevo libere trabajo a una versión vieja de sus consumidores.
4. Activar explícitamente los dos jobs postgres-only según
   [`whatsapp-recovery.md`](./whatsapp-recovery.md). Cada uno invoca su processor
   una vez por minuto con `x-recovery-secret`; el disparo inmediato del webhook
   reduce latencia y el cron recupera una invocación perdida.
5. Confirmar que el callback continúa siendo
   `/functions/v1/whatsapp-webhook` y suscribir los cuatro campos.
6. Probar los cuatro fixtures con credenciales/números de prueba y mantener las
   automatizaciones apagadas.

La presencia de código o migraciones no demuestra que recovery esté activo. El
estado autoritativo se consulta con
`private.whatsapp_recovery_schedule_status()`.

## Después de Embedded Signup

Seguir el procedimiento vigente de Meta para
[onboarding de usuarios de WhatsApp Business App](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users).
Antes de usar el número real:

1. Guardar la pareja WABA/Phone Number ID devuelta por onboarding y verificarla
   contra el número esperado.
2. Actualizar sólo los secretos backend autorizados y ejecutar health check.
3. Antes de cada solicitud, abrir una generación independiente mediante
   `start_whatsapp_coexistence_sync_generation(account_id, sync_type)`. No
   iniciar dos generaciones superpuestas del mismo stream: Meta no incluye el
   `request_id` en cada webhook y no sería posible correlacionarlas con certeza.
4. Dentro de la ventana indicada por Meta, solicitar por separado
   `smb_app_state_sync` y `history` mediante `/{PHONE_NUMBER_ID}/smb_app_data`.
5. Inmediatamente después de la respuesta de Graph, guardar su `request_id` y
   la hora contra la generación abierta mediante
   `record_whatsapp_coexistence_sync_request(...)`. La generación impide que
   una respuesta tardía sobrescriba una solicitud nueva.
6. Si la llamada a Graph falla antes de devolver `request_id`, cerrar la
   generación exacta con el RPC service-role
   `fail_whatsapp_coexistence_sync_generation(account_id, sync_type, generation_id, error, ...)`.
   No iniciar otra generación hasta confirmar el estado `failed`; el RPC
   rechaza IDs de generación viejos y no reemplaza el flujo de error de una
   generación que ya produjo eventos o lotes.
7. Vigilar cola, lotes, progreso, errores y cantidad importada. La ausencia de
   webhooks de history no demuestra por sí sola un fallo.
8. Verificar muestras de mensajes inbound/outbound, ecos manuales, contactos,
   duplicados y ventanas antes de habilitar automatizaciones.

## Recuperación y rollback

- Para un evento corregible en estado `failed`, usar exclusivamente el RPC
  service-role `requeue_whatsapp_coexistence_event(id)` y conservar antes el
  error/payload para diagnóstico.
- Para una automatización agotada, corregir primero la causa y usar
  `requeue_whatsapp_automation_dispatch(id)`; el RPC reabre de forma coordinada
  el dispatch y únicamente una ejecución terminalizada por agotamiento, sin
  alterar ejecuciones exitosas. No insertar una segunda fila ni volver a
  simular el webhook.
- Si el processor queda inactivo, no se pierden eventos: permanecen `pending` o
  recuperan un lease vencido. Restaurar exclusivamente los jobs mediante el
  procedimiento postgres-only de
  [`whatsapp-recovery.md`](./whatsapp-recovery.md); no copiar credenciales en una
  invocación manual.
- Ante comportamiento inesperado, apagar automatizaciones, pausar la cuenta de
  Coexistence y retirar las tres suscripciones nuevas desde Meta. Mantener
  `messages` si el flujo Cloud API normal sigue siendo válido.
- Revertir juntas las versiones de las cuatro Edge Functions involucradas
  (`whatsapp-automation`, `process-whatsapp-automation-outbox`,
  `process-whatsapp-coexistence` y `whatsapp-webhook`) sin borrar las tablas ni
  los mensajes importados. Las migraciones son aditivas; eliminar datos
  sincronizados no forma parte de un rollback seguro y requiere una decisión
  separada.
