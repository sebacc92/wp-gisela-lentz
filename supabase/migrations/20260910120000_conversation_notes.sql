-- Notas internas por conversación.
--
-- Son anotaciones del equipo sobre un chat: "llamó y reprogramó", "pidió
-- factura", "es la mamá de un paciente". Nunca salen hacia el paciente.
--
-- Tres reglas sostienen eso:
--
-- 1. La automatización no las lee ni las envía. WhatsApp sólo transmite lo que
--    se escribe en `messages`; estas notas viven en otra tabla justamente para
--    que ningún flujo de envío pueda confundirlas con un mensaje.
--    `conversation-notes-isolation-contract.test.ts` falla si alguna Function
--    llega a nombrar esta tabla.
-- 2. No son historia clínica. Si hace falta registrar algo clínico va al
--    odontograma, que es append-only y sólo de ADMIN. Acá se guarda gestión
--    administrativa, y por eso sí se pueden corregir y borrar.
-- 3. `anon` no tiene ningún permiso.

create table public.conversation_notes (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null
    references public.conversations (id) on delete cascade,
  -- Si se desactiva a la persona, la nota queda: el contexto sigue sirviendo
  -- aunque ya no esté quien la escribió.
  author_id uuid references public.profiles (id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversation_notes_body_check check (
    char_length(trim(body)) between 1 and 2000
  )
);

create index conversation_notes_conversation_idx
  on public.conversation_notes (conversation_id, created_at desc);

create trigger set_conversation_notes_updated_at
  before update on public.conversation_notes
  for each row execute function public.set_updated_at();

alter table public.conversation_notes enable row level security;

-- Todo el equipo activo lee y escribe: la nota existe para coordinarse.
create policy conversation_notes_read on public.conversation_notes
  for select to authenticated
  using (public.current_user_is_active());

create policy conversation_notes_insert on public.conversation_notes
  for insert to authenticated
  with check (
    public.current_user_is_active() and author_id = auth.uid()
  );

-- Corregir y borrar queda para quien la escribió; ADMIN puede además limpiar
-- una nota ajena que no corresponda.
create policy conversation_notes_update on public.conversation_notes
  for update to authenticated
  using (
    public.current_user_is_active()
    and (author_id = auth.uid() or public.current_user_is_admin())
  )
  with check (
    public.current_user_is_active()
    and (author_id = auth.uid() or public.current_user_is_admin())
  );

create policy conversation_notes_delete on public.conversation_notes
  for delete to authenticated
  using (
    public.current_user_is_active()
    and (author_id = auth.uid() or public.current_user_is_admin())
  );

grant select, insert, update, delete on public.conversation_notes to authenticated;
revoke all on public.conversation_notes from anon;
