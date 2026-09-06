# Gisela Lentz · WhatsApp y turnos

Aplicación interna, single tenant, para administrar la agenda, pacientes y
conversaciones de WhatsApp de **Gisela Lentz · Odontología**. Reutiliza Qwik,
Supabase Auth/Postgres/Edge Functions, Vercel y la API oficial de WhatsApp Cloud.
No toma decisiones clínicas.

La raíz pública (`/`) contiene la landing de Gisela con información del
consultorio, horarios, atención, preguntas frecuentes y acceso directo al
WhatsApp oficial. El panel privado permanece bajo `/app` y `/login`. La landing
se renderiza en el servidor e incluye metadata social, datos estructurados y
`sitemap.xml`; cualquier cambio de dominio debe reflejarse también en
`public/robots.txt` y `public/sitemap.xml`.

Incluye un odontograma por paciente: es historia clínica, así que vive bajo
reglas propias. Sólo lo ve y lo carga el rol ADMIN, es append-only —una
corrección agrega un asiento y nunca pisa el anterior— y la automatización de
WhatsApp jamás lo lee ni lo envía. Ver [odontograma](docs/odontograma.md).

## Qué incluye

- Inicio centrado en el próximo turno, comprobantes para revisar, reservas que
  esperan seña y mensajes sin leer.
- Agenda diaria con pre-reservas, autoconfirmación básica opcional de la seña,
  revisión manual, cancelación, reprogramación, atención y ausencia.
- Pacientes administrativos, búsqueda por teléfono normalizado y relación con
  turnos y conversaciones.
- Cobertura IOMA o Particular por paciente, con duración automática configurable
  (30 o 60 minutos inicialmente). Los servicios conservan solamente el motivo.
- Seña y pre-reserva configurables, comprobantes asociados a WhatsApp y
  disponibilidad validada transaccionalmente en Postgres.
- Bandeja de WhatsApp, atención manual y pausa/reactivación del bot por
  conversación.
- Automatización determinista para reservar, consultar, cancelar y reprogramar
  turnos; atención prioritaria y respuesta fuera de horario.
- Recordatorios idempotentes, consentimiento, RLS, auditoría y controles de
  calidad de Meta.
- Conexión de Google Calendar con consentimiento explícito y sincronización
  automática hacia un calendario privado dedicado.
- Modo de prueba fail-closed y kill switch global para automatizaciones.

El flujo de reservas y señas está documentado en
[docs/reservas-y-senas.md](docs/reservas-y-senas.md).

Si la lectura de medios con IA está habilitada, la imagen o el PDF de un
comprobante se envía temporalmente a OpenAI con `store=false` para extraer sólo
los datos visibles: monto, moneda, fecha, destino, titular e identificador de la
operación. El modelo no valida el comprobante ni concilia la transferencia con
un banco. `store=false` evita crear estado de aplicación en Responses; según la
política vigente del proveedor, los registros de prevención de abuso pueden
conservar contenido hasta 30 días salvo que el proyecto tenga Zero Data
Retention. Una regla básica local y transaccional en PostgreSQL puede confirmar
automáticamente únicamente la pre-reserva exacta asociada al mensaje. Se
exigen sólo legibilidad, monto exacto y coincidencia de alias o titular; moneda,
fecha e identificador se guardan como datos auxiliares y no bloquean. Se
conservan la evidencia técnica, la lectura estructurada, el hash del archivo y
la auditoría; la plataforma no persiste localmente sus bytes. Los comprobantes que no cumplen la
regla o llegan tarde quedan para revisión manual, y Gisela puede revisar o
cancelar después cualquier turno autoconfirmado.

## Marca

La identidad visual usa el monograma propio **GL**, una curva de sonrisa y la
frase **“Tu sonrisa, cuidada con calma.”**. Los SVG listos para usar están en
[`public/brand`](public/brand/) y las reglas de color, tipografía y aplicación
están en la [guía de marca](docs/brand-guide.md).

## Desarrollo local

Requisitos: Node compatible con `package.json`, pnpm, Docker y Supabase CLI.

```bash
pnpm install
cp .env.example .env.local
pnpm exec supabase start --exclude vector
pnpm dev
```

El stack local de esta copia usa el rango `5532x`; así puede convivir sin tocar
un stack heredado que todavía use los puertos Supabase por defecto `5432x`.
Usar la API URL que imprime la CLI (normalmente `http://127.0.0.1:55321`) en
`.env.local`.

Completar en `.env.local` únicamente las variables públicas del proyecto local
o del nuevo proyecto de Gisela:

```env
PUBLIC_SUPABASE_URL=
PUBLIC_SUPABASE_PUBLISHABLE_KEY=
```

La aplicación muestra errores simples si Supabase no está configurado. Las
credenciales de Meta y las claves de servicio nunca usan el prefijo `PUBLIC_`.

