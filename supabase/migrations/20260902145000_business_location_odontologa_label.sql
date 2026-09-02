-- Use the professional title requested by the user in the native WhatsApp pin.
-- Coordinates, address and canonical Google Maps Place ID remain unchanged.
update public.app_settings
set business_location_name = 'Consultorio de la Odontóloga Gisela Lentz'
where id = true
  and business_location_name = 'Consultorio de la Dra. Gisela Lentz'
  and business_location_address = 'Calle 11 1375, Miramar, Buenos Aires'
  and business_latitude = -38.2657317
  and business_longitude = -57.8353134
  and business_maps_url =
    'https://www.google.com/maps/search/?api=1&query=Centro%20de%20Atenci%C3%B3n%20Profesional%20%28C.A.P.%29&query_place_id=ChIJK5iJNYYQhZURBREHhxeQ9PQ';
