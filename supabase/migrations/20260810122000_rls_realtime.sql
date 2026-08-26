create or replace function public.current_user_is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and active
  );
$$;

create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and active and role = 'ADMIN'
  );
$$;

alter table public.profiles enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.professionals enable row level security;
alter table public.availability_rules enable row level security;
alter table public.availability_exceptions enable row level security;
alter table public.appointments enable row level security;
alter table public.automation_sessions enable row level security;
alter table public.reminders enable row level security;
alter table public.message_templates enable row level security;
alter table public.quick_replies enable row level security;
alter table public.app_settings enable row level security;
alter table public.whatsapp_settings enable row level security;
alter table public.audit_logs enable row level security;
alter table public.webhook_events enable row level security;

create policy profiles_read on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.current_user_is_admin());

create policy profiles_admin_update on public.profiles
  for update to authenticated
  using (public.current_user_is_admin())
  with check (public.current_user_is_admin());

create policy contacts_read on public.contacts
  for select to authenticated
  using (public.current_user_is_active());
create policy contacts_insert on public.contacts
  for insert to authenticated
  with check (public.current_user_is_active());
create policy contacts_update on public.contacts
  for update to authenticated
  using (public.current_user_is_active())
  with check (public.current_user_is_active());

create policy conversations_read on public.conversations
  for select to authenticated
  using (public.current_user_is_active());
create policy conversations_insert on public.conversations
  for insert to authenticated
  with check (public.current_user_is_active());
create policy conversations_update on public.conversations
  for update to authenticated
  using (public.current_user_is_active())
  with check (public.current_user_is_active());

create policy messages_read on public.messages
  for select to authenticated
  using (public.current_user_is_active());

create policy professionals_read on public.professionals
  for select to authenticated
  using (public.current_user_is_active());
create policy professionals_admin_insert on public.professionals
  for insert to authenticated
  with check (public.current_user_is_admin());
create policy professionals_admin_update on public.professionals
  for update to authenticated
  using (public.current_user_is_admin())
  with check (public.current_user_is_admin());

create policy availability_rules_read on public.availability_rules
  for select to authenticated
  using (public.current_user_is_active());
create policy availability_rules_admin_insert on public.availability_rules
  for insert to authenticated
  with check (public.current_user_is_admin());
create policy availability_rules_admin_update on public.availability_rules
  for update to authenticated
  using (public.current_user_is_admin())
  with check (public.current_user_is_admin());
create policy availability_rules_admin_delete on public.availability_rules
  for delete to authenticated
  using (public.current_user_is_admin());

create policy availability_exceptions_read on public.availability_exceptions
  for select to authenticated
  using (public.current_user_is_active());
create policy availability_exceptions_admin_insert on public.availability_exceptions
  for insert to authenticated
  with check (public.current_user_is_admin());
create policy availability_exceptions_admin_update on public.availability_exceptions
  for update to authenticated
  using (public.current_user_is_admin())
  with check (public.current_user_is_admin());
create policy availability_exceptions_admin_delete on public.availability_exceptions
  for delete to authenticated
  using (public.current_user_is_admin());

create policy appointments_read on public.appointments
  for select to authenticated
  using (public.current_user_is_active());

create policy automation_sessions_read on public.automation_sessions
  for select to authenticated
  using (public.current_user_is_active());

create policy reminders_read on public.reminders
  for select to authenticated
  using (public.current_user_is_active());

create policy templates_read on public.message_templates
  for select to authenticated
  using (public.current_user_is_active());
create policy templates_admin_insert on public.message_templates
  for insert to authenticated
  with check (public.current_user_is_admin());
create policy templates_admin_update on public.message_templates
  for update to authenticated
  using (public.current_user_is_admin())
  with check (public.current_user_is_admin());

create policy quick_replies_read on public.quick_replies
  for select to authenticated
  using (public.current_user_is_active());
create policy quick_replies_admin_insert on public.quick_replies
  for insert to authenticated
  with check (public.current_user_is_admin());
create policy quick_replies_admin_update on public.quick_replies
  for update to authenticated
  using (public.current_user_is_admin())
  with check (public.current_user_is_admin());

create policy app_settings_read on public.app_settings
  for select to authenticated
  using (public.current_user_is_active());
create policy app_settings_admin_update on public.app_settings
  for update to authenticated
  using (public.current_user_is_admin())
  with check (public.current_user_is_admin());

create policy whatsapp_settings_read on public.whatsapp_settings
  for select to authenticated
  using (public.current_user_is_active());

create policy audit_logs_admin_read on public.audit_logs
  for select to authenticated
  using (public.current_user_is_admin());

create policy webhook_events_admin_read on public.webhook_events
  for select to authenticated
  using (public.current_user_is_admin());

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

grant usage on schema public to authenticated, service_role;

grant select on public.profiles to authenticated;
grant update (full_name, role, active) on public.profiles to authenticated;

grant select, insert on public.contacts to authenticated;
grant update (name, phone_e164, whatsapp_opt_in_at, whatsapp_opt_out_at) on public.contacts to authenticated;

grant select, insert on public.conversations to authenticated;
grant update (status, assigned_to, automation_mode, needs_human, current_flow, unread_count) on public.conversations to authenticated;

grant select on public.messages to authenticated;

grant select, insert, update, delete on public.professionals to authenticated;
grant select, insert, update, delete on public.availability_rules to authenticated;
grant select, insert, update, delete on public.availability_exceptions to authenticated;

grant select on public.appointments to authenticated;
grant select on public.automation_sessions to authenticated;
grant select on public.reminders to authenticated;

grant select, insert, update on public.message_templates to authenticated;
grant select, insert, update on public.quick_replies to authenticated;
grant select, update on public.app_settings to authenticated;
grant select on public.whatsapp_settings to authenticated;
grant select on public.audit_logs to authenticated;
grant select on public.webhook_events to authenticated;

grant all on all tables in schema public to service_role;

revoke execute on function public.get_or_create_open_conversation(uuid) from public, anon, authenticated;
revoke execute on function public.claim_due_reminders(integer) from public, anon, authenticated;
revoke execute on function public.cleanup_webhook_events(integer) from public, anon, authenticated;

grant execute on function public.current_user_is_active() to authenticated;
grant execute on function public.current_user_is_admin() to authenticated;
grant execute on function public.mark_conversation_read(uuid) to authenticated, service_role;
grant execute on function public.get_available_slots(uuid, date, text, integer) to authenticated, service_role;
grant execute on function public.create_appointment(uuid, uuid, timestamptz, public.appointment_source, text) to authenticated, service_role;
grant execute on function public.update_appointment_status(uuid, public.appointment_status) to authenticated, service_role;
grant execute on function public.reschedule_appointment(uuid, timestamptz) to authenticated, service_role;
grant execute on function public.get_or_create_open_conversation(uuid) to service_role;
grant execute on function public.claim_due_reminders(integer) to service_role;
grant execute on function public.cleanup_webhook_events(integer) to service_role;

alter table public.messages replica identity full;
alter table public.conversations replica identity full;
alter table public.appointments replica identity full;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['messages', 'conversations', 'appointments']
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end;
$$;
