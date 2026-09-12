import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import { importCalendarPatientAppointments } from "./patient-import.ts";

const START = "2026-09-16T23:00:00.000Z";
const END = "2026-09-17T00:00:00.000Z";
const APPOINTMENT = "11111111-1111-4111-8111-111111111111";
const MATIAS = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Matías Rivas",
  phone_e164: "+5492235550123",
  alternate_phone_e164: null,
};

function fake(options: {
  titles: string[];
  contacts?: (typeof MATIAS)[];
  contactReadError?: boolean;
  rpcError?: string;
  rpcResult?: unknown;
  serviceName?: string;
  professionals?: number;
  throwOnCall?: number;
}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const reads: Array<{
    table: string;
    filters: Array<[string, string, unknown]>;
  }> = [];
  const client = {
    from(table: string) {
      const read = { table, filters: [] as Array<[string, string, unknown]> };
      reads.push(read);
      const chain = {
        select() {
          return chain;
        },
        eq(key: string, value: unknown) {
          read.filters.push(["eq", key, value]);
          return chain;
        },
        gte(key: string, value: unknown) {
          read.filters.push(["gte", key, value]);
          return chain;
        },
        lte(key: string, value: unknown) {
          read.filters.push(["lte", key, value]);
          return chain;
        },
        gt(key: string, value: unknown) {
          read.filters.push(["gt", key, value]);
          return chain;
        },
        order() {
          return chain;
        },
        limit() {
          return chain;
        },
        then(
          resolve: (result: unknown) => unknown,
          reject: (error: unknown) => unknown,
        ) {
          const data =
            table === "google_calendar_external_events"
              ? options.titles.map((summary, index) => ({
                  google_event_id: `event${index}`,
                  summary,
                  starts_at: START,
                  ends_at: END,
                }))
              : table === "contacts"
                ? (options.contacts ?? [MATIAS])
                : table === "services"
                  ? [
                      {
                        id: "service",
                        name: options.serviceName ?? "Consulta",
                        requires_orthodontic_intake: false,
                      },
                    ]
                  : table === "professionals"
                    ? Array.from(
                        { length: options.professionals ?? 1 },
                        (_, id) => ({ id: `professional${id}` }),
                      )
                    : [];
          return Promise.resolve({
            data,
            error:
              table === "contacts" && options.contactReadError
                ? { message: "offline" }
                : null,
          }).then(resolve, reject);
        },
      };
      return chain;
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (calls.length === options.throwOnCall)
        throw new Error("transport failure");
      return Promise.resolve({
        data: options.rpcResult ?? [
          { appointment_id: APPOINTMENT, created: true },
        ],
        error: options.rpcError ? { message: options.rpcError } : null,
      });
    },
  };
  return { calls, reads, client: client as unknown as SupabaseClient };
}

function run(client: SupabaseClient) {
  return importCalendarPatientAppointments({
    client,
    calendarId: "calendar",
    generation: 5,
    automationEpoch: "33333333-3333-4333-8333-333333333333",
    coverageStartsAt: "2026-09-07T03:00:00.000Z",
    coverageEndsAt: "2026-09-28T03:00:00.000Z",
    now: new Date("2026-09-07T19:00:00.000Z"),
  });
}

test("recognizes Matías despite surname order and does not create schedule-block patients", async () => {
  const db = fake({
    titles: [
      "Rivas matias tf particular",
      "Miercoles 930 a 12 hs",
      "Evento sin título",
    ],
  });
  assert.deepEqual(await run(db.client), {
    appointmentsImported: 1,
    patientImportsNeedReview: 0,
    patientImportsFailed: 0,
  });
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].name, "import_google_calendar_patient_appointment");
  assert.equal(db.calls[0].args.p_contact_id, MATIAS.id);
  assert.equal(db.calls[0].args.p_coverage, "particular");
  assert.equal(db.calls[0].args.p_is_existing_patient, true);
  assert.equal(db.calls[0].args.p_expected_ends_at, END);
  assert.deepEqual(db.reads[0].filters.slice(0, 6), [
    ["eq", "google_calendar_id", "calendar"],
    ["eq", "connection_generation", 5],
    ["eq", "status", "active"],
    ["eq", "kind", "block"],
    ["eq", "all_day", false],
    ["eq", "recurring", false],
  ]);
});

