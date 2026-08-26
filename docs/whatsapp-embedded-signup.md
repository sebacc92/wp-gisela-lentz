# Embedded Signup v4 para WhatsApp Coexistence

Este documento define el onboarding de un número que ya usa WhatsApp Business
App para que continúe en la app y quede conectado a Cloud API. El único flujo
admitido es Embedded Signup v4 mediante Facebook JavaScript SDK; no se usa un
onboarding alojado por Meta ni se registra el número como si fuera un alta Cloud
API normal.

> **Estado actual:** esta es documentación y preparación local. No se abrió
> Facebook Login, no se intercambió ningún código, no se conectó el número de
> Gisela, no se solicitó una sincronización y no se modificó Meta. La captura
> suministrada muestra `account_update` como **Subscribed**. Esta
> implementación local no hizo llamadas Graph ni cambios en Meta para alterarla;
> la asociación per-WABA se confirmará de forma read-only antes del onboarding.

## Separación de configuración y secretos

El navegador sólo puede recibir configuración pública validada:

- App ID de Meta;
- Configuration ID de Facebook Login for Business v4;
- versión pública del SDK/Graph;
- `featureType = whatsapp_business_app_onboarding`;
- `sessionInfoVersion = 3`;
- identificador, `state`, nonce y expiración del intento creados por el backend.

Aunque App ID y Configuration ID no son secretos, no se aceptan valores
arbitrarios enviados por el navegador. El backend selecciona la configuración
permitida y la asocia al intento administrativo antes de iniciar el SDK.
El frontend no necesita variables `PUBLIC_*`: la acción autenticada `start` de
`whatsapp-embedded-signup` devuelve únicamente esos valores públicos.

Permanecen exclusivamente en backend:

- `META_APP_SECRET`;
- el business integration system user access token de cada cliente;
- credenciales de `service_role` y secretos internos;
- valores descifrados de Supabase Vault;
- el App Access Token efímero utilizado para `debug_token`.

La configuración backend prevista es:

```env
META_APP_ID=
META_EMBEDDED_SIGNUP_CONFIG_ID=
META_APP_SECRET=
WHATSAPP_GRAPH_API_VERSION=v26.0
WHATSAPP_AUTOMATIONS_ENABLED=false
WHATSAPP_EMBEDDED_SIGNUP_ENABLED=false
```

`GET /debug_token` se autentica con un App Access Token de la misma Meta App.
Se genera server-side mediante `GET /oauth/access_token` con `client_id`,
`client_secret` y `grant_type=client_credentials`, se usa sólo de forma
transitoria y nunca llega al navegador ni se persiste. El `input_token`
inspeccionado y todas las operaciones sobre activos son el business integration
system user access token individual obtenido para ese cliente mediante Embedded
Signup. No existe un token global del Tech Provider ni fallback al token legacy.

Ningún código intercambiable, App Secret o access token puede aparecer en
HTML, estado serializado, `localStorage`, `sessionStorage`, query strings de la
aplicación, respuestas al navegador, analytics ni logs. Los logs de llamadas a
Graph deben redactar URL, headers y body sensibles.

`WHATSAPP_AUTOMATIONS_ENABLED` permanece en `false` durante todo el onboarding,
la sincronización y la revisión posterior. Completar Embedded Signup nunca
habilita automatizaciones.

`WHATSAPP_EMBEDDED_SIGNUP_ENABLED` es un kill switch exclusivamente backend y
queda en `false` por defecto. Sólo el literal `true` permite que `start` cree un
intento. `status` expone al navegador únicamente el booleano `enabled`; cuando
es falso la UI no reserva el tombstone, no solicita `start`, no carga el SDK y
no puede ejecutar `FB.login`.

## Flujo navegador y backend

El único punto de entrada de la interfaz es la Edge Function autenticada
`whatsapp-embedded-signup`. Recibe acciones JSON `status`, `start`, `exchange`,
`finish`, `cancel` y `offboard`; ninguna acción acepta App Secret, provider
token o business token desde el navegador.

### 1. Crear un intento

