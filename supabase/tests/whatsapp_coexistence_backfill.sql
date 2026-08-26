\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(9);

create temporary table backfill_realtime_before on commit drop as
select jsonb_build_object(
  'puballtables', publication.puballtables,
  'pubinsert', publication.pubinsert,
  'pubupdate', publication.pubupdate,
  'pubdelete', publication.pubdelete,
  'pubtruncate', publication.pubtruncate,
  'pubviaroot', publication.pubviaroot,
  'prattrs', publication_relation.prattrs::text,
  'prqual', publication_relation.prqual::text
) as configuration
from pg_catalog.pg_publication publication
join pg_catalog.pg_publication_rel publication_relation
  on publication_relation.prpubid = publication.oid
where publication.pubname = 'supabase_realtime'
  and publication_relation.prrelid = 'public.messages'::regclass;

select ok(
  (select count(*) = 1 from backfill_realtime_before)
  and (
    select not (configuration ->> 'puballtables')::boolean
      and configuration ->> 'prattrs' is null
      and configuration ->> 'prqual' is null
    from backfill_realtime_before
  ),
  'messages has an explicit unfiltered Supabase Realtime membership'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_publication_namespace publication_namespace
    join pg_catalog.pg_publication publication
      on publication.oid = publication_namespace.pnpubid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = publication_namespace.pnnspid
    where publication.pubname = 'supabase_realtime'
      and namespace.nspname = 'public'
  )
  and exists (
    select 1
    from pg_catalog.pg_publication_tables publication_table
    where publication_table.pubname = 'supabase_realtime'
      and publication_table.schemaname = 'public'
      and publication_table.tablename = 'messages'
  )
  and exists (
    select 1
    from pg_catalog.pg_publication_rel publication_relation
    join pg_catalog.pg_publication publication
      on publication.oid = publication_relation.prpubid
    where publication.pubname = 'supabase_realtime'
      and publication_relation.prrelid = 'public.messages'::regclass
  ),
  'messages Realtime membership is effective and exclusively table-explicit'
);

create temporary table backfill_message_triggers_before on commit drop as
select trigger_info.tgname, trigger_info.tgenabled
from pg_catalog.pg_trigger trigger_info
where trigger_info.tgrelid = 'public.messages'::regclass
  and not trigger_info.tgisinternal;

select is(
  (
    select trigger_state.tgenabled::text
    from backfill_message_triggers_before trigger_state
    where trigger_state.tgname = 'set_messages_updated_at'
  ),
  'O',
  'the messages updated_at trigger starts enabled for origin writes'
);

create temporary table backfill_messages_before on commit drop as
select
  message.id,
  to_jsonb(message) - 'whatsapp_ingest_sequence' as payload,
  row_number() over (
    order by message.created_at, message.id
  )::bigint as expected_ingest_sequence
from public.messages message;

create temporary table backfill_side_effects_before (
  entity text primary key,
  rows jsonb not null
) on commit drop;

insert into backfill_side_effects_before (entity, rows)
select 'contacts', coalesce(
  jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
  '[]'::jsonb
)
from public.contacts entity_row
union all
select 'conversations', coalesce(
  jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
  '[]'::jsonb
)
from public.conversations entity_row
union all
select 'appointments', coalesce(
  jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
  '[]'::jsonb
)
from public.appointments entity_row
union all
select 'automation_sessions', coalesce(
  jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
  '[]'::jsonb
)
from public.automation_sessions entity_row
union all
select 'reminders', coalesce(
  jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
  '[]'::jsonb
)
from public.reminders entity_row
union all
select 'google_calendar_sync_jobs', coalesce(
  jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
  '[]'::jsonb
)
from public.google_calendar_sync_jobs entity_row
union all
select 'whatsapp_automation_dispatches', coalesce(
  jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
  '[]'::jsonb
)
from public.whatsapp_automation_dispatches entity_row
union all
select 'whatsapp_automation_executions', coalesce(
  jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
  '[]'::jsonb
)
from public.whatsapp_automation_executions entity_row
union all
select 'whatsapp_automation_effects', coalesce(
  jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
  '[]'::jsonb
)
from public.whatsapp_automation_effects entity_row;

-- Recreate the state immediately before 20260826120000 adds and backfills the
-- ordering column. Staging is itself hidden from Realtime and the transaction
-- rolls every schema/data change back after the assertions.
alter publication supabase_realtime drop table public.messages;
alter table public.messages
  disable trigger aa0_messages_assign_whatsapp_ingest_sequence;
alter table public.messages disable trigger set_messages_updated_at;
alter table public.messages
  alter column whatsapp_ingest_sequence drop not null;
update public.messages set whatsapp_ingest_sequence = null;
alter table public.messages enable trigger set_messages_updated_at;
alter publication supabase_realtime add table public.messages;

