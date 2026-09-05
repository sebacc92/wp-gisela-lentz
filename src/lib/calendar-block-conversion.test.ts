import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  blockConversionError,
  convertCalendarBlock,
  describeBlockConversionError,
} from "./calendar-block-conversion.ts";

const APPOINTMENT_ID = "11111111-1111-4111-8111-111111111111";

function clientResult(data: unknown, error: unknown = null): SupabaseClient {
  return {
    rpc: async () => ({ data, error }),
  } as unknown as SupabaseClient;
}

const input = {
  googleEventId: "google-event-id",
  contactId: "22222222-2222-4222-8222-222222222222",
  professionalId: "33333333-3333-4333-8333-333333333333",
  serviceId: "44444444-4444-4444-8444-444444444444",
  startsAt: "2099-01-01T12:00:00.000Z",
};

test("acepta respuestas válidas de creación e idempotencia", async () => {
  assert.deepEqual(
    await convertCalendarBlock(
      clientResult({ appointment_id: APPOINTMENT_ID, created: true }),
      input,
    ),
    { appointmentId: APPOINTMENT_ID, created: true, error: null },
  );
  assert.deepEqual(
    await convertCalendarBlock(
      clientResult([{ appointment_id: APPOINTMENT_ID, created: false }]),
      input,
    ),
    { appointmentId: APPOINTMENT_ID, created: false, error: null },
  );
});

test("una respuesta RPC nula o malformada nunca se anuncia como éxito", async () => {
  for (const malformed of [
    null,
    [],
    {},
    { appointment_id: APPOINTMENT_ID },
    { appointment_id: "not-a-uuid", created: true },
    { appointment_id: APPOINTMENT_ID, created: "true" },
  ]) {
    assert.deepEqual(
      await convertCalendarBlock(clientResult(malformed), input),
      {
        appointmentId: null,
        created: false,
        error: "UNKNOWN",
      },
    );
  }
});

test("un bloqueo desactualizado exige refrescar la agenda", async () => {
  const databaseError = { message: "CALENDAR_BLOCK_STALE" };

  assert.equal(
    blockConversionError(databaseError.message),
    "CALENDAR_BLOCK_STALE",
  );
  assert.match(
    describeBlockConversionError("CALENDAR_BLOCK_STALE"),
    /Actualizá la agenda/,
  );
  assert.deepEqual(
    await convertCalendarBlock(clientResult(null, databaseError), input),
    {
      appointmentId: null,
      created: false,
      error: "CALENDAR_BLOCK_STALE",
    },
  );
});
