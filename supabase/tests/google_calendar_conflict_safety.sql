\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(58);

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
  clock_timestamp() + interval '6 days',
  clock_timestamp() + interval '6 days 60 minutes',
  'confirmed', 'manual', 'particular', 60, 'confirmed'
);

create temporary table safety_fixture as
select (
  ((current_date + 10)::text || ' 15:00')::timestamp
  at time zone (select timezone from public.app_settings where id = true)
) as free_slot,
(
  ((current_date + 11)::text || ' 14:00')::timestamp
  at time zone (select timezone from public.app_settings where id = true)
) as cancelled_slot,
(
  ((current_date + 12)::text || ' 14:00')::timestamp
  at time zone (select timezone from public.app_settings where id = true)
) as expired_slot,
(
  ((current_date + 13)::text || ' 14:00')::timestamp
  at time zone (select timezone from public.app_settings where id = true)
) as generation_slot;

do $calendar_connect_a$
declare
  oauth_attempt record;
  candidate_id uuid;
begin
  perform public.create_google_calendar_oauth_state(
    '97000000-0000-4000-8000-000000000001', repeat('d', 64),
    repeat('v', 64), clock_timestamp() + interval '10 minutes'
  );
  select * into oauth_attempt
  from public.consume_google_calendar_oauth_state(repeat('d', 64));
  select candidate.candidate_id into candidate_id
  from public.stage_google_calendar_connection_candidate(
    '97000000-0000-4000-8000-000000000001',
    'google-user-safety', 'safety@example.test',
    'fake-refresh-token-for-safety-test',
    oauth_attempt.connection_generation,
    oauth_attempt.oauth_attempt_generation
  ) candidate;
  perform 1 from public.get_google_calendar_connection_candidate_secret(
    '97000000-0000-4000-8000-000000000001'
  );
  perform public.finalize_google_calendar_connection_selection(
    '97000000-0000-4000-8000-000000000001',
    candidate_id,
    'calendar-A', 'Gisela Lentz · Turnos',
    'America/Argentina/Buenos_Aires'
  );
end;
$calendar_connect_a$;
delete from public.google_calendar_sync_jobs;

create temporary table safety_generation as
select connection_generation as generation
from public.google_calendar_connections where id = true;

create temporary table safety_sync_window as
select bounds.starts_at,
       bounds.starts_at + interval '21 days' as ends_at
from (
  select (
    (((current_date - 1)::text || ' 00:00')::timestamp)
      at time zone (select timezone from public.app_settings where id = true)
  ) as starts_at
) bounds;

do $complete_initial_import$
declare
  generation bigint;
  lease uuid;
  coverage_starts_at timestamptz;
  coverage_ends_at timestamptz;
begin
  select safety_generation.generation into generation from safety_generation;
  select starts_at, ends_at
  into coverage_starts_at, coverage_ends_at
  from safety_sync_window;
  if not public.approve_google_calendar_first_import(
    '97000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'expected first import approval';
  end if;
  select lease_token into lease
  from public.begin_google_calendar_inbound_sync(
    generation, 600, 2, coverage_starts_at, coverage_ends_at
  );
  if lease is null then raise exception 'expected initial import lease'; end if;
  if not public.complete_google_calendar_inbound_sync(
    generation, lease, 'sync-token-safety', '{}'::jsonb, 0,
    2, coverage_starts_at, coverage_ends_at
  ) then
    raise exception 'expected initial import completion';
  end if;
end;
$complete_initial_import$;

create temporary table safety_automation as
select public.activate_google_calendar_automation(
  safety_generation.generation
) as epoch
from safety_generation;

create temporary table safety_lease as
select lease.lease_token
from safety_generation, lateral public.begin_google_calendar_inbound_sync(
  safety_generation.generation, 600, 2,
  (select starts_at from safety_sync_window),
  (select ends_at from safety_sync_window)
) lease;

-- ---------------------------------------------------------------------------
-- Observación: distinguir un push pendiente de una edición externa
-- ---------------------------------------------------------------------------

-- La app movió el turno y todavía no lo proyectó: Google refleja EXACTAMENTE
-- lo último que enviamos. No hay nada externo que preservar.
insert into public.google_calendar_sync_jobs (
  appointment_id, operation, desired_version, status, attempts, available_at,
  connection_generation, google_event_id, google_etag,
  projected_operation, projected_starts_at, projected_ends_at,
  automation_epoch, authorized_google_account_id,
  authorized_google_calendar_id, authorized_connection_generation,
  projection_stage, projected_stage
)
select '97000000-0000-4000-8000-000000000004', 'upsert', 2, 'pending', 0,
       clock_timestamp(), safety_generation.generation,
       'gl' || replace('97000000-0000-4000-8000-000000000004', '-', ''),
       '"etag-1"', 'upsert',
       appointment.starts_at - interval '3 hours',
       appointment.ends_at - interval '3 hours',
       automation.epoch, 'google-user-safety', 'calendar-A',
       safety_generation.generation, 'confirmed', 'confirmed'
from safety_generation, safety_automation automation,
     public.appointments appointment
where appointment.id = '97000000-0000-4000-8000-000000000004';

select is(
  (
    select public.observe_google_calendar_managed_event(
      safety_generation.generation, safety_lease.lease_token,
      'gl' || replace('97000000-0000-4000-8000-000000000004', '-', ''),
      '97000000-0000-4000-8000-000000000004', false,
      appointment.starts_at - interval '3 hours',
      appointment.ends_at - interval '3 hours',
      clock_timestamp(), '"etag-1"', automation.epoch, 'confirmed', true
    )
    from safety_generation, safety_lease, safety_automation automation,
      public.appointments appointment
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
  '"etag-1"',
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
      clock_timestamp(), '"etag-remoto-2"', automation.epoch, 'confirmed', false
    )
    from safety_generation, safety_lease, safety_automation automation,
      public.appointments appointment
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
      5, safety_generation.generation, 2
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
      5, safety_generation.generation, 2
    ) job
  ),
  1,
  'resuelto el conflicto, la reproyección vuelve a estar disponible'
);

