-- Revisión y confirmación manual de comprobantes.
--
-- La automatización sólo puede decidir sobre un comprobante cuando la sesión
-- del bot está exactamente en `waiting_deposit`. Fuera de esa ventana —OCR
-- fallido, conversación en atención humana, sesión vencida, hold expirado o
-- automatización pausada— el comprobante quedaba sin acuse y sin ninguna
-- forma de confirmarlo desde el panel: `confirm_appointment_deposit` exige
-- deposit_status = 'proof_received' y deposit_proof_late = false.
--
-- Esta migración agrega la cola de revisión humana y las decisiones ADMIN.
-- La confirmación manual es una decisión del operador y no depende de que la
-- IA haya podido leer nada.

create table public.deposit_proof_reviews (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null
    references public.appointments (id) on delete cascade,
  proof_message_id uuid not null unique
    references public.messages (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'rejected', 'more_requested')),
  acknowledged_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles (id) on delete set null,
  decision_reason text
    check (decision_reason is null or char_length(decision_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deposit_proof_reviews_resolution check (
    (status = 'pending') = (reviewed_at is null)
  )
);

create index deposit_proof_reviews_pending_idx
  on public.deposit_proof_reviews (appointment_id)
  where status = 'pending';

comment on table public.deposit_proof_reviews is
  'Cola de comprobantes que esperan decisión humana. También es el registro idempotente del acuse de recibo.';

create trigger set_deposit_proof_reviews_updated_at
  before update on public.deposit_proof_reviews
  for each row execute function public.set_updated_at();

alter table public.deposit_proof_reviews enable row level security;
revoke all on table public.deposit_proof_reviews from public, anon, authenticated;
grant all on table public.deposit_proof_reviews to service_role;
grant select on table public.deposit_proof_reviews to authenticated;

create policy deposit_proof_reviews_read on public.deposit_proof_reviews
  for select to authenticated
  using (public.current_user_is_active());

-- ---------------------------------------------------------------------------
-- Acuse de recibo idempotente
-- ---------------------------------------------------------------------------
--
-- Devuelve `acknowledge = true` una sola vez por mensaje. Un reintento del
-- worker reutiliza la fila y no vuelve a saludar al paciente.

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
    return query select existing.appointment_id, true, false, existing.status;
    return;
  end if;

  -- Mismo criterio de asociación que usa el flujo histórico: la pre-reserva
  -- viva más reciente del contacto, anterior al comprobante y todavía futura.
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
  ) values (candidate.id, p_message_id, 'pending', clock_timestamp())
  on conflict (proof_message_id) do nothing
  returning id into inserted_id;

  if inserted_id is null then
    select * into existing from public.deposit_proof_reviews
    where proof_message_id = p_message_id;
    return query select existing.appointment_id, true, false, existing.status;
    return;
  end if;

  -- Deja la evidencia enlazada para que «Revisar comprobante» tenga qué abrir.
  -- No toca `status` ni `deposit_status`: el estado del turno sigue siendo
  -- decisión del flujo authoritative o de una persona.
  update public.appointments
  set deposit_proof_message_id = p_message_id,
      deposit_proof_received_at = coalesce(deposit_proof_received_at, p_received_at)
  where id = candidate.id and deposit_proof_message_id is null;

  return query select candidate.id, true, true, 'pending'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- Confirmación manual, sin depender de ninguna decisión de IA
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

  -- A diferencia de confirm_appointment_deposit, acá alcanza con que la
  -- pre-reserva siga viva. Un OCR fallido, un hold vencido o una conversación
  -- en atención humana no invalidan la decisión de la persona ADMIN.
  if current_appointment.status <> 'scheduled' then
    raise exception 'APPOINTMENT_NOT_SCHEDULED' using errcode = 'P0001';
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

  -- Se califican las columnas: la función declara un parámetro OUT llamado
  -- `appointment_id` y sin el prefijo la referencia sería ambigua.
  update public.deposit_proof_reviews review
  set status = 'confirmed',
      reviewed_at = clock_timestamp(),
      reviewed_by = auth.uid()
  where review.appointment_id = p_appointment_id and review.status = 'pending';

  -- Cierre causal de la sesión de revisión, con el mismo criterio estrecho de
  -- confirm_appointment_deposit: nunca limpia otra conversación ni pisa una
  -- pausa explícita de operador.
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

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(), 'deposit.confirmed_manually', 'appointment', result.id,
    jsonb_build_object(
      'appointment_id', result.id,
      'confirmed_at', result.deposit_confirmed_at,
      'previous_deposit_status', current_appointment.deposit_status,
      'proof_late', current_appointment.deposit_proof_late
    )
  );

  return query select result.id, result.contact_id, result.starts_at, false;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rechazo y pedido de un comprobante nuevo
