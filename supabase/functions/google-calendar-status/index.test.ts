import assert from "node:assert/strict";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  handleGoogleCalendarStatusRequest,
  type GoogleCalendarStatusDependencies,
} from "./index.ts";

const CALENDAR_ENVIRONMENT: Record<string, string> = {
  GOOGLE_CALENDAR_CLIENT_ID: "calendar-client-id",
  GOOGLE_CALENDAR_CLIENT_SECRET: "server-only-calendar-secret",
  GOOGLE_CALENDAR_REDIRECT_URI: "https://app.example.com/calendar/callback",
  APP_BASE_URL: "https://app.example.com",
};

function manualRequest(): Request {
  return new Request("http://127.0.0.1/functions/v1/google-calendar-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "manual_status" }),
  });
}

function authorization(role: "ADMIN" | "OPERADOR") {
  return async () =>
    ({
      user: { id: "11111111-1111-4111-8111-111111111111" },
      profile: {
        id: "11111111-1111-4111-8111-111111111111",
        full_name: "Gisela",
        role,
      },
    }) as unknown as Awaited<
      ReturnType<NonNullable<GoogleCalendarStatusDependencies["authorize"]>>
    >;
}

Deno.test(
  "Calendar manual_status entrega sólo el resumen seguro para una ADMIN",
  async () => {
    let rpcCalls = 0;
    const client = {
      rpc: async (name: string) => {
        rpcCalls += 1;
        assert.equal(name, "google_calendar_status");
        return {
          data: [
            {
              connected: true,
              status: "connected",
              google_account_email: "private-calendar@example.com",
              google_calendar_name: "Agenda privada de Gisela",
              last_synced_at: "2026-08-26T12:00:00Z",
              automation_enabled: true,
              pending_count: 0,
              failed_count: 0,
            },
          ],
          error: null,
        };
      },
    } as unknown as SupabaseClient;

    const response = await handleGoogleCalendarStatusRequest(manualRequest(), {
      createClient: () => client,
      authorize: authorization("ADMIN"),
      environment: (name) => CALENDAR_ENVIRONMENT[name],
    });

    assert.equal(response.status, 200);
    assert.equal(rpcCalls, 1);
    const body = await response.json();
    assert.deepEqual(body, {
      configured: true,
      connected: true,
      status: "connected",
      automationActive: true,
      pendingCount: 0,
      failedCount: 0,
    });
    const serialized = JSON.stringify(body).toLowerCase();
    assert.equal(serialized.includes("private-calendar"), false);
    assert.equal(serialized.includes("agenda privada"), false);
    assert.equal(serialized.includes("lastsynced"), false);
    assert.equal(serialized.includes("server-only-calendar-secret"), false);
  },
);

Deno.test(
  "Calendar manual_status exige ADMIN antes de consultar estado",
  async () => {
    let rpcCalls = 0;
    const client = {
      rpc: async () => {
        rpcCalls += 1;
        throw new Error("must not query Calendar");
      },
    } as unknown as SupabaseClient;

    const response = await handleGoogleCalendarStatusRequest(manualRequest(), {
      createClient: () => client,
      authorize: authorization("OPERADOR"),
      environment: (name) => CALENDAR_ENVIRONMENT[name],
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "ADMIN_REQUIRED" });
    assert.equal(rpcCalls, 0);
  },
);

Deno.test(
  "Calendar manual_status falla cerrado para conteos o estado inciertos",
  async () => {
    const client = {
      rpc: async () => ({
        data: [
          {
            connected: true,
            status: "unexpected_state",
            pending_count: "0",
            failed_count: null,
          },
        ],
        error: null,
      }),
    } as unknown as SupabaseClient;

    const response = await handleGoogleCalendarStatusRequest(manualRequest(), {
      createClient: () => client,
      authorize: authorization("ADMIN"),
      environment: (name) => CALENDAR_ENVIRONMENT[name],
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      configured: true,
      connected: true,
      status: null,
      automationActive: false,
      pendingCount: null,
      failedCount: null,
    });
  },
);

