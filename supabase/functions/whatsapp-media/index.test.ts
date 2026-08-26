import assert from "node:assert/strict";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import { handleWhatsAppMediaRequest } from "./index.ts";

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";
const WABA_ID = "6666666666";
const PHONE_NUMBER_ID = "7777777777";
const MEDIA_ID = "8888888888";
const BUSINESS_TOKEN = "vault-business-token-account-one";
const DOWNLOAD_URL =
  "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=8888888888";

Deno.env.set("WHATSAPP_GRAPH_API_VERSION", "v26.0");

function credentialRow(accountId = ACCOUNT_ID): Record<string, unknown> {
  return {
    credential_mode: "coexistence",
    account_id: accountId,
    waba_id: WABA_ID,
    phone_number_id: PHONE_NUMBER_ID,
    business_access_token: BUSINESS_TOKEN,
    token_generation: 7,
    coexistence_status: "active",
    onboarding_status: "completed",
    app_subscription_status: "subscribed",
    business_token_status: "active",
    business_token_validation_status: "valid",
    sending_paused: false,
  };
}

function mediaClient(input: {
  resolvedAccountId?: string;
  rpcCalls: Array<Record<string, unknown>>;
}): SupabaseClient {
  return {
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      assert.equal(name, "resolve_whatsapp_account_credentials");
      input.rpcCalls.push(parameters);
      return {
        data: [credentialRow(input.resolvedAccountId ?? ACCOUNT_ID)],
        error: null,
      };
    },
    from: (table: string) => {
      if (table === "messages") {
        return {
          select: () => ({
            eq: (_column: string, value: unknown) => {
              assert.equal(value, MESSAGE_ID);
              return {
                maybeSingle: async () => ({
                  data: {
                    id: MESSAGE_ID,
                    conversation_id: CONVERSATION_ID,
                    direction: "inbound",
                    type: "image",
                    metadata: {
                      media_id: MEDIA_ID,
                      mime_type: "image/jpeg",
                      filename: "comprobante.jpg",
                    },
                    coexistence_account_id: ACCOUNT_ID,
                  },
                  error: null,
                }),
              };
            },
          }),
        };
      }
      if (table === "audit_logs") {
        return {
          insert: async (values: Record<string, unknown>) => {
            assert.equal(values.actor_user_id, USER_ID);
            assert.equal(values.entity_id, MESSAGE_ID);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

const authorize = async () =>
  ({
    user: { id: USER_ID },
    profile: { id: USER_ID, full_name: "Admin", role: "ADMIN" },
  }) as Awaited<
    ReturnType<typeof import("../_shared/supabase.ts").authorizeUser>
  >;

Deno.test(
  "media usa el business token de la cuenta para metadata y lookaside",
  async () => {
    const rpcCalls: Array<Record<string, unknown>> = [];
    const graphCalls: Array<{ url: string; authorization: string | null }> = [];
    const response = await handleWhatsAppMediaRequest(
      new Request(
        `https://example.test/functions/v1/whatsapp-media?messageId=${MESSAGE_ID}`,
        { headers: { Authorization: "Bearer browser-session" } },
      ),
      {
        client: mediaClient({ rpcCalls }),
        authorize,
        fetchImpl: async (input, init) => {
          const url = String(input);
          graphCalls.push({
            url,
            authorization: new Headers(init?.headers).get("Authorization"),
          });
          if (url.startsWith(`https://graph.facebook.com/v26.0/${MEDIA_ID}`)) {
            return new Response(
              JSON.stringify({
                id: MEDIA_ID,
                messaging_product: "whatsapp",
                url: DOWNLOAD_URL,
                mime_type: "image/jpeg",
                file_size: 3,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          assert.equal(url, DOWNLOAD_URL);
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: {
              "content-type": "image/jpeg",
              "content-length": "3",
            },
          });
        },
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      new Uint8Array([1, 2, 3]),
    );
    assert.deepEqual(rpcCalls, [
      {
        p_purpose: "media",
        p_account_id: ACCOUNT_ID,
        p_waba_id: null,
        p_phone_number_id: null,
        p_conversation_id: CONVERSATION_ID,
        p_expected_token_generation: null,
      },
    ]);
    assert.equal(graphCalls.length, 2);
    assert.match(
      graphCalls[0].url,
      new RegExp(`/${MEDIA_ID}\\?phone_number_id=${PHONE_NUMBER_ID}$`),
    );
    for (const call of graphCalls) {
      assert.equal(call.authorization, `Bearer ${BUSINESS_TOKEN}`);
    }
  },
);

Deno.test(
  "media cross-account falla antes de cualquier llamada Graph",
  async () => {
    const rpcCalls: Array<Record<string, unknown>> = [];
    let graphCalls = 0;
    const response = await handleWhatsAppMediaRequest(
      new Request(
        `https://example.test/functions/v1/whatsapp-media?messageId=${MESSAGE_ID}`,
        { headers: { Authorization: "Bearer browser-session" } },
      ),
      {
        client: mediaClient({ resolvedAccountId: OTHER_ACCOUNT_ID, rpcCalls }),
        authorize,
        fetchImpl: async () => {
          graphCalls += 1;
          throw new Error("Graph must not be called");
        },
      },
    );

    assert.equal(response.status, 503);
    assert.equal(graphCalls, 0);
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].p_account_id, ACCOUNT_ID);
  },
);
