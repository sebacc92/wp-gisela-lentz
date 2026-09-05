\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(38);

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege('anon', 'public.begin_google_calendar_inbound_sync(bigint,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.begin_google_calendar_inbound_sync(bigint,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.begin_google_calendar_inbound_sync(bigint,integer)', 'EXECUTE'),
  'el pull entrante es exclusivo de service_role'
);

select ok(
  not has_table_privilege('anon', 'public.google_calendar_external_events', 'SELECT')
  and has_table_privilege('authenticated', 'public.google_calendar_external_events', 'SELECT')
  and not has_table_privilege('authenticated', 'public.google_calendar_external_events', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.google_calendar_sync_conflicts', 'UPDATE'),
  'el panel puede leer bloqueos y conflictos pero nunca escribirlos directamente'
);

select ok(
  has_function_privilege('authenticated', 'public.apply_google_calendar_conflict(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.apply_google_calendar_conflict(uuid)', 'EXECUTE'),
  'resolver un conflicto pasa por un RPC autenticado'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '95000000-0000-4000-8000-000000000001',
  'calendar-bidi-admin@example.test', '', 'authenticated', 'authenticated'
);
update public.profiles set role = 'ADMIN', active = true
where id = '95000000-0000-4000-8000-000000000001';

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '95000000-0000-4000-8000-000000000009',
  'calendar-bidi-operator@example.test', '', 'authenticated', 'authenticated'
);
update public.profiles set role = 'OPERADOR', active = true
where id = '95000000-0000-4000-8000-000000000009';

insert into public.professionals (id, name, appointment_duration_minutes, active)
values ('95000000-0000-4000-8000-000000000002', 'Profesional Bidireccional', 30, true);

insert into public.availability_rules (professional_id, weekday, start_time, end_time, slot_minutes)
select '95000000-0000-4000-8000-000000000002', weekday, '08:00', '20:00', 30
from generate_series(0, 6) as weekday;

insert into public.contacts (id, phone_e164, name, coverage)
values (
  '95000000-0000-4000-8000-000000000003', '+5491100009501',
  'Paciente Bidireccional', 'particular'
);

create temporary table calendar_fixture as
select
  (
    ((current_date + 60)::text || ' 15:00')::timestamp
    at time zone (select timezone from public.app_settings where id = true)
  ) as free_slot,
  (
    ((current_date + 61)::text || ' 09:00')::timestamp
    at time zone (select timezone from public.app_settings where id = true)
  ) as appointment_start;

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status
)
select
  '95000000-0000-4000-8000-000000000004',
  '95000000-0000-4000-8000-000000000003',
  '95000000-0000-4000-8000-000000000002',
  fixture.appointment_start,
  fixture.appointment_start + interval '60 minutes',
  'confirmed', 'manual', 'particular', 60, 'confirmed'
from calendar_fixture fixture;

do $calendar_connect$
declare
  oauth_attempt record;
  candidate_id uuid;
begin
  perform public.create_google_calendar_oauth_state(
    '95000000-0000-4000-8000-000000000001', repeat('c', 64),
    repeat('v', 64), clock_timestamp() + interval '10 minutes'
  );
  select * into oauth_attempt
  from public.consume_google_calendar_oauth_state(repeat('c', 64));
  select candidate.candidate_id into candidate_id
  from public.stage_google_calendar_connection_candidate(
    '95000000-0000-4000-8000-000000000001',
    'google-user-bidi', 'bidi@example.test',
    'fake-refresh-token-for-bidirectional-test',
    oauth_attempt.connection_generation,
    oauth_attempt.oauth_attempt_generation
  ) candidate;
  perform 1 from public.get_google_calendar_connection_candidate_secret(
    '95000000-0000-4000-8000-000000000001'
  );
  perform public.finalize_google_calendar_connection_selection(
    '95000000-0000-4000-8000-000000000001',
    candidate_id,
    'calendar-id-bidi', 'Gisela Lentz · Turnos',
    'America/Argentina/Buenos_Aires'
  );
end;
$calendar_connect$;

-- La conexión encola una proyección para cada turno futuro. El pull ignora un
-- push en vuelo, así que la cola se vacía antes de probar las observaciones.
delete from public.google_calendar_sync_jobs;

create temporary table calendar_generation as
select connection_generation as generation
from public.google_calendar_connections where id = true;

