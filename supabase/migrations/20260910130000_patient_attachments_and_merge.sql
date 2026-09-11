-- Adjuntos de paciente y fusión de fichas duplicadas.
--
-- Dos cosas distintas que comparten una regla: la historia clínica no se toca.
--
-- 1. `patient_attachments` guarda radiografías y documentos. Es información de
--    salud, así que sigue la misma línea que el odontograma: sólo ADMIN, y
--    `anon` no existe. Los bytes viven en Storage; acá queda el índice.
-- 2. `merge_patient_records` une dos fichas administrativas. Se **niega** a
--    fusionar si la ficha duplicada tiene odontograma: reasignar asientos
--    clínicos a otro paciente no es una operación administrativa y la ley
--    26.529 declara inviolable la historia clínica.

-- ---------------------------------------------------------------------------
-- Adjuntos
-- ---------------------------------------------------------------------------

create table public.patient_attachments (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete restrict,
  -- Ruta dentro del bucket privado. Los bytes nunca pasan por esta tabla.
  storage_path text not null unique,
  filename text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0),
  description text,
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint patient_attachments_filename_check check (
    char_length(trim(filename)) between 1 and 200
  ),
  constraint patient_attachments_description_check check (
    description is null or char_length(description) <= 500
  ),
  -- Sólo lo que el visor sabe mostrar y el consultorio realmente usa.
  constraint patient_attachments_mime_check check (
    mime_type in ('image/jpeg', 'image/png', 'application/pdf')
  )
);

create index patient_attachments_contact_idx
  on public.patient_attachments (contact_id, created_at desc);

alter table public.patient_attachments enable row level security;

create policy patient_attachments_admin_read on public.patient_attachments
  for select to authenticated
  using (public.current_user_is_admin());

create policy patient_attachments_admin_insert on public.patient_attachments
  for insert to authenticated
  with check (
    public.current_user_is_admin() and uploaded_by = auth.uid()
  );

create policy patient_attachments_admin_delete on public.patient_attachments
  for delete to authenticated
  using (public.current_user_is_admin());

grant select, insert, delete on public.patient_attachments to authenticated;
revoke all on public.patient_attachments from anon;

-- Bucket privado. `public = false` obliga a pedir una URL firmada con la
-- sesión de quien mira: una radiografía nunca queda accesible por URL suelta.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'patient-attachments',
  'patient-attachments',
  false,
  20971520, -- 20 MB
  array['image/jpeg', 'image/png', 'application/pdf']
)
on conflict (id) do nothing;

create policy patient_attachments_storage_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'patient-attachments' and public.current_user_is_admin()
  );

create policy patient_attachments_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'patient-attachments' and public.current_user_is_admin()
  );

create policy patient_attachments_storage_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'patient-attachments' and public.current_user_is_admin()
  );

-- ---------------------------------------------------------------------------
-- Fusión de fichas
-- ---------------------------------------------------------------------------

alter table public.contacts
  add column merged_into_contact_id uuid
    references public.contacts (id) on delete set null,
  add column merged_at timestamptz,
  add constraint contacts_merge_consistency_check check (
    (merged_into_contact_id is null and merged_at is null)
    or (merged_into_contact_id is not null and merged_at is not null)
  ),
  add constraint contacts_merge_not_self_check check (
    merged_into_contact_id is null or merged_into_contact_id <> id
  );

create index contacts_merged_into_idx
  on public.contacts (merged_into_contact_id)
  where merged_into_contact_id is not null;

/**
 * Une dos fichas administrativas bajo `p_primary_id`.
 *
 * No borra nada: la ficha duplicada queda marcada como fusionada y conserva su
 * fila, así cualquier referencia histórica sigue resolviendo. Mueve turnos,
 * mensajes y conversaciones, y deja asiento en `audit_logs`.
 *
 * Sólo hay una conversación abierta por contacto, así que si ambas fichas
 * tienen una, la del duplicado se cierra antes de reasignarla en lugar de
 * romper el índice.
 */
create or replace function public.merge_patient_records(
  p_primary_id uuid,
  p_duplicate_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  moved_appointments integer := 0;
  moved_messages integer := 0;
  moved_conversations integer := 0;
  clinical_entries integer := 0;
  primary_has_open boolean := false;
begin
  if not public.current_user_is_admin() then
    raise exception 'PATIENT_MERGE_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_primary_id is null or p_duplicate_id is null
    or p_primary_id = p_duplicate_id then
    raise exception 'PATIENT_MERGE_INVALID_PAIR' using errcode = '22023';
  end if;

  -- Orden estable de bloqueo: dos fusiones simultáneas no se traban entre sí.
  perform 1 from public.contacts
  where id in (p_primary_id, p_duplicate_id)
  order by id
  for update;

  if not exists (select 1 from public.contacts where id = p_primary_id) then
    raise exception 'PATIENT_MERGE_PRIMARY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.contacts where id = p_duplicate_id) then
    raise exception 'PATIENT_MERGE_DUPLICATE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.contacts
    where id = p_duplicate_id and merged_into_contact_id is not null
  ) then
    raise exception 'PATIENT_MERGE_ALREADY_MERGED' using errcode = '22023';
  end if;

  select count(*) into clinical_entries
  from public.odontogram_entries
  where contact_id = p_duplicate_id;

  -- La historia clínica no se reasigna. Se corta antes de mover nada.
  if clinical_entries > 0 then
    raise exception 'PATIENT_MERGE_CLINICAL_HISTORY' using errcode = '42501';
  end if;

  update public.appointments set contact_id = p_primary_id
  where contact_id = p_duplicate_id;
  get diagnostics moved_appointments = row_count;

  update public.messages set contact_id = p_primary_id
  where contact_id = p_duplicate_id;
  get diagnostics moved_messages = row_count;

  select exists (
    select 1 from public.conversations
    where contact_id = p_primary_id and status = 'open'
  ) into primary_has_open;

  if primary_has_open then
    update public.conversations
    set status = 'closed'
    where contact_id = p_duplicate_id and status = 'open';
  end if;

  update public.conversations set contact_id = p_primary_id
  where contact_id = p_duplicate_id;
  get diagnostics moved_conversations = row_count;

  update public.contacts
  set merged_into_contact_id = p_primary_id,
      merged_at = now()
  where id = p_duplicate_id;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    auth.uid(),
    'patient_records_merged',
    'contact',
    p_primary_id,
    jsonb_build_object(
      'duplicate_contact_id', p_duplicate_id,
      'moved_appointments', moved_appointments,
      'moved_messages', moved_messages,
      'moved_conversations', moved_conversations
    )
  );

  return jsonb_build_object(
    'primaryContactId', p_primary_id,
    'duplicateContactId', p_duplicate_id,
    'movedAppointments', moved_appointments,
    'movedMessages', moved_messages,
    'movedConversations', moved_conversations
  );
end;
$$;

revoke all on function public.merge_patient_records(uuid, uuid) from public;
grant execute on function public.merge_patient_records(uuid, uuid) to authenticated;