-- Aunque haya un upsert pendiente, un ETag remoto distinto demuestra que
-- Google cambió desde la última versión confirmada. El push debe quedar
-- retenido para no pisar título, estado u otros metadatos ajenos.
update public.google_calendar_sync_jobs job
set status = 'pending',
    attempts = 0,
    processing_started_at = null,
    operation = 'upsert',
    google_etag = '"etag-metadata-base"',
    projected_operation = 'upsert',
    projected_starts_at = appointment.starts_at,
    projected_ends_at = appointment.ends_at
from public.appointments appointment
where job.appointment_id = appointment.id
  and appointment.id = '97000000-0000-4000-8000-000000000004';

select is(
  (
    select public.observe_google_calendar_managed_event(
      safety_generation.generation, safety_lease.lease_token,
      'gl' || replace('97000000-0000-4000-8000-000000000004', '-', ''),
      '97000000-0000-4000-8000-000000000004', false,
      appointment.starts_at, appointment.ends_at,
      clock_timestamp(), '"etag-metadata-remoto"',
      automation.epoch, 'confirmed', false
    )
    from safety_generation, safety_lease, safety_automation automation,
      public.appointments appointment
    where appointment.id = '97000000-0000-4000-8000-000000000004'
  ),
  'conflict_recorded',
  'un ETag distinto con el mismo horario abre conflicto de metadatos'
);

select ok(
  exists (
    select 1 from public.google_calendar_sync_conflicts conflict
    where conflict.appointment_id = '97000000-0000-4000-8000-000000000004'
      and conflict.status = 'pending'
      and conflict.kind = 'metadata_changed'
  )
  and (
    select google_etag = '"etag-metadata-remoto"'
    from public.google_calendar_sync_jobs
    where appointment_id = '97000000-0000-4000-8000-000000000004'
  ),
  'el conflicto conserva la mutación humana y el ETag observado para If-Match'
);

select is(
  (
    select count(*)::integer
    from safety_generation, lateral public.claim_google_calendar_sync_jobs(
      5, safety_generation.generation, 2
    ) job
  ),
  0,
  'el conflicto metadata_changed retiene incluso un upsert ya pendiente'
);

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"97000000-0000-4000-8000-000000000001"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '97000000-0000-4000-8000-000000000001', true);

select throws_ok(
  format(
    'select public.apply_google_calendar_conflict(%L)',
    (select id from public.google_calendar_sync_conflicts where status = 'pending')
  ),
  '55000',
  'GOOGLE_CALENDAR_METADATA_CONFLICT_REQUIRES_RESTORE',
  'metadata_changed no puede aplicarse como fecha o cancelación implícita'
);

