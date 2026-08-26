import assert from "node:assert/strict";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  type EmbeddedSignupHandlerDependencies,
  handleWhatsAppEmbeddedSignupRequest,
} from "./index.ts";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

function request(
  action = "status",
  origin = "http://localhost:5173",
  payload: Record<string, unknown> = {},
): Request {
  return new Request("http://127.0.0.1/functions/v1/whatsapp-embedded-signup", {
    method: "POST",
    headers: {
      Authorization: "Bearer opaque-user-session",
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({ action, ...payload }),
  });
}

function dependencies(
  role: "ADMIN" | "OPERADOR",
  options: { unauthorized?: boolean } = {},
): EmbeddedSignupHandlerDependencies {
  const client = {
    rpc: async (name: string) => {
      assert.equal(name, "whatsapp_embedded_signup_status");
      return {
        data: {
          onboarding: {
            status: "initiated",
            code_hash: "must-not-cross-http-boundary",
          },
          account: {
            onboardingStatus: "not_started",
            business_access_token: "must-not-cross-http-boundary",
            business_token_secret_id: "must-not-cross-http-boundary",
          },
          app_secret: "must-not-cross-http-boundary",
          sendingPaused: true,
        },
        error: null,
      };
    },
  } as unknown as SupabaseClient;
  return {
    createClient: () => client,
    authorize: async () => {
      if (options.unauthorized) throw new Error("UNAUTHORIZED");
      return { user: { id: ADMIN_ID }, profile: { role } };
    },
  };
}

Deno.test("Embedded Signup rechaza una sesión no autenticada", async () => {
  const response = await handleWhatsAppEmbeddedSignupRequest(
    request(),
    dependencies("ADMIN", { unauthorized: true }),
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "UNAUTHORIZED" });
});

Deno.test(
  "Embedded Signup rechaza OPERADOR antes de procesar acciones",
  async () => {
    const response = await handleWhatsAppEmbeddedSignupRequest(
      request(),
      dependencies("OPERADOR"),
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "ADMIN_REQUIRED" });
  },
);

