import assert from "node:assert/strict";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  finalizeLocalOffboardingForInvalidCredential,
  type OnboardingGraphOperations,
  type OnboardingJob,
  persistOnboardingJobFailure,
  processEmbeddedSignupValidation,
  processOnboardingJob,
  shouldRetryEmbeddedSignupValidation,
  type EmbeddedSignupValidationJob,
} from "./index.ts";
import {
  type EmbeddedSignupConfiguration,
  MetaEmbeddedSignupError,
} from "../_shared/whatsapp-embedded-signup.ts";
import { WhatsAppCredentialResolutionError } from "../_shared/whatsapp-account-credentials.ts";

const configuration: EmbeddedSignupConfiguration = {
  appId: "1234567890",
  configurationId: "9876543210",
  appSecret: "server-only-app-secret",
  apiVersion: "v26.0",
};
Deno.env.set("WHATSAPP_GRAPH_API_VERSION", configuration.apiVersion);

const baseJob: OnboardingJob = {
  id: "11111111-1111-4111-8111-111111111111",
  account_id: "22222222-2222-4222-8222-222222222222",
  token_generation: 4,
  operation: "request_contacts_sync",
  deadline_at: "2099-01-01T00:00:00.000Z",
  lease_token: "33333333-3333-4333-8333-333333333333",
};

const credentials = {
  credential_mode: "coexistence",
  account_id: baseJob.account_id,
  waba_id: "5555555555",
  phone_number_id: "6666666666",
  business_access_token: "opaque-customer-token",
  token_generation: baseJob.token_generation,
  coexistence_status: "active",
  onboarding_status: "completed",
  app_subscription_status: "subscribed",
  business_token_status: "active",
  business_token_validation_status: "valid",
  sending_paused: false,
};

const embeddedValidationJob: EmbeddedSignupValidationJob = {
  attempt_id: "44444444-4444-4444-8444-444444444444",
  initiated_by: "55555555-5555-4555-8555-555555555555",
  validation_lease_token: "66666666-6666-4666-8666-666666666666",
  business_access_token: "embedded-business-token",
  submitted_business_portfolio_id: "7777777777",
  submitted_waba_id: "8888888888",
  submitted_phone_number_id: "9999999999",
  history_sharing_decision: "declined",
  validation_deadline_at: "2099-01-01T00:00:00.000Z",
  validation_attempts: 1,
};

function metaJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function configureEmbeddedSignupEnvironment(): void {
  Deno.env.set("META_APP_ID", configuration.appId);
  Deno.env.set("META_EMBEDDED_SIGNUP_CONFIG_ID", configuration.configurationId);
  Deno.env.set("META_APP_SECRET", configuration.appSecret);
  Deno.env.set("WHATSAPP_GRAPH_API_VERSION", configuration.apiVersion);
}

Deno.test(
  "processor respeta la clasificación Graph al validar el token",
  () => {
    assert.equal(
      shouldRetryEmbeddedSignupValidation(
        new MetaEmbeddedSignupError("TOKEN_DEBUG_CREDENTIAL_INVALID", {
          status: 502,
          credentialInvalid: true,
        }),
      ),
      false,
    );
    assert.equal(
      shouldRetryEmbeddedSignupValidation(
        new MetaEmbeddedSignupError("TOKEN_DEBUG_REJECTED", {
          status: 502,
          retryable: true,
        }),
      ),
      true,
    );
    assert.equal(
      shouldRetryEmbeddedSignupValidation(
        new MetaEmbeddedSignupError("TOKEN_DEBUG_NETWORK_ERROR", {
          status: 502,
          retryable: true,
          outcomeUnknown: true,
        }),
      ),
      false,
    );
  },
);