-- ---------------------------------------------------------------------------
-- Lease: una sola ejecución efectiva
-- ---------------------------------------------------------------------------

create temporary table calendar_lease as
select lease.lease_token, lease.sync_token, lease.first_import_approved
from calendar_generation, lateral public.begin_google_calendar_inbound_sync(
  calendar_generation.generation, 240
) lease;

select is(
  (select count(*)::integer from calendar_lease),
  1,
  'la primera ejecución toma el lease de sincronización entrante'
);

select is(
  (
    select count(*)::integer
    from calendar_generation, lateral public.begin_google_calendar_inbound_sync(
      calendar_generation.generation, 240
    ) lease
  ),
  0,
  'una segunda ejecución concurrente no obtiene lease'
);

select ok(
  (select not first_import_approved from calendar_lease)
  and (select sync_token is null from calendar_lease),
  'sin aprobación ADMIN no hay primera importación ni token previo'
);

-- A partir de acá el fixture representa una primera importación aprobada y
-- completa; así las aserciones de disponibilidad miden los eventos importados,
-- no el cierre fail-closed previo al incremental.
select public.approve_google_calendar_first_import(
  '95000000-0000-4000-8000-000000000001'
);
select public.complete_google_calendar_inbound_sync(
  calendar_generation.generation,
  calendar_lease.lease_token,
  'sync-token-bidi-inicial',
  '{}'::jsonb,
  0
) from calendar_generation, calendar_lease;
delete from calendar_lease;
insert into calendar_lease (lease_token, sync_token, first_import_approved)
select lease.lease_token, lease.sync_token, lease.first_import_approved
from calendar_generation, lateral public.begin_google_calendar_inbound_sync(
  calendar_generation.generation, 240
) lease;

-- ---------------------------------------------------------------------------
-- Eventos externos -> bloqueos
-- ---------------------------------------------------------------------------

select is(
  (
    select public.apply_google_calendar_external_event(
      calendar_generation.generation, calendar_lease.lease_token,
      'evento-manual-1', 'block', false, 'Evento sintético de prueba',
      calendar_fixture.free_slot, calendar_fixture.free_slot + interval '60 minutes',
      false, false, null, '"etag-1"', clock_timestamp()
    )
    from calendar_generation, calendar_lease, calendar_fixture
  ),
  'created',
  'un evento externo nuevo se importa como bloqueo'
);

select is(
  (
    select public.apply_google_calendar_external_event(
      calendar_generation.generation, calendar_lease.lease_token,
      'evento-manual-1', 'block', false, 'Evento sintético de prueba',
      calendar_fixture.free_slot, calendar_fixture.free_slot + interval '60 minutes',
      false, false, null, '"etag-1"', clock_timestamp()
    )
    from calendar_generation, calendar_lease, calendar_fixture
  ),
  'unchanged',
  'reprocesar el mismo evento no duplica ni vuelve a escribir'
);

select is(
  (
    select count(*)::integer from public.google_calendar_external_events
    where google_event_id = 'evento-manual-1'
  ),
  1,
  'el bloqueo se identifica por google_event_id, sin duplicados'
);

select ok(
  not exists (
    select 1 from public.appointments where contact_id is null
  )
  and (
    select count(*)::integer from public.appointments
    where professional_id = '95000000-0000-4000-8000-000000000002'
  ) = 1,
  'importar un evento externo no crea pacientes ni turnos'
);

select is(
  (
    select public.appointment_slot_is_available(
      '95000000-0000-4000-8000-000000000002',
      calendar_fixture.free_slot, 30, null, null
    )
    from calendar_fixture
  ),
  false,
  'el bloqueo importado ocupa el horario en la disponibilidad'
);

select is(
  (
    select public.apply_google_calendar_external_event(
      calendar_generation.generation, calendar_lease.lease_token,
      'evento-manual-1', 'block', false, 'Evento sintético movido',
      calendar_fixture.free_slot + interval '2 hours',
      calendar_fixture.free_slot + interval '3 hours',
      false, false, null, '"etag-2"', clock_timestamp()
    )
    from calendar_generation, calendar_lease, calendar_fixture
  ),
  'updated',
  'un cambio en Google actualiza el mismo bloqueo'
);

select is(
  (
    select public.appointment_slot_is_available(
      '95000000-0000-4000-8000-000000000002',
      calendar_fixture.free_slot, 30, null, null
    )
    from calendar_fixture
  ),
  true,
  'al moverse el bloqueo el horario original vuelve a estar libre'
);