## Gisela Lentz setup

### 1. Aislar los proyectos

Esta copia fue desvinculada de los proyectos remotos anteriores. Antes de todo
push o deploy:

1. Crear un proyecto Supabase nuevo para Gisela y anotar su project ref.
2. Crear o elegir un proyecto Vercel nuevo.
3. No reutilizar URL, ref, keys, WABA, Phone Number ID, callback ni cron de la
   aplicación anterior.
4. Ejecutar el guard local:

```bash
node scripts/assert-deployment-target.mjs
```

El comando falla si detecta los identificadores conocidos del proyecto viejo en
los enlaces locales de Supabase o Vercel. `pnpm run deploy:vercel` ejecuta este
guard antes de Vercel.

### 2. Vincular el Supabase nuevo y aplicar migraciones

Reemplazar `NUEVO_PROJECT_REF` por el valor real, verificar dos veces el destino
y recién entonces aplicar:

```bash
pnpm exec supabase login
pnpm exec supabase link --project-ref NUEVO_PROJECT_REF
node scripts/assert-deployment-target.mjs
pnpm exec supabase db push --dry-run
pnpm exec supabase db push
```

No ejecutar `db push`, `db reset`, `db query --linked` ni `functions deploy`
mientras el destino nuevo no esté comprobado. `supabase/seed.sql` contiene datos
ficticios para uso local y no debe cargarse en producción.

### 3. Configurar las Edge Functions

Supabase provee automáticamente `SUPABASE_URL` y la clave backend del proyecto a
sus Edge Functions. Configurar los siguientes secretos en el proyecto nuevo,
sin ponerlos en Git, Vercel o variables `PUBLIC_*`:

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
WHATSAPP_AUTOMATION_OUTBOX_RECOVERY_SECRET=
WHATSAPP_AUTOMATION_OUTBOX_CLAIM_LIMIT=10
WHATSAPP_COEXISTENCE_INTERNAL_SECRET=
WHATSAPP_COEXISTENCE_RECOVERY_SECRET=
WHATSAPP_COEXISTENCE_CLAIM_LIMIT=5
WHATSAPP_COEXISTENCE_ITEMS_PER_RUN=100
REMINDER_CRON_SECRET=
OPENAI_API_KEY=
OPENAI_ADMINISTRATIVE_ENABLED=false
APP_BASE_URL=
GOOGLE_CALENDAR_CLIENT_ID=
GOOGLE_CALENDAR_CLIENT_SECRET=
GOOGLE_CALENDAR_REDIRECT_URI=
GOOGLE_CALENDAR_CRON_SECRET=
APP_ALLOWED_ORIGINS=
WHATSAPP_AUTOMATIONS_ENABLED=false
WHATSAPP_EMBEDDED_SIGNUP_ENABLED=false
WHATSAPP_EMBEDDED_SIGNUP_MAX_ATTEMPTS_24H=10
WHATSAPP_TEST_MODE=true
WHATSAPP_TEST_ALLOWED_NUMBERS=
```

- `APP_ALLOWED_ORIGINS`: orígenes exactos separados por coma, incluida la URL
  nueva de Vercel; no usar `*`.
- `WHATSAPP_TEST_ALLOWED_NUMBERS`: números propios de prueba, separados por
  coma, en E.164; por ejemplo `+549...`. No hardcodearlos.
- `WHATSAPP_MEDIA_MAX_BYTES`: límite backend para abrir comprobantes de WhatsApp
  (10 MiB recomendado; nunca se exponen al navegador el token ni la URL de Meta).
- `WHATSAPP_WEBHOOK_MAX_BYTES`: límite incremental del webhook (3 MiB por
  defecto); evita bufferizar bodies no autenticados sin cota.
- `OPENAI_API_KEY`: secreto exclusivo de Supabase Edge Functions para el
  asistente administrativo opcional. Las respuestas administrativas y la
  lectura estructurada de comprobantes usan `gpt-5.6-luna`; las notas de voz
  usan el modelo de transcripción `gpt-transcribe`. Las solicitudes a Responses
  usan `store=false`; `/v1/audio/transcriptions` no expone ese parámetro y la
  documentación vigente indica que no conserva estado de aplicación ni logs de
  prevención de abuso. Sólo pueden ejecutarse si están activos
  `OPENAI_ADMINISTRATIVE_ENABLED`, `ai_enabled` y
  `WHATSAPP_AUTOMATIONS_ENABLED`. Los horarios provienen de las reglas
  estructuradas de agenda y la ubicación de los datos del consultorio; no
  existe un prompt/conocimiento libre editable.
- La opción independiente `ai_media_enabled` permite leer notas de voz y medios.
  Para comprobantes, se aplica el procesamiento temporal y la regla básica de
  autoconfirmación descriptos arriba; habilitar el asistente administrativo no
  habilita por sí solo la lectura de medios.
- Los flags solo aceptan `true` o `false`. Si faltan o están mal escritos, el
  sistema asume automatizaciones apagadas y mantiene activo el modo general de
  prueba.
- `WHATSAPP_EMBEDDED_SIGNUP_ENABLED` es un kill switch backend y queda en
  `false` por defecto. Sólo el literal `true` permite crear un intento; el
  frontend consume únicamente el booleano sanitizado de `status`.
- `WHATSAPP_EMBEDDED_SIGNUP_MAX_ATTEMPTS_24H` permanece sólo en backend. Usa
  `10` si falta o es inválido y limita cualquier entero configurado al rango
  `5`–`50`. La cuota se aplica por ADMIN y client scope; el burst guard fijo
  de `3` intentos cada `15` minutos no se desactiva.
- `/debug_token` usa un App Access Token efímero generado server-side con
  `META_APP_ID` y `META_APP_SECRET`. No se configura un token global del
  proveedor. Las operaciones sobre una WABA usan exclusivamente el business
  token individual obtenido para ese cliente mediante Embedded Signup.

Se pueden cargar desde el Dashboard de Supabase. Si se usa la CLI, hacerlo con
un archivo temporal ignorado y borrarlo después:

```bash
pnpm exec supabase secrets set --env-file .env.supabase-secrets --project-ref NUEVO_PROJECT_REF
```

Para Coexistence, aplicar antes y en orden las migraciones
`20260826120000_whatsapp_coexistence.sql`,
`20260826130000_whatsapp_automation_idempotency.sql` y
`20260826140000_whatsapp_bsuid_and_live_promotion.sql`, seguida por
`20260826150000_whatsapp_automation_causal_pause.sql`. La migración posterior
`20260826160000_whatsapp_recovery_schedule.sql` instala recovery inerte; sus dos
jobs se habilitan sólo mediante el procedimiento explícito y postgres-only de
[docs/whatsapp-recovery.md](docs/whatsapp-recovery.md). La migración local
`20260826170000_whatsapp_embedded_signup.sql` agrega Embedded Signup, Vault y su
outbox durable. En la producción de Gisela ya está aplicada; en un proyecto
nuevo debe revisarse y autorizarse separadamente antes de aplicarla.
Desplegar las funciones
solamente en el proyecto nuevo; `whatsapp-automation` debe preceder al outbox y
`whatsapp-webhook` debe quedar después de ambos processors:

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
pnpm exec supabase functions deploy google-calendar-oauth-start
pnpm exec supabase functions deploy google-calendar-oauth-callback
pnpm exec supabase functions deploy google-calendar-status
pnpm exec supabase functions deploy google-calendar-disconnect
pnpm exec supabase functions deploy process-calendar-sync
```

