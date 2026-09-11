import assert from "node:assert/strict";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  type CalendarSyncDependencies,
  handleCalendarSyncRequest,
} from "./index.ts";
import { googleCalendarEventPayload } from "../_shared/google-calendar.ts";
import { refreshCalendarAvailabilityBeforeBooking } from "../_shared/calendar-booking-availability.ts";

type Authorize = NonNullable<CalendarSyncDependencies["authorize"]>;

function authorizationFor(
  role: "ADMIN" | "OPERADOR",
  id = "11111111-1111-4111-8111-111111111111",
): Authorize {
  return (() =>
    Promise.resolve({
      user: { id },
      profile: { id, full_name: "Gisela", role },
    })) as unknown as Authorize;
}

const ENVIRONMENT: Record<string, string> = {
  GOOGLE_CALENDAR_CLIENT_ID: "client-id",
  GOOGLE_CALENDAR_CLIENT_SECRET: "server-only-secret",
  GOOGLE_CALENDAR_REDIRECT_URI: "https://app.example.com/calendar/callback",
  APP_BASE_URL: "https://app.example.com",
  GOOGLE_CALENDAR_CRON_SECRET: "calendar-cron-secret-".padEnd(48, "x"),
};

const APPOINTMENT_ID = "8c4b7679-f3b8-4bd8-98cb-a5a57a49b9e1";
const MANAGED_EVENT_ID = "gl8c4b7679f3b84bd898cba5a57a49b9e1";
const APP_START = "2026-09-10T14:00:00.000Z";
const APP_END = "2026-09-10T15:00:00.000Z";
const MOVED_START = "2026-09-10T17:00:00.000Z";
const MOVED_END = "2026-09-10T18:00:00.000Z";
const TEST_NOW = Date.parse("2026-09-05T15:00:00.000Z");
const AUTOMATION_EPOCH = "77777777-7777-4777-8777-777777777777";
const COVERAGE_START = "2026-09-05T03:00:00.000Z";
const COVERAGE_END = "2026-09-26T03:00:00.000Z";
const PATIENT_DETAILS = {
  coverage: "ioma" as const,
  contact: {
    name: "Paciente Sintético",
    phone_e164: "+5492291550001",
    alternate_phone_e164: "+5492291550002",
    is_existing_patient: true,
  },
};

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

interface HttpCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

interface TableReadCall {
  table: string;
  columns: string;
  filterColumn: string;
  values: unknown[];
}

type RpcHandler = (args: Record<string, unknown>) => {
  data: unknown;
  error: unknown;
};

function fakeSupabase(
  handlers: Record<string, RpcHandler>,
  options: {
    existingAppointmentIds?: string[];
    appointmentReadError?: unknown;
    patientDetails?: unknown;
    patientDetailsError?: unknown;
    patientImportBlocks?: Array<Record<string, unknown>>;
    patientImportContacts?: Array<Record<string, unknown>>;
  } = {},
) {
  const rpcCalls: RpcCall[] = [];
  const tableReads: TableReadCall[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown> = {}) {
      rpcCalls.push({ name, args });
      const handler = handlers[name];
      return Promise.resolve(
        handler ? handler(args) : { data: null, error: null },
      );
    },
    from(table: string) {
      let columns = "";
      let filterColumn = "";
      let filterValue: unknown;
      const chain = {
        select(value: string) {
          columns = value;
          return chain;
        },
        eq(column: string, value: unknown) {
          filterColumn = column;
          filterValue = value;
          return chain;
        },
        gte() {
          return chain;
        },
        lte() {
          return chain;
        },
        gt() {
          return chain;
        },
        order() {
          return chain;
        },
        limit() {
          return chain;
        },
        then(
          resolve: (value: unknown) => unknown,
          reject: (error: unknown) => unknown,
        ) {
          return Promise.resolve({
            data:
              table === "google_calendar_external_events"
                ? (options.patientImportBlocks ?? [])
                : table === "contacts"
                  ? (options.patientImportContacts ?? [])
                  : table === "professionals"
                    ? [{ id: "professional-1" }]
                    : table === "services"
                      ? [
                          {
                            id: "service-1",
                            name: "Consulta",
                            requires_orthodontic_intake: false,
                          },
                        ]
                      : [],
            error: null,
          }).then(resolve, reject);
        },
        in(filterColumn: string, values: unknown[]) {
          tableReads.push({ table, columns, filterColumn, values });
          if (table === "appointments") {
            if (options.appointmentReadError) {
              return Promise.resolve({
                data: null,
                error: options.appointmentReadError,
              });
            }
            const existing = new Set(
              (options.existingAppointmentIds ?? []).map((id) =>
                id.toLowerCase(),
              ),
            );
            return Promise.resolve({
              data: values
                .filter(
                  (id): id is string =>
                    typeof id === "string" && existing.has(id.toLowerCase()),
                )
                .map((id) => ({ id: id.toLowerCase() })),
              error: null,
            });
          }
          return Promise.resolve({ data: [], error: null });
        },
        maybeSingle: () => {
          if (table === "appointments") {
            tableReads.push({
              table,
              columns,
              filterColumn,
              values: [filterValue],
            });
            return Promise.resolve({
              data:
                "patientDetails" in options
                  ? options.patientDetails
                  : PATIENT_DETAILS,
              error: options.patientDetailsError ?? null,
            });
          }
          return Promise.resolve({
            data:
              table === "app_settings"
                ? { appointment_buffer_minutes: 15 }
                : { status: "connected", connection_generation: 1 },
            error: null,
          });
        },
      };
      return chain;
    },
  };
  return {
    client: client as unknown as SupabaseClient,
    rpcCalls,
    tableReads,
  };
}

function jsonResponseOf(body: unknown, status = 200, etag?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(etag ? { ETag: etag } : {}),
    },
  });
}

/** Google simulado: enruta por método y URL, y registra el orden real. */
function fakeGoogle(route: (call: HttpCall) => Response | null): {
  fetcher: typeof fetch;
  calls: HttpCall[];
} {
  const calls: HttpCall[] = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit | undefined).forEach(
      (value, key) => {
        headers[key.toLowerCase()] = value;
      },
    );
    const call = {
      method,
      url,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(
        jsonResponseOf({ access_token: "access-token", expires_in: 3600 }),
      );
    }
    const routed = route(call);
    if (
      routed &&
      method === "GET" &&
      url.includes("/calendar/v3/calendars/") &&
      url.includes("/events?")
    ) {
      return routed
        .clone()
        .json()
        .then((body: unknown) => {
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return routed;
          }
          const page = body as Record<string, unknown>;
          return jsonResponseOf(
            {
              kind: page.kind ?? "calendar#events",
              timeZone: page.timeZone ?? "America/Argentina/Buenos_Aires",
              accessRole: page.accessRole ?? "owner",
              ...page,
            },
            routed.status,
            routed.headers.get("etag") ?? undefined,
          );
        });
    }
    if (routed) return Promise.resolve(routed);
    return Promise.resolve(jsonResponseOf({ error: "unexpected" }, 500));
  }) as typeof fetch;
  return { fetcher, calls };
}

function adminAuthorization(): Authorize {
  return authorizationFor("ADMIN");
}

function syncRequest(mode = "manual"): Request {
  return new Request("http://127.0.0.1/functions/v1/process-calendar-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

function automaticSyncRequest(body: Record<string, unknown> = {}): Request {
  return new Request("http://127.0.0.1/functions/v1/process-calendar-sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-google-calendar-cron-secret": ENVIRONMENT.GOOGLE_CALENDAR_CRON_SECRET,
    },
    body: JSON.stringify(body),
  });
}

function claimedUpsertJob(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    job_id: "33333333-3333-4333-8333-333333333333",
    appointment_id: APPOINTMENT_ID,
    operation: "upsert",
    desired_version: 1,
    attempts: 1,
    starts_at: APP_START,
    ends_at: APP_END,
    patient_name: "Paciente Sintético",
    timezone: "America/Argentina/Buenos_Aires",
    connection_generation: 1,
    google_event_id: MANAGED_EVENT_ID,
    automation_epoch: AUTOMATION_EPOCH,
    projection_stage: "confirmed",
    projected_stage: null,
    authorized_google_calendar_id: "cal-1",
    google_etag: null,
    ...overrides,
  };
}

function baseHandlers(
  overrides: Record<string, RpcHandler> = {},
): Record<string, RpcHandler> {
  return {
    get_google_calendar_automation_gate: () => ({
      data: [
        {
          automation_enabled: true,
          automation_epoch: AUTOMATION_EPOCH,
          google_calendar_id: "cal-1",
          connection_generation: 1,
        },
      ],
      error: null,
    }),
    purge_expired_google_calendar_connection_candidate: () => ({
      data: 0,
      error: null,
    }),
    reconcile_google_calendar_sync: () => ({
      data: [{ queued: 1, already_queued: 0 }],
      error: null,
    }),
    get_google_calendar_windowed_connection_secret: () => ({
      data: [
        {
          status: "connected",
          google_calendar_id: "cal-1",
          google_calendar_timezone: "America/Argentina/Buenos_Aires",
          refresh_token: "refresh-token",
          connection_generation: 1,
        },
      ],
      error: null,
    }),
    begin_google_calendar_inbound_sync: () => ({
      data: [
        {
          lease_token: "lease-1",
          sync_token: "token-previo",
          sync_state: "incremental",
          first_import_approved: true,
          google_calendar_id: "cal-1",
          google_calendar_timezone: "America/Argentina/Buenos_Aires",
        },
      ],
      error: null,
    }),
    claim_google_calendar_sync_jobs: () => ({ data: [], error: null }),
    authorize_google_calendar_sync_job: (args) => ({
      data: [
        {
          authorized: true,
          google_calendar_id: "cal-1",
          google_event_id: MANAGED_EVENT_ID,
          operation: "upsert",
          projection_stage: args.p_expected_stage,
          connection_generation: 1,
        },
      ],
      error: null,
    }),
    google_calendar_managed_event_is_current: () => ({
      data: true,
      error: null,
    }),
    expire_google_calendar_automation_booking_holds: () => ({
      data: [],
      error: null,
    }),
    claim_google_calendar_external_cleanup: () => ({ data: [], error: null }),
    release_google_calendar_inbound_lease: () => ({ data: true, error: null }),
    invalidate_google_calendar_sync_token: () => ({ data: true, error: null }),
    list_google_calendar_full_resync_managed_candidates: () => ({
      data: [],
      error: null,
    }),
    apply_google_calendar_external_event: () => ({
      data: "already_removed",
      error: null,
    }),
    fail_google_calendar_inbound_sync: () => ({ data: true, error: null }),
    complete_google_calendar_inbound_sync: () => ({ data: true, error: null }),
    record_google_calendar_sync_attempt: () => ({ data: true, error: null }),
    ...overrides,
  };
}

function eventsListResponse(items: unknown[]): Response {
  return jsonResponseOf({ items, nextSyncToken: "token-nuevo" });
}

function indexOfCall(calls: RpcCall[], name: string): number {
  return calls.findIndex((call) => call.name === name);
}

Deno.test(
  "patient imports wait for committed inbound and keep the original Google event",
  async () => {
    for (const mode of ["manual", "initial_import"]) {
      const db = fakeSupabase(
        baseHandlers({
          import_google_calendar_patient_appointment: () => ({
            data: [{ appointment_id: APPOINTMENT_ID, created: true }],
            error: null,
          }),
        }),
        {
          patientImportBlocks: [
            {
              google_event_id: "icardo-original",
              summary: "Icardo Matias TF particular",
              starts_at: APP_START,
              ends_at: APP_END,
            },
          ],
          patientImportContacts: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              name: "Matias Icardo",
              phone_e164: "+5492234541374",
            },
          ],
        },
      );
      const google = fakeGoogle((call) =>
        call.method === "GET" && call.url.includes("/events?")
          ? eventsListResponse([])
          : null,
      );
      const response = await handleCalendarSyncRequest(
        new Request("https://app.example.com/sync", {
          method: "POST",
          body: JSON.stringify({ mode }),
        }),
        {
          createClient: () => db.client,
          authorize: authorizationFor("ADMIN"),
          environment: (name) => ENVIRONMENT[name],
          fetcher: google.fetcher,
          now: () => TEST_NOW,
        },
      );
      const body = await response.json();
      assert.equal(response.status, 200);
      const imported = indexOfCall(
        db.rpcCalls,
        "import_google_calendar_patient_appointment",
      );
      if (mode === "manual") {
        assert.ok(
          imported >
            indexOfCall(db.rpcCalls, "complete_google_calendar_inbound_sync"),
        );
        assert.equal(body.summary.appointmentsImported, 1);
        assert.equal(body.outcome, "completed");
      } else {
        assert.equal(imported, -1);
        assert.equal(body.summary.appointmentsImported, 0);
      }
      assert.equal(
        google.calls.some(
          (call) =>
            call.url.includes("/events") &&
            ["POST", "PATCH", "DELETE"].includes(call.method),
        ),
        false,
      );
    }
  },
);

Deno.test("a failed inbound commit cannot trigger patient import", async () => {
  const db = fakeSupabase(
    baseHandlers({
      complete_google_calendar_inbound_sync: () => ({
        data: false,
        error: null,
      }),
    }),
    { patientImportBlocks: [{ summary: "Icardo Matias TF particular" }] },
  );
  const google = fakeGoogle((call) =>
    call.method === "GET" && call.url.includes("/events?")
      ? eventsListResponse([])
      : null,
  );
  const response = await handleCalendarSyncRequest(
    new Request("https://app.example.com/sync", {
      method: "POST",
      body: JSON.stringify({ mode: "manual" }),
    }),
    {
      createClient: () => db.client,
      authorize: authorizationFor("ADMIN"),
      environment: (name) => ENVIRONMENT[name],
      fetcher: google.fetcher,
      now: () => TEST_NOW,
    },
  );
  assert.equal(response.status, 503);
  assert.equal(
    indexOfCall(db.rpcCalls, "import_google_calendar_patient_appointment"),
    -1,
  );
});

