\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(26);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

update public.app_settings
set deposit_enabled = true,
    booking_hold_minutes = 60
where id = true;

-- Con Calendar autorizado y observado, vencer una pre-reserva también tiene
-- que encolar el borrado del evento que ya vive en Google.
\ir _support/calendar-ready.inc

insert into public.professionals (
  id, name, specialty, appointment_duration_minutes, active
) values (
  '96000000-0000-4000-8000-000000000002',
  'Gisela Hold Expiration Test', 'Odontología', 60, true
);

insert into public.services (id, name, duration_minutes, active, sort_order)
values (
  '96000000-0000-4000-8000-000000000003',
  'Motivo Hold Expiration Test', 60, true, 9600
);

insert into public.contacts (
  id, phone_e164, whatsapp_id, name, coverage, is_existing_patient
) values
  (
    '96000000-0000-4000-8000-000000000010', '+5491100009610',
    '5491100009610', 'Paciente Proyectado', 'particular', false
  ),
  (
    '96000000-0000-4000-8000-000000000011', '+5491100009611',
    '5491100009611', 'Paciente Hold Vigente', 'particular', false
  ),
  (
    '96000000-0000-4000-8000-000000000012', '+5491100009612',
    '5491100009612', 'Paciente Confirmado', 'particular', false
  ),
  (
    '96000000-0000-4000-8000-000000000013', '+5491100009613',
    '5491100009613', 'Paciente Hold Vencido', 'particular', false
  );

-- `...20` reproduce el turno fantasma: pre-reserva vigente ya proyectada a
-- Google. `...23` es la que el tick del cron encuentra vencida en tiempo real.
-- `...21` y `...22` no deben moverse nunca.
insert into public.appointments (
  id, contact_id, professional_id, service_id, starts_at, ends_at,
  status, source, coverage, duration_minutes, deposit_status,
  hold_expires_at, hold_expired_notification_status
) values
  (
    '96000000-0000-4000-8000-000000000020',
    '96000000-0000-4000-8000-000000000010',
    '96000000-0000-4000-8000-000000000002',
    '96000000-0000-4000-8000-000000000003',
    clock_timestamp() + interval '3 days',
    clock_timestamp() + interval '3 days' + interval '60 minutes',
    'scheduled', 'whatsapp', 'particular', 60, 'pending',
    clock_timestamp() + interval '30 minutes', 'pending'
  ),
  (
    '96000000-0000-4000-8000-000000000021',
    '96000000-0000-4000-8000-000000000011',
    '96000000-0000-4000-8000-000000000002',
    '96000000-0000-4000-8000-000000000003',
    clock_timestamp() + interval '4 days',
    clock_timestamp() + interval '4 days' + interval '60 minutes',
    'scheduled', 'whatsapp', 'particular', 60, 'pending',
    clock_timestamp() + interval '2 days', 'pending'
  ),
  (
    '96000000-0000-4000-8000-000000000022',
    '96000000-0000-4000-8000-000000000012',
    '96000000-0000-4000-8000-000000000002',
    '96000000-0000-4000-8000-000000000003',
    clock_timestamp() + interval '5 days',
    clock_timestamp() + interval '5 days' + interval '60 minutes',
    'confirmed', 'whatsapp', 'particular', 60, 'confirmed',
    null, 'not_applicable'
  ),
  (
    '96000000-0000-4000-8000-000000000023',
    '96000000-0000-4000-8000-000000000013',
    '96000000-0000-4000-8000-000000000002',
    '96000000-0000-4000-8000-000000000003',
    clock_timestamp() + interval '6 days',
    clock_timestamp() + interval '6 days' + interval '60 minutes',
    'scheduled', 'whatsapp', 'particular', 60, 'pending',
    clock_timestamp() - interval '10 minutes', 'pending'
  );

select pg_temp.calendar_projection_synced(
  '96000000-0000-4000-8000-000000000020'
);

select ok(
  exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron'),
  'pg_cron is installed'
);

select is(
  (select projected_stage from public.google_calendar_sync_jobs
    where appointment_id = '96000000-0000-4000-8000-000000000020'),
  'pre_reservation',
  'the still valid hold is projected in Google as a pre-reservation'
);

select ok(
  to_regprocedure('private.expire_booking_holds_tick()') is not null
    and to_regprocedure(
      'private.booking_hold_expiration_status()'
    ) is not null
    and to_regprocedure(
      'private.install_booking_hold_expiration_schedule()'
    ) is not null
    and to_regprocedure(
      'private.uninstall_booking_hold_expiration_schedule()'
    ) is not null,
  'the private hold expiration routines exist'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'private.expire_booking_holds_tick()',
      'private.booking_hold_expiration_status()',
      'private.install_booking_hold_expiration_schedule()',
      'private.uninstall_booking_hold_expiration_schedule()'
    ]) as routine(signature)
    cross join unnest(array['anon', 'authenticated', 'service_role'])
      as grantee(role_name)
    where has_function_privilege(
      grantee.role_name, routine.signature::regprocedure, 'execute'
    )
  ),
  'no exposed role can execute the private hold expiration routines'
);

