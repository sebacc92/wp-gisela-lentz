\set ON_ERROR_STOP on
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
\ir _support/calendar-ready.inc

insert into auth.users (id, email, encrypted_password, aud, role)
values
  ('93300000-0000-4000-8000-000000000001', 'title-review-admin@example.test', '', 'authenticated', 'authenticated'),
  ('93300000-0000-4000-8000-000000000002', 'title-review-operator@example.test', '', 'authenticated', 'authenticated');
update public.profiles set role = 'ADMIN', active = true where id = '93300000-0000-4000-8000-000000000001';
update public.profiles set role = 'OPERADOR', active = true where id = '93300000-0000-4000-8000-000000000002';
insert into public.professionals (id, name, appointment_duration_minutes, active)
values ('93300000-0000-4000-8000-000000000003', 'Title Review Test', 30, true);
insert into public.services (id, name, duration_minutes, active)
values ('93300000-0000-4000-8000-000000000004', 'Title Review Consulta', 30, true);
insert into public.contacts (id, name, phone_e164, coverage, is_existing_patient)
values ('93300000-0000-4000-8000-000000000005', 'Paciente Título', '+5492234000095', 'particular', true);
insert into public.google_calendar_external_events (
  google_calendar_id, google_event_id, connection_generation, kind, status,
  summary, starts_at, ends_at, content_hash, google_etag, google_updated_at
) values (
  'synthetic-domain-test-calendar', 'synthetic-title-review-event', 9900, 'block', 'active',
  'Paciente Título TF Particular', current_date + interval '2 days 15 hours',
  current_date + interval '2 days 15 hours 30 minutes', md5('synthetic-title-review-event'),
  '"observed-title-etag"', clock_timestamp() - interval '1 minute'
);
create temporary table reviewed_booking as
select imported.appointment_id from public.google_calendar_external_events event
cross join lateral public.import_google_calendar_patient_appointment(
  event.google_event_id, '93300000-0000-4000-8000-000000000005',
  'Paciente Título', '+5492234000095', 'particular',
  '93300000-0000-4000-8000-000000000003', '93300000-0000-4000-8000-000000000004',
  event.starts_at, 'Original private note remains unchanged', null, true,
  9900, 'synthetic-domain-test-calendar', '99ca1000-0000-4000-8000-000000000001',
  event.summary, event.ends_at
) imported where event.google_event_id = 'synthetic-title-review-event';

insert into public.google_calendar_sync_conflicts (
  id, appointment_id, google_event_id, kind, status,
  observed_starts_at, observed_ends_at, google_updated_at, connection_generation
) select '93300000-0000-4000-8000-000000000006', appointment.id,
  'synthetic-title-review-event', 'metadata_changed', 'pending',
  appointment.starts_at, appointment.ends_at, clock_timestamp() - interval '1 minute', 9900
from public.appointments appointment join reviewed_booking booking on booking.appointment_id = appointment.id;

create temporary table title_review_request as
select jsonb_build_object(
  'conflict', conflict.id,
  'actor', '93300000-0000-4000-8000-000000000001',
  'generation', 9900,
  'epoch', '99ca1000-0000-4000-8000-000000000001',
  'conflict_updated', conflict.updated_at,
  'appointment_updated', appointment.updated_at,
  'summary', event.summary,
  'etag', event.google_etag,
  'reviewed_summary', 'Paciente Título · TF · Particular',
  'reviewed_etag', '"reviewed-title-etag"',
  'reviewed_updated', clock_timestamp(),
  'starts', appointment.starts_at,
  'ends', appointment.ends_at,
  'contact_updated', contact.updated_at
) as request
from public.google_calendar_sync_conflicts conflict
join public.appointments appointment on appointment.id = conflict.appointment_id
join public.contacts contact on contact.id = appointment.contact_id
join public.google_calendar_external_events event on event.converted_appointment_id = appointment.id
where conflict.id = '93300000-0000-4000-8000-000000000006';

