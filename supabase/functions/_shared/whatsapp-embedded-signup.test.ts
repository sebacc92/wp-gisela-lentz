import assert from "node:assert/strict";
import test from "node:test";
import {
  canStartOnboardingGraphJob,
  classifyEmbeddedSignupCompletionFailure,
  EMBEDDED_SIGNUP_CODE_LIFETIME_MS,
  type EmbeddedSignupConfiguration,
  embeddedSignupConfiguration,
  ensureAppSubscribed,
  exchangeEmbeddedSignupCode,
  MetaEmbeddedSignupError,
  type MetaFetch,
  requestAppDataSync,
  unsubscribeApp,
  validateWhatsAppAssets,
} from "./whatsapp-embedded-signup.ts";

const config: EmbeddedSignupConfiguration = {
  appId: "1234567890",
  configurationId: "9876543210",
  appSecret: "server-app-secret",
  apiVersion: "v26.0",
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface ScriptedFetchStep {
  method?: string;
  path: string;
  response: unknown;
  status?: number;
  inspect?: (url: URL, init: RequestInit) => void;
}

function scriptedFetch(steps: ScriptedFetchStep[]): {
  fetch: MetaFetch;
  requests: string[];
} {
  const requests: string[] = [];
  const fetch: MetaFetch = async (input, init = {}) => {
    const step = steps.shift();
    assert.ok(step, "unexpected Graph request");
    const url = new URL(String(input));
    requests.push(`${init.method ?? "GET"} ${url.pathname}`);
    assert.equal(url.origin, "https://graph.facebook.com");
    assert.equal(url.pathname, step.path);
    assert.equal(init.method ?? "GET", step.method ?? "GET");
    step.inspect?.(url, init);
    return json(step.response, step.status);
  };
  return { fetch, requests };
}

function validatedAssetsSteps(phoneId = "5555555555"): ScriptedFetchStep[] {
  return [
    {
      path: "/v26.0/oauth/access_token",
      response: { access_token: "ephemeral-app-access-token" },
      inspect: (url: URL) => {
        assert.equal(url.searchParams.get("client_id"), config.appId);
        assert.equal(url.searchParams.get("client_secret"), config.appSecret);
        assert.equal(url.searchParams.get("grant_type"), "client_credentials");
        assert.equal(url.searchParams.has("code"), false);
      },
    },
    {
      path: "/v26.0/debug_token",
      response: {
        data: {
          is_valid: true,
          app_id: config.appId,
          expires_at: 1_900_000_000,
          data_access_expires_at: 1_800_000_000,
          scopes: [
            "whatsapp_business_management",
            "whatsapp_business_messaging",
          ],
          granular_scopes: [
            {
              scope: "whatsapp_business_management",
              target_ids: ["1111111111"],
            },
            {
              scope: "whatsapp_business_messaging",
              target_ids: ["1111111111"],
            },
          ],
        },
      },
      inspect: (url: URL, init: RequestInit) => {
        assert.equal(url.searchParams.get("input_token"), "business-token");
        assert.equal(
          new Headers(init.headers).get("authorization"),
          "Bearer ephemeral-app-access-token",
        );
      },
    },
    {
      path: "/v26.0/1111111111",
      response: {
        id: "1111111111",
        owner_business_info: { id: "2222222222", name: "Dental" },
      },
    },
    {
      path: "/v26.0/1111111111/phone_numbers",
      response: {
        data: [{ id: phoneId, display_phone_number: "+54 11 5555 0000" }],
      },
    },
    {
      path: `/v26.0/${phoneId}`,
      response: {
        id: phoneId,
        display_phone_number: "+54 11 5555 0000",
        is_on_biz_app: true,
        platform_type: "CLOUD_API",
      },
    },
  ];
}

test("validates public/server Embedded Signup configuration", () => {
  const values: Record<string, string> = {
    META_APP_ID: config.appId,
    META_EMBEDDED_SIGNUP_CONFIG_ID: config.configurationId,
    META_APP_SECRET: config.appSecret,
    WHATSAPP_GRAPH_API_VERSION: config.apiVersion,
  };
  assert.deepEqual(
    embeddedSignupConfiguration((name) => values[name]),
    config,
  );
  assert.throws(
    () =>
      embeddedSignupConfiguration((name) =>
        name === "META_APP_ID" ? "not-an-id" : values[name],
      ),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "META_APP_ID_INVALID",
  );
});

test("does not retry deterministic SQL completion rejections", () => {
  assert.deepEqual(
    classifyEmbeddedSignupCompletionFailure({
      message: "P0001: WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW",
    }),
    {
      code: "WHATSAPP_HISTORY_REONBOARD_REQUIRES_REVIEW",
      retryable: false,
      status: 409,
    },
  );
  assert.deepEqual(
    classifyEmbeddedSignupCompletionFailure({
      message: "upstream connection closed",
    }),
    {
      code: "WHATSAPP_EMBEDDED_SIGNUP_COMPLETION_FAILED",
      retryable: true,
      status: 500,
    },
  );
});

test("fails closed before the 24-hour sync deadline is too close", () => {
  const now = Date.parse("2026-08-26T12:00:00.000Z");
  assert.equal(canStartOnboardingGraphJob(null, now), true);
  assert.equal(
    canStartOnboardingGraphJob("2026-08-26T12:02:00.001Z", now),
    true,
  );
  assert.equal(
    canStartOnboardingGraphJob("2026-08-26T12:02:00.000Z", now),
    false,
  );
  assert.equal(canStartOnboardingGraphJob("invalid", now), false);
});

test("exchanges a code immediately without putting it in an error", async () => {
  const receivedAtMs = 10_000;
  const scripted = scriptedFetch([
    {
      path: "/v26.0/oauth/access_token",
      response: {
        access_token: "business-token",
        token_type: "bearer",
        expires_in: 3600,
      },
      inspect: (url, init) => {
        assert.equal(url.searchParams.get("client_id"), config.appId);
        assert.equal(url.searchParams.get("client_secret"), config.appSecret);
        assert.equal(url.searchParams.get("code"), "one-use-code");
        assert.equal(init.redirect, "error");
      },
    },
  ]);
  assert.deepEqual(
    await exchangeEmbeddedSignupCode({
      code: "one-use-code",
      receivedAtMs,
      config,
      fetchImpl: scripted.fetch,
      now: () => receivedAtMs + 100,
    }),
    {
      accessToken: "business-token",
      tokenType: "bearer",
      expiresIn: 3600,
    },
  );
});

test("keeps a token that Graph accepted before a slow response crossed 30 seconds", async () => {
  let clockReads = 0;
  const scripted = scriptedFetch([
    {
      path: "/v26.0/oauth/access_token",
      response: { access_token: "accepted-business-token" },
    },
  ]);
  const token = await exchangeEmbeddedSignupCode({
    code: "accepted-before-expiry",
    receivedAtMs: 1_000,
    config,
    fetchImpl: scripted.fetch,
    now: () => {
      clockReads += 1;
      return clockReads === 1 ? 1_100 : 40_000;
    },
  });
  assert.equal(token.accessToken, "accepted-business-token");
});

test("rejects an expired code before any Graph call", async () => {
  let calls = 0;
  await assert.rejects(
    exchangeEmbeddedSignupCode({
      code: "expired-code",
      receivedAtMs: 1_000,
      config,
      fetchImpl: async () => {
        calls += 1;
        return json({});
      },
      now: () => 1_000 + EMBEDDED_SIGNUP_CODE_LIFETIME_MS,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "EMBEDDED_SIGNUP_CODE_EXPIRED",
  );
  assert.equal(calls, 0);
});

test("aborts a Graph exchange at the remaining code deadline", async () => {
  const receivedAtMs = 1_000;
  await assert.rejects(
    exchangeEmbeddedSignupCode({
      code: "deadline-code",
      receivedAtMs,
      config,
      now: () => receivedAtMs + EMBEDDED_SIGNUP_CODE_LIFETIME_MS - 1,
      fetchImpl: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "TOKEN_EXCHANGE_NETWORK_ERROR" &&
      error.outcomeUnknown &&
      !error.retryable,
  );
});

test("rejects an untrusted future receipt timestamp", async () => {
  let calls = 0;
  await assert.rejects(
    exchangeEmbeddedSignupCode({
      code: "future-code",
      receivedAtMs: 20_000,
      config,
      fetchImpl: async () => {
        calls += 1;
        return json({});
      },
      now: () => 10_000,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "EMBEDDED_SIGNUP_CODE_TIME_INVALID",
  );
  assert.equal(calls, 0);
});

test("maps token exchange failures to a safe error code", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/oauth/access_token",
      status: 400,
      response: { error: { message: "contains provider details" } },
    },
  ]);
  await assert.rejects(
    exchangeEmbeddedSignupCode({
      code: "never-logged-code",
      receivedAtMs: Date.now(),
      config,
      fetchImpl: scripted.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "TOKEN_EXCHANGE_REJECTED" &&
      !error.message.includes("never-logged-code") &&
      !error.message.includes("provider details"),
  );
});

test("classifies Meta OAuth code 190 without exposing provider details", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/1111111111/subscribed_apps",
      status: 400,
      response: {
        error: {
          code: 190,
          message: "sensitive token diagnostic from Meta",
        },
      },
    },
  ]);
  await assert.rejects(
    ensureAppSubscribed({
      wabaId: "1111111111",
      businessToken: "business-token",
      config,
      fetchImpl: scripted.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.credentialInvalid &&
      !error.retryable &&
      !error.outcomeUnknown &&
      error.code === "SUBSCRIBED_APPS_LOOKUP_CREDENTIAL_INVALID" &&
      !error.message.includes("sensitive token diagnostic"),
  );
});

test("trata HTTP 401 como business token inválido sólo en operaciones del cliente", async () => {
  const subscribedApps = scriptedFetch([
    {
      path: "/v26.0/1111111111/subscribed_apps",
      status: 401,
      response: { error: { message: "private provider diagnostic" } },
    },
  ]);
  await assert.rejects(
    ensureAppSubscribed({
      wabaId: "1111111111",
      businessToken: "business-token",
      config,
      fetchImpl: subscribedApps.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "SUBSCRIBED_APPS_LOOKUP_CREDENTIAL_INVALID" &&
      error.credentialInvalid &&
      !error.retryable &&
      !error.outcomeUnknown &&
      !error.message.includes("private provider diagnostic"),
  );

  const appData = scriptedFetch([
    {
      method: "POST",
      path: "/v26.0/5555555555/smb_app_data",
      status: 401,
      response: { error: { message: "private provider diagnostic" } },
    },
  ]);
  await assert.rejects(
    requestAppDataSync({
      phoneNumberId: "5555555555",
      syncType: "history",
      businessToken: "business-token",
      config,
      fetchImpl: appData.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "APP_DATA_SYNC_CREDENTIAL_INVALID" &&
      error.credentialInvalid &&
      !error.retryable &&
      !error.outcomeUnknown &&
      !error.message.includes("private provider diagnostic"),
  );
});

test("un 401 del App Access Token no se atribuye al business token", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/oauth/access_token",
      status: 401,
      response: { error: { message: "invalid app credential detail" } },
    },
  ]);
  await assert.rejects(
    validateWhatsAppAssets({
      businessToken: "business-token",
      expectedWabaId: "1111111111",
      config,
      fetchImpl: scripted.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "APP_TOKEN_EXCHANGE_REJECTED" &&
      !error.credentialInvalid &&
      !error.message.includes("invalid app credential detail"),
  );
});

test("un código 190 del App Access Token no se atribuye al cliente", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/oauth/access_token",
      status: 400,
      response: {
        error: { code: 190, message: "invalid app credential detail" },
      },
    },
  ]);
  await assert.rejects(
    validateWhatsAppAssets({
      businessToken: "business-token",
      expectedWabaId: "1111111111",
      config,
      fetchImpl: scripted.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "APP_TOKEN_EXCHANGE_REJECTED" &&
      !error.credentialInvalid &&
      !error.message.includes("invalid app credential detail"),
  );
});

test("honors a transient Graph code even when HTTP status is 400", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/1111111111/subscribed_apps",
      status: 400,
      response: {
        error: {
          code: 4,
          is_transient: true,
          message: "temporary provider detail",
        },
      },
    },
  ]);
  await assert.rejects(
    ensureAppSubscribed({
      wabaId: "1111111111",
      businessToken: "business-token",
      config,
      fetchImpl: scripted.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "SUBSCRIBED_APPS_LOOKUP_REJECTED" &&
      error.retryable &&
      !error.outcomeUnknown &&
      !error.message.includes("temporary provider detail"),
  );
});

test("rechaza un error Graph transitorio aunque llegue con HTTP 200", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/1111111111/subscribed_apps",
      response: {
        error: {
          code: 4,
          is_transient: true,
          message: "temporary provider detail",
        },
      },
    },
  ]);
  await assert.rejects(
    ensureAppSubscribed({
      wabaId: "1111111111",
      businessToken: "business-token",
      config,
      fetchImpl: scripted.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "SUBSCRIBED_APPS_LOOKUP_REJECTED" &&
      error.retryable &&
      !error.outcomeUnknown,
  );
});

