# Google Calendar: conexión y sincronización

> **Estado operativo:** el código y las migraciones se publican con la
> automatización saliente desactivada. Conectar Calendar o desplegar no instala
> por sí solo el cron ni autoriza escrituras; la activación requiere una acción
> técnica separada después de verificar importación v2, calendario y alcance.

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

- una pre-reserva vigente creada después de la activación aparece como
  `Nombre Apellido TF 2262338010 IOMA (pendiente de seña)`;
- al confirmar la seña, cambiar el nombre o reprogramar desde la aplicación se
  actualiza el mismo evento; al confirmar queda
  `Nombre Apellido TF 2262338010 IOMA`. Es el mismo orden y la misma forma en
  que Gisela escribe sus turnos a mano (ver
  [google-calendar-patient-import.md](google-calendar-patient-import.md));
- `TF` corresponde a paciente existente (tiene ficha), y `1ra vez` a primera
  atención. Se usa el celular del contacto (o el alternativo si no hay uno
  principal) y la cobertura guardada en el turno: `Particular` o `IOMA`.
  Un celular argentino se escribe con sus 10 dígitos, sin `+54` ni el 9
  (`2262338010`); uno extranjero conserva su prefijo internacional.
  Los datos faltantes figuran como `(ficha sin confirmar)`,
  `(celular sin confirmar)` o `(cobertura sin confirmar)`, sin inferirlos;
- cambiar el formato del título no requiere migrar nada: el reconciliador
  vuelve a encolar cada turno futuro ya proyectado hace más de una hora, y el
  worker actualiza ese mismo evento con el título nuevo;
- cancelación desde la aplicación: elimina el evento administrado; el turno se
  conserva como historial y no se borra físicamente;
- cada turno conserva un ID determinista, así los reintentos no duplican
  eventos;
- el evento contiene únicamente el título operativo, inicio, fin y marcadores
  privados de la asociación exacta con el turno y la activación;
- cada evento se marca además con visibilidad privada, como defensa adicional si
  Gisela comparte el calendario;
- no se envían nota interna, servicio, motivo clínico, asistentes ni
  notificaciones de Google (`sendUpdates=none`).
- después de la aprobación inicial, los eventos manuales de Google compatibles
  se importan como **bloqueos de agenda**, nunca como pacientes ni turnos;
- una ADMIN puede convertir un bloqueo en un turno desde la agenda, pero el
  evento externo original sigue siendo de sólo lectura: no se reemplaza ni se
  elimina desde la aplicación y no se crea otra proyección para ese turno;
- los eventos de todo el día y las ocurrencias de series recurrentes se leen
  dentro de la cobertura móvil y bloquean su rango ocupado. Excepciones movidas
  o canceladas conservan la identidad de la ocurrencia;
- mover o borrar en Google un evento que administra la aplicación crea un
  conflicto pendiente. Una ADMIN debe aplicar o rechazar el cambio; Google no
  cancela ni reprograma silenciosamente un turno de paciente.

Al desconectar sin un epoch activo ni mappings vivos se eliminan la credencial
activa y cualquier candidato local; la Function también intenta revocar en
Google, sin duplicarlos, tanto el grant activo como el candidato. Si Google no
está disponible, la desconexión local igualmente prevalece y la revocación se
puede completar después desde la cuenta de Google. Los eventos remotos se
conservan.

Si la automatización ya creó eventos que todavía representan pre-reservas o
turnos, desconectar o cambiar cuenta/calendario falla con
`GOOGLE_CALENDAR_AUTOMATION_DRAIN_REQUIRED`. Pausar cron no elimina esa
barrera: primero hay que reconciliar cada mapping hasta `absent` bajo el mismo
alcance. Nunca forzar la conexión por SQL ni abandonar eventos administrados en
otro calendario.

