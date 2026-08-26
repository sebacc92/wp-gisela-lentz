-- Durable ingestion primitives for WhatsApp Business App Coexistence.
--
-- Webhook requests only enqueue authenticated changes. A separate worker
-- claims them and calls the service-role-only RPCs below. History, app-state
-- contacts and message echoes therefore never use the live inbound pipeline
-- nor the policy gate intended to authorize a new outbound Graph API send.

-- Meta can omit the user's phone number once usernames/BSUID privacy applies.
-- Keep legacy phone identifiers when supplied, but make the portfolio-scoped
-- user ID a first-class identity instead of inventing a placeholder phone.
alter table public.contacts
  alter column phone_e164 drop not null,
  add column whatsapp_user_id text,
  add constraint contacts_whatsapp_user_id_check check (
    whatsapp_user_id is null
    or (
      char_length(whatsapp_user_id) between 1 and 256
      and whatsapp_user_id ~ '^[A-Za-z0-9.]+$'
    )
  ),
  add constraint contacts_whatsapp_identity_check check (
    phone_e164 is not null or whatsapp_user_id is not null
  );

create unique index contacts_whatsapp_user_id_idx
  on public.contacts (whatsapp_user_id)
  where whatsapp_user_id is not null;

create table public.whatsapp_coexistence_accounts (
  id uuid primary key default gen_random_uuid(),
  waba_id text not null,
  phone_number_id text not null,
  display_phone text,
  coexistence_status text not null default 'pending',
  sync_status text not null default 'idle',
  sync_started_at timestamptz,
  sync_completed_at timestamptz,
  history_sync_status text not null default 'idle',
  history_sync_generation_id uuid not null default gen_random_uuid(),
  history_sync_progress numeric(6, 3),
  history_request_id text,
  history_requested_at timestamptz,
  history_sync_started_at timestamptz,
  history_sync_completed_at timestamptz,
  history_sync_error text,
  app_state_sync_status text not null default 'idle',
  app_state_sync_generation_id uuid not null default gen_random_uuid(),
  app_state_sync_progress numeric(6, 3),
  app_state_sync_request_id text,
  app_state_sync_requested_at timestamptz,
  app_state_sync_started_at timestamptz,
  app_state_sync_completed_at timestamptz,
  app_state_sync_error text,
  last_sync_error text,
  last_webhook_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_coexistence_accounts_waba_id_check check (
    waba_id ~ '^[0-9]{5,64}$'
  ),
  constraint whatsapp_coexistence_accounts_phone_number_id_check check (
    phone_number_id ~ '^[0-9]{5,64}$'
  ),
  constraint whatsapp_coexistence_accounts_display_phone_check check (
    display_phone is null or char_length(trim(display_phone)) between 5 and 40
  ),
  constraint whatsapp_coexistence_accounts_status_check check (
    coexistence_status in (
      'pending', 'onboarding', 'active', 'paused', 'disconnected', 'error'
    )
  ),
  constraint whatsapp_coexistence_accounts_sync_status_check check (
    sync_status in (
      'idle', 'pending', 'in_progress', 'partial', 'completed', 'failed'
    )
  ),
  constraint whatsapp_coexistence_accounts_stream_status_check check (
    history_sync_status in (
      'idle', 'pending', 'in_progress', 'partial', 'completed', 'failed'
    )
    and app_state_sync_status in (
      'idle', 'pending', 'in_progress', 'partial', 'completed', 'failed'
    )
  ),
  constraint whatsapp_coexistence_accounts_progress_check check (
    (history_sync_progress is null or history_sync_progress between 0 and 100)
    and (
      app_state_sync_progress is null
      or app_state_sync_progress between 0 and 100
    )
  ),
  constraint whatsapp_coexistence_accounts_request_ids_check check (
    (
      history_request_id is null
      or char_length(trim(history_request_id)) between 1 and 240
    )
    and (
      app_state_sync_request_id is null
      or char_length(trim(app_state_sync_request_id)) between 1 and 240
    )
  ),
  constraint whatsapp_coexistence_accounts_metadata_object check (
    jsonb_typeof(metadata) = 'object'
  ),
  unique (waba_id, phone_number_id),
  unique (phone_number_id)
);

create trigger set_whatsapp_coexistence_accounts_updated_at
  before update on public.whatsapp_coexistence_accounts
  for each row execute function public.set_updated_at();

create table public.whatsapp_coexistence_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references public.whatsapp_coexistence_accounts (id) on delete cascade,
  external_event_id text not null unique,
  field text not null,
  sync_generation_id uuid,
  payload jsonb not null,
  payload_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  cursor jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  max_attempts integer not null default 12,
  available_at timestamptz not null default now(),
  processing_started_at timestamptz,
  lease_expires_at timestamptz,
  lease_token uuid,
  processed_at timestamptz,
  failed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_coexistence_events_external_id_check check (
    char_length(trim(external_event_id)) between 8 and 240
  ),
  constraint whatsapp_coexistence_events_field_check check (
    field in (
      'messages', 'history', 'smb_app_state_sync', 'smb_message_echoes'
    )
  ),
  constraint whatsapp_coexistence_events_generation_check check (
    (
      field in ('history', 'smb_app_state_sync')
      and sync_generation_id is not null
    )
    or (
      field in ('messages', 'smb_message_echoes')
      and sync_generation_id is null
    )
  ),
  constraint whatsapp_coexistence_events_payload_object check (
    jsonb_typeof(payload) = 'object'
  ),
  constraint whatsapp_coexistence_events_payload_hash_check check (
    payload_hash ~ '^[0-9a-f]{32}$'
  ),
  constraint whatsapp_coexistence_events_metadata_object check (
    jsonb_typeof(metadata) = 'object'
  ),
  constraint whatsapp_coexistence_events_cursor_object check (
    jsonb_typeof(cursor) = 'object'
  ),
  constraint whatsapp_coexistence_events_status_check check (
    status in ('pending', 'processing', 'processed', 'failed')
  ),
  constraint whatsapp_coexistence_events_attempts_check check (
    attempts between 0 and 100 and max_attempts between 1 and 100
  ),
  constraint whatsapp_coexistence_events_lease_check check (
    (
      status = 'processing'
      and processing_started_at is not null
      and lease_expires_at is not null
      and lease_token is not null
    )
    or (
      status <> 'processing'
      and processing_started_at is null
      and lease_expires_at is null
      and lease_token is null
    )
  )
);

create index whatsapp_coexistence_events_claim_idx
  on public.whatsapp_coexistence_events (available_at, created_at)
  where status = 'pending';
create index whatsapp_coexistence_events_stale_lease_idx
  on public.whatsapp_coexistence_events (lease_expires_at)
  where status = 'processing';
create index whatsapp_coexistence_events_account_created_idx
  on public.whatsapp_coexistence_events (account_id, created_at desc);
create index whatsapp_coexistence_events_generation_status_idx
  on public.whatsapp_coexistence_events (
    account_id, field, sync_generation_id, status
  );

create trigger set_whatsapp_coexistence_events_updated_at
  before update on public.whatsapp_coexistence_events
  for each row execute function public.set_updated_at();

create table public.whatsapp_coexistence_sync_batches (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references public.whatsapp_coexistence_accounts (id) on delete cascade,
  event_id uuid not null references public.whatsapp_coexistence_events (id)
    on delete restrict,
  sync_generation_id uuid not null,
  external_batch_id text not null,
  sync_type text not null,
  phase text,
  chunk_order integer,
  progress numeric(6, 3),
  status text not null default 'processing',
  item_count integer not null default 0,
  processed_count integer not null default 0,
  failed_count integer not null default 0,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  first_received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_coexistence_sync_batches_external_id_check check (
    char_length(trim(external_batch_id)) between 1 and 240
  ),
  constraint whatsapp_coexistence_sync_batches_type_check check (
    sync_type in ('history', 'smb_app_state_sync')
  ),
  constraint whatsapp_coexistence_sync_batches_phase_check check (
    phase is null or char_length(trim(phase)) between 1 and 80
  ),
  constraint whatsapp_coexistence_sync_batches_chunk_check check (
    chunk_order is null or chunk_order >= 0
  ),
  constraint whatsapp_coexistence_sync_batches_progress_check check (
    progress is null or progress between 0 and 100
  ),
  constraint whatsapp_coexistence_sync_batches_status_check check (
    status in ('pending', 'processing', 'completed', 'failed')
  ),
  constraint whatsapp_coexistence_sync_batches_counts_check check (
    item_count >= 0 and processed_count >= 0 and failed_count >= 0
    and (
      item_count = 0
      or processed_count + failed_count <= item_count
    )
  ),
  constraint whatsapp_coexistence_sync_batches_metadata_object check (
    jsonb_typeof(metadata) = 'object'
  ),
  unique (account_id, sync_type, sync_generation_id, external_batch_id)
);

create index whatsapp_coexistence_sync_batches_order_idx
  on public.whatsapp_coexistence_sync_batches (
    account_id, sync_type, sync_generation_id, chunk_order, first_received_at
  );
create index whatsapp_coexistence_sync_batches_event_idx
  on public.whatsapp_coexistence_sync_batches (event_id);

create trigger set_whatsapp_coexistence_sync_batches_updated_at
  before update on public.whatsapp_coexistence_sync_batches
  for each row execute function public.set_updated_at();

-- A Graph request can fail before Meta returns a request id or emits any
-- webhook. Keep that terminal generation outcome independently from event
-- rows so refreshes cannot accidentally turn the stream back to idle.
create table public.whatsapp_coexistence_sync_generation_failures (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references public.whatsapp_coexistence_accounts (id) on delete cascade,
  sync_type text not null,
  sync_generation_id uuid not null,
  request_id text,
  failure_kind text not null default 'request_failed',
  error text not null,
  metadata jsonb not null default '{}'::jsonb,
  failed_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default now(),
  constraint whatsapp_coexistence_generation_failures_type_check check (
    sync_type in ('history', 'smb_app_state_sync')
  ),
  constraint whatsapp_coexistence_generation_failures_kind_check check (
    failure_kind in ('request_failed', 'cancelled')
  ),
  constraint whatsapp_coexistence_generation_failures_request_check check (
    request_id is null or char_length(trim(request_id)) between 1 and 240
  ),
  constraint whatsapp_coexistence_generation_failures_error_check check (
    char_length(trim(error)) between 1 and 2000
  ),
  constraint whatsapp_coexistence_generation_failures_metadata_object check (
    jsonb_typeof(metadata) = 'object'
  ),
  unique (account_id, sync_type, sync_generation_id)
);

create index whatsapp_coexistence_generation_failures_account_idx
  on public.whatsapp_coexistence_sync_generation_failures (
    account_id, failed_at desc
  );

create table public.whatsapp_coexistence_contacts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references public.whatsapp_coexistence_accounts (id) on delete cascade,
  last_event_id uuid not null
    references public.whatsapp_coexistence_events (id) on delete restrict,
  contact_id uuid references public.contacts (id) on delete set null,
  whatsapp_id text,
  whatsapp_user_id text,
  phone_e164 text,
  profile_name text,
  app_state text not null default 'active',
  source_timestamp timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_coexistence_contacts_phone_check check (
    phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
  ),
  constraint whatsapp_coexistence_contacts_whatsapp_id_check check (
    whatsapp_id is null or whatsapp_id ~ '^[0-9]{8,15}$'
  ),
  constraint whatsapp_coexistence_contacts_user_id_check check (
    whatsapp_user_id is null
    or (
      char_length(whatsapp_user_id) between 1 and 256
      and whatsapp_user_id ~ '^[A-Za-z0-9.]+$'
    )
  ),
  constraint whatsapp_coexistence_contacts_identity_check check (
    phone_e164 is not null or whatsapp_user_id is not null
  ),
  constraint whatsapp_coexistence_contacts_profile_name_check check (
    profile_name is null
    or char_length(trim(profile_name)) between 1 and 120
  ),
  constraint whatsapp_coexistence_contacts_state_check check (
    app_state in ('active', 'removed')
  ),
  constraint whatsapp_coexistence_contacts_metadata_object check (
    jsonb_typeof(metadata) = 'object'
  ),
  unique (account_id, phone_e164)
);

create unique index whatsapp_coexistence_contacts_whatsapp_id_idx
  on public.whatsapp_coexistence_contacts (account_id, whatsapp_id)
  where whatsapp_id is not null;
create unique index whatsapp_coexistence_contacts_user_id_idx
  on public.whatsapp_coexistence_contacts (account_id, whatsapp_user_id)
  where whatsapp_user_id is not null;
create index whatsapp_coexistence_contacts_contact_idx
  on public.whatsapp_coexistence_contacts (contact_id)
  where contact_id is not null;
create index whatsapp_coexistence_contacts_event_idx
  on public.whatsapp_coexistence_contacts (last_event_id);

create trigger set_whatsapp_coexistence_contacts_updated_at
  before update on public.whatsapp_coexistence_contacts
  for each row execute function public.set_updated_at();

create table public.whatsapp_coexistence_message_enrichments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references public.whatsapp_coexistence_accounts (id) on delete cascade,
  event_id uuid not null references public.whatsapp_coexistence_events (id)
    on delete restrict,
  whatsapp_message_id text not null,
  whatsapp_message_type text not null,
  body text,
  metadata jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_coexistence_enrichments_message_id_check check (
    char_length(trim(whatsapp_message_id)) between 8 and 240
  ),
  constraint whatsapp_coexistence_enrichments_type_check check (
    whatsapp_message_type in ('image', 'video', 'document', 'audio', 'sticker')
  ),
  constraint whatsapp_coexistence_enrichments_metadata_object check (
    jsonb_typeof(metadata) = 'object'
  ),
  unique (account_id, whatsapp_message_id)
);

create index whatsapp_coexistence_enrichments_pending_idx
  on public.whatsapp_coexistence_message_enrichments (whatsapp_message_id)
  where applied_at is null;
create index whatsapp_coexistence_enrichments_event_idx
  on public.whatsapp_coexistence_message_enrichments (event_id);

create trigger set_whatsapp_coexistence_enrichments_updated_at
  before update on public.whatsapp_coexistence_message_enrichments
  for each row execute function public.set_updated_at();

create table public.whatsapp_message_status_events (
  id uuid primary key default gen_random_uuid(),
  whatsapp_message_id text not null,
  status public.message_status not null,
  status_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  constraint whatsapp_message_status_events_message_id_check check (
    char_length(trim(whatsapp_message_id)) between 8 and 240
  ),
  constraint whatsapp_message_status_events_metadata_object check (
    jsonb_typeof(metadata) = 'object'
  ),
  unique (whatsapp_message_id, status, status_at)
);

create index whatsapp_message_status_events_pending_idx
  on public.whatsapp_message_status_events (whatsapp_message_id, status_at)
  where applied_at is null;

-- Inbound persistence and automation dispatch are separate durable steps.
-- An AFTER INSERT trigger reserves this row in the message transaction; the
-- webhook then atomically releases/skips it while completing webhook_events.
-- A dedicated worker claims only released pending rows.
create table public.whatsapp_automation_dispatches (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique
    references public.messages (id) on delete restrict,
  -- Deliberately not an FK: webhook_events has a short retention policy while
  -- this row must survive until automation reaches a terminal state. The
  -- service-role finalization/enqueue RPCs validate the event transactionally.
  external_event_id text not null unique,
  status text not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 8,
  available_at timestamptz not null default now(),
  processing_started_at timestamptz,
  lease_expires_at timestamptz,
  lease_token uuid,
  completed_at timestamptz,
  failed_at timestamptz,
  completion_reason text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_automation_dispatches_external_event_check check (
    char_length(trim(external_event_id)) between 1 and 240
  ),
  constraint whatsapp_automation_dispatches_status_check check (
    status in ('reserved', 'pending', 'processing', 'completed', 'failed')
  ),
  constraint whatsapp_automation_dispatches_completion_reason_check check (
    completion_reason is null
    or (
      status = 'completed'
      and completion_reason in ('processed', 'skipped')
    )
  ),
  constraint whatsapp_automation_dispatches_attempts_check check (
    attempts between 0 and 100 and max_attempts between 1 and 100
  ),
  constraint whatsapp_automation_dispatches_lease_check check (
    (
      status = 'processing'
      and processing_started_at is not null
      and lease_expires_at is not null
      and lease_token is not null
    )
    or (
      status <> 'processing'
      and processing_started_at is null
      and lease_expires_at is null
      and lease_token is null
    )
  )
);

create index whatsapp_automation_dispatches_claim_idx
  on public.whatsapp_automation_dispatches (available_at, created_at)
  where status = 'pending';
create index whatsapp_automation_dispatches_stale_lease_idx
  on public.whatsapp_automation_dispatches (lease_expires_at)
  where status = 'processing';

create trigger set_whatsapp_automation_dispatches_updated_at
  before update on public.whatsapp_automation_dispatches
  for each row execute function public.set_updated_at();