Deno.test(
  "el estado del panel expone contadores de la sincronización, nunca detalles",
  async () => {
    const client = {
      rpc: () =>
        Promise.resolve({
          data: [
            {
              connected: true,
              status: "connected",
              google_account_email: "calendar@example.com",
              google_calendar_name: "Gisela Lentz · Turnos",
              last_synced_at: null,
              last_checked_at: "2026-09-02T21:42:00Z",
              last_sync_completed_at: "2026-09-02T21:42:00Z",
              last_sync_summary: {
                blocksImported: 1,
                fullResync: true,
                // Un título de evento nunca debería llegar hasta acá; si
                // llegara, la proyección igual tiene que descartarlo.
                eventSummary: "Cumpleaños de un paciente",
                "raro!": 3,
              },
              last_sync_error: null,
              inbound_sync_state: "incremental",
              inbound_first_import_approved: true,
              automation_enabled: true,
              automation_activated_at: "2026-09-02T21:40:00Z",
              selection_pending: true,
              pending_count: 0,
              failed_count: 0,
              active_block_count: 1,
              unsupported_event_count: 2,
              pending_conflict_count: 1,
            },
          ],
          error: null,
        }),
    } as unknown as SupabaseClient;

    const response = await handleGoogleCalendarStatusRequest(
      new Request("http://127.0.0.1/functions/v1/google-calendar-status", {
        method: "GET",
      }),
      {
        createClient: () => client,
        authorize: authorization("ADMIN"),
        environment: (name) => CALENDAR_ENVIRONMENT[name],
      },
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.lastCheckedAt, "2026-09-02T21:42:00Z");
    assert.equal(body.lastSyncedAt, null);
    assert.equal(body.blockCount, 1);
    assert.equal(body.unsupportedCount, 2);
    assert.equal(body.conflictCount, 1);
    assert.equal(body.firstImportApproved, true);
    assert.equal(body.selectionPending, true);
    assert.equal(
      body.message,
      "Google ya autorizó la cuenta. Falta elegir el calendario.",
    );
    assert.equal(body.inboundSyncState, "incremental");
    assert.equal(body.automationActive, true);
    assert.equal(body.automationActivatedAt, "2026-09-02T21:40:00Z");
    // Un conflicto pendiente pide revisión aunque la cola saliente esté al día.
    assert.equal(body.status, "attention");
    // El título y la clave inválida se descartan por completo.
    assert.deepEqual(body.lastSyncSummary, {
      blocksImported: 1,
      fullResync: true,
    });
  },
);

