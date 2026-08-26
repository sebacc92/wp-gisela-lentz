-- Cobertura, duración automática y pre-reservas con seña para Gisela Lentz.
-- Migración incremental: conserva turnos y servicios históricos, y hace que
-- las reservas nuevas usen la cobertura del paciente como fuente de duración.

create type public.patient_coverage as enum ('ioma', 'particular');
create type public.deposit_status as enum (
  'not_required',
  'pending',
  'proof_received',
  'confirmed',
  'expired'
);

alter table public.contacts
  add column coverage public.patient_coverage,
  add column is_existing_patient boolean,
  add column alternate_phone_e164 text,
  add constraint contacts_alternate_phone_e164_check check (
    alternate_phone_e164 is null
    or alternate_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
  ),
  add constraint contacts_distinct_alternate_phone_check check (
    alternate_phone_e164 is null or alternate_phone_e164 <> phone_e164
  );

alter table public.appointments
  add column coverage public.patient_coverage,
  add column duration_minutes integer,
  add column deposit_status public.deposit_status not null default 'not_required',
  add column hold_expires_at timestamptz,
  add column deposit_proof_message_id uuid references public.messages (id) on delete set null,
  add column deposit_proof_received_at timestamptz,
  add column deposit_proof_late boolean not null default false,
  add column deposit_confirmed_at timestamptz,
  add column deposit_confirmed_by uuid references public.profiles (id) on delete set null,
  add column hold_expired_notification_status text not null default 'not_applicable',
  add column hold_expired_notification_attempts integer not null default 0,
  add column hold_expired_notification_claimed_at timestamptz,
  add column hold_expired_notification_sent_at timestamptz,
  add column hold_expired_notification_error text,
  add constraint appointments_duration_minutes_check check (
    duration_minutes between 5 and 480
  ),
  add constraint appointments_deposit_proof_consistency_check check (
    (deposit_proof_message_id is null and deposit_proof_received_at is null)
    or (deposit_proof_message_id is not null and deposit_proof_received_at is not null)
  ),
  add constraint appointments_deposit_confirmation_consistency_check check (
    (deposit_confirmed_at is null and deposit_confirmed_by is null)
    or (deposit_confirmed_at is not null and deposit_confirmed_by is not null)
  ),
  add constraint appointments_hold_notification_status_check check (
    hold_expired_notification_status in (
      'not_applicable', 'pending', 'processing', 'sent', 'failed', 'cancelled'
    )
  ),
  add constraint appointments_hold_notification_attempts_check check (
    hold_expired_notification_attempts between 0 and 20
  );

update public.appointments appointment
set duration_minutes = greatest(
  5,
  least(
    480,
    round(extract(epoch from (appointment.ends_at - appointment.starts_at)) / 60)::integer
  )
);

alter table public.appointments
  alter column duration_minutes set not null,
  alter column duration_minutes set default 30,
  alter column deposit_status set default 'pending';

-- Los turnos creados antes de este flujo eran reservas completas. Se los
-- conserva como confirmados y sin exigir una seña retroactiva.
update public.appointments
set status = 'confirmed'
where status = 'scheduled'
  and deposit_status = 'not_required';

create index contacts_coverage_idx on public.contacts (coverage);
create index appointments_deposit_attention_idx
  on public.appointments (deposit_status, starts_at)
  where deposit_status in ('pending', 'proof_received');
create index appointments_hold_expiration_idx
  on public.appointments (hold_expires_at)
  where status = 'scheduled' and deposit_status = 'pending';
create index appointments_deposit_proof_message_idx
  on public.appointments (deposit_proof_message_id)
  where deposit_proof_message_id is not null;
create index appointments_hold_notification_due_idx
  on public.appointments (hold_expired_notification_status, hold_expires_at)
  where hold_expired_notification_status in ('pending', 'processing');

alter table public.app_settings
  add column deposit_enabled boolean not null default true,
  add column deposit_amount_ars integer not null default 10000,
  add column deposit_alias text not null default 'odontologa.gisela.mp',
  add column deposit_holder text not null default 'Gisela Vanesa Lentz',
  add column booking_hold_minutes integer not null default 60,
  add column ioma_duration_minutes integer not null default 30,
  add column private_duration_minutes integer not null default 60,
  add column deposit_request_message_template text not null default
    E'Buenas tardes! 😊\n\nPara confirmar su turno solicitamos una seña de {deposit_amount}.\n\nLa misma será descontada del valor de la consulta el día del turno.\n\nEsto es para asegurar el lugar y evitar ausencias.\n\nDatos para transferir:\n\nAlias: {deposit_alias}\n\nTitular: {deposit_holder}\n\nQuedo atenta al comprobante. Muchas gracias por su comprensión 💛✨',
  add column deposit_proof_received_message_template text not null default
    E'¡Gracias! 😊 Recibimos tu comprobante.\n\nGisela lo va a revisar y te confirmaremos el turno a la brevedad.',
  add column deposit_confirmed_message_template text not null default
    E'¡Listo! 😊 Tu turno quedó confirmado.\n\nTe esperamos el {date} a las {time}.\n\nMuchas gracias 💛',
  add column booking_hold_expired_message_template text not null default
    E'El horario que habíamos reservado quedó nuevamente disponible porque no recibimos el comprobante dentro del tiempo previsto.\n\nSi querés, podemos buscarte otro horario 😊',
  add constraint app_settings_deposit_amount_check check (
    deposit_amount_ars between 1 and 100000000
  ),
  add constraint app_settings_deposit_alias_check check (
    char_length(trim(deposit_alias)) between 3 and 120
  ),
  add constraint app_settings_deposit_holder_check check (
    char_length(trim(deposit_holder)) between 3 and 160
  ),
  add constraint app_settings_booking_hold_minutes_check check (
    booking_hold_minutes between 5 and 1440
  ),
  add constraint app_settings_ioma_duration_check check (
    ioma_duration_minutes between 5 and 480
  ),
  add constraint app_settings_private_duration_check check (
    private_duration_minutes between 5 and 480
  ),
  add constraint app_settings_deposit_request_template_check check (
    char_length(trim(deposit_request_message_template)) between 1 and 4096
  ),
  add constraint app_settings_deposit_proof_template_check check (
    char_length(trim(deposit_proof_received_message_template)) between 1 and 4096
  ),
  add constraint app_settings_deposit_confirmed_template_check check (
    char_length(trim(deposit_confirmed_message_template)) between 1 and 4096
  ),
  add constraint app_settings_hold_expired_template_check check (
    char_length(trim(booking_hold_expired_message_template)) between 1 and 4096
  );