test("new patient is only requested atomically when title has complete identity", async () => {
  const db = fake({
    titles: ["Ana Perez 1ra vez 2235550126 IOMA"],
    contacts: [],
  });
  assert.equal((await run(db.client)).appointmentsImported, 1);
  assert.equal(db.calls[0].args.p_contact_id, null);
  assert.equal(db.calls[0].args.p_patient_phone, "+5492235550126");
  assert.equal(db.calls[0].args.p_is_existing_patient, false);
  assert.equal(
    db.calls.length,
    1,
    "no separate patient creation or WhatsApp call",
  );
});

test("family-shared phone, incomplete title, and homonyms stay for review", async () => {
  for (const fixture of [
    { titles: ["Rivas julian 1ra vez 2235550123 particular"] },
    { titles: ["Matias Rivas TF"], contacts: [MATIAS] },
    { titles: ["Matias Rivas particular"], contacts: [MATIAS] },
    {
      titles: ["Rivas Matias TF particular"],
      contacts: [MATIAS, { ...MATIAS, id: "another" }],
    },
  ]) {
    const db = fake(fixture);
    assert.equal((await run(db.client)).patientImportsNeedReview, 1);
    assert.equal(db.calls.length, 0);
  }
});

test("a title without a phone still imports the agenda patient", async () => {
  // Gisela escribe casi todos sus turnos sin el celular; la ficha se
  // identifica por el nombre completo y el RPC rechaza los homónimos.
  const db = fake({ titles: ["Ana Perez TF IOMA"], contacts: [] });

  assert.equal((await run(db.client)).appointmentsImported, 1);
  assert.equal(db.calls[0].args.p_contact_id, null);
  assert.equal(db.calls[0].args.p_patient_phone, null);
  assert.equal(db.calls[0].args.p_patient_name, "Ana Perez");
  assert.equal(db.calls[0].args.p_coverage, "ioma");
});

test("does not choose arbitrary professional or service", async () => {
  for (const fixture of [
    { professionals: 2 },
    { serviceName: "Extracciones" },
  ]) {
    const db = fake({ ...fixture, titles: ["Rivas Matias TF particular"] });
    assert.equal((await run(db.client)).patientImportsNeedReview, 1);
    assert.equal(db.calls.length, 0);
  }
});

test("an unavailable contact list never appears empty and never creates a duplicate", async () => {
  const db = fake({
    titles: ["Rivas Matias TF 2235550123 particular"],
    contactReadError: true,
  });
  await assert.rejects(run(db.client), /CONTACTS_UNAVAILABLE/);
  assert.equal(db.calls.length, 0);
});

test("retries report existing conversion without a second created appointment", async () => {
  const db = fake({
    titles: ["Rivas Matias TF particular"],
    rpcResult: [{ appointment_id: APPOINTMENT, created: false }],
  });
  assert.equal((await run(db.client)).appointmentsImported, 0);
});

test("a transport failure after a successful import preserves the committed counter", async () => {
  const db = fake({
    titles: ["Rivas Matias TF particular", "Ana Perez 1ra vez 2235550126 IOMA"],
    throwOnCall: 2,
  });
  assert.deepEqual(await run(db.client), {
    appointmentsImported: 1,
    patientImportsNeedReview: 0,
    patientImportsFailed: 1,
  });
});

test("snapshot/collision rejection is review; unexpected errors are failed imports", async () => {
  for (const rpcError of [
    "CALENDAR_BLOCK_STALE",
    "CONTACT_IDENTITY_CONFLICT",
    "SLOT_UNAVAILABLE",
    "database offline",
  ]) {
    const db = fake({ titles: ["Rivas Matias TF particular"], rpcError });
    const result = await run(db.client);
    assert.equal(result.appointmentsImported, 0);
    assert.equal(
      result.patientImportsNeedReview,
      rpcError === "database offline" ? 0 : 1,
    );
    assert.equal(
      result.patientImportsFailed,
      rpcError === "database offline" ? 1 : 0,
    );
  }
});
