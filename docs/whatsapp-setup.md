# Conectar WhatsApp Cloud API

Esta guía conecta manualmente un número de prueba a la instalación nueva de
Gisela. El código no crea WABA, no registra números, no cambia callbacks remotos
y no realiza onboarding de Meta.

## 1. Preflight de aislamiento

Antes de usar una CLI vinculada:

```bash
node scripts/assert-deployment-target.mjs
pnpm exec supabase projects list
```

Confirmar visualmente que el project ref vinculado es el **nuevo**. No continuar
si aparece el proyecto anterior o si existe alguna duda sobre el destino.

En Meta, comprobar que el token, App Secret, WABA y Phone Number ID pertenecen al
entorno de prueba elegido por el usuario. No reutilizar ni modificar una
configuración productiva ajena.

## 2. Variables backend

Configurar en Supabase Edge Functions:

```env
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_GRAPH_API_VERSION=
WHATSAPP_MEDIA_MAX_BYTES=10485760
META_APP_ID=
META_EMBEDDED_SIGNUP_CONFIG_ID=
META_APP_SECRET=
META_WEBHOOK_VERIFY_TOKEN=
WHATSAPP_WEBHOOK_MAX_BYTES=3145728
AUTOMATION_INTERNAL_SECRET=
WHATSAPP_AUTOMATION_OUTBOX_CLAIM_LIMIT=10
WHATSAPP_COEXISTENCE_INTERNAL_SECRET=
WHATSAPP_COEXISTENCE_CLAIM_LIMIT=5
WHATSAPP_COEXISTENCE_ITEMS_PER_RUN=100
REMINDER_CRON_SECRET=
OPENAI_API_KEY=
OPENAI_ADMINISTRATIVE_ENABLED=false
APP_ALLOWED_ORIGINS=https://URL_NUEVA_DE_VERCEL
WHATSAPP_AUTOMATIONS_ENABLED=false
WHATSAPP_EMBEDDED_SIGNUP_ENABLED=false
WHATSAPP_EMBEDDED_SIGNUP_MAX_ATTEMPTS_24H=10
WHATSAPP_TEST_MODE=true
WHATSAPP_TEST_ALLOWED_NUMBERS=NUMERO_PROPIO_E164
```

Reglas:

- no guardar valores reales en `.env.example`, README, issues o logs;
- no copiar tokens a Vercel ni a variables `PUBLIC_*`;
- usar IDs numéricos y una versión vigente de Graph con formato `vN.N`;
- generar secretos internos aleatorios; el secreto nuevo de Coexistence debe
  ser distinto del existente de automatización y de los secretos de cron;
- usar orígenes HTTPS exactos, separados por coma, sin wildcard;
- mantener test mode activo y una allowlist mínima durante toda la integración.
- guardar `OPENAI_API_KEY` únicamente en Supabase Secrets. No copiarla a
  Vercel, al navegador, SQL, logs ni archivos versionados. El asistente y la
  lectura de comprobantes usan `gpt-5.6-luna`; las notas de voz usan
  `gpt-transcribe`. Todo permanece apagado mientras
  `OPENAI_ADMINISTRATIVE_ENABLED`, `ai_enabled` o
  `WHATSAPP_AUTOMATIONS_ENABLED` sean falsos;
- la lectura de audio, imágenes y PDF requiere además
  `app_settings.ai_media_enabled=true`. En particular, la lectura automática de
  un comprobante sólo se intenta con `ai_enabled`, `ai_media_enabled`,
  `OPENAI_ADMINISTRATIVE_ENABLED` y `WHATSAPP_AUTOMATIONS_ENABLED` activos; si
  algún control está apagado, el adjunto queda para revisión manual;
- mantener `WHATSAPP_EMBEDDED_SIGNUP_ENABLED=false` hasta la autorización
  específica del onboarding. Si falta o no vale literalmente `true`, backend y
  frontend deben fallar cerrado sin cargar Facebook Login;
- mantener `WHATSAPP_EMBEDDED_SIGNUP_MAX_ATTEMPTS_24H` sólo en Supabase. El
  default es `10`, el rango efectivo es `5`–`50` y la cuota se separa por ADMIN
  y client scope sin desactivar el burst guard `3/15m`;
