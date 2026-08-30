-- La configuración inicial siguió al pie de la letra los motivos que Gisela
-- enumeró y dejó "Consulta" desactivada. Falta: es la puerta de entrada para
-- quien todavía no sabe qué necesita, así que vuelve y encabeza la lista.
--
-- La fila ya existe desactivada desde la instalación del esquema; se reactiva
-- en lugar de crear una nueva para no dejar dos motivos con el mismo nombre ni
-- perder los turnos que puedan referenciarla.
insert into public.services (id, name, description, duration_minutes, active, sort_order)
select
  '51000000-0000-4000-8000-000000000001',
  'Consulta',
  null,
  30,
  true,
  10
where not exists (
  select 1 from public.services where lower(trim(name)) = 'consulta'
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
  ('ortopedia y ortodoncia', 60)
) as ordered(normalized_name, sort_order)
where lower(trim(services.name)) = ordered.normalized_name;
