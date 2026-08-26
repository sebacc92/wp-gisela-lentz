import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

/**
 * The inbound INSERT already created a `reserved` dispatch in the same
 * transaction. Finalize eligibility and the webhook claim together so neither
 * step can become visible without the other.
 */
export async function finalizeIncomingWebhookMessage(options: {
  client: Pick<SupabaseClient, "rpc">;
  externalEventId: string;
  messageId: string;
  shouldRunAutomation: boolean;
}): Promise<boolean> {
  const { client, externalEventId, messageId, shouldRunAutomation } = options;

  const finalized = await client.rpc("finalize_whatsapp_inbound_webhook", {
    p_message_id: messageId,
    p_external_event_id: externalEventId,
    p_should_run_automation: shouldRunAutomation,
  });
  const row = (
    Array.isArray(finalized.data) ? finalized.data[0] : finalized.data
  ) as { id?: string; status?: string } | null;
  const expectedStatus = shouldRunAutomation ? "pending" : "completed";
  if (finalized.error || !row?.id || row.status !== expectedStatus) {
    throw new Error(
      `INBOUND_WEBHOOK_FINALIZATION_FAILED:${finalized.error?.message ?? row?.status ?? "NO_ROW"}`,
    );
  }
  return shouldRunAutomation;
}
