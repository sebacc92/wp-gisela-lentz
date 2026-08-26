\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(1);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

create function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if value is not true then
    raise exception 'ASSERTION_FAILED: %', message;
  end if;
end;
$$;

do $$
declare
  business_timezone constant text := 'America/Argentina/Buenos_Aires';
  local_today date :=
    (clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date;
  run_at timestamptz;
  queued_count bigint;
  duplicate_count bigint;
  reminder_id uuid;
  claimed_count integer;
  early_claim_count integer;
begin
  run_at := (local_today + time '21:00') at time zone business_timezone;

  perform pg_temp.assert_true(
    not has_function_privilege(
      'anon',
      'public.queue_tomorrow_appointment_reminders(timestamp with time zone)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.queue_tomorrow_appointment_reminders(timestamp with time zone)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.queue_tomorrow_appointment_reminders(timestamp with time zone)',
      'EXECUTE'
    ),
    'only service_role may execute the queue RPC'
  );

  update public.app_settings
  set timezone = business_timezone,
      reminder_24h_enabled = false,
      reminder_day_before_time = time '21:00'
  where id = true;

  insert into public.professionals (
    id,
    name,
    specialty,
    appointment_duration_minutes,
    active
  ) values (
    '93000000-0000-4000-8000-000000000001',
    'Profesional Tomorrow Reminder Test',
    'Odontología',
    30,
    true
  );

  insert into public.contacts (id, phone_e164, whatsapp_id, name)
  values
    (
      '93000000-0000-4000-8000-000000000010',
      '+5491100009310',
      '5491100009310',
      'Paciente Reminder Con Consentimiento'
    ),
    (
      '93000000-0000-4000-8000-000000000011',
      '+5491100009311',
      '5491100009311',
      'Paciente Reminder Sin Consentimiento'
    );

  perform public.record_whatsapp_consent(
    '93000000-0000-4000-8000-000000000010',
    'opt_in',
    'appointment_updates',
    'operator',
    'tomorrow-reminder-sql-test',
    'test-policy',
    null
  );

  -- Se insertan con el switch apagado para probar que el batch de las 21:00
  -- selecciona por estado, fecha local y consentimiento en ese momento.
  insert into public.appointments (
    id,
    contact_id,
    professional_id,
    starts_at,
    ends_at,
    status,
    source
  ) values
    (
      '93000000-0000-4000-8000-000000000020',
      '93000000-0000-4000-8000-000000000010',
      '93000000-0000-4000-8000-000000000001',
      ((local_today + 1) + time '10:00') at time zone business_timezone,
      ((local_today + 1) + time '10:30') at time zone business_timezone,
      'confirmed',
      'manual'
    ),
    (
      '93000000-0000-4000-8000-000000000021',
      '93000000-0000-4000-8000-000000000011',
      '93000000-0000-4000-8000-000000000001',
      ((local_today + 1) + time '11:00') at time zone business_timezone,
      ((local_today + 1) + time '11:30') at time zone business_timezone,
      'scheduled',
      'manual'
    ),
    (
      '93000000-0000-4000-8000-000000000022',
      '93000000-0000-4000-8000-000000000010',
      '93000000-0000-4000-8000-000000000001',
      ((local_today + 2) + time '10:00') at time zone business_timezone,
      ((local_today + 2) + time '10:30') at time zone business_timezone,
      'confirmed',
      'manual'
    ),
    (
      '93000000-0000-4000-8000-000000000023',
      '93000000-0000-4000-8000-000000000010',
      '93000000-0000-4000-8000-000000000001',
      ((local_today + 1) + time '12:00') at time zone business_timezone,
      ((local_today + 1) + time '12:30') at time zone business_timezone,
      'cancelled',
      'manual'
    );

  update public.app_settings
  set reminder_24h_enabled = true
  where id = true;

  select queued, already_queued
  into queued_count, duplicate_count
  from public.queue_tomorrow_appointment_reminders(
    run_at - interval '1 minute'
  );
  perform pg_temp.assert_true(
    queued_count = 0 and duplicate_count = 0,
    'the day-before queue must remain closed before 21:00 local time'
  );

  select queued, already_queued
  into queued_count, duplicate_count
  from public.queue_tomorrow_appointment_reminders(run_at);
  perform pg_temp.assert_true(
    queued_count = 1 and duplicate_count = 0,
    'the 21:00 batch must queue only active, consented appointments for tomorrow'
  );

  select id into reminder_id
  from public.reminders
  where appointment_id = '93000000-0000-4000-8000-000000000020'
    and type = 'appointment_24h';

  perform pg_temp.assert_true(
    reminder_id is not null
    and (
      select status = 'pending' and scheduled_at = run_at
      from public.reminders
      where id = reminder_id
    ),
    'the queued reminder must retain the configured local dispatch instant'
  );

  select queued, already_queued
  into queued_count, duplicate_count
  from public.queue_tomorrow_appointment_reminders(run_at);
  perform pg_temp.assert_true(
    queued_count = 0 and duplicate_count = 1
    and (
      select count(*) = 1
      from public.reminders
      where appointment_id = '93000000-0000-4000-8000-000000000020'
        and type = 'appointment_24h'
    ),
    'repeated batches must be idempotent'
  );

  perform pg_temp.assert_true(
    not exists (
      select 1
      from public.reminders
      where appointment_id in (
        '93000000-0000-4000-8000-000000000021',
        '93000000-0000-4000-8000-000000000023'
      )
        and type = 'appointment_24h'
    ),
    'cancelled appointments and contacts without consent must be excluded'
  );

  -- El trigger conserva la programación futura a las 21:00 del día anterior.
  update public.appointments
  set starts_at = starts_at
  where id = '93000000-0000-4000-8000-000000000022';
  perform pg_temp.assert_true(
    (
      select scheduled_at =
        ((local_today + 1) + time '21:00') at time zone business_timezone
      from public.reminders
      where appointment_id = '93000000-0000-4000-8000-000000000022'
        and type = 'appointment_24h'
    ),
    'appointment changes must schedule the reminder for 21:00 on the prior day'
  );

  -- Simula un reminder futuro reclamado antes de su día correcto: el claim lo
  -- cancela y sólo entrega el que corresponde a mañana.
  update public.reminders
  set scheduled_at = clock_timestamp() - interval '1 minute'
  where appointment_id in (
    '93000000-0000-4000-8000-000000000020',
    '93000000-0000-4000-8000-000000000022'
    )
    and type = 'appointment_24h';

  -- Simula cambiar la apertura de 20:00 a una hora posterior después de haber
  -- creado el reminder: scheduled_at ya venció, pero la hora vigente manda.
  update public.app_settings
  set reminder_day_before_time = time '23:59:59'
  where id = true;

  select count(*) into early_claim_count
  from public.claim_due_reminders(100) claimed
  where claimed.id = reminder_id;

  perform pg_temp.assert_true(
    early_claim_count = 0
    and (
      select status = 'pending' and attempts = 0
      from public.reminders
      where id = reminder_id
    ),
    'a stale scheduled_at must not bypass the currently configured local time'
  );

  update public.app_settings
  set reminder_day_before_time = time '00:00'
  where id = true;

  select count(*) into claimed_count
  from public.claim_due_reminders(100) claimed
  where claimed.id = reminder_id;

  perform pg_temp.assert_true(
    claimed_count = 1
    and (
      select status = 'processing' and attempts = 1
      from public.reminders
      where id = reminder_id
    ),
    'claim must atomically reserve the eligible reminder once'
  );
  perform pg_temp.assert_true(
    (
      select status = 'cancelled'
        and last_error = 'REMINDER_WINDOW_EXPIRED'
      from public.reminders
      where appointment_id = '93000000-0000-4000-8000-000000000022'
        and type = 'appointment_24h'
    ),
    'claim must cancel a day-before reminder outside its local date window'
  );
end;
$$;

select pass(
  'tomorrow reminders are time-gated, consent-aware, deduplicated and claimed safely'
);
select * from finish();

rollback;
