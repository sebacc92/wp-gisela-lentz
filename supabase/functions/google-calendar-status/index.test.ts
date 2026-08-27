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
      pendingCount: null,
      failedCount: null,
    });
  },
);
