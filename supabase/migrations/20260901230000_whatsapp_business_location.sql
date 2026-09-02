-- WhatsApp Cloud API represents a static business pin as a native `location`
-- message. The point is stored explicitly: an address alone is never geocoded
-- or guessed while handling a patient conversation.
alter type public.message_type add value if not exists 'location';

alter table public.app_settings
  add column business_location_name text,
  add column business_location_address text,
  add column business_latitude double precision,
  add column business_longitude double precision,
  add column business_maps_url text,
  add constraint app_settings_business_location_name_check check (
    business_location_name is null
    or char_length(trim(business_location_name)) between 1 and 120
  ),
  add constraint app_settings_business_location_address_check check (
    business_location_address is null
    or char_length(trim(business_location_address)) between 3 and 500
  ),
  add constraint app_settings_business_latitude_check check (
    business_latitude is null
    or (
      business_latitude <> 'NaN'::double precision
      and business_latitude between -90 and 90
    )
  ),
  add constraint app_settings_business_longitude_check check (
    business_longitude is null
    or (
      business_longitude <> 'NaN'::double precision
      and business_longitude between -180 and 180
    )
  ),
  add constraint app_settings_business_maps_url_check check (
    business_maps_url is null
    or (
      char_length(business_maps_url) between 1 and 2048
      and business_maps_url ~
        '^https://www[.]google[.]com/maps/search/[?]api=1&query=[^[:space:]]+&query_place_id=[A-Za-z0-9_-]+$'
    )
  ),
  add constraint app_settings_business_location_complete_check check (
    (
      business_location_name is null
      and business_location_address is null
      and business_latitude is null
      and business_longitude is null
      and business_maps_url is null
    )
    or (
      business_location_name is not null
      and business_location_address is not null
      and business_latitude is not null
      and business_longitude is not null
      and business_maps_url is not null
      and business_address is not null
    )
  );

comment on column public.app_settings.business_location_name is
  'Nombre visible del pin nativo de WhatsApp. Sólo se usa junto con latitud y longitud verificadas.';
comment on column public.app_settings.business_location_address is
  'Dirección breve visible dentro del pin nativo de WhatsApp.';
comment on column public.app_settings.business_latitude is
  'Latitud verificada del acceso al consultorio; nullable para impedir inferencias desde una dirección postal.';
comment on column public.app_settings.business_longitude is
  'Longitud verificada del acceso al consultorio; nullable para impedir inferencias desde una dirección postal.';
comment on column public.app_settings.business_maps_url is
  'URL estable de Google Maps con Place ID, usada como fallback clickeable.';

-- A saved point must not silently survive an address edit. An administrator
-- can preserve a pin by updating the address and all five location fields in
-- the same statement; changing only the address clears the stale coordinates.
create function public.clear_stale_business_location()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.business_address is distinct from old.business_address
    and new.business_location_name is not distinct from old.business_location_name
    and new.business_location_address is not distinct from old.business_location_address
    and new.business_latitude is not distinct from old.business_latitude
    and new.business_longitude is not distinct from old.business_longitude
    and new.business_maps_url is not distinct from old.business_maps_url then
    new.business_location_name := null;
    new.business_location_address := null;
    new.business_latitude := null;
    new.business_longitude := null;
    new.business_maps_url := null;
  end if;
  return new;
end;
$$;

create trigger clear_stale_business_location_before_update
before update of business_address on public.app_settings
for each row execute function public.clear_stale_business_location();

revoke all on function public.clear_stale_business_location()
from public, anon, authenticated, service_role;

-- The user-confirmed Google share link resolves unambiguously to Place ID
-- ChIJK5iJNYYQhZURBREHhxeQ9PQ. Persist the canonical point and a stable Maps
-- URL, never the shortlink. Only the known singleton/address is updated.
update public.app_settings
set
  business_address =
    'Calle 11 1375, Miramar, Provincia de Buenos Aires, Argentina',
  business_location_name = 'Consultorio de la Dra. Gisela Lentz',
  business_location_address = 'Calle 11 1375, Miramar, Buenos Aires',
  business_latitude = -38.2657317,
  business_longitude = -57.8353134,
  business_maps_url =
    'https://www.google.com/maps/search/?api=1&query=Centro%20de%20Atenci%C3%B3n%20Profesional%20%28C.A.P.%29&query_place_id=ChIJK5iJNYYQhZURBREHhxeQ9PQ'
where id = true
  and lower(regexp_replace(trim(business_address), '\s+', ' ', 'g')) in (
    lower('Calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires'),
    lower('Calle 11 1375, Miramar, Provincia de Buenos Aires, Argentina')
  )
  and business_location_name is null
  and business_location_address is null
  and business_latitude is null
  and business_longitude is null
  and business_maps_url is null;

-- Operators who use the existing text quick reply still provide a useful map
-- fallback. Only the known seeded copy is changed, preserving any customized
-- `/ubicacion` response.
update public.quick_replies
set body = E'Mi consultorio está en Calle 11 1375, Miramar, Provincia de Buenos Aires, Argentina.\n\nMapa: https://www.google.com/maps/search/?api=1&query=Centro%20de%20Atenci%C3%B3n%20Profesional%20%28C.A.P.%29&query_place_id=ChIJK5iJNYYQhZURBREHhxeQ9PQ'
where shortcut = '/ubicacion'
  and (
    body = 'Mi consultorio está en calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires.'
    or body like E'Mi consultorio está en calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires.\n\nMapa: https://www.google.com/maps/%'
  );