alter table public.app_settings
  alter column automation_welcome_message set default
    E'Hola!!!☺️ Gracias por comunicarte con el Consultorio Odontológico Lentz Gisela.\nPara agendar tu turno envíanos:\n\n1. Nombre y apellido\n2. ¿Sos paciente de la odontóloga? Sí/No\n3. Teléfono de contacto\n4. Particular o ioma\n   Te respondemos a la brevedad para confirmar\n   Muchas gracias💕\n   CAP📍11 n°1375 / Miramar';

update public.app_settings
set business_address = case
      when business_address is null or trim(business_address) = ''
        then 'CAP · 11 n°1375 · Miramar'
      else business_address
    end,
    timezone = 'America/Argentina/Buenos_Aires',
    automation_welcome_message =
      E'Hola!!!☺️ Gracias por comunicarte con el Consultorio Odontológico Lentz Gisela.\nPara agendar tu turno envíanos:\n\n1. Nombre y apellido\n2. ¿Sos paciente de la odontóloga? Sí/No\n3. Teléfono de contacto\n4. Particular o ioma\n   Te respondemos a la brevedad para confirmar\n   Muchas gracias💕\n   CAP📍11 n°1375 / Miramar'
where id = true;

comment on column public.services.duration_minutes is
  'Duración histórica conservada por compatibilidad. En Gisela Lentz la duración efectiva viene de appointments.coverage y app_settings.';
comment on column public.appointments.duration_minutes is
  'Snapshot de la duración efectiva calculada desde la cobertura al crear el turno.';
comment on column public.appointments.deposit_proof_message_id is
  'Mensaje de imagen/documento asociado para revisión humana; no acredita un pago.';

revoke insert on public.contacts from authenticated;
grant insert (
  name, phone_e164, email, administrative_notes, coverage,
  is_existing_patient, alternate_phone_e164
) on public.contacts to authenticated;
grant update (
  name, phone_e164, email, administrative_notes, coverage,
  is_existing_patient, alternate_phone_e164
) on public.contacts to authenticated;

create or replace function public.coverage_duration_minutes(
  p_coverage public.patient_coverage
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case p_coverage
    when 'ioma' then settings.ioma_duration_minutes
    when 'particular' then settings.private_duration_minutes
  end
  from public.app_settings settings
  where settings.id = true;
$$;

revoke execute on function public.coverage_duration_minutes(public.patient_coverage)
  from public, anon, authenticated;
grant execute on function public.coverage_duration_minutes(public.patient_coverage)
  to service_role;

-- Función interna. Sus permisos, no una variable JWT, impiden invocarla desde
-- el navegador; otros SECURITY DEFINER pueden reutilizarla dentro del lock.
create or replace function public.expire_booking_holds(
  p_now timestamptz default clock_timestamp()
)
returns table (appointment_id uuid, contact_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_now is null then
    raise exception 'INVALID_NOW' using errcode = '22023';
  end if;

  return query
  update public.appointments appointment
  set status = 'cancelled',
      deposit_status = 'expired',
      hold_expired_notification_status = case
        when appointment.hold_expired_notification_status = 'not_applicable'
          then 'pending'
        else appointment.hold_expired_notification_status
      end,
      hold_expired_notification_claimed_at = null,
      hold_expired_notification_error = null
  where appointment.status = 'scheduled'
    and appointment.deposit_status = 'pending'
    and appointment.hold_expires_at is not null
    and appointment.hold_expires_at <= p_now
  returning appointment.id, appointment.contact_id;
end;
$$;

revoke execute on function public.expire_booking_holds(timestamptz)
  from public, anon, authenticated;
grant execute on function public.expire_booking_holds(timestamptz)
  to service_role;

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
set search_path = public
as $$
declare
  settings public.app_settings%rowtype;
  effective_timezone text;
  buffer_minutes integer;
  local_start timestamp;
  local_end_with_buffer timestamp;
  local_date date;
  inside_working_window boolean;
begin
  if p_starts_at is null
    or p_duration_minutes is null
    or p_duration_minutes not between 5 and 480
    or not exists (
      select 1 from public.professionals
      where id = p_professional_id and active
    ) then
    return false;
  end if;

  select * into settings from public.app_settings where id = true;
  if not found then return false; end if;

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
    or local_start::date <> local_end_with_buffer::date then
    return false;
  end if;
  local_date := local_start::date;

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
          (availability_exception.start_time is null and availability_exception.end_time is null)
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
        (availability_exception.start_time is null and availability_exception.end_time is null)
        or (
          availability_exception.start_time < local_end_with_buffer::time
          and availability_exception.end_time > local_start::time
        )
      )
  ) then
    return false;
  end if;

  if exists (
    select 1 from public.appointments appointment
    where appointment.professional_id = p_professional_id
      and (p_exclude_appointment_id is null or appointment.id <> p_exclude_appointment_id)
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
      ) && tstzrange(
        p_starts_at,
        p_starts_at + make_interval(mins => p_duration_minutes + buffer_minutes),
        '[)'
      )
  ) then
    return false;
  end if;

  return true;
