# Sincronización bidireccional: orden de despliegue

Este documento describe el orden previsto. **Nada de esto se ejecutó todavía.**
El estado remoto (migraciones aplicadas, versiones de Functions y cron) no fue
consultado en esta tarea: figura como **NO VERIFICADO**.

La versión nueva deja de crear o elegir calendarios automáticamente. OAuth
prepara un candidato efímero y una ADMIN debe seleccionar un calendario
preexistente que la cuenta posea. La conexión activa no cambia hasta esa
confirmación.

## Precondiciones

Antes de abrir la ventana de despliegue:

1. Verificar el project ref de Supabase y el Worker de frontend de destino.
2. Revisar por lectura qué migraciones faltan, el estado de la conexión, los
   contadores de jobs y si existe un lease entrante vigente. No copiar tokens,
   secretos ni datos de pacientes al registro de la intervención.
3. Identificar el job remoto que invoca `process-calendar-sync`, su frecuencia y
   el mecanismo exacto para pausarlo y reanudarlo. El repositorio no lo crea.
4. Confirmar que el calendario definitivo ya existe, pertenece a la cuenta que
   se conectará y usa exactamente la zona horaria configurada en la aplicación.
5. Confirmar en Google Cloud la redirect URI exacta y los permisos nuevos:

   ```text
   openid
   email
   https://www.googleapis.com/auth/calendar.calendarlist.readonly
   https://www.googleapis.com/auth/calendar.events.owned
   ```

6. Completar build, tipos y tests locales desde la misma revisión que se va a
   desplegar. No usar datos reales para el smoke test.

## Orden obligatorio

1. **Pausar sólo el cron de Calendar.** Esperar hasta que no haya jobs en
   `processing` ni un lease entrante vigente. No iniciar OAuth, no desconectar y
   no usar **Sincronizar ahora** durante la ventana.
2. **Aplicar migraciones** (`supabase db push`) en orden de timestamp:
   - `20260902220000_google_calendar_bidirectional_sync.sql`
   - `20260902230000_manual_deposit_proof_review.sql`
   - `20260903120000_google_calendar_conflict_safety.sql`
   - `20260903130000_deposit_review_hardening.sql`
   - `20260904120000_google_calendar_explicit_selection.sql`
3. **Desplegar todas las Edge Functions de Calendar desde la misma revisión:**
   - `google-calendar-selection`
   - `google-calendar-status`
   - `process-calendar-sync`
   - `google-calendar-disconnect`
   - `google-calendar-oauth-start`
   - `google-calendar-oauth-callback`
4. **Desplegar el frontend** (Worker `gisela-lentz-web`) recién cuando la nueva
   Function de selección y el nuevo status ya estén disponibles.
5. **Verificar por lectura** que status responde, que `selectionPending` tiene un
   valor coherente y que la conexión activa anterior no cambió por el despliegue.
6. Completar la prueba controlada y recién entonces **reanudar el cron**. Debe
   quedar un solo scheduler activo para Calendar.

`_shared/google-calendar.ts` se empaqueta dentro de cada Function que lo importa.
Por eso no alcanza con desplegar sólo el callback: OAuth, selección, desconexión
y worker deben pertenecer a la misma revisión.

## Compatibilidad temporal con el runtime anterior

Las migraciones bidireccionales conservan compatibilidad con un worker anterior:

- `complete_google_calendar_sync_job` mantiene la firma de **4 argumentos** como
  wrapper de la firma nueva de 7. El worker anterior puede cerrar jobs, aunque no
  registra ETag ni horario proyectado.
- `observe_google_calendar_managed_event` conserva la firma de **8 argumentos**
  sin ETag y delega en la de 9.
- `claim_google_calendar_sync_jobs` agrega `google_etag`; un worker anterior
  ignora esa columna.
- `google_calendar_status()` agrega columnas; la Function anterior consume sólo
  las que conoce.
- `appointment_slot_is_available` incorpora bloqueos importados. Mientras la
  tabla de eventos externos esté vacía, el comportamiento previo se conserva.

La última migración tiene una excepción deliberada: reemplaza
`complete_google_calendar_connection(...)` por un error
`GOOGLE_CALENDAR_SELECTION_REQUIRED`. Así un callback viejo no puede saltear la
selección owner. También convierte una conexión legada `connected` en
`reconnect_required`, rota la generación, invalida token incremental, lease,
aprobación y bitácora inbound, y cancela la cola y los mappings salientes de la
generación anterior. Los bloqueos y conflictos previos quedan `superseded`
porque el esquema legado no puede demostrar de forma suficiente su cuenta de
origen. Por lo tanto, entre migración y Functions nuevas:

- el worker no debe leer ni escribir Google hasta completar una nueva
  autorización y selección explícita;
- no debe iniciarse ni completarse OAuth con Functions de la versión anterior;
- la sincronización automática debe seguir pausada para no mezclar versiones;
- el tramo debe ser corto y terminar publicando backend y frontend juntos.

Después de reautorizar y seleccionar, la conexión nueva queda en
`awaiting_first_import`: requiere preview y aprobación nuevos y no habilita una
importación automática.

Además, una autorización legada con `calendar.app.created` no obtiene los scopes
nuevos al desplegar código. Cada cuenta debe completar nuevamente el
consentimiento antes de usar la selección explícita.

## Selección explícita y atómica

1. `google-calendar-oauth-start` permite iniciar OAuth sólo a una ADMIN y crea
   state + PKCE con vencimiento.
2. El callback canjea el código y guarda un candidato durante 15 minutos. El
   refresh token queda en Vault; todavía no reemplaza el token activo.