Un administrador autenticado solicita al backend un intento de onboarding. El
backend debe:

1. comprobar el rol `ADMIN` y que no haya otro intento activo o parcial;
2. generar `state` y nonce criptográficamente aleatorios;
3. aplicar rate limit y una expiración breve;
4. persistir sólo hashes cuando no necesite recuperar el valor original;
5. devolver App ID, Configuration ID, intento, `state`, nonce y expiración;
6. registrar auditoría sanitizada, sin códigos ni tokens.

El callback sólo puede consumir ese intento una vez. Cancelar, vencer o terminar
el intento impide reutilizarlo.

### 2. Cargar e iniciar el SDK

El SDK oficial se carga desde:

```text
https://connect.facebook.net/en_US/sdk.js
```

La estructura vigente para Coexistence es:

```js
FB.init({
  appId: APP_ID,
  autoLogAppEvents: true,
  xfbml: true,
  version: "v26.0",
});

FB.login(callback, {
  config_id: CONFIGURATION_ID,
  response_type: "code",
  override_default_response_type: true,
  extras: {
    setup: {},
    featureType: "whatsapp_business_app_onboarding",
    sessionInfoVersion: "3",
  },
});
```

La página general de v4 llama `feature_type` a este concepto, pero el ejemplo
ejecutable específico de Coexistence usa `extras.featureType`. Se sigue ese
ejemplo exacto en camelCase; no se envían ambas variantes.

La versión de Graph debe seguir siendo configuración validada, no una cadena
aportada por el usuario. Embedded Signup v4 y Graph `v26.0` son versiones de
cosas diferentes.

### 3. Validar el evento de sesión

Meta no publica una lista finita de orígenes de `postMessage`; su ejemplo usa
una comprobación de dominio demasiado amplia para una frontera productiva. La
UI mantiene una allowlist exacta y conservadora del origen HTTPS del diálogo
oficial usado por Facebook Login:

```text
https://www.facebook.com
```

No se usa `includes`, `endsWith`, wildcard ni comparación de sufijo. Cualquier
origen nuevo queda rechazado hasta que Meta lo documente y se agregue mediante
un cambio de código y tests. Después se valida además:

- JSON válido y acotado;
- `type = WA_EMBEDDED_SIGNUP`;
- `version = 3` para el FINISH de Coexistence;
- evento incluido en la lista cerrada esperada.

Sólo este evento completa el paso Coexistence:

```text
FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING
```

La carga específica de Coexistence sólo garantiza `data.waba_id`. La carga
genérica puede incluir `phone_number_id`, `business_id` y otros activos, pero
son pistas no confiables hasta verificarlos con Graph. No se exige que esos dos
IDs opcionales estén presentes.

`CANCEL` puede representar abandono (`current_step`) o un error reportado
(`error_code`, `error_message`, `session_id`, `timestamp`). También se rechazan
de forma controlada `ERROR`, versiones desconocidas y cualquier FINISH de otro
tipo. Los ejemplos oficiales de `CANCEL` omiten `version`, por lo que para
cancelación/error se admite ausente o `3`, pero no otro valor. Ninguno avanza el
onboarding.

El código OAuth y el evento de sesión llegan por callbacks distintos, cuyo
orden no está garantizado. Se correlacionan con el mismo intento y la
finalización backend sólo continúa cuando dispone de la evidencia necesaria.
El evento y las marcas de consumo pueden persistirse; el código se transmite de
forma inmediata y nunca se guarda en estado del navegador, tablas ni logs.

Meta no incluye `state`, nonce ni un identificador de sesión de la aplicación
en el FINISH. Por eso la UI reserva una sola apertura de Embedded Signup por
pestaña, incluso después de cancelar o recargar, y fija los mensajes aceptados
al primer `event.source` no nulo de esa sesión. Para reintentar hay que cerrar la
pestaña administrativa y cualquier popup de Meta, y recién entonces abrir el
panel en una pestaña nueva. En `sessionStorage` sólo queda el tombstone literal
no sensible `used`; nunca se guardan IDs, códigos, `state`, nonce ni tokens.

