\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(37);

select has_column(
  'public', 'google_calendar_connections', 'inbound_sync_contract_version',
  'la conexión guarda la versión del contrato inbound'
);
select has_column(
  'public', 'google_calendar_connections', 'inbound_coverage_starts_at',
  'la conexión guarda el inicio de cobertura verificada'
);
select has_column(
  'public', 'google_calendar_connections', 'inbound_coverage_ends_at',
  'la conexión guarda el fin exclusivo de cobertura verificada'
);
select has_column(
  'public', 'google_calendar_connections', 'inbound_sync_timezone',
  'el token guarda la zona exacta usada por Events.list'
);
select has_column(
  'public', 'google_calendar_connections',
  'inbound_lease_sync_contract_version',
  'el lease guarda la versión exacta que debe completar'
);
select has_column(
  'public', 'google_calendar_connections',
  'inbound_lease_coverage_starts_at',
  'el lease guarda el inicio solicitado'
);
select has_column(
  'public', 'google_calendar_connections',
  'inbound_lease_coverage_ends_at',
  'el lease guarda el fin solicitado'
);
select has_column(
  'public', 'google_calendar_connections', 'inbound_lease_timezone',
  'el lease guarda la zona exacta solicitada'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.get_google_calendar_windowed_connection_secret()',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.get_google_calendar_windowed_connection_secret()',
    'EXECUTE'
  ),
  'zona y secreto windowed permanecen exclusivos de service_role'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.begin_google_calendar_inbound_sync(bigint,integer,integer,timestamptz,timestamptz)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.begin_google_calendar_inbound_sync(bigint,integer,integer,timestamptz,timestamptz)',
    'EXECUTE'
  ),
  'el lease v2 permanece exclusivo de service_role'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.complete_google_calendar_inbound_sync(bigint,uuid,text,jsonb,integer,integer,timestamptz,timestamptz)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.complete_google_calendar_inbound_sync(bigint,uuid,text,jsonb,integer,integer,timestamptz,timestamptz)',
    'EXECUTE'
  ),
  'el cierre v2 permanece exclusivo de service_role'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

insert into auth.users (id, email, encrypted_password, aud, role)
values (
  '9b000000-0000-4000-8000-000000000001',
  'calendar-window-admin@example.test', '', 'authenticated', 'authenticated'
);
update public.profiles
set role = 'ADMIN', active = true
where id = '9b000000-0000-4000-8000-000000000001';

insert into public.professionals (
  id, name, appointment_duration_minutes, active
) values (
  '9b000000-0000-4000-8000-000000000002',
  'Profesional Calendar Window', 30, true
);
insert into public.availability_rules (
  professional_id, weekday, start_time, end_time, slot_minutes
)
select '9b000000-0000-4000-8000-000000000002', weekday,
       '08:00', '20:00', 30
from generate_series(0, 6) weekday;

-- Aísla la disponibilidad del fixture respecto de turnos futuros del seed.
update public.appointments appointment
set status = 'cancelled'
where appointment.status in ('scheduled', 'confirmed');

create temporary table window_fixture as
select connection.connection_generation + 100 as generation,
       bounds.coverage_starts_at,
       bounds.coverage_starts_at + interval '21 days' as coverage_ends_at,
       bounds.coverage_starts_at + interval '10 hours' as inside_slot,
       bounds.coverage_starts_at + interval '21 days 10 hours' as outside_slot
from public.google_calendar_connections connection
cross join lateral (
  select (
    ((current_date + 3)::text || ' 00:00')::timestamp
      at time zone settings.timezone
  ) as coverage_starts_at
  from public.app_settings settings
  where settings.id = true
) bounds
where connection.id = true;

update public.google_calendar_connections connection
set status = 'connected',
    connected_by = '9b000000-0000-4000-8000-000000000001',
    google_account_id = 'google-window-account',
    google_account_email = 'calendar-window@example.test',
    google_calendar_id = 'calendar-window-id',
    google_calendar_name = 'Calendar Window Fixture',
    google_calendar_timezone = 'America/Argentina/Buenos_Aires',
    refresh_token_secret_id = '9b000000-0000-4000-8000-000000000099',
    connected_at = clock_timestamp(),
    disconnected_at = null,
    connection_generation = fixture.generation,
    inbound_sync_token = null,
    inbound_sync_token_generation = null,
    inbound_sync_state = 'awaiting_first_import',
    inbound_sync_contract_version = null,
    inbound_coverage_starts_at = null,
    inbound_coverage_ends_at = null,
    inbound_first_import_approved_at = clock_timestamp(),
    inbound_first_import_approved_by = '9b000000-0000-4000-8000-000000000001',
    inbound_lease_token = null,
    inbound_lease_expires_at = null,
    last_sync_error = null,
    sync_scope_google_account_id = 'google-window-account',
    sync_scope_google_calendar_id = 'calendar-window-id',
    sync_scope_generation = fixture.generation