select is(
  (select status from public.google_calendar_sync_conflicts where kind = 'metadata_changed'),
  'pending',
  'rechazar apply deja el conflicto de metadatos pendiente para decisión explícita'
);

select lives_ok(
  format(
    'select public.reject_google_calendar_conflict(%L)',
    (select id from public.google_calendar_sync_conflicts where status = 'pending')
  ),
  'restaurar desde agenda resuelve el conflicto metadata_changed'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

-- Un evento activo sin ETag no habilita PATCH sin precondición, aun cuando su
-- horario coincida con una proyección local completa y conocida.
update public.google_calendar_sync_jobs job
set status = 'pending', processing_started_at = null,
    operation = 'upsert', google_etag = '"etag-before-missing"',
    projected_operation = 'upsert',
    projected_starts_at = appointment.starts_at,
    projected_ends_at = appointment.ends_at
from public.appointments appointment
where job.appointment_id = appointment.id
  and appointment.id = '97000000-0000-4000-8000-000000000004';

select is(
  (
    select public.observe_google_calendar_managed_event(
      safety_generation.generation, safety_lease.lease_token,
      'gl' || replace('97000000-0000-4000-8000-000000000004', '-', ''),
      '97000000-0000-4000-8000-000000000004', false,
      appointment.starts_at, appointment.ends_at,
      clock_timestamp(), null, automation.epoch, 'confirmed', false
    )
    from safety_generation, safety_lease, safety_automation automation,
      public.appointments appointment
    where appointment.id = '97000000-0000-4000-8000-000000000004'
  ),
  'conflict_recorded',
  'mismo horario sin ETag observado abre conflicto metadata_changed'
);

select ok(
  exists (
    select 1 from public.google_calendar_sync_conflicts conflict
    where conflict.appointment_id = '97000000-0000-4000-8000-000000000004'
      and conflict.status = 'pending'
      and conflict.kind = 'metadata_changed'
  )
  and (
    select google_etag = '"etag-before-missing"'
    from public.google_calendar_sync_jobs
    where appointment_id = '97000000-0000-4000-8000-000000000004'
  ),
  'ETag ausente conserva la precondición local conocida y el conflicto humano'
);

select is(
  (
    select count(*)::integer
    from safety_generation, lateral public.claim_google_calendar_sync_jobs(
      5, safety_generation.generation, 2
    ) claimed
  ),
  0,
  'sin ETag observado no se reclama el PATCH'
);

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"97000000-0000-4000-8000-000000000001"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '97000000-0000-4000-8000-000000000001', true);

select lives_ok(
  format(
    'select public.reject_google_calendar_conflict(%L)',
    (select id from public.google_calendar_sync_conflicts where status = 'pending')
  ),
  'un ADMIN puede decidir restaurar el evento que llegó sin ETag'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

-- Un mapping legado sin ETag o proyección no ofrece una base confiable. Aunque
-- el horario coincida, la primera observación se conserva como conflicto humano
-- y captura el ETag remoto antes de permitir cualquier restauración.
update public.google_calendar_sync_jobs
set status = 'pending', processing_started_at = null,
    operation = 'upsert', google_etag = null,
    projected_operation = null,
    projected_starts_at = null,
    projected_ends_at = null
where appointment_id = '97000000-0000-4000-8000-000000000004';

select is(
  (
    select public.observe_google_calendar_managed_event(
      safety_generation.generation, safety_lease.lease_token,
      'gl' || replace('97000000-0000-4000-8000-000000000004', '-', ''),
      '97000000-0000-4000-8000-000000000004', false,
      appointment.starts_at, appointment.ends_at,
      clock_timestamp(), '"etag-bootstrap-observed"',
      automation.epoch, 'confirmed', false
    )
    from safety_generation, safety_lease, safety_automation automation,
      public.appointments appointment
    where appointment.id = '97000000-0000-4000-8000-000000000004'
  ),
  'conflict_recorded',
  'un evento managed sin baseline local abre conflicto antes de reproyectar'
);

select ok(
  exists (
    select 1 from public.google_calendar_sync_conflicts conflict
    where conflict.appointment_id = '97000000-0000-4000-8000-000000000004'
      and conflict.status = 'pending'
      and conflict.kind = 'metadata_changed'
  )
  and (
    select google_etag = '"etag-bootstrap-observed"'
    from public.google_calendar_sync_jobs
    where appointment_id = '97000000-0000-4000-8000-000000000004'
  ),
  'el bootstrap conserva conflicto y ETag observado para un restore con If-Match'
);

select is(
  (
    select count(*)::integer
    from safety_generation, lateral public.claim_google_calendar_sync_jobs(
      5, safety_generation.generation, 2
    ) claimed
  ),
  0,
  'el upsert bootstrap queda retenido mientras falta decisión humana'
);

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"97000000-0000-4000-8000-000000000001"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '97000000-0000-4000-8000-000000000001', true);

