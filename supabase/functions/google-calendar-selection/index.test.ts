import assert from "node:assert/strict";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  type GoogleCalendarSelectionDependencies,
  handleGoogleCalendarSelectionRequest,
} from "./index.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TIME_ZONE = "America/Argentina/Buenos_Aires";
const ENVIRONMENT: Record<string, string> = {
  GOOGLE_CALENDAR_CLIENT_ID: "calendar-client-id",
  GOOGLE_CALENDAR_CLIENT_SECRET: "server-only-secret",
  GOOGLE_CALENDAR_REDIRECT_URI:
    "https://project.example/functions/v1/google-calendar-oauth-callback",
  APP_BASE_URL: "https://app.example",
};

function authorization(role: "ADMIN" | "OPERADOR" = "ADMIN") {
  return async () =>
    ({
      user: { id: USER_ID },
      profile: { id: USER_ID, full_name: "Seba", role },
    }) as unknown as Awaited<
      ReturnType<NonNullable<GoogleCalendarSelectionDependencies["authorize"]>>
    >;
}

function request(
  method: "GET" | "POST" | "DELETE",
  body?: Record<string, unknown>,
): Request {
  return new Request(
    "http://127.0.0.1/functions/v1/google-calendar-selection",
    {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
  );
}

Deno.test("DELETE descarta la selección sin consultar Google", async () => {
  let fetchCalls = 0;
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, "cancel_google_calendar_connection_candidate");
      assert.deepEqual(args, { p_user_id: USER_ID });
      return { data: true, error: null };
    },
  } as unknown as SupabaseClient;

  const response = await handleGoogleCalendarSelectionRequest(
    request("DELETE"),
    {
      createClient: () => client,
      authorize: authorization(),
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error("must not call Google");
      }) as typeof fetch,
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    cancelled: true,
    alreadyCancelled: false,
  });
  assert.equal(fetchCalls, 0);
});

function candidate() {
  return {
    candidate_id: "22222222-2222-4222-8222-222222222222",
    google_account_id: "google-account-id",
    google_account_email: "calendar-owner@example.com",
    refresh_token: "long-lived-refresh-token",
    expires_at: "2099-01-01T00:00:00.000Z",
  };
}

function environment(name: string): string | undefined {
  return ENVIRONMENT[name];
}

Deno.test(
  "GET lista sólo calendarios owner y nunca expone credenciales",
  async () => {
    const rpcNames: string[] = [];
    const client = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcNames.push(name);
        assert.equal(name, "get_google_calendar_connection_candidate_secret");
        assert.deepEqual(args, { p_user_id: USER_ID });
        return { data: [candidate()], error: null };
      },
    } as unknown as SupabaseClient;
    const fetchImpl = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/token")) {
        assert.equal(init?.method, "POST");
        return Response.json({ access_token: "fresh-access-token" });
      }
      assert.equal(url.pathname, "/calendar/v3/users/me/calendarList");
      assert.equal(url.searchParams.get("minAccessRole"), "owner");
      return Response.json({
        items: [
          {
            id: "owned@example.com",
            summary: "Agenda propia",
            timeZone: TIME_ZONE,
            accessRole: "owner",
            primary: true,
          },
          {
            id: "writer@example.com",
            summary: "Agenda compartida",
            timeZone: TIME_ZONE,
            accessRole: "writer",
          },
        ],
      });
    }) as typeof fetch;

    const response = await handleGoogleCalendarSelectionRequest(
      request("GET"),
      {
        createClient: () => client,
        authorize: authorization(),
        environment,
        fetchImpl,
        now: () => 0,
      },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(rpcNames, [
      "get_google_calendar_connection_candidate_secret",
    ]);
    assert.deepEqual(body, {
      selectionRequired: true,
      calendars: [
        {
          id: "owned@example.com",
          name: "Agenda propia",
          timeZone: TIME_ZONE,
          primary: true,
        },
      ],
    });
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("calendar-owner@example.com"), false);
    assert.equal(serialized.includes("long-lived-refresh-token"), false);
    assert.equal(serialized.includes("google-account-id"), false);
    assert.equal(serialized.includes(candidate().candidate_id), false);
    assert.equal(serialized.includes("server-only-secret"), false);
  },
);

Deno.test(
  "GET repetido reutiliza el candidato selecting de forma segura",
  async () => {
    let candidateReads = 0;
    const client = {
      rpc: async () => {
        candidateReads += 1;
        return { data: [candidate()], error: null };
      },
    } as unknown as SupabaseClient;
    const fetchImpl = (async (input) =>
      String(input).endsWith("/token")
        ? Response.json({ access_token: "fresh-access-token" })
        : Response.json({ items: [] })) as typeof fetch;
    const dependencies: GoogleCalendarSelectionDependencies = {
      createClient: () => client,
      authorize: authorization(),
      environment,
      fetchImpl,
      now: () => 0,
    };

    for (let count = 0; count < 2; count += 1) {
      const response = await handleGoogleCalendarSelectionRequest(
        request("GET"),
        dependencies,
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).selectionRequired, true);
    }
    assert.equal(candidateReads, 2);
  },
);

