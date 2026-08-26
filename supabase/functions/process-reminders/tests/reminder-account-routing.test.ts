import assert from "node:assert/strict";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import {
  classifyReminderWhatsAppFailure,
  deliverAppointmentReminder,
} from "../reminder-delivery.ts";
import { isWhatsAppCredentialResolutionError } from "../../_shared/whatsapp-account-credentials.ts";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const CONTACT_ID = "44444444-4444-4444-8444-444444444444";
const APPOINTMENT_ID = "55555555-5555-4555-8555-555555555555";
const REMINDER_ID = "66666666-6666-4666-8666-666666666666";
const MESSAGE_ID = "77777777-7777-4777-8777-777777777777";
const WABA_ID = "8888888888";
const PHONE_NUMBER_ID = "9999999999";
const BUSINESS_TOKEN = "vault-token-for-reminder-account";

Deno.env.set("WHATSAPP_GRAPH_API_VERSION", "v26.0");
Deno.env.set("WHATSAPP_TEST_MODE", "false");
Deno.env.set("WHATSAPP_AUTOMATIONS_ENABLED", "true");

function credentials(accountId = ACCOUNT_ID): Record<string, unknown> {
  return {
    credential_mode: "coexistence",
    account_id: accountId,
    waba_id: WABA_ID,
    phone_number_id: PHONE_NUMBER_ID,
    business_access_token: BUSINESS_TOKEN,
    token_generation: 9,
    coexistence_status: "active",
    onboarding_status: "completed",
    app_subscription_status: "subscribed",
    business_token_status: "active",
    business_token_validation_status: "valid",
    sending_paused: false,
  };
}

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

