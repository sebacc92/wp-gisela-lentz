\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(22);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '97000000-0000-4000-8000-000000000001',
  'safety-admin@example.test', '', 'authenticated', 'authenticated'
);
update public.profiles set role = 'ADMIN', active = true
where id = '97000000-0000-4000-8000-000000000001';

insert into public.professionals (id, name, appointment_duration_minutes, active)
values ('97000000-0000-4000-8000-000000000002', 'Profesional Safety', 30, true);

insert into public.availability_rules (professional_id, weekday, start_time, end_time, slot_minutes)
select '97000000-0000-4000-8000-000000000002', weekday, '08:00', '20:00', 30
from generate_series(0, 6) as weekday;

insert into public.contacts (id, phone_e164, name, coverage)
values (
  '97000000-0000-4000-8000-000000000003', '+5491100009701',
  'Paciente Safety', 'particular'
);

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status
) values (
  '97000000-0000-4000-8000-000000000004',
  '97000000-0000-4000-8000-000000000003',
  '97000000-0000-4000-8000-000000000002',
  clock_timestamp() + interval '40 days',
  clock_timestamp() + interval '40 days 60 minutes',
  'confirmed', 'manual', 'particular', 60, 'confirmed'
);

create temporary table safety_fixture as
select (
  ((current_date + 70)::text || ' 15:00')::timestamp
  at time zone (select timezone from public.app_settings where id = true)
) as free_slot;

select public.complete_google_calendar_connection(
  '97000000-0000-4000-8000-000000000001',
  'google-user-safety', 'safety@example.test', 'calendar-A',
  'Gisela Lentz · Turnos', 'fake-refresh-token-for-safety-test'
);
delete from public.google_calendar_sync_jobs;

create temporary table safety_generation as
select connection_generation as generation
from public.google_calendar_connections where id = true;

create temporary table safety_lease as
select lease.lease_token
from safety_generation, lateral public.begin_google_calendar_inbound_sync(
  safety_generation.generation, 600
) lease;

-- ---------------------------------------------------------------------------
-- Observación: distinguir un push pendiente de una edición externa
-- ---------------------------------------------------------------------------

-- La app movió el turno y todavía no lo proyectó: Google refleja EXACTAMENTE
-- lo último que enviamos. No hay nada externo que preservar.
insert into public.google_calendar_sync_jobs (
  appointment_id, operation, desired_version, status, attempts, available_at,
  connection_generation, google_event_id, google_etag,
  projected_operation, projected_starts_at, projected_ends_at
)
select '97000000-0000-4000-8000-000000000004', 'upsert', 2, 'pending', 0,
       clock_timestamp(), safety_generation.generation,
       'gl' || replace('97000000-0000-4000-8000-000000000004', '-', ''),
       '"etag-1"', 'upsert',
       appointment.starts_at - interval '3 hours',
       appointment.ends_at - interval '3 hours'
from safety_generation, public.appointments appointment
where appointment.id = '97000000-0000-4000-8000-000000000004';

select is(
  (
    select public.observe_google_calendar_managed_event(
      safety_generation.generation, safety_lease.lease_token,
      'gl' || replace('97000000-0000-4000-8000-000000000004', '-', ''),
      '97000000-0000-4000-8000-000000000004', false,
      appointment.starts_at - interval '3 hours',
      appointment.ends_at - interval '3 hours',
      clock_timestamp(), '"etag-remoto"'
    )
    from safety_generation, safety_lease, public.appointments appointment
    where appointment.id = '97000000-0000-4000-8000-000000000004'
  ),
  'pending_push',
  'Google refleja lo último proyectado: es nuestro cambio sin enviar, no un conflicto'
);

select is(
  (
    select count(*)::integer from public.google_calendar_sync_conflicts
    where status = 'pending'
  ),
  0,
  'un push pendiente no abre un conflicto fantasma'
);

select is(
  (
    select google_etag from public.google_calendar_sync_jobs
    where appointment_id = '97000000-0000-4000-8000-000000000004'
  ),
  '"etag-remoto"',
  'la observación guarda el ETag para que el próximo push use If-Match'
);

