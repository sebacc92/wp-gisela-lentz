-- Gisela confirmó dos ajustes de presentación en los motivos reservables:
-- mostrar "Ortodoncia" con su nombre canónico y agregar "Prótesis".
-- Los servicios siguen siendo categorías: duración, seña, agenda y profesional
-- conservan las reglas generales existentes y no se configuran por prestación.
do $$
declare
  orthodontics_id constant uuid :=
    '51000000-0000-4000-8000-000000000007'::uuid;
  new_prosthesis_id constant uuid :=
    '51000000-0000-4000-8000-000000000010'::uuid;
  prosthesis_ids uuid[];
  prosthesis_id uuid;
  legacy_duration integer;
begin
  if exists (
    select 1
    from public.services service
    where service.id <> orthodontics_id
      and lower(trim(service.name)) in (
        'ortodoncia',
        'ortopedia y ortodoncia'
      )
  ) then
    raise exception 'ORTHODONTICS_SERVICE_ALREADY_EXISTS';
  end if;

  update public.services
  set name = 'Ortodoncia',
      active = true,
      sort_order = 50
  where id = orthodontics_id
    and lower(trim(name)) in ('ortodoncia', 'ortopedia y ortodoncia');

  if not found then
    raise exception 'ORTHODONTICS_SERVICE_NOT_FOUND';
  end if;

  select array_agg(service.id order by service.created_at, service.id)
  into prosthesis_ids
  from public.services service
  where lower(trim(service.name)) in ('protesis', 'prótesis');

  if coalesce(cardinality(prosthesis_ids), 0) > 1 then
    raise exception 'AMBIGUOUS_PROSTHESIS_SERVICES';
  end if;

  if coalesce(cardinality(prosthesis_ids), 0) = 1 then
    prosthesis_id := prosthesis_ids[1];
    update public.services
    set name = 'Prótesis',
        active = true,
        sort_order = 60
    where id = prosthesis_id;
  else
    if exists (
      select 1 from public.services where id = new_prosthesis_id
    ) then
      raise exception 'PROSTHESIS_SERVICE_ID_ALREADY_USED';
    end if;

    select settings.default_appointment_duration_minutes
    into legacy_duration
    from public.app_settings settings
    where settings.id = true;

    if legacy_duration is null then
      raise exception 'DEFAULT_APPOINTMENT_DURATION_NOT_CONFIGURED';
    end if;

    insert into public.services (
      id, name, description, duration_minutes, active, sort_order
    ) values (
      new_prosthesis_id,
      'Prótesis',
      null,
      legacy_duration,
      true,
      60
    );
  end if;

  update public.services
  set sort_order = 70
  where lower(trim(name)) = 'otros';
end;
$$;