### 4. Intercambiar inmediatamente el código

El callback de `FB.login` entrega `response.authResponse.code`. Meta documenta
una duración de aproximadamente 30 segundos, por lo que el navegador lo envía
inmediatamente en el body de un POST autenticado al backend.

El backend usa una llamada servidor-a-servidor:

```text
GET https://graph.facebook.com/<GRAPH_VERSION>/oauth/access_token
    ?client_id=<APP_ID>
    &client_secret=<APP_SECRET>
    &code=<CODE>
```

La referencia vigente sólo documenta esos tres parámetros; no agrega
`redirect_uri` ni `grant_type`. Su ejemplo todavía muestra `v21.0`, mientras
las demás guías actuales muestran `v26.0`; por eso la versión permanece
configurable y se prueba antes del onboarding real.

Meta documenta el App Secret como parámetro del GET. Esta URL saliente debe
quedar completamente fuera de logs, trazas y errores. La API propia nunca
recibe secretos por query string.

La validación oficial `GET /debug_token` también exige el business token en
`input_token` dentro de la query y el App Access Token de la misma Meta App en
`Authorization`. Estas dos URLs Graph servidor-a-servidor son las únicas excepciones inevitables
a la regla general de no usar secretos en query strings: se construyen sólo en
memoria, no se devuelven ni registran y nunca atraviesan una URL propia o el
navegador. No se sustituuyen por endpoints no documentados.

Antes de intercambiar se verifica expiración, administrador, `state`, nonce y
consumo único. Ante timeout no se reintenta a ciegas: el código puede haberse
consumido. El business token resultante nunca vuelve al navegador.

## Business token en Supabase Vault

Cada cuenta Coexistence conserva en tablas operativas sólo un UUID de referencia
a Vault, nunca el token en texto plano. El diseño debe permitir varios clientes
aunque esta instalación sea inicialmente single-tenant.

La creación, lectura, reemplazo y eliminación se realizan mediante funciones
`SECURITY DEFINER` restringidas a `service_role`, con `search_path` fijo y
permisos revocados para `anon`, `authenticated` y `public`. Las respuestas de
esas funciones no incluyen el secreto descifrado salvo dentro del backend que
realiza la llamada inmediata a Graph.

El token intercambiado se escribe primero como secreto temporal
`whatsapp_embedded_signup_token_<ATTEMPT_UUID>` para correlacionar de forma
segura los dos callbacks, que pueden llegar en cualquier orden. Las tablas sólo
guardan el UUID de ese secreto. Después de validar App ID, permisos y activos,
la finalización transaccional renombra ese mismo secreto al nombre estable de la
cuenta; un intento fallido, cancelado o vencido elimina el secreto temporal.

Reglas de ciclo de vida:

- promover el token temporal sólo después de validar App ID, permisos y activos;
- asociar inequívocamente el UUID de Vault con la cuenta Coexistence;
- promoverlo de forma transaccional y auditar sólo UUID, actor y timestamps;
- exigir offboarding del token activo antes de un nuevo onboarding; esta fase
  no implementa rotación silenciosa de una cuenta conectada;
- usar el token todavía disponible para desuscribir webhooks antes de borrarlo;
- eliminar la referencia y el secreto al completar el offboarding local;
- no modificar todavía el `WHATSAPP_ACCESS_TOKEN` productivo existente.

Borrar un secreto de Vault revoca el acceso de esta aplicación, pero no equivale
a una revocación confirmada dentro de Meta.

Todo acceso productivo a Graph pasa por el resolver único de credenciales por
cuenta. Una conversación/mensaje Coexistence queda ligado a su
`coexistence_account_id`; WABA, teléfono, generación y business token deben
coincidir y el token se lee de Vault sólo server-side. No hay fallback a
`WHATSAPP_PHONE_NUMBER_ID`/`WHATSAPP_ACCESS_TOKEN` si existe una cuenta
administrada o un intento activo. El modo global legacy sólo puede usarse en
una instalación antigua sin ninguna cuenta ni onboarding Coexistence.