end;
$$;

create or replace function public.get_available_slots_for_coverage(
  p_professional_id uuid,
  p_coverage public.patient_coverage,
  p_date date,
  p_timezone text default 'America/Argentina/Buenos_Aires',
  p_limit integer default 40
)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  effective_duration integer;
begin
  if auth.role() <> 'service_role' and not public.current_user_is_active() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  effective_duration := public.coverage_duration_minutes(p_coverage);
  if effective_duration is null then return; end if;

  return query
  select slot.starts_at, slot.ends_at
  from public.get_available_slots_by_duration(
    p_professional_id,
    effective_duration,
    p_date,
    p_timezone,
    p_limit
  ) slot;
end;
$$;

revoke execute on function public.get_available_slots_for_coverage(
  uuid, public.patient_coverage, date, text, integer
) from public, anon;
grant execute on function public.get_available_slots_for_coverage(
  uuid, public.patient_coverage, date, text, integer
) to authenticated, service_role;

create or replace function public.create_service_appointment(
  p_contact_id uuid,
  p_professional_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_source public.appointment_source default 'manual',
  p_internal_note text default null
)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  contact_coverage public.patient_coverage;
  effective_duration integer;
  settings public.app_settings%rowtype;
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not public.current_user_is_active() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.services where id = p_service_id and active) then
    raise exception 'SERVICE_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  select coverage into contact_coverage from public.contacts where id = p_contact_id;
  if contact_coverage is null then
    raise exception 'COVERAGE_REQUIRED' using errcode = 'P0001';
  end if;
  select * into settings from public.app_settings where id = true;
  if not found then raise exception 'APP_SETTINGS_NOT_FOUND' using errcode = 'P0002'; end if;
  effective_duration := case contact_coverage
    when 'ioma' then settings.ioma_duration_minutes
    when 'particular' then settings.private_duration_minutes
  end;

  perform pg_advisory_xact_lock(hashtextextended(p_professional_id::text, 0));
  perform public.expire_booking_holds(clock_timestamp());
  if not public.appointment_slot_is_available(
    p_professional_id, p_starts_at, effective_duration, null, settings.timezone
  ) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  begin
    insert into public.appointments (
      contact_id, professional_id, service_id, starts_at, ends_at,
      status, source, created_by, internal_note, coverage, duration_minutes,
      deposit_status, hold_expires_at, hold_expired_notification_status
    ) values (
      p_contact_id, p_professional_id, p_service_id, p_starts_at,
      p_starts_at + make_interval(mins => effective_duration),
      case when settings.deposit_enabled then 'scheduled'::public.appointment_status
        else 'confirmed'::public.appointment_status end,
      p_source, auth.uid(), p_internal_note, contact_coverage, effective_duration,
      case when settings.deposit_enabled then 'pending'::public.deposit_status
        else 'not_required'::public.deposit_status end,
      case when settings.deposit_enabled then
        clock_timestamp() + make_interval(mins => settings.booking_hold_minutes)
        else null end,
      case when settings.deposit_enabled then 'pending' else 'not_applicable' end
    ) returning * into result;
  exception when exclusion_violation then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end;
  return result;
end;
$$;

create or replace function public.create_appointment(
  p_contact_id uuid,
  p_professional_id uuid,
  p_starts_at timestamptz,
  p_source public.appointment_source default 'manual',
  p_internal_note text default null
)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  contact_coverage public.patient_coverage;
  effective_duration integer;
  settings public.app_settings%rowtype;
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not public.current_user_is_active() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  select coverage into contact_coverage from public.contacts where id = p_contact_id;
  if contact_coverage is null then
    raise exception 'COVERAGE_REQUIRED' using errcode = 'P0001';
  end if;
  select * into settings from public.app_settings where id = true;
  if not found then raise exception 'APP_SETTINGS_NOT_FOUND' using errcode = 'P0002'; end if;
  effective_duration := case contact_coverage
    when 'ioma' then settings.ioma_duration_minutes
    when 'particular' then settings.private_duration_minutes
  end;

  perform pg_advisory_xact_lock(hashtextextended(p_professional_id::text, 0));
  perform public.expire_booking_holds(clock_timestamp());
  if not public.appointment_slot_is_available(
    p_professional_id, p_starts_at, effective_duration, null, settings.timezone
  ) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  begin
    insert into public.appointments (
      contact_id, professional_id, starts_at, ends_at, status, source,
      created_by, internal_note, coverage, duration_minutes, deposit_status,
      hold_expires_at, hold_expired_notification_status
    ) values (
      p_contact_id, p_professional_id, p_starts_at,
      p_starts_at + make_interval(mins => effective_duration),
      case when settings.deposit_enabled then 'scheduled'::public.appointment_status
        else 'confirmed'::public.appointment_status end,
      p_source, auth.uid(), p_internal_note, contact_coverage, effective_duration,
      case when settings.deposit_enabled then 'pending'::public.deposit_status
        else 'not_required'::public.deposit_status end,
      case when settings.deposit_enabled then
        clock_timestamp() + make_interval(mins => settings.booking_hold_minutes)
        else null end,
      case when settings.deposit_enabled then 'pending' else 'not_applicable' end
    ) returning * into result;
  exception when exclusion_violation then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end;
  return result;