Deno.test(
  "recovery persiste el segundo debug_token antes de validar activos y completa sin un tercer debug",
  async () => {
    configureEmbeddedSignupEnvironment();
    const originalFetch = globalThis.fetch;
    const graphPaths: string[] = [];
    const rpcOrder: string[] = [];
    let preCompletionParameters: Record<string, unknown> | null = null;
    let completionParameters: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      graphPaths.push(url.pathname);
      if (url.pathname === "/v26.0/oauth/access_token") {
        assert.equal(url.searchParams.get("grant_type"), "client_credentials");
        return metaJson({ access_token: "ephemeral-app-token" });
      }
      if (url.pathname === "/v26.0/debug_token") {
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer ephemeral-app-token",
        );
        return metaJson({
          data: {
            is_valid: true,
            app_id: configuration.appId,
            scopes: [
              "whatsapp_business_management",
              "whatsapp_business_messaging",
            ],
            granular_scopes: [
              {
                scope: "whatsapp_business_management",
                target_ids: [embeddedValidationJob.submitted_waba_id],
              },
              {
                scope: "whatsapp_business_messaging",
                target_ids: [embeddedValidationJob.submitted_waba_id],
              },
            ],
            expires_at: 4_102_444_800,
            data_access_expires_at: 4_102_444_800,
          },
        });
      }
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        `Bearer ${embeddedValidationJob.business_access_token}`,
      );
      if (
        url.pathname === `/v26.0/${embeddedValidationJob.submitted_waba_id}`
      ) {
        return metaJson({
          id: embeddedValidationJob.submitted_waba_id,
          owner_business_info: {
            id: embeddedValidationJob.submitted_business_portfolio_id,
          },
        });
      }
      if (
        url.pathname ===
        `/v26.0/${embeddedValidationJob.submitted_waba_id}/phone_numbers`
      ) {
        return metaJson({
          data: [{ id: embeddedValidationJob.submitted_phone_number_id }],
        });
      }
      if (
        url.pathname ===
        `/v26.0/${embeddedValidationJob.submitted_phone_number_id}`
      ) {
        return metaJson({
          id: embeddedValidationJob.submitted_phone_number_id,
          display_phone_number: "+5491112345678",
          is_on_biz_app: true,
          platform_type: "CLOUD_API",
        });
      }
      throw new Error(`unexpected Graph request: ${url.pathname}`);
    }) as typeof fetch;

    const client = {
      rpc: async (name: string, parameters: Record<string, unknown>) => {
        rpcOrder.push(name);
        if (
          name === "record_whatsapp_embedded_signup_pre_completion_validation"
        ) {
          preCompletionParameters = parameters;
          return { data: true, error: null };
        }
        if (name === "complete_whatsapp_embedded_signup") {
          completionParameters = parameters;
          return {
            data: [{ account_id: baseJob.account_id }],
            error: null,
          };
        }
        throw new Error(`unexpected RPC: ${name}`);
      },
    } as unknown as SupabaseClient;

    try {
      assert.equal(
        await processEmbeddedSignupValidation(client, embeddedValidationJob),
        "completed",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(rpcOrder, [
      "record_whatsapp_embedded_signup_pre_completion_validation",
      "complete_whatsapp_embedded_signup",
    ]);
    const recorded = preCompletionParameters as unknown as Record<
      string,
      unknown
    >;
    assert.equal(recorded.p_token_is_valid, true);
    assert.equal(recorded.p_error_code, null);
    assert.equal(recorded.p_token_app_id, configuration.appId);
    const completed = completionParameters as unknown as Record<
      string,
      unknown
    >;
    assert.equal(completed.p_token_validated_at, recorded.p_token_validated_at);
    assert.equal(
      graphPaths.filter((path) => path === "/v26.0/debug_token").length,
      1,
    );
    assert.equal(
      graphPaths.some((path) => path.endsWith("/messages")),
      false,
    );
  },
);

