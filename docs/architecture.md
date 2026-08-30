# Arquitectura

## Alcance

La aplicación es single tenant para Gisela Lentz. Conserva una sola profesional
activa y no agrega organizaciones ni billing. Supabase es la fuente de verdad de
contactos, agenda, conversaciones, mensajes y estado de la automatización.

Desde el odontograma también guarda historia clínica. Es el único dato de salud
del sistema y está aislado del resto: tabla propia, sólo ADMIN, append-only y
fuera del alcance de la automatización.

```text
Gisela / navegador
        │ Supabase Auth + RLS + Realtime
        ▼
Qwik en Vercel ───────────────► Supabase Postgres
                                      ▲
                                      │ service key sólo en Edge Functions
Paciente ◄──── WhatsApp Cloud API ◄───┼──► whatsapp-send
    │                                 ├──► whatsapp-webhook
    └─────────────────────────────────┼──► whatsapp-automation
                                      ├──► process-whatsapp-automation-outbox
                                      ├──► process-whatsapp-coexistence
                                      ├──► process-reminders
                                      ├──► whatsapp-health
                                      └──► OpenAI Responses API (opcional)
```

El navegador sólo recibe la URL y la publishable key. Las claves de servicio,
tokens de Meta y secretos internos permanecen en Supabase Edge Functions.

## Responsabilidades

- **Qwik:** Inicio, Agenda, Conversaciones, Pacientes, Configuración, login y
  estados simples de error/carga/vacío.
- **Postgres:** RLS, servicios, horarios, bloqueos, disponibilidad, concurrencia
  de turnos, sesiones del bot, recordatorios, consentimiento y auditoría.
- **`whatsapp-webhook`:** verifica firma, WABA y Phone Number ID; procesa
  mensajes vivos, pre-pausa todos los ecos manuales confiables del POST y
  captura primero los eventos masivos de Coexistence.
- **`process-whatsapp-coexistence`:** consume con lease/cursor historial,
  contactos sincronizados, ecos manuales y mutaciones; usa RPCs protegidos para
  impedir efectos laterales del flujo inbound/outbound vivo. Cada pasada
  reclama una sola cuenta y agenda otra si encontró trabajo, para drenar varias
  cuentas sin romper el orden de locks ni depender del cron.
- **`whatsapp-send`:** autentica al operador y centraliza política, test mode,
  idempotencia y despacho a Graph.
- **`whatsapp-automation`:** máquina de estados determinista y autoridad única
  para turnos. Sólo para preguntas estrictamente administrativas sobre horarios
  o ubicación puede usar opcionalmente OpenAI con una consulta canónica, sin el
  texto original ni datos del paciente; cada inbound conserva un snapshot y un
  ledger transaccional de efectos para que los retries sean deterministas.
- **`process-whatsapp-automation-outbox`:** reclama con lease las
  automatizaciones aceptadas por el webhook y las reintenta sin perderlas ante
  un fallo parcial.
- **`process-reminders`:** toma recordatorios en forma transaccional, comprueba
  consentimiento/plantilla y evita duplicados.
- **`whatsapp-health`:** valida la pertenencia del número a la WABA, calidad y
  plantillas, y devuelve sólo información no sensible.

## Desacople de Meta

La UI nunca consume el webhook bruto. El adaptador convierte cada evento de Meta
en `contacts`, `conversations` y `messages`. Los cambios de Coexistence se
conservan primero en una cola interna y luego se normalizan sin cambiar las
entidades de agenda, pacientes ni automatización. El detalle está en
[WhatsApp Coexistence](./whatsapp-coexistence.md).

La identidad de WhatsApp es dual. `contacts.whatsapp_user_id` conserva el BSUID
opaco de Meta y es el destinatario preferido; `contacts.phone_e164` es nullable
porque los formatos actuales pueden ocultar el teléfono. No se deriva uno del
otro, y todo alta o reconciliación exige al menos uno de los dos con controles
de unicidad/conflicto.

## Fallas seguras

- Automatizaciones apagadas y test mode activo son los defaults si los flags
  faltan o son inválidos.
- La asistencia con OpenAI nace apagada y exige simultáneamente el kill switch
  global activo, `OPENAI_ADMINISTRATIVE_ENABLED=true`,
  `app_settings.ai_enabled=true`, el modelo fijo esperado, conexión sin pausa y
  una clave backend válida. Los controles se vuelven a leer antes de llamar al
  proveedor y antes de enviar.
- En test mode, un número fuera de la allowlist se bloquea antes de Graph y deja
  auditoría sanitizada.
- Un envío manual reclama la conversación antes de llamar a Meta. Un eco de la
  Business App pre-pausa la conversación antes de cualquier inbound vivo del
  mismo POST, y todo origen automático vuelve a comprobar el modo
  inmediatamente antes de enviar.
- Cada pausa manual registra su origen causal. El ledger de efectos toma un
  lock sobre la conversación antes del commit: si un eco de la app u operador
  ganó la carrera, revierte en la misma transacción cualquier cambio de turno,
  perfil, decisión o sesión. Sólo el aviso de handoff perteneciente al mismo
  inbound puede completar su transición deliberada a modo manual.
- Los webhooks duplicados se resuelven por identificador único; las
  automatizaciones reservan su posición en el outbox dentro del mismo INSERT
  inbound y se activan junto con el cierre del webhook. Una fila outbound
  `pending` nunca se interpreta como aceptación de Meta.
- Si history gana la carrera por un wamid inbound que luego llega como
  `messages`, una promoción transaccional aplica unread/actividad y reserva el
  dispatch exactamente una vez, sin duplicar el mensaje.
- El outbox respeta `whatsapp_ingest_sequence` por conversación; la ejecución
  toma un snapshot bajo lease y persiste decisiones, sesiones y envíos con
  secuencias deterministas. El requeue de un agotamiento reabre de forma
  coordinada dispatch y ejecución, pero no revive ejecuciones exitosas.
- Los lotes masivos usan cursor, lease, backoff y dead letter visible; los
  estados o mutaciones adelantados se reconcilian al aparecer el wamid original.
- Una solicitud de sync que falla antes de producir `request_id` se cierra con
  una falla durable ligada a su generación exacta; una generación vieja no
  puede sobrescribir la nueva.
- WABA o Phone Number ID ajenos no modifican este tenant.
- Los turnos se validan bajo lock y restricción GiST para impedir doble reserva.
- Un error de Meta deja el mensaje en `failed` sin romper la bandeja.
- Orígenes web no autorizados no reciben cabeceras CORS permisivas.