test("un error Graph de política con HTTP 200 es terminal", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/1111111111/subscribed_apps",
      response: { error: { code: 10, message: "provider policy detail" } },
    },
  ]);
  await assert.rejects(
    ensureAppSubscribed({
      wabaId: "1111111111",
      businessToken: "business-token",
      config,
      fetchImpl: scripted.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "SUBSCRIBED_APPS_LOOKUP_REJECTED" &&
      !error.retryable &&
      !error.outcomeUnknown &&
      !error.message.includes("provider policy detail"),
  );
});

test("validates token, WABA ownership and a Coexistence phone", async () => {
  const scripted = scriptedFetch(validatedAssetsSteps());
  const assets = await validateWhatsAppAssets({
    businessToken: "business-token",
    expectedWabaId: "1111111111",
    expectedPhoneNumberId: "5555555555",
    expectedBusinessPortfolioId: "2222222222",
    config,
    fetchImpl: scripted.fetch,
  });
  assert.equal(assets.businessPortfolioId, "2222222222");
  assert.equal(assets.wabaId, "1111111111");
  assert.equal(assets.phoneNumberId, "5555555555");
  assert.equal(assets.displayPhoneNumber, "+54 11 5555 0000");
  assert.equal(
    assets.tokenExpiresAt,
    new Date(1_800_000_000 * 1_000).toISOString(),
  );
});

