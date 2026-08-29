import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import {
  resolveWhatsAppAccountCredentials,
  WhatsAppCredentialResolutionError,
} from "./whatsapp-account-credentials.ts";
import {
  dispatchWhatsAppPayload,
  markWhatsAppCredentialAttentionRequired,
  observeMetaGraphAuthenticationFailure,
  WhatsAppDispatchError,
} from "./whatsapp.ts";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const WABA_ID = "3333333333";
const PHONE_NUMBER_ID = "4444444444";
const BUSINESS_TOKEN = "business-token-for-account-one";

const originalEnvironment = {
  apiVersion: process.env.WHATSAPP_GRAPH_API_VERSION,
  wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
};
process.env.WHATSAPP_GRAPH_API_VERSION = "v26.0";

after(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("WHATSAPP_GRAPH_API_VERSION", originalEnvironment.apiVersion);
  restore("WHATSAPP_BUSINESS_ACCOUNT_ID", originalEnvironment.wabaId);
  restore("WHATSAPP_PHONE_NUMBER_ID", originalEnvironment.phoneNumberId);
  restore("WHATSAPP_ACCESS_TOKEN", originalEnvironment.accessToken);
});

function coexistenceRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    credential_mode: "coexistence",
    account_id: ACCOUNT_ID,
    waba_id: WABA_ID,
    phone_number_id: PHONE_NUMBER_ID,
    business_access_token: BUSINESS_TOKEN,
    token_generation: 3,
    coexistence_status: "active",
    onboarding_status: "completed",
    app_subscription_status: "subscribed",
    business_token_status: "active",
    business_token_validation_status: "valid",
    sending_paused: false,
    ...overrides,
  };
}

function rpcClient(input: {
  data?: unknown;
  error?: { message: string } | null;
  onRpc?: (parameters: Record<string, unknown>) => void;
}): SupabaseClient {
  return {
    async rpc(name: string, parameters: Record<string, unknown>) {
      assert.equal(name, "resolve_whatsapp_account_credentials");
      input.onRpc?.(parameters);
      return {
        data: input.data ?? null,
        error: input.error ?? null,
      };
    },
  } as unknown as SupabaseClient;
}

async function resolutionCode(
  promise: Promise<unknown>,
): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    assert.equal(error instanceof WhatsAppCredentialResolutionError, true);
    return (error as WhatsAppCredentialResolutionError).code;
  }
}

async function resolutionFailure(
  promise: Promise<unknown>,
): Promise<WhatsAppCredentialResolutionError> {
  try {
    await promise;
    throw new Error("expected credential resolution to fail");
  } catch (error) {
    assert.equal(error instanceof WhatsAppCredentialResolutionError, true);
    return error as WhatsAppCredentialResolutionError;
  }
}

test("resuelve una cuenta exacta sin consultar credenciales legacy", async () => {
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  let received: Record<string, unknown> | null = null;
  const credentials = await resolveWhatsAppAccountCredentials({
    client: rpcClient({
      data: coexistenceRow(),
      onRpc: (parameters) => {
        received = parameters;
      },
    }),
    purpose: "send",
    coexistenceAccountId: ACCOUNT_ID,
    wabaId: WABA_ID,
    phoneNumberId: PHONE_NUMBER_ID,
    conversationId: CONVERSATION_ID,
    expectedTokenGeneration: 3,
  });

  assert.deepEqual(received, {
    p_purpose: "send",
    p_account_id: ACCOUNT_ID,
    p_waba_id: WABA_ID,
    p_phone_number_id: PHONE_NUMBER_ID,
    p_conversation_id: CONVERSATION_ID,
    p_expected_token_generation: 3,
  });
  assert.equal(credentials.credentialMode, "coexistence");
  assert.equal(credentials.accountId, ACCOUNT_ID);
  assert.equal(credentials.wabaId, WABA_ID);
  assert.equal(credentials.phoneNumberId, PHONE_NUMBER_ID);
  assert.equal(credentials.businessAccessToken, BUSINESS_TOKEN);
  assert.equal(credentials.tokenGeneration, 3);
});