Deno.test(
  "recovery conserva is_valid raw y terminaliza un WABA target ajeno antes de cualquier asset lookup",
  async () => {
    configureEmbeddedSignupEnvironment();
    const originalFetch = globalThis.fetch;
    const graphPaths: string[] = [];
    let recorded: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      graphPaths.push(url.pathname);
      if (url.pathname === "/v26.0/oauth/access_token") {
        return metaJson({ access_token: "ephemeral-app-token" });
      }
      if (url.pathname === "/v26.0/debug_token") {
        return metaJson({
          data: {
            is_valid: true,
            app_id: configuration.appId,
            scopes: [
              "whatsapp_business_management",
              "whatsapp_business_messaging",
            ],
            granular_scopes: [
              {
                scope: "whatsapp_business_management",
                target_ids: ["1234500000"],
              },
              {
                scope: "whatsapp_business_messaging",
                target_ids: ["1234500000"],
              },
            ],
            expires_at: 4_102_444_800,
          },
        });
      }
      throw new Error(`asset lookup must not run: ${url.pathname}`);
    }) as typeof fetch;
    const client = {
      rpc: async (name: string, parameters: Record<string, unknown>) => {
        assert.equal(
          name,
          "record_whatsapp_embedded_signup_pre_completion_validation",
        );
        recorded = parameters;
        return { data: true, error: null };
      },
    } as unknown as SupabaseClient;

    try {
      assert.equal(
        await processEmbeddedSignupValidation(client, embeddedValidationJob),
        "rejected",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    const persisted = recorded as unknown as Record<string, unknown>;
    assert.equal(persisted.p_token_is_valid, true);
    assert.equal(persisted.p_error_code, "BUSINESS_TOKEN_WABA_MISMATCH");
    assert.deepEqual(graphPaths, [
      "/v26.0/oauth/access_token",
      "/v26.0/debug_token",
    ]);
  },
);

function unusedGraphOperation(name: string): never {
  throw new Error(`unexpected Graph operation: ${name}`);
}

function graphOperations(
  requestSync: OnboardingGraphOperations["requestSync"],
): OnboardingGraphOperations {
  return {
    configuration: () => configuration,
    ensureSubscribed: async () => unusedGraphOperation("subscribe"),
    requestSync,
    unsubscribe: async () => unusedGraphOperation("unsubscribe"),
    now: () => Date.parse("2026-08-26T12:00:00.000Z"),
  };
}

Deno.test(
  "processor realiza una sola solicitud de contacts y completa el outbox",
  async () => {
    let graphCalls = 0;
    let completionParameters: Record<string, unknown> | null = null;
    const client = {
      rpc: async (name: string, parameters: Record<string, unknown>) => {
        if (name === "resolve_whatsapp_account_credentials") {
          assert.deepEqual(parameters, {
            p_purpose: "onboarding",
            p_account_id: baseJob.account_id,
            p_waba_id: null,
            p_phone_number_id: null,
            p_conversation_id: null,
            p_expected_token_generation: baseJob.token_generation,
          });
          return { data: [credentials], error: null };
        }
        if (name === "complete_whatsapp_onboarding_job") {
          completionParameters = parameters;
          return { data: true, error: null };
        }
        throw new Error(`unexpected RPC: ${name}`);
      },
    } as unknown as SupabaseClient;

    await processOnboardingJob(
      client,
      baseJob,
      graphOperations(async (input) => {
        graphCalls += 1;
        assert.equal(input.phoneNumberId, credentials.phone_number_id);
        assert.equal(input.businessToken, credentials.business_access_token);
        assert.equal(input.syncType, "smb_app_state_sync");
        return { requestId: "meta-request-1", messagingProduct: "whatsapp" };
      }),
    );

    assert.equal(graphCalls, 1);
    assert.deepEqual(completionParameters, {
      p_job_id: baseJob.id,
      p_lease_token: baseJob.lease_token,
      p_remote_request_id: "meta-request-1",
      p_completion_reason: "remote_confirmed",
    });
  },
);

Deno.test(
  "processor suscribe la WABA y registra confirmación remota",
  async () => {
    let graphCalls = 0;
    let completionParameters: Record<string, unknown> | null = null;
    const client = {
      rpc: async (name: string, parameters: Record<string, unknown>) => {
        if (name === "resolve_whatsapp_account_credentials") {
          return { data: [credentials], error: null };
        }
        if (name === "complete_whatsapp_onboarding_job") {
          completionParameters = parameters;
          return { data: true, error: null };
        }
        throw new Error(`unexpected RPC: ${name}`);
      },
    } as unknown as SupabaseClient;
    const graph = graphOperations(async () => unusedGraphOperation("sync"));
    graph.ensureSubscribed = async (input) => {
      graphCalls += 1;
      assert.equal(input.wabaId, credentials.waba_id);
      assert.equal(input.businessToken, credentials.business_access_token);
      return { alreadySubscribed: false };
    };

    await processOnboardingJob(
      client,
      { ...baseJob, operation: "subscribe_app", deadline_at: null },
      graph,
    );

    assert.equal(graphCalls, 1);
    assert.deepEqual(completionParameters, {
      p_job_id: baseJob.id,
      p_lease_token: baseJob.lease_token,
      p_remote_request_id: null,
      p_completion_reason: "remote_confirmed",
    });
  },
);