Deno.test(
  "Google recibe nombre, ficha, celular y cobertura del turno",
  async () => {
    for (const { details, stage, expected } of [
      {
        details: {
          ...PATIENT_DETAILS,
          contact: { ...PATIENT_DETAILS.contact, coverage: "particular" },
        },
        stage: "confirmed",
        expected: "Paciente Sintético TF 2291550001 IOMA",
      },
      {
        details: {
          coverage: "particular",
          contact: {
            ...PATIENT_DETAILS.contact,
            name: "Ana Pérez",
            is_existing_patient: false,
          },
        },
        stage: "pre_reservation",
        expected:
          "Ana Pérez 1ra vez 2291550001 Particular (pendiente de seña)",
      },
      {
        details: {
          ...PATIENT_DETAILS,
          contact: { ...PATIENT_DETAILS.contact, phone_e164: null },
        },
        stage: "confirmed",
        expected: "Paciente Sintético TF 2291550002 IOMA",
      },
      {
        details: {
          coverage: null,
          contact: {
            ...PATIENT_DETAILS.contact,
            is_existing_patient: null,
            phone_e164: null,
            alternate_phone_e164: null,
          },
        },
        stage: "confirmed",
        expected:
          "Paciente Sintético (ficha sin confirmar) (celular sin confirmar) (cobertura sin confirmar)",
      },
    ]) {
      const { client, tableReads } = fakeSupabase(
        baseHandlers({
          claim_google_calendar_sync_jobs: () => ({
            data: [
              claimedUpsertJob({
                patient_name: "Nombre anterior",
                projection_stage: stage,
              }),
            ],
            error: null,
          }),
          complete_google_calendar_sync_job: () => ({
            data: true,
            error: null,
          }),
        }),
        { patientDetails: details },
      );
      const { fetcher, calls } = fakeGoogle((call) => {
        if (call.method === "GET" && call.url.includes("/events?"))
          return eventsListResponse([]);
        if (call.method === "POST" && call.url.includes("/events?")) {
          return jsonResponseOf({ id: MANAGED_EVENT_ID, etag: '"created"' });
        }
        return null;
      });
      const response = await handleCalendarSyncRequest(syncRequest(), {
        createClient: () => client,
        authorize: adminAuthorization(),
        environment: (name) => ENVIRONMENT[name],
        fetcher,
      });
      assert.equal((await response.json()).synced, 1);
      const event = calls.find(
        (call) => call.method === "POST" && call.url.includes("/events?"),
      );
      assert.equal(event?.body?.summary, expected);
      assert.equal(event?.body?.visibility, "private");
      const patientRead = tableReads.find(
        (read) => read.table === "appointments",
      );
      assert.equal(patientRead?.filterColumn, "id");
      assert.deepEqual(patientRead?.values, [APPOINTMENT_ID]);
      assert.equal(patientRead?.columns.includes("internal_note"), false);
    }
  },
);

Deno.test(
  "una lectura fallida del paciente reintenta sin escribir un evento incompleto",
  async () => {
    for (const options of [
      { patientDetailsError: { message: "fallo privado de lectura" } },
      { patientDetails: null },
      { patientDetails: { coverage: "ioma", contact: null } },
    ]) {
      const { client, rpcCalls } = fakeSupabase(
        baseHandlers({
          claim_google_calendar_sync_jobs: () => ({
            data: [claimedUpsertJob()],
            error: null,
          }),
        }),
        options,
      );
      const { fetcher, calls } = fakeGoogle((call) =>
        call.method === "GET" && call.url.includes("/events?")
          ? eventsListResponse([])
          : null,
      );
      const response = await handleCalendarSyncRequest(syncRequest(), {
        createClient: () => client,
        authorize: adminAuthorization(),
        environment: (name) => ENVIRONMENT[name],
        fetcher,
      });
      const body = await response.json();
      assert.equal(body.synced, 0);
      assert.equal(body.retried, 1);
      assert.equal(
        calls.some(
          (call) => call.url.includes("/events") && call.method !== "GET",
        ),
        false,
      );
      const failure = rpcCalls.find(
        (call) => call.name === "fail_google_calendar_sync_job",
      );
      assert.equal(
        failure?.args.p_error_code,
        "CALENDAR_PATIENT_DETAILS_UNAVAILABLE",
      );
      assert.equal(failure?.args.p_terminal, false);
      assert.equal(JSON.stringify(body).includes("fallo privado"), false);
    }
  },
);

Deno.test(
  "el nuevo título actualiza el mismo evento confirmado con su ETag",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        claim_google_calendar_sync_jobs: () => ({
          data: [
            claimedUpsertJob({
              projected_stage: "confirmed",
              google_etag: '"previous"',
            }),
          ],
          error: null,
        }),
        complete_google_calendar_sync_job: () => ({ data: true, error: null }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) => {
      if (call.method === "GET" && call.url.includes("/events?"))
        return eventsListResponse([]);
      if (call.method === "POST" && call.url.includes("/events?"))
        return jsonResponseOf({}, 409);
      if (call.method === "GET" && call.url.includes(`/${MANAGED_EVENT_ID}`)) {
        return jsonResponseOf({
          id: MANAGED_EVENT_ID,
          etag: '"previous"',
          summary: "Turno confirmado · Paciente Sintético",
          extendedProperties: {
            private: {
              managed_by: "gisela_lentz_agenda",
              appointment_id: APPOINTMENT_ID,
              automation_epoch: AUTOMATION_EPOCH,
              projection_stage: "confirmed",
            },
          },
        });
      }
      if (call.method === "PATCH") return jsonResponseOf({ etag: '"updated"' });
      return null;
    });
    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    assert.equal((await response.json()).synced, 1);
    const patch = calls.find((call) => call.method === "PATCH");
    assert.equal(
      patch?.body?.summary,
      "Paciente Sintético TF 2291550001 IOMA",
    );
    assert.equal(patch?.headers["if-match"], '"previous"');
    assert.equal(
      new URL(patch!.url).pathname.endsWith(`/${MANAGED_EVENT_ID}`),
      true,
    );
    const completed = rpcCalls.find(
      (call) => call.name === "complete_google_calendar_sync_job",
    );
    assert.equal(completed?.args.p_google_event_id, MANAGED_EVENT_ID);
    assert.equal(completed?.args.p_google_etag, '"updated"');
  },
);

Deno.test(
  "A: una reproyección pendiente no pisa en Google un cambio externo",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        observe_google_calendar_managed_event: () => ({
          data: "conflict_recorded",
          error: null,
        }),
        // La cola retiene el upsert mientras el conflicto siga pendiente.
        claim_google_calendar_sync_jobs: () => ({ data: [], error: null }),
      }),
    );
    const managedPayload = await googleCalendarEventPayload(
      {
        appointment_id: APPOINTMENT_ID,
        starts_at: MOVED_START,
        ends_at: MOVED_END,
        patient_name: "Paciente ficticio",
        patient_phone: "+5492291550001",
        is_existing_patient: true,
        coverage: "ioma",
        timezone: "America/Argentina/Buenos_Aires",
      },
      {
        eventId: MANAGED_EVENT_ID,
        automationEpoch: AUTOMATION_EPOCH,
        projectionStage: "confirmed",
        projectedStage: "confirmed",
      },
      true,
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            {
              ...managedPayload,
              etag: '"etag-remoto"',
              updated: "2026-09-03T10:00:00.000Z",
            },
          ])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, string | number>;

    // El pull ocurre ANTES que cualquier escritura hacia Google.
    const listIndex = calls.findIndex(
      (call) => call.method === "GET" && call.url.includes("/events?"),
    );
    const firstWriteIndex = calls.findIndex(
      (call) => call.method !== "GET" && call.url.includes("/events"),
    );
    assert.ok(listIndex >= 0, "el pull tiene que ejecutarse");
    assert.equal(firstWriteIndex, -1, "no puede haber escrituras hacia Google");
    assert.ok(
      indexOfCall(rpcCalls, "observe_google_calendar_managed_event") <
        indexOfCall(rpcCalls, "claim_google_calendar_sync_jobs"),
      "la observación tiene que preceder al claim de la cola saliente",
    );

    const observe = rpcCalls.find(
      (call) => call.name === "observe_google_calendar_managed_event",
    );
    assert.equal(observe?.args.p_appointment_id, APPOINTMENT_ID);
    assert.equal(observe?.args.p_automation_epoch, AUTOMATION_EPOCH);
    assert.equal(observe?.args.p_remote_projection_stage, "confirmed");
    assert.equal(observe?.args.p_payload_fingerprint_valid, true);
    assert.equal(observe?.args.p_starts_at, MOVED_START);
    assert.equal(observe?.args.p_google_etag, '"etag-remoto"');
    assert.equal(body.outcome, "completed");
    assert.equal(
      (body as unknown as { summary: { conflictsOpened: number } }).summary
        .conflictsOpened,
      1,
    );
  },
);

Deno.test(
  "un turno manual agregado entre el pull y el push impide escribir en Google",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        claim_google_calendar_sync_jobs: () => ({
          data: [claimedUpsertJob()],
          error: null,
        }),
      }),
    );
    let lists = 0;
    const { fetcher, calls } = fakeGoogle((call) => {
      if (call.method === "GET" && call.url.includes("/events?")) {
        lists += 1;
        return eventsListResponse(
          lists === 1
            ? []
            : [
                {
                  id: "human-booking-after-inbound",
                  start: { dateTime: APP_START },
                  end: { dateTime: APP_END },
                },
              ],
        );
      }
      return null;
    });
    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = await response.json();
    assert.equal(lists, 2);
    assert.equal(body.retried, 1);
    assert.equal(body.synced, 0);
    assert.equal(
      calls.some(
        (call) =>
          call.url.includes("/events") &&
          ["POST", "PATCH", "DELETE"].includes(call.method),
      ),
      false,
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_sync_job",
      ),
      false,
    );
    assert.equal(
      rpcCalls.find((call) => call.name === "fail_google_calendar_sync_job")
        ?.args.p_error_code,
      "GOOGLE_CALENDAR_SLOT_OCCUPIED",
    );
  },
);

Deno.test(
  "inbound adopta un POST pendiente perdido antes de confirmar el mismo evento",
  async () => {
    const pendingPayload = await googleCalendarEventPayload(
      {
        appointment_id: APPOINTMENT_ID,
        starts_at: APP_START,
        ends_at: APP_END,
        patient_name: "Paciente ficticio",
        patient_phone: "+5492291550001",
        is_existing_patient: true,
        coverage: "ioma",
        timezone: "America/Argentina/Buenos_Aires",
      },
      {
        eventId: MANAGED_EVENT_ID,
        automationEpoch: AUTOMATION_EPOCH,
        projectionStage: "pre_reservation",
        projectedStage: null,
      },
      true,
    );
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        observe_google_calendar_managed_event: () => ({
          data: "pending_push",
          error: null,
        }),
        claim_google_calendar_sync_jobs: () => ({
          data: [
            claimedUpsertJob({
              desired_version: 2,
              google_etag: '"etag-pendiente-observado"',
              projected_stage: "pre_reservation",
            }),
          ],
          error: null,
        }),
        complete_google_calendar_sync_job: () => ({
          data: true,
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) => {
      if (call.method === "GET" && call.url.includes("/events?")) {
        return eventsListResponse([
          {
            ...pendingPayload,
            etag: '"etag-pendiente-observado"',
            updated: "2026-09-05T15:00:00.000Z",
          },
        ]);
      }
      if (call.method === "POST" && call.url.includes("/events?")) {
        return jsonResponseOf({ error: { message: "duplicate" } }, 409);
      }
      if (call.method === "GET" && call.url.includes(`/${MANAGED_EVENT_ID}`)) {
        return jsonResponseOf({
          ...pendingPayload,
          etag: '"etag-pendiente-observado"',
        });
      }
      if (call.method === "PATCH") {
        return jsonResponseOf({}, 200, '"etag-confirmado"');
      }
      return null;
    });

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    const observe = rpcCalls.find(
      (call) => call.name === "observe_google_calendar_managed_event",
    );
    assert.equal(observe?.args.p_payload_fingerprint_valid, true);
    assert.ok(
      indexOfCall(rpcCalls, "observe_google_calendar_managed_event") <
        indexOfCall(rpcCalls, "claim_google_calendar_sync_jobs"),
    );
    assert.deepEqual(
      rpcCalls.find((call) => call.name === "claim_google_calendar_sync_jobs")
        ?.args,
      {
        p_limit: 3,
        p_expected_generation: 1,
        p_projection_contract_version: 2,
      },
    );
    assert.ok(
      indexOfCall(rpcCalls, "claim_google_calendar_sync_jobs") <
        indexOfCall(rpcCalls, "authorize_google_calendar_sync_job"),
    );
    assert.ok(
      indexOfCall(rpcCalls, "authorize_google_calendar_sync_job") <
        indexOfCall(rpcCalls, "complete_google_calendar_sync_job"),
    );
    const eventMethods = calls.filter((call) => call.url.includes("/events"));
    assert.deepEqual(
      eventMethods.map((call) => call.method),
      ["GET", "GET", "POST", "GET", "GET", "PATCH"],
    );
    assert.equal(
      eventMethods.at(-1)?.headers["if-match"],
      '"etag-pendiente-observado"',
    );
    const completion = rpcCalls.find(
      (call) => call.name === "complete_google_calendar_sync_job",
    );
    assert.equal(completion?.args.p_google_event_id, MANAGED_EVENT_ID);
    assert.equal(completion?.args.p_google_etag, '"etag-confirmado"');
    assert.equal(completion?.args.p_projection_stage, "confirmed");
    assert.equal(body.outcome, "completed");
    assert.equal(body.synced, 1);
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "claim_google_calendar_external_cleanup",
      ),
      false,
    );
  },
);

Deno.test(
  "B: cambio simultáneo en la app y en Google conserva la propuesta externa",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        observe_google_calendar_managed_event: () => ({
          data: "conflict_recorded",
          error: null,
        }),
        claim_google_calendar_sync_jobs: () => ({ data: [], error: null }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            {
              id: MANAGED_EVENT_ID,
              status: "confirmed",
              etag: '"etag-b"',
              extendedProperties: {
                private: {
                  managed_by: "gisela_lentz_agenda",
                  appointment_id: APPOINTMENT_ID,
                  automation_epoch: AUTOMATION_EPOCH,
                  projection_stage: "confirmed",
                },
              },
              // Un tercer horario: ni el de la app ni el último proyectado.
              start: { dateTime: MOVED_START },
              end: { dateTime: MOVED_END },
            },
          ])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(
      calls.filter((call) => call.method === "PATCH").length,
      0,
      "no se puede reproyectar sobre un evento con conflicto pendiente",
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_sync_job",
      ),
      false,
    );
    // El conflicto es durable, así que avanzar el syncToken no pierde nada.
    const completion = rpcCalls.find(
      (call) => call.name === "complete_google_calendar_inbound_sync",
    );
    assert.equal(completion?.args.p_next_sync_token, "token-nuevo");
    assert.equal(body.outcome, "completed");
  },
);

Deno.test(
  "C: un evento borrado sin extendedProperties se reconoce por su mapeo",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        observe_google_calendar_managed_event: () => ({
          data: "conflict_recorded",
          error: null,
        }),
        google_calendar_managed_appointment_for_event: () => ({
          data: APPOINTMENT_ID,
          error: null,
        }),
        claim_google_calendar_sync_jobs: () => ({ data: [], error: null }),
      }),
    );
    const { fetcher } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            // Sin extendedProperties y con un id que no es el determinista:
            // sólo el mapeo guardado permite identificarlo.
            {
              id: "evento-opaco-borrado",
              status: "cancelled",
              etag: '  "etag-tombstone"  ',
            },
          ])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    const mapping = rpcCalls.find(
      (call) => call.name === "google_calendar_managed_appointment_for_event",
    );
    assert.equal(mapping?.args.p_google_event_id, "evento-opaco-borrado");
    const observe = rpcCalls.find(
      (call) => call.name === "observe_google_calendar_managed_event",
    );
    assert.equal(observe?.args.p_appointment_id, APPOINTMENT_ID);
    assert.equal(observe?.args.p_cancelled, true);
    assert.equal(observe?.args.p_google_etag, '"etag-tombstone"');
    // Nunca se importa como bloqueo externo un evento que era un turno. La
    // única aplicación permitida retira idempotentemente un fallback previo.
    const fallbackRetirement = rpcCalls.find(
      (call) => call.name === "apply_google_calendar_external_event",
    );
    assert.equal(
      fallbackRetirement?.args.p_google_event_id,
      "evento-opaco-borrado",
    );
    assert.equal(fallbackRetirement?.args.p_removed, true);
    assert.equal(body.outcome, "completed");
  },
);