end;
$$;

create or replace function public.reschedule_appointment(
  p_appointment_id uuid,
  p_starts_at timestamptz
)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  current_appointment public.appointments%rowtype;
  contact_coverage public.patient_coverage;
  effective_duration integer;
  settings public.app_settings%rowtype;
  settings_timezone text;
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not public.current_user_is_active() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  select * into current_appointment
  from public.appointments
  where id = p_appointment_id and status in ('scheduled', 'confirmed');
  if not found then raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002'; end if;

  perform pg_advisory_xact_lock(hashtextextended(current_appointment.professional_id::text, 0));
  perform public.expire_booking_holds(clock_timestamp());
  select * into current_appointment from public.appointments where id = p_appointment_id;
  if current_appointment.status not in ('scheduled', 'confirmed') then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- La ficha vigente del paciente es la fuente de verdad también al
  -- reprogramar. Se vuelve a tomar un snapshot para que agenda, conflictos y
  -- auditoría reflejen la duración realmente aplicada a este nuevo horario.
  select coverage into contact_coverage
  from public.contacts
  where id = current_appointment.contact_id
  for key share;
  if contact_coverage is null then
    raise exception 'COVERAGE_REQUIRED' using errcode = 'P0001';
  end if;

  select * into settings from public.app_settings where id = true;
  if not found then
    raise exception 'APP_SETTINGS_NOT_FOUND' using errcode = 'P0002';
  end if;
  settings_timezone := settings.timezone;
  effective_duration := case contact_coverage
    when 'ioma' then settings.ioma_duration_minutes
    when 'particular' then settings.private_duration_minutes
  end;

  if not public.appointment_slot_is_available(
    current_appointment.professional_id,
    p_starts_at,
    effective_duration,
    p_appointment_id,
    settings_timezone
  ) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  begin
    update public.appointments
    set starts_at = p_starts_at,
        ends_at = p_starts_at + make_interval(mins => effective_duration),
        coverage = contact_coverage,
        duration_minutes = effective_duration
    where id = p_appointment_id
    returning * into result;
  exception when exclusion_violation then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end;
  return result;
end;
$$;

create or replace function public.reschedule_service_appointment(
  p_appointment_id uuid,
  p_starts_at timestamptz
)
returns public.appointments
language sql
security definer
set search_path = public
as $$
  select public.reschedule_appointment(p_appointment_id, p_starts_at);
$$;

create or replace function public.update_appointment_status(
  p_appointment_id uuid,
  p_status public.appointment_status
)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  current_appointment public.appointments%rowtype;
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not public.current_user_is_active() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  select * into current_appointment
  from public.appointments where id = p_appointment_id for update;
  if not found then raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002'; end if;

  -- Este RPC conserva acciones operativas simples, pero nunca confirma una
  -- pre-reserva: scheduled -> confirmed pertenece exclusivamente a
  -- confirm_appointment_deposit, que además registra actor y fecha.
  if p_status = current_appointment.status then
    return current_appointment;
  end if;

  if p_status = 'confirmed' then
    raise exception 'DEPOSIT_CONFIRMATION_REQUIRED' using errcode = 'P0001';
  end if;

  if p_status = 'scheduled' then
    raise exception 'INVALID_STATUS_TRANSITION' using errcode = 'P0001';
  end if;

  if p_status = 'cancelled'
    and current_appointment.status not in ('scheduled', 'confirmed') then
    raise exception 'INVALID_STATUS_TRANSITION' using errcode = 'P0001';
  end if;

  if p_status in ('completed', 'no_show')
    and current_appointment.status <> 'confirmed' then
    raise exception 'APPOINTMENT_NOT_CONFIRMED' using errcode = 'P0001';
  end if;

  update public.appointments
  set status = p_status,
      hold_expired_notification_status = case
        when p_status <> 'scheduled'
          and hold_expired_notification_status in ('pending', 'processing')
          then 'cancelled'
        else hold_expired_notification_status
      end,
      hold_expired_notification_claimed_at = case
        when p_status <> 'scheduled' then null
        else hold_expired_notification_claimed_at
      end
  where id = p_appointment_id
  returning * into result;
  return result;
end;
$$;