Deno.test(
  "Embedded Signup intercambia, valida y almacena el token sin devolverlo",
  async () => {
    const environment: Record<string, string> = {
      META_APP_ID: "1234567890",
      META_EMBEDDED_SIGNUP_CONFIG_ID: "9876543210",
      META_APP_SECRET: "server-only-app-secret",
      WHATSAPP_GRAPH_API_VERSION: "v26.0",
      WHATSAPP_EMBEDDED_SIGNUP_ENABLED: "true",
      WHATSAPP_AUTOMATIONS_ENABLED: "false",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "server-only-service-key",
      WHATSAPP_COEXISTENCE_INTERNAL_SECRET: "server-only-internal-secret",
    };
    const previousEnvironment = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(environment)) {
      previousEnvironment.set(name, Deno.env.get(name));
      Deno.env.set(name, value);
    }

    const originalFetch = globalThis.fetch;
    const graphRequests: string[] = [];
    let storedToken = "";
    let postExchangeValidationCalls = 0;
    let preCompletionValidationCalls = 0;
    let preCompletionValidatedAt: unknown = null;
    let debugTokenCalls = 0;
    const attemptId = "22222222-2222-4222-8222-222222222222";
    const validationLease = "33333333-3333-4333-8333-333333333333";
    const wabaId = "1111111111";
    const phoneNumberId = "5555555555";
    const portfolioId = "2222222222";
    const businessToken = "opaque-customer-business-token";

    const client = {
      rpc: async (name: string, parameters: Record<string, unknown>) => {
        if (name === "claim_whatsapp_embedded_signup_code") {
          assert.equal(parameters.p_attempt_id, attemptId);
          return {
            data: [
              {
                attempt_id: attemptId,
                waba_id: wabaId,
                exchange_deadline_at: new Date(
                  Date.now() + 25_000,
                ).toISOString(),
              },
            ],
            error: null,
          };
        }
        if (name === "store_whatsapp_embedded_signup_exchange_token") {
          storedToken = String(parameters.p_business_access_token);
          return { data: true, error: null };
        }
        if (
          name === "record_whatsapp_embedded_signup_post_exchange_validation"
        ) {
          postExchangeValidationCalls += 1;
          assert.equal(parameters.p_attempt_id, attemptId);
          assert.equal(parameters.p_token_is_valid, true);
          assert.equal(parameters.p_token_app_id, environment.META_APP_ID);
          assert.deepEqual(parameters.p_token_target_ids, [wabaId]);
          assert.equal(parameters.p_error_code, null);
          return { data: true, error: null };
        }
        if (name === "record_whatsapp_embedded_signup_session") {
          assert.equal(parameters.p_waba_id, wabaId);
          assert.equal(parameters.p_phone_number_id, phoneNumberId);
          return { data: true, error: null };
        }
        if (
          name === "record_whatsapp_embedded_signup_pre_completion_validation"
        ) {
          preCompletionValidationCalls += 1;
          assert.equal(parameters.p_attempt_id, attemptId);
          assert.equal(parameters.p_validation_lease_token, validationLease);
          assert.equal(parameters.p_token_is_valid, true);
          assert.equal(parameters.p_token_app_id, environment.META_APP_ID);
          assert.deepEqual(parameters.p_token_target_ids, [wabaId]);
          assert.equal(parameters.p_error_code, null);
          preCompletionValidatedAt = parameters.p_token_validated_at;
          return { data: true, error: null };
        }
        if (name === "claim_whatsapp_embedded_signup_validations") {
          assert.equal(storedToken, businessToken);
          return {
            data: [
              {
                attempt_id: attemptId,
                initiated_by: ADMIN_ID,
                validation_lease_token: validationLease,
                business_access_token: storedToken,
                submitted_business_portfolio_id: portfolioId,
                submitted_waba_id: wabaId,
                submitted_phone_number_id: phoneNumberId,
                history_sharing_decision: "declined",
                validation_deadline_at: new Date(
                  Date.now() + 5 * 60_000,
                ).toISOString(),
                validation_attempts: 1,
              },
            ],
            error: null,
          };
        }
        if (name === "complete_whatsapp_embedded_signup") {
          assert.equal(parameters.p_verified_waba_id, wabaId);
          assert.equal(parameters.p_verified_phone_number_id, phoneNumberId);
          assert.equal(parameters.p_validation_lease_token, validationLease);
          assert.equal(
            parameters.p_token_validated_at,
            preCompletionValidatedAt,
          );
          return {
            data: [
              {
                account_id: "44444444-4444-4444-8444-444444444444",
                onboarding_status: "provisioning",
                subscription_status: "pending",
                contacts_status: "pending",
                history_status: "idle",
                sync_deadline_at: new Date(
                  Date.now() + 24 * 60 * 60_000,
                ).toISOString(),
              },
            ],
            error: null,
          };
        }
        throw new Error(`unexpected RPC: ${name}`);
      },
    } as unknown as SupabaseClient;

    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      graphRequests.push(`${init.method ?? "GET"} ${url.pathname}`);
      const response = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.pathname === "/v26.0/oauth/access_token") {
        if (url.searchParams.get("grant_type") === "client_credentials") {
          assert.equal(url.searchParams.has("code"), false);
          return response({ access_token: "ephemeral-app-access-token" });
        }
        assert.equal(url.searchParams.get("code"), "single-use-code");
        assert.equal(init.redirect, "error");
        return response({ access_token: businessToken, token_type: "bearer" });
      }
      if (url.pathname === "/v26.0/debug_token") {
        debugTokenCalls += 1;
        assert.equal(url.searchParams.get("input_token"), businessToken);
        assert.equal(
          new Headers(init.headers).get("authorization"),
          "Bearer ephemeral-app-access-token",
        );
        return response({
          data: {
            is_valid: true,
            app_id: environment.META_APP_ID,
            expires_at: 2_000_000_000,
            scopes: [
              "whatsapp_business_management",
              "whatsapp_business_messaging",
            ],
            granular_scopes: [
              {
                scope: "whatsapp_business_management",
                target_ids: [wabaId],
              },
              {
                scope: "whatsapp_business_messaging",
                target_ids: [wabaId],
              },
            ],
          },
        });
      }
      if (url.pathname === `/v26.0/${wabaId}`) {
        return response({
          id: wabaId,
          owner_business_info: { id: portfolioId },
        });
      }
      if (url.pathname === `/v26.0/${wabaId}/phone_numbers`) {
        return response({
          data: [
            {
              id: phoneNumberId,
              display_phone_number: "+54 11 5555 0000",
              status: "CONNECTED",
            },
          ],
        });
      }
      if (url.pathname === `/v26.0/${phoneNumberId}`) {
        return response({
          id: phoneNumberId,
          display_phone_number: "+54 11 5555 0000",
          is_on_biz_app: true,
          platform_type: "CLOUD_API",
        });
      }
      if (url.pathname === "/functions/v1/process-whatsapp-coexistence") {
        assert.equal(
          new Headers(init.headers).get("x-internal-secret"),
          environment.WHATSAPP_COEXISTENCE_INTERNAL_SECRET,
        );
        return response({ processed: true });
      }
      throw new Error(`unexpected fetch: ${url.origin}${url.pathname}`);
    };

    try {
      const response = await handleWhatsAppEmbeddedSignupRequest(
        request("exchange", "http://localhost:5173", {
          attemptId,
          state: "state-value-123456",
          nonce: "nonce-value-123456",
          code: "single-use-code",
          historyDecision: "declined",
          type: "WA_EMBEDDED_SIGNUP",
          event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
          version: 3,
          businessPortfolioId: portfolioId,
          wabaId,
          phoneNumberId,
          assetIds: {
            adAccountIds: [],
            pageIds: [],
            datasetIds: [],
            catalogIds: [],
            instagramAccountIds: [],
            wabaIds: [wabaId],
          },
        }),
        {
          createClient: () => client,
          authorize: async () => ({
            user: { id: ADMIN_ID },
            profile: { role: "ADMIN" },
          }),
        },
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;
      assert.deepEqual(body, { accepted: true, completed: true });
      const serialized = JSON.stringify(body);
      assert.equal(serialized.includes(businessToken), false);
      assert.equal(serialized.includes("single-use-code"), false);
      assert.equal(
        graphRequests.some((entry) => entry.includes("/messages")),
        false,
      );
      assert.equal(storedToken, businessToken);
      assert.equal(postExchangeValidationCalls, 1);
      assert.equal(preCompletionValidationCalls, 1);
      assert.equal(debugTokenCalls, 2);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    }
  },
);