test("rechaza una respuesta que contradice account, WABA, phone o generación", async () => {
  const cases = [
    coexistenceRow({ account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    coexistenceRow({ waba_id: "5555555555" }),
    coexistenceRow({ phone_number_id: "6666666666" }),
    coexistenceRow({ token_generation: 4 }),
  ];
  for (const row of cases) {
    assert.equal(
      await resolutionCode(
        resolveWhatsAppAccountCredentials({
          client: rpcClient({ data: row }),
          purpose: "send",
          coexistenceAccountId: ACCOUNT_ID,
          wabaId: WABA_ID,
          phoneNumberId: PHONE_NUMBER_ID,
          expectedTokenGeneration: 3,
        }),
      ),
      "WHATSAPP_CREDENTIAL_IDENTITY_MISMATCH",
    );
  }
});

test("falla cerrado para Vault vacío, token revocado o validación incierta", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [
      coexistenceRow({ business_access_token: "" }),
      "WHATSAPP_CREDENTIAL_RESPONSE_INVALID",
    ],
    [
      coexistenceRow({ business_token_status: "revoked" }),
      "WHATSAPP_BUSINESS_TOKEN_UNAVAILABLE",
    ],
    [
      coexistenceRow({ business_token_validation_status: "unknown" }),
      "WHATSAPP_BUSINESS_TOKEN_NOT_VALIDATED",
    ],
    [
      coexistenceRow({
        business_token_validation_status: "attention_required",
      }),
      "WHATSAPP_BUSINESS_TOKEN_NOT_VALIDATED",
    ],
  ];
  for (const [row, code] of cases) {
    assert.equal(
      await resolutionCode(
        resolveWhatsAppAccountCredentials({
          client: rpcClient({ data: row }),
          purpose: "send",
          coexistenceAccountId: ACCOUNT_ID,
        }),
      ),
      code,
    );
  }
});

test("send rechaza cuenta desconectada, onboarding y sending_paused", async () => {
  const rows = [
    coexistenceRow({ coexistence_status: "disconnected" }),
    coexistenceRow({ onboarding_status: "provisioning" }),
    coexistenceRow({ sending_paused: true }),
  ];
  const expected = [
    "WHATSAPP_ACCOUNT_NOT_READY_FOR_OPERATION",
    "WHATSAPP_ACCOUNT_NOT_READY_FOR_OPERATION",
    "WHATSAPP_SENDING_PAUSED",
  ];
  for (let index = 0; index < rows.length; index += 1) {
    assert.equal(
      await resolutionCode(
        resolveWhatsAppAccountCredentials({
          client: rpcClient({ data: rows[index] }),
          purpose: "send",
          coexistenceAccountId: ACCOUNT_ID,
        }),
      ),
      expected[index],
    );
  }
});

test("media puede leer una cuenta pausada pero nunca una desconectada", async () => {
  const paused = await resolveWhatsAppAccountCredentials({
    client: rpcClient({
      data: coexistenceRow({
        coexistence_status: "paused",
        sending_paused: true,
      }),
    }),
    purpose: "media",
    coexistenceAccountId: ACCOUNT_ID,
  });
  assert.equal(paused.accountId, ACCOUNT_ID);
  assert.equal(paused.sendingPaused, true);

  assert.equal(
    await resolutionCode(
      resolveWhatsAppAccountCredentials({
        client: rpcClient({
          data: coexistenceRow({ coexistence_status: "disconnected" }),
        }),
        purpose: "media",
        coexistenceAccountId: ACCOUNT_ID,
      }),
    ),
    "WHATSAPP_ACCOUNT_NOT_READY_FOR_OPERATION",
  );
});

