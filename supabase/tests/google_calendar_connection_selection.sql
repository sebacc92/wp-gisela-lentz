\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(58);

select ok(
  not has_table_privilege(
    'anon', 'public.google_calendar_connection_candidates', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'public.google_calendar_connection_candidates', 'SELECT'
  )
  and has_table_privilege(
    'service_role', 'public.google_calendar_connection_candidates', 'SELECT'
  ),
  'el candidato OAuth nunca es visible para roles de navegador'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.get_google_calendar_connection_candidate_secret(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.get_google_calendar_connection_candidate_secret(uuid)',
    'EXECUTE'
  ),
  'el refresh token candidato sólo se obtiene con service_role'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.list_google_calendar_full_resync_managed_candidates(bigint,uuid,uuid,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.list_google_calendar_full_resync_managed_candidates(bigint,uuid,uuid,integer)',
    'EXECUTE'
  ),
  'el inventario managed para full resync sólo es ejecutable por service_role'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

insert into auth.users (id, email, encrypted_password, aud, role)
values
  (
    '9a000000-0000-4000-8000-000000000001',
    'calendar-selection-admin@example.test', '', 'authenticated', 'authenticated'
  ),
  (
    '9a000000-0000-4000-8000-000000000009',
    'calendar-selection-operator@example.test', '', 'authenticated', 'authenticated'
  );
update public.profiles set role = 'ADMIN', active = true
where id = '9a000000-0000-4000-8000-000000000001';

insert into public.professionals (id, name, appointment_duration_minutes, active)
values (
  '9a000000-0000-4000-8000-000000000002',
  'Profesional Calendar Selection', 30, true
);
insert into public.availability_rules (
  professional_id, weekday, start_time, end_time, slot_minutes
)
select '9a000000-0000-4000-8000-000000000002', weekday, '08:00', '20:00', 30
from generate_series(0, 6) weekday;
insert into public.contacts (id, phone_e164, name, coverage)
values (
  '9a000000-0000-4000-8000-000000000003',
  '+5491100009803', 'Paciente Ficticio Calendar Selection', 'particular'
);

-- Aísla el fixture de cualquier turno futuro del seed local.
update public.appointments
set status = 'cancelled'
where status in ('scheduled', 'confirmed');

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status
) values (
  '9a000000-0000-4000-8000-000000000004',
  '9a000000-0000-4000-8000-000000000003',
  '9a000000-0000-4000-8000-000000000002',
  clock_timestamp() + interval '50 days',
  clock_timestamp() + interval '50 days 30 minutes',
  'confirmed', 'manual', 'particular', 30, 'confirmed'
);

create temporary table selection_availability_fixture as
select (
  ((current_date + 75)::text || ' 15:00')::timestamp
  at time zone 'America/Argentina/Buenos_Aires'
) as starts_at;

create temporary table selection_sync_window as
select bounds.starts_at,
       bounds.starts_at + interval '21 days' as ends_at
from (
  select (
    ((current_date + 65)::text || ' 00:00')::timestamp
      at time zone 'America/Argentina/Buenos_Aires'
  ) as starts_at
) bounds;

select public.disconnect_google_calendar(
  '9a000000-0000-4000-8000-000000000001'
);

select public.create_google_calendar_oauth_state(
  '9a000000-0000-4000-8000-000000000001', repeat('a', 64),
  repeat('v', 64), clock_timestamp() + interval '10 minutes'
);
create temporary table stale_oauth_attempt as
select * from public.consume_google_calendar_oauth_state(repeat('a', 64));

select public.create_google_calendar_oauth_state(
  '9a000000-0000-4000-8000-000000000001', repeat('b', 64),
  repeat('v', 64), clock_timestamp() + interval '10 minutes'
);
create temporary table current_oauth_attempt as
select * from public.consume_google_calendar_oauth_state(repeat('b', 64));

select ok(
  (select stale.connection_generation = current.connection_generation
     and current.oauth_attempt_generation > stale.oauth_attempt_generation
   from stale_oauth_attempt stale, current_oauth_attempt current),
  'un nuevo inicio OAuth conserva el scope pero invalida el intento anterior'
);

select throws_ok(
  $$select * from public.stage_google_calendar_connection_candidate(
    '9a000000-0000-4000-8000-000000000001',
    'google-account-stale', 'stale-calendar@example.test',
    'fake-refresh-token-selection-stale',
    (select connection_generation from stale_oauth_attempt),
    (select oauth_attempt_generation from stale_oauth_attempt)
  )$$,
  '55000',
  'GOOGLE_CALENDAR_OAUTH_STATE_STALE',
  'un callback tardío no puede reemplazar un intento OAuth más nuevo'
);