-- Un tercer horario, que no es ni el de la app ni el último proyectado.
select is(
  (
    select public.observe_google_calendar_managed_event(
      safety_generation.generation, safety_lease.lease_token,
      'gl' || replace('97000000-0000-4000-8000-000000000004', '-', ''),
      '97000000-0000-4000-8000-000000000004', false,
      appointment.starts_at + interval '5 hours',
      appointment.ends_at + interval '5 hours',
      clock_timestamp(), '"etag-remoto-2"'
    )
    from safety_generation, safety_lease, public.appointments appointment
    where appointment.id = '97000000-0000-4000-8000-000000000004'
  ),
  'conflict_recorded',
  'una edición externa real sí abre un conflicto'
);

-- ---------------------------------------------------------------------------
-- El push queda retenido mientras el conflicto siga pendiente
-- ---------------------------------------------------------------------------

select is(
  (
    select count(*)::integer
    from safety_generation, lateral public.claim_google_calendar_sync_jobs(
      5, safety_generation.generation
    ) job
  ),
  0,
  'un upsert no se reclama mientras hay un conflicto pendiente: no pisa Google'
);

select ok(
  (
    select starts_at = observed_starts_at
    from public.appointments appointment,
      public.google_calendar_sync_conflicts conflict
    where appointment.id = '97000000-0000-4000-8000-000000000004'
      and conflict.appointment_id = appointment.id
      and conflict.status = 'pending'
  ),
  'el turno del paciente no se movió: la propuesta quedó guardada aparte'
);

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"97000000-0000-4000-8000-000000000001"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '97000000-0000-4000-8000-000000000001', true);

select lives_ok(
  format(
    'select public.reject_google_calendar_conflict(%L)',
    (select id from public.google_calendar_sync_conflicts where status = 'pending')
  ),
  'una persona ADMIN puede rechazar la propuesta externa'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select is(
  (
    select count(*)::integer
    from safety_generation, lateral public.claim_google_calendar_sync_jobs(
      5, safety_generation.generation
    ) job
  ),
  1,
  'resuelto el conflicto, la reproyección vuelve a estar disponible'
);

-- ---------------------------------------------------------------------------
-- Convertir un bloqueo en turno dentro de una sola transacción
-- ---------------------------------------------------------------------------

select is(
  (
    select public.apply_google_calendar_external_event(
      safety_generation.generation, safety_lease.lease_token,
      'bloque-convertible', 'block', false, 'Evento sintético convertible',
      safety_fixture.free_slot, safety_fixture.free_slot + interval '60 minutes',
      false, false, null, '"etag-bloque"', clock_timestamp()
    )
    from safety_generation, safety_lease, safety_fixture
  ),
  'created',
  'el bloqueo de partida existe y ocupa el horario'
);

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"97000000-0000-4000-8000-000000000001"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '97000000-0000-4000-8000-000000000001', true);

-- Un servicio inexistente hace fallar la creación DESPUÉS de retirar el
-- bloqueo dentro de la misma transacción: el rollback debe conservarlo.
select throws_ok(
  format(
    $sql$select * from public.convert_google_calendar_block_to_appointment(
      'bloque-convertible',
      '97000000-0000-4000-8000-000000000003',
      '97000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-0000000000ff',
      %L
    )$sql$,
    (select free_slot from safety_fixture)
  ),
  'P0001',
  null,
  'si la creación del turno falla, la conversión no se aplica'
);

select is(
  (
    select status from public.google_calendar_external_events
    where google_event_id = 'bloque-convertible'
  ),
  'active',
  'el bloqueo sobrevive intacto al fallo: nunca se liberó el horario'
);

create temporary table safety_conversion as
select conversion.appointment_id, conversion.created
from safety_fixture, lateral public.convert_google_calendar_block_to_appointment(
  'bloque-convertible',
  '97000000-0000-4000-8000-000000000003',
  '97000000-0000-4000-8000-000000000002',
  (select id from public.services where active order by sort_order, name limit 1),
  safety_fixture.free_slot,
  'Convertido desde Google'
) conversion;

select ok(
  (select created and appointment_id is not null from safety_conversion),
  'la conversión crea el turno con las validaciones normales'
);

select ok(
  (
    select event.status = 'converted'
      and event.converted_appointment_id = conversion.appointment_id
      and event.external_cleanup_status = 'pending'
    from public.google_calendar_external_events event, safety_conversion conversion
    where event.google_event_id = 'bloque-convertible'
  ),
  'el bloqueo queda vinculado al turno y su evento original marcado para retirar'
);

