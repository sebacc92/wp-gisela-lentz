import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import {
  sendAndRecordMessage,
  textPayload,
  WhatsAppPolicyError,
} from "./whatsapp.ts";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const INBOUND_ID = "44444444-4444-4444-8444-444444444444";
const OUTBOUND_ID = "55555555-5555-4555-8555-555555555555";
const LEASE_TOKEN = "66666666-6666-4666-8666-666666666666";

function queryResult(data: unknown) {
  const query = {
    eq: () => query,
    in: () => query,
    select: () => query,
    single: async () => ({ data, error: null }),
    maybeSingle: async () => ({ data, error: null }),
    then: (
      resolve: (value: { data: unknown; error: null }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data, error: null }).then(resolve, reject),
  };
  return query;
}

function finalGateClient(input: {
  eligibilityCalls: string[];
  failedMessages: Array<Record<string, unknown>>;
}): SupabaseClient {
  const freshConversation = {
    id: CONVERSATION_ID,
    contact_id: CONTACT_ID,
    last_inbound_message_at: new Date().toISOString(),
    automation_mode: "auto",
    automation_pause_source: null,
    automation_pause_message_id: null,
    automation_human_barrier_ingest_sequence: 0,
  };
  const freshContact = {
    id: CONTACT_ID,
    whatsapp_opt_in_at: "2026-01-01T00:00:00.000Z",
    whatsapp_opt_out_at: null,
    whatsapp_consent_status: "opted_in",
  };

  return {
    rpc: async (name: string) => {
      if (name === "resolve_whatsapp_account_credentials") {
        return {
          data: [
            {
              credential_mode: "coexistence",
              account_id: ACCOUNT_ID,
              waba_id: "7777777777",
              phone_number_id: "8888888888",
              business_access_token: "synthetic-vault-token",
              token_generation: 3,
              coexistence_status: "active",
              onboarding_status: "completed",
              app_subscription_status: "subscribed",
              business_token_status: "active",
              business_token_validation_status: "valid",
              sending_paused: false,
            },
          ],
          error: null,
        };
      }
      if (name === "resolve_whatsapp_coexistence_recipient") {
        return {
          data: [
            {
              recipient_value: "5491100000001",
              identity_kind: "wa_id",
              identity_provenance: "recent_inbound",
            },
          ],
          error: null,
        };
      }
      if (name === "check_whatsapp_automation_send_eligibility") {
        input.eligibilityCalls.push(name);
        const stillEligible = input.eligibilityCalls.length === 1;
        return {
          data: {
            eligible: stillEligible,
            reason: stillEligible ? "ELIGIBLE" : "AUTOMATIONS_DISABLED",
            conversation_id: CONVERSATION_ID,
            global_automations_enabled: false,
            test_override_active: stillEligible,
            test_override_until: stillEligible
              ? "2026-09-02T12:00:00.000Z"
              : null,
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC: ${name}`);
    },
    from: (table: string) => {
      if (table === "messages") {
        return {
          select: (columns: string) =>
            columns === "whatsapp_ingest_sequence"
              ? queryResult({ whatsapp_ingest_sequence: 1 })
              : queryResult(null),
          insert: (values: Record<string, unknown>) =>
            queryResult({
              id: OUTBOUND_ID,
              whatsapp_message_id: null,
              status: "pending",
              metadata: values.metadata,
            }),
          update: (values: Record<string, unknown>) => {
            input.failedMessages.push(values);
            return queryResult(null);
          },
        };
      }
      if (table === "conversations") {
        return { select: () => queryResult(freshConversation) };
      }
      if (table === "contacts") {
        return { select: () => queryResult(freshContact) };
      }
      if (table === "whatsapp_settings") {
        return {
          select: () =>
            queryResult({ sending_paused: false, quality_rating: "GREEN" }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

test("revocation after reservation is rechecked at the last pre-Graph gate", async () => {
  const previousAutomations = process.env.WHATSAPP_AUTOMATIONS_ENABLED;
  const previousTestMode = process.env.WHATSAPP_TEST_MODE;
  const previousGraphVersion = process.env.WHATSAPP_GRAPH_API_VERSION;
  const previousFingerprint = process.env.WHATSAPP_RECIPIENT_FINGERPRINT_SECRET;
  process.env.WHATSAPP_AUTOMATIONS_ENABLED = "true";
  process.env.WHATSAPP_TEST_MODE = "false";
  process.env.WHATSAPP_GRAPH_API_VERSION = "v26.0";
  process.env.WHATSAPP_RECIPIENT_FINGERPRINT_SECRET =
    "synthetic-final-gate-fingerprint-secret";

  const eligibilityCalls: string[] = [];
  const failedMessages: Array<Record<string, unknown>> = [];
  let graphCalls = 0;
  try {
    await assert.rejects(
      sendAndRecordMessage({
        client: finalGateClient({ eligibilityCalls, failedMessages }),
        conversation: {
          id: CONVERSATION_ID,
          contact_id: CONTACT_ID,
          coexistence_account_id: ACCOUNT_ID,
          last_inbound_message_at: new Date().toISOString(),
          automation_mode: "auto",
          needs_human: false,
        },
        contact: {
          id: CONTACT_ID,
          phone_e164: "+5491100000001",
          whatsapp_id: "5491100000001",
          whatsapp_user_id: null,
          name: "Paciente",
        },
        payload: textPayload("Mensaje sintético"),
        bodyPreview: "Mensaje sintético",
        idempotencyKey: `automation:${INBOUND_ID}:0`,
        coexistenceAccountId: ACCOUNT_ID,
        metadata: { source: "automation", inbound_message_id: INBOUND_ID },
        automationExecution: {
          messageId: INBOUND_ID,
          leaseToken: LEASE_TOKEN,
        },
        fetchImpl: async () => {
          graphCalls += 1;
          return new Response(
            JSON.stringify({ messages: [{ id: "wamid.must-not-send" }] }),
            { status: 200 },
          );
        },
      }),
      (error: unknown) =>
        error instanceof WhatsAppPolicyError &&
        error.code === "AUTOMATIONS_DISABLED",
    );
    assert.equal(eligibilityCalls.length, 2);
    assert.equal(graphCalls, 0);
    assert.equal(failedMessages.at(-1)?.status, "failed");
  } finally {
    if (previousAutomations === undefined) {
      delete process.env.WHATSAPP_AUTOMATIONS_ENABLED;
    } else {
      process.env.WHATSAPP_AUTOMATIONS_ENABLED = previousAutomations;
    }
    if (previousTestMode === undefined) {
      delete process.env.WHATSAPP_TEST_MODE;
    } else {
      process.env.WHATSAPP_TEST_MODE = previousTestMode;
    }
    if (previousGraphVersion === undefined) {
      delete process.env.WHATSAPP_GRAPH_API_VERSION;
    } else {
      process.env.WHATSAPP_GRAPH_API_VERSION = previousGraphVersion;
    }
    if (previousFingerprint === undefined) {
      delete process.env.WHATSAPP_RECIPIENT_FINGERPRINT_SECRET;
    } else {
      process.env.WHATSAPP_RECIPIENT_FINGERPRINT_SECRET = previousFingerprint;
    }
  }
});