### 4. Configurar Vercel como hosting actual y rollback

Vincular la carpeta con el proyecto nuevo y volver a ejecutar el guard:

```bash
pnpm exec vercel link
node scripts/assert-deployment-target.mjs
```

Configurar únicamente:

```env
PUBLIC_SUPABASE_URL=https://NUEVO_PROJECT_REF.supabase.co
PUBLIC_SUPABASE_PUBLISHABLE_KEY=
```

Agregar temporalmente los orígenes de Vercel y Cloudflare a
`APP_ALLOWED_ORIGINS` en Supabase y a las URLs de redirección permitidas de
Supabase Auth. El origen canónico está centralizado en `src/config/site.ts`; ver
`docs/CLOUDFLARE_MIGRATION.md` para el cutover y el rollback.

### 5. Crear el primer usuario

No existe signup público. Crear el usuario desde Supabase Dashboard →
Authentication → Users. El trigger crea un perfil `OPERADOR`; para promover al
primer administrador, reemplazar el email por el real:

```sql
update public.profiles
set role = 'ADMIN'
where id = (
  select id from auth.users where email = 'EMAIL_ADMIN_REAL'
);
```

### 6. Conectar el número de prueba

No hay ningún número conectado por código. Configurar manualmente en Meta:

- la WABA y el Phone Number ID del entorno de prueba;
- el token y App Secret correspondientes;
- el callback
  `https://NUEVO_PROJECT_REF.supabase.co/functions/v1/whatsapp-webhook`;
- el verify token elegido;
- la suscripción al campo `messages` y a los eventos operativos detallados en
  [docs/whatsapp-setup.md](docs/whatsapp-setup.md).

Mantener inicialmente:

```env
WHATSAPP_AUTOMATIONS_ENABLED=false
WHATSAPP_TEST_MODE=true
WHATSAPP_TEST_ALLOWED_NUMBERS=NUMERO_PROPIO_E164
```

Así se pueden recibir webhooks y usar la bandeja sin respuestas automáticas. El
test mode bloquea **todo** envío a un destinatario fuera de la allowlist antes de
consultar el token o llamar a Graph, y registra el intento sin teléfono ni texto
del mensaje en logs.

