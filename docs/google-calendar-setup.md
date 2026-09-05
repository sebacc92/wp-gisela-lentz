# Google Calendar: conexión y sincronización

> **Estado de Gisela (4 de septiembre de 2026):** esta integración está
> implementada localmente, pero sus Functions, secretos y cron aún no fueron
> preparados en producción. No iniciar OAuth ni pedir a Gisela que conecte su
> cuenta hasta completar y autorizar ese despliegue técnico separado.

La integración permite que Gisela conecte su cuenta desde **Configuración →
Google Calendar → Conectar**. Google muestra su pantalla de consentimiento y la
aplicación lista únicamente los calendarios preexistentes que esa cuenta posee.
Una ADMIN debe elegir explícitamente el calendario del consultorio y confirmar
la zona horaria; la aplicación no crea ni elige calendarios automáticamente.
Puede ser el calendario principal o uno secundario, pero la cuenta debe ser su
propietaria (`accessRole=owner`). Un calendario compartido con permiso de
escritura no alcanza.

Completar OAuth todavía no cambia la conexión activa. El callback guarda un
candidato efímero durante 15 minutos, con el refresh token en Vault, y vuelve a
Configuración con el estado **Falta confirmar**. La pantalla muestra sólo nombre,
si es principal y zona horaria. El identificador se usa internamente para la
confirmación y no se presenta como dato operativo. **Elegir otra cuenta**
descarta ese candidato e invalida respuestas tardías del intento anterior.

La integración es bidireccional. Los cambios entrantes no empiezan hasta que una
ADMIN revisa el preview y aprueba la primera importación; los conflictos quedan
pendientes de revisión en lugar de sobreescribir silenciosamente un turno.

## Qué se sincroniza

- alta, cambio de nombre y reprogramación desde la aplicación: crea o actualiza
  el mismo evento;
- cancelación desde la aplicación: elimina el evento administrado; el turno se
  conserva como historial y no se borra físicamente;
- cada turno conserva un ID determinista, así los reintentos no duplican
  eventos;
- el evento contiene únicamente `Turno odontológico · Nombre`, inicio, fin y un
  identificador privado del turno;
- cada evento se marca además con visibilidad privada, como defensa adicional si
  Gisela comparte el calendario;
- no se envían teléfono, nota interna, servicio, motivo clínico, asistentes ni
  notificaciones de Google (`sendUpdates=none`).
- después de la aprobación inicial, los eventos manuales de Google compatibles
  se importan como **bloqueos de agenda**, nunca como pacientes ni turnos;
- una ADMIN puede convertir un bloqueo en un turno desde la agenda. Si queda
  esperando seña, el evento original sigue bloqueando el horario; se retira
  recién cuando existe el evento sustituto administrado o cuando la cancelación
  quedó confirmada en Google;
- los eventos de todo el día y las series recurrentes quedan como no soportados
  para revisión; mientras exista alguno sin resolver, la disponibilidad falla
  cerrada para evitar una doble reserva;
- mover o borrar en Google un evento que administra la aplicación crea un
  conflicto pendiente. Una ADMIN debe aplicar o rechazar el cambio; Google no
  cancela ni reprograma silenciosamente un turno de paciente.

Al desconectar se eliminan la credencial activa y cualquier candidato local; la
Function también intenta revocar en Google, sin duplicarlos, tanto el grant
activo como el candidato. Si Google no está disponible, la desconexión local
igualmente prevalece y la revocación se puede completar después desde la cuenta
de Google. Los eventos remotos se conservan.

Una reconexión vuelve a exigir una selección explícita. Mientras exista una
conexión activa, autorizar otra cuenta sólo prepara el candidato: la cuenta, el
calendario, los tokens incrementales, los bloqueos y la cola anteriores no
cambian hasta confirmar un calendario owner válido. La confirmación rota la
generación de conexión de forma atómica y vuelve a exigir preview y aprobación
para el nuevo alcance.

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

