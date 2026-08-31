# Migración del frontend a Cloudflare Workers

## Alcance de las fases 1, 2A y 2B

La fase 1 preparó el hosting del frontend Qwik para Cloudflare Workers. La fase
2A separa staging y producción, agrega protecciones contra indexación y bloquea
despliegues productivos accidentales. La fase 2B habilita exclusivamente el
primer Worker remoto de staging sobre su hostname estable `workers.dev`; no
autoriza producción, DNS, dominios custom ni cambios del backend o las
integraciones externas.

Arquitectura objetivo inicial:

```text
Navegador
  |
  +-- giselalentz.com.ar
  |     Cloudflare Worker: SSR de /, /login, /app y rutas legales
  |     Cloudflare Static Assets: CSS, JS, imágenes, manifest, robots y sitemap
  |
  +-- Supabase
        Auth + Postgres + RLS + Realtime
        Edge Functions + WhatsApp/Meta
        automatizaciones + outboxes + processors + recovery + jobs
```

El proyecto y el adaptador de Vercel se conservan durante staging, cutover y la
ventana de rollback. Que el build local de Vercel pase no demuestra por sí solo
que el deployment remoto o sus rutas estén operativos; eso se debe comprobar
externamente antes del cutover. La migración no divide rutas ni agrega servicios
de persistencia en Cloudflare.

## Qué se despliega en Cloudflare

- El renderer SSR de Qwik Router.
- La landing pública, el login, el panel y las páginas legales.
- CSS, JavaScript, imágenes, favicon, manifest, `robots.txt` y `sitemap.xml`.
- Headers de seguridad y políticas de caché para las respuestas SSR.

El Worker no contiene APIs de negocio, acceso directo a Postgres, webhook,
colas, cron jobs ni procesamiento de WhatsApp. El navegador conserva la
comunicación directa con Supabase.

## Qué permanece en Supabase

- Auth y manejo de sesiones del panel.
- Postgres, RLS y Realtime.
- Todas las Edge Functions.
- El webhook de WhatsApp Business Platform y su verificación.
- Coexistence, Embedded Signup, automatizaciones, outboxes, processors,
  recovery y jobs.
- Secretos y credenciales de Supabase, Meta, WhatsApp, Google y OpenAI.

No se incorporan D1, KV, R2, Queues, Durable Objects ni Hyperdrive.

## API de Qwik y outputs

El proyecto usa las exportaciones instaladas de Qwik 2 beta:

```ts
import { cloudflarePagesAdapter } from "@qwik.dev/router/adapters/cloudflare-pages/vite";
import { createQwikRouter } from "@qwik.dev/router/middleware/cloudflare-pages";
```

Aunque el destino sea Workers, el adaptador genera un import fijo hacia
`server/entry.cloudflare-pages`, por lo que el entry se llama
`src/entry.cloudflare-pages.tsx`. El build produce:

```text
dist/                         assets y dist/_worker.js
server/                       módulos SSR
dist/.assetsignore            exclusiones de la subida de assets
```

`ASSETS` es el único binding. `run_worker_first` queda en `false`: un archivo
estático existente se sirve primero desde Static Assets y una ruta sin archivo
equivalente llega al Worker SSR. No se habilita `global_fetch_strictly_public`;
Qwik usa el binding `env.ASSETS.fetch()` y no existe un fetch same-zone global.

La fecha `2026-08-31` activa la compatibilidad Node vigente por fecha. No se
agregan flags `nodejs_compat` ni `nodejs_compat_v2`.

## Comandos

```bash
pnpm run test:cloudflare:config
pnpm run build:cloudflare
pnpm run preview:cloudflare
pnpm run deploy:cloudflare:dry
pnpm run deploy:cloudflare:staging:dry
pnpm run test:cloudflare
pnpm run test:cloudflare:remote -- --origin https://<staging>.workers.dev
```

`preview:cloudflare` usa exclusivamente `wrangler.staging.jsonc`, ejecución
local y un archivo de runtime vacío. Los dos comandos `*:dry` generan y validan
los paquetes sin publicarlos. `deploy:cloudflare` es deliberadamente un alias al
dry-run productivo.

Los comandos Cloudflare pasan por wrappers que rechazan argumentos anexados y
fijan explícitamente el entorno Wrangler vacío. Esto impide que
`CLOUDFLARE_ENV` o flags agregados al ejecutar un script cambien el Worker, la
configuración o el tipo de operación previstos.

Los deploys reales existen sólo como comandos explícitos:

```bash
pnpm run deploy:cloudflare:staging
pnpm run deploy:cloudflare:production
```