select is(
  (
    select public.apply_google_calendar_external_event(
      calendar_generation.generation, calendar_lease.lease_token,
      'evento-manual-1', 'block', true, null, null, null,
      false, false, null, null, clock_timestamp()
    )
    from calendar_generation, calendar_lease
  ),
  'removed',
  'eliminar el evento en Google retira el bloqueo'
);

select is(
  (
    select public.apply_google_calendar_external_event(
      calendar_generation.generation, calendar_lease.lease_token,
      'evento-manual-2', 'unsupported', false, 'Evento repetido sintético',
      null, null, false, true, 'RECURRING', null, clock_timestamp()
    )
    from calendar_generation, calendar_lease
  ),
  'created',
  'un evento recurrente se registra como no soportado sin romper el lote'
);

-- ---------------------------------------------------------------------------
-- Eventos administrados por la app
-- ---------------------------------------------------------------------------

select is(
  (
    select public.observe_google_calendar_managed_event(
      calendar_generation.generation, calendar_lease.lease_token,
      'gl' || replace('95000000-0000-4000-8000-000000000004', '-', ''),
      '95000000-0000-4000-8000-000000000004', false,
      appointment.starts_at, appointment.ends_at, clock_timestamp()
    )
    from calendar_generation, calendar_lease,
      public.appointments appointment
    where appointment.id = '95000000-0000-4000-8000-000000000004'
  ),
  'in_sync',
  'observar el propio push no genera conflicto ni un nuevo push: sin loop'
);

select is(
  (select count(*)::integer from public.google_calendar_sync_jobs),
  0,
  'una observación en sincronía no encola trabajo saliente'
);

select is(
  (
    select public.observe_google_calendar_managed_event(
      calendar_generation.generation, calendar_lease.lease_token,
      'gl' || replace('95000000-0000-4000-8000-000000000004', '-', ''),
      '95000000-0000-4000-8000-000000000004', false,
      appointment.starts_at + interval '2 hours',
      appointment.ends_at + interval '2 hours', clock_timestamp()
    )
    from calendar_generation, calendar_lease,
      public.appointments appointment
    where appointment.id = '95000000-0000-4000-8000-000000000004'
  ),
  'conflict_recorded',
  'mover el evento en Google abre un conflicto pendiente'
);

select ok(
  (
    select appointment.starts_at = fixture.appointment_start
      and appointment.status = 'confirmed'
    from public.appointments appointment, calendar_fixture fixture
    where appointment.id = '95000000-0000-4000-8000-000000000004'
  ),
  'el turno del paciente no se modificó en silencio'
);

select is(
  (
    select public.observe_google_calendar_managed_event(
      calendar_generation.generation, calendar_lease.lease_token,
      'gl' || replace('95000000-0000-4000-8000-000000000004', '-', ''),
      '95000000-0000-4000-8000-000000000004', true, null, null, clock_timestamp()
    )
    from calendar_generation, calendar_lease
  ),
  'conflict_recorded',
  'borrar el evento en Google convierte la propuesta en cancelación pendiente'
);

select is(
  (
    select count(*)::integer from public.google_calendar_sync_conflicts
    where appointment_id = '95000000-0000-4000-8000-000000000004'
      and status = 'pending'
  ),
  1,
  'nunca hay más de un conflicto pendiente por turno'
);

-- ---------------------------------------------------------------------------
-- Cierre de la corrida, token y 410
-- ---------------------------------------------------------------------------

-- La escritura va en su propia sentencia: dentro de un mismo SELECT las
-- subconsultas leen el snapshot previo y no verían el cierre de la corrida.
create temporary table calendar_completion as
select (
  select public.complete_google_calendar_inbound_sync(
    calendar_generation.generation, calendar_lease.lease_token,
    'sync-token-de-prueba',
    jsonb_build_object('blocksImported', 1, 'patientName', 'no debe guardarse'),
    0
  )
  from calendar_generation, calendar_lease
) as completed;

select ok(
  (select completed from calendar_completion)
  and (
    select inbound_sync_token = 'sync-token-de-prueba'
      and inbound_sync_state = 'incremental'
      and last_checked_at is not null
      and last_sync_completed_at is not null
      and last_synced_at is null
      and last_sync_summary = jsonb_build_object('blocksImported', 1)
    from public.google_calendar_connections where id = true
  ),
  'sin cambios igual avanza la última revisión y el resumen queda sanitizado'
);

