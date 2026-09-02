\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(11);

select ok(
  exists (
    select 1
    from pg_catalog.pg_enum enum_value
    join pg_catalog.pg_type enum_type on enum_type.oid = enum_value.enumtypid
    join pg_catalog.pg_namespace namespace on namespace.oid = enum_type.typnamespace
    where namespace.nspname = 'public'
      and enum_type.typname = 'message_type'
      and enum_value.enumlabel = 'location'
  ),
  'messages can persist the native WhatsApp location type'
);

select ok(
  (
    select count(*) = 5 and bool_and(is_nullable = 'YES')
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'app_settings'
      and column_name in (
        'business_location_name',
        'business_location_address',
        'business_latitude',
        'business_longitude',
        'business_maps_url'
      )
  ),
  'the verified business pin is an optional five-column configuration'
);

select ok(
  (
    select business_address =
        'Calle 11 1375, Miramar, Provincia de Buenos Aires, Argentina'
      and business_location_name = 'Consultorio de la Dra. Gisela Lentz'
      and business_location_address =
        'Calle 11 1375, Miramar, Buenos Aires'
      and business_latitude = -38.2657317::double precision
      and business_longitude = -57.8353134::double precision
      and business_maps_url =
        'https://www.google.com/maps/search/?api=1&query=Centro%20de%20Atenci%C3%B3n%20Profesional%20%28C.A.P.%29&query_place_id=ChIJK5iJNYYQhZURBREHhxeQ9PQ'
    from public.app_settings
    where id = true
  ),
  'the exact configured Miramar address receives only its verified map point'
);

select ok(
  (
    select position(
      'https://www.google.com/maps/search/?api=1&query=Centro%20de%20Atenci%C3%B3n%20Profesional%20%28C.A.P.%29&query_place_id=ChIJK5iJNYYQhZURBREHhxeQ9PQ'
      in body
    ) > 0
    from public.quick_replies
    where shortcut = '/ubicacion'
  ),
  'the seeded manual location reply includes the exact map fallback'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.clear_stale_business_location()',
    'EXECUTE'
  ),
  'authenticated users cannot invoke the stale-pin trigger function directly'
);

update public.app_settings
set business_address = 'Dirección temporal de prueba'
where id = true;

select ok(
  (
    select business_location_name is null
      and business_location_address is null
      and business_latitude is null
      and business_longitude is null
      and business_maps_url is null
    from public.app_settings
    where id = true
  ),
  'editing only the address clears the previously verified point'
);

select throws_ok(
  $$update public.app_settings
    set business_location_name = 'Pin incompleto',
        business_latitude = -38.2
    where id = true$$,
  '23514',
  null,
  'a partial location configuration is rejected'
);

select throws_ok(
  $$update public.app_settings
    set business_location_name = 'Fuera de rango',
        business_location_address = 'Dirección breve',
        business_latitude = 91,
        business_longitude = -57.8,
        business_maps_url =
          'https://www.google.com/maps/search/?api=1&query=prueba&query_place_id=ChIJprueba'
    where id = true$$,
  '23514',
  null,
  'latitude outside the geographic range is rejected'
);

select throws_ok(
  $$update public.app_settings
    set business_location_name = 'No numérico',
        business_location_address = 'Dirección breve',
        business_latitude = 'NaN'::double precision,
        business_longitude = -57.8,
        business_maps_url =
          'https://www.google.com/maps/search/?api=1&query=prueba&query_place_id=ChIJprueba'
    where id = true$$,
  '23514',
  null,
  'NaN cannot be stored as a business coordinate'
);

select throws_ok(
  $$update public.app_settings
    set business_location_name = 'URL insegura',
        business_location_address = 'Dirección breve',
        business_latitude = -38.2,
        business_longitude = -57.8,
        business_maps_url = 'https://share.google/shortlink'
    where id = true$$,
  '23514',
  null,
  'a shortlink cannot replace the stable Google Maps URL'
);

update public.app_settings
set
  business_address = 'Dirección verificada de prueba',
  business_location_name = 'Acceso principal',
  business_location_address = 'Acceso por Calle 11',
  business_latitude = -38.25,
  business_longitude = -57.84,
  business_maps_url =
    'https://www.google.com/maps/search/?api=1&query=prueba&query_place_id=ChIJprueba'
where id = true;

select ok(
  (
    select business_address = 'Dirección verificada de prueba'
      and business_location_name = 'Acceso principal'
      and business_location_address = 'Acceso por Calle 11'
      and business_latitude = -38.25::double precision
      and business_longitude = -57.84::double precision
      and business_maps_url =
        'https://www.google.com/maps/search/?api=1&query=prueba&query_place_id=ChIJprueba'
    from public.app_settings
    where id = true
  ),
  'an address and its complete verified point can be updated atomically'
);

select * from finish();

rollback;