select lives_ok(
  format(
    'select public.reject_google_calendar_conflict(%L)',
    (select id from public.google_calendar_sync_conflicts where status = 'pending')
  ),
  'un ADMIN puede restaurar explícitamente después del bootstrap'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select ok(
  exists (
    select 1
    from safety_generation, safety_lease,
      lateral public.list_google_calendar_full_resync_managed_candidates(
        safety_generation.generation, safety_lease.lease_token, null, 100
      ) candidate
    where candidate.appointment_id = '97000000-0000-4000-8000-000000000004'
      and candidate.google_event_id is not null
      and not candidate.remote_known
  ),
  'el inventario full-resync marca como no confiable un mapping sin proyección'
);

update public.google_calendar_sync_jobs job
set projected_operation = 'upsert',
    projected_starts_at = appointment.starts_at,
    projected_ends_at = appointment.ends_at
from public.appointments appointment
where job.appointment_id = appointment.id
  and appointment.id = '97000000-0000-4000-8000-000000000004';

select ok(
  exists (
    select 1
    from safety_generation, safety_lease,
      lateral public.list_google_calendar_full_resync_managed_candidates(
        safety_generation.generation, safety_lease.lease_token, null, 100
      ) candidate
    where candidate.appointment_id = '97000000-0000-4000-8000-000000000004'
      and candidate.remote_known
  ),
  'mapping más proyección upsert completa se informa como remote_known'
);

select is(
  (
    select count(*)::integer
    from safety_generation, safety_lease,
      lateral public.list_google_calendar_full_resync_managed_candidates(
        safety_generation.generation,
        safety_lease.lease_token,
        '97000000-0000-4000-8000-000000000004',
        100
      ) candidate
  ),
  0,
  'el cursor UUID del inventario es exclusivo y permite terminar la paginación'
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

select public.complete_google_calendar_inbound_sync(
  safety_generation.generation,
  safety_lease.lease_token,
  'sync-token-safety-convertible', '{}'::jsonb, 1,
  2,
  safety_sync_window.starts_at,
  safety_sync_window.ends_at
)
from safety_generation, safety_lease, safety_sync_window;
delete from safety_lease;

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

update public.google_calendar_external_events event
set starts_at = fixture.free_slot + interval '1 hour',
    ends_at = fixture.free_slot + interval '2 hours',
    google_etag = '"etag-bloque-movido"'
from safety_fixture fixture
where event.google_event_id = 'bloque-convertible';

select throws_ok(
  format(
    $sql$select * from public.convert_google_calendar_block_to_appointment(
      'bloque-convertible',
      '97000000-0000-4000-8000-000000000003',
      '97000000-0000-4000-8000-000000000002',
      (select id from public.services where active order by sort_order, name limit 1),
      %L
    )$sql$,
    (select free_slot from safety_fixture)
  ),
  '55000',
  'CALENDAR_BLOCK_STALE',
  'un drawer desactualizado no convierte un bloqueo que Google ya movió'
);

select ok(
  (select status = 'active'
   from public.google_calendar_external_events
   where google_event_id = 'bloque-convertible')
  and not exists (
    select 1 from public.appointments appointment, safety_fixture fixture
    where appointment.professional_id = '97000000-0000-4000-8000-000000000002'
      and appointment.starts_at in (
        fixture.free_slot, fixture.free_slot + interval '1 hour'
      )
  ),
  'el rechazo stale conserva bloqueo y no crea ningún turno'
);

update public.google_calendar_external_events event
set starts_at = fixture.free_slot,
    ends_at = fixture.free_slot + interval '60 minutes',
    google_etag = '"etag-bloque"'
from safety_fixture fixture
where event.google_event_id = 'bloque-convertible';

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
  'el bloqueo queda vinculado al turno y el evento original permanece registrado'
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

insert into safety_lease (lease_token)
select lease.lease_token
from safety_generation, lateral public.begin_google_calendar_inbound_sync(
  safety_generation.generation, 600, 2,
  (select starts_at from safety_sync_window),
  (select ends_at from safety_sync_window)
) lease;

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

-- Si el turno adoptante se cancela o vence antes de exportarse, el evento
-- manual sigue siendo responsabilidad del cleanup por ID. Hasta que Google
-- confirme el borrado, el `converted` continúa cerrando el horario.
update public.app_settings set deposit_enabled = true where id = true;

select public.apply_google_calendar_external_event(
  safety_generation.generation, safety_lease.lease_token,
  'bloque-cancelado-sin-mapping', 'block', false,
  'PRUEBA CANCELADO SIN MAPPING', safety_fixture.cancelled_slot,
  safety_fixture.cancelled_slot + interval '60 minutes',
  false, false, null, '"etag-cancelado-manual"', clock_timestamp()
) from safety_generation, safety_lease, safety_fixture;

select public.complete_google_calendar_inbound_sync(
  safety_generation.generation,
  safety_lease.lease_token,
  'sync-token-safety-cancelled', '{}'::jsonb, 1,
  2,
  safety_sync_window.starts_at,
  safety_sync_window.ends_at
)
from safety_generation, safety_lease, safety_sync_window;
delete from safety_lease;

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"97000000-0000-4000-8000-000000000001"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '97000000-0000-4000-8000-000000000001', true);

create temporary table safety_cancel_conversion as
select conversion.appointment_id
from safety_fixture, lateral public.convert_google_calendar_block_to_appointment(
  'bloque-cancelado-sin-mapping',
  '97000000-0000-4000-8000-000000000003',
  '97000000-0000-4000-8000-000000000002',
  (select id from public.services where active order by sort_order, name limit 1),
  safety_fixture.cancelled_slot,
  'PRUEBA cancelación antes de cleanup'
) conversion;

select ok(
  exists (
    select 1 from public.appointments appointment, safety_cancel_conversion conversion
    where appointment.id = conversion.appointment_id
      and appointment.status = 'scheduled'
      and appointment.deposit_status = 'pending'
  )
  and not exists (
    select 1 from public.google_calendar_sync_jobs job, safety_cancel_conversion conversion
    where job.appointment_id = conversion.appointment_id
  ),
  'la conversión con seña crea scheduled sin exportarlo prematuramente'
);

update public.appointments appointment
set status = 'cancelled'
from safety_cancel_conversion conversion
where appointment.id = conversion.appointment_id;

select ok(
  not public.appointment_slot_is_available(
    '97000000-0000-4000-8000-000000000002',
    (select cancelled_slot from safety_fixture), 60, null,
    'America/Argentina/Buenos_Aires'
  )
  and exists (
    select 1 from public.google_calendar_external_events
    where google_event_id = 'bloque-cancelado-sin-mapping'
      and status = 'converted'
      and external_cleanup_status = 'pending'
  ),
  'cancelar antes del cleanup no libera mientras el evento manual siga en Google'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select is(
  (select external_cleanup_status
   from public.google_calendar_external_events
   where google_event_id = 'bloque-cancelado-sin-mapping'),
  'pending',
  'cancelar el turno no cambia ni programa el evento manual de Google'
);

select is(
  (select count(*)::integer
   from public.google_calendar_sync_jobs job, safety_cancel_conversion conversion
   where job.appointment_id = conversion.appointment_id),
  0,
  'el turno cancelado convertido no adquiere un evento administrado sustituto'
);

select ok(
  not public.appointment_slot_is_available(
    '97000000-0000-4000-8000-000000000002',
    (select cancelled_slot from safety_fixture), 60, null,
    'America/Argentina/Buenos_Aires'
  )
  and exists (
    select 1 from public.google_calendar_external_events
    where google_event_id = 'bloque-cancelado-sin-mapping'
      and status = 'converted'
      and external_cleanup_status = 'pending'
      and external_cleanup_error is null
  ),
  'el evento manual conservado mantiene el horario bloqueado sin error de cleanup'
);

select * from public.reconcile_google_calendar_sync();

select ok(
  not public.appointment_slot_is_available(
    '97000000-0000-4000-8000-000000000002',
    (select cancelled_slot from safety_fixture), 60, null,
    'America/Argentina/Buenos_Aires'
  )
  and not exists (
    select 1 from public.google_calendar_sync_jobs job,
      safety_cancel_conversion conversion
    where job.appointment_id = conversion.appointment_id
  ),
  'reconciliar repite la política read-only sin liberar ni reproyectar el horario'
);

insert into safety_lease (lease_token)
select lease.lease_token
from safety_generation, lateral public.begin_google_calendar_inbound_sync(
  safety_generation.generation, 600, 2,
  (select starts_at from safety_sync_window),
  (select ends_at from safety_sync_window)
) lease;

select public.apply_google_calendar_external_event(
  safety_generation.generation, safety_lease.lease_token,
  'bloque-hold-vencido', 'block', false,
  'PRUEBA HOLD VENCIDO', safety_fixture.expired_slot,
  safety_fixture.expired_slot + interval '60 minutes',
  false, false, null, '"etag-hold-vencido"', clock_timestamp()
) from safety_generation, safety_lease, safety_fixture;

select public.complete_google_calendar_inbound_sync(
  safety_generation.generation,
  safety_lease.lease_token,
  'sync-token-safety-expired', '{}'::jsonb, 1,
  2,
  safety_sync_window.starts_at,
  safety_sync_window.ends_at
)
from safety_generation, safety_lease, safety_sync_window;
delete from safety_lease;

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"97000000-0000-4000-8000-000000000001"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '97000000-0000-4000-8000-000000000001', true);

create temporary table safety_expired_conversion as
select conversion.appointment_id
from safety_fixture, lateral public.convert_google_calendar_block_to_appointment(
  'bloque-hold-vencido',
  '97000000-0000-4000-8000-000000000003',
  '97000000-0000-4000-8000-000000000002',
  (select id from public.services where active order by sort_order, name limit 1),
  safety_fixture.expired_slot,
  'PRUEBA hold vencido antes de cleanup'
) conversion;

update public.appointments appointment
set hold_expires_at = clock_timestamp() - interval '1 minute'
from safety_expired_conversion conversion
where appointment.id = conversion.appointment_id;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select is(
  (select external_cleanup_status
   from public.google_calendar_external_events
   where google_event_id = 'bloque-hold-vencido'),
  'pending',
  'un hold vencido no habilita escritura ni borrado del evento manual'
);

select ok(
  not public.appointment_slot_is_available(
    '97000000-0000-4000-8000-000000000002',
    (select expired_slot from safety_fixture), 60, null,
    'America/Argentina/Buenos_Aires'
  )
  and (select external_cleanup_status = 'pending'
       from public.google_calendar_external_events
       where google_event_id = 'bloque-hold-vencido'),
  'el hold vencido permanece fail-closed mientras Google no confirma cleanup'
);

select ok(
  (select external_cleanup_status = 'pending'
   from public.google_calendar_external_events
   where google_event_id = 'bloque-hold-vencido')
  and not public.appointment_slot_is_available(
    '97000000-0000-4000-8000-000000000002',
    (select expired_slot from safety_fixture), 60, null,
    'America/Argentina/Buenos_Aires'
  )
  and not exists (
    select 1 from public.google_calendar_sync_jobs job,
      safety_expired_conversion conversion
    where job.appointment_id = conversion.appointment_id
  ),
  'el evento manual sigue bloqueando tras vencer, sin cleanup ni sustituto'
);

-- Un `converted` sólo se omite dentro de su generación. Simula un evento
-- convertido en gen A que Google vuelve a listar al iniciar gen B del mismo
-- calendario: debe reactivarse sin relación ni cleanup heredados.
insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind, status,
  summary, starts_at, ends_at, all_day, recurring, unsupported_reason,
  google_etag, google_updated_at, content_hash, converted_appointment_id,
  external_cleanup_status, external_cleanup_error
)
select 'calendar-A', 'converted-old-generation', generation - 1,
       'block', 'converted', 'PRUEBA CONVERTIDO GENERACIÓN ANTERIOR',
       fixture.generation_slot, fixture.generation_slot + interval '60 minutes',
       false, false, null, '"etag-converted-old"', clock_timestamp(),
       repeat('3', 32), conversion.appointment_id, 'failed', 'OLD_CLEANUP_ERROR'