-- Exercise the same guarded operation used by the migration. The production
-- block runs before aa0_messages_assign_whatsapp_ingest_sequence exists, so it
-- intentionally remains disabled throughout this simulation.
do $test_messages_ingest_sequence_backfill$
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
$test_messages_ingest_sequence_backfill$;

alter table public.messages
  alter column whatsapp_ingest_sequence set not null;
alter table public.messages
  enable trigger aa0_messages_assign_whatsapp_ingest_sequence;

select ok(
  not exists (
    (
      select snapshot.id, snapshot.payload
      from backfill_messages_before snapshot
      except
      select message.id, to_jsonb(message) - 'whatsapp_ingest_sequence'
      from public.messages message
    )
    union all
    (
      select message.id, to_jsonb(message) - 'whatsapp_ingest_sequence'
      from public.messages message
      except
      select snapshot.id, snapshot.payload
      from backfill_messages_before snapshot
    )
  ),
  'the sequence backfill preserves every pre-existing message field including updated_at'
);

select ok(
  not exists (
    select 1
    from backfill_messages_before snapshot
    join public.messages message on message.id = snapshot.id
    where message.whatsapp_ingest_sequence
      is distinct from snapshot.expected_ingest_sequence
  ),
  'historical message sequences are deterministic by created_at and id'
);

select ok(
  (
    select count(*) = count(whatsapp_ingest_sequence)
      and count(*) = count(distinct whatsapp_ingest_sequence)
    from public.messages
  ),
  'the backfilled message sequence is non-null and unique'
);

select is(
  (
    select jsonb_build_object(
      'puballtables', publication.puballtables,
      'pubinsert', publication.pubinsert,
      'pubupdate', publication.pubupdate,
      'pubdelete', publication.pubdelete,
      'pubtruncate', publication.pubtruncate,
      'pubviaroot', publication.pubviaroot,
      'prattrs', publication_relation.prattrs::text,
      'prqual', publication_relation.prqual::text
    )
    from pg_catalog.pg_publication publication
    join pg_catalog.pg_publication_rel publication_relation
      on publication_relation.prpubid = publication.oid
    where publication.pubname = 'supabase_realtime'
      and publication_relation.prrelid = 'public.messages'::regclass
  ),
  (select configuration from backfill_realtime_before),
  'the messages Realtime publication configuration is restored exactly'
);

select ok(
  not exists (
    (
      select tgname, tgenabled from backfill_message_triggers_before
      except
      select trigger_info.tgname, trigger_info.tgenabled
      from pg_catalog.pg_trigger trigger_info
      where trigger_info.tgrelid = 'public.messages'::regclass
        and not trigger_info.tgisinternal
    )
    union all
    (
      select trigger_info.tgname, trigger_info.tgenabled
      from pg_catalog.pg_trigger trigger_info
      where trigger_info.tgrelid = 'public.messages'::regclass
        and not trigger_info.tgisinternal
      except
      select tgname, tgenabled from backfill_message_triggers_before
    )
  ),
  'every messages trigger returns to its original enabled state'
);

select ok(
  not exists (
    with current_side_effects (entity, rows) as (
      select 'contacts', coalesce(
        jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
        '[]'::jsonb
      )
      from public.contacts entity_row
      union all
      select 'conversations', coalesce(
        jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
        '[]'::jsonb
      )
      from public.conversations entity_row
      union all
      select 'appointments', coalesce(
        jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
        '[]'::jsonb
      )
      from public.appointments entity_row
      union all
      select 'automation_sessions', coalesce(
        jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
        '[]'::jsonb
      )
      from public.automation_sessions entity_row
      union all
      select 'reminders', coalesce(
        jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
        '[]'::jsonb
      )
      from public.reminders entity_row
      union all
      select 'google_calendar_sync_jobs', coalesce(
        jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
        '[]'::jsonb
      )
      from public.google_calendar_sync_jobs entity_row
      union all
      select 'whatsapp_automation_dispatches', coalesce(
        jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
        '[]'::jsonb
      )
      from public.whatsapp_automation_dispatches entity_row
      union all
      select 'whatsapp_automation_executions', coalesce(
        jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
        '[]'::jsonb
      )
      from public.whatsapp_automation_executions entity_row
      union all
      select 'whatsapp_automation_effects', coalesce(
        jsonb_agg(to_jsonb(entity_row) order by to_jsonb(entity_row)::text),
        '[]'::jsonb
      )
      from public.whatsapp_automation_effects entity_row
    )
    (
      select entity, rows from backfill_side_effects_before
      except
      select entity, rows from current_side_effects
    )
    union all
    (
      select entity, rows from current_side_effects
      except
      select entity, rows from backfill_side_effects_before
    )
  ),
  'the messages backfill creates no business, automation, reminder, or calendar side effects'
);

select * from finish();

rollback;
