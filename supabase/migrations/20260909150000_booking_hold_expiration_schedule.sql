-- Vencimiento de pre-reservas garantizado dentro de la base.
--
-- `expire_booking_holds` es una transición interna del consultorio: libera el
-- horario cuando pasó el plazo de la seña. Hasta ahora dependía de que alguien
-- la llamara desde afuera —`process-reminders` con un cron externo, o
-- `process-calendar-sync` con su variante acotada al epoch de Calendar— y
-- ninguna de las dos es una garantía: la primera necesita un cron que puede no
-- existir, la segunda ignora por diseño los turnos anteriores a
-- `automation_activated_at` y se detiene cuando Google falla.
--
-- Este job la ejecuta directamente en SQL, cada minuto, sin HTTP, sin secretos
-- y sin tocar Google ni WhatsApp. No envía mensajes: cancelar el turno sólo
-- cancela sus recordatorios y deja `hold_expired_notification_status` en
-- `pending` para que `process-reminders` avise cuando esté disponible.
-- El borrado del evento en Google lo sigue encolando
-- `enqueue_google_calendar_appointment` sobre el mismo UPDATE.

create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'BOOKING_HOLD_EXPIRATION_EXTENSIONS_UNAVAILABLE'
      using errcode = '55000';
  end if;
end;
$$;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;
grant usage on schema private to postgres;

-- El comando del job vive en una función nombrada para que `cron.job.command`
-- sea estable y auditable, y para que nadie más que postgres pueda ejecutarla.
create or replace function private.expire_booking_holds_tick()
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_expired integer;
begin
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  select count(*) into v_expired
  from public.expire_booking_holds(clock_timestamp());

  return coalesce(v_expired, 0);
end;
$$;

revoke execute on function private.expire_booking_holds_tick()
  from public, anon, authenticated, service_role;

-- Diagnóstico operativo: responde en una sola consulta si el job está
-- instalado y si quedó alguna pre-reserva vencida sin liberar.
create or replace function private.booking_hold_expiration_status()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job record;
  v_overdue integer;
  v_last record;
begin
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  select jobid, schedule, command, active into v_job
  from cron.job
  where jobname = 'booking-hold-expiration';

  select count(*) into v_overdue
  from public.appointments appointment
  where appointment.status = 'scheduled'
    and appointment.deposit_status = 'pending'
    and appointment.hold_expires_at is not null
    and appointment.hold_expires_at <= clock_timestamp();

  select status, start_time, return_message into v_last
  from cron.job_run_details
  where jobid = v_job.jobid
  order by start_time desc
  limit 1;

  return jsonb_build_object(
    'installed', v_job.jobid is not null,
    'active', coalesce(v_job.active, false),
    'schedule', v_job.schedule,
    'overdue_holds', v_overdue,
    'last_run_status', v_last.status,
    'last_run_at', v_last.start_time,
    'last_run_message', v_last.return_message
  );
end;
$$;

revoke execute on function private.booking_hold_expiration_status()
  from public, anon, authenticated, service_role;

create or replace function private.install_booking_hold_expiration_schedule()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_existing_job record;
  v_matching_count integer;
  v_job_id bigint;
  v_command constant text := 'select private.expire_booking_holds_tick();';
  v_schedule constant text := '* * * * *';
begin
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('booking_hold_expiration_schedule', 0)
  );

  if to_regclass('cron.job') is null
    or to_regclass('cron.job_run_details') is null
    or to_regprocedure('cron.schedule(text,text,text)') is null
    or to_regprocedure('cron.unschedule(bigint)') is null
  then
    raise exception 'BOOKING_HOLD_EXPIRATION_EXTENSIONS_UNAVAILABLE'
      using errcode = '55000';
  end if;

  -- Un job homónimo ajeno a esta instalación no se pisa en silencio.
  select count(*) into v_matching_count
  from cron.job where jobname = 'booking-hold-expiration';
  if v_matching_count > 1 then
    raise exception 'BOOKING_HOLD_EXPIRATION_JOB_DUPLICATE'
      using errcode = '55000';
  elsif v_matching_count = 1 then
    select * into v_existing_job
    from cron.job where jobname = 'booking-hold-expiration';
    if v_existing_job.database <> current_database()
      or v_existing_job.username <> 'postgres'
      or v_existing_job.command <> v_command
    then
      raise exception 'BOOKING_HOLD_EXPIRATION_JOB_COLLISION'
        using errcode = '55000';
    end if;
    perform cron.unschedule(v_existing_job.jobid);
  end if;

  v_job_id := cron.schedule(
    'booking-hold-expiration',
    v_schedule,
    v_command
  );
  if v_job_id is null or not exists (
    select 1 from cron.job
    where jobid = v_job_id
      and jobname = 'booking-hold-expiration'
      and schedule = v_schedule
      and command = v_command
      and database = current_database()
      and username = 'postgres'
      and active
  ) then
    raise exception 'BOOKING_HOLD_EXPIRATION_JOB_INSTALLATION_FAILED'
      using errcode = '55000';
  end if;

  return jsonb_build_object(
    'job_id', v_job_id,
    'schedule', v_schedule,
    'command', v_command
  );
end;
$$;

revoke execute on function private.install_booking_hold_expiration_schedule()
  from public, anon, authenticated, service_role;

create or replace function private.uninstall_booking_hold_expiration_schedule()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job record;
begin
  if session_user <> 'postgres' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('booking_hold_expiration_schedule', 0)
  );

  select * into v_job
  from cron.job where jobname = 'booking-hold-expiration';
  if not found then return false; end if;

  perform cron.unschedule(v_job.jobid);
  return true;
end;
$$;

revoke execute on function private.uninstall_booking_hold_expiration_schedule()
  from public, anon, authenticated, service_role;

-- La migración deja la infraestructura lista pero no programa el job, igual
-- que el resto de los schedulers del proyecto. No es una preferencia de
-- estilo: `cron.schedule` crea el job a nombre del usuario que la ejecuta, y
-- `db push` no se conecta como `postgres`. Un job a nombre de otro rol no
-- podría ejecutar el tick. La activación es un paso explícito desde una sesión
-- postgres —el SQL Editor del dashboard lo es—:
--
--   select private.install_booking_hold_expiration_schedule();
--
-- Para pararla:
--
--   select private.uninstall_booking_hold_expiration_schedule();
