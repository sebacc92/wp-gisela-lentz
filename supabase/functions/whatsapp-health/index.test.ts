import assert from "node:assert/strict";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import type { WhatsAppAccountCredentials } from "../_shared/whatsapp-account-credentials.ts";
import {
  authenticatedHealthAccountId,
  canonicalMetaGraphNextPage,
  graphCollection,
} from "./index.ts";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const WABA_ID = "3333333333";
const PHONE_NUMBER_ID = "4444444444";
const BUSINESS_TOKEN = "business-token-for-health-account";
const initialUrl =
  `https://graph.facebook.com/v26.0/${WABA_ID}/phone_numbers` +
  "?fields=id%2Cdisplay_phone_number&limit=100";

const credentials: WhatsAppAccountCredentials = {
  credentialMode: "coexistence",
  accountId: ACCOUNT_ID,
  wabaId: WABA_ID,
  phoneNumberId: PHONE_NUMBER_ID,
  businessAccessToken: BUSINESS_TOKEN,
  tokenGeneration: 7,
  coexistenceStatus: "active",
  onboardingStatus: "completed",
  appSubscriptionStatus: "subscribed",
  businessTokenStatus: "active",
  businessTokenValidationStatus: "valid",
  sendingPaused: false,
  apiVersion: "v26.0",
};

Deno.test(
  "health reconstruye paginación con cursor y bearer de la cuenta exacta",
  async () => {
    const requests: Array<{
      url: string;
      authorization: string;
      redirect: unknown;
    }> = [];
    const rows = await graphCollection<{ id: string }>(
      initialUrl,
      credentials,
      {} as SupabaseClient,
      async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("Authorization") ?? "",
          redirect: init?.redirect,
        });
        if (requests.length === 1) {
          return new Response(
            JSON.stringify({
              data: [{ id: "first" }],
              paging: {
                next: `${initialUrl}&after=` + encodeURIComponent("cursor-one"),
                cursors: { after: "cursor-one" },
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: [{ id: "second" }] }), {
          status: 200,
        });
      },
    );

    assert.deepEqual(rows, [{ id: "first" }, { id: "second" }]);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].url.startsWith(initialUrl));
    assert.equal(
      new URL(requests[1].url).searchParams.get("after"),
      "cursor-one",
    );
    assert.equal(requests[1].url.includes("access_token"), false);
    assert.ok(
      requests.every(
        ({ authorization }) => authorization === `Bearer ${BUSINESS_TOKEN}`,
      ),
    );
    assert.ok(requests.every(({ redirect }) => redirect === "error"));
  },
);

Deno.test(
  "health rechaza next no canónico, redirects de host y tokens en URL",
  () => {
    const invalid = [
      `https://evil.example/v26.0/${WABA_ID}/phone_numbers?fields=id%2Cdisplay_phone_number&limit=100&after=cursor-one`,
      `https://graph.facebook.com.evil.example/v26.0/${WABA_ID}/phone_numbers?fields=id%2Cdisplay_phone_number&limit=100&after=cursor-one`,
      `https://user@graph.facebook.com/v26.0/${WABA_ID}/phone_numbers?fields=id%2Cdisplay_phone_number&limit=100&after=cursor-one`,
      `https://graph.facebook.com:444/v26.0/${WABA_ID}/phone_numbers?fields=id%2Cdisplay_phone_number&limit=100&after=cursor-one`,
      `https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages?fields=id%2Cdisplay_phone_number&limit=100&after=cursor-one`,
      `${initialUrl}&after=cursor-one&access_token=must-not-cross`,
      `${initialUrl}&after=another-cursor`,
    ];
    for (const providerNext of invalid) {
      assert.throws(
        () =>
          canonicalMetaGraphNextPage({
            initialUrl,
            providerNext,
            afterCursor: "cursor-one",
          }),
        Error,
        providerNext,
      );
    }
  },
);

Deno.test(
  "health rechaza selector cross-account antes de cualquier Graph",
  async () => {
    let graphCalls = 0;
    const client = {
      rpc: async () => ({
        data: { account: { accountId: ACCOUNT_ID } },
        error: null,
      }),
    } as unknown as SupabaseClient;
    await assert.rejects(
      () =>
        authenticatedHealthAccountId({
          client,
          adminUserId: "33333333-3333-4333-8333-333333333333",
          requestedAccountId: OTHER_ACCOUNT_ID,
        }),
      /WHATSAPP_HEALTH_ACCOUNT_MISMATCH/,
    );
    assert.equal(graphCalls, 0);
  },
);