from window_fixture fixture
where connection.id = true;

select is(
  (
    select count(*)::integer
    from public.get_google_calendar_windowed_connection_secret()
  ),
  1,
  'el secreto windowed se entrega sólo para la conexión y alcance coherentes'
);

update public.google_calendar_connections
set status = 'reconnect_required',
    sync_scope_google_calendar_id = 'otro-calendario'
where id = true;
select is(
  (
    select count(*)::integer
    from public.get_google_calendar_windowed_connection_secret()
  ),
  0,
  'un estado no conectado y alcance distinto no exponen credenciales al worker'
);
update public.google_calendar_connections
set status = 'connected',
    sync_scope_google_calendar_id = 'calendar-window-id'
where id = true;

select throws_ok(
  $$
    select *
    from public.begin_google_calendar_inbound_sync(
      (select generation from window_fixture), 240, 2,
      (select coverage_starts_at from window_fixture),
      (select coverage_starts_at + interval '21 days 1 second'
       from window_fixture)
    )
  $$,
  '22023',
  'INVALID_GOOGLE_CALENDAR_SYNC_WINDOW',
  'una ventana mayor a 21 días se rechaza antes de tomar lease'
);

create temporary table first_window_lease as
select lease.*
from window_fixture fixture,
lateral public.begin_google_calendar_inbound_sync(
  fixture.generation, 240, 2,
  fixture.coverage_starts_at, fixture.coverage_ends_at
) lease;

select ok(
  (select lease_token is not null
      and sync_token is null
      and sync_state = 'full_resync_required'
      and first_import_approved
      and google_calendar_id = 'calendar-window-id'
      and google_calendar_timezone = 'America/Argentina/Buenos_Aires'
   from first_window_lease),
  'el primer lease v2 exige lectura completa y expone calendario y zona exactos'
);

select ok(
  exists (
    select 1
    from public.google_calendar_connections connection,
         window_fixture fixture,
         first_window_lease lease
    where connection.id = true
      and connection.inbound_lease_token = lease.lease_token
      and connection.inbound_lease_sync_contract_version = 2
      and connection.inbound_lease_coverage_starts_at =
        fixture.coverage_starts_at
      and connection.inbound_lease_coverage_ends_at = fixture.coverage_ends_at
      and connection.inbound_lease_timezone =
        'America/Argentina/Buenos_Aires'
  ),
  'el lease persiste el contrato y la ventana que tomó'
);

select is(
  (
    select public.complete_google_calendar_inbound_sync(
      fixture.generation, lease.lease_token,
      'windowed-sync-token-mismatched', '{}'::jsonb, 0,
      2,
      fixture.coverage_starts_at + interval '1 day',
      fixture.coverage_ends_at + interval '1 day'
    )
    from window_fixture fixture, first_window_lease lease
  ),
  false,
  'complete no puede confirmar una ventana distinta de la tomada por el lease'
);

select ok(
  exists (
    select 1
    from public.google_calendar_connections connection,
         first_window_lease lease
    where connection.id = true
      and connection.inbound_lease_token = lease.lease_token
      and connection.inbound_lease_sync_contract_version = 2
  ),
  'un complete con parámetros distintos conserva el lease sin avanzar estado'
);

update public.google_calendar_connections connection
set inbound_lease_expires_at = clock_timestamp() - interval '1 second'
from first_window_lease lease
where connection.id = true
  and connection.inbound_lease_token = lease.lease_token;
select is(
  (
    select public.complete_google_calendar_inbound_sync(
      fixture.generation, lease.lease_token,
      'windowed-sync-token-expired', '{}'::jsonb, 0,
      2, fixture.coverage_starts_at, fixture.coverage_ends_at
    )
    from window_fixture fixture, first_window_lease lease
  ),
  false,
  'complete no confirma cobertura después de vencer el lease'
);
update public.google_calendar_connections connection
set inbound_lease_expires_at = clock_timestamp() + interval '240 seconds'
from first_window_lease lease
where connection.id = true
  and connection.inbound_lease_token = lease.lease_token;