Deno.test(
  "Embedded Signup rechaza state/nonce inválido antes de Graph",
  async () => {
    const names = [
      "META_APP_ID",
      "META_EMBEDDED_SIGNUP_CONFIG_ID",
      "META_APP_SECRET",
      "WHATSAPP_GRAPH_API_VERSION",
      "WHATSAPP_EMBEDDED_SIGNUP_ENABLED",
    ] as const;
    const values = [
      "1234567890",
      "9876543210",
      "server-only-app-secret",
      "v26.0",
      "true",
    ] as const;
    const previous = names.map((name) => Deno.env.get(name));
    names.forEach((name, index) => Deno.env.set(name, values[index]));
    let graphCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      graphCalls += 1;
      throw new Error("Graph must not be called");
    };
    const client = {
      rpc: async (name: string) => {
        assert.equal(name, "claim_whatsapp_embedded_signup_code");
        return {
          data: null,
          error: { message: "WHATSAPP_EMBEDDED_SIGNUP_STATE_INVALID" },
        };
      },
    } as unknown as SupabaseClient;
    try {
      const response = await handleWhatsAppEmbeddedSignupRequest(
        request("exchange", "http://localhost:5173", {
          attemptId: "22222222-2222-4222-8222-222222222222",
          state: "wrong-state-value",
          nonce: "wrong-nonce-value",
          code: "unused-code",
          historyDecision: "declined",
        }),
        {
          createClient: () => client,
          authorize: async () => ({
            user: { id: ADMIN_ID },
            profile: { role: "ADMIN" },
          }),
        },
      );
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: "WHATSAPP_EMBEDDED_SIGNUP_STATE_INVALID",
      });
      assert.equal(graphCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
      names.forEach((name, index) => {
        const value = previous[index];
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      });
    }
  },
);

