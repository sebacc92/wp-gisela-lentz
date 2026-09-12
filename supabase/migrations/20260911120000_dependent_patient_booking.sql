-- Turnos para otra persona desde WhatsApp.
--
-- Quien escribe puede pedir un turno para otra persona: un hijo, su pareja.
-- El turno sigue perteneciendo al WhatsApp que lo gestiona, así que la seña,
-- los recordatorios y cada control de pertenencia siguen mirando
-- `appointments.contact_id` sin cambios. Quien se atiende tiene su propia
-- ficha en `contacts` y queda en `appointments.patient_contact_id`: su
-- cobertura define la duración y su historia clínica no se mezcla con la de
-- quien escribe.
--
-- Esa ficha puede no tener WhatsApp propio. `responsible_contact_id` indica
-- qué contacto la gestiona; un teléfono propio se guarda sólo como
-- `alternate_phone_e164`, que nunca se usa para enviar mensajes.

alter table public.contacts
  add column responsible_contact_id uuid
    references public.contacts (id) on delete restrict,
  add constraint contacts_responsible_not_self_check
    check (responsible_contact_id is distinct from id);

create index contacts_responsible_idx
  on public.contacts (responsible_contact_id)
  where responsible_contact_id is not null;

-- Una ficha a cargo de otro contacto es válida sin identidad de WhatsApp.
alter table public.contacts
  drop constraint contacts_whatsapp_identity_check,
  add constraint contacts_whatsapp_identity_check check (
    phone_e164 is not null
    or whatsapp_user_id is not null
    or responsible_contact_id is not null
  );

alter table public.appointments
  add column patient_contact_id uuid
    references public.contacts (id) on delete restrict,
  add constraint appointments_patient_contact_distinct_check
    check (patient_contact_id is distinct from contact_id);

create index appointments_patient_contact_idx
  on public.appointments (patient_contact_id)
  where patient_contact_id is not null;

comment on column public.contacts.responsible_contact_id is
  'Contacto de WhatsApp que gestiona esta ficha cuando la persona no escribe por su cuenta.';
comment on column public.appointments.patient_contact_id is
  'Ficha de quien se atiende cuando no es el contacto que gestiona el turno.';

-- Cuerpo único de la reserva. `create_service_appointment` conserva su firma y
-- delega acá sin persona a cargo, así que su comportamiento no cambia.
create or replace function public.create_service_appointment_for_patient(
  p_contact_id uuid,
  p_patient_contact_id uuid,
  p_professional_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_source public.appointment_source,
  p_internal_note text,
  p_orthodontic_visit_type public.orthodontic_visit_type
)
returns public.appointments
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  contact_coverage public.patient_coverage;
  intake_required boolean;
  requires_deposit boolean;
  effective_duration integer;
  settings public.app_settings%rowtype;
  requested_ends_with_buffer timestamptz;
  result public.appointments;