test("reintenta respuestas Graph parciales sin convertirlas en negativas", async () => {
  const cases = [
    {
      index: 1,
      response: { data: { is_valid: true } },
      code: "TOKEN_DEBUG_INVALID_RESPONSE",
    },
    {
      index: 2,
      response: { id: "1111111111" },
      code: "WABA_LOOKUP_INVALID_RESPONSE",
    },
    {
      index: 3,
      response: {},
      code: "PHONE_LIST_INVALID_RESPONSE",
    },
    {
      index: 4,
      response: { id: "5555555555" },
      code: "PHONE_LOOKUP_INVALID_RESPONSE",
    },
  ];

  for (const testCase of cases) {
    const steps = validatedAssetsSteps();
    steps[testCase.index] = {
      ...steps[testCase.index],
      response: testCase.response,
    };
    await assert.rejects(
      validateWhatsAppAssets({
        businessToken: "business-token",
        expectedWabaId: "1111111111",
        expectedPhoneNumberId: "5555555555",
        expectedBusinessPortfolioId: "2222222222",
        config,
        fetchImpl: scriptedFetch(steps).fetch,
      }),
      (error: unknown) =>
        error instanceof MetaEmbeddedSignupError &&
        error.code === testCase.code &&
        error.retryable &&
        !error.outcomeUnknown,
      testCase.code,
    );
  }
});