- no crear un token global del Tech Provider. `/debug_token` se autentica con
  un App Access Token efímero generado server-side a partir de `META_APP_ID` y
  `META_APP_SECRET`; cada operación WABA usa el business token de ese cliente;
- `WHATSAPP_MEDIA_MAX_BYTES` limita también el stream descargado para revisar
  comprobantes (10 MiB recomendado; máximo admitido por la función: 20 MiB).
  La transcripción automática con IA aplica un límite más estricto de 4 MiB;
  un adjunto mayor queda para revisión manual.
- `WHATSAPP_WEBHOOK_MAX_BYTES` limita el body mientras se lee el stream, antes
  de reservar el payload completo. El default de 3 MiB refleja el máximo actual
  documentado por Meta; el código sólo acepta configuraciones entre 64 KiB y
  16 MiB para permitir una futura actualización controlada.

La función `whatsapp-media` recibe `GET ?messageId=UUID` con el bearer de un
usuario activo. Sólo proxifica imágenes JPEG/PNG y PDF entrantes: vuelve a pedir
a Meta una URL efímera, valida host, MIME y tamaño, y entrega los bytes sin
exponer el token ni la URL de Meta. La respuesta usa `Cache-Control: no-store`.

La carga recomendada es el Dashboard de Supabase. Como alternativa, usar un
archivo temporal ignorado:

```bash
chmod 600 .env.supabase-secrets
pnpm exec supabase secrets set --env-file .env.supabase-secrets --project-ref NUEVO_PROJECT_REF
```

Borrar ese archivo después de comprobar la carga. No pasar secretos inline porque
pueden quedar en historial o argumentos del proceso.

## 3. Desplegar funciones

Sólo después del preflight, aplicar y validar las migraciones en este orden:

1. `20260826120000_whatsapp_coexistence.sql`
2. `20260826130000_whatsapp_automation_idempotency.sql`
3. `20260826140000_whatsapp_bsuid_and_live_promotion.sql`
4. `20260826150000_whatsapp_automation_causal_pause.sql`
5. `20260826160000_whatsapp_recovery_schedule.sql`
6. `20260826170000_whatsapp_embedded_signup.sql` (sólo tras revisión y
   autorización específica)

Después desplegar las funciones consumidoras en este orden. Es importante que
`whatsapp-automation` quede actualizado antes del outbox y que el webhook sea
el último:

```bash
pnpm exec supabase functions deploy whatsapp-send
pnpm exec supabase functions deploy whatsapp-media
pnpm exec supabase functions deploy whatsapp-automation
pnpm exec supabase functions deploy process-whatsapp-automation-outbox
pnpm exec supabase functions deploy whatsapp-embedded-signup
pnpm exec supabase functions deploy process-whatsapp-coexistence
pnpm exec supabase functions deploy whatsapp-webhook
pnpm exec supabase functions deploy process-reminders
pnpm exec supabase functions deploy whatsapp-health
```

El callback será:

```text
https://NUEVO_PROJECT_REF.supabase.co/functions/v1/whatsapp-webhook
```

## 4. Configurar el webhook en Meta

1. Pegar la URL nueva como Callback URL.
2. Pegar exactamente el valor de `META_WEBHOOK_VERIFY_TOKEN` como Verify token.
3. Suscribir `messages`. Para un número habilitado mediante Coexistence,
   suscribir además `history`, `smb_app_state_sync` y `smb_message_echoes`.
4. Antes de ejecutar Embedded Signup, confirmar `account_update`: la
   documentación vigente de Meta lo requiere para observar alta, desconexión y
   reconexión. La captura suministrada lo muestra como **Subscribed**; esta fase
   no realizó llamadas Graph ni cambios en Meta para volver a suscribirlo.
5. Para salud y cortes preventivos, suscribir también, cuando estén disponibles:
   `phone_number_quality_update`, `account_review_update`,
   `message_template_status_update`, `message_template_quality_update` y
   `business_capability_update`.
6. Completar **Verify and save**.

El GET de verificación sólo responde con el token correcto. Cada POST requiere
`X-Hub-Signature-256` válido. Aun con una firma válida, una entrada cuyo WABA o
Phone Number ID no coincida se ignora para aislar este tenant.

