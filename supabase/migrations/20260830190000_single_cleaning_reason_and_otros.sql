-- El menú ofrecía "Limpieza" y "Limpieza dental". La segunda es la fila del
-- blanqueamiento renombrada deliberadamente en
-- `20260830180000_rename_whitening_service.sql`, así que la que sobra es el
-- motivo original: queda desactivado, no eliminado, porque puede tener turnos
-- asociados.
update public.services
set active = false
where id = '51000000-0000-4000-8000-000000000003'
  and lower(trim(name)) = 'limpieza';

-- "Otros" da salida a quien no encaja en ninguno de los motivos listados. La
-- duración la sigue definiendo la cobertura del paciente, como en el resto.
insert into public.services (id, name, description, duration_minutes, active, sort_order)
select
  '51000000-0000-4000-8000-000000000009',
  'Otros',
  null,
  30,
  true,
  70
where not exists (
  select 1 from public.services where lower(trim(name)) = 'otros'
);

update public.services
set active = true,
    sort_order = ordered.sort_order
from (values
  ('consulta', 10),
  ('restauraciones', 20),
  ('extracciones', 30),
  ('limpieza dental', 40),
  ('ortopedia y ortodoncia', 50),
  ('otros', 60)
) as ordered(normalized_name, sort_order)
where lower(trim(services.name)) = ordered.normalized_name;
