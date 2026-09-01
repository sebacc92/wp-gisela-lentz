import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import {
  appAutomationsEnabled,
  checkWhatsAppAutomationSendEligibility,
  whatsappConversationOperationallyEnabled,
} from "./app-automations.ts";
import {
  assertWhatsAppAutomationSendEligible,
  WhatsAppDispatchError,
  WhatsAppPolicyError,
} from "./whatsapp.ts";

test("app automations require an explicit enabled setting", () => {
  assert.equal(appAutomationsEnabled({ automations_enabled: true }), true);
  assert.equal(appAutomationsEnabled({ automations_enabled: false }), false);
  assert.equal(appAutomationsEnabled({}), false);
  assert.equal(appAutomationsEnabled(null), false);
  assert.equal(appAutomationsEnabled("true"), false);
});

interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

function rpcClient(
  handler: (name: string, args: Record<string, unknown>) => RpcResult,
  calls: Array<{ name: string; args: Record<string, unknown> }> = [],
): Pick<SupabaseClient, "rpc"> {
  return {
    rpc: (async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return handler(name, args);
    }) as unknown as SupabaseClient["rpc"],
  };
}

test("the live conversation gate uses the authoritative database result", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = rpcClient(() => ({ data: true, error: null }), calls);
  assert.equal(
    await whatsappConversationOperationallyEnabled({
      client,
      conversationId: "conversation-a",
    }),
    true,
  );
  assert.deepEqual(calls, [
    {
      name: "whatsapp_conversation_automation_operationally_enabled",
      args: { p_conversation_id: "conversation-a" },
    },
  ]);

  assert.equal(
    await whatsappConversationOperationallyEnabled({
      client: rpcClient(() => ({ data: false, error: null })),
      conversationId: "conversation-b",
    }),
    false,
  );
});

test("the live conversation gate fails closed when SQL is unavailable", async () => {
  await assert.rejects(
    whatsappConversationOperationallyEnabled({
      client: rpcClient(() => ({
        data: null,
        error: { message: "synthetic failure" },
      })),
      conversationId: "conversation-a",
    }),
    /WHATSAPP_AUTOMATION_OPERATIONAL_GATE_UNAVAILABLE/,
  );
});

test("the final send gate is bound to the inbound execution lease", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const result = await checkWhatsAppAutomationSendEligibility({
    client: rpcClient(
      () => ({
        data: {
          eligible: true,
          reason: "ELIGIBLE",
          conversation_id: "conversation-a",
          global_automations_enabled: false,
          test_override_active: true,
          test_override_until: "2026-09-02T12:00:00.000Z",
        },
        error: null,
      }),
      calls,
    ),
    conversationId: "conversation-a",
    execution: { messageId: "message-a", leaseToken: "lease-a" },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.globalAutomationsEnabled, false);
  assert.equal(result.testOverrideActive, true);
  assert.deepEqual(calls, [
    {
      name: "check_whatsapp_automation_send_eligibility",
      args: { p_message_id: "message-a", p_lease_token: "lease-a" },
    },
  ]);
});

test("the final gate rejects a mismatched conversation context", async () => {
  await assert.rejects(
    checkWhatsAppAutomationSendEligibility({
      client: rpcClient(() => ({
        data: {
          eligible: true,
          reason: "ELIGIBLE_GLOBAL",
          conversation_id: "conversation-b",
          global_automations_enabled: true,
          test_override_active: false,
          test_override_until: null,
        },
        error: null,
      })),
      conversationId: "conversation-a",
      execution: { messageId: "message-a", leaseToken: "lease-a" },
    }),
    /WHATSAPP_AUTOMATION_SEND_GATE_UNAVAILABLE/,
  );
});

test("the backend kill switch is absolute and runs before the override RPC", async () => {
  const previous = process.env.WHATSAPP_AUTOMATIONS_ENABLED;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  process.env.WHATSAPP_AUTOMATIONS_ENABLED = "false";
  try {
    await assert.rejects(
      assertWhatsAppAutomationSendEligible({
        client: rpcClient(
          () => ({
            data: {
              eligible: true,
              reason: "ELIGIBLE",
              conversation_id: "conversation-a",
              global_automations_enabled: false,
              test_override_active: true,
              test_override_until: "2026-09-02T12:00:00.000Z",
            },
            error: null,
          }),
          calls,
        ),
        conversationId: "conversation-a",
        execution: { messageId: "message-a", leaseToken: "lease-a" },
      }),
      (error: unknown) =>
        error instanceof WhatsAppPolicyError &&
        error.code === "AUTOMATIONS_DISABLED",
    );
    assert.deepEqual(calls, []);
  } finally {
    if (previous === undefined) {
      delete process.env.WHATSAPP_AUTOMATIONS_ENABLED;
    } else {
      process.env.WHATSAPP_AUTOMATIONS_ENABLED = previous;
    }
  }
});