select ok(
  not exists (select 1 from public.google_calendar_connection_candidates),
  'rechazar el callback tardío no deja candidato local'
);

create temporary table candidate_a as
select candidate.candidate_id
from public.stage_google_calendar_connection_candidate(
  '9a000000-0000-4000-8000-000000000001',
  'google-account-seba', 'seba-calendar@example.test',
  'fake-refresh-token-selection-account-a',
  (select connection_generation from current_oauth_attempt),
  (select oauth_attempt_generation from current_oauth_attempt)
) candidate;

select ok(
  (select status = 'disconnected' and google_calendar_id is null
   from public.google_calendar_connections where id = true)
  and (select selection_pending from public.google_calendar_status()),
  'stage deja intacta la conexión activa y publica selection_pending'
);

create temporary table first_candidate_read as
select candidate_id, google_account_id, char_length(refresh_token) as token_length
from public.get_google_calendar_connection_candidate_secret(
  '9a000000-0000-4000-8000-000000000001'
);
create temporary table second_candidate_read as
select candidate_id, google_account_id, char_length(refresh_token) as token_length
from public.get_google_calendar_connection_candidate_secret(
  '9a000000-0000-4000-8000-000000000001'
);

select ok(
  (select count(*) = 1 from first_candidate_read)
  and (select count(*) = 1 from second_candidate_read)
  and (select first_read.candidate_id = second_read.candidate_id
       from first_candidate_read first_read, second_candidate_read second_read)
  and (select token_length > 0 from second_candidate_read),
  'GET y POST pueden releer el mismo candidato selecting'
);

select throws_ok(
  $$select * from public.stage_google_calendar_connection_candidate(
    '9a000000-0000-4000-8000-000000000001',
    'google-account-other', 'other-calendar@example.test',
    'fake-refresh-token-concurrent-account',
    (select connection_generation from current_oauth_attempt),
    (select oauth_attempt_generation from current_oauth_attempt)
  )$$,
  '55000',
  'GOOGLE_CALENDAR_SELECTION_IN_PROGRESS',
  'otro OAuth no puede reemplazar la cuenta durante selección remota'
);

select throws_ok(
  $$select public.finalize_google_calendar_connection_selection(
    '9a000000-0000-4000-8000-000000000001',
    (select candidate_id from candidate_a),
    'calendar-seba', 'Gisela Lentz · Turnos', 'UTC'
  )$$,
  '22023',
  'INVALID_GOOGLE_CALENDAR_SELECTION',
  'DB rechaza una zona IANA válida distinta de app_settings sin consumir candidato'
);

create temporary table connection_a as
select public.finalize_google_calendar_connection_selection(
  '9a000000-0000-4000-8000-000000000001',
  (select candidate_id from candidate_a),
  'calendar-seba', 'Gisela Lentz · Turnos',
  'America/Argentina/Buenos_Aires'
) as generation;

select ok(
  exists (
    select 1 from public.google_calendar_connections connection, connection_a
    where connection.id = true
      and connection.status = 'connected'
      and connection.google_account_id = 'google-account-seba'
      and connection.google_calendar_id = 'calendar-seba'
      and connection.google_calendar_timezone = 'America/Argentina/Buenos_Aires'
      and connection.sync_scope_google_account_id = connection.google_account_id
      and connection.sync_scope_google_calendar_id = connection.google_calendar_id
      and connection.sync_scope_generation = connection_a.generation
      and connection.connection_generation = connection_a.generation
  ),
  'finalize activa exactamente la cuenta, calendario, zona y generación elegidos'
);

select ok(
  not exists (select 1 from public.google_calendar_connection_candidates)
  and not (select selection_pending from public.google_calendar_status()),
  'finalize consume el candidato y deja de anunciar selección pendiente'
);

select is(
  public.finalize_google_calendar_connection_selection(
    '9a000000-0000-4000-8000-000000000001',
    (select candidate_id from candidate_a),
    'calendar-seba', 'Gisela Lentz · Turnos',
    'America/Argentina/Buenos_Aires'
  ),
  (select generation from connection_a),
  'un POST repetido de la misma selección no rota nuevamente la generación'
);

select ok(
  exists (
    select 1
    from public.google_calendar_sync_jobs job, connection_a
    where job.appointment_id = '9a000000-0000-4000-8000-000000000004'
      and job.operation = 'upsert'
      and job.status = 'pending'
      and job.connection_generation = connection_a.generation
  )
  and not exists (
    select 1 from public.google_calendar_sync_jobs job
    join public.appointments appointment on appointment.id = job.appointment_id
    where job.status in ('pending', 'processing')
      and appointment.status <> 'confirmed'
  ),
  'una selección encola únicamente turnos confirmados futuros'
);