create function pg_temp.accept_title_review(p_changes jsonb default '{}'::jsonb)
returns public.google_calendar_sync_conflicts language plpgsql as $$
declare request jsonb;
begin
  select original.request || p_changes into request from title_review_request original;
  return public.accept_google_calendar_imported_title_review(
    (request ->> 'conflict')::uuid, (request ->> 'actor')::uuid,
    (request ->> 'generation')::bigint, (request ->> 'conflict_updated')::timestamptz,
    (request ->> 'appointment_updated')::timestamptz, request ->> 'summary', request ->> 'etag',
    request ->> 'reviewed_summary', request ->> 'reviewed_etag',
    (request ->> 'reviewed_updated')::timestamptz, (request ->> 'starts')::timestamptz,
    (request ->> 'ends')::timestamptz, (request ->> 'contact_updated')::timestamptz,
    (request ->> 'epoch')::uuid
  );
end;
$$;
-- Each failing call rolls back its synthetic intervening edit together with
-- the attempted acceptance; no fixture repair can accidentally hide a write.
create function pg_temp.review_after_sql(p_sql text)
returns void language plpgsql as $$
begin
  execute p_sql;
  perform pg_temp.accept_title_review();
end;
$$;

select ok(has_function_privilege('service_role',
  'public.accept_google_calendar_imported_title_review(uuid,uuid,bigint,timestamptz,timestamptz,text,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated',
  'public.accept_google_calendar_imported_title_review(uuid,uuid,bigint,timestamptz,timestamptz,text,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz,uuid)', 'EXECUTE')
  and not has_function_privilege('anon',
  'public.accept_google_calendar_imported_title_review(uuid,uuid,bigint,timestamptz,timestamptz,text,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz,uuid)', 'EXECUTE'),
  'only the trusted service endpoint may submit a Google observation');
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"93300000-0000-4000-8000-000000000001"}', true);
select throws_ok($$select pg_temp.accept_title_review()$$, '42501', 'UNAUTHORIZED',
  'even a real ADMIN JWT cannot bypass the Edge Google reread');
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$select pg_temp.accept_title_review('{"actor":"93300000-0000-4000-8000-000000000002"}')$$,
  '42501', 'ADMIN_REQUIRED', 'an operator cannot approve through the service wrapper');
select throws_ok($$select pg_temp.accept_title_review('{"actor":null}')$$,
  '42501', 'ADMIN_REQUIRED', 'missing actor cannot approve');
select throws_ok($$select pg_temp.review_after_sql('update public.profiles set active = false where id = ''93300000-0000-4000-8000-000000000001''')$$,
  '42501', 'ADMIN_REQUIRED', 'a disabled administrator is rechecked at commit');
select throws_ok($$select pg_temp.accept_title_review('{"conflict":"93300000-0000-4000-8000-000000000099"}')$$,
  'P0002', 'CALENDAR_TITLE_REVIEW_NOT_FOUND', 'unknown conflicts cannot be substituted');
