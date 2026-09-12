# Base de datos

Las migraciones versionadas están en `supabase/migrations/`.

## Núcleo

- `profiles`: usuario, rol, estado y capacidad opcional de observador de inbox.
- `contacts`: nombre, teléfono E.164, email opcional, cobertura IOMA/Particular,
  condición de paciente anterior y notas administrativas. Una ficha puede estar
  a cargo de otro contacto (`responsible_contact_id`): así una persona sin
  WhatsApp propio —un hijo, una pareja— tiene su ficha y su historia clínica sin
  mezclarse con las de quien escribe. Un teléfono propio se guarda como
  `alternate_phone_e164`, que nunca se usa para enviar mensajes.
- `conversations`: asignación, modo automático/manual, prioridad, atención y no leídos.
- `messages`: mensajes entrantes/salientes y estados de Meta.
- `professionals`: conserva la estructura existente, con Gisela Lentz como única profesional activa.
- `services`: motivos de turno editables. Su duración histórica se conserva por
  compatibilidad, pero no decide la duración de las reservas de Gisela.
- `availability_rules`, `availability_exceptions`: franjas semanales y bloqueos/aperturas excepcionales.
- `appointments`: `patient_contact_id` indica a quién se atiende cuando no es el
  contacto que gestiona el turno; seña, recordatorios y avisos siguen yendo a
  `contact_id`. Además, turnos con snapshot de cobertura, duración y datos de seña
  informados (monto, alias y titular), vencimiento de la pre-reserva y
  estado/auditoría de la seña, incluido el actor y la versión de política cuando
  la confirmación es automática.
- `automated_deposit_proof_results`: ledger append-only e idempotente que une
  turno, mensaje, hash SHA-256, lectura estructurada, política y resultado de
  cada comprobante procesado automáticamente.
- `automation_sessions`: estado durable del bot.
- `reminders`: cola durable de recordatorios.
- `message_templates`, `quick_replies`: textos configurables.
- `audit_logs`, `webhook_events`: auditoría e idempotencia.
- `odontogram_entries`: historia clínica odontológica por pieza. Append-only y
  sólo accesible por ADMIN. Detalle en [odontograma](odontograma.md).
- `patient_attachments`: índice de radiografías, estudios y documentos. Los
  bytes viven en el bucket privado `patient-attachments`; la tabla sólo guarda
  la ruta, el tipo y quién lo subió. Es información de salud, así que sigue la
  regla del odontograma: **sólo ADMIN**, tanto en la tabla como en el bucket.
  Nada se sirve por URL pública: cada apertura pide una URL firmada de dos
  minutos. Formatos aceptados: JPEG, PNG y PDF, hasta 20 MB.
- `treatment_plan_items`: plan de tratamiento y presupuesto por paciente. Es
  presupuesto, **no** historia clínica: cambia de precio, se reordena y se
  cancela, así que admite UPDATE y DELETE. Sólo ADMIN. Un trigger mantiene
  `completed_at` en línea con el estado. Detalle en [odontograma](odontograma.md).
- `conversation_notes`: notas internas del equipo sobre una conversación. No
  son historia clínica ni viajan por WhatsApp: viven en una tabla propia para
  que ningún flujo de envío pueda confundirlas con un mensaje. Las lee y
  escribe cualquier usuario activo; corregir o borrar queda para quien la
  escribió o para ADMIN. `anon` no tiene permisos, y
  `conversation-notes-isolation-contract.test.ts` falla si alguna Edge Function
  llega a nombrar la tabla.

## Integridad de agenda

`appointments_no_professional_overlap` es una restricción de exclusión GiST
sobre profesional y rango `[starts_at, ends_at)`. Una pre-reserva vigente y un
turno confirmado bloquean el horario. Los RPC de disponibilidad ignoran una
reserva pendiente ya vencida, y la creación limpia/revalida esos registros bajo
el mismo lock antes de insertar. Así el horario vuelve a estar disponible aunque
el cron todavía no haya ejecutado la limpieza.

Los RPC nuevos son:

- `get_available_slots_for_coverage`: calcula horarios con la duración central de
  IOMA o Particular.
- `create_service_appointment`: toma la cobertura del paciente, crea una
  pre-reserva y revalida horario semanal, bloqueos, anticipación, buffer y
  solapamientos antes de insertar.
- `record_deposit_proof`: conserva la asociación manual de un mensaje de
  imagen/documento sin afirmar que el pago sea válido.
- `process_automated_deposit_proof`: RPC exclusiva de `service_role`; bloquea el
  turno exacto, revalida mensaje, contacto, pre-reserva y regla básica, y
  devuelve `confirmed`, `review`, `late` o `already_confirmed`. Exige legibilidad,
  monto exacto y coincidencia de alias o titular; moneda, fecha e identificador
  quedan sólo como datos auxiliares. Compara contra los datos guardados en la
  pre-reserva, registra evidencia y auditoría y es idempotente por mensaje. El
  hash queda para trazabilidad, no como barrera antifraude. Si el archivo llegó
  antes del vencimiento pero terminó de procesarse después, sólo recupera el
  horario cuando todavía está libre.