from safety_generation, safety_fixture fixture, safety_cancel_conversion conversion;

insert into safety_lease (lease_token)
select lease.lease_token
from safety_generation, lateral public.begin_google_calendar_inbound_sync(
  safety_generation.generation, 600, 2,
  (select starts_at from safety_sync_window),
  (select ends_at from safety_sync_window)
) lease;

select is(
  (
    select public.apply_google_calendar_external_event(
      safety_generation.generation, safety_lease.lease_token,
      'converted-old-generation', 'block', false,
      'PRUEBA REAPARECE EN GENERACIÓN NUEVA', safety_fixture.generation_slot,
      safety_fixture.generation_slot + interval '60 minutes',
      false, false, null, '"etag-converted-new"', clock_timestamp()
    )
    from safety_generation, safety_lease, safety_fixture
  ),
  'updated',
  'un converted de otra generación no se saltea al reaparecer en Google'
);

select public.complete_google_calendar_inbound_sync(
  safety_generation.generation,
  safety_lease.lease_token,
  'sync-token-safety-generation', '{}'::jsonb, 1,
  2,
  safety_sync_window.starts_at,
  safety_sync_window.ends_at
)
from safety_generation, safety_lease, safety_sync_window;
delete from safety_lease;

select ok(
  exists (
    select 1
    from public.google_calendar_external_events event, safety_generation
    where event.google_event_id = 'converted-old-generation'
      and event.status = 'active'
      and event.connection_generation = safety_generation.generation
      and event.converted_appointment_id is null
      and event.external_cleanup_status = 'not_required'
      and event.external_cleanup_error is null
      and event.removed_at is null
  )
  and not public.appointment_slot_is_available(
    '97000000-0000-4000-8000-000000000002',
    (select generation_slot from safety_fixture), 60, null,
    'America/Argentina/Buenos_Aires'
  ),
  'la reobservación queda active, current-gen, limpia y bloqueante'
);