## Persistencia y recovery del onboarding

El esquema local separa intentos administrativos de trabajo Graph:

- `whatsapp_embedded_signup_attempts` conserva actor, hashes de `state`/nonce,
  expiración, consumo, activos recibidos y error sanitizado;
- `whatsapp_onboarding_outbox` conserva las operaciones
  `subscribe_app`, `request_contacts_sync`, `request_history_sync` y
  `unsubscribe_app`, con lease, backoff y resultado durable;
- `whatsapp_coexistence_accounts` incorpora portfolio propietario, referencia y
  generación del token, estado de onboarding/suscripción/offboarding, decisión
  de history, deadline y último intento/error.

El secreto usa un nombre estable y no sensible por cuenta:

```text
whatsapp_business_access_token_<ACCOUNT_UUID>
```

La migración no crea business tokens ni secretos por sí sola. El UUID de Vault
se guarda como `business_token_secret_id` sólo durante la finalización backend
autorizada. `anon` y `authenticated` no pueden leerlo ni invocar las funciones
internas.

`onboarding_completed_at` conserva el momento en que el backend recibió el
FINISH oficial y `initial_sync_deadline_at` es exactamente ese valor más 24
horas; la latencia posterior de Graph no extiende la ventana. El estado
`ambiguous` del outbox es terminal y no-retry para una mutación cuyo resultado
Meta no puede confirmarse. El RPC
`begin_whatsapp_coexistence_offboarding(p_account_id, p_admin_user_id,
p_client_scope)` inicia el offboarding sólo para la cuenta y el ámbito
administrativo esperados, sin borrar contactos, conversaciones ni mensajes
importados.

## Validación server-side de activos

El backend no confía en los IDs del `postMessage`. Hace dos inspecciones reales
y separadas mediante `debug_token`: una inmediatamente después del intercambio
(`post_exchange`, incluso si FINISH todavía no llegó) y otra justo antes de
confirmar la cuenta (`pre_completion`). No se duplican filas de auditoría para
simular dos llamadas. Ambas persisten server-side `is_valid`, App ID, scopes,
granular scopes, target IDs, expiraciones y fecha de validación; nunca el token.

Con el business token nuevo ejecuta, en orden:

1. `GET /<GRAPH_VERSION>/debug_token?input_token=<BUSINESS_TOKEN>` usando un App
   Access Token efímero de la misma app, generado server-side con App ID y App
   Secret. Exige `is_valid`, App ID exacto, permisos esperados y la WABA recibida
   en `granular_scopes[].target_ids`.
2. `GET /<GRAPH_VERSION>/<WABA_ID>?fields=owner_business_info`. Si el evento
   incluyó `business_id`, debe coincidir con el portfolio propietario.
3. `GET /<GRAPH_VERSION>/<WABA_ID>/phone_numbers`, siguiendo toda la paginación.
   Debe obtenerse un único teléfono compatible; un `phone_number_id` opcional
   del evento debe pertenecer a esa lista.
4. `GET /<GRAPH_VERSION>/<PHONE_NUMBER_ID>?fields=id,display_phone_number,is_on_biz_app,platform_type`.
   Coexistence exige `is_on_biz_app = true` y `platform_type = CLOUD_API`.

El manifest no confiable del navegador se canonicaliza y se limita a 100 IDs
agregados/16 KiB; si incluye `waba_ids`, debe incluir también la WABA principal.
Esos IDs quedan sólo como evidencia de auditoría: no reemplazan las consultas
server-side anteriores.

Se bloquea el flujo ante token inválido, App ID inesperado, permisos faltantes,
WABA diferente, más de un teléfono ambiguo o teléfono fuera de la WABA. App ID
se prueba mediante `debug_token`; Meta no devuelve Configuration ID, por lo que
éste se controla enlazándolo al intento creado por el backend.

Después del onboarding, la siguiente validación se agenda como máximo cada 24
horas y siempre antes del menor `expires_at`/`data_access_expires_at`, con margen
de seguridad. Un error de autenticación Graph pausa sólo esa cuenta, agenda una
inspección inmediata y conserva Vault y datos. Una operación crítica usa la
metadata fresca o falla cerrado mientras el job real de revalidación resuelve el
estado; nunca registra una validación ficticia basada sólo en cache.