select ok(
  not public.appointment_slot_is_available(
    '9a000000-0000-4000-8000-000000000002',
    (select starts_at from selection_availability_fixture),
    30,
    null,
    'America/Argentina/Buenos_Aires'
  ),
  'la disponibilidad queda cerrada hasta completar la primera importación'
);

select ok(
  public.approve_google_calendar_first_import(
    '9a000000-0000-4000-8000-000000000001'
  ),
  'la importación se aprueba dentro del alcance A'
);

select ok(
  not public.appointment_slot_is_available(
    '9a000000-0000-4000-8000-000000000002',
    (select starts_at from selection_availability_fixture),
    30,
    null,
    'America/Argentina/Buenos_Aires'
  ),
  'aprobar sin token incremental todavía no abre disponibilidad'
);

create temporary table completed_lease as
select lease.lease_token
from connection_a, lateral public.begin_google_calendar_inbound_sync(
  connection_a.generation, 240, 2,
  (select starts_at from selection_sync_window),
  (select ends_at from selection_sync_window)
) lease;
select ok(
  (select public.complete_google_calendar_inbound_sync(
    connection_a.generation,
    completed_lease.lease_token,
    'sync-token-account-a',
    '{"blocksImported":1}'::jsonb,
    1,
    2,
    selection_sync_window.starts_at,
    selection_sync_window.ends_at
  ) from connection_a, completed_lease, selection_sync_window),
  'token y resumen inbound se escriben sólo bajo lease del alcance A'
);

select ok(
  public.appointment_slot_is_available(
    '9a000000-0000-4000-8000-000000000002',
    (select starts_at from selection_availability_fixture),
    30,
    null,
    'America/Argentina/Buenos_Aires'
  ),
  'la disponibilidad se abre recién con aprobación y sync incremental completo'
);

insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind, status,
  summary, starts_at, ends_at, all_day, recurring, unsupported_reason,
  google_etag, google_updated_at, content_hash
)
select 'calendar-seba', 'unsupported-all-day-selection',
       connection_a.generation, 'unsupported', 'active',
       'PRUEBA ALL DAY NO SOPORTADO', null, null, true, false, 'ALL_DAY',
       'etag-unsupported-selection', clock_timestamp(), repeat('f', 32)
from connection_a;

select ok(
  not public.appointment_slot_is_available(
    '9a000000-0000-4000-8000-000000000002',
    (select starts_at from selection_availability_fixture),
    30,
    null,
    'America/Argentina/Buenos_Aires'
  ),
  'un evento unsupported activo cierra la disponibilidad completa'
);

update public.google_calendar_external_events
set status = 'removed', removed_at = clock_timestamp()
where google_event_id = 'unsupported-all-day-selection';

select ok(
  public.appointment_slot_is_available(
    '9a000000-0000-4000-8000-000000000002',
    (select starts_at from selection_availability_fixture),
    30,
    null,
    'America/Argentina/Buenos_Aires'
  ),
  'al quedar removed el unsupported deja de cerrar la agenda'
);

select throws_ok(
  $$update public.app_settings set timezone = 'UTC' where id = true$$,
  '55000',
  'GOOGLE_CALENDAR_TIMEZONE_CHANGE_REQUIRES_DISCONNECT',
  'una conexión activa impide que app_settings derive de la zona seleccionada'
);

-- El primer pull puede importar un bloqueo antes de que el mismo request
-- reclame los upserts. La cola no debe duplicar ese horario en Google. Un
-- bloqueo convertido por el propio turno sí permite crear su sustituto.
create temporary table selection_claim_fixture as
select
  (((current_date + 76)::text || ' 10:00')::timestamp
    at time zone 'America/Argentina/Buenos_Aires') as blocked_slot,
  (((current_date + 77)::text || ' 11:00')::timestamp
    at time zone 'America/Argentina/Buenos_Aires') as free_slot,
  (((current_date + 78)::text || ' 12:00')::timestamp
    at time zone 'America/Argentina/Buenos_Aires') as converted_slot;

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status
)
select appointment_id, '9a000000-0000-4000-8000-000000000003',
       '9a000000-0000-4000-8000-000000000002', starts_at,
       starts_at + interval '30 minutes', 'confirmed', 'manual',
       'particular', 30, 'confirmed'
from (
  select '9a000000-0000-4000-8000-000000000006'::uuid,
         blocked_slot from selection_claim_fixture
  union all
  select '9a000000-0000-4000-8000-000000000007'::uuid,
         free_slot from selection_claim_fixture
  union all
  select '9a000000-0000-4000-8000-000000000008'::uuid,
         converted_slot from selection_claim_fixture
) candidates(appointment_id, starts_at);

update public.google_calendar_sync_jobs
set status = 'succeeded'
where appointment_id = '9a000000-0000-4000-8000-000000000004';

insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind, status,
  summary, starts_at, ends_at, all_day, recurring, unsupported_reason,
  google_etag, google_updated_at, content_hash, converted_appointment_id,
  external_cleanup_status
)
select 'calendar-seba', 'full-import-block-overlap', connection_a.generation,
       'block', 'active', 'PRUEBA FULL IMPORT SOLAPADO', fixture.blocked_slot,
       fixture.blocked_slot + interval '30 minutes', false, false, null,
       'etag-full-import-block', clock_timestamp(), repeat('1', 32), null,
       'not_required'
from connection_a, selection_claim_fixture fixture
union all
select 'calendar-seba', 'converted-own-overlap', connection_a.generation,
       'block', 'converted', 'PRUEBA CONVERTIDO PROPIO', fixture.converted_slot,
       fixture.converted_slot + interval '30 minutes', false, false, null,
       'etag-converted-own', clock_timestamp(), repeat('2', 32),
       '9a000000-0000-4000-8000-000000000008'::uuid, 'pending'
from connection_a, selection_claim_fixture fixture;

create temporary table selection_claimed_after_pull as
select claimed.*
from connection_a, lateral public.claim_google_calendar_sync_jobs(
  20, connection_a.generation
) claimed;

select ok(
  not exists (
    select 1 from selection_claimed_after_pull
    where appointment_id = '9a000000-0000-4000-8000-000000000006'
  ),
  'un bloqueo manual importado y solapado retiene el upsert'
);

select ok(
  exists (
    select 1 from selection_claimed_after_pull
    where appointment_id = '9a000000-0000-4000-8000-000000000007'
  ),
  'un turno sin bloqueo solapado sí puede reclamarse'
);

select ok(
  exists (
    select 1 from selection_claimed_after_pull
    where appointment_id = '9a000000-0000-4000-8000-000000000008'
  ),
  'el bloqueo convertido por el propio turno permite crear su evento sustituto'
);

update public.google_calendar_sync_jobs
set status = 'succeeded', processing_started_at = null
where appointment_id in (
  '9a000000-0000-4000-8000-000000000007',
  '9a000000-0000-4000-8000-000000000008'
);

-- ---------------------------------------------------------------------------
-- Sólo turnos confirmados se proyectan hacia Google
-- ---------------------------------------------------------------------------

insert into public.appointments (
  id, contact_id, professional_id, starts_at, ends_at, status, source,
  coverage, duration_minutes, deposit_status, hold_expires_at
) values (
  '9a000000-0000-4000-8000-000000000005',
  '9a000000-0000-4000-8000-000000000003',
  '9a000000-0000-4000-8000-000000000002',
  clock_timestamp() + interval '65 days',
  clock_timestamp() + interval '65 days 30 minutes',
  'scheduled', 'manual', 'particular', 30, 'pending',
  clock_timestamp() + interval '1 hour'
);

select ok(
  not exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '9a000000-0000-4000-8000-000000000005'
  ),
  'un scheduled nuevo no crea ningún job saliente'
);

update public.appointments
set status = 'confirmed', deposit_status = 'confirmed', hold_expires_at = null
where id = '9a000000-0000-4000-8000-000000000005';

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '9a000000-0000-4000-8000-000000000005'
      and operation = 'upsert' and status = 'pending'
  ),
  'al confirmar el turno se crea un único upsert'
);

update public.google_calendar_sync_jobs
set status = 'succeeded',
    google_event_id = 'managed-event-confirmed-only',
    google_etag = 'etag-confirmed-only',
    projected_operation = 'upsert',
    projected_starts_at = (
      select starts_at from public.appointments
      where id = '9a000000-0000-4000-8000-000000000005'
    ),
    projected_ends_at = (
      select ends_at from public.appointments
      where id = '9a000000-0000-4000-8000-000000000005'
    )
where appointment_id = '9a000000-0000-4000-8000-000000000005';
update public.contacts
set name = 'Paciente Ficticio Calendar Selection Renombrado'
where id = '9a000000-0000-4000-8000-000000000003';

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '9a000000-0000-4000-8000-000000000005'
      and operation = 'upsert' and status = 'pending'
      and desired_version > 1
  ),
  'cambiar el nombre reencola sólo el turno confirmado'
);

update public.appointments
set status = 'scheduled', deposit_status = 'pending',
    hold_expires_at = clock_timestamp() + interval '1 hour'
where id = '9a000000-0000-4000-8000-000000000005';

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '9a000000-0000-4000-8000-000000000005'
      and operation = 'delete' and status = 'pending'
      and google_event_id = 'managed-event-confirmed-only'
  ),
  'confirmed a scheduled retira el evento que ya estaba proyectado'
);

