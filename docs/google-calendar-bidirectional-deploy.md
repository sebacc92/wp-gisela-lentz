# Sincronización bidireccional: orden de despliegue

Este documento describe el orden y las barreras de cada despliegue. El estado
remoto nunca se infiere de este archivo: antes de cada intervención hay que
comprobar por lectura migraciones, versiones de Functions, conexión, cola y
cron del proyecto exacto.

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
3. Comprobar que no exista un job de Calendar antes de la activación e
   identificar los crons ajenos (por ejemplo, WhatsApp) que deben permanecer
   intactos.
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

1. **Si existe un cron de Calendar, pausar sólo ese job.** Esperar hasta que no
   haya jobs en `processing` ni un lease entrante vigente. No iniciar OAuth, no
   desconectar y no usar **Sincronizar ahora** durante la ventana.
2. **Aplicar migraciones** (`supabase db push`) en orden de timestamp:
   - `20260902220000_google_calendar_bidirectional_sync.sql`
   - `20260902230000_manual_deposit_proof_review.sql`
   - `20260903120000_google_calendar_conflict_safety.sql`
   - `20260903130000_deposit_review_hardening.sql`
   - `20260904120000_google_calendar_explicit_selection.sql`
   - `20260905170000_google_calendar_conflict_admin_reschedule.sql`
   - `20260905183000_google_calendar_disconnect_safe_update.sql`
   - `20260905200000_google_calendar_windowed_recurrence.sql`
   - `20260905210000_google_calendar_pre_reservation_projection.sql`
   - `20260905220000_google_calendar_automatic_schedule.sql`
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
6. Confirmar que la publicación quedó inerte. No instalar el scheduler ni crear
   una pre-reserva real hasta completar el preflight y recibir autorización
   explícita; la prueba del ciclo ocurre después de ese corte.

`_shared/google-calendar.ts` se empaqueta dentro de cada Function que lo importa.
Por eso no alcanza con desplegar sólo el callback: OAuth, selección, desconexión
y worker deben pertenecer a la misma revisión.

## Compatibilidad temporal con el runtime anterior

El contrato de pre-reservas conserva las firmas anteriores de la cola como
wrappers deliberadamente cerrados. Durante una ventana DB → Function, y también
si se revierte sólo el código, el worker anterior no puede reclamar ni completar
jobs del nuevo epoch y tampoco puede reclamar limpieza de eventos externos. El
worker actual usa un claim versionado, asociación exacta y fingerprint del
payload. `google_calendar_status()` agrega columnas de forma compatible con la
Function anterior.

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
   generación y elimina el candidato. Esto todavía no autoriza salida: los
   turnos y jobs anteriores al corte de activación permanecen excluidos.

Si cuenta o calendario cambian antes de activar, los jobs legacy quedan
excluidos y los bloqueos/conflictos del alcance anterior dejan de formar parte
de la nueva generación. Con un epoch activo, cualquier job no drenado o mapping
`pre_reservation`/`confirmed` bloquea el retarget con
`GOOGLE_CALENDAR_AUTOMATION_DRAIN_REQUIRED`; no se transporta ni abandona. Si
se reautoriza exactamente la misma cuenta y el mismo calendario, la historia
activa conserva el epoch y se re-bindea a la generación nueva, pero la primera
importación se vuelve a aprobar. En todos los casos los eventos existentes en
Google se preservan.

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

Los eventos de todo el día y las ocurrencias recurrentes compatibles se
conservan como bloqueos dentro de la cobertura móvil. Los eventos externos,
incluidos los bloqueos convertidos, son siempre de sólo lectura: no se limpian,
reemplazan ni eliminan desde la aplicación. Un cambio o borrado en Google de un
evento administrado por la aplicación se registra como conflicto y requiere
revisión.

## Cron

La infraestructura versionada queda inerte al migrar. La instalación explícita
crea un solo job cada minuto y liga cron, cuenta, calendario, generación y epoch
en la misma transacción; el secreto dedicado permanece en Vault. Antes de
activarla hay que comprobar por lectura:

- que todavía no existe ningún job de Calendar durante el despliegue inerte;
- que, al autorizar la activación, se crea exactamente un job habilitado;
- que apunta al project ref correcto;
- que una ejecución actualiza `last_checked_at` aun sin cambios;
- que no quedan leases o jobs `processing` estancados.

