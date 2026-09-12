\set ON_ERROR_STOP on

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(9);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

-- Los textos que pidió Gisela después de probar el bot.
select ok(
  (select automation_welcome_message from public.app_settings where id)
    like '%Odontóloga Gisela Lentz%',
  'el saludo la nombra Odontóloga, sin abreviar'
);
select ok(
  (select automation_welcome_message from public.app_settings where id)
    not like '%Dra.%',
  'el saludo ya no usa la abreviatura anterior'
);
select ok(
  (select deposit_request_message_template from public.app_settings where id)
    like '%no se reembolsa%',
  'el pedido de seña deja escrita la política de cancelación'
);
select ok(
  (select deposit_request_message_template from public.app_settings where id)
    like '%{date}%',
  'el pedido de seña nombra el día que se está reservando'
);
select ok(
  (select deposit_confirmed_message_template from public.app_settings where id)
    like '%{address}%',
  'la confirmación recuerda la dirección del consultorio'
);

-- El día, la hora y la dirección son llaves válidas; una inventada no.
select lives_ok(
  $$update public.app_settings
    set deposit_request_message_template =
      'Seña de {deposit_amount} para el turno del {date} a las {time}. Alias {deposit_alias}, titular {deposit_holder}.'
    where id$$,
  'el pedido de seña acepta día y hora además de los datos bancarios'
);
select throws_ok(
  $$update public.app_settings
    set deposit_request_message_template = 'Seña de {deposit_amount} para el {dia}.'
    where id$$,
  '23514',
  null,
  'una llave inventada en el pedido de seña se rechaza'
);
select lives_ok(
  $$update public.app_settings
    set deposit_confirmed_message_template =
      'Turno confirmado para el {date} a las {time}. Te esperamos en {address}.'
    where id$$,
  'la confirmación acepta la dirección configurada'
);
select throws_ok(
  $$update public.app_settings
    set deposit_confirmed_message_template = 'Te esperamos en {direccion}.'
    where id$$,
  '23514',
  null,
  'una llave inventada en la confirmación se rechaza'
);

select * from finish();
rollback;