create or replace function public.record_deposit_proof(
  p_contact_id uuid,
  p_message_id uuid,
  p_received_at timestamptz default clock_timestamp()
)
returns table (
  appointment_id uuid,
  recognized boolean,
  late boolean,
  acknowledge boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate public.appointments%rowtype;
  already public.appointments%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if p_received_at is null or not exists (
    select 1 from public.messages message
    where message.id = p_message_id
      and message.contact_id = p_contact_id
      and message.direction = 'inbound'
      and message.type in ('image', 'document')
  ) then
    raise exception 'INVALID_DEPOSIT_PROOF' using errcode = '22023';
  end if;

  select * into already
  from public.appointments appointment
  where appointment.deposit_proof_message_id = p_message_id
    and appointment.contact_id = p_contact_id
  limit 1;
  if found then
    return query select already.id, true, already.deposit_proof_late, false;
    return;
  end if;

  select * into candidate
  from public.appointments appointment
  where appointment.contact_id = p_contact_id
    and appointment.status = 'scheduled'
    and appointment.deposit_status in ('pending', 'proof_received')
    and p_received_at >= appointment.created_at
    and appointment.starts_at > p_received_at
  order by appointment.created_at desc
  limit 1;

  if found then
    perform pg_advisory_xact_lock(hashtextextended(candidate.professional_id::text, 0));
    select * into candidate from public.appointments where id = candidate.id for update;
    if candidate.status = 'scheduled'
      and candidate.deposit_status = 'proof_received' then
      update public.conversations
      set automation_mode = 'manual', needs_human = true
      where contact_id = p_contact_id and status = 'open';
      return query select candidate.id, true, false, false;
      return;
    end if;

    if candidate.status = 'scheduled'
      and candidate.deposit_status = 'pending'
      and p_received_at <= candidate.hold_expires_at then
      update public.appointments
      set deposit_status = 'proof_received',
          deposit_proof_message_id = p_message_id,
          deposit_proof_received_at = p_received_at,
          deposit_proof_late = false,
          hold_expired_notification_status = 'cancelled',
          hold_expired_notification_claimed_at = null,
          hold_expired_notification_error = null
      where id = candidate.id;
      update public.conversations
      set automation_mode = 'manual', needs_human = true
      where contact_id = p_contact_id and status = 'open';
      insert into public.audit_logs (action, entity_type, entity_id, metadata)
      values (
        'deposit.proof_received', 'appointment', candidate.id,
        jsonb_build_object('message_id', p_message_id, 'late', false)
      );
      return query select candidate.id, true, false, true;
      return;
    end if;

    if candidate.status = 'scheduled'
      and candidate.deposit_status = 'pending'
      and candidate.hold_expires_at is not null
      and p_received_at <= candidate.hold_expires_at + interval '24 hours' then
      update public.appointments
      set status = 'cancelled',
          deposit_status = 'expired',
          deposit_proof_message_id = p_message_id,
          deposit_proof_received_at = p_received_at,
          deposit_proof_late = true,
          hold_expired_notification_status = 'cancelled',
          hold_expired_notification_claimed_at = null,
          hold_expired_notification_error = null
      where id = candidate.id;
      update public.conversations
      set automation_mode = 'manual', needs_human = true
      where contact_id = p_contact_id and status = 'open';
      insert into public.audit_logs (action, entity_type, entity_id, metadata)
      values (
        'deposit.proof_received_late', 'appointment', candidate.id,
        jsonb_build_object('message_id', p_message_id, 'late', true)
      );
      return query select candidate.id, true, true, false;
      return;
    end if;

    if candidate.status = 'scheduled' and candidate.deposit_status = 'pending' then
      -- Una imagen histórica o un comprobante recibido más de 24 horas después
      -- no se asocia a este turno. Igual se libera el hold vencido y el webhook
      -- continúa con su handoff humano normal para el archivo sin reconocer.
      update public.appointments
      set status = 'cancelled',
          deposit_status = 'expired',
          hold_expired_notification_status = 'cancelled',
          hold_expired_notification_claimed_at = null,
          hold_expired_notification_error = null
      where id = candidate.id;
      return query select null::uuid, false, false, false;
      return;
    end if;
  end if;

  select * into candidate
  from public.appointments appointment
  where appointment.contact_id = p_contact_id
    and appointment.status = 'cancelled'
    and appointment.deposit_status = 'expired'
    and appointment.deposit_proof_message_id is null
    and appointment.hold_expires_at is not null
    and p_received_at >= appointment.created_at
    and p_received_at >= appointment.hold_expires_at
    and p_received_at <= appointment.hold_expires_at + interval '24 hours'
  order by appointment.hold_expires_at desc
  limit 1
  for update;

  if found then
    update public.appointments
    set deposit_proof_message_id = p_message_id,
        deposit_proof_received_at = p_received_at,
        deposit_proof_late = true,
        hold_expired_notification_status = 'cancelled',
        hold_expired_notification_claimed_at = null,
        hold_expired_notification_error = null
    where id = candidate.id;
    update public.conversations
    set automation_mode = 'manual', needs_human = true
    where contact_id = p_contact_id and status = 'open';
    insert into public.audit_logs (action, entity_type, entity_id, metadata)
    values (
      'deposit.proof_received_late', 'appointment', candidate.id,
      jsonb_build_object('message_id', p_message_id, 'late', true)
    );
    return query select candidate.id, true, true, false;
    return;
  end if;

  return query select null::uuid, false, false, false;
end;
$$;

create or replace function public.confirm_appointment_deposit(
  p_appointment_id uuid
)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  appointment_professional_id uuid;
  current_appointment public.appointments%rowtype;
  result public.appointments;
begin
  if not public.current_user_is_active() or auth.uid() is null then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select professional_id into appointment_professional_id
  from public.appointments
  where id = p_appointment_id;
  if appointment_professional_id is null then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(appointment_professional_id::text, 0));
  select * into current_appointment
  from public.appointments
  where id = p_appointment_id
  for update;
  if not found then raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if current_appointment.status <> 'scheduled'
    or current_appointment.deposit_status <> 'proof_received'
    or current_appointment.deposit_proof_message_id is null
    or current_appointment.deposit_proof_late then
    raise exception 'DEPOSIT_REVIEW_REQUIRED_OR_HOLD_EXPIRED' using errcode = 'P0001';
  end if;

  update public.appointments
  set status = 'confirmed',
      deposit_status = 'confirmed',
      deposit_confirmed_at = clock_timestamp(),
      deposit_confirmed_by = auth.uid(),
      hold_expired_notification_status = 'cancelled',
      hold_expired_notification_claimed_at = null,
      hold_expired_notification_error = null
  where id = p_appointment_id
  returning * into result;

  -- La revisión quedó resuelta por la acción explícita de Gisela. Se limpia
  -- sólo esta atención contextual y se conserva manual para que el bot no
  -- vuelva a competir con una conversación que ya tomó una persona.
  update public.conversations
  set needs_human = false,
      current_flow = null
  where contact_id = result.contact_id
    and status = 'open'
    and current_flow = 'deposit_proof_received';

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(), 'deposit.confirmed', 'appointment', result.id,
    jsonb_build_object(
      'appointment_id', result.id,
      'confirmed_at', result.deposit_confirmed_at
    )
  );
  return result;
