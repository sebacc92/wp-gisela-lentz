-- Odontograma por paciente. Es el primer dato de salud que guarda la
-- aplicación, así que no se apoya en las políticas administrativas existentes:
--
-- 1. Sólo ADMIN. El rol OPERADOR gestiona turnos y mensajes y no ve nada
--    clínico, ni siquiera de lectura.
-- 2. Append-only. Cada asiento es el estado de una pieza en un momento; una
--    corrección es un asiento nuevo. No hay UPDATE ni DELETE, ni por política
--    ni por permiso: la ley 26.529 declara inviolable la historia clínica y un
--    registro que se puede pisar no lo es.
-- 3. La automatización no lo toca. El bot nunca lee ni envía estos datos.

create type public.tooth_condition as enum (
  'sano',
  'caries',
  'obturado',
  'sellante',
  'fracturado',
  'endodoncia',
  'corona',
  'protesis',
  'implante',
  'extraccion_indicada',
  'ausente'
);

-- Palatina en el maxilar superior, lingual en el inferior: es la misma cara y
-- se guarda con un solo valor para no duplicar el vocabulario.
create type public.tooth_surface as enum (
  'oclusal',
  'mesial',
  'distal',
  'vestibular',
  'palatina_lingual'
);

/** Las caras sólo admiten hallazgos localizables. Una corona o una ausencia son
 * de la pieza entera y no se registran por cara. */
create or replace function public.valid_odontogram_surfaces(p_surfaces jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $$
  select jsonb_typeof(coalesce(p_surfaces, 'null'::jsonb)) = 'object'
    and not exists (
      select 1
      from jsonb_each_text(p_surfaces) as surface(key, value)
      where surface.key not in (
          'oclusal', 'mesial', 'distal', 'vestibular', 'palatina_lingual'
        )
        or surface.value not in (
          'caries', 'obturado', 'sellante', 'fracturado'
        )
    );
$$;

create table public.odontogram_entries (
  id uuid primary key default gen_random_uuid(),
  -- El orden de la historia no puede depender del reloj: `now()` devuelve la
  -- hora de la transacción, así que dos asientos consecutivos comparten
  -- timestamp. La secuencia da un orden total y es la que define qué asiento
  -- está vigente.
  entry_sequence bigint generated always as identity,
  contact_id uuid not null references public.contacts (id) on delete restrict,
  -- Numeración FDI: permanentes 11-18/21-28/31-38/41-48 y temporarias
  -- 51-55/61-65/71-75/81-85. Gisela hace ortopedia y ortodoncia, así que la
  -- dentición temporal no es opcional.
  tooth smallint not null,
  condition public.tooth_condition not null,
  surfaces jsonb not null default '{}'::jsonb,
  note text,
  recorded_by uuid references public.profiles (id) on delete set null,
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint odontogram_entries_tooth_check check (
    tooth between 11 and 18
    or tooth between 21 and 28
    or tooth between 31 and 38
    or tooth between 41 and 48
    or tooth between 51 and 55
    or tooth between 61 and 65
    or tooth between 71 and 75
    or tooth between 81 and 85
  ),
  constraint odontogram_entries_surfaces_check check (
    public.valid_odontogram_surfaces(surfaces)
  ),
  -- Una pieza que no está, o que es una prótesis o un implante, no tiene caras
  -- que describir. Una pieza sana tampoco tiene hallazgos.
  constraint odontogram_entries_whole_tooth_check check (
    condition not in ('ausente', 'implante', 'protesis', 'sano')
    or surfaces = '{}'::jsonb
  ),
  constraint odontogram_entries_note_length_check check (
    note is null or char_length(trim(note)) between 1 and 2000
  )
);

create unique index odontogram_entries_sequence_idx
  on public.odontogram_entries (entry_sequence);
create index odontogram_entries_contact_tooth_idx
  on public.odontogram_entries (contact_id, tooth, entry_sequence desc);
create index odontogram_entries_recorded_idx
  on public.odontogram_entries (recorded_at desc);

/** Estado vigente: el último asiento de cada pieza. El historial completo sigue
 * disponible en la tabla, que es la fuente de verdad. */
create view public.odontogram_current
with (security_invoker = true)
as
select distinct on (entry.contact_id, entry.tooth)
  entry.id,
  entry.entry_sequence,
  entry.contact_id,
  entry.tooth,
  entry.condition,
  entry.surfaces,
  entry.note,
  entry.recorded_by,
  entry.recorded_at
from public.odontogram_entries entry
order by entry.contact_id, entry.tooth, entry.entry_sequence desc;

alter table public.odontogram_entries enable row level security;

create policy odontogram_entries_admin_read on public.odontogram_entries
  for select to authenticated
  using (public.current_user_is_admin());

create policy odontogram_entries_admin_insert on public.odontogram_entries
  for insert to authenticated
  with check (
    public.current_user_is_admin()
    and recorded_by = auth.uid()
  );

-- Deliberadamente no existen políticas de UPDATE ni DELETE.
revoke all on public.odontogram_entries from public, anon, authenticated;
grant select, insert on public.odontogram_entries to authenticated;
revoke all on public.odontogram_current from public, anon, authenticated;
grant select on public.odontogram_current to authenticated;
grant all on public.odontogram_entries to service_role;

revoke execute on function public.valid_odontogram_surfaces(jsonb)
  from public, anon;
grant execute on function public.valid_odontogram_surfaces(jsonb)
  to authenticated, service_role;

/** El asiento se fecha en el servidor: una historia clínica cuya cronología la
 * fija el cliente no sirve como registro. */
create or replace function public.stamp_odontogram_entry()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- clock_timestamp() avanza dentro de la transacción; now() no.
  new.recorded_at := clock_timestamp();
  new.created_at := clock_timestamp();

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(),
    'odontogram.entry_recorded',
    'contact',
    new.contact_id,
    jsonb_build_object(
      'tooth', new.tooth,
      'condition', new.condition,
      'surfaces', new.surfaces
    )
  );
  return new;
end;
$$;

create trigger stamp_odontogram_entry
  before insert on public.odontogram_entries
  for each row execute function public.stamp_odontogram_entry();

revoke execute on function public.stamp_odontogram_entry()
  from public, anon, authenticated, service_role;

comment on table public.odontogram_entries is
  'Historia clínica odontológica por pieza. Append-only y sólo accesible por ADMIN. La automatización de WhatsApp nunca lee ni envía estos datos.';