El deploy productivo pasa por `scripts/deploy-cloudflare-production.mjs`. El
orquestador exige un worktree limpio y la confirmación exacta
`CONFIRM_CLOUDFLARE_PRODUCTION=giselalentz.com.ar`; valida ambas configuraciones,
lint, tests, typechecks, Deno, los builds de Vercel y Cloudflare, los smoke tests
y un dry-run. Repite la comprobación de Git y configuración antes de permitir el
último comando Wrangler. No se debe usar el comando productivo para pruebas.

El deploy de staging pasa por `scripts/deploy-cloudflare-staging.mjs`. Rechaza
argumentos, exige un worktree limpio, valida la configuración, reconstruye el
artefacto, ejecuta un dry-run inmediato y vuelve a comprobar Git antes de usar
exclusivamente `wrangler.staging.jsonc`.

El rollback de hosting sigue disponible con:

```bash
pnpm run deploy:vercel
```

## Variables de build y secretos

Las únicas variables públicas necesarias durante el build web son:

| Nombre                            | Momento       | Destino             |
| --------------------------------- | ------------- | ------------------- |
| `PUBLIC_SUPABASE_URL`             | build de Vite | entorno de build/CI |
| `PUBLIC_SUPABASE_PUBLISHABLE_KEY` | build de Vite | entorno de build/CI |

Son configuración pública que queda incluida en el cliente; la seguridad sigue
dependiendo de Supabase Auth y RLS. No deben convertirse en secretos de
Wrangler.

El Worker de las fases 1, 2A y 2B no requiere variables de runtime ni secrets.
El archivo `config/cloudflare-runtime.env` permanece intencionalmente vacío
para evitar que Wrangler cargue por accidente credenciales locales. Ningún
secreto de Supabase, Meta, WhatsApp, Google u OpenAI se debe copiar a
Cloudflare.

## Headers, caché y observabilidad

- Las respuestas SSR reciben la CSP existente, `Permissions-Policy`,
  `Referrer-Policy`, `X-Content-Type-Options` y `X-Frame-Options` desde el
  Worker.
- `/login`, `/login/*`, `/app` y `/app/*` reciben `private, no-store` y
  `X-Robots-Tag: noindex, nofollow, noarchive`.
- Login y el layout del panel también incluyen metadata robots en el HTML.
- Las páginas SSR públicas usan revalidación conservadora.
- Los bundles con hash bajo `/build/*` y `/assets/*` usan caché larga e
  immutable.
- La observabilidad persistente de Workers queda deshabilitada en estas fases. El
  middleware Qwik instalado puede registrar detalles de errores, por lo que no
  se habilitará hasta revisar y sanitizar esos registros. No se agregó logging
  de URLs, cuerpos, sesiones ni datos del panel.

## Staging

Staging usa un Worker y archivo independientes:

| Entorno    | Configuración            | Worker                     | Superficies públicas         |
| ---------- | ------------------------ | -------------------------- | ---------------------------- |
| Producción | `wrangler.jsonc`         | `gisela-lentz-web`         | sólo Custom Domain           |
| Staging    | `wrangler.staging.jsonc` | `gisela-lentz-web-staging` | hostname workers.dev estable |

Staging no contiene routes, Custom Domains, variables, secretos ni bindings de
persistencia. `workers_dev` está habilitado y `preview_urls` está deshabilitado,
por lo que no existen previews versionadas ni aliases. Un validador fail-closed
comprueba ambos archivos y los scripts de deploy antes de cada build
Cloudflare.

Toda respuesta SSR cuyo hostname no sea exactamente `giselalentz.com.ar`
recibe `X-Robots-Tag: noindex, nofollow, noarchive`. Esto cubre workers.dev,
localhost, hosts temporales y `www`; también cubre cualquier preview si se
habilitara por error en el futuro. El canonical permanece fijo en el apex
productivo. Las rutas `/login*` y `/app*` conservan además
`Cache-Control: private, no-store, max-age=0` en todos los hosts.

La fase 2B no agrega el origen de staging a allowlists externas ni usa cuentas
reales. Antes de cualquier prueba funcional posterior, todo staging debe quedar
protegido por Cloudflare Access sobre **All traffic**. Nunca se debe reutilizar
el dominio canónico para staging.

### Estado remoto observado en la fase 2B

El 2026-08-31 se creó exclusivamente `gisela-lentz-web-staging` en la cuenta
Cloudflare `SEBA`, con hostname estable
`gisela-lentz-web-staging.seba-ad3.workers.dev`. El deployment ID observado es
`8a3f65ad-4b07-4490-8490-1fb5ea243789` y su version ID es
`98b3a053-ed65-4b58-81cf-39ca33a4836d`.