do $$
declare
  generation bigint;
  lease uuid;
  blocks_before integer;
begin
  select connection_generation into generation
  from public.google_calendar_connections where id = true;
  select count(*)::integer into blocks_before
  from public.google_calendar_external_events;

  select lease_token into lease
  from public.begin_google_calendar_inbound_sync(generation, 240);
  if lease is null then raise exception 'expected a released lease'; end if;

  perform public.invalidate_google_calendar_sync_token(generation, lease);

  if exists (
    select 1 from public.google_calendar_connections
    where id = true
      and (inbound_sync_token is not null
        or inbound_sync_state <> 'full_resync_required')
  ) then
    raise exception 'expired sync token was not invalidated';
  end if;
  if (select count(*)::integer from public.google_calendar_external_events)
     <> blocks_before then
    raise exception 'a 410 destroyed imported mappings';
  end if;
  if not exists (
    select 1 from public.appointments
    where id = '95000000-0000-4000-8000-000000000004' and status = 'confirmed'
  ) then
    raise exception 'a 410 touched a patient appointment';
  end if;
  perform public.release_google_calendar_inbound_lease(generation, lease);
end;
$$;

select pass('un 410 invalida el token y pide full resync sin borrar datos');

-- ---------------------------------------------------------------------------
-- Decisión ADMIN sobre el conflicto
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"95000000-0000-4000-8000-000000000009"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '95000000-0000-4000-8000-000000000009', true);

select throws_ok(
  format(
    'select public.apply_google_calendar_conflict(%L)',
    (select id from public.google_calendar_sync_conflicts where status = 'pending')
  ),
  '42501',
  null,
  'una persona sin rol ADMIN no puede aplicar un cambio venido de Google'
);

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"95000000-0000-4000-8000-000000000001"}', true);
select set_config('request.jwt.claim.sub', '95000000-0000-4000-8000-000000000001', true);

do $$
declare
  conflict_id uuid;
begin
  select id into conflict_id
  from public.google_calendar_sync_conflicts where status = 'pending';
  perform public.reject_google_calendar_conflict(conflict_id);

  if not exists (
    select 1 from public.google_calendar_sync_conflicts
    where id = conflict_id and status = 'rejected' and resolved_at is not null
  ) then raise exception 'conflict was not rejected'; end if;

  if not exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '95000000-0000-4000-8000-000000000004'
      and status = 'pending'
  ) then
    raise exception 'rejecting did not reproject the authoritative state';
  end if;

  if not exists (
    select 1 from public.appointments
    where id = '95000000-0000-4000-8000-000000000004' and status = 'confirmed'
  ) then raise exception 'rejecting changed the appointment'; end if;
end;
$$;

select pass('rechazar conserva el turno y vuelve a proyectar la app sobre Google');

-- ---------------------------------------------------------------------------
-- Aplicar un horario observado fuera de la regla semanal
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '', true);

insert into public.professionals (
  id, name, appointment_duration_minutes, active
) values (
  '95000000-0000-4000-8000-000000000020',
  'Profesional Apply Calendar', 60, true
);

-- El cambio propuesto sera a las 10:30. La regla empieza a las 13:30 para
-- reproducir la configuracion real sin volver reservable ese horario normal.
insert into public.availability_rules (
  professional_id, weekday, start_time, end_time, slot_minutes
)
select
  '95000000-0000-4000-8000-000000000020',
  weekday, '13:30', '17:00', 30
from generate_series(0, 6) as weekday;

insert into public.contacts (id, phone_e164, name, coverage)
values (
  '95000000-0000-4000-8000-000000000021',
  '+5491100009521', 'Paciente Apply Calendar', 'particular'
);

create temporary table calendar_apply_fixture as
select
  (
    ((current_date + 78)::text || ' 14:00')::timestamp
      at time zone (select timezone from public.app_settings where id = true)
  ) as original_start,
  (
    ((current_date + 80)::text || ' 10:30')::timestamp
      at time zone (select timezone from public.app_settings where id = true)
  ) as accepted_start,
  (
    ((current_date + 81)::text || ' 10:30')::timestamp
      at time zone (select timezone from public.app_settings where id = true)
  ) as blocked_start;

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status
)
select
  '95000000-0000-4000-8000-000000000022',
  '95000000-0000-4000-8000-000000000021',
  '95000000-0000-4000-8000-000000000020',
  fixture.original_start, fixture.original_start + interval '60 minutes',
  'confirmed', 'manual', 'particular', 60, 'confirmed'
