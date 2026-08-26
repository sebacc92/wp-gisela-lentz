# Recovery de WhatsApp Coexistence

Este runbook cubre únicamente el mecanismo periódico que recupera trabajo
pendiente de:

- `process-whatsapp-coexistence`;
- `process-whatsapp-automation-outbox`.

No configura Meta, no ejecuta Embedded Signup, no conecta un número y no llama
directamente a Graph. Al activarlo sí puede procesar backlog productivo que ya
exista, por lo que la activación requiere un preflight explícito.

## Arquitectura inerte

La migración
`20260826160000_whatsapp_recovery_schedule.sql` instala `pg_cron`, `pg_net`,
las funciones postgres-only y dos tablas privadas:

- `private.whatsapp_recovery_config`: estado y referencias por UUID a Vault;
- `private.whatsapp_recovery_http_attempts`: resultado HTTP sanitizado.

La migración deja `enabled = false`. No crea jobs, no crea secretos, no ejecuta
`net.http_post` y no contiene un bloque de autoactivación. Por eso un
`supabase db reset`, un seed o la aplicación aislada de la migración no deben
generar tráfico hacia producción.

La activación posterior crea exactamente estos jobs:

| Job                                   | Frecuencia  | Processor                            |
| ------------------------------------- | ----------- | ------------------------------------ |
| `whatsapp-coexistence-recovery`       | cada minuto | `process-whatsapp-coexistence`       |
| `whatsapp-automation-outbox-recovery` | cada minuto | `process-whatsapp-automation-outbox` |

Cada tick resuelve su credencial por UUID desde Vault, valida el job y el
destino canónico y encola un POST asíncrono mediante `pg_net`. Los processors
siguen siendo la autoridad para claims, leases, idempotencia, orden y backoff;
el cron no modifica esas colas directamente.

## Límite de seguridad de la API

Las ACL de `pg_net` y `pg_cron` son administradas por la plataforma Supabase y
no constituyen el límite de autorización de este diseño. La seguridad efectiva
requiere simultáneamente que:

- `net`, `cron`, `private` y `vault` no estén entre los schemas expuestos por
  PostgREST;
- ninguna de las funciones de recovery se publique en un schema expuesto;
- las funciones dentro de `private` sigan revocadas para los roles de API,
  concedidas sólo a `postgres` y verificando `session_user = 'postgres'`.

En este repositorio, `[api].schemas` de `supabase/config.toml` debe permanecer
limitado a `public` y `graphql_public`. La configuración remota de **Exposed
schemas** debe coincidir. La presencia de permisos administrados por Supabase
sobre objetos de una extensión no autoriza a agregar sus schemas a PostgREST.

## Credenciales dedicadas

Recovery no reutiliza las credenciales internas normales. Hay dos pares
independientes; dentro de cada par el valor de Edge y el de Vault debe ser
idéntico:

| Processor         | Supabase Edge secret                         | Nombre en Vault                              |
| ----------------- | -------------------------------------------- | -------------------------------------------- |
| Coexistence       | `WHATSAPP_COEXISTENCE_RECOVERY_SECRET`       | `whatsapp_coexistence_recovery_secret`       |
| Automation outbox | `WHATSAPP_AUTOMATION_OUTBOX_RECOVERY_SECRET` | `whatsapp_automation_outbox_recovery_secret` |

Los dos valores deben:

- generarse criptográficamente;
- tener al menos 32 bytes;
- ser distintos entre sí;
- ser distintos de `WHATSAPP_COEXISTENCE_INTERNAL_SECRET` y
  `AUTOMATION_INTERNAL_SECRET`;
- no contener saltos de línea.

Vault también requiere `whatsapp_recovery_project_url`. Es un marcador de
destino, no una credencial: debe contener únicamente el endpoint canónico del
proyecto que la migración valida. No se permite una URL configurable o un
dominio alternativo.

Nunca escribir valores sensibles en una migración, el SQL editor, argumentos
de shell, logs, documentación ni `cron.job.command`. Cargar cada valor mediante
el gestor de Edge Secrets y la interfaz segura de Vault, o mediante un cliente
parametrizado aprobado. `supabase secrets list` sólo permite verificar nombres
y digests; no permite recuperar un valor existente. Si el valor original ya no
está disponible, hay que rotar el par de manera controlada.

## Preflight de activación

Antes de activar:

1. Confirmar el proyecto remoto y que la migración `20260826160000` esté
   aplicada.
2. Verificar en `supabase/config.toml` y en la configuración API remota que
   `net`, `cron`, `private` y `vault` no aparezcan en **Exposed schemas**. Si
   cualquiera aparece, detenerse antes de cargar credenciales o activar jobs.
3. Confirmar que las versiones nuevas de ambos processors estén desplegadas y
   acepten `x-recovery-secret` sin haber eliminado el flujo interno existente.