Deno.test(
  "un evento externo libre mapeado no cancela ni resuelve el turno asociado",
  async () => {
    const externalEventId = "evento-externo-libre-mapeado";
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        google_calendar_managed_appointment_for_event: () => ({
          data: APPOINTMENT_ID,
          error: null,
        }),
        observe_google_calendar_managed_event: () => ({
          data: "conflict_recorded",
          error: null,
        }),
        apply_google_calendar_external_event: () => ({
          data: "removed",
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            {
              id: externalEventId,
              status: "confirmed",
              transparency: "transparent",
              start: { dateTime: "2026-09-10T13:00:00.000Z" },
              end: { dateTime: "2026-09-10T14:00:00.000Z" },
            },
          ])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
      now: () => TEST_NOW,
    });
    const body = (await response.json()) as {
      outcome: string;
      summary: { blocksRemoved: number; conflictsOpened: number };
    };

    assert.equal(response.status, 200);
    assert.equal(body.outcome, "completed");
    assert.equal(body.summary.blocksRemoved, 1);
    assert.equal(body.summary.conflictsOpened, 0);
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "google_calendar_managed_appointment_for_event",
      ),
      false,
      "sólo una cancelación remota consulta el mapeo de turnos",
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "observe_google_calendar_managed_event",
      ),
      false,
      "un evento libre externo no puede cancelar ni resolver un turno",
    );
    const externalRemoval = rpcCalls.find(
      (call) => call.name === "apply_google_calendar_external_event",
    );
    assert.equal(externalRemoval?.args.p_google_event_id, externalEventId);
    assert.equal(externalRemoval?.args.p_removed, true);
    assert.equal(
      externalRemoval?.args.p_unsupported_reason,
      "TRANSPARENT_EVENT",
    );
    assert.equal(externalRemoval?.args.p_starts_at, null);
    assert.equal(externalRemoval?.args.p_ends_at, null);
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
    );
  },
);

Deno.test(
  "C bis: un id determinista sin epoch queda externo y sólo lectura",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        observe_google_calendar_managed_event: () => ({
          data: "conflict_recorded",
          error: null,
        }),
      }),
    );
    const { fetcher } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([{ id: MANAGED_EVENT_ID, status: "cancelled" }])
        : null,
    );

    await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });

    assert.equal(
      rpcCalls.some(
        (call) => call.name === "observe_google_calendar_managed_event",
      ),
      false,
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "google_calendar_managed_appointment_for_event",
      ),
      false,
    );
    const external = rpcCalls.find(
      (call) => call.name === "apply_google_calendar_external_event",
    );
    assert.equal(external?.args.p_google_event_id, MANAGED_EVENT_ID);
    assert.equal(external?.args.p_removed, true);
  },
);

Deno.test(
  "la primera importación preserva un managed huérfano como bloqueo y el retry es idempotente",
  async () => {
    const legacyEventId = "evento-managed-de-integracion-anterior";
    let leases = 0;
    let applications = 0;
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        begin_google_calendar_inbound_sync: () => {
          leases += 1;
          return {
            data: [
              {
                lease_token: `lease-${leases}`,
                sync_token: leases === 1 ? null : "token-primera-corrida",
                first_import_approved: true,
                google_calendar_id: "cal-1",
                google_calendar_timezone: "America/Argentina/Buenos_Aires",
              },
            ],
            error: null,
          };
        },
        observe_google_calendar_managed_event: () => ({
          data: "ignored_unknown_appointment",
          error: null,
        }),
        apply_google_calendar_external_event: () => {
          applications += 1;
          return {
            data: applications === 1 ? "created" : "unchanged",
            error: null,
          };
        },
        reconcile_google_calendar_external_events: () => ({
          data: 0,
          error: null,
        }),
      }),
    );
    const legacyEvent = {
      id: legacyEventId,
      status: "confirmed",
      summary: "Evento legado sin turno local",
      etag: '"etag-legado"',
      updated: "2099-01-01T09:00:00.000Z",
      extendedProperties: {
        private: {
          managed_by: "gisela_lentz_agenda",
          appointment_id: APPOINTMENT_ID,
        },
      },
      start: { dateTime: "2099-01-01T10:00:00.000Z" },
      end: { dateTime: "2099-01-01T11:00:00.000Z" },
    };
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([legacyEvent])
        : null,
    );

    const firstResponse = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const firstBody = (await firstResponse.json()) as {
      summary: {
        blocksImported: number;
        blocksUnchanged: number;
        skipped: number;
        fullResync: boolean;
      };
    };
    const retryResponse = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const retryBody = (await retryResponse.json()) as {
      summary: {
        blocksImported: number;
        blocksUnchanged: number;
        skipped: number;
        fullResync: boolean;
      };
    };

    assert.equal(firstResponse.status, 200);
    assert.equal(firstBody.summary.blocksImported, 1);
    assert.equal(firstBody.summary.blocksUnchanged, 0);
    assert.equal(firstBody.summary.skipped, 0);
    assert.equal(firstBody.summary.fullResync, true);
    assert.equal(retryResponse.status, 200);
    assert.equal(retryBody.summary.blocksImported, 0);
    assert.equal(retryBody.summary.blocksUnchanged, 1);
    assert.equal(retryBody.summary.skipped, 0);
    assert.equal(retryBody.summary.fullResync, false);

    const observations = rpcCalls.filter(
      (call) => call.name === "observe_google_calendar_managed_event",
    );
    const externalApplications = rpcCalls.filter(
      (call) => call.name === "apply_google_calendar_external_event",
    );
    assert.equal(observations.length, 0);
    assert.equal(externalApplications.length, 2);
    assert.equal(externalApplications[0].args.p_expected_generation, 1);
    assert.equal(externalApplications[0].args.p_lease_token, "lease-1");
    assert.equal(externalApplications[1].args.p_lease_token, "lease-2");
    for (const application of externalApplications) {
      assert.equal(application.args.p_google_event_id, legacyEventId);
      assert.equal(application.args.p_kind, "block");
      assert.equal(application.args.p_removed, false);
      assert.equal(application.args.p_summary, "Evento legado sin turno local");
      assert.equal(application.args.p_starts_at, "2099-01-01T10:00:00.000Z");
      assert.equal(application.args.p_ends_at, "2099-01-01T11:00:00.000Z");
    }
    const reconciliation = rpcCalls.find(
      (call) => call.name === "reconcile_google_calendar_external_events",
    );
    assert.deepEqual(reconciliation?.args.p_seen_event_ids, [legacyEventId]);
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
      "la recuperación sólo registra el bloqueo local; nunca toca Google",
    );
  },
);

Deno.test(
  "la cancelación de un managed huérfano retira el bloqueo externo sin tocar Google",
  async () => {
    const legacyEventId = "evento-managed-huerfano-cancelado";
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        observe_google_calendar_managed_event: () => ({
          data: "ignored_unknown_appointment",
          error: null,
        }),
        apply_google_calendar_external_event: () => ({
          data: "removed",
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            {
              id: legacyEventId,
              status: "cancelled",
              etag: '"etag-cancelado"',
              updated: "2099-01-02T09:00:00.000Z",
              extendedProperties: {
                private: {
                  managed_by: "gisela_lentz_agenda",
                  appointment_id: APPOINTMENT_ID,
                  automation_epoch: AUTOMATION_EPOCH,
                  projection_stage: "confirmed",
                },
              },
            },
          ])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as {
      summary: { blocksRemoved: number; skipped: number };
    };

    assert.equal(response.status, 200);
    const application = rpcCalls.find(
      (call) => call.name === "apply_google_calendar_external_event",
    );
    assert.equal(application?.args.p_google_event_id, legacyEventId);
    assert.equal(application?.args.p_expected_generation, 1);
    assert.equal(application?.args.p_lease_token, "lease-1");
    assert.equal(application?.args.p_removed, true);
    assert.equal(application?.args.p_summary, null);
    assert.equal(application?.args.p_starts_at, null);
    assert.equal(application?.args.p_ends_at, null);
    assert.equal(application?.args.p_google_etag, '"etag-cancelado"');
    assert.equal(body.summary.blocksRemoved, 1);
    assert.equal(body.summary.skipped, 0);
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
    );
  },
);

Deno.test(
  "un UUID managed que contradice el id determinista no avanza token ni hace fallback",
  async () => {
    const otherAppointmentId = "9d5c878a-a4c9-4ce9-89dc-b6b68b50caf2";
    const { client, rpcCalls } = fakeSupabase(baseHandlers());
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            {
              id: MANAGED_EVENT_ID,
              status: "confirmed",
              extendedProperties: {
                private: {
                  managed_by: "gisela_lentz_agenda",
                  appointment_id: otherAppointmentId,
                  automation_epoch: AUTOMATION_EPOCH,
                  projection_stage: "confirmed",
                },
              },
              start: { dateTime: APP_START },
              end: { dateTime: APP_END },
            },
          ])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as {
      outcome: string;
      inbound: { error: string };
    };

    assert.equal(response.status, 503);
    assert.equal(body.outcome, "error");
    assert.equal(body.inbound.error, "CALENDAR_INBOUND_MANAGED_EVENT_MISMATCH");
    const failure = rpcCalls.find(
      (call) => call.name === "fail_google_calendar_inbound_sync",
    );
    assert.equal(
      failure?.args.p_error_code,
      "CALENDAR_INBOUND_MANAGED_EVENT_MISMATCH",
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "observe_google_calendar_managed_event",
      ),
      false,
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "apply_google_calendar_external_event",
      ),
      false,
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_inbound_sync",
      ),
      false,
    );
    assert.equal(
      rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
      false,
    );
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
    );
  },
);

Deno.test(
  "un managed conocido retira idempotentemente cualquier bloqueo fallback previo",
  async () => {
    let retirements = 0;
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        observe_google_calendar_managed_event: () => ({
          data: "in_sync",
          error: null,
        }),
        apply_google_calendar_external_event: () => {
          retirements += 1;
          return {
            data: retirements === 1 ? "removed" : "already_removed",
            error: null,
          };
        },
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            {
              id: MANAGED_EVENT_ID,
              status: "confirmed",
              etag: '"etag-managed"',
              updated: "2099-01-03T09:00:00.000Z",
              extendedProperties: {
                private: {
                  managed_by: "gisela_lentz_agenda",
                  appointment_id: APPOINTMENT_ID,
                  automation_epoch: AUTOMATION_EPOCH,
                  projection_stage: "confirmed",
                },
              },
              start: { dateTime: APP_START },
              end: { dateTime: APP_END },
            },
          ])
        : null,
    );

    const firstResponse = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const firstBody = (await firstResponse.json()) as {
      summary: {
        managedInSync: number;
        blocksRemoved: number;
        skipped: number;
      };
    };
    const retryResponse = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const retryBody = (await retryResponse.json()) as typeof firstBody;

    assert.equal(firstResponse.status, 200);
    assert.equal(firstBody.summary.managedInSync, 1);
    assert.equal(firstBody.summary.blocksRemoved, 1);
    assert.equal(firstBody.summary.skipped, 0);
    assert.equal(retryResponse.status, 200);
    assert.equal(retryBody.summary.managedInSync, 1);
    assert.equal(retryBody.summary.blocksRemoved, 0);
    assert.equal(retryBody.summary.skipped, 0);
    const applications = rpcCalls.filter(
      (call) => call.name === "apply_google_calendar_external_event",
    );
    assert.equal(applications.length, 2);
    for (const application of applications) {
      assert.equal(application.args.p_google_event_id, MANAGED_EVENT_ID);
      assert.equal(application.args.p_removed, true);
      assert.equal(application.args.p_google_etag, '"etag-managed"');
    }
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
    );
  },
);

Deno.test(
  "un 412 no fuerza la escritura: reintenta y deja la corrida como parcial",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        observe_google_calendar_managed_event: () => ({
          data: "in_sync",
          error: null,
        }),
        claim_google_calendar_sync_jobs: () => ({
          data: [
            claimedUpsertJob({
              job_id: "22222222-2222-4222-8222-222222222222",
              desired_version: 3,
              projected_stage: "confirmed",
              google_etag: '"etag-conocido"',
            }),
          ],
          error: null,
        }),
        fail_google_calendar_sync_job: () => ({ data: true, error: null }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) => {
      if (call.method === "GET" && call.url.includes("/events?")) {
        return eventsListResponse([]);
      }
      if (call.method === "POST" && call.url.includes("/events?")) {
        return jsonResponseOf({ error: { message: "duplicate" } }, 409);
      }
      if (call.method === "GET" && call.url.includes(`/${MANAGED_EVENT_ID}`)) {
        return jsonResponseOf({
          id: MANAGED_EVENT_ID,
          etag: '"etag-conocido"',
          extendedProperties: {
            private: {
              managed_by: "gisela_lentz_agenda",
              appointment_id: APPOINTMENT_ID,
              automation_epoch: AUTOMATION_EPOCH,
              projection_stage: "confirmed",
            },
          },
        });
      }
      if (call.method === "PATCH") {
        return jsonResponseOf({ error: { message: "conditionNotMet" } }, 412);
      }
      return null;
    });

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    const patch = calls.find((call) => call.method === "PATCH");
    assert.equal(patch?.headers["if-match"], '"etag-conocido"');
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_sync_job",
      ),
      false,
      "un 412 nunca puede darse por completado",
    );
    const failure = rpcCalls.find(
      (call) => call.name === "fail_google_calendar_sync_job",
    );
    assert.equal(
      failure?.args.p_error_code,
      "GOOGLE_EVENT_PRECONDITION_FAILED",
    );
    assert.equal(failure?.args.p_terminal, false);
    assert.equal(body.outcome, "partial");
  },
);

Deno.test(
  "un push exitoso guarda ETag y horario proyectado para la próxima lectura",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        claim_google_calendar_sync_jobs: () => ({
          data: [claimedUpsertJob()],
          error: null,
        }),
        complete_google_calendar_sync_job: () => ({ data: true, error: null }),
      }),
    );
    const { fetcher } = fakeGoogle((call) => {
      if (call.method === "GET" && call.url.includes("/events?")) {
        return eventsListResponse([]);
      }
      if (call.method === "POST" && call.url.includes("/events?")) {
        return jsonResponseOf({ id: MANAGED_EVENT_ID }, 200, '"etag-nuevo"');
      }
      return null;
    });

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    const completion = rpcCalls.find(
      (call) => call.name === "complete_google_calendar_sync_job",
    );
    assert.equal(completion?.args.p_google_etag, '"etag-nuevo"');
    assert.equal(completion?.args.p_projected_starts_at, APP_START);
    assert.equal(completion?.args.p_projected_ends_at, APP_END);
    assert.equal(completion?.args.p_automation_epoch, AUTOMATION_EPOCH);
    assert.equal(completion?.args.p_projection_stage, "confirmed");
    assert.equal(body.outcome, "completed");
  },
);

Deno.test(
  "una ejecución con el lease ocupado se reporta omitida, no exitosa",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        begin_google_calendar_inbound_sync: () => ({ data: [], error: null }),
        record_google_calendar_sync_attempt: () => ({
          data: true,
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle(() => null);

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(body.outcome, "skipped");
    assert.equal(
      (body.inbound as { skippedReason: string }).skippedReason,
      "INBOUND_SYNC_IN_PROGRESS",
    );
    assert.equal(
      calls.some((call) => call.url.includes("/events?")),
      false,
      "sin lease no se lee el calendario",
    );
    // La revisión igual queda registrada.
    assert.ok(
      rpcCalls.some(
        (call) => call.name === "record_google_calendar_sync_attempt",
      ),
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_inbound_sync",
      ),
      false,
    );
    assert.equal(
      rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
      false,
      "un lease ocupado también bloquea todo push",
    );
  },
);

