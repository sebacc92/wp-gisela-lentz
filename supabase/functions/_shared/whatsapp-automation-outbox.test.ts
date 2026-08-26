import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import { finalizeIncomingWebhookMessage } from "./whatsapp-automation-outbox.ts";

interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

function fakeClient(
  handler: (name: string) => RpcResult,
  calls: string[],
): Pick<SupabaseClient, "rpc"> {
  return {
    rpc: (async (name: string) => {
      calls.push(name);
      return handler(name);
    }) as unknown as SupabaseClient["rpc"],
  };
}

test("activates its reservation and completes the webhook atomically", async () => {
  const calls: string[] = [];
  const queued = await finalizeIncomingWebhookMessage({
    client: fakeClient(
      () => ({ data: { id: "dispatch-1", status: "pending" }, error: null }),
      calls,
    ),
    externalEventId: "wamid.live.1",
    messageId: "00000000-0000-4000-8000-000000000001",
    shouldRunAutomation: true,
  });

  assert.equal(queued, true);
  assert.deepEqual(calls, ["finalize_whatsapp_inbound_webhook"]);
});

test("fails closed when atomic finalization fails", async () => {
  const calls: string[] = [];
  await assert.rejects(
    finalizeIncomingWebhookMessage({
      client: fakeClient(
        () => ({ data: null, error: { message: "synthetic failure" } }),
        calls,
      ),
      externalEventId: "wamid.live.2",
      messageId: "00000000-0000-4000-8000-000000000002",
      shouldRunAutomation: true,
    }),
    /INBOUND_WEBHOOK_FINALIZATION_FAILED/,
  );
  assert.deepEqual(calls, ["finalize_whatsapp_inbound_webhook"]);
});

test("completes the reservation as skipped when automation is not applicable", async () => {
  const calls: string[] = [];
  const queued = await finalizeIncomingWebhookMessage({
    client: fakeClient(
      () => ({ data: { id: "dispatch-3", status: "completed" }, error: null }),
      calls,
    ),
    externalEventId: "wamid.live.3",
    messageId: "00000000-0000-4000-8000-000000000003",
    shouldRunAutomation: false,
  });
  assert.equal(queued, false);
  assert.deepEqual(calls, ["finalize_whatsapp_inbound_webhook"]);
});