-- Keep the webhook claim while its automation reservation/work remains
-- actionable. There is intentionally no FK to couple terminal retention, but
-- cleanup must not remove the claim needed to recover an unfinished finalize.
create or replace function public.cleanup_webhook_events(
  p_retention_days integer default 30
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  delete from public.webhook_events event
  where event.created_at
      < now() - make_interval(days => greatest(7, p_retention_days))
    and not exists (
      select 1
      from public.whatsapp_automation_dispatches dispatch
      where dispatch.external_event_id = event.external_event_id
        and dispatch.status in ('reserved', 'pending', 'processing')
    );
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

alter table public.messages
  add column whatsapp_origin text not null default 'cloud_api',
  -- Assigned by a BEFORE INSERT trigger only after taking the per-conversation
  -- transaction lock below. A column identity/default would consume nextval()
  -- before BEFORE triggers run, allowing a later transaction to commit first.
  add column whatsapp_ingest_sequence bigint,
  add column whatsapp_message_type text,
  add column coexistence_account_id uuid
    references public.whatsapp_coexistence_accounts (id) on delete restrict,
  add column coexistence_event_id uuid
    references public.whatsapp_coexistence_events (id) on delete restrict,
  add column coexistence_batch_id uuid
    references public.whatsapp_coexistence_sync_batches (id) on delete restrict,
  add column original_whatsapp_message_id text,
  add column edited_at timestamptz,
  add column revoked_at timestamptz,
  add constraint messages_whatsapp_origin_check check (
    whatsapp_origin in (
      'cloud_api', 'history', 'smb_message_echoes', 'meta_message_mutation'
    )
  ),
  add constraint messages_whatsapp_type_check check (
    whatsapp_message_type is null
    or char_length(trim(whatsapp_message_type)) between 1 and 80
  ),
  add constraint messages_coexistence_context_check check (
    whatsapp_origin = 'cloud_api'
    or (
      coexistence_account_id is not null
      and coexistence_event_id is not null
      and whatsapp_message_id is not null
      and whatsapp_message_type is not null
    )
  ),
  add constraint messages_echo_direction_check check (
    whatsapp_origin <> 'smb_message_echoes' or direction = 'outbound'
  ),
  add constraint messages_history_batch_check check (
    whatsapp_origin <> 'history' or coexistence_batch_id is not null
  ),
  add constraint messages_echo_mutation_reference_check check (
    whatsapp_origin <> 'smb_message_echoes'
    or whatsapp_message_type not in ('edit', 'revoke')
    or original_whatsapp_message_id is not null
  ),
  add constraint messages_mutation_reference_check check (
    whatsapp_origin <> 'meta_message_mutation'
    or (
      direction = 'inbound'
      and
      whatsapp_message_type in ('edit', 'revoke')
      and original_whatsapp_message_id is not null
    )
  );

create sequence public.messages_whatsapp_ingest_sequence_seq as bigint;
alter sequence public.messages_whatsapp_ingest_sequence_seq
  owned by public.messages.whatsapp_ingest_sequence;

-- Backfill rows that predate the ordering primitive deterministically. The
-- ALTER TABLE above keeps an ACCESS EXCLUSIVE lock until this migration
-- commits, so no writer can bypass either this backfill or the trigger that is
-- installed later in the same transaction.
--
-- This is deliberately an UPDATE rather than a sequence default: PostgreSQL
-- does not guarantee the order in which a volatile DEFAULT is evaluated while
-- rewriting an existing table. Ranking by (created_at, id) gives every
-- pre-existing row a stable, total ordering.
--
-- Internal backfill changes must not look like live messages to Realtime. The
-- table is removed only from the explicit Supabase publication while the
-- UPDATE runs, then restored before commit. Catalog changes and the UPDATE are
-- in the same transaction, so pgoutput excludes those row changes and clients
-- never observe an intermediate publication configuration. Publication-level
-- settings are untouched, and an unexpected FOR ALL TABLES, row-filtered or
-- column-filtered configuration fails closed instead of being approximated.
--
-- Of the pre-existing message triggers, only set_messages_updated_at fires for
-- an UPDATE limited to whatsapp_ingest_sequence. Suspend exactly that trigger
-- and restore its original O/R/A/D state; all column-scoped policy/business
-- triggers remain enabled. Any error rolls the nested mutation block back as
-- a subtransaction, restoring both trigger and publication automatically.
do $messages_ingest_sequence_backfill$
declare
  updated_at_trigger_state "char";
  realtime_publication_exists boolean := false;
  realtime_publication_all_tables boolean := false;
  realtime_effective_member boolean := false;
  realtime_explicit_member boolean := false;
  realtime_public_schema_member boolean := false;
  realtime_has_column_filter boolean := false;
  realtime_has_row_filter boolean := false;
begin
  lock table public.messages in access exclusive mode;

  select trigger_info.tgenabled
  into updated_at_trigger_state
  from pg_catalog.pg_trigger trigger_info
  where trigger_info.tgrelid = 'public.messages'::regclass
    and trigger_info.tgname = 'set_messages_updated_at'
    and not trigger_info.tgisinternal;

  if not found then
    raise exception 'MESSAGES_UPDATED_AT_TRIGGER_NOT_FOUND';
  end if;

  if updated_at_trigger_state not in ('O', 'R', 'A', 'D') then
    raise exception 'MESSAGES_UPDATED_AT_TRIGGER_STATE_UNSUPPORTED: %',
      updated_at_trigger_state;
  end if;

  select publication.puballtables
  into realtime_publication_all_tables
  from pg_catalog.pg_publication publication
  where publication.pubname = 'supabase_realtime';
  realtime_publication_exists := found;

  if realtime_publication_exists and realtime_publication_all_tables then
    raise exception 'SUPABASE_REALTIME_ALL_TABLES_CANNOT_ISOLATE_MESSAGES';
  end if;

  if realtime_publication_exists then
    select exists (
      select 1
      from pg_catalog.pg_publication_tables publication_table
      where publication_table.pubname = 'supabase_realtime'
        and publication_table.schemaname = 'public'
        and publication_table.tablename = 'messages'
    )
    into realtime_effective_member;

    select exists (
      select 1
      from pg_catalog.pg_publication_namespace publication_namespace
      join pg_catalog.pg_publication publication
        on publication.oid = publication_namespace.pnpubid
      join pg_catalog.pg_namespace namespace
        on namespace.oid = publication_namespace.pnnspid
      where publication.pubname = 'supabase_realtime'
        and namespace.nspname = 'public'
    )
    into realtime_public_schema_member;

    if realtime_public_schema_member then
      raise exception
        'SUPABASE_REALTIME_PUBLIC_SCHEMA_MEMBERSHIP_CANNOT_ISOLATE_MESSAGES';
    end if;

    select
      publication_relation.prattrs is not null,
      publication_relation.prqual is not null
    into
      realtime_has_column_filter,
      realtime_has_row_filter
    from pg_catalog.pg_publication_rel publication_relation
    join pg_catalog.pg_publication publication
      on publication.oid = publication_relation.prpubid
    where publication.pubname = 'supabase_realtime'
      and publication_relation.prrelid = 'public.messages'::regclass;

    realtime_explicit_member := found;

    if realtime_effective_member is distinct from realtime_explicit_member then
      raise exception
        'SUPABASE_REALTIME_MESSAGES_MEMBERSHIP_NOT_EXCLUSIVELY_EXPLICIT';
    end if;

    if realtime_explicit_member and (
      realtime_has_column_filter or realtime_has_row_filter
    ) then
      raise exception
        'SUPABASE_REALTIME_MESSAGES_FILTERED_MEMBERSHIP_CANNOT_BE_RESTORED';
    end if;
  end if;

  -- An EXCEPTION block is a PostgreSQL subtransaction. If any mutation or
  -- restoration statement below fails, PostgreSQL first rolls this whole
  -- nested block back (including catalog changes) and then re-raises the
  -- original error, leaving neither the trigger nor publication half-changed.
  begin
    if realtime_explicit_member then
      alter publication supabase_realtime drop table public.messages;
    end if;

    if updated_at_trigger_state <> 'D' then
      alter table public.messages disable trigger set_messages_updated_at;
    end if;

    with ordered_messages as (
      select
        message.id,
        row_number() over (
          order by message.created_at, message.id
        )::bigint as ingest_sequence
      from public.messages message
    )
    update public.messages message
    set whatsapp_ingest_sequence = ordered.ingest_sequence
    from ordered_messages ordered
    where ordered.id = message.id
      and message.whatsapp_ingest_sequence is null;

    case updated_at_trigger_state
      when 'O' then
        alter table public.messages
          enable trigger set_messages_updated_at;
      when 'R' then
        alter table public.messages
          enable replica trigger set_messages_updated_at;
      when 'A' then
        alter table public.messages
          enable always trigger set_messages_updated_at;
      when 'D' then
        null;
    end case;

    if realtime_explicit_member then
      alter publication supabase_realtime add table public.messages;
    end if;
  exception
    when others then
      raise;
  end;
end;
$messages_ingest_sequence_backfill$;

select setval(
  'public.messages_whatsapp_ingest_sequence_seq',
  coalesce((select max(whatsapp_ingest_sequence) from public.messages), 0) + 1,
  false
);

alter table public.messages
  alter column whatsapp_ingest_sequence set not null;

alter table public.webhook_events
  add column attempts integer not null default 0,
  add column processing_started_at timestamptz,
  add constraint webhook_events_attempts_check check (
    attempts >= 0
  );

create index webhook_events_stale_pending_idx
  on public.webhook_events (processing_started_at)
  where status = 'pending';

create index messages_whatsapp_origin_created_idx
  on public.messages (whatsapp_origin, created_at);
create unique index messages_whatsapp_ingest_sequence_idx
  on public.messages (whatsapp_ingest_sequence);
create index messages_created_ingest_sequence_idx
  on public.messages (created_at, whatsapp_ingest_sequence);
create index messages_conversation_created_ingest_idx
  on public.messages (
    conversation_id, created_at, whatsapp_ingest_sequence
  );
create index messages_original_whatsapp_message_idx
  on public.messages (original_whatsapp_message_id)
  where original_whatsapp_message_id is not null;
create index messages_coexistence_batch_idx
  on public.messages (coexistence_batch_id, created_at)
  where coexistence_batch_id is not null;
create index messages_coexistence_event_idx
  on public.messages (coexistence_event_id)
  where coexistence_event_id is not null;
create index messages_coexistence_account_created_idx
  on public.messages (coexistence_account_id, created_at)
  where coexistence_account_id is not null;

-- These tables contain raw webhook payloads and internal Meta identifiers.
-- They are deliberately invisible to browser roles.
alter table public.whatsapp_coexistence_accounts enable row level security;
alter table public.whatsapp_coexistence_events enable row level security;
alter table public.whatsapp_coexistence_sync_batches enable row level security;
alter table public.whatsapp_coexistence_sync_generation_failures
  enable row level security;
alter table public.whatsapp_coexistence_contacts enable row level security;
alter table public.whatsapp_coexistence_message_enrichments enable row level security;
alter table public.whatsapp_message_status_events enable row level security;
alter table public.whatsapp_automation_dispatches enable row level security;

revoke all on public.whatsapp_coexistence_accounts
  from public, anon, authenticated;
revoke all on public.whatsapp_coexistence_events
  from public, anon, authenticated;
revoke all on public.whatsapp_coexistence_sync_batches
  from public, anon, authenticated;
revoke all on public.whatsapp_coexistence_sync_generation_failures
  from public, anon, authenticated;
revoke all on public.whatsapp_coexistence_contacts
  from public, anon, authenticated;
revoke all on public.whatsapp_coexistence_message_enrichments
  from public, anon, authenticated;
revoke all on public.whatsapp_message_status_events
  from public, anon, authenticated;
revoke all on public.whatsapp_automation_dispatches
  from public, anon, authenticated;

grant all on public.whatsapp_coexistence_accounts to service_role;
grant all on public.whatsapp_coexistence_events to service_role;
grant all on public.whatsapp_coexistence_sync_batches to service_role;
grant all on public.whatsapp_coexistence_sync_generation_failures
  to service_role;
grant all on public.whatsapp_coexistence_contacts to service_role;
grant all on public.whatsapp_coexistence_message_enrichments to service_role;
grant all on public.whatsapp_message_status_events to service_role;
grant all on public.whatsapp_automation_dispatches to service_role;
revoke all on sequence public.messages_whatsapp_ingest_sequence_seq
  from public, anon, authenticated;
grant usage, select on sequence public.messages_whatsapp_ingest_sequence_seq
  to service_role;

create or replace function public.assert_whatsapp_coexistence_service_role()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'WHATSAPP_COEXISTENCE_SERVICE_ROLE_REQUIRED'
      using errcode = '42501';
  end if;
end;
$$;

-- Every producer/consumer of a WAMID-associated side event takes this same
-- transaction lock. If a message and a status/media/mutation arrive in
-- concurrent transactions, one waits for the other and reconciliation always
-- observes the committed counterpart.
create or replace function public.lock_whatsapp_message_wamid(
  p_whatsapp_message_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_message_id text := nullif(trim(coalesce(p_whatsapp_message_id, '')), '');
begin
  if clean_message_id is null then
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('whatsapp-wamid:' || clean_message_id, 0)
  );
end;
$$;

create or replace function public.lock_whatsapp_message_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  lock_id text;
begin
  if tg_op = 'UPDATE' then
    for lock_id in
      select distinct candidate.message_id
      from unnest(array[
        old.whatsapp_message_id,
        old.original_whatsapp_message_id,
        new.whatsapp_message_id,
        new.original_whatsapp_message_id
      ]) as candidate(message_id)
      where candidate.message_id is not null
      order by candidate.message_id
    loop
      perform public.lock_whatsapp_message_wamid(lock_id);
    end loop;
  else
    for lock_id in
      select distinct candidate.message_id
      from unnest(array[
        new.whatsapp_message_id,
        new.original_whatsapp_message_id
      ]) as candidate(message_id)
      where candidate.message_id is not null
      order by candidate.message_id
    loop
      perform public.lock_whatsapp_message_wamid(lock_id);
    end loop;
  end if;
  return new;
end;
$$;

create trigger a_messages_lock_whatsapp_wamid
  before insert or update of
    whatsapp_message_id,
    original_whatsapp_message_id
  on public.messages
  for each row execute function public.lock_whatsapp_message_before_insert();

-- Sequence allocation must happen after the WAMID lock (trigger `a_...`) and
-- before the remaining message guards (triggers `aa...`). Holding this lock
-- through transaction end serializes both allocation and commit for every
-- conversation: a later insert cannot receive/commit its sequence first.
create or replace function public.assign_whatsapp_ingest_sequence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.whatsapp_ingest_sequence
      is distinct from old.whatsapp_ingest_sequence then
      raise exception 'WHATSAPP_INGEST_SEQUENCE_IMMUTABLE'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.conversation_id is null then
    raise exception 'WHATSAPP_INGEST_CONVERSATION_REQUIRED'
      using errcode = '23502';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'whatsapp-conversation-ingest:' || new.conversation_id::text,
      0
    )
  );
  -- Always overwrite caller input. Only this locked allocation is
  -- authoritative, including for inserts made with the service role.
  new.whatsapp_ingest_sequence := nextval(
    'public.messages_whatsapp_ingest_sequence_seq'::regclass
  );
  return new;
end;
$$;

create trigger aa0_messages_assign_whatsapp_ingest_sequence
  before insert or update of whatsapp_ingest_sequence on public.messages
  for each row execute function public.assign_whatsapp_ingest_sequence();

create or replace function public.require_whatsapp_coexistence_event_lease(
  p_event_id uuid,
  p_lease_token uuid
)
returns public.whatsapp_coexistence_events
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.whatsapp_coexistence_events%rowtype;
begin
  perform public.assert_whatsapp_coexistence_service_role();

  select * into result
  from public.whatsapp_coexistence_events
  where id = p_event_id
    and status = 'processing'
    and lease_token = p_lease_token
    and lease_expires_at > clock_timestamp()
  for update;

  if not found then
    raise exception 'WHATSAPP_COEXISTENCE_EVENT_LEASE_INVALID'
      using errcode = '55000';
  end if;

  return result;
end;
$$;

create or replace function public.upsert_whatsapp_coexistence_account(
  p_waba_id text,
  p_phone_number_id text,
  p_display_phone text default null,
  p_coexistence_status text default 'pending',
  p_metadata jsonb default '{}'::jsonb
)
returns public.whatsapp_coexistence_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.whatsapp_coexistence_accounts%rowtype;
  clean_waba_id text := trim(coalesce(p_waba_id, ''));
  clean_phone_number_id text := trim(coalesce(p_phone_number_id, ''));
begin
  perform public.assert_whatsapp_coexistence_service_role();

  if clean_waba_id !~ '^[0-9]{5,64}$'
    or clean_phone_number_id !~ '^[0-9]{5,64}$'
    or p_coexistence_status not in (
      'pending', 'onboarding', 'active', 'paused', 'disconnected', 'error'
    )
    or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'WHATSAPP_COEXISTENCE_ACCOUNT_INVALID'
      using errcode = '22023';
  end if;

  select * into result
  from public.whatsapp_coexistence_accounts
  where phone_number_id = clean_phone_number_id
  for update;

  if not found then
    begin
      insert into public.whatsapp_coexistence_accounts (
        waba_id,
        phone_number_id,
        display_phone,
        coexistence_status,
        metadata
      ) values (
        clean_waba_id,
        clean_phone_number_id,
        nullif(trim(coalesce(p_display_phone, '')), ''),
        p_coexistence_status,
        coalesce(p_metadata, '{}'::jsonb)
      )
      returning * into result;
      return result;
    exception when unique_violation then
      select * into result
      from public.whatsapp_coexistence_accounts
      where phone_number_id = clean_phone_number_id
      for update;
    end;
  end if;

  if result.waba_id <> clean_waba_id then
    raise exception 'WHATSAPP_COEXISTENCE_ACCOUNT_IDENTITY_CONFLICT'
      using errcode = '23505';
  end if;

  update public.whatsapp_coexistence_accounts
  set
    display_phone = coalesce(
      nullif(trim(coalesce(p_display_phone, '')), ''),
      display_phone
    ),
    coexistence_status = case
      when coexistence_status = 'active' and p_coexistence_status = 'pending'
        then coexistence_status
      when coexistence_status in ('paused', 'disconnected', 'error')
        and p_coexistence_status in ('active', 'pending')
        then coexistence_status
      else p_coexistence_status
    end,
    metadata = metadata || coalesce(p_metadata, '{}'::jsonb)
  where id = result.id
  returning * into result;

  return result;
end;
$$;