## Suscribir la aplicación

Una vez validados WABA y teléfono:

```text
POST /<GRAPH_VERSION>/<WABA_ID>/subscribed_apps
Authorization: Bearer <BUSINESS_TOKEN>
```

La respuesta esperada es `{ "success": true }`. Un GET al mismo edge debe
confirmar que el App ID esperado aparece en la lista. Una suscripción cubre
todos los números de la WABA.

Meta indica que la suscripción se realiza una vez, pero no documenta una clave
de idempotencia para el POST. La recuperación consulta antes y después; encontrar
la aplicación ya suscripta se considera éxito, sin repetir la mutación.

### No registrar el número

El flujo estándar de Embedded Signup usa `/<PHONE_NUMBER_ID>/register`, pero la
guía específica de WhatsApp Business App Coexistence ordena omitir ese paso: el
número ya está registrado. Este onboarding **nunca** llama `/register`, no crea
un PIN y no intenta migrar el número fuera de WhatsApp Business App.

## Contactos, historial y ventana de 24 horas

Al completar la validación y la suscripción, el backend abre una generación
local independiente por stream e inicia automáticamente ambas operaciones que
correspondan. No depende de que el administrador pulse otro botón horas después.

Contactos:

```http
POST /<GRAPH_VERSION>/<PHONE_NUMBER_ID>/smb_app_data
Authorization: Bearer <BUSINESS_TOKEN>
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "sync_type": "smb_app_state_sync"
}
```

Historial, sólo cuando la decisión explícita del intento actual es `accepted`:

```json
{
  "messaging_product": "whatsapp",
  "sync_type": "history"
}
```

Con decisión `declined` no se crea generación ni job y no se llama a este
endpoint. Si se registró `accepted` pero la empresa no compartió el historial
en WhatsApp Business App, la respuesta de aceptación no garantiza datos y Meta
puede enviar un webhook `history` con error `2593109`.

Cada onboarding nuevo empieza con history desmarcado. La decisión `accepted` de
una cuenta anterior se muestra como estado histórico, pero nunca se reutiliza
como consentimiento para otra incorporación: hace falta una nueva acción
afirmativa del administrador.

Meta permite iniciar cada tipo de sync una sola vez y exige iniciar dentro de
las 24 horas tanto contactos como el historial autorizado. Como la carga FINISH
no incluye un timestamp de
finalización, `onboarding_completed_at` se fija con el reloj backend al recibir
ese evento oficial, antes de la validación server-side. También se persiste
`initial_sync_deadline_at`, exactamente 24 horas después.

Antes de cada llamada se registra durablemente la intención y la generación.
Inmediatamente después de una respuesta válida se guarda `request_id`. El
processor de recovery puede recuperar trabajo que todavía no fue despachado y
reintentar errores inequívocamente recuperables, respetando leases y backoff.

`/smb_app_data` no documenta idempotency key y sólo admite una iniciación. Por
eso un timeout después de enviar la solicitud queda en estado ambiguo y **no se
reintenta a ciegas**: se alerta al administrador, se conserva la evidencia y se
falla cerrado. Inventar un segundo request puede consumir la única oportunidad
o mezclar generaciones.

Los webhooks `history` y `smb_app_state_sync` no devuelven el `request_id` de
`/smb_app_data` ni un identificador de generación. La barrera local sólo puede
autorizar una entrega posterior al despacho y asociarla a la generación abierta;
no puede demostrar criptográficamente qué request la originó. Por eso, si un
onboarding anterior ya llegó a despachar history, una nueva incorporación con
history aceptado queda bloqueada para revisión manual en vez de arriesgar la
mezcla de historiales. Rechazar history evita la nueva solicitud.