begin
  if auth.role() <> 'service_role' and not public.current_user_is_active() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  select service.requires_orthodontic_intake into intake_required
  from public.services service
  where service.id = p_service_id and service.active
  for share;
  if not found then
    raise exception 'SERVICE_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  if intake_required and p_orthodontic_visit_type is null then
    raise exception 'ORTHODONTIC_VISIT_TYPE_REQUIRED' using errcode = 'P0001';
  end if;
  if not intake_required and p_orthodontic_visit_type is not null then
    raise exception 'ORTHODONTIC_VISIT_TYPE_NOT_APPLICABLE' using errcode = 'P0001';
  end if;

  if p_patient_contact_id is null then
    select contact.coverage into contact_coverage
    from public.contacts contact where contact.id = p_contact_id;
  else
    -- Sólo una ficha a cargo de este contacto; su cobertura define el turno.
    select patient.coverage into contact_coverage
    from public.contacts patient
    where patient.id = p_patient_contact_id
      and patient.responsible_contact_id = p_contact_id
      and patient.merged_into_contact_id is null;
    if not found then
      raise exception 'PATIENT_NOT_MANAGED' using errcode = '23514';
    end if;
  end if;
  if contact_coverage is null then
    raise exception 'COVERAGE_REQUIRED' using errcode = 'P0001';
  end if;
  select * into settings from public.app_settings app_settings
  where app_settings.id = true;
  if not found then
    raise exception 'APP_SETTINGS_NOT_FOUND' using errcode = 'P0002';
  end if;
  requires_deposit := settings.deposit_enabled
    and p_orthodontic_visit_type is distinct from 'in_treatment'::public.orthodontic_visit_type;
  effective_duration := case contact_coverage
    when 'ioma' then settings.ioma_duration_minutes
    when 'particular' then settings.private_duration_minutes
  end;
  requested_ends_with_buffer := p_starts_at + make_interval(
    mins => effective_duration + settings.appointment_buffer_minutes
  );

  perform pg_advisory_xact_lock(
    hashtextextended(p_professional_id::text, 0)
  );

  -- First validate without changing any hold. In particular, a stale or
  -- partial Calendar observation cannot cause cleanup as a side effect.
  if not public.google_calendar_automation_scope_is_current(false) then
    raise exception 'CALENDAR_NOT_READY' using errcode = 'P0001';
  end if;

  if not public.appointment_slot_is_available(
    p_professional_id, p_starts_at, effective_duration, null, settings.timezone
  ) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  perform public.expire_overlapping_booking_holds(
    p_professional_id,
    p_starts_at,
    requested_ends_with_buffer,
    null,
    clock_timestamp()
  );
  if not public.google_calendar_automation_scope_is_current(false) then
    raise exception 'CALENDAR_NOT_READY' using errcode = 'P0001';
  end if;

  if not public.appointment_slot_is_available(
    p_professional_id, p_starts_at, effective_duration, null, settings.timezone
  ) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  begin
    insert into public.appointments (
      contact_id, patient_contact_id, professional_id, service_id, starts_at,
      ends_at, status, source, created_by, internal_note, coverage,
      duration_minutes, deposit_status, hold_expires_at,
      hold_expired_notification_status, orthodontic_visit_type
    ) values (
      p_contact_id, p_patient_contact_id, p_professional_id, p_service_id,
      p_starts_at,
      p_starts_at + make_interval(mins => effective_duration),
      case when requires_deposit
        then 'scheduled'::public.appointment_status
        else 'confirmed'::public.appointment_status end,
      p_source, auth.uid(), p_internal_note, contact_coverage,
      effective_duration,
      case when requires_deposit
        then 'pending'::public.deposit_status
        else 'not_required'::public.deposit_status end,
      case when requires_deposit
        then clock_timestamp()
          + make_interval(mins => settings.booking_hold_minutes)
        else null end,
      case when requires_deposit then 'pending' else 'not_applicable' end,
      p_orthodontic_visit_type
    ) returning * into result;
  exception when exclusion_violation then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end;
  return result;
end;
$function$;

revoke all on function public.create_service_appointment_for_patient(
  uuid, uuid, uuid, uuid, timestamptz, public.appointment_source, text,
  public.orthodontic_visit_type
) from public, anon, authenticated, service_role;

create or replace function public.create_service_appointment(
  p_contact_id uuid,
  p_professional_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_source public.appointment_source default 'manual',
  p_internal_note text default null,
  p_orthodontic_visit_type public.orthodontic_visit_type default null
)
returns public.appointments
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  return public.create_service_appointment_for_patient(
    p_contact_id,
    null,
    p_professional_id,
    p_service_id,
    p_starts_at,
    p_source,
    p_internal_note,
    p_orthodontic_visit_type
  );
end;
$function$;