La verificación remota mostró `workers.dev` habilitado, Preview URLs
deshabilitadas, `ASSETS` como único binding y ausencia de routes, Custom
Domains, variables, secrets y persistencia. El Worker productivo
`gisela-lentz-web` no existía en la cuenta al cerrar esta fase. Cloudflare Access
queda pendiente de configuración manual; hasta completarlo no se deben usar
cuentas reales ni probar Supabase productivo desde staging.

Este fue el primer deployment del Worker, por lo que no existe una versión
anterior a la cual volver. Ante un incidente se debe conservar la versión para
diagnóstico y deshabilitar únicamente su hostname `workers.dev`, como se detalla
en el plan de rollback.

Pruebas públicas de la fase 2B:

1. Landing SSR, canonical, headers, caché y `X-Robots-Tag`.
2. Shell público de login y panel, sin credenciales ni datos autenticados.
3. `robots.txt`, `sitemap.xml`, manifest, CSS, JavaScript e imágenes.
4. Confirmación de que los artefactos internos no son descargables.

Pruebas funcionales reservadas para la fase 2C, después de Access y de autorizar
explícitamente las allowlists necesarias:

1. Landing, metadata SEO, assets, rutas legales y vista móvil.
2. Login, logout, persistencia de sesión y todas las subrutas del panel.
3. Auth, consultas RLS, Realtime y Edge Functions desde el navegador.
4. Embedded Signup con el hostname permitido en Meta.
5. Recepción y envío de un mensaje controlado, verificando que el callback
   sigue en Supabase.
6. Headers, caché, ausencia de indexación privada y logs sanitizados.

## Primer staging remoto

Procedimiento de la fase 2B:

1. Revisar y commitear la landing preexistente y la migración. Si comparten
   archivos, usar un checkpoint único coherente en vez de fragmentar hunks, de
   modo que el worktree quede limpio y auditable.
2. Ejecutar localmente tests, build Cloudflare y el dry-run de staging.
3. Confirmar la cuenta Cloudflare objetivo sin cambiar DNS, Custom Domains ni
   configuración productiva.
4. Verificar que el nombre remoto `gisela-lentz-web-staging` esté libre o que el
   Worker preexistente pertenezca inequívocamente a este proyecto. El estado
   remoto siempre se debe volver a consultar; no asumir que coincide con el
   registro histórico de este documento.
5. Autorizar explícitamente `pnpm run deploy:cloudflare:staging`; nunca usar el
   script productivo para crear staging.
6. Registrar el hostname workers.dev estable y confirmar que Preview URLs está
   deshabilitado.
7. Confirmar en Cloudflare que el Worker no tiene routes, Custom Domains,
   variables ni secrets y que `ASSETS` es su único binding. Omitirlos del archivo
   local no elimina estado remoto preexistente.
8. Ejecutar sólo los smoke tests públicos de la fase 2B, sin credenciales.
9. Proteger **All traffic** del Worker de staging con Cloudflare Access antes de
   habilitar pruebas funcionales o cuentas reales. Si falta permiso, completar
   este paso manualmente y posponer esas pruebas.
10. No modificar allowlists de Supabase/Meta, OAuth ni el callback de WhatsApp
    durante la fase 2B.

## Configuración externa pendiente

Nada de esta lista se cambia en las fases 1, 2A ni 2B:

- NIC Argentina: delegación del dominio cuando se autorice el cutover.
- Cloudflare: alta de la zona y nameservers autoritativos.
- Supabase Auth: Site URL canónica.
- Supabase Auth: redirect allowlist con producción, staging autorizado y el
  origen de rollback durante la ventana de transición.
- Supabase Edge Functions: revisar `APP_BASE_URL`.
- Supabase Edge Functions: revisar `APP_ALLOWED_ORIGINS` y mantener ambos
  orígenes durante el rollback.
- Meta: App Domains.
- Meta: allowed domains de Embedded Signup.
- Cloudflare Workers: Custom Domain para `giselalentz.com.ar`.
- Cloudflare: registro DNS proxied para `www` y redirect permanente al apex.
- Cloudflare Access: proteger **All traffic** del Worker de staging antes de
  usar cuentas reales; evaluar por separado una segunda capa futura para
  `/app` y `/app/*` productivos.

La regla externa preferida para `www` es una Cloudflare Single Redirect Rule:

```text
origen: www.giselalentz.com.ar
destino: https://giselalentz.com.ar
status: 301
preservar path: sí
preservar query string: sí
```

La regla requiere que el registro DNS de `www.giselalentz.com.ar` esté proxied
por Cloudflare. No se crea ni modifica DNS desde este repositorio.