Deno.test(
  "la reserva espera un lease ocupado y exige un pull completo del worker real",
  async () => {
    let elapsed = 0;
    let leaseAttempts = 0;
    const handlers = baseHandlers();
    const { client, rpcCalls } = fakeSupabase({
      ...handlers,
      begin_google_calendar_inbound_sync: (args) => {
        leaseAttempts += 1;
        return leaseAttempts === 1
          ? { data: [], error: null }
          : handlers.begin_google_calendar_inbound_sync(args);
      },
    });
    const google = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([])
        : null,
    );
    const outcomes: unknown[] = [];
    const accepted = await refreshCalendarAvailabilityBeforeBooking({
      projectUrl: "https://project.example.test",
      cronSecret: ENVIRONMENT.GOOGLE_CALENDAR_CRON_SECRET,
      now: () => elapsed,
      sleep: (milliseconds, signal) => {
        signal.throwIfAborted();
        assert.equal(milliseconds, 1_000);
        elapsed += milliseconds;
        return Promise.resolve();
      },
      fetcher: async (url, init) => {
        const response = await handleCalendarSyncRequest(
          new Request(String(url), init),
          {
            createClient: () => client,
            environment: (name) => ENVIRONMENT[name],
            fetcher: google.fetcher,
            now: () => TEST_NOW + elapsed,
          },
        );
        const body = await response.clone().json();
        outcomes.push(body.outcome);
        if (outcomes.length === 1) {
          assert.equal(response.status, 200);
          assert.equal(body.inbound.skippedReason, "INBOUND_SYNC_IN_PROGRESS");
          assert.equal(
            google.calls.some((call) => call.url.includes("/events?")),
            false,
            "el intento ocupado no lee ni modifica eventos de Google",
          );
          assert.equal(
            rpcCalls.some(
              (call) => call.name === "claim_google_calendar_sync_jobs",
            ),
            false,
            "el intento ocupado no reclama trabajos salientes",
          );
          assert.equal(
            rpcCalls.some(
              (call) => call.name === "complete_google_calendar_inbound_sync",
            ),
            false,
          );
        }
        return response;
      },
    });

    assert.equal(accepted, true);
    assert.equal(elapsed, 1_000);
    assert.equal(leaseAttempts, 2);
    assert.deepEqual(outcomes, ["skipped", "completed"]);
    assert.equal(
      google.calls.filter(
        (call) => call.method === "GET" && call.url.includes("/events?"),
      ).length,
      1,
    );
    assert.equal(
      rpcCalls.filter(
        (call) => call.name === "complete_google_calendar_inbound_sync",
      ).length,
      1,
      "sólo el segundo intento confirma la observación completa",
    );
  },
);

Deno.test(
  "sin aprobación ADMIN la primera importación no lee ni escribe nada",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        begin_google_calendar_inbound_sync: () => ({
          data: [
            {
              lease_token: "lease-1",
              sync_token: null,
              first_import_approved: false,
              google_calendar_id: "cal-1",
              google_calendar_timezone: "America/Argentina/Buenos_Aires",
            },
          ],
          error: null,
        }),
        release_google_calendar_inbound_lease: () => ({
          data: true,
          error: null,
        }),
        record_google_calendar_sync_attempt: () => ({
          data: true,
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle(() => null);

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(body.outcome, "skipped");
    assert.equal(
      (body.inbound as { skippedReason: string }).skippedReason,
      "FIRST_IMPORT_APPROVAL_REQUIRED",
    );
    assert.equal(
      calls.some((call) => call.url.includes("/events?")),
      false,
    );
    assert.ok(
      rpcCalls.some(
        (call) => call.name === "release_google_calendar_inbound_lease",
      ),
    );
    assert.equal(
      rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
      false,
      "sin aprobar el primer pull no se reclama la cola saliente",
    );
  },
);

Deno.test(
  "initial_import hace sólo pull aunque existan cola saliente y cleanup pendientes",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        begin_google_calendar_inbound_sync: () => ({
          data: [
            {
              lease_token: "lease-initial-import",
              sync_token: null,
              first_import_approved: true,
              google_calendar_id: "cal-1",
              google_calendar_timezone: "America/Argentina/Buenos_Aires",
            },
          ],
          error: null,
        }),
        apply_google_calendar_external_event: () => ({
          data: "created",
          error: null,
        }),
        reconcile_google_calendar_external_events: () => ({
          data: 0,
          error: null,
        }),
        // Si el modo reclamara trabajo por error, estas filas provocarían
        // escrituras observables contra el Google simulado.
        reconcile_google_calendar_sync: () => ({
          data: [{ queued: 1, already_queued: 0 }],
          error: null,
        }),
        claim_google_calendar_sync_jobs: () => ({
          data: [
            {
              job_id: "55555555-5555-4555-8555-555555555555",
              appointment_id: APPOINTMENT_ID,
              operation: "upsert",
              desired_version: 1,
              attempts: 1,
              starts_at: APP_START,
              ends_at: APP_END,
              patient_name: "Paciente Sintético",
              timezone: "America/Argentina/Buenos_Aires",
              connection_generation: 1,
              google_etag: null,
            },
          ],
          error: null,
        }),
        claim_google_calendar_external_cleanup: () => ({
          data: [{ google_event_id: "evento-pendiente-de-cleanup" }],
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) => {
      if (call.method === "GET" && call.url.includes("/events?")) {
        return eventsListResponse([
          {
            id: "evento-manual-initial-import",
            summary: "Bloqueo previo",
            start: { dateTime: "2099-01-01T10:00:00.000Z" },
            end: { dateTime: "2099-01-01T11:00:00.000Z" },
          },
        ]);
      }
      if (call.method === "POST" && call.url.includes("/events?")) {
        return jsonResponseOf({ id: MANAGED_EVENT_ID }, 200, '"etag-nuevo"');
      }
      if (call.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return null;
    });

    const response = await handleCalendarSyncRequest(
      syncRequest("initial_import"),
      {
        createClient: () => client,
        authorize: adminAuthorization(),
        environment: (name) => ENVIRONMENT[name],
        fetcher,
      },
    );
    const body = (await response.json()) as {
      mode: string;
      claimed: number;
      cleanup: { done: number; failed: number };
      summary: { blocksImported: number };
      reconciliation: { queued: number; alreadyQueued: number };
    };

    assert.equal(response.status, 200);
    assert.equal(body.mode, "initial_import");
    assert.equal(body.claimed, 0);
    assert.deepEqual(body.cleanup, { done: 0, failed: 0 });
    assert.equal(body.summary.blocksImported, 1);
    assert.deepEqual(body.reconciliation, { queued: 0, alreadyQueued: 0 });
    for (const forbiddenRpc of [
      "reconcile_google_calendar_sync",
      "claim_google_calendar_sync_jobs",
      "claim_google_calendar_external_cleanup",
      "complete_google_calendar_external_cleanup",
    ]) {
      assert.equal(
        rpcCalls.some((call) => call.name === forbiddenRpc),
        false,
        `${forbiddenRpc} no pertenece a una importación inbound-only`,
      );
    }
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
      "initial_import nunca escribe ni borra eventos en Google",
    );
    assert.ok(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_inbound_sync",
      ),
      "el pull inbound sí debe completar y guardar el syncToken",
    );
  },
);

Deno.test(
  "el preview pagina con una ventana fija sin tocar la agenda",
  async () => {
    const { client, rpcCalls } = fakeSupabase(baseHandlers());
    let page = 0;
    const { fetcher, calls } = fakeGoogle((call) => {
      if (call.method !== "GET" || !call.url.includes("/events?")) return null;
      page += 1;
      return page === 1
        ? jsonResponseOf({
            items: [
              {
                id: "evento-manual",
                summary: "Evento sintético",
                start: { dateTime: "2026-09-08T13:00:00.000Z" },
                end: { dateTime: "2026-09-08T14:00:00.000Z" },
              },
            ],
            nextPageToken: "preview-page-2",
          })
        : eventsListResponse([]);
    });

    const response = await handleCalendarSyncRequest(syncRequest("preview"), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
      now: () => TEST_NOW,
    });
    const body = (await response.json()) as {
      mutated: boolean;
      coverage: {
        startDate: string;
        endDateExclusive: string;
        days: number;
        timeZone: string;
      };
      preview: { wouldBecomeBlocks: number; legacyManagedEvents: number };
    };

    assert.equal(body.mutated, false);
    assert.deepEqual(
      rpcCalls.map((call) => call.name),
      ["get_google_calendar_windowed_connection_secret"],
      "el preview sólo lee la conexión",
    );
    assert.equal(
      calls.some(
        (call) => call.method !== "GET" && call.url.includes("/events"),
      ),
      false,
    );
    assert.equal(body.preview.wouldBecomeBlocks, 1);
    assert.equal(body.preview.legacyManagedEvents, 0);
    assert.deepEqual(body.coverage, {
      startDate: "2026-09-05",
      endDateExclusive: "2026-09-26",
      days: 21,
      timeZone: "America/Argentina/Buenos_Aires",
    });
    const eventReads = calls
      .filter((call) => call.method === "GET" && call.url.includes("/events?"))
      .map((call) => new URL(call.url));
    assert.equal(eventReads.length, 2);
    assert.equal(eventReads[0].searchParams.get("timeMin"), COVERAGE_START);
    assert.equal(eventReads[0].searchParams.get("timeMax"), COVERAGE_END);
    assert.equal(eventReads[1].searchParams.get("timeMin"), COVERAGE_START);
    assert.equal(eventReads[1].searchParams.get("timeMax"), COVERAGE_END);
    assert.equal(eventReads[1].searchParams.get("pageToken"), "preview-page-2");
    for (const url of eventReads) {
      assert.equal(url.searchParams.get("maxResults"), "2500");
      assert.equal(url.searchParams.get("singleEvents"), "true");
      assert.equal(url.searchParams.get("showDeleted"), "true");
      assert.equal(
        url.searchParams.get("timeZone"),
        "America/Argentina/Buenos_Aires",
      );
      assert.equal(url.searchParams.get("syncToken"), null);
    }
  },
);

Deno.test(
  "un preview truncado falla cerrado y nunca se presenta como completo",
  async () => {
    const { client, rpcCalls } = fakeSupabase(baseHandlers());
    let page = 0;
    const { fetcher, calls } = fakeGoogle((call) => {
      if (call.method !== "GET" || !call.url.includes("/events?")) return null;
      page += 1;
      return jsonResponseOf({
        items: [
          {
            id: `evento-preview-pagina-${page}`,
            status: "confirmed",
            transparency: "opaque",
            start: { dateTime: "2026-09-10T13:00:00.000Z" },
            end: { dateTime: "2026-09-10T14:00:00.000Z" },
          },
        ],
        nextPageToken: `preview-pagina-${page + 1}`,
      });
    });

    const response = await handleCalendarSyncRequest(syncRequest("preview"), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
      now: () => TEST_NOW,
    });
    const body = (await response.json()) as {
      processed: boolean;
      mode: string;
      outcome: string;
      mutated: boolean;
      pagesFetched: number;
      truncated: boolean;
    };

    assert.equal(response.status, 503);
    assert.equal(body.processed, true);
    assert.equal(body.mode, "preview");
    assert.equal(body.outcome, "partial");
    assert.equal(body.mutated, false);
    assert.equal(body.pagesFetched, 12);
    assert.equal(body.truncated, true);
    assert.equal(
      calls.filter(
        (call) => call.method === "GET" && call.url.includes("/events?"),
      ).length,
      12,
    );
    assert.deepEqual(
      rpcCalls.map((call) => call.name),
      ["get_google_calendar_windowed_connection_secret"],
      "un preview parcial no adquiere lease ni guarda estado",
    );
  },
);