-- Reserva del bot para una persona a cargo del contacto de la conversación.
-- `p_patient` es `{"contact_id": ...}` para una ficha ya existente, o los mismos
-- datos del alta propia para una persona nueva. Una persona nueva se reutiliza
-- si ese contacto ya la había cargado con el mismo nombre.
create or replace function public.create_whatsapp_automation_patient_appointment(
  p_message_id uuid,
  p_lease_token uuid,
  p_contact_id uuid,
  p_patient jsonb,
  p_professional_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_orthodontic_visit_type public.orthodontic_visit_type default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  existing_effect public.whatsapp_automation_effects%rowtype;
  appointment_row public.appointments%rowtype;
  patient_id uuid;
  patient_name text;
  patient_name_key text;
  patient_coverage public.patient_coverage;
  patient_existing boolean;
  patient_phone text;
  responsible_phone text;
  request_value jsonb;
  result_value jsonb;
  target_ends_with_buffer timestamptz;
begin
  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );
  if execution_row.contact_id <> p_contact_id then
    raise exception 'WHATSAPP_AUTOMATION_CONTACT_MISMATCH'
      using errcode = '23514';
  end if;
  request_value := jsonb_build_object(
    'contact_id', p_contact_id,
    'patient', p_patient,
    'professional_id', p_professional_id,
    'service_id', p_service_id,
    'starts_at', p_starts_at,
    'orthodontic_visit_type', p_orthodontic_visit_type
  );

  select effect.* into existing_effect
  from public.whatsapp_automation_effects effect
  where effect.execution_message_id = p_message_id
    and effect.effect_key = 'appointment:create';
  if found then
    if existing_effect.effect_type <> 'appointment_create'
      or existing_effect.request <> request_value then
      raise exception 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT'
        using errcode = '23514';
    end if;
    return existing_effect.result;
  end if;

  if jsonb_typeof(coalesce(p_patient, 'null'::jsonb)) <> 'object' then
    raise exception 'WHATSAPP_AUTOMATION_PATIENT_INVALID'
      using errcode = '22023';
  end if;
  if p_patient ? 'contact_id' then
    if p_patient - 'contact_id' <> '{}'::jsonb
      or jsonb_typeof(p_patient -> 'contact_id') <> 'string'
      or (p_patient ->> 'contact_id')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      raise exception 'WHATSAPP_AUTOMATION_PATIENT_INVALID'
        using errcode = '22023';
    end if;
    select patient.id, patient.coverage into patient_id, patient_coverage
    from public.contacts patient
    where patient.id = (p_patient ->> 'contact_id')::uuid
      and patient.responsible_contact_id = p_contact_id
      and patient.merged_into_contact_id is null;
    if not found then
      raise exception 'WHATSAPP_AUTOMATION_PATIENT_NOT_MANAGED'
        using errcode = '23514';
    end if;
    if patient_coverage is null then
      raise exception 'COVERAGE_REQUIRED' using errcode = 'P0001';
    end if;
  else
    if p_patient - 'name' - 'is_existing_patient' - 'coverage'
        - 'alternate_phone_e164' <> '{}'::jsonb
      or jsonb_typeof(p_patient -> 'name') is distinct from 'string'
      or char_length(trim(p_patient ->> 'name')) not between 1 and 120
      or jsonb_typeof(p_patient -> 'is_existing_patient')
        is distinct from 'boolean'
      or coalesce(p_patient ->> 'coverage', '') not in ('ioma', 'particular')
      or (
        p_patient ? 'alternate_phone_e164'
        and coalesce(p_patient ->> 'alternate_phone_e164', '')
          !~ '^\+[1-9][0-9]{7,14}$'
      )
    then
      raise exception 'WHATSAPP_AUTOMATION_PATIENT_INVALID'
        using errcode = '22023';
    end if;
    patient_name := regexp_replace(trim(p_patient ->> 'name'), '\s+', ' ', 'g');
    patient_name_key := public.google_calendar_patient_name_key(patient_name);
    patient_existing := (p_patient ->> 'is_existing_patient')::boolean;
    patient_coverage := (p_patient ->> 'coverage')::public.patient_coverage;
    select contact.phone_e164 into responsible_phone
    from public.contacts contact
    where contact.id = p_contact_id;
    -- El mismo WhatsApp de quien escribe no se copia: ya se alcanza por su ficha.
    patient_phone := nullif(p_patient ->> 'alternate_phone_e164', responsible_phone);
  end if;

  select p_starts_at + make_interval(
    mins => public.coverage_duration_minutes(patient_coverage)
      + settings.appointment_buffer_minutes
  ) into target_ends_with_buffer
  from public.app_settings settings
  where settings.id = true;

  if not public.google_calendar_booking_observation_covers(
    execution_row.processing_started_at,
    p_starts_at,
    target_ends_with_buffer,
    null
  ) then
    result_value := jsonb_build_object(
      'effect_status', 'rejected',
      'error_code', 'CALENDAR_AVAILABILITY_UNAVAILABLE'
    );
  else
    -- Si el horario ya no está, la ficha nueva se deshace junto con la reserva.
    begin
      if patient_id is null then
        perform pg_advisory_xact_lock(hashtextextended(
          'dependent_patient:' || p_contact_id::text || ':' || patient_name_key,
          0
        ));
        select patient.id into patient_id
        from public.contacts patient
        where patient.responsible_contact_id = p_contact_id
          and patient.merged_into_contact_id is null
          and public.google_calendar_patient_name_key(patient.name)
            = patient_name_key
        order by patient.created_at, patient.id
        limit 1
        for update;
        if found then
          update public.contacts
          set coverage = patient_coverage,
              is_existing_patient = patient_existing,
              alternate_phone_e164 = coalesce(patient_phone, alternate_phone_e164)
          where id = patient_id;
        else
          insert into public.contacts (
            name, coverage, is_existing_patient, alternate_phone_e164,
            responsible_contact_id
          ) values (
            patient_name, patient_coverage, patient_existing, patient_phone,
            p_contact_id
          )
          returning id into patient_id;
        end if;
      end if;
      appointment_row := public.create_service_appointment_for_patient(
        p_contact_id,
        patient_id,
        p_professional_id,
        p_service_id,
        p_starts_at,
        'whatsapp'::public.appointment_source,
        null,
        p_orthodontic_visit_type
      );
      result_value := to_jsonb(appointment_row);
    exception when raise_exception then
      if sqlerrm = 'SLOT_UNAVAILABLE' then
        result_value := jsonb_build_object(
          'effect_status', 'rejected',
          'error_code', 'SLOT_UNAVAILABLE'
        );
      else
        raise;
      end if;
    end;
  end if;

  insert into public.whatsapp_automation_effects (
    execution_message_id,
    effect_key,
    effect_type,
    request,
    result,
    appointment_id
  ) values (
    p_message_id,
    'appointment:create',
    'appointment_create',
    request_value,
    result_value,
    case
      when result_value ->> 'effect_status' = 'rejected' then null
      else appointment_row.id
    end
  );
  return result_value;