Cuando el número autorizado, la firma del webhook, los horarios y los servicios
estén verificados, habilitar la palanca de servidor:

```env
WHATSAPP_AUTOMATIONS_ENABLED=true
```

Esto permite que funcione el interruptor de la aplicación, pero no enciende el
bot por sí solo: `app_settings.automations_enabled` nace en `false`. Una persona
`ADMIN` puede encenderlo desde el menú lateral en escritorio o desde Inicio en
mobile. El estado debe quedar apagado hasta terminar la verificación.

No desactivar `WHATSAPP_TEST_MODE` hasta terminar todas las pruebas controladas.

### 7. Verificar WhatsApp Health

Ingresar a **Configuración → WhatsApp → Verificar conexión**. La pantalla muestra
solo estado, número visible, nombre, calidad, pausa global, test mode, cantidad de
números permitidos y estado del kill switch; nunca muestra tokens.

Si las credenciales de WhatsApp todavía no existen, debe indicar **WhatsApp no
configurado** y el resto de la aplicación continúa funcionando.

### 8. Recordatorios

El aviso del día anterior y el segundo aviso opcional están apagados
inicialmente. El primero se configura desde la aplicación y usa las 21:00 de
Buenos Aires como hora inicial. Antes de crear el cron, validar consentimiento,
plantillas `UTILITY`, calidad, test mode y el checklist de
[cumplimiento](docs/whatsapp-compliance.md). El job debe invocar
`process-reminders` cada cinco minutos con `x-cron-secret`; URL y secreto deben
quedar en Supabase Vault. El backend espera hasta la hora configurada y el kill
switch también bloquea recordatorios automáticos.

### 9. Google Calendar

La integración permite conectar una cuenta desde **Configuración → Google
Calendar**, elegir explícitamente un calendario propio e importar su ocupación
como bloqueos de sólo lectura. Las pre-reservas y los turnos nuevos sólo pueden
proyectarse después de una activación técnica separada: desplegar, conectar o
importar no habilita por sí solo el scheduler ni las escrituras en Google.
Configuración de OAuth, permisos mínimos, activación, rollback y prueba
controlada en [docs/google-calendar-setup.md](docs/google-calendar-setup.md).

## WhatsApp Business App Coexistence

El repositorio incluye recepción segura y procesamiento durable de `messages`,
`history`, `smb_app_state_sync` y `smb_message_echoes`, identidad dual por BSUID
opaco o teléfono nullable y paginación del inbox para historiales grandes. Los
medios históricos se enriquecen por wamid desde `messages[]` o
`message_echoes[]`; una carrera history→live se promueve atómicamente y un eco
manual pre-pausa la automatización antes de los inbound vivos del mismo POST.
La cola encadena pasadas para no dejar otras cuentas esperando el cron. El
módulo de Coexistence no inicia por sí solo Embedded Signup ni conecta un número
real: eso exige la acción explícita de una ADMIN desde el flujo separado.
Arquitectura, orden de migración/despliegue, cierre de generaciones fallidas,
recuperación y rollback de las cuatro funciones están en
[docs/whatsapp-coexistence.md](docs/whatsapp-coexistence.md).
El scheduler durable, sus credenciales dedicadas y su rollback operativo están
en [docs/whatsapp-recovery.md](docs/whatsapp-recovery.md).

## Validación

```bash
pnpm build.types
pnpm lint
pnpm test:automation
pnpm fmt.check
pnpm exec supabase db lint --local --schema public --level warning --fail-on error
pnpm exec supabase test db
pnpm build
git diff --check
```

## Documentación

- [Arquitectura](docs/architecture.md)
- [Base de datos](docs/database.md)
- [Odontograma](docs/odontograma.md)
- [Conexión de WhatsApp](docs/whatsapp-setup.md)
- [WhatsApp Coexistence](docs/whatsapp-coexistence.md)
- [Embedded Signup v4](docs/whatsapp-embedded-signup.md)
- [Checklist presencial de Gisela](docs/ONBOARDING_GISELA.md)
- [Recovery de WhatsApp](docs/whatsapp-recovery.md)
- [Flujo de automatización](docs/automation-flow.md)
- [Demo controlada](docs/demo-whatsapp-real.md)
- [Cumplimiento y protección del número](docs/whatsapp-compliance.md)
- [Conexión de Google Calendar](docs/google-calendar-setup.md)

Las migraciones históricas conservan textos antiguos porque ya forman parte del
historial inmutable. La migración incremental de Gisela reemplaza de forma
condicional esos defaults al instalar el esquema. Las otras únicas referencias
deliberadas al proyecto anterior están en el guard de aislamiento; no son URLs ni
credenciales consumidas por la aplicación.