Deno.test(
  "auth code antes de FINISH completa el checkpoint post_exchange real",
  async () => {
    const environment: Record<string, string> = {
      META_APP_ID: "1234567890",
      META_EMBEDDED_SIGNUP_CONFIG_ID: "9876543210",
      META_APP_SECRET: "server-only-app-secret",
      WHATSAPP_GRAPH_API_VERSION: "v26.0",
      WHATSAPP_EMBEDDED_SIGNUP_ENABLED: "true",
      WHATSAPP_AUTOMATIONS_ENABLED: "false",
    };
    const previousEnvironment = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(environment)) {
      previousEnvironment.set(name, Deno.env.get(name));
      Deno.env.set(name, value);
    }

    const originalFetch = globalThis.fetch;
    const attemptId = "22222222-2222-4222-8222-222222222222";
    const businessToken = "opaque-customer-business-token";
    const targetWabaId = "1111111111";
    const rpcOrder: string[] = [];
    let debugTokenCalls = 0;
    let graphMessageCalls = 0;
    const client = {
      rpc: async (name: string, parameters: Record<string, unknown>) => {
        rpcOrder.push(name);
        if (name === "claim_whatsapp_embedded_signup_code") {
          return {
            data: [
              {
                attempt_id: attemptId,
                waba_id: null,
                exchange_deadline_at: new Date(
                  Date.now() + 25_000,
                ).toISOString(),
              },
            ],
            error: null,
          };
        }
        if (name === "store_whatsapp_embedded_signup_exchange_token") {
          assert.equal(parameters.p_business_access_token, businessToken);
          return { data: true, error: null };
        }
        if (
          name === "record_whatsapp_embedded_signup_post_exchange_validation"
        ) {
          assert.equal(parameters.p_token_is_valid, true);
          assert.deepEqual(parameters.p_token_target_ids, [targetWabaId]);
          assert.equal(parameters.p_error_code, null);
          return { data: true, error: null };
        }
        if (name === "claim_whatsapp_embedded_signup_validations") {
          return { data: [], error: null };
        }
        throw new Error(`unexpected RPC: ${name}`);
      },
    } as unknown as SupabaseClient;

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/messages")) graphMessageCalls += 1;
      const response = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.pathname === "/v26.0/oauth/access_token") {
        if (url.searchParams.get("grant_type") === "client_credentials") {
          return response({ access_token: "ephemeral-app-access-token" });
        }
        return response({ access_token: businessToken, token_type: "bearer" });
      }
      if (url.pathname === "/v26.0/debug_token") {
        debugTokenCalls += 1;
        return response({
          data: {
            is_valid: true,
            app_id: environment.META_APP_ID,
            scopes: [
              "whatsapp_business_management",
              "whatsapp_business_messaging",
            ],
            granular_scopes: [
              {
                scope: "whatsapp_business_management",
                target_ids: [targetWabaId],
              },
              {
                scope: "whatsapp_business_messaging",
                target_ids: [targetWabaId],
              },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch: ${url.origin}${url.pathname}`);
    };

    try {
      const response = await handleWhatsAppEmbeddedSignupRequest(
        request("exchange", "http://localhost:5173", {
          attemptId,
          state: "state-value-123456",
          nonce: "nonce-value-123456",
          code: "single-use-code",
          historyDecision: "declined",
        }),
        {
          createClient: () => client,
          authorize: async () => ({
            user: { id: ADMIN_ID },
            profile: { role: "ADMIN" },
          }),
        },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        accepted: true,
        completed: false,
      });
      assert.deepEqual(rpcOrder, [
        "claim_whatsapp_embedded_signup_code",
        "store_whatsapp_embedded_signup_exchange_token",
        "record_whatsapp_embedded_signup_post_exchange_validation",
        "claim_whatsapp_embedded_signup_validations",
      ]);
      assert.equal(debugTokenCalls, 1);
      assert.equal(graphMessageCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    }
  },
);

Deno.test(
  "Embedded Signup acepta ADMIN y nunca expone credenciales",
  async () => {
    const response = await handleWhatsAppEmbeddedSignupRequest(
      request(),
      dependencies("ADMIN"),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    const serialized = JSON.stringify(body).toLowerCase();
    assert.equal(typeof body.configured, "boolean");
    assert.equal(body.sendingPaused, true);
    assert.equal(serialized.includes("access_token"), false);
    assert.equal(serialized.includes("app_secret"), false);
    assert.equal(serialized.includes("code_hash"), false);
    assert.equal(serialized.includes("must-not-cross-http-boundary"), false);
  },
);

Deno.test(
  "post_exchange con scope faltante persiste is_valid real antes de fallar",
  async () => {
    const environment: Record<string, string> = {
      META_APP_ID: "1234567890",
      META_EMBEDDED_SIGNUP_CONFIG_ID: "9876543210",
      META_APP_SECRET: "server-only-app-secret",
      WHATSAPP_GRAPH_API_VERSION: "v26.0",
      WHATSAPP_EMBEDDED_SIGNUP_ENABLED: "true",
      WHATSAPP_AUTOMATIONS_ENABLED: "false",
    };
    const previousEnvironment = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(environment)) {
      previousEnvironment.set(name, Deno.env.get(name));
      Deno.env.set(name, value);
    }
    const originalFetch = globalThis.fetch;
    const attemptId = "22222222-2222-4222-8222-222222222222";
    const businessToken = "opaque-invalid-customer-business-token";
    let invalidMetadataPersisted = false;
    let failedAttempt = false;
    const client = {
      rpc: async (name: string, parameters: Record<string, unknown>) => {
        if (name === "claim_whatsapp_embedded_signup_code") {
          return {
            data: [
              {
                attempt_id: attemptId,
                waba_id: null,
                exchange_deadline_at: new Date(
                  Date.now() + 25_000,
                ).toISOString(),
              },
            ],
            error: null,
          };
        }
        if (name === "store_whatsapp_embedded_signup_exchange_token") {
          assert.equal(parameters.p_business_access_token, businessToken);
          return { data: true, error: null };
        }
        if (
          name === "record_whatsapp_embedded_signup_post_exchange_validation"
        ) {
          assert.equal(parameters.p_token_is_valid, true);
          assert.equal(parameters.p_token_app_id, environment.META_APP_ID);
          assert.deepEqual(parameters.p_token_scopes, [
            "whatsapp_business_management",
          ]);
          assert.deepEqual(parameters.p_token_target_ids, ["1111111111"]);
          assert.equal(parameters.p_error_code, "BUSINESS_TOKEN_SCOPE_MISSING");
          invalidMetadataPersisted = true;
          return { data: true, error: null };
        }
        if (name === "fail_whatsapp_embedded_signup_attempt") {
          assert.equal(parameters.p_error_code, "BUSINESS_TOKEN_SCOPE_MISSING");
          failedAttempt = true;
          return { data: true, error: null };
        }
        throw new Error(`unexpected RPC: ${name}`);
      },
    } as unknown as SupabaseClient;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const response = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.pathname === "/v26.0/oauth/access_token") {
        if (url.searchParams.get("grant_type") === "client_credentials") {
          return response({ access_token: "ephemeral-app-access-token" });
        }
        return response({ access_token: businessToken, token_type: "bearer" });
      }
      if (url.pathname === "/v26.0/debug_token") {
        return response({
          data: {
            is_valid: true,
            app_id: environment.META_APP_ID,
            scopes: ["whatsapp_business_management"],
            granular_scopes: [
              {
                scope: "whatsapp_business_management",
                target_ids: ["1111111111"],
              },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch: ${url.origin}${url.pathname}`);
    };

    try {
      const response = await handleWhatsAppEmbeddedSignupRequest(
        request("exchange", "http://localhost:5173", {
          attemptId,
          state: "state-value-123456",
          nonce: "nonce-value-123456",
          code: "single-use-code",
          historyDecision: "declined",
        }),
        {
          createClient: () => client,
          authorize: async () => ({
            user: { id: ADMIN_ID },
            profile: { role: "ADMIN" },
          }),
        },
      );
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), {
        error: "BUSINESS_TOKEN_SCOPE_MISSING",
      });
      assert.equal(invalidMetadataPersisted, true);
      assert.equal(failedAttempt, true);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    }
  },
);