function reminderClient(input: {
  resolvedAccountId?: string;
  rpcError?: { message: string };
  rpcCalls: Array<Record<string, unknown>>;
  insertedMessages: Array<Record<string, unknown>>;
}): SupabaseClient {
  const conversationPolicy = {
    id: CONVERSATION_ID,
    contact_id: CONTACT_ID,
    last_inbound_message_at: new Date().toISOString(),
    automation_mode: "auto",
    automation_pause_source: null,
    automation_pause_message_id: null,
  };
  const contactPolicy = {
    id: CONTACT_ID,
    whatsapp_opt_in_at: "2026-01-01T00:00:00.000Z",
    whatsapp_opt_out_at: null,
    whatsapp_consent_status: "opted_in",
  };
  const templatePolicy = {
    key: "appointment_reminder_24h",
    meta_name: "appointment_reminder_24h",
    category: "UTILITY",
    meta_status: "APPROVED",
    quality_rating: "GREEN",
    enabled: true,
  };
  const appointmentPolicy = {
    id: APPOINTMENT_ID,
    contact_id: CONTACT_ID,
    starts_at: "2099-01-02T15:00:00.000Z",
    status: "confirmed",
  };

  return {
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      assert.equal(name, "resolve_whatsapp_account_credentials");
      input.rpcCalls.push(parameters);
      if (input.rpcError) {
        return { data: null, error: input.rpcError };
      }
      return {
        data: [credentials(input.resolvedAccountId ?? ACCOUNT_ID)],
        error: null,
      };
    },
    from: (table: string) => {
      if (table === "messages") {
        return {
          select: () => queryResult(null),
          insert: (values: Record<string, unknown>) => {
            input.insertedMessages.push(values);
            return queryResult({
              id: MESSAGE_ID,
              whatsapp_message_id: null,
              status: "pending",
              metadata: values.metadata,
            });
          },
          update: () => queryResult(null),
        };
      }
      if (table === "conversations") {
        return { select: () => queryResult(conversationPolicy) };
      }
      if (table === "contacts") {
        return { select: () => queryResult(contactPolicy) };
      }
      if (table === "whatsapp_settings") {
        return {
          select: () =>
            queryResult({ sending_paused: false, quality_rating: "GREEN" }),
        };
      }
      if (table === "message_templates") {
        return { select: () => queryResult(templatePolicy) };
      }
      if (table === "appointments") {
        return { select: () => queryResult(appointmentPolicy) };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

function deliveryInput(client: SupabaseClient, fetchImpl: typeof fetch) {
  return {
    client,
    reminder: { id: REMINDER_ID, type: "appointment_24h" as const },
    appointment: {
      id: APPOINTMENT_ID,
      starts_at: "2099-01-02T15:00:00.000Z",
    },
    conversation: {
      id: CONVERSATION_ID,
      contact_id: CONTACT_ID,
      coexistence_account_id: ACCOUNT_ID,
      last_inbound_message_at: new Date().toISOString(),
      automation_mode: "auto" as const,
      needs_human: false,
    },
    contact: {
      id: CONTACT_ID,
      phone_e164: "+5491100000001",
      whatsapp_id: "5491100000001",
      whatsapp_user_id: "5491100000001",
      name: "Paciente",
      whatsapp_opt_in_at: "2026-01-01T00:00:00.000Z",
      whatsapp_opt_out_at: null,
      whatsapp_consent_status: "opted_in" as const,
    },
    professionalName: "Gisela Lentz",
    template: {
      key: "appointment_reminder_24h",
      meta_name: "appointment_reminder_24h",
      language_code: "es_AR",
      body_preview: "Recordatorio de turno odontológico.",
    },
    businessTimezone: "America/Argentina/Buenos_Aires",
    fetchImpl,
  };
}

Deno.test("reminder usa cuenta, phone y business token exactos", async () => {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const insertedMessages: Array<Record<string, unknown>> = [];
  let graphAuthorization = "";
  let graphUrl = "";
  const client = reminderClient({ rpcCalls, insertedMessages });
  const result = await deliverAppointmentReminder(
    deliveryInput(client, async (input, init) => {
      graphUrl = String(input);
      graphAuthorization =
        new Headers(init?.headers).get("Authorization") ?? "";
      return new Response(
        JSON.stringify({ messages: [{ id: "wamid.reminder.1" }] }),
        { status: 200 },
      );
    }),
  );

  assert.equal(result.status, "sent");
  assert.equal(
    graphUrl,
    `https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`,
  );
  assert.equal(graphAuthorization, `Bearer ${BUSINESS_TOKEN}`);
  assert.equal(insertedMessages.length, 1);
  assert.equal(insertedMessages[0].coexistence_account_id, ACCOUNT_ID);
  assert.equal(rpcCalls.length, 2);
  assert.deepEqual(rpcCalls[0], {
    p_purpose: "send",
    p_account_id: ACCOUNT_ID,
    p_waba_id: null,
    p_phone_number_id: null,
    p_conversation_id: CONVERSATION_ID,
    p_expected_token_generation: null,
  });
  assert.deepEqual(rpcCalls[1], {
    p_purpose: "send",
    p_account_id: ACCOUNT_ID,
    p_waba_id: WABA_ID,
    p_phone_number_id: PHONE_NUMBER_ID,
    p_conversation_id: CONVERSATION_ID,
    p_expected_token_generation: 9,
  });
});

Deno.test(
  "reminder cross-account se bloquea con cero llamadas Graph",
  async () => {
    const rpcCalls: Array<Record<string, unknown>> = [];
    const insertedMessages: Array<Record<string, unknown>> = [];
    let graphCalls = 0;
    const client = reminderClient({
      resolvedAccountId: OTHER_ACCOUNT_ID,
      rpcCalls,
      insertedMessages,
    });

    await assert.rejects(
      () =>
        deliverAppointmentReminder(
          deliveryInput(client, async () => {
            graphCalls += 1;
            throw new Error("Graph must not be called");
          }),
        ),
      /WHATSAPP_CREDENTIAL_IDENTITY_MISMATCH/,
    );
    assert.equal(graphCalls, 0);
    assert.equal(insertedMessages.length, 0);
    assert.equal(rpcCalls.length, 1);
  },
);

Deno.test(
  "reminder creado post-offboarding falla terminal y no llama Graph",
  async () => {
    const rpcCalls: Array<Record<string, unknown>> = [];
    const insertedMessages: Array<Record<string, unknown>> = [];
    let graphCalls = 0;
    const client = reminderClient({
      rpcError: {
        message: "WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_NOT_FOUND",
      },
      rpcCalls,
      insertedMessages,
    });

    let caught: unknown;
    try {
      await deliverAppointmentReminder(
        deliveryInput(client, async () => {
          graphCalls += 1;
          throw new Error("Graph must not be called");
        }),
      );
    } catch (error) {
      caught = error;
    }

    assert.equal(isWhatsAppCredentialResolutionError(caught), true);
    assert.equal(
      caught instanceof Error ? caught.message : "",
      "WHATSAPP_BUSINESS_CREDENTIAL_ACCOUNT_NOT_FOUND",
    );
    assert.deepEqual(
      classifyReminderWhatsAppFailure(caught, { retryUnknown: false }),
      {
        policyBlocked: false,
        credentialTerminal: true,
        retryable: false,
      },
    );
    assert.deepEqual(
      classifyReminderWhatsAppFailure(caught, { retryUnknown: true }),
      {
        policyBlocked: false,
        credentialTerminal: true,
        retryable: false,
      },
    );
    assert.equal(graphCalls, 0);
    assert.equal(insertedMessages.length, 0);
    assert.equal(rpcCalls.length, 1);
  },
);

Deno.test(
  "un fallo transitorio del resolver reencola el reminder sin llamar Graph",
  async () => {
    let graphCalls = 0;
    const rpcCalls: Array<Record<string, unknown>> = [];
    const insertedMessages: Array<Record<string, unknown>> = [];
    const client = reminderClient({
      rpcError: { message: "temporary PostgREST timeout" },
      rpcCalls,
      insertedMessages,
    });
    let caught: unknown;
    try {
      await deliverAppointmentReminder(
        deliveryInput(client, async () => {
          graphCalls += 1;
          throw new Error("Graph must not be called");
        }),
      );
    } catch (error) {
      caught = error;
    }
    assert.equal(isWhatsAppCredentialResolutionError(caught), true);
    assert.deepEqual(
      classifyReminderWhatsAppFailure(caught, { retryUnknown: false }),
      {
        policyBlocked: false,
        credentialTerminal: false,
        retryable: true,
      },
    );
    assert.equal(graphCalls, 0);
    assert.equal(insertedMessages.length, 0);
    assert.equal(rpcCalls.length, 1);
  },
);