update public.appointments
set status = 'confirmed', deposit_status = 'confirmed', hold_expires_at = null
where id = '9a000000-0000-4000-8000-000000000005';
update public.appointments
set status = 'cancelled'
where id = '9a000000-0000-4000-8000-000000000005';

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '9a000000-0000-4000-8000-000000000005'
      and operation = 'delete' and status = 'pending'
      and google_event_id = 'managed-event-confirmed-only'
  ),
  'confirmed a cancelled conserva un único delete determinístico'
);

create temporary table stale_lease as
select lease.lease_token
from connection_a, lateral public.begin_google_calendar_inbound_sync(
  connection_a.generation, 240, 2,
  (select starts_at from selection_sync_window),
  (select ends_at from selection_sync_window)
) lease;

update public.google_calendar_sync_jobs
set status = 'succeeded',
    google_event_id = 'managed-event-account-a',
    google_etag = 'etag-account-a',
    projected_operation = 'upsert',
    projected_starts_at = clock_timestamp() + interval '50 days',
    projected_ends_at = clock_timestamp() + interval '50 days 30 minutes'
where appointment_id = '9a000000-0000-4000-8000-000000000004';

insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind, status,
  summary, starts_at, ends_at, all_day, recurring, unsupported_reason,
  google_etag, google_updated_at, content_hash
)
select 'calendar-seba', 'external-block-account-a', connection_a.generation,
       'block', 'active', 'PRUEBA AISLAMIENTO A',
       clock_timestamp() + interval '60 days',
       clock_timestamp() + interval '60 days 30 minutes',
       false, false, null, 'etag-block-a', clock_timestamp(), repeat('a', 32)
from connection_a;

insert into public.google_calendar_sync_conflicts (
  appointment_id, google_event_id, kind, status,
  connection_generation
)
select '9a000000-0000-4000-8000-000000000004',
       'managed-event-account-a', 'cancellation_requested', 'pending',
       connection_a.generation
