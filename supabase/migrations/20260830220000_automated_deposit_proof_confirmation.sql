-- Comprobantes de seña: asociación exacta, revisión o confirmación automática.
--
-- La lectura del modelo no es una autorización: esta RPC vuelve a validar en
-- PostgreSQL el mensaje, el contacto, la pre-reserva, la ventana del hold y la
-- política económica. La fila del turno y un advisory lock por profesional
-- serializan reintentos y workers concurrentes.

comment on column public.app_settings.ai_media_enabled is
  'Autoriza enviar audios, imágenes y PDF entrantes a OpenAI. Los comprobantes se extraen como datos y sólo pueden autoconfirmar la pre-reserva exacta cuando la regla SQL básica valida mensaje, hold, monto y destinatario; los demás quedan para revisión.';

alter table public.whatsapp_automation_effects
  drop constraint whatsapp_automation_effect_type_check;
alter table public.whatsapp_automation_effects
  add constraint whatsapp_automation_effect_type_check check (
    effect_type in (
      'appointment_create',
      'appointment_reschedule',
      'appointment_cancel',
      'appointment_deposit_process',
      'session_write',
      'decision',
      'profile_update',
      'handoff'
    )
  );

alter table public.appointments
  add column deposit_confirmation_actor text,
  add column deposit_confirmation_policy_version text,
  add column deposit_expected_amount_ars integer,
  add column deposit_expected_alias text,
  add column deposit_expected_holder text;

alter table public.appointments
  drop constraint appointments_deposit_confirmation_consistency_check;

alter table public.appointments
  add constraint appointments_deposit_confirmation_consistency_check check (
    (
      deposit_confirmed_at is null
      and deposit_confirmed_by is null
      and deposit_confirmation_actor is null
      and deposit_confirmation_policy_version is null
    )
    or (
      deposit_confirmed_at is not null
      and (
        (
          deposit_confirmed_by is not null
          and deposit_confirmation_actor is null
          and deposit_confirmation_policy_version is null
        )
        or (
          deposit_confirmed_by is null
          and deposit_confirmation_actor = 'automatic_system'
          and deposit_confirmation_policy_version is not null
        )
      )
    )
  ),
  add constraint appointments_deposit_confirmation_actor_check check (
    deposit_confirmation_actor is null
    or deposit_confirmation_actor = 'automatic_system'
  ),
  add constraint appointments_deposit_confirmation_policy_check check (
    deposit_confirmation_policy_version is null
    or deposit_confirmation_policy_version ~ '^[a-z0-9][a-z0-9._/-]{2,99}$'
  );

comment on column public.appointments.deposit_confirmation_actor is
  'Actor técnico explícito. NULL conserva confirmaciones humanas históricas; automatic_system nunca suplanta auth.uid().';
comment on column public.appointments.deposit_confirmation_policy_version is
  'Versión inmutable de la política SQL que autorizó una confirmación automática.';
comment on column public.appointments.deposit_proof_message_id is
  'Mensaje de evidencia asociado. Su lectura básica puede confirmar automáticamente sólo bajo la policy SQL auditada; no representa conciliación bancaria.';

-- Para holds históricos éste es el mejor dato disponible. Desde esta
-- migración cada nueva pre-reserva lo captura antes de que cambie settings;
-- reprogramar el horario no sustituye los datos ya informados al paciente.
update public.appointments appointment
set deposit_expected_amount_ars = settings.deposit_amount_ars,
    deposit_expected_alias = settings.deposit_alias,
    deposit_expected_holder = settings.deposit_holder
from public.app_settings settings
where settings.id = true
  and appointment.hold_expires_at is not null
  and appointment.deposit_status <> 'not_required'
  and (
    appointment.deposit_expected_amount_ars is null
    or appointment.deposit_expected_alias is null
    or appointment.deposit_expected_holder is null
  );

alter table public.appointments
  add constraint appointments_deposit_expected_snapshot_check check (
    (
      deposit_expected_amount_ars is null
      and deposit_expected_alias is null
      and deposit_expected_holder is null
    )
    or (
      deposit_expected_amount_ars between 1 and 100000000
      and char_length(trim(deposit_expected_alias)) between 3 and 120
      and char_length(trim(deposit_expected_holder)) between 3 and 160
    )
  ),
  add constraint appointments_hold_expected_snapshot_check check (
    hold_expires_at is null
    or deposit_status = 'not_required'
    or (
      deposit_expected_amount_ars is not null
      and deposit_expected_alias is not null
      and deposit_expected_holder is not null
    )
  );

comment on column public.appointments.deposit_expected_amount_ars is
  'Monto de seña informado al crear o renovar esta pre-reserva.';
comment on column public.appointments.deposit_expected_alias is
  'Alias informado al crear o renovar esta pre-reserva.';
comment on column public.appointments.deposit_expected_holder is
  'Titular informado al crear o renovar esta pre-reserva.';

create or replace function public.snapshot_appointment_expected_deposit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  settings_row public.app_settings%rowtype;
  refresh_snapshot boolean := false;
  snapshot_changed boolean := false;
begin
  if tg_op = 'INSERT' then
    if new.hold_expires_at is null
      or new.deposit_status = 'not_required'
    then
      return new;
    end if;
    refresh_snapshot := true;
  else
    snapshot_changed :=
      new.deposit_expected_amount_ars is distinct from
        old.deposit_expected_amount_ars
      or new.deposit_expected_alias is distinct from
        old.deposit_expected_alias
      or new.deposit_expected_holder is distinct from
        old.deposit_expected_holder;
    -- Un update sólo completa un snapshot inexistente (por ejemplo, al pasar
    -- un turno legado a pre-reserva). Cambiar fecha o renovar el plazo conserva
    -- exactamente monto, alias y titular que el paciente ya recibió.
    refresh_snapshot :=
      new.hold_expires_at is not null
      and new.deposit_status <> 'not_required'
      and (
        old.deposit_expected_amount_ars is null
        or old.deposit_expected_alias is null
        or old.deposit_expected_holder is null
      );
    if snapshot_changed and not refresh_snapshot then
      raise exception 'APPOINTMENT_DEPOSIT_EXPECTATION_IMMUTABLE'
        using errcode = '23514';
    end if;
    if new.hold_expires_at is null
      or new.deposit_status = 'not_required'
    then
      return new;
    end if;
  end if;
  if not refresh_snapshot then
    return new;
  end if;

  select settings.* into settings_row
  from public.app_settings settings
  where settings.id = true;
  if not found then
    raise exception 'APP_SETTINGS_NOT_FOUND' using errcode = 'P0002';
  end if;

  new.deposit_expected_amount_ars := settings_row.deposit_amount_ars;
  new.deposit_expected_alias := settings_row.deposit_alias;
  new.deposit_expected_holder := settings_row.deposit_holder;
  return new;
end;
$$;

create trigger aa_appointments_snapshot_expected_deposit
  before insert or update of starts_at, hold_expires_at, deposit_status,
    deposit_expected_amount_ars, deposit_expected_alias,
    deposit_expected_holder
  on public.appointments
  for each row execute function public.snapshot_appointment_expected_deposit();

revoke execute on function public.snapshot_appointment_expected_deposit()
  from public, anon, authenticated, service_role;

-- Un archivo puede llegar antes de vencer la espera y recién ser reclamado
-- después (cola, descarga o backpressure). Conserva waiting_deposit sólo para
-- ese medio puntual, con turno/contacto/cuenta válidos; cualquier texto o
-- archivo tardío continúa iniciando una sesión fresca normal.
alter function public.claim_whatsapp_automation_execution(uuid, jsonb, integer)
  rename to claim_whatsapp_automation_execution_before_timely_deposit;

