alter table public.profiles
  add column preserve_inbox_unread boolean not null default false;

comment on column public.profiles.preserve_inbox_unread is
  'When true, opening a conversation from this profile must not clear the shared inbox unread counter.';

-- Conversation unread state is mutated through the RPC below. Removing the
-- legacy column grant prevents an authenticated client from bypassing the
-- observer capability with a direct PostgREST update.
revoke update (unread_count) on public.conversations from authenticated;
revoke update (preserve_inbox_unread) on public.profiles from authenticated;

create or replace function public.mark_conversation_read(
  p_conversation_id uuid
)
returns void
language sql
security definer
set search_path = pg_catalog
as $$
  update public.conversations as conversation
  set unread_count = 0
  where conversation.id = p_conversation_id
    and (
      auth.role() = 'service_role'
      or (
        auth.role() = 'authenticated'
        and exists (
          select 1
          from public.profiles as profile
          where profile.id = auth.uid()
            and profile.active
            and not profile.preserve_inbox_unread
        )
      )
    );
$$;

comment on function public.mark_conversation_read(uuid) is
  'Clears the shared unread counter for active non-observer users; observer profiles are an authoritative no-op.';

revoke execute on function public.mark_conversation_read(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.mark_conversation_read(uuid)
  to authenticated, service_role;
