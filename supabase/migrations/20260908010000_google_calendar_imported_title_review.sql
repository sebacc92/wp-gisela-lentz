-- A reviewed administrative title may become the baseline of its SAME
-- imported patient appointment. Google stays authoritative and read-only.
-- The Edge endpoint authenticates the ADMIN, rereads this exact Google event,
-- checks the ETag the person reviewed, and validates the patient's identity and
-- operational details. Never expose this trusted-observation RPC to a browser.
create function public.accept_google_calendar_imported_title_review(
  p_conflict_id uuid,
  p_actor_id uuid,
  p_expected_generation bigint,
  p_expected_conflict_updated_at timestamptz,
  p_expected_appointment_updated_at timestamptz,
  p_expected_summary text,
  p_expected_google_etag text,
  p_reviewed_summary text,
  p_reviewed_google_etag text,
  p_reviewed_google_updated_at timestamptz,
  p_reviewed_starts_at timestamptz,
  p_reviewed_ends_at timestamptz,
  p_expected_contact_updated_at timestamptz,
  p_expected_automation_epoch uuid
)
returns public.google_calendar_sync_conflicts
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  connection_row public.google_calendar_connections%rowtype;
  event_row public.google_calendar_external_events%rowtype;
  appointment_row public.appointments%rowtype;
  contact_row public.contacts%rowtype;
  conflict_row public.google_calendar_sync_conflicts%rowtype;
  result public.google_calendar_sync_conflicts%rowtype;
  appointment_id uuid;
  professional_id uuid;
  event_id text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;
  perform 1 from public.profiles
  where id = p_actor_id and role = 'ADMIN' and active for share;
  if not found then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_reviewed_summary is null
    or char_length(p_reviewed_summary) not between 1 and 120
    or p_reviewed_summary <> btrim(p_reviewed_summary)
    or p_reviewed_summary ~ '[[:cntrl:]]'
    or nullif(btrim(p_reviewed_summary), '') is null
    or nullif(btrim(p_expected_google_etag), '') is null
    or nullif(btrim(p_reviewed_google_etag), '') is null
    or char_length(p_expected_google_etag) > 255
    or char_length(p_reviewed_google_etag) > 255
    or p_reviewed_google_updated_at is null
    or not isfinite(p_reviewed_google_updated_at)
    or p_reviewed_starts_at is null or p_reviewed_ends_at is null
    or not isfinite(p_reviewed_starts_at) or not isfinite(p_reviewed_ends_at)
    or p_reviewed_starts_at >= p_reviewed_ends_at
  then
    raise exception 'CALENDAR_TITLE_REVIEW_INVALID' using errcode = '22023';
  end if;

  -- Read identifiers only to establish the same lock order as booking/import.
  -- Every value is revalidated below after acquiring the locks.
  select appointment.id, appointment.professional_id, conflict.google_event_id
  into appointment_id, professional_id, event_id
  from public.google_calendar_sync_conflicts conflict
  join public.appointments appointment on appointment.id = conflict.appointment_id
  where conflict.id = p_conflict_id;
  if not found then
    raise exception 'CALENDAR_TITLE_REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(professional_id::text, 0));
  if not pg_try_advisory_xact_lock_shared(
    hashtextextended('google_calendar_connection', 0)
  ) then
    raise exception 'CALENDAR_TITLE_REVIEW_BUSY' using errcode = '55000';
  end if;
  select * into connection_row
  from public.google_calendar_connections where id = true for share;
  if not found or not public.google_calendar_automation_scope_is_current(true)
    or p_expected_generation is distinct from connection_row.connection_generation
    or p_expected_automation_epoch is distinct from connection_row.automation_epoch
  then
    raise exception 'CALENDAR_TITLE_REVIEW_SCOPE_STALE' using errcode = '55000';
  end if;
  -- An expired but unreleased lease is not proof that its worker has stopped.
  -- Holding the connection row prevents a new inbound lease until commit.
  if connection_row.inbound_lease_token is not null
    or connection_row.inbound_lease_expires_at is not null
  then
    raise exception 'CALENDAR_TITLE_REVIEW_BUSY' using errcode = '55000';
  end if;

  -- The inbound observer locks the external row BEFORE the conflict. Keep
  -- that order; never wait for its event while holding the conflict itself.
  select * into event_row from public.google_calendar_external_events event
  where event.google_calendar_id = connection_row.google_calendar_id
    and event.google_event_id = event_id
    and event.connection_generation = p_expected_generation for update;
  if not found or event_row.converted_appointment_id is distinct from appointment_id
    or event_row.status <> 'converted' or event_row.kind <> 'block'
    or event_row.removed_at is not null or event_row.all_day or event_row.recurring
  then
    raise exception 'CALENDAR_TITLE_REVIEW_SOURCE_STALE' using errcode = '55000';
  end if;
  select * into appointment_row from public.appointments appointment
  where appointment.id = appointment_id for update;
  if not found or not appointment_row.google_calendar_imported
    or appointment_row.status <> 'confirmed'
    or appointment_row.professional_id is distinct from professional_id
    or appointment_row.updated_at is distinct from p_expected_appointment_updated_at
    or appointment_row.starts_at is distinct from p_reviewed_starts_at
    or appointment_row.ends_at is distinct from p_reviewed_ends_at
    or event_row.starts_at is distinct from appointment_row.starts_at
    or event_row.ends_at is distinct from appointment_row.ends_at
  then
    raise exception 'CALENDAR_TITLE_REVIEW_APPOINTMENT_STALE' using errcode = '55000';
  end if;
  select * into contact_row from public.contacts
  where id = appointment_row.contact_id for share;
  if not found or contact_row.updated_at is distinct from p_expected_contact_updated_at then
    raise exception 'CALENDAR_TITLE_REVIEW_CONTACT_STALE' using errcode = '55000';
  end if;
  select * into conflict_row from public.google_calendar_sync_conflicts
  where id = p_conflict_id for update;
  if not found or conflict_row.status <> 'pending' or conflict_row.kind <> 'metadata_changed'
    or conflict_row.appointment_id is distinct from appointment_row.id
    or conflict_row.google_event_id is distinct from event_row.google_event_id
    or conflict_row.connection_generation is distinct from p_expected_generation
    or conflict_row.updated_at is distinct from p_expected_conflict_updated_at
    or conflict_row.observed_starts_at is distinct from appointment_row.starts_at
    or conflict_row.observed_ends_at is distinct from appointment_row.ends_at
  then
    raise exception 'CALENDAR_TITLE_REVIEW_CONFLICT_STALE' using errcode = '55000';
  end if;
  if event_row.summary is distinct from p_expected_summary
    or event_row.google_etag is distinct from p_expected_google_etag
    or p_reviewed_google_updated_at < event_row.google_updated_at
    or p_reviewed_google_updated_at < conflict_row.google_updated_at
  then
    raise exception 'CALENDAR_TITLE_REVIEW_OBSERVATION_STALE' using errcode = '55000';
  end if;

  -- No appointment/contact changes, projection jobs, Google mutation, or
  -- messages. The ordinary external-row trigger only refreshes the admin UI.
  update public.google_calendar_external_events
  set summary = p_reviewed_summary,
      google_etag = p_reviewed_google_etag,
      google_updated_at = p_reviewed_google_updated_at
  where google_calendar_id = event_row.google_calendar_id
    and google_event_id = event_row.google_event_id;
  update public.google_calendar_sync_conflicts
  set status = 'applied', resolved_at = clock_timestamp(), resolved_by = p_actor_id,
      resolution_error = null
  where id = p_conflict_id returning * into result;
  insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'google_calendar.imported_title_review_accepted', 'appointment',
    appointment_row.id, jsonb_build_object('conflict_id', p_conflict_id));
  return result;
end;
$$;

revoke all on function public.accept_google_calendar_imported_title_review(
  uuid, uuid, bigint, timestamptz, timestamptz, text, text, text, text,
  timestamptz, timestamptz, timestamptz, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.accept_google_calendar_imported_title_review(
  uuid, uuid, bigint, timestamptz, timestamptz, text, text, text, text,
  timestamptz, timestamptz, timestamptz, timestamptz, uuid
) to service_role;

notify pgrst, 'reload schema';