from calendar_apply_fixture fixture;

-- Igual que el caso de una reconexion: el evento determinista existe en
-- Google, pero esta generacion todavia no tiene baseline saliente.
delete from public.google_calendar_sync_jobs
where appointment_id = '95000000-0000-4000-8000-000000000022';

create temporary table calendar_apply_lease as
select lease.lease_token
from calendar_generation, lateral public.begin_google_calendar_inbound_sync(
  calendar_generation.generation, 600
) lease;

-- El fixture anterior ya verifico el cierre fail-closed de unsupported. Se lo
-- retira para que esta seccion aisle solamente la regla semanal.
update public.google_calendar_external_events
set status = 'removed', removed_at = clock_timestamp()
where google_event_id = 'evento-manual-2' and status = 'active';

select is(
  (
    select public.observe_google_calendar_managed_event(
      calendar_generation.generation,
      calendar_apply_lease.lease_token,
      'gl' || replace('95000000-0000-4000-8000-000000000022', '-', ''),
      '95000000-0000-4000-8000-000000000022', false,
      fixture.accepted_start,
      fixture.accepted_start + interval '60 minutes',
      clock_timestamp(), '"etag-apply-outside-hours"'
    )
    from calendar_generation, calendar_apply_lease,
      calendar_apply_fixture fixture
  ),
  'conflict_recorded',
  'el cambio de Google fuera de la regla semanal abre una revision'
);

select public.complete_google_calendar_inbound_sync(
  calendar_generation.generation,
  calendar_apply_lease.lease_token,
  'sync-token-apply-outside-hours', '{}'::jsonb, 1
)
from calendar_generation, calendar_apply_lease;

select is(
  (
    select public.appointment_slot_is_available(
      '95000000-0000-4000-8000-000000000020',
      fixture.accepted_start, 60,
      '95000000-0000-4000-8000-000000000022',
      (select timezone from public.app_settings where id = true)
    )
    from calendar_apply_fixture fixture
  ),
  false,
  'el horario observado sigue cerrado para una reserva comun'
);

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"95000000-0000-4000-8000-000000000001"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '95000000-0000-4000-8000-000000000001', true);

select lives_ok(
  format(
    'select public.apply_google_calendar_conflict(%L)',
    (
      select id from public.google_calendar_sync_conflicts
      where appointment_id = '95000000-0000-4000-8000-000000000022'
        and status = 'pending'
    )
  ),
  'una ADMIN puede aceptar el horario exacto ya observado en Google'
);

select ok(
  (
    select count(*) = 1
      and bool_and(
        appointment.starts_at = fixture.accepted_start
        and appointment.ends_at = fixture.accepted_start + interval '60 minutes'
        and appointment.status = 'confirmed'
        and appointment.deposit_status = 'confirmed'
        and appointment.duration_minutes = 60
      )
    from public.appointments appointment, calendar_apply_fixture fixture
    where appointment.id = '95000000-0000-4000-8000-000000000022'
  ),
  'apply mueve un unico turno y conserva estado, sena y duracion'
);

select ok(
  exists (
    select 1
    from public.google_calendar_sync_conflicts conflict
    where conflict.appointment_id = '95000000-0000-4000-8000-000000000022'
      and conflict.status = 'applied'
      and conflict.resolved_at is not null
      and conflict.resolved_by = '95000000-0000-4000-8000-000000000001'
  )
  and not exists (
    select 1
    from public.google_calendar_sync_conflicts conflict
    where conflict.appointment_id = '95000000-0000-4000-8000-000000000022'
      and conflict.status = 'pending'
  ),
  'el conflicto queda aplicado por la misma transaccion'
);

select ok(
  (
    select count(*) = 1
      and bool_and(
        job.connection_generation = generation.generation
        and job.operation = 'upsert'
        and job.status = 'pending'
      )
    from public.google_calendar_sync_jobs job, calendar_generation generation
    where job.appointment_id = '95000000-0000-4000-8000-000000000022'
  ),
  'apply deja un solo job en la generacion vigente'
);

create temporary table calendar_apply_job_version as
select desired_version
from public.google_calendar_sync_jobs
where appointment_id = '95000000-0000-4000-8000-000000000022';

