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
- `odontogram_entries`: historia clínica odontológica por pieza. Append-only y
  sólo accesible por ADMIN. Detalle en [odontograma](odontograma.md).

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
mensajes configurables. Los datos que Gisela todavía no informó permanecen
vacíos; hoy el email es el único que sigue así porque el contacto es únicamente
por WhatsApp.

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
`supabase/functions/_shared/incoming-message.ts` las deriva a atención humana
con prioridad, en singular y en plural.

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