-- ---------------------------------------------------------------------------
-- Un conflicto no autoriza por sí solo a borrar en Google
-- ---------------------------------------------------------------------------

-- Se reabre un conflicto sobre el turno, que sigue vivo en la app.
update public.google_calendar_sync_jobs
set google_etag = '"etag-antes-tombstone"'
where appointment_id = '97000000-0000-4000-8000-000000000004';

insert into safety_lease (lease_token)
select lease.lease_token
from safety_generation, lateral public.begin_google_calendar_inbound_sync(
  safety_generation.generation, 600, 2,
  (select starts_at from safety_sync_window),
  (select ends_at from safety_sync_window)
) lease;

select public.observe_google_calendar_managed_event(
  safety_generation.generation, safety_lease.lease_token,
  'gl' || replace('97000000-0000-4000-8000-000000000004', '-', ''),
  '97000000-0000-4000-8000-000000000004', true, null, null,
  clock_timestamp(), '"etag-tombstone"', automation.epoch, null, false
) from safety_generation, safety_lease, safety_automation automation;

select is(
  (select google_etag from public.google_calendar_sync_jobs
   where appointment_id = '97000000-0000-4000-8000-000000000004'),
  '"etag-tombstone"',
  'un tombstone con ETag reemplaza la precondición remota anterior'
);