from connection_a;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"9a000000-0000-4000-8000-000000000009"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub', '9a000000-0000-4000-8000-000000000009', true
);
select ok(
  not exists (select 1 from public.google_calendar_external_events)
  and not exists (select 1 from public.google_calendar_sync_conflicts),
  'una persona OPERADOR no puede leer bloqueos ni conflictos de Calendar'
);
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"9a000000-0000-4000-8000-000000000001"}',
  true
);
select set_config(
  'request.jwt.claim.sub', '9a000000-0000-4000-8000-000000000001', true
);
select ok(
  exists (select 1 from public.google_calendar_external_events)
  and exists (select 1 from public.google_calendar_sync_conflicts),
  'una persona ADMIN sí puede leer filas del alcance Calendar vigente'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

select public.create_google_calendar_oauth_state(
  '9a000000-0000-4000-8000-000000000001', repeat('c', 64),
  repeat('v', 64), clock_timestamp() + interval '10 minutes'
);
create temporary table oauth_attempt_b as
select * from public.consume_google_calendar_oauth_state(repeat('c', 64));
create temporary table candidate_b as
select candidate.candidate_id
from public.stage_google_calendar_connection_candidate(
  '9a000000-0000-4000-8000-000000000001',
  'google-account-gisela', 'gisela-calendar@example.test',
  'fake-refresh-token-selection-account-b',
  (select connection_generation from oauth_attempt_b),
  (select oauth_attempt_generation from oauth_attempt_b)
) candidate;

select ok(
  exists (
    select 1 from public.google_calendar_connections connection
    where connection.id = true
      and connection.google_account_id = 'google-account-seba'
      and connection.google_calendar_id = 'calendar-seba'
      and connection.inbound_sync_token = 'sync-token-account-a'
      and connection.inbound_sync_contract_version = 2
      and connection.inbound_coverage_starts_at =
        (select starts_at from selection_sync_window)
      and connection.inbound_coverage_ends_at =
        (select ends_at from selection_sync_window)
      and connection.inbound_first_import_approved_at is not null
      and connection.inbound_lease_token = (select lease_token from stale_lease)
  ),
  'staging de la cuenta B no modifica estado, aprobación ni lease de A'
);

select ok(
  (select selection_pending from public.google_calendar_status())
  and (select connected from public.google_calendar_status()),
  'una selección pendiente puede coexistir con la conexión A activa'
);

select count(*) from public.get_google_calendar_connection_candidate_secret(
  '9a000000-0000-4000-8000-000000000001'
);

select throws_ok(
  $$select public.finalize_google_calendar_connection_selection(
    '9a000000-0000-4000-8000-000000000001',
    (select candidate_id from candidate_a),
    'calendar-gisela', 'Gisela Lentz · Turnos',
    'America/Argentina/Buenos_Aires'
  )$$,
  '55000',
  'GOOGLE_CALENDAR_SELECTION_NOT_READY',
  'una validación remota anterior no puede finalizar un candidato OAuth nuevo'
);

select throws_ok(
  $$select public.finalize_google_calendar_connection_selection(
    '9a000000-0000-4000-8000-000000000001',
    (select candidate_id from candidate_b),
    'calendar-gisela', 'Gisela Lentz · Turnos',
    'America/Argentina/Buenos_Aires'
  )$$,
  '55000',
  'GOOGLE_CALENDAR_SYNC_IN_PROGRESS',
  'finalize no corta un pull que conserva un lease inbound vigente'
);

select throws_ok(
  $$select * from public.disconnect_google_calendar_with_secrets(
    '9a000000-0000-4000-8000-000000000001'
  )$$,
  '55000',
  'GOOGLE_CALENDAR_SYNC_IN_PROGRESS',
  'disconnect tampoco corta un pull con lease inbound vigente'
);

select ok(
  (select public.release_google_calendar_inbound_lease(
    connection_a.generation, stale_lease.lease_token
  ) from connection_a, stale_lease),
  'el lease de prueba se libera antes de cambiar el alcance'
);

update public.google_calendar_sync_jobs
set status = 'processing', processing_started_at = clock_timestamp()
where appointment_id = '9a000000-0000-4000-8000-000000000004';

select throws_ok(
  $$select public.finalize_google_calendar_connection_selection(
    '9a000000-0000-4000-8000-000000000001',
    (select candidate_id from candidate_b),
    'calendar-gisela', 'Gisela Lentz · Turnos',
    'America/Argentina/Buenos_Aires'
  )$$,
  '55000',
  'GOOGLE_CALENDAR_SYNC_IN_PROGRESS',
  'finalize no rota generación mientras un push está processing'
);

select throws_ok(
  $$select * from public.disconnect_google_calendar_with_secrets(
    '9a000000-0000-4000-8000-000000000001'
  )$$,
  '55000',
  'GOOGLE_CALENDAR_SYNC_IN_PROGRESS',
  'disconnect no borra mappings mientras un push está processing'
);

update public.google_calendar_sync_jobs
set status = 'succeeded', processing_started_at = null
where appointment_id = '9a000000-0000-4000-8000-000000000004';

select ok(
  exists (
    select 1 from public.google_calendar_connection_candidates candidate,
      candidate_b
    where candidate.id = true
      and candidate.candidate_id = candidate_b.candidate_id
      and candidate.status = 'selecting'
  )
  and exists (
    select 1 from public.google_calendar_connections
    where id = true and google_account_id = 'google-account-seba'
  ),
  'los rechazos por sync activo conservan candidato y conexión sin cambios'
);

select throws_ok(
  $$select public.finalize_google_calendar_connection_selection(
    '9a000000-0000-4000-8000-000000000001',
    (select candidate_id from candidate_b),
    'calendar-gisela', 'Gisela Lentz · Turnos',
    'America/Argentina/Buenos_Aires'
  )$$,
  '55000',
  'GOOGLE_CALENDAR_DISCONNECT_REQUIRED',
  'cambiar de cuenta exige desconectar para poder revocar el grant anterior'
);

create temporary table account_a_disconnect_tokens as
select * from public.disconnect_google_calendar_with_secrets(
  '9a000000-0000-4000-8000-000000000001'
);

select lives_ok(
  $timezone_sql$do $timezone_change_while_disconnected$
    begin
      update public.app_settings set timezone = 'UTC' where id = true;
      update public.app_settings
      set timezone = 'America/Argentina/Buenos_Aires' where id = true;
    end
  $timezone_change_while_disconnected$$timezone_sql$,
  'desconectado permite cambiar y restaurar la zona configurada'
);
select public.create_google_calendar_oauth_state(
  '9a000000-0000-4000-8000-000000000001', repeat('f', 64),
  repeat('v', 64), clock_timestamp() + interval '10 minutes'
);
create temporary table oauth_attempt_b_after_disconnect as
select * from public.consume_google_calendar_oauth_state(repeat('f', 64));
create temporary table candidate_b_after_disconnect as
select candidate.candidate_id
from public.stage_google_calendar_connection_candidate(
  '9a000000-0000-4000-8000-000000000001',
  'google-account-gisela', 'gisela-calendar@example.test',
  'fake-refresh-token-selection-account-b-after-disconnect',
  (select connection_generation from oauth_attempt_b_after_disconnect),
  (select oauth_attempt_generation from oauth_attempt_b_after_disconnect)
) candidate;
select count(*) from public.get_google_calendar_connection_candidate_secret(
  '9a000000-0000-4000-8000-000000000001'
);
create temporary table connection_b as
select public.finalize_google_calendar_connection_selection(
  '9a000000-0000-4000-8000-000000000001',
  (select candidate_id from candidate_b_after_disconnect),
  'calendar-gisela', 'Gisela Lentz · Turnos',
  'America/Argentina/Buenos_Aires'
) as generation;

select ok(
  exists (
    select 1 from public.google_calendar_connections connection,
      connection_a, connection_b
    where connection.id = true
      and connection.google_account_id = 'google-account-gisela'
      and connection.google_calendar_id = 'calendar-gisela'
      and connection.connection_generation = connection_b.generation
      and connection_b.generation > connection_a.generation
      and connection.sync_scope_google_account_id = 'google-account-gisela'
      and connection.sync_scope_google_calendar_id = 'calendar-gisela'
      and connection.sync_scope_generation = connection_b.generation
  ),
  'finalize B rota generación y scope sin mezclar identidad de A'
);

select ok(
  exists (
    select 1 from public.google_calendar_connections connection
    where connection.id = true
      and connection.inbound_sync_token is null
      and connection.inbound_sync_token_generation is null
      and connection.inbound_sync_contract_version is null
      and connection.inbound_coverage_starts_at is null
      and connection.inbound_coverage_ends_at is null
      and connection.inbound_sync_state = 'awaiting_first_import'
      and connection.inbound_first_import_approved_at is null
      and connection.inbound_first_import_approved_by is null
      and connection.inbound_lease_token is null
      and connection.inbound_lease_expires_at is null
      and connection.last_checked_at is null
      and connection.last_sync_completed_at is null
      and connection.last_sync_summary = '{}'::jsonb
      and connection.last_sync_error is null
  ),
  'cambiar de cuenta reinicia token, aprobación, lease y bitácora'
);

select ok(
  (select status = 'superseded'
   from public.google_calendar_external_events
   where google_calendar_id = 'calendar-seba'
     and google_event_id = 'external-block-account-a')
  and (select status = 'superseded'
       from public.google_calendar_sync_conflicts
       where google_event_id = 'managed-event-account-a'),
  'bloqueos y conflictos de A se conservan como historia no activa'
);

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs job, connection_b
    where job.appointment_id = '9a000000-0000-4000-8000-000000000004'
      and job.status = 'pending'
      and job.operation = 'upsert'
      and job.connection_generation = connection_b.generation
      and job.google_event_id is null
      and job.google_etag is null
      and job.projected_operation is null
      and job.projected_starts_at is null
      and job.projected_ends_at is null
  ),
  'el turno confirmado se reencola sin IDs ni ETag de la cuenta A'
);

