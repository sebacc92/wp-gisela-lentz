create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

create type public.user_role as enum ('ADMIN', 'OPERADOR');
create type public.conversation_status as enum ('open', 'closed');
create type public.automation_mode as enum ('auto', 'manual');
create type public.message_direction as enum ('inbound', 'outbound');
create type public.message_type as enum ('text', 'template', 'interactive', 'image', 'document', 'system');
create type public.message_status as enum ('pending', 'sent', 'delivered', 'read', 'failed');
create type public.appointment_status as enum ('scheduled', 'confirmed', 'cancelled', 'completed', 'no_show');
create type public.appointment_source as enum ('whatsapp', 'manual');
create type public.availability_exception_type as enum ('unavailable', 'available');
create type public.reminder_type as enum ('appointment_24h', 'appointment_2h');
create type public.reminder_status as enum ('pending', 'processing', 'sent', 'failed', 'cancelled');
create type public.webhook_event_status as enum ('pending', 'processed', 'ignored', 'failed');
create type public.whatsapp_integration_status as enum ('incomplete', 'connected', 'error');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null check (char_length(trim(full_name)) between 2 and 120),
  role public.user_role not null default 'OPERADOR',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  whatsapp_id text unique,
  name text not null check (char_length(trim(name)) between 1 and 120),
  whatsapp_opt_in_at timestamptz,
  whatsapp_opt_out_at timestamptz,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  status public.conversation_status not null default 'open',
  assigned_to uuid references public.profiles (id) on delete set null,
  automation_mode public.automation_mode not null default 'auto',
  needs_human boolean not null default false,
  current_flow text,
  last_message_at timestamptz not null default now(),
  last_inbound_message_at timestamptz,
  unread_count integer not null default 0 check (unread_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index conversations_one_open_per_contact_idx
  on public.conversations (contact_id)
  where status = 'open';

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  direction public.message_direction not null,
  whatsapp_message_id text unique,
  type public.message_type not null default 'text',
  body text not null default '',
  template_name text,
  status public.message_status not null default 'pending',
  sent_by uuid references public.profiles (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint messages_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table public.professionals (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  specialty text,
  appointment_duration_minutes integer not null default 30 check (appointment_duration_minutes between 5 and 480),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.availability_rules (
  id uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.professionals (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  slot_minutes integer not null default 30 check (slot_minutes between 5 and 480),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint availability_rules_valid_range check (start_time < end_time),
  unique (professional_id, weekday, start_time, end_time)
);

create table public.availability_exceptions (
  id uuid primary key default gen_random_uuid(),
  professional_id uuid not null references public.professionals (id) on delete cascade,
  date date not null,
  start_time time,
  end_time time,
  type public.availability_exception_type not null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint availability_exceptions_valid_range check (
    (start_time is null and end_time is null)
    or (start_time is not null and end_time is not null and start_time < end_time)
  )
);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete restrict,
  professional_id uuid not null references public.professionals (id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.appointment_status not null default 'scheduled',
  source public.appointment_source not null default 'manual',
  created_by uuid references public.profiles (id) on delete set null,
  internal_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointments_valid_range check (starts_at < ends_at)
);

alter table public.appointments
  add constraint appointments_no_professional_overlap
  exclude using gist (
    professional_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  )
  where (status in ('scheduled', 'confirmed'))
  deferrable initially immediate;

create table public.automation_sessions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null unique references public.conversations (id) on delete cascade,
  state text not null default 'idle',
  context jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_context_object check (jsonb_typeof(context) = 'object')
);

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  type public.reminder_type not null,
  scheduled_at timestamptz not null,
  status public.reminder_status not null default 'pending',
  message_id uuid references public.messages (id) on delete set null,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id, type)
);

create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z][a-z0-9_]*$'),
  meta_name text not null,
  language_code text not null default 'es_AR',
  category text,
  body_preview text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.quick_replies (
  id uuid primary key default gen_random_uuid(),
  shortcut text not null unique check (shortcut ~ '^/[a-z0-9_-]+$'),
  title text not null check (char_length(trim(title)) between 2 and 100),
  body text not null check (char_length(trim(body)) between 1 and 4096),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.app_settings (
  id boolean primary key default true check (id),
  clinic_name text not null default 'COLP',
  timezone text not null default 'America/Argentina/Buenos_Aires',
  reminder_24h_enabled boolean not null default true,
  reminder_24h_minutes integer not null default 1440 check (reminder_24h_minutes between 5 and 10080),
  reminder_2h_enabled boolean not null default false,
  reminder_2h_minutes integer not null default 120 check (reminder_2h_minutes between 5 and 10080),
  updated_at timestamptz not null default now()
);

create table public.whatsapp_settings (
  id boolean primary key default true check (id),
  display_phone text,
  display_name text,
  integration_status public.whatsapp_integration_status not null default 'incomplete',
  last_health_check_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles (id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  external_event_id text not null unique,
  event_type text not null,
  status public.webhook_event_status not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  error text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint webhook_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index messages_conversation_created_idx on public.messages (conversation_id, created_at);
create index messages_contact_created_idx on public.messages (contact_id, created_at);
create index conversations_last_message_idx on public.conversations (last_message_at desc);
create index conversations_attention_idx on public.conversations (needs_human, unread_count, last_message_at desc) where status = 'open';
create index contacts_phone_idx on public.contacts (phone_e164);
create index appointments_starts_at_idx on public.appointments (starts_at);
create index appointments_professional_starts_idx on public.appointments (professional_id, starts_at);
create index appointments_contact_starts_idx on public.appointments (contact_id, starts_at desc);
create index reminders_due_idx on public.reminders (status, scheduled_at) where status in ('pending', 'processing');
create index webhook_events_created_idx on public.webhook_events (created_at);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

insert into public.app_settings (id) values (true);
insert into public.whatsapp_settings (id) values (true);

insert into public.message_templates (key, meta_name, language_code, category, body_preview, enabled)
values
  ('appointment_created', 'appointment_created', 'es_AR', 'UTILITY', 'Tu turno en COLP quedó reservado.', true),
  ('appointment_reminder_24h', 'appointment_reminder_24h', 'es_AR', 'UTILITY', 'Te recordamos tu turno de mañana en COLP.', true),
  ('appointment_reminder_2h', 'appointment_reminder_2h', 'es_AR', 'UTILITY', 'Te recordamos que tu turno en COLP es dentro de dos horas.', false),
  ('appointment_cancelled', 'appointment_cancelled', 'es_AR', 'UTILITY', 'Tu turno en COLP fue cancelado.', true),
  ('appointment_rescheduled', 'appointment_rescheduled', 'es_AR', 'UTILITY', 'Tu turno en COLP fue reprogramado.', true);

insert into public.quick_replies (shortcut, title, body)
values
  ('/horarios', 'Horarios de atención', 'Nuestro horario de atención es de lunes a viernes de 8:00 a 18:00.'),
  ('/ubicacion', 'Ubicación', 'Estamos en La Plata. Si querés, te compartimos la ubicación exacta.'),
  ('/espera', 'En breve te respondemos', 'Recibimos tu mensaje. En breve te responde recepción.');