create or replace function public.claim_whatsapp_automation_execution(
  p_message_id uuid,
  p_request_snapshot jsonb,
  p_stale_after_seconds integer default 900
)
returns table (
  disposition text,
  lease_token uuid,
  attempts integer,
  snapshot_at timestamptz,
  message_snapshot jsonb,
  conversation_snapshot jsonb,
  contact_snapshot jsonb,
  settings_snapshot jsonb,
  session_state text,
  session_context jsonb,
  session_expires_at timestamptz,
  fresh_session boolean,
  outcome jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim_now timestamptz := clock_timestamp();
  original_expires_at timestamptz;
  target_conversation_id uuid;
  preserve_waiting_deposit boolean := false;
  claimed record;
begin
  perform public.assert_whatsapp_automation_service_role();
  perform pg_advisory_xact_lock(hashtextextended(p_message_id::text, 0));

  if not exists (
    select 1 from public.whatsapp_automation_executions execution
    where execution.message_id = p_message_id
  ) then
    select session.expires_at, conversation.id
      into original_expires_at, target_conversation_id
    from public.messages message
    join public.conversations conversation
      on conversation.id = message.conversation_id
     and conversation.contact_id = message.contact_id
    join public.automation_sessions session
      on session.conversation_id = conversation.id
    join public.appointments appointment
      on appointment.id::text = session.context ->> 'appointmentId'
     and appointment.contact_id = message.contact_id
    where message.id = p_message_id
      and message.direction = 'inbound'
      and message.type in ('image', 'document')
      and message.revoked_at is null
      and message.coexistence_account_id is not distinct from
        conversation.coexistence_account_id
      and session.state = 'waiting_deposit'
      and session.expires_at is not null
      and session.expires_at < claim_now
      and message.created_at >= appointment.created_at
      and message.created_at <= session.expires_at
      and (
        (
          appointment.status = 'scheduled'
          and appointment.deposit_status = 'pending'
        )
        or (
          appointment.status = 'cancelled'
          and appointment.deposit_status = 'expired'
        )
      )
      and appointment.deposit_proof_message_id is null
      and appointment.hold_expires_at is not null
      and message.created_at <= appointment.hold_expires_at
    for update of session;
    preserve_waiting_deposit := found;
  end if;

  if preserve_waiting_deposit then
    update public.automation_sessions session
    set expires_at = claim_now + interval '1 minute'
    where session.conversation_id = target_conversation_id;
  end if;

  select * into claimed
  from public.claim_whatsapp_automation_execution_before_timely_deposit(
    p_message_id,
    p_request_snapshot,
    p_stale_after_seconds
  );

  if preserve_waiting_deposit then
    update public.automation_sessions session
    set expires_at = original_expires_at
    where session.conversation_id = target_conversation_id;

    if claimed.disposition = 'claimed' then
      update public.whatsapp_automation_executions execution
      set session_expires_at = original_expires_at,
          fresh_session = false
      where execution.message_id = p_message_id
        and execution.status = 'processing';
      claimed.session_expires_at := original_expires_at;
      claimed.fresh_session := false;
    end if;
  end if;

  return query select
    claimed.disposition::text,
    claimed.lease_token::uuid,
    claimed.attempts::integer,
    claimed.snapshot_at::timestamptz,
    claimed.message_snapshot::jsonb,
    claimed.conversation_snapshot::jsonb,
    claimed.contact_snapshot::jsonb,
    claimed.settings_snapshot::jsonb,
    claimed.session_state::text,
    claimed.session_context::jsonb,
    claimed.session_expires_at::timestamptz,
    claimed.fresh_session::boolean,
    claimed.outcome::jsonb;
end;
$$;

revoke execute on function public.claim_whatsapp_automation_execution(
  uuid, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.claim_whatsapp_automation_execution(
  uuid, jsonb, integer
) to service_role;
revoke execute on function
  public.claim_whatsapp_automation_execution_before_timely_deposit(
    uuid, jsonb, integer
  ) from public, anon, authenticated, service_role;

-- Trabajo causal previo o posterior al claim. El dispatch se crea junto al
-- inbound, por lo que cubre la ventana antes de execution; el lease cubre
-- fixtures/recuperaciones sin dispatch. Sólo protege el turno exacto y sólo
-- mientras alguno de los dos caminos sigue siendo actionable.
create or replace function public.appointment_has_timely_deposit_proof_work(
  p_appointment_id uuid,
  p_now timestamptz default clock_timestamp()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.appointments appointment
    join public.conversations conversation
      on conversation.contact_id = appointment.contact_id
     and conversation.status = 'open'
    join public.automation_sessions session
      on session.conversation_id = conversation.id
     and session.state = 'waiting_deposit'
     and session.context ->> 'appointmentId' = appointment.id::text
     and session.expires_at is not null
    join public.messages message
      on message.conversation_id = conversation.id
     and message.contact_id = appointment.contact_id
     and message.direction = 'inbound'
     and message.type in ('image', 'document')
     and message.revoked_at is null
     and message.coexistence_account_id is not distinct from
       conversation.coexistence_account_id
     and message.created_at >= appointment.created_at
     and message.created_at <= session.expires_at
     and message.created_at <= appointment.hold_expires_at
    where appointment.id = p_appointment_id
      and appointment.hold_expires_at is not null
      and (
        appointment.deposit_proof_message_id is null
        or appointment.deposit_proof_message_id = message.id
      )
      and (
        exists (
          select 1
          from public.whatsapp_automation_dispatches dispatch
          where dispatch.message_id = message.id
            and dispatch.status in ('reserved', 'pending', 'processing')
        )
        or exists (
          select 1
          from public.whatsapp_automation_executions execution
          where execution.message_id = message.id
            and execution.conversation_id = conversation.id
            and execution.contact_id = appointment.contact_id
            and execution.status = 'processing'
            and execution.lease_expires_at > p_now
            and execution.session_state = 'waiting_deposit'
            and execution.session_context ->> 'appointmentId' =
              appointment.id::text
            and not execution.fresh_session
            and execution.message_snapshot ->> 'type' = message.type::text
            and nullif(
              execution.message_snapshot ->> 'coexistence_account_id',
              ''
            ) is not distinct from message.coexistence_account_id::text
            and nullif(
              execution.conversation_snapshot ->> 'coexistence_account_id',
              ''
            ) is not distinct from
              conversation.coexistence_account_id::text
        )
      )
  );
$$;

revoke execute on function public.appointment_has_timely_deposit_proof_work(
  uuid, timestamptz
) from public, anon, authenticated, service_role;

-- El cron no vence ni encola aviso mientras el inbound puntual conserva un
-- dispatch actionable o una ejecución causal con lease vigente. Al quedar
-- ambos terminales, el siguiente ciclo recupera el vencimiento normal.
create or replace function public.expire_booking_holds(
  p_now timestamptz default clock_timestamp()
)
returns table (appointment_id uuid, contact_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
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
    and not public.appointment_has_timely_deposit_proof_work(
      appointment.id,
      p_now
    )
  returning appointment.id, appointment.contact_id;
end;
$$;

revoke execute on function public.expire_booking_holds(timestamptz)
  from public, anon, authenticated;
grant execute on function public.expire_booking_holds(timestamptz)
  to service_role;

create or replace function public.claim_expired_booking_hold_notifications(
  p_limit integer default 25
)
returns table (appointment_id uuid, contact_id uuid, attempts integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim_now timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  perform public.expire_booking_holds(claim_now);

  update public.appointments appointment
  set hold_expired_notification_status = 'pending',
      hold_expired_notification_claimed_at = null,
      hold_expired_notification_error = 'STALE_CLAIM_RECOVERED'
  where appointment.hold_expired_notification_status = 'processing'
    and (
      appointment.hold_expired_notification_claimed_at is null
      or appointment.hold_expired_notification_claimed_at <
        claim_now - interval '15 minutes'
    );

  return query
  with due as (
    select appointment.id
    from public.appointments appointment
    where appointment.deposit_status = 'expired'
      and appointment.status = 'cancelled'
      and appointment.hold_expired_notification_status = 'pending'
      and appointment.deposit_proof_late = false
      and not public.appointment_has_timely_deposit_proof_work(
        appointment.id,
        claim_now
      )
    order by appointment.hold_expires_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.appointments appointment
  set hold_expired_notification_status = 'processing',
      hold_expired_notification_attempts =
        appointment.hold_expired_notification_attempts + 1,
      hold_expired_notification_claimed_at = claim_now
  from due
  where appointment.id = due.id
  returning appointment.id, appointment.contact_id,
    appointment.hold_expired_notification_attempts;
end;
$$;

revoke execute on function public.claim_expired_booking_hold_notifications(
  integer
) from public, anon, authenticated;
grant execute on function public.claim_expired_booking_hold_notifications(
  integer
) to service_role;

-- Resolver manualmente una revisión (confirmar o cancelar) también resuelve
-- su sesión durable. El marcador impide que esa acción pise una ejecución
-- posterior de la misma conversación.
create or replace function public.resolve_deposit_review_session()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  proof_message public.messages%rowtype;
  session_resolved boolean := false;
begin
  if old.deposit_status <> 'proof_received'
    or new.deposit_proof_message_id is null
    or (
      new.deposit_status = 'confirmed'
      and new.deposit_confirmation_actor = 'automatic_system'
    )
    or not (
      new.deposit_status = 'confirmed'
      or new.status = 'cancelled'
    )
  then
    return new;
  end if;

  select message.* into proof_message
  from public.messages message
  where message.id = new.deposit_proof_message_id
    and message.contact_id = new.contact_id;
  if not found then
    return new;
  end if;

  -- Sólo resuelve el handoff que todavía pertenece a este proof. Un operador,
  -- una app o un inbound posterior mantienen la atención manual y su sesión.
  perform 1
    from public.conversations conversation
    where conversation.id = proof_message.conversation_id
      and conversation.contact_id = new.contact_id
      and conversation.status = 'open'
      and conversation.automation_mode = 'manual'
      and conversation.automation_pause_source = 'inbound_handoff'
      and conversation.automation_pause_message_id = proof_message.id
      and conversation.current_flow = 'deposit_proof_received'
    for update;
  if not found then
    return new;
  end if;

  if exists (
    select 1
    from public.messages later_message
    where later_message.conversation_id = proof_message.conversation_id
      and later_message.direction = 'inbound'
      and later_message.whatsapp_ingest_sequence >
        proof_message.whatsapp_ingest_sequence
  ) then
    return new;
  end if;

  insert into public.automation_sessions (
    conversation_id, state, context, expires_at,
    last_automation_message_id, last_automation_ingest_sequence,
    last_automation_session_sequence
  ) values (
    proof_message.conversation_id, 'idle', '{}'::jsonb, null,
    proof_message.id, proof_message.whatsapp_ingest_sequence, 100
  )
  on conflict (conversation_id) do update
  set state = 'idle',
      context = '{}'::jsonb,
      expires_at = null,
      last_automation_message_id = excluded.last_automation_message_id,
      last_automation_ingest_sequence =
        excluded.last_automation_ingest_sequence,
      last_automation_session_sequence =
        excluded.last_automation_session_sequence
  where (
      automation_sessions.last_automation_ingest_sequence is null
      or automation_sessions.last_automation_ingest_sequence <=
        excluded.last_automation_ingest_sequence
    )
    and automation_sessions.state in ('waiting_deposit', 'human_handoff')
    and automation_sessions.context ->> 'appointmentId' = new.id::text
  returning true into session_resolved;

  if session_resolved then
    update public.conversations conversation
    set needs_human = false,
        current_flow = null
    where conversation.id = proof_message.conversation_id
      and conversation.contact_id = new.contact_id
      and conversation.status = 'open'
      and conversation.automation_mode = 'manual'
      and conversation.automation_pause_source = 'inbound_handoff'
      and conversation.automation_pause_message_id = proof_message.id
      and conversation.current_flow = 'deposit_proof_received';
  end if;

  return new;
end;
$$;

create trigger appointments_resolve_deposit_review_session
  after update of status, deposit_status on public.appointments
  for each row execute function public.resolve_deposit_review_session();

revoke execute on function public.resolve_deposit_review_session()
  from public, anon, authenticated, service_role;

-- La función histórica limpiaba todas las conversaciones abiertas del
-- contacto. La resolución moderna vive en el trigger anterior; este RPC sólo
-- conserva además un fallback exacto para record_deposit_proof histórico.
create or replace function public.confirm_appointment_deposit(
  p_appointment_id uuid
)
returns public.appointments
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  appointment_professional_id uuid;
  current_appointment public.appointments%rowtype;
  result public.appointments;
begin
  if not public.current_user_is_active() or auth.uid() is null then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
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
  if current_appointment.status <> 'scheduled'
    or current_appointment.deposit_status <> 'proof_received'
    or current_appointment.deposit_proof_message_id is null
    or current_appointment.deposit_proof_late
  then
    raise exception 'DEPOSIT_REVIEW_REQUIRED_OR_HOLD_EXPIRED'
      using errcode = 'P0001';
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

  -- Compatibilidad causal con record_deposit_proof histórico, que marcaba la
  -- conversación como `system` y no creaba automation_session. Nunca limpia
  -- otra conversación, una pausa de operador ni una atención con inbound B.
  update public.conversations conversation
  set needs_human = false,
      current_flow = null
  from public.messages proof_message
  where proof_message.id = result.deposit_proof_message_id
    and proof_message.contact_id = result.contact_id
    and conversation.id = proof_message.conversation_id
    and conversation.contact_id = result.contact_id
    and conversation.status = 'open'
    and conversation.automation_mode = 'manual'
    and conversation.current_flow = 'deposit_proof_received'
    and (
      (
        conversation.automation_pause_source = 'inbound_handoff'
        and conversation.automation_pause_message_id = proof_message.id
      )
      or (
        conversation.automation_pause_source = 'system'
        and conversation.automation_pause_message_id is null
      )
    )
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
    auth.uid(), 'deposit.confirmed', 'appointment', result.id,
    jsonb_build_object(
      'appointment_id', result.id,
      'confirmed_at', result.deposit_confirmed_at
    )
  );
  return result;
end;
$$;

create table public.automated_deposit_proof_results (
  appointment_id uuid primary key
    references public.appointments (id) on delete restrict,
  proof_message_id uuid not null unique
    references public.messages (id) on delete restrict,
  media_sha256 text,
  policy_version text not null,
  auto_approve boolean not null,
  reading jsonb not null,
  status text not null,
  result jsonb not null,
  actor text not null default 'automatic_system',
  processed_at timestamptz not null default clock_timestamp(),
  constraint automated_deposit_proof_media_sha256_check check (
    media_sha256 is null or media_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint automated_deposit_proof_policy_check check (
    policy_version ~ '^[a-z0-9][a-z0-9._/-]{2,99}$'
  ),
  constraint automated_deposit_proof_reading_check check (
    jsonb_typeof(reading) = 'object'
    and octet_length(reading::text) <= 32768
  ),
  constraint automated_deposit_proof_status_check check (
    status in ('confirmed', 'review', 'late', 'already_confirmed')
  ),
  constraint automated_deposit_proof_result_check check (
    jsonb_typeof(result) = 'object'
    and result ->> 'status' = status
  ),
  constraint automated_deposit_proof_actor_check check (
    actor = 'automatic_system'
  )
);

comment on table public.automated_deposit_proof_results is
  'Ledger append-only e idempotente de la lectura, evidencia y resultado de cada comprobante procesado automáticamente.';
comment on column public.automated_deposit_proof_results.media_sha256 is
  'Hash de evidencia cuando la descarga fue posible; NULL documenta un handoff previo o fallido sin inventar bytes.';

alter table public.automated_deposit_proof_results enable row level security;

revoke all on public.automated_deposit_proof_results
  from public, anon, authenticated, service_role;
grant select on public.automated_deposit_proof_results to service_role;

-- La misma normalización conservadora se usa para alias y titular. Se revoca
-- su ejecución directa porque sólo es una pieza interna de la política.
create or replace function public.normalize_automated_deposit_proof_text(
  p_value text
)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select trim(regexp_replace(
    lower(translate(
      coalesce(p_value, ''),
      'áéíóúüñÁÉÍÓÚÜÑ',
      'aeiouunAEIOUUN'
    )),
    '[^a-z0-9]+',
    ' ',
    'g'
  ));
$$;

revoke execute on function public.normalize_automated_deposit_proof_text(text)
  from public, anon, authenticated, service_role;

-- El claim construye el snapshot a través de este BEFORE INSERT. Se agrega el
-- tipo de mensaje que el worker necesita para decidir si debe descargar media;
-- la cuenta de Coexistence sigue incluida para enrutar esa descarga.
create or replace function public.stamp_whatsapp_automation_account_snapshots()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  message_account_id uuid;
  message_type_value public.message_type;
  conversation_account_id uuid;
begin
  select message.coexistence_account_id, message.type
    into message_account_id, message_type_value
  from public.messages message
  where message.id = new.message_id
    and message.conversation_id = new.conversation_id;
  if not found then
    raise exception 'WHATSAPP_AUTOMATION_SNAPSHOT_MESSAGE_INVALID'
      using errcode = '23503';
  end if;

  select conversation.coexistence_account_id into conversation_account_id
  from public.conversations conversation
  where conversation.id = new.conversation_id;
  if not found or message_account_id is distinct from conversation_account_id
  then
    raise exception 'WHATSAPP_AUTOMATION_SNAPSHOT_ACCOUNT_MISMATCH'
      using errcode = '23514';
  end if;

  new.message_snapshot := coalesce(new.message_snapshot, '{}'::jsonb)
    || jsonb_build_object(
      'type', message_type_value,
      'coexistence_account_id', message_account_id
    );
  new.conversation_snapshot := coalesce(
    new.conversation_snapshot,
    '{}'::jsonb
  ) || jsonb_build_object(
    'coexistence_account_id', conversation_account_id
  );
  return new;
end;
$$;

-- Sólo se completan snapshots que todavía pueden ser reclamados nuevamente.
-- Una ejecución completed es evidencia inmutable de una decisión ya cerrada.
update public.whatsapp_automation_executions execution
set message_snapshot = execution.message_snapshot || jsonb_build_object(
      'type', message.type,
      'coexistence_account_id', message.coexistence_account_id
    ),
    conversation_snapshot = execution.conversation_snapshot
      || jsonb_build_object(
        'coexistence_account_id', conversation.coexistence_account_id
      )
from public.messages message
join public.conversations conversation
  on conversation.id = message.conversation_id
where execution.message_id = message.id
  and execution.conversation_id = conversation.id
  and execution.status <> 'completed'
  and (
    not execution.message_snapshot ? 'type'
    or not execution.message_snapshot ? 'coexistence_account_id'
    or not execution.conversation_snapshot ? 'coexistence_account_id'
  );

-- La confirmación de seña es un efecto de dominio igual que crear, mover o
-- cancelar un turno. Puede escribirse durante el handoff causal del mismo
-- inbound, pero nunca atraviesa una pausa de Gisela, la app u otro mensaje.
create or replace function public.guard_whatsapp_automation_effect_manual_pause()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  conversation_row public.conversations%rowtype;
begin
  select execution.* into execution_row
  from public.whatsapp_automation_executions execution
  where execution.message_id = new.execution_message_id;
  if not found then
    raise exception 'WHATSAPP_AUTOMATION_EXECUTION_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select conversation.* into conversation_row
  from public.conversations conversation
  where conversation.id = execution_row.conversation_id
  for update;
  if not found then
    raise exception 'WHATSAPP_AUTOMATION_CONVERSATION_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if execution_row.message_ingest_sequence <=
    conversation_row.automation_human_barrier_ingest_sequence
  then
    raise exception 'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_HUMAN_REPLY'
      using errcode = '55000';
  end if;

  if conversation_row.automation_mode = 'manual'
    and not (
      conversation_row.automation_pause_source = 'inbound_handoff'
      and conversation_row.automation_pause_message_id =
        new.execution_message_id
      and new.effect_type in (
        'session_write',
        'handoff',
        'appointment_deposit_process'
      )
    ) then
    raise exception 'WHATSAPP_AUTOMATION_EFFECT_BLOCKED_MANUAL'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

-- Registra el efecto sólo dentro de la misma ejecución durable y vuelve a
-- validar su lease: un worker viejo no puede adjuntar un commit a otro intento.
create or replace function public.record_automated_deposit_process_effect(
  p_message_id uuid,
  p_lease_token uuid,
  p_appointment_id uuid,
  p_media_sha256 text,
  p_policy_version text,
  p_result jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  existing_effect public.whatsapp_automation_effects%rowtype;
  request_value jsonb;
  effect_result jsonb;
begin
  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );

  if not exists (
    select 1
    from public.messages message
    join public.appointments appointment
      on appointment.id = p_appointment_id
    where message.id = p_message_id
      and message.conversation_id = execution_row.conversation_id
      and message.contact_id = execution_row.contact_id
      and appointment.contact_id = execution_row.contact_id
  ) then
    raise exception 'WHATSAPP_AUTOMATION_DEPOSIT_EFFECT_CONTEXT_MISMATCH'
      using errcode = '23514';
  end if;

  request_value := jsonb_build_object(
    'appointment_id', p_appointment_id,
    'proof_message_id', p_message_id,
    'media_sha256', p_media_sha256,
    'policy_version', p_policy_version
  );
  effect_result := p_result || jsonb_build_object('effect_status', 'applied');

  select effect.* into existing_effect
  from public.whatsapp_automation_effects effect
  where effect.execution_message_id = p_message_id
    and effect.effect_key = 'appointment:deposit_process';
  if found then
    if existing_effect.effect_type <> 'appointment_deposit_process'
      or existing_effect.appointment_id is distinct from p_appointment_id
      or existing_effect.request is distinct from request_value
      or existing_effect.result is distinct from effect_result
    then
      raise exception 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT'
        using errcode = '23514';
    end if;
    return true;
  end if;

  insert into public.whatsapp_automation_effects (
    execution_message_id, effect_key, effect_type, request, result,
    appointment_id
  ) values (
    p_message_id, 'appointment:deposit_process',
    'appointment_deposit_process', request_value, effect_result,
    p_appointment_id
  );
  return true;
end;
$$;

revoke execute on function public.record_automated_deposit_process_effect(
  uuid, uuid, uuid, text, text, jsonb
) from public, anon, authenticated, service_role;

-- Conserva la implementación exhaustiva de lifecycle y antepone el único
-- efecto nuevo que puede requerir recuperación: una confirmación ya aplicada.
-- Review/late no son commits notificables y por eso no entran en esta rama.
alter function public.block_whatsapp_account_graph_work(uuid, text)
  rename to block_whatsapp_account_graph_work_before_automated_deposit;

create or replace function public.block_whatsapp_account_graph_work(
  p_account_id uuid,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  clean_reason text := upper(trim(coalesce(p_reason, '')));
  committed record;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if clean_reason !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'WHATSAPP_GRAPH_WORK_BLOCK_REASON_INVALID'
      using errcode = '22023';
  end if;

  for committed in
    select
      execution.message_id,
      execution.conversation_id,
      execution.message_ingest_sequence,
      effect.appointment_id
    from public.whatsapp_automation_executions execution
    join public.messages message on message.id = execution.message_id
    join public.conversations conversation
      on conversation.id = execution.conversation_id
    join public.whatsapp_automation_effects effect
      on effect.execution_message_id = execution.message_id
     and effect.effect_type = 'appointment_deposit_process'
     and effect.appointment_id is not null
     and effect.result ->> 'effect_status' = 'applied'
     and effect.result ->> 'status' = 'confirmed'
    where (
        message.coexistence_account_id = p_account_id
        or conversation.coexistence_account_id = p_account_id
      )
      and execution.status in ('processing', 'failed')
    order by execution.message_id
    for update of execution
  loop
    update public.conversations conversation
    set automation_mode = 'manual',
        needs_human = true,
        automation_pause_source = 'inbound_handoff',
        automation_pause_message_id = committed.message_id
    where conversation.id = committed.conversation_id
      and conversation.coexistence_account_id = p_account_id;

    insert into public.automation_sessions (
      conversation_id, state, context, expires_at,
      last_automation_message_id, last_automation_ingest_sequence,
      last_automation_session_sequence
    ) values (
      committed.conversation_id,
      'human_handoff',
      jsonb_build_object(
        'appointmentId', committed.appointment_id,
        'reason', 'ACCOUNT_BLOCKED_AFTER_COMMITTED_EFFECT',
        'blockReason', clean_reason
      ),
      clock_timestamp() + interval '30 days',
      committed.message_id,
      committed.message_ingest_sequence,
      100
    )
    on conflict (conversation_id) do update
    set state = 'human_handoff',
        context = excluded.context,
        expires_at = excluded.expires_at,
        last_automation_message_id = excluded.last_automation_message_id,
        last_automation_ingest_sequence =
          excluded.last_automation_ingest_sequence,
        last_automation_session_sequence =
          excluded.last_automation_session_sequence
    where automation_sessions.last_automation_ingest_sequence is null
      or automation_sessions.last_automation_ingest_sequence <=
        excluded.last_automation_ingest_sequence;

    insert into public.whatsapp_automation_effects (
      execution_message_id, effect_key, effect_type, request, result,
      appointment_id
    ) values (
      committed.message_id,
      'terminal:handoff',
      'handoff',
      jsonb_build_object(
        'appointment_id', committed.appointment_id,
        'reason', 'ACCOUNT_BLOCKED_AFTER_COMMITTED_EFFECT'
      ),
      jsonb_build_object(
        'processed', true,
        'state', 'human_handoff',
        'reason', 'ACCOUNT_BLOCKED_AFTER_COMMITTED_EFFECT',
        'blockReason', clean_reason,
        'appointmentId', committed.appointment_id
      ),
      committed.appointment_id
    ) on conflict (execution_message_id, effect_key) do nothing;
  end loop;

  return public.block_whatsapp_account_graph_work_before_automated_deposit(
    p_account_id,
    clean_reason
  );
end;
$$;

revoke execute on function public.block_whatsapp_account_graph_work(uuid, text)
  from public, anon, authenticated, service_role;
revoke execute on function
  public.block_whatsapp_account_graph_work_before_automated_deposit(uuid, text)
  from public, anon, authenticated, service_role;

-- Si el envío posterior a cualquier efecto de turno falla, el handoff puede
-- recuperar también una confirmación de seña. Al pasar auto -> manual reclama
-- causalmente este inbound; una pausa ajena preexistente se conserva y el
-- guard anterior bloquea el efecto, haciendo rollback de todo el handoff.
create or replace function public.handoff_whatsapp_automation_execution(
  p_message_id uuid,
  p_lease_token uuid,
  p_reason text,
  p_appointment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  existing_effect public.whatsapp_automation_effects%rowtype;
  request_value jsonb;
  outcome_value jsonb;
begin
  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );
  if char_length(trim(coalesce(p_reason, ''))) not between 1 and 200
    or p_appointment_id is null then
    raise exception 'WHATSAPP_AUTOMATION_HANDOFF_INVALID'
      using errcode = '22023';
  end if;

  request_value := jsonb_build_object(
    'appointment_id', p_appointment_id,
    'reason', left(trim(p_reason), 200)
  );

  select effect.* into existing_effect
  from public.whatsapp_automation_effects effect
  where effect.execution_message_id = p_message_id
    and effect.effect_key = 'terminal:handoff';
  if found then
    if existing_effect.request is distinct from request_value then
      raise exception 'WHATSAPP_AUTOMATION_EFFECT_CONFLICT'
        using errcode = '23514';
    end if;
    return existing_effect.result;
  end if;

  if not exists (
    select 1
    from public.whatsapp_automation_effects domain_effect
    where domain_effect.execution_message_id = p_message_id
      and domain_effect.appointment_id = p_appointment_id
      and (
        (
          domain_effect.effect_type in (
            'appointment_create',
            'appointment_reschedule',
            'appointment_cancel'
          )
          and coalesce(domain_effect.result ->> 'effect_status', '') <>
            'rejected'
        )
        or (
          domain_effect.effect_type = 'appointment_deposit_process'
          and domain_effect.result ->> 'effect_status' = 'applied'
          and domain_effect.result ->> 'status' = 'confirmed'
        )
      )
  ) then
    raise exception 'WHATSAPP_AUTOMATION_COMMITTED_EFFECT_NOT_FOUND'
      using errcode = '55000';
  end if;

  update public.conversations conversation
  set automation_mode = 'manual',
      needs_human = true,
      automation_pause_source = case
        when conversation.automation_mode = 'auto'
          then 'inbound_handoff'::public.automation_pause_source
        else conversation.automation_pause_source
      end,
      automation_pause_message_id = case
        when conversation.automation_mode = 'auto' then p_message_id
        else conversation.automation_pause_message_id
      end
  where conversation.id = execution_row.conversation_id;
  if not found then
    raise exception 'CONVERSATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.automation_sessions (
    conversation_id,
    state,
    context,
    expires_at,
    last_automation_message_id,
    last_automation_ingest_sequence,
    last_automation_session_sequence
  ) values (
    execution_row.conversation_id,
    'human_handoff',
    jsonb_build_object(
      'appointmentId', p_appointment_id,
      'reason', left(trim(p_reason), 200)
    ),
    clock_timestamp() + interval '30 days',
    p_message_id,
    execution_row.message_ingest_sequence,
    100
  )
  on conflict (conversation_id) do update
  set state = 'human_handoff',
      context = jsonb_build_object(
        'appointmentId', p_appointment_id,
        'reason', left(trim(p_reason), 200)
      ),
      expires_at = excluded.expires_at,
      last_automation_message_id = excluded.last_automation_message_id,
      last_automation_ingest_sequence =
        excluded.last_automation_ingest_sequence,
      last_automation_session_sequence =
        excluded.last_automation_session_sequence
  where automation_sessions.last_automation_ingest_sequence is null
    or automation_sessions.last_automation_ingest_sequence <=
      excluded.last_automation_ingest_sequence;

  outcome_value := jsonb_build_object(
    'processed', true,
    'state', 'human_handoff',
    'reason', left(trim(p_reason), 200),
    'appointmentId', p_appointment_id
  );
  insert into public.whatsapp_automation_effects (
    execution_message_id,
    effect_key,
    effect_type,
    request,
    result,
    appointment_id
  ) values (
    p_message_id,
    'terminal:handoff',
    'handoff',
    request_value,
    outcome_value,
    p_appointment_id
  );
  return outcome_value;
end;
$$;

create or replace function public.process_automated_deposit_proof(
  p_message_id uuid,
  p_lease_token uuid,
  p_appointment_id uuid,
  p_reading jsonb,
  p_media_sha256 text,
  p_policy_version text,
  p_auto_approve boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  supported_policy constant text := 'deposit-proof-basic/v1';
  clean_media_sha256 text := lower(trim(coalesce(p_media_sha256, '')));
  clean_policy_version text := trim(coalesce(p_policy_version, ''));
  processed_now timestamptz := clock_timestamp();
  appointment_professional_id uuid;
  execution_row public.whatsapp_automation_executions%rowtype;
  appointment_row public.appointments%rowtype;
  message_row public.messages%rowtype;
  conversation_row public.conversations%rowtype;
  existing_result public.automated_deposit_proof_results%rowtype;
  review_reasons text[] := array[]::text[];
  result_status text;
  result_value jsonb;
  reading_amount numeric;
  reading_destination text;
  reading_holder text;
  expected_alias text;
  expected_holder text;
  expected_holder_first_token text;
  expected_holder_last_token text;
  effective_received_at timestamptz;
  recipient_matches boolean := false;
  conversation_resumed boolean := false;
  automation_can_idle boolean := false;
  session_reset boolean := false;
  request_matches boolean := false;
begin
  perform public.assert_whatsapp_automation_service_role();

  if p_message_id is null
    or p_appointment_id is null
    or p_auto_approve is null
    or jsonb_typeof(coalesce(p_reading, 'null'::jsonb)) <> 'object'
    or octet_length(coalesce(p_reading, '{}'::jsonb)::text) > 32768
    or clean_media_sha256 !~ '^[0-9a-f]{64}$'
  then
    raise exception 'AUTOMATED_DEPOSIT_PROOF_INVALID'
      using errcode = '22023';
  end if;
  if clean_policy_version <> supported_policy then
    raise exception 'AUTOMATED_DEPOSIT_PROOF_POLICY_UNSUPPORTED'
      using errcode = '22023';
  end if;

  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );

  select appointment.professional_id into appointment_professional_id
  from public.appointments appointment
  where appointment.id = p_appointment_id;
  if appointment_professional_id is null then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(appointment_professional_id::text, 0)
  );

  select appointment.* into appointment_row
  from public.appointments appointment
  where appointment.id = p_appointment_id
  for update;
  if not found then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select message.* into message_row
  from public.messages message
  where message.id = p_message_id
  for update;
  if not found then
    raise exception 'DEPOSIT_PROOF_MESSAGE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if message_row.direction <> 'inbound'
    or message_row.type not in ('image', 'document')
    or message_row.revoked_at is not null
  then
    raise exception 'DEPOSIT_PROOF_MESSAGE_INVALID' using errcode = '22023';
  end if;

  select conversation.* into conversation_row
  from public.conversations conversation
  where conversation.id = message_row.conversation_id
  for update;
  if not found
    or conversation_row.status <> 'open'
    or execution_row.conversation_id <> conversation_row.id
    or execution_row.contact_id <> appointment_row.contact_id
    or message_row.contact_id <> appointment_row.contact_id
    or conversation_row.contact_id <> appointment_row.contact_id
    or execution_row.message_ingest_sequence <>
      message_row.whatsapp_ingest_sequence
    or message_row.coexistence_account_id is distinct from
      conversation_row.coexistence_account_id
    or execution_row.session_state <> 'waiting_deposit'
    or execution_row.fresh_session
    or execution_row.session_context ->> 'appointmentId' is distinct from
      p_appointment_id::text
    or execution_row.message_snapshot ->> 'type' is distinct from
      message_row.type::text
    or nullif(
      execution_row.message_snapshot ->> 'coexistence_account_id',
      ''
    ) is distinct from message_row.coexistence_account_id::text
    or nullif(
      execution_row.conversation_snapshot ->> 'coexistence_account_id',
      ''
    ) is distinct from conversation_row.coexistence_account_id::text
  then
    raise exception 'DEPOSIT_PROOF_CONTEXT_MISMATCH' using errcode = '23514';
  end if;
  if message_row.created_at < appointment_row.created_at then
    raise exception 'DEPOSIT_PROOF_PREDATES_HOLD' using errcode = '23514';
  end if;

  -- El lock pudo esperar detrás de otro worker/acción humana. Las decisiones
  -- temporales y confirmed_at usan la hora posterior al lock; created_at del
  -- mensaje sigue siendo la recepción causal.
  processed_now := clock_timestamp();

  -- Si el hash o la lectura ya quedaron materializados junto al mensaje, el
  -- request no puede sustituirlos por otros valores.
  if nullif(trim(message_row.metadata ->> 'media_sha256'), '') is not null
    and lower(trim(message_row.metadata ->> 'media_sha256')) <>
      clean_media_sha256
  then
    raise exception 'DEPOSIT_PROOF_MEDIA_HASH_MISMATCH' using errcode = '23514';
  end if;
  if message_row.metadata ? 'deposit_proof_reading'
    and message_row.metadata -> 'deposit_proof_reading' <> p_reading
  then
    raise exception 'DEPOSIT_PROOF_READING_MISMATCH' using errcode = '23514';
  end if;
  if nullif(trim(message_row.metadata ->> 'appointment_id'), '') is not null
    and message_row.metadata ->> 'appointment_id' <> p_appointment_id::text
  then
    raise exception 'DEPOSIT_PROOF_APPOINTMENT_METADATA_MISMATCH'
      using errcode = '23514';
  end if;

  -- El merge ocurre bajo el lock del mensaje: conserva metadata concurrente y
  -- convierte la evidencia validada en el snapshot canónico para los reintentos.
  update public.messages message
  set metadata = message.metadata || jsonb_build_object(
        'deposit_proof_reading', p_reading,
        'media_sha256', clean_media_sha256,
        'deposit_proof', true,
        'appointment_id', p_appointment_id
      )
  where message.id = p_message_id
    and message.metadata is distinct from (
      message.metadata || jsonb_build_object(
        'deposit_proof_reading', p_reading,
        'media_sha256', clean_media_sha256,
        'deposit_proof', true,
        'appointment_id', p_appointment_id
      )
    )
  returning message.* into message_row;

  if not found then
    select message.* into message_row
    from public.messages message
    where message.id = p_message_id;
  end if;

  select result.* into existing_result
  from public.automated_deposit_proof_results result
  where result.appointment_id = p_appointment_id
  for update;
  if found then
    request_matches :=
      existing_result.proof_message_id = p_message_id
      and existing_result.media_sha256 = clean_media_sha256
      and existing_result.policy_version = clean_policy_version
      and existing_result.auto_approve = p_auto_approve
      and existing_result.reading = p_reading;
    if not request_matches then
      raise exception 'AUTOMATED_DEPOSIT_PROOF_REQUEST_CONFLICT'
        using errcode = '23514';
    end if;

    perform public.record_automated_deposit_process_effect(
      p_message_id,
      p_lease_token,
      p_appointment_id,
      clean_media_sha256,
      clean_policy_version,
      existing_result.result
    );

    if appointment_row.status = 'confirmed'
      and appointment_row.deposit_status = 'confirmed'
      and appointment_row.deposit_proof_message_id = p_message_id
    then
      return existing_result.result || jsonb_build_object(
        'status', 'already_confirmed',
        'original_status', existing_result.status,
        'starts_at', appointment_row.starts_at,
        'idempotent', true
      );
    end if;

    if (
        existing_result.status = 'review'
        and appointment_row.status = 'scheduled'
        and appointment_row.deposit_status = 'proof_received'
        and not appointment_row.deposit_proof_late
        and appointment_row.deposit_proof_message_id = p_message_id
      )
      or (
        existing_result.status = 'late'
        and appointment_row.status = 'cancelled'
        and appointment_row.deposit_status = 'expired'
        and appointment_row.deposit_proof_late
        and appointment_row.deposit_proof_message_id = p_message_id
      )
    then
      return existing_result.result || jsonb_build_object(
        'starts_at', appointment_row.starts_at,
        'idempotent', true
      );
    end if;

    -- Una acción posterior (cancelar, reprogramar, reemplazar el proof) gana
    -- sobre el resultado histórico. El worker debe cerrar sin enviar textos
    -- que ya no describen el turno vigente.
    return existing_result.result || jsonb_build_object(
      'status', 'superseded',
      'original_status', existing_result.status,
      'starts_at', appointment_row.starts_at,
      'current_appointment_status', appointment_row.status,
      'current_deposit_status', appointment_row.deposit_status,
      'idempotent', true
    );
  end if;

  if exists (
    select 1
    from public.automated_deposit_proof_results result
    where result.appointment_id <> p_appointment_id
      and result.proof_message_id = p_message_id
  ) then
    raise exception 'DEPOSIT_PROOF_ALREADY_USED' using errcode = '23505';
  end if;

  if appointment_row.deposit_expected_amount_ars is null
    or appointment_row.deposit_expected_alias is null
    or appointment_row.deposit_expected_holder is null
  then
    raise exception 'APPOINTMENT_DEPOSIT_EXPECTATION_MISSING'
      using errcode = '23514';
  end if;

  if appointment_row.deposit_proof_message_id is not null
    and appointment_row.deposit_proof_message_id <> p_message_id
  then
    raise exception 'APPOINTMENT_PROOF_MESSAGE_CONFLICT'
      using errcode = '23514';
  end if;

  -- Un turno confirmado por una persona antes de que termine el worker es un
  -- resultado válido e idempotente, pero nunca se reatribuye al sistema.
  if appointment_row.status = 'confirmed' then
    if appointment_row.deposit_status <> 'confirmed'
      or appointment_row.deposit_proof_message_id <> p_message_id
    then
      raise exception 'APPOINTMENT_DEPOSIT_STATE_INVALID'
        using errcode = '23514';
    end if;

    result_status := 'already_confirmed';
    result_value := jsonb_build_object(
      'status', result_status,
      'appointment_id', appointment_row.id,
      'proof_message_id', p_message_id,
      'starts_at', appointment_row.starts_at,
      'actor', 'automatic_system',
      'confirmation_actor', coalesce(
        appointment_row.deposit_confirmation_actor,
        'human_operator'
      ),
      'expected_deposit', jsonb_build_object(
        'amount_ars', appointment_row.deposit_expected_amount_ars,
        'alias', appointment_row.deposit_expected_alias,
        'holder', appointment_row.deposit_expected_holder
      ),
      'policy_version', clean_policy_version,
      'idempotent', true,
      'conversation_resumed', false,
      'session_reset', false
    );

    insert into public.automated_deposit_proof_results (
      appointment_id, proof_message_id, media_sha256, policy_version,
      auto_approve, reading, status, result, actor, processed_at
    ) values (
      appointment_row.id, p_message_id, clean_media_sha256,
      clean_policy_version, p_auto_approve, p_reading, result_status,
      result_value, 'automatic_system', processed_now
    );

    insert into public.audit_logs (
      actor_user_id, action, entity_type, entity_id, metadata
    ) values (
      null, 'deposit.automated_proof_already_confirmed', 'appointment',
      appointment_row.id,
      jsonb_build_object(
        'actor', jsonb_build_object(
          'kind', 'system',
          'name', 'automatic_system'
        ),
        'proof_message_id', p_message_id,
        'media_sha256', clean_media_sha256,
        'policy_version', clean_policy_version,
        'reading', p_reading,
        'result', result_value
      )
    );
    perform public.record_automated_deposit_process_effect(
      p_message_id,
      p_lease_token,
      p_appointment_id,
      clean_media_sha256,
      clean_policy_version,
      result_value
    );
    return result_value;
  end if;

  if appointment_row.hold_expires_at is null then
    raise exception 'APPOINTMENT_DEPOSIT_HOLD_INVALID'
      using errcode = '23514';
  end if;
  if not (
    (
      appointment_row.status = 'scheduled'
      and appointment_row.deposit_status in ('pending', 'proof_received')
    )
    or (
      appointment_row.status = 'cancelled'
      and appointment_row.deposit_status = 'expired'
    )
  ) then
    raise exception 'APPOINTMENT_DEPOSIT_STATE_INVALID'
      using errcode = '23514';
  end if;

  effective_received_at := coalesce(
    appointment_row.deposit_proof_received_at,
    message_row.created_at
  );

  -- Política básica, recalculada en la base: legibilidad, monto exacto y
  -- destinatario. Moneda, fecha e identificador se conservan para trazabilidad
  -- pero, por decisión operativa, nunca bloquean por sí solos.
  if p_reading -> 'legible' is distinct from 'true'::jsonb then
    review_reasons := array_append(review_reasons, 'UNREADABLE');
  end if;

  if jsonb_typeof(p_reading -> 'amount') is distinct from 'number' then
    review_reasons := array_append(review_reasons, 'AMOUNT_MISSING');
  else
    reading_amount := (p_reading ->> 'amount')::numeric;
    if reading_amount <>
      appointment_row.deposit_expected_amount_ars::numeric then
      review_reasons := array_append(review_reasons, 'AMOUNT_MISMATCH');
    end if;
  end if;

  reading_destination := public.normalize_automated_deposit_proof_text(
    nullif(p_reading ->> 'destination', '')
  );
  reading_holder := public.normalize_automated_deposit_proof_text(
    nullif(p_reading ->> 'holder', '')
  );
  expected_alias := public.normalize_automated_deposit_proof_text(
    appointment_row.deposit_expected_alias
  );
  expected_holder := public.normalize_automated_deposit_proof_text(
    appointment_row.deposit_expected_holder
  );
  expected_holder_first_token := split_part(expected_holder, ' ', 1);
  expected_holder_last_token := split_part(
    expected_holder,
    ' ',
    array_length(regexp_split_to_array(expected_holder, ' +'), 1)
  );

  recipient_matches :=
    (
      reading_destination <> ''
      and (
        reading_destination = expected_alias
        or replace(reading_destination, ' ', '') =
          replace(expected_alias, ' ', '')
        or (
          char_length(expected_alias) >= 6
          and position(expected_alias in reading_destination) > 0
        )
        or reading_destination = expected_holder
        or replace(reading_destination, ' ', '') =
          replace(expected_holder, ' ', '')
        or (
          char_length(expected_holder_first_token) >= 3
          and char_length(expected_holder_last_token) >= 3
          and expected_holder_first_token <>
            expected_holder_last_token
          and regexp_split_to_array(reading_destination, ' +') @>
            array[
              expected_holder_first_token,
              expected_holder_last_token
            ]
        )
      )
    )
    or (
      reading_holder <> ''
      and (
        reading_holder = expected_holder
        or replace(reading_holder, ' ', '') =
          replace(expected_holder, ' ', '')
        or (
          char_length(expected_holder) >= 6
          and position(expected_holder in reading_holder) > 0
        )
        or reading_holder = expected_alias
        or replace(reading_holder, ' ', '') =
          replace(expected_alias, ' ', '')
        or (
          char_length(expected_holder_first_token) >= 3
          and char_length(expected_holder_last_token) >= 3
          and expected_holder_first_token <>
            expected_holder_last_token
          and regexp_split_to_array(reading_holder, ' +') @>
            array[
              expected_holder_first_token,
              expected_holder_last_token
            ]
        )
      )
    );

  if reading_destination = '' and reading_holder = '' then
    review_reasons := array_append(review_reasons, 'RECIPIENT_MISSING');
  elsif not recipient_matches then
    review_reasons := array_append(review_reasons, 'RECIPIENT_MISMATCH');
  end if;

  if not p_auto_approve then
    review_reasons := array_append(review_reasons, 'AUTO_APPROVAL_DISABLED');
  end if;

  if appointment_row.deposit_proof_late
    or effective_received_at > appointment_row.hold_expires_at
    or appointment_row.starts_at <= processed_now
  then
    result_status := 'late';
    if not ('HOLD_EXPIRED' = any(review_reasons)) then
      review_reasons := array_append(review_reasons, 'HOLD_EXPIRED');
    end if;

    update public.appointments appointment
    set status = 'cancelled',
        deposit_status = 'expired',
        deposit_proof_message_id = p_message_id,
        deposit_proof_received_at = effective_received_at,
        deposit_proof_late = true,
        hold_expired_notification_status = 'cancelled',
        hold_expired_notification_claimed_at = null,
        hold_expired_notification_error = null
    where appointment.id = appointment_row.id
    returning appointment.* into appointment_row;
  else
    begin
      -- El comprobante pudo llegar antes del vencimiento y terminar su OCR
      -- después de que el cron canceló el hold. Restaurar scheduled bajo el
      -- mismo advisory lock vuelve a consultar la exclusión: sólo recupera el
      -- lugar si nadie lo ocupó mientras tanto.
      update public.appointments appointment
      set status = 'scheduled',
          deposit_status = 'proof_received',
          deposit_proof_message_id = p_message_id,
          deposit_proof_received_at = effective_received_at,
          deposit_proof_late = false,
          hold_expired_notification_status = 'cancelled',
          hold_expired_notification_claimed_at = null,
          hold_expired_notification_error = null
      where appointment.id = appointment_row.id
      returning appointment.* into appointment_row;

      if p_auto_approve and cardinality(review_reasons) = 0 then
        result_status := 'confirmed';
        update public.appointments appointment
        set status = 'confirmed',
            deposit_status = 'confirmed',
            deposit_confirmed_at = processed_now,
            deposit_confirmed_by = null,
            deposit_confirmation_actor = 'automatic_system',
            deposit_confirmation_policy_version = clean_policy_version,
            hold_expired_notification_status = 'cancelled',
            hold_expired_notification_claimed_at = null,
            hold_expired_notification_error = null
        where appointment.id = appointment_row.id
        returning appointment.* into appointment_row;
      else
        result_status := 'review';
      end if;
    exception
      when exclusion_violation then
        -- Otra reserva ganó el horario. La evidencia queda asociada y visible,
        -- pero jamás se fuerza una violación ni se revive el turno perdido.
        result_status := 'late';
        review_reasons := array_append(
          review_reasons,
          'SLOT_NO_LONGER_AVAILABLE'
        );
        update public.appointments appointment
        set status = 'cancelled',
            deposit_status = 'expired',
            deposit_proof_message_id = p_message_id,
            deposit_proof_received_at = effective_received_at,
            deposit_proof_late = true,
            hold_expired_notification_status = 'cancelled',
            hold_expired_notification_claimed_at = null,
            hold_expired_notification_error = 'SLOT_NO_LONGER_AVAILABLE'
        where appointment.id = appointment_row.id
        returning appointment.* into appointment_row;
    end;
  end if;

  update public.messages message
  set metadata = message.metadata || jsonb_build_object(
    'deposit_proof_late', result_status = 'late'
  )
  where message.id = p_message_id;

  if result_status in ('review', 'late') then
    -- Sólo toma una conversación auto o reafirma el handoff del mismo
    -- comprobante. Una pausa de operador/app/otro inbound nunca se suplanta.
    update public.conversations conversation
    set automation_mode = 'manual',
        needs_human = true,
        priority = conversation.priority or result_status = 'late',
        current_flow = case result_status
          when 'late' then 'late_deposit_proof'
          else 'deposit_proof_received'
        end,
        automation_pause_source = 'inbound_handoff',
        automation_pause_message_id = p_message_id
    where conversation.id = conversation_row.id
      and (
        conversation.automation_mode = 'auto'
        or (
          conversation.automation_pause_source = 'inbound_handoff'
          and conversation.automation_pause_message_id = p_message_id
        )
      );

    insert into public.automation_sessions (
      conversation_id, state, context, expires_at,
      last_automation_message_id, last_automation_ingest_sequence,
      last_automation_session_sequence
    ) values (
      conversation_row.id,
      'human_handoff',
      jsonb_build_object(
        'appointmentId', appointment_row.id,
        'proofMessageId', p_message_id,
        'reason', case result_status
          when 'late' then 'deposit_proof_late'
          else 'deposit_proof_review'
        end
      ),
      processed_now + interval '30 days',
      p_message_id,
      message_row.whatsapp_ingest_sequence,
      100
    )
    on conflict (conversation_id) do update
    set state = 'human_handoff',
        context = excluded.context,
        expires_at = excluded.expires_at,
        last_automation_message_id = excluded.last_automation_message_id,
        last_automation_ingest_sequence =
          excluded.last_automation_ingest_sequence,
        last_automation_session_sequence =
          excluded.last_automation_session_sequence
    where automation_sessions.last_automation_ingest_sequence is null
      or automation_sessions.last_automation_ingest_sequence <=
        excluded.last_automation_ingest_sequence;
  else
    -- Reactiva únicamente el handoff que pertenece causalmente a este mismo
    -- comprobante. No toca una preferencia manual explícita de Gisela.
    update public.conversations conversation
    set automation_mode = 'auto',
        needs_human = false,
        priority = false,
        current_flow = null,
        automation_pause_source = null,
        automation_pause_message_id = null
    where conversation.id = conversation_row.id
      and conversation.automation_mode = 'manual'
      and conversation.automation_pause_source = 'inbound_handoff'
      and conversation.automation_pause_message_id = p_message_id;
    conversation_resumed := found;
    automation_can_idle :=
      conversation_row.automation_mode = 'auto' or conversation_resumed;

    -- El marcador de ingest evita pisar una sesión ya procesada por un inbound
    -- posterior. Que ese inbound sólo esté en cola no impide dejar idle: su
    -- ejecución serializada debe snapshottear el estado ya resuelto.
    if automation_can_idle then
      insert into public.automation_sessions (
        conversation_id, state, context, expires_at,
        last_automation_message_id, last_automation_ingest_sequence,
        last_automation_session_sequence
      ) values (
        conversation_row.id, 'idle', '{}'::jsonb, null,
        p_message_id, message_row.whatsapp_ingest_sequence, 100
      )
      on conflict (conversation_id) do update
      set state = 'idle',
          context = '{}'::jsonb,
          expires_at = null,
          last_automation_message_id = excluded.last_automation_message_id,
          last_automation_ingest_sequence =
            excluded.last_automation_ingest_sequence,
          last_automation_session_sequence =
            excluded.last_automation_session_sequence
      where automation_sessions.last_automation_ingest_sequence is null
        or automation_sessions.last_automation_ingest_sequence <=
          excluded.last_automation_ingest_sequence;
      session_reset := found;
    end if;

  end if;

  result_value := jsonb_build_object(
    'status', result_status,
    'appointment_id', appointment_row.id,
    'proof_message_id', p_message_id,
    'starts_at', appointment_row.starts_at,
    'actor', 'automatic_system',
    'policy_version', clean_policy_version,
    'expected_deposit', jsonb_build_object(
      'amount_ars', appointment_row.deposit_expected_amount_ars,
      'alias', appointment_row.deposit_expected_alias,
      'holder', appointment_row.deposit_expected_holder
    ),
    'idempotent', false,
    'auto_approve_requested', p_auto_approve,
    'review_reasons', to_jsonb(review_reasons),
    'conversation_resumed', conversation_resumed,
    'session_reset', session_reset,
    'processed_at', processed_now
  );

  insert into public.automated_deposit_proof_results (
    appointment_id, proof_message_id, media_sha256, policy_version,
    auto_approve, reading, status, result, actor, processed_at
  ) values (
    appointment_row.id, p_message_id, clean_media_sha256,
    clean_policy_version, p_auto_approve, p_reading, result_status,
    result_value, 'automatic_system', processed_now
  );

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    null,
    case result_status
      when 'confirmed' then 'deposit.automatically_confirmed'
      when 'late' then 'deposit.automated_proof_late'
      else 'deposit.automated_proof_review'
    end,
    'appointment',
    appointment_row.id,
    jsonb_build_object(
      'actor', jsonb_build_object(
        'kind', 'system',
        'name', 'automatic_system'
      ),
      'proof_message_id', p_message_id,
      'media_sha256', clean_media_sha256,
      'policy_version', clean_policy_version,
      'auto_approve', p_auto_approve,
      'reading', p_reading,
      'result', result_value
    )
  );

  perform public.record_automated_deposit_process_effect(
    p_message_id,
    p_lease_token,
    p_appointment_id,
    clean_media_sha256,
    clean_policy_version,
    result_value
  );

  return result_value;
end;
$$;

comment on function public.process_automated_deposit_proof(
  uuid, uuid, uuid, jsonb, text, text, boolean
) is
  'Service-role only y requiere lease vigente. Asocia un comprobante al turno exacto y devuelve confirmed, review, late, already_confirmed o superseded con starts_at e idempotencia transaccional.';

revoke execute on function public.process_automated_deposit_proof(
  uuid, uuid, uuid, jsonb, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.process_automated_deposit_proof(
  uuid, uuid, uuid, jsonb, text, text, boolean
) to service_role;

-- Fallback causal cuando no fue posible obtener una lectura confiable. No
-- simula OCR ni usa record_deposit_proof: asocia el mensaje exacto, conserva
-- el hold si llegó a tiempo y deja evidencia durable para revisión humana.
create or replace function public.route_automated_deposit_proof_to_review(
  p_message_id uuid,
  p_lease_token uuid,
  p_appointment_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  routing_policy constant text := 'deposit-proof-review-routing/v1';
  clean_reason text := upper(trim(coalesce(p_reason, '')));
  processed_now timestamptz := clock_timestamp();
  appointment_professional_id uuid;
  execution_row public.whatsapp_automation_executions%rowtype;
  appointment_row public.appointments%rowtype;
  message_row public.messages%rowtype;
  conversation_row public.conversations%rowtype;
  existing_result public.automated_deposit_proof_results%rowtype;
  route_reading jsonb;
  result_status text;
  result_value jsonb;
  review_reasons text[];
  effective_received_at timestamptz;
  request_matches boolean := false;
begin
  perform public.assert_whatsapp_automation_service_role();
  if p_message_id is null
    or p_appointment_id is null
    or clean_reason not in (
      'MEDIA_DISABLED',
      'DOWNLOAD_FAILED',
      'READING_FAILED',
      'UNREADABLE'
    )
  then
    raise exception 'AUTOMATED_DEPOSIT_REVIEW_ROUTE_INVALID'
      using errcode = '22023';
  end if;

  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );

  select appointment.professional_id into appointment_professional_id
  from public.appointments appointment
  where appointment.id = p_appointment_id;
  if appointment_professional_id is null then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(appointment_professional_id::text, 0)
  );

  select appointment.* into appointment_row
  from public.appointments appointment
  where appointment.id = p_appointment_id
  for update;

  select message.* into message_row
  from public.messages message
  where message.id = p_message_id
  for update;
  if not found then
    raise exception 'DEPOSIT_PROOF_MESSAGE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if message_row.direction <> 'inbound'
    or message_row.type not in ('image', 'document')
    or message_row.revoked_at is not null
  then
    raise exception 'DEPOSIT_PROOF_MESSAGE_INVALID' using errcode = '22023';
  end if;

  select conversation.* into conversation_row
  from public.conversations conversation
  where conversation.id = message_row.conversation_id
  for update;
  if not found
    or conversation_row.status <> 'open'
    or execution_row.conversation_id <> conversation_row.id
    or execution_row.contact_id <> appointment_row.contact_id
    or message_row.contact_id <> appointment_row.contact_id
    or conversation_row.contact_id <> appointment_row.contact_id
    or execution_row.message_ingest_sequence <>
      message_row.whatsapp_ingest_sequence
    or message_row.coexistence_account_id is distinct from
      conversation_row.coexistence_account_id
    or execution_row.session_state <> 'waiting_deposit'
    or execution_row.fresh_session
    or execution_row.session_context ->> 'appointmentId' is distinct from
      p_appointment_id::text
    or execution_row.message_snapshot ->> 'type' is distinct from
      message_row.type::text
    or nullif(
      execution_row.message_snapshot ->> 'coexistence_account_id',
      ''
    ) is distinct from message_row.coexistence_account_id::text
    or nullif(
      execution_row.conversation_snapshot ->> 'coexistence_account_id',
      ''
    ) is distinct from conversation_row.coexistence_account_id::text
  then
    raise exception 'DEPOSIT_PROOF_CONTEXT_MISMATCH'
      using errcode = '23514';
  end if;
  if message_row.created_at < appointment_row.created_at then
    raise exception 'DEPOSIT_PROOF_PREDATES_HOLD' using errcode = '23514';
  end if;

  processed_now := clock_timestamp();

  if nullif(message_row.metadata ->> 'appointment_id', '') is not null
    and message_row.metadata ->> 'appointment_id' <> p_appointment_id::text
  then
    raise exception 'DEPOSIT_PROOF_APPOINTMENT_METADATA_MISMATCH'
      using errcode = '23514';
  end if;
  if nullif(message_row.metadata ->> 'deposit_proof_route_reason', '')
      is not null
    and message_row.metadata ->> 'deposit_proof_route_reason' <> clean_reason
  then
    raise exception 'DEPOSIT_PROOF_ROUTE_REASON_MISMATCH'
      using errcode = '23514';
  end if;

  update public.messages message
  set metadata = message.metadata || jsonb_build_object(
    'deposit_proof', true,
    'appointment_id', p_appointment_id,
    'deposit_proof_route_reason', clean_reason,
    'deposit_proof_routing_policy', routing_policy
  )
  where message.id = p_message_id
    and message.metadata is distinct from (
      message.metadata || jsonb_build_object(
        'deposit_proof', true,
        'appointment_id', p_appointment_id,
        'deposit_proof_route_reason', clean_reason,
        'deposit_proof_routing_policy', routing_policy
      )
    )
  returning message.* into message_row;
  if not found then
    select message.* into message_row
    from public.messages message
    where message.id = p_message_id;
  end if;

  route_reading := jsonb_build_object(
    'route_reason', clean_reason,
    'extraction_available', false
  );

  select result.* into existing_result
  from public.automated_deposit_proof_results result
  where result.appointment_id = p_appointment_id
    or result.proof_message_id = p_message_id
  order by case when result.appointment_id = p_appointment_id then 0 else 1 end
  limit 1
  for update;
  if found then
    request_matches :=
      existing_result.appointment_id = p_appointment_id
      and existing_result.proof_message_id = p_message_id
      and existing_result.media_sha256 is null
      and existing_result.policy_version = routing_policy
      and not existing_result.auto_approve
      and existing_result.reading = route_reading;
    if not request_matches then
      raise exception 'AUTOMATED_DEPOSIT_PROOF_REQUEST_CONFLICT'
        using errcode = '23514';
    end if;

    perform public.record_automated_deposit_process_effect(
      p_message_id,
      p_lease_token,
      p_appointment_id,
      null,
      routing_policy,
      existing_result.result
    );

    if existing_result.status = 'review'
      and appointment_row.status = 'scheduled'
      and appointment_row.deposit_status = 'proof_received'
      and not appointment_row.deposit_proof_late
      and appointment_row.deposit_proof_message_id = p_message_id
    then
      return existing_result.result || jsonb_build_object(
        'starts_at', appointment_row.starts_at,
        'idempotent', true
      );
    end if;
    if existing_result.status = 'late'
      and appointment_row.status = 'cancelled'
      and appointment_row.deposit_status = 'expired'
      and appointment_row.deposit_proof_late
      and appointment_row.deposit_proof_message_id = p_message_id
    then
      return existing_result.result || jsonb_build_object(
        'starts_at', appointment_row.starts_at,
        'idempotent', true
      );
    end if;

    return existing_result.result || jsonb_build_object(
      'status', 'superseded',
      'original_status', existing_result.status,
      'starts_at', appointment_row.starts_at,
      'current_appointment_status', appointment_row.status,
      'current_deposit_status', appointment_row.deposit_status,
      'idempotent', true
    );
  end if;

  if appointment_row.deposit_proof_message_id is not null
    and appointment_row.deposit_proof_message_id <> p_message_id
  then
    raise exception 'APPOINTMENT_PROOF_MESSAGE_CONFLICT'
      using errcode = '23514';
  end if;
  if appointment_row.hold_expires_at is null then
    raise exception 'APPOINTMENT_DEPOSIT_HOLD_INVALID'
      using errcode = '23514';
  end if;
  if not (
    (
      appointment_row.status = 'scheduled'
      and appointment_row.deposit_status in ('pending', 'proof_received')
    )
    or (
      appointment_row.status = 'cancelled'
      and appointment_row.deposit_status = 'expired'
    )
  ) then
    raise exception 'APPOINTMENT_DEPOSIT_STATE_INVALID'
      using errcode = '23514';
  end if;

  effective_received_at := coalesce(
    appointment_row.deposit_proof_received_at,
    message_row.created_at
  );
  review_reasons := array[clean_reason]::text[];

  if appointment_row.deposit_proof_late
    or effective_received_at > appointment_row.hold_expires_at
    or appointment_row.starts_at <= processed_now
  then
    result_status := 'late';
    review_reasons := array_append(review_reasons, 'HOLD_EXPIRED');
    update public.appointments appointment
    set status = 'cancelled',
        deposit_status = 'expired',
        deposit_proof_message_id = p_message_id,
        deposit_proof_received_at = effective_received_at,
        deposit_proof_late = true,
        hold_expired_notification_status = 'cancelled',
        hold_expired_notification_claimed_at = null,
        hold_expired_notification_error = null
    where appointment.id = appointment_row.id
    returning appointment.* into appointment_row;
  else
    begin
      update public.appointments appointment
      set status = 'scheduled',
          deposit_status = 'proof_received',
          deposit_proof_message_id = p_message_id,
          deposit_proof_received_at = effective_received_at,
          deposit_proof_late = false,
          hold_expired_notification_status = 'cancelled',
          hold_expired_notification_claimed_at = null,
          hold_expired_notification_error = null
      where appointment.id = appointment_row.id
      returning appointment.* into appointment_row;
      result_status := 'review';
    exception
      when exclusion_violation then
        result_status := 'late';
        review_reasons := array_append(
          review_reasons,
          'SLOT_NO_LONGER_AVAILABLE'
        );
        update public.appointments appointment
        set status = 'cancelled',
            deposit_status = 'expired',
            deposit_proof_message_id = p_message_id,
            deposit_proof_received_at = effective_received_at,
            deposit_proof_late = true,
            hold_expired_notification_status = 'cancelled',
            hold_expired_notification_claimed_at = null,
            hold_expired_notification_error = 'SLOT_NO_LONGER_AVAILABLE'
        where appointment.id = appointment_row.id
        returning appointment.* into appointment_row;
    end;
  end if;

  update public.messages message
  set metadata = message.metadata || jsonb_build_object(
    'deposit_proof_late', result_status = 'late'
  )
  where message.id = p_message_id;

  update public.conversations conversation
  set automation_mode = 'manual',
      needs_human = true,
      priority = conversation.priority or result_status = 'late',
      current_flow = case result_status
        when 'late' then 'late_deposit_proof'
        else 'deposit_proof_received'
      end,
      automation_pause_source = 'inbound_handoff',
      automation_pause_message_id = p_message_id
  where conversation.id = conversation_row.id
    and (
      conversation.automation_mode = 'auto'
      or (
        conversation.automation_pause_source = 'inbound_handoff'
        and conversation.automation_pause_message_id = p_message_id
      )
    );

  insert into public.automation_sessions (
    conversation_id, state, context, expires_at,
    last_automation_message_id, last_automation_ingest_sequence,
    last_automation_session_sequence
  ) values (
    conversation_row.id,
    'human_handoff',
    jsonb_build_object(
      'appointmentId', appointment_row.id,
      'proofMessageId', p_message_id,
      'reason', lower(clean_reason),
      'depositProofStatus', result_status
    ),
    processed_now + interval '30 days',
    p_message_id,
    message_row.whatsapp_ingest_sequence,
    100
  )
  on conflict (conversation_id) do update
  set state = 'human_handoff',
      context = excluded.context,
      expires_at = excluded.expires_at,
      last_automation_message_id = excluded.last_automation_message_id,
      last_automation_ingest_sequence =
        excluded.last_automation_ingest_sequence,
      last_automation_session_sequence =
        excluded.last_automation_session_sequence
  where automation_sessions.last_automation_ingest_sequence is null
    or automation_sessions.last_automation_ingest_sequence <=
      excluded.last_automation_ingest_sequence;

  result_value := jsonb_build_object(
    'status', result_status,
    'appointment_id', appointment_row.id,
    'proof_message_id', p_message_id,
    'starts_at', appointment_row.starts_at,
    'actor', 'automatic_system',
    'policy_version', routing_policy,
    'route_reason', clean_reason,
    'review_reasons', to_jsonb(review_reasons),
    'idempotent', false,
    'processed_at', processed_now
  );

  insert into public.automated_deposit_proof_results (
    appointment_id, proof_message_id, media_sha256, policy_version,
    auto_approve, reading, status, result, actor, processed_at
  ) values (
    appointment_row.id, p_message_id, null, routing_policy,
    false, route_reading, result_status, result_value,
    'automatic_system', processed_now
  );

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    null,
    case result_status
      when 'late' then 'deposit.automated_proof_route_late'
      else 'deposit.automated_proof_route_review'
    end,
    'appointment',
    appointment_row.id,
    jsonb_build_object(
      'actor', jsonb_build_object(
        'kind', 'system',
        'name', 'automatic_system'
      ),
      'proof_message_id', p_message_id,
      'policy_version', routing_policy,
      'route_reason', clean_reason,
      'result', result_value
    )
  );

  perform public.record_automated_deposit_process_effect(
    p_message_id,
    p_lease_token,
    p_appointment_id,
    null,
    routing_policy,
    result_value
  );

  return result_value;
end;
$$;

comment on function public.route_automated_deposit_proof_to_review(
  uuid, uuid, uuid, text
) is
  'Service-role only. Con lease vigente asocia el comprobante exacto a revisión/late cuando media u OCR no permiten una lectura; devuelve starts_at y es idempotente.';

revoke execute on function public.route_automated_deposit_proof_to_review(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.route_automated_deposit_proof_to_review(
  uuid, uuid, uuid, text
) to service_role;

-- Una transcripción sólo puede materializar un opt-out mientras conserva el
-- lease de la ejecución que recibió ese audio. La evidencia durable continúa
-- siendo el wamid original; el texto transcripto no se persiste aquí.
create or replace function public.record_transcribed_whatsapp_opt_out(
  p_message_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  execution_row public.whatsapp_automation_executions%rowtype;
  message_row public.messages%rowtype;
  conversation_row public.conversations%rowtype;
  consent_row public.whatsapp_consent_events%rowtype;
  evidence_value text;
begin
  execution_row := public.require_whatsapp_automation_execution(
    p_message_id,
    p_lease_token
  );

  select message.* into message_row
  from public.messages message
  where message.id = p_message_id
  for update;
  if not found then
    raise exception 'WHATSAPP_AUTOMATION_OPT_OUT_MESSAGE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select conversation.* into conversation_row
  from public.conversations conversation
  where conversation.id = message_row.conversation_id
  for update;
  if not found
    or execution_row.conversation_id is distinct from conversation_row.id
    or execution_row.contact_id is distinct from message_row.contact_id
    or conversation_row.contact_id is distinct from message_row.contact_id
    or message_row.coexistence_account_id is distinct from
      conversation_row.coexistence_account_id
    or execution_row.message_snapshot ->> 'type' is distinct from 'audio'
    or nullif(
      execution_row.message_snapshot ->> 'coexistence_account_id',
      ''
    ) is distinct from message_row.coexistence_account_id::text
    or nullif(
      execution_row.conversation_snapshot ->> 'coexistence_account_id',
      ''
    ) is distinct from conversation_row.coexistence_account_id::text
  then
    raise exception 'WHATSAPP_AUTOMATION_OPT_OUT_CONTEXT_MISMATCH'
      using errcode = '23514';
  end if;

  if message_row.direction <> 'inbound'
    or message_row.type <> 'audio'
    or message_row.revoked_at is not null
    or message_row.whatsapp_ingest_sequence is null
    or nullif(trim(coalesce(message_row.whatsapp_message_id, '')), '') is null
  then
    raise exception 'WHATSAPP_AUTOMATION_OPT_OUT_AUDIO_INVALID'
      using errcode = '23514';
  end if;

  -- Serializa contra cualquier consentimiento explícito del mismo contacto.
  -- Si T2 ya decidió luego de este audio T1, T2 gana aunque la transcripción
  -- termine tarde; devolver true permite cerrar idempotentemente la ejecución.
  perform 1
  from public.contacts contact
  where contact.id = message_row.contact_id
  for update;
  if not found then
    raise exception 'WHATSAPP_AUTOMATION_OPT_OUT_CONTACT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from public.whatsapp_consent_events consent
    left join public.messages later_message
      on later_message.whatsapp_message_id = consent.whatsapp_message_id
    where consent.contact_id = message_row.contact_id
      and (
        (
          later_message.id is not null
          and later_message.contact_id = message_row.contact_id
          and later_message.direction = 'inbound'
          and later_message.whatsapp_ingest_sequence >
            message_row.whatsapp_ingest_sequence
        )
        or (
          later_message.id is null
          and consent.created_at > message_row.created_at
        )
      )
  ) then
    return true;
  end if;

  evidence_value := 'automation_audio_transcription:' || p_message_id::text;
  consent_row := public.record_whatsapp_consent(
    message_row.contact_id,
    'opt_out',
    'all',
    'whatsapp',
    evidence_value,
    'whatsapp-business-messaging-policy/2026-08-10',
    trim(message_row.whatsapp_message_id)
  );

  if consent_row.id is null
    or consent_row.contact_id is distinct from message_row.contact_id
    or consent_row.decision is distinct from 'opt_out'
    or consent_row.purpose is distinct from 'all'
    or consent_row.source is distinct from 'whatsapp'
    or consent_row.evidence_ref is distinct from evidence_value
    or consent_row.policy_version is distinct from
      'whatsapp-business-messaging-policy/2026-08-10'
    or consent_row.whatsapp_message_id is distinct from
      trim(message_row.whatsapp_message_id)
  then
    raise exception 'WHATSAPP_AUTOMATION_OPT_OUT_RESULT_MISMATCH'
      using errcode = '23514';
  end if;

  return true;
end;
$$;

comment on function public.record_transcribed_whatsapp_opt_out(uuid, uuid) is
  'Service-role only. Con message_id y lease vigentes registra idempotentemente el opt-out all/whatsapp policy whatsapp-business-messaging-policy/2026-08-10 del audio inbound exacto.';

revoke execute on function public.record_transcribed_whatsapp_opt_out(
  uuid, uuid
) from public, anon, authenticated;
grant execute on function public.record_transcribed_whatsapp_opt_out(
  uuid, uuid
) to service_role;