Una reconexión vuelve a exigir una selección explícita. Mientras exista una
conexión activa, autorizar otra cuenta sólo prepara el candidato: la cuenta, el
calendario, los tokens incrementales, los bloqueos y la cola anteriores no
cambian hasta confirmar un calendario owner válido. Reautorizar exactamente la
misma cuenta/calendario conserva el epoch y re-bindea la generación; cualquier
destino distinto exige que el alcance anterior ya esté drenado. En ambos casos
se vuelve a exigir preview y aprobación.

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
No habilitar la sincronización productiva hasta comprobar el consentimiento, la
selección y la importación v2 con la cuenta y el calendario definitivos. No
reutilizar ni exportar trabajos de una conexión de prueba anterior.

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
publicar la pantalla que consume `selectionPending`. Las migraciones terminan
sin cron de Calendar y con la salida desactivada: no instalar el scheduler hasta
recibir la autorización explícita posterior al preflight.

## 4. Mantener la sincronización activa

La migración instala infraestructura inerte para un único cron cada minuto y un
disparo inmediato transaccional. La URL exacta y el secreto dedicado deben
existir una sola vez en Supabase Vault; nunca se escriben en SQL ni en el
repositorio. Sólo `postgres` puede ejecutar la instalación explícita, que valida
el calendario, la generación, la importación v2 y la ausencia de trabajo previo
en curso antes de crear el epoch de autorización.

Cada cambio autorizado deja una tarea durable en la misma transacción. El
servidor solicita el procesamiento inmediato y el cron funciona como
recuperación: consulta cambios entrantes, renueva la cobertura móvil de 21 días,
procesa vencimientos y reintenta fallos transitorios. Ambos caminos usan el
mismo lease y la misma cola idempotente. El botón **Sincronizar ahora** conserva
los permisos y controles del procesador existente.

### Preparar la activación sin encenderla

Antes de instalar el scheduler:

1. Guardar en **Edge Functions → Secrets** un valor aleatorio de al menos 32
   caracteres con el nombre exacto GOOGLE_CALENDAR_CRON_SECRET. No reutilizar
   secretos de WhatsApp ni escribir el valor en SQL, Git, logs o el historial de
   la terminal.
2. En **Database → Vault**, crear exactamente dos secretos:
   - google_calendar_automation_project_url: la URL
     https://PROJECT_REF.supabase.co;
   - google_calendar_automation_cron_secret: el mismo valor aleatorio
     configurado en la Edge Function.
3. Verificar que exista una sola fila por cada nombre. La instalación falla
   cerrada si falta una, si hay duplicados, si la URL no coincide con el project
   ref compilado o si el secreto no cumple la longitud mínima.
4. Comprobar desde Data API que Accept-Profile: net responda
   PGRST106 Invalid schema. net.http_request_queue y net.\_http_response son
   infraestructura interna de Supabase y no deben figurar entre los schemas
   expuestos.
5. Consultar por lectura la generación activa, importación v2, cobertura, lease,
   conflictos y jobs previos. No copiar IDs de eventos, tokens ni datos de
   pacientes al informe.

Crear esos secretos todavía no instala cron, no cambia el epoch y no toca
Google.

### Activar sólo después de la autorización

La activación debe ocurrir **antes** de crear la primera pre-reserva que se
quiera proyectar. El timestamp de esa transacción es el corte: ningún turno ni
job anterior puede adoptar el epoch.

Desde una sesión postgres, sustituyendo únicamente la generación ya verificada:

```sql
select private.install_google_calendar_automatic_schedule(
  <GENERACION_VERIFICADA>
);

select private.google_calendar_automatic_schedule_status();
```

El primer resultado debe informar enabled=true y un solo job cada minuto. El
segundo debe informar configurationConsistent=true, configuredJobs=1 y
activeJobs=1. Recién después se crea la pre-reserva ficticia autorizada y se
valida el ciclo.

### Pausa y recuperación

Ante una falla después de activar, pausar únicamente el job exacto conserva los
mappings y corta tanto el cron como el disparo inmediato, porque la
configuración deja de ser consistente:

```sql
select cron.alter_job(
  job_id := (
    select cron_job_id
    from private.google_calendar_automatic_config
    where id = true
  ),
  active := false
);
```

