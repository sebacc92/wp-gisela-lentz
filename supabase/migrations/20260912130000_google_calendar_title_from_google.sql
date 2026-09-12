-- El texto del evento lo manda Google; la hora y la existencia las manda la app.
--
-- Hasta ahora el título de un evento gestionado se generaba en cada push a
-- partir de la ficha, y no se guardaba en ninguna parte. Si Gisela editaba ese
-- texto en Google —para anotar "dio seña", por ejemplo— la huella del payload
-- dejaba de validar, se abría un conflicto `metadata_changed` y la única salida
-- cableada era restaurar el título de la app encima del suyo.
--
-- Ahora ese texto se adopta: se guarda como el título de ese turno y el
-- proyector deja de regenerarlo. La app nunca pisa lo que ella escribió.
--
-- Adoptar NO cambia la identidad del paciente. La ficha —nombre, celular,
-- cobertura— sigue siendo la de la aplicación: un evento puede reutilizarse
-- para otra persona, y renombrar a una paciente desde el texto de un evento
-- haría que el bot le escriba a la equivocada. El texto es sólo texto.

alter table public.appointments
  add column google_calendar_summary_override text
    constraint appointments_google_calendar_summary_override_shape check (
      google_calendar_summary_override is null
      or (
        char_length(google_calendar_summary_override) between 1 and 255
        and google_calendar_summary_override !~ '[\r\n\t]'
        and btrim(google_calendar_summary_override) =
          google_calendar_summary_override
      )
    );

comment on column public.appointments.google_calendar_summary_override is
  'Título que una persona escribió en el evento de Google. Reemplaza al generado en cada proyección; nunca cambia la ficha del paciente.';

-- Sólo la sincronización entrante adopta un título, y sólo con el lease vigente
-- del pull que lo observó. Devuelve true cuando el título cambió de verdad.
create or replace function public.adopt_google_calendar_managed_title(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_appointment_id uuid,
  p_google_event_id text,
  p_automation_epoch uuid,
  p_summary text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_remote_projection_stage text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  adopted text := nullif(btrim(coalesce(p_summary, '')), '');
  appointment_row public.appointments%rowtype;
  job_row public.google_calendar_sync_jobs%rowtype;
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );

  if adopted is null
    or char_length(adopted) > 255
    or adopted ~ '[\r\n\t]'
    or p_automation_epoch is null
  then
    return false;
  end if;

  -- Mismas condiciones que la observación: el evento tiene que seguir siendo
  -- el que esta conexión proyectó para este turno, en esta generación.
  select job.* into job_row
  from public.google_calendar_sync_jobs job
  join public.google_calendar_connections connection
    on connection.id = true
   and connection.status = 'connected'
   and connection.connection_generation = p_expected_generation
   and connection.automation_enabled
   and connection.automation_epoch = p_automation_epoch
   and connection.automation_epoch = job.automation_epoch
   and connection.automation_google_account_id =
     job.authorized_google_account_id
   and connection.automation_google_calendar_id =
     job.authorized_google_calendar_id
   and connection.automation_connection_generation =
     job.authorized_connection_generation
   and connection.google_account_id = job.authorized_google_account_id
   and connection.google_calendar_id = job.authorized_google_calendar_id
   and connection.sync_scope_google_account_id is not distinct from
     connection.google_account_id
   and connection.sync_scope_google_calendar_id is not distinct from
     connection.google_calendar_id
   and connection.sync_scope_generation = connection.connection_generation
  where job.appointment_id = p_appointment_id
    and job.google_event_id = p_google_event_id
    and job.connection_generation = p_expected_generation
  for update of job;
  if not found then return false; end if;

  -- Se adopta el texto sólo cuando el texto es lo único que cambió. Si el
  -- horario o la etapa del evento tampoco coinciden, esto no es una anotación:
  -- es una reprogramación o algo que nadie entendió todavía, y le corresponde
  -- el conflicto de siempre.
  select * into appointment_row
  from public.appointments
  where id = p_appointment_id;
  if not found
    or appointment_row.status not in ('scheduled', 'confirmed')
    or p_starts_at is null
    or p_ends_at is null
    or appointment_row.starts_at is distinct from p_starts_at
    or appointment_row.ends_at is distinct from p_ends_at
    or p_remote_projection_stage is distinct from job_row.projection_stage
  then
    return false;
  end if;

  if appointment_row.google_calendar_summary_override is distinct from adopted
  then
    update public.appointments
    set google_calendar_summary_override = adopted
    where id = p_appointment_id;

    insert into public.audit_logs (
      actor_user_id, action, entity_type, entity_id, metadata
    ) values (
      null, 'google_calendar.title_adopted', 'appointment', p_appointment_id,
      jsonb_build_object('google_event_id', p_google_event_id)
    );
  end if;

  -- El conflicto que abrió esa misma edición queda resuelto: la app adoptó el
  -- texto en vez de restaurar el suyo, así que no hay nada que revisar y la
  -- proyección de este turno vuelve a poder salir.
  update public.google_calendar_sync_conflicts
  set status = 'applied',
      resolved_at = clock_timestamp()
  where appointment_id = p_appointment_id
    and status = 'pending'
    and kind = 'metadata_changed';

  return true;
end;
$$;

revoke execute on function public.adopt_google_calendar_managed_title(
  bigint, uuid, uuid, text, uuid, text, timestamptz, timestamptz, text
) from public, anon, authenticated;

grant execute on function public.adopt_google_calendar_managed_title(
  bigint, uuid, uuid, text, uuid, text, timestamptz, timestamptz, text
) to service_role;