Deno.test(
  "pre_completion persiste is_valid raw aunque el target WABA cambie y bloquea activos",
  async () => {
    const environment: Record<string, string> = {
      META_APP_ID: "1234567890",
      META_EMBEDDED_SIGNUP_CONFIG_ID: "9876543210",
      META_APP_SECRET: "server-only-app-secret",
      WHATSAPP_GRAPH_API_VERSION: "v26.0",
      WHATSAPP_EMBEDDED_SIGNUP_ENABLED: "true",
      WHATSAPP_AUTOMATIONS_ENABLED: "false",
    };
    const previousEnvironment = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(environment)) {
      previousEnvironment.set(name, Deno.env.get(name));
      Deno.env.set(name, value);
    }
    const originalFetch = globalThis.fetch;
    const attemptId = "22222222-2222-4222-8222-222222222222";
    const validationLease = "33333333-3333-4333-8333-333333333333";
    const wabaId = "1111111111";
    const phoneNumberId = "5555555555";
    const businessToken = "opaque-customer-business-token";
    let debugCalls = 0;
    let assetLookups = 0;
    let rawMetadataPersisted = false;
    const client = {
      rpc: async (name: string, parameters: Record<string, unknown>) => {
        if (name === "claim_whatsapp_embedded_signup_code") {
          return {
            data: [
              {
                attempt_id: attemptId,
                waba_id: wabaId,
                exchange_deadline_at: new Date(
                  Date.now() + 25_000,
                ).toISOString(),
              },
            ],
            error: null,
          };
        }
        if (name === "store_whatsapp_embedded_signup_exchange_token") {
          return { data: true, error: null };
        }
        if (
          name === "record_whatsapp_embedded_signup_post_exchange_validation"
        ) {
          assert.equal(parameters.p_error_code, null);
          return { data: true, error: null };
        }
        if (name === "record_whatsapp_embedded_signup_session") {
          return { data: true, error: null };
        }
        if (name === "claim_whatsapp_embedded_signup_validations") {
          return {
            data: [
              {
                attempt_id: attemptId,
                initiated_by: ADMIN_ID,
                validation_lease_token: validationLease,
                business_access_token: businessToken,
                submitted_business_portfolio_id: null,
                submitted_waba_id: wabaId,
                submitted_phone_number_id: phoneNumberId,
                history_sharing_decision: "declined",
                validation_deadline_at: new Date(
                  Date.now() + 5 * 60_000,
                ).toISOString(),
                validation_attempts: 1,
              },
            ],
            error: null,
          };
        }
        if (
          name === "record_whatsapp_embedded_signup_pre_completion_validation"
        ) {
          assert.equal(parameters.p_token_is_valid, true);
          assert.equal(parameters.p_token_app_id, environment.META_APP_ID);
          assert.deepEqual(parameters.p_token_target_ids, ["9999999999"]);
          assert.equal(parameters.p_error_code, "BUSINESS_TOKEN_WABA_MISMATCH");
          rawMetadataPersisted = true;
          return { data: true, error: null };
        }
        throw new Error(`unexpected RPC: ${name}`);
      },
    } as unknown as SupabaseClient;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const response = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.pathname === "/v26.0/oauth/access_token") {
        return response({
          access_token:
            url.searchParams.get("grant_type") === "client_credentials"
              ? "ephemeral-app-access-token"
              : businessToken,
        });
      }
      if (url.pathname === "/v26.0/debug_token") {
        debugCalls += 1;
        const target = debugCalls === 1 ? wabaId : "9999999999";
        return response({
          data: {
            is_valid: true,
            app_id: environment.META_APP_ID,
            scopes: [
              "whatsapp_business_management",
              "whatsapp_business_messaging",
            ],
            granular_scopes: [
              {
                scope: "whatsapp_business_management",
                target_ids: [target],
              },
              {
                scope: "whatsapp_business_messaging",
                target_ids: [target],
              },
            ],
          },
        });
      }
      assetLookups += 1;
      throw new Error(`asset lookup must not run: ${url.pathname}`);
    };

    try {
      const response = await handleWhatsAppEmbeddedSignupRequest(
        request("exchange", "http://localhost:5173", {
          attemptId,
          state: "state-value-123456",
          nonce: "nonce-value-123456",
          code: "single-use-code",
          historyDecision: "declined",
          type: "WA_EMBEDDED_SIGNUP",
          event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
          version: 3,
          wabaId,
          phoneNumberId,
          assetIds: {
            adAccountIds: [],
            pageIds: [],
            datasetIds: [],
            catalogIds: [],
            instagramAccountIds: [],
            wabaIds: [wabaId],
          },
        }),
        {
          createClient: () => client,
          authorize: async () => ({
            user: { id: ADMIN_ID },
            profile: { role: "ADMIN" },
          }),
        },
      );
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), {
        error: "BUSINESS_TOKEN_WABA_MISMATCH",
      });
      assert.equal(rawMetadataPersisted, true);
      assert.equal(debugCalls, 2);
      assert.equal(assetLookups, 0);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    }
  },
);

