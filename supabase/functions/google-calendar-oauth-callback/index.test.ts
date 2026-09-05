import assert from "node:assert/strict";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  type GoogleCalendarOAuthCallbackDependencies,
  handleGoogleCalendarOAuthCallbackRequest,
} from "./index.ts";
import { sha256Hex } from "../_shared/google-calendar.ts";

const ENVIRONMENT: Record<string, string> = {
  GOOGLE_CALENDAR_CLIENT_ID: "calendar-client-id",
  GOOGLE_CALENDAR_CLIENT_SECRET: "server-only-secret",
  GOOGLE_CALENDAR_REDIRECT_URI:
    "https://project.example/functions/v1/google-calendar-oauth-callback",
  APP_BASE_URL: "https://app.example",
};
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

function callbackRequest(
  parameters = "state=opaque-state&code=authorization-code",
) {
  return new Request(
    `https://project.example/functions/v1/google-calendar-oauth-callback?${parameters}`,
  );
}

function environment(name: string): string | undefined {
  return ENVIRONMENT[name];
}

Deno.test(
  "callback deja un candidato y exige selección explícita",
  async () => {
    const rpcNames: string[] = [];
    let stagedArguments: Record<string, unknown> | undefined;
    const client = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcNames.push(name);
        if (name === "consume_google_calendar_oauth_state") {
          assert.equal(args.p_state_hash, await sha256Hex("opaque-state"));
          return {
            data: [
              {
                user_id: USER_ID,
                code_verifier: "p".repeat(64),
                connection_generation: 7,
                oauth_attempt_generation: 11,
              },
            ],
            error: null,
          };
        }
        assert.equal(name, "stage_google_calendar_connection_candidate");
        stagedArguments = args;
        return {
          data: [
            {
              candidate_id: "22222222-2222-4222-8222-222222222222",
              expires_at: CANDIDATE_EXPIRES_AT,
            },
          ],
          error: null,
        };
      },
    } as unknown as SupabaseClient;
    const requests: Array<{ url: URL; method: string; body: string }> = [];
    const fetchImpl = (async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: String(init?.body ?? ""),
      });
      if (url.pathname.endsWith("/token")) {
        return Response.json({
          access_token: "short-lived-access-token",
          refresh_token: "long-lived-refresh-token",
        });
      }
      assert.equal(url.pathname, "/v1/userinfo");
      return Response.json({
        sub: "google-account-id",
        email: "calendar-owner@example.com",
        email_verified: true,
      });
    }) as typeof fetch;

    const response = await handleGoogleCalendarOAuthCallbackRequest(
      callbackRequest(),
      { createClient: () => client, environment, fetchImpl },
    );

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "https://app.example/app/settings?section=calendar&google_calendar=selection_required",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(rpcNames, [
      "consume_google_calendar_oauth_state",
      "stage_google_calendar_connection_candidate",
    ]);
    assert.deepEqual(stagedArguments, {
      p_user_id: USER_ID,
      p_google_account_id: "google-account-id",
      p_google_account_email: "calendar-owner@example.com",
      p_refresh_token: "long-lived-refresh-token",
      p_expected_connection_generation: 7,
      p_expected_oauth_attempt_generation: 11,
    });
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["POST", "GET"],
    );
    assert.equal(
      requests.some(({ url }) => url.pathname.includes("calendarList")),
      false,
    );
    assert.equal(
      requests.some(({ url }) => url.pathname.endsWith("/revoke")),
      false,
    );
    const tokenBody = new URLSearchParams(requests[0].body);
    assert.equal(tokenBody.get("code"), "authorization-code");
    assert.equal(tokenBody.get("code_verifier"), "p".repeat(64));
  },
);