Deno.test(
  "auth 190 en subscribed_apps o smb_app_data marca la generación exacta",
  async () => {
    for (const operation of [
      "subscribe_app",
      "request_contacts_sync",
    ] as const) {
      let attentionParameters: Record<string, unknown> | null = null;
      const client = {
        rpc: async (name: string, parameters: Record<string, unknown>) => {
          if (name === "resolve_whatsapp_account_credentials") {
            return { data: [credentials], error: null };
          }
          if (name === "mark_whatsapp_business_token_attention_required") {
            attentionParameters = parameters;
            return { data: true, error: null };
          }
          throw new Error(`unexpected RPC: ${name}`);
        },
      } as unknown as SupabaseClient;
      const graph = graphOperations(async () => {
        throw new MetaEmbeddedSignupError("APP_DATA_SYNC_CREDENTIAL_INVALID", {
          status: 502,
          credentialInvalid: true,
        });
      });
      graph.ensureSubscribed = async () => {
        throw new MetaEmbeddedSignupError(
          "SUBSCRIBED_APPS_LOOKUP_CREDENTIAL_INVALID",
          { status: 502, credentialInvalid: true },
        );
      };

      await assert.rejects(
        () =>
          processOnboardingJob(
            client,
            {
              ...baseJob,
              operation,
              deadline_at:
                operation === "subscribe_app" ? null : baseJob.deadline_at,
            },
            graph,
          ),
        (error: unknown) => {
          assert.ok(error instanceof MetaEmbeddedSignupError);
          assert.equal(error.credentialInvalid, true);
          return true;
        },
      );
      const capturedAttention = attentionParameters as unknown as Record<
        string,
        unknown
      >;
      assert.deepEqual(capturedAttention, {
        p_account_id: baseJob.account_id,
        p_expected_token_generation: baseJob.token_generation,
        p_token_status: "unknown",
        p_error_code: "META_AUTHENTICATION_FAILED",
        p_observed_at: capturedAttention.p_observed_at,
      });
      assert.equal(typeof capturedAttention.p_observed_at, "string");
      assert.equal(
        JSON.stringify(attentionParameters).includes(
          credentials.business_access_token,
        ),
        false,
      );
    }
  },
);