select ok(
  (
    select public.complete_google_calendar_inbound_sync(
      fixture.generation, lease.lease_token,
      'windowed-sync-token-1', '{"blocksImported":2}'::jsonb, 2,
      2, fixture.coverage_starts_at, fixture.coverage_ends_at
    )
    from window_fixture fixture, first_window_lease lease
  ),
  'el cierre v2 confirma token y ventana bajo el mismo lease'
);

select ok(
  exists (
    select 1
    from public.google_calendar_connections connection, window_fixture fixture
    where connection.id = true
      and connection.inbound_sync_token = 'windowed-sync-token-1'
      and connection.inbound_sync_token_generation = fixture.generation
      and connection.inbound_sync_contract_version = 2
      and connection.inbound_coverage_starts_at = fixture.coverage_starts_at
      and connection.inbound_coverage_ends_at = fixture.coverage_ends_at
      and connection.inbound_sync_timezone =
        'America/Argentina/Buenos_Aires'
      and connection.inbound_lease_token is null
      and connection.inbound_lease_sync_contract_version is null
      and connection.inbound_lease_coverage_starts_at is null
      and connection.inbound_lease_coverage_ends_at is null
      and connection.inbound_lease_timezone is null
      and connection.last_sync_error is null
  ),
  'token, generación, contrato y cobertura se persisten como una unidad'
);

select ok(
  public.appointment_slot_is_available(
    '9b000000-0000-4000-8000-000000000002',
    (select inside_slot from window_fixture), 30, null,
    'America/Argentina/Buenos_Aires'
  ),
  'un slot completamente cubierto puede ofrecerse'
);

select is(
  public.appointment_slot_is_available(
    '9b000000-0000-4000-8000-000000000002',
    (select outside_slot from window_fixture), 30, null,
    'America/Argentina/Buenos_Aires'
  ),
  false,
  'un slot fuera del horizonte verificado permanece cerrado'
);

create temporary table repeated_window_lease as
select lease.*
from window_fixture fixture,
lateral public.begin_google_calendar_inbound_sync(
  fixture.generation, 240, 2,
  fixture.coverage_starts_at, fixture.coverage_ends_at
) lease;

select ok(
  (select sync_token = 'windowed-sync-token-1'
      and sync_state = 'incremental'
   from repeated_window_lease),
  'la misma generación, versión y ventana reutiliza el token incremental'
);

select public.release_google_calendar_inbound_lease(
  fixture.generation, lease.lease_token
)
from window_fixture fixture, repeated_window_lease lease;

create temporary table shifted_window_lease as
select lease.*
from window_fixture fixture,
lateral public.begin_google_calendar_inbound_sync(
  fixture.generation, 240, 2,
  fixture.coverage_starts_at + interval '1 day',
  fixture.coverage_ends_at + interval '1 day'
) lease;

select ok(
  (select sync_token is null and sync_state = 'full_resync_required'
   from shifted_window_lease),
  'cambiar la ventana impide reutilizar el token anterior'
);

select public.release_google_calendar_inbound_lease(
  fixture.generation, lease.lease_token
)
from window_fixture fixture, shifted_window_lease lease;

select ok(
  exists (
    select 1
    from public.google_calendar_connections connection
    where connection.id = true
      and connection.inbound_lease_token is null
      and connection.inbound_lease_sync_contract_version is null
      and connection.inbound_lease_coverage_starts_at is null
      and connection.inbound_lease_coverage_ends_at is null
      and connection.inbound_lease_timezone is null
  ),
  'liberar un lease también limpia su contrato pendiente'
);

select is(
  (
    select count(*)::integer
    from window_fixture fixture,
    lateral public.begin_google_calendar_inbound_sync(
      fixture.generation, 240
    ) legacy_lease
  ),
  0,
  'un worker legacy no puede tomar lease después de establecer contrato v2'
);

create temporary table failed_window_lease as
select lease.*
from window_fixture fixture,
lateral public.begin_google_calendar_inbound_sync(
  fixture.generation, 240, 2,
  fixture.coverage_starts_at, fixture.coverage_ends_at
) lease;
select public.fail_google_calendar_inbound_sync(
  fixture.generation, lease.lease_token,
  'FIXTURE_READ_FAILED', '{}'::jsonb
)
from window_fixture fixture, failed_window_lease lease;

