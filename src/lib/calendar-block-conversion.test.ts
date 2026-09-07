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

test("envía la selección de ortodoncia al RPC atómico y null si no corresponde", async () => {
  for (const visitType of [undefined, "first_visit", "in_treatment"] as const) {
    const client = {
      async rpc(name: string, params: Record<string, unknown>) {
        assert.equal(name, "convert_google_calendar_block_to_appointment");
        assert.equal(params.p_orthodontic_visit_type, visitType ?? null);
        assert.equal(params.p_google_event_id, input.googleEventId);
        assert.equal(params.p_contact_id, input.contactId);
        return {
          data: { appointment_id: APPOINTMENT_ID, created: true },
          error: null,
        };
      },
    } as unknown as SupabaseClient;

    const result = await convertCalendarBlock(client, {
      ...input,
      orthodonticVisitType: visitType,
    });
    assert.equal(result.appointmentId, APPOINTMENT_ID);
    assert.equal(result.error, null);
  }
});

test("crear paciente y convertir manda todos los datos en un único RPC atómico", async () => {
  let calls = 0;
  const client = {
    async rpc(name: string, params: Record<string, unknown>) {
      calls += 1;
      assert.equal(name, "convert_google_calendar_block_with_patient");
      assert.deepEqual(params, {
        p_google_event_id: input.googleEventId,
        p_contact_id: null,
        p_patient_name: "Matías Rivas",
        p_patient_phone: "+5492235550123",
        p_coverage: "particular",
        p_is_existing_patient: true,
        p_professional_id: input.professionalId,
        p_service_id: input.serviceId,
        p_starts_at: input.startsAt,
        p_internal_note: "Creado en Google",
        p_orthodontic_visit_type: null,
      });
      return {
        data: { appointment_id: APPOINTMENT_ID, created: true },
        error: null,
      };
    },
  } as unknown as SupabaseClient;
  assert.equal(
    (
      await convertCalendarBlock(client, {
        ...input,
        contactId: null,
        patientName: " Matías Rivas ",
        patientPhone: " +5492235550123 ",
        coverage: "particular",
        isExistingPatient: true,
        internalNote: " Creado en Google ",
      })
    ).appointmentId,
    APPOINTMENT_ID,
  );
  assert.equal(calls, 1);
});

test("completar cobertura usa la misma transacción que convierte sin crear otra ficha", async () => {
  const client = {
    async rpc(name: string, params: Record<string, unknown>) {
      assert.equal(name, "convert_google_calendar_block_with_patient");
      assert.equal(params.p_contact_id, input.contactId);
      assert.equal(params.p_coverage, "ioma");
      assert.equal(params.p_patient_name, null);
      assert.equal(params.p_patient_phone, null);
      assert.equal(params.p_is_existing_patient, null);
      return { data: null, error: { message: "SLOT_UNAVAILABLE" } };
    },
  } as unknown as SupabaseClient;
  assert.deepEqual(
    await convertCalendarBlock(client, {
      ...input,
      coverage: "ioma",
    }),
    {
      appointmentId: null,
      created: false,
      error: "SLOT_UNAVAILABLE",
    },
  );
});

test("errores del alta de paciente permiten corregir el formulario", async () => {
  for (const error of [
    "PATIENT_NAME_REQUIRED",
    "PATIENT_PHONE_REQUIRED",
    "PATIENT_PHONE_INVALID",
    "CONTACT_NOT_FOUND",
  ] as const) {
    assert.equal(blockConversionError(error), error);
    assert.deepEqual(
      await convertCalendarBlock(clientResult(null, { message: error }), {
        ...input,
        contactId: null,
      }),
      { appointmentId: null, created: false, error },
    );
    assert.doesNotMatch(
      describeBlockConversionError(error),
      /No pudimos comprobar/,
    );
  }
});

test("la validación de ortodoncia no se presenta como una conversión exitosa", async () => {
  for (const error of [
    "ORTHODONTIC_VISIT_TYPE_REQUIRED",
    "ORTHODONTIC_VISIT_TYPE_NOT_APPLICABLE",
  ] as const) {
    assert.deepEqual(
      await convertCalendarBlock(clientResult(null, { message: error }), input),
      { appointmentId: null, created: false, error },
    );
  }
  assert.match(
    describeBlockConversionError("ORTHODONTIC_VISIT_TYPE_REQUIRED"),
    /Primera vez.*En tratamiento con Gisela/,
  );
  assert.match(
    describeBlockConversionError("ORTHODONTIC_VISIT_TYPE_NOT_APPLICABLE"),
    /Volvé a elegir el servicio/,
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