select is(
  (
    select conversion_repeat.appointment_id::text
    from safety_fixture, lateral public.convert_google_calendar_block_to_appointment(
      'bloque-convertible',
      '97000000-0000-4000-8000-000000000003',
      '97000000-0000-4000-8000-000000000002',
      (select id from public.services where active order by sort_order, name limit 1),
      safety_fixture.free_slot
    ) conversion_repeat
  ),
  (select appointment_id::text from safety_conversion),
  'un doble clic devuelve el mismo turno y nunca crea un segundo'
);

select is(
  (
    select count(*)::integer from public.appointments
    where professional_id = '97000000-0000-4000-8000-000000000002'
      and starts_at = (select free_slot from safety_fixture)
  ),
  1,
  'no hay turnos duplicados en el horario convertido'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select is(
  (
    select public.apply_google_calendar_external_event(
      safety_generation.generation, safety_lease.lease_token,
      'bloque-convertible', 'block', false, 'Evento sintético convertible',
      safety_fixture.free_slot, safety_fixture.free_slot + interval '60 minutes',
      false, false, null, '"etag-bloque"', clock_timestamp()
    )
    from safety_generation, safety_lease, safety_fixture
  ),
  'skipped_converted',
  'el siguiente pull no recrea el bloqueo ya convertido'
);

-- ---------------------------------------------------------------------------
-- Un conflicto no autoriza por sí solo a borrar en Google
-- ---------------------------------------------------------------------------

-- Se reabre un conflicto sobre el turno, que sigue vivo en la app.
select public.observe_google_calendar_managed_event(
  safety_generation.generation, safety_lease.lease_token,
  'gl' || replace('97000000-0000-4000-8000-000000000004', '-', ''),
  '97000000-0000-4000-8000-000000000004', true, null, null,
  clock_timestamp(), null
) from safety_generation, safety_lease;

select ok(
  exists (
    select 1 from public.google_calendar_sync_conflicts
    where appointment_id = '97000000-0000-4000-8000-000000000004'
      and status = 'pending' and kind = 'cancellation_requested'
  )
  and not exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '97000000-0000-4000-8000-000000000004'
      and operation = 'delete'
  ),
  'una cancelación pedida desde Google no genera por sí sola un borrado saliente'
);

select is(
  (
    select count(*)::integer
    from safety_generation, lateral public.claim_google_calendar_sync_jobs(
      5, safety_generation.generation
    ) job
    where job.operation = 'delete'
  ),
  0,
  'mientras el turno siga vivo en la app no se reclama ningún delete'
);

-- ---------------------------------------------------------------------------
-- El cleanup exige el evento sustituto exportado en la conexión vigente
-- ---------------------------------------------------------------------------

select is(
  (
    select count(*)::integer
    from safety_generation, safety_lease,
      lateral public.claim_google_calendar_external_cleanup(
        safety_generation.generation, safety_lease.lease_token, 5
      ) cleanup
  ),
  0,
  'sin el evento del turno exportado todavía no se retira el evento original'
);

-- ---------------------------------------------------------------------------
-- Cambio de cuenta y de calendario
-- ---------------------------------------------------------------------------

select public.complete_google_calendar_connection(
  '97000000-0000-4000-8000-000000000001',
  'google-user-gisela', 'gisela@example.test', 'calendar-B',
  'Gisela Lentz · Turnos', 'fake-refresh-token-for-account-change'
);

select ok(
  not exists (
    select 1 from public.google_calendar_external_events
    where google_calendar_id = 'calendar-A' and status = 'active'
  )
  and exists (
    select 1 from public.google_calendar_external_events
    where google_calendar_id = 'calendar-A' and status in ('superseded', 'converted')
  ),
  'al cambiar de cuenta los bloqueos viejos se desactivan pero se conservan'
);

select is(
  (
    select public.begin_google_calendar_inbound_sync(
      safety_generation.generation, 240
    ) is not null
    from safety_generation
  ),
  null,
  'una ejecución de la generación anterior ya no obtiene lease'
);

select throws_ok(
  format(
    $sql$select public.apply_google_calendar_external_event(
      %s, %L, 'bloque-tardio', 'block', false, 'Escritura tardía',
      now() + interval '80 days', now() + interval '80 days 1 hour',
      false, false, null, null, now()
    )$sql$,
    (select generation from safety_generation),
    (select lease_token from safety_lease)
  ),
  '42501',
  null,
  'una escritura tardía de la ejecución anterior se rechaza'
);

select * from finish();
rollback;