end;
$function$;

revoke execute on function public.create_whatsapp_automation_patient_appointment(
  uuid, uuid, uuid, jsonb, uuid, uuid, timestamptz, public.orthodontic_visit_type
) from public, anon, authenticated;
grant execute on function public.create_whatsapp_automation_patient_appointment(
  uuid, uuid, uuid, jsonb, uuid, uuid, timestamptz, public.orthodontic_visit_type
) to service_role;

-- Reprogramar (desde la app o el bot) y aceptar en la app un cambio hecho en
-- Google recalculan la duración con la cobertura de quien se atiende. Se
-- parchea el texto vigente en lugar de reescribir estas funciones: otras
-- migraciones les agregaron defensas sobre la misma base, y reescribirlas las
-- borraría en silencio. Si la forma cambió, la migración falla de entrada.
do $migration$
declare
  target regprocedure := 'public.reschedule_appointment(uuid,timestamptz)';
  prior_definition text;
  patched_definition text;
  contact_marker text := E'  select contact.coverage into contact_coverage\n  from public.contacts contact\n  where contact.id = current_appointment.contact_id\n  for key share;';
  patient_marker text := E'  select contact.coverage into contact_coverage\n  from public.contacts contact\n  where contact.id = coalesce(\n    current_appointment.patient_contact_id,\n    current_appointment.contact_id\n  )\n  for key share;';
begin
  prior_definition := pg_get_functiondef(target);
  patched_definition := replace(prior_definition, contact_marker, patient_marker);
  if patched_definition = prior_definition
    or position(contact_marker in patched_definition) > 0
    or position(patient_marker in prior_definition) > 0
  then
    raise exception 'DEPENDENT_PATIENT_COVERAGE_DEFINITION_DRIFT: %', target;
  end if;
  execute patched_definition;
end;
$migration$;

do $migration$
declare
  target regprocedure :=
    'public.reschedule_whatsapp_automation_appointment(uuid,uuid,uuid,timestamptz)';
  prior_definition text;
  patched_definition text;
  contact_marker text := E'    where contact.id = appointment_row.contact_id and settings.id = true;';
  patient_marker text := E'    where contact.id = coalesce(\n        appointment_row.patient_contact_id,\n        appointment_row.contact_id\n      )\n      and settings.id = true;';
begin
  prior_definition := pg_get_functiondef(target);
  patched_definition := replace(prior_definition, contact_marker, patient_marker);
  if patched_definition = prior_definition
    or position(contact_marker in patched_definition) > 0
    or position(patient_marker in prior_definition) > 0
  then
    raise exception 'DEPENDENT_PATIENT_COVERAGE_DEFINITION_DRIFT: %', target;
  end if;
  execute patched_definition;
end;
$migration$;

do $migration$
declare
  target regprocedure := 'public.apply_google_calendar_conflict(uuid)';
  prior_definition text;
  patched_definition text;
  contact_marker text := E'    select contact.coverage into contact_coverage\n    from public.contacts contact\n    where contact.id = current_appointment.contact_id\n    for key share;';
  patient_marker text := E'    select contact.coverage into contact_coverage\n    from public.contacts contact\n    where contact.id = coalesce(\n      current_appointment.patient_contact_id,\n      current_appointment.contact_id\n    )\n    for key share;';
begin
  prior_definition := pg_get_functiondef(target);
  patched_definition := replace(prior_definition, contact_marker, patient_marker);
  if patched_definition = prior_definition
    or position(contact_marker in patched_definition) > 0
    or position(patient_marker in prior_definition) > 0
  then
    raise exception 'DEPENDENT_PATIENT_COVERAGE_DEFINITION_DRIFT: %', target;
  end if;
  execute patched_definition;
end;
$migration$;