Los payloads actuales pueden identificar al usuario únicamente mediante un
Business-Scoped User ID: `contacts[].user_id`, `from_user_id`, `to_user_id` o
`threads[].context.user_id`. El backend lo guarda opacamente en
`contacts.whatsapp_user_id`; `phone_e164` puede quedar `null` y nunca se inventa
un teléfono desde el BSUID. Ver la
[referencia de BSUID de Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids)
y el detalle local en
[WhatsApp Business App Coexistence](./whatsapp-coexistence.md).

## 5. Prueba de recepción sin bot

Mantener:

```env
WHATSAPP_AUTOMATIONS_ENABLED=false
WHATSAPP_TEST_MODE=true
```

Enviar desde el teléfono permitido al número Cloud API. Verificar que se crean
un solo paciente, una sola conversación y un solo mensaje. Ejecutar además el
fixture local BSUID-only para comprobar la ingesta sin inventar un teléfono; la
allowlist del modo de prueba continúa siendo deliberadamente telefónica y
bloquea envíos a un identificador opaco. El webhook sigue guardando entradas
aunque el kill switch esté apagado.

Desde la bandeja se puede responder manualmente al número permitido. Cualquier
destino fuera de la allowlist se bloquea antes de Graph y genera auditoría
sanitizada.

## 6. Habilitar el flujo controlado

### Automatizaciones reales

Antes de cambiar el flag:

- cargar horarios reales o de prueba desde **Configuración → Horarios**;
- revisar los servicios como motivos del turno y, en **WhatsApp y reservas**,
  confirmar las duraciones por cobertura;
- confirmar buffer y anticipación mínima;
- completar mensaje fuera de horario, urgencias e información general sólo con
  datos verificados;
- comprobar que el único número autorizado es propio.

Luego establecer:

```env
WHATSAPP_AUTOMATIONS_ENABLED=true
```

Probar reserva, reprogramación, cancelación, urgencia y handoff. Volver a `false`
ante cualquier destinatario inesperado, duplicado o problema de calidad.

## 7. Plantillas y recordatorios

Crear y aprobar en Meta, con nombres iguales a `message_templates.meta_name`:

- `gisela_appointment_created_v3`
- `gisela_appointment_reminder_24h_v3`
- `gisela_appointment_reminder_2h_v3`
- `gisela_appointment_cancelled_v3`
- `gisela_appointment_rescheduled_v3`

Los recordatorios usan tres parámetros de cuerpo, en orden: paciente, fecha y
hora. El texto aprobado debe hablar como el consultorio, por ejemplo:
`Hola {{1}}, te recordamos tu turno del {{2}} a las {{3}}.` Nunca debe afirmar
ni insinuar que quien escribe es la Dra. Gisela Lentz. Agregar tres botones de
respuesta rápida en orden: confirmar, reprogramar y cancelar.

Los nombres `*_v3` evitan reutilizar por accidente una plantilla anterior con
la voz personal de Gisela. La migración las deja deshabilitadas y sin estado
heredado: hay que crear la copia institucional en Meta, esperar que figure
`APPROVED / UTILITY`, sincronizarla y recién entonces habilitarla desde el panel.
Cambiar `body_preview` en la base no modifica el texto real aprobado por Meta.
El backend envía exactamente los tres parámetros de esa versión.

Antes de aplicar la migración institucional, confirmar que los recordatorios y
su cron estén apagados, o que las cinco plantillas v3 ya estén aprobadas y
listas para sincronizar. Un recordatorio reclamado mientras una plantilla está
deshabilitada se cancela por política y no debe atravesar esa ventana de cambio.

En **Configuración → WhatsApp → Verificar conexión**, la función sincroniza
estado, categoría y calidad. El backend sólo permite mensajes proactivos con
plantilla `APPROVED`, categoría `UTILITY`, calidad aceptable, contexto de turno y
consentimiento demostrable.

Los recordatorios permanecen apagados hasta completar el checklist de
[cumplimiento](./whatsapp-compliance.md). Recién entonces crear un Supabase Cron
que haga POST a `process-reminders` con `x-cron-secret`; guardar URL y secreto en
Supabase Vault, no en SQL plano.

