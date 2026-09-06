import assert from "node:assert/strict";
import test from "node:test";
import { assertGoogleCalendarSlotAvailable } from "./google-calendar-slot.ts";

const input = {
  accessToken: "test-token",
  calendarId: "practice-calendar",
  calendarTimeZone: "America/Argentina/Buenos_Aires",
  startsAt: "2026-09-10T14:00:00.250Z",
  endsAt: "2026-09-10T15:00:00.250Z",
  bufferMinutes: 15,
  ownEventId: "managed-event",
  appointmentId: "appointment-id",
  automationEpoch: "epoch-id",
};

function page(items: unknown[], nextPageToken?: string): Response {
  return Response.json({
    kind: "calendar#events",
    timeZone: input.calendarTimeZone,
    accessRole: "owner",
    items,
    ...(nextPageToken ? { nextPageToken } : { nextSyncToken: "sync-token" }),
  });
}

const busy = {
  id: "manually-added",
  start: { dateTime: "2026-09-10T14:30:00Z" },
  end: { dateTime: "2026-09-10T15:00:00Z" },
};

test("la lectura antes de escribir consulta el rango con margen y expande recurrencias", async () => {
  await assertGoogleCalendarSlotAvailable({
    ...input,
    fetcher: (url) => {
      const query = new URL(String(url)).searchParams;
      assert.equal(query.get("timeMin"), "2026-09-10T14:00:00.000Z");
      assert.equal(query.get("timeMax"), "2026-09-10T15:15:01.000Z");
      assert.equal(query.get("singleEvents"), "true");
      assert.equal(query.has("syncToken"), false);
      return Promise.resolve(page([]));
    },
  });
});

test("un turno agregado por otra persona después del pull impide publicar el nuevo", async () => {
  await assert.rejects(
    assertGoogleCalendarSlotAvailable({
      ...input,
      fetcher: () => Promise.resolve(page([busy])),
    }),
    { message: "GOOGLE_CALENDAR_SLOT_OCCUPIED" },
  );
});

test("rechaza ocupación en páginas posteriores, todo el día y el margen final", async () => {
  for (const event of [
    busy,
    {
      id: "all-day",
      start: { date: "2026-09-10" },
      end: { date: "2026-09-11" },
    },
    {
      ...busy,
      start: { dateTime: "2026-09-10T15:10:00Z" },
      end: { dateTime: "2026-09-10T15:30:00Z" },
    },
    { ...busy, recurringEventId: "weekly", originalStartTime: busy.start },
  ]) {
    let reads = 0;
    await assert.rejects(
      assertGoogleCalendarSlotAvailable({
        ...input,
        fetcher: () =>
          Promise.resolve(++reads === 1 ? page([], "page-2") : page([event])),
      }),
      { message: "GOOGLE_CALENDAR_SLOT_OCCUPIED" },
    );
    assert.equal(reads, 2);
  }
});

test("no bloquean eventos cancelados, libres ni el propio con asociación exacta", async () => {
  await assertGoogleCalendarSlotAvailable({
    ...input,
    fetcher: () =>
      Promise.resolve(
        page([
          { ...busy, status: "cancelled" },
          { ...busy, transparency: "transparent" },
          {
            ...busy,
            id: input.ownEventId,
            extendedProperties: {
              private: {
                managed_by: "gisela_lentz_agenda",
                appointment_id: input.appointmentId,
                automation_epoch: input.automationEpoch,
              },
            },
          },
        ]),
      ),
  });
});

test("no excluye un evento con ID propio y asociación diferente", async () => {
  await assert.rejects(
    assertGoogleCalendarSlotAvailable({
      ...input,
      fetcher: () => Promise.resolve(page([{ ...busy, id: input.ownEventId }])),
    }),
    { message: "GOOGLE_EVENT_OWNERSHIP_CONFLICT" },
  );
});

test("páginas repetidas, calendario inválido, fallo HTTP y rangos ambiguos fallan cerrado", async () => {
  for (const response of [
    () => page([], "repeated-page"),
    () => Response.json({ items: [] }),
    () => new Response(null, { status: 503 }),
    () => page([{ id: "event-with-missing-range" }]),
  ]) {
    await assert.rejects(
      assertGoogleCalendarSlotAvailable({
        ...input,
        fetcher: () => Promise.resolve(response()),
      }),
    );
  }
});
