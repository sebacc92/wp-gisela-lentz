import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

export function appAutomationsEnabled(settings: unknown): boolean {
  if (settings === null || typeof settings !== "object") return false;

  return (
    (settings as { automations_enabled?: unknown }).automations_enabled === true
  );
}

type AutomationEligibilityClient = Pick<SupabaseClient, "rpc">;

export interface WhatsAppAutomationExecutionLease {
  messageId: string;
  leaseToken: string;
}

export interface WhatsAppAutomationSendEligibility {
  eligible: boolean;
  reason: string | null;
  conversationId: string | null;
  globalAutomationsEnabled: boolean;
  testOverrideActive: boolean;
  testOverrideUntil: string | null;
}

function firstRpcRow(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

/**
 * Read the live operational gate used by the database. This deliberately does
 * not include the backend environment kill switch: callers must require that
 * independently so a per-conversation override can never bypass it.
 */
export async function whatsappConversationOperationallyEnabled(options: {
  client: AutomationEligibilityClient;
  conversationId: string;
}): Promise<boolean> {
  const result = await options.client.rpc(
    "whatsapp_conversation_automation_operationally_enabled",
    { p_conversation_id: options.conversationId },
  );
  if (result.error || typeof result.data !== "boolean") {
    throw new Error(
      `WHATSAPP_AUTOMATION_OPERATIONAL_GATE_UNAVAILABLE:${result.error?.message ?? "INVALID_RESULT"}`,
    );
  }
  return result.data;
}

/**
 * Authoritative, lease-bound check used immediately before an automation calls
 * Meta Graph. Expiry/revocation after outbox claim therefore still fails
 * closed. Reminders and operator messages never use this execution-specific
 * RPC and retain their existing independent gates.
 */
export async function checkWhatsAppAutomationSendEligibility(options: {
  client: AutomationEligibilityClient;
  conversationId: string;
  execution: WhatsAppAutomationExecutionLease;
}): Promise<WhatsAppAutomationSendEligibility> {
  const result = await options.client.rpc(
    "check_whatsapp_automation_send_eligibility",
    {
      p_message_id: options.execution.messageId,
      p_lease_token: options.execution.leaseToken,
    },
  );
  const row = firstRpcRow(result.data);
  if (
    result.error ||
    !row ||
    typeof row.eligible !== "boolean" ||
    (row.conversation_id !== null && typeof row.conversation_id !== "string") ||
    (row.eligible && row.conversation_id !== options.conversationId) ||
    (!row.eligible &&
      row.conversation_id !== null &&
      row.conversation_id !== options.conversationId) ||
    typeof row.global_automations_enabled !== "boolean" ||
    typeof row.test_override_active !== "boolean" ||
    (row.reason !== null && typeof row.reason !== "string") ||
    (row.test_override_until !== null &&
      typeof row.test_override_until !== "string")
  ) {
    throw new Error(
      `WHATSAPP_AUTOMATION_SEND_GATE_UNAVAILABLE:${result.error?.message ?? "INVALID_RESULT"}`,
    );
  }

  return {
    eligible: row.eligible,
    reason: row.reason as string | null,
    conversationId: row.conversation_id as string | null,
    globalAutomationsEnabled: row.global_automations_enabled,
    testOverrideActive: row.test_override_active,
    testOverrideUntil: row.test_override_until as string | null,
  };
}
