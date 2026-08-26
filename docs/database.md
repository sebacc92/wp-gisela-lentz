# Base de datos

Las migraciones versionadas están en `supabase/migrations/`.

## Núcleo

- `profiles`: usuario, rol y estado.
- `contacts`: nombre, teléfono E.164, email opcional, cobertura IOMA/Particular,
  condición de paciente anterior y notas administrativas.
- `conversations`: asignación, modo automático/manual, prioridad, atención y no leídos.
- `messages`: mensajes entrantes/salientes y estados de Meta.
- `professionals`: conserva la estructura existente, con Gisela Lentz como única profesional activa.
- `services`: motivos de turno editables. Su duración histórica se conserva por
  compatibilidad, pero no decide la duración de las reservas de Gisela.
- `availability_rules`, `availability_exceptions`: franjas semanales y bloqueos/aperturas excepcionales.
- `appointments`: turnos con snapshot de cobertura y duración, vencimiento de la
  pre-reserva y estado/auditoría de la seña.
- `automation_sessions`: estado durable del bot.
- `reminders`: cola durable de recordatorios.
- `message_templates`, `quick_replies`: textos configurables.
- `audit_logs`, `webhook_events`: auditoría e idempotencia.

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
- `record_deposit_proof`: asocia un mensaje de imagen/documento sin afirmar que
  el pago sea válido ni confirmar automáticamente el turno.
- `confirm_appointment_deposit`: confirma seña y turno en una acción auditada.
- `reschedule_service_appointment`: vuelve a tomar la cobertura actual del
  paciente, recalcula la duración y revalida antes de mover el turno. Los
  registros históricos conservan su snapshot original hasta que se
  reprograman.

Los RPC históricos `get_available_slots`, `create_appointment` y `reschedule_appointment` siguen disponibles para la automatización existente. Ahora también validan la agenda en backend. Las reservas y reprogramaciones toman un advisory lock por profesional; junto con la exclusión GiST evita carreras y doble reserva.

`app_settings` centraliza nombre, subtítulo, contacto, zona horaria, duraciones
por cobertura, monto/datos de seña, tiempo de pre-reserva, buffer, anticipación y
mensajes configurables. Teléfono y email permanecen vacíos mientras no sean
informados.

## Seguridad

Todas las tablas tienen RLS. Los operadores leen la información operativa y gestionan conversaciones/turnos mediante políticas o RPC controladas. La configuración estructural solo puede modificarse con rol `ADMIN`. `anon` no tiene permisos sobre datos clínicos u operativos.

## Realtime

La publicación `supabase_realtime` contiene:

- `messages`
- `conversations`
- `appointments`

La UI se actualiza al recibir cambios y no utiliza polling agresivo.

## Seeds

`supabase/seed.sql` usa teléfonos, nombres, servicios y turnos odontológicos ficticios. Incluye un horario ilustrativo local para Gisela. La CLI lo aplica en `supabase db reset`; no debe ejecutarse en producción.