Deno.test(
  "processor falla cerrado antes de Graph si vence la ventana de sync",
  async () => {
    let graphCalls = 0;
    const client = {
      rpc: async (name: string) => {
        if (name === "resolve_whatsapp_account_credentials") {
          return { data: [credentials], error: null };
        }
        throw new Error(`unexpected RPC: ${name}`);
      },
    } as unknown as SupabaseClient;
    const graph = graphOperations(async () => {
      graphCalls += 1;
      return { requestId: "must-not-run", messagingProduct: "whatsapp" };
    });

    await assert.rejects(
      () =>
        processOnboardingJob(
          client,
          {
            ...baseJob,
            deadline_at: "2026-08-26T12:01:00.000Z",
          },
          graph,
        ),
      (error: unknown) => {
        assert.ok(error instanceof MetaEmbeddedSignupError);
        assert.equal(error.code, "SYNC_WINDOW_TOO_CLOSE");
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(graphCalls, 0);
  },
);

Deno.test(
  "processor persiste un sync ambiguo sin reintento ciego",
  async () => {
    let graphCalls = 0;
    let failureParameters: Record<string, unknown> | null = null;
    const client = {
      rpc: async (name: string, parameters: Record<string, unknown>) => {
        if (name === "resolve_whatsapp_account_credentials") {
          return { data: [credentials], error: null };
        }
        if (name === "fail_whatsapp_onboarding_job") {
          failureParameters = parameters;
          return { data: true, error: null };
        }
        throw new Error(`unexpected RPC: ${name}`);
      },
    } as unknown as SupabaseClient;
    const outcomeUnknown = new MetaEmbeddedSignupError(
      "META_GRAPH_APP_DATA_SYNC_OUTCOME_UNKNOWN",
      { status: 504, retryable: true, outcomeUnknown: true },
    );

    let captured: unknown;
    try {
      await processOnboardingJob(
        client,
        { ...baseJob, operation: "request_history_sync" },
        graphOperations(async () => {
          graphCalls += 1;
          throw outcomeUnknown;
        }),
      );
    } catch (error) {
      captured = error;
    }
    assert.equal(captured, outcomeUnknown);
    await persistOnboardingJobFailure(
      client,
      { ...baseJob, operation: "request_history_sync" },
      captured,
    );

    assert.equal(graphCalls, 1);
    assert.deepEqual(failureParameters, {
      p_job_id: baseJob.id,
      p_lease_token: baseJob.lease_token,
      p_error_code: "META_GRAPH_APP_DATA_SYNC_OUTCOME_UNKNOWN",
      p_outcome: "ambiguous",
      p_retryable: false,
    });
  },
);

Deno.test(
  "outbox reencola validación pendiente o transporte pero terminaliza identidad obsoleta",
  async () => {
    for (const [error, expectedRetryable] of [
      [
        new WhatsAppCredentialResolutionError(
          "WHATSAPP_CREDENTIAL_VALIDATION_PENDING",
          { retryable: true },
        ),
        true,
      ],
      [
        new WhatsAppCredentialResolutionError(
          "WHATSAPP_CREDENTIAL_RESOLUTION_FAILED",
          { retryable: true },
        ),
        true,
      ],
      [
        new WhatsAppCredentialResolutionError(
          "WHATSAPP_BUSINESS_CREDENTIAL_GENERATION_STALE",
        ),
        false,
      ],
    ] as const) {
      let failureParameters: Record<string, unknown> | null = null;
      const client = {
        rpc: async (name: string, parameters: Record<string, unknown>) => {
          assert.equal(name, "fail_whatsapp_onboarding_job");
          failureParameters = parameters;
          return { data: true, error: null };
        },
      } as unknown as SupabaseClient;

      await persistOnboardingJobFailure(client, baseJob, error);
      const persisted = failureParameters as unknown as Record<string, unknown>;
      assert.equal(persisted.p_error_code, error.code);
      assert.equal(persisted.p_retryable, expectedRetryable);
      assert.equal(persisted.p_outcome, "definitive");
    }
  },
);

Deno.test(
  "processor finaliza localmente el offboarding si la credencial expiró",
  async () => {
    const unsubscribeJob: OnboardingJob = {
      ...baseJob,
      operation: "unsubscribe_app",
      deadline_at: null,
    };
    let localFinalizationParameters: Record<string, unknown> | null = null;
    const client = {
      rpc: async (name: string, parameters: Record<string, unknown>) => {
        if (name === "resolve_whatsapp_account_credentials") {
          return {
            data: [
              {
                ...credentials,
                coexistence_status: "paused",
                onboarding_status: "offboarding",
                app_subscription_status: "unsubscribing",
                business_token_status: "expired",
                business_token_validation_status: "expired",
                sending_paused: true,
              },
            ],
            error: null,
          };
        }
        if (name === "mark_whatsapp_business_token_attention_required") {
          return { data: true, error: null };
        }
        if (name === "finalize_whatsapp_coexistence_local_offboarding") {
          localFinalizationParameters = parameters;
          return { data: true, error: null };
        }
        throw new Error(`unexpected RPC: ${name}`);
      },
    } as unknown as SupabaseClient;

    let captured: unknown;
    const graph = graphOperations(async () => unusedGraphOperation("sync"));
    graph.unsubscribe = async () => {
      throw new MetaEmbeddedSignupError(
        "WHATSAPP_BUSINESS_CREDENTIAL_EXPIRED",
        { status: 401, credentialInvalid: true },
      );
    };
    try {
      await processOnboardingJob(client, unsubscribeJob, graph);
    } catch (error) {
      captured = error;
    }
    assert.ok(captured instanceof MetaEmbeddedSignupError);
    assert.equal(captured.credentialInvalid, true);
    assert.equal(
      await finalizeLocalOffboardingForInvalidCredential(
        client,
        unsubscribeJob,
        captured,
      ),
      true,
    );
    assert.deepEqual(localFinalizationParameters, {
      p_job_id: unsubscribeJob.id,
      p_lease_token: unsubscribeJob.lease_token,
      p_reason: "TOKEN_EXPIRED",
    });
  },
);