select lives_ok(
  $$select private.install_booking_hold_expiration_schedule()$$,
  'the schedule installs'
);

select ok(
  exists (
    select 1 from cron.job
    where jobname = 'booking-hold-expiration'
      and schedule = '* * * * *'
      and command = 'select private.expire_booking_holds_tick();'
      and database = current_database()
      and username = 'postgres'
      and active
  ),
  'the job runs every minute as postgres with the audited command'
);

select ok(
  not exists (
    select 1 from cron.job
    where jobname = 'booking-hold-expiration'
      and command ~* '(secret|token|https?://|authorization)'
  ),
  'the cron command carries no secret material and no HTTP call'
);

select lives_ok(
  $$select private.install_booking_hold_expiration_schedule()$$,
  'reinstalling the schedule is idempotent'
);

select is(
  (select count(*)::integer from cron.job
    where jobname = 'booking-hold-expiration'),
  1,
  'reinstalling leaves exactly one job'
);

select is(
  (private.booking_hold_expiration_status() ->> 'installed')::boolean,
  true,
  'the status helper reports the job as installed'
);

select is(
  (private.booking_hold_expiration_status() ->> 'overdue_holds')::integer,
  1,
  'the status helper counts the overdue hold before the tick'
);

-- El vencimiento no debe encolar ni escribir nada que después se envíe, así
-- que se compara contra el estado previo y no contra una base vacía.
create temporary table hold_expiration_baseline as
select
  (select count(*) from public.messages) as messages,
  (
    select count(*) from public.reminders
    where status in ('pending', 'processing')
  ) as due_reminders;

select is(
  private.expire_booking_holds_tick(),
  1,
  'one tick expires exactly the overdue hold'
);

select is(
  (select status::text from public.appointments
    where id = '96000000-0000-4000-8000-000000000023'),
  'cancelled',
  'the overdue hold is cancelled'
);

select is(
  (select deposit_status::text from public.appointments
    where id = '96000000-0000-4000-8000-000000000023'),
  'expired',
  'the overdue hold deposit is marked expired'
);

select is(
  (select status::text from public.appointments
    where id = '96000000-0000-4000-8000-000000000020'),
  'scheduled',
  'a hold still inside its window survives the tick'
);

select is(
  (select status::text from public.appointments
    where id = '96000000-0000-4000-8000-000000000021'),
  'scheduled',
  'a hold that has not expired yet is untouched'
);

select is(
  (select status::text from public.appointments
    where id = '96000000-0000-4000-8000-000000000022'),
  'confirmed',
  'a confirmed appointment is untouched'
);

-- El vencimiento no habla con nadie: deja el aviso pendiente para que
-- `process-reminders` lo envíe cuando corresponda, y no escribe mensajes.
select is(
  (select hold_expired_notification_status from public.appointments
    where id = '96000000-0000-4000-8000-000000000023'),
  'pending',
  'the expired hold leaves its notice pending for the reminder worker'
);

select is(
  (select count(*)::integer from public.messages),
  (select messages::integer from hold_expiration_baseline),
  'expiring a hold writes no WhatsApp message'
);

select is(
  (
    select count(*)::integer from public.reminders
    where status in ('pending', 'processing')
  ),
  (select due_reminders::integer from hold_expiration_baseline),
  'expiring a hold queues no reminder to send'
);

select is(
  (private.booking_hold_expiration_status() ->> 'overdue_holds')::integer,
  0,
  'no overdue hold survives the tick'
);

-- Y cuando le toca vencer a la pre-reserva ya proyectada, el evento remoto
-- queda marcado para borrarse de Google.
select is(
  (
    select count(*)::integer
    from public.expire_booking_holds(clock_timestamp() + interval '31 minutes')
  ),
  1,
  'the projected hold expires once its window closes'
);

select is(
  (select projection_stage from public.google_calendar_sync_jobs
    where appointment_id = '96000000-0000-4000-8000-000000000020'),
  'absent',
  'expiring the hold retargets its Google event to absent'
);

select ok(
  exists (
    select 1 from public.google_calendar_sync_jobs
    where appointment_id = '96000000-0000-4000-8000-000000000020'
      and operation = 'delete'
      and status = 'pending'
      and google_event_id is not null
  ),
  'the Google event deletion is queued for the sync worker'
);

select is(
  private.uninstall_booking_hold_expiration_schedule(),
  true,
  'the schedule uninstalls'
);

select ok(
  not exists (
    select 1 from cron.job where jobname = 'booking-hold-expiration'
  )
    and private.uninstall_booking_hold_expiration_schedule() = false,
  'uninstalling removes the job and is idempotent'
);

select * from finish();
rollback;