test("expiry or revocation blocks a leased worker before Graph", async () => {
  const previous = process.env.WHATSAPP_AUTOMATIONS_ENABLED;
  process.env.WHATSAPP_AUTOMATIONS_ENABLED = "true";
  try {
    // SQL intentionally exposes the same terminal reason for expiry and an
    // explicit revocation; both are represented by an inactive live override.
    for (const testOverrideUntil of ["2026-09-01T11:59:59.000Z", null]) {
      await assert.rejects(
        assertWhatsAppAutomationSendEligible({
          client: rpcClient(() => ({
            data: {
              eligible: false,
              reason: "AUTOMATIONS_DISABLED",
              conversation_id: "conversation-a",
              global_automations_enabled: false,
              test_override_active: false,
              test_override_until: testOverrideUntil,
            },
            error: null,
          })),
          conversationId: "conversation-a",
          execution: { messageId: "message-a", leaseToken: "lease-a" },
        }),
        (error: unknown) =>
          error instanceof WhatsAppPolicyError &&
          error.code === "AUTOMATIONS_DISABLED",
      );
    }
  } finally {
    if (previous === undefined) {
      delete process.env.WHATSAPP_AUTOMATIONS_ENABLED;
    } else {
      process.env.WHATSAPP_AUTOMATIONS_ENABLED = previous;
    }
  }
});

test("manual mode remains a stronger barrier than the test override", async () => {
  const previous = process.env.WHATSAPP_AUTOMATIONS_ENABLED;
  process.env.WHATSAPP_AUTOMATIONS_ENABLED = "true";
  try {
    await assert.rejects(
      assertWhatsAppAutomationSendEligible({
        client: rpcClient(() => ({
          data: {
            eligible: false,
            reason: "AUTOMATION_PAUSED",
            conversation_id: "conversation-a",
            global_automations_enabled: false,
            test_override_active: true,
            test_override_until: "2026-09-02T12:00:00.000Z",
          },
          error: null,
        })),
        conversationId: "conversation-a",
        execution: { messageId: "message-a", leaseToken: "lease-a" },
      }),
      (error: unknown) =>
        error instanceof WhatsAppPolicyError &&
        error.code === "AUTOMATION_PAUSED",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.WHATSAPP_AUTOMATIONS_ENABLED;
    } else {
      process.env.WHATSAPP_AUTOMATIONS_ENABLED = previous;
    }
  }
});

test("the final gate preserves sending pause and human-reply barriers", async () => {
  const previous = process.env.WHATSAPP_AUTOMATIONS_ENABLED;
  process.env.WHATSAPP_AUTOMATIONS_ENABLED = "true";
  const blocked = (
    reason: string,
    conversationId: string | null = "conversation-a",
  ) =>
    rpcClient(() => ({
      data: {
        eligible: false,
        reason,
        conversation_id: conversationId,
        global_automations_enabled: true,
        test_override_active: false,
        test_override_until: null,
      },
      error: null,
    }));
  try {
    await assert.rejects(
      assertWhatsAppAutomationSendEligible({
        client: blocked("SENDING_PAUSED"),
        conversationId: "conversation-a",
        execution: { messageId: "message-a", leaseToken: "lease-a" },
      }),
      (error: unknown) =>
        error instanceof WhatsAppPolicyError && error.code === "SENDING_PAUSED",
    );
    await assert.rejects(
      assertWhatsAppAutomationSendEligible({
        client: blocked("HUMAN_REPLY_BARRIER"),
        conversationId: "conversation-a",
        execution: { messageId: "message-a", leaseToken: "lease-a" },
      }),
      (error: unknown) =>
        error instanceof WhatsAppPolicyError &&
        error.code === "AUTOMATION_SUPERSEDED_BY_HUMAN_REPLY",
    );
    await assert.rejects(
      assertWhatsAppAutomationSendEligible({
        client: blocked("EXECUTION_LEASE_INVALID", null),
        conversationId: "conversation-a",
        execution: { messageId: "message-a", leaseToken: "lease-a" },
      }),
      (error: unknown) =>
        error instanceof WhatsAppDispatchError &&
        error.code === "AUTOMATION_EXECUTION_LEASE_LOST" &&
        error.retryable,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.WHATSAPP_AUTOMATIONS_ENABLED;
    } else {
      process.env.WHATSAPP_AUTOMATIONS_ENABLED = previous;
    }
  }
});
