-- An early copy of 20260907160000 was already applied before its final three
-- guards were checked in. Converge that deployed contract and fresh installs
-- without replaying table changes, backfills, conversion or external writes.
-- Each known final definition is a no-op; unexpected definitions fail closed.
do $migration$
declare
  target regprocedure;
  previous text;
  revised text;
  old_observer text := 'return public.observe_google_calendar_imported_event(existing, p_removed, p_kind, clean_summary, p_starts_at, p_ends_at, p_all_day, p_recurring, p_google_etag, p_google_updated_at);';
  guarded_observer text := 'return public.observe_google_calendar_imported_event(existing, coalesce(p_removed, false) and p_unsupported_reason is distinct from ''PAST_EVENT'' and p_unsupported_reason is distinct from ''TRANSPARENT_EVENT'', p_kind, clean_summary, p_starts_at, p_ends_at, p_all_day, p_recurring, p_google_etag, p_google_updated_at);';
  old_expiry text := 'appointment.status = ''scheduled''';
  guarded_expiry text := 'appointment.status = ''scheduled'' and not appointment.google_calendar_imported';
  old_reject text := E'  update public.google_calendar_sync_conflicts\n  set status = ''rejected'',';
  guarded_reject text := E'  if exists (select 1 from public.appointments where id = conflict_row.appointment_id and google_calendar_imported) then\n    raise exception ''CALENDAR_IMPORTED_APPOINTMENT_READ_ONLY'' using errcode = ''55000'';\n  end if;\n\n  update public.google_calendar_sync_conflicts\n  set status = ''rejected'',';
begin
  target := 'public.apply_google_calendar_external_event(bigint,uuid,text,text,boolean,text,timestamptz,timestamptz,boolean,boolean,text,text,timestamptz)'::regprocedure;
  previous := pg_get_functiondef(target);
  if position(guarded_observer in previous) = 0 then
    if length(previous) - length(replace(previous, old_observer, '')) <> length(old_observer) then
      raise exception 'GOOGLE_CALENDAR_OBSERVER_CONVERGENCE_DRIFT';
    end if;
    execute replace(previous, old_observer, guarded_observer);
  elsif position(old_observer in previous) > 0 then
    raise exception 'GOOGLE_CALENDAR_OBSERVER_CONVERGENCE_DRIFT';
  end if;

  -- Do not reclassify historical deposits. Exclude imported bookings from
  -- automated expiration so their source guard cannot abort another batch.
  foreach target in array array[
    'public.expire_booking_holds(timestamptz)'::regprocedure,
    'public.expire_overlapping_booking_holds(uuid,timestamptz,timestamptz,uuid,timestamptz)'::regprocedure,
    'public.expire_google_calendar_automation_booking_holds(uuid,bigint,text,timestamptz)'::regprocedure
  ] loop
    previous := pg_get_functiondef(target);
    if length(previous) - length(replace(previous, old_expiry, '')) <> length(old_expiry) then
      raise exception 'GOOGLE_CALENDAR_EXPIRATION_CONVERGENCE_DRIFT: %', target;
    end if;
    if position(guarded_expiry in previous) = 0 then
      execute replace(previous, old_expiry, guarded_expiry);
    end if;
  end loop;

  -- Reject normally restores the app version to Google. A manual source is
  -- read-only, so its discrepancy remains pending until restored in Google.
  target := 'public.reject_google_calendar_conflict(uuid)'::regprocedure;
  previous := pg_get_functiondef(target);
  if length(previous) - length(replace(previous, old_reject, '')) <> length(old_reject) then
    raise exception 'GOOGLE_CALENDAR_REJECT_CONVERGENCE_DRIFT';
  end if;
  if position(guarded_reject in previous) = 0 then
    revised := replace(previous, old_reject, guarded_reject);
    execute revised;
  end if;
end;
$migration$;

notify pgrst, 'reload schema';
