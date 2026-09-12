-- Volver a mirar las diferencias de texto que quedaron pendientes.
--
-- El pull entrante es incremental: Google sólo devuelve lo que cambió desde el
-- token anterior. Una diferencia de metadatos abierta antes de que existiera la
-- adopción —o por un fallo transitorio al adoptarla— no vuelve a aparecer nunca
-- en la lista, y mientras siga pendiente el claim saliente no toma ese turno:
-- queda congelado hasta que alguien vuelva a tocar el evento en Google.
--
-- Esto enumera esos turnos para que cada pull los pida por GET y reintente
-- adoptar su texto. Es sólo lectura y no decide nada: quien adopta sigue siendo
-- `adopt_google_calendar_managed_title`, con las mismas condiciones.

create or replace function public.list_google_calendar_pending_title_conflicts(
  p_expected_generation bigint,
  p_lease_token uuid,
  p_limit integer default 25
)
returns table (appointment_id uuid, google_event_id text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.assert_google_calendar_inbound_lease(
    p_expected_generation, p_lease_token
  );

  return query
  select conflict.appointment_id, conflict.google_event_id
  from public.google_calendar_sync_conflicts conflict
  join public.appointments appointment
    on appointment.id = conflict.appointment_id
   and appointment.status in ('scheduled', 'confirmed')
  where conflict.status = 'pending'
    and conflict.kind = 'metadata_changed'
    and conflict.connection_generation = p_expected_generation
  order by conflict.appointment_id
  limit greatest(1, least(coalesce(p_limit, 25), 100));
end;
$$;

revoke execute on function public.list_google_calendar_pending_title_conflicts(
  bigint, uuid, integer
) from public, anon, authenticated;

grant execute on function public.list_google_calendar_pending_title_conflicts(
  bigint, uuid, integer
) to service_role;