En staging, Access debe cubrir **All traffic** del hostname workers.dev. La
configuración manual segura es: Workers & Pages →
`gisela-lentz-web-staging` → Access → **Protect this Worker behind Access** →
**All traffic**; crear una política Allow sólo para miembros autorizados de la
cuenta Cloudflare o emails explícitos, con sesión conservadora y sin Bypass ni
Everyone. En una fase productiva posterior puede evaluarse sólo para `/app` y
`/app/*`; no reemplaza Supabase Auth ni RLS. Ninguna Edge Function ni el webhook
quedan detrás de Cloudflare Access: permanecen en Supabase.

La política de privacidad todavía requiere revisión legal. No corresponde
reemplazar automáticamente la mención a Vercel mientras Vercel y Cloudflare
puedan coexistir para rollback.

## Cutover propuesto

1. Confirmar externamente backups, estado de Supabase, Auth, allowlists, Meta y
   el callback real del webhook.
2. Comprobar remotamente el deployment de Vercel y registrar la configuración
   DNS previa. Un build local exitoso no reemplaza esta prueba.
3. Completar un staging remoto con el mismo artefacto validado localmente.
4. Incorporar el apex a Supabase Auth, CORS y Meta sin retirar todavía el
   origen de rollback.
5. Crear la zona, completar la delegación y verificar certificados.
6. Ejecutar el deploy de Cloudflare sólo con autorización explícita.
7. Asociar el Custom Domain canónico y crear la regla 301 de `www`.
8. Repetir smoke tests, login, panel, Realtime, Edge Functions y un mensaje
   controlado end-to-end.
9. Observar errores y comportamiento funcional durante la ventana acordada.
10. Retirar Vercel de allowlists y actualizar el texto legal sólo después de
    cerrar formalmente el rollback.

Si se confirma que el callback actual de WhatsApp apunta a una Edge Function de
Supabase, no se debe cambiar durante este cutover. Es obligatorio verificar el
callback real y sus suscripciones directamente en Meta antes del cambio DNS;
el repositorio no confirma la configuración remota.

## Rollback

El rollback remoto se debe preparar y probar antes del cutover.

### Rollback del Worker de staging

Antes de reemplazar un staging existente, registrar su version ID activo. Si un
smoke remoto falla de forma importante, crear un deployment de rollback al 100%
de esa versión con el target explícito de staging:

```bash
pnpm exec wrangler rollback <VERSION_ID_ANTERIOR> \
  --config wrangler.staging.jsonc \
  --env "" \
  --name gisela-lentz-web-staging \
  --message "Phase 2B staging rollback after smoke failure" \
  --yes
```

Después se debe volver a consultar el deployment activo y repetir los smoke
tests públicos. Si es el primer deployment y no existe una versión anterior,
no hay rollback de versión: conservar el deployment para diagnóstico y
deshabilitar únicamente su hostname workers.dev desde Workers & Pages →
`gisela-lentz-web-staging` → Settings → Domains & Routes. No borrar producción,
Vercel ni DNS.

### Rollback del cutover productivo

Hay dos alternativas válidas:

### Alternativa 1: dominio aceptado por Vercel

Configurar y verificar `giselalentz.com.ar` como dominio aceptado por el
proyecto Vercel antes del cutover. Registrar la configuración DNS anterior y el
procedimiento exacto para restaurarla. No asumir que el dominio está aceptado
sin comprobarlo en Vercel.

### Alternativa 2: hostname estable de Vercel

Mantener verificado `gisela-lentz-wp.vercel.app` y preparar en Cloudflare una
redirección temporal de emergencia hacia ese hostname. La redirección sólo debe
activarse durante un incidente autorizado; hay que evaluar el cambio visible de
origen, cookies, Auth y allowlists antes de depender de ella. Prepararla con
status temporal 302, preservación de path y query string, y una condición de origen
que no pueda volver a coincidir después del redirect para evitar loops.

Checklist remota obligatoria:

- [ ] La landing de Vercel responde desde el hostname exacto de fallback.
- [ ] El login de Vercel carga y permite una autenticación controlada.
- [ ] El panel de Vercel carga después del login.
- [ ] Auth, RLS, Realtime y Edge Functions de Supabase funcionan desde Vercel.
- [ ] El hostname de fallback registrado coincide exactamente con el deployment
      comprobado.
- [ ] El origen Vercel permanece temporalmente en Auth y CORS.
- [ ] El callback real del webhook fue verificado por separado y sigue en
      Supabase si ésa es su ubicación actual.

Ante un fallo, activar la alternativa preparada, comprobar landing, login,
panel y Supabase, y confirmar que el webhook y los jobs nunca fueron
modificados. Investigar el incidente en staging antes de intentar otro cutover.

El rollback de hosting no requiere migrar ni restaurar la base: todos los datos
y procesos durables permanecen en Supabase durante estas fases.
