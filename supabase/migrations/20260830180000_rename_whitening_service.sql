-- La opción visible para pacientes deja de llamarse "Blanqueamiento".
-- Se conserva el UUID para no romper turnos existentes ni respuestas de listas
-- de WhatsApp que todavía estén abiertas.
do $$
declare
  whitening_service_id constant uuid :=
    '51000000-0000-4000-8000-000000000006'::uuid;
begin
  if exists (
    select 1
    from public.services
    where id <> whitening_service_id
      and lower(trim(name)) = 'limpieza dental'
  ) then
    raise exception 'LIMPIEZA_DENTAL_SERVICE_ALREADY_EXISTS';
  end if;

  update public.services
  set name = 'Limpieza dental'
  where id = whitening_service_id;

  if not found then
    raise exception 'WHITENING_SERVICE_NOT_FOUND';
  end if;
end;
$$;
