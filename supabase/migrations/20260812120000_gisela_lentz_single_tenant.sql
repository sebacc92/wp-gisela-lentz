-- Adaptación incremental y no destructiva para el consultorio de Gisela Lentz.
-- Las entidades históricas se conservan; sólo se desactivan los profesionales
-- heredados para que la agenda opere como single tenant / single professional.

alter table public.contacts
  add column email text,
  add column administrative_notes text,
  add constraint contacts_email_length_check check (
    email is null or char_length(trim(email)) between 3 and 320
  ),
  add constraint contacts_administrative_notes_length_check check (
    administrative_notes is null
    or char_length(administrative_notes) <= 4000
  );

create table public.services (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  description text check (
    description is null or char_length(description) <= 1000
  ),
  duration_minutes integer not null default 30
    check (duration_minutes between 5 and 480),
  active boolean not null default true,
  sort_order integer not null default 0 check (sort_order between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index services_name_unique_idx
  on public.services (lower(trim(name)));
create index services_active_sort_idx
  on public.services (active, sort_order, name);

create trigger set_services_updated_at
  before update on public.services
  for each row execute function public.set_updated_at();

alter table public.appointments
  add column service_id uuid references public.services (id) on delete restrict;

create index appointments_service_starts_idx
  on public.appointments (service_id, starts_at)
  where service_id is not null;

alter table public.conversations
  add column priority boolean not null default false;

create index conversations_priority_attention_idx
  on public.conversations (priority desc, unread_count desc, last_message_at desc)
  where status = 'open';

alter table public.app_settings
  add column business_subtitle text not null default 'Odontología',
  add column business_phone text,
  add column business_email text,
  add column business_address text,
  add column logo_url text,
  add column default_appointment_duration_minutes integer not null default 30,
  add column appointment_buffer_minutes integer not null default 0,
  add column minimum_booking_notice_minutes integer not null default 60,
  add column out_of_hours_enabled boolean not null default true,
  add column out_of_hours_message text not null default
    'Gracias por escribir. En este momento el consultorio se encuentra fuera del horario de atención. Recibimos tu mensaje y te responderemos cuando retomemos la atención.',
  add column out_of_hours_cooldown_minutes integer not null default 720,
  add column urgent_keywords text[] not null default
    array['urgencia', 'dolor intenso', 'sangrado', 'emergencia', 'accidente']::text[],
  add column urgent_message text not null default
    'Tu mensaje requiere atención humana. No podemos dar indicaciones clínicas automáticas; te responderemos personalmente lo antes posible.',
  add column general_info_message text,
  add constraint app_settings_business_subtitle_length_check check (
    char_length(trim(business_subtitle)) between 1 and 120
  ),
  add constraint app_settings_phone_length_check check (
    business_phone is null or char_length(trim(business_phone)) between 5 and 40
  ),
  add constraint app_settings_email_length_check check (
    business_email is null or char_length(trim(business_email)) between 3 and 320
  ),
  add constraint app_settings_address_length_check check (
    business_address is null or char_length(trim(business_address)) between 3 and 500
  ),
  add constraint app_settings_logo_url_length_check check (
    logo_url is null or char_length(trim(logo_url)) between 8 and 2048
  ),
  add constraint app_settings_default_duration_check check (
    default_appointment_duration_minutes between 5 and 480
  ),
  add constraint app_settings_buffer_check check (
    appointment_buffer_minutes between 0 and 240
  ),
  add constraint app_settings_minimum_booking_notice_check check (
    minimum_booking_notice_minutes between 0 and 43200
  ),
  add constraint app_settings_out_of_hours_message_length_check check (
    char_length(trim(out_of_hours_message)) between 1 and 1024
  ),
  add constraint app_settings_out_of_hours_cooldown_check check (
    out_of_hours_cooldown_minutes between 5 and 10080
  ),
  add constraint app_settings_urgent_keywords_check check (
    cardinality(urgent_keywords) between 1 and 50
  ),
  add constraint app_settings_urgent_message_length_check check (
    char_length(trim(urgent_message)) between 1 and 1024
  ),
  add constraint app_settings_general_info_message_length_check check (
    general_info_message is null
    or char_length(trim(general_info_message)) between 1 and 2048
  );

alter table public.app_settings
  alter column clinic_name set default 'Gisela Lentz',
  alter column automation_welcome_message set default
    E'¡Hola! Soy el asistente virtual de Gisela Lentz 👋\n\nPuedo ayudarte a sacar, reprogramar o cancelar un turno. También podés consultar tus próximos turnos o hablar con Gisela.\n\n¿En qué podemos ayudarte?';

-- Sólo se reemplazan valores que todavía coinciden exactamente con los defaults
-- heredados. Las personalizaciones realizadas por un administrador se preservan.
update public.app_settings
set clinic_name = 'Gisela Lentz'
where clinic_name = 'COLP';

update public.app_settings
set automation_welcome_message =
  E'¡Hola! Soy el asistente virtual de Gisela Lentz 👋\n\nPuedo ayudarte a sacar, reprogramar o cancelar un turno. También podés consultar tus próximos turnos o hablar con Gisela.\n\n¿En qué podemos ayudarte?'
where automation_welcome_message =
  E'¡Hola! Soy el asistente virtual de COLP 👋\n\nPuedo ayudarte a sacar, reprogramar o cancelar un turno. También podés consultar tus próximos turnos o hablar con recepción.\n\n¿En qué podemos ayudarte?';

update public.message_templates
set body_preview = 'Tu turno con Gisela Lentz quedó reservado.'
where key = 'appointment_created'
  and body_preview = 'Tu turno en COLP quedó reservado.';

update public.message_templates
set body_preview = 'Te recordamos tu turno de mañana con Gisela Lentz.'
where key = 'appointment_reminder_24h'
  and body_preview = 'Te recordamos tu turno de mañana en COLP.';

update public.message_templates
set body_preview = 'Te recordamos que tu turno con Gisela Lentz es dentro de dos horas.'
where key = 'appointment_reminder_2h'
  and body_preview = 'Te recordamos que tu turno en COLP es dentro de dos horas.';

update public.message_templates
set body_preview = 'Tu turno con Gisela Lentz fue cancelado.'
where key = 'appointment_cancelled'
  and body_preview = 'Tu turno en COLP fue cancelado.';

update public.message_templates
set body_preview = 'Tu turno con Gisela Lentz fue reprogramado.'
where key = 'appointment_rescheduled'
  and body_preview = 'Tu turno en COLP fue reprogramado.';

update public.quick_replies
set body = 'Los horarios de atención pueden variar. Consultanos y te indicamos la disponibilidad actual.'
where shortcut = '/horarios'
  and body = 'Nuestro horario de atención es de lunes a viernes de 8:00 a 18:00.';

update public.quick_replies
set body = 'La dirección del consultorio todavía no está configurada. Consultanos por este chat.'
where shortcut = '/ubicacion'
  and body = 'Estamos en La Plata. Si querés, te compartimos la ubicación exacta.';

update public.quick_replies
set body = 'Recibimos tu mensaje. Gisela te responderá en breve.'
where shortcut = '/espera'
  and body = 'Recibimos tu mensaje. En breve te responde recepción.';

-- Una única profesional activa. Los registros y turnos históricos de los demás
-- profesionales no se borran ni se reasignan.
do $$
declare
  gisela_id uuid;
begin
  select id into gisela_id
  from public.professionals
  where lower(trim(name)) = 'gisela lentz'
  order by created_at, id
  limit 1;

  if gisela_id is null then
    gisela_id := '67697365-6c61-4765-8a2d-6c656e747a01'::uuid;
    insert into public.professionals (
      id, name, specialty, appointment_duration_minutes, active
    ) values (
      gisela_id, 'Gisela Lentz', 'Odontología', 30, true
    );
  else
    update public.professionals
    set specialty = 'Odontología', active = true
    where id = gisela_id;
  end if;

  update public.professionals
  set active = false
  where id <> gisela_id and active;
end;
$$;

insert into public.services (
  id, name, description, duration_minutes, active, sort_order
)
values
  ('51000000-0000-4000-8000-000000000001', 'Consulta', null, 30, true, 10),
  ('51000000-0000-4000-8000-000000000002', 'Control', null, 30, true, 20),
  ('51000000-0000-4000-8000-000000000003', 'Limpieza', null, 45, true, 30),
  ('51000000-0000-4000-8000-000000000004', 'Urgencia / dolor', null, 30, true, 40),
  ('51000000-0000-4000-8000-000000000005', 'Extracción', null, 60, true, 50),
  ('51000000-0000-4000-8000-000000000006', 'Blanqueamiento', null, 60, true, 60),
  ('51000000-0000-4000-8000-000000000007', 'Ortodoncia', null, 45, true, 70);

-- Las franjas semanales continúan en availability_rules y los bloqueos o
-- aperturas excepcionales en availability_exceptions. No se inventan horarios
-- productivos para Gisela en esta migración; el seed local sí incluye una demo.

alter table public.services enable row level security;

create policy services_read on public.services
  for select to authenticated
  using (public.current_user_is_active());
create policy services_admin_insert on public.services
  for insert to authenticated
  with check (public.current_user_is_admin());
create policy services_admin_update on public.services
  for update to authenticated
  using (public.current_user_is_admin())
  with check (public.current_user_is_admin());
create policy services_admin_delete on public.services
  for delete to authenticated
  using (public.current_user_is_admin());

revoke all on public.services from public, anon, authenticated;
grant select, insert, update, delete on public.services to authenticated;
grant all on public.services to service_role;

grant insert (name, phone_e164, email, administrative_notes)
  on public.contacts to authenticated;
grant update (name, phone_e164, email, administrative_notes)
  on public.contacts to authenticated;
grant update (priority) on public.conversations to authenticated;

-- Autoridad central de disponibilidad. Además del constraint de exclusión ya
-- existente, los RPC toman un advisory lock por profesional para serializar la
-- validación de buffers y evitar carreras entre dos reservas simultáneas.
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
      select 1
      from public.availability_rules rule
      where rule.professional_id = p_professional_id
        and rule.active
        and rule.weekday = extract(dow from local_date)::smallint
        and local_start::time >= rule.start_time
        and local_end_with_buffer::time <= rule.end_time
    )
    or exists (
      select 1
      from public.availability_exceptions availability_exception
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
    select 1
    from public.availability_exceptions availability_exception
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
    select 1
    from public.appointments appointment
    where appointment.professional_id = p_professional_id
      and appointment.status in ('scheduled', 'confirmed')
      and (p_exclude_appointment_id is null or appointment.id <> p_exclude_appointment_id)
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

create or replace function public.get_available_slots_by_duration(
  p_professional_id uuid,
  p_duration_minutes integer,
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
  settings public.app_settings%rowtype;
  effective_timezone text;
  buffer_minutes integer;
begin
  if p_duration_minutes is null or p_duration_minutes not between 5 and 480 then
    return;
  end if;

  select * into settings from public.app_settings where id = true;
  if not found then return; end if;
  effective_timezone := coalesce(nullif(trim(p_timezone), ''), settings.timezone);
  buffer_minutes := settings.appointment_buffer_minutes;

  return query
  with windows as (
    select
      (p_date + rule.start_time) at time zone effective_timezone as window_start,
      (p_date + rule.end_time) at time zone effective_timezone as window_end,
      rule.slot_minutes as step_minutes
    from public.availability_rules rule
    where rule.professional_id = p_professional_id
      and rule.active
      and rule.weekday = extract(dow from p_date)::smallint

    union all

    select
      case
        when availability_exception.start_time is null
          then p_date::timestamp at time zone effective_timezone
        else (p_date + availability_exception.start_time) at time zone effective_timezone
      end,
      case
        when availability_exception.end_time is null
          then (p_date + 1)::timestamp at time zone effective_timezone
        else (p_date + availability_exception.end_time) at time zone effective_timezone
      end,
      greatest(5, p_duration_minutes + buffer_minutes)
    from public.availability_exceptions availability_exception
    where availability_exception.professional_id = p_professional_id
      and availability_exception.date = p_date
      and availability_exception.type = 'available'
  ),
  generated as (
    select candidate as candidate_start
    from windows service_window
    cross join lateral generate_series(
      service_window.window_start,
      service_window.window_end
        - make_interval(mins => p_duration_minutes + buffer_minutes),
      make_interval(mins => service_window.step_minutes)
    ) candidate
  )
  select distinct
    generated.candidate_start,
    generated.candidate_start + make_interval(mins => p_duration_minutes)
  from generated
  where public.appointment_slot_is_available(
    p_professional_id,
    generated.candidate_start,
    p_duration_minutes,
    null,
    effective_timezone
  )
  order by generated.candidate_start
  limit greatest(1, least(coalesce(p_limit, 40), 200));
end;
$$;

create or replace function public.get_available_slots_for_service(
  p_professional_id uuid,
  p_service_id uuid,
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
  service_duration integer;
begin
  if auth.role() <> 'service_role' and not public.current_user_is_active() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select duration_minutes into service_duration
  from public.services
  where id = p_service_id and active;

  if service_duration is null then return; end if;

  return query
  select slot.starts_at, slot.ends_at
  from public.get_available_slots_by_duration(
    p_professional_id,
    service_duration,
    p_date,
    p_timezone,
    p_limit
  ) slot;
end;
$$;

-- RPC histórico: conserva su firma y usa la duración configurada en el registro
-- del profesional para no romper clientes existentes.
create or replace function public.get_available_slots(
  p_professional_id uuid,
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
  professional_duration integer;
begin
  if auth.role() <> 'service_role' and not public.current_user_is_active() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select appointment_duration_minutes into professional_duration
  from public.professionals
  where id = p_professional_id and active;

  if professional_duration is null then return; end if;

  return query
  select slot.starts_at, slot.ends_at
  from public.get_available_slots_by_duration(
    p_professional_id,
    professional_duration,
    p_date,
    p_timezone,
    p_limit
  ) slot;
end;
$$;

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
  service_duration integer;
  settings_timezone text;
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not exists (
    select 1 from public.profiles where id = auth.uid() and active
  ) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select duration_minutes into service_duration
  from public.services
  where id = p_service_id and active;
  if service_duration is null then
    raise exception 'SERVICE_NOT_AVAILABLE' using errcode = 'P0001';
  end if;

  select timezone into settings_timezone
  from public.app_settings where id = true;

  perform pg_advisory_xact_lock(hashtextextended(p_professional_id::text, 0));
  if not public.appointment_slot_is_available(
    p_professional_id,
    p_starts_at,
    service_duration,
    null,
    settings_timezone
  ) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  begin
    insert into public.appointments (
      contact_id, professional_id, service_id, starts_at, ends_at,
      source, created_by, internal_note
    ) values (
      p_contact_id, p_professional_id, p_service_id, p_starts_at,
      p_starts_at + make_interval(mins => service_duration),
      p_source, auth.uid(), p_internal_note
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
  duration_minutes integer;
  settings_timezone text;
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not exists (
    select 1 from public.profiles where id = auth.uid() and active
  ) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select appointment_duration_minutes into duration_minutes
  from public.professionals
  where id = p_professional_id and active;
  if duration_minutes is null then
    raise exception 'PROFESSIONAL_NOT_AVAILABLE' using errcode = 'P0001';
  end if;

  select timezone into settings_timezone
  from public.app_settings where id = true;

  perform pg_advisory_xact_lock(hashtextextended(p_professional_id::text, 0));
  if not public.appointment_slot_is_available(
    p_professional_id,
    p_starts_at,
    duration_minutes,
    null,
    settings_timezone
  ) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  begin
    insert into public.appointments (
      contact_id, professional_id, starts_at, ends_at,
      source, created_by, internal_note
    ) values (
      p_contact_id, p_professional_id, p_starts_at,
      p_starts_at + make_interval(mins => duration_minutes),
      p_source, auth.uid(), p_internal_note
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
  duration_minutes integer;
  appointment_professional_id uuid;
  settings_timezone text;
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not exists (
    select 1 from public.profiles where id = auth.uid() and active
  ) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select
    appointment.professional_id,
    coalesce(service.duration_minutes, professional.appointment_duration_minutes)
  into appointment_professional_id, duration_minutes
  from public.appointments appointment
  join public.professionals professional
    on professional.id = appointment.professional_id and professional.active
  left join public.services service on service.id = appointment.service_id
  where appointment.id = p_appointment_id
    and appointment.status in ('scheduled', 'confirmed');

  if duration_minutes is null or appointment_professional_id is null then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select timezone into settings_timezone
  from public.app_settings where id = true;

  perform pg_advisory_xact_lock(hashtextextended(appointment_professional_id::text, 0));
  if not public.appointment_slot_is_available(
    appointment_professional_id,
    p_starts_at,
    duration_minutes,
    p_appointment_id,
    settings_timezone
  ) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  begin
    update public.appointments
    set starts_at = p_starts_at,
        ends_at = p_starts_at + make_interval(mins => duration_minutes),
        status = 'scheduled'
    where id = p_appointment_id
      and status in ('scheduled', 'confirmed')
    returning * into result;
  exception when exclusion_violation then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end;

  if result.id is null then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
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

revoke execute on function public.appointment_slot_is_available(
  uuid, timestamptz, integer, uuid, text
) from public, anon, authenticated;
revoke execute on function public.get_available_slots_by_duration(
  uuid, integer, date, text, integer
) from public, anon, authenticated;
revoke execute on function public.get_available_slots_for_service(
  uuid, uuid, date, text, integer
) from public, anon;
revoke execute on function public.create_service_appointment(
  uuid, uuid, uuid, timestamptz, public.appointment_source, text
) from public, anon;
revoke execute on function public.reschedule_service_appointment(uuid, timestamptz)
  from public, anon;

grant execute on function public.get_available_slots_for_service(
  uuid, uuid, date, text, integer
) to authenticated, service_role;
grant execute on function public.create_service_appointment(
  uuid, uuid, uuid, timestamptz, public.appointment_source, text
) to authenticated, service_role;
grant execute on function public.reschedule_service_appointment(uuid, timestamptz)
  to authenticated, service_role;

-- Reafirmar los permisos de los RPC históricos reemplazados arriba.
revoke execute on function public.get_available_slots(uuid, date, text, integer)
  from public, anon;
revoke execute on function public.create_appointment(
  uuid, uuid, timestamptz, public.appointment_source, text
) from public, anon;
revoke execute on function public.reschedule_appointment(uuid, timestamptz)
  from public, anon;
grant execute on function public.get_available_slots(uuid, date, text, integer)
  to authenticated, service_role;
grant execute on function public.create_appointment(
  uuid, uuid, timestamptz, public.appointment_source, text
) to authenticated, service_role;
grant execute on function public.reschedule_appointment(uuid, timestamptz)
  to authenticated, service_role;