Antes de instalar, configurar el mismo valor aleatorio (mínimo 32 caracteres)
como secreto de Edge `GOOGLE_CALENDAR_CRON_SECRET` y como secreto de Vault
`google_calendar_automation_cron_secret`. Vault debe contener además
`google_calendar_automation_project_url` con la URL exacta del proyecto. Ningún
valor debe pasar por Git, logs ni tablas públicas. Data API debe rechazar el
schema `net` con `PGRST106 Invalid schema`.

Después de verificar la generación y recibir autorización explícita:

```sql
select private.install_google_calendar_automatic_schedule(
  <GENERACION_VERIFICADA>
);
select private.google_calendar_automatic_schedule_status();
```

El status esperado es enabled y configurationConsistent, con un solo job
configurado y activo. Para una pausa de recuperación, desactivar únicamente ese
`cron_job_id` con `cron.alter_job(..., active := false)`; esto también bloquea
los disparos inmediatos sin perder mappings.
`private.uninstall_google_calendar_automatic_schedule()` sólo se usa con el
epoch drenado a absent y falla cerrada en cualquier otro estado. El
procedimiento detallado está en
[google-calendar-setup.md](google-calendar-setup.md).

## Cutover seguro: cuenta de prueba → cuenta real

La selección de un calendario nuevo no adopta turnos ni jobs anteriores. Sin
embargo, un epoch que todavía representa eventos vivos tampoco se puede
abandonar: pausar el scheduler no alcanza para habilitar un retarget.

1. Confirmar previamente que el calendario real existe, es owner y tiene la
   zona horaria correcta.
2. Si existe cron de Calendar, pausar únicamente su `cron_job_id`. Esperar a
   que no haya jobs `processing` ni lease entrante vigente.
3. Guardar contadores de sólo lectura del epoch, jobs y mappings. No copiar
   tokens, eventos, emails ni datos de pacientes.
4. Si queda cualquier mapping `pre_reservation` o `confirmed`, detener el
   cutover. Seguir operando el alcance actual o acordar cómo drenarlo; no
   desconectar, mover ni borrar eventos para forzar el cambio.
5. Sólo con todos los mappings en `absent`, desinstalar el scheduler y
   comprobar cero jobs de Calendar. Después desconectar desde Configuración; los
   eventos externos del calendario anterior permanecen intactos.
6. Iniciar OAuth con la cuenta real. En **Falta confirmar**, verificar nombre,
   principal y zona horaria sin copiar identificadores ni emails.
7. Confirmar sólo el calendario definitivo. Verificar por lectura conexión,
   generación y alcance; ningún job de la cuenta anterior puede adquirir el
   epoch nuevo.
8. Ejecutar preview, aprobar la primera importación y completar una
   sincronización manual sólo de lectura/sentido entrante. No continuar si el
   recorrido está truncado o el calendario no coincide.
9. Repetir el preflight y, con autorización explícita, activar el scheduler para
   la generación comprobada. Crear la pre-reserva ficticia recién después del
   corte y validar una sola proyección.

No borrar ni modificar el calendario de prueba como parte del cutover. Si la
revocación del grant anterior no quedó confirmada, retirarla desde esa cuenta
sólo después de comprobar la conexión definitiva.

## Abortar o corregir una selección

- **Antes de confirmar:** usar **Elegir otra cuenta**. Esto descarta el
  candidato local e invalida cualquier callback tardío de ese intento; una
  conexión activa anterior permanece intacta. Luego se puede iniciar OAuth de
  nuevo sin esperar el vencimiento.
- **Calendario incorrecto confirmado, todavía sin epoch:** no ejecutar sync;
  desconectar y repetir el flujo con el destino correcto.
- **Ya hubo escrituras:** mantener el cron pausado y el mismo alcance. Medir y
  drenar los mappings antes de otro cambio; si no pueden quedar en `absent`,
  el retarget sigue bloqueado y requiere una decisión operativa explícita.
- **Falla entre migración y Functions:** no habilitar OAuth ni cron. Completar el
  despliegue desde la misma revisión; no revertir migraciones aplicadas con SQL
  improvisado.
