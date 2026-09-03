-- Correcciones sobre la revisión manual de comprobantes.
--
--   1. `claim_deposit_proof_review` marcaba el acuse como enviado ANTES de
--      enviarlo. Si el envío fallaba, el reintento veía `acknowledge = false`
--      y el paciente quedaba sin respuesta para siempre.
--   2. `admin_confirm_appointment_deposit` confirmaba cualquier pre-reserva
--      viva, incluso con el hold vencido y el horario ya ocupado por otro
--      turno o por un bloqueo importado.
--   3. La auditoría no dejaba constancia de que la validación es una decisión
--      del operador y no una acreditación bancaria.

-- ---------------------------------------------------------------------------
-- 1. ¿El horario sigue libre para este turno?
-- ---------------------------------------------------------------------------
--
-- Deliberadamente NO reusa `appointment_slot_is_available`: aquélla exige
-- además ventana laboral y antelación mínima, que no tienen nada que ver con
-- confirmar una seña de un turno que ya estaba agendado.

create or replace function public.appointment_slot_is_free_for(
  p_appointment_id uuid
)
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  appointment_row public.appointments%rowtype;
  buffer_minutes integer;
  requested_range tstzrange;
begin
  select * into appointment_row
  from public.appointments where id = p_appointment_id;
  if not found then return false; end if;

  select appointment_buffer_minutes into buffer_minutes
  from public.app_settings where id = true;
  if buffer_minutes is null then return false; end if;

  requested_range := tstzrange(
    appointment_row.starts_at,
    appointment_row.ends_at + make_interval(mins => buffer_minutes),
    '[)'
  );

  if exists (
    select 1 from public.appointments other
    where other.id <> p_appointment_id
      and other.professional_id = appointment_row.professional_id
      and other.status in ('scheduled', 'confirmed')
      and tstzrange(
        other.starts_at,
        other.ends_at + make_interval(mins => buffer_minutes),
        '[)'
      ) && requested_range
  ) then
    return false;
  end if;

  return not exists (
    select 1
    from public.google_calendar_external_events external_event
    join public.google_calendar_connections connection
      on connection.id = true
      and connection.status = 'connected'
      and connection.google_calendar_id = external_event.google_calendar_id
      and connection.connection_generation = external_event.connection_generation
    where external_event.kind = 'block'
      and external_event.status = 'active'
      and tstzrange(
        external_event.starts_at,
        external_event.ends_at,
        '[)'
      ) && requested_range
  );
end;
$$;

revoke execute on function public.appointment_slot_is_free_for(uuid)
  from public, anon;
grant execute on function public.appointment_slot_is_free_for(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Confirmación manual con el horario revalidado
-- ---------------------------------------------------------------------------

create or replace function public.admin_confirm_appointment_deposit(
  p_appointment_id uuid
)
returns table (
  appointment_id uuid,
  contact_id uuid,
  starts_at timestamptz,
  already_confirmed boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  appointment_professional_id uuid;
  current_appointment public.appointments%rowtype;
  result public.appointments;
  hold_expired boolean;
begin
  if not public.current_user_is_admin() or auth.uid() is null then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select appointment.professional_id into appointment_professional_id
  from public.appointments appointment
  where appointment.id = p_appointment_id;
  if appointment_professional_id is null then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(appointment_professional_id::text, 0)
  );
  select appointment.* into current_appointment
  from public.appointments appointment
  where appointment.id = p_appointment_id
  for update;
  if not found then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Idempotencia: repetir la acción no vuelve a auditar, no vuelve a encolar
  -- Google Calendar y no habilita un segundo mensaje al paciente.
  if current_appointment.status = 'confirmed'
    and current_appointment.deposit_status = 'confirmed'
  then
    return query select current_appointment.id,
                        current_appointment.contact_id,
                        current_appointment.starts_at,
                        true;
    return;
  end if;

  if current_appointment.status <> 'scheduled' then
    raise exception 'APPOINTMENT_NOT_SCHEDULED' using errcode = 'P0001';
  end if;

  hold_expired :=
    current_appointment.deposit_proof_late
    or (
      current_appointment.deposit_status = 'pending'
      and current_appointment.hold_expires_at is not null
      and current_appointment.hold_expires_at <= clock_timestamp()
    );

  -- Con el hold vencido la pre-reserva dejó de ocupar el horario: confirmar a
  -- ciegas podría pisar un turno tomado después o un bloqueo importado. La
  -- persona ADMIN recibe un código explícito para saber qué corresponde hacer.
  if hold_expired then
    if current_appointment.starts_at <= clock_timestamp() then
      raise exception 'APPOINTMENT_ALREADY_STARTED' using errcode = 'P0001';
    end if;
    if not public.appointment_slot_is_free_for(p_appointment_id) then
      raise exception 'SLOT_NO_LONGER_AVAILABLE' using errcode = 'P0001';
    end if;
  end if;

  update public.appointments appointment
  set status = 'confirmed',
      deposit_status = 'confirmed',
      deposit_confirmed_at = clock_timestamp(),
      deposit_confirmed_by = auth.uid(),
      deposit_confirmation_actor = null,
      deposit_confirmation_policy_version = null,
      hold_expired_notification_status = 'cancelled',
      hold_expired_notification_claimed_at = null,
      hold_expired_notification_error = null
  where appointment.id = p_appointment_id
  returning appointment.* into result;

  update public.deposit_proof_reviews review
  set status = 'confirmed',
      reviewed_at = clock_timestamp(),
      reviewed_by = auth.uid()
  where review.appointment_id = p_appointment_id and review.status = 'pending';

  update public.conversations conversation
  set needs_human = false,
      current_flow = null
  from public.messages proof_message
  where proof_message.id = result.deposit_proof_message_id
    and proof_message.contact_id = result.contact_id
    and conversation.id = proof_message.conversation_id
    and conversation.contact_id = result.contact_id
    and conversation.status = 'open'
    and conversation.current_flow = 'deposit_proof_received'
    and not exists (
      select 1
      from public.messages later_message
      where later_message.conversation_id = proof_message.conversation_id
        and later_message.direction = 'inbound'
        and later_message.whatsapp_ingest_sequence >
          proof_message.whatsapp_ingest_sequence
    );

  -- La revisión de un comprobante NO acredita una transferencia bancaria. Lo
  -- que queda registrado es exactamente eso: la decisión de una persona.
  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(), 'deposit.confirmed_manually', 'appointment', result.id,
    jsonb_build_object(
      'appointment_id', result.id,
      'confirmed_at', result.deposit_confirmed_at,
      'previous_deposit_status', current_appointment.deposit_status,
      'proof_late', current_appointment.deposit_proof_late,
      'hold_expired', hold_expired,
      'decision', 'operator_manual_review',
      'verifies_bank_transfer', false
    )
  );

  return query select result.id, result.contact_id, result.starts_at, false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. El acuse se marca DESPUÉS de entregarlo