Para contactos tampoco existe correlación protocolaria y la metadata causal de
cada contacto puede representar cambios anteriores. No se usa ese timestamp
como barrera artificial porque podría descartar tombstones legítimos. En un
re-onboarding, una entrega excepcionalmente tardía de la generación anterior
podría introducir un contacto obsoleto que aún no exista en la nueva foto. Ese
caso debe mantenerse con automatizaciones y envíos pausados y reconciliarse
manualmente antes de habilitar producción; no se inventa una correlación que
Meta no suministra.

Si se pierde la ventana, la guía de Meta exige desconectar/cancelar el registro
y completar Embedded Signup nuevamente. No se crea una segunda generación
contra la misma alta para simular que todavía está dentro del plazo.

## Suscripciones de webhook

Coexistence requiere que el callback pueda procesar:

- `messages`;
- `history`;
- `smb_app_state_sync`;
- `smb_message_echoes`;
- `account_update`.

Las cuatro primeras ya forman parte de la preparación existente. La captura
suministrada muestra el campo de App `account_update` como **Subscribed**; esta
fase no lo volvió a suscribir ni modificó Meta. Esa configuración a nivel App no
reemplaza la asociación por WABA: después del onboarding, el worker debe
confirmar `GET /<WABA_ID>/subscribed_apps` y, sólo si falta esta App, ejecutar y
verificar `POST /<WABA_ID>/subscribed_apps` con el business token de esa cuenta.

## Cancelación y offboarding

### Intento incompleto

Un intento que recibe `CANCEL`, `ERROR` o vence se marca terminal y no puede
reutilizar código, `state` o nonce. Si todavía no se obtuvo token ni se suscribió
la aplicación, la cancelación es exclusivamente local.

### Alta parcial o completada

Un rollback técnico que sólo retira esta integración, sin afirmar que el número
quedó desconectado de Coexistence, sigue este orden:

1. mantener automatizaciones desactivadas y detener nuevos pasos del onboarding;
2. marcar el estado local como offboarding/revisión;
3. si la app quedó suscripta y el token sigue válido, ejecutar y verificar
   `DELETE /<GRAPH_VERSION>/<WABA_ID>/subscribed_apps`;
4. retirar el business token de Vault y su referencia sólo después de terminar
   las operaciones que lo necesiten; si Meta confirma código OAuth `190` o el
   vencimiento local ya es inequívoco, finalizar únicamente la baja local y
   dejar la suscripción remota como desconocida;
5. conservar mensajes importados y auditoría; nunca borrarlos como efecto
   automático del rollback.

`DELETE /subscribed_apps` sólo detiene la suscripción de webhooks. No desconecta
Coexistence y, una vez ejecutado, deja de llegar `account_update` para esa WABA.

Meta no permite usar la API normal de deregistration para un número que está a
la vez en Cloud API y WhatsApp Business App. La desconexión real debe realizarla
el cliente desde:

```text
WhatsApp Business App
→ Ajustes
→ Cuenta
→ Plataforma de WhatsApp Business
→ Desconectar cuenta
```

Para un offboarding remoto completo, la suscripción se conserva hasta que el
cliente haga esa desconexión y el backend reciba `account_update`, incluyendo
`PARTNER_REMOVED` o `ACCOUNT_OFFBOARDED`. Ese lifecycle pausa y bloquea el uso de
la credencial, pero **no la borra automáticamente**: el token y su generación se
conservan en Vault hasta que se determine si el evento es definitivo o
recuperable. Tampoco inventa un DELETE posterior ni afirma que la desuscripción
técnica fue confirmada. `ACCOUNT_RECONNECTED` mantiene envíos pausados, exige
revalidar el token y sólo permite continuar tras una revisión segura. Los datos
importados se conservan en todos estos caminos.

En `PARTNER_REMOVED`, la WABA afectada se toma de `waba_info.waba_id` cuando
Meta la incluye y `disconnection_info` se conserva de forma sanitizada. Los
eventos se deduplican, rechazan conflictos/replays antiguos y sólo pueden
modificar la cuenta que coincide exactamente con esa WABA. Un callback tardío
de Embedded Signup no puede reactivar una cuenta ya desconectada.

