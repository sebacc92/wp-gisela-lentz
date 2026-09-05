-- Selección explícita y atómica de Google Calendar.
--
-- OAuth sólo deja un candidato efímero. La conexión activa (si existe) sigue
-- intacta hasta que una Function haya vuelto a consultar Google, verificado
-- accessRole=owner y entregue la selección a `finalize_*`. El refresh token
-- nunca se guarda en una tabla pública: la tabla candidata sólo conserva el
-- UUID de Vault.

-- ---------------------------------------------------------------------------
-- 1. Candidato OAuth y alcance durable de una conexión
-- ---------------------------------------------------------------------------

create table public.google_calendar_connection_candidates (
  id boolean primary key default true check (id),
  candidate_id uuid not null default gen_random_uuid() unique,
  initiated_by uuid not null
    references public.profiles (id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'selecting')),
  google_account_id text not null
    check (char_length(google_account_id) between 1 and 255),
  google_account_email text not null
    check (char_length(google_account_email) between 3 and 320),
  connection_generation bigint not null check (connection_generation >= 0),
  oauth_attempt_generation bigint not null
    check (oauth_attempt_generation > 0),
  refresh_token_secret_id uuid not null unique,
  expires_at timestamptz not null,
  first_accessed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_calendar_candidate_expiry check (expires_at > created_at),
  constraint google_calendar_candidate_access check (
    (status = 'pending' and first_accessed_at is null)
    or (status = 'selecting' and first_accessed_at is not null)
  )
);

comment on table public.google_calendar_connection_candidates is
  'Candidato OAuth efímero. No altera la conexión activa y sólo referencia un secreto de Vault.';
comment on column public.google_calendar_connection_candidates.status is
  'selecting impide que otro callback cambie de cuenta durante la validación remota owner.';

alter table public.google_calendar_connection_candidates enable row level security;
revoke all on table public.google_calendar_connection_candidates
  from public, anon, authenticated;
grant all on table public.google_calendar_connection_candidates to service_role;

create trigger set_google_calendar_connection_candidates_updated_at
  before update on public.google_calendar_connection_candidates
  for each row execute function public.set_updated_at();

alter table public.google_calendar_connections
  add column google_calendar_timezone text
    check (
      google_calendar_timezone is null
      or char_length(google_calendar_timezone) between 1 and 255
    ),
  add column sync_scope_google_account_id text,
  add column sync_scope_google_calendar_id text,
  add column sync_scope_generation bigint,
  add column oauth_attempt_generation bigint not null default 0
    check (oauth_attempt_generation >= 0);

-- Un callback que ya consumió su state puede volver después de una
-- desconexión o de otro inicio OAuth. Los states previos al cutover no tienen
-- forma de demostrar a qué intento pertenecen, por lo que se invalidan.
alter table public.google_calendar_oauth_states
  add column connection_generation bigint,
  add column oauth_attempt_generation bigint;
delete from public.google_calendar_oauth_states;
alter table public.google_calendar_oauth_states
  alter column connection_generation set not null,
  alter column oauth_attempt_generation set not null,
  add constraint google_calendar_oauth_state_generations check (
    connection_generation >= 0 and oauth_attempt_generation > 0
  );

alter table public.google_calendar_sync_conflicts
  drop constraint google_calendar_sync_conflicts_kind_check,
  add constraint google_calendar_sync_conflicts_kind_check check (
    kind in (
      'reschedule_requested',
      'cancellation_requested',
      'metadata_changed'
    )
  );

comment on column public.google_calendar_connections.google_calendar_timezone is
  'Zona IANA devuelta por Google para el calendario owner seleccionado.';
comment on column public.google_calendar_connections.sync_scope_google_account_id is
  'Cuenta a la que pertenecen token incremental, aprobación, lease y resumen inbound.';
comment on column public.google_calendar_connections.sync_scope_google_calendar_id is
  'Calendario al que pertenecen token incremental, aprobación, lease y resumen inbound.';
comment on column public.google_calendar_connections.sync_scope_generation is
  'Generación a la que pertenecen token incremental, aprobación, lease y resumen inbound.';
comment on column public.google_calendar_connections.oauth_attempt_generation is
  'Epoch independiente que invalida callbacks OAuth consumidos pero todavía en vuelo.';
comment on column public.google_calendar_oauth_states.oauth_attempt_generation is
  'Intento OAuth vigente al crear el state; stage debe exigir coincidencia exacta.';

-- La implementación anterior no podía demostrar a qué cuenta pertenecía una
-- aprobación. El cutover descarta por seguridad todo estado inbound previo y
-- exige una nueva aprobación para el alcance activo.
update public.google_calendar_connections connection
set status = case
      when connection.status = 'connected' then 'reconnect_required'
      else connection.status
    end,
    google_calendar_timezone = case
      when connection.status in ('connected', 'reconnect_required') then
        coalesce(
          nullif(trim(connection.google_calendar_timezone), ''),
          (select settings.timezone from public.app_settings settings where settings.id = true),
          'America/Argentina/Buenos_Aires'
        )
      else null
    end,
    sync_scope_google_account_id = case
      when connection.status in ('connected', 'reconnect_required')
        and connection.google_account_id is not null
        and connection.google_calendar_id is not null
      then connection.google_account_id
      else null
    end,
    sync_scope_google_calendar_id = case
      when connection.status in ('connected', 'reconnect_required')
        and connection.google_account_id is not null
        and connection.google_calendar_id is not null
      then connection.google_calendar_id
      else null
    end,
    sync_scope_generation = case
      when connection.status in ('connected', 'reconnect_required')
        and connection.google_account_id is not null
        and connection.google_calendar_id is not null
      then connection.connection_generation + 1
      else null
    end,
    connection_generation = case
      when connection.status in ('connected', 'reconnect_required')
        then connection.connection_generation + 1
      else connection.connection_generation
    end,
    inbound_sync_token = null,
    inbound_sync_token_generation = null,
    inbound_sync_state = 'never_synced',
    inbound_first_import_approved_at = null,
    inbound_first_import_approved_by = null,
    inbound_lease_token = null,
    inbound_lease_expires_at = null,
    last_synced_at = null,
    last_error = null,
    last_checked_at = null,
    last_sync_completed_at = null,
    last_sync_summary = '{}'::jsonb,
    last_sync_error = null;

-- El esquema anterior sólo asociaba los bloqueos al calendar_id y no podía
-- demostrar la cuenta Google de origen. Ninguna fila inbound ni mapping
-- saliente se adopta implícitamente durante el cutover: la reautorización owner
-- y una primera importación completa vuelven a construir el alcance.
update public.google_calendar_external_events
set status = 'superseded',
    removed_at = coalesce(removed_at, clock_timestamp())
where status = 'active';

update public.google_calendar_sync_conflicts
set status = 'superseded',
    resolved_at = clock_timestamp()
where status = 'pending';

update public.google_calendar_sync_jobs
set status = 'cancelled',
    processing_started_at = null,
    last_error = 'CONNECTION_SCOPE_REAUTH_REQUIRED',
    google_event_id = null,
    google_etag = null,
    projected_operation = null,
    projected_starts_at = null,
    projected_ends_at = null;

-- El guard histórico conserva como pending un delete que estaba processing.
-- Una segunda pasada, ya sin mapping ni claim, lo deja definitivamente
-- cancelado sin deshabilitar defensas de tabla durante la migración.
update public.google_calendar_sync_jobs
set status = 'cancelled',
    processing_started_at = null,
    last_error = 'CONNECTION_SCOPE_REAUTH_REQUIRED'
where status <> 'cancelled';

-- Una fila histórica `disconnected` no representa una conexión reusable. Se
-- elimina cualquier credencial residual y también la identidad mostrable para
-- que una conexión futura empiece desde un alcance vacío.
delete from vault.secrets secret
using public.google_calendar_connections connection
where connection.id = true
  and connection.status not in ('connected', 'reconnect_required')
  and secret.id = connection.refresh_token_secret_id;

update public.google_calendar_connections
set connected_by = null,
    google_account_id = null,
    google_account_email = null,
    google_calendar_id = null,
    google_calendar_name = null,
    google_calendar_timezone = null,
    refresh_token_secret_id = null,
    connected_at = null,
    sync_scope_google_account_id = null,
    sync_scope_google_calendar_id = null,
    sync_scope_generation = null
where id = true and status not in ('connected', 'reconnect_required');

-- `google_calendar_status()` debe devolver una fila también antes de la
-- primera conexión.
insert into public.google_calendar_connections (id, status)
values (true, 'disconnected')
on conflict (id) do nothing;

alter table public.google_calendar_connections
  drop constraint google_calendar_connected_fields,
  add constraint google_calendar_sync_scope_all_or_none check (
    (
      sync_scope_google_account_id is null
      and sync_scope_google_calendar_id is null
      and sync_scope_generation is null
    )
    or (
      sync_scope_google_account_id is not null
      and sync_scope_google_calendar_id is not null
      and sync_scope_generation is not null
    )
  ),
  add constraint google_calendar_disconnected_fields_cleared check (
    status in ('connected', 'reconnect_required')
    or (
      connected_by is null
      and google_account_id is null
      and google_account_email is null
      and google_calendar_id is null
      and google_calendar_name is null
      and google_calendar_timezone is null
      and refresh_token_secret_id is null
      and connected_at is null
      and sync_scope_google_account_id is null
      and sync_scope_google_calendar_id is null
      and sync_scope_generation is null
      and inbound_sync_token is null
      and inbound_sync_token_generation is null
      and inbound_sync_state = 'never_synced'
      and inbound_first_import_approved_at is null
      and inbound_first_import_approved_by is null
      and inbound_lease_token is null
      and inbound_lease_expires_at is null
    )
  ),
  add constraint google_calendar_connected_fields check (
    status <> 'connected'
    or (
      google_account_id is not null
      and google_account_email is not null
      and google_calendar_id is not null
      and google_calendar_timezone is not null
      and refresh_token_secret_id is not null
      and sync_scope_google_account_id is not distinct from google_account_id
      and sync_scope_google_calendar_id is not distinct from google_calendar_id
      and sync_scope_generation = connection_generation
    )
  );

-- Un cambio de zona con Calendar activo haría que el worker proyecte usando
-- app_settings mientras el calendario seleccionado conserva otra zona. El
-- trigger de statement toma el mismo lock que finalize/disconnect ANTES de que
-- UPDATE bloquee la fila; el trigger por fila aplica luego la política segura.
create or replace function public.lock_google_calendar_timezone_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );
  return null;
end;
$$;

create trigger app_settings_google_calendar_timezone_lock
  before update of timezone on public.app_settings
  for each statement execute function public.lock_google_calendar_timezone_change();

create or replace function public.prevent_google_calendar_timezone_drift()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.timezone is distinct from old.timezone
    and exists (
      select 1
      from public.google_calendar_connections connection
      where connection.id = true
        and connection.status in ('connected', 'reconnect_required')
    )
  then
    raise exception 'GOOGLE_CALENDAR_TIMEZONE_CHANGE_REQUIRES_DISCONNECT'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger app_settings_prevent_google_calendar_timezone_drift
  before update of timezone on public.app_settings
  for each row execute function public.prevent_google_calendar_timezone_drift();

-- ---------------------------------------------------------------------------
-- 2. Ciclo de vida seguro del candidato
-- ---------------------------------------------------------------------------