Deno.test("POST revalida owner y timezone antes de finalizar", async () => {
  const rpcNames: string[] = [];
  let finalizeArguments: Record<string, unknown> | undefined;
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcNames.push(name);
      if (name === "get_google_calendar_connection_candidate_secret") {
        return { data: [candidate()], error: null };
      }
      if (name === "get_google_calendar_connection_metadata") {
        return {
          data: [
            {
              status: "connected",
              google_account_id: candidate().google_account_id,
            },
          ],
          error: null,
        };
      }
      assert.equal(name, "finalize_google_calendar_connection_selection");
      finalizeArguments = args;
      return { data: 7, error: null };
    },
    from: (table: string) => {
      assert.equal(table, "app_settings");
      const query = {
        select(columns: string) {
          assert.equal(columns, "timezone");
          return query;
        },
        eq(column: string, value: unknown) {
          assert.equal(column, "id");
          assert.equal(value, true);
          return query;
        },
        async single() {
          return { data: { timezone: TIME_ZONE }, error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  const fetchImpl = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/token")) {
      return Response.json({ access_token: "fresh-access-token" });
    }
    assert.equal(init?.method ?? "GET", "GET");
    if (url.pathname.includes("/users/me/calendarList/")) {
      assert.equal(
        url.pathname,
        "/calendar/v3/users/me/calendarList/owned%2Fcalendar%40example.com",
      );
      return Response.json({
        id: "owned/calendar@example.com",
        summary: "Agenda existente",
        timeZone: TIME_ZONE,
        accessRole: "owner",
      });
    }
    assert.equal(
      url.pathname,
      "/calendar/v3/calendars/owned%2Fcalendar%40example.com/events",
    );
    assert.equal(url.searchParams.get("maxResults"), "1");
    assert.equal(url.searchParams.get("showDeleted"), "false");
    return Response.json({ items: [] });
  }) as typeof fetch;

  const response = await handleGoogleCalendarSelectionRequest(
    request("POST", { calendarId: "owned/calendar@example.com" }),
    {
      createClient: () => client,
      authorize: authorization(),
      environment,
      fetchImpl,
      now: () => 0,
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    connected: true,
    selected: true,
    alreadySelected: false,
    calendarName: "Agenda existente",
  });
  assert.deepEqual(rpcNames, [
    "get_google_calendar_connection_candidate_secret",
    "get_google_calendar_connection_metadata",
    "finalize_google_calendar_connection_selection",
  ]);
  assert.deepEqual(finalizeArguments, {
    p_user_id: USER_ID,
    p_candidate_id: candidate().candidate_id,
    p_google_calendar_id: "owned/calendar@example.com",
    p_google_calendar_name: "Agenda existente",
    p_google_calendar_timezone: TIME_ZONE,
  });
});

Deno.test("POST exige el permiso de eventos antes de finalizar", async () => {
  let finalized = false;
  const client = {
    rpc: async (name: string) => {
      if (name === "get_google_calendar_connection_candidate_secret") {
        return { data: [candidate()], error: null };
      }
      if (name === "get_google_calendar_connection_metadata") {
        return { data: [{ status: "disconnected" }], error: null };
      }
      finalized = true;
      return { data: 7, error: null };
    },
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        single: async () => ({ data: { timezone: TIME_ZONE }, error: null }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
  const fetchImpl = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/token")) {
      return Response.json({ access_token: "fresh-access-token" });
    }
    if (url.pathname.includes("/users/me/calendarList/")) {
      return Response.json({
        id: "owned@example.com",
        summary: "Agenda existente",
        timeZone: TIME_ZONE,
        accessRole: "owner",
      });
    }
    return Response.json(
      { error: { errors: [{ reason: "insufficientPermissions" }] } },
      { status: 403 },
    );
  }) as typeof fetch;

  const response = await handleGoogleCalendarSelectionRequest(
    request("POST", { calendarId: "owned@example.com" }),
    {
      createClient: () => client,
      authorize: authorization(),
      environment,
      fetchImpl,
      now: () => 0,
    },
  );

  assert.equal(response.status, 409);
  assert.equal(
    (await response.json()).error,
    "GOOGLE_CALENDAR_EVENTS_ACCESS_REQUIRED",
  );
  assert.equal(finalized, false);
});

Deno.test("POST exige desconectar antes de cambiar de cuenta", async () => {
  let fetchCalls = 0;
  let finalized = false;
  const client = {
    rpc: async (name: string) => {
      if (name === "get_google_calendar_connection_candidate_secret") {
        return { data: [candidate()], error: null };
      }
      if (name === "get_google_calendar_connection_metadata") {
        return {
          data: [
            {
              status: "connected",
              google_account_id: "different-google-account",
            },
          ],
          error: null,
        };
      }
      finalized = true;
      return { data: 7, error: null };
    },
  } as unknown as SupabaseClient;

  const response = await handleGoogleCalendarSelectionRequest(
    request("POST", { calendarId: "owned@example.com" }),
    {
      createClient: () => client,
      authorize: authorization(),
      environment,
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error("must not call Google");
      }) as typeof fetch,
      now: () => 0,
    },
  );

  assert.equal(response.status, 409);
  assert.equal(
    (await response.json()).error,
    "GOOGLE_CALENDAR_DISCONNECT_REQUIRED",
  );
  assert.equal(finalized, false);
  assert.equal(fetchCalls, 0);
});