select ok(
  not public.appointment_slot_is_available(
    '9b000000-0000-4000-8000-000000000002',
    (select inside_slot from window_fixture), 30, null,
    'America/Argentina/Buenos_Aires'
  )
  and exists (
    select 1 from public.google_calendar_connections connection
    where connection.id = true
      and connection.last_sync_error = 'FIXTURE_READ_FAILED'
      and connection.inbound_sync_token is null
      and connection.inbound_sync_token_generation is null
      and connection.inbound_sync_contract_version is null
      and connection.inbound_coverage_starts_at is null
      and connection.inbound_coverage_ends_at is null
      and connection.inbound_sync_timezone is null
      and connection.inbound_sync_state = 'full_resync_required'
  ),
  'una lectura fallida no libera horarios aunque exista cobertura anterior'
);

create temporary table recovery_window_lease as
select lease.*
from window_fixture fixture,
lateral public.begin_google_calendar_inbound_sync(
  fixture.generation, 240, 2,
  fixture.coverage_starts_at, fixture.coverage_ends_at
) lease;
select public.complete_google_calendar_inbound_sync(
  fixture.generation, lease.lease_token,
  'windowed-sync-token-2', '{}'::jsonb, 0,
  2, fixture.coverage_starts_at, fixture.coverage_ends_at
)
from window_fixture fixture, recovery_window_lease lease;

select ok(
  public.appointment_slot_is_available(
    '9b000000-0000-4000-8000-000000000002',
    (select inside_slot from window_fixture), 30, null,
    'America/Argentina/Buenos_Aires'
  ),
  'una lectura completa posterior recupera la cobertura sin inferir ausencias'
);

create temporary table timezone_drift_lease as
select lease.*
from window_fixture fixture,
lateral public.begin_google_calendar_inbound_sync(
  fixture.generation, 240, 2,
  fixture.coverage_starts_at, fixture.coverage_ends_at
) lease;
update public.google_calendar_connections
set google_calendar_timezone = 'America/Montevideo'
where id = true;
select ok(
  exists (
    select 1
    from public.google_calendar_connections connection
    where connection.id = true
      and connection.inbound_sync_token is null
      and connection.inbound_sync_contract_version is null
      and connection.inbound_coverage_starts_at is null
      and connection.inbound_coverage_ends_at is null
      and connection.inbound_lease_token is null
      and connection.inbound_lease_sync_contract_version is null
      and connection.inbound_sync_state = 'full_resync_required'
  ),
  'cambiar timeZone invalida token, cobertura y lease aunque el offset coincida'
);
update public.google_calendar_connections
set google_calendar_timezone = 'America/Argentina/Buenos_Aires'
where id = true;

create temporary table invalidation_lease as
select lease.*
from window_fixture fixture,
lateral public.begin_google_calendar_inbound_sync(
  fixture.generation, 240, 2,
  fixture.coverage_starts_at, fixture.coverage_ends_at
) lease;
select public.invalidate_google_calendar_sync_token(
  fixture.generation, lease.lease_token
)
from window_fixture fixture, invalidation_lease lease;

select ok(
  exists (
    select 1
    from public.google_calendar_connections connection,
         window_fixture fixture,
         invalidation_lease lease
    where connection.id = true
      and connection.inbound_sync_token is null
      and connection.inbound_sync_token_generation is null
      and connection.inbound_sync_contract_version is null
      and connection.inbound_coverage_starts_at is null
      and connection.inbound_coverage_ends_at is null
      and connection.inbound_sync_state = 'full_resync_required'
      and connection.inbound_lease_token = lease.lease_token
      and connection.inbound_lease_sync_contract_version = 2
      and connection.inbound_lease_timezone =
        'America/Argentina/Buenos_Aires'
      and connection.inbound_lease_coverage_starts_at =
        fixture.coverage_starts_at
      and connection.inbound_lease_coverage_ends_at = fixture.coverage_ends_at
  ),
  'invalidar el token conserva el lease v2 para releer la misma ventana'
);

create temporary table legacy_completion as
select public.complete_google_calendar_inbound_sync(
  fixture.generation, lease.lease_token,
  'legacy-token-after-invalidation', '{}'::jsonb, 0
) as completed
from window_fixture fixture, invalidation_lease lease;

select ok(
  not (select completed from legacy_completion)
  and exists (
    select 1
    from public.google_calendar_connections connection,
         invalidation_lease lease
    where connection.id = true
      and connection.inbound_sync_token is null
      and connection.inbound_sync_contract_version is null
      and connection.inbound_coverage_starts_at is null
      and connection.inbound_coverage_ends_at is null
      and connection.inbound_lease_token = lease.lease_token
      and connection.inbound_lease_sync_contract_version = 2
      and connection.inbound_lease_timezone =
        'America/Argentina/Buenos_Aires'
  ),
  'un worker legacy no puede cerrar un lease v2 tras invalidar el token'
);

