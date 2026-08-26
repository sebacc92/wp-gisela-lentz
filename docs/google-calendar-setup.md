# Google Calendar: conexión y sincronización

La integración permite que Gisela conecte su cuenta desde **Configuración →
Google Calendar → Conectar**. Google muestra su pantalla de consentimiento y la
aplicación crea un calendario secundario privado llamado **Gisela Lentz ·
Turnos**.

La agenda de la aplicación es la fuente de verdad. Google Calendar funciona
como un espejo administrativo de los turnos; no se importan cambios hechos a
mano en Google. Esto evita reservas duplicadas y conflictos difíciles de
resolver para la usuaria.

## Qué se sincroniza

- alta y reprogramación: crea o actualiza el evento;
- cancelación: elimina el evento administrado; los turnos se conservan como
  historial y no se borran físicamente;
- cada turno conserva un ID determinista, así los reintentos no duplican
  eventos;
- el evento contiene únicamente `Turno odontológico · Nombre`, inicio, fin y un
  identificador privado del turno;
- cada evento se marca además con visibilidad privada, como defensa adicional si
  Gisela comparte el calendario;
- no se envían teléfono, nota interna, servicio, motivo clínico, asistentes ni
  notificaciones de Google (`sendUpdates=none`).

Al desconectar se revoca y elimina la credencial local, pero se conservan los
eventos que ya existen en Google. La pantalla lo aclara antes de confirmar. Una
reconexión solicitada por Google reutiliza el mismo calendario si todavía es
accesible. Después de una desconexión explícita se elimina también el vínculo
local; al conectar nuevamente puede crearse otro calendario dedicado, mientras
el anterior permanece en la cuenta hasta que Gisela decida borrarlo.

## 1. Preparar Google Cloud

1. Crear un proyecto exclusivo para Gisela en
   [Google Cloud Console](https://console.cloud.google.com/).
2. Habilitar **Google Calendar API**.
3. Configurar la pantalla de consentimiento OAuth con el nombre y los datos
   reales de la aplicación. Mientras esté en modo de prueba, agregar la cuenta
   de Gisela como usuaria de prueba.
4. Crear credenciales **OAuth client ID → Web application**.
5. Registrar exactamente esta URI de redirección, sustituyendo el project ref:

   ```text
   https://PROJECT_REF.supabase.co/functions/v1/google-calendar-oauth-callback
   ```

   Para desarrollo local también puede registrarse:

   ```text
   http://127.0.0.1:55321/functions/v1/google-calendar-oauth-callback
   ```

Google exige coincidencia exacta de la URI. No usar comodines, URLs de preview
ni una ruta enviada por el navegador.

El modo **Testing** sirve sólo para la prueba controlada: Google limita allí la
duración de los refresh tokens (habitualmente siete días para scopes distintos
de identidad). Antes del uso cotidiano hay que publicar la pantalla de
consentimiento en **Production** y completar cualquier verificación de marca o
scope que Google solicite. La revisión de scopes sensibles puede demorar varios
días, por lo que conviene iniciarla antes de la puesta en marcha. Referencias:
[expiración de tokens](https://developers.google.com/identity/protocols/oauth2#expiration)
y [verificación de scopes sensibles](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

La aplicación solicita sólo estos permisos:

```text
openid
email
https://www.googleapis.com/auth/calendar.app.created
```

`calendar.app.created` permite crear un calendario secundario y administrar
únicamente los eventos de calendarios creados por la aplicación. Es más acotado
que solicitar acceso a todos los calendarios de la cuenta. Consultar la
[lista oficial de permisos de Calendar](https://developers.google.com/workspace/calendar/api/auth).

## 2. Configurar secretos de Edge Functions

Configurar en el proyecto Supabase nuevo:

```env
APP_BASE_URL=https://DOMINIO_FINAL_DE_LA_APP
GOOGLE_CALENDAR_CLIENT_ID=
GOOGLE_CALENDAR_CLIENT_SECRET=
GOOGLE_CALENDAR_REDIRECT_URI=https://PROJECT_REF.supabase.co/functions/v1/google-calendar-oauth-callback
GOOGLE_CALENDAR_CRON_SECRET=
```

- `APP_BASE_URL` debe ser el origen final, sin query ni fragmento. Es el único
  retorno aceptado por el callback.
- `GOOGLE_CALENDAR_CRON_SECRET` debe ser aleatorio y diferente de
  `REMINDER_CRON_SECRET`.
- Ningún valor lleva prefijo `PUBLIC_`; el secreto de cliente y los tokens nunca
  llegan a Vercel o al navegador.
- El refresh token se guarda cifrado en **Supabase Vault** mediante un RPC
  restringido a `service_role`. Nunca se escribe en tablas públicas ni logs.

Google recomienda `access_type=offline` para renovar el acceso cuando la
usuaria no está presente. El flujo usa además `state` aleatorio, hash de un solo
uso con vencimiento y PKCE S256. Referencia:
[OAuth 2.0 para aplicaciones web de servidor](https://developers.google.com/identity/protocols/oauth2/web-server).

## 3. Aplicar y desplegar

Primero comprobar el proyecto vinculado y revisar los cambios:

```bash
node scripts/assert-deployment-target.mjs
pnpm exec supabase db push --dry-run
pnpm exec supabase db push
```

Después desplegar las funciones:

```bash
pnpm exec supabase functions deploy google-calendar-oauth-start
pnpm exec supabase functions deploy google-calendar-oauth-callback
pnpm exec supabase functions deploy google-calendar-status
pnpm exec supabase functions deploy google-calendar-disconnect
pnpm exec supabase functions deploy process-calendar-sync
```

## 4. Mantener la sincronización activa

Crear un cron que invoque `process-calendar-sync` cada minuto con método `POST`
y el encabezado:

```text
x-google-calendar-cron-secret: VALOR_DE_GOOGLE_CALENDAR_CRON_SECRET
```

URL:

```text
https://PROJECT_REF.supabase.co/functions/v1/process-calendar-sync
```

Guardar URL y secreto en Supabase Vault; no escribir el secreto directamente
en SQL. Supabase documenta este patrón en
[Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions).

Cada cambio de turno deja una tarea durable en Postgres. El worker toma las
tareas con bloqueo, renueva el access token, realiza operaciones idempotentes y
reintenta fallos transitorios con espera exponencial. También ejecuta una
reconciliación para reparar tareas perdidas. En la práctica, un cambio se verá
en Google normalmente dentro del minuto siguiente; el botón **Sincronizar
ahora** permite hacerlo de inmediato.

Si Google devuelve `invalid_grant` porque el permiso venció o fue revocado, se
detienen los envíos y la pantalla muestra **Volver a conectar**. Google explica
que los refresh tokens pueden invalidarse y que la aplicación debe manejarlo:
[prácticas recomendadas de OAuth](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).

## 5. Prueba controlada

1. Conectar una cuenta de Google de prueba desde el botón.
2. Confirmar que aparece el calendario **Gisela Lentz · Turnos**.
3. Crear un turno ficticio y usar **Sincronizar ahora**.
4. Reprogramarlo y comprobar que cambia el mismo evento, sin duplicarse.
5. Cancelarlo y comprobar que el evento desaparece.
6. Desconectar y confirmar que el acceso local desaparece, pero los eventos ya
   creados se conservan.
7. Revisar que logs, respuestas de Edge y tablas públicas no contengan tokens,
   códigos OAuth, teléfonos ni notas internas.

No habilitar el cron definitivo hasta completar esta prueba con el proyecto,
dominio y cuenta correctos.