Deno.test("callback no revoca la grant si falla el staging", async () => {
  const client = {
    rpc: async (name: string) =>
      name === "consume_google_calendar_oauth_state"
        ? {
            data: [
              {
                user_id: USER_ID,
                code_verifier: "p".repeat(64),
                connection_generation: 7,
                oauth_attempt_generation: 11,
              },
            ],
            error: null,
          }
        : { data: null, error: { message: "private database detail" } },
  } as unknown as SupabaseClient;
  let fetchCalls = 0;
  const fetchImpl = (async (input) => {
    fetchCalls += 1;
    return String(input).endsWith("/token")
      ? Response.json({
          access_token: "short-lived-access-token",
          refresh_token: "same-grant-refresh-token",
        })
      : Response.json({
          sub: "google-account-id",
          email: "calendar-owner@example.com",
          email_verified: true,
        });
  }) as typeof fetch;

  const response = await handleGoogleCalendarOAuthCallbackRequest(
    callbackRequest(),
    { createClient: () => client, environment, fetchImpl },
  );

  assert.equal(response.status, 303);
  assert.equal(fetchCalls, 2);
  assert.equal(
    response.headers.get("location"),
    "https://app.example/app/settings?section=calendar&google_calendar=error",
  );
  assert.equal(
    (response.headers.get("location") ?? "").includes("same-grant"),
    false,
  );
});

Deno.test(
  "callback no anuncia selección si staging devuelve una fila vacía",
  async () => {
    const client = {
      rpc: async (name: string) =>
        name === "consume_google_calendar_oauth_state"
          ? {
              data: [
                {
                  user_id: USER_ID,
                  code_verifier: "p".repeat(64),
                  connection_generation: "7",
                  oauth_attempt_generation: "11",
                },
              ],
              error: null,
            }
          : { data: [], error: null },
    } as unknown as SupabaseClient;
    const fetchImpl = (async (input) =>
      String(input).endsWith("/token")
        ? Response.json({
            access_token: "short-lived-access-token",
            refresh_token: "long-lived-refresh-token",
          })
        : Response.json({
            sub: "google-account-id",
            email: "calendar-owner@example.com",
            email_verified: true,
          })) as typeof fetch;

    const response = await handleGoogleCalendarOAuthCallbackRequest(
      callbackRequest(),
      { createClient: () => client, environment, fetchImpl },
    );

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "https://app.example/app/settings?section=calendar&google_calendar=error",
    );
  },
);

Deno.test("callback consume state antes de tratar una denegación", async () => {
  let rpcCalls = 0;
  const client = {
    rpc: async (name: string) => {
      rpcCalls += 1;
      assert.equal(name, "consume_google_calendar_oauth_state");
      return {
        data: [
          {
            user_id: USER_ID,
            code_verifier: "p".repeat(64),
            connection_generation: 7,
            oauth_attempt_generation: 11,
          },
        ],
        error: null,
      };
    },
  } as unknown as SupabaseClient;
  let fetchCalls = 0;

  const response = await handleGoogleCalendarOAuthCallbackRequest(
    callbackRequest("state=opaque-state&error=access_denied"),
    {
      createClient: () => client,
      environment,
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      }) as typeof fetch,
    },
  );

  assert.equal(response.status, 303);
  assert.equal(rpcCalls, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(
    response.headers.get("location"),
    "https://app.example/app/settings?section=calendar&google_calendar=denied",
  );
});

Deno.test(
  "callback rechaza métodos y configuración incompleta sin tocar DB",
  async () => {
    let clientCreated = false;
    const dependencies: GoogleCalendarOAuthCallbackDependencies = {
      createClient: () => {
        clientCreated = true;
        throw new Error("must not create client");
      },
      environment,
    };
    const methodResponse = await handleGoogleCalendarOAuthCallbackRequest(
      new Request("https://project.example/callback", { method: "POST" }),
      dependencies,
    );
    assert.equal(methodResponse.status, 405);

    const configResponse = await handleGoogleCalendarOAuthCallbackRequest(
      callbackRequest(),
      { ...dependencies, environment: () => undefined },
    );
    assert.equal(configResponse.status, 503);
    assert.equal(configResponse.headers.get("cache-control"), "no-store");
    assert.equal(clientCreated, false);
  },
);