create temporary table v2_completion_after_invalidation as
select public.complete_google_calendar_inbound_sync(
  fixture.generation, lease.lease_token,
  'windowed-sync-token-after-invalidation', '{}'::jsonb, 0,
  2, fixture.coverage_starts_at, fixture.coverage_ends_at
) as completed
from window_fixture fixture, invalidation_lease lease;

select ok(
  (select completed from v2_completion_after_invalidation)
  and exists (
    select 1
    from public.google_calendar_connections connection
    where connection.id = true
      and connection.inbound_sync_token =
        'windowed-sync-token-after-invalidation'
      and connection.inbound_sync_contract_version = 2
      and connection.inbound_sync_timezone =
        'America/Argentina/Buenos_Aires'
      and connection.inbound_lease_token is null
      and connection.inbound_lease_sync_contract_version is null
  ),
  'la relectura v2 exacta avanza el token y limpia el lease pendiente'
);

update public.google_calendar_connections
set google_calendar_timezone = 'America/New_York'
where id = true;
create temporary table dst_window as
select timestamp '2026-10-25 00:00:00'
         at time zone 'America/New_York' as coverage_starts_at,
       timestamp '2026-11-15 00:00:00'
         at time zone 'America/New_York' as coverage_ends_at;
create temporary table dst_window_lease as
select lease.*
from window_fixture fixture, dst_window dst_bounds,
lateral public.begin_google_calendar_inbound_sync(
  fixture.generation, 240, 2,
  dst_bounds.coverage_starts_at, dst_bounds.coverage_ends_at
) lease;
select ok(
  (select lease_token is not null and sync_token is null
     from dst_window_lease)
  and (
    select extract(epoch from coverage_ends_at - coverage_starts_at) / 3600
      = 505
    from dst_window
  ),
  '21 días locales con cambio DST aceptan una duración absoluta de 505 horas'
);
select ok(
  (
    select public.complete_google_calendar_inbound_sync(
      fixture.generation, lease.lease_token,
      'windowed-sync-token-dst', '{}'::jsonb, 0, 2,
      dst_bounds.coverage_starts_at, dst_bounds.coverage_ends_at
    )
    from window_fixture fixture, dst_window dst_bounds, dst_window_lease lease
  ),
  'complete acepta exactamente la ventana local de 21 días que tomó el lease'
);
update public.google_calendar_connections
set google_calendar_timezone = 'America/Argentina/Buenos_Aires'
where id = true;

insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind, status,
  summary, starts_at, ends_at, all_day, recurring, unsupported_reason,
  google_etag, google_updated_at, content_hash
)
select 'calendar-window-id', occurrence_id, fixture.generation,
       'block', 'active', 'OCURRENCIA FICTICIA',
       fixture.inside_slot + offset_delta,
       fixture.inside_slot + offset_delta + interval '30 minutes',
       false, true, null,
       'etag-' || occurrence_id, clock_timestamp(), md5(occurrence_id)
from window_fixture fixture
cross join (values
  ('series-fixture-occurrence-a', interval '0 minutes'),
  ('series-fixture-occurrence-b', interval '1 day')
) occurrence(occurrence_id, offset_delta);

select is(
  (
    select count(*)::integer
    from public.google_calendar_external_events event
    where event.google_calendar_id = 'calendar-window-id'
      and event.google_event_id like 'series-fixture-occurrence-%'
  ),
  2,
  'dos ocurrencias de una serie conservan identidades independientes'
);

insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind, status,
  summary, starts_at, ends_at, all_day, recurring, unsupported_reason,
  google_etag, google_updated_at, content_hash
)
select 'calendar-window-id', 'ambiguous-busy-fixture', fixture.generation,
       'unsupported', 'active', 'EVENTO FICTICIO AMBIGUO',
       null, null, false, false, 'AMBIGUOUS_BUSY_STATE',
       'etag-ambiguous', clock_timestamp(), repeat('a', 32)
from window_fixture fixture;

select is(
  (
    select unsupported_reason
    from public.google_calendar_external_events event
    where event.google_calendar_id = 'calendar-window-id'
      and event.google_event_id = 'ambiguous-busy-fixture'
  ),
  'AMBIGUOUS_BUSY_STATE',
  'un estado busy ambiguo se conserva explícitamente en vez de ignorarse'
);

select * from finish();
rollback;