Deno.test(
  "preview e initial_import coinciden para recurrencias, excepciones, todo el día y libre sin escribir Google",
  async () => {
    const recurringOccurrence = {
      id: "ocurrencia-semanal-1",
      status: "confirmed",
      transparency: "opaque",
      recurringEventId: "serie-semanal",
      originalStartTime: {
        dateTime: "2026-09-07T13:00:00.000Z",
        timeZone: "America/Argentina/Buenos_Aires",
      },
      start: { dateTime: "2026-09-07T13:00:00.000Z" },
      end: { dateTime: "2026-09-07T14:00:00.000Z" },
    };
    const movedException = {
      id: "ocurrencia-semanal-movida",
      status: "confirmed",
      transparency: "opaque",
      recurringEventId: "serie-semanal",
      originalStartTime: {
        dateTime: "2026-09-14T13:00:00.000Z",
        timeZone: "America/Argentina/Buenos_Aires",
      },
      start: { dateTime: "2026-09-15T15:00:00.000Z" },
      end: { dateTime: "2026-09-15T16:00:00.000Z" },
    };
    const cancelledOccurrence = {
      id: "ocurrencia-semanal-cancelada",
      status: "cancelled",
      recurringEventId: "serie-semanal",
      originalStartTime: {
        dateTime: "2026-09-21T13:00:00.000Z",
        timeZone: "America/Argentina/Buenos_Aires",
      },
    };
    const allDayBusy = {
      id: "evento-todo-el-dia-ocupado",
      status: "confirmed",
      transparency: "opaque",
      start: { date: "2026-09-09" },
      end: { date: "2026-09-10" },
    };
    const transparentFree = {
      id: "evento-libre",
      status: "confirmed",
      transparency: "transparent",
      start: { dateTime: "2026-09-12T13:00:00.000Z" },
      end: { dateTime: "2026-09-12T14:00:00.000Z" },
    };
    const calendarPage = (call: HttpCall): Response | null => {
      if (call.method !== "GET" || !call.url.includes("/events?")) return null;
      const url = new URL(call.url);
      return url.searchParams.get("pageToken") === "mixed-page-2"
        ? jsonResponseOf({
            items: [movedException, cancelledOccurrence],
            nextSyncToken: "token-mixed",
          })
        : jsonResponseOf({
            items: [recurringOccurrence, allDayBusy, transparentFree],
            nextPageToken: "mixed-page-2",
          });
    };

    const previewSupabase = fakeSupabase(baseHandlers());
    const previewGoogle = fakeGoogle(calendarPage);
    const previewResponse = await handleCalendarSyncRequest(
      syncRequest("preview"),
      {
        createClient: () => previewSupabase.client,
        authorize: adminAuthorization(),
        environment: (name) => ENVIRONMENT[name],
        fetcher: previewGoogle.fetcher,
        now: () => TEST_NOW,
      },
    );
    const previewBody = (await previewResponse.json()) as {
      mutated: boolean;
      pagesFetched: number;
      truncated: boolean;
      coverage: {
        startDate: string;
        endDateExclusive: string;
        days: number;
        timeZone: string;
      };
      preview: {
        managedEvents: number;
        legacyManagedEvents: number;
        externalEvents: number;
        recurringSeries: number;
        recurringOccurrences: number;
        cancelledRecurringOccurrences: number;
        allDayEvents: number;
        freeEventsIgnored: number;
        wouldBecomeBlocks: number;
        pastEventsIgnored: number;
        unsupportedEvents: number;
        cancelledEvents: number;
        ignoredEvents: number;
      };
    };

    assert.equal(previewResponse.status, 200);
    assert.equal(previewBody.mutated, false);
    assert.equal(previewBody.pagesFetched, 2);
    assert.equal(previewBody.truncated, false);
    assert.deepEqual(previewBody.coverage, {
      startDate: "2026-09-05",
      endDateExclusive: "2026-09-26",
      days: 21,
      timeZone: "America/Argentina/Buenos_Aires",
    });
    assert.deepEqual(previewBody.preview, {
      managedEvents: 0,
      legacyManagedEvents: 0,
      externalEvents: 4,
      recurringSeries: 1,
      recurringOccurrences: 2,
      cancelledRecurringOccurrences: 1,
      allDayEvents: 1,
      freeEventsIgnored: 1,
      wouldBecomeBlocks: 3,
      pastEventsIgnored: 0,
      unsupportedEvents: 0,
      cancelledEvents: 2,
      ignoredEvents: 0,
    });
    assert.deepEqual(
      previewSupabase.rpcCalls.map((call) => call.name),
      ["get_google_calendar_windowed_connection_secret"],
      "el preview no adquiere lease ni muta la base",
    );

    const appliedEvents: RpcCall[] = [];
    const initialSupabase = fakeSupabase(
      baseHandlers({
        begin_google_calendar_inbound_sync: () => ({
          data: [
            {
              lease_token: "lease-mixed",
              sync_token: null,
              sync_state: "full",
              first_import_approved: true,
              google_calendar_id: "cal-1",
              google_calendar_timezone: "America/Argentina/Buenos_Aires",
            },
          ],
          error: null,
        }),
        apply_google_calendar_external_event: (args) => {
          appliedEvents.push({
            name: "apply_google_calendar_external_event",
            args,
          });
          return {
            data: args.p_removed === true ? "already_removed" : "created",
            error: null,
          };
        },
        reconcile_google_calendar_external_events: () => ({
          data: 0,
          error: null,
        }),
      }),
    );
    const initialGoogle = fakeGoogle(calendarPage);
    const initialResponse = await handleCalendarSyncRequest(
      syncRequest("initial_import"),
      {
        createClient: () => initialSupabase.client,
        authorize: adminAuthorization(),
        environment: (name) => ENVIRONMENT[name],
        fetcher: initialGoogle.fetcher,
        now: () => TEST_NOW,
      },
    );
    const initialBody = (await initialResponse.json()) as {
      mode: string;
      claimed: number;
      cleanup: { done: number; failed: number };
      coverage: {
        startDate: string;
        endDateExclusive: string;
        days: number;
        timeZone: string;
      };
      summary: {
        blocksImported: number;
        skipped: number;
        pagesFetched: number;
        fullResync: boolean;
      };
    };

    assert.equal(initialResponse.status, 200);
    assert.equal(initialBody.mode, "initial_import");
    assert.equal(initialBody.claimed, 0);
    assert.deepEqual(initialBody.cleanup, { done: 0, failed: 0 });
    assert.deepEqual(initialBody.coverage, previewBody.coverage);
    assert.equal(initialBody.summary.blocksImported, 3);
    assert.equal(
      initialBody.summary.blocksImported,
      previewBody.preview.wouldBecomeBlocks,
      "preview e importación coinciden en bloqueos ocupados",
    );
    assert.equal(initialBody.summary.skipped, 2);
    assert.equal(initialBody.summary.pagesFetched, 2);
    assert.equal(initialBody.summary.fullResync, true);

    assert.equal(appliedEvents.length, 5);
    const appliedById = new Map(
      appliedEvents.map((call) => [call.args.p_google_event_id, call.args]),
    );
    assert.equal(appliedById.get("ocurrencia-semanal-1")?.p_recurring, true);
    assert.equal(
      appliedById.get("ocurrencia-semanal-movida")?.p_starts_at,
      "2026-09-15T15:00:00.000Z",
      "la excepción conserva su horario movido y su id de ocurrencia",
    );
    assert.equal(
      appliedById.get("ocurrencia-semanal-cancelada")?.p_removed,
      true,
    );
    assert.equal(
      appliedById.get("evento-todo-el-dia-ocupado")?.p_starts_at,
      "2026-09-09T03:00:00.000Z",
    );
    assert.equal(
      appliedById.get("evento-todo-el-dia-ocupado")?.p_ends_at,
      "2026-09-10T03:00:00.000Z",
      "el fin de fecha de Google permanece exclusivo",
    );
    assert.equal(
      appliedById.get("evento-todo-el-dia-ocupado")?.p_all_day,
      true,
    );
    assert.equal(appliedById.get("evento-libre")?.p_removed, true);

    const begin = initialSupabase.rpcCalls.find(
      (call) => call.name === "begin_google_calendar_inbound_sync",
    );
    assert.deepEqual(begin?.args, {
      p_expected_generation: 1,
      p_lease_seconds: 240,
      p_sync_contract_version: 2,
      p_coverage_starts_at: COVERAGE_START,
      p_coverage_ends_at: COVERAGE_END,
    });
    const complete = initialSupabase.rpcCalls.find(
      (call) => call.name === "complete_google_calendar_inbound_sync",
    );
    assert.equal(complete?.args.p_sync_contract_version, 2);
    assert.equal(complete?.args.p_coverage_starts_at, COVERAGE_START);
    assert.equal(complete?.args.p_coverage_ends_at, COVERAGE_END);

    for (const { calls } of [previewGoogle, initialGoogle]) {
      const calendarCalls = calls.filter((call) =>
        call.url.includes("www.googleapis.com/calendar/v3"),
      );
      assert.equal(calendarCalls.length, 2);
      assert.equal(
        calendarCalls.every((call) => call.method === "GET"),
        true,
        "preview e initial_import son sólo lectura en Google",
      );
      for (const call of calendarCalls) {
        const url = new URL(call.url);
        assert.equal(url.searchParams.get("singleEvents"), "true");
        assert.equal(url.searchParams.get("showDeleted"), "true");
        assert.equal(
          url.searchParams.get("timeZone"),
          "America/Argentina/Buenos_Aires",
        );
        assert.equal(url.searchParams.get("timeMin"), COVERAGE_START);
        assert.equal(url.searchParams.get("timeMax"), COVERAGE_END);
        assert.equal(url.searchParams.get("syncToken"), null);
      }
    }
    for (const forbiddenRpc of [
      "reconcile_google_calendar_sync",
      "claim_google_calendar_sync_jobs",
      "claim_google_calendar_external_cleanup",
      "complete_google_calendar_external_cleanup",
    ]) {
      assert.equal(
        initialSupabase.rpcCalls.some((call) => call.name === forbiddenRpc),
        false,
        `${forbiddenRpc} no se procesa durante initial_import`,
      );
    }
  },
);

Deno.test(
  "el preview reclasifica managed huérfanos sin exponer eventos ni mutar estado",
  async () => {
    const legacyAppointmentId = "9d5c878a-a4c9-4ce9-89dc-b6b68b50caf2";
    const legacyEventId = "evento-managed-legado-preview";
    const { client, rpcCalls, tableReads } = fakeSupabase(baseHandlers(), {
      existingAppointmentIds: [APPOINTMENT_ID],
    });
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            {
              id: MANAGED_EVENT_ID,
              summary: "Turno administrado",
              extendedProperties: {
                private: {
                  managed_by: "gisela_lentz_agenda",
                  appointment_id: APPOINTMENT_ID,
                  automation_epoch: AUTOMATION_EPOCH,
                  projection_stage: "confirmed",
                },
              },
              start: { dateTime: "2099-01-01T10:00:00.000Z" },
              end: { dateTime: "2099-01-01T11:00:00.000Z" },
            },
            {
              id: legacyEventId,
              summary: "Managed legado huérfano",
              extendedProperties: {
                private: {
                  managed_by: "gisela_lentz_agenda",
                  appointment_id: legacyAppointmentId,
                },
              },
              start: { dateTime: "2099-01-02T10:00:00.000Z" },
              end: { dateTime: "2099-01-02T11:00:00.000Z" },
            },
            {
              id: "evento-manual-preview",
              summary: "Manual externo",
              start: { dateTime: "2099-01-03T10:00:00.000Z" },
              end: { dateTime: "2099-01-03T11:00:00.000Z" },
            },
          ])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest("preview"), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as {
      mutated: boolean;
      preview: {
        managedEvents: number;
        legacyManagedEvents: number;
        externalEvents: number;
        wouldBecomeBlocks: number;
      };
    };

    assert.equal(response.status, 200);
    assert.equal(body.mutated, false);
    assert.deepEqual(body.preview, {
      managedEvents: 1,
      legacyManagedEvents: 1,
      externalEvents: 2,
      recurringSeries: 0,
      recurringOccurrences: 0,
      cancelledRecurringOccurrences: 0,
      allDayEvents: 0,
      freeEventsIgnored: 0,
      wouldBecomeBlocks: 2,
      pastEventsIgnored: 0,
      unsupportedEvents: 0,
      cancelledEvents: 0,
      ignoredEvents: 0,
    });
    assert.deepEqual(
      rpcCalls.map((call) => call.name),
      [
        "get_google_calendar_windowed_connection_secret",
        "google_calendar_managed_event_is_current",
      ],
    );
    assert.equal(tableReads.length, 1);
    assert.equal(tableReads[0].table, "appointments");
    assert.equal(tableReads[0].columns, "id");
    assert.equal(tableReads[0].filterColumn, "id");
    assert.deepEqual(new Set(tableReads[0].values), new Set([APPOINTMENT_ID]));
    const serialized = JSON.stringify(body);
    for (const sensitiveDetail of [
      MANAGED_EVENT_ID,
      legacyEventId,
      APPOINTMENT_ID,
      legacyAppointmentId,
      "Turno administrado",
      "Managed legado huérfano",
      "Manual externo",
    ]) {
      assert.equal(serialized.includes(sensitiveDetail), false);
    }
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
    );
  },
);

Deno.test(
  "preview trata un marker de otro epoch como bloqueo externo aunque exista el turno",
  async () => {
    const otherEpoch = "88888888-8888-4888-8888-888888888888";
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        google_calendar_managed_event_is_current: () => ({
          data: false,
          error: null,
        }),
      }),
      { existingAppointmentIds: [APPOINTMENT_ID] },
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            {
              id: MANAGED_EVENT_ID,
              status: "confirmed",
              summary: "Ejemplo sintético",
              extendedProperties: {
                private: {
                  managed_by: "gisela_lentz_agenda",
                  appointment_id: APPOINTMENT_ID,
                  automation_epoch: otherEpoch,
                  projection_stage: "confirmed",
                },
              },
              start: { dateTime: "2099-01-01T10:00:00.000Z" },
              end: { dateTime: "2099-01-01T11:00:00.000Z" },
            },
          ])
        : null,
    );
    const response = await handleCalendarSyncRequest(syncRequest("preview"), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as {
      preview: {
        managedEvents: number;
        legacyManagedEvents: number;
        externalEvents: number;
        wouldBecomeBlocks: number;
      };
    };

    assert.equal(response.status, 200);
    assert.equal(body.preview.managedEvents, 0);
    assert.equal(body.preview.legacyManagedEvents, 1);
    assert.equal(body.preview.externalEvents, 1);
    assert.equal(body.preview.wouldBecomeBlocks, 1);
    const association = rpcCalls.find(
      (call) => call.name === "google_calendar_managed_event_is_current",
    );
    assert.equal(association?.args.p_automation_epoch, otherEpoch);
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
    );
  },
);

Deno.test(
  "el preview falla cerrado si no puede verificar appointments managed",
  async () => {
    const { client, rpcCalls } = fakeSupabase(baseHandlers(), {
      appointmentReadError: { code: "42501" },
    });
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            {
              id: MANAGED_EVENT_ID,
              extendedProperties: {
                private: {
                  managed_by: "gisela_lentz_agenda",
                  appointment_id: APPOINTMENT_ID,
                  automation_epoch: AUTOMATION_EPOCH,
                  projection_stage: "confirmed",
                },
              },
              start: { dateTime: "2099-01-01T10:00:00.000Z" },
              end: { dateTime: "2099-01-01T11:00:00.000Z" },
            },
          ])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest("preview"), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as { error: string; outcome: string };

    assert.equal(response.status, 503);
    assert.equal(body.error, "CALENDAR_PREVIEW_APPOINTMENTS_FAILED");
    assert.equal(body.outcome, "error");
    assert.deepEqual(
      rpcCalls.map((call) => call.name),
      ["get_google_calendar_windowed_connection_secret"],
    );
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
    );
  },
);

Deno.test(
  "un usuario sin rol ADMIN no puede disparar la sincronización",
  async () => {
    const { client, rpcCalls } = fakeSupabase(baseHandlers());
    const { fetcher } = fakeGoogle(() => null);

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: authorizationFor(
        "OPERADOR",
        "44444444-4444-4444-8444-444444444444",
      ),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });

    assert.equal(response.status, 401);
    assert.deepEqual(rpcCalls, []);
  },
);

Deno.test(
  "el secreto automático incorrecto no cae al flujo ADMIN",
  async () => {
    for (const provided of [
      "incorrecto",
      ENVIRONMENT.GOOGLE_CALENDAR_CRON_SECRET.slice(0, -1),
      "",
    ]) {
      const { client, rpcCalls } = fakeSupabase(baseHandlers());
      const { fetcher, calls } = fakeGoogle(() => null);
      const request = new Request(
        "http://127.0.0.1/functions/v1/process-calendar-sync",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-google-calendar-cron-secret": provided,
          },
          body: JSON.stringify({ mode: "preview" }),
        },
      );
      const response = await handleCalendarSyncRequest(request, {
        createClient: () => client,
        authorize: adminAuthorization(),
        environment: (name) => ENVIRONMENT[name],
        fetcher,
      });

      assert.equal(response.status, 401);
      assert.deepEqual(rpcCalls, []);
      assert.deepEqual(calls, []);
    }
  },
);

