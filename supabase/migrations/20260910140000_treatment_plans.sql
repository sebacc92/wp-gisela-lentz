-- Plan de tratamiento y presupuesto por paciente.
--
-- Es lo que **se piensa hacer** y cuánto sale, no lo que se encontró. Esa
-- distinción decide todo el diseño:
--
-- - `odontogram_entries` es historia clínica: append-only, sin UPDATE ni
--   DELETE, porque la ley 26.529 la declara inviolable.
-- - `treatment_plan_items` es un presupuesto: cambia de precio, se reordena,
--   se cancela y se completa. Por eso acá sí hay UPDATE y DELETE.
--
-- Un ítem puede citar una pieza, pero no escribe nada en el odontograma:
-- terminar un tratamiento no registra un hallazgo clínico por su cuenta.
-- Sigue siendo sólo de ADMIN, igual que el resto de la ficha clínica.

create type public.treatment_item_status as enum (
  'pending',
  'in_progress',
  'done',
  'cancelled'
);

create table public.treatment_plan_items (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete restrict,
  -- Numeración FDI, igual que el odontograma. Nulo para trabajos que no son
  -- de una pieza puntual (una limpieza, una placa).
  tooth smallint,
  description text not null,
  estimated_cost_ars integer,
  status public.treatment_item_status not null default 'pending',
  sort_order integer not null default 0,
  note text,
  created_by uuid references public.profiles (id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint treatment_plan_items_tooth_check check (
    tooth is null
    or tooth between 11 and 18
    or tooth between 21 and 28
    or tooth between 31 and 38
    or tooth between 41 and 48
    or tooth between 51 and 55
    or tooth between 61 and 65
    or tooth between 71 and 75
    or tooth between 81 and 85
  ),
  constraint treatment_plan_items_description_check check (
    char_length(trim(description)) between 1 and 300
  ),
  constraint treatment_plan_items_note_check check (
    note is null or char_length(note) <= 500
  ),
  constraint treatment_plan_items_cost_check check (
    estimated_cost_ars is null
    or estimated_cost_ars between 0 and 100000000
  ),
  -- Un ítem terminado tiene fecha de término; uno que no lo está, no.
  constraint treatment_plan_items_completed_check check (
    (status = 'done' and completed_at is not null)
    or (status <> 'done' and completed_at is null)
  )
);

create index treatment_plan_items_contact_idx
  on public.treatment_plan_items (contact_id, sort_order, created_at);

create trigger set_treatment_plan_items_updated_at
  before update on public.treatment_plan_items
  for each row execute function public.set_updated_at();

/** Mantiene `completed_at` en línea con el estado sin pedírselo a la interfaz. */
create or replace function public.sync_treatment_item_completion()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'done' and new.completed_at is null then
    new.completed_at := now();
  elsif new.status <> 'done' then
    new.completed_at := null;
  end if;
  return new;
end;
$$;

create trigger treatment_plan_items_completion
  before insert or update on public.treatment_plan_items
  for each row execute function public.sync_treatment_item_completion();

alter table public.treatment_plan_items enable row level security;

create policy treatment_plan_items_admin_read on public.treatment_plan_items
  for select to authenticated
  using (public.current_user_is_admin());

create policy treatment_plan_items_admin_insert on public.treatment_plan_items
  for insert to authenticated
  with check (public.current_user_is_admin() and created_by = auth.uid());

create policy treatment_plan_items_admin_update on public.treatment_plan_items
  for update to authenticated
  using (public.current_user_is_admin())
  with check (public.current_user_is_admin());

create policy treatment_plan_items_admin_delete on public.treatment_plan_items
  for delete to authenticated
  using (public.current_user_is_admin());

grant select, insert, update, delete
  on public.treatment_plan_items to authenticated;
revoke all on public.treatment_plan_items from anon;
