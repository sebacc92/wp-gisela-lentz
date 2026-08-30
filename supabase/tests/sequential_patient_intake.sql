\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(2);

select is(
  (select automation_welcome_message from public.app_settings where id = true),
  'Hola!!!☺️ Gracias por comunicarte con el Consultorio Odontológico Lentz Gisela. Para agendar tu turno envíanos:',
  'the configured welcome is the exact short greeting'
);

select ok(
  not exists (
    select 1
    from public.app_settings
    where id = true
      and automation_welcome_message ~* E'(nombre y apellido|sos paciente|teléfono de contacto|ioma|particular|\\n|(^|[^0-9])[1-4][.)])'
  ),
  'the welcome does not include the former four-item intake list'
);

select * from finish();

rollback;