- `confirm_appointment_deposit`: confirma seña y turno en una acción auditada.
- `merge_patient_records`: une dos fichas administrativas bajo una principal.
  Mueve turnos, mensajes y conversaciones en una sola transacción auditada y
  **no borra** la ficha duplicada: la marca con `merged_into_contact_id`, así
  cualquier referencia histórica sigue resolviendo. Se **niega** si la ficha a
  fusionar tiene asientos en `odontogram_entries`: reasignar historia clínica a
  otro paciente no es una operación administrativa. Como sólo puede haber una
  conversación abierta por contacto, cierra la del duplicado antes de
  reasignarla en lugar de violar el índice. Exige ADMIN.
- `reschedule_service_appointment`: vuelve a tomar la cobertura actual del
  paciente, recalcula la duración y revalida antes de mover el turno. Los
  registros históricos conservan su snapshot de cobertura; una pre-reserva
  pendiente conserva siempre los datos de seña que ya se le informaron al
  paciente.

Los RPC históricos `get_available_slots`, `create_appointment` y `reschedule_appointment` siguen disponibles para la automatización existente. Ahora también validan la agenda en backend. Las reservas y reprogramaciones toman un advisory lock por profesional; junto con la exclusión GiST evita carreras y doble reserva.

`app_settings` centraliza nombre, subtítulo, contacto, zona horaria, duraciones
por cobertura, monto/datos de seña, tiempo de pre-reserva, buffer, anticipación,
mensajes configurables y los switches `ai_enabled`/`ai_media_enabled`. La lectura
de comprobantes requiere ambos, además de
`OPENAI_ADMINISTRATIVE_ENABLED=true` y la automatización global activa. Los datos
que Gisela todavía no informó permanecen vacíos; hoy el email es el único que
sigue así porque el contacto es únicamente por WhatsApp.

## Configuración operativa del consultorio

La migración `20260829120000_gisela_lentz_operational_configuration.sql` carga
las respuestas de Gisela. Es sólo configuración: no toca pacientes, turnos,
conversaciones ni credenciales, y todo puede editarse después desde
**Configuración** sin volver a migrar.

- Dirección, teléfono de WhatsApp e información general del consultorio.
- Horario semanal real en `availability_rules`: lunes 9:30–15, martes
  13:30–17, miércoles 9:30–12 y 16–21, jueves 10–15 y viernes 9:30–11, con
  franjas cada 30 minutos. Las franjas de demostración anteriores quedan
  desactivadas en lugar de borrarse.
- Feriados nacionales pendientes de 2026 y 2027 que caen de lunes a viernes,
  como bloqueos de día completo en `availability_exceptions`. Los puentes
  turísticos se decretan año a año y las vacaciones dependen de Gisela: ambos se
  cargan a mano desde **Configuración → Días y horarios cerrados**.
- Motivos de atención activos: Consulta, Restauraciones, Extracciones,
  Limpieza, Limpieza dental y Ortopedia y ortodoncia. Consulta se reincorporó en
  `20260829234000_add_consulta_service.sql`. Los motivos heredados que Gisela no
  usa quedan desactivados, no eliminados, porque pueden tener turnos asociados.
- IOMA 30 minutos, Particular 60, sin descanso entre pacientes y 12 horas de
  anticipación mínima para reservar.
- El aviso de fuera de horario queda apagado: Gisela responde durante todo el
  día.

Las urgencias no son un motivo reservable. Las agenda y cotiza ella de forma
particular, así que `requiresPriority` en
`supabase/functions/_shared/incoming-message.ts` las deriva a atención manual
con prioridad.

## Seguridad

Todas las tablas tienen RLS. Los operadores leen la información operativa y gestionan conversaciones/turnos mediante políticas o RPC controladas. La configuración estructural solo puede modificarse con rol `ADMIN`. `anon` no tiene permisos sobre datos clínicos u operativos.

`profiles.preserve_inbox_unread` es una capacidad ortogonal al rol: una persona
puede conservar todos los permisos `ADMIN` y, al mismo tiempo, abrir chats sin
poner en cero el contador compartido de no leídos. `mark_conversation_read` lo
impone en backend y el navegador no tiene permiso de actualizar directamente
`conversations.unread_count`. Si otra persona abre el chat normalmente, el
contador compartido sí se limpia; no existe un cursor de lectura por usuario.

## Realtime

La publicación `supabase_realtime` contiene:

- `messages`
- `conversations`
- `appointments`

La UI se actualiza al recibir cambios y no utiliza polling agresivo.

## Seeds

`supabase/seed.sql` usa teléfonos, nombres, servicios y turnos odontológicos ficticios. Incluye un horario ilustrativo local para Gisela. La CLI lo aplica en `supabase db reset`; no debe ejecutarse en producción.