select throws_ok(
  format(
    'select public.assert_google_calendar_inbound_lease(%s, %L)',
    (select generation from connection_a),
    (select lease_token from stale_lease)
  ),
  '42501',
  'GOOGLE_CALENDAR_INBOUND_LEASE_LOST',
  'un worker de A no puede escribir después de conectar B'
);

create temporary table reconnect_block_fixture as
select (
  ((current_date + 70)::text || ' 15:00')::timestamp
  at time zone 'America/Argentina/Buenos_Aires'
) as starts_at;
insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind, status,
  summary, starts_at, ends_at, all_day, recurring, unsupported_reason,
  google_etag, google_updated_at, content_hash
)
select 'calendar-gisela', 'reconnect-block-account-b', connection_b.generation,
       'block', 'active', 'PRUEBA RECONNECT B', fixture.starts_at,
       fixture.starts_at + interval '30 minutes', false, false, null,
       'etag-reconnect-b', clock_timestamp(), repeat('b', 32)
from connection_b, reconnect_block_fixture fixture;
select public.mark_google_calendar_reconnect_required(
  'GOOGLE_REFRESH_REJECTED', (select generation from connection_b)
);

select ok(
  (select status = 'active'
   from public.google_calendar_external_events
   where google_calendar_id = 'calendar-gisela'
     and google_event_id = 'reconnect-block-account-b')
  and exists (
    select 1 from public.google_calendar_connections connection
    where connection.id = true
      and connection.inbound_sync_contract_version is null
      and connection.inbound_coverage_starts_at is null
      and connection.inbound_coverage_ends_at is null
  )
  and not public.appointment_slot_is_available(
    '9a000000-0000-4000-8000-000000000002',
    (select starts_at from reconnect_block_fixture),
    30,
    null,
    'America/Argentina/Buenos_Aires'
  ),
  'reconnect_required conserva activos y ocupando agenda los bloqueos del mismo scope'
);

