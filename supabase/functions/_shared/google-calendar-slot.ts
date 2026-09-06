import {
  classifyGoogleCalendarEventAsExternal,
  GoogleIntegrationError,
  listGoogleCalendarEvents,
} from "./google-calendar.ts";

/**
 * Re-read the actual target range immediately before a remote write. The
 * inbound snapshot can already be outdated when another person edits Google
 * while this worker processes its queue. Calendar has no atomic range lock;
 * this check supplements the database barrier and conditional event writes.
 */
export async function assertGoogleCalendarSlotAvailable(input: {
  accessToken: string;
  calendarId: string;
  calendarTimeZone: string;
  startsAt: string;
  endsAt: string;
  bufferMinutes: number;
  ownEventId: string;
  appointmentId: string;
  automationEpoch: string;
  fetcher?: typeof fetch;
}): Promise<void> {
  const startsAt = Date.parse(input.startsAt);
  const endsAt = Date.parse(input.endsAt);
  if (
    !Number.isFinite(startsAt) ||
    !Number.isFinite(endsAt) ||
    endsAt <= startsAt ||
    !Number.isSafeInteger(input.bufferMinutes) ||
    input.bufferMinutes < 0 ||
    input.bufferMinutes > 1440
  ) {
    throw new GoogleIntegrationError("GOOGLE_CALENDAR_SLOT_PARAMETERS_INVALID");
  }
  const bufferedEnd = endsAt + input.bufferMinutes * 60_000;
  let pageToken: string | null = null;
  const visitedTokens = new Set<string>();

  // Expand recurrence on Google's side, include all-day events and inspect
  // every page. A limit or invalid response never means the slot is free.
  for (let pageNumber = 0; pageNumber < 12; pageNumber += 1) {
    const page = await listGoogleCalendarEvents({
      accessToken: input.accessToken,
      calendarId: input.calendarId,
      calendarTimeZone: input.calendarTimeZone,
      // Google ignores milliseconds in these bounds. Round outward so even
      // appointments with subsecond timestamps cannot hide a collision.
      timeMin: new Date(Math.floor(startsAt / 1000) * 1000).toISOString(),
      timeMax: new Date(Math.ceil(bufferedEnd / 1000) * 1000).toISOString(),
      pageToken,
      maxResults: 250,
      fetcher: input.fetcher,
    });
    for (const event of page.items) {
      if (event.id === input.ownEventId) {
        const properties = event.extendedProperties?.private;
        if (
          properties?.managed_by !== "gisela_lentz_agenda" ||
          properties.appointment_id !== input.appointmentId ||
          properties.automation_epoch !== input.automationEpoch
        ) {
          throw new GoogleIntegrationError("GOOGLE_EVENT_OWNERSHIP_CONFLICT", {
            status: 409,
          });
        }
        // Existing If-Match/ownership guards still protect this exact event.
        continue;
      }
      const classified = classifyGoogleCalendarEventAsExternal(
        event,
        input.calendarTimeZone,
      );
      if (classified.kind === "external_removed") continue;
      if (
        classified.kind !== "external_block" ||
        (Date.parse(classified.startsAt) < bufferedEnd &&
          Date.parse(classified.endsAt) > startsAt)
      ) {
        throw new GoogleIntegrationError("GOOGLE_CALENDAR_SLOT_OCCUPIED", {
          status: 409,
          retryable: true,
        });
      }
    }
    if (!page.nextPageToken) return;
    if (visitedTokens.has(page.nextPageToken)) break;
    visitedTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }
  throw new GoogleIntegrationError("GOOGLE_CALENDAR_SLOT_CHECK_INCOMPLETE", {
    status: 503,
    retryable: true,
  });
}