/**
 * Une dos fichas administrativas bajo `p_primary_id`.
 *
 * No borra nada: la ficha duplicada queda marcada como fusionada y conserva su
 * fila, así cualquier referencia histórica sigue resolviendo. Mueve turnos,
 * mensajes, conversaciones y personas a cargo, y deja asiento en `audit_logs`.
 *
 * Sólo hay una conversación abierta por contacto, así que si ambas fichas
 * tienen una, la del duplicado se cierra antes de reasignarla en lugar de
 * romper el índice.
 */
create or replace function public.merge_patient_records(
  p_primary_id uuid,
  p_duplicate_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  moved_appointments integer := 0;
  moved_patient_appointments integer := 0;
  moved_messages integer := 0;
  moved_conversations integer := 0;
  clinical_entries integer := 0;
  primary_has_open boolean := false;
begin
  if not public.current_user_is_admin() then
    raise exception 'PATIENT_MERGE_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_primary_id is null or p_duplicate_id is null
    or p_primary_id = p_duplicate_id then
    raise exception 'PATIENT_MERGE_INVALID_PAIR' using errcode = '22023';
  end if;

  -- Orden estable de bloqueo: dos fusiones simultáneas no se traban entre sí.
  perform 1 from public.contacts
  where id in (p_primary_id, p_duplicate_id)
  order by id
  for update;

  if not exists (select 1 from public.contacts where id = p_primary_id) then
    raise exception 'PATIENT_MERGE_PRIMARY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.contacts where id = p_duplicate_id) then
    raise exception 'PATIENT_MERGE_DUPLICATE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.contacts
    where id = p_duplicate_id and merged_into_contact_id is not null
  ) then
    raise exception 'PATIENT_MERGE_ALREADY_MERGED' using errcode = '22023';
  end if;

  select count(*) into clinical_entries
  from public.odontogram_entries
  where contact_id = p_duplicate_id;

  -- La historia clínica no se reasigna. Se corta antes de mover nada.
  if clinical_entries > 0 then
    raise exception 'PATIENT_MERGE_CLINICAL_HISTORY' using errcode = '42501';
  end if;

  -- Las personas a cargo del duplicado pasan a la principal. Si el duplicado
  -- estaba a cargo de alguien, la principal hereda ese vínculo.
  update public.contacts
  set responsible_contact_id = p_primary_id
  where responsible_contact_id = p_duplicate_id
    and id <> p_primary_id;

  update public.contacts contact
  set responsible_contact_id = case
      when contact.responsible_contact_id = p_duplicate_id then null
      else coalesce(
        contact.responsible_contact_id,
        nullif(duplicate.responsible_contact_id, p_primary_id)
      )
    end
  from public.contacts duplicate
  where contact.id = p_primary_id
    and duplicate.id = p_duplicate_id;

  -- Quien se atendía como duplicado pasa a ser la principal; si la principal
  -- ya gestiona ese turno, deja de figurar como tercero.
  update public.appointments
  set patient_contact_id = case
      when contact_id = p_primary_id then null
      else p_primary_id
    end
  where patient_contact_id = p_duplicate_id;
  get diagnostics moved_patient_appointments = row_count;

  update public.appointments
  set contact_id = p_primary_id,
      patient_contact_id = nullif(patient_contact_id, p_primary_id)
  where contact_id = p_duplicate_id;
  get diagnostics moved_appointments = row_count;

  update public.messages set contact_id = p_primary_id
  where contact_id = p_duplicate_id;
  get diagnostics moved_messages = row_count;

  select exists (
    select 1 from public.conversations
    where contact_id = p_primary_id and status = 'open'
  ) into primary_has_open;

  if primary_has_open then
    update public.conversations
    set status = 'closed'
    where contact_id = p_duplicate_id and status = 'open';
  end if;

  update public.conversations set contact_id = p_primary_id
  where contact_id = p_duplicate_id;
  get diagnostics moved_conversations = row_count;

  update public.contacts
  set merged_into_contact_id = p_primary_id,
      merged_at = now()
  where id = p_duplicate_id;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(),
    'patient_records_merged',
    'contact',
    p_primary_id,
    jsonb_build_object(
      'duplicate_contact_id', p_duplicate_id,
      'moved_appointments', moved_appointments,
      'moved_patient_appointments', moved_patient_appointments,
      'moved_messages', moved_messages,
      'moved_conversations', moved_conversations
    )
  );

  return jsonb_build_object(
    'primaryContactId', p_primary_id,
    'duplicateContactId', p_duplicate_id,
    'movedAppointments', moved_appointments,
    'movedMessages', moved_messages,
    'movedConversations', moved_conversations
  );
end;
$$;