Programar ese cron cada cinco minutos. El backend sólo abre la cola del
recordatorio `appointment_24h` desde `app_settings.reminder_day_before_time`
(21:00 por defecto) en `app_settings.timezone`, y selecciona turnos activos del
día siguiente cuyo estado ya sea **Confirmado**. Las pre-reservas que esperan
seña o revisión de comprobante quedan excluidas. Esta frecuencia permite
recuperarse de una ejecución caída o de
un turno creado después de las 21:00 sin duplicar mensajes: la base deduplica por
turno/tipo y el envío conserva una clave de idempotencia inmutable. Mantener la
URL del endpoint y `REMINDER_CRON_SECRET` exclusivamente en Vault; no escribir
valores reales en la migración ni en esta guía.

### Resumen privado de Gisela: configuración separada

1. Configurar en Edge Functions `WHATSAPP_OWNER_NUMBERS` con **los teléfonos
   personales confirmados** que pueden ver la agenda, separados por coma y en
   formato `+549...`: el de Gisela y, mientras dure un trabajo técnico, el de
   quien la asiste. No se completa por deducción ni se usa el número comercial.
   La ausencia, una entrada que no sea E.164 exacto o más de tres teléfonos
   deshabilitan el acceso privado para todos. Cada número ve la agenda completa
   con nombres de pacientes: agregar sólo con autorización expresa de la
   profesional y quitar el número cuando termina el motivo.
2. Aplicar las migraciones `20260906040000_whatsapp_owner_daily_summary.sql` y
   `20260907130000_whatsapp_owner_summary_recipients.sql`, y desplegar
   `whatsapp-webhook`, `whatsapp-automation` y `process-reminders` con sus
   módulos compartidos. Un mensaje recibido antes de esta versión no tiene la
   nueva evidencia: cada teléfono autorizado debe enviar uno nuevo desde su
   propia línea.
3. Habilitar `WHATSAPP_OWNER_DAILY_SUMMARY_ENABLED=true`,
   `WHATSAPP_AUTOMATIONS_ENABLED=true` y el bot en la aplicación. El resumen
   respeta test mode y su allowlist: durante una prueba, cada teléfono
   autorizado debe estar además en esa allowlist para recibirlo.
4. Mantener el cron `process-reminders` cada cinco minutos con
   `REMINDER_CRON_SECRET`. El disparo de las 21:00 locales es 00:00 UTC del día
   siguiente. Los disparos 21:05 y 21:10 permiten reintentos; a las 21:15 se
   cierra. No hace falta activar plantillas ni recordatorios a pacientes.
5. Cada autorizado envía un mensaje de texto desde su teléfono, por ejemplo
   “turnos de mañana”. Ese mensaje abre **su** ventana de 24 h; escribir desde
   la app comercial o responderle desde el sistema no la renueva, y la ventana
   de un teléfono no habilita la del otro. Si a las 21 alguno no tiene ventana,
   se omite su resumen sin usar plantillas y los demás salen igual. `BAJA`
   cancela los resúmenes posteriores de quien la envía.

Las consultas privadas entienden “próximos turnos”, días de semana, fechas como
“turnos del 10/9” y “turnos de la semana que viene”, siempre en horario de
Argentina. “Próximos turnos” busca desde ahora, agrupa por fecha y avisa si el
listado no cabe completo; un período inválido o no soportado pide aclaración,
sin sustituirlo por hoy. También acepta “pasame los datos de Ana Pérez” y
“¿cuándo viene Ana Pérez?” para consultar datos administrativos y el próximo
turno, sin exportar notas clínicas. Los horarios ocupados de Google se muestran
resumidos en consultas por período, no en la lista abierta de próximos turnos.