4. Confirmar por nombre que existen los dos Edge secrets y los tres registros
   de Vault. No consultar ni imprimir sus valores.
5. Verificar que no existan jobs activos y que la configuración siga inerte:

   ```sql
   select private.whatsapp_recovery_schedule_status();

   select jobid, jobname, schedule, active, database, username
   from cron.job
   where jobname in (
     'whatsapp-coexistence-recovery',
     'whatsapp-automation-outbox-recovery'
   );
   ```

   El estado esperado antes de la primera activación es `enabled = false`,
   `configuredJobs = 0`, `activeJobs = 0`, `matchingJobs = 0` y
   `configurationConsistent = true`.

6. Medir el backlog sin modificarlo:

   ```sql
   select
     'coexistence' as queue,
     status,
     count(*) as row_count,
     count(*) filter (
       where status = 'pending' and available_at <= clock_timestamp()
     ) as due,
     count(*) filter (
       where status = 'processing'
         and lease_expires_at <= clock_timestamp()
     ) as stale_leases
   from public.whatsapp_coexistence_events
   group by status

   union all

   select
     'automation_outbox',
     status,
     count(*),
     count(*) filter (
       where status = 'pending' and available_at <= clock_timestamp()
     ),
     count(*) filter (
       where status = 'processing'
         and lease_expires_at <= clock_timestamp()
     )
   from public.whatsapp_automation_dispatches
   group by status
   order by queue, status;
   ```

   Si aparece trabajo no esperado, detenerse. Activar recovery puede ejecutar
   ese backlog y, en el caso del outbox, continuar automatizaciones que tengan
   efectos externos válidos.

## Activación explícita

La única activación admitida es la función postgres-only:

```sql
select private.install_whatsapp_recovery_schedule();
```

La función valida extensiones, worker de `pg_net`, registros únicos de Vault,
longitud y separación de credenciales, destino y definición exacta de los
jobs. Reemplaza transaccionalmente sólo los dos nombres administrados y habilita
la configuración al final. Si una validación falla, la transacción no debe
dejar una activación parcial.

No llamar manualmente a `private.invoke_whatsapp_recovery(...)` para sustituir
este paso. Después del `install`, verificar:

```sql
select private.whatsapp_recovery_schedule_status();

select jobid, jobname, schedule, active, database, username
from cron.job
where jobname in (
  'whatsapp-coexistence-recovery',
  'whatsapp-automation-outbox-recovery'
)
order by jobname;
```

El resultado esperado es `enabled = true`, `configuredJobs = 2`,
`activeJobs = 2`, `matchingJobs = 2` y `configurationConsistent = true`, ambos
jobs con frecuencia `* * * * *`.

## Observabilidad

`cron.job_run_details` confirma que PostgreSQL ejecutó el comando del job. La
respuesta HTTP es asíncrona y se confirma separadamente mediante
`private.whatsapp_recovery_http_attempts`.

Antes de leer los resultados, reconciliar respuestas disponibles:

```sql
select private.capture_whatsapp_recovery_responses();
```

Consultar sólo las columnas sanitizadas:

```sql
select
  request_id,
  processor,
  requested_at,
  response_observed_at,
  status_code,
  timed_out,
  outcome,
  error_code,
  sanitized_summary
from private.whatsapp_recovery_http_attempts
order by request_id desc
limit 30;
```

Resultados posibles:

- `success`: HTTP 200, contrato válido, `processed = true` y `failed = 0`;
- `processor_error`: el processor respondió pero reportó fallos de items;
- `http_error`: status HTTP distinto de 200;
- `invalid_response`: el body no cumple el contrato esperado;
- `timeout` o `network_error`: no se obtuvo una respuesta válida;
- `response_missing`: no apareció una respuesta dentro de 15 minutos;
- `pending`: request reciente todavía no reconciliado.

Para revisar la ejecución SQL sin exponer comandos ni credenciales:

```sql
select
  run.jobid,
  job.jobname,
  run.status,
  run.start_time,
  run.end_time
from cron.job_run_details run
join cron.job job on job.jobid = run.jobid
where job.jobname in (
  'whatsapp-coexistence-recovery',
  'whatsapp-automation-outbox-recovery'
)
order by run.runid desc
limit 30;
```

No consultar ni copiar `net.http_request_queue.headers`,
`net._http_response.headers`, bodies crudos o comandos completos. La cola de
`pg_net` contiene temporalmente `x-recovery-secret`; la auditoría privada existe
para evitar esa exposición.

## Aceptación: tres ciclos completos

Un ciclo completo es un tick de cada job con su respuesta HTTP ya capturada.
No declarar recovery operativo por la mera existencia de los jobs.

Después de activar, observar tres ciclos consecutivos por processor. Como la
respuesta del último tick puede capturarse en el siguiente, ejecutar
`capture_whatsapp_recovery_responses()` después de esperar su respuesta y luego
medir desde `activated_at`:

```sql
with activation as (
  select activated_at
  from private.whatsapp_recovery_config
  where id = true
)
select
  attempt.processor,
  count(*) filter (where attempt.outcome <> 'pending') as completed_cycles,
  count(*) filter (where attempt.outcome = 'success') as successful_cycles,
  count(*) filter (
    where attempt.outcome not in ('pending', 'success')
  ) as failed_cycles,
  max(attempt.requested_at) as last_requested_at,
  max(attempt.response_observed_at) as last_observed_at
from private.whatsapp_recovery_http_attempts attempt
cross join activation
where attempt.requested_at >= activation.activated_at
group by attempt.processor
order by attempt.processor;
```

Los criterios de aceptación son, para ambos processors:

1. Ciclo 1: autenticación y conectividad correctas, con `outcome = success`.
2. Ciclo 2: un nuevo request ID, sin duplicar el anterior y sin fallos del
   processor.
3. Ciclo 3: otro resultado exitoso; trabajo futuro o con backoff no fue
   adelantado y no aparecieron leases inesperados.

En la consulta agregada deben verse al menos tres ciclos completos, todos
exitosos y cero fallidos por processor. `claimed = 0` es un resultado válido si
no había backlog. Si un ciclo falla, no esperar indefinidamente al siguiente:
aplicar el rollback, conservar la evidencia sanitizada y diagnosticar.

Durante estos tres ciclos no ejecutar Embedded Signup, no cambiar Meta, no
conectar el número real y no lanzar pruebas que llamen a Graph.

## Rollback operativo exacto

El rollback normal es idempotente y postgres-only:

```sql
select private.uninstall_whatsapp_recovery_schedule();
```

La función toma el mismo lock que los invocadores, valida los IDs y la firma
completa de ambos jobs, los desprograma y deja `enabled = false` dentro de una
única transacción. Si detecta drift, aborta sin perder los IDs de configuración
ni borrar un job desconocido. Sólo administra:

- `whatsapp-coexistence-recovery`;
- `whatsapp-automation-outbox-recovery`.

No elimina Vault, auditoría, tablas, extensiones ni trabajo pendiente. Una
segunda ejecución válida debe devolver cero jobs removidos.

Verificar inmediatamente:

```sql
select private.whatsapp_recovery_schedule_status();

select count(*) as remaining_jobs
from cron.job
where jobname in (
  'whatsapp-coexistence-recovery',
  'whatsapp-automation-outbox-recovery'
);
```

El resultado esperado es `enabled = false`, cero jobs configurados/activos y
`remaining_jobs = 0`.

Un request que `pg_net` ya hubiera enviado no puede retirarse. Esperar al menos
el timeout HTTP configurado, capturar nuevamente y revisar pendientes:

```sql
select private.capture_whatsapp_recovery_responses();

select processor, count(*) as pending_responses
from private.whatsapp_recovery_http_attempts
where outcome = 'pending'
group by processor;
```

No borrar las credenciales durante el rollback inicial: preservarlas permite
diagnóstico y reactivación controlada. Si se autoriza retirar recovery de forma
definitiva, eliminar exclusivamente los dos Edge secrets y sus dos entradas
dedicadas de Vault sólo después de confirmar cero jobs y cero requests
pendientes. La eliminación estructural debe hacerse con una migración nueva.

## Prohibiciones

- No provisionar los secretos dedicados ni permitir una activación exitosa
  desde una migración, seed, test, CI, `db reset` o entorno local. Los tests
  pueden comprobar que `install_whatsapp_recovery_schedule()` falla cerrado
  cuando Vault está vacío.
- No crear jobs equivalentes desde Dashboard ni programar invocaciones
  duplicadas.
- No activar antes de desplegar ambos processors y provisionar sus pares de
  credenciales.
- No reutilizar, rotar ni borrar innecesariamente los secretos internos
  existentes.
- No poner secretos en SQL literal, argumentos de CLI, shell history, logs,
  documentación, fixtures o archivos versionados.
- No consultar o exportar headers/bodies crudos de `pg_net`.
- No agregar `net`, `cron`, `private` o `vault` a los schemas expuestos por
  PostgREST y no tratar las ACL administradas de extensiones como barrera de
  seguridad.
- No exponer el schema `private` ni conceder estas funciones a `service_role`,
  `authenticated` o `anon`.
- No usar `migration repair`, no editar una migración ya aplicada y no alterar
  manualmente el historial.
- No truncar colas, auditoría, eventos, outbox, effects ni mensajes como parte
  del rollback.
- No eliminar `pg_cron`, `pg_net` o Vault: son extensiones compartibles.
- No usar recovery para simular webhooks, reintentar masivamente filas fallidas
  o eludir `available_at`, leases, backoff o límites de intentos.
- No modificar Meta, ejecutar Embedded Signup, conectar el número real ni
  llamar a Graph como parte de este procedimiento.