3. `google-calendar-status` informa `selectionPending=true`. El frontend llama a
   `GET google-calendar-selection` sólo para una ADMIN.
4. El GET pagina la lista de Google, filtra nuevamente `accessRole=owner` y
   devuelve nombre, indicador de calendario principal y zona horaria. No expone
   el email de la cuenta ni muestra el ID como dato operativo.
5. `POST google-calendar-selection` recibe internamente el `calendarId`, vuelve a
   consultar Google, confirma ownership y exige que la zona coincida exactamente
   con `app_settings.timezone`.
6. Sólo entonces la base reemplaza la conexión en una transacción, rota su
   generación, elimina el candidato y encola los turnos confirmados futuros.

Si cuenta o calendario cambian, los jobs antiguos se cancelan, sus mappings no
se transportan y los bloqueos/conflictos del alcance anterior quedan
`superseded`. Si se reautoriza exactamente la misma cuenta y el mismo calendario,
la historia activa puede adoptar la generación nueva, pero la primera importación
se vuelve a aprobar. En ambos casos los eventos existentes en Google se
preservan.

Si el candidato vence antes de confirmar, la conexión activa anterior no cambia.
El operador debe volver a iniciar OAuth; no debe reutilizar un ID guardado ni
intentar completar el candidato por SQL.

## Primera importación

Requiere dos acciones ADMIN separadas:

1. **Ver qué hay en Google**: preview de sólo lectura. No toma el lease, no
   encola trabajos y no escribe eventos ni bloqueos.
2. **Habilitar importación**: registra la aprobación para la cuenta, calendario y
   generación activos. La siguiente sincronización importa los eventos manuales
   compatibles como bloqueos.

No aprobar si el preview informa truncamiento o eventos no soportados. Antes de
permitir el primer push, comprobar también que ningún turno confirmado ya
existente en la aplicación se solape con un bloqueo manual del calendario: el
worker debe retener ese upsert para evitar un duplicado y la equivalencia se
resuelve de forma humana.

Los eventos de todo el día y las series recurrentes no se convierten en bloqueos
automáticamente y cierran la disponibilidad hasta su revisión. Un cambio o
borrado en Google de un turno administrado se registra como conflicto y requiere
aplicar o rechazar desde la aplicación.

Los bloqueos convertidos siguen ocupando el horario mientras el borrado del
evento manual esté pendiente o haya fallado. Esto cubre también un turno que
queda esperando seña y luego vence: sólo una limpieza confirmada libera ese
horario.

## Cron

No hay un job de Calendar versionado en este repositorio. El scheduler remoto
debe invocar `process-calendar-sync` cada minuto con `POST` y el header secreto
documentado en [google-calendar-setup.md](google-calendar-setup.md). Antes de
cerrar el despliegue hay que comprobar por lectura:

- que existe exactamente un job habilitado;
- que apunta al project ref correcto;
- que una ejecución actualiza `last_checked_at` aun sin cambios;
- que no quedan leases o jobs `processing` estancados.

## Cutover seguro: cuenta de prueba → cuenta real

La selección de un calendario nuevo encola inmediatamente todos los turnos
confirmados y futuros. Por eso el cron debe permanecer pausado hasta verificar el
destino.

1. Confirmar previamente que el calendario real existe, es owner y tiene la zona
   horaria correcta.
2. Con cron pausado y sin procesamiento en curso, guardar contadores de sólo
   lectura de la conexión de prueba.
3. Desconectar la cuenta de prueba desde Configuración. Esto borra credenciales y
   alcance locales, rota la generación y cancela jobs anteriores; no elimina
   eventos del calendario de prueba.
4. Iniciar OAuth con la cuenta real. En **Falta confirmar**, verificar nombre,
   principal y zona horaria sin copiar identificadores ni emails.
5. Confirmar sólo el calendario definitivo. Verificar por lectura que:
   - `connected=true` y `selectionPending=false`;
   - el nombre y la zona son los esperados;
   - la generación cambió;
   - sólo hay jobs de la generación nueva;
   - los bloqueos y conflictos de la prueba no forman parte del alcance activo.
6. Ejecutar el preview. No aprobar si los contadores no corresponden al
   calendario esperado.
7. Habilitar la primera importación y hacer una sincronización manual controlada
   con un turno y un evento `[PRUEBA CALENDAR]`. Repetirla para comprobar que no
   aparecen duplicados.
8. Reanudar el cron y confirmar una corrida correcta antes de cerrar la ventana.
9. Si la revocación remota de la cuenta de prueba no se confirmó, quitar ese
   acceso desde esa cuenta sólo después de validar la conexión real.

No borrar el calendario de prueba como parte del cutover. Conservarlo hasta
terminar la reconciliación y eliminar luego sólo los artefactos ficticios mediante
un procedimiento humano controlado.

## Abortar o corregir una selección

- **Antes de confirmar:** usar **Elegir otra cuenta**. Esto descarta el
  candidato local e invalida cualquier callback tardío de ese intento; una
  conexión activa anterior permanece intacta. Luego se puede iniciar OAuth de
  nuevo sin esperar el vencimiento.
- **Calendario incorrecto confirmado, cron aún pausado:** no ejecutar sync;
  desconectar y repetir el flujo con el destino correcto.
- **Ya hubo escrituras:** mantener el cron pausado, medir los eventos afectados y
  reconciliarlos antes de otro cambio. Cambiar de cuenta no borra eventos remotos
  del alcance anterior.
- **Falla entre migración y Functions:** no habilitar OAuth ni cron. Completar el
  despliegue desde la misma revisión; no revertir migraciones aplicadas con SQL
  improvisado.