test("token_validation y unsubscribe pueden diagnosticar un token retenido vencido", async () => {
  const validation = await resolveWhatsAppAccountCredentials({
    client: rpcClient({
      data: coexistenceRow({
        business_token_status: "expired",
        business_token_validation_status: "expired",
      }),
    }),
    purpose: "token_validation",
    coexistenceAccountId: ACCOUNT_ID,
  });
  assert.equal(validation.businessTokenStatus, "expired");

  const unsubscribe = await resolveWhatsAppAccountCredentials({
    client: rpcClient({
      data: coexistenceRow({
        coexistence_status: "paused",
        onboarding_status: "offboarding",
        app_subscription_status: "unsubscribing",
        business_token_status: "expired",
        business_token_validation_status: "expired",
        sending_paused: true,
      }),
    }),
    purpose: "unsubscribe",
    coexistenceAccountId: ACCOUNT_ID,
  });
  assert.equal(unsubscribe.businessTokenStatus, "expired");
});

test("legacy sólo se habilita por una respuesta explícita del RPC", async () => {
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "7777777777";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "8888888888";
  process.env.WHATSAPP_ACCESS_TOKEN = "legacy-access-token";
  const credentials = await resolveWhatsAppAccountCredentials({
    client: rpcClient({
      data: {
        credential_mode: "legacy",
        account_id: null,
        waba_id: null,
        phone_number_id: null,
        business_access_token: null,
        token_generation: null,
        coexistence_status: null,
        onboarding_status: null,
        app_subscription_status: null,
        business_token_status: null,
        business_token_validation_status: null,
        sending_paused: false,
      },
    }),
    purpose: "send",
    conversationId: CONVERSATION_ID,
  });

  assert.equal(credentials.credentialMode, "legacy");
  assert.equal(credentials.wabaId, "7777777777");
  assert.equal(credentials.phoneNumberId, "8888888888");
  assert.equal(credentials.businessAccessToken, "legacy-access-token");
});

test("un error o respuesta inválida del RPC jamás cae a env legacy", async () => {
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "7777777777";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "8888888888";
  process.env.WHATSAPP_ACCESS_TOKEN = "legacy-access-token";

  const transportFailure = await resolutionFailure(
    resolveWhatsAppAccountCredentials({
      client: rpcClient({ error: { message: "vault unavailable" } }),
      purpose: "send",
      conversationId: CONVERSATION_ID,
    }),
  );
  assert.equal(transportFailure.code, "WHATSAPP_CREDENTIAL_RESOLUTION_FAILED");
  assert.equal(transportFailure.retryable, true);

  const validationPending = await resolutionFailure(
    resolveWhatsAppAccountCredentials({
      client: rpcClient({ data: null }),
      purpose: "send",
      conversationId: CONVERSATION_ID,
    }),
  );
  assert.equal(
    validationPending.code,
    "WHATSAPP_CREDENTIAL_VALIDATION_PENDING",
  );
  assert.equal(validationPending.retryable, true);

  const missingVaultSecret = await resolutionFailure(
    resolveWhatsAppAccountCredentials({
      client: rpcClient({
        error: { message: "WHATSAPP_BUSINESS_CREDENTIAL_CORRUPT" },
      }),
      purpose: "send",
      conversationId: CONVERSATION_ID,
    }),
  );
  assert.equal(missingVaultSecret.code, "WHATSAPP_BUSINESS_CREDENTIAL_CORRUPT");
  assert.equal(missingVaultSecret.retryable, false);
});

test("una resolución managed ambigua falla cerrada aunque legacy esté configurado", async () => {
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "7777777777";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "8888888888";
  process.env.WHATSAPP_ACCESS_TOKEN = "legacy-access-token";

  const ambiguous = await resolutionFailure(
    resolveWhatsAppAccountCredentials({
      client: rpcClient({
        error: {
          message: "WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_AMBIGUOUS",
        },
      }),
      purpose: "management",
    }),
  );
  assert.equal(
    ambiguous.code,
    "WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_AMBIGUOUS",
  );
  assert.equal(ambiguous.retryable, false);
});