La búsqueda de pacientes ignora acentos y mayúsculas y compara palabras completas:
“Matías Icardo” encuentra “Matias Icardo”, pero “Ana” no selecciona “Mariana”.
También reconoce “¿Cuándo se atiende Matías Icardo?”. Si el nombre tiene un error
pequeño, ofrece hasta cinco nombres parecidos y espera confirmación; sólo después
consulta teléfono, cobertura y próximo turno. Se puede responder “sí” para una
única sugerencia, el número de opción cuando hay varias, o “no” para empezar de
nuevo. La selección queda vinculada al teléfono autorizado y a su conversación,
vence a los diez minutos y no selecciona automáticamente fichas con nombres
idénticos. El directorio de nombres se pagina sin cargar notas ni fichas completas;
si supera 10.000 contactos la búsqueda falla explícitamente, no devuelve un
resultado parcial como si fuera completo.

El cron debe quedar creado en el proyecto de destino al desplegar. Si aún no
existe, crear desde Supabase Dashboard un Cron HTTP para el endpoint
`/functions/v1/process-reminders` con método POST, expresión `*/5 * * * *`,
header `x-cron-secret` y URL/valor del secreto recuperados desde Vault. No pegar
secretos reales en el código del job ni crear otro cron si ya hay uno equivalente.
La revisión y los tests locales no crean ese job remoto ni envían WhatsApp reales.

La bitácora de resultado está en `whatsapp_owner_daily_summaries` (sólo backend),
con una fila por teléfono y día: `sent`, `skipped` o `failed`, con motivos como
`CUSTOMER_SERVICE_WINDOW_CLOSED`, `OWNER_RECIPIENT_UNVERIFIED` o
`CONTACT_OPTED_OUT`. `process-reminders` devuelve `owner_summary` con el
resultado agregado —`OWNER_SUMMARY_PARTIAL` si salió para unos y no para
otros— y el detalle por destinatario en `recipients`, sin teléfonos.
No incluye el teléfono ni los nombres de pacientes en logs de error.

## 8. Health y resolución simple

En **Configuración → WhatsApp → Verificar conexión**:

- **WhatsApp no configurado:** faltan variables de Meta; agenda e inbox continúan
  operativos.
- **Problema de conexión:** revisar pertenencia Phone Number ID/WABA, token,
  calidad y logs backend sanitizados.
- **Conectado:** confirma configuración básica, pero no habilita por sí solo
  automatizaciones, test mode ni recordatorios.

La pantalla nunca devuelve access token, App Secret, verify token, claves de
Supabase ni secretos internos.

## Coexistence

La recepción, cola durable e importación están implementadas, pero esta guía no
autoriza ejecutar Embedded Signup, registrar ni migrar el número real. Antes de
esa operación seguir el checklist, cron de recuperación, monitoreo y rollback de
[WhatsApp Business App Coexistence](./whatsapp-coexistence.md).

El flujo v4 navegador/backend, intercambio de código, token por cliente en
Vault, validación de activos, sincronización dentro de 24 horas y offboarding
están especificados en
[Embedded Signup v4 para WhatsApp Coexistence](./whatsapp-embedded-signup.md).
Esa guía es preparatoria: no autoriza abrir Facebook Login ni modificar Meta.

La implementación acepta identidad dual BSUID/teléfono, follow-ups de medios de
history (`messages[]` inbound y `message_echoes[]` outbound), promoción atómica
history→live y pre-pausa sincrónica de ecos de la app. El worker drena cuentas
por pasadas encadenadas y el outbound automático vuelve a validar el modo de la
conversación antes de Graph. La pausa conserva una marca causal y una barrera
transaccional impide que una automatización ya reclamada confirme efectos de
dominio después de que un eco manual u operador haya ganado la conversación.

Después del onboarding, cada solicitud de `history` o `smb_app_state_sync` debe
usar una generación abierta por
`start_whatsapp_coexistence_sync_generation(...)`. Si Graph responde bien, se
registra el `request_id` con
`record_whatsapp_coexistence_sync_request(...)`; si falla antes de devolverlo,
se debe cerrar esa misma generación con
`fail_whatsapp_coexistence_sync_generation(account_id, sync_type, generation_id, error, ...)`.
No iniciar una generación nueva mientras la anterior siga `pending` o
`in_progress`.

Un rollback de código debe revertir juntas `whatsapp-automation`,
`process-whatsapp-automation-outbox`, `process-whatsapp-coexistence` y
`whatsapp-webhook`; no borrar tablas ni mensajes importados como parte del
rollback operativo.