test("mantiene terminales las negativas explícitas de token y Coexistence", async () => {
  const invalidTokenSteps = validatedAssetsSteps();
  invalidTokenSteps[1] = {
    ...invalidTokenSteps[1],
    response: { data: { is_valid: false } },
  };
  await assert.rejects(
    validateWhatsAppAssets({
      businessToken: "business-token",
      expectedWabaId: "1111111111",
      expectedPhoneNumberId: "5555555555",
      config,
      fetchImpl: scriptedFetch(invalidTokenSteps).fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "BUSINESS_TOKEN_INVALID" &&
      !error.retryable &&
      error.credentialInvalid,
  );

  const incompatiblePhoneSteps = validatedAssetsSteps();
  incompatiblePhoneSteps[4] = {
    ...incompatiblePhoneSteps[4],
    response: {
      id: "5555555555",
      is_on_biz_app: false,
      platform_type: "CLOUD_API",
    },
  };
  await assert.rejects(
    validateWhatsAppAssets({
      businessToken: "business-token",
      expectedWabaId: "1111111111",
      expectedPhoneNumberId: "5555555555",
      config,
      fetchImpl: scriptedFetch(incompatiblePhoneSteps).fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "PHONE_NOT_COEXISTENCE" &&
      !error.retryable,
  );
});

test("reintenta paginación malformada de phone_numbers", async () => {
  const steps = validatedAssetsSteps();
  steps[3] = {
    ...steps[3],
    response: {
      data: [{ id: "5555555555" }],
      paging: { next: "https://graph.facebook.com/next", cursors: {} },
    },
  };
  await assert.rejects(
    validateWhatsAppAssets({
      businessToken: "business-token",
      expectedWabaId: "1111111111",
      expectedPhoneNumberId: "5555555555",
      config,
      fetchImpl: scriptedFetch(steps).fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "PHONE_LIST_PAGINATION_INVALID" &&
      error.retryable,
  );
});

test("treats a final-page cursor without paging.next as complete", async () => {
  const steps = validatedAssetsSteps();
  steps[3] = {
    ...steps[3],
    response: {
      data: [{ id: "5555555555", display_phone_number: "+54 11 5555 0000" }],
      paging: { cursors: { after: "final-cursor" } },
    },
  };
  const scripted = scriptedFetch(steps);
  const assets = await validateWhatsAppAssets({
    businessToken: "business-token",
    expectedWabaId: "1111111111",
    config,
    fetchImpl: scripted.fetch,
  });
  assert.equal(assets.phoneNumberId, "5555555555");
  assert.equal(scripted.requests.length, 5);
});

test("derives the single Coexistence phone from a multi-phone WABA", async () => {
  const steps = validatedAssetsSteps();
  steps[3] = {
    ...steps[3],
    response: {
      data: [
        { id: "4444444444", display_phone_number: "+54 11 4444 0000" },
        { id: "5555555555", display_phone_number: "+54 11 5555 0000" },
      ],
    },
  };
  steps.splice(
    4,
    1,
    {
      path: "/v26.0/4444444444",
      response: {
        id: "4444444444",
        is_on_biz_app: false,
        platform_type: "CLOUD_API",
      },
    },
    {
      path: "/v26.0/5555555555",
      response: {
        id: "5555555555",
        display_phone_number: "+54 11 5555 0000",
        is_on_biz_app: true,
        platform_type: "CLOUD_API",
      },
    },
  );
  const scripted = scriptedFetch(steps);
  const assets = await validateWhatsAppAssets({
    businessToken: "business-token",
    expectedWabaId: "1111111111",
    config,
    fetchImpl: scripted.fetch,
  });
  assert.equal(assets.phoneNumberId, "5555555555");
});

test("rejects a token that is not scoped to the submitted WABA", async () => {
  const scripted = scriptedFetch([
    validatedAssetsSteps()[0],
    {
      path: "/v26.0/debug_token",
      response: {
        data: {
          is_valid: true,
          app_id: config.appId,
          scopes: [
            "whatsapp_business_management",
            "whatsapp_business_messaging",
          ],
          granular_scopes: [
            {
              scope: "whatsapp_business_management",
              target_ids: ["9999999999"],
            },
          ],
        },
      },
    },
  ]);
  await assert.rejects(
    validateWhatsAppAssets({
      businessToken: "business-token",
      expectedWabaId: "1111111111",
      config,
      fetchImpl: scripted.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "BUSINESS_TOKEN_WABA_MISMATCH",
  );
});

test("rejects a phone that does not belong to the WABA", async () => {
  const steps = validatedAssetsSteps("5555555555").slice(0, 4);
  const scripted = scriptedFetch(steps);
  await assert.rejects(
    validateWhatsAppAssets({
      businessToken: "business-token",
      expectedWabaId: "1111111111",
      expectedPhoneNumberId: "6666666666",
      config,
      fetchImpl: scripted.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "PHONE_NUMBER_WABA_MISMATCH",
  );
});

test("does not subscribe twice when the app is already present", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/1111111111/subscribed_apps",
      response: {
        data: [{ whatsapp_business_api_data: { id: config.appId } }],
      },
      inspect: (url) => assert.equal(url.searchParams.has("fields"), false),
    },
  ]);
  assert.deepEqual(
    await ensureAppSubscribed({
      wabaId: "1111111111",
      businessToken: "business-token",
      config,
      fetchImpl: scripted.fetch,
    }),
    { alreadySubscribed: true },
  );
  assert.deepEqual(scripted.requests, [
    "GET /v26.0/1111111111/subscribed_apps",
  ]);
});

test("una lista de subscribed_apps parcial nunca dispara POST", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/1111111111/subscribed_apps",
      response: {},
    },
  ]);
  await assert.rejects(
    ensureAppSubscribed({
      wabaId: "1111111111",
      businessToken: "business-token",
      config,
      fetchImpl: scripted.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "SUBSCRIBED_APPS_LOOKUP_INVALID_RESPONSE" &&
      error.retryable,
  );
  assert.deepEqual(scripted.requests, [
    "GET /v26.0/1111111111/subscribed_apps",
  ]);
});

test("reintenta paginación malformada de subscribed_apps", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/1111111111/subscribed_apps",
      response: {
        data: [],
        paging: { next: "https://graph.facebook.com/next", cursors: {} },
      },
    },
  ]);
  await assert.rejects(
    ensureAppSubscribed({
      wabaId: "1111111111",
      businessToken: "business-token",
      config,
      fetchImpl: scripted.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "SUBSCRIBED_APPS_PAGINATION_INVALID" &&
      error.retryable,
  );
});

test("subscribes once and verifies the resulting app membership", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/1111111111/subscribed_apps",
      response: { data: [] },
    },
    {
      method: "POST",
      path: "/v26.0/1111111111/subscribed_apps",
      response: { success: true },
    },
    {
      path: "/v26.0/1111111111/subscribed_apps",
      response: {
        data: [{ whatsapp_business_api_data: { id: config.appId } }],
      },
    },
  ]);
  assert.deepEqual(
    await ensureAppSubscribed({
      wabaId: "1111111111",
      businessToken: "business-token",
      config,
      fetchImpl: scripted.fetch,
    }),
    { alreadySubscribed: false },
  );
});