Deno.test(
  "el gate automático cerrado responde antes de purge, OAuth o Google",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        get_google_calendar_automation_gate: () => ({
          data: [{ automation_enabled: false }],
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle(() => null);
    const response = await handleCalendarSyncRequest(
      automaticSyncRequest({ mode: "preview" }),
      {
        createClient: () => client,
        environment: (name) =>
          name === "GOOGLE_CALENDAR_CRON_SECRET"
            ? ENVIRONMENT.GOOGLE_CALENDAR_CRON_SECRET
            : undefined,
        fetcher,
      },
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.mode, "automatic");
    assert.equal(body.reason, "AUTOMATION_DISABLED");
    assert.deepEqual(
      rpcCalls.map((call) => call.name),
      ["get_google_calendar_automation_gate"],
    );
    assert.deepEqual(calls, []);
  },
);

Deno.test(
  "un cambio de calendario tras leer el gate corta antes de OAuth o Google",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        get_google_calendar_automation_gate: () => ({
          data: [
            {
              automation_enabled: true,
              automation_epoch: AUTOMATION_EPOCH,
              google_calendar_id: "otro-calendario",
              connection_generation: 1,
            },
          ],
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle(() => null);
    const response = await handleCalendarSyncRequest(automaticSyncRequest(), {
      createClient: () => client,
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.reason, "AUTOMATION_SCOPE_CHANGED");
    assert.deepEqual(
      rpcCalls.map((call) => call.name),
      [
        "get_google_calendar_automation_gate",
        "expire_google_calendar_automation_booking_holds",
        "purge_expired_google_calendar_connection_candidate",
        "get_google_calendar_windowed_connection_secret",
      ],
    );
    assert.deepEqual(calls, []);
  },
);

Deno.test(
  "el automático ignora el mode, vence señas antes de Google y reconcilia tras inbound seguro",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        expire_google_calendar_automation_booking_holds: () => ({
          data: [
            { appointment_id: APPOINTMENT_ID },
            { appointment_id: "99999999-9999-4999-8999-999999999999" },
          ],
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([])
        : null,
    );
    const response = await handleCalendarSyncRequest(
      automaticSyncRequest({ mode: "preview" }),
      {
        createClient: () => client,
        environment: (name) => ENVIRONMENT[name],
        fetcher,
        now: () => TEST_NOW,
      },
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.mode, "automatic");
    assert.equal(body.expiredHolds, 2);
    const expiration = rpcCalls.find(
      (call) => call.name === "expire_google_calendar_automation_booking_holds",
    );
    assert.deepEqual(expiration?.args, {
      p_automation_epoch: AUTOMATION_EPOCH,
      p_expected_generation: 1,
      p_expected_google_calendar_id: "cal-1",
      p_now: new Date(TEST_NOW).toISOString(),
    });
    assert.ok(calls.some((call) => call.url.includes("/events?")));
    const names = rpcCalls.map((call) => call.name);
    assert.equal(names[0], "get_google_calendar_automation_gate");
    assert.ok(
      indexOfCall(rpcCalls, "get_google_calendar_automation_gate") <
        indexOfCall(
          rpcCalls,
          "expire_google_calendar_automation_booking_holds",
        ),
    );
    assert.ok(
      indexOfCall(rpcCalls, "expire_google_calendar_automation_booking_holds") <
        indexOfCall(
          rpcCalls,
          "purge_expired_google_calendar_connection_candidate",
        ),
    );
    assert.ok(
      indexOfCall(rpcCalls, "assert_google_calendar_inbound_lease") <
        indexOfCall(rpcCalls, "reconcile_google_calendar_sync"),
    );
    assert.ok(
      indexOfCall(rpcCalls, "reconcile_google_calendar_sync") <
        indexOfCall(rpcCalls, "claim_google_calendar_sync_jobs"),
    );
    assert.equal(
      names.includes("claim_google_calendar_external_cleanup"),
      false,
    );
    assert.equal(names.includes("expire_booking_holds"), false);
  },
);

Deno.test(
  "un vencimiento de señas fallido no aborta la corrida ni traba el pull inbound",
  async () => {
    // El guard SQL del vencimiento exige inbound sano, así que una corrida
    // fallida lo rompe. Si eso abortara, el pull que limpia `last_sync_error`
    // nunca ocurriría y la automatización quedaría trabada para siempre.
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        expire_google_calendar_automation_booking_holds: () => ({
          data: null,
          error: {
            message: "GOOGLE_CALENDAR_AUTOMATION_EXPIRATION_SCOPE_CHANGED",
          },
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([])
        : null,
    );
    const response = await handleCalendarSyncRequest(automaticSyncRequest(), {
      createClient: () => client,
      environment: (name) => ENVIRONMENT[name],
      fetcher,
      now: () => TEST_NOW,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.holdExpirationDeferred, true);
    assert.equal(body.expiredHolds, 0);
    // Lo que importa: la corrida siguió y llegó a observar Google.
    assert.ok(calls.some((call) => call.url.includes("/events?")));
    const names = rpcCalls.map((call) => call.name);
    assert.ok(
      names.includes("purge_expired_google_calendar_connection_candidate"),
    );
    assert.ok(names.includes("complete_google_calendar_inbound_sync"));
  },
);

Deno.test(
  "si Google falla el automático vence la seña pero preserva la cola sin mutación remota",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        expire_google_calendar_automation_booking_holds: () => ({
          data: [{ appointment_id: APPOINTMENT_ID }],
          error: null,
        }),
        fail_google_calendar_inbound_sync: () => ({
          data: true,
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? jsonResponseOf({ error: { message: "unavailable" } }, 503)
        : null,
    );
    const response = await handleCalendarSyncRequest(automaticSyncRequest(), {
      createClient: () => client,
      environment: (name) => ENVIRONMENT[name],
      fetcher,
      now: () => TEST_NOW,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 503);
    assert.equal(body.expiredHolds, 1);
    assert.equal(
      rpcCalls.some(
        (call) =>
          call.name === "expire_google_calendar_automation_booking_holds",
      ),
      true,
    );
    assert.equal(
      rpcCalls.some((call) => call.name === "reconcile_google_calendar_sync"),
      false,
    );
    assert.equal(
      rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
      false,
    );
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
    );
  },
);

Deno.test(
  "un job que perdió version, epoch o stage se reautoriza y no toca Google",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        claim_google_calendar_sync_jobs: () => ({
          data: [claimedUpsertJob()],
          error: null,
        }),
        authorize_google_calendar_sync_job: () => ({
          data: [{ authorized: false }],
          error: null,
        }),
        fail_google_calendar_sync_job: () => ({ data: true, error: null }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([])
        : null,
    );
    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
    );
    const authorization = rpcCalls.find(
      (call) => call.name === "authorize_google_calendar_sync_job",
    );
    assert.deepEqual(authorization?.args, {
      p_job_id: "33333333-3333-4333-8333-333333333333",
      p_claimed_version: 1,
      p_automation_epoch: AUTOMATION_EPOCH,
      p_expected_stage: "confirmed",
    });
    const failure = rpcCalls.find(
      (call) => call.name === "fail_google_calendar_sync_job",
    );
    assert.equal(
      failure?.args.p_error_code,
      "CALENDAR_JOB_REAUTHORIZATION_FAILED",
    );
    assert.equal(failure?.args.p_automation_epoch, AUTOMATION_EPOCH);
    assert.equal(failure?.args.p_projection_stage, "confirmed");
    assert.equal(body.synced, 0);
  },
);

Deno.test(
  "un conflicto abierto entre claim y delete falla al reautorizar y no borra Google",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        claim_google_calendar_sync_jobs: () => ({
          data: [
            claimedUpsertJob({
              operation: "delete",
              projection_stage: "absent",
              projected_stage: "confirmed",
              google_etag: '"etag-del-pull"',
            }),
          ],
          error: null,
        }),
        authorize_google_calendar_sync_job: () => ({
          data: [{ authorized: false }],
          error: null,
        }),
        fail_google_calendar_sync_job: () => ({ data: true, error: null }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) => {
      if (call.method === "GET" && call.url.includes("/events?")) {
        return eventsListResponse([]);
      }
      if (call.method === "GET" && call.url.includes(`/${MANAGED_EVENT_ID}`)) {
        return jsonResponseOf({
          id: MANAGED_EVENT_ID,
          etag: '"etag-del-pull"',
          extendedProperties: {
            private: {
              managed_by: "gisela_lentz_agenda",
              appointment_id: APPOINTMENT_ID,
              automation_epoch: AUTOMATION_EPOCH,
              projection_stage: "confirmed",
            },
          },
        });
      }
      return null;
    });

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.deepEqual(
      calls
        .filter((call) => call.url.includes(`/${MANAGED_EVENT_ID}`))
        .map((call) => call.method),
      ["GET"],
    );
    assert.equal(
      calls.some((call) => call.method === "DELETE"),
      false,
    );
    assert.equal(
      rpcCalls.find((call) => call.name === "fail_google_calendar_sync_job")
        ?.args.p_error_code,
      "CALENDAR_JOB_REAUTHORIZATION_FAILED",
    );
    assert.equal(body.deleted, 0);
  },
);

Deno.test(
  "un bloqueo convertido entre claim y push no exporta ni limpia el evento manual",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        claim_google_calendar_sync_jobs: () => ({
          data: [claimedUpsertJob()],
          error: null,
        }),
        // El RPC vuelve a leer converted_appointment_id inmediatamente antes
        // del I/O y rechaza el job que se volvió no exportable tras el claim.
        authorize_google_calendar_sync_job: () => ({
          data: [{ authorized: false }],
          error: null,
        }),
        fail_google_calendar_sync_job: () => ({ data: true, error: null }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "claim_google_calendar_external_cleanup",
      ),
      false,
    );
    assert.deepEqual(body.cleanup, { done: 0, failed: 0 });
    assert.equal(body.synced, 0);
  },
);

Deno.test(
  "un claim confirmed no puede retroceder a pre_reservation",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        claim_google_calendar_sync_jobs: () => ({
          data: [
            claimedUpsertJob({
              projection_stage: "pre_reservation",
              projected_stage: "confirmed",
            }),
          ],
          error: null,
        }),
        fail_google_calendar_sync_job: () => ({ data: true, error: null }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "authorize_google_calendar_sync_job",
      ),
      false,
    );
    assert.equal(
      rpcCalls.find((call) => call.name === "fail_google_calendar_sync_job")
        ?.args.p_error_code,
      "CALENDAR_JOB_ASSOCIATION_INVALID",
    );
    assert.equal(body.synced, 0);
  },
);

Deno.test(
  "el evento manual convertido permanece intacto en Google",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        claim_google_calendar_external_cleanup: () => ({
          data: [
            {
              google_event_id: "evento-manual-convertido",
              appointment_id: APPOINTMENT_ID,
            },
          ],
          error: null,
        }),
        complete_google_calendar_external_cleanup: () => ({
          data: true,
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) => {
      if (call.method === "GET" && call.url.includes("/events?")) {
        return eventsListResponse([]);
      }
      if (call.method === "DELETE") return new Response(null, { status: 204 });
      return null;
    });

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(
      calls.some((call) => call.method === "DELETE"),
      false,
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "claim_google_calendar_external_cleanup",
      ),
      false,
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_external_cleanup",
      ),
      false,
    );
    assert.deepEqual(body.cleanup, { done: 0, failed: 0 });
  },
);

Deno.test(
  "un error de lectura no anuncia sincronización completa ni pierde el token",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        fail_google_calendar_inbound_sync: () => ({ data: true, error: null }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? jsonResponseOf({ error: { message: "backend error" } }, 503)
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(body.outcome, "error");
    // El token anterior se conserva: no se guarda uno nuevo tras un fallo.
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_inbound_sync",
      ),
      false,
    );
    assert.ok(
      rpcCalls.some(
        (call) => call.name === "fail_google_calendar_inbound_sync",
      ),
    );
    assert.equal(response.status, 503);
    assert.equal(
      rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
      false,
      "un pull fallido bloquea el push de esa ejecución",
    );
    // Nada se escribió sobre eventos existentes.
    assert.equal(
      calls.some(
        (call) =>
          ["PATCH", "DELETE", "POST"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
    );
  },
);

Deno.test(
  "una paginación incompleta no persiste el syncToken ni reconcilia bajas",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        begin_google_calendar_inbound_sync: () => ({
          data: [
            {
              lease_token: "lease-1",
              sync_token: null,
              first_import_approved: true,
              google_calendar_id: "cal-1",
              google_calendar_timezone: "America/Argentina/Buenos_Aires",
            },
          ],
          error: null,
        }),
        apply_google_calendar_external_event: () => ({
          data: "created",
          error: null,
        }),
      }),
    );
    // Cada página devuelve otro nextPageToken: el recorrido nunca termina.
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? jsonResponseOf({
            items: [
              {
                id: `manual-${Math.random()}`,
                summary: "Evento sintético",
                start: { dateTime: "2099-01-01T10:00:00.000Z" },
                end: { dateTime: "2099-01-01T11:00:00.000Z" },
              },
            ],
            nextPageToken: "otra-pagina",
          })
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal((body.inbound as { truncated: boolean }).truncated, true);
    assert.equal(body.outcome, "partial");
    assert.equal(response.status, 503);
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_inbound_sync",
      ),
      false,
    );
    const failure = rpcCalls.find(
      (call) => call.name === "fail_google_calendar_inbound_sync",
    );
    assert.equal(failure?.args.p_error_code, "GOOGLE_EVENTS_LIST_TRUNCATED");
    assert.equal(
      rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
      false,
    );
    // Sin recorrido completo no se puede saber qué desapareció.
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "reconcile_google_calendar_external_events",
      ),
      false,
    );
    const eventReads = calls
      .filter((call) => call.method === "GET" && call.url.includes("/events?"))
      .map((call) => new URL(call.url));
    assert.equal(eventReads.length, 12);
    const cutoffs = new Set(
      eventReads.map((url) => url.searchParams.get("timeMin")),
    );
    assert.equal(cutoffs.size, 1, "el cutoff debe ser fijo entre páginas");
    assert.ok([...cutoffs][0], "un full sync debe acotar la historia");
    for (const url of eventReads) {
      assert.equal(url.searchParams.get("maxResults"), "2500");
      assert.equal(url.searchParams.get("syncToken"), null);
    }
  },
);

Deno.test(
  "un full import que termina en la página 12 persiste el token final",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        begin_google_calendar_inbound_sync: () => ({
          data: [
            {
              lease_token: "lease-1",
              sync_token: null,
              first_import_approved: true,
              google_calendar_id: "cal-1",
              google_calendar_timezone: "America/Argentina/Buenos_Aires",
            },
          ],
          error: null,
        }),
      }),
    );
    let page = 0;
    const { fetcher, calls } = fakeGoogle((call) => {
      if (call.method !== "GET" || !call.url.includes("/events?")) return null;
      page += 1;
      return page < 12
        ? jsonResponseOf({ items: [], nextPageToken: `page-${page + 1}` })
        : jsonResponseOf({ items: [], nextSyncToken: "token-pagina-12" });
    });

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as {
      inbound: { truncated: boolean; pagesFetched: number };
    };

    assert.equal(response.status, 200);
    assert.equal(body.inbound.truncated, false);
    assert.equal(body.inbound.pagesFetched, 12);
    const completion = rpcCalls.find(
      (call) => call.name === "complete_google_calendar_inbound_sync",
    );
    assert.equal(completion?.args.p_next_sync_token, "token-pagina-12");
    assert.ok(
      rpcCalls.some(
        (call) => call.name === "reconcile_google_calendar_external_events",
      ),
    );
    const eventReads = calls
      .filter((call) => call.method === "GET" && call.url.includes("/events?"))
      .map((call) => new URL(call.url));
    assert.equal(eventReads.length, 12);
    const cutoff = eventReads[0].searchParams.get("timeMin");
    assert.ok(cutoff);
    for (const url of eventReads) {
      assert.equal(url.searchParams.get("timeMin"), cutoff);
      assert.equal(url.searchParams.get("maxResults"), "2500");
    }
  },
);

