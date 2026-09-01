import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.2";

import { finalizeIncomingWebhookMessage } from "./whatsapp-automation-outbox.ts";

interface RpcResult {
  data: unknown;
  error: { message: string; code?: string } | null;
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
  assert.deepEqual(calls, [
    "finalize_whatsapp_inbound_webhook_with_operational_gate",
  ]);
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
  assert.deepEqual(calls, [
    "finalize_whatsapp_inbound_webhook_with_operational_gate",
  ]);
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
  assert.deepEqual(calls, [
    "finalize_whatsapp_inbound_webhook_with_operational_gate",
  ]);
});

test("accepts an authoritative operational skip after local safety allowed automation", async () => {
  const calls: string[] = [];
  const queued = await finalizeIncomingWebhookMessage({
    client: fakeClient(
      () => ({ data: { id: "dispatch-4", status: "completed" }, error: null }),
      calls,
    ),
    externalEventId: "wamid.live.4",
    messageId: "00000000-0000-4000-8000-000000000004",
    shouldRunAutomation: true,
  });
  assert.equal(queued, false);
  assert.deepEqual(calls, [
    "finalize_whatsapp_inbound_webhook_with_operational_gate",
  ]);
});

test("falls back to the legacy finalizer only when v2 is absent during rolling deploy", async () => {
  for (const code of ["PGRST202", "42883"]) {
    const calls: string[] = [];
    const queued = await finalizeIncomingWebhookMessage({
      client: fakeClient(
        (name) =>
          name === "finalize_whatsapp_inbound_webhook_with_operational_gate"
            ? {
                data: null,
                error: { message: "v2 function unavailable", code },
              }
            : {
                data: { id: "dispatch-legacy", status: "pending" },
                error: null,
              },
        calls,
      ),
      externalEventId: `wamid.live.rolling.${code}`,
      messageId: "00000000-0000-4000-8000-000000000006",
      shouldRunAutomation: true,
    });
    assert.equal(queued, true);
    assert.deepEqual(calls, [
      "finalize_whatsapp_inbound_webhook_with_operational_gate",
      "finalize_whatsapp_inbound_webhook",
    ]);
  }
});

test("does not bypass an installed v2 finalizer after an ordinary SQL error", async () => {
  const calls: string[] = [];
  await assert.rejects(
    finalizeIncomingWebhookMessage({
      client: fakeClient(
        () => ({
          data: null,
          error: { message: "synthetic database failure", code: "XX000" },
        }),
        calls,
      ),
      externalEventId: "wamid.live.v2-error",
      messageId: "00000000-0000-4000-8000-000000000007",
      shouldRunAutomation: true,
    }),
    /INBOUND_WEBHOOK_FINALIZATION_FAILED/,
  );
  assert.deepEqual(calls, [
    "finalize_whatsapp_inbound_webhook_with_operational_gate",
  ]);
});

test("never lets SQL queue work when the backend kill switch said no", async () => {
  await assert.rejects(
    finalizeIncomingWebhookMessage({
      client: fakeClient(
        () => ({ data: { id: "dispatch-5", status: "pending" }, error: null }),
        [],
      ),
      externalEventId: "wamid.live.5",
      messageId: "00000000-0000-4000-8000-000000000005",
      shouldRunAutomation: false,
    }),
    /INBOUND_WEBHOOK_FINALIZATION_FAILED/,
  );
});