test("legacy no puede responder a un selector de cuenta Coexistence", async () => {
  assert.equal(
    await resolutionCode(
      resolveWhatsAppAccountCredentials({
        client: rpcClient({
          data: {
            credential_mode: "legacy",
            account_id: null,
            waba_id: null,
            phone_number_id: null,
            business_access_token: null,
            token_generation: null,
            coexistence_status: null,
            onboarding_status: null,
            app_subscription_status: null,
            business_token_status: null,
            business_token_validation_status: null,
            sending_paused: false,
          },
        }),
        purpose: "send",
        coexistenceAccountId: ACCOUNT_ID,
      }),
    ),
    "WHATSAPP_CREDENTIAL_RESPONSE_INVALID",
  );
});

test("POST /messages usa únicamente teléfono y business token resueltos", async () => {
  process.env.WHATSAPP_ACCESS_TOKEN = "legacy-token-that-must-not-be-used";
  let observedUrl = "";
  let observedAuthorization = "";
  let observedRedirect: RequestRedirect | undefined;
  const result = await dispatchWhatsAppPayload({
    recipient: "5491100000001",
    payload: { type: "text", text: { body: "hola" } },
    opaqueMessageId: "99999999-9999-4999-8999-999999999999",
    credentials: {
      credentialMode: "coexistence",
      accountId: ACCOUNT_ID,
      wabaId: WABA_ID,
      phoneNumberId: PHONE_NUMBER_ID,
      businessAccessToken: BUSINESS_TOKEN,
      tokenGeneration: 3,
      coexistenceStatus: "active",
      onboardingStatus: "completed",
      appSubscriptionStatus: "subscribed",
      businessTokenStatus: "active",
      businessTokenValidationStatus: "valid",
      sendingPaused: false,
      apiVersion: "v26.0",
    },
    fetchImpl: async (input, init) => {
      observedUrl = String(input);
      observedAuthorization =
        new Headers(init?.headers).get("Authorization") ?? "";
      observedRedirect = init?.redirect;
      return new Response(
        JSON.stringify({ messages: [{ id: "wamid.sent.1" }] }),
        {
          status: 200,
          headers: { "x-fb-request-id": "request-1" },
        },
      );
    },
  });

  assert.equal(
    observedUrl,
    `https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`,
  );
  assert.equal(observedAuthorization, `Bearer ${BUSINESS_TOKEN}`);
  assert.equal(observedRedirect, "error");
  assert.equal(observedAuthorization.includes("legacy-token"), false);
  assert.deepEqual(result, {
    whatsappMessageId: "wamid.sent.1",
    requestId: "request-1",
  });
});

test("POST /messages coloca el BSUID en recipient y nunca en to", async () => {
  let observedBody: Record<string, unknown> = {};
  await dispatchWhatsAppPayload({
    recipient: "AR.syntheticrecipient1",
    recipientKind: "bsuid",
    payload: { type: "text", text: { body: "hola" } },
    opaqueMessageId: "99999999-9999-4999-8999-999999999998",
    credentials: {
      credentialMode: "coexistence",
      accountId: ACCOUNT_ID,
      wabaId: WABA_ID,
      phoneNumberId: PHONE_NUMBER_ID,
      businessAccessToken: BUSINESS_TOKEN,
      tokenGeneration: 3,
      coexistenceStatus: "active",
      onboardingStatus: "completed",
      appSubscriptionStatus: "subscribed",
      businessTokenStatus: "active",
      businessTokenValidationStatus: "valid",
      sendingPaused: false,
      apiVersion: "v26.0",
    },
    fetchImpl: async (_input, init) => {
      observedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ messages: [{ id: "wamid.sent.bsuid" }] }),
        { status: 200 },
      );
    },
  });

  assert.equal(observedBody.recipient, "AR.syntheticrecipient1");
  assert.equal("to" in observedBody, false);
});