La suscripción es WABA-wide. El offboarding local se bloquea si detecta otra
cuenta activa de este mismo ámbito sobre la misma WABA, porque un DELETE
afectaría también a ese número. Esta implementación segura no intenta todavía
desuscribir sólo uno de varios números hermanos.

## Pausas y límites operativos

Crear el intento fuerza `whatsapp_settings.sending_paused = true` dentro de la
misma transacción que inserta el intento y deja auditoría con razón
`COEXISTENCE_ONBOARDING`. La pausa existe antes de abrir el popup, no recién al
completar el alta, y no se libera al cancelar. Esto protege también los envíos
manuales; `WHATSAPP_AUTOMATIONS_ENABLED=false` sigue siendo una barrera
independiente para el bot.

`is_on_biz_app = true` y `platform_type = CLOUD_API` prueban la identidad de
Coexistence. Antes de habilitar envíos reales también debe verificarse el estado
operativo del número (por ejemplo `CONNECTED`) durante la revisión final; el
onboarding no lo usa como sustituto de pertenencia ni activa envíos por sí solo.

El esquema separa tokens y cuentas por `client_scope`, pero esta aplicación
continúa siendo single-tenant: el endpoint usa el scope fijo
`gisela-lentz-wp` y contactos/settings siguen siendo globales. Eso evita mezcla
accidental hoy y permite una evolución futura, pero no debe presentarse como
multitenancy de runtime ya terminada.

## Checklist antes del onboarding real

- [ ] Meta App publicada como Tech Provider y configuración nueva v4 revisada.
- [ ] Dominios permitidos HTTPS y Configuration ID de producción confirmados.
- [ ] Advanced Access vigente para ambos permisos de WhatsApp.
- [ ] App ID/configuración públicos y App Secret backend validados sin logs.
- [ ] `account_update` suscripto en Meta y webhook probado con fixtures seguros.
- [ ] Endpoint ADMIN, rate limit, `state`, nonce, expiración y replay probados.
- [ ] Intercambio dentro de 30 segundos probado únicamente con Graph mockeado.
- [ ] Vault inaccesible para `anon`/`authenticated` y rotación probada localmente.
- [ ] Validación WABA/portfolio/teléfono falla cerrado ante cualquier diferencia.
- [ ] GET/POST de `subscribed_apps` y rollback DELETE probados con mocks.
- [ ] No existe ninguna ruta Coexistence que llame `/<PHONE_NUMBER_ID>/register`.
- [ ] Decisión de compartir history registrada antes de su solicitud.
- [ ] Si existió un onboarding anterior, generaciones de history/contactos y
      cualquier entrega tardía fueron reconciliadas manualmente.
- [ ] Jobs de recovery saludables, sin alterar sus secretos ni frecuencia.
- [ ] `WHATSAPP_AUTOMATIONS_ENABLED=false` confirmado en producción.
- [ ] Backups y conteos pre-onboarding verificados.
- [ ] Operador disponible para observar callbacks, sync, errores y deadline.
- [ ] Número real de Gisela aún desconectado hasta una autorización final.

## Fuentes oficiales de Meta

- [Embedded Signup v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4/)
- [Implementación mediante Facebook JavaScript SDK](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation)
- [Onboarding de usuarios de WhatsApp Business App](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)
- [Onboarding como Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider)
- [Guía de access tokens](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/)
- [App Access Tokens de Meta](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/)
- [Intercambio del código OAuth](https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow#exchangecode)
- [Administrar WABAs compartidas](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-accounts/)
- [Referencia de `debug_token`](https://developers.facebook.com/docs/graph-api/reference/debug_token)
- [Administrar números de teléfono](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-phone-numbers/)
- [Referencia de `subscribed_apps`](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/subscribed-apps-api)
- [Webhook `account_update`](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update/)
- [Reconexión de clientes Coexistence offboarded](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/reconnect-offboarded-coexistence-clients/)
- [Webhook `history`](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/history/)
- [Webhook `smb_app_state_sync`](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_app_state_sync/)
- [Webhook `smb_message_echoes`](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes/)
