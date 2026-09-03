import assert from "node:assert/strict";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  handleCalendarSyncRequest,
  type CalendarSyncDependencies,
} from "./index.ts";

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
};

const APPOINTMENT_ID = "8c4b7679-f3b8-4bd8-98cb-a5a57a49b9e1";
const MANAGED_EVENT_ID = "gl8c4b7679f3b84bd898cba5a57a49b9e1";
const APP_START = "2026-09-10T14:00:00.000Z";
const APP_END = "2026-09-10T15:00:00.000Z";
const MOVED_START = "2026-09-10T17:00:00.000Z";
const MOVED_END = "2026-09-10T18:00:00.000Z";

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

interface HttpCall {
  method: string;
  url: string;
  headers: Record<string, string>;
}

type RpcHandler = (args: Record<string, unknown>) => {
  data: unknown;
  error: unknown;
};

function fakeSupabase(handlers: Record<string, RpcHandler>) {
  const rpcCalls: RpcCall[] = [];
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () =>
      Promise.resolve({
        data: { status: "connected", connection_generation: 1 },
        error: null,
      }),
  };
  const client = {
    rpc(name: string, args: Record<string, unknown> = {}) {
      rpcCalls.push({ name, args });
      const handler = handlers[name];
      return Promise.resolve(
        handler ? handler(args) : { data: null, error: null },
      );
    },
    from: () => chain,
  };
  return { client: client as unknown as SupabaseClient, rpcCalls };
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
    const call = { method, url, headers };
    calls.push(call);

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(
        jsonResponseOf({ access_token: "access-token", expires_in: 3600 }),
      );
    }
    const routed = route(call);
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

function baseHandlers(
  overrides: Record<string, RpcHandler> = {},
): Record<string, RpcHandler> {
  return {
    reconcile_google_calendar_sync: () => ({
      data: [{ queued: 1, already_queued: 0 }],
      error: null,
    }),
    get_google_calendar_connection_secret: () => ({
      data: [
        {
          status: "connected",
          google_calendar_id: "cal-1",
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
        },
      ],
      error: null,
    }),
    claim_google_calendar_sync_jobs: () => ({ data: [], error: null }),
    claim_google_calendar_external_cleanup: () => ({ data: [], error: null }),
    complete_google_calendar_inbound_sync: () => ({ data: true, error: null }),
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
    const { fetcher, calls } = fakeGoogle((call) =>
      call.method === "GET" && call.url.includes("/events?")
        ? eventsListResponse([
            {
              id: MANAGED_EVENT_ID,
              status: "confirmed",
              etag: '"etag-remoto"',
              updated: "2026-09-03T10:00:00.000Z",
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
            { id: "evento-opaco-borrado", status: "cancelled" },
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
    // Nunca se importa como bloqueo externo un evento que era un turno.
    assert.equal(
      rpcCalls.some(
        (call) => call.name === "apply_google_calendar_external_event",
      ),
      false,
    );
    assert.equal(body.outcome, "completed");
  },
);

Deno.test(
  "C bis: el id determinista alcanza aunque Google no mande nada más",
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

    const observe = rpcCalls.find(
      (call) => call.name === "observe_google_calendar_managed_event",
    );
    assert.equal(observe?.args.p_appointment_id, APPOINTMENT_ID);
    assert.equal(observe?.args.p_cancelled, true);
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
            {
              job_id: "22222222-2222-4222-8222-222222222222",
              appointment_id: APPOINTMENT_ID,
              operation: "upsert",
              desired_version: 3,
              attempts: 1,
              starts_at: APP_START,
              ends_at: APP_END,
              patient_name: "Paciente Sintético",
              timezone: "America/Argentina/Buenos_Aires",
              connection_generation: 1,
              google_etag: '"etag-conocido"',
            },
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
          data: [
            {
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
              google_etag: null,
            },
          ],
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
  },
);

Deno.test("el preview no toca la cola, el lease ni la bitácora", async () => {
  const { client, rpcCalls } = fakeSupabase(baseHandlers());
  const { fetcher, calls } = fakeGoogle((call) =>
    call.method === "GET" && call.url.includes("/events?")
      ? eventsListResponse([
          {
            id: "evento-manual",
            summary: "Evento sintético",
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
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(body.mutated, false);
  assert.deepEqual(
    rpcCalls.map((call) => call.name),
    ["get_google_calendar_connection_secret"],
    "el preview sólo lee la conexión",
  );
  assert.equal(
    calls.some((call) => call.method !== "GET" && call.url.includes("/events")),
    false,
  );
  assert.equal(
    (body.preview as { wouldBecomeBlocks: number }).wouldBecomeBlocks,
    1,
  );
});

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
  "el evento manual convertido se retira de Google después del push",
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

    const deletion = calls.find((call) => call.method === "DELETE");
    assert.ok(deletion?.url.includes("evento-manual-convertido"));
    const completion = rpcCalls.find(
      (call) => call.name === "complete_google_calendar_external_cleanup",
    );
    assert.equal(completion?.args.p_succeeded, true);
    assert.deepEqual(body.cleanup, { done: 1, failed: 0 });
  },
);