-- ---------------------------------------------------------------------------

create or replace function public.claim_deposit_proof_review(
  p_contact_id uuid,
  p_message_id uuid,
  p_received_at timestamptz default clock_timestamp()
)
returns table (
  appointment_id uuid,
  recognized boolean,
  acknowledge boolean,
  review_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  existing public.deposit_proof_reviews%rowtype;
  candidate public.appointments%rowtype;
  inserted_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  -- El mensaje tiene que ser de ESTE contacto: un comprobante nunca puede
  -- asociarse al turno de otra persona.
  if not exists (
    select 1 from public.messages message
    where message.id = p_message_id
      and message.contact_id = p_contact_id
      and message.direction = 'inbound'
      and message.type in ('image', 'document')
      and message.revoked_at is null
  ) then
    raise exception 'INVALID_DEPOSIT_PROOF' using errcode = '22023';
  end if;

  select * into existing from public.deposit_proof_reviews
  where proof_message_id = p_message_id;
  if found then
    -- `acknowledge` sigue en true mientras el acuse no se haya entregado: un
    -- envío fallido debe poder reintentarse, no quedar dado por hecho.
    return query select existing.appointment_id,
                        true,
                        existing.acknowledged_at is null
                          and existing.status = 'pending',
                        existing.status;
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
  if not found then
    return query select null::uuid, false, false, null::text;
    return;
  end if;

  insert into public.deposit_proof_reviews (
    appointment_id, proof_message_id, status, acknowledged_at
  ) values (candidate.id, p_message_id, 'pending', null)
  on conflict (proof_message_id) do nothing
  returning id into inserted_id;

  if inserted_id is null then
    select * into existing from public.deposit_proof_reviews
    where proof_message_id = p_message_id;
    return query select existing.appointment_id,
                        true,
                        existing.acknowledged_at is null
                          and existing.status = 'pending',
                        existing.status;
    return;
  end if;

  update public.appointments
  set deposit_proof_message_id = p_message_id,
      deposit_proof_received_at = coalesce(deposit_proof_received_at, p_received_at)
  where id = candidate.id and deposit_proof_message_id is null;

  return query select candidate.id, true, true, 'pending'::text;
end;
$$;

create or replace function public.mark_deposit_proof_acknowledged(
  p_message_id uuid
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
  update public.deposit_proof_reviews
  set acknowledged_at = clock_timestamp()
  where proof_message_id = p_message_id and acknowledged_at is null;
  return found;
end;
$$;

revoke execute on function public.mark_deposit_proof_acknowledged(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_deposit_proof_acknowledged(uuid)
  to service_role;