select throws_ok($$select pg_temp.accept_title_review('{"generation":9899}')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_SCOPE_STALE', 'an old generation cannot be accepted');
select throws_ok($$select pg_temp.accept_title_review('{"epoch":"99ca1000-0000-4000-8000-000000000099"}')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_SCOPE_STALE', 'a revoked automation epoch cannot be accepted');
select throws_ok($$select pg_temp.review_after_sql('update public.google_calendar_connections set automation_enabled = false, automation_epoch = null, automation_activated_at = null, automation_google_account_id = null, automation_google_calendar_id = null, automation_connection_generation = null where id')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_SCOPE_STALE', 'automation revocation closes the review');
select throws_ok($$select pg_temp.review_after_sql('update public.google_calendar_connections set automation_google_calendar_id = ''another-calendar'' where id')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_SCOPE_STALE', 'calendar identity must still match the authorized scope');
select throws_ok($$select pg_temp.review_after_sql('update public.google_calendar_connections set automation_google_account_id = ''another-account'' where id')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_SCOPE_STALE', 'account identity must still match the authorized scope');
select throws_ok($$select pg_temp.review_after_sql('update public.google_calendar_connections set inbound_lease_token = gen_random_uuid(), inbound_lease_expires_at = clock_timestamp() + interval ''30 seconds'' where id')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_BUSY', 'an active inbound lease cannot race baseline acceptance');
select throws_ok($$select pg_temp.review_after_sql('update public.google_calendar_connections set inbound_lease_token = gen_random_uuid(), inbound_lease_expires_at = clock_timestamp() - interval ''30 seconds'' where id')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_BUSY', 'an expired but unreleased worker is not assumed stopped');

select throws_ok($$select pg_temp.accept_title_review('{"summary":"Other original title"}')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_OBSERVATION_STALE', 'the exact original baseline is rechecked');
select throws_ok($$select pg_temp.accept_title_review('{"etag":"\"stale-etag\""}')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_OBSERVATION_STALE', 'a newer inbound ETag invalidates the old review');
select throws_ok($$select pg_temp.accept_title_review('{"reviewed_updated":"2000-01-01T00:00:00Z"}')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_OBSERVATION_STALE', 'a remote snapshot older than the observation is rejected');
select throws_ok($$select pg_temp.accept_title_review('{"conflict_updated":"2000-01-01T00:00:00Z"}')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_CONFLICT_STALE', 'conflict edits invalidate acceptance');
select throws_ok($$select pg_temp.accept_title_review('{"appointment_updated":"2000-01-01T00:00:00Z"}')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_APPOINTMENT_STALE', 'appointment edits invalidate the earlier semantic check');
select throws_ok($$select pg_temp.accept_title_review('{"contact_updated":"2000-01-01T00:00:00Z"}')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_CONTACT_STALE', 'independent patient changes invalidate the earlier identity check');
select throws_ok($$select pg_temp.accept_title_review(jsonb_build_object('starts', (select request ->> 'ends' from title_review_request), 'ends', (select (request ->> 'ends')::timestamptz + interval '30 minutes' from title_review_request)))$$,
  '55000', 'CALENDAR_TITLE_REVIEW_APPOINTMENT_STALE', 'title review cannot move the appointment');
select throws_ok($$select pg_temp.review_after_sql('update public.google_calendar_sync_conflicts set kind = ''cancellation_requested'' where id = ''93300000-0000-4000-8000-000000000006''')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_CONFLICT_STALE', 'cancellation cannot be accepted as a title review');
select throws_ok($$select pg_temp.review_after_sql('update public.google_calendar_external_events set removed_at = clock_timestamp() where google_event_id = ''synthetic-title-review-event''')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_SOURCE_STALE', 'a deleted source cannot be accepted');
select throws_ok($$select pg_temp.review_after_sql('update public.google_calendar_external_events set all_day = true where google_event_id = ''synthetic-title-review-event''')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_SOURCE_STALE', 'an all-day source cannot be accepted');
select throws_ok($$select pg_temp.review_after_sql('update public.google_calendar_external_events set recurring = true where google_event_id = ''synthetic-title-review-event''')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_SOURCE_STALE', 'a recurring source cannot be accepted');
select throws_ok($$select pg_temp.review_after_sql('update public.google_calendar_external_events set ends_at = ends_at + interval ''30 minutes'' where google_event_id = ''synthetic-title-review-event''')$$,
  '55000', 'CALENDAR_TITLE_REVIEW_APPOINTMENT_STALE', 'changed source duration requires a different review');
select throws_ok($$select pg_temp.accept_title_review('{"reviewed_summary":""}')$$,
  '22023', 'CALENDAR_TITLE_REVIEW_INVALID', 'an empty reviewed title is invalid');
select throws_ok($$select pg_temp.accept_title_review(jsonb_build_object('reviewed_summary', repeat('x', 121)))$$,
  '22023', 'CALENDAR_TITLE_REVIEW_INVALID', 'a truncated title cannot be silently adopted');
select throws_ok($$select pg_temp.accept_title_review('{"reviewed_summary":"Paciente\nTítulo"}')$$,
  '22023', 'CALENDAR_TITLE_REVIEW_INVALID', 'persisted titles must match the observer sanitization');
select throws_ok($$select pg_temp.accept_title_review('{"reviewed_etag":null}')$$,
  '22023', 'CALENDAR_TITLE_REVIEW_INVALID', 'the fresh remote ETag is mandatory');

create temporary table preserved_title_review_state as
select
  (select to_jsonb(appointment) from public.appointments appointment
    join reviewed_booking booking on booking.appointment_id = appointment.id) as appointment,
  (select to_jsonb(contact) from public.contacts contact where id = '93300000-0000-4000-8000-000000000005') as contact,
  (select to_jsonb(connection) from public.google_calendar_connections connection where id) as connection,
  (select count(*) from public.google_calendar_sync_jobs) as job_count,
  (select count(*) from public.messages) as message_count,
  (select count(*) from public.whatsapp_automation_effects) as automation_effect_count,
  (select count(*) from public.reminders) as reminder_count;

select is((pg_temp.accept_title_review()).status, 'applied', 'the exact reviewed title can become the source baseline');
select ok((select summary = 'Paciente Título · TF · Particular'
  and google_etag = '"reviewed-title-etag"'
  and google_updated_at = (select (request ->> 'reviewed_updated')::timestamptz from title_review_request)
  and converted_appointment_id = (select appointment_id from reviewed_booking)
  and status = 'converted' and removed_at is null
  from public.google_calendar_external_events where google_event_id = 'synthetic-title-review-event'),
  'acceptance changes only baseline and Google observation, preserving source linkage');
select ok((select resolved_by = '93300000-0000-4000-8000-000000000001' and resolved_at is not null and resolution_error is null
  from public.google_calendar_sync_conflicts where id = '93300000-0000-4000-8000-000000000006'),
  'the active administrator decision is recorded');
select is((select to_jsonb(appointment) from public.appointments appointment
  join reviewed_booking booking on booking.appointment_id = appointment.id),
  (select appointment from preserved_title_review_state), 'the appointment is byte-for-byte unchanged');
select is((select to_jsonb(contact) from public.contacts contact where id = '93300000-0000-4000-8000-000000000005'),
  (select contact from preserved_title_review_state), 'the patient is byte-for-byte unchanged');
select is((select to_jsonb(connection) from public.google_calendar_connections connection where id),
  (select connection from preserved_title_review_state), 'the Calendar connection and leases are unchanged');
select ok((select count(*) from public.google_calendar_sync_jobs) = (select job_count from preserved_title_review_state)
  and (select count(*) from public.messages) = (select message_count from preserved_title_review_state)
  and (select count(*) from public.whatsapp_automation_effects) = (select automation_effect_count from preserved_title_review_state)
  and (select count(*) from public.reminders) = (select reminder_count from preserved_title_review_state),
  'review creates no Calendar jobs, messages, automation effects or reminders');
select ok(exists(select 1 from public.audit_logs where actor_user_id = '93300000-0000-4000-8000-000000000001'
  and action = 'google_calendar.imported_title_review_accepted'
  and metadata = '{"conflict_id":"93300000-0000-4000-8000-000000000006"}'::jsonb),
  'audit contains the decision ID, not patient titles or Google credentials');
select throws_ok($$select pg_temp.accept_title_review()$$,
  '55000', 'CALENDAR_TITLE_REVIEW_CONFLICT_STALE', 'a duplicate submission cannot apply a second decision');
select * from public.begin_google_calendar_inbound_sync(9900, 120, 2,
  (clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date::timestamp
    at time zone 'America/Argentina/Buenos_Aires',
  ((clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date + 21)::timestamp
    at time zone 'America/Argentina/Buenos_Aires') \gset reviewed_
select is(public.apply_google_calendar_external_event(9900, :'reviewed_lease_token',
  'synthetic-title-review-event', 'block', false, 'Paciente Título · TF · Particular',
  (select (request ->> 'starts')::timestamptz from title_review_request),
  (select (request ->> 'ends')::timestamptz from title_review_request),
  false, false, null, '"reviewed-title-etag"', clock_timestamp()), 'unchanged',
  'the next inbound observation does not reopen the accepted title');
select ok(not exists(select 1 from public.google_calendar_sync_conflicts
  where appointment_id = (select appointment_id from reviewed_booking) and status = 'pending'),
  'accepted imported metadata remains resolved on the next sync');

select * from finish();
rollback;
