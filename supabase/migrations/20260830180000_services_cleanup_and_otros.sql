-- El motivo "Blanqueamiento" quedó renombrado como "Limpieza dental" al
-- editarlo desde Configuración, así que el menú mostraba dos opciones de
-- limpieza y perdía el blanqueamiento. Se restaura sobre la misma fila para no
-- crear un motivo nuevo ni perder los turnos que la referencien.
update public.services
set name = 'Blanqueamiento'
where id = '51000000-0000-4000-8000-000000000006'
  and lower(trim(name)) = 'limpieza dental'
  and not exists (
    select 1
    from public.services other
    where other.id <> '51000000-0000-4000-8000-000000000006'
      and lower(trim(other.name)) = 'blanqueamiento'
  );

-- "Otros" da salida a quien no encaja en ninguno de los motivos listados. La
-- duración la sigue definiendo la cobertura, como el resto.
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
  ('limpieza', 40),
  ('blanqueamiento', 50),
  ('ortopedia y ortodoncia', 60),
  ('otros', 70)
) as ordered(normalized_name, sort_order)
where lower(trim(services.name)) = ordered.normalized_name;