select public.observe_google_calendar_managed_event(
  safety_generation.generation, safety_lease.lease_token,
  'gl' || replace('97000000-0000-4000-8000-000000000004', '-', ''),
  '97000000-0000-4000-8000-000000000004', true, null, null,
  clock_timestamp(), null, automation.epoch, null, false
) from safety_generation, safety_lease, safety_automation automation;

select is(
  (select google_etag from public.google_calendar_sync_jobs
   where appointment_id = '97000000-0000-4000-8000-000000000004'),
  null,
  'un tombstone sin ETag limpia el If-Match obsoleto antes de restaurar'
);

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
      5, safety_generation.generation, 2
    ) job
    where job.operation = 'delete'
  ),
  0,
  'mientras el turno siga vivo en la app no se reclama ningún delete'
);

-- ---------------------------------------------------------------------------
-- Los eventos convertidos quedan read-only: no hay sustituto ni cleanup
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::integer
   from public.google_calendar_sync_jobs job, safety_conversion conversion
   where job.appointment_id = conversion.appointment_id),
  0,
  'la conversión no crea un evento sustituto administrado'
);

update public.appointments
set status = 'confirmed', deposit_status = 'confirmed', hold_expires_at = null
where id = (select appointment_id from safety_conversion);
select is(
  (select external_cleanup_status
   from public.google_calendar_external_events
   where google_event_id = 'bloque-convertible'),
  'pending',
  'confirmar el turno conserva intacto el evento manual original'
);

select is(
  (select count(*)::integer
   from public.google_calendar_sync_jobs job, safety_conversion conversion
   where job.appointment_id = conversion.appointment_id),
  0,
  'confirmar un turno convertido tampoco habilita su proyección saliente'
);