Deno.test(
  "un evento sincronizado antes de estas migraciones no se parchea a ciegas",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        // Observación previa: el turno legado no tiene proyección registrada,
        // así que cualquier diferencia se trata como conflicto, no como push.
        observe_google_calendar_managed_event: () => ({
          data: "conflict_recorded",
          error: null,
        }),
        apply_google_calendar_external_event: () => ({
          data: "created",
          error: null,
        }),
        claim_google_calendar_sync_jobs: () => ({ data: [], error: null }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            {
              id: MANAGED_EVENT_ID,
              status: "confirmed",
              // Sin etag: el evento se exportó con el runtime anterior.
              extendedProperties: {
                private: {
                  managed_by: "gisela_lentz_agenda",
                  appointment_id: APPOINTMENT_ID,
                },
              },
              start: { dateTime: MOVED_START },
              end: { dateTime: MOVED_END },
            },
          ])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(
      rpcCalls.some(
        (call) => call.name === "observe_google_calendar_managed_event",
      ),
      false,
    );
    assert.equal(
      calls.some((call) => ["PATCH", "DELETE"].includes(call.method)),
      false,
      "un evento legado nunca se modifica sin haberlo observado antes",
    );
    assert.equal(
      (body.summary as { conflictsOpened: number }).conflictsOpened,
      0,
    );
    assert.equal(
      (body.summary as { blocksImported: number }).blocksImported,
      1,
    );
  },
);

Deno.test(
  "un evento managed sin ETag queda en revisión y nunca se parchea a ciegas",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        observe_google_calendar_managed_event: () => ({
          data: "conflict_recorded",
          error: null,
        }),
        // El claim SQL excluye cualquier appointment con conflicto pendiente.
        claim_google_calendar_sync_jobs: () => ({ data: [], error: null }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) => {
      if (call.method === "GET" && call.url.includes("/events?")) {
        return eventsListResponse([
          {
            id: MANAGED_EVENT_ID,
            status: "confirmed",
            extendedProperties: {
              private: {
                managed_by: "gisela_lentz_agenda",
                appointment_id: APPOINTMENT_ID,
                automation_epoch: AUTOMATION_EPOCH,
                projection_stage: "confirmed",
              },
            },
            start: { dateTime: APP_START },
            end: { dateTime: APP_END },
          },
        ]);
      }
      return null;
    });

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });

    assert.equal(response.status, 200);
    const observation = rpcCalls.find(
      (call) => call.name === "observe_google_calendar_managed_event",
    );
    assert.equal(observation?.args.p_google_etag, null);
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
      "la falta de ETag requiere revisión humana antes de cualquier escritura",
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_sync_job",
      ),
      false,
    );
  },
);

Deno.test(
  "una sincronización manual nunca reclama cleanup de eventos externos",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        claim_google_calendar_external_cleanup: () => ({
          data: [
            {
              google_event_id: "evento-manual-convertido",
              appointment_id: APPOINTMENT_ID,
            },
          ],
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) => {
      if (call.method === "GET" && call.url.includes("/events?")) {
        return eventsListResponse([]);
      }
      return null;
    });

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(
      rpcCalls.some(
        (call) => call.name === "claim_google_calendar_external_cleanup",
      ),
      false,
    );
    assert.equal(
      calls.some((call) => call.method === "DELETE"),
      false,
    );
    assert.deepEqual(body.cleanup, { done: 0, failed: 0 });
    assert.equal(body.outcome, "completed");
  },
);

Deno.test(
  "purga candidatos OAuth vencidos en una sincronización normal",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        get_google_calendar_windowed_connection_secret: () => ({
          data: [{ status: "disconnected", connection_generation: 2 }],
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle(() => null);

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(
      rpcCalls.map((call) => call.name),
      [
        "purge_expired_google_calendar_connection_candidate",
        "get_google_calendar_windowed_connection_secret",
      ],
    );
    assert.deepEqual(calls, []);
  },
);

Deno.test("un error al purgar el candidato OAuth no se oculta", async () => {
  const { client, rpcCalls } = fakeSupabase(
    baseHandlers({
      purge_expired_google_calendar_connection_candidate: () => ({
        data: null,
        error: { code: "XX000" },
      }),
    }),
  );
  const { fetcher, calls } = fakeGoogle(() => null);

  const response = await handleCalendarSyncRequest(syncRequest(), {
    createClient: () => client,
    authorize: adminAuthorization(),
    environment: (name) => ENVIRONMENT[name],
    fetcher,
  });
  const body = (await response.json()) as { error: string; outcome: string };

  assert.equal(response.status, 503);
  assert.equal(body.error, "CALENDAR_CANDIDATE_PURGE_FAILED");
  assert.equal(body.outcome, "error");
  assert.deepEqual(
    rpcCalls.map((call) => call.name),
    ["purge_expired_google_calendar_connection_candidate"],
  );
  assert.deepEqual(calls, []);
});

Deno.test(
  "un error aplicando un evento no avanza el token ni habilita el push",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        apply_google_calendar_external_event: () => ({
          data: null,
          error: { code: "40001" },
        }),
      }),
    );
    const { fetcher } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            {
              id: "manual-apply-failure",
              summary: "Evento sintético",
              start: { dateTime: "2099-01-01T10:00:00.000Z" },
              end: { dateTime: "2099-01-01T11:00:00.000Z" },
            },
          ])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 503);
    assert.equal(body.outcome, "error");
    const failure = rpcCalls.find(
      (call) => call.name === "fail_google_calendar_inbound_sync",
    );
    assert.equal(failure?.args.p_error_code, "CALENDAR_INBOUND_APPLY_FAILED");
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_inbound_sync",
      ),
      false,
    );
    assert.equal(
      rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
      false,
    );
  },
);

Deno.test(
  "un error reconciliando ausencias no avanza el token ni habilita el push",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        begin_google_calendar_inbound_sync: () => ({
          data: [
            {
              lease_token: "lease-1",
              sync_token: null,
              first_import_approved: true,
              google_calendar_id: "cal-1",
              google_calendar_timezone: "America/Argentina/Buenos_Aires",
            },
          ],
          error: null,
        }),
        reconcile_google_calendar_external_events: () => ({
          data: null,
          error: { code: "40001" },
        }),
      }),
    );
    const { fetcher } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });

    assert.equal(response.status, 503);
    const failure = rpcCalls.find(
      (call) => call.name === "fail_google_calendar_inbound_sync",
    );
    assert.equal(
      failure?.args.p_error_code,
      "CALENDAR_INBOUND_RECONCILE_FAILED",
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_inbound_sync",
      ),
      false,
    );
    assert.equal(
      rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
      false,
    );
  },
);

Deno.test(
  "un cierre inbound no confirmado se reporta como error y conserva retry",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        complete_google_calendar_inbound_sync: () => ({
          data: false,
          error: null,
        }),
      }),
    );
    const { fetcher } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as { error: string; outcome: string };

    assert.equal(response.status, 503);
    assert.equal(body.error, "CALENDAR_INBOUND_COMPLETE_FAILED");
    assert.equal(body.outcome, "error");
    const completion = rpcCalls.find(
      (call) => call.name === "complete_google_calendar_inbound_sync",
    );
    assert.equal(completion?.args.p_next_sync_token, "token-nuevo");
    assert.ok(
      rpcCalls.some(
        (call) => call.name === "fail_google_calendar_inbound_sync",
      ),
    );
  },
);

Deno.test("un error de bitácora no convierte un skip en éxito", async () => {
  const { client, rpcCalls } = fakeSupabase(
    baseHandlers({
      begin_google_calendar_inbound_sync: () => ({ data: [], error: null }),
      record_google_calendar_sync_attempt: () => ({
        data: null,
        error: { code: "40001" },
      }),
    }),
  );
  const { fetcher } = fakeGoogle(() => null);

  const response = await handleCalendarSyncRequest(syncRequest(), {
    createClient: () => client,
    authorize: adminAuthorization(),
    environment: (name) => ENVIRONMENT[name],
    fetcher,
  });
  const body = (await response.json()) as { error: string; outcome: string };

  assert.equal(response.status, 503);
  assert.equal(body.error, "CALENDAR_SYNC_ATTEMPT_RECORD_FAILED");
  assert.equal(body.outcome, "error");
  assert.equal(
    rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
    false,
  );
});

Deno.test(
  "events.list 404 marca reconexión y no habilita el push",
  async () => {
    const { client, rpcCalls } = fakeSupabase(baseHandlers());
    const { fetcher } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? jsonResponseOf({ error: { message: "not found" } }, 404)
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });

    assert.equal(response.status, 503);
    const reconnect = rpcCalls.find(
      (call) => call.name === "mark_google_calendar_reconnect_required",
    );
    assert.equal(
      reconnect?.args.p_error_code,
      "GOOGLE_CALENDAR_RECONNECT_REQUIRED",
    );
    assert.equal(reconnect?.args.p_expected_generation, 1);
    assert.equal(
      rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
      false,
    );
  },
);

Deno.test(
  "un 404 saliente marca reconnect antes de devolver el job processing a retry",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        claim_google_calendar_sync_jobs: () => ({
          data: [claimedUpsertJob()],
          error: null,
        }),
        mark_google_calendar_reconnect_required: () => ({
          data: true,
          error: null,
        }),
        // Debe seguir siendo aceptado aunque mark ya haya cambiado el status
        // de la conexión a reconnect_required.
        fail_google_calendar_sync_job: () => ({ data: true, error: null }),
      }),
    );
    const { fetcher } = fakeGoogle((call) => {
      if (call.method === "GET" && call.url.includes("/events?")) {
        return eventsListResponse([]);
      }
      if (call.method === "POST" && call.url.includes("/events?")) {
        return jsonResponseOf({ error: { message: "not found" } }, 404);
      }
      return null;
    });

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });

    assert.equal(response.status, 200);
    assert.ok(
      indexOfCall(rpcCalls, "mark_google_calendar_reconnect_required") <
        indexOfCall(rpcCalls, "fail_google_calendar_sync_job"),
    );
    const failure = rpcCalls.find(
      (call) => call.name === "fail_google_calendar_sync_job",
    );
    assert.equal(
      failure?.args.p_error_code,
      "GOOGLE_CALENDAR_RECONNECT_REQUIRED",
    );
    assert.equal(failure?.args.p_automation_epoch, AUTOMATION_EPOCH);
    assert.equal(failure?.args.p_projection_stage, "confirmed");
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_sync_job",
      ),
      false,
    );
  },
);

Deno.test(
  "un 410 persistente tras el full resync marca reconexión",
  async () => {
    const { client, rpcCalls } = fakeSupabase(baseHandlers());
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? jsonResponseOf({ error: { message: "gone" } }, 410)
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });

    assert.equal(response.status, 503);
    assert.equal(
      calls.filter((call) => call.method === "GET").length,
      2,
      "primero invalida el syncToken y prueba una lectura completa",
    );
    assert.ok(
      rpcCalls.some(
        (call) => call.name === "invalidate_google_calendar_sync_token",
      ),
    );
    const reconnect = rpcCalls.find(
      (call) => call.name === "mark_google_calendar_reconnect_required",
    );
    assert.equal(reconnect?.args.p_error_code, "GOOGLE_SYNC_TOKEN_EXPIRED");
    assert.equal(
      rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
      false,
    );
  },
);

Deno.test(
  "un bloqueo futuro movido al pasado se retira de forma idempotente",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        apply_google_calendar_external_event: () => ({
          data: "removed",
          error: null,
        }),
      }),
    );
    const { fetcher } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            {
              id: "manual-movido-al-pasado",
              summary: "Evento sintético pasado",
              etag: '"etag-pasado"',
              updated: "2026-09-04T10:00:00.000Z",
              start: { dateTime: "2020-01-01T10:00:00.000Z" },
              end: { dateTime: "2020-01-01T11:00:00.000Z" },
            },
          ])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });
    const body = (await response.json()) as {
      summary: { blocksRemoved: number };
    };

    assert.equal(response.status, 200);
    const application = rpcCalls.find(
      (call) => call.name === "apply_google_calendar_external_event",
    );
    assert.equal(
      application?.args.p_google_event_id,
      "manual-movido-al-pasado",
    );
    assert.equal(application?.args.p_removed, true);
    assert.equal(application?.args.p_unsupported_reason, "PAST_EVENT");
    assert.equal(application?.args.p_summary, "Evento sintético pasado");
    assert.equal(application?.args.p_starts_at, "2020-01-01T10:00:00.000Z");
    assert.equal(application?.args.p_ends_at, "2020-01-01T11:00:00.000Z");
    assert.equal(application?.args.p_google_etag, '"etag-pasado"');
    assert.equal(body.summary.blocksRemoved, 1);
  },
);

Deno.test(
  "un lease de otro calendario se rechaza antes de leer o escribir Google",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        begin_google_calendar_inbound_sync: () => ({
          data: [
            {
              lease_token: "lease-otro-scope",
              sync_token: "token-previo",
              first_import_approved: true,
              google_calendar_id: "calendario-ajeno",
              google_calendar_timezone: "America/Argentina/Buenos_Aires",
            },
          ],
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle(() => null);

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });

    assert.equal(response.status, 503);
    assert.equal(
      calls.some((call) => call.url.includes("/events?")),
      false,
    );
    const failure = rpcCalls.find(
      (call) => call.name === "fail_google_calendar_inbound_sync",
    );
    assert.equal(failure?.args.p_error_code, "CALENDAR_INBOUND_SCOPE_MISMATCH");
    assert.equal(
      rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
      false,
    );
  },
);

Deno.test(
  "revalida el lease al terminar el pull antes de reclamar la cola",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        assert_google_calendar_inbound_lease: () => ({
          data: null,
          error: { code: "42501" },
        }),
      }),
    );
    const { fetcher } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });

    assert.equal(response.status, 503);
    const failure = rpcCalls.find(
      (call) => call.name === "fail_google_calendar_inbound_sync",
    );
    assert.equal(failure?.args.p_error_code, "CALENDAR_INBOUND_LEASE_LOST");
    assert.equal(
      rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
      false,
    );
  },
);

Deno.test("events.list 403 permanente exige consentimiento nuevo", async () => {
  const { client, rpcCalls } = fakeSupabase(baseHandlers());
  const { fetcher } = fakeGoogle((call) =>
    call.method === "GET" && call.url.includes("/events?")
      ? jsonResponseOf(
          {
            error: {
              errors: [{ reason: "insufficientPermissions" }],
              status: "PERMISSION_DENIED",
            },
          },
          403,
        )
      : null,
  );

  const response = await handleCalendarSyncRequest(syncRequest(), {
    createClient: () => client,
    authorize: adminAuthorization(),
    environment: (name) => ENVIRONMENT[name],
    fetcher,
  });

  assert.equal(response.status, 503);
  const reconnect = rpcCalls.find(
    (call) => call.name === "mark_google_calendar_reconnect_required",
  );
  assert.equal(reconnect?.args.p_error_code, "GOOGLE_EVENTS_LIST_FAILED");
  assert.equal(
    rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
    false,
  );
});

