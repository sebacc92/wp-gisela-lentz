# Sincronización bidireccional: orden de despliegue

Este documento describe el orden previsto. **Nada de esto se ejecutó todavía.**
El estado remoto (migraciones aplicadas, versiones de Functions, cron) no fue
consultado en esta tarea: figura como **NO VERIFICADO**.

## Orden

1. **Migraciones** (`supabase db push`), en este orden por timestamp:
   - `20260902220000_google_calendar_bidirectional_sync.sql`
   - `20260902230000_manual_deposit_proof_review.sql`
   - `20260903120000_google_calendar_conflict_safety.sql`
   - `20260903130000_deposit_review_hardening.sql`
2. **Edge Functions**: `process-calendar-sync`, `google-calendar-status`,
   `whatsapp-automation`, y por grafo de imports de `_shared/google-calendar.ts`
   también `google-calendar-oauth-start`, `google-calendar-oauth-callback` y
   `google-calendar-disconnect`.
3. **Frontend** (Worker `gisela-lentz-web`).

## Compatibilidad temporal con el runtime anterior

Entre el paso 1 y el paso 2 conviven la base nueva y las Functions viejas. Eso
funciona porque:

- `complete_google_calendar_sync_job` conserva la firma de **4 argumentos** como
  wrapper que delega en la de 7. PostgREST resuelve la sobrecarga por los
  nombres de los argumentos del cuerpo JSON, así que el worker anterior sigue
  cerrando jobs; simplemente no registra ETag ni horario proyectado.
- `observe_google_calendar_managed_event` conserva la firma de **8 argumentos**
  (sin ETag) delegando en la de 9.
- `claim_google_calendar_sync_jobs` agrega la columna `google_etag` al resultado.
  El worker anterior la ignora.
- `google_calendar_status()` agrega columnas; la Function anterior lee sólo las
  que ya conocía.
- `appointment_slot_is_available` incorpora los bloqueos importados. Mientras
  `google_calendar_external_events` esté vacía el comportamiento es idéntico al
  actual.
- Ninguna de las capacidades nuevas se activa sola: el pull entrante exige
  aprobación ADMIN explícita y no hay cron que lo dispare.

**Ventana degradada aceptada**: con la base nueva y el worker viejo, la cola
saliente no guarda `projected_starts_at` ni `google_etag`. Si en esa ventana
alguien editara un evento en Google, el primer pull posterior al deploy de las
Functions lo trataría como conflicto pendiente (no como `pending_push`), que es
el lado seguro: una propuesta para revisar, nunca una escritura silenciosa.

## Primera importación

Sigue requiriendo dos acciones ADMIN separadas y explícitas:

1. **Ver qué hay en Google** — preview de sólo lectura. No toca la cola, no toma
   lease y no escribe ninguna fila.
2. **Habilitar importación** — recién entonces `Sincronizar ahora` trae los
   eventos manuales como bloqueos.

El evento manual preexistente en el calendario de prueba **no se importa** hasta
que se complete el paso 2.

## Cron

No hay ningún job de Calendar en este repositorio. El estado del cron en el
proyecto remoto **no fue verificado**; hay que consultarlo antes de dar por
cerrado el punto.

## Cambio de cuenta (prueba → Gisela)

Al conectar otra cuenta o calendario, un trigger sobre
`google_calendar_connections` desactiva (`status = 'superseded'`) los bloqueos
de la conexión anterior y supersede los conflictos pendientes. **No se borra
ningún evento en Google**: los bloqueos viejos se conservan como historia y
dejan de ocupar la agenda. Reconectar el **mismo** calendario los mantiene
vigentes y sólo actualiza su generación.