create or replace function public.enqueue_whatsapp_coexistence_event(
  p_account_id uuid,
  p_external_event_id text,
  p_field text,
  p_payload jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns public.whatsapp_coexistence_events
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.whatsapp_coexistence_events%rowtype;
  current_account public.whatsapp_coexistence_accounts%rowtype;
  clean_external_event_id text := trim(coalesce(p_external_event_id, ''));
  incoming_hash text;
  event_generation_id uuid;
begin
  perform public.assert_whatsapp_coexistence_service_role();

  select * into current_account
  from public.whatsapp_coexistence_accounts
  where id = p_account_id
  for update;
  if not found then
    raise exception 'WHATSAPP_COEXISTENCE_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;
  if char_length(clean_external_event_id) not between 8 and 240
    or p_field not in (
      'messages', 'history', 'smb_app_state_sync', 'smb_message_echoes'
    )
    or jsonb_typeof(p_payload) <> 'object'
    or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'WHATSAPP_COEXISTENCE_EVENT_INVALID'
      using errcode = '22023';
  end if;

  incoming_hash := md5(p_payload::text);
  event_generation_id := case p_field
    when 'history' then current_account.history_sync_generation_id
    when 'smb_app_state_sync' then current_account.app_state_sync_generation_id
    else null
  end;

  insert into public.whatsapp_coexistence_events (
    account_id,
    external_event_id,
    field,
    sync_generation_id,
    payload,
    payload_hash,
    metadata
  ) values (
    p_account_id,
    clean_external_event_id,
    p_field,
    event_generation_id,
    p_payload,
    incoming_hash,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (external_event_id) do nothing
  returning * into result;

  if result.id is null then
    select * into result
    from public.whatsapp_coexistence_events
    where external_event_id = clean_external_event_id
    for update;

    if result.account_id <> p_account_id
      or result.field <> p_field
      or result.payload_hash <> incoming_hash then
      raise exception 'WHATSAPP_COEXISTENCE_EVENT_ID_COLLISION'
        using errcode = '23505';
    end if;

    -- Terminal failures stay terminal. Meta can redeliver a poison payload for
    -- days; only the explicit service-role requeue RPC may revive it after the
    -- processor/configuration has been corrected.
  end if;

  update public.whatsapp_coexistence_accounts
  set last_webhook_at = clock_timestamp()
  where id = p_account_id;

  return result;
end;
$$;

create or replace function public.claim_whatsapp_coexistence_events(
  p_limit integer default 5
)
returns setof public.whatsapp_coexistence_events
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_account_id uuid;
begin
  perform public.assert_whatsapp_coexistence_service_role();

  -- Keep one account per transaction. Row-level state aggregation locks the
  -- account, so this ordering prevents two multi-account claims from taking
  -- account locks in opposite orders.
  select queued.account_id into selected_account_id
  from public.whatsapp_coexistence_events queued
  where (
      queued.status = 'pending'
      and queued.available_at <= clock_timestamp()
    ) or (
      queued.status = 'processing'
      and queued.lease_expires_at <= clock_timestamp()
    )
  order by coalesce(queued.lease_expires_at, queued.available_at), queued.created_at
  for update skip locked
  limit 1;

  if selected_account_id is null then
    return;
  end if;

  update public.whatsapp_coexistence_events
  set
    status = 'pending',
    available_at = clock_timestamp(),
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    last_error = coalesce(last_error, 'STALE_LEASE_RECOVERED')
  where status = 'processing'
    and lease_expires_at <= clock_timestamp()
    and account_id = selected_account_id;

  update public.whatsapp_coexistence_events
  set
    status = 'failed',
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    failed_at = clock_timestamp(),
    last_error = coalesce(last_error, 'MAX_ATTEMPTS_EXCEEDED')
  where status = 'pending'
    and attempts >= max_attempts
    and account_id = selected_account_id;

  return query
  with candidates as (
    select queued.id
    from public.whatsapp_coexistence_events queued
    where queued.status = 'pending'
      and queued.account_id = selected_account_id
      and queued.available_at <= clock_timestamp()
      and queued.attempts < queued.max_attempts
    order by queued.available_at, queued.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 5), 25))
  )
  update public.whatsapp_coexistence_events queued
  set
    status = 'processing',
    attempts = queued.attempts + 1,
    processing_started_at = clock_timestamp(),
    lease_expires_at = clock_timestamp() + interval '15 minutes',
    lease_token = gen_random_uuid(),
    processed_at = null,
    failed_at = null
  from candidates
  where queued.id = candidates.id
  returning queued.*;
end;
$$;