Deno.test(
  "Embedded Signup falla cerrado ante un Origin no autorizado",
  async () => {
    let authorizationCalls = 0;
    const deps = dependencies("ADMIN");
    deps.authorize = async () => {
      authorizationCalls += 1;
      return { user: { id: ADMIN_ID }, profile: { role: "ADMIN" } };
    };
    const response = await handleWhatsAppEmbeddedSignupRequest(
      request("status", "https://attacker.example"),
      deps,
    );
    assert.equal(response.status, 403);
    assert.equal(authorizationCalls, 0);
    assert.deepEqual(await response.json(), { error: "ORIGIN_NOT_ALLOWED" });
  },
);

Deno.test(
  "status expone data-access-only como vencimiento efectivo sin secretos",
  async () => {
    const dataAccessExpiry = "2026-09-30T12:00:00Z";
    const client = {
      rpc: async (name: string) => {
        assert.equal(name, "whatsapp_embedded_signup_status");
        return {
          data: {
            account: {
              accountId: "44444444-4444-4444-8444-444444444444",
              tokenExpiresAt: null,
              tokenDataAccessExpiresAt: dataAccessExpiry,
              tokenExpired: false,
              business_access_token: "must-not-cross-http-boundary",
              business_token_secret_id: "55555555-5555-4555-8555-555555555555",
            },
            sendingPaused: true,
          },
          error: null,
        };
      },
    } as unknown as SupabaseClient;
    const response = await handleWhatsAppEmbeddedSignupRequest(request(), {
      createClient: () => client,
      authorize: async () => ({
        user: { id: ADMIN_ID },
        profile: { role: "ADMIN" },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.account.tokenExpiresAt, null);
    assert.equal(
      body.account.tokenDataAccessExpiresAt,
      "2026-09-30T12:00:00.000Z",
    );
    assert.equal(
      body.account.tokenEffectiveExpiresAt,
      "2026-09-30T12:00:00.000Z",
    );
    assert.equal(JSON.stringify(body).includes("must-not-cross"), false);
    assert.equal(JSON.stringify(body).includes("55555555-5555"), false);
  },
);

Deno.test(
  "Embedded Signup deshabilitado rechaza START antes de DB o Graph",
  async () => {
    const previous = Deno.env.get("WHATSAPP_EMBEDDED_SIGNUP_ENABLED");
    Deno.env.set("WHATSAPP_EMBEDDED_SIGNUP_ENABLED", "false");
    let rpcCalls = 0;
    let graphCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      graphCalls += 1;
      throw new Error("Graph must not be called");
    };
    const client = {
      rpc: async () => {
        rpcCalls += 1;
        throw new Error("DB must not be called");
      },
    } as unknown as SupabaseClient;
    try {
      const response = await handleWhatsAppEmbeddedSignupRequest(
        request("start", "http://localhost:5173", {
          historyDecision: "declined",
        }),
        {
          createClient: () => client,
          authorize: async () => ({
            user: { id: ADMIN_ID },
            profile: { role: "ADMIN" },
          }),
        },
      );
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), {
        error: "WHATSAPP_EMBEDDED_SIGNUP_DISABLED",
      });
      assert.equal(rpcCalls, 0);
      assert.equal(graphCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
      if (previous === undefined)
        Deno.env.delete("WHATSAPP_EMBEDDED_SIGNUP_ENABLED");
      else Deno.env.set("WHATSAPP_EMBEDDED_SIGNUP_ENABLED", previous);
    }
  },
);

Deno.test(
  "Embedded Signup no inicia con automatizaciones habilitadas",
  async () => {
    const previous = Deno.env.get("WHATSAPP_AUTOMATIONS_ENABLED");
    const previousFeature = Deno.env.get("WHATSAPP_EMBEDDED_SIGNUP_ENABLED");
    Deno.env.set("WHATSAPP_AUTOMATIONS_ENABLED", "true");
    Deno.env.set("WHATSAPP_EMBEDDED_SIGNUP_ENABLED", "true");
    try {
      const response = await handleWhatsAppEmbeddedSignupRequest(
        request("start"),
        dependencies("ADMIN"),
      );
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: "WHATSAPP_AUTOMATIONS_MUST_BE_DISABLED",
      });
    } finally {
      if (previous === undefined)
        Deno.env.delete("WHATSAPP_AUTOMATIONS_ENABLED");
      else Deno.env.set("WHATSAPP_AUTOMATIONS_ENABLED", previous);
      if (previousFeature === undefined)
        Deno.env.delete("WHATSAPP_EMBEDDED_SIGNUP_ENABLED");
      else Deno.env.set("WHATSAPP_EMBEDDED_SIGNUP_ENABLED", previousFeature);
    }
  },
);