Corregir o revertir frontend/Functions desde la revisión recuperable y volver a
activar ese mismo job sólo tras validar el contrato. No borrar la configuración
ni crear otro cron. La desinstalación definitiva:

```sql
select private.uninstall_google_calendar_automatic_schedule();
```

falla cerrada mientras quede un evento administrado que deba actualizarse o
retirarse. Sólo usarla cuando todos los mappings del epoch estén drenados a
absent; nunca para forzar un rollback.

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
6. Repetir el preflight de alcance y, con autorización explícita, instalar el
   scheduler para la generación comprobada. Confirmar un solo cron activo y
   configuración consistente.
7. Crear una pre-reserva ficticia autorizada **después** de ese corte. Debe
   aparecer una sola vez como
   `Nombre Apellido TF 2262338010 IOMA (pendiente de seña)`, aun si se repite la
   sincronización.
8. Confirmar la seña, cambiar el nombre y reprogramar. Debe actualizarse el
   mismo ID como `Nombre Apellido TF 2262338010 IOMA`.
9. Mover el evento administrado desde Google. Debe aparecer un conflicto para
   aplicar o rechazar; el turno interno no cambia antes de esa decisión.
10. Rechazar ese conflicto para restaurar la proyección y luego cancelar el turno
    desde la aplicación. El evento administrado debe desaparecer sin borrar el
    historial interno.
11. Tras comprobar que el evento cancelado dejó el epoch drenado a absent,
    desinstalar y desconectar. Deben desaparecer las credenciales y el alcance
    locales; los eventos externos permanecen intactos en Google.
12. Revisar que logs, respuestas de Edge y tablas públicas no contengan tokens,
    códigos OAuth, teléfonos ni notas internas.

No activar el scheduler ni crear un evento de prueba real sin autorización
explícita, aun cuando el código ya esté desplegado.

## 6. Reemplazar una cuenta de prueba por la cuenta real

Un retarget sólo es seguro si la automatización nunca se activó o si todos sus
mappings ya terminaron en `absent`. Una pausa no convierte un alcance con
eventos vivos en drenado.

1. Confirmar que la cuenta real posee el calendario definitivo y que su zona
   horaria coincide exactamente con la aplicación.
2. Si existe scheduler, pausar únicamente su `cron_job_id`. Esperar a que no
   haya jobs `processing` ni lease entrante vigente.
3. Guardar un diagnóstico de sólo lectura: epoch, estados agregados de jobs y
   cantidad de mappings vivos. No copiar tokens, IDs de eventos, nombres de
   pacientes ni secretos.
4. Si queda cualquier mapping `pre_reservation` o `confirmed`, no
   desconectar ni confirmar otro destino. Continuar operando el alcance actual
   o resolver el drenaje con una decisión explícita; la aplicación no mueve ni
   abandona esos eventos.
5. Sólo con cero mappings vivos, ejecutar la desinstalación y comprobar
   configuración inactiva y cero jobs de Calendar. Luego desconectar desde
   Configuración; no borrar ni modificar eventos del calendario anterior.
6. Iniciar OAuth con la cuenta real y completar la selección dentro de los 15
   minutos. Si vence, volver a conectar; nunca forzar la selección con datos
   guardados del intento anterior.
7. Antes de confirmar, revisar nombre, indicador de principal y zona horaria.
   Confirmar crea una generación nueva, pero no adopta ni exporta turnos o jobs
   anteriores.
8. Ejecutar preview, aprobar la primera importación y completar una lectura
   manual. No continuar si el alcance está truncado, tiene disponibilidad
   ambigua o no coincide con el calendario esperado.
9. Repetir el preflight y activar sólo con autorización explícita. Crear la
   primera pre-reserva ficticia después del nuevo corte y validar el mismo ID a
   través del ciclo.

Si se confirmó un calendario incorrecto **antes de activar**, no ejecutar
**Sincronizar ahora**: desconectar y repetir OAuth. Si ya hubo escrituras, pausar
y conservar el mismo alcance hasta drenar; no forzar el retarget ni eliminar
eventos anteriores.