test("no confunde un error Graph HTTP 200 de subscribe con éxito", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/1111111111/subscribed_apps",
      response: { data: [] },
    },
    {
      method: "POST",
      path: "/v26.0/1111111111/subscribed_apps",
      response: { error: { code: 4, is_transient: true } },
    },
  ]);
  await assert.rejects(
    ensureAppSubscribed({
      wabaId: "1111111111",
      businessToken: "business-token",
      config,
      fetchImpl: scripted.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "SUBSCRIBE_APP_REJECTED" &&
      error.retryable &&
      !error.outcomeUnknown,
  );
  assert.deepEqual(scripted.requests, [
    "GET /v26.0/1111111111/subscribed_apps",
    "POST /v26.0/1111111111/subscribed_apps",
  ]);
});

test("un error no estructurado en subscribe queda ambiguo y se reconcilia", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/1111111111/subscribed_apps",
      response: { data: [] },
    },
    {
      method: "POST",
      path: "/v26.0/1111111111/subscribed_apps",
      response: { error: null },
    },
    {
      path: "/v26.0/1111111111/subscribed_apps",
      response: {
        data: [{ whatsapp_business_api_data: { id: config.appId } }],
      },
    },
  ]);
  assert.deepEqual(
    await ensureAppSubscribed({
      wabaId: "1111111111",
      businessToken: "business-token",
      config,
      fetchImpl: scripted.fetch,
    }),
    { alreadySubscribed: false },
  );
});

