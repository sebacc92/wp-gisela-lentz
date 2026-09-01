import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

const OPERATIONAL_FINALIZER_RPC =
  "finalize_whatsapp_inbound_webhook_with_operational_gate";

function rpcIsUnavailableDuringRollingDeploy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "PGRST202" || code === "42883";
}

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

  const parameters = {
    p_message_id: messageId,
    p_external_event_id: externalEventId,
    p_should_run_automation: shouldRunAutomation,
  };
  let finalized = await client.rpc(OPERATIONAL_FINALIZER_RPC, parameters);
  if (rpcIsUnavailableDuringRollingDeploy(finalized.error)) {
    // Functions-first rolling deploy: the legacy RPC preserves the exact
    // pre-migration behavior. Once SQL is present, every other v2 error fails
    // closed instead of bypassing its authoritative operational decision.
    finalized = await client.rpc(
      "finalize_whatsapp_inbound_webhook",
      parameters,
    );
  }
  const row = (
    Array.isArray(finalized.data) ? finalized.data[0] : finalized.data
  ) as { id?: string; status?: string } | null;
  const validStatus =
    row?.status === "completed" ||
    (shouldRunAutomation && row?.status === "pending");
  if (finalized.error || !row?.id || !validStatus) {
    throw new Error(
      `INBOUND_WEBHOOK_FINALIZATION_FAILED:${finalized.error?.message ?? row?.status ?? "NO_ROW"}`,
    );
  }
  return row.status === "pending";
}