Deno.test(
  "el estado nunca infiere automatización por conexión o revisión",
  async () => {
    const client = {
      rpc: () =>
        Promise.resolve({
          data: [
            {
              connected: true,
              status: "connected",
              last_checked_at: "2026-09-02T21:42:00Z",
              last_sync_completed_at: "2026-09-02T21:42:00Z",
              inbound_sync_state: "incremental",
              inbound_first_import_approved: true,
              pending_count: 0,
              failed_count: 0,
              active_block_count: 0,
              unsupported_event_count: 0,
              pending_conflict_count: 0,
            },
          ],
          error: null,
        }),
    } as unknown as SupabaseClient;

    const response = await handleGoogleCalendarStatusRequest(
      new Request("http://127.0.0.1/functions/v1/google-calendar-status"),
      {
        createClient: () => client,
        authorize: authorization("ADMIN"),
        environment: (name) => CALENDAR_ENVIRONMENT[name],
      },
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(body.automationActive, false);
    assert.equal(body.automationActivatedAt, null);
    assert.equal(
      body.message,
      "Google Calendar está conectado. La automatización todavía no está activa.",
    );
  },
);

Deno.test("un código de error de sincronización llega sanitizado", async () => {
  const client = {
    rpc: () =>
      Promise.resolve({
        data: [
          {
            connected: true,
            status: "connected",
            last_sync_error: "detalle crudo con espacios y datos",
            pending_count: 0,
            failed_count: 0,
          },
        ],
        error: null,
      }),
  } as unknown as SupabaseClient;

  const response = await handleGoogleCalendarStatusRequest(
    new Request("http://127.0.0.1/functions/v1/google-calendar-status", {
      method: "GET",
    }),
    {
      createClient: () => client,
      authorize: authorization("ADMIN"),
      environment: (name) => CALENDAR_ENVIRONMENT[name],
    },
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.lastSyncError, null);
  // Aunque un detalle inesperado no se exponga, tampoco se anuncia un estado
  // saludable mientras la base informa una falla de sincronización.
  assert.equal(body.status, "error");
});

Deno.test(
  "el panel no anuncia sincronización completa antes de aprobar la primera importación",
  async () => {
    const client = {
      rpc: () =>
        Promise.resolve({
          data: [
            {
              connected: true,
              status: "connected",
              last_checked_at: null,
              last_sync_completed_at: null,
              last_sync_error: null,
              inbound_sync_state: "awaiting_first_import",
              inbound_first_import_approved: false,
              pending_count: 0,
              failed_count: 0,
              active_block_count: 0,
              unsupported_event_count: 0,
              pending_conflict_count: 0,
            },
          ],
          error: null,
        }),
    } as unknown as SupabaseClient;

    const response = await handleGoogleCalendarStatusRequest(
      new Request("http://127.0.0.1/functions/v1/google-calendar-status"),
      {
        createClient: () => client,
        authorize: authorization("ADMIN"),
        environment: (name) => CALENDAR_ENVIRONMENT[name],
      },
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.status, "first_import_required");
    assert.equal(body.firstImportApproved, false);
    assert.equal(body.lastCheckedAt, null);
    assert.equal(
      body.message,
      "Falta revisar y habilitar la importación inicial.",
    );
  },
);

Deno.test(
  "el panel distingue importación aprobada de primera sincronización completada",
  async () => {
    const client = {
      rpc: () =>
        Promise.resolve({
          data: [
            {
              connected: true,
              status: "connected",
              last_checked_at: null,
              last_sync_completed_at: null,
              last_sync_error: null,
              inbound_sync_state: "full_resync_required",
              inbound_first_import_approved: true,
              pending_count: 0,
              failed_count: 0,
              active_block_count: 0,
              unsupported_event_count: 0,
              pending_conflict_count: 0,
            },
          ],
          error: null,
        }),
    } as unknown as SupabaseClient;

    const response = await handleGoogleCalendarStatusRequest(
      new Request("http://127.0.0.1/functions/v1/google-calendar-status"),
      {
        createClient: () => client,
        authorize: authorization("ADMIN"),
        environment: (name) => CALENDAR_ENVIRONMENT[name],
      },
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.status, "initial_sync_required");
    assert.equal(body.firstImportApproved, true);
    assert.equal(body.message, "La primera sincronización todavía no terminó.");
  },
);

Deno.test(
  "un OPERADOR no recibe identidad de cuenta ni calendario",
  async () => {
    const client = {
      rpc: () =>
        Promise.resolve({
          data: [
            {
              connected: true,
              status: "connected",
              google_account_email: "private-calendar@example.com",
              google_calendar_name: "Agenda privada",
              pending_count: 0,
              failed_count: 0,
            },
          ],
          error: null,
        }),
    } as unknown as SupabaseClient;

    const response = await handleGoogleCalendarStatusRequest(
      new Request("http://127.0.0.1/functions/v1/google-calendar-status"),
      {
        createClient: () => client,
        authorize: authorization("OPERADOR"),
        environment: (name) => CALENDAR_ENVIRONMENT[name],
      },
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.email, null);
    assert.equal(body.calendarName, null);
    assert.equal(JSON.stringify(body).includes("private-calendar"), false);
    assert.equal(JSON.stringify(body).includes("Agenda privada"), false);
  },
);