test("requests contacts and history without ever calling /messages", async () => {
  const scripted = scriptedFetch([
    {
      method: "POST",
      path: "/v26.0/5555555555/smb_app_data",
      response: { messaging_product: "whatsapp", request_id: "contacts-1" },
      inspect: (_url, init) => {
        assert.deepEqual(JSON.parse(String(init.body)), {
          messaging_product: "whatsapp",
          sync_type: "smb_app_state_sync",
        });
      },
    },
    {
      method: "POST",
      path: "/v26.0/5555555555/smb_app_data",
      response: { messaging_product: "whatsapp", request_id: "history-1" },
      inspect: (_url, init) => {
        assert.deepEqual(JSON.parse(String(init.body)), {
          messaging_product: "whatsapp",
          sync_type: "history",
        });
      },
    },
  ]);
  const common = {
    phoneNumberId: "5555555555",
    businessToken: "business-token",
    config,
    fetchImpl: scripted.fetch,
  };
  assert.equal(
    (await requestAppDataSync({ ...common, syncType: "smb_app_state_sync" }))
      .requestId,
    "contacts-1",
  );
  assert.equal(
    (await requestAppDataSync({ ...common, syncType: "history" })).requestId,
    "history-1",
  );
  assert.ok(
    scripted.requests.every((request) => !request.includes("messages")),
  );
});