create or replace function public.create_google_calendar_oauth_state(
  p_user_id uuid,
  p_state_hash text,
  p_code_verifier text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  current_connection_generation bigint;
  next_oauth_attempt_generation bigint;
  discarded_candidate_secret_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if p_user_id is null
    or p_state_hash !~ '^[0-9a-f]{64}$'
    or char_length(coalesce(p_code_verifier, '')) not between 43 and 128
    or p_expires_at <= clock_timestamp()
    or p_expires_at > clock_timestamp() + interval '15 minutes'
    or not exists (
      select 1 from public.profiles profile
      where profile.id = p_user_id and profile.active and profile.role = 'ADMIN'
    )
  then
    raise exception 'INVALID_OAUTH_STATE' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection_candidate', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );

  select candidate.refresh_token_secret_id
  into discarded_candidate_secret_id
  from public.google_calendar_connection_candidates candidate
  where candidate.id = true
  for update;

  update public.google_calendar_connections connection
  set oauth_attempt_generation = connection.oauth_attempt_generation + 1
  where connection.id = true
  returning connection.connection_generation,
            connection.oauth_attempt_generation
  into current_connection_generation, next_oauth_attempt_generation;
  if not found then
    raise exception 'GOOGLE_CALENDAR_CONNECTION_STATE_MISSING'
      using errcode = '55000';
  end if;

  -- Iniciar OAuth de nuevo reemplaza de forma explícita cualquier selección
  -- anterior, incluso si una respuesta de Google de ese intento sigue en vuelo.
  delete from public.google_calendar_connection_candidates where id = true;
  delete from vault.secrets where id = discarded_candidate_secret_id;
  delete from public.google_calendar_oauth_states
  where expires_at <= clock_timestamp() or user_id = p_user_id;

  insert into public.google_calendar_oauth_states (
    state_hash, user_id, code_verifier, expires_at,
    connection_generation, oauth_attempt_generation
  ) values (
    p_state_hash, p_user_id, p_code_verifier, p_expires_at,
    current_connection_generation, next_oauth_attempt_generation
  );
end;
$$;

-- Cambia el resultado de la versión histórica para transportar las dos
-- generaciones capturadas dentro de la misma transacción que creó el state.
drop function public.consume_google_calendar_oauth_state(text);
create function public.consume_google_calendar_oauth_state(
  p_state_hash text
)
returns table (
  user_id uuid,
  code_verifier text,
  connection_generation bigint,
  oauth_attempt_generation bigint
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  with consumed as (
    delete from public.google_calendar_oauth_states state
    where state.state_hash = p_state_hash
    returning state.user_id, state.code_verifier, state.expires_at,
              state.connection_generation, state.oauth_attempt_generation
  )
  select consumed.user_id, consumed.code_verifier,
         consumed.connection_generation, consumed.oauth_attempt_generation
  from consumed
  where consumed.expires_at > clock_timestamp()
    and exists (
      select 1 from public.profiles profile
      where profile.id = consumed.user_id and profile.active and profile.role = 'ADMIN'
    );
$$;

drop function public.get_google_calendar_connection_metadata();
create function public.get_google_calendar_connection_metadata()
returns table (
  status text,
  google_account_id text,
  google_calendar_id text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  return query
  select connection.status, connection.google_account_id,
         connection.google_calendar_id
  from public.google_calendar_connections connection
  where connection.id = true;
end;
$$;

create or replace function public.purge_expired_google_calendar_connection_candidate()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  expired_secret_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection_candidate', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );
  select candidate.refresh_token_secret_id
  into expired_secret_id
  from public.google_calendar_connection_candidates candidate
  where candidate.id = true
    and candidate.expires_at <= clock_timestamp()
  for update;

  if not found then return 0; end if;

  delete from public.google_calendar_connection_candidates where id = true;
  delete from vault.secrets where id = expired_secret_id;
  return 1;
end;
$$;

create or replace function public.stage_google_calendar_connection_candidate(
  p_user_id uuid,
  p_google_account_id text,
  p_google_account_email text,
  p_refresh_token text,
  p_expected_connection_generation bigint,
  p_expected_oauth_attempt_generation bigint
)
returns table (candidate_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  existing_candidate public.google_calendar_connection_candidates%rowtype;
  next_candidate_id uuid := gen_random_uuid();
  next_secret_id uuid;
  next_expires_at timestamptz;
  current_connection_generation bigint;
  current_oauth_attempt_generation bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
      select 1 from public.profiles profile
      where profile.id = p_user_id and profile.active and profile.role = 'ADMIN'
    )
    or char_length(trim(coalesce(p_google_account_id, ''))) not between 1 and 255
    or char_length(trim(coalesce(p_google_account_email, ''))) not between 3 and 320
    or coalesce(p_google_account_id, '') ~ E'[\\r\\n]'
    or coalesce(p_google_account_email, '') ~ E'[\\r\\n]'
    or char_length(coalesce(p_refresh_token, '')) not between 16 and 8192
    or coalesce(p_refresh_token, '') ~ E'[\\r\\n]'
    or p_expected_connection_generation is null
    or p_expected_connection_generation < 0
    or p_expected_oauth_attempt_generation is null
    or p_expected_oauth_attempt_generation <= 0
  then
    raise exception 'INVALID_GOOGLE_CONNECTION_CANDIDATE' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection_candidate', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );
  perform public.purge_expired_google_calendar_connection_candidate();

  select connection.connection_generation,
         connection.oauth_attempt_generation
  into current_connection_generation, current_oauth_attempt_generation
  from public.google_calendar_connections connection
  where connection.id = true
  for update;
  if not found
    or current_connection_generation is distinct from
      p_expected_connection_generation
    or current_oauth_attempt_generation is distinct from
      p_expected_oauth_attempt_generation
  then
    raise exception 'GOOGLE_CALENDAR_OAUTH_STATE_STALE'
      using errcode = '55000';
  end if;

  select * into existing_candidate
  from public.google_calendar_connection_candidates candidate
  where candidate.id = true
  for update;

  -- GET y POST pueden releer indefinidamente el mismo candidato. Sólo se
  -- bloquea el inicio de OTRO OAuth mientras una selección remota está en
  -- curso, cerrando la carrera cuenta A validada / cuenta B finalizada.
  if found and existing_candidate.status = 'selecting' then
    raise exception 'GOOGLE_CALENDAR_SELECTION_IN_PROGRESS'
      using errcode = '55000';
  end if;

  next_expires_at := clock_timestamp() + interval '15 minutes';

  next_secret_id := vault.create_secret(
    p_refresh_token,
    'google_calendar_candidate_' || next_candidate_id::text,
    'Temporary Google Calendar refresh token pending owner selection'
  );
  if next_secret_id is null then
    raise exception 'GOOGLE_CALENDAR_CANDIDATE_VAULT_WRITE_FAILED'
      using errcode = '55000';
  end if;

  insert into public.google_calendar_connection_candidates (
    id, candidate_id, initiated_by, status, google_account_id,
    google_account_email, connection_generation, oauth_attempt_generation,
    refresh_token_secret_id, expires_at, first_accessed_at
  ) values (
    true, next_candidate_id, p_user_id, 'pending',
    trim(p_google_account_id), trim(p_google_account_email),
    current_connection_generation, current_oauth_attempt_generation,
    next_secret_id, next_expires_at, null
  )
  on conflict (id) do update
  set candidate_id = excluded.candidate_id,
      initiated_by = excluded.initiated_by,
      status = 'pending',
      google_account_id = excluded.google_account_id,
      google_account_email = excluded.google_account_email,
      connection_generation = excluded.connection_generation,
      oauth_attempt_generation = excluded.oauth_attempt_generation,
      refresh_token_secret_id = excluded.refresh_token_secret_id,
      expires_at = excluded.expires_at,
      first_accessed_at = null,
      created_at = clock_timestamp();

  if existing_candidate.refresh_token_secret_id is not null
    and existing_candidate.refresh_token_secret_id <> next_secret_id
  then
    delete from vault.secrets
    where id = existing_candidate.refresh_token_secret_id;
  end if;

  insert into public.audit_logs (actor_user_id, action, entity_type, metadata)
  values (
    p_user_id,
    'google_calendar.selection_staged',
    'google_calendar',
    jsonb_build_object('expires_in_seconds', 900)
  );

  return query select next_candidate_id, next_expires_at;
end;
$$;

create or replace function public.get_google_calendar_connection_candidate_secret(
  p_user_id uuid
)
returns table (
  candidate_id uuid,
  google_account_id text,
  google_account_email text,
  refresh_token text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  selected_candidate public.google_calendar_connection_candidates%rowtype;
  decrypted_token text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_user_id and profile.active and profile.role = 'ADMIN'
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection_candidate', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );
  perform public.purge_expired_google_calendar_connection_candidate();

  update public.google_calendar_connection_candidates candidate
  set status = 'selecting',
      first_accessed_at = coalesce(candidate.first_accessed_at, clock_timestamp())
  where candidate.id = true
    and candidate.initiated_by = p_user_id
    and candidate.expires_at > clock_timestamp()
    and exists (
      select 1 from public.google_calendar_connections connection
      where connection.id = true
        and connection.connection_generation = candidate.connection_generation
        and connection.oauth_attempt_generation =
          candidate.oauth_attempt_generation
    )
  returning candidate.* into selected_candidate;

  if not found then return; end if;

  select secret.decrypted_secret
  into decrypted_token
  from vault.decrypted_secrets secret
  where secret.id = selected_candidate.refresh_token_secret_id;
  if coalesce(decrypted_token, '') = '' then
    raise exception 'GOOGLE_CALENDAR_CANDIDATE_SECRET_UNAVAILABLE'
      using errcode = '55000';
  end if;

  return query
  select selected_candidate.candidate_id,
         selected_candidate.google_account_id,
         selected_candidate.google_account_email,
         decrypted_token,
         selected_candidate.expires_at;
end;
$$;

create or replace function public.cancel_google_calendar_connection_candidate(
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  current_secret_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_user_id and profile.active and profile.role = 'ADMIN'
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection_candidate', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );
  select candidate.refresh_token_secret_id
  into current_secret_id
  from public.google_calendar_connection_candidates candidate
  where candidate.id = true
  for update;

  update public.google_calendar_connections connection
  set oauth_attempt_generation = connection.oauth_attempt_generation + 1
  where connection.id = true;
  if not found then
    raise exception 'GOOGLE_CALENDAR_CONNECTION_STATE_MISSING'
      using errcode = '55000';
  end if;

  delete from public.google_calendar_oauth_states oauth_state
  where oauth_state.user_id = p_user_id;
  delete from public.google_calendar_connection_candidates where id = true;
  delete from vault.secrets where id = current_secret_id;

  insert into public.audit_logs (actor_user_id, action, entity_type, metadata)
  values (
    p_user_id,
    'google_calendar.selection_cancelled',
    'google_calendar',
    jsonb_build_object('candidate_cleared', current_secret_id is not null)
  );
  return current_secret_id is not null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. El cambio de alcance ocurre una sola vez, al finalizar la selección
-- ---------------------------------------------------------------------------

create or replace function public.rescope_google_calendar_external_events()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.connection_generation is not distinct from old.connection_generation
    and new.status is not distinct from old.status
    and new.google_account_id is not distinct from old.google_account_id
    and new.google_calendar_id is not distinct from old.google_calendar_id
  then
    return new;
  end if;

  -- Sólo la misma cuenta Y el mismo calendario pueden adoptar historia al
  -- incrementar la generación (por ejemplo, una reautorización).
  if new.status in ('connected', 'reconnect_required')
    and new.google_account_id is not distinct from old.google_account_id
    and new.google_calendar_id is not distinct from old.google_calendar_id
  then
    update public.google_calendar_external_events
    set connection_generation = new.connection_generation
    where status = 'active'
      and google_calendar_id = new.google_calendar_id
      and connection_generation <> new.connection_generation;
    update public.google_calendar_sync_conflicts
    set connection_generation = new.connection_generation
    where status = 'pending'
      and connection_generation <> new.connection_generation;
    return new;
  end if;

  update public.google_calendar_external_events
  set status = 'superseded',
      removed_at = coalesce(removed_at, clock_timestamp())
  where status = 'active';

  update public.google_calendar_sync_conflicts
  set status = 'superseded', resolved_at = clock_timestamp()
  where status = 'pending';

  return new;
end;
$$;

-- Una credencial vencida detiene el I/O, pero no vuelve reservable un horario
-- ya bloqueado. El bloqueo se conserva mientras account/calendar/generation
-- sigan siendo exactamente los mismos.
create or replace function public.appointment_slot_is_available(
  p_professional_id uuid,
  p_starts_at timestamptz,
  p_duration_minutes integer,
  p_exclude_appointment_id uuid default null,
  p_timezone text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  settings public.app_settings%rowtype;
  effective_timezone text;
  buffer_minutes integer;
  local_start timestamp;
  local_end_with_buffer timestamp;
  local_date date;
  inside_working_window boolean;
  requested_range tstzrange;
begin
  if p_starts_at is null
    or p_duration_minutes is null
    or p_duration_minutes not between 5 and 480
    or not exists (
      select 1 from public.professionals professional
      where professional.id = p_professional_id and professional.active
    )
  then
    return false;
  end if;

  select * into settings from public.app_settings app_settings
  where app_settings.id = true;
  if not found then return false; end if;

  -- Entre seleccionar un calendario y terminar su primera importación todavía
  -- no conocemos todos los bloqueos de Google. También se cierra la agenda si
  -- el token quedó inválido o requiere un full resync: aceptar un turno en esa
  -- ventana podría duplicar una reserva ya existente fuera del sistema.
  if exists (
    select 1
    from public.google_calendar_connections connection
    where connection.id = true
      and connection.status in ('connected', 'reconnect_required')
      and not (
        connection.status = 'connected'
        and connection.inbound_sync_state = 'incremental'
        and connection.inbound_sync_token is not null
        and connection.inbound_sync_token_generation = connection.connection_generation
        and connection.inbound_first_import_approved_at is not null
        and connection.sync_scope_google_account_id is not distinct from
          connection.google_account_id
        and connection.sync_scope_google_calendar_id is not distinct from
          connection.google_calendar_id
        and connection.sync_scope_generation = connection.connection_generation
      )
  ) then
    return false;
  end if;

  -- Un all-day, recurrente o rango que todavía no sabemos representar no se
  -- interpreta como libre. Hasta que una persona lo retire/resuelva, cerrar la
  -- disponibilidad completa evita una doble reserva silenciosa.
  if exists (
    select 1
    from public.google_calendar_external_events external_event
    join public.google_calendar_connections connection
      on connection.id = true
     and connection.status = 'connected'
     and connection.google_calendar_id = external_event.google_calendar_id
     and connection.connection_generation = external_event.connection_generation
     and connection.sync_scope_google_account_id is not distinct from
       connection.google_account_id
     and connection.sync_scope_google_calendar_id is not distinct from
       connection.google_calendar_id
     and connection.sync_scope_generation = connection.connection_generation
    where external_event.kind = 'unsupported'
      and external_event.status = 'active'
  ) then
    return false;
  end if;

  effective_timezone := coalesce(nullif(trim(p_timezone), ''), settings.timezone);
  buffer_minutes := settings.appointment_buffer_minutes;
  begin
    local_start := p_starts_at at time zone effective_timezone;
    local_end_with_buffer := (
      p_starts_at + make_interval(mins => p_duration_minutes + buffer_minutes)
    ) at time zone effective_timezone;
  exception when invalid_parameter_value then
    return false;
  end;

  if p_starts_at < clock_timestamp()
      + make_interval(mins => settings.minimum_booking_notice_minutes)
    or local_start::date <> local_end_with_buffer::date
  then
    return false;
  end if;
  local_date := local_start::date;
  requested_range := tstzrange(
    p_starts_at,
    p_starts_at + make_interval(mins => p_duration_minutes + buffer_minutes),
    '[)'
  );

  select (
    exists (
      select 1 from public.availability_rules rule
      where rule.professional_id = p_professional_id
        and rule.active
        and rule.weekday = extract(dow from local_date)::smallint
        and local_start::time >= rule.start_time
        and local_end_with_buffer::time <= rule.end_time
    )
    or exists (
      select 1 from public.availability_exceptions availability_exception
      where availability_exception.professional_id = p_professional_id
        and availability_exception.date = local_date
        and availability_exception.type = 'available'
        and (
          (
            availability_exception.start_time is null
            and availability_exception.end_time is null
          )
          or (
            local_start::time >= availability_exception.start_time
            and local_end_with_buffer::time <= availability_exception.end_time
          )
        )
    )
  ) into inside_working_window;
  if not inside_working_window then return false; end if;

  if exists (
    select 1 from public.availability_exceptions availability_exception
    where availability_exception.professional_id = p_professional_id
      and availability_exception.date = local_date
      and availability_exception.type = 'unavailable'
      and (
        (
          availability_exception.start_time is null
          and availability_exception.end_time is null
        )
        or (
          availability_exception.start_time < local_end_with_buffer::time
          and availability_exception.end_time > local_start::time
        )
      )
  ) then
    return false;
  end if;

  if exists (
    select 1
    from public.google_calendar_external_events external_event
    join public.google_calendar_connections connection
      on connection.id = true
      and connection.status in ('connected', 'reconnect_required')
      and connection.google_calendar_id = external_event.google_calendar_id
      and connection.connection_generation = external_event.connection_generation
      and connection.sync_scope_google_account_id is not distinct from
        connection.google_account_id
      and connection.sync_scope_google_calendar_id is not distinct from
        connection.google_calendar_id
      and connection.sync_scope_generation = connection.connection_generation
    where external_event.kind = 'block'
      and (
        external_event.status = 'active'
        or (
          external_event.status = 'converted'
          and external_event.external_cleanup_status in ('pending', 'failed')
        )
      )
      and tstzrange(external_event.starts_at, external_event.ends_at, '[)')
        && requested_range
  ) then
    return false;
  end if;

  if exists (
    select 1 from public.appointments appointment
    where appointment.professional_id = p_professional_id
      and (
        p_exclude_appointment_id is null
        or appointment.id <> p_exclude_appointment_id
      )
      and (
        appointment.status = 'confirmed'
        or (
          appointment.status = 'scheduled'
          and (
            appointment.deposit_status in ('proof_received', 'not_required')
            or (
              appointment.deposit_status = 'pending'
              and appointment.hold_expires_at > clock_timestamp()
            )
          )
        )
      )
      and tstzrange(
        appointment.starts_at,
        appointment.ends_at + make_interval(mins => buffer_minutes),
        '[)'
      ) && requested_range
  ) then
    return false;
  end if;

  return true;
end;
$$;

create or replace function public.finalize_google_calendar_connection_selection(
  p_user_id uuid,
  p_candidate_id uuid,
  p_google_calendar_id text,
  p_google_calendar_name text,
  p_google_calendar_timezone text
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  selected_candidate public.google_calendar_connection_candidates%rowtype;
  old_connection public.google_calendar_connections%rowtype;
  configured_timezone text;
  old_secret_id uuid;
  candidate_secret_exists boolean;
  next_generation bigint;
  scope_changed boolean;
  clean_calendar_id text := trim(coalesce(p_google_calendar_id, ''));
  clean_calendar_name text := nullif(trim(coalesce(p_google_calendar_name, '')), '');
  clean_timezone text := trim(coalesce(p_google_calendar_timezone, ''));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_user_id and profile.active and profile.role = 'ADMIN'
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_candidate_id is null
    or char_length(clean_calendar_id) not between 1 and 1024
    or coalesce(clean_calendar_name, '') = ''
    or char_length(clean_calendar_name) > 255
    or char_length(clean_timezone) not between 1 and 255
    or clean_calendar_id ~ E'[\\r\\n]'
    or clean_calendar_name ~ E'[\\r\\n]'
    or clean_timezone ~ E'[\\r\\n]'
    or not exists (
      select 1 from pg_timezone_names timezone
      where timezone.name = clean_timezone
    )
  then
    raise exception 'INVALID_GOOGLE_CALENDAR_SELECTION' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection_candidate', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );
  perform public.purge_expired_google_calendar_connection_candidate();

  -- El trigger de app_settings toma el mismo advisory lock antes de cualquier
  -- UPDATE de timezone. FOR UPDATE mantiene estable el valor hasta el commit.
  select settings.timezone
  into configured_timezone
  from public.app_settings settings
  where settings.id = true
  for update;
  if not found or clean_timezone is distinct from configured_timezone then
    raise exception 'INVALID_GOOGLE_CALENDAR_SELECTION' using errcode = '22023';
  end if;

  select * into selected_candidate
  from public.google_calendar_connection_candidates candidate
  where candidate.id = true
    and candidate.candidate_id = p_candidate_id
    and candidate.initiated_by = p_user_id
    and candidate.status = 'selecting'
    and candidate.expires_at > clock_timestamp()
    and exists (
      select 1 from public.google_calendar_connections connection
      where connection.id = true
        and connection.connection_generation = candidate.connection_generation
        and connection.oauth_attempt_generation =
          candidate.oauth_attempt_generation
    )
  for update;
  if not found then
    -- Un retry que llegó después del commit anterior es idempotente. Sólo se
    -- acepta si ya está activo exactamente el mismo calendario y zona; jamás
    -- se crea ni se cambia una conexión sin candidato.
    select connection.connection_generation
    into next_generation
    from public.google_calendar_connections connection
    where connection.id = true
      and connection.status = 'connected'
      and connection.google_calendar_id = clean_calendar_id
      and connection.google_calendar_timezone = clean_timezone;
    if found then return next_generation; end if;
    raise exception 'GOOGLE_CALENDAR_SELECTION_NOT_READY' using errcode = '55000';
  end if;

  select exists (
    select 1 from vault.decrypted_secrets secret
    where secret.id = selected_candidate.refresh_token_secret_id
      and coalesce(secret.decrypted_secret, '') <> ''
  ) into candidate_secret_exists;
  if not candidate_secret_exists then
    raise exception 'GOOGLE_CALENDAR_CANDIDATE_SECRET_UNAVAILABLE'
      using errcode = '55000';
  end if;

  -- claim toma este mismo advisory lock. Un claim ya confirmado antes del lock
  -- queda visible como processing y obliga a reintentar el cutover; uno nuevo
  -- no puede aparecer hasta que finalize termine. Claims abandonados recuperan
  -- la misma ventana de diez minutos que usa el worker.
  update public.google_calendar_sync_jobs job
  set status = 'pending',
      processing_started_at = null,
      available_at = clock_timestamp(),
      last_error = 'STALE_CLAIM_RECOVERED'
  where job.status = 'processing'
    and (
      job.processing_started_at is null
      or job.processing_started_at <= clock_timestamp() - interval '10 minutes'
    );
  if exists (
    select 1 from public.google_calendar_sync_jobs job
    where job.status = 'processing'
  ) then
    raise exception 'GOOGLE_CALENDAR_SYNC_IN_PROGRESS' using errcode = '55000';
  end if;

  select * into old_connection
  from public.google_calendar_connections connection
  where connection.id = true
  for update;

  if old_connection.inbound_lease_token is not null
    and old_connection.inbound_lease_expires_at > clock_timestamp()
  then
    raise exception 'GOOGLE_CALENDAR_SYNC_IN_PROGRESS' using errcode = '55000';
  end if;

  -- Un cambio de cuenta debe pasar por disconnect para que la Function pueda
  -- capturar y revocar el token anterior. Borrar ese secreto desde finalize
  -- dejaría un grant remoto huérfano e imposible de reintentar.
  if old_connection.status in ('connected', 'reconnect_required')
    and old_connection.google_account_id is distinct from
      selected_candidate.google_account_id
  then
    raise exception 'GOOGLE_CALENDAR_DISCONNECT_REQUIRED'
      using errcode = '55000';
  end if;

  old_secret_id := old_connection.refresh_token_secret_id;
  next_generation := greatest(coalesce(old_connection.connection_generation, 0) + 1, 1);
  scope_changed :=
    old_connection.google_account_id is distinct from selected_candidate.google_account_id
    or old_connection.google_calendar_id is distinct from clean_calendar_id;

  insert into public.google_calendar_connections (
    id, status, connected_by, google_account_id, google_account_email,
    google_calendar_id, google_calendar_name, google_calendar_timezone,
    refresh_token_secret_id, connected_at, disconnected_at,
    last_synced_at, last_error, connection_generation,
    inbound_sync_token, inbound_sync_token_generation, inbound_sync_state,
    inbound_first_import_approved_at, inbound_first_import_approved_by,
    inbound_lease_token, inbound_lease_expires_at,
    last_checked_at, last_sync_completed_at, last_sync_summary,
    last_sync_error, sync_scope_google_account_id,
    sync_scope_google_calendar_id, sync_scope_generation
  ) values (
    true, 'connected', p_user_id, selected_candidate.google_account_id,
    selected_candidate.google_account_email, clean_calendar_id,
    clean_calendar_name, clean_timezone,
    selected_candidate.refresh_token_secret_id, clock_timestamp(), null,
    null, null, next_generation,
    null, null, 'awaiting_first_import', null, null, null, null,
    null, null, '{}'::jsonb, null,
    selected_candidate.google_account_id, clean_calendar_id, next_generation
  )
  on conflict (id) do update
  set status = 'connected',
      connected_by = excluded.connected_by,
      google_account_id = excluded.google_account_id,
      google_account_email = excluded.google_account_email,
      google_calendar_id = excluded.google_calendar_id,
      google_calendar_name = excluded.google_calendar_name,
      google_calendar_timezone = excluded.google_calendar_timezone,
      refresh_token_secret_id = excluded.refresh_token_secret_id,
      connected_at = excluded.connected_at,
      disconnected_at = null,
      last_synced_at = null,
      last_error = null,
      connection_generation = excluded.connection_generation,
      inbound_sync_token = null,
      inbound_sync_token_generation = null,
      inbound_sync_state = 'awaiting_first_import',
      inbound_first_import_approved_at = null,
      inbound_first_import_approved_by = null,
      inbound_lease_token = null,
      inbound_lease_expires_at = null,
      last_checked_at = null,
      last_sync_completed_at = null,
      last_sync_summary = '{}'::jsonb,
      last_sync_error = null,
      sync_scope_google_account_id = excluded.sync_scope_google_account_id,
      sync_scope_google_calendar_id = excluded.sync_scope_google_calendar_id,
      sync_scope_generation = excluded.sync_scope_generation;

  -- Ningún claim de la generación anterior puede completar luego del switch.
  update public.google_calendar_sync_jobs job
  set status = case
        when job.status in ('pending', 'processing', 'failed') then 'cancelled'
        else job.status
      end,
      processing_started_at = null,
      last_error = case
        when job.status in ('pending', 'processing', 'failed')
          then 'CONNECTION_GENERATION_REPLACED'
        else job.last_error
      end,
      google_event_id = case when scope_changed then null else job.google_event_id end,
      google_etag = case when scope_changed then null else job.google_etag end,
      projected_operation = case when scope_changed then null else job.projected_operation end,
      projected_starts_at = case when scope_changed then null else job.projected_starts_at end,
      projected_ends_at = case when scope_changed then null else job.projected_ends_at end
  where job.connection_generation <> next_generation;

  -- Un calendario nuevo recibe solamente turnos confirmados y futuros. Nunca
  -- se proyecta un scheduled sin seña ni se transportan deletes/mappings de la
  -- cuenta anterior.
  insert into public.google_calendar_sync_jobs as current_job (
    appointment_id, operation, desired_version, connection_generation,
    status, attempts, available_at, processing_started_at, last_error
  )
  select appointment.id, 'upsert', 1, next_generation,
         'pending', 0, clock_timestamp(), null, null
  from public.appointments appointment
  where appointment.status = 'confirmed'
    and appointment.ends_at > clock_timestamp()
  on conflict (appointment_id) do update
  set operation = 'upsert',
      desired_version = current_job.desired_version + 1,
      connection_generation = next_generation,
      status = 'pending',
      attempts = 0,
      available_at = clock_timestamp(),
      processing_started_at = null,
      last_error = null;

  delete from public.google_calendar_connection_candidates where id = true;
  if old_secret_id is not null
    and old_secret_id <> selected_candidate.refresh_token_secret_id
  then
    delete from vault.secrets where id = old_secret_id;
  end if;

  insert into public.audit_logs (actor_user_id, action, entity_type, metadata)
  values (
    p_user_id,
    'google_calendar.connected',
    'google_calendar',
    jsonb_build_object(
      'calendar_name', clean_calendar_name,
      'timezone', clean_timezone,
      'scope_changed', scope_changed,
      'generation', next_generation
    )
  );

  return next_generation;
end;
$$;

-- El callback histórico elegía un calendario sin interacción. Mantener esta
-- firma como error explícito evita que una Function vieja saltee la selección
-- owner durante un despliegue escalonado.
create or replace function public.complete_google_calendar_connection(
  p_user_id uuid,
  p_google_account_id text,
  p_google_account_email text,
  p_google_calendar_id text,
  p_google_calendar_name text,
  p_refresh_token text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  raise exception 'GOOGLE_CALENDAR_SELECTION_REQUIRED' using errcode = '55000';
end;
$$;

-- Captura ambos tokens y limpia ambos carriles bajo los mismos locks. El
-- endpoint recibe los tokens recién después del commit y puede revocarlos sin
-- que un callback intermedio deje un candidato distinto sin cubrir.
create or replace function public.disconnect_google_calendar_with_secrets(
  p_user_id uuid
)
returns table (
  active_refresh_token text,
  candidate_refresh_token text
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  active_secret_id uuid;
  candidate_secret_id uuid;
  captured_active_token text;
  captured_candidate_token text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_user_id and profile.active and profile.role = 'ADMIN'
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection_candidate', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );

  update public.google_calendar_sync_jobs job
  set status = 'pending',
      processing_started_at = null,
      available_at = clock_timestamp(),
      last_error = 'STALE_CLAIM_RECOVERED'
  where job.status = 'processing'
    and (
      job.processing_started_at is null
      or job.processing_started_at <= clock_timestamp() - interval '10 minutes'
    );
  if exists (
    select 1 from public.google_calendar_sync_jobs job
    where job.status = 'processing'
  ) then
    raise exception 'GOOGLE_CALENDAR_SYNC_IN_PROGRESS' using errcode = '55000';
  end if;

  select connection.refresh_token_secret_id
  into active_secret_id
  from public.google_calendar_connections connection
  where connection.id = true
  for update;

  if exists (
    select 1 from public.google_calendar_connections connection
    where connection.id = true
      and connection.inbound_lease_token is not null
      and connection.inbound_lease_expires_at > clock_timestamp()
  ) then
    raise exception 'GOOGLE_CALENDAR_SYNC_IN_PROGRESS' using errcode = '55000';
  end if;

  select candidate.refresh_token_secret_id
  into candidate_secret_id
  from public.google_calendar_connection_candidates candidate
  where candidate.id = true
  for update;

  select nullif(secret.decrypted_secret, '')
  into captured_active_token
  from vault.decrypted_secrets secret
  where secret.id = active_secret_id;
  select nullif(secret.decrypted_secret, '')
  into captured_candidate_token
  from vault.decrypted_secrets secret
  where secret.id = candidate_secret_id;

  update public.google_calendar_connections
  set status = 'disconnected',
      connected_by = null,
      google_account_id = null,
      google_account_email = null,
      google_calendar_id = null,
      google_calendar_name = null,
      google_calendar_timezone = null,
      refresh_token_secret_id = null,
      connected_at = null,
      disconnected_at = clock_timestamp(),
      last_synced_at = null,
      last_error = null,
      connection_generation = connection_generation + 1,
      oauth_attempt_generation = oauth_attempt_generation + 1,
      inbound_sync_token = null,
      inbound_sync_token_generation = null,
      inbound_sync_state = 'never_synced',
      inbound_first_import_approved_at = null,
      inbound_first_import_approved_by = null,
      inbound_lease_token = null,
      inbound_lease_expires_at = null,
      last_checked_at = null,
      last_sync_completed_at = null,
      last_sync_summary = '{}'::jsonb,
      last_sync_error = null,
      sync_scope_google_account_id = null,
      sync_scope_google_calendar_id = null,
      sync_scope_generation = null
  where id = true;

  update public.google_calendar_sync_jobs job
  set status = case
        when job.status in ('pending', 'processing', 'failed') then 'cancelled'
        else job.status
      end,
      processing_started_at = null,
      last_error = case
        when job.status in ('pending', 'processing', 'failed')
          then 'CALENDAR_DISCONNECTED'
        else job.last_error
      end,
      google_event_id = null,
      google_etag = null,
      projected_operation = null,
      projected_starts_at = null,
      projected_ends_at = null;

  delete from public.google_calendar_oauth_states oauth_state
  where oauth_state.user_id = p_user_id;
  delete from public.google_calendar_connection_candidates where id = true;
  delete from vault.secrets secret
  where secret.id = active_secret_id
     or secret.id = candidate_secret_id;

  insert into public.audit_logs (actor_user_id, action, entity_type, metadata)
  values (
    p_user_id,
    'google_calendar.disconnected',
    'google_calendar',
    jsonb_build_object('candidate_cleared', candidate_secret_id is not null)
  );

  return query select captured_active_token, captured_candidate_token;
end;
$$;

-- Compatibilidad con callers históricos que no revocaban el candidato. La
-- Function nueva debe usar `disconnect_google_calendar_with_secrets`.
create or replace function public.disconnect_google_calendar(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform 1
  from public.disconnect_google_calendar_with_secrets(p_user_id);
end;
$$;

create or replace function public.guard_google_calendar_confirmed_appointment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_appointment_status public.appointment_status;
  external_event_may_exist boolean := false;
begin
  select appointment.status into current_appointment_status
  from public.appointments appointment
  where appointment.id = new.appointment_id;

  if current_appointment_status <> 'confirmed' then
    new.operation := 'delete';
    external_event_may_exist :=
      new.google_event_id is not null
      or new.projected_operation = 'upsert'
      or new.attempts > 0
      or new.status = 'processing'
      or (
        tg_op = 'UPDATE'
        and (
          old.google_event_id is not null
          or old.projected_operation = 'upsert'
          or old.attempts > 0
          or old.status = 'processing'
        )
      );

    if new.status = 'processing' then
      -- El request ya reclamado puede seguir en vuelo. Su versión nueva queda
      -- marcada como delete; complete/fail liberará después ese delete.
      new.last_error := coalesce(
        new.last_error, 'DELETE_AFTER_IN_FLIGHT_UPSERT'
      );
    elsif external_event_may_exist then
      new.status := 'pending';
      new.processing_started_at := null;
      new.last_error := null;
    else
      new.status := 'cancelled';
      new.processing_started_at := null;
      new.last_error := 'APPOINTMENT_NOT_CONFIRMED';
    end if;
  end if;
  return new;
end;
$$;

-- La proyección saliente del MVP contiene sólo turnos confirmados. Un turno
-- scheduled nuevo no crea ni siquiera una fila fantasma en el outbox. Si un
-- turno deja de estar confirmado, sólo se encola delete cuando hay evidencia
-- de que Google pudo haber recibido el evento (mapping, proyección o intento).
create or replace function public.enqueue_google_calendar_appointment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_generation bigint;
  existing_job public.google_calendar_sync_jobs%rowtype;
  next_operation text;
  external_event_may_exist boolean := false;
begin
  select connection.connection_generation
  into current_generation
  from public.google_calendar_connections connection
  where connection.id = true
    and connection.status = 'connected'
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = connection.connection_generation;
  if not found then return new; end if;

  if new.status = 'confirmed' then
    next_operation := 'upsert';
  else
    select * into existing_job
    from public.google_calendar_sync_jobs job
    where job.appointment_id = new.id
    for update;
    if not found then return new; end if;

    external_event_may_exist :=
      existing_job.google_event_id is not null
      or existing_job.projected_operation = 'upsert'
      or existing_job.attempts > 0
      or existing_job.status = 'processing';
    if not external_event_may_exist then
      delete from public.google_calendar_sync_jobs job
      where job.appointment_id = new.id;
      return new;
    end if;
    next_operation := 'delete';
  end if;

  insert into public.google_calendar_sync_jobs as current_job (
    appointment_id, operation, desired_version, status, attempts,
    available_at, processing_started_at, last_error, connection_generation
  ) values (
    new.id, next_operation, 1, 'pending', 0,
    clock_timestamp(), null, null, current_generation
  )
  on conflict (appointment_id) do update
  set operation = excluded.operation,
      desired_version = current_job.desired_version + 1,
      status = case
        when current_job.status = 'processing' then 'processing'
        else 'pending'
      end,
      attempts = case
        when current_job.status = 'processing' then current_job.attempts
        else 0
      end,
      available_at = clock_timestamp(),
      processing_started_at = case
        when current_job.status = 'processing'
          then current_job.processing_started_at
        else null
      end,
      last_error = case
        when current_job.status = 'processing'
          and current_job.operation = 'upsert'
          and excluded.operation = 'delete'
        then 'DELETE_AFTER_IN_FLIGHT_UPSERT'
        else null
      end,
      connection_generation = greatest(
        current_job.connection_generation,
        excluded.connection_generation
      );

  return new;
end;
$$;

create or replace function public.enqueue_google_calendar_contact_appointments()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.name is not distinct from new.name then return new; end if;

  insert into public.google_calendar_sync_jobs as current_job (
    appointment_id, operation, desired_version, status, attempts,
    available_at, processing_started_at, last_error, connection_generation
  )
  select appointment.id, 'upsert', 1, 'pending', 0,
         clock_timestamp(), null, null, connection.connection_generation
  from public.appointments appointment
  join public.google_calendar_connections connection
    on connection.id = true
   and connection.status = 'connected'
   and connection.sync_scope_google_account_id is not distinct from
     connection.google_account_id
   and connection.sync_scope_google_calendar_id is not distinct from
     connection.google_calendar_id
   and connection.sync_scope_generation = connection.connection_generation
  where appointment.contact_id = new.id
    and appointment.status = 'confirmed'
    and appointment.ends_at > clock_timestamp()
  on conflict (appointment_id) do update
  set operation = 'upsert',
      desired_version = current_job.desired_version + 1,
      status = case
        when current_job.status = 'processing' then 'processing'
        else 'pending'
      end,
      attempts = case
        when current_job.status = 'processing' then current_job.attempts
        else 0
      end,
      available_at = clock_timestamp(),
      processing_started_at = case
        when current_job.status = 'processing'
          then current_job.processing_started_at
        else null
      end,
      last_error = null,
      connection_generation = greatest(
        current_job.connection_generation,
        excluded.connection_generation
      );

  return new;
end;
$$;

create or replace function public.reconcile_google_calendar_sync()
returns table (queued bigint, already_queued bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );
  if not exists (
    select 1 from public.google_calendar_connections connection
    where connection.id = true
      and connection.status = 'connected'
      and connection.sync_scope_google_account_id is not distinct from
        connection.google_account_id
      and connection.sync_scope_google_calendar_id is not distinct from
        connection.google_calendar_id
      and connection.sync_scope_generation = connection.connection_generation
  ) then
    return query select 0::bigint, 0::bigint;
    return;
  end if;

  return query
  with candidates as materialized (
    select appointment.id as appointment_id,
      case when appointment.status = 'confirmed' then 'upsert' else 'delete' end
        as operation
    from public.appointments appointment
    left join public.google_calendar_sync_jobs job
      on job.appointment_id = appointment.id
    where (
      appointment.status = 'confirmed'
      and appointment.ends_at > clock_timestamp()
    ) or (
      appointment.status <> 'confirmed'
      and (
        job.google_event_id is not null
        or job.projected_operation = 'upsert'
        or job.attempts > 0
        or job.status = 'processing'
      )
    )
  ), changed as (
    insert into public.google_calendar_sync_jobs as current_job (
      appointment_id, operation, desired_version, status, attempts,
      available_at, processing_started_at, last_error, connection_generation
    )
    select candidate.appointment_id, candidate.operation, 1, 'pending', 0,
           clock_timestamp(), null, null, connection.connection_generation
    from candidates candidate
    join public.google_calendar_connections connection
      on connection.id = true
     and connection.status = 'connected'
     and connection.sync_scope_google_account_id is not distinct from
       connection.google_account_id
     and connection.sync_scope_google_calendar_id is not distinct from
       connection.google_calendar_id
     and connection.sync_scope_generation = connection.connection_generation
    on conflict (appointment_id) do update
    set operation = excluded.operation,
        desired_version = current_job.desired_version + 1,
        status = case
          when current_job.status = 'processing' then 'processing'
          else 'pending'
        end,
        attempts = case
          when current_job.status = 'processing' then current_job.attempts
          else 0
        end,
        available_at = clock_timestamp(),
        processing_started_at = case
          when current_job.status = 'processing'
            then current_job.processing_started_at
          else null
        end,
        last_error = null,
        connection_generation = greatest(
          current_job.connection_generation,
          excluded.connection_generation
        )
    where current_job.operation is distinct from excluded.operation
       or current_job.connection_generation is distinct from
          excluded.connection_generation
       or current_job.status = 'cancelled'
       or (
         excluded.operation = 'upsert'
         and current_job.status = 'succeeded'
         and current_job.updated_at < clock_timestamp() - interval '1 hour'
       )
    returning appointment_id
  )
  select (select count(*) from changed),
         (select count(*) from candidates) - (select count(*) from changed);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Todo estado inbound se valida contra cuenta + calendario + generación
-- ---------------------------------------------------------------------------

-- Serializa el instante de claim con finalize/disconnect. El lock termina al
-- devolver las filas: durante el I/O remoto el status=processing es el lease
-- durable que hace que un cutover responda SYNC_IN_PROGRESS.
create or replace function public.claim_google_calendar_sync_jobs(
  p_limit integer default 10,
  p_expected_generation bigint default null
)
returns table (
  job_id uuid,
  appointment_id uuid,
  operation text,
  desired_version bigint,
  attempts integer,
  starts_at timestamptz,
  ends_at timestamptz,
  patient_name text,
  timezone text,
  connection_generation bigint,
  google_etag text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );

  if not exists (
    select 1 from public.google_calendar_connections connection
    where connection.id = true
      and connection.status = 'connected'
      and connection.connection_generation = p_expected_generation
      and connection.sync_scope_google_account_id is not distinct from
        connection.google_account_id
      and connection.sync_scope_google_calendar_id is not distinct from
        connection.google_calendar_id
      and connection.sync_scope_generation = p_expected_generation
  ) then return; end if;

  update public.google_calendar_sync_jobs job
  set status = 'pending',
      processing_started_at = null,
      available_at = clock_timestamp(),
      last_error = 'STALE_CLAIM_RECOVERED'
  where job.status = 'processing'
    and job.connection_generation = p_expected_generation
    and (
      job.processing_started_at is null
      or job.processing_started_at < clock_timestamp() - interval '10 minutes'
    );

  return query
  with due as (
    select job.id, job.appointment_id
    from public.google_calendar_sync_jobs job
    join public.appointments appointment
      on appointment.id = job.appointment_id
    where job.status = 'pending'
      and job.available_at <= clock_timestamp()
      and job.connection_generation = p_expected_generation
      and (
        (job.operation = 'upsert' and appointment.status = 'confirmed')
        or (job.operation = 'delete' and appointment.status <> 'confirmed')
      )
      and not (
        job.operation = 'upsert'
        and exists (
          select 1 from public.google_calendar_sync_conflicts conflict
          where conflict.appointment_id = job.appointment_id
            and conflict.status = 'pending'
            and conflict.connection_generation = p_expected_generation
        )
      )
      -- El primer pull y el primer push ocurren dentro de la misma invocación.
      -- Si Google ya tiene un bloqueo manual solapado, crear además el evento
      -- administrado duplicaría la reserva. La única excepción es el bloqueo
      -- que este mismo turno acaba de adoptar: necesita poder crear su evento
      -- sustituto antes de retirar el manual. Un evento no soportado cierra
      -- todos los upserts hasta resolución humana, igual que disponibilidad.
      and not (
        job.operation = 'upsert'
        and exists (
          select 1
          from public.google_calendar_external_events external_event
          join public.google_calendar_connections current_connection
            on current_connection.id = true
           and current_connection.status = 'connected'
           and current_connection.google_calendar_id =
             external_event.google_calendar_id
           and current_connection.connection_generation =
             external_event.connection_generation
           and current_connection.connection_generation = p_expected_generation
           and current_connection.sync_scope_google_account_id is not distinct from
             current_connection.google_account_id
           and current_connection.sync_scope_google_calendar_id is not distinct from
             current_connection.google_calendar_id
           and current_connection.sync_scope_generation = p_expected_generation
          where (
            external_event.kind = 'unsupported'
            and external_event.status = 'active'
          ) or (
            external_event.kind = 'block'
            and (
              external_event.status = 'active'
              or (
                external_event.status = 'converted'
                and external_event.external_cleanup_status in ('pending', 'failed')
              )
            )
            and not (
              external_event.status = 'converted'
              and external_event.converted_appointment_id = job.appointment_id
            )
            and tstzrange(
              external_event.starts_at, external_event.ends_at, '[)'
            ) && tstzrange(appointment.starts_at, appointment.ends_at, '[)')
          )
        )
      )
      and exists (
        select 1 from public.google_calendar_connections connection
        where connection.id = true
          and connection.status = 'connected'
          and connection.connection_generation = p_expected_generation
          and connection.sync_scope_google_account_id is not distinct from
            connection.google_account_id
          and connection.sync_scope_google_calendar_id is not distinct from
            connection.google_calendar_id
          and connection.sync_scope_generation = p_expected_generation
      )
    order by job.available_at, job.updated_at
    for update of job skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 20))
  ), claimed as (
    update public.google_calendar_sync_jobs job
    set status = 'processing',
        attempts = job.attempts + 1,
        processing_started_at = clock_timestamp()
    from due
    where job.id = due.id
    returning job.*
  )
  select claimed.id, claimed.appointment_id, claimed.operation,
         claimed.desired_version, claimed.attempts,
         appointment.starts_at, appointment.ends_at, contact.name,
         settings.timezone, connection.connection_generation,
         claimed.google_etag
  from claimed
  join public.appointments appointment on appointment.id = claimed.appointment_id
  join public.contacts contact on contact.id = appointment.contact_id
  join public.app_settings settings on settings.id = true
  join public.google_calendar_connections connection
    on connection.id = true
   and connection.status = 'connected'
   and connection.connection_generation = p_expected_generation
   and connection.sync_scope_google_account_id is not distinct from
     connection.google_account_id
   and connection.sync_scope_google_calendar_id is not distinct from
     connection.google_calendar_id
   and connection.sync_scope_generation = p_expected_generation;
end;
$$;

create or replace function public.begin_google_calendar_inbound_sync(
  p_expected_generation bigint,
  p_lease_seconds integer default 240
)
returns table (
  lease_token uuid,
  sync_token text,
  sync_state text,
  first_import_approved boolean,
  google_calendar_id text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  granted_lease uuid := gen_random_uuid();
  safe_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 240), 900));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('google_calendar_connection', 0)
  );

  return query
  update public.google_calendar_connections connection
  set inbound_lease_token = granted_lease,
      inbound_lease_expires_at =
        clock_timestamp() + make_interval(secs => safe_lease_seconds)
  where connection.id = true
    and connection.status = 'connected'
    and connection.connection_generation = p_expected_generation
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = p_expected_generation
    and (
      connection.inbound_lease_expires_at is null
      or connection.inbound_lease_expires_at <= clock_timestamp()
    )
  returning granted_lease,
    case
      when connection.inbound_sync_token_generation = p_expected_generation
        then connection.inbound_sync_token
      else null
    end,
    case
      when connection.inbound_sync_token_generation is distinct from p_expected_generation
        and connection.inbound_sync_state = 'incremental'
        then 'full_resync_required'
      else connection.inbound_sync_state
    end,
    connection.inbound_first_import_approved_at is not null,
    connection.google_calendar_id;
end;
$$;

create or replace function public.release_google_calendar_inbound_lease(
  p_expected_generation bigint,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  update public.google_calendar_connections connection
  set inbound_lease_token = null,
      inbound_lease_expires_at = null
  where connection.id = true
    and connection.connection_generation = p_expected_generation
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = p_expected_generation
    and connection.inbound_lease_token = p_lease_token;
  return found;
end;
$$;

create or replace function public.assert_google_calendar_inbound_lease(
  p_expected_generation bigint,
  p_lease_token uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1 from public.google_calendar_connections connection
    where connection.id = true
      and connection.status = 'connected'
      and connection.connection_generation = p_expected_generation
      and connection.sync_scope_google_account_id is not distinct from
        connection.google_account_id
      and connection.sync_scope_google_calendar_id is not distinct from
        connection.google_calendar_id
      and connection.sync_scope_generation = p_expected_generation
      and connection.inbound_lease_token = p_lease_token
      and connection.inbound_lease_expires_at > clock_timestamp()
  ) then
    raise exception 'GOOGLE_CALENDAR_INBOUND_LEASE_LOST' using errcode = '42501';
  end if;
end;
$$;

-- `events.list(timeMin=now)` no devuelve un evento administrado que alguien
-- movió al pasado. Durante un full resync el worker pagina este inventario y
-- puede hacer `events.get` para los candidatos no vistos, sin abrir toda la
-- historia del calendario (que incluiría recurring/all-day antiguos). El lease
-- hace estable cuenta/calendario/generación mientras dura esa auditoría.
create or replace function public.list_google_calendar_full_resync_managed_candidates(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_after_appointment_id uuid default null,
  p_limit integer default 100
)
returns table (
  appointment_id uuid,
  google_event_id text,
  remote_known boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );

  return query
  select appointment.id,
         nullif(trim(coalesce(job.google_event_id, '')), ''),
         coalesce((
           nullif(trim(coalesce(job.google_event_id, '')), '') is not null
           and job.projected_operation = 'upsert'
           and job.projected_starts_at is not null
           and job.projected_ends_at is not null
           and job.projected_starts_at < job.projected_ends_at
         ), false)
  from public.google_calendar_sync_jobs job
  join public.appointments appointment on appointment.id = job.appointment_id
  join public.google_calendar_connections connection
    on connection.id = true
   and connection.status = 'connected'
   and connection.connection_generation = p_expected_generation
   and connection.sync_scope_google_account_id is not distinct from
     connection.google_account_id
   and connection.sync_scope_google_calendar_id is not distinct from
     connection.google_calendar_id
   and connection.sync_scope_generation = p_expected_generation
  where job.connection_generation = p_expected_generation
    and appointment.status = 'confirmed'
    and appointment.ends_at > clock_timestamp()
    and (
      p_after_appointment_id is null
      or appointment.id > p_after_appointment_id
    )
  order by appointment.id
  limit greatest(1, least(coalesce(p_limit, 100), 200));
end;
$$;

create or replace function public.complete_google_calendar_inbound_sync(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_next_sync_token text,
  p_summary jsonb,
  p_changes integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  clean_token text := nullif(trim(coalesce(p_next_sync_token, '')), '');
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  update public.google_calendar_connections connection
  set inbound_sync_token = coalesce(clean_token, connection.inbound_sync_token),
      inbound_sync_token_generation = case
        when clean_token is not null then p_expected_generation
        else connection.inbound_sync_token_generation
      end,
      inbound_sync_state = case
        when clean_token is not null then 'incremental'
        else connection.inbound_sync_state
      end,
      last_checked_at = clock_timestamp(),
      last_sync_completed_at = clock_timestamp(),
      last_synced_at = case
        when coalesce(p_changes, 0) > 0 then clock_timestamp()
        else connection.last_synced_at
      end,
      last_sync_summary = public.sanitized_google_calendar_summary(p_summary),
      last_sync_error = null,
      inbound_lease_token = null,
      inbound_lease_expires_at = null
  where connection.id = true
    and connection.status = 'connected'
    and connection.connection_generation = p_expected_generation
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = p_expected_generation
    and connection.inbound_lease_token = p_lease_token;
  return found;
end;
$$;

create or replace function public.fail_google_calendar_inbound_sync(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_error_code text,
  p_summary jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  clean_error text := upper(trim(coalesce(p_error_code, '')));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if clean_error !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'INVALID_SYNC_FAILURE' using errcode = '22023';
  end if;

  update public.google_calendar_connections connection
  set last_checked_at = clock_timestamp(),
      last_sync_error = clean_error,
      last_sync_summary = public.sanitized_google_calendar_summary(p_summary),
      inbound_lease_token = null,
      inbound_lease_expires_at = null
  where connection.id = true
    and connection.status = 'connected'
    and connection.connection_generation = p_expected_generation
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = p_expected_generation
    and connection.inbound_lease_token = p_lease_token;
  return found;
end;
$$;

create or replace function public.invalidate_google_calendar_sync_token(
  p_expected_generation bigint,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  update public.google_calendar_connections connection
  set inbound_sync_token = null,
      inbound_sync_token_generation = null,
      inbound_sync_state = 'full_resync_required'
  where connection.id = true
    and connection.status = 'connected'
    and connection.connection_generation = p_expected_generation
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = p_expected_generation
    and connection.inbound_lease_token = p_lease_token;
  return found;
end;
$$;

create or replace function public.approve_google_calendar_first_import(
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_user_id and profile.active and profile.role = 'ADMIN'
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  update public.google_calendar_connections connection
  set inbound_first_import_approved_at =
        coalesce(connection.inbound_first_import_approved_at, clock_timestamp()),
      inbound_first_import_approved_by =
        coalesce(connection.inbound_first_import_approved_by, p_user_id)
  where connection.id = true
    and connection.status = 'connected'
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = connection.connection_generation;
  if not found then return false; end if;

  insert into public.audit_logs (actor_user_id, action, entity_type, metadata)
  values (
    p_user_id,
    'google_calendar.inbound_import_approved',
    'google_calendar',
    jsonb_build_object(
      'generation', (
        select connection.connection_generation
        from public.google_calendar_connections connection where connection.id = true
      )
    )
  );
  return true;
end;
$$;

create or replace function public.record_google_calendar_sync_attempt(
  p_expected_generation bigint,
  p_summary jsonb,
  p_changes integer,
  p_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  clean_note text := nullif(upper(trim(coalesce(p_note, ''))), '');
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if clean_note is not null and clean_note !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'INVALID_SYNC_FAILURE' using errcode = '22023';
  end if;

  update public.google_calendar_connections connection
  set last_checked_at = clock_timestamp(),
      last_sync_summary = public.sanitized_google_calendar_summary(p_summary),
      last_sync_error = clean_note,
      last_synced_at = case
        when coalesce(p_changes, 0) > 0 then clock_timestamp()
        else connection.last_synced_at
      end
  where connection.id = true
    and connection.status = 'connected'
    and connection.connection_generation = p_expected_generation
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = p_expected_generation;
  return found;
end;
$$;

create or replace function public.mark_google_calendar_reconnect_required(
  p_error_code text,
  p_expected_generation bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  clean_error text := upper(trim(coalesce(p_error_code, '')));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if clean_error !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'INVALID_SYNC_FAILURE' using errcode = '22023';
  end if;
  update public.google_calendar_connections connection
  set status = 'reconnect_required',
      last_error = clean_error,
      inbound_lease_token = null,
      inbound_lease_expires_at = null
  where connection.id = true
    and connection.connection_generation = p_expected_generation
    and connection.sync_scope_generation = p_expected_generation;
end;
$$;

-- Una conversión sólo es terminal dentro de la generación que la creó. Si el
-- mismo event ID reaparece al importar una generación nueva, Google demuestra
-- que el evento manual todavía existe: vuelve a ser un bloqueo activo del scope
-- actual y no hereda appointment/cleanup de la conexión anterior.
create or replace function public.apply_google_calendar_external_event(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_google_event_id text,
  p_kind text,
  p_removed boolean,
  p_summary text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_all_day boolean,
  p_recurring boolean,
  p_unsupported_reason text,
  p_google_etag text,
  p_google_updated_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  clean_event_id text := trim(coalesce(p_google_event_id, ''));
  clean_summary text := nullif(
    left(regexp_replace(coalesce(p_summary, ''), '[[:cntrl:]]+', ' ', 'g'), 120),
    ''
  );
  current_calendar_id text;
  existing public.google_calendar_external_events%rowtype;
  next_hash text;
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );
  if clean_event_id = '' or char_length(clean_event_id) > 1024 then
    raise exception 'GOOGLE_EXTERNAL_EVENT_INVALID' using errcode = '22023';
  end if;

  select connection.google_calendar_id into current_calendar_id
  from public.google_calendar_connections connection
  where connection.id = true
    and connection.status = 'connected'
    and connection.connection_generation = p_expected_generation
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = p_expected_generation;
  if current_calendar_id is null then
    raise exception 'CALENDAR_NOT_CONNECTED' using errcode = 'P0001';
  end if;

  select * into existing
  from public.google_calendar_external_events external_event
  where external_event.google_calendar_id = current_calendar_id
    and external_event.google_event_id = clean_event_id
  for update;

  if found
    and existing.status = 'converted'
    and existing.connection_generation = p_expected_generation
  then
    return 'skipped_converted';
  end if;

  if coalesce(p_removed, false) then
    if not found or existing.status <> 'active' then
      return 'already_removed';
    end if;
    update public.google_calendar_external_events external_event
    set status = 'removed',
        removed_at = clock_timestamp(),
        google_etag = p_google_etag,
        google_updated_at = p_google_updated_at
    where external_event.google_calendar_id = current_calendar_id
      and external_event.google_event_id = clean_event_id;
    return 'removed';
  end if;

  if p_kind not in ('block', 'unsupported') then
    raise exception 'GOOGLE_EXTERNAL_EVENT_INVALID' using errcode = '22023';
  end if;
  if p_kind = 'block'
    and (p_starts_at is null or p_ends_at is null or p_starts_at >= p_ends_at)
  then
    raise exception 'GOOGLE_EXTERNAL_EVENT_INVALID' using errcode = '22023';
  end if;
  if (p_kind = 'unsupported') <> (p_unsupported_reason is not null) then
    raise exception 'GOOGLE_EXTERNAL_EVENT_INVALID' using errcode = '22023';
  end if;

  next_hash := md5(
    p_kind
    || '|' || coalesce(clean_summary, '')
    || '|' || coalesce(p_starts_at::text, '')
    || '|' || coalesce(p_ends_at::text, '')
    || '|' || coalesce(p_all_day, false)::text
    || '|' || coalesce(p_recurring, false)::text
    || '|' || coalesce(p_unsupported_reason, '')
  );

  if found
    and existing.status = 'active'
    and existing.content_hash = next_hash
    and existing.connection_generation = p_expected_generation
  then
    return 'unchanged';
  end if;

  insert into public.google_calendar_external_events (
    google_calendar_id, google_event_id, connection_generation, kind, status,
    summary, starts_at, ends_at, all_day, recurring, unsupported_reason,
    google_etag, google_updated_at, content_hash, converted_appointment_id,
    external_cleanup_status, external_cleanup_error, removed_at
  ) values (
    current_calendar_id, clean_event_id, p_expected_generation, p_kind,
    'active', clean_summary, p_starts_at, p_ends_at, coalesce(p_all_day, false),
    coalesce(p_recurring, false), p_unsupported_reason,
    p_google_etag, p_google_updated_at, next_hash, null,
    'not_required', null, null
  )
  on conflict (google_calendar_id, google_event_id) do update
  set connection_generation = p_expected_generation,
      kind = excluded.kind,
      status = 'active',
      summary = excluded.summary,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      all_day = excluded.all_day,
      recurring = excluded.recurring,
      unsupported_reason = excluded.unsupported_reason,
      google_etag = excluded.google_etag,
      google_updated_at = excluded.google_updated_at,
      content_hash = excluded.content_hash,
      converted_appointment_id = null,
      external_cleanup_status = 'not_required',
      external_cleanup_error = null,
      removed_at = null;

  return case when existing.google_event_id is null then 'created' else 'updated' end;
end;
$$;

-- La conversión adopta el evento manual. Mientras su cleanup esté pendiente o
-- fallido, el bloqueo convertido continúa ocupando disponibilidad. Normalmente
-- se borra después de exportar el evento sustituto; si el turno se cancela o el
-- hold vence antes de tener mapping, también debe borrarse por su ID manual. Un
-- fallo es reintentable y permanece fail-closed hasta confirmación de Google.
create or replace function public.claim_google_calendar_external_cleanup(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_limit integer default 3
)
returns table (google_event_id text, appointment_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );
  return query
  select event.google_event_id, event.converted_appointment_id
  from public.google_calendar_external_events event
  join public.google_calendar_connections connection
    on connection.id = true
   and connection.status = 'connected'
   and connection.google_calendar_id = event.google_calendar_id
   and connection.connection_generation = p_expected_generation
   and connection.sync_scope_google_account_id is not distinct from
     connection.google_account_id
   and connection.sync_scope_google_calendar_id is not distinct from
     connection.google_calendar_id
   and connection.sync_scope_generation = p_expected_generation
  join public.appointments appointment
    on appointment.id = event.converted_appointment_id
  left join public.google_calendar_sync_jobs job
    on job.appointment_id = event.converted_appointment_id
   and job.connection_generation = p_expected_generation
  where event.external_cleanup_status in ('pending', 'failed')
    and event.connection_generation = p_expected_generation
    and event.status = 'converted'
    and (
      (
        job.google_event_id is not null
        and job.projected_operation = 'upsert'
      )
      or appointment.status not in ('scheduled', 'confirmed')
      or (
        appointment.status = 'scheduled'
        and appointment.deposit_status = 'pending'
        and appointment.hold_expires_at is not null
        and appointment.hold_expires_at <= clock_timestamp()
        and not public.appointment_has_timely_deposit_proof_work(
          appointment.id, clock_timestamp()
        )
      )
    )
  order by event.updated_at
  limit greatest(1, least(coalesce(p_limit, 3), 10));
end;
$$;

create or replace function public.complete_google_calendar_external_cleanup(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_google_event_id text,
  p_succeeded boolean,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  clean_error text := nullif(upper(trim(coalesce(p_error_code, ''))), '');
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );
  if clean_error is not null and clean_error !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'INVALID_SYNC_FAILURE' using errcode = '22023';
  end if;

  update public.google_calendar_external_events event
  set external_cleanup_status = case when p_succeeded then 'done' else 'failed' end,
      external_cleanup_error = case when p_succeeded then null else clean_error end
  where event.google_event_id = p_google_event_id
    and event.external_cleanup_status in ('pending', 'failed')
    and event.connection_generation = p_expected_generation
    and exists (
      select 1 from public.google_calendar_connections connection
      where connection.id = true
        and connection.status = 'connected'
        and connection.google_calendar_id = event.google_calendar_id
        and connection.connection_generation = p_expected_generation
        and connection.sync_scope_google_account_id is not distinct from
          connection.google_account_id
        and connection.sync_scope_google_calendar_id is not distinct from
          connection.google_calendar_id
        and connection.sync_scope_generation = p_expected_generation
    );
  return found;
end;
$$;

-- Un cambio de título, visibilidad u otro metadato de un evento administrado
-- no debe ser pisado silenciosamente por la siguiente reproyección. Google no
-- expone un diff semántico estable para todos esos campos, pero su ETag sí
-- cambia. Se compara contra el ETag conocido ANTES de actualizarlo. Si Google
-- omite el ETag tampoco existe una precondición segura para hacer PATCH: se
-- abre el mismo conflicto fail-closed y se conserva el ETag local. Incluso si
-- hay un push interno pendiente se abre conflicto, porque podría pisar una
-- edición externa que ya llegó a Google.
create or replace function public.observe_google_calendar_managed_event(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_google_event_id text,
  p_appointment_id uuid,
  p_cancelled boolean,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_google_updated_at timestamptz,
  p_google_etag text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  appointment_row public.appointments%rowtype;
  job_row public.google_calendar_sync_jobs%rowtype;
  job_found boolean := false;
  conflict_kind text;
  matches_appointment boolean;
  matches_projection boolean;
  stored_etag text;
  observed_etag text := nullif(trim(coalesce(p_google_etag, '')), '');
  baseline_missing boolean := false;
  metadata_changed boolean := false;
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );

  select * into appointment_row
  from public.appointments appointment
  where appointment.id = p_appointment_id;
  if not found then return 'ignored_unknown_appointment'; end if;

  select * into job_row
  from public.google_calendar_sync_jobs job
  where job.appointment_id = p_appointment_id
    and job.connection_generation = p_expected_generation
  for update;
  job_found := found;
  stored_etag := nullif(trim(coalesce(job_row.google_etag, '')), '');
  baseline_missing :=
    job_found
    and (
      stored_etag is null
      or job_row.projected_operation is distinct from 'upsert'
      or job_row.projected_starts_at is null
      or job_row.projected_ends_at is null
    );
  metadata_changed :=
    job_found
    and (
      observed_etag is null
      or baseline_missing
      or stored_etag is distinct from observed_etag
    );

  -- Guardar el ETag observado permite que reject restaure la proyección con
  -- If-Match sobre la versión que una persona acaba de revisar.
  if job_found and (coalesce(p_cancelled, false) or observed_etag is not null) then
    update public.google_calendar_sync_jobs job
    set google_etag = observed_etag
    where job.appointment_id = p_appointment_id
      and job.connection_generation = p_expected_generation;
  end if;

  if appointment_row.status not in ('scheduled', 'confirmed') then
    return 'ignored_final_appointment';
  end if;

  -- Cancelación y cambio horario externo conservan precedencia sobre un cambio
  -- de ETag. Una coincidencia con la última proyección conocida no es un cambio
  -- horario externo, pero todavía puede contener metadatos ajenos.
  if coalesce(p_cancelled, false) then
    if job_row.projected_operation = 'delete'
      or (
        job_row.operation = 'delete'
        and job_row.status in ('pending', 'processing')
      )
    then
      return 'in_sync';
    end if;
    conflict_kind := 'cancellation_requested';
  else
    matches_appointment :=
      p_starts_at is not distinct from appointment_row.starts_at
      and p_ends_at is not distinct from appointment_row.ends_at;
    matches_projection :=
      job_row.projected_starts_at is not null
      and p_starts_at is not distinct from job_row.projected_starts_at
      and p_ends_at is not distinct from job_row.projected_ends_at;

    if not matches_appointment and not matches_projection then
      if p_starts_at is null
        or p_ends_at is null
        or p_starts_at >= p_ends_at
      then
        return 'ignored_invalid_range';
      end if;
      conflict_kind := 'reschedule_requested';
    elsif metadata_changed then
      conflict_kind := 'metadata_changed';
    elsif matches_appointment then
      return 'in_sync';
    else
      return 'pending_push';
    end if;
  end if;

  insert into public.google_calendar_sync_conflicts as current_conflict (
    appointment_id, google_event_id, kind, status,
    proposed_starts_at, proposed_ends_at,
    observed_starts_at, observed_ends_at,
    google_updated_at, connection_generation
  ) values (
    p_appointment_id, p_google_event_id, conflict_kind, 'pending',
    case when conflict_kind = 'reschedule_requested' then p_starts_at end,
    case when conflict_kind = 'reschedule_requested' then p_ends_at end,
    appointment_row.starts_at, appointment_row.ends_at,
    p_google_updated_at, p_expected_generation
  )
  on conflict (appointment_id) where status = 'pending' do update
  set google_event_id = excluded.google_event_id,
      kind = excluded.kind,
      proposed_starts_at = excluded.proposed_starts_at,
      proposed_ends_at = excluded.proposed_ends_at,
      observed_starts_at = excluded.observed_starts_at,
      observed_ends_at = excluded.observed_ends_at,
      google_updated_at = excluded.google_updated_at,
      connection_generation = excluded.connection_generation,
      detected_at = clock_timestamp()
  where current_conflict.kind is distinct from excluded.kind
     or current_conflict.proposed_starts_at is distinct from excluded.proposed_starts_at
     or current_conflict.proposed_ends_at is distinct from excluded.proposed_ends_at
     or current_conflict.google_updated_at is distinct from excluded.google_updated_at;

  return case when found then 'conflict_recorded' else 'conflict_pending' end;
end;
$$;

-- Un conflicto puramente de metadatos no tiene una traducción segura a una
-- mutación de turno. Sólo puede rechazarse (restaurar la proyección de la app)
-- desde la agenda; nunca se interpreta como una reprogramación con fecha null.
create or replace function public.apply_google_calendar_conflict(
  p_conflict_id uuid
)
returns public.google_calendar_sync_conflicts
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  conflict_row public.google_calendar_sync_conflicts%rowtype;
  result public.google_calendar_sync_conflicts;
begin
  if not public.current_user_is_admin() or auth.uid() is null then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select * into conflict_row
  from public.google_calendar_sync_conflicts conflict
  where conflict.id = p_conflict_id
  for update;
  if not found or conflict_row.status <> 'pending' then
    raise exception 'CONFLICT_NOT_PENDING' using errcode = 'P0001';
  end if;
  if conflict_row.kind = 'metadata_changed' then
    raise exception 'GOOGLE_CALENDAR_METADATA_CONFLICT_REQUIRES_RESTORE'
      using errcode = '55000';
  end if;

  if conflict_row.kind = 'cancellation_requested' then
    perform public.update_appointment_status(
      conflict_row.appointment_id, 'cancelled'::public.appointment_status
    );
  else
    perform public.reschedule_appointment(
      conflict_row.appointment_id, conflict_row.proposed_starts_at
    );
  end if;

  update public.google_calendar_sync_conflicts conflict
  set status = 'applied',
      resolved_at = clock_timestamp(),
      resolved_by = auth.uid(),
      resolution_error = null
  where conflict.id = p_conflict_id
  returning * into result;

  perform public.enqueue_google_calendar_projection(conflict_row.appointment_id);
  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(), 'google_calendar.conflict_applied', 'appointment',
    conflict_row.appointment_id,
    jsonb_build_object('conflict_id', p_conflict_id, 'kind', conflict_row.kind)
  );
  return result;
end;
$$;

-- `p_starts_at` es una precondición optimista, no un horario editable: el
-- drawer lo leyó junto al bloqueo. Si Google movió el evento mientras estaba
-- abierto, el lock detecta la versión vieja y obliga a refrescar antes de crear
-- un turno. Mantener la firma evita una transición insegura de clientes.
create or replace function public.convert_google_calendar_block_to_appointment(
  p_google_event_id text,
  p_contact_id uuid,
  p_professional_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz default null,
  p_internal_note text default null
)
returns table (appointment_id uuid, created boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_calendar_id text;
  current_generation bigint;
  block_row public.google_calendar_external_events%rowtype;
  new_appointment public.appointments;
begin
  if not public.current_user_is_admin() or auth.uid() is null then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select connection.google_calendar_id, connection.connection_generation
  into current_calendar_id, current_generation
  from public.google_calendar_connections connection
  where connection.id = true
    and connection.status = 'connected'
    and connection.sync_scope_google_account_id is not distinct from
      connection.google_account_id
    and connection.sync_scope_google_calendar_id is not distinct from
      connection.google_calendar_id
    and connection.sync_scope_generation = connection.connection_generation;
  if current_calendar_id is null then
    raise exception 'CALENDAR_NOT_CONNECTED' using errcode = 'P0001';
  end if;

  select * into block_row
  from public.google_calendar_external_events event
  where event.google_calendar_id = current_calendar_id
    and event.google_event_id = p_google_event_id
    and event.connection_generation = current_generation
  for update;
  if not found then
    raise exception 'CALENDAR_BLOCK_NOT_FOUND' using errcode = 'P0002';
  end if;

  if block_row.status = 'converted' then
    return query select block_row.converted_appointment_id, false;
    return;
  end if;
  if block_row.status <> 'active' or block_row.kind <> 'block' then
    raise exception 'CALENDAR_BLOCK_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if p_starts_at is null or p_starts_at is distinct from block_row.starts_at then
    raise exception 'CALENDAR_BLOCK_STALE' using errcode = '55000';
  end if;

  update public.google_calendar_external_events event
  set status = 'removed', removed_at = clock_timestamp()
  where event.google_calendar_id = current_calendar_id
    and event.google_event_id = p_google_event_id
    and event.connection_generation = current_generation;

  new_appointment := public.create_service_appointment(
    p_contact_id, p_professional_id, p_service_id, block_row.starts_at,
    'manual'::public.appointment_source, p_internal_note
  );

  update public.google_calendar_external_events event
  set status = 'converted',
      converted_appointment_id = new_appointment.id,
      external_cleanup_status = 'pending',
      external_cleanup_error = null
  where event.google_calendar_id = current_calendar_id
    and event.google_event_id = p_google_event_id
    and event.connection_generation = current_generation;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(), 'google_calendar.block_converted', 'appointment',
    new_appointment.id, jsonb_build_object('cleanup', 'pending')
  );

  return query select new_appointment.id, true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Estado operativo sin filtrar historia de otro alcance
-- ---------------------------------------------------------------------------

drop function public.google_calendar_status();

create or replace function public.google_calendar_status()
returns table (
  connected boolean,
  status text,
  selection_pending boolean,
  google_account_email text,
  google_calendar_name text,
  google_calendar_timezone text,
  last_synced_at timestamptz,
  last_checked_at timestamptz,
  last_sync_completed_at timestamptz,
  last_sync_summary jsonb,
  last_sync_error text,
  last_error text,
  inbound_sync_state text,
  inbound_first_import_approved boolean,
  pending_count bigint,
  failed_count bigint,
  active_block_count bigint,
  unsupported_event_count bigint,
  pending_conflict_count bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  perform public.purge_expired_google_calendar_connection_candidate();

  return query
  select connection.status = 'connected',
         connection.status,
         exists (
           select 1
           from public.google_calendar_connection_candidates candidate
           join public.google_calendar_connections current_connection
             on current_connection.id = true
            and current_connection.connection_generation =
              candidate.connection_generation
            and current_connection.oauth_attempt_generation =
              candidate.oauth_attempt_generation
           where candidate.id = true
             and candidate.expires_at > clock_timestamp()
         ),
         connection.google_account_email,
         connection.google_calendar_name,
         connection.google_calendar_timezone,
         connection.last_synced_at,
         connection.last_checked_at,
         connection.last_sync_completed_at,
         connection.last_sync_summary,
         connection.last_sync_error,
         connection.last_error,
         connection.inbound_sync_state,
         connection.inbound_first_import_approved_at is not null
           and connection.sync_scope_google_account_id is not distinct from
             connection.google_account_id
           and connection.sync_scope_google_calendar_id is not distinct from
             connection.google_calendar_id
           and connection.sync_scope_generation = connection.connection_generation,
         (select count(*) from public.google_calendar_sync_jobs job
          where job.status in ('pending', 'processing')
            and job.connection_generation = connection.connection_generation),
         (select count(*) from public.google_calendar_sync_jobs job
          where job.status = 'failed'
            and job.connection_generation = connection.connection_generation),
         (select count(*) from public.google_calendar_external_events event
          where event.kind = 'block'
            and (
              event.status = 'active'
              or (
                event.status = 'converted'
                and event.external_cleanup_status in ('pending', 'failed')
              )
            )
            and event.google_calendar_id = connection.google_calendar_id
            and event.connection_generation = connection.connection_generation),
         (select count(*) from public.google_calendar_external_events event
          where event.kind = 'unsupported' and event.status = 'active'
            and event.google_calendar_id = connection.google_calendar_id
            and event.connection_generation = connection.connection_generation),
         (select count(*) from public.google_calendar_sync_conflicts conflict
          where conflict.status = 'pending'
            and conflict.connection_generation = connection.connection_generation)
  from public.google_calendar_connections connection
  where connection.id = true;
end;
$$;

-- Los roles de navegador sólo ven filas del alcance actualmente conectado.
-- La policy no consulta `google_calendar_connections` como authenticated (esa
-- tabla deliberadamente no tiene SELECT): un helper booleano SECURITY DEFINER
-- aplica el scope sin exponer identidad, calendario ni generación actuales.
create or replace function public.current_user_can_read_google_calendar_scope(
  p_google_calendar_id text,
  p_connection_generation bigint
)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select public.current_user_is_admin()
    and exists (
      select 1
      from public.google_calendar_connections connection
      where connection.id = true
        and connection.status in ('connected', 'reconnect_required')
        and connection.connection_generation = p_connection_generation
        and (
          p_google_calendar_id is null
          or connection.google_calendar_id = p_google_calendar_id
        )
        and connection.sync_scope_google_account_id is not distinct from
          connection.google_account_id
        and connection.sync_scope_google_calendar_id is not distinct from
          connection.google_calendar_id
        and connection.sync_scope_generation = connection.connection_generation
    );
$$;

drop policy google_calendar_external_events_read
  on public.google_calendar_external_events;
create policy google_calendar_external_events_read
  on public.google_calendar_external_events
  for select to authenticated
  using (
    public.current_user_can_read_google_calendar_scope(
      google_calendar_external_events.google_calendar_id,
      google_calendar_external_events.connection_generation
    )
  );

drop policy google_calendar_sync_conflicts_read
  on public.google_calendar_sync_conflicts;
create policy google_calendar_sync_conflicts_read
  on public.google_calendar_sync_conflicts
  for select to authenticated
  using (
    public.current_user_can_read_google_calendar_scope(
      null::text,
      google_calendar_sync_conflicts.connection_generation
    )
  );

-- ---------------------------------------------------------------------------
-- 6. Superficie de ejecución: únicamente service_role
-- ---------------------------------------------------------------------------

do $$
declare
  signature regprocedure;
begin
  for signature in
    select procedure_oid
    from (values
      ('public.create_google_calendar_oauth_state(uuid,text,text,timestamptz)'::regprocedure),
      ('public.consume_google_calendar_oauth_state(text)'::regprocedure),
      ('public.lock_google_calendar_timezone_change()'::regprocedure),
      ('public.prevent_google_calendar_timezone_drift()'::regprocedure),
      ('public.get_google_calendar_connection_metadata()'::regprocedure),
      ('public.purge_expired_google_calendar_connection_candidate()'::regprocedure),
      ('public.stage_google_calendar_connection_candidate(uuid,text,text,text,bigint,bigint)'::regprocedure),
      ('public.get_google_calendar_connection_candidate_secret(uuid)'::regprocedure),
      ('public.cancel_google_calendar_connection_candidate(uuid)'::regprocedure),
      ('public.finalize_google_calendar_connection_selection(uuid,uuid,text,text,text)'::regprocedure),
      ('public.complete_google_calendar_connection(uuid,text,text,text,text,text)'::regprocedure),
      ('public.disconnect_google_calendar_with_secrets(uuid)'::regprocedure),
      ('public.disconnect_google_calendar(uuid)'::regprocedure),
      ('public.guard_google_calendar_confirmed_appointment()'::regprocedure),
      ('public.enqueue_google_calendar_appointment()'::regprocedure),
      ('public.enqueue_google_calendar_contact_appointments()'::regprocedure),
      ('public.reconcile_google_calendar_sync()'::regprocedure),
      ('public.claim_google_calendar_sync_jobs(integer,bigint)'::regprocedure),
      ('public.begin_google_calendar_inbound_sync(bigint,integer)'::regprocedure),
      ('public.release_google_calendar_inbound_lease(bigint,uuid)'::regprocedure),
      ('public.assert_google_calendar_inbound_lease(bigint,uuid)'::regprocedure),
      ('public.list_google_calendar_full_resync_managed_candidates(bigint,uuid,uuid,integer)'::regprocedure),
      ('public.complete_google_calendar_inbound_sync(bigint,uuid,text,jsonb,integer)'::regprocedure),
      ('public.fail_google_calendar_inbound_sync(bigint,uuid,text,jsonb)'::regprocedure),
      ('public.invalidate_google_calendar_sync_token(bigint,uuid)'::regprocedure),
      ('public.approve_google_calendar_first_import(uuid)'::regprocedure),
      ('public.record_google_calendar_sync_attempt(bigint,jsonb,integer,text)'::regprocedure),
      ('public.mark_google_calendar_reconnect_required(text,bigint)'::regprocedure),
      ('public.claim_google_calendar_external_cleanup(bigint,uuid,integer)'::regprocedure),
      ('public.complete_google_calendar_external_cleanup(bigint,uuid,text,boolean,text)'::regprocedure),
      ('public.observe_google_calendar_managed_event(bigint,uuid,text,uuid,boolean,timestamptz,timestamptz,timestamptz,text)'::regprocedure),
      ('public.google_calendar_status()'::regprocedure)
    ) functions(procedure_oid)
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated',
      signature
    );
    execute format('grant execute on function %s to service_role', signature);
  end loop;
end;
$$;

revoke execute on function public.rescope_google_calendar_external_events()
  from public, anon, authenticated;

revoke execute on function public.current_user_can_read_google_calendar_scope(
  text, bigint
) from public, anon;
grant execute on function public.current_user_can_read_google_calendar_scope(
  text, bigint
) to authenticated, service_role;

revoke execute on function public.convert_google_calendar_block_to_appointment(
  text, uuid, uuid, uuid, timestamptz, text
) from public, anon;
grant execute on function public.convert_google_calendar_block_to_appointment(
  text, uuid, uuid, uuid, timestamptz, text
) to authenticated, service_role;

revoke execute on function public.apply_google_calendar_conflict(uuid)
  from public, anon;
grant execute on function public.apply_google_calendar_conflict(uuid)
  to authenticated, service_role;
