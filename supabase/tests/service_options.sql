\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(2);

select is(
  (
    select name
    from public.services
    where id = '51000000-0000-4000-8000-000000000006'::uuid
  ),
  'Limpieza dental',
  'the whitening service keeps its id and is shown as Limpieza dental'
);

select ok(
  not exists (
    select 1
    from public.services
    where active
      and lower(trim(name)) = 'blanqueamiento'
  ),
  'the active options no longer include Blanqueamiento'
);

select * from finish();

rollback;