Deno.test(
  "POST no anuncia conexión si finalize no devuelve generación",
  async () => {
    const client = {
      rpc: async (name: string) =>
        name === "get_google_calendar_connection_candidate_secret"
          ? { data: [candidate()], error: null }
          : { data: null, error: null },
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          single: async () => ({ data: { timezone: TIME_ZONE }, error: null }),
        };
        return query;
      },
    } as unknown as SupabaseClient;
    const fetchImpl = (async (input) =>
      String(input).endsWith("/token")
        ? Response.json({ access_token: "fresh-access-token" })
        : Response.json({
            id: "owned@example.com",
            summary: "Agenda existente",
            timeZone: TIME_ZONE,
            accessRole: "owner",
          })) as typeof fetch;

    const response = await handleGoogleCalendarSelectionRequest(
      request("POST", { calendarId: "owned@example.com" }),
      {
        createClient: () => client,
        authorize: authorization(),
        environment,
        fetchImpl,
        now: () => 0,
      },
    );

    assert.equal(response.status, 409);
    assert.equal(
      (await response.json()).error,
      "GOOGLE_CALENDAR_SELECTION_FINALIZE_FAILED",
    );
  },
);

Deno.test(
  "POST rechaza writer y timezone incorrecta sin finalizar",
  async () => {
    for (const calendar of [
      {
        id: "writer@example.com",
        summary: "Compartido",
        timeZone: TIME_ZONE,
        accessRole: "writer",
        expectedError: "GOOGLE_CALENDAR_OWNER_REQUIRED",
      },
      {
        id: "other-zone@example.com",
        summary: "Otra zona",
        timeZone: "America/New_York",
        accessRole: "owner",
        expectedError: "GOOGLE_CALENDAR_TIMEZONE_MISMATCH",
      },
    ]) {
      let finalized = false;
      const client = {
        rpc: async (name: string) => {
          if (name === "finalize_google_calendar_connection_selection") {
            finalized = true;
          }
          return { data: [candidate()], error: null };
        },
        from: () => {
          const query = {
            select: () => query,
            eq: () => query,
            single: async () => ({
              data: { timezone: TIME_ZONE },
              error: null,
            }),
          };
          return query;
        },
      } as unknown as SupabaseClient;
      const fetchImpl = (async (input) =>
        String(input).endsWith("/token")
          ? Response.json({ access_token: "fresh-access-token" })
          : Response.json(calendar)) as typeof fetch;

      const response = await handleGoogleCalendarSelectionRequest(
        request("POST", { calendarId: calendar.id }),
        {
          createClient: () => client,
          authorize: authorization(),
          environment,
          fetchImpl,
          now: () => 0,
        },
      );
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, calendar.expectedError);
      assert.equal(finalized, false);
    }
  },
);

Deno.test(
  "POST repetido acepta sólo el mismo calendario ya conectado",
  async () => {
    let fetchCalls = 0;
    const metadataIds: string[] = [];
    const client = {
      rpc: async (name: string) => {
        if (name === "get_google_calendar_connection_candidate_secret") {
          return { data: [], error: null };
        }
        assert.equal(name, "get_google_calendar_connection_metadata");
        metadataIds.push(name);
        return {
          data: [
            {
              status: "connected",
              google_calendar_id: "already-selected@example.com",
            },
          ],
          error: null,
        };
      },
    } as unknown as SupabaseClient;

    const response = await handleGoogleCalendarSelectionRequest(
      request("POST", { calendarId: "already-selected@example.com" }),
      {
        createClient: () => client,
        authorize: authorization(),
        environment,
        fetchImpl: (async () => {
          fetchCalls += 1;
          throw new Error("must not call Google");
        }) as typeof fetch,
        now: () => 0,
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      connected: true,
      selected: true,
      alreadySelected: true,
    });
    assert.equal(metadataIds.length, 1);
    assert.equal(fetchCalls, 0);
  },
);

Deno.test(
  "selection exige ADMIN y body exacto antes de consultar Google",
  async () => {
    let rpcCalls = 0;
    let fetchCalls = 0;
    const client = {
      rpc: async () => {
        rpcCalls += 1;
        return { data: [candidate()], error: null };
      },
    } as unknown as SupabaseClient;
    const common = {
      createClient: () => client,
      environment,
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error("must not call Google");
      }) as typeof fetch,
      now: () => 0,
    };

    const forbidden = await handleGoogleCalendarSelectionRequest(
      request("GET"),
      {
        ...common,
        authorize: authorization("OPERADOR"),
      },
    );
    assert.equal(forbidden.status, 403);

    const invalid = await handleGoogleCalendarSelectionRequest(
      request("POST", { calendarId: "owned@example.com", extra: true }),
      { ...common, authorize: authorization() },
    );
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "INVALID_REQUEST");
    assert.equal(rpcCalls, 0);
    assert.equal(fetchCalls, 0);
  },
);