select * from public.reconcile_google_calendar_sync();

select is(
  (select count(*)::integer
   from public.google_calendar_sync_jobs job, safety_conversion conversion
   where job.appointment_id = conversion.appointment_id),
  0,
  'reconcile mantiene excluido el turno convertido sin duplicar Google'
);

select public.complete_google_calendar_inbound_sync(
  safety_generation.generation,
  safety_lease.lease_token,
  'sync-token-safety-tombstone', '{}'::jsonb, 1,
  2,
  safety_sync_window.starts_at,
  safety_sync_window.ends_at
)
from safety_generation, safety_lease, safety_sync_window;
delete from safety_lease;

select ok(
  (select status = 'converted'
      and external_cleanup_status = 'pending'
      and external_cleanup_error is null
   from public.google_calendar_external_events
   where google_event_id = 'bloque-convertible')
  and not public.appointment_slot_is_available(
    '97000000-0000-4000-8000-000000000002',
    (select free_slot from safety_fixture), 60, null,
    'America/Argentina/Buenos_Aires'
  ),
  'el bloqueo convertido permanece como ocupación read-only, sin cleanup'
);

insert into safety_lease (lease_token)
select lease.lease_token
from safety_generation, lateral public.begin_google_calendar_inbound_sync(
  safety_generation.generation, 600, 2,
  (select starts_at from safety_sync_window),
  (select ends_at from safety_sync_window)
) lease;

-- ---------------------------------------------------------------------------
-- Cambio de cuenta y de calendario
-- ---------------------------------------------------------------------------

-- El tombstone observado arriba confirma que el evento administrado ya no
-- existe. Se completa localmente ese delete antes de desconectar para no
-- violar la barrera DRAIN de una asociación durable.
delete from public.google_calendar_sync_conflicts conflict
where conflict.appointment_id = '97000000-0000-4000-8000-000000000004';
update public.appointments
set status = 'cancelled'
where id = '97000000-0000-4000-8000-000000000004';

do $drain_managed_mapping$
declare
  claimed record;
begin
  select * into claimed
  from safety_generation, lateral public.claim_google_calendar_sync_jobs(
    1, safety_generation.generation, 2
  );
  if claimed.job_id is null then
    raise exception 'expected managed delete claim before disconnect';
  end if;
  if not public.complete_google_calendar_sync_job(
    claimed.job_id,
    claimed.desired_version,
    claimed.google_event_id,
    claimed.connection_generation,
    null,
    claimed.starts_at,
    claimed.ends_at,
    (select epoch from safety_automation),
    'absent'
  ) then
    raise exception 'expected managed delete completion before disconnect';
  end if;
end;
$drain_managed_mapping$;

do $disconnect_account_a$
declare
  generation bigint;
  lease uuid;
begin
  select safety_generation.generation, safety_lease.lease_token
  into generation, lease
  from safety_generation, safety_lease;
  if not public.release_google_calendar_inbound_lease(generation, lease) then
    raise exception 'expected account A lease release';
  end if;
  perform 1 from public.disconnect_google_calendar_with_secrets(
    '97000000-0000-4000-8000-000000000001'
  );
end;
$disconnect_account_a$;

do $calendar_connect_b$
declare
  oauth_attempt record;
  candidate_id uuid;
begin
  perform public.create_google_calendar_oauth_state(
    '97000000-0000-4000-8000-000000000001', repeat('e', 64),
    repeat('v', 64), clock_timestamp() + interval '10 minutes'
  );
  select * into oauth_attempt
  from public.consume_google_calendar_oauth_state(repeat('e', 64));
  select candidate.candidate_id into candidate_id
  from public.stage_google_calendar_connection_candidate(
    '97000000-0000-4000-8000-000000000001',
    'google-user-gisela', 'gisela@example.test',
    'fake-refresh-token-for-account-change',
    oauth_attempt.connection_generation,
    oauth_attempt.oauth_attempt_generation
  ) candidate;
  perform 1 from public.get_google_calendar_connection_candidate_secret(
    '97000000-0000-4000-8000-000000000001'
  );
  perform public.finalize_google_calendar_connection_selection(
    '97000000-0000-4000-8000-000000000001',
    candidate_id,
    'calendar-B', 'Gisela Lentz · Turnos',
    'America/Argentina/Buenos_Aires'
  );
end;
$calendar_connect_b$;

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