end;
$$;

create or replace function public.claim_expired_booking_hold_notifications(
  p_limit integer default 25
)
returns table (appointment_id uuid, contact_id uuid, attempts integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  perform public.expire_booking_holds(clock_timestamp());

  update public.appointments
  set hold_expired_notification_status = 'pending',
      hold_expired_notification_claimed_at = null,
      hold_expired_notification_error = 'STALE_CLAIM_RECOVERED'
  where hold_expired_notification_status = 'processing'
    and (
      hold_expired_notification_claimed_at is null
      or hold_expired_notification_claimed_at < clock_timestamp() - interval '15 minutes'
    );

  return query
  with due as (
    select appointment.id
    from public.appointments appointment
    where appointment.deposit_status = 'expired'
      and appointment.status = 'cancelled'
      and appointment.hold_expired_notification_status = 'pending'
      and appointment.deposit_proof_late = false
    order by appointment.hold_expires_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.appointments appointment
  set hold_expired_notification_status = 'processing',
      hold_expired_notification_attempts = hold_expired_notification_attempts + 1,
      hold_expired_notification_claimed_at = clock_timestamp()
  from due
  where appointment.id = due.id
  returning appointment.id, appointment.contact_id,
    appointment.hold_expired_notification_attempts;
end;
$$;

create or replace function public.complete_expired_booking_hold_notification(
  p_appointment_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  update public.appointments
  set hold_expired_notification_status = 'sent',
      hold_expired_notification_sent_at = clock_timestamp(),
      hold_expired_notification_claimed_at = null,
      hold_expired_notification_error = null
  where id = p_appointment_id
    and hold_expired_notification_status = 'processing';
  return found;
end;
$$;

create or replace function public.fail_expired_booking_hold_notification(
  p_appointment_id uuid,
  p_error_code text,
  p_retryable boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  update public.appointments
  set hold_expired_notification_status = case
        when p_retryable and hold_expired_notification_attempts < 3
          then 'pending'
        else 'failed'
      end,
      hold_expired_notification_claimed_at = null,
      hold_expired_notification_error = left(
        coalesce(nullif(trim(p_error_code), ''), 'SEND_FAILED'), 120
      )
  where id = p_appointment_id
    and hold_expired_notification_status = 'processing';
  return found;
end;
$$;

-- Sólo turnos confirmados generan recordatorios. Las pre-reservas y los
-- comprobantes pendientes de revisión quedan fuera del scheduler y del claim.
create or replace function public.schedule_appointment_reminders()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.app_settings%rowtype;
  has_consent boolean;
  reminder_at timestamptz;
  appointment_local_date date;
  today_local date;
begin
  select * into settings from public.app_settings where id = true;
  if not found then raise exception 'APP_SETTINGS_NOT_FOUND' using errcode = 'P0002'; end if;
  has_consent := public.has_active_whatsapp_consent(new.contact_id, 'appointment_updates');

  if new.status <> 'confirmed' or new.starts_at <= clock_timestamp() or not has_consent then
    update public.reminders
    set status = 'cancelled', processing_started_at = null,
        last_error = 'POLICY_NOT_AUTHORIZED'
    where appointment_id = new.id and status in ('pending', 'processing');
    return new;
  end if;

  appointment_local_date := (new.starts_at at time zone settings.timezone)::date;
  today_local := (clock_timestamp() at time zone settings.timezone)::date;
  reminder_at := ((appointment_local_date - 1) + settings.reminder_day_before_time)
    at time zone settings.timezone;

  if settings.reminder_24h_enabled and appointment_local_date > today_local then
    insert into public.reminders as existing (appointment_id, type, scheduled_at, status)
    values (new.id, 'appointment_24h', reminder_at, 'pending')
    on conflict (appointment_id, type) do update
    set scheduled_at = excluded.scheduled_at, status = 'pending', message_id = null,
        attempts = 0, last_error = null, sent_at = null, processing_started_at = null
    where existing.status <> 'sent';
  else
    update public.reminders set status = 'cancelled', processing_started_at = null,
      last_error = case when settings.reminder_24h_enabled
        then 'REMINDER_WINDOW_EXPIRED' else 'REMINDER_DISABLED' end
    where appointment_id = new.id and type = 'appointment_24h'
      and status in ('pending', 'processing');
  end if;

  reminder_at := new.starts_at - make_interval(mins => settings.reminder_2h_minutes);
  if settings.reminder_2h_enabled and reminder_at > clock_timestamp() then
    insert into public.reminders as existing (appointment_id, type, scheduled_at, status)
    values (new.id, 'appointment_2h', reminder_at, 'pending')
    on conflict (appointment_id, type) do update
    set scheduled_at = excluded.scheduled_at, status = 'pending', message_id = null,
        attempts = 0, last_error = null, sent_at = null, processing_started_at = null
    where existing.status <> 'sent';
  else
    update public.reminders set status = 'cancelled', processing_started_at = null,
      last_error = case when settings.reminder_2h_enabled
        then 'REMINDER_WINDOW_EXPIRED' else 'REMINDER_DISABLED' end
    where appointment_id = new.id and type = 'appointment_2h'
      and status in ('pending', 'processing');
  end if;
  return new;
end;
$$;

create or replace function public.queue_tomorrow_appointment_reminders(
  p_now timestamptz default clock_timestamp()
)
returns table (queued bigint, already_queued bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.app_settings%rowtype;
  local_today date;
  queue_opens_at timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if p_now is null then raise exception 'INVALID_NOW' using errcode = '22023'; end if;
  select * into settings from public.app_settings where id = true;
  if not found then raise exception 'APP_SETTINGS_NOT_FOUND' using errcode = 'P0002'; end if;
  local_today := (p_now at time zone settings.timezone)::date;
  queue_opens_at := (local_today + settings.reminder_day_before_time)
    at time zone settings.timezone;
  if not settings.reminder_24h_enabled or p_now < queue_opens_at then
    return query select 0::bigint, 0::bigint;
    return;
  end if;

  return query
  with candidates as materialized (
    select appointment.id as appointment_id
    from public.appointments appointment
    where appointment.status = 'confirmed'
      and appointment.starts_at > p_now
      and (appointment.starts_at at time zone settings.timezone)::date = local_today + 1
      and public.has_active_whatsapp_consent(appointment.contact_id, 'appointment_updates')
  ), queued_rows as (
    insert into public.reminders as existing (appointment_id, type, scheduled_at, status)
    select candidate.appointment_id, 'appointment_24h'::public.reminder_type,
      queue_opens_at, 'pending'::public.reminder_status
    from candidates candidate
    on conflict (appointment_id, type) do update
    set scheduled_at = excluded.scheduled_at, status = 'pending',
        message_id = case when existing.status = 'pending' then existing.message_id else null end,
        attempts = case when existing.status = 'pending' then existing.attempts else 0 end,
        last_error = case when existing.status = 'pending' then existing.last_error else null end,
        sent_at = null, processing_started_at = null
    where (existing.status = 'pending' and existing.scheduled_at is distinct from excluded.scheduled_at)
       or (existing.status = 'cancelled' and existing.sent_at is null
           and existing.last_error in (
             'POLICY_NOT_AUTHORIZED', 'POLICY_ROLLOUT_PAUSED', 'REMINDER_DISABLED',
             'REMINDER_WINDOW_EXPIRED', 'WHATSAPP_POLICY:UTILITY_CONSENT_REQUIRED'
           ))
    returning appointment_id
  )
  select (select count(*) from queued_rows),
    (select count(*) from candidates) - (select count(*) from queued_rows);
end;
$$;

create or replace function public.claim_due_reminders(p_limit integer default 25)
returns setof public.reminders
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.reminders
  set status = 'pending', processing_started_at = null,
      last_error = 'STALE_CLAIM_RECOVERED'
  where status = 'processing'
    and (processing_started_at is null
      or processing_started_at < clock_timestamp() - interval '15 minutes');

  update public.reminders reminder
  set status = 'cancelled', processing_started_at = null,
      last_error = 'POLICY_NOT_AUTHORIZED'
  from public.appointments appointment
  where reminder.appointment_id = appointment.id
    and reminder.status in ('pending', 'processing')
    and (appointment.status <> 'confirmed'
      or appointment.starts_at <= clock_timestamp()
      or not public.has_active_whatsapp_consent(appointment.contact_id, 'appointment_updates'));

  update public.reminders reminder
  set status = 'cancelled', processing_started_at = null,
      last_error = 'REMINDER_WINDOW_EXPIRED'
  from public.appointments appointment, public.app_settings settings
  where settings.id = true and reminder.appointment_id = appointment.id
    and reminder.type = 'appointment_24h'
    and reminder.status in ('pending', 'processing')
    and reminder.scheduled_at <= clock_timestamp()
    and (appointment.starts_at at time zone settings.timezone)::date <>
      (clock_timestamp() at time zone settings.timezone)::date + 1;

  return query
  with due as (
    select reminder.id
    from public.reminders reminder
    join public.appointments appointment on appointment.id = reminder.appointment_id
    join public.app_settings settings on settings.id = true
    where reminder.status = 'pending'
      and reminder.scheduled_at <= clock_timestamp()
      and reminder.scheduled_at < appointment.starts_at
      and appointment.starts_at > clock_timestamp()
      and appointment.status = 'confirmed'
      and public.has_active_whatsapp_consent(appointment.contact_id, 'appointment_updates')
      and case reminder.type
        when 'appointment_24h' then settings.reminder_24h_enabled
          and clock_timestamp() >= (
            (clock_timestamp() at time zone settings.timezone)::date
            + settings.reminder_day_before_time
          ) at time zone settings.timezone
          and (appointment.starts_at at time zone settings.timezone)::date =
            (clock_timestamp() at time zone settings.timezone)::date + 1
        when 'appointment_2h' then settings.reminder_2h_enabled
      end
    order by reminder.scheduled_at
    for update of reminder skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.reminders reminder
  set status = 'processing', attempts = attempts + 1,
      processing_started_at = clock_timestamp()
  from due where reminder.id = due.id
  returning reminder.*;
end;
$$;

-- Defensa adicional: aunque una función histórica intente encolar scheduled,
-- el outbox de Google sólo admite upsert para turnos confirmados.
create or replace function public.guard_google_calendar_confirmed_appointment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  appointment_status public.appointment_status;
begin
  select status into appointment_status
  from public.appointments where id = new.appointment_id;
  if appointment_status <> 'confirmed' then
    new.operation := 'delete';
    if new.status = 'processing' then
      -- El request a Google puede seguir en vuelo. Conservamos su claim y la
      -- versión nueva; complete/fail liberará luego un delete determinístico.
      null;
    elsif new.google_event_id is not null
      or (tg_op = 'UPDATE' and old.status = 'processing') then
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

create trigger aa_google_calendar_confirmed_only
  before insert or update on public.google_calendar_sync_jobs
  for each row execute function public.guard_google_calendar_confirmed_appointment();

create or replace function public.reconcile_google_calendar_sync()
returns table (queued bigint, already_queued bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.google_calendar_connections
    where id = true and status = 'connected'
  ) then
    return query select 0::bigint, 0::bigint;
    return;
  end if;

  return query
  with candidates as materialized (
    select appointment.id as appointment_id,
      case when appointment.status = 'confirmed' then 'upsert' else 'delete' end as operation
    from public.appointments appointment
    left join public.google_calendar_sync_jobs job on job.appointment_id = appointment.id
    where (appointment.status = 'confirmed' and appointment.ends_at > clock_timestamp())
       or (appointment.status <> 'confirmed' and job.google_event_id is not null)
  ), changed as (
    insert into public.google_calendar_sync_jobs as current_job (
      appointment_id, operation, desired_version, status, attempts,
      available_at, processing_started_at, last_error, connection_generation
    )
    select candidate.appointment_id, candidate.operation, 1, 'pending', 0,
      clock_timestamp(), null, null, connection.connection_generation
    from candidates candidate
    join public.google_calendar_connections connection
      on connection.id = true and connection.status = 'connected'
    on conflict (appointment_id) do update
    set operation = excluded.operation,
        desired_version = current_job.desired_version + 1,
        status = case when current_job.status = 'processing' then 'processing' else 'pending' end,
        attempts = case when current_job.status = 'processing' then current_job.attempts else 0 end,
        available_at = clock_timestamp(),
        processing_started_at = case when current_job.status = 'processing'
          then current_job.processing_started_at else null end,
        last_error = null,
        connection_generation = greatest(
          current_job.connection_generation, excluded.connection_generation
        )
    where current_job.operation is distinct from excluded.operation
       or current_job.connection_generation is distinct from excluded.connection_generation
       or current_job.status = 'cancelled'
       or (excluded.operation = 'upsert' and current_job.status = 'succeeded'
           and current_job.updated_at < clock_timestamp() - interval '1 hour')
    returning appointment_id
  )
  select (select count(*) from changed),
    (select count(*) from candidates) - (select count(*) from changed);
end;
$$;

create or replace function public.guard_confirmed_reminder_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.direction = 'outbound'
    and new.type = 'template'
    and new.metadata ->> 'template_key' in (
      'appointment_reminder_24h', 'appointment_reminder_2h'
    )
    and not exists (
      select 1 from public.appointments appointment
      where appointment.id::text = new.metadata ->> 'appointment_id'
        and appointment.contact_id = new.contact_id
        and appointment.status = 'confirmed'
        and appointment.starts_at > clock_timestamp()
    ) then
    raise exception 'POLICY_REMINDER_APPOINTMENT_NOT_CONFIRMED' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger aa_messages_confirmed_reminders_only
  before insert or update of status on public.messages
  for each row execute function public.guard_confirmed_reminder_message();

revoke execute on function public.record_deposit_proof(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_deposit_proof(uuid, uuid, timestamptz)
  to service_role;
revoke execute on function public.confirm_appointment_deposit(uuid)
  from public, anon;
grant execute on function public.confirm_appointment_deposit(uuid)
  to authenticated;
revoke execute on function public.claim_expired_booking_hold_notifications(integer)
  from public, anon, authenticated;
revoke execute on function public.complete_expired_booking_hold_notification(uuid)
  from public, anon, authenticated;
revoke execute on function public.fail_expired_booking_hold_notification(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_expired_booking_hold_notifications(integer)
  to service_role;
grant execute on function public.complete_expired_booking_hold_notification(uuid)
  to service_role;
grant execute on function public.fail_expired_booking_hold_notification(uuid, text, boolean)
  to service_role;

revoke execute on function public.appointment_slot_is_available(
  uuid, timestamptz, integer, uuid, text
) from public, anon, authenticated;
revoke execute on function public.create_service_appointment(
  uuid, uuid, uuid, timestamptz, public.appointment_source, text
) from public, anon;
revoke execute on function public.create_appointment(
  uuid, uuid, timestamptz, public.appointment_source, text
) from public, anon;
revoke execute on function public.reschedule_appointment(uuid, timestamptz)
  from public, anon;
revoke execute on function public.reschedule_service_appointment(uuid, timestamptz)
  from public, anon;
grant execute on function public.create_service_appointment(
  uuid, uuid, uuid, timestamptz, public.appointment_source, text
) to authenticated, service_role;
grant execute on function public.create_appointment(
  uuid, uuid, timestamptz, public.appointment_source, text
) to authenticated, service_role;
grant execute on function public.reschedule_appointment(uuid, timestamptz)
  to authenticated, service_role;
grant execute on function public.reschedule_service_appointment(uuid, timestamptz)
  to authenticated, service_role;

revoke execute on function public.schedule_appointment_reminders()
  from public, anon, authenticated;
revoke execute on function public.guard_google_calendar_confirmed_appointment()
  from public, anon, authenticated;
revoke execute on function public.guard_confirmed_reminder_message()
  from public, anon, authenticated;
