import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  calendarBookingError,
  readAppointmentCalendar,
  verifyAppointmentCalendar,
} from "./calendar-projection.ts";
import { requestDepositAndNotify } from "./deposit-request.ts";
import { confirmDepositAndNotify } from "./deposit-confirmation.ts";

test("un turno importado explica dónde cambiarlo sin sugerir fallos de conexión", () => {
  const message = calendarBookingError(
    "CALENDAR_IMPORTED_APPOINTMENT_READ_ONLY",
  );
  assert.match(
    message,
    /Para cambiar el horario o cancelarlo, hacelo desde Google Calendar/,
  );
  assert.doesNotMatch(message, /conexión|sincronizá/);
});

function clientWith(states: unknown[], syncThrows = false) {
  const calls: string[] = [];
  const client = {
    async rpc(name: string) {
      calls.push(name);
      return name === "confirm_appointment_deposit"
        ? { error: null }
        : { data: states.shift(), error: null };
    },
    from() {
      throw new Error("Must not read message data before Google is verified");
    },
    functions: {
      async invoke(name: string) {
        calls.push(name);
        if (syncThrows) throw new Error("NETWORK");
        return { data: { processed: true }, error: null };
      },
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

test("requires proof for this appointment even after a successful sync", async () => {
  const { client, calls } = clientWith([
    { state: "pending" },
    { state: "pending" },
  ]);
  assert.equal(
    await verifyAppointmentCalendar(client, "appointment-1"),
    "pending",
  );
  assert.deepEqual(calls, [
    "appointment_google_calendar_projection",
    "process-calendar-sync",
    "appointment_google_calendar_projection",
  ]);
});

test("opening appointment details only reads its projection", async () => {
  const { client, calls } = clientWith([{ state: "pending" }]);
  assert.equal(
    await readAppointmentCalendar(client, "appointment-1"),
    "pending",
  );
  assert.deepEqual(calls, ["appointment_google_calendar_projection"]);
});

test("a lost sync response may still have committed the exact projection", async () => {
  const { client } = clientWith(
    [{ state: "pending" }, { state: "synced", projectionStage: "confirmed" }],
    true,
  );
  assert.equal(
    await verifyAppointmentCalendar(client, "appointment-1"),
    "synced",
  );
});

test("missing projection stage cannot prove a saved booking", async () => {
  const { client, calls } = clientWith([{ state: "synced" }]);
  assert.equal(
    await verifyAppointmentCalendar(client, "appointment-1"),
    "unavailable",
  );
  assert.equal(calls.length, 1);
});

test("Google conflict prevents requesting a deposit while preserving the saved appointment", async () => {
  const { client, calls } = clientWith([{ state: "conflict" }]);
  assert.deepEqual(
    await requestDepositAndNotify(client, {
      appointmentId: "appointment-1",
      contactId: "contact-1",
      depositRequired: true,
    }),
    { required: true, notified: false, calendarState: "conflict" },
  );
  assert.equal(calls.includes("whatsapp-send"), false);
});

test("confirmation committed locally is not announced before Google acknowledges it", async () => {
  const { client, calls } = clientWith([
    { state: "pending" },
    { state: "pending" },
  ]);
  assert.deepEqual(
    await confirmDepositAndNotify(client, {
      appointmentId: "appointment-1",
      contactId: "contact-1",
      startsAt: "2026-09-07T13:00:00Z",
    }),
    { confirmed: true, notified: false, calendarState: "pending" },
  );
  assert.equal(
    calls.filter((name) => name === "confirm_appointment_deposit").length,
    1,
  );
  assert.equal(calls.includes("whatsapp-send"), false);
});

test("bookings without a deposit also require Google verification", async () => {
  const { client } = clientWith([null]);
  assert.deepEqual(
    await requestDepositAndNotify(client, {
      appointmentId: "appointment-1",
      contactId: "contact-1",
      depositRequired: false,
    }),
    { required: false, notified: false, calendarState: "unavailable" },
  );
});