select lives_ok(
  format(
    'select public.apply_google_calendar_conflict(%L)',
    (
      select id from public.google_calendar_sync_conflicts
      where appointment_id = '95000000-0000-4000-8000-000000000022'
        and status = 'applied'
    )
  ),
  'repetir el mismo POST confirma el resultado sin volver a mutar'
);

select ok(
  (
    select count(*) = 1
    from public.audit_logs audit
    where audit.action = 'google_calendar.conflict_applied'
      and audit.entity_id = '95000000-0000-4000-8000-000000000022'
  )
  and (
    select job.desired_version = original.desired_version
    from public.google_calendar_sync_jobs job,
      calendar_apply_job_version original
    where job.appointment_id = '95000000-0000-4000-8000-000000000022'
  )
  and not exists (
    select reminder.type
    from public.reminders reminder
    where reminder.appointment_id = '95000000-0000-4000-8000-000000000022'
    group by reminder.type
    having count(*) > 1
  )
  and not exists (
    select 1
    from public.messages message
    where message.contact_id = '95000000-0000-4000-8000-000000000021'
  ),
  'el retry no duplica auditoria, job ni recordatorios, y no envia mensajes'
);

-- Una segunda propuesta colisiona con un bloqueo externo. La excepcion debe
-- revertir tambien cualquier trigger, job o resolucion parcial.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '', true);

delete from calendar_apply_lease;
insert into calendar_apply_lease (lease_token)
select lease.lease_token
from calendar_generation, lateral public.begin_google_calendar_inbound_sync(
  calendar_generation.generation, 600
) lease;

select is(
  (
    select public.apply_google_calendar_external_event(
      calendar_generation.generation,
      calendar_apply_lease.lease_token,
      'manual-block-for-apply-test', 'block', false, 'Bloqueo de prueba',
      fixture.blocked_start, fixture.blocked_start + interval '60 minutes',
      false, false, null, '"etag-manual-block"', clock_timestamp()
    )
    from calendar_generation, calendar_apply_lease,
      calendar_apply_fixture fixture
  ),
  'created',
  'el fixture crea un bloqueo externo en el segundo destino'
);

select is(
  (
    select public.observe_google_calendar_managed_event(
      calendar_generation.generation,
      calendar_apply_lease.lease_token,
      'gl' || replace('95000000-0000-4000-8000-000000000022', '-', ''),
      '95000000-0000-4000-8000-000000000022', false,
      fixture.blocked_start,
      fixture.blocked_start + interval '60 minutes',
      clock_timestamp(), '"etag-apply-blocked"'
    )
    from calendar_generation, calendar_apply_lease,
      calendar_apply_fixture fixture
  ),
  'conflict_recorded',
  'la segunda edicion de Google abre una nueva revision'
);

select public.complete_google_calendar_inbound_sync(
  calendar_generation.generation,
  calendar_apply_lease.lease_token,
  'sync-token-apply-blocked', '{}'::jsonb, 2
)
from calendar_generation, calendar_apply_lease;

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"95000000-0000-4000-8000-000000000001"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '95000000-0000-4000-8000-000000000001', true);

select throws_ok(
  format(
    'select public.apply_google_calendar_conflict(%L)',
    (
      select id from public.google_calendar_sync_conflicts
      where appointment_id = '95000000-0000-4000-8000-000000000022'
        and status = 'pending'
    )
  ),
  'P0001',
  'SLOT_UNAVAILABLE',
  'un bloqueo externo sigue impidiendo aplicar la reprogramacion'
);

select ok(
  (
    select count(*) = 1
      and bool_and(
        appointment.starts_at = fixture.accepted_start
        and appointment.ends_at = fixture.accepted_start + interval '60 minutes'
      )
    from public.appointments appointment, calendar_apply_fixture fixture
    where appointment.id = '95000000-0000-4000-8000-000000000022'
  )
  and exists (
    select 1 from public.google_calendar_sync_conflicts conflict
    where conflict.appointment_id = '95000000-0000-4000-8000-000000000022'
      and conflict.status = 'pending'
  ),
  'una colision deja turno y conflicto completamente intactos'
);

select ok(
  exists (
    select 1 from public.google_calendar_external_events external_event
    where external_event.google_event_id = 'manual-block-for-apply-test'
      and external_event.status = 'active'
  ),
  'el rollback tampoco modifica el bloqueo externo'
);

select * from finish();
rollback;
