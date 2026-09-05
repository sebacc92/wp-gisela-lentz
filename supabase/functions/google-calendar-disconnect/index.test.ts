import assert from "node:assert/strict";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  handleGoogleCalendarDisconnectRequest,
  type GoogleCalendarDisconnectDependencies,
} from "./index.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function request(): Request {
  return new Request(
    "http://127.0.0.1/functions/v1/google-calendar-disconnect",
    { method: "POST" },
  );
}

function authorization(role: "ADMIN" | "OPERADOR" = "ADMIN") {
  return async () =>
    ({
      user: { id: USER_ID },
      profile: { id: USER_ID, full_name: "Seba", role },
    }) as unknown as Awaited<
      ReturnType<NonNullable<GoogleCalendarDisconnectDependencies["authorize"]>>
    >;
}

Deno.test("disconnect captura y revoca token activo y candidato", async () => {
  const actions: string[] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      actions.push("atomic-disconnect");
      assert.equal(name, "disconnect_google_calendar_with_secrets");
      assert.deepEqual(args, { p_user_id: USER_ID });
      return {
        data: [
          {
            active_refresh_token: "active-refresh-token",
            candidate_refresh_token: "candidate-refresh-token",
          },
        ],
        error: null,
      };
    },
  } as unknown as SupabaseClient;
  const revoked: string[] = [];
  const fetchImpl = (async (input, init) => {
    actions.push("remote-revoke");
    assert.equal(String(input), "https://oauth2.googleapis.com/revoke");
    assert.equal(init?.method, "POST");
    revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const response = await handleGoogleCalendarDisconnectRequest(request(), {
    createClient: () => client,
    authorize: authorization(),
    fetchImpl,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(actions[0], "atomic-disconnect");
  assert.deepEqual(revoked.sort(), [
    "active-refresh-token",
    "candidate-refresh-token",
  ]);
  assert.equal(body.disconnected, true);
  assert.equal(body.eventsPreserved, true);
  assert.equal(body.remoteRevocationConfirmed, true);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("active-refresh-token"), false);
  assert.equal(serialized.includes("candidate-refresh-token"), false);
});

Deno.test(
  "disconnect deduplica dos referencias al mismo refresh token",
  async () => {
    const client = {
      rpc: async () => ({
        data: [
          {
            active_refresh_token: "same-refresh-token",
            candidate_refresh_token: "same-refresh-token",
          },
        ],
        error: null,
      }),
    } as unknown as SupabaseClient;
    let revocations = 0;

    const response = await handleGoogleCalendarDisconnectRequest(request(), {
      createClient: () => client,
      authorize: authorization(),
      fetchImpl: (async () => {
        revocations += 1;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });

    assert.equal(response.status, 200);
    assert.equal(revocations, 1);
    assert.equal((await response.json()).remoteRevocationConfirmed, true);
  },
);

Deno.test(
  "disconnect conserva éxito local si una revocación remota falla",
  async () => {
    const client = {
      rpc: async () => ({
        data: [
          {
            active_refresh_token: "active-refresh-token",
            candidate_refresh_token: "candidate-refresh-token",
          },
        ],
        error: null,
      }),
    } as unknown as SupabaseClient;
    let calls = 0;

    const response = await handleGoogleCalendarDisconnectRequest(request(), {
      createClient: () => client,
      authorize: authorization(),
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) throw new Error("private network detail");
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.equal(body.disconnected, true);
    assert.equal(body.remoteRevocationConfirmed, false);
    assert.equal(
      JSON.stringify(body).includes("private network detail"),
      false,
    );
  },
);

Deno.test("disconnect exige ADMIN antes de limpiar o revocar", async () => {
  let rpcCalls = 0;
  let fetchCalls = 0;
  const client = {
    rpc: async () => {
      rpcCalls += 1;
      throw new Error("must not mutate");
    },
  } as unknown as SupabaseClient;

  const response = await handleGoogleCalendarDisconnectRequest(request(), {
    createClient: () => client,
    authorize: authorization("OPERADOR"),
    fetchImpl: (async () => {
      fetchCalls += 1;
      throw new Error("must not revoke");
    }) as typeof fetch,
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "ADMIN_REQUIRED" });
  assert.equal(rpcCalls, 0);
  assert.equal(fetchCalls, 0);
});

Deno.test("disconnect no revoca si la transacción atómica falla", async () => {
  const client = {
    rpc: async () => ({
      data: null,
      error: { message: "private database detail" },
    }),
  } as unknown as SupabaseClient;
  let fetchCalls = 0;

  const response = await handleGoogleCalendarDisconnectRequest(request(), {
    createClient: () => client,
    authorize: authorization(),
    fetchImpl: (async () => {
      fetchCalls += 1;
      throw new Error("must not revoke");
    }) as typeof fetch,
  });
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.error, "GOOGLE_DISCONNECT_FAILED");
  assert.equal(JSON.stringify(body).includes("private database detail"), false);
  assert.equal(fetchCalls, 0);
});