6. Antes del OAuth productivo, crear o identificar en la cuenta correcta el
   calendario que se usará. Su zona horaria debe coincidir exactamente con la
   configurada en la aplicación (por ejemplo,
   `America/Argentina/Buenos_Aires`). La confirmación falla de forma segura si
   no coincide.

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
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar.events.owned
```

`calendar.calendarlist.readonly` permite mostrar los calendarios existentes y
`calendar.events.owned` administrar eventos únicamente en calendarios propios.
La aplicación filtra y vuelve a validar `accessRole=owner`: nunca crea un
calendario ni permite seleccionar uno compartido con rol writer. La autorización
no combina scopes concedidos anteriormente. Consultar la [lista oficial de
permisos de Calendar](https://developers.google.com/workspace/calendar/api/auth).

Las conexiones creadas con el permiso legado `calendar.app.created` deben pasar
otra vez por OAuth después de desplegar esta versión. Un refresh token anterior
no adquiere los dos permisos nuevos por el solo hecho de actualizar el código.
No habilitar la sincronización productiva hasta comprobar el consentimiento y la
selección con la cuenta de prueba.

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
  llegan al Worker de frontend ni al navegador.
- El refresh token se guarda cifrado en **Supabase Vault** mediante un RPC
  restringido a `service_role`. Nunca se escribe en tablas públicas ni logs.

Google recomienda `access_type=offline` para renovar el acceso cuando la
usuaria no está presente. El flujo usa además `state` aleatorio, hash de un solo
uso con vencimiento y PKCE S256. Referencia:
[OAuth 2.0 para aplicaciones web de servidor](https://developers.google.com/identity/protocols/oauth2/web-server).

## 3. Aplicar y desplegar

El orden detallado y el procedimiento de cambio de cuenta están en
[google-calendar-bidirectional-deploy.md](google-calendar-bidirectional-deploy.md).
Hacerlo en una ventana breve sin iniciar OAuth ni sincronizaciones manuales.
Primero comprobar el proyecto vinculado y revisar los cambios:

```bash
node scripts/assert-deployment-target.mjs
pnpm exec supabase db push --dry-run
pnpm exec supabase db push
```

La migración de selección explícita deshabilita deliberadamente la finalización
OAuth antigua. Por eso, una vez aplicado `db push`, desplegar sin demora y desde
la misma revisión todas las Functions de Calendar:

```bash
pnpm exec supabase functions deploy google-calendar-oauth-start
pnpm exec supabase functions deploy google-calendar-oauth-callback
pnpm exec supabase functions deploy google-calendar-status
pnpm exec supabase functions deploy google-calendar-disconnect
pnpm exec supabase functions deploy google-calendar-selection
pnpm exec supabase functions deploy process-calendar-sync
```

Después desplegar el frontend. `google-calendar-selection` debe existir antes de
publicar la pantalla que consume `selectionPending`. No reanudar el cron hasta
completar las verificaciones de sólo lectura y la prueba controlada.

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

Una sincronización completa lista la ventana futura y, además, audita por ID los
eventos administrados conocidos que no aparecieron allí. Así un turno movido al
pasado o eliminado en Google no se pierde al renovar un `syncToken`. Una
respuesta incompleta o un resultado RPC desconocido detienen el avance y el
push. Un ETag ausente abre revisión humana y retiene ese turno antes de escribir;
nunca se interpreta como permiso para sobrescribir.

Si Google devuelve `invalid_grant` porque el permiso venció o fue revocado, se
detienen los envíos y la pantalla muestra **Volver a conectar**. Google explica
que los refresh tokens pueden invalidarse y que la aplicación debe manejarlo:
[prácticas recomendadas de OAuth](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).

## 5. Prueba controlada

Usar únicamente pacientes ficticios y títulos con un prefijo inequívoco, por
ejemplo `[PRUEBA CALENDAR]`. No usar datos reales para validar el despliegue.

1. Conectar una cuenta de Google de prueba desde el botón.
2. Confirmar que Configuración muestra **Falta confirmar** y sólo lista
   calendarios propios con nombre, indicador de principal y zona horaria.
3. Elegir explícitamente el calendario de prueba correcto. No confirmar si la
   zona horaria no coincide con la aplicación.
4. Ejecutar **Ver qué hay en Google**. Debe devolver sólo un resumen y no crear
   bloqueos, jobs ni eventos.
5. No aprobar si el recorrido aparece truncado o informa eventos no soportados.
   Aprobar la primera importación y usar **Sincronizar ahora**. Un evento manual
   ficticio debe aparecer como bloqueo, no como paciente ni turno.
6. Crear y confirmar un turno ficticio desde la aplicación y sincronizar. Debe
   aparecer una sola vez en Google aun si se repite la sincronización. Un turno
   que siga en `scheduled` no debe exportarse.
7. Cambiar nombre y horario desde la aplicación. Debe actualizarse el mismo
   evento.
8. Mover el evento administrado desde Google. Debe aparecer un conflicto para
   aplicar o rechazar; el turno interno no cambia antes de esa decisión.
9. Rechazar ese conflicto para restaurar la proyección y luego cancelar el turno
   desde la aplicación. El evento administrado debe desaparecer sin borrar el
   historial interno.
10. Desconectar y confirmar que desaparecen las credenciales y el alcance
    locales, mientras los eventos ya creados se conservan en Google.
11. Revisar que logs, respuestas de Edge y tablas públicas no contengan tokens,
    códigos OAuth, teléfonos ni notas internas.

No habilitar el cron definitivo hasta completar esta prueba con el proyecto,
dominio y cuenta correctos.

## 6. Reemplazar una cuenta de prueba por la cuenta real

El cambio intencional desde una cuenta de prueba se hace con una ventana corta
sin sincronización. No reutilizar el calendario ni las credenciales de prueba:

1. Confirmar que la cuenta real ya posee el calendario definitivo, con la zona
   horaria exacta de la aplicación.
2. Pausar sólo el cron de Calendar y esperar a que no haya jobs en
   `processing` ni un lease entrante vigente.
3. Guardar un diagnóstico de sólo lectura de la conexión y de los contadores de
   cola. No copiar tokens, IDs de Vault ni datos de pacientes.
4. Desde Configuración, desconectar la cuenta de prueba. Esta acción cancela la
   cola de la generación anterior y deja de considerar sus bloqueos; no borra
   sus eventos en Google.
5. Iniciar OAuth con la cuenta real y completar la selección dentro de los 15
   minutos. Si vence, volver a conectar; nunca forzar la selección con datos
   guardados del intento anterior.
6. Antes de confirmar, revisar nombre, indicador de principal y zona horaria.
   Al confirmar se crea una generación nueva y se encolan los turnos futuros ya
   confirmados. Mantener el cron pausado hasta decidir que esos turnos realmente
   deben copiarse al calendario elegido.
7. Verificar por lectura que el estado sea conectado, que no quede una selección
   pendiente y que los bloqueos/conflictos de la cuenta de prueba no aparezcan
   en el alcance activo.
8. Ejecutar el preview de la cuenta real. Aprobar la primera importación sólo si
   los contadores corresponden al calendario esperado, el recorrido no está
   truncado y no hay eventos no soportados. Verificar además que ningún turno
   confirmado ya cargado se solape con un evento manual: esos casos deben
   resolverse antes de habilitar su salida para no duplicarlos.
9. Hacer una sincronización manual controlada y comprobar creación, edición y
   reintento con un turno ficticio. Luego reanudar el cron y verificar una corrida
   correcta.
10. Recién después de validar la cuenta real, quitar el acceso de la aplicación
    desde la cuenta de prueba si la revocación automática no quedó confirmada.

Si se confirmó el calendario incorrecto pero el cron sigue pausado, no ejecutar
**Sincronizar ahora**: desconectar y repetir OAuth con el destino correcto. Si ya
hubo escrituras, detener la sincronización y reconciliar esos eventos antes de
otro cambio de cuenta; la aplicación no los elimina del calendario anterior de
forma automática.