test("treats an empty successful token exchange as outcome unknown", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/oauth/access_token",
      response: {},
    },
  ]);
  await assert.rejects(
    exchangeEmbeddedSignupCode({
      code: "one-shot-code-with-empty-response",
      receivedAtMs: 10_000,
      config,
      fetchImpl: scripted.fetch,
      now: () => 10_100,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "TOKEN_EXCHANGE_INVALID_RESPONSE" &&
      error.outcomeUnknown &&
      !error.retryable,
  );
});

test("retries a transient malformed response from a read-only Graph lookup", async () => {
  const scripted = scriptedFetch([
    validatedAssetsSteps()[0],
    {
      path: "/v26.0/debug_token",
      response: "rate limited",
      status: 429,
    },
  ]);
  await assert.rejects(
    validateWhatsAppAssets({
      businessToken: "business-token",
      expectedWabaId: "1111111111",
      config,
      fetchImpl: scripted.fetch,
    }),
    (error: unknown) =>
      error instanceof MetaEmbeddedSignupError &&
      error.code === "TOKEN_DEBUG_REJECTED" &&
      error.retryable &&
      !error.outcomeUnknown,
  );
  assert.equal(scripted.requests.length, 2);
});

test("distinguishes a rejected 429 from an ambiguous 408 sync response", async () => {
  for (const expectation of [
    { status: 429, retryable: true, outcomeUnknown: false },
    { status: 408, retryable: false, outcomeUnknown: true },
  ]) {
    let calls = 0;
    await assert.rejects(
      requestAppDataSync({
        phoneNumberId: "5555555555",
        syncType: "history",
        businessToken: "business-token",
        config,
        fetchImpl: async () => {
          calls += 1;
          return new Response("not-json", { status: expectation.status });
        },
      }),
      (error: unknown) =>
        error instanceof MetaEmbeddedSignupError &&
        error.code === "APP_DATA_SYNC_INVALID_RESPONSE" &&
        error.retryable === expectation.retryable &&
        error.outcomeUnknown === expectation.outcomeUnknown,
    );
    assert.equal(calls, 1);
  }
});

test("never blindly retries an ambiguous one-shot sync response", async () => {
  for (const response of [
    { status: 500, body: { error: { code: 2 } } },
    { status: 200, body: {} },
  ]) {
    const scripted = scriptedFetch([
      {
        method: "POST",
        path: "/v26.0/5555555555/smb_app_data",
        status: response.status,
        response: response.body,
      },
    ]);
    await assert.rejects(
      requestAppDataSync({
        phoneNumberId: "5555555555",
        syncType: "history",
        businessToken: "business-token",
        config,
        fetchImpl: scripted.fetch,
      }),
      (error: unknown) =>
        error instanceof MetaEmbeddedSignupError &&
        error.outcomeUnknown &&
        !error.retryable,
    );
    assert.equal(scripted.requests.length, 1);
  }
});

test("unsubscribe is idempotent and verifies absence", async () => {
  const scripted = scriptedFetch([
    {
      path: "/v26.0/1111111111/subscribed_apps",
      response: {
        data: [{ whatsapp_business_api_data: { id: config.appId } }],
      },
    },
    {
      method: "DELETE",
      path: "/v26.0/1111111111/subscribed_apps",
      response: { success: true },
    },
    {
      path: "/v26.0/1111111111/subscribed_apps",
      response: { data: [] },
    },
  ]);
  assert.deepEqual(
    await unsubscribeApp({
      wabaId: "1111111111",
      businessToken: "business-token",
      config,
      fetchImpl: scripted.fetch,
    }),
    { alreadyUnsubscribed: false },
  );
});