create or replace function public.checkpoint_whatsapp_coexistence_event(
  p_event_id uuid,
  p_lease_token uuid,
  p_cursor jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_whatsapp_coexistence_event_lease(
    p_event_id,
    p_lease_token
  );
  if jsonb_typeof(coalesce(p_cursor, '{}'::jsonb)) <> 'object' then
    raise exception 'WHATSAPP_COEXISTENCE_CURSOR_INVALID'
      using errcode = '22023';
  end if;

  update public.whatsapp_coexistence_events
  set
    cursor = cursor || coalesce(p_cursor, '{}'::jsonb),
    lease_expires_at = clock_timestamp() + interval '15 minutes'
  where id = p_event_id
    and status = 'processing'
    and lease_token = p_lease_token;
  return found;
end;
$$;

create or replace function public.complete_whatsapp_coexistence_event(
  p_event_id uuid,
  p_lease_token uuid,
  p_cursor jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_event public.whatsapp_coexistence_events%rowtype;
  event_updated boolean;
begin
  current_event := public.require_whatsapp_coexistence_event_lease(
    p_event_id,
    p_lease_token
  );
  if jsonb_typeof(coalesce(p_cursor, '{}'::jsonb)) <> 'object' then
    raise exception 'WHATSAPP_COEXISTENCE_CURSOR_INVALID'
      using errcode = '22023';
  end if;

  update public.whatsapp_coexistence_events
  set
    status = 'processed',
    cursor = cursor || coalesce(p_cursor, '{}'::jsonb),
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    processed_at = clock_timestamp(),
    failed_at = null,
    last_error = null
  where id = p_event_id
    and status = 'processing'
    and lease_token = p_lease_token;
  event_updated := found;

  if event_updated
    and current_event.field in ('history', 'smb_app_state_sync') then
    perform public.refresh_whatsapp_coexistence_sync_state(
      current_event.account_id
    );
  end if;

  return event_updated;
end;
$$;

create or replace function public.yield_whatsapp_coexistence_event(
  p_event_id uuid,
  p_lease_token uuid,
  p_cursor jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_whatsapp_coexistence_event_lease(
    p_event_id,
    p_lease_token
  );
  if jsonb_typeof(coalesce(p_cursor, '{}'::jsonb)) <> 'object' then
    raise exception 'WHATSAPP_COEXISTENCE_CURSOR_INVALID'
      using errcode = '22023';
  end if;

  update public.whatsapp_coexistence_events
  set
    status = 'pending',
    cursor = cursor || coalesce(p_cursor, '{}'::jsonb),
    -- Claim increments attempts. A cooperative page yield is not a failure,
    -- so return that budget before making the event immediately claimable.
    attempts = greatest(attempts - 1, 0),
    available_at = clock_timestamp(),
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    processed_at = null,
    failed_at = null
  where id = p_event_id
    and status = 'processing'
    and lease_token = p_lease_token;
  return found;
end;
$$;

create or replace function public.fail_whatsapp_coexistence_event(
  p_event_id uuid,
  p_lease_token uuid,
  p_error text,
  p_retry boolean default true,
  p_cursor jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_event public.whatsapp_coexistence_events%rowtype;
  retry_event boolean;
  retry_seconds integer;
  event_updated boolean;
begin
  current_event := public.require_whatsapp_coexistence_event_lease(
    p_event_id,
    p_lease_token
  );
  if nullif(trim(coalesce(p_error, '')), '') is null
    or jsonb_typeof(coalesce(p_cursor, '{}'::jsonb)) <> 'object' then
    raise exception 'WHATSAPP_COEXISTENCE_FAILURE_INVALID'
      using errcode = '22023';
  end if;

  retry_event := coalesce(p_retry, true)
    and current_event.attempts < current_event.max_attempts;
  retry_seconds := least(
    3600,
    (5 * power(2, least(current_event.attempts, 9)))::integer
  );

  update public.whatsapp_coexistence_events
  set
    status = case when retry_event then 'pending' else 'failed' end,
    cursor = cursor || coalesce(p_cursor, '{}'::jsonb),
    available_at = case
      when retry_event
        then clock_timestamp() + make_interval(secs => retry_seconds)
      else available_at
    end,
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    processed_at = null,
    failed_at = case when retry_event then null else clock_timestamp() end,
    last_error = left(trim(p_error), 2000)
  where id = p_event_id
    and status = 'processing'
    and lease_token = p_lease_token;
  event_updated := found;

  if current_event.field in ('history', 'smb_app_state_sync') then
    -- A transient failure belongs to the queue attempt, not to batches whose
    -- operations already committed. Only a terminal event failure marks its
    -- still-open batches; completed/source-error batches remain authoritative.
    if not retry_event then
      update public.whatsapp_coexistence_sync_batches
      set
        status = 'failed',
        failed_count = case
          when item_count = 0 then greatest(failed_count, 1)
          else least(
            greatest(item_count - processed_count, 0),
            greatest(failed_count, 1)
          )
        end,
        last_error = left(trim(p_error), 2000),
        metadata = metadata || jsonb_build_object(
          'event_failure', true,
          'event_failure_at', clock_timestamp()
        ),
        completed_at = null
      where event_id = p_event_id
        and status in ('pending', 'processing');
    end if;

    -- The event-status trigger refreshes once immediately after the queue row
    -- changes. Refresh again after batch error details are durable so account
    -- state cannot lag behind the final transaction contents.
    perform public.refresh_whatsapp_coexistence_sync_state(
      current_event.account_id
    );

  end if;

  return event_updated;
end;
$$;

create or replace function public.requeue_whatsapp_coexistence_event(
  p_event_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  event_account_id uuid;
  event_field text;
begin
  perform public.assert_whatsapp_coexistence_service_role();

  update public.whatsapp_coexistence_events
  set
    status = 'pending',
    attempts = 0,
    available_at = clock_timestamp(),
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    processed_at = null,
    failed_at = null,
    last_error = null
  where id = p_event_id
    and status = 'failed'
  returning account_id, field into event_account_id, event_field;

  if found
    and event_field in ('history', 'smb_app_state_sync') then
    -- Only batches terminalized by the queue failure are revived. A batch
    -- already failed because Meta reported a source error remains failed and
    -- continues to participate in the aggregate generation state.
    update public.whatsapp_coexistence_sync_batches
    set
      status = 'pending',
      failed_count = 0,
      last_error = null,
      completed_at = null,
      metadata = (metadata - 'event_failure' - 'event_failure_at')
        || jsonb_build_object(
          'last_requeued_error', last_error,
          'last_requeued_at', clock_timestamp()
        )
    where event_id = p_event_id
      and status = 'failed'
      and metadata ->> 'event_failure' = 'true';

    perform public.refresh_whatsapp_coexistence_sync_state(event_account_id);
  end if;

  return event_account_id is not null;
end;
$$;

create or replace function public.claim_whatsapp_webhook_event(
  p_external_event_id text,
  p_event_type text,
  p_metadata jsonb,
  p_stale_after_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
  stale_seconds integer := greatest(
    60,
    least(coalesce(p_stale_after_seconds, 900), 3600)
  );
begin
  perform public.assert_whatsapp_coexistence_service_role();

  if nullif(trim(coalesce(p_external_event_id, '')), '') is null
    or nullif(trim(coalesce(p_event_type, '')), '') is null
    or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'WHATSAPP_WEBHOOK_EVENT_INVALID'
      using errcode = '22023';
  end if;

  insert into public.webhook_events (
    external_event_id,
    event_type,
    status,
    metadata,
    attempts,
    processing_started_at
  ) values (
    trim(p_external_event_id),
    trim(p_event_type),
    'pending',
    coalesce(p_metadata, '{}'::jsonb),
    1,
    clock_timestamp()
  )
  on conflict (external_event_id) do update
  set
    event_type = excluded.event_type,
    status = 'pending',
    metadata = excluded.metadata,
    attempts = webhook_events.attempts + 1,
    processing_started_at = clock_timestamp(),
    error = null,
    processed_at = null
  where webhook_events.status = 'failed'
    or (
      webhook_events.status = 'pending'
      and (
        webhook_events.processing_started_at is null
        or webhook_events.processing_started_at
          < clock_timestamp() - make_interval(secs => stale_seconds)
      )
    )
  returning id into claimed_id;

  return claimed_id is not null;
end;
$$;

create or replace function public.complete_whatsapp_webhook_event(
  p_external_event_id text,
  p_status public.webhook_event_status default 'processed',
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_whatsapp_coexistence_service_role();

  if p_status not in ('processed', 'ignored', 'failed')
    or (
      p_status = 'failed'
      and nullif(trim(coalesce(p_error, '')), '') is null
    ) then
    raise exception 'WHATSAPP_WEBHOOK_COMPLETION_INVALID'
      using errcode = '22023';
  end if;

  update public.webhook_events
  set
    status = p_status,
    error = case
      when p_status = 'failed' then left(trim(p_error), 2000)
      else null
    end,
    processed_at = clock_timestamp(),
    processing_started_at = null
  where external_event_id = trim(coalesce(p_external_event_id, ''))
    and status = 'pending';
  return found;
end;
$$;

-- Reserving the outbox row in the same transaction as the inbound message
-- closes the gap where M1 was committed but crashed before it could be queued,
-- allowing M2 to overtake it. The later finalize RPC decides whether the
-- reservation becomes actionable or a durable skipped terminal row.
create or replace function public.reserve_whatsapp_automation_dispatch_after_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  reservation_requested boolean := coalesce(
    (new.metadata -> 'automation_dispatch_reserved') = 'true'::jsonb,
    false
  );
begin
  if not reservation_requested then
    return new;
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
    or new.direction <> 'inbound'
    or new.whatsapp_origin <> 'cloud_api'
    or nullif(trim(coalesce(new.whatsapp_message_id, '')), '') is null then
    raise exception 'WHATSAPP_AUTOMATION_RESERVATION_INVALID'
      using errcode = '42501';
  end if;

  insert into public.whatsapp_automation_dispatches (
    message_id,
    external_event_id,
    status
  ) values (
    new.id,
    new.whatsapp_message_id,
    'reserved'
  );

  return new;
end;
$$;

create trigger messages_reserve_whatsapp_automation_dispatch
  after insert on public.messages
  for each row
  execute function public.reserve_whatsapp_automation_dispatch_after_message();

create or replace function public.finalize_whatsapp_inbound_webhook(
  p_message_id uuid,
  p_external_event_id text,
  p_should_run_automation boolean
)
returns public.whatsapp_automation_dispatches
language plpgsql
security definer
set search_path = public
as $$
declare
  message_row public.messages%rowtype;
  webhook_row public.webhook_events%rowtype;
  result public.whatsapp_automation_dispatches%rowtype;
  clean_external_event_id text := trim(coalesce(p_external_event_id, ''));
begin
  perform public.assert_whatsapp_coexistence_service_role();

  if p_message_id is null
    or p_should_run_automation is null
    or char_length(clean_external_event_id) not between 1 and 240 then
    raise exception 'WHATSAPP_INBOUND_WEBHOOK_FINALIZATION_INVALID'
      using errcode = '22023';
  end if;

  select message.* into message_row
  from public.messages message
  where message.id = p_message_id
  for update;
  if not found
    or message_row.direction <> 'inbound'
    or message_row.whatsapp_origin <> 'cloud_api'
    or message_row.whatsapp_message_id is distinct from clean_external_event_id
    then
    raise exception 'WHATSAPP_AUTOMATION_MESSAGE_INVALID'
      using errcode = '23514';
  end if;

  select event.* into webhook_row
  from public.webhook_events event
  where event.external_event_id = clean_external_event_id
  for update;
  if not found or webhook_row.status <> 'pending' then
    raise exception 'WHATSAPP_AUTOMATION_WEBHOOK_EVENT_NOT_PENDING'
      using errcode = '55000';
  end if;

  select dispatch.* into result
  from public.whatsapp_automation_dispatches dispatch
  where dispatch.message_id = p_message_id
  for update;

  if found then
    if result.external_event_id <> clean_external_event_id then
      raise exception 'WHATSAPP_AUTOMATION_DISPATCH_IDENTITY_CONFLICT'
        using errcode = '23505';
    end if;

    if result.status = 'reserved' then
      update public.whatsapp_automation_dispatches dispatch
      set
        status = case
          when p_should_run_automation then 'pending'
          else 'completed'
        end,
        available_at = clock_timestamp(),
        processing_started_at = null,
        lease_expires_at = null,
        lease_token = null,
        completed_at = case
          when p_should_run_automation then null
          else clock_timestamp()
        end,
        failed_at = null,
        completion_reason = case
          when p_should_run_automation then null
          else 'skipped'
        end,
        last_error = null
      where dispatch.id = result.id
      returning dispatch.* into result;
    elsif result.status = 'pending' and not p_should_run_automation then
      -- Compatibility for an inbound committed before reservation support was
      -- enabled but finalized after this migration became active.
      update public.whatsapp_automation_dispatches dispatch
      set
        status = 'completed',
        completed_at = clock_timestamp(),
        completion_reason = 'skipped',
        last_error = null
      where dispatch.id = result.id
      returning dispatch.* into result;
    elsif not p_should_run_automation and (
      result.status <> 'completed'
      or result.completion_reason is distinct from 'skipped'
    ) then
      raise exception 'WHATSAPP_AUTOMATION_FINALIZATION_CONFLICT'
        using errcode = '55000';
    elsif p_should_run_automation
      and result.status = 'completed'
      and result.completion_reason = 'skipped' then
      raise exception 'WHATSAPP_AUTOMATION_FINALIZATION_CONFLICT'
        using errcode = '55000';
    end if;
  else
    -- Fallback covers an already-existing/duplicate inbound row inserted
    -- before its producer started setting the reservation metadata flag.
    insert into public.whatsapp_automation_dispatches (
      message_id,
      external_event_id,
      status,
      completed_at,
      completion_reason
    ) values (
      p_message_id,
      clean_external_event_id,
      case when p_should_run_automation then 'pending' else 'completed' end,
      case when p_should_run_automation then null else clock_timestamp() end,
      case when p_should_run_automation then null else 'skipped' end
    )
    returning * into result;
  end if;

  -- Outbox decision and webhook completion commit or roll back together.
  update public.webhook_events event
  set
    status = 'processed',
    metadata = event.metadata || jsonb_build_object(
      'automation_dispatch_id', result.id,
      'automation_dispatch_status', result.status,
      'automation_dispatch_completion_reason', result.completion_reason
    ),
    error = null,
    processed_at = clock_timestamp(),
    processing_started_at = null
  where event.id = webhook_row.id
    and event.status = 'pending';
  if not found then
    raise exception 'WHATSAPP_AUTOMATION_WEBHOOK_EVENT_NOT_PENDING'
      using errcode = '55000';
  end if;

  return result;
end;
$$;

create or replace function public.enqueue_whatsapp_automation_dispatch(
  p_message_id uuid,
  p_external_event_id text
)
returns public.whatsapp_automation_dispatches
language plpgsql
security definer
set search_path = public
as $$
declare
  message_row public.messages%rowtype;
  result public.whatsapp_automation_dispatches%rowtype;
  clean_external_event_id text := trim(coalesce(p_external_event_id, ''));
begin
  perform public.assert_whatsapp_coexistence_service_role();

  if p_message_id is null
    or char_length(clean_external_event_id) not between 1 and 240 then
    raise exception 'WHATSAPP_AUTOMATION_DISPATCH_INVALID'
      using errcode = '22023';
  end if;

  select * into message_row
  from public.messages
  where id = p_message_id
  for share;
  if not found
    or message_row.direction <> 'inbound'
    or message_row.whatsapp_origin <> 'cloud_api'
    or message_row.whatsapp_message_id is distinct from clean_external_event_id
    then
    raise exception 'WHATSAPP_AUTOMATION_MESSAGE_INVALID'
      using errcode = '23514';
  end if;

  -- No FK is retained because webhook_events is periodically purged. The
  -- existence/pending check here ensures enqueue happens before completion;
  -- once inserted, this outbox row has its own independent durability.
  if not exists (
    select 1
    from public.webhook_events event
    where event.external_event_id = clean_external_event_id
      and event.status = 'pending'
  ) then
    raise exception 'WHATSAPP_AUTOMATION_WEBHOOK_EVENT_NOT_PENDING'
      using errcode = '55000';
  end if;

  insert into public.whatsapp_automation_dispatches (
    message_id,
    external_event_id
  ) values (
    p_message_id,
    clean_external_event_id
  )
  on conflict (message_id) do nothing
  returning * into result;

  if result.id is null then
    select * into result
    from public.whatsapp_automation_dispatches
    where message_id = p_message_id
    for update;

    if result.external_event_id <> clean_external_event_id then
      raise exception 'WHATSAPP_AUTOMATION_DISPATCH_IDENTITY_CONFLICT'
        using errcode = '23505';
    end if;
    if result.status = 'reserved' then
      raise exception 'WHATSAPP_AUTOMATION_RESERVATION_REQUIRES_FINALIZE'
        using errcode = '55000';
    end if;
    -- Idempotent enqueue never revives completed/failed poison work. Only the
    -- explicit manual requeue RPC can revive a terminal failure.
  end if;

  return result;
end;
$$;

create or replace function public.claim_whatsapp_automation_dispatches(
  p_limit integer default 10
)
returns setof public.whatsapp_automation_dispatches
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_whatsapp_coexistence_service_role();

  update public.whatsapp_automation_dispatches
  set
    status = 'pending',
    available_at = clock_timestamp(),
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    last_error = coalesce(last_error, 'STALE_LEASE_RECOVERED')
  where status = 'processing'
    and lease_expires_at <= clock_timestamp();

  update public.whatsapp_automation_dispatches
  set
    status = 'failed',
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    failed_at = clock_timestamp(),
    last_error = coalesce(last_error, 'MAX_ATTEMPTS_EXCEEDED')
  where status = 'pending'
    and attempts >= max_attempts;

  return query
  with candidates as (
    select dispatch.id
    from public.whatsapp_automation_dispatches dispatch
    where dispatch.status = 'pending'
      and dispatch.available_at <= clock_timestamp()
      and dispatch.attempts < dispatch.max_attempts
    order by dispatch.available_at, dispatch.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 100))
  )
  update public.whatsapp_automation_dispatches dispatch
  set
    status = 'processing',
    attempts = dispatch.attempts + 1,
    processing_started_at = clock_timestamp(),
    lease_expires_at = clock_timestamp() + interval '15 minutes',
    lease_token = gen_random_uuid(),
    completed_at = null,
    failed_at = null
  from candidates
  where dispatch.id = candidates.id
  returning dispatch.*;
end;
$$;

create or replace function public.complete_whatsapp_automation_dispatch(
  p_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_whatsapp_coexistence_service_role();

  update public.whatsapp_automation_dispatches
  set
    status = 'completed',
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    completed_at = clock_timestamp(),
    failed_at = null,
    completion_reason = 'processed',
    last_error = null
  where id = p_id
    and status = 'processing'
    and lease_token = p_lease_token
    and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create or replace function public.fail_whatsapp_automation_dispatch(
  p_id uuid,
  p_lease_token uuid,
  p_error text,
  p_retry boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  dispatch_row public.whatsapp_automation_dispatches%rowtype;
  retry_dispatch boolean;
  retry_seconds integer;
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if nullif(trim(coalesce(p_error, '')), '') is null then
    raise exception 'WHATSAPP_AUTOMATION_DISPATCH_FAILURE_INVALID'
      using errcode = '22023';
  end if;

  select * into dispatch_row
  from public.whatsapp_automation_dispatches
  where id = p_id
    and status = 'processing'
    and lease_token = p_lease_token
    and lease_expires_at > clock_timestamp()
  for update;
  if not found then
    return false;
  end if;

  retry_dispatch := coalesce(p_retry, true)
    and dispatch_row.attempts < dispatch_row.max_attempts;
  retry_seconds := least(
    3600,
    (15 * power(2, least(dispatch_row.attempts, 8)))::integer
  );

  update public.whatsapp_automation_dispatches
  set
    status = case when retry_dispatch then 'pending' else 'failed' end,
    available_at = case when retry_dispatch
      then clock_timestamp() + make_interval(secs => retry_seconds)
      else available_at end,
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    completed_at = null,
    failed_at = case when retry_dispatch then null else clock_timestamp() end,
    completion_reason = null,
    last_error = left(trim(p_error), 2000)
  where id = p_id;
  return true;
end;
$$;

create or replace function public.requeue_whatsapp_automation_dispatch(
  p_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_whatsapp_coexistence_service_role();

  update public.whatsapp_automation_dispatches
  set
    status = 'pending',
    attempts = 0,
    available_at = clock_timestamp(),
    processing_started_at = null,
    lease_expires_at = null,
    lease_token = null,
    completed_at = null,
    failed_at = null,
    completion_reason = null,
    last_error = null
  where id = p_id
    and status = 'failed';
  return found;
end;
$$;

-- Recompute account state from every event/batch in each active generation.
-- This is intentionally aggregate: a later successful chunk cannot hide an
-- unresolved failure from a different chunk or from the other sync stream.
create or replace function public.refresh_whatsapp_coexistence_sync_state(
  p_account_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  account_row public.whatsapp_coexistence_accounts%rowtype;
  history_failed boolean := false;
  history_processing boolean := false;
  history_pending boolean := false;
  history_observed boolean := false;
  history_complete boolean := false;
  history_partial_error boolean := false;
  history_progress numeric;
  history_started_at timestamptz;
  history_completed_at timestamptz;
  history_error text;
  history_state text;
  app_failed boolean := false;
  app_processing boolean := false;
  app_pending boolean := false;
  app_observed boolean := false;
  app_progress numeric;
  app_started_at timestamptz;
  app_error text;
  app_state text;
  aggregate_state text;
  aggregate_error text;
begin
  select * into account_row
  from public.whatsapp_coexistence_accounts
  where id = p_account_id
  for update;
  if not found then
    return;
  end if;

  select
    coalesce(bool_or(observed.status = 'failed'), false),
    coalesce(bool_or(observed.status = 'processing'), false),
    coalesce(bool_or(observed.status = 'pending'), false),
    count(*) > 0,
    min(observed.observed_at)
  into
    history_failed,
    history_processing,
    history_pending,
    history_observed,
    history_started_at
  from (
    select event.status, event.created_at as observed_at
    from public.whatsapp_coexistence_events event
    where event.account_id = p_account_id
      and event.field = 'history'
      and event.sync_generation_id = account_row.history_sync_generation_id
    union all
    select batch.status, batch.first_received_at
    from public.whatsapp_coexistence_sync_batches batch
    where batch.account_id = p_account_id
      and batch.sync_type = 'history'
      and batch.sync_generation_id = account_row.history_sync_generation_id
    union all
    select 'failed'::text, failure.failed_at
    from public.whatsapp_coexistence_sync_generation_failures failure
    where failure.account_id = p_account_id
      and failure.sync_type = 'history'
      and failure.sync_generation_id = account_row.history_sync_generation_id
  ) observed;

  select
    max(batch.progress),
    coalesce(bool_or(
      batch.status = 'completed'
      and coalesce(batch.progress, 0) >= 100
      and batch.failed_count = 0
      and batch.last_error is null
    ), false),
    coalesce(bool_or(
      batch.status = 'completed'
      and (batch.failed_count > 0 or batch.last_error is not null)
    ), false),
    max(batch.completed_at) filter (
      where batch.status = 'completed'
        and coalesce(batch.progress, 0) >= 100
        and batch.failed_count = 0
        and batch.last_error is null
    )
  into
    history_progress,
    history_complete,
    history_partial_error,
    history_completed_at
  from public.whatsapp_coexistence_sync_batches batch
  where batch.account_id = p_account_id
    and batch.sync_type = 'history'
    and batch.sync_generation_id = account_row.history_sync_generation_id;

  select left(
    string_agg(distinct issue.error, ' | ' order by issue.error),
    2000
  ) into history_error
  from (
    select event.last_error as error
    from public.whatsapp_coexistence_events event
    where event.account_id = p_account_id
      and event.field = 'history'
      and event.sync_generation_id = account_row.history_sync_generation_id
      and event.last_error is not null
    union all
    select batch.last_error
    from public.whatsapp_coexistence_sync_batches batch
    where batch.account_id = p_account_id
      and batch.sync_type = 'history'
      and batch.sync_generation_id = account_row.history_sync_generation_id
      and batch.last_error is not null
    union all
    select failure.error
    from public.whatsapp_coexistence_sync_generation_failures failure
    where failure.account_id = p_account_id
      and failure.sync_type = 'history'
      and failure.sync_generation_id = account_row.history_sync_generation_id
  ) issue;

  history_state := case
    when history_failed then 'failed'
    when history_processing then 'in_progress'
    when history_pending then 'pending'
    when history_complete and not history_partial_error then 'completed'
    when history_observed then 'partial'
    when account_row.history_sync_status = 'pending'
      and account_row.history_requested_at is not null then 'pending'
    else 'idle'
  end;

  select
    coalesce(bool_or(observed.status = 'failed'), false),
    coalesce(bool_or(observed.status = 'processing'), false),
    coalesce(bool_or(observed.status = 'pending'), false),
    count(*) > 0,
    min(observed.observed_at)
  into
    app_failed,
    app_processing,
    app_pending,
    app_observed,
    app_started_at
  from (
    select event.status, event.created_at as observed_at
    from public.whatsapp_coexistence_events event
    where event.account_id = p_account_id
      and event.field = 'smb_app_state_sync'
      and event.sync_generation_id = account_row.app_state_sync_generation_id
    union all
    select batch.status, batch.first_received_at
    from public.whatsapp_coexistence_sync_batches batch
    where batch.account_id = p_account_id
      and batch.sync_type = 'smb_app_state_sync'
      and batch.sync_generation_id = account_row.app_state_sync_generation_id
    union all
    select 'failed'::text, failure.failed_at
    from public.whatsapp_coexistence_sync_generation_failures failure
    where failure.account_id = p_account_id
      and failure.sync_type = 'smb_app_state_sync'
      and failure.sync_generation_id = account_row.app_state_sync_generation_id
  ) observed;

  select max(batch.progress) into app_progress
  from public.whatsapp_coexistence_sync_batches batch
  where batch.account_id = p_account_id
    and batch.sync_type = 'smb_app_state_sync'
    and batch.sync_generation_id = account_row.app_state_sync_generation_id;

  select left(
    string_agg(distinct issue.error, ' | ' order by issue.error),
    2000
  ) into app_error
  from (
    select event.last_error as error
    from public.whatsapp_coexistence_events event
    where event.account_id = p_account_id
      and event.field = 'smb_app_state_sync'
      and event.sync_generation_id = account_row.app_state_sync_generation_id
      and event.last_error is not null
    union all
    select batch.last_error
    from public.whatsapp_coexistence_sync_batches batch
    where batch.account_id = p_account_id
      and batch.sync_type = 'smb_app_state_sync'
      and batch.sync_generation_id = account_row.app_state_sync_generation_id
      and batch.last_error is not null
    union all
    select failure.error
    from public.whatsapp_coexistence_sync_generation_failures failure
    where failure.account_id = p_account_id
      and failure.sync_type = 'smb_app_state_sync'
      and failure.sync_generation_id = account_row.app_state_sync_generation_id
  ) issue;

  app_state := case
    when app_failed then 'failed'
    when app_processing then 'in_progress'
    when app_pending then 'pending'
    -- Meta exposes no app-state global completion marker. A consumed delivery
    -- is partial by definition, regardless of how many items it contained.
    when app_observed then 'partial'
    when account_row.app_state_sync_status = 'pending'
      and account_row.app_state_sync_requested_at is not null then 'pending'
    else 'idle'
  end;

  if history_state <> 'idle' then
    history_started_at := coalesce(
      account_row.history_sync_started_at,
      history_started_at,
      account_row.history_requested_at,
      clock_timestamp()
    );
  end if;
  if app_state <> 'idle' then
    app_started_at := coalesce(
      account_row.app_state_sync_started_at,
      app_started_at,
      account_row.app_state_sync_requested_at,
      clock_timestamp()
    );
  end if;

  aggregate_state := case
    when history_state = 'failed' or app_state = 'failed' then 'failed'
    when history_state = 'in_progress' or app_state = 'in_progress'
      then 'in_progress'
    when history_state = 'pending' or app_state = 'pending' then case
      when history_state not in ('idle', 'pending')
        or app_state not in ('idle', 'pending') then 'in_progress'
      else 'pending'
    end
    when history_state = 'partial' or app_state = 'partial' then 'partial'
    when history_state = 'completed' or app_state = 'completed'
      then 'completed'
    else 'idle'
  end;

  aggregate_error := nullif(left(concat_ws(
    ' | ',
    case when history_error is not null
      then 'history: ' || history_error end,
    case when app_error is not null
      then 'app_state: ' || app_error end
  ), 2000), '');

  update public.whatsapp_coexistence_accounts
  set
    sync_status = aggregate_state,
    sync_started_at = case
      when aggregate_state = 'idle' then null
      else coalesce(
        least(history_started_at, app_started_at),
        history_started_at,
        app_started_at
      )
    end,
    sync_completed_at = case
      when aggregate_state = 'completed'
        then coalesce(history_completed_at, clock_timestamp())
      else null
    end,
    last_sync_error = aggregate_error,
    history_sync_status = history_state,
    history_sync_progress = history_progress,
    history_sync_started_at = case
      when history_state = 'idle' then null
      else history_started_at
    end,
    history_sync_completed_at = case
      when history_state = 'completed'
        then coalesce(history_sync_completed_at, history_completed_at, clock_timestamp())
      else null
    end,
    history_sync_error = history_error,
    app_state_sync_status = app_state,
    app_state_sync_progress = app_progress,
    app_state_sync_started_at = case
      when app_state = 'idle' then null
      else app_started_at
    end,
    -- No official global completion signal exists for this stream.
    app_state_sync_completed_at = null,
    app_state_sync_error = app_error
  where id = p_account_id;
end;
$$;

create or replace function public.start_whatsapp_coexistence_sync_generation(
  p_account_id uuid,
  p_sync_type text,
  p_request_id text default null,
  p_requested_at timestamptz default clock_timestamp()
)
returns public.whatsapp_coexistence_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.whatsapp_coexistence_accounts%rowtype;
  current_account public.whatsapp_coexistence_accounts%rowtype;
  new_generation_id uuid := gen_random_uuid();
  clean_request_id text := nullif(trim(coalesce(p_request_id, '')), '');
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if p_sync_type not in ('history', 'smb_app_state_sync')
    or p_requested_at is null
    or (clean_request_id is not null and char_length(clean_request_id) > 240)
    then
    raise exception 'WHATSAPP_COEXISTENCE_SYNC_GENERATION_INVALID'
      using errcode = '22023';
  end if;

  select * into current_account
  from public.whatsapp_coexistence_accounts
  where id = p_account_id
  for update;
  if not found then
    raise exception 'WHATSAPP_COEXISTENCE_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  -- A webhook does not carry request_id, so overlapping generations cannot be
  -- correlated safely. The caller must finish/fail the active request before
  -- beginning another one.
  if (p_sync_type = 'history' and current_account.history_sync_status in (
      'pending', 'in_progress'
    )) or (
      p_sync_type = 'smb_app_state_sync'
      and current_account.app_state_sync_status in ('pending', 'in_progress')
    ) or exists (
      select 1
      from public.whatsapp_coexistence_events event
      where event.account_id = p_account_id
        and event.field = p_sync_type
        and event.sync_generation_id = case p_sync_type
          when 'history' then current_account.history_sync_generation_id
          else current_account.app_state_sync_generation_id
        end
        and event.status in ('pending', 'processing')
    ) then
    raise exception 'WHATSAPP_COEXISTENCE_SYNC_GENERATION_ACTIVE'
      using errcode = '55000';
  end if;

  update public.whatsapp_coexistence_accounts
  set
    history_sync_generation_id = case when p_sync_type = 'history'
      then new_generation_id else history_sync_generation_id end,
    history_sync_status = case when p_sync_type = 'history'
      then 'pending' else history_sync_status end,
    history_sync_progress = case when p_sync_type = 'history'
      then null else history_sync_progress end,
    history_request_id = case when p_sync_type = 'history'
      then clean_request_id else history_request_id end,
    history_requested_at = case when p_sync_type = 'history'
      then p_requested_at else history_requested_at end,
    history_sync_started_at = case when p_sync_type = 'history'
      then null else history_sync_started_at end,
    history_sync_completed_at = case when p_sync_type = 'history'
      then null else history_sync_completed_at end,
    history_sync_error = case when p_sync_type = 'history'
      then null else history_sync_error end,
    app_state_sync_generation_id = case when p_sync_type = 'smb_app_state_sync'
      then new_generation_id else app_state_sync_generation_id end,
    app_state_sync_status = case when p_sync_type = 'smb_app_state_sync'
      then 'pending' else app_state_sync_status end,
    app_state_sync_progress = case when p_sync_type = 'smb_app_state_sync'
      then null else app_state_sync_progress end,
    app_state_sync_request_id = case when p_sync_type = 'smb_app_state_sync'
      then clean_request_id else app_state_sync_request_id end,
    app_state_sync_requested_at = case when p_sync_type = 'smb_app_state_sync'
      then p_requested_at else app_state_sync_requested_at end,
    app_state_sync_started_at = case when p_sync_type = 'smb_app_state_sync'
      then null else app_state_sync_started_at end,
    app_state_sync_completed_at = case when p_sync_type = 'smb_app_state_sync'
      then null else app_state_sync_completed_at end,
    app_state_sync_error = case when p_sync_type = 'smb_app_state_sync'
      then null else app_state_sync_error end
  where id = p_account_id
  returning * into result;
  if not found then
    raise exception 'WHATSAPP_COEXISTENCE_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform public.refresh_whatsapp_coexistence_sync_state(p_account_id);
  select * into result
  from public.whatsapp_coexistence_accounts
  where id = p_account_id;
  return result;
end;
$$;

create or replace function public.fail_whatsapp_coexistence_sync_generation(
  p_account_id uuid,
  p_sync_type text,
  p_generation_id uuid,
  p_error text,
  p_failure_kind text default 'request_failed',
  p_metadata jsonb default '{}'::jsonb,
  p_failed_at timestamptz default clock_timestamp()
)
returns public.whatsapp_coexistence_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  current_account public.whatsapp_coexistence_accounts%rowtype;
  existing_failure public.whatsapp_coexistence_sync_generation_failures%rowtype;
  current_generation_id uuid;
  current_status text;
  current_request_id text;
  clean_error text := nullif(left(trim(coalesce(p_error, '')), 2000), '');
  clean_failure_kind text := trim(coalesce(p_failure_kind, ''));
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if p_sync_type not in ('history', 'smb_app_state_sync')
    or p_generation_id is null
    or clean_error is null
    or clean_failure_kind not in ('request_failed', 'cancelled')
    or jsonb_typeof(coalesce(p_metadata, 'null'::jsonb)) <> 'object'
    or p_failed_at is null then
    raise exception 'WHATSAPP_COEXISTENCE_SYNC_GENERATION_FAILURE_INVALID'
      using errcode = '22023';
  end if;

  select * into current_account
  from public.whatsapp_coexistence_accounts
  where id = p_account_id
  for update;
  if not found then
    raise exception 'WHATSAPP_COEXISTENCE_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  current_generation_id := case p_sync_type
    when 'history' then current_account.history_sync_generation_id
    else current_account.app_state_sync_generation_id
  end;
  current_status := case p_sync_type
    when 'history' then current_account.history_sync_status
    else current_account.app_state_sync_status
  end;
  current_request_id := case p_sync_type
    when 'history' then current_account.history_request_id
    else current_account.app_state_sync_request_id
  end;

  if current_generation_id is distinct from p_generation_id then
    raise exception 'WHATSAPP_COEXISTENCE_SYNC_GENERATION_STALE'
      using errcode = '55000';
  end if;

  select failure.* into existing_failure
  from public.whatsapp_coexistence_sync_generation_failures failure
  where failure.account_id = p_account_id
    and failure.sync_type = p_sync_type
    and failure.sync_generation_id = p_generation_id;
  if found then
    if existing_failure.failure_kind <> clean_failure_kind
      or existing_failure.error <> clean_error then
      raise exception 'WHATSAPP_COEXISTENCE_SYNC_GENERATION_FAILURE_CONFLICT'
        using errcode = '23514';
    end if;
    perform public.refresh_whatsapp_coexistence_sync_state(p_account_id);
    select * into current_account
    from public.whatsapp_coexistence_accounts
    where id = p_account_id;
    return current_account;
  end if;

  if current_status not in ('pending', 'in_progress') then
    raise exception 'WHATSAPP_COEXISTENCE_SYNC_GENERATION_NOT_ACTIVE'
      using errcode = '55000';
  end if;

  -- This RPC closes the request-before-delivery gap. Once a generation has an
  -- event or batch, its leased event failure path is the authoritative one.
  if exists (
    select 1
    from public.whatsapp_coexistence_events event
    where event.account_id = p_account_id
      and event.field = p_sync_type
      and event.sync_generation_id = p_generation_id
  ) or exists (
    select 1
    from public.whatsapp_coexistence_sync_batches batch
    where batch.account_id = p_account_id
      and batch.sync_type = p_sync_type
      and batch.sync_generation_id = p_generation_id
  ) then
    raise exception 'WHATSAPP_COEXISTENCE_SYNC_GENERATION_OBSERVED'
      using errcode = '55000';
  end if;

  insert into public.whatsapp_coexistence_sync_generation_failures (
    account_id,
    sync_type,
    sync_generation_id,
    request_id,
    failure_kind,
    error,
    metadata,
    failed_at
  ) values (
    p_account_id,
    p_sync_type,
    p_generation_id,
    current_request_id,
    clean_failure_kind,
    clean_error,
    p_metadata,
    p_failed_at
  );

  perform public.refresh_whatsapp_coexistence_sync_state(p_account_id);
  select * into current_account
  from public.whatsapp_coexistence_accounts
  where id = p_account_id;
  return current_account;
end;
$$;

create or replace function public.record_whatsapp_coexistence_sync_request(
  p_account_id uuid,
  p_sync_type text,
  p_generation_id uuid,
  p_request_id text,
  p_requested_at timestamptz default clock_timestamp()
)
returns public.whatsapp_coexistence_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.whatsapp_coexistence_accounts%rowtype;
  clean_request_id text := trim(coalesce(p_request_id, ''));
begin
  perform public.assert_whatsapp_coexistence_service_role();
  if p_sync_type not in ('history', 'smb_app_state_sync')
    or p_generation_id is null
    or char_length(clean_request_id) not between 1 and 240
    or p_requested_at is null then
    raise exception 'WHATSAPP_COEXISTENCE_SYNC_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  select * into result
  from public.whatsapp_coexistence_accounts
  where id = p_account_id
  for update;
  if not found then
    raise exception 'WHATSAPP_COEXISTENCE_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if (p_sync_type = 'history' and (
      result.history_sync_generation_id <> p_generation_id
      or (
        result.history_request_id is not null
        and result.history_request_id <> clean_request_id
      )
    )) or (
      p_sync_type = 'smb_app_state_sync'
      and (
        result.app_state_sync_generation_id <> p_generation_id
        or (
          result.app_state_sync_request_id is not null
          and result.app_state_sync_request_id <> clean_request_id
        )
      )
    ) then
    raise exception 'WHATSAPP_COEXISTENCE_SYNC_REQUEST_STALE'
      using errcode = '55000';
  end if;

  update public.whatsapp_coexistence_accounts
  set
    history_request_id = case when p_sync_type = 'history'
      then clean_request_id else history_request_id end,
    history_requested_at = case when p_sync_type = 'history'
      then p_requested_at else history_requested_at end,
    app_state_sync_request_id = case when p_sync_type = 'smb_app_state_sync'
      then clean_request_id else app_state_sync_request_id end,
    app_state_sync_requested_at = case when p_sync_type = 'smb_app_state_sync'
      then p_requested_at else app_state_sync_requested_at end
  where id = p_account_id
  returning * into result;

  return result;
end;
$$;

create or replace function public.upsert_whatsapp_coexistence_sync_batch(
  p_account_id uuid,
  p_event_id uuid,
  p_lease_token uuid,
  p_external_batch_id text,
  p_sync_type text,
  p_phase text,
  p_chunk_order integer,
  p_progress numeric,
  p_status text default 'processing',
  p_item_count integer default 0,
  p_processed_count integer default 0,
  p_failed_count integer default 0,
  p_error text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.whatsapp_coexistence_sync_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  current_event public.whatsapp_coexistence_events%rowtype;
  result public.whatsapp_coexistence_sync_batches%rowtype;
  clean_batch_id text := trim(coalesce(p_external_batch_id, ''));
begin
  current_event := public.require_whatsapp_coexistence_event_lease(
    p_event_id,
    p_lease_token
  );

  if current_event.account_id <> p_account_id
    or p_sync_type not in ('history', 'smb_app_state_sync')
    or current_event.field <> p_sync_type
    or current_event.sync_generation_id is null
    or char_length(clean_batch_id) not between 1 and 240
    or p_status not in ('pending', 'processing', 'completed', 'failed')
    or (p_phase is not null and nullif(trim(p_phase), '') is null)
    or (p_chunk_order is not null and p_chunk_order < 0)
    or (p_progress is not null and p_progress not between 0 and 100)
    or coalesce(p_item_count, -1) < 0
    or coalesce(p_processed_count, -1) < 0
    or coalesce(p_failed_count, -1) < 0
    or (
      p_item_count > 0
      and p_processed_count + p_failed_count > p_item_count
    )
    or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'WHATSAPP_COEXISTENCE_SYNC_BATCH_INVALID'
      using errcode = '22023';
  end if;

  insert into public.whatsapp_coexistence_sync_batches (
    account_id,
    event_id,
    sync_generation_id,
    external_batch_id,
    sync_type,
    phase,
    chunk_order,
    progress,
    status,
    item_count,
    processed_count,
    failed_count,
    last_error,
    metadata,
    completed_at
  ) values (
    p_account_id,
    p_event_id,
    current_event.sync_generation_id,
    clean_batch_id,
    p_sync_type,
    nullif(trim(coalesce(p_phase, '')), ''),
    p_chunk_order,
    p_progress,
    p_status,
    p_item_count,
    p_processed_count,
    p_failed_count,
    nullif(left(trim(coalesce(p_error, '')), 2000), ''),
    coalesce(p_metadata, '{}'::jsonb),
    case when p_status = 'completed' then clock_timestamp() else null end
  )
  on conflict (
    account_id, sync_type, sync_generation_id, external_batch_id
  ) do update
  set
    phase = coalesce(excluded.phase, whatsapp_coexistence_sync_batches.phase),
    chunk_order = coalesce(
      excluded.chunk_order,
      whatsapp_coexistence_sync_batches.chunk_order
    ),
    progress = case
      when excluded.progress is null
        then whatsapp_coexistence_sync_batches.progress
      when whatsapp_coexistence_sync_batches.progress is null
        then excluded.progress
      else greatest(
        whatsapp_coexistence_sync_batches.progress,
        excluded.progress
      )
    end,
    status = case
      when whatsapp_coexistence_sync_batches.status = 'completed'
        then 'completed'
      else excluded.status
    end,
    item_count = greatest(
      whatsapp_coexistence_sync_batches.item_count,
      excluded.item_count
    ),
    processed_count = greatest(
      whatsapp_coexistence_sync_batches.processed_count,
      excluded.processed_count
    ),
    failed_count = case
      when whatsapp_coexistence_sync_batches.status = 'completed'
        then whatsapp_coexistence_sync_batches.failed_count
      when excluded.status = 'completed' and excluded.failed_count = 0 then 0
      else greatest(
        whatsapp_coexistence_sync_batches.failed_count,
        excluded.failed_count
      )
    end,
    last_error = case
      when whatsapp_coexistence_sync_batches.status = 'completed'
        then whatsapp_coexistence_sync_batches.last_error
      when excluded.status = 'completed' and excluded.failed_count = 0
        then null
      else coalesce(
        excluded.last_error,
        whatsapp_coexistence_sync_batches.last_error
      )
    end,
    metadata = whatsapp_coexistence_sync_batches.metadata || excluded.metadata,
    last_received_at = clock_timestamp(),
    completed_at = case
      when excluded.status = 'completed'
        then coalesce(
          whatsapp_coexistence_sync_batches.completed_at,
          clock_timestamp()
        )
      else whatsapp_coexistence_sync_batches.completed_at
    end
  where whatsapp_coexistence_sync_batches.event_id = excluded.event_id
  returning * into result;

  if result.id is null then
    raise exception 'WHATSAPP_COEXISTENCE_SYNC_BATCH_ID_COLLISION'
      using errcode = '23505';
  end if;

  perform public.refresh_whatsapp_coexistence_sync_state(p_account_id);

  return result;
end;
$$;

create or replace function public.ingest_whatsapp_coexistence_contact(
  p_account_id uuid,
  p_event_id uuid,
  p_lease_token uuid,
  p_action text,
  p_phone_e164 text,
  p_whatsapp_id text,
  p_full_name text,
  p_source_timestamp timestamptz,
  p_metadata jsonb default '{}'::jsonb
)
returns public.contacts
language plpgsql
security definer
set search_path = public
as $$
declare
  current_event public.whatsapp_coexistence_events%rowtype;
  current_mapping public.whatsapp_coexistence_contacts%rowtype;
  result public.contacts%rowtype;
  phone_contact_id uuid;
  whatsapp_contact_id uuid;
  phone_mapping_id uuid;
  whatsapp_mapping_id uuid;
  clean_phone text := trim(coalesce(p_phone_e164, ''));
  clean_whatsapp_id text := nullif(
    regexp_replace(coalesce(p_whatsapp_id, ''), '\D', '', 'g'),
    ''
  );
  clean_name text := nullif(left(trim(coalesce(p_full_name, '')), 120), '');
  source_at timestamptz := coalesce(p_source_timestamp, clock_timestamp());
begin
  current_event := public.require_whatsapp_coexistence_event_lease(
    p_event_id,
    p_lease_token
  );

  if current_event.account_id <> p_account_id
    or current_event.field <> 'smb_app_state_sync'
    or p_action not in ('add', 'remove')
    or clean_phone !~ '^\+[1-9][0-9]{7,14}$'
    or (
      clean_whatsapp_id is not null
      and clean_whatsapp_id !~ '^[0-9]{8,15}$'
    )
    or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'WHATSAPP_COEXISTENCE_CONTACT_INVALID'
      using errcode = '22023';
  end if;

  select mapping.id into phone_mapping_id
  from public.whatsapp_coexistence_contacts mapping
  where mapping.account_id = p_account_id
    and mapping.phone_e164 = clean_phone;

  if clean_whatsapp_id is not null then
    select mapping.id into whatsapp_mapping_id
    from public.whatsapp_coexistence_contacts mapping
    where mapping.account_id = p_account_id
      and mapping.whatsapp_id = clean_whatsapp_id;
  end if;

  if phone_mapping_id is not null
    and whatsapp_mapping_id is not null
    and phone_mapping_id <> whatsapp_mapping_id then
    raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
      using errcode = '23505';
  end if;

  if coalesce(phone_mapping_id, whatsapp_mapping_id) is not null then
    select * into current_mapping
    from public.whatsapp_coexistence_contacts mapping
    where mapping.id = coalesce(phone_mapping_id, whatsapp_mapping_id)
    for update;

    if current_mapping.whatsapp_id is not null
      and clean_whatsapp_id is not null
      and current_mapping.whatsapp_id <> clean_whatsapp_id then
      raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
        using errcode = '23505';
    end if;
  end if;

  -- State-sync changes may be delivered out of order. Meta timestamps have
  -- second precision, so equal-time opposing actions need an explicit rule:
  -- remove wins and an equal-time add cannot resurrect the contact.
  if found and (
    source_at < current_mapping.source_timestamp
    or (
      source_at = current_mapping.source_timestamp
      and current_mapping.app_state = 'removed'
      and p_action = 'add'
    )
  ) then
    if current_mapping.contact_id is not null then
      select * into result
      from public.contacts
      where id = current_mapping.contact_id;
    end if;
    return result;
  end if;

  select id into phone_contact_id
  from public.contacts
  where phone_e164 = clean_phone
  limit 1
  for update;

  if clean_whatsapp_id is not null then
    select id into whatsapp_contact_id
    from public.contacts
    where whatsapp_id = clean_whatsapp_id
    limit 1
    for update;
  end if;

  if phone_contact_id is not null
    and whatsapp_contact_id is not null
    and phone_contact_id <> whatsapp_contact_id then
    raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
      using errcode = '23505';
  end if;

  if coalesce(phone_contact_id, whatsapp_contact_id) is not null then
    select * into result
    from public.contacts
    where id = coalesce(phone_contact_id, whatsapp_contact_id)
    for update;

    if result.whatsapp_id is not null
      and clean_whatsapp_id is not null
      and result.whatsapp_id <> clean_whatsapp_id then
      raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
        using errcode = '23505';
    end if;
  end if;

  if p_action = 'add' then
    if result.id is null then
      begin
        insert into public.contacts (
          phone_e164,
          whatsapp_id,
          name
        ) values (
          clean_phone,
          clean_whatsapp_id,
          coalesce(clean_name, 'Paciente')
        )
        returning * into result;
      exception when unique_violation then
        phone_contact_id := null;
        whatsapp_contact_id := null;

        select id into phone_contact_id
        from public.contacts
        where phone_e164 = clean_phone
        limit 1
        for update;

        if clean_whatsapp_id is not null then
          select id into whatsapp_contact_id
          from public.contacts
          where whatsapp_id = clean_whatsapp_id
          limit 1
          for update;
        end if;

        if phone_contact_id is not null
          and whatsapp_contact_id is not null
          and phone_contact_id <> whatsapp_contact_id then
          raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
            using errcode = '23505';
        end if;
        if coalesce(phone_contact_id, whatsapp_contact_id) is null then
          raise;
        end if;

        select * into result
        from public.contacts
        where id = coalesce(phone_contact_id, whatsapp_contact_id)
        for update;
      end;
    else
      update public.contacts
      set
        whatsapp_id = coalesce(whatsapp_id, clean_whatsapp_id),
        name = case
          when clean_name is null then name
          when name = 'Paciente'
            or name = phone_e164
            or (
              current_mapping.profile_name is not null
              and name = current_mapping.profile_name
            )
            then clean_name
          else name
        end
      where id = result.id
      returning * into result;
    end if;
  end if;

  if current_mapping.id is null then
    begin
      insert into public.whatsapp_coexistence_contacts (
        account_id,
        last_event_id,
        contact_id,
        whatsapp_id,
        phone_e164,
        profile_name,
        app_state,
        source_timestamp,
        metadata
      ) values (
        p_account_id,
        p_event_id,
        result.id,
        clean_whatsapp_id,
        clean_phone,
        clean_name,
        case when p_action = 'remove' then 'removed' else 'active' end,
        source_at,
        coalesce(p_metadata, '{}'::jsonb)
      )
      on conflict (account_id, phone_e164) do update
      set
        last_event_id = case
          when excluded.source_timestamp
            > whatsapp_coexistence_contacts.source_timestamp
            or (
              excluded.source_timestamp
                = whatsapp_coexistence_contacts.source_timestamp
              and excluded.app_state = 'removed'
              and whatsapp_coexistence_contacts.app_state <> 'removed'
            ) then excluded.last_event_id
          else whatsapp_coexistence_contacts.last_event_id
        end,
        contact_id = coalesce(
          whatsapp_coexistence_contacts.contact_id,
          excluded.contact_id
        ),
        whatsapp_id = coalesce(
          whatsapp_coexistence_contacts.whatsapp_id,
          excluded.whatsapp_id
        ),
        profile_name = case
          when excluded.source_timestamp
            > whatsapp_coexistence_contacts.source_timestamp
            then coalesce(
              excluded.profile_name,
              whatsapp_coexistence_contacts.profile_name
            )
          else whatsapp_coexistence_contacts.profile_name
        end,
        app_state = case
          when excluded.source_timestamp
            > whatsapp_coexistence_contacts.source_timestamp
            then excluded.app_state
          when excluded.source_timestamp
            = whatsapp_coexistence_contacts.source_timestamp
            and excluded.app_state = 'removed' then 'removed'
          else whatsapp_coexistence_contacts.app_state
        end,
        source_timestamp = greatest(
          whatsapp_coexistence_contacts.source_timestamp,
          excluded.source_timestamp
        ),
        metadata = case
          when excluded.source_timestamp
            > whatsapp_coexistence_contacts.source_timestamp
            or (
              excluded.source_timestamp
                = whatsapp_coexistence_contacts.source_timestamp
              and excluded.app_state = 'removed'
              and whatsapp_coexistence_contacts.app_state <> 'removed'
            ) then whatsapp_coexistence_contacts.metadata || excluded.metadata
          else whatsapp_coexistence_contacts.metadata
        end;
    exception when unique_violation then
      raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
        using errcode = '23505';
    end;
  else
    if current_mapping.phone_e164 <> clean_phone
      and exists (
        select 1
        from public.whatsapp_coexistence_contacts other_mapping
        where other_mapping.account_id = p_account_id
          and other_mapping.phone_e164 = clean_phone
          and other_mapping.id <> current_mapping.id
      ) then
      raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
        using errcode = '23505';
    end if;

    update public.whatsapp_coexistence_contacts
    set
      last_event_id = p_event_id,
      contact_id = coalesce(result.id, contact_id),
      whatsapp_id = coalesce(clean_whatsapp_id, whatsapp_id),
      phone_e164 = clean_phone,
      profile_name = coalesce(clean_name, profile_name),
      app_state = case
        when p_action = 'remove' then 'removed'
        else 'active'
      end,
      source_timestamp = source_at,
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb)
    where id = current_mapping.id;
  end if;

  select * into current_mapping
  from public.whatsapp_coexistence_contacts mapping
  where mapping.account_id = p_account_id
    and mapping.phone_e164 = clean_phone
  for update;
  if current_mapping.whatsapp_id is not null
    and clean_whatsapp_id is not null
    and current_mapping.whatsapp_id <> clean_whatsapp_id then
    raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
      using errcode = '23505';
  end if;
  if current_mapping.contact_id is not null
    and result.id is not null
    and current_mapping.contact_id <> result.id then
    raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
      using errcode = '23505';
  end if;

  if result.id is not null and (
    result.phone_e164 <> clean_phone
    or (
      result.whatsapp_id is not null
      and clean_whatsapp_id is not null
      and result.whatsapp_id <> clean_whatsapp_id
    )
  ) then
    raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
      using errcode = '23505';
  end if;

  return result;
end;
$$;

create or replace function public.guard_whatsapp_coexistence_message_context()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.whatsapp_origin <> 'cloud_api' then
    if coalesce(auth.role(), '') <> 'service_role'
      or coalesce(
        current_setting('app.whatsapp_coexistence_ingest', true),
        ''
      ) <> 'on' then
      raise exception 'WHATSAPP_COEXISTENCE_INGEST_RPC_REQUIRED'
        using errcode = '42501';
    end if;

    if new.coexistence_account_id is null
      or new.coexistence_event_id is null
      or new.whatsapp_message_id is null
      or nullif(trim(coalesce(new.whatsapp_message_type, '')), '') is null then
      raise exception 'WHATSAPP_COEXISTENCE_MESSAGE_CONTEXT_INVALID'
        using errcode = '23514';
    end if;

    if new.whatsapp_origin = 'smb_message_echoes'
      and new.direction <> 'outbound' then
      raise exception 'WHATSAPP_COEXISTENCE_ECHO_DIRECTION_INVALID'
        using errcode = '23514';
    end if;

    if new.whatsapp_origin = 'history'
      and new.coexistence_batch_id is null then
      raise exception 'WHATSAPP_COEXISTENCE_BATCH_CONTEXT_INVALID'
        using errcode = '23514';
    end if;

    if new.whatsapp_origin = 'smb_message_echoes'
      and new.whatsapp_message_type in ('edit', 'revoke')
      and new.original_whatsapp_message_id is null then
      raise exception 'WHATSAPP_COEXISTENCE_MUTATION_INVALID'
        using errcode = '23514';
    end if;

    if new.whatsapp_origin = 'meta_message_mutation'
      and (
        new.direction <> 'inbound'
        or
        new.whatsapp_message_type not in ('edit', 'revoke')
        or new.original_whatsapp_message_id is null
      ) then
      raise exception 'WHATSAPP_COEXISTENCE_MUTATION_INVALID'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create trigger aab_messages_guard_whatsapp_coexistence
  before insert or update of
    whatsapp_origin,
    coexistence_account_id,
    coexistence_event_id,
    coexistence_batch_id,
    whatsapp_message_type,
    original_whatsapp_message_id,
    direction,
    conversation_id,
    contact_id
  on public.messages
  for each row execute function public.guard_whatsapp_coexistence_message_context();

-- Preserve the policy itself while excluding edit/revoke audit rows from send
-- counters. Normal history/echo messages have no original WAMID and therefore
-- still count at their real source timestamp.
create or replace function public.enforce_whatsapp_outbound_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.whatsapp_settings%rowtype;
  contact public.contacts%rowtype;
  conversation public.conversations%rowtype;
  template public.message_templates%rowtype;
  consent_event_id uuid;
  appointment_is_valid boolean;
  recent_count integer;
  policy_basis text;
begin
  if new.direction <> 'outbound' then
    return new;
  end if;

  if tg_op = 'UPDATE'
    and not (
      old.direction = 'outbound'
      and old.status = 'failed'
      and new.status = 'pending'
    ) then
    return new;
  end if;

  if session_user in ('postgres', 'supabase_admin')
    and current_setting('app.whatsapp_policy_seed_bypass', true) = 'on' then
    return new;
  end if;

  if nullif(trim(coalesce(new.idempotency_key, '')), '') is null then
    raise exception 'POLICY_IDEMPOTENCY_REQUIRED' using errcode = 'P0001';
  end if;

  select * into settings
  from public.whatsapp_settings
  where id = true;
  if not found or settings.sending_paused then
    raise exception 'POLICY_SENDING_PAUSED' using errcode = 'P0001';
  end if;

  select * into contact
  from public.contacts
  where id = new.contact_id
  for update;
  if not found then
    raise exception 'POLICY_CONTACT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into conversation
  from public.conversations
  where id = new.conversation_id;
  if not found or conversation.contact_id <> new.contact_id then
    raise exception 'POLICY_CONVERSATION_CONTACT_MISMATCH'
      using errcode = '23514';
  end if;

  if new.type = 'template' then
    if settings.quality_rating <> 'GREEN' then
      raise exception 'POLICY_NUMBER_QUALITY_UNVERIFIED' using errcode = 'P0001';
    end if;

    select * into template
    from public.message_templates candidate
    where candidate.meta_name = new.template_name
      and candidate.key = new.metadata ->> 'template_key'
    limit 1;

    if not found
      or not template.enabled
      or template.meta_status <> 'APPROVED'
      or upper(coalesce(template.category, '')) <> 'UTILITY'
      or template.quality_rating in ('RED') then
      raise exception 'POLICY_TEMPLATE_NOT_APPROVED' using errcode = 'P0001';
    end if;

    select event.id into consent_event_id
    from public.whatsapp_consent_events event
    where event.contact_id = new.contact_id
      and event.purpose in ('appointment_updates', 'all')
    order by event.sequence_number desc
    limit 1;

    if not public.has_active_whatsapp_consent(
      new.contact_id,
      'appointment_updates'
    ) then
      raise exception 'POLICY_CONSENT_REQUIRED' using errcode = 'P0001';
    end if;

    select exists (
      select 1
      from public.appointments appointment
      where appointment.id::text = new.metadata ->> 'appointment_id'
        and appointment.contact_id = new.contact_id
        and (
          template.key not in (
            'appointment_reminder_24h', 'appointment_reminder_2h'
          )
          or (
            appointment.status in ('scheduled', 'confirmed')
            and appointment.starts_at > now()
          )
        )
    ) into appointment_is_valid;
    if not appointment_is_valid then
      raise exception 'POLICY_APPOINTMENT_CONTEXT_REQUIRED'
        using errcode = 'P0001';
    end if;

    select count(*) into recent_count
    from public.messages message
    where message.contact_id = new.contact_id
      and message.direction = 'outbound'
      and message.type = 'template'
      and message.status <> 'failed'
      and message.original_whatsapp_message_id is null
      and message.created_at > now() - interval '24 hours';
    if recent_count >= 3 then
      raise exception 'POLICY_TEMPLATE_RATE_LIMIT' using errcode = 'P0001';
    end if;

    policy_basis := 'explicit_appointment_updates_consent';
  else
    if conversation.last_inbound_message_at is null
      or now() >= conversation.last_inbound_message_at + interval '24 hours' then
      raise exception 'POLICY_CUSTOMER_SERVICE_WINDOW_CLOSED'
        using errcode = 'P0001';
    end if;

    if contact.whatsapp_opt_out_at is not null
      and conversation.last_inbound_message_at <= contact.whatsapp_opt_out_at then
      raise exception 'POLICY_CONTACT_OPTED_OUT' using errcode = 'P0001';
    end if;

    policy_basis := 'customer_service_window';
  end if;

  select count(*) into recent_count
  from public.messages message
  where message.contact_id = new.contact_id
    and message.direction = 'outbound'
    and message.status <> 'failed'
    and message.original_whatsapp_message_id is null
    and message.created_at > now() - interval '1 hour';
  if recent_count >= 30 then
    raise exception 'POLICY_CONTACT_RATE_LIMIT' using errcode = 'P0001';
  end if;

  if new.metadata ->> 'source' = 'automation' then
    select count(*) into recent_count
    from public.messages message
    where message.contact_id = new.contact_id
      and message.direction = 'outbound'
      and message.status <> 'failed'
      and message.original_whatsapp_message_id is null
      and message.metadata ->> 'source' = 'automation'
      and message.created_at > now() - interval '10 minutes';
    if recent_count >= 10 then
      raise exception 'POLICY_AUTOMATION_RATE_LIMIT' using errcode = 'P0001';
    end if;
  end if;

  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'policy_decision', 'allowed',
    'policy_basis', policy_basis,
    'policy_version', settings.policy_version,
    'policy_authorized_at', clock_timestamp(),
    'consent_event_id', consent_event_id
  );

  return new;
end;
$$;

-- Preserve the existing policy functions, but do not invoke them for a row
-- inserted by the guarded Coexistence RPC. The transaction-local flag cannot
-- be supplied by a PostgREST table insert, and the guard also requires the
-- service-role JWT claim.
drop trigger if exists aa_messages_confirmed_reminders_only
  on public.messages;
create trigger aa_messages_confirmed_reminders_only
  before insert or update of status on public.messages
  for each row
  when (
    not (
      new.whatsapp_origin in (
        'history', 'smb_message_echoes', 'meta_message_mutation'
      )
      and coalesce(auth.role(), '') = 'service_role'
      and coalesce(
        current_setting('app.whatsapp_coexistence_ingest', true),
        ''
      ) = 'on'
    )
  )
  execute function public.guard_confirmed_reminder_message();

drop trigger if exists messages_enforce_whatsapp_policy
  on public.messages;
create trigger messages_enforce_whatsapp_policy
  before insert or update of status on public.messages
  for each row
  when (
    not (
      new.whatsapp_origin in (
        'history', 'smb_message_echoes', 'meta_message_mutation'
      )
      and coalesce(auth.role(), '') = 'service_role'
      and coalesce(
        current_setting('app.whatsapp_coexistence_ingest', true),
        ''
      ) = 'on'
    )
  )
  execute function public.enforce_whatsapp_outbound_policy();

create or replace function public.sync_conversation_after_message()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.whatsapp_origin = 'history' then
    -- Historical messages contribute only to historical activity. They do not
    -- open a customer-service window, become unread, or alter automation.
    update public.conversations
    set last_message_at = greatest(last_message_at, new.created_at)
    where id = new.conversation_id;

    update public.contacts
    set last_message_at = greatest(
      coalesce(last_message_at, new.created_at),
      new.created_at
    )
    where id = new.contact_id;
    return new;
  end if;

  if new.whatsapp_origin in (
    'smb_message_echoes', 'meta_message_mutation'
  ) then
    update public.conversations
    set
      automation_mode = case
        when new.whatsapp_origin = 'smb_message_echoes'
          then 'manual'::public.automation_mode
        else automation_mode
      end,
      needs_human = case
        when new.whatsapp_origin = 'smb_message_echoes'
          then false
        else needs_human
      end,
      last_message_at = greatest(last_message_at, new.created_at)
    where id = new.conversation_id;

    update public.contacts
    set last_message_at = greatest(
      coalesce(last_message_at, new.created_at),
      new.created_at
    )
    where id = new.contact_id;
    return new;
  end if;

  -- Unchanged behavior for ordinary Cloud API messages.
  update public.conversations
  set
    last_message_at = greatest(last_message_at, new.created_at),
    last_inbound_message_at = case
      when new.direction = 'inbound'
        then greatest(
          coalesce(last_inbound_message_at, new.created_at),
          new.created_at
        )
      else last_inbound_message_at
    end,
    unread_count = case
      when new.direction = 'inbound' then unread_count + 1
      else unread_count
    end,
    automation_mode = case
      when new.direction = 'outbound' and new.sent_by is not null
        then 'manual'::public.automation_mode
      else automation_mode
    end,
    needs_human = case
      when new.direction = 'outbound' and new.sent_by is not null then false
      else needs_human
    end
  where id = new.conversation_id;

  update public.contacts
  set last_message_at = greatest(
    coalesce(last_message_at, new.created_at),
    new.created_at
  )
  where id = new.contact_id;

  return new;
end;
$$;

create or replace function public.map_whatsapp_coexistence_message_type(
  p_whatsapp_message_type text
)
returns public.message_type
language sql
immutable
set search_path = public
as $$
  select case lower(trim(coalesce(p_whatsapp_message_type, '')))
    when 'text' then 'text'::public.message_type
    when 'image' then 'image'::public.message_type
    when 'document' then 'document'::public.message_type
    -- The current inbox has one generic downloadable attachment renderer.
    -- The original Meta type is always retained in whatsapp_message_type.
    when 'video' then 'document'::public.message_type
    when 'audio' then 'document'::public.message_type
    when 'sticker' then 'document'::public.message_type
    when 'interactive' then 'interactive'::public.message_type
    when 'button' then 'interactive'::public.message_type
    when 'template' then 'template'::public.message_type
    else 'system'::public.message_type
  end;
$$;

create or replace function public.get_or_create_whatsapp_coexistence_contact(
  p_phone_e164 text,
  p_whatsapp_id text,
  p_whatsapp_user_id text,
  p_name text
)
returns public.contacts
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.contacts%rowtype;
  candidate public.contacts%rowtype;
  clean_phone text := nullif(trim(coalesce(p_phone_e164, '')), '');
  clean_whatsapp_id text := nullif(
    regexp_replace(coalesce(p_whatsapp_id, ''), '\D', '', 'g'),
    ''
  );
  clean_user_id text := nullif(trim(coalesce(p_whatsapp_user_id, '')), '');
  clean_name text := coalesce(
    nullif(left(trim(coalesce(p_name, '')), 120), ''),
    'Paciente'
  );
begin
  perform public.assert_whatsapp_coexistence_service_role();

  if (clean_phone is null and clean_user_id is null)
    or (
      clean_phone is not null
      and clean_phone !~ '^\+[1-9][0-9]{7,14}$'
    )
    or (
      clean_whatsapp_id is not null
      and clean_whatsapp_id !~ '^[0-9]{8,15}$'
    )
    or (
      clean_user_id is not null
      and (
        char_length(clean_user_id) not between 1 and 256
        or clean_user_id !~ '^[A-Za-z0-9.]+$'
      )
    ) then
    raise exception 'WHATSAPP_COEXISTENCE_CONTACT_INVALID'
      using errcode = '22023';
  end if;

  -- Every identity producer uses these advisory locks. Sorting makes a
  -- payload that supplies both phone and BSUID deadlock-safe, while also
  -- closing concurrent first-insert races across webhook streams.
  perform pg_advisory_xact_lock(hashtextextended(identity_key, 811))
  from (
    select distinct identity_key
    from unnest(array[
      case when clean_phone is not null then 'phone:' || clean_phone end,
      case when clean_whatsapp_id is not null
        then 'wa:' || clean_whatsapp_id end,
      case when clean_user_id is not null then 'user:' || clean_user_id end
    ]) supplied(identity_key)
    where identity_key is not null
    order by identity_key
  ) locked_identity;

  for candidate in
    select contact.*
    from public.contacts contact
    where (
        (clean_phone is not null and contact.phone_e164 = clean_phone)
        or (
          clean_whatsapp_id is not null
          and contact.whatsapp_id = clean_whatsapp_id
        )
        or (
          clean_user_id is not null
          and contact.whatsapp_user_id = clean_user_id
        )
      )
    order by contact.id
    for update
  loop
    if result.id is not null and result.id <> candidate.id then
      raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
        using errcode = '23505';
    end if;
    result := candidate;
  end loop;

  if result.id is null then
    insert into public.contacts (
      phone_e164,
      whatsapp_id,
      whatsapp_user_id,
      name
    ) values (
      clean_phone,
      clean_whatsapp_id,
      clean_user_id,
      clean_name
    )
    returning * into result;
    return result;
  end if;

  if (result.phone_e164 is not null and clean_phone is not null
      and result.phone_e164 <> clean_phone)
    or (
      result.whatsapp_id is not null
      and clean_whatsapp_id is not null
      and result.whatsapp_id <> clean_whatsapp_id
    )
    or (
      result.whatsapp_user_id is not null
      and clean_user_id is not null
      and result.whatsapp_user_id <> clean_user_id
    ) then
    raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
      using errcode = '23505';
  end if;

  update public.contacts
  set
    phone_e164 = coalesce(phone_e164, clean_phone),
    whatsapp_id = coalesce(whatsapp_id, clean_whatsapp_id),
    whatsapp_user_id = coalesce(whatsapp_user_id, clean_user_id),
    name = case
      when name in ('Paciente', 'Contacto')
        or (phone_e164 is not null and name = phone_e164)
        then clean_name
      else name
    end
  where id = result.id
  returning * into result;

  return result;
end;
$$;

create or replace function public.get_or_create_whatsapp_coexistence_conversation(
  p_contact_id uuid,
  p_message_at timestamptz
)
returns public.conversations
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.conversations%rowtype;
  source_at timestamptz := coalesce(p_message_at, clock_timestamp());
begin
  perform public.assert_whatsapp_coexistence_service_role();

  select * into result
  from public.conversations
  where contact_id = p_contact_id
    and status = 'open'
  limit 1
  for update;

  if found then
    return result;
  end if;

  begin
    insert into public.conversations (
      contact_id,
      last_message_at,
      created_at
    ) values (
      p_contact_id,
      source_at,
      least(clock_timestamp(), source_at)
    )
    returning * into result;
  exception when unique_violation then
    select * into result
    from public.conversations
    where contact_id = p_contact_id
      and status = 'open'
    limit 1
    for update;
    if not found then
      raise;
    end if;
  end;

  return result;
end;
$$;

create or replace function public.reconcile_whatsapp_history_media(
  p_account_id uuid,
  p_whatsapp_message_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  enrichment public.whatsapp_coexistence_message_enrichments%rowtype;
  target_message public.messages%rowtype;
begin
  perform public.lock_whatsapp_message_wamid(p_whatsapp_message_id);

  select * into enrichment
  from public.whatsapp_coexistence_message_enrichments
  where account_id = p_account_id
    and whatsapp_message_id = p_whatsapp_message_id
  for update;
  if not found then
    return false;
  end if;

  select * into target_message
  from public.messages
  where whatsapp_message_id = p_whatsapp_message_id
    and (
      coexistence_account_id is null
      or coexistence_account_id = p_account_id
    )
  for update;
  if not found then
    return false;
  end if;

  update public.messages
  set
    type = public.map_whatsapp_coexistence_message_type(
      enrichment.whatsapp_message_type
    ),
    whatsapp_message_type = enrichment.whatsapp_message_type,
    body = coalesce(nullif(enrichment.body, ''), body),
    metadata = metadata
      || enrichment.metadata
      || jsonb_build_object(
        'history_media_followup', true,
        'history_media_enriched_at', clock_timestamp()
      )
  where id = target_message.id;

  update public.whatsapp_coexistence_message_enrichments
  set applied_at = clock_timestamp()
  where id = enrichment.id;
  return true;
end;
$$;

create or replace function public.reconcile_whatsapp_message_mutations(
  p_whatsapp_message_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target_message public.messages%rowtype;
  mutation public.messages%rowtype;
  changed boolean := false;
begin
  perform public.lock_whatsapp_message_wamid(p_whatsapp_message_id);

  select * into target_message
  from public.messages
  where whatsapp_message_id = p_whatsapp_message_id
    and whatsapp_origin <> 'meta_message_mutation'
  for update;
  if not found then
    return false;
  end if;

  for mutation in
    select candidate.*
    from public.messages candidate
    where candidate.whatsapp_origin in (
        'meta_message_mutation', 'smb_message_echoes'
      )
      and candidate.whatsapp_message_type in ('edit', 'revoke')
      and candidate.original_whatsapp_message_id = p_whatsapp_message_id
      and (
        target_message.coexistence_account_id is null
        or candidate.coexistence_account_id = target_message.coexistence_account_id
      )
    order by
      candidate.created_at,
      case candidate.whatsapp_message_type
        when 'edit' then 0
        when 'revoke' then 1
      end,
      candidate.whatsapp_message_id
  loop
    if mutation.whatsapp_message_type = 'edit'
      and target_message.revoked_at is null
      and (
        target_message.edited_at is null
        or mutation.created_at > target_message.edited_at
        or (
          mutation.created_at = target_message.edited_at
          and mutation.whatsapp_message_id > coalesce(
            target_message.metadata ->> 'last_edit_whatsapp_message_id',
            ''
          )
        )
      ) then
      update public.messages
      set
        body = coalesce(nullif(mutation.body, ''), body),
        type = case
          when nullif(
            trim(coalesce(mutation.metadata ->> 'content_type', '')),
            ''
          ) is not null
            then public.map_whatsapp_coexistence_message_type(
              mutation.metadata ->> 'content_type'
            )
          else type
        end,
        whatsapp_message_type = coalesce(
          nullif(
            left(
              trim(coalesce(mutation.metadata ->> 'content_type', '')),
              80
            ),
            ''
          ),
          whatsapp_message_type
        ),
        edited_at = mutation.created_at,
        metadata = metadata || jsonb_build_object(
          'last_edit_whatsapp_message_id', mutation.whatsapp_message_id,
          'edited_via_whatsapp_app', true
        )
      where id = target_message.id
      returning * into target_message;
      changed := true;
    elsif mutation.whatsapp_message_type = 'revoke'
      and (
        target_message.revoked_at is null
        or mutation.created_at > target_message.revoked_at
        or (
          mutation.created_at = target_message.revoked_at
          and mutation.whatsapp_message_id > coalesce(
            target_message.metadata ->> 'revoke_whatsapp_message_id',
            ''
          )
        )
      ) then
      update public.messages
      set
        body = 'Mensaje eliminado',
        revoked_at = mutation.created_at,
        metadata = metadata || jsonb_build_object(
          'revoke_whatsapp_message_id', mutation.whatsapp_message_id,
          'revoked_via_whatsapp', true
        )
      where id = target_message.id
      returning * into target_message;
      changed := true;
    end if;
  end loop;

  return changed;
end;
$$;

create or replace function public.reconcile_whatsapp_message_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.whatsapp_origin = 'history'
    and new.coexistence_account_id is not null then
    perform public.reconcile_whatsapp_history_media(
      new.coexistence_account_id,
      new.whatsapp_message_id
    );
  end if;

  perform public.reconcile_whatsapp_message_mutations(
    new.whatsapp_message_id
  );
  if new.original_whatsapp_message_id is not null then
    perform public.reconcile_whatsapp_message_mutations(
      new.original_whatsapp_message_id
    );
  end if;
  return new;
end;
$$;

-- Trigger helpers and internal primitives are not callable through PostgREST.
revoke execute on function public.assert_whatsapp_coexistence_service_role()
  from public, anon, authenticated, service_role;
revoke execute on function public.lock_whatsapp_message_wamid(text)
  from public, anon, authenticated, service_role;
revoke execute on function public.lock_whatsapp_message_before_insert()
  from public, anon, authenticated, service_role;
revoke execute on function public.assign_whatsapp_ingest_sequence()
  from public, anon, authenticated, service_role;
revoke execute on function public.require_whatsapp_coexistence_event_lease(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.refresh_whatsapp_coexistence_sync_state(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.guard_whatsapp_coexistence_message_context()
  from public, anon, authenticated, service_role;
revoke execute on function public.enforce_whatsapp_outbound_policy()
  from public, anon, authenticated, service_role;
revoke execute on function public.sync_conversation_after_message()
  from public, anon, authenticated, service_role;
revoke execute on function public.map_whatsapp_coexistence_message_type(text)
  from public, anon, authenticated, service_role;
revoke execute on function public.get_or_create_whatsapp_coexistence_contact(text, text, text, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.get_or_create_whatsapp_coexistence_conversation(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke execute on function public.reconcile_whatsapp_history_media(uuid, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.reconcile_whatsapp_message_mutations(text)
  from public, anon, authenticated, service_role;
revoke execute on function public.reconcile_whatsapp_message_after_insert()
  from public, anon, authenticated, service_role;
revoke execute on function public.reserve_whatsapp_automation_dispatch_after_message()
  from public, anon, authenticated, service_role;

-- Public RPC surface for Edge Functions / async processors. Browser roles are
-- revoked; Coexistence/worker RPCs also verify auth.role() internally.
revoke execute on function public.cleanup_webhook_events(integer)
  from public, anon, authenticated;
grant execute on function public.cleanup_webhook_events(integer)
  to service_role;

revoke execute on function public.upsert_whatsapp_coexistence_account(
  text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.upsert_whatsapp_coexistence_account(
  text, text, text, text, jsonb
) to service_role;

revoke execute on function public.enqueue_whatsapp_coexistence_event(
  uuid, text, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.enqueue_whatsapp_coexistence_event(
  uuid, text, text, jsonb, jsonb
) to service_role;

revoke execute on function public.claim_whatsapp_coexistence_events(integer)
  from public, anon, authenticated;
grant execute on function public.claim_whatsapp_coexistence_events(integer)
  to service_role;

revoke execute on function public.checkpoint_whatsapp_coexistence_event(
  uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.checkpoint_whatsapp_coexistence_event(
  uuid, uuid, jsonb
) to service_role;

revoke execute on function public.complete_whatsapp_coexistence_event(
  uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_whatsapp_coexistence_event(
  uuid, uuid, jsonb
) to service_role;

revoke execute on function public.fail_whatsapp_coexistence_event(
  uuid, uuid, text, boolean, jsonb
) from public, anon, authenticated;
grant execute on function public.fail_whatsapp_coexistence_event(
  uuid, uuid, text, boolean, jsonb
) to service_role;

revoke execute on function public.requeue_whatsapp_coexistence_event(uuid)
  from public, anon, authenticated;
grant execute on function public.requeue_whatsapp_coexistence_event(uuid)
  to service_role;

revoke execute on function public.claim_whatsapp_webhook_event(
  text, text, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.claim_whatsapp_webhook_event(
  text, text, jsonb, integer
) to service_role;

revoke execute on function public.complete_whatsapp_webhook_event(
  text, public.webhook_event_status, text
) from public, anon, authenticated;
grant execute on function public.complete_whatsapp_webhook_event(
  text, public.webhook_event_status, text
) to service_role;

revoke execute on function public.enqueue_whatsapp_automation_dispatch(
  uuid, text
) from public, anon, authenticated;
grant execute on function public.enqueue_whatsapp_automation_dispatch(
  uuid, text
) to service_role;

revoke execute on function public.finalize_whatsapp_inbound_webhook(
  uuid, text, boolean
) from public, anon, authenticated;
grant execute on function public.finalize_whatsapp_inbound_webhook(
  uuid, text, boolean
) to service_role;

revoke execute on function public.claim_whatsapp_automation_dispatches(integer)
  from public, anon, authenticated;
grant execute on function public.claim_whatsapp_automation_dispatches(integer)
  to service_role;

revoke execute on function public.complete_whatsapp_automation_dispatch(
  uuid, uuid
) from public, anon, authenticated;
grant execute on function public.complete_whatsapp_automation_dispatch(
  uuid, uuid
) to service_role;

revoke execute on function public.fail_whatsapp_automation_dispatch(
  uuid, uuid, text, boolean
) from public, anon, authenticated;
grant execute on function public.fail_whatsapp_automation_dispatch(
  uuid, uuid, text, boolean
) to service_role;

revoke execute on function public.requeue_whatsapp_automation_dispatch(uuid)
  from public, anon, authenticated;
grant execute on function public.requeue_whatsapp_automation_dispatch(uuid)
  to service_role;

revoke execute on function public.start_whatsapp_coexistence_sync_generation(
  uuid, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.start_whatsapp_coexistence_sync_generation(
  uuid, text, text, timestamptz
) to service_role;

revoke execute on function public.fail_whatsapp_coexistence_sync_generation(
  uuid, text, uuid, text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.fail_whatsapp_coexistence_sync_generation(
  uuid, text, uuid, text, text, jsonb, timestamptz
) to service_role;

revoke execute on function public.record_whatsapp_coexistence_sync_request(
  uuid, text, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_whatsapp_coexistence_sync_request(
  uuid, text, uuid, text, timestamptz
) to service_role;

revoke execute on function public.upsert_whatsapp_coexistence_sync_batch(
  uuid, uuid, uuid, text, text, text, integer, numeric, text,
  integer, integer, integer, text, jsonb
) from public, anon, authenticated;
grant execute on function public.upsert_whatsapp_coexistence_sync_batch(
  uuid, uuid, uuid, text, text, text, integer, numeric, text,
  integer, integer, integer, text, jsonb
) to service_role;

revoke execute on function public.ingest_whatsapp_coexistence_contact(
  uuid, uuid, uuid, text, text, text, text, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.ingest_whatsapp_coexistence_contact(
  uuid, uuid, uuid, text, text, text, text, timestamptz, jsonb
) to service_role;

revoke execute on function public.apply_whatsapp_message_status(
  text, public.message_status, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_whatsapp_message_status(
  text, public.message_status, timestamptz, jsonb
) to service_role;

create trigger messages_reconcile_whatsapp_coexistence
  after insert or update of
    whatsapp_message_id,
    original_whatsapp_message_id
  on public.messages
  for each row execute function public.reconcile_whatsapp_message_after_insert();

create or replace function public.ingest_whatsapp_history_media_followup(
  p_account_id uuid,
  p_event_id uuid,
  p_lease_token uuid,
  p_whatsapp_message_id text,
  p_message_type text,
  p_body text,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_event public.whatsapp_coexistence_events%rowtype;
  clean_message_id text := trim(coalesce(p_whatsapp_message_id, ''));
  clean_type text := lower(trim(coalesce(p_message_type, '')));
  applied boolean;
begin
  current_event := public.require_whatsapp_coexistence_event_lease(
    p_event_id,
    p_lease_token
  );
  if current_event.account_id <> p_account_id
    or current_event.field <> 'history'
    or char_length(clean_message_id) not between 8 and 240
    or clean_type not in ('image', 'video', 'document', 'audio', 'sticker')
    or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'WHATSAPP_HISTORY_MEDIA_FOLLOWUP_INVALID'
      using errcode = '22023';
  end if;

  perform public.lock_whatsapp_message_wamid(clean_message_id);

  if exists (
    select 1
    from public.messages message
    where message.whatsapp_message_id = clean_message_id
      and message.coexistence_account_id is not null
      and message.coexistence_account_id <> p_account_id
  ) or exists (
    select 1
    from public.whatsapp_coexistence_message_enrichments enrichment
    where enrichment.whatsapp_message_id = clean_message_id
      and enrichment.account_id <> p_account_id
  ) then
    raise exception 'WHATSAPP_COEXISTENCE_MESSAGE_IDENTITY_CONFLICT'
      using errcode = '23505';
  end if;

  insert into public.whatsapp_coexistence_message_enrichments (
    account_id,
    event_id,
    whatsapp_message_id,
    whatsapp_message_type,
    body,
    metadata
  ) values (
    p_account_id,
    p_event_id,
    clean_message_id,
    clean_type,
    p_body,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (account_id, whatsapp_message_id) do update
  set
    event_id = excluded.event_id,
    whatsapp_message_type = excluded.whatsapp_message_type,
    body = coalesce(excluded.body, whatsapp_coexistence_message_enrichments.body),
    metadata = whatsapp_coexistence_message_enrichments.metadata
      || excluded.metadata,
    received_at = clock_timestamp(),
    applied_at = null;

  perform set_config('app.whatsapp_coexistence_ingest', 'on', true);
  applied := public.reconcile_whatsapp_history_media(
    p_account_id,
    clean_message_id
  );
  perform set_config('app.whatsapp_coexistence_ingest', 'off', true);
  return applied;
end;
$$;

create or replace function public.ingest_whatsapp_coexistence_message(
  p_account_id uuid,
  p_event_id uuid,
  p_lease_token uuid,
  p_batch_id uuid,
  p_source text,
  p_whatsapp_message_id text,
  p_contact_phone_e164 text,
  p_contact_whatsapp_id text,
  p_contact_user_id text,
  p_contact_name text,
  p_direction public.message_direction,
  p_message_type text,
  p_body text,
  p_status public.message_status,
  p_message_at timestamptz,
  p_original_whatsapp_message_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns public.messages
language plpgsql
security definer
set search_path = public
as $$
declare
  current_event public.whatsapp_coexistence_events%rowtype;
  contact public.contacts%rowtype;
  conversation public.conversations%rowtype;
  result public.messages%rowtype;
  clean_message_id text := trim(coalesce(p_whatsapp_message_id, ''));
  clean_original_message_id text := nullif(
    trim(coalesce(p_original_whatsapp_message_id, '')),
    ''
  );
  clean_type text := lower(trim(coalesce(p_message_type, '')));
  message_origin text;
  source_at timestamptz := coalesce(p_message_at, clock_timestamp());
  initial_status public.message_status;
  database_type public.message_type;
  message_body text;
  message_metadata jsonb;
  inserted boolean := false;
begin
  current_event := public.require_whatsapp_coexistence_event_lease(
    p_event_id,
    p_lease_token
  );

  message_origin := case p_source
    when 'history' then 'history'
    when 'smb_message_echoes' then 'smb_message_echoes'
    when 'messages' then 'meta_message_mutation'
    else null
  end;
  database_type := public.map_whatsapp_coexistence_message_type(clean_type);
  initial_status := coalesce(
    p_status,
    case
      when p_direction = 'outbound' then 'sent'::public.message_status
      else 'delivered'::public.message_status
    end
  );
  message_body := coalesce(
    p_body,
    case clean_type
      when 'image' then 'Imagen'
      when 'video' then 'Video'
      when 'document' then 'Documento'
      when 'audio' then 'Audio'
      when 'sticker' then 'Sticker'
      when 'revoke' then 'Mensaje eliminado'
      when 'edit' then 'Mensaje editado'
      else ''
    end
  );

  if current_event.account_id <> p_account_id
    or message_origin is null
    or current_event.field <> p_source
    or char_length(clean_message_id) not between 8 and 240
    or char_length(clean_type) not between 1 and 80
    or p_direction is null
    or p_message_at is null
    or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object'
    or (
      clean_original_message_id is not null
      and char_length(clean_original_message_id) not between 8 and 240
    ) then
    raise exception 'WHATSAPP_COEXISTENCE_MESSAGE_INVALID'
      using errcode = '22023';
  end if;

  if p_source = 'smb_message_echoes' and p_direction <> 'outbound' then
    raise exception 'WHATSAPP_COEXISTENCE_ECHO_DIRECTION_INVALID'
      using errcode = '22023';
  end if;
  if p_source = 'smb_message_echoes'
    and clean_type in ('edit', 'revoke')
    and clean_original_message_id is null then
    raise exception 'WHATSAPP_COEXISTENCE_MUTATION_INVALID'
      using errcode = '22023';
  end if;
  if p_source = 'messages'
    and (
      p_direction <> 'inbound'
      or
      clean_type not in ('edit', 'revoke')
      or clean_original_message_id is null
    ) then
    raise exception 'WHATSAPP_COEXISTENCE_MUTATION_INVALID'
      using errcode = '22023';
  end if;

  -- Lock both the mutation event WAMID and its target in lexical order. This
  -- shares the same lock namespace as the messages BEFORE INSERT trigger and
  -- prevents deadlocks when two related mutations arrive concurrently.
  if clean_original_message_id is not null
    and clean_original_message_id < clean_message_id then
    perform public.lock_whatsapp_message_wamid(clean_original_message_id);
    perform public.lock_whatsapp_message_wamid(clean_message_id);
  else
    perform public.lock_whatsapp_message_wamid(clean_message_id);
    if clean_original_message_id is not null then
      perform public.lock_whatsapp_message_wamid(clean_original_message_id);
    end if;
  end if;

  if p_source = 'history' then
    if p_batch_id is null then
      raise exception 'WHATSAPP_COEXISTENCE_BATCH_CONTEXT_INVALID'
        using errcode = '23514';
    end if;

    perform 1
    from public.whatsapp_coexistence_sync_batches
    where id = p_batch_id
      and account_id = p_account_id
      and event_id = p_event_id
      and sync_generation_id = current_event.sync_generation_id
      and sync_type = 'history'
    for share;
    if not found then
      raise exception 'WHATSAPP_COEXISTENCE_BATCH_CONTEXT_INVALID'
        using errcode = '23514';
    end if;
  elsif p_batch_id is not null then
    raise exception 'WHATSAPP_COEXISTENCE_BATCH_CONTEXT_INVALID'
      using errcode = '23514';
  end if;

  message_metadata := coalesce(p_metadata, '{}'::jsonb)
    || jsonb_build_object(
      'whatsapp_origin', message_origin,
      'source_timestamp', source_at
    );

  -- Resolve WAMID before trusting the thread/from identity. Official history
  -- media follow-ups can carry a contradictory sender. If this WAMID already
  -- exists, only enrich that row; never create/reassign a contact from `from`.
  if p_source = 'history' then
    select * into result
    from public.messages
    where whatsapp_message_id = clean_message_id
    for update;

    if found then
      if result.coexistence_account_id is not null
        and result.coexistence_account_id <> p_account_id then
        raise exception 'WHATSAPP_COEXISTENCE_MESSAGE_IDENTITY_CONFLICT'
          using errcode = '23505';
      end if;

      perform set_config('app.whatsapp_coexistence_ingest', 'on', true);
      update public.messages
      set
        type = case
          when metadata ->> 'history_media_followup' = 'true' then type
          else database_type
        end,
        body = case
          when metadata ->> 'history_media_followup' = 'true' then body
          else coalesce(nullif(message_body, ''), body)
        end,
        whatsapp_message_type = case
          when metadata ->> 'history_media_followup' = 'true'
            then whatsapp_message_type
          else clean_type
        end,
        coexistence_account_id = coalesce(
          coexistence_account_id,
          p_account_id
        ),
        coexistence_event_id = coalesce(coexistence_event_id, p_event_id),
        coexistence_batch_id = coalesce(
          coexistence_batch_id,
          p_batch_id
        ),
        metadata = metadata
          || message_metadata
          || jsonb_build_object(
            'whatsapp_origin', whatsapp_origin,
            'last_observed_origin', message_origin,
            'last_coexistence_event_id', p_event_id,
            'observed_in_history', true
          )
      where id = result.id
      returning * into result;

      perform public.reconcile_whatsapp_history_media(
        p_account_id,
        clean_message_id
      );
      perform set_config('app.whatsapp_coexistence_ingest', 'off', true);
      perform public.apply_whatsapp_message_status(
        clean_message_id,
        initial_status,
        source_at,
        jsonb_build_object(
          'coexistence_status_source', p_source,
          'coexistence_event_id', p_event_id
        )
      );
      select * into result
      from public.messages
      where whatsapp_message_id = clean_message_id;
      return result;
    end if;
  end if;

  contact := public.get_or_create_whatsapp_coexistence_contact(
    p_contact_phone_e164,
    p_contact_whatsapp_id,
    p_contact_user_id,
    p_contact_name
  );
  conversation := public.get_or_create_whatsapp_coexistence_conversation(
    contact.id,
    source_at
  );
  perform set_config('app.whatsapp_coexistence_ingest', 'on', true);

  select * into result
  from public.messages
  where whatsapp_message_id = clean_message_id
  for update;

  if found then
    -- WAMID is authoritative. In particular, a history media follow-up may
    -- carry a contradictory `from`; an existing message never changes owner,
    -- direction or conversation during enrichment/deduplication.
    if (
      result.coexistence_account_id is not null
      and result.coexistence_account_id <> p_account_id
    ) or (
      result.contact_id <> contact.id
      and p_source <> 'history'
    ) or (
      result.direction <> p_direction
      and p_source <> 'history'
    ) or (
      result.original_whatsapp_message_id is not null
      and clean_original_message_id is not null
      and result.original_whatsapp_message_id <> clean_original_message_id
    ) then
      raise exception 'WHATSAPP_COEXISTENCE_MESSAGE_IDENTITY_CONFLICT'
        using errcode = '23505';
    end if;

    update public.messages
    set
      type = case
        when metadata ->> 'history_media_followup' = 'true' then type
        else database_type
      end,
      body = case
        when metadata ->> 'history_media_followup' = 'true' then body
        else coalesce(nullif(message_body, ''), body)
      end,
      whatsapp_message_type = case
        when metadata ->> 'history_media_followup' = 'true'
          then whatsapp_message_type
        else clean_type
      end,
      coexistence_account_id = coalesce(
        coexistence_account_id,
        p_account_id
      ),
      coexistence_event_id = coalesce(coexistence_event_id, p_event_id),
      coexistence_batch_id = coalesce(
        coexistence_batch_id,
        p_batch_id
      ),
      original_whatsapp_message_id = coalesce(
        original_whatsapp_message_id,
        clean_original_message_id
      ),
      metadata = metadata
        || message_metadata
        || jsonb_build_object(
          'whatsapp_origin', whatsapp_origin,
          'last_observed_origin', message_origin,
          'last_coexistence_event_id', p_event_id
        )
    where id = result.id
    returning * into result;
  else
    begin
      insert into public.messages (
        conversation_id,
        contact_id,
        direction,
        whatsapp_message_id,
        type,
        body,
        status,
        idempotency_key,
        metadata,
        created_at,
        whatsapp_origin,
        whatsapp_message_type,
        coexistence_account_id,
        coexistence_event_id,
        coexistence_batch_id,
        original_whatsapp_message_id
      ) values (
        conversation.id,
        contact.id,
        p_direction,
        clean_message_id,
        database_type,
        message_body,
        initial_status,
        case
          when p_direction = 'outbound'
            then 'coexistence:' || message_origin || ':' || md5(clean_message_id)
          else null
        end,
        message_metadata,
        source_at,
        message_origin,
        clean_type,
        p_account_id,
        p_event_id,
        p_batch_id,
        clean_original_message_id
      )
      returning * into result;
      inserted := true;
    exception when unique_violation then
      select * into result
      from public.messages
      where whatsapp_message_id = clean_message_id
      for update;
      if not found then
        raise;
      end if;
      if (
        result.coexistence_account_id is not null
        and result.coexistence_account_id <> p_account_id
      ) or (
        result.contact_id <> contact.id
        and p_source <> 'history'
      ) or (
        result.direction <> p_direction
        and p_source <> 'history'
      ) or (
        result.original_whatsapp_message_id is not null
        and clean_original_message_id is not null
        and result.original_whatsapp_message_id <> clean_original_message_id
      ) then
        raise exception 'WHATSAPP_COEXISTENCE_MESSAGE_IDENTITY_CONFLICT'
          using errcode = '23505';
      end if;

      -- The competing insert may have been a real-time Cloud API write of the
      -- same WAMID. Preserve its owner/direction while durably recording this
      -- Coexistence observation exactly as in the ordinary duplicate path.
      update public.messages
      set
        type = case
          when metadata ->> 'history_media_followup' = 'true' then type
          else database_type
        end,
        body = case
          when metadata ->> 'history_media_followup' = 'true' then body
          else coalesce(nullif(message_body, ''), body)
        end,
        whatsapp_message_type = case
          when metadata ->> 'history_media_followup' = 'true'
            then whatsapp_message_type
          else clean_type
        end,
        coexistence_account_id = coalesce(
          coexistence_account_id,
          p_account_id
        ),
        coexistence_event_id = coalesce(coexistence_event_id, p_event_id),
        coexistence_batch_id = coalesce(coexistence_batch_id, p_batch_id),
        original_whatsapp_message_id = coalesce(
          original_whatsapp_message_id,
          clean_original_message_id
        ),
        metadata = metadata
          || message_metadata
          || jsonb_build_object(
            'whatsapp_origin', whatsapp_origin,
            'last_observed_origin', message_origin,
            'last_coexistence_event_id', p_event_id
          )
      where id = result.id
      returning * into result;
    end;
  end if;

  -- A duplicate echo can correspond to a row imported moments earlier. Make
  -- the manual-mode transition idempotent even when no INSERT trigger fired.
  if p_source = 'smb_message_echoes'
    and not inserted then
    update public.conversations
    set automation_mode = 'manual', needs_human = false
    where id = result.conversation_id;
  end if;

  if clean_original_message_id is not null then
    perform public.reconcile_whatsapp_message_mutations(
      clean_original_message_id
    );
  end if;

  perform set_config('app.whatsapp_coexistence_ingest', 'off', true);

  perform public.apply_whatsapp_message_status(
    clean_message_id,
    initial_status,
    source_at,
    jsonb_build_object(
      'coexistence_status_source', p_source,
      'coexistence_event_id', p_event_id
    )
  );

  select * into result
  from public.messages
  where whatsapp_message_id = clean_message_id;
  return result;
end;
$$;

create or replace function public.reconcile_whatsapp_message_status_events(
  p_whatsapp_message_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_message public.messages%rowtype;
  status_event public.whatsapp_message_status_events%rowtype;
  current_status_at timestamptz;
  current_rank integer;
  incoming_rank integer;
  current_tie_rank integer;
  incoming_tie_rank integer;
  next_status public.message_status;
  applied_any boolean := false;
begin
  perform public.lock_whatsapp_message_wamid(p_whatsapp_message_id);

  select * into current_message
  from public.messages
  where whatsapp_message_id = p_whatsapp_message_id
  for update;
  if not found then
    return false;
  end if;

  begin
    current_status_at := nullif(
      current_message.metadata ->> 'status_updated_at',
      ''
    )::timestamptz;
  exception when others then
    current_status_at := null;
  end;
  begin
    current_tie_rank := nullif(
      current_message.metadata ->> 'status_tie_rank',
      ''
    )::integer;
  exception when others then
    current_tie_rank := null;
  end;

  for status_event in
    select queued.*
    from public.whatsapp_message_status_events queued
    where queued.whatsapp_message_id = p_whatsapp_message_id
      and queued.applied_at is null
    order by
      queued.status_at,
      case queued.status
        when 'pending' then 0
        when 'sent' then 1
        when 'failed' then 2
        when 'delivered' then 3
        when 'read' then 4
      end
    for update
  loop
    incoming_tie_rank := case status_event.status
      when 'pending' then 0
      when 'sent' then 1
      when 'failed' then 2
      when 'delivered' then 3
      when 'read' then 4
    end;

    if current_status_at is null
      or status_event.status_at > current_status_at
      or (
        status_event.status_at = current_status_at
        and incoming_tie_rank >= coalesce(current_tie_rank, -1)
      ) then
      current_rank := case current_message.status
        when 'pending' then 0
        when 'sent' then 1
        when 'delivered' then 2
        when 'read' then 3
        when 'failed' then -1
      end;
      incoming_rank := case status_event.status
        when 'pending' then 0
        when 'sent' then 1
        when 'delivered' then 2
        when 'read' then 3
        when 'failed' then -1
      end;

      next_status := current_message.status;
      if status_event.status = 'failed' then
        if current_message.status in ('pending', 'sent') then
          next_status := 'failed';
        end if;
      elsif current_message.status = 'failed'
        or incoming_rank >= current_rank then
        next_status := status_event.status;
      end if;

      update public.messages
      set
        status = next_status,
        metadata = current_message.metadata
          || status_event.metadata
          || jsonb_build_object(
            'status_updated_at', status_event.status_at,
            'status_event_id', status_event.id,
            'status_tie_rank', incoming_tie_rank
          )
      where id = current_message.id
      returning * into current_message;
      current_status_at := status_event.status_at;
      current_tie_rank := incoming_tie_rank;
    else
      -- A duplicate of an older status may carry error/details that were not
      -- present in the first delivery. Enrich metadata without allowing it to
      -- roll back the protected status cursor or overwrite values supplied by
      -- a newer status event. Existing/current metadata wins on key conflict.
      update public.messages
      set metadata = (
          status_event.metadata
          - 'status_updated_at'
          - 'status_event_id'
          - 'status_tie_rank'
        )
        || current_message.metadata
      where id = current_message.id
      returning * into current_message;
    end if;

    update public.whatsapp_message_status_events
    set applied_at = clock_timestamp()
    where id = status_event.id;
    applied_any := true;
  end loop;

  return applied_any;
end;
$$;

create or replace function public.attach_whatsapp_user_id_to_message_contact(
  p_whatsapp_message_id text,
  p_whatsapp_user_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_message_id text := trim(coalesce(p_whatsapp_message_id, ''));
  clean_user_id text := nullif(trim(coalesce(p_whatsapp_user_id, '')), '');
  contact_row public.contacts%rowtype;
begin
  if clean_user_id is null then return false; end if;
  if char_length(clean_message_id) not between 8 and 240
    or char_length(clean_user_id) not between 1 and 256
    or clean_user_id !~ '^[A-Za-z0-9.]+$' then
    raise exception 'WHATSAPP_STATUS_IDENTITY_INVALID' using errcode = '22023';
  end if;

  -- Coexistence message ingestion owns the WAMID before it resolves contact
  -- identities. Status attachment uses the same WAMID -> identity order.
  perform public.lock_whatsapp_message_wamid(clean_message_id);
  perform pg_advisory_xact_lock(
    hashtextextended('user:' || clean_user_id, 811)
  );

  select contact.* into contact_row
  from public.messages message
  join public.contacts contact on contact.id = message.contact_id
  where message.whatsapp_message_id = clean_message_id
  for update of contact;
  if not found then return false; end if;

  if contact_row.whatsapp_user_id is not null
    and contact_row.whatsapp_user_id <> clean_user_id then
    raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
      using errcode = '23505';
  end if;
  if exists (
    select 1
    from public.contacts other_contact
    where other_contact.whatsapp_user_id = clean_user_id
      and other_contact.id <> contact_row.id
  ) then
    raise exception 'WHATSAPP_COEXISTENCE_CONTACT_IDENTITY_CONFLICT'
      using errcode = '23505';
  end if;

  update public.contacts contact
  set whatsapp_user_id = clean_user_id
  where contact.id = contact_row.id
    and contact.whatsapp_user_id is null;
  return true;
end;
$$;

drop function public.apply_whatsapp_message_status(
  text, public.message_status, timestamptz, jsonb
);

create or replace function public.apply_whatsapp_message_status(
  p_whatsapp_message_id text,
  p_status public.message_status,
  p_status_at timestamptz,
  p_metadata jsonb,
  p_recipient_user_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_message_id text := trim(coalesce(p_whatsapp_message_id, ''));
  clean_user_id text := nullif(trim(coalesce(p_recipient_user_id, '')), '');
begin
  perform public.assert_whatsapp_coexistence_service_role();

  if char_length(clean_message_id) not between 8 and 240
    or p_status is null
    or p_status_at is null
    or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object'
    or (
      clean_user_id is not null
      and (
        char_length(clean_user_id) not between 1 and 256
        or clean_user_id !~ '^[A-Za-z0-9.]+$'
      )
    ) then
    raise exception 'WHATSAPP_MESSAGE_STATUS_INVALID'
      using errcode = '22023';
  end if;

  if clean_user_id is not null then
    perform public.attach_whatsapp_user_id_to_message_contact(
      clean_message_id,
      clean_user_id
    );
  end if;
  perform public.lock_whatsapp_message_wamid(clean_message_id);

  insert into public.whatsapp_message_status_events (
    whatsapp_message_id,
    status,
    status_at,
    metadata
  ) values (
    clean_message_id,
    p_status,
    p_status_at,
    coalesce(p_metadata, '{}'::jsonb) || case
      when clean_user_id is null then '{}'::jsonb
      else jsonb_build_object('delivery_recipient_user_id', clean_user_id)
    end
  )
  on conflict (whatsapp_message_id, status, status_at) do update
  set
    metadata = whatsapp_message_status_events.metadata || excluded.metadata,
    -- A redelivery can enrich the same status with later error/details.
    -- Reopen it so the merged metadata is copied to messages.
    applied_at = null;

  -- This RPC is service-role-only. The local flag lets status reconciliation
  -- update an already-sent history/echo row without re-running the policy that
  -- authorizes a *new* outbound send. Cloud API rows never match the bypass.
  perform set_config('app.whatsapp_coexistence_ingest', 'on', true);
  perform public.reconcile_whatsapp_message_status_events(clean_message_id);
  perform set_config('app.whatsapp_coexistence_ingest', 'off', true);

  -- `true` means durably accepted. If the message has not arrived yet, the
  -- unapplied row is reconciled by the message INSERT trigger later.
  return true;
end;
$$;

revoke execute on function public.attach_whatsapp_user_id_to_message_contact(
  text, text
) from public, anon, authenticated, service_role;
revoke execute on function public.apply_whatsapp_message_status(
  text, public.message_status, timestamptz, jsonb, text
) from public, anon, authenticated;
grant execute on function public.apply_whatsapp_message_status(
  text, public.message_status, timestamptz, jsonb, text
) to service_role;

create or replace function public.reconcile_whatsapp_message_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.reconcile_whatsapp_message_status_events(
    new.whatsapp_message_id
  );

  if new.whatsapp_origin = 'history'
    and new.coexistence_account_id is not null then
    perform public.reconcile_whatsapp_history_media(
      new.coexistence_account_id,
      new.whatsapp_message_id
    );
  end if;

  perform public.reconcile_whatsapp_message_mutations(
    new.whatsapp_message_id
  );
  perform public.attach_whatsapp_user_id_to_message_contact(
    new.whatsapp_message_id,
    (
      select event.metadata ->> 'delivery_recipient_user_id'
      from public.whatsapp_message_status_events event
      where event.whatsapp_message_id = new.whatsapp_message_id
        and event.metadata ? 'delivery_recipient_user_id'
      order by event.status_at desc, event.created_at desc
      limit 1
    )
  );
  if new.original_whatsapp_message_id is not null then
    perform public.reconcile_whatsapp_message_mutations(
      new.original_whatsapp_message_id
    );
  end if;
  return new;
end;
$$;

-- Functions created after the initial ACL block above.
revoke execute on function public.reconcile_whatsapp_message_status_events(text)
  from public, anon, authenticated, service_role;

revoke execute on function public.yield_whatsapp_coexistence_event(
  uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.yield_whatsapp_coexistence_event(
  uuid, uuid, jsonb
) to service_role;

revoke execute on function public.ingest_whatsapp_history_media_followup(
  uuid, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.ingest_whatsapp_history_media_followup(
  uuid, uuid, uuid, text, text, text, jsonb
) to service_role;

revoke execute on function public.ingest_whatsapp_coexistence_message(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text,
  public.message_direction, text, text, public.message_status,
  timestamptz, text, jsonb
) from public, anon, authenticated;
grant execute on function public.ingest_whatsapp_coexistence_message(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text,
  public.message_direction, text, text, public.message_status,
  timestamptz, text, jsonb
) to service_role;

create or replace function public.propagate_whatsapp_coexistence_event_failure()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  failure_message text := coalesce(new.last_error, 'COEXISTENCE_EVENT_FAILED');
  new_failure boolean := false;
begin
  if new.field not in ('history', 'smb_app_state_sync') then
    return new;
  end if;

  if new.status = 'failed' then
    if tg_op = 'INSERT' then
      new_failure := true;
    else
      new_failure := old.status is distinct from new.status;
    end if;
  end if;

  if new_failure then
    update public.whatsapp_coexistence_sync_batches
    set
      status = 'failed',
      failed_count = case
        when item_count = 0 then greatest(failed_count, 1)
        else least(
          greatest(item_count - processed_count, 0),
          greatest(failed_count, 1)
        )
      end,
      last_error = left(failure_message, 2000),
      metadata = metadata || jsonb_build_object(
        'event_failure', true,
        'event_failure_at', clock_timestamp()
      ),
      completed_at = null
    where event_id = new.id
      and status in ('pending', 'processing');
  end if;

  perform public.refresh_whatsapp_coexistence_sync_state(new.account_id);

  return new;
end;
$$;

create trigger whatsapp_coexistence_events_propagate_failure
  after insert or update of status on public.whatsapp_coexistence_events
  for each row
  execute function public.propagate_whatsapp_coexistence_event_failure();

revoke execute on function public.propagate_whatsapp_coexistence_event_failure()
  from public, anon, authenticated, service_role;