test("Graph 190 se clasifica sin propagar el detalle del proveedor", async () => {
  const providerDetail = "provider detail with sensitive-token-sentinel";
  let observed: unknown;
  try {
    await dispatchWhatsAppPayload({
      recipient: "5491100000001",
      payload: { type: "text", text: { body: "hola" } },
      opaqueMessageId: "99999999-9999-4999-8999-999999999999",
      credentials: {
        credentialMode: "coexistence",
        accountId: ACCOUNT_ID,
        wabaId: WABA_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        businessAccessToken: BUSINESS_TOKEN,
        tokenGeneration: 3,
        coexistenceStatus: "active",
        onboardingStatus: "completed",
        appSubscriptionStatus: "subscribed",
        businessTokenStatus: "active",
        businessTokenValidationStatus: "valid",
        sendingPaused: false,
        apiVersion: "v26.0",
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: { code: 190, message: providerDetail, error_subcode: 463 },
          }),
          { status: 401 },
        ),
    });
  } catch (error) {
    observed = error;
  }
  assert.equal(observed instanceof WhatsAppDispatchError, true);
  const error = observed as WhatsAppDispatchError;
  assert.equal(error.code, "META_AUTHENTICATION_FAILED");
  assert.equal(error.credentialInvalid, true);
  assert.equal(error.retryable, false);
  assert.equal(error.message.includes(providerDetail), false);
  assert.equal(error.message.includes(BUSINESS_TOKEN), false);
});

test("un auth error marca exactamente la generación observada sin incluir el token", async () => {
  let rpcName = "";
  let rpcParameters: Record<string, unknown> = {};
  const client = {
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      rpcName = name;
      rpcParameters = parameters;
      return { data: true, error: null };
    },
  } as unknown as SupabaseClient;
  const credentials = await resolveWhatsAppAccountCredentials({
    client: rpcClient({ data: coexistenceRow() }),
    purpose: "send",
    coexistenceAccountId: ACCOUNT_ID,
  });

  assert.equal(
    await markWhatsAppCredentialAttentionRequired({
      client,
      credentials,
      observedAt: "2026-08-26T15:00:00.000Z",
    }),
    true,
  );
  assert.equal(rpcName, "mark_whatsapp_business_token_attention_required");
  assert.deepEqual(rpcParameters, {
    p_account_id: ACCOUNT_ID,
    p_expected_token_generation: 3,
    p_token_status: "unknown",
    p_error_code: "META_AUTHENTICATION_FAILED",
    p_observed_at: "2026-08-26T15:00:00.000Z",
  });
  assert.equal(JSON.stringify(rpcParameters).includes(BUSINESS_TOKEN), false);
});

test("media/health observan HTTP 401 o Graph 190 sin consumir ni propagar el body", async () => {
  const marked: Array<Record<string, unknown>> = [];
  const client = {
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      assert.equal(name, "mark_whatsapp_business_token_attention_required");
      marked.push(parameters);
      return { data: true, error: null };
    },
  } as unknown as SupabaseClient;
  const credentials = await resolveWhatsAppAccountCredentials({
    client: rpcClient({ data: coexistenceRow() }),
    purpose: "media",
    coexistenceAccountId: ACCOUNT_ID,
  });
  const providerDetail = "secret provider detail";
  const graph190 = new Response(
    JSON.stringify({ error: { code: 190, message: providerDetail } }),
    { status: 400 },
  );
  const http401 = new Response(providerDetail, { status: 401 });

  assert.equal(
    await observeMetaGraphAuthenticationFailure({
      client,
      credentials,
      response: graph190,
    }),
    true,
  );
  assert.equal(
    await graph190.text(),
    JSON.stringify({
      error: { code: 190, message: providerDetail },
    }),
  );
  assert.equal(
    await observeMetaGraphAuthenticationFailure({
      client,
      credentials,
      response: http401,
    }),
    true,
  );
  assert.equal(marked.length, 2);
  for (const parameters of marked) {
    assert.equal(parameters.p_account_id, ACCOUNT_ID);
    assert.equal(parameters.p_expected_token_generation, 3);
    assert.equal(JSON.stringify(parameters).includes(BUSINESS_TOKEN), false);
    assert.equal(JSON.stringify(parameters).includes(providerDetail), false);
  }
});