select public.create_google_calendar_oauth_state(
  '9a000000-0000-4000-8000-000000000001', repeat('d', 64),
  repeat('v', 64), clock_timestamp() + interval '10 minutes'
);
create temporary table oauth_attempt_c as
select * from public.consume_google_calendar_oauth_state(repeat('d', 64));
select * from public.stage_google_calendar_connection_candidate(
  '9a000000-0000-4000-8000-000000000001',
  'google-account-third', 'third-calendar@example.test',
  'fake-refresh-token-selection-account-c',
  (select connection_generation from oauth_attempt_c),
  (select oauth_attempt_generation from oauth_attempt_c)
);
create temporary table secrets_before_disconnect as
select connection.refresh_token_secret_id as secret_id
from public.google_calendar_connections connection where connection.id = true
union all
select candidate.refresh_token_secret_id
from public.google_calendar_connection_candidates candidate where candidate.id = true;

create temporary table disconnect_tokens as
select * from public.disconnect_google_calendar_with_secrets(
  '9a000000-0000-4000-8000-000000000001'
);

select ok(
  exists (
    select 1 from disconnect_tokens tokens
    where char_length(tokens.active_refresh_token) > 0
      and char_length(tokens.candidate_refresh_token) > 0
  ),
  'disconnect atómico captura los tokens activo y candidato antes de limpiarlos'
);

select ok(
  exists (
    select 1 from public.google_calendar_connections connection
    where connection.id = true
      and connection.status = 'disconnected'
      and connection.google_account_id is null
      and connection.google_account_email is null
      and connection.google_calendar_id is null
      and connection.google_calendar_name is null
      and connection.google_calendar_timezone is null
      and connection.refresh_token_secret_id is null
      and connection.sync_scope_google_account_id is null
      and connection.sync_scope_google_calendar_id is null
      and connection.sync_scope_generation is null
      and connection.inbound_sync_contract_version is null
      and connection.inbound_coverage_starts_at is null
      and connection.inbound_coverage_ends_at is null
  )
  and not exists (select 1 from public.google_calendar_connection_candidates),
  'disconnect limpia identidad, scope y candidato pendiente'
);

select is(
  (select count(*)::integer
   from vault.secrets secret
   where secret.id in (select secret_id from secrets_before_disconnect)),
  0,
  'disconnect elimina de Vault tanto el secreto activo como el candidato'
);

select ok(
  not exists (
    select 1 from public.google_calendar_sync_jobs
    where google_event_id is not null
       or google_etag is not null
       or projected_operation is not null
       or projected_starts_at is not null
       or projected_ends_at is not null
  ),
  'disconnect elimina todos los mappings externos locales'
);

select throws_ok(
  $$update public.google_calendar_connections
    set google_account_id = 'legacy-disconnected-account',
        google_account_email = 'legacy-disconnected@example.test',
        google_calendar_id = 'legacy-disconnected-calendar',
        google_calendar_name = 'Legacy disconnected'
    where id = true and status = 'disconnected'$$,
  '23514',
  null,
  'una fila disconnected no puede volver a retener identidad o calendario legacy'
);

select throws_ok(
  $$select public.complete_google_calendar_connection(
    '9a000000-0000-4000-8000-000000000001',
    'legacy-account', 'legacy@example.test', 'legacy-calendar',
    'Gisela Lentz · Turnos', 'fake-refresh-token-legacy-callback'
  )$$,
  '55000',
  'GOOGLE_CALENDAR_SELECTION_REQUIRED',
  'el callback histórico no puede saltear la selección owner'
);

select public.create_google_calendar_oauth_state(
  '9a000000-0000-4000-8000-000000000001', repeat('e', 64),
  repeat('v', 64), clock_timestamp() + interval '10 minutes'
);
create temporary table oauth_consumed_before_disconnect as
select * from public.consume_google_calendar_oauth_state(repeat('e', 64));
select public.disconnect_google_calendar(
  '9a000000-0000-4000-8000-000000000001'
);

select throws_ok(
  $$select * from public.stage_google_calendar_connection_candidate(
    '9a000000-0000-4000-8000-000000000001',
    'google-account-late', 'late-calendar@example.test',
    'fake-refresh-token-after-disconnect',
    (select connection_generation from oauth_consumed_before_disconnect),
    (select oauth_attempt_generation from oauth_consumed_before_disconnect)
  )$$,
  '55000',
  'GOOGLE_CALENDAR_OAUTH_STATE_STALE',
  'un callback consumido antes de disconnect no puede recrear el candidato'
);

select ok(
  not exists (select 1 from public.google_calendar_connection_candidates),
  'el callback tardío post-disconnect no deja credencial candidata'
);

select ok(
  not (select connected from public.google_calendar_status())
  and not (select selection_pending from public.google_calendar_status())
  and (select inbound_sync_state = 'never_synced'
       from public.google_calendar_connections where id = true),
  'el estado final desconectado no conserva trabajo ni selección activa'
);

select * from finish();
rollback;