-- ---------------------------------------------------------------------------

create or replace function public.admin_review_deposit_proof(
  p_appointment_id uuid,
  p_decision text,
  p_reason text default null
)
returns table (
  review_id uuid,
  appointment_id uuid,
  contact_id uuid,
  status text,
  changed boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_appointment public.appointments%rowtype;
  review_row public.deposit_proof_reviews%rowtype;
  clean_reason text := nullif(left(trim(coalesce(p_reason, '')), 500), '');
begin
  if not public.current_user_is_admin() or auth.uid() is null then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_decision not in ('rejected', 'more_requested') then
    raise exception 'INVALID_DEPOSIT_REVIEW_DECISION' using errcode = '22023';
  end if;

  select * into current_appointment
  from public.appointments where id = p_appointment_id for update;
  if not found then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into review_row
  from public.deposit_proof_reviews
  where deposit_proof_reviews.appointment_id = p_appointment_id
    and status = 'pending'
  order by created_at desc
  limit 1
  for update;

  if not found then
    -- Un comprobante histórico enlazado al turno pero sin fila de revisión
    -- todavía puede resolverse: se crea la fila ya decidida.
    if current_appointment.deposit_proof_message_id is null then
      raise exception 'DEPOSIT_PROOF_NOT_FOUND' using errcode = 'P0002';
    end if;
    insert into public.deposit_proof_reviews as current_review (
      appointment_id, proof_message_id, status,
      reviewed_at, reviewed_by, decision_reason
    ) values (
      p_appointment_id, current_appointment.deposit_proof_message_id,
      p_decision, clock_timestamp(), auth.uid(), clean_reason
    )
    on conflict (proof_message_id) do update
    set status = excluded.status,
        reviewed_at = excluded.reviewed_at,
        reviewed_by = excluded.reviewed_by,
        decision_reason = excluded.decision_reason
    where current_review.status = 'pending'
    returning current_review.* into review_row;
    if review_row.id is null then
      -- Ya estaba resuelto por otra persona: la decisión previa se conserva.
      return query select null::uuid, p_appointment_id,
                          current_appointment.contact_id, p_decision, false;
      return;
    end if;
  else
    update public.deposit_proof_reviews
    set status = p_decision,
        reviewed_at = clock_timestamp(),
        reviewed_by = auth.uid(),
        decision_reason = clean_reason
    where id = review_row.id
    returning * into review_row;
  end if;

  -- El hold conserva sus reglas actuales: rechazar no cancela el turno ni
  -- adelanta el vencimiento. expire_booking_holds sigue siendo quien decide.
  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(),
    case when p_decision = 'rejected'
      then 'deposit.proof_rejected'
      else 'deposit.proof_more_requested' end,
    'appointment', p_appointment_id,
    jsonb_build_object('review_id', review_row.id)
  );

  return query select review_row.id, p_appointment_id,
                      current_appointment.contact_id, review_row.status, true;
end;
$$;

do $$
declare
  signature regprocedure;
begin
  for signature in
    select procedure_oid
    from (values
      ('public.admin_confirm_appointment_deposit(uuid)'::regprocedure),
      ('public.admin_review_deposit_proof(uuid,text,text)'::regprocedure)
    ) functions(procedure_oid)
  loop
    execute format('revoke execute on function %s from public, anon', signature);
    execute format('grant execute on function %s to authenticated, service_role', signature);
  end loop;
end;
$$;

revoke execute on function public.claim_deposit_proof_review(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_deposit_proof_review(uuid, uuid, timestamptz)
  to service_role;
