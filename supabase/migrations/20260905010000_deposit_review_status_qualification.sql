-- Evita que el parámetro de salida `status` vuelva ambigua la consulta de la
-- revisión pendiente. La versión anterior sólo fallaba al ejecutar una
-- decisión ADMIN exitosa; las ramas de autorización no alcanzaban esa query.

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

  select appointment.* into current_appointment
  from public.appointments appointment
  where appointment.id = p_appointment_id
  for update;
  if not found then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select review.* into review_row
  from public.deposit_proof_reviews review
  where review.appointment_id = p_appointment_id
    and review.status = 'pending'
  order by review.created_at desc
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
    update public.deposit_proof_reviews review
    set status = p_decision,
        reviewed_at = clock_timestamp(),
        reviewed_by = auth.uid(),
        decision_reason = clean_reason
    where review.id = review_row.id
    returning review.* into review_row;
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

revoke execute on function public.admin_review_deposit_proof(uuid, text, text)
  from public, anon;
grant execute on function public.admin_review_deposit_proof(uuid, text, text)
  to authenticated, service_role;