Deno.test(
  "un outcome managed nulo o desconocido falla cerrado antes de complete/claim/push",
  async () => {
    for (const invalidOutcome of [null, "outcome_nuevo", true]) {
      const { client, rpcCalls } = fakeSupabase(
        baseHandlers({
          observe_google_calendar_managed_event: () => ({
            data: invalidOutcome,
            error: null,
          }),
        }),
      );
      const { fetcher, calls } = fakeGoogle((call) =>
        call.method === "GET" && call.url.includes("/events?")
          ? eventsListResponse([
              {
                id: MANAGED_EVENT_ID,
                status: "confirmed",
                extendedProperties: {
                  private: {
                    managed_by: "gisela_lentz_agenda",
                    appointment_id: APPOINTMENT_ID,
                    automation_epoch: AUTOMATION_EPOCH,
                    projection_stage: "confirmed",
                  },
                },
                start: { dateTime: APP_START },
                end: { dateTime: APP_END },
              },
            ])
          : null,
      );

      const response = await handleCalendarSyncRequest(syncRequest(), {
        createClient: () => client,
        authorize: adminAuthorization(),
        environment: (name) => ENVIRONMENT[name],
        fetcher,
      });

      assert.equal(response.status, 503);
      const failure = rpcCalls.find(
        (call) => call.name === "fail_google_calendar_inbound_sync",
      );
      assert.equal(
        failure?.args.p_error_code,
        "CALENDAR_INBOUND_OBSERVE_INVALID_OUTCOME",
      );
      assert.equal(
        rpcCalls.some(
          (call) => call.name === "complete_google_calendar_inbound_sync",
        ),
        false,
      );
      assert.equal(
        rpcCalls.some(
          (call) => call.name === "claim_google_calendar_sync_jobs",
        ),
        false,
      );
      assert.equal(
        calls.some(
          (call) =>
            ["POST", "PATCH", "DELETE"].includes(call.method) &&
            call.url.includes("/events"),
        ),
        false,
      );
    }
  },
);

Deno.test(
  "un outcome external nulo o desconocido falla cerrado antes de complete/claim/push",
  async () => {
    for (const invalidOutcome of [null, "outcome_nuevo", 1]) {
      const { client, rpcCalls } = fakeSupabase(
        baseHandlers({
          apply_google_calendar_external_event: () => ({
            data: invalidOutcome,
            error: null,
          }),
        }),
      );
      const { fetcher, calls } = fakeGoogle((call) =>
        call.method === "GET" && call.url.includes("/events?")
          ? eventsListResponse([
              {
                id: "evento-manual-sintetico",
                summary: "PRUEBA · outcome inválido",
                start: { dateTime: "2099-01-01T10:00:00.000Z" },
                end: { dateTime: "2099-01-01T11:00:00.000Z" },
              },
            ])
          : null,
      );

      const response = await handleCalendarSyncRequest(syncRequest(), {
        createClient: () => client,
        authorize: adminAuthorization(),
        environment: (name) => ENVIRONMENT[name],
        fetcher,
      });

      assert.equal(response.status, 503);
      const failure = rpcCalls.find(
        (call) => call.name === "fail_google_calendar_inbound_sync",
      );
      assert.equal(
        failure?.args.p_error_code,
        "CALENDAR_INBOUND_APPLY_INVALID_OUTCOME",
      );
      assert.equal(
        rpcCalls.some(
          (call) => call.name === "complete_google_calendar_inbound_sync",
        ),
        false,
      );
      assert.equal(
        rpcCalls.some(
          (call) => call.name === "claim_google_calendar_sync_jobs",
        ),
        false,
      );
      assert.equal(
        calls.some(
          (call) =>
            ["POST", "PATCH", "DELETE"].includes(call.method) &&
            call.url.includes("/events"),
        ),
        false,
      );
    }
  },
);

Deno.test(
  "invalidar un syncToken exige RPC sin error y boolean true exacto",
  async () => {
    for (const invalidResult of [
      { data: false, error: null },
      { data: 1, error: null },
      { data: true, error: { code: "40001" } },
    ]) {
      const { client, rpcCalls } = fakeSupabase(
        baseHandlers({
          invalidate_google_calendar_sync_token: () => invalidResult,
        }),
      );
      const { fetcher, calls } = fakeGoogle((call) =>
        call.method === "GET" && call.url.includes("/events?")
          ? jsonResponseOf({ error: { message: "gone" } }, 410)
          : null,
      );

      const response = await handleCalendarSyncRequest(syncRequest(), {
        createClient: () => client,
        authorize: adminAuthorization(),
        environment: (name) => ENVIRONMENT[name],
        fetcher,
      });

      assert.equal(response.status, 503);
      assert.equal(
        calls.filter(
          (call) => call.method === "GET" && call.url.includes("/events?"),
        ).length,
        1,
        "no debe intentar el full resync si no confirmó la invalidación",
      );
      const failure = rpcCalls.find(
        (call) => call.name === "fail_google_calendar_inbound_sync",
      );
      assert.equal(
        failure?.args.p_error_code,
        "CALENDAR_SYNC_TOKEN_INVALIDATION_FAILED",
      );
      assert.equal(
        rpcCalls.some(
          (call) => call.name === "complete_google_calendar_inbound_sync",
        ),
        false,
      );
      assert.equal(
        rpcCalls.some(
          (call) => call.name === "claim_google_calendar_sync_jobs",
        ),
        false,
      );
    }
  },
);

Deno.test(
  "un full resync audita por GET un turno administrado no visto en la ventana futura",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        begin_google_calendar_inbound_sync: () => ({
          data: [
            {
              lease_token: "lease-1",
              sync_token: null,
              first_import_approved: true,
              google_calendar_id: "cal-1",
              google_calendar_timezone: "America/Argentina/Buenos_Aires",
            },
          ],
          error: null,
        }),
        list_google_calendar_full_resync_managed_candidates: () => ({
          data: [
            {
              appointment_id: APPOINTMENT_ID,
              google_event_id: MANAGED_EVENT_ID,
              remote_known: true,
            },
          ],
          error: null,
        }),
        observe_google_calendar_managed_event: () => ({
          data: "conflict_recorded",
          error: null,
        }),
      }),
    );
    const pastStart = "2020-01-01T10:00:00.000Z";
    const pastEnd = "2020-01-01T11:00:00.000Z";
    const { fetcher, calls } = fakeGoogle((call) => {
      if (call.method === "GET" && call.url.includes("/events?")) {
        return eventsListResponse([]);
      }
      if (
        call.method === "GET" &&
        new URL(call.url).pathname.endsWith(`/events/${MANAGED_EVENT_ID}`)
      ) {
        return jsonResponseOf({
          id: MANAGED_EVENT_ID,
          status: "confirmed",
          etag: '"etag-past"',
          extendedProperties: {
            private: {
              managed_by: "gisela_lentz_agenda",
              appointment_id: APPOINTMENT_ID,
              automation_epoch: AUTOMATION_EPOCH,
              projection_stage: "confirmed",
            },
          },
          start: { dateTime: pastStart },
          end: { dateTime: pastEnd },
        });
      }
      return null;
    });

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });

    assert.equal(response.status, 200);
    const candidateCall = rpcCalls.find(
      (call) =>
        call.name === "list_google_calendar_full_resync_managed_candidates",
    );
    assert.equal(candidateCall?.args.p_after_appointment_id, null);
    assert.equal(candidateCall?.args.p_limit, 100);
    const observe = rpcCalls.find(
      (call) => call.name === "observe_google_calendar_managed_event",
    );
    assert.equal(observe?.args.p_appointment_id, APPOINTMENT_ID);
    assert.equal(observe?.args.p_starts_at, pastStart);
    assert.equal(observe?.args.p_ends_at, pastEnd);
    assert.ok(
      indexOfCall(
        rpcCalls,
        "list_google_calendar_full_resync_managed_candidates",
      ) < indexOfCall(rpcCalls, "observe_google_calendar_managed_event"),
    );
    assert.ok(
      indexOfCall(rpcCalls, "observe_google_calendar_managed_event") <
        indexOfCall(rpcCalls, "reconcile_google_calendar_external_events"),
    );
    assert.equal(
      calls.filter(
        (call) =>
          call.method === "GET" &&
          !call.url.includes("oauth2.googleapis.com") &&
          call.url.includes(`/events/${MANAGED_EVENT_ID}`),
      ).length,
      1,
    );
    assert.ok(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_inbound_sync",
      ),
    );
  },
);

Deno.test(
  "un managed ya visto en events.list no se vuelve a pedir ni observar",
  async () => {
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        begin_google_calendar_inbound_sync: () => ({
          data: [
            {
              lease_token: "lease-1",
              sync_token: null,
              first_import_approved: true,
              google_calendar_id: "cal-1",
              google_calendar_timezone: "America/Argentina/Buenos_Aires",
            },
          ],
          error: null,
        }),
        list_google_calendar_full_resync_managed_candidates: () => ({
          data: [
            {
              appointment_id: APPOINTMENT_ID,
              google_event_id: MANAGED_EVENT_ID,
              remote_known: true,
            },
          ],
          error: null,
        }),
        observe_google_calendar_managed_event: () => ({
          data: "in_sync",
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            {
              id: MANAGED_EVENT_ID,
              status: "confirmed",
              extendedProperties: {
                private: {
                  managed_by: "gisela_lentz_agenda",
                  appointment_id: APPOINTMENT_ID,
                  automation_epoch: AUTOMATION_EPOCH,
                  projection_stage: "confirmed",
                },
              },
              start: { dateTime: APP_START },
              end: { dateTime: APP_END },
            },
          ])
        : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });

    assert.equal(response.status, 200);
    assert.equal(
      rpcCalls.filter(
        (call) => call.name === "observe_google_calendar_managed_event",
      ).length,
      1,
    );
    assert.equal(
      calls.filter(
        (call) =>
          call.method === "GET" &&
          new URL(call.url).pathname.endsWith(`/events/${MANAGED_EVENT_ID}`),
      ).length,
      0,
    );
  },
);

Deno.test(
  "un managed remoto conocido ausente genera cancelación; uno nunca proyectado no",
  async () => {
    for (const remoteKnown of [true, false]) {
      const { client, rpcCalls } = fakeSupabase(
        baseHandlers({
          begin_google_calendar_inbound_sync: () => ({
            data: [
              {
                lease_token: "lease-1",
                sync_token: null,
                first_import_approved: true,
                google_calendar_id: "cal-1",
                google_calendar_timezone: "America/Argentina/Buenos_Aires",
              },
            ],
            error: null,
          }),
          list_google_calendar_full_resync_managed_candidates: () => ({
            data: [
              {
                appointment_id: APPOINTMENT_ID,
                google_event_id: remoteKnown ? MANAGED_EVENT_ID : null,
                remote_known: remoteKnown,
              },
            ],
            error: null,
          }),
          observe_google_calendar_managed_event: () => ({
            data: "conflict_recorded",
            error: null,
          }),
        }),
      );
      const { fetcher } = fakeGoogle((call) =>
        call.method === "GET" && call.url.includes("/events?")
          ? eventsListResponse([])
          : call.method === "GET" && call.url.includes("/events/")
            ? new Response(null, { status: 404 })
            : null,
      );

      const response = await handleCalendarSyncRequest(syncRequest(), {
        createClient: () => client,
        authorize: adminAuthorization(),
        environment: (name) => ENVIRONMENT[name],
        fetcher,
      });

      assert.equal(response.status, 200);
      const observations = rpcCalls.filter(
        (call) => call.name === "observe_google_calendar_managed_event",
      );
      assert.equal(observations.length, remoteKnown ? 1 : 0);
      if (remoteKnown) {
        assert.equal(observations[0].args.p_appointment_id, APPOINTMENT_ID);
        assert.equal(observations[0].args.p_cancelled, true);
        assert.equal(observations[0].args.p_starts_at, null);
        assert.equal(observations[0].args.p_ends_at, null);
      }
      assert.ok(
        rpcCalls.some(
          (call) => call.name === "complete_google_calendar_inbound_sync",
        ),
      );
    }
  },
);

Deno.test(
  "un GET managed con appointment ajeno falla cerrado y no avanza ni empuja",
  async () => {
    const otherAppointmentId = "9d5c878a-a4c9-4ce9-89dc-b6b68b50caf2";
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        begin_google_calendar_inbound_sync: () => ({
          data: [
            {
              lease_token: "lease-1",
              sync_token: null,
              first_import_approved: true,
              google_calendar_id: "cal-1",
              google_calendar_timezone: "America/Argentina/Buenos_Aires",
            },
          ],
          error: null,
        }),
        list_google_calendar_full_resync_managed_candidates: () => ({
          data: [
            {
              appointment_id: APPOINTMENT_ID,
              google_event_id: MANAGED_EVENT_ID,
              remote_known: true,
            },
          ],
          error: null,
        }),
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) => {
      if (call.method === "GET" && call.url.includes("/events?")) {
        return eventsListResponse([]);
      }
      if (call.method === "GET" && call.url.includes("/events/")) {
        return jsonResponseOf({
          id: MANAGED_EVENT_ID,
          status: "confirmed",
          extendedProperties: {
            private: {
              managed_by: "gisela_lentz_agenda",
              appointment_id: otherAppointmentId,
              automation_epoch: AUTOMATION_EPOCH,
              projection_stage: "confirmed",
            },
          },
          start: { dateTime: APP_START },
          end: { dateTime: APP_END },
        });
      }
      return null;
    });

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });

    assert.equal(response.status, 503);
    const failure = rpcCalls.find(
      (call) => call.name === "fail_google_calendar_inbound_sync",
    );
    assert.equal(
      failure?.args.p_error_code,
      "CALENDAR_FULL_RESYNC_MANAGED_EVENT_MISMATCH",
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_inbound_sync",
      ),
      false,
    );
    assert.equal(
      rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
      false,
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "reconcile_google_calendar_external_events",
      ),
      false,
    );
    assert.equal(
      calls.some(
        (call) =>
          ["POST", "PATCH", "DELETE"].includes(call.method) &&
          call.url.includes("/events"),
      ),
      false,
    );
  },
);

Deno.test(
  "un fallo en la segunda página del audit managed bloquea token y push",
  async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(12, "0");
      return {
        appointment_id: `00000000-0000-4000-8000-${suffix}`,
        google_event_id: null,
        remote_known: false,
      };
    });
    let candidatePages = 0;
    const { client, rpcCalls } = fakeSupabase(
      baseHandlers({
        begin_google_calendar_inbound_sync: () => ({
          data: [
            {
              lease_token: "lease-1",
              sync_token: null,
              first_import_approved: true,
              google_calendar_id: "cal-1",
              google_calendar_timezone: "America/Argentina/Buenos_Aires",
            },
          ],
          error: null,
        }),
        list_google_calendar_full_resync_managed_candidates: () => {
          candidatePages += 1;
          return candidatePages === 1
            ? { data: firstPage, error: null }
            : { data: null, error: { code: "40001" } };
        },
      }),
    );
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([])
        : call.method === "GET" && call.url.includes("/events/")
          ? new Response(null, { status: 404 })
          : null,
    );

    const response = await handleCalendarSyncRequest(syncRequest(), {
      createClient: () => client,
      authorize: adminAuthorization(),
      environment: (name) => ENVIRONMENT[name],
      fetcher,
    });

    assert.equal(response.status, 503);
    const candidateCalls = rpcCalls.filter(
      (call) =>
        call.name === "list_google_calendar_full_resync_managed_candidates",
    );
    assert.equal(candidateCalls.length, 2);
    assert.equal(
      candidateCalls[1].args.p_after_appointment_id,
      "00000000-0000-4000-8000-000000000064",
    );
    assert.equal(
      calls.filter(
        (call) => call.method === "GET" && call.url.includes("/events/"),
      ).length,
      100,
    );
    const failure = rpcCalls.find(
      (call) => call.name === "fail_google_calendar_inbound_sync",
    );
    assert.equal(
      failure?.args.p_error_code,
      "CALENDAR_FULL_RESYNC_MANAGED_CANDIDATES_FAILED",
    );
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "complete_google_calendar_inbound_sync",
      ),
      false,
    );
    assert.equal(
      rpcCalls.some((call) => call.name === "claim_google_calendar_sync_jobs"),
      false,
    );
  },
);
